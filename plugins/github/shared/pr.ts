// GitHub's pull request links, pure (plugins P3): both halves and the phone import it.
import { definePrProvider, type ParsedPr } from '../../../src/shared/plugins/pullRequests.ts'

const ANY = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i
const CANONICAL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

const make = (owner: string, repo: string, n: number): ParsedPr => ({ url: `https://github.com/${owner}/${repo}/pull/${n}`, number: n, label: `#${n}` })

/** A canonical link's parts, for gh. */
export function githubParts(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(CANONICAL)
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null
}

export const githubPrs = definePrProvider({
  id: 'github',
  hint: 'a GitHub pull request link (https://github.com/<owner>/<repo>/pull/<number>)',
  signInName: 'gh',
  parse: (input: string): ParsedPr | null => {
    const m = input.trim().match(ANY)
    return m ? make(m[1], m[2], Number(m[3])) : null
  },
  owns: (url: string): boolean => CANONICAL.test(url),
  fromNumber: (n: number, linked: readonly string[]): ParsedPr | null => {
    const parts = linked.map(githubParts).find((p) => p !== null)
    return parts ? make(parts.owner, parts.repo, n) : null
  }
})
