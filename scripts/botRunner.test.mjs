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
function setup(prepare) {
  const folder = join(mkdtempSync(join(tmpdir(), 'bot-run-')), 'P.trekbot')
  createBotFolder(folder)
  writeFileSync(join(folder, 'HEARTBEAT.md'), '- plain duty\n')
  let time = new Date(2026, 10, 2, 9, 0).getTime()
  // A reflection already ran today, so tests opt in by moving the clock.
  saveState(folder, { ...loadState(folder), lastReflectionDate: localDate(time) })
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
  // The chat failed all three, so resuming drops it rather than retrying it.
  await new Promise((r) => setImmediate(r))
  assert.equal(t.turns.length, 3)
  assert.equal(loadState(t.folder).failures, 0)
  t.runner.send('next')
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

test('approval flow: request, approve, one use', async () => {
  const t = setup()
  t.runner.start()
  assert.equal(t.runner.checkTool(push).decision, 'ask')
  const id = t.runner.requestApproval(push.tool, push.input, 'ship it')
  assert.equal(t.views.at(-1).approvals[0].id, id)
  assert.match(t.views.at(-1).decision, /ship it/)
  t.runner.decideApproval(id, true)
  await started(t, 1)
  assert.equal(t.turns[0].request.wake.kind, 'approval')
  assert.match(t.turns[0].request.wake.text, /approved/)
  assert.equal(t.views.at(-1).decision, null)
  assert.equal(t.runner.checkTool(push).decision, 'allow')
  assert.equal(t.runner.checkTool(push).decision, 'ask')
})

test('a denied approval is removed and the bot is told', async () => {
  const t = setup()
  t.runner.start()
  const id = t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(id, false)
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

test('a chat that failed three times is dropped on resume and named', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  t.runner.send('innocent')
  assert.equal(t.views.at(-1).phase, 'error')
  assert.equal(loadState(t.folder).queue.length, 2)
  t.runner.setPaused(false)
  await started(t, 4)
  assert.equal(t.turns[3].request.wake.text, 'innocent')
  assert.ok(t.events.some((e) => e.kind === 'error' && /poison/.test(e.text) && /dropped/i.test(e.text)))
  await t.finish()
  const state = loadState(t.folder)
  assert.deepEqual(state.queue, [])
  assert.equal(state.failures, 0)
  assert.equal(state.wakeFailures, 0)
})

test('the failure count of a poison wake survives a restart', async () => {
  const t = setup()
  t.runner.start()
  await failThreeTimes(t)
  const saved = loadState(t.folder)
  assert.equal(saved.wakeFailures, 3)
  assert.equal(saved.queue[0].text, 'poison')
  assert.ok(!JSON.stringify(saved.queue).includes('wakeFailures'))
  // A new runner over the same folder still drops it.
  const events = []
  const again = new BotRunner({
    folder: t.folder, secretPaths: [], now: t.now, newSessionId: () => 'x', snapshot: async () => SNAP,
    runTurn: () => assert.fail('the poison wake must not run'),
    onView: () => {}, onEvent: (e) => events.push(e), onFolderMissing: () => {}
  })
  again.start()
  again.setPaused(false)
  await again.idle()
  assert.deepEqual(loadState(t.folder).queue, [])
  assert.ok(events.some((e) => /Dropped chat wake.*poison/.test(e.text)))
})

test('a poison approval wake is also dropped', async () => {
  const t = setup()
  t.runner.start()
  const id = t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(id, false)
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
  t.runner.setPaused(false)
  await tick()
  assert.equal(t.turns.length, 3)
  assert.deepEqual(loadState(t.folder).queue, [])
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
  await tick()
  assert.equal(t.turns.length, 5)
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
  assert.equal(t.runner.checkTool(push).decision, 'ask')
  const id = t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(id, true)
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

test('a malformed POLICY.json denies every tool, with one error event each', () => {
  const t = setup((folder) => writeFileSync(join(folder, 'POLICY.json'), '{"ask":["start_session"],}'))
  t.runner.start()
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

test('requestApproval refuses with the same reason when POLICY.json is malformed', () => {
  const t = setup((folder) => writeFileSync(join(folder, 'POLICY.json'), '[1,'))
  t.runner.start()
  const { reason } = t.runner.checkTool(push)
  assert.throws(() => t.runner.requestApproval(push.tool, push.input, 'r'), (err) => err.message === reason)
  assert.deepEqual(loadState(t.folder).approvals, [])
})

test('an analyser error denies rather than throws', () => {
  const t = setup()
  t.runner.start()
  const call = { tool: 'Bash', input: { command: `echo ${'a'.repeat(65 * 1024)}` } }
  const result = t.runner.checkTool(call)
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /too long/)
  assert.throws(() => t.runner.requestApproval(call.tool, call.input, 'r'), /too long/)
})

test('an approval is not used up by a check denied for a broken POLICY.json', () => {
  const t = setup()
  t.runner.start()
  const id = t.runner.requestApproval(push.tool, push.input, 'r')
  t.runner.decideApproval(id, true)
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

test('checkedTrek is cleared after each turn, even a failed one', async () => {
  const t = setup()
  t.runner.start()
  void t.runner.beat()
  await started(t, 1)
  assert.notEqual(t.runner.checkedTrek, null)
  await t.finish({ kind: 'crash', text: 'boom' })
  assert.equal(t.runner.checkedTrek, null)
  assert.equal(loadState(t.folder).snapshot, null)
  t.advance(60_000)
  void t.runner.beat()
  await started(t, 2)
  await t.finish()
  assert.equal(t.runner.checkedTrek, null)
  assert.notEqual(loadState(t.folder).snapshot, null)
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
  assert.equal(t.runner.checkedTrek, null)
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
  assert.equal(t.runner.checkedTrek, null)
})

test('stopping during a change check starts no turn and releases the lock', async () => {
  const t = setup()
  t.runner.start()
  const open = gated(t)
  const beat = t.runner.beat()
  await tick()
  await t.runner.stop()
  open()
  await beat
  assert.equal(t.turns.length, 0)
  assert.equal(t.runner.busy, false)
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
