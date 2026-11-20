// Claude Code's history (plugins A1; src/host/claudeSessionService.ts before): one
// ~/.claude/projects/<encoded cwd>/<session id>.jsonl per conversation, and a folder of the same
// name for its subagents and tool results. The encoding replaces every non-alphanumeric character
// with "-" (desktop main's importer keeps its own copy of projectDir: keep the two the same).
// Resuming a session from another cwd (after a promote) works only once its history is moved.
import { access, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentHistory } from '../../../src/shared/plugins/agents.ts'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
}

/** A conversation's history file for a session run in `cwd`: what a move carries to another server. */
export function historyFile(cwd: string, sessionId: string): string {
  assertSessionId(sessionId)
  return join(projectDir(cwd), `${sessionId}.jsonl`)
}

/**
 * Moves a session's history to another cwd's project directory: its `<id>.jsonl` and, when it has
 * one, its `<id>/` folder (subagent transcripts, tool results). `moved` when either moved. A folder
 * that already exists at the destination is never overwritten: the source folder stays where it
 * is and `folderKept` names it, for the caller to say so.
 */
export async function migrateSession(sessionId: string, fromCwd: string, toCwd: string): Promise<{ moved: boolean; folderKept?: string }> {
  assertSessionId(sessionId)
  const source = join(projectDir(fromCwd), `${sessionId}.jsonl`)
  const folder = join(projectDir(fromCwd), sessionId)
  const hasFile = await access(source).then(() => true, () => false)
  const hasFolder = await stat(folder).then((s) => s.isDirectory(), () => false)
  // no session recorded in the old directory (never used, or already moved)
  if (!hasFile && !hasFolder) return { moved: false }
  const destDir = projectDir(toCwd)
  await mkdir(destDir, { recursive: true })
  if (hasFile) await rename(source, join(destDir, `${sessionId}.jsonl`))
  if (hasFolder) {
    const destFolder = join(destDir, sessionId)
    if (await access(destFolder).then(() => true, () => false)) return { moved: true, folderKept: folder }
    await rename(folder, destFolder)
  }
  return { moved: true }
}

/** Claude's: a promote moves it, a move to another server carries its file. */
export const claudeHistory: AgentHistory = { file: historyFile, migrate: migrateSession }

/**
 * Local's: it runs Claude Code, so its history is Claude Code's and follows a promote. A move between
 * servers does not carry it, as before plugins A1 (an older target takes only Claude sessions).
 */
export const localHistory: AgentHistory = { migrate: migrateSession }
