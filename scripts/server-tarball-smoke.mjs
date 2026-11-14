// scripts/server-tarball-smoke.mjs — checks a trek-server release tarball (scripts/package-server.mjs)
// the way a user runs it: unpacked into a temp folder, through bin/trek-server with the node on PATH,
// in a temp HOME. Checks: the layout, spawn-helper executable, `--version` matching the tarball's
// name and build.json, a pty from its own node-pty, the launcher through a symlink, a `start` that
// listens on loopback and answers a WebSocket upgrade, and SIGTERM stopping it.
//
//   node scripts/server-tarball-smoke.mjs [--notarized] dist-release/trek-server-<version>-<os>-<arch>.tar.gz
//   node scripts/server-tarball-smoke.mjs dist-release/trek-server-<version>-win32-x64.zip   (on Windows)
//
// On Windows: bin\trek-server.cmd (run through cmd.exe) and bin\trek-server.ps1 (powershell.exe), ConPTY's files in node-pty, a pty running
// cmd.exe, no symlink check, and taskkill instead of SIGTERM (Windows has no signals).
//
// --notarized (macOS, the release's signed and notarized tarball): pty.node and spawn-helper carry
// a Developer ID Application signature with the hardened runtime, and the tarball is quarantined
// before it is unpacked, as a browser download is (tar passes the flag on to every file), so the
// pty check below is Gatekeeper's: macOS loads a quarantined native module only if it is notarized.
import './smokeGh.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const notarized = args.includes('--notarized')
const positional = args.filter((a) => a !== '--notarized')
const tarball = positional.length === 1 && resolve(positional[0])
const named = tarball && basename(tarball).match(/^trek-server-(.+)-(?:(darwin|linux)-(x64|arm64)\.tar\.gz|(win32)-(x64)\.zip)$/)
if (!named || !existsSync(tarball)) {
  console.error('usage: node scripts/server-tarball-smoke.mjs [--notarized] <path>/trek-server-<version>-<os>-<arch>.tar.gz (or -win32-x64.zip)')
  process.exit(2)
}
const windows = named[4] === 'win32'
const version = named[1]
const os = named[2] ?? named[4]
const arch = named[3] ?? named[5]
if (notarized && os !== 'darwin') {
  console.error('--notarized is for the macOS tarballs')
  process.exit(2)
}

let failed = false
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}${ok || !detail ? '' : `\n  ${detail}`}`)
  if (!ok) failed = true
}

const work = mkdtempSync(join(tmpdir(), 'trek-server-tarball-'))
const children = new Set()
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL')
  rmSync(work, { recursive: true, force: true })
})

let unpackFrom = tarball
if (notarized) {
  // What Safari writes: 0083 (quarantined, downloaded), a hex timestamp, the agent.
  unpackFrom = join(work, basename(tarball))
  copyFileSync(tarball, unpackFrom)
  execFileSync('xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, unpackFrom])
}
// Windows' own tar (System32's bsdtar) unpacks a zip; by full path, as under Git Bash a bare `tar`
// is GNU tar, which can't read a zip and reads C:\ as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, [windows ? '-xf' : '-xzf', unpackFrom, '-C', work])
if (unpackFrom !== tarball) rmSync(unpackFrom)
const top = readdirSync(work)
const name = `trek-server-${version}-${os}-${arch}`
check('the tarball holds one folder named after it', top.length === 1 && top[0] === name, JSON.stringify(top))
const dir = join(work, name)

check(`it is for this machine (${process.platform}-${process.arch})`, os === process.platform && arch === process.arch, `${os}-${arch}`)
const launcherFile = windows ? 'bin/trek-server.cmd' : 'bin/trek-server'
for (const file of [launcherFile, 'trek-server.cjs', 'build.json', 'package.json', 'README.md', ...(windows ? ['bin/trek-server.ps1'] : ['trek-server.service']), 'web-client/index.html', 'node_modules/node-pty/package.json']) {
  check(`${file} is there`, existsSync(join(dir, file)))
}
if (windows) {
  const native = join(dir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
  for (const file of ['conpty.node', 'conpty_console_list.node', 'conpty/OpenConsole.exe', 'conpty/conpty.dll', 'pty.node', 'winpty.dll', 'winpty-agent.exe']) {
    check(`node-pty's ${file} is there (ConPTY, and winpty for older Windows)`, existsSync(join(native, file)))
  }
  check('no debug symbols (.pdb)', readdirSync(native).every((f) => !f.endsWith('.pdb')), readdirSync(native).join(' '))
}
const helpers = ['build/Release', `prebuilds/${os}-${arch}`].map((d) => join(dir, 'node_modules', 'node-pty', d, 'spawn-helper')).filter((p) => existsSync(p))
if (os === 'darwin') check('node-pty has exactly one spawn-helper, executable', helpers.length === 1 && (statSync(helpers[0]).mode & 0o111) === 0o111, JSON.stringify(helpers))
else check('node-pty has no spawn-helper (node-pty uses it on macOS only)', helpers.length === 0, JSON.stringify(helpers))
if (notarized) {
  for (const file of helpers.length === 1 ? [join(helpers[0], '..', 'pty.node'), helpers[0]] : []) {
    const short = file.slice(dir.length + 1)
    const xattr = spawnSync('xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf8' })
    check(`${short} is quarantined, as an unpacked download is`, xattr.status === 0 && xattr.stdout.trim() !== '', xattr.stderr)
    const sig = spawnSync('codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' }).stderr
    check(`${short} is signed with a Developer ID Application certificate`, /^Authority=Developer ID Application/m.test(sig), sig)
    check(`${short} is signed with the hardened runtime and a timestamp`, /flags=.*runtime/.test(sig) && /^Timestamp=/m.test(sig), sig)
  }
}
if (!windows) check('bin/trek-server is executable', (statSync(join(dir, 'bin', 'trek-server')).mode & 0o111) === 0o111)
check('node_modules holds node-pty only', readdirSync(join(dir, 'node_modules')).filter((e) => !e.startsWith('.')).join() === 'node-pty')

const home = join(work, 'home')
mkdirSync(home)
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
const launcher = join(dir, ...launcherFile.split('/'))
// A batch file runs only through cmd.exe (Node refuses to start one without a shell).
const viaLauncher = (argv) =>
  windows ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[`"${launcher}"`, ...argv].join(' ')}"`], opts: { windowsVerbatimArguments: true } } : { file: launcher, args: argv, opts: {} }
const runLauncher = (argv) => {
  const { file, args: a, opts } = viaLauncher(argv)
  return execFileSync(file, a, { ...opts, env, encoding: 'utf8' })
}

const build = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
const printed = runLauncher(['--version']).trim()
check(`--version prints ${version}`, printed === version && build.version === version, `printed ${printed}, build.json ${build.version}`)

// The PowerShell launcher (Windows only; runs there, not on this Mac or Linux).
if (windows) {
  const ps = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'bin', 'trek-server.ps1'), 'version'], { env, encoding: 'utf8' }).trim()
  check(`bin\\trek-server.ps1 version prints ${version}`, ps === version, ps)
}

// The launcher from a symlink elsewhere, as a link in ~/.local/bin runs it (not on Windows: PATH there).
if (!windows) {
  const linkDir = join(home, '.local', 'bin')
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(launcher, join(linkDir, 'trek-server'))
  check('the launcher works through a symlink', execFileSync(join(linkDir, 'trek-server'), ['version'], { env, encoding: 'utf8' }).trim() === version)
}

// A pty from the tarball's node-pty: the native addon loads, and (on macOS) spawn-helper runs.
// spawnSync, not execFileSync: an addon that fails to load is a FAIL with its error, not a crash.
const pty = spawnSync(process.execPath, ['-e', `
  const pty = require(${JSON.stringify(join(dir, 'node_modules', 'node-pty'))})
  const p = ${windows ? `pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'set /a 6*7 >nul && echo pty-42 && ping -n 2 127.0.0.1 >nul'], { cols: 80, rows: 24 })` : `pty.spawn('/bin/sh', ['-c', 'echo pty-$((6 * 7))'], { cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } })`}
  let out = ''
  p.onData((d) => { out += d })
  // ConPTY can report the exit before it flushes the output (hence the ping above, a second's
  // pause): give the output up to 2s more to arrive after the exit.
  p.onExit(({ exitCode }) => {
    const since = Date.now()
    const report = () => {
      if (!/pty-42/.test(out) && Date.now() - since < 2000) return setTimeout(report, 50)
      process.stdout.write(out.trim() + ' exit ' + exitCode)
      process.exit(0)
    }
    report()
  })
  setTimeout(() => { process.stdout.write('timeout: ' + out); process.exit(1) }, 10000)
`], { env, encoding: 'utf8' })
const ptyOut = pty.stdout ?? ''
check('node-pty spawns a shell in a pty', pty.status === 0 && /pty-42/.test(ptyOut) && /exit 0$/.test(ptyOut), ptyOut + (pty.stderr ?? ''))

// start: a throwaway config (only a token hash), a free loopback port, a temp data folder.
const port = await new Promise((done, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})
const configPath = join(work, 'config.json')
const tokenHash = createHash('sha256').update(randomBytes(16).toString('base64url'), 'utf8').digest('hex')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [] }), { mode: 0o600 })
// cmd.exe's line is joined by hand there: a path is quoted.
const pathArg = (p) => (windows ? `"${p}"` : p)
const started = viaLauncher(['start', '--config', pathArg(configPath), '--host', '127.0.0.1', '--port', String(port), '--data-dir', pathArg(join(work, 'data'))])
const server = spawn(started.file, started.args, {
  ...started.opts,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
children.add(server)
let output = ''
server.stdout.on('data', (d) => { output += d })
server.stderr.on('data', (d) => { output += d })
const exited = new Promise((done) => server.on('exit', (code, signal) => { children.delete(server); done({ code, signal }) }))
const listening = await Promise.race([
  new Promise((done) => {
    const timer = setInterval(() => {
      if (output.includes('listening')) { clearInterval(timer); done(true) }
    }, 100)
    setTimeout(() => { clearInterval(timer); done(false) }, 15000)
  }),
  exited.then(() => false)
])
check(`start listens on 127.0.0.1:${port}`, listening && output.includes(`trek-server ${version}`), output)

if (listening) {
  // A WebSocket upgrade (Node 22's WebSocket): the server accepts the socket and speaks first or
  // waits for a hello; either way the upgrade itself must succeed.
  const opened = await new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); done('timeout') }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); done('open') })
    ws.addEventListener('error', () => { clearTimeout(timer); done('error') })
  })
  check('a WebSocket client connects', opened === 'open', opened)
}

// Windows: no signals; the launcher's cmd.exe and the node under it end with taskkill /T /F.
if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(server.pid)], { stdio: 'ignore' })
else server.kill('SIGTERM')
const stopped = await Promise.race([exited, new Promise((done) => setTimeout(() => done(null), 10000))])
check(windows ? 'taskkill ends it within 10 s' : 'SIGTERM stops it within 10 s', stopped !== null && (windows || stopped.code === 0 || stopped.signal === 'SIGTERM'), JSON.stringify(stopped) + '\n' + output)

console.log(failed ? `SERVER TARBALL SMOKE FAILED: ${basename(tarball)}` : `SERVER TARBALL SMOKE PASSED: ${basename(tarball)}`)
process.exit(failed ? 1 : 0)
