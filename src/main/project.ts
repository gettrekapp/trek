import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { GitWorktreeInfo, OpenedProject, ProjectFile, WorktreeChanges, WorktreeStatus } from '../shared/types'
import { getHost } from './hosts/registry'
import type { RawProjectFile } from '../shared/migration'
import { addRecent } from './recents'
import { decideOpen } from './windowRules'
import { openTrekproj, PROJECT_FILTERS } from './importUi'
import {
  claimProject,
  createWindow,
  fileIsOpen,
  fileOpenInOtherWindow,
  focusWindowHoldingFile,
  whileWindowPrompts,
  windowHasProject
} from './windows'

/** Null when the project ended up in another window: the sender has nothing to load. */
async function openForSender(sender: WebContents, filePath: string): Promise<OpenedProject | null> {
  // Read first, so a bad file errors in the window that asked for it.
  const opened = await openProjectFile(filePath)
  switch (decideOpen(windowHasProject(sender), fileIsOpen(filePath))) {
    case 'focus-existing':
      focusWindowHoldingFile(filePath)
      return null
    case 'new-window':
      createWindow({ initialTarget: { kind: 'file', path: filePath } })
      await addRecent(opened.filePath)
      return null
    case 'use-sender':
      claimProject(sender, filePath)
      await addRecent(opened.filePath)
      return opened
  }
}

/**
 * A .trekproj as a file window (phase 4d: only as the fallback, or without the Local server):
 * the sender takes it, or (no sender: macOS opened it) a window of its own does.
 */
export async function openLegacy(sender: WebContents | null, filePath: string): Promise<OpenedProject | null> {
  if (sender) return openForSender(sender, filePath)
  if (fileIsOpen(filePath)) {
    focusWindowHoldingFile(filePath)
    return null
  }
  const opened = await openProjectFile(filePath)
  createWindow({ initialTarget: { kind: 'file', path: filePath } })
  await addRecent(opened.filePath)
  return null
}

export function registerProjectHandlers(): void {
  ipcMain.handle('project:open', async (event): Promise<OpenedProject | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      filters: PROJECT_FILTERS,
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return openTrekproj(event.sender, result.filePaths[0], openLegacy)
  })

  ipcMain.handle('project:openPath', (event, filePath: string) => openTrekproj(event.sender, filePath, openLegacy))

  ipcMain.handle(
    'project:save',
    async (event, filePath: string | null, project: ProjectFile): Promise<string | null> => {
      let target = filePath
      if (!target) {
        const win = BrowserWindow.fromWebContents(event.sender)!
        const result = await whileWindowPrompts(event.sender, () =>
          dialog.showSaveDialog(win, {
            title: 'Save Project',
            defaultPath: `${project.name || 'project'}.trekproj`,
            filters: PROJECT_FILTERS
          })
        )
        if (result.canceled || !result.filePath) return null
        target = result.filePath
      }
      // Two windows on one file would keep overwriting each other.
      if (fileOpenInOtherWindow(event.sender, target)) {
        const win = BrowserWindow.fromWebContents(event.sender)!
        await whileWindowPrompts(event.sender, () =>
          dialog.showMessageBox(win, {
            type: 'error',
            message: 'That project is open in another window',
            detail: `Close it there before saving over ${target}.`
          })
        )
        return null
      }
      await writeFile(target, JSON.stringify(project, null, 2), 'utf8')
      claimProject(event.sender, target)
      await addRecent(target)
      return target
    }
  )

  ipcMain.handle(
    'git:listWorktrees',
    async (_event, serverId: string | null, repoPath: string): Promise<GitWorktreeInfo[]> => {
      return getHost(serverId).git.listWorktrees(repoPath)
    }
  )

  ipcMain.handle(
    'git:worktreeStatuses',
    async (
      _event,
      serverId: string | null,
      worktreePaths: string[]
    ): Promise<WorktreeStatus[]> => {
      return getHost(serverId).git.worktreeStatuses(worktreePaths)
    }
  )

  ipcMain.handle(
    'git:worktreeChanges',
    async (_event, serverId: string | null, worktreePath: string): Promise<WorktreeChanges> => {
      return getHost(serverId).git.worktreeChanges(worktreePath)
    }
  )

  ipcMain.handle(
    'git:worktreeDiff',
    async (
      _event,
      serverId: string | null,
      worktreePath: string
    ): Promise<Record<string, string>> => {
      return getHost(serverId).git.worktreeDiff(worktreePath)
    }
  )

  ipcMain.handle(
    'git:listBranches',
    async (_event, serverId: string | null, repoPath: string): Promise<string[]> => {
      return getHost(serverId).git.listBranches(repoPath)
    }
  )

  ipcMain.handle(
    'git:addWorktree',
    async (
      _event,
      serverId: string | null,
      repoPath: string,
      worktreePath: string,
      branch: string,
      createBranch: boolean
    ): Promise<void> => {
      await getHost(serverId).git.addWorktree(repoPath, worktreePath, branch, createBranch)
    }
  )

  // Refuses (throws) if the worktree has uncommitted changes — deliberately no --force.
  ipcMain.handle(
    'git:removeWorktree',
    async (_event, serverId: string | null, repoPath: string, worktreePath: string): Promise<void> => {
      await getHost(serverId).git.removeWorktree(repoPath, worktreePath)
    }
  )

  ipcMain.handle(
    'git:checkout',
    async (_event, serverId: string | null, repoPath: string, branch: string): Promise<void> => {
      await getHost(serverId).git.checkout(repoPath, branch)
    }
  )

  ipcMain.handle(
    'git:defaultBranch',
    async (_event, serverId: string | null, repoPath: string): Promise<string | null> => {
      return getHost(serverId).git.defaultBranch(repoPath)
    }
  )

  // Worktree-move support (see worktreeActions.ts moveWorktree)
  ipcMain.handle(
    'git:exportDirtyPatch',
    async (_event, serverId: string | null, worktreePath: string) => {
      return getHost(serverId).git.exportDirtyPatch(worktreePath)
    }
  )

  ipcMain.handle(
    'git:applyPatch',
    async (_event, serverId: string | null, worktreePath: string, patch: string): Promise<void> => {
      await getHost(serverId).git.applyPatch(worktreePath, patch)
    }
  )

  ipcMain.handle(
    'git:revParseHead',
    async (_event, serverId: string | null, worktreePath: string): Promise<string> => {
      return getHost(serverId).git.revParseHead(worktreePath)
    }
  )

  ipcMain.handle(
    'git:push',
    async (_event, serverId: string | null, worktreePath: string, branch: string): Promise<void> => {
      await getHost(serverId).git.push(worktreePath, branch, true)
    }
  )

  ipcMain.handle(
    'git:pull',
    async (_event, serverId: string | null, worktreePath: string, branch: string): Promise<void> => {
      await getHost(serverId).git.pull(worktreePath, branch)
    }
  )

  ipcMain.handle(
    'git:fetchBranch',
    async (_event, serverId: string | null, repoPath: string, branch: string): Promise<void> => {
      await getHost(serverId).git.fetchBranch(repoPath, branch)
    }
  )

  ipcMain.handle(
    'git:fetchPullRequestHead',
    async (
      _event,
      serverId: string | null,
      repoPath: string,
      prNumber: number,
      branch: string
    ): Promise<void> => {
      await getHost(serverId).git.fetchPullRequestHead(repoPath, prNumber, branch)
    }
  )

  ipcMain.handle(
    'git:addWorktreeAt',
    async (
      _event,
      serverId: string | null,
      repoPath: string,
      worktreePath: string,
      branch: string
    ): Promise<void> => {
      await getHost(serverId).git.addWorktreeAt(repoPath, worktreePath, branch)
    }
  )

  ipcMain.handle(
    'git:removeWorktreeForce',
    async (_event, serverId: string | null, repoPath: string, worktreePath: string): Promise<void> => {
      await getHost(serverId).git.removeWorktreeForce(repoPath, worktreePath)
    }
  )

  ipcMain.handle(
    'git:linkDirs',
    async (
      _event,
      serverId: string | null,
      repoPath: string,
      worktreePath: string,
      dirs: string[]
    ): Promise<void> => {
      await getHost(serverId).git.linkDirs(repoPath, worktreePath, dirs)
    }
  )

}

export async function openProjectFile(filePath: string): Promise<OpenedProject> {
  const raw = await readFile(filePath, 'utf8')
  const project = JSON.parse(raw) as RawProjectFile
  if (!project.name) project.name = basename(filePath).replace(/\.trekproj$/, '')
  if (!Array.isArray(project.worktrees) && !project.repositories) project.worktrees = []
  return { filePath, project }
}
