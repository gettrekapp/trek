// End-to-end remote-server smoke: real daemon on loopback, real bare origin,
// two clones ("local" and "server"). Exercises: server connect + status,
// remote worktree listing with server chips, remote worktree creation, and
// the full move flow (dirty local worktree → server) including rollback-free
// verification of the moved bytes.
import { _electron as electron } from 'playwright-core'
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'

const projectDir = process.cwd()
const PORT = 17346
const TRAP_PORT = 17347
const errors = []
const failures = []
const check = (label, actual, expected) => {
  const ok = actual === expected
  console.log(`${ok ? 'ok' : 'FAIL'}: ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expect ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(label)
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/zsh', stdio: 'pipe' }).toString()

// ---- fixture: bare origin + local clone + server clone ----
const work = realpathSync(mkdtempSync(join(tmpdir(), 'twb-remote-smoke-')))
const origin = join(work, 'origin.git')
const localRepo = join(work, 'local', 'repo')
const serverRepo = join(work, 'server', 'repo')
sh(`git init -q --bare -b master "${origin}"`)
sh(`mkdir -p "${join(work, 'local')}" "${join(work, 'server')}"`)
sh(`git clone -q "${origin}" "${localRepo}"`)
const gitEnv = '-c user.email=s@s -c user.name=s'
writeFileSync(join(localRepo, 'readme.txt'), 'hello\n')
sh(`git add . && git ${gitEnv} commit -q -m init && git push -q origin master`, localRepo)
sh(`git clone -q "${origin}" "${serverRepo}"`)

// Local worktree on a feature branch with committed + dirty state.
const localWt = `${localRepo}-feature-move`
sh(`git worktree add -q -b feature-move "${localWt}"`, localRepo)
writeFileSync(join(localWt, 'committed.txt'), 'committed work\n')
sh(`git add . && git ${gitEnv} commit -q -m work`, localWt)
writeFileSync(join(localWt, 'readme.txt'), 'hello\nmodified tracked file\n')
writeFileSync(join(localWt, 'untracked.txt'), 'brand new uncommitted file\n')

// ---- daemon ----
const token = randomBytes(16).toString('base64url')
const daemonConfig = join(work, 'daemon-config.json')
writeFileSync(
  daemonConfig,
  JSON.stringify({
    tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
    repos: [{ id: 'r', name: 'Server Repo', path: serverRepo }]
  })
)
// --data-dir: the default is the platform's trek-server folder in the real HOME.
const daemon = spawn('npx', ['tsx', 'src/index.ts', 'start', '--config', daemonConfig, '--port', String(PORT), '--data-dir', join(work, 'data')], {
  cwd: join(projectDir, 'server'),
  stdio: ['ignore', 'pipe', 'inherit']
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('daemon did not start')), 20000)
  daemon.stdout.on('data', (d) => {
    process.stdout.write(d)
    if (d.toString().includes('listening')) { clearTimeout(timer); resolve() }
  })
  daemon.on('exit', (code) => reject(new Error(`daemon exited early: ${code}`)))
})

const cleanup = async () => {
  // Wait for the daemon to go, so it never writes to a pipe this process has closed (EPIPE).
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit')
    daemon.kill()
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  }
  rmSync(work, { recursive: true, force: true })
}

try {
  const app = await electron.launch({
    // Its own userData, inside work: the default one is shared with an installed Trek (server tokens, recents, settings).
    args: ['out/main/index.js', `--user-data-dir=${join(work, 'user-data')}`],
    cwd: projectDir,
    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1', TREK_NO_LOCAL_SERVER: '1' }
  })
  const win = await app.firstWindow()
  win.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  win.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(500)

  // Store the token BEFORE the project loads so connectServer finds it.
  await win.evaluate(({ t, port }) => window.api.setServerToken('srv1', t, `ws://127.0.0.1:${port}`), { t: token, port: PORT })

  await win.evaluate(
    ({ localRepo, serverRepo, port }) => {
      window.__store.getState().setProject(
        {
          version: 2,
          name: 'remote-smoke',
          repositoryPath: localRepo,
          worktrees: [],
          servers: [{ id: 'srv1', name: 'devbox', url: `ws://127.0.0.1:${port}`, repoPath: serverRepo }]
        },
        '/tmp/remote-smoke.trekproj'
      )
    },
    { localRepo, serverRepo, port: PORT }
  )

  // Wait for the server to connect and the remote poll to land (5s cadence).
  await win.waitForFunction(
    () => window.__store.getState().serverStatus['srv1'] === 'connected',
    undefined,
    { timeout: 15000 }
  )
  check('server status', await win.evaluate(() => window.__store.getState().serverStatus['srv1']), 'connected')
  await win.waitForFunction(
    () => {
      const { project, hostWorktrees } = window.__store.getState()
      return `${project.repositories[0].id} srv1` in hostWorktrees
    },
    undefined,
    { timeout: 15000 }
  )

  const footer = (await win.locator('.sidebar-footer').innerText()).trim()
  check('footer mentions devbox connected', footer.includes('devbox · connected'), true)

  // Sidebar: local master + local feature-move + remote master = 3 rows.
  await win.waitForTimeout(500)
  check('sidebar rows', await win.locator('.wt-row').count(), 3)
  check('server chips', await win.locator('.wt-row .server-chip').count(), 1)
  check('remote MAIN tag', await win.locator('.wt-row .remote-main-tag').count(), 1)

  // Create a worktree on the server through the host-routed IPC.
  await win.evaluate(
    ({ serverRepo }) => window.api.addWorktree('srv1', serverRepo, `${serverRepo}-feature-y`, 'feature-y', true),
    { serverRepo }
  )
  await win.waitForFunction(
    () => {
      const { project, hostWorktrees } = window.__store.getState()
      return (hostWorktrees[`${project.repositories[0].id} srv1`] ?? []).length === 2
    },
    undefined,
    { timeout: 15000 }
  )
  check('remote worktree created on disk', existsSync(`${serverRepo}-feature-y`), true)
  check('sidebar rows after remote create', await win.locator('.wt-row').count(), 4)

  // ---- move flow: dirty local feature-move → devbox ----
  await win.locator('.wt-row', { hasText: 'feature-move' }).first().click()
  await win.waitForTimeout(300)
  await win.locator('.detail-actions .btn-icon').click()
  await win.waitForTimeout(200)
  const moveItem = win.locator('.detail-menu-item', { hasText: 'Move to devbox…' })
  check('move menu item present', await moveItem.count(), 1)
  await moveItem.click()
  await win.waitForTimeout(200)
  check('move modal open', await win.locator('.move-modal').count(), 1)
  await win.locator('.move-modal .btn-accent', { hasText: 'Move worktree' }).click()
  await win.waitForSelector('.move-modal .server-test-result.ok', { timeout: 60000 })
  console.log('ok: move completed')

  const movedPath = `${serverRepo}-feature-move`
  check('moved worktree exists on server', existsSync(movedPath), true)
  check('committed file arrived', readFileSync(join(movedPath, 'committed.txt'), 'utf8'), 'committed work\n')
  check('tracked modification arrived', readFileSync(join(movedPath, 'readme.txt'), 'utf8'), 'hello\nmodified tracked file\n')
  check('untracked file arrived', readFileSync(join(movedPath, 'untracked.txt'), 'utf8'), 'brand new uncommitted file\n')
  check('source worktree removed', existsSync(localWt), false)
  check('target dirty (patch applied, not committed)', sh('git status --porcelain', movedPath).trim().length > 0, true)
  check('origin has the branch', sh(`git ls-remote origin feature-move`, serverRepo).includes('feature-move'), true)

  await win.locator('.move-modal button', { hasText: 'Close' }).click()
  await win.waitForTimeout(500)

  // The moved row now renders as remote (server chip on feature-move).
  const movedRow = win.locator('.wt-row', { hasText: 'feature-move' })
  check('moved row still listed', await movedRow.count(), 1)
  check('moved row has server chip', await movedRow.locator('.server-chip').count(), 1)

  // The instance record followed the move.
  const instance = await win.evaluate(() =>
    window.__store.getState().project.repositories[0].worktrees.find((w) => w.branch === 'feature-move')
  )
  check('instance serverId updated', instance?.serverId, 'srv1')
  check('instance path updated', instance?.path, movedPath)

  // git.worktreeStatuses over the wire: the moved worktree carries the applied
  // patch, so the daemon must report it dirty (the list itself carries no status).
  const remoteStatus = await win.evaluate(
    (movedPath) => window.api.worktreeStatuses('srv1', [movedPath]).then(([s]) => s?.dirty),
    movedPath
  )
  check('remote worktreeStatuses reports dirty', remoteStatus, true)

  // The stored token is bound to ws://127.0.0.1:PORT: pointed elsewhere (another port, another
  // host name) it is never sent; a trap listener counts any connection made to it.
  const trapHits = []
  const trap = createServer((sock) => { trapHits.push(1); sock.destroy() })
  await new Promise((resolve) => trap.listen(TRAP_PORT, '127.0.0.1', resolve))
  const trapUrl = `ws://127.0.0.1:${TRAP_PORT}`
  check('hasServerToken for its own address', (await win.evaluate((u) => window.api.hasServerToken('srv1', u), `ws://127.0.0.1:${PORT}`)).ok, true)
  const otherCheck = await win.evaluate((u) => window.api.hasServerToken('srv1', u), trapUrl)
  check('hasServerToken for another address says why', `${otherCheck.ok}:${otherCheck.reason}`, 'false:changed')
  const movedTest = await win.evaluate(
    ({ u, serverRepo }) => window.api.testServer({ url: u, serverId: 'srv1', repoPath: serverRepo }),
    { u: trapUrl, serverRepo }
  )
  check('test refuses the stored token for another port', movedTest.ok === false && /address changed/.test(movedTest.error), true)
  const hostTest = await win.evaluate(
    ({ u, serverRepo }) => window.api.testServer({ url: u, serverId: 'srv1', repoPath: serverRepo }),
    { u: `ws://localhost:${PORT}`, serverRepo }
  )
  check('test refuses the stored token for another host name', hostTest.ok === false && /address changed/.test(hostTest.error), true)
  await win.evaluate((u) => window.api.connectServer({ id: 'srv1', name: 'devbox', url: u }), trapUrl)
  await win.waitForFunction(() => window.__store.getState().serverStatus['srv1'] === 'needs-auth', undefined, { timeout: 5000 })
  check('connect to another address asks for the token', /address changed/.test(await win.evaluate(() => window.__store.getState().serverErrors['srv1'] ?? '')), true)
  await win.waitForTimeout(500)
  check('nothing reached the other address', trapHits.length, 0)
  trap.close()
  await win.evaluate((u) => window.api.connectServer({ id: 'srv1', name: 'devbox', url: u }), `ws://127.0.0.1:${PORT}`)
  await win.waitForFunction(() => window.__store.getState().serverStatus['srv1'] === 'connected', undefined, { timeout: 15000 })
  check('connect to its own address again', await win.evaluate(() => window.__store.getState().serverErrors['srv1'] ?? null), null)

  const filteredErrors = errors.filter(
    (e) => !e.includes('Autofill') && !e.includes('DevTools')
  )
  console.log(`console/page errors: ${filteredErrors.length}`)
  filteredErrors.forEach((e) => console.log(`  ${e}`))
  if (filteredErrors.length > 0) failures.push('console errors')

  await app.close()
} finally {
  await cleanup()
}

console.log(failures.length === 0 ? 'REMOTE SMOKE PASS' : `REMOTE SMOKE FAIL: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
