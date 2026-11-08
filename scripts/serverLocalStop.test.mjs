// scripts/serverLocalStop.test.mjs — `trek-server stop --local`: which pid it may signal, and the stop itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localProfile } from '../server/src/localProfile.ts'
import { stopDecision, stopLocal } from '../server/src/localStop.ts'

const TOKEN = 'p3Xq9vK_2mZ-8sLwYt4bR7nH1cJ6fA0dE5gU'
const info = (pid) => ({ port: 4000, pid, token: TOKEN, version: '0.2.0', build: 'abc123def456' })
const alive = () => true
const dead = () => false

test('stopDecision: signal only a live pid that local.json names and the lock holds', () => {
  assert.deepEqual(stopDecision(info(10), 10, alive), { action: 'signal', pid: 10 })
})

test('stopDecision: no live lock holder is not running, naming a dead pid whose files are left', () => {
  assert.deepEqual(stopDecision(undefined, undefined, alive), { action: 'not-running' })
  assert.deepEqual(stopDecision(info(10), 10, dead), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(undefined, 10, dead), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(info(10), undefined, dead), { action: 'not-running', stale: 10 })
  // local.json names a live pid, but no lock holds it: a reused pid, never signalled.
  assert.deepEqual(stopDecision(info(10), undefined, alive), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(info(10), 20, (pid) => pid === 10), { action: 'not-running', stale: 20 })
})

test('stopDecision: a lock from an earlier boot is dead whatever its pid', () => {
  assert.deepEqual(stopDecision(info(10), 10, alive, true), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(undefined, 10, alive, true), { action: 'not-running', stale: 10 })
})

test('stopDecision: a live lock holder that local.json does not name is unverified', () => {
  assert.deepEqual(stopDecision(undefined, 10, alive), { action: 'unverified', pid: 10 })
  assert.deepEqual(stopDecision(info(20), 10, alive), { action: 'unverified', pid: 10 })
})

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-stop-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return localProfile(join(dir, 'home'), join(dir, 'data'))
}

/** A stand-in local server: writes the lock and local.json, and removes them on SIGTERM (unless `ignoreTerm`). */
async function fakeServer(t, profile, { ignoreTerm = false } = {}) {
  const code = `
    const fs = require('node:fs')
    fs.mkdirSync(${JSON.stringify(profile.dir)}, { recursive: true })
    fs.writeFileSync(${JSON.stringify(profile.lockPath)}, process.pid + '\\n')
    fs.writeFileSync(${JSON.stringify(profile.infoPath)}, JSON.stringify({ port: 4000, pid: process.pid, token: ${JSON.stringify(TOKEN)}, version: '0.2.0', build: 'abc123def456' }))
    process.on('SIGTERM', () => {
      if (${ignoreTerm}) return
      fs.rmSync(${JSON.stringify(profile.infoPath)})
      setTimeout(() => { fs.rmSync(${JSON.stringify(profile.lockPath)}); process.exit(0) }, 100)
    })
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  const exited = new Promise((resolve) => child.on('exit', (c, s) => resolve(c ?? s)))
  t.after(() => child.kill('SIGKILL'))
  const deadline = Date.now() + 5000
  while (!(existsSync(profile.infoPath) && existsSync(profile.lockPath)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  return { child, exited }
}

const capture = () => {
  const lines = []
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(`E: ${l}`) }
}

test('stopLocal: SIGTERMs the server and waits for local.json and the lock to go', async (t) => {
  const profile = setup(t)
  const { child, exited } = await fakeServer(t, profile)
  const out = capture()
  assert.equal(stopLocal(profile, out), 0)
  assert.equal(await exited, 0)
  assert.equal(existsSync(profile.infoPath) || existsSync(profile.lockPath), false)
  assert.deepEqual(out.lines, [`Stopping the local trek-server (pid ${child.pid})…`, 'Stopped.'])
})

test('stopLocal: nothing running is exit 0', (t) => {
  const profile = setup(t)
  const out = capture()
  assert.equal(stopLocal(profile, out), 0)
  assert.deepEqual(out.lines, ['No local trek-server is running.'])
})

test('stopLocal: an unverified lock holder is never signalled', (t) => {
  const profile = setup(t)
  // The lock holds this test's (live) pid, and there is no local.json.
  mkdirSync(profile.dir, { recursive: true })
  writeFileSync(profile.lockPath, `${process.pid}\n`)
  const kills = []
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, kill: (pid, sig) => kills.push([pid, sig]) }), 1)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], /^E: .*is held by pid \d+, but .* does not name it/)
  assert.equal(existsSync(profile.lockPath), true, 'the lock is left alone')
})

test('stopLocal: a server that ignores SIGTERM times out with exit 1', async (t) => {
  const profile = setup(t)
  const { child } = await fakeServer(t, profile, { ignoreTerm: true })
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, timeoutMs: 300 }), 1)
  assert.equal(out.lines.at(-1), `E: The local trek-server (pid ${child.pid}) did not stop within 0.3 s.`)
})

test('stopLocal: a lock and local.json from before the last boot are never signalled, even if the pid is alive', (t) => {
  const profile = setup(t)
  mkdirSync(profile.dir, { recursive: true })
  writeFileSync(profile.lockPath, `${process.pid}\n`)
  writeFileSync(profile.infoPath, JSON.stringify(info(process.pid)))
  const now = Date.now()
  utimesSync(profile.lockPath, new Date(now - 3600_000), new Date(now - 3600_000))
  const kills = []
  const out = capture()
  // Booted 10 minutes ago; the lock is an hour old.
  const code = stopLocal(profile, { ...out, clock: { now: () => now, uptime: () => 600 }, kill: (pid, sig) => kills.push([pid, sig]) })
  assert.equal(code, 0)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], new RegExp(`^No local trek-server is running \\(pid ${process.pid} is gone`))
})
