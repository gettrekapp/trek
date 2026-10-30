import { ipcMain } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillInfo } from '../shared/types'

const MAX_DESCRIPTION = 120

/** Pulls `description:` out of YAML frontmatter, if present. */
function extractDescription(markdown: string): string | undefined {
  if (!markdown.startsWith('---')) return undefined
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return undefined
  const frontmatter = markdown.slice(3, end)
  const match = frontmatter.match(/^description:\s*(.+)$/m)
  if (!match) return undefined
  const value = match[1].trim().replace(/^["']|["']$/g, '')
  return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION)}…` : value
}

/** Claude Code slash commands: <dir>/*.md, name = filename. */
async function scanCommands(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  try {
    const files = await readdir(dir, { withFileTypes: true })
    const skills: SkillInfo[] = []
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const name = file.name.slice(0, -3)
      let description: string | undefined
      try {
        description = extractDescription(await readFile(join(dir, file.name), 'utf8'))
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

/** Claude Code skills: <dir>/<name>/SKILL.md, name = directory. */
async function scanSkills(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skills: SkillInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const markdown = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8')
        skills.push({
          name: entry.name,
          description: extractDescription(markdown),
          source,
          kind: 'skill'
        })
      } catch {
        // no SKILL.md — not a skill directory
      }
    }
    return skills
  } catch {
    return []
  }
}

export function registerSkillHandlers(): void {
  ipcMain.handle('skills:list', async (_event, worktreePath: string): Promise<SkillInfo[]> => {
    const home = homedir()
    const groups = await Promise.all([
      scanSkills(join(worktreePath, '.claude', 'skills'), 'project'),
      scanCommands(join(worktreePath, '.claude', 'commands'), 'project'),
      scanSkills(join(home, '.claude', 'skills'), 'user'),
      scanCommands(join(home, '.claude', 'commands'), 'user')
    ])
    // Project-level definitions shadow user-level ones with the same name.
    const byName = new Map<string, SkillInfo>()
    for (const skill of groups.flat()) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
    return [...byName.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
    )
  })
}
