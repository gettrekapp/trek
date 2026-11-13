// scripts/serverDataDir.test.mjs — where trek-server keeps projects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
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

test('without HOME or USERPROFILE the home directory comes from os.homedir()', () => {
  assert.equal(defaultDataDir('linux', {}), join(homedir(), '.local', 'share', 'trek-server'))
})

// --- The config dir: ~/.config/trek-server, %APPDATA%\trek-server on Windows ---
import { defaultConfigPath } from '../server/src/config.ts'
import { localProfile } from '../server/src/localProfile.ts'
import { serverConfigDir } from '../src/shared/localServer.ts'
import { join as joinPath, win32 as winPath } from 'node:path'

test('config dir: ~/.config/trek-server on macOS and Linux, %APPDATA%\\trek-server on Windows', () => {
  assert.equal(defaultConfigPath('linux', {}, '/home/u'), '/home/u/.config/trek-server/config.json')
  assert.equal(defaultConfigPath('darwin', {}, '/Users/u'), '/Users/u/.config/trek-server/config.json')
  assert.equal(serverConfigDir(winPath.join, 'win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\trek-server')
  assert.equal(serverConfigDir(winPath.join, 'win32', {}, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\trek-server', 'no APPDATA: the default under the profile')
})

test('the local profile lives in the config dir, its projects in the data dir', () => {
  const p = localProfile('/home/u', '/data', 'dev', 'linux', {})
  assert.equal(p.dir, joinPath('/home/u', '.config', 'trek-server', 'local-dev'))
  assert.equal(p.dataDir, joinPath('/data', 'local-dev'))
  const w = localProfile('/home/u', '/data', undefined, 'win32', { APPDATA: '/appdata' })
  assert.equal(w.dir, joinPath('/appdata', 'trek-server', 'local'))
})
