import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig } from './config'
import type { Project } from '../../src/shared/model/types'
import { ConfigStore } from './configStore'
import { defaultDataDir, projectsDir } from './dataDir'
import { projectsUsingRepo } from './projects/model'
import { ProjectState } from './projects/state'
import { ProjectStore } from './projects/store'
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
  dataDir?: string
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
  --data-dir <path> start/remove: where projects are stored (default: config.dataDir or the platform data dir)
  --id <id>        add: repo id (default: slug of the directory name)
  --name <name>    add: display name (default: the directory name)
  -h, --help       Show this help
  -v, --version    Print the server version

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
    insecure: false
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
    else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
    else usageError(`Unknown argument: ${arg}`)
  }
  if (wantHelp || wantVersion) {
    args.command = wantHelp ? 'help' : 'version'
    return args
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

function openStore(path: string): ConfigStore {
  try {
    return new ConfigStore(path)
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
if (listTokens(store.config).length === 0) {
  fail(`No token configured. Run \`trek-server token\` first (config: ${args.configPath}).`)
}
const host = args.host ?? store.config.host ?? '127.0.0.1'
const port = args.port ?? store.config.port ?? DEFAULT_DAEMON_PORT
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
if (!config.serverId || !config.name || config.tokenHash || (dataDir !== undefined && config.dataDir !== dataDir)) {
  try {
    store.update((c) => {
      ensureIdentity(c, hostname())
      migrateLegacyToken(c)
      if (dataDir !== undefined) c.dataDir = dataDir
    })
  } catch (err) {
    fail(`Cannot update ${args.configPath}: ${(err as Error).message}`)
  }
}

const projectFiles = openProjects(store.config)
const server = startServer(store, serverVersion(), {
  create: (hub, onSummariesChange) =>
    new ProjectState({ hub, store: projectFiles.files, onSummariesChange }, projectFiles.loaded),
  store: projectFiles.files
})
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
  console.log(
    `trek-server ${serverVersion()} "${store.config.name}" (${store.config.serverId}) listening on ws://${host}:${port}`
  )
  console.log(
    store.config.repos.length > 0
      ? `repos: ${store.config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`
      : 'No repos registered yet. Add one with `trek-server add <path>`.'
  )
  console.log(`projects: ${projectFiles.loaded.length} in ${projectFiles.dir}`)
})

const SHUTDOWN_FLUSH_MS = 200
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n${signal} — shutting down (all agent sessions will end)`)
    store.close()
    server.shutdown(signal)
    // close() flushes pending saves and returns the ids that could not be written.
    const failed = projectFiles.files.close()
    if (failed.length > 0) console.error(`could not save ${failed.length} project(s): ${failed.join(', ')}`)
    // Give the daemon.shutdown frames and close handshakes a moment to flush.
    setTimeout(() => process.exit(0), SHUTDOWN_FLUSH_MS)
  })
}
