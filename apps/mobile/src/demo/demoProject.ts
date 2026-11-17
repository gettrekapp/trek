// Finding things in the demo's project, and its attention list (apps/mobile/src/demo). Pure, except
// attentionOf and setStatus, which keep `state.since` (the handlers change what these return).
import type { AttentionEntry, Automation, Project, Repository, Session, Worktree } from '../shared.ts'
import { DEMO_PROJECT_ID, type DemoState } from './demoData.ts'
import { DemoError } from './demoError.ts'

export function checkProject(projectId: unknown): void {
  if (projectId !== DEMO_PROJECT_ID) throw new DemoError('NOT_FOUND', 'No such project')
}

export function findRepo(project: Project, repoId: unknown): Repository {
  const repo = project.repositories.find((r) => r.id === repoId)
  if (!repo) throw new DemoError('NOT_FOUND', 'No such repository')
  return repo
}

export function findWorktree(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === worktreeId)
    if (worktree) return { repo, worktree }
  }
  throw new DemoError('NOT_FOUND', 'No such worktree')
}

export interface FoundSession {
  session: Session
  /** The list it is in (a worktree's sessions, or the Global panel's) */
  list: Session[]
  repo?: Repository
  worktree?: Worktree
}

export function allSessions(project: Project): FoundSession[] {
  const out: FoundSession[] = project.globalSessions.map((session) => ({ session, list: project.globalSessions }))
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) for (const session of worktree.sessions) out.push({ session, list: worktree.sessions, repo, worktree })
  }
  return out
}

export function findSession(project: Project, sessionId: unknown): FoundSession {
  const found = allSessions(project).find((f) => f.session.id === sessionId)
  if (!found) throw new DemoError('NOT_FOUND', 'No such session')
  return found
}

export function findAutomation(automations: Automation[], automationId: unknown): Automation {
  const automation = automations.find((a) => a.id === automationId)
  if (!automation) throw new DemoError('NOT_FOUND', 'No such automation')
  return automation
}

/**
 * What the `attention` topic lists: sessions in attention or done, open decisions, PR notices; oldest first (as the real server
 * does). A flagged session with no `since` yet gets `now`, kept in `state.since`. `audioAlerts` is never set: the demo project has none.
 */
export function attentionOf(state: DemoState, now: number): AttentionEntry[] {
  const project = state.project
  const out: AttentionEntry[] = []
  for (const { session, worktree } of allSessions(project)) {
    if (worktree && !worktree.loaded) continue
    const waiting = session.status === 'attention' || session.status === 'done'
    // Leaving attention/done forgets its `since`, as the real server does: a new wait is a new time
    if (!waiting) delete state.since[session.id]
    if (!waiting && !session.decision) continue
    const since = waiting ? (state.since[session.id] ??= now) : session.decision!.at
    out.push({
      projectId: project.id,
      worktreeId: worktree?.id ?? null,
      sessionId: session.id,
      title: session.title,
      status: session.status,
      since,
      ...(session.decision ? { decision: session.decision } : {}),
      projectName: project.name
    })
  }
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      const notice = worktree.prNotice
      if (!notice) continue
      out.push({
        projectId: project.id,
        worktreeId: worktree.id,
        sessionId: '',
        title: notice.title,
        status: 'attention',
        since: notice.at,
        projectName: project.name,
        pullRequest: { text: notice.text, url: notice.url }
      })
    }
  }
  return out.sort((a, b) => a.since - b.since)
}

/** The one place a session's status changes: waiting (attention, done) records since, anything else forgets it */
export function setStatus(state: DemoState, session: Session, status: Session['status'], now: number): void {
  session.status = status
  if (status === 'attention' || status === 'done') state.since[session.id] = now
  else delete state.since[session.id]
}
