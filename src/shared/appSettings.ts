// App-wide preferences, kept by main in userData's app-settings.json and shared by
// every window. Pure: read and patch, field by field.

export interface AppSettings {
  /** OS notifications for sessions on the app-wide servers (main's attention); on by default */
  showNotifications: boolean
  /** Quitting Trek stops the Local server too; off by default, so it keeps running */
  stopLocalServerOnQuit: boolean
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true, stopLocalServerOnQuit: false })

/** A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`. */
export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
  const from = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof AppSettings): boolean => (typeof from[key] === 'boolean' ? (from[key] as boolean) : base[key])
  return {
    showNotifications: flag('showNotifications'),
    stopLocalServerOnQuit: flag('stopLocalServerOnQuit')
  }
}
