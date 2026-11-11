// The relay's HTTP API (/v1). A phone registers its push token and gets a device secret; with it,
// it makes one grant per paired server and hands only the grant's secret to that server. A server
// pushes with its grant secret: the relay looks the grant up, builds the words from the kind and
// project (src/shared/push.ts), and sends through APNs or FCM. Nothing a server sends reaches the
// lock screen as free text, and the relay never logs a push's words, tokens or secrets.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isPushKind, MAX_PUSH_ID, pushText, type PushData, type PushKind } from '../../src/shared/push.ts'
import {
  GRANTS_PER_DEVICE_PER_MINUTE,
  PUSHES_PER_DEVICE_PER_HOUR,
  PUSHES_PER_GRANT_PER_MINUTE,
  REGISTRATIONS_PER_MINUTE,
  takeAll,
  WindowLimiter
} from './limits.ts'
import { MAX_LABEL, MAX_PUSH_TOKEN, type Device, type Platform, type RelayStore } from './store.ts'

export const MAX_BODY_BYTES = 16 * 1024
/** A project name longer than this is refused outright (pushText cuts to MAX_PUSH_PROJECT) */
const MAX_PROJECT_INPUT = 400

export interface PushMessage {
  title: string
  body: string
  kind: PushKind
  data: PushData
}

/**
 * 'sent'; 'dead' (the token is gone: unregistered); 'rejected' (the service refused this push or
 * the relay's credentials: retrying won't help, answered 422); 'unavailable' (the service is down,
 * limiting, or timed out: answered 503 with Retry-After).
 */
export type SendResult = 'sent' | 'dead' | 'rejected' | 'unavailable'

/** What a 503 tells a server to wait, in seconds */
export const RETRY_AFTER_S = 30
/** The header a build's registration key comes in */
export const REGISTRATION_KEY_HEADER = 'x-trek-relay-key'

export interface Provider {
  send(device: Device, message: PushMessage): Promise<SendResult>
  close?(): void
}

export interface RelayDeps {
  store: RelayStore
  providers: Partial<Record<Platform, Provider>>
  now?: () => number
  log?: (line: string) => void
  /** Read the client's address from X-Forwarded-For's last hop (behind Caddy) */
  trustProxy?: boolean
  /** POST /v1/devices needs this in REGISTRATION_KEY_HEADER */
  registrationKey?: string
}

class HttpError extends Error {
  readonly status: number
  readonly headers: Record<string, string>
  /** The request is dropped once the answer is sent (a body over the cap) */
  readonly drop: boolean
  constructor(status: number, message: string, options: { headers?: Record<string, string>; drop?: boolean } = {}) {
    super(message)
    this.status = status
    this.headers = options.headers ?? {}
    this.drop = options.drop ?? false
  }
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

const tooLarge = (): HttpError => new HttpError(413, 'body too large', { headers: { connection: 'close' }, drop: true })

/** The JSON body, up to MAX_BODY_BYTES: a larger declared length is refused before reading, and a stream past it stops being read. */
function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(tooLarge())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        over = true
        req.off('data', onData)
        req.pause()
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => {
      if (over) return
      if (size === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

const bearer = (req: IncomingMessage): string => {
  const h = req.headers.authorization
  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(h) : null
  if (!m) throw new HttpError(401, 'unauthorized')
  return m[1]
}

const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be an object')
  return v as Record<string, unknown>
}

const pushTokenOf = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_TOKEN || /\s/.test(v)) throw new HttpError(400, 'pushToken must be a token string')
  return v
}

const idOf = (v: unknown, what: string, required: boolean): string | undefined => {
  if (v === undefined && !required) return undefined
  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_ID || !/^[\w.:-]+$/.test(v)) throw new HttpError(400, `data.${what} must be an id`)
  return v
}

/** Constant-time comparison of two strings (their sha256, so lengths don't leak either) */
const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

export function createRelayHandler(deps: RelayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const registrations = new WindowLimiter(REGISTRATIONS_PER_MINUTE, 60_000)
  const grantsMade = new WindowLimiter(GRANTS_PER_DEVICE_PER_MINUTE, 60_000)
  const perGrant = new WindowLimiter(PUSHES_PER_GRANT_PER_MINUTE, 60_000)
  const perDevice = new WindowLimiter(PUSHES_PER_DEVICE_PER_HOUR, 3_600_000)
  const { store } = deps

  /** The client's address: the socket's, or behind a trusted proxy the last X-Forwarded-For hop (the one the proxy added) */
  const clientAddress = (req: IncomingMessage): string => {
    if (deps.trustProxy) {
      const raw = req.headers['x-forwarded-for']
      const hops = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((h) => h.trim()).filter(Boolean)
      if (hops.length) return hops[hops.length - 1]
    }
    return req.socket.remoteAddress ?? ''
  }

  /** A dead device's phone must send its token again before it can manage grants */
  const alive = (d: Device): Device => {
    if (d.dead) throw new HttpError(410, 'device-dead')
    return d
  }

  const device = (req: IncomingMessage, id?: string): Device => {
    const d = store.deviceFor(bearer(req), id)
    if (!d) throw new HttpError(401, 'unauthorized')
    return d
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://relay')
    const path = url.pathname
    const method = req.method ?? 'GET'
    if (path === '/v1/health' && method === 'GET') return json(res, 200, { ok: true })

    if (path === '/v1/devices' && method === 'POST') {
      if (!registrations.take(clientAddress(req), now())) throw new HttpError(429, 'too many registrations')
      if (deps.registrationKey !== undefined) {
        const given = req.headers[REGISTRATION_KEY_HEADER]
        if (typeof given !== 'string' || !sameSecret(given, deps.registrationKey)) throw new HttpError(401, 'registration key required')
      }
      const b = obj(await readBody(req))
      if (b.platform !== 'ios' && b.platform !== 'android') throw new HttpError(400, "platform must be 'ios' or 'android'")
      if (!deps.providers[b.platform]) throw new HttpError(400, `this relay does not push to ${b.platform}`)
      const made = store.addDevice(b.platform, pushTokenOf(b.pushToken))
      if (made === 'full') {
        log('[relay] refused a registration: the relay holds its most devices (maxDevices)')
        throw new HttpError(503, 'the relay is full')
      }
      const { device: d, secret, replaced } = made
      log(`[relay] registered a ${d.platform} device ${d.id}${replaced ? ' (replacing the device that had its token)' : ''}`)
      return json(res, 201, { deviceId: d.id, deviceSecret: secret })
    }

    const deviceMatch = /^\/v1\/devices\/([\w-]{1,64})$/.exec(path)
    if (deviceMatch && (method === 'PUT' || method === 'DELETE')) {
      const d = device(req, deviceMatch[1])
      if (method === 'DELETE') {
        store.removeDevice(d.id)
        log(`[relay] removed device ${d.id}`)
        return json(res, 200, { removed: true })
      }
      const b = obj(await readBody(req))
      if (b.pushToken === undefined && b.paused === undefined) throw new HttpError(400, 'send pushToken, paused, or both')
      if (b.paused !== undefined && typeof b.paused !== 'boolean') throw new HttpError(400, 'paused must be true or false')
      const token = b.pushToken === undefined ? undefined : pushTokenOf(b.pushToken)
      if (token !== undefined) store.setPushToken(d.id, token)
      if (typeof b.paused === 'boolean') store.setPaused(d.id, b.paused)
      return json(res, 200, { updated: true, paused: d.paused === true })
    }

    if (path === '/v1/grants' && method === 'GET') {
      const d = alive(device(req))
      return json(res, 200, store.grantsOf(d.id).map((g) => ({ grantId: g.id, label: g.label, createdAt: g.createdAt, lastPushAt: g.lastPushAt ?? null })))
    }
    if (path === '/v1/grants' && method === 'POST') {
      const d = alive(device(req))
      if (!grantsMade.take(d.id, now())) throw new HttpError(429, 'too many grants')
      const b = obj(await readBody(req))
      if (typeof b.label !== 'string' || b.label.length > MAX_LABEL) throw new HttpError(400, `label must be a string of up to ${MAX_LABEL} characters`)
      const made = store.addGrant(d.id, b.label.trim())
      if (made === 'full') throw new HttpError(409, 'this device has too many grants')
      return json(res, 201, { grantId: made.grant.id, grantSecret: made.secret })
    }
    const grantMatch = /^\/v1\/grants\/([\w-]{1,64})$/.exec(path)
    if (grantMatch && method === 'DELETE') {
      const d = device(req)
      if (!store.removeGrant(d.id, grantMatch[1])) throw new HttpError(404, 'no such grant')
      return json(res, 200, { revoked: true })
    }

    if (path === '/v1/push' && method === 'POST') {
      const found = store.grantFor(bearer(req))
      if (!found) throw new HttpError(401, 'unknown grant')
      const { grant, device: d } = found
      if (d.dead) throw new HttpError(410, 'the device is gone')
      const b = obj(await readBody(req))
      if (!isPushKind(b.kind)) throw new HttpError(400, 'unknown kind')
      if (typeof b.project !== 'string' || b.project.length > MAX_PROJECT_INPUT) throw new HttpError(400, 'project must be a string')
      const data = obj(b.data)
      const pushData: PushData = {
        serverId: idOf(data.serverId, 'serverId', true)!,
        projectId: idOf(data.projectId, 'projectId', true)!,
        ...(data.worktreeId !== undefined ? { worktreeId: idOf(data.worktreeId, 'worktreeId', false) } : {}),
        ...(data.sessionId !== undefined ? { sessionId: idOf(data.sessionId, 'sessionId', false) } : {})
      }
      // The phone paused every push: accepted (the server has nothing to fix) and dropped.
      if (d.paused) {
        log(`[relay] push ${b.kind} grant ${grant.id}: paused`)
        return json(res, 202, { accepted: true, paused: true })
      }
      if (!takeAll(now(), [perGrant, grant.id], [perDevice, d.id])) throw new HttpError(429, 'too many pushes')
      const provider = deps.providers[d.platform]
      if (!provider) throw new HttpError(503, `this relay does not push to ${d.platform}`, { headers: { 'retry-after': String(RETRY_AFTER_S) } })
      const words = pushText(b.kind, b.project)
      const tokenSent = d.pushToken
      const result = await provider.send(d, { ...words, kind: b.kind, data: pushData })
      log(`[relay] push ${b.kind} grant ${grant.id}: ${result}`)
      if (result === 'dead') {
        store.markDead(d.id, tokenSent)
        throw new HttpError(410, 'the device is gone')
      }
      if (result === 'rejected') throw new HttpError(422, 'the push service refused the push')
      if (result === 'unavailable') throw new HttpError(503, 'the push service is unavailable', { headers: { 'retry-after': String(RETRY_AFTER_S) } })
      store.markDelivered(d.id, tokenSent)
      store.touchGrant(grant.id)
      return json(res, 202, { accepted: true })
    }

    throw new HttpError(404, 'not found')
  }

  return (req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`[relay] internal error: ${(err as Error).message}`)
      if (res.headersSent) return void res.destroy()
      const headers = err instanceof HttpError ? err.headers : {}
      json(res, status, { error: status === 500 ? 'internal error' : (err as Error).message }, headers)
      // A body over the cap: nothing more of it is read once the answer is out.
      if (err instanceof HttpError && err.drop) res.on('finish', () => req.destroy())
    })
  }
}
