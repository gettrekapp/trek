// The last pty size the phone saw for each session (6a), from the session screen's attach,
// re-attach and pty.resized. The worktree screen's Restart passes it on: session.restart needs a
// size, and the phone never picks one of its own (the pty keeps the desktop's).
const sizes = new Map<string, { cols: number; rows: number }>()
const key = (serverId: string, sessionId: string): string => `${serverId}/${sessionId}`

export function rememberPtySize(serverId: string, sessionId: string, cols: number, rows: number): void {
  sizes.set(key(serverId, sessionId), { cols, rows })
}

export function knownPtySize(serverId: string, sessionId: string): { cols: number; rows: number } | undefined {
  return sizes.get(key(serverId, sessionId))
}
