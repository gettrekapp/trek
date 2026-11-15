// scripts/projectPage.test.mjs — which project-level page (Settings, Automations, All Notes) a click leaves open.
import test from 'node:test'
import assert from 'node:assert/strict'
import { nextProjectPage } from '../src/renderer/src/projectPage.ts'

test('nextProjectPage: a click opens the page, a second click closes it, the other page replaces it', () => {
  assert.equal(nextProjectPage(null, 'settings'), 'settings')
  assert.equal(nextProjectPage(null, 'automations'), 'automations')
  assert.equal(nextProjectPage('settings', 'settings'), null)
  assert.equal(nextProjectPage('automations', 'automations'), null)
  assert.equal(nextProjectPage('settings', 'automations'), 'automations')
  assert.equal(nextProjectPage('automations', 'settings'), 'settings')
  assert.equal(nextProjectPage(null, 'notes'), 'notes')
  assert.equal(nextProjectPage('notes', 'notes'), null)
  assert.equal(nextProjectPage('notes', 'settings'), 'settings')
})
