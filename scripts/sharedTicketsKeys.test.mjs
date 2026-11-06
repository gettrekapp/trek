// ticket parsing/URLs and named keys, shared by desktop and server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLinearTicket, parseTicket, ticketUrl } from '../src/shared/tickets.ts'
import { KEY_SEQUENCES, keySequence } from '../src/shared/keys.ts'

test('parseTicket', () => {
  assert.deepEqual(parseTicket('https://linear.app/acme/issue/tow-12/x'), { ticketId: 'TOW-12', linearWorkspace: 'acme' })
  assert.deepEqual(parseTicket('https://dev.azure.com/o/p/_workitems/edit/42'), { ticketId: '42', azureDevOpsBaseUrl: 'https://dev.azure.com/o/p' })
  assert.deepEqual(parseTicket(' tow-9 '), { ticketId: 'TOW-9' })
  assert.deepEqual(parseTicket('123'), { ticketId: '123' })
  assert.equal(parseTicket('not a ticket'), null)
  assert.equal(isLinearTicket('TOW-1'), true)
  assert.equal(isLinearTicket('12'), false)
})

test('ticketUrl', () => {
  assert.equal(ticketUrl({ linearWorkspace: 'acme' }, 'TOW-1'), 'https://linear.app/acme/issue/TOW-1')
  assert.equal(ticketUrl({}, 'TOW-1'), null)
  assert.equal(ticketUrl({ azureDevOpsBaseUrl: 'https://d/o/p/' }, '7'), 'https://d/o/p/_workitems/edit/7')
  assert.equal(ticketUrl({ linearWorkspace: 'a' }, 'TOW-1', { url: 'https://x' }), 'https://x')
})

test('keySequence maps named keys and passes literal text', () => {
  assert.equal(keySequence('enter'), '\r')
  assert.equal(keySequence('ctrl-c'), '\x03')
  assert.equal(keySequence('hello'), 'hello')
  assert.equal(KEY_SEQUENCES.esc, '\x1b')
})
