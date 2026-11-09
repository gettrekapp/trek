// scripts/staleMcpConfigRules.test.mjs — the userData files the deleted desktop MCP server left.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isStaleMcpConfig } from '../src/main/staleMcpConfigRules.ts'

test('isStaleMcpConfig matches the per-window and global MCP configs mcp.ts wrote', () => {
  for (const name of ['mcp-1.json', 'mcp-42.json', 'mcp-gemini-7.json', 'mcp-codex-123.json', 'mcp-bot-3.json', 'global-claude-mcp.json']) {
    assert.equal(isStaleMcpConfig(name), true, name)
  }
})

test('isStaleMcpConfig leaves every other userData file alone', () => {
  for (const name of [
    'open-windows.json',
    'recent-projects.json',
    'server-tokens.json',
    'mcp.json',
    'mcp-.json',
    'mcp-x.json',
    'mcp-1.json.bak',
    'mcp-1.jsonx',
    'xmcp-1.json',
    'mcp-gemini-.json',
    'mcp-other-1.json',
    'mcp-codex-1-2.json',
    'global-claude-mcp.json.tmp',
    'Global-claude-mcp.json',
    '../mcp-1.json',
    'dir/mcp-1.json'
  ]) {
    assert.equal(isStaleMcpConfig(name), false, name)
  }
})
