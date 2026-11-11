// The session screen's key bar (6a): what each key writes to the pty. Pure.
export interface BarKey {
  label: string
  /** Accessibility label */
  name: string
  data: string
}

export const KEY_BAR: readonly BarKey[] = [
  { label: '⏎', name: 'Enter', data: '\r' },
  { label: 'Esc', name: 'Escape', data: '\x1b' },
  { label: 'Tab', name: 'Tab', data: '\t' },
  { label: '^C', name: 'Control C', data: '\x03' },
  { label: '↑', name: 'Up', data: '\x1b[A' },
  { label: '↓', name: 'Down', data: '\x1b[B' },
  { label: '←', name: 'Left', data: '\x1b[D' },
  { label: '→', name: 'Right', data: '\x1b[C' },
  { label: 'y', name: 'y', data: 'y' },
  { label: 'n', name: 'n', data: 'n' }
]
