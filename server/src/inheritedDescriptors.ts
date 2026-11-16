// Linux: the sockets and pipes `start --local` inherited from the Trek app that spawned it.
//
// Node opens everything close-on-exec, but Electron's browser process can hold sockets and pipes
// that are not (Chromium's). On macOS libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT, so a child
// gets only its stdio; on Linux it forks and execs, so the Local server, which outlives the app,
// kept any such descriptor open, and handed it on to its agents. Seen as: on Linux, after a quit
// that left running a Local server the app had started, the stdout and stderr Trek was started
// with stayed open (the smokes' app.close() waited on them until the Local server stopped).
import { closeSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'

/** O_CLOEXEC, as /proc/<pid>/fdinfo/<fd> shows it in `flags:` (octal) */
const O_CLOEXEC = 0o2000000

/** What closeInheritedDescriptors uses of node:fs (the tests' stand-in) */
export interface InheritedFs {
  readdirSync(dir: string): string[]
  readlinkSync(path: string): string
  readFileSync(path: string, encoding: 'utf8'): string
  closeSync(fd: number): void
}

/**
 * Whether a descriptor above stderr was inherited, from its /proc/self/fd link and its fdinfo:
 * a socket or a pipe without close-on-exec. Node's own are close-on-exec, and a file or a
 * terminal is left alone. An fdinfo with no flags line counts as not inherited.
 */
export function isInheritedDescriptor(link: string, fdinfo: string): boolean {
  if (!/^(socket|pipe):\[\d+\]$/.test(link)) return false
  const flags = /^flags:\s*([0-7]+)\s*$/m.exec(fdinfo)
  if (!flags) return false
  return (parseInt(flags[1], 8) & O_CLOEXEC) === 0
}

const REAL_FS: InheritedFs = { readdirSync, readlinkSync, readFileSync, closeSync }

/**
 * Linux: closes the sockets and pipes above stderr that this process inherited (see
 * isInheritedDescriptor). Only for `start --local`: the app hands it nothing but stdin, stdout
 * and stderr. Returns each one it closed, as `<fd> <link>`. Never throws; elsewhere it does nothing.
 */
export function closeInheritedDescriptors(platform: NodeJS.Platform = process.platform, fs: InheritedFs = REAL_FS): string[] {
  if (platform !== 'linux') return []
  let names: string[]
  try {
    names = fs.readdirSync('/proc/self/fd')
  } catch {
    return []
  }
  const closed: string[] = []
  for (const name of names) {
    const fd = Number(name)
    if (!Number.isInteger(fd) || fd <= 2) continue
    try {
      const link = fs.readlinkSync(`/proc/self/fd/${fd}`)
      if (!isInheritedDescriptor(link, fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))) continue
      fs.closeSync(fd)
      closed.push(`${fd} ${link}`)
    } catch {
      // Gone meanwhile (the listing's own descriptor): nothing to close.
    }
  }
  return closed
}
