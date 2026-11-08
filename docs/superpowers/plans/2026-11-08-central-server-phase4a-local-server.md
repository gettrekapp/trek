# Central server phase 4a: the server's `--local` mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `trek-server` the mode the phase 4b supervisor will run: `trek-server start --local` (or `trek-server --local`), the app's own server on this machine.
1. **Its own profile.** The config is `~/.config/trek-server/local/config.json`. Projects and MCP files go in `<platform data dir>/local`. A pid lock, `local.lock`, makes sure it never clashes with a hand-run `trek-server start`, or with a second `--local`.
2. **Loopback on a random port**, with **a token generated at start**. Only its hash is saved, under the name `local`.
3. **`local.json`** (`{port, pid, token, version, build}`, 0600, written atomically). It is written once the server listens and MCP has settled, and removed on SIGTERM, SIGINT and exit.
4. **The lock.** A second `--local` start exits with code 3 while the holder lives. A dead holder's lock is taken over.
5. **A permissive path guard, in `--local` only.** `server.addRepo` takes any repo the user picks, and `project.import` takes any worktree path. Remote servers are unchanged, and tests prove it.
6. **A `local` welcome capability.**
7. **A bundle the app can run.** The version and a build id are baked in, and `ws` is bundled. The bundle runs from a bare `out/server` with only `node-pty` beside it, under Node and under Electron's Node (`ELECTRON_RUN_AS_NODE=1`).
8. **`smoke:local`** proves all of this against the built bundle, both runtimes, including a session on a fake agent that resumes with `--resume` after a SIGTERM.

**Architecture:**
- **One shared contract, `src/shared/localServer.ts`.** It holds the profile's path segments, the file names, the token name, the "already running" exit code, `LocalInfo` and `parseLocalInfo`. The server uses it now. Main's 4b supervisor will read `local.json` with the same parser. It imports nothing (no `node:path`), so it is safe anywhere under `src/shared`.
- **Two small server modules.**
  - `server/src/localProfile.ts`: the profile's paths, plus writing, reading and removing `local.json`.
  - `server/src/localLock.ts`: the pid lock, with the pure `lockDecision`.
- **The guard option.** `PathGuard` gains `{permissive}`, and `ConfigStore` passes it to every guard it builds. Only `index.ts` sets it, and only for `--local`. `v2.ts` does not change.
- **The welcome and readiness.**
  - `welcomeCapabilities(mcp, local)` adds `local`.
  - `startServer` gains `options.local` and `trek.ready`, which settles once the MCP listener is up or has failed. `local.json` waits for it, so the app's first welcome lists `mcp`.
- **`index.ts` wires `--local`.**
  - Parsing, the profile, the lock first, the token, host `127.0.0.1` and port `0`.
  - `announceLocal` after `listen`.
  - Cleanup on signal and on `exit`.
- **The build** (`server/scripts/build.mjs`):
  - bundles `ws`;
  - bakes in the version and a placeholder;
  - hashes the bundle and stamps the hash in (`buildStamp.mjs`);
  - writes `dist/build.json`.

  `buildInfo.ts` reads the baked values, or falls back to `package.json` and `"dev"` from source.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), Node 22 and Electron 43's Node 24 (`ELECTRON_RUN_AS_NODE`), esbuild (`define`, `write: false`), `ws` 8 (now bundled), `node-pty` (external), `node --test`, the `src/shared/client` SDK in `smoke:local`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections "Local server supervisor (phase 4)" (the server's half of it) and "Auth" ("The local server's token is generated automatically").

---

## Roadmap: phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–3** (done, master at `6940af0`) | protocol v2, the server registry, projects, git, sessions, status, MCP; server windows; attention across servers | Projects on servers open in their own windows. |
| **4a server `--local`** (this plan) | <ul><li>`trek-server start --local`: own profile (`~/.config/trek-server/local`, `<dataDir>/local`), pid lock, `127.0.0.1` on a random port, a token per start</li><li>`trek-server stop --local`</li><li>`local.json` `{port, pid, token, version, build}`, 0600, written when ready, removed at exit</li><li>the permissive guard, local only</li><li>the `local` capability</li><li>version and build baked into the bundle; `ws` bundled; the bundle runs from a bare `out/server` under Electron's Node</li><li>`smoke:local`</li></ul> | None in the app yet; `trek-server --local` works by hand. |
| **4b bundling and supervisor** | <ul><li>build `out/server`</li><li>`src/main/localServer.ts`: read `local.json`, probe, spawn detached with `ELECTRON_RUN_AS_NODE`</li><li>liveness and version-skew rules</li><li>a synthetic, non-removable `local` app-server entry whose token is read from `local.json`</li><li>`serverLinks` and the relay follow URL changes</li><li>Stop/Restart local server menu items and a skew dialog</li><li>Local listed first in ConnectServer</li><li>a native folder picker for New Project on Local</li><li>the Local server survives quit by default; an app setting, "Stop local server on quit", reverses that</li></ul> | A Local server appears by itself; New Project on Local. |
| **4c features on Local** | Docker, env, stacks, skills, VS Code/Reveal and Linear on for Local server windows; Linear on for every server | Local server windows do what file windows did. |
| **4d import** | <ul><li>File → Import .trekproj…</li><li>opening a `.trekproj` imports it, or focuses the project if it was already imported (tracked in `migrated.json`)</li><li>a one-time first-launch prompt</li><li>recents and `open-windows.json` rewritten</li><li>legacy server tokens migrated</li></ul> | Existing projects move onto servers. |
| **4e start screen and retirement** | <ul><li>file windows and the legacy code deleted: `pty.ts`, `mcp.ts`, `hosts/`, `servers.ts`, `worktreeActions`, `mcpTools`, the legacy store and backend, v1 on the server</li><li>the bot stays dormant in the tree</li><li>the legacy smokes rewritten or retired</li></ul> | Every project lives on a server. |

Out of scope here: everything in 4b–4e. Nothing under `src/main`, `src/preload` or `src/renderer` changes, apart from the new string in `CAPABILITY`, which no client reads yet.

---

## Decisions

### Recorded (user decisions)

1. **The local server has its own profile and a pid lock** (user-approved default, 2026-11-08). Its config is `~/.config/trek-server/local/config.json` and its data is `<dataDir>/local`. A hand-run `trek-server start` on the default profile never shares a file with it.
2. **The local server survives app quit by default.** An app setting, "Stop local server on quit", reverses that (4b). Nothing in 4a stops it, except a signal.
3. **The app runs its own bundle with Electron's Node** (`ELECTRON_RUN_AS_NODE`, spec). 4a proves the bundle runs that way, `node-pty` included.
3a. **`trek-server stop --local`** (user decision, 2026-11-08). Decision 4a, Task 6b.

### Decided in this plan

**The CLI (Task 6)**

4. **`trek-server start --local`, and `stop --local`** (the stop is a user decision, 4a below).
   - `--local` also works with no command, since `start` is the default; that is the spec's `trek-server --local`.
   - It is a usage error (exit 2) on any command but `start` and `stop`. It is also a usage error with `--config`, `--data-dir`, `--port`, `--host` or `--insecure`, because the profile fixes all of them.
   - The plan first had no `stop`: the 4b supervisor can SIGTERM the pid in `local.json` itself. The user asked for one (4a).
4a. **`trek-server stop --local`** (user decision, 2026-11-08; Task 6b). It SIGTERMs the pid in `local.json` only if `local.lock` holds the same pid, so it never signals a process that reused the pid. It waits up to 10 s for both files to go. Exit 0 once stopped or if none was running; 1 on a timeout, an unverified lock or a failed signal; 2 for a usage error (`stop` without `--local`).
5. **Exit codes:** 0 after a signal, 1 for a failure, 2 for a usage error, and **3** (`LOCAL_ALREADY_RUNNING_EXIT`) when another local server holds the lock. 4b treats 3 as "another start won; read `local.json`".

**The profile and `local.json` (Tasks 2, 6)**

6. **The paths.**
   - The profile directory is `~/.config/trek-server/local`, created 0700. It holds `config.json`, `local.json` and `local.lock`. That is "the trek-server config dir" in the spec, one level down, so the profile is one directory. It is `~/.config` on every platform, like `defaultConfigPath`.
   - The data dir is `defaultDataDir()/local`. It is set as `--data-dir` would be, so it is remembered as `config.dataDir`.
   - `src/shared/localServer.ts` gives the paths as segments (`LOCAL_PROFILE_DIR`, `LOCAL_INFO_FILE`, …), and each side joins them. No other `src/shared` file imports `node:`, and this one need not be the first.
7. **The legacy trek-daemon config is never copied into the local profile** (`configExplicit` is set). On first start the profile's config is written as `{repos: []}` once the lock is held. That avoids the store's "does not exist" warning.
8. **A new token on every start.** It replaces the `local` entry, so only its hash is ever saved.
   - Why not keep one token: `local.json` is removed at exit, and the config holds only hashes. A stable token would need its plaintext in a second file on disk while no server runs.
   - With rotation, nothing on disk grants access once the server is gone. A SIGKILLed server's leftover `local.json` holds a token that the next start revokes.
   - The cost: a client holding the old token gets `needs-auth` after a restart, until it re-reads `local.json`. 4b's synthetic entry reads the token from `local.json` on each connect (Notes for 4b, 5).
9. **`local.json` is written when the server is ready, not merely listening.**
   - It is written after `listen` and after `trek.ready`, so the app's first welcome lists `mcp` if the server will have it. Without that wait, the welcome races the MCP listener's own `listen(0)`.
   - It is written through `writeFileAtomic`: write-then-rename, mode 0600.
   - Holding the lock, a start first deletes any `local.json` left by a dead server, so the app never reads a dead port during a restart.
   - It is removed first thing on SIGTERM and SIGINT, so the app stops connecting to a server that is going away, and again from `process.on('exit')`. Both remove it only if it holds this pid.
10. **Version and build.**
    - The version comes from `server/package.json` through esbuild `define`, so `out/server` (4b) no longer reads `../package.json`, which would give `0.0.0` there.
    - The build is the first 12 hex digits of the sha256 of the bundle. The bundle is built with a placeholder, hashed, and stamped (`stampBuild`). Two bundles share an id only if they are the same code, so a dev rebuild with no version bump still counts as skew.
    - From source (tsx) the version comes from `package.json` and the build is `"dev"`.
    - `dist/build.json` carries both values, for 4b to compare with `local.json`.

**The lock (Tasks 3, 6)**

11. **Semantics.** `local.lock` holds the pid.
    - It is created by writing a temp file and hard-linking it into place. The link is atomic and fails if a lock exists, and the lock never exists without its pid. A plain `wx` create could be read empty by a racing start, which would take it over.
    - A live holder (signal 0 succeeds, or `EPERM`) refuses: exit 3, naming `local.json`.
    - A dead holder, a lock with no pid, or our own pid (a dead process that had our pid) is taken over. The start unlinks it and retries, up to 3 times, and logs `Took over the lock of a local trek-server that is gone (pid N).`
    - The lock is taken before anything in the profile is written.
12. **The double takeover.** Two starts that find the same stale lock at the same instant can both take it over: the second unlinks the first's fresh lock. So `announceLocal` re-reads the lock before writing `local.json`, and a start that no longer holds it exits 3. Only the holder ever writes `local.json`. On `exit`, the lock and `local.json` are removed only if they hold this pid.

**The guard (Task 4)**

13. **Permissive is a `PathGuard` option, set only by `index.ts` and only with `--local`.**
    - `ConfigStore` takes it in its constructor and passes it to every guard it builds (the constructor, `commit`, `swap`), so a save or a reload keeps it.
    - `server.addRepo` still passes `requireAllowedRoot: true`. On a permissive guard those checks pass, so `v2.ts:254` and `configStore.ts:105` do not change.
    - The permissive guard still resolves symlinks and paths that do not exist yet, so callers get the same realpath as before.
    - These checks still apply on Local:
      - absolute paths (`requireAbsolutePath`);
      - `NOT_A_REPO`;
      - `project.import`'s registered-repo check, so 4d calls `server.addRepo` first;
      - its refusal of a worktree at a registered repo.
    - The tests run each case against a default store too, and see `PATH_DENIED` there.

**The welcome (Task 5)**

14. **`local` is the last capability, listed only by `--local`.** A client must not guess "local" from a URL: a hand-run server on loopback is not the app's Local. The client SDK and the renderer do not read it yet (4b).
15. **`trek.ready`** settles once the MCP listener is up or has failed (at once when there is no MCP directory). It never rejects. Remote mode does not wait on it: its listen and log are unchanged.

**The bundle (Task 1)**

16. **`ws` is bundled**, not added to the root dependencies.
    - Bundled, the server needs nothing at run time but `node-pty`, which is native and which the app already ships unpacked (`asarUnpack`). `ws` is pure JS.
    - Added to the root dependencies instead, it would ship in the app only for the server, and resolution would depend on where `out/server` sits. That works, but it couples the app's dependency tree to the server's.
    - `ws`'s optional native helpers (`bufferutil`, `utf-8-validate`) stay external. `ws` loads them only if they are installed.
    - The bundle grows from 522 KB to 645 KB (esbuild's figures).
    - `ws` stays in `server/package.json` for the smoke and source runs.

**Sessions across a SIGTERM (Task 7)**

17. **Nothing changes, and the smoke proves it.** At SIGTERM the server flushes projects (`projectFiles.files.close()`), and the session keeps its `agentSessionId`. After a restart it is listed with no `ptyId` and its worktree unloaded. `worktree.load` spawns the agent with `--resume <id>`. The shutdown log still says "all agent sessions will end", which is true of their processes.

### The brief, mapped

| # | Item | Where |
|---|---|---|
| 1 | Own profile (`local/config.json`, `<dataDir>/local`) and a pid lock | Tasks 2, 3, 6 (Decisions 6, 7, 11, 12) |
| 2 | Host `127.0.0.1`, `listen(0)` | Task 6 |
| 3 | Generated token: hash in `tokens` as `local`, plaintext in `local.json` | Task 6 (Decision 8) |
| 4 | `local.json` `{port, pid, token, version, build}`, 0600, atomic, after listening, removed on SIGTERM and exit | Tasks 2, 6 (Decision 9) |
| 5 | Permissive guard and `server.addRepo` in `--local` only; remote unchanged | Task 4 (Decision 13) |
| 6 | `local` capability | Task 5 (Decision 14) |
| 7 | SIGTERM keeps sessions resumable | Task 7 (Decision 17) |
| 8 | Version and build via `define`; `ws` bundled; runs with no `server/node_modules` | Task 1 (Decisions 10, 16), Task 7 |
| 9 | Lock: live refuses with a clear message and code, stale taken over | Tasks 3, 6 (Decisions 5, 11) |
| 10 | CLI shape and how 4b stops it | Tasks 6, 6b (Decisions 4, 4a) |
| 11 | Tests: unit tests for the pure parts; the built bundle in a temp HOME, under Node and under Electron's Node, with a session | Tasks 1–5, 7 |
| 12 | Existing suites green | Task 8 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless.
  - `server/src/server.ts` and `index.ts` use extensionless imports and cannot be imported by a test. They are covered by `smoke:local`, the server smoke and `smoke:client`.
- **Baseline:** 1412 tests pass at `6940af0`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck` and `npm --prefix server run typecheck`
  - `npm run build` and `npm --prefix server run build`
  - `(cd server && npm run smoke -- --built)` (the server smoke on the bundle)
  - `node scripts/client-contract.mjs` (`smoke:client`)
  - `npm run smoke:local` (new, Task 7; it builds the server; no window)
  - `node scripts/v2-smoke.mjs` and the legacy smokes, in the final check
  - **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes. `smoke:local` opens no window, but run it on its own too: it starts Electron binaries.
- **Branch:** `central-server-phase4`, at master `6940af0`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it, context lines included. Apply them by hand or with `git apply`. New files are given whole.
- **Provenance.** Every hunk and every new file was produced from a prototype of this plan. It was built on `6940af0`, one commit per task, with the checks below run on it; the prototype branch was then deleted.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.
- **The build id** in expected output is shown as `<build>`: 12 hex digits that change with any change to the bundle.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `server/scripts/buildStamp.mjs` | create | 1 | `BUILD_PLACEHOLDER`, `stampBuild`: the build id is a hash of the bundle |
| `server/scripts/build.mjs` | modify | 1 | bundle `ws`; `define` the version and the placeholder; stamp; `dist/build.json` |
| `server/src/buildInfo.ts` | create | 1 | `buildInfo()`: the baked version and build, or `package.json` and `"dev"` |
| `server/src/index.ts` | modify | 1, 6, 6b | `buildInfo` (1); `--local`: parsing, profile, lock, token, host and port, `announceLocal`, cleanup (6); `stop --local` (6b) |
| `src/shared/localServer.ts` | create | 2 | the contract with 4b: path segments, file names, `LOCAL_TOKEN_NAME`, `LOCAL_ALREADY_RUNNING_EXIT`, `LocalInfo`, `parseLocalInfo` |
| `server/src/localProfile.ts` | create | 2 | `localProfile`, `writeLocalInfo`, `readLocalInfo`, `removeLocalInfo` |
| `server/src/localLock.ts` | create | 3 | `lockDecision`, `pidAlive`, `readLockPid`, `acquireLock`, `holdsLock`, `releaseLock` |
| `server/src/localStop.ts` | create | 6b | `stopDecision`, `stopLocal`: `trek-server stop --local` |
| `server/src/paths.ts` | modify | 4 | `PathGuardOptions.permissive` |
| `server/src/configStore.ts` | modify | 4 | the guard options, passed to every guard it builds |
| `src/shared/protocolV2.ts`, `server/src/capabilities.ts`, `PROTOCOL.md` | modify | 5 | the `local` capability |
| `server/src/server.ts` | modify | 5 | `ServerOptions.local`; `TrekServer.ready` |
| `server/README.md` | modify | 6, 6b, 7 | "The app's local server"; `smoke:local` |
| `scripts/local-server-smoke.mjs`, `package.json` | create, modify | 7 | `smoke:local` |
| `scripts/serverBuildStamp.test.mjs`, `serverLocalProfile.test.mjs`, `serverLocalLock.test.mjs`, `serverPaths.test.mjs`, `serverLocalStop.test.mjs` | create | 1–4, 6b | tests |
| `scripts/serverConfigStore.test.mjs`, `serverImportCheck.test.mjs`, `serverV2.test.mjs` | modify | 4, 5 | tests |

`v2.ts`, `repos.ts`, the session manager and everything under `src/main`, `src/preload` and `src/renderer` do not change.

---

### Task 1: The version and a build id baked into the bundle; `ws` bundled

**Files:**
- Create: `server/scripts/buildStamp.mjs`, `server/src/buildInfo.ts`
- Modify: `server/scripts/build.mjs`, `server/src/index.ts`
- Test: `scripts/serverBuildStamp.test.mjs`

Decisions 10 and 16. `serverVersion()` is replaced by `buildInfo()`. The startup line gains `(build <id>)`. `trek-server version` still prints the version alone.

- [ ] **Step 1: The test**

Create `scripts/serverBuildStamp.test.mjs`:

```js
// scripts/serverBuildStamp.test.mjs — the build id baked into the server bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_PLACEHOLDER, stampBuild } from '../server/scripts/buildStamp.mjs'

test('stampBuild replaces every placeholder with a 12-digit hash of the bundle', () => {
  const text = `const a = "${BUILD_PLACEHOLDER}";\nconst b = "${BUILD_PLACEHOLDER}";\n`
  const { text: stamped, build } = stampBuild(text)
  assert.match(build, /^[0-9a-f]{12}$/)
  assert.equal(stamped, `const a = "${build}";\nconst b = "${build}";\n`)
  assert.equal(stamped.includes(BUILD_PLACEHOLDER), false)
})

test('the same bundle gets the same id, a changed one another', () => {
  const one = `x("${BUILD_PLACEHOLDER}")`
  assert.equal(stampBuild(one).build, stampBuild(one).build)
  assert.notEqual(stampBuild(one).build, stampBuild(`${one};y()`).build)
})

test('a bundle without the placeholder is refused', () => {
  assert.throws(() => stampBuild('no id here'), /no build placeholder/)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/serverBuildStamp.test.mjs 2>&1 | grep -E "^# (pass|fail)|ERR_MODULE"`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/scripts/buildStamp.mjs'`, `# pass 0`, `# fail 1`.

- [ ] **Step 3: The implementation**

Create `server/scripts/buildStamp.mjs`:

```js
// The build id baked into the bundle: a hash of the bundle itself, so two
// bundles share an id only if they are the same code. The bundle is built with
// BUILD_PLACEHOLDER where the id goes, hashed, then the placeholder is replaced.
import { createHash } from 'node:crypto'

export const BUILD_PLACEHOLDER = '__trek_server_build_placeholder__'

/** Returns the stamped bundle and its build id (12 hex digits). */
export function stampBuild(text) {
  if (!text.includes(BUILD_PLACEHOLDER)) throw new Error('the bundle has no build placeholder')
  const build = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text: text.replaceAll(BUILD_PLACEHOLDER, build), build }
}
```

Create `server/src/buildInfo.ts`:

```ts
// The server's version and build id. The bundle has both baked in by
// scripts/build.mjs; from source (tsx, tests) the version comes from
// package.json and the build is "dev".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

declare const __TREK_SERVER_VERSION__: string | undefined
declare const __TREK_SERVER_BUILD__: string | undefined

export interface BuildInfo {
  version: string
  build: string
}

export function buildInfo(): BuildInfo {
  return {
    version: typeof __TREK_SERVER_VERSION__ === 'string' ? __TREK_SERVER_VERSION__ : packageVersion(),
    build: typeof __TREK_SERVER_BUILD__ === 'string' ? __TREK_SERVER_BUILD__ : 'dev'
  }
}

/** server/package.json's version, read next to src/ (a source run only). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
```

```diff
diff --git a/server/scripts/build.mjs b/server/scripts/build.mjs
index e1bfb7d..0487a56 100644
--- a/server/scripts/build.mjs
+++ b/server/scripts/build.mjs
@@ -1,24 +1,38 @@
-// Bundles the daemon (and the shared/host code it imports from ../src) into a
-// single executable CommonJS file: dist/trek-server.cjs. Native and runtime
-// dependencies stay external and resolve from node_modules at run time —
-// node-pty from the repo root, ws from server/node_modules.
+// Bundles the server (and the shared/host code it imports from ../src) into a
+// single executable CommonJS file: dist/trek-server.cjs. Everything is bundled
+// except node-pty, which is native and resolves from node_modules at run time
+// (the repo root's, or the app's unpacked copy), and ws's optional native
+// helpers, which ws loads only if they are installed. The version and a build
+// id (a hash of the bundle) are baked in, and also written to dist/build.json.
 import { build } from 'esbuild'
-import { chmodSync } from 'node:fs'
+import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
 import { fileURLToPath } from 'node:url'
+import { BUILD_PLACEHOLDER, stampBuild } from './buildStamp.mjs'
 
 const root = fileURLToPath(new URL('..', import.meta.url))
 const outfile = `${root}dist/trek-server.cjs`
+const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
 
-await build({
+const result = await build({
   entryPoints: [`${root}src/index.ts`],
   outfile,
   bundle: true,
   platform: 'node',
   target: 'node20',
   format: 'cjs',
-  external: ['node-pty', 'ws'],
+  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
+  define: {
+    __TREK_SERVER_VERSION__: JSON.stringify(version),
+    __TREK_SERVER_BUILD__: JSON.stringify(BUILD_PLACEHOLDER)
+  },
   banner: { js: '#!/usr/bin/env node' },
+  write: false,
   logLevel: 'info'
 })
 
+const { text, build: buildId } = stampBuild(result.outputFiles[0].text)
+mkdirSync(`${root}dist`, { recursive: true })
+writeFileSync(outfile, text)
 chmodSync(outfile, 0o755)
+writeFileSync(`${root}dist/build.json`, JSON.stringify({ version, build: buildId }) + '\n')
+console.log(`trek-server ${version}, build ${buildId}`)
diff --git a/server/src/index.ts b/server/src/index.ts
index 1bcf4ed..5f9cb0a 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -1,7 +1,8 @@
-import { existsSync, readFileSync, statSync } from 'node:fs'
-import { basename, join, resolve } from 'node:path'
+import { existsSync, statSync } from 'node:fs'
+import { basename, resolve } from 'node:path'
 import { hostname } from 'node:os'
 import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
+import { buildInfo } from './buildInfo'
 import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig } from './config'
 import type { Project } from '../../src/shared/model/types'
 import { ConfigStore } from './configStore'
@@ -163,15 +164,6 @@ function isDirectory(path: string): boolean {
   }
 }
 
-function serverVersion(): string {
-  try {
-    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
-    return pkg.version ?? '0.0.0'
-  } catch {
-    return '0.0.0'
-  }
-}
-
 function fail(message: string): never {
   console.error(message)
   process.exit(1)
@@ -188,7 +180,7 @@ if (args.command === 'help') {
   process.exit(0)
 }
 if (args.command === 'version') {
-  console.log(serverVersion())
+  console.log(buildInfo().version)
   process.exit(0)
 }
 
@@ -334,9 +326,10 @@ try {
 } catch (err) {
   fail(`Cannot read projects from ${projectsDir(args.dataDir ?? store.config.dataDir ?? defaultDataDir())}: ${(err as Error).message}`)
 }
+const { version, build } = buildInfo()
 const server = startServer(
   store,
-  serverVersion(),
+  version,
   {
     create: (hub, onSummariesChange) =>
       new ProjectState({ hub, store: projectFiles.files, onSummariesChange }, projectFiles.loaded),
@@ -356,7 +349,7 @@ server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
 })
 server.httpServer.listen(port, host, () => {
   console.log(
-    `trek-server ${serverVersion()} "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${port}`
+    `trek-server ${version} (build ${build}) "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${port}`
   )
   console.log(
     store.config.repos.length > 0
```

- [ ] **Step 4: Verify**

Run: `node --test scripts/serverBuildStamp.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 3`, `# fail 0`.

Run: `npm --prefix server run typecheck` → no errors.

Run: `npm --prefix server run build 2>&1 | tail -1 && cat server/dist/build.json`

Expected:

```
trek-server 0.2.0, build <build>
{"version":"0.2.0","build":"<build>"}
```

Run, to check that the bundle needs no `server/node_modules` and no `package.json` beside it:

```bash
D=$(mktemp -d) && mkdir -p $D/out/server $D/node_modules \
  && cp server/dist/trek-server.cjs $D/out/server/ \
  && ln -s "$PWD/node_modules/node-pty" $D/node_modules/node-pty \
  && node $D/out/server/trek-server.cjs version \
  && ELECTRON_RUN_AS_NODE=1 "$(node -p "require('electron')")" $D/out/server/trek-server.cjs version \
  && grep -c '__trek_server_build_placeholder__' server/dist/trek-server.cjs; rm -rf $D
```

Expected: `0.2.0`, `0.2.0`, `0`. Without the `node-pty` link, `version` fails with `Cannot find module 'node-pty'`: the bundle loads it at the top, and that is the one module the app must provide.

Run: `(cd server && npm run smoke -- --built) 2>&1 | tail -1` → `SERVER SMOKE PASS` (the bundled `ws`).

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1415`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/buildStamp.mjs server/src/buildInfo.ts scripts/serverBuildStamp.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "build(server): bake the version and a build id into the bundle, and bundle ws" \
  -m "Co-Authored-By: <model trailer>" \
  -- server/scripts/buildStamp.mjs server/scripts/build.mjs server/src/buildInfo.ts server/src/index.ts scripts/serverBuildStamp.test.mjs
```

---

### Task 2: The local profile and `local.json`

**Files:**
- Create: `src/shared/localServer.ts`, `server/src/localProfile.ts`
- Test: `scripts/serverLocalProfile.test.mjs`

Decisions 6 and 9. These are pure helpers; nothing calls them until Task 6.

- [ ] **Step 1: The test**

Create `scripts/serverLocalProfile.test.mjs`:

```js
// scripts/serverLocalProfile.test.mjs — the local server's profile paths and local.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { localProfile, readLocalInfo, removeLocalInfo, writeLocalInfo } from '../server/src/localProfile.ts'

const info = { port: 51234, pid: 4242, token: 'tok', version: '0.2.0', build: 'abc123def456' }

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-local-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the local profile lives under ~/.config/trek-server/local and <dataDir>/local', () => {
  assert.deepEqual(localProfile('/h', '/d/trek-server'), {
    dir: '/h/.config/trek-server/local',
    configPath: '/h/.config/trek-server/local/config.json',
    infoPath: '/h/.config/trek-server/local/local.json',
    lockPath: '/h/.config/trek-server/local/local.lock',
    dataDir: '/d/trek-server/local'
  })
})

test('parseLocalInfo keeps the five fields and drops anything else', () => {
  assert.deepEqual(parseLocalInfo({ ...info, extra: 1 }), info)
})

test('parseLocalInfo refuses a missing or wrong field', () => {
  for (const bad of [
    null, [], 'x', {},
    { ...info, port: 0 }, { ...info, port: 65536 }, { ...info, port: 1.5 }, { ...info, port: '51234' },
    { ...info, pid: 0 }, { ...info, pid: -1 }, { ...info, pid: undefined },
    { ...info, token: '' }, { ...info, token: 1 },
    { ...info, version: '' }, { ...info, build: '' }, { ...info, build: undefined }
  ]) assert.equal(parseLocalInfo(bad), undefined, JSON.stringify(bad))
})

test('writeLocalInfo writes 0600 by rename, leaving no temp file; readLocalInfo reads it back', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'local.json')
  writeFileSync(path, '{}', { mode: 0o644 })
  writeLocalInfo(path, info)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['local.json'])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), info)
  assert.deepEqual(readLocalInfo(path), info)
})

test('readLocalInfo is undefined for a missing, garbled or malformed file', (t) => {
  const dir = tempDir(t)
  assert.equal(readLocalInfo(join(dir, 'missing.json')), undefined)
  writeFileSync(join(dir, 'garbled.json'), '{"port": 1,')
  assert.equal(readLocalInfo(join(dir, 'garbled.json')), undefined)
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...info, token: '' }))
  assert.equal(readLocalInfo(join(dir, 'bad.json')), undefined)
})

test("removeLocalInfo removes only the given pid's file", (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'local.json')
  writeLocalInfo(path, info)
  assert.equal(removeLocalInfo(path, 999), false)
  assert.deepEqual(readLocalInfo(path), info)
  assert.equal(removeLocalInfo(path, info.pid), true)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(removeLocalInfo(path, info.pid), false, 'a missing file is not an error')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/serverLocalProfile.test.mjs 2>&1 | grep -E "^# (pass|fail)|ERR_MODULE"`

Expected: `Cannot find module '…/src/shared/localServer.ts'`, `# pass 0`, `# fail 1`.

- [ ] **Step 3: The implementation**

Create `src/shared/localServer.ts`:

```ts
// The local server's files (spec, "Local server supervisor (phase 4)").
// `trek-server start --local` writes them; the app's supervisor (phase 4b)
// reads them. Paths are given as segments under the home directory, and each
// side joins them, so this file imports nothing.

/** The local profile's directory, under the home directory: ~/.config/trek-server/local */
export const LOCAL_PROFILE_DIR = ['.config', 'trek-server', 'local'] as const
/** The local server's config file, in the profile directory */
export const LOCAL_CONFIG_FILE = 'config.json'
/** Written (0600) once the local server listens; removed when it exits */
export const LOCAL_INFO_FILE = 'local.json'
/** Holds the local server's pid from before it reads its config until it exits */
export const LOCAL_LOCK_FILE = 'local.lock'
/** The name the local server's generated token is saved under in its config */
export const LOCAL_TOKEN_NAME = 'local'
/** `trek-server start --local` exits with this when another local server holds the lock */
export const LOCAL_ALREADY_RUNNING_EXIT = 3

/** local.json: where the running local server listens, and how to authenticate to it */
export interface LocalInfo {
  /** The WebSocket port on 127.0.0.1 */
  port: number
  pid: number
  /** The plaintext token; a new one on every start */
  token: string
  /** The server's package version */
  version: string
  /** A hash of the server bundle ("dev" from source) */
  build: string
}

/** The LocalInfo in `raw`, field by field, or undefined if any field is missing or wrong. */
export function parseLocalInfo(raw: unknown): LocalInfo | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const { port, pid, token, version, build } = r
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return undefined
  if (typeof token !== 'string' || token === '') return undefined
  if (typeof version !== 'string' || version === '') return undefined
  if (typeof build !== 'string' || build === '') return undefined
  return { port, pid, token, version, build }
}
```

Create `server/src/localProfile.ts`:

```ts
// `trek-server start --local`'s own profile: its config, local.json and lock
// under ~/.config/trek-server/local, and its projects under <dataDir>/local, so
// it never shares files with a hand-run `trek-server start`.
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOCAL_CONFIG_FILE,
  LOCAL_INFO_FILE,
  LOCAL_LOCK_FILE,
  LOCAL_PROFILE_DIR,
  parseLocalInfo,
  type LocalInfo
} from '../../src/shared/localServer.ts'
import { writeFileAtomic } from './atomicWrite.ts'

export interface LocalProfile {
  /** ~/.config/trek-server/local */
  dir: string
  configPath: string
  infoPath: string
  lockPath: string
  /** <dataDir>/local: the local server's projects and MCP files */
  dataDir: string
}

/** `dataDir` is the platform data dir (defaultDataDir()); the profile uses its `local` subdirectory. */
export function localProfile(home: string, dataDir: string): LocalProfile {
  const dir = join(home, ...LOCAL_PROFILE_DIR)
  return {
    dir,
    configPath: join(dir, LOCAL_CONFIG_FILE),
    infoPath: join(dir, LOCAL_INFO_FILE),
    lockPath: join(dir, LOCAL_LOCK_FILE),
    dataDir: join(dataDir, 'local')
  }
}

/** Write-then-rename, 0600: the file holds the plaintext token. */
export function writeLocalInfo(path: string, info: LocalInfo): void {
  writeFileAtomic(path, JSON.stringify(info, null, 2) + '\n', 0o600)
}

/** The file's LocalInfo, or undefined if it is missing, not JSON or malformed. */
export function readLocalInfo(path: string): LocalInfo | undefined {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** Removes local.json if it is `pid`'s. Returns true if it removed it. */
export function removeLocalInfo(path: string, pid: number): boolean {
  if (readLocalInfo(path)?.pid !== pid) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Verify**

Run: `node --test scripts/serverLocalProfile.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 6`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1421`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/localServer.ts server/src/localProfile.ts scripts/serverLocalProfile.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): the local profile and local.json" \
  -m "Co-Authored-By: <model trailer>" \
  -- src/shared/localServer.ts server/src/localProfile.ts scripts/serverLocalProfile.test.mjs
```

---

### Task 3: The local server's pid lock

**Files:**
- Create: `server/src/localLock.ts`
- Test: `scripts/serverLocalLock.test.mjs`

Decisions 11 and 12. `lockDecision` is pure. `acquireLock` takes the pid and the liveness check as parameters, so the tests fake both. The test for `pidAlive` uses an exited child's pid.

- [ ] **Step 1: The test**

Create `scripts/serverLocalLock.test.mjs`:

```js
// scripts/serverLocalLock.test.mjs — the local server's pid lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, holdsLock, lockDecision, pidAlive, readLockPid, releaseLock } from '../server/src/localLock.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-lock-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const alive = () => true
const dead = () => false

test('lockDecision: a live holder refuses; a dead, missing or own pid is taken over', () => {
  assert.equal(lockDecision(10, 20, alive), 'refuse')
  assert.equal(lockDecision(10, 20, dead), 'take')
  assert.equal(lockDecision(undefined, 20, alive), 'take')
  assert.equal(lockDecision(20, 20, alive), 'take')
})

test('pidAlive: this process is, an exited child is not', () => {
  assert.equal(pidAlive(process.pid), true)
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.equal(pidAlive(child.pid), false)
})

test('acquireLock creates a 0700 directory and a 0600 lock holding the pid, with no temp file left', (t) => {
  const dir = join(tempDir(t), 'profile')
  const path = join(dir, 'local.lock')
  assert.deepEqual(acquireLock(path, 100, alive), { ok: true })
  assert.equal(readFileSync(path, 'utf8'), '100\n')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(dir), ['local.lock'])
  assert.equal(readLockPid(path), 100)
  assert.equal(holdsLock(path, 100), true)
})

test('a live holder refuses a second start and keeps its lock', (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.deepEqual(acquireLock(path, 200, alive), { ok: false, holder: 100 })
  assert.equal(readLockPid(path), 100)
  assert.deepEqual(readdirSync(join(path, '..')), ['local.lock'])
})

test("a dead holder's lock is taken over and the dead pid reported", (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.deepEqual(acquireLock(path, 200, (pid) => pid !== 100), { ok: true, tookOver: 100 })
  assert.equal(readLockPid(path), 200)
})

test('a lock holding no pid is taken over', (t) => {
  const path = join(tempDir(t), 'local.lock')
  writeFileSync(path, 'garbage')
  assert.deepEqual(acquireLock(path, 200, alive), { ok: true })
  assert.equal(readLockPid(path), 200)
})

test('releaseLock removes only its own lock', (t) => {
  const path = join(tempDir(t), 'local.lock')
  acquireLock(path, 100, alive)
  assert.equal(releaseLock(path, 200), false)
  assert.equal(holdsLock(path, 200), false)
  assert.equal(readLockPid(path), 100)
  assert.equal(releaseLock(path, 100), true)
  assert.equal(readLockPid(path), undefined)
  assert.equal(releaseLock(path, 100), false, 'a missing lock is not an error')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/serverLocalLock.test.mjs 2>&1 | grep -E "^# (pass|fail)|ERR_MODULE"`

Expected: `Cannot find module '…/server/src/localLock.ts'`, `# pass 0`, `# fail 1`.

- [ ] **Step 3: The implementation**

Create `server/src/localLock.ts`:

```ts
// The local server's pid lock: one `trek-server start --local` per profile. The
// lock file holds the server's pid. A lock whose pid is dead (a crash, a
// SIGKILL) is stale and is taken over; a live one refuses the start.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type LockAction = 'take' | 'refuse'

/**
 * What a start does about a lock that is already there. `holder` is its pid, or
 * undefined if it holds none (unreadable, hand-edited). A lock holding our own
 * pid is left from a dead process that had it before us.
 */
export function lockDecision(holder: number | undefined, self: number, alive: (pid: number) => boolean): LockAction {
  if (holder === undefined || holder === self) return 'take'
  return alive(holder) ? 'refuse' : 'take'
}

/** True if a process with that pid exists (EPERM: it exists but is another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid in the lock file, or undefined if it is missing or holds no pid. */
export function readLockPid(path: string): number | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export type LockResult =
  /** `tookOver` is the dead pid whose lock this start replaced */
  | { ok: true; tookOver?: number }
  /** `holder` is the live pid holding the lock (0 if a racing start's lock could not be read) */
  | { ok: false; holder: number }

/** A start gives up after this many stale locks in a row: other starts are racing it. */
const TAKEOVER_ATTEMPTS = 3

/**
 * Creates the lock holding `pid`. The pid is written to a temp file that is then
 * hard-linked into place, so the lock never exists without its pid, and the link
 * fails if a lock is already there. The directory is created 0700.
 */
export function acquireLock(path: string, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): LockResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let tookOver: number | undefined
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
    if (linkLock(path, pid)) return tookOver === undefined ? { ok: true } : { ok: true, tookOver }
    const holder = readLockPid(path)
    if (lockDecision(holder, pid, alive) === 'refuse') return { ok: false, holder: holder as number }
    tookOver = holder
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return { ok: false, holder: readLockPid(path) ?? 0 }
}

/** True if the lock holds `pid`: a start that was raced out of its lock must not go on. */
export function holdsLock(path: string, pid: number = process.pid): boolean {
  return readLockPid(path) === pid
}

/** Removes the lock if it holds `pid`. Returns true if it removed it. */
export function releaseLock(path: string, pid: number = process.pid): boolean {
  if (!holdsLock(path, pid)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** Returns false if a lock is already there. */
function linkLock(path: string, pid: number): boolean {
  const tmp = `${path}.${pid}.tmp`
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  writeFileSync(tmp, `${pid}\n`, { flag: 'wx', mode: 0o600 })
  try {
    linkSync(tmp, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    unlinkSync(tmp)
  }
}
```

- [ ] **Step 4: Verify**

Run: `node --test scripts/serverLocalLock.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 7`, `# fail 0`.

Run: `npm --prefix server run typecheck` → no errors.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1428`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/src/localLock.ts scripts/serverLocalLock.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): the local server's pid lock" \
  -m "Co-Authored-By: <model trailer>" \
  -- server/src/localLock.ts scripts/serverLocalLock.test.mjs
```

---

### Task 4: A permissive path guard, for the local server only

**Files:**
- Modify: `server/src/paths.ts`, `server/src/configStore.ts`
- Test:
  - Create `scripts/serverPaths.test.mjs`.
  - Modify `scripts/serverConfigStore.test.mjs`, `scripts/serverImportCheck.test.mjs` and `scripts/serverV2.test.mjs`.

Decision 13.
- Every new test runs the same call against a default guard or store too, and sees `PATH_DENIED` there.
- `serverV2.test.mjs`'s `setup` gains a `guardOptions` argument, defaulting to `{}`, so every existing test runs on a default store as before.

- [ ] **Step 1: The tests**

Create `scripts/serverPaths.test.mjs` (the first tests of `PathGuard` itself):

```js
// scripts/serverPaths.test.mjs — the path guard: configured roots, and the local server's permissive guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathGuard } from '../server/src/paths.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-paths-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const d of ['repos/a', 'roots/extra', 'outside/c']) mkdirSync(join(dir, d), { recursive: true })
  const config = { repos: [{ id: 'a', name: 'a', path: join(dir, 'repos', 'a') }], worktreeRoots: [join(dir, 'roots')] }
  return { dir, config }
}

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'no error'
}

test('the default guard allows a repo, its parent and the worktree roots, and nothing else', (t) => {
  const { dir, config } = setup(t)
  const guard = new PathGuard(config)
  assert.equal(guard.check(join(dir, 'repos', 'a')), join(dir, 'repos', 'a'))
  assert.equal(guard.check(join(dir, 'repos', 'a-feature')), join(dir, 'repos', 'a-feature'))
  assert.equal(guard.check(join(dir, 'roots', 'extra')), join(dir, 'roots', 'extra'))
  assert.equal(codeOf(() => guard.check(join(dir, 'outside', 'c'))), 'PATH_DENIED')
  assert.equal(codeOf(() => guard.check(dir)), 'PATH_DENIED')
  assert.equal(codeOf(() => new PathGuard(config, { permissive: false }).check(join(dir, 'outside', 'c'))), 'PATH_DENIED')
})

test('the permissive guard allows any path and still resolves it', (t) => {
  const { dir, config } = setup(t)
  const guard = new PathGuard(config, { permissive: true })
  assert.equal(guard.check(join(dir, 'outside', 'c')), join(dir, 'outside', 'c'))
  assert.equal(guard.check('/'), '/')
  symlinkSync(join(dir, 'outside', 'c'), join(dir, 'link'))
  assert.equal(guard.check(join(dir, 'link')), join(dir, 'outside', 'c'), 'a symlink resolves to its target')
  assert.equal(guard.check(join(dir, 'link', 'new', 'wt')), join(dir, 'outside', 'c', 'new', 'wt'), 'a path not created yet resolves through its ancestor')
  assert.equal(new PathGuard({ repos: [] }, { permissive: true }).check(join(dir, 'outside')), join(dir, 'outside'), 'with no repos at all')
})
```

```diff
diff --git a/scripts/serverConfigStore.test.mjs b/scripts/serverConfigStore.test.mjs
index 426535f..9140ed6 100644
--- a/scripts/serverConfigStore.test.mjs
+++ b/scripts/serverConfigStore.test.mjs
@@ -64,6 +64,24 @@ test('addRepo outside the allowed roots is PATH_DENIED for RPC callers, allowed
   assert.equal(store.addRepo(c, { requireAllowedRoot: false }).added, true)
 })
 
+test('a permissive store (the local server) lets RPC callers add anywhere, also after a save and a reload', (t) => {
+  const { dir, configPath } = setup(t)
+  const store = new ConfigStore(configPath, { permissive: true })
+  t.after(() => store.close())
+  const c = gitInit(join(dir, 'outside', 'c'))
+  assert.equal(store.addRepo(c, { requireAllowedRoot: true }).added, true)
+  assert.equal(store.guard.check(join(dir, 'elsewhere', 'wt')), join(dir, 'elsewhere', 'wt'))
+  saveConfig(configPath, { repos: [] })
+  assert.equal(store.reload(), true)
+  const d = gitInit(join(dir, 'outside', 'd'))
+  assert.equal(store.addRepo(d, { requireAllowedRoot: true }).added, true)
+  assert.equal(codeOf(() => store.addRepo(join(dir, 'outside'), { requireAllowedRoot: true })), 'NOT_A_REPO')
+  // The same file under a default store is still guarded.
+  const remote = new ConfigStore(configPath)
+  t.after(() => remote.close())
+  assert.equal(codeOf(() => remote.addRepo(gitInit(join(dir, 'far', 'e')), { requireAllowedRoot: true })), 'PATH_DENIED')
+})
+
 test('a path in an allowed root whose git root is outside it is PATH_DENIED', (t) => {
   const { dir, store } = setup(t)
   // dir itself becomes a repo; dir/repos/plain is allowed but resolves up to dir.
diff --git a/scripts/serverImportCheck.test.mjs b/scripts/serverImportCheck.test.mjs
index 5e3ed51..94fe953 100644
--- a/scripts/serverImportCheck.test.mjs
+++ b/scripts/serverImportCheck.test.mjs
@@ -86,6 +86,20 @@ test('repository paths must be registered; worktree paths must be allowed', (t)
   assert.equal(code(() => checkImport(b, ctx)), 'PATH_DENIED')
 })
 
+test('the permissive guard (the local server) allows a worktree anywhere, but repos must still be registered', (t) => {
+  const { registry, project } = setup(t)
+  const ctx = { registry, guard: new PathGuard({ repos: registry }, { permissive: true }), existingIds: new Set(), projectId: 'pid' }
+  const b = project()
+  b.repositories[0].worktrees[1].path = '/elsewhere/wt'
+  assert.equal(checkImport(b, ctx).repositories[0].worktrees[1].path, '/elsewhere/wt')
+  const a = project()
+  a.repositories[0].path = '/elsewhere/repo'
+  assert.equal(code(() => checkImport(a, ctx)), 'PATH_DENIED')
+  const c = project()
+  c.repositories[0].worktrees[1].path = registry[0].path
+  assert.equal(code(() => checkImport(c, ctx)), 'BAD_REQUEST', 'a worktree at a registered repo is still refused')
+})
+
 test('shape, settings and branch keys are checked', (t) => {
   const { registry, guard, project } = setup(t)
   const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 2e92b6c..fa12b2a 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -14,14 +14,15 @@ import { TopicHub } from '../server/src/topicHub.ts'
 import { dispatchV2, responseRev } from '../server/src/v2.ts'
 import { applyStatePatch } from '../src/shared/sync/topicState.ts'
 
-function setup(t) {
+/** `guardOptions` go to the ConfigStore: `{ permissive: true }` is the local server. */
+function setup(t, guardOptions = {}) {
   const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-v2-')))
   t.after(() => rmSync(dir, { recursive: true, force: true }))
   const a = join(dir, 'repos', 'a')
   execFileSync('git', ['init', '-q', a])
   const configPath = join(dir, 'config.json')
   saveConfig(configPath, { serverId: 'sid-1', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
-  const store = new ConfigStore(configPath)
+  const store = new ConfigStore(configPath, guardOptions)
   const hub = new TopicHub()
   const holder = {}
   const server = publishServerState(store, hub, '0.2.0', {
@@ -108,6 +109,39 @@ test('server.addRepo errors: missing path, outside roots, not a repo', async (t)
   assert.equal(store.config.repos.length, 1)
 })
 
+test('on the local server (a permissive store) server.addRepo takes a repo anywhere; a remote one still refuses', async (t) => {
+  const remote = setup(t)
+  const local = setup(t, { permissive: true })
+  for (const { dir } of [remote, local]) execFileSync('git', ['init', '-q', join(dir, 'outside', 'c')])
+  assert.equal((await remote.call('server.addRepo', { path: join(remote.dir, 'outside', 'c') })).error.code, 'PATH_DENIED')
+  assert.deepEqual(await local.call('server.addRepo', { path: join(local.dir, 'outside', 'c') }), { ok: true, result: { repoId: 'c' } })
+  mkdirSync(join(local.dir, 'outside', 'plain'))
+  assert.equal((await local.call('server.addRepo', { path: join(local.dir, 'outside', 'plain') })).error.code, 'NOT_A_REPO')
+  assert.equal((await local.call('server.addRepo', { path: 'outside/c' })).error.code, 'BAD_REQUEST')
+  assert.deepEqual(remote.store.config.repos.map((r) => r.id), ['a'])
+})
+
+test("project.import of a worktree outside its repo's parent: allowed on the local server, PATH_DENIED on a remote one", async (t) => {
+  const { importProjectFile } = await import('../src/shared/model/importProject.ts')
+  for (const [guardOptions, allowed] of [[{}, false], [{ permissive: true }, true]]) {
+    const { dir, a, call } = setup(t, guardOptions)
+    const elsewhere = join(dir, 'elsewhere', 'a-feature')
+    mkdirSync(elsewhere, { recursive: true })
+    let n = 0
+    const { projects } = importProjectFile({ version: 3, name: 'File', repositories: [{ id: 'x', name: 'a', path: a, worktrees: [
+      { name: 'main', path: a },
+      { name: 'feature', path: elsewhere, branch: 'feature' }
+    ] }] }, () => `imp-${++n}`)
+    const res = await call('project.import', { project: projects[0].project })
+    if (allowed) {
+      assert.equal(res.ok, true, JSON.stringify(res))
+      assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['File'])
+    } else {
+      assert.equal(res.error.code, 'PATH_DENIED')
+    }
+  }
+})
+
 test('server.addRepo rejects an empty or whitespace-only name', async (t) => {
   const { dir, call, store } = setup(t)
   const b = join(dir, 'repos', 'b')
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test scripts/serverPaths.test.mjs scripts/serverConfigStore.test.mjs scripts/serverV2.test.mjs scripts/serverImportCheck.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"`

Expected: `# pass 78`, `# fail 5`, failing:
- the permissive guard allows any path and still resolves it
- a permissive store (the local server) lets RPC callers add anywhere, also after a save and a reload
- the permissive guard (the local server) allows a worktree anywhere, but repos must still be registered
- on the local server (a permissive store) server.addRepo takes a repo anywhere; a remote one still refuses
- project.import of a worktree outside its repo's parent: allowed on the local server, PATH_DENIED on a remote one

The new default-guard test, "the default guard allows a repo, its parent and the worktree roots, and nothing else", passes before the change and after it. It pins down remote behaviour.

- [ ] **Step 3: The implementation**

```diff
diff --git a/server/src/configStore.ts b/server/src/configStore.ts
index 04cdeb9..5b06dfd 100644
--- a/server/src/configStore.ts
+++ b/server/src/configStore.ts
@@ -10,13 +10,14 @@ import type { LlmSettings } from '../../src/shared/providers/types'
 import { isRecord } from './validate.ts'
 import { saveConfig, type TrekServerConfig } from './config.ts'
 import { codedError } from './errors.ts'
-import { PathGuard } from './paths.ts'
+import { PathGuard, type PathGuardOptions } from './paths.ts'
 import { addRepo, removeRepo, resolveRepoRoot, type AddRepoOptions } from './repos.ts'
 
 export interface AddRepoRequest extends AddRepoOptions {
   /**
    * RPC callers may only add repos under an already-allowed root (a registered
    * repo's parent or a worktreeRoot). The CLI runs on the box and may add anywhere.
+   * A permissive store's guard allows every root, so there RPC callers may too.
    */
   requireAllowedRoot: boolean
 }
@@ -61,18 +62,23 @@ export class ConfigStore extends EventEmitter<{ change: [] }> {
   private usage: RepoUsage = () => []
   private current: TrekServerConfig
   private currentGuard: PathGuard
+  private readonly guardOptions: PathGuardOptions
   private watcher?: FSWatcher
   private reloadTimer?: NodeJS.Timeout
 
   private warnedMissing = false
   private warnedServerId = false
 
-  /** Throws if the file exists but is not valid JSON or has the wrong shape. A missing file is an empty config. */
-  constructor(path: string) {
+  /**
+   * Throws if the file exists but is not valid JSON or has the wrong shape. A missing file is an empty config.
+   * `guardOptions` applies to every guard the store builds (`permissive` for the local server).
+   */
+  constructor(path: string, guardOptions: PathGuardOptions = {}) {
     super()
     this.path = path
+    this.guardOptions = guardOptions
     this.current = existsSync(path) ? validateConfig(JSON.parse(readFileSync(path, 'utf8'))) : { repos: [] }
-    this.currentGuard = new PathGuard(this.current)
+    this.currentGuard = new PathGuard(this.current, guardOptions)
   }
 
   /** Treat as read-only; change it through update(). */
@@ -216,7 +222,7 @@ export class ConfigStore extends EventEmitter<{ change: [] }> {
 
   private commit(next: TrekServerConfig): void {
     // Build the guard first: if it throws, neither disk nor memory has changed.
-    const guard = new PathGuard(next)
+    const guard = new PathGuard(next, this.guardOptions)
     saveConfig(this.path, next)
     this.current = next
     this.currentGuard = guard
@@ -224,7 +230,7 @@ export class ConfigStore extends EventEmitter<{ change: [] }> {
   }
 
   private swap(next: TrekServerConfig): void {
-    const guard = new PathGuard(next)
+    const guard = new PathGuard(next, this.guardOptions)
     this.current = next
     this.currentGuard = guard
     this.emit('change')
diff --git a/server/src/paths.ts b/server/src/paths.ts
index 19bd723..0d855b5 100644
--- a/server/src/paths.ts
+++ b/server/src/paths.ts
@@ -2,17 +2,27 @@ import { realpathSync } from 'node:fs'
 import { dirname, resolve, sep } from 'node:path'
 import type { TrekServerConfig } from './config'
 
+export interface PathGuardOptions {
+  /** Every path is allowed (`trek-server start --local` only) */
+  permissive?: boolean
+}
+
 /**
  * Every client-supplied filesystem path must resolve under one of the
  * configured roots: a repo, a repo's parent directory (worktrees live as
  * siblings of the repo checkout), or an explicit worktreeRoot. This guards
  * against path typos and confused-deputy bugs — it is not a sandbox; the
  * token already grants shell access as the daemon user.
+ *
+ * The local server's guard is permissive: the user picks paths on their own
+ * disk, so every path is allowed, and check() only resolves it.
  */
 export class PathGuard {
   private roots: string[]
+  private readonly permissive: boolean
 
-  constructor(config: TrekServerConfig) {
+  constructor(config: TrekServerConfig, options: PathGuardOptions = {}) {
+    this.permissive = options.permissive === true
     const roots = new Set<string>()
     const addRoot = (path: string): void => {
       // realpath so symlinked configs (e.g. /var → /private/var) match the
@@ -31,7 +41,7 @@ export class PathGuard {
     this.roots = [...roots]
   }
 
-  /** Returns the resolved path, or throws { code: 'PATH_DENIED' }. */
+  /** Returns the resolved path, or throws { code: 'PATH_DENIED' } (never when permissive). */
   check(path: string): string {
     let resolved: string
     try {
@@ -51,6 +61,7 @@ export class PathGuard {
         }
       }
     }
+    if (this.permissive) return resolved
     const allowed = this.roots.some(
       (root) => resolved === root || resolved.startsWith(root + sep)
     )
```

- [ ] **Step 4: Verify**

Run the command from Step 2 → `# pass 83`, `# fail 0`.

Run: `npm --prefix server run typecheck` → no errors.

Run: `grep -rn "new PathGuard" server/src` → three lines, all in `configStore.ts`, each passing the store's guard options. No other server code builds a guard, so only a store opened with `{ permissive: true }` is permissive.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1434`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/serverPaths.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): a permissive path guard for the local server" \
  -m "Co-Authored-By: <model trailer>" \
  -- server/src/paths.ts server/src/configStore.ts scripts/serverPaths.test.mjs scripts/serverConfigStore.test.mjs scripts/serverImportCheck.test.mjs scripts/serverV2.test.mjs
```

---

### Task 5: The `local` capability, and `ready` once MCP has settled

**Files:**
- Modify: `src/shared/protocolV2.ts`, `server/src/capabilities.ts`, `server/src/server.ts`, `PROTOCOL.md`
- Test: `scripts/serverV2.test.mjs`

Decisions 14 and 15.
- **Testing `ready`.** `server.ts` cannot be imported by a test (Conventions). `ready` is checked in Task 7: the first welcome after `local.json` appears lists `mcp`.
- **Remote mode.** It passes neither option, so its welcome is byte-for-byte what it was. `smoke:client` checks it in Task 8.

- [ ] **Step 1: The test**

```diff
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index fa12b2a..734a9ba 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -381,9 +381,12 @@ test('project.delete ends the project topic for its subscribers, before the serv
   assert.deepEqual(sent.map((m) => m.ended ? [m.topic, m.ended] : [m.topic, 'patch']), [[`project:${projectId}`, 'deleted'], ['server', 'patch']])
 })
 
-test('welcome capabilities: mcp while the listener is up, then what the server always has', () => {
+test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
   assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'])
   assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions', 'dequeue', 'agents'])
+  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'])
+  assert.deepEqual(welcomeCapabilities(true, true), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'local'])
+  assert.deepEqual(welcomeCapabilities(false, true), ['topicEnd', 'decisions', 'dequeue', 'agents', 'local'])
 })
 
 test('project.import accepts a project from importProjectFile', async (t) => {
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/serverV2.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"`

Expected: `# pass 36`, `# fail 1`, failing:
- welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server

- [ ] **Step 3: The implementation**

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index fd637ae..db47bb7 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -199,6 +199,7 @@ new optional field needs no capability: its absence says enough.
 | `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
 | `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
 | `agents` | `server.agents` lists the agents the server can launch (see Sessions) |
+| `local` | This is the machine's own local server (`trek-server start --local`): its path checks allow any path, so `server.addRepo` takes any repo the user picks and `project.import` any worktree path. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 458bd8b..19d85c1 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -4,7 +4,7 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 /** What this server always has. */
 export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue, CAPABILITY.agents]
 
-/** `mcp` while the MCP listener is up, then the features this server always has. */
-export function welcomeCapabilities(mcp: boolean): string[] {
-  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES]
+/** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
+export function welcomeCapabilities(mcp: boolean, local = false): string[] {
+  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES, ...(local ? [CAPABILITY.local] : [])]
 }
diff --git a/server/src/server.ts b/server/src/server.ts
index 6347eba..1207215 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -48,12 +48,19 @@ export interface TrekServer {
   sessions: SessionManager
   /** The trek-dev MCP endpoint, once it is listening (undefined if it is off or failed to start) */
   mcp?: McpListener
+  /**
+   * Settles once the MCP listener is up or has failed to start (at once without MCP), so
+   * a welcome sent after it lists `mcp` if the server will have it. Never rejects.
+   */
+  ready: Promise<void>
   shutdown(reason: string): void
 }
 
 export interface ServerOptions {
   /** Where the MCP config files go (`<dataDir>/mcp`); without it, sessions get no MCP access */
   mcpDir?: string
+  /** `trek-server start --local`: the welcome lists the `local` capability */
+  local?: boolean
 }
 
 export interface ProjectsSetup {
@@ -244,7 +251,7 @@ export function startServer(
             daemonVersion,
             serverId: store.config.serverId ?? '',
             serverName: store.config.name ?? '',
-            capabilities: welcomeCapabilities(trek.mcp !== undefined)
+            capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true)
           })
         } else {
           sendFrame(ws, {
@@ -321,7 +328,16 @@ export function startServer(
 
   let stopped = false
   const callers = new Map<string, ToolCall>()
-  const trek: TrekServer = { httpServer, ptys, hub, projects, poller, sessions, shutdown: (reason) => shutdown(reason) }
+  const trek: TrekServer = {
+    httpServer,
+    ptys,
+    hub,
+    projects,
+    poller,
+    sessions,
+    ready: Promise.resolve(),
+    shutdown: (reason) => shutdown(reason)
+  }
   if (access) {
     const caller = createToolCaller({ store, hub, projects, poller, sessions })
     const callerFor = (projectId: string): ToolCall => {
@@ -329,7 +345,7 @@ export function startServer(
       if (!call) callers.set(projectId, (call = caller(projectId)))
       return call
     }
-    startMcpListener({
+    trek.ready = startMcpListener({
       access,
       serverVersion: daemonVersion,
       contextFor: (projectId) => ({ instructions: MCP_INSTRUCTIONS, tools: MCP_TOOLS, call: callerFor(projectId) })
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index aebe1ba..ff984ea 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -42,7 +42,9 @@ export const CAPABILITY = {
   /** `session.dequeue` removes one queued prompt, compare-and-set */
   dequeue: 'dequeue',
   /** `server.agents` lists the agents the server can launch */
-  agents: 'agents'
+  agents: 'agents',
+  /** This is the machine's own local server (`trek-server start --local`): it takes any path the user picks */
+  local: 'local'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
```

- [ ] **Step 4: Verify**

Run the command from Step 2 → `# pass 37`, `# fail 0`.

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1434`, `# fail 0`. One test changed; none were added.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): the local capability, and ready once MCP has settled" \
  -m "Co-Authored-By: <model trailer>" \
  -- src/shared/protocolV2.ts server/src/capabilities.ts server/src/server.ts PROTOCOL.md scripts/serverV2.test.mjs
```

---

### Task 6: `trek-server start --local`

**Files:**
- Modify: `server/src/index.ts`, `server/README.md`

Decisions 4–9, 11 and 12. The order in `start`:
1. **The lock**, before anything in the profile is written. A refusal exits 3.
2. **Clean the profile:** delete a stale `local.json`, and write the first config.
3. **Register cleanup** on `exit`.
4. **Identity and the new token**, in the existing `store.update`.
5. **Host `127.0.0.1`, port `0`.**
6. **`listen`**, with the bound port in the log.
7. **`announceLocal`:** wait for `ready`, check the lock is still held, write `local.json`.

On SIGTERM or SIGINT, `local.json` goes first. Then the existing shutdown runs, and `exit` removes `local.json` again and releases the lock. Remote mode differs only in the startup line, which now shows the bound port. That is the same number as before.

`index.ts` runs at import, so these steps are checked by hand here and by `smoke:local` in Task 7.

- [ ] **Step 1: The implementation**

````diff
diff --git a/server/README.md b/server/README.md
index 33bd057..a76bbe4 100644
--- a/server/README.md
+++ b/server/README.md
@@ -180,6 +180,30 @@ For real use, install the systemd user unit (see comments in
 `trek-server.service`) so the server — and your Claude sessions — survive
 logout and restart on boot.
 
+### The app's local server
+
+```sh
+trek-server start --local     # or `trek-server --local`
+```
+
+The Trek app runs this itself for projects on this machine; you rarely need
+to. It keeps to its own profile, so it never shares files with a server you
+run by hand:
+
+- config `~/.config/trek-server/local/config.json`, projects and MCP files in
+  `<platform data dir>/local` (e.g. `~/Library/Application Support/trek-server/local`);
+- `127.0.0.1` on a port the OS picks;
+- a new token on every start, saved as `local` (hash only);
+- `~/.config/trek-server/local/local.json` (0600), written once it listens and
+  removed when it exits: `{port, pid, token, version, build}`;
+- `local.lock` beside it, holding the pid: a second `--local` start exits with
+  code 3 while that process lives; a dead one's lock is taken over;
+- any path is allowed (the welcome lists the `local` capability), since the
+  user picks paths on their own disk.
+
+To stop it: `kill $(jq .pid ~/.config/trek-server/local/local.json)`. Its
+sessions resume (`--resume`) the next time their worktree is loaded.
+
 ## Expose it with Caddy (TLS)
 
 The server binds loopback only and refuses public interfaces without TLS.
diff --git a/server/src/index.ts b/server/src/index.ts
index 5f9cb0a..b2b3c0f 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -1,12 +1,16 @@
-import { existsSync, statSync } from 'node:fs'
+import { existsSync, rmSync, statSync } from 'node:fs'
+import type { AddressInfo } from 'node:net'
 import { basename, resolve } from 'node:path'
-import { hostname } from 'node:os'
+import { homedir, hostname } from 'node:os'
+import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_TOKEN_NAME } from '../../src/shared/localServer'
 import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
 import { buildInfo } from './buildInfo'
-import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig } from './config'
+import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig, saveConfig } from './config'
 import type { Project } from '../../src/shared/model/types'
 import { ConfigStore } from './configStore'
 import { defaultDataDir, projectsDir } from './dataDir'
+import { acquireLock, holdsLock, releaseLock } from './localLock'
+import { localProfile, removeLocalInfo, writeLocalInfo, type LocalProfile } from './localProfile'
 import { projectsUsingRepo } from './projects/model'
 import { ProjectState } from './projects/state'
 import { ProjectStore } from './projects/store'
@@ -40,6 +44,8 @@ interface CliArgs {
   host?: string
   dataDir?: string
   insecure: boolean
+  /** `start --local`: the app's local server, with its own profile (see localProfile.ts) */
+  local: boolean
 }
 
 const USAGE = `Usage: trek-server [command] [options]
@@ -47,6 +53,7 @@ const USAGE = `Usage: trek-server [command] [options]
 
 Commands:
   start                Run the server (default)
+  start --local        Run the Trek app's local server (see --local)
   add [path]           Add the git repo at path (default: current directory)
   list                 List the configured repos
   remove [id|path]     Remove a repo by id or path (default: current directory)
@@ -63,6 +70,12 @@ Options:
   --host <host>     Interface to bind (default: config.host or 127.0.0.1)
   --insecure        Allow binding a non-loopback host without TLS
   --data-dir <path> start/remove: project storage (default: config.dataDir or platform dir)
+  --local           start: the app's local server. Its own config, data and lock under
+                    ~/.config/trek-server/local and <platform data dir>/local; 127.0.0.1
+                    on a random port; a new token on every start; any path allowed.
+                    Writes the port and token to local.json there (0600) while it runs.
+                    Takes none of --config, --data-dir, --port, --host, --insecure.
+                    Exits ${LOCAL_ALREADY_RUNNING_EXIT} if a local server is already running.
   --id <id>         add: repo id (default: slug of the directory name)
   --name <name>     add: display name (default: the directory name)
   -h, --help        Show this help
@@ -82,7 +95,8 @@ function parseArgs(argv: string[]): CliArgs {
     command: 'start',
     configPath: defaultConfigPath(),
     configExplicit: false,
-    insecure: false
+    insecure: false,
+    local: false
   }
   const value = (i: number, flag: string): string => {
     const next = argv[i]
@@ -134,6 +148,7 @@ function parseArgs(argv: string[]): CliArgs {
     } else if (arg === '--host') args.host = value(++i, arg)
     else if (arg === '--data-dir') args.dataDir = value(++i, arg)
     else if (arg === '--insecure') args.insecure = true
+    else if (arg === '--local') args.local = true
     else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
     else usageError(`Unknown argument: ${arg}`)
   }
@@ -141,6 +156,10 @@ function parseArgs(argv: string[]): CliArgs {
     args.command = wantHelp ? 'help' : 'version'
     return args
   }
+  if (args.local && args.command !== 'start') usageError('--local only applies to `start`')
+  if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
+    usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
+  }
   if ((args.port !== undefined || args.host !== undefined || args.insecure) && args.command !== 'start') {
     usageError('--port, --host and --insecure only apply to `start`')
   }
@@ -184,9 +203,19 @@ if (args.command === 'version') {
   process.exit(0)
 }
 
+/** `start --local`'s profile; its config and data dir replace the defaults. */
+const local: LocalProfile | undefined = args.local ? localProfile(homedir(), defaultDataDir()) : undefined
+if (local) {
+  args.configPath = local.configPath
+  // Never copy the trek-daemon config into the local profile.
+  args.configExplicit = true
+  args.dataDir = local.dataDir
+}
+
 function openStore(path: string): ConfigStore {
   try {
-    return new ConfigStore(path)
+    // The local server's guard allows any path: the user picks them on their own disk.
+    return new ConfigStore(path, { permissive: local !== undefined })
   } catch (err) {
     fail(`Cannot read ${path}: ${(err as Error).message}`)
   }
@@ -290,11 +319,28 @@ if (args.command === 'token') {
 }
 
 // start: every check runs before anything is written.
-if (listTokens(store.config).length === 0) {
+if (local) {
+  // The lock comes first: a second local server must not touch the profile.
+  const lock = acquireLock(local.lockPath)
+  if (!lock.ok) {
+    const pid = lock.holder > 0 ? ` (pid ${lock.holder})` : ''
+    console.error(`A local trek-server is already running${pid}. Its port and token are in ${local.infoPath}.`)
+    process.exit(LOCAL_ALREADY_RUNNING_EXIT)
+  }
+  if (lock.tookOver !== undefined) console.log(`Took over the lock of a local trek-server that is gone (pid ${lock.tookOver}).`)
+  // Holding the lock, any local.json is a dead server's: its port and token are stale.
+  rmSync(local.infoPath, { force: true })
+  if (!existsSync(local.configPath)) saveConfig(local.configPath, { repos: [] })
+  process.on('exit', () => {
+    removeLocalInfo(local.infoPath, process.pid)
+    releaseLock(local.lockPath)
+  })
+} else if (listTokens(store.config).length === 0) {
   fail(`No token configured. Run \`trek-server token\` first (config: ${args.configPath}).`)
 }
-const host = args.host ?? store.config.host ?? '127.0.0.1'
-const port = args.port ?? store.config.port ?? DEFAULT_DAEMON_PORT
+const host = local ? '127.0.0.1' : (args.host ?? store.config.host ?? '127.0.0.1')
+// The local server takes a port the OS picks; local.json says which.
+const port = local ? 0 : (args.port ?? store.config.port ?? DEFAULT_DAEMON_PORT)
 if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !args.insecure) {
   fail(
     `Refusing to bind ${host} without TLS. Put a TLS-terminating reverse proxy (Caddy) in front\n` +
@@ -308,12 +354,16 @@ if (readLegacyInPlace) {
 const config = store.config
 // --data-dir is remembered, so a later plain `trek-server remove` checks the same projects.
 const dataDir = args.dataDir === undefined ? undefined : resolve(args.dataDir)
-if (!config.serverId || !config.name || config.tokenHash || (dataDir !== undefined && config.dataDir !== dataDir)) {
+/** The local server's token, for local.json. Only its hash is saved, as for any token. */
+let localToken = ''
+if (local || !config.serverId || !config.name || config.tokenHash || (dataDir !== undefined && config.dataDir !== dataDir)) {
   try {
     store.update((c) => {
       ensureIdentity(c, hostname())
       migrateLegacyToken(c)
       if (dataDir !== undefined) c.dataDir = dataDir
+      // A new token on every start, replacing the last one: a token from an old local.json stops working.
+      if (local) localToken = addToken(c, LOCAL_TOKEN_NAME)
     })
   } catch (err) {
     fail(`Cannot update ${args.configPath}: ${(err as Error).message}`)
@@ -336,7 +386,7 @@ const server = startServer(
     store: projectFiles.files
   },
   // Absolute: agents read the config file from their own worktree's directory.
-  { mcpDir: resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir(), 'mcp') }
+  { mcpDir: resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir(), 'mcp'), local: local !== undefined }
 )
 store.watch()
 server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
@@ -348,23 +398,49 @@ server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
   process.exit(1)
 })
 server.httpServer.listen(port, host, () => {
+  const bound = (server.httpServer.address() as AddressInfo).port
   console.log(
-    `trek-server ${version} (build ${build}) "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${port}`
+    `trek-server ${version} (build ${build}) "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${bound}`
   )
   console.log(
     store.config.repos.length > 0
       ? `repos: ${store.config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`
-      : 'No repos registered yet. Add one with `trek-server add <path>`.'
+      : local
+        ? 'No repos registered yet.'
+        : 'No repos registered yet. Add one with `trek-server add <path>`.'
   )
   console.log(`projects: ${projectFiles.loaded.length} in ${projectFiles.dir}`)
+  if (local) void announceLocal(local, bound)
 })
 
+/**
+ * Writes local.json, the app's cue that the local server is ready. It waits for
+ * MCP to settle, so the app's first welcome lists `mcp` if the server has it.
+ */
+async function announceLocal(profile: LocalProfile, port: number): Promise<void> {
+  await server.ready
+  if (shuttingDown) return
+  // Two starts that took over the same stale lock at once: only the one holding it goes on.
+  if (!holdsLock(profile.lockPath)) {
+    console.error(`Another local trek-server took the lock ${profile.lockPath}; exiting.`)
+    process.exit(LOCAL_ALREADY_RUNNING_EXIT)
+  }
+  try {
+    writeLocalInfo(profile.infoPath, { port, pid: process.pid, token: localToken, version, build })
+  } catch (err) {
+    fail(`Cannot write ${profile.infoPath}: ${(err as Error).message}`)
+  }
+  console.log(`local: port and token in ${profile.infoPath}`)
+}
+
 const SHUTDOWN_FLUSH_MS = 200
 let shuttingDown = false
 for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.on(signal, () => {
     if (shuttingDown) return
     shuttingDown = true
+    // First, so the app stops connecting to a server that is going away.
+    if (local) removeLocalInfo(local.infoPath, process.pid)
     console.log(`\n${signal} — shutting down (all agent sessions will end)`)
     store.close()
     server.shutdown(signal)
````

- [ ] **Step 2: Typecheck and build**

Run: `npm --prefix server run typecheck && npm --prefix server run build 2>&1 | tail -1` → no errors; `trek-server 0.2.0, build <build>`.

- [ ] **Step 3: Try it by hand, in a temp HOME**

```bash
H=$(mktemp -d)
HOME=$H node server/dist/trek-server.cjs --local > $H/server.log 2>&1 &
sleep 2; cat $H/server.log
ls -l $H/.config/trek-server/local
cat $H/.config/trek-server/local/local.json
HOME=$H node server/dist/trek-server.cjs --local; echo "exit $?"
HOME=$H node server/dist/trek-server.cjs list --local >/dev/null 2>&1; echo "exit $?"
HOME=$H node server/dist/trek-server.cjs list --local 2>&1 | head -1
HOME=$H node server/dist/trek-server.cjs --local --port 7999 2>&1 | head -1
kill -TERM $(node -p "require('$H/.config/trek-server/local/local.json').pid"); sleep 1
tail -1 $H/server.log; ls $H/.config/trek-server/local; rm -rf $H
```

Expected, in order:
- The log:
  - `trek-server 0.2.0 (build <build>) "<hostname>" (<uuid>) listening on ws://127.0.0.1:<port>`
  - `No repos registered yet.`
  - `projects: 0 in <H>/Library/Application Support/trek-server/local/projects` (on Linux: `<H>/.local/share/trek-server/local/projects`)
  - `[mcp] trek-dev MCP listening on …`
  - `local: port and token in <H>/.config/trek-server/local/local.json`
- `config.json`, `local.json` and `local.lock`, all `-rw-------`.
- `local.json` holds `port` (the same as the log's), `pid`, `token`, `"version": "0.2.0"` and `"build": "<build>"`.
- `A local trek-server is already running (pid <pid>). Its port and token are in <H>/.config/trek-server/local/local.json.` and `exit 3`.
- `exit 2`, then ``--local only applies to `start` `` (the usage text follows it).
- `--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure`
- `SIGTERM — shutting down (all agent sessions will end)`, then only `config.json` is left.

The config now holds `tokens: [{name: "local", hash, createdAt}]` and `dataDir`, and no plaintext token.

- [ ] **Step 4: Remote mode unchanged**

Run: `(cd server && npm run smoke -- --built) 2>&1 | tail -1` → `SERVER SMOKE PASS`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1434`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): trek-server start --local" \
  -m "Co-Authored-By: <model trailer>" \
  -- server/src/index.ts server/README.md
```

---

### Task 6b: `trek-server stop --local`

**Files:**
- Create: `server/src/localStop.ts`
- Modify: `server/src/index.ts`, `server/README.md`
- Test: create `scripts/serverLocalStop.test.mjs`

Decision 4a (a user decision, added after Task 6).
- **What it signals.** It reads `local.json` and the lock's pid. It sends SIGTERM only when the lock's pid is alive and `local.json` names that same pid. The lock is the authority, since it is taken first and released last.
  - No live lock holder means not running (exit 0). A dead pid whose files are left is named, and the next start cleans them up. `stop` removes nothing itself, so it cannot race a start that is taking a stale lock over.
  - A live lock holder that `local.json` does not name is **unverified** (exit 1). The server may still be starting, before `announceLocal`, or the pid was reused (Risk 1). The message names the lock file to delete if no server runs.
  - `local.json` naming a live pid that does not hold the lock is a reused pid: not running, never signalled.
- **The wait.** After SIGTERM it polls, every 50 ms for up to 10 s (`STOP_TIMEOUT_MS`), until neither `local.json` nor the lock holds the pid. If the process dies first, it stops waiting, since the files are then gone or never will be. Then it exits 0 with `Stopped.`. On a timeout it exits 1. The CLI has nothing else to do, so the wait is a blocking sleep (`Atomics.wait`), and `index.ts` stays synchronous.
- **Usage.** `--local` applies to `start` and `stop`. `stop` without `--local` is a usage error (exit 2), and so is `stop --local` with any of the profile's options, as for `start`.
- `stopDecision` is pure and unit-tested. `stopLocal` is tested against a stand-in server process that writes both files and removes them on SIGTERM. `smoke:local` (Task 7) runs `stop --local` against the real bundle under both runtimes.

- [ ] **Step 1: The tests**

Create `scripts/serverLocalStop.test.mjs`:

```js
// scripts/serverLocalStop.test.mjs — `trek-server stop --local`: which pid it may signal, and the stop itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localProfile } from '../server/src/localProfile.ts'
import { stopDecision, stopLocal } from '../server/src/localStop.ts'

const info = (pid) => ({ port: 4000, pid, token: 't', version: '0.2.0', build: 'b' })
const alive = () => true
const dead = () => false

test('stopDecision: signal only a live pid that local.json names and the lock holds', () => {
  assert.deepEqual(stopDecision(info(10), 10, alive), { action: 'signal', pid: 10 })
})

test('stopDecision: no live lock holder is not running, naming a dead pid whose files are left', () => {
  assert.deepEqual(stopDecision(undefined, undefined, alive), { action: 'not-running' })
  assert.deepEqual(stopDecision(info(10), 10, dead), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(undefined, 10, dead), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(info(10), undefined, dead), { action: 'not-running', stale: 10 })
  // local.json names a live pid, but no lock holds it: a reused pid, never signalled.
  assert.deepEqual(stopDecision(info(10), undefined, alive), { action: 'not-running', stale: 10 })
  assert.deepEqual(stopDecision(info(10), 20, (pid) => pid === 10), { action: 'not-running', stale: 20 })
})

test('stopDecision: a live lock holder that local.json does not name is unverified', () => {
  assert.deepEqual(stopDecision(undefined, 10, alive), { action: 'unverified', pid: 10 })
  assert.deepEqual(stopDecision(info(20), 10, alive), { action: 'unverified', pid: 10 })
})

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-stop-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return localProfile(join(dir, 'home'), join(dir, 'data'))
}

/** A stand-in local server: writes the lock and local.json, and removes them on SIGTERM (unless `ignoreTerm`). */
async function fakeServer(t, profile, { ignoreTerm = false } = {}) {
  const code = `
    const fs = require('node:fs')
    fs.mkdirSync(${JSON.stringify(profile.dir)}, { recursive: true })
    fs.writeFileSync(${JSON.stringify(profile.lockPath)}, process.pid + '\\n')
    fs.writeFileSync(${JSON.stringify(profile.infoPath)}, JSON.stringify({ port: 4000, pid: process.pid, token: 't', version: '0.2.0', build: 'b' }))
    process.on('SIGTERM', () => {
      if (${ignoreTerm}) return
      fs.rmSync(${JSON.stringify(profile.infoPath)})
      setTimeout(() => { fs.rmSync(${JSON.stringify(profile.lockPath)}); process.exit(0) }, 100)
    })
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  const exited = new Promise((resolve) => child.on('exit', (c, s) => resolve(c ?? s)))
  t.after(() => child.kill('SIGKILL'))
  const deadline = Date.now() + 5000
  while (!(existsSync(profile.infoPath) && existsSync(profile.lockPath)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  return { child, exited }
}

const capture = () => {
  const lines = []
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(`E: ${l}`) }
}

test('stopLocal: SIGTERMs the server and waits for local.json and the lock to go', async (t) => {
  const profile = setup(t)
  const { child, exited } = await fakeServer(t, profile)
  const out = capture()
  assert.equal(stopLocal(profile, out), 0)
  assert.equal(await exited, 0)
  assert.equal(existsSync(profile.infoPath) || existsSync(profile.lockPath), false)
  assert.deepEqual(out.lines, [`Stopping the local trek-server (pid ${child.pid})…`, 'Stopped.'])
})

test('stopLocal: nothing running is exit 0', (t) => {
  const profile = setup(t)
  const out = capture()
  assert.equal(stopLocal(profile, out), 0)
  assert.deepEqual(out.lines, ['No local trek-server is running.'])
})

test('stopLocal: an unverified lock holder is never signalled', (t) => {
  const profile = setup(t)
  // The lock holds this test's (live) pid, and there is no local.json.
  mkdirSync(profile.dir, { recursive: true })
  writeFileSync(profile.lockPath, `${process.pid}\n`)
  const kills = []
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, kill: (pid, sig) => kills.push([pid, sig]) }), 1)
  assert.deepEqual(kills, [])
  assert.match(out.lines[0], /^E: .*is held by pid \d+, but .* does not name it/)
  assert.equal(existsSync(profile.lockPath), true, 'the lock is left alone')
})

test('stopLocal: a server that ignores SIGTERM times out with exit 1', async (t) => {
  const profile = setup(t)
  const { child } = await fakeServer(t, profile, { ignoreTerm: true })
  const out = capture()
  assert.equal(stopLocal(profile, { ...out, timeoutMs: 300 }), 1)
  assert.equal(out.lines.at(-1), `E: The local trek-server (pid ${child.pid}) did not stop within 0.3 s.`)
})
```

Run: `node --test scripts/serverLocalStop.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → it fails: `localStop.ts` does not exist.

- [ ] **Step 2: The implementation**

Create `server/src/localStop.ts`:

```ts
// `trek-server stop --local`: SIGTERM the local server named by local.json, and
// wait for it to remove local.json and its lock. The lock is the authority on
// which process is the server: it is taken before anything else and released
// last. The pid is signalled only if local.json names it and the lock holds it,
// so a pid reused by an unrelated process is never signalled.
import type { LocalInfo } from '../../src/shared/localServer.ts'
import { pidAlive, readLockPid } from './localLock.ts'
import { readLocalInfo, type LocalProfile } from './localProfile.ts'

export type StopDecision =
  /** local.json names a live pid that holds the lock: the server */
  | { action: 'signal'; pid: number }
  /** No live lock holder. `stale` is a dead pid whose files are left (the next start cleans them up). */
  | { action: 'not-running'; stale?: number }
  /** A live pid holds the lock but local.json does not name it: still starting, or a reused pid */
  | { action: 'unverified'; pid: number }

/** What `stop --local` does, given local.json (or undefined), the lock's pid (or undefined), and a liveness check. */
export function stopDecision(info: LocalInfo | undefined, lock: number | undefined, alive: (pid: number) => boolean): StopDecision {
  if (lock !== undefined && alive(lock)) {
    return info?.pid === lock ? { action: 'signal', pid: lock } : { action: 'unverified', pid: lock }
  }
  const stale = lock ?? info?.pid
  return stale === undefined ? { action: 'not-running' } : { action: 'not-running', stale }
}

export interface StopOptions {
  /** How long to wait for the server to clean up after SIGTERM */
  timeoutMs?: number
  pollMs?: number
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  log?: (line: string) => void
  error?: (line: string) => void
}

export const STOP_TIMEOUT_MS = 10_000

/** A blocking sleep: the CLI has nothing else to do while it waits. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Stops the local server. Returns the exit code: 0 once it stopped (or if none
 * was running), 1 on a timeout, an unverified lock, or a failed signal.
 */
export function stopLocal(profile: LocalProfile, options: StopOptions = {}): number {
  const {
    timeoutMs = STOP_TIMEOUT_MS,
    pollMs = 50,
    alive = pidAlive,
    kill = (pid, signal) => process.kill(pid, signal),
    log = console.log,
    error = console.error
  } = options
  const decision = stopDecision(readLocalInfo(profile.infoPath), readLockPid(profile.lockPath), alive)
  if (decision.action === 'not-running') {
    log(
      decision.stale === undefined
        ? 'No local trek-server is running.'
        : `No local trek-server is running (pid ${decision.stale} is gone; it left files in ${profile.dir} that the next start cleans up).`
    )
    return 0
  }
  if (decision.action === 'unverified') {
    error(
      `${profile.lockPath} is held by pid ${decision.pid}, but ${profile.infoPath} does not name it: ` +
        'the server may still be starting, or the pid now belongs to another process. Not signalling it.\n' +
        `Try again in a moment. If no trek-server is running, delete ${profile.lockPath}.`
    )
    return 1
  }
  const { pid } = decision
  try {
    kill(pid, 'SIGTERM')
  } catch (err) {
    // ESRCH: it exited between the check and the signal; the wait below sees that.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      error(`Cannot signal the local trek-server (pid ${pid}): ${(err as Error).message}`)
      return 1
    }
  }
  log(`Stopping the local trek-server (pid ${pid})…`)
  const filesGone = (): boolean => readLocalInfo(profile.infoPath)?.pid !== pid && readLockPid(profile.lockPath) !== pid
  const deadline = Date.now() + timeoutMs
  // The server removes both files on its way out, so once it is dead they are gone or never will be.
  while (!filesGone() && alive(pid) && Date.now() < deadline) sleepSync(pollMs)
  if (filesGone()) {
    log('Stopped.')
    return 0
  }
  if (!alive(pid)) {
    log(`Stopped, but it left files in ${profile.dir}; the next start cleans them up.`)
    return 0
  }
  error(`The local trek-server (pid ${pid}) did not stop within ${timeoutMs / 1000} s.`)
  return 1
}
```

````diff
diff --git a/server/README.md b/server/README.md
index a76bbe4..43dbd43 100644
--- a/server/README.md
+++ b/server/README.md
@@ -201,8 +201,18 @@ run by hand:
 - any path is allowed (the welcome lists the `local` capability), since the
   user picks paths on their own disk.
 
-To stop it: `kill $(jq .pid ~/.config/trek-server/local/local.json)`. Its
-sessions resume (`--resume`) the next time their worktree is loaded.
+To stop it:
+
+```sh
+trek-server stop --local
+```
+
+It sends SIGTERM to the pid in `local.json`, but only if `local.lock` holds
+that same pid, so it never signals an unrelated process that reused it. Then
+it waits up to 10 s for both files to go. It exits 0 once the server has
+stopped, or if none was running, and 1 if it timed out or could not tell
+which process is the server. The server's sessions resume (`--resume`) the
+next time their worktree is loaded.
 
 ## Expose it with Caddy (TLS)
 
diff --git a/server/src/index.ts b/server/src/index.ts
index b2b3c0f..0a1d570 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -11,6 +11,7 @@ import { ConfigStore } from './configStore'
 import { defaultDataDir, projectsDir } from './dataDir'
 import { acquireLock, holdsLock, releaseLock } from './localLock'
 import { localProfile, removeLocalInfo, writeLocalInfo, type LocalProfile } from './localProfile'
+import { stopLocal } from './localStop'
 import { projectsUsingRepo } from './projects/model'
 import { ProjectState } from './projects/state'
 import { ProjectStore } from './projects/store'
@@ -25,7 +26,7 @@ import {
   revokeToken
 } from './tokens'
 
-const COMMANDS = ['start', 'token', 'add', 'list', 'remove', 'help', 'version'] as const
+const COMMANDS = ['start', 'stop', 'token', 'add', 'list', 'remove', 'help', 'version'] as const
 const TOKEN_ACTIONS = ['add', 'list', 'revoke'] as const
 
 interface CliArgs {
@@ -44,7 +45,7 @@ interface CliArgs {
   host?: string
   dataDir?: string
   insecure: boolean
-  /** `start --local`: the app's local server, with its own profile (see localProfile.ts) */
+  /** `start --local`: the app's local server, with its own profile (see localProfile.ts). `stop --local` stops it. */
   local: boolean
 }
 
@@ -54,6 +55,7 @@ const USAGE = `Usage: trek-server [command] [options]
 Commands:
   start                Run the server (default)
   start --local        Run the Trek app's local server (see --local)
+  stop --local         Stop the local server: SIGTERM, then wait for it to exit
   add [path]           Add the git repo at path (default: current directory)
   list                 List the configured repos
   remove [id|path]     Remove a repo by id or path (default: current directory)
@@ -70,7 +72,7 @@ Options:
   --host <host>     Interface to bind (default: config.host or 127.0.0.1)
   --insecure        Allow binding a non-loopback host without TLS
   --data-dir <path> start/remove: project storage (default: config.dataDir or platform dir)
-  --local           start: the app's local server. Its own config, data and lock under
+  --local           start/stop: the app's local server. Its own config, data and lock under
                     ~/.config/trek-server/local and <platform data dir>/local; 127.0.0.1
                     on a random port; a new token on every start; any path allowed.
                     Writes the port and token to local.json there (0600) while it runs.
@@ -156,7 +158,8 @@ function parseArgs(argv: string[]): CliArgs {
     args.command = wantHelp ? 'help' : 'version'
     return args
   }
-  if (args.local && args.command !== 'start') usageError('--local only applies to `start`')
+  if (args.local && args.command !== 'start' && args.command !== 'stop') usageError('--local only applies to `start` and `stop`')
+  if (args.command === 'stop' && !args.local) usageError('`stop` only stops the local server: `trek-server stop --local`')
   if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
     usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
   }
@@ -212,6 +215,8 @@ if (local) {
   args.dataDir = local.dataDir
 }
 
+if (args.command === 'stop' && local) process.exit(stopLocal(local))
+
 function openStore(path: string): ConfigStore {
   try {
     // The local server's guard allows any path: the user picks them on their own disk.
````

- [ ] **Step 3: Verify**

Run the command from Step 1 → `# pass 7`, `# fail 0`.

Run: `npm --prefix server run typecheck && npm --prefix server run build 2>&1 | tail -1` → no errors; `trek-server 0.2.0, build <build>`.

Try it by hand:

```bash
H=$(mktemp -d)
HOME=$H node server/dist/trek-server.cjs stop --local; echo "exit $?"
HOME=$H node server/dist/trek-server.cjs stop 2>&1 | head -1
HOME=$H node server/dist/trek-server.cjs --local > $H/server.log 2>&1 &
sleep 2; ls $H/.config/trek-server/local
HOME=$H node server/dist/trek-server.cjs stop --local; echo "exit $?"
ls $H/.config/trek-server/local; tail -1 $H/server.log; rm -rf $H
```

Expected, in order:
- `No local trek-server is running.` and `exit 0`.
- `` `stop` only stops the local server: `trek-server stop --local` `` (exit 2).
- `config.json`, `local.json` and `local.lock`.
- `Stopping the local trek-server (pid <pid>)…`, `Stopped.` and `exit 0`.
- Only `config.json` is left, and the log ends `SIGTERM — shutting down (all agent sessions will end)`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1441`, `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add server/src/localStop.ts scripts/serverLocalStop.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "feat(server): trek-server stop --local" \
  -m "Co-Authored-By: <model trailer>" \
  -- server/src/localStop.ts server/src/index.ts server/README.md scripts/serverLocalStop.test.mjs docs/superpowers/plans/2026-11-08-central-server-phase4a-local-server.md
```

---

### Task 7: `smoke:local`: the bundle under Node and under Electron's Node

**Files:**
- Create: `scripts/local-server-smoke.mjs`
- Modify: `package.json`, `server/README.md`

**The layout.** For each runtime the smoke builds the app's layout in a temp directory:
- `out/server/trek-server.cjs`, copied from `server/dist`;
- `node_modules/node-pty`, a link to the repo root's.

There is no `ws`, `@xterm/headless` or `package.json` anywhere it could resolve, and `NODE_PATH` is unset.

**The runtimes:** `process.execPath`, then `require('electron')` with `ELECTRON_RUN_AS_NODE=1`. Pass `--node-only` or `--electron-only` to run just one.

**The environment:** a temp `HOME` and `XDG_DATA_HOME`. The local config is pre-seeded with a fake `claude` command that echoes its arguments and then sleeps. The repo sits at `elsewhere/deep/repo`, with nothing registered near it.

**What it checks, 30 times per runtime:**
1. `--local --port` is a usage error, exit 2.
2. `local.json` appears with the server's pid. It is 0600, its version and build match `dist/build.json`, the lock holds the pid, and the log's port matches.
3. A hello with its token is welcomed, and the first welcome lists `local` and `mcp` (`ready`, Decision 9).
4. `server.addRepo` takes the out-of-root repo, and a project is created on it. A session through `node-pty` prints `--session-id`.
5. A second start exits 3, "already running (pid A)", and leaves `local.json` and the lock alone.
6. `stop --local` (Task 6b) exits 0 with `Stopped.`. The server exits 0, and `local.json` and the lock are gone. A second `stop --local` exits 0: not running.
7. A third start, then SIGKILL: the stale `local.json` and lock stay.
8. A fourth start takes over. It logs the dead pid, the lock holds the new pid, and the token is new. The dead server's token gets `needs-auth`; the new one is welcomed.
9. The session from step 4 is still listed, with its agent session id and no pty. `worktree.load` resumes it, and the agent prints `--resume <id>`.
10. A final SIGTERM: exit 0, and both files are gone.

- [ ] **Step 1: The smoke**

Create `scripts/local-server-smoke.mjs`:

```js
// Smoke for `trek-server start --local`, run from the built bundle the way the
// app will run it (phase 4b): copied into a bare out/server with only node-pty
// beside it (no server/node_modules), in a temp HOME, under Node and then under
// Electron's Node (ELECTRON_RUN_AS_NODE=1). For each runtime: local.json (0600,
// its fields, the build), a welcome with `local` and `mcp`, a repo registered
// outside any root, a session on a fake agent through node-pty, a second start
// refused by the lock, `stop --local` and SIGTERM's cleanup, a SIGKILLed
// server's stale lock taken over with a new token, and the session resumed with
// --resume.
//
//   node scripts/local-server-smoke.mjs [--node-only | --electron-only]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, TopicMirror, globalSocketFactory } from '../src/shared/client/index.ts'
import { LOCAL_ALREADY_RUNNING_EXIT, parseLocalInfo } from '../src/shared/localServer.ts'

const WAIT_MS = 15000
const root = new URL('..', import.meta.url).pathname
const bundle = join(root, 'server', 'dist', 'trek-server.cjs')
const built = JSON.parse(readFileSync(join(root, 'server', 'dist', 'build.json'), 'utf8'))

const runtimes = [
  { name: 'node', cmd: process.execPath, env: {} },
  { name: 'electron', cmd: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
].filter((r) => !process.argv.includes(r.name === 'node' ? '--electron-only' : '--node-only'))

let checks = 0
let failed = false
const ok = (msg) => { checks++; console.log(`ok: ${msg}`) }
const fail = (msg) => { checks++; failed = true; console.error(`FAIL: ${msg}`) }
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(detail ? `${msg}: ${detail}` : msg))

/** Resolves true once `pred()` holds, false after `ms`. */
const waitFor = async (pred, ms = WAIT_MS) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  return pred()
}

/** Thrown to skip the rest of a runtime's checks after one they depend on. */
class Abort extends Error {}
const must = (cond, msg, detail = '') => {
  check(cond, msg, detail)
  if (!cond) throw new Abort(msg)
}

async function suite(rt) {
  console.log(`--- ${rt.name} (${rt.cmd}) ---`)
  const work = realpathSync(mkdtempSync(join(tmpdir(), `trek-local-smoke-${rt.name}-`)))
  const home = join(work, 'home')
  // The app's layout: out/server/trek-server.cjs, and node-pty in the app's node_modules.
  const app = join(work, 'app')
  mkdirSync(join(app, 'out', 'server'), { recursive: true })
  mkdirSync(join(app, 'node_modules'))
  const cli = join(app, 'out', 'server', 'trek-server.cjs')
  copyFileSync(bundle, cli)
  symlinkSync(join(root, 'node_modules', 'node-pty'), join(app, 'node_modules', 'node-pty'))
  const env = { ...process.env, ...rt.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }
  // Only the app's node_modules may resolve: no NODE_PATH fallback.
  delete env.NODE_PATH
  const profile = join(home, '.config', 'trek-server', 'local')
  const infoPath = join(profile, 'local.json')
  const lockPath = join(profile, 'local.lock')

  // A fake agent that prints its arguments and lingers until it is killed.
  const fakeAgent = join(work, 'fake-agent.sh')
  writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nexec sleep 300\n', { mode: 0o755 })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
  // A repo with no registered repo anywhere near it.
  const repo = join(work, 'elsewhere', 'deep', 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@s' }
  })

  const children = []
  const conns = []
  const start = () => {
    const child = spawn(rt.cmd, [cli, 'start', '--local'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const run = { child, out: '', err: '', code: undefined }
    child.stdout.on('data', (d) => { run.out += d })
    child.stderr.on('data', (d) => { run.err += d })
    run.exited = new Promise((resolve) => child.on('exit', (code, signal) => { run.code = code ?? signal; resolve(run.code) }))
    children.push(run)
    return run
  }
  /** Runs a short CLI command to its end without blocking the event loop (the servers' output keeps flowing). */
  const runCli = (argv) =>
    new Promise((resolve) => {
      const p = spawn(rt.cmd, [cli, ...argv], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('exit', (code) => resolve({ code, out, err }))
    })
  const info = () => {
    try {
      return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
    } catch {
      return undefined
    }
  }
  const lockPid = () => (existsSync(lockPath) ? Number(readFileSync(lockPath, 'utf8').trim()) : undefined)
  const connect = async (port, token, name) => {
    const conn = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: `local-smoke-${name}` })
    conns.push(conn)
    conn.connect()
    await waitFor(() => conn.status === 'connected' || conn.status === 'needs-auth', 5000)
    return conn
  }
  const stopAll = async () => {
    for (const c of conns.splice(0)) c.close()
    for (const r of children) if (r.code === undefined) r.child.kill('SIGKILL')
    await Promise.all(children.map((r) => r.exited))
  }

  try {
    // --- 1. --local takes no profile options ---
    const refused = spawnSync(rt.cmd, [cli, 'start', '--local', '--port', '7999'], { env, encoding: 'utf8' })
    check(refused.status === 2 && refused.stderr.includes('--local has its own config'), '--local with --port is a usage error (exit 2)', `${refused.status} ${refused.stderr.slice(0, 200)}`)

    // --- 2. start: local.json ---
    const a = start()
    must(await waitFor(() => info()?.pid === a.child.pid || a.code !== undefined), 'local.json appears with the server\'s pid', `code ${a.code}, ${a.err}`)
    const infoA = info()
    check((statSync(infoPath).mode & 0o777) === 0o600, 'local.json is 0600', (statSync(infoPath).mode & 0o777).toString(8))
    check(infoA.version === built.version && infoA.build === built.build, `local.json has the bundle's version and build (${infoA.version}, ${infoA.build})`, JSON.stringify(infoA))
    check(lockPid() === a.child.pid, 'local.lock holds the pid')
    check(a.out.includes(`listening on ws://127.0.0.1:${infoA.port}`), 'it listens on 127.0.0.1 at the port in local.json', a.out)

    // --- 3. the welcome ---
    const conn = await connect(infoA.port, infoA.token, 'a')
    must(conn.status === 'connected', 'a hello with the local.json token is welcomed', `${conn.status} ${conn.statusMessage}`)
    const caps = conn.welcome.capabilities
    check(caps.includes('local') && caps.includes('mcp'), `the first welcome lists local and mcp (${caps.join(',')})`)

    // --- 4. a repo outside any root, a project, a session through node-pty ---
    let repoId
    try {
      repoId = (await conn.request('server.addRepo', { path: repo })).repoId
      ok(`server.addRepo takes ${repo} (repo "${repoId}")`)
    } catch (err) {
      must(false, 'server.addRepo outside any root', `${err.code} ${err.message}`)
    }
    const { projectId } = await conn.request('project.create', { name: 'Local', repositories: [{ path: repo }] })
    const mirror = new TopicMirror(conn)
    let project = null
    mirror.subscribe(`project:${projectId}`, (u) => { if (!('error' in u)) project = u.snapshot })
    const mainWt = () => project?.repositories[0]?.worktrees.find((w) => w.isMain)
    must(await waitFor(() => !!mainWt()), 'the project topic has the main worktree')
    const started = await conn.request('session.start', { projectId, worktreeId: mainWt().id, cols: 80, rows: 24 })
    const ptys = new PtyStream(conn)
    let text = ''
    await ptys.attach(started.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
    must(await waitFor(() => /FAKE_AGENT .*--session-id (\S+)/.test(text)), `node-pty runs the agent under ${rt.name}: it printed --session-id`, JSON.stringify(text))
    const agentSessionId = /--session-id (\S+)/.exec(text)[1]

    // --- 5. a second start is refused by the lock ---
    const b = start()
    await b.exited
    check(b.code === LOCAL_ALREADY_RUNNING_EXIT && b.err.includes(`already running (pid ${a.child.pid})`), `a second --local start exits ${LOCAL_ALREADY_RUNNING_EXIT}: already running`, `${b.code} ${b.err}`)
    check(info()?.pid === a.child.pid && lockPid() === a.child.pid, "the refused start leaves local.json and the lock alone")

    // --- 6. stop --local: SIGTERM, and the cleanup ---
    for (const c of conns.splice(0)) c.close()
    const stopped = await runCli(['stop', '--local'])
    await Promise.race([a.exited, new Promise((r) => setTimeout(r, 5000))])
    check(stopped.code === 0 && stopped.out.includes(`Stopping the local trek-server (pid ${a.child.pid})`) && stopped.out.includes('Stopped.'), 'stop --local stops it: exit 0, "Stopped."', `${stopped.code} ${stopped.out} ${stopped.err}`)
    check(a.code === 0, 'SIGTERM: the server exits 0', String(a.code))
    check(!existsSync(infoPath) && !existsSync(lockPath), 'SIGTERM removes local.json and local.lock')
    const again = await runCli(['stop', '--local'])
    check(again.code === 0 && again.out.includes('No local trek-server is running.'), 'stop --local with none running: exit 0, "not running"', `${again.code} ${again.out} ${again.err}`)

    // --- 7. a SIGKILLed server leaves a stale lock and local.json ---
    const c = start()
    must(await waitFor(() => info()?.pid === c.child.pid || c.code !== undefined), 'a third start writes local.json', c.err)
    const infoC = info()
    c.child.kill('SIGKILL')
    await c.exited
    check(info()?.pid === c.child.pid && lockPid() === c.child.pid, 'SIGKILL leaves local.json and local.lock behind')

    // --- 8. the next start takes the stale lock over, with a new token ---
    const d = start()
    must(await waitFor(() => info()?.pid === d.child.pid || d.code !== undefined), 'the next start takes over and writes local.json', `code ${d.code}, ${d.err}`)
    const infoD = info()
    check(d.out.includes(`Took over the lock of a local trek-server that is gone (pid ${c.child.pid})`), 'it reports the dead pid it took over', d.out)
    check(lockPid() === d.child.pid, 'local.lock now holds the new pid')
    check(infoD.token !== infoC.token, 'a new token on every start')
    const stale = await connect(infoD.port, infoC.token, 'stale')
    check(stale.status === 'needs-auth', "the dead server's token is refused", stale.status)
    const connD = await connect(infoD.port, infoD.token, 'd')
    must(connD.status === 'connected', 'the new token is welcomed', `${connD.status} ${connD.statusMessage}`)

    // --- 9. the session from before the SIGTERM resumes ---
    const mirrorD = new TopicMirror(connD)
    let projectD = null
    mirrorD.subscribe(`project:${projectId}`, (u) => { if (!('error' in u)) projectD = u.snapshot })
    const wtD = () => projectD?.repositories[0]?.worktrees.find((w) => w.isMain)
    const row = () => wtD()?.sessions.find((s) => s.id === started.sessionId)
    must(await waitFor(() => !!row()), 'the session is still listed after the restart', JSON.stringify(projectD))
    check(row().agentSessionId === agentSessionId && row().ptyId === undefined, `it kept its agent session id and has no pty (status ${row().status}, loaded ${wtD().loaded})`, JSON.stringify(row()))
    await connD.request('worktree.load', { projectId, worktreeId: wtD().id })
    must(await waitFor(() => !!row()?.ptyId), 'worktree.load gives it a pty', JSON.stringify(row()))
    let resumed = ''
    await new PtyStream(connD).attach(row().ptyId, { onData: (x) => { resumed += x }, onExit: () => {}, onReset: () => {}, onError: () => {} })
    check(await waitFor(() => resumed.includes(`--resume ${agentSessionId}`)), 'the agent is resumed with --resume and its session id', JSON.stringify(resumed))

    for (const x of conns.splice(0)) x.close()
    d.child.kill('SIGTERM')
    await d.exited
    check(d.code === 0 && !existsSync(infoPath) && !existsSync(lockPath), 'SIGTERM again: exit 0, local.json and local.lock gone')
  } catch (err) {
    if (!(err instanceof Abort)) fail(`${rt.name}: ${err.stack ?? err}`)
    for (const r of children) if (r.err) console.error(`[${rt.name} pid ${r.child.pid} stderr]\n${r.err}`)
  } finally {
    await stopAll()
    rmSync(work, { recursive: true, force: true })
  }
}

for (const rt of runtimes) await suite(rt)
console.log(failed ? `LOCAL SMOKE FAIL (${checks} checks)` : `LOCAL SMOKE PASS (${checks} checks)`)
process.exit(failed ? 1 : 0)
```

```diff
diff --git a/package.json b/package.json
index 0f977fd..f246c34 100644
--- a/package.json
+++ b/package.json
@@ -23,6 +23,7 @@
     "smoke:providers": "npm run build && node scripts/providers-smoke.mjs",
     "smoke:client": "npm --prefix server run build && node scripts/client-contract.mjs",
     "smoke:v2": "npm run build && npm --prefix server run build && node scripts/v2-smoke.mjs",
+    "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
     "rebuild": "electron-rebuild -f -w node-pty",
     "dist": "electron-vite build && electron-builder --mac --arm64"
   },
diff --git a/server/README.md b/server/README.md
index 43dbd43..14a5869 100644
--- a/server/README.md
+++ b/server/README.md
@@ -254,3 +254,7 @@ npm run smoke -- --built      # against dist/trek-server.cjs (run npm run build
 
 Starts a throwaway server on loopback with a temp repo, exercises the
 handshake, git listing, and a pty spawn/echo/kill round trip.
+
+`npm run smoke:local` at the repo root builds the bundle and checks
+`start --local` from a bare copy of it, under Node and under Electron's Node
+(`ELECTRON_RUN_AS_NODE=1`), the way the app runs it.
```

- [ ] **Step 2: Run it**

Run: `npm run smoke:local 2>&1 | grep -E "^(---|FAIL|LOCAL)"`

Expected:

```
--- node (<node path>) ---
--- electron (<repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron) ---
LOCAL SMOKE PASS (60 checks)
```

The Electron half includes `ok: node-pty runs the agent under electron: it printed --session-id`. That shows Electron's Node loads the root's `node-pty` from the app's layout, which is the runtime 4b will use.

- [ ] **Step 3: Commit**

```bash
git add scripts/local-server-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit \
  -m "test: smoke:local, the local server's bundle under Node and Electron's Node" \
  -m "Co-Authored-By: <model trailer>" \
  -- scripts/local-server-smoke.mjs package.json server/README.md
```

---

### Task 8: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1441`, `# fail 0`. That is the baseline 1412 at `6940af0`, plus:

| Task | Tests added |
|---|---|
| 1 | 3 |
| 2 | 6 |
| 3 | 7 |
| 4 | 6: 2 in `serverPaths`, 1 each in `serverConfigStore` and `serverImportCheck`, 2 in `serverV2` |
| 5 | 0 (one test changed) |
| 6b | 7: 3 for `stopDecision`, 4 for `stopLocal` |

- [ ] **Step 2: Types and build**

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors. Run: `npm run build && npm --prefix server run build` → both succeed. The server build prints `trek-server 0.2.0, build <build>`.

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous has exited:

| Command | Expected |
|---|---|
| `(cd server && npm run smoke -- --built) 2>&1 \| tail -1` | `SERVER SMOKE PASS` |
| `node scripts/client-contract.mjs 2>&1 \| tail -1` | `CLIENT CONTRACT PASS` |
| `node scripts/local-server-smoke.mjs 2>&1 \| tail -1` | `LOCAL SMOKE PASS (60 checks)` |
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (168 checks)` |
| `node scripts/remote-smoke.mjs 2>&1 \| tail -1` | `REMOTE SMOKE PASS` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/changes-smoke.mjs 2>&1 \| tail -1` | `12/12 checks passed` |
| `node scripts/multi-repo-smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |

- [ ] **Step 4: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for 4b

Found while prototyping this plan.

1. **Spawning.**
   - The command is `spawn(process.execPath, [<out/server/trek-server.cjs>, 'start', '--local'], {detached: true, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', log, log]})`, then `unref()`.
   - The server logs only to stdout and stderr, so give it a log file, for example `~/.config/trek-server/local/server.log`. Nothing rotates it.
   - An exit of 3 means another start holds the lock: read `local.json` and use that server.
2. **Ready and alive.**
   - Ready means `local.json` exists with the spawned pid, and `parseLocalInfo` accepts it.
   - Alive means `local.json` exists, its pid answers signal 0, and a hello with its token is welcomed.
   - A `local.json` whose pid is dead is a crash. The next start deletes it.
3. **Skew.** Compare `local.json`'s `version` and `build` with `out/server/build.json`, which Task 1 writes as `server/dist/build.json`. 4b's build step must copy both files. A source run reports `build: "dev"`.
4. **Stopping.**
   - On macOS and Linux, SIGTERM the pid in `local.json`, then wait for `local.json` to go. `trek-server stop --local` (Task 6b) does this, with the lock check; 4b can run it or do the same in main.
   - On Windows, `process.kill` terminates the process without running its handlers, so `local.json` and the lock stay behind. The next start takes them over. A Windows stop may want a `stop` RPC, or a CLI `stop` that the server handles itself.
5. **The token changes on every start** (Decision 8). The synthetic `local` entry must re-read `local.json` before each connect, and again after `needs-auth`. It must never store the token.
6. **A lock stuck on a reused pid** (Risk 1). If a start exits 3, but `local.json` is missing or its hello fails for some seconds, the lock's pid is not a trek-server. Offer "Reset local server", which deletes `local.lock` and starts again.
7. **Packaged runs.** This plan ran the bundle unpacked. In a packaged app `out/server` sits inside `app.asar`. Electron's Node reads asar in `ELECTRON_RUN_AS_NODE` mode, and `node-pty` is already unpacked, but check it in a `dist` build, or add `out/server/**` to `asarUnpack`.
8. **`capabilities` includes `local`.** The renderer can show the folder picker on it. Don't infer it from the URL (Decision 14).

## Risks

1. **Pid reuse.** If a SIGKILLed or crashed server's pid is later reused by another live process, a `--local` start refuses: exit 3, "already running", until `local.lock` is deleted. Liveness is signal 0 only. There is no portable way to check what process holds a pid. The message names the files, and 4b can offer a reset (Notes for 4b, 6).
2. **Two starts taking over the same stale lock at the same instant** both go on until `announceLocal`. There the one that lost exits 3 before writing `local.json` (Decision 12). Until then, both have rotated the token and opened the profile's config, and the last token written wins. The app's single-instance lock makes this a CLI-versus-app race, at a moment when no server was running.
3. **Only macOS was prototyped.**
   - Linux uses the same code paths, with `XDG_DATA_HOME` for the data dir.
   - On Windows:
     - SIGTERM runs no handler (Notes for 4b, 4);
     - `linkSync` needs NTFS;
     - the 0600 and 0700 modes mean little.
4. **The permissive guard** lets the local server's token holder name any path as the server user. That is the same trust as the user's own shell. The token is only in a 0600 file under a 0700 directory, and only on loopback. Any process running as the user can read it, and as that user it could already do the same.
5. **A client holding the last token gets `needs-auth` after a restart** (Decision 8), until it re-reads `local.json`.
6. **`local.json` waits for MCP to settle.** `startMcpListener` resolves on `listen` and rejects on an error. If it ever hung, `local.json` would never be written, and 4b's ready wait needs a timeout.
7. **The bundle grew** from 522 KB to 645 KB (esbuild's figures) with `ws`.
8. **`trek-server version` prints the version only.** The build id is in the startup line, `local.json` and `dist/build.json`.

## Questions for the user

1. **A new token on every start** (Decision 8). Planned: the local token rotates on each start and lives only in `local.json` while the server runs. The alternative is a stable token, kept in plaintext in a 0600 file in the profile, so a client never sees `needs-auth` after a restart. Keep rotation?
2. **No `trek-server stop --local`** (Decision 4). The 4b supervisor would SIGTERM the pid itself. Add the command now anyway, for people running it by hand and for a later Windows stop?
