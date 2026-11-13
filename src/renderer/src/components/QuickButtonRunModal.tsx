import { useState } from 'react'
import type { TerminalQuickButton } from '../../../shared/types'
import {
  fillTemplate,
  parseTemplate,
  type BuiltinValues,
  type QuickButtonPlan
} from '../../../shared/quickButtonTemplate.ts'

interface Props {
  button: TerminalQuickButton
  plan: QuickButtonPlan
  builtins: BuiltinValues
  onSend: (text: string) => void
  onClose: () => void
}

export function QuickButtonRunModal({ button, plan, builtins, onSend, onClose }: Props): React.JSX.Element {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [filled, setFilled] = useState<Record<string, string>>({})
  const text = fillTemplate(parseTemplate(button.text), inputs, { ...builtins, ...filled })
  const fields = [
    ...plan.inputs.map((name) => ({ key: `{${name}}`, name, missing: false })),
    ...plan.missing.map((name) => ({ key: `[${name}]`, name, missing: true }))
  ]
  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <form
        className="modal quick-btn-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onSend(text)
          onClose()
        }}
      >
        <h2>{button.label.trim() || 'Quick button'}</h2>
        {fields.map((f, i) => (
          <label key={f.key} className="quick-btn-modal-field">
            <span>
              <span className={f.missing ? 'tpl-builtin' : 'tpl-input'}>{f.key}</span>
              {f.missing && <span className="quick-btn-missing"> no value here</span>}
            </span>
            <input
              autoFocus={i === 0}
              aria-label={f.name}
              value={(f.missing ? filled : inputs)[f.name] ?? ''}
              onChange={(e) =>
                (f.missing ? setFilled : setInputs)((prev) => ({ ...prev, [f.name]: e.target.value }))
              }
            />
          </label>
        ))}
        <div className="quick-btn-modal-field">
          <span>Preview</span>
          <pre className="quick-btn-preview">{text}</pre>
        </div>
        <div className="modal-footer quick-btn-modal-footer">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Send ⏎
          </button>
        </div>
      </form>
    </div>
  )
}
