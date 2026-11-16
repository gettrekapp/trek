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

test('Linux: a child handed a socket beyond its stdio closes it, and nothing of its own', { skip: process.platform !== 'linux' && 'Linux only: /proc/self/fdinfo' }, () => {
  const module = fileURLToPath(new URL('../server/src/inheritedDescriptors.ts', import.meta.url))
  const script = `import { closeInheritedDescriptors } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(closeInheritedDescriptors()))`
  // stdio[3] 'pipe': Node hands the child one end of a socketpair as fd 3, not close-on-exec.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout).map((d) => d.split(' ')[0]), ['3'])
})
