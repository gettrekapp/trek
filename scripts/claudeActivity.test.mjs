// scripts/claudeActivity.test.mjs — following Claude Code's transcript (campsite part 4): a temp
// file that grows by appends, with a timer the test runs by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LINE_MAX, POLL_MS, READ_MAX, claudeActivity, followLines } from '../plugins/claude/server/activity.ts'
import { projectDir } from '../plugins/claude/server/history.ts'

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-claude-activity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A timer the test runs: `due()` runs the jobs that are due (one round) */
const manual = () => {
  const jobs = []
  return {
    jobs,
    schedule: (fn, ms) => {
      const job = { fn, ms, cancelled: false }
      jobs.push(job)
      return { cancel: () => { job.cancelled = true } }
    },
    live: () => jobs.filter((j) => !j.cancelled),
    run: () => {
      for (const j of jobs.splice(0)) if (!j.cancelled) j.fn()
    }
  }
}
/** Follows `file` with a manual timer and no fs.watch: `lines` gets each line, `warnings` each warning */
function follow(t, file, more = {}) {
  const clock = manual()
  const lines = []
  const warnings = []
  const stop = followLines(file, (l) => lines.push(l), { schedule: clock.schedule, watchFile: () => null, warn: (m) => warnings.push(m), ...more })
  t.after(stop)
  return { clock, lines, warnings, stop }
}

test('a file there at the start is read from its end; appended lines come, a partial line waits for its rest', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '{"old":1}\n{"old":2}\n')
  const f = follow(t, file)
  assert.deepEqual(f.lines, [], 'the old history is not replayed')
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS])
  appendFileSync(file, '{"a":1}\n{"b":')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}'])
  appendFileSync(file, '2}\r\n\n  \n{"c":3}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}', '{"b":2}', '{"c":3}'], 'CRLF and blank lines')
  // A character split across two reads stays whole
  const bytes = Buffer.from('{"d":"é"}\n')
  appendFileSync(file, bytes.subarray(0, 7))
  f.clock.run()
  appendFileSync(file, bytes.subarray(7))
  f.clock.run()
  assert.equal(f.lines.at(-1), '{"d":"é"}')
})

test('a file that appears late is read from its top; one that is truncated or replaced, again from its top', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 's.jsonl')
  const f = follow(t, file)
  f.clock.run()
  f.clock.run()
  assert.deepEqual(f.lines, [])
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS], 'polling quietly')
  writeFileSync(file, '{"first":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"first":1}'], "this run's file, from its top")
  // Truncated, then written again
  truncateSync(file, 0)
  appendFileSync(file, '{"t":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines.at(-1), '{"t":1}')
  // Replaced by another file (a new inode) longer than what was read
  const other = join(dir, 'other.jsonl')
  writeFileSync(other, '{"r":1}\n{"r":2}\n{"r":3}\n')
  renameSync(other, file)
  f.clock.run()
  assert.deepEqual(f.lines.slice(-3), ['{"r":1}', '{"r":2}', '{"r":3}'])
  // Removed, then back: from its top
  rmSync(file)
  f.clock.run()
  writeFileSync(file, '{"back":1}\n')
  f.clock.run()
  assert.equal(f.lines.at(-1), '{"back":1}')
  assert.deepEqual(f.warnings, [])
})

test('at most 256 KB a wake-up, the rest at once after; a line over the limit is skipped', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '')
  const f = follow(t, file)
  const line = `{"pad":"${'x'.repeat(1000)}"}`
  const many = Array.from({ length: 400 }, () => line).join('\n') + '\n'
  appendFileSync(file, many)
  f.clock.run()
  assert.ok(f.lines.length > 0 && f.lines.length <= Math.ceil(READ_MAX / line.length), `${f.lines.length} lines in one read`)
  assert.deepEqual(f.clock.live().map((j) => j.ms), [0], 'the rest is read at once')
  /** Every read due now, until only the poll is left */
  const drain = () => {
    do f.clock.run()
    while (f.clock.live().some((j) => j.ms === 0))
  }
  drain()
  assert.equal(f.lines.length, 400)
  // A line longer than LINE_MAX is dropped as it grows; the next one comes through
  appendFileSync(file, 'y'.repeat(LINE_MAX + 10))
  drain()
  appendFileSync(file, 'the long line ends here\n{"next":1}\n')
  drain()
  assert.deepEqual(f.lines.slice(400), ['{"next":1}'])
})

test('fs.watch wakes it early; stop ends the poll and the watch; an error is logged once and stops it', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '')
  let changed = null
  let unwatched = 0
  const f = follow(t, file, { watchFile: (_file, onChange) => { changed = onChange; return () => unwatched++ } })
  appendFileSync(file, '{"w":1}\n')
  changed()
  assert.deepEqual(f.lines, ['{"w":1}'], 'woken by the watch')
  // A throwing onLine: logged once, stopped
  const g = followLines(file, () => { throw new Error('bad line') }, { schedule: f.clock.schedule, watchFile: () => null, warn: (m) => f.warnings.push(m) })
  appendFileSync(file, '{"x":1}\n')
  f.clock.run()
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /^\[claude\] following .*s\.jsonl failed; its tool calls are no longer shown: bad line$/)
  f.clock.run()
  assert.equal(f.warnings.length, 1, 'once')
  g()
  f.stop()
  assert.equal(unwatched, 1)
  assert.deepEqual(f.clock.live(), [])
  appendFileSync(file, '{"after":1}\n')
  changed()
  assert.equal(f.lines.at(-1), '{"x":1}', 'nothing after stop')
})

test("claudeActivity: a session's tool calls from its transcript under HOME, in order; an id that is not Claude's throws", (t) => {
  const home = tempDir(t)
  // os.homedir() reads HOME (USERPROFILE on Windows) on each call
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const cwd = join(home, 'work', 'app')
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const clock = manual()
  const activity = claudeActivity({ schedule: clock.schedule, watchFile: () => null, warn: () => {} })
  const tools = []
  const stop = activity.watch({ sessionId, cwd, terminalId: 't1' }, (tool) => tools.push(tool))
  t.after(stop)
  const dir = projectDir(cwd)
  assert.ok(dir.startsWith(home), 'under HOME')
  mkdirSync(dir, { recursive: true })
  const line = (...content) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })
  writeFileSync(join(dir, `${sessionId}.jsonl`), [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }), line({ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/w/Campsite.tsx' } }), line({ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } })].join('\n') + '\n')
  clock.run()
  assert.deepEqual(tools, [{ kind: 'edit', label: 'Campsite.tsx' }, { kind: 'run', label: 'npm test' }])
  assert.throws(() => activity.watch({ sessionId: 'not-an-id', cwd, terminalId: 't2' }, () => {}), /Invalid session id/)
})
