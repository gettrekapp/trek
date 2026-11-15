// scripts/mainApplyServerUpdate.test.mjs — "Update" on a server's row, as main handles it: the
// server's status is read fresh, the question is built from that answer, and the version sent is
// the one the question named.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyServerUpdate } from '../src/main/applyServerUpdate.ts'

const STATUS = { current: '1.0.0', latest: '2.0.0', state: 'idle', sessions: 0, canRelaunch: true, restartNeeded: false, remoteApply: true }

/** An entry "build box" with main's connection `link`; `fresh` is what the server answers now. */
function setup({ fresh = STATUS, answer = true } = {}) {
  const w = {
    entry: { name: 'build box', link: { n: 1 }, connected: true },
    fresh,
    answer,
    asked: [],
    sent: [],
    refreshed: 0,
    /** Runs while the question is open */
    during: () => {}
  }
  const deps = {
    entry: (id) => (id === 'box' ? w.entry : undefined),
    updates: {
      refresh: async () => {
        w.refreshed++
        if (w.fresh instanceof Error) throw w.fresh
        return w.fresh
      },
      apply: async (id, version) => {
        w.sent.push([id, version])
      }
    },
    ask: async (confirm) => {
      w.asked.push(confirm)
      w.during()
      return w.answer
    }
  }
  return { w, run: () => applyServerUpdate('box', deps) }
}

test('the question is built from the status read now, not from what main remembered: the terminals are the ones open at the click', async () => {
  const { w, run } = setup({ fresh: { ...STATUS, sessions: 3 } })
  assert.deepEqual(await run(), { started: true })
  assert.equal(w.refreshed, 1)
  assert.equal(w.asked.length, 1)
  assert.equal(w.asked[0].message, 'Update trek-server on “build box” to 2.0.0?')
  assert.match(w.asked[0].detail, /Its 3 terminals close;/)
  assert.deepEqual(w.sent, [['box', '2.0.0']])
})

test('the version sent is the version shown: the fresh status’s latest', async () => {
  const { w, run } = setup({ fresh: { ...STATUS, latest: '2.1.0' } })
  await run()
  assert.match(w.asked[0].message, / to 2\.1\.0\?$/)
  assert.deepEqual(w.sent, [['box', '2.1.0']])
})

test('Cancel sends nothing', async () => {
  const { w, run } = setup({ answer: false })
  assert.deepEqual(await run(), { started: false })
  assert.equal(w.asked.length, 1)
  assert.deepEqual(w.sent, [])
})

test('an entry removed or re-pointed while the question was open is sent nothing', async () => {
  for (const change of [(w) => { w.entry = undefined }, (w) => { w.entry = { ...w.entry, link: { n: 2 } } }]) {
    const { w, run } = setup()
    w.during = () => change(w)
    await assert.rejects(run(), { message: 'Not connected to this server' })
    assert.equal(w.asked.length, 1)
    assert.deepEqual(w.sent, [])
  }
})

test('no question when the fresh status has nothing to install, leaves it to the machine, or is busy: the reason instead', async () => {
  for (const [fresh, message] of [
    [{ ...STATUS, latest: undefined }, 'No update is available for this server'],
    [{ ...STATUS, remoteApply: false }, /set to be updated on its own machine/],
    [{ ...STATUS, state: 'installing' }, 'An update is already running on this server'],
    [{ ...STATUS, state: 'checking' }, 'The server is checking for an update: try again in a moment']
  ]) {
    const { w, run } = setup({ fresh })
    await assert.rejects(run(), { message })
    assert.deepEqual([w.asked.length, w.sent.length], [0, 0])
  }
})

test('a server that refuses the read, or an entry that is not connected, shows the reason and no question', async () => {
  const refused = setup({ fresh: new Error('The server did not answer in time') })
  await assert.rejects(refused.run(), { message: 'The server did not answer in time' })
  assert.deepEqual([refused.w.asked.length, refused.w.sent.length], [0, 0])

  const away = setup()
  away.w.entry = { ...away.w.entry, connected: false }
  await assert.rejects(away.run(), { message: 'Not connected to this server' })
  assert.equal(away.w.refreshed, 0)
  const gone = setup()
  gone.w.entry = undefined
  await assert.rejects(gone.run(), { message: 'Not connected to this server' })
})

test('an entry re-pointed while the status was being read is asked nothing', async () => {
  const { w, run } = setup()
  const running = run()
  // After the read was sent, before its answer is used.
  w.entry = { ...w.entry, link: { n: 2 } }
  await assert.rejects(running, { message: 'Not connected to this server' })
  assert.deepEqual([w.refreshed, w.asked.length, w.sent.length], [1, 0, 0])
})
