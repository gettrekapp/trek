// scripts/clientMirror.test.mjs — topic mirrors: subscribe, patches, gaps, reconnect, unsubscribe.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { TopicMirror } from '../src/shared/client/mirror.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const tick = () => new Promise((r) => setImmediate(r))

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const mirror = new TopicMirror(conn)
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  return { server, clock, conn, mirror, sock }
}

test('the first listener subscribes; patches update every listener', async () => {
  const { mirror, sock } = setup()
  const a = []
  const b = []
  mirror.subscribe('server', (s) => a.push(s))
  mirror.subscribe('server', (s) => b.push(s))
  const req = sock.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'server' })
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 1)
  sock.reply(req, { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.deepEqual(a.at(-1), { snapshot: { n: 1 }, rev: 0 })
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  assert.deepEqual(a.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(b.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 2 }, rev: 1 })
})

test('a stale patch is ignored; a gap resubscribes and replaces the state', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 5 })
  await tick()
  sock.event('state.patch', { topic: 'server', rev: 5, ops: [{ op: 'replace', path: '/n', value: 9 }] })
  assert.equal(seen.length, 1, 'stale')
  sock.event('state.patch', { topic: 'server', rev: 7, ops: [] })
  const again = sock.lastReq('sub.subscribe')
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 2)
  sock.reply(again, { snapshot: { n: 3 }, rev: 8 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { n: 3 }, rev: 8 })
})

test('reconnect resubscribes; the old state stays until the new snapshot', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { name: 'A' }, rev: 0 })
  await tick()
  sock.serverClose(1006, '')
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'A' })
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  const req = next.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'project:p' })
  next.reply(req, { snapshot: { name: 'B' }, rev: 0 })
  await tick()
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'B' })
})

test('NOT_FOUND is reported as an error; the last listener unsubscribes', async () => {
  const { mirror, sock } = setup()
  const seen = []
  const stop = mirror.subscribe('project:gone', (s) => seen.push(s))
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'No such topic')
  await tick()
  assert.equal(seen.at(-1).error.code, 'NOT_FOUND')
  stop()
  assert.deepEqual(sock.lastReq('sub.unsubscribe').params, { topic: 'project:gone' })
  assert.equal(mirror.get('project:gone'), undefined)
})

test('a listener added later gets the current state at once', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 0 })
  await tick()
  const late = []
  mirror.subscribe('server', (s) => late.push(s))
  assert.deepEqual(late, [{ snapshot: { n: 1 }, rev: 0 }])
})

test('unsubscribe then subscribe while the first reply is in flight: the old reply is ignored', async () => {
  const { mirror, sock } = setup()
  const first = []
  const stop = mirror.subscribe('server', (s) => first.push(s))
  const oldReq = sock.lastReq('sub.subscribe')
  stop()
  const second = []
  mirror.subscribe('server', (s) => second.push(s))
  const newReq = sock.sent.filter((f) => f.method === 'sub.subscribe').at(-1)
  assert.notEqual(newReq.id, oldReq.id)
  sock.reply(oldReq, { snapshot: { n: 'old' }, rev: 1 })
  await tick()
  assert.equal(mirror.get('server'), undefined)
  assert.equal(second.length, 0)
  sock.reply(newReq, { snapshot: { n: 'new' }, rev: 2 })
  await tick()
  assert.deepEqual(second, [{ snapshot: { n: 'new' }, rev: 2 }])
  assert.deepEqual(first, [])
})

test('a gap resubscribe supersedes an earlier in-flight subscribe', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  const r1 = sock.lastReq('sub.subscribe')
  sock.reply(r1, { snapshot: { n: 1 }, rev: 0 })
  await tick()
  sock.event('state.patch', { topic: 'server', rev: 5, ops: [] })
  const r2 = sock.lastReq('sub.subscribe')
  // patches that arrive while the resync is in flight do not start another one
  sock.event('state.patch', { topic: 'server', rev: 6, ops: [] })
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 2)
  sock.reply(r2, { snapshot: { n: 6 }, rev: 6 })
  await tick()
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 6 }, rev: 6 })
})

test('patches before the snapshot lands are ignored', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  assert.equal(seen.length, 0)
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 1, 'no resubscribe either')
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 4 })
  await tick()
  assert.deepEqual(seen, [{ snapshot: { n: 1 }, rev: 4 }])
})

test('patches for an unsubscribed topic are ignored', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})()
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [] })
  assert.equal(mirror.get('server'), undefined)
})

test('a throwing listener does not stop the others, or later patches', async () => {
  const { mirror, sock } = setup()
  const orig = console.error
  const logged = []
  console.error = (...a) => logged.push(a)
  try {
    const good = []
    mirror.subscribe('server', () => {
      throw new Error('boom')
    })
    mirror.subscribe('server', (s) => good.push(s))
    sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 0 })
    await tick()
    sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
    assert.equal(good.length, 2)
    // a throwing listener added late does not break subscribe()
    mirror.subscribe('server', () => {
      throw new Error('late')
    })
    assert.ok(logged.length >= 3)
  } finally {
    console.error = orig
  }
})

test('subscribing while disconnected subscribes at the next welcome; NOT_FOUND is retried after reconnect', async () => {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const mirror = new TopicMirror(conn)
  const seen = []
  mirror.subscribe('project:p', (s) => seen.push(s))
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'gone')
  await tick()
  assert.equal(seen.at(-1).error.code, 'NOT_FOUND')
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  next.reply(next.lastReq('sub.subscribe'), { snapshot: { name: 'back' }, rev: 0 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { name: 'back' }, rev: 0 })
})

const subReqs = (sock) => sock.sent.filter((f) => f.method === 'sub.subscribe')

/** Advances the clock in 1 s steps, answering every sys.ping, so a long fake-time test keeps its link. */
function pingingClock(clock, sock) {
  const answered = new Set()
  return (ms) => {
    while (ms > 0) {
      const step = Math.min(ms, 1000)
      clock.advance(step)
      ms -= step
      for (const f of sock.sent) {
        if (f.method === 'sys.ping' && !answered.has(f.id)) {
          answered.add(f.id)
          sock.reply(f, { t: 0 })
        }
      }
    }
  }
}

test('a transient subscribe failure is reported, then retried after 1 s, doubling', async () => {
  const { clock, mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.fail(subReqs(sock)[0], 'INTERNAL', 'boom')
  await tick()
  assert.equal(seen.at(-1).error.code, 'INTERNAL', 'the listener hears the error first')
  clock.advance(999)
  assert.equal(subReqs(sock).length, 1)
  clock.advance(1)
  assert.equal(subReqs(sock).length, 2)
  sock.fail(subReqs(sock)[1], 'TIMEOUT', 'sub.subscribe timed out')
  await tick()
  assert.equal(seen.at(-1).error.code, 'TIMEOUT')
  clock.advance(1999)
  assert.equal(subReqs(sock).length, 2)
  clock.advance(1)
  assert.equal(subReqs(sock).length, 3)
  sock.reply(subReqs(sock)[2], { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { n: 1 }, rev: 0 })
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 1 }, rev: 0 })
})

test('subscribe retries cap at 30 s; NOT_FOUND is not retried', async () => {
  const { server, clock, mirror, sock } = setup()
  const advance = pingingClock(clock, sock)
  mirror.subscribe('server', () => {})
  for (const [i, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    sock.fail(subReqs(sock)[i], 'INTERNAL', 'boom')
    await tick()
    advance(delay - 1)
    assert.equal(subReqs(sock).length, i + 1, `not before ${delay} ms`)
    advance(1)
    assert.equal(subReqs(sock).length, i + 2, `after ${delay} ms`)
  }
  sock.fail(subReqs(sock).at(-1), 'NOT_FOUND', 'gone')
  await tick()
  const n = subReqs(sock).length
  advance(60_000)
  assert.equal(subReqs(sock).length, n)
  assert.equal(server.sockets.length, 1, 'the link stayed up throughout')
})

test('unsubscribing cancels a pending subscribe retry', async () => {
  const { clock, mirror, sock } = setup()
  const stop = mirror.subscribe('server', () => {})
  sock.fail(subReqs(sock)[0], 'INTERNAL', 'boom')
  await tick()
  stop()
  clock.advance(5000)
  assert.equal(subReqs(sock).length, 1)
})

test('a reconnect cancels a pending subscribe retry and resets its back-off', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  sock.fail(subReqs(sock)[0], 'INTERNAL', 'boom')
  await tick()
  sock.serverClose(1006, '')
  clock.advance(1000) // the reconnect, and the time the retry was due
  const next = server.last()
  assert.equal(subReqs(next).length, 0, 'the retry did not fire on the new socket before its welcome')
  next.open()
  next.welcome()
  assert.equal(subReqs(next).length, 1, 'the welcome resubscribes')
  clock.advance(5000)
  assert.equal(subReqs(next).length, 1, 'no leftover retry')
  next.fail(subReqs(next)[0], 'INTERNAL', 'boom')
  await tick()
  clock.advance(1000)
  assert.equal(subReqs(next).length, 2, 'back-off starts again at 1 s')
})

test('close() gives every listener a CLOSED error and drops the topics', async () => {
  const { clock, conn, mirror, sock } = setup()
  const a = []
  const b = []
  mirror.subscribe('server', (s) => a.push(s))
  mirror.subscribe('project:p', (s) => b.push(s))
  sock.reply(subReqs(sock)[0], { snapshot: { n: 1 }, rev: 0 })
  sock.fail(subReqs(sock)[1], 'INTERNAL', 'boom') // leaves a retry pending
  await tick()
  conn.close()
  assert.equal(a.at(-1).error.code, 'CLOSED')
  assert.equal(a.at(-1).error.message, 'the connection was closed')
  assert.equal(b.at(-1).error.code, 'CLOSED')
  assert.equal(mirror.get('server'), undefined)
  assert.equal(clock.pending(), 0, 'the retry is cancelled')
  const late = []
  mirror.subscribe('server', (s) => late.push(s))
  assert.equal(late.at(-1).error.code, 'CLOSED', 'a subscribe after close hears CLOSED at once')
})

// ---- whenRev ----

/** Settles `promise` into a plain record, so a test can check it without awaiting forever. */
function track(promise) {
  const out = { state: undefined, error: undefined, settled: false }
  promise.then((s) => { out.state = s; out.settled = true }, (e) => { out.error = e; out.settled = true })
  return out
}

test('whenRev resolves at once when the mirror holds the rev, else with the patch that reaches it', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 4 })
  await tick()
  assert.deepEqual(await mirror.whenRev('project:p', 3), { snapshot: { n: 1 }, rev: 4 })
  assert.deepEqual(await mirror.whenRev('project:p', 4), { snapshot: { n: 1 }, rev: 4 })
  const later = track(mirror.whenRev('project:p', 6))
  sock.event('state.patch', { topic: 'project:p', rev: 5, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  await tick()
  assert.equal(later.settled, false, 'rev 5 is not 6 yet')
  sock.event('state.patch', { topic: 'project:p', rev: 6, ops: [{ op: 'replace', path: '/n', value: 3 }] })
  await tick()
  assert.deepEqual(later.state, { snapshot: { n: 3 }, rev: 6 })
})

test('whenRev before the first snapshot, and across a gap resubscribe', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  const early = track(mirror.whenRev('project:p', 2))
  // This subscribe was in flight when the wait began: only its rev can settle it.
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 1 })
  await tick()
  assert.equal(early.settled, false)
  sock.event('state.patch', { topic: 'project:p', rev: 3, ops: [] })
  // The gap resubscribes; its snapshot is past the rev.
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 9 }, rev: 3 })
  await tick()
  assert.deepEqual(early.state, { snapshot: { n: 9 }, rev: 3 })
})

test('whenRev settles on a snapshot subscribed after the call whatever its rev: a restarted server starts at 0', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 40 })
  await tick()
  const wait = track(mirror.whenRev('project:p', 41))
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  next.reply(next.lastReq('sub.subscribe'), { snapshot: { n: 2 }, rev: 0 })
  await tick()
  assert.deepEqual(wait.state, { snapshot: { n: 2 }, rev: 0 })
})

test('whenRev rejects: not subscribed, NOT_FOUND, the last unsubscribe, close, and its timeout', async () => {
  const { clock, conn, mirror, sock } = setup()
  await assert.rejects(mirror.whenRev('project:x', 1), (e) => e.code === 'NOT_SUBSCRIBED')

  mirror.subscribe('project:gone', () => {})
  const gone = track(mirror.whenRev('project:gone', 1))
  sock.fail(subReqs(sock).at(-1), 'NOT_FOUND', 'No such topic')
  await tick()
  assert.equal(gone.error.code, 'NOT_FOUND')
  await assert.rejects(mirror.whenRev('project:gone', 1), (e) => e.code === 'NOT_FOUND', 'at once while the topic is not found')

  const stop = mirror.subscribe('project:a', () => {})
  sock.reply(subReqs(sock).at(-1), { snapshot: {}, rev: 0 })
  await tick()
  const left = track(mirror.whenRev('project:a', 5))
  stop()
  await tick()
  assert.equal(left.error.code, 'UNSUBSCRIBED')

  mirror.subscribe('project:b', () => {})
  sock.reply(subReqs(sock).at(-1), { snapshot: {}, rev: 0 })
  await tick()
  const slow = track(mirror.whenRev('project:b', 5, { timeoutMs: 2000 }))
  clock.advance(1999)
  await tick()
  assert.equal(slow.settled, false)
  clock.advance(1)
  await tick()
  assert.equal(slow.error.code, 'TIMEOUT')
  const fast = track(mirror.whenRev('project:b', 1, { timeoutMs: 2000 }))
  sock.event('state.patch', { topic: 'project:b', rev: 1, ops: [] })
  await tick()
  assert.equal(fast.state.rev, 1)
  const pendingTimers = clock.pending()
  const closing = track(mirror.whenRev('project:b', 9, { timeoutMs: 5000 }))
  assert.equal(clock.pending(), pendingTimers + 1)
  conn.close()
  await tick()
  assert.equal(closing.error.code, 'CLOSED')
  assert.equal(clock.pending(), 0, 'no timer outlives its wait')
})

test('a transient subscribe failure keeps whenRev waiting; the retry settles it', async () => {
  const { clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  const wait = track(mirror.whenRev('project:p', 2))
  sock.fail(subReqs(sock).at(-1), 'INTERNAL', 'boom')
  await tick()
  assert.equal(wait.settled, false)
  clock.advance(1000)
  sock.reply(subReqs(sock).at(-1), { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.deepEqual(wait.state, { snapshot: { n: 1 }, rev: 0 }, 'the retry was sent after the call')
})

test('whenRev does not trust a state from before a reconnect: it waits for the resubscribe', async () => {
  const { server, clock, conn, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 80 })
  await tick()
  sock.serverClose(1006, '')
  const whileDown = track(mirror.whenRev('project:p', 5))
  clock.advance(1000)
  const next = server.last()
  next.open()
  // App code that sends a command on 'connected' runs before the welcome resubscribes.
  let onConnected
  conn.on('status', ({ status }) => {
    if (status === 'connected' && !onConnected) onConnected = track(mirror.whenRev('project:p', 5))
  })
  next.welcome()
  const inFlight = track(mirror.whenRev('project:p', 5))
  await tick()
  assert.ok(onConnected, 'the status listener ran')
  assert.deepEqual([whileDown.settled, onConnected.settled, inFlight.settled], [false, false, false], 'rev 80 is from the old server')
  next.reply(next.lastReq('sub.subscribe'), { snapshot: { n: 2 }, rev: 7 })
  await tick()
  for (const w of [whileDown, onConnected, inFlight]) assert.deepEqual(w.state, { snapshot: { n: 2 }, rev: 7 })
  assert.deepEqual(await mirror.whenRev('project:p', 5), { snapshot: { n: 2 }, rev: 7 }, 'at once again')
})

test('a stale NOT_FOUND does not reject whenRev while a resubscribe is in flight', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'gone')
  await tick()
  sock.serverClose(1006, '')
  const down = track(mirror.whenRev('project:p', 1))
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  const inFlight = track(mirror.whenRev('project:p', 1))
  await tick()
  assert.deepEqual([down.settled, inFlight.settled], [false, false])
  next.reply(next.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 1 })
  await tick()
  assert.equal(down.state.rev, 1)
  assert.equal(inFlight.state.rev, 1)
})

test('whenRev: a bad rev is BAD_REQUEST; a closed connection is CLOSED, not NOT_SUBSCRIBED', async () => {
  const { conn, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: {}, rev: 3 })
  await tick()
  for (const rev of [-1, 1.5, NaN, Infinity, '2', undefined]) {
    await assert.rejects(mirror.whenRev('project:p', rev), (e) => e.code === 'BAD_REQUEST', String(rev))
  }
  assert.equal((await mirror.whenRev('project:p', 0)).rev, 3)
  conn.close()
  await assert.rejects(mirror.whenRev('project:p', 1), (e) => e.code === 'CLOSED')
})

test('whenRev settles before listeners hear the state: one that unsubscribes does not turn it into UNSUBSCRIBED', async () => {
  const { mirror, sock } = setup()
  let stop = () => {}
  stop = mirror.subscribe('project:p', (u) => { if (u.rev >= 2) stop() })
  const first = track(mirror.whenRev('project:p', 0))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 1 })
  await tick()
  assert.equal(first.state.rev, 1)
  const byPatch = track(mirror.whenRev('project:p', 2))
  sock.event('state.patch', { topic: 'project:p', rev: 2, ops: [] })
  await tick()
  assert.equal(byPatch.error, undefined)
  assert.equal(byPatch.state.rev, 2)
  assert.equal(mirror.get('project:p'), undefined, 'the listener did unsubscribe')

  let stop2 = () => {}
  stop2 = mirror.subscribe('project:q', () => stop2())
  const bySnapshot = track(mirror.whenRev('project:q', 0))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: {}, rev: 0 })
  await tick()
  assert.equal(bySnapshot.state.rev, 0)
})

test('state.patch and topic.ended with a null or malformed payload are ignored', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('project:p', (u) => seen.push(u))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 1 })
  await tick()
  for (const payload of [null, undefined, 5, 'x', { topic: 7 }]) {
    sock.event('topic.ended', payload)
    sock.event('state.patch', payload)
  }
  assert.equal(seen.length, 1)
  assert.deepEqual(mirror.get('project:p'), { snapshot: { n: 1 }, rev: 1 })
})

// ---- topic.ended ----

test('topic.ended reports TOPIC_ENDED with its reason, to current and later listeners, and rejects whenRev', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('project:p', (s) => seen.push(s))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 3 })
  await tick()
  const wait = track(mirror.whenRev('project:p', 9))
  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
  await tick()
  const err = seen.at(-1).error
  assert.equal(err.code, 'TOPIC_ENDED')
  assert.equal(err.message, 'project:p ended: deleted')
  assert.deepEqual(err.details, { reason: 'deleted' })
  assert.equal(wait.error, err)
  assert.equal(mirror.get('project:p'), undefined, 'its state is dropped')
  await assert.rejects(mirror.whenRev('project:p', 1), (e) => e.code === 'TOPIC_ENDED')
  const late = []
  mirror.subscribe('project:p', (s) => late.push(s))
  assert.equal(late.at(-1).error.code, 'TOPIC_ENDED')
  // Patches and a second end for it change nothing.
  sock.event('state.patch', { topic: 'project:p', rev: 4, ops: [] })
  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
  assert.equal(seen.length, 2)
})

test('an ended topic is not subscribed again after a reconnect; an in-flight reply is ignored; others are', async () => {
  const { server, clock, mirror, sock } = setup()
  const seen = []
  mirror.subscribe('project:p', (s) => seen.push(s))
  mirror.subscribe('server', () => {})
  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
  // The first subscribe's reply arrives after the end: it is older, so it is ignored.
  sock.reply(subReqs(sock)[0], { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.equal(seen.at(-1).error.code, 'TOPIC_ENDED')
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  assert.deepEqual(subReqs(next).map((f) => f.params.topic), ['server'])
  // An end for a topic the mirror does not hold is ignored, and an unknown reason still reads as an end.
  next.event('topic.ended', { topic: 'project:other', reason: 'deleted' })
  const stop = mirror.subscribe('project:q', (s) => seen.push(s))
  next.event('topic.ended', { topic: 'project:q' })
  assert.equal(seen.at(-1).error.message, 'project:q ended: ended')
  stop()
  assert.deepEqual(next.lastReq('sub.unsubscribe').params, { topic: 'project:q' })
})

test('topic.ended while whenRev waits on an in-flight subscribe rejects it; the late reply is ignored', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  const wait = track(mirror.whenRev('project:p', 1, { timeoutMs: 5000 }))
  const req = sock.lastReq('sub.subscribe')
  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
  await tick()
  assert.equal(wait.error.code, 'TOPIC_ENDED')
  sock.reply(req, { snapshot: { n: 1 }, rev: 1 })
  await tick()
  assert.equal(mirror.get('project:p'), undefined)
})
