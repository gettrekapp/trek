// scripts/campsiteHiker.test.mjs — the campsite plugin's hikers: a look from a session id, pixels
// for each pose, stances, chores and labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HATS, JACKETS, NEUTRAL_JACKET, PANTS, fnv1a, kitKey, kitOf, lookFor, withKit } from '../plugins/campsite/shared/hiker.ts'
import { FRAMES, POSES, pixels, shade } from '../plugins/campsite/shared/pixels.ts'
import { CHORES, CHORE_NAMES, SIGN_COLORS, SIGN_GLYPHS, SIGN_TEXT, TOOL_CHORES, TOOL_FRESH_MS, TOOL_STALE_MS, choreFor, choreText, hikerDoing, hikerLabel, hikerTooltip, indicatorState, indicatorTitle, isWaiting, liveTool, stanceFor, statusText, statusTitle, toolWords } from '../plugins/campsite/shared/pose.ts'

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

test('pixels: every hat, beard, gear, pose and frame stays on the 12×16 grid', () => {
  const base = lookFor('sweep', 'claude')
  for (const hat of HATS)
    for (const beard of [false, true])
      for (const gear of [undefined, 'none', 'pole', 'map', 'mug', 'compass'])
        for (const pose of POSES)
          for (let frame = 0; frame < FRAMES[pose]; frame++)
            for (const r of pixels({ ...base, hat, beard }, pose, frame, gear)) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 12 && r.y + r.h <= 16, `${hat}/${beard}/${gear}/${pose}/${frame}: ${JSON.stringify(r)}`)
})

test("pixels: a bearded hiker's cheer still smiles (the mouth is drawn over the beard)", () => {
  const rects = pixels({ ...lookFor('smile', 'claude'), beard: true }, 'cheer', 0)
  const over = (x, y) => rects.filter((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h).at(-1).fill
  assert.equal(over(5, 6), '#111111')
  assert.equal(over(6, 6), '#111111')
})

test('stanceFor and indicatorTitle: a decision on a finished or exited session still waves, in color, and the title says so', () => {
  assert.deepEqual(stanceFor(session({ status: 'done', decision: true }), 'map'), { pose: 'wave', gear: 'none', grey: false, sign: 'decision' })
  assert.deepEqual(stanceFor(session({ status: 'exited', decision: true }), 'map'), { pose: 'wave', gear: 'none', grey: false, sign: 'decision' })
  assert.equal(indicatorTitle({ status: 'working', decision: true }, false), 'Agent is waiting on your decision')
  assert.equal(indicatorTitle({ status: 'attention', decision: false }, false), 'Agent needs your attention')
  assert.equal(indicatorTitle({ status: 'done', decision: false }, true), 'Agent finished — click to mark fully complete')
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

test("labels: the tooltip starts with the session's crew member when given", () => {
  assert.equal(hikerTooltip(session(), 'chop', 'Aspen · Lv 2 Trailblazer'), `Aspen · Lv 2 Trailblazer · Claude 2 · auth · working · ${CHORE_NAMES.chop}`)
  assert.equal(hikerTooltip(session({ status: 'idle' }), 'chop', 'Day hiker'), 'Day hiker · Claude 2 · auth · idle')
  assert.equal(hikerTooltip(session({ status: 'idle' }), 'chop', undefined), 'Claude 2 · auth · idle')
})

test("indicatorState: the session's own; with none, the tab's status and no decision; with neither, idle (a sleeping hiker)", () => {
  assert.deepEqual(indicatorState(session({ status: 'attention', decision: true }), 'working'), { status: 'attention', decision: true })
  assert.deepEqual(indicatorState(undefined, 'done'), { status: 'done', decision: false })
  assert.deepEqual(indicatorState(undefined, null), { status: 'idle', decision: false })
  assert.equal(stanceFor(indicatorState(undefined, null), 'chop').pose, 'sleep')
})

test('hikerDoing: its chore while working, else its status; a pending decision or a bell wins', () => {
  assert.equal(hikerDoing(session({ status: 'working' }), 'chop'), CHORE_NAMES.chop)
  assert.equal(hikerDoing(session({ status: 'working', decision: true }), 'chop'), 'waiting on your decision')
  assert.equal(hikerDoing(session({ status: 'attention' }), 'chop'), 'needs your attention')
  assert.equal(hikerDoing(session({ status: 'done' }), 'chop'), 'finished')
  assert.equal(hikerDoing(session({ status: 'someday' }), 'chop'), 'idle')
})


/** The color drawn last at (x, y), or null */
const pixelAt = (rects, x, y) => rects.findLast((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.fill ?? null
const tiers = (n) => ({ pack: n, boots: n, hat: n, tool: n })

test('withKit, kitKey, kitOf (campsite part 3b): a look wears gear; none leaves it as it is', () => {
  const look = lookFor('kit', 'claude')
  assert.equal(withKit(look, null), look)
  assert.equal(withKit(look, tiers(0)), look)
  const geared = withKit(look, { pack: 1, boots: 0, hat: 3, tool: 2 })
  assert.deepEqual(geared, { ...look, kit: { pack: 1, boots: 0, hat: 3, tool: 2 } })
  assert.equal(kitKey({ pack: 1, boots: 0, hat: 3, tool: 2 }), '1032')
  assert.equal(kitKey(tiers(0)), '')
  assert.equal(kitKey(undefined), '')
  assert.deepEqual(kitOf('1032'), { pack: 1, boots: 0, hat: 3, tool: 2 })
  assert.equal(kitOf(''), null)
  assert.equal(kitOf('1049'), null)
})

test('pixels with gear: every pose, frame and tier stays on the 12×16 grid', () => {
  for (const n of [1, 2, 3]) {
    const look = withKit(lookFor('grid', 'claude'), tiers(n))
    for (const pose of POSES) {
      for (let frame = 0; frame < FRAMES[pose]; frame++) {
        for (const r of pixels(look, pose, frame)) {
          assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 12 && r.y + r.h <= 16, `tier ${n} ${pose}/${frame}: ${JSON.stringify(r)}`)
          assert.match(r.fill, /^#[0-9a-f]{6}$/i)
        }
      }
    }
  }
})

test('pixels with gear: the pack is a column wider in its tier\'s color; boots by tier, red laces at 3', () => {
  const look = lookFor('t-1', 'claude')
  const plain = pixels(look, 'stand')
  assert.equal(pixelAt(plain, 0, 8), null, 'no gear: nothing at the far left')
  assert.equal(pixelAt(plain, 3, 15), '#6b4528')
  const packs = [1, 2, 3].map((n) => pixelAt(pixels(withKit(look, { ...tiers(0), pack: n }), 'stand'), 1, 9))
  assert.deepEqual(packs, ['#c8a46a', '#3f6b3a', '#a8323a'])
  assert.equal(pixelAt(pixels(withKit(look, { ...tiers(0), pack: 2 }), 'stand'), 0, 9), '#3f6b3a', 'a column wider')
  const boots = (n, pose = 'stand') => pixels(withKit(look, { ...tiers(0), boots: n }), pose)
  assert.deepEqual([1, 2, 3].map((n) => pixelAt(boots(n), 4, 15)), ['#8a5a2b', '#1e1e24', '#1e1e24'])
  assert.equal(pixelAt(boots(3), 3, 15), '#d8423a', 'a red lace on each boot')
  assert.equal(pixelAt(boots(3, 'sit'), 9, 14), '#d8423a', 'sitting too')
  assert.equal(pixelAt(boots(2), 3, 15), '#1e1e24')
})

test("pixels with gear: a tier hat replaces the look's own; the sleeper's cap takes its color", () => {
  const look = { ...lookFor('t-1', 'claude'), hat: 'beanie', hatColor: '#123456' }
  assert.equal(pixelAt(pixels(look, 'stand'), 5, 0), '#eeeeee', "the beanie's bobble")
  const hat = (n, pose = 'stand') => pixels(withKit(look, { ...tiers(0), hat: n }), pose)
  assert.ok(!hat(1).some((r) => r.fill === '#123456'), "no trace of the look's hat")
  assert.equal(pixelAt(hat(1), 2, 3), '#b9a77a', "the bucket hat's brim")
  assert.equal(pixelAt(hat(2), 1, 3), '#8a6a3a', "the ranger hat's wide brim")
  assert.equal(pixelAt(hat(2), 5, 0), '#6e5230', 'its crease')
  assert.equal(pixelAt(hat(3), 8, 0), '#e6e1d3', "the alpine hat's feather")
  assert.equal(pixelAt(hat(3), 5, 2), '#c94f3d', 'its red band')
  assert.equal(pixelAt(hat(3, 'sleep'), 0, 11), '#3f5a3a')
})

test('pixels with gear: the tool is strapped to the pack, rising above it', () => {
  const look = lookFor('t-1', 'claude')
  const tool = (n, pose = 'stand') => pixels(withKit(look, { ...tiers(0), tool: n }), pose)
  assert.equal(pixelAt(tool(1), 0, 2), '#9aa0a8', 'a trekking pole')
  assert.equal(pixelAt(tool(2), 2, 2), '#c9ccd1', "an ice axe's head")
  assert.equal(pixelAt(tool(2), 0, 6), '#7a5230', 'its shaft')
  assert.equal(pixelAt(tool(3), 2, 2), '#e0b84a', 'gold')
  assert.equal(pixelAt(tool(3, 'sit'), 2, 4), '#e0b84a', 'it sits down with the hiker')
  for (const n of [1, 2, 3]) assert.ok(tool(n).filter((r) => r.y < 5 + 0 && r.x < 3).length > 0, `tier ${n} shows above the pack`)
  // The axe's hook (2, 3) sits where the bucket and ranger brims reach: the tool is drawn over the hat
  for (const hat of [1, 2, 3]) {
    const px = pixels(withKit(look, { ...tiers(0), hat, tool: 2 }), 'stand')
    assert.equal(pixelAt(px, 2, 3), '#c9ccd1', `the hook shows under a tier ${hat} hat`)
    assert.equal(pixelAt(px, 2, 2), '#c9ccd1')
  }
})

test('pixels (campsite part 4): binoculars over both eyes, a radio by the face whose light blinks, thinking sits with a hand at the chin and a thought', () => {
  assert.deepEqual([FRAMES.binoculars, FRAMES.radio, FRAMES.think], [1, 2, 1])
  const look = { ...bare, gear: 'mug' }
  const bino = pixels(look, 'binoculars', 0)
  assert.equal(pixelAt(bino, 4, 4), '#8fc4e8', 'a lens over the left eye')
  assert.equal(pixelAt(bino, 7, 4), '#8fc4e8', 'a lens over the right eye')
  assert.equal(pixelAt(bino, 5, 4), '#2b2d33', 'the bridge')
  assert.equal(pixelAt(bino, 2, 4), look.skin, 'both hands up')
  assert.equal(pixelAt(bino, 9, 4), look.skin)
  assert.equal(top(bino), 2, 'standing')
  assert.equal(bino.some((r) => r.fill === '#e6e1d3'), false, "the look's own gear is not held")
  const radio = [0, 1].map((f) => pixels(look, 'radio', f))
  assert.equal(pixelAt(radio[0], 9, 5), '#4a5560', 'the radio by the face')
  assert.equal(pixelAt(radio[0], 10, 1), '#9aa0a8', 'its antenna')
  assert.deepEqual([pixelAt(radio[0], 10, 0), pixelAt(radio[1], 10, 0)], ['#6e3a30', '#ff5a3c'], 'its light off, then on')
  assert.equal(top(radio[1]), 0)
  const think = pixels(look, 'think', 0)
  assert.equal(top(think.filter((r) => r.fill !== '#b9b4c6')), 4, 'sitting, as sit does')
  assert.equal(pixelAt(think, 9, 8), look.skin, 'a hand at the chin')
  assert.equal(pixelAt(think, 9, 10), shade(look.jacket), 'its arm')
  assert.deepEqual([pixelAt(think, 10, 3), pixelAt(think, 11, 1)], ['#b9b4c6', '#b9b4c6'], 'a thought rising')
})

test("choreFor (campsite part 4): a tool call younger than 8 s shows its kind's chore; an older one, thinking; none, the random chores", () => {
  assert.equal(TOOL_FRESH_MS, 8000)
  assert.deepEqual(TOOL_CHORES, { read: 'map', edit: 'chop', run: 'fire', delegate: 'tent', web: 'binoculars', mcp: 'radio', other: 'map' })
  const at = 1_000_000
  for (const [kind, chore] of Object.entries(TOOL_CHORES)) assert.equal(choreFor('t', at + 1000, { kind, label: 'x', at }), chore, kind)
  assert.equal(choreFor('t', at, { kind: 'edit', label: '', at }), 'chop', 'just heard')
  assert.equal(choreFor('t', at + 7999, { kind: 'edit', label: '', at }), 'chop', 'the last ms')
  assert.equal(choreFor('t', at + 8000, { kind: 'edit', label: '', at }), 'think', 'from 8 s on')
  assert.equal(choreFor('t', at + 60_000, { kind: 'web', label: '', at }), 'think')
  assert.equal(choreFor('t', at + 1000, { kind: 'dance', label: '', at }), 'map', "a kind this version doesn't know is other's")
  assert.equal(choreFor('t', at + 1000, { kind: 'constructor', label: '', at }), 'map')
  // No tool (or null): the seeded random chores, as before
  for (const t of [0, 25_000, 300_000]) {
    assert.equal(choreFor('t-7', t, null), choreFor('t-7', t))
    assert.equal(choreFor('t-7', t, undefined), choreFor('t-7', t))
    assert.ok(CHORES.includes(choreFor('t-7', t)))
  }
  // Two minutes on, the call is forgotten (a `/clear`'s new transcript isn't followed): the random chores again
  assert.equal(TOOL_STALE_MS, 120_000)
  assert.equal(choreFor('t-7', at + 119_999, { kind: 'web', label: '', at }), 'think', 'the last ms of thinking')
  for (const t of [at + 120_000, at + 600_000]) assert.equal(choreFor('t-7', t, { kind: 'web', label: '', at }), choreFor('t-7', t), 'from 2 minutes on')
  const tool = { kind: 'edit', label: 'a.ts', at }
  assert.equal(liveTool(tool, at + 119_999), tool)
  assert.equal(liveTool(tool, at + 120_000), null)
  assert.equal(liveTool(null, at), null)
  assert.equal(liveTool(undefined, at), null)
  // A working hiker stands in the chore's pose: the new ones too
  assert.equal(stanceFor(session(), 'binoculars').pose, 'binoculars')
  assert.equal(stanceFor(session(), 'radio').pose, 'radio')
  assert.equal(stanceFor(session(), 'think').pose, 'think')
})

test('toolWords and choreText (campsite part 4): each kind in words, with and without a label; thinking; a chore with no tool keeps its name', () => {
  const words = (kind, label) => toolWords({ kind, label })
  assert.equal(words('read', 'Campsite.tsx'), 'Reading Campsite.tsx')
  assert.equal(words('edit', 'Campsite.tsx'), 'Editing Campsite.tsx')
  assert.equal(words('run', 'npm test'), 'Running npm test')
  assert.equal(words('delegate', 'Explore the trails'), 'Sending a scout: Explore the trails')
  assert.equal(words('web', 'github.com'), 'Looking up github.com')
  assert.equal(words('mcp', 'trek-dev list_worktrees'), 'On the radio: trek-dev list_worktrees')
  assert.equal(words('other', 'TodoWrite'), 'Using TodoWrite')
  assert.deepEqual(['read', 'edit', 'run', 'delegate', 'web', 'mcp', 'other'].map((k) => words(k, '')), ['Reading', 'Editing', 'Running a command', 'Sending a scout', 'Looking something up', 'On the radio', 'Busy'])
  const tool = { kind: 'edit', label: 'Campsite.tsx', at: 0 }
  assert.equal(choreText('chop', tool), 'Editing Campsite.tsx')
  assert.equal(choreText('think', tool), 'Thinking')
  assert.equal(choreText('think'), 'Thinking')
  assert.equal(choreText('chop'), CHORE_NAMES.chop)
  assert.equal(choreText('map', { kind: 'other', label: 'Skill', at: 0 }), 'Using Skill', "other's chore is the map")
  assert.equal(choreText('fire', tool), CHORE_NAMES.fire, "not the tool's chore: the chore's name")
})

test("hikerDoing and hikerTooltip (campsite part 4): a working hiker says its tool call or Thinking; waiting and done keep today's words", () => {
  const tool = { kind: 'run', label: 'npm test', at: 0 }
  assert.equal(hikerDoing(session(), 'fire', tool), 'Running npm test')
  assert.equal(hikerDoing(session(), 'think', tool), 'Thinking')
  assert.equal(hikerDoing(session({ status: 'attention' }), 'fire', tool), 'needs your attention')
  assert.equal(hikerDoing(session({ status: 'working', decision: true }), 'fire', tool), 'waiting on your decision')
  assert.equal(hikerDoing(session({ status: 'done' }), 'think', tool), 'finished')
  assert.equal(hikerTooltip(session(), 'fire', 'Aspen · Lv 2 Trailblazer', tool), 'Aspen · Lv 2 Trailblazer · Claude 2 · auth · working · Running npm test')
  assert.equal(hikerTooltip(session(), 'think', undefined, tool), 'Claude 2 · auth · working · Thinking')
  assert.equal(hikerTooltip(session({ status: 'idle' }), 'think', undefined, tool), 'Claude 2 · auth · idle')
  assert.equal(hikerTooltip(session(), 'chop'), `Claude 2 · auth · working · ${CHORE_NAMES.chop}`, 'no tool: as before')
})
