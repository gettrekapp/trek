// scripts/serverCoalescer.test.mjs — per-key serial runs with one shared follow-up.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Coalescer } from '../server/src/git/coalescer.ts'

function gate() {
  let open
  const promise = new Promise((r) => { open = r })
  return { promise, open }
}

test('a run returns its result', async () => {
  assert.equal(await new Coalescer().run('k', async () => 42), 42)
})

test('callers during a run share one follow-up run that starts after it', async () => {
  const c = new Coalescer()
  const g = gate()
  const log = []
  let n = 0
  const job = async () => { const me = ++n; log.push(`start ${me}`); if (me === 1) await g.promise; log.push(`end ${me}`); return me }
  const first = c.run('k', job)
  await Promise.resolve()
  const second = c.run('k', job)
  const third = c.run('k', job)
  assert.equal(second, third)
  g.open()
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 2])
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2'])
})

test('a failed run rejects its callers but does not block the follow-up', async () => {
  const c = new Coalescer()
  const first = c.run('k', async () => { throw new Error('boom') })
  const second = c.run('k', async () => 'ok')
  await assert.rejects(first, /boom/)
  assert.equal(await second, 'ok')
})

test('a synchronous throw becomes a rejection', async () => {
  await assert.rejects(new Coalescer().run('k', () => { throw new Error('sync') }), /sync/)
})

test('different keys run independently', async () => {
  const c = new Coalescer()
  const g = gate()
  const slow = c.run('a', () => g.promise.then(() => 'a'))
  assert.equal(await c.run('b', async () => 'b'), 'b')
  g.open()
  assert.equal(await slow, 'a')
})

test('after everything settles a new run starts fresh', async () => {
  const c = new Coalescer()
  await c.run('k', async () => 1)
  let ran = false
  await c.run('k', async () => { ran = true })
  assert.equal(ran, true)
})
