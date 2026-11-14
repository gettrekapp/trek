// scripts/serverAutomations.test.mjs — automations on the server: the input checks and mutations
// (model.ts), the scheduler's tick and runs against a fake session manager (scheduler.ts), and the
// v2 methods (automationHandlers.ts). Nothing here starts an agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AUTOMATIONS, checkInput, clearMissed, deleteAutomation, saveAutomation } from '../server/src/automations/model.ts'

const T0 = Date.UTC(2026, 0, 5, 8, 59)
const input = (over = {}) => ({ name: 'Nightly', prompt: 'Triage the inbox', schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true, ...over })
const code = (fn) => {
  try {
    fn()
    return 'ok'
  } catch (err) {
    return err.code
  }
}
let n = 0
const newId = () => `a${++n}`

test('checkInput takes a valid automation, trimming name and prompt', () => {
  const d = checkInput(input({ name: '  Nightly ', prompt: ' go ' }), T0)
  assert.deepEqual(d, { name: 'Nightly', prompt: 'go', schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true })
  assert.deepEqual(checkInput(input({ llm: { provider: 'claude' } }), T0).llm, { provider: 'claude' })
  assert.equal(checkInput(input({ llm: null }), T0).llm, undefined)
})

test('checkInput refuses bad input with BAD_REQUEST', () => {
  for (const bad of [
    null,
    input({ name: '' }),
    input({ name: 'x'.repeat(81) }),
    input({ prompt: '   ' }),
    input({ prompt: 'x'.repeat(20_001) }),
    input({ schedule: { cron: '* * * * *', tz: 'UTC' } }),
    input({ schedule: { cron: '0 0 31 2 *', tz: 'UTC' } }),
    input({ schedule: { cron: 'nope', tz: 'UTC' } }),
    input({ schedule: { cron: '0 9 * * *', tz: 'Mars/Olympus' } }),
    input({ enabled: 'yes' }),
    input({ llm: { provider: 'nope' } }),
    input({ id: 7 })
  ]) {
    assert.equal(code(() => checkInput(bad, T0)), 'BAD_REQUEST', JSON.stringify(bad))
  }
})

test('saveAutomation creates with lastSlot = now and an empty history', () => {
  const { list, id } = saveAutomation([], checkInput(input(), T0), T0, newId)
  assert.deepEqual(list, [{ id, name: 'Nightly', prompt: 'Triage the inbox', schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true, createdAt: T0, lastSlot: T0, history: [] }])
})

test('saveAutomation updates; a schedule change or re-enable resets lastSlot and clears missed', () => {
  const base = { id: 'a', name: 'N', prompt: 'p', schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true, createdAt: 1, lastSlot: 5, missed: { since: 2, count: 3 }, history: [], llm: { provider: 'claude' } }
  const later = T0 + 1000
  // Same schedule, still enabled: lastSlot and missed kept; llm cleared when absent.
  let { list } = saveAutomation([base], checkInput(input({ id: 'a', name: 'Renamed' }), later), later, newId)
  assert.deepEqual([list[0].name, list[0].lastSlot, list[0].missed, 'llm' in list[0]], ['Renamed', 5, { since: 2, count: 3 }, false])
  ;({ list } = saveAutomation([base], checkInput(input({ id: 'a', schedule: { cron: '0 9 * * *', tz: 'UTC' } }), later), later, newId))
  assert.deepEqual([list[0].lastSlot, list[0].missed], [later, undefined])
  ;({ list } = saveAutomation([{ ...base, enabled: false }], checkInput(input({ id: 'a' }), later), later, newId))
  assert.deepEqual([list[0].lastSlot, list[0].missed], [later, undefined])
  // Disabling drops a pending missed prompt.
  ;({ list } = saveAutomation([base], checkInput(input({ id: 'a', enabled: false }), later), later, newId))
  assert.equal(list[0].missed, undefined)
  assert.equal(code(() => saveAutomation([base], checkInput(input({ id: 'zz' }), later), later, newId)), 'NOT_FOUND')
})

test('saveAutomation: at most MAX_AUTOMATIONS', () => {
  let list = []
  for (let i = 0; i < MAX_AUTOMATIONS; i++) list = saveAutomation(list, checkInput(input(), T0), T0, newId).list
  assert.equal(code(() => saveAutomation(list, checkInput(input(), T0), T0, newId)), 'CAPACITY')
})

test('deleteAutomation and clearMissed', () => {
  const a = { id: 'a', missed: { since: 1, count: 1 } }
  const b = { id: 'b' }
  assert.deepEqual(deleteAutomation([a, b], 'a'), [b])
  assert.equal(code(() => deleteAutomation([b], 'a')), 'NOT_FOUND')
  const { list, cleared } = clearMissed([a, b], ['a', 'b', 'c'])
  assert.deepEqual([list[0].missed, cleared], [undefined, ['a']])
})

import { TopicHub } from '../server/src/topicHub.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { AUTOMATION_HISTORY, AutomationScheduler, LATE_MS, clockFromFile, planTick } from '../server/src/automations/scheduler.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const min = 60_000
const auto = (over = {}) => ({ id: 'a', name: 'Nightly', prompt: 'Triage', schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true, createdAt: T0, lastSlot: T0, history: [], ...over })

test('planTick: an on-time slot is due; earlier ones in the batch are dropped; missed cleared', () => {
  const now = Date.UTC(2026, 0, 5, 9, 11) // slots 9:00, 9:05, 9:10; 9:10 is 1 min old
  const plan = planTick([auto({ missed: { since: 1, count: 2 } })], now)
  assert.deepEqual(plan, { updates: [{ id: 'a', lastSlot: Date.UTC(2026, 0, 5, 9, 10), missed: null }], due: [{ id: 'a', slot: Date.UTC(2026, 0, 5, 9, 10) }] })
})

test('planTick: a late batch adds to missed; disabled and up-to-date automations are left alone', () => {
  const now = Date.UTC(2026, 0, 5, 11, 2, 30) // 9:00 … 11:00 = 25 slots, 11:00 is 2.5 min old
  const plan = planTick([auto(), auto({ id: 'b', enabled: false }), auto({ id: 'c', lastSlot: Date.UTC(2026, 0, 5, 11) })], now)
  assert.deepEqual(plan, { updates: [{ id: 'a', lastSlot: Date.UTC(2026, 0, 5, 11), missed: { since: Date.UTC(2026, 0, 5, 9), count: 25 } }], due: [] })
  const again = planTick([auto({ missed: { since: 7, count: 3 } })], now)
  assert.deepEqual(again.updates[0].missed, { since: 7, count: 28 })
  assert.equal(LATE_MS, 2 * min)
})

test('planTick: an automation whose stored cron no longer parses is skipped', () => {
  assert.deepEqual(planTick([auto({ schedule: { cron: 'bad', tz: 'UTC' } })], T0 + 60 * min), { updates: [], due: [] })
})

function setupScheduler(automations, { startFails = false } = {}) {
  const hub = new TopicHub()
  const project = { id: 'p1', name: 'Demo', settings: {}, globalSessions: [], repositories: [{ id: 'r1', name: 'app', path: '/repo', branchData: {}, worktrees: [] }], automations }
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project])
  const started = []
  const renewed = []
  let ptys = 0
  let clock = T0
  // As the SessionManager does: start adds a Global session with its context, renew keeps its id.
  const sessions = {
    start: (p, options) => {
      if (startFails) throw Object.assign(new Error('a project holds at most 500 sessions; close some first'), { code: 'CAPACITY' })
      started.push({ ...p, ...options })
      const id = `s${started.length}`
      const ptyId = `pty${++ptys}`
      projects.apply(p.projectId, (d) => { d.globalSessions.push({ id, title: p.title, llm: p.llm ?? { provider: 'claude' }, queue: [], status: 'idle', ptyId, ...(options?.context ? { context: options.context } : {}) }) })
      return { sessionId: id, ptyId }
    },
    renew: (p) => {
      renewed.push(p)
      const ptyId = `pty${++ptys}`
      projects.apply(p.projectId, (d) => { const g = d.globalSessions.find((x) => x.id === p.sessionId); g.title = p.title; g.status = 'idle'; g.ptyId = ptyId })
      return { ptyId }
    }
  }
  const scheduler = new AutomationScheduler({ projects, sessions, now: () => clock })
  const setSession = (fn) => projects.apply('p1', (d) => fn(d.globalSessions[0]))
  return { projects, started, renewed, scheduler, setSession, setClock: (t) => (clock = t), advance: (ms) => (clock += ms), list: () => projects.require('p1').automations, globals: () => projects.require('p1').globalSessions }
}

test('check(): an on-time slot opens a Global session with the prompt, titled after the automation', () => {
  const s = setupScheduler([auto()])
  s.setClock(Date.UTC(2026, 0, 5, 9, 0, 30))
  s.scheduler.check()
  assert.deepEqual(s.started, [{ projectId: 'p1', worktreeId: null, title: 'Nightly · 09:00', initialMessage: 'Triage', cols: 120, rows: 32, context: { kind: 'automation', automationId: 'a' } }])
  const a = s.list()[0]
  assert.equal(a.lastSlot, Date.UTC(2026, 0, 5, 9))
  assert.deepEqual(a.history, [{ at: Date.UTC(2026, 0, 5, 9, 0, 30), slot: Date.UTC(2026, 0, 5, 9), trigger: 'schedule', outcome: 'ran', sessionId: 's1' }])
  s.scheduler.check()
  assert.equal(s.started.length, 1, 'the same slot never runs twice')
})

test('check(): a late batch records missed and starts nothing; the llm is passed when set', () => {
  const s = setupScheduler([auto({ llm: { provider: 'codex' } })])
  s.setClock(Date.UTC(2026, 0, 5, 9, 32, 30)) // 9:00 … 9:30 = 7 slots, 9:30 is 2.5 min old
  s.scheduler.check()
  assert.deepEqual([s.started.length, s.list()[0].missed], [0, { since: Date.UTC(2026, 0, 5, 9), count: 7 }])
  s.setClock(Date.UTC(2026, 0, 5, 9, 35, 10))
  s.scheduler.check()
  assert.deepEqual([s.started[0].llm, s.list()[0].missed], [{ provider: 'codex' }, undefined])
})

test('run(): a start failure is recorded and returned; history is capped', () => {
  const s = setupScheduler([auto({ history: Array.from({ length: AUTOMATION_HISTORY }, (_, i) => ({ at: i, trigger: 'manual', outcome: 'ran' })) })], { startFails: true })
  const { run, error } = s.scheduler.run('p1', 'a', 'manual')
  assert.deepEqual([run.outcome, run.trigger, run.error, error.code], ['failed', 'manual', 'a project holds at most 500 sessions; close some first', 'CAPACITY'])
  const history = s.list()[0].history
  assert.deepEqual([history.length, history[0].outcome], [AUTOMATION_HISTORY, 'failed'])
  assert.equal(s.list()[0].lastSlot, T0, 'a manual run leaves the schedule alone')
})

test('clockFromFile: the number in the file, else Date.now', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-clock-'))
  const file = join(dir, 'clock')
  writeFileSync(file, '12345\n')
  assert.equal(clockFromFile(file)(), 12345)
  writeFileSync(file, 'nope')
  assert.ok(Math.abs(clockFromFile(file)() - Date.now()) < 5000)
  assert.equal(clockFromFile(undefined), undefined)
})

import { dispatchV2 } from '../server/src/v2.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'

function setupV2(automations = []) {
  const s = setupScheduler(automations)
  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { hub: new TopicHub(), projects: s.projects, automations: s.scheduler })
  return { ...s, call }
}

test('welcome lists automations', () => {
  assert.ok(welcomeCapabilities(false).includes('automations'))
})

test('automation.save creates and updates; bad input is BAD_REQUEST', () => {
  const v = setupV2()
  const created = v.call('automation.save', { automation: input() })
  assert.equal(created.ok, true)
  const id = created.result.id
  assert.deepEqual(v.list().map((a) => [a.id, a.name, a.lastSlot]), [[id, 'Nightly', T0]])
  assert.equal(v.call('automation.save', { automation: input({ id, name: 'Renamed' }) }).ok, true)
  assert.equal(v.list()[0].name, 'Renamed')
  assert.equal(v.call('automation.save', { automation: input({ schedule: { cron: '* * * * *', tz: 'UTC' } }) }).error.code, 'BAD_REQUEST')
  assert.equal(v.call('automation.save', { projectId: 'nope', automation: input() }).error.code, 'NOT_FOUND')
})

test('automation.delete', () => {
  const v = setupV2([auto()])
  assert.deepEqual(v.call('automation.delete', { automationId: 'a' }), { ok: true, result: null })
  assert.equal(v.list(), undefined)
  assert.equal(v.call('automation.delete', { automationId: 'a' }).error.code, 'NOT_FOUND')
})

test('automation.runNow starts a session even when disabled; a failure is the error', () => {
  const v = setupV2([auto({ enabled: false })])
  assert.deepEqual(v.call('automation.runNow', { automationId: 'a' }), { ok: true, result: { sessionId: 's1' } })
  assert.equal(v.list()[0].history[0].trigger, 'manual')
  assert.equal(v.call('automation.runNow', { automationId: 'zz' }).error.code, 'NOT_FOUND')
})

test('automation.resolveMissed runs and dismisses; ids with nothing pending are ignored', () => {
  const missed = { since: T0, count: 3 }
  const v = setupV2([auto({ missed }), auto({ id: 'b', missed }), auto({ id: 'c' })])
  const out = v.call('automation.resolveMissed', { run: ['a', 'c'], dismiss: ['b'] })
  assert.deepEqual(out, { ok: true, result: { started: [{ automationId: 'a', sessionId: 's1' }] } })
  assert.deepEqual(v.list().map((a) => a.missed), [undefined, undefined, undefined])
  assert.equal(v.list()[0].history[0].trigger, 'missed')
  assert.deepEqual(v.call('automation.resolveMissed', { run: ['a'], dismiss: [] }).result, { started: [] })
  assert.equal(v.call('automation.resolveMissed', { run: 'a', dismiss: [] }).error.code, 'BAD_REQUEST')
})

test('checkInput refuses control characters in a prompt, but takes tabs and newlines', () => {
  assert.equal(code(() => checkInput(input({ prompt: 'a\u0000b' }), T0)), 'BAD_REQUEST')
  assert.equal(code(() => checkInput(input({ prompt: 'a\u001bb' }), T0)), 'BAD_REQUEST')
  assert.equal(code(() => checkInput(input({ prompt: 'a\tb\nc\r\nd' }), T0)), 'ok')
})

test('resolveMissed: a repeated run id starts one session; run wins over dismiss', () => {
  const missed = { since: T0, count: 3 }
  const v = setupV2([auto({ missed })])
  const out = v.call('automation.resolveMissed', { run: ['a', 'a'], dismiss: ['a'] })
  assert.deepEqual(out.result, { started: [{ automationId: 'a', sessionId: 's1' }] })
  assert.equal(v.started.length, 1)
})

test('resolveMissed: a failed start is returned as { automationId, error }', () => {
  const s = setupScheduler([auto({ missed: { since: T0, count: 2 } })], { startFails: true })
  const out = dispatchV2('automation.resolveMissed', { projectId: 'p1', run: ['a'], dismiss: [] }, { hub: new TopicHub(), projects: s.projects, automations: s.scheduler })
  assert.deepEqual(out.result, { started: [{ automationId: 'a', error: 'a project holds at most 500 sessions; close some first' }] })
})

test('check(): one failing start does not keep the next due automation from running; start() is idempotent', () => {
  const s = setupScheduler([auto(), auto({ id: 'b' })])
  let calls = 0
  const real = s.scheduler.deps.sessions.start
  s.scheduler.deps.sessions.start = (p) => {
    if (calls++ === 0) throw new Error('boom')
    return real(p)
  }
  s.setClock(Date.UTC(2026, 0, 5, 9, 0, 30))
  s.scheduler.check()
  assert.equal(s.started.length, 1)
  assert.deepEqual(s.list().map((a) => a.history[0].outcome), ['failed', 'ran'])
  s.scheduler.start()
  s.scheduler.start()
  s.scheduler.stop()
})

// ---- one reused run tab per automation ----

test('run(): the second run renews the automation\'s run tab instead of opening another', () => {
  const s = setupScheduler([auto({ llm: { provider: 'codex' } })])
  s.setClock(Date.UTC(2026, 0, 5, 9, 0, 30))
  assert.equal(s.scheduler.run('p1', 'a', 'manual').run.sessionId, 's1')
  s.setSession((g) => { g.status = 'done' })
  s.setClock(Date.UTC(2026, 0, 5, 9, 5, 10))
  const { run, error } = s.scheduler.run('p1', 'a', 'schedule', Date.UTC(2026, 0, 5, 9, 5))
  assert.equal(error, undefined)
  assert.deepEqual(run, { at: Date.UTC(2026, 0, 5, 9, 5, 10), slot: Date.UTC(2026, 0, 5, 9, 5), trigger: 'schedule', outcome: 'ran', sessionId: 's1' })
  assert.equal(s.started.length, 1, 'no new session')
  assert.deepEqual(s.renewed, [{ projectId: 'p1', sessionId: 's1', title: 'Nightly · 09:05', llm: { provider: 'codex' }, initialMessage: 'Triage', cols: 120, rows: 32 }])
  assert.equal(s.globals().length, 1)
})

test('run(): a busy run tab is skipped — recorded, nothing started, CONFLICT returned', () => {
  for (const busy of [{ status: 'working' }, { status: 'attention' }, { status: 'idle', decision: { question: 'q', at: 1 } }]) {
    const s = setupScheduler([auto()])
    s.scheduler.run('p1', 'a', 'manual')
    s.setSession((g) => Object.assign(g, busy))
    const { run, error } = s.scheduler.run('p1', 'a', 'manual')
    assert.deepEqual([run.outcome, run.error, run.sessionId, error?.code], ['skipped', 'previous run still working', undefined, 'CONFLICT'], JSON.stringify(busy))
    assert.deepEqual([s.started.length, s.renewed.length], [1, 0])
    assert.deepEqual(s.list()[0].history.map((r) => r.outcome), ['skipped', 'ran'])
  }
})

test('run(): exited and complete run tabs are renewed; a closed one is replaced by a new one', () => {
  const s = setupScheduler([auto()])
  s.scheduler.run('p1', 'a', 'manual')
  s.setSession((g) => { g.status = 'exited'; g.exitCode = 1; delete g.ptyId })
  s.scheduler.run('p1', 'a', 'manual')
  s.advance(60_000)
  s.setSession((g) => { g.status = 'complete' })
  s.scheduler.run('p1', 'a', 'manual')
  assert.deepEqual([s.started.length, s.renewed.length], [1, 2])
  assert.equal(s.renewed[0].llm, null, "no llm of its own: the project's Global agent")
  // The user closed the tab; another automation's tab and a normal tab are not taken.
  s.projects.apply('p1', (d) => {
    d.globalSessions = [
      { id: 'other', title: 'o', llm: { provider: 'claude' }, queue: [], status: 'idle', context: { kind: 'automation', automationId: 'b' } },
      { id: 'plain', title: 'p', llm: { provider: 'claude' }, queue: [], status: 'idle' }
    ]
  })
  const { run } = s.scheduler.run('p1', 'a', 'manual')
  assert.deepEqual([run.sessionId, s.started.length, s.renewed.length], ['s2', 2, 2])
  assert.deepEqual(s.globals().at(-1).context, { kind: 'automation', automationId: 'a' })
})

test('run(): a renew failure is recorded as failed', () => {
  const s = setupScheduler([auto()])
  s.scheduler.run('p1', 'a', 'manual')
  s.advance(60_000)
  s.scheduler.deps.sessions.renew = () => { throw Object.assign(new Error('the server is running its maximum of 1 sessions'), { code: 'CAPACITY' }) }
  const { run, error } = s.scheduler.run('p1', 'a', 'manual')
  assert.deepEqual([run.outcome, run.error, error.code], ['failed', 'the server is running its maximum of 1 sessions', 'CAPACITY'])
})

test('automation.runNow on a busy run tab is CONFLICT; resolveMissed reports it as error', () => {
  const v = setupV2([auto({ missed: { since: T0, count: 1 } })])
  assert.equal(v.call('automation.runNow', { automationId: 'a' }).ok, true)
  v.setSession((g) => { g.status = 'working' })
  const now = v.call('automation.runNow', { automationId: 'a' })
  assert.deepEqual([now.ok, now.error.code], [false, 'CONFLICT'])
  const out = v.call('automation.resolveMissed', { run: ['a'], dismiss: [] })
  assert.deepEqual(out.result, { started: [{ automationId: 'a', error: 'previous run still working' }] })
  assert.deepEqual(v.list()[0].history.map((r) => [r.trigger, r.outcome]), [['missed', 'skipped'], ['manual', 'skipped'], ['manual', 'ran']])
  assert.deepEqual([v.started.length, v.renewed.length], [1, 0])
})

test('automation.delete keeps its run tab, without its context', () => {
  const v = setupV2([auto(), auto({ id: 'b' })])
  v.call('automation.runNow', { automationId: 'a' })
  v.call('automation.runNow', { automationId: 'b' })
  assert.equal(v.call('automation.delete', { automationId: 'a' }).ok, true)
  assert.deepEqual(v.globals().map((g) => [g.id, g.context]), [['s1', undefined], ['s2', { kind: 'automation', automationId: 'b' }]])
})

test('run(): a run tab started less than 10 s ago is busy, even before its agent prints', () => {
  const s = setupScheduler([auto()])
  s.scheduler.run('p1', 'a', 'manual')
  s.advance(9_000)
  assert.deepEqual([s.scheduler.run('p1', 'a', 'manual').run.outcome, s.renewed.length], ['skipped', 0])
  s.advance(1_000)
  assert.deepEqual([s.scheduler.run('p1', 'a', 'manual').run.outcome, s.renewed.length], ['ran', 1])
  s.advance(5_000)
  assert.equal(s.scheduler.run('p1', 'a', 'manual').run.outcome, 'skipped', 'a renew counts as a start')
  // Another pty in the tab since (the user restarted it) is not the run's.
  s.setSession((g) => { g.ptyId = 'restarted' })
  assert.equal(s.scheduler.run('p1', 'a', 'manual').run.outcome, 'ran')
})

test('run(): an exited run tab with a stale decision is renewed, not skipped', () => {
  const s = setupScheduler([auto()])
  s.scheduler.run('p1', 'a', 'manual')
  s.setSession((g) => { g.status = 'exited'; delete g.ptyId; g.decision = { question: 'q', at: 1 } })
  assert.deepEqual([s.scheduler.run('p1', 'a', 'manual').run.outcome, s.renewed.length], ['ran', 1])
})
