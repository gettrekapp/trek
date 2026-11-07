# Project bot: OS sandbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The OS itself stops the project bot from reading or changing Trek's userData, and the bot's MCP token stops being a way around its policy:
1. **Every bot turn runs inside an OS sandbox** that hides userData from the whole `claude` process tree (the CLI, its Read/Edit/Write tools, hooks, plugins, MCP stdio servers and every shell): `sandbox-exec` with a Trek-generated profile on macOS, `bwrap` on Linux. Windows has no sandbox, so the bot refuses to run there. The sandbox is mandatory: if it can't be built, or its canary probe fails at start, the bot does not run.
2. **No MCP config file for the bot.** `--mcp-config` is inline JSON naming `${TREK_BOT_TOKEN}`, which the CLI fills in from its environment. `mcp-bot-<n>.json` is never written again; older ones are still swept at start.
3. **Trek's MCP server enforces the bot's policy itself.** A bot token's `tools/call` runs the same `decide` the hook runs, on the server, so a shell that `curl`s the server with `$TREK_BOT_TOKEN` gains nothing. Approved calls still work, once.
4. **`start_session`, `send_prompt` and `send_keys` always need approval** when the bot calls them, whatever `POLICY.json` says; the server enforces it through item 3.

**Architecture:**
- **One pure module for the sandbox, `src/host/bot/sandbox.ts`.** `sandboxFor(platform, realUserData)` returns `{ command, args }` (a prefix for the CLI's argv) or a refusal reason. On macOS the profile is passed with `-p` and every path with `-D`, so no path is ever quoted into SBPL. `probeSandbox(sandbox, canary)` runs `/usr/bin/true` and a `cat` of a canary file in userData inside it, and says why the sandbox is unusable, or `null`. `insideUserData` tells whether a folder would be hidden by it.
- **`turnProcess.ts` spawns the sandbox, never the CLI directly.** `TurnOptions.sandbox` is required. `sandbox-exec` execs the CLI in place (same pid); `bwrap` stays as its parent in the same process group, so `detached` and the group kill keep working. A missing sandbox is a new `'sandbox'` outcome; a missing CLI inside it is still `'missing'`, recognised from `execvp`'s message. `botMcpConfig(port)` and `botSettings(port, deniedDirs)` (the hook, `Read`/`Edit` deny rules for userData, `sandbox.enabled: false`) are pure builders there.
- **`main/bot.ts` gates the bot.** `attach` builds the sandbox (refusing quietly on an unsupported platform, before consent); `startBot` writes a fresh canary to `userData/bot-sandbox-canary.txt` and probes before anything else, refuses a bot folder inside userData, and hands the sandbox to every turn. Repositories inside userData are left out of `--add-dir`.
- **Server-side policy instead of tickets (Decision 7).** `mcp.ts` asks a new `BotMcpHandlers.toolCall(windowId, name, args)` before running any bot `tools/call`; `bot.ts` answers with `runner.checkTool({ tool: 'mcp__trek-dev__<name>', input: args })`, which spends a matching approval. The PreToolUse hook answers `allow` for `mcp__trek-dev__*` without checking, so an approval is spent once, by the call it was for.
- **The policy hook stays for everything else** (Bash, Read, Write, …), which runs inside the OS sandbox anyway. `policy.ts` keeps its path checks as the second layer.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports), Electron 39 main, Node 22's `child_process`, macOS Seatbelt via `/usr/bin/sandbox-exec`, bubblewrap 0.8, Docker (for the Linux check), `node --test`, Playwright's Electron driver for `smoke:bot`, the fake CLI `scripts/fixtures/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-07-bot-os-sandbox.md` (the design spike: verified macOS findings, the profile, the inline `--mcp-config`, the token bypass). The bot's core design is `docs/superpowers/specs/2026-11-02-project-bot-core-design.md`.

---

## Decisions

### Recorded from the design discussion (user decisions)

1. **The sandbox is mandatory.** If it can't be applied, the turn (and the bot) is refused with a clear reason. There is no override, per project or otherwise.
2. **macOS: `sandbox-exec` around the whole `claude` process**, with a Trek-generated profile: allow by default; deny `file-read*` and `file-write*` on the real path of userData; deny `file-write-unlink` on every ancestor of userData up to `/`; deny LaunchServices with `mach-lookup` `global-name-regex "^com\.apple\.(lsd|coreservices|launchservices)"`. Claude Code's own sandbox stays off (it can't start inside an outer one). `Read`/`Edit` deny rules for userData go into `--settings` as a second layer.
3. **Linux is included**, with `bwrap --dev-bind / / --tmpfs <userData> --die-with-parent` (plus Decision 11), tested in a Linux container with Docker.
4. **Windows: the bot refuses to run**, with a clear message.
5. **A startup self-test**: a sandboxed probe must fail to read a userData canary file and must run `/usr/bin/true`. Otherwise the bot does not start.
6. **No more `mcp-bot-<n>.json` in userData.** `--mcp-config` is an inline JSON string with `"Authorization": "Bearer ${TREK_BOT_TOKEN}"`. The file writing goes; the sweep of old files stays.
7. **Server-side enforcement against the token bypass**, with approved calls still working. The mechanism is this plan's choice (Decision 13).
8. **`start_session`, `send_prompt` and `send_keys` always require approval** when the bot calls them, whatever the policy and overrides say, enforced on the server too.
9. **Out of scope**, kept as follow-ups: network restriction, and blocking Apple Events (`osascript`).

### Decided in this plan

**The sandbox (Tasks 4–8)**

10. **The macOS profile is inline (`-p`) with `-D` parameters**, never a file and never a quoted path. Writing a profile file would need a place outside userData that the bot can't change; `-p` needs none, and `ps` shows only paths, no secrets. Trek generates one `(literal (param "ANCn"))` per ancestor, nearest first, so the profile always matches the path's depth (no padding with `/`). `sandboxFor` refuses a path that is not absolute and normal (`/a//b`, `..`, a trailing `/`, `/` itself): the profile fails open on a spelling that is not the real path (spike, and re-verified here with `/var` → `/private/var`), so the caller passes `realpathSync(app.getPath('userData'))`.

    ```scheme
    (version 1)
    (allow default)
    ; Trek's userData: nothing in the bot's process tree may read or change it.
    (deny file-read* file-write* (subpath (param "USERDATA")))
    ; Renaming an ancestor would move userData out from under the rule above.
    (deny file-write-unlink (literal (param "ANC0")) (literal (param "ANC1")) ...)
    ; LaunchServices would start an app (one the bot wrote) outside this sandbox.
    (deny mach-lookup (global-name-regex #"^com\.apple\.(lsd|coreservices|launchservices)"))
    ```

11. **Linux adds `--unshare-pid --proc /proc` to the spike's argv**:
    `bwrap --dev-bind / / --tmpfs <userData> --unshare-pid --proc /proc --die-with-parent -- <claude …>`.
    The spike said to leave out `--unshare-pid` to keep the group kill working. The Docker prototype showed the opposite is needed: without a PID namespace, killing `bwrap` alone (`--die-with-parent` only kills its direct child) or a SIGTERM to the group left a background process running; with one, the kernel ends every process in the namespace when its first one exits, and Trek's group kill still reaches all of them. It also hides Trek's own processes, so `/proc/<trek pid>/root/<userData>` can't be tried (it was already `Permission denied` without it). There is still no `--new-session` (it would move the turn out of Trek's process group). `--disable-userns` is left out: it needs bwrap 0.8+ (Ubuntu 22.04 ships 0.6), and the prototype showed a nested user namespace can't unmount the tmpfs anyway (`umount`, `umount -l` and an `rbind` copy all failed: the mount is locked).
12. **The probe runs at every bot start, not every turn.** `runTurn` is synchronous and returns a handle the runner kills; a per-turn probe would make every turn async before it starts, and the sandbox can't change while a bot runs (it is built from the real path at attach). Each start (app launch, enable, Retry, a changed project) costs two short spawns. The canary is `userData/bot-sandbox-canary.txt` with a fresh random text each time, so a leak can't be confused with an old file. `/usr/bin/true` runs first, so a profile that doesn't compile (or a missing `bwrap`) is reported as such; then `/bin/sh -c 'cat -- "$1"'` must fail without printing the text. Reasons start "The bot's OS sandbox isn't working, so the bot won't run: …".
13. **Server-side policy, not tickets.** Two designs were weighed:
    - *Tickets*: `/bot/policy`'s `allow` mints a one-shot ticket keyed by `(tool, stable(input))` per bot token, with a short expiry, and the server's `tools/call` must consume one. The hook can't pass anything to the call (its output can't change the call's arguments in a way Trek controls), so the binding has to be by `(tool, args-hash)`. That makes every Trek tool depend on the CLI sending exactly the input the hook saw: any normalisation between the two (schema coercion, dropped `undefined`s, added defaults, a changed number format) in some future CLI silently refuses every Trek tool. It also adds state to keep in step with approvals (spent at the hook, before the ticket is used), an expiry to tune, and a second route (`/bot/policy`) whose answers mint capabilities.
    - *Server-side policy (chosen)*: the server runs `runner.checkTool` on every bot `tools/call` and refuses anything but `allow`, with the policy's own reason ("Needs approval. Call …request_approval…"). The hook answers `allow` for `mcp__trek-dev__*` without checking, so an approval is spent exactly once, by the call that reaches the server. One authority and no new state; nothing depends on argument identity; a direct `curl` meets the same checks as the CLI ("No bot turn is running", approvals, the always-ask set); and if the CLI ever silently drops `--settings` (spike prototype 2), Trek's tools are still checked. The cost is that a refusal reaches the model as a tool error rather than a hook denial; the text is the same.

    `request_approval` goes through the same gate (it is free, but now needs a running turn, as it did through the hook). `/bot/policy` keeps answering for the CLI's own tools; a bot that POSTs to it directly can only spend its own approvals.
14. **Where the delegation rule lives.** `ALWAYS_ASK_TOOLS` in `policy.ts`, checked in `tierOf` before the overrides, only for `mcp__trek-dev__` names. `start_session` and `send_prompt` leave `FREE_TOOLS`. An approved call still runs (approvals are matched before the tier). `enqueue_prompt` stays free: see Questions.
15. **Platform refusal is quiet; a failed probe is loud.** An unsupported platform never changes, and it can be the first thing a shared project shows on opening, so `attach` refuses with the no-alert view (`badCommandView`), before asking for consent. A failed probe (or a bot folder inside userData) is `errorView`, with the decision alert, like other start failures.
16. **Outcome kinds.** `ENOENT` when spawning means the sandbox command is missing: kind `'sandbox'`, "The bot's OS sandbox is not available: … was not found". The runner pauses on it like `'missing'` and doesn't count it. A missing CLI inside the sandbox can't be an `ENOENT` any more; `sandbox-exec` exits 71 with `sandbox-exec: execvp() of 'x' failed: No such file or directory`, and `bwrap` exits 1 with `bwrap: execvp x: No such file or directory` (both verified). A turn with no result whose stderr has that line is `'missing'`, with the same "no shell" hint as before.
17. **The second layer in `--settings`.** `permissions.deny` gets `Read(//<dir>/**)` and `Edit(//<dir>/**)` for the real path of userData and, if it differs, `app.getPath('userData')`'s spelling. `sandbox.enabled: false` is explicit, so a user's `~/.claude/settings.json` that turns Claude Code's sandbox on can't break every Bash call with `sandbox_apply` errors. A real `claude -p` (2.1.319, haiku) run under the generated profile with exactly these settings showed they are accepted, not silently dropped: the hook ran for every tool with the expanded token, `cat` of userData was refused by the permission rules ("Permission to use Bash with command cat …"), the Read tool got "File is in a directory that is denied by your permission settings", `python3` got `PermissionError` from the OS, and the inline MCP server connected and served `tools/call`.
18. **Folders inside userData.** `startBot` refuses a bot folder that is userData or inside it ("The bot's folder can't be inside Trek's data folder, which its sandbox hides: …"). A repository inside it is left out of `--add-dir` per turn (repositories can change without a restart). Comparisons use real paths, case-folded on macOS.

**The MCP config (Task 3)**

19. **`botMcpAccess` returns `{ token, port }` and writes nothing.** `botClients` hold no `configPath`; only session clients (`SessionClient`) do, and `releaseMcpWindow` removes only their files. `removeStaleConfigs` keeps its `mcp-(bot-|gemini-)?\d+` pattern for files older versions left, and `BOT_SECRET_FILES` keeps `mcp-*.json` (session and Gemini configs still live there).

**Tests (all tasks)**

20. **The smoke runs the fake CLI under the real sandbox.** `smoke:bot` never runs a real `claude`; it runs `scripts/fixtures/fake-claude.mjs` as the project's `claudeCommand`, so after Task 7 Trek spawns it through `sandbox-exec` like the real CLI. A `CANARY` turn reads `userData/bot-consent.json` three ways (`fs.readFileSync`, `sh -c cat`, a child `node -e`) and runs `/usr/bin/true`; the smoke asserts `canary:denied true:ran`. The fake reads the inline config and expands `${VAR}` from its environment as the CLI does, and writes `TREK_BOT_TOKEN` to a file outside userData so the smoke can make direct calls with it.
21. **The macOS integration test is a unit test file** (`scripts/botSandboxMac.test.mjs`, skipped elsewhere), so `npm test` proves the profile on every run on a Mac (about 5 s). Its LaunchServices case writes a background `.app` from inside the sandbox and opens it (refused, nothing runs), then opens the same app from outside as a control (it runs and reads the fake secret), so the check can't pass vacuously.
22. **The Linux check is a separate script**, `npm run test:bot-sandbox-linux` (`scripts/bot-sandbox-linux.mjs`), because it needs Docker. It builds a `node:22-bookworm-slim` image with `bubblewrap`, `python3` and `procps`, mounts the repo read-only, and runs `scripts/fixtures/bwrap-check.mjs` as an unprivileged user. It needs no `--privileged`: `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined` are enough for user namespaces and a fresh `/proc`. With no Docker it prints `SKIP: …` and exits 0.
23. **How the bot runs on Linux today.** `package.json`'s `build` has only a `mac` target (dmg, arm64), so there is no Linux package; Trek runs on Linux from source (`npm run dev` / `npm start`). Nothing else in the bot's path is mac-only: `turnProcess.ts` uses POSIX process groups, `policy.ts` folds case only on darwin/win32, and `/bin/sh` and `/usr/bin/true` exist on both. The Linux code path is the same `sandboxFor` → `runTurn` path as macOS, and its sandbox is tested in Docker, not by a Linux smoke.

---

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import. `src/host/bot/sandbox.ts` and `turnProcess.ts` import nothing from Electron.
  - `import type` lines are erased, so they may be extensionless.
- **Baseline:** 1321 tests pass at `4671b50`. Each task states the count it ends at; the plan ends at 1344.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`
  - `node scripts/bot-smoke.mjs` after a build (`npm run smoke:bot` builds first)
  - `npm run test:bot-sandbox-linux` (Docker)
  - `npm run smoke`, `npm run smoke:windows`, `npm run smoke:v2`, `npm run smoke:remote` (final task)
  - **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes.
- **Running one smoke after a build:** `node scripts/bot-smoke.mjs` (or `smoke.mjs`, `windows-smoke.mjs`, `v2-smoke.mjs`, `remote-smoke.mjs`) skips the rebuild when `npm run build` (and, for v2, `npm --prefix server run build`) already ran.
- **Branch:** `bot-os-sandbox`, at `4671b50` (the spike's commit).
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`. Every hunk was produced from a prototype of this plan built on `4671b50`, one commit per task, with each task's checks run on it.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.
- **`smoke:bot` totals:** 111 checks at `4671b50`; 119 after Task 2, 123 after Task 3, 124 after Task 7, 129 after Task 8.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/host/bot/policy.ts` | modify | 1 | `ALWAYS_ASK_TOOLS`; `start_session`, `send_prompt` leave `FREE_TOOLS` |
| `src/main/mcp.ts` | modify | 2, 3 | `BotMcpHandlers.toolCall`, the gate on bot `tools/call`; `botMcpAccess` writes no file, `SessionClient` |
| `src/main/bot.ts` | modify | 2, 3, 7, 8 | the hook leaves Trek tools to the server, `toolCall`; the inline config; `botSandbox`, the platform refusal, the sandbox for each turn; the canary probe, `botSettings`, folders inside userData |
| `src/host/bot/turnProcess.ts` | modify | 3, 7, 8 | `botMcpConfig`; `TurnOptions.sandbox`, the `'sandbox'` kind, a missing CLI inside the sandbox; `botSettings` |
| `src/host/bot/sandbox.ts` | create | 4, 5 | `sandboxFor`, `macProfile`, `ancestorsOf`, `insideUserData`; `probeSandbox` |
| `src/host/bot/runner.ts` | modify | 7 | `'sandbox'` pauses and is not counted |
| `src/main/botSecretFiles.ts` | modify | 9 | header: the OS sandbox is the primary layer |
| `package.json` | modify | 6 | `test:bot-sandbox-linux` |
| `scripts/botPolicy.test.mjs`, `botTurn.test.mjs`, `botRunner.test.mjs` | modify | 1, 3, 7, 8 | tests |
| `scripts/botSandbox.test.mjs` | create | 4 | the profile, the argv, refusals (pure) |
| `scripts/botSandboxMac.test.mjs` | create | 5 | `sandbox-exec` for real against a fake userData (macOS only) |
| `scripts/bot-sandbox-linux.mjs`, `scripts/fixtures/bwrap-check.mjs` | create | 6 | the Linux check in Docker |
| `scripts/fixtures/fake-claude.mjs` | modify | 2, 3, 7 | `ASKTOOL` and direct calls; the inline config; `CANARY` |
| `scripts/bot-smoke.mjs` | modify | 2, 3, 7, 8 | direct calls refused and approved; no config file; the canary under the sandbox; the settings; a folder inside userData |
| `docs/superpowers/specs/2026-11-02-project-bot-core-design.md`, `2026-11-07-bot-os-sandbox.md` | modify | 9 | the sandbox and the always-ask tier; the spike's outcome |

Nothing under `server/`, `src/renderer/` or `src/shared/` changes. The renderer already shows any `BotView` reason, so the refusals need no UI work.

---

### Task 1: Delegation always needs approval

`start_session`, `send_prompt` and `send_keys` hand work to a worktree session, which runs outside the bot's sandbox (a confused deputy). They move to an always-ask set that `POLICY.json` can't lift (Decision 14). Approvals still match before the tier, so an approved call runs once.

**Files:**
- Modify: `src/host/bot/policy.ts`
- Test: `scripts/botPolicy.test.mjs` (2 new tests, 1 changed)

- [ ] **Step 1: Write the failing tests**

The free-tools test loses `start_session` and `send_prompt`, and two tests cover the new set:

````diff
diff --git a/scripts/botPolicy.test.mjs b/scripts/botPolicy.test.mjs
index d93bc34..b60add0 100644
--- a/scripts/botPolicy.test.mjs
+++ b/scripts/botPolicy.test.mjs
@@ -15,7 +15,7 @@ const trek = (name) => `mcp__trek-dev__${name}`
 const bash = (command) => ({ tool: 'Bash', input: { command } })
 
 test('free Trek tools are allowed', () => {
-  for (const name of ['list_worktrees', 'start_session', 'send_prompt', 'create_worktree', 'start_stack', 'set_worktree_note', 'request_approval']) {
+  for (const name of ['list_worktrees', 'enqueue_prompt', 'create_worktree', 'start_stack', 'set_worktree_note', 'request_approval']) {
     assert.equal(decide({ tool: trek(name), input: {} }, ctx()).decision, 'allow', name)
   }
 })
@@ -80,6 +80,22 @@ test('overrides move items between free and ask', () => {
   assert.equal(decide(bash('git push origin x'), ctx({ overrides })).decision, 'allow')
 })
 
+test('delegating to a worktree session always needs approval, whatever the overrides say', () => {
+  const overrides = { free: ['start_session', 'send_prompt', 'send_keys'] }
+  for (const name of ['start_session', 'send_prompt', 'send_keys']) {
+    assert.equal(decide({ tool: trek(name), input: {} }, ctx()).decision, 'ask', name)
+    assert.equal(decide({ tool: trek(name), input: {} }, ctx({ overrides })).decision, 'ask', `${name} with a free override`)
+  }
+})
+
+test('an approved delegation is allowed once its approval matches', () => {
+  const input = { terminalId: 't1', prompt: 'run the tests' }
+  const approvals = [{ id: 'a9', tool: trek('send_prompt'), input, reason: 'r', requestedAt: 1, status: 'approved' }]
+  const result = decide({ tool: trek('send_prompt'), input }, ctx({ approvals }))
+  assert.deepEqual([result.decision, result.approvalId], ['allow', 'a9'])
+  assert.equal(decide({ tool: trek('send_prompt'), input: { ...input, prompt: 'other' } }, ctx({ approvals })).decision, 'ask')
+})
+
 test('overrides cannot lift the never tier', () => {
   const overrides = { free: ['bash:git push'] }
   assert.equal(decide(bash('git push --force'), ctx({ overrides })).decision, 'deny')
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/botPolicy.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected:

```
not ok 11 - delegating to a worktree session always needs approval, whatever the overrides say
not ok 12 - an approved delegation is allowed once its approval matches
# pass 65
# fail 2
```

- [ ] **Step 3: Implement**

````diff
diff --git a/src/host/bot/policy.ts b/src/host/bot/policy.ts
index 4d6a29f..1f7ea8f 100644
--- a/src/host/bot/policy.ts
+++ b/src/host/bot/policy.ts
@@ -33,13 +33,19 @@ const TREK_PREFIX = 'mcp__trek-dev__'
 const FREE_TOOLS = new Set([
   'Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList',
   'list_worktrees', 'get_selected_worktree', 'list_session_types',
-  'start_session', 'send_prompt', 'enqueue_prompt', 'remove_queued_prompt',
+  'enqueue_prompt', 'remove_queued_prompt',
   'read_terminal', 'wait_for_sessions', 'create_worktree', 'load_worktree',
   'get_stack', 'start_stack', 'stop_stack', 'read_stack_log',
   'set_worktree_tag', 'set_worktree_custom_tag', 'set_worktree_note',
   'set_worktree_ticket', 'set_worktree_pull_request', 'request_approval'
 ])
 
+/**
+ * Trek tools that hand work to a worktree session, which runs outside the bot's OS sandbox. They
+ * always need the user's approval: POLICY.json can't make them free.
+ */
+const ALWAYS_ASK_TOOLS = new Set(['start_session', 'send_prompt', 'send_keys'])
+
 const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
 const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'REPL'])
 
@@ -251,6 +257,7 @@ const stringsOf = (value: unknown): string[] =>
 
 function tierOf(call: ToolCall, ctx: PolicyContext): 'allow' | 'ask' {
   const name = call.tool.startsWith(TREK_PREFIX) ? call.tool.slice(TREK_PREFIX.length) : call.tool
+  if (call.tool.startsWith(TREK_PREFIX) && ALWAYS_ASK_TOOLS.has(name)) return 'ask'
   const free = stringsOf(ctx.overrides?.free)
   const ask = stringsOf(ctx.overrides?.ask)
   if (call.tool === 'Bash') {
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/botPolicy.test.mjs scripts/botRunner.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 160`, `# fail 0`.
Run: `npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1323`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): start_session, send_prompt and send_keys always need approval" -m "Co-Authored-By: <model trailer>" -- src/host/bot/policy.ts scripts/botPolicy.test.mjs
```

---

### Task 2: Trek's MCP server runs the bot's policy on every `tools/call`

The bot's token is in its environment, so its shell can call Trek's MCP server directly and skip the PreToolUse hook. After this task the server runs the policy itself for every bot `tools/call`, and the hook leaves `mcp__trek-dev__*` calls to it (Decision 13). The smoke proves both directions: a direct call of an ask-tier tool is refused with the policy's reason, and once the user approves it, the same direct call runs once.

**Files:**
- Modify: `src/main/mcp.ts` (`BotMcpHandlers.toolCall`, the gate)
- Modify: `src/main/bot.ts` (`hookAnswer`, the hook's pass-through for Trek tools, `toolCall`)
- Modify: `scripts/fixtures/fake-claude.mjs` (`callTool`, `ASKTOOL` and its approved wake)
- Test: `scripts/bot-smoke.mjs` (8 new checks)

- [ ] **Step 1: Write the failing smoke checks**

The fake CLI gets a way to call a Trek tool straight on the server, as a shell in the bot could. `ASKTOOL` calls `list_session_types` (put in the ask tier by a `POLICY.json` the smoke writes), then requests approval for it; the approved wake calls it twice:

````diff
diff --git a/scripts/fixtures/fake-claude.mjs b/scripts/fixtures/fake-claude.mjs
index 7556003..ba89022 100755
--- a/scripts/fixtures/fake-claude.mjs
+++ b/scripts/fixtures/fake-claude.mjs
@@ -36,6 +36,17 @@ const askPolicy = async (command) => {
   return (await res.json()).hookSpecificOutput.permissionDecision
 }
 
+/** Calls a Trek tool straight on the MCP server, as a shell in the bot could, and says whether it ran. */
+const callTool = async (name, args) => {
+  const server = mcp()
+  const res = await fetch(server.url, {
+    method: 'POST',
+    headers: { ...server.headers, 'Content-Type': 'application/json' },
+    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
+  })
+  return (await res.json()).result?.isError === false ? 'ran' : 'refused'
+}
+
 /** Starts a descendant holding this process's stdout, and records its pid for the test to clean up. */
 const descendant = (code, detached) => {
   const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'], detached })
@@ -81,6 +92,15 @@ if (wake.includes('HANG')) {
     })
   })
   finish()
+} else if (wake.includes('ASKTOOL')) {
+  // POLICY.json puts list_session_types in the ask tier for this.
+  say(`tool:${await callTool('list_session_types', {})}`)
+  await callTool('request_approval', { tool: 'mcp__trek-dev__list_session_types', input: {}, reason: 'smoke test' })
+  finish()
+} else if (wake.startsWith('An approval request has an answer. The user approved this exact call') && wake.includes('list_session_types')) {
+  say(`approved-tool:${await callTool('list_session_types', {})}`)
+  say(`approved-again:${await callTool('list_session_types', {})}`)
+  finish()
 } else if (wake.startsWith('An approval request has an answer. The user approved this exact call')) {
   // Worded by BotRunner.wakeForTurn and wakePrompt in src/host/bot.
   say(`policy:${await askPolicy('git push origin smoke')}`)
````

The smoke calls the server with the bot token outside a turn and inside the `GATED` turn, runs the real hook command for a Trek tool, and drives `ASKTOOL` through the Approve button:

````diff
diff --git a/scripts/bot-smoke.mjs b/scripts/bot-smoke.mjs
index d6e3e6e..fd74fa8 100644
--- a/scripts/bot-smoke.mjs
+++ b/scripts/bot-smoke.mjs
@@ -213,6 +213,7 @@ try {
     check('a session token cannot request approval', await callRefused(session, 'request_approval', approvalArgs), true)
     check('a session token cannot call bot_snapshot', await callRefused(session, 'bot_snapshot', {}), true)
     check('the bot token cannot call bot_snapshot', await callRefused(bot, 'bot_snapshot', {}), true)
+    check('with no turn running, a direct call with the bot token is refused', await callRefused(bot, 'list_worktrees', {}), true)
 
     // --- The real hook command, as the CLI would run it, during a real turn
     const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
@@ -235,6 +236,11 @@ try {
     check('the hook allows a free call', runHook(bot.token, 'Read', readCall), [0, 'allow'])
     check('the hook denies an ask-tier call', runHook(bot.token, 'Bash', { command: 'git push origin smoke' }), [0, 'deny'])
     check('the hook exits 2 on a bad token', runHook('nonsense', 'Read', readCall)[0], 2)
+    check('the hook leaves Trek tools to the MCP server', runHook(bot.token, 'mcp__trek-dev__close_session', { terminalId: 'x' }), [0, 'allow'])
+    check('a free Trek tool called directly runs', await callRefused(bot, 'list_worktrees', {}), false)
+    const direct = await rpc(bot, 'tools/call', { name: 'close_session', arguments: { terminalId: 'x' } })
+    check('an ask-tier Trek tool called directly is refused', [direct.result?.isError, /Needs approval/.test(direct.result?.content?.[0]?.text)], [true, true])
+    check('send_prompt called directly is refused', await callRefused(bot, 'send_prompt', { terminalId: 'x', prompt: 'cat secrets' }), true)
     writeFileSync(gate, '')
     check('the gated turn ends', await seen('ungated'), true)
     await win.locator('.bot-phase', { hasText: 'Idle' }).waitFor({ timeout: 15000 })
@@ -263,6 +269,15 @@ try {
       false
     )
 
+    // A Trek tool the policy asks about, called straight on the server, before and after approval.
+    writeFileSync(join(folder, 'POLICY.json'), JSON.stringify({ ask: ['list_session_types'] }))
+    await say('ASKTOOL')
+    check('an ask-tier call made directly is refused', await seen('tool:refused'), true)
+    await win.locator('.bot-approval button', { hasText: 'Approve' }).click()
+    check('once approved, the direct call runs', await seen('approved-tool:ran'), true)
+    check('and its approval is spent', await seen('approved-again:refused'), true)
+    rmSync(join(folder, 'POLICY.json'))
+
     await action('Pause').click()
     await action('Resume').waitFor({ timeout: 15000 })
     await say('while paused')
````

- [ ] **Step 2: Run the smoke to see it fail**

Run: `npm run build && node scripts/bot-smoke.mjs 2>&1 | grep -E '^FAIL|checks? (passed|failed)'`

Expected (today the server runs any bot call, and the hook denies an ask-tier Trek tool):

```
FAIL with no turn running, a direct call with the bot token is refused: false
FAIL the hook leaves Trek tools to the MCP server: [0,"deny"]
FAIL an ask-tier Trek tool called directly is refused: [true,false]
FAIL an ask-tier call made directly is refused: false
FAIL and its approval is spent: false
5 check(s) failed
```

(`close_session` with a made-up terminal already fails in the renderer, hence `[true,false]`: refused, but not by the policy.)

- [ ] **Step 3: Implement the gate in `mcp.ts`**

The unknown-tool check moves first, so a bot calling a tool that doesn't exist still gets `-32602`; then a bot client's call goes through `toolCall`, `request_approval` included:

````diff
diff --git a/src/main/mcp.ts b/src/main/mcp.ts
index e78cce4..4c8b146 100644
--- a/src/main/mcp.ts
+++ b/src/main/mcp.ts
@@ -390,6 +390,8 @@ const BOT_TOOLS = [
 
 export interface BotMcpHandlers {
   policy: (windowId: number, hookInput: Record<string, unknown>) => object
+  /** The bot's policy for a call that has reached this server. Anything but `allowed` is refused. */
+  toolCall: (windowId: number, name: string, args: Record<string, unknown>) => { allowed: boolean; reason: string }
   requestApproval: (windowId: number, args: Record<string, unknown>) => string
 }
 
@@ -480,6 +482,19 @@ async function handleMessage(msg: JsonRpcMessage, client: McpClient): Promise<ob
     case 'tools/call': {
       const name = msg.params?.name
       const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
+      const known = typeof name === 'string' && [...TOOLS, ...(client.bot ? BOT_TOOLS : [])].some((t) => t.name === name)
+      if (!known) return fail(-32602, `Unknown tool: ${String(name)}`)
+      // The bot's token is in its environment, so its shell can call this server directly. The
+      // policy runs here, on every call, so that skipping the CLI's hook gains nothing.
+      if (client.bot) {
+        let gate: { allowed: boolean; reason: string }
+        try {
+          gate = botHandlers!.toolCall(client.windowId, name, args)
+        } catch (err) {
+          gate = { allowed: false, reason: String(err) }
+        }
+        if (!gate.allowed) return reply({ content: [{ type: 'text', text: gate.reason }], isError: true })
+      }
       if (client.bot && BOT_TOOLS.some((t) => t.name === name)) {
         try {
           // The runner words this: end the turn, or run the call now if it is already approved.
@@ -489,9 +504,6 @@ async function handleMessage(msg: JsonRpcMessage, client: McpClient): Promise<ob
           return reply({ content: [{ type: 'text', text: String(err) }], isError: true })
         }
       }
-      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
-        return fail(-32602, `Unknown tool: ${String(name)}`)
-      }
       const response = await callRenderer(client, name, args)
       const text = response.ok
         ? JSON.stringify(response.result ?? null, null, 2)
````

- [ ] **Step 4: Answer it in `bot.ts`**

````diff
diff --git a/src/main/bot.ts b/src/main/bot.ts
index 3a056d2..e097ce7 100644
--- a/src/main/bot.ts
+++ b/src/main/bot.ts
@@ -294,27 +294,38 @@ async function attach(contents: WebContents, windowId: number, request: BotAttac
   }
 }
 
+const TREK_TOOL_PREFIX = 'mcp__trek-dev__'
+
+const hookAnswer = (allow: boolean, reason: string): object => ({
+  hookSpecificOutput: {
+    hookEventName: 'PreToolUse',
+    permissionDecision: allow ? 'allow' : 'deny',
+    permissionDecisionReason: reason
+  }
+})
+
 export function registerBotHandlers(): void {
   setBotMcpHandlers({
     // A throw reaches the 500 in startMcpServer, which blocks the tool, as does anything but allow here.
     policy: (windowId, hook) => {
+      const tool = String(hook.tool_name ?? '')
+      // Trek's own tools are checked once, by toolCall, when the call reaches the MCP server.
+      // Checking here as well would spend an approval before the call it was for.
+      if (tool.startsWith(TREK_TOOL_PREFIX)) return hookAnswer(true, 'Trek checks this call when it runs.')
       const bot = bots.get(windowId)
       const decision = bot
         ? bot.runner.checkTool(
-            {
-              tool: String(hook.tool_name ?? ''),
-              input: (hook.tool_input ?? {}) as Record<string, unknown>
-            },
+            { tool, input: (hook.tool_input ?? {}) as Record<string, unknown> },
             typeof hook.cwd === 'string' ? hook.cwd : undefined
           )
         : { decision: 'deny', reason: 'The bot is not running' }
-      return {
-        hookSpecificOutput: {
-          hookEventName: 'PreToolUse',
-          permissionDecision: decision.decision === 'allow' ? 'allow' : 'deny',
-          permissionDecisionReason: decision.reason
-        }
-      }
+      return hookAnswer(decision.decision === 'allow', decision.reason)
+    },
+    toolCall: (windowId, name, args) => {
+      const bot = bots.get(windowId)
+      if (!bot) return { allowed: false, reason: 'The bot is not running' }
+      const decision = bot.runner.checkTool({ tool: `${TREK_TOOL_PREFIX}${name}`, input: args })
+      return { allowed: decision.decision === 'allow', reason: decision.reason }
     },
     requestApproval: (windowId, args) => {
       const bot = bots.get(windowId)
````

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no errors.
Run: `npm run build && node scripts/bot-smoke.mjs 2>&1 | tail -1` → `All 119 checks passed`. The new lines include:

```
ok   with no turn running, a direct call with the bot token is refused: true
ok   the hook leaves Trek tools to the MCP server: [0,"allow"]
ok   a free Trek tool called directly runs: false
ok   an ask-tier Trek tool called directly is refused: [true,true]
ok   send_prompt called directly is refused: true
ok   an ask-tier call made directly is refused: true
ok   once approved, the direct call runs: true
ok   and its approval is spent: true
```

(`a free Trek tool called directly runs` prints `callRefused`, so `false` means it ran.)

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): Trek's MCP server runs the bot's policy on every tools/call" -m "Co-Authored-By: <model trailer>" -- src/main/mcp.ts src/main/bot.ts scripts/fixtures/fake-claude.mjs scripts/bot-smoke.mjs
```

---

### Task 3: Inline `--mcp-config`, with the token from the environment

Under the sandbox the CLI couldn't read `userData/mcp-bot-<n>.json`, and it shouldn't need a file at all (Decisions 6, 19). The config becomes inline JSON with `${TREK_BOT_TOKEN}`, which the CLI expands from its environment (verified in the spike for an inline string, and again in this plan's real run). The fake CLI does the same expansion, and hands the smoke the token through a file outside userData.

**Files:**
- Modify: `src/host/bot/turnProcess.ts` (`BOT_MCP_SERVER`, `botMcpConfig`)
- Modify: `src/main/mcp.ts` (`SessionClient`; `botMcpAccess` writes nothing; `releaseMcpWindow`)
- Modify: `src/main/bot.ts` (`mcpConfig: botMcpConfig(access.port)`)
- Modify: `scripts/fixtures/fake-claude.mjs` (inline config, `${VAR}` expansion, `FAKE_CLAUDE_TOKEN_FILE`)
- Test: `scripts/botTurn.test.mjs` (1 test), `scripts/bot-smoke.mjs` (5 new checks, 1 removed)

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/botTurn.test.mjs b/scripts/botTurn.test.mjs
index 6c81f96..805dc36 100644
--- a/scripts/botTurn.test.mjs
+++ b/scripts/botTurn.test.mjs
@@ -5,7 +5,7 @@ import { spawnSync } from 'node:child_process'
 import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join, resolve } from 'node:path'
-import { killAllTurnsNow, runTurn } from '../src/host/bot/turnProcess.ts'
+import { botMcpConfig, killAllTurnsNow, runTurn } from '../src/host/bot/turnProcess.ts'
 import { startHeartbeat } from '../src/host/bot/heartbeat.ts'
 
 const FAKE = resolve('scripts/fixtures/fake-claude.mjs')
@@ -47,6 +47,15 @@ test('passes the expected flags', async () => {
   assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--add-dir'), ['/a', '/b'])
 })
 
+test('the MCP config is inline and leaves the token to the environment', () => {
+  const config = botMcpConfig(4711)
+  assert.deepEqual(JSON.parse(config), {
+    mcpServers: {
+      'trek-dev': { type: 'http', url: 'http://127.0.0.1:4711/mcp', headers: { Authorization: 'Bearer ${TREK_BOT_TOKEN}' } }
+    }
+  })
+})
+
 test('resume uses --resume', async () => {
   const log = join(dir, 'resume.log')
   await run('hi', { resume: true, env: { FAKE_CLAUDE_LOG: log } }).handle.done
````

The smoke reads the bot's server from the inline config in the CLI's argv, and its token from the fake's file. It also leaves an old `mcp-bot-7.json` before the second launch, which the start-up sweep must remove:

````diff
diff --git a/scripts/bot-smoke.mjs b/scripts/bot-smoke.mjs
index fd74fa8..6ca38cc 100644
--- a/scripts/bot-smoke.mjs
+++ b/scripts/bot-smoke.mjs
@@ -25,6 +25,7 @@ const log = join(root, 'args.log')
 const pidFile = join(root, 'hang.pid')
 const gate = join(root, 'gate')
 const descendantPids = join(root, 'descendants.pids')
+const tokenFile = join(root, 'bot.token')
 const project = {
   version: 3,
   name: 'Smoke',
@@ -45,7 +46,8 @@ const startElectron = async ({ restore = false, dataDir = userData, argLog = log
     FAKE_CLAUDE_LOG: argLog,
     FAKE_CLAUDE_PID_FILE: pidFile,
     FAKE_CLAUDE_PIDS: descendantPids,
-    FAKE_CLAUDE_GATE: gate
+    FAKE_CLAUDE_GATE: gate,
+    FAKE_CLAUDE_TOKEN_FILE: tokenFile
   }
   if (restore) delete env.TREK_NO_WINDOW_RESTORE
   else env.TREK_NO_WINDOW_RESTORE = '1'
@@ -191,9 +193,12 @@ try {
 
     // --- The policy route
     const session = serverIn(await win.evaluate(() => window.api.getMcpConfigPath()))
-    const botConfig = readdirSync(userData).filter((n) => /^mcp-bot-\d+\.json$/.test(n))
-    check('one bot config', botConfig.length, 1)
-    const bot = serverIn(join(userData, botConfig[0]))
+    const botServer = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers['trek-dev']
+    check('the bot MCP config is inline, its token left to the environment', botServer.headers.Authorization, 'Bearer ${TREK_BOT_TOKEN}')
+    check('no bot MCP config file in userData', readdirSync(userData).filter((n) => n.startsWith('mcp-bot-')), [])
+    const bot = { url: botServer.url, token: readFileSync(tokenFile, 'utf8') }
+    check('the CLI got the bot token in its environment', /^[0-9a-f]{64}$/.test(bot.token), true)
+    check('the token is not in argv', argv.some((a) => a.includes(bot.token)), false)
     const call = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(folder, 'BOT.md') } })
     check('an unknown token is refused', (await post(session, 'nonsense', call)).status, 401)
     check('a session token is refused', (await post(session, session.token, call)).status, 403)
@@ -297,6 +302,8 @@ try {
 
   // --- Second run: restart recovery, a held folder, a missing folder, closing mid-turn
   {
+    // Left by an older version, which wrote the bot's MCP config to a file.
+    writeFileSync(join(userData, 'mcp-bot-7.json'), '{}')
     const { win, errors } = await launch()
     const { say, seen, queuedOne, action } = helpers(win)
     await win.evaluate(
@@ -306,6 +313,7 @@ try {
     )
     await showBot(win)
     check('still paused after a restart', await shown(win.locator('.bot-phase', { hasText: 'Paused' })), true)
+    check("an older version's bot MCP config is removed", existsSync(join(userData, 'mcp-bot-7.json')), false)
     check('queued message survives a restart', await queuedOne(), true)
     check('earlier activity is reloaded', await seen('echo:hello'), true)
     await action('Resume').click()
````

The fake reads the config inline:

````diff
diff --git a/scripts/fixtures/fake-claude.mjs b/scripts/fixtures/fake-claude.mjs
index ba89022..5d6a223 100755
--- a/scripts/fixtures/fake-claude.mjs
+++ b/scripts/fixtures/fake-claude.mjs
@@ -1,7 +1,7 @@
 #!/usr/bin/env node
 // Stands in for the Claude CLI in tests. The wake text picks the behaviour, or the whole prompt if it has no wake tags.
 import { spawn } from 'node:child_process'
-import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
+import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
 
 const argv = process.argv.slice(2)
 const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
@@ -25,7 +25,15 @@ if (arg('--resume') === 'bad') {
 
 emit({ type: 'system', subtype: 'init', session_id: sessionId })
 
-const mcp = () => Object.values(JSON.parse(readFileSync(arg('--mcp-config'), 'utf8')).mcpServers)[0]
+if (process.env.FAKE_CLAUDE_TOKEN_FILE) writeFileSync(process.env.FAKE_CLAUDE_TOKEN_FILE, process.env.TREK_BOT_TOKEN ?? '')
+
+/** The inline --mcp-config's one server, with ${VAR} filled in from the environment as the CLI does. */
+const mcp = () => {
+  const server = Object.values(JSON.parse(arg('--mcp-config')).mcpServers)[0]
+  const expand = (text) => text.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
+  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, expand(value)]))
+  return { ...server, url: expand(server.url), headers }
+}
 const askPolicy = async (command) => {
   const server = mcp()
   const res = await fetch(server.url.replace('/mcp', '/bot/policy'), {
````

- [ ] **Step 2: Run the unit test to see it fail**

Run: `node --test scripts/botTurn.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected:

```
# SyntaxError: The requested module '../src/host/bot/turnProcess.ts' does not provide an export named 'botMcpConfig'
# pass 0
# fail 1
```

- [ ] **Step 3: Implement `botMcpConfig`**

````diff
diff --git a/src/host/bot/turnProcess.ts b/src/host/bot/turnProcess.ts
index 872bc4d..083b541 100644
--- a/src/host/bot/turnProcess.ts
+++ b/src/host/bot/turnProcess.ts
@@ -44,6 +44,25 @@ const MAX_LINE = 64 * 1024 * 1024
 const MAX_TIMEOUT_MS = 2_147_483_647
 const DEFAULT_TIMEOUT_MS = 15 * 60_000
 
+/** The name Trek's MCP server has in the bot's config: its tools are `mcp__trek-dev__<name>`. */
+export const BOT_MCP_SERVER = 'trek-dev'
+
+/**
+ * The bot's `--mcp-config`, inline. The CLI expands `${TREK_BOT_TOKEN}` from its environment, so
+ * the token is in no file and not in argv (`ps` shows the placeholder).
+ */
+export function botMcpConfig(port: number): string {
+  return JSON.stringify({
+    mcpServers: {
+      [BOT_MCP_SERVER]: {
+        type: 'http',
+        url: `http://127.0.0.1:${port}/mcp`,
+        headers: { Authorization: 'Bearer ${TREK_BOT_TOKEN}' }
+      }
+    }
+  })
+}
+
 export function claudeArgs(options: TurnOptions): string[] {
   return [
     '-p',
````

- [ ] **Step 4: Stop writing the file in `mcp.ts`**

````diff
diff --git a/src/main/mcp.ts b/src/main/mcp.ts
index 4c8b146..88f710b 100644
--- a/src/main/mcp.ts
+++ b/src/main/mcp.ts
@@ -420,15 +420,22 @@ interface McpClient {
   windowId: number
   contents: WebContents
   token: string
+  bot: boolean
+}
+
+/** A window's sessions, which read their token from a config file in userData. */
+interface SessionClient extends McpClient {
   configPath: string
   written: Promise<void>
   /** The Gemini settings file, written on first non-Claude access */
   geminiWritten?: Promise<string>
-  bot: boolean
 }
 
-const clients = new Map<number, McpClient>()
-/** Bot turns get their own token, so bot-only routes and tools stay out of other sessions' reach. */
+const clients = new Map<number, SessionClient>()
+/**
+ * Bot turns get their own token, so bot-only routes and tools stay out of other sessions' reach.
+ * No file holds it: the bot's config is inline, and the CLI reads the token from its environment.
+ */
 const botClients = new Map<number, McpClient>()
 
 function callRenderer(
@@ -582,7 +589,10 @@ async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise
 
 let portPromise: Promise<number> | null = null
 
-/** Per-window config files don't outlive a launch; a crash can leave them behind. */
+/**
+ * Per-window config files don't outlive a launch; a crash can leave them behind. `mcp-bot-<id>.json`
+ * is no longer written (the bot's config is inline), but older versions left them.
+ */
 async function removeStaleConfigs(): Promise<void> {
   const dir = app.getPath('userData')
   const names = await readdir(dir)
@@ -686,12 +696,11 @@ async function accessFor(contents: WebContents): Promise<McpAccess> {
 }
 
 export interface BotMcpAccess {
-  configPath: string
   token: string
   port: number
 }
 
-/** Writes the bot's own --mcp-config for this window, once. */
+/** The bot's own token for this window, made once. Nothing is written: see botMcpConfig. */
 export async function botMcpAccess(contents: WebContents): Promise<BotMcpAccess> {
   portPromise ??= startMcpServer().catch((err) => {
     portPromise = null
@@ -701,30 +710,10 @@ export async function botMcpAccess(contents: WebContents): Promise<BotMcpAccess>
   // A window closed by now has been released, and nothing would release a new token.
   if (contents.isDestroyed()) throw new Error('The app window is not open')
   const existing = botClients.get(contents.id)
-  if (existing) {
-    await existing.written
-    return { configPath: existing.configPath, token: existing.token, port }
-  }
+  if (existing) return { token: existing.token, port }
   const token = randomBytes(32).toString('hex')
-  const configPath = join(app.getPath('userData'), `mcp-bot-${contents.id}.json`)
-  const config = {
-    mcpServers: {
-      [MCP_SERVER_NAME]: {
-        type: 'http',
-        url: `http://127.0.0.1:${port}/mcp`,
-        headers: { Authorization: `Bearer ${token}` }
-      }
-    }
-  }
-  const written = writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
-  botClients.set(contents.id, { windowId: contents.id, contents, token, configPath, written, bot: true })
-  try {
-    await written
-  } catch (err) {
-    botClients.delete(contents.id)
-    throw err
-  }
-  return { configPath, token, port }
+  botClients.set(contents.id, { windowId: contents.id, contents, token, bot: true })
+  return { token, port }
 }
 
 /** Reads the renderer's session state for the bot's change check. Not an MCP tool. */
@@ -745,12 +734,12 @@ export function releaseMcpWindow(windowId: number): void {
     clearTimeout(entry.timer)
     entry.resolve({ ok: false, error: 'The app window was closed' })
   }
-  for (const map of [clients, botClients]) {
-    const client = map.get(windowId)
-    if (!client) continue
-    map.delete(windowId)
-    void rm(client.configPath, { force: true }).catch((err) => console.error(err))
+  const session = clients.get(windowId)
+  if (session) {
+    clients.delete(windowId)
+    void rm(session.configPath, { force: true }).catch((err) => console.error(err))
   }
+  botClients.delete(windowId)
   void rm(join(app.getPath('userData'), `mcp-gemini-${windowId}.json`), { force: true }).catch(
     (err) => console.error(err)
   )
````

- [ ] **Step 5: Use it in `bot.ts`**

````diff
diff --git a/src/main/bot.ts b/src/main/bot.ts
index e097ce7..dfd6340 100644
--- a/src/main/bot.ts
+++ b/src/main/bot.ts
@@ -10,7 +10,7 @@ import {
   createBotFolder, defaultBotFolder, isDirectory, looksLikeBotFolder, readConfig, readEvents
 } from '../host/bot/memory.ts'
 import { BotRunner } from '../host/bot/runner.ts'
-import { killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
+import { botMcpConfig, killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
 import { isConsented, recordConsent } from './botConsent'
 import { BOT_SECRET_FILES } from './botSecretFiles'
 import { botMcpAccess, readBotSnapshot, releaseMcpWindow, setBotMcpHandlers, type BotMcpAccess } from './mcp'
@@ -185,7 +185,7 @@ function bind(
             systemPrompt: turn.systemPrompt,
             sessionId: turn.sessionId,
             resume: turn.resume,
-            mcpConfig: access.configPath,
+            mcpConfig: botMcpConfig(access.port),
             settings: hookSettings(access.port),
             addDirs: bound.attach.repoPaths.filter((p) => existsSync(p)),
             env: { TREK_BOT_TOKEN: access.token },
````

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → no errors. Run: `node --test scripts/botTurn.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 36`, `# fail 0`.
Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1324`, `# fail 0`.
Run: `npm run build && node scripts/bot-smoke.mjs 2>&1 | tail -1` → `All 123 checks passed`, with:

```
ok   the bot MCP config is inline, its token left to the environment: "Bearer ${TREK_BOT_TOKEN}"
ok   no bot MCP config file in userData: []
ok   the CLI got the bot token in its environment: true
ok   the token is not in argv: false
ok   an older version's bot MCP config is removed: false
```

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): inline --mcp-config with the token from the environment; no mcp-bot file" -m "Co-Authored-By: <model trailer>" -- src/main/mcp.ts src/main/bot.ts src/host/bot/turnProcess.ts scripts/fixtures/fake-claude.mjs scripts/bot-smoke.mjs scripts/botTurn.test.mjs
```

---

### Task 4: The sandbox's profile and argv (pure)

`sandboxFor(platform, realUserData)` builds the prefix for each platform, or a refusal (Decisions 2–4, 10, 11). `insideUserData` finds a folder the sandbox would hide (Decision 18). Nothing here spawns; Task 5 adds the probe.

**Files:**
- Create: `src/host/bot/sandbox.ts`
- Test: `scripts/botSandbox.test.mjs` (8 tests)

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/botSandbox.test.mjs b/scripts/botSandbox.test.mjs
new file mode 100644
index 0000000..a907345
--- /dev/null
+++ b/scripts/botSandbox.test.mjs
@@ -0,0 +1,87 @@
+// scripts/botSandbox.test.mjs — the bot's OS sandbox: profile, argv and refusals (pure).
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { ancestorsOf, insideUserData, macProfile, sandboxFor } from '../src/host/bot/sandbox.ts'
+
+const UD = "/Users/me/Library/Application Support/Trek Dev"
+
+test('ancestors run nearest first, up to the root', () => {
+  assert.deepEqual(ancestorsOf(UD), ['/Users/me/Library/Application Support', '/Users/me/Library', '/Users/me', '/Users', '/'])
+  assert.deepEqual(ancestorsOf('/a'), ['/'])
+  assert.deepEqual(ancestorsOf('/'), [])
+})
+
+test('the macOS profile denies userData, renaming each ancestor, and LaunchServices', () => {
+  assert.equal(
+    macProfile(2),
+    [
+      '(version 1)',
+      '(allow default)',
+      "; Trek's userData: nothing in the bot's process tree may read or change it.",
+      '(deny file-read* file-write* (subpath (param "USERDATA")))',
+      '; Renaming an ancestor would move userData out from under the rule above.',
+      '(deny file-write-unlink (literal (param "ANC0")) (literal (param "ANC1")))',
+      '; LaunchServices would start an app (one the bot wrote) outside this sandbox.',
+      '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(lsd|coreservices|launchservices)"))'
+    ].join('\n')
+  )
+})
+
+test('macOS: sandbox-exec with every path as a -D parameter, one per ancestor', () => {
+  const plan = sandboxFor('darwin', UD)
+  assert.equal(plan.ok, true)
+  const { command, args } = plan.sandbox
+  assert.equal(command, '/usr/bin/sandbox-exec')
+  assert.deepEqual(args.slice(0, -2), [
+    '-D', `USERDATA=${UD}`,
+    '-D', 'ANC0=/Users/me/Library/Application Support',
+    '-D', 'ANC1=/Users/me/Library',
+    '-D', 'ANC2=/Users/me',
+    '-D', 'ANC3=/Users',
+    '-D', 'ANC4=/'
+  ])
+  assert.deepEqual(args.slice(-2), ['-p', macProfile(5)])
+})
+
+test('macOS: quotes, parentheses and = in a path stay out of the profile text', () => {
+  const odd = `/tmp/it's "odd" (x)=y`
+  const { args } = sandboxFor('darwin', `${odd}/Trek`).sandbox
+  assert.equal(args[1], `USERDATA=${odd}/Trek`)
+  assert.equal(args[3], `ANC0=${odd}`)
+  assert.ok(!args.at(-1).includes('odd'))
+})
+
+test('Linux: bwrap with a tmpfs over userData, its own PID namespace and /proc, and no new session', () => {
+  const plan = sandboxFor('linux', '/home/me/.config/Trek Dev')
+  assert.deepEqual(plan, {
+    ok: true,
+    sandbox: {
+      command: 'bwrap',
+      args: ['--dev-bind', '/', '/', '--tmpfs', '/home/me/.config/Trek Dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--']
+    }
+  })
+  assert.ok(!plan.sandbox.args.includes('--new-session'))
+})
+
+test('Windows and other platforms are refused with a reason', () => {
+  assert.deepEqual(sandboxFor('win32', 'C:\\Users\\me\\AppData\\Roaming\\Trek'), {
+    ok: false,
+    reason: "The project bot needs an OS sandbox, which Windows doesn't provide. The bot runs on macOS and Linux."
+  })
+  assert.equal(sandboxFor('freebsd', '/home/me/.config/Trek').ok, false)
+  assert.match(sandboxFor('freebsd', '/home/me/.config/Trek').reason, /no OS sandbox for freebsd/)
+})
+
+test('a path that is not absolute and normal is refused, since the profile would fail open', () => {
+  for (const path of ['relative/Trek', '/a/../b/Trek', '/a//Trek', '/a/Trek/', '/']) {
+    assert.equal(sandboxFor('darwin', path).ok, false, path)
+    assert.equal(sandboxFor('linux', path).ok, false, path)
+  }
+})
+
+test('folders inside userData are found, case-folded on macOS', () => {
+  assert.equal(insideUserData('darwin', UD, ['/p/x.trekbot', `${UD}/bots/x.trekbot`]), `${UD}/bots/x.trekbot`)
+  assert.equal(insideUserData('darwin', UD, [UD.toUpperCase()]), UD.toUpperCase())
+  assert.equal(insideUserData('linux', '/home/me/.config/Trek', ['/home/me/.config/TREK/x']), null)
+  assert.equal(insideUserData('darwin', UD, [`${UD} Other/x`, '/Users/me/Library']), null)
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/botSandbox.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `src/host/bot/sandbox.ts`, then `# pass 0`, `# fail 1`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/host/bot/sandbox.ts b/src/host/bot/sandbox.ts
new file mode 100644
index 0000000..2715baa
--- /dev/null
+++ b/src/host/bot/sandbox.ts
@@ -0,0 +1,94 @@
+// The OS sandbox around each bot turn: nothing in the turn's process tree (the CLI, its tools,
+// hooks, MCP servers and every shell) can read or change Trek's userData. Pure.
+import { dirname, isAbsolute, normalize, relative, sep } from 'node:path'
+
+export interface Sandbox {
+  /** Runs in place of the CLI: `command`, then `args`, then the CLI's own argv. */
+  command: string
+  args: string[]
+}
+
+export type SandboxPlan = { ok: true; sandbox: Sandbox } | { ok: false; reason: string }
+
+export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
+export const BWRAP = 'bwrap'
+
+/** Each directory above `dir`, nearest first, up to the root. */
+export function ancestorsOf(dir: string): string[] {
+  const found: string[] = []
+  for (let at = dir, up = dirname(at); up !== at; at = up, up = dirname(at)) found.push(up)
+  return found
+}
+
+/**
+ * The Seatbelt profile, for `ancestors` (at least 1) ancestors of userData. Every path comes in as
+ * a `-D` parameter, so none is ever quoted into the profile's text.
+ */
+export function macProfile(ancestors: number): string {
+  const literals = Array.from({ length: ancestors }, (_, i) => `(literal (param "ANC${i}"))`).join(' ')
+  return [
+    '(version 1)',
+    '(allow default)',
+    "; Trek's userData: nothing in the bot's process tree may read or change it.",
+    '(deny file-read* file-write* (subpath (param "USERDATA")))',
+    '; Renaming an ancestor would move userData out from under the rule above.',
+    `(deny file-write-unlink ${literals})`,
+    '; LaunchServices would start an app (one the bot wrote) outside this sandbox.',
+    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(lsd|coreservices|launchservices)"))'
+  ].join('\n')
+}
+
+const WINDOWS_REASON = "The project bot needs an OS sandbox, which Windows doesn't provide. The bot runs on macOS and Linux."
+
+/**
+ * How to sandbox a turn on `platform`. `userData` must be the real path (realpathSync): a profile
+ * given another spelling of it protects nothing.
+ */
+export function sandboxFor(platform: NodeJS.Platform, userData: string): SandboxPlan {
+  if (platform === 'win32') return { ok: false, reason: WINDOWS_REASON }
+  if (platform !== 'darwin' && platform !== 'linux') {
+    return { ok: false, reason: `The project bot has no OS sandbox for ${platform}. The bot runs on macOS and Linux.` }
+  }
+  if (!isAbsolute(userData) || normalize(userData) !== userData || userData.endsWith(sep)) {
+    return { ok: false, reason: `Trek's data folder has no usable real path for the bot's sandbox: ${userData}` }
+  }
+  if (platform === 'linux') {
+    // A tmpfs over userData hides it from the whole mount namespace. The new PID namespace hides
+    // Trek's own processes (and their /proc/<pid>/root); when its first process exits, the kernel
+    // kills the rest. No --new-session, so Trek's process-group kill still reaches every process.
+    return {
+      ok: true,
+      sandbox: {
+        command: BWRAP,
+        args: ['--dev-bind', '/', '/', '--tmpfs', userData, '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--']
+      }
+    }
+  }
+  const ancestors = ancestorsOf(userData)
+  return {
+    ok: true,
+    sandbox: {
+      command: SANDBOX_EXEC,
+      args: [
+        '-D', `USERDATA=${userData}`,
+        ...ancestors.flatMap((dir, i) => ['-D', `ANC${i}=${dir}`]),
+        '-p', macProfile(ancestors.length)
+      ]
+    }
+  }
+}
+
+/**
+ * The first of `paths` that is userData or inside it, if any: such a folder would be unreadable
+ * to the bot, and putting it there is a mistake. All paths are real paths.
+ */
+export function insideUserData(platform: NodeJS.Platform, userData: string, paths: string[]): string | null {
+  const fold = (path: string): string => (platform === 'darwin' || platform === 'win32' ? path.toLowerCase() : path)
+  const root = fold(userData)
+  return (
+    paths.find((path) => {
+      const rel = relative(root, fold(path))
+      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
+    }) ?? null
+  )
+}
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/botSandbox.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 8`, `# fail 0`.
Run: `npm run typecheck` → no errors. `npm test` → `# pass 1332`.

- [ ] **Step 5: Commit**

```bash
git add src/host/bot/sandbox.ts scripts/botSandbox.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): the OS sandbox's macOS profile and bwrap argv (pure)" -m "Co-Authored-By: <model trailer>" -- src/host/bot/sandbox.ts scripts/botSandbox.test.mjs
```

---

### Task 5: The canary probe, and `sandbox-exec` for real on macOS

`probeSandbox` is the start-up self-test (Decisions 5, 12). The integration test runs `sandbox-exec` with the generated profile around `sh`, `python3` and `node` against a fake userData `…/Application Support/Trek Dev` (the space is deliberate), with no Claude CLI (Decision 21). It is skipped on other platforms.

**Files:**
- Modify: `src/host/bot/sandbox.ts` (`probeSandbox`)
- Test: `scripts/botSandboxMac.test.mjs` (8 tests)

- [ ] **Step 1: Write the failing test**

````diff
diff --git a/scripts/botSandboxMac.test.mjs b/scripts/botSandboxMac.test.mjs
new file mode 100644
index 0000000..608dab6
--- /dev/null
+++ b/scripts/botSandboxMac.test.mjs
@@ -0,0 +1,140 @@
+// scripts/botSandboxMac.test.mjs — the macOS sandbox for real: sandbox-exec with Trek's profile
+// around plain shells, python and node, against a fake userData. No Claude CLI. macOS only.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { spawnSync } from 'node:child_process'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { probeSandbox, sandboxFor, SANDBOX_EXEC } from '../src/host/bot/sandbox.ts'
+
+const skip = process.platform !== 'darwin' && 'macOS only'
+const SECRET = 'TOPSECRET-123'
+const root = skip ? '' : realpathSync(mkdtempSync(join(tmpdir(), 'bot-sandbox-')))
+const ancestor = join(root, 'Application Support')
+const userData = join(ancestor, 'Trek Dev')
+const secret = join(userData, 'server-tokens.json')
+const work = join(root, 'work')
+if (!skip) {
+  mkdirSync(userData, { recursive: true })
+  writeFileSync(secret, SECRET)
+  mkdirSync(work)
+  symlinkSync(secret, join(work, 'link.json'))
+}
+const sandbox = skip ? null : sandboxFor('darwin', userData).sandbox
+const hasPython = !skip && spawnSync('python3', ['-I', '-c', '1']).status === 0
+
+/** Runs `script` with /bin/sh inside the sandbox, in `work`. */
+const sh = (script) => {
+  const ran = spawnSync(sandbox.command, [...sandbox.args, '/bin/sh', '-c', script], { cwd: work, encoding: 'utf8', timeout: 20_000 })
+  return { status: ran.status, out: `${ran.stdout}${ran.stderr}` }
+}
+const DENIED = /Operation not permitted|PermissionError|EPERM/
+const expectDenied = (script) => {
+  const ran = sh(script)
+  assert.ok(!ran.out.includes(SECRET), `leaked: ${script}\n${ran.out}`)
+  assert.match(ran.out, DENIED, script)
+  assert.notEqual(ran.status, 0, script)
+}
+const waitFor = (path, ms) => {
+  const until = Date.now() + ms
+  while (!existsSync(path) && Date.now() < until) spawnSync('/bin/sleep', ['0.2'])
+  return existsSync(path)
+}
+
+test.after(() => {
+  if (root) rmSync(root, { recursive: true, force: true })
+})
+
+test('reads of userData are denied however the path is spelled', { skip }, () => {
+  for (const script of [
+    `cat "${secret}"`,
+    `cat "$(echo "${userData}")/server-tokens.json"`,
+    `d="${ancestor}"; cat "$d/Trek Dev/server-tokens.json"`,
+    'cat link.json',
+    `cat "${secret.toUpperCase()}"`,
+    `cd "${ancestor}" && cat "./Trek Dev/../Trek Dev/server-tokens.json"`,
+    `ls "${userData}"`,
+    `grep -R TOPSECRET "${ancestor}"`,
+    `cp -R "${userData}" copied`,
+    `tar cf - "${userData}" > /dev/null`,
+    `node -e "console.log(require('fs').readFileSync('${secret}', 'utf8'))"`
+  ]) {
+    expectDenied(script)
+  }
+})
+
+test('python is denied too', { skip: skip || (!hasPython && 'no python3') }, () => {
+  expectDenied(`python3 -I -c "print(open('${secret}').read())"`)
+})
+
+test('writes, moves and new links in userData are denied', { skip }, () => {
+  for (const script of [
+    `echo x > "${userData}/new.json"`,
+    `rm "${secret}"`,
+    `mv "${secret}" stolen.json`,
+    `ln "${secret}" hard.json`,
+    `node -e "require('fs').writeFileSync('${userData}/n.json', 'x')"`
+  ]) {
+    expectDenied(script)
+  }
+  assert.equal(readFileSync(secret, 'utf8'), SECRET)
+  assert.equal(existsSync(join(userData, 'new.json')), false)
+})
+
+test('an ancestor of userData cannot be renamed, but files in it still can be made and removed', { skip }, () => {
+  expectDenied(`mv "${ancestor}" "${root}/moved" && cat "${root}/moved/Trek Dev/server-tokens.json"`)
+  expectDenied(`mv "${root}" "${root}-moved"`)
+  assert.equal(existsSync(secret), true)
+  assert.equal(sh(`touch "${ancestor}/other" && mv "${ancestor}/other" "${ancestor}/other2" && rm "${ancestor}/other2"`).status, 0)
+})
+
+test('an app the bot writes cannot be opened through LaunchServices', { skip }, () => {
+  const app = join(work, 'Esc.app')
+  const escaped = join(work, 'escaped.txt')
+  const id = `com.trek.sandbox-test.${process.pid}`
+  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>esc</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>`
+  // Written from inside the sandbox, as the bot would.
+  const made = sh(
+    `mkdir -p Esc.app/Contents/MacOS && printf '%s' '${plist}' > Esc.app/Contents/Info.plist && ` +
+    `printf '#!/bin/sh\\ncat "%s" > "%s"\\n' "${secret}" "${escaped}" > Esc.app/Contents/MacOS/esc && chmod +x Esc.app/Contents/MacOS/esc && ` +
+    '/usr/bin/open ./Esc.app'
+  )
+  assert.notEqual(made.status, 0, made.out)
+  assert.equal(waitFor(escaped, 3000), false, 'the app ran')
+  // The same app opened from outside the sandbox does escape, so the check above means something.
+  assert.equal(spawnSync('/usr/bin/open', [app]).status, 0)
+  assert.equal(waitFor(escaped, 10_000), true)
+  assert.equal(readFileSync(escaped, 'utf8'), SECRET)
+})
+
+test('ordinary commands still work', { skip }, () => {
+  for (const script of [
+    '/usr/bin/true',
+    'git --version',
+    'echo ok > made.txt && cat made.txt && rm made.txt',
+    'node -e "console.log(1 + 1)"',
+    'ls ~ > /dev/null && ls / > /dev/null',
+    `ls "${ancestor}" > /dev/null`
+  ]) {
+    assert.equal(sh(script).status, 0, script)
+  }
+})
+
+test('the probe passes for the real sandbox', { skip }, async () => {
+  const canary = join(userData, 'bot-sandbox-canary.txt')
+  writeFileSync(canary, 'canary-abc')
+  assert.equal(await probeSandbox(sandbox, { path: canary, text: 'canary-abc' }), null)
+})
+
+test('the probe catches a sandbox that hides nothing, a non-canonical path, a missing command and a bad profile', { skip }, async () => {
+  const canary = { path: join(userData, 'bot-sandbox-canary.txt'), text: 'canary-abc' }
+  writeFileSync(canary.path, canary.text)
+  const open = { command: SANDBOX_EXEC, args: ['-p', '(version 1)(allow default)'] }
+  assert.match(await probeSandbox(open, canary), /a test read of Trek's data folder succeeded/)
+  // /var is a symlink to /private/var: the profile fails open on a spelling that isn't the real path.
+  const symlinked = sandboxFor('darwin', userData.replace(/^\/private\/var\//, '/var/')).sandbox
+  assert.match(await probeSandbox(symlinked, canary), /a test read of Trek's data folder succeeded/)
+  assert.match(await probeSandbox({ command: '/nope/sandbox-exec', args: [] }, canary), /\/nope\/sandbox-exec was not found/)
+  assert.match(await probeSandbox({ command: SANDBOX_EXEC, args: ['-p', '(version 1)(bogus'] }, canary), /a test command failed/)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/botSandboxMac.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected:

```
# SyntaxError: The requested module '../src/host/bot/sandbox.ts' does not provide an export named 'probeSandbox'
# pass 0
# fail 1
```

- [ ] **Step 3: Implement `probeSandbox`**

````diff
diff --git a/src/host/bot/sandbox.ts b/src/host/bot/sandbox.ts
index 2715baa..6255a9e 100644
--- a/src/host/bot/sandbox.ts
+++ b/src/host/bot/sandbox.ts
@@ -1,5 +1,7 @@
 // The OS sandbox around each bot turn: nothing in the turn's process tree (the CLI, its tools,
-// hooks, MCP servers and every shell) can read or change Trek's userData. Pure.
+// hooks, MCP servers and every shell) can read or change Trek's userData. Pure, apart from
+// probeSandbox, which runs the canary.
+import { spawn } from 'node:child_process'
 import { dirname, isAbsolute, normalize, relative, sep } from 'node:path'
 
 export interface Sandbox {
@@ -92,3 +94,56 @@ export function insideUserData(platform: NodeJS.Platform, userData: string, path
     }) ?? null
   )
 }
+
+const PROBE_TIMEOUT_MS = 10_000
+
+interface ProbeRun {
+  code: number | null
+  output: string
+  error?: NodeJS.ErrnoException
+}
+
+function runSandboxed(sandbox: Sandbox, argv: string[]): Promise<ProbeRun> {
+  return new Promise((resolve) => {
+    let output = ''
+    let child: ReturnType<typeof spawn>
+    try {
+      child = spawn(sandbox.command, [...sandbox.args, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
+    } catch (err) {
+      resolve({ code: null, output, error: err as NodeJS.ErrnoException })
+      return
+    }
+    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS)
+    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
+    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
+    child.on('error', (error: NodeJS.ErrnoException) => {
+      clearTimeout(timer)
+      resolve({ code: null, output, error })
+    })
+    child.on('close', (code) => {
+      clearTimeout(timer)
+      resolve({ code, output })
+    })
+  })
+}
+
+const PROBE_FAILED = "The bot's OS sandbox isn't working, so the bot won't run"
+
+/**
+ * Checks that `sandbox` works before any turn uses it: `/usr/bin/true` must run in it, and
+ * `canary` (a file in userData holding `text`) must not be readable from it. Returns why not, or null.
+ */
+export async function probeSandbox(sandbox: Sandbox, canary: { path: string; text: string }): Promise<string | null> {
+  const ran = await runSandboxed(sandbox, ['/usr/bin/true'])
+  if (ran.error) {
+    const missing = ran.error.code === 'ENOENT'
+    return `${PROBE_FAILED}: ${missing ? `${sandbox.command} was not found` : ran.error.message}`
+  }
+  if (ran.code !== 0) return `${PROBE_FAILED}: a test command failed (${ran.output.trim() || `exit ${ran.code}`})`
+  const read = await runSandboxed(sandbox, ['/bin/sh', '-c', 'cat -- "$1"', 'sh', canary.path])
+  if (read.error || read.code === null) return `${PROBE_FAILED}: the test read did not finish`
+  if (read.code === 0 || read.output.includes(canary.text)) {
+    return `${PROBE_FAILED}: a test read of Trek's data folder succeeded (${canary.path})`
+  }
+  return null
+}
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/botSandboxMac.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'` → `# pass 8`, `# fail 0`, in about 5 s. It shows, on macOS 26.2:
- `cat`, `$(…)`, a variable, a symlink, an upper-case spelling, `./x/../x`, `ls`, `grep -R`, `cp -R`, `tar`, `node -e` and `python3 -I -c` all get `Operation not permitted` / `PermissionError` / `EPERM` and never print the secret;
- writing, removing, moving and hard-linking inside userData are denied, and the file is unchanged;
- renaming the parent (`Application Support`) or the temp root is denied, while making, renaming and removing other files in the parent still works;
- a `.app` written inside the sandbox can't be opened (`open` fails, nothing runs), while the same app opened outside runs and reads the secret;
- `/usr/bin/true`, `git --version`, writes in the working directory, `node -e`, `ls ~` and `ls /` work;
- the probe passes for the real sandbox, and reports a profile that hides nothing, a `/var/…` spelling of a `/private/var/…` userData (fails open), a missing `sandbox-exec` and a profile that doesn't compile.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1340`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/botSandboxMac.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): sandbox canary probe; macOS sandbox-exec integration test" -m "Co-Authored-By: <model trailer>" -- src/host/bot/sandbox.ts scripts/botSandboxMac.test.mjs
```

---

### Task 6: The Linux sandbox, checked in Docker

The same checks for `bwrap`, in a Linux container (Decisions 3, 11, 22). The host script builds the image and runs the in-container check; the check imports `sandbox.ts` itself, so it tests the argv Trek will use. No Claude CLI.

**Files:**
- Create: `scripts/bot-sandbox-linux.mjs` (the host side; skips without Docker)
- Create: `scripts/fixtures/bwrap-check.mjs` (runs in the container)
- Modify: `package.json` (`test:bot-sandbox-linux`)

- [ ] **Step 1: Write the check**

````diff
diff --git a/scripts/fixtures/bwrap-check.mjs b/scripts/fixtures/bwrap-check.mjs
new file mode 100644
index 0000000..418d7c9
--- /dev/null
+++ b/scripts/fixtures/bwrap-check.mjs
@@ -0,0 +1,93 @@
+// Runs inside a Linux container (see scripts/bot-sandbox-linux.mjs): Trek's bwrap sandbox for real,
+// around plain shells, python and node, against a fake userData. No Claude CLI.
+import { spawn, spawnSync } from 'node:child_process'
+import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
+import { homedir } from 'node:os'
+import { join } from 'node:path'
+import { probeSandbox, sandboxFor } from '../../src/host/bot/sandbox.ts'
+
+const SECRET = 'TOPSECRET-123'
+const config = join(homedir(), '.config')
+mkdirSync(join(config, 'Trek Dev'), { recursive: true })
+const userData = realpathSync(join(config, 'Trek Dev'))
+const secret = join(userData, 'server-tokens.json')
+writeFileSync(secret, SECRET)
+const work = join(homedir(), 'work')
+mkdirSync(work, { recursive: true })
+if (!existsSync(join(work, 'link.json'))) symlinkSync(secret, join(work, 'link.json'))
+
+const results = []
+const check = (name, ok, detail = '') => {
+  results.push(ok)
+  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`)
+}
+const plan = sandboxFor('linux', userData)
+check('a plan for linux', plan.ok, JSON.stringify(plan))
+const { sandbox } = plan
+const sh = (script) => {
+  const ran = spawnSync(sandbox.command, [...sandbox.args, '/bin/sh', '-c', script], { cwd: work, encoding: 'utf8', timeout: 20_000 })
+  return { status: ran.status, out: `${ran.stdout}${ran.stderr}` }
+}
+const hidden = (name, script) => {
+  const ran = sh(script)
+  check(`hidden: ${name}`, !ran.out.includes(SECRET), ran.out)
+  return ran
+}
+
+const outside = spawnSync('/bin/sh', ['-c', `cat "${secret}"`], { encoding: 'utf8' })
+check('outside the sandbox the file is readable, so the checks below mean something', outside.stdout === SECRET, outside.stderr)
+hidden('cat', `cat "${secret}"`)
+hidden('$(…)', `cat "$(echo "${userData}")/server-tokens.json"`)
+hidden('a variable', `d="${config}"; cat "$d/Trek Dev/server-tokens.json"`)
+hidden('a symlink', 'cat link.json')
+hidden('.. in the path', `cd "${config}" && cat "./Trek Dev/../Trek Dev/server-tokens.json"`)
+hidden('python3 -c', `python3 -I -c "print(open('${secret}').read())"`)
+hidden('node -e', `node -e "console.log(require('fs').readFileSync('${secret}', 'utf8'))"`)
+hidden('grep -R', `grep -R TOPSECRET "${config}"`)
+hidden('cp -R', `cp -R "${userData}" copied; cat copied/*; rm -rf copied`)
+check('listing shows an empty folder', sh(`ls -A "${userData}"`).out.trim() === '')
+hidden("Trek's /proc/<pid>/root", `cat "/proc/${process.pid}/root${secret}"`)
+hidden('/proc/1/root', `cat "/proc/1/root${secret}"`)
+hidden('umount', `umount "${userData}" 2>&1; cat "${secret}"`)
+hidden('a nested user namespace', `unshare -Urm sh -c 'umount "${userData}"; cat "${secret}"' 2>&1`)
+hidden('a nested rbind', `unshare -Urm sh -c 'mkdir -p /tmp/y && mount --rbind "${config}" /tmp/y && umount "/tmp/y/Trek Dev"; cat "/tmp/y/Trek Dev/server-tokens.json"' 2>&1`)
+hidden('renaming an ancestor', `mv "${config}" "${config}2" && cat "${config}2/Trek Dev/server-tokens.json"; mv "${config}2" "${config}"`)
+check('the rename was put back', readFileSync(secret, 'utf8') === SECRET)
+sh(`echo x > "${userData}/new.json"`)
+check('a write lands in the tmpfs, not in userData', !existsSync(join(userData, 'new.json')))
+
+for (const script of ['/usr/bin/true', 'node -e "console.log(1 + 1)"', 'echo ok > made.txt && cat made.txt && rm made.txt', 'ls / > /dev/null', `ls "${config}" > /dev/null`, 'id -u']) {
+  const ran = sh(script)
+  check(`works: ${script}`, ran.status === 0, ran.out)
+}
+check('same user inside', sh('id -u').out.trim() === String(process.getuid()))
+
+const missing = spawnSync(sandbox.command, [...sandbox.args, '/nope/claude'], { encoding: 'utf8' })
+check('a missing CLI is reported by execvp', missing.status !== 0 && /execvp \/nope\/claude: No such file or directory/.test(missing.stderr), missing.stderr)
+
+const canary = { path: join(userData, 'bot-sandbox-canary.txt'), text: 'canary-abc' }
+writeFileSync(canary.path, canary.text)
+check('the probe passes', (await probeSandbox(sandbox, canary)) === null)
+const noTmpfs = { command: 'bwrap', args: ['--dev-bind', '/', '/', '--die-with-parent', '--'] }
+check('the probe catches a sandbox that hides nothing', /test read of Trek's data folder succeeded/.test(await probeSandbox(noTmpfs, canary)))
+check('the probe catches a missing bwrap', /was not found/.test(await probeSandbox({ ...sandbox, command: '/nope/bwrap' }, canary)))
+
+// Trek kills a turn's process group: SIGTERM, then SIGKILL after a grace. With the PID namespace,
+// SIGTERM alone ends everything, a process that ignores it too, since its namespace's first process exits.
+const sleepers = () => spawnSync('pgrep', ['-c', '-x', 'sleep'], { encoding: 'utf8' }).stdout.trim()
+const child = spawn(sandbox.command, [...sandbox.args, '/bin/sh', '-c', 'sleep 300 & (trap "" TERM; exec sleep 301) & wait'], { detached: true, stdio: 'ignore' })
+await new Promise((done) => setTimeout(done, 800))
+const before = sleepers()
+process.kill(-child.pid, 'SIGTERM')
+await new Promise((done) => setTimeout(done, 800))
+check('a turn starts its processes', before === '2', before)
+check('SIGTERM to the process group ends them all', sleepers() === '0', sleepers())
+const orphan = spawn(sandbox.command, [...sandbox.args, '/bin/sh', '-c', 'sleep 300 & wait'], { stdio: 'ignore' })
+await new Promise((done) => setTimeout(done, 800))
+process.kill(orphan.pid, 'SIGKILL')
+await new Promise((done) => setTimeout(done, 800))
+check('killing bwrap alone ends the turn (--die-with-parent)', sleepers() === '0', sleepers())
+
+const failed = results.filter((ok) => !ok).length
+console.log(failed ? `LINUX SANDBOX FAIL (${failed} of ${results.length})` : `LINUX SANDBOX PASS (${results.length} checks)`)
+process.exit(failed ? 1 : 0)
````

- [ ] **Step 2: Write the host script and its npm script**

````diff
diff --git a/scripts/bot-sandbox-linux.mjs b/scripts/bot-sandbox-linux.mjs
new file mode 100644
index 0000000..fe2b158
--- /dev/null
+++ b/scripts/bot-sandbox-linux.mjs
@@ -0,0 +1,32 @@
+// scripts/bot-sandbox-linux.mjs — runs the bot's Linux (bwrap) sandbox check in a Docker container.
+// Skips, and passes, when Docker isn't available.
+import { spawnSync } from 'node:child_process'
+import { resolve } from 'node:path'
+
+const IMAGE = 'trek-bot-sandbox-linux'
+const DOCKERFILE = `FROM node:22-bookworm-slim
+RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 procps && rm -rf /var/lib/apt/lists/*
+RUN useradd -m bot
+`
+
+const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
+if (docker.error || docker.status !== 0) {
+  console.log('SKIP: Docker is not available, so the Linux sandbox check did not run.')
+  process.exit(0)
+}
+const built = spawnSync('docker', ['build', '-q', '-t', IMAGE, '-'], { input: DOCKERFILE, stdio: ['pipe', 'ignore', 'inherit'] })
+if (built.status !== 0) {
+  console.log('FAIL: could not build the test image')
+  process.exit(1)
+}
+// User namespaces need these in Docker's default profile; bwrap runs as the unprivileged user `bot`.
+const ran = spawnSync(
+  'docker',
+  [
+    'run', '--rm', '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--security-opt', 'systempaths=unconfined',
+    '-u', 'bot', '-v', `${resolve('.')}:/trek:ro`, '-w', '/trek', IMAGE,
+    'node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/fixtures/bwrap-check.mjs'
+  ],
+  { stdio: 'inherit' }
+)
+process.exit(ran.status ?? 1)
````

````diff
diff --git a/package.json b/package.json
index cf737a5..5f13b51 100644
--- a/package.json
+++ b/package.json
@@ -11,6 +11,7 @@
     "start": "electron-vite preview",
     "typecheck": "tsc --noEmit",
     "test": "node --test scripts/*.test.mjs",
+    "test:bot-sandbox-linux": "node scripts/bot-sandbox-linux.mjs",
     "smoke:windows": "npm run build && node scripts/windows-smoke.mjs",
     "smoke:multi": "npm run build && node scripts/multi-repo-smoke.mjs",
     "smoke": "npm run build && node scripts/smoke.mjs",
````

- [ ] **Step 3: Run it**

Run: `npm run test:bot-sandbox-linux 2>&1 | tail -1`

Expected: `LINUX SANDBOX PASS (34 checks)`. The first run builds the image (a few minutes for `apt-get`); later runs take about 5 s. The checks show, on Docker 28.4 (arm64, bubblewrap 0.8.0, Debian bookworm):
- the control: outside the sandbox the fake secret is readable;
- `cat`, `$(…)`, a variable, a symlink, `..`, `python3 -I -c`, `node -e`, `grep -R` and `cp -R` never print it (the tmpfs is empty: `No such file or directory`), and `ls -A` shows an empty folder;
- `/proc/<trek pid>/root/…` and `/proc/1/root/…`, `umount`, a nested user namespace's `umount`, and a nested `rbind` copy never reach it;
- renaming `~/.config` inside the sandbox moves the tmpfs with it (still hidden), and the rename is put back; a write lands in the tmpfs, not in userData;
- `/usr/bin/true`, `node -e`, writes in the working directory, `ls /`, `ls ~/.config` and `id -u` work, as the same uid;
- a missing CLI is reported as `bwrap: execvp /nope/claude: No such file or directory`;
- the probe passes, and reports a `bwrap` with no tmpfs and a missing `bwrap`;
- SIGTERM to the turn's process group ends every process, one that ignores SIGTERM included, and killing `bwrap` alone ends them too.

- [ ] **Step 4: Check that the checks bite**

Temporarily remove `'--unshare-pid', '--proc', '/proc', ` from the Linux argv in `src/host/bot/sandbox.ts` and run `node scripts/bot-sandbox-linux.mjs | grep -E 'FAIL|PASS'`. Expected:

```
FAIL SIGTERM to the process group ends them all: 2
FAIL killing bwrap alone ends the turn (--die-with-parent): 3
LINUX SANDBOX FAIL (2 of 34)
```

Put the line back (`git checkout src/host/bot/sandbox.ts`).

Without Docker on `PATH` (e.g. `PATH=/usr/bin:/bin "$(which node)" scripts/bot-sandbox-linux.mjs`): `SKIP: Docker is not available, so the Linux sandbox check did not run.`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/bot-sandbox-linux.mjs scripts/fixtures/bwrap-check.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(bot): the Linux bwrap sandbox, checked in a Docker container" -m "Co-Authored-By: <model trailer>" -- package.json scripts/bot-sandbox-linux.mjs scripts/fixtures/bwrap-check.mjs
```

---

### Task 7: Every turn runs in the sandbox

`runTurn` spawns the sandbox with the CLI's argv after it, and there is no way to call it without one (Decisions 1, 16). `attach` builds the sandbox from the real path of userData, refusing quietly on Windows and other platforms (Decision 15), and every turn gets it. From here on the smoke's fake CLI runs under `sandbox-exec` (Decision 20).

**Files:**
- Modify: `src/host/bot/turnProcess.ts` (`TurnOptions.sandbox`, `'sandbox'`, `MISSING_IN_SANDBOX`)
- Modify: `src/host/bot/runner.ts` (`'sandbox'` is uncounted and pauses)
- Modify: `src/main/bot.ts` (`botSandbox`, the refusal in `attach`, the sandbox through `startBot` and `bind`)
- Modify: `scripts/fixtures/fake-claude.mjs` (`CANARY`)
- Test: `scripts/botTurn.test.mjs` (2 tests; every turn now runs in the real sandbox), `scripts/botRunner.test.mjs` (1 test), `scripts/bot-smoke.mjs` (1 check)

- [ ] **Step 1: Write the failing tests**

The fake CLI's `CANARY` mode:

````diff
diff --git a/scripts/fixtures/fake-claude.mjs b/scripts/fixtures/fake-claude.mjs
index 5d6a223..f028a2e 100755
--- a/scripts/fixtures/fake-claude.mjs
+++ b/scripts/fixtures/fake-claude.mjs
@@ -1,7 +1,7 @@
 #!/usr/bin/env node
 // Stands in for the Claude CLI in tests. The wake text picks the behaviour, or the whole prompt if it has no wake tags.
-import { spawn } from 'node:child_process'
-import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
 
 const argv = process.argv.slice(2)
 const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
@@ -100,6 +100,25 @@ if (wake.includes('HANG')) {
     })
   })
   finish()
+} else if (wake.includes('CANARY')) {
+  // Tries a file in Trek's data the ways a tool or shell in the bot could. The turn's sandbox must stop each one.
+  const target = process.env.FAKE_CLAUDE_SECRET
+  const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
+  const tries = [
+    () => readFileSync(target, 'utf8'),
+    () => execFileSync('/bin/sh', ['-c', 'cat "$1"', 'sh', target], quiet),
+    () => execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(target)}, 'utf8'))`], quiet)
+  ]
+  const leaks = tries.filter((read) => {
+    try {
+      read()
+      return true
+    } catch {
+      return false
+    }
+  }).length
+  say(`canary:${leaks ? `LEAKED ${leaks}` : 'denied'} true:${spawnSync('/usr/bin/true').status === 0 ? 'ran' : 'failed'}`)
+  finish()
 } else if (wake.includes('ASKTOOL')) {
   // POLICY.json puts list_session_types in the ask tier for this.
   say(`tool:${await callTool('list_session_types', {})}`)
````

Every `runTurn` in the turn tests gets `sandbox: SANDBOX`: the real macOS sandbox around a fake userData in the test's temp dir (`/usr/bin/env` stands in elsewhere, and the tests that need `sandbox-exec`'s message are skipped there):

````diff
diff --git a/scripts/botTurn.test.mjs b/scripts/botTurn.test.mjs
index 805dc36..70b41f6 100644
--- a/scripts/botTurn.test.mjs
+++ b/scripts/botTurn.test.mjs
@@ -2,14 +2,22 @@
 import test, { mock } from 'node:test'
 import assert from 'node:assert/strict'
 import { spawnSync } from 'node:child_process'
-import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
+import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join, resolve } from 'node:path'
 import { botMcpConfig, killAllTurnsNow, runTurn } from '../src/host/bot/turnProcess.ts'
 import { startHeartbeat } from '../src/host/bot/heartbeat.ts'
+import { sandboxFor } from '../src/host/bot/sandbox.ts'
 
 const FAKE = resolve('scripts/fixtures/fake-claude.mjs')
-const dir = mkdtempSync(join(tmpdir(), 'bot-turn-'))
+const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bot-turn-')))
+// Every turn runs in the real sandbox, around a fake userData. Elsewhere than macOS, env stands in for it.
+const userData = join(dir, 'user data')
+mkdirSync(userData)
+const SECRET = join(userData, 'server-tokens.json')
+writeFileSync(SECRET, 'TOPSECRET')
+const mac = process.platform === 'darwin'
+const SANDBOX = mac ? sandboxFor('darwin', userData).sandbox : { command: '/usr/bin/env', args: [] }
 const run = (prompt, extra = {}) => {
   const events = []
   const handle = runTurn({
@@ -24,6 +32,7 @@ const run = (prompt, extra = {}) => {
     addDirs: ['/a', '/b'],
     env: {},
     timeoutMs: 20_000,
+    sandbox: SANDBOX,
     ...extra
   }, (e) => events.push(e))
   return { handle, events }
@@ -71,7 +80,20 @@ test('classifies failed turns', async () => {
   assert.equal((await run('x', { sessionId: 'bad', resume: true }).handle.done).kind, 'resume')
 })
 
-test('a missing command reports missing', async () => {
+test('the CLI runs inside the sandbox: Trek\'s data is unreadable, other commands run', { skip: !mac && 'macOS only' }, async () => {
+  const { handle, events } = run('CANARY', { env: { FAKE_CLAUDE_SECRET: SECRET } })
+  assert.equal((await handle.done).kind, 'ok')
+  assert.deepEqual(events, [{ kind: 'text', text: 'canary:denied true:ran' }])
+  assert.equal(readFileSync(SECRET, 'utf8'), 'TOPSECRET')
+})
+
+test('a missing sandbox command is a sandbox outcome, not a missing CLI', async () => {
+  const outcome = await run('hello', { sandbox: { command: join(dir, 'no-sandbox-exec'), args: [] } }).handle.done
+  assert.equal(outcome.kind, 'sandbox')
+  assert.equal(outcome.text, `The bot's OS sandbox is not available: ${join(dir, 'no-sandbox-exec')} was not found`)
+})
+
+test('a missing command reports missing', { skip: !mac && 'needs sandbox-exec' }, async () => {
   assert.equal((await run('x', { command: [join(dir, 'nope')] }).handle.done).kind, 'missing')
 })
 
@@ -146,7 +168,7 @@ test('running out of file descriptors is an outcome, not a throw', () => {
     try { for (;;) held.push(openSync('/dev/null', 'r')) } catch {}
     const outcome = await runTurn({
       command: ['/usr/bin/true'], cwd: '/', prompt: 'x', systemPrompt: 'S', sessionId: 's', resume: false,
-      mcpConfig: 'm', settings: 's', addDirs: [], env: {}, timeoutMs: 5000
+      mcpConfig: 'm', settings: 's', addDirs: [], env: {}, timeoutMs: 5000, sandbox: ${JSON.stringify(SANDBOX)}
     }, () => {}).done
     for (const fd of held) closeSync(fd)
     await new Promise((r) => setTimeout(r, 50))
@@ -171,7 +193,7 @@ test('a throwing onEvent never escapes or loses the result, mid-stream or in the
     let calls = 0
     const handle = runTurn({
       command: [FAKE], cwd: dir, prompt, systemPrompt: 'S', sessionId: 's1', resume: false, mcpConfig: 'm',
-      settings: '{}', addDirs: [], env: {}, timeoutMs: 20_000
+      settings: '{}', addDirs: [], env: {}, timeoutMs: 20_000, sandbox: SANDBOX
     }, () => {
       calls++
       throw new Error('listener broke')
@@ -216,7 +238,7 @@ test('a stop still SIGKILLs descendants after settling', async (t) => {
   t.after(() => killAll(readPids(file)))
   const handle = runTurn({
     command: [FAKE], cwd: dir, prompt: 'STUBBORN', systemPrompt: 'S', sessionId: 's1', resume: false, mcpConfig: 'm',
-    settings: '{}', addDirs: [], env: { FAKE_CLAUDE_PIDS: file }, timeoutMs: 20_000
+    settings: '{}', addDirs: [], env: { FAKE_CLAUDE_PIDS: file }, timeoutMs: 20_000, sandbox: SANDBOX
   }, (event) => {
     if (event.text === 'ready') handle.kill()
   })
@@ -409,7 +431,7 @@ test('the fake reads its mode from the wake alone', async () => {
 const stubbornTurn = (file, onReady) => {
   const handle = runTurn({
     command: [FAKE], cwd: dir, prompt: 'STUBBORN', systemPrompt: 'S', sessionId: 's1', resume: false, mcpConfig: 'm',
-    settings: '{}', addDirs: [], env: { FAKE_CLAUDE_PIDS: file }, timeoutMs: 20_000
+    settings: '{}', addDirs: [], env: { FAKE_CLAUDE_PIDS: file }, timeoutMs: 20_000, sandbox: SANDBOX
   }, (event) => {
     if (event.text === 'ready') onReady(handle)
   })
@@ -449,7 +471,7 @@ test('killAllTurnsNow leaves finished turns alone', async (t) => {
   assert.equal(kill.mock.callCount(), 0)
 })
 
-test('a missing CLI explains that there is no shell', async () => {
+test('a missing CLI explains that there is no shell', { skip: !mac && 'needs sandbox-exec' }, async () => {
   const { handle } = run('hello', { command: ['FOO=bar', 'claude'] })
   const outcome = await handle.done
   assert.equal(outcome.kind, 'missing')
````

````diff
diff --git a/scripts/botRunner.test.mjs b/scripts/botRunner.test.mjs
index 811fc0f..c6a7cae 100644
--- a/scripts/botRunner.test.mjs
+++ b/scripts/botRunner.test.mjs
@@ -263,6 +263,18 @@ test('auth failure pauses straight away', async () => {
   assert.equal(loadState(t.folder).queue.length, 1)
 })
 
+test('a sandbox failure pauses straight away, keeps the chat and uses no turn', async () => {
+  const t = setup()
+  t.runner.start()
+  t.runner.send('msg')
+  await started(t, 1)
+  await t.finish({ kind: 'sandbox', text: "The bot's OS sandbox is not available: /usr/bin/sandbox-exec was not found" })
+  assert.equal(t.views.at(-1).phase, 'error')
+  assert.match(t.views.at(-1).reason, /OS sandbox is not available/)
+  assert.equal(loadState(t.folder).queue.length, 1)
+  assert.equal(loadState(t.folder).turnsToday, 0)
+})
+
 test('usage limit waits for the next heartbeat and is not a failure', async () => {
   const t = setup()
   t.runner.start()
````

````diff
diff --git a/scripts/bot-smoke.mjs b/scripts/bot-smoke.mjs
index 6ca38cc..e79a852 100644
--- a/scripts/bot-smoke.mjs
+++ b/scripts/bot-smoke.mjs
@@ -47,7 +47,9 @@ const startElectron = async ({ restore = false, dataDir = userData, argLog = log
     FAKE_CLAUDE_PID_FILE: pidFile,
     FAKE_CLAUDE_PIDS: descendantPids,
     FAKE_CLAUDE_GATE: gate,
-    FAKE_CLAUDE_TOKEN_FILE: tokenFile
+    FAKE_CLAUDE_TOKEN_FILE: tokenFile,
+    // A file in this run's userData, which the CANARY turn tries to read.
+    FAKE_CLAUDE_SECRET: join(dataDir, 'bot-consent.json')
   }
   if (restore) delete env.TREK_NO_WINDOW_RESTORE
   else env.TREK_NO_WINDOW_RESTORE = '1'
@@ -186,6 +188,8 @@ try {
 
     await say('hello')
     check('chat gets a reply', await seen('echo:hello'), true)
+    await say('CANARY')
+    check('the CLI runs in the OS sandbox: userData is unreadable, other commands run', await seen('canary:denied true:ran'), true)
     const argv = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0])
     check('strict MCP config', argv.includes('--strict-mcp-config'), true)
     check('hook settings passed', argv[argv.indexOf('--settings') + 1].includes('/bot/policy'), true)
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/botTurn.test.mjs scripts/botRunner.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected (the sandbox option is ignored, so the canary leaks and the missing sandbox is never spawned):

```
not ok - a sandbox failure pauses straight away, keeps the chat and uses no turn
not ok - the CLI runs inside the sandbox: Trek's data is unreadable, other commands run
not ok - a missing sandbox command is a sandbox outcome, not a missing CLI
# pass 129
# fail 3
```

- [ ] **Step 3: Spawn through the sandbox in `turnProcess.ts`**

````diff
diff --git a/src/host/bot/turnProcess.ts b/src/host/bot/turnProcess.ts
index 083b541..e4e9f71 100644
--- a/src/host/bot/turnProcess.ts
+++ b/src/host/bot/turnProcess.ts
@@ -3,6 +3,7 @@ import { existsSync } from 'node:fs'
 import { StringDecoder } from 'node:string_decoder'
 import type { BotEventKind } from '../../shared/bot'
 import { classifyFailure, parseStreamLine } from './events.ts'
+import type { Sandbox } from './sandbox'
 
 export interface TurnOptions {
   /** The command and any arguments from the project's claudeCommand. */
@@ -17,9 +18,11 @@ export interface TurnOptions {
   addDirs: string[]
   env: Record<string, string>
   timeoutMs: number
+  /** The OS sandbox the CLI runs in (sandboxFor). There is no way to run a turn without one. */
+  sandbox: Sandbox
 }
 
-export type TurnOutcomeKind = 'ok' | 'crash' | 'timeout' | 'auth' | 'limit' | 'resume' | 'missing' | 'killed'
+export type TurnOutcomeKind = 'ok' | 'crash' | 'timeout' | 'auth' | 'limit' | 'resume' | 'missing' | 'killed' | 'sandbox'
 
 export interface TurnOutcome {
   kind: TurnOutcomeKind
@@ -92,10 +95,16 @@ const finished = (ending: TurnEnding): TurnHandle => ({
 const ignore = (): void => {}
 const NO_SHELL = 'The bot runs this command directly, without a shell, so shell aliases and env prefixes do not work.'
 
-function spawnFailure(err: NodeJS.ErrnoException, bin: string, cwd: string): TurnEnding {
+/** What sandbox-exec and bwrap print when the command they were to run doesn't exist. */
+const MISSING_IN_SANDBOX = /^(?:sandbox-exec: execvp\(\) of '.*' failed|bwrap: execvp .*): No such file or directory$/m
+
+const missingCli = (bin: string): TurnEnding => ({ kind: 'missing', text: `Claude CLI not found: ${bin}. ${NO_SHELL}` })
+
+/** The process spawned is the sandbox, so ENOENT there means the sandbox itself is missing. */
+function spawnFailure(err: NodeJS.ErrnoException, sandbox: string, cwd: string): TurnEnding {
   if (err.code !== 'ENOENT') return { kind: 'crash', text: err.message }
   return existsSync(cwd)
-    ? { kind: 'missing', text: `Claude CLI not found: ${bin}. ${NO_SHELL}` }
+    ? { kind: 'sandbox', text: `The bot's OS sandbox is not available: ${sandbox} was not found` }
     : { kind: 'crash', text: `Working directory not found: ${cwd}` }
 }
 
@@ -105,17 +114,19 @@ export function runTurn(
 ): TurnHandle {
   const [bin, ...prefix] = options.command
   if (!bin) return finished({ kind: 'missing', text: 'Claude CLI not found: the command is empty' })
+  const { sandbox } = options
   let child: ChildProcess
   try {
     // detached gives the turn its own process group, so killing it reaches its children.
-    child = spawn(bin, [...prefix, ...claudeArgs(options)], {
+    // sandbox-exec execs the CLI in place; bwrap stays as its parent, in the same group.
+    child = spawn(sandbox.command, [...sandbox.args, bin, ...prefix, ...claudeArgs(options)], {
       cwd: options.cwd,
       env: { ...process.env, ...options.env },
       stdio: ['pipe', 'pipe', 'pipe'],
       detached: true
     })
   } catch (err) {
-    return finished(spawnFailure(err as NodeJS.ErrnoException, bin, options.cwd))
+    return finished(spawnFailure(err as NodeJS.ErrnoException, sandbox.command, options.cwd))
   }
   const { pid, stdin, stdout, stderr } = child
   if (!stdin || !stdout || !stderr) {
@@ -252,12 +263,13 @@ export function runTurn(
     }
     if (result && !result.isError) return settle({ kind: 'ok', text: result.text })
     if (stopReason) return settle({ kind: stopReason, text: `Turn ${stopReason === 'timeout' ? 'timed out' : 'stopped'}` })
+    if (!result && MISSING_IN_SANDBOX.test(stderrText)) return settle(missingCli(bin))
     const text = [result?.text, stderrText.trim()].filter(Boolean).join('\n') || 'Claude exited without a result'
     // stderr can quote paths and stack traces, so it only decides when the result says nothing.
     const failure = classifyFailure(result?.text || stderrText, result?.apiStatus ?? null)
     settle({ kind: failure === 'auth' || !limited ? failure : 'limit', text })
   }
-  child.on('error', (err: NodeJS.ErrnoException) => settle(spawnFailure(err, bin, options.cwd)))
+  child.on('error', (err: NodeJS.ErrnoException) => settle(spawnFailure(err, sandbox.command, options.cwd)))
   child.on('exit', startDrain)
   child.on('close', finish)
 
````

- [ ] **Step 4: Pause on `'sandbox'` in the runner**

````diff
diff --git a/src/host/bot/runner.ts b/src/host/bot/runner.ts
index fec80aa..c906e06 100644
--- a/src/host/bot/runner.ts
+++ b/src/host/bot/runner.ts
@@ -46,7 +46,7 @@ const isUserWake = (wake: Wake): boolean => wake.kind === 'chat' || wake.kind ==
 const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
 const preview = (text: string): string => text.replace(/\s+/g, ' ').slice(0, SUMMARY_CAP)
 /** Turns that spent no real work, or that the bot had no part in ending, don't use up the daily cap. */
-const UNCOUNTED: ReadonlySet<TurnOutcome['kind']> = new Set<TurnOutcome['kind']>(['limit', 'killed', 'missing', 'auth'])
+const UNCOUNTED: ReadonlySet<TurnOutcome['kind']> = new Set<TurnOutcome['kind']>(['limit', 'killed', 'missing', 'auth', 'sandbox'])
 
 const pendingText = (id: string): string =>
   `Requested approval ${id}. End your turn; the answer arrives in a later turn.`
@@ -467,7 +467,7 @@ export class BotRunner {
 
     if (outcome.kind === 'limit') {
       this.state.limited = true
-    } else if (outcome.kind === 'auth' || outcome.kind === 'missing') {
+    } else if (outcome.kind === 'auth' || outcome.kind === 'missing' || outcome.kind === 'sandbox') {
       this.pauseWith(summary)
     } else if (outcome.kind !== 'killed') {
       this.state.failures++
````

- [ ] **Step 5: Build the sandbox in `bot.ts`**

````diff
diff --git a/src/main/bot.ts b/src/main/bot.ts
index dfd6340..47aeedc 100644
--- a/src/main/bot.ts
+++ b/src/main/bot.ts
@@ -10,6 +10,7 @@ import {
   createBotFolder, defaultBotFolder, isDirectory, looksLikeBotFolder, readConfig, readEvents
 } from '../host/bot/memory.ts'
 import { BotRunner } from '../host/bot/runner.ts'
+import { sandboxFor, type Sandbox, type SandboxPlan } from '../host/bot/sandbox.ts'
 import { botMcpConfig, killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
 import { isConsented, recordConsent } from './botConsent'
 import { BOT_SECRET_FILES } from './botSecretFiles'
@@ -39,6 +40,17 @@ let quitting = false
 
 const secretPaths = (): string[] => BOT_SECRET_FILES.map((n) => join(app.getPath('userData'), n))
 
+/** The bot's OS sandbox on this machine, around the real path of userData. No sandbox, no bot. */
+function botSandbox(): SandboxPlan {
+  let userData: string
+  try {
+    userData = realpathSync(app.getPath('userData'))
+  } catch (err) {
+    return { ok: false, reason: `Trek's data folder could not be found for the bot's sandbox: ${(err as Error).message}` }
+  }
+  return sandboxFor(process.platform, userData)
+}
+
 function sendView(contents: WebContents, view: BotView): void {
   if (!contents.isDestroyed()) contents.send('bot:view', view)
 }
@@ -133,7 +145,10 @@ function inUseView(folder: string, reason: string): BotView {
   return { ...errorView(folder, reason), folderInUse: true }
 }
 
-/** No alert, like the consent view: this can be the first thing a shared project shows on opening. */
+/**
+ * No alert, like the consent view: this can be the first thing a shared project shows on opening.
+ * For a command that breaks the rule, and for a platform with no sandbox for the bot.
+ */
 function badCommandView(folder: string, reason: string): BotView {
   return { ...OFF_VIEW, phase: 'error', folder, reason }
 }
@@ -162,6 +177,7 @@ function bind(
   request: BotAttach,
   place: { key: string; folder: string; folderId: string },
   access: BotMcpAccess,
+  sandbox: Sandbox,
   releaseLock: () => void
 ): void {
   const { folder } = place
@@ -189,7 +205,8 @@ function bind(
             settings: hookSettings(access.port),
             addDirs: bound.attach.repoPaths.filter((p) => existsSync(p)),
             env: { TREK_BOT_TOKEN: access.token },
-            timeoutMs: turn.timeoutMs
+            timeoutMs: turn.timeoutMs,
+            sandbox
           },
           onEvent
         ),
@@ -224,7 +241,8 @@ async function startBot(
   windowId: number,
   request: BotAttach,
   key: string,
-  folder: string
+  folder: string,
+  sandbox: Sandbox
 ): Promise<void> {
   const access = await botMcpAccess(contents)
   const folderId = folderIdOf(folder)
@@ -248,7 +266,7 @@ async function startBot(
     return
   }
   try {
-    bind(contents, windowId, request, { key, folder, folderId }, access, lock.release)
+    bind(contents, windowId, request, { key, folder, folderId }, access, sandbox, lock.release)
   } catch (err) {
     lock.release()
     throw err
@@ -272,6 +290,13 @@ async function attach(contents: WebContents, windowId: number, request: BotAttac
     sendView(contents, badCommandView(folder, problem))
     return
   }
+  // Asked before consent, and without an alert, like a bad command: on Windows it never changes.
+  const plan = botSandbox()
+  if (!plan.ok) {
+    await teardown(windowId)
+    sendView(contents, badCommandView(folder, plan.reason))
+    return
+  }
   if (!(await isConsented(consentEntry(request.filePath, folder, request.claudeCommand)))) {
     await teardown(windowId)
     sendView(contents, consentView(folder, request.claudeCommand.trim()))
@@ -286,7 +311,7 @@ async function attach(contents: WebContents, windowId: number, request: BotAttac
   }
   await teardown(windowId)
   try {
-    await startBot(contents, windowId, request, key, folder)
+    await startBot(contents, windowId, request, key, folder, plan.sandbox)
   } catch (err) {
     const message = err instanceof Error ? err.message : String(err)
     sendView(contents, errorView(folder, `The bot could not start: ${message}`))
````

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → no errors.
Run: `node --test scripts/botTurn.test.mjs scripts/botRunner.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 132`, `# fail 0`. The existing kill, timeout, descendant and `killAllTurnsNow` tests now run through `sandbox-exec` too and still pass: it execs the CLI in place, so the group kill and the SIGKILL grace reach it unchanged.
Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1343`, `# fail 0`.
Run: `npm run build && node scripts/bot-smoke.mjs 2>&1 | grep -E 'OS sandbox|checks? (passed|failed)'` →

```
ok   the CLI runs in the OS sandbox: userData is unreadable, other commands run: true
All 124 checks passed
```

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): every turn runs in the OS sandbox; no sandbox, no bot" -m "Co-Authored-By: <model trailer>" -- src/host/bot/turnProcess.ts src/host/bot/runner.ts src/main/bot.ts scripts/fixtures/fake-claude.mjs scripts/botTurn.test.mjs scripts/botRunner.test.mjs scripts/bot-smoke.mjs
```

---

### Task 8: The canary at start, the second layer, and folders inside userData

`startBot` proves the sandbox before anything else (Decision 12), the turn's `--settings` gain the deny rules and `sandbox.enabled: false` (Decision 17), and a bot folder inside userData is refused while a repository there is left out of `--add-dir` (Decision 18). `hookSettings` moves out of `bot.ts` into the pure `botSettings`.

**Files:**
- Modify: `src/host/bot/turnProcess.ts` (`botSettings`)
- Modify: `src/main/bot.ts` (`BotSandbox`, `sandboxProblem`, `outsideUserData`; `hookSettings` goes)
- Test: `scripts/botTurn.test.mjs` (1 test), `scripts/bot-smoke.mjs` (5 checks)

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/botTurn.test.mjs b/scripts/botTurn.test.mjs
index 70b41f6..30cae67 100644
--- a/scripts/botTurn.test.mjs
+++ b/scripts/botTurn.test.mjs
@@ -5,7 +5,7 @@ import { spawnSync } from 'node:child_process'
 import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join, resolve } from 'node:path'
-import { botMcpConfig, killAllTurnsNow, runTurn } from '../src/host/bot/turnProcess.ts'
+import { botMcpConfig, botSettings, killAllTurnsNow, runTurn } from '../src/host/bot/turnProcess.ts'
 import { startHeartbeat } from '../src/host/bot/heartbeat.ts'
 import { sandboxFor } from '../src/host/bot/sandbox.ts'
 
@@ -65,6 +65,21 @@ test('the MCP config is inline and leaves the token to the environment', () => {
   })
 })
 
+test('the settings: the policy hook, deny rules for each spelling of the data folder, and no Claude Code sandbox', () => {
+  const ud = '/Users/me/Library/Application Support/Trek Dev'
+  const settings = JSON.parse(botSettings(4711, [ud, ud, '/link/Trek Dev']))
+  assert.deepEqual(settings.permissions, {
+    deny: [`Read(/${ud}/**)`, `Edit(/${ud}/**)`, 'Read(//link/Trek Dev/**)', 'Edit(//link/Trek Dev/**)']
+  })
+  assert.deepEqual(settings.sandbox, { enabled: false })
+  const [hook] = settings.hooks.PreToolUse
+  assert.equal(hook.matcher, '*')
+  assert.equal(
+    hook.hooks[0].command,
+    'curl -sS --fail --max-time 10 -X POST -H "Authorization: Bearer $TREK_BOT_TOKEN" --data-binary @- http://127.0.0.1:4711/bot/policy || exit 2'
+  )
+})
+
 test('resume uses --resume', async () => {
   const log = join(dir, 'resume.log')
   await run('hi', { resume: true, env: { FAKE_CLAUDE_LOG: log } }).handle.done
````

The smoke checks the real turn's settings and the canary file, and opens a project whose bot folder is inside userData:

````diff
diff --git a/scripts/bot-smoke.mjs b/scripts/bot-smoke.mjs
index e79a852..0304851 100644
--- a/scripts/bot-smoke.mjs
+++ b/scripts/bot-smoke.mjs
@@ -193,6 +193,10 @@ try {
     const argv = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0])
     check('strict MCP config', argv.includes('--strict-mcp-config'), true)
     check('hook settings passed', argv[argv.indexOf('--settings') + 1].includes('/bot/policy'), true)
+    const turnSettings = JSON.parse(argv[argv.indexOf('--settings') + 1])
+    check('the settings deny Read and Edit in userData', turnSettings.permissions.deny, [`Read(/${userData}/**)`, `Edit(/${userData}/**)`])
+    check("the settings turn Claude Code's own sandbox off", turnSettings.sandbox, { enabled: false })
+    check('the sandbox was proved with a canary in userData', existsSync(join(userData, 'bot-sandbox-canary.txt')), true)
     check('repo added', argv[argv.indexOf('--add-dir') + 1], repo)
 
     // --- The policy route
@@ -477,6 +481,21 @@ try {
     check('a relative command is refused with a reason', await shown(bad), true)
     const refused = await botView(win)
     check('that is not a question or an alert', [refused.needsConsent, refused.bound, refused.decision], [false, false, null])
+    // A bot folder the sandbox would hide is refused.
+    const insideFolder = join(userData, 'Inside.trekbot')
+    mkdirSync(insideFolder)
+    const inside = { ...project, name: 'Inside', bot: { enabled: true, folder: insideFolder } }
+    const insideFile = join(sharedDir, 'Inside.trekproj')
+    writeFileSync(insideFile, JSON.stringify(inside))
+    // This window already has a project, so opening another would go to a new window.
+    await win.evaluate(([p, f]) => window.__store.getState().setProject(p, f), [inside, insideFile])
+    await allow(win)
+    check(
+      'a bot folder inside userData is refused',
+      await shown(win.locator('.bot-reason', { hasText: "can't be inside Trek's data folder" })),
+      true
+    )
+    check('and nothing ran in it', readdirSync(insideFolder), [])
     check('no page errors in the shared project', errors, [])
     await app.close()
     app = null
````

- [ ] **Step 2: Run the unit test to see it fail**

Run: `node --test scripts/botTurn.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected:

```
# SyntaxError: The requested module '../src/host/bot/turnProcess.ts' does not provide an export named 'botSettings'
# pass 0
# fail 1
```

- [ ] **Step 3: Implement `botSettings`**

````diff
diff --git a/src/host/bot/turnProcess.ts b/src/host/bot/turnProcess.ts
index e4e9f71..4e643e1 100644
--- a/src/host/bot/turnProcess.ts
+++ b/src/host/bot/turnProcess.ts
@@ -66,6 +66,24 @@ export function botMcpConfig(port: number): string {
   })
 }
 
+/**
+ * The bot's `--settings`:
+ * - the policy hook, which blocks the tool if Trek can't answer (curl --fail, then exit 2);
+ * - `Read`/`Edit` deny rules for each of `deniedDirs`, so the model gets a clear denial for
+ *   Trek's data folder (the OS sandbox is what enforces it);
+ * - Claude Code's own sandbox off, since it can't start inside Trek's, whatever the user's settings say.
+ */
+export function botSettings(port: number, deniedDirs: string[]): string {
+  const command = `curl -sS --fail --max-time 10 -X POST -H "Authorization: Bearer $TREK_BOT_TOKEN" --data-binary @- http://127.0.0.1:${port}/bot/policy || exit 2`
+  // `//` starts an absolute path in a permission rule.
+  const deny = [...new Set(deniedDirs)].flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`])
+  return JSON.stringify({
+    permissions: { deny },
+    sandbox: { enabled: false },
+    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] }
+  })
+}
+
 export function claudeArgs(options: TurnOptions): string[] {
   return [
     '-p',
````

- [ ] **Step 4: Probe, deny and refuse in `bot.ts`**

The probe comes right after `botMcpAccess`, before the wait for a stopping runner, so nothing after the "Nothing below awaits" comment awaits:

````diff
diff --git a/src/main/bot.ts b/src/main/bot.ts
index 47aeedc..b259d15 100644
--- a/src/main/bot.ts
+++ b/src/main/bot.ts
@@ -1,6 +1,7 @@
 import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
 import { randomUUID } from 'node:crypto'
 import { existsSync, realpathSync } from 'node:fs'
+import { writeFile } from 'node:fs/promises'
 import { join, resolve } from 'node:path'
 import { OFF_VIEW, type BotAttach, type BotEvent, type BotView, type TrekSnapshot } from '../shared/bot'
 import { commandProblem, consentEntry } from '../host/bot/consent.ts'
@@ -10,8 +11,8 @@ import {
   createBotFolder, defaultBotFolder, isDirectory, looksLikeBotFolder, readConfig, readEvents
 } from '../host/bot/memory.ts'
 import { BotRunner } from '../host/bot/runner.ts'
-import { sandboxFor, type Sandbox, type SandboxPlan } from '../host/bot/sandbox.ts'
-import { botMcpConfig, killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
+import { insideUserData, probeSandbox, sandboxFor, type Sandbox } from '../host/bot/sandbox.ts'
+import { botMcpConfig, botSettings, killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
 import { isConsented, recordConsent } from './botConsent'
 import { BOT_SECRET_FILES } from './botSecretFiles'
 import { botMcpAccess, readBotSnapshot, releaseMcpWindow, setBotMcpHandlers, type BotMcpAccess } from './mcp'
@@ -40,17 +41,34 @@ let quitting = false
 
 const secretPaths = (): string[] => BOT_SECRET_FILES.map((n) => join(app.getPath('userData'), n))
 
-/** The bot's OS sandbox on this machine, around the real path of userData. No sandbox, no bot. */
-function botSandbox(): SandboxPlan {
+/** The bot's OS sandbox on this machine, and the real path of the userData it hides. */
+interface BotSandbox {
+  sandbox: Sandbox
+  userData: string
+}
+
+/** No sandbox, no bot. */
+function botSandbox(): ({ ok: true } & BotSandbox) | { ok: false; reason: string } {
   let userData: string
   try {
     userData = realpathSync(app.getPath('userData'))
   } catch (err) {
     return { ok: false, reason: `Trek's data folder could not be found for the bot's sandbox: ${(err as Error).message}` }
   }
-  return sandboxFor(process.platform, userData)
+  const plan = sandboxFor(process.platform, userData)
+  return plan.ok ? { ok: true, sandbox: plan.sandbox, userData } : plan
 }
 
+/** Proves the sandbox before a bot starts: a fresh canary in userData must be unreadable from it. */
+async function sandboxProblem(box: BotSandbox): Promise<string | null> {
+  const canary = { path: join(box.userData, 'bot-sandbox-canary.txt'), text: `canary-${randomUUID()}` }
+  await writeFile(canary.path, canary.text)
+  return probeSandbox(box.sandbox, canary)
+}
+
+const outsideUserData = (box: BotSandbox, path: string): boolean =>
+  insideUserData(process.platform, box.userData, [folderIdOf(path)]) === null
+
 function sendView(contents: WebContents, view: BotView): void {
   if (!contents.isDestroyed()) contents.send('bot:view', view)
 }
@@ -59,14 +77,6 @@ function sendEvent(contents: WebContents, event: BotEvent): void {
   if (!contents.isDestroyed()) contents.send('bot:event', event)
 }
 
-/** Blocks the tool if the app can't answer: curl --fail plus exit 2 fails closed. */
-function hookSettings(port: number): string {
-  const command = `curl -sS --fail --max-time 10 -X POST -H "Authorization: Bearer $TREK_BOT_TOKEN" --data-binary @- http://127.0.0.1:${port}/bot/policy || exit 2`
-  return JSON.stringify({
-    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] }
-  })
-}
-
 function folderIdOf(folder: string): string {
   try {
     return realpathSync(folder)
@@ -177,9 +187,11 @@ function bind(
   request: BotAttach,
   place: { key: string; folder: string; folderId: string },
   access: BotMcpAccess,
-  sandbox: Sandbox,
+  box: BotSandbox,
   releaseLock: () => void
 ): void {
+  // Both spellings, should app.getPath's differ from the real path.
+  const settings = botSettings(access.port, [box.userData, app.getPath('userData')])
   const { folder } = place
   const bound: BoundBot = {
     ...place,
@@ -202,11 +214,12 @@ function bind(
             sessionId: turn.sessionId,
             resume: turn.resume,
             mcpConfig: botMcpConfig(access.port),
-            settings: hookSettings(access.port),
-            addDirs: bound.attach.repoPaths.filter((p) => existsSync(p)),
+            settings,
+            // A repository the sandbox hides would only confuse the CLI.
+            addDirs: bound.attach.repoPaths.filter((p) => existsSync(p) && outsideUserData(box, p)),
             env: { TREK_BOT_TOKEN: access.token },
             timeoutMs: turn.timeoutMs,
-            sandbox
+            sandbox: box.sandbox
           },
           onEvent
         ),
@@ -242,9 +255,14 @@ async function startBot(
   request: BotAttach,
   key: string,
   folder: string,
-  sandbox: Sandbox
+  box: BotSandbox
 ): Promise<void> {
   const access = await botMcpAccess(contents)
+  const failed = await sandboxProblem(box)
+  if (failed) {
+    sendView(contents, errorView(folder, failed))
+    return
+  }
   const folderId = folderIdOf(folder)
   for (let done = stopping.get(folderId); done; done = stopping.get(folderId)) await done
   // Nothing below awaits until the bot is in `bots`, so another window can't claim the folder meanwhile.
@@ -253,6 +271,10 @@ async function startBot(
     sendView(contents, missingView(folder))
     return
   }
+  if (!outsideUserData(box, folder)) {
+    sendView(contents, errorView(folder, `The bot's folder can't be inside Trek's data folder, which its sandbox hides: ${folder}`))
+    return
+  }
   if ([...bots.values()].some((bot) => bot.folderId === folderId)) {
     sendView(contents, inUseView(folder, `Another window's bot is using this folder: ${folder}`))
     return
@@ -266,7 +288,7 @@ async function startBot(
     return
   }
   try {
-    bind(contents, windowId, request, { key, folder, folderId }, access, sandbox, lock.release)
+    bind(contents, windowId, request, { key, folder, folderId }, access, box, lock.release)
   } catch (err) {
     lock.release()
     throw err
@@ -311,7 +333,7 @@ async function attach(contents: WebContents, windowId: number, request: BotAttac
   }
   await teardown(windowId)
   try {
-    await startBot(contents, windowId, request, key, folder, plan.sandbox)
+    await startBot(contents, windowId, request, key, folder, plan)
   } catch (err) {
     const message = err instanceof Error ? err.message : String(err)
     sendView(contents, errorView(folder, `The bot could not start: ${message}`))
````

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no errors. Run: `node --test scripts/botTurn.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 39`, `# fail 0`.
Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1344`, `# fail 0`.
Run: `npm run build && node scripts/bot-smoke.mjs 2>&1 | grep -E 'userData|sandbox|inside|checks? (passed|failed)'` → includes

```
ok   the CLI runs in the OS sandbox: userData is unreadable, other commands run: true
ok   the settings deny Read and Edit in userData: ["Read(//private/var/folders/…/user-data/**)","Edit(//private/var/folders/…/user-data/**)"]
ok   the settings turn Claude Code's own sandbox off: {"enabled":false}
ok   the sandbox was proved with a canary in userData: true
ok   no bot MCP config file in userData: []
ok   a bot folder inside userData is refused: true
All 129 checks passed
```

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(bot): prove the sandbox with a canary at start; deny rules for userData; refuse folders inside it" -m "Co-Authored-By: <model trailer>" -- src/host/bot/turnProcess.ts src/main/bot.ts scripts/botTurn.test.mjs scripts/bot-smoke.mjs
```

---

### Task 9: Docs

The core design gets the sandbox, the inline config, the server-side check and the always-ask tier; the spike gets a pointer to this plan and its two departures; `botSecretFiles.ts` says which layer is which.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-project-bot-core-design.md`
- Modify: `docs/superpowers/specs/2026-11-07-bot-os-sandbox.md`
- Modify: `src/main/botSecretFiles.ts` (comments only)

- [ ] **Step 1: Edit**

````diff
diff --git a/docs/superpowers/specs/2026-11-02-project-bot-core-design.md b/docs/superpowers/specs/2026-11-02-project-bot-core-design.md
index a0139d0..d567e86 100644
--- a/docs/superpowers/specs/2026-11-02-project-bot-core-design.md
+++ b/docs/superpowers/specs/2026-11-02-project-bot-core-design.md
@@ -173,9 +173,14 @@ The starter `BOT.md` tells the bot:
 
 - Runs locally with `.trekbot/` as the working directory and `--add-dir` for each
   local repository, the same pattern as Global Claude.
-- Uses its own MCP token and config for `trek-dev` tools, separate from the window's
-  sessions, so that the policy route and `request_approval` are out of their reach.
-  Remote worktrees are reached through those tools only.
+- Uses its own MCP token for `trek-dev` tools, separate from the window's sessions, so
+  that the policy route and `request_approval` are out of their reach. The config is
+  passed inline and names `${TREK_BOT_TOKEN}`, which the CLI fills in from its
+  environment; no file holds it. Remote worktrees are reached through those tools only.
+- Runs inside an OS sandbox that hides Trek's userData from the whole process tree:
+  `sandbox-exec` on macOS, `bwrap` on Linux. Windows has none, so the bot doesn't run
+  there. Each start proves the sandbox with a canary file first, and refuses to run
+  without it. See `2026-11-07-bot-os-sandbox.md`.
 - Default timeout is 15 minutes. On timeout, the process tree is killed.
 - Default cap is 100 turns per local day. Once reached, heartbeats and reflection
   stop until the next day, while chat and approval decisions still run.
@@ -183,13 +188,16 @@ The starter `BOT.md` tells the bot:
 ## Autonomy tiers
 
 A `PreToolUse` hook sends each tool call to `Policy`, which allows or denies it.
-`POLICY.json` can move items between the free and ask tiers. The never tier is
-fixed.
+Trek's own tools are checked by Trek's MCP server instead, when the call arrives, so
+a bot that calls the server directly with its token meets the same policy.
+`POLICY.json` can move items between the free and ask tiers, except the delegation
+tools below. The never tier is fixed.
 
 | Tier | Behaviour | Defaults |
 |---|---|---|
-| Free | Allowed | Read files; write `HEARTBEAT.md`, `MEMORY.md`, `knowledge/`, `journal/`; start and prompt sessions; create worktrees; run stacks; set notes and tags |
+| Free | Allowed | Read files; write `HEARTBEAT.md`, `MEMORY.md`, `knowledge/`, `journal/`; queue prompts; create worktrees; run stacks; set notes and tags |
 | Ask | Denied until approved | `git push`, opening or merging PRs, closing sessions, unloading or deleting worktrees, promoting to primary, changing session types |
+| Always ask | Denied until approved, whatever `POLICY.json` says | `start_session`, `send_prompt`, `send_keys`: worktree sessions run outside the bot's sandbox |
 | Never | Always denied | Writing `BOT.md`, `POLICY.json`, `config.json` or `state/`; destroying the bot folder or an ancestor of it; force-push; reading or overwriting Trek's secret stores |
 
 Trek tools match by exact name, so that enforcement is firm. Shell commands match
````

````diff
diff --git a/docs/superpowers/specs/2026-11-07-bot-os-sandbox.md b/docs/superpowers/specs/2026-11-07-bot-os-sandbox.md
index 1758210..4bf76e9 100644
--- a/docs/superpowers/specs/2026-11-07-bot-os-sandbox.md
+++ b/docs/superpowers/specs/2026-11-07-bot-os-sandbox.md
@@ -13,6 +13,16 @@ around it with `$( )`, variables, `pushd`, `grep -r ~`, `find -exec cat`, `tar`,
 
 This is a spike. The prototypes were throwaway and have been deleted. Only this doc is committed.
 
+**Outcome.** The plan is `docs/superpowers/plans/2026-11-07-bot-os-sandbox.md`. It departs from
+this spike in two places, both checked by its prototype:
+
+- **Linux** adds `--unshare-pid --proc /proc`. Without a PID namespace, killing `bwrap` (or a
+  SIGTERM to the group) left a background process alive; with one, the kernel ends everything
+  when the namespace's first process exits. Trek's process-group kill still works.
+- **Tickets became server-side policy.** Trek's MCP server runs the bot's policy on every bot
+  `tools/call` itself, and the hook leaves `mcp__trek-dev__*` calls to it. There is no ticket to
+  match, so nothing depends on the CLI sending the exact input the hook saw.
+
 Environment for every prototype: macOS 26.2 (25C56), Apple silicon, Claude Code `2.1.319`
 (logged in with claude.ai auth), `--model haiku`. Every prototype used a dummy "secret" directory
 under the session scratchpad. In the outputs below `$S` stands for that directory.
````

````diff
diff --git a/src/main/botSecretFiles.ts b/src/main/botSecretFiles.ts
index 5ef0651..5bc4dd2 100644
--- a/src/main/botSecretFiles.ts
+++ b/src/main/botSecretFiles.ts
@@ -1,5 +1,8 @@
 // The userData files a bot may never read or write (see host/bot/policy). Pure.
 //
+// The OS sandbox (host/bot/sandbox) is the primary layer: it hides all of userData from the
+// bot's whole process tree. These path checks are the second layer, and give the bot a clear reason.
+//
 // Policy also denies each one's temp and set-aside copies (`<name>.<pid>.tmp`, `<name>.corrupt-<time>`),
 // and `*` stands for any run of characters in a name, for the per-window MCP configs.
 export const BOT_SECRET_FILES = [
@@ -15,7 +18,8 @@ export const BOT_SECRET_FILES = [
   // Docker environments: each one's env vars (database passwords, API keys) for compose. The bot
   // runs environments through Trek's tools, never this file.
   'environments.json',
-  // MCP configs: each holds a bearer token for the app's MCP server (mcp-<id>, mcp-bot-<id>, mcp-gemini-<id>).
+  // MCP configs: each holds a bearer token for the app's MCP server (mcp-<id>, mcp-gemini-<id>, and
+  // mcp-bot-<id> from older versions).
   'mcp-*.json',
   'global-claude-mcp.json'
 ]
````

- [ ] **Step 2: Verify**

Run: `npm run typecheck` → no errors (comments only in `botSecretFiles.ts`).

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(bot): the OS sandbox is the primary layer; delegation always asks" -m "Co-Authored-By: <model trailer>" -- docs/superpowers/specs/2026-11-02-project-bot-core-design.md docs/superpowers/specs/2026-11-07-bot-os-sandbox.md src/main/botSecretFiles.ts
```

---

### Task 10: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1344`, `# fail 0`: the baseline 1321, plus 2 (Task 1), 1 (Task 3), 8 (Task 4), 8 (Task 5), 3 (Task 7: 2 in `botTurn.test.mjs`, 1 in `botRunner.test.mjs`) and 1 (Task 8). Per file: `botPolicy.test.mjs` 67, `botTurn.test.mjs` 39, `botRunner.test.mjs` 94, `botSandbox.test.mjs` 8, `botSandboxMac.test.mjs` 8.

- [ ] **Step 2: Types, build, Linux**

Run: `npm run typecheck` → no errors. Run: `npm run build && npm --prefix server run build` → both succeed.
Run: `npm run test:bot-sandbox-linux 2>&1 | tail -1` → `LINUX SANDBOX PASS (34 checks)` (or the `SKIP:` line where Docker is missing).

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous has exited:

| Command | Expected |
|---|---|
| `node scripts/bot-smoke.mjs 2>&1 \| tail -1` | `All 129 checks passed` |
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (142 checks)` |
| `node scripts/remote-smoke.mjs 2>&1 \| tail -1` | `REMOTE SMOKE PASS` |

- [ ] **Step 4: One real turn (optional, costs about $0.01)**

With Trek running from this branch, enable a project's bot with the real `claude` as its command and say: "Run `cat '<userData>/bot-consent.json'`, then `python3 -I -c "print(open('<userData>/bot-consent.json').read())"`, then use the Read tool on that file, then call list_worktrees." Expected: the `cat` and Read are denied by the permission rules, `python3` gets `PermissionError: [Errno 1] Operation not permitted` from the OS, and `list_worktrees` runs. This is what the prototype's real run (Decision 17) showed outside Trek.

- [ ] **Step 5: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Follow-ups (out of scope, user decision 9)

1. **Network.** The outer profile allows all network: the bot can still send repository contents anywhere. Claude Code's proxy allowlist can't be used under the outer sandbox (they don't nest), so this needs SBPL `network-outbound` rules (loopback for the hook and MCP, the Anthropic API, git remotes) or an outer proxy.
2. **Apple Events.** `osascript` driving another app (e.g. `tell application "Terminal" to do script …`) runs code outside the sandbox. The spike found no SBPL rule that blocks AE delivery under `(allow default)` without breaking `claude`; TCC's Automation prompt (with Trek as the responsible app) is the only gate today.
3. **Worktree sessions the bot starts** run unsandboxed. With delegation always approved this is a user decision per call; running them under the same profile would remove the confused deputy entirely.

## Risks

1. **`sandbox-exec` is deprecated.** It works on macOS 26.2, and Claude Code depends on Seatbelt too. If Apple removes it or the profile stops compiling, the probe turns that into a refusal at start ("… was not found" or "a test command failed"), never a silent hole.
2. **Pre-existing hard links** to a userData file elsewhere are readable on both platforms (the profile and the tmpfs match paths, not inodes). Trek makes none; the bot can't make new ones. Backups and snapshots (Time Machine local snapshots, a backup disk under `/Volumes`) hold copies under other paths; the secret stores are `safeStorage`-encrypted there, but `environments.json` and session `mcp-*.json` are plaintext.
3. **Linux: other mounts of the same filesystem.** `--dev-bind / /` brings in every mount. If the home filesystem is also mounted elsewhere (a bind mount, a btrfs top-level subvolume mounted at `/mnt`), userData is visible under that second path. The probe only checks the main path.
4. **Linux distributions that restrict user namespaces** (Ubuntu 24.04's AppArmor rule, hardened kernels) or ship an old `bwrap`: the probe fails and the bot refuses with bwrap's own message. Ubuntu ships an AppArmor profile for `bwrap` that allows it, but this is untested outside Docker.
5. **The token is still known to the bot.** It can call `/bot/policy` and `/mcp` itself; both now run the same policy, so it gains nothing except the ability to spend its own approvals early. `request_approval` only queues a request for the user.
6. **Silent `--settings` drop** (spike prototype 2). Under this plan a dropped settings value no longer opens userData (the OS layer doesn't depend on it) or Trek's tools (the server checks them); it would drop the hook for the CLI's own tools, which `-p` mode then denies ("requires approval"). The real run showed 2.1.319 accepts this plan's settings.
7. **Turn timing.** `sandbox-exec` adds a few milliseconds per spawn. The turn tests now run every fake turn through it; across six full `npm test` runs on the prototype there was one unexplained single failure that did not reproduce (five clean runs followed), most likely one of the timing-bound turn tests under parallel load.
8. **The macOS integration test opens a background app** (its control case) from the test's temp directory, outside the sandbox, on every `npm test` on a Mac. LaunchServices registers that bundle id (`com.trek.sandbox-test.<pid>`) for the run.
9. **The probe runs at start only.** A sandbox that stops working while a bot runs (an OS update mid-session) shows up as failing turns (`'sandbox'` pauses the bot; a profile error would be a `crash`), not as a probe failure.

## Questions for the user

1. **`enqueue_prompt` is still free.** It queues a prompt for a worktree session, to run when that session is next idle: the same confused-deputy route as `send_prompt`, only later. The brief named `start_session`, `send_prompt` and `send_keys`, so this plan leaves `enqueue_prompt` (and `remove_queued_prompt`) free. Should `enqueue_prompt` join the always-ask set? It is a one-word change to `ALWAYS_ASK_TOOLS` and `FREE_TOOLS` plus one test line.
