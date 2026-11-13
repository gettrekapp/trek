// The voice plugin: spoken summaries from agent sessions through ElevenLabs, with the server's key.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const VOICE_MANIFEST: PluginManifest = {
  id: 'voice',
  version: '1.0.0',
  name: 'Voice summaries',
  description: 'Agent sessions read a short summary aloud (the speak_summary tool) through ElevenLabs, in every window that has their project open.',
  defaultEnabled: true,
  // 0.2.x clients show the voice UI on this capability and hear `integrations.changed { voice }`.
  legacyCapability: 'voice',
  secrets: ['elevenlabs']
}
