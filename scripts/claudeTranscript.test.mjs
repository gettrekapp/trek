// scripts/claudeTranscript.test.mjs — Claude Code's session transcript (campsite part 4): the tool
// calls on a line (kind and label), and core's label cut. The lines are shaped like Claude Code's
// (an assistant line's message.content blocks), with made-up content.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_TOOL_KINDS, AGENT_TOOL_LABEL_MAX, agentTool, toolLabel } from '../src/shared/plugins/agents.ts'
import { toolKind, toolLabelOf, toolsInLine } from '../plugins/claude/shared/transcript.ts'

/** An assistant line as Claude Code writes it, with these content blocks */
const assistant = (...content) =>
  JSON.stringify({
    parentUuid: 'p-1',
    isSidechain: false,
    type: 'assistant',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    uuid: 'u-1',
    timestamp: '2026-11-23T12:00:00.000Z',
    sessionId: '00000000-0000-4000-8000-000000000000',
    cwd: '/work/app'
  })
const use = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input, caller: { type: 'direct' } })

test('toolLabel: one line, spaces collapsed, cut to 40 characters with an ellipsis', () => {
  assert.equal(AGENT_TOOL_LABEL_MAX, 40)
  assert.equal(toolLabel('  npm   test\n -- --watch '), 'npm test -- --watch')
  assert.equal(toolLabel('x'.repeat(40)), 'x'.repeat(40))
  const cut = toolLabel('y'.repeat(41))
  assert.equal(cut.length, 40)
  assert.equal(cut, `${'y'.repeat(39)}…`)
  assert.equal(toolLabel('a'.repeat(38) + '  bc'), `${'a'.repeat(38)}…`, 'no space before the ellipsis')
})

test('agentTool: a known kind (else other) and a cut label; not an object is null', () => {
  assert.deepEqual(AGENT_TOOL_KINDS, ['read', 'edit', 'run', 'delegate', 'web', 'mcp', 'other'])
  assert.deepEqual(agentTool({ kind: 'edit', label: 'Campsite.tsx' }), { kind: 'edit', label: 'Campsite.tsx' })
  assert.deepEqual(agentTool({ kind: 'dance', label: 'x' }), { kind: 'other', label: 'x' })
  assert.deepEqual(agentTool({ kind: 'run' }), { kind: 'run', label: '' })
  assert.equal(agentTool({ kind: 'read', label: 'z'.repeat(99) }).label.length, 40)
  assert.equal(agentTool(null), null)
  assert.equal(agentTool('edit'), null)
})

test('toolKind: Claude Code tools by kind; mcp__ names are MCP; anything else is other', () => {
  for (const name of ['Read', 'Grep', 'Glob', 'LS']) assert.equal(toolKind(name), 'read', name)
  for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(toolKind(name), 'edit', name)
  assert.equal(toolKind('Bash'), 'run')
  assert.equal(toolKind('Task'), 'delegate')
  assert.equal(toolKind('Agent'), 'delegate')
  assert.equal(toolKind('WebFetch'), 'web')
  assert.equal(toolKind('WebSearch'), 'web')
  assert.equal(toolKind('mcp__trek-dev__list_worktrees'), 'mcp')
  for (const name of ['TodoWrite', 'Skill', 'ToolSearch', 'constructor', 'read']) assert.equal(toolKind(name), 'other', name)
})

test('toolLabelOf: base names, a search, a command line, a host, a description, an MCP server and tool, cut to 40', () => {
  assert.equal(toolLabelOf('Read', { file_path: '/work/app/plugins/campsite/client/Campsite.tsx' }), 'Campsite.tsx')
  assert.equal(toolLabelOf('Edit', { file_path: 'C:\\work\\app\\src\\main.ts', old_string: 'a', new_string: 'b' }), 'main.ts')
  assert.equal(toolLabelOf('NotebookEdit', { notebook_path: '/n/explore.ipynb', new_source: '' }), 'explore.ipynb')
  assert.equal(toolLabelOf('Grep', { pattern: 'choreFor', path: '/work/app/plugins' }), 'choreFor')
  assert.equal(toolLabelOf('Glob', { pattern: '**/*.test.mjs' }), '**/*.test.mjs')
  assert.equal(toolLabelOf('LS', { path: '/work/app/plugins/' }), 'plugins')
  assert.equal(toolLabelOf('Bash', { command: 'npm test\nnpm run typecheck', description: 'Run the tests' }), 'npm test')
  assert.equal(toolLabelOf('Bash', { command: 'node --test scripts/campsiteHiker.test.mjs scripts/campsiteStage.test.mjs' }), 'node --test scripts/campsiteHiker.test.…')
  assert.equal(toolLabelOf('WebFetch', { url: 'https://github.com/owner/repo/pull/1', prompt: 'read it' }), 'github.com')
  assert.equal(toolLabelOf('WebFetch', { url: 'not a url' }), '')
  assert.equal(toolLabelOf('WebSearch', { query: 'pixi texture nearest' }), 'pixi texture nearest')
  assert.equal(toolLabelOf('Agent', { description: 'Explore the trails', prompt: 'long', subagent_type: 'Explore' }), 'Explore the trails')
  assert.equal(toolLabelOf('mcp__trek-dev__list_worktrees', {}), 'trek-dev list_worktrees')
  assert.equal(toolLabelOf('mcp__claude_ai_Docs__create', { title: 'x' }), 'claude_ai_Docs create')
  assert.equal(toolLabelOf('mcp__solo', {}), 'solo')
  assert.equal(toolLabelOf('TodoWrite', { todos: [] }), 'TodoWrite', 'another tool: its name')
  assert.equal(toolLabelOf('Read', {}), '', 'nothing to say')
  assert.equal(toolLabelOf('Read', { file_path: 3 }), '')
})

test('toolsInLine: the tool_use blocks of an assistant line, in order; text, thinking and other lines have none', () => {
  assert.deepEqual(toolsInLine(assistant(use('Edit', { file_path: '/w/Campsite.tsx', old_string: 'a', new_string: 'b' }))), [{ kind: 'edit', label: 'Campsite.tsx' }])
  assert.deepEqual(
    toolsInLine(assistant({ type: 'text', text: 'Looking.' }, use('Read', { file_path: '/w/a.ts' }), use('Bash', { command: 'npm test' }), use('mcp__trek-dev__list_worktrees', {}))),
    [
      { kind: 'read', label: 'a.ts' },
      { kind: 'run', label: 'npm test' },
      { kind: 'mcp', label: 'trek-dev list_worktrees' }
    ]
  )
  assert.deepEqual(toolsInLine(assistant({ type: 'text', text: 'Done.' })), [])
  assert.deepEqual(toolsInLine(assistant({ type: 'thinking', thinking: '…', signature: 's' })), [])
  // A user line carrying a tool's result, and the transcript's other kinds of line
  assert.deepEqual(toolsInLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Edit', content: 'ok' }] } })), [])
  assert.deepEqual(toolsInLine(JSON.stringify({ type: 'system', subtype: 'x', content: 'y' })), [])
  assert.deepEqual(toolsInLine(JSON.stringify({ type: 'summary', summary: 'z', leafUuid: 'u' })), [])
  // Malformed: not JSON, a string content, a block without a name, a non-object input
  assert.deepEqual(toolsInLine('{"type":"assistant","message":{"content":[{"type":"tool_use"'), [])
  assert.deepEqual(toolsInLine(''), [])
  assert.deepEqual(toolsInLine(JSON.stringify({ type: 'assistant', message: { content: 'plain text' } })), [])
  assert.deepEqual(toolsInLine(JSON.stringify({ type: 'assistant' })), [])
  assert.deepEqual(toolsInLine(assistant({ type: 'tool_use', id: 't', input: {} }, null, use('Grep', 'pattern'))), [{ kind: 'read', label: '' }])
})
