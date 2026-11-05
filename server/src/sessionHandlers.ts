// v2 session commands, worktree load/unload and the terminal stream. Thin
// wrappers: the logic lives in SessionManager and TerminalHost.
import { codedError } from './errors.ts'
import { requireString } from './validate.ts'
import type { V2Context } from './v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

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
  'session.markComplete': (p, ctx) => ctx.sessions.markComplete(p),
  'session.seen': (p, ctx) => ctx.sessions.seen(p),

  'worktree.load': (p, ctx) => ctx.sessions.loadWorktree(p),
  'worktree.unload': (p, ctx) => ctx.sessions.unloadWorktree(p),

  'pty.attach': (p, ctx) => ctx.sessions.terminals.attach(ptyOf(ctx, p), ctx.terminal),
  'pty.detach': (p, ctx) => {
    ctx.sessions.terminals.detach(requireString(p.ptyId, 'ptyId'), ctx.terminal)
    return null
  },
  'pty.write': (p, ctx) => {
    const ptyId = ptyOf(ctx, p)
    ctx.sessions.terminals.write(ptyId, requireString(p.data, 'data'))
    return null
  },
  'pty.resize': (p, ctx) => {
    ctx.sessions.terminals.resize(ptyOf(ctx, p), p.cols, p.rows)
    return null
  }
}
