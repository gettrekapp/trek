// Which server addresses the phone connects to (6a): wss:// always; plain ws:// only to this
// device, a private LAN or Tailscale address (with a warning: the token travels unencrypted on
// that network). Pure, so `node --test` covers it (scripts/mobileLogic.test.mjs).

export type UrlCheck = { ok: true; url: string; warning?: string } | { ok: false; message: string }

const PLAIN_WARNING = 'Not encrypted: anyone on this network can read the traffic, the token included. Use wss:// through a TLS proxy when you can.'

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null
}

/** Loopback, RFC 1918, link-local, Tailscale's 100.64/10, IPv6 ULA and link-local, and .local names. */
// It judges the address as written (after URL parsing), never what a name resolves to, and
// anything it doesn't recognise is refused for ws://: a MagicDNS name (*.ts.net) or another LAN
// name, and the hex IPv4-mapped form URL gives `[::ffff:192.168.0.1]` (`[::ffff:c0a8:1]`). That
// fails closed (wss://, or the plain IP, works), so it is left as is.
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true
  const v4 = ipv4(host.startsWith('::ffff:') ? host.slice(7) : host)
  if (v4) {
    const [a, b] = v4
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
}

export function checkServerUrl(input: string): UrlCheck {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: 'Enter the server address, like wss://dev.example.com' }
  }
  if (url.protocol === 'wss:') return { ok: true, url: text }
  if (url.protocol !== 'ws:') return { ok: false, message: 'The address starts with wss:// (or ws:// on a private network)' }
  if (!isPrivateHost(url.hostname)) return { ok: false, message: 'Plain ws:// is only allowed to a private network address. Use wss://' }
  return { ok: true, url: text, warning: PLAIN_WARNING }
}
