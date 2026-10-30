import { ipcMain } from 'electron'
import { getHost } from './hosts/registry'

export function registerClaudeSessionHandlers(): void {
  // Host-local rename: both cwds are on the same machine.
  ipcMain.handle(
    'claude:migrateSession',
    async (
      _event,
      serverId: string | null,
      sessionId: string,
      fromCwd: string,
      toCwd: string
    ): Promise<boolean> => {
      return getHost(serverId).claude.migrateSession(sessionId, fromCwd, toCwd)
    }
  )

  // Cross-machine transfer (worktree move): export reads the .jsonl on the
  // source host, import writes it on the target host under the new cwd.
  ipcMain.handle(
    'claude:exportSession',
    async (_event, serverId: string | null, cwd: string, sessionId: string) => {
      return getHost(serverId).claude.exportSession(cwd, sessionId)
    }
  )

  ipcMain.handle(
    'claude:importSession',
    async (
      _event,
      serverId: string | null,
      cwd: string,
      sessionId: string,
      content: string
    ): Promise<void> => {
      await getHost(serverId).claude.importSession(cwd, sessionId, content)
    }
  )

  ipcMain.handle(
    'claude:deleteSession',
    async (_event, serverId: string | null, cwd: string, sessionId: string): Promise<void> => {
      await getHost(serverId).claude.deleteSession(cwd, sessionId)
    }
  )
}
