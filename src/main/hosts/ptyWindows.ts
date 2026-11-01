import type { WebContents } from 'electron'

/** Which window each live pty belongs to: its events go there and nowhere else. */
const owners = new Map<string, { windowId: number; contents: WebContents }>()

export function setPtyWindow(ptyId: string, contents: WebContents): void {
  owners.set(ptyId, { windowId: contents.id, contents })
}

export function deletePtyWindow(ptyId: string): void {
  owners.delete(ptyId)
}

export function ptysOfWindow(windowId: number): string[] {
  return [...owners].filter(([, owner]) => owner.windowId === windowId).map(([id]) => id)
}

export function sendToPtyWindow<T extends { id: string }>(channel: string, payload: T): void {
  const owner = owners.get(payload.id)
  if (owner && !owner.contents.isDestroyed()) owner.contents.send(channel, payload)
}
