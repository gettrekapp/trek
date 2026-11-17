// Publishes an over-the-air update to a channel: `node scripts/publish-update.mjs <preview|production> [eas update flags…]`
// (npm run update:preview / update:production). The update reaches only builds whose native
// fingerprint matches the one computed here, and the fingerprint includes the config
// app.config.js resolves, so this sets and checks what the EAS builds see:
// - TREK_APNS_MODE=production, which the preview and production builds get from eas.json's
//   build `env` (eas update doesn't read that), and app.config.js turns into the
//   expo-notifications plugin's mode.
// - No local google-services.json, GOOGLE_SERVICES_JSON or TREK_RELAY_* from the shell: the
//   builds get those only from the EAS environment (--environment brings its plain and sensitive
//   variables here; a secret one, or a file the builds don't have, changes the fingerprint).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const [channel, ...rest] = process.argv.slice(2)
if (channel !== 'preview' && channel !== 'production') {
  console.error('Usage: node scripts/publish-update.mjs <preview|production> --message "What changed"')
  process.exit(2)
}

const problems = []
if (existsSync(join(app, 'google-services.json'))) problems.push('apps/mobile/google-services.json exists: the EAS builds don\'t have it (it is git-ignored). Move it aside while publishing.')
for (const name of ['GOOGLE_SERVICES_JSON', 'TREK_RELAY_URL', 'TREK_RELAY_KEY']) {
  if (process.env[name] !== undefined) problems.push(`${name} is set in this shell: the builds take it from the EAS environment only. Unset it while publishing.`)
}
if (problems.length > 0) {
  console.error('Not publishing: this update would not match the builds\' fingerprint, so no phone would get it.')
  for (const p of problems) console.error(`- ${p}`)
  process.exit(1)
}

const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { cwd: app, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(process.execPath, ['scripts/build-terminal.mjs'])
run('npx', ['eas-cli@27.10.0', 'update', '--channel', channel, '--environment', channel, ...rest], { TREK_APNS_MODE: 'production' })
