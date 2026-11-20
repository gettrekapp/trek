// The project window's plugins (plugin system phase 1): each built-in plugin's Runtime and slot
// components, mounted where the window's server has the plugin and it is on for the project, each
// inside its host and an error boundary (a plugin that throws hides its own UI, not the window's).
import { Component, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { PluginHostContext, type ClientPlugin, type ClientPluginHost, type MultiSlotName, type PluginRepo, type PluginSlotProps } from '../../../shared/plugins/client.ts'
import { BUILTIN_CLIENT_PLUGINS } from '../../../../plugins/builtin.client.ts'
import { getBackend, subscribeBackend, type WindowBackend } from '../backend'
import { allBranchTickets, allWorktrees, GLOBAL_WORKTREE_ID, useAppStore } from '../store'
import { revealTerminal, terminalLabel } from '../terminals'
import { SettingNumber, SettingText } from '../components/SettingText'
import type { ProjectFile, WorktreeInstance } from '../../../shared/types'
import { createClientHost, type HostDeps } from './host'
import { cachedProjectSettings, cachedRepos } from './projectView'
import { pluginActive, pluginRequired, pluginStatus, type PluginStatus } from './presence'
import { sessionsSource, type SessionsSource } from './sessions.ts'
import { activeSlotEntries } from './slots.ts'

export interface PluginEntry {
  plugin: ClientPlugin
  status: PluginStatus
  /** The server lists it as required (plugins A1b): its switch is locked on */
  required: boolean
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

let sessionView: SessionsSource | null = null
/** allWorktrees(project), kept while the project object is the same (a new array would defeat the view's memo) */
let worktreesOf: { project: ProjectFile | null; list: WorktreeInstance[] } = { project: null, list: [] }
const projectWorktrees = (project: ProjectFile | null): WorktreeInstance[] => {
  if (worktreesOf.project !== project) worktreesOf = { project, list: project ? allWorktrees(project) : [] }
  return worktreesOf.list
}
/** The window's session view, made on first use */
function windowSessions(): SessionsSource {
  if (!sessionView) {
    sessionView = sessionsSource(() => {
      const s = useAppStore.getState()
      return {
        worktrees: projectWorktrees(s.project),
        globalId: GLOBAL_WORKTREE_ID,
        terminals: s.terminals,
        terminalOrder: s.terminalOrder,
        decisions: s.decisions,
        activeWorktreeId: s.activeWorktreeId,
        activeTerminal: s.activeTerminal,
        globalPanelOpen: s.globalPanelOpen
      }
    }, useAppStore.subscribe)
  }
  return sessionView
}

/** The window's repositories as each plugin sees them (plugins E3): the same array while nothing changed. */
const windowRepos = cachedRepos(
  () => {
    const state = useAppStore.getState()
    return { project: state.project, hostWorktrees: state.hostWorktrees, backend: getBackend() }
  },
  (path) => getBackend().plugins.worktreeId(path)
)

/** The window's project's values of each plugin's project settings (plugins A2) */
const windowProjectSettings = cachedProjectSettings(() => useAppStore.getState().project)

/** What every plugin host in this window is built with. */
const hostDeps = (): HostDeps => ({
  appSettings: window.api.appSettings,
  terminalLabel,
  currentBackend: getBackend,
  ticketIds: projectTicketIds,
  onTicketIdsChanged: (listener) => {
    let last = projectTicketIds().join('\n')
    return useAppStore.subscribe(() => {
      const now = projectTicketIds().join('\n')
      if (now === last) return
      last = now
      listener()
    })
  },
  sessions: () => windowSessions().sessions(),
  onSessionsChanged: (listener) => windowSessions().onChanged(listener),
  selectedTerminalId: () => windowSessions().selected(),
  focusSession: (terminalId) => {
    // Real sessions only: revealTerminal special-cases the bot's decision id and clears quiet state before its own check.
    if (Object.hasOwn(useAppStore.getState().terminals, terminalId)) revealTerminal(terminalId)
  },
  repos: windowRepos,
  onReposChanged: (listener) => {
    const offStore = useAppStore.subscribe((state, previous) => {
      if (state.project !== previous.project || state.hostWorktrees !== previous.hostWorktrees) listener()
    })
    const offBackend = subscribeBackend(listener)
    return () => {
      offStore()
      offBackend()
    }
  },
  setRepoSettings: (pluginId, repoId, values, label) => useAppStore.getState().setPluginRepoSettings(pluginId, repoId, values, label),
  setBranchSettings: (pluginId, repoId, branch, values, label) => useAppStore.getState().setPluginBranchSettings(pluginId, repoId, branch, values, label),
  confirm: (prompt) => window.api.confirm(prompt),
  showError: (title, message) => window.api.showError(title, message),
  components: { SettingText, SettingNumber },
  projectSettings: windowProjectSettings,
  onProjectSettingsChanged: (listener) =>
    useAppStore.subscribe((state, previous) => {
      if (state.project !== previous.project) listener()
    }),
  setProjectSetting: (key, value, label) => useAppStore.getState().setPluginSetting(key, value, label)
})

function hostFor(backend: WindowBackend, plugin: ClientPlugin): ClientPluginHost {
  let byId = hosts.get(backend)
  if (!byId) hosts.set(backend, (byId = new Map()))
  let host = byId.get(plugin.manifest.id)
  if (!host) {
    host = createClientHost(plugin.manifest, backend, hostDeps())
    byId.set(plugin.manifest.id, host)
  }
  return host
}

/** Themes' hosts, apart from the built-ins': an installed theme may carry any id. */
const themeHosts = new WeakMap<WindowBackend, Map<string, ClientPluginHost>>()

/** A theme's repos(): none, one array so it is a stable snapshot. */
const THEME_REPOS: readonly PluginRepo[] = []
/** A theme's projectSettings(): none, one object so it is a stable snapshot. */
const THEME_VALUES: Readonly<Record<string, string>> = Object.freeze({})

/**
 * The window's active theme as an entry for PluginScope (theme plugins). Its host has no server
 * half: `request` rejects, `onEvent` never fires and it publishes no ticket info; `prefs` works. It
 * sees no repositories, writes no settings and shows no dialogs (plugins E3).
 */
export function themeEntry(backend: WindowBackend, plugin: ClientPlugin): PluginEntry {
  let byId = themeHosts.get(backend)
  if (!byId) themeHosts.set(backend, (byId = new Map()))
  let host = byId.get(plugin.manifest.id)
  if (!host) {
    host = {
      ...createClientHost(plugin.manifest, backend, hostDeps()),
      request: () => Promise.reject(new Error('A theme has no server half to ask')),
      onEvent: () => () => {},
      setTicketInfo: () => {},
      repos: () => THEME_REPOS,
      onReposChanged: () => () => {},
      setRepoSettings: () => {},
      setBranchSettings: () => {},
      confirm: () => Promise.resolve(false),
      showError: () => Promise.resolve(),
      projectSettings: () => THEME_VALUES,
      onProjectSettingsChanged: () => () => {},
      setProjectSetting: () => {},
      agentModels: () => Promise.reject(new Error('A theme has no server half to ask'))
    }
    byId.set(plugin.manifest.id, host)
  }
  return { plugin, status: 'on', required: false, host, key: `theme:${plugin.manifest.id}:${generationOf(backend)}` }
}

/** The window's project's linked ticket ids, once each, sorted. */
function projectTicketIds(): string[] {
  return [...new Set(allBranchTickets(useAppStore.getState().project))].sort()
}

/** The welcome as a stable value: re-read on every backend change (the welcome's arrival is one). */
export const welcomeKey = (): string => {
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
    return plugins.map((plugin) => ({
      plugin,
      status: pluginStatus(plugin.manifest, welcome, settings),
      required: pluginRequired(plugin.manifest, welcome),
      host: hostFor(backend, plugin),
      key: `${plugin.manifest.id}:${generationOf(backend)}`
    }))
    // `key` stands for the welcome, which the backend holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key, hasProject, settings, plugins])
}

/** The entries as the window has them now, outside React (the old-server teardown fallbacks, plugins E3). */
export function pluginEntriesNow(backend: WindowBackend = getBackend(), plugins: readonly ClientPlugin[] = BUILTIN_CLIENT_PLUGINS): PluginEntry[] {
  const state = useAppStore.getState()
  const welcome = backend.plugins.projectId && state.project ? backend.plugins.welcome() : undefined
  return plugins.map((plugin) => ({
    plugin,
    status: pluginStatus(plugin.manifest, welcome, state.project?.plugins),
    required: pluginRequired(plugin.manifest, welcome),
    host: hostFor(backend, plugin),
    key: `${plugin.manifest.id}:${generationOf(backend)}`
  }))
}

class PluginBoundary extends Component<{ id: string; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(err: unknown): void {
    console.error(`[plugin ${this.props.id}] its UI failed and is hidden`, err)
  }
  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children
  }
}

/** A plugin component inside its host and error boundary. */
export function PluginScope({ entry, fallback, children }: { entry: PluginEntry; fallback?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <PluginBoundary id={entry.plugin.manifest.id} fallback={fallback}>
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

type MultiSlot = MultiSlotName
/** `props` is required where the slot's props have required keys (terminalOverlay's terminalId) */
type SlotArgs<N extends MultiSlot> = { name: N } & ({} extends PluginSlotProps<N> ? { props?: PluginSlotProps<N> } : { props: PluginSlotProps<N> })

/** The active plugins' components for one slot, in built-in order. */
export function PluginSlot<N extends MultiSlot>({ name, props }: SlotArgs<N>): React.JSX.Element {
  const entries = usePluginEntries()
  return (
    <>
      {activeSlotEntries(entries, name).map((e) => {
        // The signature ties `props` to `name`; inside, a generic conditional type can't be spread.
        const Slot = e.plugin.slots![name]! as React.FC<object>
        return (
          <PluginScope key={e.key} entry={e}>
            <Slot {...((props ?? {}) as object)} />
          </PluginScope>
        )
      })}
    </>
  )
}
