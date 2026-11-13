// scripts/tickets.test.mjs — core's generic tickets (plugin system phase 2): parsing, the owner, the
// label, the link and the looked-up issue of a branch's ticket, through the ticket providers on for
// a project; the window's ticket info store; a plugin's legacyBuiltIn status.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTicketWith, ticketOwner, ticketView } from '../src/shared/tickets.ts'
import { createTicketInfoStore } from '../src/renderer/src/plugins/ticketInfo.ts'
import { createClientHost } from '../src/renderer/src/plugins/host.ts'
import { pluginStatus } from '../src/renderer/src/plugins/presence.ts'

/** Two fake trackers: letters-dash-digits, and `n<digits>`. */
const dash = {
  id: 'dash',
  hint: 'a dash id',
  owns: (id) => /^[A-Z]+-\d+$/.test(id),
  parse: (input) => {
    const url = input.match(/^https:\/\/dash\.example\/([a-z]+)\/(\w+-\d+)$/i)
    if (url) return { ticketId: url[2].toUpperCase(), settings: { dashSpace: url[1] } }
    return /^[a-z]+-\d+$/i.test(input) ? { ticketId: input.toUpperCase() } : null
  },
  label: (id) => id,
  url: (settings, id, info) => info?.url ?? (typeof settings.dashSpace === 'string' ? `https://dash.example/${settings.dashSpace}/${id}` : null)
}
const num = {
  id: 'num',
  hint: 'a number',
  owns: (id) => /^\d+$/.test(id),
  parse: (input) => (/^n?\d+$/.test(input) ? { ticketId: input.replace(/^n/, '') } : null),
  label: (id) => `#${id}`,
  url: () => null
}
const broken = {
  id: 'broken',
  hint: 'nothing',
  owns: () => {
    throw new Error('boom')
  },
  parse: () => {
    throw new Error('boom')
  },
  label: () => 'x',
  url: () => null
}

test('parseTicketWith: the first provider that reads the input, trimmed, with what it implies; null for none or blank', () => {
  assert.deepEqual(parseTicketWith([dash, num], ' ab-12 '), { ticketId: 'AB-12', providerId: 'dash' })
  assert.deepEqual(parseTicketWith([dash, num], 'https://dash.example/team/ab-3'), { ticketId: 'AB-3', settings: { dashSpace: 'team' }, providerId: 'dash' })
  assert.deepEqual(parseTicketWith([dash, num], 'n42'), { ticketId: '42', providerId: 'num' })
  assert.equal(parseTicketWith([dash], 'n42'), null, 'a provider that is off does not read it')
  assert.equal(parseTicketWith([dash, num], 'not a ticket'), null)
  assert.equal(parseTicketWith([dash, num], '   '), null)
  // A provider that throws counts as no match; the next one still reads it.
  assert.deepEqual(parseTicketWith([broken, num], '7'), { ticketId: '7', providerId: 'num' })
})

test("ticketOwner and ticketView: the owner's label and link, its looked-up issue; a ticket no provider owns is bare", () => {
  assert.equal(ticketOwner([dash, num], 'AB-1').id, 'dash')
  assert.equal(ticketOwner([dash], '5'), undefined)
  assert.deepEqual(ticketView([dash, num], { dashSpace: 'team' }, 'AB-1'), { label: 'AB-1', url: 'https://dash.example/team/AB-1', providerId: 'dash' })
  assert.deepEqual(ticketView([dash, num], {}, 'AB-1'), { label: 'AB-1', url: null, providerId: 'dash' }, 'its setting missing')
  assert.deepEqual(ticketView([dash, num], {}, '5'), { label: '#5', url: null, providerId: 'num' })
  assert.deepEqual(ticketView([dash], {}, '5'), { label: '5', url: null }, 'no provider on owns it')
  const info = { title: 'Fix it', status: 'Doing', statusColor: '#f00', url: 'https://issue' }
  const infoFor = (providerId, ticketId) => (providerId === 'dash' && ticketId === 'AB-1' ? info : undefined)
  assert.deepEqual(ticketView([dash], {}, 'AB-1', infoFor), { label: 'AB-1', url: 'https://issue', providerId: 'dash', info })
  assert.deepEqual(ticketView([broken, num], {}, '5'), { label: '#5', url: null, providerId: 'num' })
})

test('the ticket info store: per backend and plugin, replaced by each set, versioned, heard', () => {
  const store = createTicketInfoStore()
  const a = {}
  const b = {}
  let heard = 0
  const off = store.subscribe(() => heard++)
  const issue = { title: 'T', status: 'S', statusColor: '#000' }
  store.set(a, 'dash', { 'AB-1': issue })
  assert.equal(store.get(a, 'dash', 'AB-1'), issue)
  assert.equal(store.get(b, 'dash', 'AB-1'), undefined, 'another backend sees none')
  assert.equal(store.get(a, 'other', 'AB-1'), undefined, 'another plugin sees none')
  assert.equal(store.get(a, 'dash', 'toString'), undefined)
  const v = store.version()
  store.set(a, 'dash', {})
  assert.equal(store.get(a, 'dash', 'AB-1'), undefined, 'a set replaces')
  assert.equal(store.version(), v + 1)
  off()
  store.set(a, 'dash', {})
  assert.equal(heard, 2)
})

test("the client host's setTicketInfo publishes under its backend and plugin", () => {
  const store = createTicketInfoStore()
  const backend = { plugins: { projectId: 'p1', welcome: () => undefined, request: async () => null, onEvent: () => () => {} } }
  const appSettings = { get: async () => ({}), update: async () => ({}), onChanged: () => () => {} }
  const manifest = { id: 'dash', version: '1', name: 'Dash', description: '', defaultEnabled: true }
  const host = createClientHost(manifest, backend, { appSettings, terminalLabel: String, currentBackend: () => backend, ticketInfo: store })
  host.setTicketInfo({ 'AB-1': { title: 'T', status: 'S', statusColor: '#000' } })
  assert.equal(store.get(backend, 'dash', 'AB-1').title, 'T')
})

test('pluginStatus: a legacyBuiltIn plugin is legacy on a server older than plugins, missing on one that lists others', () => {
  const ado = { id: 'azure-devops', version: '1', name: 'Azure DevOps', description: '', defaultEnabled: true, legacyBuiltIn: true }
  assert.equal(pluginStatus(ado, { capabilities: [] }, undefined), 'legacy')
  assert.equal(pluginStatus(ado, { plugins: [], capabilities: [] }, undefined), 'missing')
  assert.equal(pluginStatus(ado, { plugins: [{ id: 'azure-devops', version: '1', defaultEnabled: true }], capabilities: [] }, { 'azure-devops': { enabled: false } }), 'off')
})

// ---- The window's trackers (the plugins active there) ----

import { activeTicketProviders, windowTicketView } from '../src/renderer/src/plugins/ticketProviders.ts'
import { linearTickets } from '../plugins/linear/shared/ticket.ts'
import { azureDevOpsTickets } from '../plugins/azure-devops/shared/ticket.ts'
import { FOCUS_THROTTLE_MS, REFRESH_MS, linearIds, ticketInfoOf } from '../plugins/linear/client/issues.ts'

const linearPlugin = { manifest: { id: 'linear', version: '1', name: 'Linear', description: '', defaultEnabled: true, legacyCapability: 'linear' }, ticketProvider: linearTickets }
const adoPlugin = { manifest: { id: 'azure-devops', version: '1', name: 'Azure DevOps', description: '', defaultEnabled: true, legacyBuiltIn: true }, ticketProvider: azureDevOpsTickets }
const voicePlugin = { manifest: { id: 'voice', version: '1', name: 'Voice', description: '', defaultEnabled: true, legacyCapability: 'voice' } }
const listed = (...ids) => ({ plugins: ids.map((id) => ({ id, version: '1', defaultEnabled: true })), capabilities: [] })

test("activeTicketProviders: the providers of the plugins on in the project, in built-in order; none before the welcome", () => {
  const plugins = [voicePlugin, linearPlugin, adoPlugin]
  const ids = (welcome, settings) => activeTicketProviders(plugins, welcome, settings).map((p) => p.id)
  assert.deepEqual(ids(undefined, undefined), [])
  assert.deepEqual(ids(listed('voice', 'linear', 'azure-devops'), undefined), ['linear', 'azure-devops'])
  assert.deepEqual(ids(listed('voice', 'linear', 'azure-devops'), { linear: { enabled: false } }), ['azure-devops'])
  assert.deepEqual(ids(listed('voice', 'azure-devops'), undefined), ['azure-devops'], 'a server without the Linear plugin')
  // A 0.2.x server: Linear by its capability, Azure DevOps built in.
  assert.deepEqual(ids({ capabilities: ['linear'] }, undefined), ['linear', 'azure-devops'])
  assert.deepEqual(ids({ capabilities: [] }, undefined), ['azure-devops'])
})

test("windowTicketView: the owner's link, with its looked-up issue for this backend only", () => {
  const store = createTicketInfoStore()
  const backend = {}
  store.set(backend, 'linear', { 'TOW-1': { title: 'Fix', status: 'Doing', statusColor: '#0f0', url: 'https://linear.app/x/issue/TOW-1' } })
  const providers = [linearTickets, azureDevOpsTickets]
  assert.deepEqual(windowTicketView(providers, {}, 'TOW-1', store, backend), {
    label: 'TOW-1',
    url: 'https://linear.app/x/issue/TOW-1',
    providerId: 'linear',
    info: { title: 'Fix', status: 'Doing', statusColor: '#0f0', url: 'https://linear.app/x/issue/TOW-1' }
  })
  assert.deepEqual(windowTicketView(providers, {}, 'TOW-1', store, {}), { label: 'TOW-1', url: null, providerId: 'linear' }, 'another backend has no info')
  assert.deepEqual(windowTicketView(providers, { azureDevOpsBaseUrl: 'https://d/o/p' }, '9', store, backend), { label: '#9', url: 'https://d/o/p/_workitems/edit/9', providerId: 'azure-devops' })
})

test("the Linear Runtime's rules: the project's Linear ids once each, sorted; issues as ticket info; its timings", () => {
  const host = { ticketIds: () => ['TOW-2', '12', 'TOW-1', 'TOW-2', 'nope'] }
  assert.deepEqual(linearIds(host), ['TOW-1', 'TOW-2'])
  const issue = { identifier: 'TOW-1', title: 'T', url: 'https://u', status: 'Done', statusType: 'completed', statusColor: '#00f' }
  assert.deepEqual(ticketInfoOf([issue]), { 'TOW-1': { title: 'T', status: 'Done', statusColor: '#00f', url: 'https://u' } })
  assert.deepEqual([REFRESH_MS, FOCUS_THROTTLE_MS], [300_000, 60_000])
})

test("the client host's ticketIds and onTicketIdsChanged come from its deps (none without)", () => {
  const backend = { plugins: { projectId: 'p1', welcome: () => undefined, request: async () => null, onEvent: () => () => {} } }
  const appSettings = { get: async () => ({}), update: async () => ({}), onChanged: () => () => {} }
  const manifest = { id: 'linear', version: '1', name: 'Linear', description: '', defaultEnabled: true }
  const bare = createClientHost(manifest, backend, { appSettings, terminalLabel: String, currentBackend: () => backend })
  assert.deepEqual(bare.ticketIds(), [])
  bare.onTicketIdsChanged(() => {})()
  let listener
  const host = createClientHost(manifest, backend, {
    appSettings,
    terminalLabel: String,
    currentBackend: () => backend,
    ticketIds: () => ['TOW-1'],
    onTicketIdsChanged: (l) => ((listener = l), () => (listener = undefined))
  })
  assert.deepEqual(host.ticketIds(), ['TOW-1'])
  let heard = 0
  const off = host.onTicketIdsChanged(() => heard++)
  listener()
  off()
  assert.equal(heard, 1)
  assert.equal(listener, undefined)
})

test("the Linear provider's fromBranch: the issue id a Linear-style branch name embeds", () => {
  assert.equal(linearTickets.fromBranch('garrett/tow-123-fix-login'), 'TOW-123')
  assert.equal(linearTickets.fromBranch('tow-9'), 'TOW-9')
  assert.equal(linearTickets.fromBranch('feature/login'), null)
  assert.equal(azureDevOpsTickets.fromBranch, undefined)
})

// ---- The link dialog's plan, the newest-lookup guard, a reconnect (review fixes) ----

import { ticketFromBranch, ticketLinkPlan } from '../src/shared/tickets.ts'
import { createLatest } from '../plugins/linear/client/issues.ts'

test("ticketLinkPlan: the id, the settings a URL implies (only those that differ), the link field and its check", () => {
  const providers = [linearTickets, azureDevOpsTickets]
  assert.deepEqual(ticketLinkPlan(providers, {}, 'https://linear.app/acme/issue/TOW-1'), { ticketId: 'TOW-1', settings: { linearWorkspace: 'acme' }, problem: null })
  assert.deepEqual(ticketLinkPlan(providers, { linearWorkspace: 'acme' }, 'https://linear.app/acme/issue/TOW-1'), { ticketId: 'TOW-1', settings: {}, problem: null }, 'the same workspace is not written again')
  // A bare id whose tracker lacks its setting: the field, empty, then checked, then written.
  const link = { key: 'linearWorkspace', label: 'Linear workspace', placeholder: linearTickets.linkSetting.placeholder }
  assert.deepEqual(ticketLinkPlan(providers, {}, 'tow-2'), { ticketId: 'TOW-2', link, settings: {}, problem: null })
  assert.deepEqual(ticketLinkPlan(providers, {}, 'tow-2', 'a b'), { ticketId: 'TOW-2', link, settings: {}, problem: 'Linear workspace must be a Linear workspace slug (letters, digits, _ and -; at most 200)' })
  assert.deepEqual(ticketLinkPlan(providers, {}, 'tow-2', ' acme '), { ticketId: 'TOW-2', link, settings: { linearWorkspace: 'acme' }, problem: null })
  assert.equal(ticketLinkPlan(providers, { linearWorkspace: 'acme' }, 'TOW-2').link, undefined, 'the project has it')
  assert.match(ticketLinkPlan(providers, {}, '7', 'dev.azure.com/o/p').problem, /^Azure DevOps project URL must be an http\(s\) URL/)
  assert.deepEqual(ticketLinkPlan(providers, {}, 'nope'), { ticketId: null, settings: {}, problem: 'Enter a Linear issue id (TOW-123) or issue URL, or an Azure DevOps work item id or URL.' })
  assert.match(ticketLinkPlan([], {}, 'TOW-1').problem, /No ticket tracker is on/)
})

test('ticketFromBranch: the first provider that reads an id in the branch name', () => {
  assert.equal(ticketFromBranch([azureDevOpsTickets, linearTickets], 'garrett/tow-123-fix-login'), 'TOW-123')
  assert.equal(ticketFromBranch([azureDevOpsTickets], 'garrett/tow-123-fix-login'), '')
  assert.equal(ticketFromBranch([linearTickets], 'main'), '')
})

test('createLatest: only the newest lookup counts', () => {
  const latest = createLatest()
  const a = latest.next()
  const b = latest.next()
  assert.equal(latest.isLatest(a), false)
  assert.equal(latest.isLatest(b), true)
})

test("the client host's onChanged also fires when the window's connection comes back up", () => {
  let connected
  const backend = {
    plugins: { projectId: 'p1', welcome: () => ({ plugins: [], capabilities: [] }), request: async () => null, onEvent: () => () => {}, onConnected: (l) => ((connected = l), () => (connected = undefined)) }
  }
  const appSettings = { get: async () => ({}), update: async () => ({}), onChanged: () => () => {} }
  const host = createClientHost({ id: 'linear', version: '1', name: 'Linear', description: '', defaultEnabled: true }, backend, { appSettings, terminalLabel: String, currentBackend: () => backend })
  let changes = 0
  const off = host.onChanged(() => changes++)
  connected()
  assert.equal(changes, 1)
  off()
  assert.equal(connected, undefined)
})

// ---- Review follow-ups: a provider's parse checked by its owns, warnings per method, the info store's no-op sets, ids, status colors ----

import { safeStatusColor } from '../src/renderer/src/plugins/ticketProviders.ts'

test("parseTicketWith: a parse whose ticket id its own provider doesn't own (or no id) is no match", () => {
  const lower = { ...dash, id: 'lower', parse: (input) => (/^[a-z]+-\d+$/.test(input) ? { ticketId: input } : null) }
  assert.equal(parseTicketWith([lower], 'ab-1'), null, 'a lowercase id its owns rejects')
  assert.deepEqual(parseTicketWith([lower, num], 'ab-1'), null)
  assert.deepEqual(parseTicketWith([lower, dash], 'ab-1'), { ticketId: 'AB-1', providerId: 'dash' }, 'the next provider still reads it')
  const empty = { ...dash, id: 'empty', owns: () => true, parse: () => ({ ticketId: '' }) }
  const notString = { ...dash, id: 'notstring', owns: () => true, parse: () => ({ ticketId: 5 }) }
  assert.equal(parseTicketWith([empty, notString], 'x'), null)
})

test("a provider's throws are warned once per provider and method", (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (m) => warnings.push(m))
  const flaky = {
    id: 'flaky-warn',
    hint: '',
    owns: (id) => {
      if (id === 'throw') throw new Error('owns broke')
      return true
    },
    parse: () => null,
    label: (id) => id,
    url: () => {
      throw new Error('url broke')
    }
  }
  ticketOwner([flaky], 'throw')
  ticketOwner([flaky], 'throw')
  assert.equal(ticketView([flaky], {}, 'T-1').url, null)
  ticketView([flaky], {}, 'T-1')
  assert.equal(warnings.length, 2, String(warnings))
  assert.match(warnings[0], /flaky-warn failed \(owns\): owns broke/)
  assert.match(warnings[1], /flaky-warn failed \(url\): url broke/)
})

test('the ticket info store: a set equal by value does nothing; a listener that throws does not stop the others', (t) => {
  t.mock.method(console, 'error', () => {})
  const store = createTicketInfoStore()
  const backend = {}
  let heard = 0
  store.subscribe(() => {
    throw new Error('bad listener')
  })
  store.subscribe(() => heard++)
  const v0 = store.version()
  store.set(backend, 'dash', {})
  assert.equal(store.version(), v0, 'an absent entry equals {}')
  assert.equal(heard, 0)
  store.set(backend, 'dash', { 'AB-1': { title: 'T', status: 'S', statusColor: '#000' } })
  assert.equal(store.version(), v0 + 1)
  assert.equal(heard, 1, 'heard despite the throwing listener')
  store.set(backend, 'dash', { 'AB-1': { title: 'T', status: 'S', statusColor: '#000' } })
  assert.equal(store.version(), v0 + 1, 'the same tickets by value')
  assert.equal(heard, 1)
  store.set(backend, 'dash', { 'AB-1': { title: 'T', status: 'Done', statusColor: '#000' } })
  assert.equal(store.version(), v0 + 2)
  store.set(backend, 'dash', { 'AB-1': { title: 'T', status: 'Done', statusColor: '#000', url: 'https://x' } })
  assert.equal(store.version(), v0 + 3, 'a new field is a change')
  assert.equal(heard, 3)
})

test("activeTicketProviders: a plugin whose provider's id is not its own is left out (warned once)", (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (m) => warnings.push(m))
  const misnamed = { manifest: { id: 'misnamed', version: '1', name: 'M', description: '', defaultEnabled: true }, ticketProvider: { ...num, id: 'num' } }
  const welcome = listed('misnamed', 'azure-devops')
  assert.deepEqual(activeTicketProviders([misnamed, adoPlugin], welcome, undefined).map((p) => p.id), ['azure-devops'])
  activeTicketProviders([misnamed, adoPlugin], welcome, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /misnamed/)
})

test('safeStatusColor: plain CSS colors only', () => {
  for (const ok of ['#abc', '#a1b2c3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120, 50%, 50%)', 'hsla(120,50%,50%,.3)', 'red', 'RebeccaPurple']) {
    assert.equal(safeStatusColor(ok), ok, ok)
  }
  for (const bad of ['url(x)', 'red;background:url(x)', '#abcd1', '#ggg', 'rgb(var(--x))', 'calc(1px)', 'red blue', '', ' red', 'expression(alert(1))', 'rgb(1,2,3);x:y']) {
    assert.equal(safeStatusColor(bad), undefined, bad)
  }
  assert.equal(safeStatusColor(undefined), undefined)
  assert.equal(safeStatusColor(5), undefined)
})
