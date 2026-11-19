// A branch's pull request on the phone (plugins P3): the PR providers on for the project (the
// plugins' pure shared code, as the desktop's), and what the user types for one. Pure.
import { GITHUB_MANIFEST, githubPrs, type PluginManifest, type PrProvider, type ProjectSettings } from '../shared.ts'
import { pluginOn, type TicketServer } from './tickets.ts'

/** The hosts the phone knows, in the desktop's built-in order (plugins/builtin.client.ts). */
const HOSTS: ReadonlyArray<{ manifest: PluginManifest; provider: PrProvider }> = [{ manifest: GITHUB_MANIFEST, provider: githubPrs }]

/** The PR providers on for the project; none before the server's welcome. */
export function activePrProviders(server: TicketServer | null | undefined, settings: ProjectSettings): PrProvider[] {
  if (!server) return []
  return HOSTS.filter((h) => pluginOn(h.manifest, server, settings)).map((h) => h.provider)
}
