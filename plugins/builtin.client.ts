// The plugins built into the Trek app and the web client (plugin system phase 1), in Settings
// order: the server's order (builtin.server.ts). The only place core imports a plugin's client half
// (scripts/pluginBoundaries.test.mjs).
import type { ClientPlugin } from '../src/shared/plugins/client.ts'
import { voiceClientPlugin } from './voice/client/index.tsx'
import { linearClientPlugin } from './linear/client/index.tsx'
import { azureDevOpsClientPlugin } from './azure-devops/client/index.ts'
import { githubClientPlugin } from './github/client/index.ts'
import { colimaClientPlugin } from './colima/client/index.tsx'
import { campsiteClientPlugin } from './campsite/client/index.tsx'

export const BUILTIN_CLIENT_PLUGINS: readonly ClientPlugin[] = [voiceClientPlugin, linearClientPlugin, azureDevOpsClientPlugin, githubClientPlugin, colimaClientPlugin, campsiteClientPlugin]
