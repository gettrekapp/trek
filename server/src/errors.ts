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

/** Only the fields WireErrorDetails names, with the right types, reach the wire; `reason` only with a passed-through code. */
function wireDetails(err: unknown, withReason: boolean): WireErrorDetails | undefined {
  const details = (err as { details?: unknown } | null)?.details
  const d = details && typeof details === 'object' ? (details as { reason?: unknown; tornDown?: unknown }) : {}
  const wire: WireErrorDetails = {}
  if (withReason && typeof d.reason === 'string') wire.reason = d.reason
  if (Array.isArray(d.tornDown) && d.tornDown.every((label) => typeof label === 'string')) wire.tornDown = [...(d.tornDown as string[])]
  return Object.keys(wire).length > 0 ? wire : undefined
}

export function toWireError(method: string, err: unknown): WireError {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  const passed = typeof code === 'string' && PASSTHROUGH.has(code)
  // A plugin's NOT_SIGNED_IN is for the server's own PR watch; a client sees it as a tool's failure.
  const wireCode: WireErrorCode = passed ? (code as WireErrorCode) : code === 'NOT_SIGNED_IN' ? 'TOOL_ERROR' : method.startsWith('git.') ? 'GIT_ERROR' : 'INTERNAL'
  // What was torn down before an unexpected failure reaches the client too.
  const details = wireDetails(err, passed)
  return details ? { code: wireCode, message, details } : { code: wireCode, message }
}
