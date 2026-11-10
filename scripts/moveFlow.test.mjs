// scripts/moveFlow.test.mjs — the app's worktree move (phase 5d) over fake source and target servers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { moveTargets, moveWorktree } from '../src/renderer/src/v2/moveFlow.ts'
import { ClientError } from '../src/shared/client/connection.ts'

const EXPORT = { branch: 'feat', head: 'a'.repeat(40), patch: 'diff', sessions: [{ title: 'c' }], notCarried: ['Codex 1: only Claude sessions move'], branchData: { note: 'n' }, fingerprint: 'f'.repeat(64) }

/** A fake server: answers by method, records every call. */
function fake(answers) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(params) : answer ?? null
  }
  return { calls, request, methods: () => calls.map(([m]) => m) }
}

function run(source, target, over = {}) {
  const steps = []
  const outcome = moveWorktree({
    source: source.request,
    target: target.request,
    from: { projectId: 'pa', worktreeId: 'wa' },
    to: { projectId: 'pb', repoId: 'rb' },
    loaded: true,
    progress: (step, status, detail) => steps.push([step, status, detail]),
    cancelled: () => false,
    ...over
  })
  return { outcome, steps }
}

test('a move unloads, exports, pushes, receives and finishes, in that order', async () => {
  const source = fake({ 'move.export': EXPORT })
  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: ['The tag “X” is not one of this project’s tags'] } })
  const { outcome } = run(source, target)
  const result = await outcome
  assert.equal(result.kind, 'moved')
  assert.equal(result.worktreeId, 'wb')
  assert.deepEqual(result.notes, ['Not carried: Codex 1: only Claude sessions move', 'The tag “X” is not one of this project’s tags'])
  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'move.finish'])
  assert.deepEqual(source.calls[3][1], { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint })
  assert.deepEqual(target.calls[0], ['move.receive', { projectId: 'pb', repoId: 'rb', branch: 'feat', head: EXPORT.head, patch: 'diff', sessions: EXPORT.sessions, branchData: { note: 'n' } }])
})

test('a failed push leaves the target alone and loads the source again', async () => {
  const source = fake({ 'move.export': EXPORT, 'worktree.push': new ClientError('GIT_ERROR', 'rejected') })
  const target = fake({})
  const { outcome, steps } = run(source, target)
  const result = await outcome
  assert.deepEqual([result.kind, result.step], ['failed', 'push'])
  assert.deepEqual(target.calls, [])
  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'worktree.load'])
  assert.ok(steps.some(([s, st]) => s === 'push' && st === 'failed'))
})

test('an unloaded worktree is not loaded afterwards, and cancelling stops before the target', async () => {
  const source = fake({ 'move.export': EXPORT })
  const target = fake({})
  let n = 0
  const { outcome } = run(source, target, { loaded: false, cancelled: () => ++n > 3 })
  const result = await outcome
  assert.equal(result.kind, 'failed')
  assert.equal(result.error, 'Cancelled')
  assert.deepEqual(target.calls, [])
  assert.ok(!source.methods().includes('worktree.unload'))
  assert.ok(!source.methods().includes('worktree.load'))
})

test('a refused receive restores the source; a lost answer says the target may have it', async () => {
  const refused = fake({ 'move.export': EXPORT })
  const r1 = await run(refused, fake({ 'move.receive': new ClientError('CONFLICT', 'checked out elsewhere') })).outcome
  assert.deepEqual([r1.kind, r1.step], ['failed', 'receive'])
  assert.equal(refused.methods().at(-1), 'worktree.load')
  const lost = fake({ 'move.export': EXPORT })
  const r2 = await run(lost, fake({ 'move.receive': new ClientError('NOT_CONNECTED', 'gone') })).outcome
  assert.equal(r2.kind, 'unknown')
  assert.match(r2.error, /may have created/)
  assert.ok(!lost.methods().includes('move.finish'))
})

test('a source changed after the copy: the target copy is removed again', async () => {
  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('CONFLICT', 'it changed') })
  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
  const result = await run(source, target).outcome
  assert.deepEqual([result.kind, result.step], ['failed', 'finish'])
  assert.deepEqual(target.calls[1], ['worktree.remove', { projectId: 'pb', worktreeId: 'wb', force: true }])
  assert.equal(source.methods().at(-1), 'worktree.load')
})

test('a finish that fails otherwise leaves both copies and says so', async () => {
  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('GIT_ERROR', 'busy') })
  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
  const result = await run(source, target).outcome
  assert.equal(result.kind, 'both')
  assert.equal(result.worktreeId, 'wb')
  assert.equal(target.calls.length, 1)
})

test('move targets: the other entries with a token whose server takes a move', () => {
  const link = (id, over = {}) => ({ id, name: id, url: '', hasToken: true, status: 'connected', message: '', ...over })
  const servers = [link('own'), link('b', { capabilities: ['move'] }), link('old', { capabilities: ['review'] }), link('notoken', { hasToken: false }), link('down')]
  assert.deepEqual(moveTargets(servers, 'own').map((s) => s.id), ['b', 'down'])
  assert.deepEqual(moveTargets([link('web')], 'web'), [], 'the web client has only its own server')
  assert.deepEqual(moveTargets(null, 'own'), [])
})
