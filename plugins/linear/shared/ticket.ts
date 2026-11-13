// Linear issues as tickets: an identifier (`TOW-123`) or `https://linear.app/<workspace>/issue/<ID>…`
// (the workspace slug, `linearWorkspace`, which a bare id's link needs).
import { defineTicketProvider } from '../../../src/shared/plugins/tickets.ts'

export const WORKSPACE_SETTING = 'linearWorkspace'
/** A Linear issue identifier, as stored on a branch. */
export const LINEAR_ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
/** The longest workspace slug taken. */
export const MAX_WORKSPACE = 200

/** A workspace slug: letters, digits, `_` and `-`, at most 200 characters. */
export function workspaceProblem(slug: string): string | null {
  return /^[\w-]+$/.test(slug) && slug.length <= MAX_WORKSPACE ? null : `must be a Linear workspace slug (letters, digits, _ and -; at most ${MAX_WORKSPACE})`
}

export const linearTickets = defineTicketProvider({
  id: 'linear',
  hint: 'a Linear issue id (TOW-123) or issue URL',
  owns: (ticketId) => LINEAR_ISSUE_ID.test(ticketId),
  parse: (input) => {
    const url = input.match(/^https?:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)/i)
    if (url) return workspaceProblem(url[1]) ? null : { ticketId: url[2].toUpperCase(), settings: { [WORKSPACE_SETTING]: url[1] } }
    return /^[a-z][a-z0-9]*-\d+$/i.test(input) ? { ticketId: input.toUpperCase() } : null
  },
  label: (ticketId) => ticketId,
  // Linear's default branch names embed the issue id: "garrett/tow-123-fix-login".
  fromBranch: (branch) => branch.match(/(?:^|\/)([a-z][a-z0-9]*-\d+)(?:-|$)/i)?.[1].toUpperCase() ?? null,
  url: (settings, ticketId, info) => {
    if (info?.url) return info.url
    const workspace = settings[WORKSPACE_SETTING]
    return typeof workspace === 'string' && workspace ? `https://linear.app/${workspace}/issue/${ticketId}` : null
  },
  linkSetting: { key: WORKSPACE_SETTING, label: 'Linear workspace', placeholder: 'Linear workspace, e.g. trek (from linear.app/trek/…)', check: workspaceProblem }
})
