// scripts/themeInstall.test.mjs — installing and removing a theme from the app (theme plugins
// phase 3): who may, the checks made before the server is asked, and the words shown.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PACKAGE_CHARS,
  MAX_PACKAGE_ESCAPED_BYTES,
  canInstallThemes,
  installFailure,
  installUrlProblem,
  installedNote,
  jsonEscapedBytes,
  packageFileProblem,
  packageTextProblem,
  removeConfirm
} from '../src/renderer/src/plugins/themeInstall.ts'

test('canInstallThemes: a server that lists plugins and holds pluginInstall', () => {
  assert.equal(canInstallThemes(undefined), false)
  assert.equal(canInstallThemes({ capabilities: ['pluginInstall'] }), false, 'a server older than plugins')
  assert.equal(canInstallThemes({ plugins: [], capabilities: [] }), false, 'plugins.remoteInstall is false there')
  assert.equal(canInstallThemes({ plugins: [], capabilities: ['voice', 'pluginInstall'] }), true)
  assert.equal(canInstallThemes({ plugins: [] }), false)
})

test('packageFileProblem: an empty file, and one too large to hold a package the server accepts, are refused unread', () => {
  assert.equal(MAX_PACKAGE_CHARS, 6_308_864)
  assert.equal(packageFileProblem({ size: 1 }), null)
  assert.equal(packageFileProblem({ size: MAX_PACKAGE_CHARS }), null)
  // The server counts characters, and a character is at most three bytes of a file.
  assert.equal(packageFileProblem({ size: MAX_PACKAGE_CHARS + 1 }), null, 'a multi-byte package may be under the character limit')
  assert.equal(packageFileProblem({ size: 3 * MAX_PACKAGE_CHARS }), null)
  assert.equal(packageFileProblem({ size: 0 }), 'That file is empty.')
  assert.equal(packageFileProblem({ size: 3 * MAX_PACKAGE_CHARS + 1 }), 'That file is larger than a plugin package may be (6 MB).')
})

test('jsonEscapedBytes: the UTF-8 size of the text as a JSON string, without its quotes', () => {
  const odd = 'plain "quoted" back\\slash \b\f\n\r\t \0\x01\x1f \x7f é ℵ 😀 \ud83d \ude00 \ud83d'
  for (const text of ['', 'abc', odd, JSON.stringify({ manifest: { id: 'nord' }, client: `export default "${odd}"\n` })]) {
    assert.equal(jsonEscapedBytes(text), Buffer.byteLength(JSON.stringify(text)) - 2, JSON.stringify(text))
  }
  // Past `stopAbove` the count stops: more than it, not the whole size.
  const counted = jsonEscapedBytes('\0'.repeat(1000), 60)
  assert.ok(counted > 60 && counted < 6000, String(counted))
})

test("packageTextProblem: text over the server's character limit, or that would overflow the socket's frame as a JSON string, is refused", () => {
  const pkg = JSON.stringify({ manifest: { id: 'nord', version: '1.0.0', name: 'Nord', description: 'Cold.', type: 'theme', contract: 1 }, client: 'export default { manifest: { id: "nord" } }\n' })
  assert.equal(packageTextProblem(pkg), null)
  assert.equal(packageTextProblem('é'.repeat(1000)), null)
  // Under the server's frame (16 MB) with room to spare, and over what any package the server accepts escapes to.
  assert.equal(MAX_PACKAGE_ESCAPED_BYTES, 2 * MAX_PACKAGE_CHARS)
  assert.ok(MAX_PACKAGE_ESCAPED_BYTES < 16 * 1024 * 1024 - 1024 * 1024)
  // The largest client the server accepts, all of it \uXXXX escapes, is a package of ordinary size once escaped again.
  assert.equal(packageTextProblem(JSON.stringify({ manifest: {}, client: '\0'.repeat(1024 * 1024) })), null)
  // Every character of a package may double (quotes, backslashes, line ends) and still be sent.
  assert.equal(packageTextProblem('\n'.repeat(MAX_PACKAGE_CHARS)), null)
  assert.equal(packageTextProblem('a'.repeat(MAX_PACKAGE_CHARS)), null)
  assert.equal(packageTextProblem('a'.repeat(MAX_PACKAGE_CHARS + 1)), 'That file is larger than a plugin package may be (6 MB).')
  // 2.7 MB of NUL bytes: under the character limit, over 16 MB as a JSON string.
  const nuls = '\0'.repeat(Math.ceil(2.7 * 1024 * 1024))
  assert.ok(Buffer.byteLength(JSON.stringify(nuls)) > 16 * 1024 * 1024)
  assert.equal(packageTextProblem(nuls), 'That file is not a plugin package.')
  assert.equal(packageTextProblem('\0'.repeat(Math.floor(MAX_PACKAGE_ESCAPED_BYTES / 6))), null)
  assert.equal(packageTextProblem('\0'.repeat(Math.floor(MAX_PACKAGE_ESCAPED_BYTES / 6) + 1)), 'That file is not a plugin package.')
  // Characters of three bytes each, under the character limit.
  assert.equal(packageTextProblem('ℵ'.repeat(MAX_PACKAGE_CHARS)), 'That file is not a plugin package.')
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
