// scripts/codexDiscovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandExists, discoverCodexSession } from '../src/host/agentService.ts'

function rollout(root, iso, id, cwd) {
  const d = new Date(iso)
  const dir = join(
    root,
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  )
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd } })
  writeFileSync(join(dir, `rollout-${iso.replace(/:/g, '-')}-${id}.jsonl`), `${line}\n{"type":"x"}\n`)
}

test('claims the earliest unclaimed rollout in the cwd started after launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-'))
  try {
    const launch = Date.parse('2026-11-04T10:00:00.000Z')
    rollout(root, '2026-11-04T09:59:00.000Z', 'old', '/w') // before launch
    rollout(root, '2026-11-04T10:00:03.000Z', 'other-cwd', '/x')
    rollout(root, '2026-11-04T10:00:05.000Z', 'mine', '/w')
    rollout(root, '2026-11-04T10:00:06.000Z', 'theirs', '/w')
    assert.equal(await discoverCodexSession('/w', launch, [], root), 'mine')
    // A second tab launched at the same time skips the claimed one.
    assert.equal(await discoverCodexSession('/w', launch, ['mine'], root), 'theirs')
    assert.equal(await discoverCodexSession('/w', launch, ['mine', 'theirs'], root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing sessions dir finds nothing', async () => {
  assert.equal(await discoverCodexSession('/w', Date.now(), [], '/nonexistent/codex'), undefined)
})

test('commandExists', async () => {
  assert.equal(await commandExists('sh'), true)
  assert.equal(await commandExists('definitely-not-a-command-xyz'), false)
})
