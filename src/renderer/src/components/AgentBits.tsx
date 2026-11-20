// Small pieces of the window's agent UI (plugins A2): a session tab's glyph, and the note under a
// saved agent choice that can't start a session now (its agent is off in the project, or unknown).
import { agentNote, sessionGlyph } from '../../../shared/agents/catalog.ts'
import type { LlmSelection } from '../../../shared/providers/types'
import { useAgentCatalog } from '../agents'

/** None for the default agent; else the server's glyph for the session's agent, the selection in words as its title. */
export function AgentGlyph({ llm }: { llm: LlmSelection | undefined }): React.JSX.Element | null {
  const glyph = sessionGlyph(llm, useAgentCatalog())
  return glyph ? (
    <span className="session-llm-glyph" title={glyph.title}>
      {glyph.glyph}
    </span>
  ) : null
}

export function AgentNote({ llm }: { llm: LlmSelection | undefined }): React.JSX.Element | null {
  const note = agentNote(llm, useAgentCatalog())
  return note ? <span className="settings-desc settings-warn agent-note">{note}</span> : null
}
