// scripts/serverSelfcheck.test.mjs — `trek-server selfcheck`: node-pty loads, a terminal runs a
// command, and a throwaway server answers one connection, without touching the real config.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { selfcheck } from '../server/src/update/selfcheck.ts'
import { loadNodePty } from '../server/src/sessions/nativePty.ts'
import { posixOnly } from './testPlatform.mjs'

// The terminal step runs /bin/sh, as the tarballs `trek-server update` replaces do (macOS and Linux).
const posix = { skip: posixOnly('selfcheck runs /bin/sh in its terminal') }

/** What keeps the event loop alive, but for what the test runner itself holds. */
const held = () => process.getActiveResourcesInfo().filter((r) => !['TTYWrap', 'PipeWrap', 'FSReqCallback', 'FSReqPromise', 'MessagePort', 'Immediate'].includes(r))

/** Whether anything accepts a connection on a ws://127.0.0.1:<port> URL. */
const listening = (url) =>
  new Promise((resolve) => {
    const socket = connect(Number(new URL(url).port), '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })

/** A stand-in for node-pty whose one terminal does what `behave` says; `killed` counts its kills. */
function fakePty(behave) {
  const fake = { killed: 0, spawned: [] }
  fake.spawn = (file, args, options) => {
    fake.spawned.push({ file, args, options })
    const term = {
      onData: (cb) => { term.data = cb },
      onExit: (cb) => { term.exit = cb },
      kill: () => { fake.killed += 1 }
    }
    setImmediate(() => behave(term))
    return term
  }
  return fake
}

test('selfcheck passes here, names each step, and leaves nothing behind', posix, async () => {
  const before = held()
  const lines = []
  const result = await selfcheck({ log: (line) => lines.push(line) })
  assert.equal(result.ok, true, lines.join('\n'))
  assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), [
    ['node-pty loads', true],
    ['a terminal runs a command', true],
    ['the server answers a connection', true]
  ])
  assert.deepEqual(lines, ['ok: node-pty loads', 'ok: a terminal runs a command', 'ok: the server answers a connection'])
  assert.equal(existsSync(result.workDir), false, 'the temp folder is removed')
  // Nothing it started is left running: a caller's process can end without process.exit.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(held().sort(), before.sort(), 'no socket, timer or child of its own is left')
})

test('a step that fails stops the check and says why', posix, async () => {
  const lines = []
  const result = await selfcheck({ log: (line) => lines.push(line), loadPty: () => { throw new Error('library load disallowed by system policy') } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.steps.map((s) => s.ok), [false])
  assert.match(result.steps[0].error, /library load disallowed/)
  assert.deepEqual(lines, ['FAIL: node-pty loads\n  library load disallowed by system policy'])
  assert.equal(existsSync(result.workDir), false)
})

test('a terminal whose command fails stops the check before any server is started', posix, async () => {
  const pty = fakePty((term) => { term.data('sh: not found\r\n'); term.exit({ exitCode: 127 }) })
  let opened = 0
  const result = await selfcheck({ log: () => {}, loadPty: () => pty, openSocket: () => { opened += 1; throw new Error('not reached') } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), [['node-pty loads', true], ['a terminal runs a command', false]])
  assert.match(result.steps[1].error, /exited 127 and printed "sh: not found/)
  assert.equal(opened, 0)
  assert.equal(pty.killed, 0, 'a terminal that exited is not killed')
  assert.equal(pty.spawned[0].file, '/bin/sh')
  assert.equal(existsSync(result.workDir), false)
})

test('a terminal that never exits fails after the step timeout, and is killed', posix, async () => {
  const pty = fakePty(() => {})
  const started = Date.now()
  const result = await selfcheck({ log: () => {}, loadPty: () => pty, stepTimeoutMs: 150 })
  assert.ok(Date.now() - started < 5000, 'the short timeout applies')
  assert.equal(result.ok, false)
  assert.deepEqual(result.steps.map((s) => s.ok), [true, false])
  assert.match(result.steps[1].error, /a terminal runs a command: no answer in 0\.15 s/)
  assert.equal(pty.killed, 1)
  assert.equal(existsSync(result.workDir), false)
})

test('a server that never answers fails after the step timeout, is shut down, and its folder removed', posix, async () => {
  const lines = []
  let url
  let closed = 0
  // A socket that never opens: the hello is never sent, so no welcome comes.
  const openSocket = (to) => {
    url = to
    return { addEventListener: () => {}, send: () => {}, close: () => { closed += 1 } }
  }
  const result = await selfcheck({ log: (line) => lines.push(line), loadPty: loadNodePty, openSocket, stepTimeoutMs: 1500 })
  assert.equal(result.ok, false, lines.join('\n'))
  assert.deepEqual(result.steps.map((s) => s.ok), [true, true, false])
  assert.match(result.steps[2].error, /the server answers a connection: no answer in 1\.5 s/)
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/, 'loopback, a port the OS picked')
  assert.equal(closed, 1, 'the socket is closed')
  assert.equal(await listening(url), false, 'the server no longer listens')
  assert.equal(existsSync(result.workDir), false)
})

test('an answer that is not a welcome fails the check', posix, async () => {
  const openSocket = () => {
    const handlers = {}
    setImmediate(() => handlers.message({ data: '{"type":"nope"}' }))
    return { addEventListener: (name, cb) => { handlers[name] = cb }, send: () => {}, close: () => {} }
  }
  const result = await selfcheck({ log: () => {}, loadPty: loadNodePty, openSocket })
  assert.equal(result.ok, false)
  assert.match(result.steps[2].error, /answered \{"type":"nope"\} instead of a welcome/)
  assert.equal(existsSync(result.workDir), false)
})
