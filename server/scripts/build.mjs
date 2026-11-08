// Bundles the server (and the shared/host code it imports from ../src) into a
// single executable CommonJS file: dist/trek-server.cjs. Everything is bundled
// except node-pty, which is native and resolves from node_modules at run time
// (the repo root's, or the app's unpacked copy), and ws's optional native
// helpers, which ws loads only if they are installed. The version and a build
// id (a hash of the bundle) are baked in, and also written to dist/build.json.
import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BUILD_PLACEHOLDER, stampBuild } from './buildStamp.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = `${root}dist/trek-server.cjs`
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

const result = await build({
  entryPoints: [`${root}src/index.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  define: {
    __TREK_SERVER_VERSION__: JSON.stringify(version),
    __TREK_SERVER_BUILD__: JSON.stringify(BUILD_PLACEHOLDER)
  },
  banner: { js: '#!/usr/bin/env node' },
  write: false,
  logLevel: 'info'
})

const { text, build: buildId } = stampBuild(result.outputFiles[0].text)
mkdirSync(`${root}dist`, { recursive: true })
writeFileSync(outfile, text)
chmodSync(outfile, 0o755)
writeFileSync(`${root}dist/build.json`, JSON.stringify({ version, build: buildId }) + '\n')
console.log(`trek-server ${version}, build ${buildId}`)
