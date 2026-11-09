// scripts/envPollTick.test.mjs — what each tick of the environments' poll does: the tool check until
// one answers, again now and then after a failed one (a colima installed meanwhile), else the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENV_RECHECK_TICKS, envPollTick } from '../src/renderer/src/envPollTick.ts'

test('no answer yet: every tick asks env.check', () => {
  for (let tick = 1; tick <= 3; tick++) assert.equal(envPollTick(null, tick), 'check')
})

test('a passed check: every tick lists the environments', () => {
  for (let tick = 1; tick <= 2 * ENV_RECHECK_TICKS; tick++) assert.equal(envPollTick({ ok: true }, tick), 'list')
})

test('a failed check is asked again every ENV_RECHECK_TICKS ticks (a minute), so a tool installed on the server is seen', () => {
  assert.equal(ENV_RECHECK_TICKS, 6)
  const ticks = Array.from({ length: 13 }, (_, i) => envPollTick({ ok: false, error: 'colima not found' }, i + 1))
  assert.deepEqual(ticks.map((t, i) => (t === 'check' ? i + 1 : null)).filter(Boolean), [6, 12])
  assert.equal(ticks.filter((t) => t === 'list').length, 11)
})
