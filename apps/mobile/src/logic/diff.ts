// A unified diff's lines, classed for colouring (read-only Changes, 6a). Pure.
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

export function classifyDiff(patch: string): { kind: DiffLineKind; text: string }[] {
  const lines = patch.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((text) => {
    if (text.startsWith('@@')) return { kind: 'hunk', text }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(text)) return { kind: 'meta', text }
    if (text.startsWith('+')) return { kind: 'add', text }
    if (text.startsWith('-')) return { kind: 'del', text }
    return { kind: 'context', text }
  })
}
