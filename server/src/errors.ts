import type { WireError, WireErrorCode, WireErrorDetails } from '../../src/shared/protocolV2'

/** Errors carrying one of these codes reach the client as-is. */
export type Outcome = { ok: true; result: unknown } | { ok: false; error: WireError }

const PASSTHROUGH: ReadonlySet<string> = new Set<WireErrorCode>([
  'UNAUTHORIZED',
  'BAD_REQUEST',
  'NOT_FOUND',
  'PATH_DENIED',
  'GIT_ERROR',
  'PTY_NOT_FOUND',
  'NOT_A_REPO',
  'IN_USE',
  'CONFLICT',
  'CAPACITY',
  'CONGESTED',
  'TOOL_ERROR'
])

export function codedError(code: WireErrorCode, message: string, details?: WireErrorDetails): Error {
  const err = new Error(message)
  ;(err as NodeJS.ErrnoException).code = code
  if (details) (err as { details?: WireErrorDetails }).details = details
  return err
}

export function toWireError(method: string, err: unknown): WireError {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && PASSTHROUGH.has(code)) {
    const details = (err as { details?: unknown }).details
    // Only the fields WireErrorDetails names, with the right types, reach the wire.
    const d = details && typeof details === 'object' ? (details as { reason?: unknown; tornDown?: unknown }) : {}
    const wire: WireErrorDetails = {}
    if (typeof d.reason === 'string') wire.reason = d.reason
    if (Array.isArray(d.tornDown) && d.tornDown.every((label) => typeof label === 'string')) wire.tornDown = [...(d.tornDown as string[])]
    return Object.keys(wire).length > 0 ? { code: code as WireErrorCode, message, details: wire } : { code: code as WireErrorCode, message }
  }
  // A plugin's NOT_SIGNED_IN is for the server's own PR watch; a client sees it as a tool's failure.
  if (code === 'NOT_SIGNED_IN') return { code: 'TOOL_ERROR', message }
  return { code: method.startsWith('git.') ? 'GIT_ERROR' : 'INTERNAL', message }
}
