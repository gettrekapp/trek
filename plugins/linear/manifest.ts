// The Linear plugin: issue ids and URLs as branch tickets, and their live status with the server's key.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const LINEAR_MANIFEST: PluginManifest = {
  id: 'linear',
  version: '1.0.0',
  name: 'Linear',
  description: "Link worktree branches to Linear issues by id or URL; with the server's API key, the ticket chips show each issue's status and title.",
  defaultEnabled: true,
  // 0.2.x clients show Linear on this capability and hear `integrations.changed { linear }`.
  legacyCapability: 'linear',
  secrets: ['linear'],
  projectSettings: { linearWorkspace: 'string' }
}
