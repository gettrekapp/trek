// scripts/campsiteStage.test.mjs — the Pixi strip's pure half (plugins/campsite/shared/stage.ts):
// pixels to RGBA, the animations' timing, walks, the dog's wander and the scene's geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lookFor } from '../plugins/campsite/shared/hiker.ts'
import { FRAMES, POSES, pixels } from '../plugins/campsite/shared/pixels.ts'
import { dogFrameAt, flameScale, frameAt, greyscale, heartAt, heartPixels, motionAt, rasterize, rgb, signAlpha } from '../plugins/campsite/shared/stage.ts'

/** A rand that hands out the given numbers in turn */
const seq = (...values) => {
  let i = 0
  return () => values[i++ % values.length]
}
const px = (rgba, w, x, y) => [...rgba.slice((y * w + x) * 4, (y * w + x) * 4 + 4)]

test('rgb reads a #rrggbb color', () => {
  assert.deepEqual(rgb('#c94f3d'), [0xc9, 0x4f, 0x3d])
})

test('rasterize paints one pixel per cell, later rects over earlier ones, clipped to the grid', () => {
  const rgba = rasterize(
    [
      { x: 0, y: 0, w: 2, h: 1, fill: '#ff0000' },
      { x: 1, y: 0, w: 5, h: 5, fill: '#00ff00' }
    ],
    3,
    2
  )
  assert.equal(rgba.length, 3 * 2 * 4)
  assert.deepEqual(px(rgba, 3, 0, 0), [255, 0, 0, 255])
  assert.deepEqual(px(rgba, 3, 1, 0), [0, 255, 0, 255])
  assert.deepEqual(px(rgba, 3, 2, 1), [0, 255, 0, 255])
  assert.deepEqual(px(rgba, 3, 0, 1), [0, 0, 0, 0])
})

test('greyscale makes the channels equal, keeps alpha, and leaves the input alone', () => {
  const rgba = rasterize([{ x: 0, y: 0, w: 1, h: 1, fill: '#d97757' }], 2, 1)
  const grey = greyscale(rgba)
  const [r, g, b, a] = px(grey, 2, 0, 0)
  assert.equal(r, g)
  assert.equal(g, b)
  assert.equal(a, 255)
  assert.deepEqual(px(grey, 2, 1, 0), [0, 0, 0, 0])
  assert.deepEqual(px(rgba, 2, 0, 0), [0xd9, 0x77, 0x57, 255])
})

test('every hiker pose and frame stands on the bottom row of its 12×16 grid', () => {
  const look = lookFor('t1', 'claude')
  for (const pose of POSES) {
    for (let f = 0; f < FRAMES[pose]; f++) {
      const rgba = rasterize(pixels(look, pose, f), 12, 16)
      const bottom = Array.from({ length: 12 }, (_, x) => px(rgba, 12, x, 15)[3])
      assert.ok(bottom.some((a) => a === 255), `${pose} ${f}`)
    }
  }
})

test('two-frame poses swap every 250 ms, a sleeper every 1.5 s; one-frame poses stay on 0', () => {
  assert.equal(frameAt('chop', 0), 0)
  assert.equal(frameAt('chop', 250), 1)
  assert.equal(frameAt('chop', 500), 0)
  assert.equal(frameAt('sleep', 1499), 0)
  assert.equal(frameAt('sleep', 1500), 1)
  assert.equal(frameAt('cheer', 300), 0)
})

test('motions: bob, wave, step, hop and breathe, as the CSS had them; none is still', () => {
  assert.deepEqual(motionAt('bob', 0), { dy: 0, sx: 1, sy: 1 })
  assert.equal(motionAt('bob', 700).dy, -1)
  assert.equal(motionAt('wave', 250).dy, -1)
  assert.equal(motionAt('step', 100).dy, 0)
  assert.equal(motionAt('step', 200).dy, -1)
  assert.equal(motionAt('hop', 0).dy, 0)
  assert.equal(motionAt('hop', 450).dy, -4)
  const breath = motionAt('breathe', 1500)
  assert.ok(Math.abs(breath.sx - 1.03) < 1e-9 && Math.abs(breath.sy - 0.97) < 1e-9)
  assert.equal(breath.dy, 0)
  assert.deepEqual(motionAt(undefined, 123), { dy: 0, sx: 1, sy: 1 })
})

test('the dog swaps frames at its own pace', () => {
  assert.equal(dogFrameAt('run', 149), 0)
  assert.equal(dogFrameAt('run', 150), 1)
  assert.equal(dogFrameAt('happy', 120), 1)
  assert.equal(dogFrameAt('sit', 249), 0)
})

test('a sign blinks: full, then faint, each half a second', () => {
  assert.equal(signAlpha(0), 1)
  assert.equal(signAlpha(600), 0.3)
})

test('flames flicker a third of a cycle apart', () => {
  assert.equal(flameScale(0, 0), 1)
  assert.equal(flameScale(0, 150), 1.25)
  assert.equal(flameScale(1, 0), 1.25)
  assert.equal(flameScale(1, 100), 1)
})

test("a pet's heart pops up, rises and fades over a second", () => {
  assert.deepEqual(heartAt(0), { dy: 4, alpha: 0, scale: 0.6 })
  assert.deepEqual(heartAt(200), { dy: -2, alpha: 1, scale: 1 })
  assert.equal(heartAt(1000), null)
  assert.equal(heartAt(-1), null)
  const cells = heartPixels()
  assert.ok(cells.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 7 && r.y + r.h <= 6))
})

export { seq }
