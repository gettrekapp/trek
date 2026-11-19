// scripts/serverPluginRun.test.mjs — host.run and host.testCommand (plugins P3): a plugin runs a
// program with no shell, a timeout, an output cap and an abort; a test stub is taken only as an
// absolute path. Runs only `node` (this process's binary) and temp scripts it writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandFromEnv, runCommand } from '../server/src/plugins/run.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const node = process.execPath

test('runCommand: stdout on exit 0; the first stderr line on a failure; ENOENT for a missing program', async () => {
  assert.equal(await runCommand(node, ['-e', 'process.stdout.write("hi")']), 'hi')
  await assert.rejects(runCommand(node, ['-e', 'console.error("bad thing\\nmore"); process.exit(3)']), (e) => e.message === 'bad thing')
  await assert.rejects(runCommand('/no/such/program-trek', []), (e) => e.code === 'ENOENT')
})

test('runCommand: refuses a relative path; a bare name is looked up on PATH', async () => {
  await assert.rejects(runCommand('./x', []), /bare name or an absolute path/)
  await assert.rejects(runCommand('bin/x', []), /bare name or an absolute path/)
  assert.equal(await runCommand('node', ['-e', 'process.stdout.write("ok")']), 'ok')
})

test('runCommand: a timeout and an output past maxBytes fail; an abort kills the child', async () => {
  await assert.rejects(runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }))
  await assert.rejects(runCommand(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBytes: 1000 }))
  const ac = new AbortController()
  const running = runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { signal: ac.signal })
  ac.abort()
  await assert.rejects(running)
})

test('runCommand: env is added to this process\'s env', async () => {
  assert.equal(await runCommand(node, ['-e', 'process.stdout.write(process.env.TREK_RUN_TEST)'], { env: { TREK_RUN_TEST: 'yes' } }), 'yes')
})

test('runCommand on Windows: a .mjs stub runs with this binary and ELECTRON_RUN_AS_NODE=1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-run-'))
  t.after(() => removeDir(dir))
  const stub = join(dir, 'tool.mjs')
  writeFileSync(stub, 'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.ELECTRON_RUN_AS_NODE]))\n')
  assert.equal(await runCommand(stub, ['a b'], { platform: 'win32' }), JSON.stringify([['a b'], '1']))
})

test('runCommand elsewhere: an executable stub runs as it is', { skip: posixOnly('an executable with a shebang') }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-run-'))
  t.after(() => removeDir(dir))
  const stub = join(dir, 'tool.js')
  writeFileSync(stub, '#!/bin/sh\necho direct\n')
  chmodSync(stub, 0o755)
  assert.equal((await runCommand(stub, [], { platform: 'darwin' })).trim(), 'direct')
})

test('commandFromEnv: the fallback when unset, an absolute path as it is, anything else null (warned)', () => {
  const warnings = []
  const warn = (m) => warnings.push(m)
  assert.equal(commandFromEnv('TREK_SERVER_GH', undefined, 'gh', warn), 'gh')
  assert.equal(commandFromEnv('TREK_SERVER_GH', '/tmp/stub/gh', 'gh', warn), '/tmp/stub/gh')
  for (const v of ['', 'gh', './gh', 'stub/gh']) assert.equal(commandFromEnv('TREK_SERVER_GH', v, 'gh', warn), null, v)
  assert.equal(warnings.length, 4)
})
