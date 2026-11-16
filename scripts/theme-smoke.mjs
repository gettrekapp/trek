// scripts/theme-smoke.mjs — theme plugins in a project window (theme plugins phases 2 and 3).
//
// Run: npm run smoke:theme   (builds the app with out/server, then runs this script)
//
// On the run's own Local server, with the example theme (plugins/example-theme):
//   - before any theme is installed, Settings shows no Theme row;
//   - `trek-server plugin add --local` installs it while the server runs: the window hears
//     plugins.list and the Theme row appears, on Default;
//   - choosing it restyles the window: --bg on :root, <html data-theme>, one <style
//     data-trek-theme>, and the theme's Runtime mounted in its host (the project id it marked);
//     the choice is in this app's app-settings.json under `<entry>:<project>`;
//   - a second project in the same window has the default look; back on the first, the theme;
//   - the bundle replaced on the server: the default look, Settings offers Apply; Apply brings
//     the new bundle's look and records its hash;
//   - the theme removed: the default look, "Not installed on this server", the choice kept;
//   - from the app (phase 3): the Installed themes row is there with no theme installed; a URL
//     that is not https is refused in the row, unsent; a file that is not a package is refused
//     with the server's reason; the example theme installs from its .trekplugin file and is
//     listed, not chosen; chosen, then removed with Remove after its confirmation: the default
//     look, and the row no longer lists it;
//   - no error dialogs, no console or page errors.
//
// The teardown (scripts/smokeTeardown.mjs) always stops the run's server. The app is launched
// with a temp HOME and a temp --user-data-dir. Prints THEME SMOKE PASS (n checks) or THEME SMOKE
// FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { openSettingsTab } from './smokeSettings.mjs'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { sha256Hex } from '../src/renderer/src/plugins/installedLoader.ts'
import { buildExampleTheme } from '../plugins/example-theme/build.mjs'
import { localTeardown, makeFinish } from './smokeTeardown.mjs'
import { SMOKE_SHELL } from './smokeShell.mjs'

const WATCHDOG_MS = 180_000
const DEFAULT_BG = '#111113'
const THEME_BG = '#0f1420'
const REPLACED_BG = '#201014'

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
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-theme-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const logPath = join(profile, 'server.log')
// From here on, the work dir goes on exit, whatever throws. No agents run here.
const { info, teardown } = localTeardown({ root, home, work, agentPids: join(work, 'agent-pids'), isAgent: () => false })
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [] }))

const makeRepo = (name) => {
  const path = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  writeFileSync(join(path, 'file.txt'), 'one\n')
  execFileSync('git', ['-C', path, '-c', 'user.name=s', '-c', 'user.email=s@s', 'add', '.'])
  execFileSync('git', ['-C', path, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-q', '-m', 'init'])
  return path
}
const repoOne = makeRepo('one')
const repoTwo = makeRepo('two')

// The example theme, and the same theme with another background: a replaced bundle.
const pkg = await buildExampleTheme()
const replaced = { manifest: pkg.manifest, client: pkg.client.replaceAll(THEME_BG, REPLACED_BG) }
if (replaced.client === pkg.client) throw new Error(`the example theme's bundle has no ${THEME_BG} to replace`)
const packagePath = join(work, 'example-theme.trekplugin')
const replacedPath = join(work, 'replaced', 'example-theme.trekplugin')
mkdirSync(join(work, 'replaced'))
writeFileSync(packagePath, JSON.stringify(pkg))
writeFileSync(replacedPath, JSON.stringify(replaced))
const sha = await sha256Hex(pkg.client)
const replacedSha = await sha256Hex(replaced.client)

// Main's message boxes: recorded, and answered with their confirm button (index 1).
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null })
  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: false }
}
`
)

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  ...(SMOKE_SHELL ? { SHELL: SMOKE_SHELL } : {}),
  TREK_NO_WINDOW_RESTORE: '1',
  TREK_NO_UPDATE_CHECK: '1'
}
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

/** `trek-server plugin <args> --local` on the run's Local server's data dir, as a person would run it. */
const pluginCommand = (...args) => {
  const run = spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'plugin', ...args, '--local', '--local-profile', 'dev'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000
  })
  if (run.status !== 0) console.error(`trek-server plugin ${args.join(' ')}: ${run.stdout}${run.stderr}`)
  return run.status
}

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
const finish = makeFinish({
  getApp: () => app,
  beforeClose: () => sdk?.close(),
  teardown: () => teardown(() => {}),
  report: (reason) => {
    const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
    const code = reason ? 1 : exitCode
    console.log(code === 0 ? `THEME SMOKE PASS (${checks.length} checks)` : `THEME SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
    return code
  }
})
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The app, its Local server, two projects ---------------------------------------------

  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'theme-smoke' })
  sdk.connect()
  if ((await until(() => sdk.status, 'connected', 10_000)) !== 'connected') throw new Error(`the SDK never connected to the Local server (${sdk.status})`)
  for (const path of [repoOne, repoTwo]) await sdk.request('server.addRepo', { path })
  const { projectId: first } = await sdk.request('project.create', { name: 'first', repositories: [{ path: repoOne, name: 'one' }] })
  const { projectId: second } = await sdk.request('project.create', { name: 'second', repositories: [{ path: repoTwo, name: 'two' }] })

  const sw = win.locator('.server-window')
  // The window shows a project once the store holds that project (by its name: a project file has
  // no id) and its rows are drawn: a row alone could be the previous project's.
  const show = async (projectId, name) => {
    await win.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId: id }), projectId)
    await win.waitForFunction(
      ({ id, name }) => {
        const state = window.__store.getState()
        return state.serverWindow?.projectId === id && state.project?.name === name && !!document.querySelector('.server-window .wt-row')
      },
      { id: projectId, name },
      { timeout: 15_000 }
    )
  }
  const settings = sw.locator('.settings-panel')
  const openSettings = async () => {
    if (!(await settings.isVisible())) await sw.locator('.sidebar button[title="App settings"]').click()
    await settings.waitFor({ timeout: 5000 })
    await openSettingsTab(settings, 'General')
  }
  const themeSelect = settings.locator('select[aria-label="Theme"]')
  // `has` is matched inside each row: a locator from the page, not one that starts at .server-window.
  const themeRow = settings.locator('.settings-row', { has: win.locator('select[aria-label="Theme"]') })
  const installRow = settings.locator('.theme-install')
  const installNote = installRow.locator('.settings-desc')
  const installFileInput = installRow.locator('input[type="file"]')
  /** What a theme changes in the page. */
  const look = () =>
    win.evaluate(() => ({
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      theme: document.documentElement.dataset.theme ?? null,
      styles: document.querySelectorAll('style[data-trek-theme]').length,
      runtime: document.documentElement.dataset.exampleTheme ?? null
    }))
  const DEFAULT_LOOK = { bg: DEFAULT_BG, theme: null, styles: 0, runtime: null }
  const storedThemes = () => {
    try {
      return JSON.parse(readFileSync(join(userData, 'app-settings.json'), 'utf8')).themes ?? {}
    } catch {
      return {}
    }
  }

  await win.evaluate(async (projectId) => {
    await window.api.openServerProject('local', projectId, 'first', 'Local')
  }, first)
  await show(first, 'first')

  // ---- 2. No themes: no Theme row --------------------------------------------------------------

  await openSettings()
  check('with no theme installed, Settings shows no Theme row', await themeSelect.count(), 0)
  check('and the window has the default look', await look(), DEFAULT_LOOK)
  check('but the Installed themes row is there, with its two buttons and no theme listed', [await until(() => installRow.locator('button').allTextContents(), ['Install from file…', 'Install from URL…']), await installRow.locator('.theme-list li').count()], [['Install from file…', 'Install from URL…'], 0])

  // ---- 3. Installed on the running server: the row appears ------------------------------------

  check('trek-server plugin add --local installs the example theme', pluginCommand('add', packagePath), 0)
  check(
    "the SDK's welcome follows plugins.list",
    await until(() => (sdk.welcome?.plugins ?? []).filter((p) => p.type === 'theme').map((p) => [p.id, p.sha256]), [['example-theme', sha]]),
    [['example-theme', sha]]
  )
  check('the Theme row appears', await until(() => themeSelect.count(), 1), 1)
  check('on Default, with the theme by its name', [await themeSelect.inputValue(), await themeSelect.locator('option').allTextContents()], ['', ['Default', 'Example theme']])
  check('installing a theme changes nothing by itself', await look(), DEFAULT_LOOK)

  // ---- 4. Chosen: the window is restyled --------------------------------------------------------

  await themeSelect.selectOption('example-theme')
  const THEMED = { bg: THEME_BG, theme: 'example-theme', styles: 1, runtime: first }
  check('choosing it restyles the window, and mounts its Runtime in its host', await until(look, THEMED), THEMED)
  check("the choice is in this app's settings, for this server and project", await until(storedThemes, { [`local:${first}`]: { id: 'example-theme', sha256: sha } }), {
    [`local:${first}`]: { id: 'example-theme', sha256: sha }
  })
  check('the row describes the theme', await themeRow.locator('.settings-desc').textContent(), 'A blue-tinted look: the reference theme for plugin authors.')

  // ---- 5. Another project: the default look; back: the theme ----------------------------------

  await show(second, 'second')
  check('a second project has the default look', await until(look, DEFAULT_LOOK), DEFAULT_LOOK)
  await openSettings()
  check('and its Theme row is on Default', await themeSelect.inputValue(), '')
  await show(first, 'first')
  check('back on the first project, its theme applies again', await until(look, THEMED), THEMED)

  // ---- 6. The bundle replaced on the server: default until Apply ------------------------------

  check('the bundle is replaced on the server', pluginCommand('add', replacedPath), 0)
  check('the window returns to the default look', await until(look, DEFAULT_LOOK), DEFAULT_LOOK)
  await openSettings()
  check(
    'Settings says it was updated and offers Apply',
    [await until(() => themeRow.locator('.settings-desc').getAttribute('data-theme-note'), 'apply'), await themeRow.locator('button', { hasText: 'Apply' }).count(), await themeSelect.inputValue()],
    ['apply', 1, 'example-theme']
  )
  check('the accepted hash is still the old one', storedThemes()[`local:${first}`], { id: 'example-theme', sha256: sha })
  await themeRow.locator('button', { hasText: 'Apply' }).click()
  const REPLACED = { bg: REPLACED_BG, theme: 'example-theme', styles: 1, runtime: first }
  check("Apply brings the new bundle's look", await until(look, REPLACED), REPLACED)
  check('and records its hash', await until(() => storedThemes()[`local:${first}`], { id: 'example-theme', sha256: replacedSha }), { id: 'example-theme', sha256: replacedSha })
  check('Apply is gone', await until(() => themeRow.locator('button', { hasText: 'Apply' }).count(), 0), 0)

  // ---- 7. Removed: the default look, the choice kept ------------------------------------------

  check('the theme is removed on the server', pluginCommand('remove', 'example-theme'), 0)
  check('the window returns to the default look', await until(look, DEFAULT_LOOK), DEFAULT_LOOK)
  check(
    'Settings says it is not installed, and still shows the choice',
    [await until(() => themeRow.locator('.settings-desc').textContent(), 'Not installed on this server. The window shows the default look.'), await themeSelect.inputValue()],
    ['Not installed on this server. The window shows the default look.', 'example-theme']
  )
  await themeSelect.selectOption('')
  check('Default clears the choice, and with no themes the row goes', [await until(() => themeSelect.count(), 0), await until(storedThemes, {})], [0, {}])

  // ---- 8. From the app: a refused URL, a bad file, install from a file, Remove ---------------

  await openSettings()
  await installRow.locator('button', { hasText: 'Install from URL…' }).click()
  const urlInput = installRow.locator('input[aria-label="Theme package URL"]')
  await urlInput.fill('http://themes.test/example-theme.trekplugin')
  await installRow.locator('.theme-url button[type="submit"]').click()
  check('a URL that is not https is refused in the row', [await until(() => installNote.getAttribute('data-theme-install'), 'problem'), await installNote.textContent()], ['problem', 'The URL must start with https://.'])
  await installRow.locator('.theme-url button', { hasText: 'Cancel' }).click()
  check('Cancel closes the URL form and clears the message', [await until(() => urlInput.count(), 0), await installNote.getAttribute('data-theme-install')], [0, 'about'])

  const notPackage = join(work, 'not-a-package.trekplugin')
  writeFileSync(notPackage, JSON.stringify({ manifest: { id: 'nope' }, client: 'export default 1' }))
  await installFileInput.setInputFiles(notPackage)
  check('a file that is not a package is refused', await until(() => installNote.getAttribute('data-theme-install'), 'problem'), 'problem')
  check("with the server's reason, and nothing is installed", [/version must be a semver version/.test((await installNote.textContent()) ?? ''), await installRow.locator('.theme-list li').count(), await themeSelect.count()], [true, 0, 0])

  await installFileInput.setInputFiles(packagePath)
  check('the example theme installs from its file', await until(() => installNote.textContent(), 'Installed Example theme 1.0.0.'), 'Installed Example theme 1.0.0.')
  check('it is listed in the row, with Remove', [await until(() => installRow.locator('.theme-list li').count(), 1), await installRow.locator('.theme-list li button').allTextContents()], [1, ['Remove']])
  check('and offered in the Theme row, not chosen', [await until(() => themeSelect.count(), 1), await themeSelect.inputValue(), await look()], [1, '', DEFAULT_LOOK])
  check('the server has it', await until(() => (sdk.welcome?.plugins ?? []).filter((p) => p.type === 'theme').map((p) => [p.id, p.sha256]), [['example-theme', sha]]), [['example-theme', sha]])

  await themeSelect.selectOption('example-theme')
  check('chosen, it applies', await until(look, THEMED), THEMED)
  await installRow.locator('.theme-list li button', { hasText: 'Remove' }).click()
  check('Remove asks first, naming the theme', (await until(async () => (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.message === 'Remove "Example theme" from this server?').length, 1)), 1)
  check('then the theme is gone from the server', await until(() => (sdk.welcome?.plugins ?? []).filter((p) => p.type === 'theme').length, 0), 0)
  check('the window returns to the default look', await until(look, DEFAULT_LOOK), DEFAULT_LOOK)
  check('the row says so and lists nothing', [await until(() => installNote.textContent(), 'Removed Example theme.'), await installRow.locator('.theme-list li').count()], ['Removed Example theme.', 0])
  check('the choice is kept, as not installed', [await themeSelect.inputValue(), await themeRow.locator('.settings-desc').textContent()], ['example-theme', 'Not installed on this server. The window shows the default look.'])
  await themeSelect.selectOption('')
  check('Default clears it', await until(storedThemes, {}), {})

  const errorBoxes = (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error')
  check('no error dialogs', errorBoxes, [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
