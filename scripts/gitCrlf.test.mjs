// scripts/gitCrlf.test.mjs — a move's or promote's patch between a worktree with LF files (macOS,
// Linux) and one with CRLF files (a Windows user's core.autocrlf=true): it applies, and the work
// comes out the same as git sees it (the digest a move checks), each side keeping its own line
// endings (git apply runs files through the eol conversion). core.autocrlf=true converts on
// any OS, so this runs everywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch, exportDirtyPatch, patchDigest, reverseApplyPatch } from '../src/host/gitService.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })

/** A repository with LF text committed, and a clone of it whose checkout has `autocrlf`. */
function setup(t, autocrlf) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-crlf-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lf = join(dir, 'lf')
  execFileSync('git', ['init', '-q', '-b', 'main', lf], { env })
  git(lf, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(lf, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(lf, 'b.txt'), 'alpha\nbeta\n')
  git(lf, 'add', '-A')
  git(lf, 'commit', '-q', '-m', 'init')
  const crlf = join(dir, 'crlf')
  execFileSync('git', ['-c', `core.autocrlf=${autocrlf}`, 'clone', '-q', lf, crlf], { env })
  git(crlf, 'config', 'core.autocrlf', String(autocrlf))
  return { lf, crlf }
}

for (const [from, to] of [['lf', 'crlf'], ['crlf', 'lf']]) {
  test(`a dirty patch from the ${from.toUpperCase()} worktree applies to the ${to.toUpperCase()} one, with the same digest`, async (t) => {
    const trees = setup(t, true)
    assert.equal(readFileSync(join(trees.crlf, 'a.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n', 'autocrlf checked out CRLF')
    const source = trees[from]
    const target = trees[to]
    const eol = from === 'crlf' ? '\r\n' : '\n'
    writeFileSync(join(source, 'a.txt'), ['one', 'TWO', 'three', 'four', ''].join(eol))
    writeFileSync(join(source, 'c.txt'), ['new', 'file', ''].join(eol))
    const { patch } = await exportDirtyPatch(source)
    await applyPatch(target, patch)
    // The target keeps its own line endings: git apply runs the files through its eol conversion.
    const targetEol = to === 'crlf' ? '\r\n' : '\n'
    assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), ['one', 'TWO', 'three', 'four', ''].join(targetEol))
    assert.equal(readFileSync(join(target, 'c.txt'), 'utf8'), ['new', 'file', ''].join(targetEol))
    const again = await exportDirtyPatch(target)
    assert.equal(patchDigest(again.patch), patchDigest(patch), 'the target holds the same work, as git sees it')
    // A promote's undo puts the target back.
    await reverseApplyPatch(target, patch)
    assert.equal(git(target, 'status', '--porcelain'), '')
  })
}
