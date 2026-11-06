// trek-server smoke test: throwaway config + temp git repo, then handshake,
// git.listWorktrees, pty spawn/echo/kill, the projects flow (create, branch
// note, persist, delete) and an auth-rejection check.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { applyStatePatch } from '../../src/shared/sync/topicState.ts'

const PORT = 17345
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

const work = mkdtempSync(join(tmpdir(), 'trek-server-smoke-'))
const repo = join(work, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s'
  }
})

const configPath = join(work, 'config.json')
// A fake agent: prints its args, lingers briefly, exits 7.
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nsleep 1\nexit 7\n', { mode: 0o755 })
// A second fake agent for the status section (the local provider's command): prints the
// done marker, goes quiet for 4 s, rings the bell, then lingers.
const statusAgent = join(work, 'status-agent.sh')
writeFileSync(statusAgent, '#!/bin/sh\nprintf "working (esc to interrupt)\\n"\nsleep 4\nprintf "\\a"\nsleep 30\n', { mode: 0o755 })
writeFileSync(configPath, JSON.stringify({
  llm: { providers: { claude: { command: fakeAgent }, local: { command: statusAgent } } },
  tokenHash,
  repos: [{ id: 'smoke', name: 'Smoke', path: repo }]
}))

// `--built` runs the bundled CLI (npm run build) instead of the TypeScript source.
const [cmd, cmdPrefix] = process.argv.includes('--built')
  ? [process.execPath, ['dist/trek-server.cjs']]
  : ['npx', ['tsx', 'src/index.ts']]
const serverDir = new URL('..', import.meta.url).pathname
const cli = (...args) =>
  execFileSync(cmd, [...cmdPrefix, ...args, '--config', configPath], { cwd: serverDir, encoding: 'utf8' })
const daemon = spawn(cmd, [...cmdPrefix, 'start', '--config', configPath, '--port', String(PORT), '--data-dir', join(work, 'data')], {
  cwd: serverDir,
  stdio: ['ignore', 'pipe', 'pipe']
})
// Forwarded, and kept so checks can wait for a server-side log line.
let daemonStderr = ''
daemon.stderr.on('data', (d) => {
  process.stderr.write(d)
  daemonStderr += d.toString()
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

const proto = await req('constructor', {})
if (proto.ok || proto.error.code !== 'NOT_FOUND') fail(`prototype-named method: ${JSON.stringify(proto)}`)
else ok('v1 unknown prototype-named method is NOT_FOUND')

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

// --- protocol v2 ---
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s'
}
const mkRepo = (path) => { execFileSync('git', ['init', '-q', '-b', 'main', path], { env: gitEnv }); return path }

/** A connection that records frames; `req` resolves with the res frame. */
async function connect(protocolVersion, tok) {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const frames = []
  const waiting = new Map()
  let id = 1
  sock.on('message', (raw) => {
    const f = JSON.parse(raw.toString())
    frames.push(f)
    if (f.type === 'res') { waiting.get(f.id)?.(f); waiting.delete(f.id) }
  })
  await new Promise((r) => sock.on('open', r))
  sock.send(JSON.stringify({ type: 'hello', protocolVersion, token: tok, client: 'smoke-v2', clientVersion: '0' }))
  const closed = new Promise((r) => sock.on('close', (code) => r(code)))
  await new Promise((r) => setTimeout(r, 300))
  return {
    sock, frames, closed,
    welcome: frames.find((f) => f.type === 'welcome'),
    req: (method, params) => new Promise((resolve, reject) => {
      const n = id++
      waiting.set(n, resolve)
      sock.send(JSON.stringify({ type: 'req', id: n, method, params }))
      setTimeout(() => { if (waiting.has(n)) reject(new Error(`timeout: ${method}`)) }, 10000)
    })
  }
}

/** Waits for the next state.patch on `topic` past `state.rev` and applies it. */
async function nextPatch(conn, topic, state, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const patch = conn.frames.find((f) => f.type === 'event' && f.event === 'state.patch' &&
      f.payload.topic === topic && f.payload.rev === state.rev + 1)
    if (patch) {
      const outcome = applyStatePatch(state, patch.payload)
      if (outcome.kind !== 'applied') throw new Error(`patch did not apply: ${outcome.kind}`)
      return outcome.state
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no patch for ${topic} after rev ${state.rev}`)
}

const v2 = await connect(2, token)
if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serverId ?? '')) {
  fail(`v2 welcome: ${JSON.stringify(v2.welcome)}`)
} else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}`)

const subbed = await v2.req('sub.subscribe', { topic: 'server' })
let serverState = subbed.result
if (!subbed.ok || serverState.snapshot.repos.length !== 1 || serverState.snapshot.repos[0].path !== repo) {
  fail(`subscribe server: ${JSON.stringify(subbed)}`)
} else ok('subscribe server: snapshot lists the configured repo')

const repo2 = mkRepo(join(work, 'repo2'))
const added = await v2.req('server.addRepo', { path: repo2 })
if (!added.ok || added.result.repoId !== 'repo2') fail(`server.addRepo: ${JSON.stringify(added)}`)
serverState = await nextPatch(v2, 'server', serverState)
if (serverState.snapshot.repos.length !== 2) fail(`after addRepo: ${JSON.stringify(serverState.snapshot.repos)}`)
else ok('server.addRepo: registered and patched')

const outside = mkRepo(mkdtempSync(join(tmpdir(), 'trek-server-outside-')))
const deniedAdd = await v2.req('server.addRepo', { path: outside })
rmSync(outside, { recursive: true, force: true })
if (deniedAdd.ok || deniedAdd.error.code !== 'PATH_DENIED') fail(`addRepo outside: ${JSON.stringify(deniedAdd)}`)
else ok('server.addRepo: PATH_DENIED outside the allowed roots')

mkdirSync(join(work, 'plain'))
const notRepo = await v2.req('server.addRepo', { path: join(work, 'plain') })
if (notRepo.ok || notRepo.error.code !== 'NOT_A_REPO') fail(`addRepo plain dir: ${JSON.stringify(notRepo)}`)
else ok('server.addRepo: NOT_A_REPO for a plain directory')

const repo3 = mkRepo(join(work, 'repo3'))
cli('add', repo3)
serverState = await nextPatch(v2, 'server', serverState)
if (!serverState.snapshot.repos.some((r) => r.path === realpathSync(repo3))) fail('CLI add not picked up: ' + JSON.stringify(serverState.snapshot.repos))
else ok('CLI add on a running server: picked up without a restart')

const removed = await v2.req('server.removeRepo', { repoId: 'repo2' })
if (!removed.ok) fail(`server.removeRepo: ${JSON.stringify(removed)}`)
serverState = await nextPatch(v2, 'server', serverState)
if (serverState.snapshot.repos.some((r) => r.id === 'repo2')) fail('removeRepo not reflected')
else ok('server.removeRepo: removed and patched')

const phoneToken = /^ {2}(\S+)$/m.exec(cli('token', 'add', 'phone'))?.[1]
// The running server reloads the config file asynchronously; retry until it knows the token.
let phone = await connect(2, phoneToken)
for (let attempt = 0; attempt < 10 && phone.welcome?.protocolVersion !== 2; attempt++) {
  await new Promise((r) => setTimeout(r, 300))
  phone = await connect(2, phoneToken)
}
if (phone.welcome?.protocolVersion !== 2) fail(`named token login: ${JSON.stringify(phone.frames)}`)
else ok('named token "phone" authenticates')
cli('token', 'revoke', 'phone')
const revokedCode = await Promise.race([phone.closed, new Promise((r) => setTimeout(() => r('open'), 4000))])
if (revokedCode !== 4003) fail(`revoked token connection: ${revokedCode}`)
else ok('token revoke closes its live connection with 4003')

// --- v2 transport edge cases ---
/** A raw socket that records frames and its close code; sends nothing by itself. */
async function rawSocket() {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const frames = []
  sock.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  const closed = new Promise((r) => sock.on('close', (code) => r(code)))
  await new Promise((r) => sock.on('open', r))
  return { sock, frames, closed }
}
const hello2 = (tok) => JSON.stringify({ type: 'hello', protocolVersion: 2, token: tok, client: 'smoke-v2', clientVersion: '0' })
const raceTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))])
const waitFor = async (pred, ms = 4000) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  return pred()
}

// The sub.subscribe response must precede the patches it registered for, even
// when a mutation is pipelined right behind it.
for (const [label, corked] of [['back-to-back sends', false], ['one TCP write', true]]) {
  const conn = await connect(2, token)
  const fresh = mkRepo(join(work, `order-${corked ? 'corked' : 'plain'}`))
  const subFrame = JSON.stringify({ type: 'req', id: 1, method: 'sub.subscribe', params: { topic: 'server' } })
  const addFrame = JSON.stringify({ type: 'req', id: 2, method: 'server.addRepo', params: { path: fresh } })
  if (corked) conn.sock._socket.cork()
  conn.sock.send(subFrame)
  conn.sock.send(addFrame)
  if (corked) process.nextTick(() => conn.sock._socket.uncork())
  const isPatch = (f) => f.type === 'event' && f.event === 'state.patch' && f.payload.topic === 'server'
  await waitFor(() => conn.frames.some((f) => f.type === 'res' && f.id === 2) && conn.frames.some(isPatch))
  const resIndex = conn.frames.findIndex((f) => f.type === 'res' && f.id === 1)
  const patchIndex = conn.frames.findIndex(isPatch)
  const order = conn.frames.map((f) => (f.type === 'res' ? `res${f.id}` : f.event ?? f.type)).join(', ')
  if (resIndex === -1 || patchIndex === -1 || resIndex > patchIndex) fail(`subscribe ordering (${label}): ${order}`)
  else ok(`sub.subscribe res precedes the pipelined patch (${label})`)
  conn.sock.close()
}

// Frames a revoked socket sends after the server closed it are ignored.
const phone2Token = /^ {2}(\S+)$/m.exec(cli('token', 'add', 'phone2'))?.[1]
let phone2 = await connect(2, phone2Token)
for (let attempt = 0; attempt < 10 && phone2.welcome?.protocolVersion !== 2; attempt++) {
  await new Promise((r) => setTimeout(r, 300))
  phone2 = await connect(2, phone2Token)
}
if (phone2.welcome?.protocolVersion !== 2) fail(`phone2 login: ${JSON.stringify(phone2.frames)}`)
// Stop reading, so the client does not see the server's close and keeps sending.
phone2.sock._socket.pause()
const revokedBefore = daemonStderr.split('token revoked').length
cli('token', 'revoke', 'phone2')
if (!(await waitFor(() => daemonStderr.split('token revoked').length > revokedBefore))) {
  fail('server did not log the phone2 revocation')
}
phone2.sock.send(JSON.stringify({ type: 'req', id: 99, method: 'server.removeRepo', params: { repoId: 'repo3' } }))
await new Promise((r) => setTimeout(r, 300))
phone2.sock._socket.resume()
await raceTimeout(phone2.closed, 4000)
const checker = await connect(2, token)
const snap = await checker.req('sub.subscribe', { topic: 'server' })
if (!snap.ok || !snap.result.snapshot.repos.some((r) => r.id === 'repo3')) {
  fail(`revoked socket removed a repo: ${JSON.stringify(snap)}`)
} else ok('frames from a revoked socket are ignored (repo3 still registered)')
if (phone2.frames.some((f) => f.type === 'res' && f.id === 99)) fail('revoked socket got a response')
checker.sock.close()

// Malformed frames close the socket with 1002 and do not crash the server.
for (const bad of ['null', '"x"', '[]', JSON.stringify({ type: 'hello', protocolVersion: 2, token: 5 }),
  JSON.stringify({ type: 'hello', protocolVersion: '2', token: 'TOKEN' })]) {
  const conn = await rawSocket()
  conn.sock.send(bad)
  const code = await raceTimeout(conn.closed, 4000)
  if (code !== 1002) fail(`malformed frame ${bad}: close ${code}`)
  else ok(`malformed frame ${bad} closes with 1002`)
}
{
  const conn = await connect(2, token)
  conn.sock.send(JSON.stringify({ type: 'req', id: 'one', method: 'sys.ping', params: {} }))
  const code = await raceTimeout(conn.closed, 4000)
  if (code !== 1002) fail(`req with a non-numeric id: close ${code}`)
  else ok('req with a non-numeric id closes with 1002')
}
const alive = await connect(2, token)
if (alive.welcome?.protocolVersion !== 2) fail(`server after malformed frames: ${JSON.stringify(alive.frames)}`)
else ok('server still answers a v2 hello after malformed frames')
alive.sock.close()

// After a rejected hello, a pipelined good hello is ignored.
{
  const conn = await rawSocket()
  conn.sock.send(hello2('wrong'))
  conn.sock.send(hello2(token))
  const code = await raceTimeout(conn.closed, 4000)
  if (code !== 4003 || conn.frames.some((f) => f.type === 'welcome')) {
    fail(`hello after a bad token: close ${code}, frames ${JSON.stringify(conn.frames)}`)
  } else ok('a good hello pipelined after a bad one is ignored; closed with 4003')
}

// An empty token in hello falls back to the Authorization header.
{
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${token}` } })
  const frames = []
  sock.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  await new Promise((r) => sock.on('open', r))
  sock.send(hello2(''))
  await waitFor(() => frames.length > 0, 2000)
  if (frames[0]?.type !== 'welcome') fail(`empty frame token with a header token: ${JSON.stringify(frames)}`)
  else ok('an empty hello token falls back to the Authorization header')
  sock.close()
}

v2.sock.close()

// --- projects ---
const pc = await connect(2, token)
let srv = (await pc.req('sub.subscribe', { topic: 'server' })).result
const created = await pc.req('project.create', { name: 'Smoke', repositories: [{ path: realpathSync(repo) }] })
if (!created.ok) fail(`project.create: ${JSON.stringify(created)}`)
const projectId = created.result.projectId
srv = await nextPatch(pc, 'server', srv)
if (!srv.snapshot.projects.some((p) => p.id === projectId)) fail('server topic lacks the new project')
else ok('project.create: listed in the server topic')

let proj = (await pc.req('sub.subscribe', { topic: `project:${projectId}` })).result
const repoId = proj.snapshot.repositories[0].id
const noted = await pc.req('branch.setNote', { projectId, repoId, branch: 'main', note: 'from smoke' })
if (!noted.ok) fail(`branch.setNote: ${JSON.stringify(noted)}`)
proj = await nextPatch(pc, `project:${projectId}`, proj)
if (proj.snapshot.repositories[0].branchData.main?.note !== 'from smoke') fail('branch.setNote not patched')
else ok('branch.setNote: patched into the project topic')

// --- worktrees ---
// The poller also patches the project topic, so apply patches until `cond` holds (bounded).
const projWorktrees = () => proj.snapshot.repositories[0].worktrees
const patchUntil = async (cond, max = 15, patchMs = 2000) => {
  for (let i = 0; i < max && !cond(); i++) {
    try { proj = await nextPatch(pc, `project:${projectId}`, proj, patchMs) } catch { break }
  }
  return cond()
}

const wtCreated = await pc.req('worktree.create', { projectId, repoId, branch: 'smoke-wt', createBranch: true })
if (!wtCreated.ok) fail(`worktree.create: ${JSON.stringify(wtCreated)}`)
const wtId = wtCreated.result?.worktreeId
await patchUntil(() => projWorktrees().some((w) => w.id === wtId))
const wtRow = projWorktrees().find((w) => w.id === wtId)
if (!wtRow || wtRow.branch !== 'smoke-wt' || !existsSync(wtRow.path)) fail(`worktree.create row: ${JSON.stringify(wtRow)}`)
else ok('worktree.create: created on disk and patched into the project topic')

await patchUntil(() => { const m = projWorktrees().find((w) => w.isMain); return m?.branch === 'main' && !!m.head })
const mainRow = projWorktrees().find((w) => w.isMain)
if (mainRow?.branch !== 'main' || !mainRow.head) fail(`poller did not fill the main worktree: ${JSON.stringify(mainRow)}`)
else ok('git poller: main worktree has branch and head')

const wtChanges = await pc.req('worktree.changes', { projectId, worktreeId: wtId })
if (!wtChanges.ok || !Array.isArray(wtChanges.result.files)) fail(`worktree.changes: ${JSON.stringify(wtChanges)}`)
else ok('worktree.changes answers')

const wtRemoved = await pc.req('worktree.remove', { projectId, worktreeId: wtId })
if (!wtRemoved.ok || existsSync(wtRow?.path ?? '')) fail(`worktree.remove: ${JSON.stringify(wtRemoved)}`)
await patchUntil(() => !projWorktrees().some((w) => w.id === wtId))
if (projWorktrees().some((w) => w.id === wtId)) fail('removed worktree still in the project topic')
else ok('worktree.remove: removed from disk and the project topic')

// --- sessions (fake agent) ---
{
  const mainWt = () => projWorktrees().find((w) => w.isMain)
  const mainId = mainRow?.id
  const sessionOf = (sid) => mainWt()?.sessions.find((s) => s.id === sid)
  const ptyText = (id) => pc.frames
    .filter((f) => f.type === 'event' && f.event === 'pty.data' && f.payload.ptyId === id)
    .map((f) => f.payload.data).join('')

  const started = await pc.req('session.start', { projectId, worktreeId: mainId, cols: 80, rows: 24 })
  if (!started.ok || !started.result?.sessionId || !started.result?.ptyId) fail(`session.start: ${JSON.stringify(started)}`)
  else {
    const { sessionId, ptyId: agentPty } = started.result
    ok('session.start: returned a sessionId and ptyId')

    const attached = await pc.req('pty.attach', { ptyId: agentPty })
    if (!attached.ok) fail(`pty.attach: ${JSON.stringify(attached)}`)
    const sawArgs = await waitFor(() => ptyText(agentPty).includes('FAKE_AGENT') && ptyText(agentPty).includes(`--session-id ${sessionId}`), 4000)
    if (!sawArgs) fail(`agent output missing args: ${JSON.stringify(ptyText(agentPty))}`)
    else ok('pty.attach: fake agent printed its --session-id launch args')

    const exited = await waitFor(() => pc.frames.some((f) => f.type === 'event' && f.event === 'pty.exit' && f.payload.ptyId === agentPty), 6000)
    const exitFrame = pc.frames.find((f) => f.type === 'event' && f.event === 'pty.exit' && f.payload.ptyId === agentPty)
    if (!exited || exitFrame.payload.exitCode !== 7) fail(`pty.exit: ${JSON.stringify(exitFrame)}`)
    else ok('pty.exit: exitCode 7')
    await patchUntil(() => sessionOf(sessionId)?.status === 'exited')
    const sx = sessionOf(sessionId)
    if (sx?.status !== 'exited' || sx.exitCode !== 7 || sx.ptyId) fail(`session after exit: ${JSON.stringify(sx)}`)
    else ok('project topic: session exited with exitCode 7')

    const restarted = await pc.req('session.restart', { projectId, sessionId, cols: 80, rows: 24 })
    if (!restarted.ok || !restarted.result?.ptyId || restarted.result.ptyId === agentPty) fail(`session.restart: ${JSON.stringify(restarted)}`)
    else {
      const pty2 = restarted.result.ptyId
      const att2 = await pc.req('pty.attach', { ptyId: pty2 })
      if (!att2.ok) fail(`pty.attach after restart: ${JSON.stringify(att2)}`)
      const resumed = await waitFor(() => ptyText(pty2).includes(`--resume ${sessionId}`), 4000)
      if (!resumed) fail(`restart output missing --resume: ${JSON.stringify(ptyText(pty2))}`)
      else ok('session.restart: new pty resumed with --resume')
    }

    const unloaded = await pc.req('worktree.unload', { projectId, worktreeId: mainId })
    if (!unloaded.ok) fail(`worktree.unload: ${JSON.stringify(unloaded)}`)
    await patchUntil(() => mainWt()?.loaded === false && !sessionOf(sessionId)?.ptyId)
    const su = sessionOf(sessionId)
    if (mainWt()?.loaded !== false || !su || su.ptyId || !['idle', 'exited'].includes(su.status)) {
      fail(`after unload: loaded ${mainWt()?.loaded}, session ${JSON.stringify(su)}`)
    } else ok(`worktree.unload: session kept without a pty (${su.status}), worktree not loaded`)

    const closedS = await pc.req('session.close', { projectId, sessionId })
    if (!closedS.ok) fail(`session.close: ${JSON.stringify(closedS)}`)
    await patchUntil(() => !sessionOf(sessionId))
    if (sessionOf(sessionId)) fail('closed session still in the topic')
    else ok('session.close: removed from the topic')
  }
}

// --- session status (second fake agent via the local provider) ---
{
  const mainWt = () => projWorktrees().find((w) => w.isMain)
  const mainId = mainRow?.id
  const sessionOf = (sid) => mainWt()?.sessions.find((s) => s.id === sid)

  let att = (await pc.req('sub.subscribe', { topic: 'attention' })).result
  const attEntry = (sid) => att.snapshot.entries.find((e) => e.sessionId === sid)
  /** Applies attention patches until `cond` holds (bounded). */
  const attUntil = async (cond, max = 8) => {
    for (let i = 0; i < max && !cond(); i++) {
      try { att = await nextPatch(pc, 'attention', att, 2500) } catch { break }
    }
    return cond()
  }

  const started = await pc.req('session.start', { projectId, worktreeId: mainId, cols: 80, rows: 24, llm: { provider: 'local' } })
  if (!started.ok) fail(`status session.start: ${JSON.stringify(started)}`)
  else {
    const { sessionId, ptyId: statusPty } = started.result
    await patchUntil(() => sessionOf(sessionId)?.status === 'working')
    if (sessionOf(sessionId)?.status !== 'working') fail(`status: not working: ${JSON.stringify(sessionOf(sessionId))}`)
    else ok('status: session is working while the agent prints')

    // Quiet for 2.5 s after the marker line, before the bell at 4 s: done.
    await patchUntil(() => sessionOf(sessionId)?.status === 'done', 15, 4000)
    if (sessionOf(sessionId)?.status !== 'done') fail(`status: not done: ${JSON.stringify(sessionOf(sessionId))}`)
    else ok('status: done after quiet with the marker seen')
    await attUntil(() => attEntry(sessionId)?.status === 'done')
    if (attEntry(sessionId)?.status !== 'done') fail(`attention topic lacks done: ${JSON.stringify(att.snapshot)}`)
    else ok('attention topic: lists the session as done')

    await patchUntil(() => sessionOf(sessionId)?.status === 'attention', 15, 4000)
    if (sessionOf(sessionId)?.status !== 'attention') fail(`status: no attention after the bell: ${JSON.stringify(sessionOf(sessionId))}`)
    else ok('status: attention after the bell')
    await attUntil(() => attEntry(sessionId)?.status === 'attention')
    if (attEntry(sessionId)?.status !== 'attention') fail(`attention topic lacks attention: ${JSON.stringify(att.snapshot)}`)
    else ok('attention topic: lists the session as attention')

    const attached = await pc.req('pty.attach', { ptyId: statusPty })
    if (!attached.ok) fail(`status pty.attach: ${JSON.stringify(attached)}`)
    const wrote = await pc.req('pty.write', { ptyId: statusPty, data: 'y' })
    if (!wrote.ok) fail(`status pty.write: ${JSON.stringify(wrote)}`)
    await patchUntil(() => sessionOf(sessionId)?.status === 'working')
    if (sessionOf(sessionId)?.status !== 'working') fail(`status: input did not clear attention: ${JSON.stringify(sessionOf(sessionId))}`)
    else ok('status: user input clears attention (working again)')

    const closedS = await pc.req('session.close', { projectId, sessionId })
    if (!closedS.ok) fail(`status session.close: ${JSON.stringify(closedS)}`)
    await patchUntil(() => !sessionOf(sessionId))
    await attUntil(() => !attEntry(sessionId), 4)
    if (sessionOf(sessionId) || attEntry(sessionId)) fail(`closed status session still present: ${JSON.stringify(att.snapshot)}`)
    else ok('session.close: gone from the topic and the attention topic')
  }
}

const inUse = await pc.req('server.removeRepo', { repoId: 'smoke' })
if (inUse.ok || inUse.error.code !== 'IN_USE') fail(`removeRepo while used: ${JSON.stringify(inUse)}`)
else ok('server.removeRepo: IN_USE while a project uses it')

await new Promise((r) => setTimeout(r, 400)) // debounced save
const stored = join(work, 'data', 'projects', `${projectId}.json`)
const onDisk = JSON.parse(readFileSync(stored, 'utf8'))
if (onDisk.schema !== 1 || onDisk.project.repositories[0].branchData.main?.note !== 'from smoke') fail('project not persisted')
else ok('project persisted to the data dir')

const deleted = await pc.req('project.delete', { projectId })
if (!deleted.ok || existsSync(stored)) fail(`project.delete: ${JSON.stringify(deleted)}`)
else ok('project.delete: removed from disk')
srv = await nextPatch(pc, 'server', srv)
if (srv.snapshot.projects.some((p) => p.id === projectId)) fail('server topic still lists the deleted project')
else ok('project.delete: gone from the server topic')
pc.sock.close()

// --- bad token rejected ---
const badWs = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((r) => badWs.on('open', r))
badWs.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'wrong', client: 'smoke', clientVersion: '0' }))
const closeCode = await new Promise((r) => badWs.on('close', (code) => r(code)))
if (closeCode !== 4003) fail(`bad token close code: ${closeCode}`)
else ok('bad token rejected with 4003')

// --- CLI edge cases ---
{
  const before = readFileSync(configPath, 'utf8')
  const help = cli('-h', 'add', repo)
  if (!help.startsWith('Usage: trek-server') || readFileSync(configPath, 'utf8') !== before) {
    fail('`-h add` did not just print help')
  } else ok('`-h` wins over a later command and writes nothing')
  const version = cli('add', '-v')
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`\`add -v\`: ${version}`)
  else ok('`-v` wins over an earlier command')
  try {
    execFileSync(cmd, [...cmdPrefix, 'list', '--port', '1234', '--config', configPath], { cwd: serverDir, stdio: 'pipe' })
    fail('`list --port` was accepted')
  } catch (err) {
    if (err.status !== 2) fail(`\`list --port\` exit ${err.status}`)
    else ok('`--port` outside `start` is a usage error (exit 2)')
  }
}

console.log(failed ? 'SERVER SMOKE FAIL' : 'SERVER SMOKE PASS')
process.exit(failed ? 1 : 0)
