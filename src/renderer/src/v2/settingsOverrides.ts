// What a server window's settings setters do (the store's `SettingsSetter`s: the Settings panel's,
// the title bar's and TicketModal's): each is a compare-and-set on its field, written through the
// window's settings writer. Values are turned into the server's form here: an
// empty list, a blank prompt or undefined is sent as null, which removes the key.
//
// A Local window (4c) also edits a repository's Docker environments setting,
// the Docker favourites and a branch's environment variables. The first two
// build on a value: the overlaid project (the mirror's, with the pending
// edits), which is what the window shows, so a second edit made while the
// first is in flight keeps it. Both are operations, so a CONFLICT rebases
// them on the newer value (`rebase`): a favourite toggled is toggled again
// there, silently; an environment sub-field set is set again there, and only
// asks when the other client changed that same sub-field.
//
// The environment variables are a settings field too (`branch.setEnv` with
// `expected`): the panel's Start reads the pending value from the overlay,
// and a stale draft asks Reload or Keep Mine.
//
// Tags: only the new list is sent. The server clears a deleted workflow or
// custom tag from every branch in the same change (project.updateSettings).
//
// Pure: installV2.ts supplies the requests and the writer.
import type { Project, Repository } from '../../../shared/model/types'
import type { EnvironmentSettings } from '../../../shared/types'
import type { AppState, SettingsSetter } from '../store'
import { sameSetting, type Rebased, type SettingsField, type SettingsWriter } from './settingsWriter.ts'
import { withPluginEnabled } from '../plugins/presence.ts'

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
 * to something else.
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
 * that build on a value read it with the pending edits applied.
 */
export function v2SettingsOverrides(
  writer: SettingsWriter,
  requests: SettingsRequests,
  shown: () => Project | undefined
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
    setClaudePermissionMode: (mode) => write('claudePermissionMode', 'Claude session mode', textOrNull(mode)),
    setAudioAlerts: (enabled) => write('audioAlerts', 'Audio alerts', enabled),
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
    setLinearWorkspace: (slug) => write('linearWorkspace', 'Linear workspace', textOrNull(slug)),
    setAzureDevOpsBaseUrl: (url) => write('azureDevOpsBaseUrl', 'Azure DevOps URL', textOrNull(url)),
    setProjectName: (value) => writer.write(name, value),
    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs)),
    // As the store's setter: `enabled` defaults to off, and the patch goes over the rest.
    setEnvironmentSettings: (repoId, patch) => {
      const repo = overlaid()?.repositories.find((r) => r.id === repoId)
      if (!repo) return
      writer.write(environmentsField(repoId, requests), { enabled: false, ...repo.environments, ...patch })
    },
    toggleDockerFavorite: (containerName) => {
      const favorites = new Set(overlaid()?.settings.dockerFavorites ?? [])
      if (favorites.has(containerName)) favorites.delete(containerName)
      else favorites.add(containerName)
      writer.write(favoritesField, listOrNull([...favorites].sort()))
    },
    setBranchEnvVars: (repoId, branch, text) => writer.write(branchEnvField(repoId, branch, requests), text || null)
  }
}
