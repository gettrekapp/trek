// scripts/bot-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const gate = join(root, 'gate')
const descendantPids = join(root, 'descendants.pids')
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
let secondApp

const startElectron = async ({ restore = false, dataDir = userData, argLog = log } = {}) => {
  const env = {
    ...process.env,
    FAKE_CLAUDE_LOG: argLog,
    FAKE_CLAUDE_PID_FILE: pidFile,
    FAKE_CLAUDE_PIDS: descendantPids,
    FAKE_CLAUDE_GATE: gate
  }
  if (restore) delete env.TREK_NO_WINDOW_RESTORE
  else env.TREK_NO_WINDOW_RESTORE = '1'
  const started = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${dataDir}`], cwd: process.cwd(), env })
  const win = await started.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)
  return { started, win, errors }
}

/** `restore` turns on the window restoring the smoke scripts normally switch off. User data is temporary here. */
const launch = async (options) => {
  const { started, win, errors } = await startElectron(options)
  app = started
  return { win, errors }
}

/** Opens a project file the way the app does, so nothing here vouches for its contents. */
const openFile = (page, file) =>
  page.evaluate(async (f) => {
    const opened = await window.api.openProjectPath(f)
    window.__store.getState().setProject(opened.project, opened.filePath)
  }, file)
const botView = (page) => page.evaluate(() => window.__store.getState().botView)
const flagged = (page) => page.evaluate(() => !!window.__store.getState().decisions.__bot__)
const isDirty = (page) => page.evaluate(() => window.__store.getState().dirty)
const logLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0)
const allow = (page) => page.locator('.bot-consent button', { hasText: 'Allow' }).click()
const stubFolderDialog = (path) =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
  }, path)
const goneWithin = async (pid, ms) => {
  const deadline = Date.now() + ms
  while (isAlive(pid) && Date.now() < deadline) await sleep(100)
  return !isAlive(pid)
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
const rpc = async (server, method, params) => {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  return res.json()
}
const toolNames = async (server) => (await rpc(server, 'tools/list', {})).result.tools.map((t) => t.name)
const callRefused = async (server, name, args) => {
  const reply = await rpc(server, 'tools/call', { name, arguments: args })
  return !!reply.error || reply.result?.isError === true
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
    check(
      'Enable records consent for this machine',
      JSON.parse(readFileSync(join(userData, 'bot-consent.json'), 'utf8')),
      [{ projectFile, folder, command: project.claudeCommand }]
    )
    check('the bot holds its folder lock', readFileSync(join(folder, 'state', 'lock'), 'utf8'), String(await app.evaluate(() => process.pid)))
    check('opening on the Bot tab starts no session', await win.locator('.global-tab:not(.bot-tab)').count(), 0)

    check('the bar mentions the bot when there are no sessions', await win.locator('.global-hint').textContent(), 'bot: idle')

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

    // --- What each token can reach
    const sessionTools = await toolNames(session)
    check('a session token is not offered request_approval', sessionTools.includes('request_approval'), false)
    check('the bot token is offered request_approval', (await toolNames(bot)).includes('request_approval'), true)
    const approvalArgs = { tool: 'Bash', input: { command: 'git push origin smoke' }, reason: 'r' }
    check('a session token cannot request approval', await callRefused(session, 'request_approval', approvalArgs), true)
    check('a session token cannot call bot_snapshot', await callRefused(session, 'bot_snapshot', {}), true)
    check('the bot token cannot call bot_snapshot', await callRefused(bot, 'bot_snapshot', {}), true)

    // --- The real hook command, as the CLI would run it, during a real turn
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
    const hookCommand = settings.hooks.PreToolUse[0].hooks[0].command
    const runHook = (token, tool_name, tool_input) => {
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: folder, tool_name, tool_input })
      const env = { PATH: process.env.PATH, TREK_BOT_TOKEN: token }
      const ran = spawnSync('sh', ['-c', hookCommand], { input, env, encoding: 'utf8' })
      let decision = null
      try {
        decision = JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision
      } catch {
        // no decision: the exit status is the answer
      }
      return [ran.status, decision]
    }
    await say('GATED')
    check('the turn for the hook checks is running', await seen('gated'), true)
    const readCall = { file_path: join(folder, 'BOT.md') }
    check('the hook allows a free call', runHook(bot.token, 'Read', readCall), [0, 'allow'])
    check('the hook denies an ask-tier call', runHook(bot.token, 'Bash', { command: 'git push origin smoke' }), [0, 'deny'])
    check('the hook exits 2 on a bad token', runHook('nonsense', 'Read', readCall)[0], 2)
    writeFileSync(gate, '')
    check('the gated turn ends', await seen('ungated'), true)
    await win.locator('.bot-phase', { hasText: 'Idle' }).waitFor({ timeout: 15000 })

    await say('HOLD')
    check('the first message is running', await seen('holding'), true)
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
    check('another project asks before using the folder', await shown(other.locator('.bot-consent')), true)
    check('asking raises no flag', await flagged(other), false)
    await allow(other)
    const reason = other.locator('.bot-reason', { hasText: "Another window's bot is using this folder" })
    check('a held folder shows why', await shown(reason), true)
    check(
      'a held folder offers only Disable',
      await other.locator('.bot-actions button').allTextContents(),
      ['Disable']
    )
    check('a held folder takes no messages', await other.locator('.bot-input').isDisabled(), true)
    check('a held folder offers Retry', await shown(other.locator('.bot-approval button', { hasText: 'Retry' })), true)
    await other.locator('.bot-approval button', { hasText: 'Retry' }).click()
    await other.waitForTimeout(300)
    check('Retry reports it is still held', await shown(reason), true)
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

    // --- Locate: only a bot folder, and Disable then Enable keeps it
    const plain = join(root, 'plain')
    mkdirSync(plain)
    await stubFolderDialog(plain)
    await missing.filter({ hasText: 'Locate folder' }).click()
    const notBot = win.locator('.bot-reason', { hasText: "isn't a bot folder" })
    check('Locate refuses an ordinary folder', await shown(notBot), true)
    check('and leaves it untouched', readdirSync(plain), [])
    const moved = `${folder}.moved`
    await stubFolderDialog(moved)
    await missing.filter({ hasText: 'Locate folder' }).click()
    check('Locate brings the bot back', await shown(action('Pause')), true)
    check('the bot runs from the located folder', (await botView(win)).folder, moved)
    await action('Disable').click()
    await win.locator('.bot-panel button', { hasText: 'Enable bot' }).click()
    check('Enable brings it back', await shown(action('Pause')), true)
    check('Enable keeps the located folder', (await botView(win)).folder, moved)
    check('its setting is kept', await win.evaluate(() => window.__store.getState().project.bot), { enabled: true, folder: moved })
    check('Enable makes no default folder', existsSync(folder), false)
    renameSync(moved, `${moved}.again`)
    await say('into the void again')
    check('Start new is offered again', await shown(missing.filter({ hasText: 'Start new' })), true)

    await missing.filter({ hasText: 'Start new' }).click()
    check('Start new brings the bot back', await shown(action('Pause')), true)
    check('Start new makes the folder', existsSync(join(folder, 'BOT.md')), true)
    check('Start new resets the setting', await win.evaluate(() => window.__store.getState().project.bot), { enabled: true })
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

  // --- Fourth run: someone else's project asks first
  {
    const sharedDir = join(root, 'shared')
    const sharedFolder = join(sharedDir, 'Shared.trekbot')
    mkdirSync(join(sharedFolder, 'state'), { recursive: true })
    writeFileSync(join(sharedFolder, 'state', 'state.json'), JSON.stringify({ queue: [{ kind: 'chat', text: 'seeded' }] }))
    const sharedFile = join(sharedDir, 'Shared.trekproj')
    const sharedBytes = JSON.stringify({ ...project, name: 'Shared', bot: { enabled: true } })
    writeFileSync(sharedFile, sharedBytes)
    const sharedLog = join(root, 'shared.log')

    const { win, errors } = await launch({ argLog: sharedLog })
    const { say, seen } = helpers(win)
    await openFile(win, sharedFile)
    await win.waitForTimeout(1500)
    check('opening runs nothing', logLines(sharedLog), 0)
    check('opening touches nothing in the folder', readdirSync(sharedFolder), ['state'])
    check('opening takes no lock', readdirSync(join(sharedFolder, 'state')), ['state.json'])
    const asking = await botView(win)
    check('the view asks', [asking.needsConsent, asking.bound, asking.decision], [true, false, null])
    check('no decision flag', await flagged(win), false)
    check('a loaded project is not dirty', await isDirty(win), false)
    await showBot(win)
    const consent = win.locator('.bot-consent')
    check('the panel shows the folder', await shown(consent.locator('code', { hasText: sharedFolder })), true)
    check('the panel shows the command', await shown(consent.locator('code', { hasText: project.claudeCommand })), true)
    check('the panel says it runs unattended', await shown(consent.locator('p', { hasText: 'unattended' })), true)
    check('nothing is recorded for it yet', readFileSync(join(userData, 'bot-consent.json'), 'utf8').includes(sharedFolder), false)

    await allow(win)
    check('Allow runs the seeded message', await seen('echo:seeded'), true)
    check('the CLI ran once', logLines(sharedLog), 1)
    check('starting repairs the folder', existsSync(join(sharedFolder, 'BOT.md')) && existsSync(join(sharedFolder, 'journal')), true)
    check('consent is on this machine', readFileSync(join(userData, 'bot-consent.json'), 'utf8').includes(sharedFolder), true)
    await win.locator('.bot-phase', { hasText: 'Idle' }).waitFor({ timeout: 15000 })
    check('a turn leaves the project clean', await isDirty(win), false)
    check('a turn leaves the project file alone', readFileSync(sharedFile, 'utf8'), sharedBytes)
    const inFolder = readdirSync(sharedFolder, { recursive: true }).map(String)
    check('consent is not in the bot folder', inFolder.some((n) => n.includes('consent')), false)

    const withCommand = (command) =>
      win.evaluate(
        ([file, command]) => {
          const state = window.__store.getState()
          state.setProject({ ...state.project, claudeCommand: command }, file)
        },
        [sharedFile, command]
      )
    const changed = `${project.claudeCommand} --changed`
    await withCommand(changed)
    check('a changed command asks again', await shown(consent.locator('code', { hasText: '--changed' })), true)
    check('and the old bot has stopped', (await botView(win)).bound, false)
    check('no flag for it either', await flagged(win), false)
    await allow(win)
    await say('with the new command')
    check('the new command runs after Allow', await seen('echo:with the new command'), true)
    const lastArgv = JSON.parse(readFileSync(sharedLog, 'utf8').trim().split('\n').at(-1))
    check('it is the new command', lastArgv[0], '--changed')

    await withCommand('./evil.sh')
    const bad = win.locator('.bot-reason', { hasText: 'absolute path or a bare command name' })
    check('a relative command is refused with a reason', await shown(bad), true)
    const refused = await botView(win)
    check('that is not a question or an alert', [refused.needsConsent, refused.bound, refused.decision], [false, false, null])
    check('no page errors in the shared project', errors, [])
    await app.close()
    app = null
  }

  // --- Fifth run: two copies of Trek on one folder, and quitting mid-turn
  {
    const quitFile = join(root, 'Quit.trekproj')
    const quitFolder = join(root, 'Quit.trekbot')
    const lockFile = join(quitFolder, 'state', 'lock')
    writeFileSync(quitFile, JSON.stringify({ ...project, name: 'Quit', bot: { enabled: true } }))
    mkdirSync(quitFolder)
    writeFileSync(descendantPids, '')
    const firstRun = await launch()
    const first = firstRun.win
    await openFile(first, quitFile)
    await showBot(first)
    await allow(first)
    await first.locator('.bot-phase', { hasText: 'Idle' }).waitFor({ timeout: 15000 })

    const secondRun = await startElectron({ dataDir: join(root, 'user-data-2') })
    secondApp = secondRun.started
    const second = secondRun.win
    await openFile(second, quitFile)
    await showBot(second)
    await allow(second)
    const inUse = second.locator('.bot-reason', { hasText: 'Another copy of Trek' })
    check('a second Trek is kept off the folder', await shown(inUse), true)
    check('it has no bot', (await botView(second)).bound, false)
    const retry = second.locator('.bot-approval button', { hasText: 'Retry' })
    await retry.click()
    await second.waitForTimeout(500)
    check('Retry still finds it held', (await botView(second)).bound, false)

    const { say, seen } = helpers(first)
    await say('STUBBORN')
    check('the stubborn turn is running', await seen('ready'), true)
    const [stubborn] = readFileSync(descendantPids, 'utf8').trim().split('\n').map(Number)
    check('its descendant is alive', isAlive(stubborn), true)
    await app.close()
    app = null
    check('quitting kills a descendant that ignores SIGTERM', await goneWithin(stubborn, 3000), true)
    check('quitting releases the lock', existsSync(lockFile), false)

    await retry.click()
    check('Retry takes over once it is free', await shown(second.locator('.bot-phase', { hasText: 'Working' })), true)
    check('the second Trek now holds the lock', readFileSync(lockFile, 'utf8'), String(await secondApp.evaluate(() => process.pid)))
    await sleep(500)
    const rerun = readFileSync(descendantPids, 'utf8').trim().split('\n').map(Number).at(-1)
    await secondApp.close()
    secondApp = null
    check('its own turn goes with it too', await goneWithin(rerun, 3000), true)
    check('no page errors with two copies', [...firstRun.errors, ...secondRun.errors], [])
  }
} finally {
  await app?.close()
  await secondApp?.close()
  if (existsSync(descendantPids)) {
    for (const pid of readFileSync(descendantPids, 'utf8').split('\n').map(Number)) {
      if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  }
  rmSync(root, { recursive: true, force: true })
}

const failed = checks.filter((ok) => !ok).length
console.log(failed ? `${failed} check(s) failed` : `All ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
