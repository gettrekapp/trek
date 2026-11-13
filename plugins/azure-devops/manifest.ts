// The Azure DevOps plugin: work item ids and URLs as branch tickets (plugin system phase 2).
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const AZURE_DEVOPS_MANIFEST: PluginManifest = {
  id: 'azure-devops',
  version: '1.0.0',
  name: 'Azure DevOps',
  description: 'Link worktree branches to Azure DevOps work items by id or URL; the ticket chip opens the work item.',
  defaultEnabled: true,
  // A server older than plugins handled Azure DevOps tickets itself, with no capability saying so.
  legacyBuiltIn: true,
  projectSettings: { azureDevOpsBaseUrl: 'string' }
}
