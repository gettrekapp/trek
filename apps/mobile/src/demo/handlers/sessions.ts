// The demo's sessions and terminals (apps/mobile/src/demo): session.*, review.send and pty.*. A
// prompt is typed into the session's terminal and gets a canned reply; then the session is done.
import { reviewPrompt, type Session, type Worktree } from '../../shared.ts'
import { DEMO_ROOT } from '../demoData.ts'
import { DemoError } from '../demoError.ts'
import type { DemoHandlers } from '../demoHandlers.ts'
import { allSessions, checkProject, findSession, findWorktree, setStatus, type FoundSession } from '../demoProject.ts'
import { promptEcho, replyFor, RESUMED, sessionBanner } from '../demoScripts.ts'
import type { DemoContext } from '../demoServer.ts'

const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', local: 'Local model' }
export const agentLabel = (provider: string): string => AGENT_LABELS[provider] ?? provider

/** Where a session runs, for its banner */
const whereOf = (found: { worktree?: Worktree }): string => found.worktree?.branch ?? found.worktree?.name ?? 'Global'

function ptyOf(ctx: DemoContext, found: FoundSession): string {
  const id = found.session.ptyId
  if (!id || !ctx.server.terminals.has(id)) throw new DemoError('PTY_NOT_FOUND', "The session isn't running: load its worktree's sessions first")
  return id
}

/** Types the prompt in and plays the reply (by default the canned one for it); then the session is done */
export function runPrompt(ctx: DemoContext, found: FoundSession, text: string, reply: string[] = replyFor(text)): void {
  const ptyId = ptyOf(ctx, found)
  const { session } = found
  delete session.decision
  delete ctx.server.state.ticking[session.id]
  setStatus(ctx.server.state, session, 'working', ctx.server.clock.now())
  ctx.server.changed()
  ctx.server.terminals.print(ptyId, promptEcho(text))
  ctx.server.terminals.play(ptyId, reply, () => {
    setStatus(ctx.server.state, session, 'done', ctx.server.clock.now())
    ctx.server.changed()
  })
}

/** The worktree's sessions get terminals again, each with the scrollback it had */
export function loadWorktree(ctx: DemoContext, worktree: Worktree): void {
  if (worktree.loaded) return
  worktree.loaded = true
  for (const session of worktree.sessions) {
    session.ptyId = ctx.server.terminals.open(`${ctx.server.state.scrollback[session.id] ?? ''}${RESUMED}`, worktree.path)
    delete ctx.server.state.scrollback[session.id]
    setStatus(ctx.server.state, session, 'idle', ctx.server.clock.now())
  }
}

/** The worktree's terminals end; their scrollback is kept for the next load */
export function unloadWorktree(ctx: DemoContext, worktree: Worktree): void {
  if (!worktree.loaded) return
  for (const session of worktree.sessions) {
    if (session.ptyId) ctx.server.state.scrollback[session.id] = ctx.server.terminals.close(session.ptyId)
    delete session.ptyId
    delete session.decision
    delete ctx.server.state.ticking[session.id]
    setStatus(ctx.server.state, session, 'idle', ctx.server.clock.now())
  }
  worktree.loaded = false
}

type SessionMethods =
  | 'session.start'
  | 'session.restart'
  | 'session.close'
  | 'session.sendPrompt'
  | 'session.enqueue'
  | 'session.dequeue'
  | 'session.dismissDecision'
  | 'review.send'
  | 'pty.attach'
  | 'pty.detach'
  | 'pty.write'
  | 'pty.resize'

export const SESSION_HANDLERS: DemoHandlers<SessionMethods> = {
  'session.start': (ctx, p) => {
    checkProject(p.projectId)
    const project = ctx.server.state.project
    const llm: Session['llm'] = p.llm ?? project.settings.llmDefault ?? { provider: 'claude' }
    const label = agentLabel(llm.provider)
    let found: { list: Session[]; worktree?: Worktree }
    if (p.worktreeId === null) found = { list: project.globalSessions }
    else {
      const { worktree } = findWorktree(project, p.worktreeId)
      loadWorktree(ctx, worktree)
      found = { list: worktree.sessions, worktree }
    }
    const session: Session = { id: ctx.server.newId('s'), title: p.title ?? label, llm, queue: [], status: 'idle' }
    session.ptyId = ctx.server.terminals.open(sessionBanner(label, whereOf(found)), found.worktree?.path ?? DEMO_ROOT)
    found.list.push(session)
    if (p.initialMessage) runPrompt(ctx, { ...found, session }, p.initialMessage)
    else ctx.server.changed()
    return { sessionId: session.id, ptyId: session.ptyId }
  },
  'session.restart': (ctx, p) => {
    checkProject(p.projectId)
    const found = findSession(ctx.server.state.project, p.sessionId)
    // The demo restarts a running session too (the real server refuses with BAD_REQUEST): friendlier for a demo
    if (found.worktree && !found.worktree.loaded) throw new DemoError('BAD_REQUEST', "Load the worktree's sessions first")
    const { session } = found
    if (session.ptyId) ctx.server.terminals.close(session.ptyId)
    session.ptyId = ctx.server.terminals.open(sessionBanner(agentLabel(session.llm.provider), whereOf(found)), found.worktree?.path ?? DEMO_ROOT)
    delete session.decision
    delete ctx.server.state.ticking[session.id]
    setStatus(ctx.server.state, session, 'idle', ctx.server.clock.now())
    ctx.server.changed()
    return { ptyId: session.ptyId }
  },
  'session.close': (ctx, p) => {
    checkProject(p.projectId)
    const { session, list } = findSession(ctx.server.state.project, p.sessionId)
    if (session.ptyId) ctx.server.terminals.close(session.ptyId)
    list.splice(list.indexOf(session), 1)
    delete ctx.server.state.since[session.id]
    delete ctx.server.state.ticking[session.id]
    delete ctx.server.state.scrollback[session.id]
    ctx.server.changed()
    return null
  },
  'session.sendPrompt': (ctx, p) => {
    checkProject(p.projectId)
    if (!p.text || !p.text.trim()) throw new DemoError('BAD_REQUEST', 'The prompt is empty')
    runPrompt(ctx, findSession(ctx.server.state.project, p.sessionId), p.text)
    return null
  },
  'session.enqueue': (ctx, p) => {
    checkProject(p.projectId)
    findSession(ctx.server.state.project, p.sessionId).session.queue.push(p.text)
    ctx.server.changed()
    return null
  },
  'session.dequeue': (ctx, p) => {
    checkProject(p.projectId)
    const queue = findSession(ctx.server.state.project, p.sessionId).session.queue
    if (!Number.isInteger(p.index) || p.index < 0) throw new DemoError('BAD_REQUEST', 'index must be a non-negative integer')
    // As the real server: past the end is CONFLICT when the caller said what it expected, BAD_REQUEST otherwise
    if (p.index >= queue.length) throw new DemoError(p.expected !== undefined ? 'CONFLICT' : 'BAD_REQUEST', p.expected !== undefined ? 'The queue changed' : 'No such queued prompt')
    if (p.expected !== undefined && queue[p.index] !== p.expected) throw new DemoError('CONFLICT', 'The queue changed')
    queue.splice(p.index, 1)
    ctx.server.changed()
    return null
  },
  'session.dismissDecision': (ctx, p) => {
    checkProject(p.projectId)
    const { session } = findSession(ctx.server.state.project, p.sessionId)
    if (!session.decision) return null
    delete session.decision
    ctx.server.changed()
    return null
  },
  'review.send': (ctx, p) => {
    checkProject(p.projectId)
    const { worktree } = findWorktree(ctx.server.state.project, p.worktreeId)
    const draft = worktree.review
    if ((draft?.revision ?? 0) !== p.revision) throw new DemoError('CONFLICT', 'The review changed since you opened it')
    if (!draft || draft.comments.length === 0) throw new DemoError('BAD_REQUEST', 'The review has no comments')
    const target = worktree.sessions.find((s) => s.id === p.sessionId)
    if (!target) throw new DemoError('NOT_FOUND', 'No such session in this worktree')
    target.queue.push(reviewPrompt(worktree.name, draft.comments))
    // The draft goes, the worktree keeps the last revision handed out (as review.clear does)
    worktree.reviewRevision = Math.max(worktree.reviewRevision ?? 0, draft.revision)
    delete worktree.review
    ctx.server.changed()
    return null
  },
  'pty.attach': (ctx, p) => ctx.server.terminals.attach(p.ptyId, ctx.connection),
  'pty.detach': (ctx, p) => {
    ctx.server.terminals.detach(p.ptyId, ctx.connection)
    return null
  },
  'pty.write': (ctx, p) => {
    ctx.server.terminals.write(p.ptyId, p.data)
    // Typing answers an open decision, as the real server's onUserInput does
    const owner = allSessions(ctx.server.state.project).find((f) => f.session.ptyId === p.ptyId)
    if (owner?.session.decision) {
      delete owner.session.decision
      ctx.server.changed()
    }
    return null
  },
  'pty.resize': (ctx, p) => {
    ctx.server.terminals.resize(p.ptyId, p.cols, p.rows)
    return null
  }
}
