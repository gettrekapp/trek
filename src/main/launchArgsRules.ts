// The .trekproj files a launch asks to open, pure. macOS hands them over as `open-file` events;
// Linux (and Windows) put them in argv: the first launch's own, or a second launch's, which the
// single-instance lock passes to the running app (index.ts).
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The existing `.trekproj` files named in `argv` (argv[0], the executable, is never one), as
 * absolute paths in argv order, each once. Flags (`-…`) are skipped; a relative path is resolved
 * against `cwd`, the launch's working directory, and normalised; a `file://` URL is turned into its
 * path, and dropped if it is not a valid file path.
 */
export function trekprojArgs(argv: readonly string[], cwd: string, isFile: (path: string) => boolean): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    let path: string
    if (arg.startsWith('file://')) {
      try {
        path = fileURLToPath(arg)
      } catch {
        continue
      }
    } else {
      path = resolve(cwd, arg)
    }
    if (!path.toLowerCase().endsWith('.trekproj') || out.includes(path) || !isFile(path)) continue
    out.push(path)
  }
  return out
}
