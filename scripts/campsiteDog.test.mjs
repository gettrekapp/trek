// scripts/campsiteDog.test.mjs — the camp dog: its pixels per pose, and where it runs next.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DOG_EDGE, DOG_FRAMES, DOG_GRID, DOG_MIN_TRIP, DOG_POSES, DOG_REST_MS, DOG_SPEED, dogPixels, dogStart, dogTrip } from '../plugins/campsite/shared/dog.ts'

/** A rand that hands out the given numbers in turn */
const seq = (...values) => {
  let i = 0
  return () => values[i++ % values.length]
}

test('every pose has two frames, inside the grid, and the frames differ', () => {
  for (const pose of DOG_POSES) {
    assert.equal(DOG_FRAMES[pose], 2)
    const frames = [0, 1].map((f) => dogPixels(pose, f))
    for (const rects of frames) {
      assert.ok(rects.length > 0)
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0, `${pose}: ${JSON.stringify(r)}`)
        assert.ok(r.x + r.w <= DOG_GRID.w && r.y + r.h <= DOG_GRID.h, `${pose}: ${JSON.stringify(r)}`)
      }
    }
    assert.notDeepEqual(frames[0], frames[1])
  }
})

test('every pose stands on the ground: something is drawn on the bottom row', () => {
  for (const pose of DOG_POSES) for (const f of [0, 1]) assert.ok(dogPixels(pose, f).some((r) => r.y + r.h === DOG_GRID.h), `${pose} ${f}`)
})

test('petted, the tongue is out; otherwise it is not', () => {
  const colors = (pose) => new Set(dogPixels(pose, 0).map((r) => r.fill))
  const tongue = [...colors('happy')].filter((c) => !colors('sit').has(c))
  assert.equal(tongue.length, 1)
  assert.ok(!colors('run').has(tongue[0]))
})

test('the dog starts on the strip, left of the fire', () => {
  assert.equal(dogStart(1000), 250)
  assert.ok(dogStart(200) >= DOG_EDGE)
})

test('a trip ends inside the strip, a real run away, at a steady speed', () => {
  for (const at of [0, 0.1, 0.33, 0.5, 0.77, 0.999]) {
    for (const from of [24, 300, 500, 976]) {
      const t = dogTrip(seq(0.9, at, 0.5), from, 1000, 500)
      assert.ok(t.x >= DOG_EDGE && t.x <= 1000 - DOG_EDGE, `x ${t.x}`)
      assert.ok(Math.abs(t.x - from) >= DOG_MIN_TRIP, `from ${from} to ${t.x}`)
      assert.equal(t.runMs, Math.round((Math.abs(t.x - from) / DOG_SPEED) * 1000))
      assert.equal(Number.isInteger(t.x), true)
    }
  }
})

test('the rest after a run is between the shortest and the longest', () => {
  assert.equal(dogTrip(seq(0.9, 0.5, 0), 100, 1000).restMs, DOG_REST_MS[0])
  assert.equal(dogTrip(seq(0.9, 0.5, 0.5), 100, 1000).restMs, (DOG_REST_MS[0] + DOG_REST_MS[1]) / 2)
})

test('some trips go to the fire, on the side the dog comes from', () => {
  assert.equal(dogTrip(seq(0.1, 0.9, 0.5), 100, 1000, 500).x, 456)
  assert.equal(dogTrip(seq(0.1, 0.1, 0.5), 900, 1000, 500).x, 544)
  // No fire lit: anywhere
  assert.equal(dogTrip(seq(0.1, 0.5, 0.5), 100, 1000).x, 500)
  // Already beside the fire: somewhere else
  assert.notEqual(dogTrip(seq(0.1, 0.9, 0.5), 456, 1000, 500).x, 456)
})

test('a strip too narrow to run in: the dog stays, inside it', () => {
  const t = dogTrip(seq(0.5), 400, 120)
  assert.equal(t.runMs, 0)
  assert.ok(t.x >= 0 && t.x <= 120)
  assert.equal(dogTrip(seq(0.5), 60, 120).x, 60)
})

test('a dog left outside by a resize runs back in', () => {
  const t = dogTrip(seq(0.9, 0.5, 0.5), 1400, 1000)
  assert.ok(t.x <= 1000 - DOG_EDGE)
  assert.ok(t.runMs > 0)
})

test('between the buildings: the dog starts and runs only in [left, right] (the middle)', () => {
  assert.equal(dogStart(1100, 300), 500)
  assert.ok(dogStart(400, 300) >= 300 + DOG_EDGE)
  for (const at of [0, 0.1, 0.5, 0.9, 0.999]) {
    for (const from of [0, 150, 320, 700, 1080, 1500]) {
      const t = dogTrip(seq(0.9, at, 0.5), from, 1100, 700, 300)
      assert.ok(t.x >= 300 + DOG_EDGE && t.x <= 1100 - DOG_EDGE, `from ${from}: x ${t.x}`)
    }
  }
  // Too narrow a middle to run in: it stays, inside it
  const t = dogTrip(seq(0.5), 100, 400, undefined, 300)
  assert.equal(t.runMs, 0)
  assert.ok(t.x >= 300 && t.x <= 400, `x ${t.x}`)
})
