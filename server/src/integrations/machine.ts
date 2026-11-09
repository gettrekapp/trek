// The server's machine services (phase 5a): the environments' registry and the dev stacks' logs
// and pids live in the server's data dir, next to its projects.
import { join } from 'node:path'
import { createEnvironmentService } from '../../../src/host/environmentService.ts'
import { createStackService } from '../../../src/host/stackService.ts'
import type { Machine } from './machineHandlers.ts'

/** `<dataDir>/environments.json`: each twb- VM's repository, branch and worktree */
export const ENV_REGISTRY_FILE = 'environments.json'
/** `<dataDir>/stacks`: each dev stack's log and its `stack.sh up` pid */
export const STACKS_DIR = 'stacks'

export function createMachine(dataDir: string): Machine {
  return {
    env: createEnvironmentService({ registryFile: join(dataDir, ENV_REGISTRY_FILE) }),
    stacks: createStackService({ stateDir: join(dataDir, STACKS_DIR) })
  }
}
