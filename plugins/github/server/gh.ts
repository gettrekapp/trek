// gh on the server's machine for the GitHub plugin (moved from server/src/prWatch/gh.ts in P3). gh
// uses its own sign-in (`gh auth login` as the server's user); the server never holds a GitHub
// token. TREK_SERVER_GH points the smokes at a stub (scripts/smokeGh.mjs).
import type { ServerPluginHost } from '../../../src/shared/plugins/server.ts'

/** Runs `gh <args>`, resolving with its stdout. */
export type GhRunner = (args: string[], signal?: AbortSignal) => Promise<string>

/** Never a prompt, a pager or an update check: the server has no terminal for them. */
export const GH_QUIET_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
const GH_TIMEOUT_MS = 30_000
/** A poll's answer is a few kilobytes (the query asks for no bodies) */
const GH_MAX_OUTPUT = 1024 * 1024
const NO_GH = 'gh is not installed on the server'

/** The runner through the host: gh, or TREK_SERVER_GH's stub; with a bad TREK_SERVER_GH, one that always fails. */
export function ghThroughHost(host: Pick<ServerPluginHost, 'run' | 'testCommand'>): GhRunner {
  const binary = host.testCommand('TREK_SERVER_GH', 'gh')
  if (binary === null) return () => Promise.reject(new Error(`${NO_GH} (TREK_SERVER_GH is not an absolute path)`))
  return (args, signal) =>
    host.run(binary, args, { timeoutMs: GH_TIMEOUT_MS, maxBytes: GH_MAX_OUTPUT, signal, env: GH_QUIET_ENV }).catch((err: unknown) => {
      throw (err as { code?: unknown })?.code === 'ENOENT' ? new Error(NO_GH) : err
    })
}

/**
 * A failed gh call that says gh's sign-in is the problem (not the network, GitHub, or this one PR).
 * host.run's message is gh's first stderr line, as the runner before P3 gave.
 */
export function isAuthFailure(message: string): boolean {
  return /\b401\b|bad credentials|not logged in|logged into any|gh auth login|authenticat/i.test(message)
}
