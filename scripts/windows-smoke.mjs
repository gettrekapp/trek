// scripts/windows-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-windows-')))
const userData = join(root, 'user-data')
const makeProject = (name) => {
  const repo = join(root, `repo-${name}`)
  mkdirSync(repo)
  execSync(
    `git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init`,
    { cwd: repo, shell: '/bin/zsh' }
  )
  const file = join(root, `${name}.trekproj`)
  writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      name,
      repositories: [{ id: `r-${name}`, name, path: repo, worktrees: [] }]
    })
  )
  return { file, repo }
}
const alpha = makeProject('alpha')
const beta = makeProject('beta')
const gamma = makeProject('gamma')

const launch = () =>
  electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd() })

const projectName = (page) => page.evaluate(() => window.__store.getState().project?.name ?? null)

/** The page showing a project: new windows take a moment to load theirs. */
const pageFor = async (app, name) => {
  for (let i = 0; i < 60; i++) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue
      const found = await page.evaluate(() => window.__store?.getState().project?.name).catch(() => null)
      if (found === name) return page
    }
    await sleep(250)
  }
  throw new Error(`No window for project ${name}`)
}

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const waitForWindowCount = async (app, count) => {
  for (let i = 0; i < 40 && (await windowCount(app)) !== count; i++) await sleep(250)
  return windowCount(app)
}
const closeByTitle = (app, title) =>
  app.evaluate(({ BrowserWindow }, title) => {
    BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.close()
  }, title)
const answerDialogs = (app, response) =>
  app.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = async () => ({ response, checkboxChecked: false })
  }, response)

const openIn = async (page, file) => {
  const opened = await page.evaluate((file) => window.api.openProjectPath(file), file)
  if (opened) {
    await page.evaluate((o) => window.__store.getState().setProject(o.project, o.filePath), opened)
  }
  return opened !== null
}

/** Starts a shell in the window and records which pty ids reach it. */
const spawnShell = (page, id, cwd) =>
  page.evaluate(
    async ({ id, cwd }) => {
      window.__seen ??= {}
      window.__unsub ??= window.api.onPtyData((e) => {
        window.__seen[e.id] = (window.__seen[e.id] ?? '') + e.data
      })
      await window.api.spawnPty({ id, cwd, cols: 80, rows: 24 })
    },
    { id, cwd }
  )
const seen = (page, id) => page.evaluate((id) => window.__seen?.[id] ?? '', id)
const waitForOutput = async (page, id, text) => {
  for (let i = 0; i < 40 && !(await seen(page, id)).includes(text); i++) await sleep(250)
  return (await seen(page, id)).includes(text)
}
const isRunning = (marker) => {
  try {
    execSync(`pgrep -f "sleep ${marker}"`)
    return true
  } catch {
    return false
  }
}

const mcpList = async (page) => {
  const path = await page.evaluate(() => window.api.getMcpConfigPath())
  const { url, headers } = JSON.parse(readFileSync(path, 'utf8')).mcpServers['trek-dev']
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_worktrees', arguments: {} }
    })
  })
  return { path, text: (await res.json()).result.content[0].text }
}

let app
try {
  app = await launch()
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.waitForTimeout(800)

  // --- Open flow
  check('empty window takes the project', await openIn(first, alpha.file), true)
  check('first window holds alpha', await projectName(first), 'alpha')
  check('a second project goes elsewhere', await openIn(first, beta.file), false)
  check('it adds a window', await waitForWindowCount(app, 2), 2)
  const a = first
  const b = await pageFor(app, 'beta')
  check('first window keeps alpha', await projectName(a), 'alpha')
  check('reopening alpha adds no window', await openIn(b, alpha.file), false)
  await sleep(500)
  check('still two windows', await windowCount(app), 2)

  // --- Pty routing
  await spawnShell(a, 'pty-a', alpha.repo)
  await spawnShell(b, 'pty-b', beta.repo)
  await a.evaluate(() => window.api.writePty('pty-a', 'echo from-a-$((40+2))\n'))
  await b.evaluate(() => window.api.writePty('pty-b', 'echo from-b-$((40+2))\n'))
  check('a sees its output', await waitForOutput(a, 'pty-a', 'from-a-42'), true)
  check('b sees its output', await waitForOutput(b, 'pty-b', 'from-b-42'), true)
  check('a sees nothing of b', await seen(a, 'pty-b'), '')
  check('b sees nothing of a', await seen(b, 'pty-a'), '')

  // --- MCP routing
  const mcpA = await mcpList(a)
  const mcpB = await mcpList(b)
  check('each window has its own config', mcpA.path !== mcpB.path, true)
  check('a window\'s token reaches its project', mcpA.text.includes(alpha.repo), true)
  check('and not the other one', mcpA.text.includes(beta.repo), false)
  check('b reaches its project', mcpB.text.includes(beta.repo), true)
  check('b not the other one', mcpB.text.includes(alpha.repo), false)

  // --- Save As over another window's file is refused
  await answerDialogs(app, 0)
  await openIn(a, gamma.file)
  const c = await pageFor(app, 'gamma')
  const refused = await c.evaluate(
    ([file]) => window.api.saveProject(file, window.__store.getState().project),
    [alpha.file]
  )
  check('save over an open project is refused', refused, null)
  check('its file is untouched', JSON.parse(readFileSync(alpha.file, 'utf8')).name, 'alpha')

  // --- Closing one window
  const marker = 98000 + Math.floor(Math.random() * 1000)
  await spawnShell(c, 'pty-c', gamma.repo)
  await c.evaluate((m) => window.api.writePty('pty-c', `sleep ${m}\n`), marker)
  for (let i = 0; i < 40 && !isRunning(marker); i++) await sleep(250)
  check('gamma session is running', isRunning(marker), true)
  await c.evaluate(() => {
    const s = window.__store.getState()
    s.setProject({ ...s.project, name: 'gamma' }, s.filePath)
    window.__store.setState({ dirty: true })
  })
  await closeByTitle(app, 'gamma')
  check('closing removes the window', await waitForWindowCount(app, 2), 2)
  for (let i = 0; i < 40 && isRunning(marker); i++) await sleep(250)
  check('its session ended', isRunning(marker), false)
  await b.evaluate(() => window.api.writePty('pty-b', 'echo still-$((1+1))\n'))
  check('other windows keep running', await waitForOutput(b, 'pty-b', 'still-2'), true)

  // --- A never-saved project prompts
  const before = await windowCount(app)
  await app.evaluate(async ({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'New Window').click()
  })
  await waitForWindowCount(app, before + 1)
  await sleep(1000)
  const blank = app.windows().filter((p) => !p.isClosed()).at(-1)
  await blank.waitForLoadState('domcontentloaded')
  await sleep(500)
  check('New Window starts empty', await projectName(blank), null)
  await blank.evaluate(
    ({ repo }) =>
      window.__store.getState().setProject(
        { version: 3, name: 'unsaved', repositories: [{ id: 'r', name: 'unsaved', path: repo, worktrees: [] }] },
        null
      ),
    { repo: gamma.repo }
  )
  await sleep(300)
  await answerDialogs(app, 2)
  await closeByTitle(app, 'unsaved')
  await sleep(800)
  check('Cancel keeps the window', await windowCount(app), before + 1)
  await answerDialogs(app, 1)
  await closeByTitle(app, 'unsaved')
  check("Don't Save closes it", await waitForWindowCount(app, before), before)

  // --- Quit auto-saves, relaunch restores
  await a.evaluate(() => {
    const s = window.__store.getState()
    s.setProject({ ...s.project, azureDevOpsBaseUrl: 'https://saved-on-quit' }, s.filePath)
    window.__store.setState({ dirty: true })
  })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === 'alpha')
      .setBounds({ x: 40, y: 60, width: 1000, height: 700 })
  })
  await sleep(800)
  await app.close()
  check(
    'quit saved the dirty project',
    JSON.parse(readFileSync(alpha.file, 'utf8')).azureDevOpsBaseUrl,
    'https://saved-on-quit'
  )

  app = await launch()
  await app.firstWindow()
  const restoredA = await pageFor(app, 'alpha')
  const restoredB = await pageFor(app, 'beta')
  check('both windows are back', await windowCount(app), 2)
  check('with their projects', [await projectName(restoredA), await projectName(restoredB)], ['alpha', 'beta'])
  check(
    'sessions stay unloaded',
    await restoredA.evaluate(() => Object.keys(window.__store.getState().terminals).length),
    0
  )
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha').getBounds()
  )
  check('alpha keeps its size', [bounds.width, bounds.height], [1000, 700])
  await app.close()

  // --- A server window restores, survives a reload and stays recorded. No server runs:
  // the target only names a server entry, and main keeps it whatever the renderer shows.
  const openWindowsPath = join(userData, 'open-windows.json')
  const serverTarget = { kind: 'server', serverEntryId: 'smoke-missing-server', projectId: 'smoke-project' }
  const isServerTarget = (e) =>
    e.kind === 'server' && e.serverEntryId === serverTarget.serverEntryId && e.projectId === serverTarget.projectId
  const persisted = () => JSON.parse(readFileSync(openWindowsPath, 'utf8'))
  writeFileSync(openWindowsPath, JSON.stringify([...persisted(), serverTarget], null, 2))
  app = await launch()
  await app.firstWindow()
  await pageFor(app, 'alpha')
  await pageFor(app, 'beta')
  check('the server window is restored too', await waitForWindowCount(app, 3), 3)
  let serverPage = null
  for (let i = 0; i < 40 && !serverPage; i++) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue
      const name = await page.evaluate(() => (window.__store ? window.__store.getState().project?.name ?? null : undefined)).catch(() => undefined)
      if (name === null) serverPage = page
    }
    if (!serverPage) await sleep(250)
  }
  // The renderer took its initial state on load; asking again returns the window's server target.
  const serverOf = (page) => page.evaluate(() => window.api.takeInitialWindowState().then((s) => s.server))
  check('it starts with its server target', serverPage && (await serverOf(serverPage)), {
    serverEntryId: serverTarget.serverEntryId,
    projectId: serverTarget.projectId
  })
  await serverPage.reload()
  await serverPage.waitForLoadState('domcontentloaded')
  await sleep(500)
  check('the target survives a reload', await serverOf(serverPage), {
    serverEntryId: serverTarget.serverEntryId,
    projectId: serverTarget.projectId
  })
  await serverPage.evaluate(() => window.api.reportWindowProject(false, null, null))
  await sleep(1200)
  check('projectChanged(false) keeps the server target', await serverOf(serverPage), {
    serverEntryId: serverTarget.serverEntryId,
    projectId: serverTarget.projectId
  })
  check('and it stays recorded', persisted().some(isServerTarget), true)

  // --- Navigation guard: a window never loads a foreign page; http(s) links go to the browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  // A real page that would load if the guard let it.
  const foreign = createServer((_req, res) => res.end('<p>foreign</p>'))
  await new Promise((done) => foreign.listen(0, '127.0.0.1', done))
  const foreignUrl = `http://127.0.0.1:${foreign.address().port}/trek-nav-guard`
  const appUrl = serverPage.url()
  await serverPage.evaluate((u) => (location.href = u), foreignUrl).catch(() => {})
  await sleep(800)
  await serverPage.evaluate(() => window.open('https://example.invalid/trek-open-guard'))
  await serverPage.evaluate(() => window.open('file:///etc/hosts'))
  await sleep(800)
  check('a foreign page is not loaded', serverPage.url(), appUrl)
  check('the api is still there', await serverPage.evaluate(() => typeof window.api), 'object')
  // openUrl first asks Chrome (osascript, up to 3s each) for a matching tab.
  const opened = () => app.evaluate(() => [...globalThis.__opened].sort())
  for (let i = 0; i < 40 && (await opened()).length < 2; i++) await sleep(250)
  await sleep(500)
  check(
    'http(s) links open externally, other schemes are dropped',
    await opened(),
    [foreignUrl, 'https://example.invalid/trek-open-guard'].sort()
  )
  foreign.close()
  check('window.open adds no window', await windowCount(app), 3)
  await app.close()
  check('quit keeps the server target', persisted().some(isServerTarget), true)
  app = null
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed}/${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
