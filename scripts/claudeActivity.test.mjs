// scripts/claudeActivity.test.mjs — following Claude Code's transcript (campsite part 4): a temp
// file that grows by appends, with a timer the test runs by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILS_MAX, LINE_MAX, POLL_MS, READ_MAX, claudeActivity, followLines } from '../plugins/claude/server/activity.ts'
import { historyFile, projectDir, transcriptFile } from '../plugins/claude/server/history.ts'

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
/** Makes node:fs's `name` throw `code` while `failing()` says so (the follower's named imports see it) */
function failFs(t, name, code, failing) {
  const real = fs[name]
  t.mock.method(fs, name, (...args) => {
    if (failing(args)) throw Object.assign(new Error(`${code}: mocked ${name}`), { code })
    return real(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
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
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.CLAUDE_CONFIG_DIR
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

test('ENOENT from the open (removed between the stat and the open) is as if the file were missing: polling goes on, from its top when back', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '{"old":1}\n')
  const f = follow(t, file)
  appendFileSync(file, '{"a":1}\n')
  let fail = true
  failFs(t, 'openSync', 'ENOENT', ([path]) => path === file && fail)
  f.clock.run()
  assert.deepEqual(f.lines, [])
  assert.deepEqual(f.warnings, [], 'not an error')
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS], 'still polling')
  fail = false
  f.clock.run()
  assert.deepEqual(f.lines, ['{"old":1}', '{"a":1}'], 'read again from its top')
  assert.deepEqual(f.warnings, [])
})

test('EBUSY or EPERM from the stat or the open is tried again on the next poll; FAILS_MAX in a row stops it, one success resets the count', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '')
  let failing = null
  failFs(t, 'statSync', 'EBUSY', ([path]) => path === file && failing === 'stat')
  failFs(t, 'openSync', 'EPERM', ([path]) => path === file && failing === 'open')
  const f = follow(t, file)
  appendFileSync(file, '{"a":1}\n')
  failing = 'stat'
  for (let i = 0; i < FAILS_MAX - 1; i++) f.clock.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS], 'polling on')
  failing = null
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}'], 'read once the file is free')
  // The count starts again; the open's EPERM counts the same
  appendFileSync(file, '{"b":1}\n')
  failing = 'open'
  for (let i = 0; i < FAILS_MAX - 1; i++) f.clock.run()
  assert.deepEqual(f.warnings, [])
  f.clock.run()
  assert.equal(f.warnings.length, 1, `stopped after ${FAILS_MAX} in a row`)
  assert.match(f.warnings[0], /failed; its tool calls are no longer shown: EPERM: mocked openSync$/)
  assert.deepEqual(f.clock.live(), [])
  assert.equal(FAILS_MAX, 30)
})

test('a file swapped between the stat and the open (another inode) is read at once again, from the new file', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 's.jsonl')
  writeFileSync(file, '')
  const f = follow(t, file)
  appendFileSync(file, '{"a":1}\n')
  const real = fs.fstatSync
  let swapped = false
  t.mock.method(fs, 'fstatSync', (fd, ...rest) => {
    const st = real(fd, ...rest)
    if (swapped) return st
    swapped = true
    // As if the open found another file than the stat
    return { ...st, ino: st.ino + 1 }
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  f.clock.run()
  assert.deepEqual(f.lines, [], 'nothing read from the file it did not expect')
  assert.deepEqual(f.clock.live().map((j) => j.ms), [0], 'looked at again at once')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}'])
  assert.deepEqual(f.warnings, [])
})

test('a file replaced while a long line is being skipped is read from its top, its first line whole', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 's.jsonl')
  writeFileSync(file, '')
  const f = follow(t, file)
  const drain = () => {
    do f.clock.run()
    while (f.clock.live().some((j) => j.ms === 0))
  }
  appendFileSync(file, 'y'.repeat(LINE_MAX + 10))
  drain()
  // Replaced before the long line ended: the skip ends with it
  const other = join(dir, 'other.jsonl')
  writeFileSync(other, '{"first":1}\n{"second":2}\n')
  renameSync(other, file)
  drain()
  assert.deepEqual(f.lines, ['{"first":1}', '{"second":2}'])
  // And truncated in the middle of one, the same
  appendFileSync(file, 'z'.repeat(LINE_MAX + 10))
  drain()
  truncateSync(file, 0)
  appendFileSync(file, '{"third":3}\n')
  drain()
  assert.deepEqual(f.lines, ['{"first":1}', '{"second":2}', '{"third":3}'])
})

/** Sets these env variables for the test (undefined: unset), restored after */
function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const put = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  put(vars)
  t.after(() => put(saved))
}

test("transcriptFile: Claude's physical cwd (symlinks resolved; as given when it isn't there), under $CLAUDE_CONFIG_DIR when set, else ~/.claude; historyFile unchanged", (t) => {
  const root = realpathSync(tempDir(t))
  const home = join(root, 'home')
  withEnv(t, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined })
  const real = join(root, 'real', 'app')
  mkdirSync(real, { recursive: true })
  const link = join(root, 'link')
  symlinkSync(join(root, 'real'), link, 'dir')
  const id = '00000000-0000-4000-8000-000000000002'
  const encoded = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
  assert.equal(transcriptFile(join(link, 'app'), id), join(home, '.claude', 'projects', encoded(real), `${id}.jsonl`), 'the symlink resolved')
  assert.equal(transcriptFile(join(root, 'nowhere'), id), join(home, '.claude', 'projects', encoded(join(root, 'nowhere')), `${id}.jsonl`), 'not there: as given')
  assert.equal(historyFile(join(link, 'app'), id), join(projectDir(join(link, 'app')), `${id}.jsonl`), "historyFile keeps the cwd as given")
  const config = join(root, 'config')
  assert.equal(transcriptFile(real, id, { CLAUDE_CONFIG_DIR: config }), join(config, 'projects', encoded(real), `${id}.jsonl`))
  assert.equal(transcriptFile(real, id, { CLAUDE_CONFIG_DIR: '' }), join(home, '.claude', 'projects', encoded(real), `${id}.jsonl`), 'empty: unset')
  withEnv(t, { CLAUDE_CONFIG_DIR: config })
  assert.ok(transcriptFile(real, id).startsWith(join(config, 'projects')), "the server's env by default")
  assert.throws(() => transcriptFile(real, '../x'), /Invalid session id/)
})

test('claudeActivity: a session in a symlinked cwd with $CLAUDE_CONFIG_DIR set, its transcript starting with a BOM, end to end', (t) => {
  const root = realpathSync(tempDir(t))
  const config = join(root, 'config')
  withEnv(t, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CLAUDE_CONFIG_DIR: config })
  const real = join(root, 'real', 'app')
  mkdirSync(real, { recursive: true })
  symlinkSync(join(root, 'real'), join(root, 'link'), 'dir')
  const sessionId = '00000000-0000-4000-8000-000000000003'
  const clock = manual()
  const tools = []
  const stop = claudeActivity({ schedule: clock.schedule, watchFile: () => null, warn: () => {} }).watch({ sessionId, cwd: join(root, 'link', 'app'), terminalId: 't1' }, (tool) => tools.push(tool))
  t.after(stop)
  // Where Claude writes it: the physical cwd, under the config dir
  const dir = join(config, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const edit = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/w/Campsite.tsx' } }] } })
  writeFileSync(join(dir, `${sessionId}.jsonl`), `\uFEFF${edit}\n`)
  clock.run()
  assert.deepEqual(tools, [{ kind: 'edit', label: 'Campsite.tsx' }], 'the BOM line read whole')
})
