// The campsite strip without the app: the real Campsite component on a fake plugin host, with the
// sessions of the scenario named in ?scenario= (default "few"); ?dog=0 hides the dog.
// ?built=out builds every building; ?away=1 shows the away card; ?crew=geared gives t1–t3's members
// gear (t1's tier 3 in every slot, t2's mixed, t3's tier 1) and the second a pin and a journal (which
// the fake host answers to `journal`, as the server does). ?trails=all (campsite 3c) puts the harness
// project's trails on every stage (three at the trailhead, eight on the switchbacks: "+2", two planted), another
// project's two, 12 summits (the cairn) and both projects' histories (the fake host answers
// `trailLog`); window.__summit(worktreeId, branch) sends the summit event, as the server does.
// ?freeze=1 stops both clocks (below).
// scripts/campsite-render.mjs serves it with Vite and screenshots each scenario. Not shipped: nothing imports it.
import { createRoot } from 'react-dom/client'
import { PluginHostContext, type ClientPluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import '../client/campsite.css'
import { Campsite } from '../client/Campsite.tsx'
import { newCamp, snapshot } from '../shared/camp.ts'

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
// ?freeze=1: both clocks stand still (Date.now at 2026-11-23 12:00 UTC, performance.now at 1 ms), so
// a shot is the same pixels on every run: `campsite:render -- <dir> --freeze` before and after a
// change that must not move anything, then compare the PNGs byte for byte
if (params.get('freeze') === '1') {
  const at = Date.UTC(2026, 10, 23, 12)
  Date.now = () => at
  performance.now = () => 1
}
const sessions = SCENARIOS[params.get('scenario') ?? 'few'] ?? []
const prefs = { showDog: params.get('dog') !== '0' }
// The camp's state, from the real rules: the header's counts, t1's crew member in its tooltip;
// ?built=out builds everything (all seven buildings at their top tier)
const T = Date.now()
const state = newCamp(7, T)
state.wood = 340
state.markers = 2
state.crew[0].name = 'Aspen'
state.crew[0].xp = 150
state.assignments.t1 = { crew: state.crew[0].id, project: 'harness', worktreeId: 'api', provider: 'codex', projectName: 'trek', place: 'feature/api', start: T - 3_600_000, wood: 12 }
if (params.get('built') === 'out') state.built = { lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2, signpost: 1 }
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
  const trail = (projectId: string, worktreeId: string, branch: string, stage: number, ago: number) => ({ projectId, worktreeId, repoId: 'r', branch, stage, start: T - ago, stageAt: T - ago / 2 })
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
// ?away=1: unseen for 9 hours, with something to tell (the card)
if (params.get('away') === '1') {
  state.seenAt = T - 9 * 3_600_000
  state.away = { since: T - 9 * 3_600_000, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 1, levelUps: [{ crewId: state.crew[1].id, level: 3 }] }
}
const camp = snapshot(state, T, { project: (id) => (id === 'harness' ? 'trek' : 'website') })
const listeners = new Map<string, Set<(data: unknown) => void>>()
;(window as unknown as { __summit: (worktreeId: string, branch: string) => void }).__summit = (worktreeId, branch) => {
  for (const l of listeners.get('summit') ?? []) l({ projectId: 'harness', worktreeId, branch })
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
    if (method === 'state') return camp
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

createRoot(document.getElementById('root')!).render(
  <PluginHostContext.Provider value={host}>
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
      <Campsite />
    </div>
  </PluginHostContext.Provider>
)
