// The keys a project's settings may hold and the kind of value each takes.
// Values are checked by kind only: their contents are client preferences the
// server stores and returns, not acts on.
import type { BranchData, ProjectSettings, Repository } from '../../../src/shared/model/types'
import { DEFAULT_WORKTREE_TAGS } from '../../../src/shared/types.ts'
import { isProviderId } from '../../../src/shared/providers/registry.ts'
import { codedError } from '../errors.ts'
import { checkTitle, MAX_QUEUE_ENTRY, MAX_SESSION_TYPES } from '../sessions/limits.ts'
import { assertNoProtoKeys, isRecord } from '../validate.ts'
import { pluginSettingsProblem } from '../../../src/shared/plugins/manifest.ts'

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
  worktreeOrder: 'stringArray',
  plugins: 'object'
}

/**
 * The project settings the registered plugins own (plugin system phase 2: their manifests'
 * `projectSettings`, checked by their server halves), beside the table above.
 */
export interface PluginSettingRules {
  kind(key: string): 'string' | undefined
  /** A value's problem, or null; only called with a value of the declared kind */
  check(key: string, value: string): string | null
}

/** Whether `key` is a core project setting (an own key of the settings table). */
export function isCoreSettingsKey(key: string): key is keyof ProjectSettings {
  return Object.hasOwn(SETTINGS_KINDS, key)
}

/** Whether `key` is a project setting: a core one, or one a registered plugin owns. */
export function isSettingsKey(key: string, plugins?: PluginSettingRules): boolean {
  return isCoreSettingsKey(key) || plugins?.kind(key) !== undefined
}

/** Session types are acted on at every session.start, so their fields are checked, not just their kind. */
function checkSessionTypes(types: unknown[], field: string): void {
  const bad = (message: string): Error => codedError('BAD_REQUEST', `${field}${message}`)
  if (types.length > MAX_SESSION_TYPES) throw bad(` must hold at most ${MAX_SESSION_TYPES} session types`)
  types.forEach((t, i) => {
    const at = `[${i}]`
    if (!isRecord(t)) throw bad(`${at} must be an object`)
    if (typeof t.id !== 'string' || !t.id) throw bad(`${at}.id must be a non-empty string`)
    if (typeof t.name !== 'string') throw bad(`${at}.name must be a string`)
    checkTitle(t.name, `${field}${at}.name`)
    if (typeof t.systemPrompt !== 'string') throw bad(`${at}.systemPrompt must be a string`)
    if (t.systemPrompt.length > MAX_QUEUE_ENTRY) throw bad(`${at}.systemPrompt must be at most ${MAX_QUEUE_ENTRY} characters`)
    if (t.initialMessage !== undefined) {
      if (typeof t.initialMessage !== 'string') throw bad(`${at}.initialMessage must be a string`)
      if (t.initialMessage.length > MAX_QUEUE_ENTRY) throw bad(`${at}.initialMessage must be at most ${MAX_QUEUE_ENTRY} characters`)
    }
    if (t.llm !== undefined && (!isRecord(t.llm) || !isProviderId(t.llm.provider))) throw bad(`${at}.llm must have a known provider`)
    if (t.icon !== undefined && typeof t.icon !== 'string') throw bad(`${at}.icon must be a string`)
  })
}

function checkValue(key: string, value: unknown, field: string, plugins?: PluginSettingRules): void {
  if (!isCoreSettingsKey(key)) {
    const kind = plugins?.kind(key)
    if (!kind) throw codedError('BAD_REQUEST', `${field}.${key} is not a project setting`)
    if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field}.${key} must be ${KIND_TEXT[kind]}`)
    const problem = plugins!.check(key, value)
    if (problem) throw codedError('BAD_REQUEST', `${field}.${key}: ${problem}`)
    return
  }
  const kind = SETTINGS_KINDS[key]
  const ok =
    kind === 'string' ? typeof value === 'string'
    : kind === 'boolean' ? typeof value === 'boolean'
    : kind === 'array' ? Array.isArray(value)
    : kind === 'stringArray' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
    : isRecord(value)
  if (!ok) throw codedError('BAD_REQUEST', `${field}.${key} must be ${KIND_TEXT[kind]}`)
  assertNoProtoKeys(value, `${field}.${key}`)
  if (key === 'sessionTypes') checkSessionTypes(value as unknown[], `${field}.${key}`)
  if (key === 'plugins') {
    const problem = pluginSettingsProblem(value as Record<string, unknown>)
    if (problem) throw codedError('BAD_REQUEST', `${field}.plugins: ${problem}`)
  }
}

/** A whole settings object (from an import). */
export function validateSettings(value: unknown, field: string, plugins?: PluginSettingRules): ProjectSettings {
  if (!isRecord(value)) throw codedError('BAD_REQUEST', `${field} must be an object`)
  for (const [key, v] of Object.entries(value)) if (v !== undefined) checkValue(key, v, field, plugins)
  return value as ProjectSettings
}

/** Shallow merge; a key set to null is removed. Returns a new object. */
export function applySettingsPatch(current: ProjectSettings, patch: Record<string, unknown>, plugins?: PluginSettingRules): ProjectSettings {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (!isSettingsKey(key, plugins)) throw codedError('BAD_REQUEST', `settings.${key} is not a project setting`)
      delete next[key]
    } else if (value !== undefined) {
      checkValue(key, value, 'settings', plugins)
      next[key] = value
    }
  }
  return next as ProjectSettings
}

/** The ids of a tag list; entries without a string id name no tag. */
function tagIds(tags: unknown): Set<string> {
  const ids = new Set<string>()
  if (Array.isArray(tags)) for (const t of tags) if (isRecord(t) && typeof t.id === 'string') ids.add(t.id)
  return ids
}

/**
 * The tag cascade of a settings patch (Settings' setWorktreeTags and
 * setCustomTags): when the patch sets `worktreeTags` (or removes it, which
 * brings back DEFAULT_WORKTREE_TAGS), every branch whose `tag` is not in the new
 * list becomes untagged; when it sets or removes `customTags`, every branch keeps
 * only the custom tag ids still listed, and an emptied list is dropped. A branch
 * left with no data is dropped, as `branch.*` does. A patch that does not name
 * either key changes nothing. `settings` is the project's settings after the
 * patch. Returns the repositories, the unchanged ones as they were.
 */
export function pruneDeletedTags(repositories: Repository[], settings: ProjectSettings, patch: Record<string, unknown>): Repository[] {
  const tags = Object.hasOwn(patch, 'worktreeTags') && patch.worktreeTags !== undefined
    ? tagIds(settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS)
    : undefined
  const custom = Object.hasOwn(patch, 'customTags') && patch.customTags !== undefined ? tagIds(settings.customTags) : undefined
  if (!tags && !custom) return repositories
  return repositories.map((repo) => {
    let branchData: Record<string, BranchData> | undefined
    for (const [branch, data] of Object.entries(repo.branchData)) {
      const dropTag = tags !== undefined && data.tag !== undefined && !tags.has(data.tag)
      const kept = custom && data.customTags?.filter((id) => custom.has(id))
      const dropCustom = kept !== undefined && kept.length !== data.customTags!.length
      if (!dropTag && !dropCustom) continue
      const next: BranchData = { ...data }
      if (dropTag) delete next.tag
      if (dropCustom && kept.length > 0) next.customTags = kept
      else if (dropCustom) delete next.customTags
      branchData ??= { ...repo.branchData }
      if (Object.keys(next).length === 0) delete branchData[branch]
      else branchData[branch] = next
    }
    return branchData ? { ...repo, branchData } : repo
  })
}
