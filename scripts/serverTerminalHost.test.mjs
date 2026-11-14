// scripts/serverTerminalHost.test.mjs — v2 ptys: replay, many clients, exit, kill, backpressure, screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalHost } from '../server/src/sessions/terminalHost.ts'
import { codedError, toWireError } from '../server/src/errors.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

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

// The fake ptys are a POSIX host's unless a test says win32 (its kills, its windowsPty), on any OS.
function setup(t, extra = {}) {
  const fake = fakeSpawner()
  const exits = []
  const host = new TerminalHost({ spawner: fake.spawner, onExit: (ptyId, code) => exits.push([ptyId, code]), platform: 'linux', ...extra })
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

test('query replies: one client attached, its replies reach the pty', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  assert.equal(host.writeFrom('p1', a, '\x1b[12;40R'), true)
  assert.equal(host.writeFrom('p1', a, 'ls\r'), true)
  assert.deepEqual(spawned[0].written, ['\x1b[12;40R', 'ls\r'])
})

test('query replies: with two clients only the reply owner (the earliest attached) answers; typing from either goes through', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  const b = sink()
  host.attach('p1', a)
  host.attach('p1', b)
  assert.equal(host.writeFrom('p1', b, '\x1b[?1;2c'), false)
  assert.equal(host.writeFrom('p1', a, '\x1b[?1;2c'), true)
  assert.equal(host.writeFrom('p1', b, 'y'), true)
  assert.equal(host.writeFrom('p1', b, '\x1b[<0;10;5M'), true, 'a mouse report is the user acting')
  assert.equal(host.writeFrom('p1', b, '\x1b[A'), true)
  // Re-attaching the owner (a re-subscribe) keeps it the owner.
  host.attach('p1', a)
  assert.equal(host.writeFrom('p1', b, '\x1b]11;rgb:0/0/0\x07'), false)
  assert.deepEqual(spawned[0].written, ['\x1b[?1;2c', 'y', '\x1b[<0;10;5M', '\x1b[A'])
})

test('query replies: when the owner detaches, the next attached client owns them', (t) => {
  const { host, spawned } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  const b = sink()
  const c = sink()
  host.attach('p1', a)
  host.attach('p1', b)
  host.attach('p1', c)
  host.detach('p1', a)
  assert.equal(host.writeFrom('p1', c, '\x1b[0n'), false)
  assert.equal(host.writeFrom('p1', b, '\x1b[0n'), true)
  host.detachAll(b)
  assert.equal(host.writeFrom('p1', c, '\x1b[0n'), true)
  assert.deepEqual(spawned[0].written, ['\x1b[0n', '\x1b[0n'])
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
  const host = new TerminalHost({ spawner: fake.spawner, onExit: () => { throw new Error('owner bug') }, platform: 'linux' })
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

test('win32: forceKillAll ends each pty\'s tree synchronously, never with a signal', (t) => {
  const trees = []
  const { host, spawned } = setup(t, { platform: 'win32', treeKiller: (pid, sync) => trees.push([pid, sync]) })
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  spawned[0].pid = 101
  spawned[1].pid = 102
  const signals = []
  for (const p of spawned) p.kill = (signal) => signals.push(signal)
  host.forceKillAll()
  assert.deepEqual(trees, [[101, true], [102, true]])
  assert.deepEqual(signals, [])
})

test('win32: kill() sends no signal, and a pty still running at the timeout has its tree killed', async (t) => {
  const trees = []
  const { host, spawned } = setup(t, { platform: 'win32', killTimeoutMs: 10, treeKiller: (pid, sync) => trees.push([pid, sync]) })
  host.spawn('p1', opts)
  spawned[0].pid = 201
  const signals = []
  spawned[0].kill = (signal) => signals.push(signal)
  host.kill('p1')
  assert.deepEqual(signals, [undefined], 'node-pty on Windows throws when given a signal')
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(trees, [[201, false]])
})

test('win32: whenGone never kills the tree of a pty that already exited (Windows reuses pids)', async (t) => {
  const trees = []
  const { host, spawned } = setup(t, { platform: 'win32', treeKiller: (pid, sync) => trees.push([pid, sync]) })
  host.spawn('p1', opts)
  spawned[0].pid = 301
  host.kill('p1')
  assert.equal(await host.whenGone(['p1'], 1000), true)
  assert.deepEqual(trees, [])
})

test('a pty that exits by itself is released, never signalled (Windows may have reused its pid); a killed one is not', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const { host, spawned, exits } = setup(t, { platform, treeKiller: () => assert.fail('there is no tree to end') })
    host.spawn('p1', opts)
    host.spawn('p2', opts)
    const calls = []
    for (const [i, proc] of spawned.entries()) {
      const kill = proc.kill.bind(proc)
      proc.kill = (signal) => { calls.push([i, 'kill', signal]); kill(signal) }
      proc.release = () => calls.push([i, 'release'])
    }
    spawned[0].exit(3)
    assert.deepEqual(calls, [[0, 'release']], platform)
    assert.deepEqual(exits, [['p1', 3]], 'the owner still hears the exit')
    host.kill('p2')
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(calls, [[0, 'release'], [1, 'kill', undefined]], `${platform}: kill() frees a killed pty itself`)
  }
})

test('a pty whose release throws still reports its exit; one without a release is fine', (t) => {
  const { host, spawned, exits } = setup(t)
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  spawned[0].release = () => { throw new Error('gone') }
  const warn = console.warn
  console.warn = () => {}
  t.after(() => { console.warn = warn })
  spawned[0].exit(0)
  spawned[1].exit(1)
  assert.deepEqual(exits, [['p1', 0], ['p2', 1]])
})

test('win32: whenGone kills the tree of a pty that outlives the timeout', async (t) => {
  const trees = []
  const { host, spawned } = setup(t, { platform: 'win32', killTimeoutMs: 60_000, treeKiller: (pid, sync) => trees.push([pid, sync]) })
  host.spawn('p1', opts)
  spawned[0].pid = 401
  spawned[0].kill = () => {}
  host.kill('p1')
  assert.equal(await host.whenGone(['p1'], 30, 30), false)
  assert.deepEqual(trees, [[401, false]])
})

test('a Windows host gives xterm\'s windowsPty in the attach info (and its own screen); elsewhere nothing', (t) => {
  const { host } = setup(t, { platform: 'win32', osRelease: '10.0.22631', treeKiller: () => {} })
  host.spawn('p1', opts)
  assert.deepEqual(host.attach('p1', sink()).windowsPty, { backend: 'conpty', buildNumber: 22631 })
  const mac = setup(t)
  mac.host.spawn('p1', opts)
  assert.equal('windowsPty' in mac.host.attach('p1', sink()), false)
})

test('windowsBuildNumber', async () => {
  const { windowsBuildNumber, windowsPtyFor } = await import('../server/src/sessions/terminalHost.ts')
  assert.equal(windowsBuildNumber('10.0.19045'), 19045)
  assert.equal(windowsBuildNumber('24.6.0'), undefined)
  assert.deepEqual(windowsPtyFor('win32', 'odd'), { backend: 'conpty', buildNumber: 0 })
  assert.equal(windowsPtyFor('linux', '6.1.0'), undefined)
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

test('toWireError carries the details of a passed-through code: only an object, only a string reason', () => {
  assert.deepEqual(toWireError('worktree.remove', codedError('GIT_ERROR', 'dirty', { reason: 'dirty' })), { code: 'GIT_ERROR', message: 'dirty', details: { reason: 'dirty' } })
  assert.deepEqual(toWireError('worktree.remove', codedError('GIT_ERROR', 'locked')), { code: 'GIT_ERROR', message: 'locked' })
  const internal = Object.assign(new Error('boom'), { details: { reason: 'x' } })
  assert.deepEqual(toWireError('session.start', internal), { code: 'INTERNAL', message: 'boom' })
  const odd = Object.assign(codedError('GIT_ERROR', 'x'), { details: ['dirty'] })
  assert.deepEqual(toWireError('worktree.remove', odd), { code: 'GIT_ERROR', message: 'x' })
  const numeric = Object.assign(codedError('GIT_ERROR', 'x'), { details: { reason: 5 } })
  assert.deepEqual(toWireError('worktree.remove', numeric), { code: 'GIT_ERROR', message: 'x' }, 'a reason that is not a string is dropped')
  const extra = Object.assign(codedError('GIT_ERROR', 'x'), { details: { reason: 'dirty', secret: 'y' } })
  assert.deepEqual(toWireError('worktree.remove', extra), { code: 'GIT_ERROR', message: 'x', details: { reason: 'dirty' } }, 'only the named fields')
})

test('whenGone SIGKILLs the pty\'s process group: a background child that ignores SIGHUP does not outlive it', { skip: posixOnly('process groups and SIGHUP') }, async (t) => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'trek-whengone-'))
  const pidFile = join(dir, 'child.pid')
  let childPid
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  t.after(() => {
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL')
    removeDir(dir)
  })
  // The real node-pty: the shell is its session's leader; its background child ignores SIGHUP.
  const host = new TerminalHost({ onExit: () => {} })
  t.after(() => host.disposeAll())
  host.spawn('real', {
    file: '/bin/sh',
    args: ['-c', `(trap '' HUP; exec sleep 30) & echo $! > '${pidFile}'; wait`],
    cwd: dir,
    env: {},
    cols: 80,
    rows: 24
  })
  for (let i = 0; i < 200 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); i++) await new Promise((r) => setTimeout(r, 10))
  childPid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(alive(childPid))
  host.kill('real')
  assert.equal(await host.whenGone(['real'], 3000), true)
  for (let i = 0; i < 100 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(alive(childPid), false, 'the background child is gone')
})

test('a resize that changes the size sends pty.resized to every attached sink; the same size sends nothing', (t) => {
  const { host } = setup(t)
  host.spawn('p1', opts)
  const a = sink()
  const b = sink()
  const outside = sink()
  host.attach('p1', a)
  host.attach('p1', b)
  const resized = (s) => s.events.filter((e) => e.event === 'pty.resized')
  host.resize('p1', 80, 24)
  assert.deepEqual(resized(a), [], 'unchanged: no event')
  host.resize('p1', 120, 40)
  for (const s of [a, b]) assert.deepEqual(resized(s), [{ event: 'pty.resized', ptyId: 'p1', cols: 120, rows: 40 }])
  assert.deepEqual(resized(outside), [])
  host.resize('p1', 120, 40)
  assert.equal(resized(a).length, 1)
  host.detach('p1', b)
  host.resize('p1', 100, 30)
  assert.deepEqual(resized(a).map((e) => [e.cols, e.rows]), [[120, 40], [100, 30]])
  assert.equal(resized(b).length, 1)
})
