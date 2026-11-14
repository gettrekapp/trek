// scripts/serverUpdateControl.test.mjs — how `trek-server update` reaches a running server (a Unix
// socket beside its config, readable only by its user) and how the server becomes the new version
// without changing its process id (process.execve).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTROL_SOCKET, controlPath, controlRequest, listenControl, socketPathFits } from '../server/src/update/control.ts'
import { canRelaunch, launcherPath, relaunch, relaunchEnv, relaunchRefusal } from '../server/src/update/relaunch.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const sockets = { skip: posixOnly('a Unix socket') }
const temp = () => mkdtempSync(join(tmpdir(), 'trek-ctl-'))
const STATUS = { pid: 4242, version: '1.0.0', installDir: '/opt/trek-server', sessions: 3, canRelaunch: true }
const HANDLERS = { status: () => STATUS, relaunch: () => ({ ok: true }) }
const srcUrl = (name) => pathToFileURL(join(process.cwd(), 'server', 'src', 'update', name)).href

/** Runs `fn`, returning what it warned. */
async function warnings(fn) {
  const said = []
  const warn = console.warn
  console.warn = (...args) => said.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.warn = warn
  }
  return said
}

/** What a client that writes `bytes` (nothing when '') gets back before the server closes the connection. */
function raw(path, bytes) {
  return new Promise((resolve) => {
    let got = ''
    const socket = connect(path)
    socket.setEncoding('utf8')
    socket.on('connect', () => { if (bytes) socket.write(bytes) })
    socket.on('data', (chunk) => { got += chunk })
    socket.on('error', () => {})
    socket.on('close', () => resolve(got))
  })
}

test('the socket is beside the config file', () => {
  assert.equal(controlPath(join('home', 'u', 'trek-server', 'config.json')), join('home', 'u', 'trek-server', CONTROL_SOCKET))
})

test('a running server answers status and relaunch; nobody listening is null', sockets, async () => {
  const dir = temp()
  const path = join(dir, CONTROL_SOCKET)
  const asked = []
  try {
    assert.equal(await controlRequest(path, 'status'), null, 'no socket: no server')
    const control = await listenControl(path, {
      status: () => STATUS,
      relaunch: () => { asked.push('relaunch'); return { ok: true } }
    })
    assert.ok(control)
    assert.equal(statSync(path).mode & 0o777, 0o600, 'only this user can connect')
    assert.deepEqual(await controlRequest(path, 'status'), STATUS)
    assert.deepEqual(await controlRequest(path, 'relaunch'), { ok: true })
    assert.deepEqual(asked, ['relaunch'])
    control.close()
    assert.equal(existsSync(path), false, 'removed on close')
    assert.equal(await controlRequest(path, 'status'), null)
    control.close()
    assert.deepEqual(readdirSync(dir), [], 'closing twice is harmless')
  } finally {
    removeDir(dir)
  }
})

test('a stale socket file is replaced; a live server keeps its socket', sockets, async () => {
  const dir = temp()
  const path = join(dir, CONTROL_SOCKET)
  try {
    writeFileSync(path, '')
    const first = await listenControl(path, HANDLERS)
    assert.ok(first, 'a leftover file nobody listens on is replaced')
    let second
    const said = await warnings(async () => {
      second = await listenControl(path, { status: () => ({ ...STATUS, pid: 1 }), relaunch: () => ({ ok: true }) })
    })
    assert.equal(second, null, 'a second server does not take the first one\'s socket')
    assert.equal(said.length, 1, said.join('\n'))
    assert.match(said[0], /another trek-server/)
    assert.deepEqual(readdirSync(dir), [CONTROL_SOCKET], 'the first one\'s file is where it was, and nothing else is left')
    assert.deepEqual(await controlRequest(path, 'status'), STATUS)
    first.close()

    // A socket whose server is gone (it was killed: nothing removed the file).
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:net'
      createServer().listen(${JSON.stringify(path + '2')}, () => process.kill(process.pid, 'SIGKILL'))
    `])
    assert.equal(child.signal, 'SIGKILL')
    assert.equal(existsSync(path + '2'), true, 'a killed server leaves its socket file')
    const third = await listenControl(path + '2', HANDLERS)
    assert.ok(third, 'a dead server\'s socket is taken over')
    assert.deepEqual(await controlRequest(path + '2', 'status'), STATUS)
    third.close()
  } finally {
    removeDir(dir)
  }
})

test('servers that start at once over a stale socket: exactly one has it, and it is the one that answers', sockets, async () => {
  for (let round = 0; round < 5; round++) {
    const dir = temp()
    const path = join(dir, CONTROL_SOCKET)
    try {
      writeFileSync(path, '')
      let controls
      await warnings(async () => {
        controls = await Promise.all([1, 2, 3, 4, 5, 6].map((pid) => listenControl(path, { status: () => ({ ...STATUS, pid }), relaunch: () => ({ ok: true }) })))
      })
      const winners = controls.map((control, i) => (control ? i + 1 : 0)).filter((pid) => pid !== 0)
      assert.equal(winners.length, 1, `one server has the socket, not ${winners.length}`)
      assert.equal((await controlRequest(path, 'status')).pid, winners[0], 'and its file is the one at the path')
      assert.deepEqual(readdirSync(dir), [CONTROL_SOCKET], 'no lock is left')
      for (const control of controls) control?.close()
    } finally {
      removeDir(dir)
    }
  }
})

test('a refusal, garbage and an unknown request are answered, not fatal', sockets, async () => {
  const dir = temp()
  const path = join(dir, CONTROL_SOCKET)
  try {
    const control = await listenControl(path, { status: () => STATUS, relaunch: () => ({ ok: false, error: 'Node 22.15 or later is needed' }) })
    assert.deepEqual(await controlRequest(path, 'relaunch'), { ok: false, error: 'Node 22.15 or later is needed' })
    assert.deepEqual(await controlRequest(path, 'nope'), { ok: false, error: 'unknown request' })
    assert.equal(await raw(path, 'not json\n'), '{"ok":false,"error":"unknown request"}\n')
    assert.equal(await raw(path, 'null\n'), '{"ok":false,"error":"unknown request"}\n')
    assert.equal(await raw(path, '{"op":"status"}\n{"op":"relaunch"}\n'), JSON.stringify(STATUS) + '\n', 'one request per connection')
    assert.equal(await raw(path, 'x'.repeat(100_000)), '', 'a line that never ends is dropped')
    assert.equal(await raw(path, 'x'.repeat(100_000) + '\n'), '', 'so is one far too long to be a request')
    assert.deepEqual(await controlRequest(path, 'status'), STATUS, 'still serving')
    control.close()
  } finally {
    removeDir(dir)
  }
})

test('a client that says nothing is dropped; a handler that throws is an answer, and the server keeps serving', sockets, async () => {
  const dir = temp()
  const path = join(dir, CONTROL_SOCKET)
  try {
    let fail = true
    const control = await listenControl(
      path,
      {
        status: () => { if (fail) throw new Error('sessions are gone'); return STATUS },
        relaunch: () => { throw 'not an Error' }
      },
      { idleMs: 100 }
    )
    const started = Date.now()
    assert.equal(await raw(path, ''), '', 'the server hangs up on a silent client')
    assert.ok(Date.now() - started < 3000)
    assert.deepEqual(await controlRequest(path, 'status'), { ok: false, error: 'sessions are gone' })
    assert.deepEqual(await controlRequest(path, 'relaunch'), { ok: false, error: 'not an Error' })
    fail = false
    assert.deepEqual(await controlRequest(path, 'status'), STATUS)
    control.close()
  } finally {
    removeDir(dir)
  }
})

test('a request to a server that accepts and never answers ends at its timeout, with the connection closed', sockets, async () => {
  const dir = temp()
  const path = join(dir, CONTROL_SOCKET)
  const mute = createServer()
  try {
    const closed = new Promise((resolve) => mute.on('connection', (socket) => { socket.on('error', () => {}); socket.on('close', resolve); socket.resume() }))
    await new Promise((resolve) => mute.listen(path, resolve))
    const started = Date.now()
    assert.equal(await controlRequest(path, 'status', 150), null)
    const took = Date.now() - started
    assert.ok(took >= 100 && took < 3000, `took ${took} ms`)
    await closed
    // An answer that is not JSON, and a connection closed without one, are no answer either.
    mute.removeAllListeners('connection')
    mute.on('connection', (socket) => socket.end('garbage\n'))
    assert.equal(await controlRequest(path, 'status'), null)
    mute.removeAllListeners('connection')
    mute.on('connection', (socket) => socket.destroy())
    assert.equal(await controlRequest(path, 'status'), null)
  } finally {
    mute.close()
    removeDir(dir)
  }
})

test('a path too long for a Unix socket is no control socket, not a crash, and no socket somewhere else', sockets, async () => {
  const dir = temp()
  try {
    // Node cuts a longer path short without an error: it would listen on (and connect to) a file of another name.
    assert.equal(socketPathFits('/' + 'a'.repeat(102), 'darwin'), true)
    assert.equal(socketPathFits('/' + 'a'.repeat(103), 'darwin'), false)
    assert.equal(socketPathFits('/' + 'a'.repeat(106), 'linux'), true)
    assert.equal(socketPathFits('/' + 'a'.repeat(107), 'linux'), false)
    assert.equal(socketPathFits('/' + 'é'.repeat(52), 'darwin'), false, 'bytes, not characters')

    const folder = join(dir, 'x'.repeat(120))
    mkdirSync(folder)
    const path = join(folder, CONTROL_SOCKET)
    let control
    const said = await warnings(async () => { control = await listenControl(path, HANDLERS) })
    assert.equal(control, null)
    assert.equal(said.length, 1, said.join('\n'))
    assert.match(said[0], /too long/)
    assert.deepEqual(readdirSync(dir), ['x'.repeat(120)], 'nothing was created under a shortened name')
    assert.deepEqual(readdirSync(folder), [])

    // The name such a path would be cut to: a server there is not this path's server.
    const cut = Buffer.from(path).subarray(0, 103).toString()
    const other = await listenControl(cut, HANDLERS)
    assert.ok(other)
    assert.equal(await controlRequest(path, 'status'), null)
    other.close()

    // A folder that does not exist: refused for another reason, the same way.
    let missing
    const saidMissing = await warnings(async () => { missing = await listenControl(join(dir, 'nowhere', CONTROL_SOCKET), HANDLERS) })
    assert.equal(missing, null)
    assert.equal(saidMissing.length, 1, saidMissing.join('\n'))
  } finally {
    removeDir(dir)
  }
})

test('the control socket does not keep a finished process alive', sockets, () => {
  const dir = temp()
  try {
    const path = join(dir, CONTROL_SOCKET)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { listenControl } from ${JSON.stringify(srcUrl('control.ts'))}
      const control = await listenControl(${JSON.stringify(path)}, { status: () => ({}), relaunch: () => ({ ok: true }) })
      console.log(control ? 'listening' : 'none')
    `], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(child.stdout, 'listening\n', child.stderr)
    assert.equal(child.status, 0, 'it ended by itself')
  } finally {
    removeDir(dir)
  }
})

test('the launcher is bin/trek-server in the install folder', () => {
  assert.equal(launcherPath(join('opt', 'trek-server')), join('opt', 'trek-server', 'bin', 'trek-server'))
})

test('canRelaunch: never on Windows, and only where this Node has process.execve', () => {
  const execve = () => { throw new Error('not called') }
  assert.equal(canRelaunch({ platform: 'linux', execve }), true)
  assert.equal(canRelaunch({ platform: 'darwin', execve }), true)
  assert.equal(canRelaunch({ platform: 'win32', execve }), false)
  assert.equal(canRelaunch({ platform: 'linux' }), false, 'Node before 22.15')
  assert.equal(canRelaunch({ platform: 'linux', execve: undefined }), false)
  assert.equal(canRelaunch(), process.platform !== 'win32' && typeof process.execve === 'function')
})

/** An install folder with a launcher holding `script` (none when undefined). */
function installWith(dir, script, mode = 0o755) {
  const install = join(dir, 'install')
  mkdirSync(join(install, 'bin'), { recursive: true })
  if (script !== undefined) {
    writeFileSync(join(install, 'bin', 'trek-server'), script)
    chmodSync(join(install, 'bin', 'trek-server'), mode)
  }
  return install
}

test('relaunch hands the launcher its own path, then the arguments, and this environment', { skip: posixOnly('a launcher that is a sh script') }, () => {
  const dir = temp()
  try {
    const install = installWith(dir, '#!/bin/sh\n')
    const calls = []
    const host = { platform: 'linux', execve(...args) { calls.push([this === host, ...args]) } }
    relaunch(install, ['start', '--port', '9'], host)
    const launcher = launcherPath(install)
    // The environment, and the Node this server runs under for the launcher to run the new version with.
    assert.deepEqual(calls, [[true, launcher, [launcher, 'start', '--port', '9'], { ...process.env, TREK_NODE: process.env.TREK_NODE || process.execPath }]])
  } finally {
    removeDir(dir)
  }
})

test('relaunch throws, and replaces nothing, when it cannot: no execve, or no launcher that can run', { skip: posixOnly('file modes') }, () => {
  const dir = temp()
  try {
    const calls = []
    const host = { platform: 'linux', execve: () => calls.push('execve') }
    // execve itself does not throw on a file it cannot run: Node aborts the process. So the launcher is checked first.
    assert.throws(() => relaunch(installWith(dir, undefined), [], host), /bin.trek-server is missing or cannot be run/)
    assert.throws(() => relaunch(installWith(dir, '#!/bin/sh\n', 0o644), [], host), /bin.trek-server is missing or cannot be run/)
    mkdirSync(join(dir, 'folder', 'bin', 'trek-server'), { recursive: true })
    assert.throws(() => relaunch(join(dir, 'folder'), [], host), /missing or cannot be run/, 'a folder is not a launcher')
    assert.throws(() => relaunch(installWith(dir, '#!/bin/sh\n'), [], { platform: 'linux' }), /process\.execve/)
    assert.throws(() => relaunch(installWith(dir, '#!/bin/sh\n'), [], { platform: 'win32', execve: host.execve }), /process\.execve/)
    assert.deepEqual(calls, [])
  } finally {
    removeDir(dir)
  }
})

test('the relaunched server keeps its Node: TREK_NODE if it was started with one, else the Node it runs under', () => {
  assert.deepEqual(relaunchEnv({ PATH: '/bin', HOME: '/h' }, '/opt/node/bin/node'), { PATH: '/bin', HOME: '/h', TREK_NODE: '/opt/node/bin/node' })
  assert.deepEqual(relaunchEnv({ PATH: '/bin', TREK_NODE: '/usr/local/bin/node22' }, '/opt/node/bin/node'), { PATH: '/bin', TREK_NODE: '/usr/local/bin/node22' })
  assert.equal(relaunchEnv({ TREK_NODE: '' }, '/opt/node/bin/node').TREK_NODE, '/opt/node/bin/node', 'an empty TREK_NODE is none, as for the launcher')
  const env = { PATH: '/bin' }
  relaunchEnv(env, '/n')
  assert.deepEqual(env, { PATH: '/bin' }, 'the environment given is not changed')
})

test('relaunchRefusal says, before anything is shut down, why a relaunch cannot happen', { skip: posixOnly('file modes') }, () => {
  const dir = temp()
  try {
    const host = { platform: 'linux', execve: () => { throw new Error('not called') } }
    assert.equal(relaunchRefusal(installWith(dir, '#!/bin/sh\n'), host), null)
    assert.match(relaunchRefusal(installWith(dir, '#!/bin/sh\n', 0o644), host) ?? '', /bin.trek-server is missing or cannot be run/)
    assert.match(relaunchRefusal(join(dir, 'gone'), host) ?? '', /missing or cannot be run/)
    assert.match(relaunchRefusal(installWith(dir, '#!/bin/sh\n'), { platform: 'linux' }) ?? '', /cannot replace a running process/)
    assert.match(relaunchRefusal(installWith(dir, '#!/bin/sh\n'), { platform: 'win32', execve: host.execve }) ?? '', /cannot replace a running process/)
  } finally {
    removeDir(dir)
  }
})

const execve = { skip: posixOnly('process.execve') || (!canRelaunch() && 'this Node has no process.execve (22.15 or later has)') }

test('relaunch replaces the process with the launcher: same pid, exactly the arguments, the environment, the same stdout and stderr', execve, () => {
  const dir = temp()
  try {
    // One line per argument, so an argument more, fewer or split differently fails here.
    const install = installWith(dir, '#!/bin/sh\nprintf \'%s\\n\' "launcher pid=$$" "argc=$#" "$@" "env=$TREK_RELAUNCH_TEST"\necho "launcher stderr" >&2\nexit 7\n')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { relaunch } from ${JSON.stringify(srcUrl('relaunch.ts'))}
      console.log('node pid=' + process.pid)
      relaunch(${JSON.stringify(install)}, ['start', '--name', 'my server', '--port', '9'])
    `], { encoding: 'utf8', env: { ...process.env, TREK_RELAUNCH_TEST: 'kept' } })
    const nodePid = /^node pid=(\d+)\n/.exec(child.stdout)?.[1]
    assert.ok(nodePid, child.stdout + child.stderr)
    assert.equal(child.stdout, `node pid=${nodePid}\nlauncher pid=${nodePid}\nargc=5\nstart\n--name\nmy server\n--port\n9\nenv=kept\n`, child.stderr)
    assert.match(child.stderr, /launcher stderr\n$/)
    assert.equal(child.status, 7, 'the exit code is the launcher\'s')
  } finally {
    removeDir(dir)
  }
})

test('relaunch into a launcher that is not there is an error the caller can catch, not an abort', execve, () => {
  const dir = temp()
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { relaunch } from ${JSON.stringify(srcUrl('relaunch.ts'))}
      try {
        relaunch(${JSON.stringify(join(dir, 'gone'))}, ['start'])
      } catch (err) {
        console.log('caught: ' + err.message)
        process.exit(1)
      }
    `], { encoding: 'utf8' })
    assert.match(child.stdout, /^caught: .*missing or cannot be run/, child.stderr)
    assert.equal(child.status, 1)
    assert.equal(child.signal, null)
  } finally {
    removeDir(dir)
  }
})
