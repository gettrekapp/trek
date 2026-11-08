// scripts/changes-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'twb-changes-')))
const worktree = `${repo}-wt`
const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, shell: '/bin/zsh', stdio: 'pipe' })
const commit = 'git -c user.email=s@s -c user.name=s commit -q'
sh('git init -q -b master')
writeFileSync(join(repo, 'edited.txt'), 'one\ntwo\n')
sh(`git add . && ${commit} -m init`)
sh(`git worktree add -q -b feature "${worktree}"`)
writeFileSync(join(worktree, 'committed.txt'), 'a\nb\n')
sh(`git add . && ${commit} -m work`, worktree)
writeFileSync(join(worktree, 'edited.txt'), 'one\nchanged\n')
writeFileSync(join(worktree, 'untracked.txt'), 'x\n')

const screenshot = process.env.CHANGES_SMOKE_SHOT
let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1', TREK_NO_LOCAL_SERVER: '1' }
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)
  await win.evaluate(
    ({ repo, worktree }) => {
      window.__store.getState().setProject(
        {
          version: 3,
          name: 'changes',
          repositories: [
            {
              id: 'r',
              name: 'r',
              path: repo,
              worktrees: [{ id: 'w', name: 'feature', path: worktree, branch: 'feature' }]
            }
          ]
        },
        '/tmp/changes-smoke.trekproj'
      )
    },
    { repo, worktree }
  )
  await win.waitForTimeout(1500)

  const tab = win.locator('.session-row .panel-btn').first()
  const hasTitle = (text) =>
    tab.filter({ hasText: text }).waitFor({ timeout: 8000 }).then(
      () => text,
      async () => tab.textContent()
    )

  // The primary checkout is clean.
  await win.locator('.wt-row', { hasText: 'master' }).click()
  check('clean worktree title', await hasTitle('Changes'), 'Changes')

  await win.locator('.wt-row', { hasText: 'feature' }).click()
  check('title totals all changes', await hasTitle('3 files +4 −1'), '3 files +4 −1')

  await tab.click()
  const rows = win.locator('.changes-file-row')
  await rows.first().waitFor()
  check('one row per file', await rows.count(), 3)
  await win.locator('.changes-line.add', { hasText: 'changed' }).waitFor({ timeout: 8000 })
  check('deleted line shown', await win.locator('.changes-line.del', { hasText: 'two' }).count(), 1)
  check('base shown', (await win.locator('.changes-panel .muted').textContent()).trim(), 'compared to master')
  if (screenshot) await win.screenshot({ path: screenshot })

  // An edit that keeps the same counts still replaces the patch on screen.
  writeFileSync(join(worktree, 'edited.txt'), 'one\nREWRITTEN\n')
  await win.locator('.changes-line.add', { hasText: 'REWRITTEN' }).waitFor({ timeout: 12000 })
  check(
    'same-count edit replaces the old patch',
    [
      await win.locator('.changes-line.add', { hasText: 'REWRITTEN' }).count(),
      await win.locator('.changes-line.add', { hasText: 'changed' }).count()
    ],
    [1, 0]
  )

  await rows.first().click()
  check('row collapses', await win.locator('.changes-file').first().locator('.changes-diff').count(), 0)

  // A new edit reaches the title and the open panel with no manual refresh.
  writeFileSync(join(worktree, 'later.txt'), 'later line\n')
  check('title follows new edits', await hasTitle('4 files +5 −1'), '4 files +5 −1')
  await win.locator('.changes-line.add', { hasText: 'later line' }).waitFor({ timeout: 8000 })
  check('open panel follows new edits', await rows.count(), 4)

  await tab.click()
  check('tab toggles the panel closed', await win.locator('.changes-panel').isVisible(), false)

  // Switching shows the other worktree's numbers, not the previous ones.
  await tab.click()
  await win.locator('.wt-row', { hasText: 'master' }).click()
  check('switching updates the title', await hasTitle('Changes'), 'Changes')

  check('no page errors', errors, [])
} finally {
  await app?.close()
  sh(`git worktree remove --force "${worktree}"`)
  rmSync(worktree, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
}

const failed = checks.filter((ok) => !ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
