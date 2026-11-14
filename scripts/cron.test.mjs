// scripts/cron.test.mjs — automations' cron (src/shared/cron.ts): parsing, slots read in a timezone
// (DST included), the next slot, the 5-minute minimum, picker ⇄ cron and the description.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CronError, minGapOk, nextSlot, parseCron, slotSpan, slotsBetween, validTimeZone } from '../src/shared/cron.ts'

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi)
const NY = 'America/New_York'

test('parseCron: fields, lists, ranges, steps, weekday 7', () => {
  const s = parseCron('0,30 9-17/4 * 1-3 1-5')
  assert.deepEqual(s.minutes, [0, 30])
  assert.deepEqual(s.hours, [9, 13, 17])
  assert.deepEqual([...s.months].sort((a, b) => a - b), [1, 2, 3])
  assert.deepEqual([...s.weekdays].sort(), [1, 2, 3, 4, 5])
  assert.equal(s.dayRestricted, false)
  assert.equal(s.weekdayRestricted, true)
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0])
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45])
  assert.deepEqual(parseCron('5/20 * * * *').minutes, [5, 25, 45])
  assert.deepEqual(parseCron('  0   9 * * *  ').hours, [9])
})

test('parseCron refuses what it does not take', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '0 9 * * MON', '@daily']) {
    assert.throws(() => parseCron(bad), CronError, bad)
  }
})

test('slotsBetween: after is exclusive, until inclusive, UTC', () => {
  const s = parseCron('0 * * * *')
  assert.deepEqual(slotsBetween(s, 'UTC', utc(2026, 1, 5, 9), utc(2026, 1, 5, 11)), [utc(2026, 1, 5, 10), utc(2026, 1, 5, 11)])
})

test('slotsBetween: day-of-month and day-of-week both restricted match either', () => {
  // The 1st of the month, or any Monday: Jan 2026 — Thu 1st, Mon 5th.
  const s = parseCron('0 9 1 * 1')
  assert.deepEqual(slotsBetween(s, 'UTC', utc(2026, 1, 1), utc(2026, 1, 7)), [utc(2026, 1, 1, 9), utc(2026, 1, 5, 9)])
  // Only the weekday restricted: Mondays only.
  assert.deepEqual(slotsBetween(parseCron('0 9 * * 1'), 'UTC', utc(2026, 1, 1), utc(2026, 1, 7)), [utc(2026, 1, 5, 9)])
})

test('slotsBetween reads the cron in the timezone, across DST', () => {
  // 2026: New York springs forward Sun Mar 8 (02:00 → 03:00) and falls back Sun Nov 1 (02:00 → 01:00).
  assert.deepEqual(slotsBetween(parseCron('0 9 * * *'), NY, utc(2026, 1, 5), utc(2026, 1, 6)), [utc(2026, 1, 5, 14)])
  // 02:30 does not exist on Mar 8: skipped.
  assert.deepEqual(slotsBetween(parseCron('30 2 * * *'), NY, utc(2026, 3, 7), utc(2026, 3, 10)), [utc(2026, 3, 7, 7, 30), utc(2026, 3, 9, 6, 30)])
  // 01:30 happens twice on Nov 1: fires once, on the first (EDT, 05:30Z).
  assert.deepEqual(slotsBetween(parseCron('30 1 * * *'), NY, utc(2026, 10, 31, 12), utc(2026, 11, 2, 12)), [utc(2026, 11, 1, 5, 30), utc(2026, 11, 2, 6, 30)])
})

test('slotSpan: first, last and count; none is undefined; a huge gap is clamped to 400 days', () => {
  const s = parseCron('*/5 * * * *')
  assert.deepEqual(slotSpan(s, 'UTC', utc(2026, 1, 5, 9), utc(2026, 1, 5, 11, 2)), { first: utc(2026, 1, 5, 9, 5), last: utc(2026, 1, 5, 11), count: 24 })
  assert.equal(slotSpan(s, 'UTC', utc(2026, 1, 5, 9), utc(2026, 1, 5, 9, 4)), undefined)
  const span = slotSpan(parseCron('0 0 * * *'), 'UTC', utc(2020, 1, 1), utc(2026, 1, 1))
  assert.equal(span.last, utc(2026, 1, 1))
  assert.ok(span.count <= 401 && span.count >= 399, String(span.count))
})

test('nextSlot: the first slot after; undefined when it never matches', () => {
  assert.equal(nextSlot(parseCron('0 9 * * *'), 'UTC', utc(2026, 1, 5, 9)), utc(2026, 1, 6, 9))
  assert.equal(nextSlot(parseCron('0 0 31 2 *'), 'UTC', utc(2026, 1, 1)), undefined)
  assert.equal(nextSlot(parseCron('0 0 29 2 *'), 'UTC', utc(2026, 1, 1)), utc(2028, 2, 29))
})

test('minGapOk: at least 5 minutes between slots', () => {
  assert.equal(minGapOk(parseCron('*/5 * * * *'), 'UTC', utc(2026, 1, 1)), true)
  assert.equal(minGapOk(parseCron('* * * * *'), 'UTC', utc(2026, 1, 1)), false)
  assert.equal(minGapOk(parseCron('0,3 * * * *'), 'UTC', utc(2026, 1, 1)), false)
  assert.equal(minGapOk(parseCron('0 9 * * 1'), NY, utc(2026, 1, 1)), true)
})

test('validTimeZone', () => {
  assert.equal(validTimeZone('UTC'), true)
  assert.equal(validTimeZone(NY), true)
  assert.equal(validTimeZone('Mars/Olympus'), false)
  assert.equal(validTimeZone(''), false)
})
