import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { ContainerAction, ContainerInfo } from '../../../shared/types'

interface Props {
  visible: boolean
}

const POLL_MS = 4000
const MAX_LOG = 30_000

export function DockerPanel({ visible }: Props): React.JSX.Element {
  const favorites = useAppStore((s) => s.project?.dockerFavorites)
  const toggleDockerFavorite = useAppStore((s) => s.toggleDockerFavorite)
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, ContainerAction>>({})
  const [bulkBusy, setBulkBusy] = useState<ContainerAction | null>(null)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

  const favoriteSet = new Set(favorites ?? [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setContainers(await window.api.listContainers())
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    void refresh()
    const interval = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(interval)
  }, [visible, refresh])

  // Compose output streams in regardless of which tab is showing.
  useEffect(
    () =>
      window.api.onDockerLog(({ data, done }) => {
        setLog((prev) => (prev + data).slice(-MAX_LOG))
        if (done) void refresh()
      }),
    [refresh]
  )

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  const appendLog = (text: string): void => setLog((prev) => (prev + text).slice(-MAX_LOG))

  const act = async (container: ContainerInfo, action: ContainerAction): Promise<void> => {
    setBusy((prev) => ({ ...prev, [container.id]: action }))
    try {
      await window.api.containerAction(action, container.id)
    } catch (err) {
      appendLog(`\n${String(err)}\n`)
    } finally {
      setBusy((prev) => {
        const next = { ...prev }
        delete next[container.id]
        return next
      })
      void refresh()
    }
  }

  const favoriteContainers = containers?.filter((c) => favoriteSet.has(c.name)) ?? []
  const otherContainers = containers?.filter((c) => !favoriteSet.has(c.name)) ?? []

  const bulkFavorites = async (action: 'start' | 'stop'): Promise<void> => {
    const targets = favoriteContainers.filter((c) =>
      action === 'start' ? c.state !== 'running' : c.state === 'running'
    )
    if (targets.length === 0) return
    setBulkBusy(action)
    appendLog(`\n[${action}ing ${targets.length} favorite container(s)…]\n`)
    const results = await Promise.allSettled(
      targets.map((c) => window.api.containerAction(action, c.id))
    )
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') appendLog(`${targets[i].name}: ${String(r.reason)}\n`)
    }
    appendLog(`[favorites ${action} finished]\n`)
    setBulkBusy(null)
    void refresh()
  }

  const renderRow = (c: ContainerInfo): React.JSX.Element => {
    const running = c.state === 'running'
    const containerBusy = busy[c.id]
    const isFavorite = favoriteSet.has(c.name)
    return (
      <div className="docker-row" key={c.id}>
        <button
          className={`docker-star ${isFavorite ? 'active' : ''}`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => toggleDockerFavorite(c.name)}
        >
          {isFavorite ? '★' : '☆'}
        </button>
        <span className={`docker-dot ${running ? 'running' : c.state}`} title={c.state} />
        <div className="docker-info">
          <span className="docker-name">{c.name}</span>
          <span className="docker-meta" title={`${c.image} — ${c.status}`}>
            {c.image} · {c.status}
          </span>
          {c.ports && (
            <span className="docker-ports" title={c.ports}>
              {c.ports}
            </span>
          )}
        </div>
        <div className="docker-actions">
          {running ? (
            <>
              <button
                disabled={!!containerBusy || !!bulkBusy}
                onClick={() => void act(c, 'restart')}
              >
                {containerBusy === 'restart' ? 'Restarting…' : 'Restart'}
              </button>
              <button disabled={!!containerBusy || !!bulkBusy} onClick={() => void act(c, 'stop')}>
                {containerBusy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </>
          ) : (
            <button disabled={!!containerBusy || !!bulkBusy} onClick={() => void act(c, 'start')}>
              {containerBusy === 'start' ? 'Starting…' : 'Start'}
            </button>
          )}
        </div>
      </div>
    )
  }

  const hasFavorites = favoriteContainers.length > 0

  return (
    <div className="docker-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="docker-list">
        {error && (
          <div className="error">
            Docker unavailable — is Docker running? <br />
            <span className="docker-error-detail">{error.slice(0, 300)}</span>
          </div>
        )}
        {!error && containers === null && <p className="muted">Connecting to Docker…</p>}
        {!error && containers?.length === 0 && <p className="muted">No containers.</p>}
        {!error && hasFavorites && (
          <>
            <div className="docker-group-header">
              <span>★ Favorites</span>
              <div className="docker-bulk">
                <button
                  disabled={!!bulkBusy || favoriteContainers.every((c) => c.state === 'running')}
                  onClick={() => void bulkFavorites('start')}
                >
                  {bulkBusy === 'start' ? 'Starting…' : 'Start all'}
                </button>
                <button
                  disabled={!!bulkBusy || favoriteContainers.every((c) => c.state !== 'running')}
                  onClick={() => void bulkFavorites('stop')}
                >
                  {bulkBusy === 'stop' ? 'Stopping…' : 'Stop all'}
                </button>
              </div>
            </div>
            {favoriteContainers.map(renderRow)}
          </>
        )}
        {!error && containers && containers.length > 0 && otherContainers.length > 0 && (
          <>
            {hasFavorites && <div className="docker-group-header">Others</div>}
            {otherContainers.map(renderRow)}
          </>
        )}
      </div>
      {log && (
        <div className="docker-log-wrap">
          <div className="docker-log-header">
            <span className="muted">docker compose output</span>
            <button className="docker-log-clear" onClick={() => setLog('')}>
              Clear
            </button>
          </div>
          <pre className="docker-log" ref={logRef}>
            {log}
          </pre>
        </div>
      )}
    </div>
  )
}
