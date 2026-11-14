// scripts/serverLaunchers.test.mjs — the text of the Windows launchers in the trek-server zip, and
// the POSIX launcher of the tarballs, run with sh in temp folders against a stand-in for node.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { POSIX_LAUNCHER, WIN_LAUNCHER, WIN_PS_LAUNCHER } from './serverLaunchers.mjs'
import { posixOnly, removeDir } from './testPlatform.mjs'
import { VALUE_FLAGS } from '../server/src/cli.ts'

test('the PowerShell launcher has CRLF line endings only', () => {
  assert.ok(WIN_PS_LAUNCHER.endsWith('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(WIN_PS_LAUNCHER), 'a bare LF')
  assert.ok(!/\r(?!\n)/.test(WIN_PS_LAUNCHER), 'a bare CR')
})

test('the PowerShell launcher checks for Node >= 22 with the .cmd launcher wording', () => {
  assert.match(WIN_PS_LAUNCHER, /\$major -lt 22/)
  assert.match(WIN_PS_LAUNCHER, /trek-server: Node\.js 22 or later is needed, and .*was not found \(set TREK_NODE to a node binary\)/)
  assert.match(WIN_PS_LAUNCHER, /trek-server: Node\.js 22 or later is needed; .* is version \$major/)
  assert.match(WIN_PS_LAUNCHER, /exit 127/)
  assert.match(WIN_LAUNCHER, /trek-server: Node\.js 22 or later is needed, and/)
})

test('the PowerShell launcher runs trek-server.cjs beside bin with the arguments and node\'s exit code', () => {
  assert.match(WIN_PS_LAUNCHER, /\$PSScriptRoot/)
  assert.match(WIN_PS_LAUNCHER, /\.\.\\trek-server\.cjs/)
  assert.match(WIN_PS_LAUNCHER, /& \$node .*@args/)
  assert.match(WIN_PS_LAUNCHER, /exit \$LASTEXITCODE\r\n$/)
})

test('the batch launcher keeps CRLF line endings', () => {
  assert.ok(!/(?<!\r)\n/.test(WIN_LAUNCHER))
})

test('the batch launcher has no for /f, and no parenthesis outside quotes or a rem on a command line', () => {
  // `for /f … in ('"node" -p "parseInt(…)"')` ended at that ")": the zip's launcher failed to parse.
  assert.doesNotMatch(WIN_LAUNCHER, /\bfor\s+\/f\b/i)
  for (const line of WIN_LAUNCHER.split('\r\n')) {
    if (/^(rem |echo )/.test(line)) continue
    const outside = line.replace(/"[^"]*"/g, '')
    assert.doesNotMatch(outside, /[()]/, line)
  }
})

test('the batch launcher: node checks its own version, 42 is too old, anything else is not found', () => {
  assert.match(WIN_LAUNCHER, /"%node%" -e "process\.exit\(parseInt\(process\.versions\.node\)>=22\?0:42\)" 2>nul\r\nif errorlevel 43 goto missing\r\nif errorlevel 42 goto old\r\nif errorlevel 1 goto missing\r\n/)
  assert.match(WIN_LAUNCHER, /:missing\r\necho trek-server: Node\.js 22 or later is needed, and "%node%" was not found .*1>&2\r\nexit \/b 127\r\n/)
  assert.match(WIN_LAUNCHER, /:old\r\n.*Node\.js 22 or later is needed; .* is version .*\r\nexit \/b 1\r\n/)
  assert.match(WIN_LAUNCHER, /"%node%" "%~dp0\.\.\\trek-server\.cjs" %\*\r\nexit \/b %errorlevel%\r\n/)
})

// The POSIX launcher: what runs before any of a version's JavaScript, so where an update that
// cannot start is caught.

const posix = { skip: posixOnly('the launcher is a POSIX sh script') }
const DASH = ['/bin/dash', '/usr/bin/dash'].find((p) => existsSync(p))

/** An install folder with the launcher, a label, and a stand-in for node that prints the label and its arguments. */
function install(root, name, label) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'trek-server'), POSIX_LAUNCHER, { mode: 0o755 })
  writeFileSync(join(dir, 'label'), label)
  return dir
}
function fakeNode(root) {
  const node = join(root, 'fake-node')
  // `-p …` is the launcher asking for Node's major version; anything else is the server being run.
  // Each argument also goes to <root>/args, one a line: what `$*` would blur.
  writeFileSync(
    node,
    '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22; exit 0; fi\ncjs=$1; shift\necho "RAN $(cat "$(dirname "$cjs")/label") $*"\necho $$ > "$(dirname "$0")/pid"\n: > "$(dirname "$0")/args"\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$(dirname "$0")/args"; done\n',
    { mode: 0o755 }
  )
  return node
}
/** Runs the install's launcher (through `shell`, when one is named, rather than its #!/bin/sh). */
function run(dir, node, args, { shell, path = process.env.PATH, cwd } = {}) {
  const launcher = join(dir, 'bin', 'trek-server')
  const r = spawnSync(shell ?? launcher, shell ? [launcher, ...args] : args, { env: { PATH: path, TREK_NODE: node }, encoding: 'utf8', cwd })
  return { out: r.stdout.trim(), err: r.stderr, status: r.status }
}
const pending = (dir) => writeFileSync(join(dir, 'update-pending.json'), '{"from":"1.0.0","to":"2.0.0","at":"2026-11-14T10:00:00.000Z"}\n')
const tried = (dir) => existsSync(join(dir, 'update-pending.tried'))
const world = (prefix = 'trek-launcher-') => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, node: fakeNode(root), done: () => removeDir(root) }
}

test('the POSIX launcher runs the server with its arguments, and is plain sh', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'one')
    assert.deepEqual(run(dir, w.node, ['start', '--port', '9']), { out: 'RAN one start --port 9', err: '', status: 0 })
    assert.deepEqual(run(dir, w.node, []), { out: 'RAN one', err: '', status: 0 }, 'no arguments at all')
    assert.equal(tried(dir), false, 'no update pending: nothing is marked')
    execFileSync('sh', ['-n', join(dir, 'bin', 'trek-server')])
  } finally {
    w.done()
  }
})

test('the first start after an update marks it tried and runs the new version', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    assert.deepEqual(run(dir, w.node, ['start']), { out: 'RAN two start', err: '', status: 0 })
    assert.equal(tried(dir), true)
    // exec keeps the process id: the launcher's is the server's.
    assert.equal(readFileSync(join(dir, 'update-pending.tried'), 'utf8'), readFileSync(join(w.root, 'pid'), 'utf8'), 'the mark holds the id of the process that started')
    assert.equal(existsSync(join(w.root, 'trek-server.previous')), true)
  } finally {
    w.done()
  }
})

test('a second start that still finds the marker puts the previous version back and starts it', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    run(dir, w.node, [])
    const second = run(dir, w.node, ['--port', '9'])
    assert.equal(second.out, 'RAN one --port 9', second.err)
    assert.equal(second.status, 0)
    assert.match(second.err, /did not start.*going back/)
    assert.equal(readFileSync(join(dir, 'label'), 'utf8'), 'one', 'the install path holds the previous version again')
    assert.equal(readFileSync(join(w.root, 'trek-server.failed', 'label'), 'utf8'), 'two')
    assert.equal(existsSync(join(w.root, 'trek-server.previous')), false)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'update-rolled-back.json'), 'utf8')), { from: '1.0.0', to: '2.0.0', at: '2026-11-14T10:00:00.000Z' })
    assert.equal(existsSync(join(dir, 'update-pending.json')), false, 'the restored version has no pending update')
    // And a third start is an ordinary one.
    assert.deepEqual(run(dir, w.node, ['start']), { out: 'RAN one start', err: '', status: 0 })
  } finally {
    w.done()
  }
})

test('a version that failed before (<install>.failed) is replaced by the one that failed now', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    install(w.root, 'trek-server.failed', 'zero')
    pending(dir)
    run(dir, w.node, ['start'])
    assert.equal(run(dir, w.node, ['start']).out, 'RAN one start')
    assert.equal(readFileSync(join(w.root, 'trek-server.failed', 'label'), 'utf8'), 'two')
    assert.equal(existsSync(join(w.root, 'trek-server.failed', 'bin', 'bin')), false, 'replaced, not moved inside the old one')
  } finally {
    w.done()
  }
})

test('only a start counts: other commands neither mark the update tried nor roll it back', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    for (const args of [['version'], ['token', 'list'], ['--config', '/x/config.json', 'update', '--check'], ['selfcheck'], ['-h'], ['start', '--help'], ['--version'], ['start', '-v'], ['.'], ['--web', 'stop'], ['start', '--local'], ['--local'], ['--local-profile', 'dev', '--local', 'start']]) {
      assert.equal(run(dir, w.node, args).out, `RAN two ${args.join(' ')}`)
      assert.equal(tried(dir), false, args.join(' '))
    }
    // Marked tried by a start, then: still no rollback for anything but a start.
    run(dir, w.node, ['start'])
    assert.equal(run(dir, w.node, ['version']).out, 'RAN two version')
    assert.equal(readFileSync(join(dir, 'label'), 'utf8'), 'two')
  } finally {
    w.done()
  }
})

test('start is the default command, whatever flags come first; every flag that takes a value is skipped with it', posix, () => {
  for (const flag of VALUE_FLAGS) {
    const w = world()
    try {
      const dir = install(w.root, 'trek-server', 'two')
      pending(dir)
      // The value is a word that would otherwise be read as a command.
      run(dir, w.node, [flag, 'token', '--web'])
      assert.equal(tried(dir), true, `${flag} token --web is a start`)
    } finally {
      w.done()
    }
  }
  // The launcher's list is cli.ts's, no more and no less (its `case` arm, not a mention in a comment).
  const arm = /^ *(--[a-z-]+(?:\|--[a-z-]+)*)\) skip=1 ;;$/m.exec(POSIX_LAUNCHER)
  assert.ok(arm, 'the case arm that skips a value')
  assert.deepEqual(arm[1].split('|').sort(), [...VALUE_FLAGS].sort(), 'the launcher lists every flag that takes a value')
})

test('a value flag with nothing after it, or as the last word, is still a start', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    pending(dir)
    assert.equal(run(dir, w.node, ['--web', '--port']).out, 'RAN two --web --port')
    assert.equal(tried(dir), true)
  } finally {
    w.done()
  }
})

test('with no previous version to go back to, the new one is started again, and says so', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    pending(dir)
    run(dir, w.node, ['start'])
    const again = run(dir, w.node, ['start'])
    assert.equal(again.out, 'RAN two start')
    assert.equal(again.status, 0)
    assert.match(again.err, /previous is gone/)
  } finally {
    w.done()
  }
})

test('the launcher still works through a symlink, and rolls back the folder it points into', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    const bin = join(w.root, 'bin')
    mkdirSync(bin)
    symlinkSync(join(dir, 'bin', 'trek-server'), join(bin, 'trek-server'))
    const viaLink = (args) => spawnSync(join(bin, 'trek-server'), args, { env: { PATH: process.env.PATH, TREK_NODE: w.node }, encoding: 'utf8' }).stdout.trim()
    assert.equal(viaLink(['start']), 'RAN two start')
    assert.equal(viaLink(['start']), 'RAN one start')
  } finally {
    w.done()
  }
})

test('an install folder that cannot be written to still starts: the update is just never marked tried', posix, (t) => {
  if (process.getuid() === 0) return t.skip('root writes to a read-only folder')
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    chmodSync(dir, 0o555)
    try {
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(run(dir, w.node, ['start']), { out: 'RAN two start', err: '', status: 0 })
        assert.equal(tried(dir), false)
      }
    } finally {
      chmodSync(dir, 0o755)
    }
  } finally {
    w.done()
  }
})

test('a path with a space, and arguments with spaces and glob characters, reach the server as given', posix, () => {
  const w = world('trek launcher with space-')
  try {
    const dir = install(w.root, 'trek server', 'two')
    install(w.root, 'trek server.previous', 'one')
    pending(dir)
    const args = ['start', '--name', 'my server *', '*', 'a  b', '$HOME', '']
    const given = () => readFileSync(join(w.root, 'args'), 'utf8')
    // In a folder with files a bare * would match.
    assert.equal(run(dir, w.node, args, { cwd: w.root }).status, 0)
    assert.equal(given(), args.join('\n') + '\n')
    assert.equal(tried(dir), true)
    // The rollback too: both renames, the copy and the exec, with the same arguments.
    const second = run(dir, w.node, args, { cwd: w.root })
    assert.equal(second.out, `RAN one ${args.join(' ')}`.trim(), second.err)
    assert.equal(given(), args.join('\n') + '\n')
    assert.equal(readFileSync(join(w.root, 'trek server.failed', 'label'), 'utf8'), 'two')
    assert.equal(existsSync(join(dir, 'update-rolled-back.json')), true)
  } finally {
    w.done()
  }
})

test('a previous version that cannot be moved into place leaves the new one where it was, and the start fails', posix, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    pending(dir)
    run(dir, w.node, ['start'])
    // A stand-in for mv that refuses to move <install>.previous (as a folder that cannot be renamed would).
    const fakeBin = join(w.root, 'fake-bin')
    mkdirSync(fakeBin)
    const realMv = ['/bin/mv', '/usr/bin/mv'].find((p) => existsSync(p))
    writeFileSync(join(fakeBin, 'mv'), `#!/bin/sh\ncase $1 in *.previous) echo "mv: $1: Operation not permitted" >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`, { mode: 0o755 })
    const second = run(dir, w.node, ['start'], { path: `${fakeBin}${delimiter}${process.env.PATH}` })
    assert.equal(second.status, 1)
    assert.equal(second.out, '', 'nothing is started')
    assert.match(second.err, /could not put .*trek-server\.previous back/)
    assert.equal(readFileSync(join(dir, 'label'), 'utf8'), 'two', 'the install path still holds an install')
    assert.equal(existsSync(join(w.root, 'trek-server.failed')), false)
    assert.equal(readFileSync(join(w.root, 'trek-server.previous', 'label'), 'utf8'), 'one')
    assert.equal(tried(dir), true, 'and the next start tries the rollback again')
    assert.equal(run(dir, w.node, ['start']).out, 'RAN one start')
  } finally {
    w.done()
  }
})

const MARK = 'update-pending.tried'
/** An updated install whose first start left `content` in the tried mark, `ageMinutes` ago. */
function triedWorld(content, ageMinutes = 0) {
  const w = world()
  const dir = install(w.root, 'trek-server', 'two')
  install(w.root, 'trek-server.previous', 'one')
  pending(dir)
  const mark = join(dir, MARK)
  writeFileSync(mark, content)
  if (ageMinutes > 0) {
    const then = new Date(Date.now() - ageMinutes * 60_000)
    utimesSync(mark, then, then)
  }
  return { ...w, dir, mark }
}
/** The id of a process that has exited. */
const deadPid = () => String(spawnSync(process.execPath, ['-e', '']).pid)

test('a start while the start that left the mark is still alive does not roll back, and leaves the mark alone', posix, () => {
  // This test's own process stands in for a server that is still starting.
  const w = triedWorld(`${process.pid}\n`)
  try {
    const before = statSync(w.mark).mtimeMs
    assert.deepEqual(run(w.dir, w.node, ['start']), { out: 'RAN two start', err: '', status: 0 })
    assert.equal(readFileSync(w.mark, 'utf8'), `${process.pid}\n`)
    assert.equal(statSync(w.mark).mtimeMs, before, 'not rewritten: its age still bounds how long it is believed')
    assert.equal(existsSync(join(w.root, 'trek-server.previous')), true)
    assert.equal(existsSync(join(w.root, 'trek-server.failed')), false)
  } finally {
    w.done()
  }
})

test('a mark left by a process that is gone is a start that failed: the next start rolls back', posix, () => {
  const w = triedWorld(`${deadPid()}\n`)
  try {
    const second = run(w.dir, w.node, ['start'])
    assert.equal(second.out, 'RAN one start', second.err)
    assert.match(second.err, /did not start.*going back/)
    assert.equal(readFileSync(join(w.root, 'trek-server.failed', 'label'), 'utf8'), 'two')
  } finally {
    w.done()
  }
})

test('an old mark is a failed start even when its process id is alive: the id was reused', posix, () => {
  const w = triedWorld(`${process.pid}\n`, 60)
  try {
    assert.equal(run(w.dir, w.node, ['start']).out, 'RAN one start')
    assert.equal(existsSync(join(w.root, 'trek-server.failed')), true)
  } finally {
    w.done()
  }
})

test('a mark that names no process (empty, garbage, more than one word) is a start that failed', posix, () => {
  for (const content of ['', '\n', 'not a pid', `${process.pid} ${process.pid}`, `-${process.pid}`, `${process.pid}\n${process.pid}\n`, `${process.pid}.5`]) {
    const w = triedWorld(content)
    try {
      assert.equal(run(w.dir, w.node, ['start']).out, 'RAN one start', JSON.stringify(content))
    } finally {
      w.done()
    }
  }
})

test("a mark with the launcher's own process id is a start that is gone (a container restarts with the same id)", posix, () => {
  const w = triedWorld('')
  try {
    // sh writes its id into the mark and becomes the launcher: the same process.
    const r = spawnSync('/bin/sh', ['-c', 'echo $$ > "$1"; exec "$2" start', 'sh', w.mark, join(w.dir, 'bin', 'trek-server')], { env: { PATH: process.env.PATH, TREK_NODE: w.node }, encoding: 'utf8' })
    assert.equal(r.stdout.trim(), 'RAN one start', r.stderr)
  } finally {
    w.done()
  }
})

test('an updated version that cannot be set aside is started again, and says so', posix, () => {
  const w = triedWorld('')
  try {
    // A stand-in for mv that refuses to move the install to <install>.failed.
    const fakeBin = join(w.root, 'fake-bin')
    mkdirSync(fakeBin)
    const realMv = ['/bin/mv', '/usr/bin/mv'].find((p) => existsSync(p))
    writeFileSync(join(fakeBin, 'mv'), `#!/bin/sh\ncase $2 in *.failed) echo "mv: $1: Operation not permitted" >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`, { mode: 0o755 })
    const again = run(w.dir, w.node, ['start'], { path: `${fakeBin}${delimiter}${process.env.PATH}` })
    assert.equal(again.out, 'RAN two start', again.err)
    assert.equal(again.status, 0)
    assert.match(again.err, /could not be set aside as .*trek-server\.failed; starting it again/)
    assert.equal(readFileSync(join(w.root, 'trek-server.previous', 'label'), 'utf8'), 'one', 'the previous version is still there')
    assert.equal(tried(w.dir), true, 'and the next start tries the rollback again')
    assert.equal(run(w.dir, w.node, ['start']).out, 'RAN one start')
  } finally {
    w.done()
  }
})

test('the launcher behaves the same under dash, the /bin/sh of most Linux systems', { skip: posixOnly('the launcher is a POSIX sh script') || (!DASH && 'dash is not installed here') }, () => {
  const w = world()
  try {
    const dir = install(w.root, 'trek-server', 'two')
    install(w.root, 'trek-server.previous', 'one')
    execFileSync(DASH, ['-n', join(dir, 'bin', 'trek-server')])
    assert.deepEqual(run(dir, w.node, ['--port', '9', 'version'], { shell: DASH }), { out: 'RAN two --port 9 version', err: '', status: 0 })
    pending(dir)
    assert.deepEqual(run(dir, w.node, ['--port', 'token'], { shell: DASH }), { out: 'RAN two --port token', err: '', status: 0 })
    assert.equal(tried(dir), true)
    // The launcher put back is this same text; it too runs under dash.
    writeFileSync(join(w.root, 'trek-server.previous', 'bin', 'trek-server'), POSIX_LAUNCHER.replace('#!/bin/sh', `#!${DASH}`), { mode: 0o755 })
    const second = run(dir, w.node, [], { shell: DASH })
    assert.equal(second.out, 'RAN one', second.err)
    assert.match(second.err, /did not start.*going back/)
    assert.equal(existsSync(join(dir, 'update-rolled-back.json')), true)
  } finally {
    w.done()
  }
})
