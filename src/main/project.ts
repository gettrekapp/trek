import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { GitWorktreeInfo, OpenedProject, ProjectFile, RecentEntry, WorktreeChanges, WorktreeStatus } from '../shared/types'
import { getHost } from './hosts/registry'
import type { RawProjectFile } from '../shared/migration'
import { addRecent, getRecents, removeRecent } from './recents'
import { parseRecentRef } from './recentsRules'
import { decideOpen } from './windowRules'
import {
  claimProject,
  createWindow,
  fileIsOpen,
  fileOpenInOtherWindow,
  focusWindowHoldingFile,
  whileWindowPrompts,
  windowHasProject
} from './windows'

const execFileAsync = promisify(execFile)

const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]

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

export function registerProjectHandlers(): void {
  ipcMain.handle('dialog:selectDirectory', async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('project:open', async (event): Promise<OpenedProject | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      filters: PROJECT_FILTERS,
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return openForSender(event.sender, result.filePaths[0])
  })

  ipcMain.handle('project:openPath', (event, filePath: string) => openForSender(event.sender, filePath))

  ipcMain.handle('recents:get', async (): Promise<RecentEntry[]> => {
    return getRecents()
  })

  // Removes one recent (either kind) and returns the list as `recents:get` would.
  ipcMain.handle('recents:remove', async (_event, raw: unknown): Promise<RecentEntry[]> => {
    const entry = parseRecentRef(raw)
    if (!entry) throw new Error('not a recent entry')
    await removeRecent(entry)
    return getRecents()
  })

  ipcMain.handle('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

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
    'dialog:confirm',
    async (
      event,
      opts: {
        title: string
        message: string
        detail?: string
        confirmLabel: string
        cancelLabel?: string
        defaultCancel?: boolean
      }
    ): Promise<boolean> => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      // From a renderer: anything but text is made text, so a bad call never throws in the dialog.
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: String(opts.title ?? ''),
        message: String(opts.message ?? ''),
        detail: typeof opts.detail === 'string' ? opts.detail : undefined,
        buttons: [typeof opts.cancelLabel === 'string' && opts.cancelLabel ? opts.cancelLabel : 'Cancel', String(opts.confirmLabel ?? 'OK')],
        defaultId: opts.defaultCancel === true ? 0 : 1,
        cancelId: 0
      })
      return result.response === 1
    }
  )

  ipcMain.handle(
    'dialog:confirmWithCheckbox',
    async (
      event,
      opts: {
        title: string
        message: string
        detail?: string
        confirmLabel: string
        checkboxLabel: string
        checkboxChecked: boolean
      }
    ): Promise<{ confirmed: boolean; checked: boolean }> => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: ['Cancel', opts.confirmLabel],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: opts.checkboxLabel,
        checkboxChecked: opts.checkboxChecked
      })
      return { confirmed: result.response === 1, checked: result.checkboxChecked }
    }
  )

  ipcMain.handle('dialog:error', async (event, title: string, message: string): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    await dialog.showMessageBox(win, { type: 'error', title, message: title, detail: message })
  })

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

  ipcMain.handle('app:getAlertSound', async (): Promise<Uint8Array | null> => {
    try {
      const path = join(app.getAppPath(), 'resources', 'mixkit-message-pop-alert-2354.mp3')
      return new Uint8Array(await readFile(path))
    } catch {
      return null // sound file missing — alerts just stay silent
    }
  })

  ipcMain.handle('app:revealInFinder', (_event, dirPath: string): void => {
    shell.showItemInFolder(dirPath)
  })

  ipcMain.handle('app:openInVSCode', async (_event, dirPath: string): Promise<void> => {
    try {
      await execFileAsync('code', [dirPath])
    } catch {
      // `code` shell command not installed — launch the app bundle directly.
      await execFileAsync('open', ['-a', 'Visual Studio Code', dirPath])
    }
  })
}

export async function openProjectFile(filePath: string): Promise<OpenedProject> {
  const raw = await readFile(filePath, 'utf8')
  const project = JSON.parse(raw) as RawProjectFile
  if (!project.name) project.name = basename(filePath).replace(/\.trekproj$/, '')
  if (!Array.isArray(project.worktrees) && !project.repositories) project.worktrees = []
  return { filePath, project }
}
