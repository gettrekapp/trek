// scripts/campsiteWorld.test.mjs — the world around the camp (campsite part 3d-1): the time of day,
// the seasons, the backdrop's palettes (dusk exactly as before), the weather from a project's trails
// and last activity, and the snow caps' clipping; camp version 5 (the trails' checks, each project's
// last activity).
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { weatherBadge } from '../plugins/campsite/shared/campView.ts'
import { applyActivity, restore, tick } from '../plugins/campsite/shared/economy.ts'
import { trailEvent } from '../plugins/campsite/shared/trails.ts'
import { BLEND_MIN, DUSK, DUSK_WORLD, PALETTES, QUIET_MS, capsAbove, mix, paletteAt, phaseAt, seasonAt, weatherOf, worldAt, worldKey, worldPalette } from '../plugins/campsite/shared/world.ts'

const H = 3_600_000
/** A local time on 2026-11-23 */
const at = (h, m = 0, s = 0) => new Date(2026, 10, 23, h, m, s)

test('phaseAt: dawn 05–08, day 08–17, dusk 17–20, night 20–05, at each boundary', () => {
  assert.deepEqual(phaseAt(at(5)), { phase: 'dawn', next: 'day', blend: 0 })
  assert.deepEqual(phaseAt(at(4, 59, 59)).phase, 'night')
  assert.deepEqual(phaseAt(at(8)), { phase: 'day', next: 'dusk', blend: 0 })
  assert.equal(phaseAt(at(7, 59, 59)).phase, 'dawn')
  assert.deepEqual(phaseAt(at(17)), { phase: 'dusk', next: 'night', blend: 0 })
  assert.equal(phaseAt(at(16, 59)).phase, 'day')
  assert.deepEqual(phaseAt(at(20)), { phase: 'night', next: 'dawn', blend: 0 })
  assert.equal(phaseAt(at(19, 59)).phase, 'dusk')
  assert.deepEqual(phaseAt(at(0)), { phase: 'night', next: 'dawn', blend: 0 })
  assert.deepEqual(phaseAt(at(12)), { phase: 'day', next: 'dusk', blend: 0 })
})

test('phaseAt: the blend rises over the last 30 minutes before the next phase (across midnight too); an invalid date is dusk', () => {
  assert.equal(BLEND_MIN, 30)
  assert.equal(phaseAt(at(16, 30)).blend, 0)
  assert.equal(phaseAt(at(16, 45)).blend, 0.5)
  assert.ok(Math.abs(phaseAt(at(16, 59, 30)).blend - (1 - 0.5 / 30)) < 1e-9)
  assert.equal(phaseAt(at(4, 45)).blend, 0.5)
  assert.equal(phaseAt(at(4, 45)).next, 'dawn')
  assert.equal(phaseAt(at(23, 45)).blend, 0, 'night lasts past midnight: no blend at 23:45')
  assert.deepEqual(phaseAt(new Date(NaN)), DUSK)
})

test('seasonAt: northern by the month, southern six months on, off none; an invalid date none', () => {
  const month = (m) => new Date(2026, m, 15)
  assert.deepEqual([11, 0, 1, 2, 4, 5, 7, 8, 10].map((m) => seasonAt(month(m), 'north')), ['winter', 'winter', 'winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn'])
  assert.deepEqual([11, 0, 1, 2, 4, 5, 7, 8, 10].map((m) => seasonAt(month(m), 'south')), ['summer', 'summer', 'summer', 'autumn', 'autumn', 'winter', 'winter', 'spring', 'spring'])
  assert.equal(seasonAt(month(0), 'off'), null)
  assert.equal(seasonAt(new Date(NaN), 'north'), null)
})

test("paletteAt: dusk with no season is exactly the strip's colours before 3d", () => {
  assert.equal(paletteAt('dusk', 'night', 0, null), PALETTES.dusk)
  assert.deepEqual(PALETTES.dusk, {
    sky: '#1a1622',
    stars: '#5a5068',
    starAlpha: 1,
    moreStars: 0,
    moon: '#f0c9a0',
    bite: 1,
    ridge: '#272031',
    peak: '#2f2740',
    ledge: '#463c5c',
    path: '#3d3450',
    pineLight: '#1e1a27',
    pineDark: '#17141d',
    pineRust: null,
    ground: '#16141b',
    groundEdge: '#2c2536',
    trail: '#221e2a',
    snow: null,
    glow: 1,
    lights: true
  })
  assert.equal(worldPalette(DUSK_WORLD), PALETTES.dusk)
})

test('paletteAt: day has no stars, a full pale sun, a smaller glow and dark lights; night more stars and a wider glow; the blend mixes toward the next', () => {
  const day = paletteAt('day', 'dusk', 0, null)
  assert.deepEqual([day.starAlpha, day.moreStars, day.bite, day.lights], [0, 0, 0, false])
  assert.ok(day.glow < 1)
  const night = paletteAt('night', 'dawn', 0, null)
  assert.deepEqual([night.moreStars, night.lights], [1, true])
  assert.ok(night.glow > 1)
  const half = paletteAt('day', 'dusk', 0.5, null)
  assert.equal(half.sky, mix(PALETTES.day.sky, PALETTES.dusk.sky, 0.5))
  assert.equal(half.starAlpha, 0.5)
  assert.equal(half.lights, true, 'switched at the halfway point')
  assert.equal(paletteAt('day', 'dusk', 0.25, null).lights, false)
})

test('mix: 0 keeps the colour as it is, 1 is the other, halfway rounds each channel', () => {
  assert.equal(mix('#1A1622', '#ffffff', 0), '#1A1622')
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff')
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mix('#102030', '#305070', 0.5), '#203850')
})

test('season tints: winter frosts the pines, whitens the ground edge and brings snow; autumn rusts some pines; spring greens the ground; summer none', () => {
  const dusk = PALETTES.dusk
  const winter = paletteAt('dusk', 'night', 0, 'winter')
  assert.notEqual(winter.pineLight, dusk.pineLight)
  assert.notEqual(winter.groundEdge, dusk.groundEdge)
  assert.equal(typeof winter.snow, 'string')
  const autumn = paletteAt('dusk', 'night', 0, 'autumn')
  assert.equal(typeof autumn.pineRust, 'string')
  assert.equal(autumn.pineLight, dusk.pineLight)
  const spring = paletteAt('dusk', 'night', 0, 'spring')
  assert.notEqual(spring.ground, dusk.ground)
  assert.equal(spring.snow, null)
  assert.equal(paletteAt('dusk', 'night', 0, 'summer'), dusk)
})

const T = 1_800_000_000_000
const tr = (o = {}) => ({ projectId: 'p', branch: 'feature/x', checks: null, ...o })

test("weatherOf: rain while a project's trail has failing checks (snow in winter), with its branch; another project's or passing checks don't count", () => {
  assert.deepEqual(weatherOf([tr({ checks: 'passed' }), tr({ branch: 'feature/y', checks: 'failed' })], { p: T }, 'p', T, null), { kind: 'rain', branch: 'feature/y' })
  assert.deepEqual(weatherOf([tr({ checks: 'failed' })], { p: T }, 'p', T, 'winter'), { kind: 'snow', branch: 'feature/x' })
  assert.deepEqual(weatherOf([tr({ projectId: 'q', checks: 'failed' })], { p: T }, 'p', T, null), { kind: 'clear' })
  assert.deepEqual(weatherOf([tr({ checks: 'failed' })], { p: T - 20 * H }, 'p', T, null).kind, 'rain', 'rain before fog')
})

test('weatherOf: fog from 12 quiet hours (whole hours as the reason); clear before; a project with no last activity is active now', () => {
  assert.equal(QUIET_MS, 12 * H)
  assert.deepEqual(weatherOf([], { p: T - 12 * H }, 'p', T, null), { kind: 'fog', hours: 12 })
  assert.deepEqual(weatherOf([], { p: T - 14.5 * H }, 'p', T, null), { kind: 'fog', hours: 14 })
  assert.deepEqual(weatherOf([], { p: T - 12 * H + 1 }, 'p', T, null), { kind: 'clear' })
  assert.deepEqual(weatherOf([], {}, 'p', T, null), { kind: 'clear' })
  assert.deepEqual(weatherOf([], { q: T - 20 * H }, 'p', T, null), { kind: 'clear' })
})

test('weather dims the sky and hides most stars; clear leaves the palette as it is', () => {
  const rain = worldPalette({ ...DUSK_WORLD, weather: 'rain' })
  assert.notEqual(rain.sky, PALETTES.dusk.sky)
  assert.ok(rain.starAlpha < 0.5)
  const fog = worldPalette({ ...DUSK_WORLD, weather: 'fog' })
  assert.notEqual(fog.sky, PALETTES.dusk.sky)
  assert.equal(worldPalette({ ...DUSK_WORLD, weather: 'clear' }), PALETTES.dusk)
})

test('worldAt: the clock or always dusk; the blend in sixteenths; the season by the hemisphere; worldKey changes only with what is shown', () => {
  const noon = at(12).getTime()
  assert.deepEqual(worldAt(noon, 'clock', 'north', 'clear'), { phase: 'day', next: 'dusk', blend: 0, season: 'autumn', weather: 'clear' })
  assert.deepEqual(worldAt(noon, 'dusk', 'off', 'rain'), { phase: 'dusk', next: 'night', blend: 0, season: null, weather: 'rain' })
  assert.equal(worldAt(at(16, 40).getTime(), 'clock', 'north', 'clear').blend, 5 / 16, '10 of 30 minutes: 0.33 → 5/16')
  assert.equal(worldKey(worldAt(at(16, 40).getTime(), 'clock', 'north', 'clear')), worldKey(worldAt(at(16, 40, 30).getTime(), 'clock', 'north', 'clear')))
  assert.notEqual(worldKey(worldAt(noon, 'clock', 'north', 'clear')), worldKey(worldAt(noon, 'clock', 'north', 'fog')))
  assert.equal(worldKey(DUSK_WORLD), 'dusk>night:0:none:clear')
})

test('capsAbove: each top of a polygon above the cut, as its own polygon; none when nothing reaches above; a polygon wholly above whole', () => {
  // Two peaks (at x 10 and 30) over a base at y 20
  const ridge = [0, 20, 10, 0, 20, 10, 30, 2, 40, 20]
  const caps = capsAbove(ridge, 5)
  assert.equal(caps.length, 2)
  assert.deepEqual(caps[0], [7.5, 5, 10, 0, 15, 5])
  assert.deepEqual(caps[1].slice(2, 4), [30, 2])
  assert.ok(caps.every((c) => c.length >= 6 && c.every((v, i) => i % 2 === 0 || v <= 5)))
  assert.deepEqual(capsAbove(ridge, -1), [])
  assert.deepEqual(capsAbove(ridge, 30), [ridge])
})

/** A version 4 camp.json, as 3c wrote it, with one trail */
function v4() {
  const { lastActive, ...rest } = JSON.parse(JSON.stringify(newCamp(1, T)))
  return { ...rest, version: 4, trails: { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T, stageAt: T } } }
}

test('migrateCamp: version 4 gains no checks on each trail and no last activity', () => {
  const raw = v4()
  assert.equal(isCamp(raw), false, 'not before the migration')
  const out = migrateCamp(raw)
  assert.ok(isCamp(out))
  assert.equal(out.version, 5)
  assert.deepEqual(out.trails['p:w'], { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T, stageAt: T, checks: null })
  assert.deepEqual(out.lastActive, {})
  assert.equal(migrateCamp({ version: 4, trails: 'x' }).trails, 'x', 'a malformed one is left for isCamp to refuse')
})

test('restore: checks it cannot read become null (the trail stays); last activity that is not a time is dropped', () => {
  const camp = newCamp(1, T)
  camp.trails = { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T, stageAt: T, checks: 'maybe' }, 'p:v': { projectId: 'p', worktreeId: 'v', repoId: 'r', branch: 'c', stage: 2, start: T, stageAt: T, checks: 'failed' } }
  camp.lastActive = { p: T, q: 'yesterday', r: null, s: T - 5 }
  const raw = JSON.parse(JSON.stringify(camp))
  assert.ok(isCamp(raw))
  restore(raw)
  assert.deepEqual([raw.trails['p:w'].checks, raw.trails['p:v'].checks], [null, 'failed'])
  assert.deepEqual(raw.lastActive, { p: T, s: T - 5 })
})

const pr = (kind, o = {}) => ({ kind, projectId: 'p', at: T, repoId: 'r', branch: 'feature/a', url: 'u', ...o })

test("trailEvent: a pull request's checks are kept on its trails; a new pull request and its end (merged or closed) clear them", () => {
  const camp = newCamp(1, T)
  trailEvent(camp, { kind: 'worktree.created', projectId: 'p', at: T, repoId: 'r', worktreeId: 'a', branch: 'feature/a' }, T)
  assert.equal(camp.trails['p:a'].checks, null)
  trailEvent(camp, pr('pr.linked'), T + 1)
  trailEvent(camp, pr('pr.checks', { result: 'failed', headSha: 's' }), T + 2)
  assert.equal(camp.trails['p:a'].checks, 'failed')
  trailEvent(camp, pr('pr.checks', { result: 'passed', headSha: 't' }), T + 3)
  assert.equal(camp.trails['p:a'].checks, 'passed')
  trailEvent(camp, pr('pr.checks', { result: 'failed', headSha: 'u' }), T + 4)
  trailEvent(camp, pr('pr.linked', { url: 'v' }), T + 5)
  assert.equal(camp.trails['p:a'].checks, null, 'a new pull request')
  trailEvent(camp, pr('pr.checks', { url: 'v', result: 'failed', headSha: 'w' }), T + 6)
  trailEvent(camp, pr('pr.ended', { url: 'v', result: 'closed' }), T + 7)
  assert.equal(camp.trails['p:a'].checks, null, 'closed')
  trailEvent(camp, pr('pr.checks', { url: 'v', result: 'failed', headSha: 'x' }), T + 8)
  trailEvent(camp, pr('pr.ended', { url: 'v', result: 'merged' }), T + 9)
  assert.equal(camp.trails['p:a'].checks, null, 'merged')
})

test("lastActive: every activity event stamps its project; the tick stamps the projects of working sessions; the snapshot carries trails' checks and every project's last activity", () => {
  const camp = newCamp(1, T)
  applyActivity(camp, { kind: 'session.started', projectId: 'p', at: T, terminalId: 't1', worktreeId: null, provider: 'claude', automation: false, sessionType: null }, T)
  applyActivity(camp, pr('pr.linked', { projectId: 'q' }), T + 5)
  assert.deepEqual(camp.lastActive, { p: T, q: T + 5 })
  applyActivity(camp, { kind: 'session.status', projectId: 'p', at: T, terminalId: 't1', worktreeId: null, provider: 'claude', automation: false, sessionType: null, from: 'idle', to: 'working', cause: 'output' }, T + 10)
  tick(camp, T + 3 * 60_000)
  assert.deepEqual(camp.lastActive, { p: T + 3 * 60_000, q: T + 5 })
  camp.trails['p:a'] = { projectId: 'p', worktreeId: 'a', repoId: 'r', branch: 'feature/a', stage: 2, start: T, stageAt: T, checks: 'failed' }
  const snap = snapshot(camp, T + 3 * 60_000)
  assert.equal(snap.trails[0].checks, 'failed')
  assert.deepEqual(snap.lastActive, { p: T + 3 * 60_000, q: T + 5 })
  snap.lastActive.p = 0
  assert.equal(camp.lastActive.p, T + 3 * 60_000, 'a copy')
})

test("weatherBadge: the header's glyph and its reason; none when clear", () => {
  assert.deepEqual(weatherBadge({ kind: 'rain', branch: 'feature/x' }), { glyph: '🌧', text: 'Rain: checks failing on feature/x' })
  assert.deepEqual(weatherBadge({ kind: 'snow', branch: 'feature/x' }), { glyph: '❄\uFE0F', text: 'Snow: checks failing on feature/x' })
  assert.deepEqual(weatherBadge({ kind: 'fog', hours: 14 }), { glyph: '🌫\uFE0F', text: 'Fog: quiet for 14 h' })
  assert.equal(weatherBadge({ kind: 'clear' }), null)
})
