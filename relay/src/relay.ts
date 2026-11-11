// Starts the relay's HTTP server on the config's host and port. TLS is the proxy's job (Caddy in
// front, as for trek-server); the relay speaks plain HTTP on its own address. Dead devices are
// pruned daily; close() writes the store's pending bookkeeping.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRelayHandler, type Provider } from './api.ts'
import type { RelayConfig } from './config.ts'
import type { Platform } from './store.ts'
import { RelayStore } from './store.ts'

const PRUNE_EVERY_MS = 24 * 3_600_000

export interface RunningRelay {
  server: Server
  port: number
  store: RelayStore
  close(): Promise<void>
}

export function startRelay(
  config: RelayConfig,
  providers: Partial<Record<Platform, Provider>>,
  log: (line: string) => void = (line) => console.log(line)
): Promise<RunningRelay> {
  const store = new RelayStore(config.dataDir, { maxDevices: config.maxDevices })
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    createRelayHandler({ store, providers, log, trustProxy: config.trustProxy, registrationKey: config.registrationKey })
  )
  const pruneTimer = setInterval(() => {
    try {
      const pruned = store.prune()
      if (pruned) log(`[relay] pruned ${pruned} device(s) dead for 30 days`)
    } catch (err) {
      log(`[relay] pruning failed: ${(err as Error).message}`)
    }
  }, PRUNE_EVERY_MS)
  pruneTimer.unref()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      resolve({
        server,
        port,
        store,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pruneTimer)
            server.close(() => {
              store.flush()
              done()
            })
            server.closeIdleConnections()
          })
      })
    })
  })
}
