// Where the web client's build is: `web-client` beside the bundled server
// (server/dist/web-client, written by the Trek repo's `npm run build:web`), or,
// run from source (tsx src/index.ts), the same dist directory.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** The first candidate holding an index.html, or undefined when the client is not built. */
export function webClientDir(serverDir: string): string | undefined {
  const candidates = [resolve(serverDir, 'web-client'), resolve(serverDir, '..', 'dist', 'web-client')]
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html')))
}
