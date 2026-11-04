import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseLocalModels } from '../shared/providers/local'
import { mergeLlmSettings, sanitizeLlmSettings } from '../shared/providers/settings'
import { DEFAULT_LOCAL_URLS } from '../shared/providers/types'
import type {
  LlmSettings,
  LlmSettingsPatch,
  LocalBackend,
  ModelInfo
} from '../shared/providers/types'

const settingsPath = (): string => join(app.getPath('userData'), 'llm-settings.json')

async function readSettings(): Promise<LlmSettings> {
  try {
    return sanitizeLlmSettings(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    return sanitizeLlmSettings(undefined)
  }
}

/** Every write goes through this chain, so concurrent patches never interleave. */
let writeChain: Promise<unknown> = Promise.resolve()

async function applyPatch(patch: LlmSettingsPatch): Promise<LlmSettings> {
  const next = mergeLlmSettings(await readSettings(), patch)
  const path = settingsPath()
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
  await rename(temp, path)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('llm:changed', next)
  }
  return next
}

function updateSettings(patch: LlmSettingsPatch): Promise<LlmSettings> {
  const run = writeChain.then(() => applyPatch(patch))
  writeChain = run.catch(() => undefined)
  return run
}

async function fetchLocalModels(backend: LocalBackend, baseUrl: unknown): Promise<ModelInfo[]> {
  if (backend !== 'ollama' && backend !== 'lmstudio') throw new Error(`Unknown backend: ${String(backend)}`)
  const custom = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const base = (custom || DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '')
  const url = backend === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return parseLocalModels(backend, await res.json())
}

export function registerLlmHandlers(): void {
  ipcMain.handle('llm:getSettings', () => readSettings())
  ipcMain.handle('llm:updateSettings', (_event, patch: LlmSettingsPatch) => updateSettings(patch))
  // Fetched here, not in the renderer: local servers don't send CORS headers.
  ipcMain.handle('llm:fetchModels', (_event, backend: LocalBackend, baseUrl: string) =>
    fetchLocalModels(backend, baseUrl)
  )
}
