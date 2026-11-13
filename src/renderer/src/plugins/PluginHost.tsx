// The project window's plugins (plugin system phase 1): each built-in plugin's Runtime and slot
// components, mounted where the window's server has the plugin and it is on for the project, each
// inside its host and an error boundary (a plugin that throws hides its own UI, not the window's).
import { Component, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { PluginHostContext, type ClientPlugin, type ClientPluginHost, type PluginSlotName } from '../../../shared/plugins/client.ts'
import { BUILTIN_CLIENT_PLUGINS } from '../../../../plugins/builtin.client.ts'
import { getBackend, subscribeBackend, type WindowBackend } from '../backend'
import { useAppStore } from '../store'
import { terminalLabel } from '../terminals'
import { createClientHost } from './host'
import { pluginActive, pluginStatus, type PluginStatus } from './presence'

export interface PluginEntry {
  plugin: ClientPlugin
  status: PluginStatus
  host: ClientPluginHost
  /** The React key of the plugin's components: its id and its backend's generation */
  key: string
}

/** One host per (backend, plugin id), so a component keeps its host across renders. */
const hosts = new WeakMap<WindowBackend, Map<string, ClientPluginHost>>()

/** Each backend's number, from a counter: a plugin component's key, so another backend remounts it. */
const generations = new WeakMap<WindowBackend, number>()
let nextGeneration = 0

function generationOf(backend: WindowBackend): number {
  let generation = generations.get(backend)
  if (generation === undefined) generations.set(backend, (generation = ++nextGeneration))
  return generation
}

function hostFor(backend: WindowBackend, plugin: ClientPlugin): ClientPluginHost {
  let byId = hosts.get(backend)
  if (!byId) hosts.set(backend, (byId = new Map()))
  let host = byId.get(plugin.manifest.id)
  if (!host) {
    host = createClientHost(plugin.manifest, backend, { appSettings: window.api.appSettings, terminalLabel, currentBackend: getBackend })
    byId.set(plugin.manifest.id, host)
  }
  return host
}

/** The welcome as a stable value: re-read on every backend change (the welcome's arrival is one). */
const welcomeKey = (): string => {
  const welcome = getBackend().plugins.welcome()
  return welcome ? JSON.stringify([welcome.plugins ?? null, welcome.capabilities ?? []]) : ''
}

/** Every built-in plugin with its status in this window and its host. */
export function usePluginEntries(plugins: readonly ClientPlugin[] = BUILTIN_CLIENT_PLUGINS): PluginEntry[] {
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const key = useSyncExternalStore(subscribeBackend, welcomeKey)
  const hasProject = useAppStore((s) => s.project !== null)
  const settings = useAppStore((s) => s.project?.plugins)
  return useMemo(() => {
    // Before the project's settings are in, its on/off is not known: nothing mounts yet.
    const welcome = backend.plugins.projectId && hasProject ? backend.plugins.welcome() : undefined
    return plugins.map((plugin) => ({ plugin, status: pluginStatus(plugin.manifest, welcome, settings), host: hostFor(backend, plugin), key: `${plugin.manifest.id}:${generationOf(backend)}` }))
    // `key` stands for the welcome, which the backend holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key, hasProject, settings, plugins])
}

class PluginBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(err: unknown): void {
    console.error(`[plugin ${this.props.id}] its UI failed and is hidden`, err)
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** A plugin component inside its host and error boundary. */
export function PluginScope({ entry, children }: { entry: PluginEntry; children: ReactNode }): React.JSX.Element {
  return (
    <PluginBoundary id={entry.plugin.manifest.id}>
      <PluginHostContext.Provider value={entry.host}>{children}</PluginHostContext.Provider>
    </PluginBoundary>
  )
}

/** Each active plugin's Runtime, remounted when the window's backend changes (keyed on the backend, not its project id: another server with the same project id remounts too). */
export function PluginRuntimes(): React.JSX.Element {
  const entries = usePluginEntries()
  return (
    <>
      {entries
        .filter((e) => pluginActive(e.status) && e.plugin.Runtime)
        .map((e) => {
          const Runtime = e.plugin.Runtime!
          return (
            <PluginScope key={e.key} entry={e}>
              <Runtime />
            </PluginScope>
          )
        })}
    </>
  )
}

/** The active plugins' components for one slot, in built-in order. */
export function PluginSlot({ name }: { name: Exclude<PluginSlotName, 'settings'> }): React.JSX.Element {
  const entries = usePluginEntries()
  return (
    <>
      {entries
        .filter((e) => pluginActive(e.status) && e.plugin.slots?.[name])
        .map((e) => {
          const Slot = e.plugin.slots![name]!
          return (
            <PluginScope key={e.key} entry={e}>
              <Slot />
            </PluginScope>
          )
        })}
    </>
  )
}
