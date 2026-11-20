// Local's models from its endpoint (plugins A1b): Ollama's GET /api/tags or LM Studio's GET
// /v1/models, asked by the server on its own machine for `agents.models`, every client's only
// source of Local's models since plugins A2a. Only the server config's
// `baseUrl` is asked: a client names no URL, a redirect is refused, and the request has a limit.
import { MAX_JSON_BYTES, readBodyCapped } from '../../../src/shared/plugins/server.ts'
import type { AgentConfig, AgentModel } from '../../../src/shared/plugins/agents.ts'
import { localEndpoint, parseLocalModels } from '../shared/local.ts'

export const LOCAL_MODELS_TIMEOUT_MS = 5000

/** The URL as an error may say it: no user name or password, and no query or fragment (a key may sit there) */
function shown(url: URL): string {
  const copy = new URL(url.href)
  copy.username = ''
  copy.password = ''
  copy.search = ''
  copy.hash = ''
  return copy.href
}

/** `timeoutMs`: the limit on the whole request, reply body included (tests shorten it). */
export async function listLocalModels(
  config: AgentConfig,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = LOCAL_MODELS_TIMEOUT_MS
): Promise<AgentModel[]> {
  const { backend, baseUrl } = localEndpoint(config)
  let url: URL
  try {
    url = new URL(`${baseUrl}${backend === 'ollama' ? '/api/tags' : '/v1/models'}`)
  } catch {
    throw new Error("the server config's local baseUrl is not a URL")
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error("the server config's local baseUrl is not an http(s) URL")
  const timeout = AbortSignal.timeout(timeoutMs)
  const tooSlow = (): Error => new Error(`${shown(url)} did not answer within ${timeoutMs / 1000} s`)
  let res: Response
  try {
    res = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
  } catch (err) {
    if (timeout.aborted) throw tooSlow()
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code
    throw new Error(`${shown(url)} could not be reached${typeof cause === 'string' ? ` (${cause})` : ''}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${shown(url)} returned ${res.status}`)
  }
  let body: Buffer
  try {
    body = await readBodyCapped(res, MAX_JSON_BYTES, "the local model server's reply")
  } catch (err) {
    // The limit covers the body too: a reply that stalls part-way reads as the same timeout.
    if (timeout.aborted) throw tooSlow()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(`${shown(url)} did not answer with JSON`)
  }
  return parseLocalModels(backend, parsed)
}
