// The Colima plugin's state in a project window (plugins E3; the window's store before): the
// environments its poll lists, the operation running on each VM, the tool check and the registry's
// error. One window, one backend at a time: the Runtime resets it when it mounts (another backend
// remounts it) and when it unmounts.
import { create } from 'zustand'
import { deriveProfileName } from '../shared/environments.ts'
import type { EnvCheckResult, EnvironmentInfo } from '../shared/types.ts'

export type EnvBusyAction = 'start' | 'stop' | 'destroy'

interface ColimaValues {
  /** Live environments, by profile name */
  environments: Record<string, EnvironmentInfo>
  /** The operation running on each profile: spinners and disabled buttons */
  busy: Record<string, EnvBusyAction>
  /** colima and docker on the server's machine; null until checked */
  toolCheck: EnvCheckResult | null
  /** Why env.list cannot list them (its registry unreadable); null when it can */
  listError: string | null
}

interface ColimaState extends ColimaValues {
  setEnvironments(infos: EnvironmentInfo[]): void
  setBusy(profile: string, action: EnvBusyAction | null): void
  setToolCheck(result: EnvCheckResult): void
  setListError(message: string | null): void
  reset(): void
}

const empty = (): ColimaValues => ({ environments: {}, busy: {}, toolCheck: null, listError: null })

export const useColimaStore = create<ColimaState>((set) => ({
  ...empty(),
  setEnvironments: (infos) =>
    set((state) => {
      const next: Record<string, EnvironmentInfo> = {}
      for (const info of infos) next[info.profile] = info
      if (JSON.stringify(state.environments) === JSON.stringify(next)) return state
      return { environments: next }
    }),
  setBusy: (profile, action) =>
    set((state) => {
      const busy = { ...state.busy }
      if (action) busy[profile] = action
      else delete busy[profile]
      return { busy }
    }),
  setToolCheck: (toolCheck) => set({ toolCheck }),
  setListError: (listError) => set((state) => (state.listError === listError ? state : { listError })),
  reset: () => set(empty())
}))

/** The live environment of a branch's VM (`repoKey`: the path its names hash), if the poll knows one. */
export function environmentFor(environments: Record<string, EnvironmentInfo>, repoKey: string, branch: string | undefined): EnvironmentInfo | undefined {
  if (!branch) return undefined
  return environments[deriveProfileName(repoKey, branch)]
}
