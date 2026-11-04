import { ipcMain } from 'electron'
import { getHost } from './hosts/registry'

export function registerAgentHandlers(): void {
  ipcMain.handle(
    'agents:discoverCodexSession',
    (_event, serverId: string | null, cwd: string, since: number, exclude: string[]) =>
      getHost(serverId).agents.discoverCodexSession(cwd, since, exclude)
  )
  ipcMain.handle('agents:commandExists', (_event, serverId: string | null, command: string) =>
    getHost(serverId).agents.commandExists(command)
  )
}
