import { useEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'
import { pickerAgents } from '../agentPicker'
import { effortsOf } from '../../../shared/agents/selection.ts'
import type { AgentCatalog, ClientAgent } from '../../../shared/agents/catalog.ts'
import type { AgentModel } from '../../../shared/plugins/agents.ts'
import type { LlmSelection } from '../../../shared/providers/types'

const CUSTOM = '__custom__'

interface Props {
  value: LlmSelection
  onChange: (value: LlmSelection) => void
  /** The window's agents (useAgentCatalog) */
  catalog: AgentCatalog
  /** Which of the offered agents to list (the Global panel's and automations': those with Trek's tools) */
  offer?: (agent: ClientAgent) => boolean
}

interface ListedModels {
  models: AgentModel[] | null
  error: string | null
  loading: boolean
  retry: () => void
}

/**
 * An agent's models from the window's server (`agents.models`), for an agent whose models come
 * from an endpoint (Local's): asked when it is picked, again on Retry. Picks the first model when
 * none is chosen: such an agent has no default model.
 */
function useListedModels(agentId: string | null, value: LlmSelection, onChange: (value: LlmSelection) => void): ListedModels {
  const [models, setModels] = useState<AgentModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Latest props for the async answer, so it never acts on a stale selection.
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const token = useRef(0)
  const load = (): void => {
    if (agentId === null) return
    const mine = ++token.current
    setLoading(true)
    setError(null)
    getBackend()
      .agents.models(agentId)
      .then((list) => {
        if (mine !== token.current) return
        setModels(list)
        const { value: current, onChange: change } = latest.current
        if (current.provider === agentId && !current.model && list[0]) {
          change({ provider: agentId, model: list[0].id, ...(current.effort ? { effort: current.effort } : {}) })
        }
      })
      .catch((err) => mine === token.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => mine === token.current && setLoading(false))
  }
  useEffect(() => {
    setModels(null)
    load()
    return () => {
      token.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])
  return { models, error, loading, retry: load }
}

/** Agent → Model → Effort, over the server's agents. Changing the agent resets model and effort. */
export function LlmPicker({ value, onChange, catalog, offer }: Props): React.JSX.Element {
  const agent = catalog.get(value.provider)
  const agents = pickerAgents(value, catalog, offer)
  const listed = useListedModels(agent?.modelsFrom === 'server' ? agent.id : null, value, onChange)
  const [customOpen, setCustomOpen] = useState(false)
  /** No default model: the server lists the models (an endpoint's), or they are typed (an old server) */
  const noDefault = agent?.modelsFrom === 'server' || agent?.modelsFrom === 'typed'
  const loading = agent?.modelsFrom === 'server' && listed.loading
  const models: readonly AgentModel[] = agent?.modelsFrom === 'server' ? (listed.models ?? []) : (agent?.models ?? [])
  const known = models.some((m) => m.id === value.model)
  const showCustom = customOpen || (!!value.model && !known && !loading) || (noDefault && !loading && !value.model && models.length === 0)
  const efforts = effortsOf(value, catalog)

  const setModel = (model: string | undefined): void =>
    onChange({ provider: value.provider, ...(model ? { model } : {}), ...(value.effort ? { effort: value.effort } : {}) })

  return (
    <div className="llm-picker">
      <select
        className="settings-select"
        value={value.provider}
        onChange={(e) => {
          setCustomOpen(false)
          onChange({ provider: e.target.value })
        }}
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
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
        {!noDefault && <option value="">Default model</option>}
        {noDefault && !value.model && (
          <option value="" disabled>
            {loading
              ? 'Loading models…'
              : models.length > 0
                ? 'Choose a model'
                : agent?.modelsFrom === 'typed'
                  ? 'Type a model id' // an old server can't list them for us
                  : 'No models found'}
          </option>
        )}
        {loading && value.model && <option value={value.model}>Loading models…</option>}
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
      {agent?.installed === false && (
        <span className="settings-desc settings-warn">
          {agent.label} isn&apos;t installed on the server — its command is set in the server&apos;s config.
        </span>
      )}
      {agent?.modelsFrom === 'server' && listed.error && (
        <span className="settings-desc settings-warn">
          Could not list {agent.label}&apos;s models: {listed.error}{' '}
          <button className="btn btn-ghost llm-small-btn" onClick={listed.retry}>
            Retry
          </button>
        </span>
      )}
    </div>
  )
}
