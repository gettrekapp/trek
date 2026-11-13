// scripts/serverPaths.test.mjs — the path guard: configured roots, and the local server's permissive guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PathGuard } from '../server/src/paths.ts'

// The guard resolves as pathContainment's realPath does: on Windows the native one, which also
// expands an 8.3 temp folder (C:\Users\RUNNER~1\…) to its long name.
const real = process.platform === 'win32' ? realpathSync.native : realpathSync

function setup(t) {
  const dir = real(mkdtempSync(join(tmpdir(), 'trek-server-paths-')))
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

test('Windows: a UNC path is refused, given so or resolved so (a mapped drive, a junction to a share), even when permissive', (t) => {
  const { dir, config } = setup(t)
  const share = join(dir, 'repos', 'a')
  // realPath as Windows would give it for a mapped drive or a junction onto a share.
  const realPath = (p) => (p.startsWith(share) ? '\\\\server\\share' + p.slice(share.length) : p)
  for (const permissive of [false, true]) {
    const guard = new PathGuard(config, { permissive, platform: 'win32', realPath })
    assert.equal(codeOf(() => guard.check('\\\\server\\share\\repo')), 'PATH_DENIED')
    assert.equal(codeOf(() => guard.check(share)), 'PATH_DENIED', 'resolved to a share')
    assert.equal(codeOf(() => guard.check(join(share, 'not-yet'))), 'PATH_DENIED', 'its deepest existing ancestor resolved to a share')
    assert.throws(() => guard.assertLocal(share), /network or WSL paths/)
  }
  // Elsewhere (a Linux server may well keep repos on a network mount) nothing changes.
  const posix = new PathGuard(config, { platform: 'linux', realPath })
  assert.doesNotThrow(() => posix.assertLocal(share))
})

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
  assert.equal(guard.check('/'), resolve('/'), 'the root (C:\\ on Windows)')
  symlinkSync(join(dir, 'outside', 'c'), join(dir, 'link'))
  assert.equal(guard.check(join(dir, 'link')), join(dir, 'outside', 'c'), 'a symlink resolves to its target')
  assert.equal(guard.check(join(dir, 'link', 'new', 'wt')), join(dir, 'outside', 'c', 'new', 'wt'), 'a path not created yet resolves through its ancestor')
  assert.equal(new PathGuard({ repos: [] }, { permissive: true }).check(join(dir, 'outside')), join(dir, 'outside'), 'with no repos at all')
})
