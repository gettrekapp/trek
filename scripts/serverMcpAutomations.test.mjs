// scripts/serverMcpAutomations.test.mjs — automations as the trek-dev tools see them (server/src/mcp/automations.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { automationInput, describeAutomation, resolveAutomation } from '../server/src/mcp/automations.ts'

// A Monday, 12:00 UTC: the next 09:00 UTC slot is the day after.
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0)
const auto = (extra = {}) => ({
  id: 'a1', name: 'Morning', prompt: 'Check the PRs', schedule: { cron: '0 9 * * *', tz: 'UTC' },
  enabled: true, createdAt: 0, lastSlot: 0, history: [], ...extra
})
const project = (automations, globalSessions = []) => ({ id: 'p', name: 'P', settings: {}, repositories: [], globalSessions, automations })

test('describeAutomation: the fields, with nextRun from the cron', () => {
  const a = auto()
  assert.deepEqual(describeAutomation(project([a]), a, NOW), {
    id: 'a1', name: 'Morning', prompt: 'Check the PRs', cron: '0 9 * * *', timezone: 'UTC', enabled: true,
    nextRun: '2026-01-06T09:00:00.000Z', history: []
  })
})

test('describeAutomation: disabled has no nextRun; llm, missed, run tab and history show when set', () => {
  const a = auto({
    enabled: false,
    llm: { provider: 'claude' },
    missed: { since: Date.UTC(2026, 0, 4, 9), count: 2 },
    history: [
      { at: Date.UTC(2026, 0, 5, 9), trigger: 'manual', outcome: 'skipped', error: 'still running' },
      { at: Date.UTC(2026, 0, 4, 9), slot: Date.UTC(2026, 0, 4, 9), trigger: 'schedule', outcome: 'ran', sessionId: 'g1' }
    ]
  })
  const tab = { id: 'g1', title: 'Morning', llm: { provider: 'claude' }, queue: [], status: 'done', context: { kind: 'automation', automationId: 'a1' } }
  const other = { id: 'g0', title: 'Global', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  const d = describeAutomation(project([a], [other, tab]), a, NOW)
  assert.equal('nextRun' in d, false)
  assert.deepEqual(d.llm, { provider: 'claude' })
  assert.deepEqual(d.missed, { since: '2026-01-04T09:00:00.000Z', count: 2 })
  assert.deepEqual(d.runSession, { terminalId: 'g1', status: 'done' })
  assert.deepEqual(d.history, [
    { at: '2026-01-05T09:00:00.000Z', trigger: 'manual', outcome: 'skipped', error: 'still running' },
    { at: '2026-01-04T09:00:00.000Z', trigger: 'schedule', outcome: 'ran' }
  ])
})

test('describeAutomation: a stored cron that no longer parses just has no nextRun', () => {
  const a = auto({ schedule: { cron: 'not a cron', tz: 'UTC' } })
  assert.equal('nextRun' in describeAutomation(project([a]), a, NOW), false)
})

test('resolveAutomation: id first, then name (trimmed, case-insensitive)', () => {
  const p = project([auto(), auto({ id: 'a2', name: 'Nightly' })])
  assert.equal(resolveAutomation(p, ' a2 ').id, 'a2')
  assert.equal(resolveAutomation(p, '  morning ').id, 'a1')
})

test('resolveAutomation: an ambiguous name lists the ids; an unknown one lists the names', () => {
  const p = project([auto(), auto({ id: 'a2' }), auto({ id: 'a3', name: 'Nightly' })])
  assert.throws(() => resolveAutomation(p, 'Morning'), (e) => e.code === 'BAD_REQUEST' && e.message.includes('a1, a2'))
  assert.throws(() => resolveAutomation(p, 'nope'), (e) => e.code === 'NOT_FOUND' && e.message.includes('Morning, Morning, Nightly'))
  assert.throws(() => resolveAutomation(project(undefined), 'nope'), (e) => e.code === 'NOT_FOUND' && e.message.includes('it has none'))
  assert.throws(() => resolveAutomation(p, ''), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => resolveAutomation(p, 7), (e) => e.code === 'BAD_REQUEST')
})

test('automationInput: create needs name, prompt and cron, and defaults enabled and the timezone', () => {
  assert.deepEqual(automationInput(undefined, { name: 'N', prompt: 'P', cron: '0 9 * * *' }, 'Europe/Paris'), {
    name: 'N', prompt: 'P', schedule: { cron: '0 9 * * *', tz: 'Europe/Paris' }, enabled: true, llm: null
  })
  for (const missing of ['name', 'prompt', 'cron']) {
    const args = { name: 'N', prompt: 'P', cron: '0 9 * * *' }
    delete args[missing]
    assert.throws(() => automationInput(undefined, args, 'UTC'), (e) => e.code === 'BAD_REQUEST' && e.message.includes(`${missing} is required to create an automation`))
  }
})

test('automationInput: an update keeps what is not passed; llm null clears, absent keeps', () => {
  const existing = auto({ llm: { provider: 'claude' } })
  assert.deepEqual(automationInput(existing, { enabled: false }, 'Europe/Paris'), {
    id: 'a1', name: 'Morning', prompt: 'Check the PRs', schedule: { cron: '0 9 * * *', tz: 'UTC' }, enabled: false, llm: { provider: 'claude' }
  })
  assert.deepEqual(automationInput(existing, { cron: '30 8 * * *', timezone: 'Asia/Tokyo', llm: null }, 'Europe/Paris'), {
    id: 'a1', name: 'Morning', prompt: 'Check the PRs', schedule: { cron: '30 8 * * *', tz: 'Asia/Tokyo' }, enabled: true, llm: null
  })
})
