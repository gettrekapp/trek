// Pull request providers (plugins P3): a hosting service's PR links, labels and numbers, as pure
// shared code. A provider plugin's client half gives this object as `prProvider`; its server half
// gives a PrServerProvider (server.ts), which extends it. Core's watch (server/src/prWatch/) and the
// clients' chips and dialogs go through the providers on for the project; no host is named here.
export type { PrView, ChecksState, PromptHint } from '../prWatch.ts'
export { checkName } from '../prWatch.ts'

/** A pull request link as its provider reads it. */
export interface ParsedPr {
  /** The canonical link: what `branch.setPr` stores */
  url: string
  number: number
  /** The chip's label ('#12') */
  label: string
}

export interface PrProvider {
  /** The plugin's id ('github') */
  id: string
  /** What it takes, for a message: 'a GitHub pull request link' */
  hint: string
  /** The sign-in the watch needs, as a person names it ('gh'): "watch paused — gh isn't signed in" */
  signInName: string
  /** A link in any form it accepts → its canonical form; null when it isn't this host's */
  parse(input: string): ParsedPr | null
  /** Whether a stored canonical link is this provider's */
  owns(url: string): boolean
  /** A bare number, its repository taken from links already stored in the same repository; null when none fits */
  fromNumber?(n: number, linkedUrls: readonly string[]): ParsedPr | null
}

/** Types a provider. */
export const definePrProvider = <T extends PrProvider>(provider: T): T => provider

/** A provider call that throws counts as no match (logged once per provider and method). */
const warned = new Set<string>()
function safely<T>(provider: PrProvider, method: string, fallback: T, call: () => T): T {
  try {
    return call()
  } catch (err) {
    const key = `${provider.id}:${method}`
    if (!warned.has(key)) {
      warned.add(key)
      console.warn(`[pullRequests] provider ${provider.id} failed (${method}): ${err instanceof Error ? err.message : String(err)}`)
    }
    return fallback
  }
}

const valid = (pr: ParsedPr | null | undefined): pr is ParsedPr =>
  !!pr && typeof pr.url === 'string' && pr.url !== '' && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.label === 'string' && pr.label !== ''

/** `input` parsed by `provider`; null when it isn't the provider's, its parse throws (logged once), or the answer is unusable. */
export function safeParse(provider: PrProvider, input: string): ParsedPr | null {
  const parsed = safely(provider, 'parse', null, () => provider.parse(input))
  return valid(parsed) ? parsed : null
}

/** The first provider (in order) that parses `input` into a link it owns; null when none does. */
export function parsePrWith(providers: readonly PrProvider[], input: string): (ParsedPr & { providerId: string }) | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  for (const provider of providers) {
    const parsed = safely(provider, 'parse', null, () => provider.parse(trimmed))
    if (!valid(parsed)) continue
    if (!safely(provider, 'owns', false, () => provider.owns(parsed.url))) continue
    return { ...parsed, providerId: provider.id }
  }
  return null
}

/**
 * What a pull request box saves: the canonical link of the first provider that takes `input`, else
 * any other http(s) link as typed (trimmed; it gets the generic chip and no watch, as a link no
 * provider owns does); null when it is neither.
 */
export function prLinkToSave(providers: readonly PrProvider[], input: string): string | null {
  const parsed = parsePrWith(providers, input)
  if (parsed) return parsed.url
  const trimmed = input.trim()
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null
}

/** The provider that owns a stored link, if one of these does. */
export function prOwner<P extends PrProvider>(providers: readonly P[], url: string): P | undefined {
  return providers.find((p) => safely(p, 'owns', false, () => p.owns(url)))
}

/** "#123" from any link with a /pull/ or /pullrequest/ number; "PR" otherwise. */
export function genericPrLabel(url: string): string {
  const match = url.match(/\/pull(?:request)?s?\/(\d+)/i)
  return match ? `#${match[1]}` : 'PR'
}

/** A stored link's label: its owner's, else the generic one. */
export function prLabel(providers: readonly PrProvider[], url: string): string {
  const owner = prOwner(providers, url)
  const parsed = owner ? safely(owner, 'parse', null, () => owner.parse(url)) : null
  return valid(parsed) ? parsed.label : genericPrLabel(url)
}

export type PrResolution = { ok: true; pr: ParsedPr & { providerId: string } } | { ok: false; problem: string }

/**
 * What the user (or an agent) typed → the link to store: a link through parsePrWith, else a bare
 * number (`12`, `#12`) through each provider's fromNumber with the links already stored in the
 * repository; else the problem, naming what the providers take.
 */
export function resolvePrInput(providers: readonly PrProvider[], input: string, linkedUrls: readonly string[]): PrResolution {
  if (providers.length === 0) return { ok: false, problem: 'No pull request provider is on in this project (Settings → Plugins).' }
  const parsed = parsePrWith(providers, input)
  if (parsed) return { ok: true, pr: parsed }
  const num = input.trim().match(/^#?(\d+)$/)
  if (num) {
    const n = Number(num[1])
    for (const provider of Number.isSafeInteger(n) && n > 0 ? providers : []) {
      const pr = safely(provider, 'fromNumber', null, () => provider.fromNumber?.(n, linkedUrls) ?? null)
      if (valid(pr) && safely(provider, 'owns', false, () => provider.owns(pr.url))) return { ok: true, pr: { ...pr, providerId: provider.id } }
    }
  }
  const takes = providers.map((p) => p.hint).join(', or ')
  return { ok: false, problem: `Enter ${takes}, or a number once another pull request is linked in this repository.` }
}
