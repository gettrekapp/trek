// scripts/jsonFile.test.mjs — a JSON store in userData (migrated.json): read, or a corrupt one set aside.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonStore } from '../src/main/jsonFile.ts'
import { parseMigrated } from '../src/main/importRules.ts'
import { removeDir } from './testPlatform.mjs'

const isObject = (raw) => !!raw && typeof raw === 'object' && !Array.isArray(raw)

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'trek-json-store-'))
  t.after(() => removeDir(d))
  return d
}

function quiet(t) {
  const warned = []
  const warn = console.warn
  console.warn = (...args) => warned.push(args.map(String).join(' '))
  t.after(() => (console.warn = warn))
  return warned
}

test('readJsonStore: a missing file is undefined, with no warning', async (t) => {
  const warned = quiet(t)
  assert.equal(await readJsonStore(join(dir(t), 'migrated.json'), isObject), undefined)
  assert.deepEqual(warned, [])
})

test('readJsonStore: a good file is its JSON, left in place', async (t) => {
  const path = join(dir(t), 'migrated.json')
  writeFileSync(path, JSON.stringify({ prompted: true, files: {} }))
  assert.deepEqual(await readJsonStore(path, isObject), { prompted: true, files: {} })
  assert.equal(existsSync(path), true)
})

test('readJsonStore: a file that does not parse is moved aside as .corrupt-<time>, with a warning', async (t) => {
  const warned = quiet(t)
  const d = dir(t)
  const path = join(d, 'migrated.json')
  writeFileSync(path, '{"prompted": true, "files": {')
  assert.equal(await readJsonStore(path, isObject, () => 1234), undefined)
  assert.equal(existsSync(path), false, 'the next write starts afresh')
  assert.deepEqual(readdirSync(d), ['migrated.json.corrupt-1234'])
  assert.equal(readFileSync(join(d, 'migrated.json.corrupt-1234'), 'utf8'), '{"prompted": true, "files": {', 'kept byte for byte')
  assert.equal(warned.length, 1)
  assert.match(warned[0], /migrated\.json could not be read .*moved it to .*migrated\.json\.corrupt-1234/)
  // As readMigrated reads it: nothing imported yet.
  assert.deepEqual(parseMigrated(null), { prompted: false, files: {} })
})

test('readJsonStore: JSON that `valid` refuses (a list, a string) is set aside too', async (t) => {
  quiet(t)
  const d = dir(t)
  const path = join(d, 'migrated.json')
  writeFileSync(path, '[1, 2]')
  assert.equal(await readJsonStore(path, isObject, () => 5), undefined)
  assert.deepEqual(readdirSync(d), ['migrated.json.corrupt-5'])
})
