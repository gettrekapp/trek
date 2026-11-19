// scripts/campsiteHiker.test.mjs — the campsite plugin's hikers: a look from a session id, pixels
// for each pose, stances, chores and labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HATS, JACKETS, NEUTRAL_JACKET, PANTS, fnv1a, lookFor } from '../plugins/campsite/shared/hiker.ts'
import { FRAMES, POSES, pixels, shade } from '../plugins/campsite/shared/pixels.ts'
import { CHORES, CHORE_NAMES, SIGN_COLORS, SIGN_GLYPHS, SIGN_TEXT, choreFor, hikerLabel, hikerTooltip, indicatorState, isWaiting, stanceFor, statusText, statusTitle } from '../plugins/campsite/shared/pose.ts'

test('fnv1a: the 32-bit FNV-1a of the text', () => {
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('a'), 0xe40c292c)
})

test('lookFor: the same look for the same id; jacket by provider, neutral when unknown', () => {
  assert.deepEqual(lookFor('t-1', 'claude'), lookFor('t-1', 'claude'))
  assert.equal(lookFor('t-1', 'claude').jacket, JACKETS.claude)
  assert.equal(lookFor('t-1', 'codex').jacket, JACKETS.codex)
  assert.equal(lookFor('t-1', 'mystery').jacket, NEUTRAL_JACKET)
  assert.equal(lookFor('t-1', 'constructor').jacket, NEUTRAL_JACKET, "Object's own names are not providers")
  const { jacket: _a, ...rest1 } = lookFor('t-1', 'claude')
  const { jacket: _b, ...rest2 } = lookFor('t-1', 'gemini')
  assert.deepEqual(rest1, rest2, 'the provider changes only the jacket')
})

test('lookFor: pants are drawn last, so hikers from before keep every other trait', () => {
  const { pants: p1, ...before1 } = lookFor('t-1', 'claude')
  assert.deepEqual(before1, { jacket: '#d97757', hat: 'headlamp', hatColor: '#b9a77a', hair: '#e0b050', skin: '#d9a066', beard: true, pack: '#7a4a6b', gear: 'compass' })
  const { pants: p2, ...before2 } = lookFor('session-7', 'codex')
  assert.deepEqual(before2, { jacket: '#3fae6a', hat: 'headlamp', hatColor: '#b9a77a', hair: '#3b2a1a', skin: '#f2c9a0', beard: true, pack: '#8a5a2b', gear: 'mug' })
  for (const p of [p1, p2]) assert.ok(PANTS.includes(p), p)
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(lookFor(`session-${i}`, 'claude').pants)
  assert.equal(seen.size, PANTS.length)
})

test('lookFor: looks spread out (no hat on more than 35% of 1000 sessions; beards near 30%)', () => {
  const hats = new Map()
  let beards = 0
  for (let i = 0; i < 1000; i++) {
    const look = lookFor(`session-${i}`, 'claude')
    hats.set(look.hat, (hats.get(look.hat) ?? 0) + 1)
    if (look.beard) beards++
  }
  assert.equal(hats.size, HATS.length)
  for (const [hat, n] of hats) assert.ok(n <= 350, `${hat}: ${n}`)
  assert.ok(beards > 220 && beards < 380, `beards: ${beards}`)
})

test('pixels: every pose and frame stays on the 12×16 grid', () => {
  const look = lookFor('grid', 'claude')
  for (const pose of POSES) {
    for (let frame = 0; frame < FRAMES[pose]; frame++) {
      const rects = pixels(look, pose, frame)
      assert.ok(rects.length > 10, `${pose}/${frame} draws a hiker`)
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 12 && r.y + r.h <= 16, `${pose}/${frame}: ${JSON.stringify(r)}`)
        assert.match(r.fill, /^#[0-9a-f]{6}$/i)
      }
    }
  }
})

test("pixels: the jacket and the hat show; a two-frame pose's frames differ; gear can be overridden", () => {
  const look = { ...lookFor('x', 'codex'), hat: 'beanie' }
  const fills = (rects) => new Set(rects.map((r) => r.fill))
  assert.ok(fills(pixels(look, 'stand', 0)).has(look.jacket))
  assert.ok(fills(pixels(look, 'stand', 0)).has(look.hatColor))
  for (const pose of POSES.filter((p) => FRAMES[p] === 2)) assert.notDeepEqual(pixels(look, pose, 0), pixels(look, pose, 1), pose)
  const withMug = pixels({ ...look, gear: 'pole' }, 'sit', 0, 'mug')
  assert.ok(withMug.some((r) => r.fill === '#e6e1d3'), 'the mug')
})

const top = (rects) => Math.min(...rects.map((r) => r.y))
const right = (rects) => Math.max(...rects.map((r) => r.x + r.w))
const bare = { ...lookFor('shape', 'claude'), hat: 'none', beard: false }

test('shade: each channel × 0.76', () => {
  assert.equal(shade('#000000'), '#000000')
  assert.equal(shade('#ffffff'), '#c2c2c2')
  assert.equal(shade('#d97757'), '#a55a42')
})

test('pixels: sitting is 2 rows lower than standing, crouched chores 1 row; legs reach forward when seated', () => {
  assert.equal(top(pixels(bare, 'stand', 0, 'none')), 2)
  assert.equal(top(pixels(bare, 'sit', 0, 'none')), 4)
  assert.equal(top(pixels(bare, 'tent', 0)), 3)
  assert.equal(top(pixels(bare, 'fire', 0)), 3)
  assert.equal(right(pixels(bare, 'stand', 0, 'none')), 10)
  assert.equal(right(pixels(bare, 'sit', 0, 'none')), 11, 'boots out front')
})

test('pixels: a sleeper lies down, low and full width, in a bag the color of its jacket; a second z on frame 1', () => {
  const asleep = pixels(bare, 'sleep', 0)
  assert.ok(asleep.filter((r) => r.fill !== '#b9b4c6').every((r) => r.y >= 11), 'everything but the z is in the bottom 5 rows')
  assert.equal(Math.min(...asleep.map((r) => r.x)), 0)
  assert.equal(right(asleep), 12)
  assert.ok(asleep.some((r) => r.fill === bare.jacket && r.w === 8), 'the bag')
  assert.equal(pixels(bare, 'sleep', 1).length, asleep.length + 3)
})

test('pixels: sleeves and the hem are the shaded jacket; pants and a bedroll show; wave, sleep and fire have two frames', () => {
  const fills = (rects) => new Set(rects.map((r) => r.fill))
  const standing = fills(pixels(bare, 'stand', 0, 'none'))
  assert.ok(standing.has(shade(bare.jacket)), 'sleeves')
  assert.ok(standing.has(bare.pants), 'pants')
  assert.ok(standing.has('#d9c9a0'), 'bedroll')
  assert.deepEqual([FRAMES.wave, FRAMES.sleep, FRAMES.fire, FRAMES.sit, FRAMES.cheer], [2, 2, 2, 1, 1])
})

const session = (over = {}) => ({ terminalId: 't', label: 'Claude 2', provider: 'claude', status: 'working', decision: false, worktreeId: 'w', worktreeName: 'auth', branch: 'feature/auth', ...over })

test('stanceFor: each status; a decision waves with its own sign, and wins over attention; finished cheers; unknown sleeps', () => {
  assert.deepEqual(stanceFor(session({ status: 'working' }), 'chop'), { pose: 'chop', grey: false, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'attention' }), 'chop'), { pose: 'wave', gear: 'none', grey: false, sign: 'attention' })
  assert.deepEqual(stanceFor(session({ status: 'idle', decision: true }), 'chop'), { pose: 'wave', gear: 'none', grey: false, sign: 'decision' })
  assert.deepEqual(stanceFor(session({ status: 'attention', decision: true }), 'chop'), { pose: 'wave', gear: 'none', grey: false, sign: 'decision' })
  assert.deepEqual(stanceFor(session({ status: 'starting' }), 'map'), { pose: 'walk', grey: false, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'done' }), 'map'), { pose: 'cheer', gear: 'none', grey: false, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'complete' }), 'map'), { pose: 'sit', gear: 'mug', grey: false, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'idle' }), 'map'), { pose: 'sleep', grey: false, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'exited' }), 'map'), { pose: 'sit', gear: 'none', grey: true, sign: null })
  assert.deepEqual(stanceFor(session({ status: 'someday' }), 'map'), { pose: 'sleep', grey: false, sign: null })
  assert.equal(isWaiting(session({ status: 'attention' })), true)
  assert.equal(isWaiting(session({ decision: true })), true)
  assert.equal(isWaiting(session()), false)
})

test("signs: '!' and '?' on a 3×5 grid, in the core's attention and decision colors", () => {
  assert.deepEqual(SIGN_TEXT, { attention: '!', decision: '?' })
  assert.equal(SIGN_COLORS.attention, 'var(--attention, #e2a336)')
  assert.equal(SIGN_COLORS.decision, 'var(--decision, #b18cff)')
  for (const cells of Object.values(SIGN_GLYPHS)) for (const [x, y] of cells) assert.ok(x >= 0 && x < 3 && y >= 0 && y < 5)
  assert.deepEqual(SIGN_GLYPHS.attention, [[1, 0], [1, 1], [1, 2], [1, 4]])
  assert.deepEqual(SIGN_GLYPHS.decision, [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]])
})

test('choreFor: stable for at least 20 s at a time, and it changes over ten minutes', () => {
  let changing = 0
  for (let i = 0; i < 20; i++) {
    const id = `chore-${i}`
    const seen = new Set()
    let changes = 0
    let last = choreFor(id, 0)
    let lastChange = null
    for (let t = 0; t <= 600_000; t += 500) {
      const c = choreFor(id, t)
      assert.ok(CHORES.includes(c))
      seen.add(c)
      if (c !== last) {
        changes++
        if (lastChange !== null) assert.ok(t - lastChange >= 20_000, `${id}: changed after ${t - lastChange} ms`)
        lastChange = t
      }
      last = c
    }
    assert.ok(changes <= 600_000 / 20_000 + 1, `${id}: ${changes} changes`)
    if (seen.size > 1) changing++
  }
  assert.ok(changing >= 15, `${changing} of 20 hikers changed chores`)
})

test('labels: the aria label, the badge titles, the tooltip', () => {
  assert.equal(hikerLabel(session({ status: 'attention' })), 'Claude 2, needs your attention')
  assert.equal(hikerLabel(session({ decision: true })), 'Claude 2, waiting on your decision')
  assert.equal(statusTitle('working', false), 'Agent is working')
  assert.equal(statusTitle('done', true), 'Agent finished — click to mark fully complete')
  assert.equal(statusTitle('complete', true), 'Marked complete — status tracking paused — click to resume tracking')
  assert.equal(hikerTooltip(session(), 'chop'), `Claude 2 · auth · working · ${CHORE_NAMES.chop}`)
  assert.equal(hikerTooltip(session({ worktreeId: null, worktreeName: null, branch: null, status: 'idle' }), 'chop'), 'Claude 2 · Global · idle')
})

test('labels: an unknown status reads as idle; a worktree session with no name falls back to its branch', () => {
  assert.equal(statusText(session({ status: 'someday' })), 'idle')
  assert.equal(hikerLabel(session({ status: 'someday' })), 'Claude 2, idle')
  assert.equal(statusTitle('someday', true), 'Agent is idle')
  assert.equal(hikerTooltip(session({ worktreeName: null, branch: 'feature/x', status: 'idle' }), 'chop'), 'Claude 2 · feature/x · idle')
  assert.equal(hikerTooltip(session({ worktreeName: null, branch: null, status: 'idle' }), 'chop'), 'Claude 2 · idle')
  assert.equal(hikerTooltip(session({ worktreeId: null, worktreeName: 'x', branch: null, status: 'idle' }), 'chop'), 'Claude 2 · Global · idle')
})

test("indicatorState: the session's own; with none, the tab's status and no decision; with neither, idle (a sleeping hiker)", () => {
  assert.deepEqual(indicatorState(session({ status: 'attention', decision: true }), 'working'), { status: 'attention', decision: true })
  assert.deepEqual(indicatorState(undefined, 'done'), { status: 'done', decision: false })
  assert.deepEqual(indicatorState(undefined, null), { status: 'idle', decision: false })
  assert.equal(stanceFor(indicatorState(undefined, null), 'chop').pose, 'sleep')
})
