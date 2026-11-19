// The Colima environments plugin's server half (plugins E2): one Colima VM per worktree's branch,
// with docker compose inside it, on the server's machine (macOS and Linux). Wire names unchanged
// from core's: env.*, event env.log. Before E2 these were core's own Colima and environment services
// (removed in E2) and the env half of the server's machine handlers.
import { dirname } from 'node:path'
import { defineServerPlugin, type PluginInstance, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { COLIMA_MANIFEST } from '../manifest.ts'
import { REGISTRY_FILE, prepareRegistry } from './data.ts'
import { colimaHandlers } from './handlers.ts'
import { colimaLifecycle } from './lifecycle.ts'
import { createEnvironmentService } from './service.ts'
import { createTools } from './tools.ts'

export interface ColimaOptions {
  /** Colima's home (its VMs mount only it, so the worktrees must be under it). Default: the server user's home. For tests. */
  home?: string
}

export function setupColima(host: ServerPluginHost, options: ColimaOptions = {}): PluginInstance {
  // colima runs in the plugin's data directory (host.spawn needs a cwd); one that can't be made fails the setup.
  const dataDir = dirname(host.dataFile(REGISTRY_FILE))
  const env = createEnvironmentService({
    registryFile: prepareRegistry(host),
    tools: createTools(host, dataDir),
    ...(options.home !== undefined ? { home: options.home } : {}),
    // A Local server's siblings' registries, read only: a VM one of them names is not an orphan here.
    otherRegistryFiles: () => host.legacySiblingDataFiles(REGISTRY_FILE)
  })
  return { handlers: colimaHandlers(host, env), worktreeLifecycle: colimaLifecycle(host, env) }
}

export const colimaServerPlugin = defineServerPlugin({ manifest: COLIMA_MANIFEST, setup: (host) => setupColima(host) })
