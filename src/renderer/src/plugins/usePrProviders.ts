// The project window's pull request hosts (plugins P3), as a hook: the chips, the PR dialog and Add
// Worktree read these, never a host by name.
import { useMemo, useSyncExternalStore } from 'react'
import { BUILTIN_CLIENT_PLUGINS } from '../../../../plugins/builtin.client.ts'
import type { PrProvider } from '../../../shared/plugins/pullRequests.ts'
import { getBackend, subscribeBackend } from '../backend'
import { useAppStore } from '../store'
import { welcomeKey } from './PluginHost'
import { activePrProviders } from './prProviders'

/** The window's PR providers, re-read with the backend, its welcome and the project's settings (as useTicketProviders). */
export function usePrProviders(): PrProvider[] {
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const key = useSyncExternalStore(subscribeBackend, welcomeKey)
  const hasProject = useAppStore((s) => s.project !== null)
  const settings = useAppStore((s) => s.project?.plugins)
  return useMemo(
    () => activePrProviders(BUILTIN_CLIENT_PLUGINS, backend.plugins.projectId && hasProject ? backend.plugins.welcome() : undefined, settings),
    // `key` stands for the welcome, which the backend holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, key, hasProject, settings]
  )
}

/**
 * Whether the window knows which PR providers are on: the server's welcome (with its plugins) and
 * the project are in. Before that usePrProviders() is empty without meaning none is on.
 */
export function usePrProvidersKnown(): boolean {
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const key = useSyncExternalStore(subscribeBackend, welcomeKey)
  const hasProject = useAppStore((s) => s.project !== null)
  return !!backend.plugins.projectId && hasProject && key !== ''
}
