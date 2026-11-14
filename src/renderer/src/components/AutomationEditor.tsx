import { useMemo, useState } from 'react'
import type { Automation, AutomationInput } from '../../../shared/model/types'
import type { LlmProvider } from '../../../shared/providers/types'
import {
  HOUR_STEPS,
  MINUTE_STEPS,
  WEEKDAY_NAMES,
  cronFromPicker,
  formatWall,
  nextSlots,
  parseCron,
  pickerFromCron,
  type SchedulePicker
} from '../../../shared/cron'
import { getBackend } from '../backend'
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

/** Name, prompt, schedule (picker or cron), timezone, agent and enabled; Save / Cancel / Delete. */
export function AutomationEditor({ automation, onDone }: Props): React.JSX.Element {
  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const initialCron = automation?.schedule.cron ?? cronFromPicker(DEFAULT_PICKER)
  const [picker, setPicker] = useState<SchedulePicker>(pickerFromCron(initialCron) ?? DEFAULT_PICKER)
  const [advanced, setAdvanced] = useState(automation ? pickerFromCron(initialCron) === null : false)
  const [cron, setCron] = useState(initialCron)
  const [tz, setTz] = useState(automation?.schedule.tz ?? localTz())
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [llm, setLlm] = useState(automation?.llm)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const serverPicker = useServerPicker()
  const mcpOnly = (p: LlmProvider): boolean => p.capabilities.mcp && (!serverPicker.filter || serverPicker.filter(p))

  const effectiveCron = advanced ? cron : cronFromPicker(picker)
  const preview = useMemo(() => {
    try {
      return nextSlots(parseCron(effectiveCron), tz, Date.now(), 3).map((t) => formatWall(t, tz, true))
    } catch (err) {
      return (err as Error).message
    }
  }, [effectiveCron, tz])

  const cronInvalid = typeof preview === 'string'
  const noDays = !advanced && picker.kind === 'weekly' && picker.days.length === 0

  const setAdvancedMode = (on: boolean): void => {
    if (on) setCron(cronFromPicker(picker))
    else setPicker(pickerFromCron(cron) ?? DEFAULT_PICKER)
    setAdvanced(on)
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
    if (!automation) return
    const backend = getBackend()
    try {
      await backend.automations.remove(automation.id)
      onDone()
    } catch (err) {
      setError(backend.errors.inline(err))
    }
  }

  const time = picker.kind === 'daily' || picker.kind === 'weekly' ? timeValue(picker) : '09:00'
  return (
    <div className="automation-editor">
      <h3>{automation ? 'Edit automation' : 'New automation'}</h3>
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
        {advanced ? (
          <input type="text" className="automation-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="m h dom mon dow" />
        ) : (
          <div className="automation-picker">
            <select
              value={picker.kind}
              onChange={(e) => {
                const kind = e.target.value as SchedulePicker['kind']
                setPicker(
                  kind === 'minutes' ? { kind, every: 15 } : kind === 'hours' ? { kind, every: 1, minute: 0 } : kind === 'daily' ? { kind, hour: 9, minute: 0 } : { kind, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
                )
              }}
            >
              <option value="minutes">Every N minutes</option>
              <option value="hours">Every N hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            {picker.kind === 'minutes' && (
              <select value={picker.every} onChange={(e) => setPicker({ kind: 'minutes', every: Number(e.target.value) })}>
                {MINUTE_STEPS.map((n) => <option key={n} value={n}>{n} minutes</option>)}
              </select>
            )}
            {picker.kind === 'hours' && (
              <>
                <select value={picker.every} onChange={(e) => setPicker({ ...picker, every: Number(e.target.value) })}>
                  {HOUR_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? 'hour' : `${n} hours`}</option>)}
                </select>
                <span>at minute</span>
                <input type="number" min={0} max={59} value={picker.minute} onChange={(e) => setPicker({ ...picker, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
              </>
            )}
            {picker.kind === 'weekly' && (
              <span className="automation-days">
                {WEEKDAY_NAMES.map((label, day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={picker.days.includes(day)}
                      onChange={(e) => setPicker({ ...picker, days: e.target.checked ? [...picker.days, day] : picker.days.filter((d) => d !== day) })}
                    />
                    {label}
                  </label>
                ))}
              </span>
            )}
            {(picker.kind === 'daily' || picker.kind === 'weekly') && (
              <input
                type="time"
                value={time}
                onChange={(e) => {
                  const t = parseTime(e.target.value)
                  if (t) setPicker({ ...picker, ...t })
                }}
              />
            )}
          </div>
        )}
        <label className="llm-inline-check">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvancedMode(e.target.checked)} />
          Advanced (cron)
        </label>
      </div>
      <label className="settings-row">
        <span className="settings-name">Timezone</span>
        <input type="text" value={tz} onChange={(e) => setTz(e.target.value.trim())} />
      </label>
      <div className="automation-preview muted">
        {typeof preview === 'string' ? preview : preview.length ? `Next runs: ${preview.join(' · ')}` : 'Never runs'}
      </div>
      <div className="settings-row">
        <span className="settings-name">Agent</span>
        <label className="llm-inline-check">
          <input type="checkbox" checked={!llm} onChange={(e) => setLlm(e.target.checked ? undefined : { provider: 'claude' })} />
          The project&apos;s Global agent
        </label>
        {llm && <LlmPicker value={llm} onChange={setLlm} {...serverPicker} filter={mcpOnly} />}
      </div>
      <label className="llm-inline-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <div className="modal-footer automation-footer">
        {automation &&
          (confirmDelete ? (
            <>
              <span>Delete “{automation.name}”?</span>
              <button className="danger-button" onClick={() => void remove()}>Delete</button>
              <button onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button className="danger-button" onClick={() => setConfirmDelete(true)}>Delete…</button>
          ))}
        <span className="spacer" />
        <button onClick={onDone}>Cancel</button>
        <button className="primary primary-action" disabled={busy || !name.trim() || !prompt.trim() || noDays || cronInvalid} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}
