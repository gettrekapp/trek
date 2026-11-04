import { execFile } from 'node:child_process'
import type { WebSocket } from 'ws'
import * as gitService from '../../src/host/gitService'
import * as claudeSessions from '../../src/host/claudeSessionService'
import * as agentService from '../../src/host/agentService'
import type { WireError, WireErrorCode } from '../../src/shared/protocol'
import type { DaemonConfig } from './config'
import { PathGuard } from './paths'
import { PtyRegistry } from './ptyRegistry'

export interface RpcContext {
  config: DaemonConfig
  guard: PathGuard
  ptys: PtyRegistry
  ws: WebSocket
}

type Handler = (params: any, ctx: RpcContext) => Promise<unknown> | unknown

const handlers: Record<string, Handler> = {
  'repo.list': (_p, ctx) => ctx.config.repos,

  'git.listWorktrees': (p, ctx) => gitService.listWorktrees(ctx.guard.check(p.repoPath)),
  'git.worktreeStatuses': (p, ctx) =>
    gitService.worktreeStatuses(
      (Array.isArray(p.worktreePaths) ? p.worktreePaths : []).map((path: string) =>
        ctx.guard.check(path)
      )
    ),
  'git.worktreeChanges': (p, ctx) => gitService.worktreeChanges(ctx.guard.check(p.worktreePath)),
  'git.worktreeDiff': (p, ctx) => gitService.worktreeDiff(ctx.guard.check(p.worktreePath)),
  'git.listBranches': (p, ctx) => gitService.listBranches(ctx.guard.check(p.repoPath)),
  'git.addWorktree': async (p, ctx) => {
    await gitService.addWorktree(
      ctx.guard.check(p.repoPath),
      ctx.guard.check(p.worktreePath),
      p.branch,
      p.createBranch
    )
    return null
  },
  'git.removeWorktree': async (p, ctx) => {
    await gitService.removeWorktree(ctx.guard.check(p.repoPath), ctx.guard.check(p.worktreePath))
    return null
  },
  'git.checkout': async (p, ctx) => {
    await gitService.checkout(ctx.guard.check(p.repoPath), p.branch)
    return null
  },
  'git.defaultBranch': (p, ctx) => gitService.defaultBranch(ctx.guard.check(p.repoPath)),
  'git.exportDirtyPatch': (p, ctx) => gitService.exportDirtyPatch(ctx.guard.check(p.worktreePath)),
  'git.applyPatch': async (p, ctx) => {
    await gitService.applyPatch(ctx.guard.check(p.worktreePath), p.patch)
    return null
  },
  'git.revParseHead': (p, ctx) => gitService.revParseHead(ctx.guard.check(p.worktreePath)),
  'git.push': async (p, ctx) => {
    await gitService.push(ctx.guard.check(p.worktreePath), p.branch, p.setUpstream)
    return null
  },
  'git.pull': async (p, ctx) => {
    await gitService.pull(ctx.guard.check(p.worktreePath), p.branch)
    return null
  },
  'git.fetchBranch': async (p, ctx) => {
    await gitService.fetchBranch(ctx.guard.check(p.repoPath), p.branch)
    return null
  },
  'git.fetchPullRequestHead': async (p, ctx) => {
    await gitService.fetchPullRequestHead(ctx.guard.check(p.repoPath), p.prNumber, p.branch)
    return null
  },
  'git.addWorktreeAt': async (p, ctx) => {
    await gitService.addWorktreeAt(
      ctx.guard.check(p.repoPath),
      ctx.guard.check(p.worktreePath),
      p.branch
    )
    return null
  },
  'git.removeWorktreeForce': async (p, ctx) => {
    await gitService.removeWorktreeForce(
      ctx.guard.check(p.repoPath),
      ctx.guard.check(p.worktreePath)
    )
    return null
  },
  'git.linkDirs': async (p, ctx) => {
    await gitService.linkDirs(
      ctx.guard.check(p.repoPath),
      ctx.guard.check(p.worktreePath),
      Array.isArray(p.dirs) ? p.dirs : []
    )
    return null
  },

  'pty.spawn': (p, ctx) => {
    ctx.guard.check(p.cwd)
    ctx.ptys.spawn(p, ctx.ws)
    return { ptyId: p.ptyId }
  },
  'pty.attach': (p, ctx) => ctx.ptys.attach(p.ptyId, ctx.ws),
  'pty.detach': (p, ctx) => {
    ctx.ptys.detach(p.ptyId, ctx.ws)
    return null
  },
  'pty.write': (p, ctx) => {
    ctx.ptys.write(p.ptyId, p.data)
    return null
  },
  'pty.resize': (p, ctx) => {
    ctx.ptys.resize(p.ptyId, p.cols, p.rows)
    return null
  },
  'pty.kill': (p, ctx) => {
    ctx.ptys.kill(p.ptyId)
    return null
  },
  'pty.list': (_p, ctx) => ctx.ptys.list(),

  'claude.migrateSession': (p) => claudeSessions.migrateSession(p.sessionId, p.fromCwd, p.toCwd),
  'claude.exportSession': async (p) => ({
    content: await claudeSessions.exportSession(p.cwd, p.sessionId)
  }),
  'claude.importSession': async (p) => {
    await claudeSessions.importSession(p.cwd, p.sessionId, p.content)
    return null
  },
  'claude.deleteSession': async (p) => {
    await claudeSessions.deleteSession(p.cwd, p.sessionId)
    return null
  },
  'agents.discoverCodexSession': async (p) => ({
    sessionId: (await agentService.discoverCodexSession(p.cwd, p.since, p.exclude)) ?? null
  }),
  'agents.commandExists': async (p) => ({ exists: await agentService.commandExists(p.command) }),
  'claude.check': () =>
    new Promise((resolve) => {
      // Login shell so version-manager shims and ~/.local/bin are on PATH.
      execFile('/bin/sh', ['-lc', 'claude --version'], { timeout: 15_000 }, (err, stdout) => {
        if (err) resolve({ available: false })
        else resolve({ available: true, version: stdout.trim() })
      })
    }),

  'sys.ping': (p) => ({ t: p.t })
}

export async function dispatch(
  method: string,
  params: unknown,
  ctx: RpcContext
): Promise<{ ok: true; result: unknown } | { ok: false; error: WireError }> {
  const handler = handlers[method]
  if (!handler) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method: ${method}` } }
  }
  try {
    const result = await handler(params ?? {}, ctx)
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: toWireError(method, err) }
  }
}

function toWireError(method: string, err: unknown): WireError {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException)?.code
  let wireCode: WireErrorCode = 'INTERNAL'
  if (code === 'PATH_DENIED') wireCode = 'PATH_DENIED'
  else if (code === 'PTY_NOT_FOUND') wireCode = 'PTY_NOT_FOUND'
  else if (method.startsWith('git.')) wireCode = 'GIT_ERROR'
  return { code: wireCode, message }
}
