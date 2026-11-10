# Central Server Phase 5c-2: the Changes Tab Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Changes tab picks what it compares (the branch against its base, the uncommitted work only, or one of the newest 100 commits) and takes line comments on the diff; the draft lives on the server's worktree, and "Send to session" queues every comment, with its file, line and the line's text, as one prompt on a session the user picks.

**Architecture:** `worktree.changes` and `worktree.diff` gain an optional `source`, `worktree.commits` lists the newest commits, and five `review.*` methods keep a draft on the worktree in the project model (`Worktree.review = {revision, comments}`), so it is saved with the project and every window sees it in the project topic's patches. `review.send` appends `reviewPrompt(...)` to the session's queue and deletes the draft inside one `ProjectState.apply`, so the two happen as one change (one patch, one save). The renderer projects the draft by worktree path (`worktreeReviews`), numbers the diff lines (`numberedLines`), places each comment on the line with the same side, number and text (else outdated, at the file's top), and offers the worktree's open sessions newest first. An agent reads a draft with the read-only MCP tool `get_review_comments`. Everything is behind a `review` capability; an older server keeps today's branch view and the tab says to update it.

**Tech Stack:** TypeScript, Node (`node --test`), git, React (renderer), Electron + Playwright (smokes), trek-server protocol v2.

Prototyped on `central-server-phase5c2-proto` (one commit per task, on master 3cd1d05): d44e92f (Task 1), 39e5468 (Task 2), 847f868 (Task 3), babbbd0 (Task 4), 1e715ce (Task 5), bfc6f67 (Task 6). The diffs below are those commits. Executing: cherry-pick them in order onto `central-server-phase5c2` (`git cherry-pick master..central-server-phase5c2-proto`), or apply each task's diff, then run that task's checks.

---

## User decisions (2026-11-10)

1. **The draft lives on the server**, on the worktree: saved with the project, the same in every window (and the coming web client), and kept across restarts.
2. **Send to session opens a picker** of the worktree's open agent sessions, newest first; one click queues the review there.
3. **The draft is cleared once sent.** The queued prompt holds the comments.
4. **A comment whose line changed is kept**, shown as outdated at the top of its file, and still sent with the text it was written on.
5. **Send needs the worktree loaded** (Decision 21): an unloaded worktree's Send is disabled with "Load the worktree…". Kept as prototyped.
6. **The source resets to the branch** on each selection and is not saved (Decision 23). Kept as prototyped.
7. **A read-only `get_review_comments` MCP tool** (Decision 24): an agent reads a worktree's draft, each comment with its file, side, line, line text, comment, source and whether it is outdated.
8. **Moved lines go outdated** (Decision 19): anchoring is by side, line number and exact text, with no fuzzy re-anchoring. Kept as prototyped.
9. **The limits stand** (Decision 15): 100 comments a draft, 4000 characters each, 500 for the line, and a draft that fits in one queued prompt.

## Decisions (made while prototyping)

10. **The draft is a worktree field, not a new topic or file.** `Worktree.review?: ReviewDraft` in `src/shared/model/types.ts`. The project topic already publishes patches to every subscriber and the project store already saves the worktree rows (they hold sessions), so live sync and persistence come free. The git poller keeps a row's other fields when it updates it (`reconcile.ts` spreads the row), so the draft survives polls; a sessionless worktree that git stops listing is dropped with its draft, like its row. `resetRuntime` keeps the draft (it is not runtime state) and drops one of the wrong shape (`cleanReview`, `server/src/review/draft.ts`), at load and at `project.import`.
11. **No new topic or event.** Edits reach other windows as project-topic patches. The draft is small by its limits (Decision 15).
12. **Sources.** `ChangesSource = {kind:'branch'} | {kind:'uncommitted'} | {kind:'commit', sha}`, in `src/shared/types.ts`. Absent means the branch (today's view, `changesBase`), so an older client's params are unchanged. Uncommitted is the working tree against `HEAD` (the empty tree before the first commit), untracked files included. A commit is `git diff <sha>^1 <sha>` (the empty tree for a root commit), without untracked files; a merge is shown against its first parent. `base` is `null` for both new sources.
13. **Commit ids are strict.** Only a full lowercase hex object id (40 or 64 characters, `isCommitSha`) is accepted, checked by the server before git runs (`BAD_REQUEST`) and again in `gitService` (defence in depth). It must name a commit (`git rev-parse --verify --quiet <sha>^{commit}`; else `GIT_ERROR`). It need not be among the newest 100: the picker lists those, but a commit picked earlier stays viewable after more are made. No `--end-of-options` (git 2.30+ only for rev-parse): a hex id cannot be an option.
14. **`worktree.commits`** lists the newest 100 on `HEAD` (`git log -n 100 --format=%H%x00%an%x00%at%x00%s%x1e`), newest first, merges included; the subject is cut to 200 characters. It goes through `present()`, so the same path checks as `worktree.changes` apply.
15. **Limits** (`src/shared/review.ts`): at most 100 comments a draft; a body of at most 4000 characters, not blank; a line text of at most 500 characters, one line (the app cuts a longer line and drops its control characters, `reviewLineText`); a path of 1–4096 characters, one line; a line 1–10,000,000. `review.add` and `review.edit` also refuse a change after which the draft's prompt would not fit in one queued prompt (`MAX_QUEUE_ENTRY`, 100,000 characters), so `review.send` never fails on size. The prompt is at most 100,000 characters by construction.
16. **Atomic send.** `review.send` checks the revision, the session (one of the worktree's own, `NOT_FOUND` otherwise) and its queue (`BAD_REQUEST` when full: 100 prompts), then appends the prompt and deletes the draft in one `projects.apply`: one patch, one save; there is no state where it is both queued and still drafted, or cleared and not queued. It writes the queue directly rather than through `SessionManager.enqueue` so that both changes share one apply; `enqueue` does nothing else (no auto-send, no attention).
17. **Compare-and-set.** `review.send` and `review.clear` take the draft's `revision` as the client showed it (`CONFLICT` if it moved), so a comment added in another window meanwhile is never sent or discarded unseen. `review.edit` takes `expected` (the body the edit started from). `revision` is `max(previous + 1, now)`: a draft started after another was sent or discarded starts at the server's clock, so it cannot repeat a revision an old client still holds (an empty draft is deleted, not kept as a counter).
18. **The prompt** (`reviewPrompt`): a header naming the worktree and the count ("Each quotes the line as it read when the comment was written; the file may have changed since. Address each one."), then a `## <source>` section per source in the order the comments were first written, each comment sorted by path, line and side as `<path>, line <n>:` (or `removed line <n>`), `> <lineText>`, and the body. The server builds it, so every client (and the web client) sends the same text.
19. **Comments are anchored by side and line number, plus the line's text.** `numberedLines` numbers a patch body from its hunk headers: `+` lines on the new side, `-` lines on the old side, context lines on the new side; `\ No newline` notes and anything before the first hunk are not commentable. A comment sits under the line with the same side and number whose text (through `reviewLineText`) still matches; otherwise it is outdated, at the top of its file. No fuzzy re-anchoring (a moved but unchanged line shows as outdated): simple and predictable, as the user decision asks.
20. **Where the rest show.** Comments on another source, or on a file not in the current diff, are listed in the review bar ("n not on this diff", expandable), with their source, file and line, and can be edited or deleted there. All of them are sent.
21. **Open sessions = the worktree's tabs.** The picker lists the worktree's live sessions (`terminalOrder` for the worktree, reversed: the server's session order is start order) only while the worktree is loaded. An unloaded worktree's Send is disabled with "Load the worktree to send the review to one of its sessions"; a loaded one with no session says "Start a session in this worktree…". (The server accepts any of the worktree's sessions, loaded or not.)
22. **Discard asks once, inline**: the button turns into "Discard n comments?" (no modal dialog).
23. **The source is per window and per selection**: it resets to the branch when another worktree is selected, and is not saved.
24. **`get_review_comments`** (user decision 7): `{worktree}` like the other tools, resolved in the calling session's project only (`resolveWorktree`, the same access rule as every tool). Returns `{worktree, revision, comments: [{id, file, side, line, lineText, comment, source, sourceLabel, outdated}]}` (`revision: null` and no comments without a draft). Read-only: it never changes the draft. `outdated` is worked out now, as the app shows it: one `worktree.diff` per distinct source in the draft (through the v2 command, so its path checks and 8 MiB cap apply), then `isOutdated` (`src/shared/review.ts`: no patch for the file, no line with that side and number, or another text). That is cheap: usually one or two sources, at most `MAX_OUTDATED_SOURCES` (5) diffs; a comment on a sixth source, or whose diff fails (a commit gone, a missing worktree), has `outdated: null`. 29 MCP tools.
25. **Older servers.** `features.review` follows the `review` capability (`CAPABILITY_FOR`). Without it the tab asks with no `source` (the params a pre-5c-2 server takes) and shows today's header, plus "Update the server to pick a source and comment on lines" while connected (the 5b `needsUpdate` pattern, in the tab instead of Settings).
26. **UI.** A `+` appears in a diff line's left gutter on hover; the editor is inline under the line (⌘/Ctrl+Enter saves, Escape cancels); comments render under their line with Edit and Delete; a 💬 count on the file row. The review bar sits above the file list: "Review · n comments", Send to session ▾ (a menu of sessions), Discard. Diff lines gained 12px of left padding for the gutter.
27. **Smoke.** A new `smoke:server-review` (37 checks, three of them the agent's `get_review_comments`) on a remote server, plus `smoke:local-window`'s base check now reads the picker ("Branch vs main") instead of the old header text. Every smoke still imports `scripts/smokeGh.mjs` first.

## Risks

1. **Draft size in the project topic.** Every subscriber's snapshot carries every worktree's draft. The prompt cap (Decision 15) bounds one draft to about 100,000 characters of text plus its JSON; typical drafts are a few KB. There is no cap across a project's worktrees.
2. **An older app on a 5c-2 server** ignores `review` and the source; it shows the branch view and never sees the draft. Nothing breaks.
3. **Outdated by number.** A comment on a line that moved (lines inserted above it) shows as outdated even though its text is unchanged. It is still sent correctly.
4. **Session order.** "Newest first" is the reverse of the worktree's tab order, which is the server's start order today; if tabs become reorderable, the picker follows the tabs.
5. **The poll keeps going.** The tab polls the chosen source every 5 s like today; a commit source re-runs `git diff` on an unchanging commit. Cheap, but not cached.
6. **A huge commit** (a vendored dependency) is capped as today: 8 MiB of patches, larger files listed without a diff.
7. **No per-comment conflict check on delete**: a delete removes the comment whatever its body is now.

## Questions for the user

None remain: the four were answered on 2026-11-10 (user decisions 5–9).

## Files

| File | Task | Change |
|---|---|---|
| `src/shared/types.ts` | 1, 4 | `ChangesSource`, `CommitInfo`; legacy `Repository.worktreeReviews` |
| `src/shared/model/types.ts` | 1 | `Worktree.review`, `ReviewDraft`, `ReviewComment` |
| `src/shared/protocolV2.ts` | 1 | `CAPABILITY.review`; `source` on `worktree.changes`/`diff`; `worktree.commits`; `review.*` params and results |
| `src/shared/changes.ts` | 1 | `NumberedLine`, `numberedLines` |
| `src/shared/review.ts` (new) | 1 | limits, `isCommitSha`, sources, `reviewLineText`, `reviewPrompt`, `placeComments`, `isOutdated` |
| `scripts/reviewRules.test.mjs` (new) | 1 | the pure rules |
| `src/host/gitService.ts` | 2 | `sourceRange`, `worktreeChanges`/`worktreeDiff(path, source)`, `worktreeCommits` |
| `scripts/gitChanges.test.mjs` | 2 | sources and commits against real git |
| `server/src/review/draft.ts` (new) | 3 | `checkSource`, `cleanReview` |
| `server/src/review/reviewHandlers.ts` (new) | 3 | `review.add/edit/remove/clear/send` |
| `server/src/worktreeHandlers.ts` | 3 | `source`, `worktree.commits`, `locate` exported |
| `server/src/projects/model.ts` | 3 | `resetWorktree` keeps a well-formed draft |
| `server/src/v2.ts`, `server/src/capabilities.ts` | 3 | dispatch, capability |
| `server/src/mcp/tools.ts` | 3 | `get_review_comments` |
| `scripts/serverReview.test.mjs` (new), `scripts/serverV2.test.mjs`, `scripts/serverMcpTools.test.mjs` | 3 | the server and the tool |
| `src/renderer/src/backendFeatures.ts` | 4 | `review` feature |
| `src/renderer/src/backend.ts`, `src/renderer/src/v2/backendV2.ts` | 4 | `git.changes/diff(source)`, `git.commits`, `review.*` |
| `src/renderer/src/v2/projector.ts` | 4 | `worktreeReviews` by path |
| `src/renderer/src/components/ChangesPanel.tsx` | 4 | the source picker, line comments, review bar |
| `src/renderer/src/components/WorktreeDetail.tsx` | 4 | the source state, review props, the tab's title |
| `src/renderer/src/styles.css` | 4 | the review's styles |
| `scripts/backendFeatures.test.mjs`, `scripts/v2Projector.test.mjs`, `scripts/v2Backend.test.mjs` | 4 | the app |
| `scripts/server-review-smoke.mjs` (new), `package.json`, `scripts/local-window-smoke.mjs` | 5 | the smoke |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | 6 | docs |

## Verification of the prototype (head bfc6f67)

| Check | Result |
|---|---|
| `npm run typecheck` / `cd server && npm run typecheck` | clean / clean |
| `npm test` | 1785 tests: 1784 pass, 1 skipped (the opt-in bot sandbox test), 0 fail (1754 on master) |
| `npm run build` | passes |
| smoke:server-review (new) | PASS (37 checks) |
| smoke:v2 | PASS (172) |
| smoke:local-window | PASS (57) |
| smoke:local-features | PASS (51) |
| smoke:server-env / server-integrations / server-prwatch | PASS (30 / 33 / 54) |
| smoke:local-app / providers / windows / import | PASS (45 / 36 / 38 / 63) |
| smoke:local (local-server) / smoke:client (client-contract) | PASS (85) / PASS |
| server `npm run smoke -- --built` | PASS |

Every smoke ran one at a time; no trek-server or fake agent was left running. After `get_review_comments` was added (user decision 7), both typechecks, `npm test` and smokes server-review, v2 and local-window were run again at bfc6f67 (the counts above); the other smokes ran at the head before it (3e8ba8f), which differs only by the tool, its tests, the smoke's MCP checks and the docs.

---
### Task 1: the model fields, the protocol and the pure rules

Types (`ChangesSource`, `CommitInfo`, `ReviewDraft`, `ReviewComment`, `Worktree.review`), the protocol (`CAPABILITY.review`, the `source` param, `worktree.commits`, `review.*`), `numberedLines` and `src/shared/review.ts` (limits, `isCommitSha`, sources, `reviewLineText`, `reviewPrompt`, `placeComments`, `isOutdated`).

**Files:**
- Create: `scripts/reviewRules.test.mjs`
- Modify: `src/shared/changes.ts`
- Modify: `src/shared/model/types.ts`
- Modify: `src/shared/protocolV2.ts`
- Create: `src/shared/review.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick d44e92f`, or the diff below)

````diff
diff --git a/scripts/reviewRules.test.mjs b/scripts/reviewRules.test.mjs
new file mode 100644
index 0000000..85af804
--- /dev/null
+++ b/scripts/reviewRules.test.mjs
@@ -0,0 +1,136 @@
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { numberedLines, patchBody } from '../src/shared/changes.ts'
+import {
+  MAX_REVIEW_LINE_TEXT,
+  isCommitSha,
+  isOutdated,
+  placeComments,
+  reviewLineText,
+  reviewPrompt,
+  sameSource,
+  sourceKey,
+  sourceLabel
+} from '../src/shared/review.ts'
+
+const PATCH = [
+  'diff --git a/a.txt b/a.txt',
+  'index 1111111..2222222 100644',
+  '--- a/a.txt',
+  '+++ b/a.txt',
+  '@@ -1,3 +1,3 @@',
+  ' one',
+  '-two',
+  '+TWO',
+  ' three',
+  '@@ -10,2 +10,3 @@ fn()',
+  ' ten',
+  '+ten and a half',
+  ' eleven',
+  '\\ No newline at end of file',
+  ''
+].join('\n')
+
+test('numberedLines numbers each side from the hunk headers', () => {
+  const lines = numberedLines(patchBody(PATCH))
+  assert.deepEqual(
+    lines.map((l) => [l.kind, l.side, l.line, l.text]),
+    [
+      ['hunk', undefined, undefined, '@@ -1,3 +1,3 @@'],
+      ['context', 'new', 1, 'one'],
+      ['del', 'old', 2, 'two'],
+      ['add', 'new', 2, 'TWO'],
+      ['context', 'new', 3, 'three'],
+      ['hunk', undefined, undefined, '@@ -10,2 +10,3 @@ fn()'],
+      ['context', 'new', 10, 'ten'],
+      ['add', 'new', 11, 'ten and a half'],
+      ['context', 'new', 12, 'eleven'],
+      ['note', undefined, undefined, '\\ No newline at end of file']
+    ]
+  )
+})
+
+test('numberedLines: lines before a hunk (a mode-only change) have no number', () => {
+  const lines = numberedLines(['old mode 100644', 'new mode 100755'])
+  assert.ok(lines.every((l) => l.kind === 'note' && l.line === undefined))
+})
+
+test('numberedLines: a new file starts at line 1 of the new side', () => {
+  const lines = numberedLines(['@@ -0,0 +1,2 @@', '+a', '+b'])
+  assert.deepEqual(lines.slice(1).map((l) => [l.side, l.line]), [['new', 1], ['new', 2]])
+})
+
+test('isCommitSha takes only full lowercase hex ids', () => {
+  assert.equal(isCommitSha('a'.repeat(40)), true)
+  assert.equal(isCommitSha('b'.repeat(64)), true)
+  for (const bad of ['a'.repeat(39), 'A'.repeat(40), '--output=x', 'HEAD', 'a'.repeat(40) + '^', 'g'.repeat(40), 42, undefined]) {
+    assert.equal(isCommitSha(bad), false, String(bad))
+  }
+})
+
+test('sources: same, key and label', () => {
+  const sha = 'c'.repeat(40)
+  assert.equal(sameSource({ kind: 'branch' }, { kind: 'branch' }), true)
+  assert.equal(sameSource({ kind: 'commit', sha }, { kind: 'commit', sha }), true)
+  assert.equal(sameSource({ kind: 'commit', sha }, { kind: 'commit', sha: 'd'.repeat(40) }), false)
+  assert.equal(sameSource({ kind: 'uncommitted' }, { kind: 'branch' }), false)
+  assert.equal(sourceKey({ kind: 'commit', sha }), `commit:${sha}`)
+  assert.equal(sourceLabel({ kind: 'commit', sha }, 'Fix it'), 'Commit ccccccc (Fix it)')
+  assert.equal(sourceLabel({ kind: 'uncommitted' }), 'Uncommitted changes')
+})
+
+test('reviewLineText drops control characters, keeps tabs and cuts long lines', () => {
+  assert.equal(reviewLineText('\ta\u001b[31mb\r'), '\ta[31mb')
+  assert.equal(reviewLineText('x'.repeat(MAX_REVIEW_LINE_TEXT + 10)).length, MAX_REVIEW_LINE_TEXT)
+})
+
+const comment = (over) => ({
+  id: 'c1',
+  source: { kind: 'branch' },
+  path: 'a.txt',
+  side: 'new',
+  line: 2,
+  lineText: 'TWO',
+  body: 'Why upper case?',
+  at: 1,
+  ...over
+})
+
+test('placeComments: a matching line holds its comment; a changed or missing one is outdated', () => {
+  const lines = numberedLines(patchBody(PATCH))
+  const onTwo = comment({ id: 'a' })
+  const removed = comment({ id: 'b', side: 'old', line: 2, lineText: 'two' })
+  const changed = comment({ id: 'c', line: 11, lineText: 'ten and a quarter' })
+  const gone = comment({ id: 'd', line: 99, lineText: 'x' })
+  const { byLine, outdated } = placeComments([onTwo, removed, changed, gone], lines)
+  assert.deepEqual([...byLine.entries()].map(([i, cs]) => [i, cs.map((c) => c.id)]), [[3, ['a']], [2, ['b']]])
+  assert.deepEqual(outdated.map((c) => c.id), ['c', 'd'])
+})
+
+test('reviewPrompt groups by source, then file and line, quoting each line', () => {
+  const sha = 'e'.repeat(40)
+  const text = reviewPrompt('feature', [
+    comment({ id: '1', path: 'b.txt', line: 5, lineText: 'five', body: 'B five' }),
+    comment({ id: '2', source: { kind: 'commit', sha }, path: 'a.txt', line: 1, lineText: 'one', body: 'In the commit' }),
+    comment({ id: '3', path: 'a.txt', side: 'old', line: 2, lineText: 'two', body: 'Keep this' })
+  ])
+  assert.equal(
+    text,
+    [
+      'Review comments on the changes in feature (3 comments). Each quotes the line as it read when the comment was written; the file may have changed since. Address each one.',
+      '## The branch against its base',
+      'a.txt, removed line 2:\n> two\nKeep this',
+      'b.txt, line 5:\n> five\nB five',
+      '## Commit eeeeeee',
+      'a.txt, line 1:\n> one\nIn the commit'
+    ].join('\n\n')
+  )
+})
+
+test('isOutdated: no patch, no such line, or another text', () => {
+  const c = comment({ side: 'new', line: 2, lineText: 'TWO' })
+  assert.equal(isOutdated(c, PATCH), false)
+  assert.equal(isOutdated({ ...c, lineText: 'two' }, PATCH), true)
+  assert.equal(isOutdated({ ...c, line: 99 }, PATCH), true)
+  assert.equal(isOutdated(c, undefined), true)
+})
diff --git a/src/shared/changes.ts b/src/shared/changes.ts
index 68e8f8c..0643ce4 100644
--- a/src/shared/changes.ts
+++ b/src/shared/changes.ts
@@ -91,3 +91,42 @@ export function missingPatchNote(
   if (diffError) return 'Diff not available'
   return file.added + file.deleted > 0 ? 'Diff not shown: over the size limit' : 'No text changes'
 }
+
+/** One line of a patch body with its place in the files, for line comments (5c-2). */
+export interface NumberedLine {
+  /** The line without the diff's +, - or space; a hunk header or a note as it is */
+  text: string
+  kind: 'hunk' | 'add' | 'del' | 'context' | 'note'
+  /** Which file a comment on it names: `old` for a removed line, `new` for an added or unchanged one */
+  side?: 'old' | 'new'
+  /** 1-based, in that side's file */
+  line?: number
+}
+
+/**
+ * Numbers a patch body (`patchBody`) from its hunk headers. A `\ No newline at end of file`
+ * note and anything before the first hunk have no number, so they can't be commented on.
+ */
+export function numberedLines(body: readonly string[]): NumberedLine[] {
+  let oldLine = 0
+  let newLine = 0
+  let inHunk = false
+  return body.map((raw): NumberedLine => {
+    if (raw.startsWith('@@')) {
+      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
+      inHunk = m !== null
+      if (m) {
+        oldLine = Number(m[1])
+        newLine = Number(m[2])
+      }
+      return { text: raw, kind: 'hunk' }
+    }
+    if (!inHunk || raw.startsWith('\\')) return { text: raw, kind: 'note' }
+    if (raw.startsWith('+')) return { text: raw.slice(1), kind: 'add', side: 'new', line: newLine++ }
+    if (raw.startsWith('-')) return { text: raw.slice(1), kind: 'del', side: 'old', line: oldLine++ }
+    const line: NumberedLine = { text: raw.slice(1), kind: 'context', side: 'new', line: newLine }
+    newLine++
+    oldLine++
+    return line
+  })
+}
diff --git a/src/shared/model/types.ts b/src/shared/model/types.ts
index ea0dc62..e6598d9 100644
--- a/src/shared/model/types.ts
+++ b/src/shared/model/types.ts
@@ -2,7 +2,7 @@
 // receive it as topic snapshots plus JSON patches (see ../sync/). Type-only, so
 // it is safe for `node --test`, the daemon and a React Native client.
 import type { LlmSelection } from '../providers/types.ts'
-import type { EnvironmentSettings, ProjectFile } from '../types.ts'
+import type { ChangesSource, EnvironmentSettings, ProjectFile } from '../types.ts'
 
 /**
  * Computed on the server from the terminal's live output:
@@ -116,6 +116,35 @@ export interface Worktree {
   sessions: Session[]
   /** Its watched pull request's last report, until dismissed (`prWatch.dismiss`) or replaced. Runtime only. */
   prNotice?: PrNotice
+  /** The Changes tab's draft review (5c-2): saved with the project, until sent or discarded */
+  review?: ReviewDraft
+}
+
+/** A worktree's draft review: line comments on its diffs, sent to a session as one prompt (5c-2). */
+export interface ReviewDraft {
+  /** Goes up by one on every change; `review.send` and `review.clear` compare it */
+  revision: number
+  /** In the order they were written */
+  comments: ReviewComment[]
+}
+
+/** One line comment. It keeps the line's text, so it can still be sent once the line has changed. */
+export interface ReviewComment {
+  /** Server-assigned */
+  id: string
+  /** The diff it was written on */
+  source: ChangesSource
+  /** The file's path in that diff (its new name for a rename) */
+  path: string
+  /** `old`: a removed line, numbered in the old file; `new`: an added or unchanged line, in the new file */
+  side: 'old' | 'new'
+  /** 1-based */
+  line: number
+  /** The line as it read when the comment was written, without the diff's +, - or space */
+  lineText: string
+  body: string
+  /** Epoch ms, the server's clock: when it was written or last edited */
+  at: number
 }
 
 export interface Repository {
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index d5996a3..a46b961 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -33,6 +33,8 @@ import type {
   VoiceServerConfig,
   VoiceServerSettings,
   StackStatus,
+  ChangesSource,
+  CommitInfo,
   WorktreeChanges
 } from './types.ts'
 
@@ -196,7 +198,13 @@ export const CAPABILITY = {
    * after a poll fails like a sign-in error; a change is pushed to every authenticated connection as
    * `integrations.changed` `{prWatch}`, which the client SDK applies to `welcome.capabilities`.
    */
-  prWatch: 'prWatch'
+  prWatch: 'prWatch',
+  /**
+   * The Changes tab's review (5c-2): `worktree.changes` and `worktree.diff` take a `source`,
+   * `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line
+   * comments and send them to one of its sessions as one queued prompt
+   */
+  review: 'review'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -291,8 +299,11 @@ export interface MethodParamsV2 {
   'worktree.unload': WorktreeRef
   'worktree.pull': WorktreeRef
   'worktree.push': WorktreeRef & { setUpstream: boolean }
-  'worktree.changes': WorktreeRef
-  'worktree.diff': WorktreeRef
+  /** `source` (5c-2, capability `review`) defaults to the branch against its base */
+  'worktree.changes': WorktreeRef & { source?: ChangesSource }
+  'worktree.diff': WorktreeRef & { source?: ChangesSource }
+  /** The newest 100 commits on the worktree's HEAD, newest first (5c-2) */
+  'worktree.commits': WorktreeRef
   /** A fresh `git status --porcelain` of the worktree (the status poll's `dirty` may be up to 30 s old) */
   'worktree.dirty': WorktreeRef
   // Branch data (null clears)
@@ -306,6 +317,26 @@ export interface MethodParamsV2 {
   /** Clears the worktree's pull request notice */
   'prWatch.dismiss': WorktreeRef
   'branch.setEnv': BranchRef & { env: string | null; expected?: string | null }
+  // The Changes tab's review (5c-2): the draft is the worktree's `review` in the project topic
+  /** A new line comment; `lineText` is the line as shown, without the diff's +, - or space */
+  'review.add': WorktreeRef & {
+    source: ChangesSource
+    path: string
+    side: 'old' | 'new'
+    line: number
+    lineText: string
+    body: string
+  }
+  /** `expected`: the body the edit started from (compare-and-set) */
+  'review.edit': WorktreeRef & { commentId: string; body: string; expected?: string }
+  'review.remove': WorktreeRef & { commentId: string }
+  /** Discards the draft; `revision`: the draft the client showed (compare-and-set) */
+  'review.clear': WorktreeRef & { revision: number }
+  /**
+   * Queues the draft on `sessionId` (one of the worktree's sessions) as one prompt and clears it, in
+   * one change; `revision`: the draft the client showed, so nothing unseen is sent (CONFLICT)
+   */
+  'review.send': WorktreeRef & { sessionId: string; revision: number }
   // Sessions
   /** `worktreeId: null` starts a Global panel session */
   'session.start': ProjectRef & {
@@ -467,6 +498,7 @@ export interface MethodResultsV2 {
   'worktree.diff': Record<string, string>
   /** null when git cannot read the worktree's status */
   'worktree.dirty': boolean | null
+  'worktree.commits': CommitInfo[]
   'branch.setTag': null
   'branch.setCustomTags': null
   'branch.setNote': null
@@ -475,6 +507,11 @@ export interface MethodResultsV2 {
   'branch.setPrWatch': null
   'prWatch.dismiss': null
   'branch.setEnv': null
+  'review.add': { commentId: string }
+  'review.edit': null
+  'review.remove': null
+  'review.clear': null
+  'review.send': null
   'session.start': { sessionId: string; ptyId: string }
   'session.restart': { ptyId: string }
   'session.close': null
diff --git a/src/shared/review.ts b/src/shared/review.ts
new file mode 100644
index 0000000..d526aa2
--- /dev/null
+++ b/src/shared/review.ts
@@ -0,0 +1,122 @@
+// The Changes tab's review (5c-2): line comments on a worktree's diffs, kept on the server as the
+// worktree's draft and sent to one of its sessions as one queued prompt. Pure: shared by the
+// server (limits, the prompt), the app (where a comment sits on the diff) and `node --test`.
+import type { ReviewComment } from './model/types.ts'
+import type { ChangesSource } from './types.ts'
+import { numberedLines, patchBody, type NumberedLine } from './changes.ts'
+
+/** The most comments one draft holds. */
+export const MAX_REVIEW_COMMENTS = 100
+/** The longest comment, in UTF-16 code units. */
+export const MAX_REVIEW_BODY = 4000
+/** The longest line text a comment keeps; the app cuts a longer line to this. */
+export const MAX_REVIEW_LINE_TEXT = 500
+/** The longest file path a comment names. */
+export const MAX_REVIEW_PATH = 4096
+/** The highest line number a comment may name. */
+export const MAX_REVIEW_LINE = 10_000_000
+/** How many commits `worktree.commits` lists, and the picker offers. */
+export const COMMIT_LIST_LIMIT = 100
+
+/** A full hex object id: SHA-1 (40) or SHA-256 (64), lowercase. Never an option or a revision expression. */
+export function isCommitSha(value: unknown): value is string {
+  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
+}
+
+export const BRANCH_SOURCE: ChangesSource = { kind: 'branch' }
+
+export function sameSource(a: ChangesSource, b: ChangesSource): boolean {
+  if (a.kind !== b.kind) return false
+  return a.kind !== 'commit' || (b.kind === 'commit' && a.sha === b.sha)
+}
+
+/** A stable key for a source: `branch`, `uncommitted` or `commit:<sha>`. */
+export function sourceKey(source: ChangesSource): string {
+  return source.kind === 'commit' ? `commit:${source.sha}` : source.kind
+}
+
+/** How a prompt and the tab name a source. */
+export function sourceLabel(source: ChangesSource, subject?: string): string {
+  if (source.kind === 'uncommitted') return 'Uncommitted changes'
+  if (source.kind === 'branch') return 'The branch against its base'
+  return `Commit ${source.sha.slice(0, 7)}${subject ? ` (${subject})` : ''}`
+}
+
+/**
+ * A diff line as a comment keeps it: control characters (a CR, an escape) dropped, a tab kept,
+ * and at most MAX_REVIEW_LINE_TEXT characters.
+ */
+export function reviewLineText(raw: string): string {
+  // eslint-disable-next-line no-control-regex
+  const text = raw.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '')
+  return text.length > MAX_REVIEW_LINE_TEXT ? text.slice(0, MAX_REVIEW_LINE_TEXT) : text
+}
+
+const byPlace = (a: ReviewComment, b: ReviewComment): number =>
+  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1)
+
+/**
+ * The prompt `review.send` queues: every comment, grouped by the diff it was written on, then by
+ * file and line, each with the line as it read when the comment was written.
+ */
+export function reviewPrompt(worktreeName: string, comments: readonly ReviewComment[]): string {
+  const groups = new Map<string, { source: ChangesSource; comments: ReviewComment[] }>()
+  for (const c of comments) {
+    const key = sourceKey(c.source)
+    const group = groups.get(key) ?? { source: c.source, comments: [] }
+    group.comments.push(c)
+    groups.set(key, group)
+  }
+  const count = comments.length
+  const parts = [
+    `Review comments on the changes in ${worktreeName} (${count} ${count === 1 ? 'comment' : 'comments'}). ` +
+      'Each quotes the line as it read when the comment was written; the file may have changed since. ' +
+      'Address each one.'
+  ]
+  for (const { source, comments: group } of groups.values()) {
+    parts.push(`## ${sourceLabel(source)}`)
+    for (const c of [...group].sort(byPlace)) {
+      const where = c.side === 'old' ? `removed line ${c.line}` : `line ${c.line}`
+      parts.push(`${c.path}, ${where}:\n> ${c.lineText}\n${c.body}`)
+    }
+  }
+  return parts.join('\n\n')
+}
+
+/** Where a file's comments sit on its diff: under the line they were written on, or outdated. */
+export interface PlacedComments {
+  /** By the index of the line in the numbered diff */
+  byLine: Map<number, ReviewComment[]>
+  /** Their line is not in this diff, or reads differently now: shown at the file's top */
+  outdated: ReviewComment[]
+}
+
+/**
+ * Places one file's comments (already of this source and path) on its numbered diff: on the line
+ * with the same side and number whose text still matches, else outdated.
+ */
+export function placeComments(comments: readonly ReviewComment[], lines: readonly NumberedLine[]): PlacedComments {
+  const index = new Map<string, number>()
+  lines.forEach((l, i) => {
+    if (l.side && l.line !== undefined) index.set(`${l.side} ${l.line}`, i)
+  })
+  const byLine = new Map<number, ReviewComment[]>()
+  const outdated: ReviewComment[] = []
+  for (const c of comments) {
+    const i = index.get(`${c.side} ${c.line}`)
+    if (i !== undefined && reviewLineText(lines[i].text) === c.lineText) {
+      byLine.set(i, [...(byLine.get(i) ?? []), c])
+    } else outdated.push(c)
+  }
+  return { byLine, outdated }
+}
+
+/**
+ * Whether a comment no longer sits on its line in `patch` (its file's patch in the comment's own
+ * source, now): no patch for the file, no line there with its side and number, or one that reads
+ * differently. The app shows such a comment at its file's top; get_review_comments reports it.
+ */
+export function isOutdated(comment: ReviewComment, patch: string | undefined): boolean {
+  if (patch === undefined) return true
+  return placeComments([comment], numberedLines(patchBody(patch))).outdated.length > 0
+}
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 92e1d60..b5b7037 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -448,6 +448,24 @@ export interface ChangedFile {
   unreadable?: boolean
 }
 
+/**
+ * What the Changes tab compares (5c-2): the branch against its base (what it would add to the
+ * default branch, uncommitted work included; the default), the uncommitted work alone (staged,
+ * unstaged and untracked, against HEAD), or one commit against its first parent.
+ */
+export type ChangesSource = { kind: 'branch' } | { kind: 'uncommitted' } | { kind: 'commit'; sha: string }
+
+/** One of the newest commits on a worktree's HEAD (`worktree.commits`, 5c-2). */
+export interface CommitInfo {
+  /** The full hex object id */
+  sha: string
+  /** The first line of its message, at most 200 characters */
+  subject: string
+  author: string
+  /** Author time, epoch ms */
+  at: number
+}
+
 /** What a worktree would add to the default branch, uncommitted work included. */
 export interface WorktreeChanges {
   /** The default branch compared against; null when comparing to HEAD */
````

- [ ] **Step 2: Run the checks**

Run: `node --test scripts/reviewRules.test.mjs && npm run typecheck && (cd server && npm run typecheck)`
Expected: 9 tests pass; both typechecks clean

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 1: the review's model fields, protocol (worktree.changes/diff source, worktree.commits, review.*, capability review) and pure rules (numbered diff lines, comment placement, the prompt)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 2: gitService's sources and the commit list

`sourceRange` (Decisions 12, 13), `worktreeChanges(path, source)` and `worktreeDiff(path, source)` (default: the branch), `worktreeCommits(path, limit)` (Decision 14).

**Files:**
- Modify: `scripts/gitChanges.test.mjs`
- Modify: `src/host/gitService.ts`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick 39e5468`, or the diff below)

````diff
diff --git a/scripts/gitChanges.test.mjs b/scripts/gitChanges.test.mjs
index cdf02c2..5d8f9d1 100644
--- a/scripts/gitChanges.test.mjs
+++ b/scripts/gitChanges.test.mjs
@@ -4,7 +4,7 @@ import { execFileSync } from 'node:child_process'
 import { mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync, chmodSync, symlinkSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
-import { limitPatches, splitPatch, worktreeChanges, worktreeDiff } from '../src/host/gitService.ts'
+import { limitPatches, splitPatch, worktreeChanges, worktreeCommits, worktreeDiff } from '../src/host/gitService.ts'
 
 function makeRepo(t) {
   const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
@@ -448,3 +448,84 @@ test('worktreeDiff stays under the total size limit while worktreeChanges lists
   const changes = await worktreeChanges(dir)
   assert.equal(changes.files.filter((f) => f.path.startsWith('big')).length, 5)
 })
+
+// 5c-2: the review's sources and the commit list.
+
+function withWork(t) {
+  const repo = makeRepo(t)
+  const { dir, run } = repo
+  writeFileSync(join(dir, 'committed.txt'), 'x\n')
+  run('add', '.')
+  run('commit', '-qm', 'first work')
+  writeFileSync(join(dir, 'second.txt'), 'y\n')
+  run('add', '.')
+  run('commit', '-qm', 'second work')
+  writeFileSync(join(dir, 'keep.txt'), 'one\nedited\n')
+  writeFileSync(join(dir, 'untracked.txt'), 'u\n')
+  const sha = (rev) => run('rev-parse', rev).trim()
+  return { ...repo, sha }
+}
+
+const paths = (changes) => changes.files.map((f) => f.path)
+
+test('source uncommitted: staged, unstaged and untracked against HEAD, no commits', async (t) => {
+  const { dir } = withWork(t)
+  const changes = await worktreeChanges(dir, { kind: 'uncommitted' })
+  assert.equal(changes.base, null)
+  assert.deepEqual(paths(changes), ['keep.txt', 'untracked.txt'])
+  const diff = await worktreeDiff(dir, { kind: 'uncommitted' })
+  assert.deepEqual(Object.keys(diff).sort(), ['keep.txt', 'untracked.txt'])
+  assert.match(diff['keep.txt'], /\+edited/)
+})
+
+test('source branch is the default: commits and uncommitted work against the base', async (t) => {
+  const { dir } = withWork(t)
+  const changes = await worktreeChanges(dir, { kind: 'branch' })
+  assert.equal(changes.base, 'main')
+  assert.deepEqual(paths(changes), ['committed.txt', 'keep.txt', 'second.txt', 'untracked.txt'])
+  assert.deepEqual(await worktreeChanges(dir), changes)
+})
+
+test('source commit: one commit against its parent, without the working tree', async (t) => {
+  const { dir, sha } = withWork(t)
+  const first = sha('HEAD~1')
+  const changes = await worktreeChanges(dir, { kind: 'commit', sha: first })
+  assert.deepEqual(changes, { base: null, files: [{ path: 'committed.txt', status: 'added', added: 1, deleted: 0, binary: false }] })
+  const diff = await worktreeDiff(dir, { kind: 'commit', sha: first })
+  assert.deepEqual(Object.keys(diff), ['committed.txt'])
+  assert.match(diff['committed.txt'], /^\+x$/m)
+})
+
+test('source commit: a root commit is compared with the empty tree', async (t) => {
+  const { dir, sha } = withWork(t)
+  const root = sha('main')
+  const changes = await worktreeChanges(dir, { kind: 'commit', sha: root })
+  assert.deepEqual(paths(changes), ['.gitignore', 'gone.txt', 'keep.txt', 'moved.txt'])
+})
+
+test('source commit: anything but a full hex id of a commit is refused before git sees it', async (t) => {
+  const { dir, sha, run } = withWork(t)
+  for (const bad of ['HEAD', '--output=/tmp/x', sha('HEAD').slice(0, 12), `${sha('HEAD')}^`]) {
+    await assert.rejects(worktreeChanges(dir, { kind: 'commit', sha: bad }), /full hex commit id/, bad)
+  }
+  await assert.rejects(worktreeChanges(dir, { kind: 'commit', sha: 'f'.repeat(40) }), /is not a commit/)
+  const tree = run('rev-parse', 'HEAD^{tree}').trim()
+  await assert.rejects(worktreeDiff(dir, { kind: 'commit', sha: tree }), /is not a commit/)
+})
+
+test('worktreeCommits lists HEAD newest first, with subject, author and time', async (t) => {
+  const { dir, sha } = withWork(t)
+  const commits = await worktreeCommits(dir)
+  assert.deepEqual(commits.map((c) => c.subject), ['second work', 'first work', 'base'])
+  assert.equal(commits[0].sha, sha('HEAD'))
+  assert.equal(commits[0].author, 't')
+  assert.ok(Math.abs(commits[0].at - Date.now()) < 60_000)
+  assert.equal((await worktreeCommits(dir, 2)).length, 2)
+})
+
+test('worktreeCommits: none before the first commit', async (t) => {
+  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  execFileSync('git', ['-C', dir, 'init', '-q'])
+  assert.deepEqual(await worktreeCommits(dir), [])
+})
diff --git a/src/host/gitService.ts b/src/host/gitService.ts
index 6fee7ce..727a729 100644
--- a/src/host/gitService.ts
+++ b/src/host/gitService.ts
@@ -6,10 +6,13 @@ import { promisify } from 'node:util'
 import type {
   ChangedFile,
   ChangedFileStatus,
+  ChangesSource,
+  CommitInfo,
   GitWorktreeInfo,
   WorktreeChanges,
   WorktreeStatus
 } from '../shared/types'
+import { COMMIT_LIST_LIMIT, isCommitSha } from '../shared/review.ts'
 
 const execFileAsync = promisify(execFile)
 
@@ -400,6 +403,75 @@ async function changesBase(path: string): Promise<{ base: string | null; ref: st
   return { base: null, ref: 'HEAD' }
 }
 
+/** What one source's diff runs: `git diff <from> [<to>]`, and whether untracked files count. */
+interface SourceRange {
+  /** The default branch compared against; null otherwise */
+  base: string | null
+  from: string
+  /** A commit's own id; absent = the working tree */
+  to?: string
+  untracked: boolean
+}
+
+async function emptyTree(path: string): Promise<string> {
+  return (await git(path, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
+}
+
+/**
+ * The diff a source names (5c-2). A commit must be a full hex id that names a commit in this
+ * repository; it is compared with its first parent (the empty tree for a root commit).
+ */
+async function sourceRange(path: string, source: ChangesSource): Promise<SourceRange> {
+  if (source.kind === 'branch') {
+    const { base, ref } = await changesBase(path)
+    return { base, from: ref, untracked: true }
+  }
+  if (source.kind === 'uncommitted') {
+    try {
+      await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
+      return { base: null, from: 'HEAD', untracked: true }
+    } catch {
+      return { base: null, from: await emptyTree(path), untracked: true }
+    }
+  }
+  if (!isCommitSha(source.sha)) throw new Error('sha must be a full hex commit id')
+  try {
+    await git(path, ['rev-parse', '--verify', '--quiet', `${source.sha}^{commit}`])
+  } catch {
+    throw new Error(`${source.sha.slice(0, 12)} is not a commit in this repository`)
+  }
+  let parent: string
+  try {
+    parent = (await git(path, ['rev-parse', '--verify', '--quiet', `${source.sha}^1`])).trim()
+  } catch {
+    parent = await emptyTree(path) // a root commit: everything in it is new
+  }
+  return { base: null, from: parent, to: source.sha, untracked: false }
+}
+
+const rangeArgs = (range: SourceRange): string[] => (range.to ? [range.from, range.to] : [range.from])
+
+/**
+ * The newest commits on the worktree's HEAD, newest first; none before the first commit.
+ * Merges are listed too (their diff is against the first parent).
+ */
+export async function worktreeCommits(path: string, limit = COMMIT_LIST_LIMIT): Promise<CommitInfo[]> {
+  try {
+    await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
+  } catch {
+    return []
+  }
+  // NUL between fields and RS after each commit: neither can appear in a subject or a name.
+  const out = await git(path, ['--no-optional-locks', 'log', '-n', String(limit), '--no-color', '--format=%H%x00%an%x00%at%x00%s%x1e', 'HEAD', '--'])
+  const commits: CommitInfo[] = []
+  for (const record of out.split('\x1e')) {
+    const fields = record.replace(/^\n/, '').split('\0')
+    if (fields.length < 4 || !isCommitSha(fields[0])) continue
+    commits.push({ sha: fields[0], author: fields[1], at: Number(fields[2]) * 1000, subject: fields[3].slice(0, 200) })
+  }
+  return commits
+}
+
 function fileStatus(letter: string): ChangedFileStatus {
   if (letter === 'A') return 'added'
   if (letter === 'D') return 'deleted'
@@ -537,18 +609,20 @@ async function untrackedFile(worktreePath: string, path: string): Promise<Change
 }
 
 /**
- * Everything this worktree would add to the default branch: commits since the
- * merge-base plus staged, unstaged and untracked files. Cheap enough to poll
- * for the selected worktree; patches come from worktreeDiff.
+ * The files a source changes (5c-2). The default, the branch: everything this worktree would add
+ * to the default branch, commits since the merge-base plus staged, unstaged and untracked files.
+ * Uncommitted: staged, unstaged and untracked against HEAD. A commit: against its first parent.
+ * Cheap enough to poll for the selected worktree; patches come from worktreeDiff.
  */
-export async function worktreeChanges(path: string): Promise<WorktreeChanges> {
-  const { base, ref } = await changesBase(path)
+export async function worktreeChanges(path: string, source: ChangesSource = { kind: 'branch' }): Promise<WorktreeChanges> {
+  const range = await sourceRange(path, source)
   const tracked = parseDiffRawNumstat(
-    await git(path, ['--no-optional-locks', 'diff', '-M', '-z', '--raw', '--numstat', ref, '--'])
-  )
-  const untracked = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
-    untrackedFile(path, p)
+    await git(path, ['--no-optional-locks', 'diff', '-M', '-z', '--raw', '--numstat', ...rangeArgs(range), '--'])
   )
+  const untracked = range.untracked
+    ? await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) => untrackedFile(path, p))
+    : []
+  const base = range.base
   const files = mergeChangedFiles(tracked, untracked).sort((a, b) =>
     a.path < b.path ? -1 : a.path > b.path ? 1 : 0
   )
@@ -705,17 +779,17 @@ export function limitPatches(
  * as text (binary, too large or unreadable untracked files) have no entry, and
  * neither do patches past the MAX_DIFF_BYTES total.
  */
-export async function worktreeDiff(path: string): Promise<Record<string, string>> {
-  const { ref } = await changesBase(path)
+export async function worktreeDiff(path: string, source: ChangesSource = { kind: 'branch' }): Promise<Record<string, string>> {
+  const range = await sourceRange(path, source)
   const tracked = splitPatch(
-    await git(path, ['--no-optional-locks', 'diff', '-M', ...PATCH_FORMAT_ARGS, ref, '--'])
+    await git(path, ['--no-optional-locks', 'diff', '-M', ...PATCH_FORMAT_ARGS, ...rangeArgs(range), '--'])
   )
   for (const key of Object.keys(tracked)) {
     if (isBinarySection(tracked[key])) delete tracked[key]
   }
-  const candidates = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
-    untrackedFile(path, p)
-  )
+  const candidates = range.untracked
+    ? await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) => untrackedFile(path, p))
+    : []
   const textFiles = candidates
     .filter((f) => !f.binary && !f.tooLarge && !f.unreadable)
     .map((f) => f.path)
````

- [ ] **Step 2: Run the checks**

Run: `node --test scripts/gitChanges.test.mjs`
Expected: 42 tests pass (7 new: uncommitted, branch as default, a commit, a root commit, refused ids and non-commits, the commit list, none before the first commit)

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 2: gitService's change sources (the branch against its base, uncommitted, one commit against its first parent; a commit only as a full hex id that names a commit) and worktreeCommits (the newest 100 on HEAD)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 3: the server and get_review_comments

`checkSource` and `cleanReview` (`server/src/review/draft.ts`), the five `review.*` handlers (Decisions 15–18), `source` on `worktree.changes`/`worktree.diff`, `worktree.commits`, `resetWorktree` keeping a well-formed draft (Decision 10), dispatch, the `review` capability, and the read-only MCP tool `get_review_comments` (Decision 24; 29 tools).

**Files:**
- Modify: `scripts/serverMcpTools.test.mjs`
- Create: `scripts/serverReview.test.mjs`
- Modify: `scripts/serverV2.test.mjs`
- Modify: `server/src/capabilities.ts`
- Modify: `server/src/mcp/tools.ts`
- Modify: `server/src/projects/model.ts`
- Create: `server/src/review/draft.ts`
- Create: `server/src/review/reviewHandlers.ts`
- Modify: `server/src/v2.ts`
- Modify: `server/src/worktreeHandlers.ts`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick 847f868`, or the diff below)

````diff
diff --git a/scripts/serverMcpTools.test.mjs b/scripts/serverMcpTools.test.mjs
index 6c9b5bc..a27ae0c 100644
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -6,6 +6,7 @@ import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import { execFileSync } from 'node:child_process'
+import { writeFileSync } from 'node:fs'
 import { saveConfig } from '../server/src/config.ts'
 import { ConfigStore } from '../server/src/configStore.ts'
 import { GitPoller } from '../server/src/git/poller.ts'
@@ -109,7 +110,7 @@ async function toolSetup(t, opts = {}) {
 
 test('the tool list matches decision 5', () => {
   assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
-    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session', 'get_stack',
+    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session', 'get_review_comments', 'get_stack',
     'list_session_types', 'list_worktrees', 'load_worktree', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
     'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
     'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
@@ -143,6 +144,31 @@ test('branch data tools: tag by name, custom tag, note, ticket, pull request', a
   assert.equal(s.projects.require(s.projectId).settings.linearWorkspace, 'acme')
 })
 
+test("get_review_comments: the worktree's draft, each comment outdated or not against its own source now (5c-2)", async (t) => {
+  const s = await toolSetup(t)
+  assert.deepEqual(await s.call('get_review_comments', { worktree: 'main' }), { worktree: s.projects.require(s.projectId).repositories[0].worktrees[0].id, revision: null, comments: [] })
+  writeFileSync(join(s.a, 'a.txt'), 'one\ntwo\n')
+  const comment = (id, over) => ({ id, source: { kind: 'uncommitted' }, path: 'a.txt', side: 'new', line: 2, lineText: 'two', body: `c ${id}`, at: 1, ...over })
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees[0].review = {
+      revision: 9,
+      comments: [
+        comment('fresh'),
+        comment('changed', { lineText: 'TWO' }),
+        comment('nofile', { path: 'gone.txt' }),
+        comment('nocommit', { source: { kind: 'commit', sha: 'f'.repeat(40) } })
+      ]
+    }
+  })
+  const res = await s.call('get_review_comments', { worktree: 'main' })
+  assert.equal(res.revision, 9)
+  assert.deepEqual(res.comments.map((c) => [c.id, c.outdated]), [['fresh', false], ['changed', true], ['nofile', true], ['nocommit', null]])
+  assert.deepEqual(res.comments[0], { id: 'fresh', file: 'a.txt', side: 'new', line: 2, lineText: 'two', comment: 'c fresh', source: { kind: 'uncommitted' }, sourceLabel: 'Uncommitted changes', outdated: false })
+  // Read-only: the draft is as it was.
+  assert.equal(s.projects.require(s.projectId).repositories[0].worktrees[0].review.comments.length, 4)
+  await assert.rejects(s.call('get_review_comments', { worktree: 'nope' }), (e) => e.code === 'NOT_FOUND')
+})
+
 test('watch_pull_request: on (polled at once), off, and its refusals', async (t) => {
   const polled = []
   let available = true
diff --git a/scripts/serverReview.test.mjs b/scripts/serverReview.test.mjs
new file mode 100644
index 0000000..b2ed5f5
--- /dev/null
+++ b/scripts/serverReview.test.mjs
@@ -0,0 +1,234 @@
+// scripts/serverReview.test.mjs — the Changes tab's review (5c-2): worktree.changes/diff sources,
+// worktree.commits and review.* against real git in a temp dir.
+process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+process.env.GIT_CONFIG_NOSYSTEM = '1'
+
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { execFileSync } from 'node:child_process'
+import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { saveConfig } from '../server/src/config.ts'
+import { ConfigStore } from '../server/src/configStore.ts'
+import { GitPoller } from '../server/src/git/poller.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
+import { resetRuntime } from '../server/src/projects/model.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+import { welcomeCapabilities } from '../server/src/capabilities.ts'
+import { MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH } from '../server/src/sessions/limits.ts'
+import { MAX_REVIEW_BODY, MAX_REVIEW_COMMENTS, reviewPrompt } from '../src/shared/review.ts'
+
+const gitEnv = {
+  ...process.env,
+  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
+}
+const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
+
+async function setup(t) {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-review-')))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  const a = join(dir, 'repos', 'a')
+  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
+  writeFileSync(join(a, 'a.txt'), 'one\ntwo\n')
+  git(a, 'add', '.')
+  git(a, 'commit', '-q', '-m', 'init')
+  writeFileSync(join(a, 'b.txt'), 'b\n')
+  git(a, 'add', '.')
+  git(a, 'commit', '-q', '-m', 'add b')
+  writeFileSync(join(a, 'a.txt'), 'one\nTWO\n')
+  const configPath = join(dir, 'config.json')
+  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
+  const store = new ConfigStore(configPath)
+  const hub = new TopicHub()
+  const saved = []
+  const projects = new ProjectState({ hub, store: { save: (p) => saved.push(p), remove: () => {} }, onSummariesChange: () => {} })
+  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
+  t.after(() => { poller.stop(); store.close() })
+  const subscriber = { send: () => {} }
+  const sessions = { blockPath: () => () => {}, refreshAttention: () => {} }
+  const call = async (method, params) => {
+    const res = await dispatchV2(method, params, { store, hub, subscriber, projects, poller, sessions })
+    return res
+  }
+  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
+  const projectId = created.result.projectId
+  await poller.refresh(a)
+  const project = () => projects.require(projectId)
+  const main = () => project().repositories[0].worktrees[0]
+  const worktreeId = main().id
+  // Two sessions, oldest first, as the SessionManager keeps them.
+  projects.apply(projectId, (d) => {
+    d.repositories[0].worktrees[0].sessions.push(
+      { id: 's-old', title: 'Old', llm: { provider: 'claude' }, queue: [], status: 'idle' },
+      { id: 's-new', title: 'New', llm: { provider: 'claude' }, queue: [], status: 'idle' }
+    )
+  })
+  const ref = { projectId, worktreeId }
+  const ok = async (method, params) => {
+    const res = await call(method, { ...ref, ...params })
+    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res)}`)
+    return res.result
+  }
+  const refused = async (method, params, code) => {
+    const res = await call(method, { ...ref, ...params })
+    assert.equal(res.ok, false, `${method} should fail: ${JSON.stringify(params)}`)
+    assert.equal(res.error.code, code, `${method}: ${res.error.message}`)
+    return res.error.message
+  }
+  return { a, call, ok, refused, project, main, projectId, worktreeId, saved, hub, projects }
+}
+
+const comment = (over = {}) => ({ source: { kind: 'uncommitted' }, path: 'a.txt', side: 'new', line: 2, lineText: 'TWO', body: 'Why caps?', ...over })
+
+test('the welcome lists the review capability', () => {
+  assert.ok(welcomeCapabilities(false).includes('review'))
+})
+
+test('worktree.changes and worktree.diff take a source; the default is the branch', async (t) => {
+  const s = await setup(t)
+  const branch = await s.ok('worktree.changes', {})
+  assert.deepEqual(branch.files.map((f) => f.path), ['a.txt'])
+  assert.deepEqual(await s.ok('worktree.changes', { source: { kind: 'branch' } }), branch)
+  const uncommitted = await s.ok('worktree.changes', { source: { kind: 'uncommitted' } })
+  assert.deepEqual(uncommitted.files.map((f) => f.path), ['a.txt'])
+  const [newest] = await s.ok('worktree.commits', {})
+  const commit = await s.ok('worktree.changes', { source: { kind: 'commit', sha: newest.sha } })
+  assert.deepEqual(commit.files.map((f) => f.path), ['b.txt'])
+  const diff = await s.ok('worktree.diff', { source: { kind: 'commit', sha: newest.sha } })
+  assert.deepEqual(Object.keys(diff), ['b.txt'])
+})
+
+test('worktree.commits lists the newest first', async (t) => {
+  const s = await setup(t)
+  const commits = await s.ok('worktree.commits', {})
+  assert.deepEqual(commits.map((c) => c.subject), ['add b', 'init'])
+  assert.equal(commits[0].sha, git(s.a, 'rev-parse', 'HEAD').trim())
+})
+
+test('a bad source is BAD_REQUEST before git runs; an unknown commit is GIT_ERROR', async (t) => {
+  const s = await setup(t)
+  for (const source of [null, 'branch', { kind: 'all' }, { kind: 'commit' }, { kind: 'commit', sha: 'HEAD' }, { kind: 'commit', sha: '--output=/tmp/x' }, { kind: 'commit', sha: 'A'.repeat(40) }]) {
+    await s.refused('worktree.changes', { source }, 'BAD_REQUEST')
+    await s.refused('worktree.diff', { source }, 'BAD_REQUEST')
+  }
+  await s.refused('worktree.changes', { source: { kind: 'commit', sha: 'f'.repeat(40) } }, 'GIT_ERROR')
+})
+
+test('review.add, edit and remove keep the draft on the worktree, saved with the project', async (t) => {
+  const s = await setup(t)
+  const { commentId } = await s.ok('review.add', comment())
+  const draft = s.main().review
+  assert.equal(draft.comments.length, 1)
+  assert.deepEqual({ ...draft.comments[0], at: 0 }, { id: commentId, ...comment(), at: 0 })
+  assert.ok(s.saved.at(-1).repositories[0].worktrees[0].review, 'saved with the project')
+  const before = draft.revision
+  await s.ok('review.edit', { commentId, body: 'Lower case, please', expected: 'Why caps?' })
+  assert.equal(s.main().review.comments[0].body, 'Lower case, please')
+  assert.ok(s.main().review.revision > before)
+  await s.refused('review.edit', { commentId, body: 'x', expected: 'Why caps?' }, 'CONFLICT')
+  await s.ok('review.remove', { commentId })
+  assert.equal(s.main().review, undefined, 'the last comment removed leaves no draft')
+  await s.refused('review.remove', { commentId }, 'NOT_FOUND')
+})
+
+test('review.add refuses bad comments', async (t) => {
+  const s = await setup(t)
+  const bad = [
+    { path: '' },
+    { path: 'a\nb' },
+    { side: 'both' },
+    { line: 0 },
+    { line: 1.5 },
+    { lineText: 'two\nlines' },
+    { lineText: 'x'.repeat(501) },
+    { body: '   ' },
+    { body: 'x'.repeat(MAX_REVIEW_BODY + 1) },
+    { source: { kind: 'commit', sha: 'nope' } }
+  ]
+  for (const over of bad) await s.refused('review.add', comment(over), 'BAD_REQUEST')
+  assert.equal(s.main().review, undefined)
+  const res = await s.call('review.add', { projectId: s.projectId, worktreeId: 'nope', ...comment() })
+  assert.equal(res.error.code, 'NOT_FOUND')
+})
+
+test('review.add stops at the comment limit and at what fits in one prompt', async (t) => {
+  const s = await setup(t)
+  for (let i = 0; i < MAX_REVIEW_COMMENTS; i++) await s.ok('review.add', comment({ line: i + 1, body: `c${i}` }))
+  assert.match(await s.refused('review.add', comment(), 'BAD_REQUEST'), /at most 100 comments/)
+
+  const t2 = await setup(t)
+  const big = 'x'.repeat(MAX_REVIEW_BODY)
+  let added = 0
+  for (;;) {
+    const res = await t2.call('review.add', { projectId: t2.projectId, worktreeId: t2.worktreeId, ...comment({ line: added + 1, body: big }) })
+    if (!res.ok) {
+      assert.match(res.error.message, /too long to send as one prompt/)
+      break
+    }
+    added++
+  }
+  assert.ok(added > 1 && added < MAX_REVIEW_COMMENTS)
+  assert.ok(reviewPrompt(t2.main().name, t2.main().review.comments).length <= MAX_QUEUE_ENTRY)
+})
+
+test('review.send queues one prompt on the chosen session and clears the draft in one change', async (t) => {
+  const s = await setup(t)
+  await s.ok('review.add', comment())
+  await s.ok('review.add', comment({ source: { kind: 'branch' }, side: 'old', line: 2, lineText: 'two', body: 'Keep' }))
+  const draft = s.main().review
+  const expected = reviewPrompt(s.main().name, draft.comments)
+  const patches = []
+  s.hub.subscribe(`project:${s.projectId}`, { send: (_topic, rev, ops) => patches.push({ rev, ops }) })
+  await s.ok('review.send', { sessionId: 's-old', revision: draft.revision })
+  const main = s.main()
+  assert.equal(main.review, undefined)
+  assert.deepEqual(main.sessions.find((x) => x.id === 's-old').queue, [expected])
+  assert.deepEqual(main.sessions.find((x) => x.id === 's-new').queue, [])
+  assert.equal(patches.length, 1, 'one patch: the queued prompt and the cleared draft together')
+  const paths = patches[0].ops.map((op) => op.path).join(' ')
+  assert.match(paths, /queue/)
+  assert.match(paths, /review/)
+})
+
+test('review.send and review.clear compare the revision; send needs a session of the worktree', async (t) => {
+  const s = await setup(t)
+  await s.ok('review.add', comment())
+  const { revision } = s.main().review
+  await s.refused('review.send', { sessionId: 's-new', revision: revision - 1 }, 'CONFLICT')
+  await s.refused('review.send', { sessionId: 'nope', revision }, 'NOT_FOUND')
+  await s.refused('review.clear', { revision: revision - 1 }, 'CONFLICT')
+  await s.refused('review.send', { sessionId: 's-new', revision: 'x' }, 'BAD_REQUEST')
+  assert.equal(s.main().review.comments.length, 1, 'nothing changed')
+  await s.ok('review.clear', { revision })
+  assert.equal(s.main().review, undefined)
+  await s.refused('review.send', { sessionId: 's-new', revision: 0 }, 'BAD_REQUEST')
+})
+
+test('review.send: a full queue is refused and the draft stays', async (t) => {
+  const s = await setup(t)
+  await s.ok('review.add', comment())
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees[0].sessions.find((x) => x.id === 's-new').queue = Array(MAX_QUEUE_LENGTH).fill('q')
+  })
+  const { revision } = s.main().review
+  assert.match(await s.refused('review.send', { sessionId: 's-new', revision }, 'BAD_REQUEST'), /queue is full/)
+  assert.equal(s.main().review.comments.length, 1)
+  assert.equal(s.main().sessions.find((x) => x.id === 's-new').queue.length, MAX_QUEUE_LENGTH)
+})
+
+test('a review draft survives a restart; one of the wrong shape is dropped', () => {
+  const comment1 = { id: 'c', source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: 'y', at: 1 }
+  const project = (review) => ({
+    id: 'p', name: 'P', settings: {}, globalSessions: [],
+    repositories: [{ id: 'r', name: 'r', path: '/r', branchData: {}, worktrees: [{ id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [], review }] }]
+  })
+  const kept = resetRuntime(project({ revision: 5, comments: [comment1] }))
+  assert.deepEqual(kept.repositories[0].worktrees[0].review, { revision: 5, comments: [comment1] })
+  for (const broken of ['x', { revision: 'a', comments: [] }, { revision: 1, comments: [{ ...comment1, side: 'up' }] }, { revision: 1, comments: [] }]) {
+    assert.equal(resetRuntime(project(broken)).repositories[0].worktrees[0].review, undefined, JSON.stringify(broken))
+  }
+  const mixed = resetRuntime(project({ revision: 2, comments: [comment1, { ...comment1, id: 'd', source: { kind: 'commit', sha: 'HEAD' } }] }))
+  assert.deepEqual(mixed.repositories[0].worktrees[0].review.comments.map((c) => c.id), ['c'])
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 8370537..43ab6ed 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 8f64e89..64299a5 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -5,7 +5,8 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
  * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
  * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
  * `linear` and `voice` say it serves `linear.*` and `voice.*`; whether it has a key is
- * `linear.status`'s and `voice.settings`' answer.
+ * `linear.status`'s and `voice.settings`' answer. `review` (5c-2): the Changes tab's sources and
+ * draft line comments.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -17,7 +18,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.stacks,
   CAPABILITY.linear,
   CAPABILITY.voice,
-  CAPABILITY.skills
+  CAPABILITY.skills,
+  CAPABILITY.review
 ]
 
 /**
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index ee53f02..c65fa4a 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -29,6 +29,11 @@ import { stackState, stackUrls, stripAnsi } from '../../../src/shared/stacks.ts'
 import type { StackStatus } from '../../../src/shared/types'
 import { MAX_INITIAL_LOG } from '../../../src/host/stackService.ts'
 import type { PrWatcher } from '../prWatch/watcher.ts'
+import { isOutdated, sourceKey, sourceLabel } from '../../../src/shared/review.ts'
+import type { ChangesSource } from '../../../src/shared/types'
+
+/** The most distinct sources get_review_comments diffs to say which comments are outdated. */
+const MAX_OUTDATED_SOURCES = 5
 
 const WORKTREE_PARAM = {
   type: 'string',
@@ -353,6 +358,12 @@ export const MCP_TOOLS: ToolDefinition[] = [
       required: ['worktree']
     }
   },
+  {
+    name: 'get_review_comments',
+    description:
+      "Read the user's draft review of a worktree: the line comments they wrote in Trek's Changes tab, not yet sent. Each has the file, the side (new: an added or unchanged line; old: a removed line), the line number, the line's text when the comment was written, the comment, the diff it was written on (the branch against its base, the uncommitted changes, or one commit) and whether it is outdated (its line no longer reads the same in that diff; null when that could not be checked). Read-only: the user sends the review to a session themselves.",
+    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
+  },
   {
     name: 'watch_pull_request',
     description:
@@ -369,7 +380,7 @@ export const MCP_TOOLS: ToolDefinition[] = [
 ]
 
 export const MCP_INSTRUCTIONS =
-  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
+  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_review_comments reads the user's draft line comments on a worktree's changes. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
 
 export interface ToolDeps {
   store: ConfigStore
@@ -792,6 +803,42 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         return { branch, pullRequest: url }
       },
 
+      // Read-only (5c-2). Outdated is worked out against the comment's own source now: one
+      // worktree.diff per source (its path checks and limits), at most MAX_OUTDATED_SOURCES of them.
+      get_review_comments: async (args, project) => {
+        const { worktree } = resolveWorktree(project, args.worktree)
+        const draft = worktree.review
+        if (!draft || draft.comments.length === 0) return { worktree: worktree.id, revision: null, comments: [] }
+        const sources = new Map<string, ChangesSource>()
+        for (const c of draft.comments) sources.set(sourceKey(c.source), c.source)
+        const diffs = new Map<string, Record<string, string> | null>()
+        for (const [key, source] of [...sources].slice(0, MAX_OUTDATED_SOURCES)) {
+          try {
+            diffs.set(key, (await v2('worktree.diff', { worktreeId: worktree.id, source })) as Record<string, string>)
+          } catch {
+            diffs.set(key, null) // a missing worktree, a commit gone: not checked
+          }
+        }
+        return {
+          worktree: worktree.id,
+          revision: draft.revision,
+          comments: draft.comments.map((c) => {
+            const diff = diffs.get(sourceKey(c.source))
+            return {
+              id: c.id,
+              file: c.path,
+              side: c.side,
+              line: c.line,
+              lineText: c.lineText,
+              comment: c.body,
+              source: c.source,
+              sourceLabel: sourceLabel(c.source),
+              outdated: diff ? isOutdated(c, Object.hasOwn(diff, c.path) ? diff[c.path] : undefined) : null
+            }
+          })
+        }
+      },
+
       watch_pull_request: async (args, project) => {
         const { repo, branch } = branchOf(project, args.worktree)
         if (args.watch !== undefined && args.watch !== null && typeof args.watch !== 'boolean') throw bad('watch must be a boolean')
diff --git a/server/src/projects/model.ts b/server/src/projects/model.ts
index ec7a4ba..48aa7c8 100644
--- a/server/src/projects/model.ts
+++ b/server/src/projects/model.ts
@@ -5,6 +5,7 @@ import type { RemoteRepo } from '../../../src/shared/protocolV2'
 import { codedError } from '../errors.ts'
 import { realOrResolved as real } from '../repos.ts'
 import { requireString } from '../validate.ts'
+import { cleanReview } from '../review/draft.ts'
 
 /** The registered repo at `path` (compared by realpath), or PATH_DENIED. */
 export function findRegistered(registry: readonly RemoteRepo[], path: string): RemoteRepo {
@@ -46,11 +47,16 @@ function resetSession(s: Session): Session {
 }
 
 function resetWorktree(w: Worktree): Worktree {
-  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, prNotice: _n, ...rest } = w
-  return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
+  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, prNotice: _n, review: saved, ...rest } = w
+  // The review draft (5c-2) is saved with the project; one of the wrong shape is dropped.
+  const review = saved === undefined ? undefined : cleanReview(saved)
+  return { ...rest, ...(review ? { review } : {}), loaded: false, sessions: w.sessions.map(resetSession) }
 }
 
-/** Nothing runs after a load or an import: statuses idle (except `complete`), worktrees unloaded, git state unknown. */
+/**
+ * Nothing runs after a load or an import: statuses idle (except `complete`), worktrees unloaded, git
+ * state unknown. A worktree's review draft is kept when it has the right shape.
+ */
 export function resetRuntime(project: Project): Project {
   return {
     ...project,
diff --git a/server/src/review/draft.ts b/server/src/review/draft.ts
new file mode 100644
index 0000000..6cf9743
--- /dev/null
+++ b/server/src/review/draft.ts
@@ -0,0 +1,56 @@
+// A review's saved shape and its `source` params (phase 5c-2). Imports nothing from the handlers,
+// so the project model (load and import) and the worktree handlers can use it without a cycle.
+import type { ReviewComment, ReviewDraft } from '../../../src/shared/model/types'
+import type { ChangesSource } from '../../../src/shared/types'
+import {
+  MAX_REVIEW_BODY,
+  MAX_REVIEW_COMMENTS,
+  MAX_REVIEW_LINE,
+  MAX_REVIEW_LINE_TEXT,
+  MAX_REVIEW_PATH,
+  isCommitSha
+} from '../../../src/shared/review.ts'
+import { codedError } from '../errors.ts'
+import { isRecord } from '../validate.ts'
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+/** A `source` param: absent is the branch against its base; a commit needs a full hex id. */
+export function checkSource(value: unknown, field = 'source'): ChangesSource {
+  if (value === undefined) return { kind: 'branch' }
+  if (!isRecord(value)) throw bad(`${field} must be an object`)
+  if (value.kind === 'branch' || value.kind === 'uncommitted') return { kind: value.kind }
+  if (value.kind === 'commit') {
+    if (!isCommitSha(value.sha)) throw bad(`${field}.sha must be a full lowercase hex commit id`)
+    return { kind: 'commit', sha: value.sha }
+  }
+  throw bad(`${field}.kind must be "branch", "uncommitted" or "commit"`)
+}
+
+/**
+ * A saved or imported draft, kept only if it has the shape the handlers write: anything else (a
+ * hand-edited file, another version's) is dropped rather than reaching a client.
+ */
+export function cleanReview(value: unknown): ReviewDraft | undefined {
+  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.comments)) return undefined
+  const comments: ReviewComment[] = []
+  for (const c of value.comments.slice(0, MAX_REVIEW_COMMENTS)) {
+    if (!isRecord(c)) continue
+    let source: ChangesSource
+    try {
+      source = checkSource(c.source)
+    } catch {
+      continue
+    }
+    const ok =
+      typeof c.id === 'string' && c.id !== '' &&
+      typeof c.path === 'string' && c.path !== '' && c.path.length <= MAX_REVIEW_PATH &&
+      (c.side === 'old' || c.side === 'new') &&
+      Number.isInteger(c.line) && (c.line as number) >= 1 && (c.line as number) <= MAX_REVIEW_LINE &&
+      typeof c.lineText === 'string' && c.lineText.length <= MAX_REVIEW_LINE_TEXT &&
+      typeof c.body === 'string' && c.body.trim() !== '' && c.body.length <= MAX_REVIEW_BODY &&
+      typeof c.at === 'number'
+    if (ok) comments.push({ id: c.id as string, source, path: c.path as string, side: c.side as 'old' | 'new', line: c.line as number, lineText: c.lineText as string, body: c.body as string, at: c.at as number })
+  }
+  return comments.length > 0 ? { revision: value.revision as number, comments } : undefined
+}
diff --git a/server/src/review/reviewHandlers.ts b/server/src/review/reviewHandlers.ts
new file mode 100644
index 0000000..f5ad3cb
--- /dev/null
+++ b/server/src/review/reviewHandlers.ts
@@ -0,0 +1,144 @@
+// The Changes tab's review (phase 5c-2): a worktree's draft line comments, kept on the worktree in
+// the project (so every window sees them in the project topic, and they are saved with it), and
+// sent to one of its sessions as one queued prompt. Capability `review`.
+import type { Project, ReviewComment, ReviewDraft, Worktree } from '../../../src/shared/model/types'
+import {
+  MAX_REVIEW_BODY,
+  MAX_REVIEW_COMMENTS,
+  MAX_REVIEW_LINE,
+  MAX_REVIEW_LINE_TEXT,
+  MAX_REVIEW_PATH,
+  reviewPrompt
+} from '../../../src/shared/review.ts'
+import { codedError } from '../errors.ts'
+import { MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
+import { requireString } from '../validate.ts'
+import type { V2Context } from '../v2.ts'
+import { locate } from '../worktreeHandlers.ts'
+import { checkSource } from './draft.ts'
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+/** One line of text: no line breaks, at most `max` characters. */
+function checkLine(value: unknown, field: string, max: number, allowEmpty: boolean): string {
+  const text = requireString(value, field)
+  if (!allowEmpty && text === '') throw bad(`${field} must not be empty`)
+  if (text.length > max) throw bad(`${field} must be at most ${max} characters`)
+  // eslint-disable-next-line no-control-regex
+  if (/[\u0000\n\r]/.test(text)) throw bad(`${field} must be one line`)
+  return text
+}
+
+function checkBody(value: unknown): string {
+  const body = requireString(value, 'body')
+  if (body.trim() === '') throw bad('body must not be empty')
+  if (body.length > MAX_REVIEW_BODY) throw bad(`body must be at most ${MAX_REVIEW_BODY} characters`)
+  return body
+}
+
+/**
+ * The next revision: one more than the last, and never below the clock, so a draft started after
+ * one was sent or discarded never repeats a revision a client may still hold.
+ */
+const nextRevision = (draft: ReviewDraft | undefined, now: number): number => Math.max((draft?.revision ?? 0) + 1, now)
+
+/** The prompt the draft would send must fit in one queued prompt; checked on every add and edit. */
+function checkFits(worktree: Worktree, comments: ReviewComment[]): void {
+  if (reviewPrompt(worktree.name, comments).length > MAX_QUEUE_ENTRY) {
+    throw bad(`the review would be too long to send as one prompt (${MAX_QUEUE_ENTRY} characters)`)
+  }
+}
+
+function findComment(draft: ReviewDraft | undefined, commentId: unknown): ReviewComment {
+  const id = requireString(commentId, 'commentId')
+  const comment = draft?.comments.find((c) => c.id === id)
+  if (!comment) throw codedError('NOT_FOUND', `No review comment with id "${id}"`)
+  return comment
+}
+
+function checkRevision(draft: ReviewDraft | undefined, value: unknown): void {
+  if (!Number.isSafeInteger(value)) throw bad('revision must be an integer')
+  if ((draft?.revision ?? 0) !== value) throw codedError('CONFLICT', 'the review changed since you read it')
+}
+
+/** Runs `fn` on the worktree in a copy of the project (ProjectState.apply): one change, one patch. */
+function onWorktree<T>(ctx: V2Context, p: any, fn: (worktree: Worktree, project: Project) => T): T {
+  return ctx.projects.apply(p.projectId, (d) => fn(locate(d, p.worktreeId).worktree, d))
+}
+
+export const reviewHandlers: Record<string, Handler> = {
+  'review.add': (p, ctx) => {
+    const source = checkSource(p.source)
+    const path = checkLine(p.path, 'path', MAX_REVIEW_PATH, false)
+    if (p.side !== 'old' && p.side !== 'new') throw bad('side must be "old" or "new"')
+    if (!Number.isInteger(p.line) || p.line < 1 || p.line > MAX_REVIEW_LINE) throw bad(`line must be an integer from 1 to ${MAX_REVIEW_LINE}`)
+    const lineText = checkLine(p.lineText, 'lineText', MAX_REVIEW_LINE_TEXT, true)
+    const body = checkBody(p.body)
+    const now = Date.now()
+    const commentId = ctx.projects.newId()
+    onWorktree(ctx, p, (worktree) => {
+      const comments = worktree.review?.comments ?? []
+      if (comments.length >= MAX_REVIEW_COMMENTS) throw bad(`a review holds at most ${MAX_REVIEW_COMMENTS} comments`)
+      const next = [...comments, { id: commentId, source, path, side: p.side, line: p.line, lineText, body, at: now }]
+      checkFits(worktree, next)
+      worktree.review = { revision: nextRevision(worktree.review, now), comments: next }
+    })
+    return { commentId }
+  },
+
+  'review.edit': (p, ctx) => {
+    const body = checkBody(p.body)
+    const now = Date.now()
+    onWorktree(ctx, p, (worktree) => {
+      const comment = findComment(worktree.review, p.commentId)
+      if (p.expected !== undefined && comment.body !== p.expected) throw codedError('CONFLICT', 'the comment changed since you read it')
+      if (comment.body === body) return
+      const next = worktree.review!.comments.map((c) => (c.id === comment.id ? { ...c, body, at: now } : c))
+      checkFits(worktree, next)
+      worktree.review = { revision: nextRevision(worktree.review, now), comments: next }
+    })
+    return null
+  },
+
+  'review.remove': (p, ctx) => {
+    onWorktree(ctx, p, (worktree) => {
+      const comment = findComment(worktree.review, p.commentId)
+      const next = worktree.review!.comments.filter((c) => c.id !== comment.id)
+      if (next.length === 0) delete worktree.review
+      else worktree.review = { revision: nextRevision(worktree.review, Date.now()), comments: next }
+    })
+    return null
+  },
+
+  'review.clear': (p, ctx) => {
+    onWorktree(ctx, p, (worktree) => {
+      checkRevision(worktree.review, p.revision)
+      delete worktree.review
+    })
+    return null
+  },
+
+  /**
+   * The draft goes onto the session's queue as one prompt and the draft is cleared, in the same
+   * change to the project: there is no state where it was queued and still drafted, or cleared and
+   * not queued. Queued only, like every prompt: the user sends it from the session's queue.
+   */
+  'review.send': (p, ctx) => {
+    const sessionId = requireString(p.sessionId, 'sessionId')
+    onWorktree(ctx, p, (worktree) => {
+      checkRevision(worktree.review, p.revision)
+      const draft = worktree.review
+      if (!draft || draft.comments.length === 0) throw bad('the review has no comments')
+      const session = worktree.sessions.find((s) => s.id === sessionId)
+      if (!session) throw codedError('NOT_FOUND', `No session with id "${sessionId}" in this worktree`)
+      if (session.queue.length >= MAX_QUEUE_LENGTH) throw bad(`the queue is full (${MAX_QUEUE_LENGTH} prompts)`)
+      const text = reviewPrompt(worktree.name, draft.comments)
+      if (text.length > MAX_QUEUE_ENTRY) throw bad(`the review is too long to send as one prompt (${MAX_QUEUE_ENTRY} characters)`)
+      session.queue = [...session.queue, text]
+      delete worktree.review
+    })
+    return null
+  }
+}
diff --git a/server/src/v2.ts b/server/src/v2.ts
index 74badc6..ba5d442 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -2,7 +2,7 @@
 // projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
 // the v2 pty.* stream, docker, env and stack on the server's machine (machineHandlers.ts), and
 // Linear, voice and skills with the server's own keys and disk (integrationHandlers.ts), and the
-// pull request watch (prWatchHandlers.ts).
+// pull request watch (prWatchHandlers.ts), and the Changes tab's review (reviewHandlers.ts).
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { IntegrationsChangedEvent, TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -16,6 +16,7 @@ import { sessionHandlers } from './sessionHandlers.ts'
 import { machineHandlers, type EventSink, type Machine } from './integrations/machineHandlers.ts'
 import { integrationHandlers } from './integrations/integrationHandlers.ts'
 import { prWatchHandlers } from './prWatch/prWatchHandlers.ts'
+import { reviewHandlers } from './review/reviewHandlers.ts'
 import type { PrWatcher } from './prWatch/watcher.ts'
 import type { Integrations } from './integrations/integrations.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
@@ -303,7 +304,8 @@ const handlers: Record<string, Handler> = {
   ...sessionHandlers,
   ...machineHandlers,
   ...integrationHandlers,
-  ...prWatchHandlers
+  ...prWatchHandlers,
+  ...reviewHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/server/src/worktreeHandlers.ts b/server/src/worktreeHandlers.ts
index 1e936af..ddb61b6 100644
--- a/server/src/worktreeHandlers.ts
+++ b/server/src/worktreeHandlers.ts
@@ -10,6 +10,7 @@ import { assertNotRepository, findRegistered, repoIn } from './projects/model.ts
 import { realOrResolved as real } from './repos.ts'
 import { requireAbsolutePath, requireBoolean, requireBranch, requireString } from './validate.ts'
 import type { V2Context } from './v2.ts'
+import { checkSource } from './review/draft.ts'
 
 type Handler = (params: any, ctx: V2Context) => unknown
 
@@ -74,7 +75,7 @@ async function checkBranchName(repoPath: string, branch: string, mustExist: bool
 }
 
 /** The worktree with this id and its repository; NOT_FOUND if unknown. */
-function locate(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
+export function locate(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
   const id = requireString(worktreeId, 'worktreeId')
   for (const repo of project.repositories) {
     const worktree = repo.worktrees.find((w) => w.id === id)
@@ -234,14 +235,23 @@ export const worktreeHandlers: Record<string, Handler> = {
     return null
   },
 
+  // `source` (5c-2): the branch against its base (the default), the uncommitted work, or one commit.
   'worktree.changes': async (p, ctx) => {
+    const source = checkSource(p.source)
     const { worktree } = present(ctx, p)
-    return viaGit(() => gitService.worktreeChanges(worktree.path))
+    return viaGit(() => gitService.worktreeChanges(worktree.path, source))
   },
 
   'worktree.diff': async (p, ctx) => {
+    const source = checkSource(p.source)
     const { worktree } = present(ctx, p)
-    return viaGit(() => gitService.worktreeDiff(worktree.path))
+    return viaGit(() => gitService.worktreeDiff(worktree.path, source))
+  },
+
+  /** The newest commits on its HEAD, for the Changes tab's commit picker (5c-2) */
+  'worktree.commits': async (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return viaGit(() => gitService.worktreeCommits(worktree.path))
   },
 
   // A delete's fresh check before it destroys a worktree's dev stack or VM (the poll's `dirty` can be 30 s old).
````

- [ ] **Step 2: Run the checks**

Run: `node --test scripts/serverReview.test.mjs scripts/serverV2.test.mjs scripts/serverMcpTools.test.mjs && (cd server && npm run typecheck)`
Expected: 11 + 37 + 42 tests pass; the server typecheck is clean

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 3: the server: worktree.changes/diff take a source, worktree.commits, review.add/edit/remove/clear/send (the draft on the worktree, saved with the project; send queues one prompt and clears the draft in one change), a saved draft of the wrong shape dropped at load and import, the review capability, the read-only get_review_comments MCP tool" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 4: the app

`features.review`, the backend's `git.changes/diff(loc, source?)`, `git.commits`, `review.*`, the projected `worktreeReviews`, and the Changes tab: the source picker, numbered diff lines with a `+` gutter, comments under their lines, outdated ones at the file's top, the review bar (Send to session ▾ newest first, Discard, the comments not on this diff), and the update hint for an older server (Decisions 19–23, 25, 26).

**Files:**
- Modify: `scripts/backendFeatures.test.mjs`
- Modify: `scripts/v2Backend.test.mjs`
- Modify: `scripts/v2Projector.test.mjs`
- Modify: `src/renderer/src/backend.ts`
- Modify: `src/renderer/src/backendFeatures.ts`
- Modify: `src/renderer/src/components/ChangesPanel.tsx`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/v2/backendV2.ts`
- Modify: `src/renderer/src/v2/projector.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick babbbd0`, or the diff below)

````diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 5aef9c9..be1d054 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -24,7 +24,12 @@ test('an empty window has no feature (4e: no file windows)', () => {
 
 test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+})
+
+test('the Changes tab review follows review (5c-2): an older server has only the branch view', () => {
+  assert.equal(v2Features(['review']).review, true)
+  assert.equal(v2Features(['mcp', 'linear', 'voice', 'skills', 'local'], { localEntry: true }).review, false)
 })
 
 test('the pull request watch follows prWatch (5c-1): listed only while gh is signed in on the server', () => {
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 241ef97..4f389b2 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -227,6 +227,41 @@ test("docker, env and stacks go to the server by id: a worktree by the store's p
   ])
 })
 
+test("the Changes tab's source, commits and review go to the window's server by the worktree's id (5c-2)", async () => {
+  const replies = {
+    'worktree.changes': { base: null, files: [] },
+    'worktree.diff': {},
+    'worktree.commits': [{ sha: 'a'.repeat(40), subject: 's', author: 't', at: 1 }],
+    'review.add': { commentId: 'c9' }
+  }
+  const { backend, calls } = setup({ replies })
+  const loc = { path: '/r-feat' }
+  const commit = { kind: 'commit', sha: 'a'.repeat(40) }
+  await backend.git.changes(loc)
+  await backend.git.changes(loc, { kind: 'uncommitted' })
+  await backend.git.diff(loc, commit)
+  assert.equal((await backend.git.commits(loc)).length, 1)
+  const comment = { source: commit, path: 'a.txt', side: 'new', line: 2, lineText: 'x', body: 'Why?' }
+  assert.equal(await backend.review.add('/r-feat', comment), 'c9')
+  await backend.review.edit('/r-feat', 'c9', 'Why not?', 'Why?')
+  await backend.review.remove('/r-feat', 'c9')
+  await backend.review.clear('/r-feat', 7)
+  await backend.review.send('/r-feat', 's1', 8)
+  const ref = { projectId: 'p1', worktreeId: 'w2' }
+  assert.deepEqual(calls, [
+    // No source: the params an older server already takes.
+    ['worktree.changes', ref],
+    ['worktree.changes', { ...ref, source: { kind: 'uncommitted' } }],
+    ['worktree.diff', { ...ref, source: commit }],
+    ['worktree.commits', ref],
+    ['review.add', { ...ref, ...comment }],
+    ['review.edit', { ...ref, commentId: 'c9', body: 'Why not?', expected: 'Why?' }],
+    ['review.remove', { ...ref, commentId: 'c9' }],
+    ['review.clear', { ...ref, revision: 7 }],
+    ['review.send', { ...ref, sessionId: 's1', revision: 8 }]
+  ])
+})
+
 test('a worktree path the projection does not know is refused here, and nothing is sent', async () => {
   const { backend, calls } = setup()
   await assert.rejects(backend.env.up({ path: '/elsewhere' }, { enabled: true }, undefined), (err) => err.code === 'NOT_FOUND')
diff --git a/scripts/v2Projector.test.mjs b/scripts/v2Projector.test.mjs
index e4f4b0a..2ecea14 100644
--- a/scripts/v2Projector.test.mjs
+++ b/scripts/v2Projector.test.mjs
@@ -217,6 +217,16 @@ test('a missing worktree on the same branch keeps its own PR notice; the live on
   assert.equal(ids.worktrees[ids.worktreeByPath['/r/one-gone']].worktreeId, 'w-gone')
 })
 
+test("a worktree's review draft (5c-2) is projected by the worktree's path, as the server has it", () => {
+  const p = fixture()
+  const feat = p.repositories[0].worktrees.find((w) => w.id === 'w-feat')
+  const review = { revision: 3, comments: [{ id: 'c1', source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: 'y', at: 1 }] }
+  feat.review = review
+  const [one, two] = projectV2(p).slice.project.repositories
+  assert.deepEqual(one.worktreeReviews, { '/r/one-feat': review })
+  assert.deepEqual(two.worktreeReviews, {})
+})
+
 test('settings spread into the project file; no servers', () => {
   const { project } = projectV2(fixture()).slice
   assert.equal(project.version, 3)
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index 991f2f3..6f75b44 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -16,6 +16,8 @@ import { NO_FEATURES, type BackendFeatures } from './backendFeatures'
 import { errorText } from './v2/errors'
 import type { LlmSelection } from '../../shared/providers/types'
 import type {
+  ChangesSource,
+  CommitInfo,
   ComposeAction,
   ContainerAction,
   ContainerInfo,
@@ -43,6 +45,10 @@ import type {
   WorktreeLocator
 } from '../../shared/types'
 import type { VoiceSummaryEvent } from '../../shared/protocolV2'
+import type { ReviewComment } from '../../shared/model/types'
+
+/** What `review.add` takes: a comment before the server gives it an id and a time. */
+export type NewReviewComment = Omit<ReviewComment, 'id' | 'at'>
 
 export type { BackendFeatures, FeatureName } from './backendFeatures'
 
@@ -106,8 +112,11 @@ export interface WindowBackend {
   readonly git: {
     listWorktrees(repoId: string): Promise<GitWorktreeInfo[]>
     listBranches(repoId: string): Promise<string[]>
-    changes(loc: WorktreeLocator): Promise<WorktreeChanges>
-    diff(loc: WorktreeLocator): Promise<Record<string, string>>
+    /** `source` (feature `review`) defaults to the branch against its base */
+    changes(loc: WorktreeLocator, source?: ChangesSource): Promise<WorktreeChanges>
+    diff(loc: WorktreeLocator, source?: ChangesSource): Promise<Record<string, string>>
+    /** The newest 100 commits on the worktree's HEAD, newest first (feature `review`) */
+    commits(loc: WorktreeLocator): Promise<CommitInfo[]>
     pull(loc: WorktreeLocator, branch: string): Promise<void>
     push(loc: WorktreeLocator, branch: string): Promise<void>
     /** A fresh `git status` of the worktree on its server; null when git cannot read it */
@@ -173,6 +182,21 @@ export interface WindowBackend {
   readonly skills: {
     list(loc: WorktreeLocator): Promise<SkillInfo[]>
   }
+  /**
+   * The Changes tab's draft review of the worktree at `path` (feature `review`, 5c-2). The draft
+   * itself arrives in the store (`worktreeReviews`) with the server's patch; these only ask.
+   */
+  readonly review: {
+    /** Resolves the new comment's id */
+    add(path: string, comment: NewReviewComment): Promise<string>
+    /** `expected`: the body the edit started from */
+    edit(path: string, commentId: string, body: string, expected: string): Promise<void>
+    remove(path: string, commentId: string): Promise<void>
+    /** `revision`: the draft as shown */
+    clear(path: string, revision: number): Promise<void>
+    /** Queues the draft on the session as one prompt and clears it; `revision`: the draft as shown */
+    send(path: string, terminalId: string, revision: number): Promise<void>
+  }
   /** Branch data; null or an empty text clears the value */
   readonly branch: {
     setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
@@ -249,7 +273,7 @@ export const idleBackend: WindowBackend = {
     dismissDecision: noProject
   },
   worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject },
-  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, pull: noProject, push: noProject, dirty: noProject },
+  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, commits: noProject, pull: noProject, push: noProject, dirty: noProject },
   docker: { list: noProject, container: noProject, compose: noProject, onLog: () => () => {} },
   env: {
     check: noProject,
@@ -275,6 +299,7 @@ export const idleBackend: WindowBackend = {
     onChanged: () => () => {}
   },
   skills: { list: noProject },
+  review: { add: noProject, edit: noProject, remove: noProject, clear: noProject, send: noProject },
   branch: {
     setTag: noProject,
     setCustomTag: noProject,
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index 2077a4d..f8d2a31 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -10,6 +10,7 @@ export type FeatureName =
   | 'voice'
   | 'skills'
   | 'prWatch'
+  | 'review'
   | 'moveWorktree'
   | 'reveal'
   | 'openInEditor'
@@ -28,6 +29,7 @@ export const FEATURE_NAMES: readonly FeatureName[] = [
   'voice',
   'skills',
   'prWatch',
+  'review',
   'moveWorktree',
   'reveal',
   'openInEditor',
@@ -52,6 +54,8 @@ export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map
  *   capability, on any server.
  * - The pull request watch (5c-1) runs gh on the server's machine: it needs
  *   `prWatch`, which the server lists only while gh is signed in there.
+ * - The Changes tab's sources and line comments (5c-2) need `review`: an older server's
+ *   `worktree.changes` knows only the branch against its base.
  * - The Global panel needs `mcp`.
  * - Docker, environments and stacks run on the server's machine (5a): each
  *   needs its capability, on any server.
@@ -67,6 +71,7 @@ export const V2_FEATURES: BackendFeatures = {
   voice: true,
   skills: true,
   prWatch: true,
+  review: true,
   moveWorktree: false,
   reveal: true,
   openInEditor: true,
@@ -90,7 +95,8 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   linear: 'linear',
   voice: 'voice',
   skills: 'skills',
-  prWatch: 'prWatch'
+  prWatch: 'prWatch',
+  review: 'review'
 }
 
 /**
diff --git a/src/renderer/src/components/ChangesPanel.tsx b/src/renderer/src/components/ChangesPanel.tsx
index e01016e..b02b930 100644
--- a/src/renderer/src/components/ChangesPanel.tsx
+++ b/src/renderer/src/components/ChangesPanel.tsx
@@ -1,7 +1,17 @@
-import { memo, useEffect, useMemo, useRef, useState } from 'react'
-import { initiallyExpanded, lineClass, missingPatchNote, patchBody } from '../../../shared/changes'
+import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
+import { initiallyExpanded, missingPatchNote, numberedLines, patchBody, type NumberedLine } from '../../../shared/changes'
+import {
+  BRANCH_SOURCE,
+  MAX_REVIEW_BODY,
+  placeComments,
+  reviewLineText,
+  sameSource,
+  sourceKey,
+  sourceLabel
+} from '../../../shared/review'
 import { getBackend } from '../backend'
-import type { ChangedFile, WorktreeChanges } from '../../../shared/types'
+import type { ReviewComment, ReviewDraft } from '../../../shared/model/types'
+import type { ChangedFile, ChangesSource, CommitInfo, WorktreeChanges } from '../../../shared/types'
 
 const CHANGES_POLL_MS = 5000
 
@@ -16,9 +26,10 @@ export interface ChangesState {
   diffLoading: boolean
 }
 
-/** What the hook stores: the state plus the worktree it belongs to. */
+/** What the hook stores: the state plus the worktree and source it belongs to. */
 interface OwnedState extends ChangesState {
   path: string | undefined
+  sourceKey: string
 }
 
 const EMPTY: ChangesState = {
@@ -42,16 +53,23 @@ const errorMessage = (err: unknown): string => (err instanceof Error ? err.messa
 export function useWorktreeChanges(
   path: string | undefined,
   paused: boolean,
-  panelOpen: boolean
+  panelOpen: boolean,
+  /** What to compare (feature `review`, 5c-2); undefined asks without one, as before */
+  source?: ChangesSource
 ): ChangesState {
-  const [state, setState] = useState<OwnedState>({ ...EMPTY, path })
+  const key = source ? sourceKey(source) : ''
+  const [state, setState] = useState<OwnedState>({ ...EMPTY, path, sourceKey: key })
+  // The effect re-runs on the key; this holds the source it stands for.
+  const sourceRef = useRef(source)
+  sourceRef.current = source
   const panelOpenRef = useRef(panelOpen)
   panelOpenRef.current = panelOpen
   const wakeRef = useRef<(() => void) | null>(null)
 
   useEffect(() => {
-    setState({ ...EMPTY, path })
+    setState({ ...EMPTY, path, sourceKey: key })
     if (!path || paused) return undefined
+    const asked = sourceRef.current
 
     let cancelled = false
     let timer: ReturnType<typeof setTimeout> | undefined
@@ -81,7 +99,7 @@ export function useWorktreeChanges(
       try {
         let changes: WorktreeChanges
         try {
-          changes = await getBackend().git.changes({ path })
+          changes = await getBackend().git.changes({ path }, asked)
         } catch (err) {
           if (cancelled) return
           lastSummary = null
@@ -112,7 +130,7 @@ export function useWorktreeChanges(
         if (open && diffFailedFor !== summary) {
           if (diffsFor !== summary) update({ diffLoading: true })
           try {
-            const diffs = await getBackend().git.diff({ path })
+            const diffs = await getBackend().git.diff({ path }, asked)
             if (cancelled) return
             const json = JSON.stringify(diffs)
             const same = json === diffsJson
@@ -165,16 +183,17 @@ export function useWorktreeChanges(
       wakeRef.current = null
       clearTimeout(timer)
     }
-  }, [path, paused])
+  }, [path, paused, key])
 
   useEffect(() => {
     if (panelOpen) wakeRef.current?.()
   }, [panelOpen])
 
-  // The first render after switching worktree still holds the old one's state.
-  return state.path === path ? state : EMPTY
+  // The first render after switching worktree or source still holds the old one's state.
+  return state.path === path && state.sourceKey === key ? state : EMPTY
 }
 
+
 const STATUS_LETTER: Record<ChangedFile['status'], string> = {
   added: 'A',
   modified: 'M',
@@ -182,46 +201,349 @@ const STATUS_LETTER: Record<ChangedFile['status'], string> = {
   renamed: 'R'
 }
 
-const FileDiff = memo(function FileDiff({ file, patch, loading, unavailable }: {
+/** One of the worktree's open sessions a review can be sent to. */
+export interface ReviewTarget {
+  terminalId: string
+  title: string
+}
+
+/** The review's part of the panel (feature `review`, 5c-2). */
+export interface ReviewProps {
+  /** The server has `review`: sources and line comments */
+  enabled: boolean
+  /** A connected server without `review` (older than 5c-2): the tab says to update it */
+  needsUpdate: boolean
+  /** The worktree's draft, as the server has it (the store's `worktreeReviews`) */
+  draft: ReviewDraft | undefined
+  /** The worktree's open sessions, newest first */
+  targets: ReviewTarget[]
+  /** What the Send button says when there is no session to send to */
+  noTargets: string
+  offline: boolean
+}
+
+/** Where a new comment goes. */
+interface NewAt {
+  path: string
+  side: 'old' | 'new'
+  line: number
+  lineText: string
+}
+
+/** The one comment being written or edited. */
+type Editor = ({ kind: 'new' } & NewAt) | { kind: 'edit'; commentId: string }
+
+interface ReviewActions {
+  editor: Editor | null
+  setEditor(editor: Editor | null): void
+  save(text: string): Promise<boolean>
+  remove(comment: ReviewComment): void
+  busy: boolean
+  /** Line comments can be written: feature on, online */
+  canWrite: boolean
+}
+
+function CommentEditor({ initial, actions }: { initial: string; actions: ReviewActions }): React.JSX.Element {
+  const [text, setText] = useState(initial)
+  const save = (): void => {
+    if (text.trim() === '' || actions.busy) return
+    void actions.save(text)
+  }
+  return (
+    <div className="review-editor">
+      <textarea
+        autoFocus
+        value={text}
+        maxLength={MAX_REVIEW_BODY}
+        placeholder="Comment on this line"
+        onChange={(e) => setText(e.target.value)}
+        onKeyDown={(e) => {
+          if (e.key === 'Escape') actions.setEditor(null)
+          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
+        }}
+      />
+      <div className="review-editor-actions">
+        <button className="review-btn" disabled={actions.busy || text.trim() === ''} onClick={save}>
+          {initial ? 'Save' : 'Add comment'}
+        </button>
+        <button className="review-btn quiet" onClick={() => actions.setEditor(null)}>
+          Cancel
+        </button>
+      </div>
+    </div>
+  )
+}
+
+function CommentView({ comment, actions, where }: { comment: ReviewComment; actions: ReviewActions; where?: string }): React.JSX.Element {
+  const editing = actions.editor?.kind === 'edit' && actions.editor.commentId === comment.id
+  return (
+    <div className="review-comment" data-comment-id={comment.id}>
+      {where && <div className="review-comment-where">{where}</div>}
+      {editing ? (
+        <CommentEditor initial={comment.body} actions={actions} />
+      ) : (
+        <>
+          <div className="review-comment-body">{comment.body}</div>
+          {actions.canWrite && (
+            <div className="review-comment-actions">
+              <button className="review-link" disabled={actions.busy} onClick={() => actions.setEditor({ kind: 'edit', commentId: comment.id })}>
+                Edit
+              </button>
+              <button className="review-link" disabled={actions.busy} onClick={() => actions.remove(comment)}>
+                Delete
+              </button>
+            </div>
+          )}
+        </>
+      )}
+    </div>
+  )
+}
+
+/** Where a comment was written, for one that is not on a line shown here. */
+const placeOf = (c: ReviewComment): string => `${c.side === 'old' ? 'removed line' : 'line'} ${c.line}: ${c.lineText}`
+
+const FileDiff = memo(function FileDiff({ file, patch, loading, unavailable, comments, actions }: {
   file: ChangedFile
   patch: string | undefined
   loading: boolean
   unavailable: boolean
+  /** This file's comments on this source */
+  comments: readonly ReviewComment[]
+  actions: ReviewActions
 }): React.JSX.Element {
-  const lines = useMemo(() => (patch === undefined ? [] : patchBody(patch)), [patch])
-  if (file.binary) return <div className="changes-note">Binary file changed</div>
-  if (file.tooLarge) return <div className="changes-note">File too large to show</div>
-  if (file.unreadable) return <div className="changes-note">File can't be read</div>
-  if (patch === undefined) {
-    return (
-      <div className="changes-note">
-        {missingPatchNote(file, { loading, diffError: unavailable })}
-      </div>
-    )
+  const lines = useMemo(() => (patch === undefined ? [] : numberedLines(patchBody(patch))), [patch])
+  const placed = useMemo(() => placeComments(comments, lines), [comments, lines])
+  const note = file.binary
+    ? 'Binary file changed'
+    : file.tooLarge
+      ? 'File too large to show'
+      : file.unreadable
+        ? "File can't be read"
+        : patch === undefined
+          ? missingPatchNote(file, { loading, diffError: unavailable })
+          : null
+  const outdated = patch === undefined ? comments : placed.outdated
+  const newAt = (l: NumberedLine): NewAt | null =>
+    l.side && l.line !== undefined ? { path: file.path, side: l.side, line: l.line, lineText: reviewLineText(l.text) } : null
+  const editingHere = (at: NewAt): boolean => {
+    const e = actions.editor
+    return e?.kind === 'new' && e.path === at.path && e.side === at.side && e.line === at.line
   }
   return (
-    <div className="changes-diff">
-      <div className="changes-diff-inner">
-        {lines.map((line, i) => (
-          <div key={i} className={`changes-line ${lineClass(line)}`}>
-            {line || ' '}
+    <>
+      {outdated.length > 0 && (
+        <div className="review-outdated">
+          <div className="review-outdated-title">Outdated: {outdated.length === 1 ? 'its line has' : 'their lines have'} changed</div>
+          {outdated.map((c) => (
+            <CommentView key={c.id} comment={c} actions={actions} where={placeOf(c)} />
+          ))}
+        </div>
+      )}
+      {note !== null ? (
+        <div className="changes-note">{note}</div>
+      ) : (
+        <div className="changes-diff">
+          <div className="changes-diff-inner">
+            {lines.map((line, i) => {
+              const at = newAt(line)
+              const here = placed.byLine.get(i)
+              const kind = line.kind === 'context' || line.kind === 'note' ? '' : line.kind
+              const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'context' ? ' ' : ''
+              return (
+                <div key={i} className="changes-row">
+                  <div className={`changes-line ${kind}`} data-side={at?.side} data-line={at?.line}>
+                    {at && actions.canWrite && (
+                      <button
+                        className="review-add"
+                        title="Comment on this line"
+                        disabled={actions.busy}
+                        onClick={() => actions.setEditor({ kind: 'new', ...at })}
+                      >
+                        +
+                      </button>
+                    )}
+                    {line.kind === 'hunk' || line.kind === 'note' ? line.text || ' ' : `${marker}${line.text}` || ' '}
+                  </div>
+                  {here?.map((c) => <CommentView key={c.id} comment={c} actions={actions} />)}
+                  {at && editingHere(at) && <CommentEditor initial="" actions={actions} />}
+                </div>
+              )
+            })}
           </div>
-        ))}
+        </div>
+      )}
+    </>
+  )
+})
+
+/** The source picker: the branch against its base, the uncommitted work, or one of the newest commits. */
+function SourcePicker({ path, source, onSource, base }: {
+  path: string
+  source: ChangesSource
+  onSource(source: ChangesSource): void
+  base: string | null | undefined
+}): React.JSX.Element {
+  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
+  const [error, setError] = useState<string | null>(null)
+  // Only the branch's own summary names its base: the option keeps it while another source is shown.
+  const lastBase = useRef<string | null>(null)
+  if (base) lastBase.current = base
+  const load = async (): Promise<CommitInfo[] | null> => {
+    try {
+      const list = await getBackend().git.commits({ path })
+      setCommits(list)
+      setError(null)
+      return list
+    } catch (err) {
+      setError(getBackend().errors.inline(err) ?? errorMessage(err))
+      return null
+    }
+  }
+  useEffect(() => {
+    setCommits(null)
+    if (source.kind === 'commit') void load()
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, [path])
+  const chosen = source.kind === 'commit' ? source.sha : ''
+  const listed = commits ?? []
+  // A commit picked before the list was re-read (or no longer among the newest) still shows.
+  const options = chosen && !listed.some((c) => c.sha === chosen) ? [{ sha: chosen, subject: '', author: '', at: 0 }, ...listed] : listed
+  return (
+    <span className="changes-source">
+      <select
+        className="changes-source-kind"
+        value={source.kind}
+        onChange={async (e) => {
+          const kind = e.target.value
+          if (kind === 'commit') {
+            const list = commits ?? (await load())
+            if (list && list.length > 0) onSource({ kind: 'commit', sha: list[0].sha })
+          } else onSource(kind === 'uncommitted' ? { kind: 'uncommitted' } : BRANCH_SOURCE)
+        }}
+      >
+        <option value="branch">{lastBase.current ? `Branch vs ${lastBase.current}` : 'Branch vs its base'}</option>
+        <option value="uncommitted">Uncommitted only</option>
+        <option value="commit">One commit…</option>
+      </select>
+      {source.kind === 'commit' && (
+        <select
+          className="changes-source-commit"
+          value={chosen}
+          onFocus={() => void load()}
+          onChange={(e) => onSource({ kind: 'commit', sha: e.target.value })}
+        >
+          {options.map((c) => (
+            <option key={c.sha} value={c.sha}>
+              {c.sha.slice(0, 7)} {c.subject}
+            </option>
+          ))}
+        </select>
+      )}
+      {error && <span className="changes-error"> {error}</span>}
+    </span>
+  )
+}
+
+/** Sends the draft to one of the worktree's sessions, or discards it. */
+function ReviewBar({ draft, review, elsewhere, actions, onSend, onDiscard, error }: {
+  draft: ReviewDraft | undefined
+  review: ReviewProps
+  /** Comments not shown on this diff: another source, or a file not in it */
+  elsewhere: ReviewComment[]
+  actions: ReviewActions
+  onSend(target: ReviewTarget): void
+  onDiscard(): void
+  error: string | null
+}): React.JSX.Element | null {
+  const [menu, setMenu] = useState(false)
+  const [confirmDiscard, setConfirmDiscard] = useState(false)
+  const [showElsewhere, setShowElsewhere] = useState(false)
+  const count = draft?.comments.length ?? 0
+  useEffect(() => {
+    setConfirmDiscard(false)
+    if (count === 0) setMenu(false)
+  }, [count, draft?.revision])
+  if (count === 0 && !error) return null
+  const canSend = count > 0 && review.targets.length > 0 && !review.offline && !actions.busy
+  const sendTitle =
+    count === 0 ? 'No comments to send' : review.targets.length === 0 ? review.noTargets : review.offline ? 'Server disconnected' : 'Queue the comments on a session as one prompt'
+  return (
+    <div className="review-bar">
+      <div className="review-bar-row">
+        <span className="review-count">
+          Review · {count} {count === 1 ? 'comment' : 'comments'}
+        </span>
+        {elsewhere.length > 0 && (
+          <button className="review-link review-elsewhere-toggle" onClick={() => setShowElsewhere((v) => !v)}>
+            {elsewhere.length} not on this diff {showElsewhere ? '▾' : '▸'}
+          </button>
+        )}
+        <span className="review-bar-spacer" />
+        <span className="review-send-wrap">
+          <button className="review-btn review-send" disabled={!canSend} title={sendTitle} onClick={() => setMenu((m) => !m)}>
+            Send to session ▾
+          </button>
+          {menu && canSend && (
+            <div className="review-send-menu">
+              {review.targets.map((t) => (
+                <button
+                  key={t.terminalId}
+                  className="review-send-target"
+                  onClick={() => {
+                    setMenu(false)
+                    onSend(t)
+                  }}
+                >
+                  {t.title}
+                </button>
+              ))}
+            </div>
+          )}
+        </span>
+        {count > 0 &&
+          (confirmDiscard ? (
+            <button className="review-btn danger review-discard-confirm" disabled={actions.busy || review.offline} onClick={onDiscard}>
+              Discard {count} {count === 1 ? 'comment' : 'comments'}?
+            </button>
+          ) : (
+            <button className="review-btn quiet review-discard" disabled={actions.busy || review.offline} onClick={() => setConfirmDiscard(true)}>
+              Discard
+            </button>
+          ))}
       </div>
+      {error && <div className="changes-error review-error">{error}</div>}
+      {showElsewhere && (
+        <div className="review-elsewhere">
+          {elsewhere.map((c) => (
+            <CommentView key={c.id} comment={c} actions={actions} where={`${sourceLabel(c.source)} · ${c.path}, ${placeOf(c)}`} />
+          ))}
+        </div>
+      )}
     </div>
   )
-})
+}
 
 interface Props {
   visible: boolean
   paused: boolean
   state: ChangesState
+  path: string
+  source: ChangesSource
+  onSource(source: ChangesSource): void
+  review: ReviewProps
 }
 
+const NO_COMMENTS: readonly ReviewComment[] = []
+
 export const ChangesPanel = memo(function ChangesPanel({
   visible,
   paused,
-  state
+  state,
+  path,
+  source,
+  onSource,
+  review
 }: Props): React.JSX.Element {
   const { changes, diffs, error, diffError, diffLoading } = state
   // Only the user's own toggles are stored, so a file keeps its default until touched.
@@ -231,19 +553,108 @@ export const ChangesPanel = memo(function ChangesPanel({
     [changes]
   )
   const diffsPending = diffLoading || (diffs === null && !diffError)
+  const [editor, setEditor] = useState<Editor | null>(null)
+  const [busy, setBusy] = useState(false)
+  const [reviewError, setReviewError] = useState<string | null>(null)
+  const draft = review.enabled ? review.draft : undefined
+
+  useEffect(() => {
+    if (review.offline) setEditor(null)
+  }, [review.offline])
+  // An edited comment that is gone (sent or removed elsewhere) closes its editor.
+  useEffect(() => {
+    if (editor?.kind === 'edit' && !draft?.comments.some((c) => c.id === editor.commentId)) setEditor(null)
+  }, [draft, editor])
+
+  const run = useCallback(async (title: string, work: () => Promise<void>): Promise<boolean> => {
+    const backend = getBackend()
+    setBusy(true)
+    setReviewError(null)
+    try {
+      await work()
+      return true
+    } catch (err) {
+      const text = backend.errors.inline(err)
+      if (text) setReviewError(`${title}: ${text}`)
+      return false
+    } finally {
+      setBusy(false)
+    }
+  }, [])
+
+  const canWrite = review.enabled && !review.offline
+  // One object while nothing it holds changes, so the memoised file diffs don't all re-render.
+  const actions = useMemo<ReviewActions>(() => ({
+    editor,
+    setEditor,
+    busy,
+    canWrite,
+    save: async (text) => {
+      const e = editor
+      if (!e) return false
+      const done =
+        e.kind === 'new'
+          ? await run('Could not add the comment', async () => {
+              await getBackend().review.add(path, { source, path: e.path, side: e.side, line: e.line, lineText: e.lineText, body: text })
+            })
+          : await run('Could not save the comment', async () => {
+              const before = draft?.comments.find((c) => c.id === e.commentId)
+              await getBackend().review.edit(path, e.commentId, text, before?.body ?? '')
+            })
+      if (done) setEditor(null)
+      return done
+    },
+    remove: (comment) => {
+      void run('Could not delete the comment', () => getBackend().review.remove(path, comment.id))
+    }
+  }), [editor, busy, canWrite, run, path, source, draft])
+
+  // This source's comments by file; the rest are listed in the bar.
+  const { byPath, elsewhere } = useMemo(() => {
+    const byPath = new Map<string, ReviewComment[]>()
+    const elsewhere: ReviewComment[] = []
+    const shown = new Set(changes?.files.map((f) => f.path) ?? [])
+    for (const c of draft?.comments ?? []) {
+      if (sameSource(c.source, source) && shown.has(c.path)) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])
+      else elsewhere.push(c)
+    }
+    return { byPath, elsewhere }
+  }, [draft, source, changes])
 
   return (
     <div className="notes-panel changes-panel" style={{ display: visible ? 'flex' : 'none' }}>
       <div className="notes-header">
         <span>Changes</span>
-        {changes && (
+        {review.enabled ? (
+          <SourcePicker path={path} source={source} onSource={onSource} base={changes?.base} />
+        ) : (
           <span className="muted">
-            {changes.base
-              ? `compared to ${changes.base}`
-              : 'comparing uncommitted changes only'}
+            {changes && (changes.base ? `compared to ${changes.base}` : 'comparing uncommitted changes only')}
+            {review.needsUpdate && (
+              <span className="changes-needs-update" title="This server is older than Trek 5c-2">
+                {changes ? ' · ' : ''}Update the server to pick a source and comment on lines
+              </span>
+            )}
           </span>
         )}
       </div>
+      {visible && review.enabled && (
+        <ReviewBar
+          draft={draft}
+          review={review}
+          elsewhere={elsewhere}
+          actions={actions}
+          error={reviewError}
+          onSend={(target) => {
+            if (!draft) return
+            void run(`Could not send the review to ${target.title}`, () => getBackend().review.send(path, target.terminalId, draft.revision))
+          }}
+          onDiscard={() => {
+            if (!draft) return
+            void run('Could not discard the review', () => getBackend().review.clear(path, draft.revision))
+          }}
+        />
+      )}
       {visible && (
         <div className="changes-list">
           {error && <div className="changes-note changes-error">{error}</div>}
@@ -257,6 +668,7 @@ export const ChangesPanel = memo(function ChangesPanel({
           {changes?.files.map((file) => {
             const expanded = toggled[file.path] ?? autoExpanded.has(file.path)
             const noteOnly = file.binary || file.tooLarge || file.unreadable
+            const fileComments = byPath.get(file.path) ?? NO_COMMENTS
             return (
               <div key={file.path} className="changes-file">
                 <div
@@ -270,6 +682,11 @@ export const ChangesPanel = memo(function ChangesPanel({
                   <span className="changes-path" title={file.path}>
                     {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                   </span>
+                  {fileComments.length > 0 && (
+                    <span className="review-file-count" title="Review comments on this file">
+                      💬 {fileComments.length}
+                    </span>
+                  )}
                   {!noteOnly && (
                     <span className="changes-counts">
                       <span className="add">+{file.added}</span>{' '}
@@ -285,6 +702,8 @@ export const ChangesPanel = memo(function ChangesPanel({
                     }
                     loading={diffsPending}
                     unavailable={!!diffError}
+                    comments={fileComments}
+                    actions={actions}
                   />
                 )}
               </div>
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index f382599..2a5cfa5 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -27,7 +27,9 @@ import { EnvironmentPanel } from './EnvironmentPanel'
 import { StackPanel } from './StackPanel'
 import { STACK_STATE_LABELS, stackState, stackUrls } from '../../../shared/stacks'
 import { NotesPanel } from './NotesPanel'
-import { ChangesPanel, useWorktreeChanges } from './ChangesPanel'
+import { ChangesPanel, useWorktreeChanges, type ReviewTarget } from './ChangesPanel'
+import { BRANCH_SOURCE } from '../../../shared/review'
+import type { ChangesSource } from '../../../shared/types'
 import { changesTabLabel } from '../../../shared/changes'
 import { AllNotesPanel } from './AllNotesPanel'
 import { SettingsPanel } from './SettingsPanel'
@@ -131,10 +133,13 @@ export function WorktreeDetail({
   const path = info?.path
   // The stack runs on the server's machine (`features.stacks`, any server that has `stacks`).
   const [stack, refreshStack] = useStackStatus(path, !features.stacks)
-  const changesState = useWorktreeChanges(path, offline, panel === 'changes')
+  // What the Changes tab compares (5c-2): a server without `review` is asked without a source.
+  const [changesSource, setChangesSource] = useState<ChangesSource>(BRANCH_SOURCE)
+  const changesState = useWorktreeChanges(path, offline, panel === 'changes', features.review ? changesSource : undefined)
   useEffect(() => {
     // Selection changed: back to the sessions view, drop transient UI state.
     setPanel('sessions')
+    setChangesSource(BRANCH_SOURCE)
     setMenuOpen(false)
     setTagMenuOpen(false)
     setCustomTagMenuOpen(false)
@@ -202,6 +207,10 @@ export function WorktreeDetail({
   // The server watches it (5c-1); its last report stays on the chip until dismissed.
   const watchingPr = !!pullRequest && !!info.branch && !!repo.branchPrWatches?.[info.branch]
   const prNotice = repo.worktreePrNotices?.[info.path]
+  // Where the Changes tab's review can go (5c-2): the worktree's open sessions, newest first.
+  const reviewTargets: ReviewTarget[] = loaded
+    ? [...order].reverse().flatMap((id) => (terminals[id] ? [{ terminalId: id, title: terminals[id].title }] : []))
+    : []
   const linearIssue = ticket ? linearIssues[ticket] : undefined
   const linkedTicketUrl = ticket ? ticketUrl(project, ticket, linearIssue) : null
 
@@ -725,7 +734,7 @@ export function WorktreeDetail({
         )}
         <button
           className={`panel-btn ${panel === 'changes' ? 'active' : ''}`}
-          title="Changes compared to the default branch, including uncommitted work"
+          title={features.review ? 'Changes: the branch against its base, the uncommitted work or one commit, with line comments' : 'Changes compared to the default branch, including uncommitted work'}
           onClick={() => setPanel(panel === 'changes' ? 'sessions' : 'changes')}
         >
           {changesTabLabel(changesState.changes)}
@@ -843,6 +852,17 @@ export function WorktreeDetail({
           visible={panel === 'changes'}
           paused={offline}
           state={changesState}
+          path={info.path}
+          source={changesSource}
+          onSource={setChangesSource}
+          review={{
+            enabled: features.review,
+            needsUpdate: !features.review && !offline,
+            draft: repo.worktreeReviews?.[info.path],
+            targets: reviewTargets,
+            noTargets: loaded ? 'Start a session in this worktree to send the review to' : 'Load the worktree to send the review to one of its sessions',
+            offline
+          }}
         />
         <NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />
         {info.isMain && <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />}
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 9570a1d..343076a 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -1900,7 +1900,8 @@ button:disabled {
 }
 
 .changes-line {
-  padding: 0 10px;
+  /* Room on the left for the review's + (5c-2) */
+  padding: 0 10px 0 22px;
   white-space: pre;
 }
 
@@ -1928,6 +1929,219 @@ button:disabled {
   white-space: pre-wrap;
 }
 
+/* The Changes tab's review (5c-2): the source picker, line comments and the review bar. */
+.changes-source {
+  display: flex;
+  align-items: center;
+  gap: 6px;
+  min-width: 0;
+  font-weight: 400;
+}
+
+.changes-source select {
+  max-width: 260px;
+  background: var(--bg-lighter);
+  color: var(--text);
+  border: 1px solid var(--border-strong);
+  border-radius: 6px;
+  padding: 2px 6px;
+  font-size: 11px;
+}
+
+.changes-row {
+  position: relative;
+}
+
+.changes-line {
+  position: relative;
+}
+
+.review-add {
+  position: absolute;
+  left: 3px;
+  top: 1px;
+  width: 16px;
+  height: 16px;
+  padding: 0;
+  border: none;
+  border-radius: 4px;
+  background: var(--accent);
+  color: #fff;
+  font-size: 12px;
+  line-height: 16px;
+  cursor: pointer;
+  opacity: 0;
+}
+
+.changes-line:hover .review-add,
+.review-add:focus-visible {
+  opacity: 1;
+}
+
+.review-comment,
+.review-editor {
+  margin: 4px 10px 6px 26px;
+  padding: 6px 10px;
+  max-width: 720px;
+  border: 1px solid var(--border-strong);
+  border-left: 3px solid var(--decision);
+  border-radius: 6px;
+  background: var(--panel);
+  font-family: inherit;
+  font-size: 12px;
+  line-height: 1.45;
+  white-space: normal;
+}
+
+.review-comment-where {
+  color: var(--text-muted);
+  font-family: var(--mono);
+  font-size: 11px;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
+.review-comment-body {
+  white-space: pre-wrap;
+  overflow-wrap: anywhere;
+}
+
+.review-comment-actions,
+.review-editor-actions {
+  display: flex;
+  gap: 8px;
+  margin-top: 4px;
+}
+
+.review-editor textarea {
+  width: 100%;
+  min-height: 56px;
+  box-sizing: border-box;
+  resize: vertical;
+  background: var(--bg-darker);
+  color: var(--text);
+  border: 1px solid var(--border-strong);
+  border-radius: 4px;
+  padding: 6px;
+  font: inherit;
+}
+
+.review-btn {
+  height: 24px;
+  padding: 0 10px;
+  border: none;
+  border-radius: 6px;
+  background: var(--accent);
+  color: #fff;
+  font-size: 12px;
+  cursor: pointer;
+}
+
+.review-btn.quiet {
+  background: var(--surface);
+  color: var(--text);
+}
+
+.review-btn.danger {
+  background: var(--danger);
+  color: #111;
+}
+
+.review-link {
+  padding: 0;
+  border: none;
+  background: none;
+  color: var(--accent);
+  font-size: 11px;
+  cursor: pointer;
+}
+
+.review-outdated {
+  padding: 6px 0;
+  border-bottom: 1px solid var(--border);
+}
+
+.review-outdated-title {
+  padding: 0 10px 0 26px;
+  color: var(--attention);
+  font-size: 11px;
+}
+
+.review-bar {
+  margin: 0 16px;
+  padding: 6px 10px;
+  border: 1px solid var(--border-strong);
+  border-radius: 8px;
+  background: var(--panel);
+  font-size: 12px;
+}
+
+.review-bar-row {
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  flex-wrap: wrap;
+}
+
+.review-bar-spacer {
+  flex: 1;
+}
+
+.review-count {
+  font-weight: 600;
+}
+
+.review-send-wrap {
+  position: relative;
+}
+
+.review-send-menu {
+  position: absolute;
+  right: 0;
+  top: 28px;
+  z-index: 20;
+  min-width: 180px;
+  max-height: 240px;
+  overflow: auto;
+  padding: 4px;
+  border: 1px solid var(--border-strong);
+  border-radius: 8px;
+  background: var(--bg-lighter);
+  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
+}
+
+.review-send-target {
+  display: block;
+  width: 100%;
+  padding: 5px 8px;
+  border: none;
+  border-radius: 4px;
+  background: none;
+  color: var(--text);
+  font-size: 12px;
+  text-align: left;
+  cursor: pointer;
+}
+
+.review-send-target:hover {
+  background: var(--surface);
+}
+
+.review-elsewhere .review-comment {
+  margin-left: 0;
+}
+
+.review-error {
+  margin-top: 4px;
+}
+
+.review-file-count {
+  color: var(--decision);
+  font-size: 11px;
+  white-space: nowrap;
+}
+
 .branch-glyph {
   color: var(--text-muted);
   margin-right: 4px;
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 3a7d5c5..8b05f31 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -469,8 +469,10 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       // The mirror already has them: no request.
       listWorktrees: async (repoId) => deps.state().hostWorktrees[`${repoId} ${hostKey()}`] ?? [],
       listBranches: (repoId) => request('repo.listBranches', { projectId, repoId }),
-      changes: async (loc) => request('worktree.changes', { projectId, worktreeId: worktreeAt(loc.path) }),
-      diff: async (loc) => request('worktree.diff', { projectId, worktreeId: worktreeAt(loc.path) }),
+      // A source only when one is asked for: an older server's params are the same as before.
+      changes: async (loc, source) => request('worktree.changes', { projectId, worktreeId: worktreeAt(loc.path), ...(source ? { source } : {}) }),
+      diff: async (loc, source) => request('worktree.diff', { projectId, worktreeId: worktreeAt(loc.path), ...(source ? { source } : {}) }),
+      commits: async (loc) => request('worktree.commits', { projectId, worktreeId: worktreeAt(loc.path) }),
       pull: async (loc) => {
         await request('worktree.pull', { projectId, worktreeId: worktreeAt(loc.path) })
       },
@@ -546,6 +548,22 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
     skills: {
       list: async (loc) => request('skills.list', { projectId, worktreeId: worktreeAt(loc.path) })
     },
+    // The draft is the worktree's `review` in the project topic: the patch is the answer.
+    review: {
+      add: async (path, comment) => (await request('review.add', { projectId, worktreeId: worktreeAt(path), ...comment })).commentId,
+      edit: async (path, commentId, body, expected) => {
+        await request('review.edit', { projectId, worktreeId: worktreeAt(path), commentId, body, expected })
+      },
+      remove: async (path, commentId) => {
+        await request('review.remove', { projectId, worktreeId: worktreeAt(path), commentId })
+      },
+      clear: async (path, revision) => {
+        await request('review.clear', { projectId, worktreeId: worktreeAt(path), revision })
+      },
+      send: async (path, terminalId, revision) => {
+        await request('review.send', { projectId, worktreeId: worktreeAt(path), sessionId: terminalId, revision })
+      }
+    },
     branch: {
       setTag: async (repoId, branch, tagId) => {
         await request('branch.setTag', { ...branchRef(repoId, branch), tag: tagId })
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index 5667d83..ab372c4 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -163,6 +163,7 @@ type BranchMaps = Required<
     | 'branchPullRequests'
     | 'branchPrWatches'
     | 'worktreePrNotices'
+    | 'worktreeReviews'
     | 'branchEnvVars'
   >
 >
@@ -176,6 +177,7 @@ function branchMaps(repo: V2Repository): BranchMaps {
     branchPullRequests: {},
     branchPrWatches: {},
     worktreePrNotices: {},
+    worktreeReviews: {},
     branchEnvVars: {}
   }
   for (const [branch, data] of Object.entries(repo.branchData)) {
@@ -189,7 +191,10 @@ function branchMaps(repo: V2Repository): BranchMaps {
   }
   // By the worktree's path, not its branch: a missing worktree on the same branch keeps its own notice,
   // and a row's × dismisses the worktree that holds it.
-  for (const w of repo.worktrees) if (w.prNotice) maps.worktreePrNotices[w.path] = w.prNotice.text
+  for (const w of repo.worktrees) {
+    if (w.prNotice) maps.worktreePrNotices[w.path] = w.prNotice.text
+    if (w.review) maps.worktreeReviews[w.path] = w.review
+  }
   return maps
 }
 
diff --git a/src/shared/types.ts b/src/shared/types.ts
index b5b7037..d25aac3 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -1,6 +1,7 @@
 import type { RawProjectFile } from './migration'
 import type { LlmSelection } from './providers/types'
 import type { ConnectionStatus } from './client/connection'
+import type { ReviewDraft } from './model/types'
 
 /** A workflow tag assignable to a branch's worktree, configured per project. */
 export interface WorktreeTag {
@@ -289,6 +290,8 @@ export interface Repository {
   branchPrWatches?: Record<string, true>
   /** The watched PR's last report, by the path of the worktree that holds it (5c-1) */
   worktreePrNotices?: Record<string, string>
+  /** The Changes tab's draft reviews, by the path of the worktree that holds each (5c-2) */
+  worktreeReviews?: Record<string, ReviewDraft>
   /**
    * Environment variables for the branch's Docker environment, keyed by branch
    * name (survives promote/delete). Raw .env-style text ("KEY=value" lines) —
````

- [ ] **Step 2: Run the checks**

Run: `node --test scripts/backendFeatures.test.mjs scripts/v2Projector.test.mjs scripts/v2Backend.test.mjs && npm run typecheck`
Expected: all pass (one new test in each file); the typecheck is clean

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 4: the app: features.review, git.changes/diff take a source, git.commits, backend.review (add, edit, remove, clear, send), the projected worktreeReviews; the Changes tab's source picker, line comments (outdated ones at the file's top, the rest listed in the bar) and the review bar (Send to session, newest first; Discard)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 5: the smoke

`smoke:server-review` (37 checks, Decision 27, including an agent's `get_review_comments` over the server's MCP endpoint) and `smoke:local-window`'s base check reading the picker.

**Files:**
- Modify: `package.json`
- Modify: `scripts/local-window-smoke.mjs`
- Create: `scripts/server-review-smoke.mjs`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick 1e715ce`, or the diff below)

````diff
diff --git a/package.json b/package.json
index 36b5da4..3e39c9b 100644
--- a/package.json
+++ b/package.json
@@ -25,6 +25,7 @@
     "smoke:server-env": "npm run build && node scripts/server-env-smoke.mjs",
     "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
     "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
+    "smoke:server-review": "npm run build && node scripts/server-review-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/local-window-smoke.mjs b/scripts/local-window-smoke.mjs
index be7f402..df1d498 100644
--- a/scripts/local-window-smoke.mjs
+++ b/scripts/local-window-smoke.mjs
@@ -385,7 +385,9 @@ try {
   const fileRows = detail.locator('.changes-file-row')
   await fileRows.first().waitFor({ timeout: 10_000 })
   await detail.locator('.changes-line.add', { hasText: 'changed' }).waitFor({ timeout: 10_000 })
-  check('one row per file, the deleted line, the base', [await fileRows.count(), await detail.locator('.changes-line.del', { hasText: 'two' }).count(), (await detail.locator('.changes-panel .muted').first().textContent()).trim()], [3, 1, 'compared to main'])
+  // The base is named in the source picker (5c-2), on the branch against it.
+  const basePicked = detail.locator('.changes-panel .changes-source-kind option:checked')
+  check('one row per file, the deleted line, the base', [await fileRows.count(), await detail.locator('.changes-line.del', { hasText: 'two' }).count(), await until(async () => (await basePicked.textContent()).trim(), 'Branch vs main')], [3, 1, 'Branch vs main'])
   writeFileSync(join(apiFeature, 'edited.txt'), 'one\nREWRITTEN\n')
   await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).waitFor({ timeout: 15_000 })
   check('a same-count edit replaces the patch', [await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).count(), await detail.locator('.changes-line.add', { hasText: 'changed' }).count()], [1, 0])
diff --git a/scripts/server-review-smoke.mjs b/scripts/server-review-smoke.mjs
new file mode 100644
index 0000000..f0249e3
--- /dev/null
+++ b/scripts/server-review-smoke.mjs
@@ -0,0 +1,348 @@
+// scripts/server-review-smoke.mjs — the Changes tab's review (phase 5c-2) on a remote server, in its window.
+//
+// Run: npm run smoke:server-review   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) runs with its own HOME and the not-signed-in stub gh every
+// smoke gets (smokeGh.mjs). Its agent is a fake one that lingers. The built app runs with a temp HOME
+// and --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app
+// server, and the window opens a project made through the SDK. A worktree has two commits and
+// uncommitted work. Through the DOM and the SDK it checks:
+//   - the welcome lists review, and the window's feature follows it;
+//   - the source picker: the branch against its base, uncommitted only, and one commit of the newest
+//     (the newest first; another commit picked shows its own files);
+//   - a line comment written on a commit's diff is saved on the server's worktree with its source,
+//     file, side, line and line text; one added through the SDK (another client) shows up live;
+//   - comments on another source are listed as not on this diff; switching to their source shows them
+//     under their line;
+//   - a commented line that changes on disk shows its comment as outdated, at the file's top;
+//   - Edit and Delete change the draft on the server;
+//   - an agent's get_review_comments (MCP) returns the draft the window wrote, each comment's outdated
+//     worked out, and changes nothing;
+//   - with the worktree unloaded and no session, Send is disabled and says why;
+//   - Send to session lists the worktree's sessions newest first; picking the older one queues the
+//     review as one prompt there (the prompt reviewPrompt makes from the draft), none on the other,
+//     and the draft is cleared on the server and in the window;
+//   - Discard, confirmed, clears a draft;
+//   - the renderer never holds the server token; no error dialogs, console or page errors.
+//
+// Prints SERVER REVIEW SMOKE PASS (n checks) or SERVER REVIEW SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
+import { reviewPrompt } from '../src/shared/review.ts'
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
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-review-smoke-')))
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
+  console.log(exitCode === 0 ? `SERVER REVIEW SMOKE PASS (${checks.length} checks)` : `SERVER REVIEW SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+try {
+  // ---- 1. The server and a project with a worktree: two commits and uncommitted work ----------------
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
+  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-review-smoke' })
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  check('the welcome lists review', sdk.welcome?.capabilities.includes('review'), true)
+  const { projectId } = await sdk.request('project.create', { name: 'review', repositories: [{ path: repo }] })
+  const topic = `project:${projectId}`
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const repoId = (await project()).repositories[0].id
+  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
+  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2\n')
+  git('-C', worktree, 'add', '.')
+  git('-C', worktree, 'commit', '-q', '-m', 'add b')
+  writeFileSync(join(worktree, 'a.txt'), 'one\nTWO\nthree\n')
+  git('-C', worktree, 'commit', '-q', '-am', 'shout two')
+  const shaOf = (rev) => git('-C', worktree, 'rev-parse', rev).trim()
+  const newestSha = shaOf('HEAD')
+  const olderSha = shaOf('HEAD~1')
+  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2 edited\n')
+  writeFileSync(join(worktree, 'c.txt'), 'c\n')
+  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id
+  const feature = async () => (await project()).repositories[0].worktrees.find((w) => w.id === featureId)
+  const draft = async () => (await feature()).review ?? null
+  const ref = { projectId, worktreeId: featureId }
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
+    const { opened } = await window.api.openServerProject(id, pid, 'review', 'Remote')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entry.id, projectId])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 2)
+  check("the window's review feature follows the server's capability", await until(() => win.evaluate(() => window.__features().review), true), true)
+
+  // ---- 3. The source picker ------------------------------------------------------------------------
+
+  const detail = win.locator('.server-window .detail')
+  await rows.filter({ hasText: 'feature-x' }).click()
+  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
+  await detail.locator('.panel-btn[title^="Changes"]').click()
+  const panel = detail.locator('.changes-panel')
+  const shownFiles = () => panel.locator('.changes-path').allTextContents()
+  const kind = panel.locator('.changes-source-kind')
+  const picked = async () => [await kind.inputValue(), await kind.locator('option:checked').textContent()]
+  check('the picker starts on the branch against its base (named once the summary is in)', await until(picked, ['branch', 'Branch vs main']), ['branch', 'Branch vs main'])
+  check('the branch: its commits and the uncommitted work', await until(shownFiles, ['a.txt', 'b.txt', 'c.txt']), ['a.txt', 'b.txt', 'c.txt'])
+  await kind.selectOption('uncommitted')
+  check('uncommitted only: the edit and the untracked file', await until(shownFiles, ['b.txt', 'c.txt']), ['b.txt', 'c.txt'])
+  await kind.selectOption('commit')
+  const commitSelect = panel.locator('.changes-source-commit')
+  check('one commit: the newest is picked first', await until(() => commitSelect.inputValue().catch(() => null), newestSha), newestSha)
+  check('the commit list: newest first, with subjects', await commitSelect.locator('option').allTextContents(), [`${newestSha.slice(0, 7)} shout two`, `${olderSha.slice(0, 7)} add b`, `${shaOf('main').slice(0, 7)} init`])
+  check("the newest commit's files", await until(shownFiles, ['a.txt']), ['a.txt'])
+  await commitSelect.selectOption(olderSha)
+  check("another commit's files", await until(shownFiles, ['b.txt']), ['b.txt'])
+  await commitSelect.selectOption(newestSha)
+  await until(shownFiles, ['a.txt'])
+
+  // ---- 4. A line comment, on the newest commit's diff -----------------------------------------------
+
+  const fileBox = (path) => panel.locator(`.changes-file:has(.changes-path[title="${path}"])`)
+  const line = (path, side, n) => fileBox(path).locator(`.changes-line[data-side="${side}"][data-line="${n}"]`)
+  await line('a.txt', 'new', 2).waitFor({ timeout: 10_000 })
+  check('before any comment there is no review bar', await panel.locator('.review-bar').count(), 0)
+  await line('a.txt', 'new', 2).hover()
+  await line('a.txt', 'new', 2).locator('.review-add').click()
+  await panel.locator('.review-editor textarea').fill('Why shout?')
+  await panel.locator('.review-editor .review-btn', { hasText: 'Add comment' }).click()
+  const first = await until(async () => (await draft())?.comments.length ?? 0, 1)
+  check('the comment is saved on the server', first, 1)
+  const saved = (await draft()).comments[0]
+  check('with its source, file, side, line and line text', { source: saved.source, path: saved.path, side: saved.side, line: saved.line, lineText: saved.lineText, body: saved.body }, { source: { kind: 'commit', sha: newestSha }, path: 'a.txt', side: 'new', line: 2, lineText: 'TWO', body: 'Why shout?' })
+  check('it shows under its line', await until(() => fileBox('a.txt').locator('.review-comment .review-comment-body').allTextContents(), ['Why shout?']), ['Why shout?'])
+  check('the bar counts it', await until(() => panel.locator('.review-count').textContent(), 'Review · 1 comment'), 'Review · 1 comment')
+  const sendButton = panel.locator('.review-send')
+  check('with the worktree unloaded and no session, Send is disabled and says why', [await sendButton.isDisabled(), await sendButton.getAttribute('title')], [true, 'Load the worktree to send the review to one of its sessions'])
+
+  // ---- 5. Another client's comment, live; other sources; outdated -----------------------------------
+
+  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'b.txt', side: 'new', line: 2, lineText: 'b2 edited', body: 'Another client' })
+  check("another client's comment shows up live", await until(() => panel.locator('.review-count').textContent(), 'Review · 2 comments'), 'Review · 2 comments')
+  check('as not on this diff', await until(() => panel.locator('.review-elsewhere-toggle').textContent().catch(() => null), '1 not on this diff ▸'), '1 not on this diff ▸')
+  await panel.locator('.review-elsewhere-toggle').click()
+  check('listed with its source and place', await panel.locator('.review-elsewhere .review-comment-where').allTextContents(), ['Uncommitted changes · b.txt, line 2: b2 edited'])
+  await kind.selectOption('uncommitted')
+  check('on its own source it shows under its line', await until(() => fileBox('b.txt').locator('.changes-row:has(.changes-line[data-line="2"][data-side="new"]) .review-comment-body').allTextContents(), ['Another client']), ['Another client'])
+  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2 changed again\n')
+  check('its line changed on disk: the comment is outdated, at the file top', await until(() => fileBox('b.txt').locator('.review-outdated .review-comment-where').allTextContents(), ['line 2: b2 edited']), ['line 2: b2 edited'])
+
+  // ---- 6. Edit and Delete ------------------------------------------------------------------------
+
+  const outdatedComment = fileBox('b.txt').locator('.review-outdated .review-comment')
+  await outdatedComment.locator('.review-link', { hasText: 'Edit' }).click()
+  await outdatedComment.locator('textarea').fill('Still matters')
+  await outdatedComment.locator('.review-btn', { hasText: 'Save' }).click()
+  check('Edit saves the new text on the server', await until(async () => (await draft())?.comments.map((c) => c.body), ['Why shout?', 'Still matters']), ['Why shout?', 'Still matters'])
+  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'c.txt', side: 'new', line: 1, lineText: 'c', body: 'Drop me' })
+  const dropMe = fileBox('c.txt').locator('.review-comment', { hasText: 'Drop me' })
+  await dropMe.waitFor({ timeout: 10_000 })
+  await dropMe.locator('.review-link', { hasText: 'Delete' }).click()
+  check('Delete removes it on the server', await until(async () => (await draft())?.comments.map((c) => c.body), ['Why shout?', 'Still matters']), ['Why shout?', 'Still matters'])
+
+  // ---- 7. An agent reads the draft the window wrote (MCP get_review_comments) ------------------------
+
+  // The worktree's sessions: their launch writes the project's MCP config, which the agent reads.
+  const older = await sdk.request('session.start', { ...ref, title: 'Older', cols: 120, rows: 30 })
+  const newer = await sdk.request('session.start', { ...ref, title: 'Newer', cols: 120, rows: 30 })
+  const mcpFile = join(data, 'mcp', `${projectId}.json`)
+  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const rpc = async (method, params) => {
+    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
+    return res.json()
+  }
+  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
+  const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? []
+  check('the agent’s tools list get_review_comments', listed.includes('get_review_comments'), true)
+  const called = await rpc('tools/call', { name: 'get_review_comments', arguments: { worktree: 'feature-x' } })
+  const seen = JSON.parse(called.result?.content?.[0]?.text ?? '{}')
+  check('get_review_comments returns the draft the window wrote, outdated worked out', [called.result?.isError === true, seen.revision === (await draft()).revision, seen.comments?.map((c) => ({ file: c.file, side: c.side, line: c.line, lineText: c.lineText, comment: c.comment, source: c.sourceLabel, outdated: c.outdated }))], [false, true, [
+    { file: 'a.txt', side: 'new', line: 2, lineText: 'TWO', comment: 'Why shout?', source: `Commit ${newestSha.slice(0, 7)}`, outdated: false },
+    { file: 'b.txt', side: 'new', line: 2, lineText: 'b2 edited', comment: 'Still matters', source: 'Uncommitted changes', outdated: true }
+  ]])
+  check('and leaves it as it was', (await draft()).comments.length, 2)
+
+  // ---- 8. Send to session: newest first, the older picked ---------------------------------------------
+
+  check('with sessions, Send is enabled', await until(() => sendButton.isDisabled(), false), false)
+  await sendButton.click()
+  check('it lists the sessions newest first', await panel.locator('.review-send-target').allTextContents(), ['Newer', 'Older'])
+  const before = await draft()
+  const expected = reviewPrompt((await feature()).name, before.comments)
+  await panel.locator('.review-send-target', { hasText: 'Older' }).click()
+  const queueOf = async (id) => (await feature()).sessions.find((s) => s.id === id)?.queue ?? []
+  check('the review is queued on the session picked, as one prompt', await until(() => queueOf(older.sessionId), [expected]), [expected])
+  check('none on the other', await queueOf(newer.sessionId), [])
+  check('the draft is cleared on the server', await draft(), null)
+  check('and in the window', await until(() => panel.locator('.review-bar').count(), 0), 0)
+  check('the prompt names the sources, files and lines', expected.split('\n\n').slice(1), [
+    `## Commit ${newestSha.slice(0, 7)}`,
+    'a.txt, line 2:\n> TWO\nWhy shout?',
+    '## Uncommitted changes',
+    'b.txt, line 2:\n> b2 edited\nStill matters'
+  ])
+
+  // ---- 9. Discard -----------------------------------------------------------------------------------
+
+  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'c.txt', side: 'new', line: 1, lineText: 'c', body: 'Throw away' })
+  await panel.locator('.review-discard').click()
+  await panel.locator('.review-discard-confirm').click()
+  check('Discard, confirmed, clears the draft on the server', await until(draft, null), null)
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
````

- [ ] **Step 2: Run the checks**

Run: `npm run build && node scripts/server-review-smoke.mjs && node scripts/local-window-smoke.mjs`
Expected: SERVER REVIEW SMOKE PASS (37 checks), LOCAL WINDOW SMOKE PASS (57 checks)

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 5: smoke:server-review (the source picker, line comments, live edits from another client, outdated comments, Send to session and Discard in a remote window)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 6: docs

PROTOCOL.md (the capability row, the command groups, a "Changes tab review" section with the sources, the draft and the methods, and `get_review_comments` in the MCP tool table: 29 tools), both READMEs (the feature, the tool, the smoke, the server's section) and the spec's 5c-2 decisions.

**Files:**
- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-04-central-server-design.md`
- Modify: `server/README.md`

- [ ] **Step 1: Apply the prototype's diff** (`git cherry-pick bfc6f67`, or the diff below)

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 218b3f0..deadc85 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -103,6 +103,7 @@ new optional field needs no capability: its absence says enough.
 | `voice` | `voice.*` keep the server's ElevenLabs key and voice; the MCP tool `speak_summary` sends each spoken summary to the project's subscribers as `voice.summary` |
 | `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
 | `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked (`gh auth status --hostname github.com`) when the server starts, every 10 minutes after that whether it is listed or not, and when a poll fails with what looks like a sign-in error (HTTP 401, not logged in); a poll failing any other way (the network, GitHub, one unreadable PR) leaves it as it is. The Local server announces itself only once the first check has answered (at most 3 s), so the app's first welcome has it; a remote server takes connections at once, so a welcome sent before gh answered lacks it and the change is pushed. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
+| `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -171,7 +172,7 @@ server restarts. A server without this field simply leaves it out.
 |---|---|
 | Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
 | Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
-| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff`, `worktree.dirty` |
+| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff`, `worktree.commits`, `worktree.dirty` |
 | Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setPrWatch`, `branch.setEnv` |
 | Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (see [Sessions](#sessions)) |
@@ -184,6 +185,7 @@ server restarts. A server without this field simply leaves it out.
 | Voice | `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`, `voice.setConfig`, `voice.synthesize` |
 | Skills | `skills.list` |
 | Pull request watch | `prWatch.dismiss` (and `branch.setPrWatch`) |
+| Changes tab review | `review.add`, `review.edit`, `review.remove`, `review.clear`, `review.send` (and `worktree.commits`, `worktree.changes`/`worktree.diff`'s `source`) |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
 | Misc | `sys.ping` |
 
@@ -290,7 +292,8 @@ detached, when the worktree is now `missing`, or for a name like `--mirror`;
 `NOT_FOUND` when the row is gone), pass it to git as `refs/heads/<branch>`, and
 refresh the worktree's status before answering. `worktree.changes` and
 `worktree.diff` return the worktree's changes against its base branch (files with
-their added and removed line counts) and each file's unified diff. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
+their added and removed line counts) and each file's unified diff; with `review`
+they take a `source` (see [Changes tab review](#changes-tab-review)). `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` and `worktree.commits` on
 a worktree whose path is outside the allowlist (a row from a hand-edited
 project file, say) fail with `PATH_DENIED` before running git. They (and the
 docker, env and stack methods) refuse a non-main worktree whose path is, or
@@ -528,6 +531,52 @@ read: <reason>`, once, and the next good poll withdraws it.
 `branch.setPr` with a different URL, or none, also removes the branch's watch: it watched the old
 pull request. The MCP tool `watch_pull_request` turns a watch on or off.
 
+## Changes tab review
+
+With the capability `review` (phase 5c-2), a client can pick what the Changes tab compares and
+write line comments on the diff, which go to one of the worktree's sessions as one queued prompt.
+The tab stays read-only: nothing stages or reverts.
+
+`worktree.changes` and `worktree.diff` take an optional `source`:
+
+| `source` | Compares |
+|---|---|
+| absent, or `{kind: 'branch'}` | The branch against its base: the merge-base with the default branch (`origin/HEAD`, else `origin/master`, `origin/main`, `master`, `main`) to the working tree, untracked files included. The only view a server without `review` has |
+| `{kind: 'uncommitted'}` | Staged, unstaged and untracked work against `HEAD` (the empty tree before the first commit); `base` is `null` |
+| `{kind: 'commit', sha}` | One commit against its first parent (the empty tree for a root commit), without the working tree; `base` is `null`. `sha` must be a full lowercase hex object id (40 or 64 characters, else `BAD_REQUEST`, before git runs) that names a commit in the repository (else `GIT_ERROR`) |
+
+`worktree.commits` `{projectId, worktreeId}` returns the newest 100 commits on the worktree's
+`HEAD`, newest first, as `{sha, subject, author, at}` (`at`: the author time, epoch ms; `subject`:
+the first line, at most 200 characters); none before the first commit. Merges are listed, and
+their diff is against their first parent. Any commit can be asked for, not only these.
+
+A worktree's draft is its `review` in the project topic, `{revision, comments}`, saved with the
+project (it survives a restart; one of the wrong shape is dropped at load and at `project.import`).
+Every client sees it, and every change to it, in the topic's patches. Each comment is `{id, source,
+path, side, line, lineText, body, at}`: the diff it was written on, the file's path there, `side`
+`old` (a removed line, numbered in the old file) or `new` (an added or unchanged line, in the new
+file), the 1-based line, the line as it read then (without the diff's `+`, `-` or space), the
+comment, and when it was written or last edited (the server's clock). The server never re-reads the
+line: a client shows a comment whose line no longer reads the same as outdated, and it is still sent
+with the text it was written on. `revision` goes up with every change, and never below the server's
+clock (epoch ms), so a draft begun after another was sent or discarded does not repeat a revision a
+client still holds. The draft goes away when its last comment does.
+
+| Method | Params | Result |
+|---|---|---|
+| `review.add` | `{projectId, worktreeId, source, path, side, line, lineText, body}` | `{commentId}`. `path`: one line, 1–4096 characters; `line`: 1–10,000,000; `lineText`: one line, at most 500 characters (clients cut a longer line, and drop its control characters); `body`: not blank, at most 4000 characters; at most 100 comments; and the prompt the draft would send must fit in one queued prompt (100,000 characters). Else `BAD_REQUEST` |
+| `review.edit` | `{projectId, worktreeId, commentId, body, expected?}` | `null`. `expected`: the body the edit started from (`CONFLICT` if it changed); the same limits as `review.add` |
+| `review.remove` | `{projectId, worktreeId, commentId}` | `null` (`NOT_FOUND` for an unknown comment) |
+| `review.clear` | `{projectId, worktreeId, revision}` | `null`: the draft is discarded. `revision`: the draft the client showed (`CONFLICT` if it changed) |
+| `review.send` | `{projectId, worktreeId, sessionId, revision}` | `null`: the draft is queued on `sessionId`, one of the worktree's sessions (`NOT_FOUND` otherwise), as one prompt, and cleared, in one change to the project (one patch). `revision`: the draft the client showed (`CONFLICT` if it changed, so nothing unseen is sent). `BAD_REQUEST` when the draft is empty or the session's queue is full (100 prompts); then nothing changes |
+
+The prompt lists every comment, grouped by the diff it was written on (`## Uncommitted changes`,
+`## The branch against its base`, `## Commit <sha7>`), then by file and line, each as `<path>, line
+<n>:` (or `removed line <n>`), the line quoted (`> <lineText>`) and the comment
+(`reviewPrompt` in `src/shared/review.ts`). Like every queued prompt it is not sent on its own: the
+user sends it from the session's queue. An agent can read a worktree's draft with the MCP tool
+`get_review_comments` (read-only, with each comment's `outdated`); no tool writes one.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
@@ -894,6 +943,7 @@ or `null`, and `watchingPullRequest` says the server watches the branch's pull r
 | `set_worktree_ticket` | `worktree`; `ticket?` (a Linear id or URL, or an Azure DevOps id or URL; omit to unlink) | `{branch, ticket, url}` |
 | `set_worktree_pull_request` | `worktree`; `pullRequest?` (a GitHub PR URL, or a number or `#number` when another PR in the repository gives the owner and repo; omit to unlink) | `{branch, pullRequest}` |
 | `watch_pull_request` | `worktree`; `watch?` (default true; false stops) | `{branch, pullRequest, watching}`, through `branch.setPrWatch` (see [Pull request watch](#pull-request-watch)): `TOOL_ERROR` when gh is not signed in on the server, `BAD_REQUEST` with no linked github.com PR |
+| `get_review_comments` | `worktree` | `{worktree, revision, comments: [{id, file, side, line, lineText, comment, source, sourceLabel, outdated}]}`: the worktree's draft review (see [Changes tab review](#changes-tab-review)); `revision: null` and no comments without one. Read-only. `outdated` is worked out now against each comment's own source (one `worktree.diff` per source, its path checks and limits, at most 5 sources): `true` when its file has no patch there or its line no longer reads the same, `null` when that diff could not be read (a commit gone, a missing worktree) or past the fifth source |
 | `list_session_types` | none | an array of `{id, name, systemPrompt, initialMessage?, llm?}` (no icon) |
 | `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
 | `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |
@@ -903,7 +953,7 @@ or `null`, and `watchingPullRequest` says the server watches the branch's pull r
 | `stop_stack` | `worktree` | the stack once `stack.sh down` exited 0; else `BAD_REQUEST` naming the code |
 | `read_stack_log` | `worktree`; `lines?` (default 100, 1 to 2000) | `{output}`: the last lines of the stack's log's last 64 KiB (a line cut at its start left out), colour codes removed |
 
-That is 28 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
+That is 29 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
 `stack.log` (their path checks), on the server's machine; a worktree without
 `docker/stack/stack.sh` has no stack (`get_stack` says so, the others are `BAD_REQUEST`). Tags are matched by name or id, case-insensitively, and an
 unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
diff --git a/README.md b/README.md
index ba27fc3..56255c4 100644
--- a/README.md
+++ b/README.md
@@ -201,6 +201,19 @@ other window on that project sees them live.
   installed and signed in (`gh auth login`) as the server's user; without that the
   menu item is not shown (a sign-in or sign-out on the server shows within about 10
   minutes).
+- **Changes tab review**: the Changes tab's picker compares the branch against its
+  base (the default), the uncommitted work only, or one of the newest 100 commits.
+  Hover a line and click **+** to comment on it; the draft review is kept on the
+  server, so every window on it (and a restart) sees the same comments, and it is
+  sent with **Send to session**, which lists the worktree's open sessions newest
+  first and queues every comment, with its file, line and the line's text, as one
+  prompt (sent from the queue like any other). A comment whose line has changed
+  since shows as outdated at the top of its file, and is still sent with the line
+  as it read. Comments on another source are listed in the review bar. The tab
+  stays read-only: nothing stages or reverts. Agents can read the draft with the
+  `get_review_comments` MCP tool (read-only; each comment says whether it is
+  outdated). A server older than this Trek (without the `review` capability) shows
+  only the branch against its base.
 - **This machine's features, in Local windows only**: a window on the [Local
   server](#local-server) also has Open in VS Code and Reveal in Finder, since its
   paths are this machine's. A window on a remote server shows neither.
@@ -397,6 +410,9 @@ one at a time:
 - `npm run smoke:server-prwatch`: a remote server window's pull request watch, against
   a stub `gh` (every smoke gives its servers a not-signed-in stub `gh`, `scripts/smokeGh.mjs`,
   so none runs the real one);
+- `npm run smoke:server-review`: a remote server window's Changes tab review: the
+  source picker, line comments (one from another client, live; one outdated), an
+  agent reading them with `get_review_comments`, Send to session and Discard;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 301e8a2..a284b34 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -450,7 +450,13 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
      - **Changes tab review:** a source picker (uncommitted only, the branch against its
        base, or one commit from the newest 100) and line comments on the diff. "Send to
        session" enqueues the comments, with their file and line, as one prompt. The tab
-       stays read-only: no staging or reverting.
+       stays read-only: no staging or reverting. User decisions (2026-11-10): the draft
+       comments live on the server, on the worktree (saved with the project, seen live by
+       every window and the coming web client); Send to session picks one of the
+       worktree's open agent sessions, newest first; the draft is cleared once sent; a
+       comment whose line changed is kept, shown as outdated, and still sent with the line
+       as it read. Behind a `review` capability. Plan:
+       `docs/superpowers/plans/2026-11-10-central-server-phase5c2-review.md` (5c-2).
      - **Web client:** trek-server serves a browser build of the v2 project window on
        `packages/client`, using the server's named tokens. The Electron-only actions
        (Open in VS Code, Reveal in Finder, folder pickers) are hidden there. It covers
diff --git a/server/README.md b/server/README.md
index 0489157..9ba1f9e 100644
--- a/server/README.md
+++ b/server/README.md
@@ -188,6 +188,19 @@ path: any other value is logged and gh is treated as not installed. `TREK_SERVER
 (at least 1000) is the time between polls and between sign-in checks. Both are for
 tests, which run a stub gh; leave them unset.
 
+## Changes tab review
+
+With the `review` capability a client's Changes tab can compare the branch against
+its base, the uncommitted work alone, or one commit (`worktree.changes` and
+`worktree.diff` take a `source`; `worktree.commits` lists the newest 100), and keep
+draft line comments on a worktree (`review.*`). The draft is part of the project, so
+it is saved in the project file and every client sees it live; `review.send` queues
+it on one of the worktree's sessions as one prompt and clears it in the same change.
+Nothing is sent on its own, and the tab never stages or reverts. A draft holds at
+most 100 comments of at most 4000 characters, and no more than fits in one queued
+prompt (100,000 characters). Agents can read a draft with the `get_review_comments`
+MCP tool, which never changes it. See PROTOCOL.md, "Changes tab review".
+
 ## Projects
 
 Clients create projects from registered repos (`trek-server add`). Each
````

- [ ] **Step 2: Read the docs against the code**: every method, param, limit, error and tool named matches `src/shared/protocolV2.ts`, `src/shared/review.ts`, `server/src/review/` and `server/src/mcp/tools.ts`.

- [ ] **Step 3: Commit**

```bash
git add <the new files above>
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-2) Task 6: docs: PROTOCOL.md's review capability, worktree.changes/diff sources, worktree.commits and review.*; the READMEs' Changes tab review and its smoke; the spec's 5c-2 decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

### Task 7: Final verification

- [ ] **Step 1:** `npm run typecheck`, `cd server && npm run typecheck`, `npm test` (expected: 1785 tests, 1784 pass, 1 skipped), `npm run build`.
- [ ] **Step 2:** every smoke, one at a time, each with its own temp HOME and `--user-data-dir`: server-review (37), v2 (172), local-window (57), local-features (51), server-env (30), server-integrations (33), server-prwatch (54), local-app (45), providers (36), windows (38), import (63), local (85), client, and the server's `npm run smoke -- --built`.
- [ ] **Step 3:** no trek-server or fake agent left running (`pgrep -fl trek-server`, `pgrep -fl "sleep 300"`); the tree is clean.
