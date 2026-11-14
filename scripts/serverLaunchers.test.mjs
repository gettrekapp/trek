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

test('the batch launcher has no for /f, and no parenthesis outside quotes or a rem on a command line', () => {
  // `for /f … in ('"node" -p "parseInt(…)"')` ended at that ")": the zip's launcher failed to parse.
  assert.doesNotMatch(WIN_LAUNCHER, /\bfor\s+\/f\b/i)
  for (const line of WIN_LAUNCHER.split('\r\n')) {
    if (/^(rem |echo )/.test(line)) continue
    const outside = line.replace(/"[^"]*"/g, '')
    assert.doesNotMatch(outside, /[()]/, line)
  }
})

test('the batch launcher: node checks its own version, 42 is too old, anything else is not found', () => {
  assert.match(WIN_LAUNCHER, /"%node%" -e "process\.exit\(parseInt\(process\.versions\.node\)>=22\?0:42\)" 2>nul\r\nif errorlevel 43 goto missing\r\nif errorlevel 42 goto old\r\nif errorlevel 1 goto missing\r\n/)
  assert.match(WIN_LAUNCHER, /:missing\r\necho trek-server: Node\.js 22 or later is needed, and "%node%" was not found .*1>&2\r\nexit \/b 127\r\n/)
  assert.match(WIN_LAUNCHER, /:old\r\n.*Node\.js 22 or later is needed; .* is version .*\r\nexit \/b 1\r\n/)
  assert.match(WIN_LAUNCHER, /"%node%" "%~dp0\.\.\\trek-server\.cjs" %\*\r\nexit \/b %errorlevel%\r\n/)
})
