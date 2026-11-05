# Central server phase 2a: trek-server, repo registry and v2 handshake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `daemon/` to `server/` (`trek-server`), give the server a stable identity and named tokens, make its repo registry live (config reload, `server.addRepo` / `server.removeRepo`), and serve protocol v2's handshake plus the `server` and `attention` topics alongside v1.

**Architecture:** A `ConfigStore` owns the config file: it loads it, saves it atomically, watches it for changes made by the CLI, and emits `change`. The CLI commands and the v2 RPCs both go through it. A `TopicHub` holds each topic's snapshot and rev and sends JSON-Patch diffs (from a new shared `diffJson`) to subscribers. `server.ts` accepts `hello` with protocol 1 or 2 and routes requests to the v1 `dispatch` or the new `dispatchV2`.

**Tech Stack:** Node ≥ 20 (22.18+ for running `.ts` tests directly), TypeScript, `ws`, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections 1 ("Protocol v2") and 2.

---

## Phase 2 roadmap

Phase 2 is split into sub-plans. Each one leaves the server working and tested.

| Sub-plan | Delivers |
|---|---|
| **2a (this plan)** | Rename, `serverId`/name, named tokens, `ConfigStore` + config reload, `server.addRepo`/`server.removeRepo`, v2 handshake, `server`/`attention` topics, `TopicHub`, `diffJson` |
| 2b | `packages/core` (move `src/host` + `src/shared`), project store (one JSON file per project, atomic, migrations), `state.apply`, `project.*`, `repo.*`, `branch.*`, `project:<id>` topic, `project.import`; `ConfigStore.usage` wired to projects (also in the CLI's `remove`) |
| 2c | Git poller (refcounted by `project:<id>` subscribers) and `worktree.*` |
| 2d | Server-side sessions: `pty/` with `@xterm/headless`, `session.*`, attention heuristics, prompt queue, `attention` topic, v2 `pty.*` |
| 2e | `mcp/`: the `trek-dev` MCP server per server, tools against `state/` and `sessions/` |

## Conventions for this plan

- **Tests** live in `scripts/*.test.mjs` and run from the repo root with `npm test` (`node --test scripts/*.test.mjs`). Node runs `.ts` imports directly by stripping types, so **any module a test imports must use only erasable TypeScript** (no parameter properties, enums or namespaces) and **runtime imports must include the `.ts` extension**. Type-only imports may omit it.
- **Server typecheck:** `cd server && npm run typecheck`. **App typecheck:** `npm run typecheck` at the root.
- **Base branch:** `master`. There is no remote. Commit after every task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/` | renamed from `daemon/` | the `trek-server` package |
| `server/package.json` | modify | name `trek-server`, version `0.2.0`, bins `trek-server` + `trek-daemon` |
| `server/trek-server.service` | renamed | systemd unit |
| `server/src/config.ts` | modify | config shape, paths, legacy migration, atomic save, identity |
| `server/src/tokens.ts` | create | named tokens: hash, add/rotate, revoke, list, match |
| `server/src/errors.ts` | create | `codedError`, `toWireError` (shared by v1 and v2) |
| `server/src/configStore.ts` | create | the config file as live state; repo add/remove; watch + reload |
| `server/src/topicHub.ts` | create | per-topic snapshot + rev, subscribers, diff → patch |
| `server/src/serverState.ts` | create | builds the `server` topic snapshot and republishes on change |
| `server/src/v2.ts` | create | v2 request dispatch |
| `server/src/server.ts` | modify | v1/v2 handshake, routing, `state.patch` events, revocation |
| `server/src/rpc.ts` | modify | use `errors.ts` |
| `server/src/index.ts` | rewrite | CLI on top of `ConfigStore` and `tokens.ts` |
| `server/scripts/smoke.mjs` | modify | v2 handshake, topics, registry RPCs, live CLI reload, token revoke |
| `src/shared/sync/jsonDiff.ts` | create | structural diff producing `PatchOp[]` |
| `src/shared/protocol.ts` | modify | `NOT_A_REPO`, `IN_USE` error codes |
| `src/shared/protocolV2.ts` | modify | `server.addRepo`, `server.removeRepo` |
| `src/shared/model/topics.ts` | modify | `ServerTopic.repos` |
| `scripts/serverRepos.test.mjs` | renamed from `daemonRepos.test.mjs` | |
| `scripts/serverConfig.test.mjs`, `serverTokens.test.mjs`, `serverConfigStore.test.mjs`, `serverTopicHub.test.mjs`, `serverV2.test.mjs`, `jsonDiff.test.mjs` | create | unit tests |
| `PROTOCOL.md`, `server/README.md` | modify | docs |

---

### Task 1: Rename `daemon/` to `server/`

**Files:**
- Move: `daemon/` → `server/`, `server/trek-daemon.service` → `server/trek-server.service`, `scripts/daemonRepos.test.mjs` → `scripts/serverRepos.test.mjs`
- Modify: `server/package.json`, `server/scripts/build.mjs`, `server/scripts/smoke.mjs`, `server/src/server.ts:37`, `server/trek-server.service`, `src/renderer/src/components/ServersPanel.tsx:8,184`, `src/shared/types.ts:88`

- [ ] **Step 1: Move the directory (including untracked `node_modules`/`dist`) and the test**

```bash
mv daemon server
git add -A daemon server
git mv server/trek-daemon.service server/trek-server.service
git mv scripts/daemonRepos.test.mjs scripts/serverRepos.test.mjs
rm -rf server/dist
```

- [ ] **Step 2: Update `server/package.json`**

Replace the top of the file through `"scripts"` so it reads:

```json
{
  "name": "trek-server",
  "version": "0.2.0",
  "description": "Trek server: projects, worktrees and agent sessions for Trek Dev clients",
  "private": true,
  "bin": {
    "trek-server": "dist/trek-server.cjs",
    "trek-daemon": "dist/trek-server.cjs"
  },
```

Leave `files`, `engines`, `scripts`, `dependencies` and `devDependencies` unchanged. Then refresh the lockfile's package name:

```bash
cd server && npm install && cd ..
```

- [ ] **Step 3: Update the build output name**

In `server/scripts/build.mjs`, change the header comment's `dist/trek-daemon.cjs` to `dist/trek-server.cjs`, `daemon/node_modules` to `server/node_modules`, and:

```js
const outfile = `${root}dist/trek-server.cjs`
```

In `server/scripts/smoke.mjs`, change `'dist/trek-daemon.cjs'` to `'dist/trek-server.cjs'` and the temp prefix `'trek-daemon-smoke-'` to `'trek-server-smoke-'`.

- [ ] **Step 4: Update the systemd unit**

Replace `server/trek-server.service` with:

```ini
# systemd user unit — install with:
#   mkdir -p ~/.config/systemd/user
#   cp trek-server.service ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now trek-server
#   loginctl enable-linger $USER   # keep it (and agent sessions) running after logout
#
# Run `npm run build` in server/ first. Adjust WorkingDirectory and the
# ExecStart path to wherever you cloned the repo.
[Unit]
Description=Trek server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/Trek.Developer/server
ExecStart=/usr/bin/env node %h/Trek.Developer/server/dist/trek-server.cjs start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

- [ ] **Step 5: Update the remaining references**

- `server/src/server.ts`: `res.end('trek-daemon: WebSocket only\n')` → `res.end('trek-server: WebSocket only\n')`.
- `scripts/serverRepos.test.mjs` line 1: `// scripts/serverRepos.test.mjs — \`trek-server add\`: resolving a repo root and adding it to the config.`; line 8: import from `'../server/src/repos.ts'`; line 11: prefix `'trek-server-repos-'`.
- `server/src/repos.ts` line 9 comment: `` `trek-daemon add` `` → `` `trek-server add` ``.
- `src/renderer/src/components/ServersPanel.tsx` lines 8 and 184: `daemon/README.md` → `server/README.md`.
- `src/shared/types.ts` line 88: `(daemon/)` → `(server/)`.

Run `git grep -n "daemon/" -- ':!docs/superpowers' ':!server/package-lock.json'`. Expected: no hits outside `server/README.md`, which Task 11 rewrites.

- [ ] **Step 6: Verify**

```bash
npm test
npm run typecheck
cd server && npm run typecheck && npm run build && npm run smoke -- --built && cd ..
```

Expected: all tests pass, both typechecks are clean, the build writes `server/dist/trek-server.cjs`, and the smoke ends with `DAEMON SMOKE PASS`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename the daemon package to trek-server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config paths, legacy migration, atomic save and identity

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/tokens.ts` (type only for now; filled in Task 3)
- Test: `scripts/serverConfig.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverConfig.test.mjs`:

```js
// scripts/serverConfig.test.mjs — trek-server config: legacy migration, atomic save, identity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfigPath,
  ensureIdentity,
  legacyConfigPath,
  loadConfig,
  migrateLegacyConfig,
  saveConfig
} from '../server/src/config.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-config-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('default paths: trek-server, with trek-daemon as the legacy one', () => {
  assert.match(defaultConfigPath(), /[\\/]\.config[\\/]trek-server[\\/]config\.json$/)
  assert.match(legacyConfigPath(), /[\\/]\.config[\\/]trek-daemon[\\/]config\.json$/)
})

test('migrateLegacyConfig copies the legacy file when only it exists', (t) => {
  const dir = tempDir(t)
  const legacy = join(dir, 'trek-daemon', 'config.json')
  const target = join(dir, 'trek-server', 'config.json')
  mkdirSync(join(dir, 'trek-daemon'))
  writeFileSync(legacy, JSON.stringify({ tokenHash: 'ab', repos: [{ id: 'x', name: 'X', path: '/x' }] }))
  assert.equal(migrateLegacyConfig(target, legacy), true)
  assert.deepEqual(loadConfig(target), loadConfig(legacy))
})

test('migrateLegacyConfig leaves an existing target alone', (t) => {
  const dir = tempDir(t)
  const legacy = join(dir, 'legacy.json')
  const target = join(dir, 'target.json')
  writeFileSync(legacy, JSON.stringify({ repos: [{ id: 'old', name: 'Old', path: '/old' }] }))
  writeFileSync(target, JSON.stringify({ repos: [] }))
  assert.equal(migrateLegacyConfig(target, legacy), false)
  assert.deepEqual(loadConfig(target).repos, [])
})

test('migrateLegacyConfig does nothing without a legacy file', (t) => {
  const dir = tempDir(t)
  assert.equal(migrateLegacyConfig(join(dir, 'target.json'), join(dir, 'missing.json')), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('saveConfig writes atomically, leaves no temp file and is private', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'nested', 'config.json')
  saveConfig(path, { repos: [{ id: 'a', name: 'A', path: '/a' }] })
  saveConfig(path, { repos: [] })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { repos: [] })
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['config.json'])
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('ensureIdentity fills serverId and name once', () => {
  const config = { repos: [] }
  assert.equal(ensureIdentity(config, 'build-box'), true)
  assert.match(config.serverId, /^[0-9a-f-]{36}$/)
  assert.equal(config.name, 'build-box')
  const id = config.serverId
  assert.equal(ensureIdentity(config, 'other'), false)
  assert.equal(config.serverId, id)
  assert.equal(config.name, 'build-box')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverConfig.test.mjs`
Expected: FAIL. `legacyConfigPath`, `migrateLegacyConfig` and `ensureIdentity` are not exported, and the default path still says `trek-daemon`.

- [ ] **Step 3: Implement**

Create `server/src/tokens.ts` with the type only (Task 3 adds the functions):

```ts
// Named access tokens, one per device. Only sha256 hashes are stored.

export interface TokenEntry {
  name: string
  /** sha256 hex of the token */
  hash: string
  /** ISO timestamp; empty for a token migrated from v1's single tokenHash */
  createdAt: string
}
```

Replace `server/src/config.ts` with:

```ts
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'
import type { TokenEntry } from './tokens'

export interface DaemonConfig {
  /** Stable UUID of this server, generated on first start. */
  serverId?: string
  /** Display name shown in clients; defaults to the hostname. */
  name?: string
  /** v1's single token hash. Moved into `tokens` as "default" on start. */
  tokenHash?: string
  /** Named tokens; only sha256 hashes are stored. */
  tokens?: TokenEntry[]
  /** Repos clients may operate on. `id` is any stable slug. */
  repos: RemoteRepo[]
  /**
   * Extra directories where worktrees may be created/spawned. The parent
   * directory of each repo is always allowed (worktrees are created as
   * siblings of the repo checkout).
   */
  worktreeRoots?: string[]
  port?: number
  host?: string
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'trek-server', 'config.json')
}

/** Where trek-daemon (before the rename) kept its config. */
export function legacyConfigPath(): string {
  return join(homedir(), '.config', 'trek-daemon', 'config.json')
}

/**
 * Copies the trek-daemon config to `target` when `target` does not exist yet
 * and `legacy` does. Returns true if it copied. The legacy file is kept.
 */
export function migrateLegacyConfig(target: string, legacy: string): boolean {
  if (existsSync(target) || !existsSync(legacy)) return false
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(legacy, target)
  return true
}

export function loadConfig(path: string): DaemonConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { repos: [] }
  }
  const config = JSON.parse(raw) as DaemonConfig
  if (!Array.isArray(config.repos)) config.repos = []
  return config
}

/**
 * Write-then-rename, so a running server watching the file never reads a
 * half-written config. The file is 0600: it holds token hashes.
 */
export function saveConfig(path: string, config: DaemonConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/** Fills in `serverId` and `name` if missing. Returns true if it changed the config. */
export function ensureIdentity(config: DaemonConfig, hostname: string): boolean {
  let changed = false
  if (!config.serverId) {
    config.serverId = randomUUID()
    changed = true
  }
  if (!config.name) {
    config.name = hostname
    changed = true
  }
  return changed
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/serverConfig.test.mjs && cd server && npm run typecheck && cd ..`
Expected: PASS, and the typecheck is clean. `index.ts` still compiles because it uses `tokenHash`, which still exists.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/tokens.ts scripts/serverConfig.test.mjs
git commit -m "feat: trek-server config path, legacy migration, atomic save and server identity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Named tokens

**Files:**
- Modify: `server/src/tokens.ts`
- Test: `scripts/serverTokens.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverTokens.test.mjs`:

```js
// scripts/serverTokens.test.mjs — named tokens: add/rotate, revoke, list, match, v1 migration.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTokenHashes,
  addToken,
  formatTokenList,
  hashToken,
  listTokens,
  matchToken,
  migrateLegacyToken,
  revokeToken
} from '../server/src/tokens.ts'

test('hashToken is sha256 hex', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('addToken returns a token that matches its entry', () => {
  const config = { repos: [] }
  const token = addToken(config, 'laptop', new Date('2026-11-05T10:00:00Z'))
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(config.tokens, [
    { name: 'laptop', hash: hashToken(token), createdAt: '2026-11-05T10:00:00.000Z' }
  ])
  assert.equal(matchToken(config, token).name, 'laptop')
  assert.equal(matchToken(config, 'wrong'), undefined)
})

test('adding an existing name rotates it', () => {
  const config = { repos: [] }
  const first = addToken(config, 'phone')
  const second = addToken(config, 'phone')
  assert.equal(config.tokens.length, 1)
  assert.equal(matchToken(config, first), undefined)
  assert.equal(matchToken(config, second).name, 'phone')
})

test('tokens are independent', () => {
  const config = { repos: [] }
  const a = addToken(config, 'a')
  const b = addToken(config, 'b')
  assert.equal(matchToken(config, a).name, 'a')
  assert.equal(matchToken(config, b).name, 'b')
  assert.deepEqual(activeTokenHashes(config), new Set([hashToken(a), hashToken(b)]))
})

test('revokeToken removes only that token', () => {
  const config = { repos: [] }
  const a = addToken(config, 'a')
  const b = addToken(config, 'b')
  assert.equal(revokeToken(config, 'a'), true)
  assert.equal(revokeToken(config, 'a'), false)
  assert.equal(matchToken(config, a), undefined)
  assert.equal(matchToken(config, b).name, 'b')
})

test('invalid names are refused', () => {
  for (const name of ['', ' x', 'a b', '-x', 'x'.repeat(65)]) {
    assert.throws(() => addToken({ repos: [] }, name), /Invalid token name/)
  }
})

test("v1's tokenHash matches as \"default\" before and after migration", () => {
  const config = { tokenHash: hashToken('old'), repos: [] }
  assert.equal(matchToken(config, 'old').name, 'default')
  assert.deepEqual(listTokens(config).map((t) => t.name), ['default'])
  assert.equal(migrateLegacyToken(config), true)
  assert.equal(config.tokenHash, undefined)
  assert.deepEqual(config.tokens, [{ name: 'default', hash: hashToken('old'), createdAt: '' }])
  assert.equal(matchToken(config, 'old').name, 'default')
  assert.equal(migrateLegacyToken(config), false)
})

test('rotating "default" replaces a migrated v1 token', () => {
  const config = { tokenHash: hashToken('old'), repos: [] }
  const fresh = addToken(config, 'default')
  assert.equal(config.tokenHash, undefined)
  assert.equal(matchToken(config, 'old'), undefined)
  assert.equal(matchToken(config, fresh).name, 'default')
})

test('formatTokenList aligns names and shows unknown dates', () => {
  assert.equal(
    formatTokenList([
      { name: 'default', hash: 'x', createdAt: '' },
      { name: 'ph', hash: 'y', createdAt: '2026-11-05T10:00:00.000Z' }
    ]),
    ['NAME     CREATED', 'default  unknown', 'ph       2026-11-05T10:00:00.000Z'].join('\n')
  )
  assert.match(formatTokenList([]), /No tokens/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverTokens.test.mjs`
Expected: FAIL because the exports don't exist.

- [ ] **Step 3: Implement**

Replace `server/src/tokens.ts` with:

```ts
// Named access tokens, one per device. Only sha256 hashes are stored; the
// plaintext is shown once when created.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DaemonConfig } from './config'

export interface TokenEntry {
  name: string
  /** sha256 hex of the token */
  hash: string
  /** ISO timestamp; empty for a token migrated from v1's single tokenHash */
  createdAt: string
}

export const DEFAULT_TOKEN_NAME = 'default'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Every token the config accepts, counting an unmigrated v1 tokenHash as "default". */
export function listTokens(config: DaemonConfig): TokenEntry[] {
  const tokens = [...(config.tokens ?? [])]
  if (config.tokenHash && !tokens.some((t) => t.name === DEFAULT_TOKEN_NAME)) {
    tokens.push({ name: DEFAULT_TOKEN_NAME, hash: config.tokenHash, createdAt: '' })
  }
  return tokens
}

export function activeTokenHashes(config: DaemonConfig): Set<string> {
  return new Set(listTokens(config).map((t) => t.hash))
}

/** Moves v1's `tokenHash` into `tokens` as "default". Returns true if it changed the config. */
export function migrateLegacyToken(config: DaemonConfig): boolean {
  if (!config.tokenHash) return false
  config.tokens = listTokens(config)
  delete config.tokenHash
  return true
}

/** Creates the token `name`, replacing any token of that name. Returns the plaintext, shown once. */
export function addToken(config: DaemonConfig, name: string, now: Date = new Date()): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid token name "${name}" (letters, digits, ".", "_", "-"; up to 64)`)
  }
  migrateLegacyToken(config)
  const token = randomBytes(32).toString('base64url')
  const tokens = (config.tokens ?? []).filter((t) => t.name !== name)
  tokens.push({ name, hash: hashToken(token), createdAt: now.toISOString() })
  config.tokens = tokens
  return token
}

/** Returns true if a token of that name existed. */
export function revokeToken(config: DaemonConfig, name: string): boolean {
  migrateLegacyToken(config)
  const tokens = config.tokens ?? []
  const kept = tokens.filter((t) => t.name !== name)
  config.tokens = kept
  return kept.length !== tokens.length
}

/** The entry `token` matches, or undefined. Compares every entry in constant time. */
export function matchToken(config: DaemonConfig, token: string): TokenEntry | undefined {
  const digest = Buffer.from(hashToken(token), 'hex')
  let match: TokenEntry | undefined
  for (const entry of listTokens(config)) {
    const stored = Buffer.from(entry.hash, 'hex')
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) match ??= entry
  }
  return match
}

export function formatTokenList(tokens: TokenEntry[]): string {
  if (tokens.length === 0) return 'No tokens. Run `trek-server token add <name>`.'
  const width = Math.max(4, ...tokens.map((t) => t.name.length))
  return [
    `${'NAME'.padEnd(width)}  CREATED`,
    ...tokens.map((t) => `${t.name.padEnd(width)}  ${t.createdAt || 'unknown'}`)
  ].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/serverTokens.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tokens.ts scripts/serverTokens.test.mjs
git commit -m "feat: named access tokens for trek-server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Error codes and shared error mapping

**Files:**
- Modify: `src/shared/protocol.ts` (the `WireErrorCode` union)
- Create: `server/src/errors.ts`
- Modify: `server/src/rpc.ts` (drop the local `toWireError`)

- [ ] **Step 1: Add the error codes**

In `src/shared/protocol.ts`, extend `WireErrorCode` after `'CONFLICT'`:

```ts
  /** v2: `server.addRepo` was given a path that is not inside a git repository. */
  | 'NOT_A_REPO'
  /** v2: `server.removeRepo` on a repo that projects still use. */
  | 'IN_USE'
```

- [ ] **Step 2: Create `server/src/errors.ts`**

```ts
import type { WireError, WireErrorCode } from '../../src/shared/protocol'

/** Errors carrying one of these codes reach the client as-is. */
const PASSTHROUGH: ReadonlySet<string> = new Set<WireErrorCode>([
  'BAD_REQUEST',
  'NOT_FOUND',
  'PATH_DENIED',
  'PTY_NOT_FOUND',
  'NOT_A_REPO',
  'IN_USE',
  'CONFLICT'
])

export function codedError(code: WireErrorCode, message: string): Error {
  const err = new Error(message)
  ;(err as NodeJS.ErrnoException).code = code
  return err
}

export function toWireError(method: string, err: unknown): WireError {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && PASSTHROUGH.has(code)) {
    return { code: code as WireErrorCode, message }
  }
  return { code: method.startsWith('git.') ? 'GIT_ERROR' : 'INTERNAL', message }
}
```

- [ ] **Step 3: Use it in `rpc.ts`**

In `server/src/rpc.ts`, delete the `toWireError` function at the bottom. Change the protocol import to `import type { WireError } from '../../src/shared/protocol'` and add `import { toWireError } from './errors'`.

- [ ] **Step 4: Verify**

Run: `cd server && npm run typecheck && npm run smoke && cd .. && npm run typecheck`
Expected: clean, and `DAEMON SMOKE PASS`. The smoke still sees `PATH_DENIED`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts server/src/errors.ts server/src/rpc.ts
git commit -m "feat: NOT_A_REPO and IN_USE error codes and shared server error mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ConfigStore`: the registry as live state

**Files:**
- Create: `server/src/configStore.ts`
- Test: `scripts/serverConfigStore.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverConfigStore.test.mjs`:

```js
// scripts/serverConfigStore.test.mjs — the config file as live state: repo add/remove, reload, watch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-store-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function gitInit(path) {
  execFileSync('git', ['init', '-q', path])
  return path
}

/** dir/repos/a is registered, so dir/repos is an allowed root. dir/outside/c is not. */
function setup(t) {
  const dir = tempDir(t)
  const a = gitInit(join(dir, 'repos', 'a'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  t.after(() => store.close())
  let changes = 0
  store.on('change', () => changes++)
  return { dir, a, configPath, store, changes: () => changes }
}

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'no error'
}

test('addRepo under an allowed root saves, swaps and emits change', (t) => {
  const { dir, configPath, store, changes } = setup(t)
  const b = gitInit(join(dir, 'repos', 'b'))
  mkdirSync(join(b, 'src'))
  const { repo, added } = store.addRepo(join(b, 'src'), { requireAllowedRoot: true })
  assert.equal(added, true)
  assert.deepEqual(repo, { id: 'b', name: 'b', path: b })
  assert.deepEqual(store.config.repos.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(loadConfig(configPath).repos.map((r) => r.id), ['a', 'b'])
  assert.equal(changes(), 1)
  assert.equal(store.guard.check(b), b)
})

test('addRepo outside the allowed roots is PATH_DENIED for RPC callers, allowed for the CLI', (t) => {
  const { dir, store } = setup(t)
  const c = gitInit(join(dir, 'outside', 'c'))
  assert.equal(codeOf(() => store.addRepo(c, { requireAllowedRoot: true })), 'PATH_DENIED')
  assert.equal(store.config.repos.length, 1)
  assert.equal(store.addRepo(c, { requireAllowedRoot: false }).added, true)
})

test('a path in an allowed root whose git root is outside it is PATH_DENIED', (t) => {
  const { dir, store } = setup(t)
  // dir itself becomes a repo; dir/repos/plain is allowed but resolves up to dir.
  gitInit(dir)
  mkdirSync(join(dir, 'repos', 'plain'))
  assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'plain'), { requireAllowedRoot: true })), 'PATH_DENIED')
})

test('addRepo on a non-repo is NOT_A_REPO in both modes', (t) => {
  const { dir, store } = setup(t)
  mkdirSync(join(dir, 'repos', 'plain'))
  for (const requireAllowedRoot of [true, false]) {
    assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'plain'), { requireAllowedRoot })), 'NOT_A_REPO')
    assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'missing'), { requireAllowedRoot })), 'NOT_A_REPO')
  }
})

test('adding a registered path again changes nothing in both modes', (t) => {
  const { a, store, changes } = setup(t)
  for (const requireAllowedRoot of [true, false]) {
    const result = store.addRepo(a, { requireAllowedRoot })
    assert.equal(result.added, false)
    assert.equal(result.repo.id, 'a')
  }
  assert.equal(changes(), 0)
})

test('removeRepo by id or path; unknown is NOT_FOUND', (t) => {
  const { dir, a, store, changes } = setup(t)
  const b = gitInit(join(dir, 'repos', 'b'))
  store.addRepo(b, { requireAllowedRoot: false })
  assert.equal(store.removeRepo('b').id, 'b')
  assert.equal(store.removeRepo(a).id, 'a')
  assert.equal(store.config.repos.length, 0)
  assert.equal(codeOf(() => store.removeRepo('nope')), 'NOT_FOUND')
  assert.equal(changes(), 3)
})

test('removeRepo is IN_USE while projects use the repo', (t) => {
  const { store } = setup(t)
  store.usage = (repo) => (repo.id === 'a' ? ['Project One', 'Project Two'] : [])
  assert.throws(() => store.removeRepo('a'), (err) => {
    assert.equal(err.code, 'IN_USE')
    assert.match(err.message, /Project One, Project Two/)
    return true
  })
  assert.equal(store.config.repos.length, 1)
})

test('update applies a mutation, saves and emits; a throwing mutation changes nothing', (t) => {
  const { configPath, store, changes } = setup(t)
  store.update((c) => {
    c.name = 'box'
  })
  assert.equal(store.config.name, 'box')
  assert.equal(loadConfig(configPath).name, 'box')
  assert.throws(() =>
    store.update((c) => {
      c.name = 'other'
      throw new Error('nope')
    })
  )
  assert.equal(store.config.name, 'box')
  assert.equal(loadConfig(configPath).name, 'box')
  assert.equal(changes(), 1)
})

test('reload picks up an external change and ignores an identical file', (t) => {
  const { configPath, store, changes } = setup(t)
  assert.equal(store.reload(), false)
  const next = loadConfig(configPath)
  next.worktreeRoots = ['/tmp']
  saveConfig(configPath, next)
  assert.equal(store.reload(), true)
  assert.deepEqual(store.config.worktreeRoots, ['/tmp'])
  assert.equal(changes(), 1)
})

test('reload keeps the old config when the file is not valid JSON', (t) => {
  const { configPath, store, changes } = setup(t)
  writeFileSync(configPath, '{ not json')
  assert.equal(store.reload(), false)
  assert.equal(store.config.repos.length, 1)
  assert.equal(changes(), 0)
})

test('watch reloads when another process rewrites the file', async (t) => {
  const { dir, configPath, store } = setup(t)
  store.watch()
  const changed = new Promise((resolve) => store.once('change', resolve))
  const next = loadConfig(configPath)
  next.repos.push({ id: 'z', name: 'z', path: join(dir, 'repos', 'z') })
  saveConfig(configPath, next)
  await Promise.race([
    changed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no change event')), 3000))
  ])
  assert.deepEqual(store.config.repos.map((r) => r.id), ['a', 'z'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverConfigStore.test.mjs`
Expected: FAIL because `server/src/configStore.ts` doesn't exist.

- [ ] **Step 3: Implement**

Create `server/src/configStore.ts`:

```ts
// The server's config file as live state. The CLI and the v2 RPCs both edit
// repos through this class, so validation is the same; a running server
// watches the file, so CLI edits apply without a restart.
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'
import { loadConfig, saveConfig, type DaemonConfig } from './config.ts'
import { codedError } from './errors.ts'
import { PathGuard } from './paths.ts'
import { addRepo, removeRepo, resolveRepoRoot, type AddRepoOptions } from './repos.ts'

export interface AddRepoRequest extends AddRepoOptions {
  /**
   * RPC callers may only add repos under an already-allowed root (a registered
   * repo's parent or a worktreeRoot). The CLI runs on the box and may add anywhere.
   */
  requireAllowedRoot: boolean
}

/** Names of the projects using `repo`. Phase 2b supplies the real lookup. */
export type RepoUsage = (repo: RemoteRepo) => string[]

const RELOAD_DEBOUNCE_MS = 100

export class ConfigStore extends EventEmitter<{ change: [] }> {
  readonly path: string
  usage: RepoUsage = () => []
  private current: DaemonConfig
  private currentGuard: PathGuard
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout

  /** Throws if the file exists but is not valid JSON. */
  constructor(path: string) {
    super()
    this.path = path
    this.current = loadConfig(path)
    this.currentGuard = new PathGuard(this.current)
  }

  /** Treat as read-only; change it through update(). */
  get config(): DaemonConfig {
    return this.current
  }

  get guard(): PathGuard {
    return this.currentGuard
  }

  /** Applies `mutate` to a copy, saves it and swaps it in. If `mutate` throws, nothing changes. */
  update(mutate: (config: DaemonConfig) => void): void {
    const next = structuredClone(this.current)
    mutate(next)
    this.commit(next)
  }

  addRepo(path: string, request: AddRepoRequest): { repo: RemoteRepo; added: boolean } {
    if (request.requireAllowedRoot) this.currentGuard.check(path)
    let root: string
    try {
      root = resolveRepoRoot(path)
    } catch (err) {
      throw codedError('NOT_A_REPO', (err as Error).message)
    }
    if (request.requireAllowedRoot) this.currentGuard.check(root)
    const next = structuredClone(this.current)
    const result = addRepo(next, root, { id: request.id, name: request.name })
    if (result.added) this.commit(next)
    return result
  }

  /** By id, or by path (or a path inside the checkout). */
  removeRepo(target: string): RemoteRepo {
    const next = structuredClone(this.current)
    const removed = removeRepo(next, target)
    if (!removed) throw codedError('NOT_FOUND', `No configured repo matches "${target}"`)
    const users = this.usage(removed)
    if (users.length > 0) {
      throw codedError('IN_USE', `${removed.name} is used by: ${users.join(', ')}`)
    }
    this.commit(next)
    return removed
  }

  /** Re-reads the file. Returns true (and emits change) if it differs from what is loaded. */
  reload(): boolean {
    let next: DaemonConfig
    try {
      next = loadConfig(this.path)
    } catch (err) {
      console.warn(`[config] ignoring unreadable ${this.path}: ${(err as Error).message}`)
      return false
    }
    if (JSON.stringify(next) === JSON.stringify(this.current)) return false
    this.swap(next)
    return true
  }

  /** Watches the file's directory (atomic saves replace the file) and reloads on change. */
  watch(): void {
    if (this.watcher) return
    this.watcher = watch(dirname(this.path), (_event, file) => {
      if (file && file.toString() !== basename(this.path)) return
      clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS)
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    clearTimeout(this.reloadTimer)
  }

  private commit(next: DaemonConfig): void {
    saveConfig(this.path, next)
    this.swap(next)
  }

  private swap(next: DaemonConfig): void {
    this.current = next
    this.currentGuard = new PathGuard(next)
    this.emit('change')
  }
}
```

`paths.ts` and `repos.ts` use only type imports from other local modules, so the test can load them directly without changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/serverConfigStore.test.mjs && cd server && npm run typecheck && cd ..`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/configStore.ts scripts/serverConfigStore.test.mjs
git commit -m "feat: ConfigStore for live repo registry edits and config reload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `diffJson`

**Files:**
- Create: `src/shared/sync/jsonDiff.ts`
- Test: `scripts/jsonDiff.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/jsonDiff.test.mjs`:

```js
// scripts/jsonDiff.test.mjs — structural diff whose output applyPatch turns a into b.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deepEqual, diffJson } from '../src/shared/sync/jsonDiff.ts'
import { applyPatch } from '../src/shared/sync/jsonPatch.ts'

test('equal documents give no ops', () => {
  assert.deepEqual(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), [])
})

test('object members: add, remove, nested replace', () => {
  assert.deepEqual(diffJson({ a: 1, b: { c: 2 }, d: 0 }, { a: 1, b: { c: 3 }, e: 4 }), [
    { op: 'remove', path: '/d' },
    { op: 'replace', path: '/b/c', value: 3 },
    { op: 'add', path: '/e', value: 4 }
  ])
})

test('same-length arrays are diffed per index', () => {
  assert.deepEqual(diffJson({ xs: [{ n: 1 }, { n: 2 }] }, { xs: [{ n: 1 }, { n: 5 }] }), [
    { op: 'replace', path: '/xs/1/n', value: 5 }
  ])
})

test('arrays of different length are replaced whole', () => {
  assert.deepEqual(diffJson({ xs: [1, 2] }, { xs: [1, 2, 3] }), [
    { op: 'replace', path: '/xs', value: [1, 2, 3] }
  ])
})

test('a changed root is replaced at ""', () => {
  assert.deepEqual(diffJson(1, 2), [{ op: 'replace', path: '', value: 2 }])
  assert.deepEqual(diffJson({ a: 1 }, [1]), [{ op: 'replace', path: '', value: [1] }])
})

test('keys with undefined values count as absent', () => {
  assert.deepEqual(diffJson({ a: undefined, b: 1 }, { b: 1 }), [])
  assert.deepEqual(diffJson({ b: 1 }, { a: undefined, b: 1 }), [])
  assert.equal(deepEqual({ a: undefined }, {}), true)
})

test('keys are escaped as JSON pointers', () => {
  assert.deepEqual(diffJson({}, { 'a/b': 1, 'c~d': 2 }), [
    { op: 'add', path: '/a~1b', value: 1 },
    { op: 'add', path: '/c~0d', value: 2 }
  ])
})

test('applyPatch(a, diffJson(a, b)) equals b', () => {
  const cases = [
    [{ server: { name: 'x', health: [] }, repos: [] }, { server: { name: 'y', health: [] }, repos: [{ id: 'a' }] }],
    [{ list: [{ id: 1, tags: ['a'] }, { id: 2 }] }, { list: [{ id: 1, tags: ['b'] }, { id: 2, x: null }] }],
    [{ a: { b: { c: 1 } } }, { a: { b: {} } }],
    [{ a: null }, { a: { b: 1 } }],
    [[1, 2, 3], [3, 2, 1]]
  ]
  for (const [a, b] of cases) assert.deepEqual(applyPatch(a, diffJson(a, b)), b)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/jsonDiff.test.mjs`
Expected: FAIL because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/shared/sync/jsonDiff.ts`:

```ts
// Structural diff producing the RFC 6902 subset that jsonPatch.ts applies, so a
// server can publish a new snapshot and send subscribers only what changed.
// Objects are diffed key by key; same-length arrays index by index; anything
// else that differs is replaced whole. Keys whose value is undefined count as
// absent (JSON drops them). applyPatch(a, diffJson(a, b)) deep-equals b.
// No runtime imports beyond jsonPatch.ts.
import { formatPointer, type PatchOp } from './jsonPatch.ts'

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function definedKeys(o: Obj): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const ak = definedKeys(a)
    const bk = definedKeys(b)
    return ak.length === bk.length && ak.every((k) => b[k] !== undefined && deepEqual(a[k], b[k]))
  }
  return false
}

export function diffJson(a: unknown, b: unknown): PatchOp[] {
  const ops: PatchOp[] = []
  walk(a, b, [], ops)
  return ops
}

function walk(a: unknown, b: unknown, path: string[], ops: PatchOp[]): void {
  if (deepEqual(a, b)) return
  if (isObject(a) && isObject(b)) {
    for (const k of definedKeys(a)) {
      if (b[k] === undefined) ops.push({ op: 'remove', path: formatPointer([...path, k]) })
    }
    for (const k of definedKeys(b)) {
      if (a[k] === undefined) ops.push({ op: 'add', path: formatPointer([...path, k]), value: b[k] })
      else walk(a[k], b[k], [...path, k], ops)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], [...path, String(i)], ops)
    return
  }
  ops.push({ op: 'replace', path: formatPointer(path), value: b })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/jsonDiff.test.mjs && npm run typecheck`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/jsonDiff.ts scripts/jsonDiff.test.mjs
git commit -m "feat: structural JSON diff producing protocol v2 patch ops

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `TopicHub`

**Files:**
- Create: `server/src/topicHub.ts`
- Test: `scripts/serverTopicHub.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverTopicHub.test.mjs`:

```js
// scripts/serverTopicHub.test.mjs — server-side topics: snapshot + rev, one patch per change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TopicHub } from '../server/src/topicHub.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function recorder() {
  const sent = []
  return { sent, send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
}

test('an unpublished topic cannot be subscribed to', () => {
  assert.equal(new TopicHub().subscribe('server', recorder()), undefined)
})

test('subscribe returns the snapshot at rev 0, then patches follow', () => {
  const hub = new TopicHub()
  hub.publish('server', { name: 'a', repos: [] })
  const sub = recorder()
  let state = hub.subscribe('server', sub)
  assert.deepEqual(state, { snapshot: { name: 'a', repos: [] }, rev: 0 })

  hub.publish('server', { name: 'b', repos: [] })
  hub.publish('server', { name: 'b', repos: [{ id: 'x' }] })
  assert.deepEqual(sub.sent.map((s) => s.rev), [1, 2])
  for (const patch of sub.sent) {
    const outcome = applyStatePatch(state, patch)
    assert.equal(outcome.kind, 'applied')
    state = outcome.state
  }
  assert.deepEqual(state, { snapshot: { name: 'b', repos: [{ id: 'x' }] }, rev: 2 })
  assert.deepEqual(hub.subscribe('server', recorder()), state)
})

test('publishing an equal snapshot sends nothing and keeps the rev', () => {
  const hub = new TopicHub()
  hub.publish('attention', { entries: [] })
  const sub = recorder()
  hub.subscribe('attention', sub)
  hub.publish('attention', { entries: [] })
  assert.deepEqual(sub.sent, [])
  assert.equal(hub.subscribe('attention', recorder()).rev, 0)
})

test('every subscriber gets the patch; unsubscribed ones do not', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  const a = recorder()
  const b = recorder()
  hub.subscribe('server', a)
  hub.subscribe('server', b)
  hub.publish('server', { n: 1 })
  hub.unsubscribe('server', a)
  hub.publish('server', { n: 2 })
  assert.equal(a.sent.length, 1)
  assert.equal(b.sent.length, 2)
})

test('unsubscribeAll removes a subscriber from every topic', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  hub.publish('attention', { entries: [] })
  const sub = recorder()
  hub.subscribe('server', sub)
  hub.subscribe('attention', sub)
  hub.unsubscribeAll(sub)
  hub.publish('server', { n: 1 })
  hub.publish('attention', { entries: [1] })
  assert.deepEqual(sub.sent, [])
})

test('subscribing twice delivers once', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  const sub = recorder()
  hub.subscribe('server', sub)
  hub.subscribe('server', sub)
  hub.publish('server', { n: 1 })
  assert.equal(sub.sent.length, 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverTopicHub.test.mjs`
Expected: FAIL because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `server/src/topicHub.ts`:

```ts
// Server side of protocol v2 subscriptions. Each topic has a current snapshot
// and a rev; publishing a new snapshot bumps the rev by one and sends every
// subscriber the diff as a single patch. Snapshots are treated as immutable:
// callers build a fresh object for each publish.
import type { Topic } from '../../src/shared/model/topics'
import { diffJson } from '../../src/shared/sync/jsonDiff.ts'
import type { PatchOp } from '../../src/shared/sync/jsonPatch'

export interface Subscriber {
  send(topic: Topic, rev: number, ops: PatchOp[]): void
}

interface TopicEntry {
  snapshot: unknown
  rev: number
  subscribers: Set<Subscriber>
}

export class TopicHub {
  private topics = new Map<Topic, TopicEntry>()

  /** Sets the topic's state. The first publish starts at rev 0; an unchanged snapshot sends nothing. */
  publish(topic: Topic, snapshot: unknown): void {
    const entry = this.topics.get(topic)
    if (!entry) {
      this.topics.set(topic, { snapshot, rev: 0, subscribers: new Set() })
      return
    }
    const ops = diffJson(entry.snapshot, snapshot)
    if (ops.length === 0) return
    entry.snapshot = snapshot
    entry.rev += 1
    for (const subscriber of entry.subscribers) subscriber.send(topic, entry.rev, ops)
  }

  /** Adds the subscriber and returns the state it starts from; undefined if the topic was never published. */
  subscribe(topic: Topic, subscriber: Subscriber): { snapshot: unknown; rev: number } | undefined {
    const entry = this.topics.get(topic)
    if (!entry) return undefined
    entry.subscribers.add(subscriber)
    return { snapshot: entry.snapshot, rev: entry.rev }
  }

  unsubscribe(topic: Topic, subscriber: Subscriber): void {
    this.topics.get(topic)?.subscribers.delete(subscriber)
  }

  unsubscribeAll(subscriber: Subscriber): void {
    for (const entry of this.topics.values()) entry.subscribers.delete(subscriber)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/serverTopicHub.test.mjs && cd server && npm run typecheck && cd ..`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/topicHub.ts scripts/serverTopicHub.test.mjs
git commit -m "feat: TopicHub for server-side snapshots, revs and patches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Protocol types, the `server` topic and v2 dispatch

**Files:**
- Modify: `src/shared/model/topics.ts` (`ServerTopic`)
- Modify: `src/shared/protocolV2.ts` (`MethodParamsV2`, `MethodResultsV2`)
- Create: `server/src/serverState.ts`, `server/src/v2.ts`
- Test: `scripts/serverV2.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverV2.test.mjs`:

```js
// scripts/serverV2.test.mjs — v2 dispatch: topics, server.addRepo / server.removeRepo, errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { publishServerState } from '../server/src/serverState.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-v2-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', a])
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid-1', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const stop = publishServerState(store, hub, '0.2.0')
  t.after(() => {
    stop()
    store.close()
  })
  const sent = []
  const subscriber = { send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber })
  return { dir, a, store, sent, call }
}

test('subscribing to server returns identity, repos and no projects', async (t) => {
  const { a, call } = setup(t)
  const res = await call('sub.subscribe', { topic: 'server' })
  assert.deepEqual(res, {
    ok: true,
    result: {
      rev: 0,
      snapshot: {
        server: { serverId: 'sid-1', name: 'box', version: '0.2.0', health: [] },
        projects: [],
        repos: [{ id: 'a', name: 'a', path: a }]
      }
    }
  })
})

test('attention starts empty', async (t) => {
  const { call } = setup(t)
  const res = await call('sub.subscribe', { topic: 'attention' })
  assert.deepEqual(res.result, { snapshot: { entries: [] }, rev: 0 })
})

test('bad and unknown topics', async (t) => {
  const { call } = setup(t)
  assert.equal((await call('sub.subscribe', { topic: 'bogus' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('sub.subscribe', { topic: 'project:nope' })).error.code, 'NOT_FOUND')
})

test('server.addRepo registers the repo and patches the server topic', async (t) => {
  const { dir, call, sent } = setup(t)
  const sub = await call('sub.subscribe', { topic: 'server' })
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  assert.deepEqual(await call('server.addRepo', { path: b, name: 'Bee' }), { ok: true, result: { repoId: 'b' } })
  assert.equal(sent.length, 1)
  const outcome = applyStatePatch(sub.result, sent[0])
  assert.equal(outcome.kind, 'applied')
  assert.deepEqual(outcome.state.snapshot.repos.map((r) => r.name), ['a', 'Bee'])
})

test('server.addRepo errors: missing path, outside roots, not a repo', async (t) => {
  const { dir, call, store } = setup(t)
  assert.equal((await call('server.addRepo', {})).error.code, 'BAD_REQUEST')
  const outside = join(dir, 'outside', 'c')
  execFileSync('git', ['init', '-q', outside])
  assert.equal((await call('server.addRepo', { path: outside })).error.code, 'PATH_DENIED')
  mkdirSync(join(dir, 'repos', 'plain'))
  assert.equal((await call('server.addRepo', { path: join(dir, 'repos', 'plain') })).error.code, 'NOT_A_REPO')
  assert.equal(store.config.repos.length, 1)
})

test('server.removeRepo: unknown id, in use, then removed', async (t) => {
  const { call, store, sent } = setup(t)
  await call('sub.subscribe', { topic: 'server' })
  assert.equal((await call('server.removeRepo', { repoId: 'nope' })).error.code, 'NOT_FOUND')
  store.usage = () => ['Proj']
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).error.code, 'IN_USE')
  store.usage = () => []
  assert.deepEqual(await call('server.removeRepo', { repoId: 'a' }), { ok: true, result: null })
  assert.equal(sent.length, 1)
  assert.deepEqual(store.config.repos, [])
})

test('unsubscribe stops patches', async (t) => {
  const { dir, call, sent } = setup(t)
  await call('sub.subscribe', { topic: 'server' })
  await call('sub.unsubscribe', { topic: 'server' })
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  assert.deepEqual(sent, [])
})

test('project.list is empty, ping echoes, unknown methods are NOT_FOUND', async (t) => {
  const { call } = setup(t)
  assert.deepEqual(await call('project.list', {}), { ok: true, result: [] })
  assert.deepEqual(await call('sys.ping', { t: 5 }), { ok: true, result: { t: 5 } })
  assert.equal((await call('git.listWorktrees', {})).error.code, 'NOT_FOUND')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverV2.test.mjs`
Expected: FAIL because `serverState.ts` and `v2.ts` don't exist.

- [ ] **Step 3: Extend the protocol types**

In `src/shared/model/topics.ts`, add `import type { RemoteRepo } from '../protocol.ts'` and change `ServerTopic` to:

```ts
/** `server`: who the server is, its health, its projects and its repo registry. */
export interface ServerTopic {
  server: ServerInfo
  projects: ProjectSummary[]
  /** Repos registered with `trek-server add` or `server.addRepo`; projects use only these */
  repos: RemoteRepo[]
}
```

In `src/shared/protocolV2.ts`, add to `MethodParamsV2` before `// Subscriptions`:

```ts
  // Server repo registry
  /** Registers the git repo containing `path`; it must be under an allowed root */
  'server.addRepo': { path: string; name?: string }
  /** Fails with IN_USE while a project uses the repo */
  'server.removeRepo': { repoId: string }
```

and to `MethodResultsV2` before `'sub.subscribe'`:

```ts
  /** The id of the new repo, or of the existing one if the path was already registered */
  'server.addRepo': { repoId: string }
  'server.removeRepo': null
```

- [ ] **Step 4: Create `server/src/serverState.ts`**

```ts
// Builds the `server` topic from the config and republishes it whenever the
// config changes (RPC edits, or CLI edits picked up by the file watch).
import type { AttentionTopic, ServerTopic } from '../../src/shared/model/topics'
import type { DaemonConfig } from './config'
import type { ConfigStore } from './configStore'
import type { TopicHub } from './topicHub'

export function serverTopic(config: DaemonConfig, version: string): ServerTopic {
  return {
    server: { serverId: config.serverId ?? '', name: config.name ?? '', version, health: [] },
    // Phase 2b fills this from the project store.
    projects: [],
    repos: config.repos.map(({ id, name, path }) => ({ id, name, path }))
  }
}

/** Publishes `server` and `attention` now and keeps `server` current. Returns a stop function. */
export function publishServerState(store: ConfigStore, hub: TopicHub, version: string): () => void {
  hub.publish('server', serverTopic(store.config, version))
  // Phase 2d computes attention from sessions.
  const attention: AttentionTopic = { entries: [] }
  hub.publish('attention', attention)
  const onChange = (): void => hub.publish('server', serverTopic(store.config, version))
  store.on('change', onChange)
  return () => store.off('change', onChange)
}
```

- [ ] **Step 5: Create `server/src/v2.ts`**

```ts
// Protocol v2 request dispatch. Phase 2a serves the handshake topics and the
// repo registry; later sub-plans add the rest of MethodParamsV2.
import { parseTopic } from '../../src/shared/model/topics.ts'
import type { WireError } from '../../src/shared/protocol'
import type { ConfigStore } from './configStore'
import { codedError, toWireError } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'

export interface V2Context {
  store: ConfigStore
  hub: TopicHub
  /** This connection, as a topic subscriber */
  subscriber: Subscriber
}

type Handler = (params: any, ctx: V2Context) => unknown

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw codedError('BAD_REQUEST', `${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string`)
  return value
}

const handlers: Record<string, Handler> = {
  'sys.ping': (p) => ({ t: p.t }),

  'project.list': () => [],

  'sub.subscribe': (p, ctx) => {
    if (!parseTopic(p.topic)) throw codedError('BAD_REQUEST', `Unknown topic: ${String(p.topic)}`)
    const state = ctx.hub.subscribe(p.topic, ctx.subscriber)
    if (!state) throw codedError('NOT_FOUND', `No such topic: ${p.topic}`)
    return state
  },

  'sub.unsubscribe': (p, ctx) => {
    ctx.hub.unsubscribe(p.topic, ctx.subscriber)
    return null
  },

  'server.addRepo': (p, ctx) => {
    const path = requireString(p.path, 'path')
    const name = optionalString(p.name, 'name')
    const { repo } = ctx.store.addRepo(path, { name, requireAllowedRoot: true })
    return { repoId: repo.id }
  },

  'server.removeRepo': (p, ctx) => {
    const repoId = requireString(p.repoId, 'repoId')
    // By id only: the CLI's path fallback is not offered over the wire.
    if (!ctx.store.config.repos.some((r) => r.id === repoId)) {
      throw codedError('NOT_FOUND', `No repo with id "${repoId}"`)
    }
    ctx.store.removeRepo(repoId)
    return null
  }
}

export async function dispatchV2(
  method: string,
  params: unknown,
  ctx: V2Context
): Promise<{ ok: true; result: unknown } | { ok: false; error: WireError }> {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
  if (!handler) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method: ${method}` } }
  }
  try {
    return { ok: true, result: await handler(params ?? {}, ctx) }
  } catch (err) {
    return { ok: false, error: toWireError(method, err) }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/serverV2.test.mjs && npm test && npm run typecheck && cd server && npm run typecheck && cd ..`
Expected: everything passes and both typechecks are clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/model/topics.ts src/shared/protocolV2.ts server/src/serverState.ts server/src/v2.ts scripts/serverV2.test.mjs
git commit -m "feat: v2 dispatch with the server topic and server.addRepo/removeRepo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Transport: v1 + v2 handshake, patches and token revocation

**Files:**
- Modify: `server/src/server.ts` (replace the whole file)

- [ ] **Step 1: Replace `server/src/server.ts`**

```ts
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame
} from '../../src/shared/protocol'
import {
  PROTOCOL_VERSION_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ServerFrameV2
} from '../../src/shared/protocolV2'
import type { ConfigStore } from './configStore'
import { PtyRegistry } from './ptyRegistry'
import { dispatch } from './rpc'
import { publishServerState } from './serverState'
import { activeTokenHashes, matchToken } from './tokens'
import { TopicHub, type Subscriber } from './topicHub'
import { dispatchV2 } from './v2'

const HELLO_TIMEOUT_MS = 5000
const BAD_TOKEN_CLOSE_DELAY_MS = 500
const HEARTBEAT_INTERVAL_MS = 15_000

export interface DaemonServer {
  httpServer: Server
  ptys: PtyRegistry
  hub: TopicHub
  shutdown(reason: string): void
}

export function startServer(store: ConfigStore, daemonVersion: string): DaemonServer {
  const ptys = new PtyRegistry({
    send(ws, event, payload) {
      sendFrame(ws, { type: 'event', event, payload })
    }
  })
  const hub = new TopicHub()
  const stopPublishing = publishServerState(store, hub, daemonVersion)

  /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
  const authed = new Map<WebSocket, string>()
  const onConfigChange = (): void => {
    const active = activeTokenHashes(store.config)
    for (const [ws, hash] of authed) {
      if (active.has(hash)) continue
      console.warn('[auth] token revoked; closing its connection')
      authed.delete(ws)
      ws.close(CLOSE_UNAUTHORIZED, 'token revoked')
    }
  }
  store.on('change', onConfigChange)

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('trek-server: WebSocket only\n')
  })
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    /** Set once hello is accepted. */
    let protocolVersion: number | undefined
    let missedPongs = 0
    const subscriber: Subscriber = {
      send(topic, rev, ops) {
        sendFrame(ws, { type: 'event', event: 'state.patch', payload: { topic, rev, ops } })
      }
    }

    const headerToken = bearerToken(req.headers.authorization)

    const helloTimer = setTimeout(() => {
      if (protocolVersion === undefined) ws.close(CLOSE_HELLO_TIMEOUT, 'no hello')
    }, HELLO_TIMEOUT_MS)

    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      missedPongs += 1
      if (missedPongs > 2) {
        ws.terminate()
        return
      }
      ws.ping()
    }, HEARTBEAT_INTERVAL_MS)
    ws.on('pong', () => {
      missedPongs = 0
    })

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text frames only')
        return
      }
      let frame: ClientFrame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        ws.close(1002, 'invalid JSON')
        return
      }

      if (protocolVersion === undefined) {
        if (frame.type !== 'hello') {
          ws.close(CLOSE_HELLO_TIMEOUT, 'hello first')
          return
        }
        clearTimeout(helloTimer)
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(frame.protocolVersion)) {
          ws.close(CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version')
          return
        }
        const token = frame.token ?? headerToken
        const entry = token ? matchToken(store.config, token) : undefined
        if (!entry) {
          console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
          setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), BAD_TOKEN_CLOSE_DELAY_MS)
          return
        }
        protocolVersion = frame.protocolVersion
        authed.set(ws, entry.hash)
        console.log(
          `[auth] ${frame.client}/${frame.clientVersion} (token "${entry.name}", protocol ${protocolVersion}) ` +
            `connected from ${req.socket.remoteAddress}`
        )
        if (protocolVersion === PROTOCOL_VERSION_V2) {
          sendFrame(ws, {
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION_V2,
            daemonVersion,
            serverId: store.config.serverId ?? '',
            serverName: store.config.name ?? '',
            capabilities: []
          })
        } else {
          sendFrame(ws, {
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion,
            repos: store.config.repos
          })
        }
        return
      }

      if (frame.type !== 'req') return
      const outcome =
        protocolVersion === PROTOCOL_VERSION_V2
          ? await dispatchV2(frame.method, frame.params, { store, hub, subscriber })
          : await dispatch(frame.method, frame.params, {
              config: store.config,
              guard: store.guard,
              ptys,
              ws
            })
      if (outcome.ok) {
        sendFrame(ws, { type: 'res', id: frame.id, ok: true, result: outcome.result })
      } else {
        sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: outcome.error })
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      clearInterval(heartbeat)
      authed.delete(ws)
      hub.unsubscribeAll(subscriber)
      // PTYs keep running — the client reattaches on its next connection.
      ptys.detachAll(ws)
    })
  })

  const shutdown = (reason: string): void => {
    store.off('change', onConfigChange)
    stopPublishing()
    for (const ws of wss.clients) {
      sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
      ws.close(1001, 'server shutting down')
    }
    ptys.disposeAll()
    wss.close()
    httpServer.close()
  }

  return { httpServer, ptys, hub, shutdown }
}

function sendFrame(ws: WebSocket, frame: ServerFrame | ServerFrameV2): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}
```

`hashToken` used to be exported from this file. It now lives in `tokens.ts`, and Task 10 updates the only importer, `index.ts`. Because v1 reads `store.config` and `store.guard` per request, CLI edits reach v1 clients' path guard straight away.

- [ ] **Step 2: Typecheck (expected to fail only in index.ts)**

Run: `cd server && npm run typecheck; cd ..`
Expected: errors only in `src/index.ts` (it imports `hashToken` from `./server` and passes a `DaemonConfig` to `startServer`). Task 10 fixes them. Don't commit yet; Tasks 9 and 10 are committed together.

---

### Task 10: The CLI on `ConfigStore` and tokens

**Files:**
- Modify: `server/src/index.ts` (replace the whole file)

- [ ] **Step 1: Replace `server/src/index.ts`**

```ts
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { hostname } from 'node:os'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig } from './config'
import { ConfigStore } from './configStore'
import { formatRepoList } from './repos'
import { startServer } from './server'
import {
  addToken,
  DEFAULT_TOKEN_NAME,
  formatTokenList,
  listTokens,
  migrateLegacyToken,
  revokeToken
} from './tokens'

const COMMANDS = ['start', 'token', 'add', 'list', 'remove', 'help', 'version'] as const
const TOKEN_ACTIONS = ['add', 'list', 'revoke'] as const

interface CliArgs {
  command: (typeof COMMANDS)[number]
  configPath: string
  /** --config was given, so the legacy trek-daemon config is not migrated */
  configExplicit: boolean
  /** `add`: the repo path. `remove`: an id or path. Both default to the current directory. */
  repoPath?: string
  repoId?: string
  repoName?: string
  /** `token <action>`; none means rotate "default" */
  tokenAction?: (typeof TOKEN_ACTIONS)[number]
  tokenName?: string
  port?: number
  host?: string
  insecure: boolean
}

const USAGE = `Usage: trek-server [command] [options]
       trek-server <path>           Same as \`trek-server add <path>\`

Commands:
  start                Run the server (default)
  add [path]           Add the git repo at path (default: current directory)
  list                 List the configured repos
  remove [id|path]     Remove a repo by id or path (default: current directory)
  token                Create or rotate the token named "${DEFAULT_TOKEN_NAME}"
  token add <name>     Create or rotate a named token (one per device)
  token list           List tokens
  token revoke <name>  Revoke a token; a running server closes its connections
  help                 Show this help
  version              Print the server version

Options:
  --config <path>  Config file (default: ${defaultConfigPath()})
  --port <port>    Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
  --host <host>    Interface to bind (default: config.host or 127.0.0.1)
  --insecure       Allow binding a non-loopback host without TLS
  --id <id>        add: repo id (default: slug of the directory name)
  --name <name>    add: display name (default: the directory name)
  -h, --help       Show this help
  -v, --version    Print the server version

A running server picks up repo and token changes without a restart.
`

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'start',
    configPath: defaultConfigPath(),
    configExplicit: false,
    insecure: false
  }
  const value = (i: number, flag: string): string => {
    const next = argv[i]
    if (next === undefined || next.startsWith('-')) usageError(`${flag} needs a value`)
    return next
  }
  let sawCommand = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const positional = !arg.startsWith('-')
    if (!sawCommand && (COMMANDS as readonly string[]).includes(arg)) {
      args.command = arg as CliArgs['command']
      sawCommand = true
    } else if (positional && args.command === 'token' && args.tokenAction === undefined) {
      if (!(TOKEN_ACTIONS as readonly string[]).includes(arg)) usageError(`Unknown token action: ${arg}`)
      args.tokenAction = arg as CliArgs['tokenAction']
    } else if (
      positional &&
      args.command === 'token' &&
      (args.tokenAction === 'add' || args.tokenAction === 'revoke') &&
      args.tokenName === undefined
    ) {
      args.tokenName = arg
    } else if (
      positional &&
      (args.command === 'add' || args.command === 'remove') &&
      args.repoPath === undefined
    ) {
      args.repoPath = arg
    } else if (positional && !sawCommand && isDirectory(arg)) {
      // `trek-server .` / `trek-server ~/repos/x` — shorthand for add.
      args.command = 'add'
      args.repoPath = arg
      sawCommand = true
    } else if (arg === '--id') args.repoId = value(++i, arg)
    else if (arg === '--name') args.repoName = value(++i, arg)
    else if (arg === '-h' || arg === '--help') args.command = 'help'
    else if (arg === '-v' || arg === '--version') args.command = 'version'
    else if (arg === '--config') {
      args.configPath = value(++i, arg)
      args.configExplicit = true
    } else if (arg === '--port') {
      const port = Number(value(++i, arg))
      if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`Invalid port: ${argv[i]}`)
      args.port = port
    } else if (arg === '--host') args.host = value(++i, arg)
    else if (arg === '--insecure') args.insecure = true
    else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
    else usageError(`Unknown argument: ${arg}`)
  }
  if ((args.repoId !== undefined || args.repoName !== undefined) && args.command !== 'add') {
    usageError('--id and --name only apply to `add`')
  }
  if ((args.tokenAction === 'add' || args.tokenAction === 'revoke') && args.tokenName === undefined) {
    usageError(`\`token ${args.tokenAction}\` needs a name`)
  }
  return args
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (basename(process.argv[1] ?? '').startsWith('trek-daemon')) {
  console.error('Note: trek-daemon is now trek-server; the old name will be removed in a later release.')
}

const args = parseArgs(process.argv.slice(2))

if (args.command === 'help') {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.command === 'version') {
  console.log(serverVersion())
  process.exit(0)
}

if (!args.configExplicit && migrateLegacyConfig(args.configPath, legacyConfigPath())) {
  console.error(`Copied ${legacyConfigPath()} to ${args.configPath}.`)
}

let store: ConfigStore
try {
  store = new ConfigStore(args.configPath)
} catch (err) {
  fail(`Cannot read ${args.configPath}: ${(err as Error).message}`)
}

if (args.command === 'add') {
  try {
    const { repo, added } = store.addRepo(args.repoPath ?? process.cwd(), {
      id: args.repoId,
      name: args.repoName,
      requireAllowedRoot: false
    })
    if (!added) {
      console.log(`${repo.path} is already configured as "${repo.id}".`)
      process.exit(0)
    }
    console.log(`Added ${repo.name} (id "${repo.id}") at ${repo.path}`)
    console.log(`Saved to ${args.configPath}. A running server picks it up automatically.`)
    process.exit(0)
  } catch (err) {
    fail((err as Error).message)
  }
}

if (args.command === 'list') {
  console.log(formatRepoList(store.config.repos))
  process.exit(0)
}

if (args.command === 'remove') {
  const target = args.repoPath ?? process.cwd()
  try {
    const removed = store.removeRepo(target)
    console.log(`Removed ${removed.name} (id "${removed.id}") at ${removed.path}`)
    console.log('The repo itself is untouched. A running server picks this up automatically.')
    process.exit(0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'NOT_FOUND') {
      fail(`No configured repo matches "${target}". Run \`trek-server list\` to see them.`)
    }
    fail((err as Error).message)
  }
}

if (args.command === 'token') {
  if (args.tokenAction === 'list') {
    console.log(formatTokenList(listTokens(store.config)))
    process.exit(0)
  }
  if (args.tokenAction === 'revoke') {
    const name = args.tokenName!
    if (!listTokens(store.config).some((t) => t.name === name)) {
      fail(`No token named "${name}". Run \`trek-server token list\` to see them.`)
    }
    store.update((c) => {
      revokeToken(c, name)
    })
    console.log(`Revoked "${name}". A running server closes its connections.`)
    process.exit(0)
  }
  const name = args.tokenAction === 'add' ? args.tokenName! : DEFAULT_TOKEN_NAME
  let token = ''
  try {
    store.update((c) => {
      token = addToken(c, name)
    })
  } catch (err) {
    fail((err as Error).message)
  }
  console.log(`New token "${name}" (shown once — configure it in the app now):\n`)
  console.log(`  ${token}\n`)
  console.log(`Its hash was saved to ${args.configPath}; any previous "${name}" token is now invalid.`)
  process.exit(0)
}

// start
const config = store.config
if (!config.serverId || !config.name || config.tokenHash) {
  store.update((c) => {
    ensureIdentity(c, hostname())
    migrateLegacyToken(c)
  })
}
if (listTokens(store.config).length === 0) {
  fail(`No token configured. Run \`trek-server token\` first (config: ${args.configPath}).`)
}
if (store.config.repos.length === 0) {
  fail(`No repos configured. Run \`trek-server add <path>\` (config: ${args.configPath}).`)
}
const host = args.host ?? store.config.host ?? '127.0.0.1'
const port = args.port ?? store.config.port ?? DEFAULT_DAEMON_PORT
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !args.insecure) {
  fail(
    `Refusing to bind ${host} without TLS. Put a TLS-terminating reverse proxy (Caddy) in front\n` +
      'of the loopback listener, or pass --insecure if you really know what you are doing.'
  )
}

const server = startServer(store, serverVersion())
store.watch()
server.httpServer.listen(port, host, () => {
  console.log(
    `trek-server ${serverVersion()} "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${port}`
  )
  console.log(`repos: ${store.config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down (all agent sessions will end)`)
    store.close()
    server.shutdown(signal)
    process.exit(0)
  })
}
```

The smoke test waits for the word `listening`, and the startup line still contains it.

- [ ] **Step 2: Typecheck and run the existing smoke test**

Run: `cd server && npm run typecheck && npm run smoke && cd ..`
Expected: clean, then `DAEMON SMOKE PASS`. The smoke's legacy `tokenHash` config still authenticates and is migrated on start.

- [ ] **Step 3: Try the CLI by hand**

```bash
cd server
C=$(mktemp -d)/config.json
npx tsx src/index.ts --config "$C" add ..          # Added trek-developer ... picks it up automatically
npx tsx src/index.ts --config "$C" token add phone # prints a token
npx tsx src/index.ts --config "$C" token list      # NAME / CREATED with phone
npx tsx src/index.ts --config "$C" token revoke phone
npx tsx src/index.ts --config "$C" token revoke phone   # exits 1: No token named "phone"
npx tsx src/index.ts --config "$C" token bogus          # exits 2: Unknown token action
cd ..
```

Expected: each command prints what its comment says.

- [ ] **Step 4: Commit Tasks 9 and 10**

```bash
git add server/src/server.ts server/src/index.ts
git commit -m "feat: trek-server serves protocol v1 and v2, reloads its config and revokes tokens live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Smoke coverage for v2, live reload and revocation

**Files:**
- Modify: `server/scripts/smoke.mjs`

- [ ] **Step 1: Share the command used to run the CLI**

In `server/scripts/smoke.mjs`, change the `node:fs` import to `import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'`, add `import { applyStatePatch } from '../../src/shared/sync/topicState.ts'` after the `ws` import, then replace the `daemonArgs` / `[cmd, cmdArgs]` block with:

```js
// `--built` runs the bundled CLI (npm run build) instead of the TypeScript source.
const [cmd, cmdPrefix] = process.argv.includes('--built')
  ? [process.execPath, ['dist/trek-server.cjs']]
  : ['npx', ['tsx', 'src/index.ts']]
const serverDir = new URL('..', import.meta.url).pathname
const cli = (...args) =>
  execFileSync(cmd, [...cmdPrefix, ...args, '--config', configPath], { cwd: serverDir, encoding: 'utf8' })
const daemon = spawn(cmd, [...cmdPrefix, 'start', '--config', configPath, '--port', String(PORT)], {
  cwd: serverDir,
  stdio: ['ignore', 'pipe', 'inherit']
})
```

Delete the old `const daemon = spawn(...)` call that followed.

- [ ] **Step 2: Add the v2 section**

Insert this block just before the `// --- bad token rejected ---` comment:

```js
// --- protocol v2 ---
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s'
}
const mkRepo = (path) => { execFileSync('git', ['init', '-q', '-b', 'main', path], { env: gitEnv }); return path }

/** A connection that records frames; `req` resolves with the res frame. */
async function connect(protocolVersion, tok) {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const frames = []
  const waiting = new Map()
  let id = 1
  sock.on('message', (raw) => {
    const f = JSON.parse(raw.toString())
    frames.push(f)
    if (f.type === 'res') { waiting.get(f.id)?.(f); waiting.delete(f.id) }
  })
  await new Promise((r) => sock.on('open', r))
  sock.send(JSON.stringify({ type: 'hello', protocolVersion, token: tok, client: 'smoke-v2', clientVersion: '0' }))
  const closed = new Promise((r) => sock.on('close', (code) => r(code)))
  await new Promise((r) => setTimeout(r, 300))
  return {
    sock, frames, closed,
    welcome: frames.find((f) => f.type === 'welcome'),
    req: (method, params) => new Promise((resolve, reject) => {
      const n = id++
      waiting.set(n, resolve)
      sock.send(JSON.stringify({ type: 'req', id: n, method, params }))
      setTimeout(() => { if (waiting.has(n)) reject(new Error(`timeout: ${method}`)) }, 10000)
    })
  }
}

/** Waits for the next state.patch on `topic` past `state.rev` and applies it. */
async function nextPatch(conn, topic, state, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const patch = conn.frames.find((f) => f.type === 'event' && f.event === 'state.patch' &&
      f.payload.topic === topic && f.payload.rev === state.rev + 1)
    if (patch) {
      const outcome = applyStatePatch(state, patch.payload)
      if (outcome.kind !== 'applied') throw new Error(`patch did not apply: ${outcome.kind}`)
      return outcome.state
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no patch for ${topic} after rev ${state.rev}`)
}

const v2 = await connect(2, token)
if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
  fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
} else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}`)

const subbed = await v2.req('sub.subscribe', { topic: 'server' })
let serverState = subbed.result
if (!subbed.ok || serverState.snapshot.repos.length !== 1 || serverState.snapshot.repos[0].path !== repo) {
  fail(`subscribe server: ${JSON.stringify(subbed)}`)
} else ok('subscribe server: snapshot lists the configured repo')

const repo2 = mkRepo(join(work, 'repo2'))
const added = await v2.req('server.addRepo', { path: repo2 })
if (!added.ok || added.result.repoId !== 'repo2') fail(`server.addRepo: ${JSON.stringify(added)}`)
serverState = await nextPatch(v2, 'server', serverState)
if (serverState.snapshot.repos.length !== 2) fail(`after addRepo: ${JSON.stringify(serverState.snapshot.repos)}`)
else ok('server.addRepo: registered and patched')

const outside = mkRepo(mkdtempSync(join(tmpdir(), 'trek-server-outside-')))
const deniedAdd = await v2.req('server.addRepo', { path: outside })
rmSync(outside, { recursive: true, force: true })
if (deniedAdd.ok || deniedAdd.error.code !== 'PATH_DENIED') fail(`addRepo outside: ${JSON.stringify(deniedAdd)}`)
else ok('server.addRepo: PATH_DENIED outside the allowed roots')

mkdirSync(join(work, 'plain'))
const notRepo = await v2.req('server.addRepo', { path: join(work, 'plain') })
if (notRepo.ok || notRepo.error.code !== 'NOT_A_REPO') fail(`addRepo plain dir: ${JSON.stringify(notRepo)}`)
else ok('server.addRepo: NOT_A_REPO for a plain directory')

const repo3 = mkRepo(join(work, 'repo3'))
cli('add', repo3)
serverState = await nextPatch(v2, 'server', serverState)
if (!serverState.snapshot.repos.some((r) => r.path === repo3)) fail('CLI add not picked up')
else ok('CLI add on a running server: picked up without a restart')

const removed = await v2.req('server.removeRepo', { repoId: 'repo2' })
if (!removed.ok) fail(`server.removeRepo: ${JSON.stringify(removed)}`)
serverState = await nextPatch(v2, 'server', serverState)
if (serverState.snapshot.repos.some((r) => r.id === 'repo2')) fail('removeRepo not reflected')
else ok('server.removeRepo: removed and patched')

const phoneToken = /^ {2}(\S+)$/m.exec(cli('token', 'add', 'phone'))?.[1]
const phone = await connect(2, phoneToken)
if (phone.welcome?.protocolVersion !== 2) fail(`named token login: ${JSON.stringify(phone.frames)}`)
else ok('named token "phone" authenticates')
cli('token', 'revoke', 'phone')
const revokedCode = await Promise.race([phone.closed, new Promise((r) => setTimeout(() => r('open'), 4000))])
if (revokedCode !== 4003) fail(`revoked token connection: ${revokedCode}`)
else ok('token revoke closes its live connection with 4003')

v2.sock.close()
```

- [ ] **Step 3: Run the smoke test both ways**

```bash
cd server && npm run smoke && npm run build && npm run smoke -- --built && cd ..
```

Expected: every `ok:` line prints, with no `FAIL:`, ending in `DAEMON SMOKE PASS` for both runs.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/smoke.mjs
git commit -m "test: smoke-test v2 handshake, registry RPCs, live CLI reload and token revoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation

**Files:**
- Modify: `PROTOCOL.md` (v2 section), `server/README.md`

- [ ] **Step 1: `PROTOCOL.md`**

In the v2 "Subscriptions" table, change the `server` row to:

```
| `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}], repos: [{id, name, path}]}` |
```

In the v2 "Commands" table, add a row before `Subscriptions`:

```
| Server repo registry | `server.addRepo`, `server.removeRepo` |
```

After the `project.import` paragraph, add:

```markdown
`server.addRepo {path, name?}` registers the git repository containing `path`
and returns `{repoId}`. Both `path` and the repository's top level must be under
an allowed root (a registered repo's parent directory or a `worktreeRoots`
entry); otherwise it fails with `PATH_DENIED`. A path that is not in a git
repository fails with `NOT_A_REPO`. A path that is already registered returns
the existing id. `server.removeRepo {repoId}` fails with `NOT_FOUND` for an
unknown id and with `IN_USE` while a project uses the repo. Both change the
server's config file and patch the `server` topic. Edits made with the
`trek-server` CLI on the server reach subscribers the same way, without a
restart.

Tokens are named, one per device (`trek-server token add <name>`). Revoking a
token closes its open connections with `4003`.
```

Add `NOT_A_REPO` and `IN_USE` wherever the v2 section lists error codes, next to `CONFLICT`. Run `grep -n CONFLICT PROTOCOL.md` to find the spots.

- [ ] **Step 2: `server/README.md`**

Make these changes throughout:
- Title: `# trek-server`. Intro: "The Trek server: run git worktrees and agent sessions on a machine and connect to it from the desktop app (and, later, the mobile app). Formerly `trek-daemon`; that command still works for one release and prints a notice."
- `cd daemon` → `cd server`; `dist/trek-daemon.cjs` → `dist/trek-server.cjs`; every `trek-daemon <cmd>` → `trek-server <cmd>`; `trek-daemon.service` → `trek-server.service`; `~/.config/trek-daemon/config.json` → `~/.config/trek-server/config.json`.
- Add under Install: "Upgrading from `trek-daemon`: run `npm link` again in `server/`. On first start, `~/.config/trek-daemon/config.json` is copied to `~/.config/trek-server/config.json` (unless that already exists); your token keeps working as the token named `default`."
- In Configure, replace "A running daemon only reads its config at startup, so restart it afterwards." with "A running server notices the change and picks it up; no restart needed." Remove "Restart a running daemon" wherever else it appears.
- Replace the token paragraph with:

````markdown
Create a token for each device that will connect (each prints once; only its
sha256 hash is stored):

```sh
trek-server token add laptop
trek-server token add phone
trek-server token list
trek-server token revoke phone     # closes that device's open connections
```

`trek-server token` on its own creates or rotates the token named `default`.
Paste a token into the app under Settings → Servers.
````

- Add to the end of the config JSON paragraph: "The file also holds `serverId` (generated on first start; clients key their cache by it) and `name` (defaults to the hostname; shown in clients)."

- [ ] **Step 3: Check for stale names**

Run: `git grep -n "trek-daemon" -- ':!docs/superpowers' ':!server/package-lock.json'`
Expected hits, all intentional: the `trek-daemon` alias bin in `server/package.json`, `legacyConfigPath` and the rename notice in `server/src/config.ts` and `server/src/index.ts`, and the "Formerly"/"Upgrading" lines in `server/README.md`.

- [ ] **Step 4: Full verification**

```bash
npm test
npm run typecheck
cd server && npm run typecheck && npm run build && npm run smoke -- --built && cd ..
```

Expected: all pass, ending in `DAEMON SMOKE PASS`.

- [ ] **Step 5: Commit**

```bash
git add PROTOCOL.md server/README.md
git commit -m "docs: trek-server rename, named tokens and the v2 repo registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Not in this plan (by design)

- `project.*`, `repo.*`, `branch.*`, `worktree.*`, `session.*` and the `project:<id>` topic come in 2b–2d. Until then `dispatchV2` answers them with `NOT_FOUND`.
- Moving `src/host` + `src/shared` into `packages/core` is in 2b. The server keeps importing `../../src/...` until then.
- Under v2, `server.removeRepo` returns `IN_USE` only once 2b sets `ConfigStore.usage`. The CLI's `remove` gets the same check in 2b, when it can read the project store.
