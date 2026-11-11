# Central Server Phase 5e: Promote to Primary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worktree's branch can be promoted into its repository's main checkout from its window (**Promote to primary…**), carrying its uncommitted work and its Claude sessions, and the main checkout's branch can be moved back into a worktree of its own (**Promote branch to worktree…**); an agent can ask for a promote with the trek-dev tool `promote_to_primary`, confirmed in a window.

**Architecture:** One server holds both checkouts, so each action is one request on it that does everything or puts everything back: `worktree.promote` and `worktree.demote` (each with `dryRun` for the confirmation's plan), behind a `promote` capability. They reuse 5d's config-proof patch (`exportDirtyPatch`, `applyPatch`, `patchDigest`) to carry the uncommitted work, switch the main checkout with `git switch --ignore-other-worktrees` (or add the worktree with `worktree add --force`) while the other checkout still has the branch, and remove the old holder only at the point of commitment. `promote_to_primary` asks the project's windows through a small broker (`promote.request` to the topic's subscribers, the first `promote.answer` wins, `promote.settled` to all); the window that confirms runs the same promote its menu item does.

**Tech Stack:** TypeScript, git (`switch --ignore-other-worktrees`, `worktree add --force`, `apply -R`, a throwaway `GIT_INDEX_FILE`), React 19 + zustand (renderer), `node:test`, Playwright's `_electron` with a built `trek-server` in the smoke.

**Prototype:** every task was built first on `central-server-phase5e-proto` (one commit per task, on master 1a64d76; Task 3 has a follow-up commit). The diffs below are those commits. An implementer applies each task's diff (the files are new or the hunks apply cleanly to master, in task order), then runs the task's checks.

---

## User decisions (2026-11-10)

1. **Both actions come back.** "Promote to primary": a worktree's branch is checked out in the repository's main checkout and the worktree removed; its sessions move to the main checkout and resume. "Promote branch to worktree": the main checkout's branch moves into a new worktree at the default path and the main checkout goes back to the default branch; its sessions move to the new worktree.
2. **The promoted worktree's uncommitted work is carried,** packed with 5d's config-proof patch and applied in the main checkout after the switch; any failure puts everything back (the worktree, the branch checkout, the sessions). The main checkout must be clean.
3. **The main checkout's own open sessions keep running,** now on the promoted branch; the worktree's sessions are added beside them and resume. The dialog says the main checkout's sessions will see the new branch.
4. **`promote_to_primary` returns, with a confirmation:** the tool asks the app, a window with the project open shows the same confirmation, and the tool returns once the user answers; refused when no window has the project open.

Also recorded (user, 2026-11-10): Windows support for the supervisor and the bot move to after phase 6 (the React Native client); the spec's §6 says so (Task 6).

## Decisions made in the plan (candidates for the user)

5. **One request each, on the server.** Unlike 5d's move there is one server, so nothing is client-relayed: `worktree.promote {projectId, worktreeId, dryRun?}` and `worktree.demote {projectId, repoId, dryRun?}` do all the git and project changes in-process, with an undo list, and answer `{worktreeId, moved, notes}`. `dryRun` runs the same checks and answers the plan the confirmation shows (`PromotePlan`, `src/shared/promote.ts`). One promote or demote per repository at a time (`CONFLICT`); the two checkouts' paths are blocked for `session.start` and `worktree.load` while one runs.
6. **A `promote` capability** (`STATIC_CAPABILITIES`) and a `promote` feature that follows it (`CAPABILITY_FOR`); the legacy `promote: false` ceiling goes. The web client gets it too: it has the window's one server, and its dialogs are in-page.
7. **Promote's order: the worktree goes last.** The legacy flow removed the worktree first (git refused the branch in two checkouts); here the clean main checkout switches with `git switch --ignore-other-worktrees`, the worktree's patch is applied there, the main checkout's own patch must match it by `patchDigest`, and only then is the worktree removed (`--force`): the point of commitment. A failure before it switches the main checkout back with `--discard-changes` (it was clean), takes the applied work off with `git apply -R`, and loads the worktree again if it was loaded.
8. **Demote's order: the main checkout leaves the branch last.** `git worktree add --force` (the main checkout still has the branch), `linkDirs`, the main checkout's patch (leaving out what the new worktree links: `exportDirtyPatch`'s new `linked` option), applied there and checked by digest, taken off the main checkout (`git apply -R`, then `git reset -q -- .` with a copy of its index kept), then `git checkout <default>`: the point of commitment. A failure before it puts the main checkout's branch, index and work back and removes the new worktree.
9. **Demote carries the main checkout's uncommitted work too** (by symmetry with decision 2; Question 1), unstaged, as a promote does. Its staged split is not kept (Risk 5).
10. **Every switch's undo is pushed before the switch,** and forced (`switch --discard-changes`, `forceCheckoutHead`): git writes the files before it moves HEAD, so a switch that fails part way (a lock, a disk error) leaves files of the other branch; only a checkout whose work is safe elsewhere is forced back (the promote's clean main checkout; the demote's, whose work the new worktree holds and the undo re-applies).
11. **Which sessions follow:** those whose agent can follow a folder change (`sessionMigrates`: Claude and Local, both Claude Code). Their history is **moved** (`migrateSession`, a rename) from `~/.claude/projects/<old path>` to the new path's folder, as the legacy did: one machine, and the old folder's checkout is gone (promote) or the session no longer runs there (demote). The session rows move whole (ids, queues, session types, system prompts, `complete`), unlike 5d's copies. Others: on a promote they are closed (their worktree goes) and named in `notes`; on a demote they stay in the main checkout (it stays).
12. **Resuming:** a promote resumes the moved sessions when either checkout was loaded; if the main checkout was not loaded, it is loaded, which resumes its own saved sessions too (the legacy did the same; Question 2). A demote loads the new worktree when the main checkout was loaded; the main checkout's other sessions keep running. New `SessionManager.suspendSessions` / `resumeSessions` stop and resume single sessions (the demote's moving ones; the promote's into an already-loaded main checkout).
13. **What else follows.** The branch data (note, tags, ticket, PR link, PR watch, `.env`) is keyed by branch on the repository, so it stays; a runtime PR notice moves to the row that now has the branch (the watcher finds the worktree by branch). The review draft moves when the other row has none, with a revision above both rows' last; otherwise a promote drops it and says so in `notes`. A demote tags a branch without a tag with the first workflow tag, as `worktree.create` does.
14. **What is lost on a promote is said first:** the plan lists the worktree's ignored files and its files flagged skip-worktree or assume-unchanged (5d's `leftBehind`), which are deleted with the worktree; an untracked nested git repository refuses the promote. The patch may be 64 MiB (`MAX_PROMOTE_PATCH_BYTES`: nothing goes over the wire) and must be UTF-8 (`exportDirtyPatch` decodes it).
15. **The teardown is Delete's.** The app reads the plan (`dryRun`), then shows the confirmation through `teardown.confirm` (the dev stack's checkbox when its stack has run) with the VM named when the environments poll lists one, tears them down (they need the worktree's files), then sends `worktree.promote`. A refused plan tears nothing down; a promote that fails after the teardown says the stack or VM is already gone (`tornDownNote`). A demote tears nothing down: the main checkout stays.
16. **promote_to_primary's confirmation goes through a broker** (`server/src/promote/requests.ts`): the tool refuses at once when the project's topic has no event subscriber (an MCP call's no-op subscriber does not count); else it emits `promote.request {projectId, requestId, worktreeId, branch, from?}` (`from`: the asking session's title, from an optional `terminalId`), and resolves with the first `promote.answer`, `no-window` (checked every 5 s), a 15-minute timeout, or the caller's disconnect; `promote.settled` goes to every subscriber when it ends. The window that confirms runs the promote itself and answers with the outcome (`declined`, `promoted` with the main checkout's id, `failed` with the error). The tool returns `{promoted: true, primary}` (a `list_worktrees` entry) or fails (`BAD_REQUEST`: declined, "do not ask again unless they say so"; nobody; timeout. `GIT_ERROR`: the promote failed). 30 tools.
17. **A window follows requests from `V2Workspace`,** in an effect keyed on the features (as the voice summaries are): one confirmation at a time, in order (`followPromoteRequests`, `promoteFlow.ts`); a request settled before its turn is skipped. A native dialog can't be closed from outside, so one still open when another window answers stays up; its answer then does nothing and the app says another window answered (`asked.stillAsked()`).
18. **No selection jump.** After a promote the worktree's row goes and the detail falls back to the main checkout; after a demote the main checkout stays selected and the new row appears.
19. **exportDirtyPatch keeps the index's times** (Task 4, found by this smoke): its throwaway index was a fresh copy, so git trusted the stat of a racily clean file (a same-size edit in the same second the file was committed or checked out) and left the edit out; the digest checks could not see it, since both sides built their patch the same way. The copy now has the real index's mtime, so git looks at the content as it does in the worktree. **This bug is on master in 5d's move today.**

## Risks

1. **A promote's switch overwrites the main checkout's ignored files** at paths the branch tracks (git's own rule for ignored files). Rare; not listed in the plan.
2. **A stack or VM torn down before a promote that then fails** stays gone (the worktree is intact). The plan is read first, so only a failure after the server's checks passed (a git error, a lock) can do this; the error says so. Same as Delete and the legacy promote.
3. **Putting things back can fail too** (a lock file, a full disk): the error then says what else failed and to check the checkouts with `git status`. A promote never removes the worktree in that case; a demote never leaves the main checkout off the branch without the work being in the new worktree.
4. **Untracked files that aren't ignored, in the main checkout's linked folders** (shared with the worktrees), make it "dirty": a promote is refused until they are committed, ignored or moved. A demote leaves them in the main checkout, where the new worktree links them.
5. **The staged/unstaged split is not kept** (as 5d): everything arrives unstaged, and a demote resets the main checkout's index (its copy is put back only on a failure).
6. **Other agents' sessions** (Codex, Gemini, Grok: their history is kept by folder) are closed on a promote and stay behind on a demote.
7. **The main checkout's own sessions keep running** during a promote (decision 3): one writing a file there between the apply and the digest check makes the check fail and the promote roll back; after it, its edit just stays. A resumed agent's history names the old absolute paths.
8. **A native confirmation can't be closed** when another window answers first; it stays until clicked, and its answer then does nothing.
9. **promote_to_primary holds the MCP call** up to 15 minutes; an MCP client with a shorter timeout gives up, the request is cancelled (`promote.settled`) and a still-open dialog's answer does nothing.
10. **The racily-clean bug (decision 19) is live in 5d's move on master** until Task 4 lands: a move can drop a same-size edit made in the second its file was committed or checked out, with every check passing. Task 4 can land on its own, first.
11. **Notes after a promote** ("Promoted, with notes": a closed Codex session, a dropped draft) are shown in the error dialog (the app has no plain message dialog); a smoke counting error dialogs sees them.
12. **A concurrent git command in the main checkout** (an agent there) can fail the switch with a lock; the promote rolls back.

## Questions

The user answered both on 2026-11-11, as recommended: demote carries the main checkout's uncommitted work to the new worktree (decision 9), and a promote into an unloaded main checkout loads it, resuming its own saved sessions too (decision 12). Task 4 (the 5d index-times fix) was merged to master on its own first, as a hotfix (47e2b6e), at the user's request; it is already in this branch's base, so executing this plan skips it. None remain.

## File structure

| File | Task | What |
|---|---|---|
| `src/shared/promote.ts` (new) | 1 | `PromotePlan`, `PromoteResult`, the request / settled / outcome types, the limits |
| `src/host/gitService.ts` | 1, 4 | `exportDirtyPatch`'s `linked` option, `reverseApplyPatch`, `headState`, `checkoutIgnoringOtherWorktrees`, `forceCheckoutHead`, `addWorktreeOfCheckedOut`; the index copy's times (4) |
| `server/src/promote/promoteHandlers.ts` (new) | 1 | `worktree.promote`, `worktree.demote`, `promote.answer` |
| `server/src/promote/requests.ts` (new) | 1 | `PromoteRequests`: ask / answer / stop |
| `server/src/sessions/manager.ts` | 1 | `suspendSessions`, `resumeSessions` |
| `server/src/{v2,server,capabilities}.ts`, `src/shared/protocolV2.ts` | 1, 2 | the handlers, `promoteRequests` in the context and the tools' deps, the capability, methods and events |
| `server/src/mcp/tools.ts` | 2 | `promote_to_primary`, the instructions |
| `src/renderer/src/v2/promoteFlow.ts` (new) | 3 | `promotePrompt`, `demotePrompt`, `followPromoteRequests` |
| `src/renderer/src/backend.ts`, `v2/backendV2.ts` | 3 | `worktrees.promote`, `worktrees.demote`, `worktrees.followPromoteRequests` |
| `src/renderer/src/backendFeatures.ts` | 3 | `promote` on, behind `promote` |
| `src/renderer/src/components/WorktreeDetail.tsx` | 3 | the two menu items |
| `src/renderer/src/v2/V2Workspace.tsx` | 3 (follow-up) | follows the requests while the feature is on |
| `scripts/promoteFixture.mjs` (new), `serverPromote.test.mjs` (new), `serverPromoteTool.test.mjs` (new), `promoteFlow.test.mjs` (new) | 1–3 | tests |
| `scripts/{serverV2,serverMcpTools,backendFeatures,v2Backend,serverMove}.test.mjs` | 1–4 | tests |
| `scripts/server-promote-smoke.mjs` (new), `package.json` | 5 | `smoke:server-promote` |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | 6 | docs |

## Prototype results

On `central-server-phase5e-proto` (master 1a64d76 plus the eight commits below), run one at a time:

| Check | Result |
|---|---|
| `npm run typecheck`, `cd server && npm run typecheck` | clean |
| `npm test` | 1933 pass, 0 fail, 1 skipped (master: 1910) |
| `npm run build` | passes |
| `npm run smoke:server-promote` (new) | PASS, 30 checks (passed twice) |
| `npm run smoke:server-move` | PASS, 40 checks (exportDirtyPatch changed) |
| `npm run smoke:v2` | PASS, 172 checks |
| `npm run smoke:local-window` | PASS, 57 checks (after Task 5's follow-up) |
| `npm run smoke:local-features` | PASS, 51 checks (after Task 5's follow-up) |
| `cd server && npm run smoke` | PASS |
| Leftover processes | none |

The first smoke run failed twice, and both are fixed in the prototype: the window never heard `promote.request` (installV2 subscribed before its connection existed: Task 3's follow-up), and a same-size edit made in the second its file was committed was left out of the patch (Task 4, a bug in 5d's code too).

## Tasks

### Task 1: The server: worktree.promote, worktree.demote, promote.answer

**Files:**
- Create: `scripts/promoteFixture.mjs`
- Create: `scripts/serverPromote.test.mjs`
- Modify: `scripts/serverV2.test.mjs`
- Modify: `server/src/capabilities.ts`
- Create: `server/src/promote/promoteHandlers.ts`
- Create: `server/src/promote/requests.ts`
- Modify: `server/src/server.ts`
- Modify: `server/src/sessions/manager.ts`
- Modify: `server/src/v2.ts`
- Modify: `src/host/gitService.ts`
- Create: `src/shared/promote.ts`
- Modify: `src/shared/protocolV2.ts`

- [ ] **Step 1:** Apply the diff below (prototype commit 976c0c2).
- [ ] **Step 2:** Run the checks: `node --test scripts/serverPromote.test.mjs scripts/serverV2.test.mjs` (13 new tests: the plan, a promote with its work, sessions and history, a loaded worktree resumed in the main checkout, a dirty main checkout refused, a locked worktree rolled back, the lock, a demote and its refusals, a demote rolled back when the main checkout can't switch, promote.answer), both typechecks.
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff 976c0c2</summary>

```diff
diff --git a/scripts/promoteFixture.mjs b/scripts/promoteFixture.mjs
new file mode 100644
index 0000000..3285e64
--- /dev/null
+++ b/scripts/promoteFixture.mjs
@@ -0,0 +1,112 @@
+// scripts/promoteFixture.mjs — the phase 5e tests' fixture (serverPromote.test.mjs,
+// serverPromoteTool.test.mjs): one server's handlers over real git in a temp dir, with a session
+// manager on a fake pty spawner. Not a test file itself.
+process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+process.env.GIT_CONFIG_NOSYSTEM = '1'
+
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
+import { SessionManager } from '../server/src/sessions/manager.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+import { projectDir } from '../src/host/claudeSessionService.ts'
+import { PromoteRequests } from '../server/src/promote/requests.ts'
+
+export const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
+export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
+export const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
+export const MAIN_ID = '22222222-2222-4333-8444-555555555555'
+
+function fakeSpawner() {
+  const spawned = []
+  const spawner = (opts) => {
+    const proc = {
+      opts, killed: false, dataCb: () => {}, exitCb: () => {},
+      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
+      write() {}, resize() {}, pause() {}, resume() {},
+      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) }
+    }
+    spawned.push(proc)
+    return proc
+  }
+  return { spawned, spawner }
+}
+
+/**
+ * A repository `app` (main, with origin/HEAD → main) and a worktree on `feat` with a commit, work
+ * in progress (changed, staged, untracked), a Claude session with a history, a Codex session, a
+ * review draft and branch data; the main checkout has a Claude session of its own.
+ */
+export async function setup(t) {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-promote-')))
+  const home = process.env.HOME
+  process.env.HOME = join(dir, 'home')
+  t.after(() => { process.env.HOME = home; rmSync(dir, { recursive: true, force: true }) })
+  const origin = join(dir, 'origin.git')
+  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
+  const app = join(dir, 'app')
+  execFileSync('git', ['init', '-q', '-b', 'main', app], { env: gitEnv })
+  writeFileSync(join(app, 'README'), 'one\n')
+  writeFileSync(join(app, '.gitignore'), 'ignored/\n')
+  git(app, 'add', '.')
+  git(app, 'commit', '-q', '-m', 'init')
+  git(app, 'remote', 'add', 'origin', origin)
+  git(app, 'push', '-q', '-u', 'origin', 'main')
+  git(app, 'remote', 'set-head', 'origin', 'main')
+  const configPath = join(dir, 'config.json')
+  saveConfig(configPath, { serverId: 's', name: 's', repos: [{ id: 'r', name: 'app', path: app }] })
+  const store = new ConfigStore(configPath)
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
+  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: () => {} })
+  const { spawned, spawner } = fakeSpawner()
+  const sessions = new SessionManager({ projects, store, hub, spawner, schedule: () => ({ cancel() {} }), discover: async () => undefined })
+  const promoteRequests = new PromoteRequests(hub, { timeoutMs: 2000, checkMs: 20 })
+  t.after(() => { promoteRequests.stop(); sessions.stopAll(); poller.stop(); store.close() })
+  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, sessions, promoteRequests }
+  const call = (method, params) => dispatchV2(method, params, ctx)
+  const created = await call('project.create', { name: 'P', repositories: [{ path: app }] })
+  const projectId = created.result.projectId
+  await poller.refresh(app)
+  const project = () => projects.require(projectId)
+  const repo = () => project().repositories[0]
+  const repoId = repo().id
+  const made = await call('worktree.create', { projectId, repoId, branch: 'feat', createBranch: true })
+  assert.equal(made.ok, true, JSON.stringify(made))
+  const worktreeId = made.result.worktreeId
+  const path = repo().worktrees.find((w) => w.id === worktreeId).path
+  writeFileSync(join(path, 'feat.txt'), 'committed\n')
+  git(path, 'add', '.')
+  git(path, 'commit', '-q', '-m', 'feat')
+  writeFileSync(join(path, 'README'), 'one\nchanged\n')
+  writeFileSync(join(path, 'staged.txt'), 'staged\n')
+  git(path, 'add', 'staged.txt')
+  writeFileSync(join(path, 'untracked.txt'), 'new\n')
+  mkdirSync(join(path, 'ignored'))
+  writeFileSync(join(path, 'ignored', 'local.db'), 'x')
+  mkdirSync(projectDir(path), { recursive: true })
+  writeFileSync(join(projectDir(path), `${CLAUDE_ID}.jsonl`), '{"type":"user"}\n')
+  const mainId = repo().worktrees.find((w) => w.isMain).id
+  projects.apply(projectId, (d) => {
+    const r = d.repositories[0]
+    r.worktrees.find((w) => w.id === worktreeId).sessions.push(
+      { id: CLAUDE_ID, agentSessionId: CLAUDE_ID, title: 'Claude 1', llm: { provider: 'claude' }, queue: ['later'], status: 'idle' },
+      { id: 'codex-1', title: 'Codex 1', llm: { provider: 'codex' }, queue: [], status: 'idle' }
+    )
+    r.worktrees.find((w) => w.id === worktreeId).review = { revision: 3, comments: [{ id: 'c1', at: 1, source: { kind: 'branch' }, path: 'README', side: 'new', line: 2, lineText: 'changed', body: 'why?' }] }
+    r.worktrees.find((w) => w.id === mainId).sessions.push({ id: MAIN_ID, agentSessionId: MAIN_ID, title: 'Main Claude', llm: { provider: 'claude' }, queue: [], status: 'idle' })
+    r.branchData.feat = { ...(r.branchData.feat ?? {}), note: 'the note' }
+  })
+  return { dir, app, call, projects, poller, sessions, hub, spawned, projectId, repoId, worktreeId, mainId, path, project, repo, promoteRequests, ctx }
+}
+
+export const status = (cwd) => git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()
+export const branchOf = (cwd) => git(cwd, 'symbolic-ref', '--short', 'HEAD').trim()
+
diff --git a/scripts/serverPromote.test.mjs b/scripts/serverPromote.test.mjs
new file mode 100644
index 0000000..436104c
--- /dev/null
+++ b/scripts/serverPromote.test.mjs
@@ -0,0 +1,198 @@
+// scripts/serverPromote.test.mjs — worktree.promote, worktree.demote and promote.answer (phase 5e),
+// against real git in a temp dir and a session manager with a fake pty spawner (promoteFixture.mjs).
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
+import { join } from 'node:path'
+import { projectDir } from '../src/host/claudeSessionService.ts'
+import { promoteChanging } from '../server/src/promote/promoteHandlers.ts'
+import { CLAUDE_ID, MAIN_ID, branchOf, git, setup, status } from './promoteFixture.mjs'
+
+test('worktree.promote dryRun: the plan, nothing changed', async (t) => {
+  const s = await setup(t)
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId, dryRun: true })
+  assert.equal(r.ok, true, JSON.stringify(r))
+  const plan = r.result
+  assert.equal(plan.branch, 'feat')
+  assert.equal(plan.mainPath, s.app)
+  assert.equal(plan.worktreePath, s.path)
+  assert.equal(plan.mainBranch, 'main')
+  assert.equal(plan.dirty, true)
+  assert.deepEqual(plan.sessions.map((x) => [x.title, x.carried]), [['Claude 1', true], ['Codex 1', false]])
+  assert.match(plan.sessions[1].reason, /closed/)
+  assert.equal(plan.reviewComments, 1)
+  assert.equal(plan.reviewCarried, true)
+  assert.deepEqual(plan.ignored, ['ignored/'])
+  assert.equal(branchOf(s.app), 'main')
+  assert.ok(existsSync(s.path))
+})
+
+test('worktree.promote: the main checkout has the branch and its work, the worktree is gone, sessions and history moved', async (t) => {
+  const s = await setup(t)
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, true, JSON.stringify(r))
+  assert.equal(r.result.worktreeId, s.mainId)
+  assert.deepEqual(r.result.moved, [CLAUDE_ID])
+  assert.ok(r.result.notes.some((n) => /Codex 1/.test(n)))
+  assert.equal(branchOf(s.app), 'feat')
+  assert.deepEqual(status(s.app), [' M README', '?? staged.txt', '?? untracked.txt'])
+  assert.equal(readFileSync(join(s.app, 'feat.txt'), 'utf8'), 'committed\n')
+  assert.ok(!existsSync(s.path))
+  const rows = s.repo().worktrees
+  assert.deepEqual(rows.map((w) => w.id), [s.mainId])
+  const main = rows[0]
+  assert.deepEqual(main.sessions.map((x) => x.id), [MAIN_ID, CLAUDE_ID])
+  assert.deepEqual(main.sessions[1].queue, ['later'])
+  assert.equal(main.review.comments.length, 1)
+  assert.ok(main.review.revision > 3)
+  assert.ok(existsSync(join(projectDir(s.app), `${CLAUDE_ID}.jsonl`)))
+  assert.ok(!existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
+  assert.equal(s.repo().branchData.feat.note, 'the note')
+})
+
+test('worktree.promote: a loaded worktree is stopped and its sessions resume in the main checkout', async (t) => {
+  const s = await setup(t)
+  assert.equal((await s.call('worktree.load', { projectId: s.projectId, worktreeId: s.worktreeId })).ok, true)
+  const before = s.spawned.length
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, true, JSON.stringify(r))
+  // The main checkout was not loaded: loading it resumes its own session and the moved one.
+  const main = s.repo().worktrees[0]
+  assert.equal(main.loaded, true)
+  assert.ok(main.sessions.every((x) => x.ptyId))
+  const resumed = s.spawned.slice(before)
+  assert.equal(resumed.length, 2)
+  assert.ok(resumed.every((p) => p.opts.cwd === s.app))
+})
+
+test('worktree.promote refuses a main checkout with uncommitted changes, and changes nothing', async (t) => {
+  const s = await setup(t)
+  writeFileSync(join(s.app, 'README'), 'dirty main\n')
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, false)
+  assert.equal(r.error.code, 'CONFLICT')
+  assert.match(r.error.message, /main checkout/)
+  assert.equal(branchOf(s.app), 'main')
+  assert.ok(existsSync(s.path))
+})
+
+test('worktree.promote refuses the main checkout itself', async (t) => {
+  const s = await setup(t)
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.mainId })
+  assert.equal(r.ok, false)
+  assert.equal(r.error.code, 'BAD_REQUEST')
+})
+
+test('worktree.promote puts everything back when the worktree cannot be removed (a locked worktree)', async (t) => {
+  const s = await setup(t)
+  git(s.app, 'worktree', 'lock', s.path)
+  const before = status(s.path)
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, false, JSON.stringify(r))
+  assert.equal(r.error.code, 'GIT_ERROR')
+  assert.equal(branchOf(s.app), 'main')
+  assert.deepEqual(status(s.app), [])
+  assert.ok(existsSync(s.path))
+  assert.deepEqual(status(s.path), before)
+  assert.equal(s.repo().worktrees.length, 2)
+  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
+})
+
+test('worktree.promote refuses while another promote changes the repository', async (t) => {
+  const s = await setup(t)
+  promoteChanging.add(realpathSync(s.app))
+  t.after(() => promoteChanging.clear())
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, false)
+  assert.equal(r.error.code, 'CONFLICT')
+  assert.ok(existsSync(s.path))
+})
+
+/** After a promote: the main checkout on feat, with work and the moved sessions. */
+async function promoted(t) {
+  const s = await setup(t)
+  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
+  assert.equal(r.ok, true, JSON.stringify(r))
+  // A codex session in the main checkout too: it stays there on a demote.
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees[0].sessions.push({ id: 'codex-main', title: 'Codex main', llm: { provider: 'codex' }, queue: [], status: 'idle' })
+  })
+  git(s.app, 'add', 'staged.txt')
+  return s
+}
+
+test('worktree.demote: the branch and its work go to a new worktree, the main checkout back on main and clean', async (t) => {
+  const s = await promoted(t)
+  const plan = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId, dryRun: true })
+  assert.equal(plan.ok, true, JSON.stringify(plan))
+  assert.equal(plan.result.branch, 'feat')
+  assert.equal(plan.result.mainBranch, 'main')
+  assert.equal(plan.result.worktreePath, s.path)
+  assert.deepEqual(plan.result.sessions.map((x) => [x.title, x.carried]), [['Main Claude', true], ['Claude 1', true], ['Codex main', false]])
+  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
+  assert.equal(r.ok, true, JSON.stringify(r))
+  assert.equal(branchOf(s.app), 'main')
+  assert.deepEqual(status(s.app), [])
+  assert.equal(branchOf(s.path), 'feat')
+  assert.deepEqual(status(s.path), [' M README', '?? staged.txt', '?? untracked.txt'])
+  const rows = s.repo().worktrees
+  const created = rows.find((w) => w.id === r.result.worktreeId)
+  assert.ok(created && !created.isMain)
+  assert.deepEqual(created.sessions.map((x) => x.id).sort(), [CLAUDE_ID, MAIN_ID].sort())
+  assert.deepEqual(rows.find((w) => w.isMain).sessions.map((x) => x.id), ['codex-main'])
+  assert.equal(created.review.comments.length, 1)
+  assert.equal(rows.find((w) => w.isMain).review, undefined)
+  assert.ok(existsSync(join(projectDir(s.path), `${MAIN_ID}.jsonl`)) || !existsSync(join(projectDir(s.app), `${MAIN_ID}.jsonl`)))
+  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
+})
+
+test('worktree.demote refuses on the default branch, and when the worktree path exists', async (t) => {
+  const s = await setup(t)
+  const onMain = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
+  assert.equal(onMain.ok, false)
+  assert.equal(onMain.error.code, 'BAD_REQUEST')
+  assert.match(onMain.error.message, /already on main/)
+  const p = await promoted(t)
+  mkdirSync(p.path)
+  const taken = await p.call('worktree.demote', { projectId: p.projectId, repoId: p.repoId })
+  assert.equal(taken.ok, false)
+  assert.equal(taken.error.code, 'CONFLICT')
+  assert.equal(branchOf(p.app), 'feat')
+})
+
+test('worktree.demote puts everything back when the main checkout cannot switch back to main', async (t) => {
+  const s = await promoted(t)
+  // main (not checked out anywhere now) gets a tracked shared/x; the main checkout, on feat, has an
+  // untracked shared/x in a linked folder (shared from the main checkout, not carried), which the
+  // switch to main would overwrite: git refuses it.
+  const side = join(s.dir, 'side')
+  git(s.app, 'worktree', 'add', '-q', side, 'main')
+  mkdirSync(join(side, 'shared'))
+  writeFileSync(join(side, 'shared', 'x'), 'tracked on main\n')
+  git(side, 'add', '.')
+  git(side, 'commit', '-q', '-m', 'shared')
+  git(s.app, 'worktree', 'remove', side)
+  await s.poller.refresh(s.app)
+  s.projects.apply(s.projectId, (d) => { d.repositories[0].linkedDirs = ['shared'] })
+  mkdirSync(join(s.app, 'shared'))
+  writeFileSync(join(s.app, 'shared', 'x'), 'local\n')
+  const before = status(s.app)
+  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
+  assert.equal(r.ok, false, JSON.stringify(r))
+  assert.equal(r.error.code, 'GIT_ERROR')
+  assert.equal(branchOf(s.app), 'feat')
+  assert.deepEqual(status(s.app), before)
+  assert.equal(readFileSync(join(s.app, 'shared', 'x'), 'utf8'), 'local\n')
+  assert.ok(!existsSync(s.path))
+  assert.equal(s.repo().worktrees.filter((w) => !w.missing).length, 1)
+  assert.equal(s.repo().worktrees.find((w) => w.isMain).sessions.length, 3)
+})
+
+test('promote.answer: an unknown request is not accepted', async (t) => {
+  const s = await setup(t)
+  const r = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'declined' })
+  assert.deepEqual(r, { ok: true, result: { accepted: false } })
+  const badOutcome = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'maybe' })
+  assert.equal(badOutcome.ok, false)
+})
+
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index bdcba2b..304275e 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move', 'promote']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 69fe87c..92dfa66 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -7,7 +7,8 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
  * `linear` and `voice` say it serves `linear.*` and `voice.*`; whether it has a key is
  * `linear.status`'s and `voice.settings`' answer. `review` (5c-2): the Changes tab's sources and
  * draft line comments. `move` (5d): `move.*`, a worktree's
- * move to or from another server.
+ * move to or from another server. `promote` (5e): `worktree.promote`, `worktree.demote` and
+ * `promote.answer`, and promote_to_primary's `promote.request` / `promote.settled`.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -21,7 +22,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.voice,
   CAPABILITY.skills,
   CAPABILITY.review,
-  CAPABILITY.move
+  CAPABILITY.move,
+  CAPABILITY.promote
 ]
 
 /**
diff --git a/server/src/promote/promoteHandlers.ts b/server/src/promote/promoteHandlers.ts
new file mode 100644
index 0000000..1df6cc9
--- /dev/null
+++ b/server/src/promote/promoteHandlers.ts
@@ -0,0 +1,488 @@
+// Promote to primary and its reverse (phase 5e), behind the `promote` capability. One server, so
+// each is one request that does everything or puts everything back:
+//
+// - `worktree.promote`: a worktree's branch is switched to in the repository's main checkout
+//   (which must be clean) while the worktree still has it (`--ignore-other-worktrees`), the
+//   worktree's uncommitted work (5d's config-proof patch) is applied there and checked by digest,
+//   and only then is the worktree removed (the point of commitment). Its sessions that can follow
+//   (sessionMigrates: Claude and Local) move to the main checkout with their histories and resume
+//   there; the main checkout's own sessions keep running, on the new branch.
+// - `worktree.demote` ("Promote branch to worktree"): the main checkout's branch gets a new
+//   worktree at the default path (`worktree add --force`, while the main checkout still has it),
+//   the main checkout's uncommitted work is applied there and checked, taken off the main checkout
+//   (`apply -R`, its index reset), and the main checkout switches back to the default branch (the
+//   point of commitment). Its sessions that can follow move to the new worktree; the others stay.
+//
+// `dryRun: true` answers the plan the confirmation shows, after the same checks.
+import { copyFile, mkdtemp, rm } from 'node:fs/promises'
+import { existsSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join, resolve, sep } from 'node:path'
+import * as gitService from '../../../src/host/gitService.ts'
+import { migrateSession } from '../../../src/host/claudeSessionService.ts'
+import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
+import { sessionMigrates } from '../../../src/shared/providers/selection.ts'
+import { getProvider } from '../../../src/shared/providers/registry.ts'
+import {
+  MAX_PROMOTE_LISTED_PATHS,
+  MAX_PROMOTE_PATCH_BYTES,
+  type PromoteOutcome,
+  type PromotePlan,
+  type PromoteResult,
+  type PromoteSessionInfo
+} from '../../../src/shared/promote.ts'
+import { codedError } from '../errors.ts'
+import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
+import { realOrResolved as real } from '../repos.ts'
+import { requireString } from '../validate.ts'
+import type { V2Context } from '../v2.ts'
+import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+/** Repositories (real path) a promote or demote is changing right now: one at a time per repository. */
+const changing = new Set<string>()
+/** For the tests */
+export const promoteChanging: Set<string> = changing
+
+async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
+  try {
+    return await operation()
+  } catch (err) {
+    if (err instanceof gitService.NotUtf8PatchError || err instanceof gitService.PatchTooBigError || err instanceof gitService.NestedRepoError) {
+      throw bad(err.message)
+    }
+    throw codedError('GIT_ERROR', (err as Error).message)
+  }
+}
+
+function optionalDryRun(value: unknown): boolean {
+  if (value === undefined) return false
+  if (typeof value !== 'boolean') throw bad('dryRun must be a boolean')
+  return value
+}
+
+/** The repository's main checkout row, present, the registered repository's own checkout. */
+function mainOf(ctx: V2Context, projectId: string, repo: Repository): Worktree {
+  const main = repo.worktrees.find((w) => w.isMain)
+  if (!main) throw codedError('NOT_FOUND', `${repo.path} has no main checkout listed yet`)
+  return present(ctx, { projectId, worktreeId: main.id }).worktree
+}
+
+/** Fresh uncommitted-work check; refuses when git can't say. */
+async function isDirty(path: string): Promise<boolean> {
+  const dirty = await gitService.worktreeDirty(path)
+  if (dirty === null) throw codedError('GIT_ERROR', `could not read the status of ${path}`)
+  return dirty
+}
+
+/** The sessions that follow (sessionMigrates) and what the plan says of each. */
+function splitSessions(sessions: readonly Session[], stays: string): { info: PromoteSessionInfo[]; moving: Session[] } {
+  const info: PromoteSessionInfo[] = []
+  const moving: Session[] = []
+  for (const s of sessions) {
+    const base = { title: s.title, provider: s.llm.provider }
+    if (sessionMigrates(s)) {
+      moving.push(s)
+      info.push({ ...base, carried: true })
+    } else {
+      info.push({ ...base, carried: false, reason: `${getProvider(s.llm.provider).label} keeps its history by folder, so it can't follow; ${stays}` })
+    }
+  }
+  return { info, moving }
+}
+
+/** The patch of a checkout's uncommitted work (5d's), `linked` paths left out when given. */
+function patchOf(path: string, repo: Repository, linked?: readonly string[]): Promise<{ patch: string; headSha: string }> {
+  return viaGit(() =>
+    gitService.exportDirtyPatch(path, repo.linkedDirs ?? [], { maxBytes: MAX_PROMOTE_PATCH_BYTES, repoPath: repo.path, ...(linked ? { linked } : {}) })
+  )
+}
+
+/** git apply's refusal of a file under one of the new worktree's linked folders, said plainly. */
+function linkedApplyMessage(stderr: string, repo: Repository): string | null {
+  const m = /affected file '([^']+)' is beyond a symbolic link/.exec(stderr)
+  if (!m) return null
+  return `the uncommitted work has ${m[1]}, inside a folder the new worktree links from ${repo.path} (the repository's linked folders); nothing was changed. Commit or move it first`
+}
+
+/** Moves the sessions' histories between the checkouts' Claude folders; what could not move. */
+async function moveHistories(sessions: readonly Session[], from: string, to: string): Promise<string[]> {
+  const notes: string[] = []
+  for (const s of sessions) {
+    if (!s.agentSessionId) continue
+    try {
+      await migrateSession(s.agentSessionId, from, to)
+    } catch (err) {
+      notes.push(`The history of “${s.title}” could not be moved (${(err as Error).message}); it starts afresh`)
+    }
+  }
+  return notes
+}
+
+/** The session as it arrives in the other checkout: no pty, no exit, no open question. */
+function handedOver(s: Session): Session {
+  const out: Session = structuredClone(s)
+  delete out.ptyId
+  delete out.exitCode
+  delete out.decision
+  if (out.status !== 'complete') out.status = 'idle'
+  return out
+}
+
+/** The draft moves to a row that has none: a revision above both rows' last, so none ever repeats. */
+function carryReview(from: Worktree, to: Worktree): boolean {
+  if (!from.review || from.review.comments.length === 0 || (to.review && to.review.comments.length > 0)) return false
+  const revision = Math.max(from.reviewRevision ?? 0, from.review.revision, to.reviewRevision ?? 0) + 1
+  to.review = { revision, comments: structuredClone(from.review.comments) }
+  to.reviewRevision = revision
+  return true
+}
+
+function dropOrderKey(d: Project, repoId: string, path: string): void {
+  const orderKey = `${repoId} ${path}`
+  if (!d.settings.worktreeOrder) return
+  const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
+  if (order.length > 0) d.settings.worktreeOrder = order
+  else delete d.settings.worktreeOrder
+}
+
+/** One promote or demote per repository at a time. */
+async function locked<T>(repo: Repository, work: () => Promise<T>): Promise<T> {
+  const key = real(repo.path)
+  if (changing.has(key)) throw codedError('CONFLICT', `another promote is changing ${repo.path} right now; try again once it is done`)
+  changing.add(key)
+  try {
+    return await work()
+  } finally {
+    changing.delete(key)
+  }
+}
+
+/** Runs each undo step, newest first, never throwing (the error the caller shows is the first). */
+async function undoAll(undo: (() => Promise<unknown>)[]): Promise<string[]> {
+  const failed: string[] = []
+  for (const step of undo.reverse()) await step().catch((err: Error) => failed.push(err.message))
+  return failed
+}
+
+function withUndoNote(err: unknown, failed: string[]): Error {
+  if (failed.length === 0) return err as Error
+  const e = err as Error & { code?: unknown }
+  // Keeps the first error's code (CONFLICT, BAD_REQUEST…): the message says what else went wrong.
+  const out = new Error(`${e.message}. Putting things back also failed (${failed.join('; ')}): check the checkouts with git status`) as Error & { code?: unknown }
+  out.code = e.code ?? 'GIT_ERROR'
+  return out
+}
+
+interface PromoteChecked {
+  project: Project
+  repo: Repository
+  worktree: Worktree
+  main: Worktree
+  branch: string
+  mainHead: { branch: string | null; sha: string }
+  plan: PromotePlan
+  moving: Session[]
+}
+
+async function checkPromote(ctx: V2Context, p: any): Promise<PromoteChecked> {
+  const { worktree: row } = present(ctx, p)
+  if (row.isMain) throw bad('this is already the main checkout')
+  const { repo, worktree, branch } = await checkedOut(ctx, p)
+  const projectId = requireString(p.projectId, 'projectId')
+  const main = mainOf(ctx, projectId, repo)
+  const mainHead = await viaGit(() => gitService.headState(main.path))
+  if (await isDirty(main.path)) {
+    throw codedError('CONFLICT', `the main checkout ${main.path} has uncommitted changes; commit or stash them there first`)
+  }
+  const dirty = await isDirty(worktree.path)
+  const { info, moving } = splitSessions(worktree.sessions, 'it is closed')
+  const left = await viaGit(() => gitService.leftBehind(worktree.path, repo.linkedDirs ?? [], MAX_PROMOTE_LISTED_PATHS, repo.path))
+  if (left.nestedRepos.length > 0) {
+    throw bad(`${left.nestedRepos.join(', ')} ${left.nestedRepos.length === 1 ? 'is a git repository' : 'are git repositories'} of its own inside the worktree, which a promote can't carry; commit it as a submodule, or move it out, first`)
+  }
+  const reviewComments = worktree.review?.comments.length ?? 0
+  const plan: PromotePlan = {
+    branch,
+    mainPath: main.path,
+    worktreePath: worktree.path,
+    mainBranch: mainHead.branch,
+    dirty,
+    loaded: worktree.loaded,
+    otherLoaded: main.loaded,
+    sessions: info,
+    reviewComments,
+    reviewCarried: reviewComments > 0 && !(main.review && main.review.comments.length > 0),
+    ignored: left.ignored,
+    ignoredCount: left.ignoredCount,
+    hiddenChanges: left.hiddenChanges,
+    hiddenChangesCount: left.hiddenChangesCount
+  }
+  return { project: ctx.projects.require(projectId), repo, worktree, main, branch, mainHead, plan, moving }
+}
+
+async function promote(ctx: V2Context, c: PromoteChecked): Promise<PromoteResult> {
+  const { project, repo, worktree, main, branch, mainHead, moving } = c
+  const wasLoaded = worktree.loaded
+  const undo: (() => Promise<unknown>)[] = []
+  const unblockWorktree = ctx.sessions.blockPath(worktree.path)
+  const unblockMain = ctx.sessions.blockPath(main.path)
+  let failure: Error | undefined
+  try {
+    // Its agents stop first: none may write to the worktree while its work is carried.
+    if (wasLoaded) ctx.sessions.unloadWorktree({ projectId: project.id, worktreeId: worktree.id })
+    const { patch } = await patchOf(worktree.path, repo)
+    // Pushed before the switch: one that fails part way has written files already. The main
+    // checkout was clean, so going back discards nothing of its own.
+    undo.push(() => gitService.forceCheckoutHead(main.path, mainHead))
+    await viaGit(() => gitService.checkoutIgnoringOtherWorktrees(main.path, branch))
+    if (patch !== '') {
+      await viaGit(() => gitService.applyPatch(main.path, patch))
+      undo.push(() => gitService.reverseApplyPatch(main.path, patch))
+    }
+    // The work as the main checkout now has it must be the worktree's, exactly (5d's check).
+    const applied = await patchOf(main.path, repo)
+    if (gitService.patchDigest(applied.patch) !== gitService.patchDigest(patch)) {
+      throw codedError('GIT_ERROR', "the uncommitted work in the main checkout does not match the worktree's after the apply; nothing was changed")
+    }
+    // The point of commitment: the main checkout holds the branch and its work.
+    await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
+  } catch (err) {
+    failure = withUndoNote(err, await undoAll(undo))
+  } finally {
+    unblockMain()
+    unblockWorktree()
+  }
+  if (failure) {
+    if (wasLoaded) {
+      try {
+        ctx.sessions.loadWorktree({ projectId: project.id, worktreeId: worktree.id })
+      } catch (err) {
+        console.error(`could not load ${worktree.path} again after a failed promote`, err)
+      }
+    }
+    await ctx.poller.refresh(repo.path).catch(() => false)
+    throw failure
+  }
+
+  await ctx.poller.refresh(repo.path).catch(() => false)
+  const notes = await moveHistories(moving, worktree.path, main.path)
+  for (const s of worktree.sessions) if (!sessionMigrates(s)) notes.push(`“${s.title}” was closed: ${getProvider(s.llm.provider).label} can't follow a worktree to another folder`)
+  const movedIds = moving.map((s) => s.id)
+  let mainLoaded = false
+  ctx.projects.apply(project.id, (d) => {
+    const r = repoIn(d, repo.id)
+    const from = r.worktrees.find((w) => w.id === worktree.id)
+    const to = r.worktrees.find((w) => w.id === main.id)
+    if (to && from) {
+      to.sessions.push(...from.sessions.filter((s) => movedIds.includes(s.id)).map(handedOver))
+      if (from.review && from.review.comments.length > 0 && !carryReview(from, to)) {
+        notes.push(`The worktree's review draft (${from.review.comments.length} comments) was dropped: the main checkout has a draft of its own`)
+      }
+      if (from.prNotice && !to.prNotice) to.prNotice = from.prNotice
+      mainLoaded = to.loaded
+    }
+    r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
+    dropOrderKey(d, repo.id, worktree.path)
+  })
+  // The sessions resume where they now are when either checkout was running.
+  if (movedIds.length > 0 && (wasLoaded || mainLoaded)) {
+    try {
+      if (mainLoaded) ctx.sessions.resumeSessions(project.id, movedIds)
+      else ctx.sessions.loadWorktree({ projectId: project.id, worktreeId: main.id })
+    } catch (err) {
+      notes.push(`The sessions moved but could not be resumed: ${(err as Error).message}`)
+    }
+  }
+  ctx.sessions.refreshAttention()
+  return { worktreeId: main.id, moved: movedIds, notes }
+}
+
+interface DemoteChecked {
+  project: Project
+  repo: Repository
+  main: Worktree
+  branch: string
+  defaultBranch: string
+  target: string
+  plan: PromotePlan
+  moving: Session[]
+}
+
+async function checkDemote(ctx: V2Context, p: any): Promise<DemoteChecked> {
+  const projectId = requireString(p.projectId, 'projectId')
+  const project = ctx.projects.require(projectId)
+  const repo = repoIn(project, p.repoId)
+  findRegistered(ctx.store.config.repos, repo.path)
+  const row = mainOf(ctx, projectId, repo)
+  const { worktree: main, branch } = await checkedOut(ctx, { projectId, worktreeId: row.id })
+  const defaultBranch = await gitService.defaultBranch(repo.path)
+  if (!defaultBranch) throw bad(`could not tell ${repo.path}'s default branch (main or master) to go back to`)
+  if (branch === defaultBranch) throw bad(`the main checkout is already on ${defaultBranch}; there is no branch to move into a worktree`)
+  await checkBranchName(repo.path, defaultBranch, true)
+  const listed = await viaGit(() => gitService.listWorktrees(repo.path))
+  const holder = listed.find((w) => w.branch === defaultBranch && real(w.path) !== real(main.path))
+  if (holder) throw codedError('CONFLICT', `${defaultBranch} is checked out at ${holder.path}, so the main checkout can't go back to it; remove that worktree first`)
+  const requested = defaultWorktreePath(repo.path, branch)
+  const target = ctx.store.guard.check(requested)
+  assertNotRepository(ctx.store.config.repos, target, 'path', requested)
+  if (existsSync(target)) throw codedError('CONFLICT', `${requested} already exists`)
+  const inside = (root: string): boolean => target.startsWith(real(root) + sep)
+  if (ctx.store.config.repos.some((r) => inside(r.path)) || repo.worktrees.some((w) => !w.missing && inside(w.path))) {
+    throw bad(`${requested} is inside an existing checkout`)
+  }
+  const { info, moving } = splitSessions(main.sessions, 'it stays in the main checkout')
+  const reviewComments = main.review?.comments.length ?? 0
+  const plan: PromotePlan = {
+    branch,
+    mainPath: main.path,
+    worktreePath: target,
+    mainBranch: defaultBranch,
+    dirty: await isDirty(main.path),
+    loaded: main.loaded,
+    otherLoaded: false,
+    sessions: info,
+    reviewComments,
+    reviewCarried: reviewComments > 0,
+    ignored: [],
+    ignoredCount: 0,
+    hiddenChanges: [],
+    hiddenChangesCount: 0
+  }
+  return { project, repo, main, branch, defaultBranch, target, plan, moving }
+}
+
+async function demote(ctx: V2Context, c: DemoteChecked): Promise<PromoteResult> {
+  const { project, repo, main, branch, defaultBranch, target, moving } = c
+  const movingIds = moving.map((s) => s.id)
+  const wasLoaded = main.loaded
+  const undo: (() => Promise<unknown>)[] = []
+  const unblockMain = ctx.sessions.blockPath(main.path)
+  const unblockTarget = ctx.sessions.blockPath(target)
+  const backupDir = await mkdtemp(join(tmpdir(), 'trek-promote-index-'))
+  let failure: Error | undefined
+  try {
+    if (wasLoaded && movingIds.length > 0) ctx.sessions.suspendSessions(project.id, movingIds)
+    await viaGit(() => gitService.addWorktreeOfCheckedOut(repo.path, target, branch))
+    undo.push(() => gitService.removeWorktreeForce(repo.path, target))
+    await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
+    // What the new worktree links from the main checkout stays there (it is shared, not carried).
+    const linked = await gitService.linkedSymlinks(target, repo.linkedDirs ?? [], repo.path)
+    const { patch } = await patchOf(main.path, repo, linked)
+    if (patch !== '') {
+      await viaGit(() => gitService.applyPatch(target, patch).catch((err: Error) => {
+        throw new Error(linkedApplyMessage(err.message, repo) ?? err.message)
+      }))
+    }
+    const applied = await patchOf(target, repo)
+    if (gitService.patchDigest(applied.patch) !== gitService.patchDigest(patch)) {
+      throw codedError('GIT_ERROR', "the uncommitted work in the new worktree does not match the main checkout's after the apply; nothing was changed")
+    }
+    if (patch !== '') {
+      // Off the main checkout: its files back to HEAD, and its index (staged changes) reset, kept to put back.
+      const index = resolve(main.path, (await viaGit(() => gitService.git(main.path, ['rev-parse', '--git-path', 'index']))).trim())
+      const backup = join(backupDir, 'index')
+      const hadIndex = await copyFile(index, backup).then(() => true, (err: NodeJS.ErrnoException) => {
+        if (err.code === 'ENOENT') return false
+        throw err
+      })
+      await viaGit(() => gitService.reverseApplyPatch(main.path, patch))
+      undo.push(() => gitService.applyPatch(main.path, patch))
+      // Pushed first: a reset that fails part way may have written the index already.
+      undo.push(() => (hadIndex ? copyFile(backup, index) : rm(index, { force: true })))
+      // With a pathspec: only the index's entries, HEAD left alone.
+      await viaGit(() => gitService.git(main.path, ['reset', '-q', '--', '.']))
+    }
+    // The point of commitment: the main checkout leaves the branch. Its undo is pushed first (a
+    // switch that fails part way has written files): back on the branch, its files as HEAD has
+    // them; the steps before put its index and work back.
+    undo.push(() => gitService.forceCheckoutHead(main.path, { branch, sha: '' }))
+    await viaGit(() => gitService.checkout(main.path, defaultBranch))
+  } catch (err) {
+    failure = withUndoNote(err, await undoAll(undo))
+  } finally {
+    unblockTarget()
+    unblockMain()
+    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
+  }
+  if (failure) {
+    if (wasLoaded && movingIds.length > 0) ctx.sessions.resumeSessions(project.id, movingIds)
+    await ctx.poller.refresh(repo.path).catch(() => false)
+    throw failure
+  }
+
+  if (!(await ctx.poller.refresh(repo.path).catch(() => false))) {
+    throw codedError('GIT_ERROR', `${branch} is now at ${target}, but the worktrees could not be re-read: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
+  }
+  const notes = await moveHistories(moving, main.path, target)
+  let worktreeId = ''
+  ctx.projects.apply(project.id, (d) => {
+    const r = repoIn(d, repo.id)
+    const from = r.worktrees.find((w) => w.id === main.id)
+    const created = r.worktrees.find((w) => !w.isMain && real(w.path) === real(target))
+    if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
+    worktreeId = created.id
+    if (from) {
+      created.sessions.push(...from.sessions.filter((s) => movingIds.includes(s.id)).map(handedOver))
+      from.sessions = from.sessions.filter((s) => !movingIds.includes(s.id))
+      if (from.review && from.review.comments.length > 0 && carryReview(from, created)) delete from.review
+      if (from.prNotice) {
+        created.prNotice = from.prNotice
+        delete from.prNotice
+      }
+    }
+    // As worktree.create: a branch without a tag gets the first workflow tag.
+    const firstTag = d.settings.worktreeTags?.[0]?.id
+    const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
+    if (firstTag && !data?.tag && created.branch === branch) r.branchData[branch] = { ...data, tag: firstTag }
+  })
+  if (wasLoaded && movingIds.length > 0) {
+    try {
+      ctx.sessions.loadWorktree({ projectId: project.id, worktreeId })
+    } catch (err) {
+      notes.push(`The sessions moved but could not be resumed: ${(err as Error).message}`)
+    }
+  }
+  ctx.sessions.refreshAttention()
+  return { worktreeId, moved: movingIds, notes }
+}
+
+/** promote.answer's outcome, checked. */
+function checkOutcome(p: any): PromoteOutcome {
+  const outcome = requireString(p.outcome, 'outcome')
+  if (outcome === 'declined') return { outcome }
+  if (outcome === 'promoted') return { outcome, worktreeId: requireString(p.worktreeId, 'worktreeId') }
+  if (outcome === 'failed') {
+    const error = requireString(p.error, 'error')
+    return { outcome, error: error.slice(0, 2000) }
+  }
+  throw bad('outcome must be declined, promoted or failed')
+}
+
+export const promoteHandlers: Record<string, Handler> = {
+  'worktree.promote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
+    const dryRun = optionalDryRun(p.dryRun)
+    const checked = await checkPromote(ctx, p)
+    if (dryRun) return checked.plan
+    return locked(checked.repo, async () => promote(ctx, await checkPromote(ctx, p)))
+  },
+
+  'worktree.demote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
+    const dryRun = optionalDryRun(p.dryRun)
+    const checked = await checkDemote(ctx, p)
+    if (dryRun) return checked.plan
+    return locked(checked.repo, async () => demote(ctx, await checkDemote(ctx, p)))
+  },
+
+  /** A window's answer to promote_to_primary's `promote.request`: the first answer wins. */
+  'promote.answer': (p, ctx): { accepted: boolean } => {
+    const projectId = requireString(p.projectId, 'projectId')
+    ctx.projects.require(projectId)
+    const requestId = requireString(p.requestId, 'requestId')
+    const outcome = checkOutcome(p)
+    return { accepted: ctx.promoteRequests?.answer(projectId, requestId, outcome) ?? false }
+  }
+}
diff --git a/server/src/promote/requests.ts b/server/src/promote/requests.ts
new file mode 100644
index 0000000..4d87e28
--- /dev/null
+++ b/server/src/promote/requests.ts
@@ -0,0 +1,95 @@
+// promote_to_primary's confirmation (phase 5e): the tool asks every window that has the project open
+// (`promote.request` on its topic), the first window to answer (`promote.answer`) settles it, and
+// the others are told to close their dialog (`promote.settled`). The window that confirms runs the
+// promote itself, as its menu item does, and answers with the outcome.
+import { randomUUID } from 'node:crypto'
+import { projectTopic } from '../../../src/shared/model/topics.ts'
+import {
+  PROMOTE_ANSWER_TIMEOUT_MS,
+  PROMOTE_WINDOW_CHECK_MS,
+  type PromoteOutcome,
+  type PromoteRequestEvent,
+  type PromoteSettledEvent
+} from '../../../src/shared/promote.ts'
+import type { TopicHub } from '../topicHub.ts'
+
+/** How a request ended, besides a window's answer. */
+export type PromoteAsk = PromoteOutcome | { outcome: 'no-window' } | { outcome: 'timeout' } | { outcome: 'cancelled' }
+
+interface Pending {
+  projectId: string
+  settle: (result: PromoteAsk) => void
+}
+
+export interface PromoteRequestsOptions {
+  timeoutMs?: number
+  checkMs?: number
+}
+
+export class PromoteRequests {
+  private readonly pending = new Map<string, Pending>()
+  private readonly hub: TopicHub
+  private readonly timeoutMs: number
+  private readonly checkMs: number
+
+  constructor(hub: TopicHub, options: PromoteRequestsOptions = {}) {
+    this.hub = hub
+    this.timeoutMs = options.timeoutMs ?? PROMOTE_ANSWER_TIMEOUT_MS
+    this.checkMs = options.checkMs ?? PROMOTE_WINDOW_CHECK_MS
+  }
+
+  /** Windows that would see a request now (event subscribers of the project's topic). */
+  windows(projectId: string): number {
+    return this.hub.eventSubscriberCount(projectTopic(projectId))
+  }
+
+  /**
+   * Asks the project's windows; resolves with the first answer, or `no-window` (none has the
+   * project open, now or any more), `timeout`, or `cancelled` (the caller went away).
+   */
+  ask(projectId: string, request: Omit<PromoteRequestEvent, 'projectId' | 'requestId'>, signal?: AbortSignal): Promise<PromoteAsk> {
+    if (this.windows(projectId) === 0) return Promise.resolve({ outcome: 'no-window' })
+    const requestId = randomUUID()
+    return new Promise<PromoteAsk>((resolve) => {
+      let done = false
+      const finish = (result: PromoteAsk): void => {
+        if (done) return
+        done = true
+        clearTimeout(timer)
+        clearInterval(check)
+        signal?.removeEventListener('abort', onAbort)
+        this.pending.delete(requestId)
+        this.hub.emit(projectTopic(projectId), 'promote.settled', { projectId, requestId } satisfies PromoteSettledEvent)
+        resolve(result)
+      }
+      const onAbort = (): void => finish({ outcome: 'cancelled' })
+      const timer = setTimeout(() => finish({ outcome: 'timeout' }), this.timeoutMs)
+      timer.unref?.()
+      const check = setInterval(() => {
+        if (this.windows(projectId) === 0) finish({ outcome: 'no-window' })
+      }, this.checkMs)
+      check.unref?.()
+      if (signal?.aborted) {
+        onAbort()
+        return
+      }
+      signal?.addEventListener('abort', onAbort, { once: true })
+      this.pending.set(requestId, { projectId, settle: finish })
+      const sent = this.hub.emit(projectTopic(projectId), 'promote.request', { projectId, requestId, ...request } satisfies PromoteRequestEvent)
+      if (sent === 0) finish({ outcome: 'no-window' })
+    })
+  }
+
+  /** A window's answer; false when the request is unknown, settled already or another project's. */
+  answer(projectId: string, requestId: string, outcome: PromoteOutcome): boolean {
+    const pending = this.pending.get(requestId)
+    if (!pending || pending.projectId !== projectId) return false
+    pending.settle(outcome)
+    return true
+  }
+
+  /** Server shutdown: every waiting tool call ends. */
+  stop(): void {
+    for (const p of [...this.pending.values()]) p.settle({ outcome: 'cancelled' })
+  }
+}
diff --git a/server/src/server.ts b/server/src/server.ts
index 8124521..db8a3a7 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -32,6 +32,7 @@ import { VOICE_SUMMARY_PROMPT } from '../../src/shared/providers/prompts.ts'
 import type { Integrations } from './integrations/integrations'
 import type { GhRunner } from './prWatch/gh'
 import { PrWatcher } from './prWatch/watcher'
+import { PromoteRequests } from './promote/requests'
 import { LoginLimiter, parseCookies, sameOrigin, SESSION_COOKIE, WebSessions } from './web/auth'
 import { createWebHandler } from './web/http'
 import { sweepEvery, WebSocketSignIns } from './web/sockets'
@@ -139,6 +140,8 @@ export function startServer(
       })
     : undefined
   prWatch?.start()
+  // promote_to_primary's confirmations (5e): asked of the project's windows.
+  const promoteRequests = new PromoteRequests(hub)
 
   /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
   const authed = new Map<WebSocket, string>()
@@ -395,6 +398,7 @@ export function startServer(
         integrations: options.integrations,
         integrationsChanged,
         prWatch,
+        promoteRequests,
         mcpAccess: access
           ? {
               revoke: (id) => {
@@ -481,6 +485,7 @@ export function startServer(
     trek.mcp = undefined
     poller.stop()
     prWatch?.stop()
+    promoteRequests.stop()
     sessions.stopAll()
     // A move's staged histories (5d) are only of use to the connection that was sending them.
     const cleared = moveTransfers.clear().catch(() => {})
diff --git a/server/src/sessions/manager.ts b/server/src/sessions/manager.ts
index 79a335b..9689620 100644
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -432,6 +432,66 @@ export class SessionManager {
     return null
   }
 
+  /**
+   * Stops these sessions' agents (5e: a promote or demote hands them to the other checkout) as
+   * unloadWorktree does for a whole worktree: their records stay, idle, with no pty.
+   */
+  suspendSessions(projectId: string, sessionIds: readonly string[]): void {
+    const project = this.deps.projects.require(projectId)
+    const ids = new Set(sessionIds)
+    for (const repo of project.repositories) {
+      for (const worktree of repo.worktrees) {
+        for (const session of worktree.sessions) {
+          if (!ids.has(session.id)) continue
+          this.stopDiscovery(session.id)
+          this.killSession(session)
+        }
+      }
+    }
+    this.deps.projects.apply(
+      projectId,
+      (d) => {
+        for (const repo of d.repositories) {
+          for (const worktree of repo.worktrees) {
+            for (const s of worktree.sessions) {
+              if (!ids.has(s.id)) continue
+              delete s.ptyId
+              delete s.exitCode
+              delete s.decision
+              if (s.status !== 'complete') s.status = 'idle'
+            }
+          }
+        }
+      },
+      { persist: false }
+    )
+    this.publishAttention()
+  }
+
+  /**
+   * Resumes these sessions where their records now are (5e: in the checkout a promote or demote
+   * handed them to, already loaded). One that can't start shows as exited, as loadWorktree's do.
+   */
+  resumeSessions(projectId: string, sessionIds: readonly string[]): void {
+    this.assertRunning()
+    for (const id of sessionIds) {
+      try {
+        this.spawnSession(projectId, id, { cols: LOAD_COLS, rows: LOAD_ROWS })
+      } catch (err) {
+        console.error(`could not resume session ${id}`, err)
+        try {
+          this.mutate(projectId, id, (s) => {
+            delete s.ptyId
+            s.status = 'exited'
+            s.exitCode = -1
+          }, false)
+        } catch {
+          // the session is gone
+        }
+      }
+    }
+  }
+
   unloadWorktree(p: any): null {
     const project = this.deps.projects.require(p.projectId)
     const { worktree } = findWorktree(project, p.worktreeId)
diff --git a/server/src/v2.ts b/server/src/v2.ts
index 66b578f..48595dc 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -19,6 +19,8 @@ import { integrationHandlers } from './integrations/integrationHandlers.ts'
 import { prWatchHandlers } from './prWatch/prWatchHandlers.ts'
 import { reviewHandlers } from './review/reviewHandlers.ts'
 import { moveHandlers } from './move/moveHandlers.ts'
+import { promoteHandlers } from './promote/promoteHandlers.ts'
+import type { PromoteRequests } from './promote/requests.ts'
 import type { PrWatcher } from './prWatch/watcher.ts'
 import type { Integrations } from './integrations/integrations.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
@@ -65,6 +67,8 @@ export interface V2Context {
   integrationsChanged?: (parts: IntegrationsChangedEvent) => void
   /** The pull request watch (5c-1): gh on this machine; without it no PR is watched */
   prWatch?: PrWatcher
+  /** promote_to_primary's confirmations (5e): `promote.answer` settles one */
+  promoteRequests?: PromoteRequests
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
@@ -314,7 +318,8 @@ const handlers: Record<string, Handler> = {
   ...integrationHandlers,
   ...prWatchHandlers,
   ...reviewHandlers,
-  ...moveHandlers
+  ...moveHandlers,
+  ...promoteHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/src/host/gitService.ts b/src/host/gitService.ts
index a5420be..5965e27 100644
--- a/src/host/gitService.ts
+++ b/src/host/gitService.ts
@@ -372,10 +372,12 @@ function overflowed(err: unknown): boolean {
 export async function exportDirtyPatch(
   worktreePath: string,
   exclude: readonly string[] = [],
-  options: { maxBytes?: number; repoPath?: string } = {}
+  options: { maxBytes?: number; repoPath?: string; linked?: readonly string[] } = {}
 ): Promise<{ patch: string; headSha: string }> {
   const maxBytes = options.maxBytes ?? DEFAULT_MAX_PATCH_BYTES
-  const linked = await linkedSymlinks(worktreePath, exclude, options.repoPath)
+  // `linked` (5e's demote): the paths to leave out, given — the main checkout's linkedDirs are real
+  // folders there, and only those the new worktree links stay behind.
+  const linked = options.linked ? [...options.linked] : await linkedSymlinks(worktreePath, exclude, options.repoPath)
   const headSha = (await git(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim()
   const gitIndex = resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim())
   const pathspec = ['.', ...linked.map((p) => `:(exclude,literal)${p}`)]
@@ -517,6 +519,60 @@ export async function applyPatch(worktreePath: string, patch: string): Promise<v
   })
 }
 
+/** applyPatch backwards (the same config-proof apply, `-R`): a promote's undo of the work it carried. */
+export async function reverseApplyPatch(worktreePath: string, patch: string): Promise<void> {
+  await new Promise<void>((resolve, reject) => {
+    const child = execFile(
+      'git',
+      [...PATCH_CONFIG, '-C', worktreePath, 'apply', '-R', '--binary', '--whitespace=nowarn', '-p1', '-'],
+      { env: patchEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
+      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
+    )
+    child.stdin!.end(patch)
+  })
+}
+
+/** What a checkout has checked out: its branch (null on a detached HEAD) and its commit. */
+export async function headState(path: string): Promise<{ branch: string | null; sha: string }> {
+  const sha = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim()
+  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s.trim() || null, () => null)
+  return { branch, sha }
+}
+
+/**
+ * Checks a branch out in the main checkout although a worktree still has it (5e's promote: the
+ * worktree goes only once the main checkout holds the branch and its work).
+ */
+export async function checkoutIgnoringOtherWorktrees(repoPath: string, branch: string): Promise<void> {
+  assertSafeBranch(branch)
+  // switch, not checkout: a branch name that is also a path is never read as one.
+  await git(repoPath, ['switch', '--no-guess', '--ignore-other-worktrees', branch])
+}
+
+/**
+ * Back to what headState read, the branch or the commit detached, discarding what the tracked files
+ * hold (5e's undo of a switch, which may have failed part way: git writes the files before HEAD).
+ * Only for a checkout whose own work is safe elsewhere (a promote's clean main checkout; a demote's
+ * main checkout, whose work the new worktree holds and the undo puts back).
+ */
+export async function forceCheckoutHead(repoPath: string, head: { branch: string | null; sha: string }): Promise<void> {
+  if (head.branch) {
+    assertSafeBranch(head.branch)
+    await git(repoPath, ['switch', '--discard-changes', '--no-guess', '--ignore-other-worktrees', head.branch])
+  } else {
+    await git(repoPath, ['switch', '--discard-changes', '--detach', head.sha])
+  }
+}
+
+/**
+ * A new worktree for a branch the main checkout still has (5e's demote: the main checkout leaves
+ * it only once the worktree holds it and its work). `--force` overrides only that refusal here.
+ */
+export async function addWorktreeOfCheckedOut(repoPath: string, worktreePath: string, branch: string): Promise<void> {
+  assertSafeBranch(branch)
+  await git(repoPath, ['worktree', 'add', '--force', '--', worktreePath, branch])
+}
+
 export async function revParseHead(worktreePath: string): Promise<string> {
   return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
 }
diff --git a/src/shared/promote.ts b/src/shared/promote.ts
new file mode 100644
index 0000000..15f4597
--- /dev/null
+++ b/src/shared/promote.ts
@@ -0,0 +1,87 @@
+// Promote to primary and its reverse (phase 5e), behind the `promote` capability. Both run on one
+// server, in one request each: `worktree.promote` checks a worktree's branch out in its
+// repository's main checkout, carries the worktree's uncommitted work there and removes the
+// worktree; `worktree.demote` ("Promote branch to worktree") moves the main checkout's branch, and
+// its uncommitted work, into a new worktree and puts the main checkout back on the default branch.
+// Each takes `dryRun: true` for the plan the confirmation shows. The trek-dev MCP tool
+// `promote_to_primary` asks a window to confirm (`promote.request`), and waits for its
+// `promote.answer`.
+
+/** The most uncommitted work a promote carries (one machine, nothing on the wire but the request) */
+export const MAX_PROMOTE_PATCH_BYTES = 64 * 1024 * 1024
+/** How long promote_to_primary waits for a window's answer */
+export const PROMOTE_ANSWER_TIMEOUT_MS = 15 * 60 * 1000
+/** How often promote_to_primary checks that a window still has the project open while it waits */
+export const PROMOTE_WINDOW_CHECK_MS = 5_000
+/** Paths a plan lists at most per list (the counts are complete) */
+export const MAX_PROMOTE_LISTED_PATHS = 50
+
+/** One session of the checkout that hands its sessions over, and whether it follows. */
+export interface PromoteSessionInfo {
+  title: string
+  provider: string
+  /** It moves to the other checkout (its history with it) and resumes there */
+  carried: boolean
+  /** Why not, when it is not: it is closed (promote) or stays in the main checkout (demote) */
+  reason?: string
+}
+
+/** What a promote or a demote would do, read only (`dryRun: true`); the same checks refuse a real one. */
+export interface PromotePlan {
+  /** The branch that changes checkout */
+  branch: string
+  /** The repository's main checkout */
+  mainPath: string
+  /** Promote: the worktree removed. Demote: the worktree created (the default path) */
+  worktreePath: string
+  /** Promote: what the main checkout has checked out now. Demote: the default branch it goes back to */
+  mainBranch: string | null
+  /** Uncommitted work that is carried (unstaged on arrival) */
+  dirty: boolean
+  /** The checkout that hands its sessions over has running sessions (they are stopped and resumed) */
+  loaded: boolean
+  /** The other checkout's running sessions (promote: they keep running and see the new branch) */
+  otherLoaded: boolean
+  sessions: PromoteSessionInfo[]
+  /** The review draft's comments, and whether they follow (only when the other checkout has none) */
+  reviewComments: number
+  reviewCarried: boolean
+  /** Promote: ignored files and folders in the worktree, deleted with it (5d's leftBehind) */
+  ignored: string[]
+  ignoredCount: number
+  /** Promote: files flagged assume-unchanged or skip-worktree in the worktree, whose changes are lost */
+  hiddenChanges: string[]
+  hiddenChangesCount: number
+}
+
+/** A promote or a demote that went through. */
+export interface PromoteResult {
+  /** Promote: the main checkout's worktree id. Demote: the new worktree's */
+  worktreeId: string
+  /** The sessions that moved (their ids, unchanged) */
+  moved: string[]
+  /** What did not come along, said plainly (closed sessions, a dropped review draft, a history not moved) */
+  notes: string[]
+}
+
+/** `promote.request`: an agent's promote_to_primary asks the project's windows to confirm. */
+export interface PromoteRequestEvent {
+  projectId: string
+  requestId: string
+  worktreeId: string
+  branch: string
+  /** The session that asked (its title), if the call came from one */
+  from?: string
+}
+
+/** `promote.settled`: a window answered (or the request ended): the others close their dialog. */
+export interface PromoteSettledEvent {
+  projectId: string
+  requestId: string
+}
+
+/** What a window answers: the user declined, or the promote it ran went through or failed. */
+export type PromoteOutcome =
+  | { outcome: 'declined' }
+  | { outcome: 'promoted'; worktreeId: string }
+  | { outcome: 'failed'; error: string }
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index aeba4e4..3bc8c93 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -14,6 +14,7 @@ import type {
 import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
 import type { LlmProviderId, LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
+import type { PromotePlan, PromoteRequestEvent, PromoteResult, PromoteSettledEvent } from './promote.ts'
 import type {
   ComposeAction,
   ContainerAction,
@@ -211,7 +212,13 @@ export const CAPABILITY = {
    * `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort`,
    * `move.receive` and `move.unreceive` on the target; the app relays between them
    */
-  move: 'move'
+  move: 'move',
+  /**
+   * Promote to primary and its reverse (5e): `worktree.promote` and `worktree.demote` (each with
+   * `dryRun`), and the trek-dev tool promote_to_primary's confirmation: `promote.request` to the
+   * project's subscribers, answered by one window's `promote.answer`, then `promote.settled`
+   */
+  promote: 'promote'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -317,6 +324,19 @@ export interface MethodParamsV2 {
   'worktree.commits': WorktreeRef
   /** A fresh `git status --porcelain` of the worktree (the status poll's `dirty` may be up to 30 s old) */
   'worktree.dirty': WorktreeRef
+  /**
+   * 5e: a worktree's branch into the main checkout (which must be clean), its uncommitted work
+   * carried, the worktree removed last; its Claude and Local sessions move and resume there.
+   * `dryRun` answers the plan. One request: any failure before the removal puts everything back.
+   */
+  'worktree.promote': WorktreeRef & { dryRun?: boolean }
+  /**
+   * 5e ("Promote branch to worktree"): the main checkout's branch, and its uncommitted work, into a
+   * new worktree at the default path; the main checkout goes back to the default branch.
+   */
+  'worktree.demote': RepoRef & { dryRun?: boolean }
+  /** 5e: a window's answer to `promote.request` (the first one wins; `accepted` false if late) */
+  'promote.answer': { projectId: string; requestId: string; outcome: 'declined' | 'promoted' | 'failed'; worktreeId?: string; error?: string }
   // Branch data (null clears)
   'branch.setTag': BranchRef & { tag: string | null }
   'branch.setCustomTags': BranchRef & { customTags: string[] | null }
@@ -531,6 +551,9 @@ export interface MethodResultsV2 {
   'worktree.diff': Record<string, string>
   /** null when git cannot read the worktree's status */
   'worktree.dirty': boolean | null
+  'worktree.promote': PromotePlan | PromoteResult
+  'worktree.demote': PromotePlan | PromoteResult
+  'promote.answer': { accepted: boolean }
   'worktree.commits': CommitInfo[]
   'branch.setTag': null
   'branch.setCustomTags': null
@@ -658,6 +681,10 @@ export interface EventPayloadsV2 {
    * every authenticated connection: re-read `linear.status` / `voice.settings`
    */
   'integrations.changed': IntegrationsChangedEvent
+  /** 5e: promote_to_primary asks the project's subscribers to confirm; one answers with `promote.answer` */
+  'promote.request': PromoteRequestEvent
+  /** 5e: the request was answered (or ended): close its dialog */
+  'promote.settled': PromoteSettledEvent
 }
 
 export interface IntegrationsChangedEvent {
```

</details>



### Task 2: The trek-dev tool promote_to_primary

**Files:**
- Modify: `scripts/serverMcpTools.test.mjs`
- Create: `scripts/serverPromoteTool.test.mjs`
- Modify: `server/src/mcp/tools.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1:** Apply the diff below (prototype commit f1786a0).
- [ ] **Step 2:** Run the checks: `node --test scripts/serverPromoteTool.test.mjs scripts/serverMcpTools.test.mjs` (no window; a window that declines, then one that promotes; the last window going away), `cd server && npm run typecheck`.
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff f1786a0</summary>

```diff
diff --git a/scripts/serverMcpTools.test.mjs b/scripts/serverMcpTools.test.mjs
index 5151232..055aa64 100644
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -111,7 +111,7 @@ async function toolSetup(t, opts = {}) {
 test('the tool list matches decision 5', () => {
   assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
     'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session', 'get_review_comments', 'get_stack',
-    'list_session_types', 'list_worktrees', 'load_worktree', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
+    'list_session_types', 'list_worktrees', 'load_worktree', 'promote_to_primary', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
     'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
     'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
     'wait_for_sessions', 'watch_pull_request'
diff --git a/scripts/serverPromoteTool.test.mjs b/scripts/serverPromoteTool.test.mjs
new file mode 100644
index 0000000..c660d08
--- /dev/null
+++ b/scripts/serverPromoteTool.test.mjs
@@ -0,0 +1,58 @@
+// scripts/serverPromoteTool.test.mjs — the trek-dev tool promote_to_primary (phase 5e): it asks the
+// project's windows (promote.request), waits for one's promote.answer, and says what came of it.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { existsSync } from 'node:fs'
+import { createToolCaller } from '../server/src/mcp/tools.ts'
+import { CLAUDE_ID, setup } from './promoteFixture.mjs'
+
+test('promote_to_primary: refused with no window; a window declines, or confirms and answers', async (t) => {
+  const s = await setup(t)
+  const tools = createToolCaller({ store: s.ctx.store, hub: s.hub, projects: s.projects, poller: s.poller, sessions: s.sessions, promoteRequests: s.promoteRequests })(s.projectId)
+  await assert.rejects(tools('promote_to_primary', { worktree: 'feat' }), /No Trek window/)
+  await assert.rejects(tools('promote_to_primary', { worktree: s.app }), /already the primary/)
+  const events = []
+  let reply = 'declined'
+  const window = {
+    send() {},
+    event(event, payload) {
+      events.push([event, payload])
+      if (event !== 'promote.request') return true
+      setImmediate(async () => {
+        if (reply === 'declined') {
+          await s.call('promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'declined' })
+          return
+        }
+        // As a window does: it runs the promote itself, then answers.
+        const done = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId })
+        await s.call('promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'promoted', worktreeId: done.result.worktreeId })
+      })
+      return true
+    }
+  }
+  s.hub.subscribe(`project:${s.projectId}`, window)
+  await assert.rejects(tools('promote_to_primary', { worktree: 'feat', terminalId: CLAUDE_ID }), /declined/)
+  const asked = events.find(([e]) => e === 'promote.request')[1]
+  assert.equal(asked.branch, 'feat')
+  assert.equal(asked.from, 'Claude 1')
+  assert.ok(events.some(([e, p]) => e === 'promote.settled' && p.requestId === asked.requestId))
+  assert.ok(existsSync(s.path))
+  reply = 'promoted'
+  const result = await tools('promote_to_primary', { worktree: 'feat' })
+  assert.equal(result.promoted, true)
+  assert.equal(result.primary.primary, true)
+  assert.equal(result.primary.branch, 'feat')
+  assert.ok(!existsSync(s.path))
+})
+
+test('promote_to_primary ends when the last window goes away', async (t) => {
+  const s = await setup(t)
+  const tools = createToolCaller({ store: s.ctx.store, hub: s.hub, projects: s.projects, poller: s.poller, sessions: s.sessions, promoteRequests: s.promoteRequests })(s.projectId)
+  const window = { send() {}, event: () => true }
+  s.hub.subscribe(`project:${s.projectId}`, window)
+  const keepAlive = setInterval(() => {}, 1000)
+  t.after(() => clearInterval(keepAlive))
+  const pending = tools('promote_to_primary', { worktree: 'feat' })
+  setTimeout(() => s.hub.unsubscribe(`project:${s.projectId}`, window), 50)
+  await assert.rejects(pending, /No Trek window/)
+})
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index da36fc4..05890c7 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -20,6 +20,7 @@ import type { SessionManager } from '../sessions/manager.ts'
 import type { TopicHub } from '../topicHub'
 import { dispatchV2, type V2Context } from '../v2.ts'
 import { describeWorktree, resolveWorktree } from './describe.ts'
+import type { PromoteRequests } from '../promote/requests.ts'
 import type { ToolDefinition } from './protocol.ts'
 import { projectTopic } from '../../../src/shared/model/topics.ts'
 import type { VoiceService } from '../../../src/host/voiceService.ts'
@@ -376,11 +377,21 @@ export const MCP_TOOLS: ToolDefinition[] = [
       },
       required: ['worktree']
     }
+  },
+  {
+    name: 'promote_to_primary',
+    description:
+      "Ask the user to promote a worktree to the primary checkout: its branch is checked out in the repository's main checkout (which must have no uncommitted changes), its own uncommitted work is carried there, and the worktree is removed. Its Claude and local-model sessions move to the main checkout and resume; others are closed. Every Trek window with this project open shows a confirmation; the call waits (up to 15 minutes) for the user's answer and fails if they decline, if the promote fails, or if no window has the project open. Returns the main checkout in the same shape as a list_worktrees entry. Pass your $TREK_TERMINAL_ID as terminalId so the dialog can say who asked.",
+    inputSchema: {
+      type: 'object',
+      properties: { worktree: WORKTREE_PARAM, terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID (optional)' } },
+      required: ['worktree']
+    }
   }
 ]
 
 export const MCP_INSTRUCTIONS =
-  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_review_comments reads the user's draft line comments on a worktree's changes. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
+  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_review_comments reads the user's draft line comments on a worktree's changes. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. promote_to_primary asks the user to check a worktree's branch out in the main checkout (they confirm in a Trek window). A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
 
 export interface ToolDeps {
   store: ConfigStore
@@ -394,6 +405,8 @@ export interface ToolDeps {
   machine?: Machine
   /** The pull request watch, for watch_pull_request; without it the tool says the server does not watch PRs */
   prWatch?: PrWatcher
+  /** promote_to_primary's confirmations (5e); without it the tool says no window can confirm */
+  promoteRequests?: PromoteRequests
   /** How often waits re-check session state (default 250 ms) */
   pollMs?: number
   /** wait_for_sessions waits this long first when its condition already holds (default 1.5 s) */
@@ -853,6 +866,38 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         return { branch, pullRequest: branchData(repo, branch).pr ?? null, watching: watch }
       },
 
+      // 5e: a window confirms and runs the promote; this waits for its answer.
+      promote_to_primary: async (args, project, signal) => {
+        const { worktree } = resolveWorktree(project, args.worktree)
+        if (worktree.isMain) throw bad('That worktree is already the primary checkout')
+        if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD); it can't be promoted`)
+        let from: string | undefined
+        if (typeof args.terminalId === 'string' && args.terminalId) {
+          try {
+            from = sessionIn(args.terminalId, project).session.title
+          } catch {
+            // an unknown terminal only loses the dialog's "asked by"
+          }
+        }
+        const nobody = 'No Trek window has this project open to confirm the promote, so nothing was changed. Ask the user to open the project, or to promote it themselves.'
+        if (!deps.promoteRequests) throw codedError('BAD_REQUEST', nobody)
+        const answer = await deps.promoteRequests.ask(projectId, { worktreeId: worktree.id, branch: worktree.branch, ...(from ? { from } : {}) }, signal)
+        switch (answer.outcome) {
+          case 'promoted':
+            return { promoted: true, primary: describeById(answer.worktreeId) }
+          case 'declined':
+            throw bad('The user declined the promote; nothing was changed. Do not ask again unless they say so.')
+          case 'failed':
+            throw codedError('GIT_ERROR', `The promote failed and nothing was changed: ${answer.error}`)
+          case 'no-window':
+            throw bad(nobody)
+          case 'timeout':
+            throw bad('The user did not answer within 15 minutes; nothing was changed.')
+          case 'cancelled':
+            throw disconnected()
+        }
+      },
+
       list_session_types: (_args, project) => (project.settings.sessionTypes ?? []).map(withoutIcon),
 
       save_session_type: async (args, project) => {
diff --git a/server/src/server.ts b/server/src/server.ts
index db8a3a7..2495775 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -453,7 +453,7 @@ export function startServer(
     shutdown: (reason) => shutdown(reason)
   }
   if (access) {
-    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine, prWatch })
+    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine, prWatch, promoteRequests })
     const callerFor = (projectId: string): ToolCall => {
       let call = callers.get(projectId)
       if (!call) callers.set(projectId, (call = caller(projectId)))
```

</details>



### Task 3: The app: the menu items, the confirmation, the window following requests

**Files:**
- Modify: `scripts/backendFeatures.test.mjs`
- Create: `scripts/promoteFlow.test.mjs`
- Modify: `scripts/v2Backend.test.mjs`
- Modify: `src/renderer/src/backend.ts`
- Modify: `src/renderer/src/backendFeatures.ts`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`
- Modify: `src/renderer/src/v2/backendV2.ts`
- Modify: `src/renderer/src/v2/installV2.ts`
- Create: `src/renderer/src/v2/promoteFlow.ts`
- Modify: `src/renderer/src/v2/V2Workspace.tsx`

- [ ] **Step 1:** Apply the diff below (prototype commits 701f9f7, bbc2f63).
- [ ] **Step 2:** Run the checks: `node --test scripts/promoteFlow.test.mjs scripts/v2Backend.test.mjs scripts/backendFeatures.test.mjs`, `npm run typecheck`. The follow-up commit moves the subscription from installV2 (too early: no connection yet) to V2Workspace.
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff 701f9f7</summary>

```diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 1888982..53ae4db 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -24,7 +24,7 @@ test('an empty window has no feature (4e: no file windows)', () => {
 
 test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'moveWorktree', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'moveWorktree', 'reveal', 'openInEditor', 'promote', 'settingsEdit', 'globalPanel'])
 })
 
 test('moving a worktree to another server follows move (5d)', () => {
@@ -32,6 +32,11 @@ test('moving a worktree to another server follows move (5d)', () => {
   assert.equal(v2Features(['review', 'mcp']).moveWorktree, false)
 })
 
+test('promote to primary and its reverse follow promote (5e)', () => {
+  assert.equal(v2Features(['promote']).promote, true)
+  assert.equal(v2Features(['move', 'review', 'mcp']).promote, false)
+})
+
 test('the Changes tab review follows review (5c-2): an older server has only the branch view', () => {
   assert.equal(v2Features(['review']).review, true)
   assert.equal(v2Features(['mcp', 'linear', 'voice', 'skills', 'local'], { localEntry: true }).review, false)
diff --git a/scripts/promoteFlow.test.mjs b/scripts/promoteFlow.test.mjs
new file mode 100644
index 0000000..a532e52
--- /dev/null
+++ b/scripts/promoteFlow.test.mjs
@@ -0,0 +1,81 @@
+// scripts/promoteFlow.test.mjs — the promote confirmations' text (phase 5e) and the window's
+// follower of promote_to_primary's requests.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { demotePrompt, followPromoteRequests, promotePrompt } from '../src/renderer/src/v2/promoteFlow.ts'
+
+const plan = (extra = {}) => ({
+  branch: 'feat', mainPath: '/r', worktreePath: '/r-feat', mainBranch: 'main', dirty: false, loaded: false, otherLoaded: false,
+  sessions: [], reviewComments: 0, reviewCarried: false, ignored: [], ignoredCount: 0, hiddenChanges: [], hiddenChangesCount: 0, ...extra
+})
+
+test('promotePrompt says what moves, what is closed, what is lost and who asked', () => {
+  const p = promotePrompt(
+    plan({
+      dirty: true, loaded: true, otherLoaded: true,
+      sessions: [{ title: 'Claude 1', provider: 'claude', carried: true }, { title: 'Codex 1', provider: 'codex', carried: false, reason: 'x' }],
+      reviewComments: 2, reviewCarried: false, ignored: ['a/', 'b', 'c', 'd', 'e', 'f'], ignoredCount: 7, hiddenChanges: ['h'], hiddenChangesCount: 1
+    }),
+    { vm: 'trek-feat', asked: { from: 'Claude 1', stillAsked: () => true } }
+  )
+  assert.equal(p.title, 'Promote to Primary')
+  assert.equal(p.confirmLabel, 'Promote')
+  assert.match(p.detail, /^“Claude 1” asked for this \(promote_to_primary\)\./)
+  assert.match(p.detail, /uncommitted changes move with it/)
+  assert.match(p.detail, /1 session \(Claude 1\) move to the main checkout and resume/)
+  assert.match(p.detail, /“Codex 1” can't follow and is closed/)
+  assert.match(p.detail, /main checkout's own sessions keep running/)
+  assert.match(p.detail, /review draft \(2 comments\) is dropped/)
+  assert.match(p.detail, /a\/, b, c, d, e and 2 more/)
+  assert.match(p.detail, /skip-worktree or assume-unchanged\): h\./)
+  assert.match(p.detail, /Colima VM “trek-feat”/)
+  assert.doesNotMatch(promotePrompt(plan()).detail, /asked|resume|review|ignored/)
+})
+
+test('demotePrompt says where the branch goes and which sessions stay', () => {
+  const p = demotePrompt(plan({ dirty: true, sessions: [{ title: 'A', provider: 'claude', carried: true }, { title: 'G', provider: 'gemini', carried: false }], reviewComments: 1, reviewCarried: true }))
+  assert.equal(p.confirmLabel, 'Move to Worktree')
+  assert.match(p.detail, /created at \/r-feat, and the main checkout goes back to “main”/)
+  assert.match(p.detail, /“G” can't follow and stays in the main checkout/)
+  assert.match(p.detail, /review draft \(1 comment\) moves too/)
+})
+
+test('followPromoteRequests: one at a time, in order; settled ones skipped or left unanswered; a throw is a failure', async () => {
+  const on = { request: [], settled: [] }
+  const answers = []
+  const ran = []
+  let release
+  const gate = new Promise((r) => { release = r })
+  let left = false
+  const off = followPromoteRequests({
+    onRequest: (l) => { on.request.push(l); return () => { on.request = [] } },
+    onSettled: (l) => { on.settled.push(l); return () => { on.settled = [] } },
+    run: async (event, asked) => {
+      ran.push(event.requestId)
+      if (event.requestId === 'a') await gate
+      if (event.requestId === 'boom') throw new Error('kaput')
+      return asked.stillAsked() ? { outcome: 'promoted', worktreeId: 'm' } : { outcome: 'declined' }
+    },
+    answer: async (requestId, outcome) => void answers.push([requestId, outcome]),
+    left: () => left
+  })
+  const ask = (requestId) => on.request[0]({ projectId: 'p', requestId, worktreeId: 'w', branch: 'b' })
+  ask('a')
+  ask('b')
+  ask('boom')
+  await new Promise((r) => setImmediate(r))
+  assert.deepEqual(ran, ['a'])
+  // b is answered elsewhere before its turn; a while its dialog is open.
+  on.settled[0]({ projectId: 'p', requestId: 'b' })
+  on.settled[0]({ projectId: 'p', requestId: 'a' })
+  release()
+  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
+  assert.deepEqual(ran, ['a', 'boom'])
+  assert.deepEqual(answers, [['boom', { outcome: 'failed', error: 'kaput' }]])
+  left = true
+  ask('c')
+  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
+  assert.deepEqual(ran, ['a', 'boom'])
+  off()
+  assert.equal(on.request.length, 0)
+})
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 4f389b2..58400ac 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -907,3 +907,77 @@ test('dismissDecision sends session.dismissDecision where the server has decisio
   await old.backend.sessions.dismissDecision('s1')
   assert.deepEqual(old.calls, [])
 })
+
+// ---- Promote to primary and its reverse (5e) ----
+
+const PLAN = {
+  branch: 'feat', mainPath: '/r', worktreePath: '/r-feat', mainBranch: 'main', dirty: true, loaded: false, otherLoaded: false,
+  sessions: [{ title: 'Claude 1', provider: 'claude', carried: true }], reviewComments: 0, reviewCarried: false,
+  ignored: [], ignoredCount: 0, hiddenChanges: [], hiddenChangesCount: 0
+}
+const FEAT = { path: '/r-feat', repoId: 'r1', branch: 'feat', isMain: false }
+
+test('worktrees.promote: the plan, the confirm, the stack and VM, then worktree.promote (slow)', async () => {
+  const replies = { 'worktree.promote': (p) => (p.dryRun ? PLAN : { worktreeId: 'wm', moved: ['s1'], notes: [] }) }
+  const { backend, calls, ui, timeouts } = setup({ replies, confirms: [true], capabilities: ['promote', 'stacks', 'env'], machine: { stack: 'feat', env: 'trek-feat' } })
+  const outcome = await backend.worktrees.promote(FEAT, undefined)
+  assert.deepEqual(outcome, { outcome: 'promoted', worktreeId: 'wm' })
+  assert.deepEqual(calls.map((c) => c[0]), ['worktree.promote', 'stack.sh destroy', 'colima delete', 'worktree.promote'])
+  assert.deepEqual(calls[0][1], { projectId: 'p1', worktreeId: 'w2', dryRun: true })
+  assert.deepEqual(calls[3][1], { projectId: 'p1', worktreeId: 'w2' })
+  const confirm = ui.find((u) => u[0] === 'confirm+stack')
+  assert.equal(confirm[1], 'Promote to Primary')
+  assert.match(confirm[2], /“feat” will be checked out in the main checkout at \/r \(now on main\)/)
+  assert.match(confirm[2], /Colima VM “trek-feat”/)
+  assert.ok(timeouts.some(([m]) => m === 'worktree.promote'))
+})
+
+test('worktrees.promote: declined sends nothing more; a refused plan is shown and nothing is torn down', async () => {
+  const declined = setup({ replies: { 'worktree.promote': PLAN }, confirms: [false], capabilities: ['promote'] })
+  assert.deepEqual(await declined.backend.worktrees.promote(FEAT, undefined), { outcome: 'declined' })
+  assert.deepEqual(declined.calls.map((c) => c[0]), ['worktree.promote'])
+  const refused = setup({ replies: { 'worktree.promote': new CodedError('CONFLICT', 'the main checkout /r has uncommitted changes') }, capabilities: ['promote', 'stacks'], machine: { stack: 'feat' } })
+  const outcome = await refused.backend.worktrees.promote(FEAT, undefined)
+  assert.equal(outcome.outcome, 'failed')
+  assert.deepEqual(refused.ui.filter((u) => u[0] === 'error').map((u) => u[1]), ['Could not promote worktree'])
+  assert.ok(!refused.calls.some((c) => c[0] === 'stack.sh destroy'))
+})
+
+test('worktrees.promote: a failed promote after the teardown says the stack is gone', async () => {
+  const replies = { 'worktree.promote': (p) => (p.dryRun ? PLAN : new CodedError('GIT_ERROR', 'locked')) }
+  const { backend, ui } = setup({ replies, confirms: [true], capabilities: ['promote', 'stacks'], machine: { stack: 'feat' } })
+  const outcome = await backend.worktrees.promote(FEAT, undefined)
+  assert.equal(outcome.outcome, 'failed')
+  assert.match(ui.find((u) => u[0] === 'error')[2], /locked.*dev stack was already removed/)
+})
+
+test('worktrees.demote: the plan, the confirm, worktree.demote', async () => {
+  const replies = { 'worktree.demote': (p) => (p.dryRun ? { ...PLAN, worktreePath: '/r-feat' } : { worktreeId: 'w9', moved: [], notes: [] }) }
+  const { backend, calls, ui } = setup({ replies, confirms: [true], capabilities: ['promote'] })
+  await backend.worktrees.demote({ path: '/r', repoId: 'r1', branch: 'feat', isMain: true })
+  assert.deepEqual(calls, [
+    ['worktree.demote', { projectId: 'p1', repoId: 'r1', dryRun: true }],
+    ['worktree.demote', { projectId: 'p1', repoId: 'r1' }]
+  ])
+  assert.deepEqual(ui.find((u) => u[0] === 'confirm'), ['confirm', 'Promote Branch to Worktree', 'Move to Worktree'])
+})
+
+test('promote_to_primary in a window: a request runs the promote and answers; one settled elsewhere is skipped', async () => {
+  const replies = { 'worktree.promote': (p) => (p.dryRun ? PLAN : { worktreeId: 'wm', moved: [], notes: [] }), 'promote.answer': { accepted: true } }
+  const { backend, calls, listeners } = setup({
+    replies,
+    confirms: [true],
+    capabilities: ['promote'],
+    state: { hostWorktrees: { 'r1 local': [{ path: '/r', repoId: 'r1', isMain: true }, FEAT] } }
+  })
+  const off = backend.worktrees.followPromoteRequests()
+  listeners['promote.settled'][0]({ projectId: 'p1', requestId: 'gone' })
+  listeners['promote.request'][0]({ projectId: 'p1', requestId: 'gone', worktreeId: 'w2', branch: 'feat' })
+  listeners['promote.request'][0]({ projectId: 'other', requestId: 'x', worktreeId: 'w2', branch: 'feat' })
+  listeners['promote.request'][0]({ projectId: 'p1', requestId: 'r1', worktreeId: 'w2', branch: 'feat', from: 'Claude 1' })
+  for (let i = 0; i < 20 && !calls.some((c) => c[0] === 'promote.answer'); i++) await new Promise((r) => setImmediate(r))
+  assert.deepEqual(calls.map((c) => c[0]), ['worktree.promote', 'worktree.promote', 'promote.answer'])
+  assert.deepEqual(calls[2][1], { projectId: 'p1', requestId: 'r1', outcome: 'promoted', worktreeId: 'wm' })
+  off()
+  assert.equal(listeners['promote.request'].length, 0)
+})
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index db8968d..fbed60b 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -46,6 +46,8 @@ import type {
 } from '../../shared/types'
 import type { VoiceSummaryEvent } from '../../shared/protocolV2'
 import type { ReviewComment } from '../../shared/model/types'
+import type { PromoteOutcome } from '../../shared/promote'
+import type { PromoteAsked } from './v2/promoteFlow'
 
 /** What `review.add` takes: a comment before the server gives it an id and a time. */
 export type NewReviewComment = Omit<ReviewComment, 'id' | 'at'>
@@ -110,6 +112,16 @@ export interface WindowBackend {
     setOrder(keys: string[]): Promise<void>
     /** The v2 worktree at this path, for a move to another server (feature `moveWorktree`); null if it isn't one */
     moveRef(path: string): { projectId: string; worktreeId: string } | null
+    /**
+     * Promote to primary (feature `promote`, 5e): the server's plan, the confirmation (with the
+     * dev stack's checkbox, as Delete), the teardown, then `worktree.promote`. Reports its own
+     * failures and resolves what came of it. `asked`: an agent's promote_to_primary asked.
+     */
+    promote(info: GitWorktreeInfo, instance: WorktreeInstance | undefined, asked?: PromoteAsked): Promise<PromoteOutcome>
+    /** "Promote branch to worktree" (feature `promote`): the main checkout's branch into a new worktree */
+    demote(info: GitWorktreeInfo): Promise<void>
+    /** promote_to_primary's requests to this window: each runs `promote` and answers; returns the unsubscribe */
+    followPromoteRequests(): () => void
   }
   readonly git: {
     listWorktrees(repoId: string): Promise<GitWorktreeInfo[]>
@@ -274,7 +286,18 @@ export const idleBackend: WindowBackend = {
     seen: noProject,
     dismissDecision: noProject
   },
-  worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject, moveRef: () => null },
+  worktrees: {
+    load: noProject,
+    unload: noProject,
+    unloadAll: noProject,
+    create: noProject,
+    remove: noProject,
+    setOrder: noProject,
+    moveRef: () => null,
+    promote: noProject,
+    demote: noProject,
+    followPromoteRequests: () => () => {}
+  },
   git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, commits: noProject, pull: noProject, push: noProject, dirty: noProject },
   docker: { list: noProject, container: noProject, compose: noProject, onLog: () => () => {} },
   env: {
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index d93cd5b..8b2f1a9 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -44,9 +44,10 @@ export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map
 /**
  * A server window (3c-2, 4c, 5a). The ceiling: the v2 backend's features are
  * these AND what `v2Features` asks of the server's welcome and the window's entry.
- * - Off: the bot (phase 5) and promote, which protocol v2 has no command for.
+ * - Off: the bot, which protocol v2 has no command for.
  * - Moving a worktree to another server (5d) needs `move` on this server (the target's is
  *   checked when it is picked).
+ * - Promote to primary and "Promote branch to worktree" (5e) need `promote`.
  * - Settings are edited on the server (every v2 server has
  *   project.updateSettings, so no capability), with the sections
  *   `settingsSections` picks.
@@ -76,7 +77,7 @@ export const V2_FEATURES: BackendFeatures = {
   moveWorktree: true,
   reveal: true,
   openInEditor: true,
-  promote: false,
+  promote: true,
   settingsEdit: true,
   globalPanel: true
 }
@@ -98,7 +99,8 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   skills: 'skills',
   prWatch: 'prWatch',
   review: 'review',
-  moveWorktree: 'move'
+  moveWorktree: 'move',
+  promote: 'promote'
 }
 
 /**
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index d3eff6b..3cac29d 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -640,7 +640,37 @@ export function WorktreeDetail({
               </>
             )}
             <div className="detail-menu-divider" />
-            {/* Promote comes back with a server command of its own. */}
+            {/* 5e: worktree.promote and worktree.demote, each one request on the server. */}
+            {features.promote && info.branch && info.isMain && (
+              <div
+                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
+                onClick={() => {
+                  if (busy || offline) return
+                  setMenuOpen(false)
+                  void runAction(() => getBackend().worktrees.demote({ ...info, repoId: info.repoId ?? repo.id }))
+                }}
+              >
+                <div className="detail-menu-name">Promote branch to worktree…</div>
+                <div className="detail-menu-desc">
+                  Move {info.branch} and its uncommitted work to its own worktree; the main checkout returns to the default branch
+                </div>
+              </div>
+            )}
+            {features.promote && info.branch && !info.isMain && (
+              <div
+                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
+                onClick={() => {
+                  if (busy || offline) return
+                  setMenuOpen(false)
+                  void runAction(async () => {
+                    await getBackend().worktrees.promote(info, instance)
+                  })
+                }}
+              >
+                <div className="detail-menu-name">Promote to primary…</div>
+                <div className="detail-menu-desc">Check out {info.branch} in the main checkout, with its uncommitted work and sessions</div>
+              </div>
+            )}
             {canMove && !info.isMain && info.branch && getBackend().worktrees.moveRef(info.path) && (
               <div
                 className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 8b308f5..65f50b0 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -14,6 +14,8 @@
 //
 // Pure: the store, the connection, the dialogs and the terminals come in as
 // `V2BackendDeps` (built by installV2.ts), so `node --test` covers it.
+import type { PromoteOutcome, PromotePlan, PromoteResult } from '../../../shared/promote.ts'
+import { demotePrompt, followPromoteRequests, promotePrompt } from './promoteFlow.ts'
 import { v2Features, type BackendFeatures } from '../backendFeatures.ts'
 import { v2WorktreeOrder, type V2IdMap } from './projector.ts'
 import { errorCode, errorText, PROMPT_NOT_CONFIRMED, withPromptText } from './errors.ts'
@@ -149,6 +151,8 @@ const REMOVE_FAILED = 'Could not delete worktree'
 const LONG_MS = 30 * 60_000
 /** colima stop and delete, a stack's down and destroy (each Ctrl-C's a running up and waits up to a minute) */
 const SLOW_MS = 10 * 60_000
+const PROMOTE_FAILED = 'Could not promote worktree'
+const DEMOTE_FAILED = 'Could not move the branch to a worktree'
 /** docker start, stop and restart (the server gives docker two minutes) */
 const CONTAINER_MS = 3 * 60_000
 /** A base64 text (an mp3 over the wire) as bytes. */
@@ -457,6 +461,91 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
           await fail(forceErr)
         }
       },
+      // 5e. The plan first (the same checks as the real one, so nothing is torn down for a promote
+      // the server would refuse), then the confirmation, the stack and the VM (they need the
+      // worktree's files), then the promote itself in one request.
+      promote: async (info, instance, asked) => {
+        const legacyId = instance?.id ?? legacyIdAt(info.path)
+        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
+        const failed = async (err: unknown, note = ''): Promise<PromoteOutcome> => {
+          const error = errorText(err) + note
+          await deps.showError(PROMOTE_FAILED, error)
+          return { outcome: 'failed', error }
+        }
+        if (!ref) return failed(new Error('This worktree is no longer in the project.'))
+        const { worktreeId } = ref
+        let plan: PromotePlan
+        try {
+          plan = (await request('worktree.promote', { projectId, worktreeId, dryRun: true })) as PromotePlan
+        } catch (err) {
+          return failed(err)
+        }
+        const machine = currentFeatures()
+        const env = machine.env ? deps.teardown.environment(info) : undefined
+        const prompt = promotePrompt(plan, { vm: env?.profile, asked })
+        const { confirmed, stackName } = machine.stacks
+          ? await deps.teardown.confirm(info, prompt, backend)
+          : { confirmed: await deps.confirm(prompt), stackName: undefined }
+        if (!confirmed) return { outcome: 'declined' }
+        // Another window answered the agent while this dialog was open: its answer stands.
+        if (asked && !asked.stillAsked()) {
+          await deps.showError(PROMOTE_FAILED, 'Another window already answered this request; nothing was done here.')
+          return { outcome: 'declined' }
+        }
+        if (stackName) await deps.teardown.destroyStack(info, stackName, backend)
+        if (env) await deps.teardown.destroyEnvironment(info, backend)
+        try {
+          const result = (await request('worktree.promote', { projectId, worktreeId }, { timeoutMs: SLOW_MS })) as PromoteResult
+          if (result.notes.length > 0) await deps.showError('Promoted, with notes', result.notes.join('\n'))
+          return { outcome: 'promoted', worktreeId: result.worktreeId }
+        } catch (err) {
+          return failed(err, tornDownNote(!!stackName, !!env))
+        }
+      },
+      demote: async (info) => {
+        const repoId = info.repoId
+        if (!repoId) {
+          await deps.showError(DEMOTE_FAILED, 'This checkout is no longer in the project.')
+          return
+        }
+        let plan: PromotePlan
+        try {
+          plan = (await request('worktree.demote', { projectId, repoId, dryRun: true })) as PromotePlan
+        } catch (err) {
+          await deps.showError(DEMOTE_FAILED, errorText(err))
+          return
+        }
+        if (!(await deps.confirm(demotePrompt(plan)))) return
+        try {
+          const result = (await request('worktree.demote', { projectId, repoId }, { timeoutMs: SLOW_MS })) as PromoteResult
+          if (result.notes.length > 0) await deps.showError('Moved, with notes', result.notes.join('\n'))
+        } catch (err) {
+          await deps.showError(DEMOTE_FAILED, errorText(err))
+        }
+      },
+      followPromoteRequests: () =>
+        followPromoteRequests({
+          onRequest: (listener) =>
+            deps.onEvent('promote.request', (event) => {
+              if (event.projectId === projectId) listener(event)
+            }),
+          onSettled: (listener) =>
+            deps.onEvent('promote.settled', (event) => {
+              if (event.projectId === projectId) listener(event)
+            }),
+          run: async (event, asked) => {
+            const legacyId = ids().legacyByWorktree[event.worktreeId]
+            const path = legacyId === undefined ? undefined : instancePath(legacyId)
+            const info = path === undefined ? undefined : Object.values(deps.state().hostWorktrees).flat().find((w) => w.path === path)
+            if (!info || legacyId === undefined) return { outcome: 'failed', error: "This window doesn't list that worktree" }
+            const instance = deps.state().project?.repositories.flatMap((r) => r.worktrees).find((w) => w.id === legacyId)
+            return backend.worktrees.promote(info, instance, asked)
+          },
+          answer: async (requestId, outcome) => {
+            await request('promote.answer', { projectId, requestId, ...outcome }).catch(() => {})
+          },
+          left: deps.left
+        }),
       moveRef: (path) => {
         const legacyId = legacyIdAt(path)
         const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index c2dc859..ac0382c 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -147,6 +147,9 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     left: () => left
   })
 
+  // promote_to_primary (5e): an agent's request shows this window's promote confirmation.
+  const offPromote = backend.worktrees.followPromoteRequests()
+
   // Settings edits: one compare-and-set per field, shown as pending (the overlay) until the
   // mirror holds the server's answer; a CONFLICT asks Reload or Keep Mine (settingsWriter.ts).
   const topic = `project:${projectId}` as const
@@ -296,6 +299,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
       settingsWriter.clear()
       setV2ProjectOverlay(null)
       offAgents()
+      offPromote()
       if (agentsRetry !== null) clearTimeout(agentsRetry)
       cancelRepoPath()
       cancelAll()
diff --git a/src/renderer/src/v2/promoteFlow.ts b/src/renderer/src/v2/promoteFlow.ts
new file mode 100644
index 0000000..a3cb30c
--- /dev/null
+++ b/src/renderer/src/v2/promoteFlow.ts
@@ -0,0 +1,105 @@
+// Promote to primary and "Promote branch to worktree" in a server window (phase 5e): the
+// confirmation's text from the server's plan (`worktree.promote` / `worktree.demote` with
+// `dryRun`), and the window's side of the trek-dev tool promote_to_primary: each `promote.request`
+// runs the same promote the menu item does, one at a time, and answers with what came of it. The
+// backend (backendV2.ts) does the requests; this file has no store or window, so it runs under
+// node --test.
+import type { PromoteOutcome, PromotePlan, PromoteRequestEvent, PromoteSettledEvent } from '../../../shared/promote.ts'
+import type { ConfirmPrompt } from './backendV2.ts'
+
+/** Who asked, when an agent's promote_to_primary did: the dialog says so. */
+export interface PromoteAsked {
+  from?: string
+  /** False once another window answered (the user's answer here no longer counts) */
+  stillAsked(): boolean
+}
+
+const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
+
+function listed(paths: readonly string[], total: number): string {
+  const shown = paths.slice(0, 5).join(', ')
+  return total > 5 ? `${shown} and ${total - 5} more` : shown
+}
+
+/** The confirmation of a promote: what moves, what stays, what goes. */
+export function promotePrompt(plan: PromotePlan, options: { vm?: string; asked?: PromoteAsked } = {}): ConfirmPrompt {
+  const carried = plan.sessions.filter((s) => s.carried)
+  const closed = plan.sessions.filter((s) => !s.carried)
+  const parts: string[] = []
+  if (options.asked) parts.push(`${options.asked.from ? `“${options.asked.from}”` : 'An agent'} asked for this (promote_to_primary).`)
+  parts.push(
+    `“${plan.branch}” will be checked out in the main checkout at ${plan.mainPath}` +
+      (plan.mainBranch ? ` (now on ${plan.mainBranch})` : '') +
+      `, then the worktree at ${plan.worktreePath} is deleted.`
+  )
+  parts.push(plan.dirty ? 'Its uncommitted changes move with it (unstaged).' : 'It has no uncommitted changes.')
+  if (carried.length > 0) {
+    parts.push(`${count(carried.length, 'session')} (${carried.map((s) => s.title).join(', ')}) move to the main checkout${plan.loaded ? ' and resume' : ''}.`)
+  }
+  if (closed.length > 0) parts.push(`${closed.map((s) => `“${s.title}”`).join(', ')} can't follow and ${closed.length === 1 ? 'is' : 'are'} closed.`)
+  if (plan.otherLoaded) parts.push("The main checkout's own sessions keep running and will see the new branch.")
+  if (plan.reviewComments > 0) {
+    parts.push(
+      plan.reviewCarried
+        ? `Its review draft (${count(plan.reviewComments, 'comment')}) moves too.`
+        : `Its review draft (${count(plan.reviewComments, 'comment')}) is dropped: the main checkout has one of its own.`
+    )
+  }
+  if (plan.ignoredCount > 0) parts.push(`Deleted with the worktree, never moved (ignored by git): ${listed(plan.ignored, plan.ignoredCount)}.`)
+  if (plan.hiddenChangesCount > 0) parts.push(`Lost with the worktree (hidden from git by skip-worktree or assume-unchanged): ${listed(plan.hiddenChanges, plan.hiddenChangesCount)}.`)
+  if (options.vm) parts.push(`Its Docker environment (Colima VM “${options.vm}”) and all its data will also be deleted.`)
+  return { title: 'Promote to Primary', message: `Promote “${plan.branch}” to the primary checkout?`, detail: parts.join(' '), confirmLabel: 'Promote' }
+}
+
+/** The confirmation of "Promote branch to worktree". */
+export function demotePrompt(plan: PromotePlan): ConfirmPrompt {
+  const carried = plan.sessions.filter((s) => s.carried)
+  const staying = plan.sessions.filter((s) => !s.carried)
+  const parts: string[] = [
+    `A worktree for “${plan.branch}” will be created at ${plan.worktreePath}, and the main checkout goes back to “${plan.mainBranch}”.`,
+    plan.dirty ? 'Its uncommitted changes move to the new worktree (unstaged).' : 'It has no uncommitted changes.'
+  ]
+  if (carried.length > 0) parts.push(`${count(carried.length, 'session')} (${carried.map((s) => s.title).join(', ')}) move to the new worktree${plan.loaded ? ' and resume' : ''}.`)
+  if (staying.length > 0) parts.push(`${staying.map((s) => `“${s.title}”`).join(', ')} can't follow and ${staying.length === 1 ? 'stays' : 'stay'} in the main checkout, which will be on “${plan.mainBranch}”.`)
+  if (plan.reviewComments > 0) parts.push(`Its review draft (${count(plan.reviewComments, 'comment')}) moves too.`)
+  return { title: 'Promote Branch to Worktree', message: `Move “${plan.branch}” into its own worktree?`, detail: parts.join(' '), confirmLabel: 'Move to Worktree' }
+}
+
+export interface PromoteRequestDeps {
+  onRequest(listener: (event: PromoteRequestEvent) => void): () => void
+  onSettled(listener: (event: PromoteSettledEvent) => void): () => void
+  /** Runs the promote the request names (its confirmation first); what came of it */
+  run(event: PromoteRequestEvent, asked: PromoteAsked): Promise<PromoteOutcome>
+  /** Sends the window's answer (`promote.answer`); never rejects */
+  answer(requestId: string, outcome: PromoteOutcome): Promise<void>
+  /** The window left the project: nothing more is asked or answered */
+  left(): boolean
+}
+
+/**
+ * Follows promote_to_primary's requests: one confirmation at a time, in order; a request settled
+ * elsewhere before its turn is skipped, and one settled while its dialog was open is not answered
+ * (the backend sees `stillAsked` false and does nothing). Returns the unsubscribe.
+ */
+export function followPromoteRequests(deps: PromoteRequestDeps): () => void {
+  const settled = new Set<string>()
+  let chain: Promise<void> = Promise.resolve()
+  const offSettled = deps.onSettled((event) => settled.add(event.requestId))
+  const offRequest = deps.onRequest((event) => {
+    chain = chain.then(async () => {
+      if (deps.left() || settled.has(event.requestId)) return
+      const asked: PromoteAsked = { from: event.from, stillAsked: () => !settled.has(event.requestId) && !deps.left() }
+      let outcome: PromoteOutcome
+      try {
+        outcome = await deps.run(event, asked)
+      } catch (err) {
+        outcome = { outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
+      }
+      if (!deps.left() && !settled.has(event.requestId)) await deps.answer(event.requestId, outcome)
+    })
+  })
+  return () => {
+    offRequest()
+    offSettled()
+  }
+}
```

</details>


<details><summary>Diff bbc2f63</summary>

```diff
diff --git a/src/renderer/src/v2/V2Workspace.tsx b/src/renderer/src/v2/V2Workspace.tsx
index 0577eb8..5125209 100644
--- a/src/renderer/src/v2/V2Workspace.tsx
+++ b/src/renderer/src/v2/V2Workspace.tsx
@@ -2,6 +2,7 @@ import { useEffect, useState } from 'react'
 import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
 import { globalPanelMode } from '../backendFeatures'
 import { useFeatures } from '../useFeatures'
+import { getBackend } from '../backend'
 import { useEnvironmentPoll } from '../useEnvironmentPoll'
 import { Sidebar } from '../components/Sidebar'
 import { WorktreeDetail } from '../components/WorktreeDetail'
@@ -27,6 +28,9 @@ export function V2Workspace(): React.JSX.Element {
   const globalTabs = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID]?.length ?? 0)
   const globalMode = globalPanelMode(features, globalTabs)
   useEnvironmentPoll(features.env)
+  // promote_to_primary (5e): an agent's request shows this window's promote confirmation. Re-followed
+  // when the features change (the welcome's capabilities, a new backend), as the voice summaries are.
+  useEffect(() => (features.promote ? getBackend().worktrees.followPromoteRequests() : undefined), [features])
 
   // The link dropped: a focused field or button must not take Enter or typing meanwhile.
   useEffect(() => {
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index ac0382c..c2dc859 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -147,9 +147,6 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     left: () => left
   })
 
-  // promote_to_primary (5e): an agent's request shows this window's promote confirmation.
-  const offPromote = backend.worktrees.followPromoteRequests()
-
   // Settings edits: one compare-and-set per field, shown as pending (the overlay) until the
   // mirror holds the server's answer; a CONFLICT asks Reload or Keep Mine (settingsWriter.ts).
   const topic = `project:${projectId}` as const
@@ -299,7 +296,6 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
       settingsWriter.clear()
       setV2ProjectOverlay(null)
       offAgents()
-      offPromote()
       if (agentsRetry !== null) clearTimeout(agentsRetry)
       cancelRepoPath()
       cancelAll()
```

</details>



### Task 4: exportDirtyPatch keeps the index's times (a 5d bug)

**Files:**
- Modify: `scripts/serverMove.test.mjs`
- Modify: `src/host/gitService.ts`

- [ ] **Step 1:** Apply the diff below (prototype commit 5ab6401).
- [ ] **Step 2:** Run the checks: `node --test scripts/serverMove.test.mjs` (the new racily-clean test fails without the fix: 9 runs in 10 left the edit out). Can land on its own, first.
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff 5ab6401</summary>

```diff
diff --git a/scripts/serverMove.test.mjs b/scripts/serverMove.test.mjs
index f8fa179..e1ee45b 100644
--- a/scripts/serverMove.test.mjs
+++ b/scripts/serverMove.test.mjs
@@ -298,6 +298,20 @@ test('move.receive validates what it is given', async (t) => {
   assert.equal(await code({ repoId: 'nope' }), 'NOT_FOUND')
 })
 
+test('exportDirtyPatch carries a same-size edit made in the second its file was committed (racily clean)', async (t) => {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-racy-')))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv })
+  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
+  git(dir, 'add', '.')
+  git(dir, 'commit', '-q', '-m', 'init')
+  // Same size, same second: only the index file's own mtime tells git to look at the content.
+  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
+  await new Promise((r) => setTimeout(r, 1100))
+  const { patch } = await exportDirtyPatch(dir)
+  assert.match(patch, /\+TWO/)
+})
+
 test('move.export leaves out the linked dirs (the target links them itself) and refuses non-UTF-8 text', async (t) => {
   const s = await setup(t)
   mkdirSync(join(s.a, '.trek'))
diff --git a/src/host/gitService.ts b/src/host/gitService.ts
index 5965e27..007e258 100644
--- a/src/host/gitService.ts
+++ b/src/host/gitService.ts
@@ -1,7 +1,7 @@
 // Electron-free: shared by the Electron main process and the remote daemon.
 import { execFile } from 'node:child_process'
 import { createHash } from 'node:crypto'
-import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises'
+import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, utimes } from 'node:fs/promises'
 import { tmpdir } from 'node:os'
 import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
 import { promisify } from 'node:util'
@@ -412,6 +412,11 @@ export async function exportDirtyPatch(
   try {
     try {
       await copyFile(gitIndex, index)
+      // The copy keeps the index's own times: git tells a "racily clean" entry (a file changed in
+      // the same second it was staged or checked out, same size) by comparing it with the index
+      // file's mtime. A fresh mtime would make git trust the stat and miss that change.
+      const times = await stat(gitIndex)
+      await utimes(index, times.atime, times.mtime)
     } catch (err) {
       // No index yet (nothing ever staged) is fine; anything else would build a wrong patch.
       if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
```

</details>



### Task 5: smoke:server-promote

**Files:**
- Modify: `package.json`
- Create: `scripts/server-promote-smoke.mjs`
- Modify: `scripts/local-features-smoke.mjs`
- Modify: `scripts/local-window-smoke.mjs`

- [ ] **Step 1:** Apply the diff below (prototype commits b1c239f, 18ad111).
- [ ] **Step 2:** Run the checks: `npm run smoke:server-promote` (30 checks), then `npm run smoke:local-window` and `npm run smoke:local-features` (the follow-up: their menus and features now have Promote).
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff b1c239f</summary>

```diff
diff --git a/package.json b/package.json
index 242fea0..2d739a5 100644
--- a/package.json
+++ b/package.json
@@ -28,6 +28,7 @@
     "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
     "smoke:server-review": "npm run build && node scripts/server-review-smoke.mjs",
     "smoke:server-move": "npm run build && node scripts/server-move-smoke.mjs",
+    "smoke:server-promote": "npm run build && node scripts/server-promote-smoke.mjs",
     "smoke:server-web": "npm run build && node scripts/server-web-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
diff --git a/scripts/server-promote-smoke.mjs b/scripts/server-promote-smoke.mjs
new file mode 100644
index 0000000..87e635b
--- /dev/null
+++ b/scripts/server-promote-smoke.mjs
@@ -0,0 +1,298 @@
+// scripts/server-promote-smoke.mjs — Promote to primary and Promote branch to worktree (phase 5e) on
+// a remote server, from its window, and an agent's promote_to_primary confirmed in that window.
+//
+// Run: npm run smoke:server-promote   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) runs with its own HOME and the not-signed-in stub gh every
+// smoke gets (smokeGh.mjs); its agent is a fake one that lingers. The built app runs with a temp HOME
+// and --user-data-dir, no Local server, and main's dialogs stubbed (each confirm answered as the
+// smoke says). A worktree feature-x has a commit, uncommitted work and a running Claude session with
+// a saved history. Through the DOM, the SDK, git and the MCP endpoint it checks:
+//   - the welcome lists promote, and the window's feature follows it;
+//   - Promote to primary… asks first (what moves), then the main checkout is on feature-x with the
+//     work unstaged, the worktree's folder and row are gone, the session moved to the main checkout,
+//     resumed there, its history in the main checkout's Claude folder; the window shows one row;
+//   - Promote branch to worktree… on the main checkout puts feature-x and its work back in a worktree
+//     at the default path, the main checkout on main and clean, the session moved and running there;
+//   - an agent's promote_to_primary shows the confirmation in the window (saying who asked); confirmed,
+//     the window promotes and the tool returns the main checkout; declined, the tool says so and
+//     nothing changes;
+//   - the renderer never holds the server token; no error dialogs, console or page errors.
+//
+// Prints SERVER PROMOTE SMOKE PASS (n checks) or SERVER PROMOTE SMOKE FAIL and exits 0 or 1.
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
+const token = randomBytes(16).toString('base64url')
+const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-promote-smoke-')))
+const serverHome = join(work, 'server-home')
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
+
+const repo = join(serverHome, 'repos', 'app')
+const worktree = `${repo}-feature-x`
+const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8' })
+git('init', '-q', '-b', 'main', repo)
+writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
+git('-C', repo, 'add', '.')
+git('-C', repo, 'commit', '-q', '-m', 'init')
+const status = (cwd) => git('-C', cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()
+const branchOf = (cwd) => git('-C', cwd, 'symbolic-ref', '--short', 'HEAD').trim()
+/** The server's Claude folder for a working directory (claudeSessionService's projectDir, under its HOME) */
+const claudeDir = (cwd) => join(serverHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
+
+const fakeAgent = join(work, 'fake-agent.sh')
+const agentPids = join(work, 'agent-pids')
+writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
+const configPath = join(work, 'config.json')
+writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))
+
+// Each confirm is answered with globalThis.__answer (1: the confirm button; 0: Cancel).
+const mainStub = join(work, 'main-stub.cjs')
+writeFileSync(
+  mainStub,
+  `const { dialog } = require('electron')
+globalThis.__dialogs = []
+globalThis.__answer = 1
+dialog.showMessageBox = async (...args) => {
+  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
+  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null })
+  return { response: o.type === 'error' ? 0 : globalThis.__answer, checkboxChecked: false }
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
+let daemon = null
+let app = null
+let sdk = null
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
+  sdk?.close()
+  await closeApp(app)
+  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
+    daemon.kill()
+    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
+  }
+  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
+  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
+  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(exitCode === 0 ? `SERVER PROMOTE SMOKE PASS (${checks.length} checks)` : `SERVER PROMOTE SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+try {
+  // ---- 1. The server and a project with a worktree: a commit, uncommitted work, a running session ---
+
+  const port = await freePort()
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
+      cwd: join(root, 'server'),
+      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' },
+      stdio: ['ignore', 'pipe', 'pipe']
+    })
+    daemon = d
+    let output = ''
+    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
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
+    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
+  })
+  const url = `ws://127.0.0.1:${port}`
+  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-promote-smoke' })
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  check('the welcome lists promote', sdk.welcome?.capabilities.includes('promote'), true)
+  const { projectId } = await sdk.request('project.create', { name: 'promote', repositories: [{ path: repo }] })
+  const topic = `project:${projectId}`
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const repoId = (await project()).repositories[0].id
+  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
+  writeFileSync(join(worktree, 'b.txt'), 'b\n')
+  git('-C', worktree, 'add', '.')
+  git('-C', worktree, 'commit', '-q', '-m', 'add b')
+  writeFileSync(join(worktree, 'a.txt'), 'one\nTWO\nthree\n')
+  writeFileSync(join(worktree, 'c.txt'), 'c\n')
+  const rowsNow = async () => (await project()).repositories[0].worktrees
+  const featureId = (await rowsNow()).find((w) => w.path === worktree).id
+  const mainId = (await rowsNow()).find((w) => w.isMain).id
+  const { sessionId } = await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Agent', cols: 120, rows: 30 })
+  const historyName = `${sessionId}.jsonl`
+  mkdirSync(claudeDir(worktree), { recursive: true })
+  writeFileSync(join(claudeDir(worktree), historyName), '{"type":"user"}\n')
+
+  // ---- 2. The app, with the server saved, and the project's window ---------------------------------
+
+  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
+  delete env.ELECTRON_RUN_AS_NODE
+  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
+  app.on('window', watch)
+  const win = await app.firstWindow()
+  watch(win)
+  await win.waitForLoadState('domcontentloaded')
+  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
+  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
+  await win.evaluate(async ([id, pid]) => {
+    const { opened } = await window.api.openServerProject(id, pid, 'promote', 'Remote')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entry.id, projectId])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 2)
+  check("the window's promote feature follows the server's capability", await until(() => win.evaluate(() => window.__features().promote), true), true)
+
+  const detail = win.locator('.server-window .detail')
+  const menuItem = async (rowText, path, label) => {
+    await rows.filter({ hasText: rowText }).first().click()
+    await detail.locator('.detail-path', { hasText: path }).waitFor({ timeout: 10_000 })
+    await detail.locator('.btn-icon[title="Worktree actions"]').click()
+    const item = detail.locator('.detail-menu-item', { hasText: label })
+    await item.waitFor({ timeout: 10_000 })
+    return item
+  }
+  const dialogs = () => app.evaluate(() => globalThis.__dialogs)
+  const confirmOf = async (message) => (await dialogs()).filter((d) => d.message === message)
+
+  // ---- 3. Promote to primary -----------------------------------------------------------------------
+
+  await (await menuItem('feature-x', worktree, 'Promote to primary…')).click()
+  check('the main checkout switches to feature-x', await until(() => { try { return branchOf(repo) } catch { return null } }, 'feature-x'), 'feature-x')
+  const asked = await until(async () => (await confirmOf('Promote “feature-x” to the primary checkout?')).length, 1)
+  check('Promote asked first', asked, 1)
+  const promptText = (await confirmOf('Promote “feature-x” to the primary checkout?'))[0]?.detail ?? ''
+  check('the confirmation says the work and the session move', [/uncommitted changes move with it/.test(promptText), /1 session \(Agent\) move to the main checkout and resume/.test(promptText)], [true, true])
+  check('the worktree folder is gone', await until(() => existsSync(worktree), false), false)
+  check("the main checkout has the worktree's work, unstaged", status(repo), [' M a.txt', '?? c.txt'])
+  check("and the branch's commit", existsSync(join(repo, 'b.txt')), true)
+  const afterPromote = await until(async () => (await rowsNow()).map((w) => w.id), [mainId])
+  check('the project lists only the main checkout', afterPromote, [mainId])
+  const mainRow = (await rowsNow())[0]
+  check('the session moved to the main checkout, resumed there', [mainRow.sessions.map((s) => s.id), mainRow.loaded, !!mainRow.sessions[0]?.ptyId], [[sessionId], true, true])
+  check("its history moved to the main checkout's Claude folder", [existsSync(join(claudeDir(repo), historyName)), existsSync(join(claudeDir(worktree), historyName))], [true, false])
+  check('the window shows one row, on feature-x', await until(async () => [await rows.count(), (await rows.first().textContent())?.includes('feature-x')], [1, true]), [1, true])
+
+  // ---- 4. Promote branch to worktree ---------------------------------------------------------------
+
+  await (await menuItem('feature-x', repo, 'Promote branch to worktree…')).click()
+  check('feature-x is back in a worktree at the default path', await until(() => existsSync(worktree) && branchOf(worktree), 'feature-x'), 'feature-x')
+  check('the main checkout is back on main', await until(() => branchOf(repo), 'main'), 'main')
+  check('and clean', await until(() => status(repo), []), [])
+  check('the work is in the worktree, unstaged', status(worktree), [' M a.txt', '?? c.txt'])
+  const backRows = await until(async () => (await rowsNow()).length, 2)
+  check('the project lists the main checkout and the worktree', backRows, 2)
+  const backRow = (await rowsNow()).find((w) => !w.isMain)
+  check('the session moved to the new worktree, running there', [backRow?.sessions.map((s) => s.id), backRow?.loaded, !!backRow?.sessions[0]?.ptyId], [[sessionId], true, true])
+  check("its history in the worktree's Claude folder", existsSync(join(claudeDir(worktree), historyName)), true)
+  check('the window shows both rows again', await until(() => rows.count(), 2), 2)
+
+  // ---- 5. An agent's promote_to_primary, confirmed in the window, then declined --------------------
+
+  const mcpFile = join(data, 'mcp', `${projectId}.json`)
+  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const rpc = async (method, params) => {
+    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
+    return res.json()
+  }
+  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
+  const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? []
+  check('the agent’s tools list promote_to_primary', listed.includes('promote_to_primary'), true)
+  const before = (await confirmOf('Promote “feature-x” to the primary checkout?')).length
+  const called = await rpc('tools/call', { name: 'promote_to_primary', arguments: { worktree: 'feature-x', terminalId: sessionId } })
+  const result = JSON.parse(called.result?.content?.[0]?.text ?? '{}')
+  check('confirmed in the window, the tool returns the main checkout', [called.result?.isError === true, result.promoted, result.primary?.primary, result.primary?.branch], [false, true, true, 'feature-x'])
+  const mcpPrompt = (await confirmOf('Promote “feature-x” to the primary checkout?')).slice(before)
+  check('the window asked, saying which session asked', [mcpPrompt.length, /^“Agent” asked for this/.test(mcpPrompt[0]?.detail ?? '')], [1, true])
+  check('the main checkout is on feature-x again, the worktree gone', [branchOf(repo), existsSync(worktree)], ['feature-x', false])
+
+  await sdk.request('worktree.demote', { projectId, repoId })
+  await until(() => rows.count(), 2)
+  await app.evaluate(() => { globalThis.__answer = 0 })
+  const declined = await rpc('tools/call', { name: 'promote_to_primary', arguments: { worktree: 'feature-x' } })
+  check('declined in the window, the tool says so', [declined.result?.isError, /declined/.test(declined.result?.content?.[0]?.text ?? '')], [true, true])
+  check('and nothing changed', [branchOf(repo), existsSync(worktree), status(worktree)], ['main', true, [' M a.txt', '?? c.txt']])
+
+  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
+  check("the renderer's store and page never hold the server token", held.includes(token), false)
+  check('no error dialogs', (await dialogs()).filter((d) => d.type === 'error'), [])
+  check('no console or page errors', pageErrors, [])
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
```

</details>


<details><summary>Diff 18ad111</summary>

```diff
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index bedc86e..536d278 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -363,10 +363,10 @@ try {
   }, projectId)
   const rows = win.locator('.server-window .wt-row')
   await until(() => rows.count(), 2)
-  check("the window's features: the machine-local ones, the server's Linear, voice and skills, and Move (5d)", await until(() => win.evaluate(() => {
+  check("the window's features: the machine-local ones, the server's Linear, voice and skills, Move (5d) and Promote (5e)", await until(() => win.evaluate(() => {
     const f = window.__features()
     return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear, f.bot, f.voice, f.promote, f.moveWorktree]
-  }), [true, true, true, true, true, true, true, false, true, false, true]), [true, true, true, true, true, true, true, false, true, false, true])
+  }), [true, true, true, true, true, true, true, false, true, true, true]), [true, true, true, true, true, true, true, false, true, true, true])
   check('its sidebar says Busy (the handed-over key, this app\'s setting)', await until(() => win.locator('.voice-toggle').textContent().catch(() => null), 'Busy'), 'Busy')
   const detail = win.locator('.server-window .detail')
   const mainRow = rows.filter({ hasNotText: 'feature-x' })
diff --git a/scripts/local-window-smoke.mjs b/scripts/local-window-smoke.mjs
index df1d498..d03b266 100644
--- a/scripts/local-window-smoke.mjs
+++ b/scripts/local-window-smoke.mjs
@@ -19,8 +19,8 @@
 //   - Notes and All Notes: a note saved on the server; a note on a branch with no worktree is
 //     listed as gone, and its two-step delete clears it on the server;
 //   - Settings: Audio alerts and the session mode, saved on the server;
-//   - the overflow menus: the primary's (Open in VS Code and Reveal; no Promote, Move or Delete)
-//     and a worktree's (Delete; no Promote or Move);
+//   - the overflow menus: the primary's (Open in VS Code, Reveal and Promote branch to worktree; no
+//     Move or Delete) and a worktree's (Delete and Promote to primary; no Move);
 //   - ⏏ unloads the worktree on the server (no tab, a dormant dot, ▸1, "1 saved session") and ▸1
 //     loads it again;
 //   - the Changes tab: Changes when clean; branch commits, edits and untracked files totalled
@@ -369,11 +369,11 @@ try {
     return items.map((t) => t.replace(/\s+/g, ' ').trim())
   }
   const primaryItems = await menuItems()
-  check("the primary's menu: Open in VS Code and Reveal, no Promote, Move or Delete", [primaryItems.includes('Open in VS Code'), primaryItems.includes('Reveal in Finder'), primaryItems.some((t) => /promote|move|delete/i.test(t))], [true, true, false])
+  check("the primary's menu: Open in VS Code, Reveal and Promote branch to worktree (5e), no Move or Delete", [primaryItems.includes('Open in VS Code'), primaryItems.includes('Reveal in Finder'), primaryItems.some((t) => t.startsWith('Promote branch to worktree…')), primaryItems.some((t) => t.startsWith('Move to another server') || t.startsWith('Delete worktree'))], [true, true, true, false])
   await apiFeatureRow.click()
   await detail.locator('.detail-title', { hasText: 'feature-auth' }).waitFor({ timeout: 5000 })
   const featureItems = await menuItems()
-  check("a worktree's menu: Delete, and no Promote or Move", [featureItems.some((t) => t.startsWith('Delete worktree')), featureItems.some((t) => /promote|move/i.test(t))], [true, false])
+  check("a worktree's menu: Delete and Promote to primary (5e), no Move", [featureItems.some((t) => t.startsWith('Delete worktree')), featureItems.some((t) => t.startsWith('Promote to primary…')), featureItems.some((t) => t.startsWith('Move to another server'))], [true, true, false])
 
   // ---- 8. The Changes tab -----------------------------------------------------------------------------
 
```

</details>



### Task 6: Docs

**Files:**
- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-04-central-server-design.md`
- Modify: `server/README.md`

- [ ] **Step 1:** Apply the diff below (prototype commit 8186ec2).
- [ ] **Step 2:** Run the checks: Read PROTOCOL.md's "Promote to primary" against Tasks 1–2, and the READMEs' feature and smoke lines.
- [ ] **Step 3:** Commit the task's files (`git add` new files first).


<details><summary>Diff 8186ec2</summary>

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 6c9e5e3..44a9d7e 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -107,6 +107,7 @@ new optional field needs no capability: its absence says enough.
 | `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked (`gh auth status --hostname github.com`) when the server starts, every 10 minutes after that whether it is listed or not, and when a poll fails with what looks like a sign-in error (HTTP 401, not logged in); a poll failing any other way (the network, GitHub, one unreadable PR) leaves it as it is. The Local server announces itself only once the first check has answered (at most 3 s), so the app's first welcome has it; a remote server takes connections at once, so a welcome sent before gh answered lacks it and the change is pushed. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
 | `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
 | `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export`, `move.history` and `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort`, `move.receive` and `move.unreceive` on the target |
+| `promote` | Promote to primary and its reverse (see [Promote to primary](#promote-to-primary)): `worktree.promote` and `worktree.demote`, each with `dryRun`, and the MCP tool `promote_to_primary`'s confirmation: `promote.request` to the project's subscribers, `promote.answer` from one of them, then `promote.settled` |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -780,6 +781,61 @@ two are deleted with the source; `move.prepare` lists them so the client can war
 tears it down (step 7) when the user leaves "Tear down its VM and stack" ticked, and refuses to
 move while one runs when they untick it (a stopped one then stays behind).
 
+## Promote to primary
+
+With the capability `promote` (phase 5e) a client can check a worktree's branch out in its
+repository's main checkout (**promote**), or move the main checkout's branch into a worktree of its
+own (**demote**, "Promote branch to worktree" in the app). Each is one request on one server, which
+does all of it or puts everything back; `dryRun: true` answers the plan the confirmation shows,
+after the same checks, and changes nothing.
+
+| Method | Params | Result |
+|---|---|---|
+| `worktree.promote` | `{projectId, worktreeId, dryRun?}` | With `dryRun`, the plan: `{branch, mainPath, worktreePath, mainBranch, dirty, loaded, otherLoaded, sessions, reviewComments, reviewCarried, ignored, ignoredCount, hiddenChanges, hiddenChangesCount}` (`mainBranch`: what the main checkout is on now, `null` when detached; `sessions`: each `{title, provider, carried, reason?}`; `ignored` and `hiddenChanges` as `move.prepare`'s: they are deleted with the worktree). Else `{worktreeId, moved, notes}`: the main checkout's worktree id, the ids of the sessions that moved, and one line per thing that did not come along. `BAD_REQUEST` for a main checkout, a detached HEAD, an untracked nested git repository, or uncommitted work over 64 MiB or not UTF-8; `CONFLICT` when the main checkout has uncommitted changes, or while another promote or demote changes the repository |
+| `worktree.demote` | `{projectId, repoId, dryRun?}` | The same plan (`worktreePath`: the new worktree, `<repo>-<branch>`; `mainBranch`: the default branch the main checkout goes back to; no `ignored` or `hiddenChanges`: the main checkout keeps them), else `{worktreeId, moved, notes}` with the new worktree's id. `BAD_REQUEST` when the main checkout is on the default branch, on a detached HEAD, or the default branch can't be told (`origin/HEAD`, else `master`/`main`); `CONFLICT` when the default branch is checked out in another worktree, the path exists, or another promote or demote runs |
+| `promote.answer` | `{projectId, requestId, outcome, worktreeId?, error?}` | `{accepted}`: a window's answer to a `promote.request` (`outcome` `declined`, `promoted` with the main checkout's `worktreeId`, or `failed` with an `error` of at most 2000 characters); `false` when the request is unknown or another window answered first |
+
+`worktree.promote`, in order, with the worktree's and the main checkout's paths blocked for
+`session.start` and `worktree.load` throughout: the worktree's sessions stop if it is loaded; its
+uncommitted work is packed as `move.export`'s patch is (the same config-proof plumbing, its
+linked symlinks left out); the main checkout switches to the branch (`git switch
+--ignore-other-worktrees`: the worktree still has it); the patch is applied there (all unstaged);
+the main checkout's own patch, built the same way, must match it (by `patchDigest`), else
+`GIT_ERROR`; then the worktree is removed (`git worktree remove --force`), the point of
+commitment. A failure before that switches the main checkout back (discarding what the switch
+wrote: it was clean), takes the applied work off again (`git apply -R`), loads the worktree again
+if it was loaded, and answers the error; the worktree is as it was. After it: the sessions whose
+agent can follow a folder change (Claude and Local: their history moves, `rename`, from
+`~/.claude/projects/<the worktree's path>` to the main checkout's) move to the main checkout's row
+with their queues, types and prompts; others are closed and named in `notes`. They resume there
+when either checkout was loaded (the main checkout is loaded if it was not, which resumes its own
+saved sessions too); the main checkout's own sessions keep running, now on the branch. The review
+draft moves when the main checkout has none (else it is dropped, in `notes`); the branch data and
+the PR watch are the branch's, so they stay; a PR notice moves to the main checkout.
+
+`worktree.demote`, in order, with both paths blocked: the main checkout's sessions that can follow
+stop (the others keep running); a worktree is added for the branch at `<repo>-<branch>` (`git
+worktree add --force`: the main checkout still has it) and the repository's `linkedDirs` are
+linked into it; the main checkout's uncommitted work is packed (leaving out what the new worktree
+links: that is shared, and stays), applied in the new worktree and checked by digest; it is taken
+off the main checkout (`git apply -R`, then its index reset with `git reset -- .`, a copy of it
+kept); and the main checkout switches to the default branch, the point of commitment. A failure
+before that puts the main checkout back (its branch, its index, its work), removes the new
+worktree and resumes the stopped sessions. After it: the sessions that can follow move to the new
+worktree's row (resumed if the main checkout was loaded), the review draft and a PR notice move
+too, and the branch gets the first workflow tag if it has none, as `worktree.create` does.
+
+**promote_to_primary.** The trek-dev tool asks the project's windows: the server sends
+`promote.request` `{projectId, requestId, worktreeId, branch, from?}` (`from`: the title of the
+session that asked) to every connection subscribed to the project's topic. A window shows the
+same confirmation its menu item does and, once the user answers, runs the promote itself
+(`worktree.promote`), then answers `promote.answer` with what came of it. The first answer
+settles the request, and every subscriber hears `promote.settled` `{projectId, requestId}`: a
+window whose dialog is still open does nothing with its user's answer (the Trek app says another
+window answered). The tool fails when nobody has the project open (at the call, or later: the
+server checks every 5 s), when nobody answers within 15 minutes, when the user declines, or when
+the promote fails; it returns `{promoted: true, primary}`, `primary` a `list_worktrees` entry.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
@@ -1157,8 +1213,9 @@ or `null`, and `watchingPullRequest` says the server watches the branch's pull r
 | `start_stack` | `worktree`; `starter?` (boolean) | the stack as `get_stack` describes it, once `stack.sh up` is started; `BAD_REQUEST` when it is not stopped |
 | `stop_stack` | `worktree` | the stack once `stack.sh down` exited 0; else `BAD_REQUEST` naming the code |
 | `read_stack_log` | `worktree`; `lines?` (default 100, 1 to 2000) | `{output}`: the last lines of the stack's log's last 64 KiB (a line cut at its start left out), colour codes removed |
+| `promote_to_primary` | `worktree`; `terminalId?` (named in the dialog) | `{promoted: true, primary}` once a window confirmed and promoted (see [Promote to primary](#promote-to-primary)); `BAD_REQUEST` when the user declines, nobody answers in 15 minutes, or no window has the project open; `GIT_ERROR` when the promote failed |
 
-That is 29 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
+That is 30 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
 `stack.log` (their path checks), on the server's machine; a worktree without
 `docker/stack/stack.sh` has no stack (`get_stack` says so, the others are `BAD_REQUEST`). Tags are matched by name or id, case-insensitively, and an
 unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
@@ -1173,7 +1230,7 @@ and needs a `name` to create. A name already used by another type is `BAD_REQUES
 listed, and calling one is `-32602`.
 
 - Client UI only: `get_selected_worktree` and `focus_session` (selection lives in
-  clients), and `promote_to_primary` (it needs a confirmation dialog).
+  clients). `promote_to_primary` came back in 5e: a window confirms it.
 
 **Readiness and waiting.**
 
@@ -1222,6 +1279,8 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 | `docker.log` | `{data, done?}`: a `docker.compose` run's output, only to the connection that asked for it (chunks may be dropped under backpressure, see [Docker, environments and stacks](#docker-environments-and-stacks)); `done` on its last |
 | `env.log` | `{profile, data, done?, step?}`: an `env.up`, `env.stop` or `env.destroy`'s output, only to the connection that asked for it; `step` (`vm`, `compose`, `ready`) marks an `env.up` phase, `done` its last |
 | `voice.summary` | `{projectId, sessionId, text, audio}`: a session's spoken summary (`speak_summary`), an mp3 in base64, to every connection subscribed to the project's topic (not one more than 4 MiB behind) |
+| `promote.request` | `{projectId, requestId, worktreeId, branch, from?}`: the MCP tool `promote_to_primary` asks the project's subscribers to confirm a promote; one answers with `promote.answer` (see [Promote to primary](#promote-to-primary)) |
+| `promote.settled` | `{projectId, requestId}`: that request was answered or ended; close its dialog |
 | `integrations.changed` | `{linear?: true, voice?: true, prWatch?: boolean}`: the server's Linear or ElevenLabs key, or its voice settings, changed (by any client), to every authenticated connection; re-read `linear.status` / `voice.settings` (see [Linear, voice and skills](#linear-voice-and-skills)). `prWatch` is gh's new sign-in state on the server's machine: the `prWatch` capability is now listed or not (see [Pull request watch](#pull-request-watch)); the client SDK updates `welcome.capabilities` before its listeners hear the event |
 
 ## Several clients
diff --git a/README.md b/README.md
index 11c1f49..90386b1 100644
--- a/README.md
+++ b/README.md
@@ -244,7 +244,22 @@ other window on that project sees them live.
 - **This machine's features, in Local windows only**: a window on the [Local
   server](#local-server) also has Open in VS Code and Reveal in Finder, since its
   paths are this machine's. A window on a remote server shows neither.
-- **Not yet**: promote to primary and the project bot (phase 5).
+- **Promote to primary**: **Promote to primary…** in a worktree's menu checks its
+  branch out in the repository's main checkout (which must have no uncommitted
+  changes), with the worktree's uncommitted work (unstaged), then deletes the
+  worktree. Its Claude and local-model sessions move to the main checkout with their
+  histories and resume there; other agents' sessions are closed; the main checkout's
+  own sessions keep running on the new branch. The note, tags, ticket, pull request
+  and its watch are the branch's, so they stay with it; the review draft moves if the
+  main checkout has none. Its dev stack and VM go as with Delete (the same checkbox).
+  **Promote branch to worktree…** on the main checkout does the reverse: its branch
+  and uncommitted work go to a new worktree at `<repo>-<branch>`, the sessions that
+  can follow go with them, and the main checkout returns to the default branch. Each
+  is one request on the server: any failure puts both checkouts back as they were.
+  An agent can ask for a promote with the `promote_to_primary` MCP tool; every window
+  with the project open (the web client's too) shows the confirmation, and the tool
+  waits for the answer.
+- **Not yet**: the project bot (after the native client).
 
 ## Importing a .trekproj
 
@@ -449,6 +464,9 @@ one at a time:
   with a bare repository in a temp dir as both clones' origin: the dialog, the steps,
   the target's worktree, work and Claude session, the source's removal, its VM and
   stack torn down (stub colima and docker), and a move rolled back with `move.unreceive`;
+- `npm run smoke:server-promote`: Promote to primary and Promote branch to worktree from
+  a remote server's window (the work, the session and its history moved, the folders
+  and rows), and an agent's `promote_to_primary` confirmed, then declined, in the window;
 - `npm run smoke:server-web`: the web client: `trek-server start --web` driven from a
   bare browser window (no Trek main or preload): sign-in, the cookie, a project and its
   session's terminal, the Origin rule on sockets, sign-out, revocation and the
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 2459475..024f72b 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -486,8 +486,16 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
      Docker `.env` goes with the note, and a target without `env` lists it as not carried.
      Plan:
      `docs/superpowers/plans/2026-11-10-central-server-phase5d-move-worktrees.md`.
-   - **Later, in their own plans:** the bot (ported last, only when asked), promote to
-     primary, and Windows support for the supervisor.
+   - **5e: promote to primary**, and its reverse "Promote branch to worktree", behind a `promote`
+     capability: each one request on the server (`worktree.promote`, `worktree.demote`). User
+     decisions (2026-11-10): both actions come back; the promoted worktree's uncommitted work is
+     carried (5d's config-proof patch, checked by digest; the main checkout must be clean), and any
+     failure puts everything back; the main checkout's own sessions keep running on the new branch;
+     the trek-dev tool `promote_to_primary` returns, confirmed in a window that has the project
+     open (refused when none has). Plan:
+     `docs/superpowers/plans/2026-11-10-central-server-phase5e-promote.md`.
+   - **After phase 6** (user decision, 2026-11-10): Windows support for the supervisor, and the
+     bot (ported last, in its own plan, only when asked).
 6. **Next phase:** React Native client on `packages/client` and `src/shared/model`.
 
 Remote projects can be opened after phase 3. After phase 4 every project is on a server and
diff --git a/server/README.md b/server/README.md
index aaba742..3a35f88 100644
--- a/server/README.md
+++ b/server/README.md
@@ -217,6 +217,19 @@ is removed last. Both clones need an `origin` that names the same repository,
 and the source's server user must be able to push to it. See PROTOCOL.md, "Moving a worktree
 between servers".
 
+## Promote to primary
+
+With the `promote` capability, the app's **Promote to primary…** runs `worktree.promote` on the
+server, in one request: the main checkout (which must be clean) switches to the worktree's branch
+while the worktree still has it, the worktree's uncommitted work is applied there and checked
+against the worktree's own, and only then is the worktree removed. Claude and local-model sessions
+move to the main checkout, their histories renamed into its `~/.claude/projects` folder (the
+server user's), and resume there; others are closed. **Promote branch to worktree…**
+(`worktree.demote`) does the reverse, back to the default branch. A failure before the worktree is
+removed (or, for the reverse, before the main checkout leaves the branch) puts everything back.
+The `promote_to_primary` MCP tool asks the project's windows to confirm (`promote.request`) and
+waits up to 15 minutes for one to answer. See PROTOCOL.md, "Promote to primary".
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config, read at start) also serves
```

</details>



### Task 7: Verification

- [ ] `npm run typecheck`, `cd server && npm run typecheck`, `npm test`, `npm run build`.
- [ ] Every smoke, one at a time (each with its own temp `--user-data-dir` and HOME): `smoke:server-promote`, `smoke:server-move`, `smoke:server-web`, `smoke:server-review`, `smoke:server-prwatch`, `smoke:v2`, `smoke:local-app`, `smoke:local-window`, `smoke:local-features`, `smoke:server-env`, `smoke:server-integrations`, `smoke:providers`, `smoke:windows`, `smoke:import`, `smoke:local`, `smoke:client`, and `cd server && npm run smoke`.
- [ ] A clean clone: `npm ci` (and in `server/`), typecheck, test, build.
- [ ] No leftover trek-server, fake agent or Electron processes.
