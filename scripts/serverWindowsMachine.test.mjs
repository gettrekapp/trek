// scripts/serverWindowsMachine.test.mjs — a Windows server has docker, but no environments or dev
// stacks yet (W3): their methods answer TOOL_ERROR `unsupported` and the welcome leaves them out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { machineHandlersFor, WINDOWS_UNSUPPORTED_PREFIXES } from '../server/src/integrations/machineHandlers.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'

test('win32: every env.* and stack.* method refuses as unsupported, docker.* is kept', () => {
  const win = machineHandlersFor('win32')
  const mac = machineHandlersFor('darwin')
  const gated = Object.keys(win).filter((m) => WINDOWS_UNSUPPORTED_PREFIXES.some((p) => m.startsWith(p)))
  assert.ok(gated.includes('env.up') && gated.includes('stack.up') && gated.length >= 13)
  for (const method of gated) {
    assert.throws(() => win[method]({}, {}), (err) => err.code === 'TOOL_ERROR' && err.details.reason === 'unsupported' && /not yet supported on Windows/.test(err.message), method)
  }
  assert.equal(win['docker.list'], mac['docker.list'])
})

test('win32: the welcome has no env or stacks capability; elsewhere it has both', () => {
  const win = welcomeCapabilities(true, false, false, [], 'win32')
  assert.equal(win.includes('env') || win.includes('stacks'), false)
  assert.ok(win.includes('docker'))
  // The plugins' legacy capabilities don't bring them back.
  const withPlugins = welcomeCapabilities(true, false, false, ['voice'], 'win32')
  assert.equal(withPlugins.includes('env') || withPlugins.includes('stacks'), false)
  assert.ok(withPlugins.includes('voice'))
  const linux = welcomeCapabilities(true, false, false, [], 'linux')
  assert.ok(linux.includes('env') && linux.includes('stacks'))
})
