// A service's reply body, read with a byte cap (phase 5b: Linear's JSON, ElevenLabs' audio and
// error text), so a misbehaving or hostile endpoint cannot make the server buffer without limit.
// Electron-free.

/**
 * The body's bytes, at most `max`. A `content-length` over the cap fails before anything is read;
 * without one, the stream is cut off as soon as it passes the cap. Either way the error names
 * `what` ("Linear's reply") and the body is cancelled.
 */
export async function readBodyCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const tooLarge = (): Error => new Error(`${what} is larger than ${max} bytes`)
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

export const MAX_JSON_BYTES = 1024 * 1024
export const MAX_ERROR_BYTES = 1024 * 1024
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
