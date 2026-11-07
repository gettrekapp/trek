// scripts/v2NoteDraft.test.mjs — a server window's notes draft and the note it expects to replace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { editNote, noteSaveFailed, noteSaved, noteUnsaved, planNoteSave, settleNote } from '../src/renderer/src/v2/noteDraft.ts'

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

test('the window\'s own save settles against the mirror, which already shows it', () => {
  // The server publishes the patch before it answers: `note` already changed before the save resolved.
  const d = editNote(null, '', 'mine')
  assert.equal(settleNote(noteSaved(d, 'mine'), 'mine'), null)
})

test('a draft whose text the mirror shows settles even with a stale base', () => {
  // A save that landed though its answer was lost with the link.
  const d = editNote(null, 'old', 'new')
  assert.equal(settleNote(d, 'new'), null)
  assert.equal(settleNote(d, 'old'), d)
  assert.equal(settleNote(null, 'x'), null)
})

test('a save sends the draft over its base, or waits', () => {
  const d = editNote(null, 'old', 'new')
  const idle = { offline: false, inFlight: false }
  assert.deepEqual(planNoteSave(d, idle), { kind: 'send', text: 'new', expected: 'old' })
  assert.deepEqual(planNoteSave(null, idle), { kind: 'none' })
  assert.deepEqual(planNoteSave(noteSaved(d, 'new'), idle), { kind: 'none' })
  assert.deepEqual(planNoteSave(d, { offline: true, inFlight: false }), { kind: 'offline' })
  assert.deepEqual(planNoteSave(d, { offline: false, inFlight: true }), { kind: 'busy' })
  // Nothing unsaved wins over offline and busy.
  assert.deepEqual(planNoteSave(noteSaved(d, 'new'), { offline: true, inFlight: true }), { kind: 'none' })
})

test('a save chained after one in flight expects the base that one moved to', () => {
  let d = editNote(null, '', 'a')
  const first = planNoteSave(d, { offline: false, inFlight: false })
  d = editNote(d, '', 'ab') // typed while the first is in flight
  assert.deepEqual(planNoteSave(d, { offline: false, inFlight: true }), { kind: 'busy' })
  d = noteSaved(d, first.text)
  assert.deepEqual(planNoteSave(d, { offline: false, inFlight: false }), { kind: 'send', text: 'ab', expected: 'a' })
})

test('a failed save keeps the draft unless it conflicted', () => {
  assert.deepEqual(noteSaveFailed('NOT_CONNECTED', 'the connection closed', 'mine', 'old'), { keep: true, dialog: null })
  assert.deepEqual(noteSaveFailed('TIMEOUT', 'branch.setNote timed out', 'mine', 'old'), {
    keep: true,
    dialog: { title: 'Could not save the note', message: 'branch.setNote timed out' }
  })
  assert.deepEqual(noteSaveFailed(null, 'boom', 'mine', 'old').keep, true)
  const conflict = noteSaveFailed('CONFLICT', 'expected mismatch', 'mine', 'theirs')
  assert.equal(conflict.keep, false)
  assert.equal(conflict.dialog.title, 'The note was changed elsewhere')
  assert.match(conflict.dialog.message, /Your text was:\n\nmine$/)
  // The note already is the text (its own save landed before the link dropped): drop it quietly.
  assert.deepEqual(noteSaveFailed('CONFLICT', 'expected mismatch', 'mine', 'mine'), { keep: false, dialog: null })
})

test('a NOT_FOUND refusal (the branch is gone) drops the draft and shows its text', () => {
  assert.deepEqual(noteSaveFailed('NOT_FOUND', 'no such branch', 'mine', ''), {
    keep: false,
    dialog: { title: 'Could not save the note', message: 'no such branch\n\nYour text was:\n\nmine' }
  })
})
