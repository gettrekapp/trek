// Daemon smoke test: throwaway config + temp git repo, then handshake,
// git.listWorktrees, pty spawn/echo/kill, and an auth-rejection check.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const PORT = 17345
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

const work = mkdtempSync(join(tmpdir(), 'trek-daemon-smoke-'))
const repo = join(work, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s'
  }
})

const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({
  tokenHash,
  repos: [{ id: 'smoke', name: 'Smoke', path: repo }]
}))

const daemon = spawn('npx', ['tsx', 'src/index.ts', 'start', '--config', configPath, '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'inherit']
})

let failed = false
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true }
const ok = (msg) => console.log(`ok: ${msg}`)

const cleanup = () => {
  daemon.kill()
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('daemon did not start')), 15000)
  daemon.stdout.on('data', (d) => {
    process.stdout.write(d)
    if (d.toString().includes('listening')) { clearTimeout(timer); resolve() }
  })
  daemon.on('exit', (code) => reject(new Error(`daemon exited early: ${code}`)))
})

// --- authenticated session ---
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
const events = []
const pending = new Map()
let nextId = 1

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.type === 'res') {
    const { resolve } = pending.get(frame.id) ?? {}
    pending.delete(frame.id)
    resolve?.(frame)
  } else if (frame.type === 'event') {
    events.push(frame)
  } else if (frame.type === 'welcome') {
    welcomeResolve(frame)
  }
})

let welcomeResolve
const welcome = new Promise((r) => { welcomeResolve = r })

const req = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ type: 'req', id, method, params }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 10000)
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token, client: 'smoke', clientVersion: '0' }))
const w = await welcome
if (w.repos?.[0]?.path !== repo) fail(`welcome repos: ${JSON.stringify(w.repos)}`)
else ok(`welcome: daemon ${w.daemonVersion}, ${w.repos.length} repo(s)`)

const wt = await req('git.listWorktrees', { repoPath: repo })
if (!wt.ok || wt.result.length !== 1 || !wt.result[0].isMain) fail(`listWorktrees: ${JSON.stringify(wt)}`)
else ok(`listWorktrees: ${wt.result.length} entry, branch ${wt.result[0].branch}`)

const denied = await req('git.listWorktrees', { repoPath: tmpdir() })
if (denied.ok || denied.error.code !== 'PATH_DENIED') fail(`path guard: ${JSON.stringify(denied)}`)
else ok('path guard: PATH_DENIED for out-of-root path')

// pty spawn → echo → kill
const ptyId = '00000000-0000-4000-8000-000000000001'
const spawned = await req('pty.spawn', { ptyId, cwd: repo, command: 'echo SMOKE_PTY_$((40+2))', cols: 80, rows: 24 })
if (!spawned.ok) fail(`pty.spawn: ${JSON.stringify(spawned)}`)

await new Promise((resolve) => {
  const deadline = setTimeout(resolve, 8000)
  const check = setInterval(() => {
    if (events.some((e) => e.event === 'pty.data' && e.payload.data.includes('SMOKE_PTY_42'))) {
      clearTimeout(deadline); clearInterval(check); resolve()
    }
  }, 100)
})
if (!events.some((e) => e.event === 'pty.data' && e.payload.data.includes('SMOKE_PTY_42'))) {
  fail('pty echo output not observed')
} else ok('pty spawn/echo observed')

const list = await req('pty.list', {})
if (!list.ok || list.result.length !== 1) fail(`pty.list: ${JSON.stringify(list)}`)
else ok('pty.list shows the running pty')

// reattach on a second connection: buffer replay should include the echo
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((r) => ws2.on('open', r))
const ws2frames = []
ws2.on('message', (raw) => ws2frames.push(JSON.parse(raw.toString())))
ws2.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token, client: 'smoke2', clientVersion: '0' }))
await new Promise((r) => setTimeout(r, 500))
ws2.send(JSON.stringify({ type: 'req', id: 1, method: 'pty.attach', params: { ptyId } }))
await new Promise((r) => setTimeout(r, 1000))
const replayed = ws2frames.some((f) => f.type === 'event' && f.event === 'pty.data' && f.payload.replay && f.payload.data.includes('SMOKE_PTY_42'))
if (!replayed) fail(`reattach replay missing echo: ${JSON.stringify(ws2frames.filter(f => f.type === 'event').length)} events`)
else ok('reattach replays ring buffer with replay flag')
ws2.close()

const killed = await req('pty.kill', { ptyId })
if (!killed.ok) fail(`pty.kill: ${JSON.stringify(killed)}`)
else ok('pty.kill')

ws.close()

// --- bad token rejected ---
const badWs = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((r) => badWs.on('open', r))
badWs.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'wrong', client: 'smoke', clientVersion: '0' }))
const closeCode = await new Promise((r) => badWs.on('close', (code) => r(code)))
if (closeCode !== 4003) fail(`bad token close code: ${closeCode}`)
else ok('bad token rejected with 4003')

console.log(failed ? 'DAEMON SMOKE FAIL' : 'DAEMON SMOKE PASS')
process.exit(failed ? 1 : 0)
