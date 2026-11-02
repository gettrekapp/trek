#!/usr/bin/env node
// Stands in for the Claude CLI in tests. The wake text picks the behaviour, or the whole prompt if it has no wake tags.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString('utf8')
// Only the wake, so that mode words in the journal, notes or date can't pick a behaviour.
const wake = /<wake-[0-9a-f]+>\n([\s\S]*)\n<\/wake-[0-9a-f]+>\s*$/.exec(prompt)?.[1] ?? prompt
const sessionId = arg('--resume') ?? arg('--session-id') ?? 'none'
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(argv)}\n`)

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const say = (text) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const finish = (text = 'done', isError = false) =>
  emit({ type: 'result', is_error: isError, result: text, session_id: sessionId })

if (arg('--resume') === 'bad') {
  console.error(`No conversation found with session ID: ${sessionId}`)
  emit({ type: 'result', is_error: true, session_id: sessionId })
  process.exit(1)
}

emit({ type: 'system', subtype: 'init', session_id: sessionId })

const mcp = () => Object.values(JSON.parse(readFileSync(arg('--mcp-config'), 'utf8')).mcpServers)[0]
const askPolicy = async (command) => {
  const server = mcp()
  const res = await fetch(server.url.replace('/mcp', '/bot/policy'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TREK_BOT_TOKEN}` },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  })
  return (await res.json()).hookSpecificOutput.permissionDecision
}

/** Starts a descendant holding this process's stdout, and records its pid for the test to clean up. */
const descendant = (code, detached) => {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'], detached })
  appendFileSync(process.env.FAKE_CLAUDE_PIDS, `${child.pid}\n`)
  child.unref()
}

if (wake.includes('HANG')) {
  if (process.env.FAKE_CLAUDE_PID_FILE) writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid))
  say('hanging')
  setInterval(() => {}, 1000)
} else if (wake.includes('HOLD')) {
  say('holding')
  await new Promise((done) => setTimeout(done, 2500))
  finish()
} else if (wake.includes('CRASH')) {
  console.error('boom')
  process.exit(3)
} else if (wake.includes('AUTHFAIL')) {
  finish('Not logged in · Please run /login', true)
} else if (wake.includes('LIMITED')) {
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
  finish("You've hit your limit", true)
} else if (wake.includes('ASKME')) {
  say(`policy:${await askPolicy('git push origin smoke')}`)
  const server = mcp()
  await fetch(server.url, {
    method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_approval',
        arguments: { tool: 'Bash', input: { command: 'git push origin smoke' }, reason: 'smoke test' }
      }
    })
  })
  finish()
} else if (wake.startsWith('An approval request has an answer. The user approved this exact call')) {
  // Worded by BotRunner.wakeForTurn and wakePrompt in src/host/bot.
  say(`policy:${await askPolicy('git push origin smoke')}`)
  say(`second:${await askPolicy('git push origin smoke')}`)
  finish()
} else if (wake.includes('PROMPTSIZE')) {
  say(`size:${prompt.length}`)
  finish()
} else if (wake.includes('GRANDCHILDREN')) {
  const idle = 'setTimeout(() => {}, 20000)'
  descendant(idle, false)
  descendant(idle, true)
  finish()
  process.exit(0)
} else if (wake.includes('STUBBORN')) {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ready' }] } })
  descendant(`process.on('SIGTERM', () => {}); console.log(${JSON.stringify(line)}); setTimeout(() => {}, 20000)`, false)
  setInterval(() => {}, 1000)
} else if (wake.includes('NONEWLINE')) {
  finish()
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'last' }] } }))
} else if (wake.includes('SPLITEMOJI')) {
  const bytes = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a😀b' }] } })}\n`)
  const cut = bytes.indexOf(Buffer.from('😀')) + 2
  process.stdout.write(bytes.subarray(0, cut))
  await new Promise((done) => setTimeout(done, 100))
  process.stdout.write(bytes.subarray(cut))
  finish()
} else if (wake.includes('OVERLONG')) {
  const block = Buffer.alloc(1024 * 1024, 'x')
  for (let i = 0; i < 65; i++) process.stdout.write(block)
  process.stdout.write('\n')
  say('after')
  finish()
} else {
  say(`echo:${wake.split('\n').at(-1)}`)
  finish()
}
