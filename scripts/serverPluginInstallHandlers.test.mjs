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
