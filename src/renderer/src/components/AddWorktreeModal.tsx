import { useEffect, useMemo, useState } from 'react'
import { hostRepoPath, repoById, useAppStore } from '../store'
import { scheduleAutoSave } from '../persistence'
import { getBackend } from '../backend'
import { errorText } from '../v2/errors'
import { worktreeKey } from '../../../shared/types'
import type { GitWorktreeInfo, WorktreeInstance } from '../../../shared/types'

interface Props {
  repoId: string
  onClose: () => void
}

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

interface ParsedPullRequest {
  owner: string
  repo: string
  number: number
  /** Canonical form of the pasted link — this is what gets saved. */
  url: string
}

function parsePullRequestUrl(input: string): ParsedPullRequest | null {
  const match = input
    .trim()
    .match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i)
  if (!match) return null
  const [, owner, repo, num] = match
  return { owner, repo, number: Number(num), url: `https://github.com/${owner}/${repo}/pull/${num}` }
}

export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const addWorktreeInstance = useAppStore((s) => s.addWorktreeInstance)
  const serverStatus = useAppStore((s) => s.serverStatus)
  // A server project lists every worktree already: there are no "existing" ones to add.
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  // A server's ClientError reads "code: message" through String(); a project file keeps its text as it was.
  const shown = (err: unknown): string => (serverWindow ? errorText(err) : String(err))

  // undefined = the local machine
  const [serverId, setServerId] = useState<string | undefined>(undefined)
  const [existing, setExisting] = useState<GitWorktreeInfo[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newBranch, setNewBranch] = useState('')
  const [baseExisting, setBaseExisting] = useState(false)
  const [creating, setCreating] = useState(false)

  const [prUrl, setPrUrl] = useState('')
  const [addingPr, setAddingPr] = useState(false)
  const pr = parsePullRequestUrl(prUrl)

  const servers = project.servers ?? []
  const repo = repoById(project, repoId)!
  const repoPath = hostRepoPath(repo, serverId)

  const addedKeys = useMemo(
    () => new Set([worktreeKey({ path: repo.path }), ...repo.worktrees.map((w) => worktreeKey(w))]),
    [repo.path, repo.worktrees]
  )

  useEffect(() => {
    if (!repoPath) {
      setError('This server has no repository path configured.')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      getBackend().git.listWorktrees(repoId, serverId),
      getBackend().git.listBranches(repoId, serverId)
    ])
      .then(([worktrees, branchList]) => {
        if (cancelled) return
        setExisting(worktrees.map((w) => ({ ...w, serverId })))
        setBranches(branchList)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(shown(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoId, serverId, repoPath])

  /**
   * Opens the worktree with a first session. A project file gets a new
   * instance first; a server window's mirror already lists the worktree
   * (`create` waited for it), so it is selected and started by path.
   */
  const addInstance = async (info: { path: string; branch?: string; name?: string }) => {
    if (serverWindow) {
      useAppStore.getState().selectWorktree({ path: info.path })
      await getBackend().sessions.start({ path: info.path })
      onClose()
      return
    }
    const worktree: WorktreeInstance = {
      id: crypto.randomUUID(),
      name: info.name ?? info.branch ?? baseName(info.path),
      path: info.path,
      serverId,
      branch: info.branch
    }
    addWorktreeInstance(repoId, worktree)
    await getBackend().sessions.start({ worktreeId: worktree.id })
    onClose()
  }

  const createNew = async (): Promise<void> => {
    const branch = newBranch.trim()
    if (!branch || !repoPath) return
    setCreating(true)
    setError(null)
    try {
      const { path } = await getBackend().worktrees.create({
        repoId,
        serverId,
        branch,
        createBranch: !baseExisting
      })
      await addInstance({ path, branch })
    } catch (err) {
      setError(shown(err))
      setCreating(false)
    }
  }

  const createFromPr = async (): Promise<void> => {
    if (!pr || !repoPath) return
    setAddingPr(true)
    setError(null)
    try {
      const branch =
        (await window.api.githubPrHeadBranch(pr.owner, pr.repo, pr.number)) ?? `pr/${pr.number}`
      const linkPr = (): void => {
        useAppStore.getState().setBranchPullRequest(repoId, branch, pr.url)
        scheduleAutoSave()
      }
      // The PR's branch may already be checked out — reuse that worktree.
      const checkedOut = existing.find((w) => w.branch === branch)
      if (checkedOut) {
        linkPr()
        if (addedKeys.has(worktreeKey(checkedOut))) onClose()
        else await addInstance({ path: checkedOut.path, branch })
        return
      }
      const { path } = await getBackend().worktrees.create({
        repoId,
        serverId,
        branch,
        createBranch: false,
        fromPr: pr.number
      })
      linkPr()
      await addInstance({ path, branch })
    } catch (err) {
      setError(shown(err))
      setAddingPr(false)
    }
  }

  const available = existing.filter((w) => !addedKeys.has(worktreeKey(w)))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add Worktree — {repo.name}</h2>
        {servers.length > 0 && (
          <div className="location-row">
            <span className="location-label">Location</span>
            <select
              className="settings-select"
              value={serverId ?? ''}
              onChange={(e) => setServerId(e.target.value || undefined)}
            >
              <option value="">Local machine</option>
              {servers.map((s) => {
                const down = serverStatus[s.id] !== 'connected'
                return (
                  <option key={s.id} value={s.id} disabled={down}>
                    {s.name}
                    {down ? ' (disconnected)' : ''}
                  </option>
                )
              })}
            </select>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {loading ? (
          <p className="muted">Loading worktrees…</p>
        ) : (
          <>
            {!serverWindow && <h3>Existing worktrees</h3>}
            {!serverWindow && available.length === 0 && <p className="muted">All existing worktrees are already open.</p>}
            <ul className="worktree-list">
              {available.map((w) => (
                <li key={worktreeKey(w)}>
                  <div className="worktree-info">
                    <span className="worktree-branch">
                      {w.branch ?? w.head?.slice(0, 8) ?? '(detached)'}
                      {w.isMain && <span className="main-tag">main checkout</span>}
                    </span>
                    <span className="worktree-path">{w.path}</span>
                  </div>
                  <button onClick={() => void addInstance({ path: w.path, branch: w.branch })}>
                    Add
                  </button>
                </li>
              ))}
            </ul>

            <h3>Create new worktree</h3>
            <div className="create-row">
              <input
                type="text"
                placeholder="branch name"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                list="branch-suggestions"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createNew()
                }}
              />
              <datalist id="branch-suggestions">
                {branches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={baseExisting}
                  onChange={(e) => setBaseExisting(e.target.checked)}
                />
                use existing branch
              </label>
              <button disabled={creating || !newBranch.trim()} onClick={() => void createNew()}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
            <p className="muted">
              New worktrees are created next to the repository as{' '}
              <code>
                {repoPath ? baseName(repoPath) : 'repo'}-&lt;branch&gt;
              </code>
              . New branches are cut from the latest master/main (fetched from origin first).
            </p>

            <h3>From a GitHub pull request</h3>
            <div className="create-row">
              <input
                type="text"
                placeholder="https://github.com/org/repo/pull/123"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFromPr()
                }}
              />
              <button disabled={addingPr || !pr} onClick={() => void createFromPr()}>
                {addingPr ? 'Adding…' : 'Add PR'}
              </button>
            </div>
            <p className="muted">
              Checks out the pull request&apos;s branch into a new worktree and links the PR to it.
            </p>
          </>
        )}
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
