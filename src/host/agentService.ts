// Electron-free: shared by the Electron main process and the remote daemon.
import { execFile } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSessionMeta } from '../shared/providers/codex.ts'
import { shellQuote } from '../shared/providers/shell.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** Clock skew allowed between Trek's launch time and Codex's own timestamp. */
const SKEW_MS = 2000

async function firstLine(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]
  } finally {
    await file.close()
  }
}

/** Codex files sessions under <root>/YYYY/MM/DD/; scan the days around the launch. */
function dayDirs(root: string, since: number, now: number): string[] {
  const dirs = new Set<string>()
  for (let t = since - DAY_MS; t <= now + DAY_MS; t += DAY_MS) {
    const d = new Date(t)
    for (const [y, m, day] of [
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    ]) {
      dirs.add(join(root, String(y), String(m).padStart(2, '0'), String(day).padStart(2, '0')))
    }
  }
  return [...dirs]
}

/**
 * The id of the Codex session a tab launched `ageMs` ago in `cwd` created: the earliest
 * rollout in that cwd that started after the launch and isn't claimed by another tab.
 * Taking an age rather than a timestamp keeps the comparison on this host's clock, which
 * may differ from the caller's (remote servers).
 */
export async function discoverCodexSession(
  cwd: string,
  ageMs: number,
  exclude: string[],
  root = join(homedir(), '.codex', 'sessions'),
  now = Date.now()
): Promise<string | undefined> {
  const since = now - ageMs
  const candidates: { id: string; startedAt: number }[] = []
  for (const dir of dayDirs(root, since, now)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      try {
        const meta = parseCodexSessionMeta(await firstLine(join(dir, name)))
        if (meta && meta.cwd === cwd && meta.startedAt >= since - SKEW_MS && !exclude.includes(meta.id)) {
          candidates.push(meta)
        }
      } catch {
        // unreadable or mid-write — try again on the next poll
      }
    }
  }
  candidates.sort((a, b) => a.startedAt - b.startedAt)
  return candidates[0]?.id
}

/** Whether `command` resolves in the user's login shell. */
export function commandExists(command: string): Promise<boolean> {
  const shell = process.env.SHELL || '/bin/sh'
  return new Promise((resolve) => {
    execFile(shell, ['-lc', `command -v ${shellQuote(command)}`], { timeout: 10_000 }, (err) =>
      resolve(!err)
    )
  })
}
