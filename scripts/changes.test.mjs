// scripts/changes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { changesTabLabel, startsExpanded, initiallyExpanded, missingPatchNote, patchBody, lineClass } from '../src/shared/changes.ts'

const file = (added, deleted, extra = {}) => ({
  path: 'f',
  status: 'modified',
  added,
  deleted,
  binary: false,
  ...extra
})

test('label falls back to Changes without a summary or without changes', () => {
  assert.equal(changesTabLabel(null), 'Changes')
  assert.equal(changesTabLabel({ base: null, files: [] }), 'Changes')
})

test('label totals files and lines', () => {
  assert.equal(
    changesTabLabel({ base: 'main', files: [file(40, 7), file(2, 0)] }),
    '2 files +42 −7'
  )
})

test('label uses the singular for one file', () => {
  assert.equal(changesTabLabel({ base: 'main', files: [file(1, 1)] }), '1 file +1 −1')
})

test('files start expanded up to 1500 changed lines', () => {
  assert.equal(startsExpanded(file(1000, 500)), true)
  assert.equal(startsExpanded(file(1000, 501)), false)
})

test('binary files start expanded so their note shows', () => {
  assert.equal(startsExpanded(file(0, 0, { binary: true })), true)
})

test('files too large to read start expanded so their note shows', () => {
  assert.equal(startsExpanded(file(0, 0, { tooLarge: true })), true)
})

test('unreadable files start expanded so their note shows', () => {
  assert.equal(startsExpanded(file(0, 0, { unreadable: true })), true)
})

const header = (name) =>
  `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n`

test('patchBody drops the header of a single patch', () => {
  const patch = `${header('a')}@@ -1 +1 @@\n-old\n+new\n`
  assert.deepEqual(patchBody(patch), ['@@ -1 +1 @@', '-old', '+new'])
})

test('patchBody keeps a deleted content line that starts with --', () => {
  const patch = `${header('a')}@@ -1,2 +1 @@\n--- a/not/a/header\n keep\n+++ nor this\n`
  assert.deepEqual(patchBody(patch), ['@@ -1,2 +1 @@', '--- a/not/a/header', ' keep', '+++ nor this'])
})

test('patchBody strips the headers between concatenated sections', () => {
  const second =
    'diff --git a/a b/a\nnew file mode 100644\nindex 000..333\n--- /dev/null\n+++ b/a\n'
  const patch = `diff --git a/a b/a\ndeleted file mode 100644\nindex 111..000\n--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n${second}@@ -0,0 +1 @@\n+back\n`
  assert.deepEqual(patchBody(patch), ['@@ -1 +0,0 @@', '-gone', '@@ -0,0 +1 @@', '+back'])
})

test('lineClass classifies by the first character', () => {
  assert.equal(lineClass('@@ -1 +1 @@'), 'hunk')
  assert.equal(lineClass('+added'), 'add')
  assert.equal(lineClass('-removed'), 'del')
  assert.equal(lineClass('--- was a deleted -- line'), 'del')
  assert.equal(lineClass('+++ was an added ++ line'), 'add')
  assert.equal(lineClass(' context'), '')
})

const named = (path, added, extra = {}) => ({ ...file(added, 0, extra), path })

test('initiallyExpanded expands files in order within the 5000 line budget', () => {
  const files = [named('a', 1500), named('b', 1500), named('c', 1500), named('d', 600), named('e', 1)]
  assert.deepEqual([...initiallyExpanded(files)], ['a', 'b', 'c'])
})

test('initiallyExpanded leaves over-limit files collapsed without spending budget', () => {
  const files = [named('big', 2000), named('a', 10)]
  assert.deepEqual([...initiallyExpanded(files)], ['a'])
})

test('initiallyExpanded always expands note-only rows at no cost', () => {
  const files = [
    named('a', 1500),
    named('b', 1500),
    named('c', 1500),
    named('d', 600),
    named('bin', 0, { binary: true }),
    named('large', 0, { tooLarge: true }),
    named('nope', 0, { unreadable: true })
  ]
  assert.deepEqual([...initiallyExpanded(files)], ['a', 'b', 'c', 'bin', 'large', 'nope'])
})

test('missingPatchNote explains a text row with no patch', () => {
  const idle = { loading: false, diffError: false }
  assert.equal(missingPatchNote(file(3, 1), { loading: true, diffError: false }), 'Loading…')
  assert.equal(missingPatchNote(file(3, 1), { loading: false, diffError: true }), 'Diff not available')
  assert.equal(missingPatchNote(file(3, 1), idle), 'Diff not shown: over the size limit')
  assert.equal(missingPatchNote(file(0, 2), idle), 'Diff not shown: over the size limit')
  assert.equal(missingPatchNote(file(0, 0), idle), 'No text changes')
})
