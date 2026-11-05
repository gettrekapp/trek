import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
import { defaultConfigPath, loadConfig, saveConfig } from './config'
import { addRepo, formatRepoList, removeRepo, resolveRepoRoot } from './repos'
import { hashToken, startServer } from './server'

interface CliArgs {
  command: (typeof COMMANDS)[number]
  configPath: string
  /** `add`: the repo path. `remove`: an id or path. Both default to the current directory. */
  repoPath?: string
  repoId?: string
  repoName?: string
  port?: number
  host?: string
  insecure: boolean
}

const COMMANDS = ['start', 'token', 'add', 'list', 'remove', 'help', 'version'] as const

const USAGE = `Usage: trek-daemon [command] [options]
       trek-daemon <path>         Same as \`trek-daemon add <path>\`

Commands:
  start            Run the daemon (default)
  token            Generate a new access token, replacing any previous one
  add [path]       Add the git repo at path (default: current directory)
  list             List the configured repos
  remove [id|path] Remove a repo by id or path (default: current directory)
  help             Show this help
  version          Print the daemon version

Options:
  --config <path>  Config file (default: ${defaultConfigPath()})
  --port <port>    Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
  --host <host>    Interface to bind (default: config.host or 127.0.0.1)
  --insecure       Allow binding a non-loopback host without TLS
  --id <id>        add: repo id (default: slug of the directory name)
  --name <name>    add: display name (default: the directory name)
  -h, --help       Show this help
  -v, --version    Print the daemon version
`

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'start', configPath: defaultConfigPath(), insecure: false }
  const value = (i: number, flag: string): string => {
    const next = argv[i]
    if (next === undefined || next.startsWith('-')) usageError(`${flag} needs a value`)
    return next
  }
  let sawCommand = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (
      !sawCommand &&
      (COMMANDS as readonly string[]).includes(arg)
    ) {
      args.command = arg as CliArgs['command']
      sawCommand = true
    } else if (!arg.startsWith('-') &&
      (args.command === 'add' || args.command === 'remove') &&
      args.repoPath === undefined) {
      args.repoPath = arg
    } else if (!arg.startsWith('-') && !sawCommand && isDirectory(arg)) {
      // `trek-daemon .` / `trek-daemon ~/repos/x` — shorthand for add.
      args.command = 'add'
      args.repoPath = arg
      sawCommand = true
    } else if (arg === '--id') args.repoId = value(++i, arg)
    else if (arg === '--name') args.repoName = value(++i, arg)
    else if (arg === '-h' || arg === '--help') args.command = 'help'
    else if (arg === '-v' || arg === '--version') args.command = 'version'
    else if (arg === '--config') args.configPath = value(++i, arg)
    else if (arg === '--port') {
      const port = Number(value(++i, arg))
      if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`Invalid port: ${argv[i]}`)
      args.port = port
    } else if (arg === '--host') args.host = value(++i, arg)
    else if (arg === '--insecure') args.insecure = true
    else if (!arg.startsWith('-')) usageError(`Unknown command, and not a directory: ${arg}`)
    else usageError(`Unknown argument: ${arg}`)
  }
  if ((args.repoId !== undefined || args.repoName !== undefined) && args.command !== 'add') {
    usageError('--id and --name only apply to `add`')
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

function daemonVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const args = parseArgs(process.argv.slice(2))

if (args.command === 'help') {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.command === 'version') {
  console.log(daemonVersion())
  process.exit(0)
}

if (args.command === 'add') {
  try {
    const config = loadConfig(args.configPath)
    const root = resolveRepoRoot(args.repoPath ?? process.cwd())
    const { repo, added } = addRepo(config, root, { id: args.repoId, name: args.repoName })
    if (!added) {
      console.log(`${repo.path} is already configured as "${repo.id}".`)
      process.exit(0)
    }
    saveConfig(args.configPath, config)
    console.log(`Added ${repo.name} (id "${repo.id}") at ${repo.path}`)
    console.log(`Saved to ${args.configPath}. Restart a running daemon to pick it up.`)
    process.exit(0)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}

if (args.command === 'list') {
  console.log(formatRepoList(loadConfig(args.configPath).repos))
  process.exit(0)
}

if (args.command === 'remove') {
  const config = loadConfig(args.configPath)
  const target = args.repoPath ?? process.cwd()
  const removed = removeRepo(config, target)
  if (!removed) {
    console.error(`No configured repo matches "${target}". Run \`trek-daemon list\` to see them.`)
    process.exit(1)
  }
  saveConfig(args.configPath, config)
  console.log(`Removed ${removed.name} (id "${removed.id}") at ${removed.path}`)
  console.log('The repo itself is untouched. Restart a running daemon to pick it up.')
  process.exit(0)
}

if (args.command === 'token') {
  const config = loadConfig(args.configPath)
  const token = randomBytes(32).toString('base64url')
  config.tokenHash = hashToken(token)
  saveConfig(args.configPath, config)
  console.log('New token (shown once — configure it in the app now):\n')
  console.log(`  ${token}\n`)
  console.log(`Its hash was saved to ${args.configPath}; any previous token is now invalid.`)
  process.exit(0)
}

const config = loadConfig(args.configPath)
const host = args.host ?? config.host ?? '127.0.0.1'
const port = args.port ?? config.port ?? DEFAULT_DAEMON_PORT

if (!config.tokenHash) {
  console.error(`No token configured. Run \`trek-daemon token\` first (config: ${args.configPath}).`)
  process.exit(1)
}
if (config.repos.length === 0) {
  console.error(`No repos configured. Run \`trek-daemon add <path>\` (config: ${args.configPath}).`)
  process.exit(1)
}
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !args.insecure) {
  console.error(
    `Refusing to bind ${host} without TLS. Put a TLS-terminating reverse proxy (Caddy) in front\n` +
      'of the loopback listener, or pass --insecure if you really know what you are doing.'
  )
  process.exit(1)
}

const server = startServer(config, daemonVersion())
server.httpServer.listen(port, host, () => {
  console.log(`trek-daemon ${daemonVersion()} listening on ws://${host}:${port}`)
  console.log(`repos: ${config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down (all Claude sessions will end)`)
    server.shutdown(signal)
    process.exit(0)
  })
}
