// scripts/serverTerminalHost.test.mjs — v2 ptys: replay, many clients, exit, kill, backpressure, screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalHost } from '../server/src/sessions/terminalHost.ts'
import { toWireError } from '../server/src/errors.ts'

function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], size: [opts.cols, opts.rows], killed: false, paused: false, signals: [], ignoreHup: false,
      dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb },
      onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) },
      resize(c, r) { this.size = [c, r] },
      kill(signal) { this.killed = true; this.signals.push(signal); if (!this.ignoreHup || signal === 'SIGKILL') setImmediate(() => this.exitCb(129)) },
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

function sink(bufferedAmount = () => 0) {
  const events = []
  return { events, send: (event, payload) => events.push({ event, ...payload }), bufferedAmount }
}

const MiB = 1024 * 1024

const opts = { file: '/bin/sh', args: ['-ilc', 'exec x'], cwd: '/tmp', env: {}, cols: 80, rows: 24 }
const flush = () => new Promise((r) => setImmediate(r))

function setup(t, extra = {}) {
  const fake = fakeSpawner()
  const exits = []
  const host = new TerminalHost({ spawner: fake.spawner, onExit: (ptyId, code) => exits.push([ptyId, code]), ...extra })
  t.after(() => host.disposeAll())
  return { ...fake, exits, host }
}

test('attach replays scrollback with seq, then streams live data to every attached sink', (t) => {
  const { host, spawned } = setup(t)
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

test('exit tells attached sinks and the owner, and forgets the pty', (t) => {
  const { host, spawned, exits } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  spawned[0].exit(7)
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 7 })
  assert.deepEqual(exits, [['p1', 7]])
  assert.equal(host.has('p1'), false)
  assert.throws(() => host.write('p1', 'x'), (e) => e.code === 'PTY_NOT_FOUND')
})

test('kill ends the pty without reporting an exit to the owner', async (t) => {
  const { host, spawned, exits } = setup(t)
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

test('write, resize and a duplicate spawn', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  host.write('p1', 'ls\r')
  host.resize('p1', 100, 40)
  assert.deepEqual(spawned[0].written, ['ls\r'])
  assert.deepEqual(spawned[0].size, [100, 40])
  assert.equal(host.info('p1').cols, 100)
  assert.throws(() => host.spawn('p1', opts), (e) => e.code === 'BAD_REQUEST' && /already exists/.test(e.message))
  assert.throws(() => host.spawn('p2', { ...opts, cols: 0 }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => host.spawn('p3', { ...opts, rows: 1.5 }), (e) => e.code === 'BAD_REQUEST')
  assert.equal(spawned.length, 1)
  assert.throws(() => host.resize('p1', 0, 10), (e) => e.code === 'BAD_REQUEST')
})

test('the ring buffer keeps the newest output', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const chunk = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 4; i++) spawned[0].emit(chunk)
  const a = sink()
  host.attach('p1', a)
  assert.equal(a.events.length, 2)
  assert.equal(a.events[0].seq, 2 * 1024 * 1024)
})

test('a congested sink pauses the pty until every sink drains', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  let buffered = 0
  host.attach('p1', sink(() => buffered))
  host.attach('p1', sink())
  buffered = 5 * MiB
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, true)
  buffered = 0
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawned[0].paused, false)
})

test('detachAll removes a sink everywhere', (t) => {
  const { host, spawned } = setup(t)
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

test('the headless screen: bracketed paste mode and the last lines', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  assert.equal(host.bracketedPaste('p1'), false)
  spawned[0].emit('\x1b[?2004h')
  spawned[0].emit('line one\r\nline two\r\n')
  await host.settled('p1')
  assert.equal(host.bracketedPaste('p1'), true)
  assert.deepEqual(host.screen('p1', 2), ['line one', 'line two'])
})

test('disposeAll kills everything without owner exits', async (t) => {
  const { host, spawned, exits } = setup(t)
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  host.disposeAll()
  await flush()
  assert.ok(spawned.every((p) => p.killed))
  assert.deepEqual(exits, [])
})

test('a sink between the water marks stays paused until it drops below low water', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  let buffered = 3 * MiB
  host.attach('p1', sink(() => buffered))
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, false, '3 MiB alone does not pause')
  buffered = 4 * MiB + 1
  spawned[0].emit('b')
  assert.equal(spawned[0].paused, true)
  buffered = 3 * MiB
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(spawned[0].paused, true, 'still above low water')
  buffered = 2 * MiB - 1
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawned[0].paused, false)
})

test('an attach whose replay throws leaves the sink unattached', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  spawned[0].emit('a')
  let calls = 0
  const bad = { send() { calls++; throw new Error('gone') }, bufferedAmount: () => 0 }
  assert.throws(() => host.attach('p1', bad), /gone/)
  spawned[0].emit('b')
  assert.equal(calls, 1, 'live data does not reach a sink whose attach failed')
  const ok = sink()
  host.attach('p1', ok)
  assert.equal(ok.events.length, 2)
})

test('detaching the only congested sink while paused resumes the pty', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  let buffered = 0
  const busy = sink(() => buffered)
  host.attach('p1', busy)
  buffered = 5 * MiB
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, true)
  host.detach('p1', busy)
  assert.equal(spawned[0].paused, false)
})

test('a sink whose send throws is dropped; the others still get the data', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  let calls = 0
  const bad = { send(event, payload) { if (!payload.replay) { calls++; throw new Error('gone') } }, bufferedAmount: () => 0 }
  const good = sink()
  host.attach('p1', bad)
  host.attach('p1', good)
  spawned[0].emit('one')
  spawned[0].emit('two')
  assert.equal(calls, 1)
  assert.deepEqual(good.events.map((e) => e.data), ['one', 'two'])
})

test('a sink whose bufferedAmount throws during a drain poll is dropped', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  let mode = 'idle'
  const bad = { send() {}, bufferedAmount() { if (mode === 'throw') throw new Error('gone'); return mode === 'busy' ? 5 * MiB : 0 } }
  host.attach('p1', bad)
  mode = 'busy'
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, true)
  mode = 'throw'
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawned[0].paused, false)
})

test('after ring buffer trimming, the replay ends at info().seq', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  for (let i = 0; i < 7; i++) spawned[0].emit(String(i).repeat(700 * 1024 + i))
  const a = sink()
  const info = host.attach('p1', a)
  const last = a.events.at(-1)
  assert.ok(a.events[0].seq > 0)
  assert.equal(last.seq + last.data.length, info.seq)
  for (let i = 1; i < a.events.length; i++) {
    assert.equal(a.events[i].seq, a.events[i - 1].seq + a.events[i - 1].data.length)
  }
})

test('a big output burst with no client attached pauses on the parser and resumes after', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const proc = spawned[0]
  const chunk = ('y'.repeat(79) + '\r\n').repeat(800) // ~64 KiB
  const LIMIT = 100 * MiB
  const deadline = Date.now() + 3000
  let offered = 0
  let sawPause = false
  let error
  await new Promise((resolve) => {
    const step = () => {
      try {
        // A burst: up to 1 MiB per turn, as long as the pty is not paused.
        for (let i = 0; i < 16 && !proc.paused && offered < LIMIT; i++) {
          proc.emit(chunk)
          offered += chunk.length
        }
      } catch (err) {
        error = err
        return resolve()
      }
      if (proc.paused) sawPause = true
      if (offered >= LIMIT || Date.now() > deadline) resolve()
      else setImmediate(step)
    }
    step()
  })
  assert.equal(error, undefined)
  assert.ok(sawPause, `the pty paused (offered ${offered} bytes)`)
  const until = Date.now() + 10_000
  while (proc.paused && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  assert.equal(proc.paused, false, 'resumed once parsing caught up')
})

test('a process that ignores SIGHUP gets SIGKILL after the kill timeout', async (t) => {
  const { host, spawned, exits } = setup(t, { killTimeoutMs: 50 })
  host.spawn('p1', opts)
  spawned[0].ignoreHup = true
  const a = sink()
  host.attach('p1', a)
  host.kill('p1')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(spawned[0].signals, [undefined])
  assert.equal(host.has('p1'), false, 'a dying pty counts as gone')
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(spawned[0].signals, [undefined, 'SIGKILL'])
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 129 })
  assert.deepEqual(exits, [])
})

test('count includes ptys being killed until their process exits', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  assert.equal(host.count(), 2)
  spawned[0].ignoreHup = true
  host.kill('p1')
  await flush()
  assert.equal(host.has('p1'), false)
  assert.equal(host.count(), 2, 'a dying pty still counts')
  spawned[0].exit(137)
  assert.equal(host.count(), 1)
  host.kill('p2')
  await flush()
  assert.equal(host.count(), 0)
})

test('a pty that exits after kill does not get SIGKILL', async (t) => {
  const { host, spawned } = setup(t, { killTimeoutMs: 30 })
  host.spawn('p1', opts)
  host.kill('p1')
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(spawned[0].signals, [undefined])
})

test('write and resize on a pty being killed answer PTY_NOT_FOUND', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  host.kill('p1')
  assert.equal(host.has('p1'), false)
  assert.throws(() => host.write('p1', 'x'), (e) => e.code === 'PTY_NOT_FOUND')
  assert.throws(() => host.resize('p1', 10, 10), (e) => e.code === 'PTY_NOT_FOUND')
  assert.deepEqual(spawned[0].written, [])
})

test('data emitted after exit is ignored', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  spawned[0].exit(0)
  spawned[0].emit('late')
  assert.equal(a.events.at(-1).event, 'pty.exit')
})

test('an owner onExit that throws is contained', (t) => {
  const fake = fakeSpawner()
  const host = new TerminalHost({ spawner: fake.spawner, onExit: () => { throw new Error('owner bug') } })
  t.after(() => host.disposeAll())
  host.spawn('p1', opts)
  assert.doesNotThrow(() => fake.spawned[0].exit(1))
  assert.equal(host.has('p1'), false)
})

test('screen() validates lines and joins a wrapped line without losing the space at the wrap column', async (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', { ...opts, cols: 10, rows: 5 })
  // 25 characters; a space falls on column 10, the last cell of the first row.
  const text = 'abcdefghi jklmnopqrstuvwx'
  assert.equal(text.length, 25)
  spawned[0].emit(text + '\r\n')
  await host.settled('p1')
  assert.deepEqual(host.screen('p1', 1), [text])
  for (const bad of [0, -1, 1.5, 10_001, NaN]) {
    assert.throws(() => host.screen('p1', bad), (e) => e.code === 'BAD_REQUEST')
  }
})

test('attach refuses a congested connection without replaying or attaching', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  spawned[0].emit('hello')
  const busy = sink(() => 5 * MiB)
  let refused
  assert.throws(() => host.attach('p1', busy), (e) => (refused = e).code === 'CONGESTED' && /congested/.test(e.message))
  assert.deepEqual(toWireError('pty.attach', refused), { code: 'CONGESTED', message: 'the connection is congested; try again' })
  assert.deepEqual(busy.events, [])
  spawned[0].emit('more')
  assert.deepEqual(busy.events, [], 'not attached')
  assert.equal(spawned[0].paused, false)
})

test('onOutput sees live output, never replay; onBell fires for a real bell only', async (t) => {
  const outputs = []
  const bells = []
  const { host, spawned } = setup(t, { onOutput: (id, d) => outputs.push([id, d]), onBell: (id) => bells.push(id) })
  host.spawn('p1', opts)
  spawned[0].emit('hi')
  host.attach('p1', sink())
  assert.deepEqual(outputs, [['p1', 'hi']], 'attach replays without calling onOutput')
  spawned[0].emit('\x1b]0;title\x07')
  spawned[0].emit('ding\x07')
  await host.settled('p1')
  assert.deepEqual(bells, ['p1'])
})

test('a throwing onOutput or onBell never breaks streaming', async (t) => {
  const { host, spawned } = setup(t, { onOutput: () => { throw new Error('boom') }, onBell: () => { throw new Error('boom') } })
  const orig = console.error
  console.error = () => {}
  t.after(() => { console.error = orig })
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  spawned[0].emit('x\x07')
  await host.settled('p1')
  assert.equal(a.events.at(-1).data, 'x\x07')
})

test('isAttached', (t) => {
  const { host } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  assert.equal(host.isAttached('p1', a), false)
  host.attach('p1', a)
  assert.equal(host.isAttached('p1', a), true)
  host.detach('p1', a)
  assert.equal(host.isAttached('p1', a), false)
  assert.equal(host.isAttached('nope', a), false)
})

test('forceKillAll sends SIGKILL to every pty still alive', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  const signals = []
  for (const p of spawned) p.kill = (signal) => signals.push(signal ?? 'SIGHUP')
  host.forceKillAll()
  assert.deepEqual(signals, ['SIGKILL', 'SIGKILL'])
})

test('spawn and resize cap sizes at 500 columns and 200 rows', (t) => {
  const { host } = setup(t)
  const bad = (e) => e.code === 'BAD_REQUEST'
  assert.throws(() => host.spawn('p1', { ...opts, cols: 501 }), bad)
  assert.throws(() => host.spawn('p1', { ...opts, rows: 201 }), bad)
  host.spawn('p1', { ...opts, cols: 500, rows: 200 })
  assert.throws(() => host.resize('p1', 501, 24), bad)
  assert.throws(() => host.resize('p1', 80, 201), bad)
  host.resize('p1', 500, 200)
})
