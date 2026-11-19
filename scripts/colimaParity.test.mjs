// scripts/colimaParity.test.mjs — the Colima plugin's env.* against core's (plugins E2, until Task 8
// drops core's): each scenario runs once on core's handlers (dispatchV2 with core's environment
// service) and once on the plugin's (the harness's registry), each in its own temp project, and the
// two transcripts (answers, env.log events, the stubs' calls) must match once the per-run paths are
// named. Only the differences the plan decided are mapped away: colima's working directory (the
// server's own before, the plugin's data directory now), the registry's path, and the log line for a
// colima that is not installed (the host's words). Nothing here runs a real docker or colima: the
// stubs of scripts/machineHarness.mjs. Delete this file with core's env.* (Task 8).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchV2 } from '../server/src/v2.ts'
import { holdWorktree } from '../server/src/teardown/teardown.ts'
import { createEnvironmentService } from '../src/host/environmentService.ts'
import { deriveProfileName } from '../plugins/colima/shared/environments.ts'
import { removeDir } from './testPlatform.mjs'
import { calls, git, originalPath, resetCalls, setup, skip, stubDir } from './machineHarness.mjs'

/** A side: core's handlers (its own registry in the data dir) or the plugin's. */
async function side(t, which, options) {
  const s = await setup(t, options)
  let registryFile = s.registryFile
  let call = s.call
  if (which === 'core') {
    registryFile = join(s.data, 'environments.json')
    s.ctx.machine = { ...s.ctx.machine, env: createEnvironmentService({ registryFile, home: options?.home?.(s.dir) ?? s.dir }) }
    // Core's own handlers: dispatchV2 asks core first.
    call = (method, params, on = s.ctx) => dispatchV2(method, params, on)
  }
  const profile = deriveProfileName(s.a, 'feature-x')
  /** More per-run spellings a scenario makes (a temp dir outside the project, another branch's VM) */
  const aliases = [[deriveProfileName(s.a, 'feature-y'), '<profile-y>']]
  const alias = (from, to) => aliases.push([from, to])
  /** Every per-run spelling named: the registry, colima's cwd, the temp dir, the VM's name, a record's time. */
  const name = (value) => {
    let text = JSON.stringify(value === undefined ? null : value)
    for (const [from, to] of aliases) text = text.replaceAll(from, to)
    return JSON.parse(
      text
        .replaceAll(registryFile, '<registry>')
        // Core ran colima in the server's directory; the plugin runs its streamed runs in its data directory.
        .replaceAll(`colima|${s.pluginDir}|`, 'colima|<colima cwd>|')
        .replaceAll(`colima|${process.cwd()}|`, 'colima|<colima cwd>|')
        .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<time>"')
        .replaceAll(s.dir, '<dir>')
        .replaceAll(profile, '<profile>')
        // The host's words for a program it can't find, where core printed spawn's error (a log line, no client reads it).
        .replaceAll('error: colima is not installed on the server', 'error: spawn colima ENOENT')
    )
  }
  return { s, call, registryFile, profile, name, alias }
}

/** Runs `scenario` on both sides and compares their transcripts. */
function parity(title, scenario, options) {
  test(`parity: ${title}`, { skip }, async (t) => {
    const transcripts = {}
    for (const which of ['core', 'plugin']) {
      const run = await side(t, which, options)
      const log = []
      const record = (label, value) => log.push([label, run.name(value)])
      const ask = async (method, params) => {
        const res = await run.call(method, params)
        // Messages included: a client shows them.
        record(method, res)
        return res
      }
      await scenario({ ...run, ask, record })
      // Two runs at once interleave their events as they come: each run's own, in order.
      const byProfile = Map.groupBy(run.s.events, ([, e]) => run.name(e.profile))
      record('events', [...byProfile.keys()].sort().flatMap((p) => byProfile.get(p)))
      record('calls', calls())
      transcripts[which] = log
    }
    assert.deepEqual(transcripts.plugin, transcripts.core)
  })
}

const vms = (lines) => {
  writeFileSync(join(stubDir, 'vms'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
const noVms = () => rmSync(join(stubDir, 'vms'), { force: true })

parity('check, up, list, ps, logs, composeFiles, stop and destroy', async ({ s, ask, profile }) => {
  const worktreeId = s.worktreeAt(s.feature).id
  const ref = { projectId: s.projectId, worktreeId }
  await ask('env.check', {})
  await ask('env.up', { ...ref, settings: { enabled: true, cpu: 3, memory: 1.5, networkAddress: false, composeFile: 'docker-compose.yml', profileKey: '/elsewhere' }, envVars: { FOO: 'bar' } })
  vms([{ name: profile, status: 'Running', address: '10.0.0.5' }, { name: 'twb-leftover-000000', status: 'Stopped' }])
  try {
    await ask('env.list', { projectId: s.projectId, repoId: s.repoId })
    await ask('env.ps', ref)
    await ask('env.ps', { ...ref, composeFile: 'compose.dev.yaml' })
    await ask('env.logs', { ...ref, service: 'web', tail: 50 })
    await ask('env.composeFiles', ref)
    await ask('env.stop', { profile })
    await ask('env.destroy', { profile })
    await ask('env.list', { projectId: s.projectId, repoId: s.repoId })
  } finally {
    noVms()
  }
})

parity("the repository's profileKey (an import's) names the VM", async ({ s, ask }) => {
  await ask('repo.update', { projectId: s.projectId, repoId: s.repoId, environments: { enabled: true, profileKey: '/old/spelling/a' } })
  await ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })
  await ask('env.list', { projectId: s.projectId, repoId: s.repoId })
})

parity('refusals: ids, rows, the allowlist, detached HEAD, settings, variables, profiles, services', async ({ s, ask, alias }) => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-colima-parity-outside-')))
  alias(outside, '<outside>')
  try {
    s.projects.apply(s.projectId, (d) => {
      d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'feature-x', isMain: false, loaded: false, sessions: [] })
      d.repositories[0].worktrees.push({ id: 'gone', name: 'gone', path: join(s.dir, 'gone'), branch: 'gone', isMain: false, missing: true, loaded: false, sessions: [] })
    })
    const worktreeId = s.worktreeAt(s.feature).id
    for (const [method, extra] of [['env.ps', {}], ['env.composeFiles', {}], ['env.logs', { service: 'web' }], ['env.up', { settings: { enabled: true } }]]) {
      for (const id of ['out', 'gone', 'nope']) await ask(method, { projectId: s.projectId, worktreeId: id, ...extra })
      await ask(method, { projectId: 'no-such-project', worktreeId, ...extra })
      await ask(method, { projectId: 42, worktreeId, ...extra })
      await ask(method, { projectId: s.projectId, worktreeId: 7, ...extra })
    }
    for (const repoId of ['nope', 7]) await ask('env.list', { projectId: s.projectId, repoId })
    await ask('env.list', { projectId: 42, repoId: s.repoId })
    await ask('env.list', { projectId: 'no-such-project', repoId: s.repoId })
    const up = (extra) => ask('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true }, ...extra })
    for (const composeFile of ['../outside.yml', '/etc/passwd', '-f /etc/x', 'x\0.yml', '.', 7]) await up({ settings: { enabled: true, composeFile } })
    for (const settings of [{ enabled: true, cpu: 0 }, { enabled: true, memory: '2' }, { enabled: true, disk: 20.5 }, { enabled: true, rosetta: 'yes' }, { enabled: true, extra: 1 }, { enabled: true, profileKey: 3 }, 'x', null, undefined]) {
      await up({ settings })
    }
    for (const envVars of [{ PATH: '/tmp' }, { Docker_Host: 'x' }, { 'A B': '1' }, { X: 1 }, ['X=1'], 'X=1']) await up({ envVars })
    for (const profile of ['../x', 'twb-', 'other-vm', 'twb-A', undefined]) {
      await ask('env.stop', { profile })
      await ask('env.destroy', { profile })
    }
    await ask('env.logs', { projectId: s.projectId, worktreeId, service: '-f' })
    await ask('env.logs', { projectId: s.projectId, worktreeId })
    for (const tail of [0, 1e9, 1.5, '10']) await ask('env.logs', { projectId: s.projectId, worktreeId, service: 'web', tail })
    await ask('env.ps', { projectId: s.projectId, worktreeId, composeFile: '../x.yml' })
    // Detached: up (git re-read), ps and logs refuse; composeFiles still lists.
    git(s.feature, 'checkout', '-q', '--detach')
    await s.poller.refresh(s.a)
    await up({ settings: { enabled: true } })
    await ask('env.ps', { projectId: s.projectId, worktreeId })
    await ask('env.logs', { projectId: s.projectId, worktreeId, service: 'web' })
    await ask('env.composeFiles', { projectId: s.projectId, worktreeId })
  } finally {
    removeDir(outside)
  }
})

parity('a machine without colima or docker', async ({ s, ask }) => {
  const empty = mkdtempSync(join(tmpdir(), 'trek-colima-parity-nopath-'))
  process.env.PATH = empty
  try {
    await ask('env.check', {})
    await ask('env.list', { projectId: s.projectId, repoId: s.repoId })
    await ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })
    await ask('env.stop', { profile: 'twb-x-000000' })
    await ask('env.ps', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id })
    await ask('env.logs', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, service: 'web' })
  } finally {
    process.env.PATH = `${stubDir}:${originalPath}`
    removeDir(empty)
  }
})

parity('an unreadable registry: list is TOOL_ERROR registry naming it, up refuses to write over it', async ({ s, ask, registryFile, record }) => {
  for (const text of ['{"twb-real-000000": {', '[]']) {
    writeFileSync(registryFile, text)
    await ask('env.list', { projectId: s.projectId, repoId: s.repoId })
    await ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })
  }
  rmSync(registryFile)
  record('registry gone', null)
})

parity("env.destroy is CONFLICT while the server holds the VM's worktree", async ({ s, ask, profile }) => {
  await holdWorktree(s.feature, 'removing it', async () => {
    await ask('env.destroy', { profile })
  })
  await ask('env.destroy', { profile })
})

parity('compose up failing, and two ups at once', async ({ s, ask }) => {
  git(s.a, 'worktree', 'add', '-q', '-b', 'feature-y', `${s.a}-feature-y`)
  await s.poller.refresh(s.a)
  const up = (path) => ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(path).id, settings: { enabled: true, networkAddress: false } })
  await Promise.all([up(s.feature), up(`${s.a}-feature-y`)])
  resetCalls()
  // No compose file: the up fails before colima runs.
  await ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false, composeFile: 'nope.yml' } })
})

parity("a worktree outside Colima's home", async ({ s, ask }) => {
  await ask('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true } })
}, { home: (dir) => join(dir, 'rep') })
