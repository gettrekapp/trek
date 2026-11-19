// scripts/serverTeardown.test.mjs — the worktree teardown's planning and running (plugins E1), over
// made-up participants: plans in participant order with ids namespaced, a plan that throws, hangs
// or answers nonsense left out, the chosen items run in order, a failure stopping the rest, unknown
// ids refused before anything runs, and the repository veto.
import test from 'node:test'
import assert from 'node:assert/strict'
import { optionalTeardown, planTeardown, repoRemoveVeto, requireOp, runTeardown } from '../server/src/teardown/teardown.ts'
import { defaultTeardown } from '../src/shared/teardown.ts'

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

test('runTeardown: the chosen items in participant order, each participant once with its own ids; none chosen runs nothing', async () => {
  const log = []
  const ps = [
    participant('stack', [{ id: 'destroy', label: 'Tear down the dev stack', checked: true }], log),
    participant('env', [{ id: 'destroy', label: 'Stop the VM', checked: true }, { id: 'cache', label: 'Drop the cache', checked: false }], log)
  ]
  await runTeardown(ps, target, 'promote', ['env:cache', 'stack:destroy', 'env:destroy'])
  assert.deepEqual(log, [['stack', 'promote', ['destroy']], ['env', 'promote', ['cache', 'destroy']]])
  await runTeardown(ps, target, 'remove', [])
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
  await runTeardown(ps, target, 'remove', ['env:gone'], { warn: (m) => warnings.push(m) })
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
  await assert.rejects(runTeardown([slow], target, 'remove', ['slow:x']), (e) => e.code === 'CONFLICT' && e.message === 'a teardown is already running for this worktree')
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

test('runTeardown: an id of a plugin that is now off is skipped; an unknown one is refused with a hint', async () => {
  const log = []
  const warnings = []
  const ps = [participant('stack', [{ id: 'destroy', label: 'Tear down', checked: true }], log)]
  await runTeardown(ps, target, 'remove', ['vms:vm', 'stack:destroy'], { inactive: ['vms'], warn: (m) => warnings.push(m) })
  assert.deepEqual(log, [['stack', 'remove', ['destroy']]])
  assert.match(warnings.join('\n'), /vms:vm is no longer planned/)
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
  assert.equal(await repoRemoveVeto([p('a', async () => undefined)], target.project, target.repo), 'a could not check it: not a reason')
  assert.equal(await repoRemoveVeto([p('a', async () => '')], target.project, target.repo), null)
  assert.match(await repoRemoveVeto([p('a', () => new Promise(() => {}))], target.project, target.repo, { timeoutMs: 50 }), /^a could not check it: no answer in 0.05 s$/)
})

test('runTeardown: after a teardown hits the cap, the worktree stays busy until it really ends', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const calls = []
  const late = {
    id: 'env',
    plan: async () => [{ id: 'destroy', label: 'Stop the VM', checked: true }],
    teardown: async () => {
      calls.push(Date.now())
      if (calls.length === 1) await wait(150)
    }
  }
  const t0 = Date.now()
  await assert.rejects(runTeardown([late], target, 'remove', ['env:destroy'], { teardownTimeoutMs: 50 }), /no answer in 0.05 s/)
  await wait(100 - (Date.now() - t0))
  await assert.rejects(runTeardown([late], target, 'remove', ['env:destroy']), (e) => e.code === 'CONFLICT' && e.message === 'a teardown is still finishing for this worktree')
  await wait(200 - (Date.now() - t0))
  await runTeardown([late], target, 'remove', ['env:destroy'])
  assert.equal(calls.length, 2)
})
