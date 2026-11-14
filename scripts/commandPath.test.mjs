// scripts/commandPath.test.mjs — the programs Trek spawns are found on PATH, never in the current
// directory (on Windows, libuv and cmd.exe would look there first: a repository could plant a
// git.exe). Pure tests with a fake file system on any OS; the last one runs only on Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandPath, findOnPath, hardenWindowsEnv } from '../src/host/commandPath.ts'
import { git } from '../src/host/gitService.ts'
import { samePath } from '../src/host/pathContainment.ts'
import { windowsOnly, removeDir } from './testPlatform.mjs'

const CWD = 'C:\\repo'
/** A file system of `paths`, case-insensitive as NTFS. */
const fs = (...paths) => {
  const set = new Set(paths.map((p) => p.toLowerCase()))
  return (p) => set.has(p.toLowerCase())
}
const ENV = { Path: 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\Docker\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\WINDOWS' }

test('commandPath: elsewhere than Windows the name is left to execvp', () => {
  assert.equal(commandPath('git', { platform: 'darwin', env: ENV, isFile: () => true }), 'git')
  assert.equal(commandPath('git', { platform: 'linux', env: ENV, isFile: () => true }), 'git')
})

test('commandPath: never the current directory, even with git.exe there and on PATH', () => {
  const isFile = fs(`${CWD}\\git.exe`, `${CWD}\\docker.exe`, 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Docker\\bin\\docker.exe')
  assert.equal(commandPath('git', { platform: 'win32', env: ENV, isFile }), 'C:\\Program Files\\Git\\cmd\\git.exe')
  assert.equal(commandPath('docker', { platform: 'win32', env: ENV, isFile }), 'C:\\Program Files\\Docker\\bin\\docker.exe')
})

test('commandPath: a program only in the current directory (or a relative/empty PATH entry) is not found', () => {
  const isFile = fs(`${CWD}\\git.exe`, '.\\git.exe', 'git.exe', 'bin\\git.exe')
  for (const Path of ['', ';;', '.', '.;bin', 'bin', '\\tools']) {
    assert.throws(() => commandPath('git', { platform: 'win32', env: { ...ENV, Path }, isFile }), (err) => err.code === 'ENOENT', `PATH=${JSON.stringify(Path)}`)
  }
})

test('commandPath: only .exe/.com (execFile cannot run a batch file without a shell)', () => {
  const isFile = fs('C:\\Program Files\\Git\\cmd\\gh.cmd', 'C:\\Program Files\\Docker\\bin\\gh.exe')
  assert.equal(commandPath('gh', { platform: 'win32', env: ENV, isFile }), 'C:\\Program Files\\Docker\\bin\\gh.exe')
  assert.throws(() => commandPath('gh.cmd', { platform: 'win32', env: ENV, isFile }), /not found on PATH/)
})

test("commandPath: Windows' own tools come from System32 whatever PATH says", () => {
  const isFile = fs(`${CWD}\\taskkill.exe`, 'C:\\Program Files\\Git\\cmd\\where.exe')
  assert.equal(commandPath('taskkill', { platform: 'win32', env: ENV, isFile }), 'C:\\WINDOWS\\System32\\taskkill.exe')
  assert.equal(commandPath('where', { platform: 'win32', env: ENV, isFile }), 'C:\\WINDOWS\\System32\\where.exe')
  assert.equal(commandPath('taskkill', { platform: 'win32', env: { Path: '' }, isFile }), 'C:\\Windows\\System32\\taskkill.exe')
})

test('commandPath: a path (the caller chose it) is kept', () => {
  assert.equal(commandPath('C:\\tools\\gh.exe', { platform: 'win32', env: ENV, isFile: () => false }), 'C:\\tools\\gh.exe')
  assert.equal(commandPath('/bin/sh', { platform: 'win32', env: ENV, isFile: () => false }), '/bin/sh')
})

test('hardenWindowsEnv: on Windows, cmd.exe is told not to look in the current directory', () => {
  const win = { Path: 'C:\\x' }
  hardenWindowsEnv(win, 'win32')
  assert.equal(win.NoDefaultCurrentDirectoryInExePath, '1')
  const mac = {}
  hardenWindowsEnv(mac, 'darwin')
  assert.deepEqual(mac, {})
})

test('findOnPath: PATH (any case) in order, PATHEXT in order, quoted entries', () => {
  const isFile = fs('C:\\b\\x.cmd', 'C:\\b\\x.exe', 'C:\\Program Files\\c\\y.com')
  const env = { PATH: 'C:\\a;C:\\b;"C:\\Program Files\\c"' }
  assert.equal(findOnPath('x', env, isFile), 'C:\\b\\x.exe')
  assert.equal(findOnPath('x', env, isFile, ['.cmd', '.exe']), 'C:\\b\\x.cmd')
  assert.equal(findOnPath('y', env, isFile), 'C:\\Program Files\\c\\y.com')
})

test('a git.exe planted in the current directory is never what Trek runs as git', { skip: windowsOnly("libuv's cwd-first lookup") }, async (t) => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'trek-planted-git-')))
  const before = process.cwd()
  t.after(() => {
    process.chdir(before)
    removeDir(repo)
  })
  execFileSync(commandPath('git'), ['init', '-q', repo], { windowsHide: true })
  // node.exe as git.exe: given git's arguments (`-c core.longpaths=true …`) it fails.
  copyFileSync(process.execPath, join(repo, 'git.exe'))
  process.chdir(repo)
  assert.ok(!samePath(commandPath('git'), join(repo, 'git.exe')))
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim()
  assert.ok(samePath(realpathSync.native(top), repo), top)
})
