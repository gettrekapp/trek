import { useEffect, useState } from 'react'
import { serverColorClass, useAppStore } from '../store'
import { scheduleAutoSave } from '../persistence'
import type { HostStatus, ServerConfig, ServerTestResult, ServerTokenCheck } from '../../../shared/types'
import { originOf } from '../../../shared/appServerRules.ts'

/**
 * Remote server management: each entry is a machine running the companion
 * trek-server (see server/README.md). The access token is stored encrypted on this
 * machine only — never in the project file — and bound to the server's address:
 * after the URL moves to another scheme, host or port, the token must be entered again.
 */

interface FormState {
  id: string
  name: string
  url: string
  /** Repository id → that repository's clone on this server */
  repoPaths: Record<string, string>
  /** empty = keep the stored token */
  token: string
}

const EMPTY_FORM: FormState = { id: '', name: '', url: 'wss://', repoPaths: {}, token: '' }

const STATUS_LABELS: Record<HostStatus, string> = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'disconnected',
  'needs-auth': 'token required',
  error: 'error'
}

export function ServersPanel(): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const setServers = useAppStore((s) => s.setServers)
  const setServerRepoPaths = useAppStore((s) => s.setServerRepoPaths)
  const serverStatus = useAppStore((s) => s.serverStatus)
  const serverErrors = useAppStore((s) => s.serverErrors)

  const servers = project.servers ?? []
  const repositories = project.repositories
  const [form, setForm] = useState<FormState | null>(null)
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  /** Whether the saved URL's stored token would be sent, and if not, why; null while unknown or adding. */
  const [storedToken, setStoredToken] = useState<ServerTokenCheck | null>(null)
  const hasStoredToken = storedToken?.ok === true

  const saved = form ? servers.find((s) => s.id === form.id) : undefined
  const editing = !!saved
  /** The stored token was entered for the saved URL; it is not sent once the URL points elsewhere. */
  const addressChanged = !!saved && !!form && originOf(form.url) !== originOf(saved.url)
  const tokenUsable = hasStoredToken && !addressChanged

  useEffect(() => {
    setTestResult(null)
    if (form && saved) {
      window.api
        .hasServerToken(form.id, saved.url)
        .then(setStoredToken)
        .catch((err) => setStoredToken({ ok: false, reason: 'none', error: String(err) }))
    } else {
      setStoredToken(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.id])

  const startAdd = (): void => setForm({ ...EMPTY_FORM, id: crypto.randomUUID() })
  const startEdit = (server: ServerConfig): void =>
    setForm({
      id: server.id,
      name: server.name,
      url: server.url,
      repoPaths: Object.fromEntries(
        repositories.map((r) => [r.id, r.serverPaths?.[server.id] ?? ''])
      ),
      token: ''
    })

  const filledPaths = form ? Object.values(form.repoPaths).map((p) => p.trim()).filter(Boolean) : []
  /** A changed address needs its token typed again: Save would otherwise leave the server unable to connect. */
  const needsToken = addressChanged && !form?.token.trim()
  const canSave = !!form && !!form.name.trim() && !!form.url.trim() && filledPaths.length > 0 && !needsToken

  const save = async (): Promise<void> => {
    if (!form || !canSave) return
    const config: ServerConfig = {
      id: form.id,
      name: form.name.trim(),
      url: form.url.trim()
    }
    if (form.token.trim()) {
      try {
        await window.api.setServerToken(config.id, form.token.trim(), config.url)
      } catch (err) {
        setTestResult({ ok: false, error: `Token not saved: ${err instanceof Error ? err.message : String(err)}` })
        return
      }
    }
    const next = editing
      ? servers.map((s) => (s.id === config.id ? config : s))
      : [...servers, config]
    setServerRepoPaths(config.id, form.repoPaths)
    setServers(next)
    scheduleAutoSave()
    setForm(null)
    void window.api.connectServer(config)
  }

  const remove = async (server: ServerConfig): Promise<void> => {
    const referencing = repositories
      .flatMap((r) => r.worktrees)
      .filter((w) => w.serverId === server.id)
    const confirmed = await window.api.confirm({
      title: 'Remove Server',
      message: `Remove server “${server.name}”?`,
      detail:
        (referencing.length > 0
          ? `${referencing.length} worktree(s) in this project live on it (` +
            referencing.map((w) => w.name).join(', ') +
            `) — move them first or they become unreachable. `
          : '') +
        'The stored access token is deleted from this machine. Nothing is changed on the server itself.',
      confirmLabel: 'Remove Server'
    })
    if (!confirmed) return
    await window.api.removeServer(server.id)
    setServerRepoPaths(server.id, {})
    setServers(servers.filter((s) => s.id !== server.id))
    scheduleAutoSave()
  }

  const test = async (): Promise<void> => {
    if (!form) return
    setTesting(true)
    setTestResult(null)
    try {
      const results = await Promise.all(
        filledPaths.map((repoPath) =>
          window.api.testServer({
            url: form.url.trim(),
            token: form.token.trim() || undefined,
            serverId: editing ? form.id : undefined,
            repoPath
          })
        )
      )
      const failed = results.find((r) => !r.ok)
      setTestResult(failed ?? { ...results[0], repoOk: results.every((r) => r.repoOk) })
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="servers-panel">
      <div className="settings-row servers-heading">
        <span className="settings-label">
          <span className="settings-name">Remote servers</span>
          <span className="settings-desc">
            Machines running trek-server. Worktrees and sessions on them appear in
            the sidebar with a server chip; sessions keep running when this app disconnects.
          </span>
        </span>
        <button className="btn btn-ghost" onClick={startAdd}>
          Add server…
        </button>
      </div>

      {servers.map((server) => {
        const status: HostStatus = serverStatus[server.id] ?? 'disconnected'
        const dotClass =
          status === 'connected' ? 'done' : status === 'connecting' ? 'running' : 'exited'
        return (
          <div key={server.id} className="server-row">
            <span className={`wt-dot ${dotClass}`} title={STATUS_LABELS[status]} />
            <span className={`mini-chip server-chip ${serverColorClass(server.id)}`}>
              {server.name}
            </span>
            <span className="server-row-url">{server.url}</span>
            <span className="server-row-path">
              {repositories
                .flatMap((r) => r.serverPaths?.[server.id] ?? [])
                .join(', ')}
            </span>
            {status === 'needs-auth' && (
              <button
                className="btn btn-ghost server-row-warn"
                title={serverErrors[server.id] ?? 'Enter this server’s access token'}
                onClick={() => startEdit(server)}
              >
                {serverErrors[server.id] ?? 'Token required'}
              </button>
            )}
            <span className="server-row-actions">
              <button className="btn btn-ghost" onClick={() => startEdit(server)}>
                Edit
              </button>
              <button className="btn btn-ghost danger" onClick={() => void remove(server)}>
                Remove
              </button>
            </span>
          </div>
        )
      })}
      {servers.length === 0 && !form && (
        <p className="muted servers-empty">
          No servers yet. Run trek-server on a machine (see server/README.md), then add it here.
        </p>
      )}

      {form && (
        <div className="server-form">
          <h4>{editing ? `Edit ${form.name || 'server'}` : 'Add server'}</h4>
          <label className="server-form-row">
            <span>Name</span>
            <input
              value={form.name}
              placeholder="build-box"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
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
          <label className="server-form-row">
            <span>Access token</span>
            <input
              type="password"
              value={form.token}
              placeholder={tokenUsable ? '•••• saved on this machine' : 'from `npm run token`'}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </label>
          {editing && !form.token.trim() && (addressChanged || (storedToken !== null && !storedToken.ok)) && (
            <p className="server-row-warn">
              {addressChanged
                ? 'The address changed — enter the token again to save: a saved token is only sent to the address it was entered for.'
                : storedToken && !storedToken.ok && storedToken.reason !== 'none'
                  ? storedToken.error
                  : 'Enter the access token: none is saved for this address.'}
            </p>
          )}
          {repositories.map((repo) => (
            <label className="server-form-row" key={repo.id}>
              <span>{repo.name} path on server</span>
              <input
                value={form.repoPaths[repo.id] ?? ''}
                placeholder="/home/dev/repos/Trek"
                spellCheck={false}
                onChange={(e) =>
                  setForm({ ...form, repoPaths: { ...form.repoPaths, [repo.id]: e.target.value } })
                }
              />
            </label>
          ))}
          {testResult && (
            <div className={`server-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? (
                <>
                  Connected — trek-server {testResult.daemonVersion}
                  {' · '}
                  {testResult.repoOk ? 'repo OK' : '⚠ repo path not in the server config'}
                  {testResult.claudeAvailable !== undefined &&
                    ` · ${
                      testResult.claudeAvailable
                        ? `claude ${testResult.claudeVersion ?? 'available'}`
                        : '⚠ claude CLI not found on server'
                    }`}
                </>
              ) : (
                <>Connection failed: {testResult.error}</>
              )}
            </div>
          )}
          <div className="server-form-actions">
            <button className="btn btn-ghost" disabled={testing || filledPaths.length === 0} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <span className="session-row-spacer" />
            <button className="btn btn-ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button
              className="btn btn-accent"
              disabled={!canSave}
              title={needsToken ? 'Enter the token again: the address changed' : undefined}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
