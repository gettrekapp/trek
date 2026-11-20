// The client half of a Trek plugin (plugin system phase 1): React components for named slots in a
// project window (the desktop's and the web client's), and the host API they reach the window's
// server and this app through. A plugin's client code imports only this contract and its own
// folder; never src/renderer (scripts/pluginBoundaries.test.mjs).
//
// This module is one shared instance at run time, like React: `PluginHostContext` works only if a
// plugin and the window import the same copy. An installed plugin gets it, and React, from the
// window (globalThis.__trekPlugin, set by the renderer's pluginGlobals.ts); it must never bundle
// its own.
import { createContext, useContext, useSyncExternalStore, type FC } from 'react'
import type { PluginManifest, PluginPrefValue, PluginSettingValues } from './manifest.ts'
import type { PrProvider } from './pullRequests.ts'
import type { TicketInfo, TicketProvider } from './tickets.ts'

export type { PluginPrefValue }

/** A worktree of the window's project as a plugin's slots see it (plugins E3) */
export interface PluginWorktree {
  /** The server's worktree id (what `worktree.*` and a plugin's own methods take); '' while the window has not mapped it yet */
  id: string
  repoId: string
  path: string
  /** Absent on a detached HEAD */
  branch?: string
  isMain: boolean
  /** Git no longer lists it on the server: nothing can run in it */
  missing: boolean
}

/** A repository of the window's project, with this plugin's settings (plugins E3) */
export interface PluginRepo {
  id: string
  name: string
  path: string
  /** This plugin's repoSettings values, a pending edit of this window included ({} when none) */
  settings: Readonly<PluginSettingValues>
  /** This plugin's branchSettings values by branch; a branch with none is left out */
  branchSettings: Readonly<Record<string, Readonly<PluginSettingValues>>>
  /** Its worktrees on the server, its main checkout among them */
  worktrees: readonly PluginWorktree[]
}

/** A Run-menu entry's dot (plugins E3): something runs, is stopped, or is busy */
export type PluginRunDot = 'running' | 'exited' | 'attention'

/** What a worktree's Run menu shows for a plugin's panel (plugins E3) */
export interface PluginPanelEntry {
  label: string
  title?: string
  /** No dot without one */
  dot?: PluginRunDot
}

/** Core's confirm dialog's question (plugins E3) */
export interface PluginConfirmPrompt {
  title: string
  message: string
  detail?: string
  confirmLabel: string
}

/** Core's Settings text field (plugins E3): a draft committed on blur (Enter for one line), a stale draft asked about */
export interface PluginSettingTextProps {
  value: string
  onCommit(value: string): void
  /** A textarea of this many rows; one line without it */
  rows?: number
  className?: string
  placeholder?: string
  title?: string
  spellCheck?: boolean
}

/** Core's Settings number field (plugins E3): committed on blur or Enter; a blank or non-positive entry commits `fallback` */
export interface PluginSettingNumberProps {
  value: number
  onCommit(value: number): void
  min?: number
  fallback: number
}

/** A session's status, as the window tracks it */
export type PluginSessionStatus = 'starting' | 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'

/** One of the window's project's sessions, as a plugin sees it (read-only) */
export interface PluginSession {
  terminalId: string
  /** The tab's title ("Claude 2") */
  label: string
  /** The agent: 'claude' | 'codex' | 'gemini' | 'grok' | 'local' */
  provider: string
  status: PluginSessionStatus
  /** It asked the user to make a call (request_decision) and is waiting */
  decision: boolean
  /** null: a Global session */
  worktreeId: string | null
  worktreeName: string | null
  branch: string | null
}

export interface ClientPluginHost {
  readonly id: string
  /** The window's project */
  readonly projectId: string
  /** `<id>.<method>` on the window's server; `timeoutMs` for a long one (plugins E3; the default is a minute) */
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
  /**
   * `<id>.<event>` from the window's server; an event whose payload names another `projectId` is
   * not delivered. Returns the unsubscribe.
   */
  onEvent<T = unknown>(event: string, listener: (data: T) => void): () => void
  /**
   * The plugin's server-wide state changed (`plugins.changed`, or `integrations.changed` from an
   * older server), or may have while the window was offline (its connection came back up); returns
   * the unsubscribe
   */
  onChanged(listener: () => void): () => void
  /** Whether this host still serves the window (false once it moved to another server or project) */
  isCurrent(): boolean
  /** This app's preferences for the plugin, shared by its windows */
  readonly prefs: {
    load(): Promise<Record<string, PluginPrefValue>>
    /** Resolves the plugin's preferences after the change */
    set(key: string, value: PluginPrefValue | null): Promise<Record<string, PluginPrefValue>>
    /** A change made in any window; returns the unsubscribe */
    onChange(listener: (prefs: Record<string, PluginPrefValue>) => void): () => void
  }
  /** A session's label as the window shows it ("Claude 2", the worktree's name) */
  terminalLabel(terminalId: string): string
  /**
   * This plugin's looked-up tickets (phase 2), by ticket id: replaces what it published before. The
   * window's ticket chips show their status and title.
   */
  setTicketInfo(info: Readonly<Record<string, TicketInfo>>): void
  /** The ticket ids the window's project's branches link to, once each (phase 2) */
  ticketIds(): string[]
  /** Called when that set changes; returns the unsubscribe */
  onTicketIdsChanged(listener: () => void): () => void
  /** The project's sessions in the project's worktree order (worktrees, then Global); the same array until something changes */
  sessions(): readonly PluginSession[]
  /** Called when that list, a session's status or decision, or the selected session changes; returns the unsubscribe */
  onSessionsChanged(listener: () => void): () => void
  /** The session the window shows (the Global panel's while it is open), or null */
  selectedTerminalId(): string | null
  /** Shows that session: selects its worktree (or opens the Global panel) and its tab. Unknown ids do nothing. */
  focusSession(terminalId: string): void
  /** The window's project's repositories with this plugin's settings (plugins E3); [] before the project is in. The same array until it changes. */
  repos(): readonly PluginRepo[]
  /** Called when repos() may have changed; returns the unsubscribe */
  onReposChanged(listener: () => void): () => void
  /**
   * This plugin's settings for a repository (plugins E3): `values` replaces them ({} clears). Saved on
   * the server as a compare-and-set; repos() shows it at once, while it is pending.
   */
  setRepoSettings(repoId: string, values: PluginSettingValues): void
  /** This plugin's settings for a branch (plugins E3), as setRepoSettings */
  setBranchSettings(repoId: string, branch: string, values: PluginSettingValues): void
  /** Core's confirm dialog (plugins E3) */
  confirm(prompt: PluginConfirmPrompt): Promise<boolean>
  /** Core's error dialog (plugins E3) */
  showError(title: string, message: string): Promise<void>
  /** Core's Settings fields (plugins E3) */
  readonly components: { SettingText: FC<PluginSettingTextProps>; SettingNumber: FC<PluginSettingNumberProps> }
}

export interface SessionIndicatorProps {
  terminalId: string
  /**
   * The tab's status as the window tracks it (null: not known yet). The tab can exist before, or
   * after, `sessions()` lists its session: draw from this then, so the tab is never blank.
   */
  status: PluginSessionStatus | null
  onToggleComplete?: () => void
}

/** A worktree slot's props (plugins E3) */
export interface WorktreeSlotProps {
  worktree: PluginWorktree
}

/** An entry in a worktree's Run menu and the panel it opens (plugins E3) */
export interface WorktreePanelSlot {
  /**
   * The entry for this worktree, or null to leave it out. Called while the window renders, so no
   * hooks: read the plugin's own state and host.repos(). `subscribe` says when the answer may change.
   */
  entry(host: ClientPluginHost, worktree: PluginWorktree): PluginPanelEntry | null
  /** Calls `listener` when the plugin's own state behind `entry` changes; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  /** The panel, mounted while the entry shows; `visible` while it is the worktree's open panel */
  Component: FC<WorktreeSlotProps & { visible: boolean }>
}

/**
 * The old-server fallback (a server without `worktreeTeardown`, plugins E1): what the plugin tears
 * down itself before a worktree is deleted, promoted or moved, and whether it keeps a repository in
 * its project. Remove with the fallbacks.
 */
export interface LegacyTeardownSlot {
  /**
   * What it would tear down for the worktree now, from its own state: the move dialog's `label`, the
   * confirm's `notice`; null for nothing; undefined while it can't tell yet (its first read hasn't
   * come: the move dialog waits)
   */
  part(host: ClientPluginHost, worktree: PluginWorktree): { label: string; notice: string; running: boolean } | null | undefined
  /** Tears it down: a warning to show instead of a rejection */
  run(host: ClientPluginHost, worktree: PluginWorktree): Promise<string | undefined>
  /** Why the repository can't leave its project now, or null */
  repoRemoveBlock(host: ClientPluginHost, repo: PluginRepo): string | null
  /** Calls `listener` when the plugin's own state behind `part` and `repoRemoveBlock` changes; returns the unsubscribe */
  subscribe(listener: () => void): () => void
}

export interface ClientPlugin {
  manifest: PluginManifest
  /** A ticket tracker (phase 2): the window's ticket chips and link dialog go through it where the plugin is on */
  ticketProvider?: TicketProvider
  /** A pull request host (plugins P3): the window's PR chips and dialogs go through it where the plugin is on */
  prProvider?: PrProvider
  /** Mounted once per project window while the server has the plugin and it is on for the project */
  Runtime?: FC
  slots?: {
    /** A Settings section, after the Plugins list */
    settings?: FC
    /** In the sidebar's top bar, beside the worktree filter (the voice plugin's Active/Busy) */
    sidebarToolbar?: FC
    /** Over the window (a floating bubble) */
    overlay?: FC
    /**
     * On each session tab (a worktree's and the Global panel's), in place of the core status badge.
     * Only the first active plugin that fills it is used. `onToggleComplete`: the badge's
     * mark-complete click (absent while offline).
     */
    sessionIndicator?: FC<SessionIndicatorProps>
    /** In each terminal pane's corner; the wrapper takes no clicks and dims while the user types or scrolls back. No built-in plugin fills it now (campsite moved to terminalBarEnd). */
    terminalOverlay?: FC<{ terminalId: string }>
    /**
     * At the right end of each terminal's quick button row, before the queue chip. Its wrapper is
     * 24 px tall, bottom-aligned, under 8 px of row padding: taller content rises into that padding
     * and the row keeps its height. The wrapper (`.quick-bar-end`) shrinks before the buttons do, to
     * nothing unless the plugin's CSS gives it a floor (`.quick-bar-end:has(> .its-root) { min-width }`);
     * what no longer fits is cut from the left.
     */
    terminalBarEnd?: FC<{ terminalId: string }>
    /** A strip along the bottom of the project window, above the Global bar; the plugin sets its height */
    bottomBar?: FC
    /** An entry in a worktree's Run menu, between Docker and Stack, and the panel it opens (plugins E3) */
    worktreePanel?: WorktreePanelSlot
    /** In a worktree's header, after its git chip (plugins E3); `openPanel` opens the plugin's worktreePanel */
    worktreeChip?: FC<WorktreeSlotProps & { openPanel(): void }>
    /** On a worktree's sidebar row, after its PR (plugins E3) */
    sidebarBadge?: FC<WorktreeSlotProps>
    /** `<dt>`/`<dd>` pairs in a worktree's hover card, after Git (plugins E3) */
    hoverRow?: FC<WorktreeSlotProps>
    /** A Settings tab, before Plugins, for the repository chosen there (plugins E3): core shows `title` and the repository picker */
    repoSettings?: { title: string; Component: FC<{ repo: PluginRepo }> }
  }
  /** The old-server fallback's teardown (plugins E3; LegacyTeardownSlot) */
  legacyTeardown?: LegacyTeardownSlot
  /**
   * A theme plugin's look (theme plugins; `manifest.type: 'theme'`), applied while it is the
   * window's active theme. Of a theme, the window mounts `Runtime` and the `overlay` slot only.
   */
  theme?: {
    /** CSS injected after the app's stylesheet. `<html data-theme="<id>">` is set, to scope rules by. */
    styles?: string
  }
}

export type PluginSlotName = keyof NonNullable<ClientPlugin['slots']>

/** A slot's props (`{}` for the slots that take none) */
export type PluginSlotProps<N extends PluginSlotName> = NonNullable<ClientPlugin['slots']>[N] extends FC<infer P> | undefined ? P : never

/** The slots PluginSlot mounts, each active plugin's component (the others have mounts of their own) */
export type MultiSlotName = 'sidebarToolbar' | 'overlay' | 'terminalOverlay' | 'terminalBarEnd' | 'bottomBar'

/** Types a plugin's client half. */
export const defineClientPlugin = (plugin: ClientPlugin): ClientPlugin => plugin

/** Provided by the window around each of a plugin's components (the renderer's PluginHostProvider). */
export const PluginHostContext = createContext<ClientPluginHost | null>(null)

/** The host of the plugin whose component this is. */
export function usePluginHost(): ClientPluginHost {
  const host = useContext(PluginHostContext)
  if (!host) throw new Error('usePluginHost() outside a plugin component')
  return host
}

/** The host's repos(), kept current (plugins E3). */
export function usePluginRepos(): readonly PluginRepo[] {
  const host = usePluginHost()
  return useSyncExternalStore(host.onReposChanged, host.repos)
}
