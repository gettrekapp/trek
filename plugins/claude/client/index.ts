// The claude plugin's client half (plugins A2): Settings → Plugins lists it, always on (its
// manifest's `required`: Claude is every server's fallback agent), with its Settings section:
// the project's Claude session mode and the Local agent's models.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'
import { ClaudeSettings } from './ClaudeSettings.tsx'

export const claudeClientPlugin = defineClientPlugin({ manifest: CLAUDE_MANIFEST, slots: { settings: ClaudeSettings } })
