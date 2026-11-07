// scripts/serverProjectSettings.test.mjs — ProjectSettings keys and value kinds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applySettingsPatch, pruneDeletedTags, validateSettings } from '../server/src/projects/settings.ts'
import { DEFAULT_WORKTREE_TAGS } from '../src/shared/types.ts'

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('validateSettings accepts known keys with the right kind of value', () => {
  const s = { claudeCommand: 'claude', audioAlerts: true, worktreeOrder: ['r /a'], bot: { enabled: false } }
  assert.deepEqual(validateSettings(s, 'settings'), s)
})

test('validateSettings rejects unknown keys and wrong kinds', () => {
  assert.equal(code(() => validateSettings({ nope: 1 }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ audioAlerts: 'yes' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: 'x' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: [1] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ bot: [] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings([], 'settings')), 'BAD_REQUEST')
})

test('applySettingsPatch merges shallowly and null removes', () => {
  const next = applySettingsPatch({ claudeCommand: 'a', audioAlerts: true }, { claudeCommand: 'b', audioAlerts: null })
  assert.deepEqual(next, { claudeCommand: 'b' })
})

test('applySettingsPatch validates the patch values', () => {
  assert.equal(code(() => applySettingsPatch({}, { audioAlerts: 'x' })), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, { name: 'x' })), 'BAD_REQUEST')
})

test('a nested __proto__ key is rejected, in objects and in arrays', () => {
  assert.equal(code(() => applySettingsPatch({}, JSON.parse('{"bot":{"__proto__":{}}}'))), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, JSON.parse('{"sessionTypes":[{"__proto__":1}]}'))), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings(JSON.parse('{"llmDefault":{"x":{"__proto__":1}}}'), 'settings')), 'BAD_REQUEST')
})

test('applySettingsPatch does not mutate current', () => {
  const current = { claudeCommand: 'a', audioAlerts: true }
  applySettingsPatch(current, { claudeCommand: 'b', audioAlerts: null })
  assert.deepEqual(current, { claudeCommand: 'a', audioAlerts: true })
})

test('a null delete of an unknown key is BAD_REQUEST', () => {
  assert.equal(code(() => applySettingsPatch({}, { nope: null })), 'BAD_REQUEST')
})

test('sessionTypes elements are validated', () => {
  const ok = { id: 'a', name: 'Review', systemPrompt: 'p', initialMessage: 'go', llm: { provider: 'claude' }, icon: 'data:x' }
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: [ok, { id: 'b', name: 'B', systemPrompt: '' }] })), 'ok')
  const bad = (patch) => code(() => applySettingsPatch({}, { sessionTypes: [{ ...ok, ...patch }] }))
  assert.equal(bad({ id: '' }), 'BAD_REQUEST')
  assert.equal(bad({ id: 1 }), 'BAD_REQUEST')
  assert.equal(bad({ name: 'x'.repeat(201) }), 'BAD_REQUEST')
  assert.equal(bad({ name: 'a\u0007b' }), 'BAD_REQUEST')
  assert.equal(bad({ name: undefined }), 'BAD_REQUEST')
  assert.equal(bad({ systemPrompt: 3 }), 'BAD_REQUEST')
  assert.equal(bad({ systemPrompt: 'x'.repeat(100_001) }), 'BAD_REQUEST')
  assert.equal(bad({ initialMessage: 3 }), 'BAD_REQUEST')
  assert.equal(bad({ initialMessage: 'x'.repeat(100_001) }), 'BAD_REQUEST')
  assert.equal(bad({ llm: { provider: 'nope' } }), 'BAD_REQUEST')
  assert.equal(bad({ llm: 'claude' }), 'BAD_REQUEST')
  assert.equal(bad({ icon: 5 }), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: ['x'] })), 'BAD_REQUEST')
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, systemPrompt: '' }))
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: many(100) })), 'ok')
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: many(101) })), 'BAD_REQUEST')
  // Imports go through validateSettings, so they are covered too.
  assert.equal(code(() => validateSettings({ sessionTypes: [{ ...ok, name: 'x'.repeat(201) }] }, 'settings')), 'BAD_REQUEST')
})

// The tag cascade: what a file window's setWorktreeTags and setCustomTags do to the branches.
const tag = (id, name = id) => ({ id, name, color: '#fff' })
const tagRepos = () => [
  {
    id: 'r1', name: 'a', path: '/a', worktrees: [],
    branchData: {
      one: { tag: 'todo', customTags: ['x', 'y'] },
      two: { tag: 'done', note: 'n' },
      three: { customTags: ['y'] },
      four: { tag: 'todo' },
      five: { note: 'only' }
    }
  },
  { id: 'r2', name: 'b', path: '/b', worktrees: [], branchData: { one: { tag: 'todo', customTags: ['x'] } } }
]
const prune = (repos, current, patch) => pruneDeletedTags(repos, applySettingsPatch(current, patch), patch)
const tagSettings = { worktreeTags: [tag('todo'), tag('done')], customTags: [tag('x'), tag('y')] }

test('pruneDeletedTags: a deleted tag comes off every branch that had it, in every repository', () => {
  const repos = tagRepos()
  const next = prune(repos, tagSettings, { worktreeTags: [tag('done')] })
  assert.deepEqual(next[0].branchData, {
    one: { customTags: ['x', 'y'] },
    two: { tag: 'done', note: 'n' },
    three: { customTags: ['y'] },
    five: { note: 'only' }
  })
  assert.deepEqual(next[1].branchData, { one: { customTags: ['x'] } })
  // The input is not changed.
  assert.deepEqual(repos, tagRepos())
})

test('pruneDeletedTags: a deleted custom tag comes off the lists; an emptied list is dropped', () => {
  const next = prune(tagRepos(), tagSettings, { customTags: [tag('x')] })
  assert.deepEqual(next[0].branchData, {
    one: { tag: 'todo', customTags: ['x'] },
    two: { tag: 'done', note: 'n' },
    four: { tag: 'todo' },
    five: { note: 'only' }
  })
  assert.deepEqual(next[1].branchData, { one: { tag: 'todo', customTags: ['x'] } })
  // Removing the key deletes every custom tag.
  const none = prune(tagRepos(), tagSettings, { customTags: null })
  assert.deepEqual(none[1].branchData, { one: { tag: 'todo' } })
  assert.equal(none[0].branchData.three, undefined)
})

test('pruneDeletedTags: unrelated tags, branches and repositories are untouched, as the same objects', () => {
  const repos = tagRepos()
  const next = prune(repos, tagSettings, { worktreeTags: [tag('todo')] })
  assert.deepEqual(next[0].branchData.two, { note: 'n' })
  assert.equal(next[0].branchData.one, repos[0].branchData.one)
  assert.equal(next[0].branchData.five, repos[0].branchData.five)
  assert.equal(next[1], repos[1])
})

test('pruneDeletedTags: renaming, recolouring or reordering tags clears nothing', () => {
  const repos = tagRepos()
  const renamed = { worktreeTags: [tag('done', 'Shipped'), { ...tag('todo'), color: '#000' }] }
  assert.equal(prune(repos, tagSettings, renamed)[0], repos[0])
  assert.equal(prune(repos, tagSettings, { customTags: [tag('y', 'Why'), tag('x')] })[0], repos[0])
})

test('pruneDeletedTags: a patch without either tag key changes nothing', () => {
  const repos = tagRepos()
  assert.equal(prune(repos, tagSettings, { audioAlerts: true, worktreeOrder: [] }), repos)
  assert.equal(prune(repos, tagSettings, { worktreeTags: undefined }), repos)
})

test('pruneDeletedTags: worktreeTags removed or absent means the default tags', () => {
  const repos = [{ id: 'r', name: 'a', path: '/a', worktrees: [], branchData: { a: { tag: 'In Review' }, b: { tag: 'todo' } } }]
  // Removing the key brings back the defaults: their ids stay, others go.
  assert.deepEqual(prune(repos, tagSettings, { worktreeTags: null })[0].branchData, { a: { tag: 'In Review' } })
  // From the defaults to a list without "In Review".
  const fromDefaults = prune(repos, {}, { worktreeTags: DEFAULT_WORKTREE_TAGS.filter((t) => t.id !== 'In Review') })
  assert.deepEqual(fromDefaults[0].branchData, {})
})
