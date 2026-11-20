import { CLAUDE_PERMISSION_MODES } from '../../../../shared/providers/claude'
import { useAppStore } from '../../store'
import { ImagePicker, SESSION_ICON_LIMITS } from '../ImagePicker'
import { LlmSettings } from '../LlmSettings'
import { LlmPicker } from '../LlmPicker'
import { AgentNote } from '../AgentBits'
import { useAgentCatalog } from '../../agents'
import { typeAgentStart } from '../../agentPicker'
import { SettingText } from '../SettingText'
import type { SessionType } from '../../../../shared/types'

/** Settings → Agents: the Claude session mode, the agents, and the session types. */
export function AgentsTab(): React.JSX.Element {
  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
  const catalog = useAgentCatalog()
  // '' is "Server default": the project leaves the mode to the server's Claude setting.
  const permissionMode = useAppStore((s) => s.project?.claudePermissionMode ?? '')
  const setClaudePermissionMode = useAppStore((s) => s.setClaudePermissionMode)
  const claudeArgsOverride = useAppStore((s) => s.project?.claudeArgs?.trim())
  // Default applied outside the selector — `?? []` inside it would return a
  // fresh array every snapshot and loop React's store re-render (error #185).
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  const projectDefault = useAppStore((s) => s.project?.llmDefault)
  const updateSessionTypes = useAppStore((s) => s.setSessionTypes)
  const patchSessionType = (id: string, patch: Partial<SessionType>): void => {
    updateSessionTypes(sessionTypes.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Claude session mode for this project</span>
          <span className="settings-desc">
            Permission mode passed to new Claude sessions (--permission-mode). Existing
            sessions keep the mode they were started with.
          </span>
          {claudeArgsOverride && (
            <span className="settings-desc settings-warn">
              Ignored while the project sets claudeArgs: “{claudeArgsOverride}”
            </span>
          )}
        </span>
        <select
          className="settings-select"
          value={permissionMode}
          onChange={(e) => {
            setClaudePermissionMode(e.target.value || undefined)
          }}
        >
          <option value="">Server default</option>
          {CLAUDE_PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <LlmSettings />
      <h3>Session types</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">
            Offered when clicking + to start a new session. The session is named after
            the type and its system prompt is appended to the agent&apos;s system prompt.
            An optional first message is sent when the session starts.
          </span>
        </span>
      </div>
      {sessionTypes.map((type) => (
        <div key={type.id} className="quick-btn-row">
          <ImagePicker
            image={type.icon}
            onChange={(icon) => patchSessionType(type.id, { icon })}
            limits={SESSION_ICON_LIMITS}
            title="Choose a PNG icon"
          />
          <SettingText
            className="quick-btn-label-input"
            placeholder="Name, e.g. Review"
            value={type.name}
            onCommit={(name) => patchSessionType(type.id, { name })}
          />
          <div className="session-type-fields">
            <SettingText
              rows={6}
              className="quick-btn-text-input"
              placeholder="System prompt, e.g. how the agent should approach reviewing"
              value={type.systemPrompt}
              onCommit={(systemPrompt) => patchSessionType(type.id, { systemPrompt })}
            />
            <SettingText
              rows={2}
              className="quick-btn-text-input"
              placeholder="First message (optional), e.g. /trek-review"
              value={type.initialMessage ?? ''}
              onCommit={(initialMessage) => patchSessionType(type.id, { initialMessage })}
            />
            <label className="llm-inline-check">
              <input
                type="checkbox"
                checked={!type.llm}
                onChange={(e) =>
                  patchSessionType(type.id, {
                    llm: e.target.checked ? undefined : typeAgentStart(projectDefault, serverDefault, catalog)
                  })
                }
              />
              Use the default agent
            </label>
            {type.llm && (
              <>
                <LlmPicker value={type.llm} onChange={(llm) => patchSessionType(type.id, { llm })} catalog={catalog} />
                <AgentNote llm={type.llm} />
              </>
            )}
          </div>
          <button
            className="quick-btn-remove"
            title="Remove session type"
            onClick={() => updateSessionTypes(sessionTypes.filter((t) => t.id !== type.id))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          className="btn btn-ghost"
          onClick={() =>
            updateSessionTypes([
              ...sessionTypes,
              { id: crypto.randomUUID(), name: '', systemPrompt: '' }
            ])
          }
        >
          + Add session type
        </button>
      </div>
    </>
  )
}
