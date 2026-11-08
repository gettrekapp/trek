// Main's requests to show a session in this window (attention:select, or the
// select handed over by window:takeInitial while the window was loading), the
// sessions this window reports in view, and main's alert sound.
import { useAppStore } from './store'
import { focusTerminal, revealTerminal } from './terminals'
import { playAlertSound } from './audio'
import { v2Ids } from './v2/applyProjection'
import { sameIds, selectStep, sessionsInView } from './v2/sessionSelect'
import type { SessionSelect } from '../../shared/types'

/** A select still waiting for the project (or its session) is dropped after this long. */
export const SELECT_WAIT_MS = 15_000

let pending: { select: SessionSelect; timer: ReturnType<typeof setTimeout> } | null = null

function tryPending(): void {
  if (!pending) return
  const s = useAppStore.getState()
  const step = selectStep(pending.select, {
    here: s.serverWindow,
    projected: s.project !== null,
    terminals: s.terminals,
    legacyByWorktree: v2Ids()?.legacyByWorktree ?? {}
  })
  if ('wait' in step) return
  clearTimeout(pending.timer)
  pending = null
  if ('reveal' in step) {
    revealTerminal(step.reveal)
    // The tab's pane mounts on reveal; focus once it has.
    requestAnimationFrame(() => focusTerminal(step.reveal))
  } else if ('worktree' in step) s.setActiveWorktree(step.worktree)
}

/** Shows the session as soon as the window has it; a newer request replaces an older one. */
export function requestSessionSelect(select: SessionSelect): void {
  if (pending) clearTimeout(pending.timer)
  pending = { select, timer: setTimeout(() => (pending = null), SELECT_WAIT_MS) }
  tryPending()
}

/** Follows main's select requests, reports the sessions in view, and plays main's alert. */
export function watchAttention(): () => void {
  let reported: string[] = []
  const report = (): void => {
    const now = sessionsInView(useAppStore.getState())
    if (sameIds(now, reported)) return
    reported = now
    window.api.attention.viewing(now)
  }
  const offStore = useAppStore.subscribe(() => {
    tryPending()
    report()
  })
  const offSelect = window.api.attention.onSelect(requestSessionSelect)
  const offAlert = window.api.attention.onAlert(playAlertSound)
  return () => {
    offStore()
    offSelect()
    offAlert()
  }
}
