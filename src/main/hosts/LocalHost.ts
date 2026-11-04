import { BrowserWindow } from 'electron'
import type { PtySpawnOptions } from '../../shared/types'
import * as gitService from '../../host/gitService'
import * as claudeSessions from '../../host/claudeSessionService'
import * as agentService from '../../host/agentService'
import { PtyService } from '../../host/ptyService'
import type { HostService } from './HostService'
import { sendToPtyWindow } from './ptyWindows'

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export class LocalHost implements HostService {
  readonly serverId = null
  private ptys = new PtyService()

  git = {
    listWorktrees: gitService.listWorktrees,
    worktreeStatuses: gitService.worktreeStatuses,
    worktreeChanges: gitService.worktreeChanges,
    worktreeDiff: gitService.worktreeDiff,
    listBranches: gitService.listBranches,
    addWorktree: gitService.addWorktree,
    removeWorktree: gitService.removeWorktree,
    checkout: gitService.checkout,
    defaultBranch: gitService.defaultBranch,
    exportDirtyPatch: gitService.exportDirtyPatch,
    applyPatch: gitService.applyPatch,
    revParseHead: gitService.revParseHead,
    push: gitService.push,
    pull: gitService.pull,
    fetchBranch: gitService.fetchBranch,
    fetchPullRequestHead: gitService.fetchPullRequestHead,
    addWorktreeAt: gitService.addWorktreeAt,
    removeWorktreeForce: gitService.removeWorktreeForce,
    linkDirs: gitService.linkDirs
  }

  pty = {
    spawn: async (opts: PtySpawnOptions): Promise<void> => {
      this.ptys.spawn(opts, {
        onData: (data) => sendToPtyWindow('pty:data', { id: opts.id, data }),
        onExit: (exitCode) => sendToPtyWindow('pty:exit', { id: opts.id, exitCode })
      })
    },
    write: (id: string, data: string): void => this.ptys.write(id, data),
    resize: (id: string, cols: number, rows: number): void => this.ptys.resize(id, cols, rows),
    dispose: (id: string): void => this.ptys.dispose(id),
    // A local shell cannot outlive the app, so detaching is just killing it.
    detach: (id: string): void => this.ptys.dispose(id)
  }

  claude = {
    migrateSession: claudeSessions.migrateSession,
    exportSession: claudeSessions.exportSession,
    importSession: claudeSessions.importSession,
    deleteSession: claudeSessions.deleteSession
  }

  agents = {
    discoverCodexSession: async (cwd: string, ageMs: number, exclude: string[]) =>
      (await agentService.discoverCodexSession(cwd, ageMs, exclude)) ?? null,
    commandExists: agentService.commandExists
  }

  disposeAllPtys(): void {
    this.ptys.disposeAll()
  }
}
