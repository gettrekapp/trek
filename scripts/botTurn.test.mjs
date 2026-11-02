// scripts/botTurn.test.mjs
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
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
