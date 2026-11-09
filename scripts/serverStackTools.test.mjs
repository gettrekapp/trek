// scripts/serverStackTools.test.mjs — the trek-dev MCP tools get_stack, start_stack, stop_stack and
// read_stack_log (phase 5b), over the server's stack service: real git in a temp dir, a stub
// stack.sh and a stub docker first on PATH (nothing here runs a real docker), and a stack registry
// of the test's own (TREK_STACK_REGISTRY).
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { createToolCaller } from '../server/src/mcp/tools.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { createStackService } from '../src/host/stackService.ts'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-stubs-')))
const callsFile = join(stubDir, 'calls')
const runningFlag = join(stubDir, 'running')
// `docker ps -q` lists one container while the flag file exists.
writeFileSync(join(stubDir, 'docker'), `#!/bin/bash\necho "docker|$*" >> '${callsFile}'\nif [ "$1" = ps ] && [ -f '${runningFlag}' ]; then echo c1; fi\nexit 0\n`)
chmodSync(join(stubDir, 'docker'), 0o755)
process.env.PATH = `${stubDir}:${process.env.PATH}`
process.env.TREK_STACK_REGISTRY = join(stubDir, 'registry')
process.on('exit', () => rmSync(stubDir, { recursive: true, force: true }))

const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])

async function setup(t, { stackBody = '', machine = true } = {}) {
  rmSync(callsFile, { force: true })
  rmSync(runningFlag, { force: true })
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  mkdirSync(join(a, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(a, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "stack|$*" >> '${callsFile}'\necho -e "\\x1b[32mstep $1\\x1b[0m"\n${stackBody}\n`, { mode: 0o755 })
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'init')
  git(a, 'worktree', 'add', '-q', '-b', 'feature-x', `${a}-feature-x`)
  // A worktree without a stack.sh.
  git(a, 'worktree', 'add', '-q', '--detach', `${a}-bare`)
  rmSync(join(`${a}-bare`, 'docker'), { recursive: true, force: true })
  mkdirSync(process.env.TREK_STACK_REGISTRY, { recursive: true })
  writeFileSync(join(process.env.TREK_STACK_REGISTRY, 'trek-a-feature-x'), `path=${a}-feature-x\nport=4100\n`)
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => {
    poller.stop()
    store.close()
  })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'a', path: a }, name: undefined }])
  await poller.refresh(a)
  const stacks = createStackService({ stateDir: join(dir, 'data', 'stacks') })
  const call = createToolCaller({ store, hub, projects, poller, sessions: {}, ...(machine ? { machine: { stacks } } : {}) })(projectId)
  return { a, feature: `${a}-feature-x`, call, projects, projectId }
}

test('get_stack, start_stack, read_stack_log and stop_stack drive the worktree stack.sh on the server', async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
  assert.deepEqual(await s.call('get_stack', { worktree: 'feature-x' }), {
    available: true,
    name: 'trek-a-feature-x',
    state: 'stopped',
    containers: 0,
    ports: { first: 4100, last: 4105 },
    urls: { App: 'http://a-feature-x.localhost:4100', API: 'http://localhost:4101' },
    logins: 'admin or bill, password sample123'
  })
  const started = await s.call('start_stack', { worktree: s.feature, starter: true })
  assert.equal(started.state, 'starting')
  await assert.rejects(s.call('start_stack', { worktree: 'feature-x' }), /already starting/)
  writeFileSync(runningFlag, '')
  assert.equal((await s.call('get_stack', { worktree: 'feature-x' })).state, 'running')
  // The log's last lines, without the colour codes.
  let output = ''
  for (let i = 0; i < 50 && !output.includes('step up'); i++) {
    output = (await s.call('read_stack_log', { worktree: 'feature-x' })).output
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.match(output, /\$ stack\.sh up --starter\nstep up/)
  assert.equal(output.includes('\x1b'), false)
  assert.equal((await s.call('read_stack_log', { worktree: 'feature-x', lines: 1 })).output.split('\n').length, 1)
  rmSync(runningFlag)
  const stopped = await s.call('stop_stack', { worktree: 'feature-x' })
  assert.equal(stopped.state, 'stopped')
  assert.deepEqual(calls().filter((c) => c.startsWith('stack|')), ['stack|up --starter', 'stack|down'])
})

test('the stack tools: a worktree without stack.sh, a failed down, bad arguments, and a server without stacks', async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = down ]; then exit 3; fi' })
  assert.deepEqual(await s.call('get_stack', { worktree: `${s.a}-bare` }), { available: false })
  await assert.rejects(s.call('start_stack', { worktree: `${s.a}-bare` }), /no docker\/stack\/stack\.sh/)
  await assert.rejects(s.call('stop_stack', { worktree: 'feature-x' }), /exited with code 3 — see read_stack_log/)
  await assert.rejects(s.call('start_stack', { worktree: 'feature-x', starter: 'yes' }), /starter must be a boolean/)
  await assert.rejects(s.call('read_stack_log', { worktree: 'feature-x', lines: '5' }), /lines must be a number/)
  await assert.rejects(s.call('get_stack', { worktree: 'nope' }), /No worktree "nope"/)
  const none = await setup(t, { machine: false })
  await assert.rejects(none.call('get_stack', { worktree: 'feature-x' }), /does not run dev stacks/)
})

test('the stack tools refuse a worktree outside the allowlist', async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-stack-tools-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'zzz', isMain: false, loaded: false, sessions: [] })
  })
  await assert.rejects(s.call('get_stack', { worktree: 'out' }), (err) => err.code === 'PATH_DENIED')
})
