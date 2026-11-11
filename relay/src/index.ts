// trek-relay's CLI: `trek-relay start --config <file> [--host <h>] [--port <p>]`, `trek-relay version`.
import { loadRelayConfig } from './config.ts'
import { createProviders } from './providers.ts'
import { startRelay } from './relay.ts'

declare const __TREK_RELAY_VERSION__: string | undefined
const VERSION = typeof __TREK_RELAY_VERSION__ === 'string' ? __TREK_RELAY_VERSION__ : 'dev'

function usage(message?: string): never {
  if (message) console.error(message)
  console.error('usage: trek-relay start --config <file> [--host <host>] [--port <port>]\n       trek-relay version')
  process.exit(2)
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === 'version' || command === '--version') {
    console.log(`trek-relay ${VERSION}`)
    return
  }
  if (command !== 'start') usage(command ? `unknown command: ${command}` : undefined)
  let configPath: string | undefined
  let host: string | undefined
  let port: number | undefined
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--config' && value) configPath = value
    else if (flag === '--host' && value) host = value
    else if (flag === '--port' && value) port = Number(value)
    else usage(`unknown or incomplete option: ${flag}`)
    i += 1
  }
  if (!configPath) usage('--config is required')
  const config = loadRelayConfig(configPath)
  if (host !== undefined) config.host = host
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) usage('--port must be 0–65535')
    config.port = port
  }
  const providers = createProviders(config)
  if (!providers.ios && !providers.android) console.warn('[relay] neither apns nor fcm is configured: every registration will be refused')
  const relay = await startRelay(config, providers)
  console.log(`[relay] trek-relay ${VERSION} listening on http://${config.host}:${relay.port} (put your TLS proxy in front)`)
  const stop = (): void => {
    void relay.close().then(() => {
      for (const p of Object.values(providers)) p?.close?.()
      process.exit(0)
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`trek-relay: ${(err as Error).message}`)
  process.exit(1)
})
