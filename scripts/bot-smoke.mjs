// scripts/bot-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shown = (locator, timeout = 15000) => locator.waitFor({ timeout }).then(() => true, () => false)

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-bot-')))
const repo = join(root, 'repo')
execSync(`git init -q -b master "${repo}"`)
const projectFile = join(root, 'Smoke.trekproj')
const folder = join(root, 'Smoke.trekbot')
const otherFile = join(root, 'Other.trekproj')
const userData = join(root, 'user-data')
const log = join(root, 'args.log')
const pidFile = join(root, 'hang.pid')
const project = {
  version: 3,
  name: 'Smoke',
  claudeCommand: resolve('scripts/fixtures/fake-claude.mjs'),
  repositories: [{ id: 'r', name: 'r', path: repo, worktrees: [], primaryTerminals: [] }]
}
writeFileSync(projectFile, JSON.stringify(project))
// A different project that located the same bot folder.
writeFileSync(otherFile, JSON.stringify({ ...project, name: 'Other', bot: { enabled: true, folder } }))

const screenshot = process.env.BOT_SMOKE_SHOT
let app

/** `restore` turns on the window restoring the smoke scripts normally switch off. User data is temporary here. */
const launch = async ({ restore = false } = {}) => {
  const env = { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_PID_FILE: pidFile }
  if (restore) delete env.TREK_NO_WINDOW_RESTORE
  else env.TREK_NO_WINDOW_RESTORE = '1'
  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd(), env })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)
  return { win, errors }
}

const showBot = (page) =>
  page.evaluate(() => {
    const state = window.__store.getState()
    state.setGlobalView('bot')
    state.setGlobalPanelOpen(true)
  })

const helpers = (win) => ({
  say: async (text) => {
    await win.locator('.bot-input').fill(text)
    await win.locator('.bot-input').press('Enter')
  },
  seen: (text) => shown(win.locator('.bot-event-text', { hasText: text }).first()),
  queuedOne: () => shown(win.locator('.bot-status', { hasText: '1 queued' }), 2000),
  action: (text) => win.locator('.bot-actions button', { hasText: text })
})

const post = async (server, token, body) => {
  const res = await fetch(server.url.replace('/mcp', '/bot/policy'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  })
  return res
}
const serverIn = (path) => {
  const server = Object.values(JSON.parse(readFileSync(path, 'utf8')).mcpServers)[0]
  return { url: server.url, token: server.headers.Authorization.replace('Bearer ', '') }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPid = async () => {
  for (let i = 0; i < 100; i++) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (pid > 0) return pid
    }
    await sleep(100)
  }
  return null
}
/** Closes the app and reports whether the hung turn went with it. */
const closeKills = async (pid) => {
  await app.close()
  app = null
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100)
  return !isAlive(pid)
}

try {
  // --- First run: enable, chat, queueing, approvals, pausing
  {
    const { win, errors } = await launch()
    const { say, seen, queuedOne, action } = helpers(win)
    await win.evaluate(
      ({ project, projectFile }) => window.__store.getState().setProject(project, projectFile),
      { project, projectFile }
    )
    await win.waitForTimeout(500)

    await win.evaluate(() => window.__store.getState().setGlobalView('bot'))
    await win.locator('.global-bar').click()
    await win.locator('.bot-panel button', { hasText: 'Enable bot' }).click()
    await win.locator('.bot-phase').waitFor()
    check('folder created', existsSync(join(folder, 'BOT.md')), true)
    check('opening on the Bot tab starts no session', await win.locator('.global-tab:not(.bot-tab)').count(), 0)

    await say('hello')
    check('chat gets a reply', await seen('echo:hello'), true)
    const argv = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0])
    check('strict MCP config', argv.includes('--strict-mcp-config'), true)
    check('hook settings passed', argv[argv.indexOf('--settings') + 1].includes('/bot/policy'), true)
    check('repo added', argv[argv.indexOf('--add-dir') + 1], repo)

    // --- The policy route
    const session = serverIn(await win.evaluate(() => window.api.getMcpConfigPath()))
    const botConfig = readdirSync(userData).filter((n) => /^mcp-bot-\d+\.json$/.test(n))
    check('one bot config', botConfig.length, 1)
    const bot = serverIn(join(userData, botConfig[0]))
    const call = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(folder, 'BOT.md') } })
    check('an unknown token is refused', (await post(session, 'nonsense', call)).status, 401)
    check('a session token is refused', (await post(session, session.token, call)).status, 403)
    check('a malformed body is a 500', (await post(bot, bot.token, '{not json')).status, 500)
    const idle = await post(bot, bot.token, call)
    check(
      'with no turn running, the bot token gets a denial',
      [idle.status, (await idle.json()).hookSpecificOutput.permissionDecision],
      [200, 'deny']
    )

    await say('HOLD')
    await seen('holding')
    await say('after hold')
    check('second message waits', await queuedOne(), true)
    check('queued message runs', await seen('echo:after hold'), true)

    await say('ASKME')
    check('policy asks, surfaced as a denial', await seen('policy:deny'), true)
    await win.locator('.bot-approval button', { hasText: 'Approve' }).waitFor({ timeout: 15000 })
    check(
      'decision flag set',
      await win.evaluate(() => !!window.__store.getState().decisions.__bot__),
      true
    )
    if (screenshot) await win.screenshot({ path: screenshot })
    await win.locator('.bot-approval button', { hasText: 'Approve' }).click()
    check('approved call is allowed', await seen('policy:allow'), true)
    check('approval is used up', await seen('second:deny'), true)
    check(
      'decision flag cleared',
      await win.evaluate(() => !!window.__store.getState().decisions.__bot__),
      false
    )

    await action('Pause').click()
    await action('Resume').waitFor({ timeout: 15000 })
    await say('while paused')
    check('paused message waits', await queuedOne(), true)
    await action('Resume').click()
    check('resume runs it', await seen('echo:while paused'), true)

    // Left queued and paused for the restart below.
    await action('Pause').click()
    await action('Resume').waitFor({ timeout: 15000 })
    await say('across restart')
    check('message queued before closing', await queuedOne(), true)
    check('no page errors in the first run', errors, [])
    await app.close()
    app = null
  }

  // --- Second run: restart recovery, a held folder, a missing folder, closing mid-turn
  {
    const { win, errors } = await launch()
    const { say, seen, queuedOne, action } = helpers(win)
    await win.evaluate(
      ({ project, projectFile }) =>
        window.__store.getState().setProject({ ...project, bot: { enabled: true } }, projectFile),
      { project, projectFile }
    )
    await showBot(win)
    check('still paused after a restart', await shown(win.locator('.bot-phase', { hasText: 'Paused' })), true)
    check('queued message survives a restart', await queuedOne(), true)
    check('earlier activity is reloaded', await seen('echo:hello'), true)
    await action('Resume').click()
    check('it runs on resume', await seen('echo:across restart'), true)

    // A window opened on a project goes through the same startup path as a restored one.
    check('another project goes to a new window', await win.evaluate((f) => window.api.openProjectPath(f), otherFile), null)
    let other = null
    for (let i = 0; i < 40 && !other; i++) {
      for (const page of app.windows()) {
        const name = await page.evaluate(() => window.__store?.getState().project?.name).catch(() => null)
        if (name === 'Other') other = page
      }
      if (!other) await sleep(250)
    }
    await showBot(other)
    const reason = other.locator('.bot-reason', { hasText: "Another window's bot is using this folder" })
    check('a held folder shows why', await shown(reason), true)
    check(
      'a held folder offers only Disable',
      await other.locator('.bot-actions button').allTextContents(),
      ['Disable']
    )
    check('a held folder takes no messages', await other.locator('.bot-input').isDisabled(), true)
    await other.locator('.bot-actions button', { hasText: 'Disable' }).click()
    check('Disable clears it', await shown(other.locator('.bot-panel button', { hasText: 'Enable bot' })), true)

    renameSync(folder, `${folder}.moved`)
    await say('into the void')
    const missing = win.locator('.bot-approval button')
    check('a missing folder offers Locate', await shown(missing.filter({ hasText: 'Locate folder' })), true)
    check('a missing folder offers Start new', await shown(missing.filter({ hasText: 'Start new' })), true)
    check('a missing folder offers only Disable above', await win.locator('.bot-actions button').allTextContents(), ['Disable'])
    check('a missing folder takes no messages', await win.locator('.bot-input').isDisabled(), true)
    check('the folder is not recreated', existsSync(folder), false)
    await missing.filter({ hasText: 'Start new' }).click()
    check('Start new brings the bot back', await shown(action('Pause')), true)
    check('Start new makes the folder', existsSync(join(folder, 'BOT.md')), true)
    await say('fresh start')
    check('the new bot replies', await seen('echo:fresh start'), true)

    await say('HANG')
    check('final turn is running', await seen('hanging'), true)
    const pid = await readPid()
    check('page errors', errors, [])
    rmSync(pidFile)
    check('closing the app kills the running turn', pid !== null && (await closeKills(pid)), true)
  }

  // --- Third run: really restored at startup, with no help from the test
  {
    writeFileSync(join(userData, 'open-windows.json'), JSON.stringify([{ filePath: projectFile }]))
    const { win, errors } = await launch({ restore: true })
    check('the window is restored', await win.evaluate(() => window.__store.getState().filePath), projectFile)
    // HANG was killed by the close, so it is still owed. The pid file only appears if it runs again.
    const pid = await readPid()
    check('the restored bot reruns the interrupted message', pid !== null, true)
    await showBot(win)
    check('its panel shows it working', await shown(win.locator('.bot-phase', { hasText: 'Working' })), true)
    check('no page errors after restoring', errors, [])
    check('closing kills it again', pid !== null && (await closeKills(pid)), true)
  }
} finally {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
}

const failed = checks.filter((ok) => !ok).length
console.log(failed ? `${failed} check(s) failed` : `All ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
