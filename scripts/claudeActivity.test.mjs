// scripts/claudeActivity.test.mjs — following Claude Code's transcript (campsite part 4): a temp
// file that grows by appends, with a timer the test runs by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILS_MAX, LINE_MAX, POLL_MS, READ_MAX, claudeActivity, followLines } from '../plugins/claude/server/activity.ts'
import { TRANSCRIPT_CANDIDATES_MAX, historyFile, projectDir, transcriptFile, transcriptFiles } from '../plugins/claude/server/history.ts'

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

test('EBUSY, or EPERM on Windows, from the stat or the open is tried again on the next poll; FAILS_MAX in a row stops it, one success resets the count', (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '')
  let failing = null
  failFs(t, 'statSync', 'EBUSY', ([path]) => path === file && failing === 'stat')
  failFs(t, 'openSync', 'EPERM', ([path]) => path === file && failing === 'open')
  const f = follow(t, file, { platform: 'win32' })
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

test('EPERM is a real error off Windows: logged once, stopped at once', (t) => {
  for (const platform of ['darwin', 'linux']) {
    const file = join(tempDir(t), 's.jsonl')
    writeFileSync(file, '')
    let failing = false
    failFs(t, 'statSync', 'EPERM', ([path]) => path === file && failing)
    const f = follow(t, file, { platform })
    failing = true
    f.clock.run()
    assert.equal(f.warnings.length, 1, platform)
    assert.match(f.warnings[0], /EPERM: mocked statSync$/)
    assert.deepEqual(f.clock.live(), [], `${platform}: stopped`)
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("FAILS_MAX counts the timer's polls only: fs.watch wake-ups that find the file busy use none up", (t) => {
  const file = join(tempDir(t), 's.jsonl')
  writeFileSync(file, '')
  let failing = false
  failFs(t, 'statSync', 'EBUSY', ([path]) => path === file && failing)
  let changed = null
  const f = follow(t, file, { watchFile: (_file, onChange) => { changed = onChange; return () => {} } })
  appendFileSync(file, '{"a":1}\n')
  failing = true
  for (let i = 0; i < FAILS_MAX - 1; i++) f.clock.run()
  // Many watch wake-ups, all busy: none counts, and the poll set stays as it was
  const before = f.clock.live()
  for (let i = 0; i < FAILS_MAX * 2; i++) changed()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.clock.live(), before, 'the poll is left alone')
  // The next poll is the FAILS_MAX-th
  f.clock.run()
  assert.equal(f.warnings.length, 1)
  assert.deepEqual(f.clock.live(), [])
})

test('several candidate paths: each is polled until one exists; the first existing wins, and is followed alone until it goes', (t) => {
  const dir = tempDir(t)
  const [a, b, c] = ['a', 'b', 'c'].map((n) => join(dir, n, 's.jsonl'))
  const looked = []
  const real = fs.statSync
  t.mock.method(fs, 'statSync', (path, ...rest) => {
    looked.push(path)
    return real(path, ...rest)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const f = follow(t, [a, b, c])
  assert.deepEqual(looked, [a, b, c], 'one stat each a poll')
  // b and c appear: b, the earlier, is followed, from its top (it appeared later)
  for (const p of [b, c]) mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(c, '{"c":1}\n')
  writeFileSync(b, '{"b":1}\n')
  looked.length = 0
  f.clock.run()
  assert.deepEqual(f.lines, ['{"b":1}'])
  assert.deepEqual(looked, [a, b], 'stops at the first there')
  // a appears now: b is still the one followed, a and c aren't looked at
  mkdirSync(join(a, '..'), { recursive: true })
  writeFileSync(a, '{"a":1}\n')
  appendFileSync(b, '{"b":2}\n')
  looked.length = 0
  f.clock.run()
  assert.deepEqual(f.lines, ['{"b":1}', '{"b":2}'])
  assert.deepEqual(looked, [b])
  // b goes: all are looked at again at once, and a, the first, already there, is followed from its end
  rmSync(b)
  f.clock.run()
  f.clock.run()
  assert.deepEqual(f.lines, ['{"b":1}', '{"b":2}'])
  appendFileSync(a, '{"a":2}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"b":1}', '{"b":2}', '{"a":2}'])
  assert.deepEqual(f.warnings, [])
})

test('several candidate paths, the first look: the first existing one is read from its end', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  writeFileSync(b, '{"old":1}\n')
  const f = follow(t, [a, b])
  appendFileSync(b, '{"new":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"new":1}'])
})

test('several candidate paths: one whose stat fails (EACCES) is skipped and a later one followed; all failing is logged once and stops it', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  writeFileSync(b, '{"old":1}\n')
  failFs(t, 'statSync', 'EACCES', ([path]) => path === a)
  const f = follow(t, [a, b])
  appendFileSync(b, '{"new":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"new":1}'], 'b followed, from its end')
  assert.deepEqual(f.warnings, [], 'nothing logged')
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS])
})

test('several candidate paths, all failing with EACCES: logged once, stopped', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  writeFileSync(a, '')
  writeFileSync(b, '')
  failFs(t, 'statSync', 'EACCES', ([path]) => path === a || path === b)
  const f = follow(t, [a, b])
  f.clock.run()
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /EACCES: mocked statSync$/)
  assert.deepEqual(f.clock.live(), [], 'stopped')
})

test('several candidate paths: an EACCES one with none other there is the failure: logged once, stopped', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  failFs(t, 'statSync', 'EACCES', ([path]) => path === a)
  const f = follow(t, [a, b])
  assert.equal(f.warnings.length, 1, 'b missing, a unreadable: the failure')
  assert.deepEqual(f.clock.live(), [])
})

test('several candidate paths: EBUSY on the first, the second there: the second is followed, no failure counted', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  writeFileSync(b, '')
  failFs(t, 'statSync', 'EBUSY', ([path]) => path === a)
  const f = follow(t, [a, b])
  // Many more polls than FAILS_MAX: a stays busy (b is followed, so a isn't looked at), nothing fails
  for (let i = 0; i < FAILS_MAX + 5; i++) {
    appendFileSync(b, `{"n":${i}}\n`)
    f.clock.run()
  }
  assert.equal(f.lines.length, FAILS_MAX + 5)
  assert.deepEqual(f.warnings, [])
  // b goes and a is still busy: now the busy polls count, FAILS_MAX of them stop it
  rmSync(b)
  f.clock.run()
  for (let i = 0; i < FAILS_MAX - 1; i++) f.clock.run()
  assert.deepEqual(f.warnings, [])
  f.clock.run()
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /EBUSY: mocked statSync$/)
  assert.deepEqual(f.clock.live(), [])
})

test('ENAMETOOLONG is as if the file were missing: polling goes on quietly', (t) => {
  const dir = tempDir(t)
  const [a, b] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]
  failFs(t, 'statSync', 'ENAMETOOLONG', ([path]) => path === a)
  const f = follow(t, [a, b])
  f.clock.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.clock.live().map((j) => j.ms), [POLL_MS], 'still polling')
  writeFileSync(b, '{"b":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"b":1}'], 'b, appearing later, from its top')
  // A real over-long path, no mock
  const g = follow(t, join(dir, 'x'.repeat(5000), 's.jsonl'))
  g.clock.run()
  assert.deepEqual(g.warnings, [])
  assert.deepEqual(g.clock.live().map((j) => j.ms), [POLL_MS])
})

test('the followed file goes: another candidate already there is read from its end; one that appears later, from its top', (t) => {
  const dir = tempDir(t)
  const [a, b, c] = [join(dir, 'a.jsonl'), join(dir, 'b.jsonl'), join(dir, 'c.jsonl')]
  writeFileSync(a, '')
  const f = follow(t, [a, b, c])
  appendFileSync(a, '{"a":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}'])
  // b is there with history while a is followed; a goes: b is followed from its end
  writeFileSync(b, '{"b-old":1}\n')
  rmSync(a)
  f.clock.run()
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}'], "b's history isn't replayed")
  appendFileSync(b, '{"b":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}', '{"b":1}'])
  // b goes and none is there; c appears later: from its top
  rmSync(b)
  f.clock.run()
  f.clock.run()
  writeFileSync(c, '{"c":1}\n')
  f.clock.run()
  assert.deepEqual(f.lines, ['{"a":1}', '{"b":1}', '{"c":1}'])
  assert.deepEqual(f.warnings, [])
})

test('transcriptFiles: the resolved cwd then the cwd as given, under $CLAUDE_CONFIG_DIR then ~/.claude; no path twice; at most 4', (t) => {
  const root = realpathSync(tempDir(t))
  const home = join(root, 'home')
  withEnv(t, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined })
  const real = join(root, 'real', 'app')
  mkdirSync(real, { recursive: true })
  symlinkSync(join(root, 'real'), join(root, 'link'), 'dir')
  const linked = join(root, 'link', 'app')
  const id = '00000000-0000-4000-8000-000000000004'
  const at = (base, cwd) => join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  const dot = join(home, '.claude')
  const config = join(root, 'config')
  assert.equal(TRANSCRIPT_CANDIDATES_MAX, 4)
  assert.deepEqual(transcriptFiles(linked, id, { CLAUDE_CONFIG_DIR: config }), [at(config, real), at(config, linked), at(dot, real), at(dot, linked)])
  assert.deepEqual(transcriptFiles(linked, id, {}), [at(dot, real), at(dot, linked)], 'no config dir')
  assert.deepEqual(transcriptFiles(linked, id, { CLAUDE_CONFIG_DIR: '' }), [at(dot, real), at(dot, linked)], 'empty: unset')
  assert.deepEqual(transcriptFiles(real, id, { CLAUDE_CONFIG_DIR: dot }), [at(dot, real)], 'the same paths once')
  assert.deepEqual(transcriptFiles(join(root, 'nowhere'), id, {}), [at(dot, join(root, 'nowhere'))], "not there: as given")
  assert.equal(transcriptFile(linked, id, { CLAUDE_CONFIG_DIR: config }), at(config, real))
  assert.throws(() => transcriptFiles(real, '../x'), /Invalid session id/)
})

/** claudeActivity under a temp home: its tool calls, and a writer of an Edit line at `file` */
function activityIn(t, cwd, sessionId) {
  const clock = manual()
  const tools = []
  const stop = claudeActivity({ schedule: clock.schedule, watchFile: () => null, warn: () => {} }).watch({ sessionId, cwd, terminalId: 't1' }, (tool) => tools.push(tool))
  t.after(stop)
  const write = (file, label) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: label, name: 'Edit', input: { file_path: `/w/${label}` } }] } }) + '\n')
  }
  return { clock, tools, write }
}

test('claudeActivity: a symlinked cwd whose transcript is under the cwd as given (a Windows junction kept) is found', (t) => {
  const root = realpathSync(tempDir(t))
  const home = join(root, 'home')
  withEnv(t, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined })
  mkdirSync(join(root, 'real', 'app'), { recursive: true })
  symlinkSync(join(root, 'real'), join(root, 'link'), 'dir')
  const cwd = join(root, 'link', 'app')
  const sessionId = '00000000-0000-4000-8000-000000000005'
  const a = activityIn(t, cwd, sessionId)
  a.write(join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`), 'Raw.tsx')
  a.clock.run()
  assert.deepEqual(a.tools, [{ kind: 'edit', label: 'Raw.tsx' }])
})

test("claudeActivity: with $CLAUDE_CONFIG_DIR set, a transcript under ~/.claude is found too; the config dir's wins when both are there", (t) => {
  const root = realpathSync(tempDir(t))
  const home = join(root, 'home')
  const config = join(root, 'config')
  withEnv(t, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config })
  const cwd = join(root, 'app')
  mkdirSync(cwd, { recursive: true })
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  // Only the default dir's
  const one = '00000000-0000-4000-8000-000000000006'
  const a = activityIn(t, cwd, one)
  a.write(join(home, '.claude', 'projects', folder, `${one}.jsonl`), 'Default.tsx')
  a.clock.run()
  assert.deepEqual(a.tools, [{ kind: 'edit', label: 'Default.tsx' }])
  // Both: the config dir's
  const two = '00000000-0000-4000-8000-000000000007'
  const b = activityIn(t, cwd, two)
  b.write(join(home, '.claude', 'projects', folder, `${two}.jsonl`), 'Default.tsx')
  b.write(join(config, 'projects', folder, `${two}.jsonl`), 'Config.tsx')
  b.clock.run()
  assert.deepEqual(b.tools, [{ kind: 'edit', label: 'Config.tsx' }])
})
