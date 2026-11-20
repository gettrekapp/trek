// The gemini plugin's client half (plugins A2): Settings → Plugins lists it; off, Gemini is hidden for
// new sessions in the project. Its agent's facts reach the window through server.agents.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { GEMINI_MANIFEST } from '../manifest.ts'

export const geminiClientPlugin = defineClientPlugin({ manifest: GEMINI_MANIFEST })
