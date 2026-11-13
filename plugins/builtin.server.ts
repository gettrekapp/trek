// The plugins built into trek-server (plugin system phase 1), in Settings order. The only place
// core imports a plugin's server half (scripts/pluginBoundaries.test.mjs).
import type { ServerPlugin } from '../src/shared/plugins/server.ts'
import { voiceServerPlugin } from './voice/server/index.ts'
import { azureDevOpsServerPlugin } from './azure-devops/server/index.ts'

export const BUILTIN_SERVER_PLUGINS: readonly ServerPlugin[] = [voiceServerPlugin, azureDevOpsServerPlugin]
