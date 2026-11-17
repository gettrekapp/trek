// Asks one configured MCP server for its tools (`initialize`, then `tools/list` page by page), for
// `mcpTools.list`. Over stdio (newline-delimited JSON-RPC, the server started as its own process
// group and ended with it) or streamable HTTP (a JSON or an SSE reply to each POST). The legacy
// SSE transport and OAuth sign-ins are not spoken: they come back as errors to show. Electron-free.
import { spawn } from 'node:child_process'
import { hidden } from '../../../src/host/childOptions.ts'
import { commandPath } from '../../../src/host/commandPath.ts'
import { readBodyCapped } from '../../../src/host/httpBody.ts'
import { killTree } from '../../../src/host/processTree.ts'
import { MAX_SERVER_TOOLS, MAX_TOOL_DESCRIPTION, type McpToolInfo } from '../../../src/shared/mcpTools.ts'
import type { ServerSpec } from './externalConfig.ts'

export const PROTOCOL_VERSION = '2025-06-18'
/** How long one server gets for the whole exchange */
export const DEFAULT_TIMEOUT_MS = 20_000
const MAX_PAGES = 20
const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_REPLY_BYTES = 4 * 1024 * 1024
const STDERR_TAIL = 600

interface Rpc {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
}

export interface ListOptions {
  timeoutMs?: number
  /** The server's own environment, under the spec's `env` */
  env?: Record<string, string | undefined>
  clientVersion?: string
  fetch?: typeof fetch
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function rpcError(method: string, error: unknown): Error {
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : JSON.stringify(error)
  return new Error(`${method} failed: ${message}`)
}

/** A tool as listed: its name and a description cut to size. */
function toolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '') return undefined
  const text = typeof raw.description === 'string' ? raw.description.trim().replace(/\s+/g, ' ') : ''
  const description = text.length > MAX_TOOL_DESCRIPTION ? `${text.slice(0, MAX_TOOL_DESCRIPTION - 1)}…` : text
  return description ? { name: raw.name, description } : { name: raw.name }
}

async function exchange(rpc: Rpc, clientVersion: string): Promise<McpToolInfo[]> {
  await rpc.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'trek', version: clientVersion } })
  await rpc.notify('notifications/initialized')
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc.request('tools/list', cursor ? { cursor } : {})
    if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error('tools/list answered without a tools list')
    for (const raw of result.tools) {
      const info = toolInfo(raw)
      if (info && tools.length < MAX_SERVER_TOOLS) tools.push(info)
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined
    if (!cursor || tools.length >= MAX_SERVER_TOOLS) break
  }
  return tools
}

/** The server's tools. Rejects with a message fit to show when it cannot be asked. */
export async function listServerTools(spec: ServerSpec, options: ListOptions = {}): Promise<McpToolInfo[]> {
  if (spec.invalid) throw new Error(spec.invalid)
  if (spec.unapproved) throw new Error('not approved in Claude Code for this project, so Trek does not start it')
  if (spec.transport === 'sse') throw new Error('uses the legacy SSE transport, which Trek does not speak')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`did not answer within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
  })
  let rpc: Rpc | undefined
  try {
    rpc = spec.transport === 'http' ? httpRpc(spec, controller.signal, options.fetch ?? fetch) : stdioRpc(spec, options.env ?? process.env)
    return await Promise.race([exchange(rpc, options.clientVersion ?? '0'), timeout])
  } finally {
    clearTimeout(timer)
    controller.abort()
    await rpc?.close().catch(() => {})
  }
}

function stdioRpc(spec: ServerSpec, baseEnv: Record<string, string | undefined>): Rpc {
  const env = { ...baseEnv, ...(spec.env ?? {}) }
  const child = spawn(commandPath(spec.command!, { env }), spec.args ?? [], hidden({
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    // Its own process group (POSIX), so the close ends whatever it started (npx's node, a uv venv).
    detached: process.platform !== 'win32'
  }))
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>()
  let stderr = ''
  let failure: Error | undefined
  const failAll = (err: Error): void => {
    failure ??= err
    for (const p of pending.values()) p.reject(failure)
    pending.clear()
  }
  child.on('error', (err) => failAll(new Error(`could not start "${spec.command}": ${err.message}`)))
  child.on('exit', (code, signal) => {
    const tail = stderr.trim() ? `: ${stderr.trim().slice(-STDERR_TAIL)}` : ''
    failAll(new Error(`exited (${signal ?? `code ${code}`}) before it answered${tail}`))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL * 2)
  })
  child.stdin.on('error', () => {})
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > MAX_LINE_BYTES) {
      failAll(new Error('wrote a line larger than Trek reads'))
      buffer = ''
      return
    }
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue // a log line on stdout
      }
      if (!isRecord(msg) || typeof msg.id !== 'number') continue // a notification or a request of its own
      const p = pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      if (msg.error !== undefined) p.reject(rpcError(p.method, msg.error))
      else p.resolve(msg.result)
    }
  })
  const write = (msg: unknown): void => {
    if (failure) throw failure
    child.stdin.write(`${JSON.stringify(msg)}\n`)
  }
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure)
        const id = nextId++
        pending.set(id, { resolve, reject, method })
        try {
          write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
        } catch (err) {
          pending.delete(id)
          reject(err as Error)
        }
      }),
    notify: async (method, params) => write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
    close: async () => {
      failAll(new Error('closed'))
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) await killTree(child.pid, { signal: 'SIGTERM' })
    }
  }
}

/** The JSON-RPC reply to `id` in an SSE body, if one is there. */
export function sseReply(body: string, id: number): unknown {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const msg: unknown = JSON.parse(data)
      if (isRecord(msg) && msg.id === id) return msg
    } catch {
      // not JSON: skip it
    }
  }
  return undefined
}

function httpRpc(spec: ServerSpec, signal: AbortSignal, fetchFn: typeof fetch): Rpc {
  let nextId = 1
  let sessionId: string | undefined
  let negotiated: string | undefined
  const post = async (msg: Record<string, unknown>): Promise<Response> => {
    const res = await fetchFn(spec.url!, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        ...(spec.headers ?? {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(negotiated ? { 'mcp-protocol-version': negotiated } : {})
      },
      body: JSON.stringify(msg)
    }).catch((err: unknown) => {
      throw new Error(`could not reach ${spec.url}: ${err instanceof Error ? err.message : String(err)}`)
    })
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {})
      throw new Error('needs a sign-in (Claude Code signs in with OAuth; Trek cannot)')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`answered HTTP ${res.status}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    return res
  }
  return {
    request: async (method, params) => {
      const id = nextId++
      const res = await post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      const body = (await readBodyCapped(res, MAX_REPLY_BYTES, `${method}'s reply`)).toString('utf8')
      const type = res.headers.get('content-type') ?? ''
      let msg: unknown
      if (type.includes('text/event-stream')) msg = sseReply(body, id)
      else {
        try {
          const parsed: unknown = JSON.parse(body)
          msg = Array.isArray(parsed) ? parsed.find((m) => isRecord(m) && m.id === id) : parsed
        } catch {
          throw new Error(`${method} answered with something other than JSON`)
        }
      }
      if (!isRecord(msg)) throw new Error(`${method} got no reply`)
      if (msg.error !== undefined) throw rpcError(method, msg.error)
      if (method === 'initialize' && isRecord(msg.result) && typeof msg.result.protocolVersion === 'string') negotiated = msg.result.protocolVersion
      return msg.result
    },
    notify: async (method, params) => {
      const res = await post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
      await res.body?.cancel().catch(() => {})
    },
    close: async () => {
      if (!sessionId) return
      // Ends the server's session; a server that keeps none answers 405, which is fine.
      await fetchFn(spec.url!, { method: 'DELETE', headers: { ...(spec.headers ?? {}), 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(3000) })
        .then((r) => r.body?.cancel())
        .catch(() => {})
    }
  }
}
