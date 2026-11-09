import { app, BrowserWindow, Menu, nativeImage } from 'electron'

app.setName('Trek Dev')

function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(APP_ICON)
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}
import { registerAppIpc } from './appIpc'
import { registerGithubHandlers } from './github'
import { registerLinearHandlers } from './linear'
import { registerSkillHandlers } from './skills'
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
import { importFromMenu, offerFirstLaunchImport, openFromOs, registerImportHandlers } from './importUi'
import { registerVoiceHandlers } from './voice'
import { registerLlmHandlers } from './llmSettings'
import { fixPath } from './env'
import { removeStaleMcpConfigs } from './staleMcpConfigs'
import {
  APP_ICON,
  closeAllForQuit,
  createWindow,
  isQuitting,
  registerWindowHandlers,
  restoreWindows,
  showStartView,
  windowHasProject
} from './windows'

/**
 * .trekproj files macOS asked to open (Finder, the Dock) before the windows were restored and the
 * launch's own opens were done: opened after, one at a time, before the empty-window check.
 */
const pendingOpens: string[] = []
let opensReady = false
// Registered before ready: a file that launches the app arrives before it.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (opensReady) void openFromOs(path)
  else pendingOpens.push(path)
})

function sendToFocused(channel: string): void {
  ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channel)
}

/** File → New Project… / Open on Server…: the start screen's view, in the focused window if it is empty, else in a new one. */
function startView(view: 'new-project' | 'open-on-server'): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !windowHasProject(focused.webContents)) showStartView(focused.webContents, view)
  else createWindow({ menu: view })
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
          click: () => startView('new-project')
        },
        {
          label: 'Open on Server…',
          accelerator: 'CmdOrCtrl+O',
          click: () => startView('open-on-server')
        },
        {
          label: 'Import .trekproj…',
          click: () => void importFromMenu()
        },
        ...localServerMenu(),
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
  // Must complete before anything spawns child processes (the local server, code, gh).
  await fixPath()
  void removeStaleMcpConfigs()
  registerWindowHandlers()
  registerAppIpc()
  registerImportHandlers()
  registerGithubHandlers()
  registerLinearHandlers()
  registerSkillHandlers()
  registerAppSettingsHandlers()
  // Before the links: their first connections are linked to the aggregator as they are made.
  registerAttentionHandlers()
  const attention = attentionHooks()
  registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
  registerV2Relay()
  registerLocalServerHandlers()
  registerVoiceHandlers()
  registerLlmHandlers()
  buildMenu()
  onLocalServerChanged(buildMenu)
  setDockIcon()
  // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
  void superviseLocalServer()
  // Once, before the windows come back: those on .trekproj files then come back on their projects.
  await offerFirstLaunchImport().catch((err) => console.error('[import] the first-launch prompt failed', err))
  // No empty window yet: a .trekproj that launched the app, or that arrives during the restore,
  // opens its projects in windows of their own (4d M-6).
  await restoreWindows()
  // A file that arrives while these run is queued too, so none is still opening when the check
  // below counts the windows (4e-2 Risk 6): one that arrives afterwards opens on its own.
  while (pendingOpens.length > 0) await openFromOs(pendingOpens.shift()!)
  opensReady = true
  // Nothing came back and nothing opened (no windows last time, restore off, an import that
  // failed or landed nothing): the app still shows one empty window.
  if (BrowserWindow.getAllWindows().length === 0) createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
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
    // Keeps running by default; "Stop local server on quit" stops it here.
    await quitLocalServer(appSettings().stopLocalServerOnQuit)
    quitConfirmed = true
    app.quit()
  })
})
