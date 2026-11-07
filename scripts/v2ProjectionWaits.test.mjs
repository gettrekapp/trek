// scripts/v2ProjectionWaits.test.mjs — a server window's waits for an action's result, and the
// view reset it applies on install and leave.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectionWaits, PROJECTION_WAIT_MS, REV_WAIT_MS } from '../src/renderer/src/v2/projectionWaits.ts'
import { EMPTY, VIEW_RESET, installPatch, leavePatch } from '../src/renderer/src/v2/windowState.ts'

const coded = (code) => Object.assign(new Error(code), { code })
const tick = () => new Promise((r) => setImmediate(r))

/**
 * A fake mirror whose whenRev calls stay open until settled by hand, a fake
 * store subscription and fake timers. `flags.left` is the window's left state.
 */
function setup({ mirror = true } = {}) {
  const flags = { left: false }
  const revCalls = []
  const listeners = new Set()
  const timers = []
  const waits = createProjectionWaits({
    mirror: () =>
      mirror
        ? {
            whenRev: (topic, rev, opts) =>
              new Promise((resolve, reject) => revCalls.push({ topic, rev, opts, resolve, reject }))
          }
        : undefined,
    left: () => flags.left,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setTimeout: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      timer.cleared = true
    }
  })
  const notify = () => [...listeners].forEach((l) => l())
  return { waits, flags, revCalls, listeners, timers, notify }
}

const rev = { topic: 'project:p1', rev: 7 }

test('a rev wait runs even when the check already holds (a note save settles on its own rev)', async () => {
  const { waits, revCalls } = setup()
  let settled = false
  const result = waits.whenProjected(() => true, rev).then((v) => ((settled = true), v))
  await tick()
  assert.equal(settled, false)
  assert.deepEqual(revCalls.map((c) => [c.topic, c.rev, c.opts.timeoutMs]), [['project:p1', 7, REV_WAIT_MS]])
  revCalls[0].resolve()
  assert.equal(await result, true)
})

test('whenRev failing (TIMEOUT, NOT_SUBSCRIBED, CLOSED) still resolves to check()', async () => {
  for (const code of ['TIMEOUT', 'NOT_SUBSCRIBED', 'CLOSED']) {
    const { waits, revCalls } = setup()
    let value = 'before'
    const result = waits.whenProjected(() => value, rev)
    await tick()
    value = `after ${code}`
    revCalls[0].reject(coded(code))
    assert.equal(await result, `after ${code}`)
    assert.equal(waits.waits.size, 0)
  }
})

test('leave ends a rev wait: it resolves undefined without reading the next store', async () => {
  const { waits, flags, revCalls } = setup()
  let checked = 0
  const result = waits.whenProjected(() => ++checked, rev)
  await tick()
  flags.left = true
  waits.cancelAll()
  assert.equal(await result, undefined)
  assert.equal(checked, 0)
  revCalls[0].resolve()
  assert.equal(await waits.whenProjected(() => 1, rev), undefined)
})

test('without a rev there is no mirror wait: the store is watched for up to 10 s', async () => {
  const { waits, revCalls, timers, listeners, notify } = setup()
  assert.equal(await waits.whenProjected(() => 'now'), 'now')
  let value
  const found = waits.whenProjected(() => value)
  assert.deepEqual(timers.map((t) => t.ms), [PROJECTION_WAIT_MS])
  value = 'later'
  notify()
  assert.equal(await found, 'later')
  assert.equal(timers[0].cleared, true)
  assert.equal(listeners.size, 0)
  const missing = waits.whenProjected(() => undefined)
  timers[1].run()
  assert.equal(await missing, undefined)
  assert.equal(revCalls.length, 0)
})

test('with a rev but no mirror it falls back to the store wait', async () => {
  const { waits, timers } = setup({ mirror: false })
  const result = waits.whenProjected(() => undefined, rev)
  assert.deepEqual(timers.map((t) => t.ms), [PROJECTION_WAIT_MS])
  waits.cancelAll()
  assert.equal(await result, undefined)
})

test('the view reset applies on install and on leave; the voice fields are left to stopAllSummaries', () => {
  const overrides = { renameTerminal: () => {} }
  const installed = installPatch(overrides)
  for (const [key, value] of Object.entries(VIEW_RESET)) assert.deepEqual(installed[key], value, key)
  assert.equal(installed.renameTerminal, overrides.renameTerminal)
  assert.deepEqual([installed.serverOffline, installed.serverLink, installed.globalPanelOpen, installed.globalView], [true, null, false, 'sessions'])
  const originals = { renameTerminal: () => {} }
  const left = leavePatch(originals)
  for (const [key, value] of Object.entries({ ...EMPTY, ...VIEW_RESET })) assert.deepEqual(left[key], value, key)
  assert.equal(left.renameTerminal, originals.renameTerminal)
  assert.equal('voicePlaying' in VIEW_RESET || 'voiceQueued' in VIEW_RESET, false)
})
