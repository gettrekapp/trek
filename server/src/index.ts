import { existsSync, rmSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { basename, isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { homedir, hostname } from 'node:os'
import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME, isLocalProfileName } from '../../src/shared/localServer'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocolV2'
import { buildInfo } from './buildInfo'
import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig, saveConfig } from './config'
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
import { createMachine } from './integrations/machine'
import { createIntegrations } from './integrations/integrations'
import { secretsPathFor } from './secrets'
import { seedEnvironmentsFromApp } from './integrations/envSeed'
import {
  addToken,
  DEFAULT_TOKEN_NAME,
  formatTokenList,
  listTokens,
  migrateLegacyToken,
  revokeToken
} from './tokens'

const COMMANDS = ['start', 'stop', 'token', 'add', 'list', 'remove', 'help', 'version'] as const
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
  dataDir?: string
  insecure: boolean
  /** `start --local`: the app's local server, with its own profile (see localProfile.ts). `stop --local` stops it. */
  local: boolean
  /** `--local-profile <name>`: a named local profile (local-<name>) instead of the default one */
  localProfile?: string
  /** `start --local --import-env-from <dir>`: the app's userData, whose environments the local server takes over once */
  importEnvFrom?: string
}

const USAGE = `Usage: trek-server [command] [options]
       trek-server <path>           Same as \`trek-server add <path>\`

Commands:
  start                Run the server (default)
  start --local        Run the Trek app's local server (see --local)
  stop --local         Stop the local server: SIGTERM, then wait for it to exit
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
  --config <path>   Config file (default: ${defaultConfigPath()})
  --port <port>     Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
  --host <host>     Interface to bind (default: config.host or 127.0.0.1)
  --insecure        Allow binding a non-loopback host without TLS
  --data-dir <path> start/remove: project storage (default: config.dataDir or platform dir)
  --local           start/stop: the app's local server. Its own config, data and lock under
                    ~/.config/trek-server/local and <platform data dir>/local; 127.0.0.1
                    on a random port; a new token on every start; any path allowed.
                    Writes the port and token to local.json there (0600) while it runs.
                    Takes none of --config, --data-dir, --port, --host, --insecure.
                    Exits ${LOCAL_ALREADY_RUNNING_EXIT} if a local server is already running.
  --local-profile <name>
                    With --local: a separate local server, under local-<name> in both
                    directories (a dev build of Trek uses "dev"). The name is 1-32 of a-z, 0-9, -,
                    starting with a letter or digit.
  --import-env-from <dir>
                    With start --local: the Trek app's data dir. Once, while the local data dir
                    has no environments.json, its Colima environments registry and dev stack files
                    are copied in (the app ran them itself before; the files there are kept).
  --id <id>         add: repo id (default: slug of the directory name)
  --name <name>     add: display name (default: the directory name)
  -h, --help        Show this help
  -v, --version     Print the server version

A running server picks up repo and token changes without a restart.
To add a directory named like a command, use ./<dir>.
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
    insecure: false,
    local: false
  }
  const value = (i: number, flag: string): string => {
    const next = argv[i]
    if (next === undefined || next.startsWith('-')) usageError(`${flag} needs a value`)
    return next
  }
  let sawCommand = false
  // -h / -v win wherever they appear, so `trek-server -h add` only prints help.
  let wantHelp = false
  let wantVersion = false
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
    else if (arg === '-h' || arg === '--help') wantHelp = true
    else if (arg === '-v' || arg === '--version') wantVersion = true
    else if (arg === '--config') {
      args.configPath = value(++i, arg)
      args.configExplicit = true
    } else if (arg === '--port') {
      const port = Number(value(++i, arg))
      if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`Invalid port: ${argv[i]}`)
      args.port = port
    } else if (arg === '--host') args.host = value(++i, arg)
    else if (arg === '--data-dir') args.dataDir = value(++i, arg)
    else if (arg === '--insecure') args.insecure = true
    else if (arg === '--local') args.local = true
    else if (arg === '--import-env-from') {
      const dir = value(++i, arg)
      if (!isAbsolute(dir)) usageError(`--import-env-from needs an absolute path: ${dir}`)
      args.importEnvFrom = dir
    }
    else if (arg === '--local-profile') {
      const name = value(++i, arg)
      if (!isLocalProfileName(name)) usageError(`Invalid local profile name: ${name} (1-32 of a-z, 0-9 and -, starting with a letter or digit)`)
      args.localProfile = name
    }
    else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
    else usageError(`Unknown argument: ${arg}`)
  }
  if (wantHelp || wantVersion) {
    args.command = wantHelp ? 'help' : 'version'
    return args
  }
  if (args.local && args.command !== 'start' && args.command !== 'stop') usageError('--local only applies to `start` and `stop`')
  if (args.localProfile !== undefined && !args.local) usageError('--local-profile only applies with --local')
  if (args.importEnvFrom !== undefined && !(args.local && args.command === 'start')) usageError('--import-env-from only applies to `start --local`')
  if (args.command === 'stop' && !args.local) usageError('`stop` only stops the local server: `trek-server stop --local`')
  if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
    usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
  }
  if ((args.port !== undefined || args.host !== undefined || args.insecure) && args.command !== 'start') {
    usageError('--port, --host and --insecure only apply to `start`')
  }
  if (args.dataDir !== undefined && args.command !== 'start' && args.command !== 'remove') {
    usageError('--data-dir only applies to `start` and `remove`')
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
  console.log(buildInfo().version)
  process.exit(0)
}

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
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !args.insecure) {
  fail(
    `Refusing to bind ${host} without TLS. Put a TLS-terminating reverse proxy (Caddy) in front\n` +
      'of the loopback listener, or pass --insecure if you really know what you are doing.'
  )
}
if (readLegacyInPlace) {
  migrateConfig()
  store = openStore(args.configPath)
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
    local: local !== undefined,
    machine: createMachine(serverDataDir, { local: local !== undefined }),
    integrations: createIntegrations({
      secretsFile: secretsPathFor(resolve(args.configPath)),
      linearEndpoint: process.env.TREK_SERVER_LINEAR_URL || undefined
    })
  }
)
store.watch()
server.httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} on ${host} is already in use (is trek-daemon or another trek-server still running?)`)
  } else {
    console.error(err.message)
  }
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
  if (local) void announceLocal(local, bound)
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

const SHUTDOWN_FLUSH_MS = 200
let shuttingDown = false
// SIGHUP: the terminal that ran `start --local` closed. Without a handler the
// process dies with local.json (and its token) and the lock left behind.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    // First, so the app stops connecting to a server that is going away.
    if (local) removeLocalInfo(local.infoPath, process.pid)
    console.log(`\n${signal} — shutting down (all agent sessions will end)`)
    store.close()
    server.shutdown(signal)
    // close() flushes pending saves and returns the ids that could not be written.
    const failed = projectFiles.files.close()
    if (failed.length > 0) console.error(`could not save ${failed.length} project(s): ${failed.join(', ')}`)
    // Give the daemon.shutdown frames and close handshakes a moment to flush.
    setTimeout(() => {
      server.sessions.terminals.forceKillAll()
      process.exit(0)
    }, SHUTDOWN_FLUSH_MS)
  })
}
