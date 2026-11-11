// Bundles the relay (and the shared push vocabulary it imports from ../src) into one executable
// CommonJS file, dist/trek-relay.cjs. It has no runtime dependencies: http, http2 and crypto are
// Node's own.
import { build } from 'esbuild'
import { chmodSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const outfile = `${root}dist/trek-relay.cjs`

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  define: { __TREK_RELAY_VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
chmodSync(outfile, 0o755)
console.log(`trek-relay ${version}`)
