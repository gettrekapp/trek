// The voice plugin's server half (plugin system phase 1; phase 5b's voice.* and speak_summary):
// ElevenLabs with the server's key, its voice and model in the plugin's config file, the
// speak_summary MCP tool and the "Summarize automatically" session prompt in the projects where
// it is on. Wire names unchanged: `voice.settings`, `voice.setKey`, ..., event `voice.summary`.
import { defineServerPlugin, optionalFlag, requireApiKey, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { VOICE_MANIFEST } from '../manifest.ts'
import type { VoiceKeyResult, VoiceSummaryEvent } from '../shared/types.ts'
import { migrateConfigFile } from './configFile.ts'
import { VOICE_SUMMARY_PROMPT } from './prompt.ts'
import { requireSpokenText, requireVoicePatch } from './validate.ts'
import { createVoiceService, type VoiceService } from './voiceService.ts'

export const SPEAK_SUMMARY_TOOL = {
  name: 'speak_summary',
  description:
    "Read a short spoken summary aloud to the user through the Trek server's ElevenLabs voice. Keep it SHORT: one to three plain sentences (max 400 characters), written to be heard — no markdown, code, file paths, URLs or lists. Use it only when your instructions or the user ask for spoken summaries. It plays in every Trek window that has this project open, one summary at a time, and is skipped where the user is set to Busy, so never repeat it. The result's windows counts the windows it was sent to, Busy ones included. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
  inputSchema: {
    type: 'object',
    properties: {
      terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
      summary: { type: 'string', description: 'One to three short spoken sentences, at most 400 characters' }
    },
    required: ['terminalId', 'summary']
  }
}

/** The tool's answer when a summary can't be heard. */
const NOT_SET_UP = { played: false, reason: 'Voice summaries are not set up on this Trek server — do not call speak_summary again' }
const NOBODY = { played: false, reason: 'No Trek window has this project open, so nobody would hear it' }

/** Ready to speak: a key and a chosen voice (synthesize refuses without one); an unreadable secrets file is not. */
function ready(voice: VoiceService): boolean {
  try {
    const settings = voice.settings()
    return settings.hasKey && !!settings.voiceId
  } catch {
    return false
  }
}

export function setupVoice(host: ServerPluginHost, options: { fetch?: typeof fetch } = {}) {
  const legacy = host.legacyDataFile('voice.json')
  let next: string | undefined
  try {
    next = host.dataFile('config.json')
  } catch (err) {
    // The plugin's data dir can't be made (permissions): keep voice working on the old file.
    host.log.warn(`its data dir is not usable (${err instanceof Error ? err.message : String(err)}); reading ${legacy} in place`)
  }
  const configFile = next ? migrateConfigFile(legacy, next, host.log.warn) : legacy
  const voice = createVoiceService({
    key: host.secret('elevenlabs'),
    configFile,
    api: host.testEndpoint('TREK_SERVER_ELEVENLABS_URL'),
    fetch: options.fetch
  })
  return {
    handlers: {
      settings: () => voice.settings(),
      // ElevenLabs' own refusal is `{ ok: false }` (nothing changed); the secrets file failing throws.
      setKey: async (p: Record<string, unknown>) => {
        const apiKey = requireApiKey(p.apiKey)
        const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
        let result: VoiceKeyResult
        try {
          result = await voice.setKey(apiKey, { ifAbsent })
        } catch (err) {
          // A key stored whose first voice could not be saved: the key changed all the same.
          if ((err as { keyStored?: unknown }).keyStored === true) host.changed()
          throw err
        }
        if (result.ok) host.changed()
        return result
      },
      clearKey: () => {
        voice.clearKey()
        host.changed()
        return null
      },
      voices: () => voice.voices(),
      setConfig: (p: Record<string, unknown>) => {
        const config = voice.setConfig(requireVoicePatch(p))
        host.changed()
        return config
      },
      // Settings' Test: for the asking window only.
      synthesize: async (p: Record<string, unknown>) => {
        const text = requireSpokenText(p.text, 'text')
        return { audio: Buffer.from(await voice.synthesize(text)).toString('base64') }
      }
    },
    mcpTools: [
      {
        definition: SPEAK_SUMMARY_TOOL,
        call: async (args: Record<string, unknown>, ctx: { projectId: string }) => {
          // Global sessions may speak too.
          const { sessionId } = host.session(ctx.projectId, args.terminalId)
          const summary = requireSpokenText(args.summary, 'summary')
          if (!ready(voice)) return NOT_SET_UP
          // Only the windows emit reaches: an MCP tool call's no-op subscriber hears nothing.
          if (host.subscriberCount(ctx.projectId) === 0) return NOBODY
          const audio = Buffer.from(await voice.synthesize(summary)).toString('base64')
          const event: VoiceSummaryEvent = { projectId: ctx.projectId, sessionId, text: summary, audio }
          const windows = host.emit(ctx.projectId, 'summary', event)
          // A project switched off for this plugin while it synthesized lands here too (emit reaches no one).
          return windows > 0 ? { played: true, windows } : NOBODY
        }
      }
    ],
    mcpInstructions: 'speak_summary reads a short summary aloud to the user.',
    sessionPrompt: () => (voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined)
  }
}

export const voiceServerPlugin = defineServerPlugin({
  manifest: VOICE_MANIFEST,
  setup: (host) => setupVoice(host)
})
