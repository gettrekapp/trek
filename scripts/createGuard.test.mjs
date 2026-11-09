// scripts/createGuard.test.mjs — the start screen's create guard holds until the create and its open settle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInFlight, whileCreating } from '../src/renderer/src/createGuard.ts'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('the guard holds while the create runs and while the open that follows it is still in flight', async () => {
  const created = deferred()
  const opened = deferred()
  assert.equal(createInFlight(), false)
  const run = whileCreating(async () => {
    await created.promise
    // The create returned: the open is what is left, and the guard still holds.
    await opened.promise
    return 'done'
  })
  assert.equal(createInFlight(), true)
  created.resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(createInFlight(), true, 'still held between the create and the end of the open')
  opened.resolve()
  assert.equal(await run, 'done')
  assert.equal(createInFlight(), false)
})

test('a failed run lifts the guard too, and two at once hold it until both settle', async () => {
  const a = deferred()
  const b = deferred()
  const first = whileCreating(() => a.promise)
  const second = whileCreating(() => b.promise)
  a.reject(new Error('refused'))
  await assert.rejects(first, /refused/)
  assert.equal(createInFlight(), true)
  b.resolve()
  await second
  assert.equal(createInFlight(), false)
})
