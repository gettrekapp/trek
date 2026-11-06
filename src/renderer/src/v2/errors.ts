// Display text for errors from the v2 SDK and from IPC calls into main. Pure.

/** Electron wraps a rejected invoke as "Error invoking remote method 'x': Error: <message>"; keep the message. */
export function cleanIpcMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

const HINTS: Record<string, string> = {
  NOT_CONNECTED: 'Not connected to the server',
  TIMEOUT: 'The server did not answer in time',
  UNAUTHORIZED: 'The server rejected the access token'
}

/** A `ClientError` (code + message), an IPC rejection or anything else, as one line for the UI. */
export function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: unknown; message?: unknown }
    const text = typeof message === 'string' ? cleanIpcMessage(message) : ''
    if (typeof code === 'string' && code in HINTS && !text) return HINTS[code]
    if (text) return text
    if (typeof code === 'string') return HINTS[code] ?? code
  }
  return cleanIpcMessage(String(err))
}

/** The error code of a `ClientError`, or null. */
export function errorCode(err: unknown): string | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : null
}
