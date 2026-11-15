// scripts/serverPluginInstallHandlers.test.mjs — installing plugins over the protocol (theme
// plugins phase 1): the config switch and the capability, plugins.install / remove / bundle, and,
// on a real server on a loopback port, the welcome's entries and who hears a change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDir } from './testPlatform.mjs'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { createInstalledPlugins } from '../server/src/plugins/installed.ts'
import { installedIdReserved } from '../server/src/plugins/reserved.ts'
import { dispatchV2 } from '../server/src/v2.ts'

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
  const store = createInstalledPlugins({ dir: join(root, 'plugins-installed'), reserved: installedIdReserved([{ manifest: { id: 'voice' } }]), warn: () => {} })
  const fetch = async (url) => (pages[url] === undefined ? new Response('', { status: 404 }) : new Response(pages[url]))
  return { store, ctx: { installed: { store, remoteInstall: () => remoteInstall, fetch } } }
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
  const { store, ctx } = installCtx(t)
  const code = async (method, params) => {
    const outcome = await dispatchV2(method, params, ctx)
    return outcome.ok ? 'ok' : `${outcome.error.code}: ${outcome.error.message}`
  }
  assert.match(await code('plugins.install', {}), /^BAD_REQUEST: .*url or package/)
  assert.match(await code('plugins.install', { url: 'https://a.test/x', package: packageText() }), /^BAD_REQUEST: .*url or package/)
  assert.match(await code('plugins.install', { package: 5 }), /^BAD_REQUEST/)
  assert.match(await code('plugins.install', { package: '{' }), /^BAD_REQUEST: .*not JSON/)
  assert.match(await code('plugins.install', { package: packageText({ type: 'feature' }) }), /^BAD_REQUEST: .*type must be "theme"/)
  assert.match(await code('plugins.install', { package: packageText({ id: 'voice' }) }), /^BAD_REQUEST: .*built-in plugin/)
  assert.match(await code('plugins.install', { url: 'http://a.test/x' }), /^BAD_REQUEST: .*https/)
  assert.match(await code('plugins.install', { url: 'https://a.test/missing' }), /^BAD_REQUEST: .*HTTP 404/)
  assert.match(await code('plugins.remove', { id: 'nope' }), /^NOT_FOUND/)
  assert.match(await code('plugins.remove', {}), /^BAD_REQUEST/)
  assert.match(await code('plugins.bundle', { id: 'nope' }), /^NOT_FOUND/)
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
