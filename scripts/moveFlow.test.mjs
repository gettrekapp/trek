// scripts/moveFlow.test.mjs — the app's worktree move (phase 5d) over fake source and target servers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { moveTargets, moveTeardownCheck, moveWorktree } from '../src/renderer/src/v2/moveFlow.ts'
import { ClientError } from '../src/shared/client/connection.ts'
import { MOVE_FETCH_TIMEOUT_MS } from '../src/shared/move.ts'
import { TEARDOWN_REQUEST_TIMEOUT_MS } from '../src/shared/teardown.ts'

const SID = '11111111-2222-4333-8444-555555555555'
const EXPORT = { branch: 'feat', head: 'a'.repeat(40), patch: 'diff', sessions: [{ title: 'c', agentSessionId: SID, historyBytes: 10, historySha256: 'e'.repeat(64) }], notCarried: ['Codex 1: only Claude sessions move'], branchData: { note: 'n' }, fingerprint: 'f'.repeat(64) }

/** A fake server: answers by method, records every call. */
function fake(answers) {
  const calls = []
  const options = []
  const request = async (method, params, opts) => {
    calls.push([method, params])
    options.push([method, opts])
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(params) : answer ?? null
  }
  return { calls, options, request, methods: () => calls.map(([m]) => m) }
}

/** A source whose history SID is 10 bytes, read 4 at a time ('YWJj' + ...) */
const HISTORY = Buffer.from('0123456789')
const historyChunks = ({ offset }) => {
  const part = HISTORY.subarray(offset, offset + 4)
  return { data: part.toString('base64'), offset, total: 10, done: offset + part.length >= 10 }
}
const src = (answers = {}) => fake({ 'move.export': EXPORT, 'move.history': historyChunks, ...answers })
const tgt = (answers = {}) => fake({ 'move.begin': { transferId: 't1' }, 'move.upload': ({ offset, data }) => ({ size: offset + Buffer.from(data, 'base64').length }), ...answers })

function run(source, target, over = {}) {
  const steps = []
  const outcome = moveWorktree({
    source: source.request,
    target: target.request,
    from: { projectId: 'pa', worktreeId: 'wa' },
    to: { projectId: 'pb', repoId: 'rb' },
    loaded: true,
    targetCapabilities: ['move', 'env'],
    progress: (step, status, detail) => steps.push([step, status, detail]),
    cancelled: () => false,
    ...over
  })
  return { outcome, steps }
}

test('a move unloads, exports, pushes, receives and finishes, in that order', async () => {
  const source = src()
  const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: ['The tag “X” is not one of this project’s tags'] } })
  const { outcome } = run(source, target)
  const result = await outcome
  assert.equal(result.kind, 'moved')
  assert.equal(result.worktreeId, 'wb')
  assert.deepEqual(result.notes, ['Not carried: Codex 1: only Claude sessions move', 'The tag “X” is not one of this project’s tags'])
  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'move.history', 'move.history', 'move.history', 'move.finish'])
  assert.deepEqual(source.calls[6][1], { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint })
  assert.deepEqual(target.methods(), ['move.begin', 'move.upload', 'move.upload', 'move.upload', 'move.receive'])
  assert.deepEqual(target.calls.slice(1, 4).map(([, p]) => p.offset), [0, 4, 8], 'in order, each at what is staged')
  assert.equal(Buffer.concat(target.calls.slice(1, 4).map(([, p]) => Buffer.from(p.data, 'base64'))).toString(), '0123456789')
  assert.deepEqual(target.calls[4], ['move.receive', { projectId: 'pb', repoId: 'rb', branch: 'feat', head: EXPORT.head, patch: 'diff', sessions: EXPORT.sessions, branchData: { note: 'n' }, transferId: 't1' }])
})

test('a failed push leaves the target alone and loads the source again', async () => {
  const source = src({ 'worktree.push': new ClientError('GIT_ERROR', 'rejected') })
  const target = tgt()
  const { outcome, steps } = run(source, target)
  const result = await outcome
  assert.deepEqual([result.kind, result.step], ['failed', 'push'])
  assert.deepEqual(target.calls, [])
  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'worktree.load'])
  assert.ok(steps.some(([s, st]) => s === 'push' && st === 'failed'))
})

test('an unloaded worktree is not loaded afterwards, and cancelling stops before the target', async () => {
  const source = src()
  const target = tgt()
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
  const refused = src()
  const r1 = await run(refused, tgt({ 'move.receive': new ClientError('CONFLICT', 'checked out elsewhere') })).outcome
  assert.deepEqual([r1.kind, r1.step], ['failed', 'receive'])
  assert.equal(refused.methods().at(-1), 'worktree.load')
  const lost = src()
  const lostTarget = tgt({ 'move.receive': new ClientError('NOT_CONNECTED', 'gone') })
  const r2 = await run(lost, lostTarget).outcome
  assert.equal(lostTarget.methods().at(-1), 'move.abort', 'the staged upload is dropped (a no-op if receive took it)')
  assert.equal(r2.kind, 'unknown')
  assert.equal(r2.error, 'gone')
  assert.equal(lost.methods().at(-1), 'worktree.load', 'the intact source is loaded again')
  assert.ok(!lost.methods().includes('move.finish'))
})

test('a source changed after the copy: move.unreceive undoes the target copy whole', async () => {
  const source = src({ 'move.finish': new ClientError('CONFLICT', 'it changed') })
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const result = await run(source, target).outcome
  assert.deepEqual([result.kind, result.step, result.undone, result.restored, result.cancelled], ['failed', 'finish', true, true, false])
  assert.deepEqual(target.calls.at(-1), ['move.unreceive', { projectId: 'pb', repoId: 'rb', undoToken: 'u1' }])
  assert.ok(!target.methods().includes('worktree.remove'), 'no worktree.remove: the undo is the receive\'s own')
  assert.equal(source.methods().at(-1), 'worktree.load')
})

test('a refused undo (the target restarted, or its copy was loaded) keeps both and says so', async () => {
  for (const code of ['NOT_FOUND', 'IN_USE', 'CONFLICT']) {
    const source = src({ 'move.finish': new ClientError('CONFLICT', 'it changed') })
    const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' }, 'move.unreceive': new ClientError(code, 'no such receive') })
    const result = await run(source, target).outcome
    assert.equal(result.kind, 'both', code)
    assert.equal(result.worktreeId, 'wb')
    assert.match(result.error, /could not be undone \(no such receive\).*both servers have the worktree/)
    assert.ok(!target.methods().includes('worktree.remove'), `${code}: no fallback to worktree.remove`)
    assert.equal(source.methods().at(-1), 'worktree.load', 'the source, intact, is loaded again')
  }
})

test("a failed reload of the source is reported, not swallowed", async () => {
  const source = src({ 'worktree.push': new ClientError('GIT_ERROR', 'rejected'), 'worktree.load': new ClientError('NOT_CONNECTED', 'gone') })
  const result = await run(source, tgt()).outcome
  assert.deepEqual([result.kind, result.restored], ['failed', false])
  const untouched = await run(src({ 'worktree.push': new ClientError('GIT_ERROR', 'rejected') }), tgt(), { loaded: false }).outcome
  assert.equal(untouched.restored, true, 'nothing to reload counts as restored')
})

test('a lost receive answer loads the source again (it is intact)', async () => {
  const source = src()
  const result = await run(source, tgt({ 'move.receive': new ClientError('TIMEOUT', 'timed out') })).outcome
  assert.deepEqual([result.kind, result.restored], ['unknown', true])
  assert.equal(source.methods().at(-1), 'worktree.load')
})

test('a cancel mid-histories marks that step skipped "cancelled", not left active', async () => {
  let reads = 0
  const source = src({ 'move.history': (p) => { reads++; return historyChunks(p) } })
  const { outcome, steps } = run(source, tgt(), { cancelled: () => reads >= 2 })
  const result = await outcome
  assert.deepEqual([result.kind, result.cancelled], ['failed', true])
  assert.deepEqual(steps.at(-1), ['histories', 'skipped', 'cancelled'])
})

test('an unticked teardown says so', async () => {
  const { outcome, steps } = run(src(), tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } }), { teardownUnticked: true })
  await outcome
  assert.deepEqual(steps.find(([s]) => s === 'teardown'), ['teardown', 'skipped', 'left in place (unticked)'])
  const none = run(src(), tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } }))
  await none.outcome
  assert.deepEqual(none.steps.find(([s]) => s === 'teardown'), ['teardown', 'skipped', 'nothing to tear down'])
})

test('a finish that fails otherwise leaves both copies and says so', async () => {
  const source = src({ 'move.finish': new ClientError('GIT_ERROR', 'busy') })
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const result = await run(source, target).outcome
  assert.equal(result.kind, 'both')
  assert.equal(result.worktreeId, 'wb')
  assert.equal(target.methods().at(-1), 'move.receive')
})

test('move targets: the other entries with a token whose server takes a move', () => {
  const link = (id, over = {}) => ({ id, name: id, url: '', hasToken: true, status: 'connected', message: '', ...over })
  const servers = [link('own'), link('b', { capabilities: ['move'] }), link('old', { capabilities: ['review'] }), link('notoken', { hasToken: false }), link('down')]
  assert.deepEqual(moveTargets(servers, 'own').map((s) => s.id), ['b', 'down'])
  assert.deepEqual(moveTargets([link('web')], 'web'), [], 'the web client has only its own server')
  assert.deepEqual(moveTargets(null, 'own'), [])
})

test("the branch's .env goes only to a target with environments", async () => {
  const withEnv = { ...EXPORT, branchData: { note: 'n', env: 'A=1' } }
  const receiveOf = (t) => t.calls.find(([m]) => m === 'move.receive')[1]
  const t1 = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  await run(src({ 'move.export': withEnv }), t1).outcome
  assert.deepEqual(receiveOf(t1).branchData, { note: 'n', env: 'A=1' })
  const t2 = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const result = await run(src({ 'move.export': withEnv }), t2, { targetCapabilities: ['move'] }).outcome
  assert.deepEqual(receiveOf(t2).branchData, { note: 'n' })
  assert.ok(result.notes.some((n) => n.includes('.env was not carried')))
})

test("a target without environments (plugins E2) gets neither the .env nor the env plugin's copy of it; other plugins' settings go", async () => {
  const withEnv = { ...EXPORT, branchData: { note: 'n', env: 'A=1', pluginSettings: { env: { env: 'A=1' }, other: { on: true } } } }
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const result = await run(src({ 'move.export': withEnv }), target, { targetCapabilities: ['move'] }).outcome
  assert.deepEqual(target.calls.find(([m]) => m === 'move.receive')[1].branchData, { note: 'n', pluginSettings: { other: { on: true } } })
  assert.ok(result.notes.some((n) => n.includes('.env was not carried')))
})

test('a failed upload, or a cancel between chunks, drops the staged transfer and loads the source again', async () => {
  const source = src()
  const target = tgt({ 'move.upload': new ClientError('BAD_REQUEST', 'too big') })
  const result = await run(source, target).outcome
  assert.deepEqual([result.kind, result.step], ['failed', 'histories'])
  assert.deepEqual(target.methods(), ['move.begin', 'move.upload', 'move.abort'])
  assert.equal(source.methods().at(-1), 'worktree.load')
  let reads = 0
  const slow = src({ 'move.history': (p) => { reads++; return historyChunks(p) } })
  const t2 = tgt()
  const r2 = await run(slow, t2, { cancelled: () => reads >= 2 }).outcome
  assert.equal(r2.error, 'Cancelled')
  assert.equal(t2.methods().at(-1), 'move.abort')
  assert.ok(!t2.methods().includes('move.receive'))
})

test('a move with no carried session copies nothing and sends no transfer', async () => {
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  await run(src({ 'move.export': { ...EXPORT, sessions: [] } }), target).outcome
  assert.deepEqual(target.methods(), ['move.receive'])
  assert.equal(target.calls[0][1].transferId, undefined)
})

test('the teardown runs only after the target has it and the source checks unchanged, before the source goes', async () => {
  const order = []
  const source = src({ 'move.finish': (p) => { order.push(p.verifyOnly ? 'verify' : 'finish'); return null } })
  const target = tgt({ 'move.receive': () => { order.push('receive'); return { worktreeId: 'wb', dropped: [], undoToken: 'u1' } } })
  const result = await run(source, target, { teardown: async () => { order.push('teardown'); return [] } }).outcome
  assert.equal(result.kind, 'moved')
  assert.deepEqual(order, ['receive', 'verify', 'teardown', 'finish'])
})

test('a source changed before the teardown: nothing is torn down and the target copy goes', async () => {
  let tornDown = false
  const source = src({ 'move.finish': (p) => { if (p.verifyOnly) throw new ClientError('CONFLICT', 'it changed'); return null } })
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const result = await run(source, target, { teardown: async () => { tornDown = true; return [] } }).outcome
  assert.deepEqual([result.kind, result.step], ['failed', 'teardown'])
  assert.equal(tornDown, false)
  assert.equal(target.methods().at(-1), 'move.unreceive')
  assert.equal(source.methods().at(-1), 'worktree.load')
})

test('teardown warnings become notes; a change after the teardown keeps both copies', async () => {
  const warned = await run(src(), tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } }), { teardown: async () => ['stack.sh destroy exited with code 1.'] }).outcome
  assert.equal(warned.kind, 'moved')
  assert.ok(warned.notes.includes('stack.sh destroy exited with code 1.'))
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  const late = src({ 'move.finish': (p) => { if (!p.verifyOnly) throw new ClientError('CONFLICT', 'changed by the teardown'); return null } })
  const both = await run(late, target, { teardown: async () => [] }).outcome
  assert.equal(both.kind, 'both')
  assert.match(both.error, /torn down/)
  assert.ok(!target.methods().includes('worktree.remove'))
  assert.ok(!target.methods().includes('move.unreceive'), 'after a teardown both copies are kept')
})

test('M4: move.receive waits longer than the target\'s fetch may take', async () => {
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })
  await run(src(), target).outcome
  const [, opts] = target.options.find(([m]) => m === 'move.receive')
  assert.ok(opts.timeoutMs >= MOVE_FETCH_TIMEOUT_MS + 60_000, String(opts.timeoutMs))
})

test('M7: a finish that fails without an undo loads the source again and says so', async () => {
  const source = src({ 'move.finish': new ClientError('GIT_ERROR', 'busy') })
  const result = await run(source, tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })).outcome
  assert.equal(result.kind, 'both')
  assert.equal(source.methods().at(-1), 'worktree.load')
  assert.match(result.error, /sessions were started again/)
  const failing = src({ 'move.finish': new ClientError('GIT_ERROR', 'busy'), 'worktree.load': new ClientError('GIT_ERROR', 'no') })
  const r2 = await run(failing, tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })).outcome
  assert.match(r2.error, /load it again/)
  // After a teardown, a change keeps both: the source's sessions are started again too.
  const late = src({ 'move.finish': (p) => { if (!p.verifyOnly) throw new ClientError('CONFLICT', 'changed'); return null } })
  const r3 = await run(late, tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } }), { teardown: async () => [] }).outcome
  assert.equal(r3.kind, 'both')
  assert.equal(late.methods().at(-1), 'worktree.load')
  assert.match(r3.error, /sessions were started again/)
})

test('M7: a lost finish answer says the source may or may not have been removed', async () => {
  for (const code of ['NOT_CONNECTED', 'TIMEOUT']) {
    const source = src({ 'move.finish': new ClientError(code, 'gone') })
    const result = await run(source, tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1' } })).outcome
    assert.equal(result.kind, 'both', code)
    assert.match(result.error, /may or may not have been removed/)
    assert.match(result.error, /check/)
  }
})

test('history and the server name travel: move.receive gets them, only the real move.finish names the target', async () => {
  const history = [{ id: 'h1' }]
  const source = src({ 'move.export': { ...EXPORT, history, serverName: 'laptop' } })
  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [], undoToken: 'u1', serverName: 'desk' } })
  const result = await run(source, target, { teardown: async () => [] }).outcome
  assert.equal(result.kind, 'moved')
  const receive = target.calls.find(([m]) => m === 'move.receive')[1]
  assert.deepEqual([receive.history, receive.fromServer], [history, 'laptop'])
  const finishes = source.calls.filter(([m]) => m === 'move.finish').map(([, p]) => p)
  assert.equal(finishes.length, 2)
  assert.equal(finishes[0].verifyOnly, true)
  assert.ok(!('toServer' in finishes[0]))
  assert.equal(finishes[1].toServer, 'desk')
})

test('a source that tears down itself (worktreeTeardown): one move.finish with the chosen ids, after the target has it', async () => {
  const source = src()
  const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [], serverName: 'B' } })
  const { outcome, steps } = run(source, target, { teardownIds: ['stack:destroy', 'env:destroy'] })
  const result = await outcome
  assert.equal(result.kind, 'moved')
  assert.equal(source.calls.filter(([m]) => m === 'move.finish').length, 1, 'no verifyOnly first: the server checks before it tears down')
  assert.deepEqual(source.calls.at(-1), ['move.finish', { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint, teardown: ['stack:destroy', 'env:destroy'], toServer: 'B' }])
  assert.deepEqual(steps.filter(([s]) => s === 'teardown' || s === 'finish').map(([s, st]) => [s, st]), [['teardown', 'active'], ['teardown', 'done'], ['finish', 'done']])
  assert.deepEqual(source.options.find(([m]) => m === 'move.finish')[1], { timeoutMs: TEARDOWN_REQUEST_TIMEOUT_MS }, 'a destroy or a VM delete can take minutes')
})

test('worktreeTeardown: a source changed after the copy, a busy one, or a failed item, undoes the target copy; a failed removal after it keeps both', async () => {
  for (const err of [
    new ClientError('CONFLICT', 'changed after it was copied'),
    new ClientError('CONFLICT', 'a teardown is still finishing for this worktree'),
    new ClientError('CONFLICT', 'this worktree is busy: removing it; try again once it is done'),
    new ClientError('IN_USE', 'loaded again after it was copied'),
    new ClientError('BAD_REQUEST', 'unknown teardown item ghost:x'),
    new ClientError('TOOL_ERROR', "Couldn't stop the VM: stuck", { reason: 'teardown' }),
    new ClientError('TOOL_ERROR', "Couldn't stop the VM: stuck (already done: Tear down the dev stack)", { reason: 'teardown', tornDown: ['Tear down the dev stack'] })
  ]) {
    const source = src({ 'move.finish': err })
    const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } })
    const { outcome, steps } = run(source, target, { teardownIds: ['env:destroy'] })
    const result = await outcome
    assert.deepEqual([result.kind, result.step, result.undone], ['failed', 'teardown', true], err.message)
    assert.equal(result.error, err.message)
    assert.equal(target.methods().at(-1), 'move.unreceive')
    assert.equal(source.methods().at(-1), 'worktree.load')
    assert.deepEqual(steps.find(([s, st]) => s === 'teardown' && st === 'failed'), ['teardown', 'failed', err.message])
  }
  const source = src({ 'move.finish': new ClientError('GIT_ERROR', 'locked') })
  const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } })
  const locked = run(source, target, { teardownIds: ['env:destroy'] })
  const result = await locked.outcome
  assert.deepEqual(locked.steps.find(([s, st]) => s === 'teardown' && st !== 'active'), ['teardown', 'skipped', 'nothing was torn down'])
  assert.equal(result.kind, 'both')
  assert.ok(!target.methods().includes('move.unreceive'))
  assert.match(result.error, /source's copy was not removed/)
})

test('worktreeTeardown: a failure after the teardown (details.tornDown) keeps both and names what was torn down', async () => {
  for (const err of [
    new ClientError('GIT_ERROR', 'locked', { tornDown: ['Delete the VM “trek-app”', 'Tear down the dev stack “trek-app-feat”'] }),
    new ClientError('CONFLICT', 'changed meanwhile', { tornDown: ['Delete the VM “trek-app”', 'Tear down the dev stack “trek-app-feat”'] })
  ]) {
    const source = src({ 'move.finish': err })
    const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } })
    const { outcome, steps } = run(source, target, { teardownIds: ['env:destroy', 'stack:destroy'] })
    const result = await outcome
    assert.equal(result.kind, 'both', err.message)
    assert.ok(!target.methods().includes('move.unreceive'), 'the source lost its VM: both copies are kept')
    assert.match(result.error, /already run and is not undone: Delete the VM “trek-app”; Tear down the dev stack “trek-app-feat”/)
    assert.deepEqual(steps.find(([s, st]) => s === 'teardown' && st !== 'active').slice(0, 2), ['teardown', 'done'])
  }
})

test('worktreeTeardown: a lost finish answer keeps both and says the teardown may or may not have run', async () => {
  for (const code of ['TIMEOUT', 'NOT_CONNECTED']) {
    const source = src({ 'move.finish': new ClientError(code, 'gone') })
    const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } })
    const { outcome, steps } = run(source, target, { teardownIds: ['env:destroy'] })
    const result = await outcome
    assert.equal(result.kind, 'both', code)
    assert.ok(!target.methods().includes('move.unreceive'), code)
    assert.match(result.error, /may or may not have been removed/)
    assert.deepEqual(steps.find(([s, st]) => s === 'teardown' && st !== 'active'), ['teardown', 'failed', 'the answer was lost, so it may or may not have run'], code)
  }
})

test('worktreeTeardown with some items ticked: only those are sent, and the step is no "unticked" skip', async () => {
  const source = src()
  const { outcome, steps } = run(source, tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } }), { teardownIds: ['stack:destroy'] })
  assert.equal((await outcome).kind, 'moved')
  assert.deepEqual(source.calls.at(-1)[1].teardown, ['stack:destroy'])
  assert.deepEqual(steps.filter(([s]) => s === 'teardown').map(([, st]) => st), ['active', 'done'])
})

test('moveTeardownCheck: only an unticked item that is running blocks; a running stack the plan left out, or a participant the server could not ask, blocks too', () => {
  const stack = { id: 'stack:destroy', label: 'Tear down the dev stack', checked: true, running: true }
  const vm = { id: 'env:destroy', label: 'Delete the VM', checked: true }
  const none = { stack: false }
  const ok = { blocks: false, blocking: [], unplanned: [], unchecked: [] }
  assert.deepEqual(moveTeardownCheck([stack, vm], new Set([stack.id, vm.id]), none), ok)
  assert.deepEqual(moveTeardownCheck([stack, vm], new Set([stack.id]), none), ok, 'the stopped VM unticked stays behind')
  assert.deepEqual(moveTeardownCheck([stack, vm], new Set([vm.id]), none), { ...ok, blocks: true, blocking: [stack.id] }, 'the running stack unticked')
  assert.deepEqual(moveTeardownCheck([], new Set(), none), ok)
  // The plan left the stack out (its plan failed) though this window sees it running.
  assert.deepEqual(moveTeardownCheck([vm], new Set([vm.id]), { stack: true }), { ...ok, blocks: true, unplanned: ['its dev stack'] })
  // The server says it could not ask a participant (teardownPlan's `unplanned`, plugins E3): named, and Move waits.
  const names = { env: 'Colima environments' }
  assert.deepEqual(moveTeardownCheck([stack], new Set([stack.id]), { stack: true, unchecked: ['env'] }, (id) => names[id] ?? id), { ...ok, blocks: true, unchecked: ['Colima environments'] })
  assert.deepEqual(moveTeardownCheck([], new Set(), { stack: true, unchecked: ['stack'] }), { ...ok, blocks: true, unchecked: ['its dev stack'] }, 'the stack once, as the server says it')
})

test('worktreeTeardown with nothing chosen: the finish sends no teardown; unticked says so', async () => {
  const source = src()
  const target = tgt({ 'move.receive': { worktreeId: 'wb', undoToken: 'u1', dropped: [] } })
  const { outcome, steps } = run(source, target, { teardownIds: [], teardownUnticked: true })
  assert.equal((await outcome).kind, 'moved')
  assert.equal(source.calls.at(-1)[1].teardown, undefined)
  assert.equal(source.calls.filter(([m]) => m === 'move.finish').length, 1)
  assert.deepEqual(steps.find(([s]) => s === 'teardown'), ['teardown', 'skipped', 'left in place (unticked)'])
})
