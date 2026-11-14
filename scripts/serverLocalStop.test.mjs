// scripts/serverLocalStop.test.mjs — `trek-server stop --local`: which pid it may signal, and the stop itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localProfile } from '../server/src/localProfile.ts'
import { stopDecision, stopLocal } from '../server/src/localStop.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

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
  assert.deepEqual(stopDecision(info(10), 20, (pid) => pid === 10), { action: 'not-running', stale: 20 })
})

test('stopDecision: no lock, but local.json names a live pid, is lockless (never signalled)', () => {
  assert.deepEqual(stopDecision(info(10), undefined, alive), { action: 'lockless', pid: 10 })
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
  t.after(() => removeDir(dir))
  // The profile's own APPDATA: on Windows the config dir is %APPDATA%\trek-server, whatever `home`
  // is, so without it every test here (and a developer's real Local server) shares one local.lock.
  return localProfile(join(dir, 'home'), join(dir, 'data'), undefined, process.platform, { ...process.env, APPDATA: join(dir, 'home', 'AppData', 'Roaming') })
}

/**
 * A stand-in local server: writes the lock and local.json, and removes them on SIGTERM or an IPC
 * 'stop' (a real server's server.stop; Windows has no SIGTERM handlers) (unless `ignoreTerm`). Ready once local.json is there and parses: its SIGTERM handler is set before
 * either file is written, and local.json is written last, whole (a rename), so a stop under load
 * never sees a half-written file or a server that a SIGTERM would still kill.
 */
async function fakeServer(t, profile, { ignoreTerm = false } = {}) {
  const code = `
    const fs = require('node:fs')
    const stop = () => {
      if (${ignoreTerm}) return
      fs.rmSync(${JSON.stringify(profile.infoPath)})
      setTimeout(() => { fs.rmSync(${JSON.stringify(profile.lockPath)}); process.exit(0) }, 100)
    }
    process.on('SIGTERM', stop)
    process.on('message', stop)
    fs.mkdirSync(${JSON.stringify(profile.dir)}, { recursive: true })
    fs.writeFileSync(${JSON.stringify(profile.lockPath)}, process.pid + '\\n')
    const tmp = ${JSON.stringify(profile.infoPath)} + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ port: 4000, pid: process.pid, token: ${JSON.stringify(TOKEN)}, version: '0.2.0', build: 'abc123def456' }))
    fs.renameSync(tmp, ${JSON.stringify(profile.infoPath)})
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise((resolve) => child.on('exit', (c, s) => resolve(c ?? s)))
  t.after(() => child.kill('SIGKILL'))
  const ready = () => {
    try {
      return JSON.parse(readFileSync(profile.infoPath, 'utf8')).pid === child.pid && existsSync(profile.lockPath)
    } catch {
      return false
    }
  }
  const deadline = Date.now() + 30_000
  while (!ready()) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('the stand-in server did not write local.json')
    await new Promise((r) => setTimeout(r, 20))
  }
  return { child, exited }
}

const capture = () => {
  const lines = []
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(`E: ${l}`) }
}

/** The stand-in servers never listen: a stop request finds nobody. */
const unreachable = () => 'unreachable'
/**
 * For a test whose files name this process and that expects no stop: a wrong decision then fails
 * the test, where the defaults would ask a real port and (on Windows) end this process's tree.
 */
const neverStops = {
  requestStop: () => assert.fail('asked a server to stop'),
  forceKill: (pid) => assert.fail(`ended the process tree of pid ${pid}`)
}

test('stopLocal: asks the server named by local.json to stop, with its port and token, and never signals it', async (t) => {
  const profile = setup(t)
  const { child, exited } = await fakeServer(t, profile)
  const out = capture()
  const asked = []
  const kills = []
  // The stand-in shuts down on a message, as a real server does on server.stop.
  const requestStop = (i) => {
    asked.push(i)
    child.send('stop')
    return 'accepted'
  }
  assert.equal(stopLocal(profile, { ...out, requestStop, kill: (...a) => kills.push(a) }), 0)
  assert.equal(await exited, 0)
  assert.deepEqual(asked.map((i) => [i.port, i.pid, i.token]), [[4000, child.pid, TOKEN]])
  assert.deepEqual(kills, [])
  assert.deepEqual(out.lines, [`Stopping the local trek-server (pid ${child.pid})…`, 'Stopped.'])
})

test('stopLocal: a server that does not take the request is SIGTERMed and waited for', { skip: posixOnly('SIGTERM (Windows ends the process tree instead, below)') }, async (t) => {
  const profile = setup(t)
  const { child, exited } = await fakeServer(t, profile)
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, requestStop: unreachable }), 0)
  assert.equal(await exited, 0)
  assert.equal(existsSync(profile.infoPath) || existsSync(profile.lockPath), false)
  assert.deepEqual(out.lines, [
    'The local trek-server did not take a stop request (unreachable); sending SIGTERM.',
    `Stopping the local trek-server (pid ${child.pid})…`,
    'Stopped.'
  ])
})

test('stopLocal on Windows: no signal; once the wait runs out, the process tree is ended', async (t) => {
  const profile = setup(t)
  const { child, exited } = await fakeServer(t, profile, { ignoreTerm: true })
  const out = capture()
  const kills = []
  const forced = []
  const code = stopLocal(profile, {
    ...out,
    timeoutMs: 200,
    platform: 'win32',
    // A killed child stays a zombie until this (blocked) thread reaps it: gone once it was ended.
    alive: () => forced.length === 0,
    requestStop: () => 'refused',
    kill: (...a) => kills.push(a),
    forceKill: (pid) => {
      forced.push(pid)
      child.kill('SIGKILL')
    }
  })
  await exited
  assert.equal(code, 0)
  assert.deepEqual(kills, [])
  assert.deepEqual(forced, [child.pid])
  assert.deepEqual(out.lines, [
    'The local trek-server did not take a stop request (refused).',
    `Stopping the local trek-server (pid ${child.pid})…`,
    'It did not stop within 0.2 s; ending its process tree.',
    `Stopped, but it left files in ${profile.dir}; the next start cleans them up.`
  ])
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
  assert.equal(stopLocal(profile, { ...out, ...neverStops, kill: (pid, sig) => kills.push([pid, sig]) }), 1)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], /^E: .*is held by pid \d+, but .* does not name it/)
  assert.equal(existsSync(profile.lockPath), true, 'the lock is left alone')
})

test('stopLocal: a live pid named by local.json with no lock is exit 1, never signalled', (t) => {
  const profile = setup(t)
  mkdirSync(profile.dir, { recursive: true })
  writeFileSync(profile.infoPath, JSON.stringify(info(process.pid)))
  const kills = []
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, ...neverStops, kill: (pid, sig) => kills.push([pid, sig]) }), 1)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], new RegExp(`^E: .*names pid ${process.pid}, which is running, but there is no .*local\\.lock: a local trek-server is running without its lock`))
  assert.equal(existsSync(profile.infoPath), true, 'local.json is left alone')
})

test('stopLocal: an unverified lock holder says it may still be starting or stopping', (t) => {
  const profile = setup(t)
  mkdirSync(profile.dir, { recursive: true })
  writeFileSync(profile.lockPath, `${process.pid}\n`)
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, ...neverStops, kill: () => {} }), 1)
  assert.match(out.lines[0], /may still be starting or stopping/)
})

test('stopLocal: a server that ignores SIGTERM times out with exit 1', { skip: posixOnly('SIGTERM (Windows ends the process tree instead)') }, async (t) => {
  const profile = setup(t)
  const { child } = await fakeServer(t, profile, { ignoreTerm: true })
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, timeoutMs: 300, requestStop: unreachable }), 1)
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
  const code = stopLocal(profile, { ...out, ...neverStops, clock: { now: () => now, uptime: () => 600 }, kill: (pid, sig) => kills.push([pid, sig]) })
  assert.equal(code, 0)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], new RegExp(`^No local trek-server is running \\(pid ${process.pid} is gone`))
})
