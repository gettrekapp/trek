// scripts/botHook.test.mjs — the bot's PreToolUse hook command, run by sh as the CLI runs it: the
// token reaches curl on stdin, never in argv, and the hook fails closed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botPolicyHook } from '../src/host/bot/turnProcess.ts'

const TOKEN = 'a'.repeat(32) + 'f00d'.repeat(8)
const skip = process.platform === 'win32' && 'POSIX sh only'
const INPUT = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } })

/** Runs the hook with sh, as the CLI does, with `bin` first on PATH. */
const runHook = (port, { bin, token = TOKEN } = {}) =>
  spawnSync('/bin/sh', ['-c', botPolicyHook(port)], {
    input: INPUT,
    encoding: 'utf8',
    env: { PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH, TREK_BOT_TOKEN: token }
  })

test('the token goes to curl on stdin, never in its argv', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-hook-'))
  // A curl stand-in that records its argv and stdin, then answers as Trek would.
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/argv"\ncat > "${dir}/stdin"\ncat /dev/fd/3 > "${dir}/body" 2>/dev/null\necho '{"ok":true}'\n`
  )
  chmodSync(join(dir, 'curl'), 0o755)
  const ran = runHook(4711, { bin: dir })
  assert.equal(ran.status, 0, ran.stderr)
  const argv = readFileSync(join(dir, 'argv'), 'utf8')
  assert.ok(!argv.includes(TOKEN), argv)
  assert.ok(!argv.includes('Bearer'), argv)
  assert.match(argv, /^-H\n@-$/m)
  assert.match(argv, /^http:\/\/127\.0\.0\.1:4711\/bot\/policy$/m)
  assert.equal(readFileSync(join(dir, 'stdin'), 'utf8'), `Authorization: Bearer ${TOKEN}\n`)
  assert.equal(readFileSync(join(dir, 'body'), 'utf8'), INPUT)
  // The command text names only the variable: the CLI's own argv and settings carry no token.
  assert.ok(!botPolicyHook(4711).includes(TOKEN))
})

test('with the real curl: the server gets the header and the hook input; a dead server blocks the tool', { skip }, async () => {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body, url: req.url })
      res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, { 'Content-Type': 'application/json' })
      res.end('{"hookSpecificOutput":{"permissionDecision":"allow"}}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    // spawnSync would block the server's event loop, so run the hook asynchronously.
    const { spawn } = await import('node:child_process')
    const hook = (token) =>
      new Promise((done) => {
        const child = spawn('/bin/sh', ['-c', botPolicyHook(port)], { env: { PATH: process.env.PATH, TREK_BOT_TOKEN: token } })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', (status) => done({ status, out }))
        child.stdin.end(INPUT)
      })
    const good = await hook(TOKEN)
    assert.deepEqual([good.status, JSON.parse(good.out).hookSpecificOutput.permissionDecision], [0, 'allow'])
    assert.deepEqual(seen[0], { auth: `Bearer ${TOKEN}`, body: INPUT, url: '/bot/policy' })
    assert.equal((await hook('nonsense')).status, 2, 'a refused token blocks the tool')
  } finally {
    await new Promise((r) => server.close(r))
  }
  assert.equal(runHook(1).status, 2, 'no server blocks the tool')
})
