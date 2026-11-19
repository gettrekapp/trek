// scripts/machineHarness.mjs — what scripts/serverMachine.test.mjs and scripts/colimaPlugin.test.mjs
// share (plugins E2): real git in a temp dir; stub docker and colima first on PATH and a stub
// stack.sh in the repository, each recording its arguments, its working directory (`pwd -P`, its
// real path) and $FOO; a project on a ConfigStore; and the Colima plugin on a registry with core's
// path checks. Nothing here runs a real docker or colima. Importing it puts the stubs on PATH for
// the whole file (node --test runs each file in its own process).
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { toWireError } from '../server/src/errors.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { pluginPathChecks } from '../server/src/plugins/coreChecks.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { localSiblingDataDirs } from '../server/src/plugins/siblings.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { createStackService } from '../src/host/stackService.ts'
import { COLIMA_MANIFEST } from '../plugins/colima/manifest.ts'
import { setupColima } from '../plugins/colima/server/index.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

/** The stubs are bash scripts, and a Windows server has neither the env plugin nor dev stacks. */
export const skip = posixOnly('bash stubs for docker, colima and stack.sh; no env plugin or stacks on Windows')

export const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

export const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-stubs-')))
const callsFile = join(stubDir, 'calls')
const stub = (name, body) => {
  writeFileSync(join(stubDir, name), `#!/bin/bash\necho "${name}|$(pwd -P)|$*|FOO=$FOO" >> '${callsFile}'\n${body}\n`)
  chmodSync(join(stubDir, name), 0o755)
}
stub('docker', `case "$1" in
  --version) echo "Docker version 0.0.0-stub" ;;
  ps) if [ "$2" = "-a" ]; then echo '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 1 minute","Ports":"80/tcp"}'; fi ;;
esac
case " $* " in *" compose "*" ps "*) echo '[{"Service":"web","State":"running","Status":"Up","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}]' ;; esac
case " $* " in *" logs "*) echo "web log line" ;; esac
exit 0`)
stub('colima', `case "$1" in
  --version) echo "colima version 0.0.0-stub" ;;
  list) [ -f '${stubDir}/vms' ] && cat '${stubDir}/vms' ;;
  # Opt in: delete-fails fails every delete; delete-fails-unlisted, like a real colima, one of a profile it has no VM for.
  delete) if [ -f '${stubDir}/delete-fails' ]; then exit 1; fi
    if [ -f '${stubDir}/delete-fails-unlisted' ] && ! grep -qs "\"$2\"" '${stubDir}/vms'; then exit 1; fi ;;
esac
exit 0`)
export const originalPath = process.env.PATH
process.env.PATH = `${stubDir}:${originalPath}`
process.on('exit', () => removeDir(stubDir))

export const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])
export const resetCalls = () => rmSync(callsFile, { force: true })

export const refused = (res, code, reason) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
  if (reason !== undefined) assert.equal(res.error.details?.reason, reason)
}

/**
 * Repository `a` (a compose file, compose.dev.yaml, a stack.sh) with its worktree on feature-x, in
 * a project, and the Colima plugin set up on a registry.
 * - `stackBody`: what stack.sh runs after recording its call.
 * - `home(dir)`: Colima's home for the plugin (default: the temp dir, which holds the worktrees).
 * The answer's `usePlugin({ dataDir, local })` makes the registry again, over another data dir and
 * as a Local server or not; it returns that data dir's `registryFile` and `pluginDir`.
 */
export async function setup(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-machine-')))
  t.after(() => removeDir(dir))
  resetCalls()
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  mkdirSync(join(a, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(a, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "stack|$(pwd -P)|$*" >> '${callsFile}'\n${options.stackBody ?? ''}\n`, { mode: 0o755 })
  writeFileSync(join(a, 'docker-compose.yml'), 'services: {}\n')
  writeFileSync(join(a, 'compose.dev.yaml'), 'services: {}\n')
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'init')
  git(a, 'worktree', 'add', '-q', '-b', 'feature-x', `${a}-feature-x`)
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => {
    poller.stop()
    store.close()
  })
  const data = join(dir, 'data')
  mkdirSync(data)
  const machine = { stacks: createStackService({ stateDir: join(data, 'stacks') }) }
  const events = []
  const ctx = {
    store, hub, subscriber: { send: () => {} }, projects, poller,
    sessions: { blockPath: () => () => {}, refreshAttention: () => {} },
    machine,
    caller: 'main',
    events: { send: (event, payload) => events.push([event, payload]) }
  }
  /** Each connection's caller id and its events: what the plugin's host.emitTo reaches */
  const sinks = [['main', events]]
  let registry
  const usePlugin = ({ dataDir = data, local = false } = {}) => {
    void registry?.dispose()
    registry = createPluginRegistry({
      plugins: [{ manifest: COLIMA_MANIFEST, setup: (host) => setupColima(host, { home: options.home?.(dir) ?? dir }) }],
      secretsFile: join(dir, 'secrets.json'),
      dataDir,
      hub,
      projects,
      // Until Task 8 core still has env.*: the registry is told env. is not a core namespace.
      isCoreMethod: (prefix) => prefix !== 'env.' && isCoreMethod(prefix),
      coreToolNames: [],
      paths: pluginPathChecks({ projects, store, poller }),
      ...(local ? { siblingDataDirs: () => localSiblingDataDirs(dataDir) } : {}),
      warn: () => {}
    })
    for (const [caller, list] of sinks) registry.connect(caller, (event, payload) => list.push([event, payload]))
    ctx.plugins = registry
    return { registryFile: join(dataDir, 'plugins', 'env', 'environments.json'), pluginDir: join(dataDir, 'plugins', 'env') }
  }
  const files = usePlugin()
  t.after(() => registry.dispose())
  // Until Task 8 core still has env.*: the plugin's methods are asked first.
  const call = async (method, params, on = ctx) => {
    const plugin = on.plugins?.handler(method)
    if (!plugin) return dispatchV2(method, params, on)
    try {
      return { ok: true, result: await plugin(params, on.caller) }
    } catch (err) {
      return { ok: false, error: toWireError(method, err) }
    }
  }
  let others = 0
  /** Another connection to the same server: its own caller and events (made after the last usePlugin). */
  const connection = () => {
    const own = []
    const caller = `other-${++others}`
    sinks.push([caller, own])
    registry.connect(caller, (event, payload) => own.push([event, payload]))
    const other = { ...ctx, caller, events: { send: (event, payload) => own.push([event, payload]) } }
    return { events: own, call: (method, params) => call(method, params, other) }
  }
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const repo = () => projects.require(projectId).repositories[0]
  const worktreeAt = (path) => repo().worktrees.find((w) => w.path === path)
  return { dir, a, feature: `${a}-feature-x`, data, ...files, usePlugin, store, projects, poller, call, connection, events, projectId, repoId: repo().id, repo, worktreeAt, ctx }
}
