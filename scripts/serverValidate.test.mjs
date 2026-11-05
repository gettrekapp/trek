// scripts/serverValidate.test.mjs — shared input checks and compare-and-set guards.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkExpected,
  optionalName,
  optionalString,
  optionalStringArray,
  requireAbsolutePath,
  requireBranch,
  requireName,
  requireRecord,
  requireString
} from '../server/src/validate.ts'

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('strings and names', () => {
  assert.equal(requireString('x', 'f'), 'x')
  assert.equal(code(() => requireString('', 'f')), 'BAD_REQUEST')
  assert.equal(code(() => requireString(3, 'f')), 'BAD_REQUEST')
  assert.equal(optionalString(undefined, 'f'), undefined)
  assert.equal(code(() => optionalString(3, 'f')), 'BAD_REQUEST')
  assert.equal(requireName('  Proj ', 'name'), 'Proj')
  assert.equal(code(() => requireName('   ', 'name')), 'BAD_REQUEST')
  assert.equal(optionalName(undefined, 'n'), undefined)
  assert.equal(optionalName(' A ', 'n'), 'A')
  assert.equal(code(() => optionalName(' ', 'n')), 'BAD_REQUEST')
})

test('string arrays, records, absolute paths', () => {
  assert.deepEqual(optionalStringArray(['a'], 'f'), ['a'])
  assert.equal(optionalStringArray(undefined, 'f'), undefined)
  assert.equal(code(() => optionalStringArray(['a', 1], 'f')), 'BAD_REQUEST')
  assert.deepEqual(requireRecord({ a: 1 }, 'f'), { a: 1 })
  assert.equal(code(() => requireRecord([], 'f')), 'BAD_REQUEST')
  assert.equal(requireAbsolutePath('/a/b', 'path'), '/a/b')
  assert.equal(code(() => requireAbsolutePath('a/b', 'path')), 'BAD_REQUEST')
})

test('branch names: any non-empty string except __proto__', () => {
  assert.equal(requireBranch('feature/x'), 'feature/x')
  assert.equal(requireBranch('constructor'), 'constructor')
  assert.equal(code(() => requireBranch('')), 'BAD_REQUEST')
  assert.equal(code(() => requireBranch('__proto__')), 'BAD_REQUEST')
})

test('checkExpected: absent passes; deep equality; null means absent', () => {
  assert.equal(code(() => checkExpected('name', 'a', undefined)), 'ok')
  assert.equal(code(() => checkExpected('name', 'a', 'a')), 'ok')
  assert.equal(code(() => checkExpected('name', 'a', 'b')), 'CONFLICT')
  assert.equal(code(() => checkExpected('note', undefined, null)), 'ok')
  assert.equal(code(() => checkExpected('note', 'x', null)), 'CONFLICT')
  assert.equal(code(() => checkExpected('dirs', ['a', 'b'], ['a', 'b'])), 'ok')
  assert.equal(code(() => checkExpected('dirs', ['a'], ['a', 'b'])), 'CONFLICT')
})
