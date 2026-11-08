// App-wide preferences, kept by main in userData's app-settings.json and shared by
// every window (file and server windows alike). Pure: read and patch, field by field.

export interface AppSettings {
  /** OS notifications for sessions on the app-wide servers (main's attention); on by default */
  showNotifications: boolean
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true })

/** A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`. */
export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
  const from = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    showNotifications: typeof from.showNotifications === 'boolean' ? from.showNotifications : base.showNotifications
  }
}
