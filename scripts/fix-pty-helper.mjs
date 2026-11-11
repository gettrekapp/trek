// scripts/fix-pty-helper.mjs — run by postinstall (scripts/postinstall.mjs).
//
// node-pty's prebuilt `spawn-helper` binaries can arrive from npm without their execute bit, and
// every pty spawned from plain Node (trek-server, the unit tests) then fails with
// "posix_spawnp failed". A locally compiled build/Release/spawn-helper is executable already;
// this makes the prebuilt ones executable too. No-op where they are missing (Windows, other layouts).
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty')
const dirs = [join(root, 'build', 'Release')]
const prebuilds = join(root, 'prebuilds')
if (existsSync(prebuilds)) for (const d of readdirSync(prebuilds)) dirs.push(join(prebuilds, d))

for (const dir of dirs) {
  const helper = join(dir, 'spawn-helper')
  if (!existsSync(helper)) continue
  const mode = statSync(helper).mode
  if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755)
}
