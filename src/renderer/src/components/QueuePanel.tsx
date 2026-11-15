import { useState } from 'react'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { queueLabel } from '../quickButtonRow'

interface Props {
  terminalId: string
  global?: boolean
}

/** The queue's chip, at the end of the quick buttons' row: it opens and closes the panel, and counts what is queued. */
export function QueueChip({ terminalId, global = false }: Props): React.JSX.Element {
  const queued = useAppStore((s) => s.terminalQueues[terminalId]?.length ?? 0)
  const open = useAppStore((s) => (global ? s.globalQueuePanelOpen : s.queuePanelOpen))
  const setOpen = useAppStore((s) => (global ? s.setGlobalQueuePanelOpen : s.setQueuePanelOpen))
  return (
    <button
      className={`queue-toggle ${open ? 'open' : ''} ${queued > 0 ? 'has-items' : ''}`}
      title={open ? 'Close queue' : 'Open queue'}
      aria-expanded={open}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => setOpen(!open)}
    >
      {queueLabel(queued)}
    </button>
  )
}

/**
 * Collapsible queue beside the terminal (opened from its chip). Blocks are stored oldest-first
 * (first in at the top); clicking one sends it to the terminal and submits.
 */
export function QueuePanel({ terminalId, global = false }: Props): React.JSX.Element | null {
  const queue = useAppStore((s) => s.terminalQueues[terminalId]) ?? []
  const open = useAppStore((s) => (global ? s.globalQueuePanelOpen : s.queuePanelOpen))
  const setOpen = useAppStore((s) => (global ? s.setGlobalQueuePanelOpen : s.setQueuePanelOpen))
  const enqueue = useAppStore((s) => s.enqueueTerminalText)
  const removeAt = useAppStore((s) => s.removeQueuedText)
  const [draft, setDraft] = useState('')

  if (!open) return null

  const addDraft = (): void => {
    const text = draft.trim()
    if (!text) return
    enqueue(terminalId, text)
    setDraft('')
  }

  const send = (index: number): void => {
    const text = queue[index]
    removeAt(terminalId, index)
    const backend = getBackend()
    backend.sessions
      .sendPrompt(terminalId, text)
      .catch((err) => backend.errors.promptFailed('Could not send the prompt', err, text))
  }

  const remove = (index: number): void => {
    removeAt(terminalId, index)
  }

  return (
    // The terminal pane's mousedown handler steals focus back to xterm;
    // stop it here so typing into the queue works.
    <div className="queue-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="queue-header">
        <span>Queue{queue.length > 0 ? ` · ${queue.length}` : ''}</span>
        <button className="queue-close" title="Close queue" onClick={() => setOpen(false)}>
          »
        </button>
      </div>
      <div className="queue-list">
        {queue.length === 0 && (
          <div className="queue-empty muted">
            Queue up prompts to run next — click one to send it to the terminal.
          </div>
        )}
        {queue.map((text, i) => (
          <div key={i} className="queue-item" title="Send to terminal" onClick={() => send(i)}>
            <span className="queue-item-text">{text}</span>
            <span
              className="queue-item-remove"
              title="Remove from queue"
              onClick={(e) => {
                e.stopPropagation()
                remove(i)
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>
      <div className="queue-compose">
        <textarea
          className="queue-input"
          placeholder="Queue a prompt… (⌘↵ to add)"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              addDraft()
            }
          }}
        />
        <button className="queue-add" disabled={!draft.trim()} onClick={addDraft}>
          Add to queue
        </button>
      </div>
    </div>
  )
}
