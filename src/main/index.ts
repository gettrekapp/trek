import { app, BrowserWindow, Menu, nativeImage } from 'electron'

app.setName('Trek Dev')

function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(APP_ICON)
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}
import { registerPtyHandlers, disposeAllPtys } from './pty'
import { openProjectFile, registerProjectHandlers } from './project'
import { registerGithubHandlers } from './github'
import { registerLinearHandlers } from './linear'
import { registerSkillHandlers } from './skills'
import { registerDockerHandlers } from './docker'
import { registerEnvironmentHandlers } from './environments'
import { registerStackHandlers } from './stacks'
import { registerClaudeSessionHandlers } from './claudeSessions'
import { registerServerHandlers, disconnectAllServers } from './servers'
import { closeServerLinks, registerAppServerHandlers } from './appServers'
import { registerV2Relay } from './v2relay'
import { registerMcpHandlers } from './mcp'
import { registerBotHandlers, stopAllBots } from './bot'
import { registerVoiceHandlers } from './voice'
import { registerAgentHandlers } from './agents'
import { registerLlmHandlers } from './llmSettings'
import { fixPath } from './env'
import {
  APP_ICON,
  closeAllForQuit,
  createWindow,
  isQuitting,
  registerWindowHandlers,
  restoreWindows,
  windowHasProject
} from './windows'

function sendToFocused(channel: string): void {
  ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channel)
}

function newProject(): void {
  const focused = BrowserWindow.getFocusedWindow()
  // An empty window is already at the start screen.
  if (focused && !windowHasProject(focused.webContents)) focused.focus()
  else createWindow()
}

function openProject(): void {
  if (BrowserWindow.getAllWindows().length === 0) createWindow({ menu: 'open-project' })
  else sendToFocused('menu:open-project')
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow()
        },
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: newProject
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: openProject
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
  registerWindowHandlers(openProjectFile)
  registerProjectHandlers()
  registerGithubHandlers()
  registerLinearHandlers()
  registerSkillHandlers()
  registerDockerHandlers()
  registerEnvironmentHandlers()
  registerStackHandlers()
  registerClaudeSessionHandlers()
  registerServerHandlers()
  registerAppServerHandlers()
  registerV2Relay()
  registerMcpHandlers()
  registerBotHandlers()
  registerVoiceHandlers()
  registerAgentHandlers()
  registerLlmHandlers()
  buildMenu()
  setDockIcon()
  await restoreWindows()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function cleanUp(): void {
  disposeAllPtys()
  disconnectAllServers()
}

app.on('window-all-closed', () => {
  cleanUp()
  // A quit in progress finishes on its own once closeAllForQuit returns.
  if (process.platform !== 'darwin' && !isQuitting()) app.quit()
})

let quitConfirmed = false

// Main's own server connections live as long as the app (3d's notifications need them with no window open).
app.on('will-quit', closeServerLinks)

app.on('before-quit', (event) => {
  if (quitConfirmed) return
  event.preventDefault()
  if (isQuitting()) return
  void closeAllForQuit().then(async (closed) => {
    if (!closed) return
    // After every window has agreed to close, so that a cancelled quit leaves the other bots running.
    await stopAllBots().catch((err) => console.error(err))
    cleanUp()
    quitConfirmed = true
    app.quit()
  })
})
