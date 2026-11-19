// scripts/serverPluginRun.test.mjs — host.run and host.testCommand (plugins P3): a plugin runs a
// program with no shell, a timeout, an output cap and an abort; a test stub is taken only as an
// absolute path. Runs only `node` (this process's binary) and temp scripts it writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandFromEnv, runCommand, spawnCommand } from '../server/src/plugins/run.ts'
import { realPath } from '../src/host/pathContainment.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const node = process.execPath

test('runCommand: stdout on exit 0; the first stderr line on a failure; ENOENT for a missing program', async () => {
  assert.equal(await runCommand(node, ['-e', 'process.stdout.write("hi")']), 'hi')
  await assert.rejects(runCommand(node, ['-e', 'console.error("\\nbad thing\\nmore"); process.exit(3)']), (e) => e.message === 'bad thing')
  // No stderr: the exit code, never the arguments (they may hold a query or a token).
  await assert.rejects(runCommand(node, ['-e', 'process.exit(3) // SECRET-ARG']), (e) => e.message === `${node} exited with 3` && !e.message.includes('SECRET-ARG'))
  await assert.rejects(runCommand('/no/such/program-trek', []), (e) => e.code === 'ENOENT')
})

test('runCommand: a child that dies of its own signal is not a timeout', { skip: posixOnly('POSIX signals') }, async () => {
  await assert.rejects(runCommand(node, ['-e', 'process.kill(process.pid, "SIGKILL")']), (e) => e.message === `${node} exited with SIGKILL`)
})

test('runCommand: refuses a relative path; a bare name is looked up on PATH', async () => {
  await assert.rejects(runCommand('./x', []), /bare name or an absolute path/)
  await assert.rejects(runCommand('bin/x', []), /bare name or an absolute path/)
  assert.equal(await runCommand('node', ['-e', 'process.stdout.write("ok")']), 'ok')
})

test('runCommand: a timeout and an output past maxBytes fail; an abort kills the child; no message holds the arguments', async () => {
  const quiet = (e) => !e.message.includes('SECRET-ARG')
  await assert.rejects(runCommand(node, ['-e', 'setTimeout(() => {}, 10000) // SECRET-ARG'], { timeoutMs: 200 }), (e) => e.message === `${node} timed out after 0.2 s` && quiet(e))
  await assert.rejects(runCommand(node, ['-e', 'process.stdout.write("x".repeat(5000)) // SECRET-ARG'], { maxBytes: 1000 }), (e) => e.message === `${node}'s output passed the limit` && quiet(e))
  const ac = new AbortController()
  const running = runCommand(node, ['-e', 'setTimeout(() => {}, 10000) // SECRET-ARG'], { signal: ac.signal })
  ac.abort()
  await assert.rejects(running, (e) => e.code === 'ABORT_ERR' && e.message === `${node} was stopped` && quiet(e))
})

test('runCommand: a signal already aborted rejects without starting the program', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(runCommand('/no/such/program-trek', [], { signal: ac.signal }), (e) => e.code === 'ABORT_ERR' && e.message === '/no/such/program-trek was stopped')
})

test('runCommand on Windows: a bare x.mjs is not run through node (it would be relative to the cwd)', async () => {
  // Not Windows' PATH here either: commandPath finds no x.mjs (.exe/.com only) and says ENOENT.
  await assert.rejects(runCommand('x.mjs', [], { platform: 'win32' }), (e) => e.code === 'ENOENT')
})

test('runCommand: env is added to this process\'s env', async () => {
  assert.equal(await runCommand(node, ['-e', 'process.stdout.write(process.env.TREK_RUN_TEST)'], { env: { TREK_RUN_TEST: 'yes' } }), 'yes')
})

test('runCommand: a plugin\'s env cannot set PATH (any case), so it cannot change which program runs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-run-path-'))
  t.after(() => removeDir(dir))
  // A `node` on the plugin's PATH that would be found first if that PATH were used.
  const fake = join(dir, 'node')
  writeFileSync(fake, '#!/bin/sh\necho HIJACKED\n')
  chmodSync(fake, 0o755)
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const out = await runCommand('node', ['-e', `process.stdout.write(String(process.env[${JSON.stringify(pathKey)}]) + "|" + process.env.TREK_RUN_TEST)`], {
    env: { PATH: dir, Path: dir, path: dir, TREK_RUN_TEST: 'kept' }
  })
  assert.equal(out, `${process.env[pathKey]}|kept`)
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

/** A temp directory (its real path, as a child's process.cwd() says it), removed after the test. */
function tempDir(t) {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-spawn-')))
  t.after(() => removeDir(dir))
  return dir
}

test('spawnCommand (plugins E1): stdout and stderr stream as they come; done has the exit code', async (t) => {
  const dir = tempDir(t)
  const out = { stdout: '', stderr: '' }
  const child = await spawnCommand(node, ['-e', 'process.stdout.write("a"); process.stderr.write("b"); process.exit(3)'], { cwd: dir, onOutput: (stream, chunk) => { out[stream] += chunk } })
  assert.equal(typeof child.pid, 'number')
  assert.deepEqual(await child.done, { code: 3, signal: null })
  assert.deepEqual(out, { stdout: 'a', stderr: 'b' })
})

test("spawnCommand: in the cwd, with the env added and the server's own PATH", async (t) => {
  const dir = tempDir(t)
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  let text = ''
  const child = await spawnCommand(node, ['-e', `process.stdout.write(process.cwd() + "|" + process.env.TREK_SPAWN_TEST + "|" + process.env[${JSON.stringify(pathKey)}])`], {
    cwd: dir,
    env: { TREK_SPAWN_TEST: 'yes', PATH: '/nowhere', Path: '/nowhere' },
    onOutput: (_stream, chunk) => { text += chunk }
  })
  await child.done
  assert.equal(text, `${dir}|yes|${process.env[pathKey]}`)
})

test('spawnCommand: refuses a relative command, a non-string argument, onOutput with detached, an aborted signal; ENOENT for a missing program', async (t) => {
  const dir = tempDir(t)
  await assert.rejects(spawnCommand('./x', [], { cwd: dir }), /bare name or an absolute path/)
  await assert.rejects(spawnCommand(node, [1], { cwd: dir }), /every argument must be a string/)
  await assert.rejects(spawnCommand(node, [], { cwd: dir, detached: true, onOutput: () => {} }), /detached/)
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(spawnCommand(node, [], { cwd: dir, signal: ac.signal }), (e) => e.code === 'ABORT_ERR')
  await assert.rejects(spawnCommand('/no/such/program-trek', [], { cwd: dir }), (e) => e.code === 'ENOENT')
})

test('spawnCommand: kill() and an abort end it', async (t) => {
  const dir = tempDir(t)
  const ended = (end) => end.code !== 0 || end.signal !== null
  const killed = await spawnCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir })
  killed.kill()
  assert.ok(ended(await killed.done))
  const ac = new AbortController()
  const aborted = await spawnCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, signal: ac.signal })
  ac.abort()
  assert.ok(ended(await aborted.done))
})

test('spawnCommand on Windows: a .mjs stub runs with this binary and ELECTRON_RUN_AS_NODE=1', async (t) => {
  const dir = tempDir(t)
  const stub = join(dir, 'tool.mjs')
  writeFileSync(stub, 'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.ELECTRON_RUN_AS_NODE]))\n')
  let text = ''
  const child = await spawnCommand(stub, ['a b'], { cwd: dir, platform: 'win32', onOutput: (_s, chunk) => { text += chunk } })
  await child.done
  assert.equal(text, JSON.stringify([['a b'], '1']))
})
