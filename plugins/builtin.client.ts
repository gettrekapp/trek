// The plugins built into the Trek app and the web client (plugin system phase 1), in Settings
// order. The only place core imports a plugin's client half (scripts/pluginBoundaries.test.mjs).
import type { ClientPlugin } from '../src/shared/plugins/client.ts'
import { voiceClientPlugin } from './voice/client/index.tsx'

export const BUILTIN_CLIENT_PLUGINS: readonly ClientPlugin[] = [voiceClientPlugin]
