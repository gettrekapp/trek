import { useEffect, useRef, useState } from 'react'
import { ENV_DEFAULTS, deriveProfileName, envRepoKey, parseEnvVars } from '../../../shared/environments'
import type { EnvService, EnvUpStep, GitWorktreeInfo } from '../../../shared/types'
import { refreshEnvironments } from '../environmentActions'
import { envStartArgs } from '../environmentStart'
import { SettingText } from './SettingText'
import { environmentFor, repoById, repoOfInfo, useAppStore } from '../store'

interface Props {
  visible: boolean
  info: GitWorktreeInfo
}

const PS_POLL_MS = 5000
const MAX_LOG = 30_000
const SERVICE_LOGS_POLL_MS = 3000
const SERVICE_LOGS_TAIL = 300

type StepStatus = 'active' | 'done' | 'failed'

const ENV_STEPS: { key: EnvUpStep; label: string }[] = [
  { key: 'vm', label: 'Starting VM' },
  { key: 'compose', label: 'Starting services' },
  { key: 'ready', label: 'Environment ready' }
]

const STEP_GLYPHS: Record<StepStatus | 'pending', string> = {
  pending: '○',
  active: '◐',
  done: '✓',
  failed: '✗'
}

export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)
  const toolCheck = useAppStore((s) => s.envToolCheck)
  const setEnvBusy = useAppStore((s) => s.setEnvBusy)
  const setBranchEnvVars = useAppStore((s) => s.setBranchEnvVars)
  const serverWindow = useAppStore((s) => s.serverWindow !== null)

  const repo = project ? repoOfInfo(project, info) : undefined
  // The path its VM names hash: the repository's, or the one an import kept (envRepoKey).
  const repoPath = repo ? envRepoKey(repo) : ''
  const profile = info.branch ? deriveProfileName(repoPath, info.branch) : null
  const env = environmentFor(environments, repoPath, info.branch)
  const busy = profile ? envBusy[profile] : undefined
  const running = env?.vmState === 'running'

  const [services, setServices] = useState<EnvService[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Compose files found in the worktree root, for the Apply-compose picker.
  const [composeCandidates, setComposeCandidates] = useState<string[]>([])
  // User's picker choice; null = follow what's running / the project setting.
  const [composeChoice, setComposeChoice] = useState<string | null>(null)
  const [showVars, setShowVars] = useState(false)
  const composeFile =
    composeChoice ??
    env?.composeFile ??
    repo?.environments?.composeFile ??
    (ENV_DEFAULTS.composeFile as string)
  const [steps, setSteps] = useState<Partial<Record<EnvUpStep, StepStatus>> | null>(null)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  // Service whose logs are open; null = pane closed. Logs are a re-fetched
  // tail (docker compose logs --tail), not a stream — no process to manage.
  const [logsService, setLogsService] = useState<string | null>(null)
  const [serviceLogs, setServiceLogs] = useState<string | null>(null)
  const serviceLogRef = useRef<HTMLPreElement>(null)
  // Follow the tail unless the user has scrolled up to read.
  const followLogsRef = useRef(true)

  const appendLog = (text: string): void => setLog((prev) => (prev + text).slice(-MAX_LOG))

  // Output (and step markers) stream in regardless of which tab is showing.
  useEffect(() => {
    if (!profile) return undefined
    return window.api.onEnvLog((event) => {
      if (event.profile !== profile) return
      if (event.data) appendLog(event.data)
      if (event.step) {
        const step = event.step
        setSteps((prev) => {
          const next: Partial<Record<EnvUpStep, StepStatus>> = {}
          for (const s of ENV_STEPS) {
            if (s.key === step) next[s.key] = step === 'ready' ? 'done' : 'active'
            else if (prev?.[s.key]) next[s.key] = 'done'
          }
          return next
        })
      }
    })
  }, [profile])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  // The panel instance is reused across worktree selections — don't carry one
  // worktree's picker choice (or candidates) over to another.
  useEffect(() => {
    setComposeChoice(null)
    setComposeCandidates([])
  }, [info.path])

  // Discover compose files whenever the panel is shown (local worktrees only).
  useEffect(() => {
    if (!visible || info.serverId) return undefined
    let disposed = false
    window.api
      .envComposeFiles(null, info.path)
      .then((files) => {
        if (!disposed) setComposeCandidates(files)
      })
      .catch(() => {
        // worktree unreadable — the picker just shows the current selection
      })
    return () => {
      disposed = true
    }
  }, [visible, info.serverId, info.path])

  // Service status only matters while the panel is open and the VM is up.
  useEffect(() => {
    if (!visible || !running || !profile) return undefined
    let disposed = false
    const poll = async (): Promise<void> => {
      try {
        const result = await window.api.envPs(null, profile, info.path, composeFile)
        if (!disposed) setServices(result)
      } catch {
        // VM mid-boot or context missing — the next poll retries
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), PS_POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [visible, running, profile, info.path, composeFile])

  useEffect(() => {
    if (!visible || !running || !profile || !logsService) return undefined
    let disposed = false
    const fetchLogs = async (): Promise<void> => {
      try {
        const text = await window.api.envLogs(
          null,
          profile,
          info.path,
          composeFile,
          logsService,
          SERVICE_LOGS_TAIL
        )
        if (!disposed) setServiceLogs(text)
      } catch (err) {
        if (!disposed) setServiceLogs(String(err))
      }
    }
    void fetchLogs()
    const interval = setInterval(() => void fetchLogs(), SERVICE_LOGS_POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [visible, running, profile, logsService, info.path, composeFile])

  useEffect(() => {
    const el = serviceLogRef.current
    if (el && followLogsRef.current) el.scrollTo(0, el.scrollHeight)
  }, [serviceLogs])

  if (!profile || !info.branch) {
    return (
      <div className="env-panel" style={{ display: visible ? 'flex' : 'none' }}>
        <p className="muted">Environments need a worktree on a branch.</p>
      </div>
    )
  }
  if (info.serverId) {
    return (
      <div className="env-panel" style={{ display: visible ? 'flex' : 'none' }}>
        <p className="muted">Environments are not available for remote worktrees yet.</p>
      </div>
    )
  }

  const varsText = repo?.branchEnvVars?.[info.branch] ?? ''
  const varCount = Object.keys(parseEnvVars(varsText)).length

  const start = async (): Promise<void> => {
    setEnvBusy(profile, 'start')
    setError(null)
    setSteps({ vm: 'active' })
    try {
      // The store's project now, not this render's: a variables draft this click's blur just
      // committed is in it (a server window shows the pending edit at once).
      const now = useAppStore.getState().project
      const { settings, envVars } = envStartArgs(now ? repoById(now, info.repoId) : repo, info.branch!, composeFile)
      const result = await window.api.envUp(null, repoPath, info.branch!, info.path, settings, envVars)
      if (result.code === 0) {
        setSteps({ vm: 'done', compose: 'done', ready: 'done' })
      } else {
        setError(result.error ?? `Start failed (exit code ${result.code})`)
        setSteps((prev) => {
          const next = { ...prev }
          for (const s of ENV_STEPS) if (next[s.key] === 'active') next[s.key] = 'failed'
          return next
        })
      }
    } catch (err) {
      setError(String(err))
    } finally {
      useAppStore.getState().setEnvBusy(profile, null)
      void refreshEnvironments()
    }
  }

  const stop = async (): Promise<void> => {
    setEnvBusy(profile, 'stop')
    setError(null)
    setSteps(null)
    try {
      await window.api.envStop(null, profile)
    } catch (err) {
      setError(String(err))
    } finally {
      useAppStore.getState().setEnvBusy(profile, null)
      setServices(null)
      void refreshEnvironments()
    }
  }

  const destroy = async (): Promise<void> => {
    const ok = await window.api.confirm({
      title: 'Reset environment',
      message: `Reset the environment for ${info.branch}?`,
      detail: `Deletes the VM "${profile}" and all container data/volumes for this branch. The worktree itself is untouched.`,
      confirmLabel: 'Reset'
    })
    if (!ok) return
    setEnvBusy(profile, 'destroy')
    setError(null)
    setSteps(null)
    try {
      await window.api.envDestroy(null, profile)
    } catch (err) {
      setError(String(err))
    } finally {
      useAppStore.getState().setEnvBusy(profile, null)
      setServices(null)
      void refreshEnvironments()
    }
  }

  const address = env?.address
  const serviceUrl = (published: number): string =>
    address ? `http://${address}:${published}` : `http://localhost:${published}`

  // Picker options: each compose file on its own, plus "base + variant" layered
  // combos (docker compose only auto-merges override files when run without -f,
  // and we always pass -f, so layering must be explicit).
  const composeOptions: { value: string; label: string }[] = composeCandidates.map((f) => ({
    value: f,
    label: f
  }))
  const composeBase = composeCandidates.find((f) => /^(docker-)?compose\.(yml|yaml)$/i.test(f))
  if (composeBase) {
    for (const f of composeCandidates) {
      if (f === composeBase) continue
      composeOptions.push({ value: `${composeBase},${f}`, label: `${composeBase} + ${f}` })
    }
  }
  // Keep the active selection visible even when it isn't among the candidates
  // (custom settings path, or the file was removed since the env started).
  if (!composeOptions.some((o) => o.value === composeFile)) {
    composeOptions.unshift({ value: composeFile, label: composeFile })
  }

  const stateLabel = busy
    ? { start: 'Starting…', stop: 'Stopping…', destroy: 'Resetting…' }[busy]
    : env == null || env.vmState === 'missing'
      ? 'Not created'
      : env.vmState === 'running'
        ? 'Running'
        : 'Stopped'

  return (
    <div className="env-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="env-list">
        {toolCheck && !toolCheck.ok && (
          <div className="error">
            {toolCheck.error}
            <br />
            <span className="muted">brew install colima docker docker-compose</span>
          </div>
        )}
        <div className="env-header">
          <span className={`docker-dot ${running ? 'running' : 'exited'}`} title={stateLabel} />
          <div className="docker-info">
            <span className="docker-name">{profile}</span>
            <span className="docker-meta">
              {stateLabel}
              {address ? ` · ${address}` : ''}
            </span>
          </div>
          <div className="docker-actions">
            <select
              className="settings-select"
              title="Compose file(s) to apply"
              value={composeFile}
              disabled={!!busy}
              onChange={(e) => setComposeChoice(e.target.value)}
            >
              {composeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {!running && (
              <button disabled={!!busy || (toolCheck != null && !toolCheck.ok)} onClick={() => void start()}>
                {busy === 'start' ? 'Starting…' : 'Start'}
              </button>
            )}
            {running && (
              <>
                <button disabled={!!busy} onClick={() => void start()}>
                  {busy === 'start' ? 'Applying…' : 'Apply compose'}
                </button>
                <button disabled={!!busy} onClick={() => void stop()}>
                  {busy === 'stop' ? 'Stopping…' : 'Stop'}
                </button>
              </>
            )}
            {env && env.vmState !== 'missing' && (
              <button disabled={!!busy} onClick={() => void destroy()}>
                {busy === 'destroy' ? 'Resetting…' : 'Reset'}
              </button>
            )}
          </div>
        </div>
        <div className="env-vars">
          <button className="env-vars-toggle" onClick={() => setShowVars((v) => !v)}>
            {showVars ? '▾' : '▸'} Environment variables{varCount > 0 ? ` (${varCount})` : ''}
          </button>
          {showVars && (
            <>
              {/* A server window (Local) saves each commit on the server: on blur, not per keystroke. */}
              <SettingText
                key={`${repo!.id} ${info.branch}`}
                className="env-vars-editor"
                placeholder={'KEY=value — one per line'}
                value={varsText}
                rows={6}
                spellCheck={false}
                live={!serverWindow}
                onCommit={(text) => {
                  setBranchEnvVars(repo!.id, info.branch!, text)
                }}
              />
              <p className="muted env-vars-hint">
                Passed to docker compose for ${'{VAR}'} substitution — takes effect on the next
                Start / Apply compose.
              </p>
            </>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {steps && (
          <ul className="move-steps env-steps">
            {ENV_STEPS.map((s) => {
              const status = steps[s.key]
              return (
                <li key={s.key} className={`move-step ${status ?? ''}`}>
                  <span className="move-step-glyph">{STEP_GLYPHS[status ?? 'pending']}</span>
                  {s.label}
                </li>
              )
            })}
          </ul>
        )}
        {running && services && services.length > 0 && (
          <>
            <div className="docker-group-header">Services</div>
            {services.map((s) => (
              <div className="docker-row" key={s.name}>
                <span
                  className={`docker-dot ${s.state === 'running' ? 'running' : s.state}`}
                  title={s.state}
                />
                <div className="docker-info">
                  <span className="docker-name">{s.name}</span>
                  <span className="docker-meta">{s.status}</span>
                </div>
                <div className="env-links">
                  {s.ports.map((p) => (
                    <a
                      key={`${p.published}/${p.protocol}`}
                      href={serviceUrl(p.published)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {serviceUrl(p.published).replace('http://', '')}
                    </a>
                  ))}
                </div>
                <div className="docker-actions">
                  <button
                    onClick={() => {
                      const next = logsService === s.name ? null : s.name
                      setServiceLogs(null)
                      followLogsRef.current = true
                      setLogsService(next)
                    }}
                  >
                    {logsService === s.name ? 'Hide logs' : 'Logs'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        {running && services?.length === 0 && (
          <p className="muted">No services — is the compose file empty?</p>
        )}
        {!running && !busy && !steps && (
          <p className="muted">
            Start gives this worktree its own Docker VM
            {repo?.environments?.networkAddress !== false ? ' with its own IP address' : ''} —
            ports never collide with other worktrees.
          </p>
        )}
      </div>
      {running && logsService && (
        <div className="docker-log-wrap">
          <div className="docker-log-header">
            <span className="muted">
              logs: {logsService} (last {SERVICE_LOGS_TAIL} lines, auto-refreshing)
            </span>
            <button className="docker-log-clear" onClick={() => setLogsService(null)}>
              Close
            </button>
          </div>
          <pre
            className="docker-log"
            ref={serviceLogRef}
            onScroll={(e) => {
              const el = e.currentTarget
              followLogsRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {serviceLogs ?? 'Loading…'}
            {serviceLogs === '' && '(no output yet)'}
          </pre>
        </div>
      )}
      {log && (
        <div className="docker-log-wrap">
          <div className="docker-log-header">
            <span className="muted">environment output</span>
            <button className="docker-log-clear" onClick={() => setLog('')}>
              Clear
            </button>
          </div>
          <pre className="docker-log" ref={logRef}>
            {log}
          </pre>
        </div>
      )}
    </div>
  )
}
