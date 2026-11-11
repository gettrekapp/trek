// Apple Push Notification service, over HTTP/2 with a provider token (the .p8 key). One session is
// kept open and reopened when it closes. A 410, or a 400 saying the token is bad or not for this
// app, means the phone's token is gone; anything else fails the push and is logged by the caller.
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { PushMessage, Provider, SendResult } from './api.ts'
import { ApnsToken } from './jwt.ts'
import type { Device } from './store.ts'

export const APNS_PRODUCTION = 'https://api.push.apple.com'
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'
const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])
const SEND_TIMEOUT_MS = 10_000

export interface ApnsOptions {
  origin: string
  bundleId: string
  token: ApnsToken
  log?: (line: string) => void
}

export class ApnsProvider implements Provider {
  private session?: ClientHttp2Session
  private readonly options: ApnsOptions

  constructor(options: ApnsOptions) {
    this.options = options
  }

  private connection(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
    const session = connect(this.options.origin)
    session.on('error', (err) => this.options.log?.(`[relay] apns connection: ${err.message}`))
    session.on('close', () => {
      if (this.session === session) this.session = undefined
    })
    session.unref()
    this.session = session
    return session
  }

  private request(device: Device, payload: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      let req
      try {
        req = this.connection().request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(device.pushToken)}`,
          authorization: `bearer ${this.options.token.get()}`,
          'apns-topic': this.options.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
          'content-type': 'application/json'
        })
      } catch (err) {
        resolve({ status: 0, reason: (err as Error).message })
        return
      }
      let status = 0
      let body = ''
      const timer = setTimeout(() => req.close(constants.NGHTTP2_CANCEL), SEND_TIMEOUT_MS)
      req.setEncoding('utf8')
      req.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      req.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      req.on('end', () => {
        clearTimeout(timer)
        let reason: string | undefined
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined
        } catch {
          // not JSON
        }
        resolve({ status, reason })
      })
      req.on('error', (err) => {
        clearTimeout(timer)
        resolve({ status: 0, reason: err.message })
      })
      req.end(payload)
    })
  }

  async send(device: Device, message: PushMessage): Promise<SendResult> {
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
      trek: { kind: message.kind, ...message.data }
    })
    let r = await this.request(device, payload)
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') {
      this.options.token.reset()
      r = await this.request(device, payload)
    }
    if (r.status === 200) return 'sent'
    if (r.status === 410 || (r.status === 400 && r.reason && DEAD_REASONS.has(r.reason))) return 'dead'
    this.options.log?.(`[relay] apns refused a push: ${r.status} ${r.reason ?? ''}`.trim())
    return 'failed'
  }

  close(): void {
    this.session?.close()
  }
}
