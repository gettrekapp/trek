import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectDir = process.cwd()
const errors = []

// A real throwaway git repo with one extra worktree, so the sidebar's
// `git worktree list` + status plumbing is exercised end to end.
const repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'twb-smoke-')))
const worktreePath = `${repoPath}-wt`
execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', {
  cwd: repoPath,
  shell: '/bin/zsh'
})
execSync(`git worktree add -q -b feature-x "${worktreePath}"`, { cwd: repoPath, shell: '/bin/zsh' })

const cleanup = () => {
  rmSync(worktreePath, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
}

try {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: projectDir,
    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1' }
  })

  const win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  win.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`))

  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  const startHeading = await win.locator('h1').count()
  console.log(`start screen h1 count: ${startHeading}`)

  // Simulate opening a project file: project set, no terminals registered yet
  // (worktrees without saved sessions stay dormant).
  await win.evaluate(
    ({ repoPath, worktreePath }) => {
      window.__store.getState().setProject(
        {
          version: 1,
          name: 'smoke-test',
          repositoryPath: repoPath,
          worktrees: [{ id: 'w1', name: 'feature-x', path: worktreePath, branch: 'feature-x' }],
          branchTags: { 'feature-x': 'In Review' },
          branchNotes: { 'old/gone-branch': 'legacy note for a deleted worktree' },
          branchTickets: { 'feature-x': '3191' },
          branchPullRequests: { 'feature-x': 'https://github.com/trek/trek/pull/7361' }
        },
        '/tmp/smoke.trekproj'
      )
    },
    { repoPath, worktreePath }
  )
  await win.waitForTimeout(1500)
  const primaryId = await win.evaluate(
    () => `__primary__:${window.__store.getState().project.repositories[0].id}`
  )

  // Sidebar: both git worktrees listed, primary tagged and selected.
  const rows = await win.locator('.wt-row').count()
  const primaryTags = await win.locator('.wt-row .primary-tag').count()
  const selectedRows = await win.locator('.wt-row.selected').count()
  console.log(`sidebar rows: ${rows} (expect 2), primary tags: ${primaryTags} (expect 1), selected: ${selectedRows} (expect 1)`)

  // Two-tier git poll: listWorktrees carries no status (one git process),
  // and the separate status sweep merges dirty into the cached rows.
  const listStatusFields = await win.evaluate(
    (repoPath) =>
      window.api
        .listWorktrees(null, repoPath)
        .then((infos) => infos.filter((i) => i.dirty !== undefined).length),
    repoPath
  )
  const sweptDirty = await win.evaluate(() =>
    (Object.values(window.__store.getState().hostWorktrees).flat()).map((w) => w.dirty).join(',')
  )
  console.log(
    `list status fields: ${listStatusFields} (expect 0), swept dirty flags: "${sweptDirty}" (expect false,false)`
  )

  // Detail header: primary worktree with a Clean chip (fresh repo, no upstream).
  const detailTitle = (await win.locator('.detail-title').innerText()).trim()
  const cleanChips = await win.locator('.chip-clean').count()
  const accentButtons = await win.locator('.detail-actions .btn-accent').count()
  console.log(`detail title: "${detailTitle}" (expect master), clean chips: ${cleanChips} (expect 1), VS Code button: ${accentButtons} (expect 1)`)

  // No session yet → empty state with a start button.
  const noSession = await win.locator('.no-session:visible').count()
  console.log(`no-session empty state: ${noSession} (expect 1)`)

  // Register a fake terminal on the primary worktree → session tab appears.
  await win.evaluate((primaryId) => {
    window.__store.getState().registerTerminal({
      id: 't1',
      worktreeId: primaryId,
      title: 'Claude 1',
      sessionId: '00000000-0000-0000-0000-000000000000',
      status: 'working'
    })
  }, primaryId)
  await win.waitForTimeout(400)
  const sessionTabs = await win.locator('.session-tab').count()
  const runningDots = await win.locator('.sidebar-list .wt-dot.running').count()
  const footerText = (await win.locator('.sidebar-footer').innerText()).trim()
  console.log(`session tabs: ${sessionTabs} (expect 1), running dots: ${runningDots} (expect 1), footer: "${footerText}"`)

  // Attention: the sidebar row swaps its dot for a circled ! badge.
  await win.evaluate(() => window.__store.getState().setTerminalStatus('t1', 'attention'))
  await win.waitForTimeout(200)
  const attnBadges = await win.locator('.sidebar-list .wt-attn').count()
  await win.evaluate(() => window.__store.getState().setTerminalStatus('t1', 'working'))
  await win.waitForTimeout(200)
  const attnAfterClear = await win.locator('.sidebar-list .wt-attn').count()
  console.log(`attention badges: ${attnBadges} (expect 1), after clear: ${attnAfterClear} (expect 0)`)

  // Skill menu on the session tab.
  const triggers = await win.locator('.session-tab .skill-menu-trigger').count()
  await win.locator('.session-tab .skill-menu-trigger').first().click()
  await win.waitForTimeout(600)
  const menuItems = await win.locator('.skill-menu-item').count()
  await win.keyboard.press('Escape')
  console.log(`skill menu triggers: ${triggers} (expect 1), menu items: ${menuItems} (expect >0)`)

  // Docker panel button + compose ▾ menu.
  await win.locator('.panel-btn', { hasText: 'Docker' }).click()
  await win.waitForTimeout(400)
  const dockerPanels = await win.locator('.docker-panel:visible').count()
  await win.locator('.docker-menu-trigger').click()
  await win.waitForTimeout(300)
  const composeItems = await win.locator('.docker-menu .skill-menu-item').count()
  await win.keyboard.press('Escape')
  console.log(`docker panel visible: ${dockerPanels} (expect 1), compose actions: ${composeItems} (expect 6)`)

  // Complete toggle: a done badge click marks the terminal fully complete.
  await win.evaluate(() => window.__store.getState().setTerminalStatus('t1', 'done'))
  await win.waitForTimeout(200)
  await win.locator('.session-tab .badge-done').click()
  await win.waitForTimeout(200)
  const completeBadges = await win.locator('.session-tab .badge-complete').count()
  const statusAfterToggle = await win.evaluate(() => window.__store.getState().terminals['t1'].status)
  console.log(`complete badges after click: ${completeBadges} (expect 1), status: ${statusAfterToggle} (expect complete)`)

  // Notes panel: textarea persists per branch.
  await win.locator('.panel-btn', { hasText: /^Notes$/ }).click()
  await win.waitForTimeout(300)
  const notesPanels = await win.locator('.notes-panel:visible').count()
  await win.locator('.notes-panel:visible textarea').fill('remember the thing')
  await win.waitForTimeout(200)
  const savedNote = await win.evaluate(
    () => window.__store.getState().project.repositories[0].branchNotes?.['master']
  )
  console.log(`notes panel: ${notesPanels} (expect 1), note saved: "${savedNote}"`)

  // All Notes panel: every branch note, including ones without a worktree.
  await win.locator('.panel-btn', { hasText: 'All Notes' }).click()
  await win.waitForTimeout(300)
  const noteCards = await win.locator('.note-card').count()
  const goneTags = await win.locator('.note-gone-tag').count()
  const showButtons = await win.locator('.note-card-btn:not(.danger)').count()
  // Two-step delete on the orphaned note.
  const goneDelete = win.locator('.note-card', { hasText: 'gone-branch' }).locator('.note-card-btn.danger')
  await goneDelete.click()
  await win.waitForTimeout(150)
  const confirmLabel = (await goneDelete.innerText()).trim()
  await goneDelete.click()
  await win.waitForTimeout(200)
  const noteCardsAfter = await win.locator('.note-card').count()
  const remainingNotes = await win.evaluate(() =>
    Object.keys(window.__store.getState().project.repositories[0].branchNotes ?? {}).join(',')
  )
  console.log(
    `all notes: cards ${noteCards} (expect 2), gone tags ${goneTags} (expect 1), show buttons ${showButtons} (expect 1), confirm label "${confirmLabel}", after delete ${noteCardsAfter} (expect 1), remaining: ${remainingNotes} (expect master)`
  )

  // Settings panel: audio alerts toggle, default off, persists to the project.
  await win.locator('.panel-btn[title="App settings"]').click()
  await win.waitForTimeout(300)
  const settingsPanels = await win.locator('.settings-panel:visible').count()
  const audioDefault = await win.evaluate(() => window.__store.getState().project.audioAlerts ?? false)
  await win.locator('.settings-panel:visible input[type="checkbox"]').first().click()
  await win.waitForTimeout(200)
  const audioAfterToggle = await win.evaluate(() => window.__store.getState().project.audioAlerts)
  // Claude session mode dropdown: defaults to the app-wide mode (""), persists changes.
  const modeDefault = await win.locator('select.settings-select').first().inputValue()
  await win.locator('select.settings-select').first().selectOption('acceptEdits')
  await win.waitForTimeout(200)
  const modeAfterPick = await win.evaluate(
    () => window.__store.getState().project.claudePermissionMode
  )
  console.log(
    `settings panel: ${settingsPanels} (expect 1), audio default: ${audioDefault} (expect false), after toggle: ${audioAfterToggle} (expect true), mode default: "${modeDefault}" (expect "", the app default), after pick: ${modeAfterPick} (expect acceptEdits)`
  )

  // Overflow menu on the primary: VS Code, Reveal, Ticket, PR, promote-branch.
  await win.locator('.detail-actions .btn-icon').click()
  await win.waitForTimeout(300)
  const primaryMenuItems = await win.locator('.detail-menu .detail-menu-item').count()
  await win.locator('.detail-menu-backdrop').click()
  console.log(`primary overflow actions: ${primaryMenuItems} (expect 5)`)

  // Select the feature worktree in the sidebar → detail switches, no session.
  await win.locator('.wt-row:not(.selected)').first().click()
  await win.waitForTimeout(300)
  const featureTitle = (await win.locator('.detail-title').innerText()).trim()
  const featureNoSession = await win.locator('.no-session:visible').count()
  // All Notes and Docker are primary-only: the feature worktree keeps Notes + ⚙.
  const featurePanelBtns = await win.locator('.panel-btn').count()
  console.log(`feature detail title: "${featureTitle}" (expect feature-x), empty state: ${featureNoSession} (expect 1), panel buttons: ${featurePanelBtns} (expect 2)`)

  // Branch-keyed ticket/PR links: sidebar mini-chips + detail chips.
  const sidebarTicketChips = await win.locator('.wt-row .mini-chip.ticket').count()
  const sidebarPrChips = await win.locator('.wt-row .mini-chip.pr').count()
  const detailTicketChips = await win.locator('.chip-ticket').count()
  const detailPrChips = await win.locator('.chip-pr').count()
  console.log(`ticket chips: sidebar ${sidebarTicketChips} / detail ${detailTicketChips} (expect 1/1), PR chips: sidebar ${sidebarPrChips} / detail ${detailPrChips} (expect 1/1)`)

  // Workflow tag: sidebar chip from branchTags, picker changes it per branch.
  const sidebarTagChips = await win.locator('.wt-row .mini-chip', { hasText: 'In Review' }).count()
  const tagChipText = (await win.locator('.chip-tag').innerText()).trim()
  await win.locator('.chip-tag').click()
  await win.waitForTimeout(200)
  const tagOptions = await win.locator('.tag-menu .tag-menu-item:not(.clear)').count()
  const removeTagOptions = await win.locator('.tag-menu .tag-menu-item', { hasText: /^Remove$/ }).count()
  await win.locator('.tag-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  await win.waitForTimeout(200)
  const tagAfterPick = await win.evaluate(
    () => window.__store.getState().project.repositories[0].branchTags['feature-x']
  )
  console.log(
    `sidebar tag chips: ${sidebarTagChips} (expect 1), detail chip: "${tagChipText}", options: ${tagOptions} (expect 8, incl Remove: ${removeTagOptions}), after pick: ${tagAfterPick} (expect Ready to Deploy)`
  )

  // Tag filter under the worktree list: All + 8 tags + Untagged.
  await win.locator('.tag-filter-btn').click()
  await win.waitForTimeout(200)
  const tagFilterOptions = await win.locator('.tag-filter-menu .tag-menu-item').count()
  await win.locator('.tag-filter-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  await win.waitForTimeout(200)
  const filteredRows = await win.locator('.wt-row').count()
  const filterLabel = (await win.locator('.tag-filter-btn').innerText()).trim()
  await win.locator('.sidebar-tag-filter .detail-menu-backdrop').click()
  await win.locator('.tag-filter-clear').click()
  await win.waitForTimeout(200)
  const unfilteredRows = await win.locator('.wt-row').count()
  console.log(
    `tag filter options: ${tagFilterOptions} (expect 10), filtered rows: ${filteredRows} (expect 1), label: "${filterLabel}", after clear: ${unfilteredRows} (expect 2)`
  )

  // Its overflow menu: VS Code, Reveal, Ticket, PR, Open ticket & PR, Promote, Delete.
  await win.locator('.detail-actions .btn-icon').click()
  await win.waitForTimeout(300)
  const wtMenuItems = await win.locator('.detail-menu .detail-menu-item').count()
  const dangerItems = await win.locator('.detail-menu .detail-menu-item.danger').count()
  await win.locator('.detail-menu-backdrop').click()
  console.log(`worktree overflow actions: ${wtMenuItems} (expect 7), danger: ${dangerItems} (expect 1)`)

  // Unload/load the primary: its ⏏ row button snapshots the session into the
  // project file, drops the tab, and leaves a ▸1 button that resumes it.
  await win.locator('.wt-row .primary-tag').click()
  await win.waitForTimeout(300)
  await win.locator('.wt-row.selected .wt-power.loaded').click()
  await win.waitForTimeout(400)
  const tabsAfterUnload = await win.locator('.session-tab').count()
  const savedAfterUnload = await win.evaluate(
    () => window.__store.getState().project.repositories[0].primaryTerminals?.length ?? 0
  )
  const dormantDots = await win.locator('.sidebar-list .wt-dot.dormant').count()
  const loadButtons = await win.locator('.wt-row .wt-power.dormant').count()
  const unloadedEmptyState = (await win.locator('.no-session:visible').innerText()).trim()
  console.log(
    `after unload — tabs: ${tabsAfterUnload} (expect 0), saved sessions: ${savedAfterUnload} (expect 1), dormant dots: ${dormantDots} (expect 1), load buttons: ${loadButtons} (expect 1), empty state: "${unloadedEmptyState.replace(/\n/g, ' | ')}"`
  )

  console.log(`console/page errors: ${errors.length}`)
  for (const e of errors.slice(0, 5)) console.log(`  - ${e.slice(0, 200)}`)

  await app.close()
  const pass =
    rows === 2 &&
    primaryTags === 1 &&
    selectedRows === 1 &&
    detailTitle === 'master' &&
    cleanChips === 1 &&
    accentButtons === 1 &&
    noSession === 1 &&
    sessionTabs === 1 &&
    runningDots === 1 &&
    footerText.includes('1 session running') &&
    attnBadges === 1 &&
    attnAfterClear === 0 &&
    triggers === 1 &&
    menuItems > 0 &&
    dockerPanels === 1 &&
    composeItems === 6 &&
    completeBadges === 1 &&
    statusAfterToggle === 'complete' &&
    notesPanels === 1 &&
    savedNote === 'remember the thing' &&
    noteCards === 2 &&
    goneTags === 1 &&
    showButtons === 1 &&
    confirmLabel === 'Really delete?' &&
    noteCardsAfter === 1 &&
    remainingNotes === 'master' &&
    settingsPanels === 1 &&
    audioDefault === false &&
    audioAfterToggle === true &&
    modeDefault === '' &&
    modeAfterPick === 'acceptEdits' &&
    primaryMenuItems === 5 &&
    sidebarTicketChips === 1 &&
    sidebarPrChips === 1 &&
    detailTicketChips === 1 &&
    detailPrChips === 1 &&
    featureTitle === 'feature-x' &&
    featureNoSession === 1 &&
    featurePanelBtns === 2 &&
    sidebarTagChips === 1 &&
    tagChipText.startsWith('In Review') &&
    tagOptions === 8 &&
    removeTagOptions === 1 &&
    tagAfterPick === 'Ready to Deploy' &&
    tagFilterOptions === 10 &&
    filteredRows === 1 &&
    filterLabel.includes('Ready to Deploy') &&
    unfilteredRows === 2 &&
    wtMenuItems === 7 &&
    dangerItems === 1 &&
    tabsAfterUnload === 0 &&
    savedAfterUnload === 1 &&
    dormantDots === 1 &&
    loadButtons === 1 &&
    unloadedEmptyState.includes('1 saved session') &&
    listStatusFields === 0 &&
    sweptDirty === 'false,false' &&
    errors.length === 0
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')
  process.exit(pass ? 0 : 1)
} finally {
  cleanup()
}
