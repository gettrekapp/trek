// scripts/pluginsTab.test.mjs — Settings → Plugins: the list's groups and rows, which row is selected, and the detail pane's words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginDetailNote, pluginGroups, pluginRowLine, pluginSwitchLabel, resolveSelection } from '../src/renderer/src/plugins/pluginsTab.ts'

const linear = { id: 'linear', name: 'Linear', status: 'on' }
const voice = { id: 'voice', name: 'Voice summaries', status: 'on' }
const azure = { id: 'azure-devops', name: 'Azure DevOps', status: 'off' }
const gone = { id: 'gone', name: 'Gone', status: 'missing' }

test('pluginRowLine: nothing for an on plugin, where it stands for the others', () => {
  assert.equal(pluginRowLine('on'), null)
  assert.equal(pluginRowLine('off'), 'Off in this project')
  assert.equal(pluginRowLine('missing'), 'Not available on this server')
  assert.equal(pluginRowLine('legacy'), 'Always on · update the server to switch it')
  assert.equal(pluginRowLine('unknown'), null)
})

test('pluginGroups: On, Off, Not available, in that order, each with its count; empty groups left out', () => {
  const groups = pluginGroups([azure, linear, gone, voice], 'Towbook', false)
  assert.deepEqual(groups.map((g) => [g.id, g.heading, g.rows.map((r) => r.id)]), [
    ['on', 'On in Towbook · 2', ['linear', 'voice']],
    ['off', 'Off · 1', ['azure-devops']],
    ['missing', 'Not available · 1', ['gone']]
  ])
  assert.deepEqual(pluginGroups([linear], 'Towbook', false).map((g) => g.id), ['on'])
  assert.deepEqual(pluginGroups([], 'Towbook', false), [])
})

test('pluginGroups: a project with no name yet is "this project"', () => {
  assert.equal(pluginGroups([linear], '', false)[0].heading, 'On in this project · 1')
})

test('pluginGroups: each row carries its line, its control and whether it is dimmed', () => {
  const rows = pluginGroups([linear, azure, gone], 'Towbook', false).flatMap((g) => g.rows)
  assert.deepEqual(rows, [
    { id: 'linear', name: 'Linear', status: 'on', line: null, control: 'switch', dim: false },
    { id: 'azure-devops', name: 'Azure DevOps', status: 'off', line: 'Off in this project', control: 'switch', dim: true },
    { id: 'gone', name: 'Gone', status: 'missing', line: 'Not available on this server', control: 'disabled', dim: true }
  ])
})

test('pluginGroups: a plugin whose status is unknown is not listed', () => {
  assert.deepEqual(pluginGroups([{ id: 'x', name: 'X', status: 'unknown' }, linear], 'Towbook', false).flatMap((g) => g.rows.map((r) => r.id)), ['linear'])
})

test('pluginGroups: a server older than plugins has one group, without switches, and lists only what it runs', () => {
  const old = [{ ...linear, status: 'legacy' }, { ...voice, status: 'missing' }]
  assert.deepEqual(pluginGroups(old, 'Towbook', true), [
    {
      id: 'legacy',
      heading: 'On this server · 1',
      rows: [{ id: 'linear', name: 'Linear', status: 'legacy', line: 'Always on · update the server to switch it', control: 'none', dim: false }]
    }
  ])
  assert.deepEqual(pluginGroups([{ ...voice, status: 'missing' }], 'Towbook', true), [])
})

test('resolveSelection: the chosen row while it is listed, else the first row, else nothing', () => {
  const groups = pluginGroups([azure, linear, voice], 'Towbook', false)
  assert.deepEqual(resolveSelection(groups, { kind: 'plugin', id: 'azure-devops' }), { kind: 'plugin', id: 'azure-devops' })
  assert.deepEqual(resolveSelection(groups, null), { kind: 'plugin', id: 'linear' }, 'the first row of the first group')
  assert.deepEqual(resolveSelection(groups, { kind: 'plugin', id: 'nope' }), { kind: 'plugin', id: 'linear' })
  assert.deepEqual(resolveSelection(groups, { kind: 'theme', id: 'linear' }), { kind: 'plugin', id: 'linear' }, 'a theme with a plugin\'s id is not that plugin')
  assert.equal(resolveSelection([], { kind: 'plugin', id: 'linear' }), null)
})

test('pluginDetailNote: what the detail says in place of a plugin\'s settings', () => {
  assert.equal(pluginDetailNote('on'), null)
  assert.equal(pluginDetailNote('legacy'), null)
  assert.equal(pluginDetailNote('off'), 'Turn it on to set it up for this project.')
  assert.equal(pluginDetailNote('missing'), 'Not available on this server: it may be older than this plugin (update it), or the plugin failed to start there (see its log).')
})

test('pluginSwitchLabel: the detail\'s switch names its scope', () => {
  assert.equal(pluginSwitchLabel('on', 'Towbook'), 'On for Towbook')
  assert.equal(pluginSwitchLabel('off', 'Towbook'), 'Off for Towbook')
  assert.equal(pluginSwitchLabel('on', ''), 'On for this project')
  assert.equal(pluginSwitchLabel('missing', 'Towbook'), 'Not available')
  assert.equal(pluginSwitchLabel('legacy', 'Towbook'), 'Always on')
})
