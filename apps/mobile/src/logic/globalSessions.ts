// A project's Global sessions on the phone: which ones the Global tray lists (an automation's run
// tab lives under Automations, as in the desktop's drawer), the Global tray's bar (globalRow), the
// agent a new one gets (the server's own rule, src/shared/providers/selection.ts). Pure.
import { resolveGlobalLlm } from '../shared.ts'
import type { AgentInfo, LlmSelection, Session } from '../shared.ts'

/** The Global sessions the Global tray shows: every one but an automation's run tab, in tab order. */
export function normalGlobalSessions<S extends Pick<Session, 'context'>>(sessions: readonly S[] | undefined): S[] {
  return (sessions ?? []).filter((s) => s.context?.kind !== 'automation')
}

export interface GlobalRow {
  /** "Global · 2 sessions" */
  text: string
  /** `decision` when a listed session has an open decision, else `attention` when one rang, else null */
  mark: 'decision' | 'attention' | null
}

/** The Global tray's bar: its text and mark; null for a project with no repositories (the server starts no Global session then). */
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
