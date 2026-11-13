import { useState } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { LinearKeyResult } from '../shared/types.ts'
import { useLinearStore } from './store.ts'

/** Linear API key — the window's server's, shared by every project on it. */
export function LinearSettings(): React.JSX.Element {
  const host = usePluginHost()
  const connected = useLinearStore((s) => s.connected)
  const setLinearConnected = useLinearStore((s) => s.setConnected)
  const [apiKey, setApiKey] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    if (!apiKey.trim()) return
    setBusy(true)
    setError(null)
    let result: LinearKeyResult
    try {
      result = await host.request<LinearKeyResult>('setKey', { apiKey })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiKey('')
    setUser(result.user)
    setLinearConnected(true)
  }

  const disconnect = async (): Promise<void> => {
    try {
      await host.request('clearKey')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setUser(null)
    setLinearConnected(false)
  }

  return (
    <>
      <h3>Linear</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">API key</span>
          <span className="settings-desc">
            Shows each linked issue&apos;s title and status on its ticket chip. Create a personal
            key under Linear → Settings → Security &amp; access. Stored on this project&apos;s
            server (owner-only, never sent back), not in the project, and used by every project on
            it.
          </span>
          {connected && (
            <span className="settings-desc">Connected{user ? ` as ${user}` : ''}</span>
          )}
          {error && <span className="settings-desc settings-warn">{error}</span>}
        </span>
        {connected ? (
          <button className="btn btn-ghost" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <span className="linear-key-input">
            <input
              className="settings-select"
              type="password"
              placeholder="lin_api_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect()
              }}
            />
            <button className="btn btn-ghost" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </span>
        )}
      </div>
    </>
  )
}
