# Central Server Phase 5d: Moving Worktrees Between Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worktree on one server can be moved to another server from its window (**Move to another server…**): the branch travels through origin, the uncommitted work as one patch, Claude sessions' histories (up to 64 MiB each, in chunks) are copied so they resume there, the branch data (its Docker `.env` included) comes along, its Docker VM and dev stack are torn down once the target has it, and the source's copy is removed last.

**Architecture:** The servers never talk to each other; the app relays over its two connections (both through main's relay, so no token reaches a window). Nine new methods behind a `move` capability: on the source `move.prepare` (read only: what would move), `move.export` (HEAD, the patch built in a throwaway index, each carried history's size and hash, the branch data with tags by name, and a fingerprint), `move.history` (one 4 MiB chunk of a history) and `move.finish` (removes the worktree only if its HEAD and work still match the fingerprint; `verifyOnly` just checks); on the target `move.candidates` (its projects' repositories with the same origin), `move.begin`/`move.upload`/`move.abort` (a staged transfer of the histories, chunks in order) and `move.receive` (fetch, check out, check HEAD, apply, the staged histories checked by size and hash, saved sessions, branch data, or undo all of it). The app's `moveFlow.ts` runs unload → export → push (`worktree.push`) → histories → receive → (verify, teardown) → finish, and `MoveWorktreeModal` picks the server and the place, offers the VM and stack teardown, and shows the steps. The web client never offers it (it has one server).

**Tech Stack:** TypeScript, git (temp `GIT_INDEX_FILE`, `git apply --binary`, `fetch`/`update-ref`), React 19 + zustand (renderer), `node:test`, Playwright's `_electron` with two built `trek-server`s and a bare origin in the smoke.

**Prototype:** every task was built first on `central-server-phase5d-proto` (one commit per task, on master 7b119b3). The diffs below are those commits. An implementer applies each task's diff (the files are new or the hunks apply cleanly to master, after the earlier tasks), then runs the task's checks.

---

## User decisions (2026-11-10)

1. **The target is picked.** The move dialog lists the target server's projects that have a repository with the same origin URL; the user picks one (and the repository if a project has several). With none, it says so and offers nothing.
2. **The commits go through origin**, as the legacy app did: the source pushes the branch, the target fetches it, and the target checks its HEAD is the source's.
3. **A real move.** Once the target's copy is verified, the source's sessions close and the source worktree is removed (force). Any failure before that point rolls the target back and leaves the source as it was.
4. **What comes along:** Claude sessions' history, copied, not moved (as the `.trekproj` import does; others are listed as not carried), and the worktree's note, tags, Linear ticket, PR link and PR watch. **Not carried:** the review draft and queued prompts.

Answered later the same day (the plan's first three Questions):

5. **Long chats are chunked.** Each Claude history goes in its own chunked requests, up to 64 MiB a session (Task 7: the limits, chunks in order, a per-move transfer id, partial uploads removed on failure and rollback, tests, and a smoke check with a history over 16 MiB).
6. **A running environment is handled as Delete does.** The dialog shows a "Tear down its VM and stack" checkbox, on by default; unchecked, the move is refused while they run. The teardown happens only after the target is verified (the point of commitment), never before (Task 8; Decision 26 records the ordering).
7. **The branch's `.env` goes along** with the note, tags, ticket and PR link; a target without the `env` capability lists it as not carried (Task 6).

## Decisions made in the plan (candidates for the user)

8. **Nine methods, one capability.** `move` in the welcome (`STATIC_CAPABILITIES`, so every 5d server has it). Source: `move.prepare`, `move.export`, `move.history`, `move.finish`; target: `move.candidates`, `move.begin`, `move.upload`, `move.abort`, `move.receive`. The push is the existing `worktree.push` `{setUpstream: true}`. Shapes in `src/shared/move.ts`; PROTOCOL.md, "Moving a worktree between servers".
9. **The app relays; Electron only.** `moveFlow.ts` takes two requesters (the window's own `RegisteredServer` and one `connectServerEntry(target)` opened for the dialog and dropped when it closes). The menu item shows only with `features.moveWorktree` (the window's server has `move`) and at least one other app server entry with a token whose last welcome (main's link) did not lack `move` (`moveTargets`). The web client lists only its own server, so it never shows the item. The target's own welcome is checked again when picked (`move` present, not the window's own `serverId`).
10. **The source is unloaded first.** `move.export` refuses a loaded worktree (`IN_USE`); the flow unloads it (the sessions stop, their rows stay) and loads it again on any failure before the target has it.
11. **The patch is built in a throwaway index.** `exportDirtyPatch` copies the worktree's index to a temp file, `git add -A` there, and `git diff --cached --binary HEAD`; the worktree's own index (what is staged) is never touched. The legacy `add -N` + `reset -q` reset a user's staging, so it is replaced. On the target it applies to the work tree only: every change arrives unstaged. Ignored files never travel. At most 8 MiB (`BAD_REQUEST` with how big, and to commit or remove large files).
12. **The fingerprint guards the last step.** `move.export` returns `sha256(head, patch)`; `move.finish` re-exports and removes only on a match, else `CONFLICT` (or `IN_USE` if loaded again). Then the flow removes the target's copy again (`worktree.remove {force: true}`) and loads the source: anything typed on the source while it was copied is never lost. The branch `move.receive` created on the target stays.
13. **`move.receive` is all or nothing.** Each step pushes its undo: the local branch it created (deleted) or fast-forwarded (`update-ref` back), the worktree (`worktree remove --force`), each history file (deleted, or its old content written back). On any failure the undos run in reverse, the repo is re-read, and the error is answered.
14. **The destination is the default path,** `<repo>-<branch>` beside the target's clone (as `worktree.create` does), no picker. A path that exists, or outside the server's allowed folders, makes the place `blocked`.
15. **Conflicts on the target.** The branch checked out in that clone already: `blocked` in `move.candidates`, `CONFLICT` in `move.receive`. Origin's branch not at the source's HEAD (someone pushed meanwhile): `CONFLICT`. A local branch behind HEAD is fast-forwarded; one with commits HEAD lacks is `CONFLICT` ("reconcile them first").
16. **Origins compare by host and path.** `normalizeOrigin`: `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git/` all give `github.com/o/r`; `file://` and plain paths stay paths. A repository without an origin can't move (the dialog says so).
17. **Sessions arrive saved, not running.** Each carried Claude session becomes a new row (a new server id, the same `agentSessionId`, `idle` or `complete`, an empty queue, its session type mapped by name, its system prompt kept) in an unloaded worktree; the user loads it on the target to resume. Its history goes to `~/.claude/projects/<the new path, encoded>/<agentSessionId>.jsonl` (mode 0600) in the target server user's HOME; the source's file stays (copied, not moved).
18. **What is not carried is said twice:** in the dialog before the move (`move.prepare`: other agents' sessions, Claude sessions without a saved conversation, the review comments and the queued prompts, which are lost) and after it (`notCarried` from the source, `dropped` from the target: a tag or session type the target project lacks, a PR watch on a target whose gh is not signed in).
19. **Branch data.** The note, ticket, PR link, Docker `.env` text, workflow tag and custom tags (tags by name, mapped to the target project's ids) are set on top of what the target project already has for that branch. The PR watch: the source's ends in `move.finish` (`prWatch.forget`); the target's is turned on (and polled soon) only if its gh is signed in. The `.env` is left out by the app, and listed as not carried, when the target's welcome lacks `env` (User decision 7; today every server with `move` has `env`).
20. **Limits.** A frame is 16 MiB: the patch (inside `move.export`'s answer) at most 8 MiB. The histories go apart (Decision 24): 4 MiB a chunk, 64 MiB a session (a bigger one is listed as not carried, with its size), 50 sessions, 512 MiB a transfer. Each request may take 5 minutes (a fetch, a big patch).
21. **Cancel until the target starts.** Cancel is checked between unload, export, push and every history chunk (a cancel mid-histories aborts the transfer); once `move.receive` is sent the button is gone. A lost answer to `move.receive` (`NOT_CONNECTED`, `TIMEOUT`) is its own outcome (the app still sends `move.abort`, a no-op if the receive took the transfer): the target may have it, the source is untouched, nothing is finished; retrying gives `CONFLICT` (the path exists), never a second copy.
22. **No trek-dev MCP tool.** A move needs two servers' connections and the app's saved tokens; a session's MCP tools reach only its own server. Agents can still push or commit; moving stays a user action.
23. **The source window.** `move.finish` drops the row (its sessions and review draft with it) and refreshes attention, so the window's tabs and the worktree go as with Delete. The dialog's **Open on <server>** opens the target project's window (`openServerProject`).
24. **The histories travel apart, staged on the target.** `move.export` gives each carried session's `historyBytes` and `historySha256`, not its bytes. The app opens a transfer on the target (`move.begin` `{projectId, repoId}` → a random `transferId`; a 0700 `trek-move-*` temp directory), then for each session, one chunk at a time, reads `move.history` `{…, agentSessionId, offset}` on the source (base64, at most 4 MiB; only an unloaded worktree's carried session) and appends it with `move.upload` `{transferId, agentSessionId, offset, data}` on the target, whose `offset` must be what is staged so far (`CONFLICT` otherwise, so chunks can't arrive out of order or twice). `move.receive` takes the transfer (it must be the same project and repository), checks each staged file's size and sha256 (`BAD_REQUEST`, "did not arrive whole"), copies them to `~/.claude/projects/…` (0600), and discards the transfer whatever happens. Partial uploads go: the app's `move.abort` on any failure or cancel before the receive; a transfer idle 10 minutes is swept by the next `move.begin`/`upload`/`receive`; the server's shutdown clears them; at most 4 at once (`CAPACITY`).
25. **The teardown is the Delete's.** The dialog finds the worktree's VM (the environments poll, as Delete does) and dev stack (`stack.status`: has run, `created`), and shows "Tear down its VM “…” and its dev stack “trek-…” on this server once the worktree is in place there", ticked. Unticked: while either runs (the VM `running`, the stack's containers or its `up`), Move is disabled and the dialog says to stop them or tick it; stopped, the move goes and they stay behind. The teardown is `stack.destroy` then the VM's `env.destroy` (the same calls, the same warnings as Delete); a failure is a note, and the move goes on.
26. **The teardown's place: after the target is verified, before the source's folder goes.** The order is receive → `move.finish {verifyOnly: true}` (the source unchanged and unloaded, nothing removed) → teardown → `move.finish`. Never before the receive: a move that fails or is cancelled destroys nothing. After the verify, so a source that changed while it was copied (the target's copy then goes, Decision 12) keeps its VM and stack. Before the removal, because `stack.sh destroy` runs in the worktree and the containers bind-mount it. If `move.finish` still finds a change after the teardown (the stack wrote an untracked file, say), the target's copy is kept and both are reported ("compare them and delete one"), since the source's machine state is already gone.

## Risks

1. **Histories over 64 MiB are not carried** (listed with their size; they stay on the source and are closed with it). A staged transfer sits in the target's temp directory until the receive, an abort, the 10-minute sweep or shutdown; a server killed mid-move leaves its `trek-move-*` directory to the OS's temp cleanup.
2. **A text file that is not UTF-8** (Latin-1, say) can't travel in a JSON frame: `git diff --binary` base85-encodes only what it sees as binary. `move.export` reads the patch as bytes and refuses one that isn't valid UTF-8 (`BAD_REQUEST`: commit or remove it first) rather than carry changed bytes (Task 5). Carrying the patch base64 would lift this at a third more size; left for later.
3. **`linkedDirs` would collide.** The target links the repository's `linkedDirs` before applying; a linked directory's symlink that is not git-ignored would be in the patch too and `git apply` would fail. `move.export` (and `move.finish`'s fingerprint) leave the repository's `linkedDirs` out with `:(exclude,literal)` pathspecs (Task 5).
4. **The push publishes the branch** and needs the source server user's push rights; a rejected push (protected name, hook, diverged origin) fails the move at the push step with git's message, the source untouched.
5. **Paths inside the history.** A copied Claude history still names the old absolute paths; the resumed agent sees them as earlier context. Same as the `.trekproj` import.
6. **The source's machine state isn't moved.** A VM or dev stack is torn down (Decisions 25–26) or, unticked and stopped, left behind on the source, where it is orphaned (a stack's containers would bind-mount a removed folder; the VM is listed under Orphaned environments). A teardown that fails is only a note, as with Delete. A source changed after its teardown keeps both copies (Decision 26).
7. **Submodules** and their uncommitted work are not carried (the patch has only the superproject's gitlink change).
8. **A crashed app mid-move** (after receive, before finish) leaves both copies; nothing is lost, and the dialog's outcome isn't shown. The source is unloaded at that point.
9. **The target's created branch stays** after a finish `CONFLICT` undoes the target copy; harmless (it is origin's branch), but visible in its branch list.
10. **Staging is lost:** every change arrives unstaged on the target (Decision 11).

## Questions

The user answered the three Questions (User decisions 5–7). None remain.


## File structure

| File | Responsibility |
|---|---|
| `src/shared/move.ts` (new) | The `move.*` shapes, the limits (patch, chunk, per-session, transfer), `normalizeOrigin`/`sameOrigin` |
| `src/shared/protocolV2.ts` | `CAPABILITY.move`; the nine methods' params and results |
| `src/host/gitService.ts` | `exportDirtyPatch` (throwaway index, linkedDirs excluded, UTF-8 checked; replaces the legacy add -N/reset), `originUrl`, `NotUtf8PatchError` |
| `server/src/move/moveHandlers.ts` (new) | The methods: carried sessions, history chunks, branch data by tag name, the fingerprint (`verifyOnly`), `move.receive`'s steps and undo |
| `server/src/move/transfers.ts` (new) | `MoveTransfers`: staged uploads (0700 temp dirs), chunks in order, limits, abort, the idle sweep |
| `server/src/server.ts` | Clears staged transfers at shutdown |
| `server/src/worktreeHandlers.ts` | `checkBranchName` exported |
| `server/src/v2.ts`, `server/src/capabilities.ts` | Registration; `move` in the welcome |
| `src/renderer/src/v2/moveFlow.ts` (new) | The relay: unload → export → push → histories → receive → verify, teardown → finish; outcomes; `moveTargets`, `base64Bytes` |
| `src/renderer/src/components/MoveWorktreeModal.tsx` (new) | Pick server and place, what moves, the teardown checkbox, the steps, Open on <server> |
| `src/renderer/src/components/WorktreeDetail.tsx` | The menu item |
| `src/renderer/src/backend.ts`, `src/renderer/src/v2/backendV2.ts` | `worktrees.moveRef(path)` (the v2 ids) |
| `src/renderer/src/backendFeatures.ts` | `moveWorktree` on, needing `move` |
| `src/renderer/src/styles.css` | The dialog's rows, path, summary and checkbox |
| `scripts/serverMove.test.mjs`, `scripts/moveFlow.test.mjs` (new) | Two servers' handlers over real git, transfers; the flow over fake servers |
| `scripts/server-move-smoke.mjs` (new), `package.json` | `smoke:server-move` (stub docker, colima and stack.sh) |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | Docs |

## Prototype results (on `central-server-phase5d-proto`, head of Task 8, e94ea4a, plus the spec's 66c7cc8)

| Check | Result |
|---|---|
| `npm run typecheck`, server typecheck | clean |
| `npm test` | 1878 pass, 0 fail, 1 skipped (master: 1849; +15 serverMove, +13 moveFlow, +1 backendFeatures) |
| `npm run build` | passes |
| `smoke:server-move` (new) | PASS, 29 checks: a 17 MiB history copied byte for byte in chunks, nothing left staged, the stack torn down on A after B had the worktree, only stub docker and colima |
| `smoke:v2` | PASS, 172 |
| `smoke:local-window` | PASS, 57 |
| server smoke | PASS |
| leftovers | none |


## Task 1: the server's move.* methods

**Prototype commit:** `d45809d` on `central-server-phase5d-proto`.

**Files:**

- Create: `scripts/serverMove.test.mjs`
- Modify: `scripts/serverV2.test.mjs`
- Modify: `server/src/capabilities.ts`
- Create: `server/src/move/moveHandlers.ts`
- Modify: `server/src/v2.ts`
- Modify: `server/src/worktreeHandlers.ts`
- Modify: `src/host/gitService.ts`
- Create: `src/shared/move.ts`
- Modify: `src/shared/protocolV2.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverMove.test.mjs   # 10 pass
node --test scripts/serverV2.test.mjs     # the welcome lists move
cd server && npx tsc --noEmit
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5d): the server's move.* methods behind a move capability: prepare, export and finish on the source, candidates and receive (all or nothing) on the target" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
new file mode 100644
index 0000000..306936a
--- /dev/null
+++ b/scripts/serverMove.test.mjs
@@ -0,0 +1,259 @@
+// scripts/serverMove.test.mjs — move.* (phase 5d): two servers' handlers in one process, against
+// real git in a temp dir, with a bare repository as both clones' origin.
+process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+process.env.GIT_CONFIG_NOSYSTEM = '1'
+
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { execFileSync } from 'node:child_process'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { saveConfig } from '../server/src/config.ts'
+import { ConfigStore } from '../server/src/configStore.ts'
+import { GitPoller } from '../server/src/git/poller.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+import { projectDir } from '../src/host/claudeSessionService.ts'
+import { normalizeOrigin, sameOrigin } from '../src/shared/move.ts'
+
+const gitEnv = {
+  ...process.env,
+  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
+}
+const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
+const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
+const FRESH_ID = '99999999-2222-4333-8444-555555555555'
+
+/** One server's handlers over its own config, projects and poller, with `clone` as its one repo. */
+async function server(t, dir, name, clone, prWatchable = true) {
+  const configPath = join(dir, `${name}.json`)
+  saveConfig(configPath, { serverId: name, name, repos: [{ id: 'r', name: 'app', path: clone }] })
+  const store = new ConfigStore(configPath)
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
+  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: () => {} })
+  t.after(() => { poller.stop(); store.close() })
+  const forgotten = []
+  const polled = []
+  const prWatch = { available: () => prWatchable, pollSoon: (...a) => polled.push(a), forget: (...a) => forgotten.push(a) }
+  const sessions = { blockPath: () => () => {}, refreshAttention: () => {} }
+  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber: { send: () => {} }, projects, poller, sessions, prWatch })
+  const created = await call('project.create', { name: `P-${name}`, repositories: [{ path: clone }] })
+  const projectId = created.result.projectId
+  await poller.refresh(clone)
+  const project = () => projects.require(projectId)
+  const repoId = project().repositories[0].id
+  return { call, projects, poller, projectId, repoId, project, forgotten, polled, clone }
+}
+
+async function setup(t) {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-')))
+  const home = process.env.HOME
+  process.env.HOME = join(dir, 'home')
+  t.after(() => { process.env.HOME = home; rmSync(dir, { recursive: true, force: true }) })
+  const origin = join(dir, 'origin.git')
+  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
+  const a = join(dir, 'a', 'app')
+  const b = join(dir, 'b', 'app')
+  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
+  writeFileSync(join(a, 'README'), 'one\n')
+  git(a, 'add', '.')
+  git(a, 'commit', '-q', '-m', 'init')
+  git(a, 'remote', 'add', 'origin', origin)
+  git(a, 'push', '-q', 'origin', 'main')
+  execFileSync('git', ['clone', '-q', origin, b], { env: gitEnv })
+  const A = await server(t, dir, 'a', a)
+  const B = await server(t, dir, 'b', b)
+  // A worktree on A with a commit, work in progress and two sessions.
+  const made = await A.call('worktree.create', { projectId: A.projectId, repoId: A.repoId, branch: 'feat', createBranch: true })
+  assert.equal(made.ok, true, JSON.stringify(made))
+  const worktreeId = made.result.worktreeId
+  const path = A.project().repositories[0].worktrees.find((w) => w.id === worktreeId).path
+  writeFileSync(join(path, 'feat.txt'), 'committed\n')
+  git(path, 'add', '.')
+  git(path, 'commit', '-q', '-m', 'feat')
+  writeFileSync(join(path, 'README'), 'one\nchanged\n')
+  writeFileSync(join(path, 'staged.txt'), 'staged\n')
+  git(path, 'add', 'staged.txt')
+  writeFileSync(join(path, 'untracked.txt'), 'new\n')
+  mkdirSync(projectDir(path), { recursive: true })
+  writeFileSync(join(projectDir(path), `${CLAUDE_ID}.jsonl`), '{"type":"user"}\n')
+  A.projects.apply(A.projectId, (d) => {
+    const wt = d.repositories[0].worktrees.find((w) => w.id === worktreeId)
+    wt.sessions.push(
+      { id: CLAUDE_ID, agentSessionId: CLAUDE_ID, title: 'Claude 1', llm: { provider: 'claude' }, queue: ['later'], status: 'idle' },
+      { id: FRESH_ID, agentSessionId: FRESH_ID, title: 'Claude 2', llm: { provider: 'claude' }, queue: [], status: 'idle' },
+      { id: 'codex-1', title: 'Codex 1', llm: { provider: 'codex' }, queue: [], status: 'idle' }
+    )
+    d.settings.worktreeTags = [{ id: 'a-review', name: 'Review', color: '#ffffff' }, { id: 'a-only', name: 'Only on A', color: '#ffffff' }]
+    d.repositories[0].branchData.feat = { tag: 'a-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: {} }
+  })
+  B.projects.apply(B.projectId, (d) => {
+    d.settings.worktreeTags = [{ id: 'b-review', name: 'Review', color: '#000000' }]
+  })
+  const ref = { projectId: A.projectId, worktreeId }
+  return { dir, origin, a, b, A, B, worktreeId, path, ref }
+}
+
+/** The whole move, as the app runs it: export, push, receive, finish. */
+async function move(s, { finish = true } = {}) {
+  const exported = await s.A.call('move.export', s.ref)
+  assert.equal(exported.ok, true, JSON.stringify(exported))
+  const pushed = await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
+  assert.equal(pushed.ok, true, JSON.stringify(pushed))
+  const { fingerprint, notCarried, ...rest } = exported.result
+  const received = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: rest.branch, head: rest.head, patch: rest.patch, sessions: rest.sessions, branchData: rest.branchData })
+  if (finish && received.ok) {
+    const done = await s.A.call('move.finish', { ...s.ref, fingerprint })
+    assert.equal(done.ok, true, JSON.stringify(done))
+  }
+  return { exported: exported.result, received, notCarried }
+}
+
+test('normalizeOrigin matches the ssh, https and file forms of one repository', () => {
+  assert.equal(normalizeOrigin('git@github.com:Org/App.git'), 'github.com/Org/App')
+  assert.equal(normalizeOrigin('ssh://git@GitHub.com:22/Org/App'), 'github.com/Org/App')
+  assert.equal(normalizeOrigin('https://github.com/Org/App.git/'), 'github.com/Org/App')
+  assert.equal(normalizeOrigin('/srv/git/app.git'), '/srv/git/app')
+  assert.equal(normalizeOrigin('file:///srv/git/app.git'), '/srv/git/app')
+  assert.equal(normalizeOrigin(''), null)
+  assert.ok(sameOrigin('git@github.com:o/r.git', 'https://github.com/o/r'))
+  assert.ok(!sameOrigin('git@github.com:o/r.git', 'https://github.com/o/other'))
+  assert.ok(!sameOrigin(null, null))
+})
+
+test('move.prepare lists the branch, its origin and which sessions are carried', async (t) => {
+  const s = await setup(t)
+  const res = await s.A.call('move.prepare', s.ref)
+  assert.equal(res.ok, true, JSON.stringify(res))
+  assert.equal(res.result.branch, 'feat')
+  assert.equal(res.result.origin, s.origin)
+  assert.equal(res.result.dirty, true)
+  assert.equal(res.result.queuedPrompts, 1)
+  assert.equal(res.result.prWatch, true)
+  assert.deepEqual(res.result.sessions.map((x) => [x.title, x.carried]), [['Claude 1', true], ['Claude 2', false], ['Codex 1', false]])
+  const main = s.A.project().repositories[0].worktrees.find((w) => w.isMain)
+  assert.equal((await s.A.call('move.prepare', { projectId: s.A.projectId, worktreeId: main.id })).error?.code, 'BAD_REQUEST')
+})
+
+test('move.export refuses a loaded worktree and never touches the index', async (t) => {
+  const s = await setup(t)
+  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = true })
+  assert.equal((await s.A.call('move.export', s.ref)).error?.code, 'IN_USE')
+  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = false })
+  const statusBefore = git(s.path, 'status', '--porcelain')
+  const res = await s.A.call('move.export', s.ref)
+  assert.equal(res.ok, true, JSON.stringify(res))
+  assert.equal(git(s.path, 'status', '--porcelain'), statusBefore, 'staged stays staged, untracked stays untracked')
+  assert.match(res.result.patch, /untracked\.txt/)
+  assert.match(res.result.patch, /staged\.txt/)
+  assert.match(res.result.patch, /changed/)
+  assert.equal(res.result.head, git(s.path, 'rev-parse', 'HEAD').trim())
+  assert.deepEqual(res.result.sessions.map((x) => x.agentSessionId), [CLAUDE_ID])
+  assert.equal(res.result.notCarried.length, 2)
+  assert.deepEqual(res.result.branchData, { note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true, tag: 'Review' })
+})
+
+test('move.candidates lists the repositories with the same origin, and why one is blocked', async (t) => {
+  const s = await setup(t)
+  const res = await s.B.call('move.candidates', { origin: s.origin, branch: 'feat' })
+  assert.equal(res.ok, true, JSON.stringify(res))
+  assert.equal(res.result.length, 1)
+  assert.equal(res.result[0].projectId, s.B.projectId)
+  assert.equal(res.result[0].path, join(s.dir, 'b', 'app-feat'))
+  assert.equal(res.result[0].blocked, undefined)
+  assert.deepEqual((await s.B.call('move.candidates', { origin: 'git@github.com:other/repo.git', branch: 'feat' })).result, [])
+  git(s.b, 'branch', 'feat')
+  git(s.b, 'worktree', 'add', '-q', join(s.dir, 'elsewhere'), 'feat')
+  const blocked = await s.B.call('move.candidates', { origin: s.origin, branch: 'feat' })
+  assert.match(blocked.result[0].blocked, /already checked out/)
+})
+
+test('a move builds the worktree on the target and removes the source', async (t) => {
+  const s = await setup(t)
+  const { received, exported } = await move(s)
+  assert.equal(received.ok, true, JSON.stringify(received))
+  const target = join(s.dir, 'b', 'app-feat')
+  const row = s.B.project().repositories[0].worktrees.find((w) => w.id === received.result.worktreeId)
+  assert.equal(row.path, target)
+  assert.equal(row.branch, 'feat')
+  assert.equal(row.loaded, false)
+  assert.equal(git(target, 'rev-parse', 'HEAD').trim(), exported.head)
+  assert.equal(readFileSync(join(target, 'README'), 'utf8'), 'one\nchanged\n')
+  assert.equal(readFileSync(join(target, 'untracked.txt'), 'utf8'), 'new\n')
+  assert.equal(readFileSync(join(target, 'staged.txt'), 'utf8'), 'staged\n')
+  assert.deepEqual(row.sessions.map((x) => [x.title, x.agentSessionId, x.queue.length]), [['Claude 1', CLAUDE_ID, 0]])
+  assert.notEqual(row.sessions[0].id, CLAUDE_ID, 'a new server id')
+  assert.equal(readFileSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`), 'utf8'), '{"type":"user"}\n')
+  const data = s.B.project().repositories[0].branchData.feat
+  assert.deepEqual({ ...data, prWatch: !!data.prWatch }, { tag: 'b-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true })
+  assert.deepEqual(received.result.dropped, [])
+  assert.equal(s.B.polled.length, 1, 'the watch polls soon on the target')
+  // The source: gone from git and the project, its watch ended, its history kept (copied, not moved).
+  assert.ok(!existsSync(s.path))
+  assert.equal(s.A.project().repositories[0].worktrees.some((w) => w.id === s.worktreeId), false)
+  assert.equal(s.A.project().repositories[0].branchData.feat.prWatch, undefined)
+  assert.equal(s.A.forgotten.length, 1)
+  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
+})
+
+test('a tag the target lacks, and a PR watch without gh there, are reported as dropped', async (t) => {
+  const s = await setup(t)
+  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].branchData.feat.tag = 'a-only' })
+  const B = await server(t, s.dir, 'b2', s.b, false)
+  s.B = B
+  const { received } = await move(s)
+  assert.equal(received.ok, true, JSON.stringify(received))
+  assert.equal(received.result.dropped.length, 2)
+  assert.match(received.result.dropped.join('\n'), /Only on A/)
+  assert.match(received.result.dropped.join('\n'), /gh is not signed in/)
+  assert.equal(B.project().repositories[0].branchData.feat.prWatch, undefined)
+})
+
+test('move.receive undoes everything when origin is not at the source head', async (t) => {
+  const s = await setup(t)
+  const exported = (await s.A.call('move.export', s.ref)).result
+  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
+  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: exported.patch, sessions: exported.sessions, branchData: {} })
+  assert.equal(res.error?.code, 'CONFLICT')
+  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
+  assert.ok(!existsSync(join(s.dir, 'b', 'app-feat')))
+})
+
+test('move.receive undoes the worktree, the branch and the histories when the patch fails', async (t) => {
+  const s = await setup(t)
+  const exported = (await s.A.call('move.export', s.ref)).result
+  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
+  const target = join(s.dir, 'b', 'app-feat')
+  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: 'diff --git a/x b/x\nnot a patch\n', sessions: exported.sessions, branchData: exported.branchData })
+  assert.equal(res.error?.code, 'GIT_ERROR', JSON.stringify(res))
+  assert.ok(!existsSync(target))
+  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
+  assert.ok(!existsSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`)))
+  assert.equal(s.B.project().repositories[0].worktrees.length, 1)
+  assert.equal(s.B.project().repositories[0].branchData.feat, undefined)
+})
+
+test('move.finish keeps a source that changed after the export', async (t) => {
+  const s = await setup(t)
+  const exported = (await s.A.call('move.export', s.ref)).result
+  writeFileSync(join(s.path, 'later.txt'), 'typed after the copy\n')
+  const res = await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint })
+  assert.equal(res.error?.code, 'CONFLICT')
+  assert.ok(existsSync(join(s.path, 'later.txt')))
+  assert.equal((await s.A.call('move.finish', { ...s.ref, fingerprint: 'nope' })).error?.code, 'BAD_REQUEST')
+})
+
+test('move.receive validates what it is given', async (t) => {
+  const s = await setup(t)
+  const base = { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: '', sessions: [], branchData: {} }
+  const code = async (over) => (await s.B.call('move.receive', { ...base, ...over })).error?.code
+  assert.equal(await code({ head: 'HEAD' }), 'BAD_REQUEST')
+  assert.equal(await code({ branch: '-x' }), 'BAD_REQUEST')
+  assert.equal(await code({ sessions: [{ title: 't', llm: { provider: 'codex' }, agentSessionId: CLAUDE_ID, history: '' }] }), 'BAD_REQUEST')
+  assert.equal(await code({ sessions: [{ title: 't', llm: { provider: 'claude' }, agentSessionId: '../x', history: '' }] }), 'BAD_REQUEST')
+  assert.equal(await code({ branchData: { note: 5 } }), 'BAD_REQUEST')
+  assert.equal(await code({ repoId: 'nope' }), 'NOT_FOUND')
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 43ab6ed..bdcba2b 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 64299a5..69fe87c 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -6,7 +6,8 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
  * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
  * `linear` and `voice` say it serves `linear.*` and `voice.*`; whether it has a key is
  * `linear.status`'s and `voice.settings`' answer. `review` (5c-2): the Changes tab's sources and
- * draft line comments.
+ * draft line comments. `move` (5d): `move.*`, a worktree's
+ * move to or from another server.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -19,7 +20,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.linear,
   CAPABILITY.voice,
   CAPABILITY.skills,
-  CAPABILITY.review
+  CAPABILITY.review,
+  CAPABILITY.move
 ]
 
 /**
diff --git a/server/src/move/moveHandlers.ts b/server/src/move/moveHandlers.ts
new file mode 100644
index 0000000..b016296
--- /dev/null
+++ b/server/src/move/moveHandlers.ts
@@ -0,0 +1,437 @@
+// Moving a worktree between servers (phase 5d), behind the `move` capability. The app relays: it
+// asks the source `move.prepare` (what would move), the target `move.candidates` (where it can go),
+// unloads the source, takes `move.export` (HEAD, the uncommitted work as one patch, the Claude
+// histories, the branch data), pushes the branch through origin (`worktree.push`), hands it all
+// to the target's `move.receive` (which builds the worktree, or rolls itself back), and finally
+// asks the source `move.finish` to remove its copy, only if nothing changed since the export.
+import { createHash, randomUUID } from 'node:crypto'
+import { existsSync } from 'node:fs'
+import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
+import { join } from 'node:path'
+import * as gitService from '../../../src/host/gitService.ts'
+import { projectDir } from '../../../src/host/claudeSessionService.ts'
+import type { BranchData, Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
+import {
+  MAX_MOVE_HISTORY_BYTES,
+  MAX_MOVE_PATCH_BYTES,
+  MAX_MOVE_SESSIONS,
+  sameOrigin,
+  type MoveBranchData,
+  type MoveCandidate,
+  type MoveExport,
+  type MovePlan,
+  type MoveReceived,
+  type MoveSession,
+  type MoveSessionInfo
+} from '../../../src/shared/move.ts'
+import { isProviderId } from '../../../src/shared/providers/registry.ts'
+import { sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
+import { codedError } from '../errors.ts'
+import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
+import { realOrResolved as real } from '../repos.ts'
+import { MAX_SESSIONS_PER_PROJECT, checkTitle } from '../sessions/limits.ts'
+import { isRecord, requireBranch, requireString } from '../validate.ts'
+import type { V2Context } from '../v2.ts'
+import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
+const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
+const FINGERPRINT = /^[0-9a-f]{64}$/
+const MAX_SYSTEM_PROMPT = 100_000
+const MAX_NOTE = 100_000
+const MB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
+
+/** Same head and same patch: nothing changed in the worktree since it was exported. */
+function fingerprint(head: string, patch: string): string {
+  return createHash('sha256').update(head).update('\0').update(patch).digest('hex')
+}
+
+async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
+  try {
+    return await operation()
+  } catch (err) {
+    throw codedError('GIT_ERROR', (err as Error).message)
+  }
+}
+
+/** A Claude session's history file under the worktree's path, if it has one, and its size. */
+async function historyOf(worktree: Worktree, session: Session): Promise<{ file: string; size: number } | null> {
+  if (session.llm.provider !== 'claude' || !session.agentSessionId || !SESSION_ID.test(session.agentSessionId)) return null
+  const file = join(projectDir(worktree.path), `${session.agentSessionId}.jsonl`)
+  try {
+    const info = await stat(file)
+    return info.isFile() ? { file, size: info.size } : null
+  } catch {
+    return null
+  }
+}
+
+/** Which of the worktree's sessions are carried: Claude ones with a history, within the limits. */
+async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string }[] }> {
+  const info: MoveSessionInfo[] = []
+  const carried: { session: Session; file: string }[] = []
+  let total = 0
+  for (const session of worktree.sessions) {
+    const base = { title: session.title, provider: session.llm.provider }
+    if (session.llm.provider !== 'claude') {
+      info.push({ ...base, carried: false, reason: 'only Claude sessions move; this one stays behind and is closed' })
+      continue
+    }
+    const history = await historyOf(worktree, session)
+    if (!history) {
+      info.push({ ...base, carried: false, reason: 'it has no saved conversation yet' })
+      continue
+    }
+    if (carried.length >= MAX_MOVE_SESSIONS) {
+      info.push({ ...base, carried: false, reason: `a move carries at most ${MAX_MOVE_SESSIONS} sessions` })
+      continue
+    }
+    if (total + history.size > MAX_MOVE_HISTORY_BYTES) {
+      info.push({ ...base, carried: false, reason: `its history (${MB(history.size)}) is over what one move carries (${MB(MAX_MOVE_HISTORY_BYTES)} in all)` })
+      continue
+    }
+    total += history.size
+    carried.push({ session, file: history.file })
+    info.push({ ...base, carried: true })
+  }
+  return { info, carried }
+}
+
+/** The branch data that moves, its tags by name (each project has its own tag ids). */
+function exportBranchData(project: Project, data: BranchData | undefined): MoveBranchData {
+  if (!data) return {}
+  const out: MoveBranchData = {}
+  if (data.note) out.note = data.note
+  if (data.ticket) out.ticket = data.ticket
+  if (data.pr) out.pr = data.pr
+  if (data.prWatch) out.prWatch = true
+  const tag = data.tag ? project.settings.worktreeTags?.find((t) => t.id === data.tag)?.name : undefined
+  if (tag) out.tag = tag
+  const custom = (data.customTags ?? [])
+    .map((id) => project.settings.customTags?.find((t) => t.id === id)?.name)
+    .filter((name): name is string => !!name)
+  if (custom.length > 0) out.customTags = custom
+  return out
+}
+
+/** The worktree row the source moves: not the main checkout, on a branch, with its project. */
+async function source(ctx: V2Context, p: any): Promise<{ project: Project; repo: Repository; worktree: Worktree; branch: string }> {
+  const { worktree: row } = present(ctx, p)
+  if (row.isMain) throw bad("a repository's main checkout cannot be moved; move a worktree")
+  const { repo, worktree, branch } = await checkedOut(ctx, p)
+  return { project: ctx.projects.require(p.projectId), repo, worktree, branch }
+}
+
+/** Where on this server a branch can't go, or undefined. Re-reads git's worktree list. */
+async function blockedReason(ctx: V2Context, repo: Repository, branch: string, path: string): Promise<string | undefined> {
+  const listed = await gitService.listWorktrees(repo.path).catch(() => null)
+  if (!listed) return `${repo.path} can't be read`
+  const holder = listed.find((w) => w.branch === branch)
+  if (holder) return `${branch} is already checked out at ${holder.path}`
+  if (existsSync(path)) return `${path} already exists`
+  try {
+    ctx.store.guard.check(path)
+  } catch {
+    return `${path} is outside the folders this server may use`
+  }
+  return undefined
+}
+
+function checkSessions(value: unknown): MoveSession[] {
+  if (value === undefined) return []
+  if (!Array.isArray(value)) throw bad('sessions must be an array')
+  if (value.length > MAX_MOVE_SESSIONS) throw bad(`sessions must hold at most ${MAX_MOVE_SESSIONS} entries`)
+  let total = 0
+  return value.map((raw: unknown, i) => {
+    if (!isRecord(raw)) throw bad(`sessions[${i}] must be an object`)
+    const title = checkTitle(requireString(raw.title, `sessions[${i}].title`), `sessions[${i}].title`)
+    if (!isRecord(raw.llm) || !isProviderId(raw.llm.provider)) throw bad(`sessions[${i}].llm.provider must be a known provider`)
+    if (raw.llm.provider !== 'claude') throw bad(`sessions[${i}]: only Claude sessions are carried`)
+    const llm = sanitizeLlmSelection(raw.llm)
+    if (!llm) throw bad(`sessions[${i}].llm must be an LLM selection`)
+    const agentSessionId = requireString(raw.agentSessionId, `sessions[${i}].agentSessionId`)
+    if (!SESSION_ID.test(agentSessionId)) throw bad(`sessions[${i}].agentSessionId must be a session id`)
+    const history = requireString(raw.history, `sessions[${i}].history`)
+    total += Buffer.byteLength(history)
+    if (total > MAX_MOVE_HISTORY_BYTES) throw bad(`the histories must be at most ${MB(MAX_MOVE_HISTORY_BYTES)} in all`)
+    const session: MoveSession = { title, llm, agentSessionId, history }
+    if (raw.sessionTypeName !== undefined) session.sessionTypeName = requireString(raw.sessionTypeName, `sessions[${i}].sessionTypeName`)
+    if (raw.systemPrompt !== undefined) {
+      const prompt = requireString(raw.systemPrompt, `sessions[${i}].systemPrompt`)
+      if (prompt.length > MAX_SYSTEM_PROMPT) throw bad(`sessions[${i}].systemPrompt must be at most ${MAX_SYSTEM_PROMPT} characters`)
+      session.systemPrompt = prompt
+    }
+    if (raw.complete === true) session.complete = true
+    return session
+  })
+}
+
+function checkBranchData(value: unknown): MoveBranchData {
+  if (value === undefined) return {}
+  if (!isRecord(value)) throw bad('branchData must be an object')
+  const out: MoveBranchData = {}
+  const text = (key: 'note' | 'tag' | 'ticket' | 'pr', max: number): void => {
+    const v = value[key]
+    if (v === undefined) return
+    if (typeof v !== 'string' || v.length > max) throw bad(`branchData.${key} must be a string of at most ${max} characters`)
+    if (v) out[key] = v
+  }
+  text('note', MAX_NOTE)
+  text('tag', 200)
+  text('ticket', 200)
+  text('pr', 2000)
+  if (value.customTags !== undefined) {
+    if (!Array.isArray(value.customTags) || value.customTags.length > 100 || value.customTags.some((t) => typeof t !== 'string' || t.length > 200)) {
+      throw bad('branchData.customTags must be at most 100 tag names')
+    }
+    if (value.customTags.length > 0) out.customTags = value.customTags as string[]
+  }
+  if (value.prWatch !== undefined && typeof value.prWatch !== 'boolean') throw bad('branchData.prWatch must be a boolean')
+  if (value.prWatch === true) out.prWatch = true
+  return out
+}
+
+/** The incoming branch data on top of what the target project already has for the branch. */
+function mergeBranchData(project: Project, existing: BranchData | undefined, incoming: MoveBranchData, prWatchable: boolean, dropped: string[]): BranchData {
+  const data: BranchData = { ...(existing ?? {}) }
+  if (incoming.note) data.note = incoming.note
+  if (incoming.ticket) data.ticket = incoming.ticket
+  if (incoming.pr) {
+    if (data.pr !== incoming.pr) delete data.prWatch
+    data.pr = incoming.pr
+  }
+  if (incoming.tag) {
+    const tag = project.settings.worktreeTags?.find((t) => t.name === incoming.tag)
+    if (tag) data.tag = tag.id
+    else dropped.push(`The tag “${incoming.tag}” is not one of this project's tags`)
+  }
+  if (incoming.customTags) {
+    const ids: string[] = [...(data.customTags ?? [])]
+    for (const name of incoming.customTags) {
+      const tag = project.settings.customTags?.find((t) => t.name === name)
+      if (!tag) dropped.push(`The custom tag “${name}” is not one of this project's tags`)
+      else if (!ids.includes(tag.id)) ids.push(tag.id)
+    }
+    if (ids.length > 0) data.customTags = ids
+  }
+  if (incoming.prWatch && data.pr) {
+    if (prWatchable) data.prWatch ??= {}
+    else dropped.push('The pull request is not watched here: gh is not signed in on this server')
+  }
+  return data
+}
+
+export const moveHandlers: Record<string, Handler> = {
+  /** What would move, read only: the branch, its origin, which sessions are carried. */
+  'move.prepare': async (p, ctx): Promise<MovePlan> => {
+    const { repo, worktree, branch } = await source(ctx, p)
+    const { info } = await carriedSessions(worktree)
+    return {
+      branch,
+      origin: await gitService.originUrl(repo.path),
+      repoName: repo.name,
+      dirty: (await gitService.worktreeDirty(worktree.path)) ?? worktree.dirty ?? false,
+      loaded: worktree.loaded,
+      sessions: info,
+      reviewComments: worktree.review?.comments.length ?? 0,
+      queuedPrompts: worktree.sessions.reduce((n, s) => n + s.queue.length, 0),
+      prWatch: !!(Object.hasOwn(repo.branchData, branch) && repo.branchData[branch].prWatch)
+    }
+  },
+
+  /** Everything the target needs, from an unloaded worktree. Changes nothing. */
+  'move.export': async (p, ctx): Promise<MoveExport & { fingerprint: string }> => {
+    const { project, repo, worktree, branch } = await source(ctx, p)
+    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
+    const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path))
+    const size = Buffer.byteLength(patch)
+    if (size > MAX_MOVE_PATCH_BYTES) {
+      throw bad(`the uncommitted changes make a ${MB(size)} patch; a move carries at most ${MB(MAX_MOVE_PATCH_BYTES)}. Commit or remove the large files first`)
+    }
+    const { info, carried } = await carriedSessions(worktree)
+    const sessions: MoveSession[] = []
+    const notCarried = info.filter((s) => !s.carried).map((s) => `${s.title}: ${s.reason}`)
+    for (const { session, file } of carried) {
+      const history = await readFile(file, 'utf8').catch(() => null)
+      if (history === null) {
+        notCarried.push(`${session.title}: its history could not be read`)
+        continue
+      }
+      const out: MoveSession = { title: session.title, llm: session.llm, agentSessionId: session.agentSessionId!, history }
+      const type = session.sessionTypeId ? project.settings.sessionTypes?.find((t) => t.id === session.sessionTypeId) : undefined
+      if (type) out.sessionTypeName = type.name
+      if (session.systemPrompt) out.systemPrompt = session.systemPrompt
+      if (session.status === 'complete') out.complete = true
+      sessions.push(out)
+    }
+    const data = Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
+    return { branch, head: headSha, patch, sessions, notCarried, branchData: exportBranchData(project, data), fingerprint: fingerprint(headSha, patch) }
+  },
+
+  /**
+   * The last step, once the target has the worktree: the source's copy is removed (force) only if
+   * its HEAD and uncommitted work are what was exported; otherwise CONFLICT and nothing changes.
+   * Its PR watch ends (the target watches it now).
+   */
+  'move.finish': async (p, ctx): Promise<null> => {
+    const expected = requireString(p.fingerprint, 'fingerprint')
+    if (!FINGERPRINT.test(expected)) throw bad('fingerprint must be what move.export returned')
+    const { repo, worktree, branch } = await source(ctx, p)
+    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} was loaded again after it was copied; it is kept`)
+    const unblock = ctx.sessions.blockPath(worktree.path)
+    try {
+      const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path))
+      if (fingerprint(headSha, patch) !== expected) {
+        throw codedError('CONFLICT', `${worktree.path} changed after it was copied; it is kept`)
+      }
+      await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
+      await ctx.poller.refresh(repo.path)
+    } finally {
+      unblock()
+    }
+    let watched = false
+    ctx.projects.apply(p.projectId, (d) => {
+      const r = repoIn(d, repo.id)
+      r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
+      const orderKey = `${repo.id} ${worktree.path}`
+      if (d.settings.worktreeOrder) {
+        const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
+        if (order.length > 0) d.settings.worktreeOrder = order
+        else delete d.settings.worktreeOrder
+      }
+      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
+      if (data?.prWatch) {
+        watched = true
+        const next = { ...data }
+        delete next.prWatch
+        if (Object.keys(next).length === 0) delete r.branchData[branch]
+        else r.branchData[branch] = next
+      }
+    })
+    if (watched) ctx.prWatch?.forget(requireString(p.projectId, 'projectId'), repo.id, branch)
+    ctx.sessions.refreshAttention()
+    return null
+  },
+
+  /** The places on this server the branch can go: repositories with the same origin, in every project. */
+  'move.candidates': async (p, ctx): Promise<MoveCandidate[]> => {
+    const origin = requireString(p.origin, 'origin')
+    const branch = requireBranch(p.branch)
+    const origins = new Map<string, string | null>()
+    const out: MoveCandidate[] = []
+    for (const project of ctx.projects.all()) {
+      for (const repo of project.repositories) {
+        try {
+          findRegistered(ctx.store.config.repos, repo.path)
+        } catch {
+          continue
+        }
+        if (!origins.has(repo.path)) origins.set(repo.path, await gitService.originUrl(repo.path))
+        if (!sameOrigin(origins.get(repo.path), origin)) continue
+        const path = defaultWorktreePath(repo.path, branch)
+        const blocked = await blockedReason(ctx, repo, branch, path)
+        out.push({ projectId: project.id, projectName: project.name, repoId: repo.id, repoName: repo.name, path, ...(blocked ? { blocked } : {}) })
+      }
+    }
+    return out
+  },
+
+  /**
+   * Builds the moved worktree: fetches the branch from origin, checks it out at the default path,
+   * checks HEAD is the source's, applies the patch, writes the Claude histories under the new path
+   * and adds their saved sessions (unloaded) and the branch data. Any failure undoes all of it.
+   */
+  'move.receive': async (p, ctx): Promise<MoveReceived> => {
+    const project = ctx.projects.require(p.projectId)
+    const repo = repoIn(project, p.repoId)
+    findRegistered(ctx.store.config.repos, repo.path)
+    const branch = requireBranch(p.branch)
+    await checkBranchName(repo.path, branch, false)
+    const head = requireString(p.head, 'head')
+    if (!SHA.test(head)) throw bad('head must be a full commit id')
+    const patch = p.patch === undefined ? '' : requireString(p.patch, 'patch')
+    if (Buffer.byteLength(patch) > MAX_MOVE_PATCH_BYTES) throw bad(`patch must be at most ${MB(MAX_MOVE_PATCH_BYTES)}`)
+    const sessions = checkSessions(p.sessions)
+    const incoming = checkBranchData(p.branchData)
+    const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
+    if (records + sessions.length > MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions`)
+
+    const target = ctx.store.guard.check(defaultWorktreePath(repo.path, branch))
+    assertNotRepository(ctx.store.config.repos, target, 'path')
+    const blocked = await blockedReason(ctx, repo, branch, target)
+    if (blocked) throw codedError('CONFLICT', blocked)
+
+    const undo: (() => Promise<unknown>)[] = []
+    const g = (args: string[]): Promise<string> => gitService.git(repo.path, args)
+    try {
+      await viaGit(() => g(['fetch', '--no-tags', 'origin', '--', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]))
+      const fetched = (await viaGit(() => g(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]))).trim()
+      if (fetched !== head) throw codedError('CONFLICT', `origin's ${branch} is at ${fetched.slice(0, 8)}, not the source's ${head.slice(0, 8)}: did something else push to it?`)
+      const local = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then((s) => s.trim(), () => null)
+      if (local === null) {
+        await viaGit(() => g(['branch', '--track', '--', branch, `refs/remotes/origin/${branch}`]))
+        undo.push(() => g(['branch', '-D', '--', branch]))
+      } else if (local !== head) {
+        const behind = await g(['merge-base', '--is-ancestor', local, head]).then(() => true, () => false)
+        if (!behind) throw codedError('CONFLICT', `this server's own ${branch} has commits the source's doesn't; reconcile them first`)
+        await viaGit(() => g(['update-ref', `refs/heads/${branch}`, head, local]))
+        undo.push(() => g(['update-ref', `refs/heads/${branch}`, local, head]))
+      }
+      const unblock = ctx.sessions.blockPath(target)
+      try {
+        await viaGit(() => gitService.addWorktreeAt(repo.path, target, branch))
+        undo.push(() => gitService.removeWorktreeForce(repo.path, target))
+        await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
+        const checked = await viaGit(() => gitService.revParseHead(target))
+        if (checked !== head) throw codedError('GIT_ERROR', `${target} checked out ${checked.slice(0, 8)}, not ${head.slice(0, 8)}`)
+        if (patch.trim()) {
+          await viaGit(() => gitService.applyPatch(target, patch))
+          if ((await gitService.worktreeDirty(target)) === false) throw codedError('GIT_ERROR', 'the uncommitted changes did not apply')
+        }
+      } finally {
+        unblock()
+      }
+      const dir = projectDir(target)
+      for (const s of sessions) {
+        const file = join(dir, `${s.agentSessionId}.jsonl`)
+        const before = await readFile(file, 'utf8').catch(() => null)
+        await mkdir(dir, { recursive: true })
+        await writeFile(file, s.history, { encoding: 'utf8', mode: 0o600 })
+        undo.push(() => (before === null ? rm(file, { force: true }) : writeFile(file, before, 'utf8')))
+      }
+      if (!(await ctx.poller.refresh(repo.path))) {
+        throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
+      }
+      const dropped: string[] = []
+      const watchable = ctx.prWatch?.available() ?? false
+      const worktreeId = ctx.projects.apply(p.projectId, (d) => {
+        const r = repoIn(d, repo.id)
+        const created = r.worktrees.find((w) => !w.isMain && real(w.path) === target)
+        if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
+        for (const s of sessions) {
+          const row: Session = { id: randomUUID(), agentSessionId: s.agentSessionId, title: s.title, llm: s.llm, queue: [], status: s.complete ? 'complete' : 'idle' }
+          const type = s.sessionTypeName ? d.settings.sessionTypes?.find((t) => t.name === s.sessionTypeName) : undefined
+          if (type) row.sessionTypeId = type.id
+          else if (s.sessionTypeName) dropped.push(`The session type “${s.sessionTypeName}” of “${s.title}” is not one of this project's`)
+          if (s.systemPrompt) row.systemPrompt = s.systemPrompt
+          created.sessions.push(row)
+        }
+        const existing = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
+        const data = mergeBranchData(d, existing, incoming, watchable, dropped)
+        if (Object.keys(data).length > 0) r.branchData[branch] = data
+        return created.id
+      })
+      const watched = Object.hasOwn(repoIn(ctx.projects.require(p.projectId), repo.id).branchData, branch) &&
+        !!repoIn(ctx.projects.require(p.projectId), repo.id).branchData[branch].prWatch
+      if (watched) ctx.prWatch?.pollSoon(project.id, repo.id, branch)
+      return { worktreeId, dropped }
+    } catch (err) {
+      for (const step of undo.reverse()) await step().catch(() => {})
+      await ctx.poller.refresh(repo.path).catch(() => false)
+      throw err
+    }
+  }
+}
diff --git a/server/src/v2.ts b/server/src/v2.ts
index ba5d442..25eacc9 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -2,7 +2,8 @@
 // projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
 // the v2 pty.* stream, docker, env and stack on the server's machine (machineHandlers.ts), and
 // Linear, voice and skills with the server's own keys and disk (integrationHandlers.ts), and the
-// pull request watch (prWatchHandlers.ts), and the Changes tab's review (reviewHandlers.ts).
+// pull request watch (prWatchHandlers.ts), the Changes tab's review (reviewHandlers.ts), and
+// moving a worktree between servers (moveHandlers.ts).
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { IntegrationsChangedEvent, TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -17,6 +18,7 @@ import { machineHandlers, type EventSink, type Machine } from './integrations/ma
 import { integrationHandlers } from './integrations/integrationHandlers.ts'
 import { prWatchHandlers } from './prWatch/prWatchHandlers.ts'
 import { reviewHandlers } from './review/reviewHandlers.ts'
+import { moveHandlers } from './move/moveHandlers.ts'
 import type { PrWatcher } from './prWatch/watcher.ts'
 import type { Integrations } from './integrations/integrations.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
@@ -305,7 +307,8 @@ const handlers: Record<string, Handler> = {
   ...machineHandlers,
   ...integrationHandlers,
   ...prWatchHandlers,
-  ...reviewHandlers
+  ...reviewHandlers,
+  ...moveHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/server/src/worktreeHandlers.ts b/server/src/worktreeHandlers.ts
index ea4bfe3..c54a7c0 100644
--- a/server/src/worktreeHandlers.ts
+++ b/server/src/worktreeHandlers.ts
@@ -54,7 +54,7 @@ async function hasChanges(worktreePath: string): Promise<boolean> {
 }
 
 /** Only a real branch name: not a revision expression like @{-1}, nor HEAD, a tag or a SHA. */
-async function checkBranchName(repoPath: string, branch: string, mustExist: boolean): Promise<void> {
+export async function checkBranchName(repoPath: string, branch: string, mustExist: boolean): Promise<void> {
   if (branch.startsWith('-')) throw bad('branch must not start with "-"')
   if (branch === '@' || branch === 'HEAD') throw bad(`"${branch}" is not a valid branch name`)
   try {
diff --git a/src/host/gitService.ts b/src/host/gitService.ts
index fd63e85..9d9362b 100644
--- a/src/host/gitService.ts
+++ b/src/host/gitService.ts
@@ -1,6 +1,7 @@
 // Electron-free: shared by the Electron main process and the remote daemon.
 import { execFile } from 'node:child_process'
-import { lstat, mkdir, open, readFile, symlink } from 'node:fs/promises'
+import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, symlink } from 'node:fs/promises'
+import { tmpdir } from 'node:os'
 import { dirname, join, resolve, sep } from 'node:path'
 import { promisify } from 'node:util'
 import type {
@@ -246,20 +247,38 @@ export async function checkout(repoPath: string, branch: string): Promise<void>
 }
 
 /**
- * Uncommitted + untracked changes as one binary patch. `add -N` (intent-to-add)
- * makes untracked files appear in the diff; the trailing `reset -q` undoes it,
- * so the worktree is left exactly as found. Ignored files never appear.
+ * Uncommitted + untracked changes as one binary patch against HEAD (a worktree move, 5d). It is
+ * built in a throwaway copy of the index (GIT_INDEX_FILE), so the worktree's own index, its
+ * staged changes included, is never touched. Ignored files never appear. The patch puts every
+ * change back unstaged.
  */
 export async function exportDirtyPatch(
   worktreePath: string
 ): Promise<{ patch: string; headSha: string }> {
-  const headSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
-  await git(worktreePath, ['add', '-N', '.'])
+  const headSha = (await git(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim()
+  const gitIndex = resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim())
+  const dir = await mkdtemp(join(tmpdir(), 'trek-move-index-'))
+  const index = join(dir, 'index')
   try {
-    const patch = await git(worktreePath, ['diff', 'HEAD', '--binary'])
-    return { patch, headSha }
+    await copyFile(gitIndex, index).catch(() => {})
+    const env = { ...process.env, GIT_INDEX_FILE: index }
+    const run = (args: string[]) =>
+      execFileAsync('git', ['-C', worktreePath, ...args], { env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
+    await run(['add', '-A', '--', '.'])
+    const { stdout } = await run(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD'])
+    return { patch: stdout, headSha }
   } finally {
-    await git(worktreePath, ['reset', '-q'])
+    await rm(dir, { recursive: true, force: true })
+  }
+}
+
+/** `git remote get-url origin`; null when the repository has no origin. */
+export async function originUrl(repoPath: string): Promise<string | null> {
+  try {
+    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).trim()
+    return url || null
+  } catch {
+    return null
   }
 }
 
diff --git a/src/shared/move.ts b/src/shared/move.ts
new file mode 100644
index 0000000..21d0079
--- /dev/null
+++ b/src/shared/move.ts
@@ -0,0 +1,129 @@
+// Moving a worktree between servers (phase 5d): the shapes the `move.*` methods carry, their
+// limits, and how two repositories' origin URLs are compared. Pure: shared by the server, the
+// app's move flow and `node --test`.
+import type { LlmSelection } from './providers/types.ts'
+
+/**
+ * The uncommitted work travels as one `git diff --binary` patch inside a protocol frame (16 MiB on
+ * the server). The patch and the Claude histories share what is left of it.
+ */
+export const MAX_MOVE_PATCH_BYTES = 8 * 1024 * 1024
+/** All carried session histories together */
+export const MAX_MOVE_HISTORY_BYTES = 6 * 1024 * 1024
+/** Sessions one move carries (a project holds at most 500) */
+export const MAX_MOVE_SESSIONS = 50
+
+/** A session `move.prepare` lists: carried (its history is copied) or not, and why not. */
+export interface MoveSessionInfo {
+  title: string
+  provider: string
+  carried: boolean
+  /** Why it is not carried */
+  reason?: string
+}
+
+/** What `move.prepare` reports about the worktree before anything is changed. */
+export interface MovePlan {
+  branch: string
+  /** `git remote get-url origin` of the worktree's repository; null without one */
+  origin: string | null
+  /** The repository's name on this server */
+  repoName: string
+  dirty: boolean
+  loaded: boolean
+  sessions: MoveSessionInfo[]
+  /** Unsent review comments (5c-2), which are not moved */
+  reviewComments: number
+  /** Queued prompts, which are not moved */
+  queuedPrompts: number
+  /** The branch's PR watch is on */
+  prWatch: boolean
+}
+
+/** A carried session as `move.export` hands it over and `move.receive` takes it. */
+export interface MoveSession {
+  title: string
+  llm: LlmSelection
+  /** The agent's own id, the history file's name */
+  agentSessionId: string
+  /** The `.jsonl` history, as Claude wrote it under the old path */
+  history: string
+  sessionTypeName?: string
+  systemPrompt?: string
+  complete?: boolean
+}
+
+/** The branch data carried with the worktree: tags by name, since each project has its own tag ids. */
+export interface MoveBranchData {
+  note?: string
+  tag?: string
+  customTags?: string[]
+  ticket?: string
+  pr?: string
+  prWatch?: boolean
+}
+
+/** `move.export`'s answer: everything the target needs, read from an unloaded worktree. */
+export interface MoveExport {
+  branch: string
+  /** The commit the source has checked out; the target must check out the same one */
+  head: string
+  /** `git diff --binary HEAD` of the work tree, untracked files included; '' when clean */
+  patch: string
+  sessions: MoveSession[]
+  /** Sessions not carried, one line each */
+  notCarried: string[]
+  branchData: MoveBranchData
+}
+
+/** One place on the target server the worktree can go (`move.candidates`). */
+export interface MoveCandidate {
+  projectId: string
+  projectName: string
+  repoId: string
+  repoName: string
+  /** Where the worktree would be created */
+  path: string
+  /** Why it can't go here (the branch is checked out there, the path exists); absent when it can */
+  blocked?: string
+}
+
+/** `move.receive`'s answer. */
+export interface MoveReceived {
+  worktreeId: string
+  /** What did not come across (a tag the project lacks, a PR watch without gh), one line each */
+  dropped: string[]
+}
+
+/**
+ * An origin URL reduced to host and path, so the ssh and https forms of one repository match:
+ * `git@github.com:a/b.git`, `ssh://git@github.com/a/b`, `https://github.com/a/b.git/` all give
+ * `github.com/a/b`. Hosts compare case-insensitively, paths as written. A local path is kept as a
+ * path (without a trailing `.git` or `/`). Null for an empty value.
+ */
+export function normalizeOrigin(url: string | null | undefined): string | null {
+  let value = (url ?? '').trim()
+  if (!value) return null
+  value = value.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
+  const file = /^file:\/\/[^/]*(\/.*)$/i.exec(value)
+  if (file) return file[1]
+  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(value)
+  if (scheme) {
+    return `${scheme[2].toLowerCase()}${scheme[3] ?? ''}`
+  }
+  // scp-like: [user@]host:path (not a Windows drive letter or a local path)
+  const scp = /^(?:[^@/]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(value)
+  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`
+  return value
+}
+
+/** Whether two origin URLs name the same repository; never for a missing one. */
+export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
+  const left = normalizeOrigin(a)
+  return left !== null && left === normalizeOrigin(b)
+}
+
+/** UTF-8 bytes of a string, as the frame carries it */
+export function utf8Bytes(text: string): number {
+  return new TextEncoder().encode(text).length
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 241680b..b54a6a2 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -3,6 +3,7 @@
 // domain commands and subscribe to topics (snapshot + JSON patches). See PROTOCOL.md. This file is
 // the single source of truth for frame shapes. (Protocol v1, the per-call git and pty methods of
 // the file windows, was retired in phase 4e: a v1 hello is refused with UPGRADE_CLIENT.)
+import type { MoveBranchData, MoveCandidate, MoveExport, MovePlan, MoveReceived, MoveSession } from './move.ts'
 import type {
   AttentionTopic,
   ProjectTopic,
@@ -204,7 +205,12 @@ export const CAPABILITY = {
    * `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line
    * comments and send them to one of its sessions as one queued prompt
    */
-  review: 'review'
+  review: 'review',
+  /**
+   * Moving a worktree between servers (5d): `move.prepare`, `move.export` and `move.finish` on the
+   * source, `move.candidates` and `move.receive` on the target; the app relays between them
+   */
+  move: 'move'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -450,6 +456,18 @@ export interface MethodParamsV2 {
   /** The worktree's `.claude/skills` and `.claude/commands`, then the server user's `~/.claude` ones */
   'skills.list': WorktreeRef
 
+  // Moving a worktree between servers (capability `move`, 5d)
+  /** Source, read only: what would move */
+  'move.prepare': WorktreeRef
+  /** Source: HEAD, the uncommitted work, the Claude histories and the branch data of an unloaded worktree */
+  'move.export': WorktreeRef
+  /** Source: removes the worktree if it is unchanged since `move.export` (its `fingerprint`); else CONFLICT */
+  'move.finish': WorktreeRef & { fingerprint: string }
+  /** Target: where a branch of a repository with this origin can go, in every project */
+  'move.candidates': { origin: string; branch: string }
+  /** Target: builds the worktree from origin and the export, or undoes all of it */
+  'move.receive': RepoRef & { branch: string; head: string; patch: string; sessions: MoveSession[]; branchData: MoveBranchData }
+
   // Subscriptions
   'sub.subscribe': { topic: Topic }
   'sub.unsubscribe': { topic: Topic }
@@ -565,6 +583,11 @@ export interface MethodResultsV2 {
   /** The mp3, base64 */
   'voice.synthesize': { audio: string }
   'skills.list': SkillInfo[]
+  'move.prepare': MovePlan
+  'move.export': MoveExport & { fingerprint: string }
+  'move.finish': null
+  'move.candidates': MoveCandidate[]
+  'move.receive': MoveReceived
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
````

</details>


## Task 2: the app's Move to another server…

**Prototype commit:** `37d063f` on `central-server-phase5d-proto`.

**Files:**

- Modify: `scripts/backendFeatures.test.mjs`
- Create: `scripts/moveFlow.test.mjs`
- Modify: `src/renderer/src/backend.ts`
- Modify: `src/renderer/src/backendFeatures.ts`
- Create: `src/renderer/src/components/MoveWorktreeModal.tsx`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/v2/backendV2.ts`
- Create: `src/renderer/src/v2/moveFlow.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/moveFlow.test.mjs scripts/backendFeatures.test.mjs   # 7 + 16 pass
npx tsc --noEmit
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5d): Move to another server…: the moveWorktree feature on move, MoveWorktreeModal and moveFlow.ts relaying between the two connections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index be1d054..1888982 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -24,7 +24,12 @@ test('an empty window has no feature (4e: no file windows)', () => {
 
 test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'moveWorktree', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+})
+
+test('moving a worktree to another server follows move (5d)', () => {
+  assert.equal(v2Features(['move']).moveWorktree, true)
+  assert.equal(v2Features(['review', 'mcp']).moveWorktree, false)
 })
 
 test('the Changes tab review follows review (5c-2): an older server has only the branch view', () => {
diff --git a/scripts/moveFlow.test.mjs b/scripts/moveFlow.test.mjs
new file mode 100644
index 0000000..6d01338
--- /dev/null
+++ b/scripts/moveFlow.test.mjs
@@ -0,0 +1,109 @@
+// scripts/moveFlow.test.mjs — the app's worktree move (phase 5d) over fake source and target servers.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { moveTargets, moveWorktree } from '../src/renderer/src/v2/moveFlow.ts'
+import { ClientError } from '../src/shared/client/connection.ts'
+
+const EXPORT = { branch: 'feat', head: 'a'.repeat(40), patch: 'diff', sessions: [{ title: 'c' }], notCarried: ['Codex 1: only Claude sessions move'], branchData: { note: 'n' }, fingerprint: 'f'.repeat(64) }
+
+/** A fake server: answers by method, records every call. */
+function fake(answers) {
+  const calls = []
+  const request = async (method, params) => {
+    calls.push([method, params])
+    const answer = answers[method]
+    if (answer instanceof Error) throw answer
+    return typeof answer === 'function' ? answer(params) : answer ?? null
+  }
+  return { calls, request, methods: () => calls.map(([m]) => m) }
+}
+
+function run(source, target, over = {}) {
+  const steps = []
+  const outcome = moveWorktree({
+    source: source.request,
+    target: target.request,
+    from: { projectId: 'pa', worktreeId: 'wa' },
+    to: { projectId: 'pb', repoId: 'rb' },
+    loaded: true,
+    progress: (step, status, detail) => steps.push([step, status, detail]),
+    cancelled: () => false,
+    ...over
+  })
+  return { outcome, steps }
+}
+
+test('a move unloads, exports, pushes, receives and finishes, in that order', async () => {
+  const source = fake({ 'move.export': EXPORT })
+  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: ['The tag “X” is not one of this project’s tags'] } })
+  const { outcome } = run(source, target)
+  const result = await outcome
+  assert.equal(result.kind, 'moved')
+  assert.equal(result.worktreeId, 'wb')
+  assert.deepEqual(result.notes, ['Not carried: Codex 1: only Claude sessions move', 'The tag “X” is not one of this project’s tags'])
+  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'move.finish'])
+  assert.deepEqual(source.calls[3][1], { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint })
+  assert.deepEqual(target.calls[0], ['move.receive', { projectId: 'pb', repoId: 'rb', branch: 'feat', head: EXPORT.head, patch: 'diff', sessions: EXPORT.sessions, branchData: { note: 'n' } }])
+})
+
+test('a failed push leaves the target alone and loads the source again', async () => {
+  const source = fake({ 'move.export': EXPORT, 'worktree.push': new ClientError('GIT_ERROR', 'rejected') })
+  const target = fake({})
+  const { outcome, steps } = run(source, target)
+  const result = await outcome
+  assert.deepEqual([result.kind, result.step], ['failed', 'push'])
+  assert.deepEqual(target.calls, [])
+  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'worktree.load'])
+  assert.ok(steps.some(([s, st]) => s === 'push' && st === 'failed'))
+})
+
+test('an unloaded worktree is not loaded afterwards, and cancelling stops before the target', async () => {
+  const source = fake({ 'move.export': EXPORT })
+  const target = fake({})
+  let n = 0
+  const { outcome } = run(source, target, { loaded: false, cancelled: () => ++n > 3 })
+  const result = await outcome
+  assert.equal(result.kind, 'failed')
+  assert.equal(result.error, 'Cancelled')
+  assert.deepEqual(target.calls, [])
+  assert.ok(!source.methods().includes('worktree.unload'))
+  assert.ok(!source.methods().includes('worktree.load'))
+})
+
+test('a refused receive restores the source; a lost answer says the target may have it', async () => {
+  const refused = fake({ 'move.export': EXPORT })
+  const r1 = await run(refused, fake({ 'move.receive': new ClientError('CONFLICT', 'checked out elsewhere') })).outcome
+  assert.deepEqual([r1.kind, r1.step], ['failed', 'receive'])
+  assert.equal(refused.methods().at(-1), 'worktree.load')
+  const lost = fake({ 'move.export': EXPORT })
+  const r2 = await run(lost, fake({ 'move.receive': new ClientError('NOT_CONNECTED', 'gone') })).outcome
+  assert.equal(r2.kind, 'unknown')
+  assert.match(r2.error, /may have created/)
+  assert.ok(!lost.methods().includes('move.finish'))
+})
+
+test('a source changed after the copy: the target copy is removed again', async () => {
+  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('CONFLICT', 'it changed') })
+  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const result = await run(source, target).outcome
+  assert.deepEqual([result.kind, result.step], ['failed', 'finish'])
+  assert.deepEqual(target.calls[1], ['worktree.remove', { projectId: 'pb', worktreeId: 'wb', force: true }])
+  assert.equal(source.methods().at(-1), 'worktree.load')
+})
+
+test('a finish that fails otherwise leaves both copies and says so', async () => {
+  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('GIT_ERROR', 'busy') })
+  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const result = await run(source, target).outcome
+  assert.equal(result.kind, 'both')
+  assert.equal(result.worktreeId, 'wb')
+  assert.equal(target.calls.length, 1)
+})
+
+test('move targets: the other entries with a token whose server takes a move', () => {
+  const link = (id, over = {}) => ({ id, name: id, url: '', hasToken: true, status: 'connected', message: '', ...over })
+  const servers = [link('own'), link('b', { capabilities: ['move'] }), link('old', { capabilities: ['review'] }), link('notoken', { hasToken: false }), link('down')]
+  assert.deepEqual(moveTargets(servers, 'own').map((s) => s.id), ['b', 'down'])
+  assert.deepEqual(moveTargets([link('web')], 'web'), [], 'the web client has only its own server')
+  assert.deepEqual(moveTargets(null, 'own'), [])
+})
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index 6f75b44..db8968d 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -108,6 +108,8 @@ export interface WindowBackend {
     remove(info: GitWorktreeInfo, instance: WorktreeInstance | undefined): Promise<void>
     /** The sidebar's worktree order, as the store's `worktreeKey`s */
     setOrder(keys: string[]): Promise<void>
+    /** The v2 worktree at this path, for a move to another server (feature `moveWorktree`); null if it isn't one */
+    moveRef(path: string): { projectId: string; worktreeId: string } | null
   }
   readonly git: {
     listWorktrees(repoId: string): Promise<GitWorktreeInfo[]>
@@ -272,7 +274,7 @@ export const idleBackend: WindowBackend = {
     seen: noProject,
     dismissDecision: noProject
   },
-  worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject },
+  worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject, moveRef: () => null },
   git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, commits: noProject, pull: noProject, push: noProject, dirty: noProject },
   docker: { list: noProject, container: noProject, compose: noProject, onLog: () => () => {} },
   env: {
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index f8d2a31..d93cd5b 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -44,8 +44,9 @@ export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map
 /**
  * A server window (3c-2, 4c, 5a). The ceiling: the v2 backend's features are
  * these AND what `v2Features` asks of the server's welcome and the window's entry.
- * - Off: the bot (phase 5) and the git flows protocol v2 has no command for
- *   (moving a worktree, promote).
+ * - Off: the bot (phase 5) and promote, which protocol v2 has no command for.
+ * - Moving a worktree to another server (5d) needs `move` on this server (the target's is
+ *   checked when it is picked).
  * - Settings are edited on the server (every v2 server has
  *   project.updateSettings, so no capability), with the sections
  *   `settingsSections` picks.
@@ -72,7 +73,7 @@ export const V2_FEATURES: BackendFeatures = {
   skills: true,
   prWatch: true,
   review: true,
-  moveWorktree: false,
+  moveWorktree: true,
   reveal: true,
   openInEditor: true,
   promote: false,
@@ -96,7 +97,8 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   voice: 'voice',
   skills: 'skills',
   prWatch: 'prWatch',
-  review: 'review'
+  review: 'review',
+  moveWorktree: 'move'
 }
 
 /**
diff --git a/src/renderer/src/components/MoveWorktreeModal.tsx b/src/renderer/src/components/MoveWorktreeModal.tsx
new file mode 100644
index 0000000..81135c5
--- /dev/null
+++ b/src/renderer/src/components/MoveWorktreeModal.tsx
@@ -0,0 +1,267 @@
+// "Move to another server…" (phase 5d): pick one of the app's other servers and a place there (a
+// project's repository with the same origin), see what moves and what doesn't, then run the move
+// (v2/moveFlow.ts) step by step. The source is this window's server; the target is reached through
+// the same main-process relay as every server window, so no token is in this window.
+import { useEffect, useMemo, useRef, useState } from 'react'
+import { useAppStore } from '../store'
+import { errorText } from '../v2/errors'
+import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
+import { MOVE_STEPS, moveWorktree, type MoveOutcome, type MoveStepKey, type MoveStepStatus, type Requester } from '../v2/moveFlow'
+import { CAPABILITY } from '../../../shared/protocolV2'
+import type { MoveCandidate, MovePlan } from '../../../shared/move'
+import { useAppServerLinks } from '../useAppServerLinks'
+import { moveTargets } from '../v2/moveFlow'
+import type { RegisteredServer } from '../../../shared/client/index'
+
+interface Props {
+  /** The worktree on this window's server */
+  from: { projectId: string; worktreeId: string }
+  name: string
+  onClose: () => void
+}
+
+const GLYPHS: Record<MoveStepStatus, string> = { pending: '○', active: '◐', done: '✓', skipped: '–', failed: '✗' }
+
+type TargetState =
+  | { kind: 'idle' }
+  | { kind: 'connecting' }
+  | { kind: 'error'; message: string }
+  | { kind: 'ready'; candidates: MoveCandidate[] }
+
+const requester = (server: RegisteredServer): Requester => (method, params, options) => server.connection.request(method, params, options)
+
+/** Resolves once the entry's connection is up with a welcome; rejects after `ms`. */
+function connected(server: RegisteredServer, ms = 15_000): Promise<string[]> {
+  const ready = (): string[] | null => (server.connection.status === 'connected' && server.connection.welcome ? server.connection.welcome.capabilities : null)
+  const now = ready()
+  if (now) return Promise.resolve(now)
+  return new Promise((resolve, reject) => {
+    const timer = setTimeout(() => {
+      off()
+      reject(new Error('The server did not answer'))
+    }, ms)
+    const off = server.connection.on('status', () => {
+      const caps = ready()
+      if (caps) {
+        clearTimeout(timer)
+        off()
+        resolve(caps)
+      }
+    })
+  })
+}
+
+export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Element {
+  const serverWindow = useAppStore((s) => s.serverWindow)
+  const ownEntry = serverWindow?.serverEntryId ?? ''
+  const [plan, setPlan] = useState<MovePlan | null>(null)
+  const [planError, setPlanError] = useState<string | null>(null)
+  const links = useAppServerLinks()
+  const servers = moveTargets(links.servers, ownEntry)
+  const [entryId, setEntryId] = useState('')
+  const [target, setTarget] = useState<TargetState>({ kind: 'idle' })
+  const [pick, setPick] = useState<string>('')
+  const [phase, setPhase] = useState<'choose' | 'running' | 'done'>('choose')
+  const [steps, setSteps] = useState<Partial<Record<MoveStepKey, { status: MoveStepStatus; detail?: string }>>>({})
+  const [outcome, setOutcome] = useState<MoveOutcome | null>(null)
+  const cancelled = useRef(false)
+  const [cancelling, setCancelling] = useState(false)
+  const opened = useRef(new Set<string>())
+
+  const source = useMemo(() => (ownEntry ? registeredServerEntry(ownEntry) : undefined), [ownEntry])
+
+  useEffect(() => {
+    if (!source) return
+    source.connection
+      .request('move.prepare', { projectId: from.projectId, worktreeId: from.worktreeId })
+      .then(setPlan, (err: unknown) => setPlanError(errorText(err)))
+  }, [source, from.projectId, from.worktreeId])
+
+  // Connections opened only for this dialog are closed with it.
+  useEffect(() => () => {
+    for (const id of opened.current) dropServerEntry(id)
+  }, [])
+
+  useEffect(() => {
+    if (!entryId || !plan) return
+    let live = true
+    setTarget({ kind: 'connecting' })
+    setPick('')
+    if (!registeredServerEntry(entryId)) opened.current.add(entryId)
+    const server = connectServerEntry(entryId)
+    void (async () => {
+      try {
+        const caps = await connected(server)
+        if (server.connection.welcome?.serverId && server.connection.welcome.serverId === source?.connection.welcome?.serverId) {
+          throw new Error('That is this window’s own server')
+        }
+        if (!caps.includes(CAPABILITY.move)) throw new Error('That server is too old to take a worktree: update it first')
+        if (!plan.origin) throw new Error(`${plan.repoName} has no origin remote here, so the branch can't travel`)
+        const candidates = await server.connection.request('move.candidates', { origin: plan.origin, branch: plan.branch })
+        if (live) {
+          setTarget({ kind: 'ready', candidates })
+          const first = candidates.find((c) => !c.blocked)
+          if (first) setPick(`${first.projectId} ${first.repoId}`)
+        }
+      } catch (err) {
+        if (live) setTarget({ kind: 'error', message: errorText(err) })
+      }
+    })()
+    return () => {
+      live = false
+    }
+  }, [entryId, plan, source])
+
+  const chosen = target.kind === 'ready' ? target.candidates.find((c) => `${c.projectId} ${c.repoId}` === pick && !c.blocked) : undefined
+  const targetName = servers.find((s) => s.id === entryId)?.name ?? 'the server'
+
+  const start = async (): Promise<void> => {
+    if (!source || !chosen || !plan) return
+    const server = registeredServerEntry(entryId)
+    if (!server) return
+    setPhase('running')
+    const result = await moveWorktree({
+      source: requester(source),
+      target: requester(server),
+      from,
+      to: { projectId: chosen.projectId, repoId: chosen.repoId },
+      loaded: plan.loaded,
+      progress: (step, status, detail) => setSteps((prev) => ({ ...prev, [step]: { status, detail } })),
+      cancelled: () => cancelled.current
+    })
+    setOutcome(result)
+    setPhase('done')
+  }
+
+  const openTarget = (): void => {
+    if (!chosen) return
+    void window.api.openServerProject(entryId, chosen.projectId, chosen.projectName, targetName)
+    onClose()
+  }
+
+  const carried = plan?.sessions.filter((s) => s.carried) ?? []
+  const left = plan?.sessions.filter((s) => !s.carried) ?? []
+
+  return (
+    <div className="modal-backdrop" onMouseDown={() => phase !== 'running' && onClose()}>
+      <div className="modal move-modal" onMouseDown={(e) => e.stopPropagation()}>
+        <h2>Move “{name}” to another server</h2>
+        {planError && <div className="server-test-result fail">{planError}</div>}
+        {phase === 'choose' && plan && (
+          <>
+            <p className="muted">
+              The branch is pushed to origin and checked out on the other server, the uncommitted work goes with it as a patch
+              (all of it unstaged), and its Claude sessions' histories are copied so they resume there. This worktree is removed
+              only once the new one is in place, and only if nothing changed here meanwhile.
+            </p>
+            {servers.length === 0 ? (
+              <div className="server-test-result fail">There is no other server in this app to move it to. Add one under Servers first.</div>
+            ) : (
+              <label className="move-row">
+                <span>Server</span>
+                <select value={entryId} onChange={(e) => setEntryId(e.target.value)}>
+                  <option value="">Choose a server…</option>
+                  {servers.map((s) => (
+                    <option key={s.id} value={s.id}>
+                      {s.name}
+                    </option>
+                  ))}
+                </select>
+              </label>
+            )}
+            {target.kind === 'connecting' && <p className="muted">Connecting…</p>}
+            {target.kind === 'error' && <div className="server-test-result fail">{target.message}</div>}
+            {target.kind === 'ready' && target.candidates.length === 0 && (
+              <div className="server-test-result fail">
+                No project on {targetName} has a clone of {plan.repoName} (the same origin). Add the repository to a project there first.
+              </div>
+            )}
+            {target.kind === 'ready' && target.candidates.length > 0 && (
+              <label className="move-row">
+                <span>Into</span>
+                <select value={pick} onChange={(e) => setPick(e.target.value)}>
+                  {target.candidates.map((c) => (
+                    <option key={`${c.projectId} ${c.repoId}`} value={`${c.projectId} ${c.repoId}`} disabled={!!c.blocked}>
+                      {c.projectName} — {c.repoName}
+                      {c.blocked ? ` (${c.blocked})` : ''}
+                    </option>
+                  ))}
+                </select>
+              </label>
+            )}
+            {chosen && <p className="muted move-path">New worktree: {chosen.path}</p>}
+            <ul className="move-summary">
+              <li>{carried.length === 0 ? 'No session history moves.' : `${carried.length} Claude session(s) move and can resume there.`}</li>
+              {left.map((s, i) => (
+                <li key={i} className="warn">
+                  “{s.title}” is not moved: {s.reason}.
+                </li>
+              ))}
+              {plan.reviewComments > 0 && <li className="warn">The {plan.reviewComments} unsent review comment(s) are not moved and are lost.</li>}
+              {plan.queuedPrompts > 0 && <li className="warn">The {plan.queuedPrompts} queued prompt(s) are not moved and are lost.</li>}
+              {plan.loaded && <li>Its running sessions are stopped first.</li>}
+              <li>The note, tags, ticket and pull request link go with it{plan.prWatch ? ', and the PR watch moves there' : ''}.</li>
+            </ul>
+          </>
+        )}
+        {phase !== 'choose' && (
+          <ul className="move-steps">
+            {MOVE_STEPS.map(({ key, label }) => {
+              const step = steps[key] ?? { status: 'pending' as MoveStepStatus }
+              return (
+                <li key={key} className={`move-step ${step.status}`}>
+                  <span className="move-step-glyph">{GLYPHS[step.status]}</span>
+                  <span className="move-step-label">{label}</span>
+                  {step.detail && <div className="move-step-detail">{step.detail}</div>}
+                </li>
+              )
+            })}
+          </ul>
+        )}
+        {outcome?.kind === 'moved' && (
+          <div className="server-test-result ok">
+            Moved to {targetName}.{outcome.notes.length > 0 && <ul>{outcome.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
+          </div>
+        )}
+        {outcome?.kind === 'failed' && (
+          <div className="server-test-result fail">
+            {outcome.error === 'Cancelled' ? 'Cancelled.' : `The move failed: ${outcome.error}`} Nothing changed on {targetName}, and this worktree is as it
+            was.
+          </div>
+        )}
+        {(outcome?.kind === 'both' || outcome?.kind === 'unknown') && <div className="server-test-result fail">{outcome.error}</div>}
+        <div className="modal-footer">
+          {phase === 'choose' && (
+            <>
+              <button onClick={onClose}>Cancel</button>
+              <button className="btn btn-accent" disabled={!chosen} onClick={() => void start()}>
+                Move worktree
+              </button>
+            </>
+          )}
+          {phase === 'running' && (
+            <button
+              onClick={() => {
+                cancelled.current = true
+                setCancelling(true)
+              }}
+              disabled={cancelling}
+            >
+              {cancelling ? 'Cancelling…' : 'Cancel'}
+            </button>
+          )}
+          {phase === 'done' && (
+            <>
+              {(outcome?.kind === 'moved' || outcome?.kind === 'both') && (
+                <button className="btn btn-accent" onClick={openTarget}>
+                  Open on {targetName}
+                </button>
+              )}
+              <button onClick={onClose}>Close</button>
+            </>
+          )}
+        </div>
+      </div>
+    </div>
+  )
+}
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index a8a1a6b..38c94d9 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -36,6 +36,9 @@ import { SettingsPanel } from './SettingsPanel'
 import { TerminalPane } from './TerminalPane'
 import { TicketModal } from './TicketModal'
 import { PullRequestModal } from './PullRequestModal'
+import { MoveWorktreeModal } from './MoveWorktreeModal'
+import { useAppServerLinks } from '../useAppServerLinks'
+import { moveTargets } from '../v2/moveFlow'
 import { envRepoKey } from '../../../shared/environments'
 import { getProvider } from '../../../shared/providers/registry'
 import { describeLlm } from '../../../shared/providers/selection'
@@ -120,6 +123,9 @@ export function WorktreeDetail({
   const [syncBusy, setSyncBusy] = useState<'pull' | 'push' | null>(null)
   const [showTicket, setShowTicket] = useState(false)
   const [showPR, setShowPR] = useState(false)
+  const [showMove, setShowMove] = useState(false)
+  const appServers = useAppServerLinks()
+  const ownEntry = useAppStore((s) => s.serverWindow?.serverEntryId ?? '')
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
   /** The title the rename started from: a server window refuses it if the title changed meanwhile */
@@ -130,6 +136,7 @@ export function WorktreeDetail({
   const envBusy = useAppStore((s) => s.envBusy)
 
   const features = useFeatures()
+  const canMove = features.moveWorktree && moveTargets(appServers.servers, ownEntry).length > 0
   const path = info?.path
   // The stack runs on the server's machine (`features.stacks`, any server that has `stacks`).
   const [stack, refreshStack] = useStackStatus(path, !features.stacks)
@@ -620,7 +627,20 @@ export function WorktreeDetail({
               </>
             )}
             <div className="detail-menu-divider" />
-            {/* Promote and Move to another server come back with phase 5's server commands. */}
+            {/* Promote comes back with a server command of its own. */}
+            {canMove && !info.isMain && info.branch && getBackend().worktrees.moveRef(info.path) && (
+              <div
+                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
+                onClick={() => {
+                  if (busy || offline) return
+                  setMenuOpen(false)
+                  setShowMove(true)
+                }}
+              >
+                <div className="detail-menu-name">Move to another server…</div>
+                <div className="detail-menu-desc">Push the branch and carry the uncommitted work and Claude sessions to a clone on another server</div>
+              </div>
+            )}
             {!info.isMain && (
               <div
                 className={`detail-menu-item danger ${busy || offline ? 'disabled' : ''}`}
@@ -894,6 +914,10 @@ export function WorktreeDetail({
       {showPR && info.branch && (
         <PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} />
       )}
+      {showMove && info.branch && (() => {
+        const from = getBackend().worktrees.moveRef(info.path)
+        return from ? <MoveWorktreeModal from={from} name={info.branch} onClose={() => setShowMove(false)} /> : null
+      })()}
     </main>
   )
 }
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 81067e1..02e5dbb 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -3295,6 +3295,42 @@ button:disabled {
   max-width: 520px;
 }
 
+.move-row {
+  display: flex;
+  align-items: center;
+  gap: 10px;
+  margin: 10px 0;
+  font-size: 12.5px;
+}
+
+.move-row > span {
+  width: 52px;
+  color: var(--text-muted);
+}
+
+.move-row select {
+  flex: 1;
+}
+
+.move-path {
+  font-family: var(--mono);
+  font-size: 11px;
+  user-select: text;
+}
+
+.move-summary {
+  margin: 12px 0;
+  padding-left: 18px;
+  font-size: 12px;
+  display: flex;
+  flex-direction: column;
+  gap: 4px;
+}
+
+.move-summary .warn {
+  color: #f9e2af;
+}
+
 .move-steps {
   list-style: none;
   margin: 14px 0;
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 8b05f31..8b308f5 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -457,6 +457,11 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
           await fail(forceErr)
         }
       },
+      moveRef: (path) => {
+        const legacyId = legacyIdAt(path)
+        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
+        return ref ? { projectId, worktreeId: ref.worktreeId } : null
+      },
       // The one settings write a server window makes (settings are read-only in v2).
       // No keys clears the order; keys none of which map (a stale drag) send nothing.
       setOrder: async (keys) => {
diff --git a/src/renderer/src/v2/moveFlow.ts b/src/renderer/src/v2/moveFlow.ts
new file mode 100644
index 0000000..cc80a37
--- /dev/null
+++ b/src/renderer/src/v2/moveFlow.ts
@@ -0,0 +1,134 @@
+// Moving a worktree to another server (phase 5d): the app relays between the two servers'
+// connections. Every step is a `move.*` (or `worktree.*`) request; the target builds the worktree
+// in one `move.receive`, which undoes itself on failure, and the source removes its copy last, in
+// `move.finish`, only if it is unchanged since `move.export`. Pure: the requests come in as deps,
+// so `node --test` covers it.
+import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../../../shared/protocolV2'
+import { errorCode, errorText } from './errors.ts'
+import type { AppServerLink } from '../../../shared/types'
+
+export type Requester = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options?: { timeoutMs?: number }) => Promise<MethodResultsV2[M]>
+
+export const MOVE_STEPS = [
+  { key: 'unload', label: 'Stop the sessions on the source' },
+  { key: 'export', label: 'Read the uncommitted work and the session histories' },
+  { key: 'push', label: 'Push the branch to origin' },
+  { key: 'receive', label: 'Create the worktree on the target' },
+  { key: 'finish', label: 'Remove the source worktree' }
+] as const
+
+export type MoveStepKey = (typeof MOVE_STEPS)[number]['key']
+export type MoveStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'
+
+/** Each step's time limit: a fetch or a large patch can take longer than the SDK's minute. */
+const STEP_MS = 5 * 60_000
+
+export interface MoveFlowDeps {
+  source: Requester
+  target: Requester
+  /** The worktree on the source */
+  from: { projectId: string; worktreeId: string }
+  /** Where it goes on the target */
+  to: { projectId: string; repoId: string }
+  /** Its sessions are running: they are stopped first, and started again if the move fails */
+  loaded: boolean
+  progress(step: MoveStepKey, status: MoveStepStatus, detail?: string): void
+  /** Checked between steps, until the target starts building */
+  cancelled(): boolean
+}
+
+export type MoveOutcome =
+  /** Moved: the target has it, the source's copy is gone */
+  | { kind: 'moved'; worktreeId: string; notes: string[] }
+  /** Nothing changed on either server (the source's sessions are started again if they ran) */
+  | { kind: 'failed'; step: MoveStepKey; error: string }
+  /** The target has it, but the source's copy could not be removed: both exist */
+  | { kind: 'both'; worktreeId: string; error: string; notes: string[] }
+  /** The target may or may not have built it: the connection dropped while it worked */
+  | { kind: 'unknown'; error: string }
+
+class Cancelled extends Error {}
+
+export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
+  const { source, target, from, to } = deps
+  let step: MoveStepKey = 'unload'
+  const begin = (next: MoveStepKey): void => {
+    if (deps.cancelled()) throw new Cancelled('Cancelled')
+    step = next
+    deps.progress(next, 'active')
+  }
+  let unloaded = false
+  const restore = async (): Promise<void> => {
+    if (unloaded) await source('worktree.load', from).catch(() => {})
+  }
+  let exported: MethodResultsV2['move.export']
+  try {
+    begin('unload')
+    if (deps.loaded) {
+      await source('worktree.unload', from)
+      unloaded = true
+      deps.progress('unload', 'done')
+    } else deps.progress('unload', 'skipped', 'no sessions running')
+
+    begin('export')
+    exported = await source('move.export', from, { timeoutMs: STEP_MS })
+    const carried = exported.sessions.length
+    deps.progress('export', 'done', `${exported.patch ? 'uncommitted work' : 'no uncommitted work'}, ${carried} session histor${carried === 1 ? 'y' : 'ies'}`)
+
+    begin('push')
+    await source('worktree.push', { ...from, setUpstream: true }, { timeoutMs: STEP_MS })
+    deps.progress('push', 'done')
+    begin('receive')
+  } catch (err) {
+    if (!(err instanceof Cancelled)) deps.progress(step, 'failed', errorText(err))
+    await restore()
+    return { kind: 'failed', step, error: err instanceof Cancelled ? 'Cancelled' : errorText(err) }
+  }
+
+  // From here on there is no cancelling: the target is building it.
+  let received: MethodResultsV2['move.receive']
+  try {
+    const { branch, head, patch, sessions, branchData } = exported
+    received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData }, { timeoutMs: STEP_MS })
+  } catch (err) {
+    deps.progress('receive', 'failed', errorText(err))
+    // A refusal undid itself on the target. A lost answer may not have.
+    if (errorCode(err) === 'NOT_CONNECTED' || errorCode(err) === 'TIMEOUT') {
+      return { kind: 'unknown', error: `${errorText(err)}. The target may have created the worktree: check it before trying again. The source was not changed.` }
+    }
+    await restore()
+    return { kind: 'failed', step: 'receive', error: errorText(err) }
+  }
+  const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...received.dropped]
+  deps.progress('receive', 'done', received.dropped.length > 0 ? `${received.dropped.length} thing(s) not carried over` : undefined)
+
+  deps.progress('finish', 'active')
+  try {
+    await source('move.finish', { ...from, fingerprint: exported.fingerprint }, { timeoutMs: STEP_MS })
+    deps.progress('finish', 'done')
+    return { kind: 'moved', worktreeId: received.worktreeId, notes }
+  } catch (err) {
+    const code = errorCode(err)
+    // The source changed (or was loaded) after the copy: the copy on the target is stale, so it goes.
+    if (code === 'CONFLICT' || code === 'IN_USE') {
+      const undone = await target('worktree.remove', { projectId: to.projectId, worktreeId: received.worktreeId, force: true }).then(() => true, () => false)
+      deps.progress('finish', 'failed', errorText(err))
+      if (undone) {
+        await restore()
+        return { kind: 'failed', step: 'finish', error: `${errorText(err)}. The copy on the target was removed again (its branch stays there).` }
+      }
+      return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, and the copy on the target could not be removed: both servers have it now.`, notes }
+    }
+    deps.progress('finish', 'failed', errorText(err))
+    return { kind: 'both', worktreeId: received.worktreeId, error: `The target has the worktree, but the source's copy was not removed (${errorText(err)}). Delete it there once you have checked the target.`, notes }
+  }
+}
+
+/**
+ * The app's other servers a worktree can move to: every entry but this window's own with a token
+ * (main connects only with one). Main's own connection's welcome, when it has one, rules out a
+ * server too old for `move`. The web client lists only its own server, so it never offers a move.
+ */
+export function moveTargets(servers: readonly AppServerLink[] | null, ownEntryId: string): AppServerLink[] {
+  return (servers ?? []).filter((s) => s.id !== ownEntryId && s.hasToken && (s.capabilities === undefined || s.capabilities.includes('move')))
+}
````

</details>


## Task 3: smoke:server-move

**Prototype commit:** `cd66434` on `central-server-phase5d-proto`.

**Files:**

- Modify: `package.json`
- Create: `scripts/server-move-smoke.mjs`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
npm run smoke:server-move   # SERVER MOVE SMOKE PASS (23 checks at this task)
pgrep -fl 'trek-server.cjs|sleep 300'   # nothing of the run
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(5d): smoke:server-move: two trek-servers, one bare origin, a worktree moved from a window" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/package.json b/package.json
index 52295b1..242fea0 100644
--- a/package.json
+++ b/package.json
@@ -27,6 +27,7 @@
     "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
     "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
     "smoke:server-review": "npm run build && node scripts/server-review-smoke.mjs",
+    "smoke:server-move": "npm run build && node scripts/server-move-smoke.mjs",
     "smoke:server-web": "npm run build && node scripts/server-web-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
diff --git a/scripts/server-move-smoke.mjs b/scripts/server-move-smoke.mjs
new file mode 100644
index 0000000..6ff2418
--- /dev/null
+++ b/scripts/server-move-smoke.mjs
@@ -0,0 +1,327 @@
+// scripts/server-move-smoke.mjs — moving a worktree between two servers (phase 5d), from a window.
+//
+// Run: npm run smoke:server-move   (builds the app and the server, then runs this script)
+//
+// Two plain `trek-server start`s (A and B), each with its own HOME, config, token and data dir,
+// and the not-signed-in stub gh every smoke gets (smokeGh.mjs). A bare repository in the temp dir
+// is both clones' origin. A has a project with a worktree (a commit, staged, modified and untracked
+// work, a running Claude session with a saved history, a note and a tag); B has a project on its
+// own clone. The built app runs with a temp HOME and --user-data-dir, no Local server, main's
+// dialogs stubbed, both servers saved; A's project window moves the worktree. It checks:
+//   - both welcomes list move; the window offers Move to another server… (B is saved);
+//   - the dialog lists B's project (same origin), the new path, the session that moves and the
+//     queued prompt that doesn't; a branch already checked out on B is a blocked place;
+//   - the move: the steps all done; origin has the branch; B has the worktree at the default path
+//     on the same commit with the uncommitted work (unstaged), the Claude session saved (not
+//     running) with its history under the new path in B's HOME, the note and the tag (by name);
+//   - A's worktree is gone from disk, its project and its window; A's history file is kept;
+//   - Open on B opens B's project window, which lists the moved worktree;
+//   - the renderer never holds either token; no error dialogs, console or page errors.
+//
+// Prints SERVER MOVE SMOKE PASS (n checks) or SERVER MOVE SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
+import { closeApp, killIfOurs } from './smokeTeardown.mjs'
+
+const WATCHDOG_MS = 180_000
+const DAEMON_READY_MS = 15_000
+
+const checks = []
+const failedChecks = []
+const check = (name, actual, expected) => {
+  const ok = JSON.stringify(actual) === JSON.stringify(expected)
+  checks.push(ok)
+  if (!ok) failedChecks.push(name)
+  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
+}
+const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
+const until = async (fn, expected, ms = 15_000) => {
+  const deadline = Date.now() + ms
+  let value = await fn()
+  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
+    await sleep(200)
+    value = await fn()
+  }
+  return value
+}
+
+// ---- Fixtures --------------------------------------------------------------
+
+const root = new URL('..', import.meta.url).pathname
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-smoke-')))
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+for (const dir of [appHome, userData]) mkdirSync(dir, { recursive: true })
+const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
+const claudeDir = (home, cwd) => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
+
+const origin = join(work, 'origin.git')
+git('init', '-q', '--bare', origin)
+const fakeAgent = join(work, 'fake-agent.sh')
+const agentPids = join(work, 'agent-pids')
+writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
+
+/** One server's files: its HOME (with its clone), config, token and data dir. */
+function serverFiles(name) {
+  const home = join(work, `${name}-home`)
+  const data = join(work, `${name}-data`)
+  mkdirSync(home, { recursive: true })
+  mkdirSync(data, { recursive: true })
+  const repo = join(home, 'repos', 'app')
+  const token = randomBytes(16).toString('base64url')
+  const configPath = join(work, `${name}-config.json`)
+  return { name, home, data, repo, token, configPath }
+}
+const A = serverFiles('a')
+const B = serverFiles('b')
+git('init', '-q', '-b', 'main', A.repo)
+writeFileSync(join(A.repo, 'README'), 'one\n')
+git('-C', A.repo, 'add', '.')
+git('-C', A.repo, 'commit', '-q', '-m', 'init')
+git('-C', A.repo, 'remote', 'add', 'origin', origin)
+git('-C', A.repo, 'push', '-q', 'origin', 'main')
+git('clone', '-q', origin, B.repo)
+for (const s of [A, B]) {
+  const tokenHash = createHash('sha256').update(s.token, 'utf8').digest('hex')
+  writeFileSync(s.configPath, JSON.stringify({ name: `Server ${s.name.toUpperCase()}`, tokenHash, repos: [{ id: 'app', name: 'app', path: s.repo }], llm: { providers: { claude: { command: fakeAgent } } } }))
+}
+const sourcePath = `${A.repo}-feature-x`
+const targetPath = `${B.repo}-feature-x`
+
+const mainStub = join(work, 'main-stub.cjs')
+writeFileSync(
+  mainStub,
+  `const { dialog } = require('electron')
+globalThis.__dialogs = []
+dialog.showMessageBox = async (...args) => {
+  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
+  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message })
+  return { response: 0, checkboxChecked: false }
+}
+`
+)
+
+const freePort = () =>
+  new Promise((resolve, reject) => {
+    const s = createServer()
+    s.once('error', reject)
+    s.listen(0, '127.0.0.1', () => {
+      const { port } = s.address()
+      s.close(() => resolve(port))
+    })
+  })
+
+const daemons = []
+let app = null
+const sdks = []
+const pageErrors = []
+const watch = (page) => {
+  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
+  page.on('console', (m) => {
+    if (m.type() === 'error') pageErrors.push(m.text())
+  })
+}
+
+let exitCode = 1
+let finished = false
+const finish = async (reason) => {
+  if (finished) return
+  finished = true
+  if (reason) console.error(reason)
+  for (const sdk of sdks) sdk.close()
+  await closeApp(app)
+  for (const daemon of daemons) {
+    if (daemon.exitCode === null && daemon.signalCode === null) {
+      daemon.kill()
+      await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
+    }
+  }
+  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
+  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
+  for (const s of [A, B]) spawnSync('git', ['-C', s.repo, 'worktree', 'prune'])
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(exitCode === 0 ? `SERVER MOVE SMOKE PASS (${checks.length} checks)` : `SERVER MOVE SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+/** Starts one server; resolves its ws URL and an SDK connection to it. */
+async function start(s) {
+  const port = await freePort()
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', s.configPath, '--port', String(port), '--data-dir', s.data], {
+      cwd: join(root, 'server'),
+      env: { ...process.env, HOME: s.home, XDG_STATE_HOME: join(s.home, '.local', 'state'), SHELL: '/bin/sh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
+      stdio: ['ignore', 'pipe', 'pipe']
+    })
+    daemons.push(d)
+    let output = ''
+    const timer = setTimeout(() => reject(new Error(`trek-server ${s.name} did not start:\n${output}`)), DAEMON_READY_MS)
+    d.stdout.on('data', (b) => {
+      output += b
+      if (/listening on ws:\/\//.test(output)) {
+        clearTimeout(timer)
+        resolve()
+      }
+    })
+    d.stderr.on('data', (b) => {
+      output += b
+      process.stderr.write(b)
+    })
+    d.once('exit', (code) => reject(new Error(`trek-server ${s.name} exited (${code}):\n${output}`)))
+  })
+  const url = `ws://127.0.0.1:${port}`
+  const sdk = new ServerConnection({ url, token: s.token, createSocket: globalSocketFactory, client: 'server-move-smoke' })
+  sdks.push(sdk)
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  const project = async (projectId) => {
+    const topic = `project:${projectId}`
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  return { url, sdk, project }
+}
+
+try {
+  // ---- 1. Two servers; on A a worktree with work in progress, a Claude session, a note and a tag ---
+
+  const a = await start(A)
+  const b = await start(B)
+  check('both welcomes list move', [a.sdk.welcome?.capabilities.includes('move'), b.sdk.welcome?.capabilities.includes('move')], [true, true])
+  const tags = { worktreeTags: [{ id: 'x', name: 'Review', color: '#5dabef' }] }
+  const { projectId: pa } = await a.sdk.request('project.create', { name: 'On A', repositories: [{ path: A.repo }] })
+  const { projectId: pb } = await b.sdk.request('project.create', { name: 'On B', repositories: [{ path: B.repo }] })
+  await a.sdk.request('project.updateSettings', { projectId: pa, settings: tags })
+  await b.sdk.request('project.updateSettings', { projectId: pb, settings: { worktreeTags: [{ id: 'other-id', name: 'Review', color: '#000000' }] } })
+  const repoA = (await a.project(pa)).repositories[0].id
+  const repoB = (await b.project(pb)).repositories[0].id
+  const { worktreeId } = await a.sdk.request('worktree.create', { projectId: pa, repoId: repoA, branch: 'feature-x', createBranch: true })
+  writeFileSync(join(sourcePath, 'feature.txt'), 'committed\n')
+  git('-C', sourcePath, 'add', '.')
+  git('-C', sourcePath, 'commit', '-q', '-m', 'feature')
+  const head = git('-C', sourcePath, 'rev-parse', 'HEAD').trim()
+  writeFileSync(join(sourcePath, 'README'), 'one\nedited\n')
+  writeFileSync(join(sourcePath, 'staged.txt'), 'staged\n')
+  git('-C', sourcePath, 'add', 'staged.txt')
+  writeFileSync(join(sourcePath, 'untracked.txt'), 'untracked\n')
+  const { sessionId } = await a.sdk.request('session.start', { projectId: pa, worktreeId, cols: 80, rows: 24, title: 'Claude moved' })
+  const history = '{"type":"user","message":"hello"}\n'
+  mkdirSync(claudeDir(A.home, sourcePath), { recursive: true })
+  writeFileSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`), history)
+  await a.sdk.request('session.enqueue', { projectId: pa, sessionId, text: 'a queued prompt' })
+  await a.sdk.request('branch.setNote', { projectId: pa, repoId: repoA, branch: 'feature-x', note: 'moved note' })
+  await a.sdk.request('branch.setTag', { projectId: pa, repoId: repoA, branch: 'feature-x', tag: 'x' })
+  // A second worktree whose branch B already has checked out: a blocked place.
+  await a.sdk.request('worktree.create', { projectId: pa, repoId: repoA, branch: 'feature-y', createBranch: true })
+  git('-C', `${A.repo}-feature-y`, 'push', '-q', 'origin', 'feature-y')
+  git('-C', B.repo, 'fetch', '-q', 'origin')
+  git('-C', B.repo, 'worktree', 'add', '-q', join(B.home, 'repos', 'elsewhere'), 'feature-y')
+
+  // ---- 2. The app, with both servers saved, and A's project window ---------------------------------
+
+  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
+  delete env.ELECTRON_RUN_AS_NODE
+  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
+  app.on('window', watch)
+  const win = await app.firstWindow()
+  watch(win)
+  await win.waitForLoadState('domcontentloaded')
+  const entryA = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Server A', url: u, token: t }), [a.url, A.token])
+  const entryB = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Server B', url: u, token: t }), [b.url, B.token])
+  const linkStatus = (id) => win.evaluate((x) => window.api.appServers.links().then((l) => l.servers.find((s) => s.id === x)?.status ?? null), id)
+  check("main's connections to both servers are up", [await until(() => linkStatus(entryA.id), 'connected'), await until(() => linkStatus(entryB.id), 'connected')], ['connected', 'connected'])
+  await win.evaluate(async ([id, pid]) => {
+    const { opened } = await window.api.openServerProject(id, pid, 'On A', 'Server A')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entryA.id, pa])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 3)
+  check("the window's moveWorktree feature follows the server's move", await until(() => win.evaluate(() => window.__features().moveWorktree), true), true)
+
+  // ---- 3. The dialog ---------------------------------------------------------------------------------
+
+  const detail = win.locator('.server-window .detail')
+  const openMove = async (branch) => {
+    await rows.filter({ hasText: branch }).click()
+    await detail.locator('.detail-path', { hasText: branch }).waitFor({ timeout: 10_000 })
+    await detail.locator('.btn-icon[title="Worktree actions"]').click()
+    const item = detail.locator('.detail-menu-item', { hasText: 'Move to another server…' })
+    await item.waitFor({ timeout: 10_000 })
+    await item.click()
+    const modal = win.locator('.move-modal')
+    await modal.waitFor({ timeout: 10_000 })
+    await modal.locator('.move-summary').waitFor({ timeout: 10_000 })
+    return modal
+  }
+  let modal = await openMove('feature-y')
+  await modal.locator('.move-row select').first().selectOption({ label: 'Server B' })
+  const into = modal.locator('.move-row select').nth(1)
+  await into.waitFor({ timeout: 10_000 })
+  check('a branch B has checked out is a blocked place, and Move stays disabled', [
+    await until(() => into.locator('option').first().getAttribute('disabled').then((v) => v !== null), true),
+    (await into.locator('option').first().textContent()).includes('already checked out'),
+    await modal.locator('button', { hasText: 'Move worktree' }).isDisabled()
+  ], [true, true, true])
+  await modal.locator('button', { hasText: 'Cancel' }).click()
+  await modal.waitFor({ state: 'detached', timeout: 5000 })
+
+  modal = await openMove('feature-x')
+  const summary = () => modal.locator('.move-summary li').allTextContents()
+  const lines = await until(async () => (await summary()).length >= 4, true).then(summary)
+  check('the dialog says what moves and what does not', [
+    lines.some((l) => l.includes('1 Claude session(s) move')),
+    lines.some((l) => l.includes('1 queued prompt(s) are not moved')),
+    lines.some((l) => l.includes('running sessions are stopped first'))
+  ], [true, true, true])
+  await modal.locator('.move-row select').first().selectOption({ label: 'Server B' })
+  check('B\'s project is offered, with the new path', await until(() => modal.locator('.move-path').textContent().catch(() => null), `New worktree: ${targetPath}`), `New worktree: ${targetPath}`)
+  check('the place is On B — app', (await modal.locator('.move-row select').nth(1).locator('option:checked').textContent()).trim(), 'On B — app')
+
+  // ---- 4. The move -------------------------------------------------------------------------------------
+
+  await modal.locator('button', { hasText: 'Move worktree' }).click()
+  check('the move reports success', await until(() => modal.locator('.server-test-result.ok').count(), 1, 60_000), 1)
+  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done'])
+  check('origin has the branch at the source commit', git('--git-dir', origin, 'rev-parse', 'refs/heads/feature-x').trim(), head)
+  check('B has the worktree on the same commit', existsSync(targetPath) && git('-C', targetPath, 'rev-parse', 'HEAD').trim(), head)
+  check('with the uncommitted work, all of it unstaged', git('-C', targetPath, 'status', '--porcelain').split('\n').filter(Boolean).sort(), [' M README', '?? staged.txt', '?? untracked.txt'])
+  const moved = (await b.project(pb)).repositories[0]
+  const row = moved.worktrees.find((w) => w.path === targetPath)
+  check("B's project lists it, unloaded, with the Claude session saved", [row?.loaded, row?.sessions.map((s) => [s.title, s.agentSessionId, s.queue.length])], [false, [['Claude moved', sessionId, 0]]])
+  check("the session's history is under the new path in B's HOME", readFileSync(join(claudeDir(B.home, targetPath), `${sessionId}.jsonl`), 'utf8'), history)
+  check('the note and the tag (B\'s id for the same name) came along', [moved.branchData['feature-x']?.note, moved.branchData['feature-x']?.tag], ['moved note', 'other-id'])
+  check("A's worktree is gone from disk and from A's project", [existsSync(sourcePath), (await a.project(pa)).repositories[0].worktrees.some((w) => w.id === worktreeId)], [false, false])
+  check("and from A's window", await until(() => rows.filter({ hasText: 'feature-x' }).count(), 0), 0)
+  check("A's copy of the history is kept (copied, not moved)", existsSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`)), true)
+
+  // ---- 5. Open on B ----------------------------------------------------------------------------------
+
+  const before = app.windows().length
+  await modal.locator('button', { hasText: 'Open on Server B' }).click()
+  check('Open on Server B opens another window', await until(() => app.windows().length, before + 1), before + 1)
+  const bWin = app.windows().find((w) => w !== win)
+  await bWin.waitForLoadState('domcontentloaded')
+  check("B's window lists the moved worktree", await until(() => bWin.locator('.server-window .wt-row', { hasText: 'feature-x' }).count(), 1, 20_000), 1)
+
+  const held = await Promise.all(app.windows().map((w) => w.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))))
+  check("no window's store or page holds either server's token", held.some((h) => h.includes(A.token) || h.includes(B.token)), false)
+  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
+  check('no console or page errors', pageErrors, [])
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
````

</details>


## Task 4: docs (and the spec's record of the answers)

**Prototype commits:** `776ecec` and `66c7cc8` on `central-server-phase5d-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-04-central-server-design.md`
- Modify: `server/README.md`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
grep -n "Moving a worktree between servers" PROTOCOL.md server/README.md
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(5d): PROTOCOL.md's move capability and methods; the READMEs; the spec's 5d bullet and the user's answers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index c08575d..3d4e65b 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -106,6 +106,7 @@ new optional field needs no capability: its absence says enough.
 | `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
 | `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked (`gh auth status --hostname github.com`) when the server starts, every 10 minutes after that whether it is listed or not, and when a poll fails with what looks like a sign-in error (HTTP 401, not logged in); a poll failing any other way (the network, GitHub, one unreadable PR) leaves it as it is. The Local server announces itself only once the first check has answered (at most 3 s), so the app's first welcome has it; a remote server takes connections at once, so a welcome sent before gh answered lacks it and the change is pushed. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
 | `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
+| `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export` and `move.finish` on the source, `move.candidates` and `move.receive` on the target |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -695,6 +696,56 @@ there). Like every queued prompt it is not sent on its own: the
 user sends it from the session's queue. An agent can read a worktree's draft with the MCP tool
 `get_review_comments` (read-only, with each comment's `outdated`); no tool writes one.
 
+## Moving a worktree between servers
+
+With the capability `move` (phase 5d) on both, a client can move a worktree from one server (the
+source) to another (the target). The servers never talk to each other: the client relays, over its
+two connections. The branch travels through `origin` (both clones need it, the same repository);
+the uncommitted work travels as one patch; a Claude session's history is copied so it resumes on
+the target. Only a worktree on a branch moves, never a repository's main checkout.
+
+The client's order, and what each step leaves behind when it fails:
+
+1. `move.prepare` on the source (read only) and `move.candidates` on the target: what moves, and where.
+2. `worktree.unload` on the source, if it is loaded (`move.export` refuses a loaded worktree, `IN_USE`).
+3. `move.export` on the source: changes nothing.
+4. `worktree.push` `{setUpstream: true}` on the source: the branch is on origin. A failure here, or
+   a cancel up to here, changes nothing but the push itself; the client loads the source again.
+5. `move.receive` on the target: builds the worktree, or undoes everything it did and fails.
+6. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
+   `CONFLICT` or `IN_USE` the client removes the target's copy again (`worktree.remove` `{force:
+   true}`; the branch it created there stays) and loads the source again.
+
+| Method | Params | Result |
+|---|---|---|
+| `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
+| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; `''` when clean; at most 8 MiB (else `BAD_REQUEST`). `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?}`, the tags by name. `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
+| `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
+| `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
+| `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData}` | `{worktreeId, dropped}`. See below |
+
+`move.receive`, in order: refuses (`CONFLICT`) a branch already checked out in the repository or a
+default path that exists; fetches `refs/heads/<branch>` from origin into `origin/<branch>` and
+refuses (`CONFLICT`) when it is not at `head`; creates the local branch tracking it (or
+fast-forwards an existing one that is behind `head`; `CONFLICT` when it has commits `head` lacks);
+checks it out at the default path (linking the repository's `linkedDirs`), checks `HEAD` is
+`head`, applies `patch` (`git apply --binary`: all of it unstaged, staged files included); writes each
+session's `history` to `~/.claude/projects/<the new path, encoded>/<agentSessionId>.jsonl` (mode
+0600) under the server user's HOME; and adds the worktree's row, unloaded, with one saved session
+per carried one (a new `id`, the same `agentSessionId`, `idle` or `complete`, an empty queue; its
+session type by name), and the branch data on top of what the project already has for the branch,
+the tags by name. A failure at any step undoes the ones before it (the worktree, the branch it
+created or moved, the history files it wrote) and answers the error. `dropped`: what did not come
+across, one line each (a tag or session type the project lacks, a PR watch on a server whose gh
+is not signed in). Limits: at most 50 sessions, only Claude ones (`agentSessionId` a session id), 6
+MiB of histories in all, an 8 MiB patch, the project's 500 sessions.
+
+What moves: the commits (through origin), the uncommitted work (unstaged), Claude sessions that
+have a saved history (copied, not moved: the source's file stays), the note, the workflow and custom
+tags (by name), the ticket, the pull request link and its watch. What does not: other agents'
+sessions (closed with the source), queued prompts, the review draft, a Docker environment or dev
+stack running for it on the source's machine, and the staged/unstaged split.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
diff --git a/README.md b/README.md
index eaea985..52df04c 100644
--- a/README.md
+++ b/README.md
@@ -224,11 +224,20 @@ other window on that project sees them live.
   service or dev stack is reached on: cookies are not port-scoped, so any other web
   server on that name (on loopback, any local web server the browser visits) sees
   the session cookie. See [trek-server's README](server/README.md#web-client).
+- **Move a worktree to another server**: **Move to another server…** in a worktree's
+  menu (in a window whose server has another server saved beside it in the app) picks
+  one of the app's other servers and a project there with a clone of the same
+  repository (the same origin). The branch is pushed to origin and checked out there,
+  the uncommitted work goes along as a patch (all of it unstaged), Claude sessions'
+  histories are copied so they resume there, and the note, tags, ticket, pull request
+  and its watch come too. Other agents' sessions, queued prompts and the review draft
+  do not. The old worktree is removed last, and only if nothing changed in it while it
+  was copied; a failure before that leaves it as it was. The web client never offers
+  it (it has one server).
 - **This machine's features, in Local windows only**: a window on the [Local
   server](#local-server) also has Open in VS Code and Reveal in Finder, since its
   paths are this machine's. A window on a remote server shows neither.
-- **Not yet**: promote to primary, moving worktrees between servers and the project
-  bot (phase 5).
+- **Not yet**: promote to primary and the project bot (phase 5).
 
 ## Importing a .trekproj
 
@@ -429,6 +438,9 @@ one at a time:
   source picker, line comments (one from another client, live; one outdated), an
   agent reading them with `get_review_comments`, edit and send conflicts, Send to
   session and Discard;
+- `npm run smoke:server-move`: a worktree moved between two servers from a window,
+  with a bare repository in a temp dir as both clones' origin: the dialog, the steps,
+  the target's worktree, work and Claude session, the source's removal;
 - `npm run smoke:server-web`: the web client: `trek-server start --web` driven from a
   bare browser window (no Trek main or preload): sign-in, the cookie, a project and its
   session's terminal, the Origin rule on sockets, sign-out, revocation and the
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 5fd9142..9e100f0 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -471,9 +471,18 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
        `src/shared/client/` over the browser's WebSocket; `packages/client` stays
        deferred), sessions are in memory (a restart signs browsers out), and with the web
        client on, a socket whose `Origin` is another site is refused.
-   - **Later, in their own plans:** the bot (ported last, only when asked), moving
-     worktrees between servers, promote to primary, and Windows support for the
-     supervisor.
+   - **5d, moving worktrees between servers:** client-relayed, behind a `move`
+     capability on both servers. User decisions (2026-11-10): the dialog lists the
+     target server's projects with a repository of the same origin, and the user picks
+     one; the commits travel by pushing through origin (the target checks its HEAD is
+     the source's); a real move: once the target's copy is in place the source's
+     worktree is removed, and any failure before that rolls the target back and leaves
+     the source as it was; Claude sessions' histories are copied (others are listed as
+     not carried), and the note, tags, ticket, PR link and PR watch go along, not the
+     review draft or queued prompts. Plan:
+     `docs/superpowers/plans/2026-11-10-central-server-phase5d-move-worktrees.md`.
+   - **Later, in their own plans:** the bot (ported last, only when asked), promote to
+     primary, and Windows support for the supervisor.
 6. **Next phase:** React Native client on `packages/client` and `src/shared/model`.
 
 Remote projects can be opened after phase 3. After phase 4 every project is on a server and
diff --git a/server/README.md b/server/README.md
index 6d11069..b2dbe03 100644
--- a/server/README.md
+++ b/server/README.md
@@ -203,6 +203,19 @@ prompt (100,000 characters). A worktree git no longer lists is kept, as missing,
 while it holds a draft. Agents can read a draft with the `get_review_comments`
 MCP tool, which never changes it. See PROTOCOL.md, "Changes tab review".
 
+## Moving a worktree between servers
+
+With the `move` capability on both servers, the app can move a worktree from one to another:
+**Move to another server…** in the worktree's menu. The app relays between the two servers (they
+never connect to each other, and no token reaches either window): the source pushes the branch to
+origin, the target's `move.receive` fetches and checks it out next to its clone of the same
+repository, applies the uncommitted work as one patch and writes the Claude sessions' histories
+under the new path (in the target server user's `~/.claude`), then the source removes its copy with
+`move.finish`, only if nothing changed there since it was copied. A failure on the target undoes
+all of it; the source is removed last. Both clones need an `origin` that names the same repository,
+and the source's server user must be able to push to it. See PROTOCOL.md, "Moving a worktree
+between servers".
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config, read at start) also serves
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 9e100f0..2459475 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -479,7 +479,12 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
      worktree is removed, and any failure before that rolls the target back and leaves
      the source as it was; Claude sessions' histories are copied (others are listed as
      not carried), and the note, tags, ticket, PR link and PR watch go along, not the
-     review draft or queued prompts. Plan:
+     review draft or queued prompts. Answered the same day: each Claude history travels
+     in its own chunked requests, up to 64 MiB a session; the worktree's Docker VM and
+     dev stack are torn down as Delete does (a checkbox, ticked by default; unticked, the
+     move is refused while they run), only after the target is verified; the branch's
+     Docker `.env` goes with the note, and a target without `env` lists it as not carried.
+     Plan:
      `docs/superpowers/plans/2026-11-10-central-server-phase5d-move-worktrees.md`.
    - **Later, in their own plans:** the bot (ported last, only when asked), promote to
      primary, and Windows support for the supervisor.
````

</details>


## Task 5: the patch's edge cases (linkedDirs, non-UTF-8 text)

**Prototype commit:** `f1e1e54` on `central-server-phase5d-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `scripts/serverMove.test.mjs`
- Modify: `server/src/move/moveHandlers.ts`
- Modify: `src/host/gitService.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverMove.test.mjs   # 11 pass
npm run smoke:server-move                 # 23 checks
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(5d): move.export leaves out the linkedDirs and refuses a patch that is not UTF-8" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 3d4e65b..6730207 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -719,7 +719,7 @@ The client's order, and what each step leaves behind when it fails:
 | Method | Params | Result |
 |---|---|---|
 | `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
-| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; `''` when clean; at most 8 MiB (else `BAD_REQUEST`). `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?}`, the tags by name. `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
+| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?}`, the tags by name. `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
 | `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
 | `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
 | `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData}` | `{worktreeId, dropped}`. See below |
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
index 306936a..8b8cc97 100644
--- a/scripts/serverMove.test.mjs
+++ b/scripts/serverMove.test.mjs
@@ -6,7 +6,7 @@ process.env.GIT_CONFIG_NOSYSTEM = '1'
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import { execFileSync } from 'node:child_process'
-import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import { saveConfig } from '../server/src/config.ts'
@@ -257,3 +257,17 @@ test('move.receive validates what it is given', async (t) => {
   assert.equal(await code({ branchData: { note: 5 } }), 'BAD_REQUEST')
   assert.equal(await code({ repoId: 'nope' }), 'NOT_FOUND')
 })
+
+test('move.export leaves out the linked dirs (the target links them itself) and refuses non-UTF-8 text', async (t) => {
+  const s = await setup(t)
+  mkdirSync(join(s.a, '.trek'))
+  await s.A.call('repo.update', { projectId: s.A.projectId, repoId: s.A.repoId, linkedDirs: ['.trek'] })
+  symlinkSync(join(s.a, '.trek'), join(s.path, '.trek'))
+  const res = await s.A.call('move.export', s.ref)
+  assert.equal(res.ok, true, JSON.stringify(res))
+  assert.doesNotMatch(res.result.patch, /\.trek/)
+  writeFileSync(join(s.path, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
+  const refused = await s.A.call('move.export', s.ref)
+  assert.equal(refused.error?.code, 'BAD_REQUEST')
+  assert.match(refused.error.message, /not UTF-8/)
+})
diff --git a/server/src/move/moveHandlers.ts b/server/src/move/moveHandlers.ts
index b016296..573d708 100644
--- a/server/src/move/moveHandlers.ts
+++ b/server/src/move/moveHandlers.ts
@@ -53,6 +53,7 @@ async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
   try {
     return await operation()
   } catch (err) {
+    if (err instanceof gitService.NotUtf8PatchError) throw bad(err.message)
     throw codedError('GIT_ERROR', (err as Error).message)
   }
 }
@@ -246,7 +247,7 @@ export const moveHandlers: Record<string, Handler> = {
   'move.export': async (p, ctx): Promise<MoveExport & { fingerprint: string }> => {
     const { project, repo, worktree, branch } = await source(ctx, p)
     if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
-    const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path))
+    const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path, repo.linkedDirs ?? []))
     const size = Buffer.byteLength(patch)
     if (size > MAX_MOVE_PATCH_BYTES) {
       throw bad(`the uncommitted changes make a ${MB(size)} patch; a move carries at most ${MB(MAX_MOVE_PATCH_BYTES)}. Commit or remove the large files first`)
@@ -283,7 +284,7 @@ export const moveHandlers: Record<string, Handler> = {
     if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} was loaded again after it was copied; it is kept`)
     const unblock = ctx.sessions.blockPath(worktree.path)
     try {
-      const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path))
+      const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path, repo.linkedDirs ?? []))
       if (fingerprint(headSha, patch) !== expected) {
         throw codedError('CONFLICT', `${worktree.path} changed after it was copied; it is kept`)
       }
diff --git a/src/host/gitService.ts b/src/host/gitService.ts
index 9d9362b..a4c3c27 100644
--- a/src/host/gitService.ts
+++ b/src/host/gitService.ts
@@ -246,27 +246,41 @@ export async function checkout(repoPath: string, branch: string): Promise<void>
   await git(repoPath, ['checkout', branch])
 }
 
+/** The uncommitted work has a text file git diffs as text but that is not UTF-8 (a worktree move carries the patch as a string). */
+export class NotUtf8PatchError extends Error {}
+
 /**
  * Uncommitted + untracked changes as one binary patch against HEAD (a worktree move, 5d). It is
  * built in a throwaway copy of the index (GIT_INDEX_FILE), so the worktree's own index, its
- * staged changes included, is never touched. Ignored files never appear. The patch puts every
- * change back unstaged.
+ * staged changes included, is never touched. Ignored files never appear, nor do `exclude`'s
+ * repo-relative paths (the repository's linkedDirs, which the target links itself). The patch
+ * puts every change back unstaged. A patch that is not valid UTF-8 (a Latin-1 text file, say)
+ * would not survive a JSON frame: NotUtf8PatchError.
  */
 export async function exportDirtyPatch(
-  worktreePath: string
+  worktreePath: string,
+  exclude: readonly string[] = []
 ): Promise<{ patch: string; headSha: string }> {
   const headSha = (await git(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim()
   const gitIndex = resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim())
   const dir = await mkdtemp(join(tmpdir(), 'trek-move-index-'))
   const index = join(dir, 'index')
+  const pathspec = ['.', ...exclude.map((p) => `:(exclude,literal)${p.replace(/\/+$/, '')}`)]
   try {
     await copyFile(gitIndex, index).catch(() => {})
     const env = { ...process.env, GIT_INDEX_FILE: index }
-    const run = (args: string[]) =>
-      execFileAsync('git', ['-C', worktreePath, ...args], { env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
-    await run(['add', '-A', '--', '.'])
-    const { stdout } = await run(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD'])
-    return { patch: stdout, headSha }
+    const options = { env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
+    await execFileAsync('git', ['-C', worktreePath, 'add', '-A', '--', ...pathspec], options)
+    const { stdout } = await execFileAsync(
+      'git',
+      ['-C', worktreePath, 'diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--', ...pathspec],
+      { ...options, encoding: 'buffer' }
+    )
+    try {
+      return { patch: new TextDecoder('utf-8', { fatal: true }).decode(stdout), headSha }
+    } catch {
+      throw new NotUtf8PatchError('the uncommitted changes include a text file that is not UTF-8; commit it (or remove it) first')
+    }
   } finally {
     await rm(dir, { recursive: true, force: true })
   }
````

</details>


## Task 6: the branch's Docker .env (User decision 7)

**Prototype commit:** `9acb278` on `central-server-phase5d-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `scripts/moveFlow.test.mjs`
- Modify: `scripts/server-move-smoke.mjs`
- Modify: `scripts/serverMove.test.mjs`
- Modify: `server/src/move/moveHandlers.ts`
- Modify: `src/renderer/src/components/MoveWorktreeModal.tsx`
- Modify: `src/renderer/src/v2/moveFlow.ts`
- Modify: `src/shared/move.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverMove.test.mjs scripts/moveFlow.test.mjs   # 11 + 8 pass
npm run smoke:server-move                                           # 23 checks
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5d): the branch's Docker .env goes with the note; a target without env lists it as not carried" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 6730207..f8c32d0 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -719,7 +719,7 @@ The client's order, and what each step leaves behind when it fails:
 | Method | Params | Result |
 |---|---|---|
 | `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
-| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?}`, the tags by name. `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
+| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?, env?}`, the tags by name, `env` the branch's Docker `.env` text (a client leaves it out for a target without `env`). `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
 | `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
 | `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
 | `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData}` | `{worktreeId, dropped}`. See below |
@@ -742,7 +742,7 @@ MiB of histories in all, an 8 MiB patch, the project's 500 sessions.
 
 What moves: the commits (through origin), the uncommitted work (unstaged), Claude sessions that
 have a saved history (copied, not moved: the source's file stays), the note, the workflow and custom
-tags (by name), the ticket, the pull request link and its watch. What does not: other agents'
+tags (by name), the ticket, the pull request link and its watch, the branch's Docker `.env` text. What does not: other agents'
 sessions (closed with the source), queued prompts, the review draft, a Docker environment or dev
 stack running for it on the source's machine, and the staged/unstaged split.
 
diff --git a/README.md b/README.md
index 52df04c..07ffc4d 100644
--- a/README.md
+++ b/README.md
@@ -229,8 +229,8 @@ other window on that project sees them live.
   one of the app's other servers and a project there with a clone of the same
   repository (the same origin). The branch is pushed to origin and checked out there,
   the uncommitted work goes along as a patch (all of it unstaged), Claude sessions'
-  histories are copied so they resume there, and the note, tags, ticket, pull request
-  and its watch come too. Other agents' sessions, queued prompts and the review draft
+  histories are copied so they resume there, and the note, tags, ticket, pull request,
+  its watch and the branch's Docker .env come too. Other agents' sessions, queued prompts and the review draft
   do not. The old worktree is removed last, and only if nothing changed in it while it
   was copied; a failure before that leaves it as it was. The web client never offers
   it (it has one server).
diff --git a/scripts/moveFlow.test.mjs b/scripts/moveFlow.test.mjs
index 6d01338..9119e2d 100644
--- a/scripts/moveFlow.test.mjs
+++ b/scripts/moveFlow.test.mjs
@@ -26,6 +26,7 @@ function run(source, target, over = {}) {
     from: { projectId: 'pa', worktreeId: 'wa' },
     to: { projectId: 'pb', repoId: 'rb' },
     loaded: true,
+    targetCapabilities: ['move', 'env'],
     progress: (step, status, detail) => steps.push([step, status, detail]),
     cancelled: () => false,
     ...over
@@ -107,3 +108,14 @@ test('move targets: the other entries with a token whose server takes a move', (
   assert.deepEqual(moveTargets([link('web')], 'web'), [], 'the web client has only its own server')
   assert.deepEqual(moveTargets(null, 'own'), [])
 })
+
+test("the branch's .env goes only to a target with environments", async () => {
+  const withEnv = { ...EXPORT, branchData: { note: 'n', env: 'A=1' } }
+  const t1 = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  await run(fake({ 'move.export': withEnv }), t1).outcome
+  assert.deepEqual(t1.calls[0][1].branchData, { note: 'n', env: 'A=1' })
+  const t2 = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const result = await run(fake({ 'move.export': withEnv }), t2, { targetCapabilities: ['move'] }).outcome
+  assert.deepEqual(t2.calls[0][1].branchData, { note: 'n' })
+  assert.ok(result.notes.some((n) => n.includes('.env was not carried')))
+})
diff --git a/scripts/server-move-smoke.mjs b/scripts/server-move-smoke.mjs
index 6ff2418..2985e80 100644
--- a/scripts/server-move-smoke.mjs
+++ b/scripts/server-move-smoke.mjs
@@ -13,7 +13,8 @@
 //     queued prompt that doesn't; a branch already checked out on B is a blocked place;
 //   - the move: the steps all done; origin has the branch; B has the worktree at the default path
 //     on the same commit with the uncommitted work (unstaged), the Claude session saved (not
-//     running) with its history under the new path in B's HOME, the note and the tag (by name);
+//     running) with its history under the new path in B's HOME, the note, the tag (by name) and the
+//     branch's .env;
 //   - A's worktree is gone from disk, its project and its window; A's history file is kept;
 //   - Open on B opens B's project window, which lists the moved worktree;
 //   - the renderer never holds either token; no error dialogs, console or page errors.
@@ -222,6 +223,7 @@ try {
   await a.sdk.request('session.enqueue', { projectId: pa, sessionId, text: 'a queued prompt' })
   await a.sdk.request('branch.setNote', { projectId: pa, repoId: repoA, branch: 'feature-x', note: 'moved note' })
   await a.sdk.request('branch.setTag', { projectId: pa, repoId: repoA, branch: 'feature-x', tag: 'x' })
+  await a.sdk.request('branch.setEnv', { projectId: pa, repoId: repoA, branch: 'feature-x', env: 'PORT=4100\n' })
   // A second worktree whose branch B already has checked out: a blocked place.
   await a.sdk.request('worktree.create', { projectId: pa, repoId: repoA, branch: 'feature-y', createBranch: true })
   git('-C', `${A.repo}-feature-y`, 'push', '-q', 'origin', 'feature-y')
@@ -300,7 +302,7 @@ try {
   const row = moved.worktrees.find((w) => w.path === targetPath)
   check("B's project lists it, unloaded, with the Claude session saved", [row?.loaded, row?.sessions.map((s) => [s.title, s.agentSessionId, s.queue.length])], [false, [['Claude moved', sessionId, 0]]])
   check("the session's history is under the new path in B's HOME", readFileSync(join(claudeDir(B.home, targetPath), `${sessionId}.jsonl`), 'utf8'), history)
-  check('the note and the tag (B\'s id for the same name) came along', [moved.branchData['feature-x']?.note, moved.branchData['feature-x']?.tag], ['moved note', 'other-id'])
+  check('the note, the tag (B\'s id for the same name) and the .env came along', [moved.branchData['feature-x']?.note, moved.branchData['feature-x']?.tag, moved.branchData['feature-x']?.env], ['moved note', 'other-id', 'PORT=4100\n'])
   check("A's worktree is gone from disk and from A's project", [existsSync(sourcePath), (await a.project(pa)).repositories[0].worktrees.some((w) => w.id === worktreeId)], [false, false])
   check("and from A's window", await until(() => rows.filter({ hasText: 'feature-x' }).count(), 0), 0)
   check("A's copy of the history is kept (copied, not moved)", existsSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`)), true)
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
index 8b8cc97..aff981d 100644
--- a/scripts/serverMove.test.mjs
+++ b/scripts/serverMove.test.mjs
@@ -88,7 +88,7 @@ async function setup(t) {
       { id: 'codex-1', title: 'Codex 1', llm: { provider: 'codex' }, queue: [], status: 'idle' }
     )
     d.settings.worktreeTags = [{ id: 'a-review', name: 'Review', color: '#ffffff' }, { id: 'a-only', name: 'Only on A', color: '#ffffff' }]
-    d.repositories[0].branchData.feat = { tag: 'a-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: {} }
+    d.repositories[0].branchData.feat = { tag: 'a-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: {}, env: 'PORT=1\n' }
   })
   B.projects.apply(B.projectId, (d) => {
     d.settings.worktreeTags = [{ id: 'b-review', name: 'Review', color: '#000000' }]
@@ -153,7 +153,7 @@ test('move.export refuses a loaded worktree and never touches the index', async
   assert.equal(res.result.head, git(s.path, 'rev-parse', 'HEAD').trim())
   assert.deepEqual(res.result.sessions.map((x) => x.agentSessionId), [CLAUDE_ID])
   assert.equal(res.result.notCarried.length, 2)
-  assert.deepEqual(res.result.branchData, { note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true, tag: 'Review' })
+  assert.deepEqual(res.result.branchData, { note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true, env: 'PORT=1\n', tag: 'Review' })
 })
 
 test('move.candidates lists the repositories with the same origin, and why one is blocked', async (t) => {
@@ -188,7 +188,7 @@ test('a move builds the worktree on the target and removes the source', async (t
   assert.notEqual(row.sessions[0].id, CLAUDE_ID, 'a new server id')
   assert.equal(readFileSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`), 'utf8'), '{"type":"user"}\n')
   const data = s.B.project().repositories[0].branchData.feat
-  assert.deepEqual({ ...data, prWatch: !!data.prWatch }, { tag: 'b-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true })
+  assert.deepEqual({ ...data, prWatch: !!data.prWatch }, { tag: 'b-review', note: 'the note', ticket: 'TOW-1', env: 'PORT=1\n', pr: 'https://github.com/o/r/pull/3', prWatch: true })
   assert.deepEqual(received.result.dropped, [])
   assert.equal(s.B.polled.length, 1, 'the watch polls soon on the target')
   // The source: gone from git and the project, its watch ended, its history kept (copied, not moved).
diff --git a/server/src/move/moveHandlers.ts b/server/src/move/moveHandlers.ts
index 573d708..7b71667 100644
--- a/server/src/move/moveHandlers.ts
+++ b/server/src/move/moveHandlers.ts
@@ -109,6 +109,7 @@ function exportBranchData(project: Project, data: BranchData | undefined): MoveB
   if (data.ticket) out.ticket = data.ticket
   if (data.pr) out.pr = data.pr
   if (data.prWatch) out.prWatch = true
+  if (data.env) out.env = data.env
   const tag = data.tag ? project.settings.worktreeTags?.find((t) => t.id === data.tag)?.name : undefined
   if (tag) out.tag = tag
   const custom = (data.customTags ?? [])
@@ -174,7 +175,7 @@ function checkBranchData(value: unknown): MoveBranchData {
   if (value === undefined) return {}
   if (!isRecord(value)) throw bad('branchData must be an object')
   const out: MoveBranchData = {}
-  const text = (key: 'note' | 'tag' | 'ticket' | 'pr', max: number): void => {
+  const text = (key: 'note' | 'tag' | 'ticket' | 'pr' | 'env', max: number): void => {
     const v = value[key]
     if (v === undefined) return
     if (typeof v !== 'string' || v.length > max) throw bad(`branchData.${key} must be a string of at most ${max} characters`)
@@ -184,6 +185,7 @@ function checkBranchData(value: unknown): MoveBranchData {
   text('tag', 200)
   text('ticket', 200)
   text('pr', 2000)
+  text('env', MAX_NOTE)
   if (value.customTags !== undefined) {
     if (!Array.isArray(value.customTags) || value.customTags.length > 100 || value.customTags.some((t) => typeof t !== 'string' || t.length > 200)) {
       throw bad('branchData.customTags must be at most 100 tag names')
@@ -200,6 +202,7 @@ function mergeBranchData(project: Project, existing: BranchData | undefined, inc
   const data: BranchData = { ...(existing ?? {}) }
   if (incoming.note) data.note = incoming.note
   if (incoming.ticket) data.ticket = incoming.ticket
+  if (incoming.env) data.env = incoming.env
   if (incoming.pr) {
     if (data.pr !== incoming.pr) delete data.prWatch
     data.pr = incoming.pr
diff --git a/src/renderer/src/components/MoveWorktreeModal.tsx b/src/renderer/src/components/MoveWorktreeModal.tsx
index 81135c5..0f8db7e 100644
--- a/src/renderer/src/components/MoveWorktreeModal.tsx
+++ b/src/renderer/src/components/MoveWorktreeModal.tsx
@@ -126,6 +126,7 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
       from,
       to: { projectId: chosen.projectId, repoId: chosen.repoId },
       loaded: plan.loaded,
+      targetCapabilities: server.connection.welcome?.capabilities ?? [],
       progress: (step, status, detail) => setSteps((prev) => ({ ...prev, [step]: { status, detail } })),
       cancelled: () => cancelled.current
     })
@@ -200,7 +201,7 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
               {plan.reviewComments > 0 && <li className="warn">The {plan.reviewComments} unsent review comment(s) are not moved and are lost.</li>}
               {plan.queuedPrompts > 0 && <li className="warn">The {plan.queuedPrompts} queued prompt(s) are not moved and are lost.</li>}
               {plan.loaded && <li>Its running sessions are stopped first.</li>}
-              <li>The note, tags, ticket and pull request link go with it{plan.prWatch ? ', and the PR watch moves there' : ''}.</li>
+              <li>The note, tags, ticket, pull request link and Docker .env go with it{plan.prWatch ? ', and the PR watch moves there' : ''}.</li>
             </ul>
           </>
         )}
diff --git a/src/renderer/src/v2/moveFlow.ts b/src/renderer/src/v2/moveFlow.ts
index cc80a37..08ecbce 100644
--- a/src/renderer/src/v2/moveFlow.ts
+++ b/src/renderer/src/v2/moveFlow.ts
@@ -32,6 +32,8 @@ export interface MoveFlowDeps {
   to: { projectId: string; repoId: string }
   /** Its sessions are running: they are stopped first, and started again if the move fails */
   loaded: boolean
+  /** The target's welcome capabilities: without `env` the branch's `.env` text is not sent */
+  targetCapabilities: readonly string[]
   progress(step: MoveStepKey, status: MoveStepStatus, detail?: string): void
   /** Checked between steps, until the target starts building */
   cancelled(): boolean
@@ -87,8 +89,15 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
 
   // From here on there is no cancelling: the target is building it.
   let received: MethodResultsV2['move.receive']
+  const kept: string[] = []
   try {
-    const { branch, head, patch, sessions, branchData } = exported
+    const { branch, head, patch, sessions } = exported
+    let { branchData } = exported
+    if (branchData.env && !deps.targetCapabilities.includes('env')) {
+      const { env: _env, ...rest } = branchData
+      branchData = rest
+      kept.push("The branch's Docker .env was not carried: the target server has no environments")
+    }
     received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData }, { timeoutMs: STEP_MS })
   } catch (err) {
     deps.progress('receive', 'failed', errorText(err))
@@ -99,7 +108,7 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
     await restore()
     return { kind: 'failed', step: 'receive', error: errorText(err) }
   }
-  const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...received.dropped]
+  const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...kept, ...received.dropped]
   deps.progress('receive', 'done', received.dropped.length > 0 ? `${received.dropped.length} thing(s) not carried over` : undefined)
 
   deps.progress('finish', 'active')
diff --git a/src/shared/move.ts b/src/shared/move.ts
index 21d0079..6c3ab2b 100644
--- a/src/shared/move.ts
+++ b/src/shared/move.ts
@@ -61,6 +61,8 @@ export interface MoveBranchData {
   ticket?: string
   pr?: string
   prWatch?: boolean
+  /** The branch's Docker environment `.env` text (5d); a target without `env` doesn't take it */
+  env?: string
 }
 
 /** `move.export`'s answer: everything the target needs, read from an unloaded worktree. */
````

</details>


## Task 7: Claude histories in chunks, up to 64 MiB a session (User decision 5)

**Prototype commit:** `4bb8b24` on `central-server-phase5d-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `scripts/moveFlow.test.mjs`
- Modify: `scripts/server-move-smoke.mjs`
- Modify: `scripts/serverMove.test.mjs`
- Modify: `server/README.md`
- Modify: `server/src/move/moveHandlers.ts`
- Create: `server/src/move/transfers.ts`
- Modify: `server/src/server.ts`
- Modify: `src/renderer/src/v2/moveFlow.ts`
- Modify: `src/shared/move.ts`
- Modify: `src/shared/protocolV2.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverMove.test.mjs scripts/moveFlow.test.mjs   # 15 + 10 pass (a 17 MiB history in 5 chunks)
cd server && npx tsc --noEmit && cd ..
npm run smoke:server-move                                           # 25 checks: a 17 MiB history, byte for byte, nothing left staged
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5d): Claude histories in chunks: move.history on the source, move.begin/upload/abort staging on the target, move.receive checks size and hash" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index f8c32d0..3d89f6d 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -106,7 +106,7 @@ new optional field needs no capability: its absence says enough.
 | `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
 | `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked (`gh auth status --hostname github.com`) when the server starts, every 10 minutes after that whether it is listed or not, and when a poll fails with what looks like a sign-in error (HTTP 401, not logged in); a poll failing any other way (the network, GitHub, one unreadable PR) leaves it as it is. The Local server announces itself only once the first check has answered (at most 3 s), so the app's first welcome has it; a remote server takes connections at once, so a welcome sent before gh answered lacks it and the change is pushed. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
 | `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
-| `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export` and `move.finish` on the source, `move.candidates` and `move.receive` on the target |
+| `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export`, `move.history` and `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort` and `move.receive` on the target |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -711,37 +711,47 @@ The client's order, and what each step leaves behind when it fails:
 3. `move.export` on the source: changes nothing.
 4. `worktree.push` `{setUpstream: true}` on the source: the branch is on origin. A failure here, or
    a cancel up to here, changes nothing but the push itself; the client loads the source again.
-5. `move.receive` on the target: builds the worktree, or undoes everything it did and fails.
-6. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
+5. The histories, if any session is carried: `move.begin` on the target opens a transfer, then for
+   each session, in order, `move.history` on the source reads a chunk (at most 4 MiB, base64) and
+   `move.upload` on the target appends it at its `offset`. A failure or a cancel here: `move.abort`
+   on the target, and the source is loaded again.
+6. `move.receive` on the target, with the `transferId`: builds the worktree, or undoes everything it
+   did and fails. Either way it takes the transfer and removes its staged files.
+7. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
    `CONFLICT` or `IN_USE` the client removes the target's copy again (`worktree.remove` `{force:
    true}`; the branch it created there stays) and loads the source again.
 
 | Method | Params | Result |
 |---|---|---|
 | `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
-| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?, env?}`, the tags by name, `env` the branch's Docker `.env` text (a client leaves it out for a target without `env`). `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
+| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, historyBytes, historySha256, sessionTypeName?, systemPrompt?, complete?}` (the history's bytes travel by `move.history`). `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?, env?}`, the tags by name, `env` the branch's Docker `.env` text (a client leaves it out for a target without `env`). `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
+| `move.history` | `{projectId, worktreeId, agentSessionId, offset}` | `{data, offset, total, done}`: base64 of at most 4 MiB of the session's history from byte `offset`; `done` once `offset` plus the chunk reaches `total`. Only a carried session (a Claude one with a saved history of at most 64 MiB) of an unloaded worktree (`IN_USE`; `NOT_FOUND` for another session; `BAD_REQUEST` for an offset past the end) |
 | `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
 | `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
-| `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData}` | `{worktreeId, dropped}`. See below |
+| `move.begin` | `{projectId, repoId}` | `{transferId}`: a staged upload for one move into this repository: a 0700 temp directory on the target. At most 4 at once (`CAPACITY`); one nobody has written to for 10 minutes is removed (swept by every later `move.begin`, `move.upload` and `move.receive`) |
+| `move.upload` | `{transferId, agentSessionId, offset, data}` | `{size}`: appends `data` (base64, 1 byte to 4 MiB) to that session's staged history. `offset` must be what is staged for it so far (else `CONFLICT`), so chunks go one at a time, in order. At most 64 MiB a session, 50 sessions and 512 MiB a transfer (`BAD_REQUEST`); `NOT_FOUND` for a finished, aborted or swept transfer |
+| `move.abort` | `{transferId}` | `null`: the transfer and its files go; an unknown one is fine |
+| `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData, transferId?}` | `{worktreeId, dropped}`. See below. `transferId` is required when `sessions` isn't empty, and must be a transfer begun for this repository |
 
 `move.receive`, in order: refuses (`CONFLICT`) a branch already checked out in the repository or a
 default path that exists; fetches `refs/heads/<branch>` from origin into `origin/<branch>` and
 refuses (`CONFLICT`) when it is not at `head`; creates the local branch tracking it (or
 fast-forwards an existing one that is behind `head`; `CONFLICT` when it has commits `head` lacks);
 checks it out at the default path (linking the repository's `linkedDirs`), checks `HEAD` is
-`head`, applies `patch` (`git apply --binary`: all of it unstaged, staged files included); writes each
-session's `history` to `~/.claude/projects/<the new path, encoded>/<agentSessionId>.jsonl` (mode
+`head`, applies `patch` (`git apply --binary`: all of it unstaged, staged files included); checks each
+session's staged history has its `historyBytes` and `historySha256` (else `BAD_REQUEST`: it did not
+arrive whole) and copies it to `~/.claude/projects/<the new path, encoded>/<agentSessionId>.jsonl` (mode
 0600) under the server user's HOME; and adds the worktree's row, unloaded, with one saved session
 per carried one (a new `id`, the same `agentSessionId`, `idle` or `complete`, an empty queue; its
 session type by name), and the branch data on top of what the project already has for the branch,
 the tags by name. A failure at any step undoes the ones before it (the worktree, the branch it
 created or moved, the history files it wrote) and answers the error. `dropped`: what did not come
 across, one line each (a tag or session type the project lacks, a PR watch on a server whose gh
-is not signed in). Limits: at most 50 sessions, only Claude ones (`agentSessionId` a session id), 6
-MiB of histories in all, an 8 MiB patch, the project's 500 sessions.
+is not signed in). Limits: at most 50 sessions, only Claude ones (`agentSessionId` a session id, no
+two alike), each history 1 byte to 64 MiB, an 8 MiB patch, the project's 500 sessions.
 
 What moves: the commits (through origin), the uncommitted work (unstaged), Claude sessions that
-have a saved history (copied, not moved: the source's file stays), the note, the workflow and custom
+have a saved history of at most 64 MiB (copied, not moved: the source's file stays), the note, the workflow and custom
 tags (by name), the ticket, the pull request link and its watch, the branch's Docker `.env` text. What does not: other agents'
 sessions (closed with the source), queued prompts, the review draft, a Docker environment or dev
 stack running for it on the source's machine, and the staged/unstaged split.
diff --git a/scripts/moveFlow.test.mjs b/scripts/moveFlow.test.mjs
index 9119e2d..be250ac 100644
--- a/scripts/moveFlow.test.mjs
+++ b/scripts/moveFlow.test.mjs
@@ -4,7 +4,8 @@ import assert from 'node:assert/strict'
 import { moveTargets, moveWorktree } from '../src/renderer/src/v2/moveFlow.ts'
 import { ClientError } from '../src/shared/client/connection.ts'
 
-const EXPORT = { branch: 'feat', head: 'a'.repeat(40), patch: 'diff', sessions: [{ title: 'c' }], notCarried: ['Codex 1: only Claude sessions move'], branchData: { note: 'n' }, fingerprint: 'f'.repeat(64) }
+const SID = '11111111-2222-4333-8444-555555555555'
+const EXPORT = { branch: 'feat', head: 'a'.repeat(40), patch: 'diff', sessions: [{ title: 'c', agentSessionId: SID, historyBytes: 10, historySha256: 'e'.repeat(64) }], notCarried: ['Codex 1: only Claude sessions move'], branchData: { note: 'n' }, fingerprint: 'f'.repeat(64) }
 
 /** A fake server: answers by method, records every call. */
 function fake(answers) {
@@ -18,6 +19,15 @@ function fake(answers) {
   return { calls, request, methods: () => calls.map(([m]) => m) }
 }
 
+/** A source whose history SID is 10 bytes, read 4 at a time ('YWJj' + ...) */
+const HISTORY = Buffer.from('0123456789')
+const historyChunks = ({ offset }) => {
+  const part = HISTORY.subarray(offset, offset + 4)
+  return { data: part.toString('base64'), offset, total: 10, done: offset + part.length >= 10 }
+}
+const src = (answers = {}) => fake({ 'move.export': EXPORT, 'move.history': historyChunks, ...answers })
+const tgt = (answers = {}) => fake({ 'move.begin': { transferId: 't1' }, 'move.upload': ({ offset, data }) => ({ size: offset + Buffer.from(data, 'base64').length }), ...answers })
+
 function run(source, target, over = {}) {
   const steps = []
   const outcome = moveWorktree({
@@ -35,21 +45,24 @@ function run(source, target, over = {}) {
 }
 
 test('a move unloads, exports, pushes, receives and finishes, in that order', async () => {
-  const source = fake({ 'move.export': EXPORT })
-  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: ['The tag “X” is not one of this project’s tags'] } })
+  const source = src()
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: ['The tag “X” is not one of this project’s tags'] } })
   const { outcome } = run(source, target)
   const result = await outcome
   assert.equal(result.kind, 'moved')
   assert.equal(result.worktreeId, 'wb')
   assert.deepEqual(result.notes, ['Not carried: Codex 1: only Claude sessions move', 'The tag “X” is not one of this project’s tags'])
-  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'move.finish'])
-  assert.deepEqual(source.calls[3][1], { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint })
-  assert.deepEqual(target.calls[0], ['move.receive', { projectId: 'pb', repoId: 'rb', branch: 'feat', head: EXPORT.head, patch: 'diff', sessions: EXPORT.sessions, branchData: { note: 'n' } }])
+  assert.deepEqual(source.methods(), ['worktree.unload', 'move.export', 'worktree.push', 'move.history', 'move.history', 'move.history', 'move.finish'])
+  assert.deepEqual(source.calls[6][1], { projectId: 'pa', worktreeId: 'wa', fingerprint: EXPORT.fingerprint })
+  assert.deepEqual(target.methods(), ['move.begin', 'move.upload', 'move.upload', 'move.upload', 'move.receive'])
+  assert.deepEqual(target.calls.slice(1, 4).map(([, p]) => p.offset), [0, 4, 8], 'in order, each at what is staged')
+  assert.equal(Buffer.concat(target.calls.slice(1, 4).map(([, p]) => Buffer.from(p.data, 'base64'))).toString(), '0123456789')
+  assert.deepEqual(target.calls[4], ['move.receive', { projectId: 'pb', repoId: 'rb', branch: 'feat', head: EXPORT.head, patch: 'diff', sessions: EXPORT.sessions, branchData: { note: 'n' }, transferId: 't1' }])
 })
 
 test('a failed push leaves the target alone and loads the source again', async () => {
-  const source = fake({ 'move.export': EXPORT, 'worktree.push': new ClientError('GIT_ERROR', 'rejected') })
-  const target = fake({})
+  const source = src({ 'worktree.push': new ClientError('GIT_ERROR', 'rejected') })
+  const target = tgt()
   const { outcome, steps } = run(source, target)
   const result = await outcome
   assert.deepEqual([result.kind, result.step], ['failed', 'push'])
@@ -59,8 +72,8 @@ test('a failed push leaves the target alone and loads the source again', async (
 })
 
 test('an unloaded worktree is not loaded afterwards, and cancelling stops before the target', async () => {
-  const source = fake({ 'move.export': EXPORT })
-  const target = fake({})
+  const source = src()
+  const target = tgt()
   let n = 0
   const { outcome } = run(source, target, { loaded: false, cancelled: () => ++n > 3 })
   const result = await outcome
@@ -72,33 +85,35 @@ test('an unloaded worktree is not loaded afterwards, and cancelling stops before
 })
 
 test('a refused receive restores the source; a lost answer says the target may have it', async () => {
-  const refused = fake({ 'move.export': EXPORT })
-  const r1 = await run(refused, fake({ 'move.receive': new ClientError('CONFLICT', 'checked out elsewhere') })).outcome
+  const refused = src()
+  const r1 = await run(refused, tgt({ 'move.receive': new ClientError('CONFLICT', 'checked out elsewhere') })).outcome
   assert.deepEqual([r1.kind, r1.step], ['failed', 'receive'])
   assert.equal(refused.methods().at(-1), 'worktree.load')
-  const lost = fake({ 'move.export': EXPORT })
-  const r2 = await run(lost, fake({ 'move.receive': new ClientError('NOT_CONNECTED', 'gone') })).outcome
+  const lost = src()
+  const lostTarget = tgt({ 'move.receive': new ClientError('NOT_CONNECTED', 'gone') })
+  const r2 = await run(lost, lostTarget).outcome
+  assert.equal(lostTarget.methods().at(-1), 'move.abort', 'the staged upload is dropped (a no-op if receive took it)')
   assert.equal(r2.kind, 'unknown')
   assert.match(r2.error, /may have created/)
   assert.ok(!lost.methods().includes('move.finish'))
 })
 
 test('a source changed after the copy: the target copy is removed again', async () => {
-  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('CONFLICT', 'it changed') })
-  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const source = src({ 'move.finish': new ClientError('CONFLICT', 'it changed') })
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
   const result = await run(source, target).outcome
   assert.deepEqual([result.kind, result.step], ['failed', 'finish'])
-  assert.deepEqual(target.calls[1], ['worktree.remove', { projectId: 'pb', worktreeId: 'wb', force: true }])
+  assert.deepEqual(target.calls.at(-1), ['worktree.remove', { projectId: 'pb', worktreeId: 'wb', force: true }])
   assert.equal(source.methods().at(-1), 'worktree.load')
 })
 
 test('a finish that fails otherwise leaves both copies and says so', async () => {
-  const source = fake({ 'move.export': EXPORT, 'move.finish': new ClientError('GIT_ERROR', 'busy') })
-  const target = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const source = src({ 'move.finish': new ClientError('GIT_ERROR', 'busy') })
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
   const result = await run(source, target).outcome
   assert.equal(result.kind, 'both')
   assert.equal(result.worktreeId, 'wb')
-  assert.equal(target.calls.length, 1)
+  assert.equal(target.methods().at(-1), 'move.receive')
 })
 
 test('move targets: the other entries with a token whose server takes a move', () => {
@@ -111,11 +126,35 @@ test('move targets: the other entries with a token whose server takes a move', (
 
 test("the branch's .env goes only to a target with environments", async () => {
   const withEnv = { ...EXPORT, branchData: { note: 'n', env: 'A=1' } }
-  const t1 = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
-  await run(fake({ 'move.export': withEnv }), t1).outcome
-  assert.deepEqual(t1.calls[0][1].branchData, { note: 'n', env: 'A=1' })
-  const t2 = fake({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
-  const result = await run(fake({ 'move.export': withEnv }), t2, { targetCapabilities: ['move'] }).outcome
-  assert.deepEqual(t2.calls[0][1].branchData, { note: 'n' })
+  const receiveOf = (t) => t.calls.find(([m]) => m === 'move.receive')[1]
+  const t1 = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  await run(src({ 'move.export': withEnv }), t1).outcome
+  assert.deepEqual(receiveOf(t1).branchData, { note: 'n', env: 'A=1' })
+  const t2 = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const result = await run(src({ 'move.export': withEnv }), t2, { targetCapabilities: ['move'] }).outcome
+  assert.deepEqual(receiveOf(t2).branchData, { note: 'n' })
   assert.ok(result.notes.some((n) => n.includes('.env was not carried')))
 })
+
+test('a failed upload, or a cancel between chunks, drops the staged transfer and loads the source again', async () => {
+  const source = src()
+  const target = tgt({ 'move.upload': new ClientError('BAD_REQUEST', 'too big') })
+  const result = await run(source, target).outcome
+  assert.deepEqual([result.kind, result.step], ['failed', 'histories'])
+  assert.deepEqual(target.methods(), ['move.begin', 'move.upload', 'move.abort'])
+  assert.equal(source.methods().at(-1), 'worktree.load')
+  let reads = 0
+  const slow = src({ 'move.history': (p) => { reads++; return historyChunks(p) } })
+  const t2 = tgt()
+  const r2 = await run(slow, t2, { cancelled: () => reads >= 2 }).outcome
+  assert.equal(r2.error, 'Cancelled')
+  assert.equal(t2.methods().at(-1), 'move.abort')
+  assert.ok(!t2.methods().includes('move.receive'))
+})
+
+test('a move with no carried session copies nothing and sends no transfer', async () => {
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  await run(src({ 'move.export': { ...EXPORT, sessions: [] } }), target).outcome
+  assert.deepEqual(target.methods(), ['move.receive'])
+  assert.equal(target.calls[0][1].transferId, undefined)
+})
diff --git a/scripts/server-move-smoke.mjs b/scripts/server-move-smoke.mjs
index 2985e80..8282246 100644
--- a/scripts/server-move-smoke.mjs
+++ b/scripts/server-move-smoke.mjs
@@ -11,7 +11,8 @@
 //   - both welcomes list move; the window offers Move to another server… (B is saved);
 //   - the dialog lists B's project (same origin), the new path, the session that moves and the
 //     queued prompt that doesn't; a branch already checked out on B is a blocked place;
-//   - the move: the steps all done; origin has the branch; B has the worktree at the default path
+//   - the move: the steps all done (a Claude history over 16 MiB copied in chunks, byte for byte,
+//     nothing left staged); origin has the branch; B has the worktree at the default path
 //     on the same commit with the uncommitted work (unstaged), the Claude session saved (not
 //     running) with its history under the new path in B's HOME, the note, the tag (by name) and the
 //     branch's .env;
@@ -24,7 +25,7 @@ import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { createHash, randomBytes } from 'node:crypto'
-import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
 import { createServer } from 'node:net'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
@@ -56,6 +57,7 @@ const until = async (fn, expected, ms = 15_000) => {
 // ---- Fixtures --------------------------------------------------------------
 
 const root = new URL('..', import.meta.url).pathname
+const startedAt = Date.now()
 const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-smoke-')))
 const appHome = join(work, 'app-home')
 const userData = join(work, 'user-data')
@@ -217,7 +219,10 @@ try {
   git('-C', sourcePath, 'add', 'staged.txt')
   writeFileSync(join(sourcePath, 'untracked.txt'), 'untracked\n')
   const { sessionId } = await a.sdk.request('session.start', { projectId: pa, worktreeId, cols: 80, rows: 24, title: 'Claude moved' })
-  const history = '{"type":"user","message":"hello"}\n'
+  // Over a frame (16 MiB): it travels in chunks.
+  const line = JSON.stringify({ type: 'assistant', message: 'x'.repeat(2000) }) + '\n'
+  const history = '{"type":"user","message":"hello"}\n' + line.repeat(Math.ceil((17 * 1024 * 1024) / line.length))
+  const historySha = createHash('sha256').update(history).digest('hex')
   mkdirSync(claudeDir(A.home, sourcePath), { recursive: true })
   writeFileSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`), history)
   await a.sdk.request('session.enqueue', { projectId: pa, sessionId, text: 'a queued prompt' })
@@ -294,14 +299,17 @@ try {
 
   await modal.locator('button', { hasText: 'Move worktree' }).click()
   check('the move reports success', await until(() => modal.locator('.server-test-result.ok').count(), 1, 60_000), 1)
-  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done'])
+  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done', 'done'])
+  check('the history step copied the whole 17 MB', (await modal.locator('.move-step.done', { hasText: 'Copy the session histories' }).locator('.move-step-detail').textContent()).includes('1 session history, 17.0 MB'), true)
   check('origin has the branch at the source commit', git('--git-dir', origin, 'rev-parse', 'refs/heads/feature-x').trim(), head)
   check('B has the worktree on the same commit', existsSync(targetPath) && git('-C', targetPath, 'rev-parse', 'HEAD').trim(), head)
   check('with the uncommitted work, all of it unstaged', git('-C', targetPath, 'status', '--porcelain').split('\n').filter(Boolean).sort(), [' M README', '?? staged.txt', '?? untracked.txt'])
   const moved = (await b.project(pb)).repositories[0]
   const row = moved.worktrees.find((w) => w.path === targetPath)
   check("B's project lists it, unloaded, with the Claude session saved", [row?.loaded, row?.sessions.map((s) => [s.title, s.agentSessionId, s.queue.length])], [false, [['Claude moved', sessionId, 0]]])
-  check("the session's history is under the new path in B's HOME", readFileSync(join(claudeDir(B.home, targetPath), `${sessionId}.jsonl`), 'utf8'), history)
+  const arrived = readFileSync(join(claudeDir(B.home, targetPath), `${sessionId}.jsonl`))
+  check("the session's history (over 16 MiB) is under the new path in B's HOME, byte for byte", [arrived.length > 16 * 1024 * 1024, createHash('sha256').update(arrived).digest('hex')], [true, historySha])
+  check("nothing is left staged on B", readdirSync(tmpdir()).filter((n) => n.startsWith('trek-move-') && statSync(join(tmpdir(), n)).mtimeMs >= startedAt).length, 0)
   check('the note, the tag (B\'s id for the same name) and the .env came along', [moved.branchData['feature-x']?.note, moved.branchData['feature-x']?.tag, moved.branchData['feature-x']?.env], ['moved note', 'other-id', 'PORT=4100\n'])
   check("A's worktree is gone from disk and from A's project", [existsSync(sourcePath), (await a.project(pa)).repositories[0].worktrees.some((w) => w.id === worktreeId)], [false, false])
   check("and from A's window", await until(() => rows.filter({ hasText: 'feature-x' }).count(), 0), 0)
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
index aff981d..bd7f4a8 100644
--- a/scripts/serverMove.test.mjs
+++ b/scripts/serverMove.test.mjs
@@ -16,7 +16,8 @@ import { ProjectState } from '../server/src/projects/state.ts'
 import { TopicHub } from '../server/src/topicHub.ts'
 import { dispatchV2 } from '../server/src/v2.ts'
 import { projectDir } from '../src/host/claudeSessionService.ts'
-import { normalizeOrigin, sameOrigin } from '../src/shared/move.ts'
+import { MAX_MOVE_CHUNK_BYTES, MOVE_TRANSFER_IDLE_MS, normalizeOrigin, sameOrigin } from '../src/shared/move.ts'
+import { MoveTransfers } from '../server/src/move/transfers.ts'
 
 const gitEnv = {
   ...process.env,
@@ -97,19 +98,41 @@ async function setup(t) {
   return { dir, origin, a, b, A, B, worktreeId, path, ref }
 }
 
-/** The whole move, as the app runs it: export, push, receive, finish. */
+/** Copies each carried history from A into a new transfer on B, chunk by chunk; the transfer id. */
+async function copyHistories(s, sessions) {
+  const begun = await s.B.call('move.begin', { projectId: s.B.projectId, repoId: s.B.repoId })
+  assert.equal(begun.ok, true, JSON.stringify(begun))
+  const { transferId } = begun.result
+  let chunks = 0
+  for (const session of sessions) {
+    let offset = 0
+    for (;;) {
+      const chunk = await s.A.call('move.history', { ...s.ref, agentSessionId: session.agentSessionId, offset })
+      assert.equal(chunk.ok, true, JSON.stringify(chunk))
+      const up = await s.B.call('move.upload', { transferId, agentSessionId: session.agentSessionId, offset, data: chunk.result.data })
+      assert.equal(up.ok, true, JSON.stringify(up))
+      offset = up.result.size
+      chunks++
+      if (chunk.result.done) break
+    }
+  }
+  return { transferId, chunks }
+}
+
+/** The whole move, as the app runs it: export, push, histories, receive, finish. */
 async function move(s, { finish = true } = {}) {
   const exported = await s.A.call('move.export', s.ref)
   assert.equal(exported.ok, true, JSON.stringify(exported))
   const pushed = await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
   assert.equal(pushed.ok, true, JSON.stringify(pushed))
   const { fingerprint, notCarried, ...rest } = exported.result
-  const received = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: rest.branch, head: rest.head, patch: rest.patch, sessions: rest.sessions, branchData: rest.branchData })
+  const { transferId, chunks } = await copyHistories(s, rest.sessions)
+  const received = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: rest.branch, head: rest.head, patch: rest.patch, sessions: rest.sessions, branchData: rest.branchData, transferId })
   if (finish && received.ok) {
     const done = await s.A.call('move.finish', { ...s.ref, fingerprint })
     assert.equal(done.ok, true, JSON.stringify(done))
   }
-  return { exported: exported.result, received, notCarried }
+  return { exported: exported.result, received, notCarried, chunks }
 }
 
 test('normalizeOrigin matches the ssh, https and file forms of one repository', () => {
@@ -216,7 +239,8 @@ test('move.receive undoes everything when origin is not at the source head', asy
   const s = await setup(t)
   const exported = (await s.A.call('move.export', s.ref)).result
   await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
-  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: exported.patch, sessions: exported.sessions, branchData: {} })
+  const { transferId } = await copyHistories(s, exported.sessions)
+  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: exported.patch, sessions: exported.sessions, branchData: {}, transferId })
   assert.equal(res.error?.code, 'CONFLICT')
   assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
   assert.ok(!existsSync(join(s.dir, 'b', 'app-feat')))
@@ -227,7 +251,8 @@ test('move.receive undoes the worktree, the branch and the histories when the pa
   const exported = (await s.A.call('move.export', s.ref)).result
   await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
   const target = join(s.dir, 'b', 'app-feat')
-  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: 'diff --git a/x b/x\nnot a patch\n', sessions: exported.sessions, branchData: exported.branchData })
+  const { transferId } = await copyHistories(s, exported.sessions)
+  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: 'diff --git a/x b/x\nnot a patch\n', sessions: exported.sessions, branchData: exported.branchData, transferId })
   assert.equal(res.error?.code, 'GIT_ERROR', JSON.stringify(res))
   assert.ok(!existsSync(target))
   assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
@@ -250,10 +275,18 @@ test('move.receive validates what it is given', async (t) => {
   const s = await setup(t)
   const base = { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: '', sessions: [], branchData: {} }
   const code = async (over) => (await s.B.call('move.receive', { ...base, ...over })).error?.code
+  // A clean worktree's patch is '': only the head (not on origin) refuses this one.
+  assert.equal(await code({}), 'GIT_ERROR')
   assert.equal(await code({ head: 'HEAD' }), 'BAD_REQUEST')
   assert.equal(await code({ branch: '-x' }), 'BAD_REQUEST')
-  assert.equal(await code({ sessions: [{ title: 't', llm: { provider: 'codex' }, agentSessionId: CLAUDE_ID, history: '' }] }), 'BAD_REQUEST')
-  assert.equal(await code({ sessions: [{ title: 't', llm: { provider: 'claude' }, agentSessionId: '../x', history: '' }] }), 'BAD_REQUEST')
+  const one = { title: 't', llm: { provider: 'claude' }, agentSessionId: CLAUDE_ID, historyBytes: 5, historySha256: 'a'.repeat(64) }
+  assert.equal(await code({ sessions: [{ ...one, llm: { provider: 'codex' } }] }), 'BAD_REQUEST')
+  assert.equal(await code({ sessions: [{ ...one, agentSessionId: '../x' }] }), 'BAD_REQUEST')
+  assert.equal(await code({ sessions: [{ ...one, historyBytes: 64 * 1024 * 1024 + 1 }] }), 'BAD_REQUEST')
+  assert.equal(await code({ sessions: [one, one] }), 'BAD_REQUEST', 'a repeated session')
+  assert.equal(await code({ sessions: [one] }), 'BAD_REQUEST', 'sessions need a transfer')
+  const missing = await s.B.call('move.receive', { ...base, sessions: [one], transferId: '00000000-0000-4000-8000-000000000000' })
+  assert.equal(missing.error?.code, 'NOT_FOUND', JSON.stringify(missing))
   assert.equal(await code({ branchData: { note: 5 } }), 'BAD_REQUEST')
   assert.equal(await code({ repoId: 'nope' }), 'NOT_FOUND')
 })
@@ -271,3 +304,72 @@ test('move.export leaves out the linked dirs (the target links them itself) and
   assert.equal(refused.error?.code, 'BAD_REQUEST')
   assert.match(refused.error.message, /not UTF-8/)
 })
+
+test('a history bigger than one chunk (and than a frame) arrives whole, in order', async (t) => {
+  const s = await setup(t)
+  // 17 MiB: five chunks, and more than the server's 16 MiB frame.
+  const line = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n'
+  const big = line.repeat(Math.ceil((17 * 1024 * 1024) / line.length))
+  writeFileSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`), big)
+  const { received, chunks } = await move(s)
+  assert.equal(received.ok, true, JSON.stringify(received))
+  assert.equal(chunks, Math.ceil(Buffer.byteLength(big) / MAX_MOVE_CHUNK_BYTES))
+  assert.equal(readFileSync(join(projectDir(join(s.dir, 'b', 'app-feat')), `${CLAUDE_ID}.jsonl`), 'utf8'), big)
+})
+
+test('a history that did not arrive whole is refused, and nothing stays staged or built', async (t) => {
+  const s = await setup(t)
+  const exported = (await s.A.call('move.export', s.ref)).result
+  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
+  const begun = (await s.B.call('move.begin', { projectId: s.B.projectId, repoId: s.B.repoId })).result
+  await s.B.call('move.upload', { transferId: begun.transferId, agentSessionId: CLAUDE_ID, offset: 0, data: Buffer.from('{"type"').toString('base64') })
+  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: exported.patch, sessions: exported.sessions, branchData: {}, transferId: begun.transferId })
+  assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(res))
+  assert.match(res.error.message, /did not arrive whole/)
+  assert.ok(!existsSync(join(s.dir, 'b', 'app-feat')))
+  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
+  assert.equal((await s.B.call('move.upload', { transferId: begun.transferId, agentSessionId: CLAUDE_ID, offset: 7, data: 'AAAA' })).error?.code, 'NOT_FOUND', 'the transfer went with the receive')
+})
+
+test('move.history reads only a carried history of an unloaded worktree', async (t) => {
+  const s = await setup(t)
+  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: FRESH_ID, offset: 0 })).error?.code, 'NOT_FOUND', 'no saved conversation')
+  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: -1 })).error?.code, 'BAD_REQUEST')
+  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 9999 })).error?.code, 'BAD_REQUEST')
+  const whole = await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 0 })
+  assert.deepEqual({ ...whole.result, data: Buffer.from(whole.result.data, 'base64').toString() }, { data: '{"type":"user"}\n', offset: 0, total: 16, done: true })
+  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = true })
+  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 0 })).error?.code, 'IN_USE')
+})
+
+test('transfers: chunks in order, the limits, abort, and an idle one swept', async (t) => {
+  let now = 1000
+  const transfers = new MoveTransfers(() => now)
+  t.after(() => transfers.clear())
+  const id = await transfers.begin('p', 'r')
+  const chunk = Buffer.from('abcd').toString('base64')
+  assert.equal(await transfers.append(id, CLAUDE_ID, 0, chunk), 4)
+  await assert.rejects(transfers.append(id, CLAUDE_ID, 0, chunk), /starts at 4/)
+  assert.equal(await transfers.append(id, CLAUDE_ID, 4, chunk), 8)
+  await assert.rejects(transfers.append(id, CLAUDE_ID, 8, 'not base64!'), /base64/)
+  await assert.rejects(transfers.append(id, '../etc', 0, chunk), /session id/)
+  await assert.rejects(transfers.append(id, CLAUDE_ID, 8, Buffer.alloc(MAX_MOVE_CHUNK_BYTES + 1).toString('base64')), /at most/)
+  assert.throws(() => transfers.take(id, 'p', 'other'), /another repository/)
+  const staged = transfers.take(id, 'p', 'r')
+  assert.equal(readFileSync(staged.file(CLAUDE_ID), 'utf8'), 'abcdabcd')
+  await staged.discard()
+  assert.ok(!existsSync(staged.file(CLAUDE_ID)))
+  const second = await transfers.begin('p', 'r')
+  await transfers.append(second, CLAUDE_ID, 0, chunk)
+  await transfers.abort(second)
+  await transfers.abort(second)
+  await assert.rejects(transfers.append(second, CLAUDE_ID, 4, chunk), /No such transfer/)
+  const idle = await transfers.begin('p', 'r')
+  now += MOVE_TRANSFER_IDLE_MS + 1
+  await transfers.sweep()
+  assert.equal(transfers.size, 0)
+  await assert.rejects(transfers.append(idle, CLAUDE_ID, 0, chunk), /No such transfer/)
+  const ids = []
+  for (let i = 0; i < 4; i++) ids.push(await transfers.begin('p', 'r'))
+  await assert.rejects(transfers.begin('p', 'r'), /at most 4/)
+})
diff --git a/server/README.md b/server/README.md
index b2dbe03..2e100cb 100644
--- a/server/README.md
+++ b/server/README.md
@@ -210,7 +210,7 @@ With the `move` capability on both servers, the app can move a worktree from one
 never connect to each other, and no token reaches either window): the source pushes the branch to
 origin, the target's `move.receive` fetches and checks it out next to its clone of the same
 repository, applies the uncommitted work as one patch and writes the Claude sessions' histories
-under the new path (in the target server user's `~/.claude`), then the source removes its copy with
+(copied in 4 MiB chunks into a staged upload in a temp directory, at most 64 MiB a session) under the new path (in the target server user's `~/.claude`), then the source removes its copy with
 `move.finish`, only if nothing changed there since it was copied. A failure on the target undoes
 all of it; the source is removed last. Both clones need an `origin` that names the same repository,
 and the source's server user must be able to push to it. See PROTOCOL.md, "Moving a worktree
diff --git a/server/src/move/moveHandlers.ts b/server/src/move/moveHandlers.ts
index 7b71667..e241565 100644
--- a/server/src/move/moveHandlers.ts
+++ b/server/src/move/moveHandlers.ts
@@ -1,24 +1,28 @@
 // Moving a worktree between servers (phase 5d), behind the `move` capability. The app relays: it
 // asks the source `move.prepare` (what would move), the target `move.candidates` (where it can go),
-// unloads the source, takes `move.export` (HEAD, the uncommitted work as one patch, the Claude
-// histories, the branch data), pushes the branch through origin (`worktree.push`), hands it all
-// to the target's `move.receive` (which builds the worktree, or rolls itself back), and finally
-// asks the source `move.finish` to remove its copy, only if nothing changed since the export.
+// unloads the source, takes `move.export` (HEAD, the uncommitted work as one patch, the carried
+// Claude sessions with each history's size and hash, the branch data), pushes the branch through
+// origin (`worktree.push`), copies each history in chunks (`move.history` on the source,
+// `move.upload` into a `move.begin` transfer on the target), hands the rest to the target's
+// `move.receive` (which builds the worktree, or rolls itself back), and finally asks the source
+// `move.finish` to remove its copy, only if nothing changed since the export.
 import { createHash, randomUUID } from 'node:crypto'
-import { existsSync } from 'node:fs'
-import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
+import { createReadStream, existsSync } from 'node:fs'
+import { copyFile, chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
 import { join } from 'node:path'
 import * as gitService from '../../../src/host/gitService.ts'
 import { projectDir } from '../../../src/host/claudeSessionService.ts'
 import type { BranchData, Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
 import {
-  MAX_MOVE_HISTORY_BYTES,
+  MAX_MOVE_CHUNK_BYTES,
+  MAX_MOVE_HISTORY_SESSION_BYTES,
   MAX_MOVE_PATCH_BYTES,
   MAX_MOVE_SESSIONS,
   sameOrigin,
   type MoveBranchData,
   type MoveCandidate,
   type MoveExport,
+  type MoveHistoryChunk,
   type MovePlan,
   type MoveReceived,
   type MoveSession,
@@ -33,6 +37,7 @@ import { MAX_SESSIONS_PER_PROJECT, checkTitle } from '../sessions/limits.ts'
 import { isRecord, requireBranch, requireString } from '../validate.ts'
 import type { V2Context } from '../v2.ts'
 import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'
+import { moveTransfers, type StagedHistories } from './transfers.ts'
 
 type Handler = (params: any, ctx: V2Context) => unknown
 
@@ -43,6 +48,15 @@ const FINGERPRINT = /^[0-9a-f]{64}$/
 const MAX_SYSTEM_PROMPT = 100_000
 const MAX_NOTE = 100_000
 const MB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
+const SHA256 = /^[0-9a-f]{64}$/
+
+/** A file's sha256, streamed */
+function sha256File(file: string): Promise<string> {
+  return new Promise((resolve, reject) => {
+    const hash = createHash('sha256')
+    createReadStream(file).on('data', (b) => hash.update(b)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
+  })
+}
 
 /** Same head and same patch: nothing changed in the worktree since it was exported. */
 function fingerprint(head: string, patch: string): string {
@@ -71,10 +85,9 @@ async function historyOf(worktree: Worktree, session: Session): Promise<{ file:
 }
 
 /** Which of the worktree's sessions are carried: Claude ones with a history, within the limits. */
-async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string }[] }> {
+async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string; size: number }[] }> {
   const info: MoveSessionInfo[] = []
-  const carried: { session: Session; file: string }[] = []
-  let total = 0
+  const carried: { session: Session; file: string; size: number }[] = []
   for (const session of worktree.sessions) {
     const base = { title: session.title, provider: session.llm.provider }
     if (session.llm.provider !== 'claude') {
@@ -90,12 +103,11 @@ async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionI
       info.push({ ...base, carried: false, reason: `a move carries at most ${MAX_MOVE_SESSIONS} sessions` })
       continue
     }
-    if (total + history.size > MAX_MOVE_HISTORY_BYTES) {
-      info.push({ ...base, carried: false, reason: `its history (${MB(history.size)}) is over what one move carries (${MB(MAX_MOVE_HISTORY_BYTES)} in all)` })
+    if (history.size > MAX_MOVE_HISTORY_SESSION_BYTES) {
+      info.push({ ...base, carried: false, reason: `its history (${MB(history.size)}) is over what one session carries (${MB(MAX_MOVE_HISTORY_SESSION_BYTES)})` })
       continue
     }
-    total += history.size
-    carried.push({ session, file: history.file })
+    carried.push({ session, file: history.file, size: history.size })
     info.push({ ...base, carried: true })
   }
   return { info, carried }
@@ -146,7 +158,7 @@ function checkSessions(value: unknown): MoveSession[] {
   if (value === undefined) return []
   if (!Array.isArray(value)) throw bad('sessions must be an array')
   if (value.length > MAX_MOVE_SESSIONS) throw bad(`sessions must hold at most ${MAX_MOVE_SESSIONS} entries`)
-  let total = 0
+  const seen = new Set<string>()
   return value.map((raw: unknown, i) => {
     if (!isRecord(raw)) throw bad(`sessions[${i}] must be an object`)
     const title = checkTitle(requireString(raw.title, `sessions[${i}].title`), `sessions[${i}].title`)
@@ -156,10 +168,15 @@ function checkSessions(value: unknown): MoveSession[] {
     if (!llm) throw bad(`sessions[${i}].llm must be an LLM selection`)
     const agentSessionId = requireString(raw.agentSessionId, `sessions[${i}].agentSessionId`)
     if (!SESSION_ID.test(agentSessionId)) throw bad(`sessions[${i}].agentSessionId must be a session id`)
-    const history = requireString(raw.history, `sessions[${i}].history`)
-    total += Buffer.byteLength(history)
-    if (total > MAX_MOVE_HISTORY_BYTES) throw bad(`the histories must be at most ${MB(MAX_MOVE_HISTORY_BYTES)} in all`)
-    const session: MoveSession = { title, llm, agentSessionId, history }
+    if (seen.has(agentSessionId)) throw bad(`sessions[${i}].agentSessionId repeats another`)
+    seen.add(agentSessionId)
+    const historyBytes = raw.historyBytes
+    if (!Number.isInteger(historyBytes) || (historyBytes as number) < 1 || (historyBytes as number) > MAX_MOVE_HISTORY_SESSION_BYTES) {
+      throw bad(`sessions[${i}].historyBytes must be 1 to ${MAX_MOVE_HISTORY_SESSION_BYTES}`)
+    }
+    const historySha256 = requireString(raw.historySha256, `sessions[${i}].historySha256`)
+    if (!SHA256.test(historySha256)) throw bad(`sessions[${i}].historySha256 must be a sha256 in hex`)
+    const session: MoveSession = { title, llm, agentSessionId, historyBytes: historyBytes as number, historySha256 }
     if (raw.sessionTypeName !== undefined) session.sessionTypeName = requireString(raw.sessionTypeName, `sessions[${i}].sessionTypeName`)
     if (raw.systemPrompt !== undefined) {
       const prompt = requireString(raw.systemPrompt, `sessions[${i}].systemPrompt`)
@@ -258,13 +275,13 @@ export const moveHandlers: Record<string, Handler> = {
     const { info, carried } = await carriedSessions(worktree)
     const sessions: MoveSession[] = []
     const notCarried = info.filter((s) => !s.carried).map((s) => `${s.title}: ${s.reason}`)
-    for (const { session, file } of carried) {
-      const history = await readFile(file, 'utf8').catch(() => null)
-      if (history === null) {
+    for (const { session, file, size } of carried) {
+      const historySha256 = await sha256File(file).catch(() => null)
+      if (historySha256 === null) {
         notCarried.push(`${session.title}: its history could not be read`)
         continue
       }
-      const out: MoveSession = { title: session.title, llm: session.llm, agentSessionId: session.agentSessionId!, history }
+      const out: MoveSession = { title: session.title, llm: session.llm, agentSessionId: session.agentSessionId!, historyBytes: size, historySha256 }
       const type = session.sessionTypeId ? project.settings.sessionTypes?.find((t) => t.id === session.sessionTypeId) : undefined
       if (type) out.sessionTypeName = type.name
       if (session.systemPrompt) out.systemPrompt = session.systemPrompt
@@ -275,6 +292,49 @@ export const moveHandlers: Record<string, Handler> = {
     return { branch, head: headSha, patch, sessions, notCarried, branchData: exportBranchData(project, data), fingerprint: fingerprint(headSha, patch) }
   },
 
+  /**
+   * One chunk of a carried session's history, from `offset` (at most MAX_MOVE_CHUNK_BYTES, base64).
+   * Only from an unloaded worktree, for one of its Claude sessions with a history.
+   */
+  'move.history': async (p, ctx): Promise<MoveHistoryChunk> => {
+    const agentSessionId = requireString(p.agentSessionId, 'agentSessionId')
+    if (!Number.isInteger(p.offset) || p.offset < 0) throw bad('offset must be a whole number of bytes')
+    const { worktree } = await source(ctx, p)
+    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
+    const session = worktree.sessions.find((s) => s.agentSessionId === agentSessionId)
+    const history = session ? await historyOf(worktree, session) : null
+    if (!history) throw codedError('NOT_FOUND', `No carried history ${agentSessionId} in ${worktree.path}`)
+    if (history.size > MAX_MOVE_HISTORY_SESSION_BYTES) throw bad(`that history is over ${MB(MAX_MOVE_HISTORY_SESSION_BYTES)}`)
+    if (p.offset > history.size) throw bad(`offset is past the history's ${history.size} bytes`)
+    const length = Math.min(MAX_MOVE_CHUNK_BYTES, history.size - p.offset)
+    const buffer = Buffer.alloc(length)
+    const handle = await open(history.file, 'r')
+    try {
+      const { bytesRead } = await handle.read(buffer, 0, length, p.offset)
+      const offset = p.offset as number
+      return { data: buffer.subarray(0, bytesRead).toString('base64'), offset, total: history.size, done: offset + bytesRead >= history.size }
+    } finally {
+      await handle.close()
+    }
+  },
+
+  /** Target: opens a transfer for one move's histories into this project's repository. */
+  'move.begin': async (p, ctx): Promise<{ transferId: string }> => {
+    const project = ctx.projects.require(p.projectId)
+    const repo = repoIn(project, p.repoId)
+    findRegistered(ctx.store.config.repos, repo.path)
+    return { transferId: await moveTransfers.begin(project.id, repo.id) }
+  },
+
+  /** Target: appends one chunk of a history to the transfer, in order (`offset` is what is staged so far). */
+  'move.upload': async (p): Promise<{ size: number }> => ({ size: await moveTransfers.append(p.transferId, p.agentSessionId, p.offset, p.data) }),
+
+  /** Target: drops a transfer and its files; an unknown or finished one is fine. */
+  'move.abort': async (p): Promise<null> => {
+    await moveTransfers.abort(p.transferId)
+    return null
+  },
+
   /**
    * The last step, once the target has the worktree: the source's copy is removed (force) only if
    * its HEAD and uncommitted work are what was exported; otherwise CONFLICT and nothing changes.
@@ -356,10 +416,38 @@ export const moveHandlers: Record<string, Handler> = {
     await checkBranchName(repo.path, branch, false)
     const head = requireString(p.head, 'head')
     if (!SHA.test(head)) throw bad('head must be a full commit id')
-    const patch = p.patch === undefined ? '' : requireString(p.patch, 'patch')
+    if (p.patch !== undefined && typeof p.patch !== 'string') throw bad('patch must be a string')
+    const patch: string = p.patch ?? ''
     if (Buffer.byteLength(patch) > MAX_MOVE_PATCH_BYTES) throw bad(`patch must be at most ${MB(MAX_MOVE_PATCH_BYTES)}`)
     const sessions = checkSessions(p.sessions)
     const incoming = checkBranchData(p.branchData)
+    await moveTransfers.sweep()
+    // The transfer is the move's: whatever happens below, its staged files go.
+    let staged: StagedHistories | undefined
+    if (p.transferId !== undefined) staged = moveTransfers.take(p.transferId, project.id, repo.id)
+    else if (sessions.length > 0) throw bad('transferId is needed to carry sessions')
+    try {
+      return await receive(ctx, p, project, repo, branch, head, patch, sessions, incoming, staged)
+    } finally {
+      await staged?.discard()
+    }
+  }
+}
+
+/** move.receive's work, once its params are checked and its transfer taken. */
+async function receive(
+  ctx: V2Context,
+  p: any,
+  project: Project,
+  repo: Repository,
+  branch: string,
+  head: string,
+  patch: string,
+  sessions: MoveSession[],
+  incoming: MoveBranchData,
+  staged: StagedHistories | undefined
+): Promise<MoveReceived> {
+  {
     const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
     if (records + sessions.length > MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions`)
 
@@ -400,11 +488,16 @@ export const moveHandlers: Record<string, Handler> = {
       }
       const dir = projectDir(target)
       for (const s of sessions) {
+        const from = staged?.file(s.agentSessionId)
+        if (!from || staged!.size(s.agentSessionId) !== s.historyBytes || (await sha256File(from)) !== s.historySha256) {
+          throw bad(`the history of “${s.title}” did not arrive whole (${staged?.size(s.agentSessionId) ?? 0} of ${s.historyBytes} bytes, or another hash)`)
+        }
         const file = join(dir, `${s.agentSessionId}.jsonl`)
-        const before = await readFile(file, 'utf8').catch(() => null)
+        const before = await readFile(file).catch(() => null)
         await mkdir(dir, { recursive: true })
-        await writeFile(file, s.history, { encoding: 'utf8', mode: 0o600 })
-        undo.push(() => (before === null ? rm(file, { force: true }) : writeFile(file, before, 'utf8')))
+        await copyFile(from, file)
+        await chmod(file, 0o600)
+        undo.push(() => (before === null ? rm(file, { force: true }) : writeFile(file, before)))
       }
       if (!(await ctx.poller.refresh(repo.path))) {
         throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
diff --git a/server/src/move/transfers.ts b/server/src/move/transfers.ts
new file mode 100644
index 0000000..8838172
--- /dev/null
+++ b/server/src/move/transfers.ts
@@ -0,0 +1,148 @@
+// The target's staged uploads of a worktree move's Claude histories (phase 5d): `move.begin` opens
+// a transfer, `move.upload` appends each history's chunks in order, and `move.receive` takes the
+// files (or `move.abort` drops them). Each transfer is a 0700 temp directory; one left idle for
+// MOVE_TRANSFER_IDLE_MS is removed by the next call that sweeps (every move.* call does), so a
+// client that vanished mid-move leaves nothing for long.
+import { randomUUID } from 'node:crypto'
+import { mkdtemp, open, rm } from 'node:fs/promises'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import {
+  MAX_MOVE_CHUNK_BYTES,
+  MAX_MOVE_HISTORY_SESSION_BYTES,
+  MAX_MOVE_SESSIONS,
+  MAX_MOVE_TRANSFER_BYTES,
+  MAX_MOVE_TRANSFERS,
+  MOVE_TRANSFER_IDLE_MS
+} from '../../../src/shared/move.ts'
+import { codedError } from '../errors.ts'
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
+const TRANSFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
+const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
+
+interface Transfer {
+  dir: string
+  projectId: string
+  repoId: string
+  /** agentSessionId → bytes written so far */
+  sizes: Map<string, number>
+  total: number
+  usedAt: number
+  /** An upload is writing: a second one for the transfer waits its turn by being refused */
+  busy: boolean
+}
+
+/** What `move.receive` takes: the staged files, by agent session id. */
+export interface StagedHistories {
+  file(agentSessionId: string): string | undefined
+  size(agentSessionId: string): number
+  /** Removes the transfer's directory */
+  discard(): Promise<void>
+}
+
+export class MoveTransfers {
+  private readonly transfers = new Map<string, Transfer>()
+  private readonly now: () => number
+
+  constructor(now: () => number = Date.now) {
+    this.now = now
+  }
+
+  /** Drops every transfer idle for longer than MOVE_TRANSFER_IDLE_MS. */
+  async sweep(): Promise<void> {
+    const cutoff = this.now() - MOVE_TRANSFER_IDLE_MS
+    for (const [id, t] of this.transfers) {
+      if (t.usedAt < cutoff && !t.busy) {
+        this.transfers.delete(id)
+        await rm(t.dir, { recursive: true, force: true })
+      }
+    }
+  }
+
+  async begin(projectId: string, repoId: string): Promise<string> {
+    await this.sweep()
+    if (this.transfers.size >= MAX_MOVE_TRANSFERS) throw codedError('CAPACITY', `at most ${MAX_MOVE_TRANSFERS} moves can upload at once; try again shortly`)
+    const id = randomUUID()
+    const dir = await mkdtemp(join(tmpdir(), 'trek-move-'))
+    this.transfers.set(id, { dir, projectId, repoId, sizes: new Map(), total: 0, usedAt: this.now(), busy: false })
+    return id
+  }
+
+  private get(transferId: unknown): Transfer {
+    if (typeof transferId !== 'string' || !TRANSFER_ID.test(transferId)) throw bad('transferId must be what move.begin returned')
+    const t = this.transfers.get(transferId)
+    if (!t) throw codedError('NOT_FOUND', 'No such transfer (it finished, was aborted, or sat idle too long)')
+    return t
+  }
+
+  /** Appends one chunk at `offset`, which must be what is already staged for the session. Returns the new size. */
+  async append(transferId: unknown, agentSessionId: unknown, offset: unknown, data: unknown): Promise<number> {
+    await this.sweep()
+    const t = this.get(transferId)
+    if (typeof agentSessionId !== 'string' || !SESSION_ID.test(agentSessionId)) throw bad('agentSessionId must be a session id')
+    if (typeof data !== 'string' || !BASE64.test(data) || data.length % 4 !== 0) throw bad('data must be base64')
+    const bytes = Buffer.from(data, 'base64')
+    if (bytes.length === 0) throw bad('data must not be empty')
+    if (bytes.length > MAX_MOVE_CHUNK_BYTES) throw bad(`a chunk must be at most ${MAX_MOVE_CHUNK_BYTES} bytes`)
+    const size = t.sizes.get(agentSessionId)
+    if (size === undefined && t.sizes.size >= MAX_MOVE_SESSIONS) throw bad(`a move carries at most ${MAX_MOVE_SESSIONS} histories`)
+    const at = size ?? 0
+    if (offset !== at) throw codedError('CONFLICT', `the next chunk of ${agentSessionId} starts at ${at}, not ${String(offset)}`)
+    if (at + bytes.length > MAX_MOVE_HISTORY_SESSION_BYTES) throw bad(`a history must be at most ${MAX_MOVE_HISTORY_SESSION_BYTES} bytes`)
+    if (t.total + bytes.length > MAX_MOVE_TRANSFER_BYTES) throw bad(`a move carries at most ${MAX_MOVE_TRANSFER_BYTES} bytes of histories`)
+    if (t.busy) throw codedError('CONFLICT', 'another chunk of this transfer is being written; send them one at a time')
+    t.busy = true
+    try {
+      const handle = await open(join(t.dir, `${agentSessionId}.jsonl`), at === 0 ? 'w' : 'a', 0o600)
+      try {
+        await handle.write(bytes)
+      } finally {
+        await handle.close()
+      }
+      t.sizes.set(agentSessionId, at + bytes.length)
+      t.total += bytes.length
+      t.usedAt = this.now()
+      return at + bytes.length
+    } finally {
+      t.busy = false
+    }
+  }
+
+  /** Ends the transfer for `move.receive` (for this project and repository only); the caller discards it. */
+  take(transferId: unknown, projectId: string, repoId: string): StagedHistories {
+    const t = this.get(transferId)
+    if (t.projectId !== projectId || t.repoId !== repoId) throw bad('the transfer was begun for another repository')
+    if (t.busy) throw codedError('CONFLICT', 'a chunk of this transfer is still being written')
+    this.transfers.delete(transferId as string)
+    return {
+      file: (id) => (t.sizes.has(id) ? join(t.dir, `${id}.jsonl`) : undefined),
+      size: (id) => t.sizes.get(id) ?? 0,
+      discard: () => rm(t.dir, { recursive: true, force: true })
+    }
+  }
+
+  /** Drops a transfer; an unknown or finished one is fine (the client may abort after a lost answer). */
+  async abort(transferId: unknown): Promise<void> {
+    if (typeof transferId !== 'string') return
+    const t = this.transfers.get(transferId)
+    if (!t || t.busy) return
+    this.transfers.delete(transferId)
+    await rm(t.dir, { recursive: true, force: true })
+  }
+
+  /** Every staged directory, for shutdown */
+  async clear(): Promise<void> {
+    const all = [...this.transfers.values()]
+    this.transfers.clear()
+    await Promise.all(all.map((t) => rm(t.dir, { recursive: true, force: true })))
+  }
+
+  get size(): number {
+    return this.transfers.size
+  }
+}
+
+/** The server's one store of staged transfers */
+export const moveTransfers = new MoveTransfers()
diff --git a/server/src/server.ts b/server/src/server.ts
index a859a18..52a21b2 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -36,6 +36,7 @@ import { LoginLimiter, parseCookies, sameOrigin, SESSION_COOKIE, WebSessions } f
 import { createWebHandler } from './web/http'
 import { sweepEvery, WebSocketSignIns } from './web/sockets'
 import type { WebBundle } from './web/bundle'
+import { moveTransfers } from './move/transfers'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -478,6 +479,8 @@ export function startServer(
     poller.stop()
     prWatch?.stop()
     sessions.stopAll()
+    // A move's staged histories (5d) are only of use to the connection that was sending them.
+    void moveTransfers.clear()
     store.off('change', onConfigChange)
     serverState.stop()
     projectsSetup.store.off('health', serverState.refresh)
diff --git a/src/renderer/src/v2/moveFlow.ts b/src/renderer/src/v2/moveFlow.ts
index 08ecbce..b0d8969 100644
--- a/src/renderer/src/v2/moveFlow.ts
+++ b/src/renderer/src/v2/moveFlow.ts
@@ -13,6 +13,7 @@ export const MOVE_STEPS = [
   { key: 'unload', label: 'Stop the sessions on the source' },
   { key: 'export', label: 'Read the uncommitted work and the session histories' },
   { key: 'push', label: 'Push the branch to origin' },
+  { key: 'histories', label: 'Copy the session histories' },
   { key: 'receive', label: 'Create the worktree on the target' },
   { key: 'finish', label: 'Remove the source worktree' }
 ] as const
@@ -51,6 +52,14 @@ export type MoveOutcome =
 
 class Cancelled extends Error {}
 
+/** Bytes in a base64 string */
+export function base64Bytes(data: string): number {
+  if (!data) return 0
+  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
+}
+
+const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
+
 export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
   const { source, target, from, to } = deps
   let step: MoveStepKey = 'unload'
@@ -64,6 +73,11 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
     if (unloaded) await source('worktree.load', from).catch(() => {})
   }
   let exported: MethodResultsV2['move.export']
+  /** The target's staged upload, once begun; dropped on any failure before `move.receive` takes it */
+  let transferId: string | undefined
+  const abort = async (): Promise<void> => {
+    if (transferId) await target('move.abort', { transferId }).catch(() => {})
+  }
   try {
     begin('unload')
     if (deps.loaded) {
@@ -80,9 +94,34 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
     begin('push')
     await source('worktree.push', { ...from, setUpstream: true }, { timeoutMs: STEP_MS })
     deps.progress('push', 'done')
+
+    // Each history in its own chunks, one at a time and in order: the target appends at its offset.
+    begin('histories')
+    if (exported.sessions.length === 0) deps.progress('histories', 'skipped', 'no session history to copy')
+    else {
+      transferId = (await target('move.begin', to)).transferId
+      const total = exported.sessions.reduce((n, s) => n + s.historyBytes, 0)
+      let copied = 0
+      for (const session of exported.sessions) {
+        let offset = 0
+        for (;;) {
+          if (deps.cancelled()) throw new Cancelled('Cancelled')
+          const chunk = await source('move.history', { ...from, agentSessionId: session.agentSessionId, offset }, { timeoutMs: STEP_MS })
+          const bytes = base64Bytes(chunk.data)
+          if (bytes > 0) await target('move.upload', { transferId, agentSessionId: session.agentSessionId, offset, data: chunk.data }, { timeoutMs: STEP_MS })
+          offset += bytes
+          copied += bytes
+          deps.progress('histories', 'active', `${mb(copied)} of ${mb(total)}`)
+          if (chunk.done) break
+          if (bytes === 0) throw new Error(`the history of “${session.title}” stopped at ${offset} of ${chunk.total} bytes`)
+        }
+      }
+      deps.progress('histories', 'done', `${exported.sessions.length} session histor${exported.sessions.length === 1 ? 'y' : 'ies'}, ${mb(total)}`)
+    }
     begin('receive')
   } catch (err) {
     if (!(err instanceof Cancelled)) deps.progress(step, 'failed', errorText(err))
+    await abort()
     await restore()
     return { kind: 'failed', step, error: err instanceof Cancelled ? 'Cancelled' : errorText(err) }
   }
@@ -98,11 +137,12 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
       branchData = rest
       kept.push("The branch's Docker .env was not carried: the target server has no environments")
     }
-    received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData }, { timeoutMs: STEP_MS })
+    received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData, ...(transferId ? { transferId } : {}) }, { timeoutMs: STEP_MS })
   } catch (err) {
     deps.progress('receive', 'failed', errorText(err))
     // A refusal undid itself on the target. A lost answer may not have.
     if (errorCode(err) === 'NOT_CONNECTED' || errorCode(err) === 'TIMEOUT') {
+      await abort()
       return { kind: 'unknown', error: `${errorText(err)}. The target may have created the worktree: check it before trying again. The source was not changed.` }
     }
     await restore()
diff --git a/src/shared/move.ts b/src/shared/move.ts
index 6c3ab2b..eeb77c9 100644
--- a/src/shared/move.ts
+++ b/src/shared/move.ts
@@ -4,12 +4,24 @@
 import type { LlmSelection } from './providers/types.ts'
 
 /**
- * The uncommitted work travels as one `git diff --binary` patch inside a protocol frame (16 MiB on
- * the server). The patch and the Claude histories share what is left of it.
+ * The uncommitted work travels as one `git diff --binary` patch inside `move.export`'s answer (a
+ * frame is 16 MiB on the server).
  */
 export const MAX_MOVE_PATCH_BYTES = 8 * 1024 * 1024
-/** All carried session histories together */
-export const MAX_MOVE_HISTORY_BYTES = 6 * 1024 * 1024
+/**
+ * Each Claude history travels in its own requests, in chunks of at most this many bytes (base64
+ * in the frame, so a third larger): `move.history` reads one on the source, `move.upload` stages
+ * it on the target.
+ */
+export const MAX_MOVE_CHUNK_BYTES = 4 * 1024 * 1024
+/** One session's history; a bigger one is listed as not carried */
+export const MAX_MOVE_HISTORY_SESSION_BYTES = 64 * 1024 * 1024
+/** All of one move's staged histories together on the target */
+export const MAX_MOVE_TRANSFER_BYTES = 512 * 1024 * 1024
+/** Moves uploading at once on one target */
+export const MAX_MOVE_TRANSFERS = 4
+/** A staged transfer nobody has written to for this long is removed */
+export const MOVE_TRANSFER_IDLE_MS = 10 * 60_000
 /** Sessions one move carries (a project holds at most 500) */
 export const MAX_MOVE_SESSIONS = 50
 
@@ -46,8 +58,9 @@ export interface MoveSession {
   llm: LlmSelection
   /** The agent's own id, the history file's name */
   agentSessionId: string
-  /** The `.jsonl` history, as Claude wrote it under the old path */
-  history: string
+  /** The `.jsonl` history's size and sha256 (hex), as Claude wrote it under the old path; its bytes go by `move.history` and `move.upload` */
+  historyBytes: number
+  historySha256: string
   sessionTypeName?: string
   systemPrompt?: string
   complete?: boolean
@@ -78,6 +91,14 @@ export interface MoveExport {
   branchData: MoveBranchData
 }
 
+/** One chunk of a history (`move.history`): `data` is base64 of the bytes at `offset`; `done` once it reaches `total`. */
+export interface MoveHistoryChunk {
+  data: string
+  offset: number
+  total: number
+  done: boolean
+}
+
 /** One place on the target server the worktree can go (`move.candidates`). */
 export interface MoveCandidate {
   projectId: string
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index b54a6a2..d399343 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -3,7 +3,7 @@
 // domain commands and subscribe to topics (snapshot + JSON patches). See PROTOCOL.md. This file is
 // the single source of truth for frame shapes. (Protocol v1, the per-call git and pty methods of
 // the file windows, was retired in phase 4e: a v1 hello is refused with UPGRADE_CLIENT.)
-import type { MoveBranchData, MoveCandidate, MoveExport, MovePlan, MoveReceived, MoveSession } from './move.ts'
+import type { MoveBranchData, MoveCandidate, MoveExport, MoveHistoryChunk, MovePlan, MoveReceived, MoveSession } from './move.ts'
 import type {
   AttentionTopic,
   ProjectTopic,
@@ -207,8 +207,9 @@ export const CAPABILITY = {
    */
   review: 'review',
   /**
-   * Moving a worktree between servers (5d): `move.prepare`, `move.export` and `move.finish` on the
-   * source, `move.candidates` and `move.receive` on the target; the app relays between them
+   * Moving a worktree between servers (5d): `move.prepare`, `move.export`, `move.history` and
+   * `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort` and
+   * `move.receive` on the target; the app relays between them
    */
   move: 'move'
 } as const
@@ -461,12 +462,20 @@ export interface MethodParamsV2 {
   'move.prepare': WorktreeRef
   /** Source: HEAD, the uncommitted work, the Claude histories and the branch data of an unloaded worktree */
   'move.export': WorktreeRef
+  /** Source: one chunk of a carried session's history, from `offset` */
+  'move.history': WorktreeRef & { agentSessionId: string; offset: number }
+  /** Target: opens a transfer for one move's histories */
+  'move.begin': RepoRef
+  /** Target: appends a chunk (base64) to one history in the transfer, at `offset` (what is staged so far) */
+  'move.upload': { transferId: string; agentSessionId: string; offset: number; data: string }
+  /** Target: drops a transfer; an unknown one is fine */
+  'move.abort': { transferId: string }
   /** Source: removes the worktree if it is unchanged since `move.export` (its `fingerprint`); else CONFLICT */
   'move.finish': WorktreeRef & { fingerprint: string }
   /** Target: where a branch of a repository with this origin can go, in every project */
   'move.candidates': { origin: string; branch: string }
   /** Target: builds the worktree from origin and the export, or undoes all of it */
-  'move.receive': RepoRef & { branch: string; head: string; patch: string; sessions: MoveSession[]; branchData: MoveBranchData }
+  'move.receive': RepoRef & { branch: string; head: string; patch: string; sessions: MoveSession[]; branchData: MoveBranchData; transferId?: string }
 
   // Subscriptions
   'sub.subscribe': { topic: Topic }
@@ -585,6 +594,10 @@ export interface MethodResultsV2 {
   'skills.list': SkillInfo[]
   'move.prepare': MovePlan
   'move.export': MoveExport & { fingerprint: string }
+  'move.history': MoveHistoryChunk
+  'move.begin': { transferId: string }
+  'move.upload': { size: number }
+  'move.abort': null
   'move.finish': null
   'move.candidates': MoveCandidate[]
   'move.receive': MoveReceived
````

</details>


## Task 8: tearing down the source's VM and dev stack (User decision 6)

**Prototype commit:** `e94ea4a` on `central-server-phase5d-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `scripts/moveFlow.test.mjs`
- Modify: `scripts/server-move-smoke.mjs`
- Modify: `scripts/serverMove.test.mjs`
- Modify: `server/src/move/moveHandlers.ts`
- Modify: `src/renderer/src/components/MoveWorktreeModal.tsx`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/v2/moveFlow.ts`
- Modify: `src/shared/protocolV2.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 7b119b3, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverMove.test.mjs scripts/moveFlow.test.mjs   # 15 + 13 pass
npx tsc --noEmit
npm run smoke:server-move                                           # 29 checks
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5d): the VM and dev stack torn down as Delete does, only after the target is verified (move.finish verifyOnly) and before the source's folder goes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 3d89f6d..8662ede 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -717,7 +717,12 @@ The client's order, and what each step leaves behind when it fails:
    on the target, and the source is loaded again.
 6. `move.receive` on the target, with the `transferId`: builds the worktree, or undoes everything it
    did and fails. Either way it takes the transfer and removes its staged files.
-7. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
+7. Only when the client tears the source's Docker VM or dev stack down (the user ticked it): `move.finish`
+   `{verifyOnly: true}` on the source (the same checks, nothing removed; on `CONFLICT` or `IN_USE`
+   as below), then `env.destroy` and `stack.destroy` on the source. This is the point of
+   commitment: they are never torn down before the target has the worktree and the source is
+   checked unchanged, and they need the worktree's folder, so they come before step 8.
+8. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
    `CONFLICT` or `IN_USE` the client removes the target's copy again (`worktree.remove` `{force:
    true}`; the branch it created there stays) and loads the source again.
 
@@ -726,7 +731,7 @@ The client's order, and what each step leaves behind when it fails:
 | `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
 | `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, historyBytes, historySha256, sessionTypeName?, systemPrompt?, complete?}` (the history's bytes travel by `move.history`). `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?, env?}`, the tags by name, `env` the branch's Docker `.env` text (a client leaves it out for a target without `env`). `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
 | `move.history` | `{projectId, worktreeId, agentSessionId, offset}` | `{data, offset, total, done}`: base64 of at most 4 MiB of the session's history from byte `offset`; `done` once `offset` plus the chunk reaches `total`. Only a carried session (a Claude one with a saved history of at most 64 MiB) of an unloaded worktree (`IN_USE`; `NOT_FOUND` for another session; `BAD_REQUEST` for an offset past the end) |
-| `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
+| `move.finish` | `{projectId, worktreeId, fingerprint, verifyOnly?}` | `null`: with `verifyOnly`, only the checks below, nothing removed; else the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
 | `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
 | `move.begin` | `{projectId, repoId}` | `{transferId}`: a staged upload for one move into this repository: a 0700 temp directory on the target. At most 4 at once (`CAPACITY`); one nobody has written to for 10 minutes is removed (swept by every later `move.begin`, `move.upload` and `move.receive`) |
 | `move.upload` | `{transferId, agentSessionId, offset, data}` | `{size}`: appends `data` (base64, 1 byte to 4 MiB) to that session's staged history. `offset` must be what is staged for it so far (else `CONFLICT`), so chunks go one at a time, in order. At most 64 MiB a session, 50 sessions and 512 MiB a transfer (`BAD_REQUEST`); `NOT_FOUND` for a finished, aborted or swept transfer |
@@ -753,8 +758,10 @@ two alike), each history 1 byte to 64 MiB, an 8 MiB patch, the project's 500 ses
 What moves: the commits (through origin), the uncommitted work (unstaged), Claude sessions that
 have a saved history of at most 64 MiB (copied, not moved: the source's file stays), the note, the workflow and custom
 tags (by name), the ticket, the pull request link and its watch, the branch's Docker `.env` text. What does not: other agents'
-sessions (closed with the source), queued prompts, the review draft, a Docker environment or dev
-stack running for it on the source's machine, and the staged/unstaged split.
+sessions (closed with the source), queued prompts, the review draft, and the staged/unstaged
+split. A Docker environment (VM) or dev stack for it on the source's machine is not moved: the app
+tears it down (step 7) when the user leaves "Tear down its VM and stack" ticked, and refuses to
+move while one runs when they untick it (a stopped one then stays behind).
 
 ## Sessions
 
diff --git a/README.md b/README.md
index 07ffc4d..519cee4 100644
--- a/README.md
+++ b/README.md
@@ -231,7 +231,9 @@ other window on that project sees them live.
   the uncommitted work goes along as a patch (all of it unstaged), Claude sessions'
   histories are copied so they resume there, and the note, tags, ticket, pull request,
   its watch and the branch's Docker .env come too. Other agents' sessions, queued prompts and the review draft
-  do not. The old worktree is removed last, and only if nothing changed in it while it
+  do not. Its Docker VM and dev stack, if it has them, are torn down on the old server
+  once the new worktree is in place (a ticked-by-default checkbox; unticked, the move
+  waits until they are stopped). The old worktree is removed last, and only if nothing changed in it while it
   was copied; a failure before that leaves it as it was. The web client never offers
   it (it has one server).
 - **This machine's features, in Local windows only**: a window on the [Local
diff --git a/scripts/moveFlow.test.mjs b/scripts/moveFlow.test.mjs
index be250ac..d3a8b04 100644
--- a/scripts/moveFlow.test.mjs
+++ b/scripts/moveFlow.test.mjs
@@ -158,3 +158,35 @@ test('a move with no carried session copies nothing and sends no transfer', asyn
   assert.deepEqual(target.methods(), ['move.receive'])
   assert.equal(target.calls[0][1].transferId, undefined)
 })
+
+test('the teardown runs only after the target has it and the source checks unchanged, before the source goes', async () => {
+  const order = []
+  const source = src({ 'move.finish': (p) => { order.push(p.verifyOnly ? 'verify' : 'finish'); return null } })
+  const target = tgt({ 'move.receive': () => { order.push('receive'); return { worktreeId: 'wb', dropped: [] } } })
+  const result = await run(source, target, { teardown: async () => { order.push('teardown'); return [] } }).outcome
+  assert.equal(result.kind, 'moved')
+  assert.deepEqual(order, ['receive', 'verify', 'teardown', 'finish'])
+})
+
+test('a source changed before the teardown: nothing is torn down and the target copy goes', async () => {
+  let tornDown = false
+  const source = src({ 'move.finish': (p) => { if (p.verifyOnly) throw new ClientError('CONFLICT', 'it changed'); return null } })
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const result = await run(source, target, { teardown: async () => { tornDown = true; return [] } }).outcome
+  assert.deepEqual([result.kind, result.step], ['failed', 'teardown'])
+  assert.equal(tornDown, false)
+  assert.equal(target.methods().at(-1), 'worktree.remove')
+  assert.equal(source.methods().at(-1), 'worktree.load')
+})
+
+test('teardown warnings become notes; a change after the teardown keeps both copies', async () => {
+  const warned = await run(src(), tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } }), { teardown: async () => ['stack.sh destroy exited with code 1.'] }).outcome
+  assert.equal(warned.kind, 'moved')
+  assert.ok(warned.notes.includes('stack.sh destroy exited with code 1.'))
+  const target = tgt({ 'move.receive': { worktreeId: 'wb', dropped: [] } })
+  const late = src({ 'move.finish': (p) => { if (!p.verifyOnly) throw new ClientError('CONFLICT', 'changed by the teardown'); return null } })
+  const both = await run(late, target, { teardown: async () => [] }).outcome
+  assert.equal(both.kind, 'both')
+  assert.match(both.error, /torn down/)
+  assert.ok(!target.methods().includes('worktree.remove'))
+})
diff --git a/scripts/server-move-smoke.mjs b/scripts/server-move-smoke.mjs
index 8282246..134b9a0 100644
--- a/scripts/server-move-smoke.mjs
+++ b/scripts/server-move-smoke.mjs
@@ -9,6 +9,8 @@
 // own clone. The built app runs with a temp HOME and --user-data-dir, no Local server, main's
 // dialogs stubbed, both servers saved; A's project window moves the worktree. It checks:
 //   - both welcomes list move; the window offers Move to another server… (B is saved);
+//   - the dialog offers to tear down the worktree's running dev stack (ticked); unticked, Move is
+//     refused; the stack is destroyed on A only after B has the worktree, A's folder still there;
 //   - the dialog lists B's project (same origin), the new path, the session that moves and the
 //     queued prompt that doesn't; a branch already checked out on B is a blocked place;
 //   - the move: the steps all done (a Claude history over 16 MiB copied in chunks, byte for byte,
@@ -65,6 +67,16 @@ for (const dir of [appHome, userData]) mkdirSync(dir, { recursive: true })
 const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
 const claudeDir = (home, cwd) => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
 
+// docker and colima stubs first on both servers' PATH (no real docker or colima ever runs): docker
+// ps lists one container while the file `stack-running` exists, so the dev stack reads as running.
+const machineStubs = join(work, 'machine-stubs')
+const machineCalls = join(work, 'machine-calls.log')
+const stackRunning = join(work, 'stack-running')
+mkdirSync(machineStubs)
+writeFileSync(join(machineStubs, 'docker'), `#!/bin/sh\necho "docker $*" >> '${machineCalls}'\nif [ "$1" = ps ] && [ -e '${stackRunning}' ]; then echo c0ffee; fi\nexit 0\n`, { mode: 0o755 })
+writeFileSync(join(machineStubs, 'colima'), `#!/bin/sh\necho "colima $*" >> '${machineCalls}'\nexit 0\n`, { mode: 0o755 })
+const stackCalls = join(work, 'stack-calls.log')
+
 const origin = join(work, 'origin.git')
 git('init', '-q', '--bare', origin)
 const fakeAgent = join(work, 'fake-agent.sh')
@@ -86,6 +98,10 @@ const A = serverFiles('a')
 const B = serverFiles('b')
 git('init', '-q', '-b', 'main', A.repo)
 writeFileSync(join(A.repo, 'README'), 'one\n')
+// A dev stack: stack.sh records each call and the folder it ran in.
+writeFileSync(join(A.repo, '.gitignore'), '.trek/\n')
+mkdirSync(join(A.repo, 'docker', 'stack'), { recursive: true })
+writeFileSync(join(A.repo, 'docker', 'stack', 'stack.sh'), `#!/bin/sh\necho "$1|$(pwd -P)|$( [ -f .git ] && echo present )|$( [ -d '${B.repo}-feature-x' ] && echo on-b )" >> '${stackCalls}'\nexit 0\n`, { mode: 0o755 })
 git('-C', A.repo, 'add', '.')
 git('-C', A.repo, 'commit', '-q', '-m', 'init')
 git('-C', A.repo, 'remote', 'add', 'origin', origin)
@@ -163,7 +179,7 @@ async function start(s) {
   await new Promise((resolve, reject) => {
     const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', s.configPath, '--port', String(port), '--data-dir', s.data], {
       cwd: join(root, 'server'),
-      env: { ...process.env, HOME: s.home, XDG_STATE_HOME: join(s.home, '.local', 'state'), SHELL: '/bin/sh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
+      env: { ...process.env, PATH: `${machineStubs}:${process.env.PATH}`, HOME: s.home, XDG_STATE_HOME: join(s.home, '.local', 'state'), SHELL: '/bin/sh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
       stdio: ['ignore', 'pipe', 'pipe']
     })
     daemons.push(d)
@@ -214,6 +230,9 @@ try {
   git('-C', sourcePath, 'add', '.')
   git('-C', sourcePath, 'commit', '-q', '-m', 'feature')
   const head = git('-C', sourcePath, 'rev-parse', 'HEAD').trim()
+  // The stack has run here (.trek/stack, ignored) and is running (docker ps lists a container).
+  mkdirSync(join(sourcePath, '.trek', 'stack'), { recursive: true })
+  writeFileSync(stackRunning, '')
   writeFileSync(join(sourcePath, 'README'), 'one\nedited\n')
   writeFileSync(join(sourcePath, 'staged.txt'), 'staged\n')
   git('-C', sourcePath, 'add', 'staged.txt')
@@ -291,7 +310,14 @@ try {
     lines.some((l) => l.includes('1 queued prompt(s) are not moved')),
     lines.some((l) => l.includes('running sessions are stopped first'))
   ], [true, true, true])
+  const teardownBox = modal.locator('.move-teardown input')
+  await teardownBox.waitFor({ timeout: 10_000 })
+  check('the dialog offers to tear down its running dev stack, ticked', [await teardownBox.isChecked(), (await modal.locator('.move-teardown').textContent()).includes('dev stack “trek-')], [true, true])
   await modal.locator('.move-row select').first().selectOption({ label: 'Server B' })
+  await modal.locator('.move-path').waitFor({ timeout: 10_000 })
+  await teardownBox.uncheck()
+  check('unticked while the stack runs, the move is refused', [await modal.locator('button', { hasText: 'Move worktree' }).isDisabled(), (await modal.locator('.move-summary').textContent()).includes('It is running: stop it first')], [true, true])
+  await teardownBox.check()
   check('B\'s project is offered, with the new path', await until(() => modal.locator('.move-path').textContent().catch(() => null), `New worktree: ${targetPath}`), `New worktree: ${targetPath}`)
   check('the place is On B — app', (await modal.locator('.move-row select').nth(1).locator('option:checked').textContent()).trim(), 'On B — app')
 
@@ -299,7 +325,8 @@ try {
 
   await modal.locator('button', { hasText: 'Move worktree' }).click()
   check('the move reports success', await until(() => modal.locator('.server-test-result.ok').count(), 1, 60_000), 1)
-  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done', 'done'])
+  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done', 'done', 'done'])
+  check("the dev stack was destroyed on A after B had it, while A's folder was still there", readFileSync(stackCalls, 'utf8').split('\n').filter((l) => l.startsWith('destroy')), [`destroy|${sourcePath}|present|on-b`])
   check('the history step copied the whole 17 MB', (await modal.locator('.move-step.done', { hasText: 'Copy the session histories' }).locator('.move-step-detail').textContent()).includes('1 session history, 17.0 MB'), true)
   check('origin has the branch at the source commit', git('--git-dir', origin, 'rev-parse', 'refs/heads/feature-x').trim(), head)
   check('B has the worktree on the same commit', existsSync(targetPath) && git('-C', targetPath, 'rev-parse', 'HEAD').trim(), head)
@@ -326,6 +353,7 @@ try {
 
   const held = await Promise.all(app.windows().map((w) => w.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))))
   check("no window's store or page holds either server's token", held.some((h) => h.includes(A.token) || h.includes(B.token)), false)
+  check('docker ran only as the stub, for the stack status (never colima up or delete)', readFileSync(machineCalls, 'utf8').split('\n').filter(Boolean).every((l) => l.startsWith('docker ps') || l.startsWith('colima list')), true)
   check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
   check('no console or page errors', pageErrors, [])
   exitCode = failedChecks.length ? 1 : 0
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
index bd7f4a8..c0b6de3 100644
--- a/scripts/serverMove.test.mjs
+++ b/scripts/serverMove.test.mjs
@@ -264,7 +264,11 @@ test('move.receive undoes the worktree, the branch and the histories when the pa
 test('move.finish keeps a source that changed after the export', async (t) => {
   const s = await setup(t)
   const exported = (await s.A.call('move.export', s.ref)).result
+  const checked = await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint, verifyOnly: true })
+  assert.equal(checked.ok, true, JSON.stringify(checked))
+  assert.ok(existsSync(s.path), 'verifyOnly removes nothing')
   writeFileSync(join(s.path, 'later.txt'), 'typed after the copy\n')
+  assert.equal((await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint, verifyOnly: true })).error?.code, 'CONFLICT')
   const res = await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint })
   assert.equal(res.error?.code, 'CONFLICT')
   assert.ok(existsSync(join(s.path, 'later.txt')))
diff --git a/server/src/move/moveHandlers.ts b/server/src/move/moveHandlers.ts
index e241565..769876e 100644
--- a/server/src/move/moveHandlers.ts
+++ b/server/src/move/moveHandlers.ts
@@ -338,11 +338,13 @@ export const moveHandlers: Record<string, Handler> = {
   /**
    * The last step, once the target has the worktree: the source's copy is removed (force) only if
    * its HEAD and uncommitted work are what was exported; otherwise CONFLICT and nothing changes.
-   * Its PR watch ends (the target watches it now).
+   * Its PR watch ends (the target watches it now). `verifyOnly`: the same checks, nothing removed
+   * (the app asks before it tears the source's VM and dev stack down, the point of commitment).
    */
   'move.finish': async (p, ctx): Promise<null> => {
     const expected = requireString(p.fingerprint, 'fingerprint')
     if (!FINGERPRINT.test(expected)) throw bad('fingerprint must be what move.export returned')
+    if (p.verifyOnly !== undefined && typeof p.verifyOnly !== 'boolean') throw bad('verifyOnly must be a boolean')
     const { repo, worktree, branch } = await source(ctx, p)
     if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} was loaded again after it was copied; it is kept`)
     const unblock = ctx.sessions.blockPath(worktree.path)
@@ -351,6 +353,7 @@ export const moveHandlers: Record<string, Handler> = {
       if (fingerprint(headSha, patch) !== expected) {
         throw codedError('CONFLICT', `${worktree.path} changed after it was copied; it is kept`)
       }
+      if (p.verifyOnly === true) return null
       await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
       await ctx.poller.refresh(repo.path)
     } finally {
diff --git a/src/renderer/src/components/MoveWorktreeModal.tsx b/src/renderer/src/components/MoveWorktreeModal.tsx
index 0f8db7e..12a96c7 100644
--- a/src/renderer/src/components/MoveWorktreeModal.tsx
+++ b/src/renderer/src/components/MoveWorktreeModal.tsx
@@ -3,7 +3,11 @@
 // (v2/moveFlow.ts) step by step. The source is this window's server; the target is reached through
 // the same main-process relay as every server window, so no token is in this window.
 import { useEffect, useMemo, useRef, useState } from 'react'
-import { useAppStore } from '../store'
+import { environmentFor, repoOfInfo, useAppStore } from '../store'
+import { getBackend } from '../backend'
+import { useFeatures } from '../useFeatures'
+import { destroyEnvironmentIfAny } from '../environmentActions'
+import { envRepoKey } from '../../../shared/environments'
 import { errorText } from '../v2/errors'
 import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
 import { MOVE_STEPS, moveWorktree, type MoveOutcome, type MoveStepKey, type MoveStepStatus, type Requester } from '../v2/moveFlow'
@@ -12,10 +16,13 @@ import type { MoveCandidate, MovePlan } from '../../../shared/move'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { moveTargets } from '../v2/moveFlow'
 import type { RegisteredServer } from '../../../shared/client/index'
+import type { GitWorktreeInfo, StackStatus } from '../../../shared/types'
 
 interface Props {
   /** The worktree on this window's server */
   from: { projectId: string; worktreeId: string }
+  /** The worktree as the window lists it: its path and branch, for its VM and dev stack */
+  info: GitWorktreeInfo
   name: string
   onClose: () => void
 }
@@ -51,7 +58,7 @@ function connected(server: RegisteredServer, ms = 15_000): Promise<string[]> {
   })
 }
 
-export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Element {
+export function MoveWorktreeModal({ from, info, name, onClose }: Props): React.JSX.Element {
   const serverWindow = useAppStore((s) => s.serverWindow)
   const ownEntry = serverWindow?.serverEntryId ?? ''
   const [plan, setPlan] = useState<MovePlan | null>(null)
@@ -70,6 +77,40 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
 
   const source = useMemo(() => (ownEntry ? registeredServerEntry(ownEntry) : undefined), [ownEntry])
 
+  // The worktree's Docker VM and dev stack on the source's machine (the same ones Delete tears down).
+  const features = useFeatures()
+  const project = useAppStore((s) => s.project)
+  const environments = useAppStore((s) => s.environments)
+  const repo = project ? (() => { try { return repoOfInfo(project, info) } catch { return undefined } })() : undefined
+  const env = features.env && repo ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
+  const [stack, setStack] = useState<StackStatus | null>(null)
+  useEffect(() => {
+    if (!features.stacks) return
+    getBackend().stacks.status({ path: info.path }).then(setStack, () => setStack(null))
+  }, [features.stacks, info.path])
+  const stackName = stack?.available && stack.created ? stack.slug : undefined
+  const machine = [env ? `its VM “${env.profile}”` : null, stackName ? `its dev stack “trek-${stackName}”` : null].filter(Boolean).join(' and ')
+  const machineRunning = env?.vmState === 'running' || (!!stackName && !!stack && (stack.containers > 0 || stack.upRunning))
+  const [tearDown, setTearDown] = useState(true)
+  const machineBlocks = !!machine && !tearDown && machineRunning
+  const teardown = async (): Promise<string[]> => {
+    const warnings: string[] = []
+    const backend = getBackend()
+    if (stackName) {
+      try {
+        const code = await backend.stacks.destroy({ path: info.path })
+        if (code !== 0) warnings.push(`stack.sh destroy exited with code ${code}. Remove the leftover stack on the source's machine with TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy.`)
+      } catch (err) {
+        warnings.push(`The dev stack was not destroyed: ${errorText(err)}`)
+      }
+    }
+    if (env && repo) {
+      const warning = await destroyEnvironmentIfAny(envRepoKey(repo), info.branch, backend)
+      if (warning) warnings.push(`${warning} It is listed under Orphaned environments in Settings.`)
+    }
+    return warnings
+  }
+
   useEffect(() => {
     if (!source) return
     source.connection
@@ -127,6 +168,7 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
       to: { projectId: chosen.projectId, repoId: chosen.repoId },
       loaded: plan.loaded,
       targetCapabilities: server.connection.welcome?.capabilities ?? [],
+      ...(machine && tearDown ? { teardown } : {}),
       progress: (step, status, detail) => setSteps((prev) => ({ ...prev, [step]: { status, detail } })),
       cancelled: () => cancelled.current
     })
@@ -201,6 +243,15 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
               {plan.reviewComments > 0 && <li className="warn">The {plan.reviewComments} unsent review comment(s) are not moved and are lost.</li>}
               {plan.queuedPrompts > 0 && <li className="warn">The {plan.queuedPrompts} queued prompt(s) are not moved and are lost.</li>}
               {plan.loaded && <li>Its running sessions are stopped first.</li>}
+              {machine && (
+                <li className={machineBlocks ? 'warn' : undefined}>
+                  <label className="move-teardown">
+                    <input type="checkbox" checked={tearDown} onChange={(e) => setTearDown(e.target.checked)} /> Tear down {machine} on this
+                    server once the worktree is in place there
+                  </label>
+                  {!tearDown && (machineRunning ? ' It is running: stop it first, or tick this, to move.' : ' Left as it is (stopped), it stays behind.')}
+                </li>
+              )}
               <li>The note, tags, ticket, pull request link and Docker .env go with it{plan.prWatch ? ', and the PR watch moves there' : ''}.</li>
             </ul>
           </>
@@ -235,7 +286,7 @@ export function MoveWorktreeModal({ from, name, onClose }: Props): React.JSX.Ele
           {phase === 'choose' && (
             <>
               <button onClick={onClose}>Cancel</button>
-              <button className="btn btn-accent" disabled={!chosen} onClick={() => void start()}>
+              <button className="btn btn-accent" disabled={!chosen || machineBlocks} onClick={() => void start()}>
                 Move worktree
               </button>
             </>
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 38c94d9..c3f2d48 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -916,7 +916,7 @@ export function WorktreeDetail({
       )}
       {showMove && info.branch && (() => {
         const from = getBackend().worktrees.moveRef(info.path)
-        return from ? <MoveWorktreeModal from={from} name={info.branch} onClose={() => setShowMove(false)} /> : null
+        return from ? <MoveWorktreeModal from={from} info={info} name={info.branch} onClose={() => setShowMove(false)} /> : null
       })()}
     </main>
   )
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 02e5dbb..b8a3d01 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -3327,6 +3327,10 @@ button:disabled {
   gap: 4px;
 }
 
+.move-teardown {
+  cursor: pointer;
+}
+
 .move-summary .warn {
   color: #f9e2af;
 }
diff --git a/src/renderer/src/v2/moveFlow.ts b/src/renderer/src/v2/moveFlow.ts
index b0d8969..2f4574c 100644
--- a/src/renderer/src/v2/moveFlow.ts
+++ b/src/renderer/src/v2/moveFlow.ts
@@ -15,6 +15,7 @@ export const MOVE_STEPS = [
   { key: 'push', label: 'Push the branch to origin' },
   { key: 'histories', label: 'Copy the session histories' },
   { key: 'receive', label: 'Create the worktree on the target' },
+  { key: 'teardown', label: 'Tear down its VM and dev stack on the source' },
   { key: 'finish', label: 'Remove the source worktree' }
 ] as const
 
@@ -38,6 +39,12 @@ export interface MoveFlowDeps {
   progress(step: MoveStepKey, status: MoveStepStatus, detail?: string): void
   /** Checked between steps, until the target starts building */
   cancelled(): boolean
+  /**
+   * The source's Docker VM and dev stack, torn down (the user ticked it) once the target has the
+   * worktree and the source is checked unchanged, before its folder goes; never earlier. Shows
+   * nothing itself: its warnings come back as notes, and the move goes on (as Delete's does).
+   */
+  teardown?: () => Promise<string[]>
 }
 
 export type MoveOutcome =
@@ -151,6 +158,23 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
   const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...kept, ...received.dropped]
   deps.progress('receive', 'done', received.dropped.length > 0 ? `${received.dropped.length} thing(s) not carried over` : undefined)
 
+  // The point of commitment: the target has it. With a teardown, the source is checked unchanged
+  // first (move.finish verifyOnly), so a VM or stack is only destroyed for a move that will finish.
+  let tornDown = false
+  if (deps.teardown) {
+    deps.progress('teardown', 'active')
+    try {
+      await source('move.finish', { ...from, fingerprint: exported.fingerprint, verifyOnly: true }, { timeoutMs: STEP_MS })
+    } catch (err) {
+      deps.progress('teardown', 'failed', errorText(err))
+      return undoTarget(err, 'teardown')
+    }
+    const warnings = await deps.teardown().catch((err: unknown) => [errorText(err)])
+    notes.push(...warnings)
+    tornDown = true
+    deps.progress('teardown', warnings.length > 0 ? 'failed' : 'done', warnings.length > 0 ? warnings.join(' ') : undefined)
+  } else deps.progress('teardown', 'skipped', 'nothing to tear down')
+
   deps.progress('finish', 'active')
   try {
     await source('move.finish', { ...from, fingerprint: exported.fingerprint }, { timeoutMs: STEP_MS })
@@ -158,19 +182,25 @@ export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
     return { kind: 'moved', worktreeId: received.worktreeId, notes }
   } catch (err) {
     const code = errorCode(err)
-    // The source changed (or was loaded) after the copy: the copy on the target is stale, so it goes.
+    deps.progress('finish', 'failed', errorText(err))
+    // Changed or loaded after the copy: the target's copy is stale and goes, unless the source's VM
+    // and stack are already gone (then both are kept, for the user to compare).
+    if ((code === 'CONFLICT' || code === 'IN_USE') && !tornDown) return undoTarget(err, 'finish')
     if (code === 'CONFLICT' || code === 'IN_USE') {
-      const undone = await target('worktree.remove', { projectId: to.projectId, worktreeId: received.worktreeId, force: true }).then(() => true, () => false)
-      deps.progress('finish', 'failed', errorText(err))
-      if (undone) {
-        await restore()
-        return { kind: 'failed', step: 'finish', error: `${errorText(err)}. The copy on the target was removed again (its branch stays there).` }
-      }
-      return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, and the copy on the target could not be removed: both servers have it now.`, notes }
+      return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, after its VM and dev stack were torn down: both servers have the worktree now. Compare them and delete one.`, notes }
     }
-    deps.progress('finish', 'failed', errorText(err))
     return { kind: 'both', worktreeId: received.worktreeId, error: `The target has the worktree, but the source's copy was not removed (${errorText(err)}). Delete it there once you have checked the target.`, notes }
   }
+
+  /** The source changed after the copy: the target's copy is removed again and the source loaded. */
+  async function undoTarget(err: unknown, at: MoveStepKey): Promise<MoveOutcome> {
+    const undone = await target('worktree.remove', { projectId: to.projectId, worktreeId: received.worktreeId, force: true }).then(() => true, () => false)
+    if (undone) {
+      await restore()
+      return { kind: 'failed', step: at, error: `${errorText(err)}. The copy on the target was removed again (its branch stays there).` }
+    }
+    return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, and the copy on the target could not be removed: both servers have it now.`, notes }
+  }
 }
 
 /**
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index d399343..c2ee602 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -471,7 +471,7 @@ export interface MethodParamsV2 {
   /** Target: drops a transfer; an unknown one is fine */
   'move.abort': { transferId: string }
   /** Source: removes the worktree if it is unchanged since `move.export` (its `fingerprint`); else CONFLICT */
-  'move.finish': WorktreeRef & { fingerprint: string }
+  'move.finish': WorktreeRef & { fingerprint: string; verifyOnly?: boolean }
   /** Target: where a branch of a repository with this origin can go, in every project */
   'move.candidates': { origin: string; branch: string }
   /** Target: builds the worktree from origin and the export, or undoes all of it */
````

</details>


## Task 9: final verification

- [ ] **Step 1: Typecheck, test, build**

```bash
npm run typecheck
cd server && npm run typecheck && cd ..
npm test            # expect 1879 tests: 1878 pass, 1 skipped, 0 failed
npm run build
```

- [ ] **Step 2: Every smoke, one at a time** (each Electron smoke uses its own temp `--user-data-dir` and HOME; every server one gets the not-signed-in stub gh)

```bash
node scripts/server-move-smoke.mjs       # 29
node scripts/server-web-smoke.mjs        # 50
node scripts/server-review-smoke.mjs     # 56
node scripts/server-prwatch-smoke.mjs    # 54
node scripts/v2-smoke.mjs                # 172
node scripts/local-app-smoke.mjs         # 45
node scripts/local-window-smoke.mjs      # 57
node scripts/local-features-smoke.mjs    # 51
node scripts/server-env-smoke.mjs        # 30
node scripts/server-integrations-smoke.mjs # 33
node scripts/providers-smoke.mjs         # 36
node scripts/windows-smoke.mjs           # 38
node scripts/import-smoke.mjs            # 63
node scripts/local-server-smoke.mjs      # 85
node scripts/client-contract.mjs
cd server && npm run build && npm run smoke -- --built
```

- [ ] **Step 3: A clean clone** typechecks and passes `npm test`.

- [ ] **Step 4: No leftovers**: `pgrep -fl trek-server` and `pgrep -fl 'sleep 300'` find nothing of the runs, and no `trek-move-*` directory of the runs is left in the temp directory.
