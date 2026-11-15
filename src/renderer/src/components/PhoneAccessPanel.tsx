import { useCallback, useEffect, useState } from 'react'
import { errorText } from '../v2/errors'
import { parsePhonePort, phoneAccessLabel } from '../../../shared/appServerRules'
import type { PhoneAccess } from '../../../shared/protocolV2'

export interface PhoneAccessState {
  /** null until the Local server has answered */
  access: PhoneAccess | null
  error: string | null
  /** Resolves true when the server took the change, false when it refused (`error` then says why). */
  set: (patch: { enabled?: boolean; port?: number; url?: string | null }) => Promise<boolean>
  revoke: (name: string) => Promise<void>
}

/** The Local server's phone access, kept in step by its `phoneAccess.changed`. Idle (and null) unless `active`. */
export function usePhoneAccess(active: boolean): PhoneAccessState {
  const [access, setAccess] = useState<PhoneAccess | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let live = true
    window.api.appServers.phoneAccess.get().then(
      (got) => live && setAccess(got),
      (err) => live && setError(errorText(err))
    )
    const off = window.api.appServers.phoneAccess.onChanged((next) => setAccess(next))
    return () => {
      live = false
      off()
    }
  }, [active])

  const set = useCallback(async (patch: { enabled?: boolean; port?: number; url?: string | null }) => {
    setError(null)
    try {
      setAccess(await window.api.appServers.phoneAccess.set(patch))
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }, [])

  const revoke = useCallback(async (name: string) => {
    setError(null)
    try {
      // The list follows by phoneAccess.changed.
      await window.api.appServers.phoneAccess.revoke(name)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  return { access, error, set, revoke }
}

/**
 * The Local server's side of "Pair a phone…": the switch that opens its listener on this
 * machine's Tailscale address, what that listener is doing, the address a phone is given (the
 * default, or the user's own), and the phones paired so far.
 */
export function PhoneAccessPanel({ phone }: { phone: PhoneAccessState }): React.JSX.Element {
  const { access, error, set, revoke } = phone
  const [port, setPort] = useState('')
  const [url, setUrl] = useState('')

  // The fields follow the server's values whenever those change.
  useEffect(() => setPort(access ? String(access.port) : ''), [access?.port])
  useEffect(() => setUrl(access?.url ?? ''), [access?.url])

  if (!access) {
    return <div className="phone-access">{error ? <div className="error">{error}</div> : <p className="muted">Asking the Local server…</p>}</div>
  }

  // A field the server did not take goes back to the server's value: the effects above only run
  // when that value changes, and a refusal changes nothing.
  const savePort = (): void => {
    const next = parsePhonePort(port)
    if (next === null) return setPort(String(access.port))
    if (next === access.port) return
    void set({ port: next }).then((ok) => ok || setPort(String(access.port)))
  }
  const saveUrl = (): void => {
    const next = url.trim()
    if (next === (access.url ?? '')) return
    void set({ url: next === '' ? null : next }).then((ok) => ok || setUrl(access.url ?? ''))
  }
  const problem = access.state === 'port-in-use' || access.state === 'error' || (access.state === 'no-tailscale' && !access.customUrl)

  return (
    <div className="phone-access" role="group" aria-label="Phone access">
      <label className="phone-access-switch">
        <input type="checkbox" checked={access.enabled} onChange={(e) => void set({ enabled: e.target.checked })} /> Allow phones over Tailscale
      </label>
      <p className="muted">
        The Local server listens on this computer&rsquo;s Tailscale address, so only devices on your tailnet can reach it. A paired phone
        can do what you can do in Trek on this computer.
      </p>
      {error && <div className="error">{error}</div>}
      {access.enabled && (
        <>
          <p className={problem ? 'warn' : 'muted'} aria-live="polite" data-testid="phone-access-status">
            {phoneAccessLabel(access)}
          </p>
          <div className="phone-access-row">
            <label htmlFor="phone-access-port">Port</label>
            <input
              id="phone-access-port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={savePort}
              onKeyDown={(e) => e.key === 'Enter' && savePort()}
            />
          </div>
          <div className="phone-access-row">
            <label htmlFor="phone-access-url">Address for the phone</label>
            <input
              id="phone-access-url"
              value={url}
              placeholder="ws://100.x.y.z:7346"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={saveUrl}
              onKeyDown={(e) => e.key === 'Enter' && saveUrl()}
            />
            {access.customUrl && (
              <button className="btn btn-ghost" onClick={() => void set({ url: null })}>
                Use default
              </button>
            )}
          </div>
        </>
      )}
      {access.phones.length > 0 && (
        <div className="phone-access-phones">
          <div className="muted">Paired phones</div>
          {access.phones.map((p) => (
            <div key={p.name} className="phone-access-phone">
              <code>{p.name}</code>
              <span className="muted">{p.createdAt ? new Date(p.createdAt).toLocaleString() : ''}</span>
              <button className="btn btn-ghost danger" onClick={() => void revoke(p.name)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
