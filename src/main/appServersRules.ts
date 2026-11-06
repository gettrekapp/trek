// The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
export interface AppServer {
  /** Client-side id */
  id: string
  name: string
  url: string
}

const MAX_NAME = 200

function wsUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

export function parseAppServers(raw: unknown): AppServer[] {
  if (!Array.isArray(raw)) return []
  const out: AppServer[] = []
  const ids = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || ids.has(id)) continue
    if (typeof name !== 'string' || !name || typeof url !== 'string' || !wsUrl(url)) continue
    ids.add(id)
    out.push({ id, name, url })
  }
  return out
}

export function validateServerInput(input: { name: unknown; url: unknown }): { name: string; url: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1–${MAX_NAME} characters`)
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('URL is not valid')
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('URL must start with ws:// or wss://')
  return { name, url }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** The relay's only change to outgoing frames: a hello carries the stored token. */
export function withToken(text: string, token: string): string {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return text
  }
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'hello') return text
  return JSON.stringify({ ...(frame as object), token })
}
