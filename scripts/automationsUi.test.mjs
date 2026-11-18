// scripts/automationsUi.test.mjs — the Automations panel's and missed-runs modal's pure helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRIGGER_LABELS,
  automationFact,
  automationRowLine,
  automationState,
  chooseScheduleKind,
  cronOnly,
  defaultPicker,
  lastRunLabel,
  missedBanner,
  missedKey,
  missedLabel,
  missedRows,
  nextRunFact,
  nextRunLabel,
  relativeUntil,
  resolveMissedError,
  runOutcomeLabel,
  runNowError,
  runningAutomations,
  sortAutomations
} from '../src/renderer/src/automations.ts'

const a = (id, over = {}) => ({ id, name: id.toUpperCase(), prompt: 'p', schedule: { cron: '0 9 * * *', tz: 'UTC' }, enabled: true, createdAt: 0, lastSlot: 0, history: [], ...over })
const SINCE = Date.UTC(2026, 0, 5, 20)

test('missedRows and missedKey: the automations with a pending miss; the key changes with a new miss', () => {
  const list = [a('x', { missed: { since: SINCE, count: 3 } }), a('y'), a('z', { missed: { since: SINCE, count: 1 } })]
  assert.deepEqual(missedRows(list).map((r) => r.id), ['x', 'z'])
  assert.equal(missedKey(list), `x:${SINCE}:3,z:${SINCE}:1`)
  assert.equal(missedKey([a('y')]), '')
  assert.notEqual(missedKey([a('x', { missed: { since: SINCE, count: 4 } })]), `x:${SINCE}:3`)
  // a miss that recurs with the same count but a later since is a new key
  assert.notEqual(
    missedKey([a('x', { missed: { since: SINCE, count: 1 } })]),
    missedKey([a('x', { missed: { since: SINCE + 86400000, count: 1 } })])
  )
})

test('missedLabel', () => {
  assert.equal(missedLabel({ since: SINCE, count: 1 }, 'UTC'), 'missed its 2026-01-05 20:00 run')
  assert.equal(missedLabel({ since: SINCE, count: 3 }, 'UTC'), 'missed 3 runs since 2026-01-05 20:00')
})

test('nextRunLabel and lastRunLabel', () => {
  const now = Date.UTC(2026, 0, 5, 8)
  assert.equal(nextRunLabel(a('x'), now), 'Next: 2026-01-05 09:00')
  assert.equal(nextRunLabel(a('x', { enabled: false }), now), 'Paused')
  assert.equal(nextRunLabel(a('x', { schedule: { cron: 'bad', tz: 'UTC' } }), now), 'Invalid schedule')
  assert.equal(lastRunLabel(a('x')), 'Never run')
  assert.equal(lastRunLabel(a('x', { history: [{ at: SINCE, trigger: 'schedule', outcome: 'ran', sessionId: 's' }] })), 'Last: 2026-01-05 20:00 · ran')
  assert.equal(lastRunLabel(a('x', { history: [{ at: SINCE, trigger: 'manual', outcome: 'failed', error: 'boom' }] })), 'Last: 2026-01-05 20:00 · failed: boom')
  assert.equal(
    lastRunLabel(a('x', { history: [{ at: SINCE, trigger: 'schedule', outcome: 'skipped', error: 'previous run still working' }] })),
    'Last: 2026-01-05 20:00 · skipped: previous run still working'
  )
})

test('runOutcomeLabel: a skip says why, a failure its error', () => {
  assert.equal(runOutcomeLabel({ at: 0, trigger: 'schedule', outcome: 'ran', sessionId: 's' }), 'ran')
  assert.equal(runOutcomeLabel({ at: 0, trigger: 'manual', outcome: 'failed', error: 'boom' }), 'failed: boom')
  assert.equal(runOutcomeLabel({ at: 0, trigger: 'manual', outcome: 'failed' }), 'failed: unknown error')
  assert.equal(runOutcomeLabel({ at: 0, trigger: 'schedule', outcome: 'skipped', error: 'previous run still working' }), 'skipped: previous run still working')
  assert.equal(runOutcomeLabel({ at: 0, trigger: 'missed', outcome: 'skipped' }), 'skipped: previous run still working')
})

test('runNowError: a CONFLICT (the run tab is busy) reads as the previous run still working', () => {
  const coded = (code, message) => Object.assign(new Error(message), { code })
  assert.equal(runNowError(coded('CONFLICT', 'previous run still working')), 'The previous run is still working')
  assert.equal(runNowError(coded('NOT_FOUND', 'gone')), undefined)
  assert.equal(runNowError(new Error('x')), undefined)
})

test('resolveMissedError: a skipped run says so', () => {
  assert.equal(resolveMissedError('Daily', 'previous run still working'), 'Daily: skipped, the previous run is still working')
  assert.equal(resolveMissedError('Daily', 'CAPACITY: full'), 'Daily: CAPACITY: full')
})

const NOW = Date.UTC(2026, 0, 5, 6) // 2026-01-05 06:00 UTC, a Monday
const ran = { at: NOW - 3600000, trigger: 'schedule', outcome: 'ran', sessionId: 's1' }
const failed = { at: NOW - 3600000, trigger: 'schedule', outcome: 'failed', error: 'no agent' }

test('automationState: the first that applies — missed, running, paused, failed, never, waiting', () => {
  assert.equal(automationState(a('x', { history: [ran] }), false), 'waiting')
  assert.equal(automationState(a('x'), false), 'never')
  assert.equal(automationState(a('x', { history: [failed, ran] }), false), 'failed')
  assert.equal(automationState(a('x', { history: [ran, failed] }), false), 'waiting', 'only the newest run counts')
  assert.equal(automationState(a('x', { enabled: false, history: [failed] }), false), 'paused', 'paused over failed')
  assert.equal(automationState(a('x', { history: [failed] }), true), 'running', 'running over failed')
  assert.equal(automationState(a('x', { enabled: false }), true), 'running', 'running over paused')
  assert.equal(automationState(a('x', { missed: { since: SINCE, count: 2 } }), true), 'missed', 'missed over running')
})

test('relativeUntil: minutes under an hour, hours under twelve, then the day and the time, then the date alone', () => {
  const at = (ms) => relativeUntil(NOW + ms, NOW, 'UTC')
  assert.equal(at(20_000), 'in under a minute')
  assert.equal(at(60_000), 'in 1 min')
  assert.equal(at(59 * 60_000 + 59_000), 'in 59 min')
  assert.equal(at(3_600_000), 'in 1 h')
  assert.equal(at(3 * 3_600_000), 'in 3 h')
  assert.equal(at(11 * 3_600_000 + 20 * 60_000), 'in 11 h')
  assert.equal(at(12 * 3_600_000), 'today 18:00')
  assert.equal(at(27 * 3_600_000), 'tomorrow 09:00')
  assert.equal(at(51 * 3_600_000), 'Wed 09:00', 'two days on: the weekday')
  assert.equal(at(6 * 86_400_000), 'Sun 06:00', 'six days on is still within the week')
  assert.equal(at(7 * 86_400_000 + 3 * 3_600_000), '2026-01-12', 'a week on the weekday would read as this week\'s: the date')
  assert.equal(at(40 * 86_400_000), '2026-02-14')
})

test('relativeUntil: the day is the timezone\'s, not UTC\'s', () => {
  // 06:00 UTC is 15:00 in Tokyo; 13 hours on is 04:00 the next day there, though still the same UTC day.
  assert.equal(relativeUntil(NOW + 13 * 3_600_000, NOW, 'Asia/Tokyo'), 'tomorrow 04:00')
  // Three days later the same hour is Thursday 19:00 UTC and Friday 04:00 in Tokyo.
  assert.equal(relativeUntil(NOW + 3 * 86_400_000 + 13 * 3_600_000, NOW, 'Asia/Tokyo'), 'Fri 04:00')
  assert.equal(relativeUntil(NOW + 3 * 86_400_000 + 13 * 3_600_000, NOW, 'UTC'), 'Thu 19:00')
})

test('automationFact: what the row says after the schedule, and its tone', () => {
  const fact = (auto, running = false) => automationFact(auto, automationState(auto, running), NOW)
  assert.deepEqual(fact(a('x', { history: [ran] })), { text: 'next in 3 h', tone: 'muted' })
  assert.deepEqual(fact(a('x')), { text: 'next in 3 h', tone: 'muted' })
  assert.deepEqual(fact(a('x'), true), { text: 'running now', tone: 'muted' })
  assert.deepEqual(fact(a('x', { enabled: false })), { text: 'paused', tone: 'muted' })
  assert.deepEqual(fact(a('x', { history: [failed] })), { text: 'last run failed', tone: 'danger' })
  assert.deepEqual(fact(a('x', { missed: { since: SINCE, count: 1 } })), { text: '1 run missed', tone: 'attention' })
  assert.deepEqual(fact(a('x', { missed: { since: SINCE, count: 4 } })), { text: '4 runs missed', tone: 'attention' })
  assert.deepEqual(fact(a('x', { schedule: { cron: 'nope', tz: 'UTC' } })), { text: 'invalid schedule', tone: 'danger' })
})

test('automationRowLine: the schedule in words, a dot, the fact; offline a countdown is dropped', () => {
  const line = (auto, offline = false, running = false) => automationRowLine(auto, automationState(auto, running), NOW, offline)
  assert.deepEqual(line(a('x', { history: [ran] })), { text: 'Daily at 09:00 · next in 3 h', tone: 'muted' })
  assert.deepEqual(line(a('x', { history: [ran] }), true), { text: 'Daily at 09:00', tone: 'muted' })
  assert.deepEqual(line(a('x', { enabled: false }), true), { text: 'Daily at 09:00 · paused', tone: 'muted' }, 'offline keeps a fact that is not a countdown')
  assert.deepEqual(line(a('x', { history: [failed] }), true), { text: 'Daily at 09:00 · last run failed', tone: 'danger' })
  assert.deepEqual(line(a('x', { schedule: { cron: 'nope', tz: 'UTC' } })), { text: 'Invalid schedule', tone: 'danger' }, 'said once, not twice')
})

test('nextRunFact: the detail\'s Next run, absolute and relative', () => {
  assert.deepEqual(nextRunFact(a('x'), NOW), { value: '2026-01-05 09:00', sub: 'in 3 h' })
  assert.deepEqual(nextRunFact(a('x', { enabled: false }), NOW), { value: 'Paused', sub: null })
  assert.deepEqual(nextRunFact(a('x', { schedule: { cron: 'nope', tz: 'UTC' } }), NOW), { value: 'Invalid schedule', sub: null })
})

test('nextRunFact: from two days ahead the value already says the day, so nothing is under it', () => {
  assert.deepEqual(nextRunFact(a('x', { schedule: { cron: '0 5 * * *', tz: 'UTC' } }), NOW + 3_600_000), { value: '2026-01-06 05:00', sub: 'tomorrow 05:00' })
  assert.deepEqual(nextRunFact(a('x', { schedule: { cron: '0 9 7 1 *', tz: 'UTC' } }), NOW), { value: '2026-01-07 09:00', sub: null })
  assert.deepEqual(nextRunFact(a('x', { schedule: { cron: '0 9 1 3 *', tz: 'UTC' } }), NOW), { value: '2026-03-01 09:00', sub: null })
})

test('missedBanner: the sum of the missed runs, or nothing', () => {
  assert.equal(missedBanner([a('x'), a('y')]), null)
  assert.equal(missedBanner(undefined), null)
  assert.equal(missedBanner([a('x', { missed: { since: SINCE, count: 1 } })]), '1 run was missed while the server was off.')
  assert.equal(missedBanner([a('x', { missed: { since: SINCE, count: 2 } }), a('y', { missed: { since: SINCE, count: 3 } })]), '5 runs were missed while the server was off.')
})

test('TRIGGER_LABELS: who started a run, in the history table\'s words', () => {
  assert.deepEqual(TRIGGER_LABELS, { schedule: 'Schedule', manual: 'Run now', missed: 'Missed, run later' })
})

test('sortAutomations: the project\'s order, paused ones after the rest', () => {
  const list = [a('p1', { enabled: false }), a('b'), a('p2', { enabled: false }), a('c')]
  assert.deepEqual(sortAutomations(list).map((x) => x.id), ['b', 'c', 'p1', 'p2'])
  assert.deepEqual(list.map((x) => x.id), ['p1', 'b', 'p2', 'c'], 'the input is not changed')
})

test('runningAutomations: the automations whose run tab is working', () => {
  const terminals = {
    t1: { status: 'working', context: { kind: 'automation', automationId: 'x' } },
    t2: { status: 'done', context: { kind: 'automation', automationId: 'y' } },
    t3: { status: 'working' }
  }
  assert.deepEqual([...runningAutomations(terminals)], ['x'])
})

test('defaultPicker: what each schedule kind starts from', () => {
  assert.deepEqual(defaultPicker('minutes'), { kind: 'minutes', every: 15 })
  assert.deepEqual(defaultPicker('hours'), { kind: 'hours', every: 1, minute: 0 })
  assert.deepEqual(defaultPicker('daily'), { kind: 'daily', hour: 9, minute: 0 })
  assert.deepEqual(defaultPicker('weekly'), { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
})

test('chooseScheduleKind: a picker to cron writes the picker\'s cron line', () => {
  const picker = { kind: 'weekly', days: [1, 3], hour: 7, minute: 30 }
  assert.deepEqual(chooseScheduleKind({ advanced: false, cron: '0 9 * * *', picker }, 'cron'), { advanced: true, cron: '30 7 * * 1,3', picker })
})

test('chooseScheduleKind: cron to the line\'s own kind keeps its values; to another kind takes that kind\'s default', () => {
  const state = { advanced: true, cron: '30 7 * * *', picker: { kind: 'minutes', every: 5 } }
  assert.deepEqual(chooseScheduleKind(state, 'daily'), { advanced: false, cron: '30 7 * * *', picker: { kind: 'daily', hour: 7, minute: 30 } })
  assert.deepEqual(chooseScheduleKind(state, 'weekly'), { advanced: false, cron: '30 7 * * *', picker: defaultPicker('weekly') })
  // Between two pickers: the same kind is left as it is, another starts from its default.
  const daily = { advanced: false, cron: '0 9 * * *', picker: { kind: 'daily', hour: 7, minute: 30 } }
  assert.deepEqual(chooseScheduleKind(daily, 'daily'), daily)
  assert.deepEqual(chooseScheduleKind(daily, 'hours').picker, defaultPicker('hours'))
})

test('cronOnly and chooseScheduleKind: a line the pickers cannot write is cron only, and stays cron', () => {
  assert.equal(cronOnly(true, '15 3 1 * *'), true)
  assert.equal(cronOnly(true, '30 7 * * *'), false)
  assert.equal(cronOnly(false, '15 3 1 * *'), false, 'the pickers are showing: the line is not what is being edited')
  const state = { advanced: true, cron: '15 3 1 * *', picker: { kind: 'daily', hour: 9, minute: 0 } }
  assert.deepEqual(chooseScheduleKind(state, 'daily'), state)
  assert.deepEqual(chooseScheduleKind(state, 'minutes'), state)
})

test('chooseScheduleKind: cron while already cron changes nothing, the line least of all', () => {
  const state = { advanced: true, cron: '15 3 1 * *', picker: { kind: 'daily', hour: 9, minute: 0 } }
  assert.deepEqual(chooseScheduleKind(state, 'cron'), state)
  const edited = { advanced: true, cron: '5 4 * * 2', picker: { kind: 'daily', hour: 9, minute: 0 } }
  assert.deepEqual(chooseScheduleKind(edited, 'cron'), edited, 'not rewritten from the picker')
})
