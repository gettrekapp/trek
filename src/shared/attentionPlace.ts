// Where an attention entry lives, in words: shared by main's notification text
// and a window's notifications menu, so both say the same. Pure.
import type { AttentionItem } from './types.ts'

/** "Demo · Build box", with " · Global" for a Global panel session; the server alone without a project name. */
export function attentionPlace(item: Pick<AttentionItem, 'projectName' | 'serverName' | 'worktreeId'>): string {
  const where = item.projectName ? `${item.projectName} · ${item.serverName}` : item.serverName
  return item.worktreeId === null ? `${where} · Global` : where
}
