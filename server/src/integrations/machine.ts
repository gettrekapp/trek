// The server's machine services (phase 5a): the dev stacks' logs and pids live in the server's data
// dir, next to its projects. (The Colima environments are the env plugin's since plugins E2.)
import { join } from 'node:path'
import { createStackService } from '../../../src/host/stackService.ts'
import type { Machine } from './machineHandlers.ts'

/** `<dataDir>/stacks`: each dev stack's log and its `stack.sh up` pid */
export const STACKS_DIR = 'stacks'

export function createMachine(dataDir: string): Machine {
  return { stacks: createStackService({ stateDir: join(dataDir, STACKS_DIR) }) }
}
