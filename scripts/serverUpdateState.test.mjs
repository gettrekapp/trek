// scripts/serverUpdateState.test.mjs — an update's memory: the markers in the install folder that
// carry it across a restart, and update-state.json's record of how the last one went.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_FILE, ROLLED_BACK_FILE, STATE_FILE, TRIED_FILE, readState, settleStart, writePending, writeState } from '../server/src/update/state.ts'
import { removeDir } from './testPlatform.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'trek-update-state-'))
const NOW = new Date('2026-11-14T10:00:00.000Z')

test('the marker and state files have the names the launcher and the docs use', () => {
  assert.deepEqual([PENDING_FILE, TRIED_FILE, ROLLED_BACK_FILE, STATE_FILE], ['update-pending.json', 'update-pending.tried', 'update-rolled-back.json', 'update-state.json'])
})

test('update-state.json: a missing or corrupt file is empty; a write merges and keeps the rest', () => {
  const dir = temp()
  try {
    assert.deepEqual(readState(dir), {})
    writeFileSync(join(dir, STATE_FILE), '{nope')
    assert.deepEqual(readState(dir), {})
    for (const notAnObject of ['[1]', 'null', '"text"']) {
      writeFileSync(join(dir, STATE_FILE), notAnObject)
      assert.deepEqual(readState(dir), {}, notAnObject)
    }
    writeState(dir, { lastCheckAt: '2026-11-14T09:00:00.000Z', latest: '2.0.0' })
    writeState(dir, { lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() } })
    assert.deepEqual(readState(dir), {
      lastCheckAt: '2026-11-14T09:00:00.000Z',
      latest: '2.0.0',
      lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() }
    })
    writeState(dir, { latest: undefined })
    assert.equal(readState(dir).latest, undefined, 'an undefined value removes the key')
    assert.equal('latest' in JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')), false, 'removed from the file, not written as null')
    assert.equal(readState(dir).lastCheckAt, '2026-11-14T09:00:00.000Z')
    assert.equal(readState(dir).lastResult.to, '2.0.0')
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, STATE_FILE)).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), [STATE_FILE], 'no temp file is left beside it')
  } finally {
    removeDir(dir)
  }
})

test('a new version that reaches listening settles its pending marker as a success', () => {
  const install = temp()
  const config = temp()
  try {
    writePending(install, { from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' })
    assert.deepEqual(JSON.parse(readFileSync(join(install, PENDING_FILE), 'utf8')), { from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' })
    writeFileSync(join(install, TRIED_FILE), '')
    writeState(config, { latest: '2.0.0' })
    const result = settleStart(install, config, NOW)
    assert.deepEqual(result, { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() })
    assert.equal(existsSync(join(install, PENDING_FILE)), false)
    assert.equal(existsSync(join(install, TRIED_FILE)), false)
    assert.deepEqual(readState(config), { latest: '2.0.0', lastResult: result }, 'recorded beside what was already there')
    assert.equal(settleStart(install, config, NOW), null, 'nothing left to settle')
    assert.deepEqual(readState(config).lastResult, result, 'a later start keeps the last result')
  } finally {
    removeDir(install)
    removeDir(config)
  }
})

test('a restored version settles the rolled-back marker as a failure that names both versions', () => {
  const install = temp()
  const config = temp()
  try {
    writeFileSync(join(install, ROLLED_BACK_FILE), JSON.stringify({ from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' }))
    const result = settleStart(install, config, NOW)
    assert.equal(result.ok, false)
    assert.deepEqual([result.from, result.to, result.at], ['1.0.0', '2.0.0', NOW.toISOString()])
    assert.match(result.error, /2\.0\.0 did not start.*1\.0\.0/)
    assert.equal(existsSync(join(install, ROLLED_BACK_FILE)), false)
    assert.deepEqual(readState(config).lastResult, result)
    assert.equal(settleStart(install, config, NOW), null, 'reported once')

    // A pending marker beside a rolled-back one is never a success: this is the restored version.
    writeFileSync(join(install, ROLLED_BACK_FILE), JSON.stringify({ from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' }))
    writePending(install, { from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' })
    assert.equal(settleStart(install, config, NOW).ok, false)
    assert.equal(settleStart(install, config, NOW), null, 'and the pending marker does not settle as a success on the next start')
    assert.equal(readState(config).lastResult.ok, false)
  } finally {
    removeDir(install)
    removeDir(config)
  }
})

test('unreadable markers are removed and settle nothing', () => {
  const install = temp()
  const config = temp()
  try {
    writeFileSync(join(install, PENDING_FILE), 'garbage')
    writeFileSync(join(install, ROLLED_BACK_FILE), '[]')
    assert.equal(settleStart(install, config, NOW), null)
    assert.equal(existsSync(join(install, PENDING_FILE)), false)
    assert.equal(existsSync(join(install, ROLLED_BACK_FILE)), false)
    writeFileSync(join(install, PENDING_FILE), JSON.stringify({ from: '1.0.0', to: 2 }))
    writeFileSync(join(install, TRIED_FILE), '')
    assert.equal(settleStart(install, config, NOW), null, 'a marker with a missing or mistyped field')
    assert.deepEqual(readdirSync(install), [], 'and the tried marker goes with it')
    assert.deepEqual(readState(config), {}, 'nothing was recorded')
    assert.equal(existsSync(join(config, STATE_FILE)), false)
    assert.equal(settleStart(join(install, 'missing'), join(config, 'missing'), NOW), null, 'folders that do not exist')
    assert.equal(JSON.parse(readFileSync(join(writePendingInto(install), PENDING_FILE), 'utf8')).to, '3.0.0')
  } finally {
    removeDir(install)
    removeDir(config)
  }
})

test('a state file that cannot be written does not throw: the server still starts, and says why', (t) => {
  const install = temp()
  try {
    const warn = t.mock.method(console, 'warn', () => {})
    // A config folder whose path runs through a regular file cannot be made or written, on any platform.
    writeFileSync(join(install, 'a-file'), '')
    const config = join(install, 'a-file', 'config')
    writePending(install, { from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' })
    let result
    assert.doesNotThrow(() => { result = settleStart(install, config, NOW) })
    assert.deepEqual(result, { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() })
    assert.equal(existsSync(join(install, PENDING_FILE)), false, 'the marker is still settled')
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[0]), /could not settle/)
  } finally {
    removeDir(install)
  }
})

function writePendingInto(dir) {
  writePending(dir, { from: '2.0.0', to: '3.0.0', at: NOW.toISOString() })
  return dir
}
