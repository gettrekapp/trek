// scripts/serverUpdateLock.test.mjs — the lock that keeps updates of one install apart: a live
// update keeps it; one left behind (a dead process, or older than any update takes) is taken
// over, and of any number of updaters that try at once exactly one gets it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LEFTOVER_PREFIX, LOCK_FILE, LOCK_STALE_MS, takeLock } from '../server/src/update/lock.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

// rename() puts a folder in an empty folder's place on POSIX only; Windows has no self-update.
const posix = { skip: posixOnly('the lock is taken by renaming a folder into place, and Windows has no self-update') }
const temp = () => mkdtempSync(join(tmpdir(), 'trek-lock-'))
/** A pid that cannot be alive. */
const DEAD = 2147483646
/** A lock left at `path` by an update with process id `pid`, `ageMs` ago. */
function held(path, pid, ageMs = 0, name = `${pid}-0123456789ab`) {
  mkdirSync(path, { recursive: true })
  const file = join(path, name)
  writeFileSync(file, typeof pid === 'number' ? `${pid}\n` : pid)
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs)
    utimesSync(file, then, then)
  }
  return file
}

test('the lock is a folder beside the install, and is stale after half an hour', () => {
  assert.equal(LOCK_FILE, '.trek-update.lock')
  assert.equal(LOCK_STALE_MS, 30 * 60 * 1000)
  assert.ok(!LOCK_FILE.startsWith(LEFTOVER_PREFIX), 'a sweep of leftovers never takes the lock')
})

test('taking and releasing: one holder at a time, and nothing left behind', posix, () => {
  const dir = temp()
  try {
    const path = join(dir, LOCK_FILE)
    const first = takeLock(path)
    assert.ok(first)
    const [holder] = readdirSync(path)
    assert.match(holder, new RegExp(`^${process.pid}-[0-9a-f]{12}$`))
    assert.equal(readFileSync(join(path, holder), 'utf8'), `${process.pid}\n`)
    assert.equal(takeLock(path), null, 'held by a live process (this one)')
    assert.deepEqual(readdirSync(dir), [LOCK_FILE], 'the attempt that lost left nothing')
    first.release()
    assert.deepEqual(readdirSync(dir), [])
    assert.doesNotThrow(() => first.release(), 'released twice')
    const second = takeLock(path)
    assert.ok(second)
    second.release()
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    removeDir(dir)
  }
})

test('a fresh lock of a live process is refused; a dead holder, an old one and garbage are taken over', posix, () => {
  const dir = temp()
  try {
    const path = join(dir, LOCK_FILE)
    const live = held(path, process.pid)
    assert.equal(takeLock(path), null)
    assert.equal(existsSync(live), true, 'the holder keeps its lock')
    // Just inside the bound: still its holder's.
    held(path, process.pid, LOCK_STALE_MS - 60_000)
    assert.equal(takeLock(path), null)
    removeDir(path)

    // After a reboot the process id is some other live process's: only the lock's age says so.
    const old = held(path, process.pid, LOCK_STALE_MS + 60_000)
    const afterReboot = takeLock(path)
    assert.ok(afterReboot, 'a lock older than any update takes is taken over, whoever has its process id now')
    assert.equal(existsSync(old), false)
    afterReboot.release()

    for (const content of [DEAD, '', 'not a pid', '-1', '0', '12.5']) {
      held(path, content, 0, 'left')
      const lock = takeLock(path)
      assert.ok(lock, `a lock holding ${JSON.stringify(content)}`)
      assert.equal(readdirSync(path).length, 1, 'only the new holder is in it')
      lock.release()
      assert.deepEqual(readdirSync(dir), [])
    }

    // An empty lock folder (its holder is between two steps, or died there) is free.
    mkdirSync(path)
    const empty = takeLock(path)
    assert.ok(empty)
    empty.release()
  } finally {
    removeDir(dir)
  }
})

test('a holder that was taken over releases nothing that is not its own', posix, () => {
  const dir = temp()
  try {
    const path = join(dir, LOCK_FILE)
    let clock = Date.now()
    const slow = takeLock(path, { now: () => clock })
    assert.ok(slow)
    // Later than any update takes: the next updater takes the lock over.
    clock += LOCK_STALE_MS + 60_000
    const next = takeLock(path, { now: () => clock })
    assert.ok(next)
    slow.release()
    assert.equal(readdirSync(path).length, 1, 'the new holder still has it')
    assert.equal(takeLock(path), null)
    next.release()
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    removeDir(dir)
  }
})

test('something that is not a folder at the lock path is an error that names it', posix, () => {
  const dir = temp()
  try {
    const path = join(dir, LOCK_FILE)
    writeFileSync(path, String(process.pid))
    assert.throws(() => takeLock(path), /\.trek-update\.lock is not a folder.*remove it/)
    assert.deepEqual(readdirSync(dir), [LOCK_FILE], 'and nothing else is left')
  } finally {
    removeDir(dir)
  }
})

/**
 * `count` Node processes that each try to take the lock at `path` at the same moment. Resolves
 * with how many got it. Each keeps running (and so keeps its lock) until all have answered: a
 * winner that exited would leave a dead holder's lock, which the next may rightly take.
 */
async function race(path, count) {
  const at = Date.now() + 600
  const source = `
    import { takeLock } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'server', 'src', 'update', 'lock.ts')).href)}
    while (Date.now() < ${at}) {}
    let got = 'error'
    try {
      got = takeLock(${JSON.stringify(path)}) ? 'won' : 'lost'
    } catch (err) {
      got = 'error ' + err.message
    }
    process.stdout.write(got + '\\n')
    process.stdin.resume()
    process.stdin.on('end', () => process.exit(0))
  `
  const children = Array.from({ length: count }, () => spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'inherit'] }))
  try {
    const answers = await Promise.all(children.map((child) => new Promise((resolve) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stdout.on('end', () => resolve(out.trim()))
      child.stdout.on('data', () => { if (out.includes('\n')) resolve(out.trim()) })
    })))
    return answers
  } finally {
    await Promise.all(children.map((child) => new Promise((resolve) => {
      child.on('close', resolve)
      child.stdin.end()
    })))
  }
}

test('several updaters at once over a stale lock, or none: exactly one takes it, every round', posix, async () => {
  const dir = temp()
  try {
    const ROUNDS = 12
    for (let round = 0; round < ROUNDS; round++) {
      const path = join(dir, `round-${round}`, LOCK_FILE)
      mkdirSync(join(dir, `round-${round}`))
      // In turn: a dead holder's lock, one whose process id is alive but which is too old, no lock at all.
      if (round % 3 === 0) held(path, DEAD)
      else if (round % 3 === 1) held(path, process.pid, LOCK_STALE_MS + 60_000)
      const answers = await race(path, 6)
      assert.deepEqual(answers.filter((a) => a !== 'won' && a !== 'lost'), [], `round ${round}`)
      assert.equal(answers.filter((a) => a === 'won').length, 1, `round ${round}: ${answers.join(' ')}`)
      assert.equal(readdirSync(path).length, 1, `round ${round}: one holder's file`)
    }
  } finally {
    removeDir(dir)
  }
})
