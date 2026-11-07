// scripts/v2NoteDraft.test.mjs — a server window's notes draft and the note it expects to replace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { editNote, noteSaved, noteUnsaved, settleNote } from '../src/renderer/src/v2/noteDraft.ts'

test('a draft starts from the saved note and keeps that base while typing', () => {
  let d = editNote(null, 'old', 'old!')
  d = editNote(d, 'changed by the patch meanwhile', 'old!!')
  assert.deepEqual(d, { text: 'old!!', base: 'old' })
  assert.equal(noteUnsaved(d), true)
})

test('a save moves the base; the draft settles once the mirror shows it', () => {
  let d = editNote(null, '', 'hello')
  d = noteSaved(d, 'hello')
  assert.deepEqual(d, { text: 'hello', base: 'hello' })
  assert.equal(noteUnsaved(d), false)
  // The patch is not here yet: keep showing the draft.
  assert.equal(settleNote(d, ''), d)
  assert.equal(settleNote(d, 'hello'), null)
})

test('typing after a save keeps the draft until that is saved too', () => {
  let d = noteSaved(editNote(null, '', 'a'), 'a')
  d = editNote(d, 'a', 'ab')
  assert.deepEqual(d, { text: 'ab', base: 'a' })
  assert.equal(settleNote(d, 'a'), d)
  assert.equal(noteSaved(null, 'x'), null)
})
