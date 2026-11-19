// scripts/pluginSlots.test.mjs — which plugins fill a slot (campsite): active ones in built-in
// order; for sessionIndicator, only the first.
import test from 'node:test'
import assert from 'node:assert/strict'
import { activeSlotEntries, firstActiveSlot } from '../src/renderer/src/plugins/slots.ts'
import { DIM_AFTER_KEY_MS, overlayDimmed } from '../src/renderer/src/plugins/overlayDim.ts'

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

test('overlayDimmed: while scrolled back, or within 3 s of a key', () => {
  assert.equal(DIM_AFTER_KEY_MS, 3000)
  assert.equal(overlayDimmed({ lastKeyAt: null, now: 10_000, scrolledUp: false }), false)
  assert.equal(overlayDimmed({ lastKeyAt: null, now: 10_000, scrolledUp: true }), true)
  assert.equal(overlayDimmed({ lastKeyAt: 8_000, now: 10_000, scrolledUp: false }), true)
  assert.equal(overlayDimmed({ lastKeyAt: 7_000, now: 10_000, scrolledUp: false }), false)
})
