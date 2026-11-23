// What the camp popover says (campsite parts 3a, 3b, 3c, 3d-1 and 3d-2): a building's row, whether a hire can be
// made, a member's status line, how far it is through its level, and a building's tooltip on the
// strip; a member's view: its gear rows, its bonus, and the pin's choices; the trails: a flag's
// label, a trail's row and its history's lines, the Trails tab's groups, the signpost's and the
// cairn's words, the summit's line; the header's weather glyph and its reason; the field guide's
// cards (names, counts, hints for unseen species, the new dot) and an animal's button; the
// noticeboard (part 5): its button's name, a note's line, a report's excerpt and when the notes count as seen. Pure.
import type { CampSnapshot, CrewEntry, Pin, PinRef, TrailEntry } from './camp.ts'
import { GEAR_COST, GEAR_SLOTS, GEAR_TOP, SLOT_NAMES, building, costLabel, gearGate, gearItem, type BuildingId, type Cost, type GearSlot } from './catalog.ts'
import { levelXp } from './crew.ts'
import { ago, providerName } from './journal.ts'
import { textLength, whoLine, type Note, type TrailReport } from './notes.ts'
import { shortfall } from './shop.ts'
import { STAGES, STAGE_HINTS, SUMMIT, type TrailRecord } from './trails.ts'
import { SPECIES, isRare, species, type GuideEntry, type SpeciesDef } from './wildlife.ts'
import type { Phase, Weather } from './world.ts'

export interface ShopRow {
  id: BuildingId
  /** The offered tier's name, or the top tier's once it is fully built */
  name: string
  /** "Tier 2 of 3" */
  tier: string
  effect: string
  /** The tier on offer; null: fully built */
  offer: { tier: number; cost: Cost } | null
  /** "🪵 300 · ⛳ 1" ('' when fully built) */
  price: string
  /** Why it can't be built now ("Need 120 more wood"); null when it can, or when it is built */
  short: string | null
}

export function shopRow(snap: Pick<CampSnapshot, 'wood' | 'markers' | 'built' | 'offers'>, id: BuildingId): ShopRow {
  const def = building(id)
  const offer = snap.offers.find((o) => o.id === id)
  const n = offer ? offer.tier : snap.built[id]
  const t = def.tiers[n - 1]
  return {
    id,
    name: t.name,
    tier: `Tier ${n} of ${def.tiers.length}`,
    effect: t.effect,
    offer: offer ? { tier: offer.tier, cost: offer.cost } : null,
    price: offer ? costLabel(offer.cost) : '',
    short: offer ? shortfall(snap, offer.cost) : null
  }
}

export interface HireState {
  disabled: boolean
  /** Why not: no free bunk, or wood short */
  reason: string | null
}

export function hireState(snap: Pick<CampSnapshot, 'wood' | 'crew' | 'bunks' | 'recruitCost'>): HireState {
  if (snap.crew.length >= snap.bunks) return { disabled: true, reason: 'No free bunk: build a cabin first' }
  const short = shortfall({ wood: snap.wood, markers: 0 }, { wood: snap.recruitCost, markers: 0 })
  return short ? { disabled: true, reason: short } : { disabled: false, reason: null }
}

/** "with <session label>" (a session in this window's project), "out on another project", "fishing" (with the lake) or "resting" */
export function memberStatus(snap: Pick<CampSnapshot, 'assignments' | 'built'>, crewId: string, labels: ReadonlyMap<string, string>): string {
  const terminalId = Object.keys(snap.assignments).find((id) => snap.assignments[id] === crewId)
  if (terminalId !== undefined) {
    const label = labels.get(terminalId)
    return label === undefined ? 'out on another project' : `with ${label}`
  }
  return snap.built.lake >= 1 ? 'fishing' : 'resting'
}

/** How far a member is through its level, 0–1 (its XP bar) */
export function xpProgress(m: { level: number; xp: number; next: number }): number {
  const start = levelXp(m.level)
  return m.next > start ? Math.min(1, Math.max(0, (m.xp - start) / (m.next - start))) : 1
}

/** A building's tooltip on the strip: "Two cabins (tier 2 of 3)" */
export function placedTitle(p: { id: BuildingId; tier: number }): string {
  const def = building(p.id)
  return `${def.tiers[p.tier - 1].name} (tier ${p.tier} of ${def.tiers.length})`
}

/** A member's row in the crew list, for its button's label: "Aspen, Lv 2 Trailblazer, 150 / 400 XP, resting" */
export const memberSummary = (m: Pick<CrewEntry, 'name' | 'level' | 'title' | 'xp' | 'next'>, status: string): string => `${m.name}, Lv ${m.level} ${m.title}, ${m.xp} / ${m.next} XP, ${status}`

/** "+6% wood" */
export const bonusText = (bonus: number): string => `+${bonus}% wood`

/** A crew row's status line: where it is, and its gear's bonus when it has one ("fishing · +6% wood") */
export const crewLine = (status: string, bonus: number): string => (bonus > 0 ? `${status} · ${bonusText(bonus)}` : status)

export interface GearRow {
  slot: GearSlot
  /** "Pack" */
  slotName: string
  /** The item worn ("Forest pack"), or "None" */
  current: string
  /** The slot's next tier; null: it has the best there is */
  next: { tier: number; name: string; cost: number } | null
  /** "🪵 200" ('' with nothing next) */
  price: string
  /** Why it can't be bought now: the shed or the level ("Needs Lv 3"), else the wood ("Need 40 more wood"); null when it can */
  blocked: string | null
}

/** A member's four gear rows: what it wears, the next item and its price, or what it needs first */
export function gearRows(snap: Pick<CampSnapshot, 'wood' | 'built'>, member: Pick<CrewEntry, 'gear' | 'level'>): GearRow[] {
  return GEAR_SLOTS.map((slot) => {
    const tier = member.gear[slot]
    const current = tier > 0 ? gearItem(slot, tier).name : 'None'
    if (tier >= GEAR_TOP) return { slot, slotName: SLOT_NAMES[slot], current, next: null, price: '', blocked: null }
    const n = tier + 1
    const cost = GEAR_COST[n - 1]
    const blocked = gearGate(snap.built.shed, member.level, n) ?? shortfall({ wood: snap.wood, markers: 0 }, { wood: cost, markers: 0 })
    return { slot, slotName: SLOT_NAMES[slot], current, next: { tier: n, name: gearItem(slot, n).name, cost }, price: costLabel({ wood: cost, markers: 0 }), blocked }
  })
}

/** A pin as a select's value: '' (any session), "type:<id>" or "provider:<id>" (a type's id is its typeKey, "<project id>:<type id>") */
export const pinValue = (pin: PinRef | null): string => (pin ? `${pin.kind}:${pin.id}` : '')

/** The pin a select's value names (split at its first colon: the id may hold more); null for '' (or anything else) */
export function pinFrom(value: string): PinRef | null {
  const at = value.indexOf(':')
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  return at > 0 && id !== '' && (kind === 'type' || kind === 'provider') ? { kind, id } : null
}

/**
 * The pin's choices: any session, then each session type and agent seen in the last 30 days; a type
 * whose name another seen type shares says its project (its name, else the typeKey's project id); a
 * current pin no longer seen stays listed, by its name, saying so
 */
export function pinOptions(snap: Pick<CampSnapshot, 'seenKinds'>, current: Pin | null): { value: string; label: string }[] {
  const label = (kind: Pin['kind'], name: string): string => `${kind === 'type' ? 'Session type' : 'Agent'}: ${name}`
  const types = snap.seenKinds.filter((k) => k.kind === 'type')
  const shared = (k: { id: string; name: string }): boolean => types.some((o) => o.id !== k.id && o.name === k.name)
  const project = (k: CampSnapshot['seenKinds'][number]): string => k.project ?? k.id.slice(0, Math.max(0, k.id.indexOf(':')))
  const named = (k: CampSnapshot['seenKinds'][number]): string => (k.kind === 'type' && shared(k) ? `${k.name} (${project(k)})` : k.name)
  const out = [{ value: '', label: 'Any session' }, ...snap.seenKinds.map((k) => ({ value: pinValue(k), label: label(k.kind, named(k)) }))]
  if (current && !out.some((o) => o.value === pinValue(current))) {
    const name = current.kind === 'provider' ? providerName(current.id) : current.name
    out.push({ value: pinValue(current), label: `${label(current.kind, name)} (not seen in 30 days)` })
  }
  return out
}

/** A flag's title and label: "feature/x — Ridge (PR open)" */
export const flagLabel = (t: { branch: string; stage: number }): string => `${t.branch} — ${STAGE_HINTS[t.stage]}`

/** How long since `at`: "for 5 m", "for 3 h", "for 2 d" (never below a minute) */
export function forText(at: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000))
  if (minutes < 60) return `for ${minutes} m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `for ${hours} h` : `for ${Math.floor(hours / 24)} d`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day in the viewer's time: "today", "yesterday", else "Nov 3" */
export function dayText(at: number, now: number): string {
  const day = (t: number): number => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  const d = new Date(at)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** A trail's row: its stage and how long it has been there ("Ridge · for 2 d"), or "Summited ✓ today" */
export const trailStatus = (t: Pick<TrailEntry, 'stage' | 'stageAt'>, now: number): string => (t.stage === SUMMIT ? `Summited ✓ ${dayText(t.stageAt, now)}` : `${STAGES[t.stage]} · ${forText(t.stageAt, now)}`)

/** The stage meter's label: "Stage 3 of 5: Ridge" */
export const meterLabel = (stage: number): string => `Stage ${stage + 1} of ${STAGES.length}: ${STAGES[stage]}`

/** A history line: "Summited Nov 3" or "Turned back yesterday" */
export const historyText = (r: Pick<TrailRecord, 'result' | 'end'>, now: number): string => `${r.result === 'summited' ? 'Summited' : 'Turned back'} ${dayText(r.end, now)}`

/** The Trails tab's groups: this window's project's trails, then each other project's (by name), each oldest first */
export function trailGroups(trails: readonly TrailEntry[], projectId: string): { here: TrailEntry[]; others: { projectId: string; projectName: string; trails: TrailEntry[] }[] } {
  const here = trails.filter((t) => t.projectId === projectId)
  const others = new Map<string, { projectId: string; projectName: string; trails: TrailEntry[] }>()
  for (const t of trails) {
    if (t.projectId === projectId) continue
    let g = others.get(t.projectId)
    if (!g) others.set(t.projectId, (g = { projectId: t.projectId, projectName: t.projectName, trails: [] }))
    g.trails.push(t)
  }
  return { here, others: [...others.values()].sort((a, b) => (a.projectName < b.projectName ? -1 : a.projectName > b.projectName ? 1 : 0)) }
}

/** Without the signpost, the Trails tab's line about the other projects */
export const SIGNPOST_HINT = "Build the trail signpost to see your other projects' trails"
/** No trails in this window's project */
export const NO_TRAILS = 'No trails yet: a new worktree starts one.'
/** The signpost's planks: "1 trail", "3 trails" (every project's) */
export const signpostText = (n: number): string => (n === 1 ? '1 trail' : `${n} trails`)
/** The cairn's label: "1 summit", "12 summits" */
export const cairnText = (n: number): string => (n === 1 ? '1 summit' : `${n} summits`)
/** The header's line while a summit is celebrated */
export const summitLine = (branch: string): string => `⛳ Summited ${branch}`

/** The header's weather glyph (none when clear) and what it says: its title and label */
export function weatherBadge(w: Weather): { glyph: string; text: string } | null {
  switch (w.kind) {
    case 'rain':
      return { glyph: '🌧\uFE0F', text: `Rain: checks failing on ${w.branch ?? 'a branch'}` }
    case 'snow':
      return { glyph: '❄\uFE0F', text: `Snow: checks failing on ${w.branch ?? 'a branch'}` }
    case 'fog':
      return { glyph: '🌫\uFE0F', text: `Fog: quiet for ${w.hours ?? 12} h` }
    default:
      return null
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A date in the viewer's time: "Nov 23" */
export function monthDay(at: number): string {
  const d = new Date(at)
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
}

const cap = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`
const and = (words: readonly string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)
const PHASE_ORDER: readonly Phase[] = ['dawn', 'day', 'dusk', 'night']
/** Two times of day in words, keyed in PHASE_ORDER */
const PHASE_PAIRS: Readonly<Record<string, string>> = {
  'dawn+day': 'Mornings and by day',
  'dawn+dusk': 'At dawn and dusk',
  'dawn+night': 'At night and dawn',
  'day+dusk': 'By day and at dusk',
  'day+night': 'By day and at night',
  'dusk+night': 'Dusk and night'
}

/** An unseen species' hint (ranger tower II), from its gates: "At night · Near water · Winter only"; "Any time, anywhere" with none */
export function speciesHint(s: SpeciesDef): string {
  const parts: string[] = []
  const p = s.phases
  if (p) {
    const missing = PHASE_ORDER.filter((x) => !p.includes(x))
    if (p.length === 1) parts.push(p[0] === 'day' ? 'By day' : `At ${p[0]}`)
    else if (missing.length === 1) parts.push(missing[0] === 'day' ? 'Not by day' : `Not at ${missing[0]}`)
    else if (missing.length === 2) parts.push(PHASE_PAIRS[PHASE_ORDER.filter((x) => p.includes(x)).join('+')])
  }
  if (s.needs === 'lake') parts.push('Near water')
  const q = s.seasons
  if (q) {
    if (q.length === 3 && !q.includes('winter')) parts.push('Not in winter')
    else if (q.length === 1) parts.push(`${cap(q[0])} only`)
    else parts.push(cap(and(q)))
  }
  const b = s.boosts ?? {}
  if (b.rain) parts.push('More in the rain')
  if (b.fog) parts.push('More in fog')
  if (b.autumn) parts.push('More in autumn')
  if (b.dawn && b.dusk) parts.push('More at dawn and dusk')
  return parts.length === 0 ? 'Any time, anywhere' : parts.join(' · ')
}

/** A rare's card without the ranger tower */
export const TOWER_HINT = 'Needs the ranger tower'

export interface GuideCard {
  id: string
  /** Its name, or "???" while unseen */
  name: string
  seen: boolean
  /** "Seen 12 times" (seen), else '' */
  count: string
  /** "first Nov 23" (seen); unseen: its hint (ranger tower II), TOWER_HINT (a rare without the tower), else '' */
  line: string
  /** The card's label: "Red fox, seen 12 times, first Nov 23" (", new" with the dot); "Unknown animal, not seen yet" (and its line) */
  label: string
  /** First seen after the tab was last opened */
  isNew: boolean
}

const times = (n: number): string => (n === 1 ? 'once' : `${n} times`)

/**
 * The guide's seen time on opening the tab: now, or the newest page's first sighting when that is
 * later (the server's clock ahead of this window's), so the dot never comes back for a species seen
 * before the tab was opened
 */
export function guideSeenNow(guide: Readonly<Record<string, GuideEntry>> | undefined, now: number): number {
  // A server clock far ahead (or a hand-edited camp.json) can't push the seen time more than a day past now
  return Math.min(now + 86_400_000, Object.values(guide ?? {}).reduce((at, page) => Math.max(at, page.first), now))
}

/** The field guide's cards: the 20 commons, then the 4 rares; `since`: when the tab was last opened (ms), for the new dot */
export function guideCards(snap: { guide?: Readonly<Record<string, GuideEntry>>; built: { tower?: number } }, since: number): { commons: GuideCard[]; rares: GuideCard[] } {
  const guide = snap.guide ?? {}
  const tower = snap.built.tower ?? 0
  const card = (s: SpeciesDef): GuideCard => {
    const page = Object.hasOwn(guide, s.id) ? guide[s.id] : undefined
    if (page) {
      const first = monthDay(page.first)
      const isNew = page.first > since
      return { id: s.id, name: s.name, seen: true, count: `Seen ${times(page.count)}`, line: `first ${first}`, label: `${s.name}, seen ${times(page.count)}, first ${first}${isNew ? ', new' : ''}`, isNew }
    }
    const line = isRare(s) && tower < 1 ? TOWER_HINT : tower >= 2 ? speciesHint(s) : ''
    return { id: s.id, name: '???', seen: false, count: '', line, label: line ? `Unknown animal, not seen yet: ${line}` : 'Unknown animal, not seen yet', isNew: false }
  }
  return { commons: SPECIES.filter((s) => !isRare(s)).map(card), rares: SPECIES.filter(isRare).map(card) }
}

/** The Guide tab's name: "Guide 3/24" (species this version knows) */
export function guideTab(snap: { guide?: Readonly<Record<string, GuideEntry>> }): string {
  const seen = Object.keys(snap.guide ?? {}).filter((id) => species(id) !== undefined).length
  return `Guide ${seen}/${SPECIES.length}`
}

/** An animal's button on the strip: "Red fox — open the field guide" */
export const animalLabel = (id: string): string => `${species(id)?.name ?? 'An animal'} — open the field guide`

/** The Noticeboard section with no notes */
export const NO_NOTES = 'No notes yet. Agents can leave one with camp_note.'

/** The Noticeboard's notes shown before "Show all": the newest few, so the Buildings below stay in the popover's reach */
export const NOTES_SHOWN = 3

/** The Noticeboard's notes, newest first: all of them, or the newest NOTES_SHOWN */
export const shownNotes = <T>(list: readonly T[], all: boolean): T[] => {
  const newest = [...list].reverse()
  return all ? newest : newest.slice(0, NOTES_SHOWN)
}

/** The Noticeboard's toggle: "Show all (n)" or "Show fewer"; null when every note fits */
export function notesToggle(count: number, all: boolean): string | null {
  if (count <= NOTES_SHOWN) return null
  return all ? 'Show fewer' : `Show all (${count})`
}

/** The noticeboard's button: "Noticeboard", "Noticeboard, 1 new note", "Noticeboard, 2 new notes"; null: unread, but not yet counted */
export function boardLabel(unread: number | null): string {
  if (unread === null) return 'Noticeboard, new notes'
  if (unread <= 0) return 'Noticeboard'
  return unread === 1 ? 'Noticeboard, 1 new note' : `Noticeboard, ${unread} new notes`
}

/** A note's line before its text: "Claude · Juniper on feature/x — 12 m ago" ("An agent" when nobody is known) */
export const noteHead = (n: Pick<Note, 'agent' | 'member' | 'branch' | 'at'>, now: number): string =>
  `${whoLine(n.agent, n.member) || 'An agent'}${n.branch ? ` on ${n.branch}` : ''} — ${ago(n.at, now)}`

/** A project's newest note's time in the snapshot's `noteAt`; undefined when it has none (or the server is older) */
export const projectNoteAt = (noteAt: Readonly<Record<string, number>> | undefined, projectId: string): number | undefined => (noteAt && Object.hasOwn(noteAt, projectId) ? noteAt[projectId] : undefined)

/** The notes newer than `since` (the board's unread count) */
export const unreadNotes = (notes: readonly Pick<Note, 'at'>[], since: number): number => notes.filter((n) => n.at > since).length

/** The Noticeboard's seen time on showing it: now, or the newest note's time when that is later (the server's clock ahead), at most a day past now */
export const notesSeenNow = (noteAt: number | undefined, now: number): number => Math.min(now + 86_400_000, Math.max(now, noteAt ?? 0))

/** A report's excerpt under its trail's row, in code points */
export const REPORT_EXCERPT = 60

/** A report's one-line excerpt (cut at REPORT_EXCERPT code points with "…") and whether it was cut */
export function reportExcerpt(summary: string): { text: string; cut: boolean } {
  if (textLength(summary) <= REPORT_EXCERPT) return { text: summary, cut: false }
  return { text: `${[...summary].slice(0, REPORT_EXCERPT - 1).join('').trimEnd()}…`, cut: true }
}

/** Who posted a report and when: "Claude · Juniper, 5 m ago" ("An agent" when nobody is known) */
export const reportBy = (r: Pick<TrailReport, 'by' | 'at'>, now: number): string => `${r.by || 'An agent'}, ${ago(r.at, now)}`
