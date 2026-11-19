// A hiker's look, from its session's id: the same id always gives the same hiker (after a restart
// too). The provider picks the jacket; everything else comes from the id. Pure.

export const HATS = ['beanie', 'bucket', 'cap', 'headlamp', 'none'] as const
export type Hat = (typeof HATS)[number]
export const GEARS = ['pole', 'map', 'mug', 'compass'] as const
export type Gear = (typeof GEARS)[number]

export const HAT_COLORS = ['#c94f3d', '#3a6ea5', '#b9a77a', '#d4a017', '#6b7a3a', '#7a4a6b'] as const
export const HAIRS = ['#3b2a1a', '#e0b050', '#8a3b1c', '#222222', '#bbbbbb'] as const
export const SKINS = ['#f2c9a0', '#d9a066', '#a86b3c', '#6e4527'] as const
export const PACKS = ['#6b7a3a', '#8a5a2b', '#4a5d7a', '#c08a2e', '#7a4a6b', '#3f6f6a'] as const

export const JACKETS: Readonly<Record<string, string>> = { claude: '#d97757', codex: '#3fae6a', gemini: '#4c8df6', grok: '#8f96a0' }
export const NEUTRAL_JACKET = '#a08a6a'

export interface Look {
  jacket: string
  hat: Hat
  hatColor: string
  hair: string
  skin: string
  beard: boolean
  pack: string
  gear: Gear
}

/** 32-bit FNV-1a */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32: a small seeded generator, numbers in [0, 1) */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function lookFor(terminalId: string, provider: string): Look {
  const next = generator(fnv1a(terminalId))
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
  // A fixed order of draws: adding a field later goes at the end, so existing hikers keep their looks.
  const hat = pick(HATS)
  const hatColor = pick(HAT_COLORS)
  const hair = pick(HAIRS)
  const skin = pick(SKINS)
  const beard = next() < 0.3
  const pack = pick(PACKS)
  const gear = pick(GEARS)
  const jacket = Object.hasOwn(JACKETS, provider) ? JACKETS[provider] : NEUTRAL_JACKET
  return { jacket, hat, hatColor, hair, skin, beard, pack, gear }
}
