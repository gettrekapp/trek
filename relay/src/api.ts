// The relay's HTTP API (/v1). A phone registers its push token and gets a device secret; with it,
// it makes one grant per paired server and hands only the grant's secret to that server. A server
// pushes with its grant secret: the relay looks the grant up, builds the words from the kind and
// project (src/shared/push.ts), and sends through APNs or FCM. Nothing a server sends reaches the
// lock screen as free text, and the relay never logs a push's words, tokens or secrets.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isPushKind, MAX_PUSH_ID, pushText, type PushData, type PushKind } from '../../src/shared/push.ts'
import { PUSHES_PER_DEVICE_PER_HOUR, PUSHES_PER_GRANT_PER_MINUTE, REGISTRATIONS_PER_MINUTE, WindowLimiter } from './limits.ts'
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

/** 'sent'; 'dead' (the token is gone: unregistered); 'failed' (anything else, logged) */
export type SendResult = 'sent' | 'dead' | 'failed'

export interface Provider {
  send(device: Device, message: PushMessage): Promise<SendResult>
}

export interface RelayDeps {
  store: RelayStore
  providers: Partial<Record<Platform, Provider>>
  now?: () => number
  log?: (line: string) => void
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooBig = true
        return
      }
      if (!tooBig) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'body too large'))
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

export function createRelayHandler(deps: RelayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const registrations = new WindowLimiter(REGISTRATIONS_PER_MINUTE, 60_000)
  const perGrant = new WindowLimiter(PUSHES_PER_GRANT_PER_MINUTE, 60_000)
  const perDevice = new WindowLimiter(PUSHES_PER_DEVICE_PER_HOUR, 3_600_000)
  const { store } = deps

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
      if (!registrations.take(req.socket.remoteAddress ?? '', now())) throw new HttpError(429, 'too many registrations')
      const b = obj(await readBody(req))
      if (b.platform !== 'ios' && b.platform !== 'android') throw new HttpError(400, "platform must be 'ios' or 'android'")
      if (!deps.providers[b.platform]) throw new HttpError(400, `this relay does not push to ${b.platform}`)
      const { device: d, secret } = store.addDevice(b.platform, pushTokenOf(b.pushToken))
      log(`[relay] registered a ${d.platform} device ${d.id}`)
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
      store.setPushToken(d.id, pushTokenOf(b.pushToken))
      return json(res, 200, { updated: true })
    }

    if (path === '/v1/grants' && method === 'GET') {
      const d = device(req)
      return json(res, 200, store.grantsOf(d.id).map((g) => ({ grantId: g.id, label: g.label, createdAt: g.createdAt, lastPushAt: g.lastPushAt ?? null })))
    }
    if (path === '/v1/grants' && method === 'POST') {
      const d = device(req)
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
      const t = now()
      if (!perGrant.take(grant.id, t) || !perDevice.take(d.id, t)) throw new HttpError(429, 'too many pushes')
      const provider = deps.providers[d.platform]
      if (!provider) throw new HttpError(503, `this relay does not push to ${d.platform}`)
      const words = pushText(b.kind, b.project)
      const result = await provider.send(d, { ...words, kind: b.kind, data: pushData })
      log(`[relay] push ${b.kind} grant ${grant.id}: ${result}`)
      if (result === 'dead') {
        store.markDead(d.id)
        throw new HttpError(410, 'the device is gone')
      }
      if (result === 'failed') throw new HttpError(502, 'the push service refused the push')
      store.touchGrant(grant.id)
      return json(res, 202, { accepted: true })
    }

    throw new HttpError(404, 'not found')
  }

  return (req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`[relay] internal error: ${(err as Error).message}`)
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : (err as Error).message })
      else res.destroy()
    })
  }
}
