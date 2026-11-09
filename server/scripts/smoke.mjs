// trek-server smoke test: throwaway config + temp git repo, then the refusal of a
// v1 hello (with a good token and a bad one), the v2 handshake, the projects flow
// (create, branch note, persist, delete), sessions and their ptys, revs in responses,
// decisions, server.agents, the trek-dev MCP, the topic end of a deleted project and
// an auth-rejection check.
import { spawn, execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
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

// --- protocol v1 is retired (phase 4e): its hello is refused, telling the client to upgrade ---
// The version is checked before the token: a v1 client with a stale token is still told to
// upgrade (4002, at once), not rejected as unauthorized (4003, after the bad-token delay).
const v1Hello = async (helloToken) => {
  const old = new WebSocket(`ws://127.0.0.1:${PORT}`)
  await new Promise((r) => old.on('open', r))
  const frames = []
  old.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  old.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: helloToken, client: 'smoke-v1', clientVersion: '0' }))
  // Bounded: a server that still serves v1 answers with a welcome and keeps the socket open.
  const [code, reason] = await new Promise((r) => {
    const timer = setTimeout(() => {
      old.close()
      r(['open', ''])
    }, 3000)
    old.on('close', (c, why) => {
      clearTimeout(timer)
      r([c, why.toString()])
    })
  })
  return { code, reason, frames }
}
{
  const { code, reason, frames } = await v1Hello(token)
  if (code !== 4002 || reason !== 'UPGRADE_CLIENT' || frames.length !== 0) fail(`v1 hello: ${code} ${reason} ${JSON.stringify(frames)}`)
  else ok('a v1 hello is refused with 4002 UPGRADE_CLIENT, before any welcome')
}
{
  const { code, reason, frames } = await v1Hello('wrong')
  if (code !== 4002 || reason !== 'UPGRADE_CLIENT' || frames.length !== 0) fail(`v1 hello, bad token: ${code} ${reason} ${JSON.stringify(frames)}`)
  else ok('a v1 hello with a bad token is refused with 4002 UPGRADE_CLIENT (not 4003), with no frame')
}

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
} else if (!['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents'].every((c) => v2.welcome.capabilities?.includes(c))) {
  fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
} else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)

// Ported from the v1 checks (phase 4e): a method named after an Object prototype member is unknown.
const proto = await v2.req('constructor', {})
if (proto.ok || proto.error.code !== 'NOT_FOUND') fail(`prototype-named method: ${JSON.stringify(proto)}`)
else ok('v2 unknown prototype-named method is NOT_FOUND')

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
{
  // The response names the rev the note made, and that patch was written before it.
  const at = pc.frames.indexOf(noted)
  const patchAt = pc.frames.findIndex((f) => f.type === 'event' && f.event === 'state.patch' &&
    f.payload.topic === `project:${projectId}` && f.payload.rev === noted.rev?.rev)
  if (noted.rev?.topic !== `project:${projectId}` || noted.rev.rev !== proj.rev || patchAt < 0 || patchAt > at) {
    fail(`branch.setNote rev: ${JSON.stringify(noted.rev)}, topic at ${proj.rev}, patch frame ${patchAt}, res frame ${at}`)
  } else ok(`response rev: branch.setNote answered rev ${noted.rev.rev}, after its patch`)
  const listed = await pc.req('project.list', {})
  if (!listed.ok || 'rev' in listed) fail(`project.list carries a rev: ${JSON.stringify(listed)}`)
  else ok('response rev: a method that names no project carries none')
}

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
if (wtCreated.rev?.topic !== `project:${projectId}` || !Number.isInteger(wtCreated.rev?.rev)) fail(`worktree.create rev: ${JSON.stringify(wtCreated.rev)}`)
else ok(`response rev: the async worktree.create answered rev ${wtCreated.rev.rev}`)
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

// A dirty worktree is refused with a reason the client can act on, whatever git's locale.
writeFileSync(join(wtRow.path, 'scratch.txt'), 'x')
const wtDirty = await pc.req('worktree.remove', { projectId, worktreeId: wtId })
if (wtDirty.ok || wtDirty.error.code !== 'GIT_ERROR' || wtDirty.error.details?.reason !== 'dirty') fail(`worktree.remove dirty: ${JSON.stringify(wtDirty)}`)
else ok('worktree.remove: a dirty worktree is GIT_ERROR with details.reason "dirty"')
if ('rev' in wtDirty) fail(`an error res carries a rev: ${JSON.stringify(wtDirty)}`)
else ok('response rev: an error res carries none')
rmSync(join(wtRow.path, 'scratch.txt'))
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

// --- trek-dev MCP (the session's --mcp-config) ---
const mcpConfigPath = join(work, 'data', 'mcp', `${projectId}.json`)
{
  const mainId = projWorktrees().find((w) => w.isMain)?.id
  const ptyText = (id) => pc.frames
    .filter((f) => f.type === 'event' && f.event === 'pty.data' && f.payload.ptyId === id)
    .map((f) => f.payload.data).join('')
  const started = await pc.req('session.start', { projectId, worktreeId: mainId, cols: 400, rows: 24 })
  if (!started.ok) fail(`mcp session.start: ${JSON.stringify(started)}`)
  else {
    const { sessionId, ptyId: mcpPty } = started.result
    await pc.req('pty.attach', { ptyId: mcpPty })
    const launched = await waitFor(() => ptyText(mcpPty).includes('--mcp-config') && ptyText(mcpPty).includes(mcpConfigPath), 4000)
    if (!launched) fail(`agent not launched with --mcp-config ${mcpConfigPath}: ${JSON.stringify(ptyText(mcpPty))}`)
    else ok('session.start: agent launched with --mcp-config <data dir>/mcp/<projectId>.json')
    await waitFor(() => pc.frames.some((f) => f.type === 'event' && f.event === 'pty.exit' && f.payload.ptyId === mcpPty), 6000)
    const closedS = await pc.req('session.close', { projectId, sessionId })
    if (!closedS.ok) fail(`mcp session.close: ${JSON.stringify(closedS)}`)
  }

  let server
  try {
    server = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers?.['trek-dev']
  } catch (err) {
    fail(`mcp config file: ${err.message}`)
  }
  if (server?.type !== 'http' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(server.url ?? '') || !server.headers?.Authorization) {
    fail(`mcp config entry: ${JSON.stringify(server)}`)
  } else {
    ok(`mcp config file: trek-dev at ${server.url}`)
    let rpcId = 1
    const rpc = async (method, params, headers = server.headers) => {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
      })
      return { status: res.status, body: res.status === 200 ? await res.json() : undefined }
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
    if (init.body?.result?.serverInfo?.name !== 'trek-dev') fail(`mcp initialize: ${JSON.stringify(init)}`)
    else ok(`mcp initialize: serverInfo ${init.body.result.serverInfo.name} ${init.body.result.serverInfo.version}`)
    const listed = await rpc('tools/list', {})
    const names = listed.body?.result?.tools?.map((t) => t.name) ?? []
    if (!names.includes('list_worktrees')) fail(`mcp tools/list: ${JSON.stringify(listed)}`)
    else ok(`mcp tools/list: ${names.length} tools including list_worktrees`)
    const called = await rpc('tools/call', { name: 'list_worktrees', arguments: {} })
    let worktrees
    try { worktrees = JSON.parse(called.body?.result?.content?.[0]?.text) } catch { /* reported below */ }
    if (called.body?.result?.isError !== false || !Array.isArray(worktrees) || worktrees.length !== 1) {
      fail(`mcp tools/call list_worktrees: ${JSON.stringify(called)}`)
    } else ok(`mcp tools/call list_worktrees: one worktree (${worktrees[0].branch})`)

    // A decision: asked through MCP, seen in the project and attention topics, answered by typing.
    const asking = await pc.req('session.start', { projectId, worktreeId: mainId, cols: 80, rows: 24, llm: { provider: 'local' } })
    if (!asking.ok) fail(`decision session.start: ${JSON.stringify(asking)}`)
    else {
      const { sessionId: askId, ptyId: askPty } = asking.result
      const askSession = () => projWorktrees().find((w) => w.isMain)?.sessions.find((x) => x.id === askId)
      let att = (await pc.req('sub.subscribe', { topic: 'attention' })).result
      const asked = await rpc('tools/call', { name: 'request_decision', arguments: { terminalId: askId, question: 'Ship it?' } })
      if (asked.body?.result?.isError !== false) fail(`mcp request_decision: ${JSON.stringify(asked)}`)
      await patchUntil(() => askSession()?.decision?.question === 'Ship it?')
      if (askSession()?.decision?.question !== 'Ship it?') fail(`decision not in the project topic: ${JSON.stringify(askSession())}`)
      else ok('mcp request_decision: the session carries the decision')
      for (let i = 0; i < 8 && !att.snapshot.entries.some((e) => e.sessionId === askId && e.decision); i++) {
        try { att = await nextPatch(pc, 'attention', att, 2500) } catch { break }
      }
      if (!att.snapshot.entries.some((e) => e.sessionId === askId && e.decision?.question === 'Ship it?')) fail(`attention lacks the decision: ${JSON.stringify(att.snapshot)}`)
      else ok('attention topic: lists the decision')
      await pc.req('pty.attach', { ptyId: askPty })
      await pc.req('pty.write', { ptyId: askPty, data: 'y' })
      await patchUntil(() => askSession() && !askSession().decision)
      if (!askSession() || askSession().decision) fail(`typing did not answer the decision: ${JSON.stringify(askSession())}`)
      else ok('pty.write: user input answers the decision')

      // session.dequeue: one prompt, compare-and-set.
      await pc.req('session.setQueue', { projectId, sessionId: askId, queue: ['a', 'b'] })
      const dq = await pc.req('session.dequeue', { projectId, sessionId: askId, index: 0, expected: 'a' })
      const stale = await pc.req('session.dequeue', { projectId, sessionId: askId, index: 0, expected: 'a' })
      await patchUntil(() => askSession()?.queue.length === 1)
      if (!dq.ok || stale.error?.code !== 'CONFLICT' || askSession()?.queue[0] !== 'b') fail(`session.dequeue: ${JSON.stringify({ dq, stale, queue: askSession()?.queue })}`)
      else ok('session.dequeue: removes the prompt it saw; a stale one is CONFLICT')
      await pc.req('session.close', { projectId, sessionId: askId })
      await patchUntil(() => !askSession())
    }

    const agents = await pc.req('server.agents', {})
    const agentOf = (id) => agents.result?.agents?.find((a) => a.provider === id)
    if (!agents.ok || agents.result.llmDefault?.provider !== 'claude' || agents.result.agents.length !== 5 ||
      agentOf('claude')?.installed !== true || agentOf('local')?.installed !== true || JSON.stringify(agents.result).includes(fakeAgent)) {
      fail(`server.agents: ${JSON.stringify(agents)}`)
    } else ok(`server.agents: ${agents.result.agents.map((a) => `${a.provider}${a.installed ? '' : ' (not installed)'}`).join(', ')}`)
    const wrong = await rpc('ping', {}, { Authorization: `Bearer ${'0'.repeat(64)}` })
    if (wrong.status !== 401) fail(`mcp wrong token: ${wrong.status}`)
    else ok('mcp wrong token: 401')
    // fetch cannot set Host, so this one goes through node:http.
    const hostStatus = await new Promise((resolve, reject) => {
      const u = new URL(server.url)
      const r = httpRequest({
        host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { ...server.headers, host: `evil.example:${u.port}`, 'content-type': 'application/json' }
      }, (res) => { res.resume(); resolve(res.statusCode) })
      r.on('error', reject)
      r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    })
    if (hostStatus !== 403) fail(`mcp bad Host header: ${hostStatus}`)
    else ok('mcp bad Host header: 403')
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
{
  const ended = pc.frames.findIndex((f) => f.type === 'event' && f.event === 'topic.ended' && f.payload.topic === `project:${projectId}`)
  const endFrame = pc.frames[ended]
  if (ended < 0 || endFrame.payload.reason !== 'deleted' || ended > pc.frames.indexOf(deleted) || deleted.rev?.topic !== 'server') {
    fail(`topic.ended: ${JSON.stringify(endFrame)} at ${ended}, response ${JSON.stringify(deleted)}`)
  } else ok('project.delete: topic.ended "deleted" before the response, which reports the server topic rev')
}
if (existsSync(mcpConfigPath)) fail(`project.delete left its MCP config file: ${mcpConfigPath}`)
else ok('project.delete: MCP config file removed')
srv = await nextPatch(pc, 'server', srv)
if (srv.snapshot.projects.some((p) => p.id === projectId)) fail('server topic still lists the deleted project')
else ok('project.delete: gone from the server topic')
pc.sock.close()

// --- bad token rejected ---
const badWs = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((r) => badWs.on('open', r))
badWs.send(JSON.stringify({ type: 'hello', protocolVersion: 2, token: 'wrong', client: 'smoke', clientVersion: '0' }))
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
