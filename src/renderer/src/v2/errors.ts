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

/** The same, for a prompt sent to a session. */
export const PROMPT_NOT_CONFIRMED =
  'The server was not connected, so this prompt may not have been sent. Check the session once the window is back online.'

/** The follow-up for the edits whose NOT_CONNECTED came while that dialog was open. */
export const ALSO_NOT_CONFIRMED = 'Other changes made meanwhile may also not have been saved.'

/**
 * Reports a failed edit (a setter override, or a prompt sent). NOT_CONNECTED
 * shows `notConfirmed` (EDIT_NOT_CONFIRMED unless given) under the edit's
 * title, one dialog at a time, so a burst of edits as the link drops shows
 * one, and then, if any came while it was open, one ALSO_NOT_CONFIRMED under
 * the first of their titles; any other error goes to `report`. No retry
 * queue: an edit replayed after a reconnect could land on a state the user no
 * longer sees.
 */
export function editReporter(
  show: (title: string, message: string) => Promise<void>,
  report: (title: string, err: unknown) => void
): (title: string, err: unknown, notConfirmed?: string) => void {
  let showing = false
  /** The first edit dropped while a dialog was open, or null */
  let dropped: string | null = null
  const open = (title: string, message: string): void => {
    showing = true
    const closed = (): void => {
      showing = false
      const next = dropped
      dropped = null
      if (next !== null) open(next, ALSO_NOT_CONFIRMED)
    }
    show(title, message).then(closed, closed)
  }
  return (title, err, notConfirmed = EDIT_NOT_CONFIRMED) => {
    if (errorCode(err) !== 'NOT_CONNECTED') {
      report(title, err)
      return
    }
    if (showing) dropped ??= title
    else open(title, notConfirmed)
  }
}
