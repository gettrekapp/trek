// What the session screen sends its terminal page (6a). Pure, so `node --test` covers it
// (scripts/mobileLogic.test.mjs).
//
// The pty's output is held until its size is known: a replay drawn at xterm's default 80×24 and
// then resized would wrap wrong. attach() resolves (and a re-attach's onReattach fires) after
// the replay, with the size, so the size goes first and the held output after it, in one batch.
// A reset (a reconnect is about to replay again) clears the page and holds output again until
// the next size. A `pty.resized` from another client is applied as it comes.

export type PageMessage =
  | { type: 'data'; data: string }
  | { type: 'reset' }
  | { type: 'size'; cols: number; rows: number }
  /** The pty is on a Windows server (ConPTY): xterm's windowsPty option, before any output */
  | { type: 'windowsPty'; buildNumber: number }

export class TerminalFeed {
  private sized = false
  private held: string[] = []

  /** Output from the pty: shown now, or held until the size is known. */
  data(data: string): PageMessage[] {
    if (this.sized) return [{ type: 'data', data }]
    this.held.push(data)
    return []
  }

  /** Clear the page; output is held again until the next size. */
  reset(): PageMessage[] {
    this.sized = false
    this.held = []
    return [{ type: 'reset' }]
  }

  /**
   * The pty's size (attach, re-attach, or pty.resized): the size, then whatever was held. With
   * `windowsBuild` (an attach's windowsPty), xterm is set up for ConPTY first.
   */
  size(cols: number, rows: number, windowsBuild?: number): PageMessage[] {
    this.sized = true
    const out: PageMessage[] = windowsBuild === undefined ? [] : [{ type: 'windowsPty', buildNumber: windowsBuild }]
    out.push({ type: 'size', cols, rows })
    if (this.held.length) out.push({ type: 'data', data: this.held.join('') })
    this.held = []
    return out
  }
}

/** The page's script for a batch: one injectJavaScript call, applied in order. */
export function pageScript(messages: readonly PageMessage[]): string {
  return `(function(){var f=window.__trek;if(f){${JSON.stringify(messages)}.forEach(function(m){f(m)})}})(); true;`
}
