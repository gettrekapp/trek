// scripts/serverUpdateService.test.mjs — a running server's update state: what it reports, a check,
// an install asked for by a client with its progress, and each way it is refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDir } from './testPlatform.mjs'
import { MIN_CHECK_INTERVAL_MS, createUpdateService } from '../server/src/update/service.ts'
import { writeState } from '../server/src/update/state.ts'

const NOW = new Date('2026-11-14T10:00:00.000Z')

/** An install of 1.0.0 in a temp folder, and a service whose feed and installer are stand-ins. */
function world(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trek-update-service-'))
  const dir = join(root, 'opt', 'trek-server')
  const configDir = join(root, 'config')
  mkdirSync(dir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const setInstalled = (version) => writeFileSync(join(dir, 'build.json'), JSON.stringify({ version, build: 'b', package: 'tarball', target: 'linux-x64' }))
  setInstalled('1.0.0')
  const changes = []
  const relaunched = []
  const calls = { find: 0, apply: [] }
  /** The service's clock: NOW until a test moves it on. */
  let at = NOW.getTime()
  const clock = { advance: (ms) => { at += ms } }
  const deps = {
    install: { dir, parent: join(root, 'opt'), version: '1.0.0', build: 'b', target: 'linux-x64' },
    configDir,
    running: '1.0.0',
    sessions: () => 2,
    remoteApply: () => true,
    canRelaunch: () => true,
    relaunchRefusal: () => null,
    now: () => new Date(at),
    onChange: (status) => changes.push(status),
    relaunch: (version) => relaunched.push(version),
    find: async () => {
      calls.find++
      writeState(configDir, { lastCheckAt: NOW.toISOString(), latest: '2.0.0' })
      return { version: '2.0.0', file: 'trek-server-2.0.0-linux-x64.tar.gz', sha256: 'a'.repeat(64) }
    },
    apply: async ({ expect, onStep, onProgress }) => {
      calls.apply.push(expect.version)
      // The real installer does I/O before its first step: nothing happens in the caller's tick.
      await Promise.resolve()
      onStep('checking')
      onStep('downloading')
      onProgress(50, 200)
      onProgress(200, 200)
      onStep('unpacking')
      onStep('selfcheck')
      onStep('installing')
      setInstalled('2.0.0')
      return { kind: 'installed', from: '1.0.0', to: '2.0.0' }
    },
    ...over
  }
  return { root, dir, configDir, service: createUpdateService(deps), changes, relaunched, calls, clock, setInstalled, done: () => removeDir(root) }
}
const coded = (code, reason) => (err) => err.code === code && (reason === undefined || err.details?.reason === reason)
const settled = async (service) => { await service.idle() }

test('status: the running version, idle, and what the state file remembers', () => {
  const w = world()
  try {
    assert.deepEqual(w.service.status(), { current: '1.0.0', state: 'idle', sessions: 2, canRelaunch: true, restartNeeded: false, remoteApply: true })
    writeState(w.configDir, { lastCheckAt: '2026-11-14T09:00:00.000Z', latest: '2.0.0', lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:30:00.000Z', error: 'did not start' } })
    assert.deepEqual(w.service.status(), {
      current: '1.0.0', latest: '2.0.0', state: 'idle', sessions: 2, canRelaunch: true, restartNeeded: false, remoteApply: true,
      checkedAt: '2026-11-14T09:00:00.000Z',
      lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:30:00.000Z', error: 'did not start' }
    })
  } finally {
    w.done()
  }
})

test('status: a remembered latest that is not newer than the running version is not offered', () => {
  const w = world()
  try {
    writeState(w.configDir, { latest: '1.0.0' })
    assert.equal(w.service.status().latest, undefined)
    writeState(w.configDir, { latest: '0.9.0' })
    assert.equal(w.service.status().latest, undefined)
  } finally {
    w.done()
  }
})

test('status: a newer version in the install folder than the one running needs a restart', () => {
  const w = world()
  try {
    w.setInstalled('2.0.0')
    assert.equal(w.service.status().restartNeeded, true)
    writeFileSync(join(w.dir, 'build.json'), '{nope')
    assert.equal(w.service.status().restartNeeded, false, 'an unreadable build.json is not a pending restart')
  } finally {
    w.done()
  }
})

test('check: reads the feed once, passes through checking, and answers the new status', async () => {
  const w = world()
  try {
    const status = await w.service.check()
    assert.equal(status.latest, '2.0.0')
    assert.equal(status.state, 'idle')
    assert.equal(status.checkedAt, NOW.toISOString())
    assert.deepEqual(w.changes.map((s) => s.state), ['checking', 'idle'])
    assert.equal(w.calls.find, 1)
  } finally {
    w.done()
  }
})

test('check: two at once share one read; a feed that cannot be read rejects and leaves the state idle', async () => {
  const w = world()
  const broken = world({ find: async () => { throw new Error('could not read SHA256SUMS') } })
  try {
    const [a, b] = await Promise.all([w.service.check(), w.service.check()])
    assert.equal(w.calls.find, 1)
    assert.deepEqual(a, b)
    // `cause`: the reason alone, for the server's own log line.
    await assert.rejects(broken.service.check(), (err) => err.code === 'TOOL_ERROR' && /could not read SHA256SUMS/.test(err.message) && err.cause === 'could not read SHA256SUMS')
    assert.equal(broken.service.status().state, 'idle')
    assert.deepEqual(broken.changes.map((s) => s.state), ['checking', 'idle'])
  } finally {
    w.done()
    broken.done()
  }
})

test('apply: started at once; the states and the percent arrive as changes; then the server relaunches into it', async () => {
  const w = world()
  try {
    await w.service.check()
    w.changes.length = 0
    assert.deepEqual(w.service.apply('2.0.0'), { started: true })
    assert.equal(w.service.status().state, 'checking', 'begun before apply() returns')
    await settled(w.service)
    assert.deepEqual(w.calls.apply, ['2.0.0'], 'the installer is told which version the client was shown')
    assert.deepEqual(
      w.changes.map((s) => [s.state, s.percent]),
      [['checking', undefined], ['downloading', undefined], ['downloading', 25], ['downloading', 100], ['installing', undefined], ['restarting', undefined]]
    )
    assert.deepEqual(w.relaunched, ['2.0.0'])
    assert.equal(w.service.status().state, 'restarting', 'it stays restarting until the process is replaced')
  } finally {
    w.done()
  }
})

test('apply: where the server cannot restart itself, the install finishes and waits for a restart by hand', async () => {
  for (const over of [{ canRelaunch: () => false }, { relaunchRefusal: () => 'bin/trek-server is not executable' }]) {
    const w = world(over)
    try {
      await w.service.check()
      w.service.apply('2.0.0')
      await settled(w.service)
      assert.deepEqual(w.relaunched, [])
      const status = w.service.status()
      assert.deepEqual([status.state, status.restartNeeded], ['idle', true])
      assert.equal(w.changes.at(-1).restartNeeded, true)
    } finally {
      w.done()
    }
  }
})

test('apply: a failure returns to idle, and the result the installer recorded is in the status', async () => {
  const w = world({
    apply: async () => {
      writeState(w.configDir, { lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: NOW.toISOString(), error: 'trek-server 2.0.0 does not run on this machine' } })
      return { kind: 'failed', error: 'trek-server 2.0.0 does not run on this machine' }
    }
  })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    const status = w.service.status()
    assert.equal(status.state, 'idle')
    assert.equal(status.lastResult.ok, false)
    assert.match(status.lastResult.error, /does not run on this machine/)
    assert.deepEqual(w.relaunched, [])
    assert.equal(w.changes.at(-1).state, 'idle')
  } finally {
    w.done()
  }
})

test('apply: an installer that throws is a failure, not a stuck state', async () => {
  const w = world({ apply: async () => { throw new Error('boom') } })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.equal(w.service.status().state, 'idle')
  } finally {
    w.done()
  }
})

test('apply is refused: disabled in the config, already running, not the latest version, nothing newer', async () => {
  const disabled = world({ remoteApply: () => false })
  const w = world()
  try {
    assert.equal(disabled.service.status().remoteApply, false)
    assert.throws(() => disabled.service.apply('2.0.0'), coded('CONFLICT', 'disabled'))

    assert.throws(() => w.service.apply('2.0.0'), coded('CONFLICT', 'stale'), 'no check has found a newer release yet')
    await w.service.check()
    assert.throws(() => w.service.apply('2.0.1'), coded('CONFLICT', 'stale'))
    assert.throws(() => w.service.apply(''), coded('BAD_REQUEST'))
    assert.throws(() => w.service.apply(7), coded('BAD_REQUEST'))

    w.service.apply('2.0.0')
    assert.throws(() => w.service.apply('2.0.0'), coded('CONFLICT', 'busy'))
    await assert.rejects(w.service.check(), coded('CONFLICT', 'busy'), 'no check while an update runs')
    await settled(w.service)
    assert.throws(() => w.service.apply('2.0.0'), coded('CONFLICT', 'busy'), 'still restarting')
  } finally {
    disabled.done()
    w.done()
  }
})

test('a change listener that throws does not break an update', async () => {
  const w = world({ onChange: () => { throw new Error('a closed socket') } })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.deepEqual(w.relaunched, ['2.0.0'])
  } finally {
    w.done()
  }
})

test('status never throws: a state file that is not what it should be, or no state file at all', () => {
  const w = world()
  try {
    writeFileSync(join(w.configDir, 'update-state.json'), JSON.stringify({ latest: 7, lastCheckAt: {}, lastResult: 'nope' }))
    assert.deepEqual(w.service.status(), { current: '1.0.0', state: 'idle', sessions: 2, canRelaunch: true, restartNeeded: false, remoteApply: true })
    writeFileSync(join(w.configDir, 'update-state.json'), '{nope')
    assert.equal(w.service.status().state, 'idle')
    removeDir(w.configDir)
    removeDir(w.dir)
    assert.deepEqual(w.service.status(), { current: '1.0.0', state: 'idle', sessions: 2, canRelaunch: true, restartNeeded: false, remoteApply: true })
  } finally {
    w.done()
  }
})

test('status never throws: a dependency that does (the terminals, the config) reads as the careful answer', () => {
  const boom = () => { throw new Error('boom') }
  const w = world({ sessions: boom, remoteApply: boom, canRelaunch: boom })
  try {
    assert.deepEqual(w.service.status(), { current: '1.0.0', state: 'idle', sessions: 0, canRelaunch: false, restartNeeded: false, remoteApply: false })
  } finally {
    w.done()
  }
})

test('check: a feed read that throws at once (not a rejection) rejects the same way, and the state is idle', async () => {
  const w = world({ find: () => { throw new Error('no fetch here') } })
  try {
    await assert.rejects(w.service.check(), (err) => err.code === 'TOOL_ERROR' && /no fetch here/.test(err.message))
    assert.equal(w.service.status().state, 'idle')
    assert.deepEqual(w.changes.map((s) => s.state), ['checking', 'idle'])
  } finally {
    w.done()
  }
})

test('check: a change listener that throws does not break a check', async () => {
  const w = world({ onChange: () => { throw new Error('a closed socket') } })
  try {
    const status = await w.service.check()
    assert.deepEqual([status.state, status.latest], ['idle', '2.0.0'])
  } finally {
    w.done()
  }
})

test('apply: an installer that throws at once (not a rejection) is a failure, not a stuck state', async () => {
  const w = world({ apply: () => { throw new Error('boom') } })
  try {
    await w.service.check()
    w.changes.length = 0
    assert.deepEqual(w.service.apply('2.0.0'), { started: true })
    await settled(w.service)
    assert.equal(w.service.status().state, 'idle')
    assert.deepEqual(w.changes.map((s) => s.state), ['checking', 'idle'])
    assert.deepEqual(w.service.apply('2.0.0'), { started: true }, 'and another update can be asked for')
    await settled(w.service)
  } finally {
    w.done()
  }
})

test('apply: a restart that cannot be begun leaves the install waiting for one by hand, and the status says why', async () => {
  for (const over of [
    { relaunch: () => { throw new Error('no') } },
    { relaunchRefusal: () => { throw new Error('no') } },
    { canRelaunch: () => { throw new Error('no') } }
  ]) {
    const w = world(over)
    try {
      await w.service.check()
      w.service.apply('2.0.0')
      await settled(w.service)
      const last = w.changes.at(-1)
      assert.deepEqual([last.state, last.restartNeeded], ['idle', true])
      assert.equal(w.service.status().state, 'idle')
      // And why: clients that heard `restarting` (or expected it) are not left with a bare idle.
      assert.deepEqual(last.lastResult, { ok: false, from: '1.0.0', to: '2.0.0', at: NOW.toISOString(), error: 'trek-server 2.0.0 is installed, but the server could not restart into it: no' })
      assert.deepEqual(w.service.status().lastResult, last.lastResult)
    } finally {
      w.done()
    }
  }
})

test('apply: up to date after all (the command on the machine installed it meanwhile) returns to idle', async () => {
  const w = world({ apply: async () => ({ kind: 'up-to-date', current: '2.0.0' }) })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.equal(w.service.status().state, 'idle')
    assert.equal(w.changes.at(-1).state, 'idle')
    assert.deepEqual(w.relaunched, [])
  } finally {
    w.done()
  }
})

test('the percent: one change per whole percent however many chunks arrive, and none while the size is unknown', async () => {
  const total = 50_000
  const chunky = world({
    apply: async ({ onStep, onProgress }) => {
      await Promise.resolve()
      onProgress(10, total)
      onStep('downloading')
      for (let bytes = 1; bytes <= total; bytes++) onProgress(bytes, total)
      onStep('unpacking')
      onProgress(total, total)
      return { kind: 'failed', error: 'stop here' }
    }
  })
  const unknown = world({
    apply: async ({ onStep, onProgress }) => {
      await Promise.resolve()
      onStep('downloading')
      for (let bytes = 1; bytes <= 5000; bytes++) onProgress(bytes, undefined)
      onProgress(10, 0)
      onStep('unpacking')
      return { kind: 'failed', error: 'stop here' }
    }
  })
  try {
    await chunky.service.check()
    chunky.changes.length = 0
    chunky.service.apply('2.0.0')
    await settled(chunky.service)
    const downloading = chunky.changes.filter((s) => s.state === 'downloading')
    // The step itself, then 0 to 100.
    assert.equal(downloading.length, 102)
    assert.deepEqual(downloading.slice(0, 3).map((s) => s.percent), [undefined, 0, 1])
    assert.equal(downloading.at(-1).percent, 100)
    assert.equal(chunky.changes.length, 105, 'checking, the download, installing, idle')
    assert.equal(chunky.changes.some((s) => s.state !== 'downloading' && 'percent' in s), false, 'a percent only while downloading')

    await unknown.service.check()
    unknown.changes.length = 0
    unknown.service.apply('2.0.0')
    await settled(unknown.service)
    assert.deepEqual(unknown.changes.map((s) => [s.state, s.percent]), [['checking', undefined], ['downloading', undefined], ['installing', undefined], ['idle', undefined]])
  } finally {
    chunky.done()
    unknown.done()
  }
})

test('a check asked for while one runs, and an install asked for during a check, do not start a second read', async () => {
  let release
  const w = world({ find: () => new Promise((done) => { release = () => { writeState(w.configDir, { latest: '2.0.0' }); done(null) } }) })
  try {
    const first = w.service.check()
    assert.equal(w.service.status().state, 'checking')
    assert.throws(() => w.service.apply('2.0.0'), coded('CONFLICT', 'busy'))
    release()
    assert.equal((await first).latest, '2.0.0')
    assert.deepEqual(w.service.apply('2.0.0'), { started: true })
    await settled(w.service)
  } finally {
    w.done()
  }
})

const LOCKED = 'another update is running for /opt/trek-server: /opt/.trek-update.lock is its lock (a folder that holds that update\'s process id). If no update is running, remove it.'

test('apply: a failure the installer recorded nowhere (the lock is held) is in the status, with the version that was asked for', async () => {
  const w = world({ apply: async () => ({ kind: 'failed', error: LOCKED }) })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    const failure = { ok: false, from: '1.0.0', to: '2.0.0', at: NOW.toISOString(), error: LOCKED }
    assert.deepEqual(w.service.status().lastResult, failure)
    assert.deepEqual([w.changes.at(-1).state, w.changes.at(-1).lastResult], ['idle', failure], 'and in the change that ends the attempt')
    assert.equal(w.service.status().latest, '2.0.0', 'what is offered is still offered')
  } finally {
    w.done()
  }
})

test('apply: an installer that throws leaves its reason in the status too', async () => {
  const w = world({ apply: async () => { throw new Error('boom') } })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.deepEqual(w.service.status().lastResult, { ok: false, from: '1.0.0', to: '2.0.0', at: NOW.toISOString(), error: 'boom' })
  } finally {
    w.done()
  }
})

test('the failure kept in memory goes when a new attempt starts, and when a check succeeds', async () => {
  let fail = true
  const w = world({
    apply: async () => {
      await Promise.resolve()
      return fail ? { kind: 'failed', error: LOCKED } : { kind: 'up-to-date', current: '1.0.0' }
    }
  })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.equal(w.service.status().lastResult.error, LOCKED)
    // A new attempt: what the last one ended with is not said of this one.
    fail = false
    w.service.apply('2.0.0')
    assert.equal(w.service.status().lastResult, undefined)
    await settled(w.service)
    assert.equal(w.service.status().lastResult, undefined)
    // A check that succeeds (one that reads the feed: the last read is over half a minute old).
    fail = true
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.equal(w.service.status().lastResult.error, LOCKED)
    assert.equal((await w.service.check()).lastResult.error, LOCKED, 'a check answered from the last read settles nothing')
    w.clock.advance(MIN_CHECK_INTERVAL_MS)
    assert.equal((await w.service.check()).lastResult, undefined)
  } finally {
    w.done()
  }
})

test('one last result, never two that disagree: the installer\'s own record of this failure is the one reported', async () => {
  // The installer recorded it (with the version it found in the install folder): that record is the status's.
  const recorded = { ok: false, from: '1.0.1', to: '2.0.0', at: NOW.toISOString(), error: 'trek-server 2.0.0 does not run on this machine' }
  const w = world({
    apply: async () => {
      writeState(w.configDir, { lastResult: recorded })
      return { kind: 'failed', error: recorded.error }
    }
  })
  // An older failure is on record, and this attempt recorded nothing: the newer one, from memory.
  const old = { ok: false, from: '1.0.0', to: '1.5.0', at: '2026-11-01T00:00:00.000Z', error: 'trek-server 1.5.0 did not start; went back to 1.0.0' }
  const stale = world({ apply: async () => ({ kind: 'failed', error: LOCKED }) })
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    assert.deepEqual(w.service.status().lastResult, recorded)

    await stale.service.check()
    writeState(stale.configDir, { lastResult: old })
    stale.service.apply('2.0.0')
    await settled(stale.service)
    assert.equal(stale.service.status().lastResult.error, LOCKED)
    // `trek-server update` on the machine fails later and records it: the record is newer.
    const later = { ok: false, from: '1.0.0', to: '2.0.0', at: '2026-11-14T11:00:00.000Z', error: 'the download failed' }
    writeState(stale.configDir, { lastResult: later })
    assert.deepEqual(stale.service.status().lastResult, later)
  } finally {
    w.done()
    stale.done()
  }
})

test('apply is refused while the server is checking: it says so, not that an update is running', async () => {
  let release
  const w = world({ find: () => new Promise((done) => { release = () => done(null) }) })
  try {
    const first = w.service.check()
    assert.throws(() => w.service.apply('2.0.0'), (err) => err.code === 'CONFLICT' && err.details?.reason === 'busy' && err.message === 'This server is checking for an update: try again in a moment')
    release()
    await first
  } finally {
    w.done()
  }
})

test('check: the feed is read at most once per MIN_CHECK_INTERVAL_MS; a check asked sooner answers the status as it is, with no read and no change', async () => {
  let sessions = 2
  const w = world({ sessions: () => sessions })
  try {
    assert.equal(MIN_CHECK_INTERVAL_MS, 30_000)
    const first = await w.service.check()
    assert.equal(w.calls.find, 1)
    w.changes.length = 0
    // A client that asks in a loop: no request to the feed, no write, nothing sent to anyone.
    sessions = 3
    for (let n = 0; n < 50; n++) {
      w.clock.advance(100)
      assert.deepEqual(await w.service.check(), { ...first, sessions: 3 }, 'the status now, not a copy of the last answer')
    }
    assert.equal(w.calls.find, 1)
    assert.deepEqual(w.changes, [], 'no checking and idle to every client')
    w.clock.advance(MIN_CHECK_INTERVAL_MS - 5000 - 1)
    await w.service.check()
    assert.equal(w.calls.find, 1, 'one millisecond short of the interval')
    w.clock.advance(1)
    await w.service.check()
    assert.equal(w.calls.find, 2)
    assert.deepEqual(w.changes.map((s) => s.state), ['checking', 'idle'])
  } finally {
    w.done()
  }
})

test('check: after a read that failed, one asked sooner than the interval is refused with that same error, and the feed is not asked again', async () => {
  let broken = true
  const w = world({
    find: async () => {
      w.calls.find++
      if (broken) throw new Error('the feed answered 503')
      return null
    }
  })
  const same = (err) => err.code === 'TOOL_ERROR' && err.message === 'Could not check for an update: the feed answered 503' && err.cause === 'the feed answered 503'
  try {
    await assert.rejects(w.service.check(), same)
    w.changes.length = 0
    w.clock.advance(MIN_CHECK_INTERVAL_MS - 1)
    await assert.rejects(w.service.check(), same)
    assert.equal(w.calls.find, 1)
    assert.deepEqual(w.changes, [])
    // The interval over: a new read, which may succeed.
    broken = false
    w.clock.advance(1)
    assert.equal((await w.service.check()).state, 'idle')
    assert.equal(w.calls.find, 2)
    await w.service.check()
    assert.equal(w.calls.find, 2, 'and what is remembered now is that it was read')
  } finally {
    w.done()
  }
})

test('check: the interval is counted from when a read began, and one still running is shared, not repeated', async () => {
  let release
  const w = world({ find: () => { w.calls.find++; return new Promise((done) => { release = () => done(null) }) } })
  try {
    const first = w.service.check()
    w.clock.advance(MIN_CHECK_INTERVAL_MS + 1)
    const second = w.service.check()
    assert.equal(w.calls.find, 1)
    release()
    assert.deepEqual(await first, await second)
    // Over the interval since it began: the next one reads.
    const third = w.service.check()
    assert.equal(w.calls.find, 2)
    release()
    await third
  } finally {
    w.done()
  }
})

test('a check asked while an update runs is refused as busy, however recent the last read', async () => {
  const w = world()
  try {
    await w.service.check()
    w.service.apply('2.0.0')
    await assert.rejects(w.service.check(), coded('CONFLICT', 'busy'))
    await settled(w.service)
  } finally {
    w.done()
  }
})

test('a status never carries more of an error than its first 2,000 characters: a long one on record, or from this service\'s own attempt', async () => {
  const long = `it failed:\n${'z'.repeat(500_000)}`
  const w = world({ apply: async () => ({ kind: 'failed', error: long }) })
  try {
    // The state file is the user's to edit, and older servers wrote the whole output there.
    writeFileSync(join(w.configDir, 'update-state.json'), JSON.stringify({ lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: '2026-11-01T00:00:00.000Z', error: long } }))
    const onRecord = w.service.status().lastResult.error
    assert.ok(onRecord.length < 2100 && onRecord.startsWith(long.slice(0, 2000)) && /cut: the whole message is 500011 characters/.test(onRecord), String(onRecord.length))
    await w.service.check()
    w.service.apply('2.0.0')
    await settled(w.service)
    const own = w.service.status().lastResult
    assert.equal(own.at, NOW.toISOString(), 'this attempt\'s')
    assert.equal(own.error, onRecord)
    assert.ok(JSON.stringify(w.changes.at(-1)).length < 4096)
  } finally {
    w.done()
  }
})
