// The demo's worktrees (apps/mobile/src/demo): create, load, unload and remove; their changes,
// diffs and commits from demoData; the branch list, the agents and ui.report.
import type { ChangesSource, Worktree } from '../../shared.ts'
import type { DemoChanges } from '../demoData.ts'
import { DemoError } from '../demoError.ts'
import type { DemoHandlers } from '../demoHandlers.ts'
import { checkProject, findRepo, findWorktree } from '../demoProject.ts'
import type { DemoContext } from '../demoServer.ts'
import { record } from './branch.ts'
import { loadWorktree, unloadWorktree } from './sessions.ts'

function sourceFiles(changes: DemoChanges | undefined, source: ChangesSource = { kind: 'branch' }): DemoChanges['files'] {
  if (!changes) return []
  if (source.kind === 'uncommitted') return changes.files.filter((f) => changes.uncommitted.includes(f.file.path))
  if (source.kind === 'commit') {
    const commit = changes.commits.find((c) => c.info.sha === source.sha)
    if (!commit) throw new DemoError('GIT_ERROR', `unknown commit ${source.sha}`)
    return changes.files.filter((f) => commit.paths.includes(f.file.path))
  }
  return changes.files
}

function worktreeRef(ctx: DemoContext, p: { projectId: string; worktreeId: string }) {
  checkProject(p.projectId)
  return findWorktree(ctx.server.state.project, p.worktreeId)
}

type WorktreeMethods =
  | 'worktree.create'
  | 'worktree.remove'
  | 'worktree.load'
  | 'worktree.unload'
  | 'worktree.changes'
  | 'worktree.diff'
  | 'worktree.commits'
  | 'repo.listBranches'
  | 'server.agents'
  | 'ui.report'

export const WORKTREE_HANDLERS: DemoHandlers<WorktreeMethods> = {
  'worktree.create': (ctx, p) => {
    checkProject(p.projectId)
    const repo = findRepo(ctx.server.state.project, p.repoId)
    const branch = typeof p.branch === 'string' ? p.branch.trim() : ''
    if (!branch) throw new DemoError('BAD_REQUEST', 'Enter a branch name')
    if (repo.worktrees.some((w) => w.branch === branch)) throw new DemoError('GIT_ERROR', `'${branch}' is already checked out in a worktree`)
    const branches = ctx.server.state.branches
    const exists = branches.includes(branch)
    if (p.createBranch && exists) throw new DemoError('GIT_ERROR', `a branch named '${branch}' already exists`)
    if (!p.createBranch && !exists && p.fromPr === undefined) throw new DemoError('GIT_ERROR', `invalid reference: ${branch}`)
    if (!exists) branches.push(branch)
    const worktree: Worktree = {
      id: ctx.server.newId('wt'),
      name: branch,
      path: p.path ?? `${repo.path}-${branch.replace(/\//g, '-')}`,
      branch,
      isMain: false,
      dirty: false,
      ahead: 0,
      behind: 0,
      loaded: true,
      sessions: []
    }
    repo.worktrees.push(worktree)
    record(ctx, repo.id, branch, 'created', undefined, { text: worktree.path })
    ctx.server.changed()
    return { worktreeId: worktree.id }
  },
  'worktree.remove': (ctx, p) => {
    const { repo, worktree } = worktreeRef(ctx, p)
    if (worktree.isMain) throw new DemoError('BAD_REQUEST', "The main checkout can't be removed")
    if (worktree.loaded) throw new DemoError('IN_USE', 'Unload its sessions first')
    if (worktree.dirty && !p.force) throw new DemoError('GIT_ERROR', 'The worktree has modified or untracked files', 'dirty')
    repo.worktrees.splice(repo.worktrees.indexOf(worktree), 1)
    for (const s of worktree.sessions) {
      delete ctx.server.state.since[s.id]
      delete ctx.server.state.scrollback[s.id]
    }
    delete ctx.server.state.changes[worktree.id]
    if (worktree.branch) record(ctx, repo.id, worktree.branch, 'removed', { text: worktree.path })
    ctx.server.changed()
    return null
  },
  'worktree.load': (ctx, p) => {
    loadWorktree(ctx, worktreeRef(ctx, p).worktree)
    ctx.server.changed()
    return null
  },
  'worktree.unload': (ctx, p) => {
    unloadWorktree(ctx, worktreeRef(ctx, p).worktree)
    ctx.server.changed()
    return null
  },
  'worktree.changes': (ctx, p) => {
    const { worktree } = worktreeRef(ctx, p)
    const files = sourceFiles(ctx.server.state.changes[worktree.id], p.source)
    return { base: (p.source?.kind ?? 'branch') === 'branch' ? 'main' : null, files: files.map((f) => f.file) }
  },
  'worktree.diff': (ctx, p) => {
    const { worktree } = worktreeRef(ctx, p)
    const out: Record<string, string> = {}
    for (const f of sourceFiles(ctx.server.state.changes[worktree.id], p.source)) {
      if (!p.paths || p.paths.includes(f.file.path)) out[f.file.path] = f.patch
    }
    return out
  },
  'worktree.commits': (ctx, p) => {
    const { worktree } = worktreeRef(ctx, p)
    return (ctx.server.state.changes[worktree.id]?.commits ?? []).map((c) => c.info)
  },
  'repo.listBranches': (ctx, p) => {
    checkProject(p.projectId)
    findRepo(ctx.server.state.project, p.repoId)
    return [...ctx.server.state.branches]
  },
  'server.agents': () => ({
    llmDefault: { provider: 'claude' },
    agents: [
      { provider: 'claude', label: 'Claude', installed: true },
      { provider: 'codex', label: 'Codex', installed: true },
      { provider: 'gemini', label: 'Gemini', installed: true },
      { provider: 'grok', label: 'Grok', installed: false },
      { provider: 'local', label: 'Local model', installed: false }
    ]
  }),
  'ui.report': () => null
}
