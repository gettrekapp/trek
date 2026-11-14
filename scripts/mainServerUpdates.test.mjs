// scripts/mainServerUpdates.test.mjs — main's memory of each connected server's update state:
// read at every welcome, kept in step by update.changed, a "restarting" mark from daemon.shutdown,
// and the requests behind the row's buttons. Driven with the real client connection over a fake socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANGED_COALESCE_MS, createServerUpdates } from '../src/main/serverUpdates.ts'
import { RESTART_GRACE_MS } from '../src/shared/serverUpdate.ts'
import { ServerConnection } from '../src/shared/client/index.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const STATUS = { current: '1.0.0', state: 'idle', sessions: 0, canRelaunch: true, restartNeeded: false, remoteApply: true }
const AVAILABLE = { ...STATUS, latest: '2.0.0' }
/** Lets the promise callbacks of a reply or a refusal run. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

/**
 * The updates over fake sockets. `clock` runs the connections (their retries and pings),
 * `own` runs only the updates' timers, so `own.pending()` counts exactly those.
 */
function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const own = fakeTimers()
  let changes = 0
  const updates = createServerUpdates({ changed: () => changes++, timers: own.timers })
  /** A connection to `url`, followed as `id`; `listeners()` is how many of its listeners the updates still hold. */
  const link = (id = 'box', url = 'ws://box:8800') => {
    const connection = new ServerConnection({ url, token: 't', createSocket: server.factory, timers: clock.timers })
    let listening = 0
    const spy = {
      get status() {
        return connection.status
      },
      get welcome() {
        return connection.welcome
      },
      request: (method, params) => connection.request(method, params),
      on: (kind, listener) => {
        listening++
        const off = connection.on(kind, listener)
        let done = false
        return () => {
          if (!done) listening--
          done = true
          off()
        }
      }
    }
    updates.follow(id, spy)
    connection.connect()
    return { connection, spy, listeners: () => listening, sock: () => server.sockets.filter((s) => s.url === url).at(-1) }
  }
  /** As `link`, then the server's welcome (listing `update` unless told otherwise). */
  const connected = (id, url, capabilities = ['mcp', 'update']) => {
    const l = link(id, url)
    l.sock().open()
    l.sock().welcome({ capabilities })
    return l
  }
  /** As `connected`, with the first update.status answered. */
  const following = async (status = STATUS, id, url) => {
    const l = connected(id, url)
    l.sock().reply(l.sock().lastReq('update.status'), status)
    await settled()
    return l
  }
  const requests = (sock, method) => sock.sent.filter((f) => f.type === 'req' && f.method === method)
  return { updates, server, clock, own, link, connected, following, requests, changes: () => changes }
}

test('a welcome that lists `update` reads the status once; the answer is the status, and the links hear of it', async () => {
  const { updates, connected, requests, changes } = setup()
  const { sock } = connected()
  assert.deepEqual(requests(sock(), 'update.status').map((f) => f.params), [{}])
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(changes(), 0)
  sock().reply(sock().lastReq('update.status'), AVAILABLE)
  await settled()
  assert.deepEqual(updates.statusOf('box'), AVAILABLE)
  assert.equal(changes(), 1)
  assert.equal(updates.restartingOf('box'), undefined)
})

test('a connection already welcomed when it is followed is read at once', async () => {
  const { updates, server, clock } = setup()
  const connection = new ServerConnection({ url: 'ws://box:8800', token: 't', createSocket: server.factory, timers: clock.timers })
  connection.connect()
  server.last().open()
  server.last().welcome({ capabilities: ['update'] })
  updates.follow('box', connection)
  server.last().reply(server.last().lastReq('update.status'), STATUS)
  await settled()
  assert.deepEqual(updates.statusOf('box'), STATUS)
})

test('a welcome without `update` asks nothing, and its events are ignored', async () => {
  const { updates, connected, requests, changes } = setup()
  const { sock } = connected('box', 'ws://box:8800', ['mcp'])
  assert.deepEqual(requests(sock(), 'update.status'), [])
  sock().event('update.changed', AVAILABLE)
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  await settled()
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(changes(), 0)
  await assert.rejects(updates.check('box'), { message: 'This server does not update itself' })
  await assert.rejects(updates.apply('box', '2.0.0'), { message: 'This server does not update itself' })
  assert.deepEqual(requests(sock(), 'update.check'), [])
  assert.deepEqual(requests(sock(), 'update.apply'), [])
})

test('update.changed replaces the status; a payload that is not a status is ignored', async () => {
  const { updates, following, changes } = setup()
  const { sock } = await following()
  sock().event('update.changed', { ...AVAILABLE, state: 'installing' })
  assert.deepEqual(updates.statusOf('box'), { ...AVAILABLE, state: 'installing' })
  assert.equal(changes(), 2)
  sock().event('update.changed', null)
  sock().event('update.changed', { state: 'nonsense', current: '1.0.0' })
  sock().event('worktree.changed', AVAILABLE)
  assert.deepEqual(updates.statusOf('box'), { ...AVAILABLE, state: 'installing' })
  assert.equal(changes(), 2)
})

test('a status reaches the links field by field: nothing else a server sends rides along', async () => {
  const { updates, following } = setup()
  const { sock } = await following({ ...AVAILABLE, token: 'never', lastResult: { ok: true, from: '0.9.0', to: '1.0.0', at: 't', secret: 'x' } })
  assert.deepEqual(updates.statusOf('box'), { ...AVAILABLE, lastResult: { ok: true, from: '0.9.0', to: '1.0.0', at: 't' } })
  sock().event('update.changed', { ...STATUS, extra: 1 })
  assert.deepEqual(updates.statusOf('box'), STATUS)
})

test('an update.status answer that arrives after a newer update.changed does not overwrite it', async () => {
  const { updates, connected, changes } = setup()
  const { sock } = connected()
  const asked = sock().lastReq('update.status')
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading', percent: 3 })
  sock().reply(asked, STATUS)
  await settled()
  assert.deepEqual(updates.statusOf('box'), { ...AVAILABLE, state: 'downloading', percent: 3 })
  assert.equal(changes(), 1)
})

test('daemon.shutdown with reason `update` marks the server as restarting, with the version when it names one; any other reason does not', async () => {
  const { updates, following, changes } = setup()
  const { sock } = await following()
  sock().event('daemon.shutdown', { reason: 'signal' })
  sock().event('daemon.shutdown', null)
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(changes(), 1)
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  assert.deepEqual(updates.restartingOf('box'), { version: '2.0.0' })
  assert.equal(changes(), 2)

  const other = setup()
  const lab = await other.following(STATUS, 'lab')
  lab.sock().event('daemon.shutdown', { reason: 'update' })
  assert.deepEqual(other.updates.restartingOf('lab'), {})
})

test('the restarting mark outlives the socket; the reconnect clears it, cancels its timer and reads the status again', async () => {
  const { updates, following, clock, own, requests, changes } = setup()
  const { sock } = await following(AVAILABLE)
  const first = sock()
  first.event('update.changed', { ...AVAILABLE, state: 'restarting' })
  first.event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  first.serverClose(1001, 'going away')
  assert.deepEqual(updates.restartingOf('box'), { version: '2.0.0' })
  assert.equal(own.pending(), 1)
  // Still away after a while: still restarting.
  own.advance(RESTART_GRACE_MS / 2)
  assert.deepEqual(updates.restartingOf('box'), { version: '2.0.0' })

  clock.advance(1500)
  const second = sock()
  assert.notEqual(second, first)
  second.open()
  const before = changes()
  second.welcome({ capabilities: ['update'], daemonVersion: '2.0.0' })
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(changes(), before + 1)
  assert.equal(own.pending(), 0, 'the grace timer is cancelled')
  assert.equal(requests(second, 'update.status').length, 1)
  // Until the new status is in, the old one stands (the row keeps saying restarting).
  assert.equal(updates.statusOf('box').state, 'restarting')
  const now = { ...STATUS, current: '2.0.0', lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: 't' } }
  second.reply(second.lastReq('update.status'), now)
  await settled()
  assert.deepEqual(updates.statusOf('box'), now)
  own.advance(RESTART_GRACE_MS)
  assert.equal(changes(), before + 2, 'nothing fires later')
})

test('a server not back within RESTART_GRACE_MS is no longer restarting: the row says disconnected again', async () => {
  const { updates, following, own, changes } = setup()
  const { sock } = await following()
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  sock().serverClose(1001, 'going away')
  const before = changes()
  own.advance(RESTART_GRACE_MS - 1)
  assert.deepEqual(updates.restartingOf('box'), { version: '2.0.0' })
  assert.equal(changes(), before)
  own.advance(1)
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(changes(), before + 1)
  assert.equal(own.pending(), 0)
})

test('a second shutdown notice starts the wait again, with one timer', async () => {
  const { updates, following, own } = setup()
  const { sock } = await following()
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  own.advance(RESTART_GRACE_MS - 10)
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.1' })
  assert.equal(own.pending(), 1)
  own.advance(RESTART_GRACE_MS - 10)
  assert.deepEqual(updates.restartingOf('box'), { version: '2.0.1' })
})

test('forget drops the status, the restarting mark, its timer and the listeners', async () => {
  const { updates, following, own, changes } = setup()
  const { sock, listeners } = await following(AVAILABLE)
  assert.equal(listeners(), 2)
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  assert.equal(own.pending(), 1)
  updates.forget('box')
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(own.pending(), 0)
  assert.equal(listeners(), 0)
  // Nothing the old connection says later is heard, and nothing fires.
  const before = changes()
  sock().event('update.changed', AVAILABLE)
  sock().event('daemon.shutdown', { reason: 'update' })
  own.advance(RESTART_GRACE_MS)
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(updates.restartingOf('box'), undefined)
  assert.equal(changes(), before)
  updates.forget('box')
  updates.forget('never-followed')
  await assert.rejects(updates.check('box'), { message: 'Not connected to this server' })
})

test("a new connection for the same id replaces the old one: no listeners left on it, and its late events and answers change nothing", async () => {
  const { updates, connected, following, requests } = setup()
  // The old connection: a read in flight, and a check in flight.
  const old = connected('box', 'ws://old:8800')
  const oldRead = old.sock().lastReq('update.status')
  const checking = updates.check('box')
  const oldCheck = old.sock().lastReq('update.check')
  // Re-pointed: serverLinks says unlinked, then linked with the new connection.
  updates.forget('box')
  const next = await following(STATUS, 'box', 'ws://new:8800')
  assert.equal(old.listeners(), 0)
  assert.equal(next.listeners(), 2)

  old.sock().reply(oldRead, { ...AVAILABLE, latest: '9.9.9' })
  old.sock().reply(oldCheck, { ...AVAILABLE, latest: '9.9.9' })
  old.sock().event('update.changed', { ...AVAILABLE, latest: '9.9.9' })
  old.sock().event('daemon.shutdown', { reason: 'update', version: '9.9.9' })
  // The check itself still answers whoever asked; what is remembered is the new connection's.
  assert.equal((await checking).latest, '9.9.9')
  await settled()
  assert.deepEqual(updates.statusOf('box'), STATUS)
  assert.equal(updates.restartingOf('box'), undefined)

  // And without the unlinked: following again lets go of the one before.
  const third = connected('box', 'ws://third:8800')
  assert.equal(next.listeners(), 0)
  assert.equal(updates.statusOf('box'), undefined, 'a new connection starts with no status')
  next.sock().event('update.changed', AVAILABLE)
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(requests(third.sock(), 'update.status').length, 1)
})

test('a failed update.status leaves no status and throws nothing; the next welcome asks again', async () => {
  const { updates, connected, clock, requests, changes } = setup()
  const { sock } = connected()
  sock().fail(sock().lastReq('update.status'), 'INTERNAL', 'boom')
  await settled()
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(changes(), 0)
  sock().serverClose(1006, '')
  clock.advance(1500)
  sock().open()
  sock().welcome({ capabilities: ['update'] })
  assert.equal(requests(sock(), 'update.status').length, 1)
  sock().reply(sock().lastReq('update.status'), STATUS)
  await settled()
  assert.deepEqual(updates.statusOf('box'), STATUS)
})

test('a status that can no longer be read is not kept: a failed re-read, or a server that stops listing `update`', async () => {
  const { updates, following, clock, changes } = setup()
  const { sock } = await following(AVAILABLE)
  sock().serverClose(1006, '')
  clock.advance(1500)
  sock().open()
  sock().welcome({ capabilities: ['update'] })
  assert.deepEqual(updates.statusOf('box'), AVAILABLE)
  const before = changes()
  sock().reply(sock().lastReq('update.status'), 'not a status')
  await settled()
  assert.equal(updates.statusOf('box'), undefined)
  assert.equal(changes(), before + 1)

  const other = setup()
  const lab = await other.following(AVAILABLE, 'lab')
  lab.sock().serverClose(1006, '')
  other.clock.advance(1500)
  lab.sock().open()
  lab.sock().welcome({ capabilities: ['mcp'] })
  assert.equal(other.updates.statusOf('lab'), undefined)
  assert.equal(other.requests(lab.sock(), 'update.status').length, 0)
})

test('check asks the server to look, answers its status and remembers it', async () => {
  const { updates, following, requests, changes } = setup()
  const { sock } = await following()
  const checking = updates.check('box')
  assert.deepEqual(requests(sock(), 'update.check').map((f) => f.params), [{}])
  sock().reply(sock().lastReq('update.check'), AVAILABLE)
  assert.deepEqual(await checking, AVAILABLE)
  assert.deepEqual(updates.statusOf('box'), AVAILABLE)
  assert.equal(changes(), 2)
})

test("a check's answer does not undo an event that came while it was asked", async () => {
  const { updates, following } = setup()
  const { sock } = await following()
  const checking = updates.check('box')
  sock().event('update.changed', { ...STATUS, state: 'checking' })
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading' })
  sock().reply(sock().lastReq('update.check'), AVAILABLE)
  assert.deepEqual(await checking, AVAILABLE)
  assert.equal(updates.statusOf('box').state, 'downloading')
})

test("a failed check or apply rejects with a plain Error carrying the server's sentence", async () => {
  const { updates, following } = setup()
  const { sock } = await following(AVAILABLE)
  const checking = updates.check('box')
  sock().fail(sock().lastReq('update.check'), 'TOOL_ERROR', 'Could not check for an update: the feed answered 503')
  const err = await checking.then(
    () => null,
    (e) => e
  )
  assert.equal(err.constructor, Error)
  assert.equal(err.message, 'Could not check for an update: the feed answered 503')
  assert.equal(err.code, undefined)
  assert.deepEqual(updates.statusOf('box'), AVAILABLE, 'a failed check leaves the status')

  const busy = updates.apply('box', '2.0.0')
  sock().fail(sock().lastReq('update.apply'), 'CONFLICT', '', { reason: 'busy' })
  await assert.rejects(busy, { message: 'An update is already running on this server' })
  const disabled = updates.apply('box', '2.0.0')
  sock().fail(sock().lastReq('update.apply'), 'CONFLICT', '', { reason: 'disabled' })
  await assert.rejects(disabled, { message: 'This server is set to be updated on its own machine: run `trek-server update` there.' })
})

test('apply names the version; a refusal because the latest release moved reads the status again', async () => {
  const { updates, following, requests } = setup()
  const { sock } = await following(AVAILABLE)
  const applying = updates.apply('box', '2.0.0')
  assert.deepEqual(requests(sock(), 'update.apply').map((f) => f.params), [{ version: '2.0.0' }])
  sock().reply(sock().lastReq('update.apply'), { started: true })
  assert.equal(await applying, undefined)
  assert.equal(requests(sock(), 'update.status').length, 1)

  const stale = updates.apply('box', '2.0.0')
  sock().fail(sock().lastReq('update.apply'), 'CONFLICT', 'The latest release is now 2.1.0, not 2.0.0: check again', { reason: 'stale' })
  await assert.rejects(stale, { message: 'The latest release is now 2.1.0, not 2.0.0: check again' })
  assert.equal(requests(sock(), 'update.status').length, 2)
  sock().reply(sock().lastReq('update.status'), { ...AVAILABLE, latest: '2.1.0' })
  await settled()
  assert.equal(updates.statusOf('box').latest, '2.1.0')
})

test('check and apply refuse without a connected link', async () => {
  const { updates, following, link, requests } = setup()
  await assert.rejects(updates.check('nobody'), { message: 'Not connected to this server' })
  await assert.rejects(updates.apply('nobody', '2.0.0'), { message: 'Not connected to this server' })
  const connecting = link('lab', 'ws://lab:8800')
  await assert.rejects(updates.check('lab'), { message: 'Not connected to this server' })
  const { sock } = await following(AVAILABLE)
  sock().serverClose(1006, '')
  await assert.rejects(updates.apply('box', '2.0.0'), { message: 'Not connected to this server' })
  assert.deepEqual(requests(sock(), 'update.apply'), [])
  assert.deepEqual(connecting.sock().sent, [])
  // The connection dropping under a request is the same sentence.
  const again = setup()
  const box = await again.following(AVAILABLE)
  const checking = again.updates.check('box')
  box.sock().serverClose(1006, '')
  await assert.rejects(checking, { message: 'Not connected to this server' })
})

test("a download's percents reach the links at most once per CHANGED_COALESCE_MS: the first at once, the newest after the wait", async () => {
  const { updates, following, own, changes } = setup()
  const { sock } = await following(AVAILABLE)
  const percent = (n) => sock().event('update.changed', { ...AVAILABLE, state: 'downloading', percent: n })
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading' })
  const base = changes()
  percent(1)
  assert.equal(changes(), base + 1, 'the first is not delayed')
  for (let n = 2; n <= 40; n++) percent(n)
  assert.equal(changes(), base + 1)
  assert.equal(updates.statusOf('box').percent, 40, 'what is remembered is always the newest')
  own.advance(CHANGED_COALESCE_MS)
  assert.equal(changes(), base + 2)
  // Quiet since: nothing more, and no timer left running.
  own.advance(CHANGED_COALESCE_MS * 3)
  assert.equal(changes(), base + 2)
  assert.equal(own.pending(), 0)
  // A burst that goes on is one change per wait.
  percent(41)
  percent(42)
  own.advance(CHANGED_COALESCE_MS)
  percent(43)
  own.advance(CHANGED_COALESCE_MS)
  assert.equal(changes(), base + 5)
})

test('a new state is never held back, and leaves nothing to send later', async () => {
  const { following, own, changes } = setup()
  const { sock } = await following(AVAILABLE)
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading', percent: 98 })
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading', percent: 99 })
  sock().event('update.changed', { ...AVAILABLE, state: 'downloading', percent: 100 })
  const base = changes()
  sock().event('update.changed', { ...AVAILABLE, state: 'installing' })
  assert.equal(changes(), base + 1)
  sock().event('daemon.shutdown', { reason: 'update', version: '2.0.0' })
  assert.equal(changes(), base + 2)
  own.advance(CHANGED_COALESCE_MS * 2)
  assert.equal(changes(), base + 2, 'the held-back percent was already covered')
})

test('a `changed` that throws does not break the listeners', async () => {
  const server = fakeServer()
  const clock = fakeTimers()
  const updates = createServerUpdates({
    changed: () => {
      throw new Error('a window closed')
    },
    timers: clock.timers
  })
  const connection = new ServerConnection({ url: 'ws://box:8800', token: 't', createSocket: server.factory, timers: clock.timers })
  updates.follow('box', connection)
  connection.connect()
  server.last().open()
  server.last().welcome({ capabilities: ['update'] })
  const error = console.error
  console.error = () => {}
  try {
    server.last().event('update.changed', AVAILABLE)
    server.last().event('update.changed', { ...AVAILABLE, state: 'checking' })
  } finally {
    console.error = error
  }
  assert.equal(updates.statusOf('box').state, 'checking')
})
