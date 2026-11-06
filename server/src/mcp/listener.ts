// The trek-dev MCP endpoint: loopback only, POST /mcp, one bearer token per project.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpAccessStore } from './access.ts'
import { handleMcpBody, type McpContext } from './protocol.ts'

export const MAX_MCP_BODY = 1024 * 1024
export const MCP_REQUEST_TIMEOUT_MS = 30_000

export interface McpListenerDeps {
  access: McpAccessStore
  serverVersion: string
  /** The tools and instructions for one project's token */
  contextFor: (projectId: string) => Omit<McpContext, 'serverVersion'>
  /** How long a request may take to arrive in full (headers and body); default 30 s */
  requestTimeoutMs?: number
}

export interface McpListener {
  port: number
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, json?: unknown, headers: Record<string, string> = {}): void {
  if (json === undefined) {
    res.writeHead(status, headers).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(json))
}

class BodyTooLarge extends Error {}

/** How much of a refused body is read and thrown away so the client sees the answer; past this the socket is dropped. */
const MAX_MCP_DRAIN = 8 * MAX_MCP_BODY

/**
 * Answers a request whose body is not wanted. The rest of the body is read and thrown away first: closing a socket
 * with unread bytes on it sends a reset, and a client still uploading then gets that reset instead of the answer.
 * A slow sender is bounded by the request timeout (Node answers 408 and drops it), a big one by MAX_MCP_DRAIN.
 */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  req.on('error', () => {})
  if (req.readableEnded) return send(res, status, undefined, headers)
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_MCP_DRAIN) {
    // Not worth reading: answer, then drop the connection (the client may see the reset instead).
    send(res, status, undefined, { ...headers, connection: 'close' })
    res.once('finish', () => req.destroy())
    return
  }
  let drained = 0
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length
    if (drained > MAX_MCP_DRAIN) req.destroy()
  })
  req.once('end', () => send(res, status, undefined, headers))
  req.resume()
}

/** Reads the body; rejects with BodyTooLarge as soon as it goes over the limit (without reading or destroying the rest). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_MCP_BODY) {
      reject(new BodyTooLarge())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > MAX_MCP_BODY) {
        done = true
        chunks.length = 0
        reject(new BodyTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (!done) reject(err)
    })
  })
}

export function startMcpListener(deps: McpListenerDeps): Promise<McpListener> {
  const timeout = deps.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS
  let port = 0
  const server = createServer(
    // Node only checks timeouts on an interval (default 30 s); check often enough to honour a short one.
    { requestTimeout: timeout, headersTimeout: timeout, connectionsCheckingInterval: Math.max(50, Math.min(1000, timeout)) },
    (req, res) => {
      // The client going away before its answer stops the tool's waits and anything it would still send.
      const request = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) request.abort()
      })
      void (async () => {
        try {
          // A browser on this machine can be pointed at 127.0.0.1 through a hostile DNS name; only our own host names pass.
          const host = req.headers.host
          if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(req, res, 403)
          if ((req.url ?? '').split('?')[0] !== '/mcp') return refuse(req, res, 404)
          if (req.method !== 'POST') return refuse(req, res, 405, { allow: 'POST' })
          const projectId = deps.access.projectFor(req.headers.authorization)
          if (!projectId) return refuse(req, res, 401)
          let body: string
          try {
            body = await readBody(req)
          } catch (err) {
            if (!(err instanceof BodyTooLarge)) throw err
            // The 413 goes out once the body is drained; the connection is then closed rather than reused.
            return refuse(req, res, 413, { connection: 'close' })
          }
          const reply = await handleMcpBody(body, { serverVersion: deps.serverVersion, ...deps.contextFor(projectId) }, request.signal)
          if (reply.status === 202) return send(res, 202)
          send(res, reply.status, reply.json)
        } catch (err) {
          if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } })
          else res.destroy()
        }
      })()
    }
  )
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      deps.access.setPort(port)
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
      })
    })
  })
}
