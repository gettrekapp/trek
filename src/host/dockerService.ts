// Docker on the machine this runs on (trek-server's, phase 5a): the container list, a container's
// start, stop or restart, and the Docker tab's docker compose runs in a repository. Electron-free;
// the server checks every argument before it calls these, and nothing here goes through a shell.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ComposeAction, ContainerAction, ContainerInfo, DockerLogEvent } from '../shared/types'
import { hidden } from './childOptions.ts'
import { commandPath } from './commandPath.ts'

const execFileAsync = promisify(execFile)

export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart']

/** Each compose action's arguments: a client names the action, never the arguments. */
export const COMPOSE_ARGS: Readonly<Record<ComposeAction, readonly string[]>> = {
  up: ['up', '-d'],
  upBuild: ['up', '--build', '-d'],
  restart: ['restart'],
  stop: ['stop'],
  down: ['down'],
  pull: ['pull']
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const { stdout } = await execFileAsync(commandPath('docker'), ['ps', '-a', '--format', '{{json .}}'], hidden({ timeout: 10_000 }))
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line) as Record<string, string>
      return {
        id: raw.ID,
        name: raw.Names,
        image: raw.Image,
        state: raw.State,
        status: raw.Status,
        ports: raw.Ports ?? ''
      }
    })
}

/** `id` must already be a container id or name (the server's `requireContainerId`). */
export async function containerAction(action: ContainerAction, id: string): Promise<void> {
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`)
  await execFileAsync(commandPath('docker'), [action, id], hidden({ timeout: 120_000 }))
}

/** Long-running: streams the combined output through `onLog`, then resolves the exit code (-1 if docker could not run). */
export function compose(action: ComposeAction, cwd: string, onLog: (event: DockerLogEvent) => void): Promise<number> {
  const args = COMPOSE_ARGS[action]
  return new Promise((resolve) => {
    onLog({ data: `$ docker compose ${args.join(' ')}\n` })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(commandPath('docker'), ['compose', ...args], hidden({ cwd, env: process.env }))
    } catch (err) {
      // Windows: docker is not on PATH (commandPath never falls back to the cwd).
      onLog({ data: `error: ${(err as Error).message}\n`, done: true })
      resolve(-1)
      return
    }
    child.stdout!.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
    child.stderr!.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
    // A spawn that fails reports error and then close: one done event, the first.
    let settled = false
    const finish = (data: string, code: number): void => {
      if (settled) return
      settled = true
      onLog({ data, done: true })
      resolve(code)
    }
    child.on('error', (err) => finish(`error: ${err.message}\n`, -1))
    child.on('close', (code) => finish(`[docker compose exited with code ${code ?? -1}]\n\n`, code ?? -1))
  })
}
