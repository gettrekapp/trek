# Central server phase 5a-2: Docker, the environments and the dev stacks on the server's machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Docker, the per-worktree Colima environments and the dev stacks run on the server's machine, through the server, in every server window (the spec: "Docker / env / stacks (phase 5) act on the server's machine").
1. **The protocol.** Three capabilities, `docker`, `env` and `stacks`; the methods `docker.list`, `docker.container`, `docker.compose`, `env.check`, `env.list`, `env.up`, `env.stop`, `env.destroy`, `env.ps`, `env.composeFiles`, `env.logs`, `stack.status`, `stack.up`, `stack.down`, `stack.destroy`, `stack.log` and `worktree.dirty`; the events `docker.log` and `env.log`, to the requesting connection only; the error code `TOOL_ERROR` (`details.reason: missing` when the tool is not installed).
2. **The server.** The logic of main's `docker.ts`, `environments.ts` and `stacks.ts` moves into `src/host/` (`dockerService.ts`, `environmentService.ts`, `stackService.ts`, beside `colimaService.ts`), Electron-free, with its files in the server's data dir. `server/src/integrations/` serves it: every path from the server's own state through the allowlist, every argument checked, no shell.
3. **The upgrade.** The Local server takes over the app's own environments registry and stack files once (`start --local --import-env-from <userData>`), so existing users' VMs, containers, volumes and running stacks stay theirs, under the same names.
4. **The app.** The panels call the window's server (`WindowBackend.docker`, `.env`, `.stacks`, `.git.dirty`), gated on the capabilities instead of the Local entry; the worktree delete's teardown keeps 4c's order, its fresh dirty check through the server's git. Main's `docker.ts`, `environments.ts`, `stacks.ts` and `git:localDirty` are deleted, with the preload's 21 members. Skills, Reveal and Open in VS Code stay this machine's, on Local only.
5. **Smokes.** `smoke:server-env` (new) drives a remote server window's Docker, environments and stacks against stub tools on the server's PATH; `smoke:local-features` covers the upgrade; `smoke:v2` checks a remote window's features and that nothing ran docker unasked.

**Architecture:**
- **Host services, server handlers.** `createEnvironmentService({ registryFile })` and `createStackService({ stateDir })` are the old main handlers' bodies with their files injected (`<dataDir>/environments.json`, `<dataDir>/stacks/`); `dockerService.ts` is three functions. `createMachine(dataDir)` builds them once per server (`server.ts`'s `ServerOptions.machine`). `machineHandlers.ts` maps each method to them, resolving every worktree with `present()`/`checkedOut()` (the worktree commands' own resolvers) and every repository with `repoIn` + `findRegistered` + the guard; `args.ts` checks the rest.
- **Events** go to a per-connection `EventSink` in `V2Context.events`, as the pty events go to the terminal sink: only the connection whose request started a run hears its `docker.log` or `env.log`.
- **The client** gets `onEvent` in `V2BackendDeps` (the window's own connection's events by name), and long request timeouts for the long runs (`V2Request` takes `{ timeoutMs }`).
- **The gate.** `CAPABILITY_FOR` maps `docker`, `env` and `stacks` to their capabilities; `MACHINE_FEATURES` (Local entry + `local`) shrinks to `skills`, `reveal`, `openInEditor`.

**Tech Stack:** as 5a-1: TypeScript, React 19 + zustand, Electron 43, the `src/shared/client` SDK, `node --test`, Playwright's `_electron`; `ws` and `node:child_process` (`execFile`, `spawn`, never a shell) on the server.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`: "2. Server components" (`integrations/`: "Docker/Colima/env/stacks"), "Docker / env / stacks (phase 5) act on the server's machine", "Desktop app" (main loses `docker.ts`, `environments.ts`, `stacks.ts` "once each has a server replacement"), and "6. Phases" (the 5a/5b split, recorded by 5a-1 Task 6). Builds on `docs/superpowers/plans/2026-11-09-central-server-phase5a1-cleanup.md` (its tree, its Task 5's `present()`), and on 4c's plan (`…-phase4c-local-features.md`: its teardown order, Decisions 14–17, and its env and Docker settings writes, which are unchanged) and 4d's (`profileKey`, Note 5).

---

## Roadmap

See 5a-1's "Roadmap: phase 5": this plan is **5a-2**. 5b is Linear, voice (on the server) and skills; the bot (last, only when asked), moving worktrees between servers, promote and the supervisor on Windows come later, each in its own plan. Not here: the trek-dev MCP tools `get_stack`, `start_stack`, `stop_stack`, `read_stack_log` (Question 2).

---

## Decisions

### Recorded (user decisions)

1. **Docker, Colima, the environments and the stacks move onto the server** and work in remote server windows as well as Local, gated on a server capability instead of `MACHINE_FEATURES` plus the Local entry.
2. **Security:** the token already grants a shell; keep the path allowlist on everything, validate every argument, and let no client string reach a shell unquoted.
3. **The upgrade path for existing Local env state is critical**: existing users' VMs and stacks keep working.
4. **Reveal and Open in VS Code stay this machine's; skills wait for 5b.** The bot is not touched.

### Decided in this plan

**The protocol (Task 1)**

5. **Three capabilities, one per feature**, `docker`, `env` and `stacks`, always listed by a 5a server (they say it serves the methods). Whether the machine *has* docker or colima is each call's answer, not a capability: tools come and go on a running machine's PATH, and a capability is fixed for a connection. `env.check` says which tool is missing. The calls that answer at once (`docker.list`, `docker.container`, `env.list`, `env.ps`, `env.logs`, `stack.*`) fail with `TOOL_ERROR`, `details.reason: missing`; the long runs that stream their output (`docker.compose`, `env.up`, `env.stop`, `env.destroy`) resolve their exit code `-1` instead (`env.up`: `{ code: -1, error }`), and their log says the tool could not run, as main's did, which Task 3's panels read.
6. **No method takes a path.** A worktree is `{projectId, worktreeId}` (`env.up`, `env.ps`, `env.composeFiles`, `env.logs`, `stack.*`, `worktree.dirty`), a repository `{projectId, repoId}` (`env.list`, `docker.compose`: its main checkout). The server takes the path from its state and checks it as the worktree commands do (`present()`: registered repository, not missing, inside the allowlist, a main row its repository's own; `checkedOut()` for `env.up`, which re-reads git so the VM is the branch checked out now). `env.stop` and `env.destroy` take a `twb-` profile name (the orphan list deletes VMs no worktree names).
7. **The VM's name is the server's.** `env.up` derives the profile from `envRepoKey(repository)` (its `profileKey` when an import kept one, 4d Note 5) and the branch, on the server. The client still derives the same name to find its row in `env.list` (one shared function, `deriveProfileName`). `env.up`'s `settings.profileKey` is accepted and ignored.
8. **`env.up` takes the settings and variables from the client**, as `envUp` did: the panel reads them at click time from the overlay, where a variables draft committed by the click's own blur is pending (4c review fix 2). The server checks them (Decision 10) instead of trusting them.
9. **Docker compose runs a named action**, `up`, `upBuild`, `restart`, `stop`, `down` or `pull`, whose arguments the server owns (`COMPOSE_ARGS`); the menu used to send the argument list.
10. **What is checked** (`server/src/integrations/args.ts`): a container id or name `[A-Za-z0-9][A-Za-z0-9_.-]{0,254}`; a profile `twb-[a-z0-9][a-z0-9-]{0,62}`; a service `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`; a compose file, each comma-separated part relative, inside the worktree, no `..`, not `-…`, no NUL, and, when it exists, still inside the worktree's real path once its symlinks are followed (as `stack.sh` must be, for `stack.*`); the settings' keys and ranges (`cpu` 1–256, `memory` 1–1024, `disk` 1–10000, booleans); the variables' names (`[A-Za-z_][A-Za-z0-9_]*`, as `parseEnvVars` reads them), at most 200, string values without NUL, and, in any case, none of `PATH`, `HOME`, `XDG_CONFIG_HOME` or the `DOCKER_*`, `COMPOSE_*`, `BUILDKIT_*`, `LD_*` and `DYLD_*` families (the user's decision), which would steer which programs compose runs, which daemon it reaches or which files it reads as its own configuration, instead of what the compose file reads; `tail` 1–5000; `fileId` and `offset` non-negative integers. Every command is `execFile` or `spawn` with an argument list.
11. **Long runs keep request/response**, with long client timeouts (30 min for `env.up` and `docker.compose`, 10 for `env.stop`, `env.destroy`, `stack.down`, `stack.destroy`, 3 for `docker.container`) and their output as events. A run outlives its connection: a dropped link fails the request with `NOT_CONNECTED` on the client while the server finishes the run, and the next `env.list` or `stack.status` shows the result. A server-side operations topic (every client seeing every run) is more than 5a needs.
12. **The events go to the requesting connection only**, as main's `env:log` went to the window that asked. Another window on the same project sees the result through the polls, not the log.
13. **`worktree.dirty`** is a new method rather than `worktree.changes` (which compares with the base branch, so a committed branch is "changed") or a poller refresh (which would wait on a whole status sweep). It answers `git status --porcelain` now, `null` when git cannot read it; a client of an older server falls back to the poll's flag, as `localWorktreeDirty` did for an unreadable path.

**The server (Task 1)**

14. **The services keep main's behaviour**, with three changes. The registry is written through a lock (`updateRegistry`: read, change, write, one at a time), since two clients can run two profiles' operations at once and each wrote back a registry read before the other's change; it is written then renamed, 0600 (a branch's variables can hold secrets). A stack's log read is capped at 1 MiB per call (a reader that fell behind skips ahead; its pane keeps 200 KB). The messages say "the server's machine" where they said "your".
15. **The data files live in the server's data dir**: `<dataDir>/environments.json` and `<dataDir>/stacks/<slug>.{log,pid}`. stack.sh's own registry (`$XDG_STATE_HOME/trek/stacks`) is the server user's, as it was main's.

**The upgrade (Task 2)**

16. **The Local server takes the app's files over, once.** Main starts it with `--import-env-from <userData>`; on a start whose data dir has no `environments.json`, the server copies the app's registry (well-formed `twb-` entries with absolute paths only) and its stack files (`<slug>.pid` copied, `<slug>.log` hard-linked so a stack still running keeps logging to it), before it serves anything. With nothing to copy it writes an empty registry, so it never copies again. The app's files are left as they were: a dev build and the installed app share that userData (4b Risk 1), and each Local profile takes its own copy.
17. **Nothing else needs to move**: the VM names are unchanged (Decision 7: the same `deriveProfileName(envRepoKey(repo), branch)` the app used), the stack names follow the checkout's path, and the environments setting, the Docker favourites and the branch variables were already server data (4c Note 3).
18. **A Local server older than 5a** (the user chose Keep Running at the version-skew prompt) has none of the capabilities: a Local window then shows no Docker, Env or Stack tab until it restarts; the next start of the new server takes the files over. Main no longer runs them, so this window has no fallback (README).

**The app (Task 3)**

19. **Start sends only the keys `env.up` takes** (`envStartArgs`): a repository's stored `environments` may hold `profileKey` and keys another client or an old file wrote, which the server's strict check (Decision 10) would refuse; the server reads `profileKey` from its own copy. **The panels call `getBackend()`**: `DockerPanel`, `DockerMenu` (by repository id), `StackPanel`, `EnvironmentPanel`, Settings' orphan delete, `environmentActions`, `useEnvironmentPoll`, `WorktreeDetail`'s `useStackStatus`. The idle backend rejects, and its `onLog`s are no-ops. The poll pauses while the window is offline, and checks the tools again once it is back.
20. **The teardown keeps 4c's order on the server**: the confirm (with the stack's checkbox, from `stack.status`), the fresh dirty check (`worktree.dirty`) before anything is destroyed, the unload, `stack.destroy`, `env.destroy`, then `worktree.remove`. `localTeardown.ts` becomes `worktreeTeardown.ts`. `backendV2` gates it on `features.stacks` / `features.env`, so it runs on any server that has them.
21. **Deleted:** `src/main/docker.ts`, `environments.ts`, `stacks.ts` and their registrations; `git:localDirty` (`appIpc.ts`) and the preload's `localWorktreeDirty` and 20 docker/stack/env members. Kept: `src/host/colimaService.ts` (now the environment service's), `gitService.worktreeDirty` (the server's), the types in `src/shared/types.ts` (the protocol's), `src/renderer/src/stacks.ts` (the panel's helpers), `main/skills.ts` (5b).

**The smokes (Tasks 3–4)**

22. **`smoke:server-env`** is new rather than more of `smoke:v2` (171 checks): a plain `trek-server start` with its own HOME (the worktrees under it, as Colima mounts only `$HOME`) and stub `docker`, `colima` and `stack.sh` first on its PATH, recording calls with a shared sequence number; the app with a temp HOME and userData, no Local server, main's dialogs stubbed. 29 checks.
23. **`smoke:v2`'s server gets stub `docker` and `colima` too**, and the run ends by checking nothing ran them: since 5a a remote server runs them for its windows, and no smoke may reach a real one.
24. **`smoke:local-features`** seeds the userData as a pre-5a Trek left it (a registry naming the feature branch's VM; a running `up` — a `sleep` in its own process group — with its pid and log) and checks the take-over end to end: the server's copy, the app's left alone, the VM no orphan, the stack still running with its log, and the delete stopping it first. 41 checks.

## Conventions

As 5a-1's, with these:
- **Baseline:** 5a-1 as planned (its Task 6's commit): 1597 tests (1596 pass, 1 skipped); `smoke:local-window` 57 checks; the others as master's.
- **No real docker or colima, ever.** Every smoke that can reach them puts stubs first on the PATH of the process that runs them: the server's, since this plan (`smoke:local-features` through its HOME's `.zshrc`, which main's `fixPath` reads and the Local server inherits; `smoke:v2` and `smoke:server-env` on the server's spawn). The unit tests set `process.env.PATH` in their own process (`node --test` runs each file in its own).

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/host/dockerService.ts` | create | 1 | `listContainers`, `containerAction`, `compose`; `COMPOSE_ARGS` |
| `src/host/environmentService.ts` | create | 1 | the registry (locked, atomic, 0600) and the env operations |
| `src/host/stackService.ts` | create | 1 | stack status, up, down, destroy, log |
| `src/host/colimaService.ts` | modify | 1 | `.ts` import; comments |
| `src/shared/protocolV2.ts`, `src/shared/types.ts` | modify | 1 | the methods, results, events, capabilities, `TOOL_ERROR`; `ComposeAction` |
| `server/src/integrations/args.ts` | create | 1 | every argument's check |
| `server/src/integrations/machineHandlers.ts` | create | 1 | the methods; `viaTool`; `EventSink`, `Machine` |
| `server/src/integrations/machine.ts` | create | 1 | `createMachine(dataDir)` |
| `server/src/v2.ts`, `server.ts`, `errors.ts`, `capabilities.ts`, `worktreeHandlers.ts`, `index.ts` | modify | 1, 2 | the context's `machine` and `events`; `TOOL_ERROR`; the capabilities; `present`/`checkedOut` exported, `worktree.dirty`; `--import-env-from` |
| `scripts/serverMachine.test.mjs` | create | 1, 3 | the methods against stubs and real git |
| `scripts/serverV2.test.mjs`, `server/scripts/smoke.mjs`, `scripts/client-contract.mjs` | modify | 1, 2 | the capabilities; `--import-env-from`'s usage |
| `server/src/integrations/envSeed.ts`, `scripts/serverEnvSeed.test.mjs` | create | 2 | the take-over |
| `src/main/localServer.ts` | modify | 2 | `--import-env-from userData` |
| `src/renderer/src/backend.ts`, `backendFeatures.ts`, `v2/backendV2.ts`, `v2/installV2.ts` | modify | 3 | `docker`, `env`, `stacks`, `git.dirty`; the gate; `onEvent`, timeouts |
| `src/renderer/src/worktreeTeardown.ts` | rename from `localTeardown.ts` | 3 | the teardown through the server |
| `src/renderer/src/environmentStart.ts`, `scripts/environmentStart.test.mjs` | modify | 3 | only the settings keys `env.up` takes |
| `src/renderer/src/environmentActions.ts`, `useEnvironmentPoll.ts`, `windowKind.ts`; `components/` `DockerMenu`, `DockerPanel`, `EnvironmentPanel`, `SettingsPanel`, `StackPanel`, `WorktreeDetail` | modify | 3 | through the backend |
| `src/main/docker.ts`, `environments.ts`, `stacks.ts` | delete | 3 | |
| `src/main/index.ts`, `src/main/appIpc.ts`, `src/preload/index.ts` | modify | 3 | the registrations, `git:localDirty`, the preload's members out |
| `scripts/backendFeatures.test.mjs`, `scripts/v2Backend.test.mjs` | modify | 3 | the gate; the methods, timeouts, events; the teardown on any server with the features |
| `scripts/v2-smoke.mjs`, `scripts/local-features-smoke.mjs` | modify | 3, 4 | the remote features, stubs; the upgrade |
| `scripts/server-env-smoke.mjs`, `package.json` | create, modify | 4 | `smoke:server-env` |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | modify | 5 | |

---

### Task 1: The server serves Docker, the environments and the stacks

**Files:**
- Create: `src/host/dockerService.ts`, `src/host/environmentService.ts`, `src/host/stackService.ts`, `server/src/integrations/args.ts`, `server/src/integrations/machineHandlers.ts`, `server/src/integrations/machine.ts`, `scripts/serverMachine.test.mjs`
- Modify: `src/host/colimaService.ts`, `src/shared/protocolV2.ts`, `src/shared/types.ts`, `server/src/v2.ts`, `server/src/server.ts`, `server/src/errors.ts`, `server/src/capabilities.ts`, `server/src/worktreeHandlers.ts`, `server/src/index.ts`
- Test: `scripts/serverMachine.test.mjs`, `scripts/serverV2.test.mjs`; the capability lists of `server/scripts/smoke.mjs` and `scripts/client-contract.mjs`

The app is not changed in this task: it ignores the new capabilities until Task 3.

- [ ] **Step 1: The tests**

`serverMachine.test.mjs` runs `dispatchV2` against real git in a temp dir, with stub `docker` and `colima` first on its PATH (each records its arguments, working directory and `$FOO`): the docker methods, and their refusals before docker runs (`-rf`, `a;rm -rf /`, `$(id)`, an unknown action, compose arguments); a machine with no docker or colima (`TOOL_ERROR` `missing`, `env.check`'s message, a compose run ending `-1`); `env.up` under the repository's `profileKey` with checked settings and variables, the registry 0600 in the data dir, the steps as `env.log`, `env.list`/`ps`/`logs`/`composeFiles`; the refusals of compose files, settings and variables, with no call made and no registry written; `env.destroy`, and two `env.up`s at once both registered; `stack.*` with a stub `stack.sh` (a running `up` counts, down Ctrl-C's it, the log's offsets); `worktree.dirty`; and `PATH_DENIED` for a worktree row outside the allowlist from every method. `serverV2.test.mjs` adds the three capabilities.

```diff
diff --git a/scripts/serverMachine.test.mjs b/scripts/serverMachine.test.mjs
new file mode 100644
index 0000000..d08b555
--- /dev/null
+++ b/scripts/serverMachine.test.mjs
@@ -0,0 +1,257 @@
+// scripts/serverMachine.test.mjs — docker.*, env.*, stack.* and worktree.dirty (phase 5a), against
+// real git in a temp dir and stub docker, colima and stack.sh: nothing here runs a real docker or
+// colima. Each stub records its arguments and working directory.
+process.env.GIT_CONFIG_GLOBAL = '/dev/null'
+process.env.GIT_CONFIG_NOSYSTEM = '1'
+
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { execFileSync } from 'node:child_process'
+import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { saveConfig } from '../server/src/config.ts'
+import { ConfigStore } from '../server/src/configStore.ts'
+import { GitPoller } from '../server/src/git/poller.ts'
+import { ProjectState } from '../server/src/projects/state.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+import { createEnvironmentService } from '../src/host/environmentService.ts'
+import { createStackService } from '../src/host/stackService.ts'
+import { deriveProfileName } from '../src/shared/environments.ts'
+
+const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
+const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
+
+// The stubs, first on PATH for the whole file (node --test runs each file in its own process).
+const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-stubs-')))
+const callsFile = join(stubDir, 'calls')
+const stub = (name, body) => {
+  writeFileSync(join(stubDir, name), `#!/bin/bash\necho "${name}|$PWD|$*|FOO=$FOO" >> '${callsFile}'\n${body}\n`)
+  chmodSync(join(stubDir, name), 0o755)
+}
+stub('docker', `case "$1" in
+  --version) echo "Docker version 0.0.0-stub" ;;
+  ps) if [ "$2" = "-a" ]; then echo '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 1 minute","Ports":"80/tcp"}'; fi ;;
+esac
+case " $* " in *" compose "*" ps "*) echo '[{"Service":"web","State":"running","Status":"Up","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}]' ;; esac
+case " $* " in *" logs "*) echo "web log line" ;; esac
+exit 0`)
+stub('colima', `case "$1" in
+  --version) echo "colima version 0.0.0-stub" ;;
+  list) [ -f '${stubDir}/vms' ] && cat '${stubDir}/vms' ;;
+esac
+exit 0`)
+const originalPath = process.env.PATH
+process.env.PATH = `${stubDir}:${originalPath}`
+process.on('exit', () => rmSync(stubDir, { recursive: true, force: true }))
+
+const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])
+const resetCalls = () => rmSync(callsFile, { force: true })
+
+async function setup(t, options = {}) {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-machine-')))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  resetCalls()
+  const a = join(dir, 'repos', 'a')
+  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
+  mkdirSync(join(a, 'docker', 'stack'), { recursive: true })
+  writeFileSync(join(a, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "stack|$PWD|$*" >> '${callsFile}'\n${options.stackBody ?? ''}\n`, { mode: 0o755 })
+  writeFileSync(join(a, 'docker-compose.yml'), 'services: {}\n')
+  writeFileSync(join(a, 'compose.dev.yaml'), 'services: {}\n')
+  git(a, 'add', '.')
+  git(a, 'commit', '-q', '-m', 'init')
+  git(a, 'worktree', 'add', '-q', '-b', 'feature-x', `${a}-feature-x`)
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
+  const data = join(dir, 'data')
+  mkdirSync(data)
+  const machine = {
+    env: createEnvironmentService({ registryFile: join(data, 'environments.json'), home: dir }),
+    stacks: createStackService({ stateDir: join(data, 'stacks') })
+  }
+  const events = []
+  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, sessions: { blockPath: () => () => {}, refreshAttention: () => {} }, machine, events: { send: (event, payload) => events.push([event, payload]) } }
+  const call = (method, params) => dispatchV2(method, params, ctx)
+  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
+  const projectId = created.result.projectId
+  await poller.refresh(a)
+  const repo = () => projects.require(projectId).repositories[0]
+  const worktreeAt = (path) => repo().worktrees.find((w) => w.path === path)
+  return { dir, a, feature: `${a}-feature-x`, data, store, projects, call, events, projectId, repoId: repo().id, repo, worktreeAt, ctx }
+}
+
+const refused = (res, code, reason) => {
+  assert.equal(res.ok, false, JSON.stringify(res))
+  assert.equal(res.error.code, code, res.error.message)
+  if (reason !== undefined) assert.equal(res.error.details?.reason, reason)
+}
+
+test('docker.list, docker.container and docker.compose run docker on the server, compose in the main checkout', async (t) => {
+  const s = await setup(t)
+  const list = await s.call('docker.list', {})
+  assert.deepEqual(list.result, [{ id: 'c1', name: 'web', image: 'nginx', state: 'running', status: 'Up 1 minute', ports: '80/tcp' }])
+  assert.equal((await s.call('docker.container', { action: 'restart', id: 'c1' })).ok, true)
+  const compose = await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'upBuild' })
+  assert.equal(compose.result, 0)
+  assert.deepEqual(calls().filter((c) => !c.includes('|ps -a')), [`docker|${process.cwd()}|restart c1|FOO=`, `docker|${s.a}|compose up --build -d|FOO=`])
+  // The output went to this connection as docker.log, the last one marked done.
+  assert.equal(s.events.every(([event]) => event === 'docker.log'), true)
+  assert.equal(s.events[0][1].data, '$ docker compose up --build -d\n')
+  assert.equal(s.events.at(-1)[1].done, true)
+})
+
+test('docker: an action, a container id or a repository the server does not know is refused before docker runs', async (t) => {
+  const s = await setup(t)
+  for (const id of ['-rf', 'a b', 'a;rm -rf /', '', '$(id)', 'x'.repeat(300)]) refused(await s.call('docker.container', { action: 'stop', id }), 'BAD_REQUEST')
+  refused(await s.call('docker.container', { action: 'rm', id: 'c1' }), 'BAD_REQUEST')
+  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'up -d; echo' }), 'BAD_REQUEST')
+  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, args: ['rm', '-f'] }), 'BAD_REQUEST')
+  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: 'nope', action: 'up' }), 'NOT_FOUND')
+  assert.deepEqual(calls(), [])
+})
+
+test('a machine without docker or colima: TOOL_ERROR with reason missing, and env.check says so', async (t) => {
+  const s = await setup(t)
+  const empty = mkdtempSync(join(tmpdir(), 'trek-machine-nopath-'))
+  process.env.PATH = empty
+  t.after(() => {
+    process.env.PATH = `${stubDir}:${originalPath}`
+    rmSync(empty, { recursive: true, force: true })
+  })
+  refused(await s.call('docker.list', {}), 'TOOL_ERROR', 'missing')
+  refused(await s.call('docker.container', { action: 'start', id: 'c1' }), 'TOOL_ERROR', 'missing')
+  refused(await s.call('env.list', { projectId: s.projectId, repoId: s.repoId }), 'TOOL_ERROR', 'missing')
+  const check = await s.call('env.check', {})
+  assert.deepEqual([check.ok, check.result.ok, check.result.error], [true, false, 'colima not found on PATH — brew install colima'])
+  // A compose run with no docker ends with -1 and says why in its output; nothing crashes.
+  assert.equal((await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'up' })).result, -1)
+  assert.match(s.events.map(([, e]) => e.data).join(''), /error: spawn docker ENOENT/)
+})
+
+test("env.up starts the branch's VM under the repository's envRepoKey, with the checked settings and variables", async (t) => {
+  const s = await setup(t)
+  // An imported repository keeps the path its VMs were named after.
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].environments = { enabled: true, profileKey: '/old/spelling/a' }
+  })
+  const worktreeId = s.worktreeAt(s.feature).id
+  const profile = deriveProfileName('/old/spelling/a', 'feature-x')
+  const res = await s.call('env.up', {
+    projectId: s.projectId,
+    worktreeId,
+    settings: { enabled: true, cpu: 3, memory: 6, networkAddress: false, composeFile: 'docker-compose.yml', profileKey: '/elsewhere' },
+    envVars: { FOO: 'bar' }
+  })
+  assert.deepEqual(res.result, { code: 0, address: undefined })
+  assert.deepEqual(calls(), [
+    `colima|${process.cwd()}|start ${profile} --cpu 3 --memory 6 --disk 20|FOO=`,
+    `docker|${s.feature}|--context colima-${profile} compose -f docker-compose.yml up -d|FOO=bar`,
+    `colima|${process.cwd()}|list --json|FOO=`
+  ])
+  const registry = JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))
+  assert.deepEqual(Object.keys(registry), [profile])
+  assert.deepEqual([registry[profile].repoPath, registry[profile].branch, registry[profile].worktreePath, registry[profile].envVars], ['/old/spelling/a', 'feature-x', s.feature, { FOO: 'bar' }])
+  assert.equal(statSync(join(s.data, 'environments.json')).mode & 0o777, 0o600)
+  const steps = s.events.filter(([event, e]) => event === 'env.log' && e.step).map(([, e]) => e.step)
+  assert.deepEqual(steps, ['vm', 'compose', 'ready'])
+  assert.equal(s.events.every(([event, e]) => event === 'env.log' && e.profile === profile), true)
+  // The list names it under the same key; ps and logs read its compose project.
+  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running', address: '10.0.0.5' })}\n${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}\n`)
+  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
+  const list = (await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result
+  assert.deepEqual(list.map((e) => [e.profile, e.vmState, e.address, e.orphaned]), [[profile, 'running', '10.0.0.5', undefined], ['twb-leftover-000000', 'stopped', undefined, true]])
+  assert.deepEqual((await s.call('env.ps', { projectId: s.projectId, worktreeId })).result, [{ name: 'web', state: 'running', status: 'Up', ports: [{ published: 8080, target: 80, protocol: 'tcp' }] }])
+  assert.equal((await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', tail: 50 })).result, 'web log line\n')
+  assert.deepEqual((await s.call('env.composeFiles', { projectId: s.projectId, worktreeId })).result, ['compose.dev.yaml', 'docker-compose.yml'])
+})
+
+test('env.up refuses settings, compose files and variables that would steer the run, before colima runs', async (t) => {
+  const s = await setup(t)
+  const worktreeId = s.worktreeAt(s.feature).id
+  const up = (extra) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true }, ...extra })
+  for (const composeFile of ['../outside.yml', '/etc/passwd', '-f /etc/x', 'a/../../b.yml', 'ok.yml,../x.yml', 'x\0.yml', '.']) {
+    refused(await up({ settings: { enabled: true, composeFile } }), 'BAD_REQUEST')
+  }
+  for (const settings of [{ enabled: true, cpu: 0 }, { enabled: true, memory: 1.5 }, { enabled: true, disk: '20' }, { enabled: true, rosetta: 'yes' }, { enabled: true, extra: 1 }, 'x', null]) {
+    refused(await up({ settings }), 'BAD_REQUEST')
+  }
+  for (const envVars of [{ PATH: '/tmp' }, { LD_PRELOAD: 'x.so' }, { DYLD_INSERT_LIBRARIES: 'x' }, { DOCKER_HOST: 'tcp://x' }, { 'A B': '1' }, { '1X': '1' }, { X: 1 }, { X: 'a\0b' }, ['X=1']]) {
+    refused(await up({ envVars }), 'BAD_REQUEST')
+  }
+  refused(await s.call('env.up', { projectId: s.projectId, worktreeId: 'nope', settings: { enabled: true } }), 'NOT_FOUND')
+  for (const profile of ['../x', 'twb-', '-rf', 'other-vm', 'twb-A', 'twb-a b']) {
+    refused(await s.call('env.stop', { profile }), 'BAD_REQUEST')
+    refused(await s.call('env.destroy', { profile }), 'BAD_REQUEST')
+  }
+  refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: '-f' }), 'BAD_REQUEST')
+  refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', tail: 1e9 }), 'BAD_REQUEST')
+  assert.deepEqual(calls(), [])
+  assert.equal(existsSync(join(s.data, 'environments.json')), false)
+})
+
+test('env.destroy deletes the VM and its registry entry; two environments started at once both stay registered', async (t) => {
+  const s = await setup(t)
+  git(s.a, 'worktree', 'add', '-q', '-b', 'feature-y', `${s.a}-feature-y`)
+  await s.ctx.poller.refresh(s.a)
+  const [x, y] = [s.worktreeAt(s.feature).id, s.worktreeAt(`${s.a}-feature-y`).id]
+  const results = await Promise.all([x, y].map((worktreeId) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })))
+  assert.deepEqual(results.map((r) => r.result.code), [0, 0])
+  const px = deriveProfileName(s.a, 'feature-x')
+  const py = deriveProfileName(s.a, 'feature-y')
+  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))).sort(), [px, py].sort())
+  resetCalls()
+  assert.equal((await s.call('env.destroy', { profile: px })).result, 0)
+  assert.deepEqual(calls(), [`docker|${s.feature}|--context colima-${px} compose -f docker-compose.yml down -v|FOO=`, `colima|${process.cwd()}|delete ${px} --force|FOO=`])
+  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))), [py])
+  assert.equal((await s.call('env.stop', { profile: py })).result, 0)
+})
+
+test("stack.*: the worktree's stack.sh, by the server's own path; its state in the data dir", async (t) => {
+  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
+  const worktreeId = s.worktreeAt(s.feature).id
+  const ref = { projectId: s.projectId, worktreeId }
+  const status = (await s.call('stack.status', ref)).result
+  assert.deepEqual([status.available, status.slug, status.upRunning, status.created], [true, 'a-feature-x', false, false])
+  assert.equal((await s.call('stack.up', { ...ref, starter: true })).ok, true)
+  assert.equal(existsSync(join(s.data, 'stacks', 'a-feature-x.pid')), true)
+  assert.equal((await s.call('stack.status', ref)).result.upRunning, true)
+  refused(await s.call('stack.up', { ...ref, starter: false }), 'TOOL_ERROR')
+  // Down Ctrl-C's the running up first, then runs `stack.sh down`.
+  assert.equal((await s.call('stack.down', ref)).result, 0)
+  assert.equal((await s.call('stack.status', ref)).result.upRunning, false)
+  assert.deepEqual(calls().filter((c) => c.startsWith('stack|')), [`stack|${s.feature}|up --starter`, `stack|${s.feature}|down`])
+  const log = (await s.call('stack.log', { ...ref, fileId: 0, offset: 0 })).result
+  assert.match(log.text, /\$ stack\.sh up --starter\n\$ stack\.sh down\n/)
+  assert.deepEqual((await s.call('stack.log', { ...ref, fileId: log.fileId, offset: log.offset })).result.text, '')
+  for (const bad of [{ fileId: -1, offset: 0 }, { fileId: 0, offset: 1.5 }, { fileId: '0', offset: 0 }]) refused(await s.call('stack.log', { ...ref, ...bad }), 'BAD_REQUEST')
+  refused(await s.call('stack.up', { ...ref, starter: 'yes' }), 'BAD_REQUEST')
+  assert.equal((await s.call('stack.destroy', ref)).result, 0)
+})
+
+test('worktree.dirty reads git afresh; a worktree outside the allowlist is PATH_DENIED for every machine method', async (t) => {
+  const s = await setup(t)
+  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
+  assert.equal((await s.call('worktree.dirty', ref)).result, false)
+  writeFileSync(join(s.feature, 'scratch.txt'), 'x\n')
+  assert.equal((await s.call('worktree.dirty', ref)).result, true)
+  // A row the guard does not cover (a hand-edited project file, say).
+  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
+  t.after(() => rmSync(outside, { recursive: true, force: true }))
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'feature-x', isMain: false, loaded: false, sessions: [] })
+  })
+  const out = { projectId: s.projectId, worktreeId: 'out' }
+  for (const [method, extra] of [['worktree.dirty', {}], ['stack.status', {}], ['stack.up', { starter: false }], ['stack.destroy', {}], ['stack.log', { fileId: 0, offset: 0 }], ['env.ps', {}], ['env.composeFiles', {}], ['env.logs', { service: 'web' }], ['env.up', { settings: { enabled: true } }]]) {
+    refused(await s.call(method, { ...out, ...extra }), 'PATH_DENIED')
+  }
+  assert.deepEqual(calls(), [])
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 145cff2..3deb5be 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,11 +382,12 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
-  assert.deepEqual(welcomeCapabilities(true), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'])
-  assert.deepEqual(welcomeCapabilities(false), ['topicEnd', 'decisions', 'dequeue', 'agents'])
-  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'])
-  assert.deepEqual(welcomeCapabilities(true, true), ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'local'])
-  assert.deepEqual(welcomeCapabilities(false, true), ['topicEnd', 'decisions', 'dequeue', 'agents', 'local'])
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks']
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
+  assert.deepEqual(welcomeCapabilities(false), all)
+  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
+  assert.deepEqual(welcomeCapabilities(true, true), ['mcp', ...all, 'local'])
+  assert.deepEqual(welcomeCapabilities(false, true), [...all, 'local'])
 })
 
 test('project.import accepts a project from importProjectFile', async (t) => {
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverMachine.test.mjs scripts/serverV2.test.mjs`

Expected:

```
not ok 1 - scripts/serverMachine.test.mjs
not ok 27 - welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server
# tests 38
# pass 36
# fail 2
```

`serverMachine.test.mjs` fails to load (the host services do not exist yet), and the welcome has no `docker`, `env` or `stacks`.

- [ ] **Step 3: The protocol, the services and the handlers**

```diff
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 19d85c1..f029d73 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -1,8 +1,19 @@
 // The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
 import { CAPABILITY } from '../../src/shared/protocolV2.ts'
 
-/** What this server always has. */
-export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue, CAPABILITY.agents]
+/**
+ * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
+ * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
+ */
+export const STATIC_CAPABILITIES: readonly string[] = [
+  CAPABILITY.topicEnd,
+  CAPABILITY.decisions,
+  CAPABILITY.dequeue,
+  CAPABILITY.agents,
+  CAPABILITY.docker,
+  CAPABILITY.env,
+  CAPABILITY.stacks
+]
 
 /** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
 export function welcomeCapabilities(mcp: boolean, local = false): string[] {
diff --git a/server/src/errors.ts b/server/src/errors.ts
index bb81c88..f5260e6 100644
--- a/server/src/errors.ts
+++ b/server/src/errors.ts
@@ -13,7 +13,8 @@ const PASSTHROUGH: ReadonlySet<string> = new Set<WireErrorCode>([
   'IN_USE',
   'CONFLICT',
   'CAPACITY',
-  'CONGESTED'
+  'CONGESTED',
+  'TOOL_ERROR'
 ])
 
 export function codedError(code: WireErrorCode, message: string, details?: WireErrorDetails): Error {
diff --git a/server/src/index.ts b/server/src/index.ts
index 2cd7018..b075f66 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -18,6 +18,7 @@ import { ProjectState } from './projects/state'
 import { ProjectStore } from './projects/store'
 import { formatRepoList } from './repos'
 import { startServer } from './server'
+import { createMachine } from './integrations/machine'
 import {
   addToken,
   DEFAULT_TOKEN_NAME,
@@ -414,6 +415,7 @@ try {
   fail(`Cannot read projects from ${projectsDir(args.dataDir ?? store.config.dataDir ?? defaultDataDir())}: ${(err as Error).message}`)
 }
 const { version, build } = buildInfo()
+const serverDataDir = resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir())
 const server = startServer(
   store,
   version,
@@ -423,7 +425,7 @@ const server = startServer(
     store: projectFiles.files
   },
   // Absolute: agents read the config file from their own worktree's directory.
-  { mcpDir: resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir(), 'mcp'), local: local !== undefined }
+  { mcpDir: resolve(serverDataDir, 'mcp'), local: local !== undefined, machine: createMachine(serverDataDir) }
 )
 store.watch()
 server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
diff --git a/server/src/integrations/args.ts b/server/src/integrations/args.ts
new file mode 100644
index 0000000..4afaa18
--- /dev/null
+++ b/server/src/integrations/args.ts
@@ -0,0 +1,149 @@
+// Argument checks for the docker, env and stack methods (phase 5a). A client on another machine can
+// call these, so every value that reaches a command line or a process environment is checked here:
+// nothing goes through a shell (every command is execFile or spawn with an argument list), and each
+// value is limited to what the method needs. Every failure is BAD_REQUEST.
+import { isAbsolute, relative, resolve } from 'node:path'
+import { ENV_PROFILE_PREFIX } from '../../../src/shared/environments.ts'
+import type { ComposeAction, ContainerAction, EnvironmentSettings } from '../../../src/shared/types'
+import { codedError } from '../errors.ts'
+import { isRecord, requireString } from '../validate.ts'
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+/** A twb- Colima profile, as deriveProfileName makes them (and as `colima list` lists the leftovers). */
+const PROFILE_RE = new RegExp(`^${ENV_PROFILE_PREFIX}[a-z0-9][a-z0-9-]{0,62}$`)
+/** A container id or name, as `docker ps` prints them. Never a leading "-": that would be a flag. */
+const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
+/** A compose service name. */
+const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
+/** A variable name, as parseEnvVars reads them. */
+const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
+/**
+ * Variables a branch's list may not set: they would change which programs docker compose runs or
+ * where it connects (the run is pinned to the VM's own context), not what the compose file reads.
+ */
+const DENIED_ENV = /^(PATH|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|LD_.*|DYLD_.*)$/
+const MAX_ENV_VARS = 200
+const MAX_ENV_VALUE = 32 * 1024
+const MAX_COMPOSE_FILE = 1024
+
+export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart']
+export const COMPOSE_ACTIONS: readonly ComposeAction[] = ['up', 'upBuild', 'restart', 'stop', 'down', 'pull']
+
+export function requireProfile(value: unknown): string {
+  if (typeof value !== 'string' || !PROFILE_RE.test(value)) throw bad(`profile must be a ${ENV_PROFILE_PREFIX} environment name`)
+  return value
+}
+
+export function requireContainerId(value: unknown): string {
+  if (typeof value !== 'string' || !CONTAINER_RE.test(value)) throw bad('id must be a container id or name')
+  return value
+}
+
+export function requireContainerAction(value: unknown): ContainerAction {
+  if (!(CONTAINER_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${CONTAINER_ACTIONS.join(', ')}`)
+  return value as ContainerAction
+}
+
+export function requireComposeAction(value: unknown): ComposeAction {
+  if (!(COMPOSE_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${COMPOSE_ACTIONS.join(', ')}`)
+  return value as ComposeAction
+}
+
+export function requireService(value: unknown): string {
+  if (typeof value !== 'string' || !SERVICE_RE.test(value)) throw bad('service must be a compose service name')
+  return value
+}
+
+/** An integer in [min, max], or `fallback` when absent. */
+export function optionalInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
+  if (value === undefined) return fallback
+  return requireInt(value, field, min, max)
+}
+
+export function requireInt(value: unknown, field: string, min: number, max: number): number {
+  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
+    throw bad(`${field} must be an integer from ${min} to ${max}`)
+  }
+  return value
+}
+
+/**
+ * A compose file setting: one or more comma-separated paths relative to the worktree, each inside
+ * it. Not absolute, no "..", no leading "-" (it follows `-f`, but compose must never read a flag),
+ * no NUL. Undefined when absent or blank (the default file).
+ */
+export function optionalComposeFile(value: unknown, worktreePath: string): string | undefined {
+  if (value === undefined || value === null || value === '') return undefined
+  if (typeof value !== 'string' || value.length > MAX_COMPOSE_FILE) throw bad('composeFile must be a string')
+  const files = value
+    .split(',')
+    .map((f) => f.trim())
+    .filter(Boolean)
+  if (files.length === 0) return undefined
+  for (const file of files) {
+    const inside = relative(worktreePath, resolve(worktreePath, file))
+    if (
+      file.includes('\0') ||
+      file.startsWith('-') ||
+      isAbsolute(file) ||
+      file.split(/[\\/]/).includes('..') ||
+      inside === '' ||
+      inside.startsWith('..') ||
+      isAbsolute(inside)
+    ) {
+      throw bad(`composeFile: ${JSON.stringify(file)} must be a file inside the worktree`)
+    }
+  }
+  return files.join(',')
+}
+
+const SETTINGS_KEYS = ['enabled', 'cpu', 'memory', 'disk', 'networkAddress', 'rosetta', 'composeFile', 'profileKey'] as const
+
+/**
+ * An environment's settings for `env.up`: only the known keys, with sizes in range. `profileKey` is
+ * accepted and dropped: the VM's name comes from the repository the server stores, never the client.
+ */
+export function requireEnvSettings(value: unknown, worktreePath: string): EnvironmentSettings {
+  if (!isRecord(value)) throw bad('settings must be an object')
+  for (const key of Object.keys(value)) {
+    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) throw bad(`settings.${key} is not an environment setting`)
+  }
+  const bool = (key: 'enabled' | 'networkAddress' | 'rosetta'): boolean | undefined => {
+    const v = value[key]
+    if (v === undefined) return undefined
+    if (typeof v !== 'boolean') throw bad(`settings.${key} must be a boolean`)
+    return v
+  }
+  const settings: EnvironmentSettings = { enabled: bool('enabled') ?? true }
+  const networkAddress = bool('networkAddress')
+  const rosetta = bool('rosetta')
+  if (networkAddress !== undefined) settings.networkAddress = networkAddress
+  if (rosetta !== undefined) settings.rosetta = rosetta
+  if (value.cpu !== undefined) settings.cpu = requireInt(value.cpu, 'settings.cpu', 1, 256)
+  if (value.memory !== undefined) settings.memory = requireInt(value.memory, 'settings.memory', 1, 1024)
+  if (value.disk !== undefined) settings.disk = requireInt(value.disk, 'settings.disk', 1, 10_000)
+  const composeFile = optionalComposeFile(value.composeFile, worktreePath)
+  if (composeFile !== undefined) settings.composeFile = composeFile
+  if (value.profileKey !== undefined && typeof value.profileKey !== 'string') throw bad('settings.profileKey must be a string')
+  return settings
+}
+
+/** A branch's variables for docker compose: names as parseEnvVars reads them, string values, none that steer the run. */
+export function optionalEnvVars(value: unknown): Record<string, string> | undefined {
+  if (value === undefined || value === null) return undefined
+  if (!isRecord(value)) throw bad('envVars must be an object')
+  const keys = Object.keys(value)
+  if (keys.length > MAX_ENV_VARS) throw bad(`envVars may have at most ${MAX_ENV_VARS} variables`)
+  const out: Record<string, string> = {}
+  for (const key of keys) {
+    if (!ENV_KEY_RE.test(key)) throw bad(`envVars: ${JSON.stringify(key)} is not a variable name`)
+    if (DENIED_ENV.test(key)) throw bad(`envVars: ${key} cannot be set for docker compose`)
+    const v = value[key]
+    if (typeof v !== 'string' || v.includes('\0') || v.length > MAX_ENV_VALUE) throw bad(`envVars.${key} must be a string`)
+    out[key] = v
+  }
+  return keys.length > 0 ? out : undefined
+}
+
+export { requireString }
diff --git a/server/src/integrations/machine.ts b/server/src/integrations/machine.ts
new file mode 100644
index 0000000..5fc56f3
--- /dev/null
+++ b/server/src/integrations/machine.ts
@@ -0,0 +1,18 @@
+// The server's machine services (phase 5a): the environments' registry and the dev stacks' logs
+// and pids live in the server's data dir, next to its projects.
+import { join } from 'node:path'
+import { createEnvironmentService } from '../../../src/host/environmentService.ts'
+import { createStackService } from '../../../src/host/stackService.ts'
+import type { Machine } from './machineHandlers.ts'
+
+/** `<dataDir>/environments.json`: each twb- VM's repository, branch and worktree */
+export const ENV_REGISTRY_FILE = 'environments.json'
+/** `<dataDir>/stacks`: each dev stack's log and its `stack.sh up` pid */
+export const STACKS_DIR = 'stacks'
+
+export function createMachine(dataDir: string): Machine {
+  return {
+    env: createEnvironmentService({ registryFile: join(dataDir, ENV_REGISTRY_FILE) }),
+    stacks: createStackService({ stateDir: join(dataDir, STACKS_DIR) })
+  }
+}
diff --git a/server/src/integrations/machineHandlers.ts b/server/src/integrations/machineHandlers.ts
new file mode 100644
index 0000000..ce91ef0
--- /dev/null
+++ b/server/src/integrations/machineHandlers.ts
@@ -0,0 +1,184 @@
+// Docker, the Colima environments and the dev stacks, on the server's machine (phase 5a; the
+// `docker`, `env` and `stacks` capabilities). Before 5a the app's main process ran these on the
+// client's machine, so only a Local window had them; now any server window does, and they act on
+// the server's machine and its paths.
+//
+// The token already grants a shell as the server user (PROTOCOL.md, "Auth"); these add no new
+// power, and are held to the rest of the protocol's rules: every path comes from the server's own
+// state (a project, a repository or worktree id, never a client path), passes the path allowlist,
+// and every other argument is checked (args.ts) before it reaches a command line, which is always
+// an argument list (execFile, spawn), never a shell. A tool the machine lacks is a TOOL_ERROR with
+// `details.reason: missing`, never a crash.
+import { envRepoKey } from '../../../src/shared/environments.ts'
+import * as docker from '../../../src/host/dockerService.ts'
+import type { EnvironmentService } from '../../../src/host/environmentService.ts'
+import type { StackService } from '../../../src/host/stackService.ts'
+import { deriveProfileName } from '../../../src/shared/environments.ts'
+import type { EventPayloadsV2 } from '../../../src/shared/protocolV2'
+import { codedError } from '../errors.ts'
+import { findRegistered, repoIn } from '../projects/model.ts'
+import { requireBoolean } from '../validate.ts'
+import type { V2Context } from '../v2.ts'
+import { checkedOut, present } from '../worktreeHandlers.ts'
+import {
+  optionalComposeFile,
+  optionalEnvVars,
+  optionalInt,
+  requireComposeAction,
+  requireContainerAction,
+  requireContainerId,
+  requireEnvSettings,
+  requireInt,
+  requireProfile,
+  requireService
+} from './args.ts'
+
+/** The machine's services, made once per server (server.ts) with their files in its data dir. */
+export interface Machine {
+  env: EnvironmentService
+  stacks: StackService
+}
+
+/** This connection, as a receiver of the events it asked for (`docker.log`, `env.log`). */
+export interface EventSink {
+  send<E extends keyof EventPayloadsV2>(event: E, payload: EventPayloadsV2[E]): void
+}
+
+type Handler = (params: any, ctx: V2Context) => unknown
+
+const bad = (message: string): Error => codedError('BAD_REQUEST', message)
+
+/** The program a failed execFile or spawn ran, when it was not found on PATH. */
+function missingTool(err: unknown): string | null {
+  const e = err as { code?: unknown; path?: unknown; syscall?: unknown } | null
+  if (e?.code !== 'ENOENT') return null
+  if (typeof e.path === 'string' && e.path !== '') return e.path
+  return typeof e.syscall === 'string' && e.syscall.startsWith('spawn ') ? e.syscall.slice('spawn '.length) : 'the tool'
+}
+
+/** Runs a tool: a failure is TOOL_ERROR (`missing` when the program is not installed), never INTERNAL. */
+async function viaTool<T>(operation: () => Promise<T>): Promise<T> {
+  try {
+    return await operation()
+  } catch (err) {
+    if ((err as { code?: unknown }).code === 'BAD_REQUEST') throw err
+    const tool = missingTool(err)
+    if (tool) throw codedError('TOOL_ERROR', `${tool} is not installed on the server (it is not on the server's PATH)`, { reason: 'missing' })
+    const message = (err as Error).message ?? String(err)
+    throw codedError('TOOL_ERROR', message.length > 4000 ? `${message.slice(0, 4000)}…` : message)
+  }
+}
+
+const machine = (ctx: V2Context): Machine => {
+  if (!ctx.machine) throw codedError('NOT_FOUND', 'this server has no machine services')
+  return ctx.machine
+}
+
+/** A repository the project has and the registry still has, inside the allowlist: its main checkout. */
+function repository(ctx: V2Context, p: any) {
+  const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
+  findRegistered(ctx.store.config.repos, repo.path)
+  ctx.store.guard.check(repo.path)
+  return repo
+}
+
+/** The worktree's branch's environment: its VM is named after the repository's envRepoKey and the branch. */
+function environmentOf(ctx: V2Context, p: any) {
+  const { repo, worktree } = present(ctx, p)
+  if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
+  return { repo, worktree, profile: deriveProfileName(envRepoKey(repo), worktree.branch) }
+}
+
+export const machineHandlers: Record<string, Handler> = {
+  'docker.list': () => viaTool(() => docker.listContainers()),
+
+  'docker.container': async (p) => {
+    const action = requireContainerAction(p.action)
+    const id = requireContainerId(p.id)
+    await viaTool(() => docker.containerAction(action, id))
+    return null
+  },
+
+  // Its output streams to this connection as docker.log; a docker that is not installed ends the
+  // run with code -1 and says so in the output.
+  'docker.compose': (p, ctx) => {
+    const action = requireComposeAction(p.action)
+    const repo = repository(ctx, p)
+    return docker.compose(action, repo.path, (event) => ctx.events?.send('docker.log', event))
+  },
+
+  'env.check': (_p, ctx) => machine(ctx).env.check(),
+
+  'env.list': (p, ctx) => {
+    const repo = repository(ctx, p)
+    return viaTool(() => machine(ctx).env.list(envRepoKey(repo)))
+  },
+
+  // The branch git has checked out now (re-read), the repository's VM key from the server's own
+  // data, the settings and variables checked. The output streams to this connection as env.log.
+  'env.up': async (p, ctx) => {
+    const env = machine(ctx).env
+    const { repo, worktree, branch } = await checkedOut(ctx, p)
+    const settings = requireEnvSettings(p.settings, worktree.path)
+    const envVars = optionalEnvVars(p.envVars)
+    return env.up({ repoKey: envRepoKey(repo), branch, worktreePath: worktree.path, settings, envVars }, (event) => ctx.events?.send('env.log', event))
+  },
+
+  'env.stop': (p, ctx) => {
+    const profile = requireProfile(p.profile)
+    return machine(ctx).env.stop(profile, (event) => ctx.events?.send('env.log', event))
+  },
+
+  'env.destroy': (p, ctx) => {
+    const profile = requireProfile(p.profile)
+    return machine(ctx).env.destroy(profile, (event) => ctx.events?.send('env.log', event))
+  },
+
+  'env.ps': (p, ctx) => {
+    const { worktree, profile } = environmentOf(ctx, p)
+    const composeFile = optionalComposeFile(p.composeFile, worktree.path)
+    return viaTool(() => machine(ctx).env.ps(profile, worktree.path, composeFile))
+  },
+
+  'env.composeFiles': (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return machine(ctx).env.composeFiles(worktree.path)
+  },
+
+  'env.logs': (p, ctx) => {
+    const { worktree, profile } = environmentOf(ctx, p)
+    const composeFile = optionalComposeFile(p.composeFile, worktree.path)
+    const service = requireService(p.service)
+    const tail = optionalInt(p.tail, 'tail', 1, 5000, 300)
+    return viaTool(() => machine(ctx).env.logs(profile, worktree.path, composeFile, service, tail))
+  },
+
+  'stack.status': (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return viaTool(() => machine(ctx).stacks.status(worktree.path))
+  },
+
+  'stack.up': async (p, ctx) => {
+    const starter = requireBoolean(p.starter, 'starter')
+    const { worktree } = present(ctx, p)
+    await viaTool(() => machine(ctx).stacks.up(worktree.path, starter))
+    return null
+  },
+
+  'stack.down': (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return viaTool(() => machine(ctx).stacks.down(worktree.path))
+  },
+
+  'stack.destroy': (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return viaTool(() => machine(ctx).stacks.destroy(worktree.path))
+  },
+
+  'stack.log': (p, ctx) => {
+    const fileId = requireInt(p.fileId, 'fileId', 0, Number.MAX_SAFE_INTEGER)
+    const offset = requireInt(p.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
+    const { worktree } = present(ctx, p)
+    return viaTool(() => machine(ctx).stacks.log(worktree.path, fileId, offset))
+  }
+}
diff --git a/server/src/server.ts b/server/src/server.ts
index 88c74dd..0011dbb 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -26,6 +26,7 @@ import type { TerminalSink } from './sessions/terminalHost'
 import { McpAccessStore } from './mcp/access'
 import { startMcpListener, type McpListener } from './mcp/listener'
 import { createToolCaller, type ToolCall, MCP_INSTRUCTIONS, MCP_TOOLS } from './mcp/tools'
+import type { Machine } from './integrations/machineHandlers'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -55,6 +56,8 @@ export interface ServerOptions {
   mcpDir?: string
   /** `trek-server start --local`: the welcome lists the `local` capability */
   local?: boolean
+  /** Docker, the environments and the dev stacks on this machine, with their files in the data dir (machine.ts) */
+  machine?: Machine
 }
 
 export interface ProjectsSetup {
@@ -144,6 +147,8 @@ export function startServer(
       send: (event, payload) => sendFrame(ws, { type: 'event', event, payload }),
       bufferedAmount: () => ws.bufferedAmount
     }
+    /** This connection, for the docker.log and env.log of the requests it sends */
+    const events = { send: (event: string, payload: unknown) => sendFrame(ws, { type: 'event', event, payload }) }
     const subscriber: Subscriber = {
       send(topic, rev, ops) {
         sendFrame(ws, { type: 'event', event: 'state.patch', payload: { topic, rev, ops } })
@@ -263,6 +268,8 @@ export function startServer(
         poller,
         sessions,
         terminal,
+        events,
+        machine: options.machine,
         mcpAccess: access
           ? {
               revoke: (id) => {
diff --git a/server/src/v2.ts b/server/src/v2.ts
index 35bfb30..2159514 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -1,6 +1,6 @@
 // Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
-// projects, repositories and branch data, worktree commands, session.*, worktree.load/unload
-// and the v2 pty.* stream. Attention (working/done) arrives in 2d-2.
+// projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
+// the v2 pty.* stream, and docker, env and stack on the server's machine (machineHandlers.ts).
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -11,6 +11,7 @@ import type { BranchData, Repository } from '../../src/shared/model/types'
 import type { GitPoller } from './git/poller.ts'
 import { worktreeHandlers } from './worktreeHandlers.ts'
 import { sessionHandlers } from './sessionHandlers.ts'
+import { machineHandlers, type EventSink, type Machine } from './integrations/machineHandlers.ts'
 import type { TerminalSink } from './sessions/terminalHost.ts'
 import { checkImport } from './projects/importCheck.ts'
 import { findRegistered, newRepository, repoIn } from './projects/model.ts'
@@ -45,6 +46,10 @@ export interface V2Context {
   terminal: TerminalSink
   /** The projects' MCP tokens and config files; a deleted project's are revoked */
   mcpAccess?: { revoke(projectId: string): void }
+  /** Docker, the environments and the dev stacks on this machine */
+  machine?: Machine
+  /** This connection, as a receiver of the `docker.log` and `env.log` its own requests stream */
+  events?: EventSink
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
@@ -263,7 +268,8 @@ const handlers: Record<string, Handler> = {
   },
 
   ...worktreeHandlers,
-  ...sessionHandlers
+  ...sessionHandlers,
+  ...machineHandlers
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/server/src/worktreeHandlers.ts b/server/src/worktreeHandlers.ts
index 6da6907..84cb93b 100644
--- a/server/src/worktreeHandlers.ts
+++ b/server/src/worktreeHandlers.ts
@@ -89,7 +89,7 @@ function locate(project: Project, worktreeId: unknown): { repo: Repository; work
  * import may not be). The main worktree is its repository's own checkout;
  * any other row must not be, nor contain, a registered repository.
  */
-function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
+export function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
   const found = locate(ctx.projects.require(p.projectId), p.worktreeId)
   findRegistered(ctx.store.config.repos, found.repo.path)
   if (found.worktree.missing) {
@@ -106,7 +106,7 @@ function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree
  * `git checkout` by a poll, so the repo is re-read first. The branch must be a
  * real branch name, since it goes on a git command line.
  */
-async function checkedOut(ctx: V2Context, p: any): Promise<{ repo: Repository; worktree: Worktree; branch: string }> {
+export async function checkedOut(ctx: V2Context, p: any): Promise<{ repo: Repository; worktree: Worktree; branch: string }> {
   const { repo } = present(ctx, p)
   if (!(await ctx.poller.refresh(repo.path))) {
     throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
@@ -240,5 +240,11 @@ export const worktreeHandlers: Record<string, Handler> = {
   'worktree.diff': async (p, ctx) => {
     const { worktree } = present(ctx, p)
     return viaGit(() => gitService.worktreeDiff(worktree.path))
+  },
+
+  // A delete's fresh check before it destroys a worktree's dev stack or VM (the poll's `dirty` can be 30 s old).
+  'worktree.dirty': async (p, ctx) => {
+    const { worktree } = present(ctx, p)
+    return gitService.worktreeDirty(worktree.path)
   }
 }
diff --git a/src/host/colimaService.ts b/src/host/colimaService.ts
index be533ef..5a0a534 100644
--- a/src/host/colimaService.ts
+++ b/src/host/colimaService.ts
@@ -1,7 +1,7 @@
-// Electron-free: shared by the Electron main process and (later) the daemon.
+// Colima and docker compose for the environments (environmentService.ts), on trek-server's machine. Electron-free.
 import { execFile, spawn } from 'node:child_process'
 import { promisify } from 'node:util'
-import { dockerContextFor } from '../shared/environments'
+import { dockerContextFor } from '../shared/environments.ts'
 import type { EnvCheckResult, EnvService, EnvServicePort } from '../shared/types'
 
 const execFileAsync = promisify(execFile)
@@ -61,7 +61,7 @@ export async function listColimaProfiles(): Promise<ColimaProfile[]> {
 
 export type EnvVars = Record<string, string>
 
-/** Extra vars layered over the app's own env (compose reads them for ${VAR} substitution). */
+/** Extra vars layered over the server's own env (compose reads them for ${VAR} substitution). */
 const mergedEnv = (extra?: EnvVars): NodeJS.ProcessEnv =>
   extra && Object.keys(extra).length > 0 ? { ...process.env, ...extra } : process.env
 
diff --git a/src/host/dockerService.ts b/src/host/dockerService.ts
new file mode 100644
index 0000000..e8b4f4f
--- /dev/null
+++ b/src/host/dockerService.ts
@@ -0,0 +1,64 @@
+// Docker on the machine this runs on (trek-server's, phase 5a): the container list, a container's
+// start, stop or restart, and the Docker tab's docker compose runs in a repository. Electron-free;
+// the server checks every argument before it calls these, and nothing here goes through a shell.
+import { execFile, spawn } from 'node:child_process'
+import { promisify } from 'node:util'
+import type { ComposeAction, ContainerAction, ContainerInfo, DockerLogEvent } from '../shared/types'
+
+const execFileAsync = promisify(execFile)
+
+export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart']
+
+/** Each compose action's arguments: a client names the action, never the arguments. */
+export const COMPOSE_ARGS: Readonly<Record<ComposeAction, readonly string[]>> = {
+  up: ['up', '-d'],
+  upBuild: ['up', '--build', '-d'],
+  restart: ['restart'],
+  stop: ['stop'],
+  down: ['down'],
+  pull: ['pull']
+}
+
+export async function listContainers(): Promise<ContainerInfo[]> {
+  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 10_000 })
+  return stdout
+    .trim()
+    .split('\n')
+    .filter(Boolean)
+    .map((line) => {
+      const raw = JSON.parse(line) as Record<string, string>
+      return {
+        id: raw.ID,
+        name: raw.Names,
+        image: raw.Image,
+        state: raw.State,
+        status: raw.Status,
+        ports: raw.Ports ?? ''
+      }
+    })
+}
+
+/** `id` must already be a container id or name (the server's `requireContainerId`). */
+export async function containerAction(action: ContainerAction, id: string): Promise<void> {
+  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`)
+  await execFileAsync('docker', [action, id], { timeout: 120_000 })
+}
+
+/** Long-running: streams the combined output through `onLog`, then resolves the exit code (-1 if docker could not run). */
+export function compose(action: ComposeAction, cwd: string, onLog: (event: DockerLogEvent) => void): Promise<number> {
+  const args = COMPOSE_ARGS[action]
+  return new Promise((resolve) => {
+    onLog({ data: `$ docker compose ${args.join(' ')}\n` })
+    const child = spawn('docker', ['compose', ...args], { cwd, env: process.env })
+    child.stdout.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
+    child.stderr.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
+    child.on('error', (err) => {
+      onLog({ data: `error: ${err.message}\n`, done: true })
+      resolve(-1)
+    })
+    child.on('close', (code) => {
+      onLog({ data: `[docker compose exited with code ${code ?? -1}]\n\n`, done: true })
+      resolve(code ?? -1)
+    })
+  })
+}
diff --git a/src/host/environmentService.ts b/src/host/environmentService.ts
new file mode 100644
index 0000000..fcf746f
--- /dev/null
+++ b/src/host/environmentService.ts
@@ -0,0 +1,315 @@
+// The per-worktree Colima environments on the machine this runs on (trek-server's, phase 5a): the
+// registry that maps each VM back to its repository, branch and worktree, and the operations on
+// it. Electron-free: the registry's file is the caller's (the server's data dir), and the server
+// checks every argument before it calls these.
+import { access, readFile, readdir, rename, writeFile } from 'node:fs/promises'
+import { homedir } from 'node:os'
+import { join } from 'node:path'
+import {
+  checkTools,
+  composeDownVolumes,
+  composeLogs,
+  composePs,
+  composeUp,
+  deleteVm,
+  listColimaProfiles,
+  splitComposeFiles,
+  startVm,
+  stopVm
+} from './colimaService.ts'
+import { ENV_DEFAULTS, ENV_PROFILE_PREFIX, deriveProfileName } from '../shared/environments.ts'
+import type {
+  EnvCheckResult,
+  EnvLogEvent,
+  EnvService,
+  EnvUpResult,
+  EnvUpStep,
+  EnvVmState,
+  EnvironmentInfo,
+  EnvironmentSettings
+} from '../shared/types'
+
+/**
+ * VMs are machine state, not project state: the registry maps each profile back to the
+ * repo/branch/worktree that owns it, which is what makes orphan detection possible (profile
+ * names hash, they don't invert). `repoPath` is the repository's envRepoKey.
+ */
+export interface RegistryEntry {
+  repoPath: string
+  branch: string
+  worktreePath: string
+  composeFile?: string
+  /** Extra env for docker compose (variable substitution), from the Env tab */
+  envVars?: Record<string, string>
+  createdAt: string
+}
+
+export type Registry = Record<string, RegistryEntry>
+
+export type EnvLog = (event: EnvLogEvent) => void
+
+export interface EnvUpRequest {
+  /** The repository's envRepoKey: the path its VM names hash */
+  repoKey: string
+  branch: string
+  worktreePath: string
+  settings: EnvironmentSettings | undefined
+  envVars: Record<string, string> | undefined
+}
+
+export interface EnvironmentService {
+  check(): Promise<EnvCheckResult>
+  list(repoKey: string): Promise<EnvironmentInfo[]>
+  up(request: EnvUpRequest, onLog: EnvLog): Promise<EnvUpResult>
+  stop(profile: string, onLog: EnvLog): Promise<number>
+  destroy(profile: string, onLog: EnvLog): Promise<number>
+  ps(profile: string, worktreePath: string, composeFile: string | undefined): Promise<EnvService[]>
+  composeFiles(worktreePath: string): Promise<string[]>
+  logs(profile: string, worktreePath: string, composeFile: string | undefined, service: string, tail: number): Promise<string>
+  /** Whether the registry knows the profile */
+  known(profile: string): Promise<boolean>
+}
+
+const exists = (path: string): Promise<boolean> =>
+  access(path).then(
+    () => true,
+    () => false
+  )
+
+/** colima start failed because the vmnet sudo helper isn't installed yet. */
+const isSudoHelperFailure = (output: string): boolean => /sudo|vmnet|password/i.test(output)
+
+/** A compose file name the environments' picker lists: docker-compose.yml, compose.dev.yaml, … */
+export const COMPOSE_FILE_RE = /^(docker-)?compose([.-][^.]+)*\.(yml|yaml)$/i
+
+export interface EnvironmentServiceOptions {
+  /** The registry's JSON file (the server's `<dataDir>/environments.json`) */
+  registryFile: string
+  /** VMs mount only this directory by default (Colima's $HOME); the worktree must be under it */
+  home?: string
+}
+
+export function createEnvironmentService(options: EnvironmentServiceOptions): EnvironmentService {
+  const { registryFile } = options
+  const home = options.home ?? homedir()
+
+  const readRegistry = async (): Promise<Registry> => {
+    try {
+      const parsed = JSON.parse(await readFile(registryFile, 'utf8'))
+      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Registry) : {}
+    } catch {
+      return {}
+    }
+  }
+  // Write-then-rename: a crash mid-write must not leave a torn file, which would read as no VMs.
+  const writeRegistry = async (registry: Registry): Promise<void> => {
+    const tmp = `${registryFile}.${process.pid}.tmp`
+    // 0600: a branch's variables may hold secrets.
+    await writeFile(tmp, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 })
+    await rename(tmp, registryFile)
+  }
+  /**
+   * Every change goes through here, one at a time: read, change, write. Operations on two
+   * profiles run at once (several clients), and each must not write back a registry read
+   * before the other's change.
+   */
+  let registryLock: Promise<unknown> = Promise.resolve()
+  const updateRegistry = <T>(change: (registry: Registry) => T): Promise<T> => {
+    const next = registryLock.then(async () => {
+      const registry = await readRegistry()
+      const result = change(registry)
+      await writeRegistry(registry)
+      return result
+    })
+    registryLock = next.catch(() => {})
+    return next
+  }
+  const entryOf = (registry: Registry, profile: string): RegistryEntry | undefined => (Object.hasOwn(registry, profile) ? registry[profile] : undefined)
+
+  /** Serialize operations per profile so double-clicks can't race two colima runs. */
+  const opQueues = new Map<string, Promise<unknown>>()
+  const enqueue = <T>(profile: string, work: () => Promise<T>): Promise<T> => {
+    const prev = opQueues.get(profile) ?? Promise.resolve()
+    const next = prev.then(work, work)
+    opQueues.set(profile, next)
+    return next
+  }
+
+  const logSender = (profile: string, onLog: EnvLog) => {
+    let tail = ''
+    const send = (data: string, done?: boolean, step?: EnvUpStep): void => {
+      tail = (tail + data).slice(-8_192)
+      onLog({ profile, data, ...(done ? { done } : {}), ...(step ? { step } : {}) })
+    }
+    return {
+      onData: (data: string) => send(data),
+      finish: (data: string) => send(data, true),
+      step: (step: EnvUpStep) => send('', false, step),
+      tail: () => tail
+    }
+  }
+
+  let toolCheck: EnvCheckResult | null = null
+
+  return {
+    async check() {
+      if (toolCheck?.ok) return toolCheck
+      toolCheck = await checkTools()
+      return toolCheck
+    },
+
+    async known(profile) {
+      return entryOf(await readRegistry(), profile) !== undefined
+    },
+
+    async list(repoKey) {
+      const [registry, profiles] = await Promise.all([readRegistry(), listColimaProfiles()])
+      const byName = new Map(profiles.map((p) => [p.name, p]))
+      const infos: EnvironmentInfo[] = []
+      for (const [profile, entry] of Object.entries(registry)) {
+        if (entry.repoPath !== repoKey) continue
+        const vm = byName.get(profile)
+        const vmState: EnvVmState = vm == null ? 'missing' : vm.status === 'Running' ? 'running' : 'stopped'
+        infos.push({
+          profile,
+          ...entry,
+          vmState,
+          address: vm?.address,
+          orphaned: (await exists(entry.worktreePath)) ? undefined : true
+        })
+      }
+      // twb- VMs with no registry entry (crash leftovers): surfaced for cleanup.
+      for (const vm of profiles) {
+        if (!vm.name.startsWith(ENV_PROFILE_PREFIX) || entryOf(registry, vm.name)) continue
+        infos.push({
+          profile: vm.name,
+          repoPath: repoKey,
+          branch: '',
+          worktreePath: '',
+          vmState: vm.status === 'Running' ? 'running' : 'stopped',
+          address: vm.address,
+          orphaned: true
+        })
+      }
+      return infos
+    },
+
+    up({ repoKey, branch, worktreePath, settings, envVars }, onLog) {
+      const profile = deriveProfileName(repoKey, branch)
+      const log = logSender(profile, onLog)
+      return enqueue(profile, async (): Promise<EnvUpResult> => {
+        const composeFile = settings?.composeFile || ENV_DEFAULTS.composeFile
+        const fail = (error: string): EnvUpResult => {
+          log.finish(`error: ${error}\n`)
+          return { code: -1, error }
+        }
+        for (const file of splitComposeFiles(composeFile)) {
+          const composePath = join(worktreePath, file)
+          if (!(await exists(composePath))) return fail(`No compose file at ${composePath}`)
+        }
+        if (!worktreePath.startsWith(home)) {
+          return fail(`Worktree is outside the home directory (${worktreePath}) — Colima only mounts $HOME by default`)
+        }
+
+        // Registered before starting so a crash mid-boot still leaves a trail.
+        await updateRegistry((registry) => {
+          registry[profile] = {
+            repoPath: repoKey,
+            branch,
+            worktreePath,
+            composeFile,
+            envVars: envVars && Object.keys(envVars).length > 0 ? envVars : undefined,
+            createdAt: entryOf(registry, profile)?.createdAt ?? new Date().toISOString()
+          }
+        })
+
+        const networkAddress = settings?.networkAddress ?? ENV_DEFAULTS.networkAddress
+        log.step('vm')
+        const vmCode = await startVm(
+          profile,
+          {
+            cpu: settings?.cpu ?? ENV_DEFAULTS.cpu,
+            memory: settings?.memory ?? ENV_DEFAULTS.memory,
+            disk: settings?.disk ?? ENV_DEFAULTS.disk,
+            networkAddress,
+            rosetta: settings?.rosetta ?? ENV_DEFAULTS.rosetta
+          },
+          log.onData
+        )
+        if (vmCode !== 0) {
+          if (networkAddress && isSudoHelperFailure(log.tail())) {
+            return fail(
+              `Colima's network helper needs a one-time sudo install. Run "colima start ${profile} --network-address" in a terminal on the server's machine once, or disable "Per-VM IP address" in Settings.`
+            )
+          }
+          return fail(`colima start exited with code ${vmCode}`)
+        }
+
+        log.step('compose')
+        const composeCode = await composeUp(profile, worktreePath, composeFile, log.onData, envVars)
+        if (composeCode !== 0) return fail(`docker compose up exited with code ${composeCode}`)
+
+        log.step('ready')
+        let address: string | undefined
+        try {
+          address = (await listColimaProfiles()).find((p) => p.name === profile)?.address
+        } catch {
+          // non-fatal: the env.list poll picks the address up
+        }
+        log.finish('[environment ready]\n')
+        return { code: 0, address }
+      })
+    },
+
+    stop(profile, onLog) {
+      const log = logSender(profile, onLog)
+      return enqueue(profile, async () => {
+        const code = await stopVm(profile, log.onData)
+        log.finish(`[colima stop exited with code ${code}]\n`)
+        return code
+      })
+    },
+
+    destroy(profile, onLog) {
+      const log = logSender(profile, onLog)
+      return enqueue(profile, async () => {
+        // Belt-and-braces for bind-mount cleanup; the volumes die with the VM anyway, so a
+        // failure (VM stopped, compose file gone) is fine.
+        const entry = entryOf(await readRegistry(), profile)
+        if (entry && (await exists(entry.worktreePath))) {
+          const composeFile = entry.composeFile || ENV_DEFAULTS.composeFile
+          await Promise.race([
+            composeDownVolumes(profile, entry.worktreePath, composeFile, log.onData, entry.envVars),
+            new Promise((resolve) => setTimeout(resolve, 60_000, -1))
+          ]).catch(() => -1)
+        }
+        const code = await deleteVm(profile, log.onData)
+        await updateRegistry((registry) => {
+          delete registry[profile]
+        })
+        log.finish(`[environment destroyed]\n`)
+        return code
+      })
+    },
+
+    async ps(profile, worktreePath, composeFile) {
+      const entry = entryOf(await readRegistry(), profile)
+      return composePs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, entry?.envVars)
+    },
+
+    // Compose file candidates in the worktree root, for the Apply-compose picker.
+    async composeFiles(worktreePath) {
+      try {
+        const entries = await readdir(worktreePath)
+        return entries.filter((f) => COMPOSE_FILE_RE.test(f)).sort((a, b) => a.length - b.length || a.localeCompare(b))
+      } catch {
+        return []
+      }
+    },
+
+    async logs(profile, worktreePath, composeFile, service, tail) {
+      const entry = entryOf(await readRegistry(), profile)
+      return composeLogs(profile, worktreePath, composeFile || ENV_DEFAULTS.composeFile, service, tail, entry?.envVars)
+    }
+  }
+}
diff --git a/src/host/stackService.ts b/src/host/stackService.ts
new file mode 100644
index 0000000..033f215
--- /dev/null
+++ b/src/host/stackService.ts
@@ -0,0 +1,232 @@
+// The per-worktree dev stacks (a repository's docker/stack/stack.sh) on the machine this runs on
+// (trek-server's, phase 5a): their status, start, stop, destroy and log. Electron-free: the state
+// directory (logs and the `up` process's pid) is the caller's (the server's data dir), and the
+// server resolves every worktree path from its own state before it calls these.
+import { execFile, spawn } from 'node:child_process'
+import { access, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
+import { homedir } from 'node:os'
+import { basename, join } from 'node:path'
+import { promisify } from 'node:util'
+import type { StackLogChunk, StackStatus } from '../shared/types'
+
+const execFileAsync = promisify(execFile)
+
+export const STACK_SCRIPT = 'docker/stack/stack.sh'
+const MAX_INITIAL_LOG = 64 * 1024
+/** The most one `log` call reads: a reader that fell further behind skips ahead (its pane keeps the last 200 KB anyway). */
+const MAX_LOG_READ = 1024 * 1024
+
+const exists = (path: string): Promise<boolean> =>
+  access(path).then(
+    () => true,
+    () => false
+  )
+
+// Same location stack.sh uses for its registry of name → checkout/ports.
+function registryDir(): string {
+  return process.env.TREK_STACK_REGISTRY ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'trek', 'stacks')
+}
+
+const slugify = (name: string): string =>
+  name
+    .toLowerCase()
+    .replace(/[^a-z0-9]/g, '-')
+    .replace(/^-+|-+$/g, '')
+
+const physicalPath = (path: string): Promise<string> => realpath(path).catch(() => path)
+
+function entryValue(text: string, key: string): string | undefined {
+  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]
+}
+
+/** Mirrors stack.sh's naming: the name the checkout already has in the registry, else the checkout's directory name. */
+async function resolveStack(ws: string): Promise<{ slug: string; port?: number; registered: boolean }> {
+  const dir = registryDir()
+  const files = await readdir(dir).catch(() => [] as string[])
+  for (const file of files) {
+    if (!file.startsWith('trek-')) continue
+    const text = await readFile(join(dir, file), 'utf8').catch(() => '')
+    const path = entryValue(text, 'path')
+    if (path && (await physicalPath(path)) === ws) {
+      const port = Number(entryValue(text, 'port'))
+      return { slug: file.slice('trek-'.length), port: port || undefined, registered: true }
+    }
+  }
+  return { slug: slugify(basename(ws)), registered: false }
+}
+
+function alive(pid: number): boolean {
+  try {
+    process.kill(pid, 0)
+    return true
+  } catch {
+    return false
+  }
+}
+
+async function runningContainers(slug: string): Promise<number> {
+  try {
+    const { stdout } = await execFileAsync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=trek-${slug}`], { timeout: 10_000 })
+    return stdout.split('\n').filter(Boolean).length
+  } catch {
+    return 0
+  }
+}
+
+// Conductor's variables would rename the stack or move its ports.
+function stackEnv(): NodeJS.ProcessEnv {
+  const env = { ...process.env }
+  for (const key of Object.keys(env)) if (key.startsWith('CONDUCTOR_')) delete env[key]
+  return env
+}
+
+async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
+  const deadline = Date.now() + timeoutMs
+  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
+}
+
+async function workspace(worktreePath: string): Promise<string> {
+  const ws = await physicalPath(worktreePath)
+  if (!(await exists(join(ws, STACK_SCRIPT)))) throw new Error(`No ${STACK_SCRIPT} in ${ws}`)
+  return ws
+}
+
+export interface StackService {
+  status(worktreePath: string): Promise<StackStatus>
+  up(worktreePath: string, starter: boolean): Promise<void>
+  down(worktreePath: string): Promise<number>
+  destroy(worktreePath: string): Promise<number>
+  log(worktreePath: string, fileId: number, offset: number): Promise<StackLogChunk>
+}
+
+export interface StackServiceOptions {
+  /** Where each stack's log and `up` pid go (the server's `<dataDir>/stacks`) */
+  stateDir: string
+}
+
+export function createStackService({ stateDir }: StackServiceOptions): StackService {
+  const logFile = (slug: string): string => join(stateDir, `${slug}.log`)
+  const pidFile = (slug: string): string => join(stateDir, `${slug}.pid`)
+  const stopping = new Set<string>()
+
+  const upPid = async (slug: string): Promise<number | undefined> => {
+    const pid = Number(await readFile(pidFile(slug), 'utf8').catch(() => ''))
+    return pid && alive(pid) ? pid : undefined
+  }
+
+  /** Runs stack.sh with its output appended to the stack's log file. */
+  const runScript = async (
+    ws: string,
+    slug: string,
+    args: string[],
+    opts: { fresh?: boolean; detached?: boolean } = {}
+  ): Promise<{ pid?: number; exit: Promise<number> }> => {
+    await mkdir(stateDir, { recursive: true })
+    // A fresh file (new inode) tells log readers a new run started.
+    if (opts.fresh) await rm(logFile(slug), { force: true })
+    const log = await open(logFile(slug), 'a')
+    await log.write(`$ stack.sh ${args.join(' ')}\n`)
+    // The process writes straight to the file, so `up` keeps running (and logging) across server
+    // restarts without a pipe back to this process.
+    const child = spawn('bash', [join(ws, STACK_SCRIPT), ...args], {
+      cwd: ws,
+      env: stackEnv(),
+      detached: opts.detached,
+      stdio: ['ignore', log.fd, log.fd]
+    })
+    const exit = new Promise<number>((resolve) => {
+      child.on('error', () => resolve(-1))
+      child.on('close', (code) => resolve(code ?? -1))
+    })
+    await log.close()
+    if (opts.detached) child.unref()
+    return { pid: child.pid, exit }
+  }
+
+  /**
+   * Runs `stack.sh <command>` after Ctrl-C'ing the whole `up` process group, so a start still
+   * restoring the database can't bring containers up afterwards.
+   */
+  const stopThenRun = async (worktreePath: string, command: 'down' | 'destroy'): Promise<number> => {
+    const ws = await workspace(worktreePath)
+    const { slug } = await resolveStack(ws)
+    if (stopping.has(slug)) throw new Error(`Stack '${slug}' is already stopping`)
+    stopping.add(slug)
+    try {
+      const pid = await upPid(slug)
+      if (pid) {
+        try {
+          process.kill(-pid, 'SIGINT')
+        } catch {
+          // already gone
+        }
+        await waitForExit(pid, 60_000)
+      }
+      const { exit } = await runScript(ws, slug, [command])
+      const code = await exit
+      if (command === 'destroy' && code === 0) await rm(logFile(slug), { force: true })
+      return code
+    } finally {
+      stopping.delete(slug)
+    }
+  }
+
+  return {
+    async status(worktreePath) {
+      const ws = await physicalPath(worktreePath)
+      if (!(await exists(join(ws, STACK_SCRIPT)))) {
+        return { available: false, containers: 0, upRunning: false, stopping: false, hasAdmin: false, created: false }
+      }
+      const { slug, port, registered } = await resolveStack(ws)
+      const [containers, pid, hasAdmin, hasStackDir] = await Promise.all([
+        runningContainers(slug),
+        upPid(slug),
+        exists(join(ws, '.trek', 'stack', 'admin', 'pnpm-lock.yaml')),
+        exists(join(ws, '.trek', 'stack'))
+      ])
+      return {
+        available: true,
+        slug,
+        port,
+        // The same test stack.sh destroy uses to decide there's nothing to remove
+        created: registered || hasStackDir,
+        containers,
+        upRunning: pid != null,
+        stopping: stopping.has(slug),
+        hasAdmin
+      }
+    },
+
+    async up(worktreePath, starter) {
+      const ws = await workspace(worktreePath)
+      const { slug } = await resolveStack(ws)
+      if (stopping.has(slug)) throw new Error(`Stack '${slug}' is stopping`)
+      if (await upPid(slug)) throw new Error(`Stack '${slug}' is already running`)
+      const { pid, exit } = await runScript(ws, slug, starter ? ['up', '--starter'] : ['up'], { fresh: true, detached: true })
+      if (pid == null) throw new Error('Could not start stack.sh')
+      await writeFile(pidFile(slug), String(pid))
+      void exit.then(() => rm(pidFile(slug), { force: true }))
+    },
+
+    down: (worktreePath) => stopThenRun(worktreePath, 'down'),
+
+    destroy: (worktreePath) => stopThenRun(worktreePath, 'destroy'),
+
+    async log(worktreePath, fileId, offset) {
+      const { slug } = await resolveStack(await physicalPath(worktreePath))
+      const path = logFile(slug)
+      const info = await stat(path).catch(() => null)
+      if (!info) return { fileId: 0, text: '', offset: 0 }
+      const from = Math.max(info.ino === fileId ? offset : 0, info.size - (info.ino === fileId ? MAX_LOG_READ : MAX_INITIAL_LOG))
+      if (from >= info.size) return { fileId: info.ino, text: '', offset: info.size }
+      const handle = await open(path, 'r')
+      try {
+        const buffer = Buffer.alloc(info.size - from)
+        await handle.read(buffer, 0, buffer.length, from)
+        return { fileId: info.ino, text: buffer.toString('utf8'), offset: info.size }
+      } finally {
+        await handle.close()
+      }
+    }
+  }
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 8dea818..075ea78 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -13,7 +13,21 @@ import type {
 import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
 import type { LlmProviderId, LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
-import type { EnvironmentSettings, WorktreeChanges } from './types.ts'
+import type {
+  ComposeAction,
+  ContainerAction,
+  ContainerInfo,
+  DockerLogEvent,
+  EnvCheckResult,
+  EnvLogEvent,
+  EnvService,
+  EnvUpResult,
+  EnvironmentInfo,
+  EnvironmentSettings,
+  StackLogChunk,
+  StackStatus,
+  WorktreeChanges
+} from './types.ts'
 
 export const PROTOCOL_VERSION_V2 = 2
 
@@ -53,6 +67,11 @@ export type WireErrorCode =
    * (over 4 MiB). Nothing was replayed or attached; retry once the backlog drains.
    */
   | 'CONGESTED'
+  /**
+   * A docker, colima or stack.sh command on the server's machine failed. `details.reason`
+   * `missing`: the tool is not on the server's PATH (not installed there).
+   */
+  | 'TOOL_ERROR'
 
 export interface WireError {
   code: WireErrorCode
@@ -65,6 +84,7 @@ export interface WireError {
 export interface WireErrorDetails {
   /**
    * `dirty`: `worktree.remove` refused a worktree with modified or untracked files.
+   * `missing`: a TOOL_ERROR's tool is not installed on the server.
    * The client SDK's own `TOPIC_ENDED` errors carry the `topic.ended` reason here.
    */
   reason?: string
@@ -145,7 +165,13 @@ export const CAPABILITY = {
   /** `server.agents` lists the agents the server can launch */
   agents: 'agents',
   /** This is the machine's own local server (`trek-server start --local`): it takes any path the user picks */
-  local: 'local'
+  local: 'local',
+  /** `docker.list`, `docker.container` and `docker.compose` run docker on the server's machine */
+  docker: 'docker',
+  /** `env.*` run the per-worktree Colima environments on the server's machine, and `env.log` streams their output */
+  env: 'env',
+  /** `stack.*` run the worktrees' docker/stack/stack.sh dev stacks on the server's machine */
+  stacks: 'stacks'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -242,6 +268,8 @@ export interface MethodParamsV2 {
   'worktree.push': WorktreeRef & { setUpstream: boolean }
   'worktree.changes': WorktreeRef
   'worktree.diff': WorktreeRef
+  /** A fresh `git status --porcelain` of the worktree (the status poll's `dirty` may be up to 30 s old) */
+  'worktree.dirty': WorktreeRef
   // Branch data (null clears)
   'branch.setTag': BranchRef & { tag: string | null }
   'branch.setCustomTags': BranchRef & { customTags: string[] | null }
@@ -288,6 +316,43 @@ export interface MethodParamsV2 {
   'server.removeRepo': { repoId: string }
   /** The agents the server can launch; with `projectId`, Claude's command is that project's `claudeCommand` when it has one */
   'server.agents': { projectId?: string }
+  // Docker on the server's machine (capability `docker`)
+  /** `docker ps -a` */
+  'docker.list': Record<string, never>
+  /** `id`: a container id or name, as `docker.list` gave it */
+  'docker.container': { action: ContainerAction; id: string }
+  /** `docker compose <action's args>` in the repository's main checkout; its output streams to this connection as `docker.log` */
+  'docker.compose': RepoRef & { action: ComposeAction }
+  // The worktrees' Colima environments on the server's machine (capability `env`)
+  /** colima and docker on the server's PATH (an `ok` answer is kept) */
+  'env.check': Record<string, never>
+  /** The repository's environments (by its envRepoKey), and the twb- VMs no registry entry names */
+  'env.list': RepoRef
+  /**
+   * Starts (or creates) the worktree's branch's VM and runs `docker compose up -d` in the worktree,
+   * with `settings` (the repository's, with the compose file picked) and the branch's variables as
+   * parsed `envVars`. Its output streams to this connection as `env.log`. Long: minutes on a first boot.
+   */
+  'env.up': WorktreeRef & { settings: EnvironmentSettings; envVars?: Record<string, string> }
+  /** `profile`: a twb- profile name */
+  'env.stop': { profile: string }
+  /** Deletes the VM (and, if its worktree is still there, `compose down -v` first) and its registry entry */
+  'env.destroy': { profile: string }
+  'env.ps': WorktreeRef & { composeFile?: string }
+  /** The compose files in the worktree's root */
+  'env.composeFiles': WorktreeRef
+  /** The last `tail` lines (default 300, at most 5000) of one compose service */
+  'env.logs': WorktreeRef & { composeFile?: string; service: string; tail?: number }
+  // The worktrees' dev stacks on the server's machine (capability `stacks`)
+  'stack.status': WorktreeRef
+  /** Starts `stack.sh up` (detached; it outlives the request and the server) */
+  'stack.up': WorktreeRef & { starter: boolean }
+  /** `stack.sh down`, after Ctrl-C'ing a running `up`; resolves its exit code */
+  'stack.down': WorktreeRef
+  /** `stack.sh destroy`, after Ctrl-C'ing a running `up`; resolves its exit code */
+  'stack.destroy': WorktreeRef
+  /** The stack's log from `offset` of the file `fileId` names, or its last 64 KiB when that file is gone */
+  'stack.log': WorktreeRef & { fileId: number; offset: number }
 
   // Subscriptions
   'sub.subscribe': { topic: Topic }
@@ -339,6 +404,8 @@ export interface MethodResultsV2 {
   'worktree.changes': WorktreeChanges
   /** Patch text per changed file (gitService's limits: no entry for binary or too-large files, 8 MiB in all) */
   'worktree.diff': Record<string, string>
+  /** null when git cannot read the worktree's status */
+  'worktree.dirty': boolean | null
   'branch.setTag': null
   'branch.setCustomTags': null
   'branch.setNote': null
@@ -364,6 +431,24 @@ export interface MethodResultsV2 {
   'server.addRepo': { repoId: string }
   'server.removeRepo': null
   'server.agents': ServerAgents
+  'docker.list': ContainerInfo[]
+  'docker.container': null
+  /** docker compose's exit code; -1 when docker could not run */
+  'docker.compose': number
+  'env.check': EnvCheckResult
+  'env.list': EnvironmentInfo[]
+  'env.up': EnvUpResult
+  /** colima's exit code */
+  'env.stop': number
+  'env.destroy': number
+  'env.ps': EnvService[]
+  'env.composeFiles': string[]
+  'env.logs': string
+  'stack.status': StackStatus
+  'stack.up': null
+  'stack.down': number
+  'stack.destroy': number
+  'stack.log': StackLogChunk
   'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
   'sub.unsubscribe': null
   'sys.ping': { t: number }
@@ -403,4 +488,8 @@ export interface EventPayloadsV2 {
   'state.patch': StatePatchPayload
   /** Sent to a topic's subscribers just before it stops; nothing more comes for it */
   'topic.ended': TopicEndedPayload
+  /** A `docker.compose` run's output, to the connection that asked for it only */
+  'docker.log': DockerLogEvent
+  /** An `env.up`, `env.stop` or `env.destroy`'s output and steps, to the connection that asked for it only */
+  'env.log': EnvLogEvent
 }
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 4fd37c7..20b7e9c 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -471,6 +471,9 @@ export interface ContainerInfo {
 
 export type ContainerAction = 'start' | 'stop' | 'restart'
 
+/** The docker compose runs the Docker tab's menu offers (`docker.compose`); the server owns their arguments. */
+export type ComposeAction = 'up' | 'upBuild' | 'restart' | 'stop' | 'down' | 'pull'
+
 export interface DockerLogEvent {
   data: string
   /** true on the final event of a compose run */
```


Run: `node --test scripts/serverMachine.test.mjs scripts/serverV2.test.mjs`

Expected: `# fail 0` (serverMachine's 8 pass). Two mutations each fail one of them, which the prototype checked: dropping the variables' deny list or the compose file's leading-`-` rule fails "env.up refuses settings, compose files and variables…"; writing the registry without `updateRegistry`'s lock (with a delay between the read and the write) fails "…two environments started at once both stay registered".

- [ ] **Step 4: The capability checks of the server smoke and the client contract**

```diff
diff --git a/scripts/client-contract.mjs b/scripts/client-contract.mjs
index 68b430b..fd3cba8 100644
--- a/scripts/client-contract.mjs
+++ b/scripts/client-contract.mjs
@@ -106,7 +106,7 @@ const mirror = new TopicMirror(conn)
 const ptys = new PtyStream(conn)
 conn.connect()
 if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
-if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
+if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks'].every((c) => conn.welcome?.capabilities.includes(c))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
 else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)
 
 // --- 2. server topic ---
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index eb93bc3..f12b02c 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -163,7 +163,7 @@ async function nextPatch(conn, topic, state, timeoutMs = 4000) {
 const v2 = await connect(2, token)
 if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
   fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
-} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'].every((c) => v2.welcome.capabilities?.includes(c))) {
+} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks'].every((c) => v2.welcome.capabilities?.includes(c))) {
   fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
 } else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
```


- [ ] **Step 5: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1605`, `# pass 1604`, `# fail 0`, `# skipped 1`.

Run, one at a time: `(cd server && node scripts/smoke.mjs --built)`, `node scripts/client-contract.mjs`

Expected: `SERVER SMOKE PASS` (71 `ok:` lines), `CLIENT CONTRACT PASS`.

- [ ] **Step 6: Commit**

```bash
git add src/host/dockerService.ts src/host/environmentService.ts src/host/stackService.ts server/src/integrations scripts/serverMachine.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5a-2): docker.*, env.*, stack.* and worktree.dirty on the server's machine (capabilities docker, env, stacks; TOOL_ERROR), every argument checked, every path from the server's state" -m "Co-Authored-By: <model trailer>" -- server src scripts
```

---

### Task 2: The Local server takes over the app's environments

**Files:**
- Create: `server/src/integrations/envSeed.ts`, `scripts/serverEnvSeed.test.mjs`
- Modify: `server/src/index.ts` (`--import-env-from`), `src/main/localServer.ts` (passes `userData`), `server/scripts/smoke.mjs` (its usage), `scripts/local-app-smoke.mjs` (the packaged run's command line)

- [ ] **Step 1: The tests**

It copies the registry and the stack files into an empty data dir (the log a hard link: the same inode), leaves the app's alone, and writes 0600; it runs once, even after the copy is emptied; with nothing to copy it writes an empty registry so nothing is copied later; it leaves out what is not a `twb-` entry with absolute paths (`__proto__` included) and a registry that does not parse.

```diff
diff --git a/scripts/serverEnvSeed.test.mjs b/scripts/serverEnvSeed.test.mjs
new file mode 100644
index 0000000..3ce44ac
--- /dev/null
+++ b/scripts/serverEnvSeed.test.mjs
@@ -0,0 +1,66 @@
+// scripts/serverEnvSeed.test.mjs — the Local server takes over the app's environments once (5a's upgrade).
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { seedEnvironmentsFromApp } from '../server/src/integrations/envSeed.ts'
+
+function dirs(t) {
+  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-env-seed-')))
+  t.after(() => rmSync(root, { recursive: true, force: true }))
+  const app = join(root, 'Trek Dev')
+  const data = join(root, 'data', 'local')
+  mkdirSync(join(app, 'stacks'), { recursive: true })
+  return { app, data }
+}
+
+const entry = (over = {}) => ({ repoPath: '/Users/me/app', branch: 'feature-x', worktreePath: '/Users/me/app-feature-x', composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z', ...over })
+
+test("copies the app's registry and stack files into an empty data dir, and leaves the app's as they were", (t) => {
+  const { app, data } = dirs(t)
+  const registry = { 'twb-feature-x-1a2b3c': entry(), 'twb-feature-y-4d5e6f': entry({ branch: 'feature-y', envVars: { FOO: 'bar' } }) }
+  writeFileSync(join(app, 'environments.json'), JSON.stringify(registry))
+  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), '4242')
+  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
+  writeFileSync(join(app, 'stacks', 'notes.txt'), 'not a stack file')
+  const result = seedEnvironmentsFromApp(app, data)
+  assert.deepEqual(result, { seeded: true, environments: 2, stackFiles: 2, skipped: [] })
+  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), registry)
+  assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
+  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.pid'), 'utf8'), '4242')
+  // The log is the same file (a hard link): a `stack.sh up` still writing to it shows in the new place.
+  assert.equal(statSync(join(data, 'stacks', 'app-feature-x.log')).ino, statSync(join(app, 'stacks', 'app-feature-x.log')).ino)
+  assert.equal(existsSync(join(data, 'stacks', 'notes.txt')), false)
+  assert.deepEqual(JSON.parse(readFileSync(join(app, 'environments.json'), 'utf8')), registry, "the app's file is kept")
+})
+
+test('runs once: a data dir that has its registry is never seeded again, even after it is emptied', (t) => {
+  const { app, data } = dirs(t)
+  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
+  assert.equal(seedEnvironmentsFromApp(app, data).seeded, true)
+  writeFileSync(join(data, 'environments.json'), '{}')
+  assert.deepEqual(seedEnvironmentsFromApp(app, data), { seeded: false, environments: 0, stackFiles: 0, skipped: [] })
+  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), '{}')
+})
+
+test('with nothing to copy it writes an empty registry, so a later start does not copy what appears afterwards', (t) => {
+  const { app, data } = dirs(t)
+  assert.deepEqual(seedEnvironmentsFromApp(app, data), { seeded: true, environments: 0, stackFiles: 0, skipped: [] })
+  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), {})
+  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
+  assert.equal(seedEnvironmentsFromApp(app, data).seeded, false)
+})
+
+test('leaves out what is not a twb- entry with absolute paths, and a registry that does not parse', (t) => {
+  const { app, data } = dirs(t)
+  const raw = `{"twb-ok-000001": ${JSON.stringify(entry())}, "other": ${JSON.stringify(entry())}, "twb-rel-000002": ${JSON.stringify(entry({ worktreePath: 'rel/path' }))}, "twb-num-000003": ${JSON.stringify(entry({ branch: 3 }))}, "__proto__": ${JSON.stringify(entry())}}`
+  writeFileSync(join(app, 'environments.json'), raw)
+  const result = seedEnvironmentsFromApp(app, data)
+  assert.deepEqual([result.environments, result.skipped], [1, ['environment "other"', 'environment "twb-rel-000002"', 'environment "twb-num-000003"', 'environment "__proto__"']])
+  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-ok-000001'])
+  const { app: app2, data: data2 } = dirs(t)
+  writeFileSync(join(app2, 'environments.json'), '{not json')
+  const broken = seedEnvironmentsFromApp(app2, data2)
+  assert.deepEqual([broken.seeded, broken.environments, broken.skipped.length], [true, 0, 1])
+})
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/serverEnvSeed.test.mjs`

Expected:

```
not ok 1 - scripts/serverEnvSeed.test.mjs
# tests 1
# pass 0
# fail 1
```

`envSeed.ts` does not exist yet.

- [ ] **Step 3: The seed, the flag and main's argument**

The flag only applies to `start --local` and needs an absolute path (a usage error, exit 2, otherwise). The copy runs before `startServer`; a failure is a warning (nothing was written, so the next start tries again). Main appends `--import-env-from <userData>` after the profile arguments, so `isLocalServerCommand` still reads the profile (`--local-profile <name>` comes first).

```diff
diff --git a/server/src/index.ts b/server/src/index.ts
index b075f66..3b25590 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -1,6 +1,6 @@
 import { existsSync, rmSync, statSync } from 'node:fs'
 import type { AddressInfo } from 'node:net'
-import { basename, resolve } from 'node:path'
+import { basename, isAbsolute, resolve } from 'node:path'
 import { setTimeout as delay } from 'node:timers/promises'
 import { homedir, hostname } from 'node:os'
 import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME, isLocalProfileName } from '../../src/shared/localServer'
@@ -19,6 +19,7 @@ import { ProjectStore } from './projects/store'
 import { formatRepoList } from './repos'
 import { startServer } from './server'
 import { createMachine } from './integrations/machine'
+import { seedEnvironmentsFromApp } from './integrations/envSeed'
 import {
   addToken,
   DEFAULT_TOKEN_NAME,
@@ -51,6 +52,8 @@ interface CliArgs {
   local: boolean
   /** `--local-profile <name>`: a named local profile (local-<name>) instead of the default one */
   localProfile?: string
+  /** `start --local --import-env-from <dir>`: the app's userData, whose environments the local server takes over once */
+  importEnvFrom?: string
 }
 
 const USAGE = `Usage: trek-server [command] [options]
@@ -86,6 +89,10 @@ Options:
                     With --local: a separate local server, under local-<name> in both
                     directories (a dev build of Trek uses "dev"). The name is 1-32 of a-z, 0-9, -,
                     starting with a letter or digit.
+  --import-env-from <dir>
+                    With start --local: the Trek app's data dir. Once, while the local data dir
+                    has no environments.json, its Colima environments registry and dev stack files
+                    are copied in (the app ran them itself before; the files there are kept).
   --id <id>         add: repo id (default: slug of the directory name)
   --name <name>     add: display name (default: the directory name)
   -h, --help        Show this help
@@ -159,6 +166,11 @@ function parseArgs(argv: string[]): CliArgs {
     else if (arg === '--data-dir') args.dataDir = value(++i, arg)
     else if (arg === '--insecure') args.insecure = true
     else if (arg === '--local') args.local = true
+    else if (arg === '--import-env-from') {
+      const dir = value(++i, arg)
+      if (!isAbsolute(dir)) usageError(`--import-env-from needs an absolute path: ${dir}`)
+      args.importEnvFrom = dir
+    }
     else if (arg === '--local-profile') {
       const name = value(++i, arg)
       if (!isLocalProfileName(name)) usageError(`Invalid local profile name: ${name} (1-32 of a-z, 0-9 and -, starting with a letter or digit)`)
@@ -173,6 +185,7 @@ function parseArgs(argv: string[]): CliArgs {
   }
   if (args.local && args.command !== 'start' && args.command !== 'stop') usageError('--local only applies to `start` and `stop`')
   if (args.localProfile !== undefined && !args.local) usageError('--local-profile only applies with --local')
+  if (args.importEnvFrom !== undefined && !(args.local && args.command === 'start')) usageError('--import-env-from only applies to `start --local`')
   if (args.command === 'stop' && !args.local) usageError('`stop` only stops the local server: `trek-server stop --local`')
   if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
     usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
@@ -416,6 +429,16 @@ try {
 }
 const { version, build } = buildInfo()
 const serverDataDir = resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir())
+if (args.importEnvFrom !== undefined) {
+  try {
+    const seed = seedEnvironmentsFromApp(args.importEnvFrom, serverDataDir)
+    if (seed.seeded) console.log(`environments: took over ${seed.environments} environment(s) and ${seed.stackFiles} stack file(s) from ${args.importEnvFrom}`)
+    if (seed.skipped.length > 0) console.warn(`environments: left out ${seed.skipped.join('; ')}`)
+  } catch (err) {
+    // The VMs are still there; the next start tries again (nothing was written).
+    console.warn(`environments: could not take over ${args.importEnvFrom}: ${(err as Error).message}`)
+  }
+}
 const server = startServer(
   store,
   version,
diff --git a/server/src/integrations/envSeed.ts b/server/src/integrations/envSeed.ts
new file mode 100644
index 0000000..41ab4e7
--- /dev/null
+++ b/server/src/integrations/envSeed.ts
@@ -0,0 +1,105 @@
+// The Local server's one-time take-over of the environments the app ran itself before 5a.
+//
+// Before 5a, the Trek app's main process ran Colima, docker and the dev stacks for Local windows,
+// with its environments registry in its userData (`environments.json`: each twb- VM's repository,
+// branch and worktree) and each stack's log and `stack.sh up` pid in `userData/stacks`. The VM
+// names do not change (deriveProfileName over the repository's envRepoKey, which the import keeps
+// as `profileKey`), nor do the stacks' (the checkout's path), so the VMs, containers and volumes
+// stay where they are: only the registry and the stack files move.
+//
+// `trek-server start --local --import-env-from <userData>` copies them into the server's data dir
+// before it serves anything, once: only while the data dir has no environments.json yet. With no
+// registry to copy it writes an empty one, so a later start never copies again. The app's files
+// stay as they were (a dev build and the installed app share that userData, and each Local profile
+// takes its own copy).
+import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
+import { isAbsolute, join } from 'node:path'
+import { writeFileAtomic } from '../atomicWrite.ts'
+import { ENV_PROFILE_PREFIX } from '../../../src/shared/environments.ts'
+import { isRecord } from '../validate.ts'
+import { ENV_REGISTRY_FILE, STACKS_DIR } from './machine.ts'
+
+/** A stack file the app's stacks.ts wrote: `<slug>.log` or `<slug>.pid` */
+const STACK_FILE_RE = /^[a-z0-9][a-z0-9-]*\.(log|pid)$/
+
+export interface EnvSeedResult {
+  /** Whether this start took the app's files over (false: the data dir already had its registry) */
+  seeded: boolean
+  /** Registry entries copied */
+  environments: number
+  /** Stack files copied or linked */
+  stackFiles: number
+  /** Entries left out, as text for the log */
+  skipped: string[]
+}
+
+/** The app's registry, entry by entry: only well-formed twb- entries with absolute paths. */
+function readAppRegistry(file: string, skipped: string[]): Record<string, unknown> {
+  let parsed: unknown
+  try {
+    parsed = JSON.parse(readFileSync(file, 'utf8'))
+  } catch (err) {
+    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push(`${file}: ${(err as Error).message}`)
+    return {}
+  }
+  if (!isRecord(parsed)) {
+    skipped.push(`${file}: not an object`)
+    return {}
+  }
+  const out: Record<string, unknown> = {}
+  for (const [profile, entry] of Object.entries(parsed)) {
+    const ok =
+      profile.startsWith(ENV_PROFILE_PREFIX) &&
+      profile !== '__proto__' &&
+      isRecord(entry) &&
+      typeof entry.repoPath === 'string' &&
+      isAbsolute(entry.repoPath) &&
+      typeof entry.branch === 'string' &&
+      typeof entry.worktreePath === 'string' &&
+      isAbsolute(entry.worktreePath)
+    if (ok) out[profile] = entry
+    else skipped.push(`environment ${JSON.stringify(profile)}`)
+  }
+  return out
+}
+
+export function seedEnvironmentsFromApp(appDir: string, dataDir: string): EnvSeedResult {
+  const result: EnvSeedResult = { seeded: false, environments: 0, stackFiles: 0, skipped: [] }
+  const registryFile = join(dataDir, ENV_REGISTRY_FILE)
+  if (existsSync(registryFile)) return result
+  mkdirSync(dataDir, { recursive: true })
+
+  // The stack files first: once the registry is written, this never runs again.
+  const fromStacks = join(appDir, STACKS_DIR)
+  const toStacks = join(dataDir, STACKS_DIR)
+  let names: string[] = []
+  try {
+    names = readdirSync(fromStacks)
+  } catch {
+    // none
+  }
+  for (const name of names) {
+    if (!STACK_FILE_RE.test(name)) continue
+    mkdirSync(toStacks, { recursive: true })
+    const target = join(toStacks, name)
+    if (existsSync(target)) continue
+    try {
+      // A hard link keeps the log's inode: a `stack.sh up` still running from the app keeps writing to it.
+      linkSync(join(fromStacks, name), target)
+    } catch {
+      try {
+        copyFileSync(join(fromStacks, name), target)
+      } catch (err) {
+        result.skipped.push(`${name}: ${(err as Error).message}`)
+        continue
+      }
+    }
+    result.stackFiles += 1
+  }
+
+  const registry = readAppRegistry(join(appDir, ENV_REGISTRY_FILE), result.skipped)
+  writeFileAtomic(registryFile, JSON.stringify(registry, null, 2), 0o600)
+  result.seeded = true
+  result.environments = Object.keys(registry).length
+  return result
+}
diff --git a/src/main/localServer.ts b/src/main/localServer.ts
index 026ad27..4e3f5aa 100644
--- a/src/main/localServer.ts
+++ b/src/main/localServer.ts
@@ -352,7 +352,9 @@ async function spawnAndWait(): Promise<void> {
   let child
   try {
     // detached: its own session (setsid), so no SIGHUP reaches it from the terminal that ran Trek.
-    child = spawn(process.execPath, [bundle, 'start', '--local', ...localProfileArgs(PROFILE)], {
+    // --import-env-from: the Colima environments and dev stacks this app ran itself before 5a; the
+    // server takes them over once (server/src/integrations/envSeed.ts).
+    child = spawn(process.execPath, [bundle, 'start', '--local', ...localProfileArgs(PROFILE), '--import-env-from', app.getPath('userData')], {
       cwd: homedir(),
       detached: true,
       env: childEnv(process.env),
```


Run: `node --test scripts/serverEnvSeed.test.mjs`

Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 4: The server smoke's usage checks; the packaged app's command line**

`smoke:local-app --packaged` reads the Local server's command line; it now ends with `--import-env-from <userData>`.

```diff
diff --git a/scripts/local-app-smoke.mjs b/scripts/local-app-smoke.mjs
index 563437c..c76c6eb 100644
--- a/scripts/local-app-smoke.mjs
+++ b/scripts/local-app-smoke.mjs
@@ -277,7 +277,8 @@ try {
   check("with the bundle's version and build", [first.version, first.build], [bundled.version, bundled.build])
   if (packaged) {
     const command = execFileSync('ps', ['-o', 'command=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
-    check("it runs the packaged app's binary on the bundle inside app.asar", command, `${join(packaged, 'Contents', 'MacOS', 'Trek')} ${join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')} start --local`)
+    // --import-env-from: the app's userData, whose environments the Local server takes over once (5a).
+    check("it runs the packaged app's binary on the bundle inside app.asar", command, `${join(packaged, 'Contents', 'MacOS', 'Trek')} ${join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')} start --local --import-env-from ${userData}`)
   }
   const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
   check('it runs detached, leading its own process group (setsid)', Number(pgid), first.pid)
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index f12b02c..172fd4a 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -684,6 +684,19 @@ else ok('bad token rejected with 4003')
     if (err.status !== 2) fail(`\`list --port\` exit ${err.status}`)
     else ok('`--port` outside `start` is a usage error (exit 2)')
   }
+  // The Local server's one-time take-over of the app's environments: `start --local` only, an absolute path.
+  for (const [argv, name] of [
+    [['start', '--import-env-from', work, '--config', configPath], 'without --local'],
+    [['start', '--local', '--import-env-from', 'relative/dir'], 'with a relative path']
+  ]) {
+    try {
+      execFileSync(cmd, [...cmdPrefix, ...argv], { cwd: serverDir, stdio: 'pipe', env: { ...process.env, HOME: work } })
+      fail(`\`--import-env-from\` ${name} was accepted`)
+    } catch (err) {
+      if (err.status !== 2) fail(`\`--import-env-from\` ${name} exit ${err.status}`)
+      else ok(`\`--import-env-from\` ${name} is a usage error (exit 2)`)
+    }
+  }
 }
 
 console.log(failed ? 'SERVER SMOKE FAIL' : 'SERVER SMOKE PASS')
```


- [ ] **Step 5: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1609`, `# pass 1608`, `# fail 0`, `# skipped 1`.

Run, one at a time: `(cd server && node scripts/smoke.mjs --built)`, `node scripts/local-app-smoke.mjs`, `node scripts/local-server-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `SERVER SMOKE PASS` (73 `ok:` lines, with ``ok: `--import-env-from` without --local is a usage error (exit 2)`` and ``… with a relative path …``), `LOCAL APP SMOKE PASS (45 checks)` (the supervisor's spawn, Reset and SIGKILL read the command line), `LOCAL SMOKE PASS (85 checks)`, `LOCAL FEATURES SMOKE PASS (36 checks)` (main still runs the features in this task; Task 3 moves them).

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/envSeed.ts scripts/serverEnvSeed.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5a-2): the Local server takes over the app's environments registry and dev stack files once (start --local --import-env-from <userData>)" -m "Co-Authored-By: <model trailer>" -- server src scripts
```

---

### Task 3: Every server window runs them on its server; main's code goes

**Files:**
- Rename: `src/renderer/src/localTeardown.ts` → `src/renderer/src/worktreeTeardown.ts`
- Delete: `src/main/docker.ts`, `src/main/environments.ts`, `src/main/stacks.ts`
- Modify: `src/renderer/src/backend.ts`, `backendFeatures.ts`, `environmentActions.ts`, `useEnvironmentPoll.ts`, `windowKind.ts`, `v2/backendV2.ts`, `v2/installV2.ts`; `components/` `DockerMenu`, `DockerPanel`, `EnvironmentPanel`, `SettingsPanel`, `StackPanel`, `WorktreeDetail`; `src/main/index.ts`, `src/main/appIpc.ts`, `src/preload/index.ts`
- Modify: `src/renderer/src/environmentStart.ts` (only the keys `env.up` takes)
- Test: `scripts/backendFeatures.test.mjs`, `scripts/v2Backend.test.mjs`, `scripts/environmentStart.test.mjs`, `scripts/serverMachine.test.mjs` (a main checkout's stack); `scripts/v2-smoke.mjs`, `scripts/local-features-smoke.mjs`

- [ ] **Step 1: The tests**

`backendFeatures`: docker, env and stacks each follow their capability, on any server, and not the Local entry; this machine's three need the Local entry and `local`; Environments in Settings wherever `env` is. `v2Backend`: every machine method's request (a worktree by the store's path, a repository by id, the long timeouts), a path the projection does not know refused before anything is sent, the logs by event name until unsubscribed; the delete's teardown on any server with `env` and `stacks`, and none without them, even on the Local entry. `environmentStart`: Start sends only the settings keys `env.up` takes, never a stored `profileKey` or a key another client wrote (the server refuses unknown keys). `serverMachine`: the main checkout's stack.

```diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index f9314cc..51d4a96 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -22,7 +22,7 @@ test('an empty window has no feature (4e: no file windows)', () => {
   for (const name of FEATURE_NAMES) assert.equal(NO_FEATURES[name], false, name)
 })
 
-test('a server window can have Linear, settings editing, the Global panel and the machine-local features', () => {
+test('a server window can have Linear, settings editing, the Global panel, the server machine\'s features and this machine\'s', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
   assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
 })
@@ -34,7 +34,18 @@ test('v2 features are the ceiling AND the welcome capabilities; Linear and setti
   // Before the first welcome there are no capabilities.
   assert.deepEqual(on(undefined), ['linear', 'settingsEdit'])
   // A capability the ceiling has off turns nothing on.
-  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['linear', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on(['mcp', 'bot', 'voice']), ['linear', 'settingsEdit', 'globalPanel'])
+})
+
+test("docker, env and stacks run on the server's machine: each follows its own capability, on any server (5a)", () => {
+  const on = (caps, options) => ['docker', 'env', 'stacks'].filter((name) => v2Features(caps, options)[name])
+  assert.deepEqual(on(['mcp', 'docker', 'env', 'stacks']), ['docker', 'env', 'stacks'])
+  assert.deepEqual(on(['docker']), ['docker'])
+  assert.deepEqual(on(['env', 'stacks']), ['env', 'stacks'])
+  // A server older than 5a: none, even on the Local entry with `local`.
+  assert.deepEqual(on(['mcp', 'local'], { localEntry: true }), [])
+  // The Local entry needs nothing more than the capabilities.
+  assert.deepEqual(on(['docker', 'env', 'stacks'], { localEntry: false }), ['docker', 'env', 'stacks'])
 })
 
 test("the settings sections: a server window hides this machine's and keeps the project's agents", () => {
@@ -60,11 +71,12 @@ test("the settings sections: a server window hides this machine's and keeps the
   ])
 })
 
-const MACHINE = ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor']
+const MACHINE = ['skills', 'reveal', 'openInEditor']
+const SERVER_MACHINE = ['mcp', 'docker', 'env', 'stacks']
 
-test("the Local entry's server, welcomed with `local`, has the machine-local features", () => {
+test("the Local entry's server, welcomed with `local`, has this machine's features too", () => {
   const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
-  assert.deepEqual(on(['mcp', 'local'], { localEntry: true }), [
+  assert.deepEqual(on([...SERVER_MACHINE, 'local'], { localEntry: true }), [
     'docker',
     'env',
     'stacks',
@@ -76,26 +88,25 @@ test("the Local entry's server, welcomed with `local`, has the machine-local fea
     'globalPanel'
   ])
   // Never the bot, voice, moving worktrees or promote (phase 5).
-  for (const name of ['bot', 'voice', 'moveWorktree', 'promote']) assert.equal(v2Features(['mcp', 'local'], { localEntry: true })[name], false, name)
+  for (const name of ['bot', 'voice', 'moveWorktree', 'promote']) assert.equal(v2Features([...SERVER_MACHINE, 'local'], { localEntry: true })[name], false, name)
 })
 
-test('the machine-local features need both the Local entry and the `local` capability', () => {
+test("this machine's features need both the Local entry and the `local` capability", () => {
   const any = (caps, options) => MACHINE.filter((name) => v2Features(caps, options)[name])
   // A saved entry whose server says `local` (a tunnel to another machine's Local server): its paths are not on this disk.
-  assert.deepEqual(any(['mcp', 'local']), [])
-  assert.deepEqual(any(['mcp', 'local'], { localEntry: false }), [])
+  assert.deepEqual(any([...SERVER_MACHINE, 'local']), [])
+  assert.deepEqual(any([...SERVER_MACHINE, 'local'], { localEntry: false }), [])
   // The Local entry before its welcome, or a server there that is not a Local one.
   assert.deepEqual(any(undefined, { localEntry: true }), [])
-  assert.deepEqual(any(['mcp'], { localEntry: true }), [])
+  assert.deepEqual(any(SERVER_MACHINE, { localEntry: true }), [])
 })
 
-test('a Local window also shows the environments; voice stays hidden', () => {
-  const local = settingsSections(v2Features(['mcp', 'local'], { localEntry: true }))
-  const hidden = SETTINGS_SECTIONS.filter((name) => local[name] === 'hidden')
-  assert.deepEqual(hidden, ['voice'])
-  assert.equal(local.environments, 'edit')
-  assert.equal(local.linear, 'edit')
-  assert.equal(local.agents, 'project')
+test('a window whose server runs environments shows them in Settings, on Local or not; voice stays hidden', () => {
+  for (const [caps, options] of [[[...SERVER_MACHINE, 'local'], { localEntry: true }], [SERVER_MACHINE, {}]]) {
+    const sections = settingsSections(v2Features(caps, options))
+    assert.deepEqual(SETTINGS_SECTIONS.filter((name) => sections[name] === 'hidden'), ['voice'])
+    assert.deepEqual([sections.environments, sections.linear, sections.agents], ['edit', 'edit', 'project'])
+  }
 })
 
 test('the same capabilities give the same object, so a React snapshot read is stable', () => {
diff --git a/scripts/environmentStart.test.mjs b/scripts/environmentStart.test.mjs
index ca40ad3..13cf8e8 100644
--- a/scripts/environmentStart.test.mjs
+++ b/scripts/environmentStart.test.mjs
@@ -16,6 +16,11 @@ test('envStartArgs: the branch variables parsed, the repository settings with th
   assert.deepEqual(envStartArgs(undefined, 'feat', 'c.yml'), { settings: { enabled: true, composeFile: 'c.yml' }, envVars: undefined })
 })
 
+test('envStartArgs sends only the keys env.up takes: not a profileKey, nor what another client stored', () => {
+  const repo = { id: 'r', name: 'r', path: '/r', environments: { enabled: true, memory: 8, rosetta: true, profileKey: '/old/r', vmType: 'qemu' } }
+  assert.deepEqual(envStartArgs(repo, 'feat', 'compose.yml').settings, { enabled: true, memory: 8, rosetta: true, composeFile: 'compose.yml' })
+})
+
 test("a server window's Start right after typing uses the variables still pending on the server", () => {
   const mirror = {
     id: 'p',
diff --git a/scripts/serverMachine.test.mjs b/scripts/serverMachine.test.mjs
index d08b555..dcedb4e 100644
--- a/scripts/serverMachine.test.mjs
+++ b/scripts/serverMachine.test.mjs
@@ -235,6 +235,9 @@ test("stack.*: the worktree's stack.sh, by the server's own path; its state in t
   for (const bad of [{ fileId: -1, offset: 0 }, { fileId: 0, offset: 1.5 }, { fileId: '0', offset: 0 }]) refused(await s.call('stack.log', { ...ref, ...bad }), 'BAD_REQUEST')
   refused(await s.call('stack.up', { ...ref, starter: 'yes' }), 'BAD_REQUEST')
   assert.equal((await s.call('stack.destroy', ref)).result, 0)
+  // The main checkout has its own stack: the repository's.
+  const main = s.repo().worktrees.find((w) => w.isMain)
+  assert.deepEqual((await s.call('stack.status', { projectId: s.projectId, worktreeId: main.id })).result.slug, 'a')
 })
 
 test('worktree.dirty reads git afresh; a worktree outside the allowlist is PATH_DENIED for every machine method', async (t) => {
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index a9cf4fc..64dfeef 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -26,13 +26,16 @@ class CodedError extends Error {
  * method (a value, a function of the params, or an Error to reject with), and
  * `ui` records what the dialogs were asked; `reports` what went to `report`.
  * `revs` is the rev each method's response reports; `waits` records each
- * whenProjected's rev (null without one).
+ * whenProjected's rev (null without one); `timeouts` each request sent with
+ * one; `listeners` what subscribed to each server event.
  */
 function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], localEntry = false, machine = {}, projectedAfter = [], left = () => false, revs = {} } = {}) {
   const calls = []
   const ui = []
   const reports = []
   const waits = []
+  const timeouts = []
+  const listeners = {}
   const st = {
     project: { name: 'p', version: 3, repositories: [repo()], globalSessions: [] },
     terminals: {},
@@ -43,8 +46,9 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
   }
   const answers = [...confirms]
   const idMap = ids()
-  const request = async (method, params) => {
+  const request = async (method, params, options) => {
     calls.push([method, params])
+    if (options?.timeoutMs !== undefined) timeouts.push([method, options.timeoutMs])
     const reply = replies[method]
     const value = typeof reply === 'function' ? reply(params) : reply
     if (value instanceof Error) throw value
@@ -60,6 +64,12 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     // null stands for "no welcome yet" (undefined would take the default)
     capabilities: typeof capabilities === 'function' ? capabilities : () => capabilities ?? undefined,
     localEntry,
+    onEvent: (event, listener) => {
+      ;(listeners[event] ??= []).push(listener)
+      return () => {
+        listeners[event] = listeners[event].filter((l) => l !== listener)
+      }
+    },
     ids: () => idMap,
     state: () => st,
     // Each projectedAfter entry is applied to the state and ids before the check, like a patch arriving.
@@ -85,9 +95,9 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     removalBlock: (r) => (r.id === 'blocked' ? 'It has live sessions.' : null),
     report: (title, err) => void (left() || reports.push([title, err.code])),
     reportEdit: (title, err, notConfirmed) => void (left() || reports.push([title, err.code, notConfirmed ?? 'edit'])),
-    // This machine's teardown: `machine.env` is the branch's VM, `machine.stack` its dev stack's name
-    // (offered as the confirm's checkbox), `machine.ticked` the checkbox's answer, `machine.dirty`
-    // what a fresh git status of the worktree on this disk says.
+    // The server machine's teardown: `machine.env` is the branch's VM, `machine.stack` its dev stack's
+    // name (offered as the confirm's checkbox), `machine.ticked` the checkbox's answer, `machine.dirty`
+    // what a fresh git status of the worktree (worktree.dirty) says.
     teardown: {
       environment: (info) => {
         ui.push(['env?', info.path])
@@ -107,7 +117,7 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     },
     left
   })
-  return { backend, calls, ui, st, reports, waits }
+  return { backend, calls, ui, st, reports, waits, timeouts, listeners }
 }
 
 test('features follow the welcome capabilities, with a stable object', () => {
@@ -131,20 +141,101 @@ test('features before the welcome, then when the capabilities change', () => {
   assert.equal(backend.features.globalPanel, false)
 })
 
-test("the machine-local features: only the Local entry's server, once it says `local`; Linear everywhere", () => {
-  const machine = (b) => ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor'].filter((name) => b.features[name])
-  assert.deepEqual(machine(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor'])
-  assert.deepEqual(machine(setup({ capabilities: ['mcp', 'local'] }).backend), [])
-  assert.deepEqual(machine(setup({ capabilities: ['mcp'], localEntry: true }).backend), [])
+test("this machine's features: only the Local entry's server, once it says `local`; the server machine's follow its capabilities; Linear everywhere", () => {
+  const local = (b) => ['skills', 'reveal', 'openInEditor'].filter((name) => b.features[name])
+  const server = (b) => ['docker', 'env', 'stacks'].filter((name) => b.features[name])
+  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['skills', 'reveal', 'openInEditor'])
+  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'] }).backend), [])
+  assert.deepEqual(local(setup({ capabilities: ['mcp'], localEntry: true }).backend), [])
+  assert.deepEqual(server(setup({ capabilities: ['mcp', 'docker', 'env', 'stacks'] }).backend), ['docker', 'env', 'stacks'])
+  assert.deepEqual(server(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), [])
   assert.equal(setup().backend.features.linear, true)
-  // The Local entry before its welcome, then once it arrives.
+  // A server before its welcome, then once it arrives.
   let caps
-  const { backend } = setup({ capabilities: () => caps, localEntry: true })
+  const { backend } = setup({ capabilities: () => caps })
   assert.equal(backend.features.env, false)
-  caps = ['mcp', 'local']
+  caps = ['mcp', 'env']
   assert.equal(backend.features.env, true)
 })
 
+test("docker, env and stacks go to the server by id: a worktree by the store's path, a repository by its id; the long ones with long timeouts", async () => {
+  const { backend, calls, timeouts } = setup({ replies: { 'env.up': { code: 0 }, 'worktree.dirty': true } })
+  const feat = { path: '/r-feat' }
+  await backend.docker.list()
+  await backend.docker.container('restart', 'c1')
+  await backend.docker.compose('r1', 'upBuild')
+  await backend.env.check()
+  await backend.env.list('r1')
+  await backend.env.up(feat, { enabled: true, cpu: 3 }, { FOO: 'bar' })
+  await backend.env.up(feat, { enabled: true }, undefined)
+  await backend.env.stop('twb-feat-abc123')
+  await backend.env.destroy('twb-feat-abc123')
+  await backend.env.ps(feat, undefined)
+  await backend.env.ps(feat, 'compose.dev.yaml')
+  await backend.env.composeFiles(feat)
+  await backend.env.logs(feat, undefined, 'web', 300)
+  await backend.stacks.status(feat)
+  await backend.stacks.up(feat, true)
+  await backend.stacks.down(feat)
+  await backend.stacks.destroy({ path: '/r' })
+  await backend.stacks.log(feat, 7, 120)
+  assert.equal(await backend.git.dirty(feat), true)
+  const w = { projectId: 'p1', worktreeId: 'w2' }
+  assert.deepEqual(calls, [
+    ['docker.list', {}],
+    ['docker.container', { action: 'restart', id: 'c1' }],
+    ['docker.compose', { projectId: 'p1', repoId: 'r1', action: 'upBuild' }],
+    ['env.check', {}],
+    ['env.list', { projectId: 'p1', repoId: 'r1' }],
+    ['env.up', { ...w, settings: { enabled: true, cpu: 3 }, envVars: { FOO: 'bar' } }],
+    ['env.up', { ...w, settings: { enabled: true } }],
+    ['env.stop', { profile: 'twb-feat-abc123' }],
+    ['env.destroy', { profile: 'twb-feat-abc123' }],
+    ['env.ps', w],
+    ['env.ps', { ...w, composeFile: 'compose.dev.yaml' }],
+    ['env.composeFiles', w],
+    ['env.logs', { ...w, service: 'web', tail: 300 }],
+    ['stack.status', w],
+    ['stack.up', { ...w, starter: true }],
+    ['stack.down', w],
+    ['stack.destroy', { projectId: 'p1', worktreeId: 'wm' }],
+    ['stack.log', { ...w, fileId: 7, offset: 120 }],
+    ['worktree.dirty', w]
+  ])
+  const minutes = (ms) => ms / 60_000
+  assert.deepEqual(timeouts.map(([m, ms]) => [m, minutes(ms)]), [
+    ['docker.container', 3],
+    ['docker.compose', 30],
+    ['env.up', 30],
+    ['env.up', 30],
+    ['env.stop', 10],
+    ['env.destroy', 10],
+    ['stack.down', 10],
+    ['stack.destroy', 10]
+  ])
+})
+
+test('a worktree path the projection does not know is refused here, and nothing is sent', async () => {
+  const { backend, calls } = setup()
+  await assert.rejects(backend.env.up({ path: '/elsewhere' }, { enabled: true }, undefined), (err) => err.code === 'NOT_FOUND')
+  await assert.rejects(backend.stacks.status({ path: '/elsewhere' }), (err) => err.code === 'NOT_FOUND')
+  assert.deepEqual(calls, [])
+})
+
+test("the logs come from the window's connection, by event name, until unsubscribed", () => {
+  const { backend, listeners } = setup()
+  const docker = []
+  const env = []
+  const offDocker = backend.docker.onLog((e) => docker.push(e.data))
+  const offEnv = backend.env.onLog((e) => env.push([e.profile, e.step ?? null]))
+  for (const l of listeners['docker.log']) l({ data: 'pulling' })
+  for (const l of listeners['env.log']) l({ profile: 'twb-x', data: '', step: 'vm' })
+  offDocker()
+  offEnv()
+  assert.deepEqual([listeners['docker.log'], listeners['env.log']], [[], []])
+  assert.deepEqual([docker, env], [['pulling'], [['twb-x', 'vm']]])
+})
+
 test('start by instance id or by path sends session.start with the v2 worktree, a size, the type and agent', async () => {
   const projectedAfter = [(st) => (st.terminals.s9 = { id: 's9', worktreeId: 'w2', title: 't', sessionId: 's9', status: 'idle' })]
   const { backend, calls, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } }, projectedAfter })
@@ -400,10 +491,11 @@ test('remove: a failed unload is shown, and nothing is loaded again', async () =
   assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
 })
 
-const LOCAL = { capabilities: ['mcp', 'local'], localEntry: true }
+// A server that runs the environments and the stacks (5a): any server, Local or not.
+const MACHINE_CAPS = { capabilities: ['mcp', 'docker', 'env', 'stacks'] }
 
-test("remove in a Local window: the stack and the VM go after the unload, before git's removal (legacy's order)", async () => {
-  const { backend, calls, ui } = setup({ ...LOCAL, confirms: [true], state: LOADED, machine: { env: 'twb-feat-abc123', stack: 'r-feat' } })
+test("remove on a server with env and stacks: the stack and the VM go after the unload, before git's removal (4c's order)", async () => {
+  const { backend, calls, ui } = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, machine: { env: 'twb-feat-abc123', stack: 'r-feat' } })
   await backend.worktrees.remove(feat, undefined)
   assert.deepEqual(ui[0], ['env?', '/r-feat'])
   assert.equal(ui[1][0], 'confirm+stack')
@@ -416,50 +508,50 @@ test("remove in a Local window: the stack and the VM go after the unload, before
   ])
 })
 
-test('remove in a Local window: declined tears nothing down; the stack box unticked keeps the stack', async () => {
-  const declined = setup({ ...LOCAL, confirms: [false], machine: { env: 'twb-x', stack: 'r-feat' } })
+test('remove on a server with env and stacks: declined tears nothing down; the stack box unticked keeps the stack', async () => {
+  const declined = setup({ ...MACHINE_CAPS, confirms: [false], machine: { env: 'twb-x', stack: 'r-feat' } })
   await declined.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(declined.calls, [])
-  const unticked = setup({ ...LOCAL, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat', ticked: false } })
+  const unticked = setup({ ...MACHINE_CAPS, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat', ticked: false } })
   await unticked.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(unticked.calls.map(([m]) => m), ['colima delete', 'worktree.remove'])
   // No VM and no stack: only git's removal.
-  const bare = setup({ ...LOCAL, confirms: [true] })
+  const bare = setup({ ...MACHINE_CAPS, confirms: [true] })
   await bare.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(bare.calls.map(([m]) => m), ['worktree.remove'])
 })
 
-test('remove in a Local window: a fresh check finds changes the poll missed, and asks before anything is destroyed', async () => {
+test('remove on a server with env and stacks: a fresh check finds changes the poll missed, and asks before anything is destroyed', async () => {
   // Declined: nothing is unloaded, destroyed or removed.
-  const declined = setup({ ...LOCAL, confirms: [true, false], state: LOADED, machine: { env: 'twb-x', stack: 'r-feat', dirty: true } })
+  const declined = setup({ ...MACHINE_CAPS, confirms: [true, false], state: LOADED, machine: { env: 'twb-x', stack: 'r-feat', dirty: true } })
   await declined.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(declined.calls, [])
   assert.deepEqual(declined.ui.slice(2), [['git status', '/r-feat'], ['confirm', 'Delete Uncommitted Changes', 'Delete Changes & Worktree']])
   // Accepted: the teardown, then a forced removal (no second ask).
-  const accepted = setup({ ...LOCAL, confirms: [true, true], machine: { env: 'twb-x', dirty: true } })
+  const accepted = setup({ ...MACHINE_CAPS, confirms: [true, true], machine: { env: 'twb-x', dirty: true } })
   await accepted.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(accepted.calls.map(([m, p]) => [m, p?.force]), [['colima delete', undefined], ['worktree.remove', true]])
   assert.equal(accepted.ui.filter(([kind]) => kind === 'confirm').length, 1)
 })
 
-test('remove in a Local window: no fresh check when nothing would be destroyed, or the poll already said dirty', async () => {
-  const bare = setup({ ...LOCAL, confirms: [true], machine: { dirty: true } })
+test('remove on a server with env and stacks: no fresh check when nothing would be destroyed, or the poll already said dirty', async () => {
+  const bare = setup({ ...MACHINE_CAPS, confirms: [true], machine: { dirty: true } })
   await bare.backend.worktrees.remove(feat, undefined)
   assert.ok(!bare.ui.some(([kind]) => kind === 'git status'))
-  const polled = setup({ ...LOCAL, confirms: [true], machine: { env: 'twb-x', dirty: true } })
+  const polled = setup({ ...MACHINE_CAPS, confirms: [true], machine: { env: 'twb-x', dirty: true } })
   await polled.backend.worktrees.remove({ ...feat, dirty: true }, undefined)
   assert.ok(!polled.ui.some(([kind]) => kind === 'git status'))
   assert.deepEqual(polled.calls.map(([m, p]) => [m, p?.force]), [['colima delete', undefined], ['worktree.remove', true]])
 })
 
-test('remove in a Local window that fails after the teardown: loaded again, and the error says the stack and VM are gone', async () => {
+test('remove on a server with env and stacks that fails after the teardown: loaded again, and the error says the stack and VM are gone', async () => {
   const replies = { 'worktree.remove': new CodedError('GIT_ERROR', "fatal: '/r-feat' is locked") }
-  const { backend, calls, ui } = setup({ ...LOCAL, confirms: [true], state: LOADED, replies, machine: { env: 'twb-x', stack: 'r-feat' } })
+  const { backend, calls, ui } = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, replies, machine: { env: 'twb-x', stack: 'r-feat' } })
   await backend.worktrees.remove(feat, undefined)
   assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'stack.sh destroy', 'colima delete', 'worktree.remove', 'worktree.load'])
   assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', "fatal: '/r-feat' is locked Its dev stack and its VM were already removed."])
   // A failed unload comes before any teardown: nothing to add.
-  const unload = setup({ ...LOCAL, confirms: [true], state: LOADED, replies: { 'worktree.unload': new CodedError('IN_USE', 'busy') }, machine: { env: 'twb-x' } })
+  const unload = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, replies: { 'worktree.unload': new CodedError('IN_USE', 'busy') }, machine: { env: 'twb-x' } })
   await unload.backend.worktrees.remove(feat, undefined)
   assert.deepEqual(unload.ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
 })
@@ -470,8 +562,8 @@ test('tornDownNote names what is already gone', () => {
   assert.equal(tornDownNote(false, true), ' Its VM was already removed.')
 })
 
-test("remove in any other server window never looks at this machine's environments or stacks", async () => {
-  for (const options of [{ capabilities: ['mcp', 'local'] }, { capabilities: ['mcp'], localEntry: true }, {}]) {
+test('remove on a server without env and stacks never looks at environments or stacks, not even on the Local entry', async () => {
+  for (const options of [{ capabilities: ['mcp', 'local'], localEntry: true }, { capabilities: ['mcp'], localEntry: true }, {}]) {
     const { backend, calls, ui } = setup({ ...options, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat' } })
     await backend.worktrees.remove(feat, undefined)
     assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree']])
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/backendFeatures.test.mjs scripts/v2Backend.test.mjs scripts/environmentStart.test.mjs scripts/serverMachine.test.mjs`

Expected:

```
not ok 5 - docker, env and stacks run on the server's machine: each follows its own capability, on any server (5a)
not ok 9 - a window whose server runs environments shows them in Settings, on Local or not; voice stays hidden
not ok 13 - envStartArgs sends only the keys env.up takes: not a profileKey, nor what another client stored
not ok 25 - this machine's features: only the Local entry's server, once it says `local`; the server machine's follow its capabilities; Linear everywhere
not ok 26 - docker, env and stacks go to the server by id: a worktree by the store's path, a repository by its id; the long ones with long timeouts
not ok 27 - a worktree path the projection does not know is refused here, and nothing is sent
not ok 28 - the logs come from the window's connection, by event name, until unsubscribed
not ok 52 - remove on a server with env and stacks: the stack and the VM go after the unload, before git's removal (4c's order)
not ok 53 - remove on a server with env and stacks: declined tears nothing down; the stack box unticked keeps the stack
not ok 54 - remove on a server with env and stacks: a fresh check finds changes the poll missed, and asks before anything is destroyed
not ok 55 - remove on a server with env and stacks: no fresh check when nothing would be destroyed, or the poll already said dirty
not ok 56 - remove on a server with env and stacks that fails after the teardown: loaded again, and the error says the stack and VM are gone
not ok 58 - remove on a server without env and stacks never looks at environments or stacks, not even on the Local entry
# tests 76
# pass 63
# fail 13
```

The gate still keys the three on the Local entry, the backend has no `docker`, `env`, `stacks` or `git.dirty`, the teardown keys on the Local entry, and `envStartArgs` passes every stored key.

- [ ] **Step 3: The backend, the panels, the teardown; main's code out**

```bash
git rm -q src/main/docker.ts src/main/environments.ts src/main/stacks.ts
```


```diff
diff --git a/src/main/appIpc.ts b/src/main/appIpc.ts
index 7432281..564a175 100644
--- a/src/main/appIpc.ts
+++ b/src/main/appIpc.ts
@@ -7,7 +7,6 @@ import { readFile } from 'node:fs/promises'
 import { join } from 'node:path'
 import { promisify } from 'node:util'
 import type { RecentEntry } from '../shared/types'
-import { worktreeDirty } from '../host/gitService'
 import { getRecents, removeRecent } from './recents'
 import { absolutePath, checkboxConfirmOptions, confirmOptions, editorPath, errorDialogText } from './appIpcRules'
 import { parseRecentRef } from './recentsRules'
@@ -84,13 +83,6 @@ export function registerAppIpc(): void {
     }
   })
 
-  // A Local server window's worktree, on this disk: null when git can't read it.
-  ipcMain.handle('git:localDirty', async (_event, raw: unknown): Promise<boolean | null> => {
-    const path = absolutePath(raw)
-    if (!path) throw new Error('path must be an absolute path')
-    return worktreeDirty(path)
-  })
-
   ipcMain.handle('app:revealInFinder', (_event, raw: unknown): void => {
     const dirPath = absolutePath(raw)
     if (!dirPath) throw new Error('dirPath must be an absolute path')
diff --git a/src/main/index.ts b/src/main/index.ts
index d6750c9..8d6ddc3 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -11,9 +11,6 @@ import { registerAppIpc } from './appIpc'
 import { registerGithubHandlers } from './github'
 import { registerLinearHandlers } from './linear'
 import { registerSkillHandlers } from './skills'
-import { registerDockerHandlers } from './docker'
-import { registerEnvironmentHandlers } from './environments'
-import { registerStackHandlers } from './stacks'
 import { closeServerLinks, registerAppServerHandlers } from './appServers'
 import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
 import { appSettings, registerAppSettingsHandlers } from './appSettings'
@@ -156,7 +153,7 @@ function buildMenu(): void {
 }
 
 app.whenReady().then(async () => {
-  // Must complete before anything spawns child processes (docker, git, colima).
+  // Must complete before anything spawns child processes (the local server, code, gh).
   await fixPath()
   void removeStaleMcpConfigs()
   registerWindowHandlers()
@@ -165,9 +162,6 @@ app.whenReady().then(async () => {
   registerGithubHandlers()
   registerLinearHandlers()
   registerSkillHandlers()
-  registerDockerHandlers()
-  registerEnvironmentHandlers()
-  registerStackHandlers()
   registerAppSettingsHandlers()
   // Before the links: their first connections are linked to the aggregator as they are made.
   registerAttentionHandlers()
diff --git a/src/preload/index.ts b/src/preload/index.ts
index d70aa29..ac5669e 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -7,22 +7,11 @@ import type {
   SessionSelect,
   V2SocketOpenResult,
   AppServerTest,
-  ContainerAction,
-  ContainerInfo,
-  DockerLogEvent,
-  EnvCheckResult,
-  EnvLogEvent,
-  EnvService,
-  EnvUpResult,
-  EnvironmentInfo,
-  EnvironmentSettings,
   LinearIssue,
   LinearKeyResult,
   InitialWindowState,
   RecentEntry,
   SkillInfo,
-  StackLogChunk,
-  StackStatus,
   VoiceConfig,
   VoiceInfo,
   VoiceKeyResult,
@@ -64,8 +53,6 @@ const api = {
   selectDirectory: (title: string): Promise<string | null> =>
     ipcRenderer.invoke('dialog:selectDirectory', title),
 
-  /** `git status` of a worktree on this disk (a Local window's delete); null when it can't be read. */
-  localWorktreeDirty: (path: string): Promise<boolean | null> => ipcRenderer.invoke('git:localDirty', path),
   openInVSCode: (dirPath: string): Promise<void> =>
     ipcRenderer.invoke('app:openInVSCode', dirPath),
   revealInFinder: (dirPath: string): Promise<void> =>
@@ -187,65 +174,6 @@ const api = {
   listSkills: (worktreePath: string): Promise<SkillInfo[]> =>
     ipcRenderer.invoke('skills:list', worktreePath),
 
-  // Docker
-  listContainers: (): Promise<ContainerInfo[]> => ipcRenderer.invoke('docker:list'),
-  containerAction: (action: ContainerAction, id: string): Promise<void> =>
-    ipcRenderer.invoke('docker:container', action, id),
-  compose: (args: string[], cwd: string): Promise<number> =>
-    ipcRenderer.invoke('docker:compose', args, cwd),
-  onDockerLog: (callback: (event: DockerLogEvent) => void): (() => void) =>
-    subscribe('docker:log', callback),
-
-  // Per-worktree dev stacks (the repo's docker/stack/stack.sh)
-  stackStatus: (worktreePath: string): Promise<StackStatus> =>
-    ipcRenderer.invoke('stack:status', worktreePath),
-  stackUp: (worktreePath: string, starter: boolean): Promise<void> =>
-    ipcRenderer.invoke('stack:up', worktreePath, starter),
-  stackDown: (worktreePath: string): Promise<number> =>
-    ipcRenderer.invoke('stack:down', worktreePath),
-  stackDestroy: (worktreePath: string): Promise<number> =>
-    ipcRenderer.invoke('stack:destroy', worktreePath),
-  stackLog: (worktreePath: string, fileId: number, offset: number): Promise<StackLogChunk> =>
-    ipcRenderer.invoke('stack:log', worktreePath, fileId, offset),
-
-  // Per-worktree environments (Colima VMs), on this machine only: main refuses a non-null serverId
-  envCheck: (): Promise<EnvCheckResult> => ipcRenderer.invoke('env:check'),
-  envList: (serverId: string | null, repoPath: string): Promise<EnvironmentInfo[]> =>
-    ipcRenderer.invoke('env:list', serverId, repoPath),
-  envUp: (
-    serverId: string | null,
-    repoPath: string,
-    branch: string,
-    worktreePath: string,
-    settings: EnvironmentSettings | undefined,
-    envVars?: Record<string, string>
-  ): Promise<EnvUpResult> =>
-    ipcRenderer.invoke('env:up', serverId, repoPath, branch, worktreePath, settings, envVars),
-  envStop: (serverId: string | null, profile: string): Promise<number> =>
-    ipcRenderer.invoke('env:stop', serverId, profile),
-  envDestroy: (serverId: string | null, profile: string): Promise<number> =>
-    ipcRenderer.invoke('env:destroy', serverId, profile),
-  envPs: (
-    serverId: string | null,
-    profile: string,
-    worktreePath: string,
-    composeFile?: string
-  ): Promise<EnvService[]> =>
-    ipcRenderer.invoke('env:ps', serverId, profile, worktreePath, composeFile),
-  envComposeFiles: (serverId: string | null, worktreePath: string): Promise<string[]> =>
-    ipcRenderer.invoke('env:composeFiles', serverId, worktreePath),
-  envLogs: (
-    serverId: string | null,
-    profile: string,
-    worktreePath: string,
-    composeFile: string | undefined,
-    service: string,
-    tail?: number
-  ): Promise<string> =>
-    ipcRenderer.invoke('env:logs', serverId, profile, worktreePath, composeFile, service, tail),
-  onEnvLog: (callback: (event: EnvLogEvent) => void): (() => void) =>
-    subscribe('env:log', callback),
-
   // Menu events
   onMenu: (
     channel:
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index a82c3b9..745fd74 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -16,9 +16,21 @@ import { NO_FEATURES, type BackendFeatures } from './backendFeatures'
 import { errorText } from './v2/errors'
 import type { LlmSelection } from '../../shared/providers/types'
 import type {
+  ComposeAction,
+  ContainerAction,
+  ContainerInfo,
+  DockerLogEvent,
+  EnvCheckResult,
+  EnvLogEvent,
+  EnvService,
+  EnvUpResult,
+  EnvironmentInfo,
+  EnvironmentSettings,
   GitWorktreeInfo,
   Repository,
   SessionType,
+  StackLogChunk,
+  StackStatus,
   WorktreeChanges,
   WorktreeInstance,
   WorktreeLocator
@@ -90,6 +102,41 @@ export interface WindowBackend {
     diff(loc: WorktreeLocator): Promise<Record<string, string>>
     pull(loc: WorktreeLocator, branch: string): Promise<void>
     push(loc: WorktreeLocator, branch: string): Promise<void>
+    /** A fresh `git status` of the worktree on its server; null when git cannot read it */
+    dirty(loc: WorktreeLocator): Promise<boolean | null>
+  }
+  /**
+   * Docker on the project's server's machine (feature `docker`). Each rejects with the server's
+   * error (TOOL_ERROR `missing` when docker is not installed there).
+   */
+  readonly docker: {
+    list(): Promise<ContainerInfo[]>
+    container(action: ContainerAction, id: string): Promise<void>
+    /** docker compose in the repository's main checkout; resolves its exit code. Its output comes as `onLog` */
+    compose(repoId: string, action: ComposeAction): Promise<number>
+    /** The output of this window's compose runs; returns the unsubscribe */
+    onLog(listener: (event: DockerLogEvent) => void): () => void
+  }
+  /** The worktrees' Colima environments on the server's machine (feature `env`), by worktree path */
+  readonly env: {
+    check(): Promise<EnvCheckResult>
+    list(repoId: string): Promise<EnvironmentInfo[]>
+    up(loc: WorktreeLocator, settings: EnvironmentSettings, envVars: Record<string, string> | undefined): Promise<EnvUpResult>
+    stop(profile: string): Promise<number>
+    destroy(profile: string): Promise<number>
+    ps(loc: WorktreeLocator, composeFile: string | undefined): Promise<EnvService[]>
+    composeFiles(loc: WorktreeLocator): Promise<string[]>
+    logs(loc: WorktreeLocator, composeFile: string | undefined, service: string, tail: number): Promise<string>
+    /** The output and steps of this window's up, stop and destroy runs; returns the unsubscribe */
+    onLog(listener: (event: EnvLogEvent) => void): () => void
+  }
+  /** The worktrees' dev stacks on the server's machine (feature `stacks`), by worktree path */
+  readonly stacks: {
+    status(loc: WorktreeLocator): Promise<StackStatus>
+    up(loc: WorktreeLocator, starter: boolean): Promise<void>
+    down(loc: WorktreeLocator): Promise<number>
+    destroy(loc: WorktreeLocator): Promise<number>
+    log(loc: WorktreeLocator, fileId: number, offset: number): Promise<StackLogChunk>
   }
   /** Branch data; null or an empty text clears the value */
   readonly branch: {
@@ -163,7 +210,20 @@ export const idleBackend: WindowBackend = {
     dismissDecision: noProject
   },
   worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject },
-  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, pull: noProject, push: noProject },
+  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, pull: noProject, push: noProject, dirty: noProject },
+  docker: { list: noProject, container: noProject, compose: noProject, onLog: () => () => {} },
+  env: {
+    check: noProject,
+    list: noProject,
+    up: noProject,
+    stop: noProject,
+    destroy: noProject,
+    ps: noProject,
+    composeFiles: noProject,
+    logs: noProject,
+    onLog: () => () => {}
+  },
+  stacks: { status: noProject, up: noProject, down: noProject, destroy: noProject, log: noProject },
   branch: { setTag: noProject, setCustomTag: noProject, setNote: noProject, setTicket: noProject, setPullRequest: noProject, setEnvVars: noProject },
   repos: { add: noProject, remove: noProject },
   errors: {
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index b4aa76d..2efddeb 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -38,19 +38,21 @@ export const FEATURE_NAMES: readonly FeatureName[] = [
 export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map((name) => [name, false])) as Record<FeatureName, boolean>
 
 /**
- * A server window (3c-2, 4c). The ceiling: the v2 backend's features are these
- * AND what `v2Features` asks of the server's welcome and the window's entry.
- * - Off: the bot and voice (local MCP tools, phase 5) and the git flows
- *   protocol v2 has no command for (moving a worktree, promote).
+ * A server window (3c-2, 4c, 5a). The ceiling: the v2 backend's features are
+ * these AND what `v2Features` asks of the server's welcome and the window's entry.
+ * - Off: the bot and voice (phase 5) and the git flows protocol v2 has no
+ *   command for (moving a worktree, promote).
  * - Settings are edited on the server (every v2 server has
  *   project.updateSettings, so no capability), with the sections
  *   `settingsSections` picks.
  * - Linear only reads ticket ids, with this machine's API key: on for every
  *   server (4c).
  * - The Global panel needs `mcp`.
- * - Docker, environments, stacks, skills, Reveal and Open in VS Code read or
- *   run things on this machine at the project's paths: only the Local
- *   server's paths are on this disk (`MACHINE_FEATURES`).
+ * - Docker, environments and stacks run on the server's machine (5a): each
+ *   needs its capability, on any server.
+ * - Skills, Reveal and Open in VS Code read or open things on this machine at
+ *   the project's paths: only the Local server's paths are on this disk
+ *   (`MACHINE_FEATURES`).
  */
 export const V2_FEATURES: BackendFeatures = {
   docker: true,
@@ -71,20 +73,25 @@ export const V2_FEATURES: BackendFeatures = {
 /**
  * The welcome capability a v2 feature needs, if any. Global sessions drive the
  * worktree sessions through the server's MCP tools, so without `mcp` they
- * could not do their job.
+ * could not do their job. Docker, the environments and the stacks are the
+ * server's own methods (5a): a server older than them has none of the three.
  */
 const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
-  globalPanel: 'mcp'
+  globalPanel: 'mcp',
+  docker: 'docker',
+  env: 'env',
+  stacks: 'stacks'
 }
 
 /**
- * The features that use the project's paths on this machine. A server window
- * has them only on the Local entry (the supervisor's own server, which main
- * found by its pid and profile) when its welcome says `local` too. Never by
- * the capability alone: a saved entry can reach another machine's Local
- * server through a tunnel, still on 127.0.0.1, and its paths are not here.
+ * The features that use the project's paths on this machine (Electron main
+ * reads or opens them). A server window has them only on the Local entry (the
+ * supervisor's own server, which main found by its pid and profile) when its
+ * welcome says `local` too. Never by the capability alone: a saved entry can
+ * reach another machine's Local server through a tunnel, still on 127.0.0.1,
+ * and its paths are not here. Skills move to the server in 5b.
  */
-export const MACHINE_FEATURES: readonly FeatureName[] = ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor']
+export const MACHINE_FEATURES: readonly FeatureName[] = ['skills', 'reveal', 'openInEditor']
 
 /** The `local` welcome capability (CAPABILITY.local in shared/protocolV2.ts). */
 const LOCAL_CAPABILITY = 'local'
@@ -165,9 +172,9 @@ export type SectionMode = 'edit' | 'project' | 'hidden'
 /**
  * Which Settings sections a window shows. A server window edits the project's
  * settings on the server and hides what belongs to this machine: the voice API
- * keys. Linear (its key is app-wide, in main)
- * shows where the window has the feature (every server), and the Docker
- * environments where it has `env` (the Local server: they run here).
+ * keys. Linear (its key is app-wide, in main) shows where the window has the
+ * feature (every server), and the Docker environments where it has `env` (a
+ * server that runs them, on its own machine).
  */
 export function settingsSections(features: BackendFeatures): Readonly<Record<SettingsSection, SectionMode>> {
   const out = {} as Record<SettingsSection, SectionMode>
diff --git a/src/renderer/src/components/DockerMenu.tsx b/src/renderer/src/components/DockerMenu.tsx
index e54e5cb..5ed98fd 100644
--- a/src/renderer/src/components/DockerMenu.tsx
+++ b/src/renderer/src/components/DockerMenu.tsx
@@ -1,19 +1,22 @@
 import { useEffect, useRef, useState } from 'react'
 import { createPortal } from 'react-dom'
+import { getBackend } from '../backend'
+import type { ComposeAction } from '../../../shared/types'
 
 const MENU_WIDTH = 300
 
-const COMPOSE_ACTIONS: { label: string; args: string[]; desc: string }[] = [
-  { label: 'compose up -d', args: ['up', '-d'], desc: 'Start services in the background' },
-  { label: 'compose up --build -d', args: ['up', '--build', '-d'], desc: 'Rebuild images, then start' },
-  { label: 'compose restart', args: ['restart'], desc: 'Restart all services' },
-  { label: 'compose stop', args: ['stop'], desc: 'Stop services without removing them' },
-  { label: 'compose down', args: ['down'], desc: 'Stop and remove containers and networks' },
-  { label: 'compose pull', args: ['pull'], desc: 'Pull the latest images' }
+// The server owns each action's arguments (dockerService.ts's COMPOSE_ARGS): the menu names the action.
+const COMPOSE_ACTIONS: { label: string; action: ComposeAction; desc: string }[] = [
+  { label: 'compose up -d', action: 'up', desc: 'Start services in the background' },
+  { label: 'compose up --build -d', action: 'upBuild', desc: 'Rebuild images, then start' },
+  { label: 'compose restart', action: 'restart', desc: 'Restart all services' },
+  { label: 'compose stop', action: 'stop', desc: 'Stop services without removing them' },
+  { label: 'compose down', action: 'down', desc: 'Stop and remove containers and networks' },
+  { label: 'compose pull', action: 'pull', desc: 'Pull the latest images' }
 ]
 
-/** The ▾ menu on the Docker tab: docker compose actions run in the main repo. */
-export function DockerMenu({ repoPath }: { repoPath: string }): React.JSX.Element {
+/** The ▾ menu on the Docker tab: docker compose actions run in the repository's main checkout, on its server. */
+export function DockerMenu({ repoId }: { repoId: string }): React.JSX.Element {
   const [open, setOpen] = useState(false)
   const [pos, setPos] = useState({ x: 0, y: 0 })
   const [running, setRunning] = useState<string | null>(null)
@@ -55,8 +58,10 @@ export function DockerMenu({ repoPath }: { repoPath: string }): React.JSX.Elemen
     if (running) return
     setRunning(action.label)
     try {
-      // Output streams into the Docker panel's log via docker:log events.
-      await window.api.compose(action.args, repoPath)
+      // Output streams into the Docker panel's log as the server's docker.log events.
+      await getBackend().docker.compose(repoId, action.action)
+    } catch {
+      // A failure the server could not even start (offline): the panel's poll shows docker's state.
     } finally {
       setRunning(null)
     }
diff --git a/src/renderer/src/components/DockerPanel.tsx b/src/renderer/src/components/DockerPanel.tsx
index 34a4d60..d17f36d 100644
--- a/src/renderer/src/components/DockerPanel.tsx
+++ b/src/renderer/src/components/DockerPanel.tsx
@@ -1,5 +1,6 @@
 import { useCallback, useEffect, useRef, useState } from 'react'
 import { useAppStore } from '../store'
+import { getBackend } from '../backend'
 import type { ContainerAction, ContainerInfo } from '../../../shared/types'
 
 interface Props {
@@ -23,7 +24,7 @@ export function DockerPanel({ visible }: Props): React.JSX.Element {
 
   const refresh = useCallback(async (): Promise<void> => {
     try {
-      setContainers(await window.api.listContainers())
+      setContainers(await getBackend().docker.list())
       setError(null)
     } catch (err) {
       setError(String(err))
@@ -40,7 +41,7 @@ export function DockerPanel({ visible }: Props): React.JSX.Element {
   // Compose output streams in regardless of which tab is showing.
   useEffect(
     () =>
-      window.api.onDockerLog(({ data, done }) => {
+      getBackend().docker.onLog(({ data, done }) => {
         setLog((prev) => (prev + data).slice(-MAX_LOG))
         if (done) void refresh()
       }),
@@ -56,7 +57,7 @@ export function DockerPanel({ visible }: Props): React.JSX.Element {
   const act = async (container: ContainerInfo, action: ContainerAction): Promise<void> => {
     setBusy((prev) => ({ ...prev, [container.id]: action }))
     try {
-      await window.api.containerAction(action, container.id)
+      await getBackend().docker.container(action, container.id)
     } catch (err) {
       appendLog(`\n${String(err)}\n`)
     } finally {
@@ -80,7 +81,7 @@ export function DockerPanel({ visible }: Props): React.JSX.Element {
     setBulkBusy(action)
     appendLog(`\n[${action}ing ${targets.length} favorite container(s)…]\n`)
     const results = await Promise.allSettled(
-      targets.map((c) => window.api.containerAction(action, c.id))
+      targets.map((c) => getBackend().docker.container(action, c.id))
     )
     for (let i = 0; i < results.length; i++) {
       const r = results[i]
diff --git a/src/renderer/src/components/EnvironmentPanel.tsx b/src/renderer/src/components/EnvironmentPanel.tsx
index 9800264..0ad1b52 100644
--- a/src/renderer/src/components/EnvironmentPanel.tsx
+++ b/src/renderer/src/components/EnvironmentPanel.tsx
@@ -5,6 +5,7 @@ import { refreshEnvironments } from '../environmentActions'
 import { envStartArgs } from '../environmentStart'
 import { SettingText } from './SettingText'
 import { environmentFor, repoById, repoOfInfo, useAppStore } from '../store'
+import { getBackend } from '../backend'
 
 interface Props {
   visible: boolean
@@ -75,7 +76,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
   // Output (and step markers) stream in regardless of which tab is showing.
   useEffect(() => {
     if (!profile) return undefined
-    return window.api.onEnvLog((event) => {
+    return getBackend().env.onLog((event) => {
       if (event.profile !== profile) return
       if (event.data) appendLog(event.data)
       if (event.step) {
@@ -107,8 +108,8 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
   useEffect(() => {
     if (!visible) return undefined
     let disposed = false
-    window.api
-      .envComposeFiles(null, info.path)
+    getBackend()
+      .env.composeFiles({ path: info.path })
       .then((files) => {
         if (!disposed) setComposeCandidates(files)
       })
@@ -126,7 +127,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     let disposed = false
     const poll = async (): Promise<void> => {
       try {
-        const result = await window.api.envPs(null, profile, info.path, composeFile)
+        const result = await getBackend().env.ps({ path: info.path }, composeFile)
         if (!disposed) setServices(result)
       } catch {
         // VM mid-boot or context missing — the next poll retries
@@ -145,14 +146,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     let disposed = false
     const fetchLogs = async (): Promise<void> => {
       try {
-        const text = await window.api.envLogs(
-          null,
-          profile,
-          info.path,
-          composeFile,
-          logsService,
-          SERVICE_LOGS_TAIL
-        )
+        const text = await getBackend().env.logs({ path: info.path }, composeFile, logsService, SERVICE_LOGS_TAIL)
         if (!disposed) setServiceLogs(text)
       } catch (err) {
         if (!disposed) setServiceLogs(String(err))
@@ -191,7 +185,8 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
       // committed is in it (a server window shows the pending edit at once).
       const now = useAppStore.getState().project
       const { settings, envVars } = envStartArgs(now ? repoById(now, info.repoId) : repo, info.branch!, composeFile)
-      const result = await window.api.envUp(null, repoPath, info.branch!, info.path, settings, envVars)
+      // The server names the VM after the repository and the branch it has checked out (the same profile as here).
+      const result = await getBackend().env.up({ path: info.path }, settings, envVars)
       if (result.code === 0) {
         setSteps({ vm: 'done', compose: 'done', ready: 'done' })
       } else {
@@ -215,7 +210,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     setError(null)
     setSteps(null)
     try {
-      await window.api.envStop(null, profile)
+      await getBackend().env.stop(profile)
     } catch (err) {
       setError(String(err))
     } finally {
@@ -237,7 +232,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     setError(null)
     setSteps(null)
     try {
-      await window.api.envDestroy(null, profile)
+      await getBackend().env.destroy(profile)
     } catch (err) {
       setError(String(err))
     } finally {
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index da76e6f..eb8c6db 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -13,6 +13,7 @@ import { LlmPicker, useServerPicker } from './LlmPicker'
 import { SettingNumber, SettingText } from './SettingText'
 import { settingsSections } from '../backendFeatures'
 import { useFeatures } from '../useFeatures'
+import { getBackend } from '../backend'
 import type {
   SessionType,
   EnvironmentSettings,
@@ -120,7 +121,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
     if (!ok) return
     setEnvBusy(profile, 'destroy')
     try {
-      await window.api.envDestroy(null, profile)
+      await getBackend().env.destroy(profile)
     } catch (err) {
       void window.api.showError('Could not remove environment', String(err))
     } finally {
diff --git a/src/renderer/src/components/StackPanel.tsx b/src/renderer/src/components/StackPanel.tsx
index f776cd0..63b1add 100644
--- a/src/renderer/src/components/StackPanel.tsx
+++ b/src/renderer/src/components/StackPanel.tsx
@@ -1,6 +1,7 @@
 import { useEffect, useRef, useState } from 'react'
 import type { StackStatus } from '../../../shared/types'
 import { STACK_STATE_LABELS, stackState, stackUrls, stripAnsi } from '../stacks'
+import { getBackend } from '../backend'
 
 interface Props {
   visible: boolean
@@ -13,7 +14,7 @@ interface Props {
 const LOG_POLL_MS = 1000
 const MAX_LOG = 200_000
 
-/** The Stack tab: start/stop the worktree's docker/stack/stack.sh dev stack. */
+/** The Stack tab: start/stop the worktree's docker/stack/stack.sh dev stack, on its server's machine. */
 export function StackPanel({ visible, worktreePath, status, onChanged }: Props): React.JSX.Element {
   const [starter, setStarter] = useState(false)
   const [pending, setPending] = useState<'start' | 'stop' | null>(null)
@@ -38,7 +39,7 @@ export function StackPanel({ visible, worktreePath, status, onChanged }: Props):
     const poll = async (): Promise<void> => {
       try {
         const { id, offset } = fileRef.current
-        const chunk = await window.api.stackLog(worktreePath, id, offset)
+        const chunk = await getBackend().stacks.log({ path: worktreePath }, id, offset)
         if (disposed || fileRef.current.id !== id) return
         fileRef.current = { id: chunk.fileId, offset: chunk.offset }
         if (chunk.fileId !== id) setLog(stripAnsi(chunk.text))
@@ -64,7 +65,7 @@ export function StackPanel({ visible, worktreePath, status, onChanged }: Props):
     setPending('start')
     setError(null)
     try {
-      await window.api.stackUp(worktreePath, starter)
+      await getBackend().stacks.up({ path: worktreePath }, starter)
       followRef.current = true
     } catch (err) {
       setError(String(err))
@@ -79,7 +80,7 @@ export function StackPanel({ visible, worktreePath, status, onChanged }: Props):
     setError(null)
     onChanged()
     try {
-      const code = await window.api.stackDown(worktreePath)
+      const code = await getBackend().stacks.down({ path: worktreePath })
       if (code !== 0) setError(`stack.sh down exited with code ${code} — see the output below`)
     } catch (err) {
       setError(String(err))
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 55a3e47..8448a17 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -61,7 +61,7 @@ type Panel =
 
 const STACK_POLL_MS = 4000
 
-/** Polls the worktree's docker/stack/stack.sh status; null while `off` or unknown. */
+/** Polls the worktree's docker/stack/stack.sh status on its server; null while `off` or unknown. */
 function useStackStatus(
   path: string | undefined,
   off: boolean
@@ -70,8 +70,8 @@ function useStackStatus(
 
   const refresh = useCallback(() => {
     if (!path || off) return
-    window.api
-      .stackStatus(path)
+    getBackend()
+      .stacks.status({ path })
       .then((next) =>
         setStatus((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
       )
@@ -129,8 +129,7 @@ export function WorktreeDetail({
 
   const features = useFeatures()
   const path = info?.path
-  // A remote server's paths are not on this disk: nothing here may poll them locally. A Local
-  // server window's are (`features.stacks`).
+  // The stack runs on the server's machine (`features.stacks`, any server that has `stacks`).
   const [stack, refreshStack] = useStackStatus(path, !features.stacks)
   const changesState = useWorktreeChanges(path, offline, panel === 'changes')
   useEffect(() => {
@@ -712,7 +711,7 @@ export function WorktreeDetail({
             className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
             onClick={() => setPanel(panel === 'docker' ? 'sessions' : 'docker')}
           >
-            Docker <DockerMenu key={repo.id} repoPath={repo.path} />
+            Docker <DockerMenu key={repo.id} repoId={repo.id} />
           </button>
         )}
         {showEnv && (
diff --git a/src/renderer/src/environmentActions.ts b/src/renderer/src/environmentActions.ts
index 562f953..bfe5f9b 100644
--- a/src/renderer/src/environmentActions.ts
+++ b/src/renderer/src/environmentActions.ts
@@ -1,17 +1,19 @@
-import { envRepoKey } from '../../shared/environments'
+import { getBackend } from './backend'
 import { environmentFor, useAppStore } from './store'
 
 /**
- * Pull the current environment list into the store. Cheap (one colima list),
- * called by the Workspace poll and after every environment operation so the
- * badges update immediately instead of waiting out the poll interval.
+ * Pull the current environment list into the store. Cheap (one colima list on the server's
+ * machine per repository, which names its VMs by its envRepoKey), called by the workspace's poll
+ * and after every environment operation so the badges update immediately instead of waiting out
+ * the poll interval.
  */
 export async function refreshEnvironments(): Promise<void> {
   const { project, envToolCheck, setEnvironments } = useAppStore.getState()
   const repos = project?.repositories.filter((r) => r.environments?.enabled) ?? []
   if (repos.length === 0 || !envToolCheck?.ok) return
+  const backend = getBackend()
   try {
-    const lists = await Promise.all(repos.map((r) => window.api.envList(null, envRepoKey(r))))
+    const lists = await Promise.all(repos.map((r) => backend.env.list(r.id)))
     setEnvironments(lists.flat())
   } catch {
     // colima hiccup — keep the last known state; the next poll retries
@@ -33,7 +35,7 @@ export async function destroyEnvironmentIfAny(
   if (!env) return undefined
   setEnvBusy(env.profile, 'destroy')
   try {
-    await window.api.envDestroy(null, env.profile)
+    await getBackend().env.destroy(env.profile)
     return undefined
   } catch (err) {
     return `Failed to remove environment VM "${env.profile}": ${String(err)}`
diff --git a/src/renderer/src/environmentStart.ts b/src/renderer/src/environmentStart.ts
index b8de259..3a6fdd8 100644
--- a/src/renderer/src/environmentStart.ts
+++ b/src/renderer/src/environmentStart.ts
@@ -1,4 +1,4 @@
-// What an environment's Start / Apply compose passes to `envUp`, read from the
+// What an environment's Start / Apply compose passes to `env.up`, read from the
 // project when the button is pressed, not from the render that drew it: in a
 // server window a variables draft committed by the button's own click (the
 // textarea's blur) is pending in the overlay, and the store already shows it.
@@ -13,10 +13,19 @@ export interface EnvStartArgs {
   envVars: Record<string, string> | undefined
 }
 
+/**
+ * The settings `env.up` takes: the server refuses any other key (its args.ts), and a repository's
+ * stored `environments` can hold others (another client's, an old file's) and `profileKey`, which
+ * the server reads from its own copy of the repository.
+ */
+const ENV_UP_KEYS = ['enabled', 'cpu', 'memory', 'disk', 'networkAddress', 'rosetta'] as const
+
 export function envStartArgs(repo: Repository | undefined, branch: string, composeFile: string): EnvStartArgs {
   const envVars = parseEnvVars(repo?.branchEnvVars?.[branch] ?? '')
+  const stored = (repo?.environments ?? {}) as Partial<Record<string, unknown>>
+  const picked = Object.fromEntries(ENV_UP_KEYS.filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]]))
   return {
-    settings: { enabled: true, ...repo?.environments, composeFile },
+    settings: { enabled: true, ...picked, composeFile } as EnvironmentSettings,
     envVars: Object.keys(envVars).length > 0 ? envVars : undefined
   }
 }
diff --git a/src/renderer/src/useEnvironmentPoll.ts b/src/renderer/src/useEnvironmentPoll.ts
index 64f2253..bcf8f65 100644
--- a/src/renderer/src/useEnvironmentPoll.ts
+++ b/src/renderer/src/useEnvironmentPoll.ts
@@ -1,25 +1,34 @@
 // The Colima environments' poll, for the env badges, the Env panel and
-// Settings' orphan list: a Local server window's V2Workspace runs it. It starts once a repository has environments on:
-// the tool check first (colima and docker on PATH), then `colima list` every
-// ENV_POLL_MS. refreshEnvironments no-ops until the check has passed.
+// Settings' orphan list: a server window's V2Workspace runs it, with the `env`
+// feature (the server runs them on its machine). It starts once a repository
+// has environments on: the tool check first (colima and docker on the server's
+// PATH), then `colima list` every ENV_POLL_MS. refreshEnvironments no-ops until
+// the check has passed.
 import { useEffect } from 'react'
 import { useAppStore } from './store'
+import { getBackend } from './backend'
 import { refreshEnvironments } from './environmentActions'
 
 // colima list is heavier than git worktree list — poll it less often.
 const ENV_POLL_MS = 10_000
 
-/** `allowed`: the window may run things on this machine for the project (`features.env`). */
+/** `allowed`: the window's server runs the environments (`features.env`). */
 export function useEnvironmentPoll(allowed: boolean): void {
-  const envEnabled = useAppStore((s) => allowed && !!s.project?.repositories.some((r) => r.environments?.enabled))
+  // Paused while the link is down: the server can't answer, and the check runs again once it is back.
+  const envEnabled = useAppStore((s) => allowed && !s.serverOffline && !!s.project?.repositories.some((r) => r.environments?.enabled))
   useEffect(() => {
     if (!envEnabled) return
     let cancelled = false
-    void window.api.envCheck().then((result) => {
-      if (cancelled) return
-      useAppStore.getState().setEnvToolCheck(result)
-      void refreshEnvironments()
-    })
+    getBackend()
+      .env.check()
+      .then((result) => {
+        if (cancelled) return
+        useAppStore.getState().setEnvToolCheck(result)
+        void refreshEnvironments()
+      })
+      .catch(() => {
+        // the link dropped: asked again when it is back (serverOffline above)
+      })
     const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
     return () => {
       cancelled = true
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index aa11842..93a20d1 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -23,11 +23,12 @@ import { primaryWorktreeId } from '../../../shared/repositories.ts'
 import { hostKey } from '../../../shared/types.ts'
 import type { SessionTarget, WindowBackend } from '../backend'
 import type { TerminalMeta } from '../store'
-import type { MethodNameV2, MethodParamsV2, MethodResultsV2, TopicRev } from '../../../shared/protocolV2'
+import type { EventPayloadsV2, MethodNameV2, MethodParamsV2, MethodResultsV2, TopicRev } from '../../../shared/protocolV2'
 import type { RevResult } from '../../../shared/client/connection'
 import type { GitWorktreeInfo, ProjectFile, Repository } from '../../../shared/types'
 
-export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<MethodResultsV2[M]>
+/** `timeoutMs`: for the long ones (an environment's first boot, a compose run): the SDK's default is a minute */
+export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options?: { timeoutMs?: number }) => Promise<MethodResultsV2[M]>
 /** As V2Request, with the rev the response reports (none from a server older than revs). */
 export type V2RequestWithRev = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<RevResult<M>>
 
@@ -48,9 +49,8 @@ export interface ConfirmPrompt {
 }
 
 /**
- * A Local server window's teardown on this machine before a worktree is
- * removed (localTeardown.ts). Used only with
- * the features: `env` for the VM, `stacks` for the dev stack.
+ * The teardown on the server's machine before a worktree is removed (worktreeTeardown.ts). Used
+ * only with the features: `env` for the VM, `stacks` for the dev stack.
  */
 export interface WorktreeTeardown {
   /** The branch's Colima VM, if the environments poll lists one */
@@ -61,7 +61,7 @@ export interface WorktreeTeardown {
   destroyStack(info: GitWorktreeInfo, stackName: string): Promise<void>
   /** Deletes the VM; shows its own failure and never rejects */
   destroyEnvironment(info: GitWorktreeInfo): Promise<void>
-  /** A fresh `git status` of the worktree on this disk; the cached flag if it can't be read */
+  /** A fresh `git status` of the worktree on its server (`worktree.dirty`); the cached flag if it can't be read */
   isDirty(info: GitWorktreeInfo): Promise<boolean>
 }
 
@@ -81,6 +81,8 @@ export interface V2BackendDeps {
   capabilities(): readonly string[] | undefined
   /** The window's entry is the Local server's: with `local` in the welcome, its paths are this machine's (`v2Features`) */
   localEntry: boolean
+  /** The server's events of one name on the window's connection (`docker.log`, `env.log`); returns the unsubscribe */
+  onEvent<E extends keyof EventPayloadsV2>(event: E, listener: (payload: EventPayloadsV2[E]) => void): () => void
   /** The id map of the projection in the store now */
   ids(): V2IdMap | null
   state(): V2BackendState
@@ -103,7 +105,7 @@ export interface V2BackendDeps {
   registeredRepoPath(repoId: string): Promise<string | null>
   /** Why the repository can't be removed now, or null */
   removalBlock(repo: Repository): string | null
-  /** This machine's teardown for a removed worktree; only a Local window's features reach it */
+  /** The server machine's teardown for a removed worktree; only the `env` and `stacks` features reach it */
   teardown: WorktreeTeardown
   /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
   report(title: string, err: unknown): void
@@ -138,6 +140,13 @@ class TargetError extends Error {
 }
 
 const REMOVE_FAILED = 'Could not delete worktree'
+
+/** The machine methods that can run for minutes (a VM's first boot, an image build, a stack's database restore). */
+const LONG_MS = 30 * 60_000
+/** colima stop and delete, a stack's down and destroy (each Ctrl-C's a running up and waits up to a minute) */
+const SLOW_MS = 10 * 60_000
+/** docker start, stop and restart (the server gives docker two minutes) */
+const CONTAINER_MS = 3 * 60_000
 const NOT_REGISTERED = "Registered on the server but it isn't visible here yet — try again."
 
 export function createV2Backend(deps: V2BackendDeps): WindowBackend {
@@ -338,9 +347,10 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         return { path, worktreeId }
       },
       // The server's rules: a loaded worktree is IN_USE, so it is unloaded
-      // first, and loaded again when the removal doesn't go through. A Local
-      // window also tears down the worktree's dev stack (if ticked) and its VM
-      // on this machine, after the unload and before git's removal (4c).
+      // first, and loaded again when the removal doesn't go through. With the
+      // `stacks` and `env` features it also tears down the worktree's dev stack
+      // (if ticked) and its VM on the server's machine, after the unload and
+      // before git's removal (4c's order).
       remove: async (info, instance) => {
         const legacyId = instance?.id ?? legacyIdAt(info.path)
         const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
@@ -442,10 +452,43 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       pull: async (loc) => {
         await request('worktree.pull', { projectId, worktreeId: worktreeAt(loc.path) })
       },
-      // Legacy pushes with -u.
+      // Always with -u.
       push: async (loc) => {
         await request('worktree.push', { projectId, worktreeId: worktreeAt(loc.path), setUpstream: true })
-      }
+      },
+      dirty: async (loc) => request('worktree.dirty', { projectId, worktreeId: worktreeAt(loc.path) })
+    },
+    // Every path the server needs it finds itself, from the ids: a worktree by the store's path,
+    // a repository by its id. Nothing else of this machine's goes over.
+    docker: {
+      list: () => request('docker.list', {}),
+      container: async (action, id) => {
+        await request('docker.container', { action, id }, { timeoutMs: CONTAINER_MS })
+      },
+      compose: (repoId, action) => request('docker.compose', { projectId, repoId, action }, { timeoutMs: LONG_MS }),
+      onLog: (listener) => deps.onEvent('docker.log', listener)
+    },
+    env: {
+      check: () => request('env.check', {}),
+      list: (repoId) => request('env.list', { projectId, repoId }),
+      up: async (loc, settings, envVars) =>
+        request('env.up', { projectId, worktreeId: worktreeAt(loc.path), settings, ...(envVars ? { envVars } : {}) }, { timeoutMs: LONG_MS }),
+      stop: (profile) => request('env.stop', { profile }, { timeoutMs: SLOW_MS }),
+      destroy: (profile) => request('env.destroy', { profile }, { timeoutMs: SLOW_MS }),
+      ps: async (loc, composeFile) => request('env.ps', { projectId, worktreeId: worktreeAt(loc.path), ...(composeFile ? { composeFile } : {}) }),
+      composeFiles: async (loc) => request('env.composeFiles', { projectId, worktreeId: worktreeAt(loc.path) }),
+      logs: async (loc, composeFile, service, tail) =>
+        request('env.logs', { projectId, worktreeId: worktreeAt(loc.path), ...(composeFile ? { composeFile } : {}), service, tail }),
+      onLog: (listener) => deps.onEvent('env.log', listener)
+    },
+    stacks: {
+      status: async (loc) => request('stack.status', { projectId, worktreeId: worktreeAt(loc.path) }),
+      up: async (loc, starter) => {
+        await request('stack.up', { projectId, worktreeId: worktreeAt(loc.path), starter })
+      },
+      down: async (loc) => request('stack.down', { projectId, worktreeId: worktreeAt(loc.path) }, { timeoutMs: SLOW_MS }),
+      destroy: async (loc) => request('stack.destroy', { projectId, worktreeId: worktreeAt(loc.path) }, { timeoutMs: SLOW_MS }),
+      log: async (loc, fileId, offset) => request('stack.log', { projectId, worktreeId: worktreeAt(loc.path), fileId, offset })
     },
     branch: {
       setTag: async (repoId, branch, tagId) => {
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 9f7f21b..b3a9d44 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -7,7 +7,7 @@ import { useAppStore } from '../store'
 import { setProjectSetters } from '../projectSetters'
 import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
 import { removalBlock } from '../repoRemoval'
-import { localWorktreeTeardown } from '../localTeardown'
+import { worktreeTeardown } from '../worktreeTeardown'
 import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
 import { v2SetterOverrides } from './setterOverrides'
 import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
@@ -53,10 +53,10 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
   })
 
-  const request: V2Request = (method, params) => {
+  const request: V2Request = (method, params, options) => {
     const server = left ? undefined : registered()
     if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
-    return server.connection.request(method, params)
+    return server.connection.request(method, params, options)
   }
   const requestWithRev: V2RequestWithRev = (method, params) => {
     const server = left ? undefined : registered()
@@ -109,6 +109,14 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     requestWithRev,
     capabilities: () => registered()?.connection.welcome?.capabilities,
     localEntry: isLocalEntryId(entryId),
+    // The window's own connection: a reconnect keeps it, and so its listeners.
+    onEvent: (event, listener) => {
+      const server = left ? undefined : registered()
+      if (!server) return () => {}
+      return server.connection.on('event', (frame) => {
+        if (!left && frame.event === event) listener(frame.payload as Parameters<typeof listener>[0])
+      })
+    },
     ids: v2Ids,
     state: () => useAppStore.getState(),
     whenProjected,
@@ -120,7 +128,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     promptRepoPath: requestRepoPath,
     registeredRepoPath,
     removalBlock,
-    teardown: localWorktreeTeardown,
+    teardown: worktreeTeardown,
     report,
     reportEdit,
     left: () => left
diff --git a/src/renderer/src/windowKind.ts b/src/renderer/src/windowKind.ts
index 4c7bc44..323ec7f 100644
--- a/src/renderer/src/windowKind.ts
+++ b/src/renderer/src/windowKind.ts
@@ -1,6 +1,6 @@
 // Keeps this window's backend in step with what the window shows. Not in
 // store.ts: installV2.ts imports the store (directly and through terminals.ts,
-// localTeardown.ts and the rest), so the store importing it back would make a
+// worktreeTeardown.ts and the rest), so the store importing it back would make a
 // cycle in which those modules run before the store exists.
 import { useAppStore } from './store'
 import { idleBackend, setBackend, type WindowBackend } from './backend'
diff --git a/src/renderer/src/localTeardown.ts b/src/renderer/src/worktreeTeardown.ts
similarity index 73%
rename from src/renderer/src/localTeardown.ts
rename to src/renderer/src/worktreeTeardown.ts
index 564ab97..0287730 100644
--- a/src/renderer/src/localTeardown.ts
+++ b/src/renderer/src/worktreeTeardown.ts
@@ -1,13 +1,15 @@
-// A Local server window's worktree delete, on this machine (backendV2's `worktrees.remove` calls
-// it as `teardown`): the confirm (with the dev stack's checkbox), a fresh dirty check on this disk,
-// then the stack and the branch's Colima VM, before the server removes the worktree.
+// A worktree delete's teardown on the server's machine (backendV2's `worktrees.remove` calls it as
+// `teardown`, with the `stacks` and `env` features): the confirm (with the dev stack's checkbox),
+// a fresh dirty check through the server's git (`worktree.dirty`), then the stack and the branch's
+// Colima VM, before the server removes the worktree (4c's order).
 import { environmentFor, repoOfInfo, useAppStore } from './store'
 import { destroyEnvironmentIfAny } from './environmentActions'
+import { getBackend } from './backend'
 import { envRepoKey } from '../../shared/environments'
 import type { GitWorktreeInfo } from '../../shared/types'
 import type { WorktreeTeardown } from './v2/backendV2'
 
-/** The branch's live environment (environments run on this machine only). */
+/** The branch's live environment, from the environments poll. */
 function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
   const state = useAppStore.getState()
   if (!state.project) return undefined
@@ -31,7 +33,7 @@ async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
 async function teardownStack(info: GitWorktreeInfo, stackName: string): Promise<void> {
   let failure: string | undefined
   try {
-    const code = await window.api.stackDestroy(info.path)
+    const code = await getBackend().stacks.destroy({ path: info.path })
     if (code !== 0) failure = `stack.sh destroy exited with code ${code}.`
   } catch (err) {
     failure = String(err)
@@ -39,7 +41,7 @@ async function teardownStack(info: GitWorktreeInfo, stackName: string): Promise<
   if (failure) {
     await window.api.showError(
       'Dev stack cleanup failed',
-      `${failure}\n\nThe worktree is deleted anyway. Remove the leftover stack from any checkout with:\n` +
+      `${failure}\n\nThe worktree is deleted anyway. Remove the leftover stack from any checkout on the server's machine with:\n` +
         `TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy`
     )
   }
@@ -55,7 +57,9 @@ async function confirmRemoval(
   info: GitWorktreeInfo,
   prompt: ConfirmPrompt
 ): Promise<{ confirmed: boolean; stackName?: string }> {
-  const stack = await window.api.stackStatus(info.path).catch(() => null)
+  const stack = await getBackend()
+    .stacks.status({ path: info.path })
+    .catch(() => null)
   const stackName = stack?.available && stack.created ? stack.slug : undefined
   if (!stackName) return { confirmed: await window.api.confirm(prompt) }
   const result = await window.api.confirmWithCheckbox({
@@ -66,23 +70,21 @@ async function confirmRemoval(
   return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
 }
 
-/** The teardown for a Local server window's worktree delete (backendV2's `worktrees.remove`): its paths are this machine's. */
-export const localWorktreeTeardown: WorktreeTeardown = {
-  environment: environmentOf,
-  confirm: confirmRemoval,
-  destroyStack: teardownStack,
-  destroyEnvironment: teardownEnvironment,
-  // A Local server window's worktree is on this disk.
-  isDirty: worktreeIsDirty
-}
-
-/** Fresh dirty check for a worktree on this disk; falls back to the cached flag if the check fails. */
+/** Fresh dirty check through the server's git; falls back to the cached flag if the check fails. */
 async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
   try {
-    const dirty = await window.api.localWorktreeDirty(info.path)
+    const dirty = await getBackend().git.dirty({ path: info.path })
     if (dirty !== null) return dirty
   } catch {
-    // unreadable — use the cached flag
+    // unreadable, or a server without worktree.dirty: use the cached flag
   }
   return info.dirty ?? false
 }
+
+export const worktreeTeardown: WorktreeTeardown = {
+  environment: environmentOf,
+  confirm: confirmRemoval,
+  destroyStack: teardownStack,
+  destroyEnvironment: teardownEnvironment,
+  isDirty: worktreeIsDirty
+}
```


Run: `node --test scripts/backendFeatures.test.mjs scripts/v2Backend.test.mjs scripts/environmentStart.test.mjs scripts/serverMachine.test.mjs`

Expected: `# fail 0`.

- [ ] **Step 4: The smokes' expectations**

`smoke:v2`: a remote window's features now have docker, env and stacks (its Settings list Environments), its server gets stub `docker` and `colima`, and nothing runs them unasked. `smoke:local-features`: the comments say the server runs them now; its checks pass unchanged.

```diff
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index 5e98d10..67a7b36 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -1,12 +1,15 @@
-// scripts/local-features-smoke.mjs — the machine-local features in a Local server window (4c).
+// scripts/local-features-smoke.mjs — the features of a Local server window (4c): this machine's
+// (VS Code, Reveal, skills) and the server's machine's (docker, environments, stacks: 5a), which for
+// Local is this machine too.
 //
 // Run: npm run smoke:local-features   (builds the app with out/server, then runs this script)
 //
 // The built app is launched with a temp HOME (so its supervisor starts the run's own Local server,
 // in ~/.config/trek-server/local-dev) and a temp --user-data-dir. Stubs on PATH stand in for
 // colima, docker and code: each records how it was called, and colima lists a running VM for the
-// feature branch plus a crash leftover. The HOME's .zshrc puts them first, for main's fixPath and for
-// the server's agents. The project is made on the Local server through the SDK: a repository with a
+// feature branch plus a crash leftover. The HOME's .zshrc puts them first, for main's fixPath (the
+// Local server it spawns inherits that PATH, and runs docker and colima since 5a) and for the
+// server's agents. The project is made on the Local server through the SDK: a repository with a
 // docker/stack/stack.sh stub and a project skill, and a worktree on feature-x. Then the window opens
 // it, and through the DOM it checks:
 //   - main's row: Open in VS Code and Reveal call main with the repository's path; the Docker tab
@@ -17,10 +20,11 @@
 //     env chip; VS Code with the worktree's path; the Env panel's VM; its variables, saved on blur;
 //   - a session's skill menu lists the worktree's skill and types it into the server's pty;
 //   - Delete worktree asks with the stack checkbox and the VM named, and (a file written as the
-//     confirm shows) about its uncommitted changes, from a fresh git status here, before it runs
+//     confirm shows) about its uncommitted changes, from a fresh git status (worktree.dirty), before it runs
 //     `stack.sh destroy` and `colima delete <profile> --force`; then the server removes the worktree;
 //   - no console or page errors.
-// The same window on a remote server (no `local`) is smoke:v2's: no machine-local controls, Linear on.
+// The same window on a remote server (no `local`) is smoke:v2's (none of this machine's controls,
+// Linear on) and smoke:server-env's (docker, environments and stacks on the server's machine).
 //
 // Prints LOCAL FEATURES SMOKE PASS (n checks) or LOCAL FEATURES SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
@@ -137,7 +141,7 @@ writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { p
 // detail, its checkbox and a number from the stubs' shared sequence (for the order against
 // stack.sh and colima), and answered with its confirm button (index 1) and the box ticked.
 // The delete's confirm writes an untracked file into the worktree as it is shown: the renderer
-// read the status poll's "clean" before asking, so only main's fresh git:localDirty can see it.
+// read the status poll's "clean" before asking, so only the server's fresh worktree.dirty can see it.
 const mainStub = join(work, 'main-stub.cjs')
 const dirtyOnConfirm = join(worktree, 'scratch.txt')
 writeFileSync(
@@ -381,7 +385,7 @@ try {
   const stackAt = seqOf('stack', (c) => c.endsWith('|destroy'))
   const colimaAt = seqOf('colima', (c) => c.startsWith('delete'))
   check('in order: the stack, then the VM (seq)', stackAt !== null && colimaAt !== null && stackAt < colimaAt, true)
-  // A broken git:localDirty falls back to "clean": the stack and the VM go, and git's own refusal
+  // A broken worktree.dirty falls back to "clean": the stack and the VM go, and git's own refusal
   // asks the same question afterwards. Only the order tells the two apart.
   check(
     'a fresh dirty check asks before the stack and the VM go (seq)',
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 3055c67..6e92160 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -66,7 +66,7 @@
 // Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
 import { spawn, execFileSync } from 'node:child_process'
-import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { createServer } from 'node:net'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
@@ -129,6 +129,12 @@ const notRepo = join(repos, 'plain')
 gitRepo(repoA)
 gitRepo(repoB)
 mkdirSync(notRepo)
+// docker and colima stubs, first on the server's PATH: since 5a the server runs them for its windows,
+// and this run must never reach a real one. Each records its call; nothing here should make one.
+const machineStubs = join(work, 'machine-stubs')
+mkdirSync(machineStubs)
+const machineCalls = join(work, 'machine-calls')
+for (const tool of ['docker', 'colima']) writeFileSync(join(machineStubs, tool), `#!/bin/sh\necho "${tool} $*" >> '${machineCalls}'\nexit 0\n`, { mode: 0o755 })
 // A fake agent: prints its args, then echoes each line typed into it as GOT:<line>; "quit" exits 3.
 const fakeAgent = join(work, 'fake-agent.sh')
 writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nwhile IFS= read -r line; do\n  [ "$line" = quit ] && exit 3\n  echo "GOT:$line"\ndone\n', { mode: 0o755 })
@@ -154,6 +160,7 @@ const startDaemon = () =>
   new Promise((resolve, reject) => {
     const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', join(work, 'data')], {
       cwd: new URL('../server/', import.meta.url).pathname,
+      env: { ...process.env, PATH: `${machineStubs}:${process.env.PATH}` },
       stdio: ['ignore', 'pipe', 'pipe']
     })
     daemon = d
@@ -786,17 +793,19 @@ try {
   await detail.locator('.terminal-pane:visible .queue-close').click()
 
   // A server that is not the Local entry's (this one's paths happen to be on this disk, but the
-  // window cannot know that): none of this machine's controls (4c). Its tabs have no Docker, Env
-  // or Stack, its header no Open in VS Code or Reveal, its sessions no skill menu.
-  check('a remote server window has no machine-local controls', await detail.evaluate((el) => ({
+  // window cannot know that): none of this machine's controls (4c). Its header has no Open in VS
+  // Code or Reveal, its sessions no skill menu. Docker, the environments and the stacks are the
+  // server's (5a), on: this worktree shows no Env or Stack tab only because its repository has
+  // environments off and no stack.sh, and Docker is the main checkout's tab (smoke:server-env).
+  check("a remote server window has none of this machine's controls", await detail.evaluate((el) => ({
     actions: [...el.querySelectorAll('.detail-actions button')].map((b) => b.textContent.trim()).filter((t) => /VS Code|Reveal/.test(t)),
     tabs: [...el.querySelectorAll('.session-row .panel-btn')].map((b) => b.textContent.trim()).filter((t) => /^(Docker|Env|Stack)/.test(t)),
     skills: el.querySelectorAll('.skill-menu-trigger').length
   })), { actions: [], tabs: [], skills: 0 })
-  check('and its features say so; Linear is on', await w1.evaluate(() => {
+  check("and its features say so; the server machine's docker, env and stacks, and Linear, are on", await w1.evaluate(() => {
     const f = window.__features()
     return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear]
-  }), [false, false, false, false, false, false, true])
+  }), [true, true, true, false, false, false, true])
 
   // A rename sends the title it started from, so one made elsewhere meanwhile is not overwritten.
   const oldTitle = await w1.evaluate((id) => window.__store.getState().terminals[id].title, s1)
@@ -890,6 +899,7 @@ try {
   await detail.locator('.panel-btn[title="App settings"]').click()
   const settings = w1.locator('.server-window .settings-panel')
   await settings.waitFor({ timeout: 5000 })
+  // Environments too since 5a: the server runs them on its own machine.
   check("a server window's Settings show the project's sections only", await settings.locator('h3').allTextContents(), [
     'Settings',
     'Appearance',
@@ -903,7 +913,8 @@ try {
     'Session system prompt',
     'Global system prompt',
     'Global quick buttons',
-    'Session types'
+    'Session types',
+    'Environments'
   ])
   check("and say the agents' commands are the server's", (await settings.textContent()).includes("set in the server's config"), true)
   // The app-wide "Show notifications" switch, the one machine setting a server window shows: on by
@@ -1302,6 +1313,7 @@ try {
 
   // ---- 9. No console errors in any window -------------------------------------------
   check('no console or page errors in any window', pageErrors, [])
+  check("nothing ran docker or colima on the server's machine unasked", existsSync(machineCalls) ? readFileSync(machineCalls, 'utf8').split('\n').filter(Boolean) : [], [])
   exitCode = checks.every(Boolean) ? 0 : 1
   await finish()
 } catch (err) {
```


- [ ] **Step 5: Nothing reaches main's old handlers**

Run: `git grep -nE "registerDockerHandlers|registerEnvironmentHandlers|registerStackHandlers|git:localDirty|localWorktreeDirty|localTeardown|'(docker|env|stack):[a-zA-Z]+'|window\.api\.(env[A-Z]|stack[A-Z]|listContainers|containerAction|compose\(|onDockerLog|onEnvLog)" -- src ':!src/main/bot.ts' ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected: no output.

- [ ] **Step 6: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1614`, `# pass 1613`, `# fail 0`, `# skipped 1`.

Run, one at a time: `node scripts/local-features-smoke.mjs`, `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`, `node scripts/local-window-smoke.mjs`

Expected: `LOCAL FEATURES SMOKE PASS (36 checks)` (the Local window's Docker, environments, stacks and delete teardown, now through its server), `V2 SMOKE PASS (171 checks)`, `LOCAL WINDOW SMOKE PASS (57 checks)`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/worktreeTeardown.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5a-2): every server window runs docker, environments and stacks on its server's machine (gated on the capabilities); main's docker.ts, environments.ts, stacks.ts and git:localDirty deleted" -m "Co-Authored-By: <model trailer>" -- src scripts server
```

---

### Task 4: `smoke:server-env`, and the upgrade in `smoke:local-features`

**Files:**
- Create: `scripts/server-env-smoke.mjs`
- Modify: `package.json` (`smoke:server-env`), `scripts/local-features-smoke.mjs`

- [ ] **Step 1: The smokes**

```diff
diff --git a/package.json b/package.json
index cc4de25..df90762 100644
--- a/package.json
+++ b/package.json
@@ -22,6 +22,7 @@
     "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
     "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
     "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
+    "smoke:server-env": "npm run build && node scripts/server-env-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index 67a7b36..d27db0a 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -22,19 +22,23 @@
 //   - Delete worktree asks with the stack checkbox and the VM named, and (a file written as the
 //     confirm shows) about its uncommitted changes, from a fresh git status (worktree.dirty), before it runs
 //     `stack.sh destroy` and `colima delete <profile> --force`; then the server removes the worktree;
+//   - the upgrade (5a): the app's environments registry and its running stack's pid and log, as a
+//     pre-5a Trek left them in userData, are the Local server's now: the VM it knew is no orphan,
+//     the stack's `up` still counts as running and its log shows, and the delete stops it first;
 //   - no console or page errors.
 // The same window on a remote server (no `local`) is smoke:v2's (none of this machine's controls,
 // Linear on) and smoke:server-env's (docker, environments and stacks on the server's machine).
 //
 // Prints LOCAL FEATURES SMOKE PASS (n checks) or LOCAL FEATURES SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
-import { execFileSync, spawnSync } from 'node:child_process'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import electronPath from 'electron'
 import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
 import { parseLocalInfo } from '../src/shared/localServer.ts'
+import { defaultDataDir } from '../server/src/dataDir.ts'
 import { deriveProfileName } from '../src/shared/environments.ts'
 
 const WATCHDOG_MS = 180_000
@@ -137,6 +141,19 @@ const agentPids = join(work, 'agent-pids')
 writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT ready"\nexec sleep 300\n`, { mode: 0o755 })
 writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
 
+// The upgrade: what a pre-5a Trek left in userData. Its registry knew the feature branch's VM, and
+// its stack's `stack.sh up` is still running (a sleep in its own process group, as `up` ran
+// detached), with its pid and log in userData/stacks.
+const legacyRegistry = { [featureProfile]: { repoPath: repo, branch: 'feature-x', worktreePath: worktree, composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z' } }
+mkdirSync(join(userData, 'stacks'), { recursive: true })
+writeFileSync(join(userData, 'environments.json'), JSON.stringify(legacyRegistry, null, 2))
+const legacyUp = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' })
+legacyUp.unref()
+writeFileSync(join(userData, 'stacks', 'app-feature-x.pid'), String(legacyUp.pid))
+writeFileSync(join(userData, 'stacks', 'app-feature-x.log'), '$ stack.sh up\nstarted by the app before 5a\n')
+// The Local profile's data dir, where the server keeps them from now on (server/src/dataDir.ts).
+const localData = join(defaultDataDir(process.platform, { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }, home), 'local-dev')
+
 // Main's dialogs and Reveal, stubbed before its script runs: every message box is recorded with its
 // detail, its checkbox and a number from the stubs' shared sequence (for the order against
 // stack.sh and colima), and answered with its confirm button (index 1) and the box ticked.
@@ -220,7 +237,7 @@ const finish = async (reason) => {
   })
   const left = info()
   if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
-  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
+  for (const pid of [legacyUp.pid, ...(existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : [])]) {
     if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
       try {
         process.kill(pid, 'SIGKILL')
@@ -262,7 +279,12 @@ try {
   sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'local-features-smoke' })
   sdk.connect()
   await until(() => sdk.status, 'connected', 5000)
-  check('the Local server says `local`', sdk.welcome?.capabilities.includes('local'), true)
+  check('the Local server says `local`, and runs docker, env and stacks', ['local', 'docker', 'env', 'stacks'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, true])
+  // The upgrade: the server took the app's files over before it served anything; the app's stay.
+  const seeded = existsSync(join(localData, 'environments.json')) ? JSON.parse(readFileSync(join(localData, 'environments.json'), 'utf8')) : null
+  check("the Local server took over the app's environments registry", seeded, legacyRegistry)
+  check("and its running stack's pid", existsSync(join(localData, 'stacks', 'app-feature-x.pid')) ? readFileSync(join(localData, 'stacks', 'app-feature-x.pid'), 'utf8') : null, String(legacyUp.pid))
+  check("the app's own files are left as they were", JSON.parse(readFileSync(join(userData, 'environments.json'), 'utf8')), legacyRegistry)
   await sdk.request('server.addRepo', { path: repo })
   const { projectId } = await sdk.request('project.create', { name: 'features', repositories: [{ path: repo }] })
   const topic = `project:${projectId}`
@@ -319,7 +341,8 @@ try {
   check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
   check('the environments poll runs: the tool check passes', await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
   check('and colima list fills the environments', await until(() => win.evaluate(() => Object.keys(window.__store.getState().environments).sort()), [featureProfile, 'twb-leftover-000000'].sort()), [featureProfile, 'twb-leftover-000000'].sort())
-  check('a VM with no worktree is an orphan in Settings', await until(() => settings.locator('.env-orphan-row').count(), 2), 2)
+  // The VM the app's registry knew is the server's now: only the crash leftover is an orphan.
+  check('only the VM no registry knows is an orphan in Settings', await until(() => settings.locator('.env-orphan-row').allTextContents(), ['twb-leftover-000000Delete']), ['twb-leftover-000000Delete'])
   await detail.locator('.panel-btn[title="App settings"]').click()
 
   // ---- 4. The feature row ---------------------------------------------------------------------------
@@ -346,6 +369,8 @@ try {
 
   await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
   check("the Stack panel reads the worktree's stack", await until(() => detail.locator('.env-panel:visible', { hasText: 'trek-app-feature-x' }).count(), 1), 1)
+  // The app's `up`, by the pid file the server took over: still starting, with its log.
+  check("the app's running up counts, and its log shows", [await until(() => detail.locator('.env-panel:visible .docker-meta').first().innerText(), 'Starting…'), await until(() => detail.locator('.env-panel:visible .docker-log').innerText().then((t) => t.includes('started by the app before 5a'), () => false), true)], ['Starting…', true])
 
   // ---- 5. A skill, typed into the server's pty ------------------------------------------------------
 
@@ -393,6 +418,7 @@ try {
     [true, true, true]
   )
   check("then the server's removal: the worktree was still there when the VM went", existsSync(calls('delete-saw-worktree')), true)
+  check("the destroy stopped the app's running up first", alive(legacyUp.pid), false)
   const errorBoxes = (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error')
   check('no error dialogs', errorBoxes, [])
 
diff --git a/scripts/server-env-smoke.mjs b/scripts/server-env-smoke.mjs
new file mode 100644
index 0000000..60b9adb
--- /dev/null
+++ b/scripts/server-env-smoke.mjs
@@ -0,0 +1,358 @@
+// scripts/server-env-smoke.mjs — docker, the environments and the dev stacks in a remote server's
+// window (phase 5a): they run on the server's machine, through the server.
+//
+// Run: npm run smoke:server-env   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) runs with its own HOME and stub docker, colima and
+// stack.sh first on its PATH: each records its call, its working directory and the FOO variable,
+// with a sequence number shared by every stub (for the order). Nothing here reaches a real docker
+// or colima. The built app runs with a temp HOME and --user-data-dir, no Local server, and main's
+// dialogs stubbed through -r; the server is added as an app server, and the window opens a project
+// made through the SDK (a repository with a compose file and a stack.sh, a worktree on feature-x).
+// Through the DOM it checks:
+//   - the window's features: docker, env and stacks on; this machine's (skills, Reveal, VS Code) off;
+//   - the main checkout's Docker tab lists the server's containers, restarts one, and its compose
+//     menu runs `docker compose up -d` in the repository on the server, the output streamed back;
+//     a docker that fails shows in the panel, and the panel recovers;
+//   - Settings' environments switch is saved on the server; the poll's tool check passes there;
+//   - the feature row's Env panel: the variables saved on blur, Start runs colima and compose on the
+//     server with them, the steps arrive, the server's registry names the VM;
+//   - its Stack tab starts and stops the worktree's stack.sh on the server;
+//   - Delete worktree asks with the stack checkbox and the VM named, asks about the changes a fresh
+//     worktree.dirty finds, then the stack and the VM go before the server removes the worktree;
+//   - the renderer never holds the token; no console or page errors.
+//
+// Prints SERVER ENV SMOKE PASS (n checks) or SERVER ENV SMOKE FAIL and exits 0 or 1.
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
+import { deriveProfileName } from '../src/shared/environments.ts'
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
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-env-smoke-')))
+// The server's machine: its HOME holds the repositories (Colima mounts only $HOME) and the stacks' registry.
+const serverHome = join(work, 'server-home')
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
+
+// Each stub call line: "<n>#<tool>|<cwd>|<args>|FOO=<FOO>", n from a sequence shared by every stub.
+const callsFile = join(work, 'calls')
+const seqFile = join(work, 'seq')
+const seqLock = join(work, 'seq.lock')
+const NEXT_SEQ = `next_seq() { while ! mkdir '${seqLock}' 2>/dev/null; do sleep 0.01; done; n=$(( $(cat '${seqFile}' 2>/dev/null || echo 0) + 1 )); echo $n > '${seqFile}'; rmdir '${seqLock}'; echo $n; }`
+const record = (tool) => `echo "$(next_seq)#${tool}|$PWD|$*|FOO=$FOO" >> '${callsFile}'`
+const lines = () =>
+  (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : []).map((line) => {
+    const at = line.indexOf('#')
+    return { seq: Number(line.slice(0, at)), call: line.slice(at + 1) }
+  })
+const callsOf = (tool) => lines().filter(({ call }) => call.startsWith(`${tool}|`)).map(({ call }) => call.slice(tool.length + 1))
+const seqOf = (tool, match) => lines().find(({ call }) => call.startsWith(`${tool}|`) && match(call.slice(tool.length + 1)))?.seq ?? null
+
+const repo = join(serverHome, 'repos', 'app')
+const worktree = `${repo}-feature-x`
+const featureProfile = deriveProfileName(repo, 'feature-x')
+const vmUp = join(work, 'vm-up')
+const dockerDown = join(work, 'docker-down')
+const stubs = join(work, 'stubs')
+mkdirSync(stubs)
+const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/bash\n${NEXT_SEQ}\n${body}\n`, { mode: 0o755 })
+stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
+${record('docker')}
+if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
+  if [ -f '${dockerDown}' ]; then echo "Cannot connect to the Docker daemon (stub)" >&2; exit 1; fi
+  echo '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 1 minute","Ports":"80/tcp"}'
+fi
+case " $* " in *" compose "*" ps "*) echo "[]" ;; esac
+exit 0`)
+stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
+${record('colima')}
+case "$1" in
+  start) touch '${vmUp}' ;;
+  delete) rm -f '${vmUp}'; [ -d '${worktree}' ] && echo yes > '${work}/delete-saw-worktree' ;;
+  list) [ -f '${vmUp}' ] && echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.9' })}' ;;
+esac
+exit 0`)
+
+const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
+git('init', '-q', '-b', 'main', repo)
+mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
+// `up` stays attached while its stack runs, as the real one does; down and destroy just record.
+writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\n${NEXT_SEQ}\n${record('stack')}\nif [ "$1" = up ]; then exec sleep 60; fi\n`, { mode: 0o755 })
+writeFileSync(join(repo, 'docker-compose.yml'), 'services: {}\n')
+writeFileSync(join(repo, '.gitignore'), '.trek/\n')
+git('-C', repo, 'add', '.')
+git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init')
+const configPath = join(work, 'config.json')
+writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }] }))
+
+// Main's dialogs, stubbed before its script runs: each box is recorded with its detail, its checkbox
+// and a number from the stubs' sequence, and answered with its confirm button and the box ticked.
+// The delete's confirm writes an untracked file into the worktree as it is shown: only the server's
+// fresh worktree.dirty can see it.
+const mainStub = join(work, 'main-stub.cjs')
+const dirtyOnConfirm = join(worktree, 'scratch.txt')
+writeFileSync(
+  mainStub,
+  `const { dialog } = require('electron')
+const fs = require('node:fs')
+globalThis.__dialogs = []
+const pause = new Int32Array(new SharedArrayBuffer(4))
+const nextSeq = () => {
+  for (;;) {
+    try {
+      fs.mkdirSync(${JSON.stringify(seqLock)})
+      break
+    } catch {
+      Atomics.wait(pause, 0, 0, 10)
+    }
+  }
+  let n = 0
+  try {
+    n = Number(fs.readFileSync(${JSON.stringify(seqFile)}, 'utf8')) || 0
+  } catch {}
+  fs.writeFileSync(${JSON.stringify(seqFile)}, String(n + 1) + '\\n')
+  fs.rmdirSync(${JSON.stringify(seqLock)})
+  return n + 1
+}
+const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
+dialog.showMessageBox = async (...args) => {
+  const o = opts(args)
+  if (o.message === 'Delete worktree “feature-x”?') fs.writeFileSync(${JSON.stringify(dirtyOnConfirm)}, 'unsaved\\n')
+  globalThis.__dialogs.push({ seq: nextSeq(), type: o.type ?? null, message: o.message, detail: o.detail ?? null, checkbox: o.checkboxLabel ?? null })
+  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: true }
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
+  if (app) await app.close().catch(() => {})
+  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
+    daemon.kill()
+    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
+  }
+  // A stack's `up` the run left behind (its sleep): only this run's, by its worktree in the command line.
+  spawnSync('pkill', ['-f', `${repo}.*docker/stack/stack.sh`])
+  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(exitCode === 0 ? `SERVER ENV SMOKE PASS (${checks.length} checks)` : `SERVER ENV SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+try {
+  // ---- 1. The server, on its own machine (its HOME and PATH), and a project on it --------------------
+
+  const port = await freePort()
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
+      cwd: join(root, 'server'),
+      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), PATH: `${stubs}:${process.env.PATH}` },
+      stdio: ['ignore', 'pipe', 'pipe']
+    })
+    daemon = d
+    let output = ''
+    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
+    const onData = (b) => {
+      output += b
+      if (/listening on ws:\/\//.test(output)) {
+        clearTimeout(timer)
+        resolve()
+      }
+    }
+    d.stdout.on('data', onData)
+    d.stderr.on('data', (b) => {
+      output += b
+      process.stderr.write(b)
+    })
+    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
+  })
+  const url = `ws://127.0.0.1:${port}`
+  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-env-smoke' })
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  check('the server says docker, env and stacks, and is not a local one', ['docker', 'env', 'stacks', 'local'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, false])
+  const { projectId } = await sdk.request('project.create', { name: 'envs', repositories: [{ path: repo }] })
+  const topic = `project:${projectId}`
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic })
+    await sdk.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const repoId = (await project()).repositories[0].id
+  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
+  // The stack has run once: its state dir makes `created` true, so Delete offers to destroy it.
+  mkdirSync(join(worktree, '.trek', 'stack'), { recursive: true })
+
+  // ---- 2. The app, with the server saved, and the project's window -----------------------------------
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
+    const { opened } = await window.api.openServerProject(id, pid, 'envs', 'Remote')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
+  }, [entry.id, projectId])
+  const rows = win.locator('.server-window .wt-row')
+  await until(() => rows.count(), 2)
+  check("the window's features: the server machine's on, this machine's off", await until(() => win.evaluate(() => {
+    const f = window.__features()
+    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor]
+  }), [true, true, true, false, false, false]), [true, true, true, false, false, false])
+
+  // ---- 3. The main checkout: Docker on the server -----------------------------------------------------
+
+  const detail = win.locator('.server-window .detail')
+  const mainRow = rows.filter({ hasNotText: 'feature-x' })
+  await mainRow.click()
+  await detail.locator('.detail-path', { hasText: repo }).waitFor({ timeout: 10_000 })
+  const tabs = () => detail.locator('.session-row .panel-btn').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
+  check("main's tabs: Docker and Stack (the server's), and no Open in VS Code or Reveal", [await until(() => tabs(), ['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙']), await detail.locator('.detail-actions button', { hasText: /VS Code|Reveal/ }).count()], [['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙'], 0])
+  await detail.locator('.panel-btn', { hasText: 'Docker' }).click()
+  const dockerPanel = detail.locator('.docker-panel')
+  check("the Docker panel lists the server's containers", await until(() => dockerPanel.locator('.docker-row .docker-name').allTextContents(), ['web']), ['web'])
+  await dockerPanel.locator('.docker-row', { hasText: 'web' }).locator('button', { hasText: 'Restart' }).click()
+  check('Restart runs docker restart on the server', await until(() => callsOf('docker').filter((c) => c.includes('|restart ')).map((c) => c.split('|')[1]), ['restart c1']), ['restart c1'])
+  await detail.locator('.docker-menu-trigger').click()
+  await win.locator('.docker-menu .skill-menu-item', { hasText: 'compose up -d' }).first().click()
+  check("the compose menu runs docker compose in the repository, on the server", await until(() => callsOf('docker').filter((c) => c.includes('|compose ')), [`${repo}|compose up -d|FOO=`]), [`${repo}|compose up -d|FOO=`])
+  check("and its output streams back to the panel (docker.log)", await until(async () => (await dockerPanel.locator('.docker-log').textContent().catch(() => '')).includes('[docker compose exited with code 0]'), true), true)
+  writeFileSync(dockerDown, '')
+  check("a docker that fails on the server shows in the panel", await until(() => dockerPanel.locator('.error').count(), 1), 1)
+  rmSync(dockerDown)
+  check('and the panel recovers once it answers again', await until(() => dockerPanel.locator('.error').count(), 0), 0)
+
+  // ---- 4. Settings: the environments, saved on the server; the poll runs there -------------------------
+
+  await detail.locator('.panel-btn[title="App settings"]').click()
+  const settings = win.locator('.server-window .settings-panel')
+  await settings.waitFor({ timeout: 5000 })
+  await settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input').click()
+  check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
+  check("the poll's tool check passes on the server's machine", await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
+  await detail.locator('.panel-btn[title="App settings"]').click()
+
+  // ---- 5. The feature row: its environment, on the server ----------------------------------------------
+
+  const featureRow = rows.filter({ hasText: 'feature-x' })
+  await featureRow.click()
+  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
+  check('its tabs: Env and Stack', await until(() => tabs(), ['Changes', 'Notes', 'Env', 'Stack', '⚙']), ['Changes', 'Notes', 'Env', 'Stack', '⚙'])
+  await detail.locator('.panel-btn', { hasText: 'Env' }).click()
+  const envPanel = detail.locator('.env-panel:visible')
+  await envPanel.waitFor({ timeout: 5000 })
+  await envPanel.locator('.env-vars-toggle').click()
+  await envPanel.locator('.env-vars-editor').fill('FOO=bar')
+  await envPanel.locator('.env-vars-toggle').click()
+  check('the variables are saved on the server on blur', await until(async () => ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, 'FOO=bar'), 'FOO=bar')
+  await envPanel.locator('button', { hasText: /^Start$/ }).click()
+  check('Start reaches every step (env.log from the server)', await until(() => envPanel.locator('.env-steps .move-step.done').count(), 3, 30_000), 3)
+  check('colima started the branch\'s VM on the server', callsOf('colima').filter((c) => c.includes('|start ')).map((c) => c.split('|')[1]), [`start ${featureProfile} --cpu 2 --memory 4 --disk 20 --network-address`])
+  check('and compose ran in the worktree with the variables', callsOf('docker').filter((c) => c.includes(' compose -f ') && c.includes(' up -d')), [`${worktree}|--context colima-${featureProfile} compose -f docker-compose.yml up -d|FOO=bar`])
+  const registry = JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))
+  check("the server's registry names the VM, in its data dir", [Object.keys(registry), registry[featureProfile]?.worktreePath], [[featureProfile], worktree])
+  check('the row gets a running env badge', await until(() => featureRow.locator('.mini-chip.env.running').count(), 1), 1)
+
+  // ---- 6. Its stack, on the server ---------------------------------------------------------------------
+
+  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
+  const stackPanel = detail.locator('.env-panel:visible', { hasText: 'trek-app-feature-x' })
+  await stackPanel.waitFor({ timeout: 10_000 })
+  await stackPanel.locator('button', { hasText: /^Start$/ }).click()
+  check("Start runs the worktree's stack.sh up on the server", await until(() => callsOf('stack').map((c) => c.split('|').slice(0, 2).join('|')), [`${worktree}|up`]), [`${worktree}|up`])
+  await stackPanel.locator('button', { hasText: /^Stop$/ }).click({ timeout: 10_000 })
+  check('Stop runs stack.sh down after it', await until(() => callsOf('stack').map((c) => c.split('|')[1]), ['up', 'down']), ['up', 'down'])
+
+  // ---- 7. Delete the worktree: the stack and the VM go first, on the server -----------------------------
+
+  await detail.locator('.detail-actions .btn-icon').click()
+  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
+  check('the worktree is removed on the server', await until(async () => (await project()).repositories[0].worktrees.length, 1, 30_000), 1)
+  const dialogs = await app.evaluate(() => globalThis.__dialogs)
+  const asked = dialogs.find((d) => d.message === 'Delete worktree “feature-x”?')
+  const discard = dialogs.find((d) => d.message === '“feature-x” has uncommitted changes.')
+  check('the confirm names the VM and offers the stack', [asked?.detail?.includes(`Colima VM “${featureProfile}”`) ?? false, asked?.checkbox?.startsWith('Also destroy its dev stack') ?? false], [true, true])
+  const stackAt = seqOf('stack', (c) => c.split('|')[1] === 'destroy')
+  const colimaAt = seqOf('colima', (c) => c.includes('|delete '))
+  check('stack.sh destroy, then colima delete, on the server', [stackAt !== null, colimaAt !== null, stackAt !== null && colimaAt !== null && stackAt < colimaAt], [true, true, true])
+  check("a fresh worktree.dirty asked about the changes before either", discard !== undefined && stackAt !== null && discard.seq < stackAt, true)
+  check("then the server's removal: the worktree was still there when the VM went", existsSync(join(work, 'delete-saw-worktree')), true)
+  check('no error dialogs', dialogs.filter((d) => d.type === 'error'), [])
+
+  check('the renderer never holds the token', await win.evaluate((t) => JSON.stringify(window.__store.getState()).includes(t) || document.documentElement.outerHTML.includes(t), token), false)
+  check('no console or page errors', pageErrors, [])
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
```


- [ ] **Step 2: Run them**

Run, one at a time: `node scripts/server-env-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `SERVER ENV SMOKE PASS (29 checks)`, `LOCAL FEATURES SMOKE PASS (41 checks)`; then `pgrep -fl trek-server`, `pgrep -fl "sleep (60|120)"`: nothing (each smoke stops its server and the `up` it left).

The checks fail without the code they cover, which the prototype ran: with `env.up`'s variables dropped on the server, `FAIL and compose ran in the worktree with the variables: [".../app-feature-x|--context colima-twb-feature-x-<hash> compose -f docker-compose.yml up -d|FOO="]`; with main not passing `--import-env-from`, five fail: `the Local server took over the app's environments registry: null`, `and its running stack's pid: null`, `only the VM no registry knows is an orphan in Settings: ["twb-feature-x-<hash>Delete","twb-leftover-000000Delete"]`, `the app's running up counts, and its log shows: ["Stopped",false]`, `the destroy stopped the app's running up first: true`.

- [ ] **Step 3: Commit**

```bash
git add scripts/server-env-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(5a-2): smoke:server-env, a remote server window's docker, environments and stacks on the server's machine; smoke:local-features covers the upgrade (the app's registry, a running stack's pid and log)" -m "Co-Authored-By: <model trailer>" -- scripts package.json
```

---

### Task 5: Docs

**Files:**
- Modify: `PROTOCOL.md` (the section "Docker, environments and stacks", the capabilities, `TOOL_ERROR`, the commands and events), `README.md` (what server windows run on the server's machine; Local's take-over; `smoke:server-env`), `server/README.md` (requirements, the data dir's files, `--import-env-from`, the security note), the spec

- [ ] **Step 1: The edits**

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index e274fef..c70a72d 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -58,9 +58,11 @@ Responses correlate by `id`:
 
 Error codes: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PATH_DENIED`, `GIT_ERROR`,
 `PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`, `CONFLICT`, `NOT_A_REPO`, `IN_USE`,
-`CAPACITY` and `CONGESTED`. `CAPACITY` means a server or project limit was reached
+`CAPACITY`, `CONGESTED` and `TOOL_ERROR`. `CAPACITY` means a server or project limit was reached
 (`maxSessions`, the session records of a project, or the waits of an MCP tool); it is
-retryable once something frees up. An unknown method is `NOT_FOUND`.
+retryable once something frees up. `TOOL_ERROR` means a docker, colima or stack.sh command on
+the server's machine failed (see [Docker, environments and stacks](#docker-environments-and-stacks)).
+An unknown method is `NOT_FOUND`.
 
 Every path is realpath-resolved and must fall under a configured repo root or
 worktree root; anything else is rejected with `PATH_DENIED`.
@@ -94,6 +96,9 @@ new optional field needs no capability: its absence says enough.
 | `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
 | `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
 | `agents` | `server.agents` lists the agents the server can launch (see Sessions) |
+| `docker` | `docker.list`, `docker.container` and `docker.compose` run docker on the server's machine, and `docker.log` streams compose's output (see [Docker, environments and stacks](#docker-environments-and-stacks)) |
+| `env` | `env.*` run the worktrees' Colima environments on the server's machine, and `env.log` streams their output |
+| `stacks` | `stack.*` run the worktrees' `docker/stack/stack.sh` dev stacks on the server's machine |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -162,12 +167,15 @@ server restarts. A server without this field simply leaves it out.
 |---|---|
 | Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
 | Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
-| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
+| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff`, `worktree.dirty` |
 | Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
 | Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
 | Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
 | Agents | `server.agents` |
+| Docker | `docker.list`, `docker.container`, `docker.compose` |
+| Environments | `env.check`, `env.list`, `env.up`, `env.stop`, `env.destroy`, `env.ps`, `env.composeFiles`, `env.logs` |
+| Stacks | `stack.status`, `stack.up`, `stack.down`, `stack.destroy`, `stack.log` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
 | Misc | `sys.ping` |
 
@@ -177,8 +185,8 @@ results carry only new ids; queries return their data.
 
 An error reply may carry `error.details`, an object a client can act on without
 reading the message (which may be git's own, localised text). Today the only key
-is `reason`, and the only reason is `dirty` (see `worktree.remove`). Clients
-ignore keys and reasons they don't know.
+is `reason`: `dirty` (see `worktree.remove`), or `missing` on a `TOOL_ERROR` (the
+tool is not installed on the server). Clients ignore keys and reasons they don't know.
 
 `project.rename`, `project.updateSettings`, `branch.setNote`, `branch.setEnv`,
 `session.rename`, `session.dequeue` and `repo.update` take an optional `expected`: the value the client believes the
@@ -274,10 +282,10 @@ refresh the worktree's status before answering. `worktree.changes` and
 `worktree.diff` return the worktree's changes against its base branch (files with
 their added and removed line counts) and each file's unified diff. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
 a worktree whose path is outside the allowlist (a row from a hand-edited
-project file, say) fail with `PATH_DENIED` before running git. They refuse a
-non-main worktree whose path is, or contains, a registered repository
-(`BAD_REQUEST`); the main worktree is its own repository's checkout and is
-refused only when its path is not that repository's.
+project file, say) fail with `PATH_DENIED` before running git. They (and the
+docker, env and stack methods) refuse a non-main worktree whose path is, or
+contains, a registered repository (`BAD_REQUEST`); the main worktree is its own
+repository's checkout and is refused only when its path is not that repository's.
 
 `project.import` takes one of the projects that `importProjectFile()`
 (`src/shared/model/importProject.ts`) makes from a `.trekproj` of any version.
@@ -335,6 +343,64 @@ Tokens are named, one per device (`trek-server token add <name>`). Revoking a
 token closes its open connections with `4003`.
 
 
+## Docker, environments and stacks
+
+With the capabilities `docker`, `env` and `stacks`, the server runs these on its own machine,
+for any client (phase 5a; before it, the desktop ran them on its own machine, for its Local
+server's windows only). They add no power the token did not already grant (a shell as the
+server user), and they follow the protocol's rules:
+
+- **Paths come from the server.** A method names a project and a worktree (`worktreeId`) or a
+  repository (`repoId`); the server uses the path it stores, which must still pass the path
+  allowlist (`PATH_DENIED`), as for `worktree.changes`. No method takes a path.
+- **Every other argument is checked** (`BAD_REQUEST`), and none reaches a shell: every command
+  is an argument list. A compose action is a name (`up`, `upBuild`, `restart`, `stop`, `down`,
+  `pull`) whose arguments the server owns. A container `id` is a container id or name (letters,
+  digits, `_`, `.`, `-`, not starting with `-`). A `profile` is a `twb-` environment name. A
+  compose service is a name of the same kind. `composeFile` is one or more comma-separated paths
+  inside the worktree (not absolute, no `..`, not starting with `-`). `env.up`'s `settings` takes
+  only the environment keys (`enabled`, `cpu` 1–256, `memory` 1–1024, `disk` 1–10000,
+  `networkAddress`, `rosetta`, `composeFile`; `profileKey` is ignored), and its `envVars` only
+  variable names (`[A-Za-z_][A-Za-z0-9_]*`, at most 200, string values without NUL), never
+  `PATH`, `LD_*`, `DYLD_*`, `DOCKER_HOST`, `DOCKER_CONTEXT` or `DOCKER_CONFIG`. `tail` is 1–5000
+  (default 300); `fileId` and `offset` are non-negative integers.
+- **A missing tool is an answer.** A machine without docker or colima gets `TOOL_ERROR` with
+  `details.reason: missing` (`docker.list`, `env.list`, …), and `env.check` reports which one is
+  missing; a compose or Colima run that cannot start ends with code `-1` and says so in its
+  output. Any other failure of the tool is `TOOL_ERROR` with its message.
+- **Long runs.** `env.up` (a VM's first boot), `docker.compose` (an image build) and
+  `stack.down`/`stack.destroy` (each Ctrl-C's a running `up` and waits up to a minute) can take
+  minutes; clients give them a long request timeout. A run outlives the connection that asked
+  for it: if the link drops, the run goes on, and the client reads the result from the next
+  `env.list` or `stack.status`.
+
+| Method | Params | Result |
+|---|---|---|
+| `docker.list` | `{}` | `ContainerInfo[]` (`docker ps -a`) |
+| `docker.container` | `{action: start\|stop\|restart, id}` | `null` |
+| `docker.compose` | `{projectId, repoId, action}` | compose's exit code; it runs in the repository's main checkout |
+| `env.check` | `{}` | `EnvCheckResult`: colima and docker on the server's PATH (an `ok` answer is kept) |
+| `env.list` | `{projectId, repoId}` | `EnvironmentInfo[]`: the repository's environments, and the `twb-` VMs no registry entry names (`orphaned`) |
+| `env.up` | `{projectId, worktreeId, settings, envVars?}` | `EnvUpResult`: starts (or creates) the VM of the branch git has checked out (re-read first), then `docker compose up -d` in the worktree |
+| `env.stop`, `env.destroy` | `{profile}` | colima's exit code; `destroy` also runs `compose down -v` while the worktree is there, and drops the registry entry |
+| `env.ps` | `{projectId, worktreeId, composeFile?}` | `EnvService[]` |
+| `env.composeFiles` | `{projectId, worktreeId}` | the compose files in the worktree's root |
+| `env.logs` | `{projectId, worktreeId, composeFile?, service, tail?}` | the service's last lines |
+| `stack.status` | `{projectId, worktreeId}` | `StackStatus` |
+| `stack.up` | `{projectId, worktreeId, starter}` | `null`; `stack.sh up` runs detached and outlives the server |
+| `stack.down`, `stack.destroy` | `{projectId, worktreeId}` | stack.sh's exit code |
+| `stack.log` | `{projectId, worktreeId, fileId, offset}` | `StackLogChunk`: from `offset` in the file `fileId` names (at most 1 MiB), else the last 64 KiB of the current one |
+| `worktree.dirty` | `{projectId, worktreeId}` | `git status --porcelain` read now (the status poll's `dirty` can be 30 s old); `null` when git cannot read it |
+
+A VM is named `deriveProfileName(envRepoKey(repository), branch)` (`src/shared/environments.ts`):
+the repository's `environments.profileKey` when an import kept one, else its path. The server
+keeps a registry of its VMs (`<dataDir>/environments.json`, 0600) and each stack's log and `up`
+pid (`<dataDir>/stacks/`). The local server takes over the desktop's own files once, on its
+first start that has none (`start --local --import-env-from <app data dir>`; see the server's
+README).
+
+`docker.log` and `env.log` go only to the connection whose request started the run.
+
 ## Sessions
 
 A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
@@ -765,6 +831,8 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 | `pty.data` | `{ptyId, seq, data, replay?}`, only to connections attached to the pty; `replay: true` chunks are ring-buffer re-sends. Session status is computed on the server from live bytes, never from replay |
 | `pty.exit` | `{ptyId, exitCode}`: the process exited (a dropped socket is not an exit) |
 | `daemon.shutdown` | `{reason}`, best-effort before a graceful stop |
+| `docker.log` | `{data, done?}`: a `docker.compose` run's output, only to the connection that asked for it; `done` on its last |
+| `env.log` | `{profile, data, done?, step?}`: an `env.up`, `env.stop` or `env.destroy`'s output, only to the connection that asked for it; `step` (`vm`, `compose`, `ready`) marks an `env.up` phase, `done` its last |
 
 ## Several clients
 
diff --git a/README.md b/README.md
index 7418bef..afe72e3 100644
--- a/README.md
+++ b/README.md
@@ -166,15 +166,20 @@ other window on that project sees them live.
   environment setting is re-applied over the other client's change without
   asking. Attention badges and the notifications menu cover server sessions.
   Linear ticket chips work in every server window, with the app-wide API key.
-- **Machine-local features, in Local windows only**: a window on the [Local
-  server](#local-server) also has Docker, the per-worktree Colima environments
-  (and their variables), dev stacks, skills, Open in VS Code and Reveal in
-  Finder, since its paths are this machine's.
-  Deleting a worktree there also destroys its dev stack (if ticked) and its VM,
-  after a fresh check for uncommitted changes. A window on a remote server shows
-  none of these.
+- **Docker, environments and dev stacks, on the server's machine**: every server
+  window has the Docker tab (the server's containers, and docker compose in a
+  repository's main checkout), the per-worktree Colima environments (and their
+  variables) and the dev stacks (`docker/stack/stack.sh`), all run by the server
+  on its own machine, with its own docker and colima. A server without them
+  installed says so in the panel. Deleting a worktree also destroys its dev stack
+  (if ticked) and its VM, after a fresh check for uncommitted changes on the
+  server. A server older than this Trek shows none of these.
+- **This machine's features, in Local windows only**: a window on the [Local
+  server](#local-server) also has skills, Open in VS Code and Reveal in Finder,
+  since its paths are this machine's. A window on a remote server shows none of
+  these.
 - **Not yet**: promote to primary, moving worktrees between servers, voice
-  summaries, the project bot and the stack MCP tools (phase 5).
+  summaries, skills on the server, the project bot and the stack MCP tools (phase 5).
 
 ## Importing a .trekproj
 
@@ -248,6 +253,14 @@ screen, or File → New Project…, ⌘N) on Local picks a folder on this machin
   one this Trek bundles. Trek asks once whether to restart it with its own
   version; Keep Running carries on with it, and the list says it is not this
   Trek's version.
+- **Your environments and dev stacks carry over.** Before this version, Trek ran
+  Docker, the Colima environments and the dev stacks itself, and kept their
+  registry in its app data (`environments.json`, and each stack's log and pid in
+  `stacks/`). The Local server runs them now: on its first start that has no
+  registry of its own, it copies Trek's (Trek's files stay where they were), so
+  your VMs, containers and volumes, and a stack that is still running, are its
+  own, under the same names. Until you restart an older Local server (Keep
+  Running), a Local window has no Docker, Env or Stack tab.
 
 ## Attention indicators
 
@@ -316,7 +329,10 @@ one at a time:
 - `npm run smoke:local-window`: a Local window across two repositories: its sidebar,
   sessions, tags, notes, settings, Changes, unload and repository removal;
 - `npm run smoke:local-features`: a Local window's Docker, environments, stacks,
-  skills, VS Code and Reveal against stub `colima`, `docker` and `code`;
+  skills, VS Code and Reveal against stub `colima`, `docker` and `code`, and the
+  Local server's take-over of the environments an older Trek ran itself;
+- `npm run smoke:server-env`: a remote server window's Docker, environments and
+  stacks, run on the server's machine against stub `colima`, `docker` and `stack.sh`;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 01fcbce..b509733 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -204,7 +204,10 @@ Electron, on Linux, macOS and Windows.
   keep running" is no longer needed for unload.)
 - **MCP** is per server. Global sessions launch with that server's MCP URL and token, so a
   project's Global agent sees only its own server's projects.
-- **Docker / env / stacks** (phase 5) act on the server's machine.
+- **Docker / env / stacks** (phase 5a) act on the server's machine: `docker.*`, `env.*`,
+  `stack.*` and `worktree.dirty`, behind the `docker`, `env` and `stacks` capabilities. The
+  environments' registry and the stacks' logs and pids live in the server's data dir; the
+  local server takes over the desktop's own once (`--import-env-from`).
 - **Notifications:** the server publishes the `attention` topic; each client decides
   whether to raise an OS notification.
 
@@ -230,6 +233,7 @@ Electron, on Linux, macOS and Windows.
   session/git `ipcMain` handlers; in phase 5, `bot.ts`, `docker.ts`, `environments.ts`,
   `stacks.ts`, `linear.ts`, `voice.ts` and `skills.ts`, once each has a server replacement.
   Until then those keep running in main against the local machine, for Local windows.
+  `docker.ts`, `environments.ts` and `stacks.ts` went in 5a, with `git:localDirty`.
 - **Windows:** one window per project. The registry entry is
   `{kind: 'file', path}` (legacy, until phase 4) or `{kind: 'server', serverId, projectId}`.
   Opening an already-open entry focuses its window. `open-windows.json` and recents store
diff --git a/server/README.md b/server/README.md
index 8af30af..9a59dd4 100644
--- a/server/README.md
+++ b/server/README.md
@@ -16,6 +16,9 @@ keeps running on the server; the app reattaches when it reconnects.
 - `git` with fetch/push credentials for your repos (the worktree-move flow
   pushes branches through origin)
 - `claude` CLI installed and authenticated **as the user the server runs as**
+- Optional, for the app's Docker, environments and dev stacks tabs: `docker` (with
+  compose), `colima` and `bash` on the server's PATH. Without them the server runs
+  fine, and those calls answer `TOOL_ERROR` (reason `missing`), which the app shows.
 
 ## Install
 
@@ -152,6 +155,9 @@ project is stored as one JSON file in the data dir:
 - Windows: `%LOCALAPPDATA%\trek-server\projects\`
 
 Set `"dataDir"` in the config or pass `--data-dir` to put them elsewhere.
+The data dir also holds the environments' registry (`environments.json`, 0600: each
+`twb-` Colima VM's repository, branch and worktree, and the branch's variables) and
+each dev stack's log and `stack.sh up` pid (`stacks/`).
 `start --data-dir` remembers the directory in the config, so later commands use it too.
 `trek-server remove` refuses to remove a repo that a project still uses.
 
@@ -199,6 +205,11 @@ run by hand:
   code 3 while that process lives; a dead one's lock, or one from before the
   last boot, is taken over; SIGKILL leaves both files for the next start to
   clean up (SIGINT, SIGTERM and SIGHUP remove them);
+- `--import-env-from <dir>` (the app passes its own data dir): once, on a start
+  whose data dir has no `environments.json` yet, the environments registry and
+  the dev stacks' files a Trek before 5a kept there are copied in (a stack's log
+  as a hard link, so a stack still running keeps logging to it). The originals
+  stay. With nothing to copy it writes an empty registry, so it never copies again;
 - any path is allowed (the welcome lists the `local` capability), since the
   user picks paths on their own disk. That covers every path check, not only
   `server.addRepo` and `project.import`: `worktree.create`
@@ -266,6 +277,12 @@ Then configure the app with `wss://dev.example.com`.
   SSH key; run the server as a dedicated user if the box is shared.
 - The path allowlist (repos + their parent dirs + `worktreeRoots`) protects
   against path typos and confused-deputy bugs, not against a stolen token.
+- **Docker, colima and stack.sh run as the server user**, for any client with a
+  token (the app's Docker, Env and Stack tabs). They take no paths from the
+  client (only project, repository and worktree ids, resolved and checked against
+  the allowlist), every argument is checked, and none goes through a shell. A
+  repository's own `docker/stack/stack.sh` and compose files run as written, as a
+  session would run them.
 - Auth failures are logged with the peer address; bad tokens get a delayed
   close to blunt brute force.
 - Never expose the plain `ws://` listener beyond loopback (`--insecure`
```


- [ ] **Step 2: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(5a-2): PROTOCOL.md's docker, env and stack methods, capabilities, TOOL_ERROR and events; the README's server-machine features and the upgrade; the server README's requirements, data dir, --import-env-from and security note; the spec" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md README.md server/README.md docs
```

---

### Task 6: Final verification (5a)

- [ ] **Step 1: No reference to what went**

Save as `<scratch>/gone-5a2.re`:

```
main/(docker|environments|stacks)(\.ts)?['"]|from '\./(docker|environments|stacks)'
registerDockerHandlers|registerEnvironmentHandlers|registerStackHandlers
localTeardown\.ts|from '\./localTeardown'|localWorktreeTeardown|git:localDirty|localWorktreeDirty
'(docker|env|stack):[a-zA-Z]+'
window\.api\.(env[A-Z]|stack[A-Z]|listContainers|containerAction|compose\(|onDockerLog|onEnvLog)
```

Run: `git grep -nE -f <scratch>/gone-5a1.re -f <scratch>/gone-5a2.re -- src server/src ':!src/main/bot.ts' ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected: no output.

- [ ] **Step 2: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1614`, `# pass 1613`, `# fail 0`, `# skipped 1`; `out/server: trek-server 0.2.0, build <hash>` (`58e42acfe91c` in the clean checkout of Step 4; `b468628e3f07` in the prototype, whose `node_modules` were symlinks).

- [ ] **Step 3: Every smoke, one at a time**

| Command | Expected |
|---|---|
| `HOME=$(mktemp -d) node scripts/v2-smoke.mjs` | `V2 SMOKE PASS (171 checks)` |
| `node scripts/local-app-smoke.mjs` | `LOCAL APP SMOKE PASS (45 checks)` |
| `node scripts/local-window-smoke.mjs` | `LOCAL WINDOW SMOKE PASS (57 checks)` |
| `node scripts/local-features-smoke.mjs` | `LOCAL FEATURES SMOKE PASS (41 checks)` |
| `node scripts/server-env-smoke.mjs` | `SERVER ENV SMOKE PASS (29 checks)` |
| `node scripts/providers-smoke.mjs` | `PROVIDERS SMOKE PASS (36 checks)` |
| `node scripts/windows-smoke.mjs` (three times) | `WINDOWS SMOKE PASS (38 checks)`, about 10 s each, no stall |
| `node scripts/import-smoke.mjs` | `IMPORT SMOKE PASS (63 checks)` |
| `node scripts/local-server-smoke.mjs` | `LOCAL SMOKE PASS (85 checks)` |
| `node scripts/client-contract.mjs` | `CLIENT CONTRACT PASS` |
| `(cd server && node scripts/smoke.mjs --built)` | `SERVER SMOKE PASS` (73 `ok:` lines) |


- [ ] **Step 4: A clean checkout installs and builds**

```bash
CLEAN=$(mktemp -d)/trek
git clone -q --branch central-server-phase5a "$PWD" "$CLEAN"
cd "$CLEAN"
npm ci --prefer-offline --no-audit --no-fund
npm run rebuild
npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build
node scripts/local-app-smoke.mjs
```

Expected: `npm ci` ends `added 365 packages`; `npm run rebuild` ends `✔ Rebuild Complete`; `# tests 1614`, `# pass 1613`, `# fail 0`, `# skipped 1`; `out/server: trek-server 0.2.0, build 58e42acfe91c`; `LOCAL APP SMOKE PASS (45 checks)`.

- [ ] **Step 5: The packaged app runs the Local smokes**

In the clean checkout (so the working repo's `dist/` is untouched), package without installing: the app is run from the clone's `dist/`, never copied to `/Applications`, and nothing is registered with LaunchServices (no `lsregister`).

```bash
npm run dist:dir
node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app
node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app
```

Expected: electron-builder ends with `signing file=dist/mac-arm64/Trek.app …` and `skipped macOS notarization`; `LOCAL SMOKE PASS (43 checks)`; `LOCAL APP SMOKE PASS (39 checks)` (its command-line check now ends `start --local --import-env-from <userData>`). (The packaged app's processes are named `Trek`: check for leftovers with `pgrep -fl "$CLEAN"`.) Then remove the clean checkout: `rm -rf "$(dirname "$CLEAN")"`.

- [ ] **Step 6: Nothing left running, nothing of the user's touched**

Run: `pgrep -fl trek-server; pgrep -fl "trek-(import|local-features|local-app|local-window|windows|providers|v2|server-env|local-smoke|client-contract|server-smoke)"; pgrep -fl "sleep (60|120)"; git status --short`

Expected: no output. No smoke wrote under the real HOME (`~/.config/trek-server/local*`, `~/Library/Application Support/Trek Dev`) or ran a real docker or colima.

---

## Notes for 5b and later

1. **Skills** stay this machine's (`MACHINE_FEATURES`, `src/main/skills.ts`, Local only) until 5b moves them with Linear and voice; their list reads the worktree's `.claude/` on this disk.
2. **The trek-dev MCP stack tools** (`get_stack`, `start_stack`, `stop_stack`, `read_stack_log`) can now be built on the server's `StackService` (Question 2). A bot calling them would need the always-ask policy the bot sandbox gave `start_stack`.
3. **An operations topic** (every client seeing a run in progress and its log) would replace Decision 11's per-connection events if several clients watching one environment matters.
4. **The import's legacy files** (`server-tokens.json`, `legacyTokens.ts`, the splitter, `migration.ts`) and the userData `environments.json` and `stacks/` the take-over left behind go when the import is retired; the take-over flag can go then too.

## Risks

1. **A Local server older than 5a has no Docker, Env or Stack tab** (Decision 18), and main no longer runs them: a user who keeps an old Local server running loses them until it restarts. The take-over then happens on that restart.
2. **The take-over runs once per Local profile, from a shared userData** (Decision 16). A dev build's Local profile (`local-dev`) and the installed app's (`local`) each take a copy at their first 5a start; after that they diverge, as two machines would. A VM destroyed through one stays in the other's registry as `missing` until its Reset.
3. **A run's log goes to its own connection only** (Decision 12): another window on the same project sees a run's result, not its progress; a window whose link drops mid-run loses the rest of its log (the run goes on, and the polls show the outcome).
4. **The variables' deny list** (Decision 10) refuses, in any case, `PATH`, `HOME`, `XDG_CONFIG_HOME` and every `DOCKER_*`, `COMPOSE_*`, `BUILDKIT_*`, `LD_*` and `DYLD_*` name, some of which a branch's `.env` text may have set before 5a (most likely `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES`, `DOCKER_BUILDKIT` or `PATH`); `env.up` then fails with "envVars: COMPOSE_PROJECT_NAME cannot be set for docker compose (…)" until the variable is removed from the Env tab.
5. **Docker and Colima run as the server user, for any client with a token.** That is the token's existing power (a shell), not a new one, but it is now a click away in every remote window; a shared server with several users' tokens should not be one where that is unwanted.
6. **`TOOL_ERROR` is a new error code.** An older client shows it as a plain error message (clients pass unknown codes through), which is what it is.
7. **No smoke reaches a real machine without docker.** `TOOL_ERROR` `missing` is covered by `serverMachine.test.mjs` (an empty PATH) and the panel's error state by `smoke:server-env` (a docker that fails).

## Questions for the user

None block this plan.

1. ~~**The variables' deny list**~~ Decided (Decision 10, Risk 4): refuse `PATH`, `HOME`, `XDG_CONFIG_HOME` and the `DOCKER_*`, `COMPOSE_*`, `BUILDKIT_*`, `LD_*`, `DYLD_*` families, case-insensitively.
2. **The stack MCP tools** (`get_stack`, `start_stack`, `stop_stack`, `read_stack_log`) can come back now that stacks are the server's. Add them to 5b, or leave them for the bot's plan?
3. **A server-wide switch to turn Docker, environments and stacks off** (a config `machine: false` that drops the three capabilities) is not in this plan, since the token already grants a shell. Want one for shared servers?
