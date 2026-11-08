import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
import { errorText } from '../v2/errors'
import { shouldReconnect, shouldReconnectOnMove } from '../v2/appServerLinks'
import { useAppServerLinks } from '../useAppServerLinks'
import { NewServerProjectModal } from './NewServerProjectModal'
import { STATUS_LABELS, isLoopbackUrl, localStatusLabel, originOf } from '../../../shared/appServerRules.ts'
import type { ConnectionStatus, StatusChange } from '../../../shared/client/index.ts'
import type { ServerTopic } from '../../../shared/model/topics'
import type { AppServerLink, AppServerTest } from '../../../shared/types'

/**
 * The start screen's Connect to server view: the app-wide trek-server list
 * (add, edit, token, test, remove) and, for the picked server, its projects.
 * Tokens go to main and are never read back. The list and each row's status
 * are main's broadcast (main holds a connection per server with a token), so
 * a change made in another window shows here at once. The picked server's
 * projects come over this window's own connection, closed when the view
 * unmounts (unless the window has just opened one of them).
 */

interface Props {
  onBack: () => void
}

interface FormState {
  /** null = a new server */
  id: string | null
  name: string
  url: string
  token: string
  /** The saved URL when editing: moving to another origin needs the token again. */
  savedUrl: string | null
}

type TestState = { busy: true } | { busy: false; result: AppServerTest } | { busy: false; error: string }

function dotClass(status: ConnectionStatus | undefined): string {
  return status === 'connected' ? 'done' : status === 'connecting' ? 'running' : 'exited'
}

/** Plain ws:// to anything but this machine: say so (allowed for Tailscale and LAN). */
function unencryptedRemote(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === 'ws:' && !isLoopbackUrl(url)
  } catch {
    return false
  }
}

function needsTokenAgain(form: FormState): boolean {
  if (form.id === null || form.savedUrl === null) return false
  return originOf(form.savedUrl) !== originOf(form.url)
}

export function ConnectServer({ onBack }: Props): React.JSX.Element {
  const { servers, error: listError } = useAppServerLinks()
  const [selectedId, setSelectedId] = useState<string | null>(() => useAppStore.getState().connectServerId)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tokenFor, setTokenFor] = useState<string | null>(null)
  const [tokenValue, setTokenValue] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** Ids from the last snapshot, so the next can drop removed entries' connections. */
  const knownIds = useRef<Set<string>>(new Set())
  const tokenInputId = useId()

  // Removed (here or in another window): close its connection, so it stops retrying.
  // A server window shows its own entry's "Server removed" state, but that window
  // renders no Connect view, so skip it only to be safe.
  useEffect(() => {
    if (!servers) return
    const ids = new Set(servers.map((s) => s.id))
    const shown = useAppStore.getState().serverWindow?.serverEntryId
    for (const id of knownIds.current) if (!ids.has(id) && id !== shown) dropServerEntry(id)
    knownIds.current = ids
  }, [servers])

  // The view goes: so do the connections it opened for the picked server's projects. Not the
  // one the window has just opened a project on (setServerWindow runs before this unmounts).
  useEffect(
    () => () => {
      const shown = useAppStore.getState().serverWindow?.serverEntryId
      for (const id of knownIds.current) if (id !== shown) dropServerEntry(id)
    },
    []
  )

  // connectServerId is a one-shot: picked above, now cleared.
  useEffect(() => {
    if (useAppStore.getState().connectServerId) useAppStore.getState().setConnectServerId(null)
  }, [])

  const setRowError = (id: string, message: string | null): void =>
    setRowErrors((e) => {
      const copy = { ...e }
      if (message) copy[id] = message
      else delete copy[id]
      return copy
    })

  const startAdd = (): void => {
    setFormError(null)
    setForm({ id: null, name: '', url: 'wss://', token: '', savedUrl: null })
  }

  const startEdit = (server: AppServerLink): void => {
    setFormError(null)
    setForm({ id: server.id, name: server.name, url: server.url, token: '', savedUrl: server.url })
  }

  const tokenRequired = !!form && (form.id === null || needsTokenAgain(form))
  const canSave = !!form && !!form.name.trim() && !!form.url.trim() && (!tokenRequired || !!form.token.trim())

  const save = async (): Promise<void> => {
    if (!form || !canSave) return
    setSaving(true)
    setFormError(null)
    try {
      const token = form.token.trim()
      const saved = await window.api.appServers.save({
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim(),
        url: form.url.trim(),
        ...(token ? { token } : {})
      })
      // Same entry id, new URL or token: the relay looks both up on the next open.
      registeredServerEntry(saved.id)?.connection.reconnect()
      setForm(null)
      setSelectedId(saved.id)
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const saveToken = async (server: AppServerLink): Promise<void> => {
    const token = tokenValue.trim()
    if (!token) return
    setRowError(server.id, null)
    try {
      await window.api.appServers.setToken(server.id, token)
      setTokenFor(null)
      setTokenValue('')
      registeredServerEntry(server.id)?.connection.reconnect()
    } catch (err) {
      setRowError(server.id, `Could not save the token: ${errorText(err)}`)
    }
  }

  const test = async (server: AppServerLink): Promise<void> => {
    setTests((t) => ({ ...t, [server.id]: { busy: true } }))
    try {
      const result = await window.api.appServers.test(server.id)
      setTests((t) => ({ ...t, [server.id]: { busy: false, result } }))
    } catch (err) {
      setTests((t) => ({ ...t, [server.id]: { busy: false, error: errorText(err) } }))
    }
  }

  const remove = async (server: AppServerLink): Promise<void> => {
    const confirmed = await window.api.confirm({
      title: 'Remove Server',
      message: `Remove server “${server.name}”?`,
      detail:
        'Its access token is deleted from this machine. Nothing changes on the server: its projects and sessions keep running. ' +
        'Windows and recents for it show “Server removed”.',
      confirmLabel: 'Remove Server'
    })
    if (!confirmed) return
    setRowError(server.id, null)
    try {
      await window.api.appServers.remove(server.id)
    } catch (err) {
      setRowError(server.id, `Could not remove: ${errorText(err)}`)
      return
    }
    dropServerEntry(server.id)
    // Functional updates: the confirm and remove awaits may have outlived this render's state.
    setSelectedId((id) => (id === server.id ? null : id))
    setForm((f) => (f?.id === server.id ? null : f))
  }

  const selected = servers?.find((s) => s.id === selectedId) ?? null

  return (
    <div className="connect-server">
      <div className="connect-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h2>Servers</h2>
        <button className="btn btn-ghost" disabled={!!form && form.id === null} onClick={startAdd}>
          Add server…
        </button>
      </div>

      {listError && <div className="error">{listError}</div>}

      {servers && servers.length === 0 && !form && (
        <p className="muted servers-empty">
          No servers yet. Run trek-server on a machine (see server/README.md), then add it here.
        </p>
      )}

      {servers?.map((server) => {
        if (server.local) {
          return (
            <LocalServerItem key={server.id} server={server} selected={selectedId === server.id} onToggle={() => setSelectedId(selectedId === server.id ? null : server.id)} />
          )
        }
        const testState = tests[server.id]
        const label = server.hasToken ? (server.status ? STATUS_LABELS[server.status] : 'Not connected') : 'Needs a token'
        const message = server.hasToken ? server.message : 'Set a token to connect'
        return (
          <div key={server.id} className={`connect-server-item${selectedId === server.id ? ' selected' : ''}`}>
            <div className="server-row">
              <span
                className={`wt-dot ${server.hasToken ? dotClass(server.status ?? undefined) : 'exited'}`}
                title={message ? `${label}: ${message}` : label}
              />
              <span className="connect-server-name">{server.name}</span>
              <span className="server-row-url">{server.url}</span>
              <span className={`connect-server-status${server.hasToken ? '' : ' warn'}`}>
                {label}
                {message ? ` · ${message}` : ''}
              </span>
              <span className="server-row-actions">
                <button
                  className="btn btn-ghost"
                  disabled={!server.hasToken}
                  onClick={() => setSelectedId(selectedId === server.id ? null : server.id)}
                >
                  Projects
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setTokenFor(tokenFor === server.id ? null : server.id)
                    setTokenValue('')
                  }}
                >
                  Set token
                </button>
                <button className="btn btn-ghost" disabled={testState?.busy} onClick={() => void test(server)}>
                  {testState?.busy ? 'Testing…' : 'Test'}
                </button>
                <button className="btn btn-ghost" onClick={() => startEdit(server)}>
                  Edit
                </button>
                <button className="btn btn-ghost danger" onClick={() => void remove(server)}>
                  Remove
                </button>
              </span>
            </div>

            {tokenFor === server.id && (
              <div className="server-form-row connect-token-row">
                <label htmlFor={`${tokenInputId}-${server.id}`}>Access token</label>
                <input
                  id={`${tokenInputId}-${server.id}`}
                  type="password"
                  autoFocus
                  value={tokenValue}
                  placeholder={server.hasToken ? '•••• saved on this machine' : 'from `trek-server token add <device>`'}
                  onChange={(e) => setTokenValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveToken(server)
                    if (e.key === 'Escape') setTokenFor(null)
                  }}
                />
                <button className="btn btn-ghost" disabled={!tokenValue.trim()} onClick={() => void saveToken(server)}>
                  Save
                </button>
              </div>
            )}

            {testState && !testState.busy && (
              <div
                className={`server-test-result ${'result' in testState && testState.result.status === 'connected' ? 'ok' : 'fail'}`}
              >
                {'error' in testState
                  ? `Test failed: ${testState.error}`
                  : testState.result.status === 'connected'
                    ? `Connected — ${testState.result.serverName || 'trek-server'} ${testState.result.daemonVersion ?? ''}`.trim()
                    : `${STATUS_LABELS[testState.result.status as ConnectionStatus] ?? testState.result.status}: ${testState.result.message}`}
              </div>
            )}

            {rowErrors[server.id] && <div className="error">{rowErrors[server.id]}</div>}

            {form?.id === server.id && (
              <ServerForm
                form={form}
                setForm={setForm}
                tokenRequired={tokenRequired}
                hasToken={server.hasToken}
                error={formError}
                saving={saving}
                canSave={canSave}
                onSave={() => void save()}
                onCancel={() => setForm(null)}
              />
            )}

            {selected?.id === server.id && server.hasToken && <ServerProjects server={server} />}
          </div>
        )
      })}

      {form && form.id === null && (
        <ServerForm
          form={form}
          setForm={setForm}
          tokenRequired={tokenRequired}
          hasToken={false}
          error={formError}
          saving={saving}
          canSave={canSave}
          onSave={() => void save()}
          onCancel={() => setForm(null)}
        />
      )}
    </div>
  )
}

/**
 * The Local server's row: first in the list, with no Set token, Edit or Remove (main's
 * supervisor owns it). Its state, and Start, Restart or Reset as the state allows.
 */
function LocalServerItem({ server, selected, onToggle }: { server: AppServerLink; selected: boolean; onToggle: () => void }): React.JSX.Element {
  const local = server.local!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = local.state === 'running'
  const pending = local.state === 'starting' || local.state === 'stopping'
  const linkLabel = running && server.status && server.status !== 'connected' ? ` · ${STATUS_LABELS[server.status]}` : ''
  const act = (action: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    action()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }
  const dot = running ? dotClass(server.status ?? undefined) : pending ? 'running' : 'exited'
  return (
    <div className={`connect-server-item connect-server-local${selected ? ' selected' : ''}`}>
      <div className="server-row">
        <span className={`wt-dot ${dot}`} title={localStatusLabel(local)} />
        <span className="connect-server-name">{server.name}</span>
        <span className="server-row-url">this computer</span>
        <span className={`connect-server-status${local.state === 'error' || local.skew ? ' warn' : ''}`}>
          {localStatusLabel(local)}
          {linkLabel}
        </span>
        <span className="server-row-actions">
          <button className="btn btn-ghost" disabled={!running || !server.hasToken} onClick={onToggle}>
            Projects
          </button>
          {running ? (
            <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => window.api.localServer.restart())}>
              Restart
            </button>
          ) : (
            <button className="btn btn-ghost" disabled={busy || pending} onClick={() => act(() => window.api.localServer.start())}>
              Start
            </button>
          )}
          {local.state === 'error' && local.canReset && (
            <button className="btn btn-ghost danger" disabled={busy} onClick={() => act(() => window.api.localServer.reset())}>
              Reset
            </button>
          )}
        </span>
      </div>
      {local.message && local.state !== 'running' && <div className={local.state === 'error' ? 'error connect-local-message' : 'muted connect-local-message'}>{local.message}</div>}
      {error && <div className="error">{error}</div>}
      {selected && running && server.hasToken && <ServerProjects server={server} />}
    </div>
  )
}

interface ServerFormProps {
  form: FormState
  setForm: (form: FormState) => void
  tokenRequired: boolean
  hasToken: boolean
  error: string | null
  saving: boolean
  canSave: boolean
  onSave: () => void
  onCancel: () => void
}

function ServerForm({ form, setForm, tokenRequired, hasToken, error, saving, canSave, onSave, onCancel }: ServerFormProps): React.JSX.Element {
  const moved = needsTokenAgain(form)
  return (
    <div
      className="server-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <h4>{form.id ? `Edit ${form.name || 'server'}` : 'Add server'}</h4>
      <label className="server-form-row">
        <span>Name</span>
        <input value={form.name} placeholder="build-box" onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="server-form-row">
        <span>URL</span>
        <input
          value={form.url}
          placeholder="wss://dev.example.com"
          spellCheck={false}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
      </label>
      {unencryptedRemote(form.url) && (
        <p className="muted connect-warning">Unencrypted — use wss:// unless this is a private network</p>
      )}
      <label className="server-form-row">
        <span>Access token</span>
        <input
          type="password"
          value={form.token}
          placeholder={
            tokenRequired ? 'required' : hasToken ? '•••• saved on this machine (leave empty to keep)' : 'from `trek-server token add <device>`'
          }
          onChange={(e) => setForm({ ...form, token: e.target.value })}
        />
      </label>
      {moved && (
        <p className="muted connect-warning">
          The address moved to another server, so the saved token is not sent there: enter the token again.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <div className="server-form-actions">
        <button className="btn btn-accent" disabled={saving || !canSave} onClick={onSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

type TopicView = { snapshot: ServerTopic } | { error: string } | null

/** The picked server's projects, from its `server` topic. */
function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Element {
  const setServerWindow = useAppStore((s) => s.setServerWindow)
  const [status, setStatus] = useState<StatusChange>({ status: 'connecting', message: '' })
  const [topic, setTopic] = useState<TopicView>(null)
  /** Open: false, true, or the folder New Project on Local picked first */
  const [newProjectOpen, setNewProjectOpen] = useState<boolean | { path: string }>(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const registered = useMemo(() => connectServerEntry(server.id), [server.id])

  useEffect(() => {
    const { connection, mirror } = registered
    setStatus({ status: connection.status, message: connection.statusMessage })
    const offStatus = connection.on('status', setStatus)
    const offTopic = mirror.subscribe('server', (update) => {
      setTopic('error' in update ? { error: errorText(update.error) } : { snapshot: update.snapshot })
    })
    return () => {
      offStatus()
      offTopic()
    }
  }, [registered])

  // Stuck (a wrong token, say) while main's connection to the entry is up: fixed since, so retry.
  useEffect(() => {
    if (shouldReconnect(server, registered.connection)) registered.connection.reconnect()
  }, [server.status, registered])

  // Local respawned on a new port: go there now, not after the back-off.
  const lastUrl = useRef(server.url)
  useEffect(() => {
    if (shouldReconnectOnMove(lastUrl.current, server, registered.connection)) registered.connection.reconnect()
    lastUrl.current = server.url
  }, [server.url, registered])

  // Note for 4b, 8: from the welcome, never from the URL.
  const isLocal = !!server.capabilities?.includes('local')
  const newProject = async (): Promise<void> => {
    if (!isLocal) {
      setNewProjectOpen(true)
      return
    }
    setError(null)
    try {
      const path = await window.api.selectDirectory('Choose a repository for the new project')
      if (path) setNewProjectOpen({ path })
    } catch (err) {
      setError(`Could not choose a folder: ${errorText(err)}`)
    }
  }

  const connected = status.status === 'connected'
  const serverName = registered.connection.welcome?.serverName ?? ''

  const open = async (projectId: string, name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { opened } = await window.api.openServerProject(server.id, projectId, name, serverName)
      if (opened) setServerWindow({ serverEntryId: server.id, projectId })
    } catch (err) {
      setError(`Could not open project: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const snapshot = topic && 'snapshot' in topic ? topic.snapshot : null

  return (
    <div className="connect-projects">
      {!connected && (
        <p className="muted connect-projects-status">
          {STATUS_LABELS[status.status]}
          {status.message ? ` — ${status.message}` : ''}
        </p>
      )}
      {topic && 'error' in topic && <div className="error">Could not list projects: {topic.error}</div>}
      {error && <div className="error">{error}</div>}
      {snapshot && snapshot.projects.length === 0 && <p className="muted connect-projects-status">No projects yet.</p>}
      {snapshot && snapshot.projects.length > 0 && (
        <ul className="connect-project-list">
          {snapshot.projects.map((p) => (
            <li key={p.id}>
              <span className="recent-name">{p.name || p.id}</span>
              <button className="btn btn-ghost" disabled={!connected || busy} onClick={() => void open(p.id, p.name)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="server-form-actions">
        <button className="btn btn-ghost" disabled={!connected || !snapshot || busy} onClick={() => void newProject()}>
          New Project…
        </button>
      </div>
      {newProjectOpen && snapshot && (
        <NewServerProjectModal
          registered={registered}
          serverName={server.name}
          repos={snapshot.repos}
          local={isLocal}
          initialPath={typeof newProjectOpen === 'object' ? newProjectOpen.path : undefined}
          onClose={() => setNewProjectOpen(false)}
          onCreated={(projectId, name) => {
            setNewProjectOpen(false)
            void open(projectId, name)
          }}
        />
      )}
    </div>
  )
}
