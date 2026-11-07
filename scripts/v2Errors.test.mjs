// scripts/v2Errors.test.mjs — a server window's error text, and the dialog for an edit the link dropped under.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ALSO_NOT_CONFIRMED, EDIT_NOT_CONFIRMED, PROMPT_NOT_CONFIRMED, editReporter, withPromptText } from '../src/renderer/src/v2/errors.ts'

const coded = (code, message = '') => Object.assign(new Error(message), { code })

test('an edit refused by the server goes to report; NOT_CONNECTED says it may be lost', () => {
  const shown = []
  const reports = []
  const reportEdit = editReporter(
    async (title, message) => void shown.push([title, message]),
    (title, err) => reports.push([title, err.code])
  )
  reportEdit('Could not set the tag', coded('BAD_REQUEST', 'no such tag'))
  reportEdit('Could not rename the session', coded('NOT_CONNECTED'))
  assert.deepEqual(reports, [['Could not set the tag', 'BAD_REQUEST']])
  assert.deepEqual(shown, [['Could not rename the session', EDIT_NOT_CONFIRMED]])
})

test('one "may not have been saved" dialog at a time, then one for the edits dropped meanwhile', async () => {
  const shown = []
  const closers = []
  const reports = []
  const reportEdit = editReporter(
    (title, message) => {
      shown.push([title, message])
      return new Promise((r) => closers.push(r))
    },
    (title, err) => reports.push([title, err.code])
  )
  reportEdit('Could not set the tag', coded('NOT_CONNECTED'))
  reportEdit('Could not save the note', coded('NOT_CONNECTED'))
  reportEdit('Could not set the ticket', coded('NOT_CONNECTED'))
  // Any other error is still reported while the dialog is open.
  reportEdit('Could not rename the session', coded('CONFLICT', 'renamed elsewhere'))
  assert.deepEqual(shown, [['Could not set the tag', EDIT_NOT_CONFIRMED]])
  assert.deepEqual(reports, [['Could not rename the session', 'CONFLICT']])
  closers.shift()()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(shown.at(-1), ['Could not save the note', ALSO_NOT_CONFIRMED])
  closers.shift()()
  await new Promise((r) => setImmediate(r))
  assert.equal(shown.length, 2)
  reportEdit('Could not send the prompt', coded('NOT_CONNECTED'), PROMPT_NOT_CONFIRMED)
  assert.deepEqual(shown.at(-1), ['Could not send the prompt', PROMPT_NOT_CONFIRMED])
})

test('a dialog that fails to open frees the reporter, with no unhandled rejection', async () => {
  const shown = []
  let fail = true
  const reportEdit = editReporter(
    (title) => {
      shown.push(title)
      return fail ? Promise.reject(new Error('window gone')) : Promise.resolve()
    },
    () => {}
  )
  reportEdit('Could not set the tag', coded('NOT_CONNECTED'))
  fail = false
  await new Promise((r) => setImmediate(r))
  reportEdit('Could not save the note', coded('NOT_CONNECTED'))
  assert.deepEqual(shown, ['Could not set the tag', 'Could not save the note'])
})

test("a failed prompt's dialog ends with the prompt; the burst follow-up covers prompts too", () => {
  assert.equal(withPromptText('Not sent', 'do it'), 'Not sent\n\nThe prompt was:\n\ndo it')
  assert.match(ALSO_NOT_CONFIRMED, /changes or prompts/)
})
