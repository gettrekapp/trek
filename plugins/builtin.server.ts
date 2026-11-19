// The plugins built into trek-server (plugin system phase 1), in Settings order. The only place
// core imports a plugin's server half (scripts/pluginBoundaries.test.mjs).
import type { ServerPlugin } from '../src/shared/plugins/server.ts'
import { claudeServerPlugin } from './claude/server/index.ts'
import { codexServerPlugin } from './codex/server/index.ts'
import { geminiServerPlugin } from './gemini/server/index.ts'
import { grokServerPlugin } from './grok/server/index.ts'
import { voiceServerPlugin } from './voice/server/index.ts'
import { linearServerPlugin } from './linear/server/index.ts'
import { azureDevOpsServerPlugin } from './azure-devops/server/index.ts'
import { githubServerPlugin } from './github/server/index.ts'
import { colimaServerPlugin } from './colima/server/index.ts'
import { campsiteServerPlugin } from './campsite/server/index.ts'

export const BUILTIN_SERVER_PLUGINS: readonly ServerPlugin[] = [
  // The agents (plugins A1) first: the claude plugin's Claude is every server's fallback agent.
  claudeServerPlugin,
  codexServerPlugin,
  geminiServerPlugin,
  grokServerPlugin,
  voiceServerPlugin,
  linearServerPlugin,
  azureDevOpsServerPlugin,
  githubServerPlugin,
  colimaServerPlugin,
  campsiteServerPlugin
]
