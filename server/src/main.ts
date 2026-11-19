import { existsSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME } from '../../src/shared/localServer'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocolV2'
import { buildInfo } from './buildInfo'
import { ensureIdentity, legacyConfigPath, migrateLegacyConfig, saveConfig } from './config'
import type { Project } from '../../src/shared/model/types'
import { ConfigStore } from './configStore'
import { defaultDataDir, projectsDir } from './dataDir'
import { acquireLock, holdsLock, releaseLock, removeStaleTemps, type LockResult } from './localLock'
import { localProfile, removeLocalInfo, writeLocalInfo, type LocalProfile } from './localProfile'
import { stopLocal } from './localStop'
import { projectsUsingRepo } from './projects/model'
import { ProjectState } from './projects/state'
import { ProjectStore } from './projects/store'
import { formatRepoList } from './repos'
import { startServer } from './server'
import { PLUGIN_STOP_MS } from './plugins/registry'
import { localSiblingDataDirs } from './plugins/siblings'
import { tailscaleAddress, testPhoneAddress } from './tailscale'
import { loadNodePty } from './sessions/nativePty'
import { createMachine } from './integrations/machine'
import { BUILTIN_SERVER_PLUGINS } from '../../plugins/builtin.server.ts'
import { createIntegrations } from './integrations/integrations'
import { secretsPathFor } from './secrets'
import { seedEnvironmentsFromApp } from './integrations/envSeed'
import { loadWebBundle, type WebBundle } from './web/bundle'
import { webClientDir } from './web/dir'
import { pollMsFromEnv } from './prWatch/watcher'
import { clockFromFile } from './automations/scheduler'
import { pruneRecoveryFiles } from './promote/promoteHandlers'
import { hardenWindowsEnv } from '../../src/host/commandPath.ts'
import { closeInheritedDescriptors } from './inheritedDescriptors.ts'
import {
  addToken,
  DEFAULT_TOKEN_NAME,
  formatTokenList,
  listTokens,
  migrateLegacyToken,
  revokeToken
} from './tokens'
import { USAGE, parseArgs } from './cli.ts'
import { applyUpdate, findUpdate } from './update/apply.ts'
import { controlPath, listenControl, type RelaunchAnswer } from './update/control.ts'
import { isTestUpdateBuild, updateSource } from './update/keys.ts'
import { canRelaunch, relaunch, relaunchRefusal } from './update/relaunch.ts'
import { createUpdateService, installedVersion, type UpdateService } from './update/service.ts'
import { clearTried, settleStart } from './update/state.ts'
import { readInstall, type Install } from './update/updatable.ts'

/** The bundle's own folder. A source run (tsx) has server/src here: not an install (no build.json, no update marks), so nothing about updates applies to it. */
const installDir = typeof __dirname === 'string' ? __dirname : ''

/**
 * An exit on purpose before the server is listening (no token, a config that cannot be read, a
 * port in use, a signal). Getting here shows this version loads and runs, so the launcher's mark
 * for this start goes: only a start that crashed, or was killed outright, counts against an update.
 */
function fail(message: string): never {
  console.error(message)
  clearTried(installDir)
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
  console.log(buildInfo().version)
  process.exit(0)
}

// SIGHUP: the terminal that ran `start --local` closed (on Windows: its console window). Without a
// handler the process dies with local.json (and its token) and the lock left behind. SIGBREAK:
// Ctrl+Break in a Windows console.
// Taken here, before the checks and the loading below: a handler runs only once this file has run
// to its end (all of it is synchronous), so a signal during startup is a shutdown() that finds
// everything it needs, and not a start killed half-way, which the launcher would count against
// a pending update. The other commands exit before a handler could run, as they did before.
if (args.command === 'start') {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => shutdown(signal))
}

// Windows: no cmd.exe this server starts (nor anything below it: every child inherits this env)
// looks a program up in its current directory, a worktree a repository could plant one in.
hardenWindowsEnv(process.env)

/** `start --local`'s profile; its config and data dir replace the defaults. */
const local: LocalProfile | undefined = args.local ? localProfile(homedir(), defaultDataDir(), args.localProfile) : undefined
if (local) {
  args.configPath = local.configPath
  // Never copy the trek-daemon config into the local profile.
  args.configExplicit = true
  args.dataDir = local.dataDir
  // The app runs this bundle with Electron's Node (ELECTRON_RUN_AS_NODE=1). Every
  // session's pty inherits this env, so an Electron app started from one (VS Code's
  // `code`, Trek's own `npm run dev`) would run as Node. ELECTRON_RENDERER_URL is
  // the app's dev server, and no agent should see it.
  delete process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_RENDERER_URL
  // Linux: the app's own sockets and pipes, which this process (and its agents) would keep open
  // after the app quits (Node's own are close-on-exec, and stay).
  if (args.command === 'start') {
    const closed = closeInheritedDescriptors()
    if (closed.length > 0) console.log(`local: closed ${closed.length} descriptor(s) inherited from the app: ${closed.join(', ')}`)
  }
}

if (args.command === 'stop' && local) process.exit(stopLocal(local))

function openStore(path: string): ConfigStore {
  try {
    // The local server's guard allows any path: the user picks them on their own disk.
    return new ConfigStore(path, { permissive: local !== undefined })
  } catch (err) {
    fail(`Cannot read ${path}: ${(err as Error).message}`)
  }
}

function openProjects(config: { dataDir?: string }): { dir: string; files: ProjectStore; loaded: Project[] } {
  const dir = projectsDir(args.dataDir ?? config.dataDir ?? defaultDataDir())
  const files = new ProjectStore(dir)
  return { dir, files, loaded: files.loadAll() }
}

/** Copies the trek-daemon config into place if there is no trek-server config yet. */
function migrateConfig(): void {
  if (!args.configExplicit && migrateLegacyConfig(args.configPath, legacyConfigPath())) {
    console.error(`Copied ${legacyConfigPath()} to ${args.configPath}.`)
  }
}

// Read-only commands (and `start`, until its checks pass) read a legacy
// trek-daemon config in place rather than copying it.
const readLegacyInPlace =
  !args.configExplicit && !existsSync(args.configPath) && existsSync(legacyConfigPath())
const readOnly = args.command === 'list' || (args.command === 'token' && args.tokenAction === 'list')
if (!readOnly && args.command !== 'start') migrateConfig()
let store = openStore(readLegacyInPlace && (readOnly || args.command === 'start') ? legacyConfigPath() : args.configPath)

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
    const { loaded } = openProjects(store.config)
    store.setUsage((repo) => projectsUsingRepo(loaded, repo.path))
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
    try {
      store.update((c) => {
        revokeToken(c, name)
      })
    } catch (err) {
      fail((err as Error).message)
    }
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

// start: every check runs before anything is written.
// node-pty first: a native module that will not load (a quarantined download on macOS) would
// otherwise fail the first session, after the server looked healthy.
try {
  loadNodePty()
} catch (err) {
  fail((err as Error).message)
}
if (local) {
  // The lock comes first: a second local server must not touch the profile.
  let lock: LockResult
  try {
    lock = acquireLock(local.lockPath)
  } catch (err) {
    fail(`Cannot take the lock ${local.lockPath}: ${(err as Error).message}`)
  }
  if (!lock.ok) {
    const pid = lock.holder > 0 ? ` (pid ${lock.holder})` : ''
    console.error(`A local trek-server is already running${pid}. Its port and token are in ${local.infoPath}.`)
    process.exit(LOCAL_ALREADY_RUNNING_EXIT)
  }
  // Right after the lock is ours, so a throw from here on still releases it.
  process.on('exit', () => {
    removeLocalInfo(local.infoPath, process.pid)
    releaseLock(local.lockPath)
  })
  if (lock.tookOver !== undefined) console.log(`Took over the lock of a local trek-server that is gone (pid ${lock.tookOver}).`)
  // Each write to the profile first checks the lock is still ours (Decision 12).
  stillHoldingLock(local)
  removeStaleTemps(local.dir, [LOCAL_LOCK_FILE, LOCAL_INFO_FILE])
  // Holding the lock, any local.json is a dead server's: its port and token are stale.
  stillHoldingLock(local)
  rmSync(local.infoPath, { force: true })
  stillHoldingLock(local)
  if (!existsSync(local.configPath)) saveConfig(local.configPath, { repos: [] })
} else if (listTokens(store.config).length === 0) {
  fail(`No token configured. Run \`trek-server token\` first (config: ${args.configPath}).`)
}
const host = local ? '127.0.0.1' : (args.host ?? store.config.host ?? '127.0.0.1')
// The local server takes a port the OS picks; local.json says which.
const port = local ? 0 : (args.port ?? store.config.port ?? DEFAULT_DAEMON_PORT)
const loopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1'
if (!loopbackBind && !args.insecure) {
  fail(
    `Refusing to bind ${host} without TLS. Put a TLS-terminating reverse proxy (Caddy) in front\n` +
      'of the loopback listener, or pass --insecure if you really know what you are doing.'
  )
}
if (readLegacyInPlace) {
  migrateConfig()
  store = openStore(args.configPath)
}
/** The web client's files, read once now (`--web` or `web: true`; never the local server). */
let webBundle: WebBundle | undefined
if (!local && (args.web || store.config.web === true)) {
  const dir = webClientDir(__dirname)
  if (!dir) fail('--web needs the web client build next to the server (dist/web-client): run `npm run build:web` in the Trek repo.')
  try {
    webBundle = loadWebBundle(dir)
  } catch (err) {
    fail(`Cannot read the web client in ${dir}: ${(err as Error).message}`)
  }
}
const config = store.config
// --data-dir is remembered, so a later plain `trek-server remove` checks the same projects.
const dataDir = args.dataDir === undefined ? undefined : resolve(args.dataDir)
/** The local server's token, for local.json. Only its hash is saved, as for any token. */
let localToken = ''
if (local || !config.serverId || !config.name || config.tokenHash || (dataDir !== undefined && config.dataDir !== dataDir)) {
  // The token rotation is a profile write too.
  if (local) stillHoldingLock(local)
  try {
    store.update((c) => {
      ensureIdentity(c, hostname())
      migrateLegacyToken(c)
      if (dataDir !== undefined) c.dataDir = dataDir
      // A new token on every start, replacing the last one: a token from an old local.json stops working.
      if (local) localToken = addToken(c, LOCAL_TOKEN_NAME)
    })
  } catch (err) {
    fail(`Cannot update ${args.configPath}: ${(err as Error).message}`)
  }
}

let projectFiles: ReturnType<typeof openProjects>
try {
  projectFiles = openProjects(store.config)
} catch (err) {
  fail(`Cannot read projects from ${projectsDir(args.dataDir ?? store.config.dataDir ?? defaultDataDir())}: ${(err as Error).message}`)
}
const { version, build } = buildInfo()
const serverDataDir = resolve(args.dataDir ?? store.config.dataDir ?? defaultDataDir())
// Promote recovery files (5e) are kept 30 days after a failure, then deleted at startup.
void pruneRecoveryFiles(resolve(serverDataDir, 'promote-recovery')).then((removed) => {
  if (removed.length > 0) console.log(`deleted ${removed.length} promote recovery file(s) older than 30 days`)
})
if (args.importEnvFrom !== undefined) {
  try {
    const seed = seedEnvironmentsFromApp(args.importEnvFrom, serverDataDir)
    if (seed.seeded) console.log(`environments: took over ${seed.environments} environment(s) and ${seed.stackFiles} stack file(s) from ${args.importEnvFrom}`)
    if (seed.skipped.length > 0) console.warn(`environments: left out ${seed.skipped.join('; ')}`)
  } catch (err) {
    // The VMs are still there; the next start tries again (nothing was written).
    console.warn(`environments: could not take over ${args.importEnvFrom}: ${(err as Error).message}`)
  }
}
/** A tarball install that is not the local server: the only kind that updates itself. Read once: the service, the control socket and the daily check are all for this install or for none. */
const updatable = readInstall(installDir, { local: local !== undefined })
const updateInstall: Install | undefined = updatable.ok ? updatable.install : undefined
/** The update service (a tarball install only): the protocol's update.* and the daily check. Made by startServer, as it starts. */
let updateService: UpdateService | undefined
const server = startServer(
  store,
  version,
  {
    create: (hub, onSummariesChange) =>
      new ProjectState({ hub, store: projectFiles.files, onSummariesChange }, projectFiles.loaded),
    store: projectFiles.files
  },
  // Absolute: agents read the config file from their own worktree's directory.
  {
    mcpDir: resolve(serverDataDir, 'mcp'),
    promoteRecoveryDir: resolve(serverDataDir, 'promote-recovery'),
    historyDir: resolve(serverDataDir, 'history'),
    local: local !== undefined,
    machine: createMachine(serverDataDir, { local: local !== undefined }),
    integrations: createIntegrations({}),
    prWatch: {
      // The smokes' knob: the time between polls, and between sign-in checks.
      pollMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS),
      recheckMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS)
    },
    automations: {
      tickMs: pollMsFromEnv(process.env.TREK_SERVER_AUTOMATION_TICK_MS),
      now: clockFromFile(process.env.TREK_SERVER_AUTOMATION_CLOCK_FILE)
    },
    // Background push (6b): the phones' relay grants live in the same secrets file.
    push: { secretsFile: secretsPathFor(resolve(args.configPath)) },
    // The plugins (plugin system phase 1): their keys in the same secrets file, their files in `<dataDir>/plugins/<id>`.
    // A Local server's built-ins also read the other Local profiles' old files, and take the app's over once (plugins E2).
    plugins: {
      list: BUILTIN_SERVER_PLUGINS,
      secretsFile: secretsPathFor(resolve(args.configPath)),
      dataDir: serverDataDir,
      ...(local !== undefined ? { siblingDataDirs: () => localSiblingDataDirs(serverDataDir) } : {}),
      ...(args.importEnvFrom !== undefined ? { importFrom: args.importEnvFrom } : {})
    },
    web: webBundle ? { bundle: webBundle } : undefined,
    onStopRequest: local ? () => shutdown('server.stop') : undefined,
    // The local server's listener for phones: this machine's Tailscale address, read each time it
    // is checked (TREK_SERVER_PHONE_ADDRESS, a loopback address only, stands in for it in the smokes).
    phoneAccess: local ? { address: () => testPhoneAddress(process.env.TREK_SERVER_PHONE_ADDRESS) ?? tailscaleAddress(networkInterfaces()) } : undefined,
    // Only with a key built in: without one no release can be verified, so a client is offered nothing
    // (`trek-server update` on this machine still says why).
    update: updateInstall && updateSource().keys.length > 0
      ? (onChange) => {
          const source = updateSource()
          const base = { install: updateInstall, configDir: dirname(resolve(args.configPath)), feed: source.feed, keys: source.keys, fetch }
          updateService = createUpdateService({
            install: updateInstall,
            configDir: base.configDir,
            running: version,
            sessions: () => server.sessions.terminals.count(),
            // Read at each request: the config is reloaded when its file changes.
            remoteApply: () => store.config.updates?.remoteApply !== false,
            canRelaunch,
            relaunchRefusal: () => relaunchRefusal(updateInstall.dir),
            find: () => findUpdate(base),
            apply: (opts) => applyUpdate({ ...base, expect: opts.expect, onStep: opts.onStep, onProgress: opts.onProgress }),
            relaunch: (to) => {
              const answer = requestRelaunch(updateInstall, to)
              if (!answer.ok) throw new Error(answer.error)
            },
            onChange
          })
          return updateService
        }
      : undefined
  }
)
store.watch()
// First in line: the WebSocket server (ws) hands the HTTP server's errors on to its own 'error'
// event, which nobody listens to, so behind it this would never run: the error would be thrown
// instead, and a port in use would look like a crash (to the user, and to the launcher).
server.httpServer.prependListener('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} on ${host} is already in use (is trek-daemon or another trek-server still running?)`)
  } else {
    console.error(err.message)
  }
  // Not this version's fault: the update it may be the first start of stays untried.
  clearTried(installDir)
  process.exit(1)
})
server.httpServer.listen(port, host, () => {
  const bound = (server.httpServer.address() as AddressInfo).port
  console.log(
    `trek-server ${version} (build ${build}) "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${bound}`
  )
  console.log(
    store.config.repos.length > 0
      ? `repos: ${store.config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`
      : local
        ? 'No repos registered yet.'
        : 'No repos registered yet. Add one with `trek-server add <path>`.'
  )
  console.log(`projects: ${projectFiles.loaded.length} in ${projectFiles.dir}`)
  if (webBundle) {
    console.log(
      `web client: http://${host.includes(':') ? `[${host}]` : host}:${bound}/` +
        (loopbackBind ? ' (this machine only; other devices reach it through your TLS proxy, on its https name)' : '')
    )
    // --insecure on another interface: the page loads, but a browser drops the Secure session
    // cookie on plain http there, so no sign-in ever sticks.
    if (!loopbackBind) console.warn('web client: browsers sign in only over https here; put a TLS proxy in front (see the README)')
    // Cookies are not port-scoped: a browser sends this one to every server on the same host name.
    else
      console.warn(
        'web client: cookies are not port-scoped: opened on 127.0.0.1/localhost, any other local web server the browser visits (a dev stack, a worktree\'s dev server) sees the session cookie; use a host name nothing else is reached on (see the README)'
      )
  }
  if (local) {
    // The local server settles no update (it follows the app); the launcher does not mark its start, and a mark for it would go here.
    clearTried(installDir)
    void announceLocal(local, bound)
  } else startUpdates()
})

/**
 * Exits 3 unless this process still holds the local lock. Two starts that took
 * over the same stale lock at once: only the one holding it may write the profile.
 */
function stillHoldingLock(profile: LocalProfile): void {
  if (holdsLock(profile.lockPath)) return
  console.error(`Another local trek-server took the lock ${profile.lockPath}; exiting.`)
  process.exit(LOCAL_ALREADY_RUNNING_EXIT)
}

/**
 * Writes local.json, the app's cue that the local server is ready. It waits for
 * MCP to settle, so the app's first welcome lists `mcp` if the server has it.
 */
const MCP_READY_TIMEOUT_MS = 5000

async function announceLocal(profile: LocalProfile, port: number): Promise<void> {
  // Bounded: a hung MCP listener costs only the `mcp` capability, not the start.
  const ready = await Promise.race([server.ready.then(() => true), delay(MCP_READY_TIMEOUT_MS).then(() => false)])
  if (!ready) console.warn(`MCP is not ready after ${MCP_READY_TIMEOUT_MS / 1000} s; announcing without it.`)
  if (shuttingDown) return
  stillHoldingLock(profile)
  try {
    writeLocalInfo(profile.infoPath, { port, pid: process.pid, token: localToken, version, build })
  } catch (err) {
    fail(`Cannot write ${profile.infoPath}: ${(err as Error).message}`)
  }
  console.log(`local: port and token in ${profile.infoPath}`)
}

/** What a relaunch needs: the install whose launcher this process becomes, and the arguments this server was started with. */
interface RelaunchInto {
  installDir: string
  argv: readonly string[]
  /** The version it becomes, which the clients are told (`daemon.shutdown`); absent when the install cannot say */
  version?: string
}

/** The control socket `trek-server update` reaches this server on (an updatable install only). */
let updateControl: { close(): void } | undefined
/** Settles once the control socket is listening or has given up: a shutdown that starts before then waits for it, to close it. */
let updateControlSettled: Promise<void> = Promise.resolve()
/** The release check's timers: the first look, and the daily one. */
let updateCheckTimers: Array<ReturnType<typeof setTimeout>> = []
/** A relaunch request was accepted; its shutdown starts after the answer is sent. */
let relaunchAccepted = false
/** Set by that shutdown: once it is done, become the install's new version instead of exiting. */
let relaunchInto: RelaunchInto | undefined
const UPDATE_FIRST_CHECK_MS = 30_000
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * The one way this server restarts into the version now in its install folder, whoever asks:
 * `trek-server update` over the control socket, or the update service after an install a client
 * asked for. Says why not, with the server left as it is; else the restart begins after this
 * tick (so an answer already written goes out): the usual shutdown, then the relaunch. `to`: the
 * version the clients are told they are waiting for; the command does not name one, so it is read
 * from the install folder, which has just been swapped in.
 */
function requestRelaunch(install: Install, to?: string): RelaunchAnswer {
  if (!canRelaunch()) return { ok: false, error: `Node ${process.versions.node} cannot replace a running process (22.15 or later can)` }
  // Asked twice: the restart the first request started is the answer to both.
  if (relaunchAccepted) return { ok: true }
  if (shuttingDown) return { ok: false, error: 'the server is already shutting down' }
  // Before anything is shut down: a launcher that cannot be run leaves this server up, and whoever asked says a restart is needed.
  const refusal = relaunchRefusal(install.dir)
  if (refusal !== null) return { ok: false, error: refusal }
  relaunchAccepted = true
  const version = to ?? installedVersion(install.dir)
  setImmediate(() => shutdown('update', { installDir: install.dir, argv: process.argv.slice(2), version }))
  return { ok: true }
}

/**
 * Once listening (never the local server, which follows the app): how the last update went, the
 * socket `trek-server update` asks for a restart on, and a daily look at the release feed. A
 * server that is not a release tarball's (server/dist, a source run) only settles, which finds
 * nothing: no socket, no timers, no request.
 */
function startUpdates(): void {
  if (shuttingDown) return
  const configPath = resolve(args.configPath)
  const configDir = dirname(configPath)
  if (installDir) {
    const settled = settleStart(installDir, configDir, new Date(), version)
    if (settled) console.log(settled.ok ? `update: now running trek-server ${settled.to} (was ${settled.from})` : `update: ${settled.error}`)
  }

  const install = updateInstall
  if (!install) return

  updateControlSettled = listenControl(controlPath(configPath), {
    status: () => ({ pid: process.pid, version, installDir: install.dir, sessions: server.sessions.terminals.count(), canRelaunch: canRelaunch() }),
    relaunch: () => {
      const answer = requestRelaunch(install)
      // The command asks only once it has installed: refused, the new version waits in the install
      // folder for a restart by hand, and nothing has told the clients (`restartNeeded`).
      if (!answer.ok && !shuttingDown) updateService?.notify()
      return answer
    }
  }).then(
    (control) => {
      // A shutdown that began while the socket was being taken: it is waiting for this.
      if (shuttingDown) control?.close()
      else updateControl = control ?? undefined
    },
    (err: unknown) => console.warn(`update: no control socket: ${(err as Error).message}`)
  )

  // No key built in (so no service): nothing could be verified, so nothing is asked.
  const service = updateService
  if (!service) return
  // The config file was edited (it is reloaded when it changes): clients hear a new `updates.remoteApply`.
  store.on('change', () => service.configChanged())
  const check = (): void => {
    // Read each time: the config is reloaded when its file changes.
    if (shuttingDown || store.config.updates?.check === false) return
    // Through the service, so the clients hear what it finds (`update.changed`), and so it never
    // runs beside an update: one that is running refuses it (`busy`), which is not worth a line.
    service.check().then(
      (status) => {
        if (status.latest !== undefined) console.log(`update: trek-server ${status.latest} is available (this is ${version}); run \`trek-server update\``)
      },
      (err: unknown) => {
        if ((err as { details?: { reason?: unknown } } | null)?.details?.reason === 'busy') return
        const cause = (err as { cause?: unknown } | null)?.cause
        console.warn(`update: could not check for a newer release: ${typeof cause === 'string' ? cause : (err as Error).message}`)
      }
    )
  }
  // The update smoke's knob, read by a test build only: how long after listening the first look is.
  const firstMs = (isTestUpdateBuild() && pollMsFromEnv(process.env.TREK_UPDATE_FIRST_CHECK_MS)) || UPDATE_FIRST_CHECK_MS
  updateCheckTimers = [setTimeout(check, firstMs), setInterval(check, UPDATE_CHECK_EVERY_MS)]
  // Never what keeps a stopping server alive.
  for (const timer of updateCheckTimers) timer.unref()
}

const SHUTDOWN_FLUSH_MS = 200
/** The longest the exit waits for a move's staged histories to be removed */
const SHUTDOWN_CLEAR_MS = 2000
let shuttingDown = false

/**
 * The one way out: a signal, `server.stop` (the local server's `stop --local`; on Windows a
 * signal from another process is TerminateProcess, so this never ran there before), or
 * a relaunch request (`into`: requestRelaunch, for `trek-server update` or an update a client asked
 * for), which ends in the new version instead of an exit.
 */
function shutdown(reason: string, into?: RelaunchInto): void {
  if (shuttingDown) {
    // A signal while restarting into an update: whoever sent it (a service manager stopping the
    // unit, Ctrl+C) wants the server gone, so it exits. Its next start is the new version.
    if (relaunchInto && !into) {
      relaunchInto = undefined
      console.log(`update: ${reason} during the restart; exiting instead`)
    }
    return
  }
  shuttingDown = true
  relaunchInto = into
  // Asked to stop before it was listening (Ctrl+C, a service manager's stop): not a failed start.
  if (!server.httpServer.listening) clearTried(installDir)
  // First, so the app stops connecting to a server that is going away.
  if (local) removeLocalInfo(local.infoPath, process.pid)
  console.log(`\n${reason} — shutting down (all agent sessions will end)`)
  // Closing the socket removes its file, so the next start (or the new version) finds none in its way.
  updateControl?.close()
  updateControl = undefined
  for (const timer of updateCheckTimers) clearTimeout(timer)
  store.close()
  // Settles once a move's staged histories are removed (bounded below, so a slow disk can't hold the exit).
  // A restart into an update names the version, so a client can say what it is waiting for.
  const cleared = server.shutdown(reason, into?.version !== undefined ? { version: into.version } : undefined)
  // close() flushes pending saves and returns the ids that could not be written.
  const failed = projectFiles.files.close()
  if (failed.length > 0) console.error(`could not save ${failed.length} project(s): ${failed.join(', ')}`)
  // Give the daemon.shutdown frames and close handshakes a moment to flush.
  const flushed = delay(SHUTDOWN_FLUSH_MS)
  // A control socket still being taken is closed when it settles (startUpdates); bounded like the rest.
  const controlClosed = Promise.race([updateControlSettled, delay(SHUTDOWN_CLEAR_MS)])
  // A plugin's program still stopping holds the exit until its SIGKILL (registry.ts, PLUGIN_STOP_MS).
  void Promise.all([flushed, Promise.race([cleared, delay(Math.max(SHUTDOWN_CLEAR_MS, PLUGIN_STOP_MS))]), controlClosed]).then(() => {
    server.sessions.terminals.forceKillAll()
    if (relaunchInto) {
      try {
        // Does not return: this process becomes the launcher, then the new version, with the same pid.
        relaunch(relaunchInto.installDir, relaunchInto.argv)
      } catch (err) {
        // A service manager (systemd's Restart=always) starts the new version; a hand-started server is restarted by hand.
        console.error(`update: could not restart into the new version: ${(err as Error).message}`)
        process.exit(1)
      }
    }
    process.exit(0)
  })
}

