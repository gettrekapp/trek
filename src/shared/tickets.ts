// Core's generic tickets, shared by the desktop app and the server (plugin system phase 2): parsing
// and showing a branch's ticket through the ticket providers on for a project (their trackers'
// plugins: plugins/linear, plugins/azure-devops). No tracker is named here.
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

/** The id a branch name embeds, by the first provider that reads one (the link dialog's suggestion). */
export function ticketFromBranch(providers: readonly TicketProvider[], branch: string): string {
  for (const provider of providers) {
    const id = safely(provider, null, () => provider.fromBranch?.(branch) ?? null)
    if (id) return id
  }
  return ''
}

export interface TicketLinkPlan {
  /** The ticket id to link; null when the input is no tracker's */
  ticketId: string | null
  /** The setting a bare id needs that the project lacks (the dialog shows its field) */
  link?: { key: string; label: string; placeholder: string }
  /** The project settings to write: a pasted URL's, and the link field's */
  settings: Record<string, string>
  /** Why it can't be saved yet, or null */
  problem: string | null
}

/**
 * What the link dialog would save for `input` (and its link field's `linkValue`): the ticket id, the
 * settings to write (only those that differ), and its problem: an input no tracker reads, or a link
 * value its tracker refuses.
 */
export function ticketLinkPlan(
  providers: readonly TicketProvider[],
  settings: Readonly<Record<string, unknown>>,
  input: string,
  linkValue = ''
): TicketLinkPlan {
  const parsed = parseTicketWith(providers, input)
  if (!parsed) {
    const takes = providers.map((p) => p.hint)
    return { ticketId: null, settings: {}, problem: takes.length > 0 ? `Enter ${takes.join(', or ')}.` : 'No ticket tracker is on in this project (Settings → Plugins).' }
  }
  const owner = ticketOwner(providers, parsed.ticketId)
  const writes: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.settings ?? {})) if (value !== settings[key]) writes[key] = value
  const linkSetting = owner?.linkSetting
  const has = (key: string): boolean => !!parsed.settings?.[key] || (typeof settings[key] === 'string' && settings[key] !== '')
  if (!linkSetting || has(linkSetting.key)) return { ticketId: parsed.ticketId, settings: writes, problem: null }
  const link = { key: linkSetting.key, label: linkSetting.label, placeholder: linkSetting.placeholder }
  const value = linkValue.trim()
  if (!value) return { ticketId: parsed.ticketId, link, settings: writes, problem: null }
  const problem = owner ? safely(owner, null, () => linkSetting.check?.(value) ?? null) : null
  if (problem) return { ticketId: parsed.ticketId, link, settings: writes, problem: `${linkSetting.label} ${problem}` }
  return { ticketId: parsed.ticketId, link, settings: { ...writes, [linkSetting.key]: value }, problem: null }
}
