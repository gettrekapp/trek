export interface Duty {
  text: string
  everyMs: number | null
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const LINE = /^\s*[-*]\s+(?:\[every\s+(\d+)\s*([mhd])\]\s+)?(.+?)\s*$/

export function parseDuties(markdown: string): Duty[] {
  const duties: Duty[] = []
  for (const line of markdown.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    duties.push({
      text: match[3],
      everyMs: match[1] ? Number(match[1]) * UNIT_MS[match[2]] : null
    })
  }
  return duties
}

/** Scheduled duties that have never run or whose interval has elapsed. */
export function dueDuties(duties: Duty[], lastRuns: Record<string, number>, now: number): string[] {
  return duties
    .filter((d) => {
      if (d.everyMs === null) return false
      const last = lastRuns[d.text]
      return last === undefined || now - last >= d.everyMs
    })
    .map((d) => d.text)
}
