// scripts/botRunner.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRunner } from '../src/host/bot/runner.ts'
import { createBotFolder, loadState, localDate, saveState } from '../src/host/bot/memory.ts'

const DAY = 86_400_000
const SNAP = { worktrees: [], sessions: [] }

/** A runner with a fake turn: each turn stays open until `finish` is called. */
function setup(prepare, { fresh = false } = {}) {
  const folder = join(mkdtempSync(join(tmpdir(), 'bot-run-')), 'P.trekbot')
  createBotFolder(folder)
  writeFileSync(join(folder, 'HEARTBEAT.md'), '- plain duty\n')
  let time = new Date(2026, 10, 2, 9, 0).getTime()
  // A reflection already ran today, so tests opt in by moving the clock.
  if (!fresh) saveState(folder, { ...loadState(folder), lastReflectionDate: localDate(time) })
  prepare?.(folder)
  const turns = []
  const views = []
  const events = []
  const t = {
    folder, turns, views, events, snapshot: SNAP, snapshotError: null,
    gate: null, turnError: null, turnRejects: null, sessionIdError: null, nowError: null, listenerError: null,
    folderMissing: 0, onFolderMissing: null,
    now: () => {
      if (t.nowError) throw new Error(t.nowError)
      return time
    },
    advance: (ms) => { time += ms },
    finish: async (outcome = { kind: 'ok', text: 'fine' }, index = turns.length - 1) => {
      turns[index].resolve(outcome)
      await t.runner.idle()
    }
  }
  t.runner = new BotRunner({
    folder,
    secretPaths: [],
    now: t.now,
    newSessionId: () => {
      if (t.sessionIdError) throw new Error(t.sessionIdError)
      return `session-${turns.length}`
    },
    snapshot: async () => {
      await t.gate
      if (t.snapshotError) throw new Error(t.snapshotError)
      return t.snapshot
    },
    runTurn: (request, onEvent) => {
      if (t.turnError) throw new Error(t.turnError)
      if (t.turnRejects) return { done: Promise.reject(new Error(t.turnRejects)), kill: () => {} }
      let resolve
      const done = new Promise((r) => (resolve = r))
      const turn = { request, onEvent, resolve, killed: false }
      turns.push(turn)
      return { done, kill: () => { turn.killed = true; resolve({ kind: 'killed', text: 'stopped' }) } }
    },
    onView: (view) => {
      if (t.listenerError) throw new Error(t.listenerError)
      views.push(view)
    },
    onEvent: (event) => {
      if (t.listenerError) throw new Error(t.listenerError)
      events.push(event)
      t.onEventHook?.(event)
    },
    onFolderMissing: () => {
      t.folderMissing++
      t.onFolderMissing?.()
    }
  })
  return t
}
const started = async (t, count) => {
  for (let i = 0; i < 50 && t.turns.length < count; i++) await new Promise((r) => setImmediate(r))
  assert.equal(t.turns.length, count)
}

test('first heartbeat wakes the bot, then nothing changed means no turn', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.kind, 'heartbeat')
  await t.finish()
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
})

test('a change wakes the bot with a summary', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  t.snapshot = { worktrees: [{ path: '/new', branch: 'b', head: 'h' }], sessions: [] }
  void t.runner.beat()
  await started(t, 2)
  assert.match(t.turns[1].request.wake.text, /\/new/)
})

test('a heartbeat while busy is skipped and not queued', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('hello')
  await started(t, 1)
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
  await t.finish()
  assert.equal(t.turns.length, 1)
})

test('chat while busy queues in order and runs ahead of a heartbeat', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('one')
  await started(t, 1)
  t.runner.send('two')
  t.runner.send('three')
  assert.equal(loadState(t.folder).queue.length, 2)
  t.turns[0].resolve({ kind: 'ok', text: '' })
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.text, 'two')
  t.turns[1].resolve({ kind: 'ok', text: '' })
  await started(t, 3)
  assert.equal(t.turns[2].request.wake.text, 'three')
  await t.finish()
})

test('only one turn ever runs', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  t.runner.send('b')
  void t.runner.beat()
  await new Promise((r) => setImmediate(r))
  assert.equal(t.turns.length, 1)
})

test('a scheduled duty wakes the bot once per interval', async () => {
  const t = setup()
  writeFileSync(join(t.folder, 'HEARTBEAT.md'), '- [every 2h] Check CI\n')
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  assert.match(t.turns[0].request.wake.text, /Check CI/)
  await t.finish()
  t.advance(3_600_000)
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
  t.advance(3_600_000)
  void t.runner.beat()
  await started(t, 2)
})

test('reflection runs once a day, skips the change check, and restarts the conversation', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  const before = t.turns[0].request
  assert.equal(before.resume, false)
  t.advance(DAY)
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'reflection')
  assert.equal(t.turns[1].request.resume, true)
  await t.finish()
  await t.runner.beat()
  assert.equal(t.turns.length, 2)
  assert.equal(loadState(t.folder).sessionId, null)
})

test('a reflection due while busy runs at the next idle beat', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('x')
  await started(t, 1)
  t.advance(DAY)
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
  await t.finish()
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'reflection')
})

test('paused: nothing runs, chat queues, resume drains', async () => {
  const t = setup()
  t.runner.start()
  t.runner.setPaused(true)
  t.runner.send('later')
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
  t.runner.setPaused(false)
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'later')
})

test('turn cap stops heartbeats but not chat', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'config.json'), '{"dailyTurnCap":1}'))
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  t.snapshot = { worktrees: [{ path: '/x', branch: 'b', head: 'h' }], sessions: [] }
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
  t.runner.send('still here')
  await started(t, 2)
  await t.finish()
  t.advance(DAY)
  void t.runner.beat()
  await started(t, 3)
})

test('failures back off, keep chat, then pause at three', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(t.turns.length, 1)
  assert.equal(loadState(t.folder).queue[0].text, 'msg')
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'timeout', text: 'slow' })
  t.advance(4 * 60_000)
  await t.runner.beat()
  assert.equal(t.turns.length, 2)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 3)
  await t.finish({ kind: 'crash', text: 'boom' })
  const view = t.views.at(-1)
  assert.equal(view.phase, 'error')
  assert.match(view.decision, /stopped/i)
  t.advance(DAY)
  await t.runner.beat()
  assert.equal(t.turns.length, 3)
  t.runner.setPaused(false)
  await started(t, 4)
  await t.finish()
  assert.equal(loadState(t.folder).failures, 0)
})

test('auth failure pauses straight away', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.finish({ kind: 'auth', text: 'Not logged in' })
  assert.equal(t.views.at(-1).phase, 'error')
  assert.match(t.views.at(-1).reason, /logged in/)
  assert.equal(loadState(t.folder).queue.length, 1)
})

test('usage limit waits for the next heartbeat and is not a failure', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.finish({ kind: 'limit', text: 'limit' })
  assert.equal(loadState(t.folder).failures, 0)
  t.runner.send('another')
  assert.equal(t.turns.length, 1)
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.text, 'msg')
})

test('resume failure retries once with a new conversation and is not a failure', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  await t.finish()
  t.runner.send('b')
  await started(t, 2)
  assert.equal(t.turns[1].request.resume, true)
  t.turns[1].resolve({ kind: 'resume', text: 'gone' })
  await started(t, 3)
  assert.equal(t.turns[2].request.resume, false)
  assert.equal(t.turns[2].request.wake.text, 'b')
  await t.finish()
  assert.equal(loadState(t.folder).failures, 0)
})

test('a change during a heartbeat turn wakes the next beat', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  t.snapshot = { worktrees: [{ path: '/during', branch: 'b', head: 'h' }], sessions: [] }
  await t.finish()
  void t.runner.beat()
  await started(t, 2)
  assert.match(t.turns[1].request.wake.text, /\/during/)
})

test("the bot's own HEARTBEAT.md edit does not wake it", async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  writeFileSync(join(t.folder, 'HEARTBEAT.md'), '- edited by the bot\n')
  await t.finish()
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
})

test('a chat turn does not hide a change from the next beat', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  t.snapshot = { worktrees: [{ path: '/x', branch: 'b', head: 'h' }], sessions: [] }
  t.runner.send('hi')
  await started(t, 2)
  await t.finish()
  void t.runner.beat()
  await started(t, 3)
  assert.match(t.turns[2].request.wake.text, /\/x/)
})

test('a failed snapshot runs no turn', async () => {
  const t = setup()
  t.snapshotError = 'window busy'
  t.runner.start()
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
})

test('stop kills the turn, keeps chat and journals it', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.runner.stop()
  assert.equal(t.turns[0].killed, true)
  const state = loadState(t.folder)
  assert.equal(state.queue[0].text, 'msg')
  assert.equal(state.activeTurn, null)
  assert.match(readFileSync(join(t.folder, 'journal', `${localDate(t.now())}.md`), 'utf8'), /stopped/i)
})

test('a crash mid-turn is noted and its chat recovered on the next start', async () => {
  const t = setup((folder) =>
    saveState(folder, { ...loadState(folder), activeTurn: { kind: 'chat', text: 'lost' } })
  )
  t.runner.start()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'lost')
  assert.match(readFileSync(join(t.folder, 'journal', `${localDate(t.now())}.md`), 'utf8'), /interrupted/i)
})

const push = { tool: 'Bash', input: { command: 'git push' } }
const pendingId = (t) => t.runner.view().approvals.at(-1).id

test('approval flow: request, approve, one use', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  assert.equal(t.runner.checkTool(push).decision, 'ask')
  t.runner.requestApproval(push.tool, push.input, 'ship it')
  const id = pendingId(t)
  assert.equal(t.views.at(-1).approvals[0].id, id)
  assert.match(t.views.at(-1).decision, /ship it/)
  t.runner.decideApproval(id, true)
  t.turns[0].resolve({ kind: 'ok', text: '' })
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'approval')
  assert.match(t.turns[1].request.wake.text, /approved/)
  assert.equal(t.views.at(-1).decision, null)
  assert.equal(t.runner.checkTool(push).decision, 'allow')
  assert.equal(t.runner.checkTool(push).decision, 'ask')
})

test('a denied approval is removed and the bot is told', async () => {
  const t = setup()
  t.runner.start()
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), false)
  await started(t, 1)
  assert.match(t.turns[0].request.wake.text, /denied/)
  assert.deepEqual(loadState(t.folder).approvals, [])
  assert.equal(t.runner.checkTool(push).decision, 'ask')
})

test('duplicate requests share an approval; never-tier requests are refused', () => {
  const t = setup()
  t.runner.start()
  const a = t.runner.requestApproval(push.tool, push.input, 'r')
  assert.equal(t.runner.requestApproval(push.tool, { ...push.input, description: 'x' }, 'r'), a)
  assert.throws(() => t.runner.requestApproval('Bash', { command: 'git push -f' }, 'r'), /never/i)
})

test('approvals survive a restart', () => {
  const t = setup()
  t.runner.start()
  t.runner.requestApproval(push.tool, push.input, 'r')
  assert.equal(loadState(t.folder).approvals[0].status, 'pending')
})

// --- The lock must never wedge ---

const quiet = (t) => t.mock.method(console, 'error', () => {})
const tick = () => new Promise((r) => setImmediate(r))

test('a runTurn that throws counts as a crash and leaves the bot usable', async () => {
  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  const t = setup()
  t.turnError = 'spawn blew up'
  t.runner.start()
  t.runner.send('msg')
  await t.runner.idle()
  await tick()
  process.off('unhandledRejection', onRejection)
  assert.deepEqual(rejections, [])
  const state = loadState(t.folder)
  assert.equal(state.failures, 1)
  assert.equal(state.activeTurn, null)
  assert.equal(state.queue[0].text, 'msg')
  assert.equal(t.views.at(-1).phase, 'idle')
  assert.ok(t.events.some((e) => e.kind === 'error' && /spawn blew up/.test(e.text)))
  t.turnError = null
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'msg')
  await t.finish()
  assert.equal(loadState(t.folder).failures, 0)
})

test('turn start errors pause at three like any other crash', async () => {
  const t = setup()
  t.turnError = 'nope'
  t.runner.start()
  t.runner.send('msg')
  await t.runner.idle()
  t.advance(60_000)
  await t.runner.beat()
  t.advance(5 * 60_000)
  await t.runner.beat()
  assert.equal(t.views.at(-1).phase, 'error')
  assert.equal(loadState(t.folder).failures, 3)
})

test('a new session id failure before the turn also releases the lock', async () => {
  const t = setup()
  t.sessionIdError = 'no entropy'
  t.runner.start()
  t.runner.send('msg')
  await t.runner.idle()
  assert.equal(t.turns.length, 0)
  assert.equal(loadState(t.folder).failures, 1)
  assert.equal(loadState(t.folder).activeTurn, null)
})

test('a turn whose done promise rejects is a crash', async () => {
  const t = setup()
  t.turnRejects = 'pipe burst'
  t.runner.start()
  t.runner.send('msg')
  await t.runner.idle()
  assert.equal(loadState(t.folder).failures, 1)
  assert.equal(t.views.at(-1).phase, 'idle')
})

test('afterTurn throwing still clears the lock', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.runner.start()
  t.runner.send('one')
  await started(t, 1)
  await t.finish({ kind: 'ok' }) // no text, so the summary throws
  assert.equal(t.views.at(-1).phase, 'idle')
  t.runner.send('two')
  await started(t, 2)
})

test('a throwing view or event listener cannot break a turn', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.listenerError = 'renderer gone'
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  t.turns[0].onEvent({ kind: 'text', text: 'hello' })
  await t.finish()
  t.listenerError = null
  assert.equal(loadState(t.folder).activeTurn, null)
  t.runner.send('next')
  await started(t, 2)
})

// --- Poison wakes ---

async function failThreeTimes(t, text = 'poison') {
  t.runner.send(text)
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(5 * 60_000)
  void t.runner.beat()
  await started(t, 3)
  await t.finish({ kind: 'crash', text: 'boom' })
}

test('three failures pause, naming the message and promising one more try', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  const view = t.views.at(-1)
  assert.equal(view.phase, 'error')
  assert.match(view.reason, /poison/)
  assert.match(view.reason, /once more/)
})

test('after resume a poison chat gets one more turn, then is dropped without pausing', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  t.runner.send('innocent')
  t.runner.setPaused(false)
  await started(t, 4)
  assert.equal(t.turns[3].request.wake.text, 'poison')
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.notEqual(t.views.at(-1).phase, 'error')
  assert.equal(loadState(t.folder).paused, false)
  assert.deepEqual(loadState(t.folder).queue.map((w) => w.text), ['innocent'])
  assert.equal(loadState(t.folder).wakeFailures, 0)
  assert.ok(t.events.some((e) => e.kind === 'error' && /poison/.test(e.text) && /dropped/i.test(e.text)))
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 5)
  assert.equal(t.turns[4].request.wake.text, 'innocent')
})

test('a poison chat that succeeds on its last try is kept', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  t.runner.setPaused(false)
  await started(t, 4)
  await t.finish()
  assert.deepEqual(loadState(t.folder).queue, [])
  assert.equal(loadState(t.folder).wakeFailures, 0)
  assert.ok(!t.events.some((e) => /dropped/i.test(e.text)))
})

test('the failure count of a poison wake survives a restart', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  const saved = loadState(t.folder)
  assert.equal(saved.wakeFailures, 3)
  assert.equal(saved.queue[0].text, 'poison')
  assert.ok(!JSON.stringify(saved.queue).includes('wakeFailures'))
  const events = []
  const again = new BotRunner({
    folder: t.folder, secretPaths: [], now: t.now, newSessionId: () => 'x', snapshot: async () => SNAP,
    runTurn: () => ({ done: Promise.resolve({ kind: 'crash', text: 'boom' }), kill: () => {} }),
    onView: () => {}, onEvent: (e) => events.push(e), onFolderMissing: () => {}
  })
  again.start()
  again.setPaused(false)
  await again.idle()
  assert.deepEqual(loadState(t.folder).queue, [])
  assert.ok(events.some((e) => /Dropped chat wake.*poison/.test(e.text)))
})

test('dropping a poison approval wake deletes its approval too', async () => {
  const t = setup()
  t.runner.start()
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(5 * 60_000)
  void t.runner.beat()
  await started(t, 3)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(loadState(t.folder).approvals.length, 1)
  t.runner.setPaused(false)
  await started(t, 4)
  await t.finish({ kind: 'crash', text: 'boom' })
  const state = loadState(t.folder)
  assert.deepEqual(state.queue, [])
  assert.deepEqual(state.approvals, [])
  assert.ok(t.events.some((e) => e.kind === 'error' && /dropped/i.test(e.text) && /approval/.test(e.text)))
})

test('a pause reached partly by heartbeat failures retries the chat on resume', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(5 * 60_000)
  t.runner.send('msg')
  await started(t, 3)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(t.views.at(-1).phase, 'error')
  assert.equal(loadState(t.folder).wakeFailures, 1)
  t.runner.setPaused(false)
  await started(t, 4)
  assert.equal(t.turns[3].request.wake.text, 'msg')
})

test('three failures of one chat always pause, even across a resume', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(5 * 60_000)
  t.runner.send('msg')
  await started(t, 3)
  await t.finish({ kind: 'crash', text: 'boom' }) // paused, one failure of msg
  t.runner.setPaused(false)
  await started(t, 4)
  await t.finish({ kind: 'crash', text: 'boom' }) // two
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 5)
  await t.finish({ kind: 'crash', text: 'boom' }) // three, though only two since the resume
  assert.equal(t.views.at(-1).phase, 'error')
  t.runner.setPaused(false)
  await started(t, 6)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(t.turns.length, 6)
  assert.deepEqual(loadState(t.folder).queue, [])
})

test('limits, stops and logins do not count towards dropping a wake', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.finish({ kind: 'limit', text: 'limit' })
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'auth', text: 'Not logged in' })
  t.runner.setPaused(false)
  await started(t, 3)
  await t.runner.stop()
  assert.equal(loadState(t.folder).wakeFailures, 0)
})

test('a success clears the count for the wake', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(loadState(t.folder).wakeFailures, 1)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish()
  assert.equal(loadState(t.folder).wakeFailures, 0)
})

// --- Storage can vanish ---

test('deleting the folder mid-turn stays quiet and reports it once', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  rmSync(t.folder, { recursive: true })
  t.turns[0].onEvent({ kind: 'text', text: 'still talking' })
  assert.equal(t.folderMissing, 1)
  await t.finish()
  t.runner.send('more')
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  t.runner.setPaused(true)
  t.runner.setPaused(false)
  await t.runner.beat()
  await t.runner.idle()
  assert.equal(t.folderMissing, 1)
  assert.equal(existsSync(t.folder), false, 'the folder is never recreated')
})

test('a missing folder pauses with an error and starts no more turns', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  rmSync(t.folder, { recursive: true })
  await t.finish()
  t.runner.send('more')
  await tick()
  assert.equal(t.turns.length, 1)
  const view = t.runner.view()
  assert.equal(view.phase, 'error')
  assert.equal(view.folderMissing, true)
  assert.match(view.reason, /missing/)
})

test('a heartbeat notices a folder that vanished while idle', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.runner.start()
  rmSync(t.folder, { recursive: true })
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
  assert.equal(t.folderMissing, 1)
})

test('losing only state/ logs but is not a missing folder', async (ctx) => {
  const logged = quiet(ctx)
  const t = setup()
  t.runner.start()
  rmSync(join(t.folder, 'state'), { recursive: true })
  t.runner.send('msg')
  await started(t, 1)
  await t.finish()
  assert.equal(t.folderMissing, 0)
  assert.ok(logged.mock.callCount() > 0)
})

test('a throwing onFolderMissing is contained, and it may stop the runner', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.onFolderMissing = () => {
    void t.runner.stop()
    throw new Error('listener failed')
  }
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  rmSync(t.folder, { recursive: true })
  t.turns[0].onEvent({ kind: 'text', text: 'x' })
  assert.equal(t.turns[0].killed, true)
  await t.runner.idle()
  assert.equal(t.folderMissing, 1)
})

// --- Policy failures fail closed ---

test('a malformed POLICY.json denies every tool, with one error event each', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'POLICY.json'), '{"ask":["start_session"],}'))
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  for (const call of [
    { tool: 'mcp__trek-dev__start_session', input: {} },
    { tool: 'Bash', input: { command: 'git status' } }
  ]) {
    const before = t.events.filter((e) => e.kind === 'error').length
    const result = t.runner.checkTool(call)
    assert.equal(result.decision, 'deny')
    assert.match(result.reason, /POLICY\.json/)
    assert.match(result.reason, /fix/i)
    assert.equal(t.events.filter((e) => e.kind === 'error').length, before + 1)
  }
})

test('requestApproval refuses with the same reason when POLICY.json is malformed', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'POLICY.json'), '[1,'))
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  const { reason } = t.runner.checkTool(push)
  assert.throws(() => t.runner.requestApproval(push.tool, push.input, 'r'), (err) => err.message === reason)
  assert.deepEqual(loadState(t.folder).approvals, [])
})

test('an analyser error denies rather than throws', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  const call = { tool: 'Bash', input: { command: `echo ${'a'.repeat(65 * 1024)}` } }
  const result = t.runner.checkTool(call)
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /too long/)
  assert.throws(() => t.runner.requestApproval(call.tool, call.input, 'r'), /too long/)
})

test('an approval is not used up by a check denied for a broken POLICY.json', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  writeFileSync(join(t.folder, 'POLICY.json'), 'nope')
  assert.equal(t.runner.checkTool(push).decision, 'deny')
  writeFileSync(join(t.folder, 'POLICY.json'), '{}')
  assert.equal(t.runner.checkTool(push).decision, 'allow')
})

// --- beat and start can't fail ---

test('beat never rejects and start never throws', async (ctx) => {
  quiet(ctx)
  const t = setup((folder) =>
    saveState(folder, { ...loadState(folder), activeTurn: { kind: 'chat', text: 'lost' } })
  )
  t.nowError = 'clock broke'
  assert.doesNotThrow(() => t.runner.start())
  await assert.doesNotReject(t.runner.beat())
  t.nowError = null
  await t.runner.idle()
  t.runner.send('works')
  await tick()
  assert.ok(t.turns.length >= 1)
})

test('a failed heartbeat saves no snapshot, and a later success saves its own', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(loadState(t.folder).snapshot, null)
  t.snapshot = { worktrees: [{ path: '/later', branch: 'b', head: 'h' }], sessions: [] }
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish()
  assert.equal(loadState(t.folder).snapshot.worktrees[0].path, '/later')
})

// --- Corrupt state ---

test('a corrupt state file shows as an error and resume works', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'state', 'state.json'), '{not json'))
  assert.equal(t.runner.view().phase, 'error')
  assert.match(t.runner.view().reason, /corrupt/)
  t.runner.start()
  assert.equal(t.views.at(-1).phase, 'error')
  t.runner.send('queued')
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
  t.runner.setPaused(false)
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'queued')
  assert.equal(t.views.at(-1).phase, 'working')
})

// --- The change check holds the lock ---

function gated(t) {
  let open
  t.gate = new Promise((r) => (open = r))
  return () => {
    t.gate = null
    open()
  }
}

test('chat waits for the change check, then runs ahead of its heartbeat', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  t.runner.send('hello')
  await tick()
  assert.equal(t.turns.length, 0)
  assert.equal(loadState(t.folder).queue.length, 1)
  open()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.kind, 'chat')
  assert.equal(t.turns[0].request.wake.text, 'hello')
  await t.finish()
  await beat
  // The heartbeat it displaced is seen again by the next beat.
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'heartbeat')
})

test('chat queued during a check with nothing to report runs when it ends', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  t.runner.send('hello')
  await tick()
  assert.equal(t.turns.length, 1)
  open()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.text, 'hello')
  await t.finish()
  await beat
})

test('a heartbeat during a change check is skipped', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  await t.runner.beat()
  assert.ok(t.events.some((e) => e.kind === 'skip'))
  open()
  await started(t, 1)
  await t.finish()
  await beat
})

test('pausing during a change check starts no turn', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  t.runner.setPaused(true)
  open()
  await beat
  assert.equal(t.turns.length, 0)
})

test('stopping during a change check starts no turn and releases the lock', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  await t.runner.stop() // returns without waiting for the snapshot
  assert.equal(t.runner.busy, false)
  open()
  await beat
  assert.equal(t.turns.length, 0)
})

test('a failed check releases the lock so queued chat runs', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  t.snapshotError = 'window busy'
  const beat = t.runner.beat()
  await tick()
  t.runner.send('hello')
  open()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'hello')
  await t.finish()
  await beat
})

// --- Turn cap of zero ---

test('a daily cap of 0 means no autonomous turns, but chat still runs', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'config.json'), '{"dailyTurnCap":0}'))
  t.runner.start()
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
  t.advance(DAY) // a reflection is now due as well
  await t.runner.beat()
  assert.equal(t.turns.length, 0)
  t.runner.send('hi')
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.kind, 'chat')
  await t.finish()
  await t.runner.beat()
  assert.equal(t.turns.length, 1)
})

// --- Approval lifecycle ---

const approvedInTurn = async (t, n = 1) => {
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  await started(t, n)
}

test('an approved approval is deleted when its wake ends ok, used or not', async () => {
  const t = setup()
  t.runner.start()
  await approvedInTurn(t)
  assert.equal(loadState(t.folder).approvals.length, 1)
  await t.finish()
  assert.deepEqual(loadState(t.folder).approvals, [])
  t.runner.send('next')
  await started(t, 2)
  assert.equal(t.runner.checkTool(push).decision, 'ask')
})

test('another turn ending does not delete an approval waiting for its wake', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  t.turns[0].resolve({ kind: 'ok', text: '' })
  await started(t, 2)
  assert.equal(loadState(t.folder).approvals.length, 1)
})

test('requesting a call that is already approved says to run it now', async () => {
  const t = setup()
  t.runner.start()
  const first = t.runner.requestApproval(push.tool, push.input, 'r')
  assert.match(first, /End your turn/)
  assert.equal(t.runner.requestApproval(push.tool, push.input, 'r'), first)
  t.runner.decideApproval(pendingId(t), true)
  await started(t, 1)
  const again = t.runner.requestApproval(push.tool, push.input, 'again')
  assert.match(again, /already approved/i)
  assert.match(again, /now/)
  assert.doesNotMatch(again, /End your turn/)
  assert.equal(loadState(t.folder).approvals.length, 1)
  assert.equal(t.runner.view().queued, 0)
})

test('the approval wake is written at turn start from the current state', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(pendingId(t), true)
  assert.equal(t.runner.checkTool(push).decision, 'allow') // the running turn uses it first
  t.turns[0].resolve({ kind: 'ok', text: '' })
  await started(t, 2)
  const { text, approvalId } = t.turns[1].request.wake
  assert.match(text, /already used/)
  assert.match(text, /git push/)
  assert.match(text, /took effect/)
  assert.ok(approvalId)
})

test('an approval used by a failed turn reads as used on the retry', async () => {
  const t = setup()
  t.runner.start()
  await approvedInTurn(t)
  assert.match(t.turns[0].request.wake.text, /may now run once/)
  assert.equal(t.runner.checkTool(push).decision, 'allow')
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  assert.match(t.turns[1].request.wake.text, /already used/)
})

test('approvalId survives saving, and a bad one is ignored', () => {
  const t = setup()
  const wake = { kind: 'approval', text: 'x', approvalId: 'a1' }
  saveState(t.folder, { ...loadState(t.folder), queue: [wake, { kind: 'approval', text: 'y', approvalId: 7 }] })
  assert.deepEqual(loadState(t.folder).queue, [wake, { kind: 'approval', text: 'y' }])
})

test('using an approval leaves an event and a journal line', async () => {
  const t = setup()
  t.runner.start()
  await approvedInTurn(t)
  t.runner.checkTool(push)
  assert.ok(t.events.some((e) => e.kind === 'approval' && /used/i.test(e.text) && /git push/.test(e.text)))
  assert.match(readFileSync(join(t.folder, 'journal', `${localDate(t.now())}.md`), 'utf8'), /used.*git push/i)
})

test('checkTool denies when no turn is active and after stop', async () => {
  const t = setup()
  t.runner.start()
  const read = { tool: 'Read', input: { file_path: '/x' } }
  assert.equal(t.runner.checkTool(read).decision, 'deny')
  assert.match(t.runner.checkTool(read).reason, /no .*turn/i)
  t.runner.send('go')
  await started(t, 1)
  assert.equal(t.runner.checkTool(read).decision, 'allow')
  await t.runner.stop()
  assert.equal(t.runner.checkTool(read).decision, 'deny')
})

test('checkTool denies when the bot folder is missing', async (ctx) => {
  quiet(ctx)
  const t = setup()
  t.runner.start()
  t.runner.send('go')
  await started(t, 1)
  rmSync(t.folder, { recursive: true })
  const result = t.runner.checkTool({ tool: 'Read', input: { file_path: '/x' } })
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /folder is missing/)
  assert.equal(t.folderMissing, 1)
  assert.equal(t.runner.view().folderMissing, true)
})

// --- Sessions ---

test('a resumed session that crashes or times out is abandoned', async () => {
  for (const kind of ['crash', 'timeout']) {
    const t = setup()
    t.runner.start()
    t.runner.send('a')
    await started(t, 1)
    await t.finish()
    t.runner.send('b')
    await started(t, 2)
    assert.equal(t.turns[1].request.resume, true)
    await t.finish({ kind, text: 'boom' })
    assert.equal(loadState(t.folder).sessionId, null)
    t.advance(60_000)
    void t.runner.beat()
    await started(t, 3)
    assert.equal(t.turns[2].request.resume, false)
  }
})

test('a reflection can not get stuck on a broken session', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  await t.finish()
  t.advance(DAY)
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'reflection')
  await t.finish({ kind: 'crash', text: 'boom', sessionStarted: true })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 3)
  assert.equal(t.turns[2].request.wake.kind, 'reflection')
  assert.equal(t.turns[2].request.resume, false)
})

test('a fresh turn that failed before the CLI reported a session forgets the id', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom', sessionStarted: false })
  assert.equal(loadState(t.folder).sessionId, null)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.resume, false)
  assert.ok(!t.events.some((e) => /could not resume/i.test(e.text)))
})

test('a fresh turn that failed after the CLI reported a session keeps it', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom', sessionStarted: true })
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.resume, true)
})

// --- Accounting ---

test('only real turns count towards the cap', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('msg')
  await started(t, 1)
  assert.equal(loadState(t.folder).turnsToday, 0)
  await t.finish({ kind: 'limit', text: 'limit' })
  void t.runner.beat()
  await started(t, 2)
  await t.finish({ kind: 'auth', text: 'Not logged in' })
  t.runner.setPaused(false)
  await started(t, 3)
  await t.finish({ kind: 'missing', text: 'gone' })
  t.runner.setPaused(false)
  await started(t, 4)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(loadState(t.folder).turnsToday, 1)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 5)
  await t.runner.stop()
  assert.equal(loadState(t.folder).turnsToday, 1)
})

test('a limit that recurs all day never uses up the cap', async () => {
  const t = setup((folder) => writeFileSync(join(folder, 'config.json'), '{"dailyTurnCap":2}'))
  t.runner.start()
  for (let i = 1; i <= 4; i++) {
    t.advance(60_000)
    void t.runner.beat()
    await started(t, i)
    await t.finish({ kind: 'limit', text: 'limit' })
  }
  assert.equal(loadState(t.folder).turnsToday, 0)
})

test('a backoff further off than the longest one counts as expired', async () => {
  const t = setup()
  t.runner.start()
  t.advance(30 * DAY)
  t.runner.send('a')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  t.advance(-30 * DAY) // the clock is corrected
  t.runner.send('b')
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.text, 'a')
  const u = setup((folder) => saveState(folder, { ...loadState(folder), blockedUntil: new Date(2030, 0, 1).getTime() }))
  u.runner.start()
  void u.runner.beat()
  await started(u, 1)
})

test('reflection takes the date its turn started', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  await t.finish()
  t.advance(DAY + 14 * 3_600_000 + 58 * 60_000) // 23:58 tomorrow
  void t.runner.beat()
  await started(t, 2)
  assert.equal(t.turns[1].request.wake.kind, 'reflection')
  const day = localDate(t.now())
  t.advance(7 * 60_000) // past midnight
  await t.finish()
  assert.equal(loadState(t.folder).lastReflectionDate, day)
  void t.runner.beat()
  await started(t, 3)
  assert.equal(t.turns[2].request.wake.kind, 'reflection')
})

test('a clock moved backwards repeats neither reflection nor the turn count', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  await t.finish()
  assert.equal(loadState(t.folder).turnsToday, 1)
  t.advance(-DAY)
  t.runner.send('b')
  await started(t, 2)
  await t.finish()
  assert.equal(loadState(t.folder).turnsToday, 2)
  void t.runner.beat()
  await started(t, 3)
  assert.equal(t.turns[2].request.wake.kind, 'heartbeat')
})

test("a new bot's first beat is not a reflection", async () => {
  const t = setup(null, { fresh: true })
  assert.equal(loadState(t.folder).lastReflectionDate, null)
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.kind, 'heartbeat')
  assert.equal(loadState(t.folder).lastReflectionDate, localDate(t.now()))
})

// --- Change check timeout ---

test('a snapshot that never answers times out, runs no turn and releases the lock', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const t = setup()
  t.runner.start()
  t.gate = new Promise(() => {})
  const beat = t.runner.beat()
  await tick()
  t.runner.send('waiting')
  ctx.mock.timers.tick(14_999)
  await tick()
  assert.equal(t.turns.length, 0)
  ctx.mock.timers.tick(1)
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.text, 'waiting')
  assert.ok(t.events.some((e) => e.kind === 'error' && /Trek's state/.test(e.text)))
  await t.finish()
  await beat
})

test('a timed-out check with nothing queued runs no turn', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const t = setup()
  t.runner.start()
  t.gate = new Promise(() => {})
  const beat = t.runner.beat()
  await tick()
  ctx.mock.timers.tick(15_000)
  await beat
  assert.equal(t.turns.length, 0)
})

// --- Robustness ---

test('a pause just before spawning runs nothing and requeues the chat', async () => {
  const t = setup()
  t.runner.start()
  t.onEventHook = (e) => { if (e.kind === 'wake') t.runner.setPaused(true) }
  t.runner.send('hi')
  await t.runner.idle()
  t.onEventHook = null
  assert.equal(t.turns.length, 0)
  const state = loadState(t.folder)
  assert.deepEqual(state.queue.map((w) => w.text), ['hi'])
  assert.equal(state.turnsToday, 0)
  assert.equal(state.activeTurn, null)
  t.runner.setPaused(false)
  await started(t, 1)
})

test('a stop just before spawning runs nothing and keeps the chat on disk', async () => {
  const t = setup()
  t.runner.start()
  let stopped
  t.onEventHook = (e) => { if (e.kind === 'wake') { t.onEventHook = null; stopped = t.runner.stop() } }
  t.runner.send('hi')
  await tick()
  await stopped
  assert.equal(t.turns.length, 0)
  const state = loadState(t.folder)
  assert.deepEqual(state.queue.map((w) => w.text), ['hi'])
  assert.equal(state.activeTurn, null)
})

test('phase: error, then an active turn, then paused, then idle', async () => {
  const t = setup()
  t.runner.start()
  t.runner.send('a')
  await started(t, 1)
  assert.equal(t.runner.view().phase, 'working')
  t.runner.setPaused(true)
  assert.equal(t.runner.view().phase, 'working')
  await t.finish()
  assert.equal(t.runner.view().phase, 'paused')
  t.runner.setPaused(false)
  assert.equal(t.runner.view().phase, 'idle')
})

test('a turn publishes idle once, then working', async () => {
  const t = setup()
  t.runner.start()
  t.views.length = 0
  t.runner.send('a')
  await started(t, 1)
  assert.deepEqual([...new Set(t.views.map((v) => v.phase))], ['idle', 'working'])
  assert.equal(t.views.filter((v) => v.phase === 'idle').length, 1)
})

test('idle covers the change check', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  void t.runner.beat()
  await tick()
  let idle = false
  void t.runner.idle().then(() => { idle = true })
  await tick()
  assert.equal(idle, false)
  open()
  await started(t, 1)
  assert.equal(idle, false)
  await t.finish()
  assert.equal(idle, true)
})

test('a turn that fails straight away leaves idle waiting for the next wake', async () => {
  const t = setup()
  t.runner.start()
  t.turnError = 'nope'
  t.runner.send('a')
  await t.runner.idle()
  assert.equal(t.runner.busy, false)
  assert.equal(loadState(t.folder).failures, 1)
})

test('stop is final: nothing runs and nothing writes afterwards', async () => {
  const t = setup()
  t.runner.start()
  const id = (t.runner.requestApproval(push.tool, push.input, 'r'), pendingId(t))
  await t.runner.stop()
  const statePath = join(t.folder, 'state', 'state.json')
  const eventsPath = join(t.folder, 'state', 'events.jsonl')
  const before = [readFileSync(statePath, 'utf8'), readFileSync(eventsPath, 'utf8')]
  const views = t.views.length
  t.runner.send('late')
  t.runner.setPaused(true)
  t.runner.setPaused(false)
  t.runner.decideApproval(id, true)
  await t.runner.beat()
  t.runner.setNextBeat(1)
  t.runner.checkTool(push)
  assert.throws(() => t.runner.requestApproval('Read', {}, 'r'), /stopped/i)
  await tick()
  assert.equal(t.turns.length, 0)
  assert.deepEqual([readFileSync(statePath, 'utf8'), readFileSync(eventsPath, 'utf8')], before)
  assert.equal(t.views.length, views)
})

test('a snapshot failing after stop writes nothing', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  t.snapshotError = 'late'
  const beat = t.runner.beat()
  await tick()
  await t.runner.stop()
  const count = t.events.length
  rmSync(t.folder, { recursive: true })
  open()
  await beat
  await tick()
  assert.equal(t.events.length, count)
  assert.equal(t.folderMissing, 0)
})

test('a crash during a failed turn cannot run its chat twice', async () => {
  const t = setup()
  t.runner.start()
  let onDisk
  t.onEventHook = (e) => {
    if (e.kind === 'error') {
      t.onEventHook = null
      t.runner.send('b') // commits while the failure is being handled
      onDisk = loadState(t.folder)
    }
  }
  t.runner.send('a')
  await started(t, 1)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.deepEqual(onDisk.queue.map((w) => w.text), ['a', 'b'])
  assert.equal(onDisk.activeTurn, null)
})
