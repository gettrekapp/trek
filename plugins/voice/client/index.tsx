// The voice plugin's client half (plugin system phase 1; the renderer's voice before it): plays
// the project's spoken summaries (Runtime), the Active/Busy toggle in the sidebar, the bubble while
// one plays, and its Settings section (the server's ElevenLabs key, voice and model).
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { VOICE_MANIFEST } from '../manifest.ts'
import { VoiceRuntime } from './Runtime.tsx'
import { SummaryBubble } from './SummaryBubble.tsx'
import { VoiceSettings } from './VoiceSettings.tsx'
import { VoiceToggle } from './VoiceToggle.tsx'
import './voice.css'

export const voiceClientPlugin = defineClientPlugin({
  manifest: VOICE_MANIFEST,
  Runtime: VoiceRuntime,
  slots: { settings: VoiceSettings, sidebarToolbar: VoiceToggle, overlay: SummaryBubble }
})
