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

/**
 * The dialog for an edit the link dropped under: a request refused before it
 * left, or one whose answer was lost with the connection. Either way the
 * window cannot tell whether the server applied it.
 */
export const EDIT_NOT_CONFIRMED =
  'The server was not connected, so this change may not have been saved. Check it once the window is back online.'

/**
 * Reports a failed edit (a setter override). NOT_CONNECTED shows
 * EDIT_NOT_CONFIRMED under the edit's title, one dialog at a time, so a burst of
 * edits as the link drops shows one; any other error goes to `report`. No retry
 * queue: an edit replayed after a reconnect could land on a state the user no
 * longer sees.
 */
export function editReporter(
  show: (title: string, message: string) => Promise<void>,
  report: (title: string, err: unknown) => void
): (title: string, err: unknown) => void {
  let showing = false
  return (title, err) => {
    if (errorCode(err) !== 'NOT_CONNECTED') {
      report(title, err)
      return
    }
    if (showing) return
    showing = true
    void show(title, EDIT_NOT_CONFIRMED).finally(() => {
      showing = false
    })
  }
}
