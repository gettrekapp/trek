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
