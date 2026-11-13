// scripts/serverLocalLock.test.mjs — the local server's pid lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOT_MARGIN_MS,
  acquireLock,
  beforeBoot,
  holdsLock,
  lockDecision,
  pidAlive,
  readLock,
  readLockPid,
  releaseLock,
  removeStaleTemps
} from '../server/src/localLock.ts'
import { lockText, parseLockText } from '../src/shared/localServer.ts'
import { posixOnly } from './testPlatform.mjs'

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
  assert.equal(lockDecision(10, 20, alive, true), 'take', 'a lock from an earlier boot, whatever its pid')
})

test('pidAlive: this process is, an exited child is not', () => {
  assert.equal(pidAlive(process.pid), true)
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.equal(pidAlive(child.pid), false)
})

test("pidAlive: another user's process (EPERM) is alive", { skip: process.getuid?.() === 0 ? 'running as root' : posixOnly('another user\'s process (EPERM)') }, () => {
  // launchd / init is pid 1 and is root's: signal 0 fails with EPERM.
  assert.equal(pidAlive(1), true)
})

test('acquireLock creates a 0700 directory and a 0600 lock holding the pid, with no temp file left', (t) => {
  const dir = join(tempDir(t), 'profile')
  const path = join(dir, 'local.lock')
  assert.deepEqual(acquireLock(path, 100, alive), { ok: true })
  assert.match(readFileSync(path, 'utf8'), /^100\n[0-9a-f]{32}\n$/, 'the pid, then a nonce')
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

test('a lock holding garbage around digits is not a pid', (t) => {
  const path = join(tempDir(t), 'local.lock')
  for (const text of ['12abc', '1.5', '-3', '0x10', '1e3', ' ', '']) {
    writeFileSync(path, text)
    assert.equal(readLockPid(path), undefined, JSON.stringify(text))
  }
  writeFileSync(path, ' 42 \n')
  assert.equal(readLockPid(path), 42)
  for (const text of ['42\nxyz', '42\n' + 'a'.repeat(31), '42\n' + 'A'.repeat(32), '42\n' + 'a'.repeat(32) + '\nmore']) {
    writeFileSync(path, text)
    assert.equal(readLockPid(path), undefined, JSON.stringify(text))
  }
})

test('the lock text: the pid and a nonce; an older server\'s lock (the pid alone) still reads', (t) => {
  const nonce = '0123456789abcdef0123456789abcdef'
  assert.deepEqual(parseLockText(lockText(4242, nonce)), { pid: 4242, nonce })
  assert.deepEqual(parseLockText('4242\n'), { pid: 4242, nonce: undefined })
  assert.deepEqual(parseLockText(`4242\r\n${nonce}\r\n`), { pid: 4242, nonce })
  assert.equal(parseLockText('0\n'), undefined)
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '4242\n')
  assert.equal(readLock(path).pid, 4242)
  assert.equal(readLock(path).nonce, undefined)
  // Two starts write different nonces.
  const dir = tempDir(t)
  acquireLock(join(dir, 'x.lock'), 1, alive)
  acquireLock(join(dir, 'y.lock'), 1, alive)
  assert.notEqual(readLock(join(dir, 'x.lock')).nonce, readLock(join(dir, 'y.lock')).nonce)
})

test('acquireLock keeps the profile directory 0700 even if it already existed looser', (t) => {
  const dir = join(tempDir(t), 'profile')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  assert.deepEqual(acquireLock(join(dir, 'local.lock'), 100, alive), { ok: true })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('a lock holding our own pid is taken over (a dead process had it before us)', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '100\n')
  assert.deepEqual(acquireLock(path, 100, alive), { ok: true, tookOver: 100 })
  assert.equal(readLockPid(path), 100)
})

test('two starts taking over the same stale lock: only one wins, and the loser has nothing', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '100\n')
  let inner
  // Start 300's liveness check runs start 200 to completion in the middle of it:
  // 200 takes the stale lock over while 300 is still judging the old one.
  const aliveFor300 = (pid) => {
    if (pid === 100 && inner === undefined) inner = acquireLock(path, 200, (p) => p !== 100)
    return pid === 200
  }
  const outer = acquireLock(path, 300, aliveFor300)
  assert.deepEqual(inner, { ok: true, tookOver: 100 })
  assert.deepEqual(outer, { ok: false, holder: 200 })
  assert.equal(holdsLock(path, 200), true)
  assert.equal(holdsLock(path, 300), false)
  assert.deepEqual(readdirSync(join(path, '..')), ['local.lock'], 'no temp file is left')
})

// ext4 and overlayfs give a new file a just-deleted file's inode at once, with the same coarse
// ctime: the re-read below reports the replacement with the stale lock's dev, ino and ctime,
// as such a filesystem would. Only the nonce tells them apart (the pid is the same too: the
// stale lock is from before the last boot, and its pid now belongs to the start that replaced it).
for (const [what, stale] of [['a lock with a nonce', lockText(100, 'f'.repeat(32))], ["an older server's lock", '100\n']]) {
  test(`a start that replaced the stale lock keeps it on a filesystem that reuses inodes (${what})`, (t) => {
    const path = join(tempDir(t), 'local.lock')
    writeFileSync(path, stale)
    const now = Date.now()
    const clock = { now: () => now, uptime: () => 600 }
    utimesSync(path, new Date(now - 3600_000), new Date(now - 3600_000))
    const judged = readLock(path)
    let inner
    const reread = (p) => {
      // Between start 300's judging and its unlink, start 100 takes the stale lock over.
      if (inner === undefined) inner = acquireLock(p, 100, alive, clock)
      const found = readLock(p)
      return found && { ...found, dev: judged.dev, ino: judged.ino, ctimeMs: judged.ctimeMs }
    }
    const outer = acquireLock(path, 300, (pid) => pid === 100, clock, reread)
    assert.deepEqual(inner, { ok: true, tookOver: 100 })
    assert.deepEqual(outer, { ok: false, holder: 100 })
    assert.equal(holdsLock(path, 100), true)
    assert.deepEqual(readdirSync(join(path, '..')), ['local.lock'], 'no temp file is left')
  })
}

test('a lock from before the last boot is taken over even if its pid is alive', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '100\n')
  const now = Date.now()
  // Booted 10 minutes ago; the lock is from an hour ago.
  const clock = { now: () => now, uptime: () => 600 }
  utimesSync(path, new Date(now - 3600_000), new Date(now - 3600_000))
  assert.deepEqual(acquireLock(path, 200, alive, clock), { ok: true, tookOver: 100 })
  assert.equal(readLockPid(path), 200)
})

test('a lock from this boot with a live pid still refuses', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '100\n')
  const now = Date.now()
  utimesSync(path, new Date(now - 300_000), new Date(now - 300_000))
  // Booted 10 minutes ago; the lock is 5 minutes old.
  assert.deepEqual(acquireLock(path, 200, alive, { now: () => now, uptime: () => 600 }), { ok: false, holder: 100 })
})

test('beforeBoot: older than the boot time by more than the margin', () => {
  const now = 1_000_000_000_000
  const clock = { now: () => now, uptime: () => 600 }
  const boot = now - 600_000
  assert.equal(beforeBoot(boot - BOOT_MARGIN_MS - 1, clock), true)
  assert.equal(beforeBoot(boot - BOOT_MARGIN_MS + 1, clock), false, 'within the margin: the pid check decides')
  assert.equal(beforeBoot(boot + 1000, clock), false)
  assert.equal(beforeBoot(now, clock), false)
})

test('a lock that is a directory throws, and the directory is left', (t) => {
  const path = join(tempDir(t), 'local.lock')
  mkdirSync(path)
  assert.throws(() => acquireLock(path, 200, alive), (err) => ['EPERM', 'EISDIR', 'EACCES'].includes(err.code))
  assert.equal(statSync(path).isDirectory(), true)
  assert.deepEqual(readdirSync(join(path, '..')), ['local.lock'], 'no temp file is left')
})

test('a lock that is a symlink is not followed: it holds no pid and is replaced, its target untouched', (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'target')
  writeFileSync(target, '100\n')
  const path = join(dir, 'local.lock')
  symlinkSync(target, path)
  assert.equal(readLockPid(path), undefined)
  assert.equal(holdsLock(path, 100), false)
  assert.deepEqual(acquireLock(path, 200, alive), { ok: true })
  assert.equal(lstatSync(path).isSymbolicLink(), false)
  assert.equal(readLockPid(path), 200)
  assert.equal(readFileSync(target, 'utf8'), '100\n')
})

test('running out of retries reports no holder, or only a live one', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, '100\n')
  // Every liveness check finds the lock replaced by another stale one.
  let next = 1000
  const racing = () => {
    rmSync(path)
    writeFileSync(path, `${next++}\n`)
    return false
  }
  assert.deepEqual(acquireLock(path, 200, racing), { ok: false, holder: 0 })
  writeFileSync(path, '100\n')
  let calls = 0
  // The same, but the last lock's pid is alive when the start gives up.
  const racingThenLive = (pid) => {
    if (++calls > 3) return true
    rmSync(path)
    writeFileSync(path, `${pid + 1}\n`)
    return false
  }
  assert.deepEqual(acquireLock(path, 200, racingThenLive), { ok: false, holder: 103 })
  assert.equal(readLockPid(path), 103)
})

test('removeStaleTemps removes dead pids\' temp files of the given names only', (t) => {
  const dir = tempDir(t)
  for (const name of ['local.lock.10.tmp', 'local.json.11.tmp', 'local.lock.12.tmp', 'config.json.10.tmp', 'local.lock', 'local.lock.x.tmp']) {
    writeFileSync(join(dir, name), '')
  }
  const removed = removeStaleTemps(dir, ['local.lock', 'local.json'], (pid) => pid === 12)
  assert.deepEqual(removed.sort(), ['local.json.11.tmp', 'local.lock.10.tmp'])
  assert.deepEqual(readdirSync(dir).sort(), ['config.json.10.tmp', 'local.lock', 'local.lock.12.tmp', 'local.lock.x.tmp'])
  assert.deepEqual(removeStaleTemps(join(dir, 'missing'), ['local.lock']), [])
  assert.equal(existsSync(join(dir, 'local.lock')), true)
})
