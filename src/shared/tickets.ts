// Ticket id/URL helpers shared by the desktop app and the server. The generic ones (parseTicketWith,
// ticketView) go through the ticket providers on for a project (plugin system phase 2).
import type { ParsedTicketInput, TicketInfo, TicketProvider } from './plugins/tickets.ts'

/** A provider call that throws counts as no match (logged once per provider). */
const warned = new Set<string>()
function safely<T>(provider: TicketProvider, fallback: T, call: () => T): T {
  try {
    return call()
  } catch (err) {
    if (!warned.has(provider.id)) {
      warned.add(provider.id)
      console.warn(`[tickets] provider ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return fallback
  }
}

/** The first provider (in order) that reads `input` as its ticket, with what it read; null when none does. */
export function parseTicketWith(providers: readonly TicketProvider[], input: string): (ParsedTicketInput & { providerId: string }) | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  for (const provider of providers) {
    const parsed = safely(provider, null, () => provider.parse(trimmed))
    if (parsed) return { ...parsed, providerId: provider.id }
  }
  return null
}

/** The provider that owns a stored ticket id, if one of these does. */
export function ticketOwner(providers: readonly TicketProvider[], ticketId: string): TicketProvider | undefined {
  return providers.find((p) => safely(p, false, () => p.owns(ticketId)))
}

export interface TicketView {
  label: string
  /** Null when it can't be built (a setting missing) or no provider owns the ticket */
  url: string | null
  /** The owning provider's id; undefined when none of the project's providers owns it */
  providerId?: string
  /** The owning provider's looked-up issue, if any */
  info?: TicketInfo
}

/** How a branch's ticket shows: its owner's label and link, and its looked-up issue. */
export function ticketView(
  providers: readonly TicketProvider[],
  settings: Readonly<Record<string, unknown>>,
  ticketId: string,
  infoFor: (providerId: string, ticketId: string) => TicketInfo | undefined = () => undefined
): TicketView {
  const owner = ticketOwner(providers, ticketId)
  if (!owner) return { label: ticketId, url: null }
  const info = infoFor(owner.id, ticketId)
  return {
    label: safely(owner, ticketId, () => owner.label(ticketId)),
    url: safely(owner, null, () => owner.url(settings, ticketId, info)),
    providerId: owner.id,
    ...(info ? { info } : {})
  }
}


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

const MAX_BASE = 200

/** An http(s) URL of a sensible length. */
function validBase(base: string): boolean {
  if (base.length > MAX_BASE) return false
  try {
    const { protocol } = new URL(base)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Parses a Linear issue id/URL or an Azure DevOps work item id/URL. */
export function parseTicket(input: string): ParsedTicket | null {
  const trimmed = input.trim()
  const linearUrl = trimmed.match(/^https?:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)/i)
  if (linearUrl && /^[\w-]+$/.test(linearUrl[1]) && linearUrl[1].length <= MAX_BASE) return { ticketId: linearUrl[2].toUpperCase(), linearWorkspace: linearUrl[1] }
  const adoUrl = trimmed.match(/^(https?:\/\/.+?)\/_workitems\/edit\/(\d+)/i)
  if (adoUrl && validBase(adoUrl[1])) return { ticketId: adoUrl[2], azureDevOpsBaseUrl: adoUrl[1] }
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
