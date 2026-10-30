// Electron-free: shared by the Electron main process and the remote daemon.
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude Code stores sessions per working directory:
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — where the encoding
 * replaces every non-alphanumeric character with "-". Resuming a session from
 * a different cwd (e.g. after promoting a worktree into the main repo) only
 * works if the session file is moved into the new cwd's project directory.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
}

export async function migrateSession(
  sessionId: string,
  fromCwd: string,
  toCwd: string
): Promise<boolean> {
  assertSessionId(sessionId)
  const source = join(projectDir(fromCwd), `${sessionId}.jsonl`)
  try {
    await access(source)
  } catch {
    return false // no session recorded in the old directory (never used, or already moved)
  }
  const destDir = projectDir(toCwd)
  await mkdir(destDir, { recursive: true })
  await rename(source, join(destDir, `${sessionId}.jsonl`))
  return true
}

/** Reads a session's .jsonl for transfer to another machine; null if absent. */
export async function exportSession(cwd: string, sessionId: string): Promise<string | null> {
  assertSessionId(sessionId)
  try {
    return await readFile(join(projectDir(cwd), `${sessionId}.jsonl`), 'utf8')
  } catch {
    return null
  }
}

/** Writes a transferred session .jsonl under this machine's encoding of cwd. */
export async function importSession(
  cwd: string,
  sessionId: string,
  content: string
): Promise<void> {
  assertSessionId(sessionId)
  const destDir = projectDir(cwd)
  await mkdir(destDir, { recursive: true })
  await writeFile(join(destDir, `${sessionId}.jsonl`), content, 'utf8')
}

/** Removes a session file after a verified move to another machine. */
export async function deleteSession(cwd: string, sessionId: string): Promise<void> {
  assertSessionId(sessionId)
  await rm(join(projectDir(cwd), `${sessionId}.jsonl`), { force: true })
}
