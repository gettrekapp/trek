// The grok plugin's client half (plugins A2): Settings → Plugins lists it; off, Grok is hidden for
// new sessions in the project. Its agent's facts reach the window through server.agents.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { GROK_MANIFEST } from '../manifest.ts'

export const grokClientPlugin = defineClientPlugin({ manifest: GROK_MANIFEST })
