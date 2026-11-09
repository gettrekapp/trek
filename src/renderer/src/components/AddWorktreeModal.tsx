import { useEffect, useState } from 'react'
import { repoById, useAppStore } from '../store'
import { getBackend } from '../backend'
import { errorText } from '../v2/errors'

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

  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newBranch, setNewBranch] = useState('')
  const [baseExisting, setBaseExisting] = useState(false)
  const [creating, setCreating] = useState(false)

  const [prUrl, setPrUrl] = useState('')
  const [addingPr, setAddingPr] = useState(false)
  const pr = parsePullRequestUrl(prUrl)

  const repo = repoById(project, repoId)!

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getBackend()
      .git.listBranches(repoId)
      .then((branchList) => {
        if (cancelled) return
        setBranches(branchList)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(errorText(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoId])

  /**
   * Opens the worktree with a first session. The server window's mirror
   * already lists the worktree (`create` waited for it), so it is selected
   * and started by path.
   */
  const addInstance = async (info: { path: string }) => {
    useAppStore.getState().selectWorktree({ path: info.path })
    await getBackend().sessions.start({ path: info.path })
    onClose()
  }

  const createNew = async (): Promise<void> => {
    const branch = newBranch.trim()
    if (!branch) return
    setCreating(true)
    setError(null)
    try {
      const { path } = await getBackend().worktrees.create({
        repoId,
        branch,
        createBranch: !baseExisting
      })
      await addInstance({ path })
    } catch (err) {
      setError(errorText(err))
      setCreating(false)
    }
  }

  const createFromPr = async (): Promise<void> => {
    if (!pr) return
    setAddingPr(true)
    setError(null)
    try {
      const branch =
        (await window.api.githubPrHeadBranch(pr.owner, pr.repo, pr.number)) ?? `pr/${pr.number}`
      const linkPr = (): void => {
        useAppStore.getState().setBranchPullRequest(repoId, branch, pr.url)
      }
      // The PR's branch may already be checked out: the project lists that worktree already.
      const rows = await getBackend().git.listWorktrees(repoId)
      if (rows.some((w) => w.branch === branch)) {
        linkPr()
        onClose()
        return
      }
      const { path } = await getBackend().worktrees.create({
        repoId,
        branch,
        createBranch: false,
        fromPr: pr.number
      })
      linkPr()
      await addInstance({ path })
    } catch (err) {
      setError(errorText(err))
      setAddingPr(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add Worktree — {repo.name}</h2>
        {error && <div className="error">{error}</div>}
        {loading ? (
          <p className="muted">Loading branches…</p>
        ) : (
          <>
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
                {baseName(repo.path)}-&lt;branch&gt;
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
