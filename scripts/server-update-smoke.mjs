// scripts/server-update-smoke.mjs — `trek-server update`, end to end, on this machine only: a
// signed release feed served from 127.0.0.1, test builds of the server at two versions (they take
// their feed and key from the environment; a release build never does), the real launcher and
// real running servers, each with its own install folder, config and data in one temp folder.
// macOS and Linux.
//
//   node scripts/server-update-smoke.mjs
//
// Checks: a server that is not a tarball install has no control socket and cannot update;
// --check sees the newer release; with no server running the command only swaps the folder, and
// the next start settles it; a running server is updated by the command and comes back as the new
// version on the same port (with the same pid, where Node can replace a process); a signal during
// that restart wins; a running server's own look at the feed; another install's update, and a
// second server, do not get a config's control socket; SIGTERM removes it; a bad signature, a
// tampered tarball and a version that fails its selfcheck are refused with the server untouched;
// a version that dies at start is rolled back by the next launch; a usage error, a port in use, a
// missing token and a second start at the same moment are not failed starts, and roll nothing back.
// Then the same update asked for by a client, over the protocol (update.status, update.check,
// update.apply, update.changed): what the welcome lists, each refusal, the states every signed-in
// connection hears and the restart that names its version; a config that leaves installing to
// the command; a version that fails its selfcheck; an update that fails before it downloads
// anything (its lock held, the feed unverifiable) and says why, and a server that keeps answering
// while it installs. Last, an install whose bundle is a normal build
// (no update key built in): it offers clients nothing, and its command says why.
import './smokeGh.mjs'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { SUMS, WAIT_MS, canExecve, connect, control, createUpdateFixture, diesAtStart, ending, escaped, failsSelfcheck, freePort, listeningAs, listenings, stop, until, up, waitFor, within } from './updateFixture.mjs'

if (process.platform === 'win32') {
  console.log('SERVER UPDATE SMOKE SKIPPED: trek-server does not update itself on Windows')
  process.exit(0)
}

let failed = 0
let count = 0
const check = (what, ok, detail = '') => {
  count++
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}${ok || !detail ? '' : `\n  ${String(detail).trimEnd().split('\n').join('\n  ')}`}`)
  if (!ok) failed++
}

// The temp folder, the two test builds, the feed and the servers' environment (updateFixture.mjs).
const { work, OLD, NEW, oldBuild, newBuild, buildServer, installFolder, publish, feedRequests, runToEnd, world, start, cleanup } = await createUpdateFixture()

/** How a request was refused: [code, details.reason], or what it answered instead. */
const refusal = (request) => request.then((result) => ['answered', JSON.stringify(result)], (err) => [err.code ?? String(err.message ?? err), err.details?.reason])
/** The update.changed payloads a connection received, from event `from` on. */
const changes = (conn, from = 0) => conn.events.slice(from).filter(([event]) => event === 'update.changed').map(([, payload]) => payload)
/** Their states, one per run of the same state (a download is one state and many percents). */
const stateRuns = (list) => list.map((status) => status.state).filter((state, i, all) => state !== all[i - 1])
const shutdowns = (conn) => conn.events.filter(([event]) => event === 'daemon.shutdown').map(([, payload]) => payload)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** The longest a server may leave a request unanswered while it installs an update (its event loop held up) */
const MAX_ANSWER_GAP_MS = 2000
/**
 * Asks `update.status` every 50 ms until stopped: the longest time between two answers (or from
 * the last one to the stop), how many came, and the states they named. A server whose event loop
 * is held up answers nothing meanwhile: its terminals and every client wait as long.
 */
const probe = (conn) => {
  let last = Date.now()
  let longest = 0
  let answers = 0
  const states = []
  const timer = setInterval(() => {
    if (conn.isClosed) return
    conn.request('update.status').then((status) => {
      const now = Date.now()
      longest = Math.max(longest, now - last)
      last = now
      answers++
      if (states.at(-1) !== status.state) states.push(status.state)
    }, () => {})
  }, 50)
  return {
    stop: () => {
      clearInterval(timer)
      return { longest: Math.max(longest, Date.now() - last), answers, states }
    }
  }
}

check('the builds are marked as test builds', JSON.parse(readFileSync(join(oldBuild.dir, 'build.json'), 'utf8')).testUpdate === true)
{
  const longest = join(work, 'xxxx', 'c', 'control.sock')
  check('the control sockets fit a Unix socket path here', Buffer.byteLength(longest) <= 103, `${longest} is ${Buffer.byteLength(longest)} bytes (the temp folder is too deep)`)
}

/** A version that passes nothing: its selfcheck fails. */
const FAILS_SELFCHECK = failsSelfcheck(NEW)
/** A version whose selfcheck passes and whose start dies before listening. */
const DIES_AT_START = diesAtStart(NEW)

/** The welcome of the server that is not a tarball install (scenario 1), for scenario 9. */
let plainWelcome = null

// ---- 1. a server that is not a tarball install: nothing changes for it --------------------
{
  const base = join(work, 'plain')
  mkdirSync(join(base, 'c'), { recursive: true })
  const configPath = join(base, 'c', 'config.json')
  const token = randomBytes(16).toString('base64url')
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
  // updates.check is left at its default (on): what stops it here is that this is not an install.
  writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [] }), { mode: 0o600 })
  publish('good', newBuild)
  const bundle = join(oldBuild.dir, 'trek-server.cjs')
  const port = await freePort()
  const run = start(process.execPath, [bundle, 'start', '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--data-dir', join(base, 'data')], { TREK_UPDATE_FIRST_CHECK_MS: '1000' })
  check('a bundle that is not a tarball install starts', await until(run, listeningAs(OLD)), run.output)
  try {
    const client = await connect(port, token)
    plainWelcome = client.welcome
    const answers = []
    for (const [method, params] of [['update.status', {}], ['update.check', {}], ['update.apply', { version: NEW }]]) answers.push((await refusal(client.request(method, params)))[0])
    check('over the protocol it answers NOT_FOUND to update.status, update.check and update.apply', same(answers, ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']), JSON.stringify(answers))
    client.close()
  } catch (err) {
    check('a client signs in to it', false, `${err.message}\n${run.output}`)
  }
  const refused = await runToEnd(process.execPath, [bundle, 'update', '--check', '--config', configPath])
  check('its update command says it cannot update itself', refused.status === 1 && /cannot update itself here: .*not installed from a release tarball/.test(refused.stderr), refused.out)
  check('it has no control socket, and says nothing about updates', !existsSync(join(base, 'c', 'control.sock')) && !existsSync(join(base, 'c', 'update-state.json')) && !/update:/.test(run.output), run.output)
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 2. --check; then, with no server running, the command only swaps the folder ----------
{
  const w = await world('check')
  publish('good', newBuild)
  const checked = await w.cli(['update', '--check'])
  check(`update --check reports ${NEW}`, checked.status === 0 && checked.out.includes(`trek-server ${OLD}; ${NEW} is available`), checked.out)
  check('--check installs nothing', w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`))
  check('the check is remembered', w.state().latest === NEW && typeof w.state().lastCheckAt === 'string', JSON.stringify(w.state()))
  const unasked = await w.cli(['update'])
  check('without --yes and without a terminal, it does not install', unasked.status === 1 && /update --yes/.test(unasked.stderr) && w.versionAt(w.install) === OLD, unasked.out)

  const updated = await w.cli(['update', '--yes'])
  check('with no server running, update --yes installs, and says a running server would need a restart', updated.status === 0 && updated.out.includes(`Updated to trek-server ${NEW}`) && /already running from this install still runs the old version/.test(updated.out), updated.out)
  check('the install path holds the new version, the old one is kept', w.versionAt(w.install) === NEW && w.versionAt(`${w.install}.previous`) === OLD)
  check('it is marked as not started yet', w.marks().join() === 'update-pending.json', w.marks().join())
  check('nothing is left beside the install', readdirSync(join(w.base, 'opt')).filter((entry) => entry.startsWith('.trek-update')).length === 0, readdirSync(join(w.base, 'opt')).join(' '))
  const again = await w.cli(['update', '--yes'])
  check('a second update finds nothing newer', again.status === 0 && again.out.includes(`trek-server ${NEW} is the latest version`), again.out)
  const run = start(w.launcher, w.startArgs)
  check(`the next start is ${NEW}, and settles the update`, (await up(w, run, NEW)) && (await until(run, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))), run.output)
  check('the markers are gone and the result is recorded', w.marks().length === 0 && w.state().lastResult?.ok === true && w.state().lastResult?.to === NEW, `${w.marks().join()} ${JSON.stringify(w.state())}`)

  // A launcher that cannot be run: the server says so before it shuts anything down, and stays up.
  if (canExecve) {
    chmodSync(w.launcher, 0o644)
    const listener = await connect(w.port, w.token)
    const refused = await control(w.socket, 'relaunch')
    check('a relaunch into a launcher that cannot be run is refused', refused?.ok === false && /bin\/trek-server is missing or cannot be run/.test(refused.error ?? ''), JSON.stringify(refused))
    // The command asks for a restart only once it has installed: a refusal is told to the clients, with the status as it is now.
    const told = await waitFor(() => changes(listener).length > 0, 5000)
    check('and a connected client is sent the server\'s update status: a restart that was refused is not kept from it', told && changes(listener).length === 1 && changes(listener)[0].current === NEW && changes(listener)[0].state === 'idle', JSON.stringify(listener.events))
    listener.close()
    await new Promise((done) => setTimeout(done, 500))
    check('and the server keeps serving', run.ended === null && !/shutting down/.test(run.output) && (await control(w.socket, 'status'))?.pid === run.child.pid, run.output)
    chmodSync(w.launcher, 0o755)
  }

  // A signal while the server restarts for an update: it exits instead (a service manager stopping the unit wins).
  if (canExecve) {
    const answer = await control(w.socket, 'relaunch', (a) => {
      if (a?.ok === true) run.child.kill('SIGTERM')
    })
    check('the server accepts a relaunch request', answer?.ok === true, JSON.stringify(answer))
    const ended = await ending(run)
    check('SIGTERM during the restart ends the server instead', ended?.code === 0 && /update: SIGTERM during the restart; exiting instead/.test(run.output) && listenings(run, w.port) === 1, `${JSON.stringify(ended)}\n${run.output}`)
    check('and its control socket is gone', !existsSync(w.socket))
  } else {
    const answer = await control(w.socket, 'relaunch')
    check('this Node cannot replace a process: a relaunch request is refused', answer?.ok === false && /cannot replace a running process/.test(answer.error ?? ''), JSON.stringify(answer))
    await stop(run)
  }
}

// ---- 3. a running server is updated by the command ---------------------------------------
{
  const w = await world('live')
  publish('good', newBuild)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const pid = run.child.pid
  const status = await control(w.socket, 'status')
  check('its control socket says what is running', status?.pid === pid && status?.version === OLD && status?.installDir === w.install && status?.sessions === 0 && status?.canRelaunch === canExecve, JSON.stringify(status))

  const updated = await w.cli(['update', '--yes'])
  check('update --yes installs while the server runs', updated.status === 0 && updated.out.includes(`Installed trek-server ${NEW}`), updated.out)
  if (canExecve) {
    check('the command says the server is now the new version', updated.out.includes(`the running server (pid ${pid}) is now running ${NEW}`), updated.out)
    check(`the same process comes back as ${NEW}`, await up(w, run, NEW), run.output)
    check('on the same port', listenings(run, w.port) === 2, run.output)
    check('with the same pid', run.ended === null && (await control(w.socket, 'status'))?.pid === pid)
    check('the shutdown named the update', /update — shutting down/.test(run.output), run.output)
    check('the update is settled', (await until(run, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))) && w.state().lastResult?.ok === true && w.marks().length === 0, `${w.marks().join()} ${JSON.stringify(w.state())}`)
    check('the old version is kept beside it', w.versionAt(`${w.install}.previous`) === OLD)
    const latest = await w.cli(['update', '--check'])
    check('and it is now the latest version', latest.status === 0 && latest.out.includes(`trek-server ${NEW} is the latest version`), latest.out)
    const ended = await stop(run)
    check('SIGTERM stops the restarted server', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
  } else {
    check('this Node cannot replace a process: the command says a restart finishes it', new RegExp(`Restart the running server \\(pid ${pid}\\) to finish`).test(updated.out), updated.out)
    check(`${OLD} is still running, with the update not started yet`, run.ended === null && listenings(run, w.port) === 1 && w.marks().join() === 'update-pending.json', run.output)
    const ended = await stop(run)
    check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
    const next = start(w.launcher, w.startArgs)
    check(`the next start is ${NEW}, and settles the update`, (await up(w, next, NEW)) && (await until(next, new RegExp(`update: now running trek-server ${escaped(NEW)} \\(was ${escaped(OLD)}\\)`))) && w.marks().length === 0, next.output)
    await stop(next)
  }
}

// ---- 4. one config, one control socket: the daily check, another install, a second server --
{
  const w = await world('own', { check: true })
  publish('good', newBuild)
  // A test build's knob: the first look at the feed a second after listening, not thirty.
  const run = start(w.launcher, w.startArgs, { TREK_UPDATE_FIRST_CHECK_MS: '2000' })
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  // Signed in before that first look: the server's own check is heard like one a client asked for.
  const listener = await connect(w.port, w.token)
  const heard = await waitFor(() => changes(listener).some((status) => status.state === 'idle' && status.latest === NEW))
  check('a connected client hears what the server\'s own check finds', heard && same(stateRuns(changes(listener)), ['checking', 'idle']), JSON.stringify(listener.events))
  listener.close()
  check('the running server finds the newer release by itself', (await until(run, new RegExp(`update: trek-server ${escaped(NEW)} is available \\(this is ${escaped(OLD)}\\)`))) && w.state().latest === NEW, `${run.output}\n${JSON.stringify(w.state())}`)

  // Another install folder, pointed at the same config.
  const other = installFolder(join(w.base, 'opt2', 'trek-server'), OLD, oldBuild)
  const refused = await runToEnd(join(other, 'bin', 'trek-server'), ['update', '--yes', '--config', w.configPath])
  check('another install does not update under a running server', refused.status === 1 && refused.stderr.includes(`(pid ${run.child.pid}) is another install, ${w.install}`), refused.out)
  check('and neither install changed', w.versionAt(w.install) === OLD && w.versionAt(other) === OLD && !existsSync(`${other}.previous`) && !existsSync(`${w.install}.previous`) && !/shutting down/.test(run.output), run.output)

  // A second server with the same config: the first keeps the socket.
  const second = start(w.launcher, ['start', '--config', w.configPath, '--host', '127.0.0.1', '--port', String(await freePort()), '--data-dir', join(w.base, 'data2')])
  check('a second server with the same config runs without the control socket', (await until(second, listeningAs(OLD))) && (await until(second, /update: no control socket at .*another trek-server is running with this config and has it/)), second.output)
  const secondEnded = await stop(second)
  check('stopping it leaves the first one\'s socket alone', secondEnded?.code === 0 && (await control(w.socket, 'status'))?.pid === run.child.pid, `${JSON.stringify(secondEnded)}\n${second.output}`)

  const ended = await stop(run)
  check('SIGTERM stops the server and removes its control socket', ended?.code === 0 && !existsSync(w.socket) && !existsSync(`${w.socket}.lock`), `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 5. a release that is not what was signed --------------------------------------------
for (const [name, what, tamper, message] of [
  ['sig', 'a SHA256SUMS signed by another key', (files) => files.set(`${SUMS}.sig`, Buffer.from(sign(null, files.get(SUMS), generateKeyPairSync('ed25519').privateKey).toString('base64'))), /no valid signature/],
  ['tar', 'a tarball changed after it was signed', (files, path) => files.set(path, Buffer.concat([files.get(path), Buffer.from('x')])), /the download's sha256 is/]
]) {
  const w = await world(name)
  publish(name, newBuild, tamper)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const updated = await w.cli(['update', '--yes'])
  check(`${what} is refused`, updated.status === 1 && message.test(updated.out), updated.out)
  check('and the running server is untouched', run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && !/shutting down/.test(run.output), run.output)
  await stop(run)
}

// ---- 6. a version that fails its selfcheck -----------------------------------------------
{
  const w = await world('self')
  publish('fails-selfcheck', FAILS_SELFCHECK)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const updated = await w.cli(['update', '--yes'])
  check('a version that fails its selfcheck is refused before the swap', updated.status === 1 && /does not run on this machine/.test(updated.out) && /simulated: this version cannot run here/.test(updated.out), updated.out)
  check('the running server and its install are untouched', run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && !/shutting down/.test(run.output), run.output)
  check('the failure is recorded', w.state().lastResult?.ok === false && w.state().lastResult?.to === NEW, JSON.stringify(w.state()))
  check('nothing is left beside the install', readdirSync(join(w.base, 'opt')).filter((entry) => entry.startsWith('.trek-update')).length === 0, readdirSync(join(w.base, 'opt')).join(' '))
  await stop(run)
}

// ---- 7. a version that dies at start is rolled back by the next launch -------------------
{
  const w = await world('dies')
  publish('dies-at-start', DIES_AT_START)
  const updated = await w.cli(['update', '--yes'])
  check('a version whose selfcheck passes installs', updated.status === 0 && w.versionAt(w.install) === NEW, updated.out)
  // The first launch (a service manager, or the user): the new version dies.
  const first = start(w.launcher, w.startArgs)
  const firstEnded = await ending(first)
  check('the new version dies at its first start', firstEnded?.code === 1 && (await until(first, /dies at start/)), `${JSON.stringify(firstEnded)}\n${first.output}`)
  check('that start was marked tried', w.marks().join() === 'update-pending.json,update-pending.tried', w.marks().join())
  // The next launch: the launcher puts the old version back.
  const second = start(w.launcher, w.startArgs)
  check(`the next launch goes back to ${OLD}`, (await up(w, second, OLD)) && /going back to the version before it/.test(second.output), second.output)
  check('the install path holds the old version again; the failed one is set aside', w.versionAt(w.install) === OLD && w.versionAt(`${w.install}.failed`) === NEW && !existsSync(`${w.install}.previous`))
  check('the restored server reports the failed update', await until(second, new RegExp(`update: trek-server ${escaped(NEW)} did not start; went back to ${escaped(OLD)}`)), second.output)
  check('and records it', w.state().lastResult?.ok === false && /did not start/.test(w.state().lastResult?.error ?? '') && w.marks().length === 0, `${w.marks().join()} ${JSON.stringify(w.state())}`)
  const ended = await stop(second)
  check('SIGTERM stops the restored server', ended?.code === 0, `${JSON.stringify(ended)}\n${second.output}`)
}

// ---- 8. starts that end before listening, or at the same moment, are not failed starts -----
{
  const w = await world('ends')
  publish('good', newBuild)
  const updated = await w.cli(['update', '--yes'])
  check('an update with no server running installs', updated.status === 0 && w.versionAt(w.install) === NEW, updated.out)
  const pendingOnly = () => w.marks().join() === 'update-pending.json'
  const notRolledBack = () => w.versionAt(w.install) === NEW && w.versionAt(`${w.install}.previous`) === OLD && !existsSync(`${w.install}.failed`)

  // The launcher takes these for a start (it does not know every flag); the server refuses them.
  for (const args of [['--prot', '7000'], [`--port=${w.port}`], ['start', 'help']]) {
    const refused = await runToEnd(w.launcher, args)
    check(`\`trek-server ${args.join(' ')}\` is a usage error, and leaves the update untried`, refused.status === 2 && /Usage: trek-server/.test(refused.stderr) && pendingOnly() && notRolledBack(), `${refused.status} ${w.marks().join()}\n${refused.out}`)
  }

  // Something else has the port.
  const squatter = createNetServer()
  await new Promise((done) => squatter.listen(w.port, '127.0.0.1', done))
  const busy = await runToEnd(w.launcher, w.startArgs)
  check('a start whose port is in use fails, and leaves the update untried', busy.status === 1 && /already in use/.test(busy.stderr) && pendingOnly() && notRolledBack(), `${busy.status} ${w.marks().join()}\n${busy.out}`)
  await new Promise((done) => squatter.close(done))

  // No token configured.
  const bare = join(w.base, 'c', 'bare.json')
  writeFileSync(bare, JSON.stringify({ repos: [] }), { mode: 0o600 })
  const tokenless = await runToEnd(w.launcher, ['start', '--config', bare, '--host', '127.0.0.1', '--port', String(w.port), '--data-dir', join(w.base, 'data')])
  check('a start with no token configured fails, and leaves the update untried', tokenless.status === 1 && /No token configured/.test(tokenless.stderr) && pendingOnly() && notRolledBack(), `${tokenless.status} ${w.marks().join()}\n${tokenless.out}`)

  // Two starts of one install at the same moment (two units, or a start by hand beside a service
  // manager's): the second comes while the first is marked tried and not listening yet.
  const first = start(w.launcher, w.startArgs)
  const marked = await waitFor(() => existsSync(join(w.install, 'update-pending.tried')) || first.ended !== null)
  const second = start(w.launcher, ['start', '--config', w.configPath, '--host', '127.0.0.1', '--port', String(await freePort()), '--data-dir', join(w.base, 'data2')])
  check('the first start is marked tried while it starts', marked && first.ended === null, first.output)
  check(`both starts come up as ${NEW}`, (await until(first, listeningAs(NEW))) && (await until(second, listeningAs(NEW))), `${first.output}\n---\n${second.output}`)
  check('neither moved the install from under the other', notRolledBack() && !/going back/.test(first.output + second.output), `${first.output}\n---\n${second.output}`)
  check('and the update is settled', (await waitFor(() => w.marks().length === 0)) && w.state().lastResult?.ok === true && w.state().lastResult?.to === NEW, `${w.marks().join()} ${JSON.stringify(w.state())}`)
  const ends = [await stop(second), await stop(first)]
  check('SIGTERM stops both', ends.every((e) => e?.code === 0), JSON.stringify(ends))
}

// ---- 9. the same update, asked for by a client over the protocol --------------------------
{
  const w = await world('wire')
  publish('good', newBuild)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const pid = run.child.pid
  const a = await connect(w.port, w.token)
  // Signed in and subscribed to nothing.
  const b = await connect(w.port, w.token)
  // Never signs in (the server closes it after its five seconds for a hello).
  const stranger = await connect(w.port, '', { hello: false })

  check('the welcome of a tarball install lists `update`; the one of a server that is not an install does not', a.welcome.capabilities.includes('update') && plainWelcome !== null && !plainWelcome.capabilities.includes('update'), `${JSON.stringify(a.welcome.capabilities)}\n${JSON.stringify(plainWelcome?.capabilities)}`)
  const first = await a.request('update.status')
  check('update.status says what is running, idle, with nothing found yet', same(first, { current: OLD, state: 'idle', sessions: 0, canRelaunch: canExecve, restartNeeded: false, remoteApply: true }), JSON.stringify(first))
  const early = await refusal(a.request('update.apply', { version: NEW }))
  check('update.apply before any check is refused as stale', same(early, ['CONFLICT', 'stale']), JSON.stringify(early))

  const checked = await a.request('update.check')
  check(`update.check answers that ${NEW} is the latest`, checked.latest === NEW && checked.state === 'idle' && typeof checked.checkedAt === 'string', JSON.stringify(checked))
  // b has both changes by the time it is answered: a connection's frames arrive in order.
  await b.request('sys.ping', { t: 1 })
  check('the other connection heard update.changed: checking, then idle with the latest', same(changes(b).map((status) => [status.state, status.latest]), [['checking', undefined], ['idle', NEW]]), JSON.stringify(b.events))
  check('a connection that has not signed in was sent nothing', stranger.frames === 0, String(stranger.frames))
  stranger.close()
  const other = await refusal(a.request('update.apply', { version: '9.9.9' }))
  check('update.apply of a version that is not the latest is refused as stale', same(other, ['CONFLICT', 'stale']), JSON.stringify(other))
  check('nothing was installed by any of that', w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0, w.marks().join())

  // Sent together: the server reads them in order, so the second and third find the first's update running.
  const mark = { a: a.events.length, b: b.events.length }
  const [started, second, checking] = await Promise.all([
    a.request('update.apply', { version: NEW }).catch((err) => err),
    refusal(a.request('update.apply', { version: NEW })),
    refusal(b.request('update.check'))
  ])
  check('update.apply of the latest answers that it has started', same(started, { started: true }), JSON.stringify(started))
  check('while it runs, a second update.apply and an update.check are refused as busy', same(second, ['CONFLICT', 'busy']) && same(checking, ['CONFLICT', 'busy']), `${JSON.stringify(second)} ${JSON.stringify(checking)}`)

  const heardBy = (conn, from) => {
    const list = changes(conn, from)
    const percents = list.filter((status) => status.state === 'downloading' && status.percent !== undefined).map((status) => status.percent)
    return { list, runs: stateRuns(list), percents }
  }
  const rising = (percents) => percents.length > 0 && percents.length <= 101 && percents.at(-1) === 100 && percents.every((p, i) => i === 0 || p > percents[i - 1])
  if (canExecve) {
    const gone = (await within(a.closed)) && (await within(b.closed))
    check('both connections are closed by the restart', gone, `${JSON.stringify(a.events)}\n${run.output}`)
    for (const [name, conn, from] of [['the connection that asked', a, mark.a], ['the other connection', b, mark.b]]) {
      const { runs, percents } = heardBy(conn, from)
      check(`${name} heard checking, downloading, installing, restarting`, same(runs, ['checking', 'downloading', 'installing', 'restarting']), JSON.stringify(conn.events.slice(from)))
      check(`${name} heard the download as a percent that rises to 100, each one once`, rising(percents), JSON.stringify(percents))
      const tail = conn.events.slice(-2)
      check(`then, last, daemon.shutdown naming the update and ${NEW}`, shutdowns(conn).length === 1 && tail[0]?.[0] === 'update.changed' && tail[0][1].state === 'restarting' && same(tail[1], ['daemon.shutdown', { reason: 'update', version: NEW }]), JSON.stringify(tail))
    }
    check(`the same process comes back as ${NEW}, on the same port`, (await up(w, run, NEW)) && listenings(run, w.port) === 2 && run.ended === null && (await control(w.socket, 'status'))?.pid === pid, run.output)
    const c = await connect(w.port, w.token)
    check(`a new connection's welcome says ${NEW}, and still lists \`update\``, c.welcome.daemonVersion === NEW && c.welcome.capabilities.includes('update'), JSON.stringify(c.welcome))
    const after = await c.request('update.status')
    check('update.status says it is the new version, with nothing newer and the update a success', after.current === NEW && after.latest === undefined && after.state === 'idle' && after.restartNeeded === false && after.lastResult?.ok === true && after.lastResult.from === OLD && after.lastResult.to === NEW, JSON.stringify(after))
    check('the old version is kept beside it, and nothing is left of the update', w.versionAt(`${w.install}.previous`) === OLD && w.marks().length === 0 && readdirSync(join(w.base, 'opt')).filter((entry) => entry.startsWith('.trek-update')).length === 0, `${w.marks().join()} ${readdirSync(join(w.base, 'opt')).join(' ')}`)
    c.close()
  } else {
    // This Node cannot replace a process: the install finishes and waits for a restart by hand.
    const settled = await waitFor(() => changes(a, mark.a).at(-1)?.state === 'idle' && changes(b, mark.b).at(-1)?.state === 'idle')
    check('the update ends without a restart', settled, `${JSON.stringify(a.events.slice(mark.a))}\n${run.output}`)
    for (const [name, conn, from] of [['the connection that asked', a, mark.a], ['the other connection', b, mark.b]]) {
      const { list, runs, percents } = heardBy(conn, from)
      check(`${name} heard checking, downloading, installing, idle`, same(runs, ['checking', 'downloading', 'installing', 'idle']), JSON.stringify(conn.events.slice(from)))
      check(`${name} heard the download as a percent that rises to 100, each one once`, rising(percents), JSON.stringify(percents))
      check('the last change says a restart is needed, and no shutdown was sent', list.at(-1)?.restartNeeded === true && shutdowns(conn).length === 0 && !conn.isClosed, JSON.stringify(conn.events.slice(-2)))
    }
    const after = await a.request('update.status')
    check(`the server still runs ${OLD}, with ${NEW} installed and not started`, after.current === OLD && after.restartNeeded === true && after.canRelaunch === false && run.ended === null && listenings(run, w.port) === 1 && w.versionAt(w.install) === NEW && w.marks().join() === 'update-pending.json', `${JSON.stringify(after)}\n${run.output}`)
    a.close()
    b.close()
  }
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 10. a config that leaves installing to the command on the machine --------------------
{
  const w = await world('off', { check: false, remoteApply: false })
  publish('good', newBuild)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const pid = run.child.pid
  const a = await connect(w.port, w.token)
  const status = await a.request('update.status')
  check('with updates.remoteApply false, update.status says so', status.remoteApply === false && a.welcome.capabilities.includes('update'), JSON.stringify(status))
  const found = await a.request('update.check')
  const refused = await refusal(a.request('update.apply', { version: NEW }))
  check('update.check still looks, and update.apply is refused as disabled', found.latest === NEW && same(refused, ['CONFLICT', 'disabled']), `${JSON.stringify(found)} ${JSON.stringify(refused)}`)
  check('the install is untouched', w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && !/shutting down/.test(run.output), run.output)

  // The setting is read at each request: an edit to the config needs no restart.
  const setRemoteApply = (value) => {
    const config = JSON.parse(readFileSync(w.configPath, 'utf8'))
    config.updates = { ...config.updates, remoteApply: value }
    writeFileSync(`${w.configPath}.smoke`, JSON.stringify(config, null, 2), { mode: 0o600 })
    renameSync(`${w.configPath}.smoke`, w.configPath)
  }
  /** Asks until update.status says `value` (the server reloads its config a moment after the file changes). */
  const saysRemoteApply = async (value) => {
    const deadline = Date.now() + WAIT_MS
    let last
    while (Date.now() < deadline) {
      last = await a.request('update.status')
      if (last.remoteApply === value) return true
      await new Promise((done) => setTimeout(done, 50))
    }
    return false
  }
  // A second client that asks nothing: it is told.
  const quiet = await connect(w.port, w.token)
  const mark = quiet.events.length
  setRemoteApply(true)
  const on = await saysRemoteApply(true)
  const toldOn = await waitFor(() => changes(quiet, mark).at(-1)?.remoteApply === true, 5000)
  setRemoteApply(false)
  const off = await saysRemoteApply(false)
  const toldOff = await waitFor(() => changes(quiet, mark).at(-1)?.remoteApply === false, 5000)
  const again = await refusal(a.request('update.apply', { version: NEW }))
  check('an edit to the config is followed without a restart, both ways', on && off && same(again, ['CONFLICT', 'disabled']) && w.versionAt(w.install) === OLD, `${on} ${off} ${JSON.stringify(again)}`)
  check('and every client hears it (update.changed), once each way, without asking', toldOn && toldOff && same(changes(quiet, mark).map((status) => status.remoteApply), [true, false]), JSON.stringify(quiet.events.slice(mark)))
  quiet.close()

  const updated = await w.cli(['update', '--yes'])
  check('`trek-server update --yes` on the machine still installs', updated.status === 0 && updated.out.includes(`Installed trek-server ${NEW}`) && w.versionAt(w.install) === NEW, updated.out)
  if (canExecve) {
    check('the client of a server restarted by the command is told the version too', (await within(a.closed)) && same(a.events.at(-1), ['daemon.shutdown', { reason: 'update', version: NEW }]), JSON.stringify(a.events.slice(-2)))
    check(`the same process comes back as ${NEW}`, (await up(w, run, NEW)) && run.ended === null && (await control(w.socket, 'status'))?.pid === pid, run.output)
  } else {
    // The command asked this server to restart, and was refused: the client is told, without asking.
    const told = await waitFor(() => changes(a).at(-1)?.restartNeeded === true, 5000)
    check('this Node cannot replace a process: the client hears that a restart is needed (update.changed), though the command installed it', told && changes(a).at(-1).current === OLD && changes(a).at(-1).state === 'idle', JSON.stringify(a.events.slice(-3)))
    const waiting = await a.request('update.status')
    check('and update.status says so, whoever installed it', waiting.current === OLD && waiting.restartNeeded === true && shutdowns(a).length === 0, JSON.stringify(waiting))
    a.close()
  }
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 11. a version that fails its selfcheck, asked for by a client ------------------------
{
  const w = await world('wbad')
  publish('fails-selfcheck', FAILS_SELFCHECK)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const a = await connect(w.port, w.token)
  const found = await a.request('update.check')
  const mark = a.events.length
  const started = await a.request('update.apply', { version: NEW }).catch((err) => err)
  check('update.apply of a version that will fail its selfcheck starts', found.latest === NEW && same(started, { started: true }), `${JSON.stringify(found)} ${JSON.stringify(started)}`)
  const settled = await waitFor(() => changes(a, mark).at(-1)?.state === 'idle')
  check('its states are checking, downloading, installing, then idle again', settled && same(stateRuns(changes(a, mark)), ['checking', 'downloading', 'installing', 'idle']), JSON.stringify(a.events.slice(mark)))
  const last = changes(a, mark).at(-1)
  const after = await a.request('update.status')
  const failedAsSaid = (status) => status?.lastResult?.ok === false && status.lastResult.to === NEW && /does not run on this machine/.test(status.lastResult.error ?? '') && /simulated: this version cannot run here/.test(status.lastResult.error ?? '')
  check('the last change and update.status carry the failure, with the selfcheck\'s own words', failedAsSaid(last) && failedAsSaid(after) && after.restartNeeded === false, `${JSON.stringify(last)}\n${JSON.stringify(after)}`)
  const ping = await a.request('sys.ping', { t: 7 }).catch((err) => err)
  check(`no shutdown: the server still runs ${OLD} and answers`, shutdowns(a).length === 0 && !a.isClosed && same(ping, { t: 7 }) && after.current === OLD && run.ended === null && !/shutting down/.test(run.output) && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0, `${JSON.stringify(ping)}\n${run.output}`)
  check('nothing is left beside the install', readdirSync(join(w.base, 'opt')).filter((entry) => entry.startsWith('.trek-update')).length === 0, readdirSync(join(w.base, 'opt')).join(' '))
  a.close()
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 12. a client-asked update that fails before it downloads anything says why -----------
{
  const w = await world('early')
  publish('good', newBuild)
  const run = start(w.launcher, w.startArgs)
  check(`${OLD} is running`, await up(w, run, OLD), run.output)
  const a = await connect(w.port, w.token)
  const found = await a.request('update.check')
  /** update.apply of NEW, to its end: what it answered, the changes it sent, and the status after. */
  const attempt = async () => {
    const mark = a.events.length
    const started = await a.request('update.apply', { version: NEW }).catch((err) => err)
    const settled = await waitFor(() => changes(a, mark).at(-1)?.state === 'idle')
    return { started, settled, heard: changes(a, mark), after: await a.request('update.status') }
  }

  // The update's lock, held by a live process (this one), taken the way lock.ts takes it: a private
  // folder that already holds the holder's file (named for it, holding its process id), renamed
  // into the lock's place. `trek-server update` running on the machine looks the same.
  const parent = join(w.base, 'opt')
  const lock = join(parent, '.trek-update.lock')
  const mine = mkdtempSync(join(parent, '.trek-update-lock-'))
  writeFileSync(join(mine, `${process.pid}-${randomBytes(6).toString('hex')}`), `${process.pid}\n`, { flag: 'wx' })
  renameSync(mine, lock)
  const locked = await attempt()
  check('with the update\'s lock held by a live process, update.apply starts, and ends at idle', found.latest === NEW && same(locked.started, { started: true }) && locked.settled && same(stateRuns(locked.heard), ['checking', 'idle']), `${JSON.stringify(locked.started)} ${JSON.stringify(locked.heard)}`)
  const lockedAsSaid = (status) => status?.lastResult?.ok === false && status.lastResult.from === OLD && status.lastResult.to === NEW && (status.lastResult.error ?? '').includes(`${lock} is its lock`) && status.latest === NEW
  check('its last change and update.status say why: a failed update to the release, naming the lock', lockedAsSaid(locked.heard.at(-1)) && lockedAsSaid(locked.after), `${JSON.stringify(locked.heard.at(-1))}\n${JSON.stringify(locked.after)}`)
  check('nothing is recorded for the update that holds the lock, and nothing was touched', w.state().lastResult === undefined && existsSync(lock) && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && run.ended === null, `${JSON.stringify(w.state())}\n${run.output}`)
  rmSync(lock, { recursive: true, force: true })

  // The feed fails once the install has begun (here: its signature no longer verifies).
  publish('sig', newBuild, (files) => files.set(`${SUMS}.sig`, Buffer.from(sign(null, files.get(SUMS), generateKeyPairSync('ed25519').privateKey).toString('base64'))))
  const unsigned = await attempt()
  const unsignedAsSaid = (status) => status?.lastResult?.ok === false && status.lastResult.to === NEW && /no valid signature/.test(status.lastResult.error ?? '') && status.latest === NEW
  check('a feed that fails during the install: the status carries a failed update to the release, with the reason', same(unsigned.started, { started: true }) && unsigned.settled && unsignedAsSaid(unsigned.heard.at(-1)) && unsignedAsSaid(unsigned.after) && w.state().lastResult?.to === NEW, `${JSON.stringify(unsigned.heard.at(-1))}\n${JSON.stringify(unsigned.after)}`)
  check(`after both, the server still runs ${OLD}, untouched, with nothing left beside the install`, run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0 && readdirSync(parent).filter((entry) => entry.startsWith('.trek-update')).length === 0, `${readdirSync(parent).join(' ')}\n${run.output}`)

  // The release is good again: while it is unpacked, checked and flushed to disk, the server keeps answering.
  publish('good', newBuild)
  const mark = a.events.length
  const probing = probe(a)
  const started = await a.request('update.apply', { version: NEW }).catch((err) => err)
  const over = await waitFor(() => ['restarting', 'idle'].includes(changes(a, mark).at(-1)?.state))
  const measured = probing.stop()
  console.log(`  (the longest wait for an answer during the install: ${measured.longest} ms, over ${measured.answers} answers)`)
  check('Try again with the release good: the update installs', same(started, { started: true }) && over && stateRuns(changes(a, mark)).includes('installing') && w.versionAt(w.install) === NEW, `${JSON.stringify(started)} ${JSON.stringify(stateRuns(changes(a, mark)))}\n${run.output}`)
  check(`and while it installs the server keeps answering: update.status says \`installing\`, and no answer takes ${MAX_ANSWER_GAP_MS / 1000} s`, measured.states.includes('installing') && measured.longest < MAX_ANSWER_GAP_MS, JSON.stringify(measured))
  if (canExecve) check(`the server comes back as ${NEW}`, (await within(a.closed)) && (await up(w, run, NEW)), run.output)
  a.close()
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

// ---- 13. an install with no update key built in (a normal build) offers clients nothing ----
{
  const normal = { dir: buildServer('normal', { test: false }) }
  const built = JSON.parse(readFileSync(join(normal.dir, 'build.json'), 'utf8'))
  check('a normal build is not a test build', built.testUpdate === undefined && typeof built.version === 'string', JSON.stringify(built))
  const w = await world('nokey', { bundle: normal, version: built.version })
  // A newer signed release is there, and the environment names the feed and its key: a normal build reads neither.
  publish('good', newBuild)
  const asked = feedRequests()
  const run = start(w.launcher, w.startArgs)
  check('an install of a normal build starts, and creates its control socket', (await up(w, run, built.version)) && (await control(w.socket, 'status'))?.pid === run.child.pid, run.output)
  try {
    const client = await connect(w.port, w.token)
    check('its welcome does not list `update`', !client.welcome.capabilities.includes('update'), JSON.stringify(client.welcome.capabilities))
    const answer = await refusal(client.request('update.status'))
    check('and it answers NOT_FOUND to update.status', answer[0] === 'NOT_FOUND', JSON.stringify(answer))
    client.close()
  } catch (err) {
    check('a client signs in to it', false, `${err.message}\n${run.output}`)
  }
  const checked = await w.cli(['update', '--check'])
  check('`trek-server update --check` on it exits 1, saying it has no update key', checked.status === 1 && /has no update key built in/.test(checked.stderr), checked.out)
  check('the feed was never asked, and nothing changed', feedRequests() === asked && w.versionAt(w.install) === built.version && w.marks().length === 0 && run.ended === null, `${feedRequests() - asked} requests\n${run.output}`)
  const ended = await stop(run)
  check('SIGTERM stops it', ended?.code === 0, `${JSON.stringify(ended)}\n${run.output}`)
}

cleanup()
process.removeListener('exit', cleanup)
if (failed > 0) {
  console.log(`SERVER UPDATE SMOKE FAIL (${failed} of ${count} checks failed)`)
  process.exit(1)
}
console.log(`SERVER UPDATE SMOKE PASS (${count} checks)`)
process.exit(0)
