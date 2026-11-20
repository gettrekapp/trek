// The claude plugin's Settings section (plugins A2; Settings → Agents before): the project's Claude
// session mode, and the Local agent's model list as the server reads it from its endpoint. Local's
// backend and URL are the server config's (llm.providers.local), hand-edited there: a window is
// never told them, and the server asks only the URL its config names.
import { useState } from 'react'
import { usePluginHost, useProjectSettings } from '../../../src/shared/plugins/client.ts'
import { CLAUDE_PERMISSION_MODES } from '../shared/claude.ts'
import { localAgent } from '../shared/local.ts'

interface LocalTest {
  busy: boolean
  /** What the last Test found, in words */
  text: string | null
  models: string[]
}

export function ClaudeSettings(): React.JSX.Element {
  const host = usePluginHost()
  const values = useProjectSettings()
  // '' is "Server default": the project leaves the mode to the server's config.
  const mode = values.claudePermissionMode ?? ''
  const args = values.claudeArgs?.trim()
  const [test, setTest] = useState<LocalTest>({ busy: false, text: null, models: [] })
  const testLocal = (): void => {
    setTest({ busy: true, text: 'Asking the server…', models: [] })
    host.agentModels(localAgent.id).then(
      (models) => {
        if (host.isCurrent()) setTest({ busy: false, text: `Connected: ${models.length} model${models.length === 1 ? '' : 's'}`, models: models.map((m) => m.label) })
      },
      (err: unknown) => {
        if (host.isCurrent()) setTest({ busy: false, text: err instanceof Error ? err.message : String(err), models: [] })
      }
    )
  }

  return (
    <>
      <h3>Claude Code</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Claude session mode for this project</span>
          <span className="settings-desc">
            Permission mode passed to new Claude sessions (--permission-mode). Existing sessions keep the mode
            they were started with.
          </span>
          {args && <span className="settings-desc settings-warn">Ignored while the project sets claudeArgs: “{args}”</span>}
        </span>
        <select
          className="settings-select"
          aria-label="Claude session mode"
          value={mode}
          onChange={(e) => host.setProjectSetting('claudePermissionMode', e.target.value)}
        >
          <option value="">Server default</option>
          {CLAUDE_PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <h4>Local model</h4>
      <div className="settings-row claude-local">
        <span className="settings-label">
          <span className="settings-name">{localAgent.label}&apos;s endpoint</span>
          <span className="settings-desc">
            {localAgent.label} runs Claude Code against Ollama or LM Studio on the server&apos;s machine. Its backend
            and URL are set in the server&apos;s config file, under llm.providers.local (backend: ollama or
            lmstudio; baseUrl). Test asks the server for the models there.
          </span>
          {test.text && <span className="settings-desc claude-local-result">{test.text}</span>}
          {test.models.length > 0 && <span className="settings-desc claude-local-models">{test.models.join(', ')}</span>}
        </span>
        <button className="btn btn-ghost" disabled={test.busy} onClick={testLocal}>
          Test
        </button>
      </div>
    </>
  )
}
