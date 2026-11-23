// The campsite plugin's per-app preferences (shared by the app's windows). Pure.
import type { PluginPrefValue } from '../../../src/shared/plugins/manifest.ts'
import type { Hemisphere } from './world.ts'

/** The sky follows the window's clock, or is always dusk (the strip's look before part 3d) */
export type SkyPref = 'clock' | 'dusk'
export const SKY_PREFS: readonly SkyPref[] = ['clock', 'dusk']
/** The seasons follow the northern or southern half of the world, or are off */
export const SEASON_PREFS: readonly Hemisphere[] = ['north', 'south', 'off']

export interface CampsitePrefs {
  showCampsite: boolean
  campsiteCollapsed: boolean
  showTerminalHiker: boolean
  showDog: boolean
  sky: SkyPref
  seasons: Hemisphere
}
export type CampsitePrefKey = keyof CampsitePrefs

export const DEFAULT_PREFS: CampsitePrefs = { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true, showDog: true, sky: 'clock', seasons: 'north' }

/** The choices of each pref that isn't a switch */
const CHOICES: Partial<Record<CampsitePrefKey, readonly string[]>> = { sky: SKY_PREFS, seasons: SEASON_PREFS }

/** The stored prefs, each one this version can't read (a wrong type, an unknown choice) at its default */
export function readPrefs(raw: Readonly<Record<string, PluginPrefValue>>): CampsitePrefs {
  const out: Record<string, PluginPrefValue> = { ...DEFAULT_PREFS }
  for (const key of Object.keys(DEFAULT_PREFS) as CampsitePrefKey[]) {
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined
    if (value === undefined) continue
    const choices = CHOICES[key]
    if (choices ? typeof value === 'string' && choices.includes(value) : typeof value === 'boolean') out[key] = value
  }
  return out as unknown as CampsitePrefs
}
