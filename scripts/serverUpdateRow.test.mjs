// scripts/serverUpdateRow.test.mjs — what a server's row in the app says about updating it: an
// available release and its button, the progress of an install, a restart, and how it ended; what
// the app asks before it has a server install; and a refused request as a sentence.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STATUS_ERROR_CHARS,
  RESTARTING_STATUS,
  RESTART_GRACE_MS,
  applyUpdateRefusal,
  canCheckUpdate,
  parseUpdateStatus,
  restartingBanner,
  restartingToUpdate,
  settleUpdateActs,
  serverUpdateConfirm,
  serverUpdateRow,
  updateErrorText,
  updateRestartOf,
  updateSignatures
} from '../src/shared/serverUpdate.ts'
import { ClientError } from '../src/shared/client/index.ts'

const STATUS = { current: '1.0.0', state: 'idle', sessions: 0, canRelaunch: true, restartNeeded: false, remoteApply: true }
const link = (over = {}) => ({ id: 's1', name: 'build box', url: 'wss://box', hasToken: true, status: 'connected', message: '', capabilities: ['update'], version: '1.0.0', update: STATUS, ...over })
const withStatus = (status, over = {}) => link({ update: { ...STATUS, ...status }, ...over })
const LOCAL = { state: 'running', message: '', canReset: false, pid: 7, version: '1.0.0' }
const failed = (over = {}) => ({ ok: false, from: '1.0.0', to: '2.0.0', at: 't', error: 'trek-server 2.0.0 did not start; went back to 1.0.0', ...over })
/** Why a row has no button, in parts: the renderer draws the command as code, never from markup. */
const HINT = [{ text: 'This server is set to be updated on its own machine: run ' }, { command: 'trek-server update' }, { text: ' there.' }]
/** The same as one sentence, where only text can be shown (a refused request). */
const HINT_TEXT = 'This server is set to be updated on its own machine: run “trek-server update” there.'

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

test("a row's status says restarting, not disconnected, exactly while its update line does", () => {
  assert.equal(RESTARTING_STATUS, 'Restarting to update…')
  for (const status of ['disconnected', 'connecting', 'error', 'closed', null]) {
    assert.equal(restartingToUpdate(link({ status, updateRestarting: { version: '2.0.0' } })), true, String(status))
    assert.equal(restartingToUpdate(link({ status, update: undefined, updateRestarting: {} })), true, String(status))
    // Away for another reason (or after main's grace ended the mark): disconnected is what it is.
    assert.equal(restartingToUpdate(link({ status })), false, String(status))
  }
  // It has answered: connected again, or refusing this app.
  for (const status of ['connected', 'needs-auth', 'incompatible']) {
    assert.equal(restartingToUpdate(link({ status, updateRestarting: { version: '2.0.0' } })), false, status)
  }
  assert.equal(restartingToUpdate(link({ local: LOCAL, status: 'disconnected', updateRestarting: { version: '2.0.0' } })), false, 'never the Local entry')
  // The two agree: the status never says restarting without the line, or the line without it.
  for (const status of ['connected', 'connecting', 'disconnected', 'needs-auth', 'incompatible', 'error', 'closed', null]) {
    const away = link({ status, update: undefined, updateRestarting: { version: '2.0.0' } })
    assert.equal(serverUpdateRow(away)?.text === 'Restarting into 2.0.0…', restartingToUpdate(away), String(status))
  }
})

test('the restarting mark says nothing once the server has answered: connected again, or refusing this app', () => {
  // Connected again: what the status says is what the row says.
  assert.deepEqual(
    serverUpdateRow(withStatus({ current: '2.0.0', lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: 't' } }, { updateRestarting: { version: '2.0.0' }, updateWitnessed: { version: '2.0.0' } })),
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

test('a failure for the release that is offered always shows, whoever recorded it and whatever it says it came from', () => {
  // The update's lock was held, or the feed could not be read: nothing was installed, and the
  // server reports the attempt with the version that was asked for.
  const locked = 'another update is running for /opt/trek-server: /opt/.trek-update.lock is its lock'
  for (const from of ['1.0.0', '0.9.0', '2.0.0', '']) {
    assert.deepEqual(serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed({ from, error: locked }) })), {
      tone: 'error',
      text: `Update failed: ${locked}`,
      action: { kind: 'apply', label: 'Try Again', version: '2.0.0' }
    }, from)
  }
  // What a server recorded before it named the version being installed ("from 1.0.0 to 1.0.0") was never shown.
  assert.equal(serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed({ to: '1.0.0', error: locked }) })).text, 'Update available: 2.0.0')
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

test('a success is said where it was seen: for the version now running, in the app that saw the server update', () => {
  const ok = { ok: true, from: '1.0.0', to: '2.0.0', at: 't' }
  const seen = { updateWitnessed: { version: '2.0.0' } }
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: ok }, { version: '2.0.0', ...seen })), { tone: 'done', text: 'Updated to 2.0.0' })
  // An app that connects later (another machine's, or this one started again) saw nothing happen: nothing to say.
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: ok }, { version: '2.0.0' })), null)
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.0', lastResult: ok }, { updateWitnessed: { version: '1.9.0' } })), null, 'what was seen was another update')
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.1', lastResult: ok }, seen)), null, 'a success for a version it has since moved past is not news')
  assert.equal(serverUpdateRow(withStatus({ current: '1.0.0', lastResult: ok }, seen)), null, 'nor one it is not running')
  assert.equal(serverUpdateRow(withStatus({ current: '2.0.0' }, seen)), null, 'nor without the server saying so')
  // A newer release wins over the news of the last one.
  assert.deepEqual(serverUpdateRow(withStatus({ current: '2.0.0', latest: '3.0.0', lastResult: ok }, seen)), { tone: 'available', text: 'Update available: 3.0.0', action: { kind: 'apply', label: 'Update', version: '3.0.0' } })
  // A failure is not a matter of who saw it: it is said until the next attempt.
  assert.equal(serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed() })).tone, 'error')
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

test('a failure whose first line only introduces the next (it ends in a colon) says both', () => {
  const selfcheck = 'trek-server 2.0.0 does not run on this machine, so 1.0.0 stays:\nFAIL: node-pty loads\n  simulated: this version cannot run here'
  assert.equal(
    serverUpdateRow(withStatus({ latest: '2.0.0', lastResult: failed({ error: selfcheck }) })).text,
    'Update failed: trek-server 2.0.0 does not run on this machine, so 1.0.0 stays: FAIL: node-pty loads'
  )
  // Blank lines between them are skipped; a colon with nothing after it is all there is to say.
  assert.equal(serverUpdateRow(withStatus({ lastResult: failed({ error: 'the selfcheck failed:\n\n   \n  no pty\nmore' }) })).text, 'Update failed: the selfcheck failed: no pty')
  assert.equal(serverUpdateRow(withStatus({ lastResult: failed({ error: 'the selfcheck failed:\n' }) })).text, 'Update failed: the selfcheck failed:')
  // Still one line of reasonable length.
  const long = serverUpdateRow(withStatus({ lastResult: failed({ error: `it failed:\n${'x'.repeat(500)}` }) })).text
  assert.ok(long.length <= 220 && long.endsWith('…') && !long.includes('\n'), long)
  // A refused request's message is read the same way.
  assert.equal(updateErrorText({ code: 'TOOL_ERROR', message: 'Could not check for an update:\nthe feed answered 500' }), 'Could not check for an update: the feed answered 500')
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
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0', remoteApply: false }), HINT_TEXT)
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0', state: 'downloading' }), 'An update is already running on this server')
  assert.equal(applyUpdateRefusal({ ...STATUS, latest: '2.0.0', state: 'checking' }), 'The server is checking for an update: try again in a moment', 'a check is not an update')
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
  assert.equal(updateErrorText(new ClientError('CONFLICT', '', { reason: 'disabled' })), HINT_TEXT)
  // The server's own sentence for it is written for a terminal (backticks): the app says its own.
  assert.equal(updateErrorText(new ClientError('CONFLICT', "This server's config leaves updating to `trek-server update` on its own machine (updates.remoteApply is false)", { reason: 'disabled' })), HINT_TEXT)
  assert.equal(updateErrorText(new ClientError('CONFLICT', '', { reason: 'busy' })), 'An update is already running on this server')
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

test('a status from the wire is taken field by field; what is not a status is none', () => {
  const full = { ...STATUS, latest: '2.0.0', state: 'downloading', percent: 12, sessions: 3, checkedAt: 'c', lastResult: { ok: false, from: '0.9.0', to: '1.0.0', at: 't', error: 'why' } }
  assert.deepEqual(parseUpdateStatus(full), full)
  assert.deepEqual(parseUpdateStatus({ ...full, token: 'x', lastResult: { ...full.lastResult, extra: 1 } }), full)
  assert.deepEqual(parseUpdateStatus(STATUS), STATUS)
  // Missing or mistyped fields fall to the careful side: nothing to offer, nothing it can do.
  assert.deepEqual(parseUpdateStatus({ current: '1.0.0', state: 'idle', latest: 2, percent: 'x', sessions: -1, lastResult: { ok: 'yes' } }), {
    current: '1.0.0',
    state: 'idle',
    sessions: 0,
    canRelaunch: false,
    restartNeeded: false,
    remoteApply: false
  })
  for (const bad of [null, undefined, 'idle', 7, [], {}, { state: 'idle' }, { current: '', state: 'idle' }, { current: '1.0.0' }, { current: '1.0.0', state: 'napping' }]) {
    assert.equal(parseUpdateStatus(bad), undefined, JSON.stringify(bad))
  }
})

test('a status from the wire is bounded: a version is short and plain or it is dropped, and without a running version there is no status', () => {
  for (const version of ['1.0.0', '2.0.0-rc.1', '10.20.30', '0.4.0-beta-2', 'v1']) {
    assert.equal(parseUpdateStatus({ ...STATUS, current: version, latest: version }).current, version, version)
    assert.equal(parseUpdateStatus({ ...STATUS, latest: version }).latest, version, version)
  }
  const bad = ['x'.repeat(41), `2.0.0-${'y'.repeat(300)}`, '2.0.0\nUpdated', '2.0.0 beta', '2.0.0\u202e', '2.0.0\u0000', '<b>2</b>', '2.0.0+build', '../2', '-2', '.2', '']
  for (const version of bad) {
    assert.equal(parseUpdateStatus({ ...STATUS, current: version }), undefined, JSON.stringify(version))
    assert.deepEqual(parseUpdateStatus({ ...STATUS, latest: version }), STATUS, JSON.stringify(version))
    // A result between versions that are not ones says nothing that can be shown.
    assert.equal(parseUpdateStatus({ ...STATUS, lastResult: { ok: false, from: '1.0.0', to: version, at: 't', error: 'e' } }).lastResult, undefined, JSON.stringify(version))
    assert.equal(parseUpdateStatus({ ...STATUS, lastResult: { ok: true, from: version, to: '2.0.0', at: 't' } }).lastResult, undefined, JSON.stringify(version))
  }
  assert.equal(parseUpdateStatus({ ...STATUS, current: 'x'.repeat(40) }).current, 'x'.repeat(40), 'forty characters is a version')
})

test('a status from the wire is bounded: the terminals are a count from 0 to 9999, the percent a whole number from 0 to 100 or none', () => {
  const sessions = (value) => parseUpdateStatus({ ...STATUS, sessions: value }).sessions
  assert.deepEqual([0, 1, 9999, 10_000, 1e300, -1, 1.5, Number.NaN, Infinity, '3', null].map(sessions), [0, 1, 9999, 9999, 9999, 0, 0, 0, 0, 0, 0])
  assert.match(serverUpdateConfirm('b', parseUpdateStatus({ ...STATUS, latest: '2.0.0', sessions: 1e300 })).detail, /Its 9999 terminals close;/)
  const percent = (value) => parseUpdateStatus({ ...STATUS, state: 'downloading', percent: value }).percent
  assert.deepEqual([0, 42, 100, 41.6, 250, -5e9, 1e300, Number.NaN, Infinity, -Infinity, '50', null].map(percent), [0, 42, 100, 42, 100, 0, 100, undefined, undefined, undefined, undefined, undefined])
})

test('a status from the wire is bounded: an error is cut to MAX_STATUS_ERROR_CHARS, the times to forty characters', () => {
  assert.ok(MAX_STATUS_ERROR_CHARS >= 2000 && MAX_STATUS_ERROR_CHARS <= 2200)
  const result = (over) => parseUpdateStatus({ ...STATUS, lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: 't', ...over } }).lastResult
  const huge = result({ error: 'e'.repeat(5 * 1024 * 1024) }).error
  assert.equal(huge.length, MAX_STATUS_ERROR_CHARS)
  assert.equal(result({ error: 'e'.repeat(MAX_STATUS_ERROR_CHARS) }).error.length, MAX_STATUS_ERROR_CHARS)
  assert.equal(result({ at: '2026-11-14T10:00:00.000Z' }).at, '2026-11-14T10:00:00.000Z')
  assert.equal(result({ at: 'a'.repeat(500) }).at, 'a'.repeat(40))
  assert.equal(parseUpdateStatus({ ...STATUS, checkedAt: 'c'.repeat(500) }).checkedAt, 'c'.repeat(40))
  assert.equal(parseUpdateStatus({ ...STATUS, checkedAt: '2026-11-14T10:00:00.000Z' }).checkedAt, '2026-11-14T10:00:00.000Z')
})

test('control and format characters never reach what is shown: stripped from a status at the door, and from a name in the question', () => {
  // NUL, BEL, ESC, DEL, a C1 control; a right-to-left override, a zero-width joiner, a byte-order mark.
  const NASTY = '\u0000\u0007\u001b\u007f\u0085\u202e\u200d\ufeff'
  const status = parseUpdateStatus({
    ...STATUS,
    checkedAt: `2026-11-14${NASTY}T10:00:00.000Z`,
    lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: `t${NASTY}`, error: `first${NASTY} line:\r\nsecond\tline\rthird${NASTY}` }
  })
  assert.equal(status.checkedAt, '2026-11-14T10:00:00.000Z')
  assert.equal(status.lastResult.at, 't')
  // Line breaks are kept as line breaks (the row says the first line); a tab is a space; the rest is gone.
  assert.equal(status.lastResult.error, 'first line:\nsecond line\nthird')
  assert.equal(serverUpdateRow(link({ update: status })).text, 'Update failed: first line: second line')
  for (const text of [status.checkedAt, status.lastResult.at, status.lastResult.error.replaceAll('\n', ''), serverUpdateRow(link({ update: status })).text]) {
    assert.doesNotMatch(text, /[\p{Cc}\p{Cf}]/u)
  }
  // The server's name is the user's own, and still never carries a control into the native dialog.
  const asked = serverUpdateConfirm(`build${NASTY} box\u202e`, { ...STATUS, latest: '2.0.0' })
  assert.equal(asked.message, 'Update trek-server on “build box” to 2.0.0?')
  // What is shown without having come through the door (a refused request's message) is cleaned as it is shown.
  assert.equal(updateErrorText({ code: 'TOOL_ERROR', message: `Could not${NASTY} check` }), 'Could not check')
  assert.equal(updateErrorText({ code: `INTERNAL${NASTY}`, message: '' }), 'INTERNAL')
  assert.equal(serverUpdateRow(withStatus({ latest: `2.0.0${NASTY}` })).text, 'Update available: 2.0.0')
})

test('the hint is parts, never markup: text and the command, which is all the renderer draws as code', () => {
  const { hint } = serverUpdateRow(withStatus({ latest: '2.0.0', remoteApply: false }))
  assert.deepEqual(hint, HINT)
  assert.ok(hint.every((part) => Object.keys(part).length === 1 && typeof (part.text ?? part.command) === 'string'))
  assert.doesNotMatch(JSON.stringify(hint), /`|<|>/)
  assert.doesNotMatch(HINT_TEXT, /`/)
})

test("a click's error goes when the server's row moves on, or the server is gone; a click in flight and a check's news stay", () => {
  const box = withStatus({ latest: '2.0.0' }, { id: 'box' })
  const lab = link({ id: 'lab' })
  const before = updateSignatures([box, lab])
  assert.deepEqual(Object.keys(before).sort(), ['box', 'lab'])
  const acts = { box: { busy: false, error: 'The server did not answer in time' }, lab: { busy: false, checked: true } }
  // Nothing moved: the very same object (no render).
  assert.equal(settleUpdateActs(acts, before, updateSignatures([{ ...box }, { ...lab }])), acts)
  // The terminals' count is not what a row shows: the error stays.
  assert.equal(settleUpdateActs(acts, before, updateSignatures([withStatus({ latest: '2.0.0', sessions: 3 }, { id: 'box' }), lab])), acts)
  // The row's line changes (an install begins): the error was about a moment that is over.
  const moved = settleUpdateActs(acts, before, updateSignatures([withStatus({ latest: '2.0.0', state: 'downloading' }, { id: 'box' }), lab]))
  assert.deepEqual(moved, { box: { busy: false }, lab: { busy: false, checked: true } })
  // So does its connection.
  assert.deepEqual(settleUpdateActs(acts, before, updateSignatures([{ ...box, status: 'disconnected' }, lab])).box, { busy: false })
  // A row that only changes keeps what a check found; one whose click is in flight is left alone.
  const checked = { box: { busy: false, error: 'x', checked: true }, lab: { busy: true, kind: 'check' } }
  assert.deepEqual(settleUpdateActs(checked, before, updateSignatures([withStatus({ latest: '2.1.0' }, { id: 'box' }), link({ id: 'lab', update: { ...STATUS, state: 'checking' } })])), {
    box: { busy: false, checked: true },
    lab: { busy: true, kind: 'check' }
  })
  // Removed from the list: nothing is kept for it.
  assert.deepEqual(settleUpdateActs(acts, before, updateSignatures([lab])), { lab: { busy: false, checked: true } })
  // A server seen for the first time has not moved on from anything.
  assert.equal(settleUpdateActs(acts, {}, before), acts)
})

test('a shutdown notice that announces a restart to update: the version it names, if it is one; any other notice is none', () => {
  assert.deepEqual(updateRestartOf({ reason: 'update', version: '2.0.0' }), { version: '2.0.0' })
  assert.deepEqual(updateRestartOf({ reason: 'update' }), {})
  assert.deepEqual(updateRestartOf({ reason: 'update', version: 7 }), {})
  assert.deepEqual(updateRestartOf({ reason: 'update', version: `2.0.0\u202e${'x'.repeat(100)}` }), {}, 'a version that is not one is not named')
  for (const other of [{ reason: 'SIGTERM' }, { reason: 'server.stop', version: '2.0.0' }, {}, null, undefined, 'update', 7]) assert.equal(updateRestartOf(other), undefined, JSON.stringify(other))
})

test("a project window's banner while its server restarts to update: that, not Disconnected and why the socket closed", () => {
  assert.deepEqual(restartingBanner({ version: '2.0.0' }, 'disconnected'), { label: 'Restarting to update…', message: 'the server is restarting into 2.0.0; this window reconnects by itself' })
  assert.deepEqual(restartingBanner({}, 'connecting'), { label: 'Restarting to update…', message: 'the server is restarting into a new version; this window reconnects by itself' })
  for (const status of ['disconnected', 'connecting', 'error', 'closed']) assert.equal(restartingBanner({}, status)?.label, RESTARTING_STATUS, status)
  // No notice, or the server has answered (connected again, or refusing this app): the usual banner, or none.
  assert.equal(restartingBanner(undefined, 'disconnected'), null)
  for (const status of ['connected', 'needs-auth', 'incompatible']) assert.equal(restartingBanner({ version: '2.0.0' }, status), null, status)
})
