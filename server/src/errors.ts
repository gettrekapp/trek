import type { WireError, WireErrorCode, WireErrorDetails } from '../../src/shared/protocol'

/** Errors carrying one of these codes reach the client as-is. */
export type Outcome = { ok: true; result: unknown } | { ok: false; error: WireError }

const PASSTHROUGH: ReadonlySet<string> = new Set<WireErrorCode>([
  'BAD_REQUEST',
  'NOT_FOUND',
  'PATH_DENIED',
  'GIT_ERROR',
  'PTY_NOT_FOUND',
  'NOT_A_REPO',
  'IN_USE',
  'CONFLICT',
  'CAPACITY',
  'CONGESTED'
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
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      return { code: code as WireErrorCode, message, details: details as WireErrorDetails }
    }
    return { code: code as WireErrorCode, message }
  }
  return { code: method.startsWith('git.') ? 'GIT_ERROR' : 'INTERNAL', message }
}
