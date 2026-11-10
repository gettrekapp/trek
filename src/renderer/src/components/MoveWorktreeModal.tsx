// "Move to another server…" (phase 5d): pick one of the app's other servers and a place there (a
// project's repository with the same origin), see what moves and what doesn't, then run the move
// (v2/moveFlow.ts) step by step. The source is this window's server; the target is reached through
// the same main-process relay as every server window, so no token is in this window.
import { useEffect, useMemo, useRef, useState } from 'react'
import { environmentFor, repoOfInfo, useAppStore } from '../store'
import { getBackend } from '../backend'
import { useFeatures } from '../useFeatures'
import { destroyEnvironmentIfAny } from '../environmentActions'
import { envRepoKey } from '../../../shared/environments'
import { errorText } from '../v2/errors'
import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
import { MOVE_STEPS, moveWorktree, type MoveOutcome, type MoveStepKey, type MoveStepStatus, type Requester } from '../v2/moveFlow'
import { CAPABILITY } from '../../../shared/protocolV2'
import type { MoveCandidate, MovePlan } from '../../../shared/move'
import { useAppServerLinks } from '../useAppServerLinks'
import { moveTargets } from '../v2/moveFlow'
import type { RegisteredServer } from '../../../shared/client/index'
import type { GitWorktreeInfo, StackStatus } from '../../../shared/types'

interface Props {
  /** The worktree on this window's server */
  from: { projectId: string; worktreeId: string }
  /** The worktree as the window lists it: its path and branch, for its VM and dev stack */
  info: GitWorktreeInfo
  name: string
  onClose: () => void
}

const GLYPHS: Record<MoveStepStatus, string> = { pending: '○', active: '◐', done: '✓', skipped: '–', failed: '✗' }

type TargetState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; candidates: MoveCandidate[] }

const requester = (server: RegisteredServer): Requester => (method, params, options) => server.connection.request(method, params, options)

/** Resolves once the entry's connection is up with a welcome; rejects after `ms`. */
function connected(server: RegisteredServer, ms = 15_000): Promise<string[]> {
  const ready = (): string[] | null => (server.connection.status === 'connected' && server.connection.welcome ? server.connection.welcome.capabilities : null)
  const now = ready()
  if (now) return Promise.resolve(now)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('The server did not answer'))
    }, ms)
    const off = server.connection.on('status', () => {
      const caps = ready()
      if (caps) {
        clearTimeout(timer)
        off()
        resolve(caps)
      }
    })
  })
}

export function MoveWorktreeModal({ from, info, name, onClose }: Props): React.JSX.Element {
  const serverWindow = useAppStore((s) => s.serverWindow)
  const ownEntry = serverWindow?.serverEntryId ?? ''
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const links = useAppServerLinks()
  const servers = moveTargets(links.servers, ownEntry)
  const [entryId, setEntryId] = useState('')
  const [target, setTarget] = useState<TargetState>({ kind: 'idle' })
  const [pick, setPick] = useState<string>('')
  const [phase, setPhase] = useState<'choose' | 'running' | 'done'>('choose')
  const [steps, setSteps] = useState<Partial<Record<MoveStepKey, { status: MoveStepStatus; detail?: string }>>>({})
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null)
  const cancelled = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const opened = useRef(new Set<string>())

  const source = useMemo(() => (ownEntry ? registeredServerEntry(ownEntry) : undefined), [ownEntry])

  // The worktree's Docker VM and dev stack on the source's machine (the same ones Delete tears down).
  const features = useFeatures()
  const project = useAppStore((s) => s.project)
  const environments = useAppStore((s) => s.environments)
  const repo = project ? (() => { try { return repoOfInfo(project, info) } catch { return undefined } })() : undefined
  const env = features.env && repo ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
  const [stack, setStack] = useState<StackStatus | null>(null)
  useEffect(() => {
    if (!features.stacks) return
    getBackend().stacks.status({ path: info.path }).then(setStack, () => setStack(null))
  }, [features.stacks, info.path])
  const stackName = stack?.available && stack.created ? stack.slug : undefined
  const machine = [env ? `its VM “${env.profile}”` : null, stackName ? `its dev stack “trek-${stackName}”` : null].filter(Boolean).join(' and ')
  const machineRunning = env?.vmState === 'running' || (!!stackName && !!stack && (stack.containers > 0 || stack.upRunning))
  const [tearDown, setTearDown] = useState(true)
  const machineBlocks = !!machine && !tearDown && machineRunning
  const teardown = async (): Promise<string[]> => {
    const warnings: string[] = []
    const backend = getBackend()
    if (stackName) {
      try {
        const code = await backend.stacks.destroy({ path: info.path })
        if (code !== 0) warnings.push(`stack.sh destroy exited with code ${code}. Remove the leftover stack on the source's machine with TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy.`)
      } catch (err) {
        warnings.push(`The dev stack was not destroyed: ${errorText(err)}`)
      }
    }
    if (env && repo) {
      const warning = await destroyEnvironmentIfAny(envRepoKey(repo), info.branch, backend)
      if (warning) warnings.push(`${warning} It is listed under Orphaned environments in Settings.`)
    }
    return warnings
  }

  useEffect(() => {
    if (!source) return
    source.connection
      .request('move.prepare', { projectId: from.projectId, worktreeId: from.worktreeId })
      .then(setPlan, (err: unknown) => setPlanError(errorText(err)))
  }, [source, from.projectId, from.worktreeId])

  // Connections opened only for this dialog are closed with it.
  useEffect(() => () => {
    for (const id of opened.current) dropServerEntry(id)
  }, [])

  useEffect(() => {
    if (!entryId || !plan) return
    let live = true
    setTarget({ kind: 'connecting' })
    setPick('')
    if (!registeredServerEntry(entryId)) opened.current.add(entryId)
    const server = connectServerEntry(entryId)
    void (async () => {
      try {
        const caps = await connected(server)
        if (server.connection.welcome?.serverId && server.connection.welcome.serverId === source?.connection.welcome?.serverId) {
          throw new Error('That is this window’s own server')
        }
        if (!caps.includes(CAPABILITY.move)) throw new Error('That server is too old to take a worktree: update it first')
        if (!plan.origin) throw new Error(`${plan.repoName} has no origin remote here, so the branch can't travel`)
        const candidates = await server.connection.request('move.candidates', { origin: plan.origin, branch: plan.branch })
        if (live) {
          setTarget({ kind: 'ready', candidates })
          const first = candidates.find((c) => !c.blocked)
          if (first) setPick(`${first.projectId} ${first.repoId}`)
        }
      } catch (err) {
        if (live) setTarget({ kind: 'error', message: errorText(err) })
      }
    })()
    return () => {
      live = false
    }
  }, [entryId, plan, source])

  const chosen = target.kind === 'ready' ? target.candidates.find((c) => `${c.projectId} ${c.repoId}` === pick && !c.blocked) : undefined
  const targetName = servers.find((s) => s.id === entryId)?.name ?? 'the server'

  const start = async (): Promise<void> => {
    if (!source || !chosen || !plan) return
    const server = registeredServerEntry(entryId)
    if (!server) return
    setPhase('running')
    const result = await moveWorktree({
      source: requester(source),
      target: requester(server),
      from,
      to: { projectId: chosen.projectId, repoId: chosen.repoId },
      loaded: plan.loaded,
      targetCapabilities: server.connection.welcome?.capabilities ?? [],
      ...(machine && tearDown ? { teardown } : {}),
      progress: (step, status, detail) => setSteps((prev) => ({ ...prev, [step]: { status, detail } })),
      cancelled: () => cancelled.current
    })
    setOutcome(result)
    setPhase('done')
  }

  const openTarget = (): void => {
    if (!chosen) return
    void window.api.openServerProject(entryId, chosen.projectId, chosen.projectName, targetName)
    onClose()
  }

  const carried = plan?.sessions.filter((s) => s.carried) ?? []
  const left = plan?.sessions.filter((s) => !s.carried) ?? []

  return (
    <div className="modal-backdrop" onMouseDown={() => phase !== 'running' && onClose()}>
      <div className="modal move-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Move “{name}” to another server</h2>
        {planError && <div className="server-test-result fail">{planError}</div>}
        {phase === 'choose' && plan && (
          <>
            <p className="muted">
              The branch is pushed to origin and checked out on the other server, the uncommitted work goes with it as a patch
              (all of it unstaged), and its Claude sessions' histories are copied so they resume there. This worktree is removed
              only once the new one is in place, and only if nothing changed here meanwhile.
            </p>
            {servers.length === 0 ? (
              <div className="server-test-result fail">There is no other server in this app to move it to. Add one under Servers first.</div>
            ) : (
              <label className="move-row">
                <span>Server</span>
                <select value={entryId} onChange={(e) => setEntryId(e.target.value)}>
                  <option value="">Choose a server…</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {target.kind === 'connecting' && <p className="muted">Connecting…</p>}
            {target.kind === 'error' && <div className="server-test-result fail">{target.message}</div>}
            {target.kind === 'ready' && target.candidates.length === 0 && (
              <div className="server-test-result fail">
                No project on {targetName} has a clone of {plan.repoName} (the same origin). Add the repository to a project there first.
              </div>
            )}
            {target.kind === 'ready' && target.candidates.length > 0 && (
              <label className="move-row">
                <span>Into</span>
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  {target.candidates.map((c) => (
                    <option key={`${c.projectId} ${c.repoId}`} value={`${c.projectId} ${c.repoId}`} disabled={!!c.blocked}>
                      {c.projectName} — {c.repoName}
                      {c.blocked ? ` (${c.blocked})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {chosen && <p className="muted move-path">New worktree: {chosen.path}</p>}
            <ul className="move-summary">
              <li>{carried.length === 0 ? 'No session history moves.' : `${carried.length} Claude session(s) move and can resume there.`}</li>
              {left.map((s, i) => (
                <li key={i} className="warn">
                  “{s.title}” is not moved: {s.reason}.
                </li>
              ))}
              {plan.reviewComments > 0 && <li className="warn">The {plan.reviewComments} unsent review comment(s) are not moved and are lost.</li>}
              {plan.queuedPrompts > 0 && <li className="warn">The {plan.queuedPrompts} queued prompt(s) are not moved and are lost.</li>}
              {plan.loaded && <li>Its running sessions are stopped first.</li>}
              {machine && (
                <li className={machineBlocks ? 'warn' : undefined}>
                  <label className="move-teardown">
                    <input type="checkbox" checked={tearDown} onChange={(e) => setTearDown(e.target.checked)} /> Tear down {machine} on this
                    server once the worktree is in place there
                  </label>
                  {!tearDown && (machineRunning ? ' It is running: stop it first, or tick this, to move.' : ' Left as it is (stopped), it stays behind.')}
                </li>
              )}
              <li>The note, tags, ticket, pull request link and Docker .env go with it{plan.prWatch ? ', and the PR watch moves there' : ''}.</li>
            </ul>
          </>
        )}
        {phase !== 'choose' && (
          <ul className="move-steps">
            {MOVE_STEPS.map(({ key, label }) => {
              const step = steps[key] ?? { status: 'pending' as MoveStepStatus }
              return (
                <li key={key} className={`move-step ${step.status}`}>
                  <span className="move-step-glyph">{GLYPHS[step.status]}</span>
                  <span className="move-step-label">{label}</span>
                  {step.detail && <div className="move-step-detail">{step.detail}</div>}
                </li>
              )
            })}
          </ul>
        )}
        {outcome?.kind === 'moved' && (
          <div className="server-test-result ok">
            Moved to {targetName}.{outcome.notes.length > 0 && <ul>{outcome.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        )}
        {outcome?.kind === 'failed' && (
          <div className="server-test-result fail">
            {outcome.error === 'Cancelled' ? 'Cancelled.' : `The move failed: ${outcome.error}`} Nothing changed on {targetName}, and this worktree is as it
            was.
          </div>
        )}
        {(outcome?.kind === 'both' || outcome?.kind === 'unknown') && <div className="server-test-result fail">{outcome.error}</div>}
        <div className="modal-footer">
          {phase === 'choose' && (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" disabled={!chosen || machineBlocks} onClick={() => void start()}>
                Move worktree
              </button>
            </>
          )}
          {phase === 'running' && (
            <button
              onClick={() => {
                cancelled.current = true
                setCancelling(true)
              }}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {phase === 'done' && (
            <>
              {(outcome?.kind === 'moved' || outcome?.kind === 'both') && (
                <button className="btn btn-accent" onClick={openTarget}>
                  Open on {targetName}
                </button>
              )}
              <button onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
