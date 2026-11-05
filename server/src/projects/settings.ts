// The keys a project's settings may hold and the kind of value each takes.
// Values are checked by kind only: their contents are client preferences the
// server stores and returns, not acts on.
import type { ProjectSettings } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { assertNoProtoKeys, isRecord } from '../validate.ts'

type Kind = 'string' | 'boolean' | 'array' | 'stringArray' | 'object'

const KIND_TEXT: Record<Kind, string> = {
  string: 'a string',
  boolean: 'a boolean',
  array: 'an array',
  stringArray: 'an array of strings',
  object: 'an object'
}

/** Every ProjectSettings key; the Record type makes the compiler flag a missing one. */
const SETTINGS_KINDS: Record<keyof ProjectSettings, Kind> = {
  claudeCommand: 'string',
  claudeArgs: 'string',
  claudePermissionMode: 'string',
  dockerFavorites: 'stringArray',
  azureDevOpsBaseUrl: 'string',
  linearWorkspace: 'string',
  worktreeTags: 'array',
  customTags: 'array',
  audioAlerts: 'boolean',
  titleBarColor: 'string',
  logoImage: 'string',
  bannerImage: 'string',
  terminalButtons: 'array',
  globalTerminalButtons: 'array',
  globalSystemPrompt: 'string',
  bot: 'object',
  sessionSystemPrompt: 'string',
  sessionTypes: 'array',
  llmDefault: 'object',
  globalLlm: 'object',
  worktreeOrder: 'stringArray'
}

/** Whether `key` is a project setting (an own key of the settings table). */
export function isSettingsKey(key: string): key is keyof ProjectSettings {
  return Object.hasOwn(SETTINGS_KINDS, key)
}

function checkValue(key: string, value: unknown, field: string): void {
  if (!isSettingsKey(key)) throw codedError('BAD_REQUEST', `${field}.${key} is not a project setting`)
  const kind = SETTINGS_KINDS[key as keyof ProjectSettings]
  const ok =
    kind === 'string' ? typeof value === 'string'
    : kind === 'boolean' ? typeof value === 'boolean'
    : kind === 'array' ? Array.isArray(value)
    : kind === 'stringArray' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
    : isRecord(value)
  if (!ok) throw codedError('BAD_REQUEST', `${field}.${key} must be ${KIND_TEXT[kind]}`)
  assertNoProtoKeys(value, `${field}.${key}`)
}

/** A whole settings object (from an import). */
export function validateSettings(value: unknown, field: string): ProjectSettings {
  if (!isRecord(value)) throw codedError('BAD_REQUEST', `${field} must be an object`)
  for (const [key, v] of Object.entries(value)) if (v !== undefined) checkValue(key, v, field)
  return value as ProjectSettings
}

/** Shallow merge; a key set to null is removed. Returns a new object. */
export function applySettingsPatch(current: ProjectSettings, patch: Record<string, unknown>): ProjectSettings {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (!isSettingsKey(key)) throw codedError('BAD_REQUEST', `settings.${key} is not a project setting`)
      delete next[key]
    } else if (value !== undefined) {
      checkValue(key, value, 'settings')
      next[key] = value
    }
  }
  return next as ProjectSettings
}
