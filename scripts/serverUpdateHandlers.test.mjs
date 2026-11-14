// scripts/serverUpdateHandlers.test.mjs — the update.* protocol methods: answered by the server's
// update service, refused on a server that has none, and their refusals as the wire carries them;
// and, on a real server on a loopback port, who hears update.changed, what the welcome lists and
// what a shutdown for an update tells its clients.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDirWhenFree } from './testPlatform.mjs'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { codedError } from '../server/src/errors.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { ProjectStore } from '../server/src/projects/store.ts'
import { startServer } from '../server/src/server.ts'
import { addToken } from '../server/src/tokens.ts'
import { createUpdateService } from '../server/src/update/service.ts'
import { writeState } from '../server/src/update/state.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const STATUS = { current: '1.0.0', latest: '2.0.0', state: 'idle', sessions: 0, canRelaunch: true, restartNeeded: false, remoteApply: true }
/** The update handlers read nothing else of the context. */
const ctx = (update) => ({ update })

test('update.status, update.check and update.apply go to the update service', async () => {
  const calls = []
  const service = {
    status: () => { calls.push('status'); return STATUS },
    check: async () => { calls.push('check'); return { ...STATUS, checkedAt: 'now' } },
    apply: (version) => { calls.push(`apply ${version}`); return { started: true } }
  }
  // Answered in the caller's tick where the service answers in it.
  assert.deepEqual(dispatchV2('update.status', {}, ctx(service)), { ok: true, result: STATUS })
  const checked = dispatchV2('update.check', {}, ctx(service))
  assert.ok(checked instanceof Promise, 'a check is awaited')
  assert.deepEqual(await checked, { ok: true, result: { ...STATUS, checkedAt: 'now' } })
  assert.deepEqual(dispatchV2('update.apply', { version: '2.0.0' }, ctx(service)), { ok: true, result: { started: true } })
  assert.deepEqual(dispatchV2('update.apply', undefined, ctx(service)), { ok: true, result: { started: true } }, 'no params: the service is asked, and says what is wrong')
  assert.deepEqual(calls, ['status', 'check', 'apply 2.0.0', 'apply undefined'])
})

test('a server that cannot update itself answers NOT_FOUND to all three', async () => {
  for (const [method, params] of [['update.status', {}], ['update.check', {}], ['update.apply', { version: '2.0.0' }]]) {
    const result = await dispatchV2(method, params, ctx(undefined))
    assert.equal(result.ok, false, method)
    assert.equal(result.error.code, 'NOT_FOUND', method)
    assert.match(result.error.message, /does not update itself/)
  }
})

test("the service's refusals reach the client with their code and reason", async () => {
  const service = {
    status: () => STATUS,
    check: async () => { throw codedError('TOOL_ERROR', 'Could not check for an update: no valid signature') },
    apply: () => { throw codedError('CONFLICT', 'refused', { reason: 'stale' }) }
  }
  assert.deepEqual(dispatchV2('update.apply', { version: '9.9.9' }, ctx(service)), { ok: false, error: { code: 'CONFLICT', message: 'refused', details: { reason: 'stale' } } })
  assert.deepEqual(await dispatchV2('update.check', {}, ctx(service)), { ok: false, error: { code: 'TOOL_ERROR', message: 'Could not check for an update: no valid signature' } })
  const busy = { ...service, check: () => Promise.reject(codedError('CONFLICT', 'An update is running on this server', { reason: 'busy' })) }
  assert.deepEqual((await dispatchV2('update.check', {}, ctx(busy))).error, { code: 'CONFLICT', message: 'An update is running on this server', details: { reason: 'busy' } })
})

// ---- a real server on a loopback port -----------------------------------------------------

const WAIT_MS = 10_000

/** A server with a token, on a port the OS picks; nothing outside its temp folder is read or written. */
async function server(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-update-wire-'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [] })
  const store = new ConfigStore(configPath)
  let token = ''
  store.update((config) => { token = addToken(config, 'test') })
  const files = new ProjectStore(join(dir, 'projects'))
  const trek = startServer(
    store,
    '1.0.0',
    { create: (hub, onSummariesChange) => new ProjectState({ hub, store: files, onSummariesChange }, files.loadAll()), store: files },
    // What another server left in the temp directory is not swept: that server may be in use.
    { sweepStaleMoves: false, ...options }
  )
  const sockets = []
  let down = false
  const shutdown = async (reason, detail) => {
    if (down) return
    down = true
    await trek.shutdown(reason, detail)
  }
  t.after(async () => {
    for (const ws of sockets) ws.close()
    await shutdown('test over')
    trek.httpServer.closeAllConnections()
    trek.sessions.terminals.forceKillAll()
    store.close()
    files.close()
    await removeDirWhenFree(dir)
  })
  await new Promise((done, reject) => {
    trek.httpServer.once('error', reject)
    trek.httpServer.listen(0, '127.0.0.1', done)
  })
  const url = `ws://127.0.0.1:${trek.httpServer.address().port}`

  /** A connection and every frame it is sent. `hello: false`: it never signs in. */
  const connect = async ({ hello = true } = {}) => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const frames = []
    const waiters = new Set()
    ws.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)))
      for (const wake of waiters) wake()
    })
    const closed = new Promise((done) => ws.addEventListener('close', done))
    /** The first frame from index `from` on that `pred` accepts; fails with what did arrive. */
    const frame = (pred, what, from = 0) =>
      new Promise((done, reject) => {
        const look = () => {
          const found = frames.slice(from).find(pred)
          if (!found) return
          clearTimeout(timer)
          waiters.delete(look)
          done(found)
        }
        const timer = setTimeout(() => {
          waiters.delete(look)
          reject(new Error(`no ${what} within ${WAIT_MS} ms; received ${JSON.stringify(frames)}`))
        }, WAIT_MS)
        waiters.add(look)
        look()
      })
    await new Promise((done, reject) => {
      ws.addEventListener('open', done)
      ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)))
    })
    let nextId = 1
    const request = async (method, params = {}) => {
      const id = nextId++
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
      return frame((f) => f.type === 'res' && f.id === id, `answer to ${method}`)
    }
    let welcome
    if (hello) {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'test', clientVersion: '0', token }))
      welcome = await frame((f) => f.type === 'welcome', 'welcome')
    }
    const events = (name) => frames.filter((f) => f.type === 'event' && f.event === name).map((f) => f.payload)
    return { ws, frames, frame, request, welcome, events, closed }
  }
  return { trek, connect, shutdown }
}

test('update.changed goes to every signed-in connection and to no other; one that signs in later reads the state with update.status', async (t) => {
  let emit
  let made = 0
  let current = { ...STATUS }
  const service = {
    status: () => current,
    check: async () => current,
    apply: () => { throw codedError('CONFLICT', 'The latest release is now 2.0.0, not 9.9.9: check again', { reason: 'stale' }) }
  }
  const s = await server(t, {
    update: (onChange) => {
      made++
      emit = onChange
      return service
    }
  })
  assert.equal(made, 1, 'made once, as the server is made: before it can answer a connection')

  const a = await s.connect()
  const b = await s.connect()
  const stranger = await s.connect({ hello: false })
  assert.ok(a.welcome.capabilities.includes('update'), JSON.stringify(a.welcome.capabilities))

  current = { ...STATUS, state: 'downloading', percent: 40 }
  emit(current)
  // Each has heard it by the time it is answered: a connection's frames arrive in order.
  for (const c of [a, b]) {
    assert.deepEqual((await c.request('sys.ping', { t: 1 })).result, { t: 1 })
    assert.deepEqual(c.events('update.changed'), [current])
  }

  // Signing in mid-update: the welcome, and nothing replayed. The state is there to be asked for.
  const late = await s.connect()
  assert.deepEqual((await late.request('update.status')).result, current)
  assert.deepEqual(late.frames.map((f) => f.type), ['welcome', 'res'])

  // A refusal's reason, and an awaited answer, as the wire carries them.
  const refused = await a.request('update.apply', { version: '9.9.9' })
  assert.deepEqual([refused.ok, refused.error], [false, { code: 'CONFLICT', message: 'The latest release is now 2.0.0, not 9.9.9: check again', details: { reason: 'stale' } }])
  assert.deepEqual((await a.request('update.check')).result, current)

  // The restart: `restarting` first, then the shutdown that names the version, then the close.
  current = { ...STATUS, state: 'restarting' }
  emit(current)
  await s.shutdown('update', { version: '2.0.0' })
  for (const c of [a, b, late]) {
    await c.closed
    const tail = c.frames.filter((f) => f.type === 'event').slice(-2)
    assert.deepEqual(tail, [
      { type: 'event', event: 'update.changed', payload: current },
      { type: 'event', event: 'daemon.shutdown', payload: { reason: 'update', version: '2.0.0' } }
    ])
  }
  await stranger.closed
  assert.deepEqual(stranger.frames, [], 'a connection that never signed in is sent nothing')
})

test('a real update service behind the wire: a change for each step, the refusal reasons, and the status', async (t) => {
  const s = await server(t, {
    update: (onChange) => {
      const dir = mkdtempSync(join(tmpdir(), 'trek-update-wire-install-'))
      t.after(() => removeDirWhenFree(dir))
      writeState(dir, { latest: '2.0.0' })
      return createUpdateService({
        install: { dir, parent: dir, version: '1.0.0', build: 'b', target: 'linux-x64' },
        configDir: dir,
        running: '1.0.0',
        sessions: () => 0,
        remoteApply: () => true,
        canRelaunch: () => false,
        relaunchRefusal: () => 'not here',
        find: async () => null,
        apply: async ({ onStep, onProgress }) => {
          await Promise.resolve()
          onStep('downloading')
          onProgress(1, 2)
          onStep('installing')
          return { kind: 'failed', error: 'simulated' }
        },
        relaunch: () => {},
        onChange
      })
    }
  })
  const a = await s.connect()
  const stale = await a.request('update.apply', { version: '3.0.0' })
  assert.deepEqual([stale.error.code, stale.error.details], ['CONFLICT', { reason: 'stale' }])
  assert.equal((await a.request('update.apply', {})).error.code, 'BAD_REQUEST')
  assert.deepEqual((await a.request('update.apply', { version: '2.0.0' })).result, { started: true })
  await a.frame((f) => f.event === 'update.changed' && f.payload.state === 'idle', 'the update to end')
  assert.deepEqual(a.events('update.changed').map((p) => [p.state, p.percent]), [['checking', undefined], ['downloading', undefined], ['downloading', 50], ['installing', undefined], ['idle', undefined]])
})

test('a server with no update service: no capability, NOT_FOUND, and a shutdown that names no version', async (t) => {
  const s = await server(t, {})
  const a = await s.connect()
  assert.equal(a.welcome.capabilities.includes('update'), false)
  for (const [method, params] of [['update.status', {}], ['update.check', {}], ['update.apply', { version: '2.0.0' }]]) {
    const res = await a.request(method, params)
    assert.deepEqual([res.ok, res.error.code], [false, 'NOT_FOUND'], method)
  }
  await s.shutdown('SIGTERM')
  await a.closed
  assert.deepEqual(a.frames.at(-1), { type: 'event', event: 'daemon.shutdown', payload: { reason: 'SIGTERM' } })
})
