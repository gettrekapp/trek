// scripts/colimaService.test.mjs — the Colima plugin's tools and environment service (plugins E2)
// over the host's programs, against stub colima and docker first on PATH (nothing here runs a real
// one): colima in the plugin's data directory, compose in the worktree, a service's logs from both
// streams, and compose down skipped where the host refuses the folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand, spawnCommand } from '../server/src/plugins/run.ts'
import { createTools } from '../plugins/colima/server/tools.ts'
import { createEnvironmentService } from '../plugins/colima/server/service.ts'
import { deriveProfileName } from '../plugins/colima/shared/environments.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const skip = posixOnly('bash stubs for docker and colima; the env plugin is for macOS and Linux')
const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-colima-stubs-')))
const callsFile = join(stubDir, 'calls')
const stub = (name, body) => {
  writeFileSync(join(stubDir, name), `#!/bin/bash\necho "${name}|$(pwd -P)|$*|FOO=$FOO" >> '${callsFile}'\n${body}\n`)
  chmodSync(join(stubDir, name), 0o755)
}
stub('docker', `[ "$1" = "--version" ] && echo "Docker version 0.0.0-stub"
case " $* " in *" logs "*" broken "*) echo "no such service: broken" >&2; exit 1 ;; esac
case " $* " in *" logs "*" huge "*) head -c 17000000 /dev/zero | tr '\\0' a; sleep 20; exit 0 ;; esac
case " $* " in *" logs "*" slow "*) sleep 20; exit 0 ;; esac
case " $* " in *" -f broken.yml ps "*) echo "" >&2; echo "service \\"db\\" has neither an image nor a build context" >&2; exit 1 ;; esac
case " $* " in *" -f lines.yml ps "*) echo '{"Service":"web","State":"running","Status":"Up","Publishers":[]}'; echo '{"Name":"db-1","State":"exited","Status":"Exited (0)"}'; exit 0 ;; esac
case " $* " in *" down "*) [ -f '${stubDir}/slowdown' ] && sleep 20 ;; esac
case " $* " in *" logs "*) echo "out line"; echo "err line" >&2 ;; esac
case " $* " in *" compose "*" ps "*) echo '[{"Service":"web","State":"running","Status":"Up","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"},{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}]' ;; esac
exit 0`)
stub('colima', `[ "$1" = "--version" ] && echo "colima version 0.0.0-stub"
[ "$1" = "list" ] && [ -f '${stubDir}/vms' ] && cat '${stubDir}/vms'
[ "$1" = "stop" ] && echo "stopping $2"
exit 0`)
const originalPath = process.env.PATH
process.env.PATH = `${stubDir}:${originalPath}`
process.on('exit', () => removeDir(stubDir))
const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])

/** The host's run and spawn as the registry hands them over; `refuse(cwd)` names a cwd the host won't take. */
function fakeHost(refuse = () => null) {
  return {
    run: (command, args, options = {}) => runCommand(command, args, options),
    spawn: (command, args, options) => {
      const why = refuse(options.cwd)
      // As the registry's programCwd: a plain Error, no code
      return why ? Promise.reject(new Error(why)) : spawnCommand(command, args, options)
    }
  }
}

function dirs(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-colima-')))
  t.after(() => removeDir(root))
  rmSync(callsFile, { force: true })
  const pluginDir = join(root, 'data', 'plugins', 'env')
  const worktree = join(root, 'app-feat')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(worktree)
  writeFileSync(join(worktree, 'docker-compose.yml'), 'services: {}\n')
  return { root, pluginDir, worktree, registryFile: join(pluginDir, 'environments.json') }
}

test("the tools: colima in the plugin's data directory, compose in the worktree with the variables, a service's logs from both streams", { skip }, async (t) => {
  const d = dirs(t)
  const tools = createTools(fakeHost(), d.pluginDir)
  assert.deepEqual(await tools.checkTools(), { ok: true, colimaVersion: 'colima version 0.0.0-stub', dockerVersion: 'Docker version 0.0.0-stub' })
  const out = []
  assert.equal(await tools.startVm('twb-x-000000', { cpu: 2, memory: 4, disk: 20, networkAddress: true, rosetta: false }, (c) => out.push(c)), 0)
  assert.equal(out[0], '$ colima start twb-x-000000 --cpu 2 --memory 4 --disk 20 --network-address\n')
  assert.equal(await tools.composeUp('twb-x-000000', d.worktree, 'docker-compose.yml', () => {}, { FOO: 'bar' }), 0)
  assert.deepEqual(await tools.composePs('twb-x-000000', d.worktree, 'docker-compose.yml'), [{ name: 'web', state: 'running', status: 'Up', ports: [{ published: 8080, target: 80, protocol: 'tcp' }] }])
  assert.equal(await tools.composeLogs('twb-x-000000', d.worktree, 'docker-compose.yml', 'web', 50), 'out line\nerr line\n')
  assert.deepEqual(calls().filter((c) => !c.includes('|--version|')), [
    `colima|${d.pluginDir}|start twb-x-000000 --cpu 2 --memory 4 --disk 20 --network-address|FOO=`,
    `docker|${d.worktree}|--context colima-twb-x-000000 compose -f docker-compose.yml up -d|FOO=bar`,
    `docker|${d.worktree}|--context colima-twb-x-000000 compose -f docker-compose.yml ps --format json|FOO=`,
    `docker|${d.worktree}|--context colima-twb-x-000000 compose -f docker-compose.yml logs --no-color --tail 50 web|FOO=`
  ])
})

test('the tools without colima or docker: check says so, a streamed run ends with -1 and says why, a read rejects with ENOENT', { skip }, async (t) => {
  const d = dirs(t)
  const empty = mkdtempSync(join(tmpdir(), 'trek-colima-nopath-'))
  process.env.PATH = empty
  t.after(() => {
    process.env.PATH = `${stubDir}:${originalPath}`
    removeDir(empty)
  })
  const tools = createTools(fakeHost(), d.pluginDir)
  assert.deepEqual(await tools.checkTools(), { ok: false, error: 'colima not found on PATH — brew install colima' })
  const out = []
  assert.equal(await tools.stopVm('twb-x-000000', (c) => out.push(c)), -1)
  assert.match(out.join(''), /error: colima is not installed on the server/)
  await assert.rejects(tools.listColimaProfiles(), (e) => e.code === 'ENOENT')
  await assert.rejects(tools.composeLogs('twb-x-000000', d.worktree, 'docker-compose.yml', 'web', 5), (e) => e.code === 'ENOENT')
})

test('destroy: compose down where the host lets it run, skipped (said in the log) where it refuses the folder; the VM and its entry go either way', { skip }, async (t) => {
  const d = dirs(t)
  const profile = 'twb-feat-000000'
  writeFileSync(d.registryFile, JSON.stringify({ [profile]: { repoPath: '/r', branch: 'feat', worktreePath: d.worktree, createdAt: 'then' } }))
  const refusing = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(fakeHost((cwd) => (cwd === d.worktree ? `${d.worktree} is outside the server's allowed paths` : null)), d.pluginDir), home: d.root })
  const log = []
  assert.equal(await refusing.destroy(profile, (e) => log.push(e)), 0)
  assert.ok(log.map((e) => e.data).join('').includes(`skipping docker compose down: ${d.worktree} is outside the server's allowed paths`))
  assert.deepEqual(calls(), [`colima|${d.pluginDir}|delete ${profile} --force|FOO=`])
  assert.deepEqual(JSON.parse(readFileSync(d.registryFile, 'utf8')), {})
  assert.equal(log.at(-1).done, true)
  writeFileSync(d.registryFile, JSON.stringify({ [profile]: { repoPath: '/r', branch: 'feat', worktreePath: d.worktree, createdAt: 'then', envVars: { FOO: 'v' } } }))
  rmSync(callsFile, { force: true })
  const service = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(fakeHost(), d.pluginDir), home: d.root })
  assert.equal(await service.destroy(profile, () => {}), 0)
  assert.deepEqual(calls(), [`docker|${d.worktree}|--context colima-${profile} compose -f docker-compose.yml down -v|FOO=v`, `colima|${d.pluginDir}|delete ${profile} --force|FOO=`])
})

test('up: registered (0600) before the VM starts, then compose; list, known and knownRepo find it under the repository key', { skip }, async (t) => {
  const d = dirs(t)
  const service = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(fakeHost(), d.pluginDir), home: d.root })
  const profile = deriveProfileName('/old/a', 'feat')
  const res = await service.up({ repoKey: '/old/a', branch: 'feat', worktreePath: d.worktree, settings: { enabled: true, networkAddress: false }, envVars: { FOO: 'bar' } }, () => {})
  assert.deepEqual(res, { code: 0, address: undefined })
  assert.equal(statSync(d.registryFile).mode & 0o777, 0o600)
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running', address: '10.0.0.5' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  assert.deepEqual((await service.list('/old/a')).map((e) => [e.profile, e.vmState, e.address]), [[profile, 'running', '10.0.0.5']])
  assert.deepEqual([await service.known(profile), await service.knownRepo('/old/a'), await service.knownRepo('/r/other')], [true, true, false])
})

test("destroy: a program that can't start (an errno code, not the host's refusal) is an error line, not a skip", { skip }, async (t) => {
  const d = dirs(t)
  const profile = 'twb-feat-000000'
  writeFileSync(d.registryFile, JSON.stringify({ [profile]: { repoPath: '/r', branch: 'feat', worktreePath: d.worktree, createdAt: 'then' } }))
  const host = fakeHost()
  const failing = {
    run: host.run,
    spawn: (command, args, options) => (command === 'docker' ? Promise.reject(Object.assign(new Error('docker could not start'), { code: 'EACCES' })) : host.spawn(command, args, options))
  }
  const service = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(failing, d.pluginDir), home: d.root })
  const log = []
  assert.equal(await service.destroy(profile, (e) => log.push(e)), 0)
  const text = log.map((e) => e.data).join('')
  assert.ok(text.includes('error: docker could not start\n'), text)
  assert.ok(!text.includes('skipping'), text)
})

test('destroy: a compose down past its time says so, and the VM is deleted anyway', { skip }, async (t) => {
  const d = dirs(t)
  const profile = 'twb-feat-000000'
  writeFileSync(join(stubDir, 'slowdown'), '')
  t.after(() => rmSync(join(stubDir, 'slowdown'), { force: true }))
  writeFileSync(d.registryFile, JSON.stringify({ [profile]: { repoPath: '/r', branch: 'feat', worktreePath: d.worktree, createdAt: 'then' } }))
  const service = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(fakeHost(), d.pluginDir), home: d.root, composeDownTimeoutMs: 300 })
  const log = []
  const started = Date.now()
  assert.equal(await service.destroy(profile, (e) => log.push(e)), 0)
  assert.ok(Date.now() - started < 10_000)
  assert.ok(log.map((e) => e.data).join('').includes('docker compose down timed out after 0.3 s; deleting the VM anyway\n'))
  assert.equal(calls().at(-1), `colima|${d.pluginDir}|delete ${profile} --force|FOO=`)
})

test("the registry stays 0600 past a crash's leftover 0644 temp file", { skip }, async (t) => {
  const d = dirs(t)
  const tmp = `${d.registryFile}.${process.pid}.tmp`
  writeFileSync(tmp, '{}', { mode: 0o644 })
  chmodSync(tmp, 0o644)
  const service = createEnvironmentService({ registryFile: d.registryFile, tools: createTools(fakeHost(), d.pluginDir), home: d.root })
  const res = await service.up({ repoKey: '/old/a', branch: 'feat', worktreePath: d.worktree, settings: { enabled: true, networkAddress: false }, envVars: undefined }, () => {})
  assert.equal(res.code, 0)
  assert.equal(statSync(d.registryFile).mode & 0o777, 0o600)
  assert.equal(existsSync(tmp), false)
})

test("a failing logs or ps read rejects with docker's stderr line, never its arguments", { skip }, async (t) => {
  const d = dirs(t)
  const tools = createTools(fakeHost(), d.pluginDir)
  await assert.rejects(tools.composeLogs('twb-x-000000', d.worktree, 'docker-compose.yml', 'broken', 5), (e) => e.message === 'no such service: broken')
  await assert.rejects(tools.composePs('twb-x-000000', d.worktree, 'broken.yml'), (e) => e.message === 'service "db" has neither an image nor a build context' && !e.message.includes('--context'))
})

test("logs: past the cap the program is stopped and the read rejects; past its time it says it timed out", { skip }, async (t) => {
  const d = dirs(t)
  const tools = createTools(fakeHost(), d.pluginDir)
  let started = Date.now()
  await assert.rejects(tools.composeLogs('twb-x-000000', d.worktree, 'docker-compose.yml', 'huge', 5), (e) => e.message === "docker compose logs' output passed about 16 MiB")
  assert.ok(Date.now() - started < 10_000, 'killed, not left to sleep out its 20 s')
  started = Date.now()
  const quick = createTools(fakeHost(), d.pluginDir, { logsTimeoutMs: 500 })
  await assert.rejects(quick.composeLogs('twb-x-000000', d.worktree, 'docker-compose.yml', 'slow', 5), (e) => e.message === 'docker compose logs timed out after 0.5 s')
  assert.ok(Date.now() - started < 10_000)
  // The default is 30 s, said as such
  assert.match(readFileSync(new URL('../plugins/colima/server/tools.ts', import.meta.url), 'utf8'), /logsTimeoutMs = 30_000/)
})

test('the argv: several compose files are several -f flags, rosetta is the vz runtime, ps reads line-delimited JSON, stop streams in the plugin directory', { skip }, async (t) => {
  const d = dirs(t)
  writeFileSync(join(d.worktree, 'a.yml'), '')
  writeFileSync(join(d.worktree, 'b.yml'), '')
  const tools = createTools(fakeHost(), d.pluginDir)
  assert.equal(await tools.composeUp('twb-x-000000', d.worktree, 'a.yml, b.yml', () => {}), 0)
  assert.equal(await tools.startVm('twb-x-000000', { cpu: 1, memory: 1.5, disk: 10, networkAddress: false, rosetta: true }, () => {}), 0)
  assert.deepEqual(await tools.composePs('twb-x-000000', d.worktree, 'lines.yml'), [
    { name: 'web', state: 'running', status: 'Up', ports: [] },
    { name: 'db-1', state: 'exited', status: 'Exited (0)', ports: [] }
  ])
  const out = []
  assert.equal(await tools.stopVm('twb-x-000000', (c) => out.push(c)), 0)
  assert.equal(out.join(''), '$ colima stop twb-x-000000\nstopping twb-x-000000\n')
  assert.deepEqual(calls(), [
    `docker|${d.worktree}|--context colima-twb-x-000000 compose -f a.yml -f b.yml up -d|FOO=`,
    `colima|${d.pluginDir}|start twb-x-000000 --cpu 1 --memory 1.5 --disk 10 --vm-type vz --vz-rosetta|FOO=`,
    `docker|${d.worktree}|--context colima-twb-x-000000 compose -f lines.yml ps --format json|FOO=`,
    `colima|${d.pluginDir}|stop twb-x-000000|FOO=`
  ])
})
