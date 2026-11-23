// The world around the camp (campsite part 3d-1): the time of day from the local clock (dawn, day,
// dusk, night, blended over the last 30 minutes before the next), the season by the month (northern
// or southern, or off), the backdrop's colours for both (dusk is exactly the strip's colours before
// 3d), and the weather over a project's camp from its trails and its last activity (rain while
// checks fail, snow in winter, fog after 12 quiet hours). Looks only: nothing here pays. Pure.
import { HOUR_MS } from './catalog.ts'

export type Phase = 'dawn' | 'day' | 'dusk' | 'night'
/** In order through a day */
export const PHASES: readonly Phase[] = ['dawn', 'day', 'dusk', 'night']
/** Each phase's first minute of the day (local) */
const STARTS: Readonly<Record<Phase, number>> = { dawn: 5 * 60, day: 8 * 60, dusk: 17 * 60, night: 20 * 60 }
/** The blend toward the next phase rises over its last this many minutes */
export const BLEND_MIN = 30

export interface PhaseAt {
  phase: Phase
  next: Phase
  /** 0–1: how far toward `next` (0 until BLEND_MIN minutes before it starts) */
  blend: number
}
/** Always dusk: the strip's look before part 3d */
export const DUSK: PhaseAt = { phase: 'dusk', next: 'night', blend: 0 }

/** The phase at a local time (an invalid date: dusk) */
export function phaseAt(date: Date): PhaseAt {
  const mins = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
  if (!Number.isFinite(mins)) return DUSK
  const phase: Phase = mins >= STARTS.night || mins < STARTS.dawn ? 'night' : mins >= STARTS.dusk ? 'dusk' : mins >= STARTS.day ? 'day' : 'dawn'
  const next = PHASES[(PHASES.indexOf(phase) + 1) % PHASES.length]
  let until = STARTS[next] - mins
  if (until < 0) until += 24 * 60
  return { phase, next, blend: until < BLEND_MIN ? 1 - until / BLEND_MIN : 0 }
}

export type Season = 'winter' | 'spring' | 'summer' | 'autumn'
/** Which half of the world the seasons follow, or none (today's look all year) */
export type Hemisphere = 'north' | 'south' | 'off'

/** The season at a local date: northern winter Dec–Feb, spring Mar–May, summer Jun–Aug, autumn Sep–Nov; southern six months on; off (or an invalid date): null */
export function seasonAt(date: Date, hemisphere: Hemisphere): Season | null {
  const month = date.getMonth()
  if (hemisphere === 'off' || !Number.isInteger(month)) return null
  const m = hemisphere === 'south' ? (month + 6) % 12 : month
  return m === 11 || m < 2 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'autumn'
}

/** The backdrop's colours */
export interface Palette {
  sky: string
  stars: string
  /** The ten stars' alpha (0: none) */
  starAlpha: number
  /** The night's extra stars' alpha */
  moreStars: number
  moon: string
  /** The bite that makes the moon a crescent, in the sky's colour: 1 the crescent, 0 a full disc (the day's pale sun) */
  bite: number
  ridge: string
  /** The trails' mountain, its ledges' lips and its path */
  peak: string
  ledge: string
  path: string
  pineLight: string
  pineDark: string
  /** Autumn: every third pine turns this; null: none */
  pineRust: string | null
  ground: string
  groundEdge: string
  trail: string
  /** Winter: the snow on the ridge's and the peak's tops; null: none */
  snow: string | null
  /** The fire's glow's size (1: as at dusk) */
  glow: number
  /** The string lights lit (else dark bulbs) */
  lights: boolean
}

function freezeAll(palettes: Record<Phase, Palette>): Readonly<Record<Phase, Readonly<Palette>>> {
  for (const p of Object.values(palettes)) Object.freeze(p)
  return Object.freeze(palettes)
}

/** Each phase's palette. Dusk is the strip's colours before part 3d, exactly. Frozen (each palette holds only strings, numbers and booleans, so that is all the way down): paletteAt hands them out as they are */
export const PALETTES: Readonly<Record<Phase, Readonly<Palette>>> = freezeAll({
  dusk: {
    sky: '#1a1622',
    stars: '#5a5068',
    starAlpha: 1,
    moreStars: 0,
    moon: '#f0c9a0',
    bite: 1,
    ridge: '#272031',
    peak: '#2f2740',
    ledge: '#463c5c',
    path: '#3d3450',
    pineLight: '#1e1a27',
    pineDark: '#17141d',
    pineRust: null,
    ground: '#16141b',
    groundEdge: '#2c2536',
    trail: '#221e2a',
    snow: null,
    glow: 1,
    lights: true
  },
  night: {
    sky: '#0e0d15',
    stars: '#6a6482',
    starAlpha: 1,
    moreStars: 1,
    moon: '#d9dce6',
    bite: 1,
    ridge: '#1a1723',
    peak: '#221e2e',
    ledge: '#373149',
    path: '#2f2a3f',
    pineLight: '#14121b',
    pineDark: '#0f0d14',
    pineRust: null,
    ground: '#0f0e13',
    groundEdge: '#1f1c28',
    trail: '#17151e',
    snow: null,
    glow: 1.35,
    lights: true
  },
  dawn: {
    sky: '#3a2e3c',
    stars: '#6a5e74',
    starAlpha: 0.45,
    moreStars: 0,
    moon: '#efd3b6',
    bite: 1,
    ridge: '#352d3e',
    peak: '#41384e',
    ledge: '#5a4e6c',
    path: '#4f445f',
    pineLight: '#26212e',
    pineDark: '#1f1b25',
    pineRust: null,
    ground: '#1f1b23',
    groundEdge: '#3a3141',
    trail: '#2a2530',
    snow: null,
    glow: 0.85,
    lights: true
  },
  day: {
    sky: '#36404e',
    stars: '#5a5068',
    starAlpha: 0,
    moreStars: 0,
    moon: '#e6e0c6',
    bite: 0,
    ridge: '#414b59',
    peak: '#4d5867',
    ledge: '#66717f',
    path: '#5c6775',
    pineLight: '#2f3b33',
    pineDark: '#28322b',
    pineRust: null,
    ground: '#262c25',
    groundEdge: '#3a4636',
    trail: '#30372e',
    snow: null,
    glow: 0.6,
    lights: false
  }
})

const hex2 = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
/** '#rrggbb' → [r, g, b] */
const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
/** A share held to 0–1 (NaN or none: 0) */
const unit = (t: number): number => Math.min(1, Math.max(0, t || 0))

/** From colour `a` toward `b` by t, held to 0–1 (0: `a` as it is) */
export function mix(a: string, b: string, t: number): string {
  t = unit(t)
  if (t <= 0) return a
  if (t >= 1) return b
  const x = channels(a)
  const y = channels(b)
  return `#${hex2(x[0] + (y[0] - x[0]) * t)}${hex2(x[1] + (y[1] - x[1]) * t)}${hex2(x[2] + (y[2] - x[2]) * t)}`
}

const COLOURS = ['sky', 'stars', 'moon', 'ridge', 'peak', 'ledge', 'path', 'pineLight', 'pineDark', 'ground', 'groundEdge', 'trail'] as const

/** One palette toward another by t, held to 0–1: colours and amounts mixed, the lights switched halfway */
function between(a: Readonly<Palette>, b: Readonly<Palette>, t: number): Readonly<Palette> {
  t = unit(t)
  if (t <= 0) return a
  const out: Palette = { ...a, starAlpha: a.starAlpha + (b.starAlpha - a.starAlpha) * t, moreStars: a.moreStars + (b.moreStars - a.moreStars) * t, bite: a.bite + (b.bite - a.bite) * t, glow: a.glow + (b.glow - a.glow) * t, lights: t < 0.5 ? a.lights : b.lights }
  for (const k of COLOURS) out[k] = mix(a[k], b[k], t)
  return out
}

/** A season's touch on a palette: winter frosts the pines, whitens the ground's edge and caps the tops with snow; autumn rusts some pines; spring greens the ground a little; summer none */
function seasoned(p: Readonly<Palette>, season: Season | null): Readonly<Palette> {
  switch (season) {
    case 'winter':
      return { ...p, pineLight: mix(p.pineLight, '#c4ccd8', 0.22), pineDark: mix(p.pineDark, '#c4ccd8', 0.14), ground: mix(p.ground, '#cfd6df', 0.06), groundEdge: mix(p.groundEdge, '#d6dde6', 0.4), snow: mix('#d4dbe4', p.sky, 0.45) }
    case 'autumn':
      return { ...p, pineRust: mix(p.pineLight, '#8a4a2a', 0.5) }
    case 'spring':
      return { ...p, ground: mix(p.ground, '#3e6a3a', 0.18), groundEdge: mix(p.groundEdge, '#4f7a45', 0.3) }
    default:
      return p
  }
}

/** The palette at a phase, toward the next by `blend`, with the season's touch (no season, blend 0 at dusk: the dusk palette itself) */
export function paletteAt(phase: Phase, next: Phase, blend: number, season: Season | null): Readonly<Palette> {
  return seasoned(between(PALETTES[phase], PALETTES[next], blend), season)
}

export type WeatherKind = 'clear' | 'rain' | 'snow' | 'fog'
/** The weather over a project's camp, and why */
export interface Weather {
  kind: WeatherKind
  /** Rain or snow: the branch whose checks fail */
  branch?: string
  /** Fog: whole hours since the project's last activity */
  hours?: number
}
/** Fog after this long without activity */
export const QUIET_MS = 12 * HOUR_MS

/** Failing checks rain only this long after their last result: unlinking a pull request or turning its watch off says nothing, so they can't rain forever */
export const CHECKS_RAIN_MS = 24 * HOUR_MS

/** A trail as the weather reads it (the camp's, or a snapshot's) */
export interface WeatherTrail {
  projectId: string
  branch: string
  checks: 'passed' | 'failed' | null
  /** When the checks' result came (ms) */
  checksAt: number | null
}

/**
 * A project's weather: rain while any of its open trails has failing checks from the last
 * CHECKS_RAIN_MS (snow in winter), the first such trail's branch the reason; else fog once QUIET_MS have passed since its last activity
 * (a project with none yet, as just after the upgrade, counts as active now); else clear
 */
export function weatherOf(trails: readonly WeatherTrail[], lastActive: Readonly<Record<string, number>>, projectId: string, now: number, season: Season | null): Weather {
  const failing = trails.find((t) => t.projectId === projectId && t.checks === 'failed' && t.checksAt !== null && now - t.checksAt < CHECKS_RAIN_MS)
  if (failing) return { kind: season === 'winter' ? 'snow' : 'rain', branch: failing.branch }
  const at = Object.hasOwn(lastActive, projectId) ? lastActive[projectId] : now
  const quiet = now - at
  return quiet >= QUIET_MS ? { kind: 'fog', hours: Math.floor(quiet / HOUR_MS) } : { kind: 'clear' }
}

/** Rain and fog dim the sky a little and hide most stars */
function weathered(p: Readonly<Palette>, kind: WeatherKind): Readonly<Palette> {
  if (kind === 'rain' || kind === 'snow') return { ...p, sky: mix(p.sky, '#16181e', 0.3), starAlpha: p.starAlpha * 0.25, moreStars: p.moreStars * 0.25, moon: mix(p.moon, p.sky, 0.45) }
  if (kind === 'fog') return { ...p, sky: mix(p.sky, '#2a2c33', 0.25), starAlpha: p.starAlpha * 0.4, moreStars: p.moreStars * 0.4, moon: mix(p.moon, p.sky, 0.3) }
  return p
}

/** What the strip shows: the phase (and its blend, in sixteenths), the season and the weather */
export interface World extends PhaseAt {
  season: Season | null
  weather: WeatherKind
}
/** The strip before part 3d: dusk, no season, clear */
export const DUSK_WORLD: World = { ...DUSK, season: null, weather: 'clear' }

/** The world at `now` (ms): the clock's phase, or always dusk; the season by the hemisphere; the blend quantised to 1/16 so it changes a few times in half an hour */
export function worldAt(now: number, sky: 'clock' | 'dusk', hemisphere: Hemisphere, weather: WeatherKind): World {
  const date = new Date(now)
  const p = sky === 'dusk' ? DUSK : phaseAt(date)
  return { phase: p.phase, next: p.next, blend: Math.floor(p.blend * 16) / 16, season: seasonAt(date, hemisphere), weather }
}

/** The same string while the world looks the same */
export const worldKey = (w: World): string => `${w.phase}>${w.next}:${w.blend}:${w.season ?? 'none'}:${w.weather}`

/** The backdrop's colours for a world (may be one of the frozen PALETTES: read only) */
export const worldPalette = (w: World): Readonly<Palette> => weathered(paletteAt(w.phase, w.next, w.blend, w.season), w.weather)

/**
 * The parts of a polygon (x, y pairs) above y = `cut`, each its own polygon (the ridge has several
 * tops): the snow on them. A polygon wholly above is returned whole
 */
export function capsAbove(points: readonly number[], cut: number): number[][] {
  const n = points.length / 2
  let start = -1
  for (let i = 0; i < n; i++) {
    if (points[2 * i + 1] > cut) {
      start = i
      break
    }
  }
  if (start < 0) return n >= 3 ? [[...points]] : []
  const caps: number[][] = []
  let cap: number[] | null = null
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    const j = (i + 1) % n
    const ax = points[2 * i]
    const ay = points[2 * i + 1]
    const bx = points[2 * j]
    const by = points[2 * j + 1]
    if (cap) cap.push(ax, ay)
    if (ay > cut !== by > cut) {
      const x = ax + ((bx - ax) * (cut - ay)) / (by - ay)
      if (by <= cut) cap = [x, cut]
      else if (cap) {
        cap.push(x, cut)
        if (cap.length >= 6) caps.push(cap)
        cap = null
      }
    }
  }
  return caps
}
