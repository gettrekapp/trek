// The session view a plugin's host gives (campsite): the window's project's sessions in sidebar
// order, the selected one, and a cached feed for useSyncExternalStore (the same array until
// something changes). Pure: the window passes in its store's state (tests pass a literal).
import type { PluginSession, PluginSessionStatus } from '../../../shared/plugins/client.ts'
import { DEFAULT_AGENT_ID } from '../../../shared/plugins/agents.ts'

export interface SessionInput {
  /** The project's worktrees in sidebar order */
  worktrees: readonly { id: string; name: string; branch?: string }[]
  /** The Global panel's worktree id (GLOBAL_WORKTREE_ID) */
  globalId: string
  terminals: Readonly<Record<string, { id: string; worktreeId: string; title: string; status: string; llm?: { provider: string } }>>
  terminalOrder: Readonly<Record<string, readonly string[]>>
  decisions: Readonly<Record<string, unknown>>
  activeWorktreeId: string | null
  activeTerminal: Readonly<Record<string, string>>
  globalPanelOpen: boolean
}

export function pluginSessions(input: SessionInput): PluginSession[] {
  const out: PluginSession[] = []
  const add = (worktreeId: string, worktree: SessionInput['worktrees'][number] | null): void => {
    for (const id of input.terminalOrder[worktreeId] ?? []) {
      const meta = Object.hasOwn(input.terminals, id) ? input.terminals[id] : undefined
      if (!meta || meta.worktreeId !== worktreeId) continue
      out.push({
        terminalId: id,
        label: meta.title,
        provider: meta.llm?.provider ?? DEFAULT_AGENT_ID,
        status: meta.status as PluginSessionStatus,
        decision: Object.hasOwn(input.decisions, id),
        worktreeId: worktree ? worktree.id : null,
        worktreeName: worktree ? worktree.name : null,
        branch: worktree ? (worktree.branch ?? null) : null
      })
    }
  }
  for (const w of input.worktrees) add(w.id, w)
  add(input.globalId, null)
  return out
}

export function selectedTerminal(input: SessionInput): string | null {
  const worktreeId = input.globalPanelOpen ? input.globalId : input.activeWorktreeId
  if (!worktreeId) return null
  const id = input.activeTerminal[worktreeId]
  return id && Object.hasOwn(input.terminals, id) ? id : null
}

export interface SessionsSource {
  sessions(): readonly PluginSession[]
  selected(): string | null
  onChanged(listener: () => void): () => void
}

const sameInput = (a: SessionInput, b: SessionInput): boolean =>
  (Object.keys(b) as (keyof SessionInput)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length

/** One per window: `read` gives the store's state now, `subscribe` hears every store change. */
export function sessionsSource(read: () => SessionInput, subscribe: (listener: () => void) => () => void): SessionsSource {
  let cached: { key: string; list: PluginSession[]; selected: string | null } | null = null
  let lastInput: SessionInput | null = null
  const current = (): { key: string; list: PluginSession[]; selected: string | null } => {
    const input = read()
    // The store replaces what it changes, never mutating in place: the same fields are the same view.
    if (cached && lastInput && sameInput(lastInput, input)) return cached
    lastInput = input
    const list = pluginSessions(input)
    const selected = selectedTerminal(input)
    const key = JSON.stringify([list, selected])
    if (!cached || cached.key !== key) cached = { key, list, selected }
    return cached
  }
  return {
    sessions: () => current().list,
    selected: () => current().selected,
    onChanged: (listener) => {
      let last = current().key
      return subscribe(() => {
        const key = current().key
        if (key === last) return
        last = key
        listener()
      })
    }
  }
}
