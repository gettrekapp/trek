// scripts/botShellCommand.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeShell, couldMatch, expandPath, parseShell } from '../src/host/bot/shellCommand.ts'

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
  assert.deepEqual(cwds('cd a && b; cd ../d; e'), ['/c', '/c/a', '/c/a', '/c/d'])
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
  assert.deepEqual(analyzeShell('find a b -name c -delete', '/c').finds, [{ roots: ['/c/a', '/c/b'], names: ['c'] }])
  assert.deepEqual(analyzeShell('find -name c -delete', '/c').finds, [{ roots: ['/c'], names: ['c'] }])
  assert.deepEqual(analyzeShell('find . -name c', '/c').finds, [])
})

test('analysis reports what would be destroyed as a whole', () => {
  const destroys = (c) => analyzeShell(c, '/c').destroys
  assert.deepEqual(destroys('rm -rf a b'), ['/c/a', '/c/b'])
  assert.deepEqual(destroys('mv a b c'), ['/c/a', '/c/b'])
  assert.deepEqual(destroys('cd d && rmdir ..'), ['/c'])
  assert.deepEqual(destroys('chmod -R 7 a'), ['/c/7', '/c/a'])
  assert.deepEqual(destroys('chmod 7 a'), [])
  assert.deepEqual(destroys('find a -delete'), ['/c/a'])
  assert.deepEqual(destroys('find a -name b -delete'), [])
  assert.deepEqual(destroys('find a'), [])
  assert.deepEqual(destroys('mkdir a; touch b; cat c'), [])
})
