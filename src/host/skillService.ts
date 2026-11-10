// The Claude Code skills and slash commands a worktree's sessions can run (phase 5b; main's
// skills.ts before it): the worktree's own `.claude/` and the user's `~/.claude/`, read on the
// server's machine. Electron-free.
import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { SkillInfo } from '../shared/types'

const MAX_DESCRIPTION = 120
/** The most read of one SKILL.md or command: the frontmatter is at its head. */
export const MAX_SKILL_HEAD = 16 * 1024

/**
 * The first MAX_SKILL_HEAD bytes of a regular file (after following links), or undefined for
 * anything else (a FIFO would block the read, a device never end) or a file outside `confine`
 * (its real path). Stat before opening, so a device is never opened; open non-blocking and stat
 * the handle, so a file swapped for a FIFO in between does not block either.
 */
async function readHead(path: string, confine?: string): Promise<string | undefined> {
  if (!(await stat(path)).isFile()) return undefined
  if (confine && !within(confine, await realpath(path))) return undefined
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    if (!(await handle.stat()).isFile()) return undefined
    const buffer = Buffer.alloc(MAX_SKILL_HEAD)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await handle.close()
  }
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Pulls `description:` out of YAML frontmatter, if present. */
export function extractDescription(markdown: string): string | undefined {
  if (!markdown.startsWith('---')) return undefined
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return undefined
  const frontmatter = markdown.slice(3, end)
  const match = frontmatter.match(/^description:\s*(.+)$/m)
  if (!match) return undefined
  const value = match[1].trim().replace(/^["']|["']$/g, '')
  return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION)}…` : value
}

/** Claude Code slash commands: <dir>/*.md, name = filename. `confine`: see readHead. */
async function scanCommands(dir: string | undefined, source: SkillInfo['source'], confine?: string): Promise<SkillInfo[]> {
  if (!dir) return []
  try {
    const files = await readdir(dir, { withFileTypes: true })
    const skills: SkillInfo[] = []
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const name = file.name.slice(0, -3)
      let description: string | undefined
      try {
        const head = await readHead(join(dir, file.name), confine)
        if (head === undefined) continue
        description = extractDescription(head)
      } catch {
        // unreadable file — list it without a description
      }
      skills.push({ name, description, source, kind: 'command' })
    }
    return skills
  } catch {
    return [] // directory doesn't exist
  }
}

/** Claude Code skills: <dir>/<name>/SKILL.md, name = directory. `confine`: see readHead. */
async function scanSkills(dir: string | undefined, source: SkillInfo['source'], confine?: string): Promise<SkillInfo[]> {
  if (!dir) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skills: SkillInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const markdown = await readHead(join(dir, entry.name, 'SKILL.md'), confine)
        if (markdown === undefined) continue
        skills.push({ name: entry.name, description: extractDescription(markdown), source, kind: 'skill' })
      } catch {
        // no SKILL.md — not a skill directory
      }
    }
    return skills
  } catch {
    return []
  }
}

/**
 * The worktree's `.claude/<sub>` by its real path, or undefined when it is missing or it (or
 * `.claude`) leads outside the worktree: a checkout's `.claude` linked to `/` or another
 * user's home must not make the server read there.
 */
async function projectDir(root: string | undefined, sub: string): Promise<string | undefined> {
  if (!root) return undefined
  const dir = await realpath(join(root, '.claude', sub)).catch(() => undefined)
  return dir && within(root, dir) ? dir : undefined
}

/**
 * The worktree's skills and commands, then the user's (`home`: the server user's home). A
 * project-level definition shadows a user-level one with the same name. The worktree's are
 * confined to it (projectDir, and each file's real path); the user's `~/.claude` is the server
 * user's own and is not. Either way only a regular file's first MAX_SKILL_HEAD bytes are read.
 */
export async function listSkills(worktreePath: string, home: string = homedir()): Promise<SkillInfo[]> {
  const root = await realpath(worktreePath).catch(() => undefined)
  const groups = await Promise.all([
    projectDir(root, 'skills').then((dir) => scanSkills(dir, 'project', root)),
    projectDir(root, 'commands').then((dir) => scanCommands(dir, 'project', root)),
    scanSkills(join(home, '.claude', 'skills'), 'user'),
    scanCommands(join(home, '.claude', 'commands'), 'user')
  ])
  const byName = new Map<string, SkillInfo>()
  for (const skill of groups.flat()) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
