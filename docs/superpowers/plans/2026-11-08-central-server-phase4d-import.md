# Central server phase 4d: importing legacy `.trekproj` projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Existing projects move onto servers.
1. **A `.trekproj` is split by server and each piece is imported where it lived.** The part on this machine becomes a project on the Local server; each part on a remote server becomes a project on the app-server entry at that server's address (`project.import`). Repositories are registered first (`server.addRepo`).
2. **Opening a `.trekproj` imports it** (File → Open Project…, a recent, the start screen, Finder's `open-file`), or opens the projects it already became (`migrated.json`). A file window opens only as the fallback when no part could be imported.
3. **File → Import .trekproj…** always imports (Import Again for a file imported before), and a result dialog lists the parts, what was left and every warning.
4. **A one-time first-launch prompt** offers to import the files of the recents and of the windows open at the last quit; those windows then come back on their server projects.
5. **Recents and the restored windows are rewritten** to `(serverEntryId, projectId)`. The original file is never written.
6. **Legacy server tokens move with their projects, origin-bound only**: a v1 token goes to an app-server entry only when it was entered for that entry's origin.
7. **Nothing that worked is lost on the way**: a Local repository's Colima VMs keep their names (4c Note 1), and a saved Claude session still resumes when the server runs it from its realpath (its history is copied there).
8. **`smoke:import`** (new, 39 checks) runs all of it against the Local server and a test trek-server.

**Architecture:**
- **Pure rules, `src/main/importRules.ts`** (Tasks 1, 2, 6): where a piece goes (`routePiece`), the `migrated.json` format (`parseMigrated`, `recordImport`), the recents and window rewrites (`rewriteRecents`, `rewriteOpenWindows`, `restoreEntries`), the prompt's file list (`promptCandidates`), the path rules (`profileKeyFor`, `withProfileKeys`, `movedSessions`, `worktreeInError`, `dropWorktree`) and the result text (`importSummary`).
- **The importer, `src/main/importer.ts`** (Task 5), over main's own connections (`serverLink`, `serverLinks.ts`): the token never leaves main. Per piece: route it, wait for the link, `server.addRepo` each repository, add the Local profile keys, `project.import` (dropping a worktree the server refuses by path, and sending again), read the project back from main's mirror, copy the Claude histories of sessions whose path moved (Local) or warn (remote). Then `migrated.json` and recents.
- **The UI, `src/main/importUi.ts`** (Tasks 6–8): File → Import, `openTrekproj` (what every open of a `.trekproj` goes through), `openFromOs`, the add-server question, the result dialog, the first-launch prompt. Server windows a main-side import opens in an empty window are announced to its renderer (`window:showServer`).
- **Stores** (Task 4): `src/main/migrated.ts` (`userData/migrated.json`, chained atomic writes, keyed by realpath); `recents.ts`' `rewriteRecentsForImport`; `restoreWindows` maps a window on an imported file to its Local piece.
- **The VM names** (Task 2): `EnvironmentSettings.profileKey` keeps the path the file had; `envRepoKey(repo)` is what every environment call site hashes now.
- **Tokens** (Task 3): `adoptableToken` (pure), `legacyTokenFor` (servers.ts), `addAppServer` and `adoptAppServerToken` (appServers.ts), all main-only.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), Electron 43 (`dialog`, `open-file`, `fileAssociations`), the `src/shared/client` SDK (main's `ServerRegistry` links and their `TopicMirror`), `node --test`, Playwright's `_electron` (with `-r <stub>` to stub main's dialogs).

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, "Import and retiring legacy windows (phase 4)": "each file is split by server and each piece is sent to its server with `project.import`. Recents and `open-windows.json` entries are rewritten to `(serverId, projectId)`. The original files are not touched." Builds on the 4c plan (`docs/superpowers/plans/2026-11-08-central-server-phase4c-local-features.md`), whose "Notes for 4d" 1–4 are covered by Decisions 13–15.

---

## Roadmap: phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–3** (done) | protocol v2, the server registry, projects, git, sessions, status, MCP; server windows; attention across servers | Projects on servers open in their own windows. |
| **4a server `--local`** (done) | `trek-server start --local` / `stop --local`, its profile, pid lock, `local.json`, the `local` capability | None in the app. |
| **4b bundling and supervisor** (done) | `out/server`; the supervisor; the synthetic `local` entry; File → Local Server | A Local server appears by itself. |
| **4c features on Local** (done, master at `e015701`) | Docker, environments, stacks, skills, VS Code/Reveal on Local; Linear everywhere | Local windows do what file windows did. |
| **4d import** (this plan) | <ul><li>`importRules.ts`, `importer.ts`, `importUi.ts`, `migrated.json`</li><li>File → Import .trekproj…; opening a `.trekproj` imports it or opens what it became; Finder's `open-file` and `fileAssociations`</li><li>the first-launch prompt; recents and restored windows rewritten</li><li>v1 tokens carried, origin-bound</li><li>`profileKey` for VM names; Claude histories copied to realpaths</li><li>`smoke:import`; README</li></ul> | Existing projects move onto servers. |
| **4e start screen and retirement** | the start screen becomes Open on server…, New Project… (Local first) and Import .trekproj…; file windows and the legacy code deleted (the fallback of Decision 2 with them); the bot stays dormant; the legacy smokes rewritten or retired | Every project lives on a server. |

Out of scope here: the start screen's buttons (4e), deleting file windows (4e), drag and drop of files (Decision 9), anything bot-related (phase 5).

---

## Decisions

### Recorded (user decisions)

1. **Opening a `.trekproj` imports it**: double-click (`open-file`), a recent and File → Open. A file imported before opens the projects it became (`migrated.json`). The original file is never changed. File → **Import .trekproj…** and a **one-time first-launch prompt** covering recents and restored windows.

### Decided in this plan

**Opening a `.trekproj` during 4d (Tasks 6, 7)**

2. **Import, then open the server windows. A file window only as an offered fallback.** `openTrekproj` (importUi.ts) is what `project:open`, `project:openPath` and `open-file` go through:
   - imported before: open its pieces (Local's in the asking window when that is empty); if a part was left, offer to import it now;
   - not imported: import, show the result, open the pieces;
   - **no part landed**: the result dialog offers **Open as File Window** or Cancel. Recommended over an automatic fallback: a file window for a file that was meant to move would quietly fork the project, and over no fallback: until 4e a file whose Local part cannot land (Local off, not starting) would otherwise not open at all;
   - **a file already open in a file window** is focused there, as before; it is not imported underneath a window that may have unsaved changes (File → Import closes that window first, Decision 3);
   - **without the Local server** (`TREK_NO_LOCAL_SERVER`, which the legacy smokes set), a `.trekproj` opens as a file window as before, and the prompt does not run. There is nowhere to import this machine's part to.
3. **File → Import .trekproj… on a file open in a file window asks that window to close first** (`closeFileWindow`: its renderer's save prompt runs). Cancelled, nothing is imported. So the import reads what was saved, and the same worktrees are never driven by a file window and a server window at once. The server window takes the closed window's bounds.
4. **A main-side open can use the empty window that asked.** `openServerTarget` (extracted from `window:openServerProject`) gains `announce`: when it takes the sender, main sends `window:showServer`, and App.tsx switches an empty window to the project. Only a window whose renderer is listening is taken; anything else gets a new window. The IPC return types of `project:open` / `project:openPath` are unchanged (`OpenedProject | null`), so the legacy callers are untouched.
5. **Which window gets which piece.** Local's piece first (`localFirst`): it takes the asking window (or a closed file window's bounds); every other piece opens in a window of its own. A piece already open is focused.
6. **Finder.** `package.json` gains `fileAssociations` for `trekproj`, so a packaged Trek is offered for the file. `open-file` is registered before `ready`; files that arrive before the windows are restored (the launch file) wait, and are opened after `restoreWindows`. An OS open uses the focused window only if it is empty, and its fallback always gets a window of its own (a file project can only be handed to a renderer in an IPC reply).
7. **The result dialog is shown on every first import**, even a clean one: the user learns that the file is not the project any more. A second open of an imported file shows nothing.
8. **Import Again** (File → Import on an imported file) makes new projects; the earlier ones stay on their servers, and `migrated.json` points at the new ones (per target).
9. **Drag and drop of files is not supported today** (the sidebar's drop is an internal reorder), so it is not added.

**Routing and servers (Tasks 1, 3, 5)**

10. **A remote piece goes to the saved entry on the legacy server's origin** (`routePiece`): scheme, host and port. An entry with the very URL wins over another on that origin. The Local entry is never a match, whatever its port. A URL that is not `ws:`/`wss:`, or a target the file's `servers` list does not name, is left with that reason.
11. **A server with no entry is offered**: "Add the server “build-box”?", saying whether the token saved for that address comes along. Added through Save's own checks (`addAppServer`). Skipped, the piece is left. Within one run (the first-launch prompt) a declined origin is not asked again (`declined`), and an entry that could not be reached is not waited for again (`unreachable`).
12. **Tokens are carried origin-bound only** (`adoptableToken` over `tokenToSend`). A v1 token goes to an entry only when its stored record's origin is the entry's origin. A token saved before binding (no origin) is not carried. An entry's own token is never replaced, and an entry re-pointed meanwhile gets nothing (`adoptAppServerToken` checks the URL before and after reading). Without a token, the piece is left at once with "set it in Connect to server…, then open the file again"; it does not wait out a connection that will never be made.

**Paths (Tasks 2, 5)**

13. **VM names (4c Note 1): keep the file's path as the profile key.** Colima profiles cannot be renamed, so re-keying the VMs is out; computing the names from the same string the file window used keeps them.
    - `EnvironmentSettings.profileKey?: string`; `envRepoKey(repo)` is `profileKey || path`. All nine call sites that hashed `repo.path` (`environmentFor`, `envList`, `envUp`, `destroyEnvironmentIfAny`, the Env panel's profile) use it. `userData/environments.json` was written with the same string as `repoPath`, so `env:list`'s filter keeps finding the VMs and the orphan list stays right.
    - The importer sets it on a Local repository whose `environments` exist and whose path as the file had it (`ImportedProject.sourcePaths`, raw: before the splitter's normalization) is not its realpath (`profileKeyFor`). A repository without environments made no VM, and gets nothing.
    - The settings setters spread the current environments, so the key survives every later edit. `repo.update` takes `environments` as a record, so the server needs no change.
14. **Session resume when the server moved the path.** The import reads the project back (one snapshot from main's mirror) and `movedSessions` compares it with what was sent, by id (the server keeps nested ids).
    - **On Local**, each moved session of a provider whose history follows its cwd (`sessionMigrates`: Claude, Local) with a UUID id gets its `.jsonl` **copied** (`COPYFILE_EXCL`) from `projectDir(from)` to `projectDir(to)` when it is not there already. Copied, not moved: the file window (Decision 2's fallback) can still resume it. Whether Claude filed the history under the logical or the physical cwd, one of the two folders has it, and the copy only fills the gap.
    - **On a remote server** main cannot reach its disk, so the result warns: "N session(s) in topic were saved under X, but build-box runs them in Y: they may start fresh rather than resume."
    - The id must be a UUID (`isAgentSessionId`), since it names the file copied.
15. **A worktree the server refuses by path is left out, not the piece.** `project.import` checks every non-main worktree against the path guard. On `PATH_DENIED` or `BAD_REQUEST` naming a worktree's path (`worktreeInError`, longest match), the importer drops it (`dropWorktree`, with a warning naming its sessions) and sends again, at most 50 times. A repository the server will not register (`PATH_DENIED`, `NOT_A_REPO` from `server.addRepo`) is dropped with a warning; a piece with no repository left is left.
16. **Remote repositories are registered too** (`server.addRepo`), so a clone under an already-allowed root needs no `trek-server add`. Already registered, it is a no-op.

**migrated.json, recents and windows (Tasks 1, 4)**

17. **`userData/migrated.json`**: `{ prompted, files: { <realpath of the .trekproj>: { pieces: [{target, serverEntryId, projectId, name, serverName}], left: [{target, label, reason}] } } }`. `recordImport` replaces a target's piece on a re-import, keeps left pieces of targets it did not try, and records nothing for a file of which nothing landed (so opening it imports again). Pieces are kept Local's first.
18. **Recents**: the file's entries (compared by realpath) become one server entry per piece, Local's first, where the first one stood (`rewriteRecents`); a server entry already listed moves rather than doubling.
19. **Restored windows are mapped at restore time** (`restoreEntries` in `restoreWindows`), not only rewritten once on disk. A window on an imported file comes back on its Local piece with its bounds; the next persist writes `open-windows.json` with the server target. Doing it at restore also covers a file window left open at quit after an import, and a window the Dock opened while the first-launch prompt was up. A file window whose file was not imported stays a file window.
20. **Data that does not map** is listed in the result (`NOT_CARRIED`): open tabs, selection and drafts; running terminals (sessions come back idle and resume when loaded); the project bot's folder and consent (keyed to the `.trekproj` path; the bot is dormant); the file's own server list. Global sessions go with the Local piece; a file with none here gets a warning that they were not imported.

**The first-launch prompt (Task 8)**

21. **Once, before the windows are restored.** If `migrated.json` has no `prompted`, it collects the `.trekproj` files of the windows open at the last quit, then of the recents (`promptCandidates`: once per realpath, none already imported), that are still on disk. None: it records `prompted` silently. Otherwise one dialog lists them (12 by name, then a count) with **Import** and **Skip**; the answer is recorded before any import, so a crash part-way never asks again (opening a file imports it anyway). Import runs each file in turn, then one result dialog covers them all. `restoreWindows` then brings the windows back on their projects (Decision 19).

### The brief, mapped

| # | Item | Where |
|---|---|---|
| 1 | Main-side importer over main's links; tokens stay in main | Task 5 (Decisions 10–16) |
| 2 | Pure rules: targets, recents/windows rewrites, `migrated.json`, paths, profile names | Tasks 1, 2 (Decisions 10, 13–19) |
| 3 | Apply the rewrites | Task 4 (Decisions 18, 19) |
| 4 | File → Import .trekproj… and the result dialog | Task 6 (Decisions 3, 7, 8, 20) |
| 5 | The first-launch prompt | Task 8 (Decision 21) |
| 6 | Opening a file imports it; `open-file`; recents; File → Open; drag and drop | Task 7 (Decisions 2, 4–6, 9) |
| 7 | Legacy tokens, origin-bound | Task 3 (Decision 12) |
| 8 | VM profiles; session-resume cwd | Tasks 2, 5 (Decisions 13, 14) |
| 9 | `smoke:import` | Task 9 |
| 10 | Final verification | Task 10 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import; `import type` lines may be extensionless.
  - `importRules.ts`, `serverTokenRules.ts`, `environments.ts` and `importProject.ts` are tested directly. `importer.ts`, `importUi.ts`, `migrated.ts` and the stores import Electron, and are covered by `smoke:import`.
- **Baseline:** 1511 tests (1510 pass, 1 skipped) at `e015701`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck`
  - `npm run build` (the renderer, main, `server/dist` and `out/server`)
  - `npm test`
  - the smokes named in each task
- **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes, and two supervisors must never race over one profile.
  - Every Electron smoke uses its own temp `--user-data-dir` and, if it runs Local, a temp HOME. `smoke:import` restores windows (it seeds `open-windows.json`), which is safe only because its userData is its own: never drop its `--user-data-dir`.
  - Every app smoke but `smoke:local-*` and `smoke:import` sets `TREK_NO_LOCAL_SERVER=1`.
- **Never touch** `~/.config/trek-server/local*`, the user's `.trekproj` files, recents, `~/Library/Application Support/Trek Dev` or the installed `/Applications/Trek.app`. Fixture `.trekproj` files are made in the smoke's temp dir.
- **Branch:** `central-server-phase4d`, at master `e015701`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it, context lines included. Apply them by hand or with `git apply`. New files are given whole.
- **Provenance.** Every hunk and every new file was produced from a prototype of this plan, built on `e015701`, one commit per task. Each task's commit was checked out on its own and passed `npm run typecheck` and `npm test` with the count given. With all nine, `smoke:import` (37; 39 after the review fixes), `smoke:windows` (40), `smoke:local-app` (43), `smoke:v2` (170) and `smoke:local-features` (34) passed, one at a time. The prototype branch was then deleted.
- **Temp paths** in expected output are shown as `<work>` (the smoke's `mkdtemp` directory, `/var/folders/…`, whose realpath is `/private/var/folders/…`).

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/main/importRules.ts` | create | 1, 2, 6 | routing, `migrated.json`, rewrites, prompt list (1); path rules (2); result text (6) |
| `scripts/importRules.test.mjs` | create | 1, 2, 6 | their tests |
| `src/shared/model/importProject.ts` | modify | 2 | `ImportedProject.sourcePaths`: each repository's path as the file had it |
| `scripts/importProject.test.mjs` | modify | 2 | the source paths |
| `src/shared/environments.ts` | modify | 2 | `envRepoKey` |
| `src/shared/types.ts` | modify | 2 | `EnvironmentSettings.profileKey` |
| `scripts/environments.test.mjs` | create | 2 | `envRepoKey`, the legacy VM names |
| `src/renderer/src/worktreeActions.ts`, `environmentActions.ts`, `components/EnvironmentPanel.tsx`, `components/WorktreeDetail.tsx`, `components/Sidebar.tsx` | modify | 2 | hash `envRepoKey(repo)`, not `repo.path` |
| `src/main/serverTokenRules.ts` | modify | 3 | `adoptableToken` |
| `scripts/serverTokenRules.test.mjs` | modify | 3 | its rule |
| `src/main/servers.ts` | modify | 3 | `legacyTokenFor` (main-only) |
| `src/main/appServers.ts` | modify | 3 | `savedAppServers`, `addAppServer`, `adoptAppServerToken` (main-only) |
| `src/main/migrated.ts` | create | 4 | `userData/migrated.json`; `fileKey`, `isFileKey` |
| `src/main/recents.ts` | modify | 4 | `rewriteRecentsForImport` |
| `src/main/windows.ts` | modify | 4, 6 | `readRestoreEntries`; restore through `restoreEntries` (4); `openServerTarget`, `closeFileWindow` (6) |
| `src/main/importer.ts` | create | 5 | the importer |
| `src/main/importUi.ts` | create | 6, 7, 8 | File → Import, the dialogs, `openPieces` (6); `openTrekproj`, `openFromOs` (7); the first-launch prompt (8) |
| `src/main/index.ts` | modify | 6, 7, 8 | the menu item (6); `open-file` (7); the prompt before restore (8) |
| `src/preload/index.ts`, `src/renderer/src/App.tsx` | modify | 6 | `onShowServer` / `window:showServer` |
| `src/main/project.ts` | modify | 7 | `openLegacy`; `project:open` / `project:openPath` through `openTrekproj` |
| `src/renderer/src/components/StartScreen.tsx` | modify | 7 | refresh the recents after an import |
| `package.json` | modify | 7, 9 | `fileAssociations` (7); `smoke:import` (9) |
| `scripts/import-smoke.mjs` | create | 9 | `smoke:import` |
| `README.md` | modify | 9 | "Importing a .trekproj"; `smoke:import` |

`server/` does not change: `project.import`, `server.addRepo` and `repo.update`'s free-form `environments` already do what the import needs.

---

### Task 1: The pure rules — routing, `migrated.json`, the recents and window rewrites

**Files:**
- Create: `src/main/importRules.ts`
- Test: `scripts/importRules.test.mjs`

- [ ] **Step 1: The failing test**

`scripts/importRules.test.mjs`:

```js
// scripts/importRules.test.mjs — importing a .trekproj: where each piece goes, migrated.json,
// and the recents and open-windows rewrites.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  localFirst,
  markPrompted,
  migratedFile,
  parseMigrated,
  promptCandidates,
  recordImport,
  restoreEntries,
  rewriteOpenWindows,
  rewriteRecents,
  routePiece,
  serializeMigrated
} from '../src/main/importRules.ts'
import { MAX_RECENTS } from '../src/main/recentsRules.ts'

const fileServers = [
  { id: 'srv', name: 'build-box', url: 'wss://build.example:7777' },
  { id: 'old', name: 'old-box', url: 'https://old.example' },
  { id: 'bad', name: 'bad', url: 'not a url' }
]
const entries = [
  { id: 'local', name: 'Local', url: 'ws://127.0.0.1:5000' },
  { id: 'e1', name: 'Build', url: 'wss://build.example:7777/' },
  { id: 'e2', name: 'Other', url: 'wss://other.example' }
]

test('routePiece: the local target goes to Local', () => {
  assert.deepEqual(routePiece('local', fileServers, entries), { kind: 'local' })
})

test('routePiece: a remote target matches a saved entry by origin, never the Local entry', () => {
  assert.deepEqual(routePiece('srv', fileServers, entries), { kind: 'entry', entryId: 'e1', name: 'Build' })
  // Another port is another origin.
  assert.deepEqual(routePiece('srv', fileServers, [{ id: 'e3', name: 'Port', url: 'wss://build.example:7778' }]), {
    kind: 'add',
    server: fileServers[0]
  })
  // A Local entry on the same origin is not a match: Local is this machine, not the file's server.
  assert.deepEqual(routePiece('srv', fileServers, [{ id: 'local', name: 'Local', url: 'wss://build.example:7777' }]), {
    kind: 'add',
    server: fileServers[0]
  })
})

test('routePiece: an exact URL wins over another entry with the same origin', () => {
  const two = [
    { id: 'a', name: 'A', url: 'wss://build.example:7777/sub' },
    { id: 'b', name: 'B', url: 'wss://build.example:7777' }
  ]
  assert.deepEqual(routePiece('srv', fileServers, two), { kind: 'entry', entryId: 'b', name: 'B' })
})

test('routePiece: a server the file names with no entry is offered to add; one it cannot be added as is unknown', () => {
  assert.deepEqual(routePiece('srv', fileServers, []), { kind: 'add', server: fileServers[0] })
  assert.deepEqual(routePiece('old', fileServers, []), { kind: 'unknown', label: 'old-box', why: 'its address is not a ws:// or wss:// URL' })
  assert.deepEqual(routePiece('bad', fileServers, []), { kind: 'unknown', label: 'bad', why: 'its address is not a ws:// or wss:// URL' })
  assert.deepEqual(routePiece('gone', fileServers, entries), { kind: 'unknown', label: 'server gone', why: "the file's server list does not name it" })
})

const piece = (target, projectId, serverEntryId = target === 'local' ? 'local' : `e-${target}`) => ({
  target,
  serverEntryId,
  projectId,
  name: 'Proj',
  serverName: target === 'local' ? 'Local' : 'Build'
})

test('localFirst keeps the order otherwise', () => {
  assert.deepEqual(localFirst([piece('a', 'p1'), piece('local', 'p2'), piece('b', 'p3')]).map((p) => p.target), ['local', 'a', 'b'])
})

test('parseMigrated tolerates anything and keeps well-formed files', () => {
  assert.deepEqual(parseMigrated(null), { prompted: false, files: {} })
  assert.deepEqual(parseMigrated({ prompted: 'yes', files: [] }), { prompted: false, files: {} })
  const good = { prompted: true, files: { '/a.trekproj': { pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] } } }
  assert.deepEqual(parseMigrated(good), good)
  const mixed = {
    prompted: true,
    files: {
      '/a.trekproj': { pieces: [piece('local', 'p1'), { target: 'x' }, piece('srv', '')], left: [{ target: 1 }] },
      '/b.trekproj': 'nope',
      '': { pieces: [], left: [] }
    }
  }
  assert.deepEqual(parseMigrated(mixed), { prompted: true, files: { '/a.trekproj': { pieces: [piece('local', 'p1')], left: [] } } })
  // A prototype key never becomes a file.
  assert.deepEqual(parseMigrated(JSON.parse('{"files":{"__proto__":{"pieces":[],"left":[]}}}')).files, {})
  assert.deepEqual(parseMigrated(serializeMigrated(good)), good)
})

test('recordImport adds pieces, replaces a re-imported target and keeps the left ones not attempted', () => {
  let m = parseMigrated(null)
  m = recordImport(m, '/a', { attempted: ['local', 'srv'], pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] })
  assert.deepEqual(migratedFile(m, '/a'), { pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] })
  // A retry of the left piece: it lands, and Local's stays.
  m = recordImport(m, '/a', { attempted: ['srv'], pieces: [piece('srv', 'p2')], left: [] })
  assert.deepEqual(migratedFile(m, '/a'), { pieces: [piece('local', 'p1'), piece('srv', 'p2')], left: [] })
  // Import again: Local's piece is replaced by the new project.
  m = recordImport(m, '/a', { attempted: ['local'], pieces: [piece('local', 'p3')], left: [] })
  assert.deepEqual(migratedFile(m, '/a').pieces.map((p) => p.projectId), ['p3', 'p2'])
  // Nothing landed and nothing was there: no entry, so the next open imports again.
  m = recordImport(m, '/b', { attempted: ['local'], pieces: [], left: [{ target: 'local', label: 'Local', reason: 'off' }] })
  assert.equal(migratedFile(m, '/b'), undefined)
  assert.equal(migratedFile(m, '/c'), undefined)
  assert.equal(markPrompted(m).prompted, true)
  assert.equal(m.prompted, false)
})

const file = (path) => ({ kind: 'file', path })
const server = (serverEntryId, projectId) => ({ kind: 'server', serverEntryId, projectId, name: 'Proj', serverName: serverEntryId === 'local' ? 'Local' : 'Build' })
const isA = (path) => path === '/a.trekproj' || path === '/link/a.trekproj'

test("rewriteRecents puts the pieces where the file was, Local's first, and drops the file's other entries", () => {
  const list = [file('/x.trekproj'), file('/a.trekproj'), server('e9', 'q'), file('/link/a.trekproj')]
  assert.deepEqual(rewriteRecents(list, isA, [piece('srv', 'p2'), piece('local', 'p1')]), [
    file('/x.trekproj'),
    server('local', 'p1'),
    server('e-srv', 'p2'),
    server('e9', 'q')
  ])
})

test('rewriteRecents moves a server entry already listed instead of doubling it, and prepends when the file was not listed', () => {
  const list = [server('local', 'p1'), file('/x.trekproj'), file('/a.trekproj')]
  assert.deepEqual(rewriteRecents(list, isA, [piece('local', 'p1')]), [file('/x.trekproj'), server('local', 'p1')])
  assert.deepEqual(rewriteRecents([file('/x.trekproj')], isA, [piece('local', 'p1')]), [server('local', 'p1'), file('/x.trekproj')])
  assert.deepEqual(rewriteRecents([file('/a.trekproj')], isA, []), [file('/a.trekproj')])
})

test('rewriteRecents keeps the cap', () => {
  const list = Array.from({ length: MAX_RECENTS }, (_, i) => file(i === 0 ? '/a.trekproj' : `/f${i}.trekproj`))
  const out = rewriteRecents(list, isA, [piece('local', 'p1'), piece('srv', 'p2')])
  assert.equal(out.length, MAX_RECENTS)
  assert.deepEqual(out.slice(0, 2), [server('local', 'p1'), server('e-srv', 'p2')])
})

const bounds = { x: 1, y: 2, width: 900, height: 700 }

test("rewriteOpenWindows gives the file's window to Local's piece and keeps its bounds", () => {
  const windows = [
    { target: { kind: 'file', path: '/x.trekproj' } },
    { target: { kind: 'file', path: '/a.trekproj' }, bounds },
    { target: { kind: 'file', path: '/link/a.trekproj' } }
  ]
  assert.deepEqual(rewriteOpenWindows(windows, isA, [piece('srv', 'p2'), piece('local', 'p1')]), [
    { target: { kind: 'file', path: '/x.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds }
  ])
})

test('rewriteOpenWindows: no Local piece means the first one; a window already on it stays the only one', () => {
  const windows = [{ target: { kind: 'file', path: '/a.trekproj' } }]
  assert.deepEqual(rewriteOpenWindows(windows, isA, [piece('srv', 'p2')]), [{ target: { kind: 'server', serverEntryId: 'e-srv', projectId: 'p2' } }])
  const already = [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' } }, { target: { kind: 'file', path: '/a.trekproj' }, bounds }]
  assert.deepEqual(rewriteOpenWindows(already, isA, [piece('local', 'p1')]), [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' } }])
  assert.deepEqual(rewriteOpenWindows(windows, isA, []), windows)
})

test('restoreEntries: each window on an imported file comes back on its Local piece; other windows stay', () => {
  const key = (path) => (path === '/link/a.trekproj' ? '/a.trekproj' : path)
  const m = recordImport(parseMigrated(null), '/a.trekproj', { attempted: ['local', 'srv'], pieces: [piece('srv', 'p2'), piece('local', 'p1')], left: [] })
  const windows = [
    { target: { kind: 'file', path: '/link/a.trekproj' }, bounds },
    { target: { kind: 'file', path: '/fallback.trekproj' } },
    { target: { kind: 'file', path: '/a.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
  ]
  assert.deepEqual(restoreEntries(windows, m, key), [
    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds },
    { target: { kind: 'file', path: '/fallback.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
  ])
  assert.deepEqual(restoreEntries(windows, parseMigrated(null), key), windows)
})

test('promptCandidates: open windows first, then recents, once per file, none already imported', () => {
  const key = (path) => (path === '/link/a.trekproj' ? '/a.trekproj' : path)
  const recents = [file('/b.trekproj'), server('local', 'p'), file('/link/a.trekproj'), file('/done.trekproj')]
  const windows = [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p' } }, { target: { kind: 'file', path: '/a.trekproj' } }]
  const migrated = recordImport(parseMigrated(null), '/done.trekproj', { attempted: ['local'], pieces: [piece('local', 'd')], left: [] })
  assert.deepEqual(promptCandidates(recents, windows, migrated, key), [
    { path: '/a.trekproj', key: '/a.trekproj' },
    { path: '/b.trekproj', key: '/b.trekproj' }
  ])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/importRules.test.mjs`

Expected: the file fails to load, `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/src/main/importRules.ts' imported from <repo>/scripts/importRules.test.mjs`, and `# fail 1`.

- [ ] **Step 3: The rules**

`src/main/importRules.ts`:

```ts
// Importing a .trekproj (phase 4d): where each piece of a split file goes, what
// migrated.json records, and how recents and open-windows.json are rewritten. Pure.
import { LOCAL_ENTRY_ID, originOf } from '../shared/appServerRules.ts'
import { LOCAL_TARGET } from '../shared/model/importProject.ts'
import type { ServerConfig } from '../shared/types.ts'
import { MAX_RECENTS, type RecentEntry } from './recentsRules.ts'
import { isTargetId, sameTarget, type OpenWindowEntry, type WindowTarget } from './windowRules.ts'

// ---- Where a piece goes -----------------------------------------------------------------------

/** Where one piece of a split file is sent. */
export type PieceRoute =
  /** What lived on the machine that saved the file: the Local server */
  | { kind: 'local' }
  /** A saved app-server entry on the legacy server's origin */
  | { kind: 'entry'; entryId: string; name: string }
  /** A server the file names that has no entry: the user is offered to add it */
  | { kind: 'add'; server: ServerConfig }
  /** Nowhere: `why` says so in the result */
  | { kind: 'unknown'; label: string; why: string }

function isWsUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

const withoutTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '')

/**
 * The legacy server `target` (an id from the file's `servers`) matched to a saved entry by
 * origin (scheme, host and port). An entry with the very same URL wins over another on that
 * origin. The Local entry is never a match: it is this machine, whatever its port.
 */
export function routePiece(
  target: string,
  fileServers: readonly ServerConfig[],
  entries: readonly { id: string; name: string; url: string }[]
): PieceRoute {
  if (target === LOCAL_TARGET) return { kind: 'local' }
  const server = fileServers.find((s) => s.id === target)
  if (!server) return { kind: 'unknown', label: `server ${target}`, why: "the file's server list does not name it" }
  const origin = originOf(server.url)
  if (!origin || !isWsUrl(server.url)) return { kind: 'unknown', label: server.name, why: 'its address is not a ws:// or wss:// URL' }
  const same = entries.filter((e) => e.id !== LOCAL_ENTRY_ID && originOf(e.url) === origin)
  const hit = same.find((e) => withoutTrailingSlash(e.url) === withoutTrailingSlash(server.url)) ?? same[0]
  return hit ? { kind: 'entry', entryId: hit.id, name: hit.name } : { kind: 'add', server }
}

// ---- migrated.json ----------------------------------------------------------------------------

/** One piece that landed: the project it became, and the labels a recent entry shows. */
export interface MigratedPiece {
  /** LOCAL_TARGET, or the legacy server id from the file */
  target: string
  serverEntryId: string
  projectId: string
  name: string
  serverName: string
}

/** One piece that did not land, and why: opening the file again offers to retry it. */
export interface MigratedLeft {
  target: string
  label: string
  reason: string
}

export interface MigratedFile {
  pieces: MigratedPiece[]
  left: MigratedLeft[]
}

/** userData/migrated.json: by the realpath of each imported .trekproj. */
export interface Migrated {
  /** The first-launch prompt has run (whatever the answer) */
  prompted: boolean
  files: Record<string, MigratedFile>
}

const str = (v: unknown): v is string => typeof v === 'string'

function parsePiece(raw: unknown): MigratedPiece | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.target) || !r.target || !isTargetId(r.serverEntryId) || !isTargetId(r.projectId) || !str(r.name) || !str(r.serverName)) return null
  return { target: r.target, serverEntryId: r.serverEntryId, projectId: r.projectId, name: r.name, serverName: r.serverName }
}

function parseLeft(raw: unknown): MigratedLeft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return str(r.target) && r.target && str(r.label) && str(r.reason) ? { target: r.target, label: r.label, reason: r.reason } : null
}

const kept = <T>(items: unknown, parse: (raw: unknown) => T | null): T[] =>
  Array.isArray(items) ? items.map(parse).filter((x): x is T => x !== null) : []

/** Tolerates anything on disk: a bad file entry is dropped, never the rest. */
export function parseMigrated(raw: unknown): Migrated {
  const out: Migrated = { prompted: false, files: Object.create(null) as Record<string, MigratedFile> }
  if (!raw || typeof raw !== 'object') return { ...out, files: {} }
  const r = raw as Record<string, unknown>
  out.prompted = r.prompted === true
  const files = r.files
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [key, value] of Object.entries(files)) {
      if (!key || key === '__proto__' || !value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      out.files[key] = { pieces: kept(v.pieces, parsePiece), left: kept(v.left, parseLeft) }
    }
  }
  return { prompted: out.prompted, files: { ...out.files } }
}

export function serializeMigrated(m: Migrated): unknown {
  return { prompted: m.prompted, files: m.files }
}

export function migratedFile(m: Migrated, key: string): MigratedFile | undefined {
  return Object.prototype.hasOwnProperty.call(m.files, key) ? m.files[key] : undefined
}

/**
 * One import of the file at `key`: the targets it tried, the pieces that landed (each
 * replacing an older piece of its target) and the ones left. Left pieces of targets it did
 * not try stay. Pieces are kept Local's first. A file with no piece at all is not recorded:
 * opening it imports it again.
 */
export function recordImport(
  m: Migrated,
  key: string,
  run: { attempted: readonly string[]; pieces: readonly MigratedPiece[]; left: readonly MigratedLeft[] }
): Migrated {
  const before = migratedFile(m, key) ?? { pieces: [], left: [] }
  const landed = new Set(run.pieces.map((p) => p.target))
  const tried = new Set(run.attempted)
  const pieces = localFirst([...before.pieces.filter((p) => !landed.has(p.target)), ...run.pieces])
  const left = [...before.left.filter((l) => !tried.has(l.target) && !landed.has(l.target)), ...run.left]
  const files = { ...m.files }
  if (pieces.length === 0) delete files[key]
  else files[key] = { pieces, left }
  return { ...m, files }
}

export function markPrompted(m: Migrated): Migrated {
  return { ...m, prompted: true }
}

export function localFirst<T extends { target: string }>(pieces: readonly T[]): T[] {
  return [...pieces.filter((p) => p.target === LOCAL_TARGET), ...pieces.filter((p) => p.target !== LOCAL_TARGET)]
}

// ---- Recents and open-windows.json ------------------------------------------------------------

export function recentOf(piece: MigratedPiece): Extract<RecentEntry, { kind: 'server' }> {
  return { kind: 'server', serverEntryId: piece.serverEntryId, projectId: piece.projectId, name: piece.name, serverName: piece.serverName }
}

export function targetOf(piece: MigratedPiece): Extract<WindowTarget, { kind: 'server' }> {
  return { kind: 'server', serverEntryId: piece.serverEntryId, projectId: piece.projectId }
}

const sameServerRecent = (a: RecentEntry, b: RecentEntry): boolean =>
  a.kind === 'server' && b.kind === 'server' && a.serverEntryId === b.serverEntryId && a.projectId === b.projectId

/**
 * The file's recent entries (`isFile` says which paths are it: the caller compares realpaths)
 * become one server entry per piece, Local's first, where the first of them stood; when the
 * file was not listed, they go first. A server entry already listed moves rather than doubling.
 */
export function rewriteRecents(list: readonly RecentEntry[], isFile: (path: string) => boolean, pieces: readonly MigratedPiece[]): RecentEntry[] {
  if (pieces.length === 0) return [...list]
  const added = localFirst(pieces).map(recentOf)
  const isOld = (e: RecentEntry): boolean => (e.kind === 'file' && isFile(e.path)) || added.some((n) => sameServerRecent(n, e))
  const at = list.findIndex((e) => e.kind === 'file' && isFile(e.path))
  const before = at === -1 ? 0 : list.slice(0, at).filter((e) => !isOld(e)).length
  const rest = list.filter((e) => !isOld(e))
  return [...rest.slice(0, before), ...added, ...rest.slice(before)].slice(0, MAX_RECENTS)
}

/**
 * A window restored on the file comes back on Local's piece (or the first piece when the
 * file had nothing local), with its bounds. A second window on the file, or one on a
 * target already listed, is dropped: a target is restored once.
 */
export function rewriteOpenWindows(entries: readonly OpenWindowEntry[], isFile: (path: string) => boolean, pieces: readonly MigratedPiece[]): OpenWindowEntry[] {
  const first = localFirst(pieces)[0]
  if (!first) return [...entries]
  const target = targetOf(first)
  let placed = entries.some((e) => sameTarget(e.target, target))
  const out: OpenWindowEntry[] = []
  for (const entry of entries) {
    if (entry.target.kind !== 'file' || !isFile(entry.target.path)) {
      out.push(entry)
      continue
    }
    if (placed) continue
    placed = true
    out.push(entry.bounds ? { target, bounds: entry.bounds } : { target })
  }
  return out
}

/**
 * The windows to restore, with each one on an imported file moved to the file's Local piece
 * (rewriteOpenWindows), so a .trekproj that was imported never comes back as a file window.
 * `key` is a path's realpath. The next write of open-windows.json keeps the rewrite.
 */
export function restoreEntries(entries: readonly OpenWindowEntry[], m: Migrated, key: (path: string) => string): OpenWindowEntry[] {
  let out = [...entries]
  const keys = new Set(entries.flatMap((e) => (e.target.kind === 'file' ? [key(e.target.path)] : [])))
  for (const k of keys) {
    const file = migratedFile(m, k)
    if (file) out = rewriteOpenWindows(out, (path) => key(path) === k, file.pieces)
  }
  return out
}

/**
 * The files the first-launch prompt offers: those of the windows restored last time, then
 * the recents, once per file (`key` is its realpath), leaving out the ones already imported.
 * Whether each is still on disk is the caller's to check.
 */
export function promptCandidates(
  recents: readonly RecentEntry[],
  windows: readonly OpenWindowEntry[],
  m: Migrated,
  key: (path: string) => string
): { path: string; key: string }[] {
  const out: { path: string; key: string }[] = []
  const seen = new Set<string>()
  const paths = [
    ...windows.flatMap((w) => (w.target.kind === 'file' ? [w.target.path] : [])),
    ...recents.flatMap((e) => (e.kind === 'file' ? [e.path] : []))
  ]
  for (const path of paths) {
    const k = key(path)
    if (seen.has(k) || migratedFile(m, k)) continue
    seen.add(k)
    out.push({ path, key: k })
  }
  return out
}
```

- [ ] **Step 4: Run the test**

Run: `node --test scripts/importRules.test.mjs`

Expected: `# pass 14`, `# fail 0`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`

Expected: typecheck prints nothing after its header; `# tests 1525`, `# pass 1524`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/main/importRules.ts scripts/importRules.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): import rules: where each piece of a .trekproj goes, migrated.json, the recents and restored windows" -m "Co-Authored-By: <model trailer>" -- src/main/importRules.ts scripts/importRules.test.mjs
```

---

### Task 2: The path rules — VM names keep the file's path; sessions whose path moved; refused worktrees

**Files:**
- Modify: `src/main/importRules.ts`, `src/shared/model/importProject.ts`, `src/shared/environments.ts`, `src/shared/types.ts`, `src/renderer/src/worktreeActions.ts`, `src/renderer/src/environmentActions.ts`, `src/renderer/src/components/EnvironmentPanel.tsx`, `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/Sidebar.tsx`
- Create: `scripts/environments.test.mjs`
- Test: `scripts/importRules.test.mjs`, `scripts/importProject.test.mjs`

- [ ] **Step 1: The failing tests**

`scripts/importRules.test.mjs` (the imports, and the path tests at the end):

```diff
diff --git a/scripts/importRules.test.mjs b/scripts/importRules.test.mjs
index 0026f5b..5f8bb1c 100644
--- a/scripts/importRules.test.mjs
+++ b/scripts/importRules.test.mjs
@@ -3,17 +3,23 @@
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
+  dropWorktree,
+  isAgentSessionId,
   localFirst,
   markPrompted,
   migratedFile,
+  movedSessions,
   parseMigrated,
+  profileKeyFor,
   promptCandidates,
   recordImport,
   restoreEntries,
   rewriteOpenWindows,
   rewriteRecents,
   routePiece,
-  serializeMigrated
+  serializeMigrated,
+  withProfileKeys,
+  worktreeInError
 } from '../src/main/importRules.ts'
 import { MAX_RECENTS } from '../src/main/recentsRules.ts'
 
@@ -187,3 +193,89 @@ test('promptCandidates: open windows first, then recents, once per file, none al
     { path: '/b.trekproj', key: '/b.trekproj' }
   ])
 })
+
+// ---- Paths: the env profile key, sessions whose cwd moved, a worktree the server refused ----
+
+const session = (id, agentSessionId, provider = 'claude') => ({ id, title: id, llm: { provider }, queue: [], status: 'idle', ...(agentSessionId ? { agentSessionId } : {}) })
+const UUID1 = '11111111-1111-4111-8111-111111111111'
+const UUID2 = '22222222-2222-4222-8222-222222222222'
+const UUID3 = '33333333-3333-4333-8333-333333333333'
+const project = (paths, extra = {}) => ({
+  id: 'p',
+  name: 'P',
+  settings: {},
+  globalSessions: extra.global ?? [],
+  repositories: [
+    {
+      id: 'r1',
+      name: 'app',
+      path: paths.repo,
+      branchData: {},
+      ...(extra.environments ? { environments: extra.environments } : {}),
+      worktrees: [
+        { id: 'w1', name: 'app', path: paths.repo, isMain: true, loaded: false, sessions: [session('s1', UUID1)] },
+        { id: 'w2', name: 'x', path: paths.x, isMain: false, loaded: false, sessions: [session('s2', UUID2), session('s3', 'codex-id', 'codex'), session('s4')] }
+      ]
+    }
+  ]
+})
+
+test('isAgentSessionId takes only a UUID, so a file cannot name a path', () => {
+  assert.equal(isAgentSessionId(UUID1), true)
+  assert.equal(isAgentSessionId('../../.ssh/id_rsa'), false)
+  assert.equal(isAgentSessionId(''), false)
+  assert.equal(isAgentSessionId(undefined), false)
+})
+
+test('profileKeyFor: the path as the file had it, only when the server stores another', () => {
+  assert.equal(profileKeyFor('/var/x/app', '/private/var/x/app'), '/var/x/app')
+  assert.equal(profileKeyFor('/Users/me/app/', '/Users/me/app'), '/Users/me/app/')
+  assert.equal(profileKeyFor('/Users/me/app', '/Users/me/app'), undefined)
+})
+
+test('withProfileKeys sets the key on repositories with environments, and keeps one already there', () => {
+  const p = project({ repo: '/l/app', x: '/l/app-x' }, { environments: { enabled: true, cpu: 4 } })
+  const keyed = withProfileKeys(p, new Map([['r1', '/l/app']]))
+  assert.deepEqual(keyed.repositories[0].environments, { enabled: true, cpu: 4, profileKey: '/l/app' })
+  assert.equal(p.repositories[0].environments.profileKey, undefined, 'the input is not changed')
+  assert.deepEqual(withProfileKeys(keyed, new Map([['r1', '/other']])).repositories[0].environments.profileKey, '/l/app')
+  // No environments: there are no VMs to keep, and none are made up.
+  const plain = project({ repo: '/l/app', x: '/l/app-x' })
+  assert.equal(withProfileKeys(plain, new Map([['r1', '/l/app']])).repositories[0].environments, undefined)
+})
+
+test("movedSessions: the sessions whose worktree the server stores at another path, Claude's kind only", () => {
+  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
+  const stored = project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' })
+  assert.deepEqual(movedSessions(sent, stored), [
+    { worktree: 'app', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID1] },
+    { worktree: 'x', from: '/var/t/app-x', to: '/private/var/t/app-x', agentSessionIds: [UUID2] }
+  ])
+  assert.deepEqual(movedSessions(sent, sent), [])
+})
+
+test("movedSessions: the Global panel's sessions run in the first repository's main worktree", () => {
+  const sent = project({ repo: '/var/t/app', x: '/l/app-x' }, { global: [session('g', UUID3)] })
+  const stored = project({ repo: '/private/var/t/app', x: '/l/app-x' }, { global: [session('g', UUID3)] })
+  assert.deepEqual(movedSessions(sent, stored), [
+    { worktree: 'app', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID1] },
+    { worktree: 'Global', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID3] }
+  ])
+})
+
+test('worktreeInError finds the worktree a refusal names, never the main one, and the longest path wins', () => {
+  const p = project({ repo: '/r/app', x: '/r/app-x' })
+  p.repositories[0].worktrees.push({ id: 'w3', name: 'y', path: '/r/app-x2', isMain: false, loaded: false, sessions: [session('s5', UUID3)] })
+  assert.deepEqual(worktreeInError(p, 'Path not under a configured root: /r/app-x'), { repoId: 'r1', worktreeId: 'w2' })
+  assert.deepEqual(worktreeInError(p, 'project.repositories[0].worktrees[2]: worktree path /r/app-x2 is another repository (/r/z) or contains one'), { repoId: 'r1', worktreeId: 'w3' })
+  assert.equal(worktreeInError(p, 'Path not under a configured root: /r/app'), null)
+  assert.equal(worktreeInError(p, 'something else'), null)
+})
+
+test('dropWorktree takes the worktree out and says how many sessions went with it', () => {
+  const p = project({ repo: '/r/app', x: '/r/app-x' })
+  const { project: out, path, sessions } = dropWorktree(p, { repoId: 'r1', worktreeId: 'w2' })
+  assert.deepEqual(out.repositories[0].worktrees.map((w) => w.id), ['w1'])
+  assert.deepEqual([path, sessions], ['/r/app-x', 3])
+  assert.equal(p.repositories[0].worktrees.length, 2, 'the input is not changed')
+})
```

`scripts/importProject.test.mjs` (appended):

```diff
diff --git a/scripts/importProject.test.mjs b/scripts/importProject.test.mjs
index 0daf4d2..3b95418 100644
--- a/scripts/importProject.test.mjs
+++ b/scripts/importProject.test.mjs
@@ -392,3 +392,23 @@ test('a server with no clone path anywhere gives only the local project and a wa
   assert.equal(warnings.length, 1)
   assert.match(warnings[0], /1 session\(s\)/)
 })
+
+test("each piece keeps its repositories' paths as the file had them (the env VM names hash them)", () => {
+  const file = {
+    version: 3,
+    name: 'P',
+    servers: [{ id: 'srv', name: 'box', url: 'wss://b' }],
+    repositories: [
+      { id: 'a', name: 'a', path: '/var/t/a/', serverPaths: { srv: '/home/a//' }, worktrees: [] },
+      { id: 'b', name: 'b', path: '/l/b', worktrees: [] }
+    ]
+  }
+  const { projects } = splitProjectByServer(file, ids())
+  const local = projects.find((p) => p.target === 'local')
+  const remote = projects.find((p) => p.target === 'srv')
+  assert.deepEqual(local.project.repositories.map((r) => [r.path, local.sourcePaths[r.id]]), [
+    ['/var/t/a', '/var/t/a/'],
+    ['/l/b', '/l/b']
+  ])
+  assert.deepEqual(remote.project.repositories.map((r) => [r.path, remote.sourcePaths[r.id]]), [['/home/a', '/home/a//']])
+})
```

`scripts/environments.test.mjs`:

```js
// scripts/environments.test.mjs — which path an environment's VM name hashes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveProfileName, envRepoKey } from '../src/shared/environments.ts'

test("envRepoKey is the repository's path, or the profile key an import kept", () => {
  assert.equal(envRepoKey({ path: '/private/var/t/app' }), '/private/var/t/app')
  assert.equal(envRepoKey({ path: '/private/var/t/app', environments: { enabled: true } }), '/private/var/t/app')
  assert.equal(envRepoKey({ path: '/private/var/t/app', environments: { enabled: true, profileKey: '/var/t/app' } }), '/var/t/app')
  assert.equal(envRepoKey({ path: '/p', environments: { enabled: true, profileKey: '' } }), '/p')
})

test('an imported repository keeps the VM names its file window made', () => {
  const legacy = deriveProfileName('/var/t/app', 'feature-x')
  const imported = { path: '/private/var/t/app', environments: { enabled: true, profileKey: '/var/t/app' } }
  assert.equal(deriveProfileName(envRepoKey(imported), 'feature-x'), legacy)
  assert.notEqual(deriveProfileName(imported.path, 'feature-x'), legacy)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test scripts/importRules.test.mjs scripts/environments.test.mjs scripts/importProject.test.mjs`

Expected: `importRules.test.mjs` fails to load with `SyntaxError: The requested module '../src/main/importRules.ts' does not provide an export named 'dropWorktree'`; `environments.test.mjs` with `... does not provide an export named 'envRepoKey'`; the new `importProject` test fails with `TypeError: Cannot read properties of undefined (reading '…')` (`sourcePaths` is missing). `# fail 3`.

- [ ] **Step 3: The splitter keeps the paths as the file had them**

```diff
diff --git a/src/shared/model/importProject.ts b/src/shared/model/importProject.ts
index 8da08ed..c175ccc 100644
--- a/src/shared/model/importProject.ts
+++ b/src/shared/model/importProject.ts
@@ -29,6 +29,12 @@ export interface ImportedProject {
   /** The server's display name from the file, when it lists the server */
   serverName?: string
   project: Project
+  /**
+   * Each repository's path as the file had it, by repository id. `project` has it
+   * normalized, and the server stores its realpath; the environment VM names of a
+   * file window hashed this one (deriveProfileName).
+   */
+  sourcePaths: Record<string, string>
 }
 
 export interface ImportResult {
@@ -100,7 +106,8 @@ function repositoryFor(
   target: string,
   label: string,
   newId: () => string,
-  warnings: string[]
+  warnings: string[],
+  sourcePaths: Record<string, string>
 ): Repository | null {
   const isLocal = target === LOCAL_TARGET
   const rawPath = isLocal ? r.path : r.serverPaths?.[target]
@@ -146,6 +153,7 @@ function repositoryFor(
   }
   if (r.linkedDirs) repo.linkedDirs = [...r.linkedDirs]
   if (r.environments) repo.environments = r.environments
+  sourcePaths[repo.id] = rawPath
   return repo
 }
 
@@ -212,8 +220,9 @@ export function splitProjectByServer(file: ProjectFile, newId: () => string): Im
     const isLocal = target === LOCAL_TARGET
     const serverName = isLocal ? undefined : serverNames.get(target)
     const label = isLocal ? 'this machine' : (serverName ?? `server ${target}`)
+    const sourcePaths: Record<string, string> = {}
     const repositories = file.repositories
-      .map((r) => repositoryFor(r, target, label, newId, warnings))
+      .map((r) => repositoryFor(r, target, label, newId, warnings, sourcePaths))
       .filter((r): r is Repository => r !== null)
     if (repositories.length === 0) continue
 
@@ -230,7 +239,8 @@ export function splitProjectByServer(file: ProjectFile, newId: () => string): Im
         settings: projectSettings,
         repositories,
         globalSessions: isLocal ? (file.globalSessions ?? []).map((t) => toSession(t, newId)) : []
-      }
+      },
+      sourcePaths
     }
     if (serverName !== undefined) imported.serverName = serverName
     projects.push(structuredClone(imported))
```

- [ ] **Step 4: `envRepoKey` and `profileKey`**

```diff
diff --git a/src/shared/environments.ts b/src/shared/environments.ts
index e780c9b..75466e1 100644
--- a/src/shared/environments.ts
+++ b/src/shared/environments.ts
@@ -27,6 +27,16 @@ export function deriveProfileName(repoPath: string, branch: string): string {
   return `${ENV_PROFILE_PREFIX}${slug || 'env'}-${hash(`${repoPath}\0${branch}`)}`
 }
 
+/**
+ * The repository path a branch's VM name hashes: the repository's own, or the
+ * `profileKey` an import kept. An imported repository is stored at its realpath
+ * (`server.addRepo`), but its file window named VMs after the path the file had,
+ * so the import keeps that path here and the existing VMs stay this repository's.
+ */
+export function envRepoKey(repo: { path: string; environments?: { profileKey?: string } }): string {
+  return repo.environments?.profileKey || repo.path
+}
+
 /** Colima registers a docker context named after the profile. */
 export const dockerContextFor = (profile: string): string => `colima-${profile}`
 
```

```diff
diff --git a/src/shared/types.ts b/src/shared/types.ts
index a33cdd4..e972294 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -504,6 +504,12 @@ export interface EnvironmentSettings {
    * order (e.g. "docker-compose.yml,docker-compose.override.yml").
    */
   composeFile?: string
+  /**
+   * The repository path this repository's VM names hash, when it is not `path`: set by
+   * a .trekproj import whose file had another spelling of the path (a symlink, `/var`
+   * for `/private/var`, a trailing slash). See envRepoKey.
+   */
+  profileKey?: string
 }
 
 export type EnvVmState = 'running' | 'stopped' | 'missing'
```

- [ ] **Step 5: Every environment call site hashes `envRepoKey(repo)`**

These are all the sites that passed `repo.path` to `deriveProfileName`, `environmentFor`, `envList`, `envUp` or `destroyEnvironmentIfAny` (`grep -rn "environmentFor(\|envList(\|envUp(\|deriveProfileName(\|destroyEnvironmentIfAny(" src/renderer/src`). A file window's repositories have no `profileKey`, so nothing changes there.

```diff
diff --git a/src/renderer/src/worktreeActions.ts b/src/renderer/src/worktreeActions.ts
index 5c3b371..8ec95ef 100644
--- a/src/renderer/src/worktreeActions.ts
+++ b/src/renderer/src/worktreeActions.ts
@@ -9,6 +9,7 @@ import {
   useAppStore
 } from './store'
 import { destroyEnvironmentIfAny } from './environmentActions'
+import { envRepoKey } from '../../shared/environments'
 import { createTerminal, disposeTerminal } from './terminals'
 import { sameWorktree } from '../../shared/types'
 import type { GitWorktreeInfo, PersistedTerminal, WorktreeInstance } from '../../shared/types'
@@ -331,7 +332,7 @@ export async function moveWorktree(opts: {
   // The source's environment VM must not survive pointing at a deleted path
   // (environments are local-only in v1, so only a local source can have one).
   if (sourceServerId === null && environmentOf(info)) {
-    const envWarning = await destroyEnvironmentIfAny(repo.path, branch)
+    const envWarning = await destroyEnvironmentIfAny(envRepoKey(repo), branch)
     if (envWarning) warning = `${envWarning} It is listed under Orphaned environments in Settings.`
   }
   try {
@@ -360,14 +361,14 @@ export async function moveWorktree(opts: {
 function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
   const state = useAppStore.getState()
   if (info.serverId || !state.project) return undefined
-  return environmentFor(state.environments, repoOfInfo(state.project, info).path, info.branch)
+  return environmentFor(state.environments, envRepoKey(repoOfInfo(state.project, info)), info.branch)
 }
 
 /** Tear down the worktree's environment, surfacing failures without blocking the caller. */
 async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
   const project = useAppStore.getState().project
   if (!project) return
-  const warning = await destroyEnvironmentIfAny(repoOfInfo(project, info).path, info.branch)
+  const warning = await destroyEnvironmentIfAny(envRepoKey(repoOfInfo(project, info)), info.branch)
   if (warning) {
     await window.api.showError(
       'Environment cleanup failed',
```

```diff
diff --git a/src/renderer/src/environmentActions.ts b/src/renderer/src/environmentActions.ts
index c37d999..562f953 100644
--- a/src/renderer/src/environmentActions.ts
+++ b/src/renderer/src/environmentActions.ts
@@ -1,3 +1,4 @@
+import { envRepoKey } from '../../shared/environments'
 import { environmentFor, useAppStore } from './store'
 
 /**
@@ -10,7 +11,7 @@ export async function refreshEnvironments(): Promise<void> {
   const repos = project?.repositories.filter((r) => r.environments?.enabled) ?? []
   if (repos.length === 0 || !envToolCheck?.ok) return
   try {
-    const lists = await Promise.all(repos.map((r) => window.api.envList(null, r.path)))
+    const lists = await Promise.all(repos.map((r) => window.api.envList(null, envRepoKey(r))))
     setEnvironments(lists.flat())
   } catch {
     // colima hiccup — keep the last known state; the next poll retries
```

```diff
diff --git a/src/renderer/src/components/EnvironmentPanel.tsx b/src/renderer/src/components/EnvironmentPanel.tsx
index cbf6f7b..eccc18d 100644
--- a/src/renderer/src/components/EnvironmentPanel.tsx
+++ b/src/renderer/src/components/EnvironmentPanel.tsx
@@ -1,5 +1,5 @@
 import { useEffect, useRef, useState } from 'react'
-import { ENV_DEFAULTS, deriveProfileName, parseEnvVars } from '../../../shared/environments'
+import { ENV_DEFAULTS, deriveProfileName, envRepoKey, parseEnvVars } from '../../../shared/environments'
 import type { EnvService, EnvUpStep, GitWorktreeInfo } from '../../../shared/types'
 import { refreshEnvironments } from '../environmentActions'
 import { envStartArgs } from '../environmentStart'
@@ -42,7 +42,8 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   const repo = project ? repoOfInfo(project, info) : undefined
-  const repoPath = repo?.path ?? ''
+  // The path its VM names hash: the repository's, or the one an import kept (envRepoKey).
+  const repoPath = repo ? envRepoKey(repo) : ''
   const profile = info.branch ? deriveProfileName(repoPath, info.branch) : null
   const env = environmentFor(environments, repoPath, info.branch)
   const busy = profile ? envBusy[profile] : undefined
```

```diff
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 09ca363..6b7b6e5 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -40,6 +40,7 @@ import { TerminalPane } from './TerminalPane'
 import { TicketModal } from './TicketModal'
 import { PullRequestModal } from './PullRequestModal'
 import { MoveWorktreeModal } from './MoveWorktreeModal'
+import { envRepoKey } from '../../../shared/environments'
 import { getProvider } from '../../../shared/providers/registry'
 import { describeLlm } from '../../../shared/providers/selection'
 import type { GitWorktreeInfo, Repository, StackStatus } from '../../../shared/types'
@@ -222,7 +223,7 @@ export function WorktreeDetail({
 
   const envEnabled = !!repo.environments?.enabled
   const showEnv = features.env && envEnabled && !isRemote && !!info.branch
-  const env = showEnv ? environmentFor(environments, repo.path, info.branch) : undefined
+  const env = showEnv ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
   const envOpBusy = env ? envBusy[env.profile] : undefined
   const envChipLabel = envOpBusy
     ? { start: 'Env starting…', stop: 'Env stopping…', destroy: 'Env resetting…' }[envOpBusy]
```

```diff
diff --git a/src/renderer/src/components/Sidebar.tsx b/src/renderer/src/components/Sidebar.tsx
index 247201a..7621b94 100644
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -21,6 +21,7 @@ import { VoiceToggle } from './VoiceToggle'
 import { removalBlock } from '../repositoryActions'
 import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
+import { envRepoKey } from '../../../shared/environments'
 import { sameWorktree, worktreeKey } from '../../../shared/types'
 import type { GitWorktreeInfo, HostStatus, Repository, TerminalStatus } from '../../../shared/types'
 
@@ -214,7 +215,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
     const env =
       info.serverId || !features.env
         ? undefined
-        : environmentFor(environments, repo.path, info.branch)
+        : environmentFor(environments, envRepoKey(repo), info.branch)
     const envIsBusy = env ? !!envBusy[env.profile] : false
     const isSelected =
       (selected && sameWorktree(info, selected)) ||
```

- [ ] **Step 6: The path rules**

`src/main/importRules.ts`:

```diff
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index bbd103d..4c8b458 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -2,6 +2,8 @@
 // migrated.json records, and how recents and open-windows.json are rewritten. Pure.
 import { LOCAL_ENTRY_ID, originOf } from '../shared/appServerRules.ts'
 import { LOCAL_TARGET } from '../shared/model/importProject.ts'
+import type { Project, Session } from '../shared/model/types.ts'
+import { sessionMigrates } from '../shared/providers/selection.ts'
 import type { ServerConfig } from '../shared/types.ts'
 import { MAX_RECENTS, type RecentEntry } from './recentsRules.ts'
 import { isTargetId, sameTarget, type OpenWindowEntry, type WindowTarget } from './windowRules.ts'
@@ -245,3 +247,121 @@ export function promptCandidates(
   }
   return out
 }
+
+// ---- Paths: the env profile key, sessions whose cwd moved, a worktree the server refused ------
+
+const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
+
+/** A Claude-style session id. Its .jsonl is copied by this name, so nothing else may pass. */
+export function isAgentSessionId(id: unknown): id is string {
+  return typeof id === 'string' && UUID.test(id)
+}
+
+/**
+ * The repository path a Local repository's VM names keep hashing (EnvironmentSettings.profileKey):
+ * the path as the file had it, when the server stores another (its realpath, without a
+ * trailing slash). Undefined when they are the same string.
+ */
+export function profileKeyFor(filePath: string, serverPath: string): string | undefined {
+  return filePath === serverPath ? undefined : filePath
+}
+
+/**
+ * `project` with `keys` (repository id → profile key) on each repository's environments.
+ * A repository without environments has made no VM, so it gets none; one that has a key keeps it.
+ */
+export function withProfileKeys(project: Project, keys: ReadonlyMap<string, string>): Project {
+  return {
+    ...project,
+    repositories: project.repositories.map((repo) => {
+      const key = keys.get(repo.id)
+      if (!key || !repo.environments || repo.environments.profileKey) return repo
+      return { ...repo, environments: { ...repo.environments, profileKey: key } }
+    })
+  }
+}
+
+/** Saved sessions whose working directory the server moved: their agent history is filed under `from`. */
+export interface MovedSessions {
+  /** The worktree's name, or "Global" */
+  worktree: string
+  from: string
+  to: string
+  agentSessionIds: string[]
+}
+
+/** Sessions whose history follows the cwd (Claude's kind: sessionMigration), with a usable id. */
+function resumable(sessions: readonly Session[]): string[] {
+  return sessions.filter((s) => sessionMigrates(s) && isAgentSessionId(s.agentSessionId)).map((s) => s.agentSessionId as string)
+}
+
+/**
+ * Compares the project as sent with the project as the server stored it (ids are kept):
+ * each worktree whose path changed, with its resumable sessions. Global sessions run in
+ * the first repository's main worktree.
+ */
+export function movedSessions(sent: Project, stored: Project): MovedSessions[] {
+  const out: MovedSessions[] = []
+  const storedPaths = new Map<string, string>()
+  for (const repo of stored.repositories) for (const w of repo.worktrees) storedPaths.set(w.id, w.path)
+  for (const repo of sent.repositories) {
+    for (const w of repo.worktrees) {
+      const to = storedPaths.get(w.id)
+      const ids = resumable(w.sessions)
+      if (to !== undefined && to !== w.path && ids.length > 0) out.push({ worktree: w.name, from: w.path, to, agentSessionIds: ids })
+    }
+  }
+  const firstMain = sent.repositories[0]?.worktrees.find((w) => w.isMain)
+  const globalTo = firstMain ? storedPaths.get(firstMain.id) : undefined
+  const globalIds = resumable(sent.globalSessions)
+  if (firstMain && globalTo !== undefined && globalTo !== firstMain.path && globalIds.length > 0) {
+    out.push({ worktree: 'Global', from: firstMain.path, to: globalTo, agentSessionIds: globalIds })
+  }
+  return out
+}
+
+export interface WorktreeRef {
+  repoId: string
+  worktreeId: string
+}
+
+/** Whether `message` names `path` as a whole: followed by its end, a space, a comma or a bracket. */
+function names(message: string, path: string): boolean {
+  for (let at = message.indexOf(path); at !== -1; at = message.indexOf(path, at + 1)) {
+    const next = message[at + path.length]
+    if (next === undefined || next === ' ' || next === ',' || next === ')' || next === ';') return true
+  }
+  return false
+}
+
+/**
+ * The non-main worktree a `project.import` refusal names (PATH_DENIED: "Path not under a
+ * configured root: <path>"; BAD_REQUEST: "worktree path <path> is another repository"), so
+ * the import can go on without it. The longest matching path wins. Null when none is named.
+ */
+export function worktreeInError(project: Project, message: string): WorktreeRef | null {
+  let best: (WorktreeRef & { length: number }) | null = null
+  for (const repo of project.repositories) {
+    for (const w of repo.worktrees) {
+      if (w.isMain || !names(message, w.path)) continue
+      if (!best || w.path.length > best.length) best = { repoId: repo.id, worktreeId: w.id, length: w.path.length }
+    }
+  }
+  return best ? { repoId: best.repoId, worktreeId: best.worktreeId } : null
+}
+
+/** `project` without the worktree; its path and how many saved sessions went with it. */
+export function dropWorktree(project: Project, ref: WorktreeRef): { project: Project; path: string; sessions: number } {
+  let path = ''
+  let sessions = 0
+  const repositories = project.repositories.map((repo) => {
+    if (repo.id !== ref.repoId) return repo
+    const gone = repo.worktrees.find((w) => w.id === ref.worktreeId)
+    if (gone) {
+      path = gone.path
+      sessions = gone.sessions.length
+    }
+    return { ...repo, worktrees: repo.worktrees.filter((w) => w.id !== ref.worktreeId) }
+  })
+  return { project: { ...project, repositories }, path, sessions }
+}
```

- [ ] **Step 7: Run the tests**

Run: `node --test scripts/importRules.test.mjs scripts/environments.test.mjs scripts/importProject.test.mjs`

Expected: `# pass 40`, `# fail 0` (21 + 2 + 17).

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`

Expected: `# tests 1535`, `# pass 1534`, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add scripts/environments.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat: imported repositories keep their VM names (profileKey, envRepoKey); the import's path rules" -m "Co-Authored-By: <model trailer>" -- scripts/environments.test.mjs scripts/importRules.test.mjs scripts/importProject.test.mjs src/main/importRules.ts src/shared/model/importProject.ts src/shared/environments.ts src/shared/types.ts src/renderer/src/worktreeActions.ts src/renderer/src/environmentActions.ts src/renderer/src/components/EnvironmentPanel.tsx src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx
```

---

### Task 3: v1 tokens follow their projects, origin-bound

**Files:**
- Modify: `src/main/serverTokenRules.ts`, `src/main/servers.ts`, `src/main/appServers.ts`
- Test: `scripts/serverTokenRules.test.mjs`

- [ ] **Step 1: The failing test**

```diff
diff --git a/scripts/serverTokenRules.test.mjs b/scripts/serverTokenRules.test.mjs
index d64bbe4..af2463c 100644
--- a/scripts/serverTokenRules.test.mjs
+++ b/scripts/serverTokenRules.test.mjs
@@ -3,6 +3,7 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
   ADDRESS_CHANGED,
+  adoptableToken,
   INVALID_URL,
   NO_TOKEN,
   TOKEN_UNBOUND,
@@ -96,3 +97,16 @@ test('checkSetToken refuses a bad token or URL from the renderer', () => {
   }
   for (const url of ['garbage', 'file:///tmp/x', 'wss://']) assert.equal(checkSetToken('tok', url), INVALID_URL, url)
 })
+
+test("adoptableToken: an import carries a v1 token to an app-server entry on the origin it was entered for, and nowhere else", () => {
+  const stored = decodeTokenRecord(encodeTokenRecord('tok', 'wss://build.example:7777'))
+  assert.equal(adoptableToken('wss://build.example:7777', stored), 'tok')
+  assert.equal(adoptableToken('wss://build.example:7777/sub', stored), 'tok')
+  assert.equal(adoptableToken('wss://build.example:7778', stored), null)
+  assert.equal(adoptableToken('ws://build.example:7777', stored), null)
+  assert.equal(adoptableToken('wss://evil.example:7777', stored), null)
+  // Saved before tokens were bound: its origin is unknown, so it is not carried.
+  assert.equal(adoptableToken('wss://build.example:7777', decodeTokenRecord('bare-token')), null)
+  assert.equal(adoptableToken('wss://build.example:7777', null), null)
+  assert.equal(adoptableToken('not a url', stored), null)
+})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/serverTokenRules.test.mjs`

Expected: `SyntaxError: The requested module '../src/main/serverTokenRules.ts' does not provide an export named 'adoptableToken'`, `# fail 1`.

- [ ] **Step 3: The rule**

```diff
diff --git a/src/main/serverTokenRules.ts b/src/main/serverTokenRules.ts
index 151f65c..c7ac8ac 100644
--- a/src/main/serverTokenRules.ts
+++ b/src/main/serverTokenRules.ts
@@ -84,3 +84,13 @@ export function tokenCheck(url: string, stored: StoredServerToken | null): Serve
   const decision = tokenToSend(url, stored)
   return decision.ok ? { ok: true } : decision
 }
+
+/**
+ * The v1 token an import may copy into an app-server entry at `entryUrl` (phase 4d): only one
+ * stored bound to that entry's origin. A token saved before binding, or for another origin, stays
+ * where it is, and the user enters it for the entry.
+ */
+export function adoptableToken(entryUrl: string, stored: StoredServerToken | null): string | null {
+  const decision = tokenToSend(entryUrl, stored)
+  return decision.ok ? decision.token : null
+}
```

- [ ] **Step 4: Main's side: read a v1 token for an entry's URL; add an entry; adopt a token**

None of these is reachable over IPC. `addAppServer` goes through `save`, so it gets Save's checks (a duplicate URL, Local's URL, the URL's form) and its rollback. `adoptAppServerToken` never replaces an entry's own token, and refuses an entry whose URL is no longer the one the token was matched to.

```diff
diff --git a/src/main/servers.ts b/src/main/servers.ts
index 6cf2f93..9aa81ae 100644
--- a/src/main/servers.ts
+++ b/src/main/servers.ts
@@ -5,7 +5,7 @@ import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol'
 import { broadcast } from './hosts/LocalHost'
 import { RemoteHost } from './hosts/RemoteHost'
 import { allRemoteHosts, deleteRemoteHost, getRemoteHost, setRemoteHost } from './hosts/registry'
-import { checkSetToken, decodeTokenRecord, encodeTokenRecord, tokenCheck, tokenToSend, type StoredServerToken } from './serverTokenRules'
+import { adoptableToken, checkSetToken, decodeTokenRecord, encodeTokenRecord, tokenCheck, tokenToSend, type StoredServerToken } from './serverTokenRules'
 
 /**
  * Access tokens are encrypted, keyed by server id, each with the origin it was
@@ -27,6 +27,14 @@ async function setToken(serverId: string, token: string | null, url?: string): P
   await tokens.set(serverId, encodeTokenRecord(token, url as string))
 }
 
+/**
+ * Main-only (the importer): the v1 token stored for the legacy server `serverId`, when it was
+ * entered for `entryUrl`'s origin (adoptableToken). Never returned over IPC.
+ */
+export async function legacyTokenFor(serverId: string, entryUrl: string): Promise<string | null> {
+  return adoptableToken(entryUrl, await getStored(serverId))
+}
+
 function emitStatus(event: ServerStatusEvent): void {
   broadcast('server:status', event)
 }
```

```diff
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
index ad1780c..d78cb2d 100644
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -287,6 +287,35 @@ async function test(id: unknown): Promise<AppServerTest> {
   return result
 }
 
+/** The saved entries (not Local), for the importer's matching by origin. */
+export function savedAppServers(): AppServer[] {
+  return loaded().map((s) => ({ ...s }))
+}
+
+/**
+ * Main-only (the importer): a new entry for a legacy server the user agreed to add, with the
+ * v1 token carried over when one was stored for its origin (or none). Goes through Save's checks.
+ */
+export async function addAppServer(name: string, url: string, token: string | null): Promise<AppServerInfo> {
+  return save({ name, url, token })
+}
+
+/**
+ * Main-only (the importer): stores `token` for a saved entry that has none, so a legacy server's
+ * token follows its project. `url` is the address the token was matched to (adoptableToken): an
+ * entry re-pointed meanwhile gets nothing. An entry's own token is never replaced. True when stored.
+ */
+export async function adoptAppServerToken(id: string, url: string, token: string): Promise<boolean> {
+  refuseLocal(id, 'given a token')
+  const server = requireKnown(id)
+  if (server.url !== url || (await tokens.get(server.id))) return false
+  // Read again after the await: a save in between may have re-pointed it.
+  if (getAppServer(server.id)?.url !== url) return false
+  await tokens.set(server.id, token)
+  await linksFollow()
+  return true
+}
+
 /** Quit: main's connections close for good. */
 export function closeServerLinks(): void {
   links?.close()
```

- [ ] **Step 5: Verify**

Run: `node --test scripts/serverTokenRules.test.mjs && npm run typecheck && npm test`

Expected: `# pass 12` for the file; then `# tests 1536`, `# pass 1535`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): an import carries a v1 token to an app-server entry on its own origin only" -m "Co-Authored-By: <model trailer>" -- scripts/serverTokenRules.test.mjs src/main/serverTokenRules.ts src/main/servers.ts src/main/appServers.ts
```

---

### Task 4: The stores — `migrated.json`, recents, restored windows

**Files:**
- Create: `src/main/migrated.ts`
- Modify: `src/main/recents.ts`, `src/main/windows.ts`

The rules are Task 1's (`recordImport`, `rewriteRecents`, `restoreEntries`, tested there). This task wires them to the disk; `smoke:import` covers it.

- [ ] **Step 1: `migrated.json`**

`src/main/migrated.ts`:

```ts
// userData/migrated.json: which .trekproj files were imported, into which server projects,
// and whether the first-launch prompt has run (importRules.ts has the format).
import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './secrets'
import { parseMigrated, serializeMigrated, type Migrated } from './importRules'

function migratedPath(): string {
  return join(app.getPath('userData'), 'migrated.json')
}

/** A .trekproj's key: its realpath, so a symlink or another spelling finds the same import. */
export function fileKey(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Whether `path` is the file `key` names (for the recents and open-windows rewrites). */
export function isFileKey(key: string): (path: string) => boolean {
  return (path) => fileKey(path) === key
}

export async function readMigrated(): Promise<Migrated> {
  try {
    return parseMigrated(JSON.parse(await readFile(migratedPath(), 'utf8')))
  } catch {
    return parseMigrated(null) // first run, or unreadable: nothing imported yet
  }
}

/** Every change is a read-modify-write; chained so two imports never lose each other's entry. */
let chain: Promise<unknown> = Promise.resolve()

export function updateMigrated(change: (m: Migrated) => Migrated): Promise<Migrated> {
  const run = chain.then(async () => {
    const next = change(await readMigrated())
    await writeFileAtomic(migratedPath(), JSON.stringify(serializeMigrated(next), null, 2))
    return next
  })
  chain = run.catch(() => undefined)
  return run
}
```

- [ ] **Step 2: Recents follow an import**

```diff
diff --git a/src/main/recents.ts b/src/main/recents.ts
index 735d6d3..63f47f0 100644
--- a/src/main/recents.ts
+++ b/src/main/recents.ts
@@ -3,6 +3,7 @@ import { access, readFile } from 'node:fs/promises'
 import { join } from 'node:path'
 import { writeFileAtomic } from './secrets'
 import { addRecentEntry, keepRecents, parseRecents, removeRecentEntry, serializeRecents, type RecentEntry } from './recentsRules'
+import { rewriteRecents, type MigratedPiece } from './importRules'
 
 function recentsFile(): string {
   return join(app.getPath('userData'), 'recent-projects.json')
@@ -61,3 +62,8 @@ export function addRecentServer(entry: Extract<RecentEntry, { kind: 'server' }>)
 export function removeRecent(entry: RecentEntry): Promise<void> {
   return update((list) => removeRecentEntry(list, entry))
 }
+
+/** An import: its pieces' server entries take the place of the file's (importRules.rewriteRecents). */
+export function rewriteRecentsForImport(isFile: (path: string) => boolean, pieces: readonly MigratedPiece[]): Promise<void> {
+  return update((list) => rewriteRecents(list, isFile, pieces))
+}
```

- [ ] **Step 3: A restored window on an imported file opens its Local piece**

`readRestoreEntries` is for the first-launch prompt (Task 8). `restoreWindows` maps each entry through `restoreEntries` (Decision 19); the windows it creates persist the server targets.

```diff
diff --git a/src/main/windows.ts b/src/main/windows.ts
index db8545a..ff8b12c 100644
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -25,6 +25,8 @@ import {
   type WindowBounds,
   type WindowTarget
 } from './windowRules'
+import { restoreEntries } from './importRules'
+import { fileKey, readMigrated } from './migrated'
 
 // icon.png is extracted from AppIcon.icns (the packaging icon) — nativeImage
 // needs a PNG for the runtime dock icon.
@@ -390,6 +392,11 @@ async function readOpenWindows(): Promise<OpenWindowEntry[]> {
   }
 }
 
+/** The windows open at the last quit, as open-windows.json has them (the first-launch prompt reads their files). */
+export function readRestoreEntries(): Promise<OpenWindowEntry[]> {
+  return readOpenWindows()
+}
+
 /** Reopens the windows from last time, one at a time, or one empty window. */
 export async function restoreWindows(): Promise<void> {
   if (RESTORE_DISABLED) {
@@ -398,7 +405,8 @@ export async function restoreWindows(): Promise<void> {
   }
   const workAreas = screen.getAllDisplays().map((d) => d.workArea)
   let restored = 0
-  for (const { target, bounds } of await readOpenWindows()) {
+  // A window on a .trekproj that was imported comes back on its server project (Local's piece).
+  for (const { target, bounds } of restoreEntries(await readOpenWindows(), await readMigrated(), fileKey)) {
     // A server window comes back even if its entry is gone: it shows "Server removed".
     if (target.kind === 'file') {
       const exists = await access(target.path).then(
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`

Expected: `# tests 1536`, `# pass 1535`, `# fail 0` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/main/migrated.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): migrated.json; recents follow an import; a restored window on an imported file opens its project" -m "Co-Authored-By: <model trailer>" -- src/main/migrated.ts src/main/recents.ts src/main/windows.ts
```

---

### Task 5: The importer

**Files:**
- Create: `src/main/importer.ts`

Everything goes over main's own connection to each entry (`serverLink`). For a new entry, `addAppServer` awaits `linksFollow()`, so the link exists by the time `waitForLink` looks; a needs-auth or incompatible link fails at once, and an entry with no token fails without waiting (Decision 12). The project is read back with `mirror.subscribe` (the mirror's own bookkeeping) rather than a raw `sub.subscribe` on main's socket.

- [ ] **Step 1: The importer**

`src/main/importer.ts`:

```ts
// The .trekproj importer (phase 4d). A file is split by server (importProjectFile); each piece
// goes to its server over main's own connection to it (serverLinks.ts, so no token leaves main):
// its repositories are registered first (server.addRepo), then the project is sent with
// `project.import`. The project is read back to find the sessions whose path the server moved
// (its realpath), whose agent history is copied there on Local. migrated.json records the pieces
// (restoreWindows reads it, so a window on the file comes back on its project), and recents
// follow. The file is only read.
import { randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { originOf } from '../shared/appServerRules.ts'
import type { RegisteredServer } from '../shared/client/index.ts'
import type { RawProjectFile } from '../shared/migration'
import { importProjectFile, LOCAL_TARGET, type ImportedProject } from '../shared/model/importProject.ts'
import { projectTopic } from '../shared/model/topics.ts'
import type { Project } from '../shared/model/types'
import type { ServerConfig } from '../shared/types'
import { projectDir } from '../host/claudeSessionService'
import { addAppServer, adoptAppServerToken, getAppServer, getAppServerToken, savedAppServers, serverLink } from './appServers'
import { LOCAL_SERVER_DISABLED } from './localServer'
import { LOCAL_ENTRY_ID, LOCAL_ENTRY_NAME } from './localServerRules'
import { legacyTokenFor } from './servers'
import { fileKey, isFileKey, updateMigrated } from './migrated'
import { rewriteRecentsForImport } from './recents'
import {
  dropWorktree,
  movedSessions,
  profileKeyFor,
  recordImport,
  routePiece,
  withProfileKeys,
  worktreeInError,
  type MigratedLeft,
  type MigratedPiece,
  type MovedSessions
} from './importRules'

/** Local may still be starting (first launch): its supervisor's own wait, and then some. */
const LOCAL_WAIT_MS = 60_000
const REMOTE_WAIT_MS = 15_000
const IMPORT_TIMEOUT_MS = 30_000
const READ_BACK_MS = 10_000
/** At most this many worktrees are dropped from one piece before the import gives up on it */
const MAX_REFUSED_WORKTREES = 50

export interface ImportOptions {
  /** Only these targets: a retry of the pieces left by an earlier import */
  only?: readonly string[]
  /**
   * A piece's server has no entry: whether to add it. `tokenCarried` says whether the token
   * saved for it in this app (for that origin) comes along.
   */
  askAddServer(server: ServerConfig, tokenCarried: boolean): Promise<boolean>
  /** Origins the user declined to add, shared by the files of one run so each is asked once */
  declined?: Set<string>
  /** Entries that could not be reached, with why, shared by the files of one run so each waits once */
  unreachable?: Map<string, string>
}

export interface ImportReport {
  path: string
  /** migrated.json's key: the file's realpath */
  key: string
  name: string
  pieces: MigratedPiece[]
  left: MigratedLeft[]
  warnings: string[]
  /** Saved sessions whose agent history was copied to the path the server runs them in */
  carried: number
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | undefined => (err as { code?: unknown } | null)?.code as string | undefined

function fileServersOf(raw: RawProjectFile): ServerConfig[] {
  return (Array.isArray(raw.servers) ? raw.servers : []).filter(
    (s): s is ServerConfig => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string'
  )
}

/** Reads and splits the file; throws when it is not a project file. */
async function readProjectFile(path: string): Promise<RawProjectFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as RawProjectFile
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This is not a Trek project file')
  // As openProjectFile does for a file window.
  if (!raw.name) raw.name = basename(path).replace(/\.trekproj$/, '')
  if (!Array.isArray(raw.worktrees) && !raw.repositories) raw.worktrees = []
  return raw
}

export async function importTrekproj(path: string, options: ImportOptions): Promise<ImportReport> {
  const key = fileKey(path)
  const raw = await readProjectFile(path)
  const { projects, warnings } = importProjectFile(raw, randomUUID)
  const report: ImportReport = { path, key, name: raw.name, pieces: [], left: [], warnings: [...warnings], carried: 0 }
  const globals = Array.isArray(raw.globalSessions) ? raw.globalSessions.length : 0
  if (globals > 0 && !projects.some((p) => p.target === LOCAL_TARGET)) {
    report.warnings.push(`The Global panel's ${globals} session(s) were not imported: they belong with this machine's repositories, and the file has none.`)
  }
  const fileServers = fileServersOf(raw)
  const attempted: string[] = []
  for (const piece of projects) {
    if (options.only && !options.only.includes(piece.target)) continue
    attempted.push(piece.target)
    const label = piece.target === LOCAL_TARGET ? LOCAL_ENTRY_NAME : (piece.serverName ?? `server ${piece.target}`)
    try {
      report.pieces.push(await importPiece(piece, fileServers, options, report))
    } catch (err) {
      report.left.push({ target: piece.target, label, reason: errorText(err) })
    }
  }
  await updateMigrated((m) => recordImport(m, key, { attempted, pieces: report.pieces, left: report.left }))
  if (report.pieces.length > 0) {
    await rewriteRecentsForImport(isFileKey(key), report.pieces).catch((err) => report.warnings.push(`Recent projects were not updated: ${errorText(err)}`))
  }
  return report
}

async function importPiece(piece: ImportedProject, fileServers: ServerConfig[], options: ImportOptions, report: ImportReport): Promise<MigratedPiece> {
  const entry = await entryFor(piece, fileServers, options)
  const isLocal = entry.id === LOCAL_ENTRY_ID
  const failed = options.unreachable?.get(entry.id)
  if (failed) throw new Error(failed)
  let link: RegisteredServer
  try {
    link = await waitForLink(entry.id, entry.name, isLocal ? LOCAL_WAIT_MS : REMOTE_WAIT_MS)
  } catch (err) {
    options.unreachable?.set(entry.id, errorText(err))
    throw err
  }
  let project = await registerRepositories(link, piece.project, entry.name, report.warnings)
  if (isLocal) project = withProfileKeys(project, localProfileKeys(project, piece.sourcePaths))
  const { projectId, sent } = await sendImport(link, project, entry.name, report.warnings)
  try {
    const moved = movedSessions(sent, await readProject(link, projectId))
    if (isLocal) report.carried += await carryHistories(moved, report.warnings)
    else for (const m of moved) report.warnings.push(remoteMoveWarning(m, entry.name))
  } catch (err) {
    report.warnings.push(`Could not read the imported project back from ${entry.name} (${errorText(err)}): sessions whose path changed may start fresh.`)
  }
  return { target: piece.target, serverEntryId: entry.id, projectId, name: piece.project.name, serverName: entry.name }
}

/** The app-server entry a piece goes to: Local, a saved entry (its v1 token carried over), or one the user adds. */
async function entryFor(piece: ImportedProject, fileServers: ServerConfig[], options: ImportOptions): Promise<{ id: string; name: string }> {
  const route = routePiece(piece.target, fileServers, savedAppServers())
  switch (route.kind) {
    case 'local':
      if (LOCAL_SERVER_DISABLED) throw new Error('The Local server is turned off')
      return { id: LOCAL_ENTRY_ID, name: LOCAL_ENTRY_NAME }
    case 'unknown':
      throw new Error(`${route.label}: ${route.why}`)
    case 'entry': {
      const entry = getAppServer(route.entryId)
      if (!entry) throw new Error(`${route.name} was removed from your servers`)
      const token = await legacyTokenFor(piece.target, entry.url)
      if (token) await adoptAppServerToken(entry.id, entry.url, token)
      return { id: entry.id, name: entry.name }
    }
    case 'add': {
      const origin = originOf(route.server.url) ?? route.server.url
      if (options.declined?.has(origin)) throw new Error(`${route.server.name} was not added to your servers`)
      const token = await legacyTokenFor(route.server.id, route.server.url)
      if (!(await options.askAddServer(route.server, token !== null))) {
        options.declined?.add(origin)
        throw new Error(`${route.server.name} was not added to your servers`)
      }
      const added = await addAppServer(route.server.name, route.server.url, token)
      return { id: added.id, name: added.name }
    }
  }
}

/** Main's own connection to the entry, once connected. A missing or rejected token fails at once. */
async function waitForLink(id: string, name: string, timeoutMs: number): Promise<RegisteredServer> {
  const noToken = `${name} has no access token here: set it in Connect to server…, then open the file again to import this part`
  if (id !== LOCAL_ENTRY_ID && !(await getAppServerToken(id))) throw new Error(noToken)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const link = serverLink(id)
    const status = link?.connection.status
    if (link && status === 'connected') return link
    if (status === 'needs-auth') throw new Error(`${name} rejected its access token: set it in Connect to server…, then open the file again to import this part`)
    if (status === 'incompatible') throw new Error(`${name} is incompatible with this Trek (${link?.connection.statusMessage || 'upgrade it'})`)
    if (Date.now() >= deadline) throw new Error(`Could not connect to ${name}${status ? ` (${status})` : ''}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

/**
 * Registers each repository on the server (a no-op when it is already there). One the server
 * refuses (PATH_DENIED: outside its roots; NOT_A_REPO) is left out with a warning.
 */
async function registerRepositories(link: RegisteredServer, project: Project, serverName: string, warnings: string[]): Promise<Project> {
  const kept: Project['repositories'] = []
  for (const repo of project.repositories) {
    try {
      await link.connection.request('server.addRepo', { path: repo.path, name: repo.name })
      kept.push(repo)
    } catch (err) {
      const code = codeOf(err)
      if (code !== 'PATH_DENIED' && code !== 'NOT_A_REPO') throw err
      const sessions = repo.worktrees.reduce((n, w) => n + w.sessions.length, 0)
      warnings.push(
        `Repository "${repo.name}" (${repo.path}) was not added on ${serverName} (${code}: ${errorText(err)}); its ${repo.worktrees.length} worktree(s) and ${sessions} session(s) were not imported.`
      )
    }
  }
  if (kept.length === 0) throw new Error(`None of its repositories could be added on ${serverName}`)
  return { ...project, repositories: kept }
}

/** Each Local repository whose file path is not its realpath keeps the file's path for its VM names. */
function localProfileKeys(project: Project, sourcePaths: Record<string, string>): Map<string, string> {
  const keys = new Map<string, string>()
  for (const repo of project.repositories) {
    const source = sourcePaths[repo.id]
    let real: string
    try {
      real = realpathSync(repo.path)
    } catch {
      continue
    }
    const key = source === undefined ? undefined : profileKeyFor(source, real)
    if (key) keys.set(repo.id, key)
  }
  return keys
}

/** `project.import`; a worktree the server refuses by path is left out (with a warning) and the import is sent again. */
async function sendImport(link: RegisteredServer, project: Project, serverName: string, warnings: string[]): Promise<{ projectId: string; sent: Project }> {
  let sent = project
  for (let refused = 0; ; refused++) {
    try {
      const { projectId } = await link.connection.request('project.import', { project: sent }, { timeoutMs: IMPORT_TIMEOUT_MS })
      return { projectId, sent }
    } catch (err) {
      const code = codeOf(err)
      const ref = (code === 'PATH_DENIED' || code === 'BAD_REQUEST') && refused < MAX_REFUSED_WORKTREES ? worktreeInError(sent, errorText(err)) : null
      if (!ref) throw err
      const dropped = dropWorktree(sent, ref)
      sent = dropped.project
      warnings.push(`Worktree ${dropped.path} was refused by ${serverName} (${errorText(err)}); it and its ${dropped.sessions} session(s) were not imported.`)
    }
  }
}

/** The project as the server stored it: one snapshot from main's mirror, then unsubscribed. */
function readProject(link: RegisteredServer, projectId: string): Promise<Project> {
  return new Promise((resolve, reject) => {
    let done = false
    let off: (() => void) | null = null
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle()
      queueMicrotask(() => off?.())
    }
    const timer = setTimeout(() => finish(() => reject(new Error('timed out'))), READ_BACK_MS)
    off = link.mirror.subscribe(projectTopic(projectId), (update) => {
      if ('error' in update) finish(() => reject(update.error))
      else finish(() => resolve(structuredClone(update.snapshot as Project)))
    })
    if (done) off()
  })
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/**
 * Claude files a session's history under its working directory (claudeSessionService). A session
 * the server now runs from another path (its realpath) would not find it, so its .jsonl is copied
 * there, never moved: the file window can still resume it. One already there is left alone.
 */
async function carryHistories(moved: readonly MovedSessions[], warnings: string[]): Promise<number> {
  let copied = 0
  for (const m of moved) {
    for (const id of m.agentSessionIds) {
      const from = join(projectDir(m.from), `${id}.jsonl`)
      const to = join(projectDir(m.to), `${id}.jsonl`)
      try {
        if ((await exists(to)) || !(await exists(from))) continue
        await mkdir(projectDir(m.to), { recursive: true })
        await copyFile(from, to, constants.COPYFILE_EXCL)
        copied++
      } catch (err) {
        warnings.push(`The history of a session in ${m.worktree} was not copied to ${m.to} (${errorText(err)}); it may start fresh.`)
      }
    }
  }
  return copied
}

function remoteMoveWarning(m: MovedSessions, serverName: string): string {
  return `${m.agentSessionIds.length} session(s) in ${m.worktree} were saved under ${m.from}, but ${serverName} runs them in ${m.to}: they may start fresh rather than resume.`
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`

Expected: `# tests 1536`, `# pass 1535`, `# fail 0`. Nothing calls it yet; Tasks 6–8 do, and `smoke:import` drives it.

- [ ] **Step 3: Commit**

```bash
git add src/main/importer.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): the .trekproj importer: route, register, import, read back, carry Claude histories, record" -m "Co-Authored-By: <model trailer>" -- src/main/importer.ts
```

---

### Task 6: File → Import .trekproj… and the result dialog

**Files:**
- Create: `src/main/importUi.ts`
- Modify: `src/main/importRules.ts`, `src/main/windows.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`
- Test: `scripts/importRules.test.mjs`

- [ ] **Step 1: The failing test (the result text)**

```diff
diff --git a/scripts/importRules.test.mjs b/scripts/importRules.test.mjs
index 5f8bb1c..fcda24e 100644
--- a/scripts/importRules.test.mjs
+++ b/scripts/importRules.test.mjs
@@ -4,6 +4,7 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
   dropWorktree,
+  importSummary,
   isAgentSessionId,
   localFirst,
   markPrompted,
@@ -279,3 +280,47 @@ test('dropWorktree takes the worktree out and says how many sessions went with i
   assert.deepEqual([path, sessions], ['/r/app-x', 3])
   assert.equal(p.repositories[0].worktrees.length, 2, 'the input is not changed')
 })
+
+// ---- The result dialog ----------------------------------------------------------------------
+
+const report = (extra = {}) => ({
+  path: '/p/Proj.trekproj',
+  key: '/p/Proj.trekproj',
+  name: 'Proj',
+  pieces: [],
+  left: [],
+  warnings: [],
+  carried: 0,
+  ...extra
+})
+
+test('importSummary: every piece landed', () => {
+  const s = importSummary([report({ pieces: [piece('local', 'p1'), piece('srv', 'p2')], carried: 2 })])
+  assert.equal(s.type, 'info')
+  assert.equal(s.message, 'Imported “Proj”')
+  assert.match(s.detail, /^“Proj” is now 2 projects: on Local and on Build\./)
+  assert.match(s.detail, /2 sessions' history was copied to the path the server runs them in\./)
+  assert.match(s.detail, /Not carried over: /)
+  assert.match(s.detail, /The \.trekproj file was not changed\./)
+})
+
+test('importSummary: a part left, with its reason, and the warnings', () => {
+  const s = importSummary([report({ pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }], warnings: ['w1'] })])
+  assert.equal(s.type, 'warning')
+  assert.equal(s.message, '“Proj” was imported in part')
+  assert.match(s.detail, /“Proj” is now a project on Local\./)
+  assert.match(s.detail, /Not imported: build-box — not added\. Open the file again to retry\./)
+  assert.match(s.detail, /• w1/)
+})
+
+test('importSummary: nothing landed', () => {
+  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }] })])
+  assert.deepEqual([s.type, s.message], ['error', '“Proj” could not be imported'])
+  assert.doesNotMatch(s.detail, /Not carried over/)
+})
+
+test('importSummary: several files, and one that could not be read', () => {
+  const s = importSummary([report({ pieces: [piece('local', 'p1')] }), { path: '/p/Bad.trekproj', error: 'Unexpected token' }])
+  assert.deepEqual([s.type, s.message], ['warning', 'Imported 1 of 2 projects'])
+  assert.match(s.detail, /“Bad\.trekproj” could not be read: Unexpected token/)
+})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test scripts/importRules.test.mjs`

Expected: `SyntaxError: The requested module '../src/main/importRules.ts' does not provide an export named 'importSummary'`, `# fail 1`.

- [ ] **Step 3: `importSummary`**

```diff
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index 4c8b458..e493f58 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -365,3 +365,45 @@ export function dropWorktree(project: Project, ref: WorktreeRef): { project: Pro
   })
   return { project: { ...project, repositories }, path, sessions }
 }
+
+// ---- The result dialog --------------------------------------------------------------------
+
+/** One file's import, as the result dialog reads it (importer.ts's ImportReport, or a file that could not be read). */
+export type ImportOutcome =
+  | { name: string; pieces: readonly MigratedPiece[]; left: readonly MigratedLeft[]; warnings: readonly string[]; carried: number }
+  | { path: string; error: string }
+
+/** What a file window had that no server project holds. */
+export const NOT_CARRIED =
+  "Not carried over: open tabs, the selection and drafts; running terminals (sessions come back idle and resume when loaded); the project bot's folder and consent; the file's own server list."
+
+const quoted = (name: string): string => `“${name}”`
+
+function fileSection(o: ImportOutcome): string {
+  if ('error' in o) return `${quoted(o.path.split('/').pop() ?? o.path)} could not be read: ${o.error}`
+  const lines: string[] = []
+  const places = localFirst(o.pieces).map((p) => p.serverName)
+  if (places.length === 1) lines.push(`${quoted(o.name)} is now a project on ${places[0]}.`)
+  else if (places.length > 1) lines.push(`${quoted(o.name)} is now ${places.length} projects: ${places.map((p) => `on ${p}`).join(' and ')}.`)
+  for (const l of o.left) lines.push(`Not imported: ${l.label} — ${l.reason.replace(/\.$/, '')}.${o.pieces.length > 0 ? ' Open the file again to retry.' : ''}`)
+  if (o.carried > 0) lines.push(`${o.carried} session${o.carried === 1 ? "'s" : "s'"} history was copied to the path the server runs them in.`)
+  for (const w of o.warnings) lines.push(`• ${w}`)
+  return lines.join('\n')
+}
+
+/** The result dialog for one import or a first-launch run of several. */
+export function importSummary(outcomes: readonly ImportOutcome[]): { type: 'info' | 'warning' | 'error'; message: string; detail: string } {
+  const landed = outcomes.filter((o) => !('error' in o) && o.pieces.length > 0)
+  const clean = landed.filter((o) => !('error' in o) && o.left.length === 0 && o.warnings.length === 0)
+  const type = landed.length === 0 ? 'error' : clean.length === outcomes.length ? 'info' : 'warning'
+  let message: string
+  if (outcomes.length === 1 && !('error' in outcomes[0])) {
+    const o = outcomes[0]
+    message = o.pieces.length === 0 ? `${quoted(o.name)} could not be imported` : o.left.length > 0 ? `${quoted(o.name)} was imported in part` : `Imported ${quoted(o.name)}`
+  } else {
+    message = `Imported ${landed.length} of ${outcomes.length} project${outcomes.length === 1 ? '' : 's'}`
+  }
+  const sections = outcomes.map(fileSection)
+  if (landed.length > 0) sections.push(NOT_CARRIED, outcomes.length === 1 ? 'The .trekproj file was not changed.' : 'The .trekproj files were not changed.')
+  return { type, message, detail: sections.join('\n\n') }
+}
```

Run: `node --test scripts/importRules.test.mjs`

Expected: `# pass 25`, `# fail 0`.

- [ ] **Step 4: `openServerTarget` and `closeFileWindow`**

`window:openServerProject`'s body moves into `openServerTarget`, unchanged for that caller. `announce` is Decision 4; `closeFileWindow` is Decision 3.

```diff
diff --git a/src/main/windows.ts b/src/main/windows.ts
index ff8b12c..552d852 100644
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -151,6 +151,68 @@ export function showServerSession(serverEntryId: string, projectId: string, sele
   }
 }
 
+/**
+ * Opens a server project: focuses the window that holds it, takes `sender` when that window is
+ * empty (`opened: true`: its renderer switches to the project, told by the IPC reply, or by
+ * `window:showServer` with `announce`), or opens a new window (at `bounds`, when given).
+ * `sender` null always means a new window. Recorded as a recent.
+ */
+export async function openServerTarget(
+  sender: WebContents | null,
+  target: Extract<WindowTarget, { kind: 'server' }>,
+  name: unknown,
+  serverName: unknown,
+  opts: { bounds?: WindowBounds; announce?: boolean } = {}
+): Promise<{ opened: boolean }> {
+  // The user's own label for the server wins over the name the server reports (which may be empty).
+  const recent = {
+    kind: 'server' as const,
+    serverEntryId: target.serverEntryId,
+    projectId: target.projectId,
+    name: capLabel(name),
+    serverName: capLabel(getAppServer(target.serverEntryId)?.name || serverName)
+  }
+  // The window is already claimed or created by then; a failed recents write must not fail the call.
+  const remember = async (): Promise<void> => {
+    try {
+      await addRecentServer(recent)
+    } catch (err) {
+      console.warn('[windows] could not record recent server project:', err)
+    }
+  }
+  const holder = windowHolding(target)
+  const state = sender && !sender.isDestroyed() ? windows.get(sender.id) : undefined
+  // Told by main, the renderer must be listening already.
+  const usable = !!state && (!opts.announce || state.rendererReady)
+  switch (decideOpen(!usable || windowHasProject(sender!), holder !== undefined)) {
+    case 'focus-existing':
+      focusWindow(holder!.win)
+      return { opened: false }
+    case 'new-window':
+      createWindow({ initialTarget: target, bounds: opts.bounds })
+      await remember()
+      return { opened: false }
+    case 'use-sender':
+      claimTarget(sender!, target)
+      // A main-side open (an import): the window hears it here, not from an IPC reply.
+      if (opts.announce) sender!.send('window:showServer', { serverEntryId: target.serverEntryId, projectId: target.projectId })
+      await remember()
+      return { opened: true }
+  }
+}
+
+/**
+ * Asks the file window holding `filePath`, if any, to close (its renderer offers to save first),
+ * before an import reads the file. `closed` false: the user kept it open. `bounds` are its own.
+ */
+export async function closeFileWindow(filePath: string): Promise<{ closed: boolean; bounds?: WindowBounds }> {
+  const holder = windowHoldingFile(filePath)
+  if (!holder) return { closed: true }
+  const bounds = holder.win.getNormalBounds()
+  if (holder.rendererReady) focusWindow(holder.win)
+  return { closed: await requestClose(holder), bounds }
+}
+
 export function focusWindowHoldingFile(filePath: string): void {
   const holder = windowHoldingFile(filePath)
   if (holder) focusWindow(holder.win)
@@ -499,37 +561,7 @@ export function registerWindowHandlers(readProject: (path: string) => Promise<Op
     async (event, serverEntryId: unknown, projectId: unknown, name: unknown, serverName: unknown): Promise<{ opened: boolean }> => {
       if (!isTargetId(serverEntryId)) throw new Error(`serverEntryId must be a non-empty string of at most ${MAX_TARGET_ID} characters`)
       if (!isTargetId(projectId)) throw new Error(`projectId must be a non-empty string of at most ${MAX_TARGET_ID} characters`)
-      const target: WindowTarget = { kind: 'server', serverEntryId, projectId }
-      // The user's own label for the server wins over the name the server reports (which may be empty).
-      const recent = {
-        kind: 'server' as const,
-        serverEntryId,
-        projectId,
-        name: capLabel(name),
-        serverName: capLabel(getAppServer(serverEntryId)?.name || serverName)
-      }
-      // The window is already claimed or created by then; a failed recents write must not fail the call.
-      const remember = async (): Promise<void> => {
-        try {
-          await addRecentServer(recent)
-        } catch (err) {
-          console.warn('[windows] could not record recent server project:', err)
-        }
-      }
-      const holder = windowHolding(target)
-      switch (decideOpen(windowHasProject(event.sender), holder !== undefined)) {
-        case 'focus-existing':
-          focusWindow(holder!.win)
-          return { opened: false }
-        case 'new-window':
-          createWindow({ initialTarget: target })
-          await remember()
-          return { opened: false }
-        case 'use-sender':
-          claimTarget(event.sender, target)
-          await remember()
-          return { opened: true }
-      }
+      return openServerTarget(event.sender, { kind: 'server', serverEntryId, projectId }, name, serverName)
     }
   )
 
```

- [ ] **Step 5: The renderer hears `window:showServer`**

```diff
diff --git a/src/preload/index.ts b/src/preload/index.ts
index b73a1ab..810304e 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -67,6 +67,9 @@ const api = {
     serverName: string
   ): Promise<{ opened: boolean }> =>
     ipcRenderer.invoke('window:openServerProject', serverEntryId, projectId, name, serverName),
+  /** Main opened a server project in this (empty) window: an import, from the menu or a .trekproj. */
+  onShowServer: (callback: (server: { serverEntryId: string; projectId: string }) => void): (() => void) =>
+    subscribe('window:showServer', callback),
   reportTitle: (name: string | null): void => ipcRenderer.send('window:reportTitle', name),
   /** A server window gives up its target and becomes an empty window. */
   releaseTarget: (): Promise<void> => ipcRenderer.invoke('window:releaseTarget'),
```

```diff
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index 9a9cc93..dc79090 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -80,6 +80,11 @@ export default function App(): React.JSX.Element {
         const state = useAppStore.getState()
         if (state.project) state.setGlobalPanelOpen(!state.globalPanelOpen)
       }),
+      // An import main opened here: only ever sent to an empty window.
+      window.api.onShowServer((server) => {
+        const state = useAppStore.getState()
+        if (!state.project && !state.serverWindow) state.setServerWindow(server)
+      }),
       window.api.onMcpCall((request) => void handleMcpCall(request)),
       window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
       watchWindowProject(),
```

- [ ] **Step 6: The UI module, with File → Import**

`src/main/importUi.ts`:

```ts
// What the user sees of an import (phase 4d): File → Import .trekproj…, the add-server question,
// the result dialog, and opening the server windows a file became. importer.ts does the work.
import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
import { basename } from 'node:path'
import type { ServerConfig } from '../shared/types'
import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
import { importSummary, localFirst, migratedFile, targetOf, type ImportOutcome, type MigratedPiece } from './importRules'
import { fileKey, readMigrated } from './migrated'
import { closeFileWindow, openServerTarget, windowHasProject } from './windows'
import type { WindowBounds } from './windowRules'

export const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function box(parent: BrowserWindow | null, options: MessageBoxOptions): Promise<number> {
  const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response
}

function askAddServer(parent: BrowserWindow | null): ImportOptions['askAddServer'] {
  return async (server: ServerConfig, tokenCarried: boolean) =>
    (await box(parent, {
      type: 'question',
      message: `Add the server “${server.name}”?`,
      detail:
        `Part of this project is on ${server.name} (${server.url}), which is not in your servers. Add it to import that part.\n\n` +
        (tokenCarried
          ? 'The access token saved in Trek for that address comes with it.'
          : 'No access token is saved in Trek for that address: set one in Connect to server…, then open the file again to import that part.'),
      buttons: ['Add Server', 'Skip'],
      defaultId: 0,
      cancelId: 1
    })) === 0
}

/** One import, asking about servers to add on `parent`. Throws when the file cannot be read. */
export function runImport(path: string, parent: BrowserWindow | null, extra: Pick<ImportOptions, 'only' | 'declined' | 'unreachable'> = {}): Promise<ImportReport> {
  return importTrekproj(path, { ...extra, askAddServer: askAddServer(parent) })
}

/** The result dialog. `buttons` (with the index of the cancel one) when the caller offers a choice. */
export async function showImportResult(parent: BrowserWindow | null, outcomes: readonly ImportOutcome[], choice?: { buttons: string[]; cancelId: number }): Promise<number> {
  const { type, message, detail } = importSummary(outcomes)
  return box(parent, { type, message, detail, buttons: choice?.buttons ?? ['OK'], defaultId: 0, cancelId: choice?.cancelId ?? 0 })
}

/** An empty window of the app whose renderer can take a project, if `win` is one. */
function emptyWindow(win: BrowserWindow | null): WebContents | null {
  return win && !win.isDestroyed() && !windowHasProject(win.webContents) ? win.webContents : null
}

/**
 * The windows of an import, Local's piece first: it takes `sender` when that window is empty
 * (main tells its renderer: `window:showServer`) or opens at `bounds`; each other piece opens in
 * a window of its own. A piece already open is focused.
 */
export async function openPieces(sender: WebContents | null, pieces: readonly MigratedPiece[], bounds?: WindowBounds): Promise<void> {
  for (const [i, piece] of localFirst(pieces).entries()) {
    await openServerTarget(i === 0 ? sender : null, targetOf(piece), piece.name, piece.serverName, { announce: true, bounds: i === 0 ? bounds : undefined })
  }
}

/** File → Import .trekproj…: always an import (Import Again for a file imported before). */
export async function importFromMenu(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow()
  const options = { title: 'Import Project', filters: PROJECT_FILTERS, properties: ['openFile' as const] }
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return
  const path = picked.filePaths[0]
  const before = migratedFile(await readMigrated(), fileKey(path))
  if (before) {
    const response = await box(parent, {
      type: 'question',
      message: `“${basename(path)}” was imported before`,
      detail: 'Open the projects it became, or import it again as new projects. Importing again leaves the earlier projects as they are.',
      buttons: ['Open', 'Import Again', 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
    if (response === 2) return
    if (response === 0) return openPieces(emptyWindow(parent), before.pieces)
  }
  // A file window on it closes first (offering to save), so the import reads what it saved.
  const closed = await closeFileWindow(path)
  if (!closed.closed) return
  let report: ImportReport
  try {
    report = await runImport(path, parent)
  } catch (err) {
    await box(parent, { type: 'error', message: `Could not import “${basename(path)}”`, detail: errorText(err), buttons: ['OK'] })
    return
  }
  await showImportResult(parent, [report])
  await openPieces(closed.bounds ? null : emptyWindow(parent), report.pieces, closed.bounds)
}
```

The menu item, after Open Project…:

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index ef37f47..5b0915d 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -33,6 +33,7 @@ import {
 } from './localServer'
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
+import { importFromMenu } from './importUi'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
 import { registerVoiceHandlers } from './voice'
@@ -111,6 +112,10 @@ function buildMenu(): void {
           accelerator: 'CmdOrCtrl+O',
           click: openProject
         },
+        {
+          label: 'Import .trekproj…',
+          click: () => void importFromMenu()
+        },
         ...localServerMenu(),
         { type: 'separator' },
         {
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`

Expected: `# tests 1540`, `# pass 1539`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/main/importUi.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat: File → Import .trekproj… and the import's result dialog; main can open a server project in an empty window" -m "Co-Authored-By: <model trailer>" -- src/main/importUi.ts src/main/importRules.ts scripts/importRules.test.mjs src/main/windows.ts src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx
```

---

### Task 7: Opening a `.trekproj` imports it, or opens what it became

**Files:**
- Modify: `src/main/importUi.ts`, `src/main/project.ts`, `src/main/index.ts`, `src/renderer/src/components/StartScreen.tsx`, `package.json`

- [ ] **Step 1: `openTrekproj` and `openFromOs`**

```diff
diff --git a/src/main/importUi.ts b/src/main/importUi.ts
index 02f38ce..e674574 100644
--- a/src/main/importUi.ts
+++ b/src/main/importUi.ts
@@ -2,11 +2,12 @@
 // the result dialog, and opening the server windows a file became. importer.ts does the work.
 import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
 import { basename } from 'node:path'
-import type { ServerConfig } from '../shared/types'
+import type { OpenedProject, ServerConfig } from '../shared/types'
+import { LOCAL_SERVER_DISABLED } from './localServer'
 import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
-import { importSummary, localFirst, migratedFile, targetOf, type ImportOutcome, type MigratedPiece } from './importRules'
+import { importSummary, localFirst, migratedFile, targetOf, type ImportOutcome, type MigratedLeft, type MigratedPiece } from './importRules'
 import { fileKey, readMigrated } from './migrated'
-import { closeFileWindow, openServerTarget, windowHasProject } from './windows'
+import { closeFileWindow, fileIsOpen, openServerTarget, windowHasProject } from './windows'
 import type { WindowBounds } from './windowRules'
 
 export const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]
@@ -94,3 +95,58 @@ export async function importFromMenu(): Promise<void> {
   await showImportResult(parent, [report])
   await openPieces(closed.bounds ? null : emptyWindow(parent), report.pieces, closed.bounds)
 }
+
+/** How a .trekproj opened as a file window: the sender takes it (its IPC reply carries it), or a window opens. */
+export type LegacyOpen = (sender: WebContents | null, filePath: string) => Promise<OpenedProject | null>
+
+async function offerRetry(parent: BrowserWindow | null, filePath: string, left: readonly MigratedLeft[]): Promise<void> {
+  const response = await box(parent, {
+    type: 'question',
+    message: `Part of “${basename(filePath)}” was not imported`,
+    detail: `${left.map((l) => `${l.label}: ${l.reason}`).join('\n')}\n\nImport it now?`,
+    buttons: ['Import', 'Not Now'],
+    defaultId: 0,
+    cancelId: 1
+  })
+  if (response !== 0) return
+  const report = await runImport(filePath, parent, { only: left.map((l) => l.target) })
+  await showImportResult(parent, [report])
+  await openPieces(null, report.pieces)
+}
+
+/**
+ * Opening a .trekproj during phase 4d (File → Open Project…, a recent, Finder): the projects it
+ * was imported as open, after offering to retry any part left; a file not imported yet is imported
+ * first. Only when no part of it could be imported is a file window offered (the fallback until 4e).
+ * A file already open in a file window is focused there. Without the Local server
+ * (TREK_NO_LOCAL_SERVER, which the legacy smokes set) a .trekproj opens as a file window, as before.
+ * Null whenever the sender has nothing to load: a server window it took hears `window:showServer`.
+ */
+export async function openTrekproj(sender: WebContents | null, filePath: string, legacy: LegacyOpen): Promise<OpenedProject | null> {
+  if (LOCAL_SERVER_DISABLED || fileIsOpen(filePath)) return legacy(sender, filePath)
+  const parent = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
+  const before = migratedFile(await readMigrated(), fileKey(filePath))
+  if (before) {
+    await openPieces(sender, before.pieces)
+    if (before.left.length > 0) await offerRetry(parent, filePath, before.left)
+    return null
+  }
+  const report = await runImport(filePath, parent)
+  if (report.pieces.length === 0) {
+    const response = await showImportResult(parent, [report], { buttons: ['Open as File Window', 'Cancel'], cancelId: 1 })
+    return response === 0 ? legacy(sender, filePath) : null
+  }
+  await showImportResult(parent, [report])
+  await openPieces(sender, report.pieces)
+  return null
+}
+
+/** A .trekproj macOS asked the app to open (Finder, the Dock): into the focused window if it is empty. */
+export async function openFromOs(filePath: string, legacy: LegacyOpen): Promise<void> {
+  try {
+    // A file window can only be handed over in an IPC reply, so the fallback always gets a window of its own.
+    await openTrekproj(emptyWindow(BrowserWindow.getFocusedWindow()), filePath, (_sender, path) => legacy(null, path))
+  } catch (err) {
+    await box(null, { type: 'error', message: `Could not open “${basename(filePath)}”`, detail: errorText(err), buttons: ['OK'] })
+  }
+}
```

- [ ] **Step 2: `project:open` and `project:openPath` go through it; `openLegacy` is the fallback**

`PROJECT_FILTERS` moves to `importUi.ts` (File → Import uses it too). `openForSender` is unchanged.

```diff
diff --git a/src/main/project.ts b/src/main/project.ts
index 5aff51d..8a4a70e 100644
--- a/src/main/project.ts
+++ b/src/main/project.ts
@@ -10,6 +10,7 @@ import type { RawProjectFile } from '../shared/migration'
 import { addRecent, getRecents, removeRecent } from './recents'
 import { parseRecentRef } from './recentsRules'
 import { decideOpen } from './windowRules'
+import { openTrekproj, PROJECT_FILTERS } from './importUi'
 import {
   claimProject,
   createWindow,
@@ -22,7 +23,6 @@ import {
 
 const execFileAsync = promisify(execFile)
 
-const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]
 
 /** Null when the project ended up in another window: the sender has nothing to load. */
 async function openForSender(sender: WebContents, filePath: string): Promise<OpenedProject | null> {
@@ -43,6 +43,22 @@ async function openForSender(sender: WebContents, filePath: string): Promise<Ope
   }
 }
 
+/**
+ * A .trekproj as a file window (phase 4d: only as the fallback, or without the Local server):
+ * the sender takes it, or (no sender: macOS opened it) a window of its own does.
+ */
+export async function openLegacy(sender: WebContents | null, filePath: string): Promise<OpenedProject | null> {
+  if (sender) return openForSender(sender, filePath)
+  if (fileIsOpen(filePath)) {
+    focusWindowHoldingFile(filePath)
+    return null
+  }
+  const opened = await openProjectFile(filePath)
+  createWindow({ initialTarget: { kind: 'file', path: filePath } })
+  await addRecent(opened.filePath)
+  return null
+}
+
 export function registerProjectHandlers(): void {
   ipcMain.handle('dialog:selectDirectory', async (event, title: string) => {
     const win = BrowserWindow.fromWebContents(event.sender)!
@@ -61,10 +77,10 @@ export function registerProjectHandlers(): void {
       properties: ['openFile']
     })
     if (result.canceled || result.filePaths.length === 0) return null
-    return openForSender(event.sender, result.filePaths[0])
+    return openTrekproj(event.sender, result.filePaths[0], openLegacy)
   })
 
-  ipcMain.handle('project:openPath', (event, filePath: string) => openForSender(event.sender, filePath))
+  ipcMain.handle('project:openPath', (event, filePath: string) => openTrekproj(event.sender, filePath, openLegacy))
 
   ipcMain.handle('recents:get', async (): Promise<RecentEntry[]> => {
     return getRecents()
```

- [ ] **Step 3: Finder's `open-file`**

Registered at the top of `index.ts`, before `ready`; the launch file waits for the restored windows (Decision 6).

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index 5b0915d..62d39d3 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -8,7 +8,7 @@ function setDockIcon(): void {
   if (!icon.isEmpty()) app.dock.setIcon(icon)
 }
 import { registerPtyHandlers, disposeAllPtys } from './pty'
-import { openProjectFile, registerProjectHandlers } from './project'
+import { openLegacy, openProjectFile, registerProjectHandlers } from './project'
 import { registerGithubHandlers } from './github'
 import { registerLinearHandlers } from './linear'
 import { registerSkillHandlers } from './skills'
@@ -33,7 +33,7 @@ import {
 } from './localServer'
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
-import { importFromMenu } from './importUi'
+import { importFromMenu, openFromOs } from './importUi'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
 import { registerVoiceHandlers } from './voice'
@@ -50,6 +50,16 @@ import {
   windowHasProject
 } from './windows'
 
+/** .trekproj files macOS asked to open (Finder, the Dock) before the windows were restored: opened after. */
+const pendingOpens: string[] = []
+let opensReady = false
+// Registered before ready: a file that launches the app arrives before it.
+app.on('open-file', (event, path) => {
+  event.preventDefault()
+  if (opensReady) void openFromOs(path, openLegacy)
+  else pendingOpens.push(path)
+})
+
 function sendToFocused(channel: string): void {
   ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channel)
 }
@@ -189,6 +199,8 @@ app.whenReady().then(async () => {
   // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
   void superviseLocalServer()
   await restoreWindows()
+  opensReady = true
+  for (const path of pendingOpens.splice(0)) await openFromOs(path, openLegacy)
 
   app.on('activate', () => {
     if (BrowserWindow.getAllWindows().length === 0) createWindow()
```

```diff
diff --git a/package.json b/package.json
index 857ef96..a0c3b93 100644
--- a/package.json
+++ b/package.json
@@ -44,6 +44,13 @@
       "out/**",
       "resources/**"
     ],
+    "fileAssociations": [
+      {
+        "ext": "trekproj",
+        "name": "Trek Project",
+        "role": "Editor"
+      }
+    ],
     "asarUnpack": [
       "**/node_modules/node-pty/**"
     ],
```

- [ ] **Step 4: The start screen's recents follow an import**

`openRecent` and Open Project… get `null` back when the file was imported (the window switches by `window:showServer`, or the project opened elsewhere); the list is read again, so the file's entry shows as its server projects.

```diff
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index 82d8499..273ab1d 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -26,6 +26,10 @@ export function StartScreen(): React.JSX.Element {
     window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
   }, [view])
 
+  const refreshRecents = (): void => {
+    window.api.getRecentProjects().then(setRecents).catch(() => undefined)
+  }
+
   const removeRecent = async (entry: RecentEntry): Promise<void> => {
     setError(null)
     try {
@@ -69,7 +73,8 @@ export function StartScreen(): React.JSX.Element {
     setError(null)
     try {
       const opened = await window.api.openProject()
-      if (!opened) return
+      // A .trekproj is imported now: its server project opened (here, or in a window of its own).
+      if (!opened) return refreshRecents()
       loadOpened(opened)
     } catch (err) {
       syncWindowProject() // main claimed the file for a project that didn't load
@@ -85,6 +90,8 @@ export function StartScreen(): React.JSX.Element {
     try {
       const opened = await window.api.openProjectPath(filePath)
       if (opened) loadOpened(opened)
+      // Imported: the file's entry became its server projects'.
+      else refreshRecents()
     } catch (err) {
       syncWindowProject() // main claimed the file for a project that didn't load
       setError(`Could not open project: ${String(err)}`)
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: `# tests 1540`, `# pass 1539`, `# fail 0`; the build ends with `out/server: trek-server 0.2.0, build <hash>`.

Then the legacy open path still works without the Local server: `node scripts/windows-smoke.mjs` (it opens and restores `.trekproj` windows with `TREK_NO_LOCAL_SERVER=1` and its own `--user-data-dir`).

Expected: `40/40 checks passed`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat: opening a .trekproj imports it, or opens the projects it became; Finder's open-file; a file window only as the fallback" -m "Co-Authored-By: <model trailer>" -- src/main/importUi.ts src/main/project.ts src/main/index.ts src/renderer/src/components/StartScreen.tsx package.json
```

---

### Task 8: The first-launch prompt

**Files:**
- Modify: `src/main/importUi.ts`, `src/main/index.ts`

- [ ] **Step 1: `offerFirstLaunchImport`**

```diff
diff --git a/src/main/importUi.ts b/src/main/importUi.ts
index e674574..76a4d38 100644
--- a/src/main/importUi.ts
+++ b/src/main/importUi.ts
@@ -1,13 +1,25 @@
 // What the user sees of an import (phase 4d): File → Import .trekproj…, the add-server question,
 // the result dialog, and opening the server windows a file became. importer.ts does the work.
 import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
+import { access } from 'node:fs/promises'
 import { basename } from 'node:path'
 import type { OpenedProject, ServerConfig } from '../shared/types'
 import { LOCAL_SERVER_DISABLED } from './localServer'
 import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
-import { importSummary, localFirst, migratedFile, targetOf, type ImportOutcome, type MigratedLeft, type MigratedPiece } from './importRules'
-import { fileKey, readMigrated } from './migrated'
-import { closeFileWindow, fileIsOpen, openServerTarget, windowHasProject } from './windows'
+import {
+  importSummary,
+  localFirst,
+  markPrompted,
+  migratedFile,
+  promptCandidates,
+  targetOf,
+  type ImportOutcome,
+  type MigratedLeft,
+  type MigratedPiece
+} from './importRules'
+import { fileKey, readMigrated, updateMigrated } from './migrated'
+import { getRecents } from './recents'
+import { closeFileWindow, fileIsOpen, openServerTarget, readRestoreEntries, windowHasProject } from './windows'
 import type { WindowBounds } from './windowRules'
 
 export const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]
@@ -150,3 +162,54 @@ export async function openFromOs(filePath: string, legacy: LegacyOpen): Promise<
     await box(null, { type: 'error', message: `Could not open “${basename(filePath)}”`, detail: errorText(err), buttons: ['OK'] })
   }
 }
+
+/** The prompt lists this many files by name; the rest as a count. */
+const PROMPT_LISTED = 12
+
+/**
+ * Once (migrated.json's `prompted`), before the windows are restored: the .trekproj files of the
+ * windows open at the last quit and of the recents, still on disk and not imported yet, are
+ * imported if the user agrees. restoreWindows then brings those windows back on their projects.
+ * Asked whatever the answer, never again. Without the Local server nothing is asked.
+ */
+export async function offerFirstLaunchImport(): Promise<void> {
+  if (LOCAL_SERVER_DISABLED) return
+  const m = await readMigrated()
+  if (m.prompted) return
+  const candidates: { path: string; key: string }[] = []
+  for (const c of promptCandidates(await getRecents(), await readRestoreEntries(), m, fileKey)) {
+    if (await access(c.path).then(() => true, () => false)) candidates.push(c)
+  }
+  if (candidates.length === 0) {
+    await updateMigrated(markPrompted)
+    return
+  }
+  const listed = candidates.slice(0, PROMPT_LISTED).map((c) => `• ${basename(c.path).replace(/\.trekproj$/, '')} — ${c.path}`)
+  if (candidates.length > PROMPT_LISTED) listed.push(`• and ${candidates.length - PROMPT_LISTED} more`)
+  const response = await box(null, {
+    type: 'question',
+    message: 'Move your projects into Trek?',
+    detail:
+      'Trek now keeps each project on a server: the Local server on this Mac, or one of your servers. ' +
+      `These project files are in your recent projects or were open when Trek last quit:\n\n${listed.join('\n')}\n\n` +
+      'Importing copies each one in; the .trekproj files are not changed. Either way, opening a .trekproj later imports it, and File → Import .trekproj… is always there.',
+    buttons: ['Import', 'Skip'],
+    defaultId: 0,
+    cancelId: 1
+  })
+  // Recorded first: a crash part-way never asks again (opening a file imports it).
+  await updateMigrated(markPrompted)
+  if (response !== 0) return
+  // Asked about, and waited for, once per server across the files.
+  const declined = new Set<string>()
+  const unreachable = new Map<string, string>()
+  const outcomes: ImportOutcome[] = []
+  for (const c of candidates) {
+    try {
+      outcomes.push(await runImport(c.path, null, { declined, unreachable }))
+    } catch (err) {
+      outcomes.push({ path: c.path, error: errorText(err) })
+    }
+  }
+  await showImportResult(null, outcomes)
+}
```

- [ ] **Step 2: Before the windows are restored**

`superviseLocalServer()` has already been started (not awaited), so Local is coming up while the dialog is read; the importer waits for it (up to 60 s, once per run: `unreachable`).

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index 62d39d3..ae6ebbf 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -33,7 +33,7 @@ import {
 } from './localServer'
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
-import { importFromMenu, openFromOs } from './importUi'
+import { importFromMenu, offerFirstLaunchImport, openFromOs } from './importUi'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
 import { registerVoiceHandlers } from './voice'
@@ -198,6 +198,8 @@ app.whenReady().then(async () => {
   setDockIcon()
   // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
   void superviseLocalServer()
+  // Once, before the windows come back: those on .trekproj files then come back on their projects.
+  await offerFirstLaunchImport().catch((err) => console.error('[import] the first-launch prompt failed', err))
   await restoreWindows()
   opensReady = true
   for (const path of pendingOpens.splice(0)) await openFromOs(path, openLegacy)
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`

Expected: `# tests 1540`, `# pass 1539`, `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): a one-time first-launch prompt imports the .trekproj files of the recents and the restored windows" -m "Co-Authored-By: <model trailer>" -- src/main/importUi.ts src/main/index.ts
```

---

### Review fixes (Tasks 1–3, done)

Applied after the review of Tasks 1–3, in one commit before Task 9. Tests: 1540 → 1559 (1558 pass, 1 skipped; +19).

1. **`routePiece` matches Save's identity, origin and path** (`serverKey`, now exported from `appServersRules.ts`). An entry with the very URL still wins among those with the same key. An entry on the same origin under another path is another server, so the file's is offered (`add`). Both bare (or `/`) is the same key, so the origin-only case needs no fallback of its own. Of two file servers with one id, the first is the one; the splitter's `serverName` now agrees (it was last-wins). A user name or password in the file's URL does not count for matching; with no entry, such a URL is `unknown` (Save refuses it). `declineKey` (origin and path) replaces the origin in `ImportOptions.declined`.
2. **`recordImport` never leaves a target that still has a piece** (an Import Again that failed where an earlier import landed): the failure is only in that run's result dialog. `left` is deduped by target, keeping the first reason.
3. **`adoptAppServerToken` is set-if-absent.** The secret store gains `setIfAbsent`, run as one step of its write chain. The URL check (`mayAdoptToken`, pure) and the call are made in the same synchronous step, as Save does, so a token the user set, or another adoption, queued before it is never overwritten, and a Save that re-points the entry, or a remove, queued after it clears it.
4. **`envRepoKey`** takes `profileKey` only when it is a string starting with `/`.
5. **Secrets are looked up as own properties** (`ownSecret`, `src/main/secretsRules.ts`, `Object.hasOwn`), so a legacy server id like `constructor` or `__proto__` finds nothing instead of throwing. Writes use `defineProperty`, so a `__proto__` key is stored as a key.
6. **Global sessions move from the file's first repository's raw path** (`ImportedProject.globalCwd`, Local's piece only), where a file window ran them (`terminals.ts`), not from the Local piece's first repository, which may be another one when Local refused the file's first. The `to` is the stored project's first repository's main worktree, where the server runs them.
7. **`worktreeInError` reads the server's own wording first**: the path after `configured root: ` (`server/src/paths.ts`) or between `worktree path ` and ` is another repository (` (`server/src/projects/model.ts`), matched exactly. The clash's repository path in a BAD_REQUEST is never taken for the worktree. A message in neither wording falls back to the longest path named.
8. **`addAppServer` names the entry with `addedServerName`**: the file's name trimmed and cut to `MAX_NAME`, or the URL's host when that leaves nothing.
9. **A file server with id `local` is its own piece.** The splitter renames it (`local-server`, or `local-server-N` when the file uses that) in `servers`, `serverPaths` and the worktrees' `serverId`, and keeps the worktree order's `local <path>` entries for both. The piece has `legacyServerId: 'local'`, which the importer uses for the v1 token lookup. `ImportResult.servers` is the file's servers as the targets name them; the importer routes with it.
10. **`fileKey` moved to `src/main/fileKey.ts`** (no Electron, tested directly; `migrated.ts` re-exports it). It was already taken before the file is read. A file that is gone (deleted or moved) now keys on `realpath(dirname) + basename`, so `/var` and `/private/var` still map; a folder that is gone too falls back to the resolved path.
11. **Pure decisions**: `mayAdoptToken`, `addedServerName`, `declineKey` and `ownSecret`, each tested.

`smoke:import` gains two checks: a saved entry on the test server's origin under another path (`…/other`) is neither used nor given the token, and nothing of the run is written under the real HOME.

---

### Task 9: `smoke:import` and the README

**Files:**
- Create: `scripts/import-smoke.mjs`
- Modify: `package.json`, `README.md`

What it builds, all under one `mkdtemp` directory (`<work>`, `/var/folders/…`):
- **Here:** `real/app` with a `feature-x` worktree, reached by the file as `<work>/link/app` (a symlink, and `/var` rather than `/private/var`). The file's sessions' Claude histories are filed under those symlinked paths in the temp HOME.
- **A test trek-server** (`server/dist/trek-server.cjs start --config … --port … --data-dir …`, its own HOME) with `beta` registered, and a `topic` worktree the file names under `/var`.
- **The file:** two repositories (`app` here; `beta` on the server, its local clone gone), branch data of every kind, linked dirs, environments, a queue, the Global panel, settings and a worktree order.
- **userData as an older Trek left it:** recents naming the file (by its `/var` spelling), `open-windows.json` with the file and bounds, and `server-tokens.json` holding the server's v1 token bound to its origin (`plain:`, the secret store's unencrypted form, so no keychain is read).
- **A decoy entry** in `app-servers.json` on the test server's origin under another path (`…/other`): another server, so the file's is still offered and added, and the decoy gets no token.
- **The real HOME is only read**: at the end, no Claude history folder for the run's paths exists there, and no Trek or trek-server file there names the run's temp dir.
- **Stubs:** main's message boxes are recorded and answered with their first button; the open dialog returns `globalThis.__openPath`. The fake agent records its physical cwd, the id after `--resume`, and whether Claude's history for it is in that cwd's project folder.

- [ ] **Step 1: The smoke**

The committed `scripts/import-smoke.mjs` is the script below plus the review fixes' additions: the decoy entry seeded in `app-servers.json` (its check folded into "the server was added…", and "that entry got no token"), and the real-HOME check (`realHomeLeaks`) at the end of launch 2.

`scripts/import-smoke.mjs`:

```js
// scripts/import-smoke.mjs — importing a .trekproj onto the Local server and a remote one (4d).
//
// Run: npm run smoke:import   (builds the app with out/server and server/dist, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own `local-dev` server) and a
// temp --user-data-dir, seeded as an older Trek left it: recents and open-windows.json naming a
// .trekproj, and that file's server token in server-tokens.json. A test trek-server stands in for
// the file's remote server. The file has two repositories, one here (through a symlink, under /var)
// and one on the server, with branch data, saved sessions (their Claude histories filed under the
// symlinked paths), the Global panel, settings, worktree order and an environments setting.
//   Launch 1: the first-launch prompt lists the file and imports it; the server is offered and added
//     with its token; the result dialog lists both parts and the warnings; the window restored last
//     time comes back on the Local project, with its bounds; the data is on the right servers;
//     loading a worktree resumes its session with `--resume <id>` in the realpath, where its history
//     was copied; recents and migrated.json are rewritten; the .trekproj is byte-identical.
//   Launch 2: no prompt; open-windows.json brings the Local window back; opening the file again
//     imports nothing and opens the projects; File → Import .trekproj… imports a second file.
// Main's dialogs are stubbed through -r and answered with their first button.
//
// Prints IMPORT SMOKE PASS (n checks) or IMPORT SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { deriveProfileName, envRepoKey } from '../src/shared/environments.ts'
import { encodeTokenRecord } from '../src/main/serverTokenRules.ts'

const WATCHDOG_MS = 300_000
const DAEMON_READY_MS = 15_000

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, expected, ms = 20_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}
/** fn's first truthy value, or its last one after `ms` */
const first = async (fn, ms = 20_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const claudeDir = (cwd) => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
// Not realpath'd: under /var/folders, whose realpath is /private/var/folders.
const work = mkdtempSync(join(tmpdir(), 'trek-import-smoke-'))
const real = realpathSync(work)
const home = join(real, 'home')
const remoteHome = join(real, 'remote-home')
const userData = join(real, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
for (const dir of [profile, remoteHome, userData, join(real, 'files'), join(real, 'real'), join(real, 'remote')]) mkdirSync(dir, { recursive: true })

const gitRepo = (path) => {
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  execFileSync('git', ['-C', path, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
}
// Here: the repository and its feature-x worktree, reached by the file through a symlink (and /var).
const realRepo = join(real, 'real', 'app')
const realFeature = `${realRepo}-feature-x`
gitRepo(realRepo)
execFileSync('git', ['-C', realRepo, 'worktree', 'add', '-q', '-b', 'feature-x', realFeature])
symlinkSync(join(real, 'real'), join(real, 'link'))
const fileRepo = join(work, 'link', 'app')
const fileFeature = `${fileRepo}-feature-x`
// On the server: beta, registered there, and its topic worktree, which the file names under /var.
const remoteRepo = join(real, 'remote', 'beta')
const remoteTopic = `${remoteRepo}-topic`
gitRepo(remoteRepo)
execFileSync('git', ['-C', remoteRepo, 'worktree', 'add', '-q', '-b', 'topic', remoteTopic])
const fileTopic = join(work, 'remote', 'beta-topic')
// A second file, for File → Import .trekproj…
const otherRepo = join(real, 'real', 'other')
gitRepo(otherRepo)

const S_MAIN = '11111111-1111-4111-8111-111111111111'
const S_X = '22222222-2222-4222-8222-222222222222'
const S_GLOBAL = '33333333-3333-4333-8333-333333333333'
const S_TOPIC = '44444444-4444-4444-8444-444444444444'
// The Claude histories the file window's sessions left, filed under the paths it ran them in.
for (const [cwd, id] of [[fileRepo, S_MAIN], [fileFeature, S_X], [fileRepo, S_GLOBAL]]) {
  mkdirSync(claudeDir(cwd), { recursive: true })
  writeFileSync(join(claudeDir(cwd), `${id}.jsonl`), `{"session":"${id}"}\n`)
}

const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const port = await freePort()
const remoteUrl = `ws://127.0.0.1:${port}`

const fileA = join(real, 'files', 'Imported.trekproj')
writeFileSync(
  fileA,
  JSON.stringify(
    {
      version: 3,
      name: 'Imported',
      servers: [{ id: 'srv', name: 'build-box', url: remoteUrl }],
      sessionSystemPrompt: 'Be brief.',
      audioAlerts: true,
      worktreeOrder: [`local ${fileFeature}`, `srv ${fileTopic}`, `local ${fileRepo}`],
      globalSessions: [{ sessionId: S_GLOBAL, title: 'Global one' }],
      repositories: [
        {
          id: 'app',
          name: 'app',
          path: fileRepo,
          primaryTerminals: [{ sessionId: S_MAIN, title: 'Main session' }],
          branchTags: { 'feature-x': 'In Review' },
          branchCustomTags: { 'feature-x': ['hot'] },
          branchNotes: { 'feature-x': 'note x' },
          branchTickets: { 'feature-x': 'TOW-7' },
          branchPullRequests: { 'feature-x': 'https://example.invalid/pr/7' },
          branchEnvVars: { 'feature-x': 'FOO=1' },
          linkedDirs: ['.trek'],
          environments: { enabled: true, cpu: 3 },
          worktrees: [{ id: 'wx', name: 'feature-x', path: fileFeature, branch: 'feature-x', terminals: [{ sessionId: S_X, title: 'X session', queue: ['queued prompt'] }] }]
        },
        {
          id: 'beta',
          name: 'beta',
          // This machine's clone is gone: Local refuses it (NOT_A_REPO), the server has it.
          path: join(real, 'missing-beta'),
          serverPaths: { srv: remoteRepo },
          branchNotes: { topic: 'remote note' },
          worktrees: [{ id: 'wt', name: 'topic', path: fileTopic, branch: 'topic', serverId: 'srv', terminals: [{ sessionId: S_TOPIC, title: 'Topic session' }] }]
        }
      ]
    },
    null,
    2
  )
)
const fileB = join(real, 'files', 'Other.trekproj')
writeFileSync(fileB, JSON.stringify({ version: 3, name: 'Other', repositories: [{ id: 'o', name: 'other', path: otherRepo, worktrees: [] }] }, null, 2))
const shaA = sha(fileA)
const shaB = sha(fileB)

// userData as an older Trek left it: the file in recents (by its /var spelling) and open at quit,
// and the server's v1 token, bound to its origin ("plain:" is the secret store's unencrypted form).
const bounds = { x: 120, y: 90, width: 1111, height: 777 }
writeFileSync(join(userData, 'recent-projects.json'), JSON.stringify([join(work, 'files', 'Imported.trekproj')]))
writeFileSync(join(userData, 'open-windows.json'), JSON.stringify([{ filePath: fileA, bounds }]))
writeFileSync(join(userData, 'server-tokens.json'), JSON.stringify({ srv: `plain:${Buffer.from(encodeTokenRecord(token, remoteUrl)).toString('base64')}` }))

// The agents: each records its cwd (physical), the id it resumes, and whether Claude's history for
// that id is where Claude would look (the cwd's project folder), then lingers.
const agentLog = join(real, 'agent-log')
const agentPids = join(real, 'agent-pids')
const fakeAgent = join(real, 'fake-agent.sh')
writeFileSync(
  fakeAgent,
  `#!/bin/sh
echo $$ >> '${agentPids}'
id=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && id="$a"; prev="$a"; done
dir="$HOME/.claude/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"
found=no; [ -n "$id" ] && [ -f "$dir/$id.jsonl" ] && found=yes
echo "$(pwd -P)|$id|$found" >> '${agentLog}'
exec sleep 300
`,
  { mode: 0o755 }
)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
const remoteConfig = join(real, 'remote-config.json')
writeFileSync(remoteConfig, JSON.stringify({ tokenHash, repos: [{ id: 'beta', name: 'beta', path: remoteRepo }], llm: { providers: { claude: { command: fakeAgent } } } }))

// Main's dialogs, stubbed before its script runs: each message box is recorded and answered with its
// first button (Import, Add Server, OK, Open); the open dialog returns globalThis.__openPath.
const mainStub = join(real, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
dialog.showMessageBox = async (...args) => {
  const o = opts(args)
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null, buttons: o.buttons ?? [] })
  return { response: 0, checkboxChecked: false }
}
dialog.showOpenDialog = async () => ({ canceled: !globalThis.__openPath, filePaths: globalThis.__openPath ? [globalThis.__openPath] : [] })
`
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- The remote server -----------------------------------------------------

let daemon = null
const startDaemon = () =>
  new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', remoteConfig, '--port', String(port), '--data-dir', join(real, 'remote-data')], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: remoteHome, SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    const timer = setTimeout(() => reject(new Error(`the test trek-server did not start:\n${output}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      output += b
      if (/listening on ws:\/\//.test(output) && output.includes(`:${port}`)) {
        clearTimeout(timer)
        resolve()
      }
    })
    d.stderr.on('data', (b) => (output += b))
    d.once('exit', (code) => reject(new Error(`the test trek-server exited (${code}):\n${output}`)))
  })

// ---- The app ---------------------------------------------------------------

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  SHELL: '/bin/zsh'
}
// Windows are restored: this run's userData is its own.
delete env.TREK_NO_WINDOW_RESTORE
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE

let app = null
const sdks = []
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
}
const dialogs = () => app.evaluate(() => globalThis.__dialogs)
/** Each window's target, as its store has it */
const windowTargets = async () =>
  (await Promise.all(app.windows().map((w) => w.evaluate(() => window.__store?.getState().serverWindow ?? null).catch(() => null)))).filter(Boolean)
const connect = async (url, tok) => {
  const sdk = new ServerConnection({ url, token: tok, createSocket: globalSocketFactory, client: 'import-smoke' })
  sdks.push(sdk)
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  return sdk
}
const snapshot = async (sdk, projectId) => {
  const topic = `project:${projectId}`
  const { snapshot } = await sdk.request('sub.subscribe', { topic })
  await sdk.request('sub.unsubscribe', { topic })
  return snapshot
}
const agentLines = () => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('\n').filter(Boolean) : [])

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  for (const sdk of sdks) sdk.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(real, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `IMPORT SMOKE PASS (${checks.length} checks)` : `IMPORT SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  await startDaemon()

  // ---- Launch 1: the first-launch prompt imports the file ---------------------------------------

  await launch()
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForLoadState('domcontentloaded')
  const migrated = readJson(join(userData, 'migrated.json'))
  const pieces = migrated?.files?.[fileA]?.pieces ?? []
  check('migrated.json: the file, by its realpath, in two pieces, Local first; the prompt ran', [migrated?.prompted, pieces.map((p) => [p.target, p.serverName])], [true, [['local', 'Local'], ['srv', 'build-box']]])
  const localId = pieces[0]?.projectId
  const remotePiece = pieces[1]
  const asked = await dialogs()
  const prompt = asked.find((d) => d.message === 'Move your projects into Trek?')
  check('the prompt lists the file once, and offers Import or Skip', [prompt?.detail?.split(fileA).length - 1, prompt?.buttons], [1, ['Import', 'Skip']])
  const addServer = asked.find((d) => d.message === 'Add the server “build-box”?')
  check('the file’s server is offered, with its saved token', [!!addServer, addServer?.detail?.includes('The access token saved in Trek for that address comes with it.')], [true, true])
  const result = asked.find((d) => d.message === 'Imported “Imported”')
  check('the result names both parts', result?.detail?.split('\n')[0], '“Imported” is now 2 projects: on Local and on build-box.')
  check('and warns about the clone this machine no longer has', /Repository "beta" \(.*missing-beta\) was not added on Local \(NOT_A_REPO/.test(result?.detail ?? ''), true)
  check('and about the server session whose path the server moved', (result?.detail ?? '').includes(`1 session(s) in topic were saved under ${fileTopic}, but build-box runs them in ${remoteTopic}`), true)
  check('three Claude histories were copied to the realpaths', (result?.detail ?? '').includes("3 sessions' history was copied"), true)
  check('no error dialogs', asked.filter((d) => d.type === 'error').map((d) => d.message), [])

  check('the window restored last time comes back on the Local project', await until(windowTargets, [{ serverEntryId: 'local', projectId: localId }]), [{ serverEntryId: 'local', projectId: localId }])
  check('with its bounds', await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0].getNormalBounds(); return [b.width, b.height] }), [bounds.width, bounds.height])
  await win.locator('.server-window .wt-row').first().waitFor({ timeout: 20_000 })
  check('recents: the two projects where the file was', readJson(join(userData, 'recent-projects.json'))?.map((e) => [e.serverEntryId, e.projectId]), [['local', localId], [remotePiece?.serverEntryId, remotePiece?.projectId]])
  const appServers = readJson(join(userData, 'app-servers.json'))
  check('the server was added under its name and URL', appServers?.map((s) => [s.name, s.url]), [['build-box', remoteUrl]])
  check("main's connection to it is up with the carried token", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.name === 'build-box')?.status ?? null, 'connected'), 'connected')

  // The data, on each server.
  const local = info()
  const localSdk = await connect(`ws://127.0.0.1:${local.port}`, local.token)
  const lp = await snapshot(localSdk, localId)
  const app0 = lp.repositories[0]
  check('Local: one repository, at its realpath', lp.repositories.map((r) => [r.name, r.path]), [['app', realRepo]])
  check('Local: worktrees at their realpaths', app0.worktrees.map((w) => [w.name, w.path, w.isMain]), [['app', realRepo, true], ['feature-x', realFeature, false]])
  check('Local: the branch data', app0.branchData['feature-x'], { tag: 'In Review', customTags: ['hot'], note: 'note x', ticket: 'TOW-7', pr: 'https://example.invalid/pr/7', env: 'FOO=1' })
  check('Local: linked dirs and the environments, with the profile key', [app0.linkedDirs, app0.environments], [['.trek'], { enabled: true, cpu: 3, profileKey: fileRepo }])
  check('Local: the VM names its file window made', deriveProfileName(envRepoKey(app0), 'feature-x'), deriveProfileName(fileRepo, 'feature-x'))
  check('Local: settings and the worktree order, re-keyed', [lp.settings.sessionSystemPrompt, lp.settings.audioAlerts, lp.settings.worktreeOrder?.length], ['Be brief.', true, 2])
  const xSession = app0.worktrees[1].sessions[0]
  check('Local: the sessions keep their agent ids and queue; the Global one too', [app0.worktrees[0].sessions.map((s) => s.agentSessionId), xSession?.agentSessionId, xSession?.queue, lp.globalSessions.map((s) => s.agentSessionId)], [[S_MAIN], S_X, ['queued prompt'], [S_GLOBAL]])
  const remoteSdk = await connect(remoteUrl, token)
  const rp = await snapshot(remoteSdk, remotePiece?.projectId)
  check('build-box: beta with its worktree and session, no Global sessions', [rp.repositories.map((r) => [r.name, r.path]), rp.repositories[0].worktrees.map((w) => [w.name, w.path]), rp.repositories[0].worktrees[1].sessions[0].agentSessionId, rp.globalSessions], [[['beta', remoteRepo]], [['beta', remoteRepo], ['topic', remoteTopic]], S_TOPIC, []])
  check('build-box: its branch note', rp.repositories[0].branchData.topic, { note: 'remote note' })

  // The histories: copied to the realpaths, the originals kept; a load resumes in the realpath.
  check('the histories are under the realpaths now, and still under the old ones', [S_MAIN, S_X, S_GLOBAL].map((id) => [existsSync(join(claudeDir(id === S_X ? realFeature : realRepo), `${id}.jsonl`)), existsSync(join(claudeDir(id === S_X ? fileFeature : fileRepo), `${id}.jsonl`))]), [[true, true], [true, true], [true, true]])
  await localSdk.request('worktree.load', { projectId: localId, worktreeId: app0.worktrees[1].id })
  check('loading feature-x resumes its session with --resume <id> in the realpath, finding its history', await until(() => agentLines().find((l) => l.includes(S_X)) ?? null, `${realFeature}|${S_X}|yes`, 20_000), `${realFeature}|${S_X}|yes`)
  check('the .trekproj is byte-identical', sha(fileA), shaA)
  check('no console or page errors', pageErrors, [])

  await app.close()
  app = null

  // ---- Launch 2: no prompt; opening the file again opens it; File → Import -----------------------

  check('open-windows.json was written with the Local project and its bounds', readJson(join(userData, 'open-windows.json'))?.map((e) => [e.kind, e.serverEntryId, e.projectId, e.bounds?.width]), [['server', 'local', localId, bounds.width]])
  await launch()
  const win2 = await app.firstWindow({ timeout: 60_000 })
  await win2.waitForLoadState('domcontentloaded')
  check('launch 2 restores the Local project', await until(windowTargets, [{ serverEntryId: 'local', projectId: localId }]), [{ serverEntryId: 'local', projectId: localId }])
  check('and asks nothing', await dialogs(), [])
  const projectsBefore = (await localSdk.request('project.list', {})).length
  await win2.evaluate((f) => window.api.openProjectPath(f), join(work, 'files', 'Imported.trekproj'))
  const opened = [{ serverEntryId: 'local', projectId: localId }, { serverEntryId: remotePiece?.serverEntryId, projectId: remotePiece?.projectId }]
  check('opening the file again opens its projects (the remote one in a window of its own)', await until(async () => (await windowTargets()).sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId)), [...opened].sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId))), [...opened].sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId)))
  await win2.evaluate((f) => window.api.openProjectPath(f), fileA)
  check('a second open imports nothing and opens no more windows', [(await localSdk.request('project.list', {})).length, app.windows().length, (await dialogs()).length], [projectsBefore, 2, 0])
  check('migrated.json is unchanged', readJson(join(userData, 'migrated.json'))?.files?.[fileA]?.pieces?.map((p) => p.projectId), pieces.map((p) => p.projectId))

  await app.evaluate(({ Menu }, path) => {
    globalThis.__openPath = path
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'Import .trekproj…').click()
  }, fileB)
  const otherId = await first(() => readJson(join(userData, 'migrated.json'))?.files?.[fileB]?.pieces?.[0]?.projectId)
  check('File → Import .trekproj… imports the second file onto Local', (await localSdk.request('project.list', {})).some((p) => p.id === otherId && p.name === 'Other'), true)
  check('its result says so', (await until(async () => (await dialogs()).map((d) => d.message), ['Imported “Other”'])), ['Imported “Other”'])
  check('and its project opens in a window', await until(async () => (await windowTargets()).some((t) => t.projectId === otherId), true), true)
  check('both files are byte-identical', [sha(fileA), sha(fileB)], [shaA, shaB])
  check('no console or page errors (launch 2)', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
```

- [ ] **Step 2: The script and the README**

```diff
diff --git a/package.json b/package.json
index a0c3b93..d7ecf36 100644
--- a/package.json
+++ b/package.json
@@ -28,6 +28,7 @@
     "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
     "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
     "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
+    "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
     "rebuild": "electron-rebuild -f -w node-pty",
     "dist": "npm run build && electron-builder --mac --arm64",
```

```diff
diff --git a/README.md b/README.md
index 7fefbe7..fbbaafe 100644
--- a/README.md
+++ b/README.md
@@ -217,9 +217,29 @@ other window on that project sees them live.
   after a fresh check for uncommitted changes. A window on a remote server shows
   none of these.
 - **Not yet in server windows**: promote to primary, moving worktrees, voice and
-  the bot (phase 5), and importing a `.trekproj` (phase 4d). Until then, the
-  per-project servers under ⚙ Settings → Servers remain the way to run remote
-  sessions from a project file.
+  the bot (phase 5).
+
+## Importing a .trekproj
+
+Opening a `.trekproj` (File → Open Project…, a recent project, or the file from
+Finder) imports it: the part on this machine becomes a project on the Local
+server, and each part on a remote server becomes a project there, and their
+windows open. **File → Import .trekproj…** does the same, and can import a file
+again. On the first launch with Local, Trek offers once to import the files in
+your recent projects and the windows open at the last quit.
+
+- The `.trekproj` file is never changed. `migrated.json` in Trek's app data
+  remembers what each file became, so opening it again opens those projects.
+- A remote part goes to the server in your list at the same address; if none is,
+  Trek offers to add it, with the token saved for that address, if any.
+- Settings, tags, notes, tickets, pull requests, environment variables, linked
+  folders, environments, queues, session types, saved sessions and the worktree
+  order come along. Open tabs, drafts, running terminals (sessions come back idle
+  and resume when loaded) and the project bot's folder do not.
+- Paths become their realpaths on the server. Claude's saved histories are copied
+  to them on Local, and a repository's VMs keep their names.
+- A file opens as a project file window only if none of it could be imported, or
+  when the Local server is off (`TREK_NO_LOCAL_SERVER=1`).
 
 ## Local server
 
@@ -309,7 +329,8 @@ older files are upgraded by `src/shared/migration.ts`. `npm test` runs the unit
 `npm run smoke:multi` runs the two-repository end-to-end test, and
 `npm run smoke:providers` starts Codex and Gemini sessions against fake CLIs, and
 `npm run smoke:local-features` drives a Local server window's Docker, environments,
-stacks, skills, VS Code and Reveal against stub `colima`, `docker` and `code`. Terminal
+stacks, skills, VS Code and Reveal against stub `colima`, `docker` and `code`, and
+`npm run smoke:import` imports a `.trekproj` onto Local and a test server. Terminal
 PTYs are managed in the main process (`src/main/pty.ts`); xterm.js instances,
 the attention heuristics and worktree load/unload live in the renderer
 (`src/renderer/src/terminals.ts`). Which worktrees are loaded is runtime-only
```

- [ ] **Step 3: Run it (alone)**

Run: `npm run smoke:import`

Expected (temp paths shortened):

```
ok   migrated.json: the file, by its realpath, in two pieces, Local first; the prompt ran: [true,[["local","Local"],["srv","build-box"]]]
ok   the prompt lists the file once, and offers Import or Skip: [1,["Import","Skip"]]
ok   the file’s server is offered, with its saved token: [true,true]
ok   the result names both parts: "“Imported” is now 2 projects: on Local and on build-box."
ok   and warns about the clone this machine no longer has: true
ok   and about the server session whose path the server moved: true
ok   three Claude histories were copied to the realpaths: true
ok   no error dialogs: []
ok   the window restored last time comes back on the Local project: [{"serverEntryId":"local","projectId":"<id>"}]
ok   with its bounds: [1111,777]
ok   recents: the two projects where the file was: [["local","<id>"],["<entry>","<id>"]]
ok   the server was added under its name and URL, beside the entry on its origin under another path: [["decoy","ws://127.0.0.1:<port>/other"],["build-box","ws://127.0.0.1:<port>"]]
ok   that entry got no token: false
ok   main's connection to it is up with the carried token: "connected"
ok   Local: one repository, at its realpath: [["app","/private<work>/real/app"]]
ok   Local: worktrees at their realpaths: [["app","/private<work>/real/app",true],["feature-x","/private<work>/real/app-feature-x",false]]
ok   Local: the branch data: {"tag":"In Review","customTags":["hot"],"note":"note x","ticket":"TOW-7","pr":"https://example.invalid/pr/7","env":"FOO=1"}
ok   Local: linked dirs and the environments, with the profile key: [[".trek"],{"enabled":true,"cpu":3,"profileKey":"<work>/link/app"}]
ok   Local: the VM names its file window made: "twb-feature-x-<hash>"
ok   Local: settings and the worktree order, re-keyed: ["Be brief.",true,2]
ok   Local: the sessions keep their agent ids and queue; the Global one too: [["11111111-…"],"22222222-…",["queued prompt"],["33333333-…"]]
ok   build-box: beta with its worktree and session, no Global sessions: [[["beta","/private<work>/remote/beta"]],[["beta","/private<work>/remote/beta"],["topic","/private<work>/remote/beta-topic"]],"44444444-…",[]]
ok   build-box: its branch note: {"note":"remote note"}
ok   the histories are under the realpaths now, and still under the old ones: [[true,true],[true,true],[true,true]]
ok   loading feature-x resumes its session with --resume <id> in the realpath, finding its history: "/private<work>/real/app-feature-x|22222222-…|yes"
ok   the .trekproj is byte-identical: "<sha256>"
ok   no console or page errors: []
ok   open-windows.json was written with the Local project and its bounds: [["server","local","<id>",1111]]
ok   launch 2 restores the Local project: [{"serverEntryId":"local","projectId":"<id>"}]
ok   and asks nothing: []
ok   opening the file again opens its projects (the remote one in a window of its own): [{…"<entry>"…},{"serverEntryId":"local",…}]
ok   a second open imports nothing and opens no more windows: [1,2,0]
ok   migrated.json is unchanged: ["<id>","<id>"]
ok   File → Import .trekproj… imports the second file onto Local: true
ok   its result says so: ["Imported “Other”"]
ok   and its project opens in a window: true
ok   both files are byte-identical: ["<sha256>","<sha256>"]
ok   no console or page errors (launch 2): []
ok   nothing of this run was written under the real HOME: []
IMPORT SMOKE PASS (39 checks)
```

Then: `ps aux | grep -E "trek-import-smoke|fake-agent" | grep -v grep` prints nothing (the run stops `--local`, kills its test server and agents, and removes `<work>`).

- [ ] **Step 4: Commit**

```bash
git add scripts/import-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:import, a .trekproj onto Local and a test server; README: importing a .trekproj" -m "Co-Authored-By: <model trailer>" -- scripts/import-smoke.mjs package.json README.md
```

---

### Task 10: Final verification

- [ ] **Step 1: The checks**

Run: `npm run typecheck && npm test && npm run build`

Expected: `# tests 1559`, `# pass 1558`, `# fail 0` (1511 + 29 in Tasks 1–8, + 19 from the review fixes); the build ends with `out/server: trek-server 0.2.0, build <hash>`.

- [ ] **Step 2: The smokes, one at a time**

Before each, check that it launches Electron with its own `--user-data-dir` (Conventions). `windows-smoke` and `v2-smoke` do not set HOME themselves: run them with a temp one (`HOME=$(mktemp -d) node scripts/…`). Run, in order, waiting for each to exit:

| Command | Expected | What it proves for 4d |
|---|---|---|
| `node scripts/import-smoke.mjs` | `IMPORT SMOKE PASS (39 checks)` | the whole import |
| `node scripts/windows-smoke.mjs` | `40/40 checks passed` | file windows open and restore as before without Local (`restoreEntries` with no `migrated.json`) |
| `node scripts/local-app-smoke.mjs` | `LOCAL APP SMOKE PASS (43 checks)` | a Local app with no `.trekproj` history starts as before (the prompt finds nothing to offer) |
| `node scripts/v2-smoke.mjs` | `V2 SMOKE PASS (170 checks)` | `window:openServerProject` through `openServerTarget` |
| `node scripts/local-features-smoke.mjs` | `LOCAL FEATURES SMOKE PASS (34 checks)` | the env call sites through `envRepoKey` (a realpath repository: no `profileKey`) |

- [ ] **Step 3: Nothing left running, nothing of the user's touched**

Run: `ps aux | grep -E "trek-(import|local-features|local-app|v2)-smoke|fake-agent" | grep -v grep`

Expected: no output. A Local server you started yourself with `npm run dev`, or an installed Trek, is yours: leave it running.

- [ ] **Step 4: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for 4e

Found while prototyping this plan.

1. **The fallback goes with file windows.** `openLegacy`, `openForSender`, the `fileIsOpen` branch of `openTrekproj` and "Open as File Window" (Decision 2) are 4d-only. In 4e, a file of which nothing could be imported shows the result dialog with OK only, and `TREK_NO_LOCAL_SERVER` imports the remote parts or says there is nowhere to import to.
2. **The start screen's Import .trekproj… button** can call `importFromMenu` through a new IPC (`project:import`), with the asking window as the parent and as the empty window to use.
3. **`restoreEntries` keeps a file window for an unimported file.** Once file windows are gone, `restoreWindows` should drop such an entry, or hand it to `openTrekproj` after the windows are up.
4. **The legacy smokes open files through `openProjectPath` with `TREK_NO_LOCAL_SERVER=1`** (`windows-smoke`, `bot-smoke`), which is the legacy branch of `openTrekproj`. They are rewritten or retired with file windows.
5. **`profileKey` is data, not a 4d shim.** It stays after 4e; any code that later builds a profile name must use `envRepoKey`.
6. **`server-tokens.json`** is still read by the importer for files imported later. It can go when the import is retired, not with file windows.
7. **The splitter's known gaps remain** (memory: `rekeyOrder` writes raw paths; no dedupe of `agentSessionId` after same-path worktrees are folded into the main one). Neither showed in the smoke; both are small fixes in `importProject.ts` if 4e touches it.
8. **4c Note 4 still stands**: if Local is ever keyed by profile, `routePiece`'s `LOCAL_ENTRY_ID` exclusion and `importer.ts`'s Local checks follow `isLocalEntryId`.

## Risks

1. **The file is never written** (`readFile` only; the smoke checks both files byte for byte). Claude histories are copied with `COPYFILE_EXCL`, never moved or overwritten, so the file window can still resume them.
2. **Duplicates, not loss.** A crash between `project.import` and `recordImport`, or Import Again, leaves an extra project on the server; nothing is deleted. A user who imports, keeps working in the new project, then picks Import Again gets a fresh copy of the file's (older) state beside it.
3. **The import changes the servers' registries.** `server.addRepo` writes the server's config (on a remote server too, under its allowed roots). That is the same call New Project makes, and it is what `project.import` requires.
4. **Unsaved changes in a file window.** File → Import closes the window first and its save prompt runs (Decision 3). Opening the file, or the first-launch prompt, never imports a file a window has open: the former focuses it, the latter runs before any window exists.
5. **A `.trekproj` opened from Finder is imported without a question**, as decided. A crafted file can register any git repository on Local and set project settings such as `claudeCommand`, which runs when a session in it starts. That was already true of opening it in a file window (and then starting a session). It cannot move a token: a v1 token goes only to an entry on its own origin, and a new server is only added on a yes.
6. **The first-launch prompt has no window behind it.** On a first launch, Import may wait up to a minute for Local to come up with only the dialog on screen; the windows appear after.
7. **`smoke:import` stores an app-server token through safeStorage**, as `smoke:v2` does, under the "Trek Dev Safe Storage" keychain item. The legacy token it seeds is `plain:`, so no keychain item is read for it.
8. **The read-back is one snapshot within 10 s.** If it times out, the import still lands, with a warning that sessions whose path changed may start fresh (their histories are not copied).

## Questions for the user

None block this plan.

1. **Ask before importing a file opened from Finder?** Risk 5. A one-line "Import “X.trekproj” into Trek?" would make a double-click on a file from elsewhere a choice. The recorded decision is to import; say if you want the question.
2. **Registering repositories on a remote server** (Decision 16, Risk 3) saves a `trek-server add` for a clone under an allowed root. If you would rather an import never change a remote server's registry, those repositories would be left with a "run `trek-server add`" warning instead.
