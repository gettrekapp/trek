// The server's machine services (phase 5a): the environments' registry and the dev stacks' logs
// and pids live in the server's data dir, next to its projects.
import { join } from 'node:path'
import { createEnvironmentService } from '../../../src/host/environmentService.ts'
import { createStackService } from '../../../src/host/stackService.ts'
import type { Machine } from './machineHandlers.ts'
import { localSiblingDataDirs } from '../plugins/siblings.ts'

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
  return localSiblingDataDirs(dataDir).map((dir) => join(dir, ENV_REGISTRY_FILE))
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
