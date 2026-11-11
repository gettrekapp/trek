import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, mismatches, PACKAGES, setVersion, versionFromTag } from './set-version.mjs'

test('versionFromTag: v-prefixed, bare and ref tags; prereleases; junk refused', () => {
  assert.equal(versionFromTag('v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('1.2.3'), '1.2.3')
  assert.equal(versionFromTag('refs/tags/v0.3.0-rc.1'), '0.3.0-rc.1')
  for (const bad of ['v1.2', 'vx.y.z', '', undefined, 'v1.2.3 ', 'v1.2.3/../x']) assert.equal(versionFromTag(bad), undefined, String(bad))
})

test('setVersion writes every package.json and lock root; mismatches names the stragglers', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'set-version-')) + '/'
  t.after(() => rmSync(base, { recursive: true, force: true }))
  for (const dir of PACKAGES) {
    if (dir) mkdirSync(base + dir)
    writeFileSync(`${base}${dir}package.json`, JSON.stringify({ name: dir || 'root', version: '0.1.0' }, null, 2) + '\n')
    writeFileSync(`${base}${dir}package-lock.json`, JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/x': { version: '0.1.0' } } }))
  }
  assert.deepEqual(mismatches('0.4.0', base), ['package.json: 0.1.0', 'server/package.json: 0.1.0', 'relay/package.json: 0.1.0'])
  setVersion('0.4.0', base)
  assert.deepEqual(mismatches('0.4.0', base), [])
  const lock = JSON.parse(readFileSync(`${base}server/package-lock.json`, 'utf8'))
  assert.deepEqual([lock.version, lock.packages[''].version, lock.packages['node_modules/x'].version], ['0.4.0', '0.4.0', '0.1.0'])
  assert.ok(readFileSync(`${base}package.json`, 'utf8').endsWith('}\n'))
})

test('compareVersions: numeric parts, and a prerelease below its release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.2.0', '0.2.0') === 0)
  assert.ok(compareVersions('0.3.0-rc.1', '0.3.0') < 0)
  assert.ok(compareVersions('0.3.0', '0.2.0') > 0)
  assert.ok(compareVersions('0.3.0-rc.1', '0.3.0-rc.2') < 0)
})
