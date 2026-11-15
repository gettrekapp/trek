// scripts/themeChoice.test.mjs — a project window's theme (theme plugins phase 2): the themes its
// server lists, how the app's stored choice stands against them, and what Settings says about it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { installedThemes, themeKey, themeNote, themeState } from '../src/renderer/src/plugins/theme.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const nord = { id: 'nord', version: '1.0.0', defaultEnabled: false, type: 'theme', name: 'Nord', description: 'Cold.', contract: 1, sha256: SHA_A }
const voice = { id: 'voice', version: '1.0.0', defaultEnabled: true }

test('themeKey joins the server entry and the project', () => {
  assert.equal(themeKey('local', 'p1'), 'local:p1')
})

test('installedThemes: only entries that are themes with a hash; names fall back to the id and are clamped', () => {
  assert.deepEqual(installedThemes(undefined), [])
  assert.deepEqual(installedThemes([voice, nord, { ...nord, id: 'nohash', sha256: undefined }, { ...voice, id: 'feature', sha256: SHA_B }]), [
    { id: 'nord', version: '1.0.0', name: 'Nord', description: 'Cold.', sha256: SHA_A, contract: 1 }
  ])
  const [bare] = installedThemes([{ id: 'bare', version: '1.0.0', defaultEnabled: false, type: 'theme', sha256: SHA_B }])
  assert.deepEqual(bare, { id: 'bare', version: '1.0.0', name: 'bare', description: '', sha256: SHA_B, contract: undefined })
  const [long] = installedThemes([{ ...nord, name: 'n'.repeat(200), description: 'd'.repeat(900) }])
  assert.equal(long.name.length, 64)
  assert.equal(long.name.endsWith('…'), true)
  assert.equal(long.description.length, 300)
  assert.equal(installedThemes([{ ...nord, name: '   ' }])[0].name, 'nord')
})

test('themeState: none, ready, changed, missing', () => {
  assert.deepEqual(themeState(undefined, [nord]), { kind: 'none' })
  assert.equal(themeState({ id: 'nord', sha256: SHA_A }, [voice, nord]).kind, 'ready')
  assert.equal(themeState({ id: 'nord', sha256: SHA_A }, [voice, nord]).theme.sha256, SHA_A)
  const changed = themeState({ id: 'nord', sha256: SHA_B }, [nord])
  assert.equal(changed.kind, 'changed')
  assert.equal(changed.theme.sha256, SHA_A, 'the theme as the server has it now')
  assert.deepEqual(themeState({ id: 'nord', sha256: SHA_A }, [voice]), { kind: 'missing', id: 'nord' })
  assert.deepEqual(themeState({ id: 'nord', sha256: SHA_A }, undefined), { kind: 'missing', id: 'nord' })
  // A feature plugin of that id is not the theme.
  assert.deepEqual(themeState({ id: 'voice', sha256: SHA_A }, [voice]), { kind: 'missing', id: 'voice' })
})

test('themeNote: what the Theme row says', () => {
  const ready = themeState({ id: 'nord', sha256: SHA_A }, [nord])
  assert.deepEqual(themeNote({ kind: 'none' }, { kind: 'idle' }), { text: "Restyles this project's window in this app only." })
  assert.deepEqual(themeNote(ready, { kind: 'applied' }), { text: 'Cold.' })
  assert.deepEqual(themeNote(ready, { kind: 'loading' }), { text: 'Cold.' })
  assert.deepEqual(themeNote(ready, { kind: 'stale' }), { text: 'This theme is changing on the server. The window shows the default look for now.' })
  assert.deepEqual(themeNote(ready, { kind: 'failed', reason: 'the bundle does not match its hash' }), {
    text: 'Could not load this theme: the bundle does not match its hash. The window shows the default look.',
    problem: true
  })
  assert.deepEqual(themeNote(themeState({ id: 'nord', sha256: SHA_B }, [nord]), { kind: 'idle' }), {
    text: 'This theme was updated on the server. The window shows the default look until you apply the new version.',
    apply: true
  })
  assert.deepEqual(themeNote({ kind: 'missing', id: 'nord' }, { kind: 'idle' }), { text: 'Not installed on this server. The window shows the default look.', problem: true })
  const noDescription = themeState({ id: 'bare', sha256: SHA_B }, [{ id: 'bare', version: '1.0.0', defaultEnabled: false, type: 'theme', sha256: SHA_B }])
  assert.deepEqual(themeNote(noDescription, { kind: 'applied' }), { text: "Restyles this project's window in this app only." })
})
