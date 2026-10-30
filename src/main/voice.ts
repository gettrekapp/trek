import { app, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSecretStore } from './secrets'
import type { VoiceConfig, VoiceInfo, VoiceKeyResult, VoiceSettings } from '../shared/types'

const API = 'https://api.elevenlabs.io/v1'
const API_KEY = 'apiKey'
const DEFAULT_CONFIG: VoiceConfig = {
  voiceId: '',
  modelId: 'eleven_flash_v2_5',
  active: true,
  promptSessions: false
}

/** The ElevenLabs key never leaves the main process. */
const secrets = createSecretStore('elevenlabs.json')
const configPath = (): string => join(app.getPath('userData'), 'voice-settings.json')

async function readConfig(): Promise<VoiceConfig> {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath(), 'utf8')) }
  } catch {
    return DEFAULT_CONFIG
  }
}

async function updateConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
  const config = { ...(await readConfig()), ...patch }
  await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
  return config
}

async function request(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30_000)
  })
  if (res.status === 401) throw new Error('ElevenLabs rejected the API key')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
  return res
}

async function fetchVoices(apiKey: string): Promise<VoiceInfo[]> {
  const res = await request(apiKey, '/voices')
  const { voices } = (await res.json()) as { voices: { voice_id: string; name: string }[] }
  return voices.map((v) => ({ id: v.voice_id, name: v.name }))
}

async function requireKey(): Promise<string> {
  const apiKey = await secrets.get(API_KEY)
  if (!apiKey) throw new Error('No ElevenLabs API key is configured')
  return apiKey
}

/** Validates a key by listing its voices, and picks the first voice if none is chosen yet. */
async function setApiKey(apiKey: string): Promise<VoiceKeyResult> {
  try {
    const voices = await fetchVoices(apiKey)
    await secrets.set(API_KEY, apiKey)
    const config = await readConfig()
    if (!config.voiceId && voices[0]) await updateConfig({ voiceId: voices[0].id })
    return { ok: true, voices }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function synthesize(text: string): Promise<Uint8Array> {
  const apiKey = await requireKey()
  const { voiceId, modelId } = await readConfig()
  if (!voiceId) throw new Error('No ElevenLabs voice is selected')
  const res = await request(
    apiKey,
    `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId })
    }
  )
  return new Uint8Array(await res.arrayBuffer())
}

export function registerVoiceHandlers(): void {
  ipcMain.handle(
    'voice:getSettings',
    async (): Promise<VoiceSettings> => ({
      ...(await readConfig()),
      hasApiKey: !!(await secrets.get(API_KEY))
    })
  )
  ipcMain.handle('voice:setApiKey', (_event, apiKey: string) => setApiKey(apiKey.trim()))
  ipcMain.handle('voice:clearApiKey', () => secrets.set(API_KEY, null))
  ipcMain.handle('voice:listVoices', async () => fetchVoices(await requireKey()))
  ipcMain.handle('voice:setConfig', (_event, patch: Partial<VoiceConfig>) => updateConfig(patch))
  ipcMain.handle('voice:synthesize', (_event, text: string) => synthesize(text))
}
