// Settings → Appearance → Installed themes (theme plugins phase 3): where the window's server
// installs for a client (`pluginInstall`), install a theme from a .trekplugin file or an https
// URL, and remove one. A theme is installed on the server, for every client of it; the list here
// is the server's (plugins.list), never edited locally. Installing does not choose the theme.
import { useEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'
import type { InstalledTheme } from './theme'
import { installFailure, installUrlProblem, installedNote, packageFileProblem, packageTextProblem, removeConfirm } from './themeInstall'

const ABOUT = 'Themes are installed on the server, for every client of it. A theme is code that runs in this window: install only what you trust.'

export function ThemeInstallRow({ themes }: { themes: InstalledTheme[] }): React.JSX.Element {
  /** What is in flight: 'install', or `remove:<id>`; one thing at a time */
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; problem?: true } | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  /** An action is under way, from its click to its end: `busy` is set only once its request starts, after the file is read or the removal confirmed. */
  const acting = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** One action at a time: a click while another is under way does nothing. */
  const once = async (action: () => Promise<void>): Promise<void> => {
    if (acting.current) return
    acting.current = true
    try {
      await action()
    } finally {
      acting.current = false
    }
  }

  /** Whether this row is still shown, in a window still on `backend`: the server and project an action started with. */
  const still = (backend: ReturnType<typeof getBackend>): boolean => alive.current && getBackend() === backend

  /** Runs one request on `backend`, the window's server when the action started; its outcome shows only while this row is still that window's. */
  const run = async (
    backend: ReturnType<typeof getBackend>,
    what: string,
    method: string,
    params: Record<string, unknown>,
    done: (result: unknown) => string
  ): Promise<boolean> => {
    const here = (): boolean => still(backend)
    setBusy(what)
    setMessage(null)
    try {
      const result = await backend.plugins.request(method, params)
      if (here()) setMessage({ text: done(result) })
      return true
    } catch (err) {
      if (here()) setMessage({ text: installFailure(err), problem: true })
      return false
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const installFile = async (file: File): Promise<void> => {
    const problem = packageFileProblem(file)
    if (problem) {
      setMessage({ text: problem, problem: true })
      return
    }
    // The file goes to the server of the window it was picked in: not to one the window moved to while it was read.
    const backend = getBackend()
    let text: string
    try {
      text = await file.text()
    } catch (err) {
      if (still(backend)) setMessage({ text: `Could not read that file. (${err instanceof Error ? err.message : String(err)})`, problem: true })
      return
    }
    if (!still(backend)) return
    const unfit = packageTextProblem(text)
    if (unfit) {
      setMessage({ text: unfit, problem: true })
      return
    }
    await run(backend, 'install', 'plugins.install', { package: text }, installedNote)
  }

  const installUrl = async (): Promise<void> => {
    const problem = installUrlProblem(url)
    if (problem) {
      setMessage({ text: problem, problem: true })
      return
    }
    if (await run(getBackend(), 'install', 'plugins.install', { url: url.trim() }, installedNote)) {
      if (!alive.current) return
      setUrlOpen(false)
      setUrl('')
    }
  }

  const remove = async (theme: InstalledTheme): Promise<void> => {
    const backend = getBackend()
    const confirmed = await window.api.confirm(removeConfirm(theme))
    if (!confirmed || !still(backend)) return
    await run(backend, `remove:${theme.id}`, 'plugins.remove', { id: theme.id }, () => `Removed ${theme.name}.`)
  }

  return (
    <div className="settings-row theme-install">
      <span className="settings-label">
        <span className="settings-name">Installed themes</span>
        <span className="settings-desc" data-theme-install={message ? (message.problem ? 'problem' : 'done') : 'about'}>
          {message?.text ?? ABOUT}
        </span>
        {themes.length > 0 && (
          <ul className="theme-list">
            {themes.map((t) => (
              <li key={t.id}>
                <span>
                  {t.name} <span className="muted">{t.version}</span>
                </span>
                <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void once(() => remove(t))}>
                  {busy === `remove:${t.id}` ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {urlOpen && (
          <form
            className="theme-url"
            onSubmit={(e) => {
              e.preventDefault()
              void once(installUrl)
            }}
          >
            <input
              className="settings-select"
              type="text"
              aria-label="Theme package URL"
              placeholder="https://…/name.trekplugin"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy !== null}>
              {busy === 'install' ? 'Installing…' : 'Install'}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setUrlOpen(false)
                setUrl('')
                setMessage(null)
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </span>
      <span className="appearance-color">
        <button className="btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          Install from file…
        </button>
        <button className="btn" disabled={busy !== null || urlOpen} onClick={() => setUrlOpen(true)}>
          Install from URL…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".trekplugin,application/json"
          aria-label="Theme package file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void once(() => installFile(file))
          }}
        />
      </span>
    </div>
  )
}
