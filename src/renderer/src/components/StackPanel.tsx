import { useEffect, useRef, useState } from 'react'
import type { StackStatus } from '../../../shared/types'
import { STACK_STATE_LABELS, stackState, stackUrls, stripAnsi } from '../stacks'

interface Props {
  visible: boolean
  worktreePath: string
  status: StackStatus
  /** Re-read the stack status right away (after start/stop) */
  onChanged: () => void
}

const LOG_POLL_MS = 1000
const MAX_LOG = 200_000

/** The Stack tab: start/stop the worktree's docker/stack/stack.sh dev stack. */
export function StackPanel({ visible, worktreePath, status, onChanged }: Props): React.JSX.Element {
  const [starter, setStarter] = useState(false)
  const [pending, setPending] = useState<'start' | 'stop' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const fileRef = useRef({ id: 0, offset: 0 })
  const logRef = useRef<HTMLPreElement>(null)
  const followRef = useRef(true)

  const state = stackState(status)
  const active = state !== 'stopped'

  useEffect(() => {
    fileRef.current = { id: 0, offset: 0 }
    setLog('')
    setError(null)
  }, [worktreePath])

  useEffect(() => {
    if (!visible) return undefined
    let disposed = false
    const poll = async (): Promise<void> => {
      try {
        const { id, offset } = fileRef.current
        const chunk = await window.api.stackLog(worktreePath, id, offset)
        if (disposed || fileRef.current.id !== id) return
        fileRef.current = { id: chunk.fileId, offset: chunk.offset }
        if (chunk.fileId !== id) setLog(stripAnsi(chunk.text))
        else if (chunk.text) setLog((prev) => (prev + stripAnsi(chunk.text)).slice(-MAX_LOG))
      } catch {
        // no log yet — the next poll retries
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), LOG_POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [visible, worktreePath])

  useEffect(() => {
    const el = logRef.current
    if (el && followRef.current) el.scrollTo(0, el.scrollHeight)
  }, [log])

  const start = async (): Promise<void> => {
    setPending('start')
    setError(null)
    try {
      await window.api.stackUp(worktreePath, starter)
      followRef.current = true
    } catch (err) {
      setError(String(err))
    } finally {
      setPending(null)
      onChanged()
    }
  }

  const stop = async (): Promise<void> => {
    setPending('stop')
    setError(null)
    onChanged()
    try {
      const code = await window.api.stackDown(worktreePath)
      if (code !== 0) setError(`stack.sh down exited with code ${code} — see the output below`)
    } catch (err) {
      setError(String(err))
    } finally {
      setPending(null)
      onChanged()
    }
  }

  const urls = stackUrls(status)

  return (
    <div className="env-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="env-list">
        <div className="env-header">
          <span
            className={`docker-dot ${state === 'running' ? 'running' : active ? 'attention' : 'exited'}`}
            title={STACK_STATE_LABELS[state]}
          />
          <div className="docker-info">
            <span className="docker-name">trek-{status.slug}</span>
            <span className="docker-meta">
              {pending === 'stop' ? STACK_STATE_LABELS.stopping : STACK_STATE_LABELS[state]}
              {status.containers > 0 &&
                ` · ${status.containers} container${status.containers === 1 ? '' : 's'}`}
              {status.port ? ` · ports ${status.port}–${status.port + 5}` : ''}
            </span>
          </div>
          <div className="docker-actions">
            {!active && (
              <>
                <label
                  className="stack-starter"
                  title="Restore a new stack database from the starter dataset (a year of history) instead of slim"
                >
                  <input
                    type="checkbox"
                    checked={starter}
                    disabled={!!pending}
                    onChange={(e) => setStarter(e.target.checked)}
                  />
                  Starter data
                </label>
                <button disabled={!!pending} onClick={() => void start()}>
                  {pending === 'start' ? 'Starting…' : 'Start'}
                </button>
              </>
            )}
            {active && (
              <button disabled={!!pending || state === 'stopping'} onClick={() => void stop()}>
                {pending === 'stop' || state === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {active && urls.length > 0 && (
          <div className="env-links stack-links">
            {urls.map((u) => (
              <a key={u.label} href={u.url} target="_blank" rel="noreferrer">
                {u.label} {u.url.replace('http://', '')}
              </a>
            ))}
            <span className="muted">Logins admin / bill · password sample123</span>
          </div>
        )}
        {!active && !log && (
          <p className="muted">
            Start runs <code>docker/stack/stack.sh up</code>: this worktree gets its own compose
            project, database and ports, side by side with the main checkout&apos;s stack. Stop runs{' '}
            <code>stack.sh down</code>, which keeps the database for the next start.
          </p>
        )}
      </div>
      {log && (
        <div className="docker-log-wrap">
          <div className="docker-log-header">
            <span className="muted">stack.sh output</span>
            <button className="docker-log-clear" onClick={() => setLog('')}>
              Clear
            </button>
          </div>
          <pre
            className="docker-log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {log}
          </pre>
        </div>
      )}
    </div>
  )
}
