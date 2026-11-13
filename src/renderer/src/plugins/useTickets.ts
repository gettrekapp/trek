// The project window's tickets through its trackers (plugin system phase 2): the chips, the link
// dialog and quick buttons read these, never a tracker by name.
import { useMemo, useSyncExternalStore } from 'react'
import { BUILTIN_CLIENT_PLUGINS } from '../../../../plugins/builtin.client.ts'
import type { TicketProvider } from '../../../shared/plugins/tickets.ts'
import type { TicketView } from '../../../shared/tickets.ts'
import { getBackend, subscribeBackend } from '../backend'
import { useAppStore } from '../store'
import { welcomeKey } from './PluginHost'
import { activeTicketProviders, windowTicketView } from './ticketProviders'
import { ticketInfoStore } from './ticketInfo'

/**
 * The project's trackers, re-read with the backend, its welcome and the project's settings: the
 * same inputs as `currentTicketView`'s (the welcome only once the backend has a project and the
 * store has it), so the two agree.
 */
export function useTicketProviders(): TicketProvider[] {
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const key = useSyncExternalStore(subscribeBackend, welcomeKey)
  const hasProject = useAppStore((s) => s.project !== null)
  const settings = useAppStore((s) => s.project?.plugins)
  return useMemo(
    () => activeTicketProviders(BUILTIN_CLIENT_PLUGINS, backend.plugins.projectId && hasProject ? backend.plugins.welcome() : undefined, settings),
    // `key` stands for the welcome, which the backend holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, key, hasProject, settings]
  )
}

/** A function from a ticket id to its view, re-rendering on the plugins' looked-up issues. */
export function useTicketViews(): (ticketId: string) => TicketView {
  const providers = useTicketProviders()
  const project = useAppStore((s) => s.project)
  useSyncExternalStore(ticketInfoStore.subscribe, ticketInfoStore.version)
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const settings = (project ?? {}) as Readonly<Record<string, unknown>>
  return (ticketId) => windowTicketView(providers, settings, ticketId, ticketInfoStore, backend)
}

/** The same, read at the time (a quick button's click). */
export function currentTicketView(ticketId: string): TicketView {
  const backend = getBackend()
  const project = useAppStore.getState().project
  const welcome = backend.plugins.projectId && project ? backend.plugins.welcome() : undefined
  const providers = activeTicketProviders(BUILTIN_CLIENT_PLUGINS, welcome, project?.plugins)
  return windowTicketView(providers, (project ?? {}) as Readonly<Record<string, unknown>>, ticketId, ticketInfoStore, backend)
}
