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
