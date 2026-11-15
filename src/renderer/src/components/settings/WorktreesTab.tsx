import { useAppStore } from '../../store'
import { SettingText } from '../SettingText'
import { WorktreeTagsEditor } from './WorktreeTagsEditor'
import type { Repository } from '../../../../shared/types'

const parseDirs = (text: string): string[] =>
  text
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)

interface Props {
  /** The repository the per-repository rows edit */
  repo: Repository | undefined
  repoSelector: React.ReactNode
}

/** Settings → Worktrees: the tags, and what each new worktree is linked to. */
export function WorktreesTab({ repo, repoSelector }: Props): React.JSX.Element {
  // Defaults applied outside the selectors — `?? []` inside one would return a
  // fresh array every snapshot and loop React's store re-render (error #185).
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  const linkedDirs = repo?.linkedDirs ?? []
  const setLinkedDirs = useAppStore((s) => s.setLinkedDirs)
  const worktreeTags = useAppStore((s) => s.project?.worktreeTags) ?? []
  const setWorktreeTags = useAppStore((s) => s.setWorktreeTags)
  const customTags = useAppStore((s) => s.project?.customTags) ?? []
  const setCustomTags = useAppStore((s) => s.setCustomTags)

  return (
    <>
      <h3>Worktree tags</h3>
      <WorktreeTagsEditor
        description="Workflow tags assignable to a worktree's branch, in menu order. New worktrees start with the first tag. Deleting a tag removes it from every branch using it."
        tags={worktreeTags}
        onChange={setWorktreeTags}
        usesOf={(id) =>
          repositories.flatMap((r) => Object.values(r.branchTags ?? {})).filter((t) => t === id).length
        }
      />
      <h3>Custom tags</h3>
      <WorktreeTagsEditor
        description="Extra tags that can be toggled on and off individually per worktree's branch, alongside its workflow tag. Deleting a tag removes it from every branch using it."
        tags={customTags}
        onChange={setCustomTags}
        usesOf={(id) =>
          repositories
            .flatMap((r) => Object.values(r.branchCustomTags ?? {}))
            .filter((ids) => ids.includes(id)).length
        }
      />
      <h3>Linked directories</h3>
      {repoSelector}
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Linked directories</span>
          <span className="settings-desc">
            Comma-separated repo-relative paths (e.g. .trek) symlinked from the main
            repository into every new worktree — for local-only folders like database backups
            and secrets that aren&apos;t committed. Applies to worktrees created from now on.
          </span>
        </span>
        <SettingText
          key={repo?.id}
          className="settings-select"
          placeholder=".trek"
          value={linkedDirs.join(', ')}
          onCommit={(text) => {
            if (repo) setLinkedDirs(repo.id, parseDirs(text))
          }}
        />
      </div>
    </>
  )
}
