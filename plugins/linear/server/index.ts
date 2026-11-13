// The Linear plugin's server half (plugin system phase 2; phase 5b's linear.*): the server's API
// key, issue lookups, its tickets (set_worktree_ticket) and its workspace setting's check. Wire
// names unchanged: `linear.status`, `linear.setKey`, `linear.clearKey`, `linear.issues`.
import { defineServerPlugin, optionalFlag, pluginError, requireApiKey, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { LINEAR_MANIFEST } from '../manifest.ts'
import { WORKSPACE_SETTING, linearTickets, workspaceProblem } from '../shared/ticket.ts'
import { createLinearService } from './linearService.ts'

const MAX_IDS = 500
const MAX_ID = 64

function requireIssueIds(value: unknown): string[] {
  const bad = (message: string): Error => pluginError('BAD_REQUEST', message)
  if (!Array.isArray(value)) throw bad('ids must be an array of strings')
  if (value.length > MAX_IDS) throw bad(`ids: at most ${MAX_IDS}`)
  for (const id of value) if (typeof id !== 'string' || id.length > MAX_ID) throw bad(`ids must be strings of at most ${MAX_ID} characters`)
  return value as string[]
}

export function setupLinear(host: ServerPluginHost, options: { fetch?: typeof fetch } = {}) {
  const linear = createLinearService({ key: host.secret('linear'), endpoint: host.testEndpoint('TREK_SERVER_LINEAR_URL'), fetch: options.fetch })
  return {
    handlers: {
      status: () => ({ hasKey: linear.hasKey() }),
      // Linear's own refusal is `{ ok: false }` (nothing changed); the secrets file failing throws.
      setKey: async (p: Record<string, unknown>) => {
        const apiKey = requireApiKey(p.apiKey)
        const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
        const result = await linear.setKey(apiKey, { ifAbsent })
        if (result.ok) host.changed()
        return result
      },
      clearKey: () => {
        linear.clearKey()
        host.changed()
        return null
      },
      issues: (p: Record<string, unknown>) => linear.issues(requireIssueIds(p.ids))
    },
    ticketProvider: linearTickets,
    checkProjectSetting: (key: string, value: string) => (key === WORKSPACE_SETTING ? workspaceProblem(value) : null)
  }
}

export const linearServerPlugin = defineServerPlugin({
  manifest: LINEAR_MANIFEST,
  setup: (host) => setupLinear(host)
})
