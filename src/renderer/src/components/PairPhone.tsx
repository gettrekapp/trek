import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'qrcode'
import { errorText } from '../v2/errors'
import type { AppServerPairing } from '../../../shared/types'

/**
 * "Pair a phone…" (6a): a one-time code from the server, shown as a QR of
 * `trek://pair?url=…&code=…` and as text, with its countdown. The code is not a token: the phone
 * redeems it once for its own. Main asks the server for it (window.api.appServers.pairPhone).
 */
export function PairPhone({ serverId, onClose }: { serverId: string; onClose: () => void }): React.JSX.Element {
  const [pairing, setPairing] = useState<AppServerPairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const ask = useCallback(async () => {
    setError(null)
    setPairing(null)
    try {
      setPairing(await window.api.appServers.pairPhone(serverId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [serverId])

  useEffect(() => {
    void ask()
  }, [ask])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
  const expired = pairing !== null && left === 0

  return (
    <div className="pair-phone" role="group" aria-label="Pair a phone">
      {error && <div className="error">Could not get a pairing code: {error}</div>}
      {!pairing && !error && <p className="muted">Asking the server for a pairing code…</p>}
      {pairing && (
        <>
          {!expired && <QrCode text={pairing.link} />}
          <div className="pair-phone-text">
            <p>
              In the Trek app on your phone, choose <strong>Add server</strong> and scan this code, or type the server
              address and the code below.
            </p>
            <div className="pair-phone-field">
              <span className="muted">Server</span> <code data-testid="pair-url">{pairing.url}</code>
            </div>
            <div className="pair-phone-field">
              <span className="muted">Code</span> <code data-testid="pair-code">{groupCode(pairing.code)}</code>
            </div>
            <p className={expired ? 'warn' : 'muted'} aria-live="polite">
              {expired
                ? 'This code has expired.'
                : `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more. The phone gets its own token, which you can revoke on the server.`}
            </p>
          </div>
        </>
      )}
      <div className="pair-phone-actions">
        <button className="btn btn-ghost" onClick={() => void ask()}>
          New code
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

/** In groups of five, for reading aloud or typing. */
export function groupCode(code: string): string {
  return code.replace(/(.{5})(?=.)/g, '$1-')
}

/** The QR as SVG squares (no image data, no innerHTML): a 4-module quiet zone, black on white. */
function QrCode({ text }: { text: string }): React.JSX.Element {
  const { size, path } = useMemo(() => {
    const { modules } = create(text, { errorCorrectionLevel: 'M' })
    let d = ''
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`
      }
    }
    return { size: modules.size + 8, path: d }
  }, [text])
  return (
    <svg className="pair-phone-qr" data-testid="pair-qr" viewBox={`0 0 ${size} ${size}`} width={220} height={220} role="img" aria-label="Pairing QR code">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  )
}
