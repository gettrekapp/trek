// scripts/campsiteServer.test.mjs — the campsite's server half (campsite part 2): camp.json, and the
// wiring from the activity feed to the camp with a fake host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCampStore } from '../plugins/campsite/server/store.ts'

const T0 = 1_800_000_000_000
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-camp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A schedule whose jobs run when the test says */
const manual = () => {
  const jobs = []
  return { jobs, schedule: (fn, ms) => { const job = { fn, ms, cancelled: false }; jobs.push(job); return { cancel: () => { job.cancelled = true } } }, run: () => { for (const j of jobs.splice(0)) if (!j.cancelled) j.fn() } }
}

test('no file: a new camp; a change saves once after the debounce, atomically', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const clock = manual()
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: clock.schedule })
  assert.equal(store.camp.wood, 0)
  store.camp.wood = 5
  store.changed()
  store.changed()
  assert.equal(clock.jobs.length, 1, 'one pending save')
  assert.equal(existsSync(file), false)
  clock.run()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).wood, 5)
  assert.equal(existsSync(`${file}.tmp`), false)
})

test('a saved camp loads back; flush saves at once; dispose flushes', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const a = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: manual().schedule })
  a.camp.markers = 2
  a.flush()
  const clock = manual()
  const b = openCampStore(file, { now: () => T0 + 1, seed: () => 9, warn: () => {}, schedule: clock.schedule })
  assert.equal(b.camp.markers, 2)
  assert.equal(b.camp.seed, 7)
  b.camp.markers = 3
  b.changed()
  b.dispose()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).markers, 3)
})

test('an unreadable camp.json is moved to camp.json.bak and a new camp starts, with a warning', (t) => {
  const file = join(tempDir(t), 'camp.json')
  writeFileSync(file, '{not json')
  const warnings = []
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.equal(store.camp.wood, 0)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{not json')
  assert.equal(warnings.length, 1)
})
