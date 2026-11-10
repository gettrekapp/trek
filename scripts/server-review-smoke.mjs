// scripts/server-review-smoke.mjs — the Changes tab's review (phase 5c-2) on a remote server, in its window.
//
// Run: npm run smoke:server-review   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME and the not-signed-in stub gh every
// smoke gets (smokeGh.mjs). Its agent is a fake one that lingers. The built app runs with a temp HOME
// and --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app
// server, and the window opens a project made through the SDK. A worktree has two commits and
// uncommitted work. Through the DOM and the SDK it checks:
//   - the welcome lists review, and the window's feature follows it;
//   - the source picker: the branch against its base, uncommitted only, and one commit of the newest
//     (the newest first; another commit picked shows its own files); selecting another worktree and
//     back resets it to the branch;
//   - Escape cancels a new comment (focus back on its line's +), ⌘/Ctrl+Enter saves one;
//   - a line comment written on a commit's diff is saved on the server's worktree with its source,
//     file, side, line and line text; one added through the SDK (another client) shows up live;
//   - comments on another source are listed as not on this diff; switching to their source shows them
//     under their line;
//   - a commented line that changes on disk shows its comment as outdated, at the file's top, and a
//     comment being written on it moves there with its text;
//   - an edit that another client changed meanwhile is refused (CONFLICT, shown in the bar); Edit
//     and Delete change the draft on the server;
//   - an agent's get_review_comments (MCP) returns the draft the window wrote, each comment's outdated
//     worked out, and changes nothing;
//   - with the worktree unloaded, or loaded with no session, Send is disabled and says why;
//   - Send to session lists the worktree's sessions newest first, with their agent and status; the
//     menu closes on Escape and a click outside; a send on a draft that changed unseen is refused
//     (CONFLICT, shown in the bar); picking the older one queues the
//     review as one prompt there (the prompt reviewPrompt makes from the draft), none on the other,
//     and the draft is cleared on the server and in the window;
//   - Discard disarms on blur and after a few seconds, leaving the draft; confirmed, it clears it and
//     the bar goes;
//   - the renderer never holds the server token; no error dialogs, console or page errors.
//
// Prints SERVER REVIEW SMOKE PASS (n checks) or SERVER REVIEW SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { reviewPrompt } from '../src/shared/review.ts'
import { closeApp, killIfOurs } from './smokeTeardown.mjs'

const WATCHDOG_MS = 180_000
const DAEMON_READY_MS = 15_000

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, expected, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-review-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

const repo = join(serverHome, 'repos', 'app')
const worktree = `${repo}-feature-x`
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
git('-C', repo, 'add', '.')
git('-C', repo, 'commit', '-q', '-m', 'init')

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message })
  return { response: 0, checkboxChecked: false }
}
`
)

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let daemon = null
let app = null
let sdk = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  await closeApp(app)
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill()
    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
  }
  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER REVIEW SMOKE PASS (${checks.length} checks)` : `SERVER REVIEW SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The server and a project with a worktree: two commits and uncommitted work ----------------

  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      output += b
      if (/listening on ws:\/\//.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    })
    d.stderr.on('data', (b) => {
      output += b
      process.stderr.write(b)
    })
    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
  })
  const url = `ws://127.0.0.1:${port}`
  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-review-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the welcome lists review', sdk.welcome?.capabilities.includes('review'), true)
  const { projectId } = await sdk.request('project.create', { name: 'review', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2\n')
  git('-C', worktree, 'add', '.')
  git('-C', worktree, 'commit', '-q', '-m', 'add b')
  writeFileSync(join(worktree, 'a.txt'), 'one\nTWO\nthree\n')
  git('-C', worktree, 'commit', '-q', '-am', 'shout two')
  const shaOf = (rev) => git('-C', worktree, 'rev-parse', rev).trim()
  const newestSha = shaOf('HEAD')
  const olderSha = shaOf('HEAD~1')
  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2 edited\n')
  writeFileSync(join(worktree, 'c.txt'), 'c\n')
  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id
  const feature = async () => (await project()).repositories[0].worktrees.find((w) => w.id === featureId)
  const draft = async () => (await feature()).review ?? null
  const ref = { projectId, worktreeId: featureId }

  // ---- 2. The app, with the server saved, and the project's window ---------------------------------

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
  await win.evaluate(async ([id, pid]) => {
    const { opened } = await window.api.openServerProject(id, pid, 'review', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's review feature follows the server's capability", await until(() => win.evaluate(() => window.__features().review), true), true)

  // ---- 3. The source picker ------------------------------------------------------------------------

  const detail = win.locator('.server-window .detail')
  await rows.filter({ hasText: 'feature-x' }).click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  await detail.locator('.panel-btn[title^="Changes"]').click()
  const panel = detail.locator('.changes-panel')
  const shownFiles = () => panel.locator('.changes-path').allTextContents()
  const kind = panel.locator('.changes-source-kind')
  const picked = async () => [await kind.inputValue(), await kind.locator('option:checked').textContent()]
  check('the picker starts on the branch against its base (named once the summary is in)', await until(picked, ['branch', 'Branch vs main']), ['branch', 'Branch vs main'])
  check('the branch: its commits and the uncommitted work', await until(shownFiles, ['a.txt', 'b.txt', 'c.txt']), ['a.txt', 'b.txt', 'c.txt'])
  await kind.selectOption('uncommitted')
  check('uncommitted only: the edit and the untracked file', await until(shownFiles, ['b.txt', 'c.txt']), ['b.txt', 'c.txt'])
  await kind.selectOption('commit')
  const commitSelect = panel.locator('.changes-source-commit')
  check('one commit: the newest is picked first', await until(() => commitSelect.inputValue().catch(() => null), newestSha), newestSha)
  check('the commit list: newest first, with subjects', await commitSelect.locator('option').allTextContents(), [`${newestSha.slice(0, 7)} shout two`, `${olderSha.slice(0, 7)} add b`, `${shaOf('main').slice(0, 7)} init`])
  check("the newest commit's files", await until(shownFiles, ['a.txt']), ['a.txt'])
  await commitSelect.selectOption(olderSha)
  check("another commit's files", await until(shownFiles, ['b.txt']), ['b.txt'])
  await commitSelect.selectOption(newestSha)
  await until(shownFiles, ['a.txt'])
  // Another worktree selected and back: the tab shows the branch again.
  await rows.filter({ hasNotText: 'feature-x' }).first().click()
  await until(async () => (await detail.locator('.detail-path').textContent()).includes('feature-x'), false)
  await rows.filter({ hasText: 'feature-x' }).click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  await detail.locator('.panel-btn[title^="Changes"]').click()
  check('a selection change resets the source to the branch', await until(() => kind.inputValue(), 'branch'), 'branch')
  await kind.selectOption('commit')
  await until(() => commitSelect.inputValue().catch(() => null), newestSha)
  await until(shownFiles, ['a.txt'])

  // ---- 4. A line comment, on the newest commit's diff -----------------------------------------------

  const fileBox = (path) => panel.locator(`.changes-file:has(.changes-path[title="${path}"])`)
  const line = (path, side, n) => fileBox(path).locator(`.changes-line[data-side="${side}"][data-line="${n}"]`)
  await line('a.txt', 'new', 2).waitFor({ timeout: 10_000 })
  check('before any comment there is no review bar', await panel.locator('.review-bar').count(), 0)
  const focusedLine = () => win.evaluate(() => {
    const el = document.activeElement
    const row = el?.classList.contains('review-add') ? el.closest('.changes-line') : null
    return row ? `${row.dataset.side} ${row.dataset.line}` : null
  })
  await line('a.txt', 'new', 1).hover()
  await line('a.txt', 'new', 1).locator('.review-add').click()
  await panel.locator('.review-editor textarea').fill('Never mind')
  await panel.locator('.review-editor textarea').press('Escape')
  check('Escape cancels a new comment, focus back on its line', [await panel.locator('.review-editor').count(), await until(focusedLine, 'new 1')], [0, 'new 1'])
  await line('a.txt', 'new', 2).hover()
  await line('a.txt', 'new', 2).locator('.review-add').click()
  await panel.locator('.review-editor textarea').fill('Why shout?')
  await panel.locator('.review-editor textarea').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const first = await until(async () => (await draft())?.comments.length ?? 0, 1)
  check('the comment is saved on the server', first, 1)
  const saved = (await draft()).comments[0]
  check('with its source, file, side, line and line text', { source: saved.source, path: saved.path, side: saved.side, line: saved.line, lineText: saved.lineText, body: saved.body }, { source: { kind: 'commit', sha: newestSha }, path: 'a.txt', side: 'new', line: 2, lineText: 'TWO', body: 'Why shout?' })
  check('it shows under its line', await until(() => fileBox('a.txt').locator('.review-comment .review-comment-body').allTextContents(), ['Why shout?']), ['Why shout?'])
  check('⌘/Ctrl+Enter saved it: the editor closed, focus back on its line', [await panel.locator('.review-editor').count(), await until(focusedLine, 'new 2')], [0, 'new 2'])
  check('the bar counts it', await until(() => panel.locator('.review-count').textContent(), 'Review · 1 comment'), 'Review · 1 comment')
  const sendButton = panel.locator('.review-send')
  check('with the worktree unloaded and no session, Send is disabled and says why', [await sendButton.isDisabled(), await sendButton.getAttribute('title')], [true, 'Load the worktree to send the review to one of its sessions'])

  // ---- 5. Another client's comment, live; other sources; outdated -----------------------------------

  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'b.txt', side: 'new', line: 2, lineText: 'b2 edited', body: 'Another client' })
  check("another client's comment shows up live", await until(() => panel.locator('.review-count').textContent(), 'Review · 2 comments'), 'Review · 2 comments')
  check('as not on this diff', await until(() => panel.locator('.review-elsewhere-toggle').textContent().catch(() => null), '1 not on this diff ▸'), '1 not on this diff ▸')
  await panel.locator('.review-elsewhere-toggle').click()
  check('listed with its source and place', await panel.locator('.review-elsewhere .review-comment-where').allTextContents(), ['Uncommitted changes · b.txt, line 2: b2 edited'])
  await kind.selectOption('uncommitted')
  check('on its own source it shows under its line', await until(() => fileBox('b.txt').locator('.changes-row:has(.changes-line[data-line="2"][data-side="new"]) .review-comment-body').allTextContents(), ['Another client']), ['Another client'])
  await line('b.txt', 'new', 2).hover()
  await line('b.txt', 'new', 2).locator('.review-add').click()
  await panel.locator('.review-editor textarea').fill('Half typed')
  writeFileSync(join(worktree, 'b.txt'), 'b1\nb2 changed again\n')
  check('its line changed on disk: the comment is outdated, at the file top', await until(() => fileBox('b.txt').locator('.review-outdated .review-comment .review-comment-where').allTextContents(), ['line 2: b2 edited']), ['line 2: b2 edited'])
  check('titled outdated', await fileBox('b.txt').locator('.review-outdated-title').textContent(), 'Outdated: its line has changed')
  const stray = fileBox('b.txt').locator('.review-outdated .review-stray-editor')
  check('a comment being written on the line moves there too, its text kept', [await stray.locator('.review-comment-where').textContent().catch(() => null), await stray.locator('textarea').inputValue().catch(() => null)], ['line 2: b2 edited', 'Half typed'])
  await stray.locator('.review-btn', { hasText: 'Cancel' }).click()
  check('Cancel closes it, nothing added', [await panel.locator('.review-editor').count(), (await draft()).comments.length], [0, 2])

  // ---- 6. Edit and Delete ------------------------------------------------------------------------

  const outdatedComment = fileBox('b.txt').locator('.review-outdated .review-comment')
  const otherId = (await draft()).comments.find((c) => c.body === 'Another client').id
  await outdatedComment.locator('.review-link', { hasText: 'Edit' }).click()
  await outdatedComment.locator('textarea').fill('Mine')
  // Another client edits it while this window's edit is open: the save is refused, its text kept.
  await sdk.request('review.edit', { ...ref, commentId: otherId, body: 'Theirs' })
  await outdatedComment.locator('.review-btn', { hasText: 'Save' }).click()
  check('an edit that another client changed meanwhile is refused (CONFLICT)', await until(() => panel.locator('.review-error').textContent().catch(() => null), 'Could not save the comment: the comment changed since you read it'), 'Could not save the comment: the comment changed since you read it')
  check('the server keeps theirs, the editor keeps mine', [(await draft()).comments.map((c) => c.body), await outdatedComment.locator('textarea').inputValue()], [['Why shout?', 'Theirs'], 'Mine'])
  await outdatedComment.locator('.review-btn', { hasText: 'Cancel' }).click()
  await outdatedComment.locator('.review-link', { hasText: 'Edit' }).click()
  await outdatedComment.locator('textarea').fill('Still matters')
  await outdatedComment.locator('.review-btn', { hasText: 'Save' }).click()
  check('Edit saves the new text on the server', await until(async () => (await draft())?.comments.map((c) => c.body), ['Why shout?', 'Still matters']), ['Why shout?', 'Still matters'])
  check('focus back on its Edit', await until(() => win.evaluate(() => document.activeElement?.classList.contains('review-edit') ? document.activeElement.textContent : null), 'Edit'), 'Edit')
  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'c.txt', side: 'new', line: 1, lineText: 'c', body: 'Drop me' })
  const dropMe = fileBox('c.txt').locator('.review-comment', { hasText: 'Drop me' })
  await dropMe.waitFor({ timeout: 10_000 })
  await dropMe.locator('.review-link', { hasText: 'Delete' }).click()
  check('Delete removes it on the server', await until(async () => (await draft())?.comments.map((c) => c.body), ['Why shout?', 'Still matters']), ['Why shout?', 'Still matters'])

  // ---- 7. An agent reads the draft the window wrote (MCP get_review_comments) ------------------------

  await sdk.request('worktree.load', ref)
  check('loaded with no session, Send is disabled and says why', await until(async () => [await sendButton.isDisabled(), await sendButton.getAttribute('title')], [true, 'Start a session in this worktree to send the review to']), [true, 'Start a session in this worktree to send the review to'])
  // The worktree's sessions: their launch writes the project's MCP config, which the agent reads.
  const older = await sdk.request('session.start', { ...ref, title: 'Older', cols: 120, rows: 30 })
  const newer = await sdk.request('session.start', { ...ref, title: 'Newer', cols: 120, rows: 30 })
  const mcpFile = join(data, 'mcp', `${projectId}.json`)
  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const rpc = async (method, params) => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
    return res.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? []
  check('the agent’s tools list get_review_comments', listed.includes('get_review_comments'), true)
  const called = await rpc('tools/call', { name: 'get_review_comments', arguments: { worktree: 'feature-x' } })
  const seen = JSON.parse(called.result?.content?.[0]?.text ?? '{}')
  check('get_review_comments returns the draft the window wrote, outdated worked out', [called.result?.isError === true, seen.revision === (await draft()).revision, seen.comments?.map((c) => ({ file: c.file, side: c.side, line: c.line, lineText: c.lineText, comment: c.comment, source: c.sourceLabel, outdated: c.outdated }))], [false, true, [
    { file: 'a.txt', side: 'new', line: 2, lineText: 'TWO', comment: 'Why shout?', source: `Commit ${newestSha.slice(0, 7)}`, outdated: false },
    { file: 'b.txt', side: 'new', line: 2, lineText: 'b2 edited', comment: 'Still matters', source: 'Uncommitted changes', outdated: true }
  ]])
  check('and leaves it as it was', (await draft()).comments.length, 2)

  // ---- 8. Send to session: newest first, the older picked ---------------------------------------------

  check('with sessions, Send is enabled', await until(() => sendButton.isDisabled(), false), false)
  await sendButton.click()
  check('it lists the sessions newest first', await panel.locator('.review-send-target .review-send-title').allTextContents(), ['Newer', 'Older'])
  check('each with its agent and status', (await panel.locator('.review-send-target .review-send-detail').allTextContents()).map((t) => /^Claude · [a-z]+$/.test(t)), [true, true])
  await win.keyboard.press('Escape')
  check('Escape closes the menu', await panel.locator('.review-send-menu').count(), 0)
  await sendButton.click()
  await panel.locator('.review-count').click()
  check('a click outside closes it', await panel.locator('.review-send-menu').count(), 0)

  // A send on a draft that changed unseen: the window is made to show the draft as it was
  // before another client's comment (the store's copy put back), and the server refuses it.
  const shown = await draft()
  const extra = await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'c.txt', side: 'new', line: 1, lineText: 'c', body: 'Unseen' })
  await until(() => panel.locator('.review-count').textContent(), 'Review · 3 comments')
  await win.evaluate(([wt, stale]) => {
    const s = window.__store.getState()
    window.__store.setState({ project: { ...s.project, repositories: s.project.repositories.map((r) => (r.worktreeReviews?.[wt] ? { ...r, worktreeReviews: { ...r.worktreeReviews, [wt]: stale } } : r)) } })
  }, [worktree, shown])
  await until(() => panel.locator('.review-count').textContent(), 'Review · 2 comments')
  await sendButton.click()
  await panel.locator('.review-send-target', { hasText: 'Older' }).click()
  check('a send on a draft that changed unseen is refused (CONFLICT)', await until(() => panel.locator('.review-error').textContent().catch(() => null), 'Could not send the review to Older: the review changed since you read it'), 'Could not send the review to Older: the review changed since you read it')
  check('nothing queued, the draft kept', [(await feature()).sessions.map((s) => s.queue.length), (await draft()).comments.length], [[0, 0], 3])
  await sdk.request('review.remove', { ...ref, commentId: extra.commentId })
  await until(() => panel.locator('.review-count').textContent(), 'Review · 2 comments')
  check('the window has the draft as the server does again', await until(() => win.evaluate((wt) => window.__store.getState().project.repositories.find((r) => r.worktreeReviews?.[wt])?.worktreeReviews[wt].revision ?? null, worktree), (await draft()).revision), (await draft()).revision)

  await sendButton.click()
  const before = await draft()
  const expected = reviewPrompt((await feature()).name, before.comments)
  await panel.locator('.review-send-target', { hasText: 'Older' }).click()
  const queueOf = async (id) => (await feature()).sessions.find((s) => s.id === id)?.queue ?? []
  check('the review is queued on the session picked, as one prompt', await until(() => queueOf(older.sessionId), [expected]), [expected])
  check('none on the other', await queueOf(newer.sessionId), [])
  check('the draft is cleared on the server', await draft(), null)
  check('and in the window', await until(() => panel.locator('.review-bar').count(), 0), 0)
  check('the queued prompt names the sources, files and lines', (await queueOf(older.sessionId))[0]?.split('\n\n').slice(1), [
    `## Commit ${newestSha.slice(0, 7)}`,
    'a.txt, line 2:\n> TWO\nWhy shout?',
    '## Uncommitted changes',
    'b.txt, line 2:\n> b2 edited\nStill matters'
  ])

  // ---- 9. Discard -----------------------------------------------------------------------------------

  await sdk.request('review.add', { ...ref, source: { kind: 'uncommitted' }, path: 'c.txt', side: 'new', line: 1, lineText: 'c', body: 'Throw away' })
  await panel.locator('.review-discard').waitFor({ timeout: 10_000 })
  await panel.locator('.review-discard').click()
  await panel.locator('.review-discard-confirm').waitFor({ timeout: 5000 })
  await panel.locator('.review-count').click()
  check('Discard unconfirmed (focus left) disarms, the draft kept', [await panel.locator('.review-discard-confirm').count(), await panel.locator('.review-discard').count(), (await draft())?.comments.length], [0, 1, 1])
  await panel.locator('.review-discard').click()
  await panel.locator('.review-discard-confirm').waitFor({ timeout: 5000 })
  check('Discard unconfirmed for a few seconds disarms, the draft kept', [await until(() => panel.locator('.review-discard-confirm').count(), 0, 8000), (await draft())?.comments.length], [0, 1])
  await panel.locator('.review-discard').click()
  await panel.locator('.review-discard-confirm').click()
  check('Discard, confirmed, clears the draft on the server', await until(draft, null), null)
  check('and the bar goes', await until(() => panel.locator('.review-bar').count(), 0), 0)

  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
  check("the renderer's store and page never hold the server token", held.includes(token), false)
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
