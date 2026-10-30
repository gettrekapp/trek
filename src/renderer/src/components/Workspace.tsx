import { useCallback, useEffect, useState } from 'react'
import { mergedWorktrees, useAppStore } from '../store'
import { refreshEnvironments } from '../environmentActions'
import { Sidebar } from './Sidebar'
import { WorktreeDetail } from './WorktreeDetail'
import { AddWorktreeModal } from './AddWorktreeModal'
import { hostKey, sameWorktree } from '../../../shared/types'
import type { GitWorktreeInfo } from '../../../shared/types'

const POLL_MS = 5000
/**
 * Dirty/ahead/behind costs two git processes *per worktree*, so with a lot of
 * worktrees it dwarfs everything else the poll does — the worktree list
 * itself is one process per host. It gets a much slower cadence, plus a
 * targeted refresh whenever it actually matters: the list changed, the window
 * regained focus, the selection moved, or a pull/push just ran. It is also
 * gated on window focus entirely — see the sweep effect below.
 */
const STATUS_POLL_MS = 30_000
// colima list is heavier than git worktree list — poll it less often.
const ENV_POLL_MS = 10_000

/** A new/removed worktree or a moved HEAD makes the cached status stale. */
function identityChanged(before: GitWorktreeInfo[] | undefined, after: GitWorktreeInfo[]): boolean {
  if (!before || before.length !== after.length) return true
  return after.some((w, i) => before[i].path !== w.path || before[i].head !== w.head)
}

/**
 * The worktree manager: sidebar listing every git worktree of the repository
 * (local and remote), detail pane for the selected one. Polls git so
 * checkouts, new worktrees and dirty/ahead/behind states made outside the app
 * show up here.
 */
export function Workspace(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const selected = useAppStore((s) => s.selected)
  const hostWorktrees = useAppStore((s) => s.hostWorktrees)
  const [showAdd, setShowAdd] = useState(false)

  const repoPath = project?.repositoryPath
  const servers = project?.servers

  // One connection per configured server; reruns when servers are added,
  // edited, or removed in the Servers settings panel.
  useEffect(() => {
    if (!servers) return
    for (const server of servers) {
      void window.api.connectServer(server)
    }
  }, [servers])

  // Server connection state feeds row styling and poll gating.
  useEffect(() => {
    return window.api.onServerStatus(({ serverId, status }) => {
      useAppStore.getState().setServerStatus(serverId, status)
    })
  }, [])

  /** Dirty/ahead/behind for specific worktrees of one host. */
  const refreshStatuses = useCallback(
    async (serverId: string | undefined, paths: string[]): Promise<void> => {
      if (paths.length === 0) return
      try {
        const statuses = await window.api.worktreeStatuses(serverId ?? null, paths)
        useAppStore.getState().setWorktreeStatuses(hostKey(serverId), statuses)
      } catch {
        // host temporarily unreadable — keep the last known status
      }
    },
    []
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!repoPath) return
    const state = useAppStore.getState()
    const targets = [
      { serverId: undefined as string | undefined, repoPath },
      ...(state.project?.servers ?? []).map((s) => ({
        serverId: s.id as string | undefined,
        repoPath: s.repoPath
      }))
    ]
    await Promise.allSettled(
      targets.map(async (target) => {
        // Skip hosts that aren't reachable — keep their cached rows (greyed
        // out in the sidebar) instead of stalling the poll on timeouts.
        if (target.serverId && state.serverStatus[target.serverId] !== 'connected') return
        try {
          const infos = (
            await window.api.listWorktrees(target.serverId ?? null, target.repoPath)
          ).map((info) => ({ ...info, serverId: target.serverId }))
          const key = hostKey(target.serverId)
          const before = useAppStore.getState().hostWorktrees[key]
          useAppStore.getState().setHostWorktrees(key, infos)
          // First load, a new/removed worktree or a commit: the cached status
          // is gone or wrong, so sweep now rather than waiting out the slow
          // interval. Edits alone don't land here — those wait for the sweep.
          if (identityChanged(before, infos)) {
            void refreshStatuses(
              target.serverId,
              infos.map((info) => info.path)
            )
          }
        } catch {
          // host temporarily unreadable — keep the last known list
        }
      })
    )
  }, [repoPath, refreshStatuses])

  /** The slow sweep: every known worktree on every reachable host. */
  const sweepStatuses = useCallback(async (): Promise<void> => {
    const state = useAppStore.getState()
    if (!state.project) return
    const serverIds: (string | undefined)[] = [
      undefined,
      ...(state.project.servers ?? []).map((s) => s.id)
    ]
    await Promise.allSettled(
      serverIds.map((serverId) => {
        if (serverId && state.serverStatus[serverId] !== 'connected') return Promise.resolve()
        const known = state.hostWorktrees[hostKey(serverId)] ?? []
        return refreshStatuses(
          serverId,
          known.map((w) => w.path)
        )
      })
    )
  }, [refreshStatuses])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), POLL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // The sweep costs real CPU (seconds of it across a repo with many
  // worktrees), and nobody reads the sidebar while the app is in the
  // background — so it only ticks while the window has focus, and refocusing
  // sweeps straight away rather than waiting out the interval.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (interval) return
      void sweepStatuses()
      interval = setInterval(() => void sweepStatuses(), STATUS_POLL_MS)
    }
    const stop = (): void => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }
    if (document.hasFocus()) start()
    window.addEventListener('focus', start)
    window.addEventListener('blur', stop)
    return () => {
      stop()
      window.removeEventListener('focus', start)
      window.removeEventListener('blur', stop)
    }
  }, [sweepStatuses])

  // The selected worktree's status drives its Clean chip and Pull/Push counts,
  // so it gets a fresh read the moment the selection lands on it.
  const selectedPath = selected?.path
  const selectedServerId = selected?.serverId
  useEffect(() => {
    if (selectedPath) void refreshStatuses(selectedServerId, [selectedPath])
  }, [selectedPath, selectedServerId, refreshStatuses])

  // Environment (Colima VM) status for badges. refreshEnvironments no-ops
  // until the feature is enabled and the toolchain check has passed.
  const envEnabled = !!project?.environments?.enabled
  useEffect(() => {
    if (!envEnabled) return
    let cancelled = false
    void window.api.envCheck().then((result) => {
      if (cancelled) return
      useAppStore.getState().setEnvToolCheck(result)
      void refreshEnvironments()
    })
    const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [envEnabled])

  const worktrees = project ? mergedWorktrees(project, hostWorktrees) : []
  const selectedInfo =
    (selected ? worktrees.find((w) => sameWorktree(w, selected)) : undefined) ??
    worktrees.find((w) => w.isMain && !w.serverId)

  return (
    <div className="workspace">
      <Sidebar worktrees={worktrees} onAdd={() => setShowAdd(true)} />
      <WorktreeDetail
        info={selectedInfo}
        worktrees={worktrees}
        onWorktreesChanged={() => {
          void refresh()
          void sweepStatuses() // a pull/push just moved ahead/behind
        }}
      />
      {showAdd && (
        <AddWorktreeModal
          onClose={() => {
            setShowAdd(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
