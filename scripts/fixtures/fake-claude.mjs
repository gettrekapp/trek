#!/usr/bin/env node
// Stands in for the Claude CLI in tests. The prompt picks the behaviour.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString('utf8')
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

if (prompt.includes('HANG')) {
  say('hanging')
  setInterval(() => {}, 1000)
} else if (prompt.includes('HOLD')) {
  say('holding')
  await new Promise((done) => setTimeout(done, 2500))
  finish()
} else if (prompt.includes('CRASH')) {
  console.error('boom')
  process.exit(3)
} else if (prompt.includes('AUTHFAIL')) {
  finish('Not logged in · Please run /login', true)
} else if (prompt.includes('LIMITED')) {
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
  finish("You've hit your limit", true)
} else if (prompt.includes('ASKME')) {
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
} else if (prompt.includes('approved')) {
  say(`policy:${await askPolicy('git push origin smoke')}`)
  say(`second:${await askPolicy('git push origin smoke')}`)
  finish()
} else if (prompt.includes('PROMPTSIZE')) {
  say(`size:${prompt.length}`)
  finish()
} else if (prompt.includes('GRANDCHILDREN')) {
  const idle = 'setTimeout(() => {}, 20000)'
  descendant(idle, false)
  descendant(idle, true)
  finish()
  process.exit(0)
} else if (prompt.includes('STUBBORN')) {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ready' }] } })
  descendant(`process.on('SIGTERM', () => {}); console.log(${JSON.stringify(line)}); setTimeout(() => {}, 20000)`, false)
  setInterval(() => {}, 1000)
} else if (prompt.includes('NONEWLINE')) {
  finish()
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'last' }] } }))
} else if (prompt.includes('SPLITEMOJI')) {
  const bytes = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a😀b' }] } })}\n`)
  const cut = bytes.indexOf(Buffer.from('😀')) + 2
  process.stdout.write(bytes.subarray(0, cut))
  await new Promise((done) => setTimeout(done, 100))
  process.stdout.write(bytes.subarray(cut))
  finish()
} else if (prompt.includes('OVERLONG')) {
  const block = Buffer.alloc(1024 * 1024, 'x')
  for (let i = 0; i < 65; i++) process.stdout.write(block)
  process.stdout.write('\n')
  say('after')
  finish()
} else {
  say(`echo:${prompt.split('\n').filter((line) => !line.startsWith('</wake-')).at(-1)}`)
  finish()
}
