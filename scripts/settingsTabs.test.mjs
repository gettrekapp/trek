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
    { id: 'environments', label: 'Environments' },
    { id: 'plugins', label: 'Plugins' }
  ])
})

test('visibleSettingsTabs: Environments and Plugins show only where there is something in them', () => {
  assert.deepEqual(ids(visibleSettingsTabs({ environments: true, plugins: true })), ['general', 'agents', 'sessions', 'worktrees', 'environments', 'plugins'])
  assert.deepEqual(ids(visibleSettingsTabs({ environments: false, plugins: true })), ['general', 'agents', 'sessions', 'worktrees', 'plugins'])
  assert.deepEqual(ids(visibleSettingsTabs({ environments: true, plugins: false })), ['general', 'agents', 'sessions', 'worktrees', 'environments'])
  assert.deepEqual(ids(visibleSettingsTabs({ environments: false, plugins: false })), ['general', 'agents', 'sessions', 'worktrees'])
})

test('resolveSettingsTab: the chosen tab while it shows, General once it is gone', () => {
  const some = visibleSettingsTabs({ environments: false, plugins: true })
  assert.equal(resolveSettingsTab('plugins', some), 'plugins')
  assert.equal(resolveSettingsTab('environments', some), 'general')
})

test('nextSettingsTab: arrows step and stop at the ends, Home and End jump, other keys do nothing', () => {
  const some = visibleSettingsTabs({ environments: false, plugins: true })
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
