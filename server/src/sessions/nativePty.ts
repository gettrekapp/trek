// node-pty, loaded on first use rather than at import, so a native addon that will not load
// gives a clear error (`trek-server start` checks it before anything else) instead of a stack
// trace from every command, `--version` included.
//
// node-pty's own loader (lib/utils.js) tries build/Release, build/Debug and
// prebuilds/<platform>-<arch>, each relative to `..` and then `.`, and reports only the last
// error: "Cannot find module './prebuilds/<platform>-<arch>//pty.node'", whatever went wrong at
// the path that exists. explainPtyLoadError loads each pty.node that exists itself, to report
// why it did not load, and on macOS spots Gatekeeper's refusal of a quarantined download.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type * as NodePty from 'node-pty'

// The bundle (CommonJS) has `require`, which resolves node-pty as a plain require there always
// has (the repo's node_modules, the app's app.asar.unpacked, the tarball's node_modules). The
// sources run as ES modules under node --test, where it does not exist; import.meta is never
// read in the bundle (tsc, compiling for CommonJS, objects to import.meta: TS1470).
// @ts-expect-error TS1470
const requireHere: NodeJS.Require = typeof require === 'function' ? require : createRequire(import.meta.url)

let loaded: typeof NodePty | undefined

/** node-pty, or a throw whose message says why it did not load (explainPtyLoadError). */
export function loadNodePty(): typeof NodePty {
  if (loaded) return loaded
  try {
    loaded = requireHere('node-pty') as typeof NodePty
    return loaded
  } catch (err) {
    throw new Error(explainPtyLoadError(err, ptyNodeErrors()))
  }
}

/** Each pty.node node-pty would look for that exists, with the error loading it raises (or null). */
function ptyNodeErrors(): Array<{ path: string; error: string | null }> {
  let root: string
  try {
    root = dirname(requireHere.resolve('node-pty/package.json'))
  } catch {
    return []
  }
  const found: Array<{ path: string; error: string | null }> = []
  for (const d of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    const path = join(root, d, 'pty.node')
    if (!existsSync(path)) continue
    try {
      requireHere(path)
      found.push({ path, error: null })
    } catch (err) {
      found.push({ path, error: (err as Error).message })
    }
  }
  return found
}

/**
 * The message for a node-pty that failed to load: node-pty's own error, why each pty.node that
 * exists did not load, and on macOS, for a quarantined download Gatekeeper refuses, how to clear it.
 */
export function explainPtyLoadError(
  err: unknown,
  natives: Array<{ path: string; error: string | null }>,
  platform: NodeJS.Platform = process.platform
): string {
  // Its first line: node-pty's message ends with the require stack, which says nothing here.
  const first = String((err as Error)?.message ?? err).split('\n')[0]
  const lines = [`node-pty (the native terminal module trek-server needs) did not load: ${first}`]
  if (natives.length === 0) lines.push('No pty.node was found for this platform: node-pty is missing or built for another one.')
  for (const n of natives) lines.push(`${n.path}: ${n.error ?? 'loads on its own'}`)
  const refused = natives.find((n) => n.error && /disallowed by system policy|not valid for use in process|code signature/i.test(n.error))
  if (platform === 'darwin' && refused) {
    // node_modules/node-pty/<build|prebuilds>/<dir>/pty.node → the folder holding node_modules.
    const folder = dirname(dirname(dirname(dirname(dirname(refused.path)))))
    lines.push(
      '',
      'macOS refused to load it. A download carries a quarantine flag that its unpacked files inherit,',
      'and macOS will not load a quarantined native module it cannot verify. If you trust this download,',
      'clear the flag and run trek-server again:',
      '',
      `  xattr -dr com.apple.quarantine '${folder.replace(/'/g, `'\\''`)}'`,
      '',
      '(Downloading with curl or `gh release download` sets no quarantine flag.)'
    )
  }
  return lines.join('\n')
}
