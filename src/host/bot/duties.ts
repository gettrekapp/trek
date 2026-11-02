export interface Duty {
  text: string
  everyMs: number | null
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const MARKER = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/
const CHECKBOX = /^\[([ xX])\](?:\s+|$)/
const TAG = /^\[every\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\](?:\s+|$)/i

export function parseDuties(markdown: string): Duty[] {
  const found = new Map<string, Duty>()
  let inFence = false
  let inComment = false
  for (const line of markdown.split('\n')) {
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const open = line.lastIndexOf('<!--')
    if (open !== -1 && !line.includes('-->', open)) {
      inComment = true
      continue
    }
    const marker = MARKER.exec(line)
    if (!marker) continue
    let rest = marker[1].trim()
    const box = CHECKBOX.exec(rest)
    if (box) {
      if (box[1] !== ' ') continue
      rest = rest.slice(box[0].length)
    }
    let everyMs: number | null = null
    const tag = TAG.exec(rest)
    if (tag) {
      const ms = Number(tag[1]) * UNIT_MS[tag[2][0].toLowerCase()]
      if (ms > 0) everyMs = ms
      rest = rest.slice(tag[0].length)
    }
    const text = rest.trim()
    if (!text) continue
    const old = found.get(text)
    if (!old) found.set(text, { text, everyMs })
    else if (everyMs !== null && (old.everyMs === null || everyMs < old.everyMs)) old.everyMs = everyMs
  }
  return [...found.values()]
}

/** Scheduled duties that have never run or whose interval has elapsed. */
export function dueDuties(duties: Duty[], lastRuns: Record<string, number>, now: number): string[] {
  return duties
    .filter((d) => {
      if (d.everyMs === null) return false
      if (!Object.hasOwn(lastRuns, d.text)) return true
      return now - lastRuns[d.text] >= d.everyMs
    })
    .map((d) => d.text)
}
