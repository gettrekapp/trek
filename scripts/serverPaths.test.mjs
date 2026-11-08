// scripts/serverPaths.test.mjs — the path guard: configured roots, and the local server's permissive guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathGuard } from '../server/src/paths.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-paths-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const d of ['repos/a', 'roots/extra', 'outside/c']) mkdirSync(join(dir, d), { recursive: true })
  const config = { repos: [{ id: 'a', name: 'a', path: join(dir, 'repos', 'a') }], worktreeRoots: [join(dir, 'roots')] }
  return { dir, config }
}

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'no error'
}

test('the default guard allows a repo, its parent and the worktree roots, and nothing else', (t) => {
  const { dir, config } = setup(t)
  const guard = new PathGuard(config)
  assert.equal(guard.check(join(dir, 'repos', 'a')), join(dir, 'repos', 'a'))
  assert.equal(guard.check(join(dir, 'repos', 'a-feature')), join(dir, 'repos', 'a-feature'))
  assert.equal(guard.check(join(dir, 'roots', 'extra')), join(dir, 'roots', 'extra'))
  assert.equal(codeOf(() => guard.check(join(dir, 'outside', 'c'))), 'PATH_DENIED')
  assert.equal(codeOf(() => guard.check(dir)), 'PATH_DENIED')
  assert.equal(codeOf(() => new PathGuard(config, { permissive: false }).check(join(dir, 'outside', 'c'))), 'PATH_DENIED')
})

test('the permissive guard allows any path and still resolves it', (t) => {
  const { dir, config } = setup(t)
  const guard = new PathGuard(config, { permissive: true })
  assert.equal(guard.check(join(dir, 'outside', 'c')), join(dir, 'outside', 'c'))
  assert.equal(guard.check('/'), '/')
  symlinkSync(join(dir, 'outside', 'c'), join(dir, 'link'))
  assert.equal(guard.check(join(dir, 'link')), join(dir, 'outside', 'c'), 'a symlink resolves to its target')
  assert.equal(guard.check(join(dir, 'link', 'new', 'wt')), join(dir, 'outside', 'c', 'new', 'wt'), 'a path not created yet resolves through its ancestor')
  assert.equal(new PathGuard({ repos: [] }, { permissive: true }).check(join(dir, 'outside')), join(dir, 'outside'), 'with no repos at all')
})
