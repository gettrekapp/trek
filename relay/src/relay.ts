// Starts the relay's HTTP server on the config's host and port. TLS is the proxy's job (Caddy in
// front, as for trek-server); the relay speaks plain HTTP on its own address.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRelayHandler, type Provider } from './api.ts'
import type { RelayConfig } from './config.ts'
import type { Platform } from './store.ts'
import { RelayStore } from './store.ts'

export interface RunningRelay {
  server: Server
  port: number
  close(): Promise<void>
}

export function startRelay(
  config: RelayConfig,
  providers: Partial<Record<Platform, Provider>>,
  log: (line: string) => void = (line) => console.log(line)
): Promise<RunningRelay> {
  const store = new RelayStore(config.dataDir)
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, createRelayHandler({ store, providers, log }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      resolve({
        server,
        port,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}
