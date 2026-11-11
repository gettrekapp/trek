// scripts/appIpcRules.test.mjs — the checks on what a renderer sends the app's own IPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { absolutePath, checkboxConfirmOptions, confirmOptions, dialogIdOf, editorPath, errorDialogText, trekprojPath } from '../src/main/appIpcRules.ts'

test('absolutePath takes an absolute path string only', () => {
  assert.equal(absolutePath('/Users/me/repo'), '/Users/me/repo')
  for (const bad of ['repo', './repo', '', '-n', 5, null, undefined, {}, ['/a']]) assert.equal(absolutePath(bad), null, String(bad))
})

test('editorPath takes an absolute path, never an option', () => {
  assert.equal(editorPath('/Users/me/repo'), '/Users/me/repo')
  for (const bad of ['-n', '--goto', '-/x', 'repo', '', 7, null]) assert.equal(editorPath(bad), null, String(bad))
})

test('trekprojPath takes an absolute path ending in .trekproj', () => {
  assert.equal(trekprojPath('/a/b/Project.trekproj'), '/a/b/Project.trekproj')
  assert.equal(trekprojPath('/a/b/Project.TREKPROJ'), '/a/b/Project.TREKPROJ')
  for (const bad of ['Project.trekproj', '/a/b/Project.json', '/a/b/trekproj', '/a/b/Project.trekproj/', '', 3, null]) assert.equal(trekprojPath(bad), null, String(bad))
})

test('errorDialogText makes both arguments text', () => {
  assert.deepEqual(errorDialogText('Oops', 'it broke'), { title: 'Oops', message: 'it broke' })
  assert.deepEqual(errorDialogText(undefined, null), { title: '', message: '' })
  assert.deepEqual(errorDialogText(42, { toString: () => 'obj' }), { title: '42', message: 'obj' })
})

test('confirmOptions makes anything but text text, with the defaults', () => {
  assert.deepEqual(confirmOptions({ title: 'T', message: 'M', detail: 'D', confirmLabel: 'Delete', cancelLabel: 'Keep', defaultCancel: true }), {
    title: 'T', message: 'M', detail: 'D', confirmLabel: 'Delete', cancelLabel: 'Keep', defaultCancel: true
  })
  assert.deepEqual(confirmOptions({ title: 1, message: null, detail: 2, cancelLabel: '', defaultCancel: 'yes' }), {
    title: '1', message: '', detail: undefined, confirmLabel: 'OK', cancelLabel: 'Cancel', defaultCancel: false
  })
  assert.deepEqual(confirmOptions(null), { title: '', message: '', detail: undefined, confirmLabel: 'OK', cancelLabel: 'Cancel', defaultCancel: false })
})

test('checkboxConfirmOptions coerces as confirmOptions does; the box is ticked only by true', () => {
  assert.deepEqual(checkboxConfirmOptions({ title: 'T', message: 'M', confirmLabel: 'Go', checkboxLabel: 'Also', checkboxChecked: true }), {
    title: 'T', message: 'M', detail: undefined, confirmLabel: 'Go', checkboxLabel: 'Also', checkboxChecked: true
  })
  assert.deepEqual(checkboxConfirmOptions({ title: 5, detail: {}, checkboxLabel: 9, checkboxChecked: 1 }), {
    title: '5', message: '', detail: undefined, confirmLabel: 'OK', checkboxLabel: '9', checkboxChecked: false
  })
  assert.deepEqual(checkboxConfirmOptions('nope'), { title: '', message: '', detail: undefined, confirmLabel: 'OK', checkboxLabel: '', checkboxChecked: false })
})

test('dialogIdOf: a short string, from the options or alone; else none', () => {
  assert.equal(dialogIdOf({ dialogId: 'promote:r1' }), 'promote:r1')
  assert.equal(dialogIdOf('promote:r1'), 'promote:r1')
  for (const bad of [{}, { dialogId: 3 }, { dialogId: '' }, 'x'.repeat(201), null, undefined]) assert.equal(dialogIdOf(bad), undefined)
})
