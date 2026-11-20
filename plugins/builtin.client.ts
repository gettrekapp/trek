// The plugins built into the Trek app and the web client (plugin system phase 1), in Settings
// order: the server's order (builtin.server.ts). The only place core imports a plugin's client half
// (scripts/pluginBoundaries.test.mjs).
import type { ClientPlugin } from '../src/shared/plugins/client.ts'
import { claudeClientPlugin } from './claude/client/index.ts'
import { codexClientPlugin } from './codex/client/index.ts'
import { geminiClientPlugin } from './gemini/client/index.ts'
import { grokClientPlugin } from './grok/client/index.ts'
import { voiceClientPlugin } from './voice/client/index.tsx'
import { linearClientPlugin } from './linear/client/index.tsx'
import { azureDevOpsClientPlugin } from './azure-devops/client/index.ts'
import { githubClientPlugin } from './github/client/index.ts'
import { colimaClientPlugin } from './colima/client/index.tsx'
import { campsiteClientPlugin } from './campsite/client/index.tsx'

// The agents first (plugins A2), as the server registers them (builtin.server.ts).
export const BUILTIN_CLIENT_PLUGINS: readonly ClientPlugin[] = [
  claudeClientPlugin,
  codexClientPlugin,
  geminiClientPlugin,
  grokClientPlugin,
  voiceClientPlugin,
  linearClientPlugin,
  azureDevOpsClientPlugin,
  githubClientPlugin,
  colimaClientPlugin,
  campsiteClientPlugin
]
