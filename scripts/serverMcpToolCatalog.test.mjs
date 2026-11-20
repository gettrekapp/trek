// scripts/serverMcpToolCatalog.test.mjs — `mcpTools.list`: the configured MCP servers read from
// Claude Code's config, each asked for its tools over stdio or HTTP, the catalog's cache, and the
// shared list helpers the quick button editor shows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredServers, expandVars, readConfigSources, serverSpec } from '../plugins/claude/server/externalMcp.ts'
import { listServerTools, sseReply } from '../server/src/mcp/externalClient.ts'
import { ToolCatalog, toolCatalogHandlers } from '../server/src/mcp/toolCatalog.ts'
import { MCP_TOOLS } from '../server/src/mcp/tools.ts'
import { otherTools, qualifiedToolName, sortByName } from '../src/shared/mcpTools.ts'
import { removeDir } from './testPlatform.mjs'

const FAKE = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'fake-mcp-server.mjs')
const tempDir = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-mcp-catalog-')))
  t.after(() => removeDir(dir))
  return dir
}
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))

test('expandVars: ${VAR} and ${VAR:-default}, as Claude Code does', () => {
  const env = { A: 'one', EMPTY: '' }
  assert.equal(expandVars('x-${A}-${B:-two}-${EMPTY:-three}-${MISSING}', env), 'x-one-two-three-')
  assert.equal(expandVars('$A ${A', env), '$A ${A')
})

test('serverSpec: stdio, http and sse entries; a malformed one carries why', () => {
  const env = { HOME: '/h', TOKEN: 't' }
  assert.deepEqual(serverSpec('s', { command: 'npx', args: ['-y', '${HOME}/x'], env: { K: '${TOKEN}', N: 1 } }, 'user', env), {
    name: 's', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', '/h/x'], env: { K: 't' }, cwd: undefined
  })
  assert.deepEqual(serverSpec('h', { type: 'http', url: 'https://x/${TOKEN}', headers: { Authorization: 'Bearer ${TOKEN}' } }, 'local', env, '/p'), {
    name: 'h', scope: 'local', transport: 'http', url: 'https://x/t', headers: { Authorization: 'Bearer t' }, cwd: '/p'
  })
  assert.equal(serverSpec('u', { url: 'https://x' }, 'user', env).transport, 'http', 'a url without a type is http')
  assert.equal(serverSpec('e', { type: 'sse', url: 'https://x' }, 'user', env).transport, 'sse')
  assert.match(serverSpec('n', { type: 'stdio' }, 'user', env).invalid, /no command/)
  assert.match(serverSpec('n', { type: 'ws', url: 'x' }, 'user', env).invalid, /"ws"/)
  assert.match(serverSpec('n', 'nope', 'user', env).invalid, /not an object/)
})

test('configuredServers: local over project over user, Trek\'s own left out, unapproved project servers marked', () => {
  const servers = configuredServers({
    env: {},
    claudeJson: {
      mcpServers: { shared: { command: 'user-shared' }, mine: { command: 'mine' }, 'trek-dev': { type: 'http', url: 'http://x' } },
      projects: {
        '/p': { mcpServers: { shared: { command: 'local-shared' } }, enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['off'] }
      }
    },
    userSettings: [{ enabledMcpjsonServers: ['byUserSettings'] }],
    projects: [
      {
        path: '/p',
        mcpJson: { mcpServers: { approved: { command: 'a' }, off: { command: 'o' }, never: { command: 'n' }, byUserSettings: { command: 'u' }, mine: { command: 'project-mine' } } },
        settings: [{ enabledMcpjsonServers: ['never'], disabledMcpjsonServers: ['byUserSettings'] }]
      }
    ]
  })
  const view = Object.fromEntries(servers.map((s) => [s.name, `${s.scope}:${s.command}${s.unapproved ? ':unapproved' : ''}`]))
  assert.deepEqual(view, {
    approved: 'project:a',
    byUserSettings: 'project:u:unapproved',
    mine: 'project:project-mine:unapproved',
    never: 'project:n',
    off: 'project:o:unapproved',
    shared: 'local:local-shared'
  })
  assert.deepEqual(servers.map((s) => s.name), [...servers.map((s) => s.name)].sort(), 'by name')
})

test('configuredServers: enableAllProjectMcpServers approves every project server not disabled', () => {
  const servers = configuredServers({
    env: {},
    claudeJson: { projects: { '/p': { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['no'] } } },
    projects: [{ path: '/p', mcpJson: { mcpServers: { yes: { command: 'y' }, no: { command: 'n' } } } }]
  })
  assert.deepEqual(servers.map((s) => [s.name, s.unapproved === true]), [['no', true], ['yes', false]])
})

test('readConfigSources: CLAUDE_CONFIG_DIR, each project\'s .mcp.json and settings.local.json, never its committed settings.json', async (t) => {
  const dir = tempDir(t)
  const config = join(dir, 'config')
  const project = join(dir, 'repo')
  mkdirSync(config)
  mkdirSync(join(project, '.claude'), { recursive: true })
  writeJson(join(config, '.claude.json'), { mcpServers: { u: { command: 'u' } } })
  writeJson(join(config, 'settings.json'), { enabledMcpjsonServers: ['fromUser'] })
  writeJson(join(project, '.mcp.json'), { mcpServers: { fromUser: { command: 'a' }, fromLocal: { command: 'b' }, selfApproved: { command: 'c' } } })
  writeJson(join(project, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['fromLocal'] })
  writeJson(join(project, '.claude', 'settings.json'), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['selfApproved'] })
  const sources = await readConfigSources([project, project], { CLAUDE_CONFIG_DIR: config }, '/nowhere')
  assert.equal(sources.projects.length, 1, 'a path once')
  const servers = configuredServers(sources)
  assert.deepEqual(servers.map((s) => [s.name, s.unapproved === true]), [['fromLocal', false], ['fromUser', false], ['selfApproved', true], ['u', false]])
  assert.equal(servers.find((s) => s.name === 'fromLocal').cwd, project)
})

test('readConfigSources: missing or broken files read as none', async (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, '.claude.json'), '{ not json')
  const sources = await readConfigSources([join(dir, 'gone')], {}, dir)
  assert.equal(sources.claudeJson, undefined)
  assert.deepEqual(configuredServers(sources), [])
})

const fakeSpec = (mode, extra = {}) => ({ name: 'fake', scope: 'user', transport: 'stdio', command: process.execPath, args: [FAKE, mode], ...extra })

test('stdio: initialize then every page of tools/list; log lines and notifications skipped; cwd and env passed', async (t) => {
  const cwd = tempDir(t)
  const tools = await listServerTools(fakeSpec('ok', { cwd, env: { FAKE_MCP_ENV: 'from-config' } }), { timeoutMs: 15_000 })
  assert.deepEqual(tools.map((x) => x.name), ['zeta', 'Alpha', 'whereami'])
  assert.equal(tools[0].description, 'Last one', 'whitespace folded')
  assert.equal('description' in tools[1], false)
  assert.equal(tools[2].description, `${cwd} from-config`)
})

test('stdio: a server that exits says so with its stderr; an RPC error and a hang are errors too', async () => {
  await assert.rejects(listServerTools(fakeSpec('crash'), { timeoutMs: 15_000 }), /exited \(code 3\).*missing API key/s)
  await assert.rejects(listServerTools(fakeSpec('error'), { timeoutMs: 15_000 }), /tools\/list failed: boom/)
  await assert.rejects(listServerTools(fakeSpec('hang'), { timeoutMs: 1500 }), /did not answer within 2 s/)
  await assert.rejects(listServerTools({ ...fakeSpec('ok'), command: join(tmpdir(), 'no-such-mcp-server') }, { timeoutMs: 15_000 }), /could not start|ENOENT/)
})

test('not started: an unapproved, malformed or legacy SSE server', async () => {
  await assert.rejects(listServerTools({ ...fakeSpec('ok'), unapproved: true }), /not approved/)
  await assert.rejects(listServerTools({ name: 'x', scope: 'user', transport: 'stdio', invalid: 'its config has no command' }), /no command/)
  await assert.rejects(listServerTools({ name: 'x', scope: 'user', transport: 'sse', url: 'http://127.0.0.1:1' }), /legacy SSE/)
})

test('sseReply finds the reply to the id among the events', () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"x"}\n\nid: 1\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"ok":true}}\n\n'
  assert.deepEqual(sseReply(body, 2), { jsonrpc: '2.0', id: 2, result: { ok: true } })
  assert.equal(sseReply(body, 3), undefined)
})

/** A streamable HTTP MCP server: JSON for initialize, SSE for tools/list, a session id, a DELETE at the end. */
async function httpServer(t, { status } = {}) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'], auth: req.headers.authorization, body: body && JSON.parse(body) })
      if (status) return res.writeHead(status).end()
      if (req.method === 'DELETE') return res.writeHead(200).end()
      const msg = JSON.parse(body)
      if (msg.id === undefined) return res.writeHead(202).end()
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remote_tool', description: 'Does it remotely' }] } })}\n\n`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen }
}

test('http: JSON and SSE replies, the session id and negotiated version sent back, headers from the config, the session ended', async (t) => {
  const { url, seen } = await httpServer(t)
  const tools = await listServerTools({ name: 'h', scope: 'user', transport: 'http', url, headers: { Authorization: 'Bearer k' } }, { timeoutMs: 10_000 })
  assert.deepEqual(tools, [{ name: 'remote_tool', description: 'Does it remotely' }])
  assert.deepEqual(seen.map((s) => [s.method, s.body?.method, s.session, s.version, s.auth]), [
    ['POST', 'initialize', undefined, undefined, 'Bearer k'],
    ['POST', 'notifications/initialized', 'sess-1', '2025-03-26', 'Bearer k'],
    ['POST', 'tools/list', 'sess-1', '2025-03-26', 'Bearer k'],
    ['DELETE', undefined, 'sess-1', undefined, 'Bearer k']
  ])
})

test('http: a server that wants a sign-in says so; another failure names its status', async (t) => {
  const signIn = await httpServer(t, { status: 401 })
  await assert.rejects(listServerTools({ name: 'h', scope: 'user', transport: 'http', url: signIn.url }), /needs a sign-in/)
  const broken = await httpServer(t, { status: 500 })
  await assert.rejects(listServerTools({ name: 'h', scope: 'user', transport: 'http', url: broken.url }), /HTTP 500/)
})

test('ToolCatalog: asks once per set of paths, keeps the answer, a refresh asks again, callers share an ask in flight', async () => {
  let asks = 0
  let release
  const catalog = new ToolCatalog({
    configured: async (paths) => {
      asks++
      await new Promise((r) => (release = r))
      return [
        { name: 'b', scope: 'user', transport: 'stdio', command: 'x' },
        { name: 'a', scope: 'local', transport: 'http', url: 'http://x', cwd: paths[0] }
      ]
    },
    list: async (spec) => {
      if (spec.name === 'a') throw new Error('needs a sign-in')
      return [{ name: 'z' }, { name: 'y' }]
    },
    now: () => 42
  })
  const first = catalog.servers(['/p', '/q'])
  const second = catalog.servers(['/q', '/p', '/p'])
  await new Promise((r) => setImmediate(r))
  release()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one, two)
  assert.equal(asks, 1)
  assert.deepEqual(one, {
    checkedAt: 42,
    servers: [
      { name: 'a', scope: 'local', transport: 'http', tools: [], error: 'needs a sign-in' },
      { name: 'b', scope: 'user', transport: 'stdio', tools: [{ name: 'y' }, { name: 'z' }] }
    ]
  })
  assert.equal(await catalog.servers(['/p', '/q']), one, 'cached')
  const again = catalog.servers(['/p', '/q'], true)
  await new Promise((r) => setImmediate(r))
  release()
  await again
  assert.equal(asks, 2)
})

test('mcpTools.list: Trek\'s core and plugin tools sorted, the servers from the catalog, servers:false skips them', async () => {
  const project = { id: 'p1', repositories: [{ path: '/repo/a' }, { path: '/repo/b' }] }
  let pathsAsked
  const ctx = {
    projects: { require: (id) => (id === 'p1' ? project : assert.fail('unknown project')) },
    plugins: { tools: () => [{ definition: { name: 'aaa_plugin_tool', description: 'From a plugin', inputSchema: {} } }] },
    toolCatalog: {
      coreTools: MCP_TOOLS,
      servers: async (paths, refresh) => {
        pathsAsked = [paths, refresh]
        return { servers: [{ name: 'x', scope: 'user', transport: 'stdio', tools: [{ name: 't' }] }], checkedAt: 7 }
      }
    }
  }
  const list = toolCatalogHandlers['mcpTools.list']
  const result = await list({ projectId: 'p1', refresh: true }, ctx)
  assert.equal(result.trek.length, MCP_TOOLS.length + 1)
  assert.equal(result.trek[0].name, 'aaa_plugin_tool')
  assert.deepEqual(result.trek.map((x) => x.name), sortByName(result.trek).map((x) => x.name))
  assert.ok(result.trek.some((x) => x.name === 'list_worktrees' && x.description))
  assert.deepEqual(result.servers.map((s) => s.name), ['x'])
  assert.equal(result.checkedAt, 7)
  assert.deepEqual(pathsAsked, [['/repo/a', '/repo/b'], true])
  pathsAsked = undefined
  const fast = await list({ projectId: 'p1', servers: false }, ctx)
  assert.deepEqual([fast.servers, fast.checkedAt, pathsAsked], [[], 0, undefined])
  await assert.rejects(async () => list({ projectId: 'p1', refresh: 'yes' }, ctx), /refresh must be a boolean/)
  await assert.rejects(async () => list({ projectId: 'p1', servers: 1 }, ctx), /servers must be a boolean/)
})

test('otherTools: every server\'s tools by the name Claude Code calls them, sorted across servers', () => {
  assert.equal(qualifiedToolName('claude.ai Google Drive', 'search'), 'mcp__claude_ai_Google_Drive__search')
  const catalog = {
    trek: [],
    checkedAt: 0,
    servers: [
      { name: 'zed', scope: 'user', transport: 'stdio', tools: [{ name: 'a', description: 'A' }] },
      { name: 'chrome-devtools', scope: 'user', transport: 'stdio', tools: [{ name: 'take_screenshot' }, { name: 'click' }] },
      { name: 'down', scope: 'user', transport: 'http', tools: [], error: 'x' }
    ]
  }
  assert.deepEqual(otherTools(catalog), [
    { name: 'mcp__chrome-devtools__click', description: undefined },
    { name: 'mcp__chrome-devtools__take_screenshot', description: undefined },
    { name: 'mcp__zed__a', description: 'A' }
  ])
})
