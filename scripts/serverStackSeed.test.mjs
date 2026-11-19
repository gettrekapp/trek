// scripts/serverStackSeed.test.mjs — the Local server takes over the app's dev stack files once (5a's upgrade; the environments registry is the env plugin's since plugins E2, scripts/colimaSeed.test.mjs).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { seedStacksFromApp } from '../server/src/integrations/stackSeed.ts'
import { createStackService } from '../src/host/stackService.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

// Windows has no POSIX file modes (stat reports 0666): the 0600 checks are POSIX only.
const posix = process.platform !== 'win32'

function dirs(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-env-seed-')))
  t.after(() => removeDir(root))
  const app = join(root, 'Trek Dev')
  const data = join(root, 'data', 'local')
  mkdirSync(join(app, 'stacks'), { recursive: true })
  return { app, data }
}

const entry = (over = {}) => ({ repoPath: '/Users/me/app', branch: 'feature-x', worktreePath: '/Users/me/app-feature-x', composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z', ...over })

test("copies the app's stack files into the data dir once (a marker says so), and leaves the app's as they were", (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-feature-x-1a2b3c': entry() }))
  // A live pid (this test's own): a dead one is left out (below).
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), String(process.pid))
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  writeFileSync(join(app, 'stacks', 'notes.txt'), 'not a stack file')
  assert.deepEqual(seedStacksFromApp(app, data), { seeded: true, stackFiles: 2, skipped: [] })
  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.pid'), 'utf8'), String(process.pid))
  // The log is the same file (a hard link): a `stack.sh up` still writing to it shows in the new place.
  assert.equal(statSync(join(data, 'stacks', 'app-feature-x.log')).ino, statSync(join(app, 'stacks', 'app-feature-x.log')).ino)
  assert.equal(existsSync(join(data, 'stacks', 'notes.txt')), false)
  assert.equal(existsSync(join(data, 'environments.json')), false, "the environments registry is the env plugin's now")
  writeFileSync(join(app, 'stacks', 'later.log'), 'x')
  assert.deepEqual(seedStacksFromApp(app, data), { seeded: false, stackFiles: 0, skipped: [] }, 'once')
  assert.equal(existsSync(join(data, 'stacks', 'later.log')), false)
})

test("a data dir that took over before E2 (its environments.json, 5a's marker) never takes the app's stacks again: it gets the marker", (t) => {
  const { app, data } = dirs(t)
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'environments.json'), '{}')
  // A months-old pid file: its pid may be another process's by now.
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), String(process.pid))
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  assert.deepEqual(seedStacksFromApp(app, data), { seeded: false, stackFiles: 0, skipped: [] })
  assert.equal(existsSync(join(data, 'stacks')), false)
  assert.equal(existsSync(join(data, 'stacks.seeded')), true)
  if (posix) assert.equal(statSync(join(data, 'stacks.seeded')).mode & 0o777, 0o600)
  assert.deepEqual(seedStacksFromApp(app, data), { seeded: false, stackFiles: 0, skipped: [] })
})

test('stack files: only regular files, a live pid as the stack service writes it, nothing already there replaced', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'stacks', 'a.pid'), ` ${process.pid}\n`)
  writeFileSync(join(app, 'stacks', 'b.pid'), 'not a pid')
  // A pid no process has (the stack ended while the app was closed): left out, so a reused pid is never Ctrl-C'd.
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(join(app, 'stacks', 'd.pid'), String(dead))
  writeFileSync(join(app, 'secret'), 'outside')
  symlinkSync(join(app, 'secret'), join(app, 'stacks', 'c.log'))
  const result = seedStacksFromApp(app, data)
  assert.equal(result.stackFiles, 1)
  assert.equal(readFileSync(join(data, 'stacks', 'a.pid'), 'utf8'), String(process.pid), "String(pid): the stack service's pid compare reads it")
  if (posix) assert.equal(statSync(join(data, 'stacks', 'a.pid')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(data, 'stacks', 'b.pid')), false)
  assert.equal(existsSync(join(data, 'stacks', 'c.log')), false)
  assert.equal(existsSync(join(data, 'stacks', 'd.pid')), false)
  assert.equal(result.skipped.length, 3, result.skipped.join('\n'))
  assert.ok(result.skipped.includes(`d.pid: no process ${dead}`), result.skipped.join('\n'))
  // The copy is the server's own file: a write to it never reaches the app's.
  writeFileSync(join(data, 'stacks', 'a.pid'), '9999')
  assert.equal(readFileSync(join(app, 'stacks', 'a.pid'), 'utf8'), ` ${process.pid}\n`)
})

test('a log that cannot be hard-linked (another volume) is copied instead', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  const realLink = fs.linkSync
  mock.method(fs, 'linkSync', (from, to) => {
    if (String(to).includes(`${sep}stacks${sep}`)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    return realLink(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = seedStacksFromApp(app, data)
  assert.deepEqual([result.seeded, result.stackFiles, result.skipped], [true, 1, []])
  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.log'), 'utf8'), '$ stack.sh up\n')
  assert.notEqual(statSync(join(data, 'stacks', 'app-feature-x.log')).ino, statSync(join(app, 'stacks', 'app-feature-x.log')).ino, 'a copy')
})

test("the stack service runs on what the seed took over: the app's running up counts, its log shows, and down stops it", { skip: posixOnly('dev stacks: a stack.sh in its own process group, Ctrl-C by SIGINT (no stacks on a Windows server)') }, async (t) => {
  const { app, data } = dirs(t)
  const root = join(app, '..')
  // Stubs first on PATH: `docker ps` (the status's container count) lists nothing; no real docker runs.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  const savedRegistry = process.env.TREK_STACK_REGISTRY
  process.env.PATH = `${bin}:${savedPath}`
  process.env.TREK_STACK_REGISTRY = join(root, 'stack-registry')
  t.after(() => {
    process.env.PATH = savedPath
    if (savedRegistry === undefined) delete process.env.TREK_STACK_REGISTRY
    else process.env.TREK_STACK_REGISTRY = savedRegistry
  })
  const ws = join(root, 'app-feature-x')
  mkdirSync(join(ws, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(ws, 'docker', 'stack', 'stack.sh'), '#!/bin/bash\necho "stub stack.sh $*"\n', { mode: 0o755 })

  // The app's `stack.sh up`, as main ran it before 5a: detached (its own process group), writing to the app's log.
  const appLog = join(app, 'stacks', 'app-feature-x.log')
  writeFileSync(appLog, '$ stack.sh up\n')
  const fd = openSync(appLog, 'a')
  const up = spawn('sleep', ['300'], { detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const pid = up.pid
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone
    }
  })
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), String(pid))

  assert.equal(seedStacksFromApp(app, data).stackFiles, 2)
  const stacks = createStackService({ stateDir: join(data, 'stacks') })
  const status = await stacks.status(ws)
  assert.deepEqual([status.slug, status.upRunning], ['app-feature-x', true])
  appendFileSync(appLog, 'restoring the database (the old app is still logging)\n')
  const chunk = await stacks.log(ws, 0, 0)
  assert.match(chunk.text, /\$ stack\.sh up\nrestoring the database \(the old app is still logging\)\n/)

  const exited = new Promise((resolve) => up.once('exit', (code, signal) => resolve(signal)))
  assert.equal(await stacks.down(ws), 0)
  assert.equal(await exited, 'SIGINT', "down Ctrl-C'd the app's up process group")
  assert.equal((await stacks.status(ws)).upRunning, false)
  // Only the log is shared, and both sides only append: the server's down shows in the app's file too.
  assert.match(readFileSync(appLog, 'utf8'), /\$ stack\.sh down\nstub stack\.sh down\n/)
})
