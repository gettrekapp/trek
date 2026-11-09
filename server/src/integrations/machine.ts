// The server's machine services (phase 5a): the environments' registry and the dev stacks' logs
// and pids live in the server's data dir, next to its projects.
import { readdirSync, type Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LOCAL_PROFILE_NAME_RE } from '../../../src/shared/localServer.ts'
import { createEnvironmentService } from '../../../src/host/environmentService.ts'
import { createStackService } from '../../../src/host/stackService.ts'
import type { Machine } from './machineHandlers.ts'

/** `<dataDir>/environments.json`: each twb- VM's repository, branch and worktree */
export const ENV_REGISTRY_FILE = 'environments.json'
/** `<dataDir>/stacks`: each dev stack's log and its `stack.sh up` pid */
export const STACKS_DIR = 'stacks'

/**
 * The other Local profiles' registries: `<parent>/local` and `<parent>/local-<name>` beside a Local
 * server's own data dir (`<platform data dir>/local…`), not its own. Each Local profile took its own
 * snapshot of the app's registry (Decision 16), so a VM the installed app or a dev build created
 * since is in only one of them; read only, so it never shows as the other's orphan to delete.
 */
export function localSiblingRegistries(dataDir: string): string[] {
  const parent = dirname(dataDir)
  const own = basename(dataDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== own && (e.name === 'local' || (e.name.startsWith('local-') && LOCAL_PROFILE_NAME_RE.test(e.name.slice(6)))))
    .map((e) => join(parent, e.name, ENV_REGISTRY_FILE))
}

/** `local`: a Local server (`start --local`), which also reads its sibling profiles' registries. */
export function createMachine(dataDir: string, options: { local?: boolean } = {}): Machine {
  return {
    env: createEnvironmentService({
      registryFile: join(dataDir, ENV_REGISTRY_FILE),
      ...(options.local ? { otherRegistryFiles: () => localSiblingRegistries(dataDir) } : {})
    }),
    stacks: createStackService({ stateDir: join(dataDir, STACKS_DIR) })
  }
}
