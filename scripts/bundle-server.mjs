// Copies the built server (server/dist: trek-server.cjs and build.json, from
// `npm --prefix server run build`) into out/server, where the app's supervisor
// (src/main/localServer.ts) runs it with Electron's Node. out/server ships inside
// app.asar with the rest of out/: Electron's Node reads the script from the asar,
// and node-pty resolves to the app's copy, which asarUnpack leaves unpacked.
// Fails if the server has not been built, rather than shipping a stale copy.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const from = `${root}server/dist`
const to = `${root}out/server`
const FILES = ['trek-server.cjs', 'build.json']

for (const name of FILES) {
  if (!existsSync(`${from}/${name}`)) {
    console.error(`bundle-server: ${from}/${name} is missing; run npm --prefix server run build first`)
    process.exit(1)
  }
}
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const name of FILES) copyFileSync(`${from}/${name}`, `${to}/${name}`)
const { version, build } = JSON.parse(readFileSync(`${to}/build.json`, 'utf8'))
console.log(`out/server: trek-server ${version}, build ${build}`)
