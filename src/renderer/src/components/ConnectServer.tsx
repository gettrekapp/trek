import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
import { errorText } from '../v2/errors'
import { NewServerProjectModal } from './NewServerProjectModal'
import type { ConnectionStatus, StatusChange } from '../../../shared/client/index.ts'
import type { ServerTopic } from '../../../shared/model/topics'
import type { AppServerInfo, AppServerTest } from '../../../shared/types'

/**
 * The start screen's Connect to server view: the app-wide trek-server list
 * (add, edit, token, test, remove) and, for the picked server, its projects.
 * Tokens go to main and are never read back. Connections live in the
 * renderer-wide registry and stay open when this view unmounts.
 */

interface Props {
  onBack: () => void
  /** The list changed (added, edited or removed), so the start screen re-reads it. */
  onServersChanged: () => void
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

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  'needs-auth': 'Token rejected',
  incompatible: 'Incompatible',
  error: 'Error',
  closed: 'Closed'
}

function dotClass(status: ConnectionStatus | undefined): string {
  return status === 'connected' ? 'done' : status === 'connecting' ? 'running' : 'exited'
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin
  } catch {
    return null
  }
}

/** Plain ws:// to anything but this machine: say so (allowed for Tailscale and LAN). */
function unencryptedRemote(url: string): boolean {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'ws:') return false
    return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
  } catch {
    return false
  }
}

function needsTokenAgain(form: FormState): boolean {
  if (form.id === null || form.savedUrl === null) return false
  return originOf(form.savedUrl) !== originOf(form.url)
}

export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.Element {
  const [servers, setServers] = useState<AppServerInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, StatusChange>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tokenFor, setTokenFor] = useState<string | null>(null)
  const [tokenValue, setTokenValue] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<AppServerInfo[] | null> => {
    try {
      const list = await window.api.appServers.list()
      setServers(list)
      setListError(null)
      return list
    } catch (err) {
      setListError(`Could not read the server list: ${errorText(err)}`)
      return null
    }
  }, [])

  useEffect(() => {
    void load()
    // Another window may have changed the list.
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // One connection per server that has a token; its status drives the row's dot.
  useEffect(() => {
    if (!servers) return
    const unsubscribers: (() => void)[] = []
    const next: Record<string, StatusChange> = {}
    for (const server of servers) {
      if (!server.hasToken) continue
      const { connection } = connectServerEntry(server.id)
      next[server.id] = { status: connection.status, message: connection.statusMessage }
      unsubscribers.push(
        connection.on('status', (change) => setStatuses((s) => ({ ...s, [server.id]: change })))
      )
    }
    setStatuses(next)
    return () => unsubscribers.forEach((u) => u())
  }, [servers])

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

  const startEdit = (server: AppServerInfo): void => {
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
      await load()
      onServersChanged()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const saveToken = async (server: AppServerInfo): Promise<void> => {
    const token = tokenValue.trim()
    if (!token) return
    setRowError(server.id, null)
    try {
      await window.api.appServers.setToken(server.id, token)
      setTokenFor(null)
      setTokenValue('')
      registeredServerEntry(server.id)?.connection.reconnect()
      await load()
    } catch (err) {
      setRowError(server.id, `Could not save the token: ${errorText(err)}`)
    }
  }

  const test = async (server: AppServerInfo): Promise<void> => {
    setTests((t) => ({ ...t, [server.id]: { busy: true } }))
    try {
      const result = await window.api.appServers.test(server.id)
      setTests((t) => ({ ...t, [server.id]: { busy: false, result } }))
    } catch (err) {
      setTests((t) => ({ ...t, [server.id]: { busy: false, error: errorText(err) } }))
    }
  }

  const remove = async (server: AppServerInfo): Promise<void> => {
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
    if (selectedId === server.id) setSelectedId(null)
    if (form?.id === server.id) setForm(null)
    await load()
    onServersChanged()
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
        const status = statuses[server.id]
        const testState = tests[server.id]
        const label = server.hasToken ? (status ? STATUS_LABELS[status.status] : 'Not connected') : 'Needs a token'
        const message = server.hasToken ? status?.message : 'Set a token to connect'
        return (
          <div key={server.id} className={`connect-server-item${selectedId === server.id ? ' selected' : ''}`}>
            <div className="server-row">
              <span
                className={`wt-dot ${server.hasToken ? dotClass(status?.status) : 'exited'}`}
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
                <span>Access token</span>
                <input
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
    <div className="server-form">
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
function ServerProjects({ server }: { server: AppServerInfo }): React.JSX.Element {
  const setServerWindow = useAppStore((s) => s.setServerWindow)
  const [status, setStatus] = useState<StatusChange>({ status: 'connecting', message: '' })
  const [topic, setTopic] = useState<TopicView>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
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
        <button className="btn btn-ghost" disabled={!connected || !snapshot || busy} onClick={() => setNewProjectOpen(true)}>
          New Project…
        </button>
      </div>
      {newProjectOpen && snapshot && (
        <NewServerProjectModal
          registered={registered}
          serverName={server.name}
          repos={snapshot.repos}
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
