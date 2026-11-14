// scripts/serverUpdateRow.test.mjs — what a server's row in the app says about updating it: an
// available release and its button, the progress of an install, a restart, and how it ended; what
// the app asks before it has a server install; and a refused request as a sentence.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESTART_GRACE_MS,
  applyUpdateRefusal,
  canCheckUpdate,
  serverUpdateConfirm,
  serverUpdateRow,
  updateErrorText
} from '../src/shared/serverUpdate.ts'
import { ClientError } from '../src/shared/client/index.ts'

const STATUS = { current: '1.0.0', state: 'idle', sessions: 0, canRelaunch: true, restartNeeded: false, remoteApply: true }
const link = (over = {}) => ({ id: 's1', name: 'build box', url: 'wss://box', hasToken: true, status: 'connected', message: '', capabilities: ['update'], version: '1.0.0', update: STATUS, ...over })
const withStatus = (status, over = {}) => link({ update: { ...STATUS, ...status }, ...over })
const LOCAL = { state: 'running', message: '', canReset: false, pid: 7, version: '1.0.0' }
const failed = (over = {}) => ({ ok: false, from: '1.0.0', to: '2.0.0', at: 't', error: 'trek-server 2.0.0 did not start; went back to 1.0.0', ...over })
const HINT = 'This server is set to be updated on its own machine: run `trek-server update` there.'

test('nothing to say: no capability, the Local entry, not connected, no status yet, or up to date with no history', () => {
  assert.equal(serverUpdateRow(link({ capabilities: [], update: undefined })), null)
  assert.equal(serverUpdateRow(link({ capabilities: undefined, update: undefined })), null)
  assert.equal(serverUpdateRow(link({ capabilities: ['mcp'], update: { ...STATUS, latest: '2.0.0' } })), null, 'a status without the capability is not shown')
  assert.equal(serverUpdateRow(link({ local: LOCAL, update: { ...STATUS, latest: '2.0.0' } })), null)
  assert.equal(serverUpdateRow(link({ local: LOCAL, status: 'disconnected', updateRestarting: { version: '2.0.0' } })), null)
  for (const status of ['connecting', 'disconnected', 'needs-auth', 'incompatible', 'error', 'closed', null]) {
    assert.equal(serverUpdateRow(withStatus({ latest: '2.0.0' }, { status })), null, String(status))
  }
  assert.equal(serverUpdateRow(link({ update: undefined })), null, 'the capability, but no status read yet')
  assert.equal(serverUpdateRow(link({ update: undefined }), { checked: true }), null)
  assert.equal(serverUpdateRow(link()), null)
})

test('a newer release: the version and an Update button', () => {
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0' })), { tone: 'available', text: 'Update available: 2.0.0', action: { kind: 'apply', label: 'Update', version: '2.0.0' } })
})

test('a server that leaves installing to its own machine offers no button, and says why', () => {
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0', remoteApply: false })), { tone: 'available', text: 'Update available: 2.0.0', hint: HINT })
})

test('progress: checking, downloading with and without a percent, installing, restarting', () => {
  const row = (status) => serverUpdateRow(withStatus({ latest: '2.0.0', ...status }))
  assert.deepEqual(row({ state: 'checking' }), { tone: 'progress', text: 'Checking for an update…' })
  assert.deepEqual(row({ state: 'downloading' }), { tone: 'progress', text: 'Downloading 2.0.0…' })
  assert.deepEqual(row({ state: 'downloading', percent: 0 }), { tone: 'progress', text: 'Downloading 2.0.0… 0%' })
  assert.deepEqual(row({ state: 'downloading', percent: 42 }), { tone: 'progress', text: 'Downloading 2.0.0… 42%' })
  assert.deepEqual(row({ state: 'installing' }), { tone: 'progress', text: 'Installing 2.0.0…' })
  assert.deepEqual(row({ state: 'restarting' }), { tone: 'progress', text: 'Restarting into 2.0.0…' })
  // Progress wins over what else the status says, and never offers a button.
  assert.deepEqual(row({ state: 'installing', lastResult: failed(), restartNeeded: true }), { tone: 'progress', text: 'Installing 2.0.0…' })
})

test('progress names the version being installed only when it is known, never the last result\'s', () => {
  const row = (status) => serverUpdateRow(withStatus({ lastResult: { ok: true, from: '0.9.0', to: '1.0.0', at: 't' }, ...status }))
  assert.deepEqual(row({ state: 'downloading', percent: 7 }), { tone: 'progress', text: 'Downloading… 7%' })
  assert.deepEqual(row({ state: 'installing' }), { tone: 'progress', text: 'Installing…' })
  assert.deepEqual(row({ state: 'restarting' }), { tone: 'progress', text: 'Restarting to update…' })
})

test('a percent that is not a whole number from 0 to 100 is rounded, kept in range, or left out', () => {
  const text = (percent) => serverUpdateRow(withStatus({ latest: '2.0.0', state: 'downloading', percent })).text
  assert.equal(text(41.6), 'Downloading 2.0.0… 42%')
  assert.equal(text(250), 'Downloading 2.0.0… 100%')
  assert.equal(text(-3), 'Downloading 2.0.0… 0%')
  assert.equal(text(Number.NaN), 'Downloading 2.0.0…')
  assert.equal(text('half'), 'Downloading 2.0.0…')
})

test('restarting outlives the connection: the server said it was going, so the row does not say disconnected', () => {
  for (const status of ['disconnected', 'connecting', 'error']) {
    assert.deepEqual(serverUpdateRow(link({ status, updateRestarting: { version: '2.0.0' } })), { tone: 'progress', text: 'Restarting into 2.0.0…' }, status)
  }
  assert.deepEqual(serverUpdateRow(link({ status: 'disconnected', update: undefined, updateRestarting: {} })), { tone: 'progress', text: 'Restarting to update…' })
  assert.ok(RESTART_GRACE_MS >= 60_000)
})

test('the restarting mark says nothing once the server has answered: connected again, or refusing this app', () => {
  // Connected again: what the status says is what the row says.
  assert.deepEqual(
    serverUpdateRow(withStatus({ current: '2.0.0', lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: 't' } }, { updateRestarting: { version: '2.0.0' } })),
    { tone: 'done', text: 'Updated to 2.0.0' }
  )
  assert.equal(serverUpdateRow(link({ updateRestarting: { version: '2.0.0' } })), null)
  // Still connected, the shutdown just announced: the status itself says restarting.
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0', state: 'restarting' }, { updateRestarting: { version: '2.0.0' } })), { tone: 'progress', text: 'Restarting into 2.0.0…' })
  // The server is back and refuses the token or the protocol: the row's status says that.
  assert.equal(serverUpdateRow(link({ status: 'needs-auth', updateRestarting: { version: '2.0.0' } })), null)
  assert.equal(serverUpdateRow(link({ status: 'incompatible', updateRestarting: { version: '2.0.0' } })), null)
})

test('an update installed that waits for a restart by hand: no version is named (the status does not say which is installed), no button', () => {
  const text = 'An update is installed. Restart trek-server on that machine to finish.'
  assert.deepEqual(serverUpdateRow(withStatus({ restartNeeded: true, latest: '2.0.0' })), { tone: 'attention', text })
  assert.deepEqual(serverUpdateRow(withStatus({ restartNeeded: true })), { tone: 'attention', text })
  assert.deepEqual(serverUpdateRow(withStatus({ restartNeeded: true, latest: '2.0.0', lastResult: failed() })), { tone: 'attention', text })
  assert.deepEqual(serverUpdateRow(withStatus({ restartNeeded: true }), { checked: true }), { tone: 'attention', text })
})

test('a failed update: its reason, and Try Again for the release that failed', () => {
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed() })), {
    tone: 'error',
    text: 'Update failed: trek-server 2.0.0 did not start; went back to 1.0.0',
    action: { kind: 'apply', label: 'Try Again', version: '2.0.0' }
  })
  assert.equal(serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed({ error: undefined }) })).text, 'Update failed: no reason was recorded')
})

test('a failed update with no release known any more offers a check, not an install', () => {
  const row = serverUpdateRow(withStatus({ lastResult: failed({ error: 'the download failed' }) }))
  assert.deepEqual(row, { tone: 'error', text: 'Update failed: the download failed', action: { kind: 'check', label: 'Check Again' } })
  // A check is never refused by remoteApply.
  assert.deepEqual(serverUpdateRow(withStatus({ remoteApply: false, lastResult: failed({ error: 'the download failed' }) })), row)
})

test('a failed update on a server that refuses installs from the app: no Try Again, the hint instead', () => {
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0', remoteApply: false, lastResult: failed() })), {
    tone: 'error',
    text: 'Update failed: trek-server 2.0.0 did not start; went back to 1.0.0',
    hint: HINT
  })
})

test('a failure is old news once a newer release is offered, or the server runs that version or a later one', () => {
  assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.1.0', lastResult: failed() })), { tone: 'available', text: 'Update available: 2.1.0', action: { kind: 'apply', label: 'Update', version: '2.1.0' } })
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: failed() })), null)
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.1', lastResult: failed() })), null)
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.1', latest: '2.2.0', lastResult: failed() })).text, 'Update available: 2.2.0')
})

test('a success: said for the version now running, and only then', () => {
  const ok = { ok: true, from: '1.0.0', to: '2.0.0', at: 't' }
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: ok }, { version: '2.0.0' })), { tone: 'done', text: 'Updated to 2.0.0' })
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.1', lastResult: ok })), null, 'a success for a version it has since moved past is not news')
  assert.equal(serverUpdateRow(withStatus({ current: '1.0.0', lastResult: ok })), null, 'nor one it is not running')
  // A newer release wins over the news of the last one.
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.0', latest: '3.0.0', lastResult: ok })), { tone: 'available', text: 'Update available: 3.0.0', action: { kind: 'apply', label: 'Update', version: '3.0.0' } })
})

test('a check the user asked for that found nothing says so, until the status has something else to say', () => {
  const latest = { tone: 'done', text: 'trek-server 1.0.0 is the latest version' }
  assert.deepEqual(serverUpdateRow(link(), { checked: true }), latest)
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: 't' } }), { checked: true }), { tone: 'done', text: 'trek-server 2.0.0 is the latest version' })
  assert.equal(serverUpdateRow(withStatus({ latest: '2.0.0' }), { checked: true }).text, 'Update available: 2.0.0')
  assert.equal(serverUpdateRow(withStatus({ state: 'checking' }), { checked: true }).text, 'Checking for an update…')
  assert.equal(serverUpdateRow(withStatus({ lastResult: failed() }), { checked: true }).tone, 'error')
  assert.equal(serverUpdateRow(link({ status: 'disconnected' }), { checked: true }), null)
})

test('a long error is cut to one line of reasonable length; a long version is cut too', () => {
  const row = serverUpdateRow(withStatus({ lastResult: failed({ error: `\n  first line\n${'x'.repeat(500)}` }) }))
  assert.equal(row.text, 'Update failed: first line')
  const long = serverUpdateRow(withStatus({ lastResult: failed({ error: 'x'.repeat(500) }) }))
  assert.ok(long.text.length <= 220, String(long.text.length))
  assert.ok(long.text.endsWith('…'))
  const version = serverUpdateRow(withStatus({ latest: `2.0.0-${'y'.repeat(300)}` }))
  assert.ok(version.text.length <= 80, String(version.text.length))
  assert.equal(version.action.version, `2.0.0-${'y'.repeat(300)}`, 'what is asked for is the version itself')
  assert.ok(!serverUpdateRow(withStatus({ latest: '2.0.0\nUpdated' })).text.includes('\n'))
})

test('Check for Update shows for a connected server that updates itself and is doing nothing', () => {
  assert.equal(canCheckUpdate(link()), true)
  assert.equal(canCheckUpdate(withStatus({ latest: '2.0.0' })), true)
  assert.equal(canCheckUpdate(link({ update: undefined })), true, 'before the first status')
  assert.equal(canCheckUpdate(link({ local: LOCAL })), false)
  assert.equal(canCheckUpdate(link({ capabilities: ['mcp'] })), false)
  assert.equal(canCheckUpdate(link({ capabilities: undefined })), false)
  assert.equal(canCheckUpdate(link({ status: 'disconnected' })), false)
  assert.equal(canCheckUpdate(link({ status: null })), false)
  for (const state of ['checking', 'downloading', 'installing', 'restarting']) assert.equal(canCheckUpdate(withStatus({ state })), false, state)
  assert.equal(canCheckUpdate(link({ updateRestarting: {} })), false)
})

test('the confirmation names the server and what a restart costs', () => {
  const none = serverUpdateConfirm('build box', { ...STATUS, latest: '2.0.0' })
  assert.deepEqual(none, {
    message: 'Update trek-server on “build box” to 2.0.0?',
    detail: 'It is running 1.0.0. The server restarts into the new version. It has no terminals open.',
    buttons: ['Update', 'Cancel']
  })
  assert.equal(
    serverUpdateConfirm('b', { ...STATUS, latest: '2.0.0', sessions: 1 }).detail,
    'It is running 1.0.0. The server restarts into the new version. Its 1 terminal closes; agent sessions resume when you open their worktrees again.'
  )
  assert.equal(
    serverUpdateConfirm('b', { ...STATUS, latest: '2.0.0', sessions: 4 }).detail,
    'It is running 1.0.0. The server restarts into the new version. Its 4 terminals close; agent sessions resume when you open their worktrees again.'
  )
})

test('the confirmation for a server that cannot restart itself says it keeps running, and closes nothing', () => {
  const manual = serverUpdateConfirm('b', { ...STATUS, latest: '2.0.0', canRelaunch: false, sessions: 4 }).detail
  assert.equal(
    manual,
    'It is running 1.0.0. This server cannot restart itself (its Node is older than 22.15): the new version is installed, and it keeps running 1.0.0 until you restart it on that machine.'
  )
  assert.doesNotMatch(manual, /terminals? close/)
})

test("the confirmation's server name: quotes kept, line breaks flattened, a long one cut", () => {
  assert.equal(serverUpdateConfirm('the "big" box', { ...STATUS, latest: '2.0.0' }).message, 'Update trek-server on “the "big" box” to 2.0.0?')
  assert.equal(serverUpdateConfirm('  two\n lines ', { ...STATUS, latest: '2.0.0' }).message, 'Update trek-server on “two lines” to 2.0.0?')
  const long = serverUpdateConfirm('n'.repeat(200), { ...STATUS, latest: '2.0.0' }).message
  assert.equal(long, `Update trek-server on “${'n'.repeat(59)}…” to 2.0.0?`)
  assert.equal(serverUpdateConfirm('b', STATUS).message, 'Update trek-server on “b” to the latest version?')
  // A count that is not a whole number of terminals is none.
  assert.match(serverUpdateConfirm('b', { ...STATUS, latest: '2.0.0', sessions: -1 }).detail, /It has no terminals open\./)
})

test('why the app does not ask a server to install: no release, an install left to its machine, one already running', () => {
  assert.equal(applyUpdateRefusal(undefined), 'No update is available for this server')
  assert.equal(applyUpdateRefusal(STATUS), 'No update is available for this server')
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0', remoteApply: false }), HINT)
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0', state: 'downloading' }), 'An update is already running on this server')
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0' }), null)
})

test("a refused update request as a sentence: the server's own when it has one", () => {
  assert.equal(
    updateErrorText(new ClientError('CONFLICT', 'The latest release is now 2.1.0, not 2.0.0: check again', { reason: 'stale' })),
    'The latest release is now 2.1.0, not 2.0.0: check again'
  )
  assert.equal(updateErrorText(new ClientError('CONFLICT', '', { reason: 'stale' })), 'A newer release appeared: check again')
  assert.equal(updateErrorText(new ClientError('CONFLICT', 'request failed', { reason: 'stale' })), 'A newer release appeared: check again')
  assert.equal(updateErrorText(new ClientError('CONFLICT', '', { reason: 'busy' })), 'An update is already running on this server')
  assert.equal(updateErrorText(new ClientError('CONFLICT', 'An update is running on this server', { reason: 'busy' })), 'An update is running on this server')
  assert.equal(updateErrorText(new ClientError('CONFLICT', '', { reason: 'disabled' })), HINT)
  assert.equal(updateErrorText(new ClientError('CONFLICT', '')), 'The server refused the update')
  assert.equal(updateErrorText(new ClientError('TOOL_ERROR', 'Could not check for an update: the feed answered 503')), 'Could not check for an update: the feed answered 503')
  assert.equal(updateErrorText(new ClientError('NOT_FOUND', '')), 'This server does not update itself')
  assert.equal(updateErrorText(new ClientError('NOT_CONNECTED', 'the connection closed')), 'Not connected to this server')
  assert.equal(updateErrorText(new ClientError('TIMEOUT', 'update.check timed out')), 'The server did not answer in time')
  assert.equal(updateErrorText(new Error('boom')), 'boom')
  assert.equal(updateErrorText('str'), 'str')
  assert.equal(updateErrorText(new ClientError('INTERNAL', '')), 'INTERNAL')
  // One line, of reasonable length.
  const long = updateErrorText(new ClientError('TOOL_ERROR', `Could not check\n${'x'.repeat(900)}`))
  assert.equal(long, 'Could not check')
})
