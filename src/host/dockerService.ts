// Docker on the machine this runs on (trek-server's, phase 5a): the container list, a container's
// start, stop or restart, and the Docker tab's docker compose runs in a repository. Electron-free;
// the server checks every argument before it calls these, and nothing here goes through a shell.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ComposeAction, ContainerAction, ContainerInfo, DockerLogEvent } from '../shared/types'

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
  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 10_000 })
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
  await execFileAsync('docker', [action, id], { timeout: 120_000 })
}

/** Long-running: streams the combined output through `onLog`, then resolves the exit code (-1 if docker could not run). */
export function compose(action: ComposeAction, cwd: string, onLog: (event: DockerLogEvent) => void): Promise<number> {
  const args = COMPOSE_ARGS[action]
  return new Promise((resolve) => {
    onLog({ data: `$ docker compose ${args.join(' ')}\n` })
    const child = spawn('docker', ['compose', ...args], { cwd, env: process.env })
    child.stdout.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
    child.stderr.on('data', (chunk: Buffer) => onLog({ data: chunk.toString() }))
    child.on('error', (err) => {
      onLog({ data: `error: ${err.message}\n`, done: true })
      resolve(-1)
    })
    child.on('close', (code) => {
      onLog({ data: `[docker compose exited with code ${code ?? -1}]\n\n`, done: true })
      resolve(code ?? -1)
    })
  })
}
