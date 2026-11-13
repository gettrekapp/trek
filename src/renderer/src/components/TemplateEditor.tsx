import { Fragment, useMemo, useRef, useState } from 'react'
import { BUILTINS, parseTemplate, type BuiltinDef } from '../../../shared/quickButtonTemplate.ts'

const GROUPS = [...new Set(BUILTINS.map((b) => b.group))]
const INPUT_NAME = /^[A-Za-z0-9_]+$/

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
}

/**
 * A textarea whose text is drawn by a highlight layer behind it: {inputs}
 * orange, [built-ins] blue. The textarea's own glyphs are transparent so the
 * layer shows through; both share font, padding and wrapping.
 */
export function TemplateEditor({ value, onChange, placeholder, autoFocus }: Props): React.JSX.Element {
  const ta = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  /** The `[` suggestion list: where its `[` is and what follows it */
  const [suggest, setSuggest] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [inputName, setInputName] = useState('')
  const segments = useMemo(() => parseTemplate(value), [value])
  const matches = suggest ? BUILTINS.filter((b) => b.name.includes(suggest.query.toLowerCase())) : []

  const replace = (start: number, end: number, token: string): void => {
    onChange(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const insert = (token: string): void => {
    const el = ta.current
    const start = el?.selectionStart ?? value.length
    replace(start, el?.selectionEnd ?? start, token)
  }
  const pick = (b: BuiltinDef): void => {
    if (!suggest) return
    replace(suggest.start, ta.current?.selectionStart ?? suggest.start, `[${b.name}]`)
    setSuggest(null)
  }
  const track = (text: string, caret: number): void => {
    const open = text.slice(0, caret).match(/\[([A-Za-z_]*)$/)
    setSuggest(open ? { start: caret - open[0].length, query: open[1] } : null)
    setActive(0)
  }
  const addInput = (): void => {
    if (!INPUT_NAME.test(inputName)) return
    insert(`{${inputName}}`)
    setNaming(false)
    setInputName('')
  }

  return (
    <div className="tpl">
      <div className="tpl-toolbar">
        <div className="tpl-dropdown">
          <button type="button" onClick={() => setListOpen((o) => !o)}>
            + Built-in ▾
          </button>
          {listOpen && (
            <div className="tpl-menu" role="listbox">
              {GROUPS.map((group) => (
                <Fragment key={group}>
                  <div className="tpl-menu-group">{group}</div>
                  {BUILTINS.filter((b) => b.group === group).map((b) => (
                    <button
                      type="button"
                      key={b.name}
                      className="tpl-menu-item"
                      onClick={() => {
                        insert(`[${b.name}]`)
                        setListOpen(false)
                      }}
                    >
                      <span className="tpl-builtin">[{b.name}]</span>
                      <span className="tpl-menu-desc">{b.description}</span>
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>
        {naming ? (
          <span className="tpl-name">
            <input
              autoFocus
              placeholder="INPUT_NAME"
              aria-label="Input name"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addInput()
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setNaming(false)
                }
              }}
            />
            <button type="button" disabled={!INPUT_NAME.test(inputName)} onClick={addInput}>
              Add
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setNaming(true)}>
            + Input
          </button>
        )}
      </div>
      <div className="tpl-editor">
        <div ref={layer} className="tpl-layer" aria-hidden>
          {segments.map((s, i) =>
            s.kind === 'text' ? (
              <Fragment key={i}>{s.text}</Fragment>
            ) : (
              <span key={i} className={s.kind === 'input' ? 'tpl-input' : 'tpl-builtin'}>
                {s.raw}
              </span>
            )
          )}
          {/* A trailing newline needs a glyph after it to take up a line */}
          {'\u200b'}
        </div>
        <textarea
          ref={ta}
          className="tpl-textarea"
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value)
            track(e.target.value, e.target.selectionStart)
          }}
          onScroll={(e) => {
            if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop
          }}
          onBlur={() => setSuggest(null)}
          onKeyDown={(e) => {
            if (!suggest || matches.length === 0) return
            if (e.key === 'ArrowDown') setActive((a) => (a + 1) % matches.length)
            else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + matches.length) % matches.length)
            else if (e.key === 'Enter' || e.key === 'Tab') pick(matches[active])
            else if (e.key === 'Escape') setSuggest(null)
            else return
            e.preventDefault()
            e.stopPropagation()
          }}
        />
        {suggest && matches.length > 0 && (
          <div className="tpl-menu tpl-suggest" role="listbox">
            {matches.map((b, i) => (
              <button
                type="button"
                key={b.name}
                className={`tpl-menu-item${i === active ? ' active' : ''}`}
                // mousedown, not click: the textarea's blur would close the list first
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(b)
                }}
              >
                <span className="tpl-builtin">[{b.name}]</span>
                <span className="tpl-menu-desc">{b.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tpl-legend">
        <span className="tpl-input">{'{INPUT}'}</span> asks when clicked ·{' '}
        <span className="tpl-builtin">[built_in]</span> filled in · type <code>[</code> for built-ins
      </div>
    </div>
  )
}
