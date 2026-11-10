# Central server phase 5b: Linear, voice and skills on the server, and the stack MCP tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linear, voice and skills run on each window's server, in every server window, local or remote (the spec: `integrations/` "Linear, … voice synthesis (audio returned to the client), skills", `secrets/` "Linear and voice keys in a 0600 file in the server's config dir"), and the trek-dev MCP server gets back `speak_summary` and the four stack tools.
1. **The protocol.** Three capabilities, `linear`, `voice` and `skills`; the methods `linear.status`, `linear.setKey`, `linear.clearKey`, `linear.issues`, `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`, `voice.setConfig`, `voice.synthesize` and `skills.list`; the event `voice.summary`, to every connection subscribed to the project.
2. **The server.** Main's `linear.ts`, `voice.ts` and `skills.ts` move into `src/host/` (`linearService.ts`, `voiceService.ts`, `skillService.ts`), Electron-free. The keys are in the server's `secrets.json` (0600, beside its config), write-only over the protocol; the voice choice is in `<dataDir>/voice.json`. `server/src/integrations/integrationHandlers.ts` serves them.
3. **The MCP tools.** `speak_summary` synthesizes on the server and sends the clip to the project's windows; `get_stack`, `start_stack`, `stop_stack`, `read_stack_log` drive the server's stack service through `stack.*`. "Summarize automatically" (the voice prompt) is the server's again.
4. **The app.** `WindowBackend.linear`, `.voice` and `.skills`; Settings' Linear and Voice sections on the window's server; the clips play from `voice.summary` while the app is Active (an app setting now). Main hands its Linear and ElevenLabs keys and voice settings to the Local server once. Main's `linear.ts`, `voice.ts`, `skills.ts` and their preload members go.
5. **Smokes.** `smoke:server-integrations` (new) drives a remote window's Linear, voice, skills and the MCP tools against stub Linear and ElevenLabs services; `smoke:local-features` checks the hand-over; `smoke:v2` and `smoke:server-env` follow the gate.

**Architecture:**
- **Host services, server handlers**, as 5a-2: `createLinearService({ key, endpoint })`, `createVoiceService({ key, configFile, api })` (each `key` a `KeySlot` over the secrets file), `listSkills(worktreePath, home)`; `createIntegrations({ secretsFile, voiceConfigFile, … })` builds them once per server (`ServerOptions.integrations`); `integrationHandlers.ts` checks every argument and maps failures to `TOOL_ERROR` (`viaService`).
- **The secrets file** (`server/src/secrets.ts`) is read strictly (only ENOENT is empty) and written then renamed, 0600; synchronous, so two requests never interleave a read-modify-write.
- **The voice fan-out.** `TopicHub.emit(topic, event, payload)` calls each subscriber's new optional `event()`; a connection's skips itself above the pty sink's high-water mark (a late clip is worse than none). `speak_summary` checks the key and that someone listens before it synthesizes.
- **The app.** `CAPABILITY_FOR` gains `linear`, `voice`, `skills`; `MACHINE_FEATURES` shrinks to `reveal`, `openInEditor`. The hand-over is main's (`integrationsHandover.ts`, its rules pure in `integrationsHandoverRules.ts`), over its own connection with the Local token.

**Tech Stack:** as 5a-2: TypeScript, React 19 + zustand, Electron 43, the `src/shared/client` SDK, `node --test`, Playwright's `_electron`; `ws`, `fetch` on the server.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`: "2. Server components" (`integrations/`, `secrets/`), "Desktop app" (main loses `linear.ts`, `voice.ts`, `skills.ts` "once each has a server replacement"; "Hidden until phase 5"), "6. Phases" (5b). Builds on `docs/superpowers/plans/2026-11-09-central-server-phase5a2-machine.md` (its `present()`, `TOOL_ERROR`, the stack service, its Notes for 5b 1–2 and Question 2) and on 4c's plan (Decisions 2 and 5: Linear everywhere with the app's key, which this plan replaces).

**Prototype:** every task below was built and verified first, on `central-server-phase5b-proto` (8 commits on master `fec2b0e`); each task's diff is that prototype's commit, so the implementer applies it, then the reviews look at it fresh. Task 6 folds in the prototype's one design fix (4c0f764, Decision 14).

---

## Roadmap

See 5a-1's "Roadmap: phase 5": this plan is **5b**. 5c (PR watch, the Changes tab's review, the web client) follows, each in its own plan; the bot (last, only when asked), moving worktrees between servers, promote and the supervisor on Windows come later.

---

## Decisions

### Recorded (user decisions, 2026-11-09)

1. **The Linear key lives on each server**, as the spec says: `linear.*` with the server's own key. A remote server needs its key set once, from any window's Settings. The 5c web client gets Linear with it.
2. **A spoken summary plays in every window that has the session's project open and is Active**, on every machine. Active/Busy stays a per-app setting. The tool reports how many windows it went to, or `played: false` with a reason.
3. **Main hands the app's keys and voice settings to the Local server once**, only where the server has none; nobody re-enters them.
4. **The stack MCP tools are in 5b** (5a-2's Question 2). **No server-wide off switch** (as 5a: the token already grants a shell; Question 2 below asks again for these three).

### Decided in this plan

**The server (Tasks 1–3)**

5. **One secrets file per server**, `secrets.json` beside the config file `--config` names (a Local profile's own, for `--local`), not the data dir: the spec's "server's config dir", and the Local profiles never share one. Names `linear`, `elevenlabs` (`LINEAR_SECRET`, `ELEVENLABS_SECRET`). Read strictly: an unreadable or malformed file throws (`TOOL_ERROR`), and no write replaces a file it could not read, so a torn file never loses the other key.
6. **Keys are write-only.** `linear.status` and `voice.settings` say `hasKey`, never the key; no method returns one. `setKey` checks the key with the service first (Linear's `viewer`, ElevenLabs' `/voices`) and answers `{ok, user}` / `{ok, voices}` or `{ok: false, error}` as main did; `{ok: false}` is only the service's answer. The secrets file is read before the service is asked, so an unreadable one is `TOOL_ERROR` with no request (with `ifAbsent` too), and a failed write is `TOOL_ERROR`, never `{ok: false}`; a voice key stored whose first voice cannot be saved is `TOOL_ERROR` saying the key was kept (review fix). Replies are read capped: Linear's and ElevenLabs' JSON and error text at 1 MiB, a clip at 4 MiB (`src/host/httpBody.ts`). A key is trimmed, ≤1024 printable ASCII characters with no spaces (it goes into an HTTP header).
7. **`setKey`'s `ifAbsent`** stores the key only while none is stored (the result says `present` when one was kept): the hand-over's, so a key the user entered on the server first wins.
8. **The voice choice is the server's** (`voiceId`, `modelId`, `promptSessions` in `<dataDir>/voice.json`, 0600, written then renamed; `voice.setConfig` takes only those keys, ids `[A-Za-z0-9_-]{1,128}` / `[A-Za-z0-9_.-]{1,128}`). `active` is not: it is the user's presence at one machine (Decision 2).
9. **`voice.synthesize {text}`** (≤400 characters, `MAX_SPOKEN_CHARS`) answers the requester only, base64 mp3: Settings' "Test voice".
10. **`linear.issues {ids}`**: at most 500 ids of at most 64 characters; the service keeps main's `ISSUE_ID` filter and batches of 50; no key → `[]`.
11. **The service URLs can be overridden for the smokes only**: `TREK_SERVER_LINEAR_URL`, `TREK_SERVER_ELEVENLABS_URL` (server README: never set them in production). `childEnv` lets them through to the Local server (it drops every other `TREK_*`).
12. **`skills.list {projectId, worktreeId}`** resolves the worktree with `present()` (registered repository, allowlist, a main row its repository's own) and reads its `.claude/{skills,commands}` and the server user's `~/.claude/{skills,commands}`, project shadowing user, as main's did. No path in the request. Only regular files are read (stat after following links, so a FIFO or device is never opened), their first 16 KiB; the worktree's `.claude`, its `skills`/`commands` and each `SKILL.md` must have real paths inside the worktree's, else nothing is listed from them (the user's `~/.claude` is the server user's own and is not confined) (review fix).

**The MCP tools (Tasks 2, 4)**

13. **`speak_summary`** keeps the legacy name, parameters and limits (`terminalId`, `summary` ≤400). Order: the session must be the project's (Global sessions too); no key or no chosen voice → `played: false, reason: not set up — do not call again`; no subscriber that takes events (a connection, not an MCP call's no-op subscriber) → `played: false, reason: nobody would hear it`, both before any synthesis; then `{played: true, windows: n}`. `windows` counts connections it was sent to, Busy ones included (Question 3; the tool's description says so). The clip's frame is serialized once per emit, not once per window. The voice prompt (`VOICE_SUMMARY_PROMPT`) is added to a session's system prompt when `promptSessions` is on, a key and a voice are set, and the session has the MCP tools; it goes before the user's prompts (the session type's, the shared or Global one), after a Global session's role, so the user's can override it, as the desktop ordered them.
14. **The stack tools** go through `dispatchV2('stack.*')` in process, so they keep `present()`'s checks; descriptions and result shape are the legacy ones (`describeStack`, via `src/shared/stacks.ts`, moved from the renderer). `start_stack` refuses unless the stack is stopped; `stop_stack` fails on a non-zero exit, pointing at `read_stack_log`; `read_stack_log {lines}` 1–2000 (clamped before flooring), from the log's last 64 KiB, ANSI stripped; the log's trailing newline does not count as a line, and when the log is longer than what was read its cut first line is left out.

**The app (Tasks 5–6)**

15. **The gate:** `CAPABILITY_FOR` gives `linear`, `voice`, `skills` their capabilities; `V2_FEATURES.voice` turns on; `MACHINE_FEATURES` is `reveal`, `openInEditor`. Settings shows Linear where `features.linear`, Voice where `features.voice`.
16. **Playback:** `WindowBackend.voice.onSummary` hears the window's own connection's `voice.summary`; `useVoice()` queues the clips one at a time and drops them while Busy. Active/Busy is the app setting `voiceActive` (default true), so every window of this app agrees.
17. **The hand-over** (`integrationsHandover.ts`) runs once per Local profile, each time a new Local server pid is running: decrypt `linear.json` / `elevenlabs.json`, connect with the Local token, `linear.setKey`/`voice.setKey` with `ifAbsent`, then `voice.setConfig` with the app's voice choice (marked pending and retried next start if that one fails); state in `integrations-handover.json`. It moves `active: false` into `voiceActive` once. Old files are left alone (the installed app and a dev build share userData, 4b Risk 1).
18. **A handed-over key is stored unchecked** (the prototype's fix 4c0f764): `ifAbsent` skips the service's check. The app checked it when the user entered it; checking again would need the network at the start and would reach the real services from the smokes. Settings then says "Connected" without the Linear user's name until the key is entered again (Risk 4).
19. **Deleted:** `src/main/linear.ts`, `voice.ts`, `skills.ts` and their registrations; the preload's `linear*`, `voice*` and `listSkills` members. Kept: `src/main/secrets.ts` (server tokens and the hand-over's reads), the types in `src/shared/types.ts` (the protocol's).

**The smokes (Task 6)**

20. **`smoke:server-integrations`** is new: a plain `trek-server start` with its own HOME and the two test URLs pointed at a local HTTP stub of Linear and ElevenLabs, recording every request; the app with a temp HOME and userData. It checks the remote window's Settings, ticket chips, skills, a test clip, `speak_summary` reaching the window (an `Audio` element), Busy dropping it, and the stack tools over the server's MCP endpoint. 29 checks.
21. **`smoke:local-features`** seeds the userData as a pre-5b Trek left it (both key files, `voice-settings.json` with `active: false`) and checks the hand-over: the Local server has both keys and the voice choice, `voiceActive` is false, and neither service was contacted. 50 checks.

## Conventions

As 5a-2's, with these:
- **Baseline:** master `fec2b0e`: 1651 tests (1650 pass, 1 skipped); smokes as 5a-2's final verification.
- **No real Linear or ElevenLabs, ever.** Every test and smoke that can reach them points the server at a stub (`endpoint` in the unit tests, the two URLs in the smokes) and checks the stub saw the requests it expected.
- **No real docker or colima**, as 5a-2.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `server/src/secrets.ts` | create | 1 | `secrets.json`: strict read, atomic 0600 write, `setIfAbsent` |
| `src/host/linearService.ts` | create | 1, 6 | Linear's GraphQL with the server's key |
| `server/src/integrations/integrations.ts` | create | 1–3 | `createIntegrations` |
| `server/src/integrations/integrationHandlers.ts` | create | 1–3 | the methods; argument checks; `viaService` |
| `src/shared/protocolV2.ts`, `src/shared/types.ts` | modify | 1–3, 5, 6 | methods, results, `voice.summary`, capabilities |
| `server/src/v2.ts`, `server.ts`, `capabilities.ts`, `index.ts` | modify | 1, 2, 4 | the context's `integrations`; the capabilities; the subscriber's `event()` |
| `src/host/voiceService.ts` | create | 2, 6 | ElevenLabs; `voice.json` |
| `server/src/topicHub.ts` | modify | 2 | `emit` |
| `server/src/mcp/tools.ts` | modify | 2, 4 | `speak_summary`, the stack tools |
| `server/src/sessions/launch.ts`, `manager.ts`, `src/shared/providers/prompts.ts` | modify | 2 | the voice prompt |
| `src/host/skillService.ts` | create | 3 | `listSkills`: the skill scan |
| `src/shared/stacks.ts` | move from `src/renderer/src/stacks.ts` | 4 | stack state and URLs, for the server too |
| `src/renderer/src/backend.ts`, `backendFeatures.ts`, `v2/backendV2.ts` | modify | 5 | `linear`, `voice`, `skills`; the gate |
| `src/renderer/src/linear.ts`, `voice.ts`, `App.tsx`, `components/{LinearSettings,VoiceSettings,VoiceToggle,SkillMenu,SettingsPanel}.tsx` | modify | 5 | through the backend; `useVoice` |
| `src/main/integrationsHandover.ts`, `integrationsHandoverRules.ts` | create | 5, 6 | the hand-over |
| `src/main/appSettings.ts`, `src/shared/appSettings.ts`, `src/main/localServer.ts`, `localServerRules.ts`, `src/main/index.ts` | modify | 5, 6 | `voiceActive`; the hand-over's hooks; `childEnv` |
| `src/main/linear.ts`, `voice.ts`, `skills.ts` | delete | 5 | |
| `src/preload/index.ts` | modify | 5 | the members out |
| `scripts/serverIntegrations.test.mjs`, `serverStackTools.test.mjs`, `integrationsHandover.test.mjs` | create | 1–6 | |
| `scripts/{serverV2,serverMcpTools,serverLaunch,backendFeatures,v2Backend,appSettings,localServerRules}.test.mjs`, `server/scripts/smoke.mjs`, `scripts/client-contract.mjs` | modify | 1–6 | |
| `scripts/server-integrations-smoke.mjs`, `package.json` | create, modify | 6 | `smoke:server-integrations` |
| `scripts/{local-features,v2,server-env}-smoke.mjs` | modify | 6 | |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | modify | 7 | |

---

### Task 1: The server's secrets file and Linear with its own key

**Files:**
- Create: `server/src/secrets.ts`, `src/host/linearService.ts`, `server/src/integrations/integrations.ts`, `server/src/integrations/integrationHandlers.ts`, `scripts/serverIntegrations.test.mjs`
- Modify: `src/shared/protocolV2.ts`, `src/shared/types.ts`, `server/src/v2.ts`, `server/src/server.ts`, `server/src/capabilities.ts`, `server/src/index.ts`
- Test: `scripts/serverIntegrations.test.mjs`; the capability lists of `scripts/serverV2.test.mjs`, `server/scripts/smoke.mjs`, `scripts/client-contract.mjs`

The app is not changed in this task (Decisions 5–7, 10, 11).

- [ ] **Step 1: Apply the diff** (the prototype's 612a7f1; tests and code together, since the tests import the handlers)

````diff
diff --git a/scripts/client-contract.mjs b/scripts/client-contract.mjs
index fd3cba8..a481fa5 100644
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -106,7 +106,7 @@ const mirror = new TopicMirror(conn)
 const ptys = new PtyStream(conn)
 conn.connect()
 if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
-if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
+if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
 else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)
 
 // --- 2. server topic ---
diff --git a/scripts/serverIntegrations.test.mjs b/scripts/serverIntegrations.test.mjs
new file mode 100644
index 0000000..6ed96b8
--- /dev/null
+++ b/scripts/serverIntegrations.test.mjs
@@ -0,0 +1,157 @@
+// scripts/serverIntegrations.test.mjs — the server's secrets file and linear.* (phase 5b), against a
+// local HTTP stub of Linear's GraphQL endpoint: nothing here reaches api.linear.app.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createServer } from 'node:http'
+import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
+import { createIntegrations } from '../server/src/integrations/integrations.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+
+const tempDir = (t) => {
+  const dir = mkdtempSync(join(tmpdir(), 'trek-integrations-'))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  return dir
+}
+
+/** A stub of Linear's endpoint: `good-key` is a valid key; issues TOW-1 and TOW-2..TOW-120 exist. */
+async function linearStub(t, options = {}) {
+  const requests = []
+  const server = createServer((req, res) => {
+    let body = ''
+    req.on('data', (c) => (body += c))
+    req.on('end', () => {
+      const parsed = JSON.parse(body)
+      requests.push({ auth: req.headers.authorization, ...parsed })
+      const send = (status, value) => {
+        res.writeHead(status, { 'content-type': 'application/json' })
+        res.end(JSON.stringify(value))
+      }
+      if (options.status) return send(options.status, {})
+      if (req.headers.authorization !== 'good-key') return send(401, {})
+      if (parsed.query.includes('viewer')) return send(200, { data: { viewer: { name: 'Ada' } } })
+      const data = {}
+      for (const [alias, id] of Object.entries(parsed.variables)) {
+        data[alias] = /^TOW-\d+$/.test(id) ? { identifier: id, title: `Title ${id}`, url: `https://linear.app/x/issue/${id}`, state: { name: 'In Progress', type: 'started', color: '#f00' } } : null
+      }
+      send(200, { data })
+    })
+  })
+  await new Promise((r) => server.listen(0, '127.0.0.1', r))
+  t.after(() => server.close())
+  return { url: `http://127.0.0.1:${server.address().port}/graphql`, requests }
+}
+
+async function setup(t, options = {}) {
+  const dir = tempDir(t)
+  const stub = await linearStub(t, options)
+  const secretsFile = secretsPathFor(join(dir, 'config.json'))
+  const integrations = createIntegrations({ secretsFile, linearEndpoint: stub.url })
+  const ctx = { integrations }
+  const call = (method, params) => dispatchV2(method, params, ctx)
+  return { dir, stub, secretsFile, call }
+}
+
+const refused = (res, code) => {
+  assert.equal(res.ok, false, JSON.stringify(res))
+  assert.equal(res.error.code, code, res.error.message)
+}
+
+test('the secrets file: beside the config, 0600, set, set-if-absent and clear', (t) => {
+  const dir = tempDir(t)
+  const path = secretsPathFor(join(dir, 'config.json'))
+  assert.equal(path, join(dir, 'secrets.json'))
+  const file = createSecretFile(path)
+  assert.equal(file.get('linear'), null)
+  file.set('linear', 'k1')
+  assert.equal(statSync(path).mode & 0o777, 0o600)
+  assert.equal(file.setIfAbsent('linear', 'k2'), false)
+  assert.equal(file.get('linear'), 'k1')
+  assert.equal(file.setIfAbsent('elevenlabs', 'e1'), true)
+  file.set('linear', null)
+  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { elevenlabs: 'e1' })
+  // `__proto__` is just a name, never the object's prototype.
+  file.set('__proto__', 'p')
+  assert.equal(file.get('__proto__'), 'p')
+  assert.equal(file.get('constructor'), null)
+})
+
+test('the secrets file: one that cannot be parsed throws, and is never replaced', (t) => {
+  const dir = tempDir(t)
+  const path = join(dir, 'secrets.json')
+  writeFileSync(path, '{"linear": "k1", torn')
+  const file = createSecretFile(path)
+  assert.throws(() => file.get('linear'), /not valid JSON/)
+  assert.throws(() => file.set('elevenlabs', 'e1'), /not valid JSON/)
+  assert.equal(readFileSync(path, 'utf8'), '{"linear": "k1", torn')
+})
+
+test('linear.setKey checks the key with Linear, stores it 0600 and never sends it back', async (t) => {
+  const s = await setup(t)
+  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
+  // Without a key, no lookup and no request.
+  assert.deepEqual((await s.call('linear.issues', { ids: ['TOW-1'] })).result, [])
+  assert.equal(s.stub.requests.length, 0)
+
+  const rejected = await s.call('linear.setKey', { apiKey: 'bad-key' })
+  assert.deepEqual(rejected.result, { ok: false, error: 'Linear rejected the API key' })
+  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
+
+  const set = await s.call('linear.setKey', { apiKey: '  good-key \n' })
+  assert.deepEqual(set.result, { ok: true, user: 'Ada' })
+  assert.equal(JSON.stringify(set).includes('good-key'), false)
+  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: true })
+  assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600)
+  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'good-key' })
+
+  assert.deepEqual((await s.call('linear.clearKey', {})).result, null)
+  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
+})
+
+test('linear.setKey ifAbsent keeps a stored key without asking Linear', async (t) => {
+  const s = await setup(t)
+  assert.equal((await s.call('linear.setKey', { apiKey: 'good-key', ifAbsent: true })).result.ok, true)
+  const before = s.stub.requests.length
+  const again = await s.call('linear.setKey', { apiKey: 'other-key', ifAbsent: true })
+  assert.deepEqual(again.result, { ok: false, error: 'This server already has a key; it was kept', present: true })
+  assert.equal(s.stub.requests.length, before)
+  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'good-key' })
+})
+
+test('linear.issues looks the ids up in batches of 50 and leaves out unknown and malformed ids', async (t) => {
+  const s = await setup(t)
+  await s.call('linear.setKey', { apiKey: 'good-key' })
+  const lookups = s.stub.requests.length
+  const ids = [...Array.from({ length: 60 }, (_, i) => `TOW-${i + 1}`), 'TOW-1', 'nope', 'ABC-9']
+  const res = await s.call('linear.issues', { ids })
+  assert.equal(res.ok, true)
+  // ABC-9 is well-formed but Linear has no such issue; "nope" is never sent; TOW-1 once.
+  assert.equal(res.result.length, 60)
+  assert.deepEqual(res.result[0], { identifier: 'TOW-1', title: 'Title TOW-1', url: 'https://linear.app/x/issue/TOW-1', status: 'In Progress', statusType: 'started', statusColor: '#f00' })
+  const sent = s.stub.requests.slice(lookups)
+  assert.equal(sent.length, 2)
+  assert.deepEqual(sent.map((r) => Object.keys(r.variables).length), [50, 11])
+  assert.equal(sent.every((r) => r.auth === 'good-key'), true)
+})
+
+test('linear.*: a Linear that fails is TOOL_ERROR; bad arguments are BAD_REQUEST before any request', async (t) => {
+  const s = await setup(t, { status: 500 })
+  // No key yet: the check fails with Linear's status, nothing stored.
+  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'good-key' })).result, { ok: false, error: 'Linear API returned 500' })
+  createSecretFile(s.secretsFile).set('linear', 'good-key')
+  refused(await s.call('linear.issues', { ids: ['TOW-1'] }), 'TOOL_ERROR')
+  const sent = s.stub.requests.length
+  refused(await s.call('linear.setKey', { apiKey: 'has space' }), 'BAD_REQUEST')
+  refused(await s.call('linear.setKey', { apiKey: '' }), 'BAD_REQUEST')
+  refused(await s.call('linear.setKey', { apiKey: 'k', ifAbsent: 'yes' }), 'BAD_REQUEST')
+  refused(await s.call('linear.issues', { ids: 'TOW-1' }), 'BAD_REQUEST')
+  refused(await s.call('linear.issues', { ids: Array.from({ length: 501 }, () => 'TOW-1') }), 'BAD_REQUEST')
+  refused(await s.call('linear.issues', { ids: [1] }), 'BAD_REQUEST')
+  assert.equal(s.stub.requests.length, sent)
+})
+
+test('linear.*: a server without integrations answers NOT_FOUND', async () => {
+  refused(await dispatchV2('linear.status', {}, {}), 'NOT_FOUND')
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 3deb5be..ddd7fa7 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 172fd4a..93a3a7d 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -163,7 +163,7 @@ async function nextPatch(conn, topic, state, timeoutMs = 4000) {
 const v2 = await connect(2, token)
 if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
   fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
-} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks'].every((c) => v2.welcome.capabilities?.includes(c))) {
+} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear'].every((c) => v2.welcome.capabilities?.includes(c))) {
   fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
 } else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index f029d73..bc84205 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -4,6 +4,7 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 /**
  * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
  * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
+ * `linear` says it serves `linear.*`; whether it has a key is `linear.status`'s answer.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -12,7 +13,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.agents,
   CAPABILITY.docker,
   CAPABILITY.env,
-  CAPABILITY.stacks
+  CAPABILITY.stacks,
+  CAPABILITY.linear
 ]
 
 /** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
diff --git a/server/src/index.ts b/server/src/index.ts
index 86c4ecd..c45a710 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -19,6 +19,8 @@ import { ProjectStore } from './projects/store'
 import { formatRepoList } from './repos'
 import { startServer } from './server'
 import { createMachine } from './integrations/machine'
+import { createIntegrations } from './integrations/integrations'
+import { secretsPathFor } from './secrets'
 import { seedEnvironmentsFromApp } from './integrations/envSeed'
 import {
   addToken,
@@ -448,7 +450,15 @@ const server = startServer(
     store: projectFiles.files
   },
   // Absolute: agents read the config file from their own worktree's directory.
-  { mcpDir: resolve(serverDataDir, 'mcp'), local: local !== undefined, machine: createMachine(serverDataDir, { local: local !== undefined }) }
+  {
+    mcpDir: resolve(serverDataDir, 'mcp'),
+    local: local !== undefined,
+    machine: createMachine(serverDataDir, { local: local !== undefined }),
+    integrations: createIntegrations({
+      secretsFile: secretsPathFor(resolve(args.configPath)),
+      linearEndpoint: process.env.TREK_SERVER_LINEAR_URL || undefined
+    })
+  }
 )
 store.watch()
 server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
diff --git a/server/src/integrations/integrationHandlers.ts b/server/src/integrations/integrationHandlers.ts
new file mode 100644
index 0000000..424f0b4
--- /dev/null
+++ b/server/src/integrations/integrationHandlers.ts
@@ -0,0 +1,74 @@
+// Linear with the server's own API key (phase 5b; capability `linear`). Before 5b the app's main
+// process kept one key for every window; now each server has its own, in its secrets file
+// (secrets.ts), set from any client and never sent back.
+import type { V2Context } from '../v2.ts'
+import { codedError } from '../errors.ts'
+import type { Integrations } from './integrations.ts'
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+const MAX_KEY = 1024
+const MAX_IDS = 500
+const MAX_ID = 64
+
+/** An API key: trimmed, not empty, printable, no whitespace inside (it goes into an HTTP header). */
+export function requireApiKey(value: unknown): string {
+  if (typeof value !== 'string') throw bad('apiKey must be a string')
+  const key = value.trim()
+  if (!key) throw bad('apiKey is required')
+  if (key.length > MAX_KEY) throw bad(`apiKey must be at most ${MAX_KEY} characters`)
+  if (!/^[\x21-\x7e]+$/.test(key)) throw bad('apiKey must be printable ASCII with no spaces')
+  return key
+}
+
+export function optionalFlag(value: unknown, field: string): boolean {
+  if (value === undefined) return false
+  if (typeof value !== 'boolean') throw bad(`${field} must be a boolean`)
+  return value
+}
+
+function requireIssueIds(value: unknown): string[] {
+  if (!Array.isArray(value)) throw bad('ids must be an array of strings')
+  if (value.length > MAX_IDS) throw bad(`ids: at most ${MAX_IDS}`)
+  for (const id of value) if (typeof id !== 'string' || id.length > MAX_ID) throw bad(`ids must be strings of at most ${MAX_ID} characters`)
+  return value as string[]
+}
+
+export const integrations = (ctx: V2Context): Integrations => {
+  if (!ctx.integrations) throw codedError('NOT_FOUND', 'this server has no integrations')
+  return ctx.integrations
+}
+
+/** A failed lookup (Linear down, the secrets file unreadable) is TOOL_ERROR, never INTERNAL; a coded refusal stays as it is. */
+export async function viaService<T>(operation: () => T | Promise<T>): Promise<T> {
+  try {
+    return await operation()
+  } catch (err) {
+    const code = (err as { code?: unknown }).code
+    if (code === 'BAD_REQUEST' || code === 'NOT_FOUND') throw err
+    throw codedError('TOOL_ERROR', (err as Error).message ?? String(err))
+  }
+}
+
+export const integrationHandlers: Record<string, Handler> = {
+  'linear.status': (_p, ctx) => viaService(() => ({ hasKey: integrations(ctx).linear.hasKey() })),
+
+  'linear.setKey': (p, ctx) => {
+    const apiKey = requireApiKey(p.apiKey)
+    const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
+    return integrations(ctx).linear.setKey(apiKey, { ifAbsent })
+  },
+
+  'linear.clearKey': (_p, ctx) =>
+    viaService(() => {
+      integrations(ctx).linear.clearKey()
+      return null
+    }),
+
+  'linear.issues': (p, ctx) => {
+    const ids = requireIssueIds(p.ids)
+    return viaService(() => integrations(ctx).linear.issues(ids))
+  }
+}
diff --git a/server/src/integrations/integrations.ts b/server/src/integrations/integrations.ts
new file mode 100644
index 0000000..189e391
--- /dev/null
+++ b/server/src/integrations/integrations.ts
@@ -0,0 +1,36 @@
+// The server's integrations with outside services (phase 5b): Linear, with the server's own key in
+// its secrets file. Made once per server (index.ts) and handed to the handlers through V2Context.
+import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
+import { createSecretFile, type SecretFile } from '../secrets.ts'
+
+/** The secrets file's names. */
+export const LINEAR_SECRET = 'linear'
+
+export interface Integrations {
+  linear: LinearService
+}
+
+export interface IntegrationOptions {
+  /** `secrets.json` beside the server's config (secretsPathFor) */
+  secretsFile: string
+  /**
+   * Linear's GraphQL endpoint, for tests (default api.linear.app); the server reads
+   * `TREK_SERVER_LINEAR_URL` from its environment for its smokes.
+   */
+  linearEndpoint?: string
+}
+
+export function keySlot(file: SecretFile, name: string): KeySlot {
+  return {
+    get: () => file.get(name),
+    set: (value) => file.set(name, value),
+    setIfAbsent: (value) => file.setIfAbsent(name, value)
+  }
+}
+
+export function createIntegrations(options: IntegrationOptions): Integrations {
+  const secrets = createSecretFile(options.secretsFile)
+  return {
+    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint })
+  }
+}
diff --git a/server/src/secrets.ts b/server/src/secrets.ts
new file mode 100644
index 0000000..264f83f
--- /dev/null
+++ b/server/src/secrets.ts
@@ -0,0 +1,69 @@
+// The server's integration keys (phase 5b: Linear, ElevenLabs), in `secrets.json` beside its
+// config: owner-only (0600), written then renamed. The keys are write-only over the protocol: a
+// client can set, replace or clear one and ask whether it is set, never read it back.
+import { readFileSync } from 'node:fs'
+import { dirname, join } from 'node:path'
+import { writeFileAtomic } from './atomicWrite.ts'
+
+export const SECRETS_FILE = 'secrets.json'
+
+/** `secrets.json` in the directory of the server's config file (the Local profile's own, for `--local`). */
+export function secretsPathFor(configPath: string): string {
+  return join(dirname(configPath), SECRETS_FILE)
+}
+
+export interface SecretFile {
+  get(name: string): string | null
+  /** Stores `value`, or removes the key for null. */
+  set(name: string, value: string | null): void
+  /** Stores `value` only while nothing is stored under `name`; true when it stored it. */
+  setIfAbsent(name: string, value: string): boolean
+}
+
+/**
+ * Read strictly: a missing file is empty, but one that cannot be read or parse throws, so a write
+ * never replaces a file it could not read (and the other key in it) with only its own.
+ */
+export function createSecretFile(path: string): SecretFile {
+  const readAll = (): Record<string, string> => {
+    let text: string
+    try {
+      text = readFileSync(path, 'utf8')
+    } catch (err) {
+      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
+      throw new Error(`${path} cannot be read: ${(err as Error).message}`)
+    }
+    let all: unknown
+    try {
+      all = JSON.parse(text)
+    } catch (err) {
+      throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
+    }
+    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error(`${path} must hold a JSON object`)
+    const out: Record<string, string> = Object.create(null)
+    for (const [key, value] of Object.entries(all)) if (typeof value === 'string' && value) out[key] = value
+    return out
+  }
+  const write = (all: Record<string, string>): void => writeFileAtomic(path, JSON.stringify(all, null, 2) + '\n', 0o600)
+  return {
+    get(name) {
+      const all = readAll()
+      return Object.hasOwn(all, name) ? all[name] : null
+    },
+    set(name, value) {
+      const all = readAll()
+      if (value === null) {
+        if (!Object.hasOwn(all, name)) return
+        delete all[name]
+      } else all[name] = value
+      write(all)
+    },
+    setIfAbsent(name, value) {
+      const all = readAll()
+      if (Object.hasOwn(all, name)) return false
+      all[name] = value
+      write(all)
+      return true
+    }
+  }
+}
diff --git a/server/src/server.ts b/server/src/server.ts
index 3d6da6e..d60a5eb 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -27,6 +27,7 @@ import { McpAccessStore } from './mcp/access'
 import { startMcpListener, type McpListener } from './mcp/listener'
 import { createToolCaller, type ToolCall, MCP_INSTRUCTIONS, MCP_TOOLS } from './mcp/tools'
 import { createEventSink, type Machine } from './integrations/machineHandlers'
+import type { Integrations } from './integrations/integrations'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -58,6 +59,8 @@ export interface ServerOptions {
   local?: boolean
   /** Docker, the environments and the dev stacks on this machine, with their files in the data dir (machine.ts) */
   machine?: Machine
+  /** Linear with the server's own key, in its secrets file (integrations.ts) */
+  integrations?: Integrations
 }
 
 export interface ProjectsSetup {
@@ -273,6 +276,7 @@ export function startServer(
         terminal,
         events,
         machine: options.machine,
+        integrations: options.integrations,
         mcpAccess: access
           ? {
               revoke: (id) => {
diff --git a/server/src/v2.ts b/server/src/v2.ts
index 2159514..cdd59e9 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -1,6 +1,7 @@
 // Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
 // projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
-// the v2 pty.* stream, and docker, env and stack on the server's machine (machineHandlers.ts).
+// the v2 pty.* stream, docker, env and stack on the server's machine (machineHandlers.ts), and
+// Linear with the server's key (integrationHandlers.ts).
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -12,6 +13,8 @@ import type { GitPoller } from './git/poller.ts'
 import { worktreeHandlers } from './worktreeHandlers.ts'
 import { sessionHandlers } from './sessionHandlers.ts'
 import { machineHandlers, type EventSink, type Machine } from './integrations/machineHandlers.ts'
+import { integrationHandlers } from './integrations/integrationHandlers.ts'
+import type { Integrations } from './integrations/integrations.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
 import { checkImport } from './projects/importCheck.ts'
 import { findRegistered, newRepository, repoIn } from './projects/model.ts'
@@ -50,6 +53,8 @@ export interface V2Context {
   machine?: Machine
   /** This connection, as a receiver of the `docker.log` and `env.log` its own requests stream */
   events?: EventSink
+  /** Linear with the server's own key (phase 5b) */
+  integrations?: Integrations
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
@@ -269,7 +274,8 @@ const handlers: Record<string, Handler> = {
 
   ...worktreeHandlers,
   ...sessionHandlers,
-  ...machineHandlers
+  ...machineHandlers,
+  ...integrationHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/src/host/linearService.ts b/src/host/linearService.ts
new file mode 100644
index 0000000..44192ee
--- /dev/null
+++ b/src/host/linearService.ts
@@ -0,0 +1,107 @@
+// Linear's ticket lookups with the server's API key (phase 5b; main's linear.ts before it).
+// Electron-free: the key is in a slot the caller owns (the server's secrets file), and the
+// endpoint can be pointed elsewhere (a test's stub server).
+import type { LinearIssue, LinearKeyResult } from '../shared/types'
+
+export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
+export const LINEAR_ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
+/** Linear caps query complexity, so large lookups are split into batches. */
+const BATCH_SIZE = 50
+const TIMEOUT_MS = 15_000
+
+/** Where the key lives; it never leaves the server. */
+export interface KeySlot {
+  get(): string | null
+  set(value: string | null): void
+  setIfAbsent(value: string): boolean
+}
+
+export interface LinearService {
+  hasKey(): boolean
+  /**
+   * Checks the key with Linear, then stores it. `ifAbsent`: only while no key is stored (the app's
+   * hand-over), else `{ ok: false, present: true }` and nothing changes.
+   */
+  setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<LinearKeyResult>
+  clearKey(): void
+  /** The issues that exist and the key can see; unknown ids are left out, and none without a key. */
+  issues(ids: string[]): Promise<LinearIssue[]>
+}
+
+interface GraphQLResponse<T> {
+  data?: T | null
+  errors?: { message: string }[]
+}
+
+interface RawIssue {
+  identifier: string
+  title: string
+  url: string
+  state: { name: string; type: string; color: string }
+}
+
+export const PRESENT_ERROR = 'This server already has a key; it was kept'
+
+export function createLinearService(options: { key: KeySlot; endpoint?: string; fetch?: typeof fetch }): LinearService {
+  const endpoint = options.endpoint ?? LINEAR_ENDPOINT
+  const doFetch = options.fetch ?? fetch
+
+  async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse<T>> {
+    const res = await doFetch(endpoint, {
+      method: 'POST',
+      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
+      body: JSON.stringify({ query, variables }),
+      signal: AbortSignal.timeout(TIMEOUT_MS)
+    })
+    if (res.status === 401) throw new Error('Linear rejected the API key')
+    if (!res.ok && res.status !== 400) throw new Error(`Linear API returned ${res.status}`)
+    return (await res.json()) as GraphQLResponse<T>
+  }
+
+  async function fetchBatch(apiKey: string, ids: string[]): Promise<LinearIssue[]> {
+    // One aliased field per issue; a missing issue only nulls its own alias.
+    const params = ids.map((_, i) => `$i${i}: String!`).join(', ')
+    const fields = ids.map((_, i) => `i${i}: issue(id: $i${i}) { identifier title url state { name type color } }`).join('\n')
+    const variables = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
+    const { data } = await graphql<Record<string, RawIssue | null>>(apiKey, `query (${params}) {\n${fields}\n}`, variables)
+    return Object.values(data ?? {})
+      .filter((issue): issue is RawIssue => !!issue && typeof issue === 'object' && !!issue.state)
+      .map((issue) => ({
+        identifier: String(issue.identifier),
+        title: String(issue.title),
+        url: String(issue.url),
+        status: String(issue.state.name),
+        statusType: String(issue.state.type),
+        statusColor: String(issue.state.color)
+      }))
+  }
+
+  return {
+    hasKey: () => !!options.key.get(),
+
+    async setKey(apiKey, { ifAbsent = false } = {}) {
+      if (ifAbsent && options.key.get()) return { ok: false, error: PRESENT_ERROR, present: true }
+      try {
+        const { data, errors } = await graphql<{ viewer: { name: string } }>(apiKey, 'query { viewer { name } }')
+        if (!data?.viewer) return { ok: false, error: errors?.[0]?.message ?? 'Invalid API key' }
+        if (ifAbsent) {
+          if (!options.key.setIfAbsent(apiKey)) return { ok: false, error: PRESENT_ERROR, present: true }
+        } else options.key.set(apiKey)
+        return { ok: true, user: String(data.viewer.name) }
+      } catch (err) {
+        return { ok: false, error: err instanceof Error ? err.message : String(err) }
+      }
+    },
+
+    clearKey: () => options.key.set(null),
+
+    async issues(ids) {
+      const apiKey = options.key.get()
+      if (!apiKey) return []
+      const valid = [...new Set(ids.filter((id) => LINEAR_ISSUE_ID.test(id)))]
+      const batches: string[][] = []
+      for (let i = 0; i < valid.length; i += BATCH_SIZE) batches.push(valid.slice(i, i + BATCH_SIZE))
+      return (await Promise.all(batches.map((b) => fetchBatch(apiKey, b)))).flat()
+    }
+  }
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index f84b2dc..97a2c5d 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -24,6 +24,8 @@ import type {
   EnvUpResult,
   EnvironmentInfo,
   EnvironmentSettings,
+  LinearIssue,
+  LinearKeyResult,
   StackLogChunk,
   StackStatus,
   WorktreeChanges
@@ -173,7 +175,9 @@ export const CAPABILITY = {
   /** `env.*` run the per-worktree Colima environments on the server's machine, and `env.log` streams their output */
   env: 'env',
   /** `stack.*` run the worktrees' docker/stack/stack.sh dev stacks on the server's machine */
-  stacks: 'stacks'
+  stacks: 'stacks',
+  /** `linear.*` look up Linear issues with the server's own API key (set from any client, never read back) */
+  linear: 'linear'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -356,6 +360,18 @@ export interface MethodParamsV2 {
   /** The stack's log from `offset` of the file `fileId` names, or its last 64 KiB when that file is gone */
   'stack.log': WorktreeRef & { fileId: number; offset: number }
 
+  // Linear, with the server's API key (capability `linear`)
+  /** Whether the server has a Linear key */
+  'linear.status': Record<string, never>
+  /**
+   * Checks the key with Linear and stores it on the server (0600, never sent back). `ifAbsent`: only
+   * while the server has none (the app's hand-over); a stored key is kept and the result says `present`.
+   */
+  'linear.setKey': { apiKey: string; ifAbsent?: boolean }
+  'linear.clearKey': Record<string, never>
+  /** The issues with these ids (e.g. TOW-123) that exist and the key can see; none without a key */
+  'linear.issues': { ids: string[] }
+
   // Subscriptions
   'sub.subscribe': { topic: Topic }
   'sub.unsubscribe': { topic: Topic }
@@ -451,6 +467,10 @@ export interface MethodResultsV2 {
   'stack.down': number
   'stack.destroy': number
   'stack.log': StackLogChunk
+  'linear.status': { hasKey: boolean }
+  'linear.setKey': LinearKeyResult
+  'linear.clearKey': null
+  'linear.issues': LinearIssue[]
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 20b7e9c..fe66a2d 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -665,7 +665,8 @@ export interface LinearIssue {
   statusColor: string
 }
 
-export type LinearKeyResult = { ok: true; user: string } | { ok: false; error: string }
+/** `present`: a set-if-absent (the app's hand-over) found a key already stored, and kept it. */
+export type LinearKeyResult = { ok: true; user: string } | { ok: false; error: string; present?: true }
 
 /** Machine-wide ElevenLabs voice summary settings (not per project). */
 export interface VoiceConfig {
````

- [ ] **Step 2: Run the new tests**

Run: `node --test scripts/serverIntegrations.test.mjs scripts/serverV2.test.mjs`
Expected: PASS (7 tests in `serverIntegrations.test.mjs`). Then drop `requireApiKey`'s printable check locally and confirm "linear.*: a Linear that fails is TOOL_ERROR; bad arguments are BAD_REQUEST before any request" fails; restore it.

- [ ] **Step 3: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`
Expected: exit 0, no failures.

- [ ] **Step 4: Commit**

```bash
git add server/src/secrets.ts src/host/linearService.ts server/src/integrations/integrations.ts server/src/integrations/integrationHandlers.ts scripts/serverIntegrations.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5b): the server's secrets file and linear.* with its own key (capability linear)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- server/src/secrets.ts src/host/linearService.ts server/src/integrations/integrations.ts server/src/integrations/integrationHandlers.ts scripts/serverIntegrations.test.mjs src/shared/protocolV2.ts src/shared/types.ts server/src/v2.ts server/src/server.ts server/src/capabilities.ts server/src/index.ts scripts/serverV2.test.mjs server/scripts/smoke.mjs scripts/client-contract.mjs
```

---

### Task 2: Voice on the server, `speak_summary` and the voice prompt

**Files:**
- Create: `src/host/voiceService.ts`
- Modify: `server/src/integrations/{integrations,integrationHandlers}.ts`, `server/src/topicHub.ts`, `server/src/server.ts`, `server/src/index.ts`, `server/src/capabilities.ts`, `server/src/mcp/tools.ts`, `server/src/sessions/launch.ts`, `server/src/sessions/manager.ts`, `src/shared/providers/prompts.ts`, `src/shared/protocolV2.ts`, `src/shared/types.ts`
- Test: `scripts/serverIntegrations.test.mjs`, `scripts/serverMcpTools.test.mjs`, `scripts/serverLaunch.test.mjs`; the capability lists

Decisions 2, 8, 9, 13.

- [ ] **Step 1: Apply the diff** (2344f4b)

````diff
diff --git a/scripts/client-contract.mjs b/scripts/client-contract.mjs
index a481fa5..b2413fc 100644
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -106,7 +106,7 @@ const mirror = new TopicMirror(conn)
 const ptys = new PtyStream(conn)
 conn.connect()
 if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
-if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
+if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
 else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)
 
 // --- 2. server topic ---
diff --git a/scripts/serverIntegrations.test.mjs b/scripts/serverIntegrations.test.mjs
index 6ed96b8..ee46074 100644
--- a/scripts/serverIntegrations.test.mjs
+++ b/scripts/serverIntegrations.test.mjs
@@ -1,5 +1,5 @@
-// scripts/serverIntegrations.test.mjs — the server's secrets file and linear.* (phase 5b), against a
-// local HTTP stub of Linear's GraphQL endpoint: nothing here reaches api.linear.app.
+// scripts/serverIntegrations.test.mjs — the server's secrets file, linear.* and voice.* (phase 5b),
+// against local HTTP stubs of Linear's and ElevenLabs' APIs: nothing here reaches either service.
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import { createServer } from 'node:http'
@@ -9,6 +9,7 @@ import { join } from 'node:path'
 import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
 import { createIntegrations } from '../server/src/integrations/integrations.ts'
 import { dispatchV2 } from '../server/src/v2.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
 
 const tempDir = (t) => {
   const dir = mkdtempSync(join(tmpdir(), 'trek-integrations-'))
@@ -44,14 +45,51 @@ async function linearStub(t, options = {}) {
   return { url: `http://127.0.0.1:${server.address().port}/graphql`, requests }
 }
 
+/** A stub of ElevenLabs' API: `good-voice` is a valid key with two voices; speech is `mp3:<voice>:<model>:<text>`. */
+async function elevenLabsStub(t, options = {}) {
+  const requests = []
+  const server = createServer((req, res) => {
+    let body = ''
+    req.on('data', (c) => (body += c))
+    req.on('end', () => {
+      requests.push({ method: req.method, url: req.url, key: req.headers['xi-api-key'], body })
+      if (options.status) {
+        res.writeHead(options.status)
+        return res.end('quota exceeded')
+      }
+      if (req.headers['xi-api-key'] !== 'good-voice') {
+        res.writeHead(401)
+        return res.end()
+      }
+      if (req.method === 'GET' && req.url === '/v1/voices') {
+        res.writeHead(200, { 'content-type': 'application/json' })
+        return res.end(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2', name: 'Adam' }] }))
+      }
+      const speech = /^\/v1\/text-to-speech\/([^?]+)\?output_format=mp3_44100_128$/.exec(req.url)
+      if (req.method === 'POST' && speech) {
+        const { text, model_id } = JSON.parse(body)
+        res.writeHead(200, { 'content-type': 'audio/mpeg' })
+        return res.end(`mp3:${decodeURIComponent(speech[1])}:${model_id}:${text}`)
+      }
+      res.writeHead(404)
+      res.end()
+    })
+  })
+  await new Promise((r) => server.listen(0, '127.0.0.1', r))
+  t.after(() => server.close())
+  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests }
+}
+
 async function setup(t, options = {}) {
   const dir = tempDir(t)
   const stub = await linearStub(t, options)
+  const voiceStub = await elevenLabsStub(t, options.voice)
   const secretsFile = secretsPathFor(join(dir, 'config.json'))
-  const integrations = createIntegrations({ secretsFile, linearEndpoint: stub.url })
+  const voiceConfigFile = join(dir, 'data', 'voice.json')
+  const integrations = createIntegrations({ secretsFile, linearEndpoint: stub.url, voiceConfigFile, elevenLabsApi: voiceStub.url })
   const ctx = { integrations }
   const call = (method, params) => dispatchV2(method, params, ctx)
-  return { dir, stub, secretsFile, call }
+  return { dir, stub, voiceStub, secretsFile, voiceConfigFile, integrations, call }
 }
 
 const refused = (res, code) => {
@@ -155,3 +193,70 @@ test('linear.*: a Linear that fails is TOOL_ERROR; bad arguments are BAD_REQUEST
 test('linear.*: a server without integrations answers NOT_FOUND', async () => {
   refused(await dispatchV2('linear.status', {}, {}), 'NOT_FOUND')
 })
+
+test('voice.setKey checks the key by listing its voices, picks the first voice, and never sends the key back', async (t) => {
+  const s = await setup(t)
+  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: '', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: false })
+  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'bad' })).result, { ok: false, error: 'ElevenLabs rejected the API key' })
+  const set = await s.call('voice.setKey', { apiKey: 'good-voice' })
+  assert.deepEqual(set.result, { ok: true, voices: [{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }] })
+  assert.equal(JSON.stringify(set).includes('good-voice'), false)
+  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: 'v1', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: true })
+  assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600)
+  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { elevenlabs: 'good-voice' })
+  assert.deepEqual((await s.call('voice.voices', {})).result, [{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }])
+  // A voice already chosen is kept by a later key.
+  await s.call('voice.setConfig', { voiceId: 'v2' })
+  await s.call('voice.setKey', { apiKey: 'good-voice' })
+  assert.equal((await s.call('voice.settings', {})).result.voiceId, 'v2')
+  // ifAbsent keeps the stored key without a request.
+  const before = s.voiceStub.requests.length
+  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'other', ifAbsent: true })).result, { ok: false, error: 'This server already has a key; it was kept', present: true })
+  assert.equal(s.voiceStub.requests.length, before)
+  assert.equal((await s.call('voice.clearKey', {})).ok, true)
+  assert.equal((await s.call('voice.settings', {})).result.hasKey, false)
+  refused(await s.call('voice.voices', {}), 'TOOL_ERROR')
+})
+
+test('voice.setConfig checks each field; voice.synthesize speaks in the chosen voice and model, to this connection', async (t) => {
+  const s = await setup(t)
+  refused(await s.call('voice.synthesize', { text: 'Hi' }), 'TOOL_ERROR')
+  await s.call('voice.setKey', { apiKey: 'good-voice' })
+  const config = await s.call('voice.setConfig', { modelId: 'eleven_turbo_v2_5', promptSessions: true })
+  assert.deepEqual(config.result, { voiceId: 'v1', modelId: 'eleven_turbo_v2_5', promptSessions: true })
+  assert.deepEqual(JSON.parse(readFileSync(s.voiceConfigFile, 'utf8')), config.result)
+  assert.equal(s.integrations.voice.promptSessions(), true)
+  const spoken = await s.call('voice.synthesize', { text: ' Hello there. ' })
+  assert.equal(Buffer.from(spoken.result.audio, 'base64').toString(), 'mp3:v1:eleven_turbo_v2_5:Hello there.')
+  for (const params of [{ voiceId: '../x' }, { voiceId: '' }, { modelId: 'a b' }, { promptSessions: 'yes' }, { active: true }]) {
+    refused(await s.call('voice.setConfig', params), 'BAD_REQUEST')
+  }
+  refused(await s.call('voice.synthesize', { text: 'x'.repeat(401) }), 'BAD_REQUEST')
+  refused(await s.call('voice.synthesize', { text: '' }), 'BAD_REQUEST')
+  // Without a key, sessions are not told to speak whatever the setting.
+  await s.call('voice.clearKey', {})
+  assert.equal(s.integrations.voice.promptSessions(), false)
+})
+
+test('voice.*: an ElevenLabs that fails is TOOL_ERROR with its message', async (t) => {
+  const s = await setup(t, { voice: { status: 429 } })
+  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'good-voice' })).result, { ok: false, error: 'ElevenLabs returned 429: quota exceeded' })
+  createSecretFile(s.secretsFile).set('elevenlabs', 'good-voice')
+  await s.call('voice.setConfig', { voiceId: 'v1' })
+  const res = await s.call('voice.synthesize', { text: 'Hi' })
+  refused(res, 'TOOL_ERROR')
+  assert.match(res.error.message, /429/)
+})
+
+test('TopicHub.emit reaches the subscribers that take events and counts the ones it was sent to', () => {
+  const hub = new TopicHub()
+  hub.publish('project:p', {})
+  const got = []
+  hub.subscribe('project:p', { send() {}, event: (e, p) => (got.push([e, p]), true) })
+  hub.subscribe('project:p', { send() {}, event: () => false })
+  hub.subscribe('project:p', { send() {} })
+  hub.subscribe('project:p', { send() {}, event: () => { throw new Error('boom') } })
+  assert.equal(hub.emit('project:p', 'voice.summary', { x: 1 }), 1)
+  assert.deepEqual(got, [['voice.summary', { x: 1 }]])
+  assert.equal(hub.emit('project:nope', 'voice.summary', {}), 0)
+})
diff --git a/scripts/serverLaunch.test.mjs b/scripts/serverLaunch.test.mjs
index 65bacce..fd39fc6 100644
--- a/scripts/serverLaunch.test.mjs
+++ b/scripts/serverLaunch.test.mjs
@@ -41,6 +41,17 @@ test('global sessions get the global prompt and addDirs; the role prompt only wi
   assert.match(withMcp.command, /--mcp-config '\/c.json'/)
 })
 
+test('the voice prompt goes first for a worktree session, after the role for a Global one, and only with MCP', () => {
+  const mcp = { configPath: '/c.json', url: 'http://x/mcp', token: 't', geminiSettingsPath: '/g.json' }
+  const worktree = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', voicePrompt: 'VOICE', mcp }, { sessionSystemPrompt: 'SHARED' }, DEFAULT_LLM_SETTINGS)
+  assert.match(worktree.command, /--append-system-prompt 'VOICE\n\nTYPE\n\nSHARED'/)
+  const global = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, voicePrompt: 'VOICE', mcp }, { globalSystemPrompt: 'G' }, DEFAULT_LLM_SETTINGS)
+  assert.match(global.command, /global Claude session[^']*\n\nVOICE\n\nG'/)
+  // Without the MCP tools there is no speak_summary to call.
+  const noMcp = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', voicePrompt: 'VOICE' }, {}, DEFAULT_LLM_SETTINGS)
+  assert.match(noMcp.command, /--append-system-prompt 'TYPE'/)
+})
+
 test('other providers, local backend env and an invalid selection', () => {
   assert.match(agentCommand({ ...base, llm: { provider: 'codex' } }, {}, DEFAULT_LLM_SETTINGS).command, /^codex --full-auto/)
   const local = agentCommand({ ...base, llm: { provider: 'local' } }, {}, { llmDefault: { provider: 'claude' }, providers: { local: { backend: 'lmstudio' } } })
diff --git a/scripts/serverMcpTools.test.mjs b/scripts/serverMcpTools.test.mjs
index a85cbb7..f92357e 100644
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -104,7 +104,7 @@ async function toolSetup(t, opts = {}) {
     job.fired = true
     job.fn()
   }
-  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir }
+  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir, hub }
 }
 
 test('the tool list matches decision 5', () => {
@@ -112,7 +112,7 @@ test('the tool list matches decision 5', () => {
     'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session',
     'list_session_types', 'list_worktrees', 'load_worktree', 'read_terminal', 'remove_queued_prompt',
     'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
-    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'start_session', 'unload_worktree',
+    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'unload_worktree',
     'wait_for_sessions'
   ])
 })
@@ -626,3 +626,48 @@ test('read_terminal clamps lines', async (t) => {
   assert.equal(await read(2.5), 'two\nthree')
   assert.equal(await read(1e9), 'one\ntwo\nthree')
 })
+
+/** A voice service stub: `hasKey`, and an mp3 that is the text's bytes. */
+const voiceStub = (hasKey = true) => {
+  const spoken = []
+  return {
+    spoken,
+    settings: () => ({ hasKey, voiceId: 'v1', modelId: 'm', promptSessions: false }),
+    synthesize: async (text) => {
+      spoken.push(text)
+      return new TextEncoder().encode(`mp3:${text}`)
+    }
+  }
+}
+
+test('speak_summary sends the clip to every window that has the project open', async (t) => {
+  const voice = voiceStub()
+  const s = await toolSetup(t, { voice })
+  const { terminalId } = await s.call('start_session', { worktree: 'main' })
+  const topic = `project:${s.projectId}`
+  const windows = [[], [], []]
+  const subscribers = windows.map((got, i) => ({ send() {}, event: (event, payload) => (i === 2 ? false : (got.push([event, payload]), true)) }))
+  // Nobody listening: nothing synthesized.
+  assert.deepEqual(await s.call('speak_summary', { terminalId, summary: 'Done.' }), { played: false, reason: 'No Trek window has this project open, so nobody would hear it' })
+  assert.deepEqual(voice.spoken, [])
+  for (const sub of subscribers) s.hub.subscribe(topic, sub)
+  // The third window is congested: it does not count.
+  assert.deepEqual(await s.call('speak_summary', { terminalId, summary: '  The tests pass.  ' }), { played: true, windows: 2 })
+  const audio = Buffer.from('mp3:The tests pass.').toString('base64')
+  for (const got of windows.slice(0, 2)) assert.deepEqual(got, [['voice.summary', { projectId: s.projectId, sessionId: terminalId, text: 'The tests pass.', audio }]])
+  await assert.rejects(s.call('speak_summary', { terminalId, summary: 'x'.repeat(401) }), /401 characters/)
+  await assert.rejects(s.call('speak_summary', { terminalId, summary: ' ' }), /summary is required/)
+  await assert.rejects(s.call('speak_summary', { terminalId: 'nope', summary: 'Hi' }), /No session/)
+  assert.deepEqual(voice.spoken, ['The tests pass.'])
+})
+
+test('speak_summary without a key (or without voice) says it is not set up', async (t) => {
+  for (const voice of [voiceStub(false), undefined]) {
+    const s = await toolSetup(t, voice ? { voice } : {})
+    const { terminalId } = await s.call('start_session', { worktree: 'main' })
+    s.hub.subscribe(`project:${s.projectId}`, { send() {}, event: () => true })
+    const result = await s.call('speak_summary', { terminalId, summary: 'Hi' })
+    assert.equal(result.played, false)
+    assert.match(result.reason, /not set up/)
+  }
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index ddd7fa7..26d59a1 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 93a3a7d..8484246 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -163,7 +163,7 @@ async function nextPatch(conn, topic, state, timeoutMs = 4000) {
 const v2 = await connect(2, token)
 if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
   fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
-} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear'].every((c) => v2.welcome.capabilities?.includes(c))) {
+} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice'].every((c) => v2.welcome.capabilities?.includes(c))) {
   fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
 } else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index bc84205..931435e 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -4,7 +4,8 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 /**
  * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
  * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
- * `linear` says it serves `linear.*`; whether it has a key is `linear.status`'s answer.
+ * `linear` and `voice` say it serves `linear.*` and `voice.*`; whether it has a key is
+ * `linear.status`'s and `voice.settings`' answer.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -14,7 +15,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.docker,
   CAPABILITY.env,
   CAPABILITY.stacks,
-  CAPABILITY.linear
+  CAPABILITY.linear,
+  CAPABILITY.voice
 ]
 
 /** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
diff --git a/server/src/index.ts b/server/src/index.ts
index c45a710..33e4b8e 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -19,7 +19,7 @@ import { ProjectStore } from './projects/store'
 import { formatRepoList } from './repos'
 import { startServer } from './server'
 import { createMachine } from './integrations/machine'
-import { createIntegrations } from './integrations/integrations'
+import { createIntegrations, VOICE_CONFIG_FILE } from './integrations/integrations'
 import { secretsPathFor } from './secrets'
 import { seedEnvironmentsFromApp } from './integrations/envSeed'
 import {
@@ -456,7 +456,9 @@ const server = startServer(
     machine: createMachine(serverDataDir, { local: local !== undefined }),
     integrations: createIntegrations({
       secretsFile: secretsPathFor(resolve(args.configPath)),
-      linearEndpoint: process.env.TREK_SERVER_LINEAR_URL || undefined
+      linearEndpoint: process.env.TREK_SERVER_LINEAR_URL || undefined,
+      voiceConfigFile: resolve(serverDataDir, VOICE_CONFIG_FILE),
+      elevenLabsApi: process.env.TREK_SERVER_ELEVENLABS_URL || undefined
     })
   }
 )
diff --git a/server/src/integrations/integrationHandlers.ts b/server/src/integrations/integrationHandlers.ts
index 424f0b4..52a236a 100644
--- a/server/src/integrations/integrationHandlers.ts
+++ b/server/src/integrations/integrationHandlers.ts
@@ -1,6 +1,8 @@
-// Linear with the server's own API key (phase 5b; capability `linear`). Before 5b the app's main
-// process kept one key for every window; now each server has its own, in its secrets file
-// (secrets.ts), set from any client and never sent back.
+// Linear and ElevenLabs with the server's own API keys (phase 5b; capabilities `linear` and
+// `voice`). Before 5b the app's main process kept one key of each for every window; now each server
+// has its own, in its secrets file (secrets.ts), set from any client and never sent back.
+import { MAX_SPOKEN_CHARS } from '../../../src/host/voiceService.ts'
+import type { VoiceServerConfig } from '../../../src/shared/types'
 import type { V2Context } from '../v2.ts'
 import { codedError } from '../errors.ts'
 import type { Integrations } from './integrations.ts'
@@ -36,6 +38,37 @@ function requireIssueIds(value: unknown): string[] {
   return value as string[]
 }
 
+/** An ElevenLabs voice id (alphanumeric; it goes into the request's path, encoded too). */
+const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
+const MODEL_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/
+
+function requireVoicePatch(p: Record<string, unknown>): Partial<VoiceServerConfig> {
+  const patch: Partial<VoiceServerConfig> = {}
+  for (const key of Object.keys(p)) {
+    if (key !== 'voiceId' && key !== 'modelId' && key !== 'promptSessions') throw bad(`${key} is not a voice setting`)
+  }
+  if (p.voiceId !== undefined) {
+    if (typeof p.voiceId !== 'string' || !VOICE_ID_RE.test(p.voiceId)) throw bad('voiceId must be an ElevenLabs voice id')
+    patch.voiceId = p.voiceId
+  }
+  if (p.modelId !== undefined) {
+    if (typeof p.modelId !== 'string' || !MODEL_ID_RE.test(p.modelId)) throw bad('modelId must be an ElevenLabs model id')
+    patch.modelId = p.modelId
+  }
+  if (p.promptSessions !== undefined) patch.promptSessions = optionalFlag(p.promptSessions, 'promptSessions')
+  return patch
+}
+
+/** The text to speak: trimmed, not empty, at most MAX_SPOKEN_CHARS. */
+export function requireSpokenText(value: unknown, field: string): string {
+  if (typeof value !== 'string' || !value.trim()) throw bad(`${field} is required`)
+  const text = value.trim()
+  if (text.length > MAX_SPOKEN_CHARS) {
+    throw bad(`${field} is ${text.length} characters; keep it to one to three short sentences (at most ${MAX_SPOKEN_CHARS})`)
+  }
+  return text
+}
+
 export const integrations = (ctx: V2Context): Integrations => {
   if (!ctx.integrations) throw codedError('NOT_FOUND', 'this server has no integrations')
   return ctx.integrations
@@ -70,5 +103,31 @@ export const integrationHandlers: Record<string, Handler> = {
   'linear.issues': (p, ctx) => {
     const ids = requireIssueIds(p.ids)
     return viaService(() => integrations(ctx).linear.issues(ids))
+  },
+
+  'voice.settings': (_p, ctx) => viaService(() => integrations(ctx).voice.settings()),
+
+  'voice.setKey': (p, ctx) => {
+    const apiKey = requireApiKey(p.apiKey)
+    const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
+    return integrations(ctx).voice.setKey(apiKey, { ifAbsent })
+  },
+
+  'voice.clearKey': (_p, ctx) =>
+    viaService(() => {
+      integrations(ctx).voice.clearKey()
+      return null
+    }),
+
+  'voice.voices': (_p, ctx) => viaService(() => integrations(ctx).voice.voices()),
+
+  'voice.setConfig': (p, ctx) => {
+    const patch = requireVoicePatch(p)
+    return viaService(() => integrations(ctx).voice.setConfig(patch))
+  },
+
+  'voice.synthesize': (p, ctx) => {
+    const text = requireSpokenText(p.text, 'text')
+    return viaService(async () => ({ audio: Buffer.from(await integrations(ctx).voice.synthesize(text)).toString('base64') }))
   }
 }
diff --git a/server/src/integrations/integrations.ts b/server/src/integrations/integrations.ts
index 189e391..ab80266 100644
--- a/server/src/integrations/integrations.ts
+++ b/server/src/integrations/integrations.ts
@@ -1,13 +1,19 @@
-// The server's integrations with outside services (phase 5b): Linear, with the server's own key in
-// its secrets file. Made once per server (index.ts) and handed to the handlers through V2Context.
+// The server's integrations with outside services (phase 5b): Linear and ElevenLabs, each with the
+// server's own key in its secrets file. Made once per server (index.ts) and handed to the handlers
+// through V2Context, and to the speak_summary tool and the sessions' launch.
 import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
+import { createVoiceService, type VoiceService } from '../../../src/host/voiceService.ts'
 import { createSecretFile, type SecretFile } from '../secrets.ts'
 
 /** The secrets file's names. */
 export const LINEAR_SECRET = 'linear'
+export const ELEVENLABS_SECRET = 'elevenlabs'
+/** `<dataDir>/voice.json`: the server's voice, model and "Summarize automatically" (no secret) */
+export const VOICE_CONFIG_FILE = 'voice.json'
 
 export interface Integrations {
   linear: LinearService
+  voice: VoiceService
 }
 
 export interface IntegrationOptions {
@@ -18,6 +24,10 @@ export interface IntegrationOptions {
    * `TREK_SERVER_LINEAR_URL` from its environment for its smokes.
    */
   linearEndpoint?: string
+  /** `voice.json` in the data dir */
+  voiceConfigFile: string
+  /** ElevenLabs' API base (default api.elevenlabs.io/v1); `TREK_SERVER_ELEVENLABS_URL` for the smokes */
+  elevenLabsApi?: string
 }
 
 export function keySlot(file: SecretFile, name: string): KeySlot {
@@ -31,6 +41,7 @@ export function keySlot(file: SecretFile, name: string): KeySlot {
 export function createIntegrations(options: IntegrationOptions): Integrations {
   const secrets = createSecretFile(options.secretsFile)
   return {
-    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint })
+    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint }),
+    voice: createVoiceService({ key: keySlot(secrets, ELEVENLABS_SECRET), configFile: options.voiceConfigFile, api: options.elevenLabsApi })
   }
 }
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index f19a3c5..65eb81c 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -21,6 +21,9 @@ import type { TopicHub } from '../topicHub'
 import { dispatchV2, type V2Context } from '../v2.ts'
 import { describeWorktree, resolveWorktree } from './describe.ts'
 import type { ToolDefinition } from './protocol.ts'
+import { projectTopic } from '../../../src/shared/model/topics.ts'
+import type { VoiceService } from '../../../src/host/voiceService.ts'
+import { requireSpokenText } from '../integrations/integrationHandlers.ts'
 
 const WORKTREE_PARAM = {
   type: 'string',
@@ -76,6 +79,19 @@ export const MCP_TOOLS: ToolDefinition[] = [
       required: ['terminalId', 'question']
     }
   },
+  {
+    name: 'speak_summary',
+    description:
+      "Read a short spoken summary aloud to the user through the Trek server's ElevenLabs voice. Keep it SHORT: one to three plain sentences (max 400 characters), written to be heard — no markdown, code, file paths, URLs or lists. Use it only when your instructions or the user ask for spoken summaries. It plays in every Trek window that has this project open, one summary at a time, and is skipped where the user is set to Busy, so never repeat it. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
+    inputSchema: {
+      type: 'object',
+      properties: {
+        terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
+        summary: { type: 'string', description: 'One to three short spoken sentences, at most 400 characters' }
+      },
+      required: ['terminalId', 'summary']
+    }
+  },
   {
     name: 'create_worktree',
     description:
@@ -302,6 +318,8 @@ export interface ToolDeps {
   projects: ProjectState
   poller: GitPoller
   sessions: SessionManager
+  /** ElevenLabs with the server's key, for speak_summary; without it the tool says voice is not set up */
+  voice?: VoiceService
   /** How often waits re-check session state (default 250 ms) */
   pollMs?: number
   /** wait_for_sessions waits this long first when its condition already holds (default 1.5 s) */
@@ -788,6 +806,26 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         return { notified: true }
       },
 
+      speak_summary: async (args) => {
+        // Global sessions may speak too, so this does not go through targetIn.
+        const { session } = sessionIn(args.terminalId)
+        const summary = requireSpokenText(args.summary, 'summary')
+        const notSetUp = { played: false, reason: 'Voice summaries are not set up on this Trek server — do not call speak_summary again' }
+        let ready = false
+        try {
+          ready = deps.voice?.settings().hasKey === true
+        } catch {
+          // An unreadable secrets file: not set up.
+        }
+        if (!ready) return notSetUp
+        const topic = projectTopic(projectId)
+        const nobody = { played: false, reason: 'No Trek window has this project open, so nobody would hear it' }
+        if (deps.hub.subscriberCount(topic) === 0) return nobody
+        const audio = Buffer.from(await deps.voice!.synthesize(summary)).toString('base64')
+        const windows = deps.hub.emit(topic, 'voice.summary', { projectId, sessionId: session.id, text: summary, audio })
+        return windows > 0 ? { played: true, windows } : nobody
+      },
+
       close_session: async (args) => {
         const { session } = targetIn(args.terminalId)
         await v2('session.close', { sessionId: session.id })
diff --git a/server/src/server.ts b/server/src/server.ts
index d60a5eb..8220b34 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -22,11 +22,12 @@ import { TopicHub, type Subscriber } from './topicHub'
 import { dispatchV2, responseRev } from './v2'
 import { GitPoller } from './git/poller'
 import { SessionManager } from './sessions/manager'
-import type { TerminalSink } from './sessions/terminalHost'
+import { SINK_HIGH_WATER, type TerminalSink } from './sessions/terminalHost'
 import { McpAccessStore } from './mcp/access'
 import { startMcpListener, type McpListener } from './mcp/listener'
 import { createToolCaller, type ToolCall, MCP_INSTRUCTIONS, MCP_TOOLS } from './mcp/tools'
 import { createEventSink, type Machine } from './integrations/machineHandlers'
+import { VOICE_SUMMARY_PROMPT } from '../../src/shared/providers/prompts.ts'
 import type { Integrations } from './integrations/integrations'
 
 const HELLO_TIMEOUT_MS = 5000
@@ -99,7 +100,8 @@ export function startServer(
     projects,
     store,
     hub,
-    mcpAccess: access ? (projectId) => access.accessFor(projectId) : undefined
+    mcpAccess: access ? (projectId) => access.accessFor(projectId) : undefined,
+    voicePrompt: () => (options.integrations?.voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined)
   })
 
   /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
@@ -161,6 +163,12 @@ export function startServer(
       },
       ended(topic, reason) {
         sendFrame(ws, { type: 'event', event: 'topic.ended', payload: { topic, reason } })
+      },
+      // A spoken summary to a connection that has fallen behind is dropped: it would play late.
+      event(event, payload) {
+        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > SINK_HIGH_WATER) return false
+        sendFrame(ws, { type: 'event', event, payload })
+        return true
       }
     }
 
@@ -329,7 +337,7 @@ export function startServer(
     shutdown: (reason) => shutdown(reason)
   }
   if (access) {
-    const caller = createToolCaller({ store, hub, projects, poller, sessions })
+    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice })
     const callerFor = (projectId: string): ToolCall => {
       let call = callers.get(projectId)
       if (!call) callers.set(projectId, (call = caller(projectId)))
diff --git a/server/src/sessions/launch.ts b/server/src/sessions/launch.ts
index f877672..cef32fd 100644
--- a/server/src/sessions/launch.ts
+++ b/server/src/sessions/launch.ts
@@ -16,6 +16,8 @@ export interface AgentLaunch {
   global: boolean
   /** The session type's prompt (worktree sessions) */
   systemPrompt?: string
+  /** The voice summary prompt (phase 5b); only for an agent that gets the MCP tools, which has speak_summary */
+  voicePrompt?: string
   /** Sent only on a fresh start */
   initialMessage?: string
   addDirs?: string[]
@@ -29,9 +31,10 @@ export function agentCommand(launch: AgentLaunch, settings: ProjectSettings, llm
   const config = llm.providers[provider.id] ?? {}
   const isClaude = provider.id === 'claude'
   const mcp = launch.mcp && provider.capabilities.mcp ? launch.mcp : undefined
+  const voice = mcp ? launch.voicePrompt : undefined
   const prompts = launch.global
-    ? [mcp ? (isClaude ? GLOBAL_SYSTEM_PROMPT : globalAgentPrompt(provider.label)) : undefined, settings.globalSystemPrompt?.trim()]
-    : [launch.systemPrompt?.trim(), settings.sessionSystemPrompt?.trim()]
+    ? [mcp ? (isClaude ? GLOBAL_SYSTEM_PROMPT : globalAgentPrompt(provider.label)) : undefined, voice, settings.globalSystemPrompt?.trim()]
+    : [voice, launch.systemPrompt?.trim(), settings.sessionSystemPrompt?.trim()]
   const systemPrompt = prompts.filter(Boolean).join('\n\n') || undefined
   return provider.buildLaunch({
     sessionId: launch.sessionId,
diff --git a/server/src/sessions/manager.ts b/server/src/sessions/manager.ts
index b365e5e..2df87d9 100644
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -61,6 +61,8 @@ export interface SessionManagerDeps {
   now?: () => number
   /** The MCP access a project's sessions launch with; without it sessions launch without MCP */
   mcpAccess?: (projectId: string) => McpAccess | undefined
+  /** Added to the prompt of a session that has the MCP tools: the voice summary prompt while it is on (phase 5b) */
+  voicePrompt?: () => string | undefined
   /** Whether a program resolves in the login shell (server.agents); default agentService.commandExists */
   commandExists?: (binary: string) => Promise<boolean>
 }
@@ -603,6 +605,7 @@ export class SessionManager {
         resume: launch.resume,
         global: !worktree,
         systemPrompt: session.systemPrompt,
+        voicePrompt: this.deps.voicePrompt?.(),
         initialMessage: launch.resume ? undefined : run.initialMessage,
         addDirs
       },
diff --git a/server/src/topicHub.ts b/server/src/topicHub.ts
index 9501803..e0f5c5b 100644
--- a/server/src/topicHub.ts
+++ b/server/src/topicHub.ts
@@ -11,6 +11,8 @@ export interface Subscriber {
   send(topic: Topic, rev: number, ops: PatchOp[]): void
   /** The topic stopped for good (see `drop`); without it the subscriber is just forgotten */
   ended?(topic: Topic, reason: TopicEndReason): void
+  /** An event for the topic's subscribers (`voice.summary`); false when it was not sent (a congested connection) */
+  event?(event: string, payload: unknown): boolean
 }
 
 interface TopicEntry {
@@ -103,6 +105,25 @@ export class TopicHub {
     }
   }
 
+  /**
+   * Sends an event to each of the topic's subscribers that takes events (a connection: not an MCP
+   * tool call's no-op subscriber). Returns how many it went to. One that throws is logged and skipped.
+   */
+  emit(topic: Topic, event: string, payload: unknown): number {
+    const entry = this.topics.get(topic)
+    if (!entry) return 0
+    let sent = 0
+    for (const subscriber of [...entry.subscribers]) {
+      if (!subscriber.event) continue
+      try {
+        if (subscriber.event(event, payload)) sent += 1
+      } catch (err) {
+        console.warn(`topic ${topic}: sending ${event} to a subscriber failed`, err)
+      }
+    }
+    return sent
+  }
+
   unsubscribe(topic: Topic, subscriber: Subscriber): void {
     this.topics.get(topic)?.subscribers.delete(subscriber)
   }
diff --git a/src/host/voiceService.ts b/src/host/voiceService.ts
new file mode 100644
index 0000000..80321b9
--- /dev/null
+++ b/src/host/voiceService.ts
@@ -0,0 +1,146 @@
+// ElevenLabs voice summaries with the server's API key (phase 5b; main's voice.ts before it).
+// Electron-free: the key is in a slot the caller owns (the server's secrets file), the voice and
+// model in a JSON file, and the API's base URL can be pointed at a test's stub server.
+import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
+import { dirname } from 'node:path'
+import type { VoiceInfo, VoiceKeyResult, VoiceServerConfig, VoiceServerSettings } from '../shared/types'
+import { PRESENT_ERROR, type KeySlot } from './linearService.ts'
+
+export const ELEVENLABS_API = 'https://api.elevenlabs.io/v1'
+/** The longest text synthesized (the speak_summary tool's limit): one to three short sentences. */
+export const MAX_SPOKEN_CHARS = 400
+const TIMEOUT_MS = 30_000
+
+export const DEFAULT_VOICE_CONFIG: Readonly<VoiceServerConfig> = Object.freeze({
+  voiceId: '',
+  modelId: 'eleven_flash_v2_5',
+  promptSessions: false
+})
+
+export interface VoiceService {
+  settings(): VoiceServerSettings
+  /**
+   * Checks the key by listing its voices, stores it and picks the first voice if none is chosen.
+   * `ifAbsent`: only while no key is stored (the app's hand-over), else `{ ok: false, present: true }`.
+   */
+  setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<VoiceKeyResult>
+  clearKey(): void
+  voices(): Promise<VoiceInfo[]>
+  setConfig(patch: Partial<VoiceServerConfig>): VoiceServerConfig
+  /** An mp3 of `text` in the chosen voice */
+  synthesize(text: string): Promise<Uint8Array>
+  /** Sessions are told to speak: a key is set and "Summarize automatically" is on */
+  promptSessions(): boolean
+}
+
+/** Written then renamed, so a reader never sees half a file. */
+function writeAtomic(path: string, text: string): void {
+  mkdirSync(dirname(path), { recursive: true })
+  const tmp = `${path}.${process.pid}.tmp`
+  try {
+    rmSync(tmp, { force: true })
+    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
+    renameSync(tmp, path)
+  } catch (err) {
+    rmSync(tmp, { force: true })
+    throw err
+  }
+}
+
+export function createVoiceService(options: { key: KeySlot; configFile: string; api?: string; fetch?: typeof fetch }): VoiceService {
+  const api = options.api ?? ELEVENLABS_API
+  const doFetch = options.fetch ?? fetch
+
+  /** A missing or unreadable file is the defaults (it holds no secret); known fields of the right type are kept. */
+  const readConfig = (): VoiceServerConfig => {
+    let raw: unknown
+    try {
+      raw = JSON.parse(readFileSync(options.configFile, 'utf8'))
+    } catch {
+      return { ...DEFAULT_VOICE_CONFIG }
+    }
+    const from = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
+    return {
+      voiceId: typeof from.voiceId === 'string' ? from.voiceId : DEFAULT_VOICE_CONFIG.voiceId,
+      modelId: typeof from.modelId === 'string' && from.modelId ? from.modelId : DEFAULT_VOICE_CONFIG.modelId,
+      promptSessions: typeof from.promptSessions === 'boolean' ? from.promptSessions : DEFAULT_VOICE_CONFIG.promptSessions
+    }
+  }
+
+  const setConfig = (patch: Partial<VoiceServerConfig>): VoiceServerConfig => {
+    const next = { ...readConfig(), ...patch }
+    writeAtomic(options.configFile, JSON.stringify(next, null, 2) + '\n')
+    return next
+  }
+
+  async function request(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
+    const res = await doFetch(`${api}${path}`, {
+      ...init,
+      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', ...init.headers },
+      signal: AbortSignal.timeout(TIMEOUT_MS)
+    })
+    if (res.status === 401) throw new Error('ElevenLabs rejected the API key')
+    if (!res.ok) {
+      const body = await res.text().catch(() => '')
+      throw new Error(`ElevenLabs returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
+    }
+    return res
+  }
+
+  async function fetchVoices(apiKey: string): Promise<VoiceInfo[]> {
+    const res = await request(apiKey, '/voices')
+    const { voices } = (await res.json()) as { voices?: { voice_id: unknown; name: unknown }[] }
+    return (Array.isArray(voices) ? voices : []).map((v) => ({ id: String(v.voice_id), name: String(v.name) }))
+  }
+
+  const requireKey = (): string => {
+    const apiKey = options.key.get()
+    if (!apiKey) throw new Error('No ElevenLabs API key is set on this server')
+    return apiKey
+  }
+
+  return {
+    settings: () => ({ ...readConfig(), hasKey: !!options.key.get() }),
+
+    async setKey(apiKey, { ifAbsent = false } = {}) {
+      if (ifAbsent && options.key.get()) return { ok: false, error: PRESENT_ERROR, present: true }
+      try {
+        const voices = await fetchVoices(apiKey)
+        if (ifAbsent) {
+          if (!options.key.setIfAbsent(apiKey)) return { ok: false, error: PRESENT_ERROR, present: true }
+        } else options.key.set(apiKey)
+        if (!readConfig().voiceId && voices[0]) setConfig({ voiceId: voices[0].id })
+        return { ok: true, voices }
+      } catch (err) {
+        return { ok: false, error: err instanceof Error ? err.message : String(err) }
+      }
+    },
+
+    clearKey: () => options.key.set(null),
+
+    voices: () => fetchVoices(requireKey()),
+
+    setConfig,
+
+    async synthesize(text) {
+      const apiKey = requireKey()
+      const { voiceId, modelId } = readConfig()
+      if (!voiceId) throw new Error('No ElevenLabs voice is selected on this server')
+      const res = await request(apiKey, `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
+        method: 'POST',
+        headers: { Accept: 'audio/mpeg' },
+        body: JSON.stringify({ text, model_id: modelId })
+      })
+      return new Uint8Array(await res.arrayBuffer())
+    },
+
+    promptSessions: () => {
+      try {
+        return !!options.key.get() && readConfig().promptSessions
+      } catch {
+        // An unreadable secrets file: launch the session without the prompt.
+        return false
+      }
+    }
+  }
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 97a2c5d..8fd00cf 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -27,6 +27,10 @@ import type {
   LinearIssue,
   LinearKeyResult,
   StackLogChunk,
+  VoiceInfo,
+  VoiceKeyResult,
+  VoiceServerConfig,
+  VoiceServerSettings,
   StackStatus,
   WorktreeChanges
 } from './types.ts'
@@ -177,7 +181,12 @@ export const CAPABILITY = {
   /** `stack.*` run the worktrees' docker/stack/stack.sh dev stacks on the server's machine */
   stacks: 'stacks',
   /** `linear.*` look up Linear issues with the server's own API key (set from any client, never read back) */
-  linear: 'linear'
+  linear: 'linear',
+  /**
+   * `voice.*` keep the server's ElevenLabs key and voice; its speak_summary tool sends each spoken
+   * summary to the project's subscribers as `voice.summary`
+   */
+  voice: 'voice'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -372,6 +381,21 @@ export interface MethodParamsV2 {
   /** The issues with these ids (e.g. TOW-123) that exist and the key can see; none without a key */
   'linear.issues': { ids: string[] }
 
+  // ElevenLabs voice summaries, with the server's API key (capability `voice`)
+  /** The server's voice, model and "Summarize automatically", and whether it has a key */
+  'voice.settings': Record<string, never>
+  /**
+   * Checks the key by listing its voices and stores it on the server (0600, never sent back); picks
+   * the first voice if none is chosen. `ifAbsent` as `linear.setKey`'s.
+   */
+  'voice.setKey': { apiKey: string; ifAbsent?: boolean }
+  'voice.clearKey': Record<string, never>
+  /** The key's voices */
+  'voice.voices': Record<string, never>
+  'voice.setConfig': Partial<VoiceServerConfig>
+  /** An mp3 of `text` (at most 400 characters), for this connection only: Settings' Test */
+  'voice.synthesize': { text: string }
+
   // Subscriptions
   'sub.subscribe': { topic: Topic }
   'sub.unsubscribe': { topic: Topic }
@@ -471,6 +495,13 @@ export interface MethodResultsV2 {
   'linear.setKey': LinearKeyResult
   'linear.clearKey': null
   'linear.issues': LinearIssue[]
+  'voice.settings': VoiceServerSettings
+  'voice.setKey': VoiceKeyResult
+  'voice.clearKey': null
+  'voice.voices': VoiceInfo[]
+  'voice.setConfig': VoiceServerConfig
+  /** The mp3, base64 */
+  'voice.synthesize': { audio: string }
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
@@ -514,4 +545,18 @@ export interface EventPayloadsV2 {
   'docker.log': DockerLogEvent
   /** An `env.up`, `env.stop` or `env.destroy`'s output and steps, to the connection that asked for it only */
   'env.log': EnvLogEvent
+  /**
+   * A session's spoken summary (the speak_summary tool), to every connection subscribed to its
+   * project's topic; a client plays it unless its user is Busy
+   */
+  'voice.summary': VoiceSummaryEvent
+}
+
+export interface VoiceSummaryEvent {
+  projectId: string
+  /** The session that spoke (its terminalId) */
+  sessionId: string
+  text: string
+  /** The mp3, base64 */
+  audio: string
 }
diff --git a/src/shared/providers/prompts.ts b/src/shared/providers/prompts.ts
index 00c09f2..97c4870 100644
--- a/src/shared/providers/prompts.ts
+++ b/src/shared/providers/prompts.ts
@@ -7,3 +7,10 @@ export const GLOBAL_SYSTEM_PROMPT =
 export function globalAgentPrompt(label: string): string {
   return `You are the global ${label} session of Trek Dev, an app that runs coding-agent sessions (Claude Code, Codex, Gemini and others) across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their sessions.`
 }
+
+/**
+ * Added to sessions that have the trek-dev tools while the server has an ElevenLabs key and its
+ * voice settings' "Summarize automatically" is on (phase 5b; the desktop's before 4e).
+ */
+export const VOICE_SUMMARY_PROMPT =
+  "The user hears spoken summaries from Trek. Whenever you finish a task and end your turn, or stop to wait on the user, call the trek-dev speak_summary tool once with one to three short plain sentences saying what you did or what you need, then end your turn. Skip it for mid-task progress and trivial replies."
diff --git a/src/shared/types.ts b/src/shared/types.ts
index fe66a2d..a4cf800 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -687,4 +687,17 @@ export interface VoiceInfo {
   name: string
 }
 
-export type VoiceKeyResult = { ok: true; voices: VoiceInfo[] } | { ok: false; error: string }
+/** `present`: a set-if-absent (the app's hand-over) found a key already stored, and kept it. */
+export type VoiceKeyResult = { ok: true; voices: VoiceInfo[] } | { ok: false; error: string; present?: true }
+
+/** A server's ElevenLabs settings (phase 5b): its voice and model, and whether sessions are told to speak. */
+export interface VoiceServerConfig {
+  voiceId: string
+  modelId: string
+  /** Tell agent sessions to call speak_summary on their own when they finish or need the user. */
+  promptSessions: boolean
+}
+
+export interface VoiceServerSettings extends VoiceServerConfig {
+  hasKey: boolean
+}
````

- [ ] **Step 2: Run the tests**

Run: `node --test scripts/serverIntegrations.test.mjs scripts/serverMcpTools.test.mjs scripts/serverLaunch.test.mjs`
Expected: PASS: `voice.*` against the stub endpoint (the key check, the config's checks, a failing ElevenLabs as `TOOL_ERROR`); `TopicHub.emit`; `speak_summary` sending the clip to every window, and "not set up" without a key; the voice prompt only with MCP. The "nobody would hear it" path has no unit test: the implementer adds one (a project with no subscriber: `played: false`, and the stub saw no synthesis request).

- [ ] **Step 3: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/host/voiceService.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5b): voice on the server: voice.*, the speak_summary tool sends each clip to the project's windows (voice.summary), the voice prompt for sessions (capability voice)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

(`-a` is safe here: the tree held only this task's changes; check `git status` first.)

---

### Task 3: Skills on the server

**Files:**
- Create: `src/host/skillService.ts`
- Modify: `server/src/integrations/{integrations,integrationHandlers}.ts`, `server/src/capabilities.ts`, `src/shared/protocolV2.ts`
- Test: `scripts/serverIntegrations.test.mjs`; the capability lists

Decision 12.

- [ ] **Step 1: Apply the diff** (4f03065)

````diff
diff --git a/scripts/client-contract.mjs b/scripts/client-contract.mjs
index b2413fc..ff13d69 100644
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -106,7 +106,7 @@ const mirror = new TopicMirror(conn)
 const ptys = new PtyStream(conn)
 conn.connect()
 if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
-if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
+if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
 else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)
 
 // --- 2. server topic ---
diff --git a/scripts/serverIntegrations.test.mjs b/scripts/serverIntegrations.test.mjs
index ee46074..ee20770 100644
--- a/scripts/serverIntegrations.test.mjs
+++ b/scripts/serverIntegrations.test.mjs
@@ -1,15 +1,20 @@
-// scripts/serverIntegrations.test.mjs — the server's secrets file, linear.* and voice.* (phase 5b),
+// scripts/serverIntegrations.test.mjs — the server's secrets file, linear.*, voice.* and skills.list (phase 5b),
 // against local HTTP stubs of Linear's and ElevenLabs' APIs: nothing here reaches either service.
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import { createServer } from 'node:http'
-import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { execFileSync } from 'node:child_process'
+import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
 import { createIntegrations } from '../server/src/integrations/integrations.ts'
 import { dispatchV2 } from '../server/src/v2.ts'
 import { TopicHub } from '../server/src/topicHub.ts'
+import { saveConfig } from '../server/src/config.ts'
+import { ConfigStore } from '../server/src/configStore.ts'
+import { GitPoller } from '../server/src/git/poller.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
 
 const tempDir = (t) => {
   const dir = mkdtempSync(join(tmpdir(), 'trek-integrations-'))
@@ -260,3 +265,53 @@ test('TopicHub.emit reaches the subscribers that take events and counts the ones
   assert.deepEqual(got, [['voice.summary', { x: 1 }]])
   assert.equal(hub.emit('project:nope', 'voice.summary', {}), 0)
 })
+
+test("skills.list reads the worktree's .claude and the server user's ~/.claude; the project shadows the user", async (t) => {
+  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+  process.env.GIT_CONFIG_NOSYSTEM = '1'
+  const dir = realpathSync(tempDir(t))
+  const a = join(dir, 'repos', 'a')
+  execFileSync('git', ['init', '-q', '-b', 'main', a])
+  execFileSync('git', ['-C', a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'])
+  const write = (path, text) => {
+    mkdirSync(join(path, '..'), { recursive: true })
+    writeFileSync(path, text)
+  }
+  write(join(a, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: "Review the branch"\n---\nbody')
+  write(join(a, '.claude', 'commands', 'ship.md'), 'no frontmatter')
+  const home = join(dir, 'home')
+  write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: the user one\n---\n')
+  write(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), `---\ndescription: ${'x'.repeat(130)}\n---\n`)
+  mkdirSync(join(home, '.claude', 'skills', 'empty'), { recursive: true })
+  write(join(home, '.claude', 'commands', 'todo.md'), '---\ndescription: List todos\n---\n')
+  const configPath = join(dir, 'config.json')
+  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
+  const store = new ConfigStore(configPath)
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
+  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
+  t.after(() => {
+    poller.stop()
+    store.close()
+  })
+  const integrations = createIntegrations({ secretsFile: join(dir, 'secrets.json'), voiceConfigFile: join(dir, 'voice.json'), home })
+  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, integrations }
+  const call = (method, params) => dispatchV2(method, params, ctx)
+  const projectId = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result.projectId
+  await poller.refresh(a)
+  const main = projects.require(projectId).repositories[0].worktrees[0]
+  const listed = await call('skills.list', { projectId, worktreeId: main.id })
+  assert.deepEqual(listed.result, [
+    { name: 'review', description: 'Review the branch', source: 'project', kind: 'skill' },
+    { name: 'ship', description: undefined, source: 'project', kind: 'command' },
+    { name: 'notes', description: `${'x'.repeat(120)}…`, source: 'user', kind: 'skill' },
+    { name: 'todo', description: 'List todos', source: 'user', kind: 'command' }
+  ])
+  // A row the guard does not cover; an unknown worktree.
+  const outside = realpathSync(tempDir(t))
+  projects.apply(projectId, (d) => {
+    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'x', isMain: false, loaded: false, sessions: [] })
+  })
+  refused(await call('skills.list', { projectId, worktreeId: 'out' }), 'PATH_DENIED')
+  refused(await call('skills.list', { projectId, worktreeId: 'nope' }), 'NOT_FOUND')
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 26d59a1..8370537 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
   assert.deepEqual(welcomeCapabilities(false), all)
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 8484246..b3da20a 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -163,7 +163,7 @@ async function nextPatch(conn, topic, state, timeoutMs = 4000) {
 const v2 = await connect(2, token)
 if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
   fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
-} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice'].every((c) => v2.welcome.capabilities?.includes(c))) {
+} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills'].every((c) => v2.welcome.capabilities?.includes(c))) {
   fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
 } else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 931435e..7030083 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -16,7 +16,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.env,
   CAPABILITY.stacks,
   CAPABILITY.linear,
-  CAPABILITY.voice
+  CAPABILITY.voice,
+  CAPABILITY.skills
 ]
 
 /** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
diff --git a/server/src/integrations/integrationHandlers.ts b/server/src/integrations/integrationHandlers.ts
index 52a236a..9699242 100644
--- a/server/src/integrations/integrationHandlers.ts
+++ b/server/src/integrations/integrationHandlers.ts
@@ -1,9 +1,10 @@
-// Linear and ElevenLabs with the server's own API keys (phase 5b; capabilities `linear` and
-// `voice`). Before 5b the app's main process kept one key of each for every window; now each server
+// Linear and ElevenLabs with the server's own API keys, and the skills on its disk (phase 5b;
+// capabilities `linear`, `voice` and `skills`). Before 5b the app's main process kept one key of each for every window; now each server
 // has its own, in its secrets file (secrets.ts), set from any client and never sent back.
 import { MAX_SPOKEN_CHARS } from '../../../src/host/voiceService.ts'
 import type { VoiceServerConfig } from '../../../src/shared/types'
 import type { V2Context } from '../v2.ts'
+import { present } from '../worktreeHandlers.ts'
 import { codedError } from '../errors.ts'
 import type { Integrations } from './integrations.ts'
 
@@ -126,6 +127,12 @@ export const integrationHandlers: Record<string, Handler> = {
     return viaService(() => integrations(ctx).voice.setConfig(patch))
   },
 
+  // The worktree's path from the server's state, checked as the worktree commands check it.
+  'skills.list': (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return viaService(() => integrations(ctx).skills.list(worktree.path))
+  },
+
   'voice.synthesize': (p, ctx) => {
     const text = requireSpokenText(p.text, 'text')
     return viaService(async () => ({ audio: Buffer.from(await integrations(ctx).voice.synthesize(text)).toString('base64') }))
diff --git a/server/src/integrations/integrations.ts b/server/src/integrations/integrations.ts
index ab80266..710b46c 100644
--- a/server/src/integrations/integrations.ts
+++ b/server/src/integrations/integrations.ts
@@ -1,8 +1,10 @@
-// The server's integrations with outside services (phase 5b): Linear and ElevenLabs, each with the
-// server's own key in its secrets file. Made once per server (index.ts) and handed to the handlers
+// The server's integrations (phase 5b): Linear and ElevenLabs, each with the server's own key in
+// its secrets file, and the Claude Code skills on its disk. Made once per server (index.ts) and handed to the handlers
 // through V2Context, and to the speak_summary tool and the sessions' launch.
 import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
 import { createVoiceService, type VoiceService } from '../../../src/host/voiceService.ts'
+import { listSkills } from '../../../src/host/skillService.ts'
+import type { SkillInfo } from '../../../src/shared/types'
 import { createSecretFile, type SecretFile } from '../secrets.ts'
 
 /** The secrets file's names. */
@@ -14,6 +16,8 @@ export const VOICE_CONFIG_FILE = 'voice.json'
 export interface Integrations {
   linear: LinearService
   voice: VoiceService
+  /** A worktree's skills and commands, then the server user's */
+  skills: { list(worktreePath: string): Promise<SkillInfo[]> }
 }
 
 export interface IntegrationOptions {
@@ -28,6 +32,8 @@ export interface IntegrationOptions {
   voiceConfigFile: string
   /** ElevenLabs' API base (default api.elevenlabs.io/v1); `TREK_SERVER_ELEVENLABS_URL` for the smokes */
   elevenLabsApi?: string
+  /** Whose `~/.claude` the skills come from (default: the server user's home) */
+  home?: string
 }
 
 export function keySlot(file: SecretFile, name: string): KeySlot {
@@ -42,6 +48,7 @@ export function createIntegrations(options: IntegrationOptions): Integrations {
   const secrets = createSecretFile(options.secretsFile)
   return {
     linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint }),
-    voice: createVoiceService({ key: keySlot(secrets, ELEVENLABS_SECRET), configFile: options.voiceConfigFile, api: options.elevenLabsApi })
+    voice: createVoiceService({ key: keySlot(secrets, ELEVENLABS_SECRET), configFile: options.voiceConfigFile, api: options.elevenLabsApi }),
+    skills: { list: (worktreePath) => listSkills(worktreePath, options.home) }
   }
 }
diff --git a/src/host/skillService.ts b/src/host/skillService.ts
new file mode 100644
index 0000000..55a3064
--- /dev/null
+++ b/src/host/skillService.ts
@@ -0,0 +1,81 @@
+// The Claude Code skills and slash commands a worktree's sessions can run (phase 5b; main's
+// skills.ts before it): the worktree's own `.claude/` and the user's `~/.claude/`, read on the
+// server's machine. Electron-free.
+import { readdir, readFile } from 'node:fs/promises'
+import { homedir } from 'node:os'
+import { join } from 'node:path'
+import type { SkillInfo } from '../shared/types'
+
+const MAX_DESCRIPTION = 120
+
+/** Pulls `description:` out of YAML frontmatter, if present. */
+export function extractDescription(markdown: string): string | undefined {
+  if (!markdown.startsWith('---')) return undefined
+  const end = markdown.indexOf('\n---', 3)
+  if (end === -1) return undefined
+  const frontmatter = markdown.slice(3, end)
+  const match = frontmatter.match(/^description:\s*(.+)$/m)
+  if (!match) return undefined
+  const value = match[1].trim().replace(/^["']|["']$/g, '')
+  return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION)}…` : value
+}
+
+/** Claude Code slash commands: <dir>/*.md, name = filename. */
+async function scanCommands(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
+  try {
+    const files = await readdir(dir, { withFileTypes: true })
+    const skills: SkillInfo[] = []
+    for (const file of files) {
+      if (!file.isFile() || !file.name.endsWith('.md')) continue
+      const name = file.name.slice(0, -3)
+      let description: string | undefined
+      try {
+        description = extractDescription(await readFile(join(dir, file.name), 'utf8'))
+      } catch {
+        // unreadable file — list it without a description
+      }
+      skills.push({ name, description, source, kind: 'command' })
+    }
+    return skills
+  } catch {
+    return [] // directory doesn't exist
+  }
+}
+
+/** Claude Code skills: <dir>/<name>/SKILL.md, name = directory. */
+async function scanSkills(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
+  try {
+    const entries = await readdir(dir, { withFileTypes: true })
+    const skills: SkillInfo[] = []
+    for (const entry of entries) {
+      if (!entry.isDirectory()) continue
+      try {
+        const markdown = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8')
+        skills.push({ name: entry.name, description: extractDescription(markdown), source, kind: 'skill' })
+      } catch {
+        // no SKILL.md — not a skill directory
+      }
+    }
+    return skills
+  } catch {
+    return []
+  }
+}
+
+/**
+ * The worktree's skills and commands, then the user's (`home`: the server user's home). A
+ * project-level definition shadows a user-level one with the same name.
+ */
+export async function listSkills(worktreePath: string, home: string = homedir()): Promise<SkillInfo[]> {
+  const groups = await Promise.all([
+    scanSkills(join(worktreePath, '.claude', 'skills'), 'project'),
+    scanCommands(join(worktreePath, '.claude', 'commands'), 'project'),
+    scanSkills(join(home, '.claude', 'skills'), 'user'),
+    scanCommands(join(home, '.claude', 'commands'), 'user')
+  ])
+  const byName = new Map<string, SkillInfo>()
+  for (const skill of groups.flat()) {
+    if (!byName.has(skill.name)) byName.set(skill.name, skill)
+  }
+  return [...byName.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 8fd00cf..558843c 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -25,6 +25,7 @@ import type {
   EnvironmentInfo,
   EnvironmentSettings,
   LinearIssue,
+  SkillInfo,
   LinearKeyResult,
   StackLogChunk,
   VoiceInfo,
@@ -186,7 +187,9 @@ export const CAPABILITY = {
    * `voice.*` keep the server's ElevenLabs key and voice; its speak_summary tool sends each spoken
    * summary to the project's subscribers as `voice.summary`
    */
-  voice: 'voice'
+  voice: 'voice',
+  /** `skills.list` lists a worktree's Claude Code skills and commands on the server's disk */
+  skills: 'skills'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -396,6 +399,10 @@ export interface MethodParamsV2 {
   /** An mp3 of `text` (at most 400 characters), for this connection only: Settings' Test */
   'voice.synthesize': { text: string }
 
+  // Skills (capability `skills`)
+  /** The worktree's `.claude/skills` and `.claude/commands`, then the server user's `~/.claude` ones */
+  'skills.list': WorktreeRef
+
   // Subscriptions
   'sub.subscribe': { topic: Topic }
   'sub.unsubscribe': { topic: Topic }
@@ -502,6 +509,7 @@ export interface MethodResultsV2 {
   'voice.setConfig': VoiceServerConfig
   /** The mp3, base64 */
   'voice.synthesize': { audio: string }
+  'skills.list': SkillInfo[]
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
````

- [ ] **Step 2: Run the tests**

Run: `node --test scripts/serverIntegrations.test.mjs scripts/serverV2.test.mjs`
Expected: PASS: "skills.list reads the worktree's .claude and the server user's ~/.claude; the project shadows the user".

- [ ] **Step 3: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/host/skillService.ts
git status --short   # only this task's files
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5b): skills.list on the server: the worktree's .claude and the server user's ~/.claude (capability skills)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

---

### Task 4: The stack tools on the server's MCP

**Files:**
- Create: `scripts/serverStackTools.test.mjs`
- Move: `src/renderer/src/stacks.ts` → `src/shared/stacks.ts`
- Modify: `server/src/mcp/tools.ts`, `server/src/server.ts`, `src/renderer/src/components/StackPanel.tsx`, `src/renderer/src/components/WorktreeDetail.tsx`
- Test: `scripts/serverStackTools.test.mjs`, `scripts/serverMcpTools.test.mjs` (the tool count)

Decision 14. Stub `stack.sh` only; no docker.

- [ ] **Step 1: Apply the diff** (c86f914; use `git mv` for the move)

````diff
diff --git a/scripts/serverMcpTools.test.mjs b/scripts/serverMcpTools.test.mjs
index f92357e..20e704b 100644
--- a/scripts/serverMcpTools.test.mjs
+++ b/scripts/serverMcpTools.test.mjs
@@ -109,10 +109,10 @@ async function toolSetup(t, opts = {}) {
 
 test('the tool list matches decision 5', () => {
   assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
-    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session',
-    'list_session_types', 'list_worktrees', 'load_worktree', 'read_terminal', 'remove_queued_prompt',
+    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session', 'get_stack',
+    'list_session_types', 'list_worktrees', 'load_worktree', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
     'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
-    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'unload_worktree',
+    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
     'wait_for_sessions'
   ])
 })
diff --git a/scripts/serverStackTools.test.mjs b/scripts/serverStackTools.test.mjs
new file mode 100644
index 0000000..a37da4e
--- /dev/null
+++ b/scripts/serverStackTools.test.mjs
@@ -0,0 +1,122 @@
+// scripts/serverStackTools.test.mjs — the trek-dev MCP tools get_stack, start_stack, stop_stack and
+// read_stack_log (phase 5b), over the server's stack service: real git in a temp dir, a stub
+// stack.sh and a stub docker first on PATH (nothing here runs a real docker), and a stack registry
+// of the test's own (TREK_STACK_REGISTRY).
+process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+process.env.GIT_CONFIG_NOSYSTEM = '1'
+
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { execFileSync } from 'node:child_process'
+import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { saveConfig } from '../server/src/config.ts'
+import { ConfigStore } from '../server/src/configStore.ts'
+import { GitPoller } from '../server/src/git/poller.ts'
+import { createToolCaller } from '../server/src/mcp/tools.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { createStackService } from '../src/host/stackService.ts'
+
+const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
+const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
+
+const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-stubs-')))
+const callsFile = join(stubDir, 'calls')
+const runningFlag = join(stubDir, 'running')
+// `docker ps -q` lists one container while the flag file exists.
+writeFileSync(join(stubDir, 'docker'), `#!/bin/bash\necho "docker|$*" >> '${callsFile}'\nif [ "$1" = ps ] && [ -f '${runningFlag}' ]; then echo c1; fi\nexit 0\n`)
+chmodSync(join(stubDir, 'docker'), 0o755)
+process.env.PATH = `${stubDir}:${process.env.PATH}`
+process.env.TREK_STACK_REGISTRY = join(stubDir, 'registry')
+process.on('exit', () => rmSync(stubDir, { recursive: true, force: true }))
+
+const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])
+
+async function setup(t, { stackBody = '', machine = true } = {}) {
+  rmSync(callsFile, { force: true })
+  rmSync(runningFlag, { force: true })
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-')))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  const a = join(dir, 'repos', 'a')
+  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
+  mkdirSync(join(a, 'docker', 'stack'), { recursive: true })
+  writeFileSync(join(a, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "stack|$*" >> '${callsFile}'\necho -e "\\x1b[32mstep $1\\x1b[0m"\n${stackBody}\n`, { mode: 0o755 })
+  git(a, 'add', '.')
+  git(a, 'commit', '-q', '-m', 'init')
+  git(a, 'worktree', 'add', '-q', '-b', 'feature-x', `${a}-feature-x`)
+  // A worktree without a stack.sh.
+  git(a, 'worktree', 'add', '-q', '--detach', `${a}-bare`)
+  rmSync(join(`${a}-bare`, 'docker'), { recursive: true, force: true })
+  mkdirSync(process.env.TREK_STACK_REGISTRY, { recursive: true })
+  writeFileSync(join(process.env.TREK_STACK_REGISTRY, 'trek-a-feature-x'), `path=${a}-feature-x\nport=4100\n`)
+  const configPath = join(dir, 'config.json')
+  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }] })
+  const store = new ConfigStore(configPath)
+  const hub = new TopicHub()
+  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
+  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
+  t.after(() => {
+    poller.stop()
+    store.close()
+  })
+  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'a', path: a }, name: undefined }])
+  await poller.refresh(a)
+  const stacks = createStackService({ stateDir: join(dir, 'data', 'stacks') })
+  const call = createToolCaller({ store, hub, projects, poller, sessions: {}, ...(machine ? { machine: { stacks } } : {}) })(projectId)
+  return { a, feature: `${a}-feature-x`, call, projects, projectId }
+}
+
+test('get_stack, start_stack, read_stack_log and stop_stack drive the worktree stack.sh on the server', async (t) => {
+  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
+  assert.deepEqual(await s.call('get_stack', { worktree: 'feature-x' }), {
+    available: true,
+    name: 'trek-a-feature-x',
+    state: 'stopped',
+    containers: 0,
+    ports: { first: 4100, last: 4105 },
+    urls: { App: 'http://a-feature-x.localhost:4100', API: 'http://localhost:4101' },
+    logins: 'admin or bill, password sample123'
+  })
+  const started = await s.call('start_stack', { worktree: s.feature, starter: true })
+  assert.equal(started.state, 'starting')
+  await assert.rejects(s.call('start_stack', { worktree: 'feature-x' }), /already starting/)
+  writeFileSync(runningFlag, '')
+  assert.equal((await s.call('get_stack', { worktree: 'feature-x' })).state, 'running')
+  // The log's last lines, without the colour codes.
+  let output = ''
+  for (let i = 0; i < 50 && !output.includes('step up'); i++) {
+    output = (await s.call('read_stack_log', { worktree: 'feature-x' })).output
+    await new Promise((r) => setTimeout(r, 20))
+  }
+  assert.match(output, /\$ stack\.sh up --starter\nstep up/)
+  assert.equal(output.includes('\x1b'), false)
+  assert.equal((await s.call('read_stack_log', { worktree: 'feature-x', lines: 1 })).output.split('\n').length, 1)
+  rmSync(runningFlag)
+  const stopped = await s.call('stop_stack', { worktree: 'feature-x' })
+  assert.equal(stopped.state, 'stopped')
+  assert.deepEqual(calls().filter((c) => c.startsWith('stack|')), ['stack|up --starter', 'stack|down'])
+})
+
+test('the stack tools: a worktree without stack.sh, a failed down, bad arguments, and a server without stacks', async (t) => {
+  const s = await setup(t, { stackBody: 'if [ "$1" = down ]; then exit 3; fi' })
+  assert.deepEqual(await s.call('get_stack', { worktree: `${s.a}-bare` }), { available: false })
+  await assert.rejects(s.call('start_stack', { worktree: `${s.a}-bare` }), /no docker\/stack\/stack\.sh/)
+  await assert.rejects(s.call('stop_stack', { worktree: 'feature-x' }), /exited with code 3 — see read_stack_log/)
+  await assert.rejects(s.call('start_stack', { worktree: 'feature-x', starter: 'yes' }), /starter must be a boolean/)
+  await assert.rejects(s.call('read_stack_log', { worktree: 'feature-x', lines: '5' }), /lines must be a number/)
+  await assert.rejects(s.call('get_stack', { worktree: 'nope' }), /No worktree "nope"/)
+  const none = await setup(t, { machine: false })
+  await assert.rejects(none.call('get_stack', { worktree: 'feature-x' }), /does not run dev stacks/)
+})
+
+test('the stack tools refuse a worktree outside the allowlist', async (t) => {
+  const s = await setup(t)
+  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-outside-')))
+  t.after(() => rmSync(outside, { recursive: true, force: true }))
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'zzz', isMain: false, loaded: false, sessions: [] })
+  })
+  await assert.rejects(s.call('get_stack', { worktree: 'out' }), (err) => err.code === 'PATH_DENIED')
+})
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index 65eb81c..8ba17d0 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -24,6 +24,9 @@ import type { ToolDefinition } from './protocol.ts'
 import { projectTopic } from '../../../src/shared/model/topics.ts'
 import type { VoiceService } from '../../../src/host/voiceService.ts'
 import { requireSpokenText } from '../integrations/integrationHandlers.ts'
+import type { Machine } from '../integrations/machineHandlers.ts'
+import { stackState, stackUrls, stripAnsi } from '../../../src/shared/stacks.ts'
+import type { StackStatus } from '../../../src/shared/types'
 
 const WORKTREE_PARAM = {
   type: 'string',
@@ -36,6 +39,9 @@ const SESSION_TYPE_PARAM = {
   description: 'Session type id or name (case-insensitive), as returned by list_session_types'
 }
 
+const STACK_DESCRIPTION =
+  "A worktree's dev stack is the repo's docker/stack/stack.sh, run on the Trek server's machine: its own docker compose project (trek-<name>), Trek_<name> database, Cosmos database and block of ports, running side by side with other worktrees' stacks."
+
 const LLM_PARAMS = {
   provider: {
     type: 'string',
@@ -297,6 +303,44 @@ export const MCP_TOOLS: ToolDefinition[] = [
       required: ['worktree']
     }
   },
+  {
+    name: 'get_stack',
+    description: `${STACK_DESCRIPTION} Returns whether the worktree has one, its state (starting, running, stopping, stopped), running container count, ports and URLs (App, API, Admin).`,
+    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
+  },
+  {
+    name: 'start_stack',
+    description: `${STACK_DESCRIPTION} Starts it in the background (stack.sh up) and returns immediately; poll get_stack until state is running and read_stack_log for progress. A first start restores the database and can take minutes.`,
+    inputSchema: {
+      type: 'object',
+      properties: {
+        worktree: WORKTREE_PARAM,
+        starter: {
+          type: 'boolean',
+          description:
+            'Restore a new stack database from the starter dataset (a year of history) instead of the default slim one. Only matters for a stack whose database does not exist yet.'
+        }
+      },
+      required: ['worktree']
+    }
+  },
+  {
+    name: 'stop_stack',
+    description: `${STACK_DESCRIPTION} Stops it (stack.sh down): removes its containers but keeps its database for the next start. Waits until stopped.`,
+    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
+  },
+  {
+    name: 'read_stack_log',
+    description: `${STACK_DESCRIPTION} Returns the last lines of the stack.sh output (setup steps, then the App, API, nodeapp and admin container logs).`,
+    inputSchema: {
+      type: 'object',
+      properties: {
+        worktree: WORKTREE_PARAM,
+        lines: { type: 'number', description: 'Lines from the end (default 100, max 2000)' }
+      },
+      required: ['worktree']
+    }
+  },
   {
     name: 'set_worktree_pull_request',
     description:
@@ -310,7 +354,7 @@ export const MCP_TOOLS: ToolDefinition[] = [
 ]
 
 export const MCP_INSTRUCTIONS =
-  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
+  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine, and speak_summary reads a short summary aloud to the user. A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."
 
 export interface ToolDeps {
   store: ConfigStore
@@ -320,6 +364,8 @@ export interface ToolDeps {
   sessions: SessionManager
   /** ElevenLabs with the server's key, for speak_summary; without it the tool says voice is not set up */
   voice?: VoiceService
+  /** The dev stacks on the server's machine, for the stack tools; without it they say so */
+  machine?: Machine
   /** How often waits re-check session state (default 250 ms) */
   pollMs?: number
   /** wait_for_sessions waits this long first when its condition already holds (default 1.5 s) */
@@ -455,6 +501,7 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
     projects: deps.projects,
     poller: deps.poller,
     sessions: deps.sessions,
+    machine: deps.machine,
     // Tool calls subscribe to nothing and attach to no pty.
     subscriber: { send() {} },
     terminal: { send() {}, bufferedAmount: () => 0 }
@@ -589,6 +636,51 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
       }
     }
 
+    /** A stack as the tools describe it (the desktop's describeStack). */
+    const describeStack = (status: StackStatus) => ({
+      name: status.slug ? `trek-${status.slug}` : null,
+      state: stackState(status),
+      containers: status.containers,
+      ports: status.port ? { first: status.port, last: status.port + 5 } : null,
+      urls: Object.fromEntries(stackUrls(status).map((u) => [u.label, u.url])),
+      logins: 'admin or bill, password sample123'
+    })
+
+    /** get_stack, start_stack, stop_stack and read_stack_log, through the stack.* commands (their checks and the allowlist). */
+    const stackTool = async (name: string, args: Record<string, unknown>, project: Project): Promise<unknown> => {
+      const { worktree } = resolveWorktree(project, args.worktree)
+      if (!deps.machine) throw bad('This Trek server does not run dev stacks')
+      const ref = { worktreeId: worktree.id }
+      const status = (await v2('stack.status', ref)) as StackStatus
+      if (!status.available) {
+        if (name === 'get_stack') return { available: false }
+        throw bad('That worktree has no docker/stack/stack.sh')
+      }
+      switch (name) {
+        case 'start_stack': {
+          if (args.starter !== undefined && typeof args.starter !== 'boolean') throw bad('starter must be a boolean')
+          const state = stackState(status)
+          if (state !== 'stopped') throw bad(`The stack is already ${state}`)
+          await v2('stack.up', { ...ref, starter: args.starter === true })
+          return describeStack((await v2('stack.status', ref)) as StackStatus)
+        }
+        case 'stop_stack': {
+          const code = await v2('stack.down', ref)
+          if (code !== 0) throw bad(`stack.sh down exited with code ${String(code)} — see read_stack_log`)
+          return describeStack((await v2('stack.status', ref)) as StackStatus)
+        }
+        case 'read_stack_log': {
+          if (args.lines !== undefined && typeof args.lines !== 'number') throw bad('lines must be a number')
+          const lines = Math.min(Math.max(Math.floor(Number(args.lines)) || 100, 1), 2000)
+          // fileId 0 names no log: the answer is the current log's last 64 KiB.
+          const { text } = (await v2('stack.log', { ...ref, fileId: 0, offset: 0 })) as { text: string }
+          return { output: stripAnsi(text).split('\n').slice(-lines).join('\n') }
+        }
+        default:
+          return { available: true, ...describeStack(status) }
+      }
+    }
+
     const handlers: Record<string, (args: Record<string, unknown>, project: Project, signal?: AbortSignal) => unknown> = {
       list_worktrees: (_args, project) =>
         project.repositories.flatMap((repo) => repo.worktrees.map((w) => describeWorktree(project, repo, w))),
@@ -806,6 +898,11 @@ export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCal
         return { notified: true }
       },
 
+      get_stack: (args, project) => stackTool('get_stack', args, project),
+      start_stack: (args, project) => stackTool('start_stack', args, project),
+      stop_stack: (args, project) => stackTool('stop_stack', args, project),
+      read_stack_log: (args, project) => stackTool('read_stack_log', args, project),
+
       speak_summary: async (args) => {
         // Global sessions may speak too, so this does not go through targetIn.
         const { session } = sessionIn(args.terminalId)
diff --git a/server/src/server.ts b/server/src/server.ts
index 8220b34..4602e50 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -337,7 +337,7 @@ export function startServer(
     shutdown: (reason) => shutdown(reason)
   }
   if (access) {
-    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice })
+    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine })
     const callerFor = (projectId: string): ToolCall => {
       let call = callers.get(projectId)
       if (!call) callers.set(projectId, (call = caller(projectId)))
diff --git a/src/renderer/src/components/StackPanel.tsx b/src/renderer/src/components/StackPanel.tsx
index 63b1add..afb72e4 100644
--- a/src/renderer/src/components/StackPanel.tsx
+++ b/src/renderer/src/components/StackPanel.tsx
@@ -1,6 +1,6 @@
 import { useEffect, useRef, useState } from 'react'
 import type { StackStatus } from '../../../shared/types'
-import { STACK_STATE_LABELS, stackState, stackUrls, stripAnsi } from '../stacks'
+import { STACK_STATE_LABELS, stackState, stackUrls, stripAnsi } from '../../../shared/stacks'
 import { getBackend } from '../backend'
 
 interface Props {
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index d0a9aae..81d3b3e 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -25,7 +25,7 @@ import { DockerMenu } from './DockerMenu'
 import { DockerPanel } from './DockerPanel'
 import { EnvironmentPanel } from './EnvironmentPanel'
 import { StackPanel } from './StackPanel'
-import { STACK_STATE_LABELS, stackState, stackUrls } from '../stacks'
+import { STACK_STATE_LABELS, stackState, stackUrls } from '../../../shared/stacks'
 import { NotesPanel } from './NotesPanel'
 import { ChangesPanel, useWorktreeChanges } from './ChangesPanel'
 import { changesTabLabel } from '../../../shared/changes'
diff --git a/src/renderer/src/stacks.ts b/src/shared/stacks.ts
similarity index 87%
rename from src/renderer/src/stacks.ts
rename to src/shared/stacks.ts
index b887174..3c0124b 100644
--- a/src/renderer/src/stacks.ts
+++ b/src/shared/stacks.ts
@@ -1,4 +1,5 @@
-import type { StackStatus } from '../../shared/types'
+// A dev stack's state and URLs, from its stack.status: the stack panel's and the server's stack tools'.
+import type { StackStatus } from './types'
 
 export type StackState = 'starting' | 'running' | 'stopping' | 'stopped'
 
````

- [ ] **Step 2: Run the tests**

Run: `node --test scripts/serverStackTools.test.mjs scripts/serverMcpTools.test.mjs`
Expected: PASS: the three tests of `serverStackTools.test.mjs` (the four tools driving a stub `stack.sh`; a worktree without `stack.sh`, a failed down, bad arguments and a server without stacks; a worktree outside the allowlist refused), and `serverMcpTools`' tool list (27 tools).

- [ ] **Step 3: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

- [ ] **Step 4: Commit**

```bash
git add scripts/serverStackTools.test.mjs src/shared/stacks.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5b): the trek-dev stack tools on the server: get_stack, start_stack, stop_stack, read_stack_log over its stack service" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

---

### Task 5: Every server window has Linear, voice and skills from its server; main hands its keys over

**Files:**
- Create: `src/main/integrationsHandover.ts`, `src/main/integrationsHandoverRules.ts`, `scripts/integrationsHandover.test.mjs`
- Delete: `src/main/linear.ts`, `src/main/voice.ts`, `src/main/skills.ts`
- Modify: `src/main/appSettings.ts`, `src/main/index.ts`, `src/main/localServer.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/backend.ts`, `src/renderer/src/backendFeatures.ts`, `src/renderer/src/components/{LinearSettings,SettingsPanel,SkillMenu,VoiceSettings,VoiceToggle}.tsx`, `src/renderer/src/linear.ts`, `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/voice.ts`, `src/shared/appSettings.ts`, `src/shared/types.ts`
- Test: `scripts/integrationsHandover.test.mjs`, `scripts/backendFeatures.test.mjs`, `scripts/v2Backend.test.mjs`, `scripts/appSettings.test.mjs`

Decisions 3, 15–17, 19.

- [ ] **Step 1: Apply the diff** (ad7947b; `git rm` the three main files)

````diff
diff --git a/scripts/appSettings.test.mjs b/scripts/appSettings.test.mjs
index 35b4906..8bc6637 100644
--- a/scripts/appSettings.test.mjs
+++ b/scripts/appSettings.test.mjs
@@ -3,20 +3,23 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/appSettings.ts'
 
-const DEFAULTS = { showNotifications: true, stopLocalServerOnQuit: false }
+const DEFAULTS = { showNotifications: true, stopLocalServerOnQuit: false, voiceActive: true }
 
 test('notifications are on and stopping Local on quit is off by default; a missing, corrupt or mistyped file reads as the defaults', () => {
   assert.deepEqual(DEFAULT_APP_SETTINGS, DEFAULTS)
-  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no', stopLocalServerOnQuit: 1 }]) {
+  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no', stopLocalServerOnQuit: 1, voiceActive: 0 }]) {
     assert.deepEqual(parseAppSettings(raw), DEFAULTS, JSON.stringify(raw))
   }
-  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false, stopLocalServerOnQuit: false }, 'unknown keys are dropped')
+  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false, stopLocalServerOnQuit: false, voiceActive: true }, 'unknown keys are dropped')
 })
 
 test('a patch changes only the fields it carries, over the current settings', () => {
-  const current = { showNotifications: false, stopLocalServerOnQuit: true }
+  const current = { showNotifications: false, stopLocalServerOnQuit: true, voiceActive: true }
   assert.deepEqual(parseAppSettings({}, current), current)
-  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true, stopLocalServerOnQuit: true })
-  assert.deepEqual(parseAppSettings({ stopLocalServerOnQuit: false }, current), { showNotifications: false, stopLocalServerOnQuit: false })
+  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true, stopLocalServerOnQuit: true, voiceActive: true })
+  assert.deepEqual(parseAppSettings({ stopLocalServerOnQuit: false }, current), { showNotifications: false, stopLocalServerOnQuit: false, voiceActive: true })
+  // Active/Busy for spoken summaries is the app's (5b).
+  assert.deepEqual(parseAppSettings({ voiceActive: false }, current), { showNotifications: false, stopLocalServerOnQuit: true, voiceActive: false })
+  assert.deepEqual(parseAppSettings({ voiceActive: 'no' }, current), current)
   assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), current)
 })
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 51d4a96..68069e4 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -22,19 +22,27 @@ test('an empty window has no feature (4e: no file windows)', () => {
   for (const name of FEATURE_NAMES) assert.equal(NO_FEATURES[name], false, name)
 })
 
-test('a server window can have Linear, settings editing, the Global panel, the server machine\'s features and this machine\'s', () => {
+test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
 })
 
-test('v2 features are the ceiling AND the welcome capabilities; Linear and settings need none', () => {
+test('v2 features are the ceiling AND the welcome capabilities; settings need none', () => {
   const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
-  assert.deepEqual(on(['mcp']), ['linear', 'settingsEdit', 'globalPanel'])
-  assert.deepEqual(on([]), ['linear', 'settingsEdit'])
+  assert.deepEqual(on(['mcp']), ['settingsEdit', 'globalPanel'])
+  assert.deepEqual(on([]), ['settingsEdit'])
   // Before the first welcome there are no capabilities.
-  assert.deepEqual(on(undefined), ['linear', 'settingsEdit'])
+  assert.deepEqual(on(undefined), ['settingsEdit'])
   // A capability the ceiling has off turns nothing on.
-  assert.deepEqual(on(['mcp', 'bot', 'voice']), ['linear', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on(['mcp', 'bot', 'moveWorktree']), ['settingsEdit', 'globalPanel'])
+})
+
+test('Linear, voice and skills are the server\'s (5b): each follows its own capability, on any server', () => {
+  const on = (caps, options) => ['linear', 'voice', 'skills'].filter((name) => v2Features(caps, options)[name])
+  assert.deepEqual(on(['linear', 'voice', 'skills']), ['linear', 'voice', 'skills'])
+  assert.deepEqual(on(['voice']), ['voice'])
+  // A server older than 5b: none, even on the Local entry with `local`.
+  assert.deepEqual(on(['mcp', 'local', 'docker'], { localEntry: true }), [])
 })
 
 test("docker, env and stacks run on the server's machine: each follows its own capability, on any server (5a)", () => {
@@ -48,12 +56,13 @@ test("docker, env and stacks run on the server's machine: each follows its own c
   assert.deepEqual(on(['docker', 'env', 'stacks'], { localEntry: false }), ['docker', 'env', 'stacks'])
 })
 
-test("the settings sections: a server window hides this machine's and keeps the project's agents", () => {
-  const v2 = settingsSections(v2Features(['mcp']))
+test("the settings sections: a server window shows what its server has and keeps the project's agents", () => {
+  const v2 = settingsSections(v2Features(['mcp', 'linear']))
   assert.deepEqual(Object.keys(v2), [...SETTINGS_SECTIONS])
   const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
-  // Linear's key is app-wide and it reads ticket ids only: shown on every server (4c).
+  // Linear's key is the server's (5b): shown where it serves linear.*; voice and the environments where it has them.
   assert.deepEqual(by('hidden'), ['voice', 'environments'])
+  assert.deepEqual(SETTINGS_SECTIONS.filter((name) => settingsSections(v2Features([]))[name] === 'hidden'), ['linear', 'voice', 'environments'])
   assert.deepEqual(by('project'), ['agents'])
   assert.deepEqual(by('edit'), [
     'sessionMode',
@@ -71,8 +80,8 @@ test("the settings sections: a server window hides this machine's and keeps the
   ])
 })
 
-const MACHINE = ['skills', 'reveal', 'openInEditor']
-const SERVER_MACHINE = ['mcp', 'docker', 'env', 'stacks']
+const MACHINE = ['reveal', 'openInEditor']
+const SERVER_MACHINE = ['mcp', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']
 
 test("the Local entry's server, welcomed with `local`, has this machine's features too", () => {
   const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
@@ -81,14 +90,15 @@ test("the Local entry's server, welcomed with `local`, has this machine's featur
     'env',
     'stacks',
     'linear',
+    'voice',
     'skills',
     'reveal',
     'openInEditor',
     'settingsEdit',
     'globalPanel'
   ])
-  // Never the bot, voice, moving worktrees or promote (phase 5).
-  for (const name of ['bot', 'voice', 'moveWorktree', 'promote']) assert.equal(v2Features([...SERVER_MACHINE, 'local'], { localEntry: true })[name], false, name)
+  // Never the bot, moving worktrees or promote (phase 5).
+  for (const name of ['bot', 'moveWorktree', 'promote']) assert.equal(v2Features([...SERVER_MACHINE, 'local'], { localEntry: true })[name], false, name)
 })
 
 test("this machine's features need both the Local entry and the `local` capability", () => {
@@ -101,11 +111,11 @@ test("this machine's features need both the Local entry and the `local` capabili
   assert.deepEqual(any(SERVER_MACHINE, { localEntry: true }), [])
 })
 
-test('a window whose server runs environments shows them in Settings, on Local or not; voice stays hidden', () => {
+test('a window whose server runs environments and has Linear and voice shows them in Settings, on Local or not', () => {
   for (const [caps, options] of [[[...SERVER_MACHINE, 'local'], { localEntry: true }], [SERVER_MACHINE, {}]]) {
     const sections = settingsSections(v2Features(caps, options))
-    assert.deepEqual(SETTINGS_SECTIONS.filter((name) => sections[name] === 'hidden'), ['voice'])
-    assert.deepEqual([sections.environments, sections.linear, sections.agents], ['edit', 'edit', 'project'])
+    assert.deepEqual(SETTINGS_SECTIONS.filter((name) => sections[name] === 'hidden'), [])
+    assert.deepEqual([sections.environments, sections.linear, sections.voice, sections.agents], ['edit', 'edit', 'edit', 'project'])
   }
 })
 
diff --git a/scripts/integrationsHandover.test.mjs b/scripts/integrationsHandover.test.mjs
new file mode 100644
index 0000000..35f5604
--- /dev/null
+++ b/scripts/integrationsHandover.test.mjs
@@ -0,0 +1,72 @@
+// scripts/integrationsHandover.test.mjs — handing the app's Linear and ElevenLabs keys and voice
+// settings to the Local server once (phase 5b), against a fake server's set-if-absent methods.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { handOver, legacyVoiceConfig, parseHandoverState } from '../src/main/integrationsHandoverRules.ts'
+
+/** A fake Local server: `keys` it already has; `fail` methods that throw (a server older than 5b, a dropped link). */
+function fakeServer({ keys = {}, reject = {}, fail = [] } = {}) {
+  const calls = []
+  const request = async (method, params) => {
+    calls.push([method, params])
+    if (fail.includes(method)) throw new Error(`Unknown method: ${method}`)
+    if (method === 'voice.setConfig') return params
+    const name = method.split('.')[0]
+    if (reject[name]) return { ok: false, error: reject[name] }
+    if (params.ifAbsent && keys[name]) return { ok: false, error: 'kept', present: true }
+    keys[name] = params.apiKey
+    return method === 'linear.setKey' ? { ok: true, user: 'Ada' } : { ok: true, voices: [] }
+  }
+  return { calls, keys, request }
+}
+
+const legacy = { linearKey: 'lin_app', voiceKey: 'sk_app', voice: { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true, active: false } }
+
+test('both keys and the voice settings go over once, set-if-absent', async () => {
+  const server = fakeServer()
+  assert.deepEqual(await handOver(server.request, legacy, {}), { linear: true, voice: true })
+  assert.deepEqual(server.calls, [
+    ['linear.setKey', { apiKey: 'lin_app', ifAbsent: true }],
+    ['voice.setKey', { apiKey: 'sk_app', ifAbsent: true }],
+    ['voice.setConfig', { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true }]
+  ])
+  // Done parts are not asked again.
+  const again = fakeServer()
+  assert.deepEqual(await handOver(again.request, legacy, { linear: true, voice: true }), { linear: true, voice: true })
+  assert.deepEqual(again.calls, [])
+})
+
+test("a server with its own key keeps it, and its own voice: that part is done", async () => {
+  const server = fakeServer({ keys: { linear: 'lin_srv', voice: 'sk_srv' } })
+  assert.deepEqual(await handOver(server.request, legacy, {}), { linear: true, voice: true })
+  assert.deepEqual(server.keys, { linear: 'lin_srv', voice: 'sk_srv' })
+  assert.equal(server.calls.some(([m]) => m === 'voice.setConfig'), false)
+})
+
+test('nothing to hand over is done at once; a refused key or an older server is left for the next start', async () => {
+  const none = fakeServer()
+  assert.deepEqual(await handOver(none.request, { linearKey: null, voiceKey: null, voice: {} }, {}), { linear: true, voice: true })
+  assert.deepEqual(none.calls, [])
+  const refused = fakeServer({ reject: { linear: 'Linear rejected the API key' } })
+  assert.deepEqual(await handOver(refused.request, legacy, {}), { voice: true })
+  const older = fakeServer({ fail: ['linear.setKey', 'voice.setKey'] })
+  assert.deepEqual(await handOver(older.request, legacy, {}), {})
+  // The key went but the voice settings did not: they are pending, and sent next time (only they).
+  const half = fakeServer({ fail: ['voice.setConfig'] })
+  const pending = await handOver(half.request, legacy, { linear: true })
+  assert.deepEqual(pending, { linear: true, voice: true, voiceConfigPending: true })
+  const next = fakeServer({ keys: { voice: 'sk_app' } })
+  assert.deepEqual(await handOver(next.request, legacy, pending), { linear: true, voice: true })
+  assert.deepEqual(next.calls, [['voice.setConfig', { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true }]])
+})
+
+test('only well-formed voice settings are sent; the state file reads strictly', () => {
+  assert.deepEqual(legacyVoiceConfig({ voiceId: '', modelId: 'a b', promptSessions: 'yes', active: true }), {})
+  assert.deepEqual(legacyVoiceConfig({ voiceId: 'v1', promptSessions: false }), { voiceId: 'v1', promptSessions: false })
+  assert.deepEqual(parseHandoverState(undefined), { profiles: {} })
+  assert.deepEqual(parseHandoverState({ profiles: { local: { linear: true, voice: 'x', voiceConfigPending: true }, 'local-dev': null }, voiceActive: true }), { profiles: { local: { linear: true } }, voiceActive: true })
+  assert.deepEqual(parseHandoverState({ profiles: { local: { voice: true, voiceConfigPending: true } } }), { profiles: { local: { voice: true, voiceConfigPending: true } } })
+  const proto = parseHandoverState(JSON.parse('{"profiles":{"__proto__":{"linear":true}}}'))
+  assert.equal(Object.hasOwn(proto.profiles, '__proto__'), true)
+  assert.equal(Object.getPrototypeOf(proto.profiles), Object.prototype)
+})
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 28124ba..3e104af 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -152,15 +152,16 @@ test('features before the welcome, then when the capabilities change', () => {
   assert.equal(backend.features.globalPanel, false)
 })
 
-test("this machine's features: only the Local entry's server, once it says `local`; the server machine's follow its capabilities; Linear everywhere", () => {
-  const local = (b) => ['skills', 'reveal', 'openInEditor'].filter((name) => b.features[name])
-  const server = (b) => ['docker', 'env', 'stacks'].filter((name) => b.features[name])
-  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['skills', 'reveal', 'openInEditor'])
+test("this machine's features: only the Local entry's server, once it says `local`; the server's follow its capabilities", () => {
+  const local = (b) => ['reveal', 'openInEditor'].filter((name) => b.features[name])
+  const server = (b) => ['docker', 'env', 'stacks', 'linear', 'voice', 'skills'].filter((name) => b.features[name])
+  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['reveal', 'openInEditor'])
   assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'] }).backend), [])
   assert.deepEqual(local(setup({ capabilities: ['mcp'], localEntry: true }).backend), [])
   assert.deepEqual(server(setup({ capabilities: ['mcp', 'docker', 'env', 'stacks'] }).backend), ['docker', 'env', 'stacks'])
   assert.deepEqual(server(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), [])
-  assert.equal(setup().backend.features.linear, true)
+  assert.deepEqual(server(setup({ capabilities: ['linear', 'voice', 'skills'] }).backend), ['linear', 'voice', 'skills'])
+  assert.equal(setup().backend.features.linear, false)
   // A server before its welcome, then once it arrives.
   let caps
   const { backend } = setup({ capabilities: () => caps })
@@ -233,6 +234,52 @@ test('a worktree path the projection does not know is refused here, and nothing
   assert.deepEqual(calls, [])
 })
 
+test("linear, voice and skills go to the window's server; the clip comes back as bytes; the summaries are this project's", async () => {
+  const replies = {
+    'linear.status': { hasKey: true },
+    'linear.setKey': { ok: true, user: 'Ada' },
+    'linear.issues': [{ identifier: 'TOW-1' }],
+    'voice.settings': { hasKey: false, voiceId: '', modelId: 'm', promptSessions: false },
+    'voice.setKey': { ok: true, voices: [] },
+    'voice.voices': [{ id: 'v1', name: 'Rachel' }],
+    'voice.setConfig': { voiceId: 'v1', modelId: 'm', promptSessions: true },
+    'voice.synthesize': { audio: Buffer.from('mp3!').toString('base64') },
+    'skills.list': [{ name: 'review', source: 'project', kind: 'skill' }]
+  }
+  const { backend, calls, listeners } = setup({ replies })
+  assert.equal(await backend.linear.hasKey(), true)
+  assert.deepEqual(await backend.linear.setKey('lin_k'), { ok: true, user: 'Ada' })
+  await backend.linear.clearKey()
+  assert.deepEqual(await backend.linear.issues(['TOW-1']), [{ identifier: 'TOW-1' }])
+  assert.equal((await backend.voice.settings()).modelId, 'm')
+  await backend.voice.setKey('sk_k')
+  await backend.voice.clearKey()
+  await backend.voice.voices()
+  await backend.voice.setConfig({ promptSessions: true })
+  assert.equal(Buffer.from(await backend.voice.synthesize('Hi')).toString(), 'mp3!')
+  assert.deepEqual(await backend.skills.list({ path: '/r-feat' }), [{ name: 'review', source: 'project', kind: 'skill' }])
+  assert.deepEqual(calls, [
+    ['linear.status', {}],
+    ['linear.setKey', { apiKey: 'lin_k' }],
+    ['linear.clearKey', {}],
+    ['linear.issues', { ids: ['TOW-1'] }],
+    ['voice.settings', {}],
+    ['voice.setKey', { apiKey: 'sk_k' }],
+    ['voice.clearKey', {}],
+    ['voice.voices', {}],
+    ['voice.setConfig', { promptSessions: true }],
+    ['voice.synthesize', { text: 'Hi' }],
+    ['skills.list', { projectId: 'p1', worktreeId: 'w2' }]
+  ])
+  const heard = []
+  const off = backend.voice.onSummary((e) => heard.push(e.text))
+  for (const l of listeners['voice.summary']) l({ projectId: 'p1', sessionId: 's1', text: 'mine', audio: '' })
+  for (const l of listeners['voice.summary']) l({ projectId: 'other', sessionId: 's1', text: 'theirs', audio: '' })
+  off()
+  assert.deepEqual(listeners['voice.summary'], [])
+  assert.deepEqual(heard, ['mine'])
+})
+
 test("the logs come from the window's connection, by event name, until unsubscribed", () => {
   const { backend, listeners } = setup()
   const docker = []
diff --git a/src/main/appSettings.ts b/src/main/appSettings.ts
index 451528a..fce5fc1 100644
--- a/src/main/appSettings.ts
+++ b/src/main/appSettings.ts
@@ -40,7 +40,7 @@ export function appSettings(): AppSettings {
 /** Every write goes through this chain, so concurrent patches never interleave. */
 let writeChain: Promise<unknown> = Promise.resolve()
 
-async function update(patch: unknown): Promise<AppSettings> {
+export async function updateAppSettings(patch: unknown): Promise<AppSettings> {
   // Applied at once (the next notification follows it), written in order.
   const next = parseAppSettings(patch, appSettings())
   settings = next
@@ -65,5 +65,5 @@ async function update(patch: unknown): Promise<AppSettings> {
 
 export function registerAppSettingsHandlers(): void {
   ipcMain.handle('appSettings:get', () => ({ ...appSettings() }))
-  ipcMain.handle('appSettings:update', (_event, patch: unknown) => update(patch))
+  ipcMain.handle('appSettings:update', (_event, patch: unknown) => updateAppSettings(patch))
 }
diff --git a/src/main/index.ts b/src/main/index.ts
index 8d6ddc3..d324848 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -1,3 +1,4 @@
+import { handOverIntegrationsToLocal } from './integrationsHandover'
 import { app, BrowserWindow, Menu, nativeImage } from 'electron'
 
 app.setName('Trek Dev')
@@ -9,8 +10,6 @@ function setDockIcon(): void {
 }
 import { registerAppIpc } from './appIpc'
 import { registerGithubHandlers } from './github'
-import { registerLinearHandlers } from './linear'
-import { registerSkillHandlers } from './skills'
 import { closeServerLinks, registerAppServerHandlers } from './appServers'
 import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
 import { appSettings, registerAppSettingsHandlers } from './appSettings'
@@ -28,7 +27,6 @@ import {
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
 import { importFromMenu, offerFirstLaunchImport, openFromOs, registerImportHandlers } from './importUi'
-import { registerVoiceHandlers } from './voice'
 import { registerLlmHandlers } from './llmSettings'
 import { fixPath } from './env'
 import { removeStaleMcpConfigs } from './staleMcpConfigs'
@@ -160,8 +158,6 @@ app.whenReady().then(async () => {
   registerAppIpc()
   registerImportHandlers()
   registerGithubHandlers()
-  registerLinearHandlers()
-  registerSkillHandlers()
   registerAppSettingsHandlers()
   // Before the links: their first connections are linked to the aggregator as they are made.
   registerAttentionHandlers()
@@ -169,13 +165,13 @@ app.whenReady().then(async () => {
   registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
   registerV2Relay()
   registerLocalServerHandlers()
-  registerVoiceHandlers()
   registerLlmHandlers()
   buildMenu()
   onLocalServerChanged(buildMenu)
   setDockIcon()
   // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
   void superviseLocalServer()
+  handOverIntegrationsToLocal()
   // Once, before the windows come back: those on .trekproj files then come back on their projects.
   await offerFirstLaunchImport().catch((err) => console.error('[import] the first-launch prompt failed', err))
   // No empty window yet: a .trekproj that launched the app, or that arrives during the restore,
diff --git a/src/main/integrationsHandover.ts b/src/main/integrationsHandover.ts
new file mode 100644
index 0000000..2a23066
--- /dev/null
+++ b/src/main/integrationsHandover.ts
@@ -0,0 +1,127 @@
+// Hands the app's Linear and ElevenLabs keys and voice settings to the Local server, once per Local
+// profile (phase 5b; the rules in integrationsHandoverRules.ts). Before 5b main kept them in
+// userData (the keys encrypted with safeStorage, which the server cannot decrypt), and every window
+// used them; now each server has its own, and the Local server starts with the app's. Main decrypts
+// them and calls the same set-if-absent methods any client could, through its own connection with
+// the Local token (never the renderer's). The old files are left as they were: the installed app and
+// a dev build share this userData, and each hands over to its own Local profile.
+import { app } from 'electron'
+import { readFileSync } from 'node:fs'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../shared/client/index.ts'
+import { CAPABILITY } from '../shared/protocolV2.ts'
+import { appSettings, updateAppSettings } from './appSettings'
+import { createSecretStore, writeFileAtomic } from './secrets'
+import { handOver, parseHandoverState, type HandoverState, type LegacyIntegrations } from './integrationsHandoverRules'
+import { localProfileKey, localServerStatus, localServerUrl, localToken, onLocalServerChanged } from './localServer'
+
+const STATE_FILE = 'integrations-handover.json'
+const CONNECT_TIMEOUT_MS = 10_000
+const REQUEST_TIMEOUT_MS = 30_000
+
+const statePath = (): string => join(app.getPath('userData'), STATE_FILE)
+
+function readState(): HandoverState {
+  try {
+    return parseHandoverState(JSON.parse(readFileSync(statePath(), 'utf8')))
+  } catch {
+    return parseHandoverState(undefined)
+  }
+}
+
+function readLegacyVoice(): LegacyIntegrations['voice'] {
+  try {
+    const raw: unknown = JSON.parse(readFileSync(join(app.getPath('userData'), 'voice-settings.json'), 'utf8'))
+    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as LegacyIntegrations['voice']) : {}
+  } catch {
+    return {}
+  }
+}
+
+async function readLegacy(): Promise<LegacyIntegrations> {
+  const [linearKey, voiceKey] = await Promise.all([
+    createSecretStore('linear.json').get('apiKey').catch(() => null),
+    createSecretStore('elevenlabs.json').get('apiKey').catch(() => null)
+  ])
+  return { linearKey, voiceKey, voice: readLegacyVoice() }
+}
+
+/** Connected to the Local server, or null when it does not answer in time (or has no `linear`/`voice`). */
+function connectLocal(url: string, token: string): Promise<ServerConnection | null> {
+  const conn = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'trek-desktop-handover', clientVersion: app.getVersion() })
+  return new Promise((resolve) => {
+    let settled = false
+    const finish = (ok: boolean): void => {
+      if (settled) return
+      settled = true
+      clearTimeout(timer)
+      off()
+      if (ok) resolve(conn)
+      else {
+        conn.close()
+        resolve(null)
+      }
+    }
+    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS)
+    const off = conn.on('status', ({ status }) => {
+      if (status === 'connected') {
+        const caps = conn.welcome?.capabilities ?? []
+        finish(caps.includes(CAPABILITY.linear) && caps.includes(CAPABILITY.voice))
+      } else if (status === 'needs-auth' || status === 'incompatible' || status === 'closed') finish(false)
+    })
+    conn.connect()
+  })
+}
+
+/** The Local server's pid this ran for: once per server run (a later start retries what failed). */
+let triedPid: number | undefined
+
+async function run(): Promise<void> {
+  const state = readState()
+  const profile = localProfileKey()
+  const done = Object.hasOwn(state.profiles, profile) ? state.profiles[profile] : {}
+  const legacy = await readLegacy()
+  let changed = false
+  // Active/Busy stays the app's: voice-settings.json's, into the app settings, once.
+  if (!state.voiceActive) {
+    if (legacy.voice.active === false && appSettings().voiceActive) await updateAppSettings({ voiceActive: false }).catch(() => undefined)
+    state.voiceActive = true
+    changed = true
+  }
+  if (!(done.linear && done.voice) || done.voiceConfigPending) {
+    let next = done
+    if (!legacy.linearKey && !legacy.voiceKey) next = { linear: true, voice: true }
+    else {
+      const url = localServerUrl()
+      const token = localToken()
+      const conn = url && token ? await connectLocal(url, token) : null
+      if (conn) {
+        try {
+          next = await handOver((method, params) => conn.request(method, params as never, { timeoutMs: REQUEST_TIMEOUT_MS }), legacy, done)
+        } finally {
+          conn.close()
+        }
+      }
+    }
+    if (next.linear !== done.linear || next.voice !== done.voice || next.voiceConfigPending !== done.voiceConfigPending) {
+      Object.defineProperty(state.profiles, profile, { value: next, enumerable: true, writable: true, configurable: true })
+      changed = true
+      const parts = [next.linear && !done.linear ? 'Linear' : '', next.voice && !done.voice ? 'ElevenLabs' : ''].filter(Boolean)
+      if (parts.length > 0) console.log(`trek: handed this app's ${parts.join(' and ')} settings to the Local server (${profile})`)
+    }
+  }
+  if (changed) await writeFileAtomic(statePath(), JSON.stringify(state, null, 2))
+}
+
+function maybeRun(): void {
+  const status = localServerStatus()
+  if (status.state !== 'running' || status.pid === undefined || status.pid === triedPid) return
+  triedPid = status.pid
+  void run().catch((err) => console.warn('trek: could not hand the Linear and voice settings to the Local server', err))
+}
+
+/** Called once at startup, beside the supervisor: runs each time a new Local server is running. */
+export function handOverIntegrationsToLocal(): void {
+  onLocalServerChanged(maybeRun)
+  maybeRun()
+}
diff --git a/src/main/integrationsHandoverRules.ts b/src/main/integrationsHandoverRules.ts
new file mode 100644
index 0000000..b2ba246
--- /dev/null
+++ b/src/main/integrationsHandoverRules.ts
@@ -0,0 +1,105 @@
+// The app's Linear and ElevenLabs keys and voice settings, handed to the Local server once (phase
+// 5b): before 5b main kept them (safeStorage in userData), and the server cannot decrypt those
+// files. Pure: the requests and the legacy values come in, so `node --test` covers it.
+
+/** What a Local profile has been given already, by part. */
+export interface HandoverDone {
+  linear?: true
+  voice?: true
+  /** The key went over but its voice settings did not (the link dropped between the two): sent next time */
+  voiceConfigPending?: true
+}
+
+/** `integrations-handover.json`: per Local profile, and the app's own Active/Busy once. */
+export interface HandoverState {
+  profiles: Record<string, HandoverDone>
+  /** voice-settings.json's `active` was moved into the app settings */
+  voiceActive?: true
+}
+
+/** The app's own files, decrypted. */
+export interface LegacyIntegrations {
+  linearKey: string | null
+  voiceKey: string | null
+  voice: { voiceId?: unknown; modelId?: unknown; promptSessions?: unknown; active?: unknown }
+}
+
+/** The Local server's `linear.setKey`, `voice.setKey` and `voice.setConfig`. */
+export type HandoverRequest = (method: 'linear.setKey' | 'voice.setKey' | 'voice.setConfig', params: Record<string, unknown>) => Promise<unknown>
+
+export function parseHandoverState(raw: unknown): HandoverState {
+  const from = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
+  const profiles: Record<string, HandoverDone> = {}
+  const rawProfiles = from.profiles && typeof from.profiles === 'object' && !Array.isArray(from.profiles) ? (from.profiles as Record<string, unknown>) : {}
+  for (const [name, value] of Object.entries(rawProfiles)) {
+    if (!value || typeof value !== 'object') continue
+    const v = value as Record<string, unknown>
+    Object.defineProperty(profiles, name, {
+      value: {
+        ...(v.linear === true ? { linear: true } : {}),
+        ...(v.voice === true ? { voice: true } : {}),
+        ...(v.voice === true && v.voiceConfigPending === true ? { voiceConfigPending: true } : {})
+      },
+      enumerable: true,
+      writable: true,
+      configurable: true
+    })
+  }
+  return { profiles, ...(from.voiceActive === true ? { voiceActive: true } : {}) }
+}
+
+/** The voice settings worth sending: a chosen voice, a model, the flag; nothing else. */
+export function legacyVoiceConfig(voice: LegacyIntegrations['voice']): Record<string, unknown> {
+  const out: Record<string, unknown> = {}
+  if (typeof voice.voiceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(voice.voiceId)) out.voiceId = voice.voiceId
+  if (typeof voice.modelId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(voice.modelId)) out.modelId = voice.modelId
+  if (typeof voice.promptSessions === 'boolean') out.promptSessions = voice.promptSessions
+  return out
+}
+
+const result = (value: unknown): { ok?: unknown; present?: unknown } => (value && typeof value === 'object' ? (value as { ok?: unknown; present?: unknown }) : {})
+
+/**
+ * Hands over what `done` lacks; resolves what is done now. A part is done when there is nothing to
+ * hand over, when the server took it (`ok`), or when it already had a key of its own (`present`:
+ * the user set one there, which wins). Anything else (Linear or ElevenLabs unreachable, a rejected
+ * key, a server older than 5b) leaves it for the next start. The voice settings go only with a key
+ * the server took: a server with its own key keeps its own voice too. Settings that fail after
+ * their key went are pending, and sent on the next start.
+ */
+export async function handOver(request: HandoverRequest, legacy: LegacyIntegrations, done: HandoverDone): Promise<HandoverDone> {
+  const next: HandoverDone = { ...done }
+  const attempt = async <T>(run: () => Promise<T>): Promise<T | false> => {
+    try {
+      return await run()
+    } catch {
+      return false
+    }
+  }
+  if (!next.linear) {
+    const ok = await attempt(async () => {
+      if (!legacy.linearKey) return true
+      const r = result(await request('linear.setKey', { apiKey: legacy.linearKey, ifAbsent: true }))
+      return r.ok === true || r.present === true
+    })
+    if (ok) next.linear = true
+  }
+  const config = legacyVoiceConfig(legacy.voice)
+  const sendConfig = (): Promise<boolean> => attempt(async () => {
+    if (Object.keys(config).length > 0) await request('voice.setConfig', config)
+    return true
+  })
+  if (!next.voice) {
+    const stored = await attempt(async () => {
+      if (!legacy.voiceKey) return 'nothing'
+      const r = result(await request('voice.setKey', { apiKey: legacy.voiceKey, ifAbsent: true }))
+      if (r.present === true) return 'kept'
+      return r.ok === true ? 'stored' : false
+    }) as 'nothing' | 'kept' | 'stored' | false
+    if (stored) {
+      next.voice = true
+      if (stored === 'stored' && !(await sendConfig())) next.voiceConfigPending = true
+    }
+  } else if (next.voiceConfigPending && (await sendConfig())) delete next.voiceConfigPending
+  return next
+}
diff --git a/src/main/linear.ts b/src/main/linear.ts
deleted file mode 100644
index 27b5008..0000000
--- a/src/main/linear.ts
+++ /dev/null
@@ -1,96 +0,0 @@
-import { ipcMain } from 'electron'
-import { createSecretStore } from './secrets'
-import type { LinearIssue, LinearKeyResult } from '../shared/types'
-
-const ENDPOINT = 'https://api.linear.app/graphql'
-const API_KEY = 'apiKey'
-const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
-/** Linear caps query complexity, so large lookups are split into batches. */
-const BATCH_SIZE = 50
-
-/** The personal API key never leaves the main process. */
-const secrets = createSecretStore('linear.json')
-
-interface GraphQLResponse<T> {
-  data?: T | null
-  errors?: { message: string }[]
-}
-
-async function graphql<T>(
-  apiKey: string,
-  query: string,
-  variables: Record<string, unknown> = {}
-): Promise<GraphQLResponse<T>> {
-  const res = await fetch(ENDPOINT, {
-    method: 'POST',
-    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
-    body: JSON.stringify({ query, variables }),
-    signal: AbortSignal.timeout(15_000)
-  })
-  if (res.status === 401) throw new Error('Linear rejected the API key')
-  if (!res.ok && res.status !== 400) throw new Error(`Linear API returned ${res.status}`)
-  return (await res.json()) as GraphQLResponse<T>
-}
-
-interface RawIssue {
-  identifier: string
-  title: string
-  url: string
-  state: { name: string; type: string; color: string }
-}
-
-async function fetchBatch(apiKey: string, ids: string[]): Promise<LinearIssue[]> {
-  // One aliased field per issue; a missing issue only nulls its own alias.
-  const params = ids.map((_, i) => `$i${i}: String!`).join(', ')
-  const fields = ids
-    .map((_, i) => `i${i}: issue(id: $i${i}) { identifier title url state { name type color } }`)
-    .join('\n')
-  const variables = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
-  const { data } = await graphql<Record<string, RawIssue | null>>(
-    apiKey,
-    `query (${params}) {\n${fields}\n}`,
-    variables
-  )
-  return Object.values(data ?? {})
-    .filter((issue): issue is RawIssue => !!issue)
-    .map((issue) => ({
-      identifier: issue.identifier,
-      title: issue.title,
-      url: issue.url,
-      status: issue.state.name,
-      statusType: issue.state.type,
-      statusColor: issue.state.color
-    }))
-}
-
-/** Issues that exist and are visible to the key; unknown ids are left out. */
-async function fetchIssues(ids: string[]): Promise<LinearIssue[]> {
-  const apiKey = await secrets.get(API_KEY)
-  if (!apiKey) return []
-  const valid = [...new Set(ids.filter((id) => ISSUE_ID.test(id)))]
-  const batches: string[][] = []
-  for (let i = 0; i < valid.length; i += BATCH_SIZE) batches.push(valid.slice(i, i + BATCH_SIZE))
-  return (await Promise.all(batches.map((b) => fetchBatch(apiKey, b)))).flat()
-}
-
-/** Validates a key against Linear before storing it. */
-async function setApiKey(apiKey: string): Promise<LinearKeyResult> {
-  try {
-    const { data, errors } = await graphql<{ viewer: { name: string } }>(
-      apiKey,
-      'query { viewer { name } }'
-    )
-    if (!data?.viewer) return { ok: false, error: errors?.[0]?.message ?? 'Invalid API key' }
-    await secrets.set(API_KEY, apiKey)
-    return { ok: true, user: data.viewer.name }
-  } catch (err) {
-    return { ok: false, error: err instanceof Error ? err.message : String(err) }
-  }
-}
-
-export function registerLinearHandlers(): void {
-  ipcMain.handle('linear:hasApiKey', async (): Promise<boolean> => !!(await secrets.get(API_KEY)))
-  ipcMain.handle('linear:setApiKey', (_event, apiKey: string) => setApiKey(apiKey.trim()))
-  ipcMain.handle('linear:clearApiKey', () => secrets.set(API_KEY, null))
-  ipcMain.handle('linear:fetchIssues', (_event, ids: string[]) => fetchIssues(ids))
-}
diff --git a/src/main/localServer.ts b/src/main/localServer.ts
index b183085..2be6ca3 100644
--- a/src/main/localServer.ts
+++ b/src/main/localServer.ts
@@ -629,6 +629,11 @@ async function showError(failed: LocalServerStatus): Promise<void> {
 
 // ---- The API: appServers.ts, the menu, the IPC and quit ----
 
+/** This Trek's Local profile: `local` packaged, else `local-<name>` (a dev build's): the key of what it handed to that server. */
+export function localProfileKey(): string {
+  return PROFILE === undefined ? 'local' : `local-${PROFILE}`
+}
+
 export function localServerStatus(): LocalServerStatus {
   return { ...status }
 }
diff --git a/src/main/skills.ts b/src/main/skills.ts
deleted file mode 100644
index b8970d0..0000000
--- a/src/main/skills.ts
+++ /dev/null
@@ -1,86 +0,0 @@
-import { ipcMain } from 'electron'
-import { readdir, readFile } from 'node:fs/promises'
-import { homedir } from 'node:os'
-import { join } from 'node:path'
-import type { SkillInfo } from '../shared/types'
-
-const MAX_DESCRIPTION = 120
-
-/** Pulls `description:` out of YAML frontmatter, if present. */
-function extractDescription(markdown: string): string | undefined {
-  if (!markdown.startsWith('---')) return undefined
-  const end = markdown.indexOf('\n---', 3)
-  if (end === -1) return undefined
-  const frontmatter = markdown.slice(3, end)
-  const match = frontmatter.match(/^description:\s*(.+)$/m)
-  if (!match) return undefined
-  const value = match[1].trim().replace(/^["']|["']$/g, '')
-  return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION)}…` : value
-}
-
-/** Claude Code slash commands: <dir>/*.md, name = filename. */
-async function scanCommands(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
-  try {
-    const files = await readdir(dir, { withFileTypes: true })
-    const skills: SkillInfo[] = []
-    for (const file of files) {
-      if (!file.isFile() || !file.name.endsWith('.md')) continue
-      const name = file.name.slice(0, -3)
-      let description: string | undefined
-      try {
-        description = extractDescription(await readFile(join(dir, file.name), 'utf8'))
-      } catch {
-        // unreadable file — list it without a description
-      }
-      skills.push({ name, description, source, kind: 'command' })
-    }
-    return skills
-  } catch {
-    return [] // directory doesn't exist
-  }
-}
-
-/** Claude Code skills: <dir>/<name>/SKILL.md, name = directory. */
-async function scanSkills(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
-  try {
-    const entries = await readdir(dir, { withFileTypes: true })
-    const skills: SkillInfo[] = []
-    for (const entry of entries) {
-      if (!entry.isDirectory()) continue
-      try {
-        const markdown = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8')
-        skills.push({
-          name: entry.name,
-          description: extractDescription(markdown),
-          source,
-          kind: 'skill'
-        })
-      } catch {
-        // no SKILL.md — not a skill directory
-      }
-    }
-    return skills
-  } catch {
-    return []
-  }
-}
-
-export function registerSkillHandlers(): void {
-  ipcMain.handle('skills:list', async (_event, worktreePath: string): Promise<SkillInfo[]> => {
-    const home = homedir()
-    const groups = await Promise.all([
-      scanSkills(join(worktreePath, '.claude', 'skills'), 'project'),
-      scanCommands(join(worktreePath, '.claude', 'commands'), 'project'),
-      scanSkills(join(home, '.claude', 'skills'), 'user'),
-      scanCommands(join(home, '.claude', 'commands'), 'user')
-    ])
-    // Project-level definitions shadow user-level ones with the same name.
-    const byName = new Map<string, SkillInfo>()
-    for (const skill of groups.flat()) {
-      if (!byName.has(skill.name)) byName.set(skill.name, skill)
-    }
-    return [...byName.values()].sort(
-      (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
-    )
-  })
-}
diff --git a/src/main/voice.ts b/src/main/voice.ts
deleted file mode 100644
index 6153342..0000000
--- a/src/main/voice.ts
+++ /dev/null
@@ -1,102 +0,0 @@
-import { app, ipcMain } from 'electron'
-import { readFile, writeFile } from 'node:fs/promises'
-import { join } from 'node:path'
-import { createSecretStore } from './secrets'
-import type { VoiceConfig, VoiceInfo, VoiceKeyResult, VoiceSettings } from '../shared/types'
-
-const API = 'https://api.elevenlabs.io/v1'
-const API_KEY = 'apiKey'
-const DEFAULT_CONFIG: VoiceConfig = {
-  voiceId: '',
-  modelId: 'eleven_flash_v2_5',
-  active: true,
-  promptSessions: false
-}
-
-/** The ElevenLabs key never leaves the main process. */
-const secrets = createSecretStore('elevenlabs.json')
-const configPath = (): string => join(app.getPath('userData'), 'voice-settings.json')
-
-async function readConfig(): Promise<VoiceConfig> {
-  try {
-    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath(), 'utf8')) }
-  } catch {
-    return DEFAULT_CONFIG
-  }
-}
-
-async function updateConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
-  const config = { ...(await readConfig()), ...patch }
-  await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
-  return config
-}
-
-async function request(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
-  const res = await fetch(`${API}${path}`, {
-    ...init,
-    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', ...init.headers },
-    signal: AbortSignal.timeout(30_000)
-  })
-  if (res.status === 401) throw new Error('ElevenLabs rejected the API key')
-  if (!res.ok) {
-    const body = await res.text().catch(() => '')
-    throw new Error(`ElevenLabs returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
-  }
-  return res
-}
-
-async function fetchVoices(apiKey: string): Promise<VoiceInfo[]> {
-  const res = await request(apiKey, '/voices')
-  const { voices } = (await res.json()) as { voices: { voice_id: string; name: string }[] }
-  return voices.map((v) => ({ id: v.voice_id, name: v.name }))
-}
-
-async function requireKey(): Promise<string> {
-  const apiKey = await secrets.get(API_KEY)
-  if (!apiKey) throw new Error('No ElevenLabs API key is configured')
-  return apiKey
-}
-
-/** Validates a key by listing its voices, and picks the first voice if none is chosen yet. */
-async function setApiKey(apiKey: string): Promise<VoiceKeyResult> {
-  try {
-    const voices = await fetchVoices(apiKey)
-    await secrets.set(API_KEY, apiKey)
-    const config = await readConfig()
-    if (!config.voiceId && voices[0]) await updateConfig({ voiceId: voices[0].id })
-    return { ok: true, voices }
-  } catch (err) {
-    return { ok: false, error: err instanceof Error ? err.message : String(err) }
-  }
-}
-
-async function synthesize(text: string): Promise<Uint8Array> {
-  const apiKey = await requireKey()
-  const { voiceId, modelId } = await readConfig()
-  if (!voiceId) throw new Error('No ElevenLabs voice is selected')
-  const res = await request(
-    apiKey,
-    `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
-    {
-      method: 'POST',
-      headers: { Accept: 'audio/mpeg' },
-      body: JSON.stringify({ text, model_id: modelId })
-    }
-  )
-  return new Uint8Array(await res.arrayBuffer())
-}
-
-export function registerVoiceHandlers(): void {
-  ipcMain.handle(
-    'voice:getSettings',
-    async (): Promise<VoiceSettings> => ({
-      ...(await readConfig()),
-      hasApiKey: !!(await secrets.get(API_KEY))
-    })
-  )
-  ipcMain.handle('voice:setApiKey', (_event, apiKey: string) => setApiKey(apiKey.trim()))
-  ipcMain.handle('voice:clearApiKey', () => secrets.set(API_KEY, null))
-  ipcMain.handle('voice:listVoices', async () => fetchVoices(await requireKey()))
-  ipcMain.handle('voice:setConfig', (_event, patch: Partial<VoiceConfig>) => updateConfig(patch))
-  ipcMain.handle('voice:synthesize', (_event, text: string) => synthesize(text))
-}
diff --git a/src/preload/index.ts b/src/preload/index.ts
index ac5669e..4619884 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -7,15 +7,8 @@ import type {
   SessionSelect,
   V2SocketOpenResult,
   AppServerTest,
-  LinearIssue,
-  LinearKeyResult,
   InitialWindowState,
   RecentEntry,
-  SkillInfo,
-  VoiceConfig,
-  VoiceInfo,
-  VoiceKeyResult,
-  VoiceSettings,
 } from '../shared/types'
 import type { LlmSettings, LlmSettingsPatch, LocalBackend, ModelInfo } from '../shared/providers/types'
 
@@ -63,13 +56,6 @@ const api = {
   githubPrHeadBranch: (owner: string, repo: string, number: number): Promise<string | null> =>
     ipcRenderer.invoke('github:prHeadBranch', owner, repo, number),
 
-  // Linear — the API key stays in the main process
-  linearHasApiKey: (): Promise<boolean> => ipcRenderer.invoke('linear:hasApiKey'),
-  linearSetApiKey: (apiKey: string): Promise<LinearKeyResult> =>
-    ipcRenderer.invoke('linear:setApiKey', apiKey),
-  linearClearApiKey: (): Promise<void> => ipcRenderer.invoke('linear:clearApiKey'),
-  linearFetchIssues: (ids: string[]): Promise<LinearIssue[]> =>
-    ipcRenderer.invoke('linear:fetchIssues', ids),
 
   // Agent CLIs — app-wide defaults and local model lists
   llmGetSettings: (): Promise<LlmSettings> => ipcRenderer.invoke('llm:getSettings'),
@@ -80,15 +66,6 @@ const api = {
   llmFetchModels: (backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> =>
     ipcRenderer.invoke('llm:fetchModels', backend, baseUrl),
 
-  // ElevenLabs voice summaries — the API key stays in the main process
-  voiceGetSettings: (): Promise<VoiceSettings> => ipcRenderer.invoke('voice:getSettings'),
-  voiceSetApiKey: (apiKey: string): Promise<VoiceKeyResult> =>
-    ipcRenderer.invoke('voice:setApiKey', apiKey),
-  voiceClearApiKey: (): Promise<void> => ipcRenderer.invoke('voice:clearApiKey'),
-  voiceListVoices: (): Promise<VoiceInfo[]> => ipcRenderer.invoke('voice:listVoices'),
-  voiceSetConfig: (patch: Partial<VoiceConfig>): Promise<VoiceConfig> =>
-    ipcRenderer.invoke('voice:setConfig', patch),
-  voiceSynthesize: (text: string): Promise<Uint8Array> => ipcRenderer.invoke('voice:synthesize', text),
 
   // App-wide trek-servers (protocol v2). Tokens can be set, never read.
   appServers: {
@@ -170,9 +147,6 @@ const api = {
   showError: (title: string, message: string): Promise<void> =>
     ipcRenderer.invoke('dialog:error', title, message),
 
-  // Skills
-  listSkills: (worktreePath: string): Promise<SkillInfo[]> =>
-    ipcRenderer.invoke('skills:list', worktreePath),
 
   // Menu events
   onMenu: (
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index b386a65..340c2f7 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -6,7 +6,7 @@ import { StartScreen, type StartView } from './components/StartScreen'
 import { ServerProjectWindow } from './v2/ServerProjectWindow'
 import { requestSessionSelect, watchAttention } from './attentionSelect'
 import { useLinearSync } from './linear'
-import { loadVoiceSettings } from './voice'
+import { useVoice } from './voice'
 import { loadLlmSettings, watchLlmSettings } from './llm'
 import { SummaryBubble } from './components/SummaryBubble'
 import { titleBarForeground } from '../../shared/appearance'
@@ -25,9 +25,9 @@ export default function App(): React.JSX.Element {
     if (serverWindow) setStartRequest(undefined)
   }, [serverWindow])
   useLinearSync()
+  useVoice()
 
   useEffect(() => {
-    void loadVoiceSettings()
     void loadLlmSettings()
     return watchLlmSettings()
   }, [])
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index 745fd74..1e98382 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -27,14 +27,22 @@ import type {
   EnvironmentInfo,
   EnvironmentSettings,
   GitWorktreeInfo,
+  LinearIssue,
+  LinearKeyResult,
   Repository,
   SessionType,
+  SkillInfo,
   StackLogChunk,
   StackStatus,
   WorktreeChanges,
+  VoiceInfo,
+  VoiceKeyResult,
+  VoiceServerConfig,
+  VoiceServerSettings,
   WorktreeInstance,
   WorktreeLocator
 } from '../../shared/types'
+import type { VoiceSummaryEvent } from '../../shared/protocolV2'
 
 export type { BackendFeatures, FeatureName } from './backendFeatures'
 
@@ -138,6 +146,29 @@ export interface WindowBackend {
     destroy(loc: WorktreeLocator): Promise<number>
     log(loc: WorktreeLocator, fileId: number, offset: number): Promise<StackLogChunk>
   }
+  /** Linear with the server's own API key (feature `linear`); the key is never sent back */
+  readonly linear: {
+    hasKey(): Promise<boolean>
+    setKey(apiKey: string): Promise<LinearKeyResult>
+    clearKey(): Promise<void>
+    issues(ids: string[]): Promise<LinearIssue[]>
+  }
+  /** ElevenLabs with the server's own API key (feature `voice`) */
+  readonly voice: {
+    settings(): Promise<VoiceServerSettings>
+    setKey(apiKey: string): Promise<VoiceKeyResult>
+    clearKey(): Promise<void>
+    voices(): Promise<VoiceInfo[]>
+    setConfig(patch: Partial<VoiceServerConfig>): Promise<VoiceServerConfig>
+    /** An mp3 of `text`, for this window only (Settings' Test) */
+    synthesize(text: string): Promise<Uint8Array>
+    /** The project's sessions' spoken summaries (speak_summary), as the server sends them; returns the unsubscribe */
+    onSummary(listener: (event: VoiceSummaryEvent) => void): () => void
+  }
+  /** A worktree's Claude Code skills and commands, and the server user's (feature `skills`) */
+  readonly skills: {
+    list(loc: WorktreeLocator): Promise<SkillInfo[]>
+  }
   /** Branch data; null or an empty text clears the value */
   readonly branch: {
     setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
@@ -224,6 +255,9 @@ export const idleBackend: WindowBackend = {
     onLog: () => () => {}
   },
   stacks: { status: noProject, up: noProject, down: noProject, destroy: noProject, log: noProject },
+  linear: { hasKey: noProject, setKey: noProject, clearKey: noProject, issues: noProject },
+  voice: { settings: noProject, setKey: noProject, clearKey: noProject, voices: noProject, setConfig: noProject, synthesize: noProject, onSummary: () => () => {} },
+  skills: { list: noProject },
   branch: { setTag: noProject, setCustomTag: noProject, setNote: noProject, setTicket: noProject, setPullRequest: noProject, setEnvVars: noProject },
   repos: { add: noProject, remove: noProject },
   errors: {
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index 2efddeb..801324e 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -40,19 +40,19 @@ export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map
 /**
  * A server window (3c-2, 4c, 5a). The ceiling: the v2 backend's features are
  * these AND what `v2Features` asks of the server's welcome and the window's entry.
- * - Off: the bot and voice (phase 5) and the git flows protocol v2 has no
- *   command for (moving a worktree, promote).
+ * - Off: the bot (phase 5) and the git flows protocol v2 has no command for
+ *   (moving a worktree, promote).
  * - Settings are edited on the server (every v2 server has
  *   project.updateSettings, so no capability), with the sections
  *   `settingsSections` picks.
- * - Linear only reads ticket ids, with this machine's API key: on for every
- *   server (4c).
+ * - Linear, voice and skills are the server's (5b): Linear and ElevenLabs
+ *   with the server's own keys, the skills read on its disk; each needs its
+ *   capability, on any server.
  * - The Global panel needs `mcp`.
  * - Docker, environments and stacks run on the server's machine (5a): each
  *   needs its capability, on any server.
- * - Skills, Reveal and Open in VS Code read or open things on this machine at
- *   the project's paths: only the Local server's paths are on this disk
- *   (`MACHINE_FEATURES`).
+ * - Reveal and Open in VS Code open things on this machine at the project's
+ *   paths: only the Local server's paths are on this disk (`MACHINE_FEATURES`).
  */
 export const V2_FEATURES: BackendFeatures = {
   docker: true,
@@ -60,7 +60,7 @@ export const V2_FEATURES: BackendFeatures = {
   stacks: true,
   bot: false,
   linear: true,
-  voice: false,
+  voice: true,
   skills: true,
   moveWorktree: false,
   reveal: true,
@@ -74,13 +74,17 @@ export const V2_FEATURES: BackendFeatures = {
  * The welcome capability a v2 feature needs, if any. Global sessions drive the
  * worktree sessions through the server's MCP tools, so without `mcp` they
  * could not do their job. Docker, the environments and the stacks are the
- * server's own methods (5a): a server older than them has none of the three.
+ * server's own methods (5a), and Linear, voice and skills (5b): a server older
+ * than them has none of them.
  */
 const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   globalPanel: 'mcp',
   docker: 'docker',
   env: 'env',
-  stacks: 'stacks'
+  stacks: 'stacks',
+  linear: 'linear',
+  voice: 'voice',
+  skills: 'skills'
 }
 
 /**
@@ -89,9 +93,9 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
  * supervisor's own server, which main found by its pid and profile) when its
  * welcome says `local` too. Never by the capability alone: a saved entry can
  * reach another machine's Local server through a tunnel, still on 127.0.0.1,
- * and its paths are not here. Skills move to the server in 5b.
+ * and its paths are not here. Skills moved to the server in 5b.
  */
-export const MACHINE_FEATURES: readonly FeatureName[] = ['skills', 'reveal', 'openInEditor']
+export const MACHINE_FEATURES: readonly FeatureName[] = ['reveal', 'openInEditor']
 
 /** The `local` welcome capability (CAPABILITY.local in shared/protocolV2.ts). */
 const LOCAL_CAPABILITY = 'local'
@@ -171,16 +175,15 @@ export type SectionMode = 'edit' | 'project' | 'hidden'
 
 /**
  * Which Settings sections a window shows. A server window edits the project's
- * settings on the server and hides what belongs to this machine: the voice API
- * keys. Linear (its key is app-wide, in main) shows where the window has the
- * feature (every server), and the Docker environments where it has `env` (a
- * server that runs them, on its own machine).
+ * settings on the server; Linear and Voice (their keys are the server's, 5b)
+ * show where it has `linear` and `voice`, and the Docker environments where it
+ * has `env` (a server that runs them, on its own machine).
  */
 export function settingsSections(features: BackendFeatures): Readonly<Record<SettingsSection, SectionMode>> {
   const out = {} as Record<SettingsSection, SectionMode>
   for (const name of SETTINGS_SECTIONS) out[name] = 'edit'
   if (!features.linear) out.linear = 'hidden'
-  out.voice = 'hidden'
+  if (!features.voice) out.voice = 'hidden'
   if (!features.env) out.environments = 'hidden'
   out.agents = 'project'
   return out
diff --git a/src/renderer/src/components/LinearSettings.tsx b/src/renderer/src/components/LinearSettings.tsx
index a5fca00..a51db84 100644
--- a/src/renderer/src/components/LinearSettings.tsx
+++ b/src/renderer/src/components/LinearSettings.tsx
@@ -1,7 +1,8 @@
 import { useState } from 'react'
 import { useAppStore } from '../store'
+import { getBackend } from '../backend'
 
-/** Linear API key — stored encrypted on this machine, shared by every project. */
+/** Linear API key — the window's server's, shared by every project on it. */
 export function LinearSettings(): React.JSX.Element {
   const connected = useAppStore((s) => s.linearConnected)
   const setLinearConnected = useAppStore((s) => s.setLinearConnected)
@@ -14,7 +15,14 @@ export function LinearSettings(): React.JSX.Element {
     if (!apiKey.trim()) return
     setBusy(true)
     setError(null)
-    const result = await window.api.linearSetApiKey(apiKey)
+    let result: Awaited<ReturnType<ReturnType<typeof getBackend>['linear']['setKey']>>
+    try {
+      result = await getBackend().linear.setKey(apiKey)
+    } catch (err) {
+      setBusy(false)
+      setError(err instanceof Error ? err.message : String(err))
+      return
+    }
     setBusy(false)
     if (!result.ok) {
       setError(result.error)
@@ -26,7 +34,12 @@ export function LinearSettings(): React.JSX.Element {
   }
 
   const disconnect = async (): Promise<void> => {
-    await window.api.linearClearApiKey()
+    try {
+      await getBackend().linear.clearKey()
+    } catch (err) {
+      setError(err instanceof Error ? err.message : String(err))
+      return
+    }
     setUser(null)
     setLinearConnected(false)
   }
@@ -39,8 +52,9 @@ export function LinearSettings(): React.JSX.Element {
           <span className="settings-name">API key</span>
           <span className="settings-desc">
             Shows each linked issue&apos;s title and status on its ticket chip. Create a personal
-            key under Linear → Settings → Security &amp; access. Stored encrypted on this machine,
-            not in the project.
+            key under Linear → Settings → Security &amp; access. Stored on this project&apos;s
+            server (owner-only, never sent back), not in the project, and used by every project on
+            it.
           </span>
           {connected && (
             <span className="settings-desc">Connected{user ? ` as ${user}` : ''}</span>
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index 73dc5f3..a45918b 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -27,8 +27,8 @@ interface Props {
 
 export function SettingsPanel({ visible }: Props): React.JSX.Element {
   // The project's settings are edited on the server: text is committed on blur (each commit is a
-  // request), this machine's sections are hidden (but a Local window's environments, and Linear
-  // everywhere), and a conflict's Reload remounts it.
+  // request), Linear, Voice and the environments show where the window's server has them (their
+  // keys and VMs are the server's), and a conflict's Reload remounts it.
   const features = useFeatures()
   const sections = settingsSections(features)
   const reload = useAppStore((s) => s.settingsReload)
diff --git a/src/renderer/src/components/SkillMenu.tsx b/src/renderer/src/components/SkillMenu.tsx
index 95ec3ea..93df165 100644
--- a/src/renderer/src/components/SkillMenu.tsx
+++ b/src/renderer/src/components/SkillMenu.tsx
@@ -1,6 +1,7 @@
 import { useEffect, useRef, useState } from 'react'
 import { createPortal } from 'react-dom'
 import { useAppStore } from '../store'
+import { getBackend } from '../backend'
 import { focusTerminal, writeTerminal } from '../terminals'
 import type { SkillInfo, WorktreeInstance } from '../../../shared/types'
 
@@ -52,9 +53,10 @@ export function SkillMenu({ worktree, terminalId }: Props): React.JSX.Element {
     })
     setSkills(null)
     setOpen(true)
-    // Fetched on every open so newly added skills show up without a restart.
-    window.api
-      .listSkills(worktree.path)
+    // Fetched on every open so newly added skills show up without a restart; the window's server
+    // reads the worktree's .claude and its user's ~/.claude on its disk.
+    getBackend()
+      .skills.list({ path: worktree.path })
       .then(setSkills)
       .catch(() => setSkills([]))
   }
diff --git a/src/renderer/src/components/VoiceSettings.tsx b/src/renderer/src/components/VoiceSettings.tsx
index 9f9baf0..278b309 100644
--- a/src/renderer/src/components/VoiceSettings.tsx
+++ b/src/renderer/src/components/VoiceSettings.tsx
@@ -1,6 +1,7 @@
 import { useEffect, useState } from 'react'
 import { useAppStore } from '../store'
-import { loadVoiceSettings, speakSummary, updateVoiceConfig } from '../voice'
+import { getBackend } from '../backend'
+import { loadVoiceSettings, testVoice, updateVoiceConfig } from '../voice'
 import type { VoiceInfo } from '../../../shared/types'
 
 const MODELS = [
@@ -9,7 +10,7 @@ const MODELS = [
   { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — most natural' }
 ]
 
-/** ElevenLabs key and voice — stored on this machine, shared by every project. */
+/** ElevenLabs key and voice — the window's server's, shared by every project on it. */
 export function VoiceSettings(): React.JSX.Element {
   const voice = useAppStore((s) => s.voice)
   const [apiKey, setApiKey] = useState('')
@@ -20,37 +21,53 @@ export function VoiceSettings(): React.JSX.Element {
 
   useEffect(() => {
     if (!connected) return
-    window.api
-      .voiceListVoices()
+    getBackend()
+      .voice.voices()
       .then(setVoices)
       .catch((err: Error) => setError(err.message))
   }, [connected])
 
+  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))
+
   const connect = async (): Promise<void> => {
     if (!apiKey.trim()) return
     setBusy(true)
     setError(null)
-    const result = await window.api.voiceSetApiKey(apiKey)
-    setBusy(false)
-    if (!result.ok) {
-      setError(result.error)
-      return
+    try {
+      const result = await getBackend().voice.setKey(apiKey)
+      if (!result.ok) {
+        setError(result.error)
+        return
+      }
+      setApiKey('')
+      setVoices(result.voices)
+      await loadVoiceSettings()
+    } catch (err) {
+      fail(err)
+    } finally {
+      setBusy(false)
     }
-    setApiKey('')
-    setVoices(result.voices)
-    await loadVoiceSettings()
   }
 
   const disconnect = async (): Promise<void> => {
-    await window.api.voiceClearApiKey()
-    setVoices([])
-    await loadVoiceSettings()
+    try {
+      await getBackend().voice.clearKey()
+      setVoices([])
+      await loadVoiceSettings()
+    } catch (err) {
+      fail(err)
+    }
+  }
+
+  const update = (patch: Parameters<typeof updateVoiceConfig>[0]): void => {
+    setError(null)
+    updateVoiceConfig(patch).catch(fail)
   }
 
   const test = async (): Promise<void> => {
     setError(null)
     try {
-      const result = await speakSummary('', 'This is how spoken summaries from your agent sessions will sound.')
+      const result = await testVoice('This is how spoken summaries from your agent sessions will sound.')
       if (!result.played) setError(result.reason)
     } catch (err) {
       setError(err instanceof Error ? err.message : String(err))
@@ -64,9 +81,10 @@ export function VoiceSettings(): React.JSX.Element {
         <span className="settings-label">
           <span className="settings-name">ElevenLabs API key</span>
           <span className="settings-desc">
-            Lets agent sessions read a short summary aloud (the speak_summary tool), while the
-            sidebar toggle is set to Active. Stored encrypted on this machine, not in the project
-            file.
+            Lets agent sessions read a short summary aloud (the speak_summary tool) in every window
+            that has their project open, while that app&apos;s sidebar toggle is set to Active. Stored
+            on this project&apos;s server (owner-only, never sent back), with its voice and model,
+            for every project on it.
           </span>
           {error && <span className="settings-desc settings-warn">{error}</span>}
         </span>
@@ -102,7 +120,7 @@ export function VoiceSettings(): React.JSX.Element {
               <select
                 className="settings-select"
                 value={voice.voiceId}
-                onChange={(e) => void updateVoiceConfig({ voiceId: e.target.value })}
+                onChange={(e) => update({ voiceId: e.target.value })}
               >
                 {!voices.some((v) => v.id === voice.voiceId) && (
                   <option value={voice.voiceId}>{voice.voiceId || 'Choose a voice'}</option>
@@ -122,7 +140,7 @@ export function VoiceSettings(): React.JSX.Element {
             <input
               type="checkbox"
               checked={voice.promptSessions}
-              onChange={(e) => void updateVoiceConfig({ promptSessions: e.target.checked })}
+              onChange={(e) => update({ promptSessions: e.target.checked })}
             />
             <span className="settings-label">
               <span className="settings-name">Summarize automatically</span>
@@ -140,7 +158,7 @@ export function VoiceSettings(): React.JSX.Element {
             <select
               className="settings-select"
               value={voice.modelId}
-              onChange={(e) => void updateVoiceConfig({ modelId: e.target.value })}
+              onChange={(e) => update({ modelId: e.target.value })}
             >
               {!MODELS.some((m) => m.id === voice.modelId) && (
                 <option value={voice.modelId}>{voice.modelId}</option>
diff --git a/src/renderer/src/components/VoiceToggle.tsx b/src/renderer/src/components/VoiceToggle.tsx
index 66b2fba..1b2505e 100644
--- a/src/renderer/src/components/VoiceToggle.tsx
+++ b/src/renderer/src/components/VoiceToggle.tsx
@@ -1,7 +1,7 @@
 import { useAppStore } from '../store'
 import { updateVoiceConfig } from '../voice'
 
-/** Active plays spoken summaries; Busy silences them. */
+/** Active plays spoken summaries in this app's windows; Busy silences them (an app-wide setting). */
 export function VoiceToggle(): React.JSX.Element | null {
   const voice = useAppStore((s) => s.voice)
   if (!voice?.hasApiKey) return null
@@ -14,7 +14,7 @@ export function VoiceToggle(): React.JSX.Element | null {
           ? 'Active — spoken summaries play. Click to go Busy.'
           : 'Busy — spoken summaries are skipped. Click to go Active.'
       }
-      onClick={() => void updateVoiceConfig({ active: !active })}
+      onClick={() => void updateVoiceConfig({ active: !active }).catch((err) => console.warn('Could not change Active/Busy', err))}
     >
       <span className="voice-toggle-dot" />
       {active ? 'Active' : 'Busy'}
diff --git a/src/renderer/src/linear.ts b/src/renderer/src/linear.ts
index a9b32be..c0e6fec 100644
--- a/src/renderer/src/linear.ts
+++ b/src/renderer/src/linear.ts
@@ -1,7 +1,10 @@
 import { useEffect } from 'react'
 import { allBranchTickets, isLinearTicket, useAppStore } from './store'
+import { getBackend } from './backend'
 import { useFeatures } from './useFeatures'
 
+// The ticket chips' Linear issues, looked up by the window's server with its own key (5b).
+
 const REFRESH_MS = 5 * 60_000
 /** Window focus refreshes, but not more often than this. */
 const FOCUS_THROTTLE_MS = 60_000
@@ -14,10 +17,13 @@ function linkedLinearIds(): string[] {
 }
 
 export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void> {
-  if (!useAppStore.getState().linearConnected || ids.length === 0) return
+  const backend = getBackend()
+  if (!backend.features.linear || !useAppStore.getState().linearConnected || ids.length === 0) return
   lastRefresh = Date.now()
   try {
-    useAppStore.getState().setLinearIssues(await window.api.linearFetchIssues(ids))
+    const issues = await backend.linear.issues(ids)
+    // The window moved to another server meanwhile: not its issues.
+    if (getBackend() === backend) useAppStore.getState().setLinearIssues(issues)
   } catch (err) {
     // Chips fall back to the bare id; the next refresh retries.
     console.warn('Linear issue refresh failed', err)
@@ -27,8 +33,9 @@ export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void
 /** Keeps the store's Linear issue cache fresh for the open project's tickets. */
 export function useLinearSync(): void {
   const connected = useAppStore((s) => s.linearConnected)
-  // Every window has Linear (4c); the effect still re-runs when the window's features change.
-  const linear = useFeatures().linear
+  // A new object for each backend and each welcome: the key is asked again for the window's server.
+  const features = useFeatures()
+  const linear = features.linear
   // Joined so the effect only re-runs when the set of linked ids changes.
   const idsKey = useAppStore((s) =>
     [...new Set(allBranchTickets(s.project).filter(isLinearTicket))]
@@ -37,10 +44,18 @@ export function useLinearSync(): void {
   )
 
   useEffect(() => {
-    void window.api.linearHasApiKey().then((has) => {
-      useAppStore.getState().setLinearConnected(has)
-    })
-  }, [])
+    const backend = getBackend()
+    if (!backend.features.linear) {
+      useAppStore.getState().setLinearConnected(false)
+      return
+    }
+    backend.linear.hasKey().then(
+      (has) => {
+        if (getBackend() === backend) useAppStore.getState().setLinearConnected(has)
+      },
+      (err) => console.warn('Linear key check failed', err)
+    )
+  }, [features])
 
   useEffect(() => {
     if (!connected || !idsKey || !linear) return
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 45f3a09..1a97d86 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -151,6 +151,14 @@ const LONG_MS = 30 * 60_000
 const SLOW_MS = 10 * 60_000
 /** docker start, stop and restart (the server gives docker two minutes) */
 const CONTAINER_MS = 3 * 60_000
+/** A base64 text (an mp3 over the wire) as bytes. */
+export function base64Bytes(text: string): Uint8Array {
+  const binary = atob(text)
+  const bytes = new Uint8Array(binary.length)
+  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
+  return bytes
+}
+
 const NOT_REGISTERED = "Registered on the server but it isn't visible here yet — try again."
 
 export function createV2Backend(deps: V2BackendDeps): WindowBackend {
@@ -504,6 +512,32 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       destroy: async (loc) => request('stack.destroy', { projectId, worktreeId: worktreeAt(loc.path) }, { timeoutMs: SLOW_MS }),
       log: async (loc, fileId, offset) => request('stack.log', { projectId, worktreeId: worktreeAt(loc.path), fileId, offset })
     },
+    linear: {
+      hasKey: async () => (await request('linear.status', {})).hasKey,
+      setKey: (apiKey) => request('linear.setKey', { apiKey }),
+      clearKey: async () => {
+        await request('linear.clearKey', {})
+      },
+      issues: (ids) => request('linear.issues', { ids })
+    },
+    voice: {
+      settings: () => request('voice.settings', {}),
+      setKey: (apiKey) => request('voice.setKey', { apiKey }),
+      clearKey: async () => {
+        await request('voice.clearKey', {})
+      },
+      voices: () => request('voice.voices', {}),
+      setConfig: (patch) => request('voice.setConfig', patch),
+      synthesize: async (text) => base64Bytes((await request('voice.synthesize', { text })).audio),
+      // Only this project's: the server sends a project's summaries to its subscribers only.
+      onSummary: (listener) =>
+        deps.onEvent('voice.summary', (event) => {
+          if (event.projectId === projectId) listener(event)
+        })
+    },
+    skills: {
+      list: async (loc) => request('skills.list', { projectId, worktreeId: worktreeAt(loc.path) })
+    },
     branch: {
       setTag: async (repoId, branch, tagId) => {
         await request('branch.setTag', { ...branchRef(repoId, branch), tag: tagId })
diff --git a/src/renderer/src/voice.ts b/src/renderer/src/voice.ts
index 5a843b3..e81ac17 100644
--- a/src/renderer/src/voice.ts
+++ b/src/renderer/src/voice.ts
@@ -1,10 +1,18 @@
+import { useEffect } from 'react'
 import { useAppStore, type SpokenSummary } from './store'
-import type { VoiceConfig } from '../../shared/types'
+import { getBackend } from './backend'
+import { useFeatures } from './useFeatures'
+import { base64Bytes } from './v2/backendV2'
+import type { VoiceConfig, VoiceSettings } from '../../shared/types'
 
 /**
- * Spoken summaries from Claude sessions (the speak_summary MCP tool),
- * synthesized by ElevenLabs in the main process. Clips play one at a time,
- * in arrival order, and only while the app is set to Active.
+ * Spoken summaries from agent sessions (the speak_summary MCP tool). Since 5b the
+ * window's server synthesizes them with its ElevenLabs key and sends each clip
+ * to every window that has the project open (`voice.summary`); this window
+ * plays them one at a time, in arrival order, and only while this app is set
+ * to Active (an app-wide setting, `voiceActive`: the user's presence here, not
+ * the server's). The key, voice, model and "Summarize automatically" are the
+ * server's.
  */
 
 export const MAX_SUMMARY_CHARS = 400
@@ -55,35 +63,102 @@ export function stopAllSummaries(): void {
   publish()
 }
 
-export async function loadVoiceSettings(): Promise<void> {
-  useAppStore.getState().setVoice(await window.api.voiceGetSettings())
+const isActive = (): boolean => useAppStore.getState().voice?.active !== false
+
+/** Queues a clip to play; its position in the queue (0: playing now). */
+function enqueue(terminalId: string, text: string, audio: Uint8Array): number {
+  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
+  queue.push({ terminalId, text, url })
+  const position = queue.length + (current ? 1 : 0) - 1
+  playNext()
+  return position
 }
 
-export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
-  const config = await window.api.voiceSetConfig(patch)
-  const voice = useAppStore.getState().voice
-  useAppStore.getState().setVoice({ hasApiKey: voice?.hasApiKey ?? false, ...config })
-  if (!config.active) stopAllSummaries()
+/** This app's Active/Busy, from the app settings (true when they cannot be read). */
+async function appActive(): Promise<boolean> {
+  try {
+    return (await window.api.appSettings.get()).voiceActive !== false
+  } catch {
+    return true
+  }
 }
 
-export const voiceReady = (): boolean => !!useAppStore.getState().voice?.hasApiKey
+/**
+ * The window's server's voice settings with this app's Active/Busy, or null
+ * when the window's server has no voice (or the window has no project).
+ */
+export async function loadVoiceSettings(): Promise<void> {
+  const backend = getBackend()
+  if (!backend.features.voice) {
+    useAppStore.getState().setVoice(null)
+    return
+  }
+  const [server, active] = await Promise.all([backend.voice.settings(), appActive()])
+  // The window moved to another server meanwhile: its own load wins.
+  if (getBackend() !== backend) return
+  const { hasKey, ...config } = server
+  const voice: VoiceSettings = { ...config, hasApiKey: hasKey, active }
+  useAppStore.getState().setVoice(voice)
+}
 
-const isActive = (): boolean => useAppStore.getState().voice?.active !== false
+/** `active` is this app's (app settings); the rest is the window's server's. */
+export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
+  const { active, ...server } = patch
+  const before = useAppStore.getState().voice
+  if (!before) return
+  let next: VoiceSettings = { ...before }
+  if (active !== undefined) {
+    const settings = await window.api.appSettings.update({ voiceActive: active })
+    next = { ...next, active: settings.voiceActive }
+  }
+  if (Object.keys(server).length > 0) {
+    const backend = getBackend()
+    const config = await backend.voice.setConfig(server)
+    if (getBackend() !== backend) return
+    next = { ...next, ...config }
+  }
+  useAppStore.getState().setVoice(next)
+  if (!next.active) stopAllSummaries()
+}
 
-export type SpeakResult =
-  | { played: true; position: number }
-  | { played: false; reason: string }
+export type SpeakResult = { played: true; position: number } | { played: false; reason: string }
 
-/** Synthesizes a summary and queues it, unless the user is Busy. */
-export async function speakSummary(terminalId: string, text: string): Promise<SpeakResult> {
+/** Settings' Test: synthesized for this window only, and played unless the user is Busy. */
+export async function testVoice(text: string): Promise<SpeakResult> {
   const busy: SpeakResult = { played: false, reason: 'The user is Busy, so it was not played' }
   if (!isActive()) return busy
-  const audio = await window.api.voiceSynthesize(text)
+  const audio = await getBackend().voice.synthesize(text)
   // The user may have gone Busy while it was synthesizing.
   if (!isActive()) return busy
-  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
-  queue.push({ terminalId, text, url })
-  const position = queue.length + (current ? 1 : 0) - 1
-  playNext()
-  return { played: true, position }
+  return { played: true, position: enqueue('', text, audio) }
+}
+
+/**
+ * Keeps the window's voice settings for its server, plays the summaries the
+ * server sends for its project, and follows the app's Active/Busy (changed in
+ * any window).
+ */
+export function useVoice(): void {
+  const features = useFeatures()
+  useEffect(() => {
+    void loadVoiceSettings().catch((err) => {
+      console.warn('Voice settings could not be read', err)
+      useAppStore.getState().setVoice(null)
+    })
+    if (!features.voice) return
+    const offSummary = getBackend().voice.onSummary((event) => {
+      if (!isActive()) return
+      enqueue(event.sessionId, event.text, base64Bytes(event.audio))
+    })
+    const offSettings = window.api.appSettings.onChanged((settings) => {
+      const voice = useAppStore.getState().voice
+      if (!voice || voice.active === settings.voiceActive) return
+      useAppStore.getState().setVoice({ ...voice, active: settings.voiceActive })
+      if (!settings.voiceActive) stopAllSummaries()
+    })
+    return () => {
+      offSummary()
+      offSettings()
+    }
+  }, [features])
 }
diff --git a/src/shared/appSettings.ts b/src/shared/appSettings.ts
index 595f7dd..83b19d4 100644
--- a/src/shared/appSettings.ts
+++ b/src/shared/appSettings.ts
@@ -6,9 +6,11 @@ export interface AppSettings {
   showNotifications: boolean
   /** Quitting Trek stops the Local server too; off by default, so it keeps running */
   stopLocalServerOnQuit: boolean
+  /** Active plays the sessions' spoken summaries in this app's windows; Busy (false) skips them */
+  voiceActive: boolean
 }
 
-export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true, stopLocalServerOnQuit: false })
+export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true, stopLocalServerOnQuit: false, voiceActive: true })
 
 /** A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`. */
 export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
@@ -16,6 +18,7 @@ export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEF
   const flag = (key: keyof AppSettings): boolean => (typeof from[key] === 'boolean' ? (from[key] as boolean) : base[key])
   return {
     showNotifications: flag('showNotifications'),
-    stopLocalServerOnQuit: flag('stopLocalServerOnQuit')
+    stopLocalServerOnQuit: flag('stopLocalServerOnQuit'),
+    voiceActive: flag('voiceActive')
   }
 }
diff --git a/src/shared/types.ts b/src/shared/types.ts
index a4cf800..16f6917 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -668,17 +668,17 @@ export interface LinearIssue {
 /** `present`: a set-if-absent (the app's hand-over) found a key already stored, and kept it. */
 export type LinearKeyResult = { ok: true; user: string } | { ok: false; error: string; present?: true }
 
-/** Machine-wide ElevenLabs voice summary settings (not per project). */
-export interface VoiceConfig {
-  voiceId: string
-  modelId: string
-  /** Active plays spoken summaries; Busy (false) drops them. */
+/**
+ * A window's view of voice summaries (phase 5b): its server's voice, model and "Summarize
+ * automatically" (VoiceServerConfig), with this app's Active/Busy (`voiceActive` in the app settings).
+ */
+export interface VoiceConfig extends VoiceServerConfig {
+  /** Active plays spoken summaries in this app's windows; Busy (false) drops them. */
   active: boolean
-  /** Tell Claude sessions to call speak_summary on their own when they finish or need the user. */
-  promptSessions: boolean
 }
 
 export interface VoiceSettings extends VoiceConfig {
+  /** The window's server has an ElevenLabs key */
   hasApiKey: boolean
 }
 
````

- [ ] **Step 2: Run the tests**

Run: `node --test scripts/integrationsHandover.test.mjs scripts/backendFeatures.test.mjs scripts/v2Backend.test.mjs scripts/appSettings.test.mjs`
Expected: PASS: the gate (linear, voice, skills by capability, on any server; reveal and openInEditor still Local only); the backend's methods and `onSummary` decoding; the hand-over's order, `ifAbsent`, the pending voice config, nothing re-sent once done.

- [ ] **Step 3: Nothing still calls the deleted members**

Run: `grep -rn "linearFetchIssues\|linearHasApiKey\|linearSetApiKey\|linearClearApiKey\|voiceGetSettings\|voiceSetApiKey\|voiceClearApiKey\|voiceListVoices\|voiceSetConfig\|voiceSynthesize\|listSkills\|registerLinearHandlers\|registerVoiceHandlers\|registerSkillHandlers" src`
Expected: no output.

- [ ] **Step 4: Typecheck, the suite, build**

Run: `npm run typecheck && npm test && npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/main/integrationsHandover.ts src/main/integrationsHandoverRules.ts scripts/integrationsHandover.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5b): every server window has Linear, voice and skills from its server; main hands the app's keys and voice settings to the Local server once; Active/Busy is an app setting; main's linear.ts, voice.ts, skills.ts and their preload members go" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

---

### Task 6: A handed-over key is stored unchecked; the smokes

**Files:**
- Create: `scripts/server-integrations-smoke.mjs`
- Modify: `src/host/linearService.ts`, `src/host/voiceService.ts`, `src/main/integrationsHandoverRules.ts`, `src/main/localServerRules.ts`, `src/shared/protocolV2.ts`, `package.json`, `scripts/{local-features,server-env,v2}-smoke.mjs`
- Test: `scripts/serverIntegrations.test.mjs`, `scripts/localServerRules.test.mjs`; the smokes

Decisions 11, 18, 20, 21.

- [ ] **Step 1: The unchecked hand-over key and the test URLs through `childEnv`** (4c0f764)

````diff
diff --git a/scripts/localServerRules.test.mjs b/scripts/localServerRules.test.mjs
index 8a6b156..2830eaf 100644
--- a/scripts/localServerRules.test.mjs
+++ b/scripts/localServerRules.test.mjs
@@ -73,6 +73,8 @@ test('TREK_LOCAL_PROFILE: a dev build takes a valid name, an invalid one is dev;
   assert.equal(localProfileName(true, { TREK_LOCAL_PROFILE: 'dev-wt2' }), undefined)
   // The server never inherits it: childEnv drops every TREK_ variable.
   assert.equal('TREK_LOCAL_PROFILE' in childEnv({ TREK_LOCAL_PROFILE: 'dev-wt2', PATH: '/bin' }), false)
+  // Only the server's test endpoints for Linear and ElevenLabs get through (the smokes' stubs, 5b).
+  assert.deepEqual(childEnv({ TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_OTHER: 'x' }), { TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', ELECTRON_RUN_AS_NODE: '1' })
 })
 
 test('isLocalServerCommand: trek-server, start --local, and this profile\'s --local-profile', () => {
diff --git a/scripts/serverIntegrations.test.mjs b/scripts/serverIntegrations.test.mjs
index ee20770..de46bc3 100644
--- a/scripts/serverIntegrations.test.mjs
+++ b/scripts/serverIntegrations.test.mjs
@@ -153,14 +153,14 @@ test('linear.setKey checks the key with Linear, stores it 0600 and never sends i
   assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
 })
 
-test('linear.setKey ifAbsent keeps a stored key without asking Linear', async (t) => {
+test('linear.setKey ifAbsent (the hand-over) stores the key unchecked, and keeps a stored one', async (t) => {
   const s = await setup(t)
-  assert.equal((await s.call('linear.setKey', { apiKey: 'good-key', ifAbsent: true })).result.ok, true)
-  const before = s.stub.requests.length
+  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'app-key', ifAbsent: true })).result, { ok: true, user: '' })
   const again = await s.call('linear.setKey', { apiKey: 'other-key', ifAbsent: true })
   assert.deepEqual(again.result, { ok: false, error: 'This server already has a key; it was kept', present: true })
-  assert.equal(s.stub.requests.length, before)
-  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'good-key' })
+  // Linear was never asked: the app checked the key when it was entered.
+  assert.equal(s.stub.requests.length, 0)
+  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'app-key' })
 })
 
 test('linear.issues looks the ids up in batches of 50 and leaves out unknown and malformed ids', async (t) => {
@@ -214,10 +214,13 @@ test('voice.setKey checks the key by listing its voices, picks the first voice,
   await s.call('voice.setConfig', { voiceId: 'v2' })
   await s.call('voice.setKey', { apiKey: 'good-voice' })
   assert.equal((await s.call('voice.settings', {})).result.voiceId, 'v2')
-  // ifAbsent keeps the stored key without a request.
+  // ifAbsent keeps the stored key without a request, and stores one unchecked on a server without.
   const before = s.voiceStub.requests.length
   assert.deepEqual((await s.call('voice.setKey', { apiKey: 'other', ifAbsent: true })).result, { ok: false, error: 'This server already has a key; it was kept', present: true })
   assert.equal(s.voiceStub.requests.length, before)
+  const fresh = await setup(t)
+  assert.deepEqual((await fresh.call('voice.setKey', { apiKey: 'app-voice', ifAbsent: true })).result, { ok: true, voices: [] })
+  assert.deepEqual([fresh.voiceStub.requests.length, (await fresh.call('voice.settings', {})).result.hasKey], [0, true])
   assert.equal((await s.call('voice.clearKey', {})).ok, true)
   assert.equal((await s.call('voice.settings', {})).result.hasKey, false)
   refused(await s.call('voice.voices', {}), 'TOOL_ERROR')
diff --git a/src/host/linearService.ts b/src/host/linearService.ts
index 44192ee..c8594fc 100644
--- a/src/host/linearService.ts
+++ b/src/host/linearService.ts
@@ -19,8 +19,10 @@ export interface KeySlot {
 export interface LinearService {
   hasKey(): boolean
   /**
-   * Checks the key with Linear, then stores it. `ifAbsent`: only while no key is stored (the app's
-   * hand-over), else `{ ok: false, present: true }` and nothing changes.
+   * Checks the key with Linear, then stores it. `ifAbsent` (the app's hand-over): stored as it is,
+   * without asking Linear (the app checked it when the user entered it, and the hand-over must not
+   * depend on Linear being reachable), only while no key is stored; else `{ ok: false, present: true }`
+   * and nothing changes. Its `user` is then empty.
    */
   setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<LinearKeyResult>
   clearKey(): void
@@ -80,13 +82,11 @@ export function createLinearService(options: { key: KeySlot; endpoint?: string;
     hasKey: () => !!options.key.get(),
 
     async setKey(apiKey, { ifAbsent = false } = {}) {
-      if (ifAbsent && options.key.get()) return { ok: false, error: PRESENT_ERROR, present: true }
+      if (ifAbsent) return options.key.setIfAbsent(apiKey) ? { ok: true, user: '' } : { ok: false, error: PRESENT_ERROR, present: true }
       try {
         const { data, errors } = await graphql<{ viewer: { name: string } }>(apiKey, 'query { viewer { name } }')
         if (!data?.viewer) return { ok: false, error: errors?.[0]?.message ?? 'Invalid API key' }
-        if (ifAbsent) {
-          if (!options.key.setIfAbsent(apiKey)) return { ok: false, error: PRESENT_ERROR, present: true }
-        } else options.key.set(apiKey)
+        options.key.set(apiKey)
         return { ok: true, user: String(data.viewer.name) }
       } catch (err) {
         return { ok: false, error: err instanceof Error ? err.message : String(err) }
diff --git a/src/host/voiceService.ts b/src/host/voiceService.ts
index 80321b9..17c871d 100644
--- a/src/host/voiceService.ts
+++ b/src/host/voiceService.ts
@@ -21,7 +21,8 @@ export interface VoiceService {
   settings(): VoiceServerSettings
   /**
    * Checks the key by listing its voices, stores it and picks the first voice if none is chosen.
-   * `ifAbsent`: only while no key is stored (the app's hand-over), else `{ ok: false, present: true }`.
+   * `ifAbsent` (the app's hand-over, which sends its voice next): stored as it is, without asking
+   * ElevenLabs, only while no key is stored; else `{ ok: false, present: true }`. Its `voices` are then empty.
    */
   setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<VoiceKeyResult>
   clearKey(): void
@@ -103,12 +104,10 @@ export function createVoiceService(options: { key: KeySlot; configFile: string;
     settings: () => ({ ...readConfig(), hasKey: !!options.key.get() }),
 
     async setKey(apiKey, { ifAbsent = false } = {}) {
-      if (ifAbsent && options.key.get()) return { ok: false, error: PRESENT_ERROR, present: true }
+      if (ifAbsent) return options.key.setIfAbsent(apiKey) ? { ok: true, voices: [] } : { ok: false, error: PRESENT_ERROR, present: true }
       try {
         const voices = await fetchVoices(apiKey)
-        if (ifAbsent) {
-          if (!options.key.setIfAbsent(apiKey)) return { ok: false, error: PRESENT_ERROR, present: true }
-        } else options.key.set(apiKey)
+        options.key.set(apiKey)
         if (!readConfig().voiceId && voices[0]) setConfig({ voiceId: voices[0].id })
         return { ok: true, voices }
       } catch (err) {
diff --git a/src/main/integrationsHandoverRules.ts b/src/main/integrationsHandoverRules.ts
index b2ba246..e47c25e 100644
--- a/src/main/integrationsHandoverRules.ts
+++ b/src/main/integrationsHandoverRules.ts
@@ -62,8 +62,9 @@ const result = (value: unknown): { ok?: unknown; present?: unknown } => (value &
 /**
  * Hands over what `done` lacks; resolves what is done now. A part is done when there is nothing to
  * hand over, when the server took it (`ok`), or when it already had a key of its own (`present`:
- * the user set one there, which wins). Anything else (Linear or ElevenLabs unreachable, a rejected
- * key, a server older than 5b) leaves it for the next start. The voice settings go only with a key
+ * the user set one there, which wins). Anything else (a server older than 5b, a dropped link, a
+ * secrets file it cannot write) leaves it for the next start. The server stores a hand-over key
+ * without asking Linear or ElevenLabs (`ifAbsent`), so neither needs to be reachable. The voice settings go only with a key
  * the server took: a server with its own key keeps its own voice too. Settings that fail after
  * their key went are pending, and sent on the next start.
  */
diff --git a/src/main/localServerRules.ts b/src/main/localServerRules.ts
index 3a44ded..c44abd8 100644
--- a/src/main/localServerRules.ts
+++ b/src/main/localServerRules.ts
@@ -220,6 +220,8 @@ export function skewOf(bundled: BundledBuild | undefined, running: Pick<LocalInf
  * and `NPM_TOKEN` are kept.
  */
 const DROPPED_PREFIXES = ['ELECTRON_', 'TREK_', 'npm_']
+/** Kept despite their prefix: the server's test endpoints for Linear and ElevenLabs (the smokes' stubs). */
+const KEPT = new Set(['TREK_SERVER_LINEAR_URL', 'TREK_SERVER_ELEVENLABS_URL'])
 const DROPPED = new Set([
   'NODE_OPTIONS',
   'NODE_PATH',
@@ -245,7 +247,7 @@ const DROPPED = new Set([
 export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
   const out: Record<string, string> = {}
   for (const [key, value] of Object.entries(env)) {
-    if (value === undefined || DROPPED.has(key) || DROPPED_PREFIXES.some((p) => key.startsWith(p))) continue
+    if (value === undefined || DROPPED.has(key) || (!KEPT.has(key) && DROPPED_PREFIXES.some((p) => key.startsWith(p)))) continue
     out[key] = value
   }
   out.ELECTRON_RUN_AS_NODE = '1'
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 558843c..7f10dda 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -376,8 +376,9 @@ export interface MethodParamsV2 {
   /** Whether the server has a Linear key */
   'linear.status': Record<string, never>
   /**
-   * Checks the key with Linear and stores it on the server (0600, never sent back). `ifAbsent`: only
-   * while the server has none (the app's hand-over); a stored key is kept and the result says `present`.
+   * Checks the key with Linear and stores it on the server (0600, never sent back). `ifAbsent` (the
+   * app's hand-over): stored as it is, unchecked, only while the server has none; a stored key is
+   * kept and the result says `present`.
    */
   'linear.setKey': { apiKey: string; ifAbsent?: boolean }
   'linear.clearKey': Record<string, never>
````

Run: `node --test scripts/serverIntegrations.test.mjs scripts/localServerRules.test.mjs`
Expected: PASS: `setKey {ifAbsent: true}` stores with no request to the stub; `childEnv` keeps the two URLs and still drops another `TREK_*`.

- [ ] **Step 2: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(5b): a hand-over key is stored unchecked (no Linear or ElevenLabs request); the Local server inherits the test endpoints for them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

- [ ] **Step 3: The smokes** (8de7868)

````diff
diff --git a/package.json b/package.json
index df90762..bd84d39 100644
--- a/package.json
+++ b/package.json
@@ -23,6 +23,7 @@
     "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
     "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
     "smoke:server-env": "npm run build && node scripts/server-env-smoke.mjs",
+    "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index bb17f6d..f8363fa 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -14,7 +14,9 @@
 // it, and through the DOM it checks:
 //   - main's row: Open in VS Code and Reveal call main with the repository's path; the Docker tab
 //     is there, and its compose menu runs `docker compose up -d` in the repository;
-//   - Settings show Linear and Environments; the environments switch is saved on the server
+//   - the hand-over (5b): the app's Linear and ElevenLabs keys and voice settings are the Local
+//     server's (its secrets file and voice.json), asked of neither service; Busy is an app setting;
+//   - Settings show Linear, Voice and Environments; the environments switch is saved on the server
 //     (repo.update), and the environments poll starts (the tool check, colima list);
 //   - the feature row's env badge; its tabs: Changes, Notes, Env, Stack, Settings; its header's
 //     env chip; VS Code with the worktree's path; the Env panel's VM; its variables, saved on blur;
@@ -33,6 +35,7 @@
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { createServer as createHttpServer } from 'node:http'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import electronPath from 'electron'
@@ -178,6 +181,24 @@ legacyUp.once('exit', () => {
 })
 writeFileSync(join(userData, 'stacks', 'app-feature-x.pid'), String(legacyUp.pid))
 writeFileSync(join(userData, 'stacks', 'app-feature-x.log'), '$ stack.sh up\nstarted by the app before 5a\n')
+// 5b: the app's Linear and ElevenLabs keys (main's safeStorage files; `plain:` is how they read where
+// encryption is off, and reads the same where it is on) and its voice settings, handed to the Local
+// server once. A stub of both services, which the Local server inherits through main's env
+// (TREK_SERVER_LINEAR_URL, TREK_SERVER_ELEVENLABS_URL): the hand-over itself asks neither.
+const plain = (value) => `plain:${Buffer.from(value, 'utf8').toString('base64')}`
+writeFileSync(join(userData, 'linear.json'), JSON.stringify({ apiKey: plain('lin_api_from_app') }))
+writeFileSync(join(userData, 'elevenlabs.json'), JSON.stringify({ apiKey: plain('sk_from_app') }))
+const legacyVoice = { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', active: false, promptSessions: true }
+writeFileSync(join(userData, 'voice-settings.json'), JSON.stringify(legacyVoice))
+const serviceRequests = []
+const services = createHttpServer((req, res) => {
+  serviceRequests.push(`${req.method} ${req.url}`)
+  res.writeHead(req.url === '/v1/voices' ? 200 : 404, { 'content-type': 'application/json' })
+  res.end(JSON.stringify(req.url === '/v1/voices' ? { voices: [{ voice_id: 'v9', name: 'Nine' }] } : {}))
+})
+await new Promise((r) => services.listen(0, '127.0.0.1', r))
+const servicesUrl = `http://127.0.0.1:${services.address().port}`
+
 // The Local profile's data dir, where the server keeps them from now on (server/src/dataDir.ts).
 const localData = join(defaultDataDir(process.platform, { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }, home), 'local-dev')
 
@@ -249,6 +270,7 @@ const finish = async (reason) => {
   if (reason) console.error(reason)
   sdk?.close()
   await closeApp(app)
+  services.close()
   // Leave no server behind: stop --local in the run's HOME, then SIGKILL whatever local.json names.
   spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
     env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
@@ -277,7 +299,9 @@ try {
     XDG_DATA_HOME: join(home, '.local', 'share'),
     XDG_STATE_HOME: join(home, '.local', 'state'),
     SHELL: '/bin/zsh',
-    TREK_NO_WINDOW_RESTORE: '1'
+    TREK_NO_WINDOW_RESTORE: '1',
+    TREK_SERVER_LINEAR_URL: `${servicesUrl}/graphql`,
+    TREK_SERVER_ELEVENLABS_URL: `${servicesUrl}/v1`
   }
   delete env.TREK_NO_LOCAL_SERVER
   delete env.TREK_LOCAL_PROFILE
@@ -305,6 +329,15 @@ try {
   const inode = (p) => (existsSync(p) ? statSync(p).ino : null)
   check("and its log, the app's own file", [inode(join(localData, 'stacks', 'app-feature-x.log')) !== null, inode(join(localData, 'stacks', 'app-feature-x.log')) === inode(join(userData, 'stacks', 'app-feature-x.log'))], [true, true])
   check("the app's own files are left as they were", JSON.parse(readFileSync(join(userData, 'environments.json'), 'utf8')), legacyRegistry)
+  // 5b: the hand-over, through main's own connection, before the window asks anything.
+  const handover = join(userData, 'integrations-handover.json')
+  check('main handed the Linear and ElevenLabs settings to this Local profile once', await until(() => (existsSync(handover) ? JSON.parse(readFileSync(handover, 'utf8')) : null), { profiles: { 'local-dev': { linear: true, voice: true } }, voiceActive: true }), { profiles: { 'local-dev': { linear: true, voice: true } }, voiceActive: true })
+  const serverSecrets = join(profile, 'secrets.json')
+  check("the keys are the Local server's now, in its secrets file, owner-only", [existsSync(serverSecrets) ? JSON.parse(readFileSync(serverSecrets, 'utf8')) : null, existsSync(serverSecrets) ? statSync(serverSecrets).mode & 0o777 : null], [{ linear: 'lin_api_from_app', elevenlabs: 'sk_from_app' }, 0o600])
+  check('and the voice and model, with Summarize automatically', existsSync(join(localData, 'voice.json')) ? JSON.parse(readFileSync(join(localData, 'voice.json'), 'utf8')) : null, { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true })
+  check("Busy stays this app's: an app setting now", (await win.evaluate(() => window.api.appSettings.get())).voiceActive, false)
+  check('the hand-over asked neither Linear nor ElevenLabs', serviceRequests, [])
+  check("the app's key files are left as they were", [readFileSync(join(userData, 'linear.json'), 'utf8').includes(plain('lin_api_from_app')), JSON.parse(readFileSync(join(userData, 'voice-settings.json'), 'utf8'))], [true, legacyVoice])
   await sdk.request('server.addRepo', { path: repo })
   const { projectId } = await sdk.request('project.create', { name: 'features', repositories: [{ path: repo }] })
   const topic = `project:${projectId}`
@@ -327,10 +360,11 @@ try {
   }, projectId)
   const rows = win.locator('.server-window .wt-row')
   await until(() => rows.count(), 2)
-  check("the window's features: the machine-local ones and Linear", await until(() => win.evaluate(() => {
+  check("the window's features: the machine-local ones, and the server's Linear, voice and skills", await until(() => win.evaluate(() => {
     const f = window.__features()
     return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear, f.bot, f.voice, f.promote, f.moveWorktree]
-  }), [true, true, true, true, true, true, true, false, false, false, false]), [true, true, true, true, true, true, true, false, false, false, false])
+  }), [true, true, true, true, true, true, true, false, true, false, false]), [true, true, true, true, true, true, true, false, true, false, false])
+  check('its sidebar says Busy (the handed-over key, this app\'s setting)', await until(() => win.locator('.voice-toggle').textContent().catch(() => null), 'Busy'), 'Busy')
   const detail = win.locator('.server-window .detail')
   const mainRow = rows.filter({ hasNotText: 'feature-x' })
   await mainRow.click()
@@ -356,7 +390,8 @@ try {
   const settings = win.locator('.server-window .settings-panel')
   await settings.waitFor({ timeout: 5000 })
   const headings = await settings.locator('h3').allTextContents()
-  check('Settings show Linear and Environments, not Voice or Servers', [headings.includes('Linear'), headings.includes('Environments'), headings.includes('Voice'), headings.includes('Servers')], [true, true, false, false])
+  check('Settings show Linear, Voice summaries and Environments, not Servers', [headings.includes('Linear'), headings.includes('Voice summaries'), headings.includes('Environments'), headings.includes('Servers')], [true, true, true, false])
+  check("its Voice section lists the handed-over key's voices, from the server", await until(() => settings.locator('.settings-row', { hasText: /^Voice/ }).locator('select option').allTextContents().catch(() => []), ['Nine']), ['Nine'])
   await settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input').click()
   check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
   check('the environments poll runs: the tool check passes', await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
diff --git a/scripts/server-env-smoke.mjs b/scripts/server-env-smoke.mjs
index 5d7c707..ee38f25 100644
--- a/scripts/server-env-smoke.mjs
+++ b/scripts/server-env-smoke.mjs
@@ -10,7 +10,8 @@
 // dialogs stubbed through -r; the server is added as an app server, and the window opens a project
 // made through the SDK (a repository with a compose file and a stack.sh, a worktree on feature-x).
 // Through the DOM it checks:
-//   - the window's features: docker, env and stacks on; this machine's (skills, Reveal, VS Code) off;
+//   - the window's features: docker, env and stacks on (and the skills, the server's since 5b); this
+//     machine's (Reveal, VS Code) off;
 //   - the main checkout's Docker tab lists the server's containers, restarts one, and its compose
 //     menu runs `docker compose up -d` in the repository on the server, the output streamed back;
 //     a docker that fails shows in the panel, and the panel recovers;
@@ -272,10 +273,10 @@ try {
   }, [entry.id, projectId])
   const rows = win.locator('.server-window .wt-row')
   await until(() => rows.count(), 2)
-  check("the window's features: the server machine's on, this machine's off", await until(() => win.evaluate(() => {
+  check("the window's features: the server machine's on (the skills too, 5b), this machine's off", await until(() => win.evaluate(() => {
     const f = window.__features()
     return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor]
-  }), [true, true, true, false, false, false]), [true, true, true, false, false, false])
+  }), [true, true, true, true, false, false]), [true, true, true, true, false, false])
 
   // ---- 3. The main checkout: Docker on the server -----------------------------------------------------
 
diff --git a/scripts/server-integrations-smoke.mjs b/scripts/server-integrations-smoke.mjs
new file mode 100644
index 0000000..8b69697
--- /dev/null
+++ b/scripts/server-integrations-smoke.mjs
@@ -0,0 +1,394 @@
+// scripts/server-integrations-smoke.mjs — Linear, voice summaries, skills and the stack MCP tools in a
+// remote server's window (phase 5b): each is the server's, with its own keys and its own disk.
+//
+// Run: npm run smoke:server-integrations   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) runs with its own HOME (its user's ~/.claude) and a stub
+// docker first on its PATH, and with TREK_SERVER_LINEAR_URL and TREK_SERVER_ELEVENLABS_URL pointed at
+// a stub HTTP server in this process: nothing here reaches api.linear.app, api.elevenlabs.io or a real
+// docker. Its agent is a fake one that echoes its arguments. The built app runs with a temp HOME and
+// --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app server,
+// and the window opens a project made through the SDK. Through the DOM and the server's MCP endpoint
+// it checks:
+//   - the window's features: linear, voice and skills on (the server's); Reveal and VS Code off;
+//   - Settings → Linear: a rejected key shows Linear's error; a good one connects, is stored in the
+//     server's secrets file (0600), and the branch's ticket chip shows the issue's title;
+//   - Settings → Voice: the key connects and lists the server key's voices; the chosen voice and
+//     "Summarize automatically" are saved on the server; Test synthesizes there, in that voice, and
+//     plays here;
+//   - speak_summary (MCP): the clip reaches the window (and a subscribed SDK connection), and plays;
+//     while this app is Busy (an app setting) it is not played; a session started afterwards carries
+//     the voice prompt;
+//   - a session's skill menu lists the worktree's skill and the server user's command;
+//   - get_stack, start_stack, read_stack_log and stop_stack (MCP) run the worktree's stack.sh on the
+//     server;
+//   - the renderer never holds the server token or either API key; no console or page errors.
+//
+// Prints SERVER INTEGRATIONS SMOKE PASS (n checks) or SERVER INTEGRATIONS SMOKE FAIL and exits 0 or 1.
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { createServer as createHttpServer } from 'node:http'
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
+const LINEAR_KEY = `lin_api_${randomBytes(8).toString('hex')}`
+const VOICE_KEY = `sk_${randomBytes(8).toString('hex')}`
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-integrations-smoke-')))
+const serverHome = join(work, 'server-home')
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
+
+// The server user's own command, in its ~/.claude.
+mkdirSync(join(serverHome, '.claude', 'commands'), { recursive: true })
+writeFileSync(join(serverHome, '.claude', 'commands', 'server-cmd.md'), '---\ndescription: The server user\'s command\n---\n')
+
+const repo = join(serverHome, 'repos', 'app')
+const worktree = `${repo}-feature-x`
+const stubs = join(work, 'stubs')
+mkdirSync(stubs)
+const stackCalls = join(work, 'stack-calls')
+const upPids = join(work, 'up-pids')
+// docker: `ps -q` lists no containers (the stack service counts them); nothing else is called here.
+writeFileSync(join(stubs, 'docker'), `#!/bin/bash\necho "$*" >> '${join(work, 'docker-calls')}'\nexit 0\n`, { mode: 0o755 })
+
+const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
+git('init', '-q', '-b', 'main', repo)
+mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
+// `up` stays attached while its stack runs, as the real one does (until down's Ctrl-C).
+writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "$*" >> '${stackCalls}'\necho "stack step $1"\nif [ "$1" = up ]; then echo $$ >> '${upPids}'; exec sleep 60; fi\n`, { mode: 0o755 })
+mkdirSync(join(repo, '.claude', 'skills', 'smoke-skill'), { recursive: true })
+writeFileSync(join(repo, '.claude', 'skills', 'smoke-skill', 'SKILL.md'), '---\nname: smoke-skill\ndescription: A skill from the worktree\n---\nSay hi.\n')
+writeFileSync(join(repo, '.gitignore'), '.trek/\n')
+git('-C', repo, 'add', '.')
+git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init')
+
+// The server's agent: it echoes its arguments (the voice prompt among them) and lingers.
+const fakeAgent = join(work, 'fake-agent.sh')
+const agentPids = join(work, 'agent-pids')
+writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT $*"\nexec sleep 300\n`, { mode: 0o755 })
+const configPath = join(work, 'config.json')
+writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))
+
+// The stub of Linear's GraphQL endpoint and ElevenLabs' API, in this process.
+const linearRequests = []
+const voiceRequests = []
+const stubHttp = createHttpServer((req, res) => {
+  let body = ''
+  req.on('data', (c) => (body += c))
+  req.on('end', () => {
+    const json = (status, value) => {
+      res.writeHead(status, { 'content-type': 'application/json' })
+      res.end(JSON.stringify(value))
+    }
+    if (req.url === '/graphql') {
+      const parsed = JSON.parse(body)
+      linearRequests.push({ auth: req.headers.authorization, query: parsed.query, variables: parsed.variables })
+      if (req.headers.authorization !== LINEAR_KEY) return json(401, {})
+      if (parsed.query.includes('viewer')) return json(200, { data: { viewer: { name: 'Ada Lovelace' } } })
+      const out = {}
+      for (const [alias, id] of Object.entries(parsed.variables ?? {})) {
+        out[alias] = id === 'TOW-7' ? { identifier: id, title: 'Ship the integrations', url: `https://linear.app/x/issue/${id}`, state: { name: 'In Progress', type: 'started', color: '#f2c94c' } } : null
+      }
+      return json(200, { data: out })
+    }
+    voiceRequests.push({ method: req.method, url: req.url, key: req.headers['xi-api-key'], body })
+    if (req.headers['xi-api-key'] !== VOICE_KEY) return json(401, {})
+    if (req.method === 'GET' && req.url === '/v1/voices') return json(200, { voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2', name: 'Adam' }] })
+    if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
+      res.writeHead(200, { 'content-type': 'audio/mpeg' })
+      return res.end(Buffer.from('ID3-not-really-an-mp3'))
+    }
+    json(404, {})
+  })
+})
+await new Promise((r) => stubHttp.listen(0, '127.0.0.1', r))
+const stubUrl = `http://127.0.0.1:${stubHttp.address().port}`
+const speechRequests = () => voiceRequests.filter((r) => r.method === 'POST').map((r) => ({ voice: r.url.split('/')[3].split('?')[0], ...JSON.parse(r.body) }))
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
+  stubHttp.close()
+  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
+  for (const pid of pids(upPids)) killIfOurs(pid, (command) => command === 'sleep 60', "a stack's up")
+  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
+  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(exitCode === 0 ? `SERVER INTEGRATIONS SMOKE PASS (${checks.length} checks)` : `SERVER INTEGRATIONS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+try {
+  // ---- 1. The server, on its own machine, and a project on it ------------------------------------
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
+        PATH: `${stubs}:${process.env.PATH}`,
+        TREK_SERVER_LINEAR_URL: `${stubUrl}/graphql`,
+        TREK_SERVER_ELEVENLABS_URL: `${stubUrl}/v1`
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
+  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-integrations-smoke' })
+  const sdkSummaries = []
+  sdk.on('event', (ev) => {
+    if (ev.event === 'voice.summary') sdkSummaries.push(ev.payload.text)
+  })
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  check('the server says linear, voice and skills, and is not a local one', ['linear', 'voice', 'skills', 'local'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, false])
+  const { projectId } = await sdk.request('project.create', { name: 'integrations', repositories: [{ path: repo }] })
+  const topic = `project:${projectId}`
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const repoId = (await project()).repositories[0].id
+  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
+  await sdk.request('branch.setTicket', { projectId, repoId, branch: 'feature-x', ticket: 'TOW-7' })
+  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id
+
+  // ---- 2. The app, with the server saved, and the project's window ---------------------------------
+
+  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
+  delete env.ELECTRON_RUN_AS_NODE
+  delete env.TREK_SERVER_LINEAR_URL
+  delete env.TREK_SERVER_ELEVENLABS_URL
+  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
+  app.on('window', watch)
+  const win = await app.firstWindow()
+  watch(win)
+  await win.waitForLoadState('domcontentloaded')
+  // Every clip this window plays, by its Audio element.
+  await win.evaluate(() => {
+    window.__clips = 0
+    const Original = window.Audio
+    window.Audio = function (src) {
+      window.__clips += 1
+      return new Original(src)
+    }
+  })
+  const clips = () => win.evaluate(() => window.__clips)
+  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
+  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
+  await win.evaluate(async ([id, pid]) => {
+    const { opened } = await window.api.openServerProject(id, pid, 'integrations', 'Remote')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entry.id, projectId])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 2)
+  check("the window's features: the server's Linear, voice and skills; not this machine's", await until(() => win.evaluate(() => {
+    const f = window.__features()
+    return [f.linear, f.voice, f.skills, f.reveal, f.openInEditor]
+  }), [true, true, true, false, false]), [true, true, true, false, false])
+
+  // ---- 3. Settings → Linear, with the server's key ---------------------------------------------------
+
+  const detail = win.locator('.server-window .detail')
+  const featureRow = rows.filter({ hasText: 'feature-x' })
+  await featureRow.click()
+  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
+  await detail.locator('.panel-btn[title="App settings"]').click()
+  const settings = win.locator('.server-window .settings-panel')
+  await settings.waitFor({ timeout: 5000 })
+  check('Settings show Linear and Voice summaries', [await settings.locator('h3', { hasText: /^Linear$/ }).count(), await settings.locator('h3', { hasText: 'Voice summaries' }).count()], [1, 1])
+  const linearRow = settings.locator('.settings-row', { hasText: 'API key' }).filter({ has: win.locator('input[placeholder="lin_api_…"]') })
+  await linearRow.locator('input').fill('lin_api_wrong')
+  await linearRow.locator('button', { hasText: 'Connect' }).click()
+  check("a rejected key shows Linear's answer, from the server", await until(() => linearRow.locator('.settings-warn').textContent().catch(() => null), 'Linear rejected the API key'), 'Linear rejected the API key')
+  await linearRow.locator('input').fill(LINEAR_KEY)
+  await linearRow.locator('button', { hasText: 'Connect' }).click()
+  const linearSection = settings.locator('.settings-row', { hasText: 'Shows each linked issue' })
+  check('a good key connects, as its Linear user', await until(() => linearSection.locator('.settings-desc', { hasText: 'Connected' }).textContent().catch(() => null), 'Connected as Ada Lovelace'), 'Connected as Ada Lovelace')
+  const secrets = join(work, 'secrets.json')
+  check("the key is in the server's secrets file, beside its config, owner-only", [existsSync(secrets) ? JSON.parse(readFileSync(secrets, 'utf8')).linear === LINEAR_KEY : false, existsSync(secrets) ? statSync(secrets).mode & 0o777 : null], [true, 0o600])
+  check("the branch's ticket chip shows the issue, looked up by the server", await until(() => featureRow.locator('.mini-chip.ticket').getAttribute('title').catch(() => null), 'TOW-7 · In Progress — Ship the integrations'), 'TOW-7 · In Progress — Ship the integrations')
+  check('every Linear request carried the key the user typed, from the server', [...new Set(linearRequests.map((r) => r.auth))], ['lin_api_wrong', LINEAR_KEY])
+
+  // ---- 4. Settings → Voice, with the server's key ----------------------------------------------------
+
+  const voiceRow = settings.locator('.settings-row', { hasText: 'ElevenLabs API key' })
+  await voiceRow.locator('input').fill(VOICE_KEY)
+  await voiceRow.locator('button', { hasText: 'Connect' }).click()
+  const voiceSelect = settings.locator('.settings-row', { hasText: /^Voice/ }).locator('select')
+  check("the key connects and lists the server key's voices", await until(() => voiceSelect.locator('option').allTextContents().catch(() => []), ['Rachel', 'Adam']), ['Rachel', 'Adam'])
+  await voiceSelect.selectOption('v2')
+  const voiceConfig = () => (existsSync(join(data, 'voice.json')) ? JSON.parse(readFileSync(join(data, 'voice.json'), 'utf8')) : null)
+  check('the chosen voice is saved on the server', await until(() => voiceConfig()?.voiceId ?? null, 'v2'), 'v2')
+  await settings.locator('label.settings-row', { hasText: 'Summarize automatically' }).locator('input').click()
+  check('and "Summarize automatically"', await until(() => voiceConfig()?.promptSessions ?? null, true), true)
+  check('the secrets file holds both keys', existsSync(secrets) ? Object.keys(JSON.parse(readFileSync(secrets, 'utf8'))).sort() : [], ['elevenlabs', 'linear'])
+  await settings.locator('.settings-row', { hasText: /^Voice/ }).locator('button', { hasText: 'Test' }).click()
+  check('Test synthesizes on the server, in the chosen voice, and plays here', [await until(() => speechRequests().length, 1), speechRequests()[0]?.voice, await until(() => clips(), 1)], [1, 'v2', 1])
+  await detail.locator('.panel-btn[title="App settings"]').click()
+
+  // ---- 5. speak_summary, from a session, to every window that has the project open --------------------
+
+  const started = await sdk.request('session.start', { projectId, worktreeId: featureId, cols: 120, rows: 30 })
+  const mcpFile = join(data, 'mcp', `${projectId}.json`)
+  const mcp = await until(() => existsSync(mcpFile), true) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const tool = async (name, args) => {
+    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }) })
+    const body = await res.json()
+    const text = body.result?.content?.[0]?.text ?? ''
+    try {
+      return { isError: body.result?.isError === true, value: JSON.parse(text) }
+    } catch {
+      return { isError: body.result?.isError === true, value: text }
+    }
+  }
+  await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) })
+  // The SDK connection listens too, on the project's topic.
+  await sdk.request('sub.subscribe', { topic })
+  const spoken = await tool('speak_summary', { terminalId: started.sessionId, summary: 'The integrations are on the server.' })
+  check('speak_summary reaches both connections on the project', spoken.value, { played: true, windows: 2 })
+  check('and the window plays it; the SDK connection got it too', [await until(() => clips(), 2), sdkSummaries], [2, ['The integrations are on the server.']])
+  check('in the voice the server has', speechRequests().at(-1), { voice: 'v2', text: 'The integrations are on the server.', model_id: 'eleven_flash_v2_5' })
+  // Busy (this app's setting): the clip still comes, and is not played.
+  await win.locator('.voice-toggle').click()
+  check('the sidebar toggle goes Busy, an app setting', await until(() => win.evaluate(async () => (await window.api.appSettings.get()).voiceActive), false), false)
+  check('a summary while Busy is sent but not played', [(await tool('speak_summary', { terminalId: started.sessionId, summary: 'Nobody hears this.' })).value.played, await sleep(1000).then(clips)], [true, 2])
+  await win.locator('.voice-toggle').click()
+  await sdk.request('sub.unsubscribe', { topic })
+  const tooLong = await tool('speak_summary', { terminalId: started.sessionId, summary: 'x'.repeat(401) })
+  check('a summary over 400 characters is refused', [tooLong.isError, String(tooLong.value).includes('401 characters')], [true, true])
+  // A session started now carries the voice prompt (Summarize automatically is on).
+  const read = async (terminalId) => (await tool('read_terminal', { terminalId, lines: 50 })).value.output ?? ''
+  // Compared without whitespace: the screen wraps the long line.
+  check('the session started after carries the voice prompt', await until(async () => (await read(started.sessionId)).replace(/\s+/g, '').includes('callthetrek-devspeak_summarytool'), true), true)
+
+  // ---- 6. A session's skill menu: the worktree's skill and the server user's command -----------------
+
+  const tab = detail.locator('.session-tab').first()
+  await tab.waitFor({ timeout: 10_000 })
+  await tab.locator('.skill-menu-trigger').click()
+  const menu = win.locator('.skill-menu')
+  await menu.locator('.skill-menu-item', { hasText: 'smoke-skill' }).waitFor({ timeout: 5000 })
+  check("the skill menu lists the worktree's skill and the server user's command", await menu.locator('.skill-menu-name').allTextContents(), ['/smoke-skill', '/server-cmd'])
+  await win.keyboard.press('Escape')
+
+  // ---- 7. The stack tools, on the server ------------------------------------------------------------
+
+  const got = await tool('get_stack', { worktree: 'feature-x' })
+  check('get_stack: the worktree has a stack, stopped', [got.isError, got.value.available, got.value.name, got.value.state], [false, true, 'trek-app-feature-x', 'stopped'])
+  check('start_stack starts stack.sh up on the server', [(await tool('start_stack', { worktree: 'feature-x' })).value.state, await until(() => (existsSync(stackCalls) ? readFileSync(stackCalls, 'utf8').trim() : ''), 'up')], ['starting', 'up'])
+  check('read_stack_log reads its output', await until(async () => (await tool('read_stack_log', { worktree: 'feature-x' })).value.output?.includes('stack step up') ?? false, true), true)
+  check('stop_stack Ctrl-Cs it and runs stack.sh down', [(await tool('stop_stack', { worktree: 'feature-x' })).value.state, readFileSync(stackCalls, 'utf8').trim().split('\n')], ['stopped', ['up', 'down']])
+
+  const html = await win.evaluate(() => JSON.stringify(window.__store.getState()) + document.documentElement.outerHTML)
+  check('the renderer never holds the server token or either API key', [token, LINEAR_KEY, VOICE_KEY].map((s) => html.includes(s)), [false, false, false])
+  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
+  check('no console or page errors', pageErrors, [])
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 6e92160..048c3c0 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -794,18 +794,19 @@ try {
 
   // A server that is not the Local entry's (this one's paths happen to be on this disk, but the
   // window cannot know that): none of this machine's controls (4c). Its header has no Open in VS
-  // Code or Reveal, its sessions no skill menu. Docker, the environments and the stacks are the
-  // server's (5a), on: this worktree shows no Env or Stack tab only because its repository has
-  // environments off and no stack.sh, and Docker is the main checkout's tab (smoke:server-env).
-  check("a remote server window has none of this machine's controls", await detail.evaluate((el) => ({
+  // Code or Reveal. Docker, the environments and the stacks are the server's (5a), on: this
+  // worktree shows no Env or Stack tab only because its repository has environments off and no
+  // stack.sh, and Docker is the main checkout's tab (smoke:server-env). Linear, voice and the
+  // skills are the server's too (5b): its sessions have the skill menu (smoke:server-integrations).
+  check("a remote server window has none of this machine's controls, and the server's skill menu", await detail.evaluate((el) => ({
     actions: [...el.querySelectorAll('.detail-actions button')].map((b) => b.textContent.trim()).filter((t) => /VS Code|Reveal/.test(t)),
     tabs: [...el.querySelectorAll('.session-row .panel-btn')].map((b) => b.textContent.trim()).filter((t) => /^(Docker|Env|Stack)/.test(t)),
     skills: el.querySelectorAll('.skill-menu-trigger').length
-  })), { actions: [], tabs: [], skills: 0 })
-  check("and its features say so; the server machine's docker, env and stacks, and Linear, are on", await w1.evaluate(() => {
+  })), { actions: [], tabs: [], skills: 1 })
+  check("and its features say so; the server's docker, env, stacks, skills, Linear and voice are on", await w1.evaluate(() => {
     const f = window.__features()
-    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear]
-  }), [true, true, true, false, false, false, true])
+    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear, f.voice]
+  }), [true, true, true, true, false, false, true, true])
 
   // A rename sends the title it started from, so one made elsewhere meanwhile is not overwritten.
   const oldTitle = await w1.evaluate((id) => window.__store.getState().terminals[id].title, s1)
@@ -906,6 +907,7 @@ try {
     'Notifications',
     'Local server',
     'Linear',
+    'Voice summaries',
     'Agents',
     'Worktree tags',
     'Custom tags',
@@ -921,11 +923,11 @@ try {
   // default, saved by main (app-settings.json), and back on for the checks after this one.
   const notifySwitch = settings.locator('input[aria-label="Show notifications"]')
   const appSettingsNow = () => w1.evaluate(() => window.api.appSettings.get())
-  check('Show notifications is on by default', [await notifySwitch.isChecked(), await appSettingsNow()], [true, { showNotifications: true, stopLocalServerOnQuit: false }])
+  check('Show notifications is on by default', [await notifySwitch.isChecked(), await appSettingsNow()], [true, { showNotifications: true, stopLocalServerOnQuit: false, voiceActive: true }])
   await notifySwitch.click()
-  check('turned off, main keeps it off', await until(appSettingsNow, { showNotifications: false, stopLocalServerOnQuit: false }), { showNotifications: false, stopLocalServerOnQuit: false })
+  check('turned off, main keeps it off', await until(appSettingsNow, { showNotifications: false, stopLocalServerOnQuit: false, voiceActive: true }), { showNotifications: false, stopLocalServerOnQuit: false, voiceActive: true })
   await notifySwitch.click()
-  check('and on again', await until(appSettingsNow, { showNotifications: true, stopLocalServerOnQuit: false }), { showNotifications: true, stopLocalServerOnQuit: false })
+  check('and on again', await until(appSettingsNow, { showNotifications: true, stopLocalServerOnQuit: false, voiceActive: true }), { showNotifications: true, stopLocalServerOnQuit: false, voiceActive: true })
   const prompt = settings.locator('.session-prompt-input')
   const settingsNow = async () => (await projectNow()).settings
   let sentAt = await sentCount()
````

- [ ] **Step 4: Run them, one at a time**

Run each, waiting for it to finish: `npm run smoke:server-integrations`, `npm run smoke:local-features`, `npm run smoke:v2`, `npm run smoke:server-env`.
Expected: `SERVER INTEGRATIONS SMOKE PASS (29 checks)`, `LOCAL FEATURES SMOKE PASS (50 checks)`, `V2 SMOKE PASS (171 checks)`, the server-env smoke's 30. Then `pgrep -fl "trek-server|Electron.*user-data-dir"` shows nothing of these runs.

- [ ] **Step 5: Commit**

```bash
git add scripts/server-integrations-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(5b): smoke:server-integrations (Linear, voice, skills and the stack tools in a remote window, against stub services); smoke:local-features checks the hand-over; smoke:v2 and smoke:server-env follow the gate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -a
```

---

### Task 7: Docs

**Files:** `PROTOCOL.md`, `README.md`, `server/README.md`, `docs/superpowers/specs/2026-11-04-central-server-design.md`

- [ ] **Step 1: Apply the diff** (d4b831c)

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 82517dd..05f2ff4 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -99,6 +99,9 @@ new optional field needs no capability: its absence says enough.
 | `docker` | `docker.list`, `docker.container` and `docker.compose` run docker on the server's machine, and `docker.log` streams compose's output (see [Docker, environments and stacks](#docker-environments-and-stacks)) |
 | `env` | `env.*` run the worktrees' Colima environments on the server's machine, and `env.log` streams their output |
 | `stacks` | `stack.*` run the worktrees' `docker/stack/stack.sh` dev stacks on the server's machine |
+| `linear` | `linear.*` look Linear issues up with the server's own API key (see [Linear, voice and skills](#linear-voice-and-skills)) |
+| `voice` | `voice.*` keep the server's ElevenLabs key and voice; the MCP tool `speak_summary` sends each spoken summary to the project's subscribers as `voice.summary` |
+| `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -176,6 +179,9 @@ server restarts. A server without this field simply leaves it out.
 | Docker | `docker.list`, `docker.container`, `docker.compose` |
 | Environments | `env.check`, `env.list`, `env.up`, `env.stop`, `env.destroy`, `env.ps`, `env.composeFiles`, `env.logs` |
 | Stacks | `stack.status`, `stack.up`, `stack.down`, `stack.destroy`, `stack.log` |
+| Linear | `linear.status`, `linear.setKey`, `linear.clearKey`, `linear.issues` |
+| Voice | `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`, `voice.setConfig`, `voice.synthesize` |
+| Skills | `skills.list` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
 | Misc | `sys.ping` |
 
@@ -428,6 +434,51 @@ log. Under backpressure (from more than 4 MiB unsent on the connection until it
 2 MiB) their output chunks are dropped, and the next chunk of that run that is sent follows one
 `[output dropped: the connection fell behind]` line. A `done` or a `step` event is never dropped.
 
+## Linear, voice and skills
+
+With the capabilities `linear`, `voice` and `skills` (phase 5b), the server looks Linear issues up
+and synthesizes spoken summaries with its own API keys, and lists the skills on its own disk.
+Before 5b the desktop app kept one Linear and one ElevenLabs key for every window; now each server
+has its own, set from any client.
+
+**The keys are write-only.** `linear.setKey` and `voice.setKey` store a key in the server's
+`secrets.json`, beside its config file (owner-only, 0600, written then renamed; a file that cannot
+be read or parse is never overwritten), and no method sends a key back: `linear.status` and
+`voice.settings` say only whether one is set. A key is checked first (Linear's `viewer`, the
+ElevenLabs key's voices); the result is `{ok: false, error}` with the service's answer when it is
+refused. `ifAbsent: true` is the desktop's one-time hand-over of its own keys to the local server:
+the key is stored as it is, unchecked (the app checked it when the user entered it), and only while
+the server has none; otherwise the result is `{ok: false, error, present: true}` and the server's
+own key is kept. A key is 1 to 1024 printable ASCII characters with no spaces.
+
+| Method | Params | Result |
+|---|---|---|
+| `linear.status` | `{}` | `{hasKey}` |
+| `linear.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, user}` (the key's Linear user; empty for `ifAbsent`) or `{ok: false, error, present?}` |
+| `linear.clearKey` | `{}` | `null` |
+| `linear.issues` | `{ids}` (at most 500 strings of at most 64 characters) | the `LinearIssue`s that exist and the key can see; ids that are not `ABC-123` are left out; `[]` without a key |
+| `voice.settings` | `{}` | `{hasKey, voiceId, modelId, promptSessions}` |
+| `voice.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, voices}` (the first one is chosen when no voice is; empty for `ifAbsent`) or `{ok: false, error, present?}` |
+| `voice.clearKey` | `{}` | `null` |
+| `voice.voices` | `{}` | the key's voices, `[{id, name}]` |
+| `voice.setConfig` | any of `{voiceId, modelId, promptSessions}` | the whole config |
+| `voice.synthesize` | `{text}` (trimmed, 1 to 400 characters) | `{audio}`: an mp3, base64, for this connection only (a client's Test) |
+| `skills.list` | `{projectId, worktreeId}` | `SkillInfo[]`: the worktree's `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`, then the server user's `~/.claude` ones; a project one shadows a user one of the same name |
+
+A failure of Linear or ElevenLabs (unreachable, a revoked key, a quota) is `TOOL_ERROR` with the
+service's message. The voice config (`<dataDir>/voice.json`) holds no secret. `promptSessions`
+("Summarize automatically") adds a prompt to every session the server starts that has the MCP tools,
+while it has a key, telling the agent to call `speak_summary` when it finishes or waits on the
+user. `skills.list` takes the worktree's path from the server's state and checks it as the worktree
+commands do (registered repository, not missing, inside the allowlist).
+
+**Spoken summaries.** The MCP tool `speak_summary` (see [MCP](#mcp-trek-dev-on-the-server))
+synthesizes the summary with the server's key and sends it as a `voice.summary` event to every
+connection subscribed to the session's project topic, and answers how many it went to. A
+connection with more than 4 MiB unsent is skipped (the clip would play late). Whether a client
+plays it is the client's: the desktop plays it unless its user set the app to Busy, an app-wide
+setting of that desktop, not the server's.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
@@ -796,8 +847,15 @@ or `null`.
 | `list_session_types` | none | an array of `{id, name, systemPrompt, initialMessage?, llm?}` (no icon) |
 | `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
 | `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |
-
-That is 22 tools. Tags are matched by name or id, case-insensitively, and an
+| `speak_summary` | `terminalId`, `summary` (one to three short sentences, trimmed, at most 400 characters) | `{played: true, windows}` (the connections it went to, see [Linear, voice and skills](#linear-voice-and-skills)), or `{played: false, reason}` when the server has no ElevenLabs key or no connection has the project open (nothing is synthesized then) |
+| `get_stack` | `worktree` | `{available: false}`, or `{available: true, name, state, containers, ports, urls, logins}`; `state` is `starting`, `running`, `stopping` or `stopped` |
+| `start_stack` | `worktree`; `starter?` (boolean) | the stack as `get_stack` describes it, once `stack.sh up` is started; `BAD_REQUEST` when it is not stopped |
+| `stop_stack` | `worktree` | the stack once `stack.sh down` exited 0; else `BAD_REQUEST` naming the code |
+| `read_stack_log` | `worktree`; `lines?` (default 100, 1 to 2000) | `{output}`: the last lines of the stack's log, colour codes removed |
+
+That is 27 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
+`stack.log` (their path checks), on the server's machine; a worktree without
+`docker/stack/stack.sh` has no stack (`get_stack` says so, the others are `BAD_REQUEST`). Tags are matched by name or id, case-insensitively, and an
 unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
 Linear workspace or Azure DevOps base URL from a URL and saves it to the project's
 settings. A worktree with a detached HEAD has no branch data, so the `set_worktree_*`
@@ -811,8 +869,6 @@ listed, and calling one is `-32602`.
 
 - Client UI only: `get_selected_worktree` and `focus_session` (selection lives in
   clients), and `promote_to_primary` (it needs a confirmation dialog).
-- Phase 5: `speak_summary` (voice) and `get_stack`, `start_stack`, `stop_stack`,
-  `read_stack_log` (Docker).
 
 **Readiness and waiting.**
 
@@ -860,6 +916,7 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 | `daemon.shutdown` | `{reason}`, best-effort before a graceful stop |
 | `docker.log` | `{data, done?}`: a `docker.compose` run's output, only to the connection that asked for it (chunks may be dropped under backpressure, see [Docker, environments and stacks](#docker-environments-and-stacks)); `done` on its last |
 | `env.log` | `{profile, data, done?, step?}`: an `env.up`, `env.stop` or `env.destroy`'s output, only to the connection that asked for it; `step` (`vm`, `compose`, `ready`) marks an `env.up` phase, `done` its last |
+| `voice.summary` | `{projectId, sessionId, text, audio}`: a session's spoken summary (`speak_summary`), an mp3 in base64, to every connection subscribed to the project's topic (not one more than 4 MiB behind) |
 
 ## Several clients
 
diff --git a/README.md b/README.md
index 5ccb26f..829c82d 100644
--- a/README.md
+++ b/README.md
@@ -40,8 +40,9 @@ sends every action to its server, and every other window on that project sees it
   (link ticket/PR, delete worktree). A ticket is a Linear issue (`TOW-123`, or paste its
   `linear.app/<workspace>/issue/…` URL) or a legacy Azure DevOps work item id; when the
   branch name contains a Linear id the ticket dialog pre-fills it. Add a Linear API key
-  in ⚙ Settings to show each issue's status and title on its chip; the key is stored
-  encrypted in the app's user-data directory, never on a server. The **All Notes** panel
+  in ⚙ Settings to show each issue's status and title on its chip; the key is the
+  window's server's (stored there, owner-only, never sent back to any client), shared by
+  every project on that server. The **All Notes** panel
   collects every branch note in one place — including branches whose worktree is gone —
   with a per-note delete.
 - **Sessions** (per worktree): each session tab is an agent the server runs in the
@@ -165,7 +166,7 @@ other window on that project sees them live.
   setting first, you pick **Reload** or **Keep Mine**; a Docker favourite or an
   environment setting is re-applied over the other client's change without
   asking. Attention badges and the notifications menu cover server sessions.
-  Linear ticket chips work in every server window, with the app-wide API key.
+  Linear ticket chips work in every server window, with that server's API key.
 - **Docker, environments and dev stacks, on the server's machine**: every server
   window has the Docker tab (the server's containers, and docker compose in a
   repository's main checkout), the per-worktree Colima environments (and their
@@ -177,12 +178,22 @@ other window on that project sees them live.
   A server older than this Trek (without the `docker`, `env` and `stacks`
   capabilities) shows no Docker, Env or Stack tab, and Trek does not fall back
   to running them on this machine.
+- **Linear, voice summaries and skills, on the server**: each server keeps its own
+  Linear and ElevenLabs keys (⚙ Settings, set from any window on it; neither is ever
+  sent back to a client), its voice and model, and whether its sessions are told to
+  speak a summary when they finish ("Summarize automatically"). A session's
+  `speak_summary` is synthesized on the server and played in every Trek window that
+  has its project open, unless that app is set to Busy (the sidebar's Active/Busy
+  toggle, a setting of this app). The ⚡ skill menu lists the worktree's
+  `.claude/skills` and `.claude/commands`, and the server user's `~/.claude` ones, read
+  on the server. Its agents also get the `get_stack`, `start_stack`, `stop_stack` and
+  `read_stack_log` MCP tools. A server older than this Trek (without the `linear`,
+  `voice` and `skills` capabilities) shows none of these.
 - **This machine's features, in Local windows only**: a window on the [Local
-  server](#local-server) also has skills, Open in VS Code and Reveal in Finder,
-  since its paths are this machine's. A window on a remote server shows none of
-  these.
-- **Not yet**: promote to primary, moving worktrees between servers, voice
-  summaries, skills on the server, the project bot and the stack MCP tools (phase 5).
+  server](#local-server) also has Open in VS Code and Reveal in Finder, since its
+  paths are this machine's. A window on a remote server shows neither.
+- **Not yet**: promote to primary, moving worktrees between servers and the project
+  bot (phase 5).
 
 ## Importing a .trekproj
 
@@ -277,6 +288,15 @@ screen, or File → New Project…, ⌘N) on Local picks a folder on this machin
   created is not offered for deletion in Settings; a VM another trek-server on
   this machine created is (Settings says it may be another Trek's, and Delete
   removes its containers and volumes).
+- **Your Linear and ElevenLabs keys carry over.** Before this version Trek kept one
+  Linear key and one ElevenLabs key (and the voice, the model and "Summarize
+  automatically") for every window. Each server has its own now: once the Local
+  server runs, Trek hands it this app's keys and voice settings, once per Local
+  profile, and only where the server has no key of its own (one set there wins).
+  The keys are stored as they are, without asking Linear or ElevenLabs, so it works
+  offline; a hand-over that fails (an older Local server) is tried again at its next
+  start. Trek's own files are left as they were. A remote server needs its keys set
+  once from any window on it. Active/Busy stays this app's setting.
 
 ## Attention indicators
 
@@ -345,10 +365,13 @@ one at a time:
 - `npm run smoke:local-window`: a Local window across two repositories: its sidebar,
   sessions, tags, notes, settings, Changes, unload and repository removal;
 - `npm run smoke:local-features`: a Local window's Docker, environments, stacks,
-  skills, VS Code and Reveal against stub `colima`, `docker` and `code`, and the
-  Local server's take-over of the environments an older Trek ran itself;
+  skills, VS Code and Reveal against stub `colima`, `docker` and `code`, the Local
+  server's take-over of the environments an older Trek ran itself, and the hand-over
+  of its Linear and ElevenLabs keys;
 - `npm run smoke:server-env`: a remote server window's Docker, environments and
   stacks, run on the server's machine against stub `colima`, `docker` and `stack.sh`;
+- `npm run smoke:server-integrations`: a remote server window's Linear, voice
+  summaries, skills and the stack MCP tools, against stub Linear and ElevenLabs APIs;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 744a3a2..93acabe 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -233,7 +233,8 @@ Electron, on Linux, macOS and Windows.
   session/git `ipcMain` handlers; in phase 5, `bot.ts`, `docker.ts`, `environments.ts`,
   `stacks.ts`, `linear.ts`, `voice.ts` and `skills.ts`, once each has a server replacement.
   Until then those keep running in main against the local machine, for Local windows.
-  `docker.ts`, `environments.ts` and `stacks.ts` went in 5a, with `git:localDirty`.
+  `docker.ts`, `environments.ts` and `stacks.ts` went in 5a, with `git:localDirty`;
+  `linear.ts`, `voice.ts` and `skills.ts` in 5b.
 - **Windows:** one window per project. The registry entry is
   `{kind: 'file', path}` (legacy, until phase 4) or `{kind: 'server', serverId, projectId}`.
   Opening an already-open entry focuses its window. `open-windows.json` and recents store
@@ -423,7 +424,14 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
      `stacks` capabilities, in every server window. Plans:
      `docs/superpowers/plans/2026-11-09-central-server-phase5a1-cleanup.md` and
      `…-phase5a2-machine.md`.
-   - **5b:** Linear, voice (moved to the server) and skills.
+   - **5b:** Linear, voice (moved to the server) and skills, behind the `linear`, `voice` and
+     `skills` capabilities, in every server window. User decisions (2026-11-09): the Linear and
+     ElevenLabs keys are each server's (`secrets.json` beside its config, write-only over the
+     protocol); a spoken summary (`speak_summary`, synthesized on the server) plays in every
+     window that has the project open and whose app is Active (Active/Busy stays the app's);
+     main hands the app's keys and voice settings to the Local server once, set-if-absent. The
+     trek-dev stack tools (`get_stack`, `start_stack`, `stop_stack`, `read_stack_log`) return on
+     the server's stack service.
    - **5c:** the cheapest gaps from a comparison with T3 Code (2026-11-09), each in its
      own plan:
      - **PR watch:** the server polls a worktree's linked pull request (`gh`, on the
diff --git a/server/README.md b/server/README.md
index 4da2d0c..622efc8 100644
--- a/server/README.md
+++ b/server/README.md
@@ -20,6 +20,8 @@ keeps running on the server; the app reattaches when it reconnects.
   compose), `colima` and `bash` on the server's PATH. Without them the server runs
   fine: those calls answer `TOOL_ERROR` (reason `missing`), or, for a compose or
   Colima run, end with code -1 and say why in their output, which the app shows.
+- Optional, for Linear ticket chips and voice summaries: outbound HTTPS to
+  `api.linear.app` and `api.elevenlabs.io`, and the keys, set from the app's Settings.
 
 ## Install
 
@@ -144,7 +146,26 @@ memory, so each start of the server makes new ones. The config files agents
 launch with are written to `<dataDir>/mcp` (mode 0600, in a 0700 directory) and
 removed when their project is deleted or the server next starts. If that
 directory cannot be used, the server logs a warning and runs without MCP.
-See `../PROTOCOL.md` for the tools.
+Besides those, sessions get `speak_summary` (read aloud through the server's
+ElevenLabs key, in every Trek window that has the project open) and `get_stack`,
+`start_stack`, `stop_stack` and `read_stack_log` (the worktree's dev stack, run on
+this machine). See `../PROTOCOL.md` for the tools.
+
+## Linear and voice keys
+
+The app's Linear and ElevenLabs settings are each server's own: a key set from any
+client is stored in `secrets.json` beside the config file (`~/.config/trek-server/`,
+or the Local profile's directory; mode 0600, written then renamed) and is never sent
+back to a client, which only learns whether one is set. The voice, the model and
+"Summarize automatically" are in the data dir's `voice.json` (no secret). With
+"Summarize automatically" on and a key set, every session the server starts with
+the MCP tools is told to call `speak_summary` when it finishes or waits on the user.
+A `secrets.json` that cannot be read or parse is never overwritten: setting a key
+fails until it is fixed. The app's own keys are handed to its Local server once.
+
+`TREK_SERVER_LINEAR_URL` and `TREK_SERVER_ELEVENLABS_URL` point the server at other
+endpoints (Linear's GraphQL URL; ElevenLabs' `/v1` base). They are for tests, which
+run stub services; leave them unset.
 
 ## Projects
 
@@ -306,6 +327,9 @@ Then configure the app with `wss://dev.example.com`.
   `DYLD_*` name, in any case. A repository's own `docker/stack/stack.sh` and
   compose content (`include`, `env_file`, bind mounts, …) run as written, as a
   session would run them.
+- **The Linear and ElevenLabs keys are the server's**, usable by any client with a
+  token (looking issues up, synthesizing speech), never readable by one. A shared
+  server's keys are shared by everyone who can connect to it.
 - Auth failures are logged with the peer address; bad tokens get a delayed
   close to blunt brute force.
 - Never expose the plain `ws://` listener beyond loopback (`--insecure`
````

- [ ] **Step 2: Check the docs against the code**: every method in `PROTOCOL.md`'s new sections is in `V2Params`; the capability list matches `server/src/capabilities.ts`; the tool count in the docs matches `MCP_TOOLS.length`.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(5b): PROTOCOL.md's linear, voice and skills methods, capabilities, voice.summary and the five MCP tools; the README's server-side Linear, voice and skills and the key hand-over; the server README's secrets.json and voice.json; the spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- PROTOCOL.md README.md server/README.md docs/superpowers/specs/2026-11-04-central-server-design.md
```

---

### Task 8: Final verification (5b)

- [ ] **Step 1:** `npm run typecheck`, `npm test` (the prototype: 1675 tests, 1674 pass, 1 skipped), `npm run build`.
- [ ] **Step 2:** Every smoke, one at a time: v2 (171), local-app (45), local-window (57), local-features (50), server-env (30), server-integrations (29), providers (36), windows (38), import (63), local-server (85), client-contract, the server smoke.
- [ ] **Step 3:** A clean checkout (`git clone` into the scratchpad, `npm ci`, typecheck, test) passes.
- [ ] **Step 4:** No processes left; `git status` clean.
- [ ] **Step 5:** The final whole-branch review (most capable model), its fixes, then the counts again.

---

## Notes for 5c and later

1. **The web client (5c)** gets Linear, voice and skills from the server with no main: only the hand-over is Electron's.
2. **The old userData files** (`linear.json`, `elevenlabs.json`, `voice-settings.json`) and `integrations-handover.json` go when the importer is retired, with 5a-2's Note 4.
3. **The bot** would need `speak_summary` and `start_stack` in its always-ask policy (`src/host/bot/policy.ts` lists the stack tools already).

## Risks

1. **Two servers sharing one `--config` directory share keys** (Decision 5): the Local profiles never do; a hand-run server pointed at another's config would.
2. **Every token holder can use a server's keys** (look up issues, spend ElevenLabs characters through `voice.synthesize` and `speak_summary`), never read them. That is the token's existing power (a shell, which could read `secrets.json`).
3. **Remote servers need their keys entered once**; before 5b every window used the app's. Their Settings say so.
4. **After the hand-over, Linear Settings says "Connected" without the user's name** (Decision 18) until the key is entered again; a handed-over key that has since been revoked shows as connected until a lookup fails.
5. **`windows` counts deliveries, not plays** (Decision 13): a Busy window counts.
6. ~~**`subscriberCount` counts MCP's no-op subscribers too**~~ Fixed in the Tasks 1–4 review: `speak_summary` checks `eventSubscriberCount` (only subscribers that take events), so an MCP tool call watching alone synthesizes nothing.
7. **No smoke plays real audio**: the check counts `Audio` elements made from the clip.

## Questions for the user

None block this plan.

1. **The hand-over stores the key unchecked** (Decision 18). Alternative: check it at the hand-over, which needs the network at that start and a stub in the smokes.
2. **A server-wide switch** to turn Linear, voice and skills off (a config flag dropping the capabilities), as asked for Docker in 5a (answered "not now" there).
3. **`speak_summary`'s `windows`** counts deliveries (Risk 5). Alternative: clients report whether they played it, which needs a reply path.
