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
import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
import { appSettings, registerAppSettingsHandlers } from './appSettings'
import {
  LOCAL_SERVER_DISABLED,
  localServerStatus,
  onLocalServerChanged,
  quitLocalServer,
  registerLocalServerHandlers,
  restartLocalServer,
  startLocalServer,
  stopLocalServer,
  superviseLocalServer
} from './localServer'
import { localStatusLabel } from '../shared/appServerRules.ts'
import { registerV2Relay } from './v2relay'
import { importFromMenu } from './importUi'
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

/** File → Local Server: its state, Start or Restart, and Stop. Rebuilt on every change. */
function localServerMenu(): Electron.MenuItemConstructorOptions[] {
  if (LOCAL_SERVER_DISABLED) return []
  const local = localServerStatus()
  const running = local.state === 'running'
  const busy = local.state === 'starting' || local.state === 'stopping'
  return [
    { type: 'separator' },
    {
      label: 'Local Server',
      submenu: [
        { label: localStatusLabel(local), enabled: false },
        { type: 'separator' },
        {
          label: running ? 'Restart Local Server' : 'Start Local Server',
          enabled: !busy,
          click: () => void (running ? restartLocalServer() : startLocalServer())
        },
        { label: 'Stop Local Server', enabled: running, click: () => void stopLocalServer() }
      ]
    }
  ]
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
        {
          label: 'Import .trekproj…',
          click: () => void importFromMenu()
        },
        ...localServerMenu(),
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
  registerAppSettingsHandlers()
  // Before the links: their first connections are linked to the aggregator as they are made.
  registerAttentionHandlers()
  const attention = attentionHooks()
  registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
  registerV2Relay()
  registerLocalServerHandlers()
  registerMcpHandlers()
  registerBotHandlers()
  registerVoiceHandlers()
  registerAgentHandlers()
  registerLlmHandlers()
  buildMenu()
  onLocalServerChanged(buildMenu)
  setDockIcon()
  // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
  void superviseLocalServer()
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

// Main's own server connections live as long as the app (notifications need them with no window open).
app.on('will-quit', () => {
  closeAttention()
  closeServerLinks()
})

app.on('before-quit', (event) => {
  if (quitConfirmed) return
  event.preventDefault()
  if (isQuitting()) return
  void closeAllForQuit().then(async (closed) => {
    if (!closed) return
    // After every window has agreed to close, so that a cancelled quit leaves the other bots running.
    await stopAllBots().catch((err) => console.error(err))
    // Keeps running by default; "Stop local server on quit" stops it here.
    await quitLocalServer(appSettings().stopLocalServerOnQuit)
    cleanUp()
    quitConfirmed = true
    app.quit()
  })
})
