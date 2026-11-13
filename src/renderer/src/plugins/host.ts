// A plugin's host in a project window (plugin system phase 1): its `<id>.*` requests and events
// on the window's backend, its per-app preferences in the app settings, and the window's session
// labels. One per (backend, plugin): a window that moves to another server or project gets new ones.
import type { ClientPluginHost } from '../../../shared/plugins/client.ts'
import type { PluginManifest, PluginPrefValue } from '../../../shared/plugins/manifest.ts'
import type { AppSettings, AppSettingsPatch } from '../../../shared/appSettings.ts'
import type { WindowBackend } from '../backend'
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
}

const prefsOf = (settings: AppSettings, id: string): Record<string, PluginPrefValue> =>
  Object.hasOwn(settings.plugins, id) ? { ...settings.plugins[id] } : {}

/** A plugin's prefs as a value to compare: its entries sorted by key. */
const prefsKey = (prefs: Record<string, PluginPrefValue>): string => JSON.stringify(Object.entries(prefs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export function createClientHost(manifest: PluginManifest, backend: WindowBackend, deps: HostDeps): ClientPluginHost {
  const { id } = manifest
  const projectId = backend.plugins.projectId ?? ''
  return {
    id,
    projectId,
    request: <T>(method: string, params: Record<string, unknown> = {}) => backend.plugins.request(`${id}.${method}`, params) as Promise<T>,
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
    onTicketIdsChanged: (listener) => deps.onTicketIdsChanged?.(listener) ?? (() => {})
  }
}
