/**
 * OSC 52, the escape sequence a terminal program uses to set the clipboard
 * (`ESC ] 52 ; <targets> ; <base64> BEL`). Claude Code sends one for every
 * copy-on-select; it also copies natively, but that lands on the server
 * machine's clipboard. Handling OSC 52 in the window puts the text on the
 * clipboard of the computer the user is sitting at.
 */

/** The largest payload taken, in base64 characters (about 1.5 MB of text). */
export const OSC52_MAX_BASE64 = 2_000_000

/**
 * The text an OSC 52 payload (what follows `52;`) asks to put on the
 * clipboard, or null when it asks for nothing this window should do: a read
 * (`?`, never answered, so a program cannot read the user's clipboard), a
 * clear (empty data), a malformed or oversized payload.
 */
export function osc52Text(data: string): string | null {
  const semi = data.indexOf(';')
  if (semi < 0) return null
  const b64 = data.slice(semi + 1).replace(/\s+/g, '')
  if (b64 === '' || b64 === '?' || b64.length > OSC52_MAX_BASE64) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null
  let bytes: Uint8Array
  try {
    const bin = atob(b64)
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
