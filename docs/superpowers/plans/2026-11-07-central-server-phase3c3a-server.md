# Central server phase 3c-3a: server gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the server and protocol gaps that 3c-2 left for the app to work around. 3c-3 splits in two: this plan, 3c-3a, is the server, the protocol and the SDK, and 3c-3b is the app on top of it. 3c-3a adds:
1. **Decisions on the server** (user decision): a runtime `Session.decision`, the MCP tool `request_decision`, clear-on-input in the SessionManager, `session.dismissDecision`, and decisions in the `attention` topic for 3d's notifications;
2. **Launchable agents** (user decision): `server.agents` lists every provider with whether it is installed for the server's user, plus the server's default agent;
3. **`topic.ended`**: the hub tells a deleted project's subscribers before it drops the topic, and the mirror reports `TOPIC_ENDED`, distinct from `CLOSED` and `NOT_FOUND`;
4. **Revs in responses**: a successful response carries the rev its command left the topic at; the SDK gains `requestWithRev` and `TopicMirror.whenRev`, which will replace `whenProjected`'s 10 s guess in 3c-3b;
5. **`GIT_ERROR` details**: `worktree.remove` says `details.reason: "dirty"`, whatever git's locale;
6. **`session.dequeue {index, expected}`**, and the MCP `remove_queued_prompt` uses it;
7. **a `capabilities` list** in the welcome, so the app can tell a new server from an old one;
8. the server smoke and `smoke:client` cover all of it. No app code changes; the app smokes stay green.

**Architecture:**
- **Additive, no version bump.** Every change is a new method, a new event, a new optional field or a new capability string. `protocolVersion` stays 2 (PROTOCOL.md "Versioning": additive changes don't bump it). An older client ignores the new fields and events; a newer client checks `welcome.capabilities` for what it cannot detect by absence (a method or an event), and reads the new fields when they are there.
- **Capabilities are named once.** `CAPABILITY` in `src/shared/protocolV2.ts` holds the strings, and `server/src/capabilities.ts`'s `welcomeCapabilities(mcp)` builds the welcome's list: `mcp` while the MCP listener is up (as today), then `topicEnd`, `decisions`, `dequeue` and `agents`, which this server always has. Each task adds its own string.
- **Decisions live where statuses live.** The SessionManager owns them like it owns `status`: runtime-only (`persist: false`), cleared by the same `onUserInput` path that turns `attention` into `working` (so the terminal-reply filter applies), and republished through `publishAttention`. `resetRuntime` drops them on load and import.
- **Revs are read at answer time.** `responseRev(method, params, hub)` (`v2.ts`) reads the topic's rev when the handler is done, sync or async; `server.ts` puts it on the `res` frame. `dispatchV2`'s outcome does not change, so the MCP tools and the existing dispatch tests are unaffected.
- **The SDK stays pure.** `ClientError.details`, `requestWithRev`, `whenRev` and the `TOPIC_ENDED` handling run on injected sockets and timers and are covered by `node --test` with `clientFakes.mjs`.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports), `ws`, the `src/shared/client` SDK, `node --test`, the built `trek-server` (esbuild), the server smoke (`npm --prefix server run smoke`), `smoke:client`, and the Electron smokes for the app (unchanged).

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections "Attention and notifications (phase 3)" and "v2 project window (phase 3)". Earlier plans: `docs/superpowers/plans/2026-11-06-central-server-phase3c2-window.md` (the working window; its "Notes for 3c-3" are this plan's checklist, mapped under Decisions below), `…-phase3c1-seams.md`, and `…-phase2e-mcp.md` (the server's MCP tools).

---

## Roadmap: phase 3c-3 and 3d

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-3a server gaps** (this plan) | <ul><li>`Session.decision`, MCP `request_decision`, clear-on-input, `session.dismissDecision`, decisions in the `attention` topic</li><li>`server.agents`</li><li>`topic.ended`, and `TOPIC_ENDED` in the mirror</li><li>`rev` on responses, `requestWithRev`, `whenRev`</li><li>`GIT_ERROR` `details.reason: "dirty"`, `ClientError.details`</li><li>`session.dequeue`</li><li>`welcome.capabilities`: `topicEnd`, `decisions`, `dequeue`, `agents`</li></ul> | None in the app. MCP agents on a server get `request_decision`. |
| **3c-3b the app on top** | <ul><li>decisions in server windows: the projector maps `Session.decision` into `decisions`, the attention UI shows them, DecisionIcon and NotificationsMenu dismiss with `session.dismissDecision`, and the legacy-only `clearDecision` path is not used for v2</li><li>the New session menu from `server.agents`, Default labelled with the server's `llmDefault`, and "Choose…" over that list</li><li>settings editing through `project.updateSettings` with per-key `expected` overrides</li><li>main's "app servers changed" broadcast to every window, replacing focus polling</li><li>one connection per server in main (3d's attention aggregator reuses it); renderer registry entries dropped on unmount</li><li>`TOPIC_ENDED` replacing ServerProjectTree's `offServer` workaround (kept for servers without `topicEnd`)</li><li>`whenRev` replacing `whenProjected`'s 10 s timeout (kept for servers that send no `rev`)</li><li>structural sharing in `applyV2Project`</li><li>per-window UI state reset in `installV2Window`</li><li>one server-window error helper</li><li>the notes draft lost on leave</li><li>`session.rename` sent with `expected`</li><li>the `NOT_CONNECTED` edit-loss policy</li><li>`removeQueuedText` through `session.dequeue` when the server has `dequeue`</li><li>the "Delete Uncommitted Changes" re-ask keyed on `details.reason`</li></ul> | Decisions, provider lists and settings work in server windows. |
| **3d attention and notifications** (spec) | <ul><li>main's attention aggregator: one connection per configured server, subscribed to `attention` (decisions included)</li><li>each OS notification raised once; the merged list pushed to every window's notifications menu, legacy windows included</li><li>clicking an entry focuses or opens that `(serverId, projectId)` window and selects the session</li></ul> | Notifications across servers and windows. |

Out of scope here: everything in the 3c-3b and 3d rows. Desktop-UI MCP tools stay dropped for v2 (`get_selected_worktree`, `focus_session`), and so does `promote_to_primary` (user decision).

---

## Decisions

### Recorded from the design discussion (user decisions)

1. **Decisions live on the server**: a `Session.decision` field, an MCP `request_decision` tool scoped to the calling session's project, cleared by real user input to that session's pty (reusing `noteInput` and the reply filter), never by terminal replies, and listed in the `attention` topic so 3d can use it.
2. **The server reports which agents and providers it can launch**, for the app's New Session menu in 3c-3b.
3. **Settings editing in server windows is 3c-3b.** This plan checks that `project.updateSettings` already supports field-scoped `expected` for every setting the app edits, and changes the server only if it does not (it does; Decision 15).
4. **Desktop-UI MCP tools stay dropped for v2** (`get_selected_worktree`, `focus_session`), and `promote_to_primary` too.

### Decided in this plan

**Decisions (Tasks 5 and 6)**

1. **Shape: `decision?: {question, at}`**, an optional field like `ptyId` and `exitCode`, not `{…} | null`. Absent means none, which is also what an older server sends, and a JSON patch adds or removes it. `question` is trimmed, 1 to 1000 characters (`checkQuestion` in `limits.ts`; the desktop's tool takes any length, but the question is a one-line notification summary). `at` is the server's epoch ms. A newer request replaces an open one.
2. **What clears it.**
   - **Input**: exactly what `onUserInput` already counts: a `pty.write` that is not only terminal replies (the existing `isTerminalReply` filter: cursor reports, focus in/out, mouse reports…), `session.sendPrompt`, and the MCP `send_keys` (`noteUserInput`). The decision clears in the same `apply` as the status change, so a client sees one patch. Input to a session in a status `onInput` leaves alone (idle, working, done) still clears the decision, and `since` moves only when the status does (`setStatus` now compares).
   - **`session.dismissDecision {projectId, sessionId}`**, the v2 command for the desktop's dismiss clicks (DecisionIcon, NotificationsMenu). Dismissing a session with no decision is fine.
   - **The agent going away**: `worktree.unload` and `forgetGlobal` (a repository removal) clear it with the pty; `session.close` removes the record.
   - **Not** `session.seen` (the desktop's `clearTerminalAttention` does not clear decisions either), and not an exit: the question is still open when an agent exits.
   - This differs from the desktop in one place: there, only xterm's `onKey` cleared a decision, so sending a queued prompt (a paste) did not. On the server a prompt is input (2d-2 decided `sendPrompt` always counts), so it answers the decision too. One rule for status and decisions is simpler than two.
3. **Runtime only.** Like statuses: `persist: false`, so a decision reaches disk only with a later persisted change, and `resetRuntime` (`model.ts`) drops it on load and import. A server restart ends every agent anyway; the desktop also forgets decisions when it restarts.
4. **The `attention` topic lists decisions.** An entry is listed when the session is `attention` or `done` (as today) **or** has a decision, in any status, and carries `decision` when it has one. `AttentionEntry.status` widens from `'attention' | 'done'` to `SessionStatus`, and `since` is `decision.at` for an entry listed only for its decision, so the list stays oldest-first. No client reads `attention` yet (3d is the first), so the widening breaks nothing; the type change is compile-checked.
5. **The MCP tool** is the desktop's `request_decision {terminalId, question}` → `{notified: true}`, with the description reworded for a server ("flags your session for every Trek client of this server"). Global sessions may call it, as on the desktop (`sessionIn`, not `targetIn`). It calls `SessionManager.requestDecision` directly: there is deliberately no v2 command that sets a decision, since only an agent asks one. `list_worktrees` and `get_current_session` report `decision` (the question or `null`), as the desktop's do. `MCP_INSTRUCTIONS` gains the desktop's sentence asking agents to call it. 22 tools.
6. **Capability `decisions`.** `session.dismissDecision` is a method a client cannot detect by absence (it only appears when there is a decision to dismiss), and 3d's aggregator may want to say "this server does not report decisions".

**Launchable agents (Task 8)**

7. **`server.agents {projectId?}` → `{llmDefault, agents: [{provider, label, installed}]}`**, an RPC rather than welcome data: the installed check runs a login shell per program, too slow for every hello, and the config file reloads live, which a welcome would not follow. `llmDefault` is the server config's (`ConfigStore.llmSettings()`, Claude when it names none). `agents` is every provider the server knows, in `PROVIDER_LIST` order, installed or not, with the server's own `label`, so a client older than a new provider can still show it.
8. **`installed`** is `command -v` of the command's program in the server user's login shell (`agentService.commandExists`, which the v1 `agents.commandExists` already uses). The command is the one `agentCommand` would run: the project's `claudeCommand` for Claude when `projectId` names a project that has one, else the `llm` section's `command`, else the provider's default. The program is the first word after any `NAME=value` assignments (`commandBinary`; LlmPicker checks only the first word, which reads `KEY=x claude` as not installed). `CommandProbe` shares a check in flight, reuses an answer for 60 s and starts over past 64 programs; a check that throws reads as not installed.
9. **The command lines are not sent.** A configured command can carry a secret (`API_KEY=… claude`), and the app needs only "can I offer this". The app's hint "set its command in Settings → Agents" stays hidden in v2 (3c-2 Note 1); the server's `llm` section is still edited in its config file (see the question at the end).
10. **Capability `agents`**, so the 3c-3b menu knows whether to ask or keep the 3c-2 interim.

**Topic end (Task 4)**

11. **`topic.ended {topic, reason}`**, an event sent to each subscriber of a topic just before the hub forgets it; `reason` is `'deleted'`, the only case today (`ProjectState.delete`). `TopicHub.drop(topic, reason = 'deleted')` forgets the topic first, then tells each subscriber through an optional `Subscriber.ended`, each call isolated (a throwing one is logged), so a subscriber that looks the topic up inside `ended` finds it gone. The event goes out before `onSummariesChange` patches the `server` topic, so a client hears "ended" before "not listed". `project.delete`'s response comes after both.
12. **In the mirror, `TOPIC_ENDED` is final.** On `topic.ended` the mirror drops the state, gives every listener `{error}` with code `TOPIC_ENDED`, message `<topic> ended: <reason>` and `details: {reason}`, cancels any retry, ignores a subscribe reply still in flight (`attempt++`), and never subscribes to that topic again, not after a reconnect either; a listener added later gets the same error. That is what sets it apart from `NOT_FOUND` (cleared state, retried after the next reconnect) and `CLOSED` (the connection, not the topic). The entry goes when its last listener unsubscribes, as any entry does.
13. **Capability `topicEnd`.** An older server drops the topic silently, so 3c-3b keeps the `offServer` workaround for servers without it.

**Revs (Tasks 2 and 3)**

14. **The rev rides on the `res` frame, not in the result**: `{type: 'res', id, ok: true, result, rev?: {topic, rev}}`. Result types stay as they are (`null` stays `null`), and an older client ignores the field (`connection.ts` reads only the fields it knows).
    - **Which topic.** `project.create`, `project.import`, `project.delete`, `server.addRepo` and `server.removeRepo` report the `server` topic (the project list or the repo registry). Any other method whose params name a string `projectId` reports `project:<id>`, as long as that topic still exists. Queries that name a project (`repo.listBranches`, `worktree.changes`, `worktree.diff`, `server.agents` with a `projectId`) carry the rev they read at: harmless, and one rule is easier to document than a list. Methods that name no topic (`sys.ping`, `pty.*`, `sub.*`, `project.list`, `server.agents` without one) and error replies carry none.
    - **When it is read.** `responseRev` runs as `server.ts` answers, after a sync handler returns or an async one settles, so it covers every `apply` the command made (`session.start` applies twice; `worktree.create` refreshes the poller first). Another client's change can push it higher, which is why the client test is "at least".
    - The hub writes a topic's patches to a subscriber synchronously inside `publish`, on the same socket, before any later response, so a subscribed client has usually applied the rev already when the response arrives. The rev makes it exact, including while the mirror resubscribes (Note 8 is the case where it was not).
15. **`whenRev(topic, rev, {timeoutMs?})`** resolves once the mirror's state for the topic has rev ≥ `rev`, or with any snapshot from a subscribe sent **after** the call, whatever its rev. Revs start again at 0 when the server restarts, so after a restart "at least 57" might never come, while a fresh snapshot is by definition the newest state the server has (the command was applied before its response, so a later subscribe sees it if it survived). A subscribe already in flight when the wait began does not count by itself (its snapshot may be older than the command); its rev still does. `whenRev` needs a current subscription (`NOT_SUBSCRIBED` otherwise), so it never subscribes behind the caller's back. It rejects with the topic's `NOT_FOUND` or `TOPIC_ENDED`, with `CLOSED`, with `UNSUBSCRIBED` when the last listener leaves, and with `TIMEOUT` after `timeoutMs` on the connection's timers; a transient subscribe failure keeps it waiting for the retry. `requestWithRev` resolves `{result, rev?}`, dropping a malformed `rev`; `request` is unchanged.
16. **No capability for revs or error details.** A response either has `rev` or it does not, and an error either has `details` or it does not: absence says enough (3c-3b falls back to `whenProjected` and the English regex).

**Errors (Task 1)**

17. **`WireError.details?: {reason?}`**, optional, v2 only; clients ignore keys and reasons they don't know. `codedError(code, message, details?)` attaches it and `toWireError` passes it on for a passed-through code, and only when it is a plain object. `ClientError.details` carries it to the app.
18. **`dirty` is decided from the worktree's status, not git's message.** When a non-forced `git worktree remove` fails, the handler reads `worktreeStatuses([path])` (the poller's own `git status --porcelain`) and adds `details: {reason: 'dirty'}` when the worktree has modified or untracked files. That is locale-proof without touching the desktop's shared `gitService.git` environment (`LC_ALL=C` there would change every git message the desktop shows), and it costs one `git status` only on a refusal. Any other refusal (a locked worktree) has no `details`.

**Queue (Task 7)**

19. **`session.dequeue {projectId, sessionId, index, expected?}`** was cheap, so it is in. `index` must be a non-negative integer (`BAD_REQUEST`). With `expected`, the prompt the client saw at `index`, it is compare-and-set: `CONFLICT` "queue[i] changed since you read it", and also `CONFLICT` when the queue no longer reaches `index` (from the client's point of view the queue changed). Without `expected`, an index past the end is `BAD_REQUEST`. It is saved like `setQueue`. The MCP `remove_queued_prompt` now sends it with the prompt it read, so its whole-list race is gone too. Capability `dequeue`.

**Settings (Task 9)**

20. **`project.updateSettings` needs no change.** Every key of the settings table (`SETTINGS_KINDS`, which the compiler keeps complete against `ProjectSettings`) can be listed in `expected`; only listed keys are compared, by deep equality with null meaning absent, and a stale one fails the whole patch with nothing applied. That covers what the settings screen edits (session types, quick buttons, tags, `llmDefault`, `globalLlm`, `claudeCommand`, the bot, audio alerts…). Task 9 adds a test that pins this down. `repo.update` (`name`, `linkedDirs`, `environments`) and `project.rename` already take `expected` too. What a server window cannot edit is the server-wide `llm` section, which no method writes (see the question at the end).

**Versioning**

21. **No protocol version bump, and the welcome lists capabilities.** Everything is additive; `welcome.capabilities` was already there for `mcp` and the 3c-2 app ANDs it with its feature ceiling (`v2Features`), where an unknown string turns nothing on. A 3c-2 app against this server: ignores `rev`, `details`, `decision` and the new capabilities, and sees `TOPIC_ENDED` on a deleted project, which ServerProjectTree treats as a transient error (it keeps the last view) until its `offServer` listener shows "not found" on the `server` patch that follows at once; `smoke:v2` checks exactly that path and stays green. A 3c-3b app against a 3c-2 server: sees none of the new capabilities and keeps its current paths.

### The 3c-2 "Notes for 3c-3", mapped

| # | Note | Where |
|---|---|---|
| 1 | Launchable agents for the New session menu | Server: Task 8 (`server.agents`, Decisions 7–10). App: 3c-3b |
| 2 | Decisions: projector, clear-on-input instead of `clearDecision` | Server: Tasks 5 and 6 (Decisions 1–6). App: 3c-3b |
| 3 | Settings editing with `expected` | Server: checked, no change needed (Task 9, Decision 20). App: 3c-3b |
| 4 | A deleted project only detected through the `server` topic | Task 4 (`topic.ended`, `TOPIC_ENDED`; Decisions 11–13). Dropping `offServer`: 3c-3b |
| 5 | Dead 3b styles | Done in 3c-2 |
| 6 | One connection per server in main | 3c-3b (app only) |
| 7 | The Global panel without `mcp` | 3c-3b if it matters in practice (app only; the server already reports `mcp`) |
| 8 | `whenProjected`'s 10 s | Tasks 2 and 3 (`rev`, `whenRev`; Decisions 14–15). Replacing the wait: 3c-3b |
| 9 | The uncommitted-changes match is English text | Task 1 (`details.reason: "dirty"`, Decision 18). Using it: 3c-3b |
| 10 | `session.rename` `expected` not sent | Server already supports it (`serverSessions.test.mjs` "rename trims, guards with expected…"). App: 3c-3b |
| 11 | Whole-list `session.setQueue` | Task 7 (`session.dequeue`, Decision 19). App: 3c-3b |
| 12 | Rename and complete show the old value for one round trip | By design (no optimistic UI); unchanged |
| 13 | `NOT_CONNECTED` mid-flight is silent | 3c-3b (app policy) |
| 14 | A notes draft that could not be saved on unmount or leave | 3c-3b (app) |
| 15 | Responses carrying the rev | Task 2 (Decision 14). Using it for the notes draft: 3c-3b |
| 16 | Structural sharing in `applyV2Project` | 3c-3b (app) |
| 17 | Reset per-window UI state | 3c-3b (app) |
| 18 | One error helper for component-level `showError` | 3c-3b (app) |

Every server-side note is covered here; the rest are app-side and listed in the 3c-3b row.

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import. `server/src/server.ts` is not imported by any test, so its imports keep the existing extensionless style.
  - `import type` lines are erased, so they may be extensionless.
- **Baseline:** 1157 tests pass at `ed8bda9`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck` (the app and `src/shared`) and `npm --prefix server run typecheck` (the server)
  - `npm --prefix server run smoke` (the server, from its TypeScript source; prints `SERVER SMOKE PASS`)
  - `npm run smoke:client` (builds the server, then the SDK against it; prints `CLIENT CONTRACT PASS`)
  - the app smokes, which must stay green: `npm run smoke`, `npm run smoke:windows`, `npm run smoke:v2` (it builds the app and the server and drives a server window). **Run Electron smokes strictly one at a time.**
- **Branch:** `central-server-phase3c3`, cut from master at `ed8bda9`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`; every hunk was produced from a prototype of this plan built on `ed8bda9`, one commit per task, with every check below run on it.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/shared/protocol.ts` | modify | 1, 4 | `WireError.details`, `WireErrorDetails` |
| `server/src/errors.ts` | modify | 1 | `codedError(…, details?)`; `toWireError` passes details on |
| `server/src/worktreeHandlers.ts` | modify | 1 | `removeUnforced`: `details.reason: 'dirty'` |
| `src/shared/client/connection.ts` | modify | 1, 2 | `ClientError.details`; `requestWithRev`, `RevResult`, `parseRev` |
| `src/shared/protocolV2.ts` | modify | 2, 4, 5, 7, 8 | `TopicRev`, `ResFrameV2`; `CAPABILITY`, `TopicEndedPayload`; `session.dismissDecision`, `session.dequeue`, `server.agents`, `AgentInfo`, `ServerAgents` |
| `server/src/topicHub.ts` | modify | 2, 4 | `rev(topic)`; `Subscriber.ended`, `drop(topic, reason)` tells subscribers |
| `server/src/v2.ts` | modify | 2 | `responseRev` |
| `server/src/server.ts` | modify | 2, 4 | `rev` on `res` frames; `topic.ended` events; `welcomeCapabilities` |
| `src/shared/client/mirror.ts` | modify | 3, 4 | `whenRev`, waiters; `topic.ended` → `TOPIC_ENDED` |
| `src/shared/client/mirror.typecheck.ts` | modify | 3 | `whenRev`'s type |
| `server/src/capabilities.ts` | create | 4, 5, 7, 8 | `STATIC_CAPABILITIES`, `welcomeCapabilities` |
| `src/shared/model/types.ts` | modify | 5 | `Session.decision`, `SessionDecision`; `AttentionEntry` widened |
| `server/src/sessions/status.ts` | modify | 5 | `attentionEntries` lists decisions |
| `server/src/sessions/limits.ts` | modify | 5 | `MAX_QUESTION_LENGTH`, `checkQuestion` |
| `server/src/sessions/manager.ts` | modify | 5, 7, 8 | `requestDecision`, `dismissDecision`, clear-on-input; `dequeue`; `agents` |
| `server/src/projects/model.ts` | modify | 5 | `resetSession` drops `decision` |
| `server/src/sessionHandlers.ts` | modify | 5, 7, 8 | `session.dismissDecision`, `session.dequeue`, `server.agents` |
| `server/src/mcp/tools.ts` | modify | 6, 7 | `request_decision`; `decision` in `get_current_session`; `remove_queued_prompt` via `session.dequeue` |
| `server/src/mcp/describe.ts` | modify | 6 | `decision` in worktree entries' sessions |
| `server/src/sessions/agents.ts` | create | 8 | `commandBinary`, `agentCommands`, `CommandProbe` |
| `PROTOCOL.md` | modify | 1–8 | each task documents what it adds |
| `scripts/clientFakes.mjs` | modify | 1, 2 | `fail(…, details)`, `reply(…, extra)` |
| `scripts/clientConnection.test.mjs`, `clientMirror.test.mjs` | modify | 1, 2, 3, 4 | SDK tests |
| `scripts/serverTerminalHost.test.mjs`, `serverWorktrees.test.mjs`, `serverTopicHub.test.mjs`, `serverV2.test.mjs`, `serverStatus.test.mjs`, `serverSessions.test.mjs`, `serverProjectModel.test.mjs`, `serverMcpTools.test.mjs` | modify | 1–9 | server tests |
| `scripts/serverAgents.test.mjs` | create | 8 | `server.agents` helpers |
| `server/scripts/smoke.mjs`, `scripts/client-contract.mjs` | modify | 9 | the smokes |

No file under `src/renderer`, `src/main` or `src/preload` changes.

---
### Task 1: Error details, and `dirty` on `worktree.remove`

A refused `worktree.remove` says why in a field the app can read, so 3c-3b's "Delete Uncommitted Changes" re-ask no longer depends on git speaking English (Note 9). The SDK carries the field to the caller.

**Files:**
- Modify: `src/shared/protocol.ts`, `server/src/errors.ts`, `server/src/worktreeHandlers.ts`, `src/shared/client/connection.ts`, `PROTOCOL.md`
- Test: `scripts/serverWorktrees.test.mjs`, `scripts/serverTerminalHost.test.mjs`, `scripts/clientConnection.test.mjs`, `scripts/clientFakes.mjs`

- [ ] **Step 1: Write the failing tests**

`clientFakes.mjs`'s `fail()` learns to send `details`:

````diff
--- a/scripts/clientFakes.mjs
+++ b/scripts/clientFakes.mjs
@@ -161,9 +161,9 @@ function fakeSocket(url) {
       if (!reqFrame) throw new Error('fake socket: reply() to a missing request')
       sock.receive({ type: 'res', id: reqFrame.id, ok: true, result })
     },
-    fail(reqFrame, code, message) {
+    fail(reqFrame, code, message, details) {
       if (!reqFrame) throw new Error('fake socket: fail() of a missing request')
-      sock.receive({ type: 'res', id: reqFrame.id, ok: false, error: { code, message } })
+      sock.receive({ type: 'res', id: reqFrame.id, ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
     },
     event(event, payload) {
       sock.receive({ type: 'event', event, payload })
````

The dirty refusal carries the reason, and a refusal for another reason (a locked worktree) carries none:

````diff
--- a/scripts/serverWorktrees.test.mjs
+++ b/scripts/serverWorktrees.test.mjs
@@ -212,12 +212,23 @@ test('worktree.remove refuses a dirty worktree unless forced', async (t) => {
   writeFileSync(join(wt.path, 'scratch.txt'), 'x')
   const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
   assert.equal(refused.error.code, 'GIT_ERROR')
+  assert.deepEqual(refused.error.details, { reason: 'dirty' })
   assert.ok(existsSync(wt.path))
   const forced = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: true })
   assert.equal(forced.ok, true, JSON.stringify(forced))
   assert.equal(existsSync(wt.path), false)
 })
 
+test('worktree.remove: a refusal that is not about changes carries no reason', async (t) => {
+  const s = await setup(t)
+  const wt = await withWorktree(s, 'locked')
+  git(s.a, 'worktree', 'lock', wt.path)
+  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
+  assert.equal(refused.error.code, 'GIT_ERROR')
+  assert.equal(refused.error.details, undefined)
+  assert.ok(existsSync(wt.path))
+})
+
 test('worktree.remove: the main worktree, bad force, unknown ids', async (t) => {
   const s = await setup(t)
   const mainId = s.project().repositories[0].worktrees[0].id
````

`toWireError` passes details on only for a passed-through code, and only an object (this file already imports `toWireError`):

````diff
--- a/scripts/serverTerminalHost.test.mjs
+++ b/scripts/serverTerminalHost.test.mjs
@@ -2,7 +2,7 @@
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import { TerminalHost } from '../server/src/sessions/terminalHost.ts'
-import { toWireError } from '../server/src/errors.ts'
+import { codedError, toWireError } from '../server/src/errors.ts'
 
 function fakeSpawner() {
   const spawned = []
@@ -445,3 +445,12 @@ test('spawn and resize cap sizes at 500 columns and 200 rows', (t) => {
   assert.throws(() => host.resize('p1', 80, 201), bad)
   host.resize('p1', 500, 200)
 })
+
+test('toWireError carries the details of a passed-through code, and only an object', () => {
+  assert.deepEqual(toWireError('worktree.remove', codedError('GIT_ERROR', 'dirty', { reason: 'dirty' })), { code: 'GIT_ERROR', message: 'dirty', details: { reason: 'dirty' } })
+  assert.deepEqual(toWireError('worktree.remove', codedError('GIT_ERROR', 'locked')), { code: 'GIT_ERROR', message: 'locked' })
+  const internal = Object.assign(new Error('boom'), { details: { reason: 'x' } })
+  assert.deepEqual(toWireError('session.start', internal), { code: 'INTERNAL', message: 'boom' })
+  const odd = Object.assign(codedError('GIT_ERROR', 'x'), { details: ['dirty'] })
+  assert.deepEqual(toWireError('worktree.remove', odd), { code: 'GIT_ERROR', message: 'x' })
+})
````

The SDK keeps the details on its `ClientError`:

````diff
--- a/scripts/clientConnection.test.mjs
+++ b/scripts/clientConnection.test.mjs
@@ -47,6 +47,23 @@ test('requests resolve, fail with the wire code, time out, and reject when not c
   await assert.rejects(cut, (e) => e.code === 'NOT_CONNECTED')
 })
 
+test('an error reply carries the server\'s details; malformed details are dropped', async () => {
+  const { server, conn } = setup()
+  conn.connect()
+  const sock = server.last()
+  sock.open()
+  sock.welcome()
+  const dirty = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
+  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'contains modified or untracked files', { reason: 'dirty' })
+  await assert.rejects(dirty, (e) => e.code === 'GIT_ERROR' && e.details?.reason === 'dirty')
+  const plain = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
+  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'locked')
+  await assert.rejects(plain, (e) => e.code === 'GIT_ERROR' && e.details === undefined)
+  const odd = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
+  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'x', ['dirty'])
+  await assert.rejects(odd, (e) => e.details === undefined)
+})
+
 test('reconnects with backoff 1s, 2s, 4s… capped at 30s, reset by welcome', () => {
   const { server, clock, conn, statuses } = setup()
   conn.connect()
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/clientConnection.test.mjs scripts/serverTerminalHost.test.mjs scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: these three fail, then `# pass 88` and `# fail 3`:

```
not ok - an error reply carries the server's details; malformed details are dropped
not ok - toWireError carries the details of a passed-through code, and only an object
not ok - worktree.remove refuses a dirty worktree unless forced
```

"a refusal that is not about changes carries no reason" passes already: it pins down that only dirt gets a reason.

- [ ] **Step 3: Implement**

The wire type:

````diff
--- a/src/shared/protocol.ts
+++ b/src/shared/protocol.ts
@@ -39,6 +39,14 @@ export type WireErrorCode =
 export interface WireError {
   code: WireErrorCode
   message: string
+  /** v2: a machine-readable detail of the refusal; clients ignore keys they don't know */
+  details?: WireErrorDetails
+}
+
+/** v2: what `WireError.details` may say. */
+export interface WireErrorDetails {
+  /** `dirty`: `worktree.remove` refused a worktree with modified or untracked files */
+  reason?: string
 }
 
 export interface RemoteRepo {
````

The server's errors:

````diff
--- a/server/src/errors.ts
+++ b/server/src/errors.ts
@@ -1,4 +1,4 @@
-import type { WireError, WireErrorCode } from '../../src/shared/protocol'
+import type { WireError, WireErrorCode, WireErrorDetails } from '../../src/shared/protocol'
 
 /** Errors carrying one of these codes reach the client as-is. */
 export type Outcome = { ok: true; result: unknown } | { ok: false; error: WireError }
@@ -16,9 +16,10 @@ const PASSTHROUGH: ReadonlySet<string> = new Set<WireErrorCode>([
   'CONGESTED'
 ])
 
-export function codedError(code: WireErrorCode, message: string): Error {
+export function codedError(code: WireErrorCode, message: string, details?: WireErrorDetails): Error {
   const err = new Error(message)
   ;(err as NodeJS.ErrnoException).code = code
+  if (details) (err as { details?: WireErrorDetails }).details = details
   return err
 }
 
@@ -26,6 +27,10 @@ export function toWireError(method: string, err: unknown): WireError {
   const message = err instanceof Error ? err.message : String(err)
   const code = (err as { code?: unknown } | null)?.code
   if (typeof code === 'string' && PASSTHROUGH.has(code)) {
+    const details = (err as { details?: unknown }).details
+    if (details && typeof details === 'object' && !Array.isArray(details)) {
+      return { code: code as WireErrorCode, message, details: details as WireErrorDetails }
+    }
     return { code: code as WireErrorCode, message }
   }
   return { code: method.startsWith('git.') ? 'GIT_ERROR' : 'INTERNAL', message }
````

`worktree.remove` reads the status after git refuses (`worktreeStatuses` is the poller's own `git status --porcelain`, so untracked files count, as they do for `git worktree remove`):

````diff
--- a/server/src/worktreeHandlers.ts
+++ b/server/src/worktreeHandlers.ts
@@ -29,6 +29,19 @@ async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
   }
 }
 
+/**
+ * `git worktree remove` without --force. A refusal because of modified or untracked
+ * files is told apart by reading the worktree's status, not git's localised message.
+ */
+async function removeUnforced(repoPath: string, worktreePath: string): Promise<void> {
+  try {
+    await gitService.removeWorktree(repoPath, worktreePath)
+  } catch (err) {
+    const [status] = await gitService.worktreeStatuses([worktreePath])
+    throw codedError('GIT_ERROR', (err as Error).message, status?.dirty ? { reason: 'dirty' } : undefined)
+  }
+}
+
 /** Only a real branch name: not a revision expression like @{-1}, nor HEAD, a tag or a SHA. */
 async function checkBranchName(repoPath: string, branch: string, mustExist: boolean): Promise<void> {
   if (branch.startsWith('-')) throw bad('branch must not start with "-"')
@@ -169,9 +182,8 @@ export const worktreeHandlers: Record<string, Handler> = {
       // The block lasts until the re-read has marked the row missing.
       const unblock = ctx.sessions.blockPath(worktree.path)
       try {
-        await viaGit(() => force
-          ? gitService.removeWorktreeForce(repo.path, worktree.path)
-          : gitService.removeWorktree(repo.path, worktree.path))
+        if (force) await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
+        else await removeUnforced(repo.path, worktree.path)
         // Git has removed it. Even if the re-read fails, the row goes below.
         await ctx.poller.refresh(repo.path)
       } finally {
````

The SDK. `details` is declared as a class field, so it exists (as `undefined`) on every `ClientError`; callers test its value, not `'details' in err`:

````diff
--- a/src/shared/client/connection.ts
+++ b/src/shared/client/connection.ts
@@ -2,6 +2,7 @@
 // ping, and reconnect with backoff. Ported from the desktop's v1 RemoteHost.
 // Pure TypeScript: the socket and the timers are injected.
 import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION } from '../protocol.ts'
+import type { WireErrorDetails } from '../protocol.ts'
 import {
   CLOSE_REASON_UPGRADE_CLIENT,
   PROTOCOL_VERSION_V2,
@@ -58,10 +59,13 @@ export interface RequestOptions {
 
 export class ClientError extends Error {
   readonly code: string
-  constructor(code: string, message: string) {
+  /** The server's `error.details`, when its reply carried any */
+  readonly details?: WireErrorDetails
+  constructor(code: string, message: string, details?: WireErrorDetails) {
     super(message)
     this.name = 'ClientError'
     this.code = code
+    this.details = details
   }
 }
 
@@ -93,7 +97,7 @@ interface IncomingFrame {
   id?: unknown
   ok?: unknown
   result?: unknown
-  error?: { code?: unknown; message?: unknown }
+  error?: { code?: unknown; message?: unknown; details?: unknown }
   event?: unknown
   payload?: unknown
   serverId?: unknown
@@ -299,7 +303,9 @@ export class ServerConnection {
       } else {
         const code = typeof frame.error?.code === 'string' ? frame.error.code : 'INTERNAL'
         const message = typeof frame.error?.message === 'string' ? frame.error.message : 'request failed'
-        pending.reject(new ClientError(code, message))
+        const details = frame.error?.details
+        const known = details && typeof details === 'object' && !Array.isArray(details) ? (details as WireErrorDetails) : undefined
+        pending.reject(new ClientError(code, message, known))
       }
       return
     }
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -231,6 +231,11 @@ Params and results are in `MethodParamsV2` / `MethodResultsV2`. Commands change
 state only through the server, so their effects arrive as patches. Command
 results carry only new ids; queries return their data.
 
+An error reply may carry `error.details`, an object a client can act on without
+reading the message (which may be git's own, localised text). Today the only key
+is `reason`, and the only reason is `dirty` (see `worktree.remove`). Clients
+ignore keys and reasons they don't know.
+
 `project.rename`, `project.updateSettings`, `branch.setNote`, `session.rename`
 and `repo.update` take an optional `expected`: the value the client believes the
 field has now. The server fails with `CONFLICT` only if that field's current
@@ -291,7 +296,11 @@ worktree stays on disk.
 
 `worktree.remove {projectId, worktreeId, force?}` runs `git worktree remove`
 and drops the row. A dirty worktree fails with `GIT_ERROR` unless
-`force: true`, so a client can confirm with the user and retry. The main
+`force: true`, so a client can confirm with the user and retry. When git refuses
+and the worktree has modified or untracked files (the server reads its status
+after the refusal, so git's locale does not matter), the error carries
+`details: {reason: "dirty"}`; any other refusal (a locked worktree, say) has no
+`details`. The main
 worktree is `BAD_REQUEST`; a worktree that any project has loaded is `IN_USE`.
 For a worktree whose directory was deleted but which git still lists, `git
 worktree remove` clears just that worktree from git's list; the server never
@@ -798,7 +807,8 @@ then stale, so no ping starts and no welcome listener runs for it.
 `connected` fails with `NOT_CONNECTED`, and so does every request still pending
 when the socket closes. The default timeout is 60 s (`requestTimeoutMs`, or
 `timeoutMs` per call); a timeout fails with `TIMEOUT`. Error replies reject with a
-`ClientError` carrying the server's `code`.
+`ClientError` carrying the server's `code`, and its `details` when the reply has
+an object there (anything else is dropped).
 
 **Mirror.** `TopicMirror.subscribe(topic, listener)` reference-counts per topic:
 the first listener sends `sub.subscribe`, later ones get the current state at
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/clientConnection.test.mjs scripts/serverTerminalHost.test.mjs scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 91`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean (no output after the `tsc --noEmit` lines).

`npm test` is at 1160 (1157 + 3).

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): GIT_ERROR details — worktree.remove says when the worktree is dirty" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/errors.ts server/src/worktreeHandlers.ts src/shared/client/connection.ts src/shared/protocol.ts scripts/clientConnection.test.mjs scripts/clientFakes.mjs scripts/serverTerminalHost.test.mjs scripts/serverWorktrees.test.mjs
```

---

### Task 2: Responses carry the rev; `requestWithRev`

A successful response says which rev its command left the topic at (Notes 8 and 15). The SDK hands it back with `requestWithRev`; Task 3 waits for it.

**Files:**
- Modify: `server/src/topicHub.ts`, `server/src/v2.ts`, `server/src/server.ts`, `src/shared/protocolV2.ts`, `src/shared/client/connection.ts`, `PROTOCOL.md`
- Test: `scripts/serverTopicHub.test.mjs`, `scripts/serverV2.test.mjs`, `scripts/clientConnection.test.mjs`, `scripts/clientFakes.mjs`

- [ ] **Step 1: Write the failing tests**

`clientFakes.mjs`'s `reply()` takes extra frame fields:

````diff
--- a/scripts/clientFakes.mjs
+++ b/scripts/clientFakes.mjs
@@ -157,9 +157,10 @@ function fakeSocket(url) {
         ...extra
       })
     },
-    reply(reqFrame, result) {
+    /** `extra` adds fields to the res frame (say, `{rev: {topic, rev}}`). */
+    reply(reqFrame, result, extra = {}) {
       if (!reqFrame) throw new Error('fake socket: reply() to a missing request')
-      sock.receive({ type: 'res', id: reqFrame.id, ok: true, result })
+      sock.receive({ type: 'res', id: reqFrame.id, ok: true, result, ...extra })
     },
     fail(reqFrame, code, message, details) {
       if (!reqFrame) throw new Error('fake socket: fail() of a missing request')
````

The hub reads a topic's rev:

````diff
--- a/scripts/serverTopicHub.test.mjs
+++ b/scripts/serverTopicHub.test.mjs
@@ -110,6 +110,18 @@ test('drop forgets the topic and its subscribers; publishing again starts at rev
   assert.equal(sub.sent.length, 1)
 })
 
+test('rev reads the current rev; undefined for a topic never published or dropped', () => {
+  const hub = new TopicHub()
+  assert.equal(hub.rev('project:p'), undefined)
+  hub.publish('project:p', { n: 0 })
+  assert.equal(hub.rev('project:p'), 0)
+  hub.publish('project:p', { n: 1 })
+  hub.publish('project:p', { n: 1 })
+  assert.equal(hub.rev('project:p'), 1, 'an unchanged snapshot keeps the rev')
+  hub.drop('project:p')
+  assert.equal(hub.rev('project:p'), undefined)
+})
+
 test('subscriberCount follows subscribe, unsubscribe and unsubscribeAll', () => {
   const hub = new TopicHub()
   hub.publish('project:p', { a: 1 })
````

`responseRev` picks the topic and reads its rev. `setup()` now returns its `hub`:

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -10,7 +10,7 @@ import { ConfigStore } from '../server/src/configStore.ts'
 import { ProjectState } from '../server/src/projects/state.ts'
 import { publishServerState } from '../server/src/serverState.ts'
 import { TopicHub } from '../server/src/topicHub.ts'
-import { dispatchV2 } from '../server/src/v2.ts'
+import { dispatchV2, responseRev } from '../server/src/v2.ts'
 import { applyStatePatch } from '../src/shared/sync/topicState.ts'
 
 function setup(t) {
@@ -47,7 +47,7 @@ function setup(t) {
     forgetGlobal: (projectId) => forgotten.push(['global', projectId])
   }
   const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects: holder.projects, sessions })
-  return { dir, a, store, sent, call, forgotten, projects: holder.projects }
+  return { dir, a, store, hub, sent, call, forgotten, projects: holder.projects }
 }
 
 test('subscribing to server returns identity, repos and no projects', async (t) => {
@@ -227,6 +227,30 @@ test('project.delete removes it everywhere; removeRepo is IN_USE until then', as
   assert.equal((await call('server.removeRepo', { repoId: 'a' })).ok, true)
 })
 
+test('responseRev: a project command reports its project topic, a registry or project-list command the server topic', async (t) => {
+  const { a, hub, call } = setup(t)
+  const params = { name: 'P', repositories: [{ path: a }] }
+  const { projectId } = (await call('project.create', params)).result
+  const serverRev = hub.rev('server')
+  assert.deepEqual(responseRev('project.create', params, hub), { topic: 'server', rev: serverRev })
+  const topic = `project:${projectId}`
+  assert.deepEqual(responseRev('project.rename', { projectId }, hub), { topic, rev: 0 })
+  await call('project.rename', { projectId, name: 'Q' })
+  await call('project.rename', { projectId, name: 'R' })
+  assert.deepEqual(responseRev('project.rename', { projectId }, hub), { topic, rev: 2 })
+  // A read that names a project reports the rev it read at.
+  assert.deepEqual(responseRev('repo.listBranches', { projectId, repoId: 'x' }, hub), { topic, rev: 2 })
+  // Renames and the delete each change the server topic's project list.
+  await call('project.delete', { projectId })
+  assert.equal(hub.rev('server'), serverRev + 3)
+  assert.deepEqual(responseRev('project.delete', { projectId }, hub), { topic: 'server', rev: serverRev + 3 })
+  assert.equal(responseRev('project.rename', { projectId }, hub), undefined, 'the topic is gone')
+  assert.equal(responseRev('sys.ping', { t: 1 }, hub), undefined)
+  assert.equal(responseRev('pty.write', { ptyId: 'x', data: 'y' }, hub), undefined)
+  assert.equal(responseRev('project.rename', { projectId: 5 }, hub), undefined)
+  assert.equal(responseRev('project.rename', undefined, hub), undefined)
+})
+
 test('project.import accepts a project from importProjectFile', async (t) => {
   const { a, call } = setup(t)
   const { importProjectFile } = await import('../src/shared/model/importProject.ts')
````

The SDK:

````diff
--- a/scripts/clientConnection.test.mjs
+++ b/scripts/clientConnection.test.mjs
@@ -64,6 +64,34 @@ test('an error reply carries the server\'s details; malformed details are droppe
   await assert.rejects(odd, (e) => e.details === undefined)
 })
 
+test('requestWithRev resolves with the result and the response rev; request() still resolves the bare result', async () => {
+  const { server, conn } = setup()
+  await assert.rejects(conn.requestWithRev('sys.ping', { t: 1 }), (e) => e.code === 'NOT_CONNECTED')
+  conn.connect()
+  const sock = server.last()
+  sock.open()
+  sock.welcome()
+  const rev = { topic: 'project:p', rev: 12 }
+  const withRev = conn.requestWithRev('worktree.create', { projectId: 'p', repoId: 'r', branch: 'b', createBranch: true })
+  sock.reply(sock.lastReq('worktree.create'), { worktreeId: 'w' }, { rev })
+  assert.deepEqual(await withRev, { result: { worktreeId: 'w' }, rev })
+  const bare = conn.request('project.rename', { projectId: 'p', name: 'x' })
+  sock.reply(sock.lastReq('project.rename'), null, { rev })
+  assert.equal(await bare, null)
+  // An older server sends no rev; a malformed one is dropped.
+  const none = conn.requestWithRev('project.rename', { projectId: 'p', name: 'y' })
+  sock.reply(sock.lastReq('project.rename'), null)
+  assert.deepEqual(await none, { result: null })
+  for (const odd of [{ topic: 'project:p', rev: -1 }, { topic: 3, rev: 1 }, { topic: 'server', rev: 1.5 }, 'server', null]) {
+    const r = conn.requestWithRev('project.rename', { projectId: 'p', name: 'z' })
+    sock.reply(sock.lastReq('project.rename'), null, { rev: odd })
+    assert.deepEqual(await r, { result: null }, JSON.stringify(odd))
+  }
+  const refused = conn.requestWithRev('project.rename', { projectId: 'p', name: 'q' })
+  sock.fail(sock.lastReq('project.rename'), 'CONFLICT', 'changed')
+  await assert.rejects(refused, (e) => e.code === 'CONFLICT')
+})
+
 test('reconnects with backoff 1s, 2s, 4s… capped at 30s, reset by welcome', () => {
   const { server, clock, conn, statuses } = setup()
   conn.connect()
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/clientConnection.test.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|does not provide'`

Expected: `# pass 40`, `# fail 3`, with:

```
not ok - requestWithRev resolves with the result and the response rev; request() still resolves the bare result
not ok - rev reads the current rev; undefined for a topic never published or dropped
# SyntaxError: The requested module '../server/src/v2.ts' does not provide an export named 'responseRev'
not ok - scripts/serverV2.test.mjs
```

(the first two fail with `TypeError: … is not a function`).

- [ ] **Step 3: Implement**

The hub:

````diff
--- a/server/src/topicHub.ts
+++ b/server/src/topicHub.ts
@@ -30,6 +30,11 @@ export class TopicHub {
     return () => this.subscribeListeners.delete(listener)
   }
 
+  /** The topic's current rev; undefined if it was never published or was dropped. */
+  rev(topic: Topic): number | undefined {
+    return this.topics.get(topic)?.rev
+  }
+
   subscriberCount(topic: Topic): number {
     return this.topics.get(topic)?.subscribers.size ?? 0
   }
````

The frame type. `ResFrame` from `protocol.ts` stays v1's; v2 gets its own, with `rev` on a success:

````diff
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -14,7 +14,7 @@ import type {
   EventFrame,
   EventPayloads as EventPayloadsV1,
   PtyInfo,
-  ResFrame
+  WireError
 } from './protocol.ts'
 import type { LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
@@ -224,7 +224,18 @@ type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] ext
 /** Compile-time check: every method has both params and a result type. */
 export const _catalogComplete: SameKeys<MethodParamsV2, MethodResultsV2> = true
 
-export type ServerFrameV2 = WelcomeFrameV2 | ResFrame | EventFrame
+/** A topic's rev, as a successful response reports it (PROTOCOL.md, "Revs"). */
+export interface TopicRev {
+  topic: Topic
+  rev: number
+}
+
+/** A v2 response. A success may carry the rev its command left a topic at. */
+export type ResFrameV2 =
+  | { type: 'res'; id: number; ok: true; result: unknown; rev?: TopicRev }
+  | { type: 'res'; id: number; ok: false; error: WireError }
+
+export type ServerFrameV2 = WelcomeFrameV2 | ResFrameV2 | EventFrame
 
 export interface StatePatchPayload extends StatePatch {
   topic: Topic
````

`responseRev` in `v2.ts`:

````diff
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -1,7 +1,8 @@
 // Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
 // projects, repositories and branch data, worktree commands, session.*, worktree.load/unload
 // and the v2 pty.* stream. Attention (working/done) arrives in 2d-2.
-import { parseTopic } from '../../src/shared/model/topics.ts'
+import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
+import type { TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
 import { codedError, toWireError, type Outcome } from './errors.ts'
 import type { Subscriber, TopicHub } from './topicHub'
@@ -259,6 +260,29 @@ const handlers: Record<string, Handler> = {
   ...sessionHandlers
 }
 
+/** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
+const SERVER_TOPIC_METHODS: ReadonlySet<string> = new Set([
+  'project.create',
+  'project.import',
+  'project.delete',
+  'server.addRepo',
+  'server.removeRepo'
+])
+
+/**
+ * The rev a successful response reports (PROTOCOL.md, "Revs"): the `server` topic's for
+ * the commands above, else the project topic's for a method whose params name a project
+ * that still has one. Read once the handler is done, so it covers every change it made.
+ */
+export function responseRev(method: string, params: unknown, hub: TopicHub): TopicRev | undefined {
+  let topic: Topic | undefined
+  if (SERVER_TOPIC_METHODS.has(method)) topic = 'server'
+  else if (isRecord(params) && typeof params.projectId === 'string') topic = projectTopic(params.projectId)
+  if (!topic) return undefined
+  const rev = hub.rev(topic)
+  return rev === undefined ? undefined : { topic, rev }
+}
+
 /**
  * Synchronous when the handler is: the caller can then answer in the same tick,
  * so a `sub.subscribe` response always precedes the patches it registered for.
````

`server.ts` reads it as it answers, for sync and async handlers alike, and only on success:

````diff
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -10,7 +10,8 @@ import {
 import {
   PROTOCOL_VERSION_V2,
   SUPPORTED_PROTOCOL_VERSIONS,
-  type ServerFrameV2
+  type ServerFrameV2,
+  type TopicRev
 } from '../../src/shared/protocolV2'
 import type { Outcome } from './errors'
 import { isRecord } from './validate'
@@ -22,7 +23,7 @@ import { dispatch } from './rpc'
 import { publishServerState } from './serverState'
 import { activeTokenHashes, matchToken } from './tokens'
 import { TopicHub, type Subscriber } from './topicHub'
-import { dispatchV2 } from './v2'
+import { dispatchV2, responseRev } from './v2'
 import { GitPoller } from './git/poller'
 import { SessionManager } from './sessions/manager'
 import type { TerminalSink } from './sessions/terminalHost'
@@ -171,9 +172,9 @@ export function startServer(
       missedPongs = 0
     })
 
-    const respond = (id: number, outcome: Outcome): void => {
+    const respond = (id: number, outcome: Outcome, rev?: TopicRev): void => {
       if (outcome.ok) {
-        sendFrame(ws, { type: 'res', id, ok: true, result: outcome.result })
+        sendFrame(ws, rev ? { type: 'res', id, ok: true, result: outcome.result, rev } : { type: 'res', id, ok: true, result: outcome.result })
       } else {
         sendFrame(ws, { type: 'res', id, ok: false, error: outcome.error })
       }
@@ -277,10 +278,14 @@ export function startServer(
               }
             : undefined
         })
+        const method = frame.method
+        const params = frame.params
+        // A success reports the rev its command left the topic at, read as it answers.
+        const answer = (o: Outcome): void => respond(id, o, o.ok ? responseRev(method, params, hub) : undefined)
         // Answer synchronous handlers in this tick: a sub.subscribe response
         // must reach the client before any patch for the topic it subscribed to.
-        if (outcome instanceof Promise) outcome.then((o) => respond(id, o)).catch(internalError)
-        else respond(id, outcome)
+        if (outcome instanceof Promise) outcome.then(answer).catch(internalError)
+        else answer(outcome)
       } else {
         dispatch(frame.method, frame.params, { config: store.config, guard: store.guard, ptys, ws })
           .then((o) => respond(id, o))
````

The SDK. The private `send` now resolves the whole reply; `request` unwraps it as before, and `requestWithRev` hands back the rev too:

````diff
--- a/src/shared/client/connection.ts
+++ b/src/shared/client/connection.ts
@@ -8,7 +8,8 @@ import {
   PROTOCOL_VERSION_V2,
   type MethodNameV2,
   type MethodParamsV2,
-  type MethodResultsV2
+  type MethodResultsV2,
+  type TopicRev
 } from '../protocolV2.ts'
 import { OPEN, realTimers, type SocketFactory, type SocketLike, type Timers } from './socket.ts'
 
@@ -57,6 +58,30 @@ export interface RequestOptions {
   timeoutMs?: number
 }
 
+/** What `requestWithRev` resolves with. */
+export interface RevResult<M extends MethodNameV2> {
+  result: MethodResultsV2[M]
+  /**
+   * The rev the command left its topic at (PROTOCOL.md, "Revs"). Absent for a
+   * method that names no topic, and from a server older than this field.
+   */
+  rev?: TopicRev
+}
+
+/** A successful reply, before `request` unwraps it. */
+interface Reply {
+  result: unknown
+  rev?: TopicRev
+}
+
+/** The response's `rev`, if it has the right shape. */
+function parseRev(value: unknown): TopicRev | undefined {
+  if (!value || typeof value !== 'object') return undefined
+  const { topic, rev } = value as { topic?: unknown; rev?: unknown }
+  if (typeof topic !== 'string' || !Number.isInteger(rev) || (rev as number) < 0) return undefined
+  return { topic: topic as TopicRev['topic'], rev: rev as number }
+}
+
 export class ClientError extends Error {
   readonly code: string
   /** The server's `error.details`, when its reply carried any */
@@ -86,7 +111,7 @@ export const SERVER_REMOVED_MESSAGE = 'Server removed'
 type Listener<T> = (value: T) => void
 
 interface Pending {
-  resolve(value: unknown): void
+  resolve(value: Reply): void
   reject(err: Error): void
   timer: unknown
 }
@@ -100,6 +125,7 @@ interface IncomingFrame {
   error?: { code?: unknown; message?: unknown; details?: unknown }
   event?: unknown
   payload?: unknown
+  rev?: unknown
   serverId?: unknown
   serverName?: unknown
   daemonVersion?: unknown
@@ -184,7 +210,18 @@ export class ServerConnection {
     params: MethodParamsV2[M],
     options: RequestOptions = {}
   ): Promise<MethodResultsV2[M]> {
-    return this.send(method, params, options.timeoutMs) as Promise<MethodResultsV2[M]>
+    return this.send(method, params, options.timeoutMs).then((reply) => reply.result as MethodResultsV2[M])
+  }
+
+  /** As `request`, and also hands back the rev the response reports (see `TopicMirror.whenRev`). */
+  requestWithRev<M extends MethodNameV2>(
+    method: M,
+    params: MethodParamsV2[M],
+    options: RequestOptions = {}
+  ): Promise<RevResult<M>> {
+    return this.send(method, params, options.timeoutMs).then((reply) =>
+      reply.rev ? { result: reply.result as MethodResultsV2[M], rev: reply.rev } : { result: reply.result as MethodResultsV2[M] }
+    )
   }
 
   /**
@@ -192,13 +229,13 @@ export class ServerConnection {
    * before the promise rejects, so the ping can close the socket at once rather
    * than a microtask later.
    */
-  private send(method: string, params: unknown, timeoutMs: number | undefined, onTimeout?: () => void): Promise<unknown> {
+  private send(method: string, params: unknown, timeoutMs: number | undefined, onTimeout?: () => void): Promise<Reply> {
     const socket = this.socket
     if (this.status !== 'connected' || !socket || socket.readyState !== OPEN) {
       return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
     }
     const id = this.nextId++
-    return new Promise((resolve, reject) => {
+    return new Promise<Reply>((resolve, reject) => {
       const timer = this.timers.setTimeout(() => {
         if (!this.pending.delete(id)) return
         onTimeout?.()
@@ -299,7 +336,8 @@ export class ServerConnection {
       this.pending.delete(frame.id)
       this.timers.clearTimeout(pending.timer)
       if (frame.ok) {
-        pending.resolve(frame.result)
+        const rev = parseRev(frame.rev)
+        pending.resolve(rev ? { result: frame.result, rev } : { result: frame.result })
       } else {
         const code = typeof frame.error?.code === 'string' ? frame.error.code : 'INTERNAL'
         const message = typeof frame.error?.message === 'string' ? frame.error.message : 'request failed'
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -213,6 +213,27 @@ comes from the `server` topic.
 - Subscriptions end with `sub.unsubscribe` or when the socket closes.
 - Unknown topics fail with `BAD_REQUEST`; unknown project ids with `NOT_FOUND`.
 
+**Revs in responses.** A successful response to a method whose params name a
+`projectId` carries `rev: {topic: "project:<id>", rev}`: the project topic's rev
+once the method finished, so it covers every change the command made.
+`project.create`, `project.import`, `project.delete`, `server.addRepo` and
+`server.removeRepo` carry the `server` topic's rev instead. A query that names a
+project (`repo.listBranches`, `worktree.changes`, `worktree.diff`) carries the
+rev it read at. Methods that name no topic (`sys.ping`, `pty.*`, `sub.*`,
+`project.list`), error replies, and a project whose topic is gone carry none.
+
+```json
+{ "type": "res", "id": 9, "ok": true, "result": { "worktreeId": "w3" },
+  "rev": { "topic": "project:p1", "rev": 57 } }
+```
+
+The server writes a topic's patches to a subscriber before the response of any
+later command on the same socket, so a subscribed client has usually applied
+that rev by the time the response arrives (not while it is resubscribing).
+`rev` lets it know for sure. Other clients' changes move the rev too, so the
+test is always "at least `rev`", never "exactly". Revs start again at 0 when the
+server restarts. A server without this field simply leaves it out.
+
 ## Commands
 
 | Group | Methods |
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/clientConnection.test.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 72`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean. `npm test` is at 1163. The real `server.ts` path (the frame on the wire, and that the patch precedes it) is checked by the server smoke in Task 9.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): responses report the rev their command left the topic at; SDK requestWithRev" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/server.ts server/src/topicHub.ts server/src/v2.ts src/shared/client/connection.ts src/shared/protocolV2.ts scripts/clientConnection.test.mjs scripts/clientFakes.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs
```

---

### Task 3: `TopicMirror.whenRev`

The wait that will replace `whenProjected`'s 10 s guess in 3c-3b (Note 8): resolve once the mirror holds the rev a response named (Decision 15).

**Files:**
- Modify: `src/shared/client/mirror.ts`, `src/shared/client/mirror.typecheck.ts`, `PROTOCOL.md`
- Test: `scripts/clientMirror.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/clientMirror.test.mjs` (`setup`, `tick` and `subReqs` are the file's own helpers):

````diff
--- a/scripts/clientMirror.test.mjs
+++ b/scripts/clientMirror.test.mjs
@@ -310,3 +310,114 @@ test('close() gives every listener a CLOSED error and drops the topics', async (
   mirror.subscribe('server', (s) => late.push(s))
   assert.equal(late.at(-1).error.code, 'CLOSED', 'a subscribe after close hears CLOSED at once')
 })
+
+// ---- whenRev ----
+
+/** Settles `promise` into a plain record, so a test can check it without awaiting forever. */
+function track(promise) {
+  const out = { state: undefined, error: undefined, settled: false }
+  promise.then((s) => { out.state = s; out.settled = true }, (e) => { out.error = e; out.settled = true })
+  return out
+}
+
+test('whenRev resolves at once when the mirror holds the rev, else with the patch that reaches it', async () => {
+  const { mirror, sock } = setup()
+  mirror.subscribe('project:p', () => {})
+  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 4 })
+  await tick()
+  assert.deepEqual(await mirror.whenRev('project:p', 3), { snapshot: { n: 1 }, rev: 4 })
+  assert.deepEqual(await mirror.whenRev('project:p', 4), { snapshot: { n: 1 }, rev: 4 })
+  const later = track(mirror.whenRev('project:p', 6))
+  sock.event('state.patch', { topic: 'project:p', rev: 5, ops: [{ op: 'replace', path: '/n', value: 2 }] })
+  await tick()
+  assert.equal(later.settled, false, 'rev 5 is not 6 yet')
+  sock.event('state.patch', { topic: 'project:p', rev: 6, ops: [{ op: 'replace', path: '/n', value: 3 }] })
+  await tick()
+  assert.deepEqual(later.state, { snapshot: { n: 3 }, rev: 6 })
+})
+
+test('whenRev before the first snapshot, and across a gap resubscribe', async () => {
+  const { mirror, sock } = setup()
+  mirror.subscribe('project:p', () => {})
+  const early = track(mirror.whenRev('project:p', 2))
+  // This subscribe was in flight when the wait began: only its rev can settle it.
+  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 1 })
+  await tick()
+  assert.equal(early.settled, false)
+  sock.event('state.patch', { topic: 'project:p', rev: 3, ops: [] })
+  // The gap resubscribes; its snapshot is past the rev.
+  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 9 }, rev: 3 })
+  await tick()
+  assert.deepEqual(early.state, { snapshot: { n: 9 }, rev: 3 })
+})
+
+test('whenRev settles on a snapshot subscribed after the call whatever its rev: a restarted server starts at 0', async () => {
+  const { server, clock, mirror, sock } = setup()
+  mirror.subscribe('project:p', () => {})
+  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 40 })
+  await tick()
+  const wait = track(mirror.whenRev('project:p', 41))
+  sock.serverClose(1006, '')
+  clock.advance(1000)
+  const next = server.last()
+  next.open()
+  next.welcome()
+  next.reply(next.lastReq('sub.subscribe'), { snapshot: { n: 2 }, rev: 0 })
+  await tick()
+  assert.deepEqual(wait.state, { snapshot: { n: 2 }, rev: 0 })
+})
+
+test('whenRev rejects: not subscribed, NOT_FOUND, the last unsubscribe, close, and its timeout', async () => {
+  const { clock, conn, mirror, sock } = setup()
+  await assert.rejects(mirror.whenRev('project:x', 1), (e) => e.code === 'NOT_SUBSCRIBED')
+
+  mirror.subscribe('project:gone', () => {})
+  const gone = track(mirror.whenRev('project:gone', 1))
+  sock.fail(subReqs(sock).at(-1), 'NOT_FOUND', 'No such topic')
+  await tick()
+  assert.equal(gone.error.code, 'NOT_FOUND')
+  await assert.rejects(mirror.whenRev('project:gone', 1), (e) => e.code === 'NOT_FOUND', 'at once while the topic is not found')
+
+  const stop = mirror.subscribe('project:a', () => {})
+  sock.reply(subReqs(sock).at(-1), { snapshot: {}, rev: 0 })
+  await tick()
+  const left = track(mirror.whenRev('project:a', 5))
+  stop()
+  await tick()
+  assert.equal(left.error.code, 'UNSUBSCRIBED')
+
+  mirror.subscribe('project:b', () => {})
+  sock.reply(subReqs(sock).at(-1), { snapshot: {}, rev: 0 })
+  await tick()
+  const slow = track(mirror.whenRev('project:b', 5, { timeoutMs: 2000 }))
+  clock.advance(1999)
+  await tick()
+  assert.equal(slow.settled, false)
+  clock.advance(1)
+  await tick()
+  assert.equal(slow.error.code, 'TIMEOUT')
+  const fast = track(mirror.whenRev('project:b', 1, { timeoutMs: 2000 }))
+  sock.event('state.patch', { topic: 'project:b', rev: 1, ops: [] })
+  await tick()
+  assert.equal(fast.state.rev, 1)
+  const pendingTimers = clock.pending()
+  const closing = track(mirror.whenRev('project:b', 9, { timeoutMs: 5000 }))
+  assert.equal(clock.pending(), pendingTimers + 1)
+  conn.close()
+  await tick()
+  assert.equal(closing.error.code, 'CLOSED')
+  assert.equal(clock.pending(), 0, 'no timer outlives its wait')
+})
+
+test('a transient subscribe failure keeps whenRev waiting; the retry settles it', async () => {
+  const { clock, mirror, sock } = setup()
+  mirror.subscribe('project:p', () => {})
+  const wait = track(mirror.whenRev('project:p', 2))
+  sock.fail(subReqs(sock).at(-1), 'INTERNAL', 'boom')
+  await tick()
+  assert.equal(wait.settled, false)
+  clock.advance(1000)
+  sock.reply(subReqs(sock).at(-1), { snapshot: { n: 1 }, rev: 0 })
+  await tick()
+  assert.deepEqual(wait.state, { snapshot: { n: 1 }, rev: 0 }, 'the retry was sent after the call')
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/clientMirror.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 16`, `# fail 5`; the five new tests fail with `TypeError: mirror.whenRev is not a function`:

```
not ok - whenRev resolves at once when the mirror holds the rev, else with the patch that reaches it
not ok - whenRev before the first snapshot, and across a gap resubscribe
not ok - whenRev settles on a snapshot subscribed after the call whatever its rev: a restarted server starts at 0
not ok - whenRev rejects: not subscribed, NOT_FOUND, the last unsubscribe, close, and its timeout
not ok - a transient subscribe failure keeps whenRev waiting; the retry settles it
```

- [ ] **Step 3: Implement**

Each entry keeps its waiters. A subscribe success settles them with its `attempt` (so a subscribe sent after the wait began settles it whatever its rev), an applied patch settles them by rev, and `NOT_FOUND`, `CLOSED` and the last unsubscribe reject them. A waiter's timer is cleared whenever it settles, so none outlives its wait:

````diff
--- a/src/shared/client/mirror.ts
+++ b/src/shared/client/mirror.ts
@@ -13,6 +13,21 @@ export type MirrorListener<T extends Topic = Topic> = (update: MirrorUpdate<T>)
 /** Internally, one entry holds listeners of one topic; the snapshot's type follows from that topic. */
 type Listener = (update: TopicState<unknown> | { error: ClientError }) => void
 
+export interface WhenRevOptions {
+  /** Reject with TIMEOUT after this long, on the connection's timers. Without it the wait has no limit. */
+  timeoutMs?: number
+}
+
+/** A `whenRev` call still waiting. */
+interface Waiter {
+  rev: number
+  /** The entry's `attempt` when the wait began: a snapshot from any later subscribe settles it */
+  attempt: number
+  resolve(state: TopicState<unknown>): void
+  reject(err: ClientError): void
+  timer: unknown
+}
+
 interface Entry {
   listeners: Set<Listener>
   state?: TopicState<unknown>
@@ -25,6 +40,8 @@ interface Entry {
   retryTimer: unknown
   /** The next retry's delay */
   retryDelay: number
+  /** `whenRev` calls waiting on this topic */
+  waiters: Set<Waiter>
 }
 
 /** A subscribe that fails transiently (not NOT_FOUND or NOT_CONNECTED) is retried after 1 s, doubling to 30 s. */
@@ -65,7 +82,7 @@ export class TopicMirror {
     }
     let entry = this.topics.get(topic)
     if (!entry) {
-      entry = { listeners: new Set(), attempt: 0, loading: false, retryTimer: null, retryDelay: RETRY_MIN_MS }
+      entry = { listeners: new Set(), attempt: 0, loading: false, retryTimer: null, retryDelay: RETRY_MIN_MS, waiters: new Set() }
       this.topics.set(topic, entry)
       entry.listeners.add(listener)
       if (this.conn.status === 'connected') this.resubscribe(topic)
@@ -84,10 +101,45 @@ export class TopicMirror {
       if (current.listeners.size > 0) return
       this.topics.delete(topic)
       this.cancelRetry(current)
+      this.failWaiters(current, new ClientError('UNSUBSCRIBED', `${topic} was unsubscribed`))
       this.conn.request('sub.unsubscribe', { topic }).catch(() => {})
     }
   }
 
+  /**
+   * Resolves with the topic's state once the mirror holds `rev` or later (a
+   * response's `rev`, see `ServerConnection.requestWithRev`), or a snapshot from a
+   * subscribe sent after this call, whatever its rev: that is the newest state the
+   * server has, and after a server restart revs start again at 0. Needs a current
+   * subscription (`NOT_SUBSCRIBED` otherwise). Rejects with the topic's error on
+   * `NOT_FOUND` and when the connection closes (`CLOSED`), with `UNSUBSCRIBED` when
+   * its last listener leaves, and with `TIMEOUT` after `timeoutMs`. Transient
+   * subscribe failures keep it waiting.
+   */
+  whenRev<T extends Topic>(topic: T, rev: number, options: WhenRevOptions = {}): Promise<TopicState<TopicSnapshot<T>>> {
+    const entry = this.topics.get(topic)
+    if (!entry) return Promise.reject(new ClientError('NOT_SUBSCRIBED', `${topic} is not subscribed`))
+    if (entry.state && entry.state.rev >= rev) return Promise.resolve(entry.state as TopicState<TopicSnapshot<T>>)
+    if (entry.error?.code === 'NOT_FOUND') return Promise.reject(entry.error)
+    return new Promise((resolve, reject) => {
+      const waiter: Waiter = {
+        rev,
+        attempt: entry.attempt,
+        resolve: (state) => resolve(state as TopicState<TopicSnapshot<T>>),
+        reject,
+        timer: null
+      }
+      if (options.timeoutMs !== undefined) {
+        waiter.timer = this.conn.timers.setTimeout(() => {
+          waiter.timer = null
+          if (!entry.waiters.delete(waiter)) return
+          reject(new ClientError('TIMEOUT', `${topic} did not reach rev ${rev}`))
+        }, options.timeoutMs)
+      }
+      entry.waiters.add(waiter)
+    })
+  }
+
   /** The current state, if a snapshot has arrived. Shared and read-only, as for listeners. */
   get<T extends Topic>(topic: T): TopicState<TopicSnapshot<T>> | undefined {
     return this.topics.get(topic)?.state as TopicState<TopicSnapshot<T>> | undefined
@@ -107,6 +159,7 @@ export class TopicMirror {
         entry.error = undefined
         entry.retryDelay = RETRY_MIN_MS
         this.notify(entry, entry.state)
+        this.settle(entry, attempt)
       },
       (err: ClientError) => {
         if (this.topics.get(topic) !== entry || entry.attempt !== attempt) return
@@ -116,6 +169,7 @@ export class TopicMirror {
         if (err.code === 'NOT_FOUND') entry.state = undefined
         entry.error = err
         this.notify(entry, { error: err })
+        if (err.code === 'NOT_FOUND') this.failWaiters(entry, err)
         // Anything else (TIMEOUT, INTERNAL, ...) may pass: try again with back-off.
         if (err.code !== 'NOT_FOUND' && this.topics.get(topic) === entry) this.scheduleRetry(topic, entry)
       }
@@ -133,9 +187,34 @@ export class TopicMirror {
       this.cancelRetry(entry)
       entry.attempt++
       this.notify(entry, { error: closedError() })
+      this.failWaiters(entry, closedError())
+    }
+  }
+
+  /** Resolves the waiters the current state satisfies; `attempt` names the subscribe that just brought it. */
+  private settle(entry: Entry, attempt?: number): void {
+    const state = entry.state
+    if (!state) return
+    for (const waiter of [...entry.waiters]) {
+      if (state.rev < waiter.rev && (attempt === undefined || attempt <= waiter.attempt)) continue
+      this.dropWaiter(entry, waiter)
+      waiter.resolve(state)
     }
   }
 
+  private failWaiters(entry: Entry, err: ClientError): void {
+    for (const waiter of [...entry.waiters]) {
+      this.dropWaiter(entry, waiter)
+      waiter.reject(err)
+    }
+  }
+
+  private dropWaiter(entry: Entry, waiter: Waiter): void {
+    entry.waiters.delete(waiter)
+    if (waiter.timer !== null) this.conn.timers.clearTimeout(waiter.timer)
+    waiter.timer = null
+  }
+
   private scheduleRetry(topic: Topic, entry: Entry): void {
     this.cancelRetry(entry)
     const delay = entry.retryDelay
@@ -159,6 +238,7 @@ export class TopicMirror {
     if (outcome.kind === 'applied') {
       entry.state = outcome.state
       this.notify(entry, entry.state)
+      this.settle(entry)
     } else if (outcome.kind === 'resync') {
       this.resubscribe(patch.topic)
     }
````

````diff
--- a/src/shared/client/mirror.typecheck.ts
+++ b/src/shared/client/mirror.typecheck.ts
@@ -21,4 +21,5 @@ export function checks(mirror: TopicMirror): void {
   assertType<Equal<ReturnType<typeof mirror.get<'server'>>, TopicState<ServerTopic> | undefined>>()
   const s = mirror.get('server')
   if (s) assertType<Equal<typeof s.snapshot.repos, ServerTopic['repos']>>()
+  assertType<Equal<ReturnType<typeof mirror.whenRev<'project:p1'>>, Promise<TopicState<ProjectTopic>>>>()
 }
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -829,7 +829,9 @@ then stale, so no ping starts and no welcome listener runs for it.
 when the socket closes. The default timeout is 60 s (`requestTimeoutMs`, or
 `timeoutMs` per call); a timeout fails with `TIMEOUT`. Error replies reject with a
 `ClientError` carrying the server's `code`, and its `details` when the reply has
-an object there (anything else is dropped).
+an object there (anything else is dropped). `requestWithRev(method, params)`
+resolves with `{result, rev?}`: the response's `rev` (see "Revs in responses"),
+left out when the server sent none or a malformed one.
 
 **Mirror.** `TopicMirror.subscribe(topic, listener)` reference-counts per topic:
 the first listener sends `sub.subscribe`, later ones get the current state at
@@ -854,6 +856,20 @@ connection is closed, every listener gets `{error}` with code `CLOSED` ("the
 connection was closed") and the topics are dropped; a `subscribe` after that
 gets the same error at once.
 
+**Waiting for a rev.** `TopicMirror.whenRev(topic, rev, {timeoutMs?})` resolves
+with the topic's state once the mirror holds `rev` or later, at once if it
+already does. A snapshot from a subscribe sent after the call also resolves it,
+whatever its rev: that is the newest state the server has (after a server
+restart revs start again at 0, so "at least `rev`" might never come). It needs
+a current subscription and rejects with `NOT_SUBSCRIBED` without one. It
+rejects with the topic's `NOT_FOUND`, with `CLOSED` when the connection closes,
+with `UNSUBSCRIBED` when the topic's last listener leaves, and with `TIMEOUT`
+after `timeoutMs` (on the connection's timers; without it there is no limit).
+A transient subscribe failure keeps it waiting for the retry. The usual use:
+`const {result, rev} = await conn.requestWithRev(...)`, then
+`if (rev) await mirror.whenRev(rev.topic, rev.rev)` before reading what the
+command made.
+
 **PtyStream.** `attach(ptyId, handlers)` registers the handlers before the request
 (the replay arrives first, as `onData(data, true)`) and resolves with the
 `PtyInfo`. It rejects with `ALREADY_ATTACHED` if the stream has that pty (also
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/clientMirror.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 21`, `# fail 0`.

Run: `npm run typecheck`

Expected: clean (it also checks `mirror.typecheck.ts`). `npm test` is at 1168.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): TopicMirror.whenRev waits until the mirror holds a rev" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md src/shared/client/mirror.ts src/shared/client/mirror.typecheck.ts scripts/clientMirror.test.mjs
```

---

### Task 4: `topic.ended`, `TOPIC_ENDED`, and the capability list

A deleted project's subscribers hear that its topic ended instead of the topic going quiet (Note 4). The welcome's capabilities become a list built in one place, starting with `topicEnd` (Decisions 11–13, 21).

**Files:**
- Create: `server/src/capabilities.ts`
- Modify: `src/shared/protocolV2.ts`, `src/shared/protocol.ts`, `server/src/topicHub.ts`, `server/src/server.ts`, `src/shared/client/mirror.ts`, `PROTOCOL.md`
- Test: `scripts/serverTopicHub.test.mjs`, `scripts/serverV2.test.mjs`, `scripts/clientMirror.test.mjs`

- [ ] **Step 1: Write the failing tests**

The hub. `recorder()` also records ends (in `ends`, since `ended` is the method):

````diff
--- a/scripts/serverTopicHub.test.mjs
+++ b/scripts/serverTopicHub.test.mjs
@@ -6,7 +6,8 @@ import { applyStatePatch } from '../src/shared/sync/topicState.ts'
 
 function recorder() {
   const sent = []
-  return { sent, send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
+  const ends = []
+  return { sent, ends, send: (topic, rev, ops) => sent.push({ topic, rev, ops }), ended: (topic, reason) => ends.push({ topic, reason }) }
 }
 
 test('an unpublished topic cannot be subscribed to', () => {
@@ -122,6 +123,33 @@ test('rev reads the current rev; undefined for a topic never published or droppe
   assert.equal(hub.rev('project:p'), undefined)
 })
 
+test('drop tells each subscriber the topic ended, after forgetting it; others and later topics are untouched', (t) => {
+  const warn = t.mock.method(console, 'warn', () => {})
+  const hub = new TopicHub()
+  hub.publish('project:p', { n: 0 })
+  hub.publish('project:q', { n: 0 })
+  const a = recorder()
+  const b = recorder()
+  const other = recorder()
+  const plain = { send() {} }
+  const throwing = { send() {}, ended() { throw new Error('boom') } }
+  hub.subscribe('project:p', a)
+  hub.subscribe('project:p', throwing)
+  hub.subscribe('project:p', plain)
+  hub.subscribe('project:p', b)
+  hub.subscribe('project:q', other)
+  let revInside
+  a.ended = (topic, reason) => { a.ends.push({ topic, reason }); revInside = hub.rev(topic) }
+  hub.drop('project:p')
+  assert.deepEqual(a.ends, [{ topic: 'project:p', reason: 'deleted' }])
+  assert.deepEqual(b.ends, [{ topic: 'project:p', reason: 'deleted' }], 'a throwing subscriber does not stop the others')
+  assert.equal(revInside, undefined, 'the topic is already gone when subscribers hear it')
+  assert.deepEqual(other.ends, [])
+  assert.equal(warn.mock.callCount(), 1)
+  hub.drop('project:p')
+  assert.equal(a.ends.length, 1, 'dropping an unknown topic tells nobody')
+})
+
 test('subscriberCount follows subscribe, unsubscribe and unsubscribeAll', () => {
   const hub = new TopicHub()
   hub.publish('project:p', { a: 1 })
````

`project.delete` through dispatch, and the welcome list. The test subscriber records ends:

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -5,6 +5,7 @@ import { execFileSync } from 'node:child_process'
 import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
+import { welcomeCapabilities } from '../server/src/capabilities.ts'
 import { saveConfig } from '../server/src/config.ts'
 import { ConfigStore } from '../server/src/configStore.ts'
 import { ProjectState } from '../server/src/projects/state.ts'
@@ -38,7 +39,10 @@ function setup(t) {
     store.close()
   })
   const sent = []
-  const subscriber = { send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
+  const subscriber = {
+    send: (topic, rev, ops) => sent.push({ topic, rev, ops }),
+    ended: (topic, reason) => sent.push({ topic, ended: reason })
+  }
   /** Records what the handlers ask of the session manager */
   const forgotten = []
   const sessions = {
@@ -251,6 +255,21 @@ test('responseRev: a project command reports its project topic, a registry or pr
   assert.equal(responseRev('project.rename', undefined, hub), undefined)
 })
 
+test('project.delete ends the project topic for its subscribers, before the server topic drops it', async (t) => {
+  const { a, call, sent } = setup(t)
+  await call('sub.subscribe', { topic: 'server' })
+  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
+  await call('sub.subscribe', { topic: `project:${projectId}` })
+  sent.length = 0
+  await call('project.delete', { projectId })
+  assert.deepEqual(sent.map((m) => m.ended ? [m.topic, m.ended] : [m.topic, 'patch']), [[`project:${projectId}`, 'deleted'], ['server', 'patch']])
+})
+
+test('welcome capabilities: mcp while the listener is up, then what the server always has', () => {
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd'])
+  assert.deepEqual(welcomeCapabilities(false), ['topicEnd'])
+})
+
 test('project.import accepts a project from importProjectFile', async (t) => {
   const { a, call } = setup(t)
   const { importProjectFile } = await import('../src/shared/model/importProject.ts')
````

The mirror (appended; `track` is Task 3's helper):

````diff
--- a/scripts/clientMirror.test.mjs
+++ b/scripts/clientMirror.test.mjs
@@ -421,3 +421,55 @@ test('a transient subscribe failure keeps whenRev waiting; the retry settles it'
   await tick()
   assert.deepEqual(wait.state, { snapshot: { n: 1 }, rev: 0 }, 'the retry was sent after the call')
 })
+
+// ---- topic.ended ----
+
+test('topic.ended reports TOPIC_ENDED with its reason, to current and later listeners, and rejects whenRev', async () => {
+  const { mirror, sock } = setup()
+  const seen = []
+  mirror.subscribe('project:p', (s) => seen.push(s))
+  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 3 })
+  await tick()
+  const wait = track(mirror.whenRev('project:p', 9))
+  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
+  await tick()
+  const err = seen.at(-1).error
+  assert.equal(err.code, 'TOPIC_ENDED')
+  assert.equal(err.message, 'project:p ended: deleted')
+  assert.deepEqual(err.details, { reason: 'deleted' })
+  assert.equal(wait.error, err)
+  assert.equal(mirror.get('project:p'), undefined, 'its state is dropped')
+  await assert.rejects(mirror.whenRev('project:p', 1), (e) => e.code === 'TOPIC_ENDED')
+  const late = []
+  mirror.subscribe('project:p', (s) => late.push(s))
+  assert.equal(late.at(-1).error.code, 'TOPIC_ENDED')
+  // Patches and a second end for it change nothing.
+  sock.event('state.patch', { topic: 'project:p', rev: 4, ops: [] })
+  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
+  assert.equal(seen.length, 2)
+})
+
+test('an ended topic is not subscribed again after a reconnect; an in-flight reply is ignored; others are', async () => {
+  const { server, clock, mirror, sock } = setup()
+  const seen = []
+  mirror.subscribe('project:p', (s) => seen.push(s))
+  mirror.subscribe('server', () => {})
+  sock.event('topic.ended', { topic: 'project:p', reason: 'deleted' })
+  // The first subscribe's reply arrives after the end: it is older, so it is ignored.
+  sock.reply(subReqs(sock)[0], { snapshot: { n: 1 }, rev: 0 })
+  await tick()
+  assert.equal(seen.at(-1).error.code, 'TOPIC_ENDED')
+  sock.serverClose(1006, '')
+  clock.advance(1000)
+  const next = server.last()
+  next.open()
+  next.welcome()
+  assert.deepEqual(subReqs(next).map((f) => f.params.topic), ['server'])
+  // An end for a topic the mirror does not hold is ignored, and an unknown reason still reads as an end.
+  next.event('topic.ended', { topic: 'project:other', reason: 'deleted' })
+  const stop = mirror.subscribe('project:q', (s) => seen.push(s))
+  next.event('topic.ended', { topic: 'project:q' })
+  assert.equal(seen.at(-1).error.message, 'project:q ended: ended')
+  stop()
+  assert.deepEqual(next.lastReq('sub.unsubscribe').params, { topic: 'project:q' })
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/clientMirror.test.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 32`, `# fail 4`:

```
not ok - topic.ended reports TOPIC_ENDED with its reason, to current and later listeners, and rejects whenRev
not ok - an ended topic is not subscribed again after a reconnect; an in-flight reply is ignored; others are
not ok - drop tells each subscriber the topic ended, after forgetting it; others and later topics are untouched
not ok - scripts/serverV2.test.mjs
```

`serverV2.test.mjs` fails as a whole: `../server/src/capabilities.ts` does not exist yet (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement**

The protocol: the capability strings, the event and its payload:

````diff
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -28,6 +28,25 @@ export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1, 2]
 /** Close reason sent with code 4002 when the client is older than the server allows. */
 export const CLOSE_REASON_UPGRADE_CLIENT = 'UPGRADE_CLIENT'
 
+/**
+ * `welcome.capabilities` values: the features a client cannot otherwise tell a
+ * server has (a method or an event). Clients hide or work around what is missing.
+ */
+export const CAPABILITY = {
+  /** The server's MCP listener is up, so sessions get the trek-dev tools (the Global panel needs them) */
+  mcp: 'mcp',
+  /** The server sends `topic.ended` before a topic stops (a deleted project) */
+  topicEnd: 'topicEnd'
+} as const
+
+/** Why a topic ended (`topic.ended`). */
+export type TopicEndReason = 'deleted'
+
+export interface TopicEndedPayload {
+  topic: Topic
+  reason: TopicEndReason
+}
+
 export interface WelcomeFrameV2 {
   type: 'welcome'
   protocolVersion: 2
@@ -246,4 +265,6 @@ export interface EventPayloadsV2 {
   'pty.exit': EventPayloadsV1['pty.exit']
   'daemon.shutdown': EventPayloadsV1['daemon.shutdown']
   'state.patch': StatePatchPayload
+  /** Sent to a topic's subscribers just before it stops; nothing more comes for it */
+  'topic.ended': TopicEndedPayload
 }
````

````diff
--- a/src/shared/protocol.ts
+++ b/src/shared/protocol.ts
@@ -45,7 +45,10 @@ export interface WireError {
 
 /** v2: what `WireError.details` may say. */
 export interface WireErrorDetails {
-  /** `dirty`: `worktree.remove` refused a worktree with modified or untracked files */
+  /**
+   * `dirty`: `worktree.remove` refused a worktree with modified or untracked files.
+   * The client SDK's own `TOPIC_ENDED` errors carry the `topic.ended` reason here.
+   */
   reason?: string
 }
 
````

The hub forgets the topic, then tells each subscriber:

````diff
--- a/server/src/topicHub.ts
+++ b/server/src/topicHub.ts
@@ -3,11 +3,14 @@
 // subscriber the diff as a single patch. Snapshots are treated as immutable:
 // callers build a fresh object for each publish.
 import type { Topic } from '../../src/shared/model/topics'
+import type { TopicEndReason } from '../../src/shared/protocolV2'
 import { diffJson } from '../../src/shared/sync/jsonDiff.ts'
 import type { PatchOp } from '../../src/shared/sync/jsonPatch'
 
 export interface Subscriber {
   send(topic: Topic, rev: number, ops: PatchOp[]): void
+  /** The topic stopped for good (see `drop`); without it the subscriber is just forgotten */
+  ended?(topic: Topic, reason: TopicEndReason): void
 }
 
 interface TopicEntry {
@@ -83,9 +86,21 @@ export class TopicHub {
     return { snapshot: entry.snapshot, rev: entry.rev }
   }
 
-  /** Forgets the topic (a deleted project). Subscribers learn about it from the `server` topic. */
-  drop(topic: Topic): void {
+  /**
+   * Forgets the topic (a deleted project) and tells each of its subscribers it
+   * ended. A subscriber whose `ended` throws is logged; the others still hear it.
+   */
+  drop(topic: Topic, reason: TopicEndReason = 'deleted'): void {
+    const entry = this.topics.get(topic)
+    if (!entry) return
     this.topics.delete(topic)
+    for (const subscriber of [...entry.subscribers]) {
+      try {
+        subscriber.ended?.(topic, reason)
+      } catch (err) {
+        console.warn(`topic ${topic}: telling a subscriber it ended failed`, err)
+      }
+    }
   }
 
   unsubscribe(topic: Topic, subscriber: Subscriber): void {
````

Create `server/src/capabilities.ts`:

````ts
// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/** What this server always has. */
export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd]

/** `mcp` while the MCP listener is up, then the features this server always has. */
export function welcomeCapabilities(mcp: boolean): string[] {
  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES]
}
````

`server.ts` sends the event and builds the welcome's list (`trek.mcp` is set once the listener is up, as before):

````diff
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -13,6 +13,7 @@ import {
   type ServerFrameV2,
   type TopicRev
 } from '../../src/shared/protocolV2'
+import { welcomeCapabilities } from './capabilities'
 import type { Outcome } from './errors'
 import { isRecord } from './validate'
 import type { ConfigStore } from './configStore'
@@ -150,6 +151,9 @@ export function startServer(
     const subscriber: Subscriber = {
       send(topic, rev, ops) {
         sendFrame(ws, { type: 'event', event: 'state.patch', payload: { topic, rev, ops } })
+      },
+      ended(topic, reason) {
+        sendFrame(ws, { type: 'event', event: 'topic.ended', payload: { topic, reason } })
       }
     }
 
@@ -240,7 +244,7 @@ export function startServer(
             daemonVersion,
             serverId: store.config.serverId ?? '',
             serverName: store.config.name ?? '',
-            capabilities: trek.mcp ? ['mcp'] : []
+            capabilities: welcomeCapabilities(trek.mcp !== undefined)
           })
         } else {
           sendFrame(ws, {
````

The mirror. `ProjectState.delete` needs no change: it already calls `hub.drop(projectTopic(id))` before `onSummariesChange()`, and `drop`'s reason defaults to `'deleted'`:

````diff
--- a/src/shared/client/mirror.ts
+++ b/src/shared/client/mirror.ts
@@ -5,6 +5,7 @@
 // object, and a patch builds the next one from it. Treat them as read-only.
 import type { Topic, TopicSnapshot } from '../model/topics.ts'
 import { applyStatePatch, type TopicState } from '../sync/topicState.ts'
+import type { TopicEndedPayload } from '../protocolV2.ts'
 import { ClientError, type ServerConnection } from './connection.ts'
 
 /** What a listener of `topic` gets: the state, or an error. */
@@ -42,6 +43,8 @@ interface Entry {
   retryDelay: number
   /** `whenRev` calls waiting on this topic */
   waiters: Set<Waiter>
+  /** The server said the topic ended (`topic.ended`): it is never subscribed again */
+  ended: boolean
 }
 
 /** A subscribe that fails transiently (not NOT_FOUND or NOT_CONNECTED) is retried after 1 s, doubling to 30 s. */
@@ -56,6 +59,7 @@ export class TopicMirror {
     this.conn = conn
     conn.on('welcome', () => {
       for (const [topic, entry] of this.topics) {
+        if (entry.ended) continue
         this.cancelRetry(entry)
         entry.retryDelay = RETRY_MIN_MS
         this.resubscribe(topic)
@@ -63,6 +67,7 @@ export class TopicMirror {
     })
     conn.on('event', ({ event, payload }) => {
       if (event === 'state.patch') this.onPatch(payload as { topic: Topic; rev: number; ops: [] })
+      else if (event === 'topic.ended') this.onEnded(payload as Partial<TopicEndedPayload>)
     })
     conn.on('status', ({ status }) => {
       if (status === 'closed') this.onClosed()
@@ -82,7 +87,7 @@ export class TopicMirror {
     }
     let entry = this.topics.get(topic)
     if (!entry) {
-      entry = { listeners: new Set(), attempt: 0, loading: false, retryTimer: null, retryDelay: RETRY_MIN_MS, waiters: new Set() }
+      entry = { listeners: new Set(), attempt: 0, loading: false, retryTimer: null, retryDelay: RETRY_MIN_MS, waiters: new Set(), ended: false }
       this.topics.set(topic, entry)
       entry.listeners.add(listener)
       if (this.conn.status === 'connected') this.resubscribe(topic)
@@ -112,7 +117,7 @@ export class TopicMirror {
    * subscribe sent after this call, whatever its rev: that is the newest state the
    * server has, and after a server restart revs start again at 0. Needs a current
    * subscription (`NOT_SUBSCRIBED` otherwise). Rejects with the topic's error on
-   * `NOT_FOUND` and when the connection closes (`CLOSED`), with `UNSUBSCRIBED` when
+   * `NOT_FOUND`, `TOPIC_ENDED` and when the connection closes (`CLOSED`), with `UNSUBSCRIBED` when
    * its last listener leaves, and with `TIMEOUT` after `timeoutMs`. Transient
    * subscribe failures keep it waiting.
    */
@@ -120,7 +125,7 @@ export class TopicMirror {
     const entry = this.topics.get(topic)
     if (!entry) return Promise.reject(new ClientError('NOT_SUBSCRIBED', `${topic} is not subscribed`))
     if (entry.state && entry.state.rev >= rev) return Promise.resolve(entry.state as TopicState<TopicSnapshot<T>>)
-    if (entry.error?.code === 'NOT_FOUND') return Promise.reject(entry.error)
+    if (entry.error?.code === 'NOT_FOUND' || entry.ended) return Promise.reject(entry.error)
     return new Promise((resolve, reject) => {
       const waiter: Waiter = {
         rev,
@@ -191,6 +196,27 @@ export class TopicMirror {
     }
   }
 
+  /**
+   * The server ended the topic (a deleted project): drop its state, tell every
+   * listener with a `TOPIC_ENDED` error carrying the reason, and never subscribe
+   * to it again, not even after a reconnect. A listener added later hears the same error.
+   */
+  private onEnded(payload: Partial<TopicEndedPayload>): void {
+    const topic = payload.topic
+    const entry = topic === undefined ? undefined : this.topics.get(topic)
+    if (!entry || entry.ended) return
+    this.cancelRetry(entry)
+    // A subscribe reply still on its way is older than the end.
+    entry.attempt++
+    entry.loading = false
+    entry.ended = true
+    entry.state = undefined
+    const reason = typeof payload.reason === 'string' ? payload.reason : 'ended'
+    entry.error = new ClientError('TOPIC_ENDED', `${topic} ended: ${reason}`, { reason })
+    this.notify(entry, { error: entry.error })
+    this.failWaiters(entry, entry.error)
+  }
+
   /** Resolves the waiters the current state satisfies; `attempt` names the subscribe that just brought it. */
   private settle(entry: Entry, attempt?: number): void {
     const state = entry.state
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -188,6 +188,17 @@ version closes with `4002` and the reason `unsupported protocol version`;
 Clients key everything they cache by it. `repos` is gone; the project list
 comes from the `server` topic.
 
+`capabilities` names the features a client could not otherwise tell the server
+has (a method or an event); a client hides or works around what is missing. A
+new optional field needs no capability: its absence says enough.
+
+| Capability | Meaning |
+|---|---|
+| `mcp` | The server's MCP listener is up, so its sessions get the trek-dev tools (see [MCP](#mcp-trek-dev-on-the-server)). Listed per connection, only while the listener is up |
+| `topicEnd` | The server sends `topic.ended` before a topic stops (see Subscriptions) |
+
+The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
+
 ## Subscriptions
 
 ```json
@@ -212,6 +223,12 @@ comes from the `server` topic.
   replaces its mirror with the new snapshot. There is no replay log.
 - Subscriptions end with `sub.unsubscribe` or when the socket closes.
 - Unknown topics fail with `BAD_REQUEST`; unknown project ids with `NOT_FOUND`.
+- When a topic stops for good (today only a deleted project's), every subscriber
+  first gets `{"type": "event", "event": "topic.ended", "payload": {"topic":
+  "project:p1", "reason": "deleted"}}`, and nothing more for that topic. A
+  subscribe to it afterwards fails with `NOT_FOUND`. A server without the
+  `topicEnd` capability stops the topic silently; its clients learn about the
+  deletion from the `server` topic dropping the project.
 
 **Revs in responses.** A successful response to a method whose params name a
 `projectId` carries `rev: {topic: "project:<id>", rev}`: the project topic's rev
@@ -373,8 +390,9 @@ clears `tag`, `note`, `ticket`, `pr` or `env`. `branch.setCustomTags` with
 `customTags: null` or `[]` clears the custom tags; omitting `customTags` is
 `BAD_REQUEST`. A branch whose data becomes empty is removed from `branchData`.
 
-Deleting a project removes it from the `server` topic's `projects`; its
-`project:<id>` topic stops, and subscribing to it fails with `NOT_FOUND`. Once
+Deleting a project sends `topic.ended` (reason `deleted`) to the subscribers of
+its `project:<id>` topic, then removes it from the `server` topic's `projects`;
+the topic stops, and subscribing to it fails with `NOT_FOUND`. Once
 `project.delete` succeeds, the server kills the ptys of the project's sessions
 (Global ones included) and stops their Codex id discovery. Once `repo.remove`
 succeeds, it does the same for that repository's sessions and for the project's
@@ -617,7 +635,7 @@ scope keeps agents from acting on other projects by mistake. Other local users a
 kept out by the 0700 directory, the 0600 files and the bearer token.
 
 **Capabilities.** The v2 `welcome` frame's `capabilities` contains `"mcp"` when the
-server has MCP for its sessions (the listener is up), and is `[]` otherwise.
+server has MCP for its sessions (the listener is up), and lacks it otherwise.
 
 **Endpoint.** A second HTTP server inside `trek-server`, bound to `127.0.0.1` on
 an OS-chosen port, so it is never exposed (agents run on the server's machine). It
@@ -775,6 +793,7 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 | Event | Payload |
 |---|---|
 | `state.patch` | `{topic, rev, ops}` |
+| `topic.ended` | `{topic, reason}`; `reason` is `deleted` (see Subscriptions) |
 | `pty.data` | as v1. Session status is computed on the server from live bytes, never from replay |
 | `pty.exit` | as v1 |
 | `daemon.shutdown` | as v1 |
@@ -856,13 +875,20 @@ connection is closed, every listener gets `{error}` with code `CLOSED` ("the
 connection was closed") and the topics are dropped; a `subscribe` after that
 gets the same error at once.
 
+**Ended topics.** On `topic.ended` the mirror drops the topic's state and gives
+every listener `{error}` with code `TOPIC_ENDED`, the message `<topic> ended:
+<reason>` and `details: {reason}`. It never subscribes to that topic again, not
+after a reconnect either; a listener added later gets the same error at once.
+`TOPIC_ENDED` is final, unlike `NOT_FOUND` (retried after a reconnect) and
+`CLOSED` (the connection, not the topic).
+
 **Waiting for a rev.** `TopicMirror.whenRev(topic, rev, {timeoutMs?})` resolves
 with the topic's state once the mirror holds `rev` or later, at once if it
 already does. A snapshot from a subscribe sent after the call also resolves it,
 whatever its rev: that is the newest state the server has (after a server
 restart revs start again at 0, so "at least `rev`" might never come). It needs
 a current subscription and rejects with `NOT_SUBSCRIBED` without one. It
-rejects with the topic's `NOT_FOUND`, with `CLOSED` when the connection closes,
+rejects with the topic's `NOT_FOUND` or `TOPIC_ENDED`, with `CLOSED` when the connection closes,
 with `UNSUBSCRIBED` when the topic's last listener leaves, and with `TIMEOUT`
 after `timeoutMs` (on the connection's timers; without it there is no limit).
 A transient subscribe failure keeps it waiting for the retry. The usual use:
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/clientMirror.test.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 67`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean. `npm test` is at 1173.

- [ ] **Step 6: Commit**

```bash
git add server/src/capabilities.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): topic.ended for deleted projects, a welcome capability list; the mirror reports TOPIC_ENDED" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/capabilities.ts server/src/server.ts server/src/topicHub.ts src/shared/client/mirror.ts src/shared/protocol.ts src/shared/protocolV2.ts scripts/clientMirror.test.mjs scripts/serverTopicHub.test.mjs scripts/serverV2.test.mjs
```

---
### Task 5: Decisions on sessions

`Session.decision`, set by `requestDecision`, cleared by input (through the existing reply filter), by `session.dismissDecision` and by the agent going away, and listed in the `attention` topic (Decisions 1–4, 6; user decision 1). Task 6 adds the MCP tool that calls `requestDecision`.

**Files:**
- Modify: `src/shared/model/types.ts`, `src/shared/protocolV2.ts`, `server/src/sessions/status.ts`, `server/src/sessions/limits.ts`, `server/src/sessions/manager.ts`, `server/src/projects/model.ts`, `server/src/sessionHandlers.ts`, `server/src/capabilities.ts`, `PROTOCOL.md`
- Test: `scripts/serverStatus.test.mjs`, `scripts/serverSessions.test.mjs`, `scripts/serverProjectModel.test.mjs`, `scripts/serverV2.test.mjs`

- [ ] **Step 1: Write the failing tests**

`attentionEntries` lists a session with a decision in any status:

````diff
--- a/scripts/serverStatus.test.mjs
+++ b/scripts/serverStatus.test.mjs
@@ -73,3 +73,21 @@ test('attentionEntries lists attention and done sessions, oldest first, with Glo
   ])
   assert.equal(attentionEntries(projects, new Map(), () => 999)[0].since, 999)
 })
+
+test('attentionEntries also lists a session with an open decision, in any status, since it was asked', () => {
+  const s = (id, status, decision) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status, ...(decision ? { decision } : {}) })
+  const projects = [{
+    id: 'p', name: 'P', settings: {}, globalSessions: [],
+    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
+      { id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [
+        s('a', 'working', { question: 'Which DB?', at: 300 }),
+        s('b', 'attention', { question: 'Merge?', at: 500 }),
+        s('c', 'idle')
+      ] }
+    ] }]
+  }]
+  assert.deepEqual(attentionEntries(projects, new Map([['b', 100]]), () => 999), [
+    { projectId: 'p', worktreeId: 'w', sessionId: 'b', title: 'b', status: 'attention', since: 100, decision: { question: 'Merge?', at: 500 } },
+    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'a', status: 'working', since: 300, decision: { question: 'Which DB?', at: 300 } }
+  ])
+})
````

`resetRuntime` drops it:

````diff
--- a/scripts/serverProjectModel.test.mjs
+++ b/scripts/serverProjectModel.test.mjs
@@ -56,7 +56,7 @@ test('newProject assembles repositories, empty settings and no global sessions',
 })
 
 test('resetRuntime clears running state everywhere', () => {
-  const session = { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'p', exitCode: 1 }
+  const session = { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'p', exitCode: 1, decision: { question: 'q', at: 1 } }
   const p = {
     id: 'p', name: 'P', settings: {}, globalSessions: [{ ...session }],
     repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
````

The SessionManager, against the file's fake pty (`statusOf`, `attention`, `fireQuiet` and `v2` are the file's helpers; the new block goes before "maxSessions refusals use CAPACITY"):

````diff
--- a/scripts/serverSessions.test.mjs
+++ b/scripts/serverSessions.test.mjs
@@ -962,6 +962,104 @@ test('attention entries are oldest first with their since; markComplete drops on
   assert.deepEqual(attention(s).map((e) => e.sessionId), [second.sessionId])
 })
 
+// ---- decisions ----
+
+const decisionOf = (s) => s.wx().sessions[0].decision
+
+test('requestDecision flags the session and lists it, unsaved; real input clears it, a terminal reply does not', async (t) => {
+  const s = setup(t)
+  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  const saves = s.saves.length
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: '  Ship it?  ' })
+  assert.deepEqual(decisionOf(s), { question: 'Ship it?', at: s.clock.t })
+  assert.equal(s.saves.length, saves, 'decisions are runtime-only')
+  assert.deepEqual(attention(s).map((e) => [e.sessionId, e.status, e.since, e.decision]), [[sessionId, 'idle', s.clock.t, { question: 'Ship it?', at: s.clock.t }]])
+  s.sessions.noteInput(ptyId, '\x1b[12;1R')
+  s.sessions.noteInput(ptyId, '\x1b[I')
+  assert.equal(decisionOf(s)?.question, 'Ship it?', 'terminal replies and focus reports do not answer it')
+  s.sessions.noteInput(ptyId, 'y')
+  assert.equal(decisionOf(s), undefined)
+  assert.equal(statusOf(s), 'idle', 'input to an idle session leaves its status alone')
+  assert.deepEqual(attention(s), [])
+})
+
+test('a decision on a done session: input clears it in one patch and keeps done and its since', async (t) => {
+  const s = setup(t)
+  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  s.spawned[0].emit('esc to interrupt')
+  fireQuiet(s)
+  const doneSince = attention(s)[0].since
+  s.clock.t += 7000
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'Which one?' })
+  assert.deepEqual(attention(s).map((e) => [e.status, e.since, e.decision.question]), [['done', doneSince, 'Which one?']])
+  const publish = t.mock.method(s.projects, 'apply')
+  s.sessions.noteInput(ptyId, '1')
+  assert.equal(publish.mock.callCount(), 1, 'one change for the decision and the status')
+  assert.equal(decisionOf(s), undefined)
+  assert.equal(statusOf(s), 'done')
+  assert.deepEqual(attention(s).map((e) => [e.status, e.since, e.decision]), [['done', doneSince, undefined]])
+})
+
+test('sendPrompt and tool keys answer a decision; seen does not; dismissDecision does; a new request replaces it', async (t) => {
+  const s = setup(t)
+  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  const ask = (question) => s.sessions.requestDecision({ projectId: s.projectId, sessionId, question })
+  ask('one')
+  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'go' })
+  assert.equal(decisionOf(s), undefined, 'a prompt is the user acting')
+  ask('two')
+  s.sessions.noteUserInput(sessionId)
+  assert.equal(decisionOf(s), undefined, 'so are send_keys')
+  ask('three')
+  s.sessions.seen({ projectId: s.projectId, sessionId })
+  assert.equal(decisionOf(s)?.question, 'three', 'showing the session does not answer it')
+  s.clock.t += 10
+  ask('four')
+  assert.deepEqual(decisionOf(s), { question: 'four', at: s.clock.t })
+  s.sessions.dismissDecision({ projectId: s.projectId, sessionId })
+  assert.equal(decisionOf(s), undefined)
+  assert.deepEqual(attention(s), [])
+  assert.doesNotThrow(() => s.sessions.dismissDecision({ projectId: s.projectId, sessionId }), 'dismissing nothing is fine')
+})
+
+test('decisions: exit keeps one, unload and a Global restart clear them; bad questions and ids are refused', async (t) => {
+  const s = setup(t)
+  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  const global = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId: one.sessionId, question: 'q1' })
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, question: 'q2' })
+  s.spawned[0].exit(0)
+  assert.equal(decisionOf(s)?.question, 'q1', 'the question is still open after the agent exits')
+  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
+  assert.equal(decisionOf(s), undefined)
+  s.sessions.forgetGlobal(s.projectId)
+  assert.equal(s.project().globalSessions[0].decision, undefined)
+  assert.deepEqual(attention(s), [])
+  const bad = (p) => assert.throws(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, ...p }), (e) => e.code === 'BAD_REQUEST')
+  bad({ question: '   ' })
+  bad({ question: 5 })
+  bad({})
+  bad({ question: 'x'.repeat(1001) })
+  assert.doesNotThrow(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, question: 'x'.repeat(1000) }))
+  assert.throws(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: 'nope', question: 'q' }), (e) => e.code === 'NOT_FOUND')
+  assert.throws(() => s.sessions.dismissDecision({ projectId: s.projectId, sessionId: 'nope' }), (e) => e.code === 'NOT_FOUND')
+})
+
+test('v2: session.dismissDecision is wired; pty.write answers a decision', async (t) => {
+  const s = setup(t)
+  const { call } = v2(s)
+  const { ptyId, sessionId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'q' })
+  assert.deepEqual(await call('session.dismissDecision', { projectId: s.projectId, sessionId }), { ok: true, result: null })
+  assert.equal(decisionOf(s), undefined)
+  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'q' })
+  await call('pty.attach', { ptyId })
+  await call('pty.write', { ptyId, data: '\x1b[1;1R' })
+  assert.equal(decisionOf(s)?.question, 'q')
+  await call('pty.write', { ptyId, data: 'n' })
+  assert.equal(decisionOf(s), undefined)
+})
+
 test('maxSessions refusals use CAPACITY', (t) => {
   const s = setup(t, { maxSessions: 1 })
   s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
````

The welcome list gains `decisions`:

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -266,8 +266,8 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has', () => {
-  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd'])
-  assert.deepEqual(welcomeCapabilities(false), ['topicEnd'])
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions'])
+  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions'])
 })
 
 test('project.import accepts a project from importProjectFile', async (t) => {
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverProjectModel.test.mjs scripts/serverSessions.test.mjs scripts/serverStatus.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 109`, `# fail 8`:

```
not ok - resetRuntime clears running state everywhere
not ok - requestDecision flags the session and lists it, unsaved; real input clears it, a terminal reply does not
not ok - a decision on a done session: input clears it in one patch and keeps done and its since
not ok - sendPrompt and tool keys answer a decision; seen does not; dismissDecision does; a new request replaces it
not ok - decisions: exit keeps one, unload and a Global restart clear them; bad questions and ids are refused
not ok - v2: session.dismissDecision is wired; pty.write answers a decision
not ok - attentionEntries also lists a session with an open decision, in any status, since it was asked
not ok - welcome capabilities: mcp while the listener is up, then what the server always has
```

(the SessionManager ones with `TypeError: s.sessions.requestDecision is not a function`).

- [ ] **Step 3: Implement the model and the attention entries**

````diff
--- a/src/shared/model/types.ts
+++ b/src/shared/model/types.ts
@@ -33,6 +33,18 @@ export interface Session {
   ptyId?: string
   /** Set once the session's process has exited */
   exitCode?: number
+  /**
+   * The agent asked the user to decide something (MCP `request_decision`).
+   * Runtime only; cleared by input to the session or `session.dismissDecision`.
+   */
+  decision?: SessionDecision
+}
+
+export interface SessionDecision {
+  /** One-line summary of the decision needed */
+  question: string
+  /** Epoch ms when it was asked */
+  at: number
 }
 
 /** Data a project keeps per branch, so it survives the worktree being deleted and re-created. */
@@ -128,14 +140,19 @@ export interface ProjectSummary {
   name: string
 }
 
-/** A session that needs the user, as listed by the `attention` topic. */
+/**
+ * A session that needs the user, as listed by the `attention` topic: one in
+ * `attention` or `done`, or one with an open decision (in any status).
+ */
 export interface AttentionEntry {
   projectId: string
   /** null = a Global panel session */
   worktreeId: string | null
   sessionId: string
   title: string
-  status: Extract<SessionStatus, 'attention' | 'done'>
-  /** Epoch ms when the session entered this status */
+  status: SessionStatus
+  /** Epoch ms when the session entered `attention` or `done`; otherwise when its decision was asked */
   since: number
+  /** The session's open decision */
+  decision?: SessionDecision
 }
````

````diff
--- a/server/src/sessions/status.ts
+++ b/server/src/sessions/status.ts
@@ -72,7 +72,7 @@ export function isTerminalReply(data: string): boolean {
   return true
 }
 
-/** The `attention` topic's entries: sessions in attention or done, oldest first. */
+/** The `attention` topic's entries: sessions in attention or done, or with an open decision, oldest first. */
 export function attentionEntries(
   projects: Iterable<Project>,
   since: ReadonlyMap<string, number>,
@@ -82,8 +82,18 @@ export function attentionEntries(
   const fallback = now()
   for (const project of projects) {
     const add = (worktreeId: string | null, s: Project['globalSessions'][number]): void => {
-      if (s.status !== 'attention' && s.status !== 'done') return
-      entries.push({ projectId: project.id, worktreeId, sessionId: s.id, title: s.title, status: s.status, since: since.get(s.id) ?? fallback })
+      const flagged = s.status === 'attention' || s.status === 'done'
+      if (!flagged && !s.decision) return
+      const entry: AttentionEntry = {
+        projectId: project.id,
+        worktreeId,
+        sessionId: s.id,
+        title: s.title,
+        status: s.status,
+        since: flagged ? since.get(s.id) ?? fallback : s.decision!.at
+      }
+      if (s.decision) entry.decision = s.decision
+      entries.push(entry)
     }
     for (const s of project.globalSessions) add(null, s)
     for (const r of project.repositories) for (const w of r.worktrees) for (const s of w.sessions) add(w.id, s)
````

````diff
--- a/server/src/projects/model.ts
+++ b/server/src/projects/model.ts
@@ -40,7 +40,7 @@ export function newProject(
 }
 
 function resetSession(s: Session): Session {
-  const { ptyId: _p, exitCode: _e, ...rest } = s
+  const { ptyId: _p, exitCode: _e, decision: _d, ...rest } = s
   // `complete` is the user marking a session finished, not something that was running.
   return { ...rest, status: s.status === 'complete' ? 'complete' : 'idle' }
 }
````

- [ ] **Step 4: Implement the SessionManager**

The question's limit:

````diff
--- a/server/src/sessions/limits.ts
+++ b/server/src/sessions/limits.ts
@@ -17,6 +17,8 @@ export const MAX_COLS = 500
 export const MAX_ROWS = 200
 /** The most session records one project holds, running or not. */
 export const MAX_SESSIONS_PER_PROJECT = 500
+/** The longest question a decision request carries. */
+export const MAX_QUESTION_LENGTH = 1000
 
 const bad = (message: string): Error => codedError('BAD_REQUEST', message)
 
@@ -36,3 +38,11 @@ export function checkQueue(queue: unknown, field: string): string[] {
   if (queue.some((q: string) => q.length > MAX_QUEUE_ENTRY)) throw bad(`each prompt in ${field} must be at most ${MAX_QUEUE_ENTRY} characters`)
   return [...queue] as string[]
 }
+
+/** A decision's question: a non-empty string, trimmed, at most MAX_QUESTION_LENGTH characters. */
+export function checkQuestion(value: unknown, field: string): string {
+  const question = typeof value === 'string' ? value.trim() : ''
+  if (!question) throw bad(`${field} is required`)
+  if (question.length > MAX_QUESTION_LENGTH) throw bad(`${field} must be at most ${MAX_QUESTION_LENGTH} characters`)
+  return question
+}
````

`requestDecision` and `dismissDecision`; `onUserInput` clears the decision in the same patch as the status change (or alone, when the status stays), and `setStatus` moves `since` only when the status changes; `unloadWorktree` and `forgetGlobal` clear decisions with the ptys:

````diff
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -23,7 +23,7 @@ import type { TopicHub } from '../topicHub.ts'
 import { checkExpected, isRecord, requireBoolean, requireName, requireString } from '../validate.ts'
 import type { McpAccess } from '../../../src/shared/providers/types'
 import { agentCommand, sessionEnv, shellLaunch } from './launch.ts'
-import { MAX_COLS, MAX_PTY_WRITE, MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH, MAX_ROWS, MAX_SESSIONS_PER_PROJECT, checkQueue, checkTitle } from './limits.ts'
+import { MAX_COLS, MAX_PTY_WRITE, MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH, MAX_ROWS, MAX_SESSIONS_PER_PROJECT, checkQuestion, checkQueue, checkTitle } from './limits.ts'
 import { findSession, findWorktree, sessionList } from './locate.ts'
 import {
   IDLE_MS,
@@ -321,6 +321,24 @@ export class SessionManager {
     return null
   }
 
+  /**
+   * The session's agent asks the user to decide something (MCP request_decision).
+   * A newer request replaces an open one. Runtime only, like the status.
+   */
+  requestDecision(p: any): null {
+    const question = checkQuestion(p.question, 'question')
+    this.mutate(p.projectId, p.sessionId, (s) => { s.decision = { question, at: this.now() } }, false)
+    this.publishAttention()
+    return null
+  }
+
+  /** A client dismissed the session's decision without answering it in the terminal. */
+  dismissDecision(p: any): null {
+    this.mutate(p.projectId, p.sessionId, (s) => { delete s.decision }, false)
+    this.publishAttention()
+    return null
+  }
+
   /** A client typed into the pty (pty.write). Terminal auto-replies are not input. */
   noteInput(ptyId: string, data: string): void {
     if (isTerminalReply(data)) return
@@ -382,6 +400,8 @@ export class SessionManager {
         for (const s of target.sessions) {
           delete s.ptyId
           delete s.exitCode
+          // The agent that asked is gone; its question would outlive it.
+          delete s.decision
           if (s.status !== 'complete') s.status = 'idle'
         }
       },
@@ -420,6 +440,7 @@ export class SessionManager {
           for (const s of d.globalSessions) {
             delete s.ptyId
             delete s.exitCode
+            delete s.decision
             if (s.status !== 'complete') s.status = 'idle'
           }
         },
@@ -641,8 +662,9 @@ export class SessionManager {
   }
 
   /**
-   * The user typed or sent a prompt. Leaving attention or complete for working arms
-   * the quiet timer as output does, so an agent that prints nothing still settles.
+   * The user typed or sent a prompt: it answers an open decision. Leaving attention or
+   * complete for working arms the quiet timer as output does, so an agent that prints
+   * nothing still settles.
    */
   private onUserInput(ptyId: string): void {
     if (this.stopped) return
@@ -650,13 +672,14 @@ export class SessionManager {
     const session = owner && this.sessionOf(owner)
     if (!owner || !session) return
     const status = onInput(session.status)
-    if (status === session.status) return
-    if (status === 'working') {
+    const answered = session.decision !== undefined
+    if (status === session.status && !answered) return
+    if (status !== session.status && status === 'working') {
       const entry = this.activity.get(owner.sessionId) ?? { activity: newActivity() }
       this.activity.set(owner.sessionId, entry)
       this.armQuiet(ptyId, entry)
     }
-    this.setStatus(owner, status)
+    this.setStatus(owner, status, answered)
   }
 
   private onQuietTimer(ptyId: string, entry: { activity: Activity; quiet?: ScheduledJob }): void {
@@ -690,15 +713,31 @@ export class SessionManager {
     }
   }
 
-  /** A runtime-only status change (never saved), then the attention topic. */
-  private setStatus(owner: Owner, status: SessionStatus): void {
+  /**
+   * A runtime-only status change (never saved), and with `clearDecision` the
+   * session's decision cleared in the same patch, then the attention topic.
+   * `since` moves only when the status does.
+   */
+  private setStatus(owner: Owner, status: SessionStatus, clearDecision = false): void {
+    let changed = false
     try {
-      this.deps.projects.apply(owner.projectId, (d) => { findSession(d, owner.sessionId).session.status = status }, { persist: false })
+      this.deps.projects.apply(
+        owner.projectId,
+        (d) => {
+          const s = findSession(d, owner.sessionId).session
+          changed = s.status !== status
+          s.status = status
+          if (clearDecision) delete s.decision
+        },
+        { persist: false }
+      )
     } catch {
       return
     }
-    if (status === 'attention' || status === 'done') this.since.set(owner.sessionId, this.now())
-    else this.since.delete(owner.sessionId)
+    if (changed) {
+      if (status === 'attention' || status === 'done') this.since.set(owner.sessionId, this.now())
+      else this.since.delete(owner.sessionId)
+    }
     this.publishAttention()
   }
 
````

The v2 command, its types and the capability:

````diff
--- a/server/src/sessionHandlers.ts
+++ b/server/src/sessionHandlers.ts
@@ -30,6 +30,7 @@ export const sessionHandlers: Record<string, Handler> = {
   'session.setQueue': (p, ctx) => ctx.sessions.setQueue(p),
   'session.markComplete': (p, ctx) => ctx.sessions.markComplete(p),
   'session.seen': (p, ctx) => ctx.sessions.seen(p),
+  'session.dismissDecision': (p, ctx) => ctx.sessions.dismissDecision(p),
 
   'worktree.load': (p, ctx) => ctx.sessions.loadWorktree(p),
   'worktree.unload': (p, ctx) => ctx.sessions.unloadWorktree(p),
````

````diff
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -36,7 +36,9 @@ export const CAPABILITY = {
   /** The server's MCP listener is up, so sessions get the trek-dev tools (the Global panel needs them) */
   mcp: 'mcp',
   /** The server sends `topic.ended` before a topic stops (a deleted project) */
-  topicEnd: 'topicEnd'
+  topicEnd: 'topicEnd',
+  /** Sessions carry `decision` (MCP request_decision), and `session.dismissDecision` clears it */
+  decisions: 'decisions'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -163,6 +165,8 @@ export interface MethodParamsV2 {
   'session.markComplete': SessionRef & { complete: boolean }
   /** A client showed the session to the user; clears attention/done for everyone */
   'session.seen': SessionRef
+  /** Clears the session's open decision (the user dismissed it) for everyone */
+  'session.dismissDecision': SessionRef
   // Terminal stream (same shapes as v1)
   'pty.attach': { ptyId: string }
   'pty.detach': { ptyId: string }
@@ -221,6 +225,7 @@ export interface MethodResultsV2 {
   'session.setQueue': null
   'session.markComplete': null
   'session.seen': null
+  'session.dismissDecision': null
   'pty.attach': PtyInfo
   'pty.detach': null
   'pty.write': null
````

````diff
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -2,7 +2,7 @@
 import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 
 /** What this server always has. */
-export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd]
+export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions]
 
 /** `mcp` while the MCP listener is up, then the features this server always has. */
 export function welcomeCapabilities(mcp: boolean): string[] {
````

- [ ] **Step 5: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -196,6 +196,7 @@ new optional field needs no capability: its absence says enough.
 |---|---|
 | `mcp` | The server's MCP listener is up, so its sessions get the trek-dev tools (see [MCP](#mcp-trek-dev-on-the-server)). Listed per connection, only while the listener is up |
 | `topicEnd` | The server sends `topic.ended` before a topic stops (see Subscriptions) |
+| `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 
@@ -212,7 +213,7 @@ The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 | Topic | Snapshot |
 |---|---|
 | `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}], repos: [{id, name, path}]}`. `health` lists `PERSIST_FAILED` (a project could not be saved; the server keeps retrying) and `LOAD_FAILED` (a project file was skipped at start) and `REPO_UNAVAILABLE` (see Worktrees below) |
-| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done` across all projects, oldest `since` first (epoch ms; see Statuses) |
+| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, and every session with an open decision whatever its status, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions) |
 | `project:<id>` | the whole `Project` tree |
 
 - `ops` are RFC 6902 JSON Patch, limited to `add`, `remove` and `replace`.
@@ -259,7 +260,7 @@ server restarts. A server without this field simply leaves it out.
 | Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
 | Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
 | Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
-| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen` |
+| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
@@ -368,7 +369,7 @@ rejects the import with `BAD_REQUEST` if any repository, worktree or session id
 is empty, contains a space, or already exists on that server, and with
 `PATH_DENIED` if any repository path is not registered or any worktree path is outside its allowlist. It also requires exactly one `isMain` worktree per repository (its path becomes the registry path), no repository listed twice, no worktree path listed twice in one repository, no non-main worktree path that is another registered repository or contains one, no worktree `branch` that starts with `-` or contains whitespace or control characters, no own `__proto__` key anywhere in the payload (settings values included), and sessions within the session limits: a `title` of at most 200 characters with no control characters, and a `queue` of at most 100 non-empty prompts of at most 100,000 characters each (the rules of `session.rename` and `session.setQueue`); otherwise `BAD_REQUEST`. It resets runtime
 fields: `status` to idle, `loaded` to false, and drops `ptyId`, `exitCode`,
-`dirty`, `ahead`, `behind`, `head` and `missing`.
+`decision`, `dirty`, `ahead`, `behind`, `head` and `missing`.
 
 Projects use registered repositories only. `project.create`, `repo.add` and
 `project.import` fail with `PATH_DENIED` for a repository path that is not in
@@ -515,7 +516,29 @@ the desktop's rules, applied to live output only; replay never changes a status.
   `session.markComplete`.
 - **The `attention` topic** is republished whenever any entry field can change: a
   status change, `session.rename`, `session.close`, `worktree.unload`, `session.seen`,
-  `session.markComplete`, and removal of a worktree, repository or project.
+  `session.markComplete`, a decision asked, answered or dismissed, and removal of a
+  worktree, repository or project.
+
+**Decisions.** An agent that stops to ask the user something calls the MCP tool
+`request_decision {terminalId, question}`. The session then carries
+`decision: {question, at}` (`at` in epoch ms), a newer request replacing an open
+one, and the `attention` topic lists it with its `decision`, whatever its status;
+an entry listed only for its decision has `since` = `at`. The decision clears for
+every client:
+
+- on input to the session, exactly what turns `attention` into `working` (a
+  `pty.write` that is not only terminal replies, `session.sendPrompt`, and the
+  MCP `send_keys`), in the same patch as that status change. Input to a session
+  in another status clears the decision and leaves the status alone;
+- with `session.dismissDecision {projectId, sessionId}` (the user dismissed it
+  without typing an answer; a session with no decision is fine);
+- when `worktree.unload` (or a repository removal, for Global sessions) ends the
+  agent that asked, and with the session on `session.close`.
+
+`session.seen` does not clear it, and an agent that exits keeps it until one of
+the above. Decisions are runtime only, like statuses: never saved on their own,
+and dropped when a project loads or is imported. `question` is trimmed and must
+be 1 to 1000 characters, else `BAD_REQUEST`.
 
 Known gaps, the same as on the desktop unless noted:
 
````

- [ ] **Step 6: Verify**

Run: `node --test scripts/serverProjectModel.test.mjs scripts/serverSessions.test.mjs scripts/serverStatus.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 117`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean. The app compiles against the widened `AttentionEntry` (nothing in it reads the `attention` topic yet). `npm test` is at 1179.

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): session decisions, cleared by input or session.dismissDecision, listed in the attention topic" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/capabilities.ts server/src/projects/model.ts server/src/sessionHandlers.ts server/src/sessions/limits.ts server/src/sessions/manager.ts server/src/sessions/status.ts src/shared/model/types.ts src/shared/protocolV2.ts scripts/serverProjectModel.test.mjs scripts/serverSessions.test.mjs scripts/serverStatus.test.mjs scripts/serverV2.test.mjs
```

---

### Task 6: The MCP `request_decision` tool

The desktop's tool, on the server (Decision 5). `list_worktrees` and `get_current_session` report the open question.

**Files:**
- Modify: `server/src/mcp/tools.ts`, `server/src/mcp/describe.ts`, `PROTOCOL.md`
- Test: `scripts/serverMcpTools.test.mjs`

- [ ] **Step 1: Write the failing tests**

The fixture project gets a session with a decision; the tool list, a new tool test, and the Global test (renamed) cover it:

````diff
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -19,7 +19,7 @@ process.env.GIT_CONFIG_GLOBAL = '/dev/null'
 process.env.GIT_CONFIG_NOSYSTEM = '1'
 const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
 
-const s = (id, status = 'idle') => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status })
+const s = (id, status = 'idle', extra = {}) => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status, ...extra })
 const project = {
   id: 'p', name: 'P',
   settings: { worktreeTags: [{ id: 't1', name: 'Todo', color: '#fff' }], customTags: [{ id: 'c1', name: 'Hot', color: '#f00' }] },
@@ -27,7 +27,7 @@ const project = {
   repositories: [
     { id: 'ra', name: 'A', path: '/r/a', branchData: { feat: { tag: 't1', customTags: ['c1'], note: 'n', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3' } }, worktrees: [
       { id: 'am', name: 'A', path: '/r/a', branch: 'main', isMain: true, loaded: false, sessions: [] },
-      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working')] }
+      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working'), s('s2', 'idle', { decision: { question: 'Which?', at: 1 } })] }
     ] },
     { id: 'rb', name: 'B', path: '/r/b', branchData: {}, worktrees: [
       { id: 'bm', name: 'B', path: '/r/b', branch: 'main', isMain: true, loaded: false, sessions: [] }
@@ -40,7 +40,10 @@ test('describeWorktree', () => {
     worktree: 'af', repo: 'A', repoId: 'ra', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
     tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', note: 'n',
     dirty: true, ahead: 1, behind: 0, loaded: true,
-    sessions: [{ terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'] }]
+    sessions: [
+      { terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'], decision: null },
+      { terminalId: 's2', title: 's2', status: 'idle', llm: { provider: 'claude' }, queue: ['q'], decision: 'Which?' }
+    ]
   })
 })
 
@@ -108,7 +111,7 @@ test('the tool list matches decision 5', () => {
   assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
     'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session',
     'list_session_types', 'list_worktrees', 'load_worktree', 'read_terminal', 'remove_queued_prompt',
-    'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
+    'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
     'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'start_session', 'unload_worktree',
     'wait_for_sessions'
   ])
@@ -460,12 +463,33 @@ test('delete_session_type: unknown type is NOT_FOUND, and malformed saved entrie
   assert.deepEqual(await s.call('list_session_types', {}), [{ id: 'z' }, { id: 'k', name: 'Keep', systemPrompt: '' }])
 })
 
-test('Global sessions: only get_current_session reaches them', async (t) => {
+test('request_decision flags the session for every client; typing answers it; bad arguments', async (t) => {
+  const s = await toolSetup(t)
+  const { terminalId } = await s.call('start_session', { worktree: 'main' })
+  assert.deepEqual(await s.call('request_decision', { terminalId, question: ' Use Postgres or SQLite? ' }), { notified: true })
+  const session = () => s.projects.require(s.projectId).repositories[0].worktrees[0].sessions[0]
+  assert.equal(session().decision.question, 'Use Postgres or SQLite?')
+  assert.equal((await s.call('get_current_session', { terminalId })).decision, 'Use Postgres or SQLite?')
+  assert.equal((await s.call('list_worktrees', {}))[0].sessions[0].decision, 'Use Postgres or SQLite?')
+  await s.call('send_keys', { terminalId, keys: ['1', 'enter'] })
+  assert.equal(session().decision, undefined)
+  assert.equal((await s.call('get_current_session', { terminalId })).decision, null)
+  await assert.rejects(s.call('request_decision', { terminalId, question: '  ' }), (e) => e.code === 'BAD_REQUEST' && /question is required/.test(e.message))
+  await assert.rejects(s.call('request_decision', { terminalId, question: 7 }), (e) => e.code === 'BAD_REQUEST')
+  await assert.rejects(s.call('request_decision', { question: 'q' }), (e) => e.code === 'BAD_REQUEST' && /terminalId/.test(e.message))
+  await assert.rejects(s.call('request_decision', { terminalId: 'nope', question: 'q' }), (e) => e.code === 'NOT_FOUND')
+  const other = s.callerFor(s.projects.create('Q', [{ registered: s.registered, name: undefined }]))
+  await assert.rejects(other('request_decision', { terminalId, question: 'q' }), (e) => e.code === 'NOT_FOUND', 'another project cannot flag it')
+})
+
+test('Global sessions: only get_current_session and request_decision reach them', async (t) => {
   const s = await toolSetup(t)
   const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, cols: 80, rows: 24 })
   const me = await s.call('get_current_session', { terminalId: sessionId })
   assert.equal(me.terminalId, sessionId)
   assert.equal(me.worktree, null)
+  assert.deepEqual(await s.call('request_decision', { terminalId: sessionId, question: 'Which repo?' }), { notified: true })
+  assert.equal(s.projects.require(s.projectId).globalSessions[0].decision.question, 'Which repo?')
   const calls = [
     ['send_prompt', { terminalId: sessionId, text: 'x' }],
     ['enqueue_prompt', { terminalId: sessionId, text: 'x' }],
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 33`, `# fail 4`:

```
not ok - describeWorktree
not ok - the tool list matches decision 5
not ok - request_decision flags the session for every client; typing answers it; bad arguments
not ok - Global sessions: only get_current_session and request_decision reach them
```

(the tool calls fail with `BAD_REQUEST` "Unknown tool: request_decision").

- [ ] **Step 3: Implement**

````diff
--- a/server/src/mcp/describe.ts
+++ b/server/src/mcp/describe.ts
@@ -25,7 +25,14 @@ export function describeWorktree(project: Project, repo: Repository, w: Worktree
     ahead: w.ahead,
     behind: w.behind,
     loaded: w.loaded,
-    sessions: w.sessions.map((s) => ({ terminalId: s.id, title: s.title, status: s.status, llm: s.llm, queue: s.queue }))
+    sessions: w.sessions.map((s) => ({
+      terminalId: s.id,
+      title: s.title,
+      status: s.status,
+      llm: s.llm,
+      queue: s.queue,
+      decision: s.decision?.question ?? null
+    }))
   }
 }
 
````

The tool goes after `get_current_session`, as on the desktop. `sessionIn` (not `targetIn`) lets a Global session ask; `checkQuestion` (Task 5) gives the desktop's "question is required" for a missing or blank one:

````diff
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -60,6 +60,22 @@ export const MCP_TOOLS: ToolDefinition[] = [
       required: ['terminalId']
     }
   },
+  {
+    name: 'request_decision',
+    description:
+      "Tell the user you need them to make a decision before you can continue. Flags your session for every Trek client of this server and lists it in their notifications; it clears when the user types in your session or dismisses it. Call it whenever you stop to ask the user to choose between options or approve an approach, after writing the question and options in your reply, then end your turn and wait for their answer. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
+    inputSchema: {
+      type: 'object',
+      properties: {
+        terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
+        question: {
+          type: 'string',
+          description: 'One-line summary of the decision needed, shown in the notification (at most 1000 characters)'
+        }
+      },
+      required: ['terminalId', 'question']
+    }
+  },
   {
     name: 'create_worktree',
     description:
@@ -278,7 +294,7 @@ export const MCP_TOOLS: ToolDefinition[] = [
 ]
 
 export const MCP_INSTRUCTIONS =
-  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID."
+  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
 
 export interface ToolDeps {
   store: ConfigStore
@@ -550,6 +566,7 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         status: session.status,
         llm: session.llm,
         queue: session.queue,
+        decision: session.decision?.question ?? null,
         worktree: repo && worktree ? describeWorktree(project, repo, worktree) : null
       }
     }
@@ -764,6 +781,13 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         })
       },
 
+      request_decision: (args) => {
+        // Global sessions may ask too, so this does not go through targetIn.
+        const { session } = sessionIn(args.terminalId)
+        deps.sessions.requestDecision({ projectId, sessionId: session.id, question: args.question })
+        return { notified: true }
+      },
+
       close_session: async (args) => {
         const { session } = targetIn(args.terminalId)
         await v2('session.close', { sessionId: session.id })
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -724,14 +724,16 @@ lists the paths. Arguments are validated: a field of the wrong type is
 `BAD_REQUEST`, not read as empty.
 
 **Global sessions.** A Global session can only be read, through
-`get_current_session`, which answers with `worktree: null`. Every other tool that
-takes a `terminalId` refuses it with `BAD_REQUEST` ("the Global session can't be
-targeted by tools"). An unknown session is `NOT_FOUND`.
+`get_current_session`, which answers with `worktree: null`, and can ask for a
+decision with `request_decision`. Every other tool that takes a `terminalId`
+refuses it with `BAD_REQUEST` ("the Global session can't be targeted by tools").
+An unknown session is `NOT_FOUND`.
 
 A *worktree entry* below is what `list_worktrees` returns for one worktree:
 `{worktree, repo, repoId, path, branch, primary, missing, tag, customTags, ticket,
 pullRequest, note, dirty, ahead, behind, loaded, sessions: [{terminalId, title,
-status, llm, queue}]}`.
+status, llm, queue, decision}]}`, where `decision` is the open decision's question
+or `null`.
 
 | Tool | Parameters | Result |
 |---|---|---|
@@ -739,7 +741,8 @@ status, llm, queue}]}`.
 | `create_worktree` | `branch`; `existingBranch?` (check out an existing branch; default false); `repo?` (name or id; required with several repositories) | the new worktree entry |
 | `load_worktree` | `worktree` | `{loaded: true, sessions}` |
 | `unload_worktree` | `worktree` | `{unloaded: true}` |
-| `get_current_session` | `terminalId` | `{terminalId, title, status, llm, queue, worktree}`, `worktree` being an entry (`null` for a Global session) |
+| `get_current_session` | `terminalId` | `{terminalId, title, status, llm, queue, decision, worktree}`, `worktree` being an entry (`null` for a Global session) |
+| `request_decision` | `terminalId`, `question` (1 to 1000 characters once trimmed) | `{notified: true}`; sets the session's `decision` (see [Decisions](#sessions)) |
 | `start_session` | `worktree`; `sessionType?` (id or name, case-insensitive); `prompt?`; `provider?`, `model?`, `effort?` | `{terminalId, status}`; with a `prompt`, also `promptSent` (and `reason` when it is `false`) |
 | `close_session` | `terminalId` | `{closed: true}` |
 | `send_prompt` | `terminalId`, `text` | `{sent: true}` |
@@ -757,7 +760,7 @@ status, llm, queue}]}`.
 | `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
 | `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |
 
-That is 21 tools. Tags are matched by name or id, case-insensitively, and an
+That is 22 tools. Tags are matched by name or id, case-insensitively, and an
 unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
 Linear workspace or Azure DevOps base URL from a URL and saves it to the project's
 settings. A worktree with a detached HEAD has no branch data, so the `set_worktree_*`
@@ -770,9 +773,7 @@ and needs a `name` to create. A name already used by another type is `BAD_REQUES
 not listed, and calling one is `-32602`.
 
 - Desktop UI only: `get_selected_worktree` and `focus_session` (selection lives in
-  clients), `promote_to_primary` (it needs a confirmation dialog), and
-  `request_decision` (the decision flag and its notification belong to phase 3's
-  notifications menu).
+  clients), and `promote_to_primary` (it needs a confirmation dialog).
 - Phase 5: `speak_summary` (voice) and `get_stack`, `start_stack`, `stop_stack`,
   `read_stack_log` (Docker).
 
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 37`, `# fail 0`.

Run: `npm --prefix server run typecheck`

Expected: clean. `npm test` is at 1180.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): MCP request_decision; worktree entries and get_current_session report the decision" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/mcp/describe.ts server/src/mcp/tools.ts scripts/serverMcpTools.test.mjs
```

---

### Task 7: `session.dequeue`

Remove one queued prompt, compare-and-set, so a concurrent enqueue or send is not lost (Note 11, Decision 19).

**Files:**
- Modify: `server/src/sessions/manager.ts`, `server/src/sessionHandlers.ts`, `server/src/mcp/tools.ts`, `src/shared/protocolV2.ts`, `server/src/capabilities.ts`, `PROTOCOL.md`
- Test: `scripts/serverSessions.test.mjs`, `scripts/serverV2.test.mjs`

- [ ] **Step 1: Write the failing tests**

Before "sendPrompt pastes with CRs…":

````diff
--- a/scripts/serverSessions.test.mjs
+++ b/scripts/serverSessions.test.mjs
@@ -496,6 +496,33 @@ test('enqueue appends, setQueue replaces; both are saved', (t) => {
   assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['ok', 3] }), (e) => e.code === 'BAD_REQUEST')
 })
 
+test('dequeue removes one prompt, guarded by expected; it is saved', async (t) => {
+  const s = setup(t)
+  const { call } = v2(s)
+  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  const ref = { projectId: s.projectId, sessionId }
+  s.sessions.setQueue({ ...ref, queue: ['a', 'b', 'c'] })
+  const queue = () => s.wx().sessions[0].queue
+  const before = s.saves.length
+  assert.deepEqual(await call('session.dequeue', { ...ref, index: 1, expected: 'b' }), { ok: true, result: null })
+  assert.deepEqual(queue(), ['a', 'c'])
+  assert.equal(s.saves.length, before + 1)
+  // Another client sent 'a' meanwhile: index 0 is now 'c'.
+  s.sessions.setQueue({ ...ref, queue: ['c'] })
+  const stale = await call('session.dequeue', { ...ref, index: 0, expected: 'a' })
+  assert.deepEqual([stale.error.code, stale.error.message], ['CONFLICT', 'queue[0] changed since you read it'])
+  assert.equal((await call('session.dequeue', { ...ref, index: 3, expected: 'c' })).error.code, 'CONFLICT', 'the queue no longer reaches the index')
+  assert.equal((await call('session.dequeue', { ...ref, index: 3 })).error.code, 'BAD_REQUEST')
+  for (const index of [-1, 0.5, '0', undefined]) {
+    assert.equal((await call('session.dequeue', { ...ref, index })).error.code, 'BAD_REQUEST', String(index))
+  }
+  assert.equal((await call('session.dequeue', { ...ref, index: 0, expected: 3 })).error.code, 'BAD_REQUEST')
+  assert.deepEqual(queue(), ['c'])
+  await call('session.dequeue', { ...ref, index: 0 })
+  assert.deepEqual(queue(), [])
+  assert.equal((await call('session.dequeue', { ...ref, index: 0 })).error.message, 'the queue is empty')
+})
+
 test('sendPrompt pastes with CRs, bracketed when the agent asked for it, then presses enter', async (t) => {
   const s = setup(t)
   const { sessionId, ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
````

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -266,8 +266,8 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has', () => {
-  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions'])
-  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions'])
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions', 'dequeue'])
+  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions', 'dequeue'])
 })
 
 test('project.import accepts a project from importProjectFile', async (t) => {
````

The MCP test "enqueue_prompt and remove_queued_prompt" stays as it is and must keep passing once the tool goes through `session.dequeue`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverSessions.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 97`, `# fail 2`:

```
not ok - dequeue removes one prompt, guarded by expected; it is saved
not ok - welcome capabilities: mcp while the listener is up, then what the server always has
```

(the first with `NOT_FOUND` "Unknown method: session.dequeue").

- [ ] **Step 3: Implement**

````diff
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -287,6 +287,26 @@ export class SessionManager {
     return null
   }
 
+  /**
+   * Removes the queued prompt at `index`. With `expected` (the prompt the client
+   * saw there) it is compare-and-set: CONFLICT if that prompt changed or the queue
+   * no longer reaches `index`. Without it, an index past the end is BAD_REQUEST.
+   */
+  dequeue(p: any): null {
+    const index = p.index
+    if (!Number.isInteger(index) || index < 0) throw bad('index must be a non-negative integer')
+    if (p.expected !== undefined && typeof p.expected !== 'string') throw bad('expected must be a string')
+    this.mutate(p.projectId, p.sessionId, (s) => {
+      if (index >= s.queue.length) {
+        if (p.expected !== undefined) throw codedError('CONFLICT', 'the queue changed since you read it')
+        throw bad(s.queue.length ? `index must be 0–${s.queue.length - 1}` : 'the queue is empty')
+      }
+      checkExpected(`queue[${index}]`, s.queue[index], p.expected)
+      s.queue = s.queue.filter((_, i) => i !== index)
+    })
+    return null
+  }
+
   /** Types `text` into the running session as the desktop pastes it, then presses enter. */
   async sendPrompt(p: any): Promise<null> {
     const text = requireString(p.text, 'text')
````

````diff
--- a/server/src/sessionHandlers.ts
+++ b/server/src/sessionHandlers.ts
@@ -28,6 +28,7 @@ export const sessionHandlers: Record<string, Handler> = {
   'session.sendPrompt': (p, ctx) => ctx.sessions.sendPrompt(p),
   'session.enqueue': (p, ctx) => ctx.sessions.enqueue(p),
   'session.setQueue': (p, ctx) => ctx.sessions.setQueue(p),
+  'session.dequeue': (p, ctx) => ctx.sessions.dequeue(p),
   'session.markComplete': (p, ctx) => ctx.sessions.markComplete(p),
   'session.seen': (p, ctx) => ctx.sessions.seen(p),
   'session.dismissDecision': (p, ctx) => ctx.sessions.dismissDecision(p),
````

````diff
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -38,7 +38,9 @@ export const CAPABILITY = {
   /** The server sends `topic.ended` before a topic stops (a deleted project) */
   topicEnd: 'topicEnd',
   /** Sessions carry `decision` (MCP request_decision), and `session.dismissDecision` clears it */
-  decisions: 'decisions'
+  decisions: 'decisions',
+  /** `session.dequeue` removes one queued prompt, compare-and-set */
+  dequeue: 'dequeue'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -161,6 +163,8 @@ export interface MethodParamsV2 {
   /** Appends to the session's queue. Stored for a client to send; the server never sends it on its own */
   'session.enqueue': SessionRef & { text: string }
   'session.setQueue': SessionRef & { queue: string[] }
+  /** Removes one queued prompt; `expected` is the prompt the client saw at `index` */
+  'session.dequeue': SessionRef & { index: number; expected?: string }
   /** true = fully complete (tracking paused); false = resume tracking */
   'session.markComplete': SessionRef & { complete: boolean }
   /** A client showed the session to the user; clears attention/done for everyone */
@@ -223,6 +227,7 @@ export interface MethodResultsV2 {
   'session.sendPrompt': null
   'session.enqueue': null
   'session.setQueue': null
+  'session.dequeue': null
   'session.markComplete': null
   'session.seen': null
   'session.dismissDecision': null
````

````diff
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -2,7 +2,7 @@
 import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 
 /** What this server always has. */
-export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions]
+export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue]
 
 /** `mcp` while the MCP listener is up, then the features this server always has. */
 export function welcomeCapabilities(mcp: boolean): string[] {
````

`remove_queued_prompt` sends the prompt it read as `expected`:

````diff
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -824,7 +824,7 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
               : 'The queue is empty: there is no index to remove'
           )
         }
-        await v2('session.setQueue', { sessionId: session.id, queue: queue.filter((_, i) => i !== index) })
+        await v2('session.dequeue', { sessionId: session.id, index, expected: queue[index] })
         return { removed: queue[index], queue: sessionIn(session.id).session.queue }
       },
 
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -197,6 +197,7 @@ new optional field needs no capability: its absence says enough.
 | `mcp` | The server's MCP listener is up, so its sessions get the trek-dev tools (see [MCP](#mcp-trek-dev-on-the-server)). Listed per connection, only while the listener is up |
 | `topicEnd` | The server sends `topic.ended` before a topic stops (see Subscriptions) |
 | `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
+| `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 
@@ -260,7 +261,7 @@ server restarts. A server without this field simply leaves it out.
 | Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
 | Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
 | Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
-| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
+| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
@@ -275,8 +276,8 @@ reading the message (which may be git's own, localised text). Today the only key
 is `reason`, and the only reason is `dirty` (see `worktree.remove`). Clients
 ignore keys and reasons they don't know.
 
-`project.rename`, `project.updateSettings`, `branch.setNote`, `session.rename`
-and `repo.update` take an optional `expected`: the value the client believes the
+`project.rename`, `project.updateSettings`, `branch.setNote`, `session.rename`,
+`session.dequeue` and `repo.update` take an optional `expected`: the value the client believes the
 field has now. The server fails with `CONFLICT` only if that field's current
 value differs (deep equality, null means absent). For `project.updateSettings`
 and `repo.update`, only the keys listed in `expected` are compared. A
@@ -584,7 +585,13 @@ paste when the agent has turned that mode on, and `\r` follows 150 ms later. It
 answers `BAD_REQUEST` when the session has no running pty, or when `text` is longer
 than 1 MiB (1,048,576 UTF-16 code units), the limit of `pty.write`. `session.enqueue
 {text}` appends to the session's `queue` and `session.setQueue {queue}` replaces
-it; text and queue entries must be non-empty strings. A queue entry is at most
+it; text and queue entries must be non-empty strings. `session.dequeue {index,
+expected?}` removes the prompt at `index` (0-based) without touching the rest, so
+another client's enqueue or removal meanwhile is not lost, as it can be with a
+`setQueue` of the whole list. With `expected`, the prompt the client saw at
+`index`, it is compare-and-set: `CONFLICT` if that prompt changed or the queue no
+longer reaches `index`. Without it, an `index` past the end is `BAD_REQUEST`, as
+is an `index` that is not a non-negative integer. A queue entry is at most
 100,000 characters and a queue holds at most 100 entries; beyond that is
 `BAD_REQUEST`. The server only stores the queue and never sends it: a client sends
 a queued prompt itself, with `session.sendPrompt`, when the user chooses.
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/serverSessions.test.mjs scripts/serverMcpTools.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 136`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean. `npm test` is at 1181.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): session.dequeue removes one queued prompt, compare-and-set" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/capabilities.ts server/src/mcp/tools.ts server/src/sessionHandlers.ts server/src/sessions/manager.ts src/shared/protocolV2.ts scripts/serverSessions.test.mjs scripts/serverV2.test.mjs
```

---

### Task 8: `server.agents`

Which agents the server can launch, for 3c-3b's New session menu (user decision 2; Decisions 7–10, Note 1).

**Files:**
- Create: `server/src/sessions/agents.ts`, `scripts/serverAgents.test.mjs`
- Modify: `server/src/sessions/manager.ts`, `server/src/sessionHandlers.ts`, `src/shared/protocolV2.ts`, `server/src/capabilities.ts`, `PROTOCOL.md`
- Test: `scripts/serverAgents.test.mjs`, `scripts/serverSessions.test.mjs`, `scripts/serverV2.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/serverAgents.test.mjs`:

````js
// scripts/serverAgents.test.mjs — server.agents: each provider's command, its program, and the cached installed check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCommands, commandBinary, CommandProbe, PROBE_TTL_MS } from '../server/src/sessions/agents.ts'
import { DEFAULT_LLM_SETTINGS } from '../src/shared/providers/types.ts'

test('commandBinary skips leading env assignments and blanks', () => {
  assert.equal(commandBinary('claude'), 'claude')
  assert.equal(commandBinary('  /opt/bin/codex --full-auto '), '/opt/bin/codex')
  assert.equal(commandBinary('API_KEY=x OTHER_1=y gemini -y'), 'gemini')
  assert.equal(commandBinary('A=1'), undefined)
  assert.equal(commandBinary('   '), undefined)
})

test('agentCommands: every provider, the server config command, else the default; Claude takes the project\'s claudeCommand', () => {
  const llm = { ...DEFAULT_LLM_SETTINGS, providers: { claude: { command: 'server-claude' }, codex: { command: '  ' }, gemini: { command: 'gem --x' } } }
  assert.deepEqual(agentCommands(llm, undefined), [
    { provider: 'claude', label: 'Claude', command: 'server-claude' },
    { provider: 'codex', label: 'Codex', command: 'codex' },
    { provider: 'gemini', label: 'Gemini', command: 'gem --x' },
    { provider: 'grok', label: 'Grok', command: 'grok' },
    { provider: 'local', label: 'Local', command: 'claude' }
  ])
  assert.equal(agentCommands(llm, { claudeCommand: ' my-claude ' })[0].command, 'my-claude')
  assert.equal(agentCommands(llm, { claudeCommand: '  ' })[0].command, 'server-claude')
})

test('CommandProbe shares a check in flight, reuses it for a minute, and reads a failed check as not installed', async () => {
  const clock = { t: 0 }
  const asked = []
  const probe = new CommandProbe(async (binary) => {
    asked.push(binary)
    if (binary === 'boom') throw new Error('shell failed')
    return binary === 'claude'
  }, () => clock.t)
  const [a, b] = await Promise.all([probe.installed('claude'), probe.installed('claude')])
  assert.deepEqual([a, b, asked], [true, true, ['claude']])
  assert.equal(await probe.installed('codex'), false)
  assert.equal(await probe.installed('boom'), false)
  clock.t = PROBE_TTL_MS - 1
  await probe.installed('claude')
  assert.deepEqual(asked, ['claude', 'codex', 'boom'])
  clock.t = PROBE_TTL_MS
  await probe.installed('claude')
  assert.deepEqual(asked, ['claude', 'codex', 'boom', 'claude'], 'checked again after the TTL')
})

test('CommandProbe starts over past 64 programs', async () => {
  const asked = []
  const probe = new CommandProbe(async (binary) => { asked.push(binary); return true }, () => 0)
  for (let i = 0; i < 64; i++) await probe.installed(`p${i}`)
  await probe.installed('p0')
  assert.equal(asked.length, 64, 'still cached')
  await probe.installed('p64')
  await probe.installed('p0')
  assert.equal(asked.length, 66, 'the cache was cleared for the 65th')
})
````

Through the SessionManager and v2 dispatch, with a fake `commandExists` (`setup()` passes it on):

````diff
--- a/scripts/serverSessions.test.mjs
+++ b/scripts/serverSessions.test.mjs
@@ -64,7 +64,7 @@ const tick = () => new Promise((r) => setImmediate(r))
 /** The agent command a spawn ran (the shell's -c argument). */
 const cmd = (proc) => proc.opts.args.at(-1)
 
-function setup(t, { llm, maxSessions, mcpAccess } = {}) {
+function setup(t, { llm, maxSessions, mcpAccess, commandExists } = {}) {
   const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-sessions-')))
   t.after(() => rmSync(dir, { recursive: true, force: true }))
   const a = join(dir, 'repos', 'a')
@@ -88,7 +88,7 @@ function setup(t, { llm, maxSessions, mcpAccess } = {}) {
   const scheduled = []
   const clock = { t: 1_000_000 }
   const sessions = new SessionManager({
-    projects, store, hub, spawner: fake.spawner, now: () => clock.t, mcpAccess,
+    projects, store, hub, spawner: fake.spawner, now: () => clock.t, mcpAccess, commandExists,
     discover: async (cwd, ageMs, exclude) => {
       discoveries.push({ cwd, ageMs, exclude })
       const next = sessions.__nextDiscovery
@@ -1087,6 +1087,33 @@ test('v2: session.dismissDecision is wired; pty.write answers a decision', async
   assert.equal(decisionOf(s), undefined)
 })
 
+test('v2: server.agents lists every provider, whether it is installed, and the server default', async (t) => {
+  const asked = []
+  const commandExists = async (binary) => { asked.push(binary); return binary === 'claude' || binary === 'my-claude' }
+  const s = setup(t, { llm: { llmDefault: { provider: 'codex', model: 'gpt-5' }, providers: { gemini: { command: 'KEY=secret gem' } } }, commandExists })
+  const { call } = v2(s)
+  const all = await call('server.agents', {})
+  assert.equal(all.ok, true, JSON.stringify(all))
+  assert.deepEqual(all.result, {
+    llmDefault: { provider: 'codex', model: 'gpt-5' },
+    agents: [
+      { provider: 'claude', label: 'Claude', installed: true },
+      { provider: 'codex', label: 'Codex', installed: false },
+      { provider: 'gemini', label: 'Gemini', installed: false },
+      { provider: 'grok', label: 'Grok', installed: false },
+      { provider: 'local', label: 'Local', installed: true }
+    ]
+  })
+  assert.equal(JSON.stringify(all.result).includes('secret'), false, 'command lines are not sent')
+  assert.deepEqual(asked.sort(), ['claude', 'codex', 'gem', 'grok'], 'local runs claude: one check')
+  s.projects.apply(s.projectId, (d) => { d.settings.claudeCommand = 'nope-claude --x' })
+  const scoped = await call('server.agents', { projectId: s.projectId })
+  assert.equal(scoped.result.agents[0].installed, false, "the project's claudeCommand")
+  assert.equal(scoped.result.agents[4].installed, true, 'local keeps the server command')
+  assert.equal((await call('server.agents', { projectId: 'nope' })).error.code, 'NOT_FOUND')
+  assert.equal((await call('server.agents', { projectId: 5 })).error.code, 'BAD_REQUEST')
+})
+
 test('maxSessions refusals use CAPACITY', (t) => {
   const s = setup(t, { maxSessions: 1 })
   s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
````

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -266,8 +266,8 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has', () => {
-  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions', 'dequeue'])
-  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions', 'dequeue'])
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'])
+  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions', 'dequeue', 'agents'])
 })
 
 test('project.import accepts a project from importProjectFile', async (t) => {
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverAgents.test.mjs scripts/serverSessions.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 98`, `# fail 3`:

```
not ok - scripts/serverAgents.test.mjs
not ok - v2: server.agents lists every provider, whether it is installed, and the server default
not ok - welcome capabilities: mcp while the listener is up, then what the server always has
```

(`serverAgents.test.mjs` with `ERR_MODULE_NOT_FOUND` for `server/src/sessions/agents.ts`; the dispatch test with "Unknown method: server.agents").

- [ ] **Step 3: Implement**

Create `server/src/sessions/agents.ts`:

````ts
// What the server can launch (`server.agents`): each provider, and whether the
// program of the command the server would run for it is installed for the
// server's user. The command line itself is never sent: it may carry secrets
// (`API_KEY=… claude`).
import { commandExists } from '../../../src/host/agentService.ts'
import type { ProjectSettings } from '../../../src/shared/model/types'
import { PROVIDER_LIST } from '../../../src/shared/providers/registry.ts'
import type { LlmProviderId, LlmSettings } from '../../../src/shared/providers/types'

/** How long an installed check is reused. */
export const PROBE_TTL_MS = 60_000
/** More distinct programs than this and the cache starts over. */
const MAX_PROBES = 64

/** A command line's program: its first word after any leading NAME=value assignments. */
export function commandBinary(command: string): string | undefined {
  return command.trim().split(/\s+/).find((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
}

/** Each provider with the command the server runs it with, chosen as agentCommand does. */
export function agentCommands(
  llm: LlmSettings,
  settings: ProjectSettings | undefined
): { provider: LlmProviderId; label: string; command: string }[] {
  return PROVIDER_LIST.map((p) => ({
    provider: p.id,
    label: p.label,
    command:
      (p.id === 'claude' ? settings?.claudeCommand?.trim() || undefined : undefined) ??
      (llm.providers[p.id]?.command?.trim() || p.defaultCommand)
  }))
}

/** Whether a program resolves in the login shell; each answer is shared while in flight and reused for PROBE_TTL_MS. */
export class CommandProbe {
  private readonly exists: (binary: string) => Promise<boolean>
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; result: Promise<boolean> }>()

  constructor(exists: (binary: string) => Promise<boolean> = commandExists, now: () => number = Date.now) {
    this.exists = exists
    this.now = now
  }

  installed(binary: string): Promise<boolean> {
    const hit = this.cache.get(binary)
    if (hit && this.now() - hit.at < PROBE_TTL_MS) return hit.result
    if (this.cache.size >= MAX_PROBES) this.cache.clear()
    const result = this.exists(binary).catch(() => false)
    this.cache.set(binary, { at: this.now(), result })
    return result
  }
}
````

The SessionManager owns one probe (on its own clock, so tests control the TTL):

````diff
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -37,6 +37,8 @@ import {
   type Activity
 } from './status.ts'
 import { TerminalHost, type PtySpawner } from './terminalHost.ts'
+import { agentCommands, commandBinary, CommandProbe } from './agents.ts'
+import type { ServerAgents } from '../../../src/shared/protocolV2'
 
 export const LOAD_COLS = 120
 export const LOAD_ROWS = 32
@@ -59,6 +61,8 @@ export interface SessionManagerDeps {
   now?: () => number
   /** The MCP access a project's sessions launch with; without it sessions launch without MCP */
   mcpAccess?: (projectId: string) => McpAccess | undefined
+  /** Whether a program resolves in the login shell (server.agents); default agentService.commandExists */
+  commandExists?: (binary: string) => Promise<boolean>
 }
 
 function requireSize(p: any): { cols: number; rows: number } {
@@ -112,6 +116,7 @@ export class SessionManager {
   private readonly outputSeen = new Set<string>()
   /** sessionId → when it entered attention or done */
   private readonly since = new Map<string, number>()
+  private readonly probe: CommandProbe
   private stopped = false
 
   constructor(deps: SessionManagerDeps) {
@@ -119,6 +124,7 @@ export class SessionManager {
     this.newId = deps.newId ?? randomUUID
     this.now = deps.now ?? Date.now
     this.discover = deps.discover ?? discoverCodexSession
+    this.probe = new CommandProbe(deps.commandExists, this.now)
     this.schedule =
       deps.schedule ??
       ((fn, ms) => {
@@ -372,6 +378,19 @@ export class SessionManager {
     }
   }
 
+  /** The agents this server can launch, and its default (server.agents). */
+  async agents(p: any): Promise<ServerAgents> {
+    const settings = p.projectId === undefined ? undefined : this.deps.projects.require(p.projectId).settings
+    const llm = this.deps.store.llmSettings()
+    const agents = await Promise.all(
+      agentCommands(llm, settings).map(async ({ provider, label, command }) => {
+        const binary = commandBinary(command)
+        return { provider, label, installed: binary ? await this.probe.installed(binary) : false }
+      })
+    )
+    return { llmDefault: llm.llmDefault, agents }
+  }
+
   /** True once the session's current run has produced live output (cleared when its pty ends). */
   hasOutput(sessionId: string): boolean {
     return this.outputSeen.has(sessionId)
````

````diff
--- a/server/src/sessionHandlers.ts
+++ b/server/src/sessionHandlers.ts
@@ -33,6 +33,8 @@ export const sessionHandlers: Record<string, Handler> = {
   'session.seen': (p, ctx) => ctx.sessions.seen(p),
   'session.dismissDecision': (p, ctx) => ctx.sessions.dismissDecision(p),
 
+  'server.agents': (p, ctx) => ctx.sessions.agents(p),
+
   'worktree.load': (p, ctx) => ctx.sessions.loadWorktree(p),
   'worktree.unload': (p, ctx) => ctx.sessions.unloadWorktree(p),
 
````

````diff
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -16,7 +16,7 @@ import type {
   PtyInfo,
   WireError
 } from './protocol.ts'
-import type { LlmSelection } from './providers/types.ts'
+import type { LlmProviderId, LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
 import type { EnvironmentSettings, WorktreeChanges } from './types.ts'
 
@@ -40,7 +40,9 @@ export const CAPABILITY = {
   /** Sessions carry `decision` (MCP request_decision), and `session.dismissDecision` clears it */
   decisions: 'decisions',
   /** `session.dequeue` removes one queued prompt, compare-and-set */
-  dequeue: 'dequeue'
+  dequeue: 'dequeue',
+  /** `server.agents` lists the agents the server can launch */
+  agents: 'agents'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -181,6 +183,8 @@ export interface MethodParamsV2 {
   'server.addRepo': { path: string; name?: string }
   /** Fails with IN_USE while a project uses the repo */
   'server.removeRepo': { repoId: string }
+  /** The agents the server can launch; with `projectId`, Claude's command is that project's `claudeCommand` when it has one */
+  'server.agents': { projectId?: string }
 
   // Subscriptions
   'sub.subscribe': { topic: Topic }
@@ -189,6 +193,24 @@ export interface MethodParamsV2 {
   'sys.ping': { t: number }
 }
 
+/** One agent CLI the server can run (`server.agents`). */
+export interface AgentInfo {
+  provider: LlmProviderId
+  label: string
+  /**
+   * Whether the program of the command the server would run for it resolves in
+   * the server user's login shell (checked at most once a minute per program)
+   */
+  installed: boolean
+}
+
+export interface ServerAgents {
+  /** The server config's default agent, used when neither the session, its type nor the project picks one */
+  llmDefault: LlmSelection
+  /** Every provider the server knows, installed or not, in the server's order */
+  agents: AgentInfo[]
+}
+
 export interface SubscribeResult<S> {
   snapshot: S
   rev: number
@@ -238,6 +260,7 @@ export interface MethodResultsV2 {
   /** The id of the new repo, or of the existing one if the path was already registered */
   'server.addRepo': { repoId: string }
   'server.removeRepo': null
+  'server.agents': ServerAgents
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
````

````diff
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -2,7 +2,7 @@
 import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 
 /** What this server always has. */
-export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue]
+export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue, CAPABILITY.agents]
 
 /** `mcp` while the MCP listener is up, then the features this server always has. */
 export function welcomeCapabilities(mcp: boolean): string[] {
````

- [ ] **Step 4: Document it**

````diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -198,6 +198,7 @@ new optional field needs no capability: its absence says enough.
 | `topicEnd` | The server sends `topic.ended` before a topic stops (see Subscriptions) |
 | `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
 | `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
+| `agents` | `server.agents` lists the agents the server can launch (see Sessions) |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 
@@ -264,6 +265,7 @@ server restarts. A server without this field simply leaves it out.
 | Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
+| Agents | `server.agents` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
 | Misc | `sys.ping` |
 
@@ -433,6 +435,19 @@ settings override it: `llmDefault`, `globalLlm`, `claudePermissionMode`,
 `claudeCommand`, `claudeArgs`, `sessionTypes`, `sessionSystemPrompt` and
 `globalSystemPrompt`. No method edits the `llm` section; edit the file.
 
+**Which agents.** `server.agents {projectId?}` returns `{llmDefault, agents:
+[{provider, label, installed}]}`: the `llm` section's default (Claude when it
+names none), and every provider the server knows, in its order. `installed`
+says whether the program of the command the server would run for that provider
+(the project's `claudeCommand` for Claude when `projectId` names a project that
+has one, else the `llm` section's `command`, else the provider's default; the
+program is the first word after any `NAME=value` assignments) is found by
+`command -v` in the server user's login shell. Each program's answer is reused
+for a minute, so the first call can take a few seconds. The command lines
+themselves are not sent: they may carry secrets. An unknown `projectId` is
+`NOT_FOUND`. A provider that is installed can still fail to start (a local
+model's backend may be down, say); `session.start` reports that as usual.
+
 **Starting.** `session.start {projectId, worktreeId, title?, llm?, sessionTypeId?,
 initialMessage?, cols, rows}` returns `{sessionId, ptyId}`. `worktreeId: null`
 starts a Global session. `cols` is an integer from 1 to 500 and `rows` from 1 to 200 (as for `session.restart`
````

- [ ] **Step 5: Verify**

Run: `node --test scripts/serverAgents.test.mjs scripts/serverSessions.test.mjs scripts/serverV2.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 104`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck`

Expected: both clean. `npm test` is at 1186.

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/agents.ts scripts/serverAgents.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): server.agents lists the agents the server can launch and its default" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/src/capabilities.ts server/src/sessionHandlers.ts server/src/sessions/agents.ts server/src/sessions/manager.ts src/shared/protocolV2.ts scripts/serverAgents.test.mjs scripts/serverSessions.test.mjs scripts/serverV2.test.mjs
```

---

### Task 9: The settings check, and the smokes

Pin down that `project.updateSettings` already guards every setting the app will edit (user decision 3, Decision 20), then drive everything this plan added through a real server: the server smoke with raw frames, `smoke:client` through the SDK.

**Files:**
- Modify: `server/scripts/smoke.mjs`, `scripts/client-contract.mjs`
- Test: `scripts/serverV2.test.mjs`

- [ ] **Step 1: The settings test**

Before "wrong id types are BAD_REQUEST, not NOT_FOUND":

````diff
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -210,6 +210,37 @@ test('project.updateSettings merges, null removes, expected is per key', async (
   assert.equal((await snapshotOf(call, projectId)).settings.claudeCommand, 'c')
 })
 
+test('project.updateSettings expected guards the settings a settings screen edits: absent is null, values compare deeply', async (t) => {
+  const { a, call } = setup(t)
+  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
+  const update = (settings, expected) => call('project.updateSettings', { projectId, settings, expected })
+  const review = [{ id: 'rev', name: 'Review', systemPrompt: 'Review it', llm: { provider: 'codex' } }]
+  const buttons = [{ id: 'b', label: 'Test', text: 'npm test' }]
+  // Keys never set match null.
+  const first = await update(
+    { sessionTypes: review, terminalButtons: buttons, worktreeTags: [{ id: 't', name: 'Todo', color: '#fff' }], llmDefault: { provider: 'gemini' }, bot: { enabled: false }, audioAlerts: true },
+    { sessionTypes: null, terminalButtons: null, worktreeTags: null, llmDefault: null, bot: null, audioAlerts: null, customTags: null, globalLlm: null, claudeCommand: null }
+  )
+  assert.equal(first.ok, true, JSON.stringify(first))
+  // A structurally equal copy of each current value passes.
+  const second = await update(
+    { sessionTypes: [...review, { id: 'fix', name: 'Fix', systemPrompt: '' }] },
+    { sessionTypes: structuredClone(review), llmDefault: { provider: 'gemini' }, bot: { enabled: false } }
+  )
+  assert.equal(second.ok, true, JSON.stringify(second))
+  // A stale value of one guarded key fails the whole patch.
+  const stale = await update({ terminalButtons: [], audioAlerts: false }, { terminalButtons: [], audioAlerts: true })
+  assert.deepEqual([stale.error.code, stale.error.message], ['CONFLICT', 'settings.terminalButtons changed since you read it'])
+  const settings = (await snapshotOf(call, projectId)).settings
+  assert.deepEqual(settings.terminalButtons, buttons)
+  assert.equal(settings.audioAlerts, true)
+  assert.equal(settings.sessionTypes.length, 2)
+  // Order matters inside an array; a removed key reads as null again.
+  assert.equal((await update({ audioAlerts: null }, { sessionTypes: [...settings.sessionTypes].reverse() })).error.code, 'CONFLICT')
+  assert.equal((await update({ audioAlerts: null }, { audioAlerts: true })).ok, true)
+  assert.equal((await update({ audioAlerts: false }, { audioAlerts: null })).ok, true)
+})
+
 test('wrong id types are BAD_REQUEST, not NOT_FOUND', async (t) => {
   const { a, call } = setup(t)
   const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
````

- [ ] **Step 2: Run it**

Run: `node --test scripts/serverV2.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 33`, `# fail 0`. It passes without a server change: this test documents the contract 3c-3b relies on, and fails if a later change breaks it. `npm test` is at 1187.

- [ ] **Step 3: The server smoke**

The checks go where their state already exists: the welcome; the response rev next to the existing `branch.setNote` check (the `res` frame's index is compared with the patch frame's, so "patch before response" is checked on the wire); the dirty refusal on the worktree the smoke already creates; a decision, `session.dequeue` and `server.agents` in the MCP block, which has the `rpc()` helper (the session runs the `local` provider's lingering status agent, so its pty is alive for `pty.write`); `topic.ended` after `project.delete`:

````diff
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -1,6 +1,7 @@
 // trek-server smoke test: throwaway config + temp git repo, then handshake,
 // git.listWorktrees, pty spawn/echo/kill, the projects flow (create, branch
-// note, persist, delete) and an auth-rejection check.
+// note, persist, delete), revs in responses, decisions, server.agents, the
+// topic end of a deleted project and an auth-rejection check.
 import { spawn, execFileSync } from 'node:child_process'
 import { request as httpRequest } from 'node:http'
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
@@ -216,9 +217,9 @@ async function nextPatch(conn, topic, state, timeoutMs = 4000) {
 const v2 = await connect(2, token)
 if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
   fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
-} else if (!v2.welcome.capabilities?.includes('mcp')) {
-  fail(`v2 welcome capabilities lack mcp: ${JSON.stringify(v2.welcome.capabilities)}`)
-} else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}`)
+} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'].every((c) => v2.welcome.capabilities?.includes(c))) {
+  fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
+} else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
 const subbed = await v2.req('sub.subscribe', { topic: 'server' })
 let serverState = subbed.result
@@ -400,6 +401,18 @@ if (!noted.ok) fail(`branch.setNote: ${JSON.stringify(noted)}`)
 proj = await nextPatch(pc, `project:${projectId}`, proj)
 if (proj.snapshot.repositories[0].branchData.main?.note !== 'from smoke') fail('branch.setNote not patched')
 else ok('branch.setNote: patched into the project topic')
+{
+  // The response names the rev the note made, and that patch was written before it.
+  const at = pc.frames.indexOf(noted)
+  const patchAt = pc.frames.findIndex((f) => f.type === 'event' && f.event === 'state.patch' &&
+    f.payload.topic === `project:${projectId}` && f.payload.rev === noted.rev?.rev)
+  if (noted.rev?.topic !== `project:${projectId}` || noted.rev.rev !== proj.rev || patchAt < 0 || patchAt > at) {
+    fail(`branch.setNote rev: ${JSON.stringify(noted.rev)}, topic at ${proj.rev}, patch frame ${patchAt}, res frame ${at}`)
+  } else ok(`response rev: branch.setNote answered rev ${noted.rev.rev}, after its patch`)
+  const listed = await pc.req('project.list', {})
+  if (!listed.ok || 'rev' in listed) fail(`project.list carries a rev: ${JSON.stringify(listed)}`)
+  else ok('response rev: a method that names no project carries none')
+}
 
 // --- worktrees ---
 // The poller also patches the project topic, so apply patches until `cond` holds (bounded).
@@ -428,6 +441,12 @@ const wtChanges = await pc.req('worktree.changes', { projectId, worktreeId: wtId
 if (!wtChanges.ok || !Array.isArray(wtChanges.result.files)) fail(`worktree.changes: ${JSON.stringify(wtChanges)}`)
 else ok('worktree.changes answers')
 
+// A dirty worktree is refused with a reason the client can act on, whatever git's locale.
+writeFileSync(join(wtRow.path, 'scratch.txt'), 'x')
+const wtDirty = await pc.req('worktree.remove', { projectId, worktreeId: wtId })
+if (wtDirty.ok || wtDirty.error.code !== 'GIT_ERROR' || wtDirty.error.details?.reason !== 'dirty') fail(`worktree.remove dirty: ${JSON.stringify(wtDirty)}`)
+else ok('worktree.remove: a dirty worktree is GIT_ERROR with details.reason "dirty"')
+rmSync(join(wtRow.path, 'scratch.txt'))
 const wtRemoved = await pc.req('worktree.remove', { projectId, worktreeId: wtId })
 if (!wtRemoved.ok || existsSync(wtRow?.path ?? '')) fail(`worktree.remove: ${JSON.stringify(wtRemoved)}`)
 await patchUntil(() => !projWorktrees().some((w) => w.id === wtId))
@@ -599,6 +618,47 @@ const mcpConfigPath = join(work, 'data', 'mcp', `${projectId}.json`)
     if (called.body?.result?.isError !== false || !Array.isArray(worktrees) || worktrees.length !== 1) {
       fail(`mcp tools/call list_worktrees: ${JSON.stringify(called)}`)
     } else ok(`mcp tools/call list_worktrees: one worktree (${worktrees[0].branch})`)
+
+    // A decision: asked through MCP, seen in the project and attention topics, answered by typing.
+    const asking = await pc.req('session.start', { projectId, worktreeId: mainId, cols: 80, rows: 24, llm: { provider: 'local' } })
+    if (!asking.ok) fail(`decision session.start: ${JSON.stringify(asking)}`)
+    else {
+      const { sessionId: askId, ptyId: askPty } = asking.result
+      const askSession = () => projWorktrees().find((w) => w.isMain)?.sessions.find((x) => x.id === askId)
+      let att = (await pc.req('sub.subscribe', { topic: 'attention' })).result
+      const asked = await rpc('tools/call', { name: 'request_decision', arguments: { terminalId: askId, question: 'Ship it?' } })
+      if (asked.body?.result?.isError !== false) fail(`mcp request_decision: ${JSON.stringify(asked)}`)
+      await patchUntil(() => askSession()?.decision?.question === 'Ship it?')
+      if (askSession()?.decision?.question !== 'Ship it?') fail(`decision not in the project topic: ${JSON.stringify(askSession())}`)
+      else ok('mcp request_decision: the session carries the decision')
+      for (let i = 0; i < 8 && !att.snapshot.entries.some((e) => e.sessionId === askId && e.decision); i++) {
+        try { att = await nextPatch(pc, 'attention', att, 2500) } catch { break }
+      }
+      if (!att.snapshot.entries.some((e) => e.sessionId === askId && e.decision?.question === 'Ship it?')) fail(`attention lacks the decision: ${JSON.stringify(att.snapshot)}`)
+      else ok('attention topic: lists the decision')
+      await pc.req('pty.attach', { ptyId: askPty })
+      await pc.req('pty.write', { ptyId: askPty, data: 'y' })
+      await patchUntil(() => askSession() && !askSession().decision)
+      if (!askSession() || askSession().decision) fail(`typing did not answer the decision: ${JSON.stringify(askSession())}`)
+      else ok('pty.write: user input answers the decision')
+
+      // session.dequeue: one prompt, compare-and-set.
+      await pc.req('session.setQueue', { projectId, sessionId: askId, queue: ['a', 'b'] })
+      const dq = await pc.req('session.dequeue', { projectId, sessionId: askId, index: 0, expected: 'a' })
+      const stale = await pc.req('session.dequeue', { projectId, sessionId: askId, index: 0, expected: 'a' })
+      await patchUntil(() => askSession()?.queue.length === 1)
+      if (!dq.ok || stale.error?.code !== 'CONFLICT' || askSession()?.queue[0] !== 'b') fail(`session.dequeue: ${JSON.stringify({ dq, stale, queue: askSession()?.queue })}`)
+      else ok('session.dequeue: removes the prompt it saw; a stale one is CONFLICT')
+      await pc.req('session.close', { projectId, sessionId: askId })
+      await patchUntil(() => !askSession())
+    }
+
+    const agents = await pc.req('server.agents', {})
+    const agentOf = (id) => agents.result?.agents?.find((a) => a.provider === id)
+    if (!agents.ok || agents.result.llmDefault?.provider !== 'claude' || agents.result.agents.length !== 5 ||
+      agentOf('claude')?.installed !== true || agentOf('local')?.installed !== true || JSON.stringify(agents.result).includes(fakeAgent)) {
+      fail(`server.agents: ${JSON.stringify(agents)}`)
+    } else ok(`server.agents: ${agents.result.agents.map((a) => `${a.provider}${a.installed ? '' : ' (not installed)'}`).join(', ')}`)
     const wrong = await rpc('ping', {}, { Authorization: `Bearer ${'0'.repeat(64)}` })
     if (wrong.status !== 401) fail(`mcp wrong token: ${wrong.status}`)
     else ok('mcp wrong token: 401')
@@ -630,6 +690,13 @@ else ok('project persisted to the data dir')
 const deleted = await pc.req('project.delete', { projectId })
 if (!deleted.ok || existsSync(stored)) fail(`project.delete: ${JSON.stringify(deleted)}`)
 else ok('project.delete: removed from disk')
+{
+  const ended = pc.frames.findIndex((f) => f.type === 'event' && f.event === 'topic.ended' && f.payload.topic === `project:${projectId}`)
+  const endFrame = pc.frames[ended]
+  if (ended < 0 || endFrame.payload.reason !== 'deleted' || ended > pc.frames.indexOf(deleted) || deleted.rev?.topic !== 'server') {
+    fail(`topic.ended: ${JSON.stringify(endFrame)} at ${ended}, response ${JSON.stringify(deleted)}`)
+  } else ok('project.delete: topic.ended "deleted" before the response, which reports the server topic rev')
+}
 if (existsSync(mcpConfigPath)) fail(`project.delete left its MCP config file: ${mcpConfigPath}`)
 else ok('project.delete: MCP config file removed')
 srv = await nextPatch(pc, 'server', srv)
````

`installed` is asserted only for `claude` and `local`, whose commands are the smoke's own executable fake agents; whether `codex`, `gemini` or `grok` are on this machine's PATH is not the smoke's business.

- [ ] **Step 4: The client contract**

`project.create` now waits with `whenRev` on the rev its response named, and a new step deletes the project and expects `TOPIC_ENDED` on the project listener:

````diff
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -1,7 +1,8 @@
 // Contract smoke for the client SDK (src/shared/client/) against a real,
 // built trek-server: connect, mirror the server and project topics, create a
-// project, start a session and stream its pty, survive a reconnect, and reach
-// needs-auth with a wrong token. Uses only the SDK and the global WebSocket.
+// project and wait for its rev, start a session and stream its pty, survive a
+// reconnect, see a deleted project's topic end, and reach needs-auth with a
+// wrong token. Uses only the SDK and the global WebSocket.
 import { spawn, execFileSync } from 'node:child_process'
 import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { createServer } from 'node:net'
@@ -105,7 +106,7 @@ const mirror = new TopicMirror(conn)
 const ptys = new PtyStream(conn)
 conn.connect()
 if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
-if (!conn.welcome?.capabilities.includes('mcp')) fail(`welcome capabilities lack mcp: ${JSON.stringify(conn.welcome)}`)
+if (!['mcp', 'topicEnd'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
 else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)
 
 // --- 2. server topic ---
@@ -122,14 +123,24 @@ else ok('server topic: mirror lists the registered repo')
 
 // --- 3. project.create ---
 let projectId
+let createdRev
 try {
-  projectId = (await conn.request('project.create', { name: 'Contract', repositories: [{ path: repo }] })).projectId
+  const created = await conn.requestWithRev('project.create', { name: 'Contract', repositories: [{ path: repo }] })
+  projectId = created.result.projectId
+  createdRev = created.rev
 } catch (err) {
   abort(`project.create: ${err.code} ${err.message}`)
 }
-if (!(await waitFor(() => server.snapshot.projects.some((p) => p.id === projectId)))) {
-  fail(`server mirror lacks the new project: ${JSON.stringify(server.snapshot.projects)}`)
-} else ok(`project.create: ${projectId} appears in the server mirror`)
+if (createdRev?.topic !== 'server') abort(`project.create rev: ${JSON.stringify(createdRev)}`)
+try {
+  // whenRev resolves only once the mirror holds the rev the response named.
+  const state = await mirror.whenRev('server', createdRev.rev, { timeoutMs: WAIT_MS })
+  if (state.rev < createdRev.rev || !state.snapshot.projects.some((p) => p.id === projectId)) {
+    fail(`whenRev resolved early: rev ${state.rev} < ${createdRev.rev}, ${JSON.stringify(state.snapshot.projects)}`)
+  } else ok(`project.create: ${projectId} in the server mirror at rev ${state.rev} (response rev ${createdRev.rev})`)
+} catch (err) {
+  fail(`whenRev(server, ${createdRev.rev}): ${err.code} ${err.message}`)
+}
 
 // --- 4. project topic, session, pty ---
 const projectTopic = `project:${projectId}`
@@ -202,12 +213,23 @@ if (!(await waitFor(() => exitCode !== null, 6000))) fail('pty: no exit after th
 else ok(`pty: exit ${exitCode} delivered after the reattach`)
 if (ptyErrors.length) fail(`pty errors: ${ptyErrors.map(String).join('; ')}`)
 
-// --- 6. wrong token ---
+// --- 6. a deleted project's topic ends ---
+try {
+  const deleted = await conn.requestWithRev('project.delete', { projectId })
+  if (deleted.rev?.topic !== 'server') fail(`project.delete rev: ${JSON.stringify(deleted.rev)}`)
+} catch (err) {
+  fail(`project.delete: ${err.code} ${err.message}`)
+}
+if (!(await waitFor(() => projectError?.code === 'TOPIC_ENDED'))) fail(`project topic after delete: ${projectError?.code ?? 'no error'}`)
+else if (projectError.details?.reason !== 'deleted' || mirror.get(projectTopic) !== undefined) fail(`topic end: ${JSON.stringify(projectError.details)}`)
+else ok(`project.delete: the project mirror hears TOPIC_ENDED (${projectError.message})`)
+
+// --- 7. wrong token ---
 const bad = new ServerConnection({ url, token: 'wrong-token', createSocket: globalSocketFactory, client: 'contract-bad' })
 conns.push(bad)
 bad.connect()
 if (!(await waitFor(() => bad.status === 'needs-auth'))) fail(`wrong token: status ${bad.status} (${bad.statusMessage})`)
 else ok(`wrong token: needs-auth (${bad.statusMessage})`)
 
-// --- 7. clean up ---
+// --- 8. clean up ---
 finish()
````

- [ ] **Step 5: Run the smokes**

Run: `npm --prefix server run smoke 2>&1 | grep -E 'capabilities|response rev|dirty|decision|dequeue|server.agents|topic.ended|SMOKE'`

Expected (the server name and id, the rev, and which of codex, gemini and grok are installed vary):

```
ok: v2 welcome: server "<name>" <uuid>, capabilities mcp,topicEnd,decisions,dequeue,agents
ok: response rev: branch.setNote answered rev 1, after its patch
ok: response rev: a method that names no project carries none
ok: worktree.remove: a dirty worktree is GIT_ERROR with details.reason "dirty"
ok: mcp request_decision: the session carries the decision
ok: attention topic: lists the decision
ok: pty.write: user input answers the decision
ok: session.dequeue: removes the prompt it saw; a stale one is CONFLICT
ok: server.agents: claude, codex (not installed), gemini, grok (not installed), local
ok: project.delete: topic.ended "deleted" before the response, which reports the server topic rev
SERVER SMOKE PASS
```

`npm --prefix server run smoke 2>&1 | grep -c '^ok:'` prints `74` (65 before this task).

Run: `npm --prefix server run build && node server/scripts/smoke.mjs --built 2>&1 | tail -1`

Expected: `SERVER SMOKE PASS` (the bundled CLI too).

Run: `npm run smoke:client 2>&1 | grep -E '^ok|PASS|FAIL'`

Expected (ids vary):

```
ok: connected: server "<name>" <uuid>, capabilities mcp,topicEnd,decisions,dequeue,agents
ok: server topic: mirror lists the registered repo
ok: project.create: <id> in the server mirror at rev 1 (response rev 1)
ok: project topic: snapshot at rev 2 with main worktree <id>
ok: PtyStream: fake agent printed its --session-id launch args
ok: project mirror: session <id> listed (status working)
ok: reconnect: connecting > connected
ok: reconnect: project mirror resubscribed (rev 6)
ok: reconnect: PtyStream got onReset (text so far 263 chars) then replay with --session-id
ok: pty: exit 0 delivered after the reattach
ok: project.delete: the project mirror hears TOPIC_ENDED (project:<id> ended: deleted)
ok: wrong token: needs-auth (The server rejected the access token)
CLIENT CONTRACT PASS
```

(12 checks, 11 before; the revs and the character count vary from run to run).

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(server): settings compare-and-set check; the server smoke and smoke:client cover the 3c-3a additions" -m "Co-Authored-By: <model trailer>" -- scripts/client-contract.mjs scripts/serverV2.test.mjs server/scripts/smoke.mjs
```

---

### Task 10: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1187`, `# fail 0`: the baseline 1157 at `ed8bda9`, plus 3 (Task 1), 3 (Task 2), 5 (Task 3), 5 (Task 4), 6 (Task 5), 1 (Task 6), 1 (Task 7), 5 (Task 8) and 1 (Task 9). After the review fixes below: `# pass 1195`.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm --prefix server run typecheck && npm run build 2>&1 | tail -1 && npm --prefix server run build 2>&1 | tail -1`

Expected: clean typechecks; `✓ built in …`; `⚡ Done in …`.

- [ ] **Step 3: The server and SDK smokes**

```bash
npm --prefix server run smoke 2>&1 | tail -1   # SERVER SMOKE PASS (77 ok lines after the review fixes, 74 before)
npm run smoke:client 2>&1 | tail -1            # CLIENT CONTRACT PASS
```

- [ ] **Step 4: The app smokes, one at a time**

The app is unchanged, but `smoke:v2` drives the new server and the changed SDK (`connection.ts`, `mirror.ts`), and the start screen and Connect use the SDK too:

```bash
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (110 checks)
npm run smoke:windows 2>&1 | tail -1  # 40/40 checks passed
npm run smoke 2>&1 | tail -1          # SMOKE PASS
```

`smoke:v2`'s "a project deleted on the server says so, live" is the 3c-2 app meeting `topic.ended`: its project listener keeps the last view on the unknown `TOPIC_ENDED` error, and its `server` topic listener shows "Project not found" right after (Decision 21).

- [ ] **Step 5: The app is untouched**

Run: `git diff ed8bda9 --stat -- src/renderer src/main src/preload`

Expected: no output.

- [ ] **Step 6: Nothing left to commit**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Review fixes (done)

Applied after the Tasks 1–4 review and the final review. `npm test` goes from 1187 to 1195 (8 new tests); the server smoke from 74 to 77 `ok` lines; the client contract stays at 12 checks.

**SDK (`src/shared/client/mirror.ts`, `connection.ts`)**

1. **`whenRev` no longer trusts a stale state.** An entry carries `stale`, set when the connection leaves `connected` and cleared by the next reply to a subscribe. The immediate resolve needs `!entry.loading && !entry.stale`, which also covers the window between `connected` (emitted before the welcome listeners) and the welcome's resubscribe. Test: state at rev 80, a reconnect; `whenRev(5)` while down, from a `connected` status listener, and with the resubscribe in flight all stay pending until the new snapshot (rev 7).
2. **A held `NOT_FOUND`** rejects at once only under the same guard. Test: NOT_FOUND, reconnect, the waits resolve with the resubscribe's snapshot.
3. **`rev` is validated**: a non-integer or negative value rejects with `BAD_REQUEST`.
4. **A closed connection** rejects with `CLOSED` before the subscription check.
5. **Waiters settle before `notify`**, for snapshots and patches, so a listener that unsubscribes during notify does not turn a success into `UNSUBSCRIBED`. Test covers both paths.
6. **Null or non-object event payloads** are dropped before `onPatch`/`onEnded`; both also need a string `topic`. Test.
7. **`details`** keeps only a string `reason`, on the client (`connection.ts`) and the server (`toWireError`). Tests on both sides.
10. **`timeoutMs`: documented, no default.** The right bound is the caller's (a spinner, a background refresh), and every wait already ends on unsubscribe, close or `TOPIC_ENDED`; a default would either cut a slow legitimate wait or be too long to matter. `WhenRevOptions`, the `whenRev` doc comment and PROTOCOL.md say to always pass one.
- Test: `topic.ended` while `whenRev` waits on an in-flight subscribe rejects it with `TOPIC_ENDED`, and the late reply is ignored.

**Server**

8. **Dirty check**: `removeUnforced` runs one `git --no-optional-locks status --porcelain` (`hasChanges`, through `gitService.git`; no narrower helper existed) instead of `worktreeStatuses`, which also ran `rev-list`. An unreadable status sends no details. Test: a modified tracked file reads as `dirty`.
11. **`checkQuestion` collapses whitespace**: each run of whitespace (line breaks, tabs) becomes one space, then it is trimmed; any other control character left is `BAD_REQUEST` (`checkTitle`'s range). Collapsing rather than rejecting newlines, because agents naturally write multi-line questions and the app shows one line. PROTOCOL.md and the MCP tool's `question` description say so. Tests in the decisions test.
15. **`CommandProbe` runs at most 8 checks at once** (`MAX_PROBES_IN_FLIGHT`); a new program beyond that resolves `false` uncached, so the next call checks it. A program already in flight still shares its check. Test.
16. **`commandBinary`** documents that it is a best-effort hint (`env FOO=1 claude` gives `env`).
- **Server smoke**: an async handler's `res` (`worktree.create`) carries the project rev; the dirty `worktree.remove` error and v1 `res` frames carry none.

**Docs and smokes**

9, 12, 13, 14. PROTOCOL.md: `project.rename` reports the project topic's rev (wait on `server` without a rev for the project list); `server.agents` carries a rev only with a `projectId`, and a rev on a read is not a change; `server.agents`' `llmDefault` is always the server's, overridden by `settings.llmDefault` as for `session.start`; `session.restart` keeps an open decision (now also asserted in the decisions test).
17. `scripts/v2-smoke.mjs`: the exit text is polled with `until(...)`.
18. `scripts/client-contract.mjs`: the welcome must list all five capabilities.

## Notes for 3c-3b

Found while prototyping this plan.

1. **Decisions in the projector.** Map `Session.decision` to the store's `decisions[legacyId] = {terminalId, question, requestedAt: decision.at}`; DecisionIcon's and NotificationsMenu's dismiss become `session.dismissDecision` through a setter override for `clearDecision` (typed against `AppState`, like 3c-2's). `requestDecision` and `requestTerminalDecision` stay legacy-only (only the server's MCP sets a v2 decision). The OS notification and alert sound for a v2 decision belong to 3d's aggregator, not to each window.
2. **A decision clears on any input the server counts, a queued prompt included** (Decision 2). The desktop's own sessions keep their behaviour, where a paste does not clear it.
3. **`TOPIC_ENDED` → "not found"** in ServerProjectTree's project listener, and drop the `offServer` subscription when `welcome.capabilities` has `topicEnd`; keep it for older servers.
4. **`whenRev` instead of `whenProjected`**: `installV2.ts`'s request path becomes `requestWithRev`, and a method that must hand back what its patch brings awaits `mirror.whenRev(rev.topic, rev.rev)` before reading the store, falling back to today's `whenProjected` when the response has no `rev`. `leave()` should unsubscribe or otherwise end those waits as it ends `whenProjected`'s (a `whenRev` on a topic whose last listener leaves rejects `UNSUBSCRIBED`). The notes draft can settle on "mirror rev ≥ the save's rev" instead of comparing texts (Note 15).
5. **`details.reason === 'dirty'`** replaces `/modified or untracked/` in `worktrees.remove`, keeping the regex for servers that send no `details`.
6. **`removeQueuedText` through `session.dequeue {index, expected}`** when the server has `dequeue`; a `CONFLICT` there is worth no dialog (the queue the user sees is about to change anyway).
7. **`server.agents` is slow the first time** (a login shell per program, in parallel, up to the 10 s `commandExists` timeout). Fetch it once per window (or once per server in main) when the window opens, not when the menu opens, and keep the 3c-2 interim until it answers. `installed: false` should grey an item out, not hide it: the check reads the server user's login shell, which may differ from the agent's real environment.
8. **`ClientError.details` always exists as a property** (a class field), possibly `undefined`; test its value.
9. **3d reads `attention` entries in any status**: an entry with only a decision is `idle`, `working` or `exited`, with `since` = the decision's `at`. 3d should label it by `decision`, not by `status`.

From the reviews:

10. **Decisions.** Gate on the `decisions` capability. Map `Session.decision` from the project topic. DecisionIcon and NotificationsMenu dismiss with `session.dismissDecision {projectId, sessionId}`. Never clear a decision locally: any input the server counts clears it, a queued prompt included, and the patch says so. A restarted or exited session can still hold one. Display the question as-is: the server has collapsed it to one line with no control characters.
11. **Attention topic (3d).** `status` can be any value; entries may carry a `decision`; `since = decision.at` when the entry is listed only for its decision; label by decision first.
12. **Agents.** Gate on `agents`. Fetch once per window or server. Label Default with `settings.llmDefault ?? llmDefault` (`settings.globalLlm ?? llmDefault` for Global). Re-fetch after a `claudeCommand` edit, remembering each program's answer is cached for 60 s (an edit to a new program is checked at once; going back to one checked within the minute reuses that answer). Grey out agents that aren't installed instead of hiding them.
13. **Dequeue.** Gate on `dequeue`; send `{index, expected}`; a `CONFLICT` is silent.
14. **Revs.** A rev on a read is not a change. Always pass `timeoutMs` to `whenRev`.
15. **Settings.** Any `ProjectSettings` key can be guarded with `expected` (null means absent; arrays are compared by order). The server's `llm` section stays file-only, so keep the "edit the server config" hint.

## Risks

1. **The rev on queries.** Reads that name a project carry the rev they read at (Decision 14). It is accurate but not useful; a client must not take it as "this read changed something".
2. **An in-flight subscribe does not settle `whenRev` by itself** (Decision 15). If the server restarts while that subscribe is in flight, it fails with `NOT_CONNECTED`, and the welcome's resubscribe (a later attempt) settles the wait. A wait with no `timeoutMs` on a topic that never moves again and never resubscribes waits until the topic ends, the connection closes or its last listener leaves; 3c-3b should pass a `timeoutMs`.
3. **`dirty` is read after the refusal.** A worktree that is both locked and dirty reports `dirty`; the app's forced retry then fails on the lock and shows git's message. A worktree whose status cannot be read (the directory half-removed) reports no reason, and the app shows the plain error as today.
4. **`installed` is a hint.** It checks the server user's login shell (`$SHELL -lc 'command -v …'`), not the agent's launch (`$SHELL -ilc`, interactive); an alias defined only for interactive shells reads as not installed although the session would start. `session.start` remains the real test.
5. **Decisions are lost on a server restart** (runtime only, Decision 3), as statuses are. An agent resumed after a restart that is still waiting on its question shows no decision until it asks again.
6. **`MAX_QUESTION_LENGTH` is new.** The desktop's tool takes any length; an agent that sends a long question to the server gets `BAD_REQUEST` and has to shorten it (the tool's description says "at most 1000 characters"). The limit applies after whitespace runs collapse to one space; a question with another control character (an escape sequence) is refused.
7. **`topic.ended` covers only deletion.** `TopicHub.drop` has no other caller today; a future drop with another reason must extend `TopicEndReason`, and old SDKs read an unknown reason as an end anyway (`TOPIC_ENDED`, message `… ended: <reason>`).
8. **The capability list is static except `mcp`.** A server that loses a feature at runtime other than MCP has no way to say so; none can today.
