// Linear's ticket lookups with the server's API key (phase 5b; the Linear plugin's since plugin
// system phase 2). The key is in a slot the host owns (the server's secrets file), and the endpoint
// can be pointed elsewhere (a test's stub server).
import type { LinearIssue, LinearKeyResult } from '../shared/types.ts'
import { LINEAR_ISSUE_ID } from '../shared/ticket.ts'
import { MAX_JSON_BYTES, PRESENT_ERROR, readBodyCapped, type KeySlot } from '../../../src/shared/plugins/server.ts'

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
/** Linear caps query complexity, so large lookups are split into batches. */
const BATCH_SIZE = 50
const TIMEOUT_MS = 15_000

export interface LinearService {
  hasKey(): boolean
  /**
   * Checks the key with Linear, then stores it. `ifAbsent` (the app's hand-over): stored as it is,
   * without asking Linear (the app checked it when the user entered it, and the hand-over must not
   * depend on Linear being reachable), only while no key is stored; else `{ ok: false, present: true }`
   * and nothing changes. Its `user` is then empty. `{ ok: false, error }` is only Linear's answer
   * (or Linear unreachable); a key slot that cannot be read or written throws, before any request
   * when it cannot be read.
   */
  setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<LinearKeyResult>
  clearKey(): void
  /** The issues that exist and the key can see; unknown ids are left out, and none without a key. */
  issues(ids: string[]): Promise<LinearIssue[]>
}

interface GraphQLResponse<T> {
  data?: T | null
  errors?: { message: string }[]
}

interface RawIssue {
  identifier: string
  title: string
  url: string
  state: { name: string; type: string; color: string }
}


export function createLinearService(options: { key: KeySlot; endpoint?: string; fetch?: typeof fetch }): LinearService {
  const endpoint = options.endpoint ?? LINEAR_ENDPOINT
  const doFetch = options.fetch ?? fetch

  async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse<T>> {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 401) throw new Error('Linear rejected the API key')
    if (!res.ok && res.status !== 400) throw new Error(`Linear API returned ${res.status}`)
    const body = await readBodyCapped(res, MAX_JSON_BYTES, "Linear's reply")
    try {
      return JSON.parse(body.toString('utf8')) as GraphQLResponse<T>
    } catch {
      // A proxy's HTML error page, say: report the status, not a JSON parse error.
      throw new Error(res.ok ? "Linear's reply is not JSON" : `Linear API returned ${res.status}`)
    }
  }

  async function fetchBatch(apiKey: string, ids: string[]): Promise<LinearIssue[]> {
    // One aliased field per issue; a missing issue only nulls its own alias.
    const params = ids.map((_, i) => `$i${i}: String!`).join(', ')
    const fields = ids.map((_, i) => `i${i}: issue(id: $i${i}) { identifier title url state { name type color } }`).join('\n')
    const variables = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
    const { data } = await graphql<Record<string, RawIssue | null>>(apiKey, `query (${params}) {\n${fields}\n}`, variables)
    return Object.values(data ?? {})
      .filter((issue): issue is RawIssue => !!issue && typeof issue === 'object' && !!issue.state)
      .map((issue) => ({
        identifier: String(issue.identifier),
        title: String(issue.title),
        url: String(issue.url),
        status: String(issue.state.name),
        statusType: String(issue.state.type),
        statusColor: String(issue.state.color)
      }))
  }

  return {
    hasKey: () => !!options.key.get(),

    async setKey(apiKey, { ifAbsent = false } = {}) {
      if (ifAbsent) return options.key.setIfAbsent(apiKey) ? { ok: true, user: '' } : { ok: false, error: PRESENT_ERROR, present: true }
      // An unreadable secrets file fails here, before Linear sees the key.
      options.key.get()
      let viewer: { name: string }
      try {
        const { data, errors } = await graphql<{ viewer: { name: string } }>(apiKey, 'query { viewer { name } }')
        if (!data?.viewer) return { ok: false, error: errors?.[0]?.message ?? 'Invalid API key' }
        viewer = data.viewer
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Outside the try: a failed write is the server's error, not a rejected key.
      options.key.set(apiKey)
      return { ok: true, user: String(viewer.name) }
    },

    clearKey: () => options.key.set(null),

    async issues(ids) {
      const apiKey = options.key.get()
      if (!apiKey) return []
      const valid = [...new Set(ids.filter((id) => LINEAR_ISSUE_ID.test(id)))]
      const batches: string[][] = []
      for (let i = 0; i < valid.length; i += BATCH_SIZE) batches.push(valid.slice(i, i + BATCH_SIZE))
      return (await Promise.all(batches.map((b) => fetchBatch(apiKey, b)))).flat()
    }
  }
}
