import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Environment (Colima VM) feature smoke: stub colima/docker binaries on PATH
// so the whole env:check → env:list → panel/badge pipeline runs without a
// real Colima install. Read-only operations only — the userData registry is
// never written (no Start/Reset is clicked).

const projectDir = process.cwd()
const errors = []

// Mirrors deriveProfileName in src/shared/environments.ts.
function deriveProfileName(repoPath, branch) {
  let h = 5381
  const input = `${repoPath}\0${branch}`
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  const hash = h.toString(16).padStart(8, '0').slice(0, 6)
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  return `twb-${slug || 'env'}-${hash}`
}

const repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'twb-envsmoke-')))
const worktreePath = `${repoPath}-wt`
execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', {
  cwd: repoPath,
  shell: '/bin/zsh'
})
execSync(`git worktree add -q -b feature-x "${worktreePath}"`, { cwd: repoPath, shell: '/bin/zsh' })

const featureProfile = deriveProfileName(repoPath, 'feature-x')

// Stub binaries: colima reports one VM for feature-x plus one crash leftover.
const stubDir = mkdtempSync(join(tmpdir(), 'twb-envstub-'))
writeFileSync(
  join(stubDir, 'colima-list.jsonl'),
  `${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.5' })}\n` +
    `${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}\n`
)
writeFileSync(
  join(stubDir, 'colima'),
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
if [ "$1" = "list" ]; then cat "$(dirname "$0")/colima-list.jsonl"; exit 0; fi
exit 0
`
)
writeFileSync(
  join(stubDir, 'docker'),
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
echo "[]"
exit 0
`
)
chmodSync(join(stubDir, 'colima'), 0o755)
chmodSync(join(stubDir, 'docker'), 0o755)

const cleanup = () => {
  rmSync(worktreePath, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(stubDir, { recursive: true, force: true })
}

try {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: projectDir,
    env: {
      ...process.env,
      TREK_NO_WINDOW_RESTORE: '1',
      TREK_NO_LOCAL_SERVER: '1',
      PATH: `${stubDir}:${process.env.PATH}`,
      // A failing SHELL makes fixPath() keep process.env.PATH (with the stubs
      // first) instead of re-resolving PATH from a login shell.
      SHELL: '/usr/bin/false'
    }
  })

  const win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  win.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`))

  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  await win.evaluate(
    ({ repoPath, worktreePath }) => {
      window.__store.getState().setProject(
        {
          version: 2,
          name: 'env-smoke',
          repositoryPath: repoPath,
          worktrees: [{ id: 'w1', name: 'feature-x', path: worktreePath, branch: 'feature-x' }],
          environments: { enabled: true }
        },
        '/tmp/env-smoke.trekproj'
      )
    },
    { repoPath, worktreePath }
  )
  // envCheck + first env:list run right after the enable flag is seen.
  await win.waitForTimeout(2000)

  const toolCheckOk = await win.evaluate(() => window.__store.getState().envToolCheck?.ok)
  const envState = await win.evaluate(() => window.__store.getState().environments)
  const envCount = Object.keys(envState).length
  const feature = envState[featureProfile]
  console.log(
    `tool check ok: ${toolCheckOk} (expect true), environments: ${envCount} (expect 2), ` +
      `feature vm: ${feature?.vmState}/${feature?.address} (expect running/192.168.106.5)`
  )

  // Sidebar: the feature-x row carries a green env badge; master has none.
  const envChips = await win.locator('.wt-row .mini-chip.env').count()
  const runningEnvChips = await win.locator('.wt-row .mini-chip.env.running').count()
  console.log(`sidebar env chips: ${envChips} (expect 1), running: ${runningEnvChips} (expect 1)`)

  // Feature worktree detail: Env panel button + header chip, then the panel.
  await win.locator('.wt-row:not(.selected)').first().click()
  await win.waitForTimeout(300)
  const panelBtns = await win.locator('.panel-btn').count()
  const envChip = (await win.locator('.chip-env').innerText()).trim()
  await win.locator('.panel-btn', { hasText: 'Env' }).click()
  await win.waitForTimeout(1000)
  const envPanels = await win.locator('.env-panel:visible').count()
  const headerName = (await win.locator('.env-header .docker-name').innerText()).trim()
  const headerMeta = (await win.locator('.env-header .docker-meta').innerText()).trim()
  const actionButtons = await win.locator('.env-header .docker-actions button').count()
  // docker stub returns [] for compose ps → empty-services message.
  const noServices = await win.locator('.env-panel:visible .muted', { hasText: 'No services' }).count()
  console.log(
    `feature panel buttons: ${panelBtns} (expect 3), header chip: "${envChip}", env panel: ${envPanels} (expect 1), ` +
      `profile: "${headerName}" (expect ${featureProfile}), meta: "${headerMeta}" (expect Running · 192.168.106.5), ` +
      `actions: ${actionButtons} (expect 3), no-services msg: ${noServices} (expect 1)`
  )

  // Settings: both stub VMs are unregistered → they show as orphans.
  await win.locator('.panel-btn[title="App settings"]').click()
  await win.waitForTimeout(400)
  const settingsCheckboxes = await win.locator('.settings-panel:visible input[type="checkbox"]').count()
  const sizeInputs = await win.locator('.env-size-inputs input').count()
  const orphanRows = await win.locator('.env-orphan-row').count()
  console.log(
    `settings checkboxes: ${settingsCheckboxes} (expect 3), vm size inputs: ${sizeInputs} (expect 3), ` +
      `orphan rows: ${orphanRows} (expect 2)`
  )

  console.log(`console/page errors: ${errors.length}`)
  for (const e of errors.slice(0, 5)) console.log(`  - ${e.slice(0, 200)}`)

  await app.close()
  const pass =
    toolCheckOk === true &&
    envCount === 2 &&
    feature?.vmState === 'running' &&
    feature?.address === '192.168.106.5' &&
    envChips === 1 &&
    runningEnvChips === 1 &&
    panelBtns === 3 &&
    envChip.includes('192.168.106.5') &&
    envPanels === 1 &&
    headerName === featureProfile &&
    headerMeta.includes('Running') &&
    headerMeta.includes('192.168.106.5') &&
    actionButtons === 3 &&
    noServices === 1 &&
    settingsCheckboxes === 3 &&
    sizeInputs === 3 &&
    orphanRows === 2 &&
    errors.length === 0
  console.log(pass ? 'ENV SMOKE PASS' : 'ENV SMOKE FAIL')
  process.exit(pass ? 0 : 1)
} finally {
  cleanup()
}
