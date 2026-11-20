// Local's models from its endpoint (plugins A1b): Ollama's GET /api/tags or LM Studio's GET
// /v1/models, asked by the server on its own machine for `agents.models`. (The desktop's
// llm:fetchModels does the same for its own settings until plugins A2.) Only the server config's
// `baseUrl` is asked: a client names no URL, a redirect is refused, and the request has a limit.
import { MAX_JSON_BYTES, readBodyCapped } from '../../../src/shared/plugins/server.ts'
import type { AgentConfig, AgentModel } from '../../../src/shared/plugins/agents.ts'
import { localEndpoint, parseLocalModels } from '../shared/local.ts'

export const LOCAL_MODELS_TIMEOUT_MS = 5000

/** The URL as an error may say it: no user name or password */
function shown(url: URL): string {
  const copy = new URL(url.href)
  copy.username = ''
  copy.password = ''
  return copy.href
}

export async function listLocalModels(config: AgentConfig, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<AgentModel[]> {
  const { backend, baseUrl } = localEndpoint(config)
  let url: URL
  try {
    url = new URL(`${baseUrl}${backend === 'ollama' ? '/api/tags' : '/v1/models'}`)
  } catch {
    throw new Error("the server config's local baseUrl is not a URL")
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error("the server config's local baseUrl is not an http(s) URL")
  const timeout = AbortSignal.timeout(LOCAL_MODELS_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
  } catch (err) {
    const timedOut = timeout.aborted
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code
    throw new Error(`${shown(url)} ${timedOut ? `did not answer within ${LOCAL_MODELS_TIMEOUT_MS / 1000} s` : `could not be reached${typeof cause === 'string' ? ` (${cause})` : ''}`}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${shown(url)} returned ${res.status}`)
  }
  const body = await readBodyCapped(res, MAX_JSON_BYTES, "the local model server's reply")
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(`${shown(url)} did not answer with JSON`)
  }
  return parseLocalModels(backend, parsed)
}
