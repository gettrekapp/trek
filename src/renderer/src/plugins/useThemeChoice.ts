// The window's theme choice (theme plugins phase 2): this app's stored choice for the window's
// server and project, against the themes its server lists now. Shared by ThemeHost and Settings.
import { useMemo, useSyncExternalStore } from 'react'
import type { ThemeChoice } from '../../../shared/appSettings.ts'
import { getBackend, subscribeBackend, type WindowBackend } from '../backend'
import { useAppStore } from '../store'
import { useAppSettings } from '../useAppSettings'
import { welcomeKey } from './PluginHost'
import { installedThemes, themeKey, themeState, type InstalledTheme, type ThemeState } from './theme'
import { canInstallThemes } from './themeInstall'

export interface ThemeChoiceView {
  backend: WindowBackend
  /** The app settings' key of this window; null with no project open, or before the settings are read */
  key: string | null
  /** The server's welcome is in and lists plugins (false too for a server older than plugins) */
  listed: boolean
  /** The window's server installs and removes themes for a client (`pluginInstall`) */
  canInstall: boolean
  themes: InstalledTheme[]
  choice: ThemeChoice | undefined
  state: ThemeState
}

export function useThemeChoice(): ThemeChoiceView {
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const welcome = useSyncExternalStore(subscribeBackend, welcomeKey)
  const serverWindow = useAppStore((s) => s.serverWindow)
  const settings = useAppSettings()
  // The backend and the window's project change in the same tick; one that is not this project's is not read.
  const key = serverWindow && settings && backend.plugins.projectId === serverWindow.projectId ? themeKey(serverWindow.serverEntryId, serverWindow.projectId) : null
  const stored = key !== null && settings && Object.hasOwn(settings.themes, key) ? settings.themes[key] : undefined
  const id = stored?.id
  const sha256 = stored?.sha256
  return useMemo(() => {
    const welcomed = key !== null ? backend.plugins.welcome() : undefined
    const presence = welcomed?.plugins
    const choice = id !== undefined && sha256 !== undefined ? { id, sha256 } : undefined
    return { backend, key, listed: presence !== undefined, canInstall: canInstallThemes(welcomed), themes: installedThemes(presence), choice, state: themeState(choice, presence) }
    // `welcome` stands for the server's list, which the backend holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, welcome, key, id, sha256])
}
