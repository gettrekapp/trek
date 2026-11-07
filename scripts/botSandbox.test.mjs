// scripts/botSandbox.test.mjs — the bot's OS sandbox: profile, argv and refusals (pure).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ancestorsOf, insideUserData, macProfile, sandboxFor } from '../src/host/bot/sandbox.ts'

const UD = "/Users/me/Library/Application Support/Trek Dev"

test('ancestors run nearest first, up to the root', () => {
  assert.deepEqual(ancestorsOf(UD), ['/Users/me/Library/Application Support', '/Users/me/Library', '/Users/me', '/Users', '/'])
  assert.deepEqual(ancestorsOf('/a'), ['/'])
  assert.deepEqual(ancestorsOf('/'), [])
})

test('the macOS profile denies userData, renaming each ancestor, and LaunchServices', () => {
  assert.equal(
    macProfile(2),
    [
      '(version 1)',
      '(allow default)',
      "; Trek's userData: nothing in the bot's process tree may read or change it.",
      '(deny file-read* file-write* (subpath (param "USERDATA")))',
      '; Renaming an ancestor would move userData out from under the rule above.',
      '(deny file-write-unlink (literal (param "ANC0")) (literal (param "ANC1")))',
      '; LaunchServices would start an app (one the bot wrote) outside this sandbox.',
      '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(lsd|coreservices|launchservices)"))'
    ].join('\n')
  )
})

test('macOS: sandbox-exec with every path as a -D parameter, one per ancestor', () => {
  const plan = sandboxFor('darwin', UD)
  assert.equal(plan.ok, true)
  const { command, args } = plan.sandbox
  assert.equal(command, '/usr/bin/sandbox-exec')
  assert.deepEqual(args.slice(0, -2), [
    '-D', `USERDATA=${UD}`,
    '-D', 'ANC0=/Users/me/Library/Application Support',
    '-D', 'ANC1=/Users/me/Library',
    '-D', 'ANC2=/Users/me',
    '-D', 'ANC3=/Users',
    '-D', 'ANC4=/'
  ])
  assert.deepEqual(args.slice(-2), ['-p', macProfile(5)])
})

test('macOS: quotes, parentheses and = in a path stay out of the profile text', () => {
  const odd = `/tmp/it's "odd" (x)=y`
  const { args } = sandboxFor('darwin', `${odd}/Trek`).sandbox
  assert.equal(args[1], `USERDATA=${odd}/Trek`)
  assert.equal(args[3], `ANC0=${odd}`)
  assert.ok(!args.at(-1).includes('odd'))
})

test('Linux: bwrap with a tmpfs over userData, its own PID namespace and /proc, and no new session', () => {
  const plan = sandboxFor('linux', '/home/me/.config/Trek Dev')
  assert.deepEqual(plan, {
    ok: true,
    sandbox: {
      command: 'bwrap',
      args: ['--dev-bind', '/', '/', '--tmpfs', '/home/me/.config/Trek Dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--']
    }
  })
  assert.ok(!plan.sandbox.args.includes('--new-session'))
})

test('Windows and other platforms are refused with a reason', () => {
  assert.deepEqual(sandboxFor('win32', 'C:\\Users\\me\\AppData\\Roaming\\Trek'), {
    ok: false,
    reason: "The project bot needs an OS sandbox, which Windows doesn't provide. The bot runs on macOS and Linux."
  })
  assert.equal(sandboxFor('freebsd', '/home/me/.config/Trek').ok, false)
  assert.match(sandboxFor('freebsd', '/home/me/.config/Trek').reason, /no OS sandbox for freebsd/)
})

test('a path that is not absolute and normal is refused, since the profile would fail open', () => {
  for (const path of ['relative/Trek', '/a/../b/Trek', '/a//Trek', '/a/Trek/', '/']) {
    assert.equal(sandboxFor('darwin', path).ok, false, path)
    assert.equal(sandboxFor('linux', path).ok, false, path)
  }
})

test('folders inside userData are found, case-folded on macOS', () => {
  assert.equal(insideUserData('darwin', UD, ['/p/x.trekbot', `${UD}/bots/x.trekbot`]), `${UD}/bots/x.trekbot`)
  assert.equal(insideUserData('darwin', UD, [UD.toUpperCase()]), UD.toUpperCase())
  assert.equal(insideUserData('linux', '/home/me/.config/Trek', ['/home/me/.config/TREK/x']), null)
  assert.equal(insideUserData('darwin', UD, [`${UD} Other/x`, '/Users/me/Library']), null)
})
