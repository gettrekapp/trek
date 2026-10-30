import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
import { defaultConfigPath, loadConfig, saveConfig } from './config'
import { hashToken, startServer } from './server'

interface CliArgs {
  command: 'start' | 'token'
  configPath: string
  port?: number
  host?: string
  insecure: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'start', configPath: defaultConfigPath(), insecure: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'start' || arg === 'token') args.command = arg
    else if (arg === '--config') args.configPath = argv[++i]
    else if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--host') args.host = argv[++i]
    else if (arg === '--insecure') args.insecure = true
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
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
  console.error(`No token configured. Run \`npm run token\` first (config: ${args.configPath}).`)
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
