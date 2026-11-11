// Redeeming a phone pairing code (6a): one hello with `pairingCode` instead of a token. The
// server mints the phone's own named token and sends it once in the welcome; the socket is then
// closed, and the phone connects again with that token like any client. Nothing here imports Node,
// DOM or Electron modules (the phone runs it).
import { CLOSE_UNAUTHORIZED, PAIRING_CLOSE_REASON, PROTOCOL_VERSION_V2 } from '../protocolV2.ts'
import { realTimers, type SocketFactory, type Timers } from './socket.ts'

export type PairingFailure = 'expired' | 'used' | 'unknown' | 'limited' | 'unsaved' | 'unreachable' | 'refused' | 'timeout'

export class PairingError extends Error {
  readonly kind: PairingFailure
  constructor(kind: PairingFailure, message: string) {
    super(message)
    this.name = 'PairingError'
    this.kind = kind
  }
}

export interface PairingResult {
  token: string
  tokenName: string
  serverId: string
  serverName: string
  capabilities: string[]
}

export interface RedeemOptions {
  url: string
  code: string
  deviceName: string
  createSocket: SocketFactory
  client?: string
  clientVersion?: string
  timeoutMs?: number
  timers?: Timers
}

const MESSAGES: Record<PairingFailure, string> = {
  expired: 'That pairing code has expired. Ask for a new one on the desktop.',
  used: 'That pairing code was already used. Ask for a new one on the desktop.',
  unknown: 'The server does not recognise that pairing code. Check it, or ask for a new one.',
  limited: 'Too many pairing attempts. Wait a minute and try again.',
  unsaved: 'The server could not save the new token, and the code is now used up. Check the server (its log says why), then ask for a new code on the desktop.',
  unreachable: 'Could not reach the server.',
  refused: 'The server refused the pairing.',
  timeout: 'The server did not answer in time.'
}

/** Why a 4003 close refused the code, from its reason. */
export function pairingFailureOf(code: number, reason: string): PairingFailure {
  if (code !== CLOSE_UNAUTHORIZED) return 'unreachable'
  for (const [kind, text] of Object.entries(PAIRING_CLOSE_REASON)) if (reason === text) return kind as PairingFailure
  return 'refused'
}

export function redeemPairingCode(opts: RedeemOptions): Promise<PairingResult> {
  const timers = opts.timers ?? realTimers
  return new Promise<PairingResult>((resolve, reject) => {
    let done = false
    let socket: ReturnType<SocketFactory>
    const finish = (err: PairingError | null, result?: PairingResult): void => {
      if (done) return
      done = true
      timers.clearTimeout(timer)
      try {
        socket?.close(1000, 'paired')
      } catch {
        // already closed
      }
      if (err) reject(err)
      else resolve(result!)
    }
    const fail = (kind: PairingFailure): void => finish(new PairingError(kind, MESSAGES[kind]))
    const timer = timers.setTimeout(() => fail('timeout'), opts.timeoutMs ?? 15_000)
    try {
      socket = opts.createSocket(opts.url)
    } catch {
      fail('unreachable')
      return
    }
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION_V2,
          client: opts.client ?? 'trek-mobile',
          clientVersion: opts.clientVersion ?? '0',
          pairingCode: opts.code,
          deviceName: opts.deviceName
        })
      )
    })
    socket.addEventListener('message', (event) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame?.type !== 'welcome') return
      if (typeof frame.pairedToken !== 'string' || frame.pairedToken === '') return fail('refused')
      finish(null, {
        token: frame.pairedToken,
        tokenName: typeof frame.pairedTokenName === 'string' ? frame.pairedTokenName : '',
        serverId: typeof frame.serverId === 'string' ? frame.serverId : '',
        serverName: typeof frame.serverName === 'string' ? frame.serverName : '',
        capabilities: Array.isArray(frame.capabilities) ? frame.capabilities.filter((c): c is string => typeof c === 'string') : []
      })
    })
    socket.addEventListener('close', (event) => fail(pairingFailureOf(event.code, event.reason)))
    socket.addEventListener('error', () => {
      // 'close' follows with the code
    })
  })
}

/**
 * A `trek://pair?url=…&code=…` link (the desktop's QR): the server URL and the code, or null.
 * Only fills the pairing form; nothing is redeemed without the user's tap.
 */
export function parsePairingLink(link: string): { url: string; code: string } | null {
  let parsed: URL
  try {
    parsed = new URL(link.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'trek:') return null
  // trek://pair?… : the host is "pair" (or the path, for trek:pair?…)
  const target = parsed.hostname || parsed.pathname.replace(/^\/+/, '')
  if (target !== 'pair') return null
  const url = parsed.searchParams.get('url') ?? ''
  const code = parsed.searchParams.get('code') ?? ''
  if (!url || !code || !/^[A-Za-z2-7\s-]{16,64}$/.test(code)) return null
  try {
    const server = new URL(url)
    if (server.protocol !== 'ws:' && server.protocol !== 'wss:') return null
  } catch {
    return null
  }
  return { url, code }
}

/** The link the desktop shows as a QR. */
export function pairingLink(url: string, code: string): string {
  return `trek://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`
}
