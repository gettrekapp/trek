import type { GitWorktreeInfo, PtySpawnOptions, WorktreeChanges, WorktreeStatus } from '../../shared/types'

/**
 * One machine that can hold worktrees and run Claude sessions. LocalHost runs
 * everything in-process; RemoteHost forwards to a companion daemon over
 * WebSocket. PTY output flows back through the shared `pty:data`/`pty:exit`
 * renderer events either way — the renderer never knows where a pty lives.
 */
export interface HostService {
  /** null = the local machine */
  readonly serverId: string | null

  git: {
    listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>
    /** Dirty/ahead/behind per worktree — polled apart from the worktree list. */
    worktreeStatuses(worktreePaths: string[]): Promise<WorktreeStatus[]>
    /** What the worktree would add to the default branch, for the Changes tab. */
    worktreeChanges(worktreePath: string): Promise<WorktreeChanges>
    /** Patch text per changed file. Fetched only while the Changes panel is open. */
    worktreeDiff(worktreePath: string): Promise<Record<string, string>>
    listBranches(repoPath: string): Promise<string[]>
    addWorktree(
      repoPath: string,
      worktreePath: string,
      branch: string,
      createBranch: boolean
    ): Promise<void>
    removeWorktree(repoPath: string, worktreePath: string): Promise<void>
    checkout(repoPath: string, branch: string): Promise<void>
    defaultBranch(repoPath: string): Promise<string | null>
    exportDirtyPatch(worktreePath: string): Promise<{ patch: string; headSha: string }>
    applyPatch(worktreePath: string, patch: string): Promise<void>
    revParseHead(worktreePath: string): Promise<string>
    push(worktreePath: string, branch: string, setUpstream: boolean): Promise<void>
    /** Fast-forward the worktree's branch from origin (git pull --ff-only). */
    pull(worktreePath: string, branch: string): Promise<void>
    fetchBranch(repoPath: string, branch: string): Promise<void>
    /** Fetch refs/pull/<n>/head into a local branch (works for fork PRs too). */
    fetchPullRequestHead(repoPath: string, prNumber: number, branch: string): Promise<void>
    addWorktreeAt(repoPath: string, worktreePath: string, branch: string): Promise<void>
    removeWorktreeForce(repoPath: string, worktreePath: string): Promise<void>
    /** Symlink repo-relative paths (settings.linkedDirs) into a fresh worktree. */
    linkDirs(repoPath: string, worktreePath: string, dirs: string[]): Promise<void>
  }

  pty: {
    spawn(opts: PtySpawnOptions): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    dispose(id: string): void
    /**
     * Give up this client's hold on the pty (worktree unload). A local shell
     * has nowhere to survive, so this kills it; a remote one keeps running on
     * its daemon and is reattached when the worktree is loaded again.
     */
    detach(id: string): void
  }

  claude: {
    migrateSession(sessionId: string, fromCwd: string, toCwd: string): Promise<boolean>
    exportSession(cwd: string, sessionId: string): Promise<string | null>
    importSession(cwd: string, sessionId: string, content: string): Promise<void>
    deleteSession(cwd: string, sessionId: string): Promise<void>
  }
}
