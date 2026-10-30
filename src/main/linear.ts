import { ipcMain } from 'electron'
import { createSecretStore } from './secrets'
import type { LinearIssue, LinearKeyResult } from '../shared/types'

const ENDPOINT = 'https://api.linear.app/graphql'
const API_KEY = 'apiKey'
const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
/** Linear caps query complexity, so large lookups are split into batches. */
const BATCH_SIZE = 50

/** The personal API key never leaves the main process. */
const secrets = createSecretStore('linear.json')

interface GraphQLResponse<T> {
  data?: T | null
  errors?: { message: string }[]
}

async function graphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphQLResponse<T>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000)
  })
  if (res.status === 401) throw new Error('Linear rejected the API key')
  if (!res.ok && res.status !== 400) throw new Error(`Linear API returned ${res.status}`)
  return (await res.json()) as GraphQLResponse<T>
}

interface RawIssue {
  identifier: string
  title: string
  url: string
  state: { name: string; type: string; color: string }
}

async function fetchBatch(apiKey: string, ids: string[]): Promise<LinearIssue[]> {
  // One aliased field per issue; a missing issue only nulls its own alias.
  const params = ids.map((_, i) => `$i${i}: String!`).join(', ')
  const fields = ids
    .map((_, i) => `i${i}: issue(id: $i${i}) { identifier title url state { name type color } }`)
    .join('\n')
  const variables = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
  const { data } = await graphql<Record<string, RawIssue | null>>(
    apiKey,
    `query (${params}) {\n${fields}\n}`,
    variables
  )
  return Object.values(data ?? {})
    .filter((issue): issue is RawIssue => !!issue)
    .map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      status: issue.state.name,
      statusType: issue.state.type,
      statusColor: issue.state.color
    }))
}

/** Issues that exist and are visible to the key; unknown ids are left out. */
async function fetchIssues(ids: string[]): Promise<LinearIssue[]> {
  const apiKey = await secrets.get(API_KEY)
  if (!apiKey) return []
  const valid = [...new Set(ids.filter((id) => ISSUE_ID.test(id)))]
  const batches: string[][] = []
  for (let i = 0; i < valid.length; i += BATCH_SIZE) batches.push(valid.slice(i, i + BATCH_SIZE))
  return (await Promise.all(batches.map((b) => fetchBatch(apiKey, b)))).flat()
}

/** Validates a key against Linear before storing it. */
async function setApiKey(apiKey: string): Promise<LinearKeyResult> {
  try {
    const { data, errors } = await graphql<{ viewer: { name: string } }>(
      apiKey,
      'query { viewer { name } }'
    )
    if (!data?.viewer) return { ok: false, error: errors?.[0]?.message ?? 'Invalid API key' }
    await secrets.set(API_KEY, apiKey)
    return { ok: true, user: data.viewer.name }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerLinearHandlers(): void {
  ipcMain.handle('linear:hasApiKey', async (): Promise<boolean> => !!(await secrets.get(API_KEY)))
  ipcMain.handle('linear:setApiKey', (_event, apiKey: string) => setApiKey(apiKey.trim()))
  ipcMain.handle('linear:clearApiKey', () => secrets.set(API_KEY, null))
  ipcMain.handle('linear:fetchIssues', (_event, ids: string[]) => fetchIssues(ids))
}
