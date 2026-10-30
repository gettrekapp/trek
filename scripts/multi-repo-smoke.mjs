// scripts/multi-repo-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}

const makeRepo = (prefix) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const opts = { cwd: repo, shell: '/bin/zsh' }
  execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', opts)
  execSync(`git worktree add -q -b feature-auth "${repo}-wt"`, opts)
  return repo
}

const api = makeRepo('twb-multi-api-')
const web = makeRepo('twb-multi-web-')
const cleanup = () => {
  for (const repo of [api, web]) {
    rmSync(`${repo}-wt`, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

try {
  const app = await electron.launch({ args: ['out/main/index.js'], cwd: process.cwd() })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  await win.evaluate(
    ({ api, web }) => {
      window.__store.getState().setProject(
        {
          version: 3,
          name: 'multi',
          repositories: [
            {
              id: 'r-api',
              name: 'api',
              path: api,
              worktrees: [{ id: 'w-api', name: 'feature-auth', path: `${api}-wt`, branch: 'feature-auth' }]
            },
            {
              id: 'r-web',
              name: 'web',
              path: web,
              worktrees: [{ id: 'w-web', name: 'feature-auth', path: `${web}-wt`, branch: 'feature-auth' }]
            }
          ]
        },
        '/tmp/multi-repo-smoke.trekproj'
      )
    },
    { api, web }
  )
  await win.waitForTimeout(1500)

  check('two sections', await win.locator('.repo-section').count(), 2)
  check('four rows', await win.locator('.wt-row').count(), 4)
  check('one primary per repository', await win.locator('.wt-row .primary-tag').count(), 2)
  check('one selected row', await win.locator('.wt-row.selected').count(), 1)

  // Same branch name in both repositories: writes must not cross over.
  const repos = () =>
    win.evaluate(() => {
      const { repositories } = window.__store.getState().project
      return Object.fromEntries(repositories.map((r) => [r.id, r]))
    })
  await win.evaluate(() => {
    const s = window.__store.getState()
    s.setBranchTag('r-api', 'feature-auth', 'In Review')
    s.setBranchNote('r-api', 'feature-auth', 'api note')
    s.setBranchPullRequest('r-api', 'feature-auth', 'https://github.com/o/api/pull/1')
  })
  const after = await repos()
  check('api tag set', after['r-api'].branchTags['feature-auth'], 'In Review')
  check('web tag untouched', after['r-web'].branchTags?.['feature-auth'] ?? null, null)
  check('web note untouched', after['r-web'].branchNotes?.['feature-auth'] ?? null, null)
  check('web PR untouched', after['r-web'].branchPullRequests?.['feature-auth'] ?? null, null)

  // Selecting web's row shows web's data, not api's.
  await win.locator('.repo-section').nth(1).locator('.wt-row', { hasText: 'feature-auth' }).click()
  await win.waitForTimeout(300)
  check('web row has no PR chip', await win.locator('.repo-section').nth(1).locator('.mini-chip.pr').count(), 0)
  check('api row has a PR chip', await win.locator('.repo-section').nth(0).locator('.mini-chip.pr').count(), 1)
  check('detail shows no PR for web', await win.locator('.chip-pr').count(), 0)

  // Collapsing keeps the section's status visible.
  // Focus acknowledges attention on the selected worktree, so look at api while web raises it.
  await win.locator('.repo-section').nth(0).locator('.wt-row', { hasText: 'feature-auth' }).click()
  await win.evaluate(() => {
    window.__store.getState().registerTerminal({
      id: 't-web',
      worktreeId: 'w-web',
      title: 'Claude',
      sessionId: '00000000-0000-0000-0000-000000000001',
      status: 'attention'
    })
  })
  await win.waitForTimeout(200)
  await win.locator('.repo-section').nth(1).locator('.repo-toggle').click()
  await win.waitForTimeout(200)
  check('collapsed section hides rows', await win.locator('.repo-section').nth(1).locator('.wt-row').count(), 0)
  check('collapsed section shows attention', await win.locator('.repo-section').nth(1).locator('.repo-header .wt-attn').count(), 1)
  await win.locator('.repo-section').nth(1).locator('.repo-toggle').click()

  // A tag filter hides sections with no match.
  await win.locator('.tag-filter-btn').click()
  await win.locator('.tag-filter-menu .tag-menu-item', { hasText: 'In Review' }).click()
  await win.locator('.sidebar-tag-filter .detail-menu-backdrop').click()
  await win.waitForTimeout(200)
  check('filter hides the empty section', await win.locator('.repo-section').count(), 1)
  await win.locator('.tag-filter-clear').click()

  await win.locator('.repo-section').nth(1).locator('.wt-row', { hasText: 'feature-auth' }).click()
  // Live sessions block removal; clearing them allows it, and the rows go too.
  const blocked = await win.evaluate(() => {
    const { terminalOrder } = window.__store.getState()
    return (terminalOrder['w-web'] ?? []).length
  })
  check('web has a live session', blocked, 1)
  await win.locator('.repo-section').nth(1).locator('.repo-action').nth(1).click()
  check(
    'remove is disabled with live sessions',
    await win.locator('.repo-menu .tag-menu-item.disabled').count(),
    1
  )
  await win.locator('.repo-section').nth(1).locator('.detail-menu-backdrop').click()

  await win.evaluate(() => {
    const s = window.__store.getState()
    s.removeTerminal('t-web')
    s.removeRepository('r-web')
  })
  await win.waitForTimeout(300)
  check('one section left', await win.locator('.repo-section').count(), 1)
  check('two rows left', await win.locator('.wt-row').count(), 2)
  check(
    'selection falls back to the remaining repository',
    await win.locator('.wt-row.selected').count(),
    1
  )

  check('page errors', errors, [])
  await app.close()
  const pass = checks.every(Boolean)
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')
  process.exit(pass ? 0 : 1)
} finally {
  cleanup()
}
