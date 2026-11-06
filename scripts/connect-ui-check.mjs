// Throwaway check of the start screen's Connect flow against a real trek-server.
import { _electron as electron } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-connect-ui-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-connect-outside-')))
const repos = join(work, 'repos')
mkdirSync(repos)
const gitRepo = (path) => {
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  execFileSync('git', ['-C', path, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
}
const repoA = join(repos, 'alpha')
const repoB = join(repos, 'beta')
const notRepo = join(repos, 'plain')
gitRepo(repoA)
gitRepo(repoB)
mkdirSync(notRepo)
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ llm: { providers: { claude: { command: fakeAgent } } }, tokenHash, repos: [{ id: 'alpha', name: 'Alpha', path: repoA }] }))

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const port = await freePort()
let daemon = null
const startDaemon = async () => {
  daemon = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', join(work, 'data')], {
    cwd: new URL('../server/', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  daemon.stderr.on('data', (d) => process.stderr.write(d))
  await sleep(1000)
}
const stopDaemon = async () => {
  const d = daemon
  daemon = null
  if (!d || d.exitCode !== null) return
  await new Promise((resolve) => {
    d.once('exit', resolve)
    d.kill()
  })
}
await startDaemon()

const userData = join(work, 'user-data')
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd() })
let exitCode = 1
try {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const pageErrors = []
  win.on('pageerror', (e) => pageErrors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })

  await win.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  const form = win.locator('.server-form')
  await form.locator('.server-form-row', { hasText: 'Name' }).locator('input').fill('Local box')
  await form.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://192.168.1.50:${port}`)
  check('ws:// to a LAN host warns', await form.locator('.connect-warning').first().textContent(), 'Unencrypted — use wss:// unless this is a private network')
  await form.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://127.0.0.1:${port}`)
  check('loopback does not warn', await form.locator('.connect-warning').count(), 0)
  check('Save needs a token for a new server', await form.locator('button', { hasText: 'Save' }).isDisabled(), true)
  await form.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill(token)
  await form.locator('button', { hasText: 'Save' }).click()

  const item = win.locator('.connect-server-item').first()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10000 })
  check('the server shows connected', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot done')
  check('the renderer never sees the token', await win.evaluate((t) => document.body.innerHTML.includes(t), token), false)

  await item.locator('button', { hasText: 'Test' }).click()
  await item.locator('.server-test-result').waitFor()
  check('Test reports connected', (await item.locator('.server-test-result').getAttribute('class')).includes('ok'), true)

  // A wrong token: needs-auth, 4003; the dot goes grey.
  await item.locator('button', { hasText: 'Set token' }).click()
  check('the Set token field is labelled', await item.getByLabel('Access token').count(), 1)
  await item.locator('.connect-token-row input').fill('wrong-token')
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: 'Token rejected' }).waitFor({ timeout: 10000 })
  check('a wrong token shows Token rejected', await item.locator('.connect-server-status').textContent(), 'Token rejected · The server rejected the access token')
  check('and a grey dot', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot exited')
  await item.locator('button', { hasText: 'Set token' }).click()
  await item.locator('.connect-token-row input').fill(token)
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10000 })
  check('the right token reconnects', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot done')

  // Edit: another origin needs the token again; main clears it otherwise. Escape cancels.
  await item.locator('button', { hasText: 'Edit' }).click()
  await item.locator('.server-form input').first().press('Escape')
  check('Escape cancels the Edit form', await item.locator('.server-form').count(), 0)
  await item.locator('button', { hasText: 'Edit' }).click()
  const edit = item.locator('.server-form')
  await edit.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://localhost:${port}`)
  check('another origin needs the token again', await edit.locator('button', { hasText: 'Save' }).isDisabled(), true)
  check('and says so', (await edit.locator('.connect-warning').allTextContents()).some((t) => t.includes('enter the token again')), true)
  await edit.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill(token)
  await edit.locator('button', { hasText: 'Save' }).click()
  await item.locator('.server-row-url', { hasText: `ws://localhost:${port}` }).waitFor()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10000 })
  check('the edited server reconnects', [await item.locator('.wt-dot').getAttribute('class'), await item.locator('.connect-server-status').textContent()], ['wt-dot done', 'Connected'])
  const list = await win.evaluate(() => window.api.appServers.list())
  check('it still has a token', list[0].hasToken, true)
  const entryId = list[0].id

  // A spare server with a bad token: needs-auth, then Remove (confirmed) drops it.
  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  await win.locator('.server-form').locator('input').first().press('Escape')
  check('Escape cancels the Add form', await win.locator('.server-form').count(), 0)
  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  const spareForm = win.locator('.server-form')
  await spareForm.locator('.server-form-row', { hasText: 'Name' }).locator('input').fill('Spare')
  await spareForm.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://127.0.0.1:${port}`)
  await spareForm.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill('wrong-token')
  await spareForm.locator('button', { hasText: 'Save' }).click()
  const spare = win.locator('.connect-server-item', { hasText: 'Spare' })
  await spare.locator('.connect-server-status', { hasText: 'Token rejected' }).waitFor({ timeout: 10000 })
  check('a bad-token server shows needs-auth', await spare.locator('.wt-dot').getAttribute('class'), 'wt-dot exited')
  await spare.locator('button', { hasText: 'Remove' }).click()
  await spare.waitFor({ state: 'detached', timeout: 5000 })
  check('Remove drops it from the list', await win.locator('.connect-server-item').count(), 1)

  // Projects, then New Project…
  if (!(await item.locator('.connect-projects').count())) await item.locator('button', { hasText: 'Projects' }).click()
  await item.locator('.connect-projects-status', { hasText: 'No projects yet.' }).waitFor({ timeout: 5000 })
  await item.locator('button', { hasText: 'New Project…' }).click()
  const modal = win.locator('.modal.new-server-project')
  check('the modal lists the registered repo', await modal.locator('.worktree-branch').allTextContents(), ['Alpha'])
  check('Create starts disabled', await modal.locator('button', { hasText: 'Create' }).isDisabled(), true)
  check('the name and path inputs are labelled', [await modal.getByLabel('Project name').count(), await modal.getByLabel('Add repo by path…').count()], [1, 1])
  const addInput = modal.locator('input[placeholder^="/home/dev"]')
  await addInput.fill(join(outside, 'x'))
  await modal.locator('button', { hasText: 'Add' }).click()
  await modal.locator('.error').waitFor()
  const denied = await modal.locator('.error').textContent()
  check('a path outside the roots is PATH_DENIED with the hint', denied.includes('Run trek-server add <path> on the server.'), true)
  await addInput.fill(notRepo)
  await modal.locator('button', { hasText: 'Add' }).click()
  await sleep(500)
  const notARepo = await modal.locator('.error').textContent()
  check('a plain directory is NOT_A_REPO with the hint', notARepo !== denied && notARepo.includes('trek-server add'), true)
  console.log('   errors:', JSON.stringify(denied), JSON.stringify(notARepo))
  // A path inside the checkout: the server registers the repo root, and Create sends that.
  await addInput.fill(`${repoB}/`)
  await addInput.press('Enter')
  await addInput.press('Enter')
  await modal.locator('.worktree-branch', { hasText: 'beta' }).waitFor({ timeout: 5000 })
  check('the added repo is ticked', await modal.locator('li', { hasText: 'beta' }).locator('input[type=checkbox]').isChecked(), true)
  check('a double Enter adds it once', await modal.locator('.worktree-branch').allTextContents(), ['Alpha', 'beta'])
  check('it shows the server path', await modal.locator('li', { hasText: 'beta' }).locator('.worktree-path').textContent(), repoB)
  await modal.locator('li', { hasText: 'Alpha' }).locator('input[type=checkbox]').check()
  await modal.locator('input[placeholder="Project name"]').fill('Demo')
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'modal.png') })
  await modal.locator('button', { hasText: 'Create' }).click()
  await modal.waitFor({ state: 'detached', timeout: 5000 })
  const target = await win.evaluate(() => window.__store.getState().serverWindow)
  check('Create opens the project in this window', !!target && target.projectId.length > 0, true)
  const recents = await win.evaluate(() => window.api.getRecentProjects())
  check('it is recorded as a recent', recents.map((r) => [r.kind, r.name, r.serverName]), [['server', 'Demo', 'Local box']])

  // The server window: title, tree.
  const tree = win.locator('.server-window-tree')
  await tree.waitFor({ timeout: 10000 })
  const windowTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  await win.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
  check('the title bar and the window title show the project', [await win.locator('.title-text').textContent(), await windowTitle()], ['Demo', 'Demo'])
  check('the tree lists the repos', await tree.locator('.repo-section:not(.server-window-global) .repo-name').allTextContents(), ['Alpha', 'beta'])
  check('each with its main worktree', await tree.locator('.wt-name').allTextContents(), ['main', 'main'])
  check('and a Global section', await tree.locator('.server-window-global .repo-name').textContent(), 'Global')
  check('no banner while connected', await win.locator('.server-window-banner').count(), 0)
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'server-window.png') })

  // Live: a worktree created from another client shows up without a reload.
  const sdk = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: 'connect-ui-check' })
  sdk.connect()
  for (let i = 0; i < 50 && sdk.status !== 'connected'; i++) await sleep(100)
  const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${target.projectId}` })
  const alpha = snapshot.repositories.find((r) => r.name === 'Alpha')
  check('project.create used the canonical repo path', snapshot.repositories.map((r) => r.path), [repoA, repoB])
  await sdk.request('worktree.create', { projectId: target.projectId, repoId: alpha.id, branch: 'feature-x', createBranch: true })
  await tree.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10000 })
  check('a new worktree appears live', (await tree.locator('.wt-name').allTextContents()).includes('feature-x'), true)
  sdk.close()

  // Not found: Pick another project goes to Connect with this server picked.
  await win.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId: 'no-such-project' }), entryId)
  await win.locator('.server-window-message h2', { hasText: 'Project not found' }).waitFor({ timeout: 10000 })
  check('an unknown project says so', await win.locator('.server-window-message h2').textContent(), 'Project not found on Local box')
  await win.locator('.server-window-message button', { hasText: 'Pick another project' }).click()
  await item.locator('.connect-project-list .recent-name').first().waitFor({ timeout: 5000 })
  check('Pick another project lists that server\'s projects', await item.locator('.connect-project-list .recent-name').allTextContents(), ['Demo'])
  check('and releases the window title', await windowTitle(), 'Trek Dev')
  await item.locator('.connect-project-list li', { hasText: 'Demo' }).locator('button', { hasText: 'Open' }).click()
  await tree.waitFor({ timeout: 10000 })
  check('Open brings the project back into this window', await win.evaluate(() => window.__store.getState().serverWindow?.projectId), target.projectId)

  // Disconnect: the banner shows, the tree stays; back again once the server is.
  await stopDaemon()
  await win.locator('.server-window-banner').waitFor({ timeout: 10000 })
  const banner = await win.locator('.server-window-banner').textContent()
  check('the disconnect banner shows the status and last seen', [banner.startsWith('Disconnected'), banner.includes('last seen')], [true, true])
  check('the tree stays visible', (await tree.locator('.wt-name').allTextContents()).includes('feature-x'), true)
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'server-window-down.png') })
  await startDaemon()
  await win.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 20000 })
  check('the banner goes once reconnected', await win.locator('.server-window-banner').count(), 0)

  // A window stuck in needs-auth never retries, so only the focus re-check of the
  // server list can see its entry removed from another window.
  const stuck = await win.evaluate((url) => window.api.appServers.save({ name: 'Stuck', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
  await win.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId: 'whatever' }), stuck.id)
  await win.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10000 })
  await win.evaluate((id) => window.api.appServers.remove(id), stuck.id)
  await sleep(500)
  check('a stuck window does not notice the removal by itself', await win.locator('.server-window-banner', { hasText: 'Token rejected' }).count(), 1)
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 5000 })
  check('on focus it re-reads the list and shows Server removed', await win.locator('.server-window-message h2').textContent(), 'Server removed')
  await win.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [entryId, target.projectId])
  await tree.waitFor({ timeout: 10000 })
  await win.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })

  // Count the relay opens in main (Electron's private handler map; falls back to the status alone).
  const hooked = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get('v2socket:open')
    if (!original) return false
    globalThis.__v2Opens = 0
    handlers.set('v2socket:open', (...args) => {
      globalThis.__v2Opens++
      return original(...args)
    })
    return true
  })
  const opens = () => app.evaluate(() => globalThis.__v2Opens)

  // Server removed (as from another window): the relay's removed result is terminal, no retries.
  await win.evaluate((id) => window.api.appServers.remove(id), entryId)
  await win.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 10000 })
  check('a removed server shows Server removed', await win.locator('.server-window-message button').allTextContents(), ['Close'])
  check('both titles say Server removed', [await win.locator('.title-text').textContent(), await windowTitle()], ['Server removed', 'Server removed'])
  if (hooked) {
    const before = await opens()
    check('the hook saw the refused retry', before >= 1, true)
    await sleep(3000)
    check('no further relay opens over 3 s', (await opens()) - before, 0)
  } else {
    console.log('   (no ipcMain handler map: checking the view alone)')
    await sleep(3000)
  }
  check('it stays Server removed', await win.locator('.server-window-message h2').textContent(), 'Server removed')
  // A relay open for the removed entry resolves a structured refusal, never a close code.
  const refused = await win.evaluate((id) => window.api.v2Socket.open(id), entryId)
  check('a removed entry refuses to open, structurally', refused, { ok: false, removed: true, reason: 'Server removed' })

  // Back to the start screen: the recent shows Server removed, × removes it.
  await win.evaluate(async () => {
    await window.api.releaseTarget()
    window.__store.getState().setServerWindow(null)
  })
  await win.locator('.recent-projects li', { hasText: 'Demo' }).waitFor()
  check('the recent shows Server removed', await win.locator('.recent-projects li .recent-path').first().textContent(), 'Server removed')
  await win.screenshot({ path: join(process.env.SHOT_DIR ?? work, 'start.png') })
  await win.locator('.recent-projects li', { hasText: 'Demo' }).hover()
  await win.locator('.recent-projects li button.recent-remove').first().click()
  await win.locator('.recent-projects').waitFor({ state: 'detached', timeout: 5000 })
  check('× removes the recent', await win.evaluate(() => window.api.getRecentProjects()), [])
  check('no page errors', pageErrors, [])
  exitCode = checks.every(Boolean) ? 0 : 1
} catch (err) {
  console.error(err)
} finally {
  await app.close().catch(() => {})
  await stopDaemon()
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log(exitCode === 0 ? `CONNECT UI PASS (${checks.length})` : 'CONNECT UI FAIL')
  process.exit(exitCode)
}
