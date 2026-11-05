import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
import { defaultConfigPath, loadConfig, saveConfig } from './config'
import { hashToken, startServer } from './server'

interface CliArgs {
  command: 'start' | 'token' | 'help' | 'version'
  configPath: string
  port?: number
  host?: string
  insecure: boolean
}

const USAGE = `Usage: trek-daemon [command] [options]

Commands:
  start            Run the daemon (default)
  token            Generate a new access token, replacing any previous one
  help             Show this help
  version          Print the daemon version

Options:
  --config <path>  Config file (default: ${defaultConfigPath()})
  --port <port>    Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
  --host <host>    Interface to bind (default: config.host or 127.0.0.1)
  --insecure       Allow binding a non-loopback host without TLS
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'start' || arg === 'token' || arg === 'help' || arg === 'version') args.command = arg
    else if (arg === '-h' || arg === '--help') args.command = 'help'
    else if (arg === '-v' || arg === '--version') args.command = 'version'
    else if (arg === '--config') args.configPath = value(++i, arg)
    else if (arg === '--port') {
      const port = Number(value(++i, arg))
      if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`Invalid port: ${argv[i]}`)
      args.port = port
    } else if (arg === '--host') args.host = value(++i, arg)
    else if (arg === '--insecure') args.insecure = true
    else usageError(`Unknown argument: ${arg}`)
  }
  return args
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
  console.error(`No repos configured. Add repos to ${args.configPath}:`)
  console.error('  { "repos": [{ "id": "trek", "name": "Trek", "path": "/home/dev/repos/Trek" }] }')
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
