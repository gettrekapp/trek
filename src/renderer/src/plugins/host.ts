// A plugin's host in a project window (plugin system phase 1): its `<id>.*` requests and events
// on the window's backend, its per-app preferences in the app settings, the window's session
// labels, its read-only session view (campsite), and its project's repositories and core's dialogs
// (plugins E3). One per (backend, plugin): a window that moves to another server or project gets new ones.
import type { ClientPluginHost, PluginConfirmPrompt, PluginRepo, PluginSession } from '../../../shared/plugins/client.ts'
import type { PluginManifest, PluginPrefValue, PluginSettingValues } from '../../../shared/plugins/manifest.ts'
import type { AppSettings, AppSettingsPatch } from '../../../shared/appSettings.ts'
import type { WindowBackend } from '../backend'
import { CAPABILITY } from '../../../shared/protocolV2.ts'
import { changedFor, forProject } from './presence.ts'
import { ticketInfoStore, type TicketInfoStore } from './ticketInfo.ts'

export interface AppSettingsApi {
  get(): Promise<AppSettings>
  update(patch: AppSettingsPatch): Promise<AppSettings>
  onChanged(callback: (settings: AppSettings) => void): () => void
}

export interface HostDeps {
  appSettings: AppSettingsApi
  terminalLabel(terminalId: string): string
  /** The window's backend now (getBackend) */
  currentBackend(): WindowBackend
  /** Where `setTicketInfo` publishes (default: the window's store) */
  ticketInfo?: TicketInfoStore
  /** The project's linked ticket ids, and their changes (default: none) */
  ticketIds?: () => string[]
  onTicketIdsChanged?: (listener: () => void) => () => void
  /** The window's session view (campsite); absent: no sessions */
  sessions?: () => readonly PluginSession[]
  onSessionsChanged?: (listener: () => void) => () => void
  selectedTerminalId?: () => string | null
  focusSession?: (terminalId: string) => void
  /** The window's repositories as a plugin sees them (plugins E3; default: none) */
  repos?: (pluginId: string) => readonly PluginRepo[]
  /** Called when they may have changed; returns the unsubscribe */
  onReposChanged?: (listener: () => void) => () => void
  /** The store's plugin settings setters (plugins E3; default: nothing is written) */
  setRepoSettings?: (pluginId: string, repoId: string, values: PluginSettingValues, label: string) => void
  setBranchSettings?: (pluginId: string, repoId: string, branch: string, values: PluginSettingValues, label: string) => void
  /** Core's dialogs (plugins E3; default: a confirm declined, an error not shown) */
  confirm?: (prompt: PluginConfirmPrompt) => Promise<boolean>
  showError?: (title: string, message: string) => Promise<void>
  /** Core's Settings fields (plugins E3; default: ones that render nothing) */
  components?: ClientPluginHost['components']
  /** The project's values of a plugin's project setting keys (plugins A2; default: none) */
  projectSettings?: (pluginId: string, keys: readonly string[]) => Readonly<Record<string, string>>
  onProjectSettingsChanged?: (listener: () => void) => () => void
  /** The store's plugin project setting setter (plugins A2; default: nothing is written) */
  setProjectSetting?: (key: string, value: string, label: string) => void
}

const prefsOf = (settings: AppSettings, id: string): Record<string, PluginPrefValue> =>
  Object.hasOwn(settings.plugins, id) ? { ...settings.plugins[id] } : {}

/** A plugin's prefs as a value to compare: its entries sorted by key. */
const prefsKey = (prefs: Record<string, PluginPrefValue>): string => JSON.stringify(Object.entries(prefs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/** A constant, so useSyncExternalStore gets a stable empty snapshot */
const NO_SESSIONS: readonly PluginSession[] = []
/** A host without the window's project (a test's): one array, so it is a stable snapshot. */
const NO_REPOS: readonly PluginRepo[] = []
const NO_COMPONENTS: ClientPluginHost['components'] = { SettingText: () => null, SettingNumber: () => null }
/** A host without the window's project (a test's): one object, so it is a stable snapshot. */
const NO_VALUES: Readonly<Record<string, string>> = Object.freeze({})

/** The longest a plugin's request may wait (plugins E3): an hour. */
export const MAX_PLUGIN_TIMEOUT_MS = 60 * 60_000

/** A plugin's timeout, kept only when it is a finite positive number, capped at MAX_PLUGIN_TIMEOUT_MS; else the default. */
function requestOptions(options: { timeoutMs?: unknown } | undefined): { timeoutMs: number } | undefined {
  const ms = options?.timeoutMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? { timeoutMs: Math.min(ms, MAX_PLUGIN_TIMEOUT_MS) } : undefined
}

/** Core's confirm gets the plugin's four fields as strings, nothing else of its object. */
const confirmFields = (prompt: PluginConfirmPrompt): PluginConfirmPrompt => ({
  title: String(prompt.title),
  message: String(prompt.message),
  ...(prompt.detail !== undefined ? { detail: String(prompt.detail) } : {}),
  confirmLabel: String(prompt.confirmLabel)
})

export function createClientHost(manifest: PluginManifest, backend: WindowBackend, deps: HostDeps): ClientPluginHost {
  const { id } = manifest
  const projectId = backend.plugins.projectId ?? ''
  /** The project settings the plugin's manifest declares: the only ones its host reads or writes */
  const settingKeys = Object.keys(manifest.projectSettings ?? {})
  return {
    id,
    projectId,
    request: <T>(method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }) =>
      backend.plugins.request(`${id}.${method}`, params, requestOptions(options)) as Promise<T>,
    onEvent: <T>(event: string, listener: (data: T) => void) =>
      backend.plugins.onEvent(`${id}.${event}`, (payload) => {
        if (forProject(payload, projectId)) listener(payload as T)
      }),
    onChanged: (listener) => {
      const hasPlugins = (): boolean => backend.plugins.welcome()?.plugins !== undefined
      const offPlugins = backend.plugins.onEvent('plugins.changed', (payload) => {
        if (changedFor(manifest, 'plugins.changed', payload, hasPlugins())) listener()
      })
      const offLegacy = backend.plugins.onEvent('integrations.changed', (payload) => {
        if (changedFor(manifest, 'integrations.changed', payload, hasPlugins())) listener()
      })
      // A change made while the window was offline sent nothing it heard: a reconnect is a change too.
      const offConnected = backend.plugins.onConnected(listener)
      return () => {
        offPlugins()
        offLegacy()
        offConnected()
      }
    },
    isCurrent: () => deps.currentBackend() === backend,
    prefs: {
      load: () => deps.appSettings.get().then((s) => prefsOf(s, id)),
      set: (key, value) => deps.appSettings.update({ plugins: { [id]: { [key]: value } } }).then((s) => prefsOf(s, id)),
      onChange: (listener) => {
        // Only when this plugin's prefs differ from the last ones heard: a change to other app
        // settings (or another plugin's prefs) does not call it.
        let last: string | undefined
        // Seeded from the prefs as they are now, so the first unrelated change is not heard either.
        deps.appSettings.get().then(
          (s) => {
            if (last === undefined) last = prefsKey(prefsOf(s, id))
          },
          () => {}
        )
        return deps.appSettings.onChanged((s) => {
          const prefs = prefsOf(s, id)
          const key = prefsKey(prefs)
          if (key === last) return
          last = key
          listener(prefs)
        })
      }
    },
    terminalLabel: (terminalId) => deps.terminalLabel(terminalId),
    // A stale host (the window moved on) publishes under its own backend, which nobody reads.
    setTicketInfo: (info) => (deps.ticketInfo ?? ticketInfoStore).set(backend, id, info),
    ticketIds: () => deps.ticketIds?.() ?? [],
    onTicketIdsChanged: (listener) => deps.onTicketIdsChanged?.(listener) ?? (() => {}),
    sessions: () => deps.sessions?.() ?? NO_SESSIONS,
    onSessionsChanged: (listener) => deps.onSessionsChanged?.(listener) ?? (() => {}),
    selectedTerminalId: () => deps.selectedTerminalId?.() ?? null,
    focusSession: (terminalId) => deps.focusSession?.(terminalId),
    repos: () => deps.repos?.(id) ?? NO_REPOS,
    onReposChanged: (listener) => deps.onReposChanged?.(listener) ?? (() => {}),
    // The plugin's name labels its settings in a conflict dialog.
    setRepoSettings: (repoId, values) => deps.setRepoSettings?.(id, repoId, values, manifest.name),
    setBranchSettings: (repoId, branch, values) => deps.setBranchSettings?.(id, repoId, branch, values, manifest.name),
    // Async, so a prompt whose fields can't be read rejects rather than throws.
    confirm: async (prompt) => (deps.confirm ? deps.confirm(confirmFields(prompt)) : false),
    showError: (title, message) => deps.showError?.(title, message) ?? Promise.resolve(),
    components: deps.components ?? NO_COMPONENTS,
    projectSettings: () => deps.projectSettings?.(id, settingKeys) ?? NO_VALUES,
    onProjectSettingsChanged: (listener) => deps.onProjectSettingsChanged?.(listener) ?? (() => {}),
    // The plugin's name labels the setting in a failure dialog.
    setProjectSetting: (key, value) => {
      if (settingKeys.includes(key)) deps.setProjectSetting?.(key, String(value), manifest.name)
    },
    agentModels: async (agentId) => {
      if (backend.plugins.welcome()?.capabilities?.includes(CAPABILITY.agentInfo) !== true) {
        throw new Error("This server can't list an agent's models: update it")
      }
      return backend.agents.models(String(agentId))
    }
  }
}
