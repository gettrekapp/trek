// scripts/serverPluginInstallHandlers.test.mjs — installing plugins over the protocol (theme
// plugins phase 1): the config switch and the capability, plugins.install / remove / bundle, and,
// on a real server on a loopback port, the welcome's entries and who hears a change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDir, removeDirWhenFree } from './testPlatform.mjs'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { createInstalledPlugins } from '../server/src/plugins/installed.ts'
import { installedIdReserved } from '../server/src/plugins/reserved.ts'
import { MAX_PACKAGE_BYTES } from '../server/src/plugins/source.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { ProjectStore } from '../server/src/projects/store.ts'
import { startServer } from '../server/src/server.ts'
import { addToken } from '../server/src/tokens.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'

test('pluginInstall is listed only when asked for, after update', () => {
  const off = welcomeCapabilities(true, false, false, [], 'linux', true)
  assert.ok(!off.includes('pluginInstall'))
  const on = welcomeCapabilities(true, false, false, [], 'linux', true, true)
  assert.equal(on.indexOf('pluginInstall'), on.indexOf('update') + 1)
  assert.ok(welcomeCapabilities(true, true, false, [], 'linux', false, true).includes('pluginInstall'), 'the local server installs plugins too')
})

test('config.plugins.remoteInstall must be true or false', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-config-'))
  t.after(() => removeDir(dir))
  const path = join(dir, 'config.json')
  const open = (plugins) => {
    writeFileSync(path, JSON.stringify({ repos: [], plugins }))
    const store = new ConfigStore(path)
    const value = store.config.plugins
    store.close()
    return value
  }
  assert.deepEqual(open({ remoteInstall: false }), { remoteInstall: false })
  assert.deepEqual(open({}), {})
  assert.throws(() => open({ remoteInstall: 'no' }), /config\.plugins\.remoteInstall must be true or false/)
  assert.throws(() => open([]), /config\.plugins must be an object/)
})

const MANIFEST = { id: 'solarized', version: '1.0.0', name: 'Solarized', description: 'A theme.', type: 'theme', contract: 1 }
const packageText = (manifest = {}, client = 'export default {}') => JSON.stringify({ manifest: { ...MANIFEST, ...manifest }, client })

/** The context the plugin install handlers read: the store, the switch (a value, or a function asked each time), a fetch that serves `pages`, and the lines logged. */
function installCtx(t, { remoteInstall = true, pages = {}, tokenName = 'laptop' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trek-plugin-handlers-'))
  t.after(() => removeDir(root))
  const dir = join(root, 'plugins-installed')
  const store = createInstalledPlugins({ dir, reserved: installedIdReserved([{ manifest: { id: 'voice' } }]), warn: () => {} })
  const asked = []
  const fetch = async (url, init) => {
    asked.push(url)
    init?.signal?.throwIfAborted()
    return pages[url] === undefined ? new Response('', { status: 404 }) : new Response(pages[url])
  }
  const logged = []
  const allowed = typeof remoteInstall === 'function' ? remoteInstall : () => remoteInstall
  return { dir, store, asked, logged, ctx: { tokenName, installed: { store, remoteInstall: allowed, fetch, log: (line) => logged.push(line) } } }
}

test('plugins.install by package and by URL answers the presence entry; plugins.bundle hands the text out; plugins.remove removes', async (t) => {
  const { store, ctx } = installCtx(t, { pages: { 'https://themes.test/nord.trekplugin': packageText({ id: 'nord', name: 'Nord' }, 'export default 2') } })
  const installed = await dispatchV2('plugins.install', { package: packageText() }, ctx)
  assert.equal(installed.ok, true)
  assert.deepEqual(installed.result, store.presence()[0])
  assert.equal(installed.result.id, 'solarized')
  const byUrl = await dispatchV2('plugins.install', { url: 'https://themes.test/nord.trekplugin' }, ctx)
  assert.deepEqual([byUrl.ok, byUrl.result.id, byUrl.result.name], [true, 'nord', 'Nord'])
  const bundle = await dispatchV2('plugins.bundle', { id: 'nord' }, ctx)
  assert.deepEqual(bundle, { ok: true, result: { sha256: byUrl.result.sha256, client: 'export default 2' } })
  assert.deepEqual(await dispatchV2('plugins.remove', { id: 'nord' }, ctx), { ok: true, result: {} })
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['solarized'])
})

test('the refusals', async (t) => {
  const { dir, store, asked, ctx } = installCtx(t)
  const code = async (method, params) => {
    const outcome = await dispatchV2(method, params, ctx)
    return outcome.ok ? 'ok' : `${outcome.error.code}: ${outcome.error.message}`
  }
  assert.match(await code('plugins.install', {}), /^BAD_REQUEST: .*url or package/)
  assert.match(await code('plugins.install', { url: 'https://a.test/x', package: packageText() }), /^BAD_REQUEST: .*url or package/)
  assert.match(await code('plugins.install', { package: 5 }), /^BAD_REQUEST/)
  assert.match(await code('plugins.install', { url: 5 }), /^BAD_REQUEST: url must be a string/)
  assert.match(await code('plugins.install', { package: '{' }), /^BAD_REQUEST: .*not JSON/)
  assert.match(await code('plugins.install', { package: packageText({ type: 'feature' }) }), /^BAD_REQUEST: .*type must be "theme"/)
  assert.match(await code('plugins.install', { package: packageText({ id: 'voice' }) }), /^BAD_REQUEST: .*built-in plugin/)
  assert.match(await code('plugins.install', { url: 'http://a.test/x' }), /^BAD_REQUEST: .*https/)
  assert.match(await code('plugins.install', { url: 'https://a.test/missing' }), /^BAD_REQUEST: .*HTTP 404/)
  assert.match(await code('plugins.remove', { id: 'nope' }), /^NOT_FOUND/)
  assert.match(await code('plugins.remove', {}), /^BAD_REQUEST/)
  assert.match(await code('plugins.bundle', { id: 'nope' }), /^NOT_FOUND/)

  // A package that would be taken but for its size: refused before it is parsed.
  const oversized = JSON.stringify({ manifest: MANIFEST, client: 'export default {}', padding: 'x'.repeat(MAX_PACKAGE_BYTES) })
  assert.match(await code('plugins.install', { package: oversized }), /^BAD_REQUEST: .*larger than a plugin package may be/)

  // What is not an id, or is too long to be a URL, is not sent back.
  const fetched = asked.length
  const longUrl = `https://a.test/${'u'.repeat(2048)}`
  const refusedUrl = await code('plugins.install', { url: longUrl })
  assert.match(refusedUrl, /^BAD_REQUEST: url is longer than 2,048 characters$/)
  assert.equal(asked.length, fetched, 'and not fetched')
  assert.match(await code('plugins.install', { url: `https://a.test/${'u'.repeat(2048 - 'https://a.test/'.length)}` }), /^BAD_REQUEST: .*HTTP 404/, '2,048 characters are a URL')
  for (const method of ['plugins.bundle', 'plugins.remove']) {
    for (const id of ['../../etc/passwd', 'Solarized', 'x'.repeat(33), '<script>alert(1)</script>', 'a\nb']) {
      assert.equal(await code(method, { id }), 'BAD_REQUEST: id is not a plugin id', `${method} ${JSON.stringify(id)}`)
    }
    for (const id of [5, '', null, ['solarized'], { id: 'solarized' }]) assert.equal(await code(method, { id }), 'BAD_REQUEST: id is required', `${method} ${JSON.stringify(id)}`)
    assert.match(await code(method, null), /^BAD_REQUEST: id is required/)
  }

  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], 'nothing was written')
  assert.deepEqual(store.list(), [])
})

test('remoteInstall off: install and remove are NOT_FOUND, the bundle is still handed out', async (t) => {
  const { store, ctx } = installCtx(t, { remoteInstall: false })
  store.add(JSON.parse(packageText({ defaultEnabled: false })))
  const install = await dispatchV2('plugins.install', { package: packageText({ id: 'nord' }) }, ctx)
  assert.deepEqual([install.ok, install.error.code], [false, 'NOT_FOUND'])
  assert.match(install.error.message, /trek-server plugin add/)
  const remove = await dispatchV2('plugins.remove', { id: 'solarized' }, ctx)
  assert.deepEqual([remove.ok, remove.error.code], [false, 'NOT_FOUND'])
  assert.equal((await dispatchV2('plugins.bundle', { id: 'solarized' }, ctx)).ok, true)
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['solarized'])
})

test('remoteInstall is asked at each request: a config changed while the server runs is obeyed at once', async (t) => {
  let on = true
  let asks = 0
  const { store, ctx } = installCtx(t, { remoteInstall: () => (asks++, on) })
  assert.equal((await dispatchV2('plugins.install', { package: packageText() }, ctx)).ok, true)
  on = false
  const install = await dispatchV2('plugins.install', { package: packageText({ id: 'nord' }) }, ctx)
  assert.deepEqual([install.ok, install.error.code], [false, 'NOT_FOUND'])
  const remove = await dispatchV2('plugins.remove', { id: 'solarized' }, ctx)
  assert.deepEqual([remove.ok, remove.error.code], [false, 'NOT_FOUND'])
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['solarized'])
  assert.equal((await dispatchV2('plugins.bundle', { id: 'solarized' }, ctx)).ok, true, 'the bundle does not ask')
  on = true
  assert.deepEqual(await dispatchV2('plugins.remove', { id: 'solarized' }, ctx), { ok: true, result: {} })
  assert.equal((await dispatchV2('plugins.install', { package: packageText({ id: 'nord' }) }, ctx)).ok, true)
  assert.equal(asks, 5, 'once per install or remove')
})

test('an install and a removal are logged with the token that asked; a refusal is not', async (t) => {
  const url = 'https://user:secret@themes.test/packs/nord.trekplugin?key=secret#frag'
  // The fetch is never given credentials: the URL with them is refused, so the page is the one without.
  const page = 'https://themes.test/packs/nord.trekplugin?key=secret#frag'
  const { logged, ctx } = installCtx(t, { tokenName: 'my "phone"\nx', pages: { [page]: packageText({ id: 'nord', version: '2.1.0' }, 'export default 2') } })
  const first = await dispatchV2('plugins.install', { package: packageText() }, ctx)
  assert.deepEqual(logged, [`[plugins] token "my \\"phone\\"\\nx" installed solarized 1.0.0 (sha256 ${first.result.sha256}) from a package`], 'the name is quoted, on one line')
  assert.equal((await dispatchV2('plugins.install', { url }, ctx)).ok, false)
  assert.equal(logged.length, 1, 'a refused install is not logged')
  const byUrl = await dispatchV2('plugins.install', { url: page }, ctx)
  assert.equal(byUrl.ok, true, JSON.stringify(byUrl))
  assert.equal(logged[1], `[plugins] token "my \\"phone\\"\\nx" installed nord 2.1.0 (sha256 ${byUrl.result.sha256}) from https://themes.test/packs/nord.trekplugin`, 'the URL without its query or fragment')
  assert.match(byUrl.result.sha256, /^[0-9a-f]{64}$/)
  assert.equal((await dispatchV2('plugins.remove', { id: 'nope' }, ctx)).ok, false)
  assert.equal((await dispatchV2('plugins.remove', { id: 'nord' }, ctx)).ok, true)
  assert.deepEqual(logged.slice(2), ['[plugins] token "my \\"phone\\"\\nx" removed nord'])

  // A plain name, as the user's sentence has it; and the default is console.log.
  const plain = installCtx(t, { tokenName: 'laptop' })
  delete plain.ctx.installed.log
  const real = console.log
  const printed = []
  console.log = (line) => printed.push(line)
  try {
    await dispatchV2('plugins.install', { package: packageText() }, plain.ctx)
    await dispatchV2('plugins.remove', { id: 'solarized' }, plain.ctx)
  } finally {
    console.log = real
  }
  assert.equal(printed.length, 2, JSON.stringify(printed))
  assert.match(printed[0], /^\[plugins\] token "laptop" installed solarized 1\.0\.0 \(sha256 [0-9a-f]{64}\) from a package$/)
  assert.equal(printed[1], '[plugins] token "laptop" removed solarized')
})

test('text that is not ASCII keeps its bytes: the hash a client computes of the bundle it is sent is the one announced', async (t) => {
  // A leading U+FEFF, two- three- and four-byte characters, a line and paragraph separator.
  const client = '\uFEFFexport default { name: "Zażółć 日本語 🎨", sep: "\u2028\u2029" } // é\n'
  const { dir, store, ctx } = installCtx(t)
  const installed = await dispatchV2('plugins.install', { package: packageText({}, client) }, ctx)
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const bundle = await dispatchV2('plugins.bundle', { id: 'solarized' }, ctx)
  assert.equal(bundle.ok, true)
  assert.equal(bundle.result.client, client, 'the text as it was sent, its U+FEFF kept')
  assert.equal(bundle.result.client.charCodeAt(0), 0xfeff)
  const clientSide = createHash('sha256').update(new TextEncoder().encode(bundle.result.client)).digest('hex')
  assert.equal(clientSide, bundle.result.sha256)
  assert.equal(installed.result.sha256, clientSide, "the install's answer")
  assert.equal(store.presence()[0].sha256, clientSide, "the welcome's entry")
  // Read from the folder, as after a restart: the same.
  const restarted = createInstalledPlugins({ dir, reserved: () => false, warn: () => {} })
  assert.equal(restarted.presence()[0].sha256, clientSide)
  assert.deepEqual(restarted.bundle('solarized'), bundle.result)
})

test('a server with no installed plugins store answers NOT_FOUND to all three', async () => {
  for (const [method, params] of [['plugins.install', { package: packageText() }], ['plugins.remove', { id: 'x' }], ['plugins.bundle', { id: 'x' }]]) {
    const outcome = await dispatchV2(method, params, {})
    assert.deepEqual([outcome.ok, outcome.error.code], [false, 'NOT_FOUND'], method)
  }
})

const WAIT_MS = 10_000

/** A server with a token and the built-in plugins, on a port the OS picks; nothing outside its temp folder is read or written. */
async function server(t, config = {}, list = BUILTIN_SERVER_PLUGINS) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-wire-'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [], ...config })
  const store = new ConfigStore(configPath)
  let token = ''
  store.update((c) => { token = addToken(c, 'test') })
  const files = new ProjectStore(join(dir, 'projects'))
  const trek = startServer(
    store,
    '1.0.0',
    { create: (hub, onSummariesChange) => new ProjectState({ hub, store: files, onSummariesChange }, files.loadAll()), store: files },
    { sweepStaleMoves: false, plugins: { list, secretsFile: join(dir, 'secrets.json'), dataDir: dir, env: {} } }
  )
  const sockets = []
  t.after(async () => {
    for (const ws of sockets) ws.close()
    await trek.shutdown('test over')
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
    const signIn = () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'test', clientVersion: '0', token }))
      return frame((f) => f.type === 'welcome', 'welcome')
    }
    const welcome = hello ? await signIn() : undefined
    /** The first `name` event from frame index `from` on whose payload `pred` accepts. */
    const event = (name, pred = () => true, from = 0) => frame((f) => f.type === 'event' && f.event === name && pred(f.payload), name, from)
    return { ws, frames, request, welcome, event, signIn }
  }
  return { dir, connect }
}

const lists = (id) => (p) => p.plugins.some((x) => x.id === id)
const isId = (id) => (p) => p.id === id
/** Frames arrive in order, so a connection that is answered has been sent everything before the answer. */
const settle = async (...connections) => {
  for (const c of connections) assert.deepEqual((await c.request('sys.ping', { t: 1 })).result, { t: 1 })
}
const pluginEvents = (c) => c.frames.filter((f) => f.type === 'event' && (f.event === 'plugins.list' || f.event === 'plugins.changed'))

test('on the wire: the welcome lists installed plugins after the built-ins, and every signed-in connection hears an install and a removal: the list, then the change', async (t) => {
  const s = await server(t)
  const a = await s.connect()
  const b = await s.connect()
  const stranger = await s.connect({ hello: false })
  assert.ok(a.welcome.capabilities.includes('pluginInstall'))
  const builtIns = a.welcome.plugins.map((p) => p.id)
  assert.ok(builtIns.includes('voice') && !builtIns.includes('solarized'))

  const res = await a.request('plugins.install', { package: packageText() })
  assert.equal(res.ok, true, JSON.stringify(res))
  for (const c of [a, b]) {
    const list = await c.event('plugins.list', lists('solarized'))
    assert.deepEqual(list.payload.plugins.map((p) => p.id), [...builtIns, 'solarized'], 'built-ins first')
    assert.deepEqual(list.payload.plugins.at(-1), res.result)
    const changed = await c.event('plugins.changed', isId('solarized'))
    assert.ok(c.frames.indexOf(list) < c.frames.indexOf(changed), 'the list, then the change')
  }

  const late = await s.connect()
  assert.deepEqual(late.welcome.plugins.at(-1), res.result, 'a later welcome lists it')
  const bundle = await late.request('plugins.bundle', { id: 'solarized' })
  assert.deepEqual(bundle.result, { sha256: res.result.sha256, client: 'export default {}' })

  // The removal's own frames: only those after this point count (the install's would satisfy a search from the start).
  const from = new Map([a, b, late].map((c) => [c, c.frames.length]))
  assert.equal((await late.request('plugins.remove', { id: 'solarized' })).ok, true)
  for (const c of [a, b, late]) {
    const list = await c.event('plugins.list', () => true, from.get(c))
    assert.deepEqual(list.payload.plugins.map((p) => p.id), builtIns, 'the list without it')
    const changed = await c.event('plugins.changed', isId('solarized'), from.get(c))
    assert.ok(c.frames.indexOf(list) < c.frames.indexOf(changed), 'the list, then the change')
  }

  // One that had not signed in was sent neither. Its frames arrive in order: signing in now, its
  // welcome comes after anything it was sent before.
  await settle(a, b, late)
  await stranger.signIn()
  assert.deepEqual(stranger.frames.map((f) => f.type), ['welcome'], JSON.stringify(stranger.frames))
  assert.deepEqual(pluginEvents(a).map((f) => f.event), ['plugins.list', 'plugins.changed', 'plugins.list', 'plugins.changed'], 'and nothing twice')
})

test('on the wire: a plugin added in the folder by another process reaches the connected clients', async (t) => {
  const s = await server(t)
  const a = await s.connect()
  const other = createInstalledPlugins({ dir: join(s.dir, 'plugins-installed'), reserved: () => false, warn: () => {} })
  // The server's watch becomes live some time after it starts (macOS), and a change made before
  // that is not heard: a real change is made again until one is.
  const heard = a.event('plugins.list', lists('nord'))
  let done = false
  heard.then(() => { done = true }, () => { done = true })
  for (let n = 0; !done && n < 40; n++) {
    other.add(JSON.parse(packageText({ id: 'nord', name: `Nord ${n}`, defaultEnabled: false })))
    await Promise.race([heard.catch(() => {}), new Promise((wake) => setTimeout(wake, 250))])
  }
  const list = await heard
  assert.match(list.payload.plugins.at(-1).name, /^Nord \d+$/)
  const changed = await a.event('plugins.changed', isId('nord'))
  assert.ok(a.frames.indexOf(list) < a.frames.indexOf(changed), 'the list, then the change')
})

test('on the wire: remoteInstall off drops the capability and refuses install and remove; what is installed is still listed and handed out', async (t) => {
  const s = await server(t, { plugins: { remoteInstall: false } })
  const a = await s.connect()
  assert.ok(!a.welcome.capabilities.includes('pluginInstall'))
  assert.ok(!a.welcome.plugins.some((p) => p.id === 'solarized'))
  assert.equal((await a.request('plugins.install', { package: packageText() })).error.code, 'NOT_FOUND')

  // Installed on the machine, as `trek-server plugin add` does: the store is there, only the clients' way in is shut.
  const other = createInstalledPlugins({ dir: join(s.dir, 'plugins-installed'), reserved: () => false, warn: () => {} })
  // The server hears of it through its watch, which may not be live yet: a real change is made again until it answers.
  let added
  let bundle
  for (let n = 0; n < 40 && !bundle?.ok; n++) {
    added = other.add(JSON.parse(packageText({ defaultEnabled: false }, `export default ${n}`)))
    await Promise.race([a.event('plugins.list', lists('solarized')).catch(() => {}), new Promise((wake) => setTimeout(wake, 250))])
    bundle = await a.request('plugins.bundle', { id: 'solarized' })
  }
  assert.equal(bundle.ok, true, JSON.stringify(bundle))
  assert.equal(bundle.result.sha256, added.sha256, 'the bundle as it is now')
  const late = await s.connect()
  assert.ok(!late.welcome.capabilities.includes('pluginInstall'))
  assert.equal(late.welcome.plugins.at(-1).id, 'solarized', 'the welcome lists it')
  assert.equal(late.welcome.plugins.at(-1).sha256, added.sha256)
  const remove = await late.request('plugins.remove', { id: 'solarized' })
  assert.deepEqual([remove.ok, remove.error.code], [false, 'NOT_FOUND'])
  assert.equal((await late.request('plugins.bundle', { id: 'solarized' })).ok, true, 'still there')
})

test('on the wire (plugins E1): host.emitTo reaches only the connection that sent the request; once it closes, nobody', async (t) => {
  let host
  let lastCaller
  const teller = {
    manifest: { id: 'teller', version: '1.0.0', name: 'teller', description: '', defaultEnabled: true },
    setup: (h) => {
      host = h
      return {
        handlers: {
          tell: (p, ctx) => {
            lastCaller = ctx.caller
            host.emitTo(ctx.caller, 'teller.told', { text: p.text })
            return null
          }
        }
      }
    }
  }
  const s = await server(t, {}, [teller])
  const a = await s.connect()
  const b = await s.connect()
  assert.equal((await a.request('teller.tell', { text: 'hi' })).ok, true)
  assert.deepEqual((await a.event('teller.told')).payload, { text: 'hi' })
  assert.equal(typeof lastCaller, 'string')
  assert.ok(lastCaller.length > 0, 'a connection has a caller id')
  await settle(b)
  assert.equal(b.frames.filter((f) => f.event === 'teller.told').length, 0, 'the other connection hears nothing')
  assert.ok(!JSON.stringify(a.frames).includes(lastCaller), 'the caller id is never on the wire')

  // b's own request reaches b, under its own id.
  const aCaller = lastCaller
  assert.equal((await b.request('teller.tell', { text: 'me' })).ok, true)
  assert.deepEqual((await b.event('teller.told')).payload, { text: 'me' })
  assert.notEqual(lastCaller, aCaller)

  // a closes: its caller is disconnected, and a later emitTo to it throws nothing and reaches no one.
  await new Promise((done) => {
    a.ws.addEventListener('close', done)
    a.ws.close()
  })
  const before = b.frames.length
  // The server's close handler may run just after the client sees the close: give it a turn of the loop.
  await new Promise((done) => setImmediate(done))
  host.emitTo(aCaller, 'teller.told', { text: 'late' })
  await settle(b)
  assert.equal(b.frames.slice(before).filter((f) => f.event === 'teller.told').length, 0)
})
