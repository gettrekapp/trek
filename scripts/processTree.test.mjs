// scripts/processTree.test.mjs — killTree: a POSIX process group, or taskkill /T /F on Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { killTree, killTreeSync, taskkillArgs } from '../src/host/processTree.ts'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return check()
}

test('taskkill gets the tree, forced', () => {
  assert.deepEqual(taskkillArgs(1234), ['/T', '/F', '/PID', '1234'])
})

test('win32: killTree runs taskkill for the pid and never signals', async () => {
  const runs = []
  const kills = []
  await killTree(4321, { platform: 'win32', signal: 'SIGINT' }, { runTaskkill: async (args) => runs.push(args), kill: (...a) => kills.push(a) })
  assert.deepEqual(runs, [['/T', '/F', '/PID', '4321']])
  assert.deepEqual(kills, [])
})

test('POSIX: killTree signals the group (default SIGKILL, or the given signal)', async () => {
  const kills = []
  await killTree(4321, { platform: 'linux' }, { kill: (...a) => kills.push(a) })
  await killTree(4321, { platform: 'darwin', signal: 'SIGINT' }, { kill: (...a) => kills.push(a) })
  assert.deepEqual(kills, [[-4321, 'SIGKILL'], [-4321, 'SIGINT']])
})

test('no pid, pid 0/1 or a fraction: nothing is killed', async () => {
  const kills = []
  const runs = []
  for (const pid of [undefined, 0, 1, 2.5]) {
    await killTree(pid, { platform: 'linux' }, { kill: (...a) => kills.push(a) })
    await killTree(pid, { platform: 'win32' }, { runTaskkill: async (a) => runs.push(a) })
    killTreeSync(pid, { platform: 'linux' })
  }
  assert.deepEqual(kills, [])
  assert.deepEqual(runs, [])
})

test('a real tree: the leader and its child both go', async (t) => {
  // POSIX: a detached shell leads its own group. Windows: node starts a child node and waits.
  const win = process.platform === 'win32'
  const leader = win
    ? spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    : spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  leader.stdout.on('data', (d) => (out += d))
  t.after(() => {
    try {
      leader.kill('SIGKILL')
    } catch {}
  })
  assert.ok(await until(() => /\d+/.test(out)), 'the child printed its pid')
  const child = Number(out.trim().split(/\s+/)[0])
  assert.ok(alive(child))
  await killTree(leader.pid)
  assert.ok(await until(() => !alive(child)), 'the child is gone')
  assert.ok(await until(() => leader.exitCode !== null || leader.signalCode !== null), 'the leader is gone')
})
