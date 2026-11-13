// scripts/serverWinLaunch.test.mjs — starting agents on Windows without a shell: MSVC quoting,
// PATH × PATHEXT, npm shims, batch files. Pure (the env and files are given), so it runs on any
// OS; the last test spawns real processes and runs only on Windows (the windows-latest CI job).
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cmdEscapeArg,
  cmdEscapeCommand,
  MAX_COMMAND_LINE,
  parseCmdShim,
  parseWindowsCommandLine,
  quoteWindowsArg,
  resolveWindowsCommand,
  winSpawnPlan
} from '../server/src/sessions/winLaunch.ts'
import { sessionProcess, shellLaunch } from '../server/src/sessions/launch.ts'
import { commandBinary } from '../server/src/sessions/agents.ts'
import { launchSpec, quoted, raw, word } from '../src/shared/providers/shell.ts'
import { claude } from '../src/shared/providers/claude.ts'
import { windowsOnly } from './testPlatform.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/cmd-shim/${name}.cmd`, import.meta.url), 'utf8')

/** A file system of `paths` (case-insensitive, as NTFS) with optional contents. */
function files(paths) {
  const map = new Map(Object.entries(paths).map(([p, text]) => [p.toLowerCase(), text]))
  return {
    isFile: (p) => map.has(p.toLowerCase()),
    readFile: (p) => {
      const text = map.get(p.toLowerCase())
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return text
    }
  }
}

const ARGS = [
  'plain',
  '',
  'two words',
  'tab\there',
  'say "hi"',
  'C:\\dir\\',
  'C:\\dir with space\\',
  'a\\\\"b',
  '\\\\server\\share',
  'line one\nline two',
  '100% ^caret & | < > !bang',
  `it's`,
  'ünïcødé ✓ 🚀',
  '"',
  '\\',
  '\\"'
]

test('quoteWindowsArg round-trips through CommandLineToArgvW for every awkward argument', () => {
  const line = ['prog.exe', ...ARGS.map(quoteWindowsArg)].join(' ')
  assert.deepEqual(parseWindowsCommandLine(line), ['prog.exe', ...ARGS])
})

test('quoteWindowsArg leaves simple arguments alone and quotes the rest', () => {
  assert.equal(quoteWindowsArg('--model'), '--model')
  assert.equal(quoteWindowsArg('C:\\x\\y'), 'C:\\x\\y')
  assert.equal(quoteWindowsArg(''), '""')
  assert.equal(quoteWindowsArg('a b'), '"a b"')
  assert.equal(quoteWindowsArg('C:\\a b\\'), '"C:\\a b\\\\"')
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""')
})

test('parseWindowsCommandLine: the program keeps its backslashes; quotes group it', () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files\\Claude\\claude.exe" --verbose'), ['C:\\Program Files\\Claude\\claude.exe', '--verbose'])
  assert.deepEqual(parseWindowsCommandLine('  claude   a  '), ['claude', 'a'])
  assert.deepEqual(parseWindowsCommandLine('x "a""b"'), ['x', 'a"b'])
  assert.deepEqual(parseWindowsCommandLine(''), [])
})

const ENV = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\nodejs";C:\\Users\\u\\AppData\\Roaming\\npm;relative\\dir', PATHEXT: '.COM;.EXE;.BAT;.CMD' }

test('resolveWindowsCommand: PATH (any case) × PATHEXT in order; quoted dirs; never the current directory', () => {
  const fs = files({ 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd': '', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe': '', 'C:\\Program Files\\nodejs\\node.exe': '', 'C:\\repo\\claude.cmd': '' })
  const deps = { env: ENV, cwd: 'C:\\repo', ...fs }
  assert.equal(resolveWindowsCommand('claude', deps), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe', '.EXE before .CMD')
  assert.equal(resolveWindowsCommand('node', deps), 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(resolveWindowsCommand('claude.cmd', deps), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'an extension is taken as given')
  assert.equal(resolveWindowsCommand('nope', deps), undefined)
  assert.equal(resolveWindowsCommand('claude', { ...deps, env: { PATH: '' } }), undefined, 'the cwd (a repository) is never searched')
})

test('resolveWindowsCommand: a path, absolute or relative to the cwd, with PATHEXT tried', () => {
  const fs = files({ 'C:\\tools\\claude.exe': '', 'C:\\repo\\bin\\agent.bat': '' })
  const deps = { env: ENV, cwd: 'C:\\repo', ...fs }
  assert.equal(resolveWindowsCommand('C:\\tools\\claude', deps), 'C:\\tools\\claude.exe')
  assert.equal(resolveWindowsCommand('C:/tools/claude.exe', deps), 'C:\\tools\\claude.exe')
  assert.equal(resolveWindowsCommand('.\\bin\\agent', deps), 'C:\\repo\\bin\\agent.bat')
  assert.equal(resolveWindowsCommand('C:\\tools\\missing', deps), undefined)
})

test('parseCmdShim: npm shims for node scripts, with node arguments; nothing for other interpreters', () => {
  const at = 'C:\\Users\\u\\AppData\\Roaming\\npm\\bin\\claude.cmd'
  const none = () => false
  assert.deepEqual(parseCmdShim(fixture('claude'), at, none), {
    nodeArgs: [],
    script: 'C:\\Users\\u\\AppData\\Roaming\\npm\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  })
  assert.deepEqual(parseCmdShim(fixture('gemini'), at, none).nodeArgs, ['--no-warnings=DEP0040'])
  assert.match(parseCmdShim(fixture('codex'), at, none).script, /@openai\\codex\\bin\\codex\.js$/)
  assert.equal(parseCmdShim(fixture('shtool'), at, none), undefined, 'a #!/bin/sh script')
  assert.equal(parseCmdShim('@echo off\r\nmy-tool.exe %*\r\n', at, none), undefined, "the user's own batch file")
  const own = parseCmdShim(fixture('claude'), at, (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm\\bin\\node.exe')
  assert.equal(own.bundledNode, 'C:\\Users\\u\\AppData\\Roaming\\npm\\bin\\node.exe')
})

test('cmd escaping (cross-spawn): quote, then ^ before each metacharacter; twice for a shim', () => {
  assert.equal(cmdEscapeArg('plain', false), '^"plain^"')
  assert.equal(cmdEscapeArg('a b&c', false), '^"a^ b^&c^"')
  assert.equal(cmdEscapeArg('100%', true), '^^^"100^^^%^^^"')
  assert.equal(cmdEscapeArg('say "hi"', false), '^"say^ \\^"hi\\^"^"')
  assert.equal(cmdEscapeArg('C:\\dir\\', false), '^"C:\\dir\\\\^"')
  assert.equal(cmdEscapeCommand('C:\\My Tools (x86)\\a.cmd'), 'C:\\My^ Tools^ ^(x86^)\\a.cmd')
})

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'
const WIN_FILES = {
  'C:\\Program Files\\nodejs\\node.exe': '',
  [`${NPM}\\codex.cmd`]: fixture('codex').replaceAll('..\\lib\\node_modules', 'node_modules'),
  'C:\\tools\\claude.exe': '',
  'C:\\tools\\my-agent.bat': '@echo off\r\nreal-agent.exe %*\r\n',
  'C:\\tools\\plain.cmd': '@echo off\r\necho hi\r\n'
}
const winDeps = (extra = {}) => ({ env: { ...ENV, ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, cwd: 'C:\\repo', ...files({ ...WIN_FILES, ...extra }) })

test('winSpawnPlan: an .exe gets its arguments MSVC-quoted, multi-line prompt included', () => {
  const spec = claude.buildLaunch({ sessionId: 'id-1', resume: false, command: 'C:\\tools\\claude.exe', systemPrompt: 'a\nb "c"', initialMessage: '100% & done' })
  const plan = winSpawnPlan(spec, winDeps())
  assert.equal(plan.file, 'C:\\tools\\claude.exe')
  assert.deepEqual(parseWindowsCommandLine(`x ${plan.args}`).slice(1), [
    '--permission-mode', 'auto', '--append-system-prompt', 'a\nb "c"', '--session-id', 'id-1', '100% & done'
  ])
})

test('winSpawnPlan: an npm shim runs node with its script directly (no cmd.exe)', () => {
  const spec = launchSpec('codex', [word('--full-auto'), word('--'), quoted('line1\nline2')])
  const plan = winSpawnPlan(spec, winDeps())
  assert.equal(plan.file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual(parseWindowsCommandLine(`x ${plan.args}`).slice(1), [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, '--full-auto', '--', 'line1\nline2'])
})

test('winSpawnPlan: the head may carry its own arguments, and claudeArgs text is split', () => {
  const spec = launchSpec('"C:\\tools\\claude.exe" --debug', [raw('--permission-mode plan --add-dir "C:\\a b"')])
  const plan = winSpawnPlan(spec, winDeps())
  assert.deepEqual(parseWindowsCommandLine(`x ${plan.args}`).slice(1), ['--debug', '--permission-mode', 'plan', '--add-dir', 'C:\\a b'])
})

test('winSpawnPlan: another batch file runs under cmd.exe, escaped (twice when it passes %* on)', () => {
  const plan = winSpawnPlan(launchSpec('C:\\tools\\my-agent.bat', [quoted('a&b')]), winDeps())
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(plan.args, '/d /s /c "C:\\tools\\my-agent.bat ^^^"a^^^&b^^^""')
  const single = winSpawnPlan(launchSpec('C:\\tools\\plain.cmd', [quoted('a&b')]), winDeps())
  assert.equal(single.args, '/d /s /c "C:\\tools\\plain.cmd ^"a^&b^""')
})

test('winSpawnPlan: a shim without node on PATH falls back to cmd.exe', () => {
  const deps = winDeps()
  const noNode = { ...deps, isFile: (p) => !/node\.exe$/i.test(p) && deps.isFile(p) }
  assert.equal(winSpawnPlan(launchSpec('codex', [word('--full-auto')]), noNode).file, 'C:\\Windows\\system32\\cmd.exe')
})

test('winSpawnPlan refuses: a multi-line argument to a batch file, an env prefix, a missing program, an over-long line', () => {
  assert.throws(() => winSpawnPlan(launchSpec('C:\\tools\\plain.cmd', [quoted('a\nb')]), winDeps()), /is a batch file \(plain\.cmd\), which can't receive multi-line arguments/)
  assert.throws(() => winSpawnPlan(launchSpec('API_KEY=x claude', []), winDeps()), /Env prefixes \(API_KEY=…\) aren't supported on Windows/)
  assert.throws(() => winSpawnPlan(launchSpec('gemini', []), winDeps()), /`gemini` not found on PATH/)
  assert.throws(() => winSpawnPlan(launchSpec('C:\\tools\\claude.exe', [quoted('x'.repeat(MAX_COMMAND_LINE))]), winDeps()), /over Windows' limit of 32767/)
})

test('sessionProcess: POSIX keeps the login shell; Windows refusals are BAD_REQUEST', () => {
  const spec = launchSpec('claude', [word('--session-id'), word('x')])
  assert.deepEqual(sessionProcess(spec, '/w', 'linux', { SHELL: '/bin/zsh' }), shellLaunch(spec.command, 'linux', { SHELL: '/bin/zsh' }))
  assert.throws(
    () => sessionProcess(launchSpec('gemini', []), 'C:\\repo', 'win32', ENV, files(WIN_FILES)),
    (err) => err.code === 'BAD_REQUEST' && /not found on PATH/.test(err.message)
  )
  assert.deepEqual(sessionProcess(launchSpec('C:\\tools\\claude.exe', []), 'C:\\repo', 'win32', ENV, files(WIN_FILES)), { file: 'C:\\tools\\claude.exe', args: '' })
})

test('commandBinary on Windows reads the program as CreateProcess does', () => {
  assert.equal(commandBinary('"C:\\Program Files\\Claude\\claude.exe" --x', 'win32'), 'C:\\Program Files\\Claude\\claude.exe')
  assert.equal(commandBinary('claude', 'win32'), 'claude')
  assert.equal(commandBinary('FOO=1 claude', 'linux'), 'claude')
})

// --- Windows only (the windows-latest CI job): real ConPTY spawns, argv as the program sees it ---

test('Windows: an .exe, an npm shim and a batch file each receive their argv intact', { skip: windowsOnly('ConPTY spawns') }, async (t) => {
  const { TerminalHost } = await import('../server/src/sessions/terminalHost.ts')
  const dir = mkdtempSync(join(tmpdir(), 'trek-winlaunch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The "agent": prints its argv as JSON between markers.
  const script = join(dir, 'print-argv.js')
  writeFileSync(script, "process.stdout.write('ARGV' + JSON.stringify(process.argv.slice(2)) + 'END')\n")
  // fake-agent.exe: node itself, whose first argument is the script.
  copyFileSync(process.execPath, join(dir, 'fake-agent.exe'))
  // An npm shim (its node_modules layout) for the script.
  writeFileSync(join(dir, 'shimmed.cmd'), fixture('claude').replace('..\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 'print-argv.js'))
  writeFileSync(join(dir, 'plain.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0print-argv.js" %*\r\n`)
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` }
  const tricky = ['two words', 'say "hi"', '100% & | ^', 'C:\\dir\\', '']
  const run = async (head, args) => {
    const plan = sessionProcess(launchSpec(head, args.map((a) => quoted(a))), dir, 'win32', env)
    let out = ''
    let exited
    const done = new Promise((r) => (exited = r))
    const host = new TerminalHost({ onExit: () => exited() })
    host.spawn('p', { ...plan, cwd: dir, env: {}, cols: 200, rows: 50 })
    host.attach('p', { send: (event, payload) => event === 'pty.data' && (out += payload.data), bufferedAmount: () => 0 })
    await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))])
    host.disposeAll()
    const m = /ARGV(.*?)END/s.exec(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, ''))
    return m ? JSON.parse(m[1]) : out
  }
  assert.deepEqual(await run(`fake-agent.exe "${script}"`, [...tricky, 'a\nb']), [...tricky, 'a\nb'])
  assert.deepEqual(await run('shimmed', [...tricky, 'a\nb']), [...tricky, 'a\nb'])
  assert.deepEqual(await run('plain', tricky), tricky)
})
