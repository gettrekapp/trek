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
  /** When the field guide's tab was last opened (ms; part 3d-2): species first seen after it carry the new dot */
  guideSeenAt: number
  /** When the Noticeboard was last opened (ms; part 5): a project whose newest note is later carries the board's unread dot */
  notesSeenAt: number
}
export type CampsitePrefKey = keyof CampsitePrefs

export const DEFAULT_PREFS: CampsitePrefs = { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true, showDog: true, sky: 'clock', seasons: 'north', guideSeenAt: 0, notesSeenAt: 0 }

/** The choices of each pref that isn't a switch */
const CHOICES: Partial<Record<CampsitePrefKey, readonly string[]>> = { sky: SKY_PREFS, seasons: SEASON_PREFS }

/** The stored prefs, each one this version can't read (a wrong type, an unknown choice, a time that isn't a finite number ≥ 0) at its default */
export function readPrefs(raw: Readonly<Record<string, PluginPrefValue>>): CampsitePrefs {
  const out: Record<string, PluginPrefValue> = { ...DEFAULT_PREFS }
  for (const key of Object.keys(DEFAULT_PREFS) as CampsitePrefKey[]) {
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined
    if (value === undefined) continue
    const choices = CHOICES[key]
    const kind = typeof DEFAULT_PREFS[key]
    if (choices ? typeof value === 'string' && choices.includes(value) : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= 0 : typeof value === kind) out[key] = value
  }
  return out as unknown as CampsitePrefs
}
