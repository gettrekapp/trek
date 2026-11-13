// scripts/botLock.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBotLock } from '../src/host/bot/lock.ts'

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-lock-'))
  mkdirSync(join(dir, 'state'))
  return dir
}
const lockIn = (dir) => join(dir, 'state', 'lock')
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

/** A live process other than this one. */
function liveOther(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  return child.pid
}

test('acquires a free folder, recording the pid, and releases it', () => {
  const dir = folder()
  const lock = acquireBotLock(dir)
  assert.equal(lock.acquired, true)
  assert.equal(readFileSync(lockIn(dir), 'utf8'), String(process.pid))
  lock.release()
  assert.equal(existsSync(lockIn(dir)), false)
  lock.release()
})

test('a live holder keeps it, and its lock is left alone', (t) => {
  const dir = folder()
  const pid = liveOther(t)
  writeFileSync(lockIn(dir), String(pid))
  assert.deepEqual(acquireBotLock(dir), { acquired: false, pid })
  assert.equal(readFileSync(lockIn(dir), 'utf8'), String(pid))
})

test('a dead holder is taken over, with nothing left behind', () => {
  const dir = folder()
  writeFileSync(lockIn(dir), String(deadPid()))
  const lock = acquireBotLock(dir)
  assert.equal(lock.acquired, true)
  assert.equal(readFileSync(lockIn(dir), 'utf8'), String(process.pid))
  assert.deepEqual(readdirSync(join(dir, 'state')), ['lock'])
})

test("this process's own pid is stale: callers check their own bots first, and a moved folder brings its lock along", () => {
  const dir = folder()
  writeFileSync(lockIn(dir), String(process.pid))
  assert.equal(acquireBotLock(dir).acquired, true)
})

test('an unreadable lock counts as held while new, in case its owner is still writing it', () => {
  const dir = folder()
  writeFileSync(lockIn(dir), '')
  assert.deepEqual(acquireBotLock(dir), { acquired: false, pid: null })
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockIn(dir), old, old)
  assert.equal(acquireBotLock(dir).acquired, true)
})

test('release leaves a lock that has since become someone else\'s', (t) => {
  const dir = folder()
  const lock = acquireBotLock(dir)
  const pid = liveOther(t)
  writeFileSync(lockIn(dir), String(pid))
  lock.release()
  assert.equal(readFileSync(lockIn(dir), 'utf8'), String(pid))
})

test('release survives the folder having gone', () => {
  const dir = folder()
  const lock = acquireBotLock(dir)
  rmSync(dir, { recursive: true, force: true })
  lock.release()
})

test('a missing state folder is an error, not a free lock', () => {
  assert.throws(() => acquireBotLock(mkdtempSync(join(tmpdir(), 'bot-lock-'))), /ENOENT/)
})
