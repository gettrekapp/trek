import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { scheduleAutoSave } from '../persistence'
import { defaultSessionLlm, updateLlmSettings } from '../llm'
import { LlmPicker } from './LlmPicker'
import { PROVIDER_LIST } from '../../../shared/providers/registry'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
import type {
  LlmProviderId,
  LlmSelection,
  LlmSettingsPatch,
  LocalBackend,
  LocalProviderConfig
} from '../../../shared/providers/types'

/**
 * Text input with a local draft: typing never touches the store, and the value is committed
 * on blur or Enter. The draft follows outside changes whenever the field isn't being edited.
 */
function DraftInput({
  value,
  onCommit,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== value) onCommit(draft.trim())
  }
  return (
    <input
      {...rest}
      type="text"
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** App-wide agent defaults, per-provider commands, and this project's overrides. */
export function LlmSettings(): React.JSX.Element {
  const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
  const project = useAppStore((s) => s.project)
  const setProjectLlmDefault = useAppStore((s) => s.setProjectLlmDefault)
  const setGlobalLlm = useAppStore((s) => s.setGlobalLlm)
  const [testResult, setTestResult] = useState<string | null>(null)

  // Patches, not whole objects: the main process merges them into the file, so two windows
  // (or two quick edits) never overwrite each other. A field set to undefined is removed.
  const save = (patch: LlmSettingsPatch): void => {
    updateLlmSettings(patch).catch(
      (err) => void window.api.showError('Could not save LLM settings', String(err))
    )
  }
  const patchProvider = (id: LlmProviderId, patch: Partial<LocalProviderConfig>): void =>
    save({ providers: { [id]: patch } })
  const setProjectDefault = (llm: LlmSelection | undefined): void => {
    setProjectLlmDefault(llm)
    scheduleAutoSave()
  }
  const setGlobal = (llm: LlmSelection | undefined): void => {
    setGlobalLlm(llm)
    scheduleAutoSave()
  }

  const local = settings.providers.local ?? {}
  const backend: LocalBackend = local.backend ?? 'ollama'
  const testLocal = (): void => {
    setTestResult('Testing…')
    window.api
      .llmFetchModels(backend, local.baseUrl?.trim() || DEFAULT_LOCAL_URLS[backend])
      .then((models) => setTestResult(`Connected — ${models.length} model(s)`))
      .catch((err) => setTestResult(String(err)))
  }

  return (
    <>
      <h3>Agents</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Default for new sessions</span>
          <span className="settings-desc">
            Used by ⌘T and + on every project, unless the project overrides it below. Applies to
            new sessions; existing ones keep their agent.
          </span>
        </span>
        <LlmPicker value={settings.llmDefault} onChange={(llmDefault) => save({ llmDefault })} />
      </div>
      {project && (
        <>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={!!project.llmDefault}
              onChange={(e) => setProjectDefault(e.target.checked ? defaultSessionLlm() : undefined)}
            />
            <span className="settings-label">
              <span className="settings-name">Override the default for this project</span>
              <span className="settings-desc">Saved in the project file.</span>
            </span>
          </label>
          {project.llmDefault && (
            <div className="settings-row">
              <LlmPicker value={project.llmDefault} onChange={setProjectDefault} />
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
                onChange={(e) => setGlobal(e.target.checked ? undefined : { provider: 'claude' })}
              />
              Same as the session default
            </label>
            {project.globalLlm && (
              <LlmPicker value={project.globalLlm} onChange={setGlobal} filter={(p) => p.capabilities.mcp} />
            )}
          </div>
        </>
      )}
      {PROVIDER_LIST.map((provider) => {
        const config = settings.providers[provider.id] ?? {}
        return (
          <div key={provider.id} className="settings-row llm-provider-card">
            <span className="settings-label">
              <span className="settings-name">{provider.label}</span>
              {provider.id === 'claude' && (
                <span className="settings-desc">
                  A project&apos;s claudeCommand, claudeArgs and session mode take precedence.
                </span>
              )}
            </span>
            <DraftInput
              className="quick-btn-label-input llm-command-input"
              placeholder={provider.defaultCommand}
              value={config.command ?? ''}
              onCommit={(command) => patchProvider(provider.id, { command: command || undefined })}
              title="Command"
            />
            {provider.approvalModes.length > 0 && (
              <select
                className="settings-select"
                value={config.approvalMode ?? provider.defaultApprovalMode ?? ''}
                onChange={(e) => patchProvider(provider.id, { approvalMode: e.target.value })}
                title="Approval mode"
              >
                {provider.approvalModes.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
            {provider.id === 'local' && (
              <>
                <select
                  className="settings-select"
                  value={backend}
                  onChange={(e) => patchProvider('local', { backend: e.target.value as LocalBackend })}
                >
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                </select>
                <DraftInput
                  className="quick-btn-label-input llm-command-input"
                  placeholder={DEFAULT_LOCAL_URLS[backend]}
                  value={local.baseUrl ?? ''}
                  onCommit={(baseUrl) => patchProvider('local', { baseUrl: baseUrl || undefined })}
                  title="Base URL"
                />
                <button className="btn btn-ghost" onClick={testLocal}>
                  Test
                </button>
                {testResult && <span className="settings-desc">{testResult}</span>}
              </>
            )}
          </div>
        )
      })}
    </>
  )
}
