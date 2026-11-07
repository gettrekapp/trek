// scripts/mainServerLinks.test.mjs — main's own connection to each app-wide server that has a token.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SERVER_LINKS, RETRY_STUCK_MS, TOO_MANY_SERVERS, createServerLinks } from '../src/main/serverLinks.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const SECRET = 'tok-S3CRET-never-in-a-snapshot'

/**
 * Links over a fake list, a fake secret store and fake sockets. `hold` keeps
 * the token reads open until `release()`, to change the list meanwhile.
 */
function setup({ entries = [], stored = {} } = {}) {
  const list = entries.map((e) => ({ ...e }))
  const secrets = new Map(Object.entries(stored))
  const server = fakeServer()
  const clock = fakeTimers()
  const changes = []
  let held = null
  let time = 0
  const links = createServerLinks({
    entries: () => list.map((e) => ({ ...e })),
    // The value is read first, then held: as a read that started before a change.
    token: async (id) => {
      const value = secrets.get(id) ?? null
      if (held) await held.promise
      return value
    },
    createSocket: server.factory,
    timers: clock.timers,
    clientVersion: '9.9.9',
    changed: (snapshot) => changes.push(snapshot),
    now: () => time
  })
  const hold = () => {
    let release
    held = { promise: new Promise((r) => (release = r)) }
    return () => {
      held = null
      release()
    }
  }
  const sockFor = (url) => server.sockets.filter((s) => s.url === url).at(-1)
  return { links, list, secrets, server, clock, changes, hold, sockFor, last: () => changes.at(-1), advanceTime: (ms) => (time += ms) }
}

const box = { id: 'box', name: 'Box', url: 'ws://box:8800' }
const lab = { id: 'lab', name: 'Lab', url: 'ws://lab:8800' }

test('one connection per entry with a token; none without one', async () => {
  const { links, server, sockFor, last } = setup({ entries: [box, lab], stored: { box: SECRET } })
  await links.sync()
  assert.deepEqual(server.sockets.map((s) => s.url), ['ws://box:8800'])
  const sock = sockFor('ws://box:8800')
  sock.open()
  assert.equal(sock.sent[0].token, SECRET)
  assert.equal(sock.sent[0].client, 'trek-desktop-main')
  sock.welcome({ serverName: 'build-box', capabilities: ['mcp', 'agents'] })
  assert.deepEqual(last().servers, [
    { id: 'box', name: 'Box', url: 'ws://box:8800', hasToken: true, status: 'connected', message: '', serverName: 'build-box', capabilities: ['mcp', 'agents'] },
    { id: 'lab', name: 'Lab', url: 'ws://lab:8800', hasToken: false, status: null, message: '' }
  ])
})

test('a snapshot never carries a token, only the listed fields', async () => {
  const { links, sockFor, changes } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  const sock = sockFor('ws://box:8800')
  sock.open()
  sock.welcome()
  sock.serverClose(4003, 'unauthorized')
  const all = [...changes, links.snapshot()]
  assert.ok(all.length >= 4)
  const allowed = ['capabilities', 'hasToken', 'id', 'message', 'name', 'serverName', 'status', 'url']
  for (const snapshot of all) {
    assert.deepEqual(Object.keys(snapshot).sort(), ['seq', 'servers'])
    assert.equal(JSON.stringify(snapshot).includes(SECRET), false)
    for (const s of snapshot.servers) for (const key of Object.keys(s)) assert.ok(allowed.includes(key), key)
  }
})

test('every change is a new snapshot with a higher seq', async () => {
  const { links, sockFor, changes } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  sockFor('ws://box:8800').open()
  sockFor('ws://box:8800').welcome()
  const seqs = changes.map((c) => c.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length)
  assert.equal(links.snapshot().seq, seqs.at(-1))
})

test('a new token reconnects the same entry with it; a cleared token closes it', async () => {
  const { links, secrets, server, sockFor, last } = setup({ entries: [box], stored: { box: 'old' } })
  await links.sync()
  const first = sockFor('ws://box:8800')
  first.open()
  first.serverClose(4003, 'unauthorized')
  assert.equal(last().servers[0].status, 'needs-auth')
  secrets.set('box', 'new')
  await links.sync()
  const second = server.last()
  assert.notEqual(second, first)
  second.open()
  assert.equal(second.sent[0].token, 'new')
  second.welcome()
  assert.equal(last().servers[0].status, 'connected')
  secrets.delete('box')
  await links.sync()
  assert.equal(second.readyState, 3)
  assert.deepEqual(last().servers[0], { id: 'box', name: 'Box', url: 'ws://box:8800', hasToken: false, status: null, message: '' })
  assert.equal(links.get('box'), undefined)
})

test('a new URL closes the old connection and opens one to the new address', async () => {
  const { links, list, server, sockFor, last } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  const old = sockFor('ws://box:8800')
  old.open()
  old.welcome({ serverName: 'old-box' })
  list[0].url = 'ws://box2:8800'
  await links.sync()
  assert.equal(old.readyState, 3)
  assert.equal(server.last().url, 'ws://box2:8800')
  const now = last().servers[0]
  assert.equal(now.url, 'ws://box2:8800')
  assert.equal(now.serverName, undefined, 'the old welcome is not carried over')
})

test('a removed entry is closed and leaves the snapshot', async () => {
  const { links, list, sockFor, last } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
  await links.sync()
  list.splice(0, 1)
  await links.sync()
  assert.equal(sockFor('ws://box:8800').readyState, 3)
  assert.deepEqual(last().servers.map((s) => s.id), ['lab'])
  assert.equal(links.get('box'), undefined)
})

test('a token read for the old URL never goes to a new one', async () => {
  const { links, list, secrets, server, hold } = setup({ entries: [box], stored: { box: SECRET } })
  const release = hold()
  const first = links.sync()
  // Its token read has started (and read the old token) before the change.
  await new Promise((r) => setImmediate(r))
  // As appServers.save does for a move to another origin: the URL changes and the token is cleared.
  list[0].url = 'ws://elsewhere:8800'
  secrets.delete('box')
  const second = links.sync()
  release()
  await first
  await second
  assert.deepEqual(server.sockets.map((s) => s.url), [])
  assert.equal(links.snapshot().servers[0].hasToken, false)
})

test('retryStuck reconnects needs-auth and incompatible links, at most once per window of time', async () => {
  const { links, server, sockFor, advanceTime } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
  await links.sync()
  sockFor('ws://box:8800').open()
  sockFor('ws://box:8800').serverClose(4003, 'unauthorized')
  sockFor('ws://lab:8800').open()
  sockFor('ws://lab:8800').welcome()
  assert.equal(server.sockets.length, 2)
  links.retryStuck()
  assert.deepEqual(server.sockets.map((s) => s.url), ['ws://box:8800', 'ws://lab:8800', 'ws://box:8800'])
  server.last().open()
  server.last().serverClose(4003, 'unauthorized')
  links.retryStuck()
  assert.equal(server.sockets.length, 3, 'within RETRY_STUCK_MS: nothing')
  advanceTime(RETRY_STUCK_MS)
  links.retryStuck()
  assert.equal(server.sockets.length, 4)
})

test(`at most ${MAX_SERVER_LINKS} connections; the rest say why`, async () => {
  const entries = Array.from({ length: MAX_SERVER_LINKS + 1 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, url: `ws://s${i}:1` }))
  const stored = Object.fromEntries(entries.map((e) => [e.id, SECRET]))
  const { links, server, last } = setup({ entries, stored })
  await links.sync()
  assert.equal(server.sockets.length, MAX_SERVER_LINKS)
  assert.deepEqual(last().servers.at(-1), { id: `s${MAX_SERVER_LINKS}`, name: `S${MAX_SERVER_LINKS}`, url: `ws://s${MAX_SERVER_LINKS}:1`, hasToken: true, status: 'error', message: TOO_MANY_SERVERS })
})

test('close ends every connection and every broadcast', async () => {
  const { links, sockFor, changes, clock } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  const sock = sockFor('ws://box:8800')
  sock.open()
  const before = changes.length
  links.close()
  assert.equal(sock.readyState, 3)
  clock.advance(60_000)
  await links.sync()
  assert.equal(changes.length, before)
})

test('retryStuck: a call that finds nothing stuck does not start the throttle', async () => {
  const { links, server, sockFor } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  sockFor('ws://box:8800').open()
  sockFor('ws://box:8800').welcome()
  links.retryStuck()
  assert.equal(server.sockets.length, 1, 'connected: nothing to retry')
  sockFor('ws://box:8800').serverClose(4003, 'unauthorized')
  // No time has passed, yet the first call reconnected nothing, so this one runs.
  links.retryStuck()
  assert.equal(server.sockets.length, 2)
  server.last().open()
  server.last().serverClose(4003, 'unauthorized')
  links.retryStuck()
  assert.equal(server.sockets.length, 2, 'that one did reconnect: now throttled')
})

test('retry(id) reconnects that entry only, if stuck, with no throttle', async () => {
  const { links, server, sockFor } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
  await links.sync()
  sockFor('ws://box:8800').open()
  sockFor('ws://box:8800').serverClose(4003, 'unauthorized')
  sockFor('ws://lab:8800').open()
  sockFor('ws://lab:8800').serverClose(4003, 'unauthorized')
  links.retryStuck()
  assert.equal(server.sockets.length, 4)
  for (const s of server.sockets.slice(2)) {
    s.open()
    s.serverClose(4003, 'unauthorized')
  }
  // Within the throttle window: retry still reconnects, and only the entry asked for.
  links.retry('box')
  assert.deepEqual(server.sockets.slice(4).map((s) => s.url), ['ws://box:8800'])
  server.last().open()
  server.last().welcome()
  links.retry('box')
  links.retry('missing')
  assert.equal(server.sockets.length, 5, 'connected, or unknown: nothing')
})

test('drop(id) closes the connection at once, with no reconnect; the next sync brings it back if still listed', async () => {
  const { links, server, sockFor, clock, last } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
  await links.sync()
  const sock = sockFor('ws://box:8800')
  sock.open()
  sock.welcome()
  links.drop('box')
  assert.equal(sock.readyState, 3)
  assert.equal(links.get('box'), undefined)
  assert.equal(last().servers[0].status, null, 'the snapshot shows it unconnected')
  clock.advance(120_000)
  assert.equal(server.sockets.filter((s) => s.url === 'ws://box:8800').length, 1, 'no reconnect with the cached token')
  links.drop('missing')
  // A remove that failed: the entry is still listed with its token, so the sync reconnects it.
  await links.sync()
  assert.equal(server.sockets.filter((s) => s.url === 'ws://box:8800').length, 2)
  assert.equal(server.last().readyState, 0)
})

test('drop(id) during a sync\'s token reads: that sync leaves the entry to the next', async () => {
  const { links, secrets, server, hold } = setup({ entries: [box], stored: { box: SECRET } })
  await links.sync()
  assert.equal(server.sockets.length, 1)
  const release = hold()
  const first = links.sync()
  await new Promise((r) => setImmediate(r))
  // As appServers.remove does: the link drops, then the token is cleared.
  links.drop('box')
  secrets.delete('box')
  const second = links.sync()
  release()
  await first
  await second
  assert.equal(server.sockets.length, 1, 'the token read before the drop never reconnects')
  assert.equal(links.get('box'), undefined)
})
