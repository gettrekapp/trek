# Central server phase 5c-1: the pull request watch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server watches a branch's linked GitHub pull request with `gh` on its own machine. When the PR's checks fail or pass, new reviews or comments arrive, it gets a merge conflict, or it is merged or closed, the server queues a prompt saying so on the worktree's newest agent session and raises attention (the spec's 5c "PR watch"). The parts:
1. **The protocol.** A `prWatch` capability, listed only while gh is installed and signed in on the server's machine. The methods `branch.setPrWatch` and `prWatch.dismiss`. The branch's saved watch (`branchData.prWatch`) and the worktree's runtime notice (`Worktree.prNotice`). The `attention` topic gains a worktree entry for a notice.
2. **The server.** `server/src/prWatch/` holds three files:
   - `gh.ts` runs gh;
   - `watcher.ts` is the `PrWatcher`, which polls every 3 minutes, queues the prompt and sets the notice;
   - `prWatchHandlers.ts` holds the methods.

   The rules are pure, in `src/shared/prWatch.ts`: they read gh's answer, compare a poll with the last one, and write the prompt and the notice.
3. **The MCP tool.** `watch_pull_request`, and `watchingPullRequest` in `list_worktrees`.
4. **The app.** The open window follows a change in gh's sign-in (`integrations.changed {prWatch}`, applied by the SDK).
   - Main's attention aggregator lists a notice, keyed by its worktree, and raises a "PR #12 changed" notification.
   - The notifications menu says what changed, and dismissing an entry calls `prWatch.dismiss`.
   - The detail pane's … menu has **Watch pull request**, gated on `features.prWatch`.
   - The PR chip says "· watching", a notice chip has a × to dismiss it, and the sidebar row is flagged.
5. **No real gh in any smoke.** `TREK_SERVER_GH` points the server at a gh binary. Every smoke imports `scripts/smokeGh.mjs`, which sets that variable to a stub that is never signed in, and main's `childEnv` keeps it for the Local server. `smoke:server-prwatch` (new) gives its own server a scripted stub.

**Architecture:**
- **One watch per branch.** It sits next to the PR link (`branchData.pr`), so it follows the branch through worktree re-creation, as the link does. It is saved with the project: `{}` until the first poll, then `{seen}`. A watch is polled only while a worktree has the branch checked out.
- **The notice is the worktree's** and runtime only, like a session's status: `resetRuntime` drops it on load. `attentionEntries` lists it with `sessionId: ''`, `title: 'PR #12'`, `status: 'attention'`, `since: at` and `pullRequest: {text, url}`. A client older than 5c-1 still lists it as needing attention.
- **gh is the server's.** The server holds no GitHub token: gh signs in as the server's user. The welcome's `prWatch` is `PrWatcher.available()`. `trek.ready` waits up to 3 s for the first `gh auth status`, so the Local server's first welcome lists it.
- **The prompt goes through the existing queue** (`SessionManager.enqueue`), so it is click-to-send, as every queued prompt is (2d-2's decision). Nothing starts a session.

**Tech Stack:** as 5b: TypeScript, React 19 + zustand, Electron 43, the `src/shared/client` SDK, `node --test`, Playwright's `_electron`; `execFile` on the server.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, "6. Phases", 5c's "PR watch" (Task 6 adds the user's decisions there). Builds on 5b's plan, `docs/superpowers/plans/2026-11-09-central-server-phase5b-integrations.md`: its capability gate (`CAPABILITY_FOR`), its `childEnv` `KEPT` list, `TOOL_ERROR`, and its smoke layout (`smoke:server-integrations`). The attention aggregator is 3d's (`src/main/attention.ts`).

**Prototype:** every task was built and verified first, on `central-server-phase5c1-proto` (6 commits on master `300eb5e`). Each task's diff below is that prototype's commit: the implementer applies it, then the reviews look at it fresh.

---

## Roadmap

5c is three plans, built in the order the user chose on 2026-11-10:

| Plan | Contents |
|---|---|
| **5c-1** | this plan: the PR watch |
| **5c-2** | the Changes tab review: a source picker, line comments, and "Send to session" |
| **5c-3** | the web client |

The bot, moving worktrees between servers, promote, and the supervisor on Windows come later, each in its own plan.

---

## Decisions

### Recorded (user decisions, 2026-11-10)

1. **The prompt goes to the worktree's most recent open agent session.** That is the last of `Worktree.sessions`, which are kept in the order they were started, whatever its status. Every v2 session runs an agent, so "never a terminal-only session" holds by construction.
2. **No open agent session: attention only.** The worktree is flagged and the notifications menu says what changed. Nothing is queued and nothing is started.
3. **A watch stops by itself after reporting merged or closed.** It survives server restarts until then, because it is saved with the project.
4. **PR prompts are queued, not sent.** They wait in the click-to-send queue like every queued prompt (2d-2), so nothing is sent unattended.
5. **Bots' reviews and comments count.** Any author but the PR's own triggers a report.
6. **A change in gh's sign-in is pushed to open windows.** It reuses 5b's `integrations.changed`, which already goes to every authenticated connection whatever it subscribes to, now with `{prWatch: true|false}`.
   - The client SDK (`ServerConnection`) applies it to `welcome.capabilities`, as a new array, before its event listeners run.
   - The server window (`ServerProjectWindow`) calls `backendChanged()` on it, so `features.prWatch`, and with it the menu item, follow without a reconnect.
   - The `server` topic was not used: windows on a `topicEnd` server never subscribe to it, and a capability is not project state.
7. **Notices are runtime only** (Decision 12): lost on a server restart, as a session's status is.

### Decided in this plan

8. **The watch is stored per branch**, as `branchData.prWatch` beside `branchData.pr`. The UI and the MCP tool address a worktree, which means its branch; a detached worktree has none. `branch.setPr` with a different URL, or none, removes the watch, because the watch was for the old PR.
9. **Only a canonical `https://github.com/<owner>/<repo>/pull/<n>` URL is watched** (`watchableUrl`).
   - `set_worktree_pull_request` stores that form. An older client's `branch.setPr` may store any string, and such a string is never handed to gh.
   - GitHub Enterprise hosts are not watched, and sign-in is checked for `github.com` only.
10. **What counts as a change** (`watchStep`):
   - **The first poll is the baseline** and reports nothing, unless the PR is already merged or closed. Turning a watch on never replays what was already there.
   - **Checks** are reported once per head commit. A failure is reported as soon as one check has failed, with the failed checks' names, even while others still run. A pass is reported once all checks have settled. Pending and no checks at all are never reported. A new push that fails the same way again is a new report.
     - *Review fix:* a finished CheckRun whose conclusion is not a failure is settled: `SUCCESS`, `NEUTRAL`, `SKIPPED`, `STALE`, and any conclusion GitHub adds later, so an unfamiliar word never holds "passed" back forever. A StatusContext settles only at `SUCCESS` (`PENDING` and `EXPECTED` wait).
   - **Reviews and comments** are counted when they are newer than the newest one seen, by anyone but the PR's author and gh's signed-in user (the agent's own replies). That includes bots (Decision 5). A deleted comment never moves the mark back.
     - *Review fix:* GitHub's times are to the second, so `seen.commentsAtCount` also keeps how many were at `commentsAt`; one more in that same second is counted. A watch saved before the field counts whatever is at that time as seen.
     - *Review fix:* the signed-in user is the query's `viewer { login }`, read with every poll, so it follows a re-login without a separate call.
   - **A conflict** is reported when GitHub starts saying `CONFLICTING`. `UNKNOWN`, while GitHub is still working it out, keeps the last answer.
   - **Merged or closed** is reported, and then the watch ends.
   - **One poll gives one prompt and one notice**, whatever changed in it.
11. **The prompt says what to do.** It names the PR and each change, together with the `gh` command that shows it (`gh pr checks <url>`, `gh pr view <url> --comments`). It is queued, not sent (Decision 4).
   - Up to 10 failed checks are named; the rest are counted. *Review fix:* a name is untrusted text from the repo's CI config, so it is made one line (control, bidi and zero-width characters removed, whitespace runs collapsed) and cut to 100 characters (`checkName`).
   - With the newest session's queue full (100 prompts), nothing is queued and the notice says so.
   - *Review fix:* a session that refuses the prompt for another reason (closed meanwhile, `NOT_FOUND`) passes it to the next newest session. With none left, the notice alone reports it ("no agent session"), never "queue is full".
12. **The notice** is `{title: 'PR #12', text, url, at}`. `text` is what changed and where the prompt went, for example "Checks failed · 1 new comment — prompt queued for Claude".
   - The notice is runtime only (Risk 4). The next report replaces it, and `prWatch.dismiss` clears it.
   - It is published unpersisted, like a session's status.
13. **Polling.**
   - Every watched branch is polled every 3 minutes (`PR_POLL_MS`), one at a time.
   - *Review fix:* each poll runs one `gh api graphql` query (`PR_QUERY`, `prQueryArgs`) instead of `gh pr view --json …reviews,comments`, whose comment and review bodies could pass the output cap on a bot-heavy PR. It asks only for what is compared: state, mergeable, head commit, the head commit's first 100 checks, the author and time of the newest 100 reviews and comments, and `viewer { login }`. The answer is a few kilobytes; the cap is now 1 MiB, with a 30 s timeout. gh runs with no prompt, no pager and no update check.
   - Turning a watch on polls it at once. A poll already running for the same branch and URL is skipped. *Review fix:* the URL is part of that key, so a PR re-linked mid-poll gets its own baseline poll at once; the old answer is then dropped by the re-read below.
   - After each `gh` answer the branch is read again, so a watch turned off, a PR changed, or the worktree gone, during the call is left alone (its `seen` does not move).
   - *Review fix:* a branch's polls failing 3 times in a row (`FAILS_BEFORE_NOTICE`) set the worktree's notice to "Can’t be read: <first line of the error>", once, until a poll succeeds; the good poll withdraws it unless something replaced it. A watch is never dead silently.
   - *Review fix:* a watched branch with no worktree (removed, or missing on disk) drops its `seen` at the next round (`forgetUnpolled`), so when a worktree has it again its first poll is a fresh baseline rather than a report of everything since. Chosen over "unpolled for longer than N": it needs no saved timestamp, and a server that was down for a while still reports what changed meanwhile.
   - *Review fix:* `stop()` aborts any running gh (an `AbortSignal` on `execFile`); nothing is applied, logged or re-checked after it.
   - *Review fix:* a round goes on past a branch whose poll throws.
   - *Review fix:* `project.import` checks a branch's `prWatch` is an object and drops its `seen`, so an imported watch starts with a baseline.
14. **The `prWatch` capability.**
    - **When it is checked:** `gh auth status --hostname github.com` runs at start, then every 10 minutes (`GH_RECHECK_MS`) on its own timer, signed in or not, and after a poll that fails with what looks like a sign-in error (`isAuthFailure`: HTTP 401, bad credentials, not logged in, authentication). *Review fix:* before, it was re-checked only while signed out, or after any failed poll. A sign-out with nothing watched was never noticed, and one network blip withdrew the capability from every window and paused every watch for 10 minutes.
    - Callers while a check runs share it (one in-flight promise), so two can't both report the same change.
    - Not `--active`: gh before 2.40 rejects the flag, which would read as signed out.
    - **Signed out:** no watch can be turned on (`TOOL_ERROR`), but the watches already on stay on and resume once gh is signed in again.
    - **A change is pushed** to every authenticated connection as `integrations.changed {prWatch}` (Decision 6). For the smoke, `TREK_SERVER_PR_POLL_MS` also sets the time between sign-in checks.
    - **`trek.ready`** waits up to 3 s for the first check, so a slow gh never holds up the start. Only the Local server's announcement waits on it, so the app's first welcome has the answer; a remote server takes connections at once, and a welcome sent before gh answered lacks `prWatch` until the change is pushed.
15. **The methods.**
    - **`branch.setPrWatch {projectId, repoId, branch, watch}`:**
      - Turning a watch on needs `prWatch` (otherwise `TOOL_ERROR`) and a linked github.com URL (otherwise `BAD_REQUEST`).
      - A watch that is already on keeps its `seen`, and is not polled again.
      - Turning a watch off always works, gh or not.
    - **`prWatch.dismiss {projectId, worktreeId}`** clears the notice; an unknown worktree is `NOT_FOUND`.
    - **`watch_pull_request {worktree, watch?}`** goes through `branch.setPrWatch` and answers `{branch, pullRequest, watching}`.
16. **The attention entry is the worktree's**, with `sessionId: ''`.
    - **Main's handling:**
      - main keys it as `worktree:<id>`;
      - it raises it as a new kind, `pullRequest`, once per `at`;
      - the notification reads "PR #12 changed", with the place and the notice's text as the body; *app review fix:* a notice the server could not read (`Can’t be read: <reason>`) reads "PR #12 can’t be read", with the place and the reason;
      - the notification is shown even when the worktree is in view, because no session can stand for it;
      - its sound follows the project's `audioAlerts`;
      - it is dismissed through `prWatch.dismiss`.
    - **Clicking it** selects the worktree. `selectStep` already falls back to the worktree when the session id is not a tab.
    - **A malformed entry** (`sessionId: ''` with no `pullRequest`) is skipped.
17. **The app's surface.**
    - The … menu shows **Watch pull request** or **Stop watching pull request** when a PR is linked and either `features.prWatch` is on or the branch is already watched. That way a watch can still be stopped while gh is signed out.
    - The PR chip shows "· watching" while the branch is watched. *App review fix:* while gh is signed out (`features.prWatch` off) a kept watch shows as "· watch paused — gh signed out". The menu item does nothing while another action is busy.
    - A notice adds a chip with a × (titled Dismiss, disabled while offline), flags the sidebar row and adds an entry to the notifications menu. *App review fix:* the row's flag ("PR", its tooltip the notice) sits beside the status dot instead of replacing it, so a working session still shows; a collapsed repo header shows the flag too when any of its worktrees has a notice. The menu words a notice's entry as a notice: its × is "Dismiss", a failed dismiss says "Could not dismiss the notice", and the bell's title counts sessions and pull request notices apart (`MenuEntry.pullRequest`).
    - The projector gives the store `branchPrWatches`, keyed by branch, as it does `branchPullRequests`. *App review fix:* notices are `worktreePrNotices`, keyed by the worktree's path, not its branch: keyed by branch, a `missing` worktree on the same branch could override the live one's notice, and the row's × then dismissed the live worktree, which had none.
18. **`src/main/github.ts` stays.** It resolves a PR's head branch when the app creates a worktree from a PR, which has nothing to do with the watch. *App review fix:* it picks gh as the server does (`src/main/ghBinary.ts`): `TREK_SERVER_GH` when it is an absolute path, no gh (the public API fallback only) for any other value, and `gh` from the PATH only when it is unset. So no smoke reaches the real gh through main either.
19. **No smoke runs the real gh.**
    - `TREK_SERVER_GH` (an absolute path) is the gh the server runs. Only an unset variable means `gh` from the PATH. *Review fix:* any other value (empty, relative) is logged and fails closed: the runner always rejects, so gh reads as not installed. Before, it fell back to the real gh on the PATH, so a typo in a test's stub path reached GitHub.
    - `TREK_SERVER_PR_POLL_MS` (at least 1000) sets the time between polls and between sign-in checks, for the smoke.
    - Every smoke imports `scripts/smokeGh.mjs` first. It writes a stub that is never signed in and sets `TREK_SERVER_GH` to it in `process.env`.
    - Every child inherits the variable, and main's `childEnv` keeps it for the Local server. `smoke:v2` and `smoke:local-features` check that the welcome has no `prWatch`, which proves the stub was the gh that ran.
    - *App review fix:* `smoke:server-prwatch` runs the notification path end to end: main's `Notification` is stubbed (recorded, clickable) and its title and body checked, a menu entry and a notification click each select the worktree, the menu's × dismisses a second notice on the server, and at the end every gh call is checked to be the sign-in check or the watch's query. Its sign-out section records the window's connection status and the SDK connection's status and welcomes, so "without a reconnect" is asserted.
    - This lands in Task 2, with the first code that runs gh, so no smoke between tasks reaches the real one. This machine has `/opt/homebrew/bin/gh`.

## Conventions

As 5b's, with these:
- **Baseline:** master `300eb5e`: 1697 tests (1696 pass, 1 skipped). Smokes are as in 5b's final verification.
- **No real gh, ever, and no GitHub.** Unit tests hand `PrWatcher` a fake runner. Smokes get `smokeGh.mjs`'s stub; `smoke:server-prwatch` scripts its own and checks every `api graphql` query it saw.
- **No real docker, colima, Linear or ElevenLabs**, as in 5b.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/shared/model/types.ts` | modify | 1 | `BranchData.prWatch`, `PrWatch`, `PrSeen`, `PrNotice`, `Worktree.prNotice`, `AttentionEntry.pullRequest` |
| `src/shared/prWatch.ts` | create | 1 | the pure rules: `watchableUrl`, `checksOf`, `parsePrView`, `watchStep`, `promptText`, `noticeText` |
| `scripts/prWatchRules.test.mjs` | create | 1 | |
| `server/src/prWatch/gh.ts` | create | 2 | `ghRunner`, `ghBinary` (`TREK_SERVER_GH`), `ghSignedIn` |
| `server/src/prWatch/watcher.ts` | create | 2 | `PrWatcher`, `watchTargets`, `pollMsFromEnv` |
| `server/src/prWatch/prWatchHandlers.ts` | create | 2 | `branch.setPrWatch`, `prWatch.dismiss` |
| `server/src/v2.ts`, `server.ts`, `capabilities.ts`, `index.ts` | modify | 2, 3 | the context's `prWatch`; `branch.setPr` ends a watch; the capability and its push (`integrations.changed {prWatch}`); the watcher's start, stop and `ready` |
| `server/src/sessions/status.ts`, `server/src/projects/model.ts` | modify | 2 | the notice's attention entry; `resetRuntime` drops `prNotice` |
| `src/shared/protocolV2.ts` | modify | 2 | `CAPABILITY.prWatch`, the methods |
| `src/main/localServerRules.ts` | modify | 2 | `childEnv` keeps `TREK_SERVER_GH` |
| `scripts/smokeGh.mjs` | create | 2 | the stub gh every smoke gets |
| every `scripts/*-smoke.mjs`, `scripts/client-contract.mjs`, `server/scripts/smoke.mjs` | modify | 2 | `import './smokeGh.mjs'`; v2 and local-features check it |
| `scripts/serverPrWatch.test.mjs` | create | 2 | |
| `scripts/localServerRules.test.mjs` | modify | 2 | |
| `server/src/mcp/tools.ts`, `describe.ts` | modify | 3 | `watch_pull_request`, `watchingPullRequest` |
| `scripts/serverMcpTools.test.mjs` | modify | 3 | |
| `src/main/attention.ts`, `attentionRules.ts` | modify | 4 | the notice's key, kind, text and dismiss |
| `src/shared/types.ts` | modify | 4 | `AttentionItem.pullRequest`; the legacy `branchPrWatches`, `branchPrNotices` |
| `src/renderer/src/{backend,backendFeatures,notificationItems}.ts`, `v2/{backendV2,projector}.ts` | modify | 4 | `branch.setPrWatch`, `branch.dismissPrNotice`; `features.prWatch`; the menu's text; the maps |
| `src/renderer/src/components/{WorktreeDetail,Sidebar}.tsx`, `styles.css` | modify | 4 | the menu item, the chips, the flag |
| `scripts/{mainAttention,mainAttentionRules,attentionMenu,v2Projector,backendFeatures}.test.mjs` | modify | 4 | |
| `src/shared/client/connection.ts`, `src/renderer/src/v2/ServerProjectWindow.tsx` | modify | 4 | `integrations.changed {prWatch}` moves the capability; the window re-reads its features |
| `scripts/clientConnection.test.mjs` | modify | 4 | |
| `scripts/server-prwatch-smoke.mjs`, `package.json` | create, modify | 5 | `smoke:server-prwatch` |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | modify | 6 | |

---

### Task 1: The PR watch's model and its pure rules

**Files:**
- Create: `src/shared/prWatch.ts`, `scripts/prWatchRules.test.mjs`
- Modify: `src/shared/model/types.ts`

Nothing runs gh yet, and no behaviour changes. The new model fields are optional (Decisions 8–12).

- [ ] **Step 1: Apply the diff** (the prototype's 6f174f9)

`````diff
diff --git a/scripts/prWatchRules.test.mjs b/scripts/prWatchRules.test.mjs
new file mode 100644
index 0000000..2d1bf81
--- /dev/null
+++ b/scripts/prWatchRules.test.mjs
@@ -0,0 +1,167 @@
+// scripts/prWatchRules.test.mjs — the pull request watch's rules (phase 5c-1): gh's answer read,
+// a poll compared with the last, and the prompt and notice that report it.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import {
+  MAX_FAILED_NAMES,
+  checksOf,
+  noticeText,
+  parsePrView,
+  promptText,
+  watchStep,
+  watchableUrl
+} from '../src/shared/prWatch.ts'
+
+const URL = 'https://github.com/acme/app/pull/12'
+
+/** gh's answer, with the fields PR_VIEW_FIELDS asks for. */
+function gh(overrides = {}) {
+  return {
+    number: 12,
+    state: 'OPEN',
+    mergeable: 'MERGEABLE',
+    headRefOid: 'aaa',
+    author: { login: 'me' },
+    statusCheckRollup: [],
+    reviews: [],
+    comments: [],
+    ...overrides
+  }
+}
+const run = (name, status, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion })
+const ctx = (context, state) => ({ __typename: 'StatusContext', context, state })
+
+test('watchableUrl takes only a canonical github.com pull URL', () => {
+  assert.deepEqual(watchableUrl(URL), { url: URL, number: 12 })
+  for (const bad of [undefined, '', '12', '-R x', 'https://github.com/acme/app/pull/12/files', 'http://github.com/acme/app/pull/12', 'https://gitlab.com/a/b/pull/1']) {
+    assert.equal(watchableUrl(bad), null, String(bad))
+  }
+})
+
+test('checksOf: none, pending, passing, failing (as soon as one fails), status contexts too', () => {
+  assert.deepEqual(checksOf([]), { state: 'none', failed: [] })
+  assert.deepEqual(checksOf(undefined), { state: 'none', failed: [] })
+  assert.deepEqual(checksOf([run('lint', 'IN_PROGRESS')]), { state: 'pending', failed: [] })
+  assert.deepEqual(checksOf([run('lint', 'COMPLETED', 'SUCCESS'), run('docs', 'COMPLETED', 'SKIPPED'), ctx('ci/x', 'SUCCESS')]), { state: 'passing', failed: [] })
+  assert.deepEqual(checksOf([run('lint', 'COMPLETED', 'FAILURE'), run('test', 'QUEUED'), ctx('ci/x', 'ERROR')]), { state: 'failing', failed: ['lint', 'ci/x'] })
+  assert.deepEqual(checksOf([ctx('ci/x', 'PENDING')]), { state: 'pending', failed: [] })
+  assert.deepEqual(checksOf([run('t', 'COMPLETED', 'TIMED_OUT'), run('c', 'COMPLETED', 'CANCELLED')]).failed, ['t', 'c'])
+})
+
+test("parsePrView: state, mergeable, head, checks, and others' reviews and comments, oldest first", () => {
+  const view = parsePrView(
+    gh({
+      mergeable: 'CONFLICTING',
+      statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')],
+      reviews: [
+        { author: { login: 'rev' }, state: 'COMMENTED', submittedAt: '2026-11-10T10:05:00Z' },
+        { author: { login: 'rev' }, state: 'PENDING' },
+        { author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-11-10T10:06:00Z' }
+      ],
+      comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }]
+    })
+  )
+  assert.deepEqual(view, {
+    number: 12,
+    state: 'OPEN',
+    mergeable: 'CONFLICTING',
+    headSha: 'aaa',
+    checks: 'failing',
+    failed: ['lint'],
+    commentTimes: ['2026-11-10T10:01:00Z', '2026-11-10T10:05:00Z']
+  })
+  assert.equal(parsePrView(gh({ mergeable: 'something' })).mergeable, 'UNKNOWN')
+  assert.throws(() => parsePrView(gh({ state: 'DRAFT' })), /unexpected state/)
+  assert.throws(() => parsePrView([]), /not a JSON object/)
+})
+
+test('watchStep: the first poll is the baseline and reports nothing', () => {
+  const step = watchStep(undefined, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')], comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }] })))
+  assert.deepEqual(step, { seen: { checks: 'aaa failing', conflict: false, commentsAt: '2026-11-10T10:01:00Z' }, events: [], stop: false })
+})
+
+test('watchStep: a PR already merged or closed at the baseline is reported, and the watch stops', () => {
+  assert.deepEqual(watchStep(undefined, parsePrView(gh({ state: 'MERGED' }))).events, [{ kind: 'merged' }])
+  assert.equal(watchStep(undefined, parsePrView(gh({ state: 'CLOSED' }))).stop, true)
+})
+
+test('watchStep: checks are reported once per head commit, failing with names or passing', () => {
+  const pending = watchStep(undefined, parsePrView(gh({ statusCheckRollup: [run('lint', 'IN_PROGRESS')] }))).seen
+  const failed = watchStep(pending, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] })))
+  assert.deepEqual(failed.events, [{ kind: 'checksFailed', names: ['lint'] }])
+  // The same failure again: nothing new.
+  assert.deepEqual(watchStep(failed.seen, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] }))).events, [])
+  // A push that fails the same way is a new moment.
+  assert.deepEqual(
+    watchStep(failed.seen, parsePrView(gh({ headRefOid: 'bbb', statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] }))).events,
+    [{ kind: 'checksFailed', names: ['lint'] }]
+  )
+  // Passing after a push, even with pending missed between polls.
+  const passing = watchStep(failed.seen, parsePrView(gh({ headRefOid: 'bbb', statusCheckRollup: [run('lint', 'COMPLETED', 'SUCCESS')] })))
+  assert.deepEqual(passing.events, [{ kind: 'checksPassed' }])
+  // Pending after a push reports nothing.
+  assert.deepEqual(watchStep(passing.seen, parsePrView(gh({ headRefOid: 'ccc', statusCheckRollup: [run('lint', 'QUEUED')] }))).events, [])
+})
+
+test('watchStep: new reviews and comments are those after the newest seen; the author’s are skipped', () => {
+  const base = watchStep(undefined, parsePrView(gh({ comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }] }))).seen
+  const next = watchStep(
+    base,
+    parsePrView(
+      gh({
+        comments: [
+          { author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' },
+          { author: { login: 'bob' }, createdAt: '2026-11-10T10:09:00Z' },
+          { author: { login: 'me' }, createdAt: '2026-11-10T10:10:00Z' }
+        ],
+        reviews: [{ author: { login: 'rev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-10T10:08:00Z' }]
+      })
+    )
+  )
+  assert.deepEqual(next.events, [{ kind: 'comments', count: 2 }])
+  assert.equal(next.seen.commentsAt, '2026-11-10T10:09:00Z')
+  // A deleted comment never moves commentsAt back.
+  assert.equal(watchStep(next.seen, parsePrView(gh())).seen.commentsAt, '2026-11-10T10:09:00Z')
+})
+
+test('watchStep: a conflict is reported when it appears; UNKNOWN keeps the last answer', () => {
+  const base = watchStep(undefined, parsePrView(gh())).seen
+  const conflicted = watchStep(base, parsePrView(gh({ mergeable: 'CONFLICTING' })))
+  assert.deepEqual(conflicted.events, [{ kind: 'conflict' }])
+  const unknown = watchStep(conflicted.seen, parsePrView(gh({ mergeable: 'UNKNOWN' })))
+  assert.deepEqual(unknown, { seen: conflicted.seen, events: [], stop: false })
+  assert.deepEqual(watchStep(unknown.seen, parsePrView(gh({ mergeable: 'CONFLICTING' }))).events, [])
+})
+
+test('watchStep: merged and closed end the watch, whatever else changed', () => {
+  const base = watchStep(undefined, parsePrView(gh())).seen
+  assert.deepEqual(watchStep(base, parsePrView(gh({ state: 'MERGED', mergeable: 'CONFLICTING' }))), {
+    seen: { checks: 'aaa none', conflict: true },
+    events: [{ kind: 'merged' }],
+    stop: true
+  })
+  assert.deepEqual(watchStep(base, parsePrView(gh({ state: 'CLOSED' }))).events, [{ kind: 'closed' }])
+})
+
+test('promptText says what changed and what to do, with gh commands on the PR URL', () => {
+  const text = promptText(URL, 12, [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 2 }, { kind: 'conflict' }])
+  assert.equal(
+    text,
+    [
+      `Pull request #12 (${URL}) changed:`,
+      `- Checks failed: lint. Look at them with \`gh pr checks ${URL}\`, fix the cause, and push.`,
+      `- 2 new reviews or comments. Read them with \`gh pr view ${URL} --comments\` and address them.`,
+      '- It has a merge conflict with its base branch. Merge or rebase onto the base, resolve the conflict, and push.'
+    ].join('\n')
+  )
+  const many = Array.from({ length: MAX_FAILED_NAMES + 2 }, (_, i) => `c${i}`)
+  assert.match(promptText(URL, 12, [{ kind: 'checksFailed', names: many }]), /c9 and 2 more\./)
+  assert.match(promptText(URL, 12, [{ kind: 'merged' }]), /- It was merged\.$/)
+})
+
+test('noticeText: what changed, then where the prompt went', () => {
+  const events = [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 1 }]
+  assert.equal(noticeText(events, { queuedFor: 'Claude' }), 'Checks failed · 1 new comment — prompt queued for Claude')
+  assert.equal(noticeText([{ kind: 'merged' }], 'noSession'), 'Merged — no agent session to send it to')
+  assert.equal(noticeText([{ kind: 'conflict' }], 'queueFull'), 'Merge conflict — its session’s queue is full')
+})
diff --git a/src/shared/model/types.ts b/src/shared/model/types.ts
index 241222f..ed84a6c 100644
--- a/src/shared/model/types.ts
+++ b/src/shared/model/types.ts
@@ -60,6 +60,34 @@ export interface BranchData {
   pr?: string
   /** .env-style text for the branch's Docker environment */
   env?: string
+  /** The server watches `pr` (5c-1): on while present; cleared with `pr`, and by the server after merged or closed */
+  prWatch?: PrWatch
+}
+
+/** A pull request watch. `seen` is what the last poll saw; absent until the first poll (the baseline, which reports nothing). */
+export interface PrWatch {
+  seen?: PrSeen
+}
+
+/** What a watch remembers between polls, so a server restart reports nothing twice. */
+export interface PrSeen {
+  /** `<head commit> <checks state>`: a new push, or the same run settling, is a new moment */
+  checks: string
+  /** GitHub last said the PR conflicts with its base (UNKNOWN keeps the previous answer) */
+  conflict: boolean
+  /** ISO time of the newest review or comment by someone other than the PR's author */
+  commentsAt?: string
+}
+
+/** What a watched pull request last reported (5c-1). Runtime only, like a session's status. */
+export interface PrNotice {
+  /** "PR #12" */
+  title: string
+  /** One line: what changed, and where its prompt went */
+  text: string
+  url: string
+  /** Epoch ms, the server's clock */
+  at: number
 }
 
 export interface Worktree {
@@ -84,6 +112,8 @@ export interface Worktree {
   /** Whether the worktree's sessions are running (loaded) or only saved */
   loaded: boolean
   sessions: Session[]
+  /** Its watched pull request's last report, until dismissed (`prWatch.dismiss`) or replaced. Runtime only. */
+  prNotice?: PrNotice
 }
 
 export interface Repository {
@@ -142,7 +172,10 @@ export interface ProjectSummary {
 
 /**
  * A session that needs the user, as listed by the `attention` topic: one in
- * `attention` or `done`, or one with an open decision (in any status).
+ * `attention` or `done`, or one with an open decision (in any status). A
+ * worktree's pull request notice (5c-1) is listed too: `sessionId` '', `title`
+ * the notice's ("PR #12"), `status` 'attention', `since` its `at`, and
+ * `pullRequest` set, so a client older than 5c-1 still lists it as needing attention.
  */
 export interface AttentionEntry {
   projectId: string
@@ -159,4 +192,6 @@ export interface AttentionEntry {
   projectName: string
   /** The project's `audioAlerts` setting, when on: the client plays its alert sound */
   audioAlerts?: true
+  /** A worktree's pull request notice (5c-1): what changed. Its entry has no session (`sessionId` ''). */
+  pullRequest?: { text: string; url: string }
 }
diff --git a/src/shared/prWatch.ts b/src/shared/prWatch.ts
new file mode 100644
index 0000000..6ad2971
--- /dev/null
+++ b/src/shared/prWatch.ts
@@ -0,0 +1,216 @@
+// Pull request watch rules (phase 5c-1), pure: what `gh pr view --json` says
+// about a pull request, what changed since the last poll, and the prompt and
+// notice that report it. The server's PrWatcher (server/src/prWatch/) runs gh
+// and applies the result; tests drive these with fixtures.
+import type { PrSeen } from './model/types.ts'
+
+/** The fields the watcher asks gh for (`gh pr view <url> --json …`). */
+export const PR_VIEW_FIELDS = 'number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments'
+
+const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/
+
+/**
+ * A linked PR the watcher may hand to gh: a canonical github.com pull URL, as
+ * set_worktree_pull_request stores it. Anything else (a branch.setPr from an
+ * older client may be any string) is refused rather than passed to gh.
+ */
+export function watchableUrl(url: string | undefined): { url: string; number: number } | null {
+  if (typeof url !== 'string') return null
+  const m = url.match(PR_URL)
+  return m ? { url, number: Number(m[3]) } : null
+}
+
+export type ChecksState = 'none' | 'pending' | 'passing' | 'failing'
+
+/** A pull request as the watcher sees it: the parts of gh's answer it compares. */
+export interface PrView {
+  number: number
+  state: 'OPEN' | 'MERGED' | 'CLOSED'
+  /** UNKNOWN while GitHub is still working it out */
+  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
+  headSha: string
+  checks: ChecksState
+  /** The failed checks' names, in gh's order */
+  failed: string[]
+  /** ISO times of the reviews and comments by anyone but the PR's author */
+  commentTimes: string[]
+}
+
+export type PrEvent =
+  | { kind: 'checksFailed'; names: string[] }
+  | { kind: 'checksPassed' }
+  | { kind: 'comments'; count: number }
+  | { kind: 'conflict' }
+  | { kind: 'merged' }
+  | { kind: 'closed' }
+
+const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
+const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
+/** Names listed in a prompt; the rest are counted */
+export const MAX_FAILED_NAMES = 10
+
+const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
+const str = (v: unknown): string => (typeof v === 'string' ? v : '')
+
+/**
+ * Checks from gh's statusCheckRollup: CheckRuns (status, conclusion, name) and
+ * StatusContexts (state, context). Failing as soon as one has failed, even with
+ * others still running: the agent can start on it. Passing once all are done.
+ */
+export function checksOf(rollup: unknown): { state: ChecksState; failed: string[] } {
+  const items = Array.isArray(rollup) ? rollup.filter(isRecord) : []
+  if (items.length === 0) return { state: 'none', failed: [] }
+  const failed: string[] = []
+  let pending = false
+  for (const item of items) {
+    const name = str(item.name) || str(item.context) || 'unnamed check'
+    if (item.__typename === 'StatusContext' || (item.state !== undefined && item.status === undefined)) {
+      const state = str(item.state)
+      if (FAILED.has(state)) failed.push(name)
+      else if (!PASSED.has(state)) pending = true
+      continue
+    }
+    if (str(item.status) !== 'COMPLETED') {
+      pending = true
+      continue
+    }
+    const conclusion = str(item.conclusion)
+    if (FAILED.has(conclusion)) failed.push(name)
+    else if (!PASSED.has(conclusion)) pending = true
+  }
+  if (failed.length > 0) return { state: 'failing', failed }
+  return { state: pending ? 'pending' : 'passing', failed: [] }
+}
+
+/** gh's JSON for PR_VIEW_FIELDS; throws on an answer without the fields the watch compares. */
+export function parsePrView(json: unknown): PrView {
+  if (!isRecord(json)) throw new Error('gh pr view: not a JSON object')
+  const state = json.state
+  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') throw new Error(`gh pr view: unexpected state ${JSON.stringify(state)}`)
+  const mergeable = json.mergeable === 'MERGEABLE' || json.mergeable === 'CONFLICTING' ? json.mergeable : 'UNKNOWN'
+  const author = isRecord(json.author) ? str(json.author.login) : ''
+  const times: string[] = []
+  const collect = (list: unknown, at: 'submittedAt' | 'createdAt'): void => {
+    for (const item of Array.isArray(list) ? list.filter(isRecord) : []) {
+      const login = isRecord(item.author) ? str(item.author.login) : ''
+      const time = str(item[at])
+      // A pending review has no submittedAt; the author's own comments are not news to the agent.
+      if (!time || (author && login === author)) continue
+      times.push(time)
+    }
+  }
+  collect(json.reviews, 'submittedAt')
+  collect(json.comments, 'createdAt')
+  const checks = checksOf(json.statusCheckRollup)
+  return {
+    number: typeof json.number === 'number' ? json.number : 0,
+    state,
+    mergeable,
+    headSha: str(json.headRefOid),
+    checks: checks.state,
+    failed: checks.failed,
+    commentTimes: times.sort()
+  }
+}
+
+/** One poll's outcome: what to remember, what to report, and whether the watch ends. */
+export interface WatchStep {
+  seen: PrSeen
+  events: PrEvent[]
+  /** Merged or closed: report it, then the watch turns off */
+  stop: boolean
+}
+
+const checksKey = (view: PrView): string => `${view.headSha} ${view.checks}`
+
+/**
+ * Compares a poll with the last one. The first poll (`prev` undefined) is the
+ * baseline: it reports nothing, unless the PR is already merged or closed. A
+ * checks state is reported once per head commit: failing (with the names) or
+ * passing; pending and none are not reported. New reviews and comments are
+ * those after the newest one seen.
+ */
+export function watchStep(prev: PrSeen | undefined, view: PrView): WatchStep {
+  const newest = view.commentTimes.length > 0 ? view.commentTimes[view.commentTimes.length - 1] : undefined
+  const seen: PrSeen = {
+    checks: checksKey(view),
+    conflict: view.mergeable === 'UNKNOWN' ? (prev?.conflict ?? false) : view.mergeable === 'CONFLICTING'
+  }
+  const commentsAt = newest !== undefined && (prev?.commentsAt === undefined || newest > prev.commentsAt) ? newest : prev?.commentsAt
+  if (commentsAt !== undefined) seen.commentsAt = commentsAt
+  if (view.state !== 'OPEN') return { seen, events: [{ kind: view.state === 'MERGED' ? 'merged' : 'closed' }], stop: true }
+  if (!prev) return { seen, events: [], stop: false }
+  const events: PrEvent[] = []
+  if (seen.checks !== prev.checks) {
+    if (view.checks === 'failing') events.push({ kind: 'checksFailed', names: view.failed })
+    else if (view.checks === 'passing') events.push({ kind: 'checksPassed' })
+  }
+  const fresh = view.commentTimes.filter((t) => prev.commentsAt === undefined || t > prev.commentsAt).length
+  if (fresh > 0) events.push({ kind: 'comments', count: fresh })
+  if (seen.conflict && !prev.conflict) events.push({ kind: 'conflict' })
+  return { seen, events, stop: false }
+}
+
+const names = (list: string[]): string => {
+  const shown = list.slice(0, MAX_FAILED_NAMES).join(', ')
+  return list.length > MAX_FAILED_NAMES ? `${shown} and ${list.length - MAX_FAILED_NAMES} more` : shown
+}
+
+/** The prompt queued on the worktree's session: what changed, and what to do about it. */
+export function promptText(url: string, number: number, events: PrEvent[]): string {
+  const lines = events.map((e): string => {
+    switch (e.kind) {
+      case 'checksFailed':
+        return `- Checks failed${e.names.length > 0 ? `: ${names(e.names)}` : ''}. Look at them with \`gh pr checks ${url}\`, fix the cause, and push.`
+      case 'checksPassed':
+        return '- All checks passed.'
+      case 'comments':
+        return `- ${e.count === 1 ? 'A new review or comment' : `${e.count} new reviews or comments`}. Read them with \`gh pr view ${url} --comments\` and address them.`
+      case 'conflict':
+        return '- It has a merge conflict with its base branch. Merge or rebase onto the base, resolve the conflict, and push.'
+      case 'merged':
+        return '- It was merged.'
+      case 'closed':
+        return '- It was closed without being merged.'
+    }
+  })
+  return `Pull request #${number} (${url}) changed:\n${lines.join('\n')}`
+}
+
+/** "checks failed · 2 new comments": the notice's first part. */
+export function eventSummary(events: PrEvent[]): string {
+  return events
+    .map((e): string => {
+      switch (e.kind) {
+        case 'checksFailed':
+          return 'checks failed'
+        case 'checksPassed':
+          return 'checks passed'
+        case 'comments':
+          return e.count === 1 ? '1 new comment' : `${e.count} new comments`
+        case 'conflict':
+          return 'merge conflict'
+        case 'merged':
+          return 'merged'
+        case 'closed':
+          return 'closed'
+      }
+    })
+    .join(' · ')
+}
+
+/** Where the prompt went, for the notice. */
+export type PromptOutcome = { queuedFor: string } | 'noSession' | 'queueFull'
+
+/** The notice's one line: "Checks failed · 1 new comment — prompt queued for Claude". */
+export function noticeText(events: PrEvent[], outcome: PromptOutcome): string {
+  const what = eventSummary(events)
+  const capital = what.charAt(0).toUpperCase() + what.slice(1)
+  const where =
+    outcome === 'noSession'
+      ? 'no agent session to send it to'
+      : outcome === 'queueFull'
+        ? 'its session’s queue is full'
+        : `prompt queued for ${outcome.queuedFor}`
+  return `${capital} — ${where}`
+}
`````

- [ ] **Step 2: Verify:** `node --test scripts/prWatchRules.test.mjs` passes all 11 tests. `npm run typecheck` and `cd server && npm run typecheck` are clean.
- [ ] **Step 3: Commit:** `feat(5c-1): the PR watch's model fields and pure rules`.

### Task 2: The server watches pull requests; no smoke runs the real gh

**Files:**
- Create:
  - `server/src/prWatch/{gh,watcher,prWatchHandlers}.ts`
  - `scripts/serverPrWatch.test.mjs`
  - `scripts/smokeGh.mjs`
- Modify:
  - `server/src/{v2,server,capabilities,index}.ts`
  - `server/src/sessions/status.ts`
  - `server/src/projects/model.ts`
  - `src/shared/protocolV2.ts`
  - `src/main/localServerRules.ts`
  - `scripts/localServerRules.test.mjs`
  - every smoke's imports: `scripts/{import,local-app,local-features,local-server,local-window,providers,server-env,server-integrations,v2,windows}-smoke.mjs`, `scripts/client-contract.mjs`, `server/scripts/smoke.mjs`
  - one check each in `smoke:v2` and `smoke:local-features`

This is the first code that runs gh, so the smoke stub lands with it (Decision 19). The app does not change yet: a 5c-1 server with an older app shows a notice as "PR #12 needs your attention" (Risk 1).

- [ ] **Step 1: Apply the diff** (the prototype's e157c76)

`````diff
diff --git a/scripts/client-contract.mjs b/scripts/client-contract.mjs
index ff13d69..7180ec3 100644
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -3,6 +3,7 @@
 // project and wait for its rev, start a session and stream its pty, survive a
 // reconnect, see a deleted project's topic end, and reach needs-auth with a
 // wrong token. Uses only the SDK and the global WebSocket.
+import './smokeGh.mjs'
 import { spawn, execFileSync } from 'node:child_process'
 import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { createServer } from 'node:net'
diff --git a/scripts/import-smoke.mjs b/scripts/import-smoke.mjs
index 8c50d12..dc6d27e 100644
--- a/scripts/import-smoke.mjs
+++ b/scripts/import-smoke.mjs
@@ -28,6 +28,7 @@
 // Main's dialogs are stubbed through -r and answered with their first button.
 //
 // Prints IMPORT SMOKE PASS (n checks) or IMPORT SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { createHash, randomBytes } from 'node:crypto'
diff --git a/scripts/local-app-smoke.mjs b/scripts/local-app-smoke.mjs
index c76c6eb..d5ea32f 100644
--- a/scripts/local-app-smoke.mjs
+++ b/scripts/local-app-smoke.mjs
@@ -38,6 +38,7 @@
 //
 //   node scripts/local-app-smoke.mjs [--packaged <Trek.app>]
 // Prints LOCAL APP SMOKE PASS (n checks) or LOCAL APP SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index f8363fa..c3f5902 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -32,6 +32,7 @@
 // Linear on) and smoke:server-env's (docker, environments and stacks on the server's machine).
 //
 // Prints LOCAL FEATURES SMOKE PASS (n checks) or LOCAL FEATURES SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
@@ -319,6 +320,8 @@ try {
   sdk.connect()
   await until(() => sdk.status, 'connected', 5000)
   check('the Local server says `local`, and runs docker, env and stacks', ['local', 'docker', 'env', 'stacks'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, true])
+  // The app's childEnv keeps TREK_SERVER_GH: the Local server asked smokeGh.mjs's stub, not the real gh (5c-1).
+  check("the Local server's gh is the smoke's stub: no prWatch", sdk.welcome?.capabilities.includes('prWatch'), false)
   // The upgrade: the server took the app's files over before it served anything; the app's stay.
   // Compared key-sorted: the take-over writes each entry's own fields in its own order.
   const sortedKeys = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v)
diff --git a/scripts/local-server-smoke.mjs b/scripts/local-server-smoke.mjs
index 6251dc6..1db0569 100644
--- a/scripts/local-server-smoke.mjs
+++ b/scripts/local-server-smoke.mjs
@@ -15,6 +15,7 @@
 // (read from inside the asar), with node-pty and its spawn-helper from app.asar.unpacked.
 //
 //   node scripts/local-server-smoke.mjs [--node-only | --electron-only | --packaged <Trek.app>]
+import './smokeGh.mjs'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
diff --git a/scripts/local-window-smoke.mjs b/scripts/local-window-smoke.mjs
index a04774d..be7f402 100644
--- a/scripts/local-window-smoke.mjs
+++ b/scripts/local-window-smoke.mjs
@@ -37,6 +37,7 @@
 // The app is launched with a temp HOME (its supervisor starts the run's own Local server in
 // ~/.config/trek-server/local-dev) and a temp --user-data-dir. Prints LOCAL WINDOW SMOKE PASS
 // (n checks) or LOCAL WINDOW SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawnSync } from 'node:child_process'
 import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
diff --git a/scripts/localServerRules.test.mjs b/scripts/localServerRules.test.mjs
index 2830eaf..aad84f7 100644
--- a/scripts/localServerRules.test.mjs
+++ b/scripts/localServerRules.test.mjs
@@ -74,7 +74,7 @@ test('TREK_LOCAL_PROFILE: a dev build takes a valid name, an invalid one is dev;
   // The server never inherits it: childEnv drops every TREK_ variable.
   assert.equal('TREK_LOCAL_PROFILE' in childEnv({ TREK_LOCAL_PROFILE: 'dev-wt2', PATH: '/bin' }), false)
   // Only the server's test endpoints for Linear and ElevenLabs get through (the smokes' stubs, 5b).
-  assert.deepEqual(childEnv({ TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_OTHER: 'x' }), { TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', ELECTRON_RUN_AS_NODE: '1' })
+  assert.deepEqual(childEnv({ TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_GH: '/tmp/stub/gh', TREK_SERVER_OTHER: 'x' }), { TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_GH: '/tmp/stub/gh', ELECTRON_RUN_AS_NODE: '1' })
 })
 
 test('isLocalServerCommand: trek-server, start --local, and this profile\'s --local-profile', () => {
diff --git a/scripts/providers-smoke.mjs b/scripts/providers-smoke.mjs
index 1b9493b..7ff3d81 100644
--- a/scripts/providers-smoke.mjs
+++ b/scripts/providers-smoke.mjs
@@ -21,6 +21,7 @@
 //   - no error dialogs (main's dialogs are stubbed), no console or page errors.
 //
 // Prints PROVIDERS SMOKE PASS (n checks) or PROVIDERS SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, execSync } from 'node:child_process'
 import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
diff --git a/scripts/server-env-smoke.mjs b/scripts/server-env-smoke.mjs
index ee38f25..58111d9 100644
--- a/scripts/server-env-smoke.mjs
+++ b/scripts/server-env-smoke.mjs
@@ -24,6 +24,7 @@
 //   - the renderer never holds the token; no console or page errors.
 //
 // Prints SERVER ENV SMOKE PASS (n checks) or SERVER ENV SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { createHash, randomBytes } from 'node:crypto'
diff --git a/scripts/server-integrations-smoke.mjs b/scripts/server-integrations-smoke.mjs
index fefa447..a6917f3 100644
--- a/scripts/server-integrations-smoke.mjs
+++ b/scripts/server-integrations-smoke.mjs
@@ -27,6 +27,7 @@
 //     API key; no console or page errors.
 //
 // Prints SERVER INTEGRATIONS SMOKE PASS (n checks) or SERVER INTEGRATIONS SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { createHash, randomBytes } from 'node:crypto'
diff --git a/scripts/serverPrWatch.test.mjs b/scripts/serverPrWatch.test.mjs
new file mode 100644
index 0000000..612cf08
--- /dev/null
+++ b/scripts/serverPrWatch.test.mjs
@@ -0,0 +1,310 @@
+// scripts/serverPrWatch.test.mjs — the server's pull request watch (phase 5c-1): the PrWatcher's polls
+// against a fake gh (nothing here runs gh or reaches GitHub), what it queues and notices, the
+// attention entry a notice makes, and the v2 methods branch.setPrWatch, branch.setPr and prWatch.dismiss.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
+import { resetRuntime } from '../server/src/projects/model.ts'
+import { attentionEntries } from '../server/src/sessions/status.ts'
+import { PrWatcher, pollMsFromEnv, watchTargets } from '../server/src/prWatch/watcher.ts'
+import { ghBinary } from '../server/src/prWatch/gh.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+import { welcomeCapabilities } from '../server/src/capabilities.ts'
+import { MAX_QUEUE_LENGTH } from '../server/src/sessions/limits.ts'
+
+const URL = 'https://github.com/acme/app/pull/12'
+
+function session(id, title = id) {
+  return { id, title, llm: { provider: 'claude' }, queue: [], status: 'idle' }
+}
+
+function project({ prWatch = {}, sessions = [session('s1', 'Old'), session('s2', 'Claude')], pr = URL } = {}) {
+  const data = {}
+  if (pr) data.pr = pr
+  if (prWatch) data.prWatch = prWatch
+  return {
+    id: 'p1',
+    name: 'Demo',
+    settings: {},
+    globalSessions: [],
+    repositories: [
+      {
+        id: 'r1',
+        name: 'app',
+        path: '/repo',
+        branchData: { feature: data },
+        worktrees: [
+          { id: 'w0', name: 'app', path: '/repo', isMain: true, loaded: false, sessions: [] },
+          { id: 'w1', name: 'feature', path: '/repo-feature', branch: 'feature', isMain: false, loaded: true, sessions }
+        ]
+      }
+    ]
+  }
+}
+
+function setup(initial = project(), ghAnswers = []) {
+  const hub = new TopicHub()
+  const saved = []
+  const projects = new ProjectState({ hub, store: { save: (p) => saved.push(structuredClone(p)), remove() {} }, onSummariesChange() {} }, [initial])
+  const queued = []
+  let refreshed = 0
+  const sessions = {
+    enqueue: ({ projectId, sessionId, text }) => {
+      queued.push({ sessionId, text })
+      projects.apply(projectId, (d) => {
+        for (const r of d.repositories) for (const w of r.worktrees) for (const s of w.sessions) if (s.id === sessionId) s.queue.push(text)
+      })
+    },
+    refreshAttention: () => refreshed++
+  }
+  const calls = []
+  const answers = [...ghAnswers]
+  const gh = async (args) => {
+    calls.push(args)
+    if (args[0] === 'auth') return ''
+    const next = answers.shift()
+    if (next instanceof Error) throw next
+    return JSON.stringify(next)
+  }
+  let clock = 1000
+  const jobs = []
+  const watcher = new PrWatcher({ projects, sessions, gh, now: () => clock, schedule: (fn, ms) => (jobs.push({ fn, ms }), { cancel() {} }) })
+  return { hub, projects, saved, queued, calls, watcher, jobs, refreshedCount: () => refreshed, tick: (ms) => (clock += ms), worktree: () => projects.require('p1').repositories[0].worktrees[1], data: () => projects.require('p1').repositories[0].branchData.feature }
+}
+
+const view = (o = {}) => ({ number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, statusCheckRollup: [], reviews: [], comments: [], ...o })
+const failing = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] }
+const target = { projectId: 'p1', repoId: 'r1', branch: 'feature', url: URL, number: 12 }
+
+test('ghBinary: TREK_SERVER_GH when it is an absolute path, else gh on the PATH', () => {
+  assert.equal(ghBinary('/tmp/stub/gh'), '/tmp/stub/gh')
+  for (const v of [undefined, '', 'gh', './gh']) assert.equal(ghBinary(v), 'gh', String(v))
+})
+
+test('pollMsFromEnv takes whole milliseconds, at least 1000', () => {
+  assert.equal(pollMsFromEnv('1500'), 1500)
+  for (const v of [undefined, '', '999', '1.5e3', 'abc', '-2000']) assert.equal(pollMsFromEnv(v), undefined, String(v))
+})
+
+test('watchTargets: watched branches checked out in a worktree, with a github.com pull URL', () => {
+  assert.deepEqual(watchTargets([project()]), [target])
+  assert.deepEqual(watchTargets([project({ prWatch: null })]), [])
+  assert.deepEqual(watchTargets([project({ pr: 'https://example.com/x' })]), [])
+  const gone = project()
+  gone.repositories[0].worktrees[1].missing = true
+  assert.deepEqual(watchTargets([gone]), [])
+})
+
+test('the first poll is the baseline: saved, nothing queued, no notice', async () => {
+  const s = setup(project(), [view(failing)])
+  await s.watcher.ready
+  assert.equal(s.watcher.available(), true)
+  await s.watcher.poll(target)
+  assert.deepEqual(s.calls.at(-1), ['pr', 'view', URL, '--json', 'number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments'])
+  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa failing', conflict: false } })
+  assert.equal(s.saved.length, 1, 'the baseline is saved, so a restart compares with it')
+  assert.deepEqual(s.queued, [])
+  assert.equal(s.worktree().prNotice, undefined)
+})
+
+test("a change queues one prompt on the worktree's newest session and sets the worktree's notice", async () => {
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }), [view({ ...failing, mergeable: 'CONFLICTING' })])
+  await s.watcher.ready
+  s.tick(5000)
+  await s.watcher.poll(target)
+  assert.equal(s.queued.length, 1)
+  assert.equal(s.queued[0].sessionId, 's2')
+  assert.match(s.queued[0].text, /^Pull request #12 \(https:\/\/github\.com\/acme\/app\/pull\/12\) changed:\n- Checks failed: lint\./)
+  assert.match(s.queued[0].text, /merge conflict/)
+  assert.deepEqual(s.worktree().prNotice, { title: 'PR #12', text: 'Checks failed · merge conflict — prompt queued for Claude', url: URL, at: 6000 })
+  assert.ok(s.refreshedCount() >= 1, 'attention is republished')
+  // The same answer again reports nothing more.
+  s.calls.length = 0
+  await s.watcher.poll(target)
+  assert.equal(s.queued.length, 1)
+})
+
+test('no session: the notice says so and nothing is queued or started', async () => {
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } }, sessions: [] }), [view(failing)])
+  await s.watcher.ready
+  await s.watcher.poll(target)
+  assert.deepEqual(s.queued, [])
+  assert.equal(s.worktree().prNotice.text, 'Checks failed — no agent session to send it to')
+})
+
+test('a full queue: nothing is queued, the notice says so', async () => {
+  const full = session('s9', 'Busy')
+  full.queue = Array.from({ length: MAX_QUEUE_LENGTH }, (_, i) => `p${i}`)
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } }, sessions: [full] }), [view(failing)])
+  await s.watcher.ready
+  await s.watcher.poll(target)
+  assert.deepEqual(s.queued, [])
+  assert.match(s.worktree().prNotice.text, /queue is full/)
+})
+
+test('merged: reported, then the watch turns itself off (the PR link stays)', async () => {
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state: 'MERGED' })])
+  await s.watcher.ready
+  await s.watcher.poll(target)
+  assert.deepEqual(s.data(), { pr: URL })
+  assert.match(s.queued[0].text, /It was merged\./)
+  assert.equal(s.worktree().prNotice.text, 'Merged — prompt queued for Claude')
+  assert.deepEqual(watchTargets(s.projects.all()), [])
+})
+
+test('a gh failure leaves the watch as it was and is logged once while it lasts', async (t) => {
+  const warned = []
+  t.mock.method(console, 'warn', (m) => warned.push(m))
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }), [new Error('HTTP 502'), new Error('HTTP 502'), 'not json'])
+  await s.watcher.ready
+  await s.watcher.poll(target)
+  await s.watcher.poll(target)
+  assert.equal(warned.length, 1)
+  await s.watcher.poll(target)
+  assert.equal(warned.length, 2)
+  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa pending', conflict: false } })
+})
+
+test('a watch turned off (or a different PR linked) while gh answered is left alone', async () => {
+  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }))
+  await s.watcher.ready
+  let release
+  const slow = new Promise((r) => (release = r))
+  s.watcher.deps.gh = async () => {
+    await slow
+    return JSON.stringify(view(failing))
+  }
+  const polling = s.watcher.poll(target)
+  s.projects.apply('p1', (d) => delete d.repositories[0].branchData.feature.prWatch)
+  release()
+  await polling
+  assert.deepEqual(s.queued, [])
+  assert.equal(s.worktree().prNotice, undefined)
+})
+
+test('gh not signed in: not available, rounds poll nothing, and it looks again after the recheck interval', async () => {
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project()])
+  let signedIn = false
+  const calls = []
+  let clock = 0
+  const changes = []
+  const watcher = new PrWatcher({
+    projects,
+    sessions: { enqueue() {}, refreshAttention() {} },
+    onAvailability: (a) => changes.push(a),
+    gh: async (args) => {
+      calls.push(args[0])
+      if (args[0] === 'auth' && !signedIn) throw new Error('not logged in')
+      return JSON.stringify(view())
+    },
+    now: () => clock,
+    recheckMs: 600_000,
+    schedule: () => ({ cancel() {} })
+  })
+  await watcher.ready
+  assert.equal(watcher.available(), false)
+  await watcher.round()
+  assert.deepEqual(calls, ['auth'])
+  signedIn = true
+  clock = 600_000
+  await watcher.round()
+  assert.equal(watcher.available(), true)
+  assert.deepEqual(calls, ['auth', 'auth', 'pr'])
+  assert.deepEqual(changes, [true], 'told once, when it changed (not at the first, signed-out answer)')
+  // A failed poll re-checks: signed out again is told too.
+  signedIn = false
+  watcher.deps.gh = async (args) => {
+    calls.push(args[0])
+    throw new Error('HTTP 401')
+  }
+  await watcher.round()
+  assert.deepEqual(changes, [true, false])
+})
+
+test("a notice is the worktree's attention entry, without a session; a load forgets it", () => {
+  const p = project()
+  p.repositories[0].worktrees[1].prNotice = { title: 'PR #12', text: 'Merged — no agent session to send it to', url: URL, at: 5 }
+  p.settings.audioAlerts = true
+  assert.deepEqual(attentionEntries([p], new Map(), () => 9), [
+    {
+      projectId: 'p1',
+      worktreeId: 'w1',
+      sessionId: '',
+      title: 'PR #12',
+      status: 'attention',
+      since: 5,
+      projectName: 'Demo',
+      pullRequest: { text: 'Merged — no agent session to send it to', url: URL },
+      audioAlerts: true
+    }
+  ])
+  assert.equal(resetRuntime(p).repositories[0].worktrees[1].prNotice, undefined)
+  assert.deepEqual(resetRuntime(p).repositories[0].branchData.feature.prWatch, {}, 'the watch itself is saved')
+})
+
+test('welcomeCapabilities lists prWatch only while gh is signed in', () => {
+  assert.equal(welcomeCapabilities(true, false, false).includes('prWatch'), false)
+  assert.deepEqual(welcomeCapabilities(false, true, true).slice(-2), ['prWatch', 'local'])
+})
+
+/** dispatchV2 with what these methods use. */
+function ctxFor(initial, { available = true } = {}) {
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [initial])
+  const polled = []
+  const dismissed = []
+  const prWatch = {
+    available: () => available,
+    pollSoon: (...a) => polled.push(a),
+    dismiss: (projectId, worktreeId) => {
+      dismissed.push(worktreeId)
+      projects.apply(projectId, (d) => delete d.repositories[0].worktrees[1].prNotice, { persist: false })
+    }
+  }
+  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { hub, projects, prWatch, sessions: { refreshAttention() {} } })
+  return { call, projects, polled, dismissed, data: () => projects.require('p1').repositories[0].branchData.feature }
+}
+
+test('branch.setPrWatch: on needs gh and a github.com PR; on twice keeps what it saw; off always works', () => {
+  const c = ctxFor(project({ prWatch: null }))
+  assert.deepEqual(c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }), { ok: true, result: null })
+  assert.deepEqual(c.data(), { pr: URL, prWatch: {} })
+  assert.deepEqual(c.polled, [['p1', 'r1', 'feature']], 'polled at once')
+  c.projects.apply('p1', (d) => (d.repositories[0].branchData.feature.prWatch = { seen: { checks: 'x', conflict: false } }))
+  c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true })
+  assert.deepEqual(c.data().prWatch, { seen: { checks: 'x', conflict: false } })
+  assert.equal(c.polled.length, 1)
+  c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: false })
+  assert.deepEqual(c.data(), { pr: URL })
+
+  const noPr = ctxFor(project({ prWatch: null, pr: null }))
+  assert.equal(noPr.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'BAD_REQUEST')
+  const odd = ctxFor(project({ prWatch: null, pr: 'https://example.com/pr/1' }))
+  assert.match(odd.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.message, /not a GitHub pull request URL/)
+  const signedOut = ctxFor(project(), { available: false })
+  assert.equal(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'TOOL_ERROR')
+  assert.deepEqual(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: false }), { ok: true, result: null })
+  assert.equal(c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: 'yes' }).error.code, 'BAD_REQUEST')
+})
+
+test('branch.setPr: a different PR, or none, ends the watch; the same one keeps it', () => {
+  const c = ctxFor(project())
+  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: URL })
+  assert.deepEqual(c.data(), { pr: URL, prWatch: {} })
+  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: 'https://github.com/acme/app/pull/13' })
+  assert.deepEqual(c.data(), { pr: 'https://github.com/acme/app/pull/13' })
+  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: null })
+  assert.equal(c.data(), undefined)
+})
+
+test('prWatch.dismiss clears the notice; an unknown worktree is NOT_FOUND', () => {
+  const p = project()
+  p.repositories[0].worktrees[1].prNotice = { title: 'PR #12', text: 'x', url: URL, at: 1 }
+  const c = ctxFor(p)
+  assert.deepEqual(c.call('prWatch.dismiss', { worktreeId: 'w1' }), { ok: true, result: null })
+  assert.deepEqual(c.dismissed, ['w1'])
+  assert.equal(c.projects.require('p1').repositories[0].worktrees[1].prNotice, undefined)
+  assert.equal(c.call('prWatch.dismiss', { worktreeId: 'nope' }).error.code, 'NOT_FOUND')
+})
diff --git a/scripts/smokeGh.mjs b/scripts/smokeGh.mjs
new file mode 100644
index 0000000..9a03fac
--- /dev/null
+++ b/scripts/smokeGh.mjs
@@ -0,0 +1,14 @@
+// scripts/smokeGh.mjs — no smoke runs the real gh (phase 5c-1). Imported first by every smoke that
+// starts a trek-server, directly or through the app's Local server: it points TREK_SERVER_GH at a
+// stub that answers every call "not signed in", so the server's sign-in check reaches nothing and
+// its welcome has no prWatch. Children inherit it through process.env, and main's childEnv keeps it
+// for the Local server. smoke:server-prwatch sets its own stub for its server instead.
+import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+
+const dir = mkdtempSync(join(tmpdir(), 'trek-smoke-gh-'))
+const stub = join(dir, 'gh')
+writeFileSync(stub, "#!/bin/sh\necho 'You are not logged into any GitHub hosts. (a smoke stub)' >&2\nexit 1\n", { mode: 0o755 })
+process.env.TREK_SERVER_GH = stub
+process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 048c3c0..7717720 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -64,6 +64,7 @@
 // patches by shadowing its webContents.send. Any may need updating on an Electron upgrade; the
 // first falls back to the view alone, the others fail the run with a message.
 // Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { spawn, execFileSync } from 'node:child_process'
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
@@ -562,6 +563,8 @@ try {
   const sdk = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: 'v2-smoke' })
   sdk.connect()
   check('the SDK connects', await until(() => sdk.status, 'connected'), 'connected')
+  // smokeGh.mjs's stub answers "not signed in": the server never asked the real gh (5c-1).
+  check("the server's gh is the smoke's stub: no prWatch", sdk.welcome?.capabilities.includes('prWatch'), false)
   const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${target.projectId}` })
   const alpha = snapshot.repositories.find((r) => r.name === 'Alpha')
   check('project.create used the canonical repo path', snapshot.repositories.map((r) => r.path), [repoA, repoB])
diff --git a/scripts/windows-smoke.mjs b/scripts/windows-smoke.mjs
index 7c33598..3289bf1 100644
--- a/scripts/windows-smoke.mjs
+++ b/scripts/windows-smoke.mjs
@@ -24,6 +24,7 @@
 //   - no error dialogs (main's dialogs are stubbed), no console or page errors.
 //
 // Prints WINDOWS SMOKE PASS (n checks) or WINDOWS SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
 import { _electron as electron } from 'playwright-core'
 import { execFileSync } from 'node:child_process'
 import { createServer } from 'node:http'
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index b3da20a..7bb2da0 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -3,6 +3,7 @@
 // (create, branch note, persist, delete), sessions and their ptys, revs in responses,
 // decisions, server.agents, the trek-dev MCP, the topic end of a deleted project and
 // an auth-rejection check.
+import '../../scripts/smokeGh.mjs'
 import { spawn, execFileSync } from 'node:child_process'
 import { request as httpRequest } from 'node:http'
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 7030083..8f64e89 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -20,7 +20,15 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.skills
 ]
 
-/** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
-export function welcomeCapabilities(mcp: boolean, local = false): string[] {
-  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES, ...(local ? [CAPABILITY.local] : [])]
+/**
+ * `mcp` while the MCP listener is up, then the features this server always has, then `prWatch`
+ * while gh is signed in on its machine (5c-1), then `local` on the local server.
+ */
+export function welcomeCapabilities(mcp: boolean, local = false, prWatch = false): string[] {
+  return [
+    ...(mcp ? [CAPABILITY.mcp] : []),
+    ...STATIC_CAPABILITIES,
+    ...(prWatch ? [CAPABILITY.prWatch] : []),
+    ...(local ? [CAPABILITY.local] : [])
+  ]
 }
diff --git a/server/src/index.ts b/server/src/index.ts
index 35371ab..24c4b86 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -22,6 +22,8 @@ import { createMachine } from './integrations/machine'
 import { createIntegrations, testEndpoint, VOICE_CONFIG_FILE } from './integrations/integrations'
 import { secretsPathFor } from './secrets'
 import { seedEnvironmentsFromApp } from './integrations/envSeed'
+import { ghBinary, ghRunner } from './prWatch/gh'
+import { pollMsFromEnv } from './prWatch/watcher'
 import {
   addToken,
   DEFAULT_TOKEN_NAME,
@@ -459,7 +461,13 @@ const server = startServer(
       linearEndpoint: testEndpoint('TREK_SERVER_LINEAR_URL', process.env.TREK_SERVER_LINEAR_URL),
       voiceConfigFile: resolve(serverDataDir, VOICE_CONFIG_FILE),
       elevenLabsApi: testEndpoint('TREK_SERVER_ELEVENLABS_URL', process.env.TREK_SERVER_ELEVENLABS_URL)
-    })
+    }),
+    prWatch: {
+      gh: ghRunner(ghBinary(process.env.TREK_SERVER_GH)),
+      // The smokes' knob: the time between polls, and between sign-in checks while gh is signed out.
+      pollMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS),
+      recheckMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS)
+    }
   }
 )
 store.watch()
diff --git a/server/src/prWatch/gh.ts b/server/src/prWatch/gh.ts
new file mode 100644
index 0000000..3fdc15d
--- /dev/null
+++ b/server/src/prWatch/gh.ts
@@ -0,0 +1,53 @@
+// The GitHub CLI on the server's machine, for the pull request watch (phase 5c-1). gh uses its own
+// sign-in (`gh auth login` as the server's user); the server never holds a GitHub token. Tests hand
+// the watcher a fake runner; every smoke points TREK_SERVER_GH at a stub (scripts/smokeGh.mjs).
+import { execFile } from 'node:child_process'
+import { isAbsolute } from 'node:path'
+
+/** Runs `gh <args>`, resolving with its stdout; rejects on a non-zero exit, a timeout or no gh. */
+export type GhRunner = (args: string[]) => Promise<string>
+
+const GH_TIMEOUT_MS = 30_000
+/** A PR's reviews and comments can be long; past this the call fails rather than buffer more */
+const GH_MAX_OUTPUT = 8 * 1024 * 1024
+
+/**
+ * The gh executable: `TREK_SERVER_GH` from the server's environment when it is an absolute path
+ * (the smokes point it at a stub, so no smoke runs the real gh), else `gh` on the PATH.
+ */
+export function ghBinary(value: string | undefined): string {
+  return value !== undefined && isAbsolute(value) ? value : 'gh'
+}
+
+/** A runner for `binary`. */
+export const ghRunner = (binary: string): GhRunner => (args) =>
+  new Promise((resolve, reject) => {
+    execFile(
+      binary,
+      args,
+      {
+        timeout: GH_TIMEOUT_MS,
+        maxBuffer: GH_MAX_OUTPUT,
+        // Never a prompt, a pager or an update check: the server has no terminal for them.
+        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
+      },
+      (err, stdout, stderr) => {
+        if (err) {
+          const detail = String(stderr).trim().split('\n')[0] || err.message
+          reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed on the server' : detail))
+          return
+        }
+        resolve(String(stdout))
+      }
+    )
+  })
+
+/** `gh auth status` succeeds: gh is installed and signed in to github.com. */
+export async function ghSignedIn(run: GhRunner): Promise<boolean> {
+  try {
+    await run(['auth', 'status', '--hostname', 'github.com'])
+    return true
+  } catch {
+    return false
+  }
+}
diff --git a/server/src/prWatch/prWatchHandlers.ts b/server/src/prWatch/prWatchHandlers.ts
new file mode 100644
index 0000000..f918c31
--- /dev/null
+++ b/server/src/prWatch/prWatchHandlers.ts
@@ -0,0 +1,50 @@
+// The pull request watch's v2 methods (phase 5c-1): turning a branch's watch on or off, and
+// dismissing a worktree's notice. The `prWatch` capability says gh is signed in on the server.
+import type { BranchData } from '../../../src/shared/model/types'
+import { watchableUrl } from '../../../src/shared/prWatch.ts'
+import { codedError } from '../errors.ts'
+import { repoIn } from '../projects/model.ts'
+import { requireBoolean, requireBranch, requireString } from '../validate.ts'
+import type { V2Context } from '../v2.ts'
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const NOT_SIGNED_IN = 'gh is not installed or not signed in on the Trek server’s machine (run `gh auth login` there as the server’s user)'
+
+export const prWatchHandlers: Record<string, Handler> = {
+  /**
+   * On: the branch's linked PR must be a github.com pull URL, and gh signed in. Already on, it
+   * stays as it is (its `seen` kept). Off works whatever gh says.
+   */
+  'branch.setPrWatch': (p, ctx) => {
+    const branch = requireBranch(p.branch)
+    const watch = requireBoolean(p.watch, 'watch')
+    if (watch && !ctx.prWatch?.available()) throw codedError('TOOL_ERROR', NOT_SIGNED_IN)
+    const { repoId, changed } = ctx.projects.apply(p.projectId, (d) => {
+      const repo = repoIn(d, p.repoId)
+      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
+      const changed = watch !== (data.prWatch !== undefined)
+      if (watch) {
+        if (!data.pr) throw codedError('BAD_REQUEST', `${branch} has no linked pull request`)
+        if (!watchableUrl(data.pr)) throw codedError('BAD_REQUEST', `${data.pr} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`)
+        data.prWatch ??= {}
+      } else delete data.prWatch
+      if (Object.keys(data).length === 0) delete repo.branchData[branch]
+      else repo.branchData[branch] = data
+      return { repoId: repo.id, changed }
+    })
+    if (watch && changed) ctx.prWatch?.pollSoon(requireString(p.projectId, 'projectId'), repoId, branch)
+    return null
+  },
+
+  'prWatch.dismiss': (p, ctx) => {
+    const worktreeId = requireString(p.worktreeId, 'worktreeId')
+    const project = ctx.projects.require(p.projectId)
+    if (!project.repositories.some((r) => r.worktrees.some((w) => w.id === worktreeId))) {
+      throw codedError('NOT_FOUND', `No worktree with id "${worktreeId}" in this project`)
+    }
+    if (!ctx.prWatch) return null
+    ctx.prWatch.dismiss(project.id, worktreeId)
+    return null
+  }
+}
diff --git a/server/src/prWatch/watcher.ts b/server/src/prWatch/watcher.ts
new file mode 100644
index 0000000..187ad44
--- /dev/null
+++ b/server/src/prWatch/watcher.ts
@@ -0,0 +1,277 @@
+// The pull request watch (phase 5c-1): every few minutes the server asks gh about each watched
+// branch's linked PR, compares it with the last poll (src/shared/prWatch.ts) and reports what changed:
+// a prompt queued on the worktree's newest agent session, and a notice on the worktree that the
+// `attention` topic lists. Nothing starts a session. A watch is the branch's `prWatch` field: it
+// is saved with the project, so it survives a restart, and its `seen` keeps a restart from reporting
+// anything twice. Merged or closed is reported, then the watch turns itself off.
+import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
+import {
+  PR_VIEW_FIELDS,
+  noticeText,
+  parsePrView,
+  promptText,
+  watchStep,
+  watchableUrl,
+  type PrEvent,
+  type PromptOutcome
+} from '../../../src/shared/prWatch.ts'
+import type { ProjectState } from '../projects/state.ts'
+import { MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
+import { ghSignedIn, type GhRunner } from './gh.ts'
+
+/** Between rounds of polls */
+export const PR_POLL_MS = 3 * 60_000
+/** How often a server whose gh is not signed in looks again */
+export const GH_RECHECK_MS = 10 * 60_000
+/** `ready` waits at most this long for the first check: a slow gh never holds up the server's start */
+export const GH_READY_MS = 3000
+
+/**
+ * `TREK_SERVER_PR_POLL_MS` from the server's environment, for the smokes: a whole number of
+ * milliseconds, at least 1000. Anything else (or none) is the default.
+ */
+export function pollMsFromEnv(value: string | undefined): number | undefined {
+  if (value === undefined || !/^\d+$/.test(value)) return undefined
+  const ms = Number(value)
+  return ms >= 1000 ? ms : undefined
+}
+
+export interface ScheduledJob {
+  cancel(): void
+}
+
+export interface PrWatcherDeps {
+  projects: ProjectState
+  /** The SessionManager's: queues a prompt (throws when the queue is full), and republishes `attention` */
+  sessions: {
+    enqueue(p: { projectId: string; sessionId: string; text: string }): unknown
+    refreshAttention(): void
+  }
+  gh: GhRunner
+  /** gh's sign-in changed: the server tells every connection (`integrations.changed` `{prWatch}`) */
+  onAvailability?: (available: boolean) => void
+  pollMs?: number
+  recheckMs?: number
+  now?: () => number
+  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
+}
+
+/** One watched branch, as a round found it. */
+interface Target {
+  projectId: string
+  repoId: string
+  branch: string
+  url: string
+  number: number
+}
+
+const keyOf = (t: { projectId: string; repoId: string; branch: string }): string => JSON.stringify([t.projectId, t.repoId, t.branch])
+
+/** The worktree that has `branch` checked out (and is still on disk). */
+function worktreeOn(repo: Repository, branch: string): Worktree | undefined {
+  return repo.worktrees.find((w) => w.branch === branch && !w.missing)
+}
+
+/** Every watched branch checked out in a worktree, with a URL gh may be given. */
+export function watchTargets(projects: Iterable<Project>): Target[] {
+  const out: Target[] = []
+  for (const project of projects) {
+    for (const repo of project.repositories) {
+      for (const [branch, data] of Object.entries(repo.branchData)) {
+        if (!data.prWatch || !worktreeOn(repo, branch)) continue
+        const pr = watchableUrl(data.pr)
+        if (pr) out.push({ projectId: project.id, repoId: repo.id, branch, url: pr.url, number: pr.number })
+      }
+    }
+  }
+  return out
+}
+
+export class PrWatcher {
+  private readonly deps: PrWatcherDeps
+  private readonly now: () => number
+  private readonly schedule: NonNullable<PrWatcherDeps['schedule']>
+  private signedIn = false
+  private lastCheck = -Infinity
+  private job: ScheduledJob | undefined
+  private stopped = false
+  /** Branches being polled now: a poll asked for meanwhile is skipped */
+  private readonly inFlight = new Set<string>()
+  /** The last failure logged per branch, so a lasting one is logged once */
+  private readonly lastError = new Map<string, string>()
+  /** Settles once the first `gh auth status` has answered, or after GH_READY_MS; never rejects */
+  readonly ready: Promise<void>
+  private readonly firstCheck: Promise<boolean>
+
+  constructor(deps: PrWatcherDeps) {
+    this.deps = deps
+    this.now = deps.now ?? Date.now
+    this.schedule =
+      deps.schedule ??
+      ((fn, ms) => {
+        const timer = setTimeout(() => void fn(), ms)
+        timer.unref()
+        return { cancel: () => clearTimeout(timer) }
+      })
+    this.firstCheck = this.checkSignIn()
+    this.ready = Promise.race([
+      this.firstCheck.then(() => undefined),
+      new Promise<void>((resolve) => setTimeout(resolve, GH_READY_MS).unref())
+    ])
+  }
+
+  /** gh is installed and signed in (as of the last check): the welcome lists `prWatch` */
+  available(): boolean {
+    return this.signedIn
+  }
+
+  start(): void {
+    void this.firstCheck.then(() => this.next())
+  }
+
+  stop(): void {
+    this.stopped = true
+    this.job?.cancel()
+  }
+
+  /** A watch was turned on (or its PR changed): poll it now rather than at the next round. */
+  pollSoon(projectId: string, repoId: string, branch: string): void {
+    const target = watchTargets([this.deps.projects.require(projectId)]).find((t) => t.repoId === repoId && t.branch === branch)
+    if (target && this.signedIn) void this.poll(target)
+  }
+
+  /** Clears a worktree's notice (`prWatch.dismiss`). */
+  dismiss(projectId: unknown, worktreeId: string): void {
+    this.deps.projects.apply(
+      projectId,
+      (d) => {
+        for (const r of d.repositories) for (const w of r.worktrees) if (w.id === worktreeId) delete w.prNotice
+      },
+      { persist: false }
+    )
+    this.deps.sessions.refreshAttention()
+  }
+
+  private async checkSignIn(): Promise<boolean> {
+    this.lastCheck = this.now()
+    const was = this.signedIn
+    this.signedIn = await ghSignedIn(this.deps.gh)
+    if (this.signedIn !== was) {
+      this.deps.onAvailability?.(this.signedIn)
+      console.log(this.signedIn ? '[prWatch] gh is signed in: pull requests can be watched' : '[prWatch] gh is not installed or not signed in: pull requests are not watched')
+    }
+    return this.signedIn
+  }
+
+  private next(): void {
+    if (this.stopped) return
+    this.job = this.schedule(() => this.round(), this.deps.pollMs ?? PR_POLL_MS)
+  }
+
+  /** One round: every watched branch, one at a time. */
+  async round(): Promise<void> {
+    try {
+      if (!this.signedIn && this.now() - this.lastCheck >= (this.deps.recheckMs ?? GH_RECHECK_MS)) await this.checkSignIn()
+      if (!this.signedIn) return
+      for (const target of watchTargets(this.deps.projects.all())) {
+        if (this.stopped) return
+        await this.poll(target)
+      }
+    } catch (err) {
+      console.warn(`[prWatch] a round failed: ${(err as Error).message}`)
+    } finally {
+      this.next()
+    }
+  }
+
+  /** Asks gh about one PR and applies what changed; a failure is logged (once while it lasts) and the watch stays. */
+  async poll(target: Target): Promise<void> {
+    const key = keyOf(target)
+    if (this.inFlight.has(key)) return
+    this.inFlight.add(key)
+    try {
+      let stdout: string
+      try {
+        stdout = await this.deps.gh(['pr', 'view', target.url, '--json', PR_VIEW_FIELDS])
+      } catch (err) {
+        this.logOnce(key, `gh pr view ${target.url}: ${(err as Error).message}`)
+        // Signed out meanwhile: stop asking until the next check finds it signed in.
+        await this.checkSignIn()
+        return
+      }
+      let view
+      try {
+        view = parsePrView(JSON.parse(stdout))
+      } catch (err) {
+        this.logOnce(key, `gh pr view ${target.url}: ${(err as Error).message}`)
+        return
+      }
+      this.lastError.delete(key)
+      if (this.stopped) return
+      this.apply(target, view)
+    } finally {
+      this.inFlight.delete(key)
+    }
+  }
+
+  private logOnce(key: string, message: string): void {
+    if (this.lastError.get(key) === message) return
+    this.lastError.set(key, message)
+    console.warn(`[prWatch] ${message}`)
+  }
+
+  /** Re-reads the branch after the await: a watch turned off, or a PR changed, meanwhile is left alone. */
+  private apply(target: Target, view: ReturnType<typeof parsePrView>): void {
+    let events: PrEvent[] = []
+    try {
+      events = this.deps.projects.apply(target.projectId, (d) => {
+        const repo = d.repositories.find((r) => r.id === target.repoId)
+        const data = repo && Object.hasOwn(repo.branchData, target.branch) ? repo.branchData[target.branch] : undefined
+        if (!repo || !data?.prWatch || data.pr !== target.url) return []
+        const step = watchStep(data.prWatch.seen, view)
+        if (step.stop) delete data.prWatch
+        else data.prWatch = { seen: step.seen }
+        return step.events
+      })
+    } catch {
+      return // the project is gone
+    }
+    if (events.length > 0) this.report(target, events)
+  }
+
+  /** Queues the prompt on the worktree's newest session, if any, and sets the worktree's notice. */
+  private report(target: Target, events: PrEvent[]): void {
+    const project = this.deps.projects.require(target.projectId)
+    const repo = project.repositories.find((r) => r.id === target.repoId)
+    const worktree = repo && worktreeOn(repo, target.branch)
+    if (!worktree) return
+    // Sessions are kept in the order they were started; every v2 session runs an agent.
+    const session = worktree.sessions.at(-1)
+    let outcome: PromptOutcome = 'noSession'
+    if (session) {
+      if (session.queue.length >= MAX_QUEUE_LENGTH) outcome = 'queueFull'
+      else {
+        try {
+          this.deps.sessions.enqueue({ projectId: target.projectId, sessionId: session.id, text: promptText(target.url, target.number, events) })
+          outcome = { queuedFor: session.title }
+        } catch (err) {
+          console.warn(`[prWatch] could not queue the prompt for ${target.url}: ${(err as Error).message}`)
+          outcome = 'queueFull'
+        }
+      }
+    }
+    const notice = { title: `PR #${target.number}`, text: noticeText(events, outcome), url: target.url, at: this.now() }
+    try {
+      this.deps.projects.apply(
+        target.projectId,
+        (d) => {
+          for (const r of d.repositories) for (const w of r.worktrees) if (w.id === worktree.id) w.prNotice = notice
+        },
+        { persist: false }
+      )
+    } catch {
+      return
+    }
+    this.deps.sessions.refreshAttention()
+  }
+}
diff --git a/server/src/projects/model.ts b/server/src/projects/model.ts
index b4c8df7..ec7a4ba 100644
--- a/server/src/projects/model.ts
+++ b/server/src/projects/model.ts
@@ -46,7 +46,7 @@ function resetSession(s: Session): Session {
 }
 
 function resetWorktree(w: Worktree): Worktree {
-  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, ...rest } = w
+  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, prNotice: _n, ...rest } = w
   return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
 }
 
diff --git a/server/src/server.ts b/server/src/server.ts
index 4739212..18053c7 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -30,6 +30,8 @@ import { createToolCaller, type ToolCall, MCP_INSTRUCTIONS, MCP_TOOLS } from './
 import { createEventSink, type Machine } from './integrations/machineHandlers'
 import { VOICE_SUMMARY_PROMPT } from '../../src/shared/providers/prompts.ts'
 import type { Integrations } from './integrations/integrations'
+import type { GhRunner } from './prWatch/gh'
+import { PrWatcher } from './prWatch/watcher'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -63,6 +65,8 @@ export interface ServerOptions {
   machine?: Machine
   /** Linear and ElevenLabs with the server's own keys (its secrets file), and the skills on its disk (integrations.ts) */
   integrations?: Integrations
+  /** The pull request watch (5c-1): gh on this machine, and how often it polls; without it no PR is watched */
+  prWatch?: { gh: GhRunner; pollMs?: number; recheckMs?: number }
 }
 
 export interface ProjectsSetup {
@@ -105,6 +109,20 @@ export function startServer(
     voicePrompt: () => (options.integrations?.voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined)
   })
 
+  // Set once the connections exist (below): gh's first answer comes after this function returns.
+  let prWatchChanged = (_available: boolean): void => {}
+  const prWatch = options.prWatch
+    ? new PrWatcher({
+        projects,
+        sessions,
+        gh: options.prWatch.gh,
+        pollMs: options.prWatch.pollMs,
+        recheckMs: options.prWatch.recheckMs,
+        onAvailability: (available) => prWatchChanged(available)
+      })
+    : undefined
+  prWatch?.start()
+
   /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
   const authed = new Map<WebSocket, string>()
   /** Revoked sockets that have not finished closing yet; terminated if the close handshake stalls. */
@@ -131,6 +149,8 @@ export function startServer(
   const integrationsChanged = (parts: IntegrationsChangedEvent): void => {
     for (const ws of authed.keys()) sendFrame(ws, { type: 'event', event: 'integrations.changed', payload: parts })
   }
+  // An open window shows or hides the PR watch without reconnecting (5c-1).
+  prWatchChanged = (available) => integrationsChanged({ prWatch: available })
   const serverState = publishServerState(store, hub, daemonVersion, {
     projects: () => projects.list(),
     health: () => [...projectsSetup.store.health(), ...poller.health()]
@@ -267,7 +287,7 @@ export function startServer(
           daemonVersion,
           serverId: store.config.serverId ?? '',
           serverName: store.config.name ?? '',
-          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true)
+          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true, prWatch?.available() === true)
         })
         return
       }
@@ -291,6 +311,7 @@ export function startServer(
         machine: options.machine,
         integrations: options.integrations,
         integrationsChanged,
+        prWatch,
         mcpAccess: access
           ? {
               revoke: (id) => {
@@ -339,7 +360,8 @@ export function startServer(
     projects,
     poller,
     sessions,
-    ready: Promise.resolve(),
+    // The first gh check too, so the local server's first welcome lists `prWatch` if it has it.
+    ready: prWatch ? prWatch.ready : Promise.resolve(),
     shutdown: (reason) => shutdown(reason)
   }
   if (access) {
@@ -349,6 +371,7 @@ export function startServer(
       if (!call) callers.set(projectId, (call = caller(projectId)))
       return call
     }
+    const prWatchReady = trek.ready
     trek.ready = startMcpListener({
       access,
       serverVersion: daemonVersion,
@@ -364,6 +387,7 @@ export function startServer(
       },
       (err: unknown) => console.warn(`[mcp] disabled: the listener did not start: ${(err as Error).message}`)
     )
+    trek.ready = Promise.all([prWatchReady, trek.ready]).then(() => undefined)
   }
 
   const shutdown = (reason: string): void => {
@@ -371,6 +395,7 @@ export function startServer(
     void trek.mcp?.close()
     trek.mcp = undefined
     poller.stop()
+    prWatch?.stop()
     sessions.stopAll()
     store.off('change', onConfigChange)
     serverState.stop()
diff --git a/server/src/sessions/status.ts b/server/src/sessions/status.ts
index c025bec..83a80fa 100644
--- a/server/src/sessions/status.ts
+++ b/server/src/sessions/status.ts
@@ -73,7 +73,8 @@ export function isTerminalReply(data: string): boolean {
 }
 
 /**
- * The `attention` topic's entries: sessions in attention or done, or with an open decision, oldest first.
+ * The `attention` topic's entries: sessions in attention or done, or with an open decision, and
+ * worktrees with a pull request notice (5c-1), oldest first.
  * A flagged session with no `since` yet gets now, stored into `since` so it stays the same on the next publish.
  */
 export function attentionEntries(
@@ -107,7 +108,27 @@ export function attentionEntries(
       entries.push(entry)
     }
     for (const s of project.globalSessions) add(null, s)
-    for (const r of project.repositories) for (const w of r.worktrees) for (const s of w.sessions) add(w.id, s)
+    for (const r of project.repositories) {
+      for (const w of r.worktrees) {
+        for (const s of w.sessions) add(w.id, s)
+        // A watched pull request's notice (5c-1): the worktree's entry, with no session.
+        if (w.prNotice) {
+          const n = w.prNotice
+          const entry: AttentionEntry = {
+            projectId: project.id,
+            worktreeId: w.id,
+            sessionId: '',
+            title: n.title,
+            status: 'attention',
+            since: n.at,
+            projectName: project.name,
+            pullRequest: { text: n.text, url: n.url }
+          }
+          if (project.settings.audioAlerts === true) entry.audioAlerts = true
+          entries.push(entry)
+        }
+      }
+    }
   }
   return entries.sort((a, b) => a.since - b.since)
 }
diff --git a/server/src/v2.ts b/server/src/v2.ts
index d382680..a5015c0 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -1,7 +1,8 @@
 // Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
 // projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
 // the v2 pty.* stream, docker, env and stack on the server's machine (machineHandlers.ts), and
-// Linear, voice and skills with the server's own keys and disk (integrationHandlers.ts).
+// Linear, voice and skills with the server's own keys and disk (integrationHandlers.ts), and the
+// pull request watch (prWatchHandlers.ts).
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { IntegrationsChangedEvent, TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -14,6 +15,8 @@ import { worktreeHandlers } from './worktreeHandlers.ts'
 import { sessionHandlers } from './sessionHandlers.ts'
 import { machineHandlers, type EventSink, type Machine } from './integrations/machineHandlers.ts'
 import { integrationHandlers } from './integrations/integrationHandlers.ts'
+import { prWatchHandlers } from './prWatch/prWatchHandlers.ts'
+import type { PrWatcher } from './prWatch/watcher.ts'
 import type { Integrations } from './integrations/integrations.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
 import { checkImport } from './projects/importCheck.ts'
@@ -57,6 +60,8 @@ export interface V2Context {
   integrations?: Integrations
   /** Tells every authenticated connection the keys or voice settings changed (`integrations.changed`) */
   integrationsChanged?: (parts: IntegrationsChangedEvent) => void
+  /** The pull request watch (5c-1): gh on this machine; without it no PR is watched */
+  prWatch?: PrWatcher
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
@@ -245,7 +250,21 @@ const handlers: Record<string, Handler> = {
   },
   'branch.setNote': (p, ctx) => setBranchField(ctx, p, 'note', clearableString(p.note, 'note'), p.expected),
   'branch.setTicket': (p, ctx) => setBranchField(ctx, p, 'ticket', clearableString(p.ticket, 'ticket')),
-  'branch.setPr': (p, ctx) => setBranchField(ctx, p, 'pr', clearableString(p.pr, 'pr')),
+  // A different PR (or none) ends the branch's watch: it watched the old one (5c-1).
+  'branch.setPr': (p, ctx) => {
+    const pr = clearableString(p.pr, 'pr')
+    const branch = requireBranch(p.branch)
+    ctx.projects.apply(p.projectId, (d) => {
+      const repo = repoIn(d, p.repoId)
+      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
+      if (pr === null) delete data.pr
+      else data.pr = pr
+      if (data.prWatch && repo.branchData[branch]?.pr !== pr) delete data.prWatch
+      if (Object.keys(data).length === 0) delete repo.branchData[branch]
+      else repo.branchData[branch] = data
+    })
+    return null
+  },
   'branch.setEnv': (p, ctx) => setBranchField(ctx, p, 'env', clearableString(p.env, 'env'), p.expected),
 
   'sub.subscribe': (p, ctx) => {
@@ -277,7 +296,8 @@ const handlers: Record<string, Handler> = {
   ...worktreeHandlers,
   ...sessionHandlers,
   ...machineHandlers,
-  ...integrationHandlers
+  ...integrationHandlers,
+  ...prWatchHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/src/main/localServerRules.ts b/src/main/localServerRules.ts
index 4385812..e9d1492 100644
--- a/src/main/localServerRules.ts
+++ b/src/main/localServerRules.ts
@@ -220,8 +220,11 @@ export function skewOf(bundled: BundledBuild | undefined, running: Pick<LocalInf
  * and `NPM_TOKEN` are kept.
  */
 const DROPPED_PREFIXES = ['ELECTRON_', 'TREK_', 'npm_']
-/** Kept despite their prefix: the server's test endpoints for Linear and ElevenLabs (the smokes' stubs; the server takes them only on loopback). */
-const KEPT = new Set(['TREK_SERVER_LINEAR_URL', 'TREK_SERVER_ELEVENLABS_URL'])
+/**
+ * Kept despite their prefix: the server's test endpoints for Linear and ElevenLabs (the smokes' stubs;
+ * the server takes them only on loopback), and its gh (the smokes' stub, scripts/smokeGh.mjs).
+ */
+const KEPT = new Set(['TREK_SERVER_LINEAR_URL', 'TREK_SERVER_ELEVENLABS_URL', 'TREK_SERVER_GH'])
 const DROPPED = new Set([
   'NODE_OPTIONS',
   'NODE_PATH',
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 4b7aa4d..1ea1fcf 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -189,7 +189,13 @@ export const CAPABILITY = {
    */
   voice: 'voice',
   /** `skills.list` lists a worktree's Claude Code skills and commands on the server's disk */
-  skills: 'skills'
+  skills: 'skills',
+  /**
+   * gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's
+   * pull request watch on (5c-1). Checked at start and again while it is missing; a connection sees a
+   * change from its next welcome.
+   */
+  prWatch: 'prWatch'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -294,6 +300,10 @@ export interface MethodParamsV2 {
   'branch.setNote': BranchRef & { note: string | null; expected?: string | null }
   'branch.setTicket': BranchRef & { ticket: string | null }
   'branch.setPr': BranchRef & { pr: string | null }
+  /** Turns the branch's pull request watch on or off (5c-1); on needs `prWatch` and a linked github.com PR */
+  'branch.setPrWatch': BranchRef & { watch: boolean }
+  /** Clears the worktree's pull request notice */
+  'prWatch.dismiss': WorktreeRef
   'branch.setEnv': BranchRef & { env: string | null; expected?: string | null }
   // Sessions
   /** `worktreeId: null` starts a Global panel session */
@@ -461,6 +471,8 @@ export interface MethodResultsV2 {
   'branch.setNote': null
   'branch.setTicket': null
   'branch.setPr': null
+  'branch.setPrWatch': null
+  'prWatch.dismiss': null
   'branch.setEnv': null
   'session.start': { sessionId: string; ptyId: string }
   'session.restart': { ptyId: string }
@@ -570,6 +582,11 @@ export interface EventPayloadsV2 {
 export interface IntegrationsChangedEvent {
   linear?: true
   voice?: true
+  /**
+   * gh's sign-in on the server's machine changed (5c-1): the `prWatch` capability is now listed
+   * (true) or not (false). The client SDK applies it to `welcome.capabilities`.
+   */
+  prWatch?: boolean
 }
 
 export interface VoiceSummaryEvent {
`````

- [ ] **Step 2: Verify:**
  - `node --test scripts/serverPrWatch.test.mjs` passes 16 tests;
  - `npm test` passes 1723 (1 skipped);
  - both typechecks are clean;
  - `npm run smoke:v2` checks "the server's gh is the smoke's stub: no prWatch".
- [ ] **Step 3: Commit:** `feat(5c-1): the server's PrWatcher, branch.setPrWatch, prWatch.dismiss, the prWatch capability; every smoke's stub gh`.

### Task 3: `watch_pull_request`

**Files:**
- Modify: `server/src/mcp/tools.ts`, `server/src/mcp/describe.ts`, `server/src/server.ts` (the tool caller gets `prWatch`), `scripts/serverMcpTools.test.mjs`

This brings the MCP server to 28 tools (Decision 15). `list_worktrees` entries gain `watchingPullRequest`.

- [ ] **Step 1: Apply the diff** (the prototype's e2206e1)

`````diff
diff --git a/scripts/serverMcpTools.test.mjs b/scripts/serverMcpTools.test.mjs
index d9865fc..1b72f90 100644
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -38,7 +38,7 @@ const project = {
 test('describeWorktree', () => {
   assert.deepEqual(describeWorktree(project, project.repositories[0], project.repositories[0].worktrees[1]), {
     worktree: 'af', repo: 'A', repoId: 'ra', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
-    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', note: 'n',
+    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', watchingPullRequest: false, note: 'n',
     dirty: true, ahead: 1, behind: 0, loaded: true,
     sessions: [
       { terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'], decision: null },
@@ -113,7 +113,7 @@ test('the tool list matches decision 5', () => {
     'list_session_types', 'list_worktrees', 'load_worktree', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
     'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
     'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
-    'wait_for_sessions'
+    'wait_for_sessions', 'watch_pull_request'
   ])
 })
 
@@ -143,6 +143,27 @@ test('branch data tools: tag by name, custom tag, note, ticket, pull request', a
   assert.equal(s.projects.require(s.projectId).settings.linearWorkspace, 'acme')
 })
 
+test('watch_pull_request: on (polled at once), off, and its refusals', async (t) => {
+  const polled = []
+  let available = true
+  const prWatch = { available: () => available, pollSoon: (...a) => polled.push(a), dismiss() {} }
+  const s = await toolSetup(t, { prWatch })
+  const codeOf = (p) => p.then(() => 'ok', (e) => e.code)
+  assert.match(await s.call('watch_pull_request', { worktree: 'main' }).catch((e) => e.message), /no linked pull request/)
+  await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
+  assert.deepEqual(await s.call('watch_pull_request', { worktree: 'main' }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9', watching: true })
+  assert.equal(polled.length, 1)
+  assert.equal((await s.call('list_worktrees', {}))[0].watchingPullRequest, true)
+  assert.deepEqual(await s.call('watch_pull_request', { worktree: 'main', watch: false }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9', watching: false })
+  assert.equal((await s.call('list_worktrees', {}))[0].watchingPullRequest, false)
+  assert.equal(await codeOf(s.call('watch_pull_request', { worktree: 'main', watch: 'yes' })), 'BAD_REQUEST')
+  available = false
+  assert.equal(await codeOf(s.call('watch_pull_request', { worktree: 'main' })), 'TOOL_ERROR')
+  const bare = await toolSetup(t)
+  await bare.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
+  assert.match(await bare.call('watch_pull_request', { worktree: 'main' }).catch((e) => e.message), /gh is not installed or not signed in/)
+})
+
 test('session types: list, save (create and update by name), delete', async (t) => {
   const s = await toolSetup(t)
   assert.deepEqual(await s.call('list_session_types', {}), [])
diff --git a/server/src/mcp/describe.ts b/server/src/mcp/describe.ts
index 7439f83..5bb8001 100644
--- a/server/src/mcp/describe.ts
+++ b/server/src/mcp/describe.ts
@@ -20,6 +20,7 @@ export function describeWorktree(project: Project, repo: Repository, w: Worktree
     customTags: (data.customTags ?? []).map(customName),
     ticket: data.ticket,
     pullRequest: data.pr,
+    watchingPullRequest: data.prWatch !== undefined,
     note: data.note,
     dirty: w.dirty,
     ahead: w.ahead,
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index f64376e..ee53f02 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -28,6 +28,7 @@ import type { Machine } from '../integrations/machineHandlers.ts'
 import { stackState, stackUrls, stripAnsi } from '../../../src/shared/stacks.ts'
 import type { StackStatus } from '../../../src/shared/types'
 import { MAX_INITIAL_LOG } from '../../../src/host/stackService.ts'
+import type { PrWatcher } from '../prWatch/watcher.ts'
 
 const WORKTREE_PARAM = {
   type: 'string',
@@ -351,11 +352,24 @@ export const MCP_TOOLS: ToolDefinition[] = [
       properties: { worktree: WORKTREE_PARAM, pullRequest: { type: 'string' } },
       required: ['worktree']
     }
+  },
+  {
+    name: 'watch_pull_request',
+    description:
+      "Watch (or stop watching) a worktree branch's linked GitHub pull request. The Trek server polls it with gh every few minutes; when its checks fail or pass, new reviews or comments arrive, it gets a merge conflict, or it is merged or closed, a prompt saying so is queued on the worktree's newest agent session and the user is notified. The watch ends by itself after merged or closed. Link the PR first with set_worktree_pull_request. Needs gh signed in on the server's machine.",
+    inputSchema: {
+      type: 'object',
+      properties: {
+        worktree: WORKTREE_PARAM,
+        watch: { type: 'boolean', description: 'false stops watching (default true)' }
+      },
+      required: ['worktree']
+    }
   }
 ]
 
 export const MCP_INSTRUCTIONS =
-  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
+  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
 
 export interface ToolDeps {
   store: ConfigStore
@@ -367,6 +381,8 @@ export interface ToolDeps {
   voice?: VoiceService
   /** The dev stacks on the server's machine, for the stack tools; without it they say so */
   machine?: Machine
+  /** The pull request watch, for watch_pull_request; without it the tool says the server does not watch PRs */
+  prWatch?: PrWatcher
   /** How often waits re-check session state (default 250 ms) */
   pollMs?: number
   /** wait_for_sessions waits this long first when its condition already holds (default 1.5 s) */
@@ -503,6 +519,7 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
     poller: deps.poller,
     sessions: deps.sessions,
     machine: deps.machine,
+    prWatch: deps.prWatch,
     // Tool calls subscribe to nothing and attach to no pty.
     subscriber: { send() {} },
     terminal: { send() {}, bufferedAmount: () => 0 }
@@ -775,6 +792,14 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         return { branch, pullRequest: url }
       },
 
+      watch_pull_request: async (args, project) => {
+        const { repo, branch } = branchOf(project, args.worktree)
+        if (args.watch !== undefined && args.watch !== null && typeof args.watch !== 'boolean') throw bad('watch must be a boolean')
+        const watch = args.watch !== false
+        await v2('branch.setPrWatch', { repoId: repo.id, branch, watch })
+        return { branch, pullRequest: branchData(repo, branch).pr ?? null, watching: watch }
+      },
+
       list_session_types: (_args, project) => (project.settings.sessionTypes ?? []).map(withoutIcon),
 
       save_session_type: async (args, project) => {
diff --git a/server/src/server.ts b/server/src/server.ts
index 18053c7..9428921 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -365,7 +365,7 @@ export function startServer(
     shutdown: (reason) => shutdown(reason)
   }
   if (access) {
-    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine })
+    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine, prWatch })
     const callerFor = (projectId: string): ToolCall => {
       let call = callers.get(projectId)
       if (!call) callers.set(projectId, (call = caller(projectId)))
`````

- [ ] **Step 2: Verify:** `node --test scripts/serverMcpTools.test.mjs` passes 41 tests, and `npm test` passes 1724.
- [ ] **Step 3: Commit:** `feat(5c-1): the watch_pull_request MCP tool`.

### Task 4: The app: Watch pull request, the notice, and its notification

**Files:**
- Modify:
  - `src/main/attention.ts`, `src/main/attentionRules.ts`
  - `src/shared/types.ts`
  - `src/renderer/src/{backend,backendFeatures,notificationItems}.ts`, `src/renderer/src/v2/{backendV2,projector}.ts`
  - `src/renderer/src/components/{WorktreeDetail,Sidebar}.tsx`, `src/renderer/src/styles.css`
  - `src/shared/client/connection.ts`, `src/renderer/src/v2/ServerProjectWindow.tsx` (the pushed `prWatch`, Decision 6)
  - `scripts/{mainAttention,mainAttentionRules,attentionMenu,v2Projector,backendFeatures,clientConnection}.test.mjs`

This covers Decisions 6, 16 and 17. The renderer never sees a URL from main's list (only the notice's text), and it never sees the token.

- [ ] **Step 1: Apply the diff** (the prototype's 6921b97)

`````diff
diff --git a/scripts/attentionMenu.test.mjs b/scripts/attentionMenu.test.mjs
index b542a48..437b57a 100644
--- a/scripts/attentionMenu.test.mjs
+++ b/scripts/attentionMenu.test.mjs
@@ -105,3 +105,10 @@ test('labels: Global, no project name, stale, and the status texts', () => {
   assert.equal(menuEntries([], null, [item('s', { stale: true })], () => '')[0].stale, true)
   assert.deepEqual(['attention', 'done', 'idle'].map(statusText), ['Needs your attention', 'Finished', 'idle'])
 })
+
+test("a pull request notice (5c-1) is listed by what changed, as the worktree's, not a decision", () => {
+  const notice = item('', { key: JSON.stringify(['box', 'p1', 'worktree:w1']), title: 'PR #12', since: 400, pullRequest: 'Checks failed — prompt queued for Claude' })
+  assert.deepEqual(menuEntries([], null, [notice], () => ''), [
+    { kind: 'server', id: notice.key, source: 'Demo · Build box · PR #12', text: 'Checks failed — prompt queued for Claude', at: 400, decision: false, stale: false }
+  ])
+})
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index a382e6f..5aef9c9 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -24,7 +24,12 @@ test('an empty window has no feature (4e: no file windows)', () => {
 
 test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+})
+
+test('the pull request watch follows prWatch (5c-1): listed only while gh is signed in on the server', () => {
+  assert.equal(v2Features(['prWatch']).prWatch, true)
+  assert.equal(v2Features(['mcp', 'local', 'linear'], { localEntry: true }).prWatch, false)
 })
 
 test('v2 features are the ceiling AND the welcome capabilities; settings need none', () => {
diff --git a/scripts/clientConnection.test.mjs b/scripts/clientConnection.test.mjs
index b03ae56..924c376 100644
--- a/scripts/clientConnection.test.mjs
+++ b/scripts/clientConnection.test.mjs
@@ -525,3 +525,25 @@ test('error on an open socket waits for its close', () => {
   sock.serverClose(1006, '')
   assert.equal(conn.status, 'disconnected')
 })
+
+test("integrations.changed {prWatch} moves prWatch in the welcome's capabilities, as a new array, before listeners hear it (5c-1)", () => {
+  const { server, conn } = setup()
+  conn.connect()
+  const sock = server.last()
+  sock.open()
+  sock.welcome()
+  const seen = []
+  conn.on('event', () => seen.push(conn.welcome.capabilities))
+  const before = conn.welcome.capabilities
+  sock.event('integrations.changed', { prWatch: true })
+  assert.deepEqual(conn.welcome.capabilities, ['mcp', 'prWatch'])
+  assert.notEqual(conn.welcome.capabilities, before)
+  assert.deepEqual(seen[0], ['mcp', 'prWatch'])
+  sock.event('integrations.changed', { prWatch: true })
+  assert.deepEqual(conn.welcome.capabilities, ['mcp', 'prWatch'], 'listed once')
+  sock.event('integrations.changed', { prWatch: false })
+  assert.deepEqual(conn.welcome.capabilities, ['mcp'])
+  sock.event('integrations.changed', { linear: true })
+  sock.event('integrations.changed', { prWatch: 'yes' })
+  assert.deepEqual(conn.welcome.capabilities, ['mcp'])
+})
diff --git a/scripts/mainAttention.test.mjs b/scripts/mainAttention.test.mjs
index 2d6b27f..2809948 100644
--- a/scripts/mainAttention.test.mjs
+++ b/scripts/mainAttention.test.mjs
@@ -331,3 +331,27 @@ test('find by key; close unsubscribes everything and stops broadcasts', () => {
   attention.linked('box', fakeSource().source)
   assert.equal(changes.length, count)
 })
+
+test("a pull request notice (5c-1) is keyed by its worktree, raised once per report, and carries what changed", () => {
+  const { attention, raised, last } = setup()
+  const box = fakeSource()
+  attention.linked('box', box.source)
+  const notice = (since, text) => entry('', { title: 'PR #12', since, pullRequest: { text, url: 'https://github.com/o/r/pull/12' } })
+  box.snapshot([])
+  box.snapshot([notice(200, 'Checks failed — prompt queued for Claude'), entry('s1', { since: 150 })])
+  assert.deepEqual(raised.map((e) => [e.kind, e.item.key]), [
+    ['pullRequest', attentionKey('box', 'p1', 'worktree:w1')],
+    ['attention', attentionKey('box', 'p1', 's1')]
+  ])
+  assert.equal(last().items[0].pullRequest, 'Checks failed — prompt queued for Claude')
+  assert.equal('url' in last().items[0], false, 'only the text reaches a window')
+  // The same report again: nothing; a new one (its own at): raised again.
+  box.snapshot([notice(200, 'Checks failed — prompt queued for Claude')])
+  assert.equal(raised.length, 2)
+  box.snapshot([notice(300, 'Checks passed — prompt queued for Claude')])
+  assert.equal(raised.at(-1).kind, 'pullRequest')
+  assert.equal(newMoment(notice(300, 'x'), { flagged: 300, decided: null }), null)
+  // A session-less entry without a notice is malformed and skipped.
+  box.snapshot([entry('')])
+  assert.deepEqual(last().items, [])
+})
diff --git a/scripts/mainAttentionRules.test.mjs b/scripts/mainAttentionRules.test.mjs
index f3b1aa4..1ee86d4 100644
--- a/scripts/mainAttentionRules.test.mjs
+++ b/scripts/mainAttentionRules.test.mjs
@@ -71,3 +71,11 @@ test('the app-wide "Show notifications" switch off: nothing is notified, focus o
   }
   assert.equal(wantsAlert([{ audioAlerts: true }]), true, 'the sound does not follow the switch')
 })
+
+test('a pull request notice (5c-1): "PR #12 changed" with what changed; a dismiss clears the notice', () => {
+  const notice = item({ sessionId: '', title: 'PR #12', pullRequest: 'Merged — no agent session to send it to' })
+  assert.deepEqual(notificationText('pullRequest', notice), { title: 'PR #12 changed', body: 'Demo · Build box\nMerged — no agent session to send it to' })
+  assert.deepEqual(dismissRequest(notice), { method: 'prWatch.dismiss', params: { projectId: 'p1', worktreeId: 'w1' } })
+  // No session in view can stand for it: notified even in its own focused window.
+  assert.equal(shouldNotify('pullRequest', notice, { target: here, viewing: ['s1'] }), true)
+})
diff --git a/scripts/v2Projector.test.mjs b/scripts/v2Projector.test.mjs
index bcf47cd..df132d0 100644
--- a/scripts/v2Projector.test.mjs
+++ b/scripts/v2Projector.test.mjs
@@ -179,12 +179,25 @@ test('branch data becomes the six legacy maps; empty values are left out', () =>
   assert.deepEqual(one.branchTickets, { feat: 'TOW-1' })
   assert.deepEqual(one.branchPullRequests, { feat: 'https://github.com/o/r/pull/7' })
   assert.deepEqual(one.branchEnvVars, { feat: 'A=1' })
+  assert.deepEqual(one.branchPrWatches, {})
+  assert.deepEqual(one.branchPrNotices, {})
   assert.deepEqual(one.linkedDirs, ['.trek'])
   assert.deepEqual(two.branchNotes, {})
   assert.equal(two.linkedDirs, undefined)
   assert.equal('serverPaths' in one, false)
 })
 
+test("a watched PR (5c-1): the branch's watch, and its worktree's notice by branch", () => {
+  const p = fixture()
+  const repo = p.repositories[0]
+  repo.branchData.feat.prWatch = { seen: { checks: 'a none', conflict: false } }
+  const feat = repo.worktrees.find((w) => w.branch === 'feat')
+  feat.prNotice = { title: 'PR #7', text: 'Merged — no agent session to send it to', url: 'https://github.com/o/r/pull/7', at: 1 }
+  const [one] = projectV2(p).slice.project.repositories
+  assert.deepEqual(one.branchPrWatches, { feat: true })
+  assert.deepEqual(one.branchPrNotices, { feat: 'Merged — no agent session to send it to' })
+})
+
 test('settings spread into the project file; no servers', () => {
   const { project } = projectV2(fixture()).slice
   assert.equal(project.version, 3)
diff --git a/src/main/attention.ts b/src/main/attention.ts
index a92a673..f429938 100644
--- a/src/main/attention.ts
+++ b/src/main/attention.ts
@@ -25,7 +25,7 @@ export interface AttentionSource {
   mirror: { subscribe(topic: 'attention', listener: MirrorListener<'attention'>): () => void }
 }
 
-export type AttentionKind = 'decision' | 'attention' | 'done'
+export type AttentionKind = 'decision' | 'attention' | 'done' | 'pullRequest'
 
 /** A new entry: what it is, and the item as listed. */
 export interface AttentionEvent {
@@ -81,6 +81,10 @@ export function attentionKey(serverEntryId: string, projectId: string, sessionId
   return JSON.stringify([serverEntryId, projectId, sessionId])
 }
 
+/** An entry's key: its session's, or for a pull request notice (no session, 5c-1) its worktree's. */
+const keyOfEntry = (serverEntryId: string, e: AttentionEntry): string =>
+  attentionKey(serverEntryId, e.projectId, e.sessionId || `worktree:${e.worktreeId ?? ''}`)
+
 const isFlagged = (status: unknown): boolean => status === 'attention' || status === 'done'
 
 /** A server's entry with the fields this needs; anything else is skipped. */
@@ -94,11 +98,16 @@ function wellFormed(e: unknown): e is AttentionEntry {
     const d = x.decision as Record<string, unknown> | null
     if (!d || typeof d.question !== 'string' || typeof d.at !== 'number') return false
   }
+  if (x.pullRequest !== undefined) {
+    const n = x.pullRequest as Record<string, unknown> | null
+    if (!n || typeof n.text !== 'string' || typeof x.worktreeId !== 'string') return false
+  } else if (x.sessionId === '') return false
   return true
 }
 
 /** The moment that makes an entry new, and its kind; null when it is listed for nothing new. */
 export function newMoment(entry: AttentionEntry, prev: Seen | undefined): AttentionKind | null {
+  if (entry.pullRequest) return entry.since !== (prev?.flagged ?? null) ? 'pullRequest' : null
   const decided = entry.decision?.at ?? null
   if (decided !== null && decided !== (prev?.decided ?? null)) return 'decision'
   const flagged = isFlagged(entry.status) ? entry.since : null
@@ -107,6 +116,7 @@ export function newMoment(entry: AttentionEntry, prev: Seen | undefined): Attent
 }
 
 function seenOf(entry: AttentionEntry): Seen {
+  if (entry.pullRequest) return { flagged: entry.since, decided: null }
   return { flagged: isFlagged(entry.status) ? entry.since : null, decided: entry.decision?.at ?? null }
 }
 
@@ -123,7 +133,7 @@ export function createAttention(deps: AttentionDeps): Attention {
   // Field by field: nothing from the server's entry is spread, so nothing else reaches a window.
   const item = (id: string, link: Linked, e: AttentionEntry): AttentionItem => {
     const out: AttentionItem = {
-      key: attentionKey(id, e.projectId, e.sessionId),
+      key: keyOfEntry(id, e),
       serverEntryId: id,
       serverName: deps.serverName(id),
       projectId: e.projectId,
@@ -138,6 +148,7 @@ export function createAttention(deps: AttentionDeps): Attention {
       out.question = e.decision.question
       out.askedAt = e.decision.at
     }
+    if (e.pullRequest) out.pullRequest = e.pullRequest.text
     if (link.failed || link.down) out.stale = true
     return out
   }
@@ -165,7 +176,7 @@ export function createAttention(deps: AttentionDeps): Attention {
     const events: AttentionEvent[] = []
     const seen = new Map<string, Seen>()
     for (const e of entries) {
-      const key = attentionKey(id, e.projectId, e.sessionId)
+      const key = keyOfEntry(id, e)
       const kind = link.baselined ? newMoment(e, link.seen.get(key)) : null
       if (kind) events.push({ kind, item: item(id, link, e), audioAlerts: e.audioAlerts === true })
       seen.set(key, seenOf(e))
diff --git a/src/main/attentionRules.ts b/src/main/attentionRules.ts
index fb269b0..14e5dea 100644
--- a/src/main/attentionRules.ts
+++ b/src/main/attentionRules.ts
@@ -20,7 +20,8 @@ export interface FocusedWindow {
  * session is in view in the focused window. No window focused (another
  * app is frontmost), or another window focused: notified. Nothing is notified
  * while the app-wide "Show notifications" switch is off (`showNotifications`);
- * the bell and the alert sound do not follow it.
+ * the bell and the alert sound do not follow it. A pull request notice (5c-1)
+ * has no session, so it is notified as attention is for a session not in view.
  */
 export function shouldNotify(
   kind: AttentionKind,
@@ -41,6 +42,8 @@ export const placeOf = (item: AttentionItem): string => attentionPlace(item)
 
 /** As the legacy window words them, with the session's title for the agent's name. */
 export function notificationText(kind: AttentionKind, item: AttentionItem): { title: string; body: string } {
+  // A pull request notice (5c-1): "PR #12 changed", then where, then what changed.
+  if (kind === 'pullRequest') return { title: `${item.title} changed`, body: `${placeOf(item)}\n${item.pullRequest ?? ''}` }
   const title =
     kind === 'decision'
       ? `${item.title} needs a decision`
@@ -60,11 +63,16 @@ export function wantsAlert(events: readonly { audioAlerts: boolean }[]): boolean
   return events.some((e) => e.audioAlerts)
 }
 
-/** Dismissing an entry: its decision if it has one (the menu labels it by that), else it is marked seen. */
-export function dismissRequest(item: AttentionItem): {
-  method: 'session.dismissDecision' | 'session.seen'
-  params: { projectId: string; sessionId: string }
-} {
+/**
+ * Dismissing an entry: a pull request notice is cleared (5c-1); else its decision if it has one
+ * (the menu labels it by that), else it is marked seen.
+ */
+export function dismissRequest(item: AttentionItem):
+  | { method: 'session.dismissDecision' | 'session.seen'; params: { projectId: string; sessionId: string } }
+  | { method: 'prWatch.dismiss'; params: { projectId: string; worktreeId: string } } {
+  if (item.pullRequest !== undefined && item.worktreeId !== null) {
+    return { method: 'prWatch.dismiss', params: { projectId: item.projectId, worktreeId: item.worktreeId } }
+  }
   const params = { projectId: item.projectId, sessionId: item.sessionId }
   return item.question !== undefined ? { method: 'session.dismissDecision', params } : { method: 'session.seen', params }
 }
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index 269a385..991f2f3 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -184,6 +184,10 @@ export interface WindowBackend {
     setNote(repoId: string, branch: string, text: string, expected?: string | null): Promise<void>
     setTicket(repoId: string, branch: string, ticketId: string | null): Promise<void>
     setPullRequest(repoId: string, branch: string, url: string | null): Promise<void>
+    /** The server watches the branch's linked PR (5c-1, `features.prWatch`) */
+    setPrWatch(repoId: string, branch: string, watch: boolean): Promise<void>
+    /** Clears the pull request notice of the worktree at `path` */
+    dismissPrNotice(path: string): Promise<void>
     setEnvVars(repoId: string, branch: string, text: string): Promise<void>
   }
   /** Both report a failure in their own dialog and resolve. */
@@ -271,7 +275,16 @@ export const idleBackend: WindowBackend = {
     onChanged: () => () => {}
   },
   skills: { list: noProject },
-  branch: { setTag: noProject, setCustomTag: noProject, setNote: noProject, setTicket: noProject, setPullRequest: noProject, setEnvVars: noProject },
+  branch: {
+    setTag: noProject,
+    setCustomTag: noProject,
+    setNote: noProject,
+    setTicket: noProject,
+    setPullRequest: noProject,
+    setPrWatch: noProject,
+    dismissPrNotice: noProject,
+    setEnvVars: noProject
+  },
   repos: { add: noProject, remove: noProject },
   errors: {
     show: (title, message) => void window.api.showError(title, message),
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index 9dcb743..2077a4d 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -9,6 +9,7 @@ export type FeatureName =
   | 'linear'
   | 'voice'
   | 'skills'
+  | 'prWatch'
   | 'moveWorktree'
   | 'reveal'
   | 'openInEditor'
@@ -26,6 +27,7 @@ export const FEATURE_NAMES: readonly FeatureName[] = [
   'linear',
   'voice',
   'skills',
+  'prWatch',
   'moveWorktree',
   'reveal',
   'openInEditor',
@@ -48,6 +50,8 @@ export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map
  * - Linear, voice and skills are the server's (5b): Linear and ElevenLabs
  *   with the server's own keys, the skills read on its disk; each needs its
  *   capability, on any server.
+ * - The pull request watch (5c-1) runs gh on the server's machine: it needs
+ *   `prWatch`, which the server lists only while gh is signed in there.
  * - The Global panel needs `mcp`.
  * - Docker, environments and stacks run on the server's machine (5a): each
  *   needs its capability, on any server.
@@ -62,6 +66,7 @@ export const V2_FEATURES: BackendFeatures = {
   linear: true,
   voice: true,
   skills: true,
+  prWatch: true,
   moveWorktree: false,
   reveal: true,
   openInEditor: true,
@@ -84,7 +89,8 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   stacks: 'stacks',
   linear: 'linear',
   voice: 'voice',
-  skills: 'skills'
+  skills: 'skills',
+  prWatch: 'prWatch'
 }
 
 /**
diff --git a/src/renderer/src/components/Sidebar.tsx b/src/renderer/src/components/Sidebar.tsx
index 2a680f4..c9ce23a 100644
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -205,6 +205,8 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
     const pullRequest = info.branch
       ? repo.branchPullRequests?.[info.branch]
       : undefined
+    // A watched PR's report (5c-1) flags the row until it is dismissed.
+    const prNotice = info.branch ? repo.branchPrNotices?.[info.branch] : undefined
     const env = features.env ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
     const envIsBusy = env ? !!envBusy[env.profile] : false
     const isSelected =
@@ -246,8 +248,8 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
         onClick={() => selectWorktree({ path: info.path }, instance?.id)}
         title={`${branchLabel(info)} — ${info.path}`}
       >
-        {dot === 'attention' ? (
-          <span className="wt-attn" title={DOT_TITLES.attention}>
+        {dot === 'attention' || prNotice ? (
+          <span className="wt-attn" title={dot === 'attention' ? DOT_TITLES.attention : prNotice}>
             !
           </span>
         ) : (
@@ -306,7 +308,9 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
                   </span>
                 )}
                 {pullRequest && (
-                  <span className="mini-chip pr">{pullRequestLabel(pullRequest)}</span>
+                  <span className="mini-chip pr" title={prNotice}>
+                    {pullRequestLabel(pullRequest)}
+                  </span>
                 )}
                 {env && (
                   <span
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 81d3b3e..e425c34 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -199,6 +199,9 @@ export function WorktreeDetail({
   // promote/demote and worktree re-creation.
   const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
   const pullRequest = info.branch ? repo.branchPullRequests?.[info.branch] : undefined
+  // The server watches it (5c-1); its last report stays on the chip until dismissed.
+  const watchingPr = !!pullRequest && !!info.branch && !!repo.branchPrWatches?.[info.branch]
+  const prNotice = info.branch ? repo.branchPrNotices?.[info.branch] : undefined
   const linearIssue = ticket ? linearIssues[ticket] : undefined
   const linkedTicketUrl = ticket ? ticketUrl(project, ticket, linearIssue) : null
 
@@ -402,11 +405,26 @@ export function WorktreeDetail({
             )}
             {pullRequest && (
               <span
-                className="chip chip-pr"
-                title={`Open pull request — ${pullRequest}`}
+                className={`chip chip-pr${prNotice ? ' notice' : ''}`}
+                title={`${prNotice ? `${prNotice}\n` : ''}Open pull request — ${pullRequest}`}
                 onClick={() => window.open(pullRequest)}
               >
                 PR {pullRequestLabel(pullRequest)}
+                {watchingPr && <span className="chip-pr-watch"> · watching</span>}
+              </span>
+            )}
+            {prNotice && (
+              <span className="chip chip-pr-notice" title="Dismiss">
+                {prNotice}
+                <button
+                  className="chip-dismiss"
+                  aria-label="Dismiss pull request notice"
+                  onClick={() => {
+                    if (!offline) void getBackend().branch.dismissPrNotice(info.path).catch((err: unknown) => getBackend().errors.report('Could not dismiss the notice', err))
+                  }}
+                >
+                  ×
+                </button>
               </span>
             )}
             {git && <span className="chip chip-git">{git}</span>}
@@ -543,6 +561,27 @@ export function WorktreeDetail({
                     Change or unlink the linked pull request
                   </div>
                 </div>
+                {pullRequest && info.branch && (features.prWatch || watchingPr) && (
+                  <div
+                    className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
+                    onClick={() => {
+                      const branch = info.branch
+                      if (offline || !branch) return
+                      void runAction(() =>
+                        getBackend()
+                          .branch.setPrWatch(repo.id, branch, !watchingPr)
+                          .catch((err: unknown) => getBackend().errors.report(watchingPr ? 'Could not stop watching the pull request' : 'Could not watch the pull request', err))
+                      )
+                    }}
+                  >
+                    <div className="detail-menu-name">{watchingPr ? 'Stop watching pull request' : 'Watch pull request'}</div>
+                    <div className="detail-menu-desc">
+                      {watchingPr
+                        ? 'The server stops following its checks and reviews'
+                        : "The server follows its checks, reviews and merge state, and queues a prompt on this worktree's newest session"}
+                    </div>
+                  </div>
+                )}
                 {(linkedTicketUrl || pullRequest) && (
                   <div
                     className="detail-menu-item"
diff --git a/src/renderer/src/notificationItems.ts b/src/renderer/src/notificationItems.ts
index 7447cdb..2ac38a7 100644
--- a/src/renderer/src/notificationItems.ts
+++ b/src/renderer/src/notificationItems.ts
@@ -63,7 +63,7 @@ export function menuEntries(
       kind: 'server',
       id: item.key,
       source: serverSource(item),
-      text: item.question ?? statusText(item.status),
+      text: item.pullRequest ?? item.question ?? statusText(item.status),
       at: item.askedAt ?? item.since,
       decision: item.question !== undefined,
       stale: item.stale === true
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index d70e8d9..e11ab1e 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -783,6 +783,32 @@ button:disabled {
   background: rgba(124, 102, 220, 0.3);
 }
 
+.chip-pr.notice {
+  box-shadow: inset 0 0 0 1px var(--attention);
+}
+
+.chip-pr-watch {
+  opacity: 0.75;
+}
+
+.chip-pr-notice {
+  background: rgba(255, 178, 36, 0.12);
+  color: var(--attention);
+  display: inline-flex;
+  align-items: center;
+  gap: 4px;
+  max-width: 100%;
+}
+
+.chip-dismiss {
+  background: none;
+  border: 0;
+  color: inherit;
+  cursor: pointer;
+  padding: 0 2px;
+  font: inherit;
+}
+
 .chip-git {
   background: rgba(255, 178, 36, 0.12);
   color: var(--attention);
diff --git a/src/renderer/src/v2/ServerProjectWindow.tsx b/src/renderer/src/v2/ServerProjectWindow.tsx
index ab56167..49bded1 100644
--- a/src/renderer/src/v2/ServerProjectWindow.tsx
+++ b/src/renderer/src/v2/ServerProjectWindow.tsx
@@ -157,6 +157,11 @@ function ServerProjectTree({
     if (isCurrent()) useAppStore.getState().setServerLink(connection.status)
     backendChanged()
     const offStatus = connection.on('status', onStatus)
+    // gh's sign-in changed on the server (5c-1): the SDK has already moved `prWatch` in the welcome.
+    const offPrWatch = connection.on('event', (frame) => {
+      if (frame.event !== 'integrations.changed' || !isCurrent()) return
+      if (typeof (frame.payload as { prWatch?: unknown } | null)?.prWatch === 'boolean') backendChanged()
+    })
     const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
       if ('error' in update) {
         if (projectGone(update.error)) setView({ notFound: true })
@@ -173,6 +178,7 @@ function ServerProjectTree({
     if (connection.status === 'connected') watchServer()
     return () => {
       offStatus()
+      offPrWatch()
       offTopic()
       offServer?.()
       // The slice and the project setters (setProjectSetters) go with serverWindow (windowKind.ts); the streams go now.
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index eb6f085..3a7d5c5 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -571,6 +571,12 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       setPullRequest: async (repoId, branch, url) => {
         await request('branch.setPr', { ...branchRef(repoId, branch), pr: url })
       },
+      setPrWatch: async (repoId, branch, watch) => {
+        await request('branch.setPrWatch', { ...branchRef(repoId, branch), watch })
+      },
+      dismissPrNotice: async (path) => {
+        await request('prWatch.dismiss', { projectId, worktreeId: worktreeAt(path) })
+      },
       setEnvVars: async (repoId, branch, text) => {
         await request('branch.setEnv', { ...branchRef(repoId, branch), env: text || null })
       }
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index a19cf8a..50cff2e 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -161,6 +161,8 @@ type BranchMaps = Required<
     | 'branchCustomTags'
     | 'branchTickets'
     | 'branchPullRequests'
+    | 'branchPrWatches'
+    | 'branchPrNotices'
     | 'branchEnvVars'
   >
 >
@@ -172,6 +174,8 @@ function branchMaps(repo: V2Repository): BranchMaps {
     branchCustomTags: {},
     branchTickets: {},
     branchPullRequests: {},
+    branchPrWatches: {},
+    branchPrNotices: {},
     branchEnvVars: {}
   }
   for (const [branch, data] of Object.entries(repo.branchData)) {
@@ -180,8 +184,10 @@ function branchMaps(repo: V2Repository): BranchMaps {
     if (data.customTags?.length) maps.branchCustomTags[branch] = [...data.customTags]
     if (data.ticket) maps.branchTickets[branch] = data.ticket
     if (data.pr) maps.branchPullRequests[branch] = data.pr
+    if (data.prWatch) maps.branchPrWatches[branch] = true
     if (data.env) maps.branchEnvVars[branch] = data.env
   }
+  for (const w of repo.worktrees) if (w.prNotice && w.branch) maps.branchPrNotices[w.branch] = w.prNotice.text
   return maps
 }
 
diff --git a/src/shared/client/connection.ts b/src/shared/client/connection.ts
index a53e513..88fc0ea 100644
--- a/src/shared/client/connection.ts
+++ b/src/shared/client/connection.ts
@@ -350,6 +350,13 @@ export class ServerConnection {
       return
     }
     if (frame.type === 'event' && typeof frame.event === 'string') {
+      // `prWatch` comes and goes with gh's sign-in on the server (5c-1): the welcome's capabilities
+      // follow it, as a new array, before the event's listeners hear it.
+      const prWatch = frame.event === 'integrations.changed' ? (frame.payload as { prWatch?: unknown } | null)?.prWatch : undefined
+      if (typeof prWatch === 'boolean' && this.welcome) {
+        const others = this.welcome.capabilities.filter((c) => c !== 'prWatch')
+        this.welcome = { ...this.welcome, capabilities: prWatch ? [...others, 'prWatch'] : others }
+      }
       const ev: ServerEvent = { event: frame.event, payload: frame.payload }
       this.emit(this.eventListeners, ev, 'event')
     }
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 16f6917..4b86f31 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -186,7 +186,7 @@ export interface AppServersChanged {
  * server's `attention` entry and the server list's name: no token, no URL.
  */
 export interface AttentionItem {
-  /** `JSON.stringify([serverEntryId, projectId, sessionId])`: what a window sends back to open or dismiss it */
+  /** `JSON.stringify([serverEntryId, projectId, sessionId or 'worktree:<id>'])`: what a window sends back to open or dismiss it */
   key: string
   serverEntryId: string
   /** The user's name for the server entry */
@@ -205,6 +205,8 @@ export interface AttentionItem {
   question?: string
   /** When the decision was asked (epoch ms) */
   askedAt?: number
+  /** A worktree's pull request notice (5c-1): what changed. The entry has no session (`sessionId` ''). */
+  pullRequest?: string
   /** main's connection to the server is down or failed: this is the last state it saw */
   stale?: true
 }
@@ -283,6 +285,10 @@ export interface Repository {
   branchTickets?: Record<string, string>
   /** GitHub pull request URLs, keyed by branch name (survives promote/delete) */
   branchPullRequests?: Record<string, string>
+  /** Branches whose linked PR the server watches (5c-1) */
+  branchPrWatches?: Record<string, true>
+  /** The watched PR's last report, by the branch of the worktree that holds it (5c-1) */
+  branchPrNotices?: Record<string, string>
   /**
    * Environment variables for the branch's Docker environment, keyed by branch
    * name (survives promote/delete). Raw .env-style text ("KEY=value" lines) —
`````

- [ ] **Step 2: Verify:** `npm test` passes 1730 (1 skipped), and `npm run typecheck` is clean.
- [ ] **Step 3: Commit:** `feat(5c-1): Watch pull request in the detail pane; the notice in the menu, the sidebar and main's notifications`.

### Task 5: `smoke:server-prwatch`

**Files:**
- Create: `scripts/server-prwatch-smoke.mjs`
- Modify: `package.json`

The smoke runs a remote server with `TREK_SERVER_GH` set to a scripted stub (signed in while a marker file exists; `pr view` answers with a JSON file the smoke rewrites) and `TREK_SERVER_PR_POLL_MS=1000`. It drives the window, the SDK and MCP through these steps:
1. Watch on from the menu (polled at once with the linked URL; the chip says watching; a baseline).
2. Failing checks: one prompt on the newest of two sessions; the notice in the menu, the sidebar and the detail pane; its × clears it.
3. `watch_pull_request` off and on, with a new baseline and nothing re-reported.
4. Merged with no session: the notice says nothing was queued, and the watch ends.
5. gh signed out: a failed poll re-checks, a new welcome has no `prWatch`, and turning a watch on is refused while the one already on stays. The open window and SDK connection follow without reconnecting (`integrations.changed {prWatch}`), and follow back when gh is signed in again.
6. No token in the renderer, and no errors.

- [ ] **Step 1: Apply the diff** (the prototype's ad089eb)

`````diff
diff --git a/package.json b/package.json
index bd84d39..36b5da4 100644
--- a/package.json
+++ b/package.json
@@ -24,6 +24,7 @@
     "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
     "smoke:server-env": "npm run build && node scripts/server-env-smoke.mjs",
     "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
+    "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/server-prwatch-smoke.mjs b/scripts/server-prwatch-smoke.mjs
new file mode 100644
index 0000000..a0b26ee
--- /dev/null
+++ b/scripts/server-prwatch-smoke.mjs
@@ -0,0 +1,355 @@
+// scripts/server-prwatch-smoke.mjs — the pull request watch (phase 5c-1) on a remote server, in its window.
+//
+// Run: npm run smoke:server-prwatch   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) runs with its own HOME, TREK_SERVER_GH pointed at a stub gh
+// and TREK_SERVER_PR_POLL_MS=1000: nothing here runs the real gh or reaches GitHub. The stub answers
+// `gh auth status` while a marker file exists, and `gh pr view` with a JSON file this script rewrites.
+// The server's agent is a fake one that lingers. The built app runs with a temp HOME and
+// --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app server,
+// and the window opens a project made through the SDK. Through the DOM, the SDK and the server's MCP
+// endpoint it checks:
+//   - the welcome lists prWatch while gh is signed in, and the window's feature follows it;
+//   - the detail pane's "Watch pull request" turns the branch's watch on (saved on the server, polled
+//     at once with the linked URL); the PR chip says watching;
+//   - failing checks: a prompt is queued on the worktree's newest session, the worktree's notice is
+//     listed in the notifications menu and flags its sidebar row; the notice's × clears it;
+//   - watch_pull_request (MCP) turns the watch off and on;
+//   - merged with no session: the notice says nothing was queued, and the watch turns itself off;
+//   - gh signed out: a failed poll re-checks, a new connection's welcome has no prWatch, and the open
+//     window and connection follow (integrations.changed {prWatch}); signed in again, they follow back;
+//   - the renderer never holds the server token; no error dialogs, console or page errors.
+//
+// Prints SERVER PRWATCH SMOKE PASS (n checks) or SERVER PRWATCH SMOKE FAIL and exits 0 or 1.
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
+const WATCHDOG_MS = 150_000
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
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-prwatch-smoke-')))
+const serverHome = join(work, 'server-home')
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
+
+const PR_URL = 'https://github.com/acme/app/pull/12'
+const repo = join(serverHome, 'repos', 'app')
+const worktree = `${repo}-feature-x`
+const stubs = join(work, 'stubs')
+mkdirSync(stubs)
+const signedIn = join(work, 'gh-signed-in')
+const prJson = join(work, 'gh-pr.json')
+const ghCalls = join(work, 'gh-calls')
+// gh: `auth status` while the marker exists; `pr view` answers with gh-pr.json (exit 1 when it is gone).
+writeFileSync(
+  join(stubs, 'gh'),
+  `#!/bin/bash
+echo "$*" >> '${ghCalls}'
+if [ "$1" = auth ]; then [ -e '${signedIn}' ] && exit 0; echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
+if [ "$1" = pr ] && [ "$2" = view ]; then [ -e '${prJson}' ] && exec cat '${prJson}'; echo 'HTTP 401: Bad credentials' >&2; exit 1; fi
+exit 1
+`,
+  { mode: 0o755 }
+)
+writeFileSync(signedIn, '')
+const pr = (overrides = {}) =>
+  writeFileSync(
+    prJson,
+    JSON.stringify({ number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' }], reviews: [], comments: [], ...overrides })
+  )
+pr()
+const prViews = () => (existsSync(ghCalls) ? readFileSync(ghCalls, 'utf8').trim().split('\n').filter((l) => l.startsWith('pr view')) : [])
+
+const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
+git('init', '-q', '-b', 'main', repo)
+git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '--allow-empty', '-m', 'init')
+
+const fakeAgent = join(work, 'fake-agent.sh')
+const agentPids = join(work, 'agent-pids')
+writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
+const configPath = join(work, 'config.json')
+writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))
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
+  console.log(exitCode === 0 ? `SERVER PRWATCH SMOKE PASS (${checks.length} checks)` : `SERVER PRWATCH SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+const connect = async (url, client) => {
+  const c = new ServerConnection({ url, token, createSocket: globalSocketFactory, client })
+  c.connect()
+  await until(() => c.status, 'connected', 5000)
+  return c
+}
+
+try {
+  // ---- 1. The server, with a stub gh signed in, and a project on it --------------------------------
+
+  const port = await freePort()
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
+      cwd: join(root, 'server'),
+      env: {
+        ...process.env,
+        HOME: serverHome,
+        XDG_STATE_HOME: join(serverHome, '.local', 'state'),
+        SHELL: '/bin/sh',
+        // This server's own stub, in place of the not-signed-in one smokeGh.mjs gives every smoke.
+        TREK_SERVER_GH: join(stubs, 'gh'),
+        TREK_SERVER_PR_POLL_MS: '1000'
+      },
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
+  // The first gh check runs at start; a connection made once it answered lists prWatch.
+  check('gh answered the server’s sign-in check', await until(() => existsSync(ghCalls) && readFileSync(ghCalls, 'utf8').includes('auth status'), true), true)
+  await sleep(300)
+  sdk = await connect(url, 'server-prwatch-smoke')
+  const sdkChanges = []
+  sdk.on('event', (ev) => {
+    if (ev.event === 'integrations.changed') sdkChanges.push(ev.payload)
+  })
+  check('the welcome lists prWatch while gh is signed in', sdk.welcome?.capabilities.includes('prWatch'), true)
+  const { projectId } = await sdk.request('project.create', { name: 'prwatch', repositories: [{ path: repo }] })
+  const topic = `project:${projectId}`
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const repoId = (await project()).repositories[0].id
+  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
+  await sdk.request('branch.setPr', { projectId, repoId, branch: 'feature-x', pr: PR_URL })
+  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id
+  const feature = async () => (await project()).repositories[0].worktrees.find((w) => w.id === featureId)
+  const branchData = async () => (await project()).repositories[0].branchData['feature-x']
+
+  // ---- 2. The app, with the server saved, and the project's window ---------------------------------
+
+  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
+  delete env.ELECTRON_RUN_AS_NODE
+  delete env.TREK_SERVER_PR_POLL_MS
+  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
+  app.on('window', watch)
+  const win = await app.firstWindow()
+  watch(win)
+  await win.waitForLoadState('domcontentloaded')
+  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
+  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
+  await win.evaluate(async ([id, pid]) => {
+    const { opened } = await window.api.openServerProject(id, pid, 'prwatch', 'Remote')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entry.id, projectId])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 2)
+  check("the window's prWatch feature follows the server's capability", await until(() => win.evaluate(() => window.__features().prWatch), true), true)
+
+  // ---- 3. Watch pull request, from the detail pane --------------------------------------------------
+
+  const detail = win.locator('.server-window .detail')
+  const featureRow = rows.filter({ hasText: 'feature-x' })
+  await featureRow.click()
+  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
+  const menuItem = (name) => detail.locator('.detail-menu-item', { hasText: name })
+  await detail.locator('button[title="Worktree actions"]').click()
+  await menuItem('Watch pull request').click()
+  check("the branch's watch is on, saved on the server", await until(async () => (await branchData())?.prWatch !== undefined, true), true)
+  check('polled at once, with the linked URL', await until(() => prViews().length > 0, true), true)
+  check('every gh pr view named the linked URL and the watch’s fields', [...new Set(prViews())], [`pr view ${PR_URL} --json number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments`])
+  check('the PR chip says watching', await until(() => detail.locator('.chip-pr').textContent().catch(() => ''), 'PR #12 · watching'), 'PR #12 · watching')
+  check('the baseline is saved: checks pending, no notice yet', [await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa pending'), (await feature()).prNotice ?? null], ['aaa pending', null])
+
+  // ---- 4. Checks fail: a prompt on the newest session, the notice in the menu and the sidebar --------
+
+  await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Old', cols: 120, rows: 30 })
+  const newest = await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Claude', cols: 120, rows: 30 })
+  pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] })
+  const queueOf = async (sessionId) => (await feature()).sessions.find((s) => s.id === sessionId)?.queue ?? []
+  const queued = await until(async () => (await queueOf(newest.sessionId)).length, 1)
+  check("one prompt is queued on the worktree's newest session, none on the older", [queued, (await feature()).sessions.map((s) => s.queue.length)], [1, [0, 1]])
+  check('the prompt says what failed and how to look', (await queueOf(newest.sessionId))[0].split('\n').slice(0, 2), [`Pull request #12 (${PR_URL}) changed:`, `- Checks failed: lint. Look at them with \`gh pr checks ${PR_URL}\`, fix the cause, and push.`])
+  const notice = 'Checks failed — prompt queued for Claude'
+  check("the worktree's notice", await until(async () => (await feature()).prNotice?.text ?? null, notice), notice)
+  await win.locator('.notif-bell').click()
+  const notifItem = win.locator('.notif-menu .notif-item', { hasText: 'PR #12' })
+  check('the notifications menu lists it, saying what changed', await until(() => notifItem.locator('.notif-question').textContent().catch(() => null), notice), notice)
+  await win.keyboard.press('Escape')
+  await win.locator('.notif-bell').click().catch(() => {})
+  check("the sidebar flags the worktree's row", await until(() => featureRow.locator('.wt-attn').getAttribute('title').catch(() => null), notice), notice)
+  check('the detail pane shows the notice', await until(() => detail.locator('.chip-pr-notice').textContent().catch(() => null), `${notice}×`), `${notice}×`)
+  await detail.locator('.chip-pr-notice .chip-dismiss').click()
+  check('its × clears the notice on the server', await until(async () => (await feature()).prNotice ?? null, null), null)
+  check('and the row is no longer flagged', await until(() => featureRow.locator('.wt-attn').count(), 0), 0)
+
+  // ---- 5. watch_pull_request (MCP) --------------------------------------------------------------------
+
+  const mcpFile = join(data, 'mcp', `${projectId}.json`)
+  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const rpc = async (method, params) => {
+    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
+    return res.json()
+  }
+  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
+  const tool = async (name, args) => {
+    const body = await rpc('tools/call', { name, arguments: args })
+    const text = body.result?.content?.[0]?.text ?? ''
+    try {
+      return { isError: body.result?.isError === true, value: JSON.parse(text) }
+    } catch {
+      return { isError: body.result?.isError === true, value: text }
+    }
+  }
+  check('watch_pull_request off', (await tool('watch_pull_request', { worktree: 'feature-x', watch: false })).value, { branch: 'feature-x', pullRequest: PR_URL, watching: false })
+  check('the chip follows: no longer watching', await until(() => detail.locator('.chip-pr').textContent().catch(() => ''), 'PR #12'), 'PR #12')
+  check('watch_pull_request on', (await tool('watch_pull_request', { worktree: 'feature-x' })).value, { branch: 'feature-x', pullRequest: PR_URL, watching: true })
+  check('list_worktrees says it is watched', (await tool('list_worktrees', {})).value.find((w) => w.branch === 'feature-x')?.watchingPullRequest, true)
+  check('the new watch took its baseline (the failure already reported is not reported again)', await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa failing'), 'aaa failing')
+  check('still one prompt queued', await queueOf(newest.sessionId).then((q) => q.length), 1)
+
+  // ---- 6. Merged, with no session left: the notice says so, and the watch ends ---------------------
+
+  for (const s of (await feature()).sessions) await sdk.request('session.close', { projectId, sessionId: s.id })
+  pr({ state: 'MERGED' })
+  const merged = 'Merged — no agent session to send it to'
+  check('merged with no session: the notice says nothing was queued', await until(async () => (await feature()).prNotice?.text ?? null, merged), merged)
+  check('the watch turned itself off; the PR stays linked', await branchData(), { pr: PR_URL })
+  check("the window has it, by the worktree's branch", await until(() => win.evaluate(() => window.__store.getState().project?.repositories[0].branchPrNotices?.['feature-x'] ?? null), merged), merged)
+
+  // ---- 7. gh signed out: a failed poll re-checks, and a new welcome has no prWatch ------------------
+
+  pr()
+  await sdk.request('branch.setPrWatch', { projectId, repoId, branch: 'feature-x', watch: true })
+  await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa pending')
+  rmSync(signedIn)
+  rmSync(prJson)
+  const after = await until(async () => {
+    const c = await connect(url, 'server-prwatch-smoke-2')
+    const has = c.welcome?.capabilities.includes('prWatch')
+    c.close()
+    return has
+  }, false)
+  check("gh signed out: a new connection's welcome has no prWatch", after, false)
+  const refused = await sdk.request('branch.setPrWatch', { projectId, repoId, branch: 'feature-x', watch: true }).then(() => null, (e) => e.code)
+  check('turning a watch on is refused then (TOOL_ERROR); the one on stays', [refused, (await branchData())?.prWatch !== undefined], ['TOOL_ERROR', true])
+  // Pushed (integrations.changed {prWatch}): the open window and connection follow without reconnecting.
+  check("the open window's PR watch goes away, without a reconnect", await until(() => win.evaluate(() => window.__features().prWatch), false), false)
+  check("and the open SDK connection's capabilities follow", sdk.welcome.capabilities.includes('prWatch'), false)
+  pr()
+  writeFileSync(signedIn, '')
+  check('gh signed in again: the open window shows it again (the next sign-in check)', await until(() => win.evaluate(() => window.__features().prWatch), true), true)
+  check('every connection heard each change', sdkChanges.filter((c) => 'prWatch' in c), [{ prWatch: false }, { prWatch: true }])
+
+  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
+  check("the renderer's store and page never hold the server token", held.includes(token), false)
+  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
+  check('no console or page errors', pageErrors, [])
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
`````

- [ ] **Step 2: Verify:** `npm run smoke:server-prwatch` prints `SERVER PRWATCH SMOKE PASS (35 checks)`.
- [ ] **Step 3: Commit:** `test(5c-1): smoke:server-prwatch`.

### Task 6: Docs

**Files:**
- Modify: `PROTOCOL.md`, `README.md`, `server/README.md`, `docs/superpowers/specs/2026-11-04-central-server-design.md`

`PROTOCOL.md` gets:
- the capability, with when it is checked;
- the commands table;
- the `attention` topic's notice entry;
- a "Pull request watch" section: what is polled and reported, the methods, and that `branch.setPr` ends a watch;
- the MCP table and its count (28).

The README gets the feature and the smoke. The server README covers gh's sign-in and `TREK_SERVER_GH` / `TREK_SERVER_PR_POLL_MS`. The spec gets the decisions.

- [ ] **Step 1: Apply the diff** (the prototype's c638bb2)

`````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 233f841..66507c5 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -102,6 +102,7 @@ new optional field needs no capability: its absence says enough.
 | `linear` | `linear.*` look Linear issues up with the server's own API key (see [Linear, voice and skills](#linear-voice-and-skills)) |
 | `voice` | `voice.*` keep the server's ElevenLabs key and voice; the MCP tool `speak_summary` sends each spoken summary to the project's subscribers as `voice.summary` |
 | `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
+| `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked when the server starts (its first welcome waits up to 3 s for the answer), again every 10 minutes while it is missing, and after a poll fails. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -119,7 +120,7 @@ The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 | Topic | Snapshot |
 |---|---|
 | `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}], repos: [{id, name, path}]}`. `health` lists `PERSIST_FAILED` (a project could not be saved; the server keeps retrying) and `LOAD_FAILED` (a project file was skipped at start) and `REPO_UNAVAILABLE` (see Worktrees below) |
-| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?, projectName, audioAlerts?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, and every session with an open decision whatever its status, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions). `projectName` is the project's name and `audioAlerts: true` is present while the project's `audioAlerts` setting is on, so a client can label an entry and decide on its alert sound without the project topic |
+| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?, projectName, audioAlerts?, pullRequest?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, every session with an open decision whatever its status, and every worktree with a pull request notice, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions). `projectName` is the project's name and `audioAlerts: true` is present while the project's `audioAlerts` setting is on, so a client can label an entry and decide on its alert sound without the project topic. A notice's entry (see [Pull request watch](#pull-request-watch)) is the worktree's: `sessionId` is `''`, `title` the notice's (`PR #12`), `status` `attention`, `since` when it was raised, and `pullRequest: {text, url}`; a client older than 5c-1 lists it as needing attention |
 | `project:<id>` | the whole `Project` tree |
 
 - `ops` are RFC 6902 JSON Patch, limited to `add`, `remove` and `replace`.
@@ -171,7 +172,7 @@ server restarts. A server without this field simply leaves it out.
 | Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
 | Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
 | Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff`, `worktree.dirty` |
-| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
+| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setPrWatch`, `branch.setEnv` |
 | Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
@@ -182,6 +183,7 @@ server restarts. A server without this field simply leaves it out.
 | Linear | `linear.status`, `linear.setKey`, `linear.clearKey`, `linear.issues` |
 | Voice | `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`, `voice.setConfig`, `voice.synthesize` |
 | Skills | `skills.list` |
+| Pull request watch | `prWatch.dismiss` (and `branch.setPrWatch`) |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
 | Misc | `sys.ping` |
 
@@ -487,6 +489,38 @@ connection with more than 4 MiB unsent is skipped (the clip would play late). Wh
 plays it is the client's: the desktop plays it unless its user set the app to Busy, an app-wide
 setting of that desktop, not the server's.
 
+## Pull request watch
+
+With the capability `prWatch` (phase 5c-1), the server watches a branch's linked pull request
+(`branchData.pr`) with the GitHub CLI on its own machine, signed in as the server's user (`gh auth
+login`); the server holds no GitHub token. A watch is the branch's `branchData.prWatch`, saved with
+the project, so it survives a restart: `{}` until its first poll, then `{seen}`, what that poll saw
+(the head commit and checks state, whether GitHub said it conflicts, the newest review or comment
+time). Only a canonical `https://github.com/<owner>/<repo>/pull/<n>` URL is watched, and only while a
+worktree has the branch checked out.
+
+Every 3 minutes the server runs `gh pr view <url> --json
+number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments` for each watched branch,
+one at a time, and compares it with `seen`. The first poll is the baseline and reports nothing
+(unless the PR is already merged or closed). After that it reports: checks failed (as soon as one
+has, with their names) or all passed, once per head commit; new reviews or comments by anyone but
+the PR's author; a merge conflict when GitHub starts saying so (`UNKNOWN` keeps the last answer);
+merged; closed. A report is one prompt queued on the worktree's newest session (the last of its
+`sessions`; every v2 session runs an agent), saying what changed and which `gh` command shows it,
+and the worktree's `prNotice` `{title, text, url, at}` (runtime only, like a status), which the
+`attention` topic lists. With no session, or its queue full, nothing is queued and the notice says
+so; no session is started. After merged or closed the watch removes itself; the link stays. A
+failed `gh` call leaves the watch as it was, is logged once while it lasts, and re-checks the
+sign-in.
+
+| Method | Params | Result |
+|---|---|---|
+| `branch.setPrWatch` | `{projectId, repoId, branch, watch}` | `null`. On needs `prWatch` (else `TOOL_ERROR`) and a linked github.com pull URL (else `BAD_REQUEST`); a watch already on keeps its `seen`; a new one is polled at once. Off always works |
+| `prWatch.dismiss` | `{projectId, worktreeId}` | `null`: the worktree's notice is cleared (`NOT_FOUND` for an unknown worktree) |
+
+`branch.setPr` with a different URL, or none, also removes the branch's watch: it watched the old
+pull request. The MCP tool `watch_pull_request` turns a watch on or off.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
@@ -827,9 +861,9 @@ An unknown session is `NOT_FOUND`.
 
 A *worktree entry* below is what `list_worktrees` returns for one worktree:
 `{worktree, repo, repoId, path, branch, primary, missing, tag, customTags, ticket,
-pullRequest, note, dirty, ahead, behind, loaded, sessions: [{terminalId, title,
+pullRequest, watchingPullRequest, note, dirty, ahead, behind, loaded, sessions: [{terminalId, title,
 status, llm, queue, decision}]}`, where `decision` is the open decision's question
-or `null`.
+or `null`, and `watchingPullRequest` says the server watches the branch's pull request.
 
 | Tool | Parameters | Result |
 |---|---|---|
@@ -852,6 +886,7 @@ or `null`.
 | `set_worktree_note` | `worktree`, `note` (empty clears) | `{branch}` |
 | `set_worktree_ticket` | `worktree`; `ticket?` (a Linear id or URL, or an Azure DevOps id or URL; omit to unlink) | `{branch, ticket, url}` |
 | `set_worktree_pull_request` | `worktree`; `pullRequest?` (a GitHub PR URL, or a number or `#number` when another PR in the repository gives the owner and repo; omit to unlink) | `{branch, pullRequest}` |
+| `watch_pull_request` | `worktree`; `watch?` (default true; false stops) | `{branch, pullRequest, watching}`, through `branch.setPrWatch` (see [Pull request watch](#pull-request-watch)): `TOOL_ERROR` when gh is not signed in on the server, `BAD_REQUEST` with no linked github.com PR |
 | `list_session_types` | none | an array of `{id, name, systemPrompt, initialMessage?, llm?}` (no icon) |
 | `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
 | `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |
@@ -861,7 +896,7 @@ or `null`.
 | `stop_stack` | `worktree` | the stack once `stack.sh down` exited 0; else `BAD_REQUEST` naming the code |
 | `read_stack_log` | `worktree`; `lines?` (default 100, 1 to 2000) | `{output}`: the last lines of the stack's log's last 64 KiB (a line cut at its start left out), colour codes removed |
 
-That is 27 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
+That is 28 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
 `stack.log` (their path checks), on the server's machine; a worktree without
 `docker/stack/stack.sh` has no stack (`get_stack` says so, the others are `BAD_REQUEST`). Tags are matched by name or id, case-insensitively, and an
 unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
@@ -925,7 +960,7 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 | `docker.log` | `{data, done?}`: a `docker.compose` run's output, only to the connection that asked for it (chunks may be dropped under backpressure, see [Docker, environments and stacks](#docker-environments-and-stacks)); `done` on its last |
 | `env.log` | `{profile, data, done?, step?}`: an `env.up`, `env.stop` or `env.destroy`'s output, only to the connection that asked for it; `step` (`vm`, `compose`, `ready`) marks an `env.up` phase, `done` its last |
 | `voice.summary` | `{projectId, sessionId, text, audio}`: a session's spoken summary (`speak_summary`), an mp3 in base64, to every connection subscribed to the project's topic (not one more than 4 MiB behind) |
-| `integrations.changed` | `{linear?: true, voice?: true}`: the server's Linear or ElevenLabs key, or its voice settings, changed (by any client), to every authenticated connection; re-read `linear.status` / `voice.settings` (see [Linear, voice and skills](#linear-voice-and-skills)) |
+| `integrations.changed` | `{linear?: true, voice?: true, prWatch?: boolean}`: the server's Linear or ElevenLabs key, or its voice settings, changed (by any client), to every authenticated connection; re-read `linear.status` / `voice.settings` (see [Linear, voice and skills](#linear-voice-and-skills)). `prWatch` is gh's new sign-in state on the server's machine: the `prWatch` capability is now listed or not (see [Pull request watch](#pull-request-watch)); the client SDK updates `welcome.capabilities` before its listeners hear the event |
 
 ## Several clients
 
diff --git a/README.md b/README.md
index 48395c5..44286bd 100644
--- a/README.md
+++ b/README.md
@@ -189,6 +189,16 @@ other window on that project sees them live.
   on the server. Its agents also get the `get_stack`, `start_stack`, `stop_stack` and
   `read_stack_log` MCP tools. A server older than this Trek (without the `linear`,
   `voice` and `skills` capabilities) shows none of these.
+- **Pull request watch, on the server**: with a pull request linked to a branch, the
+  worktree's … menu has **Watch pull request** (agents can call `watch_pull_request`).
+  The server asks `gh` on its own machine about it every few minutes; when its checks
+  fail or pass, new reviews or comments arrive, it gets a merge conflict, or it is
+  merged or closed, a prompt saying so (and which `gh` command shows it) is queued on
+  the worktree's newest session, and the worktree is flagged in the sidebar and the
+  notifications menu until you dismiss it. Nothing is started for a worktree with no
+  session. After merged or closed the watch turns itself off. It needs `gh` installed
+  and signed in (`gh auth login`) as the server's user; without that the menu item is
+  not shown.
 - **This machine's features, in Local windows only**: a window on the [Local
   server](#local-server) also has Open in VS Code and Reveal in Finder, since its
   paths are this machine's. A window on a remote server shows neither.
@@ -382,6 +392,9 @@ one at a time:
   stacks, run on the server's machine against stub `colima`, `docker` and `stack.sh`;
 - `npm run smoke:server-integrations`: a remote server window's Linear, voice
   summaries, skills and the stack MCP tools, against stub Linear and ElevenLabs APIs;
+- `npm run smoke:server-prwatch`: a remote server window's pull request watch, against
+  a stub `gh` (every smoke gives its servers a not-signed-in stub `gh`, `scripts/smokeGh.mjs`,
+  so none runs the real one);
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index a62286c..301e8a2 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -441,6 +441,12 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
        session (the existing queue) and raises attention. It can be switched on per
        worktree from the detail pane and by a `watch_pull_request` MCP tool. Behind a
        `prWatch` capability that the server reports only when `gh` is authenticated.
+       User decisions (2026-11-10): the prompt goes to the worktree's newest open agent
+       session; with none, the worktree is flagged and listed in the notifications menu
+       and nothing is started; a watch ends by itself after reporting merged or closed,
+       and survives server restarts until then. Plan:
+       `docs/superpowers/plans/2026-11-10-central-server-phase5c1-pr-watch.md` (5c-1);
+       the review is 5c-2 and the web client 5c-3.
      - **Changes tab review:** a source picker (uncommitted only, the branch against its
        base, or one commit from the newest 100) and line comments on the diff. "Send to
        session" enqueues the comments, with their file and line, as one prompt. The tab
diff --git a/server/README.md b/server/README.md
index 4c25c26..08a4fd0 100644
--- a/server/README.md
+++ b/server/README.md
@@ -168,6 +168,22 @@ endpoints (Linear's GraphQL URL; ElevenLabs' `/v1` base). They are for tests, wh
 run stub services; leave them unset. Only an `http` or `https` URL on `127.0.0.1`,
 `::1` or `localhost` is taken; any other value is ignored with a warning.
 
+## Pull request watch
+
+A client (or an agent, through `watch_pull_request`) can have the server watch a
+branch's linked GitHub pull request. The server runs the GitHub CLI as its own user,
+so install `gh` on the server's machine and sign in there (`gh auth login`); the
+server stores no GitHub token. While `gh auth status` fails the welcome has no
+`prWatch` and no watch can be turned on (watches already on stay, and resume once
+gh is signed in again). A change in gh's sign-in reaches every connected client at
+once (`integrations.changed`). Every 3 minutes each watched pull request is read with `gh pr
+view`; a change queues a prompt on the worktree's newest session and flags the
+worktree. The watch is saved in the project file, so it survives a restart.
+
+`TREK_SERVER_GH` (an absolute path) is the gh to run instead of `gh` on the PATH, and
+`TREK_SERVER_PR_POLL_MS` (at least 1000) the time between polls and, while gh is signed out, between sign-in checks. They are for tests,
+which run a stub gh; leave them unset.
+
 ## Projects
 
 Clients create projects from registered repos (`trek-server add`). Each
`````

- [ ] **Step 2: Commit:** `docs(5c-1): the pull request watch`.

### Task 7: Final verification (5c-1)

- [ ] **Step 1:** Run `npm run typecheck`, `cd server && npm run typecheck`, `npm test` and `npm run build`. The prototype had 1731 tests: 1730 pass, 1 skipped.
- [ ] **Step 2:** Run every smoke, one at a time. Each smoke runs with `smokeGh.mjs`'s stub. The prototype's counts:

  | Smoke | Checks |
  |---|---|
  | server-prwatch | 35 |
  | v2 | 172 |
  | local-features | 51 |
  | server-integrations | 33 |
  | local-app | 45 |
  | local-window | 57 |
  | server-env | 30 |
  | providers | 36 |
  | windows | 38 |
  | import | 63 |
  | local-server | 85 |
  | client-contract | PASS |
  | the server smoke | PASS |

- [ ] **Step 3:** A clean checkout passes: `git clone` into the scratchpad, then `npm ci`, the typechecks and the tests.
- [ ] **Step 4:** No processes are left (no `trek-server.cjs`, no fake agents), `git status` is clean, and no smoke's log shows a `gh` call outside a stub.
- [ ] **Step 5:** Run the final whole-branch review (most capable model), apply its fixes, then take the counts again.

---

## Notes for 5c-2 and 5c-3

1. **5c-2's "Send to session"** queues one prompt, the same way this plan's watcher does (`session.enqueue`). Both are click-to-send (Decision 4).
2. **The web client (5c-3)** gets `prWatch` changes from the SDK as the desktop does (Decision 6). It has no main: it needs its own attention list over the `attention` topic. That list must handle the notice entries the way main's does: keyed by worktree, its text shown, dismissed through `prWatch.dismiss`. It also needs the detail pane's menu item; that one is a plain renderer feature behind `features.prWatch`.

## Risks

1. **An app older than 5c-1 on a 5c-1 server:**
   - It shows a notice as "PR #12 needs your attention", with no text.
   - Dismissing it calls `session.seen` with `''`, which fails with `NOT_FOUND`.
   - Two notices in one project share its key, so only one is notified.
   - It cannot turn a watch on or off, since it has no menu item; MCP still works.
2. **A capability change reaches a window only while it is connected.** A window that was disconnected gets the current state from its next welcome; a server older than 5c-1 sends no `prWatch` change (it has no watch).
3. **Bots' comments count as new comments** (CI bots, coverage bots), so a busy bot means a prompt every poll it comments (Decision 5).
4. **A notice is lost on a server restart** (runtime only, Decisions 7 and 12). The prompt it reported is still in the queue, and the watch's `seen` keeps it from being reported again.
5. **GitHub API use.**
   - Each watched PR costs one GraphQL call every 3 minutes, which is far under gh's 5000 an hour for a handful of PRs, plus one `gh auth status` every 10 minutes.
   - A PR that keeps failing (no access, deleted) is logged once and flags its worktree after 3 failures; it re-runs `gh auth status` only when its error looks like sign-in.
   - Only the newest 100 reviews and comments and the first 100 checks are read. More than 100 new comments within one poll are counted as 100; a failing check past the first 100 is missed.
6. **The server must find gh.**
   - A Local server inherits the app's fixed PATH, as docker does.
   - A remote server needs gh on its user's PATH, signed in as that user. Without it, `prWatch` is simply missing.
   - A sign-in or sign-out reaches open windows within about 10 minutes (the timer), or at the next poll that fails with a sign-in error.
7. **A queued prompt waits for the user to send it.** The queue is click-to-send (2d-2), so the agent does nothing until then. The notification and the flag are what draw the user (Decision 4).
8. **"Checks passed" and "merged" prompts are informational.** The spec asks for them, but they cost a queue slot.

## Questions for the user

None. The user answered the draft's four on 2026-11-10 (Decisions 4–7).
