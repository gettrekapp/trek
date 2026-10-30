// Electron-free: shared by the Electron main process and the remote daemon.
import * as pty from 'node-pty'
import type { PtySpawnOptions } from '../shared/types'

export interface PtyCallbacks {
  onData(data: string): void
  onExit(exitCode: number): void
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export class PtyService {
  private sessions = new Map<string, pty.IPty>()

  spawn(opts: PtySpawnOptions, callbacks: PtyCallbacks): void {
    const shell = defaultShell()
    const args = process.platform === 'win32' ? [] : ['-il']

    const session = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: { ...process.env, ...opts.env } as Record<string, string>
    })

    this.sessions.set(opts.id, session)

    if (opts.command) {
      // Give the shell a moment to initialize before typing the command.
      setTimeout(() => session.write(`${opts.command}\r`), 300)
    }

    session.onData((data) => callbacks.onData(data))

    session.onExit(({ exitCode }) => {
      this.sessions.delete(opts.id)
      callbacks.onExit(exitCode)
    })
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(id)?.resize(cols, rows)
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      this.sessions.delete(id)
      session.kill()
    }
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  pause(id: string): void {
    this.sessions.get(id)?.pause()
  }

  resume(id: string): void {
    this.sessions.get(id)?.resume()
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }
}
