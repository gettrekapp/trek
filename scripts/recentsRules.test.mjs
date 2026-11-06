// scripts/recentsRules.test.mjs — recents of both kinds: parsing and adding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addRecentEntry, keepRecents, parseRecentRef, parseRecents, removeRecentEntry, serializeRecents, MAX_RECENTS } from '../src/main/recentsRules.ts'

const server = (projectId, name = 'P') => ({ kind: 'server', serverEntryId: 's', projectId, name, serverName: 'box' })

test('parseRecents keeps file paths and well-formed server entries', () => {
  assert.deepEqual(parseRecents(['/a.trekproj', 5, server('p1'), { kind: 'server', projectId: 'x' }, null]), [
    { kind: 'file', path: '/a.trekproj' },
    server('p1')
  ])
  assert.deepEqual(parseRecents('nope'), [])
})

test('parseRecents keeps server entries with empty labels but not empty ids', () => {
  const blank = { kind: 'server', serverEntryId: 's', projectId: 'p', name: '', serverName: '' }
  assert.deepEqual(parseRecents([blank]), [blank])
  assert.deepEqual(parseRecents([{ ...blank, serverEntryId: '' }, { ...blank, projectId: '' }]), [])
  assert.deepEqual(parseRecents([{ ...blank, name: 5 }, { kind: 'server', serverEntryId: 's', projectId: 'p', name: 'n' }]), [])
  assert.deepEqual(parseRecents(serializeRecents([blank])), [blank])
})

test('addRecentEntry puts the entry first, dedupes and caps the list', () => {
  let list = []
  for (let i = 0; i < MAX_RECENTS + 2; i++) list = addRecentEntry(list, server(`p${i}`))
  assert.equal(list.length, MAX_RECENTS)
  assert.equal(list[0].projectId, `p${MAX_RECENTS + 1}`)
  list = addRecentEntry(list, server('p5', 'Renamed'))
  assert.equal(list[0].name, 'Renamed')
  assert.equal(list.filter((e) => e.projectId === 'p5').length, 1)
  assert.deepEqual(addRecentEntry([{ kind: 'file', path: '/a' }], { kind: 'file', path: '/a' }), [{ kind: 'file', path: '/a' }])
})

test('keepRecents drops missing files only, and serializeRecents keeps files as strings', () => {
  const list = [{ kind: 'file', path: '/gone' }, server('p1'), { kind: 'file', path: '/here' }]
  assert.deepEqual(keepRecents(list, new Set(['/gone'])), [server('p1'), { kind: 'file', path: '/here' }])
  assert.deepEqual(serializeRecents(list), ['/gone', server('p1'), '/here'])
  assert.deepEqual(parseRecents(serializeRecents(list)), list)
})

test('removeRecentEntry drops the matching entry of either kind only', () => {
  const list = [{ kind: 'file', path: '/a.trekproj' }, server('p1'), server('p2'), { kind: 'file', path: '/b.trekproj' }]
  assert.deepEqual(removeRecentEntry(list, { kind: 'file', path: '/a.trekproj' }), list.slice(1))
  // Labels don't matter, the ids do.
  assert.deepEqual(removeRecentEntry(list, { ...server('p1'), name: 'other', serverName: '' }), [list[0], list[2], list[3]])
  assert.deepEqual(removeRecentEntry(list, { ...server('p1'), serverEntryId: 'other' }), list)
  assert.deepEqual(removeRecentEntry(list, { kind: 'file', path: '/missing' }), list)
})

test('parseRecentRef validates an entry named over IPC', () => {
  assert.deepEqual(parseRecentRef({ kind: 'file', path: '/a' }), { kind: 'file', path: '/a' })
  assert.deepEqual(parseRecentRef({ kind: 'server', serverEntryId: 's', projectId: 'p' }), {
    kind: 'server',
    serverEntryId: 's',
    projectId: 'p',
    name: '',
    serverName: ''
  })
  for (const bad of [null, '/a', { kind: 'file', path: '' }, { kind: 'file' }, { kind: 'server', serverEntryId: 's' }, { kind: 'server', serverEntryId: 5, projectId: 'p' }, { kind: 'x' }]) {
    assert.equal(parseRecentRef(bad), null, JSON.stringify(bad))
  }
})
