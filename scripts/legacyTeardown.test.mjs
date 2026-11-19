// scripts/legacyTeardown.test.mjs — core's adapter for the old-server fallback (plugins E3,
// src/renderer/src/plugins/legacyParts.ts): which plugins' legacyTeardown is asked, what a throwing
// or unknown part does, the warnings of a run, the repository block, and the subscriptions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyRepoBlockOf, readLegacyParts, runLegacyPartsOf, subscribeLegacy } from '../src/renderer/src/plugins/legacyParts.ts'

const worktree = { id: 'w2', repoId: 'r1', path: '/r-feat', branch: 'feat', isMain: false, missing: false }

/** A plugin entry as PluginHost gives it; `slot` its legacyTeardown (none when null). */
function entry(id, status, slot, repos = [{ id: 'r1' }]) {
  const asked = []
  const host = { id, repos: () => repos, onReposChanged: () => () => {} }
  const legacyTeardown = slot && {
    part: (h, w) => {
      asked.push(['part', h.id, w.id])
      return slot.part ? slot.part(w) : null
    },
    run: async (h, w) => {
      asked.push(['run', h.id, w.id])
      return slot.run ? slot.run(w) : undefined
    },
    repoRemoveBlock: (h, repo) => {
      asked.push(['block', h.id, repo.id])
      return slot.block ? slot.block(repo) : null
    },
    subscribe: slot.subscribe ?? (() => () => {})
  }
  return { plugin: { manifest: { id, name: `Plugin ${id}` }, ...(legacyTeardown ? { legacyTeardown } : {}) }, status, host, key: id, asked }
}

const vmPart = (label) => ({ part: () => ({ label, notice: `${label} goes.`, running: false }) })

test('only the active plugins (on, or legacy before E2) with the slot are asked', () => {
  const entries = [
    entry('a', 'on', vmPart('A')),
    entry('b', 'off', vmPart('B')),
    entry('c', 'legacy', vmPart('C')),
    entry('d', 'missing', vmPart('D')),
    entry('e', 'on', null)
  ]
  const read = readLegacyParts(entries, worktree)
  assert.deepEqual(read, {
    parts: [
      { pluginId: 'a', name: 'Plugin a', label: 'A', notice: 'A goes.', running: false },
      { pluginId: 'c', name: 'Plugin c', label: 'C', notice: 'C goes.', running: false }
    ],
    pending: []
  })
  assert.deepEqual(entries.map((e) => e.asked.length), [1, 0, 1, 0, 0])
  assert.deepEqual(entries[0].asked, [['part', 'a', 'w2']])
})

test('a part that throws is left out and logged; one not known yet (undefined) is pending, by its name; null is nothing', () => {
  const logs = []
  const entries = [
    entry('a', 'on', { part: () => { throw new Error('boom') } }),
    entry('b', 'on', { part: () => undefined }),
    entry('c', 'on', { part: () => null }),
    entry('d', 'on', vmPart('D'))
  ]
  const read = readLegacyParts(entries, worktree, (message, err) => logs.push([message, String(err)]))
  assert.deepEqual(read.parts.map((p) => p.pluginId), ['d'])
  assert.deepEqual(read.pending, ['Plugin b'])
  assert.deepEqual(logs, [['[plugin a] its teardown check failed', 'Error: boom']])
})

test("run: each known part in plugin order; their warnings in that order; a rejection is a warning in the plugin's name", async () => {
  const order = []
  const entries = [
    entry('a', 'on', { ...vmPart('A'), run: () => (order.push('a'), 'A was left.') }),
    entry('b', 'on', { part: () => undefined, run: () => order.push('b') }),
    entry('c', 'on', { ...vmPart('C'), run: () => (order.push('c'), Promise.reject(Object.assign(new Error('colima delete failed'), { code: 'INTERNAL' }))) }),
    entry('d', 'on', { ...vmPart('D'), run: () => (order.push('d'), undefined) }),
    entry('e', 'on', { ...vmPart('E'), run: () => (order.push('e'), 'E was left.') }),
    entry('f', 'off', { ...vmPart('F'), run: () => order.push('f') })
  ]
  assert.deepEqual(await runLegacyPartsOf(entries, worktree), ['A was left.', 'Plugin c: colima delete failed', 'E was left.'])
  assert.deepEqual(order, ['a', 'c', 'd', 'e'], 'not the one not known yet, nor the off one')
})

test("the repository block: a repository the plugin's host doesn't list is skipped; the first reason wins; a throwing check is logged", () => {
  const logs = []
  const entries = [
    entry('a', 'on', { block: () => 'A says no.' }, [{ id: 'other' }]),
    entry('b', 'on', { block: () => { throw new Error('boom') } }),
    entry('c', 'off', { block: () => 'C says no.' }),
    entry('d', 'on', { block: () => null }),
    entry('e', 'on', { block: () => 'E says no.' }),
    entry('f', 'on', { block: () => 'F says no.' })
  ]
  assert.equal(legacyRepoBlockOf(entries, 'r1', (message) => logs.push(message)), 'E says no.')
  assert.deepEqual(entries.map((e) => e.asked.length), [0, 1, 0, 1, 1, 0])
  assert.deepEqual(logs, ['[plugin b] its repository check failed'])
  assert.equal(legacyRepoBlockOf([entry('d', 'on', { block: () => null })], 'r1'), null)
})

test("subscribeLegacy: each active plugin's own state and its host's repositories, until unsubscribed", () => {
  const subscribed = []
  const sub = (id) => (listener) => {
    subscribed.push(id)
    listener()
    return () => subscribed.push(`-${id}`)
  }
  const entries = [entry('a', 'on', { subscribe: sub('a') }), entry('b', 'off', { subscribe: sub('b') }), entry('c', 'on', null)]
  entries[0].host.onReposChanged = sub('a.repos')
  let heard = 0
  const off = subscribeLegacy(entries, () => heard++)
  assert.deepEqual([subscribed, heard], [['a', 'a.repos'], 2])
  off()
  assert.deepEqual(subscribed, ['a', 'a.repos', '-a', '-a.repos'])
})
