process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 't'
process.env.GIT_AUTHOR_EMAIL = 't@t'
process.env.GIT_COMMITTER_NAME = 't'
process.env.GIT_COMMITTER_EMAIL = 't@t'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeBranch, fetchBranch, push } from '../src/host/gitService.ts'
import { removeDir } from './testPlatform.mjs'

const refused = [
  '', '-x', '--upload-pack=x', '@', 'HEAD', 'a b', 'a\tb', 'a\nb', 'a\x01b', 'a\x7fb',
  'a:b', 'x:refs/heads/main', 'a^b', 'a~1', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b',
  '/a', 'a/', '.a', 'a.', 'a.lock', 'a//b', 'a/.b'
]
const accepted = ['main', 'feat/x-1', 'release/2.0', 'user/ab_c', 'pr-12', 'a@b', 'HEAD2']

for (const name of refused) {
  test(`assertSafeBranch refuses ${JSON.stringify(name)}`, () => {
    assert.throws(() => assertSafeBranch(name), /^Error: invalid branch name/)
  })
}
for (const name of accepted) {
  test(`assertSafeBranch accepts ${JSON.stringify(name)}`, () => {
    assert.doesNotThrow(() => assertSafeBranch(name))
  })
}

test('injection attempts are rejected and have no effect', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-branch-safety-'))
  t.after(() => removeDir(dir))
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  g(dir, 'clone', '-q', origin, repo)
  g(repo, 'checkout', '-q', '-b', 'main')
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
  g(repo, 'push', '-q', 'origin', 'main')
  const before = g(origin, 'rev-parse', 'main')

  const pwned = join(dir, 'PWNED')
  await assert.rejects(fetchBranch(repo, `--upload-pack=touch ${pwned}; git-upload-pack`), /invalid branch name/)
  assert.equal(existsSync(pwned), false)

  g(repo, 'checkout', '-q', '-b', 'x')
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
  await assert.rejects(push(repo, 'x:refs/heads/main', false), /invalid branch name/)
  assert.equal(g(origin, 'rev-parse', 'main'), before)

  // a legitimate push still works
  await push(repo, 'x', false)
  assert.equal(g(origin, 'rev-parse', 'x'), g(repo, 'rev-parse', 'x'))
})
