// scripts/codexDiscovery.test.mjs
// Run under UTC+14 so a rollout's local date and UTC date are different days for 14 hours of
// every day; the fixed instants below make that deterministic.
process.env.TZ = 'Pacific/Kiritimati'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('a symlinked cwd matches the rollout recorded under its real path, and back', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-cwd-'))
  const root = join(base, 'sessions')
  try {
    const real = join(base, 'real')
    mkdirSync(real)
    const link = join(base, 'link')
    symlinkSync(real, link)
    rollout(root, '2026-11-04T12:00:05.000Z', 'via-real', real)
    assert.equal(await discoverCodexSession(link, AGE, [], root, NOW), 'via-real')
    rollout(root, '2026-11-04T12:00:06.000Z', 'via-link', link)
    assert.equal(await discoverCodexSession(real, AGE, ['via-real'], root, NOW), 'via-link')
    // A path that doesn't exist still matches by its exact string.
    rollout(root, '2026-11-04T12:00:07.000Z', 'gone', '/no/such/dir')
    assert.equal(await discoverCodexSession('/no/such/dir', AGE, [], root, NOW), 'gone')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('CODEX_HOME moves the sessions folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const saved = process.env.CODEX_HOME
  try {
    rollout(join(home, 'sessions'), '2026-11-04T12:00:05.000Z', 'in-home', '/w')
    process.env.CODEX_HOME = home
    assert.equal(await discoverCodexSession('/w', AGE, [], undefined, NOW), 'in-home')
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing sessions dir finds nothing', async () => {
  assert.equal(await discoverCodexSession('/w', 1000, [], '/nonexistent/codex'), undefined)
})

test('commandExists', async () => {
  assert.equal(await commandExists('sh'), true)
  assert.equal(await commandExists('definitely-not-a-command-xyz'), false)
})

import { pickClaimant, pollDelay } from '../src/shared/providers/discovery.ts'

const tab = (id, startedAt, status = 'working', sessionPending = true) => ({ id, status, sessionPending, startedAt })

test('pickClaimant: the oldest eligible tab wins', () => {
  assert.equal(pickClaimant([tab('b', 200), tab('a', 100), tab('c', 300)])?.id, 'a')
})

test('pickClaimant: an exited tab is skipped', () => {
  assert.equal(pickClaimant([tab('a', 100, 'exited'), tab('b', 200)])?.id, 'b')
})

test('pickClaimant: bound tabs are skipped', () => {
  assert.equal(pickClaimant([tab('a', 100, 'working', false), tab('b', 200, 'starting')])?.id, 'b')
})

test('pickClaimant: none eligible gives undefined', () => {
  assert.equal(pickClaimant([]), undefined)
  assert.equal(pickClaimant([tab('a', 100, 'exited'), tab('b', 200, 'idle', false)]), undefined)
})

test('pickClaimant: a tab whose launch failed (marked exited) is skipped', () => {
  assert.equal(pickClaimant([tab('a', 100, 'exited')]), undefined)
  assert.equal(pickClaimant([tab('a', 100, 'exited'), tab('b', 200, 'starting')])?.id, 'b')
})

test('pollDelay: fast for the first minute, then slow', () => {
  assert.equal(pollDelay(0), 2000)
  assert.equal(pollDelay(59_999), 2000)
  assert.equal(pollDelay(60_000), 15_000)
})

import { isUnknownMethodError } from '../src/shared/providers/discovery.ts'

test('isUnknownMethodError spots an old daemon through IPC', () => {
  const ipc = new Error(
    "Error invoking remote method 'agents:discoverCodexSession': Error: Unknown method: agents.discoverCodexSession"
  )
  assert.equal(isUnknownMethodError(ipc), true)
  const coded = Object.assign(new Error('nope'), { code: 'NOT_FOUND' })
  assert.equal(isUnknownMethodError(coded), true)
  assert.equal(isUnknownMethodError(new Error('Server "x" is not connected')), false)
  assert.equal(isUnknownMethodError('Unknown method: x'), true)
  assert.equal(isUnknownMethodError(undefined), false)
})
