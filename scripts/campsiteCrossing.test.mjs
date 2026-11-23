// scripts/campsiteCrossing.test.mjs — an animal on the strip (campsite part 3d-2): a walker on the
// treeline with one pause, a flier under the header, a swimmer on the lake, and standing still under
// reduced motion.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FLY_TOP, PAUSE_MS, STILL_MS, SWIM_MS, SWIM_Y, WALK_Y, admit, crossing, crossingAt, occupiedSpans, stillSpot } from '../plugins/campsite/shared/crossing.ts'
import { LOG_W, TENT_W } from '../plugins/campsite/shared/layout.ts'
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
  // Its middle stays clear of the tier-2 dock (the first 48 px) and the reeds (from 168 px), its whole width inside
  for (const id of ['heron', 'duck', 'beaver', 'otter', 'frog']) {
    for (const r of [0, 0.5, 1]) {
      const s = crossing(id, 'left', 1600, LAKE, r, false)
      assert.ok(s.fromX - s.w / 2 >= 1400 + 48 && s.fromX + s.w / 2 <= 1400 + 168, `${id} at ${r}: ${s.fromX}±${s.w / 2}`)
    }
  }
  assert.equal(crossing('otter', 'left', 1600, LAKE, 0, false).fromX, 1400 + 48 + 21, 'a wide swimmer is pushed off the dock')
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

test("reduced motion: a still walker stands in a gap clear of the tents, the log, the fire and the buildings; the widest gap when none fits; none with no gap", () => {
  // A deer is 60 wide: gaps [8, 100) and [300, 992)
  const busy = [{ from: 100, to: 300 }]
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const x = stillSpot(1000, 60, busy, r)
    assert.ok(x - 30 >= 8 && x + 30 <= 992 && (x + 30 <= 100 || x - 30 >= 300), `r ${r}: ${x}`)
  }
  assert.equal(stillSpot(1000, 60, [], 0.5), 500)
  assert.equal(stillSpot(1000, 60, busy, 0), 38, 'r picks along every spot that fits, left to right')
  assert.equal(stillSpot(1000, 60, busy, 1), 962)
  // Nothing fits: the widest gap's middle
  assert.equal(stillSpot(300, 60, [{ from: 30, to: 120 }, { from: 150, to: 270 }], 0.5), 135)
  assert.equal(stillSpot(300, 60, [{ from: 0, to: 300 }], 0.5), null)
  // Overlapping and out-of-strip spans merge
  assert.equal(stillSpot(400, 60, [{ from: -50, to: 150 }, { from: 100, to: 330 }], 0.5), 361)
  const layout = { width: 1000, fireX: 500, tents: [{ x: 620 }, { x: 380 }], log: { x: 260 } }
  const spans = occupiedSpans(layout, [{ x: 8, w: 92 }])
  assert.deepEqual(spans, [
    { from: 460, to: 540 },
    { from: 620 - TENT_W / 2, to: 620 + TENT_W / 2 },
    { from: 380 - TENT_W / 2, to: 380 + TENT_W / 2 },
    { from: 260 - LOG_W / 2, to: 260 + LOG_W / 2 },
    { from: 8, to: 100 }
  ])
  assert.deepEqual(occupiedSpans({ width: 0, fireX: 0, tents: [], log: null }, []), [])
  for (const r of [0, 0.3, 0.6, 0.9, 1]) {
    const c = crossing('deer', 'left', 1000, null, r, true, spans)
    for (const s of spans) assert.ok(c.fromX + c.w / 2 <= s.from || c.fromX - c.w / 2 >= s.to, `r ${r}: ${c.fromX} clear of ${s.from}–${s.to}`)
  }
  assert.equal(crossing('deer', 'left', 300, null, 0.5, true, [{ from: 0, to: 300 }]), null, 'no gap: not drawn')
  assert.equal(crossing('owl', 'left', 1000, null, 0, true, spans).fromX, 300, 'a flier ignores what stands on the ground')
})

test('admit: a sighting for this project, a known species and edge, shown only on an expanded, visible, measured strip with no animal up', () => {
  const view = { projectId: 'p1', shown: true, collapsed: false, hidden: false, width: 1200 }
  const e = { projectId: 'p1', species: 'fox', dir: 'left' }
  assert.deepEqual(admit(e, view, false), { species: 'fox', dir: 'left' })
  assert.equal(admit({ ...e, projectId: 'p2' }, view, false), null, "another project's")
  assert.equal(admit({ ...e, dir: 'up' }, view, false), null, 'a bad edge')
  assert.equal(admit({ ...e, species: 'dragon' }, view, false), null, 'an unknown species')
  assert.equal(admit({ ...e, species: 3 }, view, false), null)
  assert.equal(admit(e, view, true), null, 'one at a time')
  assert.equal(admit(e, { ...view, hidden: true }, false), null, 'a hidden window')
  assert.equal(admit(e, { ...view, shown: false }, false), null, 'the strip off')
  assert.equal(admit(e, { ...view, collapsed: true }, false), null, 'collapsed')
  assert.equal(admit(e, { ...view, width: 0 }, false), null, 'not measured')
})
