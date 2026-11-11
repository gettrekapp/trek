// scripts/serverNativePty.test.mjs — node-pty's load error, explained (server/src/sessions/nativePty.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { explainPtyLoadError, loadNodePty } from '../server/src/sessions/nativePty.ts'

const nodePtyError = new Error("Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/darwin-arm64: Error: Cannot find module './prebuilds/darwin-arm64//pty.node'")
const prebuilt = '/Users/me/Downloads/trek-server-0.2.0-darwin-arm64/node_modules/node-pty/prebuilds/darwin-arm64/pty.node'
const gatekeeper = `dlopen(${prebuilt}, 0x0001): tried: '${prebuilt}' (code signature in <333B> '${prebuilt}' not valid for use in process: library load disallowed by system policy)`

test('a quarantined pty.node on macOS: the real dlopen error and the xattr command for the unpacked folder', () => {
  const message = explainPtyLoadError(nodePtyError, [{ path: prebuilt, error: gatekeeper }], 'darwin')
  assert.match(message, /^node-pty \(the native terminal module trek-server needs\) did not load: Failed to load native module/)
  assert.ok(message.includes(`${prebuilt}: ${gatekeeper}`), 'the error from the file that exists, not node-pty\'s last one')
  assert.match(message, /macOS refused to load it/)
  assert.ok(message.includes("  xattr -dr com.apple.quarantine '/Users/me/Downloads/trek-server-0.2.0-darwin-arm64'\n"), message)
})

test('the folder is quoted for the shell, a single quote included', () => {
  const path = "/Users/me/it's here/trek-server/node_modules/node-pty/build/Release/pty.node"
  const message = explainPtyLoadError(nodePtyError, [{ path, error: 'library load disallowed by system policy' }], 'darwin')
  assert.ok(message.includes(`xattr -dr com.apple.quarantine '/Users/me/it'\\''s here/trek-server'`), message)
})

test('no Gatekeeper hint for another failure, or off macOS', () => {
  const abi = [{ path: prebuilt, error: 'dlopen(...): mach-o file, but is an incompatible architecture' }]
  assert.doesNotMatch(explainPtyLoadError(nodePtyError, abi, 'darwin'), /xattr/)
  const linux = [{ path: '/srv/trek-server/node_modules/node-pty/build/Release/pty.node', error: 'code signature whatever' }]
  assert.doesNotMatch(explainPtyLoadError(nodePtyError, linux, 'linux'), /xattr/)
})

test('no pty.node at all says so', () => {
  assert.match(explainPtyLoadError(nodePtyError, [], 'linux'), /No pty\.node was found for this platform/)
})

test('loadNodePty loads the repo\'s node-pty, once', () => {
  const pty = loadNodePty()
  assert.equal(typeof pty.spawn, 'function')
  assert.equal(loadNodePty(), pty)
})
