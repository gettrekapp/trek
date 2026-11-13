import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { BUILTINS, parseTemplate, type BuiltinDef } from '../../../shared/quickButtonTemplate.ts'

const GROUPS = [...new Set(BUILTINS.map((b) => b.group))]
const INPUT_NAME = /^[A-Za-z0-9_]+$/

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

/**
 * A textarea whose text is drawn by a highlight layer behind it: {inputs}
 * orange, [built-ins] blue. The textarea's own glyphs are transparent so the
 * layer shows through; both share font, padding and wrapping.
 */
export function TemplateEditor({ value, onChange, placeholder }: Props): React.JSX.Element {
  const ta = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const dropdown = useRef<HTMLDivElement>(null)
  /** Until the textarea is first focused its caret is 0: toolbar inserts go at the end instead */
  const everFocused = useRef(false)
  /** The `[` suggestion list: where its `[` is and what follows it */
  const [suggest, setSuggest] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [inputName, setInputName] = useState('')
  // A mousedown outside the built-in menu closes it.
  useEffect(() => {
    if (!listOpen) return undefined
    const onDown = (e: MouseEvent): void => {
      if (!dropdown.current?.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [listOpen])
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
    if (!el || !everFocused.current) {
      replace(value.length, value.length, token)
      return
    }
    replace(el.selectionStart, el.selectionEnd, token)
  }
  const pick = (b: BuiltinDef): void => {
    if (!suggest) return
    setSuggest(null)
    // The caret must still be right after the typed `[query`; anything else is a stale anchor.
    const caret = ta.current?.selectionStart ?? -1
    if (caret < suggest.start || caret !== suggest.start + 1 + suggest.query.length) return
    replace(suggest.start, caret, `[${b.name}]`)
  }
  const track = (text: string, caret: number): void => {
    const open = text.slice(0, caret).match(/\[([A-Za-z_]*)$/)
    setSuggest(open ? { start: caret - open[0].length, query: open[1] } : null)
    setActive(0)
  }
  const addInput = (): void => {
    if (!INPUT_NAME.test(inputName)) return
    insert(`{${inputName}}`) // focuses the textarea
    setNaming(false)
    setInputName('')
  }

  return (
    <div className="tpl">
      <div className="tpl-toolbar">
        <div
          ref={dropdown}
          className="tpl-dropdown"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && listOpen) {
              e.stopPropagation()
              setListOpen(false)
            }
          }}
        >
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
                  setInputName('')
                  // The field unmounts: keep focus in the modal so Escape can still close it.
                  requestAnimationFrame(() => ta.current?.focus())
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
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value)
            track(e.target.value, e.target.selectionStart)
          }}
          onFocus={() => {
            everFocused.current = true
          }}
          // The caret moved (arrows, Home/End, a click): the `[` list follows it.
          onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
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
