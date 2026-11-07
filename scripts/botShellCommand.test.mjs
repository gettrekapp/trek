// scripts/botShellCommand.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeShell, couldMatch, expandPath, parseShell, shellBudget, SHELL_STEP_LIMIT } from '../src/host/bot/shellCommand.ts'
import { resolve } from 'node:path'

const words = (command) => parseShell(command, '/c').map((s) => s.words.map((w) => w.text))

test('splits on unquoted separators only', () => {
  assert.deepEqual(words('a b; c && d || e | f\ng'), [['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g']])
  assert.deepEqual(words('(a) & b'), [['a'], ['b']])
  assert.deepEqual(words(`echo "a;b" 'c|d' e${'\\'};f`), [['echo', 'a;b', 'c|d', 'e;f']])
})

test('removes quotes and joins continuations', () => {
  assert.deepEqual(words(`a"b"'c' "d\\"e" "f\\g" ''`), [['abc', 'd"e', 'f\\g', '']])
  assert.deepEqual(words('git push \\\n  --force\\\r\n x'), [['git', 'push', '--force', 'x']])
  assert.deepEqual(words(`'a\\\nb'`), [['a\\\nb']])
})

test('collects redirect targets apart from words', () => {
  const redirects = (c) => parseShell(c, '/c')[0].redirects.map((w) => w.text)
  assert.deepEqual(redirects('a > b'), ['b'])
  assert.deepEqual(redirects('a >b 2>c >>d &>e &>>f >|g'), ['b', 'c', 'd', 'e', 'f', 'g'])
  assert.deepEqual(redirects('a 2>&1 >&2 3>&-'), [])
  assert.deepEqual(redirects(`a '>' b ">c"`), [])
  assert.deepEqual(words('a 2>x b'), [['a', 'b']])
  assert.deepEqual(words('a2>x'), [['a2']])
  assert.deepEqual(words('a < b'), [['a', 'b']])
  assert.deepEqual(words('a <<< "b c"'), [['a', 'b c']])
})

test('skips heredoc bodies and comments', () => {
  assert.deepEqual(words('a <<X\nb\nX\nc'), [['a'], ['c']])
  assert.deepEqual(words(`a <<-'X' && d\n\tb\n\tX\nc`), [['a'], ['d'], ['c']])
  assert.deepEqual(words('a <<X <<Y\nb\nX\nc\nY\nd'), [['a'], ['d']])
  assert.deepEqual(words('# a\nb # c\nd#e'), [['b'], ['d#e']])
})

test('tracks cd through segments and subshells', () => {
  const cwds = (c, from = '/c') => parseShell(c, from).map((s) => s.cwd)
  // A `..` is kept as written, for the policy to resolve lexically and physically
  assert.deepEqual(cwds('cd a && b; cd ../d; e'), ['/c', '/c/a', '/c/a', '/c/a/../d'])
  assert.deepEqual(cwds('cd a && b; cd ../d; e').map((p) => resolve(p)), ['/c', '/c/a', '/c/a', '/c/d'])
  assert.deepEqual(cwds('(cd a; b); c'), ['/c', '/c/a', '/c'])
  assert.deepEqual(cwds('cd -P a; b'), ['/c', '/c/a'])
  assert.equal(parseShell('cd; a', '/c')[1].cwd, expandPath('~', '/c'))
  assert.equal(parseShell('cd ~/x; a', '/c')[1].cwd, expandPath('~/x', '/c'))
})

test('expands inner scripts without leaking their cd', () => {
  assert.deepEqual(words('bash -c "a b; c" && d'), [['bash', '-c', 'a b; c'], ['a', 'b'], ['c'], ['d']])
  assert.deepEqual(parseShell('sh -c "cd a; b"; c', '/c').map((s) => s.cwd), ['/c', '/c', '/c/a', '/c'])
})

test('marks only unquoted wildcards', () => {
  const ref = (c) => analyzeShell(c, '/c').paths.at(-1)
  assert.equal(couldMatch(ref('cat /d/*.json'), '/d/a.json'), true)
  assert.equal(couldMatch(ref('cat /d/?.json'), '/d/a.json'), true)
  assert.equal(couldMatch(ref('cat /d/[ab].json'), '/d/a.json'), true)
  assert.equal(couldMatch(ref('cat /d/*.json'), '/d/e/a.json'), false)
  assert.equal(couldMatch(ref('cat "/d/*.json"'), '/d/a.json'), false)
  assert.equal(couldMatch(ref('cat /d/a.json'), '/d/a.json'), true)
  assert.deepEqual(words('[ -f a ] && b'), [['[', '-f', 'a', ']'], ['b']])
})

test('analysis reports force pushes per segment, ask keys and write targets', () => {
  assert.equal(analyzeShell('git push && rm -f x', '/c').forcePush, false)
  assert.equal(analyzeShell('rm -f x && git -C a push -f', '/c').forcePush, true)
  assert.deepEqual(analyzeShell('git push; gh pr merge 1; git status', '/c').ask, ['git push', 'gh pr merge'])
  assert.deepEqual(analyzeShell('cd a && rm b -f > c', '/c').writes, ['/c/a/c', '/c/a/b'])
  assert.deepEqual(analyzeShell('cp a b', '/c').writes, ['/c/b', '/c/b/a'])
  assert.deepEqual(analyzeShell('git -C /r rm a', '/c').writes, ['/r/a'])
  assert.deepEqual(analyzeShell('find a b -name c -delete', '/c').writes, ['/c/a', '/c/b'])
  assert.deepEqual(analyzeShell('find -name c -delete', '/c').destroys, ['/c'])
  assert.deepEqual(analyzeShell('find . -name c', '/c').destroys, [])
})

test('analysis reports what would be destroyed as a whole', () => {
  const destroys = (c) => analyzeShell(c, '/c').destroys
  assert.deepEqual(destroys('rm -rf a b'), ['/c/a', '/c/b'])
  assert.deepEqual(destroys('mv a b c'), ['/c/a', '/c/b'])
  assert.deepEqual(destroys('cd d && rmdir ..'), ['/c/d/..'])
  assert.deepEqual(destroys('chmod -R 7 a'), ['/c/7', '/c/a'])
  assert.deepEqual(destroys('chmod 7 a'), [])
  assert.deepEqual(destroys('find a -delete'), ['/c/a'])
  assert.deepEqual(destroys('find a -name b -delete'), ['/c/a'])
  assert.deepEqual(destroys('find a'), [])
  assert.deepEqual(destroys('mkdir a; touch b; cat c'), [])
})

test('substitutions queue their segments and keep the outer word', () => {
  assert.deepEqual(words('echo "a$(b c)d" e'), [['b', 'c'], ['echo', 'a$()d', 'e']])
  assert.deepEqual(words('echo a`b c`d e'), [['b', 'c'], ['echo', 'a$()d', 'e']])
  assert.deepEqual(words(`x "$(cat <<'E'\nb " c\nE\n)" y`), [['cat'], ['x', '$()', 'y']])
  assert.deepEqual(words('x $(a $(b) "$(c)")'), [['b'], ['c'], ['a', '$()', '$()'], ['x', '$()']])
  assert.deepEqual(words('x $(a'), [['a'], ['x', '$()']])
  assert.deepEqual(words('x $((1<<2)) y'), [['x', '$((1<<2))', 'y']])
  assert.deepEqual(parseShell('x $(cd a; b); c', '/c').map((s) => s.cwd), ['/c', '/c/a', '/c', '/c'])
})

test('ANSI-C strings keep an escaped quote inside', () => {
  assert.deepEqual(words(`echo $'it\\'s' b`), [['echo', `it's`, 'b']])
})

test('a run of wildcards collapses', () => {
  const ref = analyzeShell(`cat /d/${'*'.repeat(500)}x`, '/c').paths.at(-1)
  assert.equal(couldMatch(ref, '/d/aax'), true)
  assert.equal(couldMatch(ref, '/d/aay'), false)
})

test('nesting is limited', () => {
  // 100 KB of evals is past the step budget before it is past the nesting limit.
  assert.throws(() => parseShell(`${'eval '.repeat(20000)}ls`, '/c'), /nested|too complex/)
  assert.throws(() => parseShell(`${'eval '.repeat(20)}ls`, '/c'), /nested/)
  assert.throws(() => parseShell(`${'$('.repeat(20)}ls`, '/c'), /nested/)
  assert.equal(parseShell(`${'eval '.repeat(5)}ls`, '/c').length, 6)
})

test('analysis rejects oversized commands', () => {
  assert.throws(() => analyzeShell('a'.repeat(64 * 1024 + 1), '/c'), /too long/)
  assert.throws(() => analyzeShell('a;'.repeat(2001), '/c'), /too many/)
  assert.doesNotThrow(() => analyzeShell('a;'.repeat(2000), '/c'))
})

/** Analyses `command` and returns [the error message or 'ok', the steps it took]. */
const work = (command, cwd = '/c') => {
  const budget = shellBudget()
  try {
    analyzeShell(command, cwd, budget)
    return ['ok', budget.steps]
  } catch (err) {
    return [err.message, budget.steps]
  }
}

test('analysis is bounded by work, not time: each rejection stops within the step limit', () => {
  const rejected = [
    // Each cd deepened cwd, and every later path cost its depth: 73 s on the main thread before.
    ['cd a;'.repeat(1999), /too deeply nested/],
    ['cd a;'.repeat(5000), /too deeply nested/],
    [`cd ${'a/'.repeat(70)}`, /too deeply nested/],
    [`cd ${'a'.repeat(5000)}`, /too deeply nested/],
    [`git -C ${'a/'.repeat(70)} status`, /too deeply nested/],
    [`cat ${'/a'.repeat(300)}`, /too deeply nested/],
    // Segments are counted across sh -c and eval, during the parse.
    [`sh -c '${'a;'.repeat(1500)}'; ${'b;'.repeat(600)}`, /too many parts/],
    [`eval '${'a;'.repeat(2001)}'`, /too many parts/],
    // Many deep paths: within every other limit, but too much to resolve.
    [`cd ${'a/'.repeat(58)}; ${'x '.repeat(30000)}`, /too complex/],
    [`cat ${`${'/a'.repeat(250)} `.repeat(120)}`, /too complex/]
  ]
  for (const [command, message] of rejected) {
    const [result, steps] = work(command)
    assert.match(result, message, command.slice(0, 40))
    assert.ok(steps <= SHELL_STEP_LIMIT, `${command.slice(0, 40)}: ${steps} steps`)
  }
})

test('ordinary commands take a small part of the budget', () => {
  for (const command of [
    'git status',
    'cd /Users/me/proj && git status && npm test 2>&1 | tail -5; for f in src/*.ts; do grep -n foo "$f"; done',
    'a;'.repeat(1000),
    `cd ${'a/'.repeat(50)} && ls`
  ]) {
    const [result, steps] = work(command)
    assert.equal(result, 'ok', command.slice(0, 40))
    assert.ok(steps < SHELL_STEP_LIMIT / 5, `${command.slice(0, 40)}: ${steps} steps`)
  }
})

test('a smaller budget is honoured, and steps are what was spent', () => {
  const budget = shellBudget(10)
  assert.throws(() => analyzeShell('echo a b c d e f g h', '/c', budget), /too complex/)
  assert.ok(budget.steps <= 10)
  const roomy = shellBudget()
  analyzeShell('ls', '/c', roomy)
  assert.ok(roomy.steps > 0 && roomy.steps < 20, String(roomy.steps))
})
