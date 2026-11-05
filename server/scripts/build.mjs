// Bundles the daemon (and the shared/host code it imports from ../src) into a
// single executable CommonJS file: dist/trek-server.cjs. Native and runtime
// dependencies stay external and resolve from node_modules at run time —
// node-pty from the repo root, ws from server/node_modules.
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = `${root}dist/trek-server.cjs`

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['node-pty', 'ws'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})

chmodSync(outfile, 0o755)
