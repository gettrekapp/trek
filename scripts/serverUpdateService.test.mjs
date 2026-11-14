// scripts/serverUpdateService.test.mjs — a running server's update state: what it reports, a check,
// an install asked for by a client with its progress, and each way it is refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDir } from './testPlatform.mjs'
import { createUpdateService } from '../server/src/update/service.ts'
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
  const deps = {
    install: { dir, parent: join(root, 'opt'), version: '1.0.0', build: 'b', target: 'linux-x64' },
    configDir,
    running: '1.0.0',
    sessions: () => 2,
    remoteApply: () => true,
    canRelaunch: () => true,
    relaunchRefusal: () => null,
    now: () => NOW,
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
  return { root, dir, configDir, service: createUpdateService(deps), changes, relaunched, calls, setInstalled, done: () => removeDir(root) }
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
    await assert.rejects(broken.service.check(), (err) => err.code === 'TOOL_ERROR' && /could not read SHA256SUMS/.test(err.message))
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
    await assert.rejects(w.service.check(), coded('TOOL_ERROR'), 'and the next check is a new read, not the failed one')
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

test('apply: a restart that cannot be begun leaves the install waiting for one by hand', async () => {
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
