// scripts/botMcpGate.test.mjs — the bot's gate on Trek's MCP server (mcpRpc), and the handlers
// that answer it (mcpHandlers), against a real BotRunner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateBotCall, handleBody, handleMessage } from '../src/main/mcpRpc.ts'
import { botMcpHandlers } from '../src/host/bot/mcpHandlers.ts'
import { BotRunner } from '../src/host/bot/runner.ts'
import { createBotFolder, loadState, saveState } from '../src/host/bot/memory.ts'
import { BOT_MCP_SERVER, TREK_TOOL_PREFIX } from '../src/host/bot/turnProcess.ts'

const BOT = { windowId: 1, bot: true }
const SESSION = { windowId: 1, bot: false }
const TOOLS = [{ name: 'list_worktrees' }, { name: 'close_session' }, { name: 'send_prompt' }]
const BOT_TOOLS = [{ name: 'request_approval' }]

/** Handlers that record what they were asked, answering with `toolCall`. */
const recording = (toolCall = () => ({ allowed: true, reason: 'ok' })) => {
  const asked = []
  return {
    asked,
    handlers: {
      policy: () => ({}),
      toolCall: (windowId, name, args) => {
        asked.push(['toolCall', name, args])
        return toolCall(windowId, name, args)
      },
      requestApproval: (windowId, args) => {
        asked.push(['requestApproval', args])
        return 'queued'
      }
    }
  }
}

/** RPC deps whose renderer records each call that reached it. */
const depsWith = (handlers) => {
  const ran = []
  return {
    ran,
    deps: {
      tools: TOOLS,
      botTools: BOT_TOOLS,
      handlers,
      serverInfo: { name: 'trek-dev', version: '0' },
      instructions: 'i',
      supportedVersions: ['2025-06-18'],
      callRenderer: async (name, args) => {
        ran.push([name, args])
        return { ok: true, result: { name } }
      }
    }
  }
}
const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

test('the gate refuses when the handlers throw, are missing, or answer anything but allowed', () => {
  const throwing = recording(() => {
    throw new Error('policy broke')
  }).handlers
  assert.deepEqual(gateBotCall(throwing, BOT, 'list_worktrees', {}), { text: 'Error: policy broke', isError: true })
  assert.deepEqual(gateBotCall(null, BOT, 'list_worktrees', {}), { text: 'The bot is not running', isError: true })
  for (const answer of [undefined, null, {}, { allowed: 'yes', reason: 'r' }, { allowed: false, reason: 'no' }]) {
    const gated = gateBotCall(recording(() => answer).handlers, BOT, 'list_worktrees', {})
    assert.equal(gated?.isError, true, JSON.stringify(answer))
  }
  assert.equal(gateBotCall(recording().handlers, BOT, 'list_worktrees', {}), null, 'allowed goes on')
})

test('a session token is never gated, by design: its sessions run outside the bot', () => {
  const { asked, handlers } = recording(() => ({ allowed: false, reason: 'no' }))
  assert.equal(gateBotCall(handlers, SESSION, 'send_prompt', {}), null)
  assert.equal(gateBotCall(null, SESSION, 'send_prompt', {}), null)
  assert.deepEqual(asked, [])
})

test('an unknown tool is -32602 and consumes nothing', async () => {
  const { asked, handlers } = recording()
  const { ran, deps } = depsWith(handlers)
  for (const client of [BOT, SESSION]) {
    const reply = await handleMessage(call('cat_secrets', {}), client, deps)
    assert.equal(reply.error.code, -32602)
  }
  // request_approval is a bot tool: a session token doesn't know it.
  assert.equal((await handleMessage(call('request_approval', {}), SESSION, deps)).error.code, -32602)
  assert.deepEqual([asked, ran], [[], []])
})

test('arguments that are not a plain object are -32602 and consume nothing', async () => {
  const { asked, handlers } = recording()
  const { ran, deps } = depsWith(handlers)
  for (const args of [[], 'x', 5, true, null, [{ terminalId: 't' }]]) {
    const reply = await handleMessage(call('list_worktrees', args), BOT, deps)
    if (args === null) {
      // `arguments: null` is the same as leaving them out.
      assert.equal(reply.result.isError, false)
      continue
    }
    assert.equal(reply.error?.code, -32602, JSON.stringify(args))
    assert.match(reply.error.message, /must be an object/)
  }
  assert.deepEqual(asked, [['toolCall', 'list_worktrees', {}]])
  assert.deepEqual(ran, [['list_worktrees', {}]])
})

test('a notification-form tools/call runs nothing and gets no reply', async () => {
  const { asked, handlers } = recording()
  const { ran, deps } = depsWith(handlers)
  for (const id of [undefined, null]) {
    const msg = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method: 'tools/call', params: { name: 'list_worktrees', arguments: {} } }
    assert.equal(await handleMessage(msg, BOT, deps), null)
    assert.equal(await handleBody([msg, msg], BOT, deps), null)
  }
  assert.deepEqual([asked, ran], [[], []])
})

/** A runner with a fake turn that stays open until `end` is called. */
function runnerWith({ approved } = {}) {
  const folder = join(mkdtempSync(join(tmpdir(), 'bot-gate-')), 'G.trekbot')
  createBotFolder(folder)
  if (approved) {
    const state = loadState(folder)
    saveState(folder, {
      ...state,
      approvals: [{ id: 'a1', tool: approved.tool, input: approved.input, reason: 'r', requestedAt: 1, status: 'approved' }]
    })
  }
  let resolve = null
  const runner = new BotRunner({
    folder,
    secretPaths: [],
    now: () => new Date(2026, 10, 7, 9, 0).getTime(),
    newSessionId: () => 's1',
    snapshot: async () => ({ worktrees: [], sessions: [] }),
    runTurn: () => ({ done: new Promise((r) => (resolve = r)), kill: () => resolve?.({ kind: 'killed', text: 'stopped' }) }),
    onView: () => {},
    onEvent: () => {},
    onFolderMissing: () => {}
  })
  const handlers = botMcpHandlers((windowId) => (windowId === 1 ? runner : undefined))
  return {
    runner,
    folder,
    handlers,
    inTurn: async () => {
      runner.start()
      runner.send('go')
      for (let i = 0; i < 100 && !resolve; i++) await new Promise((r) => setImmediate(r))
      assert.ok(resolve, 'a turn started')
    },
    end: async () => {
      resolve({ kind: 'ok', text: 'done' })
      await runner.idle()
    }
  }
}

test('request_approval outside a turn is refused, and queues nothing', async () => {
  const bot = runnerWith()
  const args = { tool: 'Bash', input: { command: 'git push' }, reason: 'r' }
  const gated = gateBotCall(bot.handlers, BOT, 'request_approval', args, BOT_TOOLS)
  assert.deepEqual(gated, { text: 'No bot turn is running.', isError: true })
  assert.deepEqual(loadState(bot.folder).approvals, [])
  // And a window with no bot at all.
  assert.equal(gateBotCall(bot.handlers, { windowId: 2, bot: true }, 'request_approval', args, BOT_TOOLS).isError, true)
})

test('request_approval in a turn queues the request', async (t) => {
  const bot = runnerWith()
  t.after(() => bot.runner.stop())
  await bot.inTurn()
  const gated = gateBotCall(bot.handlers, BOT, 'request_approval', { tool: 'Bash', input: { command: 'git push' }, reason: 'r' }, BOT_TOOLS)
  assert.equal(gated.isError, false)
  assert.match(gated.text, /^Requested approval /)
  assert.equal(loadState(bot.folder).approvals.length, 1)
  await bot.end()
})

test('a batch of two identical approved calls runs one and refuses the other', async (t) => {
  const input = { terminalId: 't1', prompt: 'run the tests' }
  const bot = runnerWith({ approved: { tool: `${TREK_TOOL_PREFIX}send_prompt`, input } })
  t.after(() => bot.runner.stop())
  await bot.inTurn()
  const { ran, deps } = depsWith(bot.handlers)
  const replies = await handleBody([call('send_prompt', input, 1), call('send_prompt', input, 2)], BOT, deps)
  assert.deepEqual(replies.map((r) => [r.id, r.result.isError]), [[1, false], [2, true]])
  assert.match(replies[1].result.content[0].text, /Needs approval/)
  assert.deepEqual(ran, [['send_prompt', input]])
  assert.deepEqual(loadState(bot.folder).approvals, [])
  await bot.end()
})

test('the hook leaves Trek tools to the server without spending an approval; other tools are checked', async (t) => {
  const input = { terminalId: 't1', prompt: 'x' }
  const bot = runnerWith({ approved: { tool: `${TREK_TOOL_PREFIX}send_prompt`, input } })
  t.after(() => bot.runner.stop())
  await bot.inTurn()
  const decision = (hook) => bot.handlers.policy(1, hook).hookSpecificOutput.permissionDecision
  assert.equal(decision({ tool_name: `${TREK_TOOL_PREFIX}send_prompt`, tool_input: input }), 'allow')
  assert.equal(decision({ tool_name: `${TREK_TOOL_PREFIX}x`, tool_input: {} }), 'allow')
  assert.equal(loadState(bot.folder).approvals.length, 1, 'the approval is still there for the call itself')
  // Not Trek's prefix: the policy runs.
  assert.equal(decision({ tool_name: 'mcp__other__send_prompt', tool_input: input }), 'deny')
  assert.equal(decision({ tool_name: 'mcp__trek-dev_send_prompt', tool_input: input }), 'deny')
  assert.equal(decision({ tool_name: 'Bash', tool_input: { command: 'git push origin x' } }), 'deny')
  assert.equal(decision({ tool_name: 'Read', tool_input: { file_path: join(bot.folder, 'BOT.md') } }), 'allow')
  assert.equal(TREK_TOOL_PREFIX, `mcp__${BOT_MCP_SERVER}__`)
  await bot.end()
})

test('with no bot for the window, the hook denies and every call is refused', () => {
  const handlers = botMcpHandlers(() => undefined)
  assert.equal(handlers.policy(1, { tool_name: 'Read', tool_input: {} }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(gateBotCall(handlers, BOT, 'list_worktrees', {}).isError, true)
  assert.throws(() => handlers.requestApproval(1, { tool: 'Bash', input: {}, reason: 'r' }), /not running/)
})

test('tools/list offers request_approval to bot tokens only', async () => {
  const { deps } = depsWith(null)
  const names = async (client) => (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, client, deps)).result.tools.map((t) => t.name)
  assert.equal((await names(BOT)).includes('request_approval'), true)
  assert.equal((await names(SESSION)).includes('request_approval'), false)
})
