# Central server phase 2e: the trek-dev MCP server on trek-server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent session that `trek-server` runs gets the `trek-dev` MCP tools, served by the server itself and scoped to the session's own project. The tools cover worktrees, sessions, prompts, terminal reads and waiting, branch data, and session types. Global sessions get their tools and role prompt back.

**Architecture:**
- **Pure JSON-RPC handling** in `server/src/mcp/protocol.ts`, ported from the desktop's hand-written MCP server in `src/main/mcp.ts` (no SDK).
- **A loopback HTTP listener** (`server/src/mcp/listener.ts`) on `127.0.0.1` and a random port, with one bearer token per project. Agents run on the server's machine, so the endpoint is never exposed.
- **Per-project access and config files** (`server/src/mcp/access.ts`) in the server's data directory, mode 0600.
- **Tools** (`server/src/mcp/tools.ts`) run against the server's own state. Wherever a v2 command already exists they call it in-process, through `dispatchV2`, so validation and behaviour stay in one place.
- **`SessionManager`** passes each project's MCP access to `agentCommand`.

**Tech Stack:** Node ≥ 22.18, TypeScript, `node:http`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section 2 (`mcp/`) and section 3 ("MCP is per server"). Desktop reference: `src/main/mcp.ts` (protocol and tool definitions) and `src/renderer/src/mcpTools.ts` (tool behaviour). Carry-overs: memory note "Phase 2e carry-overs" (decisions 10–12 below).

---

## Decisions made in this plan

Task 11 records these in `PROTOCOL.md`.

1. **Scope: a session's tools see only its own project** (the user's choice). A token belongs to one project. Every tool resolves worktrees and sessions inside that project only; ids from another project are `NOT_FOUND`.
2. **The endpoint.**
   - It is a second HTTP server inside `trek-server`, on `127.0.0.1` and an OS-chosen port, so it is not on the clients' WebSocket port.
   - `POST /mcp` only. Any other path is 404. A non-POST is 405 with `Allow: POST`. A missing or wrong `Authorization: Bearer` header is 401.
   - Bodies are limited to 1 MiB (413 above that).
   - JSON-RPC behaves as on the desktop:
     - methods `initialize`, `ping`, `tools/list` and `tools/call`;
     - a message without an `id` is a notification; a request made only of notifications gets 202 with no body;
     - batching is supported;
     - protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted (the default is `2025-06-18`);
     - responses are plain JSON, with no SSE and no `Mcp-Session-Id`.
3. **Tokens and config files.**
   - Each project gets a token (`randomBytes(32)` hex) the first time one of its sessions launches.
   - Tokens are kept in memory and new ones are generated on every server start; the server also listens on a new port each start.
   - The Claude `--mcp-config` file is `<dataDir>/mcp/<projectId>.json` and the Gemini settings file is `<dataDir>/mcp/<projectId>-gemini.json`. Both are written with mode 0600 in a 0700 directory.
   - The files are rewritten whenever the token or port changes.
   - On start the server deletes the whole `mcp/` directory's files. `project.delete` revokes the token and deletes that project's files.
   - Codex gets the URL and the token through `TREK_MCP_TOKEN`, as the provider adapter already does.
4. **Every session gets MCP**, worktree and Global alike. On the desktop only local worktree sessions got it, because MCP listened on the desktop's own loopback; every server session is local to the server. Global sessions also get the role prompt again (`agentCommand` adds it when `mcp` is set).
5. **Tools in 2e.** These match the desktop's names, parameters and result shapes wherever the server has the data:
   - **Worktrees:** `list_worktrees`, `create_worktree` (no `server` param), `load_worktree`, `unload_worktree`.
   - **Sessions:** `get_current_session`, `start_session`, `close_session`.
   - **Prompts:** `send_prompt`, `enqueue_prompt`, `remove_queued_prompt`, `send_keys`.
   - **Terminal:** `read_terminal` (from the headless screen), `wait_for_sessions`.
   - **Branch data:** `set_worktree_tag`, `set_worktree_custom_tag`, `set_worktree_note`, `set_worktree_ticket`, `set_worktree_pull_request`.
   - **Session types:** `list_session_types`, `save_session_type`, `delete_session_type`.
6. **Tools left out of 2e.**
   - **Desktop UI only:**
     - `get_selected_worktree` and `focus_session` (selection lives in clients);
     - `request_decision` (the decision flag and its notification belong to phase 3's notifications menu);
     - `promote_to_primary` (it needs a confirmation dialog).
   - **Phase 5:** `speak_summary` (voice) and `get_stack`, `start_stack`, `stop_stack`, `read_stack_log` (Docker).
   - **Behaviour:** they are not listed, and calling one is the JSON-RPC error `-32602 "Unknown tool"`.
7. **Ids in tool parameters.** The parameter keeps the desktop's name `terminalId` so existing prompts keep working. Its value is the session id, which is `TREK_TERMINAL_ID` / `TREK_SESSION_ID` in the agent's env. A worktree parameter accepts a worktree id, path, branch or name, matched in that order. A branch or name that matches in more than one repository is `BAD_REQUEST` and lists the candidates.
8. **Readiness and waiting** follow the desktop:
   - A session counts as *settled* when its status is not `working`. A session that has never produced output also counts as not yet settled, because the server has no `starting` status.
   - **`send_prompt` (and `start_session` with a `prompt`)** first waits up to 60 s for the session's first output, then up to 30 s until it is settled. It sends even if those waits time out.
   - **`wait_for_sessions`:**
     - `until`: `all` (default) or `any`;
     - `timeoutSeconds`: default 300, maximum 600;
     - it waits 1.5 s first when the condition already holds;
     - it returns `{timedOut, sessions: [{terminalId, status}]}`, where a session that has disappeared reports status `closed`.
   - Waiting polls every 250 ms.
9. **Tool results** are `{content: [{type: 'text', text: JSON.stringify(result, null, 2)}], isError: false}`. Errors are `isError: true` with the error message as the text.
10. **Capacity code (carry-over).**
    - A new wire error code `CAPACITY` covers the `maxSessions` refusal and the new session-record cap.
    - Each project holds at most 500 session records (`MAX_SESSIONS_PER_PROJECT`); `session.start` beyond that is `CAPACITY`.
11. **Terminal size cap (carry-over).** Columns are at most 500 and rows at most 200, for spawn, resize, `session.start` and `restart`. This bounds the headless screen at about 18 MB per pty.
12. **v1 limits (carry-over).** v1 `pty.spawn` stays outside `maxSessions` and `forceKillAll`. v1 is retired in phase 4, which is documented.

## Conventions

- **Tests:** `scripts/*.test.mjs`, run from the repo root with `npm test`. Modules imported by tests use only erasable TypeScript, and their runtime relative imports include `.ts`. Tests may open real loopback HTTP connections (the sandbox allows loopback).
- **Typechecks:** `npm run typecheck` (root) and `cd server && npm run typecheck`. **Smoke test:** `cd server && npm run smoke`, then `npm run build && npm run smoke -- --built`.
- **Branch and commits:** base branch `master`, no remote; work on `central-server-phase2e`. There is no global git identity, so commit with `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit …` and the trailer of the model doing the work. Use an explicit path list (`… commit -m … -- <files>`) when other agents work in parallel.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/shared/tickets.ts` | create | `parseTicket`, `ticketUrl`, `isLinearTicket` (moved from the renderer store) |
| `src/shared/keys.ts` | create | `KEY_SEQUENCES`, `keySequence` (moved from the renderer) |
| `src/renderer/src/store.ts`, `src/renderer/src/terminals.ts` | modify | import the moved code |
| `src/shared/protocol.ts`, `server/src/errors.ts` | modify | `CAPACITY` |
| `server/src/sessions/limits.ts`, `manager.ts`, `terminalHost.ts` | modify | record cap, size cap, `CAPACITY`; `mcpAccess` dependency; `hasOutput` |
| `server/src/mcp/protocol.ts` | create | JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`, batching |
| `server/src/mcp/access.ts` | create | per-project tokens and config files |
| `server/src/mcp/listener.ts` | create | the loopback HTTP server |
| `server/src/mcp/tools.ts` | create | tool definitions and handlers |
| `server/src/mcp/describe.ts` | create | worktree descriptions and worktree resolution (pure) |
| `server/src/server.ts`, `server/src/index.ts`, `server/src/v2.ts` | modify | start/stop the listener, revoke on `project.delete` |
| `PROTOCOL.md`, `server/README.md` | modify | docs |
| `server/scripts/smoke.mjs` | modify | call a tool through a session's config file |
| `scripts/serverMcpProtocol.test.mjs`, `scripts/serverMcpAccess.test.mjs`, `scripts/serverMcpListener.test.mjs`, `scripts/serverMcpTools.test.mjs` | create | |

---

### Task 1: Move the pure ticket and key helpers into `src/shared`

**Files:**
- Create: `src/shared/tickets.ts`, `src/shared/keys.ts`
- Modify: `src/renderer/src/store.ts`, `src/renderer/src/terminals.ts`
- Test: `scripts/sharedTicketsKeys.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/sharedTicketsKeys.test.mjs — ticket parsing/URLs and named keys, shared by desktop and server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLinearTicket, parseTicket, ticketUrl } from '../src/shared/tickets.ts'
import { KEY_SEQUENCES, keySequence } from '../src/shared/keys.ts'

test('parseTicket', () => {
  assert.deepEqual(parseTicket('https://linear.app/acme/issue/tow-12/x'), { ticketId: 'TOW-12', linearWorkspace: 'acme' })
  assert.deepEqual(parseTicket('https://dev.azure.com/o/p/_workitems/edit/42'), { ticketId: '42', azureDevOpsBaseUrl: 'https://dev.azure.com/o/p' })
  assert.deepEqual(parseTicket(' tow-9 '), { ticketId: 'TOW-9' })
  assert.deepEqual(parseTicket('123'), { ticketId: '123' })
  assert.equal(parseTicket('not a ticket'), null)
  assert.equal(isLinearTicket('TOW-1'), true)
  assert.equal(isLinearTicket('12'), false)
})

test('ticketUrl', () => {
  assert.equal(ticketUrl({ linearWorkspace: 'acme' }, 'TOW-1'), 'https://linear.app/acme/issue/TOW-1')
  assert.equal(ticketUrl({}, 'TOW-1'), null)
  assert.equal(ticketUrl({ azureDevOpsBaseUrl: 'https://d/o/p/' }, '7'), 'https://d/o/p/_workitems/edit/7')
  assert.equal(ticketUrl({ linearWorkspace: 'a' }, 'TOW-1', { url: 'https://x' }), 'https://x')
})

test('keySequence maps named keys and passes literal text', () => {
  assert.equal(keySequence('enter'), '\r')
  assert.equal(keySequence('ctrl-c'), '\x03')
  assert.equal(keySequence('hello'), 'hello')
  assert.equal(KEY_SEQUENCES.esc, '\x1b')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/sharedTicketsKeys.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement**

`src/shared/tickets.ts`: move `isLinearTicket`, `ParsedTicket`, `parseTicket` and `ticketUrl` out of `src/renderer/src/store.ts`, about lines 161–203, unchanged except for types:
- `ticketUrl`'s first parameter becomes `project: { linearWorkspace?: string; azureDevOpsBaseUrl?: string }`;
- `issue` becomes `issue?: { url: string }`.

Re-export them from `store.ts` (`export { isLinearTicket, parseTicket, ticketUrl, type ParsedTicket } from '../../shared/tickets'`) so renderer imports don't change. Any other helper in `store.ts` that uses them keeps working.

`src/shared/keys.ts`:

```ts
// Named keys an agent can send through send_keys; anything else is typed literally.
export const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04'
}

export function keySequence(key: string): string {
  return Object.hasOwn(KEY_SEQUENCES, key.toLowerCase()) ? KEY_SEQUENCES[key.toLowerCase()] : key
}
```

In `src/renderer/src/terminals.ts`, delete the local `KEY_SEQUENCES` and import `keySequence` from `'../../shared/keys'`. Then make `sendKeysToTerminal` use `keySequence(k)`. Check how it maps keys today: if it does not lowercase, keep its exact behaviour by using `KEY_SEQUENCES[k] ?? k` instead.

- [ ] **Step 4: Run the tests and both typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tickets.ts src/shared/keys.ts scripts/sharedTicketsKeys.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor: share ticket parsing and named keys" -m "Co-Authored-By: <model trailer>" -- src/shared/tickets.ts src/shared/keys.ts src/renderer/src/store.ts src/renderer/src/terminals.ts scripts/sharedTicketsKeys.test.mjs
```

---

### Task 2: Carry-overs — `CAPACITY`, the session-record cap, the terminal size cap

**Files:**
- Modify: `src/shared/protocol.ts`, `server/src/errors.ts`
- Modify: `server/src/sessions/limits.ts`, `server/src/sessions/manager.ts`, `server/src/sessions/terminalHost.ts`
- Test: `scripts/serverSessions.test.mjs`, `scripts/serverTerminalHost.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverSessions.test.mjs`, using its `setup`, `size` and so on:

```js
test('maxSessions refusals use CAPACITY', (t) => {
  const s = setup(t, { maxSessions: 1 })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY')
})

test('a project holds at most MAX_SESSIONS_PER_PROJECT session records', async (t) => {
  const { MAX_SESSIONS_PER_PROJECT } = await import('../server/src/sessions/limits.ts')
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT; i++) {
      d.repositories[0].worktrees[1].sessions.push({ id: `r${i}`, title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' })
    }
  })
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].loaded = true })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY')
})

test('terminal sizes are capped at 500 columns and 200 rows', (t) => {
  const s = setup(t)
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 501, rows: 30 }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 80, rows: 201 }), (e) => e.code === 'BAD_REQUEST')
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 500, rows: 200 })
})
```

Append to `scripts/serverTerminalHost.test.mjs` a test that `spawn` and `resize` refuse `cols: 501` and `rows: 201` with BAD_REQUEST, and accept 500 by 200.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`

- [ ] **Step 3: Implement**

- **Error codes:**
  - In `src/shared/protocol.ts`, add `| 'CAPACITY'` to `WireErrorCode` with a doc comment: "v2: the server is at a session limit (`maxSessions` or the per-project session-record cap)".
  - In `server/src/errors.ts`, add `'CAPACITY'` to `PASSTHROUGH`.
- **Limits:** in `server/src/sessions/limits.ts`, add these constants:
  - `export const MAX_COLS = 500`
  - `export const MAX_ROWS = 200`
  - `export const MAX_SESSIONS_PER_PROJECT = 500`
- **`terminalHost.ts`:** size validation (`validateSize`, or whatever the file calls it) uses `MAX_COLS` and `MAX_ROWS` in place of 1000. Update the message to "cols must be 1–500 and rows 1–200".
- **`manager.ts`:**
  - `requireSize` uses the same limits.
  - The `maxSessions` refusal throws `codedError('CAPACITY', …)`, with the same message.
  - In `start`, after validation and before any load or spawn, count the project's session records: Global sessions plus the sessions of every worktree. If the count is `>= MAX_SESSIONS_PER_PROJECT`, throw `codedError('CAPACITY', \`a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions; close some first\`)`.
- **Existing tests:** update any test that expected BAD_REQUEST for the `maxSessions` cap to expect CAPACITY.

- [ ] **Step 4: Run the tests and typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): CAPACITY error code, per-project session cap, 500x200 terminal cap" -m "Co-Authored-By: <model trailer>" -- src/shared/protocol.ts server/src/errors.ts server/src/sessions/limits.ts server/src/sessions/manager.ts server/src/sessions/terminalHost.ts scripts/serverSessions.test.mjs scripts/serverTerminalHost.test.mjs
```

---

### Task 3: MCP JSON-RPC handling (pure)

**Files:**
- Create: `server/src/mcp/protocol.ts`
- Test: `scripts/serverMcpProtocol.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/serverMcpProtocol.test.mjs — MCP JSON-RPC: initialize, ping, tools/list, tools/call, notifications, batches.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleMcpBody } from '../server/src/mcp/protocol.ts'

const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]
const ctx = {
  serverVersion: '0.2.0',
  instructions: 'Use these tools.',
  tools,
  call: async (name, args) => {
    if (name === 'boom') throw new Error('it broke')
    return { echoed: args }
  }
}
const body = (v) => JSON.stringify(v)

test('initialize negotiates the protocol version', async () => {
  const r = await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }), ctx)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'trek-dev', version: '0.2.0' },
    instructions: 'Use these tools.'
  })
  const unknown = await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }), ctx)
  assert.equal(unknown.json.result.protocolVersion, '2025-06-18')
})

test('ping, tools/list and an unknown method', async () => {
  assert.deepEqual((await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'ping' }), ctx)).json, { jsonrpc: '2.0', id: 1, result: {} })
  assert.deepEqual((await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx)).json.result, { tools })
  assert.equal((await handleMcpBody(body({ jsonrpc: '2.0', id: 3, method: 'nope' }), ctx)).json.error.code, -32601)
})

test('tools/call: text content, isError on a throw, -32602 for an unknown tool', async () => {
  const ok = await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }), ctx)
  assert.deepEqual(ok.json.result, { content: [{ type: 'text', text: JSON.stringify({ echoed: { a: 1 } }, null, 2) }], isError: false })
  const err = await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } }), { ...ctx, tools: [...tools, { name: 'boom', description: '', inputSchema: { type: 'object' } }] })
  assert.deepEqual(err.json.result, { content: [{ type: 'text', text: 'it broke' }], isError: true })
  const unknown = await handleMcpBody(body({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing', arguments: {} } }), ctx)
  assert.equal(unknown.json.error.code, -32602)
  assert.match(unknown.json.error.message, /Unknown tool: missing/)
})

test('notifications get 202 and no body; batches return arrays', async () => {
  const n = await handleMcpBody(body({ jsonrpc: '2.0', method: 'notifications/initialized' }), ctx)
  assert.deepEqual(n, { status: 202 })
  const batch = await handleMcpBody(body([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]), ctx)
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.json.map((r) => r.id), [1, 2])
})

test('a body that is not JSON is a 400 parse error', async () => {
  const r = await handleMcpBody('{nope', ctx)
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, -32700)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverMcpProtocol.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement**

Create `server/src/mcp/protocol.ts`:

```ts
// MCP over JSON-RPC, as the desktop's hand-written server does it (src/main/mcp.ts):
// initialize, ping, tools/list and tools/call; notifications get 202; batches work;
// plain JSON responses, no SSE or Mcp-Session-Id.

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpContext {
  serverVersion: string
  instructions: string
  tools: readonly ToolDefinition[]
  /** Runs a listed tool; a throw becomes an isError result with the message */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export type McpReply = { status: 202 } | { status: 200 | 400; json: unknown }

interface Message {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const reply = (id: Message['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const failure = (id: Message['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function handleMessage(msg: Message, ctx: McpContext): Promise<unknown | null> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return failure(null, -32600, 'Invalid request')
  if (msg.id === undefined) return null
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return reply(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'trek-dev', version: ctx.serverVersion },
        instructions: ctx.instructions
      })
    }
    case 'ping':
      return reply(msg.id, {})
    case 'tools/list':
      return reply(msg.id, { tools: ctx.tools })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!ctx.tools.some((t) => t.name === name)) return failure(msg.id, -32602, `Unknown tool: ${name}`)
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {}
      try {
        const result = await ctx.call(name, args)
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }], isError: false })
      } catch (err) {
        return reply(msg.id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      return failure(msg.id, -32601, 'Method not found')
  }
}

/** Handles one HTTP body (a message or a batch). */
export async function handleMcpBody(body: string, ctx: McpContext): Promise<McpReply> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: 400, json: failure(null, -32700, 'Parse error') }
  }
  if (Array.isArray(parsed)) {
    const replies = (await Promise.all(parsed.map((m) => handleMessage(m as Message, ctx)))).filter((r) => r !== null)
    return replies.length === 0 ? { status: 202 } : { status: 200, json: replies }
  }
  const one = await handleMessage(parsed as Message, ctx)
  return one === null ? { status: 202 } : { status: 200, json: one }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverMcpProtocol.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/protocol.ts scripts/serverMcpProtocol.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): MCP JSON-RPC handling" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/protocol.ts scripts/serverMcpProtocol.test.mjs
```

---

### Task 4: Per-project MCP access and config files

**Files:**
- Create: `server/src/mcp/access.ts`
- Test: `scripts/serverMcpAccess.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/serverMcpAccess.test.mjs — per-project MCP tokens and their 0600 config files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpAccessStore } from '../server/src/mcp/access.ts'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-mcp-access-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, mcpDir: join(dir, 'mcp') }
}

test('no access before the listener has a port', (t) => {
  const { mcpDir } = setup(t)
  assert.equal(new McpAccessStore(mcpDir).accessFor('p1'), undefined)
})

test('accessFor writes the Claude and Gemini files once per project, mode 0600', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(4321)
  const a = store.accessFor('p1')
  assert.equal(a.url, 'http://127.0.0.1:4321/mcp')
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.equal(a.configPath, join(mcpDir, 'p1.json'))
  assert.equal(a.geminiSettingsPath, join(mcpDir, 'p1-gemini.json'))
  assert.deepEqual(JSON.parse(readFileSync(a.configPath, 'utf8')), {
    mcpServers: { 'trek-dev': { type: 'http', url: a.url, headers: { Authorization: `Bearer ${a.token}` } } }
  })
  assert.deepEqual(JSON.parse(readFileSync(a.geminiSettingsPath, 'utf8')), {
    mcpServers: { 'trek-dev': { httpUrl: a.url, headers: { Authorization: `Bearer ${a.token}` }, trust: true } }
  })
  assert.equal(statSync(a.configPath).mode & 0o777, 0o600)
  assert.equal(statSync(mcpDir).mode & 0o777, 0o700)
  assert.deepEqual(store.accessFor('p1'), a, 'the same token and files on the next call')
  assert.notEqual(store.accessFor('p2').token, a.token)
})

test('projectFor matches the bearer header; revoke removes token and files', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1)
  const a = store.accessFor('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), 'p1')
  assert.equal(store.projectFor(`Bearer ${'0'.repeat(64)}`), undefined)
  assert.equal(store.projectFor(undefined), undefined)
  assert.equal(store.projectFor('Basic x'), undefined)
  store.revoke('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), undefined)
  assert.equal(existsSync(a.configPath), false)
  assert.equal(existsSync(a.geminiSettingsPath), false)
})

test('the constructor clears files from an earlier run', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(mcpDir, { recursive: true })
  writeFileSync(join(mcpDir, 'old.json'), '{}')
  new McpAccessStore(mcpDir)
  assert.equal(existsSync(join(mcpDir, 'old.json')), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverMcpAccess.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement**

Create `server/src/mcp/access.ts`:

```ts
// One MCP bearer token per project, plus the config files agents are launched
// with. Tokens live in memory: a server start makes new ones (and a new port).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpAccess } from '../../../src/shared/providers/types'
import { writeFileAtomic } from '../atomicWrite.ts'

export class McpAccessStore {
  private readonly dir: string
  private port?: number
  private readonly byProject = new Map<string, McpAccess>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true })
  }

  /** Called once the listener knows its port. */
  setPort(port: number): void {
    this.port = port
    for (const projectId of [...this.byProject.keys()]) this.byProject.delete(projectId)
  }

  /** The project's access, created on first use; undefined until the listener is up. */
  accessFor(projectId: string): McpAccess | undefined {
    if (this.port === undefined) return undefined
    const existing = this.byProject.get(projectId)
    if (existing) return existing
    const token = randomBytes(32).toString('hex')
    const url = `http://127.0.0.1:${this.port}/mcp`
    const headers = { Authorization: `Bearer ${token}` }
    const configPath = join(this.dir, `${projectId}.json`)
    const geminiSettingsPath = join(this.dir, `${projectId}-gemini.json`)
    writeFileAtomic(configPath, JSON.stringify({ mcpServers: { 'trek-dev': { type: 'http', url, headers } } }, null, 2), 0o600)
    writeFileAtomic(geminiSettingsPath, JSON.stringify({ mcpServers: { 'trek-dev': { httpUrl: url, headers, trust: true } } }, null, 2), 0o600)
    const access: McpAccess = { configPath, url, token, geminiSettingsPath }
    this.byProject.set(projectId, access)
    return access
  }

  /** The project a request's Authorization header belongs to. */
  projectFor(header: string | undefined): string | undefined {
    if (!header) return undefined
    const given = Buffer.from(header)
    for (const [projectId, access] of this.byProject) {
      const expected = Buffer.from(`Bearer ${access.token}`)
      if (given.length === expected.length && timingSafeEqual(given, expected)) return projectId
    }
    return undefined
  }

  revoke(projectId: string): void {
    const access = this.byProject.get(projectId)
    this.byProject.delete(projectId)
    if (!access) return
    rmSync(access.configPath, { force: true })
    rmSync(access.geminiSettingsPath, { force: true })
  }
}
```

Check `server/src/atomicWrite.ts` for the real export name and signature. It may be `atomicWrite(path, data, mode)`; adapt the calls to match.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverMcpAccess.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/access.ts scripts/serverMcpAccess.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): per-project MCP tokens and config files" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/access.ts scripts/serverMcpAccess.test.mjs
```

---

### Task 5: The loopback HTTP listener

**Files:**
- Create: `server/src/mcp/listener.ts`
- Test: `scripts/serverMcpListener.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/serverMcpListener.test.mjs — the MCP HTTP listener: auth, paths, methods, limits, routing by token.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpAccessStore } from '../server/src/mcp/access.ts'
import { startMcpListener } from '../server/src/mcp/listener.ts'

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-mcp-listener-'))
  const access = new McpAccessStore(join(dir, 'mcp'))
  const calls = []
  const listener = await startMcpListener({
    access,
    serverVersion: '0.2.0',
    contextFor: (projectId) => ({
      instructions: 'x',
      tools: [{ name: 'who', description: '', inputSchema: { type: 'object' } }],
      call: async (name) => { calls.push([projectId, name]); return { projectId } }
    })
  })
  t.after(async () => { await listener.close(); rmSync(dir, { recursive: true, force: true }) })
  const url = access.accessFor('p1').url
  const token = access.accessFor('p1').token
  const post = (body, headers = { authorization: `Bearer ${token}` }, path = '/mcp', method = 'POST') =>
    fetch(url.replace('/mcp', path), { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body })
  return { access, calls, listener, url, token, post }
}

test('listens on loopback and routes a call to the token\'s project', async (t) => {
  const s = await setup(t)
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const res = await s.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'who', arguments: {} } }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.match((await res.json()).result.content[0].text, /"projectId": "p1"/)
  assert.deepEqual(s.calls, [['p1', 'who']])
})

test('401 without a valid token; 404 for other paths; 405 for GET', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post('{}', {})).status, 401)
  assert.equal((await s.post('{}', { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await s.post('{}', undefined, '/other')).status, 404)
  const get = await s.post('', undefined, '/mcp', 'GET')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
})

test('202 for notifications; 413 above 1 MiB', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202)
  assert.equal((await s.post('x'.repeat(1024 * 1024 + 1))).status, 413)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverMcpListener.test.mjs 2>&1 | tail -3`

- [ ] **Step 3: Implement**

Create `server/src/mcp/listener.ts`:

```ts
// The trek-dev MCP endpoint: loopback only, POST /mcp, one bearer token per project.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpAccessStore } from './access.ts'
import { handleMcpBody, type McpContext } from './protocol.ts'

export const MAX_MCP_BODY = 1024 * 1024

export interface McpListenerDeps {
  access: McpAccessStore
  serverVersion: string
  /** The tools and instructions for one project's token */
  contextFor: (projectId: string) => Omit<McpContext, 'serverVersion'>
}

export interface McpListener {
  port: number
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, json?: unknown, headers: Record<string, string> = {}): void {
  if (json === undefined) {
    res.writeHead(status, headers).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(json))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_MCP_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startMcpListener(deps: McpListenerDeps): Promise<McpListener> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if ((req.url ?? '').split('?')[0] !== '/mcp') return send(res, 404)
        if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST' })
        const projectId = deps.access.projectFor(req.headers.authorization)
        if (!projectId) return send(res, 401)
        const body = await readBody(req)
        if (body === null) return send(res, 413)
        const reply = await handleMcpBody(body, { serverVersion: deps.serverVersion, ...deps.contextFor(projectId) })
        if (reply.status === 202) return send(res, 202)
        send(res, reply.status, reply.json)
      } catch (err) {
        if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } })
      }
    })()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      deps.access.setPort(port)
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}
```

The tests read `access.accessFor('p1')` after `startMcpListener` resolves, so `setPort` has already run.

`close()` waits for open connections. If tests hang on keep-alive, call `server.closeAllConnections()` before `server.close`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverMcpListener.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/listener.ts scripts/serverMcpListener.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): loopback MCP listener" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/listener.ts scripts/serverMcpListener.test.mjs
```

---

### Task 6: Worktree descriptions and resolution (pure)

**Files:**
- Create: `server/src/mcp/describe.ts`
- Test: `scripts/serverMcpTools.test.mjs` (created here; Tasks 7–8 append to it)

- [ ] **Step 1: Write the failing test**

```js
// scripts/serverMcpTools.test.mjs — trek-dev tools on the server: describing and resolving worktrees, then the tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorktree, resolveWorktree } from '../server/src/mcp/describe.ts'

const s = (id, status = 'idle') => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status })
const project = {
  id: 'p', name: 'P',
  settings: { worktreeTags: [{ id: 't1', name: 'Todo', color: '#fff' }], customTags: [{ id: 'c1', name: 'Hot', color: '#f00' }] },
  globalSessions: [],
  repositories: [
    { id: 'ra', name: 'A', path: '/r/a', branchData: { feat: { tag: 't1', customTags: ['c1'], note: 'n', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3' } }, worktrees: [
      { id: 'am', name: 'A', path: '/r/a', branch: 'main', isMain: true, loaded: false, sessions: [] },
      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working')] }
    ] },
    { id: 'rb', name: 'B', path: '/r/b', branchData: {}, worktrees: [
      { id: 'bm', name: 'B', path: '/r/b', branch: 'main', isMain: true, loaded: false, sessions: [] }
    ] }
  ]
}

test('describeWorktree', () => {
  assert.deepEqual(describeWorktree(project, project.repositories[0], project.repositories[0].worktrees[1]), {
    worktree: 'af', repo: 'A', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', note: 'n',
    dirty: true, ahead: 1, behind: 0, loaded: true,
    sessions: [{ terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'] }]
  })
})

test('resolveWorktree: id, path, then branch or name; ambiguity across repositories', () => {
  assert.equal(resolveWorktree(project, 'af').worktree.id, 'af')
  assert.equal(resolveWorktree(project, '/r/a-feat').worktree.id, 'af')
  assert.equal(resolveWorktree(project, 'feat').worktree.id, 'af')
  assert.throws(() => resolveWorktree(project, 'main'), (e) => e.code === 'BAD_REQUEST' && /A: \/r\/a/.test(e.message) && /B: \/r\/b/.test(e.message))
  assert.throws(() => resolveWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | tail -3`

- [ ] **Step 3: Implement**

Create `server/src/mcp/describe.ts`:

```ts
// Worktrees as MCP tools see them (the desktop's describeWorktree, minus client UI state).
import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'

export function describeWorktree(project: Project, repo: Repository, w: Worktree) {
  const data = w.branch && Object.hasOwn(repo.branchData, w.branch) ? repo.branchData[w.branch] : {}
  const tagName = (id?: string) => project.settings.worktreeTags?.find((t) => t.id === id)?.name
  const customName = (id: string) => project.settings.customTags?.find((t) => t.id === id)?.name ?? id
  return {
    worktree: w.id,
    repo: repo.name,
    path: w.path,
    branch: w.branch,
    primary: w.isMain,
    missing: w.missing ?? false,
    tag: tagName(data.tag),
    customTags: (data.customTags ?? []).map(customName),
    ticket: data.ticket,
    pullRequest: data.pr,
    note: data.note,
    dirty: w.dirty,
    ahead: w.ahead,
    behind: w.behind,
    loaded: w.loaded,
    sessions: w.sessions.map((s) => ({ terminalId: s.id, title: s.title, status: s.status, llm: s.llm, queue: s.queue }))
  }
}

/** A worktree by id, then path, then branch or name; a branch/name in several repositories is ambiguous. */
export function resolveWorktree(project: Project, ref: unknown): { repo: Repository; worktree: Worktree } {
  if (typeof ref !== 'string' || ref.trim() === '') throw codedError('BAD_REQUEST', 'worktree is required')
  const all = project.repositories.flatMap((repo) => repo.worktrees.map((worktree) => ({ repo, worktree })))
  const byId = all.find((x) => x.worktree.id === ref)
  if (byId) return byId
  const byPath = all.find((x) => x.worktree.path === ref || real(x.worktree.path) === real(ref))
  if (byPath) return byPath
  const named = all.filter((x) => x.worktree.branch === ref || x.worktree.name === ref)
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    throw codedError('BAD_REQUEST', `"${ref}" matches several worktrees; pass a path: ${named.map((x) => `${x.repo.name}: ${x.worktree.path}`).join(', ')}`)
  }
  throw codedError('NOT_FOUND', `No worktree "${ref}" in this project`)
}
```

`real(ref)` on a branch name resolves against the cwd, so the path rule could match a worktree whose path equals `<cwd>/<branch>`. That is harmless, but if it bothers you, only try the path rule when `ref` is absolute (`isAbsolute` from `node:path`). Do that.

A branch or name that appears in several worktrees of *one* repository can't happen: one branch can't be checked out twice. Names are derived from branches.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/describe.ts scripts/serverMcpTools.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): describe and resolve worktrees for MCP tools" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/describe.ts scripts/serverMcpTools.test.mjs
```

---

### Task 7: The tools — worktrees, branch data, session types

**Files:**
- Create: `server/src/mcp/tools.ts`
- Test: `scripts/serverMcpTools.test.mjs`

**Design.**
- `tools.ts` exports `MCP_TOOLS: ToolDefinition[]` and `MCP_INSTRUCTIONS`.
- It also exports `createToolCaller(deps)`, which returns `(projectId) => (name, args) => Promise<unknown>`, where `deps = { v2: V2Context-like, sessions: SessionManager, projects: ProjectState, now?, sleep? }`.
- The caller runs v2 commands in process through `dispatchV2(method, params, ctx)`, with a context whose `subscriber` and `terminal` are inert stubs. It turns `{ok:false}` into a thrown `Error(message)`.
- **Tool descriptions and schemas:** copy the desktop's text from `src/main/mcp.ts` (the `TOOLS` array, lines 48–371) for every tool in decision 5, dropping only the `server` parameter of `create_worktree`. Keep the parameter names (`worktree`, `terminalId`, `sessionType`, `provider`/`model`/`effort`).
- **`MCP_INSTRUCTIONS`:** adapt the desktop's `INSTRUCTIONS` constant. Remove mentions of the left-out tools and of remote servers. Say that the tools act on this project only.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverMcpTools.test.mjs`. The test needs a real `ProjectState`, `SessionManager` (fake spawner), `ConfigStore`, `TopicHub`, a stub poller and `dispatchV2`.
- Build it like `scripts/serverSessions.test.mjs`'s `setup`; read that file and copy its fake spawner and temp-config approach.
- Use `scripts/serverWorktrees.test.mjs`'s real-git setup only for `create_worktree`.

Add a helper and these tests:

```js
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { MCP_TOOLS, createToolCaller } from '../server/src/mcp/tools.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { TopicHub } from '../server/src/topicHub.ts'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

/** A fake pty: records writes, emits output, exits on demand (as in serverSessions.test.mjs). */
function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], killed: false, dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) }, resize() {}, pause() {}, resume() {},
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) },
      emit(d) { this.dataCb(d) }, exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

/** A project on a real git repo, a fake pty spawner, and a tool caller for it. */
async function toolSetup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-mcp-tools-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  execFileSync('git', ['-C', a, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  const configPath = join(dir, 'config.json')
  const registered = { id: 'a', name: 'a', path: a }
  saveConfig(configPath, { repos: [registered] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  const { spawned, spawner } = fakeSpawner()
  const jobs = []
  const schedule = (fn, ms) => { const job = { fn, ms, cancelled: false, fired: false }; jobs.push(job); return { cancel: () => { job.cancelled = true } } }
  const sessions = new SessionManager({ projects, store, hub, spawner, schedule, discover: async () => undefined })
  t.after(() => { sessions.stopAll(); poller.stop(); store.close() })
  const projectId = projects.create('P', [{ registered, name: undefined }])
  await poller.refresh(a)
  const callerFor = createToolCaller({ store, hub, projects, poller, sessions, pollMs: 5, graceMs: 10, readyTimeouts: { firstOutputMs: 200, settleMs: 200 } })
  /** Fires the one pending 2.5 s quiet timer of a session's current run. */
  const fireQuiet = () => {
    const job = jobs.find((j) => j.ms === 2500 && !j.cancelled && !j.fired)
    assert.ok(job, 'a quiet timer is pending')
    job.fired = true
    job.fn()
  }
  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir }
}
```

Then add the tests:

```js
test('the tool list matches decision 5', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session',
    'list_session_types', 'list_worktrees', 'load_worktree', 'read_terminal', 'remove_queued_prompt',
    'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'start_session', 'unload_worktree',
    'wait_for_sessions'
  ])
})

test('list_worktrees and create_worktree', async (t) => {
  const s = await toolSetup(t)
  assert.equal((await s.call('list_worktrees', {})).length, 1)
  const created = await s.call('create_worktree', { branch: 'feat/x' })
  assert.equal(created.branch, 'feat/x')
  assert.equal((await s.call('list_worktrees', {})).length, 2)
})

test('branch data tools: tag by name, custom tag, note, ticket, pull request', async (t) => {
  const s = await toolSetup(t)
  s.projects.apply(s.projectId, (d) => {
    d.settings.worktreeTags = [{ id: 'todo', name: 'Todo', color: '#fff' }]
    d.settings.customTags = [{ id: 'hot', name: 'Hot', color: '#f00' }]
  })
  assert.deepEqual(await s.call('set_worktree_tag', { worktree: 'main', tag: 'todo' }), { branch: 'main', tag: 'Todo' })
  await assert.rejects(s.call('set_worktree_tag', { worktree: 'main', tag: 'nope' }), /Todo/)
  assert.deepEqual(await s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'hot' }), { branch: 'main', customTags: ['Hot'] })
  assert.deepEqual(await s.call('set_worktree_note', { worktree: 'main', note: 'hi' }), { branch: 'main' })
  const ticket = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 'https://linear.app/acme/issue/tow-5/x' })
  assert.deepEqual(ticket, { branch: 'main', ticket: 'TOW-5', url: 'https://linear.app/acme/issue/TOW-5' })
  assert.deepEqual(await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
  const data = s.projects.require(s.projectId).repositories[0].branchData.main
  assert.deepEqual([data.tag, data.customTags, data.note, data.ticket, data.pr], ['todo', ['hot'], 'hi', 'TOW-5', 'https://github.com/o/r/pull/9'])
  assert.equal(s.projects.require(s.projectId).settings.linearWorkspace, 'acme')
})

test('session types: list, save (create and update by name), delete', async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('list_session_types', {}), [])
  const created = await s.call('save_session_type', { name: 'Review', systemPrompt: 'Review it' })
  assert.equal(created.name, 'Review')
  const updated = await s.call('save_session_type', { name: 'review', initialMessage: 'go' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.initialMessage, 'go')
  assert.deepEqual(await s.call('delete_session_type', { sessionType: 'Review' }), { deleted: 'Review' })
  assert.deepEqual(await s.call('list_session_types', {}), [])
})

test('load_worktree and unload_worktree', async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('load_worktree', { worktree: 'main' }), { loaded: true, sessions: [] })
  assert.deepEqual(await s.call('unload_worktree', { worktree: 'main' }), { unloaded: true })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

- [ ] **Step 3: Implement**

Create `server/src/mcp/tools.ts`. Each handler below is specified exactly. The desktop's behaviour is in `src/renderer/src/mcpTools.ts`; read the matching function for each one.

- **`list_worktrees`:** every worktree of the project, `describeWorktree` each.
- **`create_worktree {branch, existingBranch?, repo?}`:**
  - `repo` is required when the project has more than one repository. Match it by repository id or name, case-insensitively; ambiguous or unknown is BAD_REQUEST or NOT_FOUND.
  - Run v2 `worktree.create {projectId, repoId, branch, createBranch: existingBranch !== true}`.
  - Return `describeWorktree` of the new worktree.
- **`load_worktree {worktree}`:** v2 `worktree.load`, then return `{loaded: true, sessions: describeWorktree(...).sessions}`.
- **`unload_worktree {worktree}`:** v2 `worktree.unload`, then return `{unloaded: true}`.
- **`set_worktree_tag {worktree, tag?}`:**
  - A detached worktree (no branch) is BAD_REQUEST.
  - An empty or missing `tag` clears it.
  - Otherwise match the tag name or id case-insensitively in `settings.worktreeTags`. Unknown is BAD_REQUEST and lists the tag names.
  - Run v2 `branch.setTag`. Return `{branch, tag: name | null}`.
- **`set_worktree_custom_tag {worktree, tag, enabled?}`:**
  - Match in `settings.customTags`.
  - Add the id to, or remove it from, the branch's current `customTags`.
  - Run v2 `branch.setCustomTags`. Return `{branch, customTags: names}`.
- **`set_worktree_note {worktree, note}`:** v2 `branch.setNote`, then return `{branch}`.
- **`set_worktree_ticket {worktree, ticket?}`:**
  - An empty or missing `ticket` clears it.
  - Otherwise `parseTicket` from `src/shared/tickets.ts`. Null is BAD_REQUEST.
  - If the parse gives `linearWorkspace` or `azureDevOpsBaseUrl`, run v2 `project.updateSettings` to set it.
  - Run v2 `branch.setTicket`. Return `{branch, ticket, url: ticketUrl(settings, ticketId)}`.
- **`set_worktree_pull_request {worktree, pullRequest?}`:**
  - Port `pullRequestUrl` from `src/renderer/src/mcpTools.ts`, about lines 293–309. It takes a full GitHub URL, or a number / `#n` whose owner and repo come from another PR already linked in the same repository's `branchData`.
  - Empty clears it.
  - Run v2 `branch.setPr`. Return `{branch, pullRequest}`.
- **`list_session_types`:** `settings.sessionTypes ?? []` without `icon`.
- **`save_session_type {id?, name?, systemPrompt?, initialMessage?, llm?}`:**
  - Port the desktop's merge from `mcpTools.ts`:
    - With `id`, update that type; unknown is NOT_FOUND.
    - Otherwise match by name case-insensitively and update; if there's no match, create a new type, which needs `name`, with `id: randomUUID()`.
    - `llm: null` removes the agent.
  - Write with v2 `project.updateSettings {settings: {sessionTypes}}`.
  - Return the type without `icon`.
- **`delete_session_type {sessionType}`:** match by id or name case-insensitively, run `project.updateSettings`, return `{deleted: name}`.

Each tool takes the project fresh (`projects.require(projectId)`) at the start. Write a small `v2(method, params)` helper that adds `projectId` and throws `new Error(outcome.error.message)` on failure. Errors thrown by `resolveWorktree` and the validators reach the agent as `isError` text through `protocol.ts`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm test 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): MCP tools for worktrees, branch data and session types" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/tools.ts scripts/serverMcpTools.test.mjs
```

(`git add server/src/mcp/tools.ts` first.)

---

### Task 8: The tools — sessions, prompts, terminal reads and waiting

**Files:**
- Modify: `server/src/mcp/tools.ts`, `server/src/sessions/manager.ts`
- Test: `scripts/serverMcpTools.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverMcpTools.test.mjs`. Task 7's `toolSetup` already passes fast `pollMs`, `graceMs` and `readyTimeouts` to `createToolCaller`, so tests don't wait 90 s.

```js
test('start_session, get_current_session and close_session', async (t) => {
  const s = await toolSetup(t)
  const { terminalId, status } = await s.call('start_session', { worktree: 'main' })
  assert.equal(status, 'idle')
  const current = await s.call('get_current_session', { terminalId })
  assert.equal(current.terminalId, terminalId)
  assert.equal(current.worktree.worktree, s.projects.require(s.projectId).repositories[0].worktrees[0].id)
  assert.deepEqual(await s.call('close_session', { terminalId }), { closed: true })
  await assert.rejects(s.call('get_current_session', { terminalId }), /No session/)
})

test('send_prompt waits for the agent to be ready, then pastes', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const proc = s.spawned.at(-1)
  setTimeout(() => proc.emit('ready'), 20)
  assert.deepEqual(await s.call('send_prompt', { terminalId, text: 'hello' }), { sent: true })
  assert.equal(proc.written[0], 'hello')
})

test('start_session with a prompt sends it once the agent is ready', async (t) => {
  const s = await toolSetup(t)
  const pending = s.call('start_session', { worktree: 'main', prompt: 'do it' })
  setTimeout(() => s.spawned.at(-1).emit('ready'), 20)
  await pending
  assert.equal(s.spawned.at(-1).written[0], 'do it')
})

test('enqueue_prompt and remove_queued_prompt', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.deepEqual(await s.call('enqueue_prompt', { terminalId, text: 'a' }), { queue: ['a'] })
  await s.call('enqueue_prompt', { terminalId, text: 'b' })
  assert.deepEqual(await s.call('remove_queued_prompt', { terminalId, index: 0 }), { removed: 'a', queue: ['b'] })
  await assert.rejects(s.call('remove_queued_prompt', { terminalId, index: 5 }), /index/)
})

test('send_keys maps named keys and counts as input', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.deepEqual(await s.call('send_keys', { terminalId, keys: ['esc', 'y', 'enter'] }), { sent: 3 })
  assert.deepEqual(s.spawned.at(-1).written, ['\x1b', 'y', '\r'])
})

test('read_terminal reads the headless screen', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  s.spawned.at(-1).emit('line one\r\nline two\r\n')
  const r = await s.call('read_terminal', { terminalId, lines: 1 })
  assert.deepEqual(r, { status: 'working', output: 'line two' })
})

test('wait_for_sessions: any, all with a timeout, and closed sessions', async (t) => {
  const s = await toolSetup(t)
  const a = (await s.call('start_session', { worktree: 'main' })).terminalId
  const b = (await s.call('start_session', { worktree: 'main' })).terminalId
  s.spawned[0].emit('x')
  s.spawned[1].emit('x')
  s.fireQuiet() // the first quiet timer belongs to session a: a settles to idle, b stays working
  const any = await s.call('wait_for_sessions', { terminalIds: [a, b], until: 'any', timeoutSeconds: 1 })
  assert.equal(any.timedOut, false)
  const all = await s.call('wait_for_sessions', { terminalIds: [a, b], timeoutSeconds: 0.05 })
  assert.equal(all.timedOut, true)
  assert.deepEqual(all.sessions.map((x) => x.status), ['idle', 'working'])
  await s.call('close_session', { terminalId: a })
  const closed = await s.call('wait_for_sessions', { terminalIds: [b, a], until: 'any', timeoutSeconds: 1 })
  assert.equal(closed.timedOut, false)
  assert.deepEqual(closed.sessions.find((x) => x.terminalId === a), { terminalId: a, status: 'closed' })
})

test('tools see only their own project', async (t) => {
  const s = await toolSetup(t)
  const other = s.projects.create('Other', [{ registered: s.registered, name: undefined }])
  const otherCall = s.callerFor(other)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  await assert.rejects(otherCall('get_current_session', { terminalId }), /No session/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/serverMcpTools.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

- [ ] **Step 3: Implement**

- **`manager.ts`:** add `hasOutput(sessionId: string): boolean`. It returns true once the session's current run has produced live output, meaning the `activity` map has an entry. It is cleared with the activity when the pty ends.
- **`tools.ts`:** add the tools below. `createToolCaller` deps gain optional `pollMs` (default 250), `graceMs` (default 1500), `readyTimeouts` (default `{ firstOutputMs: 60_000, settleMs: 30_000 }`) and `sleep` (default `setTimeout`-based).
- **Helpers:**
  - `sessionIn(projectId, terminalId)` returns `findSession` in the fresh project; NOT_FOUND reads "No session …".
  - `settled(session)` is `session.status !== 'working' && hasOutput(id)`, or the status is `exited`, `complete` or `attention`.
  - `waitFor(predicate, timeoutMs)` polls every `pollMs` and resolves to true or false.
- **The tools:**
  - **`get_current_session {terminalId}`:** `{terminalId, title, status, llm, queue, worktree: describeWorktree(...)}` for a worktree session. A Global session is `{…, worktree: null}`.
  - **`start_session {worktree, sessionType?, prompt?, provider?, model?, effort?}`:**
    - Port `llmArg`: `model` or `effort` without `provider` is BAD_REQUEST, and `provider` must be a known id.
    - Resolve `sessionType` by id or name, case-insensitively.
    - Run v2 `session.start {projectId, worktreeId, sessionTypeId, llm, cols: 120, rows: 32}`.
    - If there is a `prompt`, wait for readiness as `send_prompt` does, then run v2 `session.sendPrompt`.
    - Return `{terminalId, status}`.
  - **`send_prompt {terminalId, text}`:**
    - Empty text is BAD_REQUEST. An `exited` session is BAD_REQUEST.
    - Wait up to `firstOutputMs` for `hasOutput`, then up to `settleMs` until it is not `working`. Neither timeout throws.
    - Run v2 `session.sendPrompt`. Return `{sent: true}`.
  - **`enqueue_prompt {terminalId, text}`:** v2 `session.enqueue`, then return `{queue}` from the fresh session.
  - **`remove_queued_prompt {terminalId, index}`:**
    - `index` must be an integer within the queue's range, else BAD_REQUEST mentioning "index".
    - Run v2 `session.setQueue` with the item removed. Return `{removed, queue}`.
  - **`send_keys {terminalId, keys: string[]}`:**
    - The session must be running (it has a `ptyId` that `terminals.has` accepts).
    - For each key, `terminals.write(ptyId, keySequence(key))`.
    - Then call `sessions.noteInput(ptyId, 'x')`, so it counts as input; or add a dedicated manager method `noteUserInput(sessionId)` that calls the input transition directly, which is cleaner.
    - Return `{sent: keys.length}`.
  - **`read_terminal {terminalId, lines?}`:**
    - Default 80, clamped to 1–2000.
    - The session must be running.
    - `await terminals.settled(ptyId)`, then `{status, output: terminals.screen(ptyId, lines).join('\n')}`.
  - **`wait_for_sessions {terminalIds, until?, timeoutSeconds?}`:**
    - Each id must exist at the start, else NOT_FOUND.
    - The condition is every one (or, with `until: 'any'`, at least one) settled or gone.
    - If it already holds, sleep `graceMs` first.
    - Poll until it holds or `min(timeoutSeconds || 300, 600)` seconds pass.
    - Return `{timedOut, sessions: [{terminalId, status: s?.status ?? 'closed'}]}`.
  - **`close_session {terminalId}`:** v2 `session.close`, then return `{closed: true}`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): MCP tools for sessions, prompts, terminal reads and waiting" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/tools.ts server/src/sessions/manager.ts scripts/serverMcpTools.test.mjs
```

---

### Task 9: Sessions launch with MCP

**Files:**
- Modify: `server/src/sessions/manager.ts`
- Test: `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('sessions launch with the project\'s MCP access; Global sessions get the role prompt', (t) => {
  const s = setup(t, { mcpAccess: (projectId) => ({ configPath: `/m/${projectId}.json`, url: 'http://127.0.0.1:9/mcp', token: 'tok', geminiSettingsPath: `/m/${projectId}-g.json` }) })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.match(cmd(s.spawned[0]), new RegExp(`--mcp-config '/m/${s.projectId}.json' --allowedTools mcp__trek-dev`))
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.match(cmd(s.spawned[1]), /global Claude session/)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'codex' }, ...size })
  assert.equal(s.spawned[2].opts.env.TREK_MCP_TOKEN, 'tok')
})

test('without MCP access sessions launch as before', (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.doesNotMatch(cmd(s.spawned[0]), /--mcp-config/)
})
```

`setup` must pass an optional `mcpAccess` option through to `SessionManager`.

- [ ] **Step 2: Run to verify it fails, then implement**

- Add `mcpAccess?: (projectId: string) => McpAccess | undefined` to `SessionManagerDeps`.
- In the spawn method, pass `mcp: this.deps.mcpAccess?.(projectId)` into the `agentCommand` launch object. `agentCommand` already ignores it for providers without MCP and adds the Global role prompt when it is set.

- [ ] **Step 3: Run the tests and typecheck, then commit**

```bash
npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): launch sessions with the project's MCP access" -m "Co-Authored-By: <model trailer>" -- server/src/sessions/manager.ts scripts/serverSessions.test.mjs
```

---

### Task 10: Wire MCP into the server, and the smoke test

**Files:**
- Modify: `server/src/server.ts`, `server/src/index.ts`, `server/src/v2.ts`
- Modify: `server/scripts/smoke.mjs`

- [ ] **Step 1: Wire it**

- **`server/src/server.ts`:**
  - `startServer` is synchronous today. Build an `McpAccessStore` in `<dataDir>/mcp`. `startServer`'s caller in `index.ts` knows the data dir, so pass it in through `ProjectsSetup` or a new option.
  - Pass `mcpAccess: (id) => access.accessFor(id)` to the `SessionManager`.
  - Start the listener with `startMcpListener({ access, serverVersion: daemonVersion, contextFor: (projectId) => ({ instructions: MCP_INSTRUCTIONS, tools: MCP_TOOLS, call: caller(projectId) }) })`, where `caller = createToolCaller({ store, hub, projects, poller, sessions })`.
  - The listener starts asynchronously. Until it is listening, `accessFor` returns `undefined` and sessions launch without MCP. Log a warning if the listener fails to start, and keep serving.
  - Add `mcp?: McpListener` to `TrekServer`. `shutdown` closes it.
- **`server/src/v2.ts`:** after `project.delete` succeeds, revoke the project's MCP access. Add an optional `mcpAccess?: { revoke(projectId: string): void }` to `V2Context`, and pass it from `server.ts`.
- **`server/src/index.ts`:** nothing beyond what `server.ts` exposes. `shutdown` closes the listener.

- [ ] **Step 2: Typecheck and build**

Run: `(cd server && npm run typecheck && npm run build) 2>&1 | tail -3`

- [ ] **Step 3: Smoke test**

In `server/scripts/smoke.mjs`, after the existing session sections:
1. Start a session with the existing fake agent (it prints its args). Check the pty output contains `--mcp-config` and the config file path. The fake agent echoes `$*`.
2. Read that config file. It is at `<data dir>/mcp/<projectId>.json`, and the smoke's data dir is known.
3. Using its `url` and `Authorization` header, `fetch` the endpoint:
   - `initialize` returns `serverInfo.name === 'trek-dev'`.
   - `tools/list` has `list_worktrees`.
   - `tools/call list_worktrees` returns a text result that parses to an array with one worktree.
   - A wrong token returns 401.
4. `project.delete` removes the config file, as covered by `forgetProject` plus `revoke`. Do this step only if the smoke's project flow deletes a project after this point; otherwise create and delete a throwaway project.

Run: `cd server && npm run smoke 2>&1 | tail -20`, then `npm run build && npm run smoke -- --built 2>&1 | tail -3`
Expected: `SERVER SMOKE PASS` both times.

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): serve trek-dev MCP to the server's sessions" -m "Co-Authored-By: <model trailer>" -- server/src/server.ts server/src/index.ts server/src/v2.ts server/scripts/smoke.mjs
```

---

### Task 11: Docs

**Files:**
- Modify: `PROTOCOL.md`, `server/README.md`

- [ ] **Step 1: Write**

- **`PROTOCOL.md`:**
  - Add a section **"MCP (trek-dev) on the server"** covering decisions 1–9: scope, endpoint, auth, files, which sessions get it, the tool list with the left-out tools and why, ids, readiness and waiting, and result format. List each tool with its parameters and result shape, as `src/mcp/tools.ts` defines them.
  - Add `CAPACITY` to the v2 error codes (decision 10) and update the `maxSessions` text.
  - Update the size limits (decision 11) and the v1 note (decision 12).
  - Remove "the Global role prompt arrives in phase 2e" and say it is now added.
- **`server/README.md`:** a short "MCP for agents" paragraph: loopback only, per project, config files in `<dataDir>/mcp`.

Base every statement on the shipped code.

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck && (cd server && npm run typecheck)
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs: trek-dev MCP on the server, CAPACITY and size limits" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md server/README.md
```

---

## Final verification

- [ ] `npm test` → `# fail 0`
- [ ] `npm run typecheck` and `cd server && npm run typecheck && npm run build` → clean
- [ ] `cd server && npm run smoke` and `npm run smoke -- --built` → `SERVER SMOKE PASS`

## Carry-over checklist (from 2d)

| Carry-over | Where |
|---|---|
| Unbounded session records | Decision 10, Task 2 |
| Large-terminal memory | Decision 11, Task 2 |
| Capacity error code | Decision 10, Task 2 |
| v1 limits | Decision 12 (documented) |
| Decisions cleared by input | Decision 6 (`request_decision` deferred to phase 3) |
| MCP for Global sessions | Decision 4, Task 9 |
