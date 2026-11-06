# Central server phase 3b: servers, server windows and the Connect flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app keeps an app-wide list of trek-servers. From the start screen you can connect to one, create or pick a project on it, and open that project in a **server window**. A server window shows the live project tree read-only; 3c makes it fully interactive. Server windows behave like file windows: opening an open one focuses it, recents list them, and they come back on launch.

**Architecture:**
- **Main** keeps the server list in `userData/app-servers.json`, with tokens in safeStorage. It relays each window's WebSocket over IPC and injects the token into the `hello` frame, so the token never reaches the renderer and the renderer's CSP stays as it is.
- **The renderer** uses the 3a SDK (`src/shared/client/`) with an IPC-backed socket factory.
- **Windows** get a `target` that is either `{kind: 'file', path}` or `{kind: 'server', serverEntryId, projectId}`. Recents and `open-windows.json` store either kind.
- **Legacy file windows are unchanged.**

**Tech Stack:** Electron (main, preload, renderer), React, the `src/shared/client` SDK, Playwright `_electron` for the smoke test.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section 3, "Desktop app", "Start screen" and "v2 project window". Roadmap: `docs/superpowers/plans/2026-11-06-central-server-phase3a-client.md`.

---

## Decisions made in this plan

1. **Main relays the connection** (the user's choice).
   - Main opens a WebSocket for the window. The renderer's SDK uses an IPC-backed `SocketLike`.
   - The renderer asks for a socket by **server entry id**, never by URL. Main looks up the URL and refuses an unknown id.
   - Main replaces the `token` in any outgoing `hello` frame with the stored token. The renderer sends `token: ''`.
   - Socket events go only to the window that opened the socket. A window's sockets close when it is destroyed.
   - The CSP is unchanged.
2. **App-wide servers are separate from today's per-project servers.** Legacy `.trekproj` `servers` keep working for file windows through v1 `RemoteHost`.
   - The new list is `userData/app-servers.json`, an array of `{id, name, url}`.
     - `id` is a client-side UUID.
     - `url` must be `ws://` or `wss://`. `ws://` is allowed for any host (Tailscale and LAN), and the UI warns when it isn't loopback.
   - Tokens are kept in `createSecretStore('app-server-tokens.json')`, keyed by `id`.
   - The renderer can set a token and ask whether one is set. It can never read a token.
3. **Ids.** Windows, recents and `open-windows.json` key server projects by `(serverEntryId, projectId)`. The entry id is the client-side one; the server's own UUID is in `welcome.serverId`. Removing an entry leaves its recents and restored windows pointing at nothing, and they show "Server removed" (spec, Errors).
4. **Window targets.**
   - `WindowState` gains `target: WindowTarget | null`, where `WindowTarget` is `{kind: 'file', path}` or `{kind: 'server', serverEntryId, projectId}`. It replaces `filePath` and `hasProject`, keeping their behaviour for files.
   - `decideOpen` is unchanged. "Already open" now compares targets: file paths by realpath, server targets by both ids.
   - `InitialWindowState` gains `server: {serverEntryId, projectId} | null`.
5. **Recents.** `recent-projects.json` holds either a string (a file path, as today) or `{kind: 'server', serverEntryId, projectId, name, serverName}`. It still keeps at most 8. File entries are dropped when the file is missing. Server entries are kept until the user removes them; if the server entry is gone, they show "Server removed". The start screen shows a server entry as its name with a `server` chip, and `serverName` (or "Server removed") on the line below. Each recent has a × remove control.
6. **Closing a server window** needs no prompt and no save: its sessions run on the server. The renderer answers the close request at once. Its sockets close and the server keeps everything running.
7. **Start screen.**
   - **Connect to server…** joins New Project / Open Project.
   - It opens a panel with the server list. Each server shows a dot for its connection status (connected, connecting, needs-auth, error or incompatible) and its status message.
   - The panel offers: **Add server** (name, URL and token), **Set token**, **Test** and **Remove**, with a confirmation before removing.
   - Picking a server lists its projects from the `server` topic. Each project has **Open**, and the list has **New Project…**.
   - **New Project…** opens a modal with these parts:
     - a name field;
     - one checkbox per registered repo, from the `server` topic's `repos`;
     - **Add repo by path…**, a text field plus Add button that calls `server.addRepo` and ticks the new repo. `PATH_DENIED` and `NOT_A_REPO` show inline, with the hint "run `trek-server add <path>` on the server".
     - **Create** calls `project.create` and opens the new project.
8. **The read-only server window in 3b** shows:
   - the project name in the title bar;
   - a connection banner when not `connected`, giving the status and message;
   - the repositories, each with its worktrees (branch or name, a `missing` marker, dirty/ahead/behind, and `loaded`), and each worktree's sessions with title and status;
   - the Global sessions.

   **Edge cases:**
   - An unknown project (`NOT_FOUND`) shows "Project not found on `<server>`" with **Close** and **Pick another project**, which opens the start screen's Connect view.
   - A removed server entry shows "Server removed" with **Close**.

   **Who reports the title:** the renderer, through `window:reportTitle(name)`, which the server window uses instead of `window:projectChanged`.

## Conventions

- Unit tests live in `scripts/*.test.mjs` and run with `npm test`. Modules imported by tests must be erasable TS with `.ts` runtime imports. Pure helpers go in their own files so the tests can import them.
- Typechecks: `npm run typecheck`.
- App build: `npm run build`.
- The smoke test is `npm run smoke:v2`, added in Task 10. Existing smokes still to run: `npm run smoke` and `npm run smoke:windows`.
- Branch: `central-server-phase3`, base `master`, no remote.
- There is no global git identity. Commit with `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit … -- <files>`, plus the trailer of the model doing the work.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/main/windowRules.ts` | modify | `WindowTarget`, `sameTarget`, `parseOpenWindows` for both kinds |
| `src/main/recentsRules.ts` | create | `RecentEntry`, `parseRecents`, `addRecentEntry` (pure) |
| `src/main/appServersRules.ts` | create | `AppServer`, `parseAppServers`, `validateServerInput`, `withToken` (pure) |
| `src/main/appServers.ts` | create | the list and tokens on disk, IPC, Test |
| `src/main/v2relay.ts` | create | the WebSocket relay over IPC |
| `src/main/windows.ts`, `src/main/recents.ts`, `src/main/project.ts`, `src/main/index.ts` | modify | targets, server windows, recents, restore |
| `src/shared/types.ts` | modify | `InitialWindowState.server`, `RecentEntry` type, `AppServer` |
| `src/preload/index.ts` | modify | `appServers`, `v2Socket`, `openServerProject`, `reportTitle` |
| `src/renderer/src/v2/ipcSocket.ts` | create | IPC-backed `SocketFactory` |
| `src/renderer/src/v2/serverClients.ts` | create | the renderer's `ServerRegistry` over the IPC factory |
| `src/renderer/src/components/ConnectServer.tsx`, `NewServerProjectModal.tsx` | create | start screen Connect flow |
| `src/renderer/src/components/StartScreen.tsx` | modify | the third action and mixed recents |
| `src/renderer/src/v2/ServerProjectWindow.tsx` | create | read-only project view |
| `src/renderer/src/App.tsx`, `windowLifecycle.ts`, `styles.css` | modify | boot into the server window, close behaviour, styles |
| `scripts/windowRules.test.mjs`, `scripts/recentsRules.test.mjs`, `scripts/appServersRules.test.mjs`, `scripts/ipcSocket.test.mjs` | modify/create | |
| `scripts/v2-smoke.mjs`, `package.json` | create/modify | `smoke:v2` |

---

### Task 1: Window targets and `open-windows.json` (pure)

**Files:**
- Modify: `src/main/windowRules.ts`
- Test: `scripts/windowRules.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/windowRules.test.mjs`, importing `sameTarget` alongside the existing imports:

```js
test('sameTarget compares file paths and server ids', () => {
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/a.trekproj' }), true)
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/b.trekproj' }), false)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), true)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'q' }), false)
  assert.equal(sameTarget({ kind: 'file', path: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), false)
})

test('parseOpenWindows reads legacy file entries and server entries', () => {
  assert.deepEqual(parseOpenWindows([
    { filePath: '/a.trekproj', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: '', projectId: 'p2' },
    { kind: 'server', serverEntryId: 's1' },
    { kind: 'file', path: '/b.trekproj' }
  ]), [
    { target: { kind: 'file', path: '/a.trekproj' }, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { target: { kind: 'server', serverEntryId: 's1', projectId: 'p1' } },
    { target: { kind: 'file', path: '/b.trekproj' } }
  ])
})

test('serializeOpenWindow writes file entries in the legacy shape', () => {
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'file', path: '/a' } }), { filePath: '/a' })
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }), { kind: 'server', serverEntryId: 's', projectId: 'p', bounds: { x: 0, y: 0, width: 1, height: 1 } })
})
```

The existing `parseOpenWindows` tests expect `{filePath, bounds}` entries. Update them to the new `{target: {kind: 'file', path}, bounds}` shape and keep what they assert.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/windowRules.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

- [ ] **Step 3: Implement**

In `src/main/windowRules.ts`, replace `OpenWindowEntry` and `parseOpenWindows`, and add:

```ts
export type WindowTarget =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string }

/** File paths are compared as given; callers normalize them (realpath) first. */
export function sameTarget(a: WindowTarget, b: WindowTarget): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'server' && b.kind === 'server') return a.serverEntryId === b.serverEntryId && a.projectId === b.projectId
  return false
}

export interface OpenWindowEntry {
  target: WindowTarget
  bounds?: WindowBounds
}

function targetKey(t: WindowTarget): string {
  return t.kind === 'file' ? `file\0${t.path}` : `server\0${t.serverEntryId}\0${t.projectId}`
}

function readTarget(item: Record<string, unknown>): WindowTarget | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (item.kind === 'server') {
    return str(item.serverEntryId) && str(item.projectId) ? { kind: 'server', serverEntryId: item.serverEntryId, projectId: item.projectId } : null
  }
  if (item.kind === 'file') return str(item.path) ? { kind: 'file', path: item.path } : null
  return str(item.filePath) ? { kind: 'file', path: item.filePath } : null // legacy entry
}

/** Tolerates anything on disk: bad entries are dropped, and a target appears once. */
export function parseOpenWindows(raw: unknown): OpenWindowEntry[] {
  if (!Array.isArray(raw)) return []
  const entries = new Map<string, OpenWindowEntry>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const target = readTarget(item as Record<string, unknown>)
    if (!target || entries.has(targetKey(target))) continue
    const bounds = (item as { bounds?: unknown }).bounds
    entries.set(targetKey(target), isBounds(bounds) ? { target, bounds } : { target })
  }
  return [...entries.values()]
}

/** File windows keep the legacy shape so an older Trek can still read the file. */
export function serializeOpenWindow(entry: OpenWindowEntry): Record<string, unknown> {
  const bounds = entry.bounds ? { bounds: entry.bounds } : {}
  return entry.target.kind === 'file'
    ? { filePath: entry.target.path, ...bounds }
    : { kind: 'server', serverEntryId: entry.target.serverEntryId, projectId: entry.target.projectId, ...bounds }
}
```

`windows.ts` uses `parseOpenWindows`, so its call sites now get `entry.target`. Update them only as far as needed to keep file windows working, using `entry.target.kind === 'file' ? entry.target.path : undefined`. Task 6 adds server windows. The app must typecheck and `npm run smoke:windows` must pass after this task.

- [ ] **Step 4: Run the tests, typecheck and the windows smoke**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; npm run smoke:windows 2>&1 | tail -3`
Expected: `# fail 0`; clean; the windows smoke passes.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): window targets for file and server windows" -m "Co-Authored-By: <model trailer>" -- src/main/windowRules.ts src/main/windows.ts scripts/windowRules.test.mjs
```

---

### Task 2: Pure rules for recents and app servers

**Files:**
- Create: `src/main/recentsRules.ts`, `src/main/appServersRules.ts`
- Test: `scripts/recentsRules.test.mjs`, `scripts/appServersRules.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/recentsRules.test.mjs — recents of both kinds: parsing and adding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addRecentEntry, parseRecents, MAX_RECENTS } from '../src/main/recentsRules.ts'

const server = (projectId, name = 'P') => ({ kind: 'server', serverEntryId: 's', projectId, name, serverName: 'box' })

test('parseRecents keeps file paths and well-formed server entries', () => {
  assert.deepEqual(parseRecents(['/a.trekproj', 5, server('p1'), { kind: 'server', projectId: 'x' }, null]), [
    { kind: 'file', path: '/a.trekproj' },
    server('p1')
  ])
  assert.deepEqual(parseRecents('nope'), [])
})

test('addRecentEntry puts the entry first, dedupes and caps the list', () => {
  let list = []
  for (let i = 0; i < MAX_RECENTS + 2; i++) list = addRecentEntry(list, server(`p${i}`))
  assert.equal(list.length, MAX_RECENTS)
  assert.equal(list[0].projectId, `p${MAX_RECENTS + 1}`)
  list = addRecentEntry(list, server('p5', 'Renamed'))
  assert.equal(list[0].name, 'Renamed')
  assert.equal(list.filter((e) => e.projectId === 'p5').length, 1)
  assert.deepEqual(addRecentEntry([{ kind: 'file', path: '/a' }], { kind: 'file', path: '/a' }), [{ kind: 'file', path: '/a' }])
})
```

```js
// scripts/appServersRules.test.mjs — app-wide server list parsing, input checks, and hello token injection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackUrl, parseAppServers, validateServerInput, withToken } from '../src/main/appServersRules.ts'

test('parseAppServers keeps valid entries once', () => {
  assert.deepEqual(parseAppServers([
    { id: 'a', name: 'Box', url: 'wss://box.example:7400' },
    { id: 'a', name: 'Dup', url: 'wss://x' },
    { id: 'b', name: 'Bad', url: 'http://x' },
    { id: '', name: 'No id', url: 'ws://x' },
    'junk'
  ]), [{ id: 'a', name: 'Box', url: 'wss://box.example:7400' }])
})

test('validateServerInput', () => {
  assert.deepEqual(validateServerInput({ name: ' Box ', url: ' wss://box:7400 ' }), { name: 'Box', url: 'wss://box:7400' })
  assert.throws(() => validateServerInput({ name: '', url: 'wss://x' }), /name/)
  assert.throws(() => validateServerInput({ name: 'x', url: 'https://x' }), /ws:\/\/ or wss:\/\//)
  assert.throws(() => validateServerInput({ name: 'x', url: 'not a url' }), /URL/)
  assert.throws(() => validateServerInput({ name: 'x'.repeat(201), url: 'wss://x' }), /name/)
})

test('isLoopbackUrl', () => {
  assert.equal(isLoopbackUrl('ws://127.0.0.1:7400'), true)
  assert.equal(isLoopbackUrl('ws://localhost:7400'), true)
  assert.equal(isLoopbackUrl('ws://[::1]:7400'), true)
  assert.equal(isLoopbackUrl('ws://box.tailnet:7400'), false)
})

test('withToken sets the token on hello frames only', () => {
  assert.deepEqual(JSON.parse(withToken(JSON.stringify({ type: 'hello', protocolVersion: 2, token: '' }), 'secret')), { type: 'hello', protocolVersion: 2, token: 'secret' })
  const req = JSON.stringify({ type: 'req', id: 1, method: 'sys.ping', params: { token: 'x' } })
  assert.equal(withToken(req, 'secret'), req)
  assert.equal(withToken('not json', 'secret'), 'not json')
})
```

- [ ] **Step 2: Run them to verify they fail, then implement**

`src/main/recentsRules.ts`:

```ts
// Recent projects of both kinds, as stored in recent-projects.json. Pure.
export const MAX_RECENTS = 8

export type RecentEntry =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string; name: string; serverName: string }

export function parseRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RecentEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) out.push({ kind: 'file', path: item })
    else if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'server') {
      const r = item as Record<string, unknown>
      if ([r.serverEntryId, r.projectId, r.name, r.serverName].every((v) => typeof v === 'string' && v !== '')) {
        out.push({ kind: 'server', serverEntryId: r.serverEntryId as string, projectId: r.projectId as string, name: r.name as string, serverName: r.serverName as string })
      }
    }
  }
  return out
}

function sameEntry(a: RecentEntry, b: RecentEntry): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'server' && b.kind === 'server') return a.serverEntryId === b.serverEntryId && a.projectId === b.projectId
  return false
}

export function addRecentEntry(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((e) => !sameEntry(e, entry))].slice(0, MAX_RECENTS)
}

/** File entries stay plain strings on disk, so an older Trek can still read them. */
export function serializeRecents(list: readonly RecentEntry[]): unknown[] {
  return list.map((e) => (e.kind === 'file' ? e.path : e))
}
```

`src/main/appServersRules.ts`:

```ts
// The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
export interface AppServer {
  /** Client-side id */
  id: string
  name: string
  url: string
}

const MAX_NAME = 200

function wsUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

export function parseAppServers(raw: unknown): AppServer[] {
  if (!Array.isArray(raw)) return []
  const out: AppServer[] = []
  const ids = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || ids.has(id)) continue
    if (typeof name !== 'string' || !name || typeof url !== 'string' || !wsUrl(url)) continue
    ids.add(id)
    out.push({ id, name, url })
  }
  return out
}

export function validateServerInput(input: { name: unknown; url: unknown }): { name: string; url: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1–${MAX_NAME} characters`)
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('URL is not valid')
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('URL must start with ws:// or wss://')
  return { name, url }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** The relay's only change to outgoing frames: a hello carries the stored token. */
export function withToken(text: string, token: string): string {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return text
  }
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'hello') return text
  return JSON.stringify({ ...(frame as object), token })
}
```

- [ ] **Step 3: Run the tests and typecheck, then commit**

```bash
npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck
git add src/main/recentsRules.ts src/main/appServersRules.ts scripts/recentsRules.test.mjs scripts/appServersRules.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): pure rules for mixed recents, app servers and hello tokens" -m "Co-Authored-By: <model trailer>" -- src/main/recentsRules.ts src/main/appServersRules.ts scripts/recentsRules.test.mjs scripts/appServersRules.test.mjs
```

---

### Task 3: App-wide servers in main

**Files:**
- Create: `src/main/appServers.ts`
- Modify: `src/main/index.ts` (register), `src/shared/types.ts`, `src/preload/index.ts`

- [ ] **Step 1: Implement**

`src/main/appServers.ts` holds the list in memory, backed by `userData/app-servers.json` through `parseAppServers` and an atomic write. Tokens go in `createSecretStore('app-server-tokens.json')` from `./secrets`. Read `secrets.ts` for its API.

Export these for other main modules:

```ts
export function listAppServers(): AppServer[]
export function getAppServer(id: string): AppServer | undefined
export async function getAppServerToken(id: string): Promise<string | null>
export function registerAppServerHandlers(): void
```

IPC handlers, all `ipcMain.handle`:

| Channel | Behaviour |
|---|---|
| `appServers:list` | Returns `(AppServer & { hasToken: boolean })[]`. |
| `appServers:save({ id?, name, url, token? })` | Validates through `validateServerInput`. Without an `id`, creates the entry with `randomUUID()`; with one, updates it (unknown → error). If `token` is a non-empty string, stores it. Writes the file and returns the entry. |
| `appServers:setToken(id, token)` | Unknown id → error. An empty token clears it. |
| `appServers:remove(id)` | Removes the entry and its token, and closes any relay sockets for it through `v2relay.closeForServer(id)` (Task 4). |
| `appServers:test(id)` | See below. |

`appServers:test(id)` does a one-shot check using the 3a SDK in main:
1. Create `new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'trek-desktop-test', clientVersion: app.getVersion() })` and call `connect()`.
2. Resolve on the first `connected`, `needs-auth`, `incompatible`, or an `error`/`disconnected` after it has tried. Give up after 8 s.
3. Return `{ status, message, serverName?, daemonVersion?, capabilities? }`.
4. Always `close()` the connection.

With no token stored, return `{status: 'needs-auth', message: 'No token set'}` without connecting.

Register the handlers in `src/main/index.ts` next to the other `register…` calls.

In `src/shared/types.ts`:
- export `AppServerInfo { id: string; name: string; url: string; hasToken: boolean }`;
- export `AppServerTest { status: string; message: string; serverName?: string; daemonVersion?: string; capabilities?: string[] }`.

In `src/preload/index.ts`, add an `appServers` group to `api` with `list`, `save`, `setToken`, `remove` and `test`. Follow the existing invoke style.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`

- [ ] **Step 3: Commit**

```bash
git add src/main/appServers.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): app-wide trek-server list with tokens in safeStorage" -m "Co-Authored-By: <model trailer>" -- src/main/appServers.ts src/main/index.ts src/shared/types.ts src/preload/index.ts
```

There is no unit test here. The rules it depends on were tested in Task 2, and the smoke test in Task 10 drives it end to end.

---

### Task 4: The WebSocket relay in main

**Files:**
- Create: `src/main/v2relay.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`

- [ ] **Step 1: Implement**

`src/main/v2relay.ts`:

```ts
// Each v2 window's WebSockets live here, in main: the renderer asks by server
// entry id, main injects the stored token into hello, and events go only to
// the window that opened the socket. The renderer never sees a token or opens
// a socket itself, so its CSP stays strict.
import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { withToken } from './appServersRules'
import { getAppServer, getAppServerToken } from './appServers'

interface RelaySocket {
  id: string
  serverEntryId: string
  owner: WebContents
  ws: WebSocket
  token: string
}

const sockets = new Map<string, RelaySocket>()
/** Windows that already close their sockets when destroyed */
const watched = new WeakSet<WebContents>()

function emit(s: RelaySocket, event: Record<string, unknown>): void {
  if (!s.owner.isDestroyed()) s.owner.send('v2socket:event', { socketId: s.id, ...event })
}

export function closeForServer(serverEntryId: string): void {
  for (const s of [...sockets.values()]) if (s.serverEntryId === serverEntryId) s.ws.close(1000, 'server removed')
}

export function registerV2Relay(): void {
  ipcMain.handle('v2socket:open', async (event, serverEntryId: unknown) => {
    if (typeof serverEntryId !== 'string') throw new Error('serverEntryId is required')
    const server = getAppServer(serverEntryId)
    if (!server) throw new Error('Server removed')
    const token = (await getAppServerToken(serverEntryId)) ?? ''
    const owner = event.sender
    const ws = new WebSocket(server.url)
    const s: RelaySocket = { id: randomUUID(), serverEntryId, owner, ws, token }
    sockets.set(s.id, s)
    ws.addEventListener('open', () => emit(s, { type: 'open' }))
    ws.addEventListener('message', (e) => emit(s, { type: 'message', data: String(e.data) }))
    ws.addEventListener('error', () => emit(s, { type: 'error' }))
    ws.addEventListener('close', (e) => {
      sockets.delete(s.id)
      emit(s, { type: 'close', code: e.code, reason: e.reason })
    })
    if (!watched.has(owner)) {
      watched.add(owner)
      owner.once('destroyed', () => {
        for (const other of [...sockets.values()]) if (other.owner === owner) other.ws.close(1000, 'window closed')
      })
    }
    return s.id
  })

  ipcMain.on('v2socket:send', (event, socketId: unknown, text: unknown) => {
    const s = typeof socketId === 'string' ? sockets.get(socketId) : undefined
    if (!s || s.owner !== event.sender || typeof text !== 'string') return
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(withToken(text, s.token))
  })

  ipcMain.on('v2socket:close', (event, socketId: unknown, code: unknown, reason: unknown) => {
    const s = typeof socketId === 'string' ? sockets.get(socketId) : undefined
    if (!s || s.owner !== event.sender) return
    const valid = typeof code === 'number' && (code === 1000 || (code >= 3000 && code <= 4999))
    s.ws.close(valid ? code : 1000, typeof reason === 'string' ? reason : '')
  })
}
```

`WebSocket.close()` throws for codes other than 1000 and 3000–4999, so the relay clamps them. The SDK's 4000 is valid.

In `src/main/index.ts`, call `registerV2Relay()`.

In `src/preload/index.ts`, add to `api`:

```ts
v2Socket: {
  open: (serverEntryId: string): Promise<string> => ipcRenderer.invoke('v2socket:open', serverEntryId),
  send: (socketId: string, text: string): void => ipcRenderer.send('v2socket:send', socketId, text),
  close: (socketId: string, code?: number, reason?: string): void => ipcRenderer.send('v2socket:close', socketId, code, reason),
  onEvent: (callback: (event: { socketId: string; type: 'open' | 'message' | 'close' | 'error'; data?: string; code?: number; reason?: string }) => void): (() => void) =>
    subscribe('v2socket:event', callback)
},
```

Use the same `subscribe` helper as the rest of the preload.

- [ ] **Step 2: Typecheck and build, then commit**

```bash
npm run typecheck && npm run build 2>&1 | tail -3
git add src/main/v2relay.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): relay v2 WebSockets through main with the token injected" -m "Co-Authored-By: <model trailer>" -- src/main/v2relay.ts src/main/index.ts src/preload/index.ts
```

---

### Task 5: The IPC-backed socket in the renderer

**Files:**
- Create: `src/renderer/src/v2/ipcSocket.ts`, `src/renderer/src/v2/serverClients.ts`
- Test: `scripts/ipcSocket.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/ipcSocket.test.mjs — the renderer's SocketLike over the main-process relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ipcSocketFactory } from '../src/renderer/src/v2/ipcSocket.ts'

function fakeApi() {
  const sent = []
  const closed = []
  let listener = () => {}
  let openResolve
  let openReject
  const api = {
    open: (entryId) => new Promise((res, rej) => { openResolve = res; openReject = rej; sent.push(['open', entryId]) }),
    send: (id, text) => sent.push(['send', id, text]),
    close: (id, code, reason) => closed.push([id, code, reason]),
    onEvent: (cb) => { listener = cb; return () => { listener = () => {} } }
  }
  return { api, sent, closed, fire: (e) => listener(e), resolveOpen: (id) => openResolve(id), rejectOpen: (err) => openReject(err) }
}

const flush = () => new Promise((r) => setImmediate(r))

test('open, message, send and close round-trip through the relay', async () => {
  const f = fakeApi()
  const factory = ipcSocketFactory(f.api)
  const sock = factory('entry-1')
  const log = []
  sock.addEventListener('open', () => log.push('open'))
  sock.addEventListener('message', (e) => log.push(['message', e.data]))
  sock.addEventListener('close', (e) => log.push(['close', e.code, e.reason]))
  assert.equal(sock.readyState, 0)
  assert.deepEqual(f.sent[0], ['open', 'entry-1'])
  f.resolveOpen('sock-9')
  await flush()
  f.fire({ socketId: 'other', type: 'open' })
  f.fire({ socketId: 'sock-9', type: 'open' })
  assert.equal(sock.readyState, 1)
  sock.send('{"type":"hello"}')
  assert.deepEqual(f.sent[1], ['send', 'sock-9', '{"type":"hello"}'])
  f.fire({ socketId: 'sock-9', type: 'message', data: '{"type":"welcome"}' })
  sock.close(4000, 'bye')
  assert.deepEqual(f.closed, [['sock-9', 4000, 'bye']])
  f.fire({ socketId: 'sock-9', type: 'close', code: 4000, reason: 'bye' })
  assert.equal(sock.readyState, 3)
  assert.deepEqual(log, ['open', ['message', '{"type":"welcome"}'], ['close', 4000, 'bye']])
})

test('send before open throws, like a WebSocket; a failed open closes with 1006', async () => {
  const f = fakeApi()
  const sock = ipcSocketFactory(f.api)('missing')
  assert.throws(() => sock.send('x'))
  const closes = []
  sock.addEventListener('close', (e) => closes.push([e.code, e.reason]))
  f.rejectOpen(new Error('Server removed'))
  await flush()
  assert.equal(sock.readyState, 3)
  assert.deepEqual(closes, [[1006, 'Server removed']])
})

test('close before the relay answers closes the socket once it exists', async () => {
  const f = fakeApi()
  const sock = ipcSocketFactory(f.api)('e')
  sock.close(1000, 'early')
  f.resolveOpen('s1')
  await flush()
  assert.deepEqual(f.closed, [['s1', 1000, 'early']])
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

`src/renderer/src/v2/ipcSocket.ts`:

```ts
// A SocketLike over the main-process relay (src/main/v2relay.ts): the "url" the
// SDK passes is the app-server entry id. Pure: the relay API is injected.
import type { SocketFactory, SocketLike } from '../../../shared/client/socket.ts'

export interface RelayApi {
  open(serverEntryId: string): Promise<string>
  send(socketId: string, text: string): void
  close(socketId: string, code?: number, reason?: string): void
  onEvent(cb: (e: { socketId: string; type: string; data?: string; code?: number; reason?: string }) => void): () => void
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export function ipcSocketFactory(api: RelayApi): SocketFactory {
  return (serverEntryId) => {
    const listeners: Record<string, Array<(e: any) => void>> = { open: [], message: [], close: [], error: [] }
    let socketId: string | null = null
    let pendingClose: { code?: number; reason?: string } | null = null
    let unsubscribe: (() => void) | null = null
    const dispatch = (type: string, e: unknown) => {
      for (const l of [...listeners[type]]) l(e)
    }
    const finish = (code: number, reason: string) => {
      if (sock.readyState === CLOSED) return
      sock.readyState = CLOSED
      unsubscribe?.()
      dispatch('close', { code, reason })
    }
    const sock: SocketLike & { readyState: number } = {
      readyState: CONNECTING,
      send(data) {
        if (sock.readyState !== OPEN || !socketId) throw new Error('WebSocket is not open')
        api.send(socketId, data)
      },
      close(code, reason) {
        if (sock.readyState === CLOSED || sock.readyState === CLOSING) return
        sock.readyState = CLOSING
        if (socketId) api.close(socketId, code, reason)
        else pendingClose = { code, reason }
      },
      addEventListener(type: string, listener: (e: any) => void) {
        listeners[type]?.push(listener)
      }
    } as SocketLike & { readyState: number }
    unsubscribe = api.onEvent((e) => {
      if (e.socketId !== socketId) return
      if (e.type === 'open' && sock.readyState === CONNECTING) {
        sock.readyState = OPEN
        dispatch('open', {})
      } else if (e.type === 'message') dispatch('message', { data: e.data ?? '' })
      else if (e.type === 'error') dispatch('error', {})
      else if (e.type === 'close') finish(e.code ?? 1006, e.reason ?? '')
    })
    api.open(serverEntryId).then(
      (id) => {
        socketId = id
        if (pendingClose) api.close(id, pendingClose.code, pendingClose.reason)
      },
      (err: Error) => {
        dispatch('error', {})
        finish(1006, err.message)
      }
    )
    return sock
  }
}
```

`src/renderer/src/v2/serverClients.ts` holds one renderer-wide `ServerRegistry` from the 3a SDK, created on first use. Use `createSocket: ipcSocketFactory(window.api.v2Socket)`, `client: 'trek-desktop'` and `clientVersion` from the app.

Export `connectServerEntry(entryId)`. It returns the registered server, adding it if missing with `{id: entryId, url: entryId, token: ''}`. The url is the entry id, which the IPC factory sends to main. Also export `dropServerEntry(entryId)`.

Since the relay injects the real token, a token change in the start screen must call `connection.reconnect()` on the entry; the SDK token stays `''`.

- [ ] **Step 3: Run the tests and typecheck, then commit**

```bash
node --test scripts/ipcSocket.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck
git add src/renderer/src/v2/ipcSocket.ts src/renderer/src/v2/serverClients.ts scripts/ipcSocket.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): IPC-backed socket for the renderer's client SDK" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/ipcSocket.ts src/renderer/src/v2/serverClients.ts scripts/ipcSocket.test.mjs
```

---

### Task 6: Server windows in main

**Files:**
- Modify: `src/main/windows.ts`, `src/main/recents.ts`, `src/main/project.ts`, `src/main/index.ts`, `src/shared/types.ts`, `src/preload/index.ts`

- [ ] **Step 1: Implement**

- **`windows.ts`:**
  - `WindowState` gets `target: WindowTarget | null` in place of `filePath` and `hasProject`. File targets hold the normalized path.
  - `createWindow` takes `{ initialTarget?: WindowTarget; menu?; bounds? }`. Callers that pass `initialProject` move to `initialTarget: {kind: 'file', path}`.
  - Lookups (`windowHoldingFile` and friends) compare with `sameTarget`, and add `windowHolding(target)`.
  - `open-windows.json` writes `serializeOpenWindow` for every window with a target. Restore opens both kinds:
    - skip file targets whose file is missing;
    - restore server targets even if the entry is gone, because the window shows "Server removed".
  - `window:takeInitial` returns `{ opened, menu, server }`:
    - for a server target, `server` is `{serverEntryId, projectId}` and `opened` is null;
    - for files, it behaves as today, with `server: null`.
- **IPC:**
  - `window:openServerProject(serverEntryId, projectId, name, serverName)`. It uses `decideOpen(senderHasTarget, alreadyOpen)` with `sameTarget`, mirroring `openForSender` in `project.ts`, and returns:
    - **focus-existing:** focuses that window and returns `{ opened: false }`;
    - **new-window:** creates a window with that target, adds the recent, and returns `{ opened: false }`;
    - **use-sender:** claims the target for the sender, adds the recent, and returns `{ opened: true }`. The renderer then boots into the server view.
  - `window:reportTitle(name)` sets the window title.
- **`recents.ts`:**
  - Read with `parseRecents` and write with `serializeRecents`.
  - `getRecents` drops missing files only.
  - Add `addRecentServer(entry)` and keep `addRecent(filePath)`.
  - The `recents:get` IPC returns `RecentEntry[]`.
  - Export the `RecentEntry` type through `src/shared/types.ts` (re-export from `recentsRules`, or duplicate the type there and import it into `recentsRules` — whichever keeps the erasable-TS rule).
- **`src/shared/types.ts`:** `InitialWindowState` gains `server: { serverEntryId: string; projectId: string } | null`.
- **Preload:**
  - add `openServerProject(serverEntryId, projectId, name, serverName): Promise<{opened: boolean}>` and `reportTitle(name)`;
  - `getRecentProjects` now returns `RecentEntry[]`.
- **Renderer start screen:** adapt it to the new recents shape. A file entry opens as before. A server entry calls `openServerProject` (Task 7 renders it).

Keep every file-window behaviour exactly as it is: focus, Save As refusal, close prompts, quit save and restore. `npm run smoke:windows` must pass unchanged.

- [ ] **Step 2: Test, typecheck, build and the windows smoke**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck && npm run build 2>&1 | tail -2; npm run smoke:windows 2>&1 | tail -3; npm run smoke 2>&1 | tail -2`
Expected: everything passes.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows — open, focus, recents and restore" -m "Co-Authored-By: <model trailer>" -- src/main/windows.ts src/main/recents.ts src/main/project.ts src/main/index.ts src/shared/types.ts src/preload/index.ts src/renderer/src/components/StartScreen.tsx
```

---

### Task 7: The Connect to server flow and New Project dialog

**Files:**
- Create: `src/renderer/src/components/ConnectServer.tsx`, `src/renderer/src/components/NewServerProjectModal.tsx`
- Modify: `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/styles.css`

- [ ] **Step 1: Implement**

**`StartScreen.tsx`:**
- Add a third button, **Connect to server…**, which sets `view = 'connect'` and renders `<ConnectServer onBack={...} />` in place of the main actions.
- Recents render both kinds:
  - a file entry looks as it does today;
  - a server entry shows `.recent-name` = `name` and `.recent-path` = `serverName`, plus a `server` mini-chip, and clicking it calls `window.api.openServerProject(...)`.

**`ConnectServer.tsx`.** Use the existing class names (`.start-screen`, `.recent-projects`, `button.primary`, `.error`, `wt-dot` status dots, `.modal…`) and add only small CSS.

On mount:
- load `window.api.appServers.list()`;
- for each entry, `connectServerEntry(id)`, and subscribe to its connection `status` to show a dot: connected → `done`, connecting → `running`, else `exited`, with the status message as a tooltip and as small text;
- on unmount, unsubscribe the listeners. Leave connections open for reuse; they live in the renderer-wide registry.

**Each server row:**
- name, URL, the dot and the status text;
- **Projects** (selects the server);
- **Set token** (an inline password field: `appServers.setToken`, then `connection.reconnect()`);
- **Test** (`appServers.test(id)`, then show the result inline);
- **Remove** (`window.api.confirm`, then `appServers.remove`, `dropServerEntry`, and refresh).

**Add server:**
- an inline form with name, URL and token, plus Save, which calls `appServers.save`;
- a muted warning under the URL when it is `ws://` to a non-loopback host: "Unencrypted — use wss:// unless this is a private network";
- validation errors from main show in `.error`.

**Selected server:**
- subscribe to the `server` topic through `registered.mirror.subscribe('server', …)`, and list `snapshot.projects` (`{id, name}`) with **Open** buttons;
- **Open** calls `window.api.openServerProject(entryId, projectId, name, welcome.serverName)`. If `{opened: true}`, set the store flag that switches `App` into the server window (Task 8 adds it);
- show **New Project…**, which opens the modal;
- if the server isn't connected, show its status and disable the buttons.

**`NewServerProjectModal.tsx`:**
- **Fields:** a name, one checkbox per `snapshot.repos` entry (`{id, name, path}`), and **Add repo by path…**.
- **Add repo by path…:**
  - a text field plus Add, which calls `request('server.addRepo', { path })`;
  - on success, tick the returned `repoId` (the `server` topic patch adds the repo to the list);
  - on `PATH_DENIED` or `NOT_A_REPO`, show the message plus "Run `trek-server add <path>` on the server".
- **Create:**
  - disabled until the name is non-empty and at least one repo is ticked;
  - calls `request('project.create', { name, repositories: ticked.map((r) => ({ path: r.path })) })`, then opens the project as **Open** does.
- **Layout:** the `modal-backdrop`/`modal` pattern from `AddWorktreeModal.tsx`, with Escape and Cancel to close.

**Shared:**
- Pull the error-message helper that turns a `ClientError` code and message into display text into a small shared function.
- Every request is awaited with its error shown. Nothing is fire-and-forget.

- [ ] **Step 2: Typecheck and build, then commit**

```bash
npm run typecheck && npm run build 2>&1 | tail -2
git add src/renderer/src/components/ConnectServer.tsx src/renderer/src/components/NewServerProjectModal.tsx
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): Connect to server and New Project on a server" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/ConnectServer.tsx src/renderer/src/components/NewServerProjectModal.tsx src/renderer/src/components/StartScreen.tsx src/renderer/src/styles.css
```

---

### Task 8: The read-only server window

**Files:**
- Create: `src/renderer/src/v2/ServerProjectWindow.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/windowLifecycle.ts`, `src/renderer/src/store.ts` (one field), `src/renderer/src/styles.css`

- [ ] **Step 1: Implement**

**Store** (`store.ts`): add `serverWindow: { serverEntryId: string; projectId: string } | null` (default null) and a setter. It is separate from `project`, which stays the legacy file model. A window is either one or the other.

**`App.tsx`:**
- `takeInitialWindowState()` now also returns `server`. If it is set, call `setServerWindow(server)`.
- When `ConnectServer`'s Open gets `{opened: true}`, it also calls `setServerWindow`.
- The body renders `serverWindow ? <ServerProjectWindow {...serverWindow} /> : project ? <Workspace/>… : <StartScreen/>`.
- The title bar shows the server project's name. `ServerProjectWindow` passes it up through the store or a callback, and calls `window.api.reportTitle(name)`.

**`windowLifecycle.ts`:** in the close-request handler, if `serverWindow` is set, call `closeReady()` at once (decision 6).

**`ServerProjectWindow.tsx`:**
- **Server entry.** Look it up with `window.api.appServers.list()`. If it's missing, show "Server removed" and a **Close** button (`window.close()`).
- **Connection.** Otherwise `connectServerEntry(entryId)`, subscribe to `status`, and `mirror.subscribe(\`project:${projectId}\`, …)`.
- **Banner.** When the status isn't `connected`, show a banner with the status, the message and "last seen `<time>`". Record `lastSeen` whenever a snapshot arrives. The tree stays visible.
- **Not found.** A `NOT_FOUND` error shows "Project not found on `<serverName>`", with **Close** and **Pick another project**.
  - **Pick another project** clears `serverWindow` and opens the start screen's Connect view on that server.
  - Pass the server through a small store field, or a prop on `StartScreen`.
  - Main's claim on this target must be released. Send `window:reportTitle('Trek')`, and add a `window:releaseTarget` IPC so the window can take a new target. Implement it in `windows.ts`.
- **The tree:**
  - one section per repository: a `.repo-header` with the name, then each worktree as a row showing:
    - `branch ?? name`;
    - a `missing` tag;
    - dirty, ahead and behind (as the legacy sidebar shows them);
    - `loaded`;
  - under each worktree, its sessions with title and a status dot in the legacy colours (`working` → running, `attention` → attention, `done` → done, `exited` → exited, idle or complete → idle);
  - a "Global" section for `globalSessions`.
- **Styling.** Reuse the legacy sidebar classes (`.repo-section`, `.wt-row`, `wt-dot`) where they fit. This view is read-only; 3c replaces it with the real `Sidebar`/`Workspace` driven by the mirror.

- [ ] **Step 2: Typecheck, build and the existing smokes, then commit**

```bash
npm run typecheck && npm run build 2>&1 | tail -2; npm run smoke 2>&1 | tail -2; npm run smoke:windows 2>&1 | tail -2
git add src/renderer/src/v2/ServerProjectWindow.tsx
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): read-only server project window" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/ServerProjectWindow.tsx src/renderer/src/App.tsx src/renderer/src/windowLifecycle.ts src/renderer/src/store.ts src/renderer/src/styles.css src/main/windows.ts src/preload/index.ts
```

---

### Task 9: Docs

- [ ] In `README.md`'s desktop section, add a short **Servers and server projects** subsection covering:
  - the app-wide server list, with tokens in the OS keychain through safeStorage;
  - **Connect to server…**, and **New Project** on a server (registered repos, plus **Add repo by path…**);
  - server windows: they focus if already open, appear in recents, are restored on launch, and close with no prompt because sessions stay on the server;
  - that main relays the connection, so tokens never reach the window;
  - that server windows are read-only until the next update (3c).

  Then commit with `-- README.md`.

---

### Task 10: The v2 desktop smoke test

**Files:**
- Create: `scripts/v2-smoke.mjs`
- Modify: `package.json` (`"smoke:v2": "npm run build && npm --prefix server run build && node scripts/v2-smoke.mjs"`)

- [ ] **Step 1: Write it**

**Setup.** Read `scripts/windows-smoke.mjs` for how it launches Electron with Playwright and a temp `--user-data-dir`. Read `scripts/client-contract.mjs` for how it starts a built `trek-server` with a temp config, a repo, a token and a fake agent. Combine them.

**Check, in order, through the DOM and `window.api`:**
1. **Start and add a server.** Start `trek-server` on a free loopback port. Launch the app with a temp user-data dir and `TREK_NO_WINDOW_RESTORE` unset. Click **Connect to server…**, add the server (name, `ws://127.0.0.1:<port>` and the token), and wait for its dot to show connected.
2. **Create a project.** Click **Projects** and **New Project…**, enter a name, tick the registered repo and click **Create**. The window becomes the server window: the title shows the project name, and the tree shows the repo with its `main` worktree.
3. **Live updates.** From the test, create a worktree through a separate SDK connection (`worktree.create`, like the contract script). The window's tree shows the new worktree without a reload.
4. **Focus instead of reopening.** Open a second window (File → New Window, or `createWindow` via `app.evaluate`). In it, use Connect → Projects → **Open** on the same project. No third window appears and the first window is focused (check through `BrowserWindow.getFocusedWindow()`).
5. **Recents.** A fresh empty window's start screen lists the project by name with a `server` chip and the server name beneath it.
6. **Restore.** Quit the app and relaunch it with the same user-data dir. The server window comes back and shows the tree.
7. **Disconnect.** Stop `trek-server`. The window shows the disconnected banner and the tree stays visible.
8. **Bad token.** Add a second server entry with a wrong token. Its dot shows needs-auth.
9. **No console errors** in any window. Collect `page.on('console')` errors as `scripts/smoke.mjs` does.

Print `V2 SMOKE PASS` or `V2 SMOKE FAIL` and set the exit code accordingly. Bound every wait.

- [ ] **Step 2: Run it**

Run: `npm run smoke:v2 2>&1 | tail -20`
Expected: `V2 SMOKE PASS`.

If a step fails because of an app bug, fix the bug in the right file, explain it in the report, and re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/v2-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(app): v2 server window smoke" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs package.json
```

---

## Final verification

- [ ] `npm test` gives `# fail 0`.
- [ ] `npm run typecheck` and `npm run build` are clean.
- [ ] `npm run smoke`, `npm run smoke:windows`, `npm run smoke:client` and `npm run smoke:v2` all pass.
