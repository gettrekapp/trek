// scripts/bot-sandbox-linux.mjs — runs the bot's Linux (bwrap) sandbox check in a Docker container.
// Skips, and passes, when Docker isn't available.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const IMAGE = 'trek-bot-sandbox-linux'
const DOCKERFILE = `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 procps && rm -rf /var/lib/apt/lists/*
RUN useradd -m bot
`

const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
if (docker.error || docker.status !== 0) {
  console.log('SKIP: Docker is not available, so the Linux sandbox check did not run.')
  process.exit(0)
}
const built = spawnSync('docker', ['build', '-q', '-t', IMAGE, '-'], { input: DOCKERFILE, stdio: ['pipe', 'ignore', 'inherit'] })
if (built.status !== 0) {
  console.log('FAIL: could not build the test image')
  process.exit(1)
}
// User namespaces need these in Docker's default profile; bwrap runs as the unprivileged user `bot`.
const ran = spawnSync(
  'docker',
  [
    'run', '--rm', '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--security-opt', 'systempaths=unconfined',
    '-u', 'bot', '-v', `${resolve('.')}:/trek:ro`, '-w', '/trek', IMAGE,
    'node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/fixtures/bwrap-check.mjs'
  ],
  { stdio: 'inherit' }
)
process.exit(ran.status ?? 1)
