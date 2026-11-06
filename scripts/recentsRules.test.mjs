// scripts/recentsRules.test.mjs — recents of both kinds: parsing and adding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addRecentEntry, parseRecents, MAX_RECENTS } from '../src/main/recentsRules.ts'

const server = (projectId, name = 'P') => ({ kind: 'server', serverEntryId: 's', projectId, name, serverName: 'box' })

test('parseRecents keeps file paths and well-formed server entries', () => {
  assert.deepEqual(parseRecents(['/a.trekproj', 5, server('p1'), { kind: 'server', projectId: 'x' }, null]), [
    { kind: 'file', path: '/a.trekproj' },
    server('p1')
  ])
  assert.deepEqual(parseRecents('nope'), [])
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
