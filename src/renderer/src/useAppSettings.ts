import { useEffect, useState } from 'react'
import type { AppSettings } from '../../shared/appSettings.ts'

/** This app's settings, following every change (any window's); null until first read. */
export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    let live = true
    const off = window.api.appSettings.onChanged((next) => setSettings(next))
    window.api.appSettings.get().then(
      (s) => {
        if (live) setSettings((had) => had ?? s)
      },
      () => {}
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return settings
}
