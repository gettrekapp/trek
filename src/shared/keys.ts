// Named keys an agent can send through send_keys; anything else is typed literally.
export const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04'
}

export function keySequence(key: string): string {
  const name = key.toLowerCase()
  return Object.hasOwn(KEY_SEQUENCES, name) ? KEY_SEQUENCES[name] : key
}
