import { execFile } from 'node:child_process'

/**
 * GUI-launched macOS apps inherit a minimal PATH (/usr/bin:/bin:...), so
 * spawned tools like docker, git, and code are ENOENT in packaged builds.
 * Resolve the user's real PATH from their login shell once at startup and
 * patch process.env — every later spawn (ptys, git, docker) inherits it.
 */
export async function fixPath(): Promise<void> {
  if (process.platform === 'win32') return

  const merge = (base: string): string => {
    const parts = base.split(':').filter(Boolean)
    for (const dir of ['/usr/local/bin', '/opt/homebrew/bin']) {
      if (!parts.includes(dir)) parts.push(dir)
    }
    return parts.join(':')
  }

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        shell,
        ['-ilc', 'printf "__PATH_START__%s__PATH_END__" "$PATH"'],
        { timeout: 5000 },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    })
    // Markers guard against shell profiles that print their own output.
    const match = stdout.match(/__PATH_START__(.*)__PATH_END__/s)
    if (match && match[1].length > 0) {
      process.env.PATH = merge(match[1])
      return
    }
  } catch {
    // login shell failed or timed out — fall through to the static merge
  }
  process.env.PATH = merge(process.env.PATH ?? '')
}
