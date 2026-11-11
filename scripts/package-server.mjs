// scripts/package-server.mjs — the trek-server release tarball for this machine's platform:
// trek-server-<version>-<os>-<arch>.tar.gz, run with a system Node >= 22.
//
//   npm run build:web && npm --prefix server run build     (server/dist: the .cjs, build.json, web-client)
//   node scripts/package-server.mjs [--out <dir>]          (default: dist-release/)
//   node scripts/server-tarball-smoke.mjs <tarball>        (unpacks it and runs it)
//
// The tarball holds one folder, trek-server-<version>-<os>-<arch>/:
//   bin/trek-server        sh launcher: checks Node >= 22, then runs trek-server.cjs (follows symlinks)
//   trek-server.cjs        the bundled server (everything but node-pty)
//   build.json             its version and build id
//   web-client/            the web client (`trek-server start --web`)
//   node_modules/node-pty  node-pty for this platform only: its lib/ and one native folder
//                          (pty.node, plus an executable spawn-helper on macOS: node-pty builds
//                          that helper for macOS only), compiled here on Linux, node-pty's own
//                          prebuild on macOS
//   package.json, README.md, trek-server.service
//
// node-pty is a Node-API addon, so the tarball works with any Node >= 22 on the same os/arch. It
// packages for the host only (node-pty must be built for the target); the release workflow runs it
// on a runner of each platform. node-pty's version is the one in the root package-lock.json, so the
// tarball runs what the app and the tests run. Installing it needs network access (npm) and, on
// Linux, python3, make and g++.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The launcher. POSIX sh; resolves its own symlinks so a link in ~/.local/bin finds the folder.
const LAUNCHER = `#!/bin/sh
# trek-server launcher: runs trek-server.cjs (beside this bin/ folder) with Node.js >= 22,
# the \`node\` on PATH unless TREK_NODE names one.
set -e
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")/.." && pwd)
node=\${TREK_NODE:-node}
if ! command -v "$node" >/dev/null 2>&1; then
  echo "trek-server: Node.js 22 or later is needed, and \\"$node\\" was not found (set TREK_NODE to a node binary)" >&2
  exit 127
fi
major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
# Anything but digits (not a Node, a wrapper printing more) counts as too old: \`[ -lt ]\` would
# fail on it and let it through.
case $major in ''|*[!0-9]*) major=0 ;; esac
if [ "$major" -lt 22 ]; then
  echo "trek-server: Node.js 22 or later is needed; $("$node" --version 2>/dev/null) is $(command -v "$node")" >&2
  exit 1
fi
exec "$node" "$here/trek-server.cjs" "$@"
`

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'server', 'dist')

function fail(message) {
  console.error(`package-server: ${message}`)
  process.exit(1)
}

const outAt = process.argv.indexOf('--out')
const out = resolve(outAt >= 0 ? (process.argv[outAt + 1] ?? fail('--out needs a directory')) : join(root, 'dist-release'))

const OS = { darwin: 'darwin', linux: 'linux' }[process.platform]
const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch]
if (!OS || !ARCH) fail(`no trek-server tarball for ${process.platform}-${process.arch} (darwin and linux, x64 and arm64 only)`)

for (const need of ['trek-server.cjs', 'build.json', 'web-client/index.html']) {
  if (!existsSync(join(dist, need))) fail(`server/dist/${need} is missing: run \`npm run build:web && npm --prefix server run build\` first`)
}
const { version, build } = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))
const serverPkg = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8'))
if (version !== serverPkg.version) fail(`server/dist was built as ${version}, but server/package.json is ${serverPkg.version}: rebuild it`)
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const ptyVersion = lock.packages?.['node_modules/node-pty']?.version
if (!ptyVersion) fail('node-pty is not in the root package-lock.json')

const name = `trek-server-${version}-${OS}-${ARCH}`
const stage = mkdtempSync(join(tmpdir(), 'trek-server-package-'))
const dir = join(stage, name)
try {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  for (const file of ['trek-server.cjs', 'build.json']) cpSync(join(dist, file), join(dir, file))
  chmodSync(join(dir, 'trek-server.cjs'), 0o755)
  cpSync(join(dist, 'web-client'), join(dir, 'web-client'), { recursive: true })
  cpSync(join(root, 'server', 'trek-server.service'), join(dir, 'trek-server.service'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'trek-server',
    version,
    description: serverPkg.description,
    private: true,
    bin: { 'trek-server': 'bin/trek-server' },
    engines: { node: '>=22' },
    os: [OS],
    cpu: [ARCH],
    dependencies: { 'node-pty': ptyVersion }
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'bin', 'trek-server'), LAUNCHER, { mode: 0o755 })
  writeFileSync(join(dir, 'README.md'), readme(name, version, build))

  // node-pty for this platform. A clean environment for npm: no build-from-source override left
  // over from the caller, no lockfile written.
  const env = { ...process.env }
  delete env.npm_config_build_from_source
  execFileSync('npm', ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'] })
  prunePty(join(dir, 'node_modules'))

  mkdirSync(out, { recursive: true })
  const tarball = join(out, `${name}.tar.gz`)
  rmSync(tarball, { force: true })
  // COPYFILE_DISABLE: macOS's tar would add ._ AppleDouble files for extended attributes.
  execFileSync('tar', ['-czf', tarball, '-C', stage, name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' })
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  console.log(`${tarball}\n  trek-server ${version} (build ${build}), node-pty ${ptyVersion}, ${(statSync(tarball).size / 1e6).toFixed(1)} MB, sha256 ${sha}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

/**
 * Keeps what node-pty loads at run time: package.json, LICENSE, lib/ (without its tests) and the
 * one native folder it would pick (lib/utils.js: build/Release, then prebuilds/<platform>-<arch>),
 * holding pty.node and spawn-helper. Drops its sources, other platforms' prebuilds and node-addon-api
 * (needed only to compile it).
 */
function prunePty(modules) {
  const pty = join(modules, 'node-pty')
  const release = join(pty, 'build', 'Release')
  const prebuilt = join(pty, 'prebuilds', `${process.platform}-${process.arch}`)
  const native = existsSync(join(release, 'pty.node')) ? release : existsSync(join(prebuilt, 'pty.node')) ? prebuilt : null
  if (!native) fail(`node-pty ${ptyVersion} has no pty.node in build/Release or prebuilds/${process.platform}-${process.arch}`)
  const keepNative = native === release ? 'build' : 'prebuilds'
  for (const entry of readdirSync(pty)) {
    if (['package.json', 'LICENSE', 'README.md', 'lib', keepNative].includes(entry)) continue
    rmSync(join(pty, entry), { recursive: true, force: true })
  }
  if (native === release) {
    for (const entry of readdirSync(join(pty, 'build'))) if (entry !== 'Release') rmSync(join(pty, 'build', entry), { recursive: true, force: true })
    for (const entry of readdirSync(release)) if (!['pty.node', 'spawn-helper'].includes(entry)) rmSync(join(release, entry), { recursive: true, force: true })
  } else {
    for (const entry of readdirSync(join(pty, 'prebuilds'))) if (join(pty, 'prebuilds', entry) !== prebuilt) rmSync(join(pty, 'prebuilds', entry), { recursive: true, force: true })
  }
  removeTests(join(pty, 'lib'))
  for (const entry of readdirSync(modules)) {
    if (entry !== 'node-pty' && !entry.startsWith('.')) rmSync(join(modules, entry), { recursive: true, force: true })
  }
  rmSync(join(modules, '.package-lock.json'), { force: true })
  // node-pty uses spawn-helper on macOS only (its binding.gyp builds it for OS=="mac"); Linux has none.
  const helper = join(native, 'spawn-helper')
  if (process.platform === 'darwin') {
    if (!existsSync(helper)) fail(`node-pty's ${helper} is missing`)
    // Prebuilt spawn-helpers can arrive without their execute bit (see scripts/fix-pty-helper.mjs).
    chmodSync(helper, 0o755)
  }
}

function removeTests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) removeTests(path)
    else if (/\.test\.js(\.map)?$/.test(entry.name)) rmSync(path)
  }
}

function readme(name, version, build) {
  return `# trek-server ${version}

The Trek server (build ${build}) for ${OS}-${ARCH}. Clients — the Trek desktop app, the web
client and the phone — connect to it; see the Trek repository's server/README.md for the full
guide (configuration, tokens, TLS, the web client).

## Requirements

- Node.js 22 or later on PATH (or set \`TREK_NODE\` to a node binary). Nothing is compiled:
  node-pty is included, built for ${OS}-${ARCH}.
- \`git\`, and the agent CLIs you use (\`claude\`, \`codex\`, …), installed and signed in as the
  user the server runs as.

## Run

\`\`\`sh
tar -xzf ${name}.tar.gz
mkdir -p ~/.local/bin && ln -sf "$PWD/${name}/bin/trek-server" ~/.local/bin/trek-server
trek-server --version
trek-server add ~/src/my-repo      # register a repository
trek-server token                  # create the token a client signs in with
trek-server start                  # serve (see --help for --host, --port, --web)
\`\`\`

\`trek-server.service\` is a systemd user unit: point its \`ExecStart\` at
\`${name}/bin/trek-server start\` (an absolute path) and drop its \`WorkingDirectory\`.

To upgrade, unpack the new version beside this one and move the symlink (and the unit's path);
the configuration and data live in ~/.config/trek-server and the data folder, not here.
${OS === 'darwin' ? `
On macOS, a tarball downloaded with a browser is quarantined, and so is what it unpacks; the
native files here are not notarized, so clear the flag (or download with curl):
\`xattr -dr com.apple.quarantine ${name}\`.
` : ''}`
}
