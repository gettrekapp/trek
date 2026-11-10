// "Move to another server…" (phase 5d): pick one of the app's other servers and a place there (a
// project's repository with the same origin), see what moves and what doesn't, then run the move
// (v2/moveFlow.ts) step by step. The source is this window's server; the target is reached through
// the same main-process relay as every server window, so no token is in this window. The dialog is
// on the worktree it was opened on (WorktreeDetail holds it from the click), and from Move on, on
// the place picked then: the move removes the worktree's row, and the detail behind moves on.
import { useEffect, useMemo, useRef, useState } from 'react'
import { environmentFor, repoOfInfo, useAppStore } from '../store'
import { getBackend } from '../backend'
import { useFeatures } from '../useFeatures'
import { destroyEnvironmentIfAny } from '../environmentActions'
import { envRepoKey } from '../../../shared/environments'
import { errorText } from '../v2/errors'
import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
import { MOVE_STEPS, moveWorktree, setRunningMove, type MoveOutcome, type MoveStepKey, type MoveStepStatus, type Requester } from '../v2/moveFlow'
import { CAPABILITY } from '../../../shared/protocolV2'
import type { MoveCandidate, MovePlan } from '../../../shared/move'
import { useAppServerLinks } from '../useAppServerLinks'
import { moveTargets } from '../v2/moveFlow'
import type { RegisteredServer } from '../../../shared/client/index'
import type { GitWorktreeInfo, StackStatus } from '../../../shared/types'

interface Props {
  /** The worktree on this window's server */
  from: { projectId: string; worktreeId: string }
  /** The worktree as the window listed it when the dialog opened: its path and branch, for its VM and dev stack */
  info: GitWorktreeInfo
  name: string
  onClose: () => void
}

const GLYPHS: Record<MoveStepStatus, string> = { pending: '○', active: '◐', done: '✓', skipped: '–', failed: '✗' }
/** What each glyph means, for screen readers */
const STATUS_TEXT: Record<MoveStepStatus, string> = { pending: 'to do', active: 'in progress', done: 'done', skipped: 'skipped', failed: 'failed' }

type TargetState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; candidates: MoveCandidate[] }

/** Where the move goes, fixed when it starts: the pickers (and the server list) can't change it after */
interface Frozen {
  entryId: string
  targetName: string
  projectId: string
  projectName: string
}

/** The worktree's dev stack: unknown while it is read, or when the read failed */
type StackRead = { kind: 'loading' } | { kind: 'ok'; status: StackStatus | null } | { kind: 'error'; message: string }

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

/** Paths that are lost with the source: listed when few, folded behind a summary when many */
function PathList({ paths, count }: { paths: string[]; count: number }): React.JSX.Element {
  const list = (
    <ul className="move-paths">
      {paths.map((p) => (
        <li key={p}>{p}</li>
      ))}
      {count > paths.length && <li className="muted">and {count - paths.length} more</li>}
    </ul>
  )
  return count > 5 ? (
    <details>
      <summary>Show them</summary>
      {list}
    </details>
  ) : (
    list
  )
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
  const [frozen, setFrozen] = useState<Frozen | null>(null)
  const [steps, setSteps] = useState<Partial<Record<MoveStepKey, { status: MoveStepStatus; detail?: string }>>>({})
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null)
  const cancelled = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const opened = useRef(new Set<string>())
  const dialog = useRef<HTMLDivElement>(null)
  const serverSelect = useRef<HTMLSelectElement>(null)
  const choosing = phase === 'choose'

  const source = useMemo(() => (ownEntry ? registeredServerEntry(ownEntry) : undefined), [ownEntry])

  // The worktree's Docker VM and dev stack on the source's machine (the same ones Delete tears down).
  const features = useFeatures()
  const project = useAppStore((s) => s.project)
  const environments = useAppStore((s) => s.environments)
  const repo = project ? (() => { try { return repoOfInfo(project, info) } catch { return undefined } })() : undefined
  const env = features.env && repo ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
  // Read when the dialog opens, and again on Retry. Until a read succeeds Move stays disabled: a
  // running stack can't be told from none, and a stack not known can't be torn down.
  const [stackRead, setStackRead] = useState<StackRead>(features.stacks ? { kind: 'loading' } : { kind: 'ok', status: null })
  const [stackTry, setStackTry] = useState(0)
  useEffect(() => {
    if (!features.stacks) {
      setStackRead({ kind: 'ok', status: null })
      return
    }
    let live = true
    setStackRead({ kind: 'loading' })
    getBackend()
      .stacks.status({ path: info.path })
      .then(
        (status) => live && setStackRead({ kind: 'ok', status }),
        (err: unknown) => live && setStackRead({ kind: 'error', message: errorText(err) })
      )
    return () => {
      live = false
    }
  }, [features.stacks, info.path, stackTry])
  const stack = stackRead.kind === 'ok' ? stackRead.status : null
  const stackUnknown = stackRead.kind !== 'ok'
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

  // Only while choosing: once the move starts, nothing here is read again.
  useEffect(() => {
    if (!source || !choosing || plan) return
    let live = true
    source.connection.request('move.prepare', { projectId: from.projectId, worktreeId: from.worktreeId }).then(
      (p) => live && setPlan(p),
      (err: unknown) => live && setPlanError(errorText(err))
    )
    return () => {
      live = false
    }
  }, [source, choosing, plan, from.projectId, from.worktreeId])

  // Connections opened only for this dialog are closed with it; a move cut short by the window
  // closing no longer holds the window's close.
  useEffect(
    () => () => {
      for (const id of opened.current) dropServerEntry(id)
      setRunningMove(null)
    },
    []
  )

  // Escape closes it, except while the move runs. The dialog takes the focus, then the server picker.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || phase === 'running') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, onClose])
  useEffect(() => {
    dialog.current?.focus()
  }, [])
  const planReady = !!plan
  useEffect(() => {
    if (planReady) serverSelect.current?.focus()
  }, [planReady])

  useEffect(() => {
    if (!entryId || !plan || !choosing) return
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
    // `choosing` is left out: leaving 'choose' must not run this again (nor drop what it found).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, plan, source])

  const chosen = target.kind === 'ready' ? target.candidates.find((c) => `${c.projectId} ${c.repoId}` === pick && !c.blocked) : undefined
  const allBlocked = target.kind === 'ready' && target.candidates.length > 0 && target.candidates.every((c) => !!c.blocked)
  const targetName = frozen?.targetName ?? servers.find((s) => s.id === entryId)?.name ?? 'the server'

  const start = async (): Promise<void> => {
    if (phase !== 'choose' || !source || !chosen || !plan || stackUnknown || machineBlocks) return
    const server = registeredServerEntry(entryId)
    if (!server) return
    setFrozen({ entryId, targetName, projectId: chosen.projectId, projectName: chosen.projectName })
    setPhase('running')
    setRunningMove(`Moving “${name}” to ${targetName}. Closed now, it stops partway: this worktree stays, and ${targetName} may have a copy too.`)
    const result = await moveWorktree({
      source: requester(source),
      target: requester(server),
      from,
      to: { projectId: chosen.projectId, repoId: chosen.repoId },
      loaded: plan.loaded,
      targetCapabilities: server.connection.welcome?.capabilities ?? [],
      ...(machine && tearDown ? { teardown } : machine ? { teardownUnticked: true } : {}),
      progress: (step, status, detail) => setSteps((prev) => ({ ...prev, [step]: { status, detail } })),
      cancelled: () => cancelled.current
    })
    setRunningMove(null)
    setOutcome(result)
    setPhase('done')
  }

  // The project picked at Move. The window opens on the project, the moved worktree in its list:
  // openServerProject has no way to select a worktree (attention's select needs a session).
  const openTarget = (): void => {
    if (!frozen) return
    void window.api.openServerProject(frozen.entryId, frozen.projectId, frozen.projectName, frozen.targetName)
    onClose()
  }

  /** From the receive on, the target is building it: no cancelling (Decision 21) */
  const committed = !!steps.receive && steps.receive.status !== 'pending'
  const reload = (restored: boolean): string =>
    restored ? '' : " Its sessions were stopped for the move and could not be started again: load it again."

  const carried = plan?.sessions.filter((s) => s.carried) ?? []
  const left = plan?.sessions.filter((s) => !s.carried) ?? []

  return (
    <div className="modal-backdrop" onMouseDown={() => phase !== 'running' && onClose()}>
      <div
        className="modal move-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-modal-title"
        tabIndex={-1}
        ref={dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="move-modal-title">Move “{name}” to another server</h2>
        {planError && <div className="server-test-result fail">{planError}</div>}
        {choosing && !plan && !planError && <p className="muted move-reading">Reading the worktree…</p>}
        {choosing && plan && (
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
                <select ref={serverSelect} value={entryId} onChange={(e) => setEntryId(e.target.value)}>
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
            {allBlocked && (
              <div className="server-test-result fail move-all-blocked">
                Every place on {targetName} is blocked (the list says why): free one there first.
              </div>
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
              {plan.ignoredCount > 0 && (
                <li className="warn move-ignored">
                  {plan.ignoredCount} ignored file(s) or folder(s) are not moved and are deleted with this worktree: copy what you need first.
                  <PathList paths={plan.ignored} count={plan.ignoredCount} />
                </li>
              )}
              {plan.hiddenChangesCount > 0 && (
                <li className="warn move-hidden">
                  {plan.hiddenChangesCount} file(s) flagged assume-unchanged or skip-worktree: their changes are not moved and are deleted with this
                  worktree.
                  <PathList paths={plan.hiddenChanges} count={plan.hiddenChangesCount} />
                </li>
              )}
              {plan.loaded && <li>Its running sessions are stopped first.</li>}
              {stackRead.kind === 'error' && (
                <li className="warn move-stack-error">
                  Could not read its dev stack ({stackRead.message}), so Move waits until it can.{' '}
                  <button className="btn move-retry" onClick={() => setStackTry((n) => n + 1)}>
                    Retry
                  </button>
                </li>
              )}
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
        {!choosing && (
          <ul className="move-steps" aria-live="polite">
            {MOVE_STEPS.map(({ key, label }) => {
              const step = steps[key] ?? { status: 'pending' as MoveStepStatus }
              return (
                <li key={key} className={`move-step ${step.status}`}>
                  <span className="move-step-glyph" aria-hidden="true">
                    {GLYPHS[step.status]}
                  </span>
                  <span className="visually-hidden">{STATUS_TEXT[step.status]}: </span>
                  <span className="move-step-label">{label}</span>
                  {step.detail && <div className="move-step-detail">{step.detail}</div>}
                </li>
              )
            })}
          </ul>
        )}
        {phase === 'running' && committed && (
          <p className="muted move-committed">{targetName} is creating the worktree now: from here on the move can't be cancelled.</p>
        )}
        <div role="status" aria-live="polite">
          {outcome?.kind === 'moved' && (
            <div className="server-test-result ok">
              Moved to {targetName}.{outcome.notes.length > 0 && <ul>{outcome.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            </div>
          )}
          {outcome?.kind === 'failed' && !outcome.undone && (
            <div className="server-test-result fail">
              {outcome.cancelled ? 'Cancelled.' : `The move failed: ${outcome.error}.`} Nothing changed on {targetName}
              {outcome.step === 'histories' || outcome.step === 'receive' || (outcome.cancelled && outcome.step === 'push') ? ' (the branch is pushed to origin)' : ''}, and this worktree is
              {outcome.restored ? ' as it was.' : ' still here.'}
              {reload(outcome.restored)}
            </div>
          )}
          {outcome?.kind === 'failed' && outcome.undone && (
            <div className="server-test-result fail">
              The move stopped: {outcome.error}. {targetName} had created the worktree, and that was undone there (the worktree, the branch it made, the
              branch data and the session histories). This worktree is {outcome.restored ? 'as it was' : 'still here'}; the branch stays pushed to origin.
              {reload(outcome.restored)}
            </div>
          )}
          {outcome?.kind === 'unknown' && (
            <div className="server-test-result fail">
              The answer from {targetName} was lost ({outcome.error}), so it may or may not have created the worktree. Nothing was removed here: this
              worktree is intact{outcome.restored ? ', its sessions started again' : ''}. Open {targetName} to check before moving it again (a second move
              is refused while a copy is there).{reload(outcome.restored)}
            </div>
          )}
          {outcome?.kind === 'both' && <div className="server-test-result fail">{outcome.error}</div>}
        </div>
        <div className="modal-footer">
          {choosing && (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" disabled={!chosen || machineBlocks || stackUnknown} onClick={() => void start()}>
                Move worktree
              </button>
            </>
          )}
          {/* Cancel stays where it was until the target starts building; Move stays too, disabled,
              so a second click on it lands on nothing. */}
          {phase === 'running' && (
            <>
              {!committed && (
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
              <button className="btn btn-accent" disabled>
                Moving…
              </button>
            </>
          )}
          {phase === 'done' && (
            <>
              {(outcome?.kind === 'moved' || outcome?.kind === 'both' || outcome?.kind === 'unknown') && (
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
