// The campsite plugin's per-app preferences (shared by the app's windows). Pure.
import type { PluginPrefValue } from '../../../src/shared/plugins/manifest.ts'

export interface CampsitePrefs {
  showCampsite: boolean
  campsiteCollapsed: boolean
  showTerminalHiker: boolean
}
export type CampsitePrefKey = keyof CampsitePrefs

export const DEFAULT_PREFS: CampsitePrefs = { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true }

export function readPrefs(raw: Readonly<Record<string, PluginPrefValue>>): CampsitePrefs {
  const out = { ...DEFAULT_PREFS }
  for (const key of Object.keys(DEFAULT_PREFS) as CampsitePrefKey[]) {
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}
