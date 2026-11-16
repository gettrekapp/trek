// scripts/inheritedDescriptors.test.mjs — `start --local` closes the sockets and pipes it
// inherited from the app on Linux (server/src/inheritedDescriptors.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { closeInheritedDescriptors, isInheritedDescriptor } from '../server/src/inheritedDescriptors.ts'

const fdinfo = (flags) => `pos:\t0\nflags:\t${flags}\nmnt_id:\t15\nino:\t12345\n`

test('inherited: a socket or a pipe without close-on-exec; not one with it, nor a file, a terminal or an epoll', () => {
  assert.equal(isInheritedDescriptor('socket:[123]', fdinfo('02')), true)
  assert.equal(isInheritedDescriptor('pipe:[456]', fdinfo('01')), true)
  assert.equal(isInheritedDescriptor('socket:[123]', fdinfo('02000002')), false)
  assert.equal(isInheritedDescriptor('pipe:[456]', fdinfo('02004000')), false)
  assert.equal(isInheritedDescriptor('/tmp/server.log', fdinfo('02')), false)
  assert.equal(isInheritedDescriptor('/dev/pts/3', fdinfo('02')), false)
  assert.equal(isInheritedDescriptor('anon_inode:[eventpoll]', fdinfo('02')), false)
  assert.equal(isInheritedDescriptor('socket:[123]', 'pos:\t0\n'), false)
})

test('off Linux it reads and closes nothing', () => {
  const touched = []
  const fs = { readdirSync: (d) => (touched.push(d), []), readlinkSync: () => '', readFileSync: () => '', closeSync: (fd) => touched.push(fd) }
  assert.deepEqual(closeInheritedDescriptors('darwin', fs), [])
  assert.deepEqual(closeInheritedDescriptors('win32', fs), [])
  assert.deepEqual(touched, [])
})

test('on Linux it closes only the inherited ones above stderr, and survives one gone meanwhile', () => {
  const fds = {
    0: ['pipe:[1]', '02'],
    1: ['socket:[2]', '02'],
    2: ['socket:[2]', '02'],
    3: ['socket:[7]', '02'],
    4: ['socket:[8]', '02000002'],
    5: ['/tmp/log', '02'],
    6: ['pipe:[9]', '01']
  }
  const closed = []
  const fs = {
    readdirSync: (dir) => (assert.equal(dir, '/proc/self/fd'), [...Object.keys(fds), '7']),
    readlinkSync: (path) => {
      const fd = path.split('/').pop()
      if (!fds[fd]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return fds[fd][0]
    },
    readFileSync: (path) => fdinfo(fds[path.split('/').pop()][1]),
    closeSync: (fd) => closed.push(fd)
  }
  assert.deepEqual(closeInheritedDescriptors('linux', fs), ['3 socket:[7]', '6 pipe:[9]'])
  assert.deepEqual(closed, [3, 6])
  assert.deepEqual(closeInheritedDescriptors('linux', { ...fs, readdirSync: () => { throw new Error('no /proc') } }), [])
})

test("on Linux it keeps Node's IPC channel, though it looks inherited", () => {
  const closed = []
  const fs = {
    readdirSync: () => ['3', '4'],
    readlinkSync: (p) => (p.endsWith('/3') ? 'socket:[7]' : 'pipe:[8]'),
    readFileSync: () => fdinfo('02'),
    closeSync: (fd) => closed.push(fd)
  }
  assert.deepEqual(closeInheritedDescriptors('linux', fs, 3), ['4 pipe:[8]'])
  assert.deepEqual(closed, [4])
})

test('Linux: a child handed a socket beyond its stdio is left with no inherited socket or pipe, and its own stdio works', { skip: process.platform !== 'linux' && 'Linux only: /proc/self/fdinfo' }, () => {
  const module = fileURLToPath(new URL('../server/src/inheritedDescriptors.ts', import.meta.url))
  // After the cleanup, the child lists what still looks inherited: nothing should. What it closed
  // depends on the environment too (a CI runner leaks pipes of its own into every process), so
  // only its kind is checked, not an exact list.
  const script = [
    `import { readdirSync, readlinkSync, readFileSync } from 'node:fs'`,
    `import { closeInheritedDescriptors, isInheritedDescriptor } from ${JSON.stringify(module)}`,
    `const closed = closeInheritedDescriptors()`,
    `const left = []`,
    `for (const n of readdirSync('/proc/self/fd')) {`,
    `  if (Number(n) <= 2) continue`,
    `  try { const link = readlinkSync('/proc/self/fd/' + n); if (isInheritedDescriptor(link, readFileSync('/proc/self/fdinfo/' + n, 'utf8'))) left.push(n + ' ' + link) } catch {}`,
    `}`,
    `process.stdout.write(JSON.stringify({ closed, left }))`
  ].join('\n')
  // stdio[3] 'pipe': the child gets a socket beyond its stdio.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const { closed, left } = JSON.parse(child.stdout)
  assert.deepEqual(left, [], 'no inherited socket or pipe is left open')
  for (const entry of closed) assert.match(entry, /^\d+ (socket|pipe):\[\d+\]$/)
  assert.ok(closed.every((entry) => Number(entry.split(' ')[0]) > 2), 'stdio is never closed')
})
