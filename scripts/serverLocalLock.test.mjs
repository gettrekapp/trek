// scripts/serverLocalLock.test.mjs — the local server's pid lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, holdsLock, lockDecision, pidAlive, readLockPid, releaseLock } from '../server/src/localLock.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-lock-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const alive = () => true
const dead = () => false

test('lockDecision: a live holder refuses; a dead, missing or own pid is taken over', () => {
  assert.equal(lockDecision(10, 20, alive), 'refuse')
  assert.equal(lockDecision(10, 20, dead), 'take')
  assert.equal(lockDecision(undefined, 20, alive), 'take')
  assert.equal(lockDecision(20, 20, alive), 'take')
})

test('pidAlive: this process is, an exited child is not', () => {
  assert.equal(pidAlive(process.pid), true)
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.equal(pidAlive(child.pid), false)
})

test('acquireLock creates a 0700 directory and a 0600 lock holding the pid, with no temp file left', (t) => {
  const dir = join(tempDir(t), 'profile')
  const path = join(dir, 'local.lock')
  assert.deepEqual(acquireLock(path, 100, alive), { ok: true })
  assert.equal(readFileSync(path, 'utf8'), '100\n')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(dir), ['local.lock'])
  assert.equal(readLockPid(path), 100)
  assert.equal(holdsLock(path, 100), true)
})

test('a live holder refuses a second start and keeps its lock', (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.deepEqual(acquireLock(path, 200, alive), { ok: false, holder: 100 })
  assert.equal(readLockPid(path), 100)
  assert.deepEqual(readdirSync(join(path, '..')), ['local.lock'])
})

test("a dead holder's lock is taken over and the dead pid reported", (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.deepEqual(acquireLock(path, 200, (pid) => pid !== 100), { ok: true, tookOver: 100 })
  assert.equal(readLockPid(path), 200)
})

test('a lock holding no pid is taken over', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, 'garbage')
  assert.deepEqual(acquireLock(path, 200, alive), { ok: true })
  assert.equal(readLockPid(path), 200)
})

test('releaseLock removes only its own lock', (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.equal(releaseLock(path, 200), false)
  assert.equal(holdsLock(path, 200), false)
  assert.equal(readLockPid(path), 100)
  assert.equal(releaseLock(path, 100), true)
  assert.equal(readLockPid(path), undefined)
  assert.equal(releaseLock(path, 100), false, 'a missing lock is not an error')
})
