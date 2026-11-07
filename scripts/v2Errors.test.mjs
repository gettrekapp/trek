// scripts/v2Errors.test.mjs — a server window's error text, and the dialog for an edit the link dropped under.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EDIT_NOT_CONFIRMED, editReporter } from '../src/renderer/src/v2/errors.ts'

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

test('one "may not have been saved" dialog at a time', async () => {
  const shown = []
  let close
  const reportEdit = editReporter(
    (title) => {
      shown.push(title)
      return new Promise((r) => (close = r))
    },
    () => {}
  )
  reportEdit('Could not set the tag', coded('NOT_CONNECTED'))
  reportEdit('Could not save the note', coded('NOT_CONNECTED'))
  assert.deepEqual(shown, ['Could not set the tag'])
  close()
  await new Promise((r) => setImmediate(r))
  reportEdit('Could not queue the prompt', coded('NOT_CONNECTED'))
  assert.deepEqual(shown, ['Could not set the tag', 'Could not queue the prompt'])
})
