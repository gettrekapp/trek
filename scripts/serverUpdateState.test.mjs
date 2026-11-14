// scripts/serverUpdateState.test.mjs — an update's memory: the markers in the install folder that
// carry it across a restart, and update-state.json's record of how the last one went.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RESULT_ERROR_CHARS, PENDING_FILE, ROLLED_BACK_FILE, STATE_FILE, TRIED_FILE, capError, clearTried, readState, settleStart, writePending, writeState } from '../server/src/update/state.ts'
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

test('settling forgets a "latest" that is not newer than the version now running', () => {
  const install = temp()
  const config = temp()
  try {
    // The update to 2.0.0 was found, installed, and has started.
    writeState(config, { lastCheckAt: '2026-11-14T09:00:00.000Z', latest: '2.0.0' })
    writePending(install, { from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' })
    const result = settleStart(install, config, NOW, '2.0.0')
    assert.deepEqual(readState(config), { lastCheckAt: '2026-11-14T09:00:00.000Z', lastResult: result }, 'it no longer says 2.0.0 is available')

    // With nothing to settle too (installed by hand), and for a version beyond it.
    writeState(config, { latest: '2.0.0' })
    assert.equal(settleStart(install, config, NOW, '2.1.0'), null)
    assert.equal(readState(config).latest, undefined)

    // One that is still newer stays.
    writeState(config, { latest: '3.0.0' })
    settleStart(install, config, NOW, '2.0.0')
    assert.equal(readState(config).latest, '3.0.0')
    // A rollback: 2.0.0 is still newer than the 1.0.0 that runs again.
    writeState(config, { latest: '2.0.0' })
    writeFileSync(join(install, ROLLED_BACK_FILE), JSON.stringify({ from: '1.0.0', to: '2.0.0', at: '2026-11-14T09:59:00.000Z' }))
    assert.equal(settleStart(install, config, NOW, '1.0.0').ok, false)
    assert.equal(readState(config).latest, '2.0.0')

    // No state file is made for it.
    const fresh = temp()
    try {
      assert.equal(settleStart(install, fresh, NOW, '2.0.0'), null)
      assert.deepEqual(readdirSync(fresh), [])
    } finally {
      removeDir(fresh)
    }
  } finally {
    removeDir(install)
    removeDir(config)
  }
})

test('clearTried removes the tried mark of this very start, and only that', () => {
  const install = temp()
  try {
    const mark = join(install, TRIED_FILE)
    writePending(install, { from: '1.0.0', to: '2.0.0', at: NOW.toISOString() })
    // As the launcher writes it: its process id (which exec hands to the server) and a newline.
    writeFileSync(mark, `${process.pid}\n`)
    clearTried(install)
    assert.equal(existsSync(mark), false)
    assert.equal(existsSync(join(install, PENDING_FILE)), true, 'the update is still pending: its next start is a first start')

    // Another start's mark (two starts at once; a command that is not the start) stays.
    for (const other of [`${process.pid + 1}\n`, '', 'garbage', `${process.pid} 7`]) {
      writeFileSync(mark, other)
      clearTried(install)
      assert.equal(readFileSync(mark, 'utf8'), other, JSON.stringify(other))
    }
    writeFileSync(mark, '4242\n')
    clearTried(install, 4242)
    assert.equal(existsSync(mark), false, 'the process id is the one given')
  } finally {
    removeDir(install)
  }
})

test('clearTried never throws: no install (a source run), no folder, no mark, a mark that is a folder', () => {
  const install = temp()
  try {
    assert.doesNotThrow(() => clearTried(''))
    assert.doesNotThrow(() => clearTried(install))
    assert.doesNotThrow(() => clearTried(join(install, 'missing')))
    mkdirSync(join(install, TRIED_FILE))
    assert.doesNotThrow(() => clearTried(install))
    assert.deepEqual(readdirSync(install), [TRIED_FILE])
  } finally {
    removeDir(install)
  }
})

function writePendingInto(dir) {
  writePending(dir, { from: '2.0.0', to: '3.0.0', at: NOW.toISOString() })
  return dir
}

test('a recorded failure\'s error is cut to its first MAX_RESULT_ERROR_CHARS characters, and says so', () => {
  const dir = temp()
  try {
    assert.equal(MAX_RESULT_ERROR_CHARS, 2000)
    assert.equal(capError('short'), 'short')
    assert.equal(capError('x'.repeat(2000)), 'x'.repeat(2000), 'exactly the limit is whole')
    // A selfcheck can print up to about a megabyte before it fails.
    const long = `trek-server 2.0.0 does not run on this machine, so 1.0.0 stays:\n${'y'.repeat(1024 * 1024)}`
    const cut = capError(long)
    assert.ok(cut.startsWith(long.slice(0, 2000)))
    assert.ok(cut.length < 2100, String(cut.length))
    assert.match(cut, /\n… \(cut: the whole message is 1048640 characters\)$/)
    assert.equal(capError(cut), cut, 'cutting what is cut changes nothing')
    writeState(dir, { lastResult: { ok: false, from: '1.0.0', to: '2.0.0', at: NOW.toISOString(), error: long } })
    assert.equal(readState(dir).lastResult.error, cut)
    assert.ok(statSync(join(dir, STATE_FILE)).size < 4096)
    // A result with no error, and a success, are written as they are.
    writeState(dir, { lastResult: { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() } })
    assert.deepEqual(readState(dir).lastResult, { ok: true, from: '1.0.0', to: '2.0.0', at: NOW.toISOString() })
  } finally {
    removeDir(dir)
  }
})
