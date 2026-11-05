// scripts/serverTerminalHost.test.mjs — v2 ptys: replay, many clients, exit, kill, backpressure, screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalHost } from '../server/src/sessions/terminalHost.ts'

function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], size: [opts.cols, opts.rows], killed: false, paused: false,
      dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb },
      onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) },
      resize(c, r) { this.size = [c, r] },
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) },
      pause() { this.paused = true },
      resume() { this.paused = false },
      emit(d) { this.dataCb(d) },
      exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

function sink(congested = () => false) {
  const events = []
  return { events, send: (event, payload) => events.push({ event, ...payload }), congested }
}

const opts = { file: '/bin/sh', args: ['-ilc', 'exec x'], cwd: '/tmp', env: {}, cols: 80, rows: 24 }
const flush = () => new Promise((r) => setImmediate(r))

function setup() {
  const fake = fakeSpawner()
  const exits = []
  const host = new TerminalHost({ spawner: fake.spawner, onExit: (ptyId, code) => exits.push([ptyId, code]) })
  return { ...fake, exits, host }
}

test('attach replays scrollback with seq, then streams live data to every attached sink', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  spawned[0].emit('hello ')
  spawned[0].emit('world')
  const a = sink()
  const info = host.attach('p1', a)
  assert.deepEqual(info, { ptyId: 'p1', cwd: '/tmp', cols: 80, rows: 24, seq: 11 })
  assert.deepEqual(a.events, [
    { event: 'pty.data', ptyId: 'p1', seq: 0, data: 'hello ', replay: true },
    { event: 'pty.data', ptyId: 'p1', seq: 6, data: 'world', replay: true }
  ])
  const b = sink()
  host.attach('p1', b)
  spawned[0].emit('!')
  assert.deepEqual(a.events.at(-1), { event: 'pty.data', ptyId: 'p1', seq: 11, data: '!' })
  assert.deepEqual(b.events.at(-1), { event: 'pty.data', ptyId: 'p1', seq: 11, data: '!' })
  host.detach('p1', a)
  spawned[0].emit('?')
  assert.equal(a.events.at(-1).data, '!')
  assert.equal(b.events.at(-1).data, '?')
})

test('exit tells attached sinks and the owner, and forgets the pty', () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  spawned[0].exit(7)
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 7 })
  assert.deepEqual(exits, [['p1', 7]])
  assert.equal(host.has('p1'), false)
  assert.throws(() => host.write('p1', 'x'), (e) => e.code === 'PTY_NOT_FOUND')
})

test('kill ends the pty without reporting an exit to the owner', async () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  host.kill('p1')
  await flush()
  assert.equal(spawned[0].killed, true)
  assert.deepEqual(exits, [])
  assert.equal(host.has('p1'), false)
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 129 })
})

test('write, resize and a duplicate spawn', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  host.write('p1', 'ls\r')
  host.resize('p1', 100, 40)
  assert.deepEqual(spawned[0].written, ['ls\r'])
  assert.deepEqual(spawned[0].size, [100, 40])
  assert.equal(host.info('p1').cols, 100)
  assert.throws(() => host.spawn('p1', opts), /already exists/)
  assert.throws(() => host.resize('p1', 0, 10), (e) => e.code === 'BAD_REQUEST')
})

test('the ring buffer keeps the newest output', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  const chunk = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 4; i++) spawned[0].emit(chunk)
  const a = sink()
  host.attach('p1', a)
  assert.equal(a.events.length, 2)
  assert.equal(a.events[0].seq, 2 * 1024 * 1024)
})

test('a congested sink pauses the pty until every sink drains', async () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  let busy = true
  host.attach('p1', sink(() => busy))
  host.attach('p1', sink())
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, true)
  busy = false
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawned[0].paused, false)
})

test('detachAll removes a sink everywhere', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  const a = sink()
  host.attach('p1', a)
  host.attach('p2', a)
  host.detachAll(a)
  spawned[0].emit('x')
  spawned[1].emit('y')
  assert.equal(a.events.length, 0)
})

test('the headless screen: bracketed paste mode and the last lines', async () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  assert.equal(host.bracketedPaste('p1'), false)
  spawned[0].emit('\x1b[?2004h')
  spawned[0].emit('line one\r\nline two\r\n')
  await host.settled('p1')
  assert.equal(host.bracketedPaste('p1'), true)
  assert.deepEqual(host.screen('p1', 2), ['line one', 'line two'])
})

test('disposeAll kills everything without owner exits', async () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  host.disposeAll()
  await flush()
  assert.ok(spawned.every((p) => p.killed))
  assert.deepEqual(exits, [])
})
