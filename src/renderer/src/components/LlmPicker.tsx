import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { getProvider, PROVIDER_LIST } from '../../../shared/providers/registry'
import { effortsFor } from '../../../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
import type { LlmProvider, LlmSelection, ModelInfo } from '../../../shared/providers/types'

const CUSTOM = '__custom__'

interface Props {
  value: LlmSelection
  onChange: (value: LlmSelection) => void
  /** Restrict the providers offered (e.g. MCP-capable for the Global panel) */
  filter?: (provider: LlmProvider) => boolean
  /** Host the agent will run on, for the "not installed" check; null = this machine */
  serverId?: string | null
}

/** Provider → Model → Effort. Changing provider resets model and effort. */
export function LlmPicker({ value, onChange, filter, serverId = null }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
  const project = useAppStore((s) => s.project)
  const providers = PROVIDER_LIST.filter((p) => !filter || filter(p))
  const provider = getProvider(value.provider)
  const isLocal = provider.id === 'local'
  const localConfig = settings.providers.local
  const backend = localConfig?.backend ?? 'ollama'
  const baseUrl = localConfig?.baseUrl?.trim() || DEFAULT_LOCAL_URLS[backend]

  const [localModels, setLocalModels] = useState<ModelInfo[] | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [installed, setInstalled] = useState<boolean | null>(null)

  // Latest props for the async fetch below, so it never acts on a stale selection.
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const loadToken = useRef(0)

  const loadLocal = (): void => {
    const token = ++loadToken.current
    setLoading(true)
    setLocalError(null)
    window.api
      .llmFetchModels(backend, baseUrl)
      .then((models) => {
        if (token !== loadToken.current) return
        setLocalModels(models)
        // Local has no "default" model: pick the first one if none is chosen. Only while
        // Local is still the selected provider, and only once (a model is then set).
        const { value: current, onChange: change } = latest.current
        if (current.provider === 'local' && !current.model && models[0]) {
          change({ provider: 'local', model: models[0].id, ...(current.effort ? { effort: current.effort } : {}) })
        }
      })
      .catch((err) => token === loadToken.current && setLocalError(String(err)))
      .finally(() => token === loadToken.current && setLoading(false))
  }

  useEffect(() => {
    if (isLocal) loadLocal()
    return () => {
      loadToken.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, backend, baseUrl])

  const command =
    (provider.id === 'claude' ? project?.claudeCommand?.trim() : undefined) ||
    settings.providers[provider.id]?.command?.trim() ||
    provider.defaultCommand
  useEffect(() => {
    let cancelled = false
    setInstalled(null)
    // Only the binary name is checked; a command with arguments is assumed present.
    const binary = command.split(/\s+/)[0]
    window.api
      .agentCommandExists(serverId, binary)
      .then((exists) => !cancelled && setInstalled(exists))
      .catch(() => !cancelled && setInstalled(null))
    return () => {
      cancelled = true
    }
  }, [command, serverId])

  const models = isLocal ? (localModels ?? []) : provider.models
  const known = models.some((m) => m.id === value.model)
  const showCustom =
    customOpen ||
    (!!value.model && !known && !(isLocal && loading)) ||
    (isLocal && !loading && !value.model && models.length === 0)
  const efforts = effortsFor(value)

  const setModel = (model: string | undefined): void =>
    onChange({ provider: value.provider, ...(model ? { model } : {}), ...(value.effort ? { effort: value.effort } : {}) })

  return (
    <div className="llm-picker">
      <select
        className="settings-select"
        value={value.provider}
        onChange={(e) => {
          setCustomOpen(false)
          onChange({ provider: e.target.value as LlmSelection['provider'] })
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        className="settings-select"
        value={showCustom ? CUSTOM : (value.model ?? '')}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomOpen(true)
            return
          }
          setCustomOpen(false)
          setModel(e.target.value || undefined)
        }}
      >
        {!isLocal && <option value="">Default model</option>}
        {isLocal && !value.model && (
          <option value="" disabled>
            {loading ? 'Loading models…' : models.length === 0 ? 'No models found' : 'Choose a model'}
          </option>
        )}
        {isLocal && loading && value.model && <option value={value.model}>Loading models…</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {showCustom && (
        <input
          className="settings-input llm-custom-model"
          type="text"
          placeholder="Model id"
          autoFocus={customOpen}
          value={value.model ?? ''}
          onChange={(e) => setModel(e.target.value || undefined)}
        />
      )}
      {efforts.length > 0 && (
        <select
          className="settings-select"
          value={value.effort && efforts.includes(value.effort) ? value.effort : ''}
          onChange={(e) =>
            onChange({
              provider: value.provider,
              ...(value.model ? { model: value.model } : {}),
              ...(e.target.value ? { effort: e.target.value } : {})
            })
          }
        >
          <option value="">Default effort</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      {isLocal && localError && (
        <span className="settings-desc settings-warn">
          Could not list models at {baseUrl}: {localError}{' '}
          <button className="btn btn-ghost llm-small-btn" onClick={loadLocal}>
            Retry
          </button>
        </span>
      )}
      {installed === false && (
        <span className="settings-desc settings-warn">
          “{command.split(/\s+/)[0]}” isn&apos;t installed on this machine — set its command in Settings.
        </span>
      )}
    </div>
  )
}
