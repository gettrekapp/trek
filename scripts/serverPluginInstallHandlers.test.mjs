// scripts/serverPluginInstallHandlers.test.mjs — installing plugins over the protocol (theme
// plugins phase 1): the config switch and the capability, plugins.install / remove / bundle, and,
// on a real server on a loopback port, the welcome's entries and who hears a change.
import test from 'node:test'
import assert from 'node:assert/strict'
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

/** The context the plugin install handlers read: the store, the switch, and a fetch that serves `pages`. */
function installCtx(t, { remoteInstall = true, pages = {} } = {}) {
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
  return { dir, store, asked, ctx: { installed: { store, remoteInstall: () => remoteInstall, fetch } } }
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

test('a server with no installed plugins store answers NOT_FOUND to all three', async () => {
  for (const [method, params] of [['plugins.install', { package: packageText() }], ['plugins.remove', { id: 'x' }], ['plugins.bundle', { id: 'x' }]]) {
    const outcome = await dispatchV2(method, params, {})
    assert.deepEqual([outcome.ok, outcome.error.code], [false, 'NOT_FOUND'], method)
  }
})

const WAIT_MS = 10_000

/** A server with a token and the built-in plugins, on a port the OS picks; nothing outside its temp folder is read or written. */
async function server(t, config = {}) {
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
    { sweepStaleMoves: false, plugins: { list: BUILTIN_SERVER_PLUGINS, secretsFile: join(dir, 'secrets.json'), dataDir: dir, env: {} } }
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
  const connect = async () => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const frames = []
    const waiters = new Set()
    ws.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)))
      for (const wake of waiters) wake()
    })
    const frame = (pred, what) =>
      new Promise((done, reject) => {
        const look = () => {
          const found = frames.find(pred)
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
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'test', clientVersion: '0', token }))
    const welcome = await frame((f) => f.type === 'welcome', 'welcome')
    const event = (name, pred = () => true) => frame((f) => f.type === 'event' && f.event === name && pred(f.payload), name)
    return { frames, request, welcome, event }
  }
  return { dir, connect }
}

test('on the wire: the welcome lists installed plugins after the built-ins, and every connection hears an install and a removal', async (t) => {
  const s = await server(t)
  const a = await s.connect()
  const b = await s.connect()
  assert.ok(a.welcome.capabilities.includes('pluginInstall'))
  const builtIns = a.welcome.plugins.map((p) => p.id)
  assert.ok(builtIns.includes('voice') && !builtIns.includes('solarized'))

  const res = await a.request('plugins.install', { package: packageText() })
  assert.equal(res.ok, true, JSON.stringify(res))
  const listed = (await b.event('plugins.list', (p) => p.plugins.some((x) => x.id === 'solarized'))).payload.plugins
  assert.deepEqual(listed.map((p) => p.id), [...builtIns, 'solarized'], 'built-ins first')
  assert.deepEqual(listed.at(-1), res.result)
  await b.event('plugins.changed', (p) => p.id === 'solarized')
  await a.event('plugins.list', (p) => p.plugins.some((x) => x.id === 'solarized'))

  const late = await s.connect()
  assert.deepEqual(late.welcome.plugins.at(-1), res.result, 'a later welcome lists it')
  const bundle = await late.request('plugins.bundle', { id: 'solarized' })
  assert.deepEqual(bundle.result, { sha256: res.result.sha256, client: 'export default {}' })

  assert.equal((await late.request('plugins.remove', { id: 'solarized' })).ok, true)
  const after = (await a.event('plugins.list', (p) => !p.plugins.some((x) => x.id === 'solarized') && a.frames.some((f) => f.event === 'plugins.changed'))).payload.plugins
  assert.deepEqual(after.map((p) => p.id), builtIns)
})

test('on the wire: a plugin added in the folder by another process reaches the connected clients', async (t) => {
  const s = await server(t)
  const a = await s.connect()
  const other = createInstalledPlugins({ dir: join(s.dir, 'plugins-installed'), reserved: () => false, warn: () => {} })
  other.add(JSON.parse(packageText({ id: 'nord', name: 'Nord', defaultEnabled: false })))
  const listed = (await a.event('plugins.list', (p) => p.plugins.some((x) => x.id === 'nord'))).payload.plugins
  assert.equal(listed.at(-1).name, 'Nord')
})

test('on the wire: remoteInstall off drops the capability', async (t) => {
  const s = await server(t, { plugins: { remoteInstall: false } })
  const a = await s.connect()
  assert.ok(!a.welcome.capabilities.includes('pluginInstall'))
  assert.equal((await a.request('plugins.install', { package: packageText() })).error.code, 'NOT_FOUND')
})
