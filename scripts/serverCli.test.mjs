// scripts/serverCli.test.mjs — trek-server's argument parsing: the update and selfcheck commands,
// and the list of flags that take a value (the POSIX launcher's rollback reads the same list).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMMANDS, VALUE_FLAGS, parseArgs } from '../server/src/cli.ts'

test('update and selfcheck are commands; --check and --yes are update flags', () => {
  assert.ok(COMMANDS.includes('update') && COMMANDS.includes('selfcheck'))
  assert.equal(parseArgs(['selfcheck']).command, 'selfcheck')
  const plain = parseArgs(['update'])
  assert.deepEqual([plain.command, plain.check, plain.yes], ['update', false, false])
  const check = parseArgs(['update', '--check'])
  assert.deepEqual([check.command, check.check, check.yes], ['update', true, false])
  const yes = parseArgs(['--yes', 'update', '--config', '/tmp/x/config.json'])
  assert.deepEqual([yes.command, yes.yes, yes.configPath, yes.configExplicit], ['update', true, '/tmp/x/config.json', true])
})

test('start is still the default, and its flags parse as before', () => {
  const start = parseArgs(['--port', '9001', '--host', '127.0.0.1'])
  assert.deepEqual([start.command, start.port, start.host, start.check, start.yes], ['start', 9001, '127.0.0.1', false, false])
  assert.equal(parseArgs(['token', 'add', 'laptop']).tokenName, 'laptop')
  assert.equal(parseArgs(['update', '-h']).command, 'help')
})

/** What parseArgs prints before it exits 2 for these arguments ('' when it accepts them). */
function refusal(argv) {
  const exit = process.exit
  const error = console.error
  let printed = ''
  process.exit = (code) => {
    throw new Error(`exit ${code}`)
  }
  console.error = (text) => {
    printed += text
  }
  try {
    parseArgs(argv)
  } catch (err) {
    if (!/^exit \d+$/.test(err.message)) throw err
  } finally {
    process.exit = exit
    console.error = error
  }
  return printed
}

test('VALUE_FLAGS lists exactly the flags parseArgs reads a value for', () => {
  const source = readFileSync(new URL('../server/src/cli.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export function parseArgs('), source.indexOf('function isDirectory('))
  // Every flag parseArgs names, however its branch is written…
  const flags = [...new Set([...body.matchAll(/['"`](--?[A-Za-z][\w-]*)['"`]/g)].map((m) => m[1]))]
  assert.ok(flags.length >= 15, `found only ${flags.join(' ')}`)
  // …and those it refuses when nothing follows them.
  const reading = flags.filter((flag) => refusal([flag]).startsWith(`${flag} needs a value`))
  assert.deepEqual(reading.sort(), [...VALUE_FLAGS].sort())
  // Nothing takes the next argument except through value(): one call per value flag, and the
  // loop's own i++ is the only other place the index moves.
  const moves = body.match(/\+\+\s*i\b|\bi\s*\+\+|\bi\s*[+-]?=(?!=)|--\s*i\b|\bi\s*--/g) ?? []
  const viaValue = body.match(/value\(\+\+i, arg\)/g) ?? []
  assert.equal(viaValue.length, VALUE_FLAGS.length, 'one value(++i, arg) per value flag')
  assert.deepEqual(moves.filter((m) => !m.startsWith('++')).map((m) => m.trim()), ['i =', 'i++'], `the index moves at: ${moves.join(' | ')}`)
  assert.equal(moves.filter((m) => m.startsWith('++')).length, viaValue.length, `the index moves at: ${moves.join(' | ')}`)
})

test('plugin add, remove and list parse; a missing action or target is refused', () => {
  assert.ok(COMMANDS.includes('plugin'))
  const add = parseArgs(['plugin', 'add', './my-theme', '--data-dir', '/tmp/data'])
  assert.deepEqual([add.command, add.pluginAction, add.pluginTarget, add.dataDir], ['plugin', 'add', './my-theme', '/tmp/data'])
  const url = parseArgs(['plugin', 'add', 'https://themes.test/nord.trekplugin'])
  assert.equal(url.pluginTarget, 'https://themes.test/nord.trekplugin')
  const remove = parseArgs(['plugin', 'remove', 'nord'])
  assert.deepEqual([remove.pluginAction, remove.pluginTarget], ['remove', 'nord'])
  assert.equal(parseArgs(['plugin', 'list']).pluginAction, 'list')
  // `add` and `list` after `plugin` are its actions, not the repo commands.
  assert.equal(parseArgs(['plugin', 'list']).command, 'plugin')
  assert.match(refusal(['plugin']), /plugin needs an action/)
  assert.match(refusal(['plugin', 'install', 'x']), /Unknown plugin action: install/)
  assert.match(refusal(['plugin', 'add']), /plugin add needs/)
  assert.match(refusal(['plugin', 'remove']), /plugin remove needs/)
  assert.match(refusal(['plugin', 'list', 'extra']), /Unknown/)
})

test('plugin takes --local and --local-profile, for the local server; not with --data-dir or --config', () => {
  const list = parseArgs(['plugin', 'list', '--local'])
  assert.deepEqual([list.command, list.pluginAction, list.local, list.localProfile], ['plugin', 'list', true, undefined])
  const add = parseArgs(['plugin', 'add', './my-theme', '--local', '--local-profile', 'dev'])
  assert.deepEqual([add.command, add.pluginAction, add.pluginTarget, add.local, add.localProfile], ['plugin', 'add', './my-theme', true, 'dev'])
  const first = parseArgs(['--local-profile', 'dev', '--local', 'plugin', 'remove', 'nord'])
  assert.deepEqual([first.command, first.pluginAction, first.pluginTarget, first.local, first.localProfile], ['plugin', 'remove', 'nord', true, 'dev'])
  assert.match(refusal(['plugin', 'list', '--local', '--data-dir', '/tmp/data']), /--local has its own config, data dir/)
  assert.match(refusal(['plugin', 'list', '--local', '--config', '/tmp/config.json']), /--local has its own config, data dir/)
  assert.match(refusal(['plugin', 'list', '--local-profile', 'dev']), /--local-profile only applies with --local/)
  assert.match(refusal(['plugin', 'list', '--local', '--local-profile', 'Bad_Name']), /Invalid local profile name/)
  assert.match(refusal(['plugin', 'list', '--local', '--web']), /--web does not apply to the local server/)
  // Still only these three.
  assert.match(refusal(['token', 'list', '--local']), /--local only applies to `start`, `stop` and `plugin`/)
  assert.match(refusal(['list', '--local']), /--local only applies/)
})
