// scripts/campsiteStage.test.mjs — the Pixi strip's pure half (plugins/campsite/shared/stage.ts):
// pixels to RGBA, the animations' timing, walks, the dog's wander and the scene's geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lookFor } from '../plugins/campsite/shared/hiker.ts'
import { tentColors } from '../plugins/campsite/shared/layout.ts'
import { SIGN_GLYPHS } from '../plugins/campsite/shared/pose.ts'
import { FRAMES, POSES, pixels } from '../plugins/campsite/shared/pixels.ts'
import { backdrop, FEET_Y, fireParts, INSIDE_FEET_Y, logBox, signBoxes, tentShapes, departed, DOG_HAPPY_MS, DOG_SETTLE_MS, dogAdvance, dogFrameAt, dogHalt, dogInit, dogPet, dogPoseAt, dogResize, dogX, flameScale, frameAt, greyscale, heartAt, heartPixels, motionAt, offstage, rasterize, reconcileMovers, rgb, signAlpha, walkAt, WALK_MS } from '../plugins/campsite/shared/stage.ts'

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
  assert.equal(motionAt('step', 0).dy, 0)
  assert.equal(motionAt('step', 100).dy, -0.5)
  assert.equal(motionAt('step', 200).dy, -1)
  assert.equal(motionAt('step', 300).dy, -0.5)
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

test('a sign blinks in four held steps: full, fading, faint, fading', () => {
  assert.equal(signAlpha(0), 1)
  assert.ok(Math.abs(signAlpha(300) - 0.65) < 1e-9)
  assert.equal(signAlpha(600), 0.3)
  assert.ok(Math.abs(signAlpha(800) - 0.65) < 1e-9)
})

test('flames step through 1, 1.125, 1.25, 1.125, a third of a cycle apart', () => {
  assert.equal(flameScale(0, 0), 1)
  assert.equal(flameScale(0, 100), 1.125)
  assert.equal(flameScale(0, 150), 1.25)
  assert.equal(flameScale(0, 250), 1.125)
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

const W = 1000
const settled = (spots) => reconcileMovers(new Map(), spots, W, 0, { first: true, instant: false })

test('offstage is past the nearer edge', () => {
  assert.equal(offstage(100, W), -54)
  assert.equal(offstage(700, W), 1054)
})

test("the stage's first layout: everyone appears in place", () => {
  const m = settled([{ terminalId: 'a', x: 300 }])
  assert.deepEqual(walkAt(m.get('a').walk, 0), { x: 300, walking: false })
  assert.equal(m.get('a').leaving, false)
})

test('a new hiker walks in from the nearer edge, in WALK_MS', () => {
  const m = reconcileMovers(settled([]), [{ terminalId: 'a', x: 300 }], W, 1000, { first: false, instant: false })
  const a = m.get('a')
  assert.deepEqual(a.walk, { from: -54, to: 300, start: 1000 })
  assert.equal(a.facingLeft, false)
  assert.deepEqual(walkAt(a.walk, 1000 + WALK_MS / 2), { x: 123, walking: true })
  assert.deepEqual(walkAt(a.walk, 1000 + WALK_MS), { x: 300, walking: false })
})

test('a moved hiker walks from where it is now, and faces the way it goes', () => {
  const one = reconcileMovers(settled([{ terminalId: 'a', x: 300 }]), [{ terminalId: 'a', x: 500 }], W, 5000, { first: false, instant: false })
  assert.deepEqual(one.get('a').walk, { from: 300, to: 500, start: 5000 })
  assert.equal(one.get('a').facingLeft, false)
  const two = reconcileMovers(one, [{ terminalId: 'a', x: 100 }], W, 5600, { first: false, instant: false })
  assert.deepEqual(two.get('a').walk, { from: 400, to: 100, start: 5600 })
  assert.equal(two.get('a').facingLeft, true)
})

test('an unmoved hiker keeps its walk (the same object)', () => {
  const one = settled([{ terminalId: 'a', x: 300 }])
  const two = reconcileMovers(one, [{ terminalId: 'a', x: 300 }], W, 9000, { first: false, instant: false })
  assert.equal(two.get('a'), one.get('a'))
})

test('a gone hiker walks off to the nearer edge, then is dropped', () => {
  const gone = reconcileMovers(settled([{ terminalId: 'a', x: 700 }]), [], W, 100, { first: false, instant: false })
  const a = gone.get('a')
  assert.equal(a.leaving, true)
  assert.deepEqual(a.walk, { from: 700, to: 1054, start: 100 })
  assert.equal(departed(a, 100 + WALK_MS - 1), false)
  assert.equal(departed(a, 100 + WALK_MS), true)
  assert.equal(reconcileMovers(gone, [], W, 100 + WALK_MS, { first: false, instant: false }).has('a'), false)
})

test('a leaving hiker back under its id turns round', () => {
  const gone = reconcileMovers(settled([{ terminalId: 'a', x: 700 }]), [], W, 100, { first: false, instant: false })
  const back = reconcileMovers(gone, [{ terminalId: 'a', x: 700 }], W, 700, { first: false, instant: false }).get('a')
  assert.equal(back.leaving, false)
  assert.deepEqual(back.walk, { from: 877, to: 700, start: 700 })
  assert.equal(back.facingLeft, true)
})

test('instant (reduced motion): hikers appear, move and vanish in place', () => {
  const one = reconcileMovers(settled([{ terminalId: 'a', x: 300 }]), [{ terminalId: 'a', x: 500 }, { terminalId: 'b', x: 200 }], W, 10, { first: false, instant: true })
  assert.deepEqual(one.get('a').walk, { from: 500, to: 500, start: 10 })
  assert.deepEqual(one.get('b').walk, { from: 200, to: 200, start: 10 })
  assert.equal(reconcileMovers(one, [], W, 20, { first: false, instant: true }).size, 0)
})

// dogTrip takes three numbers: 0.9 (not to the fire), 0.9 (where: 24 + 0.9 × 752 → 701), 0 (the shortest rest, 1500 ms)
const trip = () => seq(0.9, 0.9, 0)

test('the dog starts sitting a quarter of the way in, and settles before its first run', () => {
  const s = dogInit(800, 0)
  assert.equal(dogX(s, 0), 200)
  assert.equal(dogPoseAt(s, 0), 'sit')
  assert.equal(dogAdvance(s, DOG_SETTLE_MS - 1, trip(), 800), s)
})

test('then it runs where dogTrip says, and sits there for the trip’s rest', () => {
  const run = dogAdvance(dogInit(800, 0), DOG_SETTLE_MS, trip(), 800)
  assert.equal(run.running, true)
  assert.equal(run.from, 200)
  assert.equal(run.to, 701)
  assert.equal(run.until, DOG_SETTLE_MS + 3854)
  assert.equal(run.left, false)
  assert.equal(dogPoseAt(run, DOG_SETTLE_MS + 1), 'run')
  assert.equal(dogX(run, DOG_SETTLE_MS + 1927), 450.5)
  const sat = dogAdvance(run, run.until, trip(), 800)
  assert.equal(sat.running, false)
  assert.equal(dogX(sat, run.until), 701)
  assert.equal(sat.until, run.until + 1500)
})

test('petted, it stops where it is and wags for DOG_HAPPY_MS', () => {
  const run = dogAdvance(dogInit(800, 0), DOG_SETTLE_MS, trip(), 800)
  const t = DOG_SETTLE_MS + 1927
  const pet = dogPet(run, t)
  assert.equal(pet.running, false)
  assert.equal(dogX(pet, t + 5), 450.5)
  assert.equal(dogPoseAt(pet, t + 5), 'happy')
  assert.equal(pet.until, t + DOG_HAPPY_MS)
  assert.equal(dogPoseAt(pet, t + DOG_HAPPY_MS), 'sit')
})

test('a resize stops it inside the strip, and it settles again', () => {
  const run = dogAdvance(dogInit(800, 0), DOG_SETTLE_MS, trip(), 800)
  const t = DOG_SETTLE_MS + 1927
  const s = dogResize(run, t, 300)
  assert.equal(s.running, false)
  assert.equal(dogX(s, t), 300)
  assert.equal(s.until, t + DOG_SETTLE_MS)
})

test('halted mid-run (the window hidden), it stays where it was drawn', () => {
  const run = dogAdvance(dogInit(800, 0), DOG_SETTLE_MS, trip(), 800)
  const t = DOG_SETTLE_MS + 1927
  assert.equal(dogPoseAt(run, t), 'run')
  const x = dogX(run, t)
  const s = dogHalt(run, t, 800)
  assert.equal(s.running, false)
  for (const later of [t, t + 100, t + 5000, t + 60_000]) assert.equal(dogX(s, later), x)
})

test('feet: 10 px above the strip’s bottom; inside a tent, 14', () => {
  assert.equal(FEET_Y, 102)
  assert.equal(INSIDE_FEET_Y, 98)
})

test('the backdrop: stars, a crescent moon, a ridge, 16 pines on the ground line, and the ground', () => {
  const b = backdrop(1000)
  assert.equal(b.stars.length, 10)
  assert.deepEqual(b.stars[0], { x: 70, y: 14, w: 2, h: 2, fill: '#5a5068' })
  // Left of the header's counts at the right end (180 px kept); 9% in from the right on a strip wide enough
  assert.deepEqual(b.moon, { x: 826, y: 18, r: 6, fill: '#f0c9a0' })
  assert.deepEqual(b.bite, { x: 830, y: 15, r: 5, fill: '#1a1622' })
  assert.equal(backdrop(3000).moon.x, 3000 - 270 - 12 + 6)
  assert.deepEqual(b.ridge.points.slice(0, 2), [0, 98])
  assert.deepEqual(b.ridge.points.slice(-2), [1000, 98])
  for (let i = 1; i < b.ridge.points.length; i += 2) assert.ok(b.ridge.points[i] >= 52 && b.ridge.points[i] <= 98)
  assert.equal(b.pines.length, 16)
  for (const p of b.pines) assert.equal(Math.max(...p.points.filter((_, i) => i % 2 === 1)), 98)
  assert.equal(Math.min(...b.pines[0].points.filter((_, i) => i % 2 === 1)), 70)
  assert.deepEqual(b.ground[0], { x: 0, y: 98, w: 1000, h: 14, fill: '#16141b' })
})

test('the fire: a 46 px hearth on the feet line, three flames on it, two embers, and the glow', () => {
  const f = fireParts(500)
  assert.equal(f.hearth[0].x, 477)
  assert.equal(f.hearth.at(-1).x + f.hearth.at(-1).w, 523)
  for (const b of f.hearth) assert.equal(b.y + b.h, 102)
  assert.deepEqual(f.flames.map((b) => [b.x, b.y + b.h, b.h]), [[490, 96, 12], [497, 96, 20], [504, 96, 10]])
  assert.deepEqual(f.embers.map((b) => [b.x, b.y]), [[506, 67], [494, 60]])
  assert.deepEqual(f.glow, { x: 430, y: 52, w: 140, h: 100 })
})

test("a tent: two faces in its worktree's colors and a door, 84×52 standing 12 px up", () => {
  const [left, right] = tentColors('wt-1')
  const [a, b, door] = tentShapes(300, 'wt-1')
  assert.deepEqual(a, { points: [258, 100, 300, 48, 300, 100], fill: left })
  assert.deepEqual(b, { points: [300, 48, 342, 100, 300, 100], fill: right })
  assert.deepEqual(door, { points: [292, 100, 300, 72, 308, 100], fill: '#1f160b' })
})

test('the log, 72×6 on the feet line', () => {
  assert.deepEqual(logBox(200), { x: 164, y: 96, w: 72, h: 6, fill: '#5a3a22' })
})

test("a sign: a board over the head and its glyph's cells, from the hiker's top-left", () => {
  const boxes = signBoxes('attention', '#e2a336')
  assert.deepEqual(boxes[0], { x: 10.5, y: -24, w: 15, h: 21, fill: '#e2a336' })
  assert.equal(boxes.length, 1 + SIGN_GLYPHS.attention.length)
  assert.deepEqual(boxes[1], { x: 16.5, y: -21, w: 3, h: 3, fill: '#111113' })
})

test('a dog whose run and rest both ended long ago goes straight on to its next trip', () => {
  const run = dogAdvance(dogInit(800, 0), DOG_SETTLE_MS, trip(), 800)
  const s = dogAdvance(run, run.until + 60_000, trip(), 800)
  assert.equal(s.from, 701)
  assert.ok(s.until > run.until + 60_000)
})

test('under reduced motion a settled hiker keeps its Mover', () => {
  const opts = { first: false, instant: true }
  const one = reconcileMovers(new Map(), [{ terminalId: 'a', x: 300 }], W, 0, opts)
  const two = reconcileMovers(one, [{ terminalId: 'a', x: 300 }], W, 5, opts)
  assert.equal(two.get('a'), one.get('a'))
})

test('a negative t still lands on a step', () => {
  assert.equal(flameScale(2, 50), 1.25)
  assert.ok(Math.abs(signAlpha(-100) - 0.65) < 1e-9)
})

test('greyscale of #d97757 is 138 in every channel (luminance 137.52)', () => {
  const grey = greyscale(rasterize([{ x: 0, y: 0, w: 1, h: 1, fill: '#d97757' }], 1, 1))
  assert.deepEqual([...grey], [138, 138, 138, 255])
})

test('a strip too narrow to run in leaves the dog sitting', () => {
  const s = dogAdvance(dogInit(150, 0), DOG_SETTLE_MS, trip(), 150)
  assert.equal(s.running, false)
  assert.ok(s.until > DOG_SETTLE_MS)
})

test('a zero-width backdrop has no NaN', () => {
  const b = backdrop(0)
  const nums = [...b.stars.flatMap((x) => [x.x, x.y, x.w, x.h]), ...[b.moon, b.bite].flatMap((c) => [c.x, c.y, c.r]), ...b.ridge.points, ...b.pines.flatMap((p) => p.points), ...b.ground.flatMap((x) => [x.x, x.y, x.w, x.h])]
  assert.ok(nums.length > 0 && nums.every((n) => Number.isFinite(n)))
})

test('between the buildings: the dog starts, wanders and is stopped inside [left, right]', () => {
  const s = dogInit(1100, 0, 300)
  assert.equal(dogX(s, 0), 500)
  let d = s
  for (let t = DOG_SETTLE_MS, i = 0; i < 40; i++, t += 7000) {
    d = dogAdvance(d, t, seq(0.9, (i * 0.37) % 1, 0), 1100, 700, 300)
    assert.ok(d.to >= 300 && d.to <= 1100, `to ${d.to}`)
  }
  // A building went up under it: it stops inside the new middle and settles
  const moved = dogResize(dogInit(1600, 0), 10, 1300, 500)
  assert.equal(dogX(moved, 10), 500)
  assert.equal(moved.until, 10 + DOG_SETTLE_MS)
  assert.equal(dogX(dogHalt(dogInit(1600, 0), 10, 1300, 500), 10), 500)
  assert.equal(dogX(dogResize(dogInit(1600, 0), 10, 300, 0), 10), 300)
  assert.equal(dogX(dogResize(dogInit(1600, 0), 10, 1600, 0), 10), 400, 'no reserve: as before')
})
