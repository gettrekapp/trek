// scripts/botTurn.test.mjs
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTurn } from '../src/host/bot/turnProcess.ts'
import { startHeartbeat } from '../src/host/bot/heartbeat.ts'

const FAKE = resolve('scripts/fixtures/fake-claude.mjs')
const dir = mkdtempSync(join(tmpdir(), 'bot-turn-'))
const run = (prompt, extra = {}) => {
  const events = []
  const handle = runTurn({
    command: [FAKE],
    cwd: dir,
    prompt,
    systemPrompt: 'SYS',
    sessionId: 's1',
    resume: false,
    mcpConfig: '/tmp/mcp.json',
    settings: '{}',
    addDirs: ['/a', '/b'],
    env: {},
    timeoutMs: 20_000,
    ...extra
  }, (e) => events.push(e))
  return { handle, events }
}

test('a good turn streams events and reports ok', async () => {
  const { handle, events } = run('hello')
  const outcome = await handle.done
  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(events, [{ kind: 'text', text: 'echo:hello' }])
})

test('passes the expected flags', async () => {
  const log = join(dir, 'args.log')
  await run('hi', { env: { FAKE_CLAUDE_LOG: log } }).handle.done
  const argv = JSON.parse(readFileSync(log, 'utf8').trim())
  for (const flag of ['-p', '--output-format', '--verbose', '--mcp-config', '--strict-mcp-config', '--settings', '--append-system-prompt', '--session-id']) {
    assert.ok(argv.includes(flag), flag)
  }
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json')
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--add-dir'), ['/a', '/b'])
})

test('resume uses --resume', async () => {
  const log = join(dir, 'resume.log')
  await run('hi', { resume: true, env: { FAKE_CLAUDE_LOG: log } }).handle.done
  const argv = JSON.parse(readFileSync(log, 'utf8').trim())
  assert.equal(argv[argv.indexOf('--resume') + 1], 's1')
  assert.ok(!argv.includes('--session-id'))
})

test('classifies failed turns', async () => {
  assert.equal((await run('CRASH').handle.done).kind, 'crash')
  assert.equal((await run('AUTHFAIL').handle.done).kind, 'auth')
  assert.equal((await run('LIMITED').handle.done).kind, 'limit')
  assert.equal((await run('x', { sessionId: 'bad', resume: true }).handle.done).kind, 'resume')
})

test('a missing command reports missing', async () => {
  assert.equal((await run('x', { command: [join(dir, 'nope')] }).handle.done).kind, 'missing')
})

test('a hung turn times out and is killed', async () => {
  const outcome = await run('HANG', { timeoutMs: 400 }).handle.done
  assert.equal(outcome.kind, 'timeout')
})

test('kill stops a turn', async () => {
  const { handle } = run('HANG')
  setTimeout(() => handle.kill(), 200)
  assert.equal((await handle.done).kind, 'killed')
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const killAll = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
// Filtered because signalling pid 0 would hit this test's own process group.
const readPids = (file) => readFileSync(file, 'utf8').split('\n').map(Number).filter((pid) => pid > 0)
const quietly = (t) => t.mock.method(console, 'error', () => {})

test('the prompt goes over stdin and not argv', async () => {
  const log = join(dir, 'stdin.log')
  const prompt = `PROMPTSIZE -p --flag ${'x'.repeat(3 * 1024 * 1024)}`
  const { handle, events } = run(prompt, { env: { FAKE_CLAUDE_LOG: log } })
  assert.equal((await handle.done).kind, 'ok')
  assert.deepEqual(events, [{ kind: 'text', text: `size:${prompt.length}` }])
  const argv = JSON.parse(readFileSync(log, 'utf8').trim())
  assert.ok(!argv.some((a) => a.includes('PROMPTSIZE')))
  assert.equal(argv[argv.indexOf('-p') + 1], '--output-format')
})

test('a child that never reads stdin cannot throw EPIPE at us', async () => {
  const outcome = await run('x'.repeat(4 * 1024 * 1024), { command: ['/usr/bin/true'] }).handle.done
  assert.equal(outcome.kind, 'crash')
})

test('synchronous spawn failures become outcomes', async () => {
  const nul = run('x', { systemPrompt: 'a\0b' }).handle
  assert.equal((await nul.done).kind, 'crash')
  nul.kill()
  const file = join(dir, 'a-file')
  writeFileSync(file, '')
  assert.equal((await run('x', { cwd: file }).handle.done).kind, 'crash')
  assert.equal((await run('x', { env: { BAD: 'a\0b' } }).handle.done).kind, 'crash')
})

test('an empty command reports missing', async () => {
  assert.equal((await run('x', { command: [''] }).handle.done).kind, 'missing')
  assert.equal((await run('x', { command: [] }).handle.done).kind, 'missing')
})

test('running out of file descriptors is an outcome, not a throw', () => {
  const script = `
    import { closeSync, openSync } from 'node:fs'
    import { runTurn } from ${JSON.stringify(resolve('src/host/bot/turnProcess.ts'))}
    const held = []
    try { for (;;) held.push(openSync('/dev/null', 'r')) } catch {}
    const outcome = await runTurn({
      command: ['/usr/bin/true'], cwd: '/', prompt: 'x', systemPrompt: 'S', sessionId: 's', resume: false,
      mcpConfig: 'm', settings: 's', addDirs: [], env: {}, timeoutMs: 5000
    }, () => {}).done
    for (const fd of held) closeSync(fd)
    await new Promise((r) => setTimeout(r, 50))
    console.log(JSON.stringify(outcome))
    process.exit(0)
  `
  const ran = spawnSync('/bin/sh', ['-c', 'ulimit -n 256; exec "$0" --no-warnings --input-type=module -e "$1"', process.execPath, script], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(JSON.parse(ran.stdout.trim()).kind, 'crash')
})

test('a missing working directory is a crash that says so', async () => {
  const cwd = join(dir, 'gone')
  const outcome = await run('x', { cwd }).handle.done
  assert.equal(outcome.kind, 'crash')
  assert.equal(outcome.text, `Working directory not found: ${cwd}`)
})

test('a throwing onEvent never escapes or loses the result, mid-stream or in the final flush', async (t) => {
  const error = quietly(t)
  for (const [prompt, count] of [['hello', 1], ['NONEWLINE', 1]]) {
    let calls = 0
    const handle = runTurn({
      command: [FAKE], cwd: dir, prompt, systemPrompt: 'S', sessionId: 's1', resume: false, mcpConfig: 'm',
      settings: '{}', addDirs: [], env: {}, timeoutMs: 20_000
    }, () => {
      calls++
      throw new Error('listener broke')
    })
    assert.equal((await handle.done).kind, 'ok', prompt)
    assert.equal(calls, count, prompt)
  }
  assert.equal(error.mock.callCount(), 2)
})

test('output left without a trailing newline is still parsed', async () => {
  const { handle, events } = run('NONEWLINE')
  assert.equal((await handle.done).kind, 'ok')
  assert.deepEqual(events, [{ kind: 'text', text: 'last' }])
})

test('descendants holding stdout cannot stop a good result from settling', async (t) => {
  const file = join(dir, 'held.pids')
  writeFileSync(file, '')
  t.after(() => killAll(readPids(file)))
  const started = Date.now()
  const outcome = await run('GRANDCHILDREN', { env: { FAKE_CLAUDE_PIDS: file } }).handle.done
  assert.equal(outcome.kind, 'ok')
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}`)
  const pids = readPids(file)
  assert.equal(pids.length, 2)
  assert.ok(pids.every(alive), 'still holding stdout when we settled')
})

test('a good result beats a stop that arrives after it', async (t) => {
  const file = join(dir, 'beat.pids')
  writeFileSync(file, '')
  t.after(() => killAll(readPids(file)))
  const { handle } = run('GRANDCHILDREN', { env: { FAKE_CLAUDE_PIDS: file } })
  setTimeout(() => handle.kill(), 350)
  assert.equal((await handle.done).kind, 'ok')
})

test('a stop still SIGKILLs descendants after settling', async (t) => {
  const file = join(dir, 'stubborn.pids')
  writeFileSync(file, '')
  t.after(() => killAll(readPids(file)))
  const handle = runTurn({
    command: [FAKE], cwd: dir, prompt: 'STUBBORN', systemPrompt: 'S', sessionId: 's1', resume: false, mcpConfig: 'm',
    settings: '{}', addDirs: [], env: { FAKE_CLAUDE_PIDS: file }, timeoutMs: 20_000
  }, (event) => {
    if (event.text === 'ready') handle.kill()
  })
  const started = Date.now()
  assert.equal((await handle.done).kind, 'killed')
  assert.ok(Date.now() - started < 2500, 'settled well before the grace period ended')
  const [pid] = readPids(file)
  assert.ok(alive(pid), 'ignored SIGTERM')
  const deadline = Date.now() + 5000
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.ok(!alive(pid), 'killed by the grace timer')
})

test('kill after settling sends no signals at all', async (t) => {
  const { handle } = run('hello')
  await handle.done
  const kill = t.mock.method(process, 'kill', () => true)
  handle.kill()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(kill.mock.callCount(), 0)
})

test('a child that survives SIGKILL cannot wedge the turn', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true)
  t.after(() => {
    kill.mock.restore()
    killAll(kill.mock.calls.map((call) => -call.arguments[0]).filter((pid) => pid > 0))
  })
  const outcome = await run('HANG', { timeoutMs: 200 }).handle.done
  assert.equal(outcome.kind, 'timeout')
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments[1]), ['SIGTERM', 'SIGKILL'])
})

test('an emoji split across chunks survives', async () => {
  const { handle, events } = run('SPLITEMOJI')
  assert.equal((await handle.done).kind, 'ok')
  assert.deepEqual(events, [{ kind: 'text', text: 'a😀b' }])
})

test('an endless line is dropped past the cap, once, and the turn carries on', async () => {
  const { handle, events } = run('OVERLONG')
  assert.equal((await handle.done).kind, 'ok')
  assert.equal(events.filter((e) => e.kind === 'error').length, 1)
  assert.deepEqual(events.filter((e) => e.kind === 'text'), [{ kind: 'text', text: 'after' }])
})

test('the timeout is clamped to something a timer can hold', async () => {
  for (const timeoutMs of [Infinity, 1e308, 2 ** 31, 2 ** 40, NaN, 0, -5]) {
    assert.equal((await run('hello', { timeoutMs }).handle.done).kind, 'ok', String(timeoutMs))
  }
})

test('heartbeat waits one interval, rereads it, and stops', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let beats = 0
  let minutes = 5
  const scheduled = []
  const stop = startHeartbeat(() => minutes, () => { beats++ }, (at) => scheduled.push(at))
  mock.timers.tick(4 * 60_000)
  assert.equal(beats, 0)
  mock.timers.tick(60_000)
  assert.equal(beats, 1)
  minutes = 1
  mock.timers.tick(5 * 60_000)
  assert.equal(beats, 2)
  mock.timers.tick(60_000)
  assert.equal(beats, 3)
  stop()
  mock.timers.tick(10 * 60_000)
  assert.equal(beats, 3)
  assert.equal(scheduled.length, 4)
  mock.timers.reset()
})

const withTimers = (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())
}
const MINUTE = 60_000
const MAX_DELAY = 2 ** 31 - 1

test('heartbeat clamps long intervals to what a timer can hold', (t) => {
  withTimers(t)
  for (const minutes of [1e308, Infinity, 1e10]) {
    let beats = 0
    const scheduled = []
    const before = Date.now()
    const stop = startHeartbeat(() => minutes, () => { beats++ }, (at) => scheduled.push(at))
    assert.equal(scheduled[0] - before, MAX_DELAY, String(minutes))
    mock.timers.tick(MAX_DELAY - 1)
    assert.equal(beats, 0)
    mock.timers.tick(1)
    assert.equal(beats, 1)
    stop()
  }
})

test('heartbeat falls back to the last good delay on a bad or throwing interval', (t) => {
  withTimers(t)
  quietly(t)
  let beats = 0
  let minutes = () => 2
  const stop = startHeartbeat(() => minutes(), () => { beats++ }, () => {})
  for (const bad of [() => NaN, () => 0, () => -1, () => { throw new Error('config') }]) {
    minutes = bad
    const before = beats
    mock.timers.tick(2 * MINUTE)
    assert.equal(beats, before + 1)
  }
  mock.timers.tick(2 * MINUTE)
  assert.equal(beats, 5)
  stop()
})

test('heartbeat has a default when the very first interval is bad', (t) => {
  withTimers(t)
  quietly(t)
  for (const read of [() => NaN, () => { throw new Error('config') }]) {
    let beats = 0
    const stop = startHeartbeat(read, () => { beats++ }, () => {})
    mock.timers.tick(5 * MINUTE)
    assert.equal(beats, 1)
    stop()
  }
})

test('a throwing onBeat or onScheduled does not stop the heartbeat', (t) => {
  withTimers(t)
  const error = quietly(t)
  let beats = 0
  let scheduled = 0
  const stop = startHeartbeat(() => 1, () => {
    beats++
    throw new Error('beat')
  }, () => {
    scheduled++
    throw new Error('scheduled')
  })
  mock.timers.tick(MINUTE)
  mock.timers.tick(MINUTE)
  assert.equal(beats, 2)
  assert.equal(scheduled, 3)
  assert.equal(error.mock.callCount(), 5)
  stop()
})

test('stopping during onBeat or onScheduled does not re-arm', (t) => {
  withTimers(t)
  let stop
  let beats = 0
  let scheduled = 0
  stop = startHeartbeat(() => 1, () => {
    beats++
    stop()
  }, () => { scheduled++ })
  mock.timers.tick(MINUTE)
  assert.equal(beats, 1)
  assert.equal(scheduled, 1)
  mock.timers.tick(10 * MINUTE)
  assert.equal(beats, 1)

  let later = 0
  let calls = 0
  const stopLater = startHeartbeat(() => 1, () => { later++ }, () => {
    if (++calls === 2) stopLater()
  })
  mock.timers.tick(MINUTE)
  mock.timers.tick(10 * MINUTE)
  assert.equal(later, 1)
  assert.equal(calls, 2)
})

test('an outcome says whether the CLI reported a session', async () => {
  assert.equal((await run('hello').handle.done).sessionStarted, true)
  assert.equal((await run('x', { command: ['/usr/bin/true'] }).handle.done).sessionStarted, false)
  assert.equal((await run('x', { command: ['/no/such/claude'] }).handle.done).sessionStarted, false)
  assert.equal((await run('x', { command: [] }).handle.done).sessionStarted, false)
})
