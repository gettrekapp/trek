// scripts/codexDiscovery.test.mjs
// Run under UTC+14 so a rollout's local date and UTC date are different days for 14 hours of
// every day; the fixed instants below make that deterministic.
process.env.TZ = 'Pacific/Kiritimati'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandExists, discoverCodexSession } from '../src/host/agentService.ts'

const pad = (n) => String(n).padStart(2, '0')

/** Writes a rollout. `file` names it independently of its timestamp; `dirs` picks the day directory. */
function rollout(root, iso, id, cwd, { file = `${iso.replace(/:/g, '-')}-${id}`, dirs = 'local' } = {}) {
  const d = new Date(iso)
  const [y, m, day] =
    dirs === 'utc'
      ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
      : [d.getFullYear(), d.getMonth() + 1, d.getDate()]
  const dir = join(root, String(y), pad(m), pad(day))
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd } })
  writeFileSync(join(dir, `rollout-${file}.jsonl`), `${line}\n{"type":"x"}\n`)
}

// 12:00 UTC is 02:00 the next day in Kiritimati.
const NOW = Date.parse('2026-11-04T12:00:10.000Z')
const AGE = 10_000 // launched at 12:00:00Z

function withRoot(fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'))
    try {
      await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('the timezone override makes local and UTC dates differ', () => {
  const d = new Date('2026-11-04T12:00:00.000Z')
  assert.notEqual(d.getDate(), d.getUTCDate())
})

test(
  'claims the earliest unclaimed rollout in the cwd started after launch',
  withRoot(async (root) => {
    rollout(root, '2026-11-04T11:59:00.000Z', 'old', '/w') // before launch
    rollout(root, '2026-11-04T12:00:03.000Z', 'other-cwd', '/x')
    // File names sort opposite to start times, so only the explicit sort picks "mine".
    rollout(root, '2026-11-04T12:00:05.000Z', 'mine', '/w', { file: 'b-mine' })
    rollout(root, '2026-11-04T12:00:06.000Z', 'theirs', '/w', { file: 'a-theirs' })
    const find = (exclude) => discoverCodexSession('/w', AGE, exclude, root, NOW)
    assert.equal(await find([]), 'mine')
    // A second tab launched at the same time skips the claimed one.
    assert.equal(await find(['mine']), 'theirs')
    assert.equal(await find(['mine', 'theirs']), undefined)
  })
)

test(
  'finds a session filed under the UTC date only',
  withRoot(async (root) => {
    rollout(root, '2026-11-04T12:00:05.000Z', 'utc-only', '/w', { dirs: 'utc' })
    assert.equal(await discoverCodexSession('/w', AGE, [], root, NOW), 'utc-only')
  })
)

test(
  'finds a session filed under the local date only',
  withRoot(async (root) => {
    rollout(root, '2026-11-04T12:00:05.000Z', 'local-only', '/w', { dirs: 'local' })
    assert.equal(await discoverCodexSession('/w', AGE, [], root, NOW), 'local-only')
  })
)

test('a missing sessions dir finds nothing', async () => {
  assert.equal(await discoverCodexSession('/w', 1000, [], '/nonexistent/codex'), undefined)
})

test('commandExists', async () => {
  assert.equal(await commandExists('sh'), true)
  assert.equal(await commandExists('definitely-not-a-command-xyz'), false)
})
