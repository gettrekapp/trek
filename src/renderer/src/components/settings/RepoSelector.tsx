import type { Repository } from '../../../../shared/types'

interface Props {
  repositories: Repository[]
  repo: Repository | undefined
  onSelect: (id: string) => void
}

/** Which repository the per-repository settings edit; nothing with a single repository. */
export function RepoSelector({ repositories, repo, onSelect }: Props): React.JSX.Element | null {
  if (repositories.length <= 1) return null
  return (
    <div className="settings-row">
      <span className="settings-label">
        <span className="settings-name">Repository</span>
        <span className="settings-desc">These settings apply per repository.</span>
      </span>
      <select className="settings-select" value={repo?.id} onChange={(e) => onSelect(e.target.value)}>
        {repositories.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </div>
  )
}
