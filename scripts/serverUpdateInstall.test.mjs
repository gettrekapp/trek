// scripts/serverUpdateInstall.test.mjs — an update's files: the tarball downloaded and hashed,
// unpacked beside the install only if it is one well-formed folder for this version and target,
// then swapped into the install's place with the old version kept as <install>.previous.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEntries, download, previousDir, swap, undoSwap, unpack, validateStaged } from '../server/src/update/install.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'trek-install-'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const serve = (bytes, status = 200) => async () => new Response(status === 200 ? bytes : 'no', { status })
/** A body that arrives in these chunks, then (with `fail`) breaks off. */
const chunked = (chunks, fail) => async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(Buffer.from(chunk)))
        if (fail) controller.error(new Error(fail))
        else controller.close()
      }
    })
  )
const TAR = { COPYFILE_DISABLE: '1' }

/** A folder shaped like a release tarball's. */
function folder(parent, name, { version = '2.0.0', target = 'linux-x64', extra } = {}) {
  const dir = join(parent, name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'trek-server'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(dir, 'trek-server.cjs'), `// ${version}\n`)
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ version, build: 'b', package: 'tarball', target }))
  extra?.(dir)
  return dir
}

/** The tarball of such a folder, made the way the release makes one. */
function tarball(root, name, opts) {
  folder(join(root, 'src'), name, opts)
  const file = join(root, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', join(root, 'src'), name], { env: { ...process.env, ...TAR } })
  return file
}

test('download writes the file only when its sha256 is the signed one', async () => {
  const dir = temp()
  try {
    const bytes = Buffer.from('tarball bytes')
    const dest = join(dir, 'a.tar.gz')
    const seen = []
    const asked = []
    const fetch = async (url, init) => { asked.push([String(url), init.redirect, init.signal instanceof AbortSignal]); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) }
    await download('http://127.0.0.1:1/a', dest, sha(bytes), { fetch, onProgress: (n, total) => seen.push([n, total]) })
    assert.deepEqual(readFileSync(dest), bytes)
    assert.deepEqual(seen.at(-1), [bytes.length, bytes.length])
    assert.deepEqual(asked, [['http://127.0.0.1:1/a', 'follow', true]])
    if (process.platform !== 'win32') assert.equal(statSync(dest).mode & 0o777, 0o600)

    // In several chunks: the hash is of all of them, in order.
    const parts = join(dir, 'parts.tar.gz')
    const progress = []
    await download('http://127.0.0.1:1/p', parts, sha(bytes), { fetch: chunked(['tarball', ' ', 'bytes']), onProgress: (n, total) => progress.push([n, total]) })
    assert.deepEqual(readFileSync(parts), bytes)
    assert.deepEqual(progress, [[7, undefined], [8, undefined], [13, undefined]])

    const bad = join(dir, 'b.tar.gz')
    await assert.rejects(download('http://127.0.0.1:1/b', bad, sha(Buffer.from('other')), { fetch: serve(bytes) }), /sha256/)
    assert.equal(existsSync(bad), false, 'a file that does not match is removed')
    await assert.rejects(download('http://127.0.0.1:1/c', bad, sha(bytes), { fetch: serve(bytes, 404) }), /HTTP 404/)
    assert.equal(existsSync(bad), false, 'nothing is written for an error response')
    await assert.rejects(download('http://127.0.0.1:1/d', bad, sha(bytes), { fetch: serve(bytes), maxBytes: 4 }), /larger than/)
    assert.equal(existsSync(bad), false)
    await assert.rejects(download('http://127.0.0.1:1/e', bad, sha(bytes), { fetch: async () => { throw new Error('offline') } }), /offline/)
    assert.equal(existsSync(bad), false)
    assert.deepEqual(readdirSync(dir).sort(), ['a.tar.gz', 'parts.tar.gz'], 'no failure leaves a file behind')
  } finally {
    removeDir(dir)
  }
})

test('download stops at the size cap part-way through a body, and removes what it had written', async () => {
  const dir = temp()
  try {
    const dest = join(dir, 'big.tar.gz')
    const written = []
    // 3 bytes fit under the cap of 4 and are written; the next chunk passes it.
    await assert.rejects(
      download('http://127.0.0.1:1/big', dest, sha(Buffer.from('abcdefghi')), { fetch: chunked(['abc', 'def', 'ghi']), maxBytes: 4, onProgress: (n) => written.push(n) }),
      /larger than/
    )
    assert.deepEqual(written, [3], 'nothing past the cap was written')
    assert.equal(existsSync(dest), false)

    // Exactly the cap is allowed.
    await download('http://127.0.0.1:1/fits', dest, sha(Buffer.from('abcd')), { fetch: chunked(['abc', 'd']), maxBytes: 4 })
    assert.equal(readFileSync(dest, 'utf8'), 'abcd')
    rmSync(dest)

    await assert.rejects(download('http://127.0.0.1:1/cut', dest, sha(Buffer.from('abcdef')), { fetch: chunked(['abc'], 'connection reset') }), /connection reset/)
    assert.equal(existsSync(dest), false, 'a download that breaks off is removed')
  } finally {
    removeDir(dir)
  }
})

test('checkEntries: one top folder, no absolute path, no ..', () => {
  assert.equal(checkEntries(['a/', 'a/bin/', 'a/bin/trek-server', 'a/build.json']), 'a')
  assert.equal(checkEntries(['./a/', './a/x']), 'a')
  assert.equal(checkEntries(['a/x', 'a/y/z']), 'a', 'no entry for the folder itself')
  // What bsdtar and GNU tar list for `tar -czf t.tgz -C parent .`: the parent itself first.
  assert.equal(checkEntries(['./', './a/', './a/bin/', './a/x']), 'a')
  assert.throws(() => checkEntries([]), /empty/)
  assert.throws(() => checkEntries(['./']), /empty/)
  assert.throws(() => checkEntries(['a/x', 'b/y']), /one folder/)
  assert.throws(() => checkEntries(['a/', 'b/']), /one folder/)
  assert.throws(() => checkEntries(['a/x', '/etc/passwd']), /absolute/)
  assert.throws(() => checkEntries(['a/x', 'a/../../y']), /\.\./)
  assert.throws(() => checkEntries(['a/x', '../y']), /\.\./)
  assert.throws(() => checkEntries(['a/x', 'a/..']), /\.\./)
  assert.throws(() => checkEntries(['..']), /\.\./)
  assert.throws(() => checkEntries(['loose-file']), /one folder/)
  assert.throws(() => checkEntries(['./loose-file']), /one folder/)
  assert.throws(() => checkEntries(['a/', 'a/x', 'loose-file']), /one folder/)
  // A top-level symlink (or file) named like the folder is listed without the slash.
  assert.throws(() => checkEntries(['a', 'a/x']), /one folder/)
})

test('unpack puts the tarball folder in a staging folder beside the install and returns it', { skip: posixOnly('the system tar, as the release tarballs are made') }, () => {
  const root = temp()
  try {
    const file = tarball(root, 'trek-server-2.0.0-linux-x64')
    // What this machine's tar lists is what checkEntries is written for.
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter((line) => line !== '')
    assert.deepEqual(listing.sort(), [
      'trek-server-2.0.0-linux-x64/',
      'trek-server-2.0.0-linux-x64/bin/',
      'trek-server-2.0.0-linux-x64/bin/trek-server',
      'trek-server-2.0.0-linux-x64/build.json',
      'trek-server-2.0.0-linux-x64/trek-server.cjs'
    ])
    const stage = join(root, '.trek-update-2.0.0')
    const staged = unpack(file, stage)
    assert.equal(staged, join(stage, 'trek-server-2.0.0-linux-x64'))
    assert.deepEqual(readdirSync(stage), ['trek-server-2.0.0-linux-x64'])
    assert.deepEqual(readdirSync(staged).sort(), ['bin', 'build.json', 'trek-server.cjs'])
    assert.equal(statSync(join(staged, 'bin', 'trek-server')).mode & 0o111, 0o111, 'the launcher is still executable')
    assert.equal(statSync(stage).mode & 0o777, 0o700)
    assert.doesNotThrow(() => validateStaged(staged, { version: '2.0.0', target: 'linux-x64' }))
    // A leftover staging folder from an interrupted update is replaced.
    writeFileSync(join(stage, 'leftover'), 'x')
    assert.equal(unpack(file, stage), staged)
    assert.deepEqual(readdirSync(stage), ['trek-server-2.0.0-linux-x64'])
  } finally {
    removeDir(root)
  }
})

test('unpack refuses a tarball that is not one folder before it unpacks anything', { skip: posixOnly('the system tar, as the release tarballs are made') }, () => {
  const root = temp()
  try {
    folder(join(root, 'src'), 'one')
    folder(join(root, 'src'), 'two')
    writeFileSync(join(root, 'src', 'loose'), 'x')
    const stage = join(root, '.stage')
    const pack = (name, entries) => {
      const file = join(root, name)
      execFileSync('tar', ['-czf', file, '-C', join(root, 'src'), ...entries], { env: { ...process.env, ...TAR } })
      return file
    }
    assert.throws(() => unpack(pack('two.tar.gz', ['one', 'two']), stage), /one folder/)
    assert.throws(() => unpack(pack('loose.tar.gz', ['one', 'loose']), stage), /one folder/)
    assert.throws(() => unpack(pack('file.tar.gz', ['loose']), stage), /one folder/)
    assert.equal(existsSync(stage), false, 'nothing was unpacked')
    writeFileSync(join(root, 'junk.tar.gz'), 'not a tarball')
    assert.throws(() => unpack(join(root, 'junk.tar.gz'), stage))
    assert.equal(existsSync(stage), false)
  } finally {
    removeDir(root)
  }
})

test('validateStaged refuses another version, another target, or a folder that is not an install', () => {
  const root = temp()
  try {
    const want = { version: '2.0.0', target: 'linux-x64' }
    const at = (name, opts) => folder(root, name, opts)
    assert.doesNotThrow(() => validateStaged(at('good'), want))
    assert.throws(() => validateStaged(at('v', { version: '2.0.1' }), want), /2\.0\.1/)
    assert.throws(() => validateStaged(at('t', { target: 'linux-arm64' }), want), /linux-arm64/)
    assert.throws(() => validateStaged(at('l', { extra: (d) => rmSync(join(d, 'bin'), { recursive: true }) }), want), /bin\/trek-server/)
    assert.throws(() => validateStaged(at('c', { extra: (d) => rmSync(join(d, 'trek-server.cjs')) }), want), /trek-server\.cjs/)
    assert.throws(() => validateStaged(at('b', { extra: (d) => writeFileSync(join(d, 'build.json'), '{') }), want), /build\.json/)
    assert.throws(() => validateStaged(at('n', { extra: (d) => rmSync(join(d, 'build.json')) }), want), /build\.json/)
    assert.throws(() => validateStaged(at('a', { extra: (d) => writeFileSync(join(d, 'build.json'), 'null') }), want), /build\.json/)
    assert.throws(() => validateStaged(at('s', { extra: (d) => writeFileSync(join(d, 'build.json'), JSON.stringify({ version: '2.0.0', build: 'dev', target: 'linux-x64' })) }), want), /release tarball/)
  } finally {
    removeDir(root)
  }
})

test('swap puts the staged folder at the install path and keeps one previous version; undoSwap reverses it', () => {
  const root = temp()
  try {
    const install = join(root, 'trek-server-1.0.0-linux-x64')
    const make = (dir, label) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'label'), label) }
    const label = (dir) => readFileSync(join(dir, 'label'), 'utf8')
    assert.equal(previousDir(install), `${install}.previous`)
    make(install, 'one')
    make(join(root, 'stage', 'two'), 'two')
    swap(install, join(root, 'stage', 'two'))
    assert.equal(label(install), 'two')
    assert.equal(label(previousDir(install)), 'one')
    assert.equal(existsSync(join(root, 'stage', 'two')), false, 'the staged folder was moved, not copied')

    make(join(root, 'stage', 'three'), 'three')
    swap(install, join(root, 'stage', 'three'))
    assert.equal(label(install), 'three')
    assert.equal(label(previousDir(install)), 'two', 'only the last version is kept')

    undoSwap(install)
    assert.equal(label(install), 'two')
    assert.equal(existsSync(previousDir(install)), false)
    assert.deepEqual(readdirSync(root).sort(), ['stage', 'trek-server-1.0.0-linux-x64'], 'the version that was undone is gone')
    assert.throws(() => undoSwap(install), /no previous version/)
    assert.equal(label(install), 'two', 'an undo with nothing to go back to leaves the install alone')
  } finally {
    removeDir(root)
  }
})

test('a swap whose second rename fails leaves the install as it was', () => {
  const root = temp()
  try {
    const install = join(root, 'trek-server-1.0.0-linux-x64')
    mkdirSync(install)
    writeFileSync(join(install, 'label'), 'one')
    assert.throws(() => swap(install, join(root, 'missing-stage')), /ENOENT/)
    assert.equal(readFileSync(join(install, 'label'), 'utf8'), 'one')
    assert.equal(existsSync(previousDir(install)), false)
    assert.deepEqual(readdirSync(root), ['trek-server-1.0.0-linux-x64'])
  } finally {
    removeDir(root)
  }
})
