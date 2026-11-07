// The settings setters a server window replaces (the Settings panel's, the
// title bar's and TicketModal's): each becomes a compare-and-set on its field,
// written through the window's settings writer. Values are turned into the
// server's form here: what the store's setter would leave out (an empty list,
// a blank prompt, undefined) is sent as null, which removes the key.
//
// Tags: only the new list is sent. The server clears a deleted workflow or
// custom tag from every branch in the same change (project.updateSettings),
// as the store's setter does in a file window.
//
// Pure: installV2.ts supplies the requests and the writer.
import type { Project } from '../../../shared/model/types'
import type { AppState } from '../store'
import type { SettingsField, SettingsWriter } from './settingsWriter'

export const SETTINGS_SETTERS = [
  'setClaudePermissionMode',
  'setAudioAlerts',
  'setTitleBarColor',
  'setLogoImage',
  'setBannerImage',
  'setWorktreeTags',
  'setCustomTags',
  'setTerminalButtons',
  'setGlobalTerminalButtons',
  'setSessionSystemPrompt',
  'setGlobalSystemPrompt',
  'setSessionTypes',
  'setProjectLlmDefault',
  'setGlobalLlm',
  'setLinearWorkspace',
  'setAzureDevOpsBaseUrl',
  'setProjectName',
  'setLinkedDirs'
] as const

export type SettingsSetter = (typeof SETTINGS_SETTERS)[number]
export type SettingsOverrides = Pick<AppState, SettingsSetter>

export interface SettingsRequests {
  /** `project.updateSettings` with `expected`; resolves once the mirror holds it */
  updateSettings(settings: Record<string, unknown>, expected: Record<string, unknown>): Promise<void>
  /** `project.rename` with `expected` */
  rename(name: string, expected: string): Promise<void>
  /** `repo.update` of `linkedDirs`, with `expected` */
  setLinkedDirs(repoId: string, linkedDirs: string[] | null, expected: string[] | null): Promise<void>
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

export function linkedDirsField(repoId: string, requests: SettingsRequests): SettingsField {
  return {
    key: `repo:${repoId}.linkedDirs`,
    label: 'Linked directories',
    title: SAVE_FAILED,
    current: (project) => project.repositories.find((r) => r.id === repoId)?.linkedDirs ?? null,
    apply: (project, value) => ({
      ...project,
      repositories: project.repositories.map((r) => {
        if (r.id !== repoId) return r
        const { linkedDirs: _old, ...rest } = r
        void _old
        return value === null ? rest : { ...rest, linkedDirs: value as string[] }
      })
    }),
    send: (value, expected) => requests.setLinkedDirs(repoId, value as string[] | null, expected as string[] | null)
  }
}

const listOrNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null)
const textOrNull = (text: string | undefined): string | null => (text ? text : null)
const promptOrNull = (prompt: string): string | null => (prompt.trim() ? prompt : null)

export function v2SettingsOverrides(writer: SettingsWriter, requests: SettingsRequests): SettingsOverrides {
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
  const write = (key: string, label: string, value: unknown): void => writer.write(setting(key, label), value)
  return {
    setClaudePermissionMode: (mode) => write('claudePermissionMode', 'Claude session mode', textOrNull(mode)),
    setAudioAlerts: (enabled) => write('audioAlerts', 'Audio alerts', enabled),
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
    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs))
  }
}
