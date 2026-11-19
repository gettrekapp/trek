// scripts/pluginSlots.test.mjs — which plugins fill a slot (campsite): active ones in built-in
// order; for sessionIndicator, only the first. And what a plugin's worktree slots see and decide
// (plugins E3): the project's repositories with that plugin's settings and their worktrees with the
// server's ids, the same array while nothing changed; each plugin's Run-menu entry for a worktree
// (one that throws left out); and the Run button's dot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { activeSlotEntries, firstActiveSlot, panelEntries, pluginSlotId, runDot } from '../src/renderer/src/plugins/slots.ts'
import { DIM_AFTER_KEY_MS, overlayDimmed } from '../src/renderer/src/plugins/overlayDim.ts'
import { cachedRepos, pluginReposOf, pluginWorktreeOf } from '../src/renderer/src/plugins/projectView.ts'

const entry = (id, status, slots) => ({ plugin: { manifest: { id }, slots }, status, host: {}, key: id })
const Comp = () => null

test('activeSlotEntries: on or legacy plugins that fill the slot, in order', () => {
  const entries = [entry('a', 'on', { bottomBar: Comp }), entry('b', 'off', { bottomBar: Comp }), entry('c', 'legacy', { bottomBar: Comp }), entry('d', 'on', {})]
  assert.deepEqual(activeSlotEntries(entries, 'bottomBar').map((e) => e.plugin.manifest.id), ['a', 'c'])
})

test('firstActiveSlot: the first active one, or undefined', () => {
  const entries = [entry('a', 'missing', { sessionIndicator: Comp }), entry('b', 'on', { sessionIndicator: Comp }), entry('c', 'on', { sessionIndicator: Comp })]
  assert.equal(firstActiveSlot(entries, 'sessionIndicator')?.plugin.manifest.id, 'b')
  assert.equal(firstActiveSlot([], 'sessionIndicator'), undefined)
})

test('overlayDimmed: while scrolled back, or while typing (held 3 s after a key)', () => {
  assert.equal(DIM_AFTER_KEY_MS, 3000)
  assert.equal(overlayDimmed({ typing: false, scrolledUp: false }), false)
  assert.equal(overlayDimmed({ typing: false, scrolledUp: true }), true)
  assert.equal(overlayDimmed({ typing: true, scrolledUp: false }), true)
  assert.equal(overlayDimmed({ typing: true, scrolledUp: true }), true)
})

test('overlayDimmed: never while nothing fills the overlay (disabled)', () => {
  assert.equal(overlayDimmed({ typing: true, scrolledUp: true, enabled: false }), false)
  assert.equal(overlayDimmed({ typing: true, scrolledUp: false, enabled: true }), true)
})

const ids = { '/r': 'wm', '/r-feat': 'w2' }
const worktreeId = (path) => ids[path]
const project = {
  repositories: [
    {
      id: 'r1', name: 'app', path: '/r', worktrees: [],
      pluginSettings: { env: { enabled: true }, other: { x: 1 } },
      branchPluginSettings: { feat: { env: { env: 'A=1' } }, main: { other: { y: 2 } } }
    },
    { id: 'r2', name: 'api', path: '/s', worktrees: [] }
  ]
}
const rows = {
  'r1 local': [
    { path: '/r', repoId: 'r1', branch: 'main', isMain: true },
    { path: '/r-feat', repoId: 'r1', branch: 'feat', isMain: false, prunable: true }
  ]
}

test("pluginReposOf: each repository with this plugin's settings only, and its rows as worktrees with the server's ids", () => {
  assert.deepEqual(pluginReposOf(project, rows, 'env', worktreeId), [
    {
      id: 'r1', name: 'app', path: '/r', settings: { enabled: true }, branchSettings: { feat: { env: 'A=1' } },
      worktrees: [
        { id: 'wm', repoId: 'r1', path: '/r', branch: 'main', isMain: true, missing: false },
        { id: 'w2', repoId: 'r1', path: '/r-feat', branch: 'feat', isMain: false, missing: true }
      ]
    },
    { id: 'r2', name: 'api', path: '/s', settings: {}, branchSettings: {}, worktrees: [] }
  ])
  assert.deepEqual(pluginReposOf(null, rows, 'env', worktreeId), [])
  // A row the window has not mapped yet, on a detached HEAD.
  assert.deepEqual(pluginWorktreeOf({ path: '/x', isMain: false }, worktreeId), { id: '', repoId: '', path: '/x', isMain: false, missing: false })
})

test('cachedRepos: the same array until the project, the rows or the backend change', () => {
  let state = { project, hostWorktrees: rows, backend: 'b1' }
  const repos = cachedRepos(() => state, worktreeId)
  const first = repos('env')
  assert.equal(repos('env'), first)
  assert.notEqual(repos('other'), first, 'one per plugin')
  assert.equal(repos('env'), first, "another plugin's read keeps this one's")
  state = { ...state, hostWorktrees: { ...rows } }
  assert.notEqual(repos('env'), first)
  const second = repos('env')
  state = { ...state, backend: 'b2' }
  assert.notEqual(repos('env'), second)
})

test("panelEntries: each plugin's entry for the worktree, in plugin order; none, or one that throws, is left out", () => {
  const host = { id: 'h' }
  const slot = (entry) => ({ entry, subscribe: () => () => {}, Component: () => null })
  const plugin = (id, worktreePanel) => ({ manifest: { id }, slots: worktreePanel ? { worktreePanel } : {} })
  const logged = []
  const worktree = { id: 'w2', repoId: 'r1', path: '/r-feat', branch: 'feat', isMain: false, missing: false }
  const out = panelEntries(
    [
      { plugin: plugin('env', slot((h, w) => (h === host && w.branch ? { label: 'Env', dot: 'running' } : null))), host },
      { plugin: plugin('quiet', slot(() => null)), host },
      { plugin: plugin('bad', slot(() => { throw new Error('boom') })), host },
      { plugin: plugin('plain'), host }
    ],
    worktree,
    (message) => logged.push(message)
  )
  assert.deepEqual(out, [{ pluginId: 'env', panelId: 'plugin:env', entry: { label: 'Env', dot: 'running' } }])
  assert.match(logged.join('\n'), /plugin bad/)
  assert.deepEqual(panelEntries([{ plugin: plugin('env', slot(() => ({ label: 'Env' }))), host }], undefined), [], 'no worktree yet')
  assert.equal(pluginSlotId('env'), 'plugin:env')
})

test('runDot: busy anywhere is attention, else running anywhere, else exited', () => {
  assert.equal(runDot(['running', 'attention']), 'attention')
  assert.equal(runDot([undefined, 'running', 'exited']), 'running')
  assert.equal(runDot([undefined, 'exited']), 'exited')
  assert.equal(runDot([]), 'exited')
})
