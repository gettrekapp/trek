// scripts/updateFixture.mjs — what the update smokes share (server-update-smoke.mjs and
// server-update-app-smoke.mjs): test builds of trek-server at two versions (they take their feed
// and key from the environment; a release build never does), install folders laid out as a release
// tarball's (the real launcher, a pruned node-pty), a signed release feed served from 127.0.0.1,
// and how the servers are started, waited on, asked and stopped. Everything lives in one temp
// folder, removed when the process exits; every child is ended by its own handle. macOS and Linux.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POSIX_LAUNCHER } from './serverLaunchers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export const TARGET = `${process.platform}-${process.arch}`
export const WAIT_MS = 20000
/** Whether this Node can replace a running process (22.15 and later): the servers run with this same Node (TREK_NODE below). */
export const canExecve = typeof process.execve === 'function'
/** The feed's path of the signed sums. */
export const SUMS = '/releases/latest/download/SHA256SUMS'

/** Resolves true once `pred()` holds, false after `ms`. */
export const waitFor = async (pred, ms = WAIT_MS) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
  return pred()
}

/** Whether `promise` settles within `ms`. */
export const within = (promise, ms = WAIT_MS) => {
  let timer
  return Promise.race([promise.then(() => true), new Promise((done) => { timer = setTimeout(() => done(false), ms) })]).finally(() => clearTimeout(timer))
}

export const freePort = () =>
  new Promise((done, reject) => {
    const probe = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

/** Waits until `run.output` matches, the process ends, or the time is up. */
export const until = async (run, pattern, ms = WAIT_MS) => {
  await waitFor(() => pattern.test(run.output) || run.ended !== null, ms)
  // Its last output can arrive just after its exit.
  if (run.ended !== null) await waitFor(() => pattern.test(run.output), 500)
  return pattern.test(run.output)
}

/** How it ended ({ code, signal }), or null if it has not within `ms`. */
export const ending = (run, ms = WAIT_MS) => Promise.race([run.exited, new Promise((done) => setTimeout(() => done(null), ms))])

export async function stop(run) {
  if (run.ended === null) run.child.kill('SIGTERM')
  return ending(run, 10000)
}

/** One request on a server's control socket; `onAnswer` runs the moment the answer is read. null when nothing answers. */
export function control(socketPath, op, onAnswer) {
  return new Promise((done) => {
    let data = ''
    const socket = createConnection(socketPath)
    const finish = (value) => {
      clearTimeout(timer)
      socket.destroy()
      done(value)
    }
    const timer = setTimeout(() => finish(null), 5000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ op }) + '\n'))
    socket.on('data', (chunk) => {
      data += chunk
      const end = data.indexOf('\n')
      if (end < 0) return
      let answer = null
      try {
        answer = JSON.parse(data.slice(0, end))
      } catch {
        // Not an answer.
      }
      onAnswer?.(answer)
      finish(answer)
    })
    socket.on('error', () => finish(null))
  })
}

/**
 * A signed-in protocol connection (PROTOCOL.md, "Handshake" and "Requests"). `request(method,
 * params)` resolves the result, or rejects with the error ({ code, message, details }) or, after
 * WAIT_MS, with what was received instead; `events` collects [event, payload] in the order they
 * arrived; `closed` settles when the socket closes. `hello: false`: it never signs in (`frames`
 * is all it was sent).
 */
export function connect(port, token, { hello = true, client = 'server-update-smoke' } = {}) {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const conn = { welcome: null, events: [], frames: 0, isClosed: false }
    const pending = new Map()
    let nextId = 1
    const giveUp = setTimeout(() => {
      ws.close()
      reject(new Error(`no welcome from 127.0.0.1:${port} within ${WAIT_MS} ms`))
    }, WAIT_MS)
    const ready = () => {
      clearTimeout(giveUp)
      done(conn)
    }
    conn.closed = new Promise((gone) => ws.addEventListener('close', (event) => {
      conn.isClosed = true
      clearTimeout(giveUp)
      for (const { fail, method } of pending.values()) fail(new Error(`the connection closed (${event.code}) before ${method} was answered`))
      pending.clear()
      reject(new Error(`the connection to 127.0.0.1:${port} closed (${event.code} ${event.reason}) before a welcome`))
      gone()
    }))
    conn.close = () => ws.close()
    conn.request = (method, params = {}) => new Promise((answer, fail) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error(`no answer to ${method} within ${WAIT_MS} ms; events: ${JSON.stringify(conn.events)}`))
      }, WAIT_MS)
      pending.set(id, { method, answer: (value) => { clearTimeout(timer); answer(value) }, fail: (err) => { clearTimeout(timer); fail(err) } })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
    ws.addEventListener('open', () => {
      if (hello) ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client, clientVersion: '0', token }))
      else ready()
    })
    ws.addEventListener('message', (event) => {
      conn.frames++
      const frame = JSON.parse(String(event.data))
      if (frame.type === 'welcome') {
        conn.welcome = frame
        ready()
      } else if (frame.type === 'event') {
        conn.events.push([frame.event, frame.payload])
      } else if (frame.type === 'res') {
        const waiting = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.ok) waiting?.answer(frame.result)
        else waiting?.fail(frame.error)
      }
    })
  })
}

export const escaped = (text) => text.replaceAll('.', '\\.')
export const listeningAs = (version) => new RegExp(`trek-server ${escaped(version)} \\(build [^)]+\\) .* listening on ws://127\\.0\\.0\\.1:`)
export const listenings = (run, port) => run.output.split('\n').filter((line) => line.includes(`listening on ws://127.0.0.1:${port}`)).length
/** The server is listening as `version`, and `trek-server update` can reach it. */
export const up = async (w, run, version) => (await until(run, listeningAs(version))) && (await waitFor(() => existsSync(w.socket)))

/** A stand-in bundle for `version` that passes nothing: its selfcheck fails. */
export const failsSelfcheck = (version) =>
  `#!/usr/bin/env node\nif (process.argv[2] === 'version') { console.log('${version}'); process.exit(0) }\nconsole.error('FAIL: node-pty loads\\n  simulated: this version cannot run here')\nprocess.exit(1)\n`
/** A stand-in bundle for `version` whose selfcheck passes and whose start dies before listening. */
export const diesAtStart = (version) =>
  `#!/usr/bin/env node\nconst cmd = process.argv[2]\nif (cmd === 'version') { console.log('${version}'); process.exit(0) }\nif (cmd === 'selfcheck') { console.log('ok: simulated'); process.exit(0) }\nconsole.error('simulated: this version dies at start')\nprocess.exit(1)\n`

/**
 * The fixture: a temp folder, test builds of `old` and `next`, the pruned node-pty, a key pair
 * and the feed's HTTP server on 127.0.0.1. `signals: false` leaves SIGINT, SIGTERM and SIGHUP to
 * the caller (a smoke with an app to close first); the temp folder and the children still go
 * when the process exits.
 */
export async function createUpdateFixture({ prefix = 'trek-upd-', old: OLD = '9.0.0', next: NEW = '9.0.1', signals = true } = {}) {
  // realpath: macOS's /var is a link to /private/var, and the server reports real paths.
  const work = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const children = new Set()
  let http
  const cleanup = () => {
    for (const child of children) child.kill('SIGKILL')
    http?.close()
    rmSync(work, { recursive: true, force: true })
  }
  process.on('exit', cleanup)
  if (signals) for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130))

  // ---- the builds: one bundle per version ---------------------------------------------------
  /** A test build claiming `version`, in work/build/<version>. `test: false`: a normal build (no key built in, the repo's own version) in a folder of that name. */
  function buildServer(version, { test = true } = {}) {
    const out = join(work, 'build', version)
    execFileSync(process.execPath, [join(root, 'server', 'scripts', 'build.mjs'), '--out', out], {
      env: test ? { ...process.env, TREK_SERVER_TEST_UPDATE: '1', TREK_SERVER_TEST_VERSION: version } : withoutTestBuild(process.env),
      // esbuild's summary goes to stderr: shown only if the build fails (execFileSync's error carries it).
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8'
    })
    return out
  }

  /**
   * node-pty as a release tarball holds it (scripts/package-server.mjs, prunePty): package.json,
   * lib/ and the one native folder it loads from, with pty.node and (macOS) spawn-helper. Made once
   * from the repo's own, in work/build/node_modules: every install folder gets a copy, and a bundle
   * run straight from work/build/<version> resolves this one.
   */
  function prunedPty() {
    const from = join(root, 'node_modules', 'node-pty')
    const to = join(work, 'build', 'node_modules', 'node-pty')
    const native = ['build/Release', `prebuilds/${TARGET}`].find((dir) => existsSync(join(from, dir, 'pty.node')))
    if (!native) throw new Error(`node-pty has no pty.node in build/Release or prebuilds/${TARGET}: run npm ci`)
    mkdirSync(join(to, native), { recursive: true })
    cpSync(join(from, 'package.json'), join(to, 'package.json'))
    cpSync(join(from, 'lib'), join(to, 'lib'), { recursive: true, filter: (src) => !src.endsWith('.test.js') })
    for (const file of ['pty.node', 'spawn-helper']) {
      if (existsSync(join(from, native, file))) cpSync(join(from, native, file), join(to, native, file))
    }
    return to
  }

  /** A folder laid out as a release tarball's (scripts/package-server.mjs): launcher, bundle, build.json, node-pty. `bundle`: a build's folder, or a script's text. */
  function installFolder(at, version, bundle) {
    mkdirSync(join(at, 'bin'), { recursive: true })
    writeFileSync(join(at, 'bin', 'trek-server'), POSIX_LAUNCHER, { mode: 0o755 })
    if (typeof bundle === 'string') writeFileSync(join(at, 'trek-server.cjs'), bundle, { mode: 0o755 })
    else cpSync(join(bundle.dir, 'trek-server.cjs'), join(at, 'trek-server.cjs'))
    const built = typeof bundle === 'string' ? { build: 'smoke' } : JSON.parse(readFileSync(join(bundle.dir, 'build.json'), 'utf8'))
    writeFileSync(join(at, 'build.json'), JSON.stringify({ version, build: built.build, package: 'tarball', target: TARGET }) + '\n')
    cpSync(pty, join(at, 'node_modules', 'node-pty'), { recursive: true })
    return at
  }

  // ---- the feed: a signed release, served from loopback ------------------------------------
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const PUBKEY = publicKey.export({ type: 'spki', format: 'pem' })
  /** What the feed serves now: path → bytes. Each scenario sets it. */
  let served = new Map()
  /** How many requests the feed has had */
  let requests = 0

  /** Publishes a release of `version` (NEW unless given) whose tarball holds `bundle`. `tamper` changes what is served after it is signed. */
  function publish(name, bundle, tamper, version = NEW) {
    const folder = `trek-server-${version}-${TARGET}`
    const stage = join(work, 'release', name)
    installFolder(join(stage, folder), version, bundle)
    const tarball = join(stage, `${folder}.tar.gz`)
    // COPYFILE_DISABLE: macOS's tar would add ._ AppleDouble files for extended attributes.
    execFileSync('tar', ['-czf', tarball, '-C', stage, folder], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const bytes = readFileSync(tarball)
    const sums = Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${folder}.tar.gz\n`)
    const tarballPath = `/releases/download/v${version}/${folder}.tar.gz`
    const files = new Map([
      [SUMS, sums],
      [`${SUMS}.sig`, Buffer.from(sign(null, sums, privateKey).toString('base64') + '\n')],
      [tarballPath, bytes]
    ])
    tamper?.(files, tarballPath)
    served = files
  }

  http = createHttpServer((req, res) => {
    requests++
    const body = served.get(req.url ?? '')
    if (!body) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const FEED = `http://127.0.0.1:${http.address().port}/releases`

  // ---- one install, its config, and how it is run ------------------------------------------
  const home = join(work, 'home')
  mkdirSync(home, { recursive: true })
  // TREK_NODE: the launcher runs this Node, whichever `node` is on PATH.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TREK_UPDATE_FEED: FEED, TREK_UPDATE_PUBKEY: PUBKEY, TREK_NODE: process.execPath }

  /** Runs `file` to its end (the feed is served by this process, so nothing here may block it). */
  function runToEnd(file, args, ms = 120000) {
    return new Promise((done) => {
      const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => child.kill('SIGKILL'), ms)
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        children.delete(child)
        done({ status, signal, stderr: err, out: `${out}${err}${signal ? `\n(ended by ${signal})` : ''}` })
      })
    })
  }

  /**
   * A fresh install of OLD in its own folder, with its own config. The names are short: the control
   * socket sits beside the config, and a Unix socket's path holds about 100 bytes. `bundle` and
   * `version`: another build to install instead; `config`: more of the config file.
   */
  async function world(name, { check = false, remoteApply, bundle = oldBuild, version = OLD, config = {} } = {}) {
    const base = join(work, name)
    const install = installFolder(join(base, 'opt', 'trek-server'), version, bundle)
    const configPath = join(base, 'c', 'config.json')
    mkdirSync(join(base, 'c'), { recursive: true })
    // The config holds only the hash; the token is kept for the scenarios that sign in.
    const token = randomBytes(16).toString('base64url')
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
    writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [], ...config, updates: { check, ...(remoteApply === undefined ? {} : { remoteApply }) } }), { mode: 0o600 })
    const port = await freePort()
    const launcher = join(install, 'bin', 'trek-server')
    const startArgs = ['start', '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--data-dir', join(base, 'data')]
    const cli = (args) => runToEnd(launcher, [...args, '--config', configPath])
    const versionAt = (dir) => JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')).version
    const state = () => {
      try {
        return JSON.parse(readFileSync(join(base, 'c', 'update-state.json'), 'utf8'))
      } catch {
        return {}
      }
    }
    const marks = () => ['update-pending.json', 'update-pending.tried', 'update-rolled-back.json'].filter((file) => existsSync(join(install, file)))
    return { base, install, configPath, token, socket: join(base, 'c', 'control.sock'), port, launcher, startArgs, cli, versionAt, state, marks }
  }

  /** Starts a server. `output` grows; `exited` settles when it ends. */
  function start(file, args, extraEnv = {}) {
    const child = spawn(file, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    const run = { child, output: '', ended: null }
    child.stdout.on('data', (d) => { run.output += d })
    child.stderr.on('data', (d) => { run.output += d })
    run.exited = new Promise((done) => child.on('exit', (code, signal) => {
      children.delete(child)
      run.ended = { code, signal }
      done(run.ended)
    }))
    return run
  }

  // ---- the bundles -------------------------------------------------------------------------
  console.log('building two test builds of trek-server…')
  const oldBuild = { dir: buildServer(OLD) }
  const newBuild = { dir: buildServer(NEW) }
  const pty = prunedPty()

  return { work, OLD, NEW, FEED, PUBKEY, env, children, oldBuild, newBuild, buildServer, installFolder, publish, feedRequests: () => requests, runToEnd, world, start, cleanup }
}

/** The environment without the test build's switches: what a normal build is made with. */
function withoutTestBuild(env) {
  const { TREK_SERVER_TEST_UPDATE: _update, TREK_SERVER_TEST_VERSION: _version, ...rest } = env
  return rest
}
