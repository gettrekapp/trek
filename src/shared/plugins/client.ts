// The client half of a Trek plugin (plugin system phase 1): React components for named slots in a
// project window (the desktop's and the web client's), and the host API they reach the window's
// server and this app through. A plugin's client code imports only this contract and its own
// folder; never src/renderer (scripts/pluginBoundaries.test.mjs).
//
// This module is one shared instance at run time, like React: `PluginHostContext` works only if a
// plugin and the window import the same copy. An installable plugin (a later phase) gets it, and
// React, from the app as externals; it must never bundle its own.
import { createContext, useContext, type FC } from 'react'
import type { PluginManifest, PluginPrefValue } from './manifest.ts'
import type { TicketInfo, TicketProvider } from './tickets.ts'

export type { PluginPrefValue }

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
  /** The plugin's server-wide state changed (`plugins.changed`, or `integrations.changed` from an older server); returns the unsubscribe */
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
}

export interface ClientPlugin {
  manifest: PluginManifest
  /** A ticket tracker (phase 2): the window's ticket chips and link dialog go through it where the plugin is on */
  ticketProvider?: TicketProvider
  /** Mounted once per project window while the server has the plugin and it is on for the project */
  Runtime?: FC
  slots?: {
    /** A Settings section, after the Plugins list */
    settings?: FC
    /** In the sidebar's top bar, beside the worktree filter (the voice plugin's Active/Busy) */
    sidebarToolbar?: FC
    /** Over the window (a floating bubble) */
    overlay?: FC
  }
}

export type PluginSlotName = keyof NonNullable<ClientPlugin['slots']>

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
