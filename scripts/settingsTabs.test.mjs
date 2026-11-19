// scripts/settingsTabs.test.mjs — which Settings tabs show, the one shown when the chosen one is gone, and where a key moves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_TABS, nextSettingsTab, resolveSettingsTab, visibleSettingsTabs } from '../src/renderer/src/settingsTabs.ts'

const ids = (tabs) => tabs.map((t) => t.id)

test('the tabs, in order, with their labels', () => {
  assert.deepEqual(SETTINGS_TABS, [
    { id: 'general', label: 'General' },
    { id: 'agents', label: 'Agents' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'worktrees', label: 'Worktrees' },
    { id: 'plugins', label: 'Plugins' }
  ])
})

test('visibleSettingsTabs: Plugins shows only where there is one to list', () => {
  assert.deepEqual(ids(visibleSettingsTabs({ plugins: true })), ['general', 'agents', 'sessions', 'worktrees', 'plugins'])
  assert.deepEqual(ids(visibleSettingsTabs({ plugins: false })), ['general', 'agents', 'sessions', 'worktrees'])
})

test('resolveSettingsTab: the chosen tab while it shows, General once it is gone', () => {
  const some = visibleSettingsTabs({ plugins: true })
  assert.equal(resolveSettingsTab('plugins', some), 'plugins')
  assert.equal(resolveSettingsTab('plugin:env', some), 'general')
})

test('nextSettingsTab: arrows step and stop at the ends, Home and End jump, other keys do nothing', () => {
  const some = visibleSettingsTabs({ plugins: true })
  assert.equal(nextSettingsTab(some, 'agents', 'ArrowRight'), 'sessions')
  assert.equal(nextSettingsTab(some, 'agents', 'ArrowLeft'), 'general')
  assert.equal(nextSettingsTab(some, 'worktrees', 'ArrowRight'), 'plugins')
  assert.equal(nextSettingsTab(some, 'general', 'ArrowLeft'), null)
  assert.equal(nextSettingsTab(some, 'plugins', 'ArrowRight'), null)
  assert.equal(nextSettingsTab(some, 'sessions', 'Home'), 'general')
  assert.equal(nextSettingsTab(some, 'sessions', 'End'), 'plugins')
  assert.equal(nextSettingsTab(some, 'general', 'Home'), null)
  assert.equal(nextSettingsTab(some, 'sessions', 'Enter'), null)
})

test("visibleSettingsTabs (plugins E3): a plugin's repository settings tab comes right before Plugins", () => {
  const pluginTabs = [{ id: 'plugin:env', label: 'Environments' }]
  assert.deepEqual(ids(visibleSettingsTabs({ plugins: true, pluginTabs })), ['general', 'agents', 'sessions', 'worktrees', 'plugin:env', 'plugins'])
  assert.deepEqual(ids(visibleSettingsTabs({ plugins: false, pluginTabs })), ['general', 'agents', 'sessions', 'worktrees', 'plugin:env'])
  assert.equal(resolveSettingsTab('plugin:env', visibleSettingsTabs({ plugins: true })), 'general', 'gone once the plugin is off')
})
