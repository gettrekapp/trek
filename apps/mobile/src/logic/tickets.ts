// A branch's ticket on the phone: its label and link, and what the user types for one, through
// the ticket providers of the trackers on for the project (Linear, Azure DevOps: the plugins' pure
// shared code) and core's generic tickets (src/shared/tickets.ts), as the desktop does. Looked-up
// issue titles and statuses are not fetched, and the phone never writes the project settings a
// pasted URL implies (the desktop's ticket dialog does). Pure.
import {
  AZURE_DEVOPS_MANIFEST,
  azureDevOpsTickets,
  LINEAR_MANIFEST,
  linearTickets,
  pluginEnabled,
  providerTicketView,
  ticketLinkPlan,
  type PluginManifest,
  type PluginPresence,
  type ProjectSettings,
  type TicketProvider
} from '../shared.ts'

/** The server welcome's part this needs: its plugin list (absent from a server older than plugins). */
export interface TicketServer {
  plugins?: readonly PluginPresence[]
  capabilities?: readonly string[]
}

/** The trackers the phone knows, in the desktop's built-in order (plugins/builtin.client.ts). */
const TRACKERS: ReadonlyArray<{ manifest: PluginManifest; provider: TicketProvider }> = [
  { manifest: LINEAR_MANIFEST, provider: linearTickets },
  { manifest: AZURE_DEVOPS_MANIFEST, provider: azureDevOpsTickets }
]

/**
 * Whether a plugin is on for the project, as the desktop's pluginStatus and pluginActive decide
 * (src/renderer/src/plugins/presence.ts):
 * - a server that lists its plugins: this one is listed, and enabled by the project's `plugins`
 *   setting or, with none, the server's default for it (not the manifest's);
 * - a server older than plugins (no list): it has the plugin's legacy capability, or had it built
 *   in (`legacyBuiltIn`); always on there, whatever the project's setting.
 */
function pluginOn(manifest: PluginManifest, server: TicketServer, settings: ProjectSettings): boolean {
  if (!server.plugins) {
    const capability = !!manifest.legacyCapability && server.capabilities?.includes(manifest.legacyCapability) === true
    return capability || manifest.legacyBuiltIn === true
  }
  const listed = server.plugins.find((p) => p.id === manifest.id)
  return !!listed && pluginEnabled(settings.plugins, { id: manifest.id, defaultEnabled: listed.defaultEnabled })
}

/** The ticket providers on for the project; none before the server's welcome. */
export function activeTicketProviders(server: TicketServer | null | undefined, settings: ProjectSettings): TicketProvider[] {
  if (!server) return []
  return TRACKERS.filter((t) => pluginOn(t.manifest, server, settings)).map((t) => t.provider)
}

export interface TicketView {
  label: string
  /** Its browser link, or null when it can't be built */
  url: string | null
}

/** The plugins' settings sit at the top of the project's (`linearWorkspace`), read by name. */
const byName = (settings: ProjectSettings): Readonly<Record<string, unknown>> => settings as unknown as Readonly<Record<string, unknown>>

/** A stored ticket id's label and link; with no provider owning it, the id itself and no link. */
export function ticketView(providers: readonly TicketProvider[], settings: ProjectSettings, ticketId: string): TicketView {
  const { label, url } = providerTicketView(providers, byName(settings), ticketId)
  return { label, url }
}

/**
 * What the user typed or pasted → the ticket id to store, or why not: the desktop's ticket dialog
 * rule (ticketLinkPlan), which refuses what no provider on for the project reads, saying what they
 * take. The settings a URL implies are dropped: its ticket links only if the project has them.
 * With no tracker on, nothing is read: the phone says where one is turned on (not on the phone).
 */
export function parseTicketInput(providers: readonly TicketProvider[], input: string): { ticketId: string } | { error: string } {
  if (providers.length === 0) return { error: "No ticket tracker is on in this project. Turn one on in the desktop app's Settings → Plugins." }
  const plan = ticketLinkPlan(providers, {}, input)
  return plan.ticketId && !plan.problem ? { ticketId: plan.ticketId } : { error: plan.problem ?? 'Enter a ticket id or URL.' }
}
