// The codex plugin's client half (plugins A2): Settings → Plugins lists it; off, Codex is hidden for
// new sessions in the project. Its agent's facts reach the window through server.agents.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { CODEX_MANIFEST } from '../manifest.ts'

export const codexClientPlugin = defineClientPlugin({ manifest: CODEX_MANIFEST })
