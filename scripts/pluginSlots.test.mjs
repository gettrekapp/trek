// scripts/pluginSlots.test.mjs — which plugins fill a slot (campsite): active ones in built-in
// order; for sessionIndicator, only the first.
import test from 'node:test'
import assert from 'node:assert/strict'
import { activeSlotEntries, firstActiveSlot } from '../src/renderer/src/plugins/slots.ts'

const entry = (id, status, slots) => ({ plugin: { manifest: { id }, slots }, status, host: {}, key: id })
const Comp = () => null

test('activeSlotEntries: on or legacy plugins that fill the slot, in order', () => {
  const entries = [entry('a', 'on', { bottomBar: Comp }), entry('b', 'off', { bottomBar: Comp }), entry('c', 'legacy', { bottomBar: Comp }), entry('d', 'on', {})]
  assert.deepEqual(activeSlotEntries(entries, 'bottomBar').map((e) => e.plugin.manifest.id), ['a', 'c'])
})

test('firstActiveSlot: the first active one, or undefined', () => {
  const entries = [entry('a', 'missing', { sessionIndicator: Comp }), entry('b', 'on', { sessionIndicator: Comp }), entry('c', 'on', { sessionIndicator: Comp })]
  assert.equal(firstActiveSlot(entries, 'sessionIndicator')?.plugin.manifest.id, 'b')
  assert.equal(firstActiveSlot([], 'sessionIndicator'), undefined)
})
