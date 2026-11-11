// Local stand-ins for APNs, Google's OAuth token endpoint and FCM (6b tests and smoke:push). The
// relay reaches them through its test-only apnsHost/fcmHost/oauthHost overrides, so no test ever
// talks to Apple or Google. APNs is cleartext HTTP/2 (h2c) on loopback; the others plain HTTP.
import { createServer as createH2Server } from 'node:http2'
import { createServer } from 'node:http'
import { generateKeyPairSync, verify } from 'node:crypto'

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

/** A .p8-style ES256 key (PKCS#8 PEM) and its public half, for checking provider tokens */
export function testApnsKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey }
}

/** A service-account JSON like Google's, pointing token_uri at `oauthOrigin` (or Google's, overridden by the relay) */
export function testServiceAccount(tokenUri = 'https://oauth2.googleapis.com/token') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    account: {
      type: 'service_account',
      project_id: 'trek-test',
      client_email: 'relay@trek-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: tokenUri
    },
    publicKey
  }
}

/** Checks a compact JWT's signature with `publicKey` and returns its header and claims */
export function readJwt(jwt, publicKey, alg) {
  const [h, c, s] = jwt.split('.')
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, Buffer.from(s, 'base64url'))
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) }
}

/**
 * APNs: records each push ({path, headers, body}); `respond(push)` picks the answer
 * ({status, reason}), default 200.
 */
export async function startApnsStub() {
  const pushes = []
  const stub = { pushes, respond: () => ({ status: 200 }) }
  const server = createH2Server()
  const sessions = new Set()
  server.on('session', (s) => {
    sessions.add(s)
    s.on('close', () => sessions.delete(s))
  })
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (c) => (body += c))
    stream.on('end', () => {
      const push = { path: headers[':path'], headers, body: body ? JSON.parse(body) : null }
      pushes.push(push)
      const { status, reason } = stub.respond(push)
      stream.respond({ ':status': status, 'content-type': 'application/json' })
      stream.end(reason ? JSON.stringify({ reason }) : '')
    })
  })
  const port = await listen(server)
  stub.origin = `http://127.0.0.1:${port}`
  // A client's HTTP/2 session stays open between pushes: end them, or close() waits forever.
  stub.close = () =>
    new Promise((resolve) => {
      for (const s of sessions) s.destroy()
      server.close(() => resolve())
    })
  return stub
}

/**
 * Google's token endpoint (POST /token) and FCM (POST /v1/projects/<p>/messages:send). Records the
 * token requests' assertions and the messages; `respond(message)` picks FCM's answer.
 */
export async function startFcmStub() {
  const assertions = []
  const messages = []
  let issued = 0
  const stub = { assertions, messages, respond: () => ({ status: 200 }), tokensIssued: () => issued }
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/token') {
        const form = new URLSearchParams(body)
        assertions.push(form.get('assertion'))
        issued += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600 }))
        return
      }
      if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url ?? '')) {
        const message = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) }
        messages.push(message)
        const { status, error } = stub.respond(message)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200 ? { name: 'projects/trek-test/messages/1' } : { error }))
        return
      }
      res.writeHead(404).end()
    })
  })
  const port = await listen(server)
  stub.origin = `http://127.0.0.1:${port}`
  stub.close = () => new Promise((resolve) => server.close(() => resolve()))
  return stub
}
