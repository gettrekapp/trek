import { useState } from 'react'
import { QuickButtonModal } from '../QuickButtonModal'
import { SettingText } from '../SettingText'
import type { TerminalQuickButton } from '../../../../shared/types'

interface QuickButtonsEditorProps {
  description: string
  buttons: TerminalQuickButton[]
  onChange: (buttons: TerminalQuickButton[]) => void
}

export function QuickButtonsEditor({
  description,
  buttons,
  onChange
}: QuickButtonsEditorProps): React.JSX.Element {
  const patchButton = (id: string, patch: Partial<TerminalQuickButton>): void => {
    onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }

  const moveButton = (index: number, delta: number): void => {
    const next = [...buttons]
    const [btn] = next.splice(index, 1)
    next.splice(index + delta, 0, btn)
    onChange(next)
  }

  const [editing, setEditing] = useState<TerminalQuickButton | null>(null)

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">{description}</span>
        </span>
      </div>
      {buttons.map((btn, i) => (
        <div key={btn.id} className="quick-btn-row">
          <SettingText
            className="quick-btn-label-input"
            placeholder="Label"
            value={btn.label}
            onCommit={(label) => patchButton(btn.id, { label })}
          />
          <SettingText
            rows={1}
            className="quick-btn-text-input"
            placeholder="Text sent to the terminal — {INPUT} asks, [branch] etc. filled in"
            value={btn.text}
            onCommit={(text) => patchButton(btn.id, { text })}
          />
          <button className="quick-btn-remove" title="Edit with built-ins" onClick={() => setEditing(btn)}>
            ✎
          </button>
          <button
            className="quick-btn-remove"
            title="Move up"
            disabled={i === 0}
            onClick={() => moveButton(i, -1)}
          >
            ↑
          </button>
          <button
            className="quick-btn-remove"
            title="Move down"
            disabled={i === buttons.length - 1}
            onClick={() => moveButton(i, 1)}
          >
            ↓
          </button>
          <button
            className="quick-btn-remove"
            title="Remove button"
            onClick={() => onChange(buttons.filter((b) => b.id !== btn.id))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          className="btn btn-ghost"
          onClick={() => onChange([...buttons, { id: crypto.randomUUID(), label: '', text: '' }])}
        >
          + Add button
        </button>
      </div>
      {editing && (
        <QuickButtonModal
          button={editing}
          onSave={(saved) => patchButton(saved.id, { label: saved.label, text: saved.text })}
          onDelete={() => onChange(buttons.filter((b) => b.id !== editing.id))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
