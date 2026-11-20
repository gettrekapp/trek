import { useAppStore } from '../store'
import { useAgentCatalog } from '../agents'
import { LlmPicker } from './LlmPicker'
import { AgentNote } from './AgentBits'
import { expectedDefault, globalStart, type ClientAgent } from '../../../shared/agents/catalog.ts'
import { DEFAULT_AGENT_ID } from '../../../shared/plugins/agents.ts'
import type { LlmSelection } from '../../../shared/providers/types'

/** The Global panel's agents need Trek's tools (MCP). */
const withTools = (agent: ClientAgent): boolean => agent.capabilities.mcp

/**
 * The project's agents, over its server's (plugins A2: the window's catalog): its default for new
 * sessions and its Global panel's agent. The server's own default and each agent's command and
 * settings are its config file's, which the protocol does not edit.
 */
export function LlmSettings(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
  const catalog = useAgentCatalog()
  const setProjectLlmDefault = useAppStore((s) => s.setProjectLlmDefault)
  const setGlobalLlm = useAppStore((s) => s.setGlobalLlm)
  /** What an override starts from: the agent the server would run now. */
  const startFrom = (): LlmSelection => expectedDefault({}, serverDefault ?? { provider: DEFAULT_AGENT_ID }, catalog, false)

  return (
    <>
      <h3>Agents</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">
            The server&apos;s default agent and each agent&apos;s command are set in the server&apos;s config
            file. This project can override the default below.
          </span>
        </span>
      </div>
      {project && (
        <>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={!!project.llmDefault}
              onChange={(e) => setProjectLlmDefault(e.target.checked ? startFrom() : undefined)}
            />
            <span className="settings-label">
              <span className="settings-name">Override the default for this project</span>
              <span className="settings-desc">Saved on the server.</span>
            </span>
          </label>
          {project.llmDefault && (
            <div className="settings-row">
              <LlmPicker value={project.llmDefault} onChange={setProjectLlmDefault} catalog={catalog} />
              <AgentNote llm={project.llmDefault} />
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">Global panel</span>
              <span className="settings-desc">
                Agent for new Global panel tabs. Only agents that can use Trek&apos;s tools (MCP) are
                offered.
              </span>
            </span>
            <label className="llm-inline-check">
              <input
                type="checkbox"
                checked={!project.globalLlm}
                onChange={(e) => setGlobalLlm(e.target.checked ? undefined : globalStart(serverDefault, catalog))}
              />
              Same as the session default
            </label>
            {project.globalLlm && (
              <>
                <LlmPicker value={project.globalLlm} onChange={setGlobalLlm} catalog={catalog} offer={withTools} />
                <AgentNote llm={project.globalLlm} />
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
