// scripts/campsiteCrossing.test.mjs — an animal on the strip (campsite part 3d-2): a walker on the
// treeline with one pause, a flier under the header, a swimmer on the lake, and standing still under
// reduced motion.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FLY_TOP, PAUSE_MS, STILL_MS, SWIM_MS, SWIM_Y, WALK_Y, crossing, crossingAt } from '../plugins/campsite/shared/crossing.ts'
import { GROUND_Y, STAGE_H } from '../plugins/campsite/shared/stage.ts'

const LAKE = { x: 1400, w: 180 }

test('a walker: from its edge to the other in 15–25 s on the treeline, pausing once for 3 s; it faces where it goes', () => {
  assert.equal(WALK_Y, GROUND_Y - 2)
  const c = crossing('deer', 'left', 1200, null, 0.5, false)
  assert.deepEqual([c.move, c.ms, c.w, c.h, c.y, c.fromX, c.toX], ['walker', 20_000, 60, 48, WALK_Y, -34, 1234])
  assert.equal(c.pauseAt, Math.round(0.5 * (20_000 - PAUSE_MS)))
  assert.equal(crossing('deer', 'left', 1200, null, 0, false).ms, 15_000)
  assert.equal(crossing('deer', 'left', 1200, null, 1, false).ms, 25_000)
  const start = crossingAt(c, 0)
  assert.deepEqual([start.x, start.y, start.flip, start.alpha], [-34, WALK_Y, false, 1])
  const pausing = crossingAt(c, c.pauseAt + 1000)
  assert.equal(pausing.x, crossingAt(c, c.pauseAt).x, 'still through the pause')
  assert.equal(pausing.frame, 0)
  assert.ok(crossingAt(c, c.pauseAt + PAUSE_MS + 500).x > pausing.x, 'on again after it')
  assert.ok(Math.abs(crossingAt(c, c.ms - 1).x - 1234) < 1)
  assert.equal(crossingAt(c, c.ms), null, 'gone once over')
  assert.equal(crossingAt(c, -1), null)
  assert.deepEqual([crossingAt(c, 0).frame, crossingAt(c, 250).frame], [0, 1], 'a stride every 250 ms')
  const back = crossing('fox', 'right', 1200, null, 0.5, false)
  assert.deepEqual([back.fromX > 1200, back.toX < 0, crossingAt(back, 0).flip], [true, true, true])
})

test("a flier: across in 8–12 s, its top never above FLY_TOP (under the header and the peak's flags), flapping", () => {
  const c = crossing('hawk', 'left', 1600, null, 0.5, false)
  assert.deepEqual([c.move, c.ms, c.y, c.pauseAt], ['flier', 10_000, FLY_TOP + 24, null])
  for (let t = 0; t < c.ms; t += 97) {
    const p = crossingAt(c, t)
    assert.ok(p.y - c.h >= FLY_TOP && p.y - c.h <= FLY_TOP + 3, `top at ${t}`)
  }
  assert.deepEqual([crossingAt(c, 0).frame, crossingAt(c, 200).frame], [0, 1])
  assert.ok(crossingAt(c, 5000).x > 700 && crossingAt(c, 5000).x < 900, 'halfway at half time')
})

test('a swimmer: comes up at the lake (clear of the dock and reeds), bobs for 20 s fading in and out, then goes; none without a lake', () => {
  assert.equal(SWIM_Y, STAGE_H - 8)
  assert.equal(crossing('duck', 'left', 1600, null, 0.5, false), null)
  const c = crossing('duck', 'left', 1600, LAKE, 0, false)
  assert.deepEqual([c.move, c.ms, c.fromX, c.toX, c.y], ['swimmer', SWIM_MS, 1400 + Math.round(180 * 0.35), 1400 + Math.round(180 * 0.35), SWIM_Y])
  assert.equal(crossing('duck', 'left', 1600, LAKE, 1, false).fromX, 1400 + Math.round(180 * 0.7))
  assert.equal(crossingAt(c, 0).alpha, 0)
  assert.equal(crossingAt(c, 500).alpha, 0.5)
  assert.equal(crossingAt(c, 10_000).alpha, 1)
  assert.equal(crossingAt(c, SWIM_MS - 500).alpha, 0.5)
  assert.deepEqual([crossingAt(c, 0).frame, crossingAt(c, 600).frame], [0, 1], 'a bob every 600 ms')
})

test('reduced motion: it stands still at one spot for 10 s, in its first frame; a species this version cannot draw has no crossing', () => {
  const walker = crossing('deer', 'right', 1000, null, 0.5, true)
  assert.deepEqual([walker.ms, walker.fromX, walker.toX, walker.y], [STILL_MS, 500, 500, WALK_Y])
  assert.deepEqual(crossingAt(walker, 9000), { x: 500, y: WALK_Y, frame: 0, alpha: 1, flip: true })
  assert.equal(crossingAt(walker, STILL_MS), null)
  const flier = crossing('owl', 'left', 1000, null, 0, true)
  assert.deepEqual([flier.fromX, flier.y], [300, FLY_TOP + flier.h])
  const swimmer = crossing('frog', 'left', 1000, LAKE, 0, true)
  assert.deepEqual([swimmer.ms, crossingAt(swimmer, 0).alpha], [STILL_MS, 1])
  assert.equal(crossing('dragon', 'left', 1000, LAKE, 0, false), null)
})
