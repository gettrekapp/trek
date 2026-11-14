// Bundles the server (and the shared/host code it imports from ../src) into a
// single executable CommonJS file: dist/trek-server.cjs. Everything is bundled
// except node-pty, which is native and resolves from node_modules at run time
// (the repo root's, or the app's unpacked copy), and ws's optional native
// helpers, which ws loads only if they are installed. The version and a build
// id (a hash of the bundle) are baked in, and also written to dist/build.json.
import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_PLACEHOLDER, stampBuild } from './buildStamp.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outAt = process.argv.indexOf('--out')
const outArg = outAt >= 0 ? process.argv[outAt + 1] : undefined
if (outAt >= 0 && (!outArg || outArg.startsWith('--'))) {
  console.error('build: --out needs a directory')
  process.exit(1)
}
const outDir = outArg ? resolve(outArg) : join(root, 'dist')
const outfile = join(outDir, 'trek-server.cjs')
// A build for the update tests: it takes its feed and key from the environment, and may claim
// any version. Only ever into --out: server/dist is what the app and the release package.
const testUpdate = process.env.TREK_SERVER_TEST_UPDATE === '1'
if (testUpdate && (outAt < 0 || outDir === join(root, 'dist'))) {
  console.error('build: TREK_SERVER_TEST_UPDATE=1 needs --out <dir>, and not server/dist: a test build is never written to server/dist')
  process.exit(1)
}
if (!testUpdate && process.env.TREK_SERVER_TEST_VERSION) {
  console.error('build: TREK_SERVER_TEST_VERSION only applies with TREK_SERVER_TEST_UPDATE=1')
  process.exit(1)
}
const version = (testUpdate && process.env.TREK_SERVER_TEST_VERSION) || JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version

const result = await build({
  // The paths esbuild writes into the bundle are relative to this, so the build id is the same from any cwd.
  absWorkingDir: root,
  entryPoints: [`${root}src/index.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  define: {
    __TREK_SERVER_VERSION__: JSON.stringify(version),
    __TREK_SERVER_BUILD__: JSON.stringify(BUILD_PLACEHOLDER),
    __TREK_SERVER_TEST_UPDATE__: JSON.stringify(testUpdate)
  },
  // The test build's line also gives it a build id no release build has (the id is a hash of this text).
  banner: { js: testUpdate ? '#!/usr/bin/env node\n// A test build of trek-server (TREK_SERVER_TEST_UPDATE): not for release.' : '#!/usr/bin/env node' },
  // sessions/nativePty.ts reads import.meta.url only where `require` is missing (never in this bundle).
  logOverride: { 'empty-import-meta': 'silent' },
  write: false,
  logLevel: 'info'
})

const { text, build: buildId } = stampBuild(result.outputFiles[0].text)
mkdirSync(outDir, { recursive: true })
writeFileSync(outfile, text)
chmodSync(outfile, 0o755)
writeFileSync(join(outDir, 'build.json'), JSON.stringify({ version, build: buildId, ...(testUpdate ? { testUpdate: true } : {}) }) + '\n')
console.log(`trek-server ${version}, build ${buildId}${testUpdate ? ' (a test build: not for release)' : ''}`)
