// The project window's theme (theme plugins phase 2): loads the chosen theme's bundle from the
// window's server while the choice is `ready`, then applies it: its styles after the app's, the
// id on <html data-theme>, and its Runtime and overlay inside its host and the plugin error
// boundary. Anything else (no choice, changed, missing, a load that failed) is the default look.
import { useEffect, useRef, useState } from 'react'
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import type { WindowBackend } from '../backend'
import { loadInstalledPlugin } from './installedLoader'
import { PluginScope, themeEntry } from './PluginHost'
import { exposePluginGlobals } from './pluginGlobals'
import { setThemeLoad } from './themeLoadStore'
import { useThemeChoice } from './useThemeChoice'

/** A `stale` answer is followed by a new list; if none changes anything, the load goes again: this long after, this many times. */
const STALE_RETRY_MS = 3000
const STALE_RETRIES = 5

interface Loaded {
  backend: WindowBackend
  sha256: string
  plugin: ClientPlugin
}

export function ThemeHost(): React.JSX.Element | null {
  const { backend, state } = useThemeChoice()
  const ready = state.kind === 'ready' ? state.theme : null
  const readyId = ready?.id
  const readySha = ready?.sha256
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // A load that failed while the link was down goes again when it is back.
  const [attempt, setAttempt] = useState(0)
  const staleTries = useRef(0)
  useEffect(
    () =>
      backend.plugins.onConnected(() => {
        staleTries.current = 0
        setAttempt((n) => n + 1)
      }),
    [backend]
  )
  useEffect(() => {
    staleTries.current = 0
  }, [backend, readyId, readySha])

  useEffect(() => {
    if (!ready) {
      setThemeLoad({ kind: 'idle' })
      return
    }
    let live = true
    setThemeLoad({ kind: 'loading' })
    exposePluginGlobals()
    let retry: ReturnType<typeof setTimeout> | undefined
    loadInstalledPlugin(ready, ready.sha256, { request: (method, params) => backend.plugins.request(method, params) })
      // The loader does not reject; if it ever did, that is a failed load, not a status stuck on loading.
      .catch((): { kind: 'failed'; reason: string } => ({ kind: 'failed', reason: 'it could not be loaded' }))
      .then((result) => {
        if (!live) return
        if (result.kind === 'loaded') {
          setLoaded({ backend, sha256: ready.sha256, plugin: result.plugin })
          setThemeLoad({ kind: 'applied' })
          return
        }
        // Whatever was applied before is not this load's: a load that did not succeed is the default look.
        setLoaded(null)
        setThemeLoad(result)
        // Stale, and then the server lists this same bundle again: no new list starts a load, so this does.
        if (result.kind === 'stale' && staleTries.current < STALE_RETRIES) {
          staleTries.current += 1
          retry = setTimeout(() => setAttempt((n) => n + 1), STALE_RETRY_MS)
        }
      })
    return () => {
      live = false
      clearTimeout(retry)
    }
    // `ready` is a new object on every list: its id and hash are what a load depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, readyId, readySha, attempt])

  // What was loaded applies only while it is still this window's ready theme.
  const active = loaded && loaded.backend === backend && loaded.sha256 === readySha && loaded.plugin.manifest.id === readyId ? loaded : null

  useEffect(() => {
    if (!active) return
    const { id } = active.plugin.manifest
    const style = document.createElement('style')
    style.dataset.trekTheme = id
    style.textContent = active.plugin.theme?.styles ?? ''
    // Last in <head>: after the app's stylesheet.
    document.head.appendChild(style)
    document.documentElement.dataset.theme = id
    return () => {
      style.remove()
      delete document.documentElement.dataset.theme
    }
  }, [active])

  if (!active) return null
  const entry = themeEntry(backend, active.plugin)
  const Runtime = active.plugin.Runtime
  const Overlay = active.plugin.slots?.overlay
  if (!Runtime && !Overlay) return null
  return (
    <PluginScope key={`${entry.key}:${active.sha256}`} entry={entry}>
      {Runtime && <Runtime />}
      {Overlay && <Overlay />}
    </PluginScope>
  )
}
