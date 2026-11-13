// The ticket trackers a project window uses (plugin system phase 2): the ticket providers of the
// plugins active there (on for the project, or built into an older server), in built-in order.
// Pure: imported by tests.
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import type { ProjectPluginSettings } from '../../../shared/plugins/manifest.ts'
import type { TicketInfo, TicketProvider } from '../../../shared/plugins/tickets.ts'
import { ticketView, type TicketView } from '../../../shared/tickets.ts'
import type { TicketInfoStore } from './ticketInfo.ts'
import { pluginActive, pluginStatus, type PluginWelcome } from './presence.ts'

/** The providers of the plugins active in the window; none before its welcome and its project's settings. */
export function activeTicketProviders(
  plugins: readonly ClientPlugin[],
  welcome: PluginWelcome | undefined,
  settings: ProjectPluginSettings | undefined
): TicketProvider[] {
  return plugins.flatMap((p) => (p.ticketProvider && pluginActive(pluginStatus(p.manifest, welcome, settings)) ? [p.ticketProvider] : []))
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
