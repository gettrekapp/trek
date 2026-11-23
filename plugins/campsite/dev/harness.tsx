// The campsite strip without the app: the real Campsite component on a fake plugin host, with the
// sessions of the scenario named in ?scenario= (default "few"); ?dog=0 hides the dog.
// ?built=out builds every building; ?away=1 shows the away card; ?crew=geared gives t1–t3's members
// gear (tier 3, 2 and 1 in every slot) and the first a pin and a journal.
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
const sessions = SCENARIOS[params.get('scenario') ?? 'few'] ?? []
const prefs = { showDog: params.get('dog') !== '0' }
// The camp's state, from the real rules: the header's counts, t1's crew member in its tooltip;
// ?built=out builds everything (all six buildings at their top tier)
const T = Date.now()
const state = newCamp(7, T)
state.wood = 340
state.markers = 2
state.crew[0].name = 'Aspen'
state.crew[0].xp = 150
state.assignments.t1 = { crew: state.crew[0].id, project: 'harness', worktreeId: 'api', provider: 'codex', projectName: 'trek', place: 'feature/api', start: T - 3_600_000, wood: 12 }
if (params.get('built') === 'out') state.built = { lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2 }
// ?crew=geared: the members out with t1, t2 and t3 wear tier 3, 2 and 1 gear; the first is pinned to
// Codex and has a journal
if (params.get('crew') === 'geared') {
  state.built.shed = 2
  state.crew.forEach((m, i) => {
    const n = 3 - i
    m.gear = { pack: n, boots: n, hat: n, tool: n }
    m.xp = [1700, 450, 120][i]
    state.assignments[`t${i + 1}`] = { crew: m.id, project: 'harness', worktreeId: i === 2 ? 'web' : 'api', provider: PROVIDERS[(i + 1) % PROVIDERS.length], projectName: 'trek', place: i === 2 ? 'feature/web' : 'feature/api', start: T - 3_600_000, wood: 12 }
  })
  state.seenKinds = [
    { kind: 'type', id: 'harness:rev', name: 'Review', at: T },
    { kind: 'provider', id: 'claude', name: 'Claude', at: T },
    { kind: 'provider', id: 'codex', name: 'Codex', at: T }
  ]
  state.crew[0].pin = { kind: 'provider', id: 'codex' }
  state.crew[0].journal = [
    { kind: 'hired', at: T - 9 * 86_400_000 },
    { kind: 'trip', at: T - 2 * 86_400_000, minutes: 192, project: 'trek', place: 'main', provider: 'claude', wood: 48 },
    { kind: 'level', at: T - 2 * 86_400_000, level: 5, title: 'Legend' },
    { kind: 'gear', at: T - 86_400_000, slot: 'tool', tier: 3 },
    { kind: 'summit', at: T - 5 * 3_600_000, branch: 'feature/campsite-strip', project: 'trek' },
    { kind: 'pinned', at: T - 3_600_000, name: 'Codex' }
  ]
}
// ?away=1: unseen for 9 hours, with something to tell (the card)
if (params.get('away') === '1') {
  state.seenAt = T - 9 * 3_600_000
  state.away = { since: T - 9 * 3_600_000, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 1, levelUps: [{ crewId: state.crew[1].id, level: 3 }] }
}
const camp = snapshot(state, T)
const host = {
  id: 'campsite',
  projectId: 'harness',
  sessions: () => sessions,
  onSessionsChanged: () => () => {},
  selectedTerminalId: () => sessions[0]?.terminalId ?? null,
  focusSession: (id: string) => console.log('[harness] focus', id),
  prefs: { load: async () => prefs, set: async () => prefs, onChange: () => () => {} },
  request: async (method: string) => {
    if (method === 'state') return camp
    if (method === 'seen' || method === 'awaySeen') return { ok: true }
    throw new Error(`[harness] no method ${method}`)
  },
  onEvent: () => () => {},
  onChanged: () => () => {}
} as unknown as ClientPluginHost

createRoot(document.getElementById('root')!).render(
  <PluginHostContext.Provider value={host}>
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
      <Campsite />
    </div>
  </PluginHostContext.Provider>
)
