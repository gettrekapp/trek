// Runs inside a Linux container (see scripts/bot-sandbox-linux.mjs): Trek's bwrap sandbox for real,
// around plain shells, python and node, against a fake userData. No Claude CLI.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probeSandbox, sandboxFor } from '../../src/host/bot/sandbox.ts'

const SECRET = 'TOPSECRET-123'
const config = join(homedir(), '.config')
mkdirSync(join(config, 'Trek Dev'), { recursive: true })
const userData = realpathSync(join(config, 'Trek Dev'))
const secret = join(userData, 'server-tokens.json')
writeFileSync(secret, SECRET)
const work = join(homedir(), 'work')
mkdirSync(work, { recursive: true })
if (!existsSync(join(work, 'link.json'))) symlinkSync(secret, join(work, 'link.json'))

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`)
}
const plan = sandboxFor('linux', userData)
check('a plan for linux', plan.ok, JSON.stringify(plan))
const { sandbox } = plan
const sh = (script) => {
  const ran = spawnSync(sandbox.command, [...sandbox.args, '/bin/sh', '-c', script], { cwd: work, encoding: 'utf8', timeout: 20_000 })
  return { status: ran.status, out: `${ran.stdout}${ran.stderr}` }
}
const hidden = (name, script) => {
  const ran = sh(script)
  check(`hidden: ${name}`, !ran.out.includes(SECRET), ran.out)
  return ran
}

const outside = spawnSync('/bin/sh', ['-c', `cat "${secret}"`], { encoding: 'utf8' })
check('outside the sandbox the file is readable, so the checks below mean something', outside.stdout === SECRET, outside.stderr)
hidden('cat', `cat "${secret}"`)
hidden('$(…)', `cat "$(echo "${userData}")/server-tokens.json"`)
hidden('a variable', `d="${config}"; cat "$d/Trek Dev/server-tokens.json"`)
hidden('a symlink', 'cat link.json')
hidden('.. in the path', `cd "${config}" && cat "./Trek Dev/../Trek Dev/server-tokens.json"`)
hidden('python3 -c', `python3 -I -c "print(open('${secret}').read())"`)
hidden('node -e', `node -e "console.log(require('fs').readFileSync('${secret}', 'utf8'))"`)
hidden('grep -R', `grep -R TOPSECRET "${config}"`)
hidden('cp -R', `cp -R "${userData}" copied; cat copied/*; rm -rf copied`)
check('listing shows an empty folder', sh(`ls -A "${userData}"`).out.trim() === '')
hidden("Trek's /proc/<pid>/root", `cat "/proc/${process.pid}/root${secret}"`)
hidden('/proc/1/root', `cat "/proc/1/root${secret}"`)
hidden('umount', `umount "${userData}" 2>&1; cat "${secret}"`)
hidden('a nested user namespace', `unshare -Urm sh -c 'umount "${userData}"; cat "${secret}"' 2>&1`)
hidden('a nested rbind', `unshare -Urm sh -c 'mkdir -p /tmp/y && mount --rbind "${config}" /tmp/y && umount "/tmp/y/Trek Dev"; cat "/tmp/y/Trek Dev/server-tokens.json"' 2>&1`)
hidden('renaming an ancestor', `mv "${config}" "${config}2" && cat "${config}2/Trek Dev/server-tokens.json"; mv "${config}2" "${config}"`)
check('the rename was put back', readFileSync(secret, 'utf8') === SECRET)
sh(`echo x > "${userData}/new.json"`)
check('a write lands in the tmpfs, not in userData', !existsSync(join(userData, 'new.json')))

// Another process of this user, outside the sandbox, with a secret in its environment (as a
// Codex session once had its MCP token). The PID namespace hides it, its /proc entry included.
const ENV_SECRET = `ENVSECRET-${process.pid}`
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { ...process.env, HELD_SECRET: ENV_SECRET }, stdio: 'ignore' })
await new Promise((done) => setTimeout(done, 300))
const environ = `/proc/${holder.pid}/environ`
check('outside the sandbox its environment is readable, so the checks below mean something', readFileSync(environ, 'utf8').includes(ENV_SECRET))
const peek = (name, script) => {
  const ran = sh(script)
  check(`hidden: ${name}`, !ran.out.includes(ENV_SECRET), ran.out)
  return ran
}
peek('its /proc/<pid>/environ', `cat ${environ}`)
peek('its /proc/<pid>/cmdline and status', `cat /proc/${holder.pid}/cmdline /proc/${holder.pid}/status`)
peek('ps with environments, every process', 'ps eww -A')
peek('every /proc/*/environ', 'cat /proc/[0-9]*/environ')
check('its pid does not exist inside', sh(`kill -0 ${holder.pid}`).status !== 0)
check('only the sandbox\'s own processes are listed', !sh('ps -A -o pid=').out.split(/\s+/).includes(String(holder.pid)))
holder.kill('SIGKILL')

for (const script of ['/usr/bin/true', 'node -e "console.log(1 + 1)"', 'echo ok > made.txt && cat made.txt && rm made.txt', 'ls / > /dev/null', `ls "${config}" > /dev/null`, 'id -u']) {
  const ran = sh(script)
  check(`works: ${script}`, ran.status === 0, ran.out)
}
check('same user inside', sh('id -u').out.trim() === String(process.getuid()))

const missing = spawnSync(sandbox.command, [...sandbox.args, '/nope/claude'], { encoding: 'utf8' })
check('a missing CLI is reported by execvp', missing.status !== 0 && /execvp \/nope\/claude: No such file or directory/.test(missing.stderr), missing.stderr)

const canary = { path: join(userData, 'bot-sandbox-canary.txt'), text: 'canary-abc' }
writeFileSync(canary.path, canary.text)
check('the probe passes', (await probeSandbox(sandbox, canary)) === null)
const noTmpfs = { command: 'bwrap', args: ['--dev-bind', '/', '/', '--die-with-parent', '--'] }
check('the probe catches a sandbox that hides nothing', /test read of Trek's data folder succeeded/.test(await probeSandbox(noTmpfs, canary)))
check('the probe catches a missing bwrap', /was not found/.test(await probeSandbox({ ...sandbox, command: '/nope/bwrap' }, canary)))

// Trek kills a turn's process group: SIGTERM, then SIGKILL after a grace. With the PID namespace,
// SIGTERM alone ends everything, a process that ignores it too, since its namespace's first process exits.
const sleepers = () => spawnSync('pgrep', ['-c', '-x', 'sleep'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(sandbox.command, [...sandbox.args, '/bin/sh', '-c', 'sleep 300 & (trap "" TERM; exec sleep 301) & wait'], { detached: true, stdio: 'ignore' })
await new Promise((done) => setTimeout(done, 800))
const before = sleepers()
process.kill(-child.pid, 'SIGTERM')
await new Promise((done) => setTimeout(done, 800))
check('a turn starts its processes', before === '2', before)
check('SIGTERM to the process group ends them all', sleepers() === '0', sleepers())
const orphan = spawn(sandbox.command, [...sandbox.args, '/bin/sh', '-c', 'sleep 300 & wait'], { stdio: 'ignore' })
await new Promise((done) => setTimeout(done, 800))
process.kill(orphan.pid, 'SIGKILL')
await new Promise((done) => setTimeout(done, 800))
check('killing bwrap alone ends the turn (--die-with-parent)', sleepers() === '0', sleepers())

const failed = results.filter((ok) => !ok).length
console.log(failed ? `LINUX SANDBOX FAIL (${failed} of ${results.length})` : `LINUX SANDBOX PASS (${results.length} checks)`)
process.exit(failed ? 1 : 0)
