// scripts/campsiteStage.test.mjs — the Pixi strip's pure half (plugins/campsite/shared/stage.ts):
// pixels to RGBA, the animations' timing, walks, the dog's wander and the scene's geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lookFor } from '../plugins/campsite/shared/hiker.ts'
import { FRAMES, POSES, pixels } from '../plugins/campsite/shared/pixels.ts'
import { greyscale, rasterize, rgb } from '../plugins/campsite/shared/stage.ts'

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

export { seq }
