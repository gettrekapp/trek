// Ticket id/URL helpers shared by the desktop app and the server.

/** Linear issue identifiers look like "TOW-123"; Azure DevOps ids are bare numbers. */
export function isLinearTicket(ticketId: string): boolean {
  return /^[A-Z][A-Z0-9]*-\d+$/.test(ticketId)
}

export interface ParsedTicket {
  ticketId: string
  /** Present when the input was a Linear URL */
  linearWorkspace?: string
  /** Present when the input was an Azure DevOps URL */
  azureDevOpsBaseUrl?: string
}

/** Parses a Linear issue id/URL or an Azure DevOps work item id/URL. */
export function parseTicket(input: string): ParsedTicket | null {
  const trimmed = input.trim()
  const linearUrl = trimmed.match(/^https?:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)/i)
  if (linearUrl) return { ticketId: linearUrl[2].toUpperCase(), linearWorkspace: linearUrl[1] }
  const adoUrl = trimmed.match(/^(https?:\/\/.+?)\/_workitems\/edit\/(\d+)/i)
  if (adoUrl) return { ticketId: adoUrl[2], azureDevOpsBaseUrl: adoUrl[1] }
  if (/^[a-z][a-z0-9]*-\d+$/i.test(trimmed)) return { ticketId: trimmed.toUpperCase() }
  if (/^\d+$/.test(trimmed)) return { ticketId: trimmed }
  return null
}

/** Browser URL for a linked ticket, when its workspace/base URL is known. */
export function ticketUrl(
  project: { linearWorkspace?: string; azureDevOpsBaseUrl?: string },
  ticketId: string,
  issue?: { url: string }
): string | null {
  if (isLinearTicket(ticketId)) {
    if (issue) return issue.url
    if (!project.linearWorkspace) return null
    return `https://linear.app/${project.linearWorkspace}/issue/${ticketId}`
  }
  if (!project.azureDevOpsBaseUrl) return null
  return `${project.azureDevOpsBaseUrl.replace(/\/+$/, '')}/_workitems/edit/${ticketId}`
}
