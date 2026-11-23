// The campsite strip without the app: the real Campsite component on a fake plugin host, with the
// sessions of the scenario named in ?scenario= (default "few"); ?dog=0 hides the dog.
// ?built=out builds every building; ?away=1 shows the away card; ?crew=geared gives t1–t3's members
// gear (t1's tier 3 in every slot, t2's mixed, t3's tier 1) and the second a pin and a journal (which
// the fake host answers to `journal`, as the server does). ?trails=all (campsite 3c) puts the harness
// project's trails on every stage (three at the trailhead, eight on the switchbacks: "+2", two planted), another
// project's two, 12 summits (the cairn) and both projects' histories (the fake host answers
// `trailLog`); window.__summit(worktreeId, branch) sends the summit event, as the server does.
// ?freeze=1 stops both clocks (below). The world (campsite 3d-1): ?at=2026-11-23T12:00 (local time)
// pins the window's clock there (it runs on from it, or stands still with ?freeze=1) and follows it
// (the sky "Follow the clock", the seasons ?seasons=north|south|off, default north); without ?at the
// strip is always dusk with no season, its look before 3d. ?weather=rain fails the checks of the
// harness project's api trail (snow in winter); ?weather=fog leaves the project quiet for 14 hours.
// Wildlife (campsite 3d-2): ?tower=1|2 builds the ranger tower; ?guide=some fills the field guide
// (five species, three first seen in the last two days: the new dot; the Guide tab last opened two
// days ago); ?away=sightings adds 12 sightings and two new species to the away card;
// ?animal=<species> sends a sighting once the strip is up (?dir=left|right, default left), then
// (?age=<ms>) moves the page's performance.now on by that much, so the animal is drawn that far
// into its crossing, frozen or not (?r, default 0.5, is the crossing's die: its length and spot);
// window.__sighting(species, dir) sends one, as the server does.
// ?sheet=1 shows every species' two frames at the strip's scale instead of the strip.
// Real chores (campsite 4): ?tool=read|edit|run|delegate|web|mcp|other gives t1 (working) a tool call
// a second old, in the `state` answer as the server sends it (its chore and its tooltip's words);
// ?tool=think, one 20 s old (thinking). ?sheet=hikers shows every hiker pose and frame at the tab's,
// the terminal bar's and the strip's scales (1, 2, 3) instead of the strip.
// scripts/campsite-render.mjs serves it with Vite and screenshots each scenario. Not shipped: nothing imports it.
import { createRoot } from 'react-dom/client'
import { PluginHostContext, type ClientPluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import '../client/campsite.css'
import { Campsite } from '../client/Campsite.tsx'
import { ANIMAL_SCALE, animalPixels, animalSize } from '../shared/animalPixels.ts'
import { newCamp, snapshot } from '../shared/camp.ts'
import { lookFor, withKit } from '../shared/hiker.ts'
import { FRAMES, POSES, pixels } from '../shared/pixels.ts'
import { SPECIES } from '../shared/wildlife.ts'

const PROVIDERS = ['claude', 'codex', 'gemini', 'grok']
const s = (n: number, status: PluginSession['status'], worktree: string | null, extra: Partial<PluginSession> = {}): PluginSession => ({
  terminalId: `t${n}`,
  label: `Agent ${n}`,
  provider: PROVIDERS[n % PROVIDERS.length],
  status,
  decision: false,
  worktreeId: worktree,
  worktreeName: worktree,
  branch: worktree ? `feature/${worktree}` : null,
  ...extra
})

const SCENARIOS: Record<string, PluginSession[]> = {
  empty: [],
  few: [s(1, 'working', 'api'), s(2, 'attention', 'api'), s(3, 'done', 'web'), s(4, 'idle', null), s(5, 'complete', 'web'), s(6, 'working', null, { decision: true })],
  exited: [s(1, 'exited', 'api'), s(2, 'working', 'api'), s(3, 'exited', null)],
  grouped: Array.from({ length: 20 }, (_, i) => s(i + 1, i % 5 === 0 ? 'attention' : 'working', `wt${i % 6}`))
}

const params = new URLSearchParams(location.search)
// ?freeze=1: both clocks stand still (Date.now at ?at, else 2026-11-23 12:00 UTC; performance.now at
// 1 ms), so a shot is the same pixels on every run: `campsite:render -- <dir> --freeze` before and
// after a change that must not move anything, then compare the PNGs byte for byte. With --freeze the
// render script has already frozen them (and `new Date()`) before any script ran, imports included;
// this is for the page opened by hand, and sets the same values. ?at alone: the clock starts there and
// runs on. Either way Date.now and an argument-less `new Date()` agree (a Date with arguments is the
// real one). Frozen, Math.random is seeded too (mulberry32), so the particles land in the same places
const pinned = params.has('at') ? new Date(params.get('at') ?? '').getTime() : NaN
const frozen = params.get('freeze') === '1'
if (frozen || Number.isFinite(pinned)) {
  const RealDate = Date
  const base = Number.isFinite(pinned) ? pinned : Date.UTC(2026, 10, 23, 12)
  const start = RealDate.now()
  const clock = frozen ? () => base : () => base + (RealDate.now() - start)
  const ClockDate = function (this: unknown, ...a: unknown[]) {
    if (!new.target) return new RealDate(clock()).toString()
    return a.length === 0 ? new RealDate(clock()) : new RealDate(...(a as [number]))
  } as unknown as DateConstructor
  Object.setPrototypeOf(ClockDate, RealDate)
  ;(ClockDate as unknown as { prototype: Date }).prototype = RealDate.prototype
  ClockDate.now = clock
  globalThis.Date = ClockDate
  if (frozen) {
    performance.now = () => 1
    let seed = 0x2d1
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }
}
const sessions = SCENARIOS[params.get('scenario') ?? 'few'] ?? []
// Without ?at: always dusk, no season (the strip before 3d-1, so the older shots stay the same)
const prefs: Record<string, string | number | boolean> = Number.isFinite(pinned) ? { showDog: params.get('dog') !== '0', sky: 'clock', seasons: params.get('seasons') ?? 'north' } : { showDog: params.get('dog') !== '0', sky: 'dusk', seasons: 'off' }
// The camp's state, from the real rules: the header's counts, t1's crew member in its tooltip;
// ?built=out builds everything (all seven buildings at their top tier)
const T = Date.now()
const state = newCamp(7, T)
state.wood = 340
state.markers = 2
state.crew[0].name = 'Aspen'
state.crew[0].xp = 150
state.assignments.t1 = { crew: state.crew[0].id, project: 'harness', worktreeId: 'api', provider: 'codex', projectName: 'trek', place: 'feature/api', start: T - 3_600_000, wood: 12 }
if (params.get('built') === 'out') state.built = { lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2, signpost: 1, tower: 0 }
// ?crew=geared: the members out with t1, t2 and t3 wear tier 3 gear, mixed tiers (2, 2, 1 and none:
// its view shows Buy and a gate) and tier 1; the second is pinned to Codex and has a journal
if (params.get('crew') === 'geared') {
  state.built.shed = 2
  const GEAR = [{ pack: 3, boots: 3, hat: 3, tool: 3 }, { pack: 2, boots: 2, hat: 1, tool: 0 }, { pack: 1, boots: 1, hat: 1, tool: 1 }]
  state.crew.forEach((m, i) => {
    m.gear = GEAR[i]
    m.xp = [1700, 450, 120][i]
    state.assignments[`t${i + 1}`] = { crew: m.id, project: 'harness', worktreeId: i === 2 ? 'web' : 'api', provider: PROVIDERS[(i + 1) % PROVIDERS.length], projectName: 'trek', place: i === 2 ? 'feature/web' : 'feature/api', start: T - 3_600_000, wood: 12 }
  })
  state.seenKinds = [
    { kind: 'type', id: 'harness:rev', name: 'Review', at: T },
    { kind: 'provider', id: 'claude', name: 'Claude', at: T },
    { kind: 'provider', id: 'codex', name: 'Codex', at: T }
  ]
  state.crew[1].pin = { kind: 'provider', id: 'codex', name: 'Codex' }
  state.crew[1].journal = [
    { kind: 'hired', at: T - 9 * 86_400_000 },
    { kind: 'trip', at: T - 2 * 86_400_000, minutes: 192, project: 'trek', place: 'main', provider: 'claude', wood: 48 },
    { kind: 'level', at: T - 2 * 86_400_000, level: 3, title: 'Mountaineer' },
    { kind: 'gear', at: T - 86_400_000, slot: 'hat', tier: 1 },
    { kind: 'summit', at: T - 5 * 3_600_000, branch: 'feature/campsite-strip', project: 'trek' },
    { kind: 'pinned', at: T - 3_600_000, name: 'Codex' }
  ]
}
if (params.get('trails') === 'all') {
  const D = 86_400_000
  const trail = (projectId: string, worktreeId: string, branch: string, stage: number, ago: number) => ({ projectId, worktreeId, repoId: 'r', branch, stage, start: T - ago, stageAt: T - ago / 2, checks: null, checksAt: null })
  const all = [
    trail('harness', 'docs', 'feature/docs', 0, 3 * 3_600_000),
    trail('harness', 'auth', 'feature/auth', 0, 2 * 3_600_000),
    trail('harness', 'lint', 'chore/lint', 0, 3_600_000),
    ...Array.from({ length: 8 }, (_, i) => trail('harness', `s${i}`, `feature/step-${i}`, 1, (i + 1) * D)),
    trail('harness', 'api', 'feature/api', 2, 2 * D),
    trail('harness', 'web', 'feature/web', 3, 5 * D),
    trail('harness', 'ship', 'feature/ship', 4, 4 * 3_600_000),
    // A second planted flag: the false summit's flag steps clear of the planted row
    trail('harness', 'release', 'chore/release', 4, 9 * 3_600_000),
    trail('site', 'blog', 'feature/blog', 2, D),
    trail('site', 'nav', 'fix/nav', 0, 3_600_000)
  ]
  state.trails = Object.fromEntries(all.map((t) => [`${t.projectId}:${t.worktreeId}`, t]))
  state.summits = 12
  state.trailLog = {
    harness: [
      { branch: 'feature/campsite-strip', result: 'summited', start: T - 9 * D, end: T - 2 * D },
      { branch: 'spike/old-idea', result: 'turned-back', start: T - 6 * D, end: T - D }
    ],
    site: [{ branch: 'feature/landing', result: 'summited', start: T - 4 * D, end: T - 3 * D }]
  }
}
// ?weather=rain: the api trail's checks fail, 10 minutes ago (it is added on the ridge when ?trails isn't all);
// ?weather=fog: nothing heard from the harness project for 14 hours
if (params.get('weather') === 'rain') {
  const key = 'harness:api'
  const api = state.trails[key] ?? { projectId: 'harness', worktreeId: 'api', repoId: 'r', branch: 'feature/api', stage: 2, start: T - 86_400_000, stageAt: T - 3_600_000, checks: null, checksAt: null }
  state.trails[key] = { ...api, checks: 'failed', checksAt: T - 600_000 }
}
if (params.get('weather') === 'fog') state.lastActive.harness = T - 14 * 3_600_000
const tower = Number(params.get('tower'))
if (tower === 1 || tower === 2) state.built.tower = tower
// ?guide=some: five species seen (three of them since the Guide tab was last opened, two days ago)
if (params.get('guide') === 'some') {
  const D = 86_400_000
  state.guide = {
    deer: { count: 12, first: T - 9 * D, last: T - 3_600_000 },
    fox: { count: 3, first: T - 5 * D, last: T - D },
    owl: { count: 1, first: T - D, last: T - D },
    heron: { count: 2, first: T - 12 * 3_600_000, last: T - 3_600_000 },
    moose: { count: 1, first: T - 3_600_000, last: T - 3_600_000 }
  }
  prefs.guideSeenAt = T - 2 * D
}
// ?away=1: unseen for 9 hours, with something to tell (the card)
if (params.get('away') === '1') {
  state.seenAt = T - 9 * 3_600_000
  state.away = { since: T - 9 * 3_600_000, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 1, levelUps: [{ crewId: state.crew[1].id, level: 3 }], sightings: 0, newSpecies: [] }
}
// ?away=sightings: the same card, with 12 sightings, a heron and a lynx new among them
if (params.get('away') === 'sightings') {
  state.seenAt = T - 9 * 3_600_000
  state.away = { since: T - 9 * 3_600_000, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 0, levelUps: [], sightings: 12, newSpecies: ['heron', 'lynx'] }
}
const camp = snapshot(state, T, { project: (id) => (id === 'harness' ? 'trek' : 'website') })
// ?tool=<kind>: t1's latest tool call, a second old (?tool=think: 20 s old), as `state` answers it
const TOOL_LABELS: Record<string, string> = { read: 'Campsite.tsx', edit: 'Campsite.tsx', run: 'npm test', delegate: 'Explore the trails', web: 'github.com', mcp: 'trek-dev list_worktrees', other: 'TodoWrite' }
const toolParam = params.get('tool') ?? ''
const tools =
  toolParam === 'think'
    ? { t1: { kind: 'edit', label: TOOL_LABELS.edit, age: 20_000 } }
    : Object.hasOwn(TOOL_LABELS, toolParam)
      ? { t1: { kind: toolParam, label: TOOL_LABELS[toolParam], age: 1000 } }
      : null
const listeners = new Map<string, Set<(data: unknown) => void>>()
;(window as unknown as { __summit: (worktreeId: string, branch: string) => void }).__summit = (worktreeId, branch) => {
  for (const l of listeners.get('summit') ?? []) l({ projectId: 'harness', worktreeId, branch })
}
const sighting = (species: string, dir: string): void => {
  for (const l of listeners.get('sighting') ?? []) l({ projectId: 'harness', species, at: Date.now(), dir })
}
;(window as unknown as { __sighting: typeof sighting }).__sighting = sighting
// ?animal=<species>: once the stage is drawn, a sighting; then the page's clock moves on by ?age
const animal = params.get('animal')
if (animal) {
  const age = Number(params.get('age') ?? 0)
  const send = (): void => {
    if (!document.querySelector('.cs-canvas canvas')) {
      setTimeout(send, 50)
      return
    }
    setTimeout(() => {
      // The crossing's die (its length, pause and spot), pinned so a shot is the same in every run (?r, default 0.5)
      const random = Math.random
      const r = Number(params.get('r') ?? 0.5)
      Math.random = () => r
      try {
        sighting(animal, params.get('dir') === 'right' ? 'right' : 'left')
      } finally {
        Math.random = random
      }
      // Once the animal's button is attached (the crossing has started on the page's clock), its clock moves on
      const age_ = (): void => {
        if (!document.querySelector('.cs-animal')) {
          setTimeout(age_, 20)
          return
        }
        if (age > 0) {
          const was = performance.now.bind(performance)
          performance.now = () => was() + age
        }
        // The render waits for this before it checks and shoots the animal
        ;(window as unknown as { __animalAged: boolean }).__animalAged = true
      }
      age_()
    }, 200)
  }
  send()
}
const host = {
  id: 'campsite',
  projectId: 'harness',
  sessions: () => sessions,
  onSessionsChanged: () => () => {},
  selectedTerminalId: () => sessions[0]?.terminalId ?? null,
  focusSession: (id: string) => console.log('[harness] focus', id),
  prefs: { load: async () => prefs, set: async () => prefs, onChange: () => () => {} },
  request: async (method: string, params?: { crewId?: string; projectId?: string }) => {
    if (method === 'state') return tools ? { ...camp, tools } : camp
    if (method === 'journal') return { journal: state.crew.find((m) => m.id === params?.crewId)?.journal ?? [] }
    if (method === 'trailLog') return { log: state.trailLog[params?.projectId ?? ''] ?? [] }
    if (method === 'seen' || method === 'awaySeen') return { ok: true }
    throw new Error(`[harness] no method ${method}`)
  },
  onEvent: (event: string, listener: (data: unknown) => void) => {
    const set = listeners.get(event) ?? new Set()
    listeners.set(event, set)
    set.add(listener)
    return () => set.delete(listener)
  },
  onChanged: () => () => {}
} as unknown as ClientPluginHost

/** ?sheet=1: every species, both frames, at the strip's scale on a dusk sky over a ground line, named */
function Sheet(): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: 8, background: '#1a1622', color: '#c9c2d6', font: '11px ui-monospace, Menlo, monospace' }}>
      {SPECIES.map((s) => {
        const { w, h } = animalSize(s.id)
        return (
          <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 6, background: '#221e2a' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 60, borderBottom: '3px solid #2c2536' }}>
              {([0, 1] as const).map((f) => (
                <svg key={f} width={w * ANIMAL_SCALE} height={h * ANIMAL_SCALE} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges">
                  {animalPixels(s.id, f).map((r, i) => (
                    <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
                  ))}
                </svg>
              ))}
            </div>
            <span>
              {s.name} ({s.move})
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** ?sheet=hikers: every pose and frame, four looks (the last geared), at the tab's, the terminal bar's and the strip's scales */
function HikerSheet(): React.JSX.Element {
  const looks = [lookFor('t1', 'claude'), lookFor('t2', 'codex'), { ...lookFor('t3', 'gemini'), hat: 'cap' as const }, withKit(lookFor('t4', 'grok'), { pack: 3, boots: 3, hat: 3, tool: 3 })]
  const cells = POSES.flatMap((pose) => Array.from({ length: FRAMES[pose] }, (_, frame) => ({ pose, frame })))
  return (
    <div style={{ padding: 8, background: '#1a1622', color: '#c9c2d6', font: '10px ui-monospace, Menlo, monospace' }}>
      {[1, 2, 3].map((scale) => (
        <div key={scale} style={{ marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, ${Math.max(12 * scale, 64)}px)`, gap: 4, alignItems: 'end' }}>
            {cells.map(({ pose, frame }) => (
              <span key={`${pose}${frame}`}>
                {pose}
                {FRAMES[pose] === 2 ? ` ${frame}` : ''}
              </span>
            ))}
            {looks.flatMap((look, i) =>
              cells.map(({ pose, frame }) => (
                <svg key={`${i}${pose}${frame}`} width={12 * scale} height={16 * scale} viewBox="0 0 12 16" shapeRendering="crispEdges" style={{ background: '#2c2536' }}>
                  {pixels(look, pose, frame).map((r, j) => (
                    <rect key={j} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
                  ))}
                </svg>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  params.get('sheet') === '1' ? (
    <Sheet />
  ) : params.get('sheet') === 'hikers' ? (
    <HikerSheet />
  ) : (
    <PluginHostContext.Provider value={host}>
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
        <Campsite />
      </div>
    </PluginHostContext.Provider>
  )
)
