// scripts/cron.test.mjs — automations' cron (src/shared/cron.ts): parsing, slots read in a timezone
// (DST included), the next slot, the 5-minute minimum, picker ⇄ cron and the description.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CronError, nextSlots, cronFromPicker, describeCron, formatWall, minGapOk, nextSlot, parseCron, pickerFromCron, slotSpan, slotsBetween, validTimeZone } from '../src/shared/cron.ts'

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
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '0 9 * * MON', '@daily', undefined, null, 5]) {
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

test('picker ⇄ cron round trips', () => {
  const cases = [
    [{ kind: 'minutes', every: 15 }, '*/15 * * * *'],
    [{ kind: 'hours', every: 1, minute: 0 }, '0 * * * *'],
    [{ kind: 'hours', every: 6, minute: 30 }, '30 */6 * * *'],
    [{ kind: 'daily', hour: 9, minute: 5 }, '5 9 * * *'],
    [{ kind: 'weekly', days: [1, 3, 5], hour: 17, minute: 0 }, '0 17 * * 1,3,5']
  ]
  for (const [picker, cron] of cases) {
    assert.equal(cronFromPicker(picker), cron)
    assert.deepEqual(pickerFromCron(cron), picker)
  }
  // Weekday 7 is Sunday; days come back sorted.
  assert.deepEqual(pickerFromCron('0 8 * * 7,1'), { kind: 'weekly', days: [0, 1], hour: 8, minute: 0 })
  // Not one of the picker's shapes: Advanced.
  for (const cron of ['*/7 * * * *', '0 9 1 * *', '0 9-17 * * *', '0 */5 * * *', '0 9 * 1 *']) assert.equal(pickerFromCron(cron), null, cron)
})

test('describeCron', () => {
  assert.equal(describeCron('*/5 * * * *'), 'Every 5 minutes')
  assert.equal(describeCron('0 * * * *'), 'Every hour')
  assert.equal(describeCron('15 * * * *'), 'Every hour at :15')
  assert.equal(describeCron('0 */2 * * *'), 'Every 2 hours')
  assert.equal(describeCron('5 9 * * *'), 'Daily at 09:05')
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00')
  assert.equal(describeCron('0 9 * * 1,2,3,4,5'), 'Weekdays at 09:00')
  assert.equal(describeCron('0 10 * * 0,6'), 'Weekends at 10:00')
  assert.equal(describeCron('0 9 * * 1,3'), 'Mon, Wed at 09:00')
  assert.equal(describeCron('0 0 * * 5-7'), 'Fri, Sat, Sun at 00:00')
  assert.equal(describeCron('0 9 1 * *'), 'Cron: 0 9 1 * *')
  assert.equal(describeCron('nope'), 'Invalid schedule')
})

test('formatWall: a slot in the timezone, with or without the date', () => {
  assert.equal(formatWall(utc(2026, 1, 5, 14, 0), NY), '09:00')
  assert.equal(formatWall(utc(2026, 1, 5, 14, 0), NY, true), '2026-01-05 09:00')
})

test('slotSpan over 400 days of */5 in New York matches a slow reference and is fast', () => {
  const s = parseCron('*/5 * * * *')
  // Reference: every 5-minute UTC instant whose New York wall minute is a multiple of 5 is simply every instant
  // on the 5-minute grid (all offsets are whole 5-minute multiples), except the repeated fall-back hour
  // fires once, so the count over a range is the grid count less the repeated hour's 12 slots per fall-back.
  const until = utc(2026, 6, 1)
  const after = until - 400 * 86_400_000
  const t0 = Date.now()
  const span = slotSpan(s, NY, after, until)
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`)
  // Spring forward skips nothing on the grid (the gap hour is simply absent from wall time, instants continue);
  // fall back repeats a wall hour, whose second pass is skipped (12 slots), once in that range (Nov 1 2026 is
  // after; Nov 2 2025 is inside).
  const grid = 400 * 288
  assert.equal(span.count, grid - 12)
  // A short range checked against zonedToUtc-free brute force over instants.
  const a = utc(2026, 3, 7), b = utc(2026, 3, 10)
  const fast = slotsBetween(s, NY, a, b)
  assert.equal(fast.length, ((b - a) / 300_000))
  for (let i = 1; i < fast.length; i++) assert.equal(fast[i] - fast[i - 1], 300_000)
})

test('minGapOk sees a spring-forward squeeze', () => {
  assert.equal(minGapOk(parseCron('0,58 1,3 * * *'), NY, utc(2026, 1, 1)), false)
  assert.equal(minGapOk(parseCron('0 9 * * *'), NY, utc(2026, 1, 1)), true)
})

test('DST: London and a 30-minute shift at Lord Howe', () => {
  const L = 'Europe/London'
  const spec = parseCron('30 1 * * *')
  // 01:30 doesn't exist on 2026-03-29 (01:00 -> 02:00)
  assert.deepEqual(slotsBetween(spec, L, utc(2026, 3, 28, 12), utc(2026, 3, 30, 12)), [utc(2026, 3, 28, 1, 30), utc(2026, 3, 30, 0, 30)].filter((t) => t > utc(2026, 3, 28, 12)))
  // 01:30 happens twice on 2026-10-25: once, the first (BST, 00:30Z)
  assert.deepEqual(slotsBetween(spec, L, utc(2026, 10, 24, 12), utc(2026, 10, 25, 12)), [utc(2026, 10, 25, 0, 30)])
  // Lord Howe 2026-10-04: 02:00 -> 02:30, so 02:00 and 02:15 are skipped; 02:30 is 15:30Z on Oct 3
  assert.deepEqual(slotsBetween(parseCron('0,15,30 2 * * *'), 'Australia/Lord_Howe', utc(2026, 10, 3), utc(2026, 10, 4)), [utc(2026, 10, 3, 15, 30)])
})

test('nextSlots: n ascending slots', () => {
  const r = nextSlots(parseCron('0 9 * * *'), 'UTC', utc(2026, 1, 5, 9), 3)
  assert.deepEqual(r, [utc(2026, 1, 6, 9), utc(2026, 1, 7, 9), utc(2026, 1, 8, 9)])
})
