// scripts/serverLaunchers.test.mjs — the text of the Windows launchers in the trek-server zip.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WIN_LAUNCHER, WIN_PS_LAUNCHER } from './serverLaunchers.mjs'

test('the PowerShell launcher has CRLF line endings only', () => {
  assert.ok(WIN_PS_LAUNCHER.endsWith('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(WIN_PS_LAUNCHER), 'a bare LF')
  assert.ok(!/\r(?!\n)/.test(WIN_PS_LAUNCHER), 'a bare CR')
})

test('the PowerShell launcher checks for Node >= 22 with the .cmd launcher wording', () => {
  assert.match(WIN_PS_LAUNCHER, /\$major -lt 22/)
  assert.match(WIN_PS_LAUNCHER, /trek-server: Node\.js 22 or later is needed, and .*was not found \(set TREK_NODE to a node binary\)/)
  assert.match(WIN_PS_LAUNCHER, /trek-server: Node\.js 22 or later is needed; .* is version \$major/)
  assert.match(WIN_PS_LAUNCHER, /exit 127/)
  assert.match(WIN_LAUNCHER, /trek-server: Node\.js 22 or later is needed, and/)
})

test('the PowerShell launcher runs trek-server.cjs beside bin with the arguments and node\'s exit code', () => {
  assert.match(WIN_PS_LAUNCHER, /\$PSScriptRoot/)
  assert.match(WIN_PS_LAUNCHER, /\.\.\\trek-server\.cjs/)
  assert.match(WIN_PS_LAUNCHER, /& \$node .*@args/)
  assert.match(WIN_PS_LAUNCHER, /exit \$LASTEXITCODE\r\n$/)
})

test('the batch launcher keeps CRLF line endings', () => {
  assert.ok(!/(?<!\r)\n/.test(WIN_LAUNCHER))
})
