// Throwaway check of the start screen's Connect flow against a real trek-server.
import { _electron as electron } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

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
const daemon = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', join(work, 'data')], {
  cwd: new URL('../server/', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe']
})
daemon.stderr.on('data', (d) => process.stderr.write(d))
await sleep(1000)

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

  // Picked by the save already; the projects list shows.
  await item.locator('.connect-projects-status', { hasText: 'No projects yet.' }).waitFor({ timeout: 5000 })
  await item.locator('button', { hasText: 'New Project…' }).click()
  const modal = win.locator('.modal.new-server-project')
  check('the modal lists the registered repo', await modal.locator('.worktree-branch').allTextContents(), ['Alpha'])
  check('Create starts disabled', await modal.locator('button', { hasText: 'Create' }).isDisabled(), true)
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
  await addInput.fill(repoB)
  await modal.locator('button', { hasText: 'Add' }).click()
  await modal.locator('.worktree-branch', { hasText: 'beta' }).waitFor({ timeout: 5000 })
  check('the added repo is ticked', await modal.locator('li', { hasText: 'beta' }).locator('input[type=checkbox]').isChecked(), true)
  await modal.locator('input[placeholder="Project name"]').fill('Demo')
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'modal.png') })
  await modal.locator('button', { hasText: 'Create' }).click()
  await modal.waitFor({ state: 'detached', timeout: 5000 })
  const target = await win.evaluate(() => window.__store.getState().serverWindow)
  check('Create opens the project in this window', !!target && target.projectId.length > 0, true)
  const recents = await win.evaluate(() => window.api.getRecentProjects())
  check('it is recorded as a recent', recents.map((r) => [r.kind, r.name, r.serverName]), [['server', 'Demo', 'Local box']])
  check('the project shows on the server list', await item.locator('.connect-project-list .recent-name').allTextContents(), ['Demo'])

  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'connect.png') })
  // A wrong token: needs-auth, 4003.
  await item.locator('button', { hasText: 'Set token' }).click()
  await item.locator('.connect-token-row input').fill('wrong-token')
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: 'Token rejected' }).waitFor({ timeout: 10000 })
  check('a wrong token shows Token rejected', await item.locator('.connect-server-status').textContent(), 'Token rejected · The server rejected the access token')
  await item.locator('button', { hasText: 'Set token' }).click()
  await item.locator('.connect-token-row input').fill(token)
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10000 })
  check('the right token reconnects', true, true)

  // Edit: another origin needs the token again; main clears it otherwise.
  await item.locator('button', { hasText: 'Edit' }).click()
  const edit = item.locator('.server-form')
  await edit.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://localhost:${port}`)
  check('another origin needs the token again', await edit.locator('button', { hasText: 'Save' }).isDisabled(), true)
  check('and says so', (await edit.locator('.connect-warning').allTextContents()).some((t) => t.includes('enter the token again')), true)
  await edit.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill(token)
  await edit.locator('button', { hasText: 'Save' }).click()
  await item.locator('.server-row-url', { hasText: `ws://localhost:${port}` }).waitFor()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10000 })
  check('the edited server reconnects', true, true)
  const list = await win.evaluate(() => window.api.appServers.list())
  check('it still has a token', list[0].hasToken, true)

  // Remove: confirmed, the list empties, the recent shows Server removed.
  await item.locator('button', { hasText: 'Remove' }).click()
  await win.locator('.connect-server-item').first().waitFor({ state: 'detached', timeout: 5000 })
  check('Remove empties the list', await win.locator('.servers-empty').count(), 1)
  // A relay open for the removed entry rejects; the ipc socket turns that into a status message.
  const msg = await win.evaluate(async (id) => {
    try {
      await window.api.v2Socket.open(id)
      return 'opened'
    } catch (e) {
      return String(e.message)
    }
  }, list[0].id)
  check('a removed entry refuses to open', msg.endsWith('Server removed'), true)
  await win.evaluate(() => window.__store.getState().setServerWindow(null))
  await win.locator('.connect-header button', { hasText: '← Back' }).click()
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
  daemon.kill()
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log(exitCode === 0 ? `CONNECT UI PASS (${checks.length})` : 'CONNECT UI FAIL')
  process.exit(exitCode)
}
