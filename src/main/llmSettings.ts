import { app, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseLocalModels } from '../shared/providers/local'
import { sanitizeLlmSelection } from '../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../shared/providers/types'
import type { LlmSettings, LocalBackend, ModelInfo } from '../shared/providers/types'

const settingsPath = (): string => join(app.getPath('userData'), 'llm-settings.json')

function sanitize(raw: unknown): LlmSettings {
  const record = (raw ?? {}) as Partial<LlmSettings>
  return {
    llmDefault: sanitizeLlmSelection(record.llmDefault) ?? DEFAULT_LLM_SETTINGS.llmDefault,
    providers:
      record.providers && typeof record.providers === 'object' ? record.providers : {}
  }
}

async function readSettings(): Promise<LlmSettings> {
  try {
    return sanitize(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    return sanitize(undefined)
  }
}

async function writeSettings(settings: LlmSettings): Promise<LlmSettings> {
  const clean = sanitize(settings)
  await writeFile(settingsPath(), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

async function fetchLocalModels(backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> {
  const base = (baseUrl.trim() || DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '')
  const url = backend === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return parseLocalModels(backend, await res.json())
}

export function registerLlmHandlers(): void {
  ipcMain.handle('llm:getSettings', () => readSettings())
  ipcMain.handle('llm:setSettings', (_event, settings: LlmSettings) => writeSettings(settings))
  // Fetched here, not in the renderer: local servers don't send CORS headers.
  ipcMain.handle('llm:fetchModels', (_event, backend: LocalBackend, baseUrl: string) =>
    fetchLocalModels(backend, baseUrl)
  )
}
