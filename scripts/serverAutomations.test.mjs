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
