// The ticket trackers a project window uses (plugin system phase 2): the ticket providers of the
// plugins active there (on for the project, or built into an older server), in built-in order.
// Pure: imported by tests.
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import type { ProjectPluginSettings } from '../../../shared/plugins/manifest.ts'
import type { TicketInfo, TicketProvider } from '../../../shared/plugins/tickets.ts'
import { ticketView, type TicketView } from '../../../shared/tickets.ts'
import type { TicketInfoStore } from './ticketInfo.ts'
import { pluginActive, pluginStatus, type PluginWelcome } from './presence.ts'

/** Plugins already warned about a provider whose id is not theirs. */
const warnedIds = new Set<string>()

/**
 * The providers of the plugins active in the window; none before its welcome and its project's
 * settings. A provider whose id is not its plugin's is left out (warned once).
 */
export function activeTicketProviders(
  plugins: readonly ClientPlugin[],
  welcome: PluginWelcome | undefined,
  settings: ProjectPluginSettings | undefined
): TicketProvider[] {
  return plugins.flatMap((p) => {
    const provider = p.ticketProvider
    if (!provider || !pluginActive(pluginStatus(p.manifest, welcome, settings))) return []
    if (provider.id !== p.manifest.id) {
      if (!warnedIds.has(p.manifest.id)) {
        warnedIds.add(p.manifest.id)
        console.warn(`[tickets] plugin ${p.manifest.id}'s ticket provider has the id ${JSON.stringify(provider.id)}: left out`)
      }
      return []
    }
    return [provider]
  })
}

/** CSS color keywords, hex colors, and rgb()/rgba()/hsl()/hsla() of numbers only. */
const SAFE_COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([0-9.,% ]*\)|[a-z]+)$/i

/** A plugin's status color if it is a plain CSS color (a chip's dot); undefined otherwise. */
export function safeStatusColor(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_COLOR_RE.test(value) ? value : undefined
}

/** A branch ticket's view in a window: its providers, the project's settings, the plugins' looked-up issues for this backend. */
export function windowTicketView(
  providers: readonly TicketProvider[],
  settings: Readonly<Record<string, unknown>>,
  ticketId: string,
  info: TicketInfoStore,
  backend: object
): TicketView {
  return ticketView(providers, settings, ticketId, (providerId, id): TicketInfo | undefined => info.get(backend, providerId, id))
}
