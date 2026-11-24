// scripts/campsitePlugin.test.mjs — the campsite plugin's identity: a server half that keeps the camp,
// built in after Colima, on by default; its MCP tools (part 5) listed and called through the
// server's plugin registry and trek-dev MCP only in the projects where it is on.
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CAMPSITE_MANIFEST } from '../plugins/campsite/manifest.ts'
import { campsiteServerPlugin } from '../plugins/campsite/server/index.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { DEFAULT_PREFS, readPrefs } from '../plugins/campsite/shared/prefs.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { mcpContext } from '../server/src/plugins/mcp.ts'
import { handleMcpBody } from '../server/src/mcp/protocol.ts'
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '../server/src/mcp/tools.ts'
import { isCoreMethod } from '../server/src/v2.ts'

test('campsite: id, default on, no secrets or settings', () => {
  assert.equal(CAMPSITE_MANIFEST.id, 'campsite')
  assert.equal(CAMPSITE_MANIFEST.name, 'Campsite')
  assert.equal(CAMPSITE_MANIFEST.defaultEnabled, true)
  assert.equal(CAMPSITE_MANIFEST.secrets, undefined)
  assert.equal(CAMPSITE_MANIFEST.projectSettings, undefined)
})

test('campsite: its server half answers state, build, recruit, gear, pin, journal, trailLog, notes, seen and awaySeen, and has two MCP tools (part 5)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-campsite-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const host = { id: 'campsite', dataFile: (n) => join(dir, n), onActivity: () => () => {}, emitAll: () => 0, session: () => ({}), checkedWorktree: async () => ({}), run: async () => '', isEnabled: () => true, projectName: () => 'P', worktree: () => ({}), worktrees: () => [], log: { info() {}, warn() {} } }
  const instance = campsiteServerPlugin.setup(host)
  t.after(() => instance.dispose?.())
  assert.deepEqual(Object.keys(instance.handlers), ['state', 'build', 'recruit', 'gear', 'pin', 'journal', 'trailLog', 'notes', 'seen', 'awaySeen'])
  assert.deepEqual(instance.mcpTools.map((tool) => tool.definition.name), ['camp_note', 'camp_trail_report'])
  assert.match(instance.mcpInstructions, /camp_trail_report/)
})

test('campsite: built in last, after Colima', () => {
  const ids = BUILTIN_SERVER_PLUGINS.map((p) => p.manifest.id)
  assert.equal(ids.at(-1), 'campsite')
  assert.equal(ids.at(-2), 'env')
})

test('readPrefs: booleans for the switches, a known choice for the sky and seasons, a time for the guide and the noticeboard, defaults for the rest', () => {
  assert.deepEqual(DEFAULT_PREFS, { showCampsite: true, showTerminalHiker: true, showDog: true, sky: 'clock', seasons: 'north', guideSeenAt: 0, notesSeenAt: 0 })
  assert.equal(readPrefs({ guideSeenAt: 1_800_000_000_000 }).guideSeenAt, 1_800_000_000_000)
  for (const bad of [-1, 'soon', true, Number.NaN]) assert.equal(readPrefs({ guideSeenAt: bad }).guideSeenAt, 0, String(bad))
  // The noticeboard's seen time (part 5), a time like the guide's
  assert.equal(readPrefs({ notesSeenAt: 1_800_000_000_000 }).notesSeenAt, 1_800_000_000_000)
  for (const bad of [-1, 'soon', false]) assert.equal(readPrefs({ notesSeenAt: bad }).notesSeenAt, 0, String(bad))
  assert.deepEqual(readPrefs({}), DEFAULT_PREFS)
  assert.deepEqual(readPrefs({ showCampsite: false, campsiteCollapsed: 'yes', other: 1 }), { ...DEFAULT_PREFS, showCampsite: false })
  assert.deepEqual(readPrefs({ sky: 'dusk', seasons: 'south' }), { ...DEFAULT_PREFS, sky: 'dusk', seasons: 'south' })
  assert.deepEqual(readPrefs({ seasons: 'off' }).seasons, 'off')
  assert.deepEqual(readPrefs({ sky: 'noon', seasons: true, showDog: 'clock' }), DEFAULT_PREFS, 'unknown values fall back to the defaults')
  assert.deepEqual(readPrefs({ sky: 1 }).sky, 'clock')
})

test('campsite MCP (part 5): camp_note and camp_trail_report listed and called over trek-dev only where Campsite is on; an error is an isError result', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-campsite-mcp-'))
  const project = (id, plugins) => ({ id, name: id, settings: plugins ? { plugins } : {}, globalSessions: [{ id: `${id}-g` }], repositories: [{ id: 'r', path: '/r', worktrees: [{ id: 'w', path: '/r', branch: 'main', sessions: [{ id: `${id}-s` }] }] }] })
  const projects = { on: project('on'), off: project('off', { campsite: { enabled: false } }) }
  const emitted = []
  const registry = createPluginRegistry({
    plugins: [campsiteServerPlugin],
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub: { emit: (topic, event, payload) => (emitted.push([topic, event, payload]), 1), eventSubscriberCount: () => 1 },
    projects: { require: (id) => { if (!Object.hasOwn(projects, id)) throw Object.assign(new Error(`No project with id "${id}"`), { code: 'NOT_FOUND' }); return projects[id] }, all: () => Object.values(projects) },
    isCoreMethod,
    coreToolNames: MCP_TOOLS.map((tool) => tool.name),
    env: {},
    warn: () => {}
  })
  t.after(async () => {
    await registry.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const core = async (name) => `core ${name}`
  const mcp = (projectId) => ({ serverVersion: 'test', ...mcpContext(projectId, core, registry, MCP_TOOLS) })
  const rpc = async (projectId, method, params) => (await handleMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), mcp(projectId))).json.result
  const names = async (projectId) => (await rpc(projectId, 'tools/list', {})).tools.map((tool) => tool.name)
  assert.deepEqual((await names('on')).slice(-2), ['camp_note', 'camp_trail_report'])
  assert.equal((await names('off')).some((n) => n.startsWith('camp_')), false)
  assert.match((await rpc('on', 'initialize', {})).instructions, /camp_trail_report when you finish a task/)
  assert.equal((await rpc('off', 'initialize', {})).instructions, MCP_INSTRUCTIONS)
  const called = await rpc('on', 'tools/call', { name: 'camp_note', arguments: { text: 'Tests are green.', terminalId: 'on-s' } })
  assert.deepEqual(called, { content: [{ type: 'text', text: JSON.stringify('Pinned to the noticeboard.', null, 2) }], isError: false })
  assert.deepEqual(emitted.filter(([, event]) => event === 'campsite.note').map(([topic, , payload]) => [topic, payload.projectId, payload.note.text]), [['project:on', 'on', 'Tests are green.']])
  const refused = await rpc('on', 'tools/call', { name: 'camp_trail_report', arguments: { summary: 'From the log', terminalId: 'on-g' } })
  assert.deepEqual(refused, { content: [{ type: 'text', text: 'This session has no trail (Global); leave a camp_note instead.' }], isError: true })
  const foreign = await rpc('on', 'tools/call', { name: 'camp_note', arguments: { text: 'hi', terminalId: 'off-s' } })
  assert.equal(foreign.isError, true, "another project's session")
  assert.equal((await handleMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'camp_note', arguments: { text: 'hi' } } }), mcp('off'))).json.error.code, -32602, 'not listed where it is off')
})
