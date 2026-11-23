// Claude Code's history (plugins A1; core's `src/host/claudeSessionService.ts` before, now
// `src/main`'s, for the importer only): one ~/.claude/projects/<encoded cwd>/<session id>.jsonl per
// conversation, and a folder of the same name for its subagents and tool results. The encoding
// replaces every non-alphanumeric character with "-" (desktop main's importer keeps its own copy of
// projectDir: keep the two the same). Resuming a session from another cwd (after a promote) works
// only once its history is moved.
import { realpathSync } from 'node:fs'
import { access, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentHistory } from '../../../src/shared/plugins/agents.ts'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A cwd as Claude Code names its project folder: every non-alphanumeric character a dash */
const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd))
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
}

/** A conversation's history file for a session run in `cwd`: what a move carries to another server. */
export function historyFile(cwd: string, sessionId: string): string {
  assertSessionId(sessionId)
  return join(projectDir(cwd), `${sessionId}.jsonl`)
}

/** The most transcript paths a running session's follower looks at */
export const TRANSCRIPT_CANDIDATES_MAX = 4

/**
 * Where a running session's transcript may be (campsite part 4: its tool calls), most likely first,
 * no path twice (at most TRANSCRIPT_CANDIDATES_MAX). Claude Code names the folder after its
 * physical cwd (`process.cwd()`): the cwd with its symlinks resolved on POSIX, while on Windows it
 * keeps a junction as given; so both forms: realpath(cwd) (skipped when it fails), then the cwd as
 * given. It keeps the folder under `$CLAUDE_CONFIG_DIR/projects` when its env sets it (the server's,
 * which the agent inherits; empty is unset), else ~/.claude/projects; both roots are looked at, the
 * config dir's first. historyFile and the importer keep ~/.claude and the cwd as given, as they
 * always have.
 */
export function transcriptFiles(cwd: string, sessionId: string, env: Record<string, string | undefined> = process.env): string[] {
  assertSessionId(sessionId)
  const forms: string[] = []
  try {
    forms.push(realpathSync(cwd))
  } catch {
    // Not there (yet), or unreadable: the cwd as given only
  }
  forms.push(cwd)
  const roots: string[] = []
  if (env.CLAUDE_CONFIG_DIR) roots.push(join(env.CLAUDE_CONFIG_DIR, 'projects'))
  roots.push(join(homedir(), '.claude', 'projects'))
  const out: string[] = []
  for (const root of roots) {
    for (const form of forms) {
      const file = join(root, encodeCwd(form), `${sessionId}.jsonl`)
      if (!out.includes(file)) out.push(file)
    }
  }
  return out.slice(0, TRANSCRIPT_CANDIDATES_MAX)
}

/** The most likely of `transcriptFiles`: the physical cwd's, under the config dir when set */
export function transcriptFile(cwd: string, sessionId: string, env: Record<string, string | undefined> = process.env): string {
  return transcriptFiles(cwd, sessionId, env)[0]
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
