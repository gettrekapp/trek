// v2 session commands, worktree load/unload and the terminal stream. Thin
// wrappers: the logic lives in SessionManager and TerminalHost.
import { codedError } from './errors.ts'
import { requireString } from './validate.ts'
import type { V2Context } from './v2.ts'
import { MAX_PTY_WRITE } from './sessions/limits.ts'

type Handler = (params: any, ctx: V2Context) => unknown

/** pty.write and pty.resize: only a connection attached to the pty may drive it. */
function attachedPty(ctx: V2Context, p: any): string {
  const ptyId = ptyOf(ctx, p)
  if (!ctx.sessions.terminals.isAttached(ptyId, ctx.terminal)) throw codedError('BAD_REQUEST', 'attach to the pty first')
  return ptyId
}

function ptyOf(ctx: V2Context, p: any): string {
  const ptyId = requireString(p.ptyId, 'ptyId')
  if (!ctx.sessions.terminals.has(ptyId)) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
  return ptyId
}

export const sessionHandlers: Record<string, Handler> = {
  'session.start': (p, ctx) => ctx.sessions.start(p),
  'session.restart': (p, ctx) => ctx.sessions.restart(p),
  'session.close': (p, ctx) => ctx.sessions.close(p),
  'session.rename': (p, ctx) => ctx.sessions.rename(p),
  'session.sendPrompt': (p, ctx) => ctx.sessions.sendPrompt(p),
  'session.enqueue': (p, ctx) => ctx.sessions.enqueue(p),
  'session.setQueue': (p, ctx) => ctx.sessions.setQueue(p),
  'session.dequeue': (p, ctx) => ctx.sessions.dequeue(p),
  'session.markComplete': (p, ctx) => ctx.sessions.markComplete(p),
  'session.seen': (p, ctx) => ctx.sessions.seen(p),
  'session.dismissDecision': (p, ctx) => ctx.sessions.dismissDecision(p),

  'worktree.load': (p, ctx) => ctx.sessions.loadWorktree(p),
  'worktree.unload': (p, ctx) => ctx.sessions.unloadWorktree(p),

  'pty.attach': (p, ctx) => ctx.sessions.terminals.attach(ptyOf(ctx, p), ctx.terminal),
  'pty.detach': (p, ctx) => {
    ctx.sessions.terminals.detach(requireString(p.ptyId, 'ptyId'), ctx.terminal)
    return null
  },
  'pty.write': (p, ctx) => {
    const ptyId = attachedPty(ctx, p)
    const data = requireString(p.data, 'data')
    if (data.length > MAX_PTY_WRITE) throw codedError('BAD_REQUEST', `data must be at most ${MAX_PTY_WRITE} characters`)
    ctx.sessions.noteInput(ptyId, data)
    ctx.sessions.terminals.write(ptyId, data)
    return null
  },
  'pty.resize': (p, ctx) => {
    ctx.sessions.terminals.resize(attachedPty(ctx, p), p.cols, p.rows)
    return null
  }
}
