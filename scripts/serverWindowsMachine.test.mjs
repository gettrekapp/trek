// scripts/serverWindowsMachine.test.mjs — a Windows server has docker, but no dev stacks yet (W3) and
// no Colima environments (the env plugin is for macOS and Linux, plugins E2): stack.* answers
// TOOL_ERROR `unsupported`, env.* is no method there, and the welcome leaves out both capabilities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machineHandlersFor, WINDOWS_UNSUPPORTED_PREFIXES } from '../server/src/integrations/machineHandlers.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { removeDir } from './testPlatform.mjs'

function builtins(t, platform) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-win-plugins-'))
  t.after(() => removeDir(dir))
  const registry = createPluginRegistry({
    plugins: BUILTIN_SERVER_PLUGINS,
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub: { emit: () => 0, eventSubscriberCount: () => 0 },
    projects: { require: () => { throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' }) }, all: () => [] },
    isCoreMethod,
    coreToolNames: [],
    platform,
    warn: () => {}
  })
  t.after(() => registry.dispose())
  return registry
}

test('win32: every stack.* method refuses as unsupported, docker.* is kept, and core has no env.* on any platform', () => {
  const win = machineHandlersFor('win32')
  const mac = machineHandlersFor('darwin')
  assert.deepEqual(WINDOWS_UNSUPPORTED_PREFIXES, ['stack.'])
  const gated = Object.keys(win).filter((m) => m.startsWith('stack.'))
  assert.ok(gated.includes('stack.up') && gated.length >= 5)
  for (const method of gated) {
    assert.throws(() => win[method]({}, {}), (err) => err.code === 'TOOL_ERROR' && err.details.reason === 'unsupported' && /Dev stacks are not yet supported on Windows/.test(err.message), method)
  }
  assert.equal(win['docker.list'], mac['docker.list'])
  assert.deepEqual([...Object.keys(win), ...Object.keys(mac)].filter((m) => m.startsWith('env.')), [])
})

test('win32: the env plugin is listed as not available, never set up: env.* is no method and the welcome has no env', async (t) => {
  const registry = builtins(t, 'win32')
  assert.deepEqual(registry.presence().find((p) => p.id === 'env'), { id: 'env', version: '1.0.0', defaultEnabled: true, available: false })
  assert.equal(registry.handler('env.up'), undefined)
  assert.equal((await dispatchV2('env.up', {}, { plugins: registry })).error.code, 'NOT_FOUND')
  const win = welcomeCapabilities(true, false, false, registry.legacyCapabilities(), 'win32')
  assert.equal(win.includes('env') || win.includes('stacks'), false)
  assert.ok(win.includes('docker'))
})

test("elsewhere the env plugin's legacy capability is the welcome's env; stacks is core's", (t) => {
  const registry = builtins(t, 'linux')
  assert.deepEqual(registry.presence().find((p) => p.id === 'env'), { id: 'env', version: '1.0.0', defaultEnabled: true })
  const linux = welcomeCapabilities(true, false, false, registry.legacyCapabilities(), 'linux')
  assert.ok(linux.includes('env') && linux.includes('stacks'))
  const bare = welcomeCapabilities(true, false, false, [], 'linux')
  assert.deepEqual([bare.includes('env'), bare.includes('stacks')], [false, true])
})
