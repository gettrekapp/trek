import { useAppStore } from './store'
import { resolveNewSessionLlm } from '../../shared/providers/selection'
import { mergeLlmSettings } from '../../shared/providers/settings'
import { DEFAULT_LLM_SETTINGS } from '../../shared/providers/types'
import type { LlmSelection, LlmSettings, LlmSettingsPatch } from '../../shared/providers/types'

export async function loadLlmSettings(): Promise<void> {
  try {
    useAppStore.getState().setLlmSettings(await window.api.llmGetSettings())
  } catch (err) {
    console.error('could not load LLM settings', err)
    useAppStore.getState().setLlmSettings(DEFAULT_LLM_SETTINGS)
  }
}

/** Number of updateLlmSettings calls still waiting for the main process. */
let pendingUpdates = 0

/**
 * Mirrors settings changed from other windows. Broadcasts are ignored while our own
 * updates are in flight: main serializes writes, so once our replies are in, the last
 * broadcast is the truth.
 */
export function watchLlmSettings(): () => void {
  return window.api.onLlmSettingsChanged((settings) => {
    if (pendingUpdates === 0) useAppStore.getState().setLlmSettings(settings)
  })
}

export function llmSettings(): LlmSettings {
  return useAppStore.getState().llmSettings ?? DEFAULT_LLM_SETTINGS
}

/** Applies a patch right away, then lets the main process confirm what was saved. */
export async function updateLlmSettings(patch: LlmSettingsPatch): Promise<void> {
  const store = useAppStore.getState()
  store.setLlmSettings(mergeLlmSettings(llmSettings(), patch))
  pendingUpdates++
  try {
    const saved = await window.api.llmUpdateSettings(patch)
    if (pendingUpdates === 1) useAppStore.getState().setLlmSettings(saved)
  } finally {
    pendingUpdates--
  }
}

/** What a new tab runs when nothing more specific is chosen. */
export function defaultSessionLlm(): LlmSelection {
  return resolveNewSessionLlm({
    projectDefault: useAppStore.getState().project?.llmDefault,
    appDefault: llmSettings().llmDefault
  })
}
