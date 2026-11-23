// What a server window's settings setters do (the store's `SettingsSetter`s: the Settings panel's,
// the title bar's and TicketModal's): each is a compare-and-set on its field, written through the
// window's settings writer. Values are turned into the server's form here: an
// empty list, a blank prompt or undefined is sent as null, which removes the key.
//
// A window also edits the Docker favourites, which build on a value: the overlaid project (the
// mirror's, with the pending edits), which is what the window shows, so a second toggle made while
// the first is in flight keeps it. It is an operation, so a CONFLICT rebases it on the newer value
// (`rebase`): a favourite toggled is toggled again there, silently.
//
// The plugins' repository and branch settings (plugins E3) are fields too, written whole by the
// plugin from what the window shows; a CONFLICT re-applies the fields it changed over the other
// client's, and asks only when that client changed the same field. A server before plugins E2 keeps
// the env plugin's as core's old `environments` and `env` (legacyEnvFields.ts): they go there.
//
// Tags: only the new list is sent. The server clears a deleted workflow or
// custom tag from every branch in the same change (project.updateSettings).
//
// Pure: installV2.ts supplies the requests and the writer.
import type { BranchData, Project, Repository } from '../../../shared/model/types'
import type { EnvironmentSettings } from '../../../shared/types'
import type { AppState, SettingsSetter } from '../store'
import { sameSetting, type Rebased, type SettingsField, type SettingsWriter } from './settingsWriter.ts'
import { withPluginEnabled } from '../plugins/presence.ts'
import type { PluginSettingValues } from '../../../shared/plugins/manifest.ts'
import { LEGACY_ENV_BRANCH_FIELD, LEGACY_ENV_PLUGIN, legacyFromRepoValues } from '../../../shared/legacyEnvFields.ts'

export type SettingsOverrides = Pick<AppState, SettingsSetter>

export interface SettingsRequests {
  /** `project.updateSettings` with `expected`; resolves once the mirror holds it */
  updateSettings(settings: Record<string, unknown>, expected: Record<string, unknown>): Promise<void>
  /** `project.rename` with `expected` */
  rename(name: string, expected: string): Promise<void>
  /** `repo.update` of `linkedDirs`, with `expected` */
  setLinkedDirs(repoId: string, linkedDirs: string[] | null, expected: string[] | null): Promise<void>
  /** `repo.update` of `environments`, with `expected` */
  setEnvironments(repoId: string, environments: EnvironmentSettings | null, expected: EnvironmentSettings | null): Promise<void>
  /** `branch.setEnv` with `expected` */
  setBranchEnv(repoId: string, branch: string, env: string | null, expected: string | null): Promise<void>
  /** `repo.setPluginSettings` with `expected` (plugins E3): `values` replaces the plugin's; {} clears them */
  setRepoPluginSettings(repoId: string, pluginId: string, values: PluginSettingValues, expected: PluginSettingValues | null): Promise<void>
  /** `branch.setPluginSettings` with `expected` (plugins E3) */
  setBranchPluginSettings(repoId: string, branch: string, pluginId: string, values: PluginSettingValues, expected: PluginSettingValues | null): Promise<void>
}

const SAVE_FAILED = 'Could not save the setting'

/** A key of the project's settings. */
export function settingField(key: string, label: string, requests: SettingsRequests): SettingsField {
  return {
    key: `settings.${key}`,
    label,
    title: SAVE_FAILED,
    current: (project) => (project.settings as Record<string, unknown>)[key] ?? null,
    apply: (project, value) => {
      const settings = { ...project.settings } as Record<string, unknown>
      if (value === null) delete settings[key]
      else settings[key] = value
      return { ...project, settings: settings as Project['settings'] }
    },
    send: (value, expected) => requests.updateSettings({ [key]: value }, { [key]: expected })
  }
}

export function nameField(requests: SettingsRequests): SettingsField {
  return {
    key: 'name',
    label: 'Project name',
    title: 'Could not rename the project',
    current: (project) => project.name,
    apply: (project, value) => ({ ...project, name: value as string }),
    send: (value, expected) => requests.rename(value as string, expected as string)
  }
}

/** A repository's own field (`repo.update`): `linkedDirs` or `environments`. */
function repoField(
  repoId: string,
  name: 'linkedDirs' | 'environments',
  label: string,
  send: (value: unknown, expected: unknown) => Promise<void>
): SettingsField {
  return {
    key: `repo:${repoId}.${name}`,
    label,
    title: SAVE_FAILED,
    current: (project) => project.repositories.find((r) => r.id === repoId)?.[name] ?? null,
    apply: (project, value) => ({
      ...project,
      repositories: project.repositories.map((r) => {
        if (r.id !== repoId) return r
        const rest: Repository = { ...r }
        delete rest[name]
        return value === null ? rest : { ...rest, [name]: value }
      })
    }),
    send
  }
}

export function linkedDirsField(repoId: string, requests: SettingsRequests): SettingsField {
  return repoField(repoId, 'linkedDirs', 'Linked directories', (value, expected) =>
    requests.setLinkedDirs(repoId, value as string[] | null, expected as string[] | null)
  )
}

export function environmentsField(repoId: string, requests: SettingsRequests): SettingsField {
  return {
    ...repoField(repoId, 'environments', 'Docker environments', (value, expected) =>
      requests.setEnvironments(repoId, value as EnvironmentSettings | null, expected as EnvironmentSettings | null)
    ),
    rebase: rebaseObject
  }
}

/** A branch's environment variables (`branchData[branch].env`), through `branch.setEnv`. */
export function branchEnvField(repoId: string, branch: string, requests: SettingsRequests): SettingsField {
  return {
    key: `branch:${repoId}/${branch}.env`,
    label: `Environment variables of ${branch}`,
    title: 'Could not save the environment',
    current: (project) => {
      const data = project.repositories.find((r) => r.id === repoId)?.branchData
      return (data && Object.hasOwn(data, branch) ? data[branch].env : undefined) ?? null
    },
    apply: (project, value) => ({
      ...project,
      repositories: project.repositories.map((r) => {
        if (r.id !== repoId) return r
        const data = { ...(Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : {}) }
        if (value === null) delete data.env
        else data.env = value as string
        const branchData = { ...r.branchData }
        if (Object.keys(data).length === 0) delete branchData[branch]
        else branchData[branch] = data
        return { ...r, branchData }
      })
    }),
    send: (value, expected) => requests.setBranchEnv(repoId, branch, value as string | null, expected as string | null)
  }
}

/** A plugin's own entry in a pluginSettings map (an own key only), exactly as kept; null when it has none. */
function pluginValuesIn(map: Record<string, PluginSettingValues> | undefined, pluginId: string): PluginSettingValues | null {
  return map && Object.hasOwn(map, pluginId) ? map[pluginId] : null
}

/** `map` with the plugin's entry set to `value` (null removes it); undefined when that leaves it empty. */
function withPluginValues(map: Record<string, PluginSettingValues> | undefined, pluginId: string, value: unknown): Record<string, PluginSettingValues> | undefined {
  const next = { ...(map ?? {}) }
  if (value === null) delete next[pluginId]
  else next[pluginId] = value as PluginSettingValues
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * A plugin's settings for a repository (plugins E1, E3): `repo.setPluginSettings` with `expected`
 * (the plugin's entry as read, unknown keys included; null for none). A value set is an operation
 * on the plugin's fields: another client's other fields are kept (rebaseObject).
 */
export function pluginRepoField(repoId: string, pluginId: string, label: string, requests: SettingsRequests): SettingsField {
  return {
    key: `repo:${repoId}.plugin:${pluginId}`,
    label,
    title: SAVE_FAILED,
    current: (project) => pluginValuesIn(project.repositories.find((r) => r.id === repoId)?.pluginSettings, pluginId),
    apply: (project, value) => ({
      ...project,
      repositories: project.repositories.map((r) => {
        if (r.id !== repoId) return r
        const { pluginSettings: _old, ...rest } = r
        const pluginSettings = withPluginValues(r.pluginSettings, pluginId, value)
        const next: Repository = pluginSettings ? { ...rest, pluginSettings } : rest
        // The env plugin's old field, as the server mirrors it (legacyEnv.ts's mirrorRepo).
        if (pluginId === LEGACY_ENV_PLUGIN) {
          const environments = legacyFromRepoValues((value as PluginSettingValues | null) ?? undefined)
          if (environments) next.environments = environments
          else delete next.environments
        }
        return next
      })
    }),
    send: (value, expected) => requests.setRepoPluginSettings(repoId, pluginId, (value as PluginSettingValues | null) ?? {}, expected as PluginSettingValues | null),
    rebase: rebaseObject
  }
}

/** A plugin's settings for a branch (plugins E1, E3): `branch.setPluginSettings` with `expected`; an emptied branch entry goes. */
export function pluginBranchField(repoId: string, branch: string, pluginId: string, label: string, requests: SettingsRequests): SettingsField {
  return {
    key: `branch:${repoId}/${branch}.plugin:${pluginId}`,
    label,
    title: SAVE_FAILED,
    current: (project) => {
      const data = project.repositories.find((r) => r.id === repoId)?.branchData
      return pluginValuesIn(data && Object.hasOwn(data, branch) ? data[branch].pluginSettings : undefined, pluginId)
    },
    apply: (project, value) => ({
      ...project,
      repositories: project.repositories.map((r) => {
        if (r.id !== repoId) return r
        const before = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : {}
        const { pluginSettings: _old, ...data } = before
        const pluginSettings = withPluginValues(before.pluginSettings, pluginId, value)
        const next: BranchData = pluginSettings ? { ...data, pluginSettings } : data
        // The env plugin's old field, as the server mirrors it (legacyEnv.ts's mirrorBranch).
        if (pluginId === LEGACY_ENV_PLUGIN) {
          const text = (value as PluginSettingValues | null)?.[LEGACY_ENV_BRANCH_FIELD]
          if (typeof text === 'string' && text !== '') next.env = text
          else delete next.env
        }
        const branchData = { ...r.branchData }
        if (Object.keys(next).length === 0) delete branchData[branch]
        else branchData[branch] = next
        return { ...r, branchData }
      })
    }),
    send: (value, expected) =>
      requests.setBranchPluginSettings(repoId, branch, pluginId, (value as PluginSettingValues | null) ?? {}, expected as PluginSettingValues | null),
    rebase: rebaseObject
  }
}

/**
 * Whether a branch's .env is held only in the old field (`BranchData.env`), not in the env plugin's
 * copy: one over the plugin's limit, which the server keeps but doesn't mirror (legacyEnv.ts's
 * migrateBranchEnv). The window shows it from there (projector.ts), so it is written back there:
 * `branch.setEnv`, guarded by that text. A plugin write would clear it unread (its mirror is made
 * from the plugin's copy), with `expected` blind to it.
 */
function envOnlyInOldField(project: Project | undefined, repoId: string, branch: string): boolean {
  const data = project?.repositories.find((r) => r.id === repoId)?.branchData
  if (!data || !Object.hasOwn(data, branch)) return false
  const { env, pluginSettings } = data[branch]
  if (typeof env !== 'string' || env === '') return false
  const entry = pluginValuesIn(pluginSettings, LEGACY_ENV_PLUGIN)
  return !entry || !Object.hasOwn(entry, LEGACY_ENV_BRANCH_FIELD)
}

/**
 * A set's change from `base` to `wanted` (items added, items removed) applied
 * to `latest`, sorted; null when empty. Never a clash: each item is its own toggle.
 */
export function rebaseSet(latest: unknown, wanted: unknown, base: unknown): Rebased {
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
  const was = new Set(list(base))
  const now = new Set(list(wanted))
  const out = new Set(list(latest))
  for (const item of now) if (!was.has(item)) out.add(item)
  for (const item of was) if (!now.has(item)) out.delete(item)
  return { value: listOrNull([...out].sort()), clash: false }
}

/**
 * An object's change from `base` to `wanted` (the keys it set or removed)
 * applied to `latest`. A clash when `latest` also changed one of those keys,
 * to something else. Clearing a whole entry (wanted null) keeps a key another client added.
 */
export function rebaseObject(latest: unknown, wanted: unknown, base: unknown): Rebased {
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const [l, w, b] = [obj(latest), obj(wanted), obj(base)]
  const out: Record<string, unknown> = { ...l }
  let clash = false
  for (const key of new Set([...Object.keys(w), ...Object.keys(b)])) {
    if (sameSetting(w[key], b[key])) continue
    if (!sameSetting(l[key], b[key]) && !sameSetting(l[key], w[key])) clash = true
    if (w[key] === undefined) delete out[key]
    else out[key] = w[key]
  }
  return { value: Object.keys(out).length > 0 ? out : null, clash }
}

const listOrNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null)
const textOrNull = (text: string | undefined): string | null => (text ? text : null)
const promptOrNull = (prompt: string): string | null => (prompt.trim() ? prompt : null)

/**
 * `shown` is the mirror's project (undefined before it has one): the setters
 * that build on a value read it with the pending edits applied. `listsPlugin`
 * says whether the server lists a built-in plugin (plugins E3): a server before
 * plugins E2 has no `env` plugin, and keeps its settings as core's old fields.
 */
export function v2SettingsOverrides(
  writer: SettingsWriter,
  requests: SettingsRequests,
  shown: () => Project | undefined,
  listsPlugin: (pluginId: string) => boolean = () => true
): SettingsOverrides {
  const fields = new Map<string, SettingsField>()
  const setting = (key: string, label: string): SettingsField => {
    let field = fields.get(key)
    if (!field) {
      field = settingField(key, label, requests)
      fields.set(key, field)
    }
    return field
  }
  const name = nameField(requests)
  const favoritesField: SettingsField = { ...settingField('dockerFavorites', 'Docker favourites', requests), rebase: rebaseSet }
  // Per plugin: a switch flipped elsewhere meanwhile is kept, and only the same plugin's clashes.
  const pluginsField: SettingsField = { ...settingField('plugins', 'Plugins', requests), rebase: rebaseObject }
  const write = (key: string, label: string, value: unknown): void => writer.write(setting(key, label), value)
  const overlaid = (): Project | undefined => {
    const project = shown()
    return project && writer.overlay(project)
  }
  return {
    setAudioAlerts: (enabled) => write('audioAlerts', 'Audio alerts', enabled),
    // Absent is on: switching it back on clears the setting.
    setTasksEnabled: (enabled) => write('tasksEnabled', 'Tasks', enabled ? null : false),
    // The whole `plugins` setting, from what the window shows (pending edits included).
    setPluginEnabled: (id, enabled) => writer.write(pluginsField, withPluginEnabled(overlaid()?.settings.plugins, id, enabled)),
    setTitleBarColor: (color) => write('titleBarColor', 'Title bar color', textOrNull(color)),
    setLogoImage: (image) => write('logoImage', 'Logo', textOrNull(image)),
    setBannerImage: (image) => write('bannerImage', 'Banner', textOrNull(image)),
    setWorktreeTags: (tags) => write('worktreeTags', 'Worktree tags', tags),
    setCustomTags: (tags) => write('customTags', 'Custom tags', listOrNull(tags)),
    setTerminalButtons: (buttons) => write('terminalButtons', 'Terminal quick buttons', listOrNull(buttons)),
    setGlobalTerminalButtons: (buttons) => write('globalTerminalButtons', 'Global quick buttons', listOrNull(buttons)),
    setSessionSystemPrompt: (prompt) => write('sessionSystemPrompt', 'Session system prompt', promptOrNull(prompt)),
    setGlobalSystemPrompt: (prompt) => write('globalSystemPrompt', 'Global system prompt', promptOrNull(prompt)),
    setSessionTypes: (types) => write('sessionTypes', 'Session types', listOrNull(types)),
    setProjectLlmDefault: (llm) => write('llmDefault', 'Default agent', llm ?? null),
    setGlobalLlm: (llm) => write('globalLlm', 'Global panel agent', llm ?? null),
    // A plugin's own setting (phase 2), named in a failure dialog by its label (else its key).
    setPluginSetting: (key, value, label) => write(key, label ?? key, textOrNull(value)),
    setProjectName: (value) => writer.write(name, value),
    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs)),
    toggleDockerFavorite: (containerName) => {
      const favorites = new Set(overlaid()?.settings.dockerFavorites ?? [])
      if (favorites.has(containerName)) favorites.delete(containerName)
      else favorites.add(containerName)
      writer.write(favoritesField, listOrNull([...favorites].sort()))
    },
    // A plugin's settings (plugins E3): `values` replaces the plugin's ({} clears them), named in a
    // dialog by `label` (its name). A server before plugins E2 keeps the env plugin's as core's old
    // fields (legacyEnvFields.ts): they go there, compare-and-set as ever. So does a branch's .env
    // held only in the old field (envOnlyInOldField). The env plugin's only branch setting is that text.
    setPluginRepoSettings: (pluginId, repoId, values, label) => {
      if (!overlaid()?.repositories.some((r) => r.id === repoId)) return
      if (pluginId === LEGACY_ENV_PLUGIN && !listsPlugin(pluginId)) writer.write(environmentsField(repoId, requests), legacyFromRepoValues(values) ?? null)
      else writer.write(pluginRepoField(repoId, pluginId, label ?? pluginId, requests), Object.keys(values).length > 0 ? { ...values } : null)
    },
    setPluginBranchSettings: (pluginId, repoId, branch, values, label) => {
      const shown = overlaid()
      if (!shown?.repositories.some((r) => r.id === repoId)) return
      const pluginField = (): SettingsField => pluginBranchField(repoId, branch, pluginId, `${label ?? pluginId} of ${branch}`, requests)
      const envText = (): void => {
        const text = values[LEGACY_ENV_BRANCH_FIELD]
        writer.write(branchEnvField(repoId, branch, requests), typeof text === 'string' && text !== '' ? text : null)
      }
      if (pluginId === LEGACY_ENV_PLUGIN && !listsPlugin(pluginId)) return envText()
      if (pluginId === LEGACY_ENV_PLUGIN && envOnlyInOldField(shown, repoId, branch)) {
        // The text goes through the old field only when the values name it; any other keys go
        // through the plugin's method (the env plugin has none today: the server refuses them).
        // With both, the text alone: a plugin write without the text would clear it there.
        if (Object.hasOwn(values, LEGACY_ENV_BRANCH_FIELD)) return envText()
        if (Object.keys(values).length > 0) writer.write(pluginField(), { ...values })
        return
      }
      // An empty .env is none (as branch.setEnv's null): the Env panel clears with `env: ''`, which the
      // branch above needs to see, but the plugin's copy keeps no empty text.
      const { [LEGACY_ENV_BRANCH_FIELD]: text, ...rest } = values
      const kept = pluginId === LEGACY_ENV_PLUGIN && text === '' ? rest : values
      writer.write(pluginField(), Object.keys(kept).length > 0 ? { ...kept } : null)
    }
  }
}
