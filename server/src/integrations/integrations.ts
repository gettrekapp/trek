// The server's integrations with outside services (phase 5b): Linear and ElevenLabs, each with the
// server's own key in its secrets file. Made once per server (index.ts) and handed to the handlers
// through V2Context, and to the speak_summary tool and the sessions' launch.
import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
import { createVoiceService, type VoiceService } from '../../../src/host/voiceService.ts'
import { createSecretFile, type SecretFile } from '../secrets.ts'

/** The secrets file's names. */
export const LINEAR_SECRET = 'linear'
export const ELEVENLABS_SECRET = 'elevenlabs'
/** `<dataDir>/voice.json`: the server's voice, model and "Summarize automatically" (no secret) */
export const VOICE_CONFIG_FILE = 'voice.json'

export interface Integrations {
  linear: LinearService
  voice: VoiceService
}

export interface IntegrationOptions {
  /** `secrets.json` beside the server's config (secretsPathFor) */
  secretsFile: string
  /**
   * Linear's GraphQL endpoint, for tests (default api.linear.app); the server reads
   * `TREK_SERVER_LINEAR_URL` from its environment for its smokes.
   */
  linearEndpoint?: string
  /** `voice.json` in the data dir */
  voiceConfigFile: string
  /** ElevenLabs' API base (default api.elevenlabs.io/v1); `TREK_SERVER_ELEVENLABS_URL` for the smokes */
  elevenLabsApi?: string
}

export function keySlot(file: SecretFile, name: string): KeySlot {
  return {
    get: () => file.get(name),
    set: (value) => file.set(name, value),
    setIfAbsent: (value) => file.setIfAbsent(name, value)
  }
}

export function createIntegrations(options: IntegrationOptions): Integrations {
  const secrets = createSecretFile(options.secretsFile)
  return {
    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint }),
    voice: createVoiceService({ key: keySlot(secrets, ELEVENLABS_SECRET), configFile: options.voiceConfigFile, api: options.elevenLabsApi })
  }
}
