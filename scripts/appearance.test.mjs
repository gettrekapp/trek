// scripts/appearance.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProjectName, sanitizeAppearance, titleBarForeground } from '../src/shared/appearance.ts'

const PNG = 'data:image/png;base64,AAAA'

test('valid appearance values and other fields are kept', () => {
  const project = { name: 'p', titleBarColor: '#1E3a8a', logoImage: PNG, bannerImage: PNG }
  assert.deepEqual(sanitizeAppearance(project), project)
})

test('a project without appearance values is unchanged', () => {
  assert.deepEqual(sanitizeAppearance({ name: 'p' }), { name: 'p' })
})

test('colors that are not #rrggbb are removed', () => {
  for (const titleBarColor of ['red', '#fff', '#12345g', '#1234567', 'x#123456', 'url(x)', 5]) {
    assert.deepEqual(sanitizeAppearance({ name: 'p', titleBarColor }), { name: 'p' })
  }
})

test('images that are not embedded data:image/ URLs are removed', () => {
  const bad = [
    'https://example.com/a.png',
    'https://example.com/data:image/a.png',
    'file:///a.png',
    'data:text/html,x',
    '',
    5
  ]
  for (const value of bad) {
    assert.deepEqual(sanitizeAppearance({ name: 'p', logoImage: value }), { name: 'p' })
    assert.deepEqual(sanitizeAppearance({ name: 'p', bannerImage: value }), { name: 'p' })
  }
})

test('sanitizing does not change the input', () => {
  const project = { name: 'p', titleBarColor: 'red' }
  sanitizeAppearance(project)
  assert.equal(project.titleBarColor, 'red')
})

test('dark colors get light text', () => {
  for (const color of ['#000000', '#161618', '#1e3a8a']) {
    assert.equal(titleBarForeground(color), 'light')
  }
})

test('light colors get dark text', () => {
  for (const color of ['#ffffff', '#ffeb3b', '#a7f3d0', '#e53935', '#767676']) {
    assert.equal(titleBarForeground(color), 'dark')
  }
})

test('a project name is trimmed', () => {
  assert.equal(resolveProjectName('  New name  ', 'old'), 'New name')
})

test('a blank project name keeps the current one', () => {
  for (const input of ['', '   ', '\t\n']) {
    assert.equal(resolveProjectName(input, 'old'), 'old')
  }
})
