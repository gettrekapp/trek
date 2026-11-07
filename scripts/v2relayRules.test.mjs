// scripts/v2relayRules.test.mjs — the relay's ownership table, one watch per window, and close-code rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SOCKETS_PER_OWNER, RelayTable, clampCloseCode, clampCloseReason, goneRefusal, relayRefusal } from '../src/main/v2relayRules.ts'
import { SERVER_REMOVED_MESSAGE } from '../src/shared/client/index.ts'

test('clampCloseCode keeps 1000 and 3000–4999, otherwise 1000', () => {
  for (const ok of [1000, 3000, 4000, 4999]) assert.equal(clampCloseCode(ok), ok)
  for (const bad of [undefined, null, '4000', 999, 1001, 1006, 2999, 5000, 4000.5, NaN]) {
    assert.equal(clampCloseCode(bad), 1000)
  }
})

test('clampCloseReason caps at 123 UTF-8 bytes on a character boundary', () => {
  assert.equal(clampCloseReason(undefined), '')
  assert.equal(clampCloseReason(42), '')
  assert.equal(clampCloseReason('bye'), 'bye')
  assert.equal(clampCloseReason('a'.repeat(200)), 'a'.repeat(123))
  const cut = clampCloseReason('é'.repeat(100))
  assert.equal(cut, 'é'.repeat(61))
  assert.ok(Buffer.byteLength(cut) <= 123)
})

test('owned returns a socket only to the window that opened it', () => {
  const a = {}
  const b = {}
  const table = new RelayTable()
  table.add({ id: 's1', serverEntryId: 'x', owner: a })
  assert.equal(table.owned('s1', a)?.id, 's1')
  assert.equal(table.owned('s1', b), undefined)
  assert.equal(table.owned('missing', a), undefined)
  assert.equal(table.owned(1, a), undefined)
  table.delete('s1')
  assert.equal(table.owned('s1', a), undefined)
})

test('forServer and forOwner select by server entry and by window', () => {
  const a = {}
  const b = {}
  const table = new RelayTable()
  table.add({ id: '1', serverEntryId: 'x', owner: a })
  table.add({ id: '2', serverEntryId: 'y', owner: a })
  table.add({ id: '3', serverEntryId: 'x', owner: b })
  assert.deepEqual(table.forServer('x').map((e) => e.id), ['1', '3'])
  assert.deepEqual(table.forOwner(a).map((e) => e.id), ['1', '2'])
  assert.deepEqual(table.forServer('z'), [])
  assert.equal(table.size, 3)
})

test('watch is true once per window', () => {
  const a = {}
  const b = {}
  const table = new RelayTable()
  assert.equal(table.watch(a), true)
  assert.equal(table.watch(a), false)
  assert.equal(table.watch(b), true)
})

test('delete and has report whether the socket is still in the table', () => {
  const a = {}
  const table = new RelayTable()
  table.add({ id: 's1', serverEntryId: 'x', owner: a })
  assert.equal(table.has('s1'), true)
  assert.equal(table.delete('s1'), true)
  assert.equal(table.has('s1'), false)
  assert.equal(table.delete('s1'), false, 'a second close is not reported')
})

test('generation starts at 0 per window and bumps independently', () => {
  const a = {}
  const b = {}
  const table = new RelayTable()
  assert.equal(table.generation(a), 0)
  const before = table.generation(a)
  assert.equal(table.bumpGeneration(a), 1)
  assert.notEqual(table.generation(a), before, 'an open begun before the bump sees a change')
  assert.equal(table.bumpGeneration(a), 2)
  assert.equal(table.generation(b), 0)
})

test('atCapacity caps sockets per window, 16 by default', () => {
  assert.equal(MAX_SOCKETS_PER_OWNER, 16)
  const a = {}
  const b = {}
  const table = new RelayTable()
  for (let i = 0; i < 15; i++) table.add({ id: `a${i}`, serverEntryId: 'x', owner: a })
  assert.equal(table.atCapacity(a), false)
  table.add({ id: 'a15', serverEntryId: 'x', owner: a })
  assert.equal(table.atCapacity(a), true)
  assert.equal(table.atCapacity(b), false, 'another window has its own budget')
  table.delete('a0')
  assert.equal(table.atCapacity(a), false)
  const small = new RelayTable(2)
  small.add({ id: '1', serverEntryId: 'x', owner: a })
  assert.equal(small.atCapacity(a), false)
  small.add({ id: '2', serverEntryId: 'x', owner: a })
  assert.equal(small.atCapacity(a), true)
})

test('goneRefusal: removed is final only once the remove has written the list', () => {
  assert.deepEqual(goneRefusal(false), { ok: false, removed: true, reason: SERVER_REMOVED_MESSAGE })
  assert.deepEqual(goneRefusal(true), { ok: false, removed: false, reason: 'Server being removed' }, 'a remove that may yet fail is temporary')
})

test('relayRefusal: after the token read, the open goes on only if the entry still has the URL it had', () => {
  const before = { url: 'ws://box:1' }
  assert.equal(relayRefusal(before, { url: 'ws://box:1' }, false), null)
  assert.deepEqual(relayRefusal(before, { url: 'wss://evil:1' }, false), { ok: false, removed: false, reason: 'Server changed' }, 're-pointed: temporary')
  assert.deepEqual(relayRefusal(before, undefined, false), { ok: false, removed: true, reason: SERVER_REMOVED_MESSAGE }, 'removed and written: final')
  assert.deepEqual(relayRefusal(before, undefined, true), { ok: false, removed: false, reason: 'Server being removed' }, 'removing: temporary')
})
