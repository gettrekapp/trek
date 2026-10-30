import { ipcMain } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ContainerAction, ContainerInfo } from '../shared/types'

const execFileAsync = promisify(execFile)

const CONTAINER_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart']

export function registerDockerHandlers(): void {
  ipcMain.handle('docker:list', async (): Promise<ContainerInfo[]> => {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--format', '{{json .}}'],
      { timeout: 10_000 }
    )
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
  })

  ipcMain.handle(
    'docker:container',
    async (_event, action: ContainerAction, id: string): Promise<void> => {
      if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`)
      await execFileAsync('docker', [action, id], { timeout: 120_000 })
    }
  )

  // Long-running; streams combined output to the renderer as docker:log events.
  ipcMain.handle(
    'docker:compose',
    (event, args: string[], cwd: string): Promise<number> => {
      return new Promise((resolve) => {
        const send = (data: string, done = false): void => {
          if (!event.sender.isDestroyed()) event.sender.send('docker:log', { data, done })
        }
        send(`$ docker compose ${args.join(' ')}\n`)
        const child = spawn('docker', ['compose', ...args], { cwd, env: process.env })
        child.stdout.on('data', (chunk: Buffer) => send(chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => send(chunk.toString()))
        child.on('error', (err) => {
          send(`error: ${err.message}\n`, true)
          resolve(-1)
        })
        child.on('close', (code) => {
          send(`[docker compose exited with code ${code ?? -1}]\n\n`, true)
          resolve(code ?? -1)
        })
      })
    }
  )
}
