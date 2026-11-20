// The claude plugin's client half (plugins A2): Settings → Plugins lists it, always on (its manifest's
// `required`: Claude is every server's fallback agent). Its Settings section (Claude's session mode,
// Local's models) comes in plugins A2b.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'

export const claudeClientPlugin = defineClientPlugin({ manifest: CLAUDE_MANIFEST })
