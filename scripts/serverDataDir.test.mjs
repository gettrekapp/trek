// scripts/serverDataDir.test.mjs — where trek-server keeps projects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { defaultDataDir, projectsDir } from '../server/src/dataDir.ts'

test('platform defaults', () => {
  assert.equal(defaultDataDir('linux', { HOME: '/h' }, '/h'), '/h/.local/share/trek-server')
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/x' }, '/h'), '/x/trek-server')
  assert.equal(defaultDataDir('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/trek-server')
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U'), join('C:\\L', 'trek-server'))
})

test('projects live in a projects/ subdirectory', () => {
  assert.equal(projectsDir('/d'), join('/d', 'projects'))
})
