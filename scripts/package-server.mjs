// scripts/package-server.mjs — the trek-server release tarball for this machine's platform:
// trek-server-<version>-<os>-<arch>.tar.gz (a .zip on Windows), run with a system Node >= 22.
//
//   npm run build:web && npm --prefix server run build     (server/dist: the .cjs, build.json, web-client)
//   node scripts/package-server.mjs [--out <dir>] [--sign <identity> | --sign-azure]   (default: dist-release/)
//   node scripts/server-tarball-smoke.mjs <tarball>        (unpacks it and runs it)
//
// The tarball holds one folder, trek-server-<version>-<os>-<arch>/:
//   bin/trek-server        sh launcher: checks Node >= 22, then runs trek-server.cjs (follows symlinks)
//                          (Windows: bin\trek-server.cmd, the same checks in a batch file, and
//                          bin\trek-server.ps1, in PowerShell, which Ctrl+C does not ask about)
//   trek-server.cjs        the bundled server (everything but node-pty)
//   build.json             its version and build id, and what `trek-server update` reads:
//                          package "tarball" and target "<os>-<arch>"
//   web-client/            the web client (`trek-server start --web`)
//   node_modules/node-pty  node-pty for this platform only: its lib/ and one native folder
//                          (pty.node, plus an executable spawn-helper on macOS: node-pty builds
//                          that helper for macOS only), compiled here on Linux, node-pty's own
//                          prebuild on macOS and Windows (there: ConPTY's conpty.node,
//                          conpty_console_list.node and conpty/, and winpty's files for Windows
//                          builds before 18309, which have no ConPTY)
//   package.json, README.md, trek-server.service (not on Windows)
//
// node-pty is a Node-API addon, so the tarball works with any Node >= 22 on the same os/arch. It
// packages for the host only (node-pty must be built for the target); the release workflow runs it
// on a runner of each platform. node-pty's version is the one in the root package-lock.json, so the
// tarball runs what the app and the tests run. Installing it needs network access (npm) and, on
// Linux, python3, make and g++.
//
// --sign (macOS): signs node-pty's pty.node and spawn-helper with that codesign identity (a
// Developer ID Application one), the hardened runtime and a secure timestamp, from the keychain
// CSC_KEYCHAIN names when it is set. macOS refuses to load a quarantined native module (any file
// unpacked from a browser download) unless it is signed and notarized; the release workflow
// notarizes the signed files after this (see docs/RELEASING.md). Unsigned, node-pty keeps the
// ad-hoc signature its linker gave it, which runs only when not quarantined.
//
// --sign-azure (Windows): signs bin\trek-server.ps1 with Azure Trusted Signing before zipping, as
// electron-builder signs the app (the TrustedSigning PowerShell module's Invoke-TrustedSigning,
// SHA256, Microsoft's RFC 3161 timestamp), then checks Get-AuthenticodeSignature says Valid (and,
// when AZURE_SIGNING_PUBLISHER is set, that the signer's subject names it). It reads the account
// from AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE, and the module signs
// in with AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET. The .cmd launcher cannot carry
// a signature, and node-pty's prebuilt .node, .dll and .exe files are left as
// node-pty ships them.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POSIX_LAUNCHER, WIN_LAUNCHER, WIN_PS_LAUNCHER } from './serverLaunchers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'server', 'dist')

/**
 * tar's flags that record every entry as root's (0:0, no names) rather than the runner's user:
 * the tarball says nothing about the machine that built it, and unpacked as root without
 * --no-same-owner its files are not some local user's who happens to have the runner's id.
 * GNU tar (the Linux runners) and bsdtar (macOS) spell them differently.
 */
function rootOwned() {
  const bsd = /bsdtar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }))
  return bsd ? ['--uid', '0', '--gid', '0', '--numeric-owner'] : ['--owner=0', '--group=0', '--numeric-owner']
}

function fail(message) {
  console.error(`package-server: ${message}`)
  process.exit(1)
}

const outAt = process.argv.indexOf('--out')
const out = resolve(outAt >= 0 ? (process.argv[outAt + 1] ?? fail('--out needs a directory')) : join(root, 'dist-release'))
const signAt = process.argv.indexOf('--sign')
const signIdentity = signAt >= 0 ? (process.argv[signAt + 1] ?? fail('--sign needs a codesign identity')) : undefined
if (signIdentity !== undefined && process.platform !== 'darwin') fail('--sign is for macOS only')
const signAzure = process.argv.includes('--sign-azure')
if (signAzure && process.platform !== 'win32') fail('--sign-azure is for Windows only')
const AZURE_ENV = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE']
if (signAzure) {
  const missing = AZURE_ENV.filter(name => !process.env[name])
  if (missing.length) fail(`--sign-azure needs ${missing.join(', ')}`)
}

const OS = { darwin: 'darwin', linux: 'linux', win32: 'win32' }[process.platform]
const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch]
if (!OS || !ARCH) fail(`no trek-server tarball for ${process.platform}-${process.arch} (darwin and linux, x64 and arm64; win32 x64)`)
const WINDOWS = OS === 'win32'
if (WINDOWS && ARCH !== 'x64') fail('Windows: x64 only (node-pty has no tested arm64 build here)')

for (const need of ['trek-server.cjs', 'build.json', 'web-client/index.html']) {
  if (!existsSync(join(dist, need))) fail(`server/dist/${need} is missing: run \`npm run build:web && npm --prefix server run build\` first`)
}
const built = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))
const { version, build } = built
if (built.testUpdate) fail('server/dist holds a test build (TREK_SERVER_TEST_UPDATE): rebuild it with `npm --prefix server run build`')
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
  cpSync(join(dist, 'trek-server.cjs'), join(dir, 'trek-server.cjs'))
  // What `trek-server update` reads: this folder came from a release tarball, for this target.
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ version, build, package: 'tarball', target: `${OS}-${ARCH}` }) + '\n')
  chmodSync(join(dir, 'trek-server.cjs'), 0o755)
  cpSync(join(dist, 'web-client'), join(dir, 'web-client'), { recursive: true })
  // A systemd unit: Linux (and macOS, for the docs); Windows has none.
  if (!WINDOWS) cpSync(join(root, 'server', 'trek-server.service'), join(dir, 'trek-server.service'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'trek-server',
    version,
    description: serverPkg.description,
    private: true,
    bin: { 'trek-server': WINDOWS ? 'bin/trek-server.cmd' : 'bin/trek-server' },
    engines: { node: '>=22' },
    os: [OS],
    cpu: [ARCH],
    dependencies: { 'node-pty': ptyVersion }
  }, null, 2) + '\n')
  if (WINDOWS) {
    writeFileSync(join(dir, 'bin', 'trek-server.cmd'), WIN_LAUNCHER)
    writeFileSync(join(dir, 'bin', 'trek-server.ps1'), WIN_PS_LAUNCHER)
    if (signAzure) signScript(join(dir, 'bin', 'trek-server.ps1'))
  }
  else writeFileSync(join(dir, 'bin', 'trek-server'), POSIX_LAUNCHER, { mode: 0o755 })
  writeFileSync(join(dir, 'README.md'), readme(name, version, build))

  // node-pty for this platform. A clean environment for npm: no build-from-source override left
  // over from the caller, no lockfile written.
  const env = { ...process.env }
  delete env.npm_config_build_from_source
  // npm is npm.cmd on Windows, which Node runs only through a shell (its fixed arguments need no quoting).
  execFileSync(WINDOWS ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: WINDOWS
  })
  const native = prunePty(join(dir, 'node_modules'))
  if (signIdentity !== undefined) sign(native, signIdentity)

  mkdirSync(out, { recursive: true })
  const tarball = join(out, WINDOWS ? `${name}.zip` : `${name}.tar.gz`)
  rmSync(tarball, { force: true })
  // Windows: its own tar (System32's bsdtar), which writes a zip for a .zip name (-a), what
  // Explorer unpacks. By full path: under Git Bash (the workflows' shell) a bare `tar` is GNU tar,
  // which writes no zip and reads C:\ as a remote host.
  // COPYFILE_DISABLE: macOS's tar would add ._ AppleDouble files for extended attributes.
  if (WINDOWS) execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', tarball, '-C', stage, name], { stdio: 'inherit' })
  else execFileSync('tar', [...rootOwned(), '-czf', tarball, '-C', stage, name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' })
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  console.log(`${tarball}\n  trek-server ${version} (build ${build}), node-pty ${ptyVersion}, ${(statSync(tarball).size / 1e6).toFixed(1)} MB, sha256 ${sha}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

/**
 * Keeps what node-pty loads at run time: package.json, LICENSE, lib/ (without its tests) and the
 * one native folder it would pick (lib/utils.js: build/Release, then prebuilds/<platform>-<arch>),
 * holding pty.node and spawn-helper. Drops its sources, other platforms' prebuilds and node-addon-api
 * (needed only to compile it). Returns that native folder.
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
    for (const entry of readdirSync(release)) if (!keepNativeFile(entry)) rmSync(join(release, entry), { recursive: true, force: true })
  } else {
    // Windows: the prebuild holds ConPTY's and winpty's files; only the debug symbols go.
    if (WINDOWS) for (const entry of readdirSync(prebuilt)) if (!keepNativeFile(entry)) rmSync(join(prebuilt, entry), { recursive: true, force: true })
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
  return native
}

/**
 * A file of node-pty's native folder that is loaded at run time: pty.node and spawn-helper; on
 * Windows also ConPTY (conpty.node, conpty_console_list.node, conpty/ with OpenConsole.exe and
 * conpty.dll) and winpty (winpty.dll, winpty-agent.exe, used before build 18309).
 */
function keepNativeFile(entry) {
  if (['pty.node', 'spawn-helper'].includes(entry)) return true
  return WINDOWS && ['conpty.node', 'conpty_console_list.node', 'conpty', 'winpty.dll', 'winpty-agent.exe'].includes(entry)
}

/** codesign pty.node and spawn-helper: the identity, the hardened runtime, a secure timestamp. */
function sign(native, identity) {
  const keychain = process.env.CSC_KEYCHAIN ? ['--keychain', process.env.CSC_KEYCHAIN] : []
  for (const file of ['pty.node', 'spawn-helper']) {
    const path = join(native, file)
    execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, ...keychain, path], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', path], { stdio: 'inherit' })
  }
}

/**
 * Invoke-TrustedSigning on one file, with the parameters electron-builder passes it
 * (app-builder-lib's windowsSignAzureManager), then Get-AuthenticodeSignature on it. The values
 * travel in the environment, so nothing is quoted into the command.
 */
function signScript(file) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // As electron-builder: NuGet may already be there (the GitHub runners have it).
    'try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null } catch { }',
    'Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser',
    'Invoke-TrustedSigning -Endpoint $env:AZURE_SIGNING_ENDPOINT -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT -CertificateProfileName $env:AZURE_SIGNING_PROFILE -Files $env:TREK_SIGN_FILE -FileDigest SHA256 -TimestampRfc3161 http://timestamp.acs.microsoft.com -TimestampDigest SHA256',
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:TREK_SIGN_FILE',
    '$subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(none)" }',
    'Write-Output "$($sig.Status) $env:TREK_SIGN_FILE [$subject]"',
    'if ($sig.Status -ne "Valid") { Write-Error "not validly signed: $($sig.StatusMessage)" }',
    'if ($env:AZURE_SIGNING_PUBLISHER -and -not $subject.Contains($env:AZURE_SIGNING_PUBLISHER)) { Write-Error "not signed by $env:AZURE_SIGNING_PUBLISHER" }'
  ].join('\n')
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, TREK_SIGN_FILE: file }, stdio: 'inherit' })
  } catch {
    fail(`signing ${file} failed (see above)`)
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
${WINDOWS ? windowsRun(name) : ''}${WINDOWS ? '' : `
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

To update, run \`trek-server update\` (\`trek-server update --check\` only looks): it installs the
latest release in this folder's place, after checking its signature and that it runs here, and a
running server restarts into it. This folder keeps its path and its name, so the symlink and the
unit's path keep working; \`trek-server version\` says which version is in it. The version before
is kept beside it as \`${name}.previous\`. The configuration and data live in
~/.config/trek-server and the data folder, not here.
`}${OS !== 'darwin' ? '' : signIdentity !== undefined ? `
On macOS, a tarball downloaded with a browser is quarantined, and so is what it unpacks. node-pty's
native files here are signed and notarized, so macOS loads them anyway (it checks the notarization
online the first time). If it still refuses (\`trek-server start\` then says "macOS refused to load
it"), clear the flag: \`xattr -dr com.apple.quarantine ${name}\`.
` : `
On macOS, a tarball downloaded with a browser is quarantined, and so is what it unpacks; the
native files here are not notarized, so clear the flag (or download with curl):
\`xattr -dr com.apple.quarantine ${name}\`.
`}`
}

/** The README's Run section on Windows. */
function windowsRun(name) {
  return [
    '',
    `Unzip it (Explorer's Extract All, or \`tar -xf ${name}.zip\`), then in PowerShell or cmd:`,
    '',
    '```bat',
    `${name}\\bin\\trek-server --version`,
    `${name}\\bin\\trek-server add C:\\src\\my-repo`,
    `${name}\\bin\\trek-server token`,
    `${name}\\bin\\trek-server start`,
    '```',
    '',
    `\`add\` registers a repository, \`token\` creates the token a client signs in with, and \`start\``,
    'serves (see `--help` for `--host`, `--port`, `--web`). Put the `bin` folder on PATH to run',
    '`trek-server` from anywhere. Ctrl+C in its console stops it.',
    '',
    'There are two launchers: `bin\\trek-server.cmd` (what `trek-server` runs in cmd and PowerShell) and',
    '`bin\\trek-server.ps1`. cmd asks "Terminate batch job (Y/N)?" on Ctrl+C with the .cmd one (answer Y);',
    'the PowerShell one does not:',
    '',
    '```powershell',
    `powershell -NoProfile -ExecutionPolicy Bypass -File ${name}\\bin\\trek-server.ps1 start`,
    '```',
    '',
    signAzure
      ? "The .ps1 is signed, but PowerShell's execution policy may still refuse a script from a download:"
      : 'Until the scripts are signed, Windows may refuse to run the .ps1 (an unsigned script from a download):',
    'pass `-ExecutionPolicy Bypass` as above, or run `Get-ChildItem -Recurse <folder> | Unblock-File` once.',
    '',
    'The launchers run the `node` on PATH, and cmd looks in the current directory first: start',
    '`trek-server.cmd` from a directory you trust (not a repository), or set `TREK_NODE` to the full',
    'path of `node.exe`.',
    '',
    'The configuration lives in %APPDATA%\\trek-server and the projects in %LOCALAPPDATA%\\trek-server,',
    'not here, so an upgrade is a new folder beside this one. Environments and dev stacks are not',
    "available on Windows yet; see the Trek repository's docs/WINDOWS.md.",
    ''
  ].join('\n')
}
