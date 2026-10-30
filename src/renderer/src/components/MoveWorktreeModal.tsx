import { useRef, useState } from 'react'
import { serverById, useAppStore } from '../store'
import { MOVE_STEPS, moveWorktree, type MoveStepKey } from '../worktreeActions'
import type { GitWorktreeInfo, WorktreeInstance } from '../../../shared/types'

interface Props {
  info: GitWorktreeInfo
  instance: WorktreeInstance | undefined
  /** undefined = the local machine */
  targetServerId: string | undefined
  onClose: () => void
  /** Called after a successful move so the worktree lists refresh. */
  onMoved: () => void
}

type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

const STEP_GLYPHS: Record<StepStatus, string> = {
  pending: '○',
  active: '◐',
  done: '✓',
  skipped: '–',
  failed: '✗'
}

export function MoveWorktreeModal({
  info,
  instance,
  targetServerId,
  onClose,
  onMoved
}: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const [steps, setSteps] = useState<Record<string, { status: StepStatus; detail?: string }>>({})
  const [phase, setPhase] = useState<'confirm' | 'running' | 'success' | 'failed'>('confirm')
  const [warning, setWarning] = useState<string | undefined>()
  const cancelled = useRef(false)

  const sourceName = info.serverId
    ? (serverById(project, info.serverId)?.name ?? 'server')
    : 'this machine'
  const targetName = targetServerId
    ? (serverById(project, targetServerId)?.name ?? 'server')
    : 'this machine'

  const start = async (): Promise<void> => {
    setPhase('running')
    const result = await moveWorktree({
      info,
      instance,
      targetServerId,
      onProgress: (step: MoveStepKey, status, detail) =>
        setSteps((prev) => ({
          ...prev,
          [step]: { status: status as StepStatus, detail }
        })),
      isCancelled: () => cancelled.current
    })
    if (result.ok) {
      setWarning(result.warning)
      setPhase('success')
      onMoved()
    } else {
      setPhase('failed')
    }
  }

  const cancel = (): void => {
    if (phase === 'running') {
      // Takes effect between steps; everything up to the commit point rolls back.
      cancelled.current = true
    } else {
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => phase !== 'running' && onClose()}>
      <div className="modal move-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          Move “{info.branch ?? info.path}” to {targetName}
        </h2>
        {phase === 'confirm' && (
          <p className="muted">
            The branch is pushed to origin from {sourceName}, checked out into a new worktree on{' '}
            {targetName}, uncommitted changes travel as a patch, and its Claude sessions move with
            it and resume. The source worktree is only removed after everything is verified on the
            target.
          </p>
        )}
        <ul className="move-steps">
          {MOVE_STEPS.map(({ key, label }) => {
            const step = steps[key] ?? { status: 'pending' as StepStatus }
            return (
              <li key={key} className={`move-step ${step.status}`}>
                <span className="move-step-glyph">{STEP_GLYPHS[step.status]}</span>
                <span className="move-step-label">{label}</span>
                {step.detail && <div className="move-step-detail">{step.detail}</div>}
              </li>
            )
          })}
        </ul>
        {phase === 'success' && (
          <div className="server-test-result ok">
            Moved to {targetName}.{warning ? ` ${warning}` : ''}
          </div>
        )}
        {phase === 'failed' && (
          <div className="server-test-result fail">
            The move failed and was rolled back — nothing changed on {sourceName}. Closed Claude
            sessions can be restarted from the worktree.
          </div>
        )}
        <div className="modal-footer">
          {phase === 'confirm' && (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" onClick={() => void start()}>
                Move worktree
              </button>
            </>
          )}
          {phase === 'running' && (
            <button onClick={cancel} disabled={cancelled.current}>
              {cancelled.current ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {(phase === 'success' || phase === 'failed') && <button onClick={onClose}>Close</button>}
        </div>
      </div>
    </div>
  )
}
