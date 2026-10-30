import { app, BrowserWindow, Menu, nativeImage } from 'electron'
import { join } from 'node:path'

// icon.png is extracted from AppIcon.icns (the packaging icon) — nativeImage
// needs a PNG for the runtime dock icon.
const APP_ICON = join(app.getAppPath(), 'resources', 'icon.png')

app.setName('Trek Dev')

function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(APP_ICON)
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}
import { registerPtyHandlers, disposeAllPtys } from './pty'
import { registerProjectHandlers } from './project'
import { registerGithubHandlers } from './github'
import { registerLinearHandlers } from './linear'
import { registerSkillHandlers } from './skills'
import { registerDockerHandlers } from './docker'
import { registerEnvironmentHandlers } from './environments'
import { registerStackHandlers } from './stacks'
import { registerClaudeSessionHandlers } from './claudeSessions'
import { registerServerHandlers, disconnectAllServers } from './servers'
import { registerMcpHandlers } from './mcp'
import { registerVoiceHandlers } from './voice'
import { fixPath } from './env'
import { openUrl } from './openUrl'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Trek Dev',
    icon: APP_ICON, // window icon on Windows/Linux; macOS uses the dock icon
    backgroundColor: '#111113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void openUrl(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function sendToFocused(channel: string): void {
  ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channel)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToFocused('menu:new-project')
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu:open-project')
        },
        { type: 'separator' },
        {
          label: 'Save Project',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu:save-project')
        },
        { type: 'separator' },
        {
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToFocused('menu:new-terminal')
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToFocused('menu:close-tab')
        },
        {
          label: 'Toggle Global Claude',
          accelerator: 'CmdOrCtrl+J',
          click: () => sendToFocused('menu:toggle-global-claude')
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    // Built by hand: the stock windowMenu binds CmdOrCtrl+W to closing the window.
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  // Must complete before anything spawns child processes (docker, git, ptys).
  await fixPath()
  registerPtyHandlers()
  registerProjectHandlers()
  registerGithubHandlers()
  registerLinearHandlers()
  registerSkillHandlers()
  registerDockerHandlers()
  registerEnvironmentHandlers()
  registerStackHandlers()
  registerClaudeSessionHandlers()
  registerServerHandlers()
  registerMcpHandlers()
  registerVoiceHandlers()
  buildMenu()
  setDockIcon()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disposeAllPtys()
  disconnectAllServers()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposeAllPtys()
  disconnectAllServers()
})
