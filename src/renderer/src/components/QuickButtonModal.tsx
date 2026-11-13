import { useState } from 'react'
import type { TerminalQuickButton } from '../../../shared/types'
import { TemplateEditor } from './TemplateEditor'

interface Props {
  /** The button being edited; undefined creates a new one */
  button?: TerminalQuickButton
  onSave: (button: TerminalQuickButton) => void
  onDelete?: () => void
  onClose: () => void
}

export function QuickButtonModal({ button, onSave, onDelete, onClose }: Props): React.JSX.Element {
  const [label, setLabel] = useState(button?.label ?? '')
  const [text, setText] = useState(button?.text ?? '')
  const save = (): void => {
    if (!text.trim()) return
    onSave({ id: button?.id ?? crypto.randomUUID(), label: label.trim(), text })
    onClose()
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="modal quick-btn-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{button ? 'Edit quick button' : 'New quick button'}</h2>
        <label className="quick-btn-modal-field">
          <span>Label</span>
          <input
            autoFocus
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        <div className="quick-btn-modal-field">
          <span>Text sent to the terminal</span>
          <TemplateEditor value={text} onChange={setText} placeholder="e.g. Review {AREA} on [branch]" />
        </div>
        <div className="modal-footer quick-btn-modal-footer">
          {onDelete && (
            <button
              className="danger"
              onClick={() => {
                onDelete()
                onClose()
              }}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!text.trim()} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
