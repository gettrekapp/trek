import { useAppStore } from './store'
import { resolveGlobalLlm, resolveNewSessionLlm } from '../../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS } from '../../shared/providers/types'
import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
import type { SessionType } from '../../shared/types'

export async function loadLlmSettings(): Promise<void> {
  try {
    useAppStore.getState().setLlmSettings(await window.api.llmGetSettings())
  } catch (err) {
    console.error('could not load LLM settings', err)
    useAppStore.getState().setLlmSettings(DEFAULT_LLM_SETTINGS)
  }
}

export function llmSettings(): LlmSettings {
  return useAppStore.getState().llmSettings ?? DEFAULT_LLM_SETTINGS
}

export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  useAppStore.getState().setLlmSettings(settings)
  useAppStore.getState().setLlmSettings(await window.api.llmSetSettings(settings))
}

/** What a new tab runs when nothing more specific is chosen. */
export function defaultSessionLlm(): LlmSelection {
  return resolveNewSessionLlm({
    projectDefault: useAppStore.getState().project?.llmDefault,
    appDefault: llmSettings().llmDefault
  })
}

/** What a new tab runs, given the + menu pick and session type. */
export function newSessionLlm(sessionType?: SessionType, pick?: LlmSelection): LlmSelection {
  return resolveNewSessionLlm({
    pick,
    sessionType: sessionType?.llm,
    projectDefault: useAppStore.getState().project?.llmDefault,
    appDefault: llmSettings().llmDefault
  })
}

/** What a new Global panel tab runs. */
export function globalSessionLlm(): LlmSelection {
  return resolveGlobalLlm(useAppStore.getState().project?.globalLlm, defaultSessionLlm())
}
