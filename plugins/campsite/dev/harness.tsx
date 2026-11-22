// The campsite strip without the app: the real Campsite component on a fake plugin host, with the
// sessions of the scenario named in ?scenario= (default "few"); ?dog=0 hides the dog.
// scripts/campsite-render.mjs serves it with Vite and screenshots each scenario. Not shipped: nothing imports it.
import { createRoot } from 'react-dom/client'
import { PluginHostContext, type ClientPluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import '../client/campsite.css'
import { Campsite } from '../client/Campsite.tsx'

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
const host = {
  id: 'campsite',
  projectId: 'harness',
  sessions: () => sessions,
  onSessionsChanged: () => () => {},
  selectedTerminalId: () => sessions[0]?.terminalId ?? null,
  focusSession: (id: string) => console.log('[harness] focus', id),
  prefs: { load: async () => prefs, set: async () => prefs, onChange: () => () => {} }
} as unknown as ClientPluginHost

createRoot(document.getElementById('root')!).render(
  <PluginHostContext.Provider value={host}>
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
      <Campsite />
    </div>
  </PluginHostContext.Provider>
)
