// The client half of a Trek plugin (plugin system phase 1): React components for named slots in a
// project window (the desktop's and the web client's), and the host API they reach the window's
// server and this app through. A plugin's client code imports only this contract and its own
// folder; never src/renderer (scripts/pluginBoundaries.test.mjs).
//
// This module is one shared instance at run time, like React: `PluginHostContext` works only if a
// plugin and the window import the same copy. An installed plugin gets it, and React, from the
// window (globalThis.__trekPlugin, set by the renderer's pluginGlobals.ts); it must never bundle
// its own.
import { createContext, useContext, type FC } from 'react'
import type { PluginManifest, PluginPrefValue } from './manifest.ts'
import type { PrProvider } from './pullRequests.ts'
import type { TicketInfo, TicketProvider } from './tickets.ts'

export type { PluginPrefValue }

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
  /** `<id>.<method>` on the window's server */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
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
    /** In each terminal pane's corner; the wrapper takes no clicks and dims while the user types or scrolls back */
    terminalOverlay?: FC<{ terminalId: string }>
    /** A strip along the bottom of the project window, above the Global bar; the plugin sets its height */
    bottomBar?: FC
  }
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
