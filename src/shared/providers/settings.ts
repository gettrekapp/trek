import { sanitizeLlmSelection } from './selection.ts'
import { DEFAULT_LLM_SETTINGS, PROVIDER_IDS } from './types.ts'
import type {
  LlmProviderId,
  LlmSettings,
  LlmSettingsPatch,
  LocalBackend,
  LocalProviderConfig
} from './types'

const BACKENDS: LocalBackend[] = ['ollama', 'lmstudio']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function sanitizeConfig(id: LlmProviderId, raw: Record<string, unknown>): LocalProviderConfig {
  const out: LocalProviderConfig = {}
  const command = nonEmpty(raw.command)
  const approvalMode = nonEmpty(raw.approvalMode)
  if (command) out.command = command
  if (approvalMode) out.approvalMode = approvalMode
  if (id === 'local') {
    if (BACKENDS.includes(raw.backend as LocalBackend)) out.backend = raw.backend as LocalBackend
    const baseUrl = nonEmpty(raw.baseUrl)
    if (baseUrl) out.baseUrl = baseUrl
  }
  return out
}

/** Reads untrusted settings (a file, an IPC payload) into the known shape. */
export function sanitizeLlmSettings(raw: unknown): LlmSettings {
  const record = isObject(raw) ? raw : {}
  const providers: Record<string, LocalProviderConfig> = {}
  if (isObject(record.providers)) {
    for (const id of PROVIDER_IDS) {
      const entry = record.providers[id]
      if (isObject(entry)) providers[id] = sanitizeConfig(id, entry)
    }
  }
  return {
    llmDefault: sanitizeLlmSelection(record.llmDefault) ?? DEFAULT_LLM_SETTINGS.llmDefault,
    providers: providers as LlmSettings['providers']
  }
}

/** Applies a patch to settings without mutating them; the result is sanitized. */
export function mergeLlmSettings(base: LlmSettings, patch: LlmSettingsPatch): LlmSettings {
  const providers: Record<string, Record<string, unknown>> = {}
  for (const id of PROVIDER_IDS) {
    const current = base.providers[id]
    if (current) providers[id] = { ...current }
  }
  const patched = isObject(patch.providers) ? patch.providers : {}
  for (const id of PROVIDER_IDS) {
    if (!(id in patched)) continue
    const change = patched[id]
    if (change === null) {
      delete providers[id]
    } else if (isObject(change)) {
      const next = { ...(providers[id] ?? {}) }
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      providers[id] = next
    }
  }
  return sanitizeLlmSettings({ llmDefault: patch.llmDefault ?? base.llmDefault, providers })
}
