import { primaryWorktreeId, useAppStore } from './store'
import type { PersistedTerminal, ProjectFile } from '../../shared/types'

/**
 * The live terminals of one worktree, in the shape the project file stores.
 * `remote` keeps each entry's daemon-side pty id so a relaunch or reload can
 * reattach to the still-running session instead of resuming a fresh claude.
 */
export function sessionSnapshot(worktreeId: string, remote: boolean): PersistedTerminal[] {
  const state = useAppStore.getState()
  return (state.terminalOrder[worktreeId] ?? [])
    .map((id) => state.terminals[id])
    .filter(Boolean)
    .map((meta) => ({
      title: meta.title,
      sessionId: meta.sessionId,
      ...(remote ? { ptyId: meta.id } : {}),
      ...(meta.systemPrompt ? { systemPrompt: meta.systemPrompt } : {}),
      ...(meta.sessionTypeId ? { sessionTypeId: meta.sessionTypeId } : {}),
      ...(state.terminalQueues[meta.id]?.length ? { queue: state.terminalQueues[meta.id] } : {})
    }))
}

/**
 * Saves the project, snapshotting live terminal sessions so reopening the
 * project resumes them. Prompts for a location when the project has never
 * been saved (manual ⌘S path).
 */
export async function saveProject(): Promise<void> {
  const state = useAppStore.getState()
  if (!state.project) return
  // An unloaded worktree has no live terminals — its sessions already sit on
  // the instance, so they must be carried over rather than snapshotted away.
  const snapshot: ProjectFile = {
    ...state.project,
    repositories: state.project.repositories.map((repo) => {
      const primaryId = primaryWorktreeId(repo.id)
      return {
        ...repo,
        worktrees: repo.worktrees.map((w) =>
          state.loadedWorktrees[w.id] ? { ...w, terminals: sessionSnapshot(w.id, !!w.serverId) } : w
        ),
        primaryTerminals: state.loadedWorktrees[primaryId]
          ? sessionSnapshot(primaryId, false)
          : repo.primaryTerminals
      }
    })
  }
  const savedPath = await window.api.saveProject(state.filePath, snapshot)
  if (savedPath) state.markSaved(savedPath)
}

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced background save after structural changes (new/closed tabs).
 * Does nothing for never-saved projects — auto-save must not pop a dialog.
 */
export function scheduleAutoSave(): void {
  if (!useAppStore.getState().filePath) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    // Re-check: the project may have been closed while the timer was pending.
    if (useAppStore.getState().filePath) void saveProject()
  }, 500)
}
