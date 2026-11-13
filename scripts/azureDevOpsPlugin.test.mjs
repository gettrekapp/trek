// scripts/azureDevOpsPlugin.test.mjs — the Azure DevOps plugin (plugin system phase 2): its ticket
// provider (work item numbers and `<base>/_workitems/edit/<n>` URLs) and its project setting
// (`azureDevOpsBaseUrl`) through the server's registry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { azureDevOpsTickets, baseUrlProblem } from '../plugins/azure-devops/shared/ticket.ts'
import { azureDevOpsServerPlugin } from '../plugins/azure-devops/server/index.ts'
import { azureDevOpsClientPlugin } from '../plugins/azure-devops/client/index.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { isCoreMethod } from '../server/src/v2.ts'
import { applySettingsPatch } from '../server/src/projects/settings.ts'
import { parseTicketWith, ticketView } from '../src/shared/tickets.ts'

test('owns: work item numbers only', () => {
  assert.equal(azureDevOpsTickets.owns('42'), true)
  for (const id of ['TOW-1', '4a', '', ' 4']) assert.equal(azureDevOpsTickets.owns(id), false, id)
})

test('parse: a number, a work item URL (implying its base), and odd bases refused', () => {
  assert.deepEqual(azureDevOpsTickets.parse('123'), { ticketId: '123' })
  assert.deepEqual(azureDevOpsTickets.parse('https://dev.azure.com/o/p/_workitems/edit/42'), { ticketId: '42', settings: { azureDevOpsBaseUrl: 'https://dev.azure.com/o/p' } })
  assert.deepEqual(azureDevOpsTickets.parse('http://tfs.local/DefaultCollection/p/_workitems/edit/5'), { ticketId: '5', settings: { azureDevOpsBaseUrl: 'http://tfs.local/DefaultCollection/p' } })
  assert.equal(azureDevOpsTickets.parse(`https://${'a'.repeat(200)}.com/_workitems/edit/5`), null)
  assert.equal(azureDevOpsTickets.parse('http://[bad/_workitems/edit/5'), null)
  assert.equal(azureDevOpsTickets.parse('TOW-1'), null)
  assert.equal(azureDevOpsTickets.parse('https://linear.app/a/issue/TOW-1'), null)
})

test('label and url: #n, linked from the base URL (trailing slashes dropped), none without it', () => {
  assert.equal(azureDevOpsTickets.label('7'), '#7')
  assert.equal(azureDevOpsTickets.url({ azureDevOpsBaseUrl: 'https://d/o/p/' }, '7'), 'https://d/o/p/_workitems/edit/7')
  assert.equal(azureDevOpsTickets.url({}, '7'), null)
  assert.equal(azureDevOpsTickets.url({ azureDevOpsBaseUrl: 5 }, '7'), null)
  assert.equal(azureDevOpsTickets.linkSetting.key, 'azureDevOpsBaseUrl')
  assert.deepEqual(ticketView([azureDevOpsTickets], { azureDevOpsBaseUrl: 'https://d/o/p' }, '7'), { label: '#7', url: 'https://d/o/p/_workitems/edit/7', providerId: 'azure-devops' })
  assert.deepEqual(parseTicketWith([azureDevOpsTickets], ' 9 '), { ticketId: '9', providerId: 'azure-devops' })
})

test('baseUrlProblem: an http(s) URL of at most 200 characters', () => {
  assert.equal(baseUrlProblem('https://dev.azure.com/o/p'), null)
  assert.match(baseUrlProblem('ftp://x'), /http\(s\)/)
  assert.match(baseUrlProblem('not a url'), /http\(s\)/)
  assert.match(baseUrlProblem(`https://${'a'.repeat(200)}`), /200 characters/)
})

test('the manifest: on by default, built in on servers older than plugins, owning azureDevOpsBaseUrl; both halves give the provider', () => {
  const { manifest } = azureDevOpsServerPlugin
  assert.equal(manifest.id, 'azure-devops')
  assert.equal(manifest.defaultEnabled, true)
  assert.equal(manifest.legacyBuiltIn, true)
  assert.equal(manifest.legacyCapability, undefined)
  assert.deepEqual(manifest.projectSettings, { azureDevOpsBaseUrl: 'string' })
  assert.equal(azureDevOpsClientPlugin.ticketProvider, azureDevOpsTickets)
  assert.equal(azureDevOpsClientPlugin.manifest, manifest)
})

test("through the registry: azureDevOpsBaseUrl checked as the plugin's; the provider on where the plugin is", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-ado-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const projects = {
    require: (id) => {
      if (id === 'on') return { settings: {} }
      if (id === 'off') return { settings: { plugins: { 'azure-devops': { enabled: false } } } }
      throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
    }
  }
  const registry = createPluginRegistry({
    plugins: [azureDevOpsServerPlugin],
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub: { emit: () => 0, eventSubscriberCount: () => 0 },
    projects,
    isCoreMethod,
    coreToolNames: [],
    env: {}
  })
  assert.deepEqual(applySettingsPatch({}, { azureDevOpsBaseUrl: 'https://dev.azure.com/o/p' }, registry.settingRules), { azureDevOpsBaseUrl: 'https://dev.azure.com/o/p' })
  assert.throws(() => applySettingsPatch({}, { azureDevOpsBaseUrl: 'ftp://x' }, registry.settingRules), /settings\.azureDevOpsBaseUrl: must be an http\(s\) URL/)
  assert.deepEqual(registry.ticketProviders('on').map((p) => p.id), ['azure-devops'])
  assert.deepEqual(registry.ticketProviders('off'), [])
})
