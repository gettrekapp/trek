// scripts/serverTeardown.test.mjs — the worktree teardown's planning and running (plugins E1), over
// made-up participants: plans in participant order with ids namespaced, a plan that throws, hangs
// or answers nonsense left out, the chosen items run in order, a failure stopping the rest, unknown
// ids refused before anything runs, and the repository veto.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TEARDOWN_RUN_TIMEOUT_MS, anyBusy, assertNotTearingDown, busyReason, holdWorktree, optionalTeardown, planTeardown, planTeardownReport, repoRemoveVeto, requireOp, runTeardown, withTornDown } from '../server/src/teardown/teardown.ts'
import { codedError, toWireError } from '../server/src/errors.ts'
import { participantsFor, stackParticipant } from '../server/src/teardown/participants.ts'
import { TEARDOWN_REQUEST_TIMEOUT_MS, defaultTeardown } from '../src/shared/teardown.ts'

const target = {
  project: { id: 'p1' },
  repo: { id: 'r1', name: 'app', path: '/r/app', branchData: {}, worktrees: [] },
  worktree: { id: 'w2', path: '/r/app-feat', branch: 'feat', isMain: false }
}

/** A participant that plans `items` ('throw' / 'hang' / anything else as is) and records its teardowns in `log`. */
function participant(id, items, log, { failOn } = {}) {
  return {
    id,
    plan: async () => {
      if (items === 'throw') throw new Error('cannot tell')
      if (items === 'hang') return new Promise(() => {})
      return items
    },
    teardown: async (_t, op, ids) => {
      log.push([id, op, ids])
      if (failOn && ids.includes(failOn)) throw new Error('it would not stop')
    }
  }
}

test('planTeardown: every participant in order, ids namespaced; one that throws, hangs or answers nonsense is left out', async () => {
  const warnings = []
  const log = []
  const items = await planTeardown(
    [
      participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log),
      participant('broken', 'throw', log),
      participant('slow', 'hang', log),
      participant('env', [{ id: 'destroy', label: ' Stop and delete the VM ', checked: true }, { id: 'Bad Id', label: 'x', checked: true }, { id: 'cache', label: 'Drop the cache', checked: false }], log),
      participant('odd', 'not a list', log)
    ],
    target,
    'remove',
    { timeoutMs: 50, warn: (m) => warnings.push(m) }
  )
  assert.deepEqual(items, [
    { id: 'stack:destroy', label: 'Tear down the dev stack', checked: true },
    { id: 'env:destroy', label: 'Stop and delete the VM', checked: true },
    { id: 'env:cache', label: 'Drop the cache', checked: false }
  ])
  assert.equal(warnings.length, 4)
  assert.ok(warnings.some((w) => w.includes('broken') && w.includes('cannot tell')))
  assert.ok(warnings.some((w) => w.includes('slow') && w.includes('no answer')))
  assert.deepEqual(defaultTeardown(items), ['stack:destroy', 'env:destroy'])
  assert.deepEqual(log, [])
})

test('planTeardownReport (plugins E3): the items, and the participants whose plan failed or hung', async () => {
  const log = []
  const warnings = []
  const report = await planTeardownReport(
    [
      participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log),
      participant('broken', 'throw', log),
      participant('slow', 'hang', log),
      participant('odd', 'not a list', log)
    ],
    target,
    'move',
    { timeoutMs: 50, warn: (m) => warnings.push(m) }
  )
  assert.deepEqual(report, { items: [{ id: 'stack:destroy', label: 'Tear down the dev stack', checked: true }], unplanned: ['broken', 'slow'] })
  // An answer that is not a list is left out too, but it did answer: not unplanned.
  assert.equal(warnings.length, 3)
})

test('runTeardown: the chosen items in participant order, each participant once with its own ids; none chosen runs nothing', async () => {
  const log = []
  const ps = [
    participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log),
    participant('env', [{ id: 'destroy', label: 'Stop the VM', checked: true }, { id: 'cache', label: 'Drop the cache', checked: false }], log)
  ]
  assert.deepEqual(await runTeardown(ps, target, 'promote', ['env:cache', 'stack:destroy', 'env:destroy']), ['Tear down the dev stack', 'Drop the cache', 'Stop the VM'], 'the labels it ran, in order')
  assert.deepEqual(log, [['stack', 'promote', ['destroy']], ['env', 'promote', ['cache', 'destroy']]])
  assert.deepEqual(await runTeardown(ps, target, 'remove', []), [])
  assert.equal(log.length, 2)
})

test('runTeardown: a failing item stops the rest (TOOL_ERROR naming it); an unknown participant is refused before anything runs; an item no longer planned is skipped', async () => {
  const log = []
  const ps = [
    participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log, { failOn: 'destroy' }),
    participant('env', [{ id: 'destroy', label: 'Stop the VM', checked: true }], log)
  ]
  await assert.rejects(runTeardown(ps, target, 'remove', ['stack:destroy', 'env:destroy']), (e) => e.code === 'TOOL_ERROR' && e.details?.reason === 'teardown' && e.message === "Couldn't tear down the dev stack: it would not stop")
  assert.deepEqual(log, [['stack', 'remove', ['destroy']]])
  log.length = 0
  for (const ids of [['nobody:x'], ['stack'], [':x'], ['env:destroy', 'ghost:y']]) {
    await assert.rejects(runTeardown(ps, target, 'remove', ids), (e) => e.code === 'BAD_REQUEST', JSON.stringify(ids))
  }
  assert.deepEqual(log, [])
  const warnings = []
  assert.deepEqual(await runTeardown(ps, target, 'remove', ['env:gone'], { warn: (m) => warnings.push(m) }), [], 'a skipped item is not reported as torn down')
  assert.deepEqual(log, [])
  assert.match(warnings[0], /env:gone is no longer planned/)
})

test('repoRemoveVeto: the first reason; a check that throws refuses too; none: null', async () => {
  const p = (id, answer) => ({
    id,
    plan: async () => [],
    teardown: async () => {},
    beforeRepoRemove: async () => {
      if (answer instanceof Error) throw answer
      return answer
    }
  })
  assert.equal(await repoRemoveVeto([p('a', null), p('b', 'A VM is running.'), p('c', 'later')], target.project, target.repo), 'A VM is running.')
  assert.equal(await repoRemoveVeto([p('a', null), { id: 'none', plan: async () => [], teardown: async () => {} }], target.project, target.repo), null)
  assert.match(await repoRemoveVeto([p('a', new Error('colima hung'))], target.project, target.repo), /a could not check it: colima hung/)
})

test('optionalTeardown and requireOp: what a request may send', () => {
  assert.deepEqual(optionalTeardown(undefined), [])
  assert.deepEqual(optionalTeardown(['a:x', 'a:x', 'b:y']), ['a:x', 'b:y'])
  for (const bad of ['a:x', [1], [''], new Array(51).fill('a:x')]) assert.throws(() => optionalTeardown(bad), (e) => e.code === 'BAD_REQUEST')
  assert.equal(requireOp('move'), 'move')
  for (const bad of ['delete', undefined, 1]) assert.throws(() => requireOp(bad), (e) => e.code === 'BAD_REQUEST')
})

test('runTeardown: a chosen participant whose re-check throws or hangs stops the operation before anything is torn down', async () => {
  const log = []
  const stack = participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log)
  for (const [items, text] of [['hang', /no answer/], ['throw', /cannot tell/]]) {
    const ps = [stack, participant('env', items, log)]
    await assert.rejects(
      runTeardown(ps, target, 'remove', ['stack:destroy', 'env:destroy'], { timeoutMs: 50 }),
      (e) => e.code === 'TOOL_ERROR' && e.details?.reason === 'teardown' && /^Couldn't check env before tearing it down: /.test(e.message) && text.test(e.message)
    )
  }
  assert.deepEqual(log, [])
})

test('runTeardown: one at a time per worktree; the next one may run once it ends, failed or not', async () => {
  const log = []
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const slow = {
    id: 'slow',
    plan: async () => [{ id: 'x', label: 'Wait', checked: true }],
    teardown: async () => {
      log.push('slow')
      await gate
    }
  }
  const first = runTeardown([slow], target, 'remove', ['slow:x'])
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(runTeardown([slow], target, 'remove', ['slow:x']), (e) => e.code === 'CONFLICT' && e.message === 'this worktree is busy: tearing it down; try again once it is done')
  const other = { ...target, worktree: { ...target.worktree, id: 'w3', path: '/r/app-other' } }
  const third = runTeardown([participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log)], other, 'remove', ['stack:destroy'])
  await third
  release()
  await first
  const failing = participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log, { failOn: 'destroy' })
  await assert.rejects(runTeardown([failing], target, 'remove', ['stack:destroy']), (e) => e.code === 'TOOL_ERROR')
  await runTeardown([participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log)], target, 'remove', ['stack:destroy'])
  assert.deepEqual(log, ['slow', ['stack', 'remove', ['destroy']], ['stack', 'remove', ['destroy']], ['stack', 'remove', ['destroy']]])
})

test('runTeardown: a later failure says what was already torn down', async () => {
  const log = []
  const ps = [
    participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log),
    participant('env', [{ id: 'destroy', label: 'Stop the VM', checked: true }], log, { failOn: 'destroy' })
  ]
  await assert.rejects(runTeardown(ps, target, 'remove', ['stack:destroy', 'env:destroy']), (e) => {
    assert.equal(e.code, 'TOOL_ERROR')
    assert.deepEqual(e.details, { reason: 'teardown', tornDown: ['Tear down the dev stack'] })
    assert.equal(e.message, "Couldn't stop the VM: it would not stop (already done: Tear down the dev stack)")
    return true
  })
  await assert.rejects(runTeardown(ps.slice(1), target, 'remove', ['env:destroy']), (e) => {
    assert.deepEqual(e.details, { reason: 'teardown', tornDown: [] })
    assert.equal(e.message, "Couldn't stop the VM: it would not stop")
    return true
  })
})

test('runTeardown: a teardown that hangs past the cap fails, naming it', async () => {
  const hung = { id: 'env', plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }], teardown: () => new Promise(() => {}) }
  await assert.rejects(
    // Its own worktree: one that never settles stays busy for good.
    runTeardown([hung], { ...target, worktree: { ...target.worktree, id: 'w9', path: '/r/app-hung' } }, 'remove', ['env:destroy'], { teardownTimeoutMs: 50 }),
    (e) => e.code === 'TOOL_ERROR' && e.details?.reason === 'teardown' && e.message === "Couldn't stop the VM: no answer in 0.05 s"
  )
})

test('runTeardown: the limit is one deadline for the whole teardown, shared by its participants', async () => {
  const slow = { id: 'stack', plan: async () => [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], teardown: () => new Promise((resolve) => setTimeout(resolve, 120)) }
  const hung = { id: 'env', plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }], teardown: () => new Promise(() => {}) }
  const started = Date.now()
  await assert.rejects(
    runTeardown([slow, hung], { ...target, worktree: { ...target.worktree, id: 'w8', path: '/r/app-shared' } }, 'remove', ['stack:destroy', 'env:destroy'], { teardownTimeoutMs: 200 }),
    (e) => {
      assert.equal(e.code, 'TOOL_ERROR')
      assert.deepEqual(e.details, { reason: 'teardown', tornDown: ['Tear down the dev stack'] })
      // The VM got what the stack left (about 0.08 s), not a fresh 0.2 s.
      const m = /^Couldn't stop the VM: no answer in ([\d.]+) s \(already done: Tear down the dev stack\)$/.exec(e.message)
      assert.ok(m, e.message)
      assert.ok(Number(m[1]) < 0.2, e.message)
      return true
    }
  )
  assert.ok(Date.now() - started < 350, 'the whole teardown ends near its one deadline')
  assert.throws(() => assertNotTearingDown('/r/app-shared'), (e) => e.code === 'CONFLICT' && e.message === 'a teardown is still finishing for this worktree')
})

test('runTeardown: a participant reached after the deadline is not started', async () => {
  let started = false
  const slow = { id: 'stack', plan: async () => [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], teardown: async () => {} }
  const next = { id: 'env', plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }], teardown: async () => void (started = true) }
  // The clock jumps past the deadline once the stack has started (Date.now: the deadline, the stack's time left, then the VM's).
  const where = { ...target, worktree: { ...target.worktree, id: 'w7', path: '/r/app-late' } }
  const origNow = Date.now
  let calls = 0
  Date.now = () => origNow() + (++calls > 2 ? 10_000 : 0)
  try {
    await assert.rejects(runTeardown([slow, next], where, 'remove', ['stack:destroy', 'env:destroy'], { teardownTimeoutMs: 5_000 }), (e) => {
      assert.equal(e.message, "Couldn't stop the VM: no time was left for it (already done: Tear down the dev stack)")
      assert.deepEqual(e.details, { reason: 'teardown', tornDown: ['Tear down the dev stack'] })
      return true
    })
  } finally {
    Date.now = origNow
  }
  assert.equal(started, false)
  assertNotTearingDown(where.worktree.path)
})

test('TEARDOWN_RUN_TIMEOUT_MS: a minute under the clients\' wait for the request', () => {
  assert.equal(TEARDOWN_RUN_TIMEOUT_MS, TEARDOWN_REQUEST_TIMEOUT_MS - 60_000)
})

test('runTeardown: an id no participant here offers is refused with a hint, before anything runs', async () => {
  const log = []
  const ps = [participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log)]
  await assert.rejects(runTeardown(ps, target, 'remove', ['vms:vm', 'stack:destroy']), (e) => e.code === 'BAD_REQUEST' && e.message === '"vms:vm" is not offered for this worktree; reopen the confirm')
  assert.deepEqual(log, [], 'nothing ran')
  await assert.rejects(runTeardown(ps, target, 'remove', ['ghost:y']), (e) => e.code === 'BAD_REQUEST' && e.message === '"ghost:y" is not offered for this worktree; reopen the confirm')
})

test("runTeardown: the label's first letter is lowercased only when it starts an ordinary word", async () => {
  const log = []
  const ps = [participant('env', [{ id: 'destroy', label: 'VM “dev” deleted', checked: true }], log, { failOn: 'destroy' })]
  await assert.rejects(runTeardown(ps, target, 'remove', ['env:destroy']), (e) => e.message === "Couldn't VM “dev” deleted: it would not stop")
})

test('planTeardown and runTeardown: two participants with one id is an internal error', async () => {
  const log = []
  const ps = [participant('env', [], log), participant('env', [], log)]
  await assert.rejects(planTeardown(ps, target, 'remove'), /twice/)
  await assert.rejects(runTeardown(ps, target, 'remove', ['env:x']), /twice/)
})

test('repoRemoveVeto: an answer that is not a reason, and a check that hangs, refuse', async () => {
  const p = (id, check) => ({ id, plan: async () => [], teardown: async () => {}, beforeRepoRemove: check })
  assert.equal(await repoRemoveVeto([p('a', async () => 42)], target.project, target.repo), 'a could not check it: not a reason')
  assert.equal(await repoRemoveVeto([p('a', async () => undefined)], target.project, target.repo), null, 'undefined is no veto, like null')
  assert.equal(await repoRemoveVeto([p('a', async () => '')], target.project, target.repo), null)
  assert.match(await repoRemoveVeto([p('a', () => new Promise(() => {}))], target.project, target.repo, { timeoutMs: 50 }), /^a could not check it: no answer in 0.05 s$/)
})

test('runTeardown: after a teardown hits the cap, the worktree stays busy until it really ends; so is every other operation on it', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let calls = 0
  const late = {
    id: 'env',
    plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }],
    teardown: async () => {
      calls += 1
      if (calls === 1) await gate
    }
  }
  await assert.rejects(runTeardown([late], target, 'remove', ['env:destroy'], { teardownTimeoutMs: 50 }), /no answer in 0.05 s/)
  const finishing = (e) => e.code === 'CONFLICT' && e.message === 'a teardown is still finishing for this worktree'
  await assert.rejects(runTeardown([late], target, 'remove', ['env:destroy']), finishing)
  await assert.rejects(runTeardown([late], target, 'remove', []), finishing, 'even with nothing chosen')
  assert.throws(() => assertNotTearingDown(target.worktree.path), finishing)
  await assert.rejects(holdWorktree(target.worktree.path, 'removing it', async () => 'x'), finishing)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assertNotTearingDown(target.worktree.path)
  await runTeardown([late], target, 'remove', ['env:destroy'])
  assert.equal(calls, 2)
})

test('holdWorktree: the worktree is busy for the whole operation; runTeardown inside it takes the hold', async () => {
  const log = []
  const ps = [participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log)]
  // The CONFLICT names what holds the worktree (an unreceive is no teardown).
  const running = (e) => e.code === 'CONFLICT' && e.message === 'this worktree is busy: undoing a move; try again once it is done'
  const answer = await holdWorktree(target.worktree.path, 'undoing a move', async (hold) => {
    assert.throws(() => assertNotTearingDown(target.worktree.path), running)
    await assert.rejects(runTeardown(ps, target, 'remove', ['stack:destroy']), running)
    await assert.rejects(holdWorktree(target.worktree.path, 'promoting it', async () => {}), running)
    await runTeardown(ps, target, 'remove', ['stack:destroy'], { hold })
    await runTeardown(ps, target, 'remove', [], { hold })
    assert.throws(() => assertNotTearingDown(target.worktree.path), running, 'still held after its teardown')
    return 'removed'
  })
  assert.equal(answer, 'removed')
  assert.deepEqual(log, [['stack', 'remove', ['destroy']]])
  assertNotTearingDown(target.worktree.path)
  await assert.rejects(holdWorktree(target.worktree.path, 'removing it', async () => {
    throw new Error('git failed')
  }), /git failed/)
  assertNotTearingDown(target.worktree.path)
  const other = { ...target, worktree: { ...target.worktree, path: '/r/elsewhere' } }
  await holdWorktree(target.worktree.path, 'removing it', async (hold) => {
    await assert.rejects(runTeardown(ps, other, 'remove', ['stack:destroy'], { hold }), /another worktree/)
  })
})

test('holdWorktree: a teardown that hits the cap inside it keeps the worktree busy after the operation ends', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const late = { id: 'env', plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }], teardown: () => gate }
  const where = { ...target, worktree: { ...target.worktree, path: '/r/app-held' } }
  await assert.rejects(holdWorktree(where.worktree.path, 'removing it', (hold) => runTeardown([late], where, 'remove', ['env:destroy'], { hold, teardownTimeoutMs: 50 })), /no answer/)
  assert.throws(() => assertNotTearingDown(where.worktree.path), (e) => e.code === 'CONFLICT' && e.message === 'a teardown is still finishing for this worktree')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assertNotTearingDown(where.worktree.path)
})

test('toWireError: a teardown failure carries tornDown (strings only)', () => {
  const err = codedError('TOOL_ERROR', "Couldn't stop the VM: no", { reason: 'teardown', tornDown: ['Tear down the dev stack'] })
  assert.deepEqual(toWireError('worktree.remove', err), { code: 'TOOL_ERROR', message: "Couldn't stop the VM: no", details: { reason: 'teardown', tornDown: ['Tear down the dev stack'] } })
  assert.deepEqual(toWireError('worktree.remove', codedError('TOOL_ERROR', 'x', { reason: 'teardown', tornDown: [] })).details, { reason: 'teardown', tornDown: [] })
  assert.deepEqual(toWireError('worktree.remove', codedError('TOOL_ERROR', 'x', { reason: 'teardown', tornDown: [1, 'a'] })).details, { reason: 'teardown' })
  assert.deepEqual(toWireError('worktree.remove', codedError('TOOL_ERROR', 'x', { tornDown: ['a'] })).details, { tornDown: ['a'] })
  assert.equal(toWireError('worktree.remove', codedError('TOOL_ERROR', 'x', { tornDown: 'a' })).details, undefined)
})

test("participantsFor: core's stack with machine services, never on Windows; then the plugins' in order (the VM is the env plugin's since E2)", () => {
  const machine = { stacks: {} }
  const lifecycle = { plan: async () => [], teardown: async () => {} }
  const ctx = { store: {}, machine, caller: 'c1', plugins: { lifecycles: () => [{ id: 'one', lifecycle }, { id: 'two', lifecycle }] } }
  assert.deepEqual(participantsFor(ctx, 'p1', 'linux').map((p) => p.id), ['stack', 'one', 'two'])
  assert.deepEqual(participantsFor(ctx, 'p1', 'win32').map((p) => p.id), ['one', 'two'])
  assert.deepEqual(participantsFor({ ...ctx, machine: undefined }, 'p1', 'darwin').map((p) => p.id), ['one', 'two'])
  // A test's stand-in for the registry may have no lifecycles.
  assert.deepEqual(participantsFor({ store: {}, plugins: { prProviders: () => [] } }, 'p1', 'linux'), [])
})

test('withTornDown: a failure after the teardown keeps its code, message and reason, and says what was torn down; toWireError passes it on any code', () => {
  const dirty = codedError('GIT_ERROR', 'has modified or untracked files', { reason: 'dirty' })
  const out = withTornDown(dirty, ['Stop the VM'])
  assert.equal(out, dirty)
  assert.deepEqual(toWireError('worktree.remove', out), { code: 'GIT_ERROR', message: 'has modified or untracked files', details: { reason: 'dirty', tornDown: ['Stop the VM'] } })
  const plain = codedError('CONFLICT', 'locked')
  assert.equal(withTornDown(plain, []), plain)
  assert.equal(plain.details, undefined, 'nothing torn down: as it was')
  assert.deepEqual(toWireError('worktree.promote', withTornDown(new Error('boom'), ['A'])), { code: 'INTERNAL', message: 'boom', details: { tornDown: ['A'] } })
  assert.deepEqual(toWireError('worktree.promote', withTornDown('odd', ['A'])), { code: 'INTERNAL', message: 'odd', details: { tornDown: ['A'] } })
  // An unexpected error's own reason stays on the server.
  assert.deepEqual(toWireError('worktree.promote', Object.assign(new Error('x'), { details: { reason: 'r' } })), { code: 'INTERNAL', message: 'x' })
})

test('planTeardown: an item may say it is running (a boolean); anything else there leaves it out', async () => {
  const warnings = []
  const items = await planTeardown(
    [participant('vms', [{ id: 'up', label: 'Stop the VM', checked: true, running: true }, { id: 'down', label: 'Delete the stopped VM', checked: false, running: false }, { id: 'odd', label: 'x', checked: true, running: 'yes' }], [])],
    target,
    'move',
    { warn: (m) => warnings.push(m) }
  )
  assert.deepEqual(items, [
    { id: 'vms:up', label: 'Stop the VM', checked: true, running: true },
    { id: 'vms:down', label: 'Delete the stopped VM', checked: false }
  ])
  assert.equal(warnings.length, 1)
})

test('the stack participant says whether its stack is running (plugins E1)', async () => {
  const ctx = { store: { guard: { check: () => {} } } }
  const stackOf = (status) => stackParticipant(ctx, { stacks: { status: async () => status } })
  const stack = { available: true, created: true, slug: 'app-feat', stopping: false, hasAdmin: false }
  assert.deepEqual((await stackOf({ ...stack, containers: 0, upRunning: false }).plan(target, 'move')).map((i) => i.running), [undefined])
  assert.deepEqual((await stackOf({ ...stack, containers: 2, upRunning: false }).plan(target, 'move')).map((i) => i.running), [true])
  assert.deepEqual((await stackOf({ ...stack, containers: 0, upRunning: true }).plan(target, 'move')).map((i) => i.running), [true])
})

test("busyReason and anyBusy (plugins E2): a hold's label, then 'finishing' while a timed-out teardown runs on, then free", async () => {
  const path = '/r/app-busy-reason'
  const where = { ...target, worktree: { ...target.worktree, id: 'w-busy', path } }
  assert.equal(busyReason(path), null)
  let finish
  const late = { id: 'env', plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }], teardown: () => new Promise((resolve) => (finish = resolve)) }
  await holdWorktree(path, 'removing it', async () => {
    assert.equal(anyBusy(), true)
    assert.equal(busyReason(path), 'this worktree is busy: removing it; try again once it is done')
  })
  assert.equal(busyReason(path), null)
  await assert.rejects(runTeardown([late], where, 'remove', ['env:destroy'], { teardownTimeoutMs: 30 }), (e) => e.code === 'TOOL_ERROR')
  assert.equal(busyReason(path), 'a teardown is still finishing for this worktree')
  assert.equal(anyBusy(), true)
  finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(busyReason(path), null)
})
