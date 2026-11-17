// A project's Global sessions on the phone: which ones are listed (an automation's run tab lives
// under Automations, as in the desktop's drawer), the project screen's Global row, the agent a new
// one gets (the server's own rule, src/shared/providers/selection.ts), and when the tablet
// sidebar's Global group is open. Pure.
import { resolveGlobalLlm } from '../shared.ts'
import type { AgentInfo, LlmSelection, Session } from '../shared.ts'

/** The Global sessions the Global screen lists: every one but an automation's run tab, in tab order. */
export function normalGlobalSessions<S extends Pick<Session, 'context'>>(sessions: readonly S[] | undefined): S[] {
  return (sessions ?? []).filter((s) => s.context?.kind !== 'automation')
}

export interface GlobalRow {
  /** "Global · 2 sessions" */
  text: string
  /** `decision` when a listed session has an open decision, else `attention` when one rang, else null */
  mark: 'decision' | 'attention' | null
}

/** The project screen's Global row; null for a project with no repositories (the server starts no Global session then). */
export function globalRow(project: {
  repositories: readonly unknown[]
  globalSessions: readonly Pick<Session, 'status' | 'decision' | 'context'>[] | undefined
}): GlobalRow | null {
  if (project.repositories.length === 0) return null
  const list = normalGlobalSessions(project.globalSessions)
  const text = list.length === 0 ? 'Global · no sessions' : `Global · ${list.length} session${list.length === 1 ? '' : 's'}`
  const mark = list.some((s) => !!s.decision) ? 'decision' : list.some((s) => s.status === 'attention') ? 'attention' : null
  return { text, mark }
}

/**
 * The label of the agent a Global session started without `llm` gets: the project's Global agent,
 * else its default, else the server's (`serverDefault`, server.agents' `llmDefault`), passing over
 * one without Trek's tools, as the server does. By the server's label for it (`agents`), else the
 * provider's id. Null until the server's default is known.
 */
export function globalAgentLabel(
  settings: { globalLlm?: LlmSelection; llmDefault?: LlmSelection },
  serverDefault: LlmSelection | undefined,
  agents: readonly AgentInfo[]
): string | null {
  if (!serverDefault) return null
  const llm = resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault)
  return agents.find((a) => a.provider === llm.provider)?.label ?? llm.provider
}

/** Whether the tablet sidebar's Global group is open: the pane shows the Global screen or one of its sessions. */
export function globalGroupOpen(
  selection: { screen: string | null; sessionId: string | null },
  sessions: readonly Pick<Session, 'id' | 'context'>[] | undefined
): boolean {
  if (selection.screen === 'global') return true
  return selection.sessionId !== null && normalGlobalSessions(sessions).some((s) => s.id === selection.sessionId)
}
