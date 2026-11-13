// scripts/quickButtonTemplate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTINS,
  parseTemplate,
  templateInputs,
  templateBuiltins
} from '../src/shared/quickButtonTemplate.ts'

test('plain text is one text segment', () => {
  assert.deepEqual(parseTemplate('just text'), [{ kind: 'text', text: 'just text' }])
  assert.deepEqual(parseTemplate(''), [])
})

test('inputs and known built-ins become tokens', () => {
  assert.deepEqual(parseTemplate('Review {AREA} on [branch].'), [
    { kind: 'text', text: 'Review ' },
    { kind: 'input', name: 'AREA', raw: '{AREA}' },
    { kind: 'text', text: ' on ' },
    { kind: 'builtin', name: 'branch', raw: '[branch]' },
    { kind: 'text', text: '.' }
  ])
})

test('built-in names match case-insensitively and normalise to lower case', () => {
  assert.deepEqual(parseTemplate('[Branch]'), [{ kind: 'builtin', name: 'branch', raw: '[Branch]' }])
})

test('unknown brackets, markdown links and invalid braces stay literal', () => {
  assert.deepEqual(parseTemplate('[x] [text](url) [branch](url) {a b} {}'), [
    { kind: 'text', text: '[x] [text](url) [branch](url) {a b} {}' }
  ])
})

test('input names are case-sensitive and may hold digits and underscores', () => {
  assert.deepEqual(templateInputs('{a} {A} {area_2} {a}'), ['a', 'A', 'area_2'])
})

test('templateBuiltins lists each built-in once, in order', () => {
  assert.deepEqual(templateBuiltins('[pr_url] [branch] [PR_URL]'), ['pr_url', 'branch'])
})

test('every built-in has a group and a description', () => {
  for (const b of BUILTINS) {
    assert.match(b.name, /^[a-z_]+$/)
    assert.ok(b.description.length > 0, b.name)
    assert.ok(['Worktree', 'Repo & project', 'Branch', 'Session', 'Time'].includes(b.group), b.name)
  }
})
