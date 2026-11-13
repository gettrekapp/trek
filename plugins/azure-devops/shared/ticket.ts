// Azure DevOps work items as tickets: a bare number, or `<base>/_workitems/edit/<n>` (the project's
// org/project URL, `azureDevOpsBaseUrl`, which the link needs).
import { defineTicketProvider } from '../../../src/shared/plugins/tickets.ts'

export const BASE_URL_SETTING = 'azureDevOpsBaseUrl'
/** The longest base URL taken. */
export const MAX_BASE_URL = 200

/** An http(s) URL of a sensible length. */
export function baseUrlProblem(base: string): string | null {
  if (base.length > MAX_BASE_URL) return `must be at most ${MAX_BASE_URL} characters`
  try {
    const { protocol } = new URL(base)
    return protocol === 'http:' || protocol === 'https:' ? null : 'must be an http(s) URL'
  } catch {
    return 'must be an http(s) URL'
  }
}

export const azureDevOpsTickets = defineTicketProvider({
  id: 'azure-devops',
  hint: 'an Azure DevOps work item id or URL',
  owns: (ticketId) => /^\d+$/.test(ticketId),
  parse: (input) => {
    const url = input.match(/^(https?:\/\/.+?)\/_workitems\/edit\/(\d+)/i)
    if (url) return baseUrlProblem(url[1]) ? null : { ticketId: url[2], settings: { [BASE_URL_SETTING]: url[1] } }
    return /^\d+$/.test(input) ? { ticketId: input } : null
  },
  label: (ticketId) => `#${ticketId}`,
  url: (settings, ticketId) => {
    const base = settings[BASE_URL_SETTING]
    return typeof base === 'string' && base ? `${base.replace(/\/+$/, '')}/_workitems/edit/${ticketId}` : null
  },
  linkSetting: { key: BASE_URL_SETTING, label: 'Azure DevOps project URL', placeholder: 'https://dev.azure.com/org/Project', check: baseUrlProblem }
})
