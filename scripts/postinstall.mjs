// scripts/postinstall.mjs — the root package's postinstall.
//
// Makes node-pty's prebuilt spawn-helpers executable (scripts/fix-pty-helper.mjs), then installs
// trek-server (server/) and trek-relay (relay/), each from its own package-lock.json. Under a root
// `npm ci` (npm sets npm_command=ci for the scripts it runs) they get `npm ci` too: their lockfiles
// are enforced and a lockfile out of step with its package.json fails the install, as the root's
// does. Under `npm install` they get `npm install`, which may update their lockfiles.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await import('./fix-pty-helper.mjs')

const command = process.env.npm_command === 'ci' ? 'ci' : 'install'
// The npm that runs this script (npm_execpath), not whichever is first on PATH.
const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm']
for (const dir of ['server', 'relay']) {
  console.log(`postinstall: npm ${command} in ${dir}/`)
  execFileSync(npm[0], [...npm.slice(1), command, '--no-audit', '--no-fund'], { cwd: join(root, dir), stdio: 'inherit' })
}
