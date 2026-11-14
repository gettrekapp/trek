// scripts/automationsUi.test.mjs — the Automations panel's and missed-runs modal's pure helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lastRunLabel, missedKey, missedLabel, missedRows, nextRunLabel, resolveMissedError, runOutcomeLabel, runNowError } from '../src/renderer/src/automations.ts'

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
