// scripts/themeInstall.test.mjs — installing and removing a theme from the app (theme plugins
// phase 3): who may, the checks made before the server is asked, and the words shown.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PACKAGE_CHARS, canInstallThemes, installFailure, installUrlProblem, installedNote, packageFileProblem, removeConfirm } from '../src/renderer/src/plugins/themeInstall.ts'

test('canInstallThemes: a server that lists plugins and holds pluginInstall', () => {
  assert.equal(canInstallThemes(undefined), false)
  assert.equal(canInstallThemes({ capabilities: ['pluginInstall'] }), false, 'a server older than plugins')
  assert.equal(canInstallThemes({ plugins: [], capabilities: [] }), false, 'plugins.remoteInstall is false there')
  assert.equal(canInstallThemes({ plugins: [], capabilities: ['voice', 'pluginInstall'] }), true)
  assert.equal(canInstallThemes({ plugins: [] }), false)
})

test("packageFileProblem: an empty file and one over the server's package limit are refused unread", () => {
  assert.equal(MAX_PACKAGE_CHARS, 6_308_864)
  assert.equal(packageFileProblem({ size: 1 }), null)
  assert.equal(packageFileProblem({ size: MAX_PACKAGE_CHARS }), null)
  assert.equal(packageFileProblem({ size: 0 }), 'That file is empty.')
  assert.equal(packageFileProblem({ size: MAX_PACKAGE_CHARS + 1 }), 'That file is larger than a plugin package may be (6 MB).')
})

test('installUrlProblem: an https URL with no credentials, at most 2,048 characters', () => {
  assert.equal(installUrlProblem('https://themes.test/nord.trekplugin'), null)
  assert.equal(installUrlProblem('  https://themes.test/nord.trekplugin?x=1  '), null, 'spaces around it are not part of it')
  assert.equal(installUrlProblem(''), "Enter the https URL of a theme's .trekplugin file.")
  assert.equal(installUrlProblem('   '), "Enter the https URL of a theme's .trekplugin file.")
  assert.equal(installUrlProblem('nord.trekplugin'), 'That is not a URL.')
  assert.equal(installUrlProblem('http://themes.test/nord.trekplugin'), 'The URL must start with https://.')
  assert.equal(installUrlProblem('file:///tmp/nord.trekplugin'), 'The URL must start with https://.')
  assert.equal(installUrlProblem('https://user:secret@themes.test/nord.trekplugin'), 'The URL must not carry a user name or password.')
  assert.equal(installUrlProblem('https://user@themes.test/nord.trekplugin'), 'The URL must not carry a user name or password.')
  assert.equal(installUrlProblem(`https://themes.test/${'a'.repeat(2048)}`), 'The URL is longer than 2,048 characters.')
})

test("installedNote: the installed theme by the server's answer, clamped; a bare word when the answer is not an entry", () => {
  const entry = { id: 'nord', version: '1.2.0', defaultEnabled: false, type: 'theme', name: 'Nord', description: 'Cold.', contract: 1, sha256: 'a'.repeat(64) }
  assert.equal(installedNote(entry), 'Installed Nord 1.2.0.')
  assert.equal(installedNote({ ...entry, name: undefined }), 'Installed nord 1.2.0.')
  assert.equal(installedNote({ ...entry, name: 'n'.repeat(200) }), `Installed ${'n'.repeat(63)}… 1.2.0.`)
  assert.equal(installedNote(null), 'Installed.')
  assert.equal(installedNote({ id: 'Bad Id', version: '1' }), 'Installed.')
})

test("installFailure: the server's reason, clamped; a dropped link in the app's own words", () => {
  assert.equal(installFailure(Object.assign(new Error('Not an installable plugin: type must be "theme"'), { code: 'BAD_REQUEST' })), 'Not an installable plugin: type must be "theme"')
  assert.equal(installFailure(Object.assign(new Error('not connected to the server'), { code: 'NOT_CONNECTED' })), 'Not connected to the server. Try again when the link is back.')
  assert.equal(installFailure(new Error('x'.repeat(900))).length, 300)
  assert.equal(installFailure(new Error('x'.repeat(900))).endsWith('…'), true)
  assert.equal(installFailure('boom'), 'boom')
  assert.equal(installFailure(new Error('')), 'The server refused, without saying why.')
})

test('removeConfirm: names the theme, says who loses it, and Cancel is the default', () => {
  assert.deepEqual(removeConfirm({ id: 'nord', version: '1.0.0', name: 'Nord', description: '', sha256: 'a'.repeat(64), contract: 1 }), {
    title: 'Remove theme',
    message: 'Remove "Nord" from this server?',
    detail: 'It is removed for every client of this server. Windows that use it return to the default look.',
    confirmLabel: 'Remove',
    defaultCancel: true
  })
})
