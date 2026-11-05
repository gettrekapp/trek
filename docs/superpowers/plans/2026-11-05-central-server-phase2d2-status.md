# Central server phase 2d-2: session status and attention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trek-server` computes each session's `working` / `done` / `idle` / `attention` status from its live terminal, the same way the desktop does today. It publishes the sessions that need the user in the `attention` topic. The plan also closes the resource gaps left over from 2d-1.

**Architecture:**
- **Pure rules** in `server/src/sessions/status.ts` port the desktop's `markActivity`, bell and key handling from `src/renderer/src/terminals.ts`. They also hold the `attention` topic builder and a filter that tells real input from a terminal's automatic replies.
- **`TerminalHost`** reports live output (`onOutput`) and the headless screen's bell (`onBell`) to its owner.
- **`SessionManager`** keeps per-session activity state and the 2.5 s quiet timer. It applies status changes as runtime-only (`persist: false`) project updates and republishes the `attention` topic.
- **Queued prompts stay click-to-send** (the user's choice). The server only stores the queue.

**Tech Stack:** Node ≥ 22.18, TypeScript, `@xterm/headless` 6.0.0 (already a dependency), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections 1, 2 and 4 (`Session.status`, the `attention` topic, "attention runs on live bytes only"). Protocol: `PROTOCOL.md`, v2 "Sessions". Previous sub-plan: `2026-11-05-central-server-phase2d1-sessions.md`. Carry-overs: the 2d-1 review items listed under decisions 7–12.

---

## Decisions made in this plan

Task 6 records these in `PROTOCOL.md`.

1. **Statuses follow the desktop's rules exactly** (`src/renderer/src/terminals.ts`, `markActivity`, `onBell`, `onKey`):
   - **Live output** (never replay):
     - Ignored while the session is `complete`.
     - Otherwise the status becomes `working`, unless it is `attention` or `exited`.
     - Every chunk restarts a 2500 ms quiet timer.
     - The output is scanned for the provider's `statusMarkers`, for example Claude's `esc to interrupt`. The previous chunk's tail is kept so a marker split across two chunks still matches.
   - **The quiet timer fires while `working`:** the status becomes `done` if a marker was seen since the last settle, otherwise `idle`. The marker flag is then cleared.
   - **Bell** (from the headless screen; a BEL that only ends an OSC sequence is not a bell): `attention`, unless the session is `complete` or `exited`. (The desktop has no `exited` guard; the server needs one because parsing is asynchronous, so a final BEL can be parsed after the exit.)
   - **User input** while `attention` or `complete`: `working`.
2. **What counts as user input.**
   - A `pty.write` counts, unless its data is only terminal replies that xterm.js sends on its own:
     - cursor position reports (`ESC [ n ; m R`)
     - device attribute replies (`ESC [ ? … c`, `ESC [ > … c`)
     - status reports (`ESC [ n n`)
     - focus in/out (`ESC [ I`, `ESC [ O`)
     - OSC color replies (`ESC ] 1x ; rgb:… BEL|ST`)
     - DECXCPR (`ESC [ ? n ; m R`), DECRPM mode reports (`ESC [ ? m ; v $ y`), DECRQSS (`ESC P 0|1 $ r … ST`) and window reports (`ESC [ 4|6|8 ; n ; m t`), added after review against the xterm.js 6 source
     - mouse reports (`ESC [ < … M|m`, `ESC [ M` + 3 bytes). The desktop's `onKey` never counted them, and pointer motion must not clear `attention`.
   - Known gap: Shift/Ctrl/Alt+F3 sends `ESC [ 1 ; <mod> R`, which is identical to a cursor report, so that key is not seen as input.
   - `session.sendPrompt` counts as input.
   - The desktop used xterm's `onKey`, which the server cannot see; the filter is its equivalent.
3. **`since`.** The server records when a session entered `attention` or `done` (epoch ms, runtime only). A restart resets every status anyway.
4. **The `attention` topic** lists every session in `attention` or `done` across all projects, oldest first:
   ```
   { projectId, worktreeId (null = Global), sessionId, title, status, since }
   ```
   It is republished whenever any of those fields can change: a status change, rename, close, unload, forget, or a project or repository removal.
5. **Status changes are runtime-only.** They use `persist: false`. Only `complete` reaches disk, through `session.markComplete`, as before.
6. **Queued prompts stay click-to-send** (the user's choice). The `session.enqueue` doc comment changes to "stored for a client to send; the server never sends it on its own".
7. **Size limits.**
   - `session.sendPrompt` text is limited to `MAX_PTY_WRITE` (1 Mi UTF-16 units), the same as `pty.write`.
   - A queue entry is at most 100,000 characters, and a queue holds at most 100 entries.
   - Anything over a limit is `BAD_REQUEST`.
   - The WebSocket server accepts frames up to 16 MiB (`maxPayload`). Before, it used the `ws` default of 100 MiB.
8. **Session cap.** A new optional server config field `maxSessions` (default 64) caps running session ptys.
   - `session.start` and `session.restart` beyond the cap answer `BAD_REQUEST` ("the server is running its maximum of N sessions").
   - `worktree.load` marks each session it cannot start `exited` with `exitCode` -1, as it does for other spawn failures.
9. **`pty.write` and `pty.resize` need the connection to be attached** to that pty (`BAD_REQUEST`, "attach first"). `pty.attach` is the only way in.
10. **Shutdown force-kills.** After the shutdown grace period, and just before the process exits, every session pty still alive gets SIGKILL. The unref'd per-pty SIGKILL timers might not fire in time.
11. **Adding a repository** does not touch running Global sessions. They pick up the new `addDirs` on their next restart. This is documented; the session is not killed.
12. **`@xterm/headless` stays in `dependencies`.** `npm start` runs the server from source with `tsx`, which needs the package at runtime. Only the esbuild bundle inlines it.

## Conventions

- **Tests:** `scripts/*.test.mjs`, run from the repo root with `npm test`. Modules imported by tests use only erasable TypeScript. Their runtime relative imports include `.ts`.
- **Typechecks:** `npm run typecheck` (root) and `cd server && npm run typecheck`.
- **Smoke:** `cd server && npm run smoke`, then `npm run build && npm run smoke -- --built`.
- **Branch and commits:** the base branch is `master`, with no remote. Work on branch `central-server-phase2d2`. There is no global git identity, so commit with `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit …`, plus the trailer of the model doing the work. Commit with an explicit path list (`… commit -m … -- <files>`) whenever another agent may be working in parallel.

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/src/sessions/status.ts` | create | pure status rules, input filter, attention entries |
| `server/src/sessions/terminalHost.ts` | modify | `onOutput` / `onBell` hooks, `isAttached`, `forceKillAll` |
| `server/src/sessions/manager.ts` | modify | activity state, quiet timers, `since`, the attention topic, `noteInput`, limits, `maxSessions` |
| `server/src/sessionHandlers.ts` | modify | input noting, the attach requirement |
| `server/src/config.ts`, `server/src/configStore.ts` | modify | `maxSessions` |
| `server/src/server.ts`, `server/src/index.ts` | modify | the hub for the manager, `maxPayload`, SIGKILL at exit |
| `PROTOCOL.md`, `server/README.md`, `src/shared/protocolV2.ts` | modify | docs |
| `server/scripts/smoke.mjs` | modify | a fake agent that shows working, done and attention |
| `scripts/serverStatus.test.mjs` | create | |
| `scripts/serverTerminalHost.test.mjs`, `scripts/serverSessions.test.mjs`, `scripts/serverConfigStore.test.mjs` | modify | |

---

### Task 1: Pure status rules

**Files:**
- Create: `server/src/sessions/status.ts`
- Test: `scripts/serverStatus.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverStatus.test.mjs`:

```js
// scripts/serverStatus.test.mjs — the desktop's status rules, ported; input filter; attention entries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, isTerminalReply, newActivity, onBell, onInput, onOutput, onQuiet } from '../server/src/sessions/status.ts'

const markers = ['esc to interrupt']

test('output makes a session working and asks for the quiet timer', () => {
  for (const status of ['idle', 'done', 'working']) {
    const r = onOutput(status, newActivity(), 'hello', markers)
    assert.equal(r.status, 'working', status)
    assert.equal(r.restartTimer, true)
  }
})

test('output leaves attention and exited alone, and is ignored while complete', () => {
  assert.equal(onOutput('attention', newActivity(), 'x', markers).status, 'attention')
  assert.equal(onOutput('exited', newActivity(), 'x', markers).status, 'exited')
  const complete = onOutput('complete', newActivity(), 'esc to interrupt', markers)
  assert.equal(complete.status, 'complete')
  assert.equal(complete.restartTimer, false)
  assert.equal(complete.activity.processingSeen, false)
})

test('markers are found case-insensitively, even split across chunks', () => {
  let a = onOutput('idle', newActivity(), '… Esc to inte', markers).activity
  assert.equal(a.processingSeen, false)
  a = onOutput('working', a, 'rrupt)', markers).activity
  assert.equal(a.processingSeen, true)
})

test('quiet: done after real work, idle after a repaint; only while working', () => {
  assert.deepEqual(onQuiet('working', { processingSeen: true, scanTail: 'x' }), { status: 'done', activity: { processingSeen: false, scanTail: 'x' } })
  assert.equal(onQuiet('working', { processingSeen: false, scanTail: '' }).status, 'idle')
  assert.equal(onQuiet('attention', { processingSeen: true, scanTail: '' }).status, 'attention')
  assert.equal(onQuiet('attention', { processingSeen: true, scanTail: '' }).activity.processingSeen, true)
})

test('bell means attention unless complete; input clears attention and complete', () => {
  for (const s of ['idle', 'working', 'done', 'attention']) assert.equal(onBell(s), 'attention')
  assert.equal(onBell('complete'), 'complete')
  assert.equal(onBell('exited'), 'exited')
  assert.equal(onInput('attention'), 'working')
  assert.equal(onInput('complete'), 'working')
  for (const s of ['idle', 'working', 'done', 'exited']) assert.equal(onInput(s), s)
})

test('terminal replies are not user input', () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[I', '\x1b[O',
    '\x1b]11;rgb:0d0d/0d0d/0f0f\x07', '\x1b]10;rgb:c9c9/c9c9/cfcf\x1b\\', '\x1b[I\x1b[12;1R']) {
    assert.equal(isTerminalReply(reply), true, JSON.stringify(reply))
  }
  for (const input of ['a', '\r', '\x1b[A', '\x03', 'hello\r', '\x1b[200~paste\x1b[201~', '', '\x1b[I a']) {
    assert.equal(isTerminalReply(input), input === '' ? true : false, JSON.stringify(input))
  }
})

test('attentionEntries lists attention and done sessions, oldest first, with Global as null', () => {
  const s = (id, status, title = id) => ({ id, title, llm: { provider: 'claude' }, queue: [], status })
  const projects = [{
    id: 'p', name: 'P', settings: {},
    globalSessions: [s('g', 'done')],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [s('a', 'attention', 'Fix'), s('b', 'working'), s('c', 'idle')] }
    ] }]
  }]
  const since = new Map([['a', 200], ['g', 100]])
  assert.deepEqual(attentionEntries(projects, since, () => 999), [
    { projectId: 'p', worktreeId: null, sessionId: 'g', title: 'g', status: 'done', since: 100 },
    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'Fix', status: 'attention', since: 200 }
  ])
  assert.equal(attentionEntries(projects, new Map(), () => 999)[0].since, 999)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverStatus.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement**

Create `server/src/sessions/status.ts`:

```ts
// Session status from live terminal activity — the desktop's rules
// (src/renderer/src/terminals.ts markActivity / onBell / onKey), ported as pure
// functions. The SessionManager owns the timers and applies the results.
import type { AttentionEntry, Project, SessionStatus } from '../../../src/shared/model/types'

/** Output must stay quiet this long before a working session settles. */
export const IDLE_MS = 2500

export interface Activity {
  /** A provider marker ("esc to interrupt") was seen since the last settle */
  processingSeen: boolean
  /** The end of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
}

export function newActivity(): Activity {
  return { processingSeen: false, scanTail: '' }
}

/** Live (never replayed) output. `restartTimer`: (re)start the quiet timer. */
export function onOutput(
  status: SessionStatus,
  activity: Activity,
  data: string,
  markers: readonly string[]
): { status: SessionStatus; activity: Activity; restartTimer: boolean } {
  // Marked complete: the user opted out of tracking.
  if (status === 'complete') return { status, activity, restartTimer: false }
  const window = activity.scanTail + data
  const lower = window.toLowerCase()
  const processingSeen = activity.processingSeen || markers.some((m) => lower.includes(m))
  const longest = Math.max(1, ...markers.map((m) => m.length))
  const next: Activity = { processingSeen, scanTail: window.slice(Math.max(0, window.length - longest + 1)) }
  // A bell means the agent waits on the user: redraws must not clear it.
  const nextStatus = status === 'attention' || status === 'exited' ? status : 'working'
  return { status: nextStatus, activity: next, restartTimer: true }
}

/** The quiet timer fired. */
export function onQuiet(status: SessionStatus, activity: Activity): { status: SessionStatus; activity: Activity } {
  if (status !== 'working') return { status, activity }
  return { status: activity.processingSeen ? 'done' : 'idle', activity: { ...activity, processingSeen: false } }
}

/** The terminal rang its bell (a BEL ending an OSC sequence is not a bell). */
export function onBell(status: SessionStatus): SessionStatus {
  return status === 'complete' || status === 'exited' ? status : 'attention'
}

/** The user typed into the session. */
export function onInput(status: SessionStatus): SessionStatus {
  return status === 'attention' || status === 'complete' ? 'working' : status
}

// Replies xterm.js sends by itself: cursor position, device attributes,
// status reports, focus in/out, OSC color queries' answers.
const REPLY = /\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\d+n|\x1b\[[IO]|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/y

/** True when `data` is only terminal replies (or empty): not the user typing. */
export function isTerminalReply(data: string): boolean {
  let at = 0
  while (at < data.length) {
    REPLY.lastIndex = at
    if (!REPLY.test(data)) return false
    at = REPLY.lastIndex
  }
  return true
}

/** The `attention` topic's entries: sessions in attention or done, oldest first. */
export function attentionEntries(
  projects: Iterable<Project>,
  since: ReadonlyMap<string, number>,
  now: () => number
): AttentionEntry[] {
  const entries: AttentionEntry[] = []
  for (const project of projects) {
    const add = (worktreeId: string | null, s: Project['globalSessions'][number]): void => {
      if (s.status !== 'attention' && s.status !== 'done') return
      entries.push({ projectId: project.id, worktreeId, sessionId: s.id, title: s.title, status: s.status, since: since.get(s.id) ?? now() })
    }
    for (const s of project.globalSessions) add(null, s)
    for (const r of project.repositories) for (const w of r.worktrees) for (const s of w.sessions) add(w.id, s)
  }
  return entries.sort((a, b) => a.since - b.since)
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverStatus.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/status.ts scripts/serverStatus.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): session status rules ported from the desktop" -m "Co-Authored-By: <model trailer>" -- server/src/sessions/status.ts scripts/serverStatus.test.mjs
```

---

### Task 2: TerminalHost hooks

**Files:**
- Modify: `server/src/sessions/terminalHost.ts`
- Test: `scripts/serverTerminalHost.test.mjs`

- [ ] **Step 1: Write the failing tests**

Read the test file's existing `setup(t, extra)` and `fakeSpawner()` first: `extra` is spread into the host's deps. Append:

```js
test('onOutput sees live output, never replay; onBell fires for a real bell only', async (t) => {
  const outputs = []
  const bells = []
  const { host, spawned } = setup(t, { onOutput: (id, d) => outputs.push([id, d]), onBell: (id) => bells.push(id) })
  host.spawn('p1', opts)
  spawned[0].emit('hi')
  host.attach('p1', sink())
  assert.deepEqual(outputs, [['p1', 'hi']], 'attach replays without calling onOutput')
  spawned[0].emit('\x1b]0;title\x07')
  spawned[0].emit('ding\x07')
  await host.settled('p1')
  assert.deepEqual(bells, ['p1'])
})

test('isAttached', (t) => {
  const { host } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  assert.equal(host.isAttached('p1', a), false)
  host.attach('p1', a)
  assert.equal(host.isAttached('p1', a), true)
  host.detach('p1', a)
  assert.equal(host.isAttached('p1', a), false)
  assert.equal(host.isAttached('nope', a), false)
})

test('forceKillAll sends SIGKILL to every pty still alive', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  const signals = []
  for (const p of spawned) p.kill = (signal) => signals.push(signal ?? 'SIGHUP')
  host.forceKillAll()
  assert.deepEqual(signals, ['SIGKILL', 'SIGKILL'])
})
```

Adapt `sink()` and `setup` to the file's real helper signatures (`sink` takes a `bufferedAmount` function).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/serverTerminalHost.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 3 failures.

- [ ] **Step 3: Implement**

In `server/src/sessions/terminalHost.ts`:
- Add to `TerminalHostDeps`:

```ts
  /** Live output (never replay), after the chunk is buffered and before clients get it */
  onOutput?: (ptyId: string, data: string) => void
  /** The program rang the terminal bell (from the headless screen) */
  onBell?: (ptyId: string) => void
```

- Store them in the constructor, like `onExit`.
- In `spawn`, after the record's headless `screen` is created, subscribe: `record.screen.onBell(() => this.safely(() => this.onBellHook?.(ptyId)))`. Give the field whatever name the class uses for stored hooks.
- In `onData`, right after `writeScreen`, call `this.safely(() => this.onOutputHook?.(record.ptyId, data))`.
- Add a private `safely(fn)` that runs `fn` in try/catch and logs with `console.error`. A throwing owner must never break streaming.
- Add the following methods:

```ts
  /** Whether `sink` is attached to the pty. */
  isAttached(ptyId: string, sink: TerminalSink): boolean {
    return this.records.get(ptyId)?.sinks.has(sink) ?? false
  }

  /** Last resort at process exit: SIGKILL every pty that is still alive. */
  forceKillAll(): void {
    for (const record of this.records.values()) {
      try {
        record.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverTerminalHost.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm test 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0` for both test runs, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): TerminalHost output and bell hooks, isAttached, forceKillAll" -m "Co-Authored-By: <model trailer>" -- server/src/sessions/terminalHost.ts scripts/serverTerminalHost.test.mjs
```

---

### Task 3: Status tracking and the attention topic in the SessionManager

**Files:**
- Modify: `server/src/sessions/manager.ts`
- Modify: `server/src/sessionHandlers.ts`
- Test: `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Read `scripts/serverSessions.test.mjs`'s `setup(t, …)` first.
- The test builds `SessionManager` with `projects`, `store`, `spawner`, `discover` and `schedule`.
- `schedule` records jobs `{fn, ms, cancelled}` in `scheduled`.
- `hub` is the TopicHub passed to `ProjectState`.

Extend `setup` so it also passes `hub` to `SessionManager` (`new SessionManager({ …, hub })`) and returns `hub`. The quiet timer goes through the same injected `schedule`, so tests fire it by hand.

Add a helper to the file, then the tests:

```js
/** The quiet-timer jobs (2500 ms) still pending, newest last. */
const quietJobs = (s) => s.scheduled.filter((j) => j.ms === 2500 && !j.cancelled)
const statusOf = (s) => s.wx().sessions[0].status
const attention = (s) => s.hub.subscribe('attention', { send() {} }).snapshot.entries

test('output → working; quiet → done after a marker, idle after a repaint', (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const proc = s.spawned[0]
  proc.emit('Thinking… (esc to interrupt)')
  assert.equal(statusOf(s), 'working')
  proc.emit('more')
  assert.equal(quietJobs(s).length, 1, 'each chunk restarts the one quiet timer')
  quietJobs(s)[0].fn()
  assert.equal(statusOf(s), 'done')
  assert.equal(attention(s)[0].status, 'done')
  proc.emit('repaint')
  assert.equal(statusOf(s), 'working')
  assert.deepEqual(attention(s), [])
  quietJobs(s)[0].fn()
  assert.equal(statusOf(s), 'idle')
})

test('a bell sets attention and lists it; real input clears it, a terminal reply does not', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.equal(statusOf(s), 'attention')
  assert.deepEqual(attention(s).map((e) => [e.sessionId, e.worktreeId, e.status]), [[sessionId, 'wx', 'attention']])
  s.sessions.noteInput(ptyId, '\x1b[12;1R')
  assert.equal(statusOf(s), 'attention')
  s.sessions.noteInput(ptyId, 'y')
  assert.equal(statusOf(s), 'working')
  assert.deepEqual(attention(s), [])
})

test('complete ignores output and bells; typing re-engages tracking', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: true })
  s.spawned[0].emit('esc to interrupt\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.equal(statusOf(s), 'complete')
  s.sessions.noteInput(ptyId, 'x')
  assert.equal(statusOf(s), 'working')
})

test('status changes are not saved; seen and rename update the attention topic', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const saves = s.saves.length
  s.spawned[0].emit('esc to interrupt')
  quietJobs(s)[0].fn()
  assert.equal(s.saves.length, saves, 'working/done are runtime-only')
  s.sessions.rename({ projectId: s.projectId, sessionId, title: 'Renamed' })
  assert.equal(attention(s)[0].title, 'Renamed')
  s.sessions.seen({ projectId: s.projectId, sessionId })
  assert.deepEqual(attention(s), [])
})

test('exit, close and unload cancel the quiet timer and drop attention entries', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('esc to interrupt')
  quietJobs(s)[0].fn()
  assert.equal(attention(s).length, 1)
  s.spawned[0].emit('x')
  s.spawned[0].exit(0)
  assert.equal(quietJobs(s).length, 0)
  assert.equal(statusOf(s), 'exited')
  assert.deepEqual(attention(s), [])
  s.sessions.restart({ projectId: s.projectId, sessionId: one.sessionId, ...size })
  s.spawned[1].emit('esc to interrupt')
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(quietJobs(s).length, 0)
})

test('sendPrompt counts as input', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'go' })
  assert.equal(statusOf(s), 'working')
})

test('pty.write notes input through the v2 handler', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  await call('pty.attach', { ptyId })
  await call('pty.write', { ptyId, data: 'n' })
  assert.equal(statusOf(s), 'working')
})
```

Update the existing `v2(s)` helper so it passes `hub: s.hub`, if it builds a context.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the new tests fail.

- [ ] **Step 3: Implement**

In `server/src/sessions/manager.ts`:

- Add `hub?: TopicHub` to `SessionManagerDeps`. Import `type TopicHub` from `'../topicHub.ts'`, `type AttentionTopic` from `'../../../src/shared/model/topics'`, and from `./status.ts`: `IDLE_MS, attentionEntries, isTerminalReply, newActivity, onBell, onInput, onOutput, onQuiet, type Activity`.
- Add these fields:

```ts
  /** sessionId → live activity (marker scan) and its quiet timer */
  private readonly activity = new Map<string, { activity: Activity; quiet?: ScheduledJob }>()
  /** sessionId → when it entered attention or done */
  private readonly since = new Map<string, number>()
```

- Build the `TerminalHost` with the two new hooks: `onOutput: (ptyId, data) => this.onPtyOutput(ptyId, data)` and `onBell: (ptyId) => this.onPtyBell(ptyId)`.
- At the end of the constructor, call `this.publishAttention()`.
- Add these methods:

```ts
  /** A client typed into the pty (pty.write). Terminal auto-replies are not input. */
  noteInput(ptyId: string, data: string): void {
    if (isTerminalReply(data)) return
    this.updateStatus(ptyId, (status) => onInput(status))
  }

  private onPtyOutput(ptyId: string, data: string): void {
    const owner = this.owners.get(ptyId)
    if (!owner) return
    const session = this.sessionOf(owner)
    if (!session) return
    const markers = getProvider(session.llm.provider).statusMarkers
    const entry = this.activity.get(owner.sessionId) ?? { activity: newActivity() }
    const r = onOutput(session.status, entry.activity, data, markers)
    entry.activity = r.activity
    this.activity.set(owner.sessionId, entry)
    if (r.restartTimer) {
      entry.quiet?.cancel()
      entry.quiet = this.schedule(() => this.onQuietTimer(ptyId), IDLE_MS)
    }
    if (r.status !== session.status) this.setStatus(owner, r.status)
  }

  private onQuietTimer(ptyId: string): void {
    const owner = this.owners.get(ptyId)
    const entry = owner && this.activity.get(owner.sessionId)
    if (!owner || !entry) return
    entry.quiet = undefined
    const session = this.sessionOf(owner)
    if (!session) return
    const r = onQuiet(session.status, entry.activity)
    entry.activity = r.activity
    if (r.status !== session.status) this.setStatus(owner, r.status)
  }

  private onPtyBell(ptyId: string): void {
    this.updateStatus(ptyId, (status) => onBell(status))
  }

  private updateStatus(ptyId: string, next: (status: SessionStatus) => SessionStatus): void {
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    const status = next(session.status)
    if (status !== session.status) this.setStatus(owner, status)
  }

  /** The session's current record, or undefined if it (or its project) is gone. */
  private sessionOf(owner: Owner): Session | undefined {
    try {
      return findSession(this.deps.projects.require(owner.projectId), owner.sessionId).session
    } catch {
      return undefined
    }
  }

  private setStatus(owner: Owner, status: SessionStatus): void {
    try {
      this.deps.projects.apply(owner.projectId, (d) => { findSession(d, owner.sessionId).session.status = status }, { persist: false })
    } catch {
      return
    }
    if (status === 'attention' || status === 'done') this.since.set(owner.sessionId, this.now())
    else this.since.delete(owner.sessionId)
    this.publishAttention()
  }

  /** Republishes the `attention` topic (a no-op when nothing changed). */
  private publishAttention(): void {
    if (!this.deps.hub) return
    const topic: AttentionTopic = { entries: attentionEntries(this.deps.projects.all(), this.since, this.now) }
    this.deps.hub.publish('attention', topic)
  }
```

`Owner` is the manager's existing ptyId→session owner type; use its real name.

Also make these changes:
- **Clear activity whenever a session's pty ends or is dropped.** Do this wherever the manager already removes an owner: in `killSession`, in `onExit`, and in the forget methods. For the session, cancel `activity.get(id)?.quiet`, then delete it from both `activity` and `since`. Add a private `dropActivity(sessionId)` helper for this.
- **Republish the attention topic at the end of every public method that can change attention fields.** These are `close`, `rename`, `seen`, `markComplete`, `unloadWorktree`, `forgetProject`, `forgetRepo`, `forgetGlobal`, and exit handling. `publishAttention` is cheap when nothing changed, because the hub diffs.
- **Make `seen` and `markComplete` maintain `since`.** Leaving `attention`/`done` deletes it.
- **`sendPrompt`:** after the write, call `this.noteInput(ptyId, text)`. Typed prompts are user input.
- **`stopAll`:** cancel every quiet timer.

In `server/src/sessionHandlers.ts`, in `pty.write`, after the size check: `ctx.sessions.noteInput(ptyId, data)`, then write.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): live session status and the attention topic" -m "Co-Authored-By: <model trailer>" -- server/src/sessions/manager.ts server/src/sessionHandlers.ts scripts/serverSessions.test.mjs
```

---

### Task 4: Limits — prompt and queue sizes, `maxSessions`, attach-before-write

**Files:**
- Modify: `server/src/config.ts`, `server/src/configStore.ts`
- Modify: `server/src/sessions/manager.ts`, `server/src/sessionHandlers.ts`
- Test: `scripts/serverConfigStore.test.mjs`, `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverConfigStore.test.mjs`, reusing the file's `tempDir`/`saveConfig` pattern:

```js
test('maxSessions: default 64, a positive integer otherwise', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'c.json')
  saveConfig(path, { repos: [] })
  const a = new ConfigStore(path)
  t.after(() => a.close())
  assert.equal(a.maxSessions(), 64)
  saveConfig(path, { repos: [], maxSessions: 3 })
  const b = new ConfigStore(path)
  t.after(() => b.close())
  assert.equal(b.maxSessions(), 3)
  assert.throws(() => validateConfig({ repos: [], maxSessions: 0 }), /config.maxSessions must be a positive integer/)
  assert.throws(() => validateConfig({ repos: [], maxSessions: 'x' }), /config.maxSessions must be a positive integer/)
})
```

Adapt the helper names (`tempDir`, `join`) to the file's real ones.

Append to `scripts/serverSessions.test.mjs`. `setup(t, { … })` must accept a config override; extend it the way it already accepts `llm`, so `setup(t, { maxSessions: 2 })` writes `maxSessions` into the config.

```js
test('maxSessions caps running sessions; load marks the rest exited -1', async (t) => {
  const s = setup(t, { maxSessions: 2 })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const second = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'BAD_REQUEST' && /maximum of 2/.test(e.message))
  // An exit frees a slot
  s.spawned[1].exit(0)
  s.sessions.restart({ projectId: s.projectId, sessionId: second.sessionId, ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size }), (e) => e.code === 'BAD_REQUEST')
  // Unload frees both; loading three dormant sessions with a cap of 2 runs two
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  await new Promise((r) => setImmediate(r))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions.push({ id: 'third', agentSessionId: '33333333-3333-4333-8333-333333333333', title: 'T', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  const states = s.wx().sessions.map((x) => [x.status, x.exitCode])
  assert.deepEqual(states, [['idle', undefined], ['idle', undefined], ['exited', -1]])
})
```

```js
test('prompt and queue limits', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const big = 'x'.repeat(1024 * 1024 + 1)
  await assert.rejects(s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: big }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'q'.repeat(100_001) }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: Array(101).fill('q') }), (e) => e.code === 'BAD_REQUEST')
  s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: Array(100).fill('q') })
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'one more' }), (e) => e.code === 'BAD_REQUEST')
})

test('pty.write and pty.resize need the connection to be attached', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  assert.equal((await call('pty.write', { ptyId, data: 'x' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('pty.resize', { ptyId, cols: 90, rows: 20 })).error.code, 'BAD_REQUEST')
  await call('pty.attach', { ptyId })
  assert.equal((await call('pty.write', { ptyId, data: 'x' })).ok, true)
  assert.equal((await call('pty.resize', { ptyId, cols: 90, rows: 20 })).ok, true)
})
```

The existing v2 test "session.start, pty.attach/write/resize/detach" already attaches before it writes. Check that it still passes, and fix any test that writes without attaching.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the new tests fail.

- [ ] **Step 3: Implement**

- **`server/src/config.ts`:** add `/** Most session ptys running at once (default 64). */ maxSessions?: number` to `TrekServerConfig`.
- **`server/src/configStore.ts`:**
  - In `validateConfig`, add `if (raw.maxSessions !== undefined && (!Number.isInteger(raw.maxSessions) || (raw.maxSessions as number) < 1)) throw new Error('config.maxSessions must be a positive integer')`.
  - Add `maxSessions(): number { return this.current.maxSessions ?? 64 }`, exported as `DEFAULT_MAX_SESSIONS = 64`.
- **`server/src/sessions/manager.ts`:**
  - Add `export const MAX_QUEUE_ENTRY = 100_000` and `export const MAX_QUEUE_LENGTH = 100`.
  - Import `MAX_PTY_WRITE` from `'../sessionHandlers.ts'`. If that makes a runtime import cycle, move `MAX_PTY_WRITE` into `terminalHost.ts`, export it from there, and have `sessionHandlers.ts` import it.
  - `sendPrompt`: reject `text.length > MAX_PTY_WRITE` with BAD_REQUEST.
  - `enqueue`: reject an entry over `MAX_QUEUE_ENTRY`, or a queue already at `MAX_QUEUE_LENGTH`.
  - `setQueue`: reject more than `MAX_QUEUE_LENGTH` entries, or any entry over `MAX_QUEUE_ENTRY`.
  - At the top of the private spawn method (`spawnSession`), count `this.owners.size`, the running session ptys. If it is `>= this.deps.store.maxSessions()`, throw `codedError('BAD_REQUEST', \`the server is running its maximum of ${max} sessions\`)`.
  - `start` and `restart` propagate the error. `loadWorktree`'s per-session catch already turns it into `exited` / -1.
- **`server/src/sessionHandlers.ts`:** `pty.write` and `pty.resize` throw `codedError('BAD_REQUEST', 'attach to the pty first')` unless `ctx.sessions.terminals.isAttached(ptyId, ctx.terminal)`.

- [ ] **Step 4: Run the tests and typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`, and both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): session limits — prompt and queue sizes, maxSessions, attach before write" -m "Co-Authored-By: <model trailer>" -- server/src/config.ts server/src/configStore.ts server/src/sessions/manager.ts server/src/sessionHandlers.ts server/src/sessions/terminalHost.ts scripts/serverConfigStore.test.mjs scripts/serverSessions.test.mjs
```

---

### Task 5: Server wiring and smoke

**Files:**
- Modify: `server/src/server.ts`, `server/src/index.ts`
- Modify: `server/scripts/smoke.mjs`

- [ ] **Step 1: Wire it**

- **`server/src/server.ts`:**
  - Pass the hub: `new SessionManager({ projects, store, hub })`.
  - Set `maxPayload: 16 * 1024 * 1024` on `new WebSocketServer({ server: httpServer, maxPayload: … })`. Name the constant `MAX_FRAME_BYTES`.
- **`server/src/index.ts`:** in the signal handler's `setTimeout(() => process.exit(0), SHUTDOWN_FLUSH_MS)`, call `server.sessions.terminals.forceKillAll()` before `process.exit(0)`.

- [ ] **Step 2: Typecheck and build**

Run: `(cd server && npm run typecheck && npm run build) 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Extend the smoke test**

Read the existing `// --- sessions (fake agent) ---` section of `server/scripts/smoke.mjs`. Its fake agent is `fake-agent.sh`: it echoes, sleeps 1 s and exits 7. Add a second fake agent and a second section after the existing one:

```js
const statusAgent = join(work, 'status-agent.sh')
writeFileSync(statusAgent, '#!/bin/sh\nprintf "working (esc to interrupt)\\n"\nsleep 4\nprintf "\\a"\nsleep 30\n', { mode: 0o755 })
```

The new section starts a session whose `llm.providers.claude.command` points to `statusAgent`. The config is written once at the top, so either:
- use a second provider entry, for example the `local` provider with `command: statusAgent` and `session.start { llm: { provider: 'local' } }`; or
- put both agents behind one script that branches on an env var.

Choose the cleanest option and keep the existing section unchanged.

Then assert the following, applying patches with the file's bounded `patchUntil`:
1. The session becomes `working`.
2. Within about 4 s of quiet it becomes `done`, and the `attention` topic (subscribe to it) lists it with `status: 'done'`.
3. After the bell it becomes `attention`, and the attention topic lists it as `attention`.
4. `pty.attach`, then `pty.write { data: 'y' }`, makes it `working` again.
5. `session.close` removes it from the attention topic.

Keep every wait bounded to a few seconds.

- [ ] **Step 4: Run the smoke test**

Run: `cd server && npm run smoke 2>&1 | tail -30`, then `npm run build && npm run smoke -- --built 2>&1 | tail -5`
Expected: `SERVER SMOKE PASS` both times.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): wire status into the server; smoke working, done and attention" -m "Co-Authored-By: <model trailer>" -- server/src/server.ts server/src/index.ts server/scripts/smoke.mjs
```

---

### Task 6: Docs

**Files:**
- Modify: `PROTOCOL.md`, `server/README.md`, `src/shared/protocolV2.ts`

- [ ] **Step 1: Write**

- **`PROTOCOL.md`, v2 section.** Base this on the shipped code, not just this plan:
  - **Intro.** Statuses and the `attention` topic are now served. Remove "arrive in phase 2d-2" for statuses and the attention topic. Queued prompts stay client-sent.
  - **Sessions → Statuses.** Replace the 2d-1 text with decisions 1–5.
  - **Queue.** Decision 6: the server stores the queue and never sends it.
  - **Limits.** Decisions 7–9. Add the new BAD_REQUEST cases to the error list.
  - **Global sessions.** Decision 11.
  - **Shutdown.** Decision 10.
  - **Topics table, `attention` row.** Fill it in: the entry fields and ordering.
- **`server/README.md`.** Add `maxSessions` to the config description, next to the `llm` section.
- **`src/shared/protocolV2.ts`.** Change the `session.enqueue` comment to "Stored for a client to send; the server never sends it on its own".

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck && (cd server && npm run typecheck)
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs: v2 session statuses, attention topic and limits" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/README.md src/shared/protocolV2.ts
```

---

## Final verification

- [ ] `npm test` → `# fail 0`
- [ ] `npm run typecheck` and `cd server && npm run typecheck && npm run build` → clean
- [ ] `cd server && npm run smoke` and `npm run smoke -- --built` → `SERVER SMOKE PASS`

## Carry-over checklist (from 2d-1)

| Carry-over | Where |
|---|---|
| Queue auto-send | Decision 6 (user: click-to-send) |
| sendPrompt and queue size limits, `maxPayload` | Decision 7, Task 4, Task 5 |
| Server-wide pty cap | Decision 8, Task 4 |
| Global sessions and `repo.add` | Decision 11 (documented) |
| pty.write and resize require attach | Decision 9, Task 4 |
| `@xterm/headless` dependency | Decision 12 (kept; `tsx` needs it) |
| SIGKILL at shutdown | Decision 10, Tasks 2 and 5 |
| Status heuristics | Decisions 1–5, Tasks 1–3 |
