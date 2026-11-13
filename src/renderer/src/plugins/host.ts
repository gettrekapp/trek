// A plugin's host in a project window (plugin system phase 1): its `<id>.*` requests and events
// on the window's backend, its per-app preferences in the app settings, and the window's session
// labels. One per (backend, plugin): a window that moves to another server or project gets new ones.
import type { ClientPluginHost } from '../../../shared/plugins/client.ts'
import type { PluginManifest, PluginPrefValue } from '../../../shared/plugins/manifest.ts'
import type { AppSettings } from '../../../shared/appSettings.ts'
import type { WindowBackend } from '../backend'
import { changedFor, forProject } from './presence.ts'

export interface AppSettingsApi {
  get(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  onChanged(callback: (settings: AppSettings) => void): () => void
}

export interface HostDeps {
  appSettings: AppSettingsApi
  terminalLabel(terminalId: string): string
  /** The window's backend now (getBackend) */
  currentBackend(): WindowBackend
}

const prefsOf = (settings: AppSettings, id: string): Record<string, PluginPrefValue> =>
  Object.hasOwn(settings.plugins, id) ? { ...settings.plugins[id] } : {}

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
      return () => {
        offPlugins()
        offLegacy()
      }
    },
    isCurrent: () => deps.currentBackend() === backend,
    prefs: {
      load: () => deps.appSettings.get().then((s) => prefsOf(s, id)),
      set: (key, value) => deps.appSettings.update({ plugins: { [id]: { [key]: value } } } as unknown as Partial<AppSettings>).then((s) => prefsOf(s, id)),
      onChange: (listener) => deps.appSettings.onChanged((s) => listener(prefsOf(s, id)))
    },
    terminalLabel: (terminalId) => deps.terminalLabel(terminalId)
  }
}
