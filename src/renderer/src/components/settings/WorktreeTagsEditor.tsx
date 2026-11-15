import { SettingText } from '../SettingText'
import type { WorktreeTag } from '../../../../shared/types'

const NEW_TAG_COLOR = '#5dabef'

export function WorktreeTagsEditor({
  description,
  tags,
  onChange,
  usesOf
}: {
  description: string
  tags: WorktreeTag[]
  onChange: (tags: WorktreeTag[]) => void
  /** How many branches carry the tag */
  usesOf: (id: string) => number
}): React.JSX.Element {
  const update = (next: WorktreeTag[]): void => {
    onChange(next)
  }

  const patchTag = (id: string, patch: Partial<WorktreeTag>): void => {
    update(tags.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const moveTag = (index: number, delta: number): void => {
    const next = [...tags]
    const [tag] = next.splice(index, 1)
    next.splice(index + delta, 0, tag)
    update(next)
  }

  const removeTag = async (tag: WorktreeTag): Promise<void> => {
    const uses = usesOf(tag.id)
    if (uses > 0) {
      const ok = await window.api.confirm({
        title: 'Delete tag',
        message: `Delete the tag "${tag.name}"?`,
        detail: `It is set on ${uses} branch${uses === 1 ? '' : 'es'}, which will lose it.`,
        confirmLabel: 'Delete'
      })
      if (!ok) return
    }
    update(tags.filter((t) => t.id !== tag.id))
  }

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">{description}</span>
        </span>
      </div>
      {tags.map((tag, i) => (
        <div key={tag.id} className="quick-btn-row tag-edit-row">
          <input
            className="tag-color-input"
            type="color"
            title="Tag color"
            value={tag.color}
            onChange={(e) => patchTag(tag.id, { color: e.target.value })}
          />
          <SettingText
            className="quick-btn-text-input"
            placeholder="Tag name"
            value={tag.name}
            onCommit={(name) => patchTag(tag.id, { name })}
          />
          <button
            className="quick-btn-remove"
            title="Move up"
            disabled={i === 0}
            onClick={() => moveTag(i, -1)}
          >
            ↑
          </button>
          <button
            className="quick-btn-remove"
            title="Move down"
            disabled={i === tags.length - 1}
            onClick={() => moveTag(i, 1)}
          >
            ↓
          </button>
          <button className="quick-btn-remove" title="Delete tag" onClick={() => void removeTag(tag)}>
            ×
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          className="btn btn-ghost"
          onClick={() =>
            update([...tags, { id: crypto.randomUUID(), name: '', color: NEW_TAG_COLOR }])
          }
        >
          + Add tag
        </button>
      </div>
    </>
  )
}
