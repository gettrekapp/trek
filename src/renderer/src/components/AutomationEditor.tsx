import { useMemo, useState } from 'react'
import type { Automation, AutomationInput } from '../../../shared/model/types'
import type { LlmProvider } from '../../../shared/providers/types'
import {
  HOUR_STEPS,
  MINUTE_STEPS,
  WEEKDAY_NAMES,
  cronFromPicker,
  describeCron,
  formatWall,
  nextSlots,
  parseCron,
  pickerFromCron,
  type SchedulePicker
} from '../../../shared/cron'
import { getBackend } from '../backend'
import { defaultPicker } from '../automations'
import { useAppStore } from '../store'
import { LlmPicker, useServerPicker } from './LlmPicker'

interface Props {
  /** Absent: a new automation */
  automation?: Automation
  onDone: () => void
}

const DEFAULT_PICKER: SchedulePicker = { kind: 'daily', hour: 9, minute: 0 }
const localTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const pad = (n: number): string => String(n).padStart(2, '0')

/** "HH:MM" ⇄ hour and minute for an <input type="time">. */
function timeValue(p: { hour: number; minute: number }): string {
  return `${pad(p.hour)}:${pad(p.minute)}`
}
function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null
}

const SCHEDULE_KINDS: { kind: SchedulePicker['kind'] | 'cron'; label: string }[] = [
  { kind: 'minutes', label: 'Minutes' },
  { kind: 'hours', label: 'Hours' },
  { kind: 'daily', label: 'Daily' },
  { kind: 'weekly', label: 'Weekly' },
  { kind: 'cron', label: 'Cron' }
]

/** Name, prompt, schedule (picker or cron), timezone, agent and enabled; Save / Cancel / Delete. */
export function AutomationEditor({ automation, onDone }: Props): React.JSX.Element {
  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const initialCron = automation?.schedule.cron ?? cronFromPicker(DEFAULT_PICKER)
  const [picker, setPicker] = useState<SchedulePicker>(pickerFromCron(initialCron) ?? DEFAULT_PICKER)
  const [advanced, setAdvanced] = useState(automation ? pickerFromCron(initialCron) === null : false)
  const [cron, setCron] = useState(initialCron)
  const [tz, setTz] = useState(automation?.schedule.tz ?? localTz())
  // On or off is the list's switch: the editor keeps what the automation has, and a new one starts on.
  const enabled = automation?.enabled ?? true
  const [llm, setLlm] = useState(automation?.llm)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const offline = useAppStore((s) => s.serverOffline)
  const serverPicker = useServerPicker()
  const mcpOnly = (p: LlmProvider): boolean => p.capabilities.mcp && (!serverPicker.filter || serverPicker.filter(p))

  const effectiveCron = advanced ? cron : cronFromPicker(picker)
  const preview = useMemo(() => {
    if (!advanced && picker.kind === 'weekly' && picker.days.length === 0) return 'Pick at least one day'
    try {
      return nextSlots(parseCron(effectiveCron), tz, Date.now(), 3).map((t) => formatWall(t, tz, true))
    } catch (err) {
      return (err as Error).message
    }
  }, [effectiveCron, tz, advanced, picker])

  const cronInvalid = typeof preview === 'string'
  const noDays = !advanced && picker.kind === 'weekly' && picker.days.length === 0

  const setAdvancedMode = (on: boolean): void => {
    if (on) setCron(cronFromPicker(picker))
    else setPicker(pickerFromCron(cron) ?? DEFAULT_PICKER)
    setAdvanced(on)
  }

  /** The schedule's kind as the row of choices shows it: one of the picker's, or cron. */
  const kind: SchedulePicker['kind'] | 'cron' = advanced ? 'cron' : picker.kind
  // A cron line the pickers cannot write can only be edited as cron.
  const cronOnly = advanced && pickerFromCron(cron) === null
  const chooseKind = (next: SchedulePicker['kind'] | 'cron'): void => {
    if (next === 'cron') {
      if (!advanced) setAdvancedMode(true)
      return
    }
    // Leaving cron keeps the line where the pickers can write it and it is of this kind.
    const from = advanced ? pickerFromCron(cron) : picker
    setPicker(from?.kind === next ? from : defaultPicker(next))
    setAdvanced(false)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const input: AutomationInput = {
      ...(automation ? { id: automation.id } : {}),
      name,
      prompt,
      schedule: { cron: effectiveCron, tz },
      enabled,
      llm: llm ?? null
    }
    const backend = getBackend()
    try {
      await backend.automations.save(input)
      onDone()
    } catch (err) {
      setError(backend.errors.inline(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!automation || busy) return
    setBusy(true)
    const backend = getBackend()
    try {
      await backend.automations.remove(automation.id)
      onDone()
    } catch (err) {
      setError(backend.errors.inline(err))
    } finally {
      setBusy(false)
    }
  }

  const time = picker.kind === 'daily' || picker.kind === 'weekly' ? timeValue(picker) : '09:00'
  return (
    <div className="automation-editor">
      <h2>{automation ? 'Edit automation' : 'New automation'}</h2>
      {error && <div className="error">{error}</div>}
      <label className="settings-row">
        <span className="settings-name">Name</span>
        <input type="text" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="settings-row">
        <span className="settings-name">Prompt</span>
        <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What the Global agent should do on each run" />
      </label>
      <div className="settings-row">
        <span className="settings-name">Schedule</span>
        <div className="automation-schedule-fields">
          <div className="automation-kinds" role="radiogroup" aria-label="Repeats">
            {SCHEDULE_KINDS.map((k) => {
              const blocked = k.kind !== 'cron' && cronOnly
              return (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.kind}
                  className={kind === k.kind ? 'active' : ''}
                  disabled={blocked}
                  title={blocked ? 'This schedule can only be edited as cron' : undefined}
                  onClick={() => chooseKind(k.kind)}
                >
                  {k.label}
                </button>
              )
            })}
          </div>
          <div className="automation-picker">
            {advanced && <input type="text" className="automation-cron" aria-label="Cron line" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="m h dom mon dow" />}
            {!advanced && picker.kind === 'minutes' && (
              <select aria-label="Every" value={picker.every} onChange={(e) => setPicker({ kind: 'minutes', every: Number(e.target.value) })}>
                {MINUTE_STEPS.map((n) => <option key={n} value={n}>{n} minutes</option>)}
              </select>
            )}
            {!advanced && picker.kind === 'hours' && (
              <>
                <select aria-label="Every" value={picker.every} onChange={(e) => setPicker({ ...picker, every: Number(e.target.value) })}>
                  {HOUR_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? 'hour' : `${n} hours`}</option>)}
                </select>
                <span>at minute</span>
                <input type="number" aria-label="Minute" min={0} max={59} value={picker.minute} onChange={(e) => setPicker({ ...picker, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
              </>
            )}
            {!advanced && picker.kind === 'weekly' && (
              <span className="automation-days" role="group" aria-label="Days">
                {WEEKDAY_NAMES.map((label, day) => {
                  const on = picker.days.includes(day)
                  return (
                    <button key={day} type="button" aria-pressed={on} className={on ? 'active' : ''} onClick={() => setPicker({ ...picker, days: on ? picker.days.filter((d) => d !== day) : [...picker.days, day] })}>
                      {label}
                    </button>
                  )
                })}
              </span>
            )}
            {!advanced && (picker.kind === 'daily' || picker.kind === 'weekly') && (
              <input
                type="time"
                aria-label="Time"
                value={time}
                onChange={(e) => {
                  const t = parseTime(e.target.value)
                  if (t) setPicker({ ...picker, ...t })
                }}
              />
            )}
            <label className="automation-tz-field">
              <span>in</span>
              <input type="text" className="automation-tz" aria-label="Timezone" value={tz} onChange={(e) => setTz(e.target.value.trim())} />
            </label>
          </div>
        </div>
      </div>
      <div className="automation-preview muted">
        {typeof preview === 'string' ? preview : `${describeCron(effectiveCron)} (${tz}). ${preview.length ? `Next runs: ${preview.join(' · ')}` : 'Never runs'}`}
      </div>
      <div className="settings-row">
        <span className="settings-name">Agent</span>
        <label className="llm-inline-check">
          <input type="checkbox" checked={!llm} onChange={(e) => setLlm(e.target.checked ? undefined : { provider: 'claude' })} />
          The project&apos;s Global agent
        </label>
        {llm && <LlmPicker value={llm} onChange={setLlm} {...serverPicker} filter={mcpOnly} />}
      </div>
      <div className="modal-footer automation-footer">
        {automation &&
          (confirmDelete ? (
            <>
              <span>Delete “{automation.name}”?</span>
              <button className="danger-button" disabled={busy || offline} onClick={() => void remove()}>Delete</button>
              <button onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button className="danger-button" onClick={() => setConfirmDelete(true)}>Delete…</button>
          ))}
        <span className="spacer" />
        <button onClick={onDone}>Cancel</button>
        <button className="primary primary-action" disabled={busy || offline || !name.trim() || !prompt.trim() || noDays || cronInvalid} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}
