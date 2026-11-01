import { ipcMain } from 'electron'
import type { PtySpawnOptions } from '../shared/types'
import { deletePtyOwner, getHost, getPtyOwner, localHost, setPtyOwner } from './hosts/registry'
import { deletePtyWindow, ptysOfWindow, setPtyWindow } from './hosts/ptyWindows'

function forgetPty(id: string): void {
  deletePtyOwner(id)
  deletePtyWindow(id)
}

export function registerPtyHandlers(): void {
  ipcMain.handle('pty:spawn', async (event, opts: PtySpawnOptions) => {
    const host = getHost(opts.serverId)
    setPtyOwner(opts.id, host)
    setPtyWindow(opts.id, event.sender)
    try {
      await host.pty.spawn(opts)
    } catch (err) {
      forgetPty(opts.id)
      throw err
    }
  })

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    getPtyOwner(id)?.pty.write(id, data)
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) getPtyOwner(id)?.pty.resize(id, cols, rows)
  })

  ipcMain.on('pty:dispose', (_event, id: string) => {
    getPtyOwner(id)?.pty.dispose(id)
    forgetPty(id)
  })

  ipcMain.on('pty:detach', (_event, id: string) => {
    getPtyOwner(id)?.pty.detach(id)
    forgetPty(id)
  })
}

/** A closed window's local shells die; its remote ptys keep running on their daemons. */
export function releaseWindowPtys(windowId: number): void {
  for (const id of ptysOfWindow(windowId)) {
    getPtyOwner(id)?.pty.detach(id)
    forgetPty(id)
  }
}

export function disposeAllPtys(): void {
  // Local shells die with the app; remote ptys keep running on their daemons
  // by design — the app reattaches on next launch.
  localHost.disposeAllPtys()
}
