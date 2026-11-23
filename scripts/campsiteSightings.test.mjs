// scripts/campsiteSightings.test.mjs — sightings in the camp (campsite part 3d-2): the minute roll
// and its odds, the field guide, the last sightings, the project's last species, the away card,
// the windows' clock, camp version 6 and what restore drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { awayHolds, awaySeen, awayText } from '../plugins/campsite/shared/away.ts'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { restore } from '../plugins/campsite/shared/economy.ts'
import { ACTIVE_MS, SIGHTINGS_MAX, contextFor, dropBadWildlife, isActive, recordSighting, rollSighting, setClock } from '../plugins/campsite/shared/wildlife.ts'

const T0 = Date.UTC(2026, 10, 23, 12)
const H = 3_600_000
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let x = Math.imul(s ^ (s >>> 15), 1 | s)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
const seq = (...xs) => {
  let i = 0
  return () => xs[i++ % xs.length]
}

test('recordSighting: the guide counts (first and last), the last 30 sightings, the project\'s last species, the away tally (new species once)', () => {
  const camp = newCamp(1, T0)
  recordSighting(camp, 'fox', 'p', T0)
  recordSighting(camp, 'deer', 'q', T0 + 1)
  recordSighting(camp, 'fox', 'p', T0 + 2)
  assert.deepEqual(camp.guide, { fox: { count: 2, first: T0, last: T0 + 2 }, deer: { count: 1, first: T0 + 1, last: T0 + 1 } })
  assert.deepEqual(camp.sightings, [
    { species: 'fox', projectId: 'p', at: T0 },
    { species: 'deer', projectId: 'q', at: T0 + 1 },
    { species: 'fox', projectId: 'p', at: T0 + 2 }
  ])
  assert.deepEqual(camp.lastSeen, { p: 'fox', q: 'deer' })
  assert.deepEqual([camp.away.sightings, camp.away.newSpecies], [3, ['fox', 'deer']])
  for (let i = 0; i < 40; i++) recordSighting(camp, i % 2 ? 'rabbit' : 'elk', 'p', T0 + 10 + i)
  assert.equal(SIGHTINGS_MAX, 30)
  assert.equal(camp.sightings.length, 30, 'only the last 30 are kept')
  assert.equal(camp.sightings.at(-1).at, T0 + 49)
  assert.deepEqual(camp.away.newSpecies, ['fox', 'deer', 'elk', 'rabbit'])
})

test('isActive: a working session in the project, or activity within ACTIVE_MS (10 minutes)', () => {
  const camp = newCamp(1, T0)
  assert.equal(ACTIVE_MS, 600_000)
  assert.equal(isActive(camp, 'p', T0), false)
  camp.lastActive.p = T0 - ACTIVE_MS + 1
  assert.equal(isActive(camp, 'p', T0), true)
  assert.equal(isActive(camp, 'p', T0 + 1), false)
  camp.spans.t1 = { start: T0 - H, paid: 0, project: 'q' }
  assert.equal(isActive(camp, 'q', T0), true)
})

test('rollSighting: about 1 in 20 minutes while active, 1 in 120 quiet, ×1.25 with tower II (seeded); a hit is logged and never repeats the last species', () => {
  const minutes = 24_000
  const count = (setup, seed) => {
    const camp = newCamp(1, T0)
    setup(camp)
    const rand = seeded(seed)
    let hits = 0
    let last = null
    for (let i = 0; i < minutes; i++) {
      const id = rollSighting(camp, 'p', T0, rand)
      if (id === null) continue
      assert.notEqual(id, last, 'never twice running')
      last = id
      hits++
    }
    assert.equal(camp.guide && Object.values(camp.guide).reduce((n, g) => n + g.count, 0), hits, 'each hit in the guide')
    return hits
  }
  const active = count((c) => (c.lastActive.p = T0), 11)
  const quiet = count(() => {}, 12)
  const towerActive = count((c) => {
    c.lastActive.p = T0
    c.built.tower = 2
  }, 13)
  assert.ok(Math.abs(active - minutes / 20) < 90, `active ${active}`)
  assert.ok(Math.abs(quiet - minutes / 120) < 40, `quiet ${quiet}`)
  assert.ok(Math.abs(towerActive - (minutes / 20) * 1.25) < 100, `tower II ${towerActive}`)
  // force (the smokes' TREK_CAMPSITE_FORCE_SIGHTINGS): every roll hits, no dice for the chance
  const camp = newCamp(1, T0)
  assert.equal(rollSighting(camp, 'p', T0, seq(0), true), 'deer')
  assert.equal(rollSighting(camp, 'p', T0, seq(0.99), false), null, 'a miss logs nothing more')
  assert.equal(camp.guide.deer.count, 1)
})

test("contextFor: the time of day and season by the windows' clock (another time zone, the hemisphere), the project's weather, the lake and the tower", () => {
  const camp = newCamp(1, T0)
  camp.built.lake = 1
  camp.built.tower = 2
  camp.clock = { tz: 'Asia/Tokyo', seasons: 'south' }
  assert.deepEqual(contextFor(camp, 'p', T0), { phase: 'night', season: 'spring', weather: 'clear', built: { lake: 1, tower: 2 } })
  camp.clock = { tz: 'Europe/London', seasons: 'off' }
  camp.lastActive.p = T0 - 13 * H
  assert.deepEqual(contextFor(camp, 'p', T0), { phase: 'day', season: null, weather: 'fog', built: { lake: 1, tower: 2 } })
  camp.trails['p:w'] = { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T0, stageAt: T0, checks: 'failed', checksAt: T0 - H }
  assert.equal(contextFor(camp, 'p', T0).weather, 'rain')
})

test("setClock: a window's time zone and seasons are kept when valid; an unknown zone or a bad value leaves the one before", () => {
  const camp = newCamp(1, T0)
  assert.deepEqual(camp.clock, { tz: null, seasons: 'north' })
  assert.equal(setClock(camp, { tz: 'Europe/Oslo', seasons: 'south' }), true)
  assert.deepEqual(camp.clock, { tz: 'Europe/Oslo', seasons: 'south' })
  assert.equal(setClock(camp, { tz: 'Europe/Oslo', seasons: 'south' }), false, 'the same: no change')
  assert.equal(setClock(camp, { tz: 'Mars/Olympus', seasons: 'east' }), false)
  assert.equal(setClock(camp, {}), false)
  assert.deepEqual(camp.clock, { tz: 'Europe/Oslo', seasons: 'south' })
  assert.equal(setClock(camp, { seasons: 'off' }), true)
  assert.deepEqual(camp.clock, { tz: 'Europe/Oslo', seasons: 'off' })
})

test('setClock: a time zone is kept by its canonical name; another spelling of the same zone is no change', () => {
  const camp = newCamp(1, T0)
  assert.equal(setClock(camp, { tz: 'europe/oslo' }), true)
  assert.equal(camp.clock.tz, 'Europe/Oslo')
  for (const tz of ['EUROPE/OSLO', 'Europe/Oslo']) assert.equal(setClock(camp, { tz }), false, tz)
  assert.equal(setClock(camp, { tz: 'US/Pacific' }), true)
  assert.equal(camp.clock.tz, 'America/Los_Angeles')
  assert.equal(setClock(camp, { tz: 'america/los_angeles' }), false)
  // Restore canonicalises a saved spelling too
  const saved = { ...newCamp(1, T0), clock: { tz: 'europe/oslo', seasons: 'south' } }
  dropBadWildlife(saved)
  assert.deepEqual(saved.clock, { tz: 'Europe/Oslo', seasons: 'south' })
})

test('the snapshot carries the guide (a copy); the away card the sightings and the new species by name; awayText says so', () => {
  const camp = newCamp(1, T0)
  recordSighting(camp, 'heron', 'p', T0)
  recordSighting(camp, 'lynx', 'p', T0 + 1)
  recordSighting(camp, 'heron', 'p', T0 + 2)
  const snap = snapshot(camp, T0 + 5 * H)
  assert.deepEqual(snap.guide, { heron: { count: 2, first: T0, last: T0 + 2 }, lynx: { count: 1, first: T0 + 1, last: T0 + 1 } })
  assert.notEqual(snap.guide.heron, camp.guide.heron)
  assert.deepEqual([snap.away.sightings, snap.away.newSpecies], [3, ['Great blue heron', 'Lynx']], 'a new species makes the card due')
  assert.equal(awayText(snap.away), 'While you were away (5 h): 3 sightings · 2 new species: Great blue heron, Lynx')
  assert.equal(awayText({ ...snap.away, sightings: 1, newSpecies: [] }), 'While you were away (5 h): 1 sighting')
  const { sightings, newSpecies, ...older } = snap.away
  assert.equal(awayText({ ...older, markers: 1 }), 'While you were away (5 h): ⛳ +1', 'an older server sends neither')
})

test('the away card: sightings of species already in the guide are no reason to show it; a new species is; on a card due for something else they still count', () => {
  const camp = newCamp(1, T0)
  recordSighting(camp, 'fox', 'p', T0)
  awaySeen(camp, T0)
  recordSighting(camp, 'fox', 'p', T0 + 1)
  recordSighting(camp, 'fox', 'q', T0 + 2)
  assert.equal(awayHolds(camp.away), false)
  assert.equal(snapshot(camp, T0 + 5 * H).away, undefined, 'two known sightings alone: no card')
  camp.away.markers = 1
  assert.deepEqual([snapshot(camp, T0 + 5 * H).away.sightings, snapshot(camp, T0 + 5 * H).away.newSpecies], [2, []], 'due for a marker: the sightings show')
  camp.away.markers = 0
  recordSighting(camp, 'owl', 'p', T0 + 3)
  assert.deepEqual([snapshot(camp, T0 + 5 * H).away.sightings, snapshot(camp, T0 + 5 * H).away.newSpecies], [3, ['Great horned owl']], 'a new species: due')
  camp.away.newSpecies = ['dragon']
  assert.equal(awayHolds(camp.away), false, 'an unknown id is nothing to tell')
})

test('migrateCamp: version 5 gains the ranger tower (not built), an empty guide, no sightings or last species, the default clock and no sightings while away', () => {
  const v6 = newCamp(1, T0)
  const { guide, sightings, lastSeen, clock, ...rest } = v6
  const { tower, ...built } = v6.built
  const { sightings: s, newSpecies, ...away } = v6.away
  const v5 = { ...rest, version: 5, built, away }
  assert.equal(isCamp(v5), false, 'not before the migration')
  const out = migrateCamp(v5)
  assert.ok(isCamp(out))
  assert.equal(out.version, 6)
  assert.equal(out.built.tower, 0)
  assert.deepEqual([out.guide, out.sightings, out.lastSeen, out.clock], [{}, [], {}, { tz: null, seasons: 'north' }])
  assert.deepEqual([out.away.sightings, out.away.newSpecies], [0, []])
})

/** A camp.json as version `v` (2–5) wrote it: newCamp's fields, without those later versions added */
function older(v) {
  const { guide, sightings, lastSeen, clock, ...camp } = JSON.parse(JSON.stringify(newCamp(1, T0)))
  const { tower, ...built } = camp.built
  const { sightings: s, newSpecies, ...away } = camp.away
  let out = { ...camp, version: 5, built, away, wood: 77, trails: { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T0, stageAt: T0, checks: null, checksAt: null } }, lastActive: { p: T0 } }
  if (v <= 4) {
    const { lastActive, ...rest } = out
    out = { ...rest, version: 4, trails: { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 2, start: T0, stageAt: T0 } } }
  }
  if (v <= 3) {
    const { trails, trailLog, trailsDone, summits, ...rest } = out
    const { signpost, ...b } = rest.built
    out = { ...rest, version: 3, built: b }
  }
  if (v <= 2) {
    const { seenKinds, ...rest } = out
    const { shed, ...b } = rest.built
    out = { ...rest, version: 2, built: b, crew: rest.crew.map(({ gear, pin, journal, ...m }) => m) }
  }
  return out
}

test('migrateCamp: versions 2, 3, 4 and 5 go straight to 6, with the wildlife defaults and their wood kept', () => {
  for (const v of [2, 3, 4, 5]) {
    const raw = older(v)
    assert.equal(raw.version, v)
    assert.equal(isCamp(raw), false, `version ${v} is not a camp before the migration`)
    const out = migrateCamp(raw)
    assert.ok(isCamp(out), `version ${v} migrates to a camp`)
    assert.equal(out.version, 6)
    assert.equal(out.wood, 77)
    assert.equal(out.built.tower, 0)
    assert.deepEqual([out.guide, out.sightings, out.lastSeen, out.clock], [{}, [], {}, { tz: null, seasons: 'north' }], `version ${v}`)
    assert.deepEqual([out.away.sightings, out.away.newSpecies], [0, []])
    assert.deepEqual(out.lastActive, v === 5 ? { p: T0 } : {})
    assert.deepEqual(Object.keys(out.trails), v >= 4 ? ['p:w'] : [])
    // The migrated camp survives restore unchanged in its wildlife
    restore(out, undefined, T0)
    assert.deepEqual([out.guide, out.sightings, out.clock], [{}, [], { tz: null, seasons: 'north' }])
  }
})

test('restore: guide pages, sightings, last species and a clock it cannot read are dropped or defaulted; the camp is kept', () => {
  const camp = newCamp(1, T0)
  camp.guide = { fox: { count: 2, first: T0, last: T0 }, dragon: { count: 1, first: T0, last: T0 }, deer: { count: 0, first: T0, last: T0 }, elk: 'x' }
  camp.sightings = [{ species: 'fox', projectId: 'p', at: T0 }, { species: 'dragon', projectId: 'p', at: T0 }, { species: 'fox', at: T0 }, 3]
  camp.lastSeen = { p: 'fox', q: 'dragon', r: 4 }
  camp.clock = { tz: 'Mars/Olympus', seasons: 'east' }
  camp.away.sightings = -2
  camp.away.newSpecies = ['fox', 'dragon', 7]
  restore(camp, undefined, T0)
  assert.deepEqual(camp.guide, { fox: { count: 2, first: T0, last: T0 } })
  assert.deepEqual(camp.sightings, [{ species: 'fox', projectId: 'p', at: T0 }])
  assert.deepEqual(camp.lastSeen, { p: 'fox' })
  assert.deepEqual(camp.clock, { tz: null, seasons: 'north' })
  assert.deepEqual([camp.away.sightings, camp.away.newSpecies], [0, ['fox']])
  const gone = newCamp(1, T0)
  gone.guide = null
  gone.sightings = 'x'
  gone.lastSeen = []
  delete gone.clock
  delete gone.away.sightings
  delete gone.away.newSpecies
  assert.ok(isCamp(gone), 'unreadable wildlife is no reason to lose the camp')
  restore(gone, undefined, T0)
  assert.deepEqual([gone.guide, gone.sightings, gone.lastSeen, gone.clock, gone.away.sightings, gone.away.newSpecies], [{}, [], {}, { tz: null, seasons: 'north' }, 0, []])
})
