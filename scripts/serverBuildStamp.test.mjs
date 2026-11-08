// scripts/serverBuildStamp.test.mjs — the build id baked into the server bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_PLACEHOLDER, stampBuild } from '../server/scripts/buildStamp.mjs'

test('stampBuild replaces every placeholder with a 12-digit hash of the bundle', () => {
  const text = `const a = "${BUILD_PLACEHOLDER}";\nconst b = "${BUILD_PLACEHOLDER}";\n`
  const { text: stamped, build } = stampBuild(text)
  assert.match(build, /^[0-9a-f]{12}$/)
  assert.equal(stamped, `const a = "${build}";\nconst b = "${build}";\n`)
  assert.equal(stamped.includes(BUILD_PLACEHOLDER), false)
})

test('the same bundle gets the same id, a changed one another', () => {
  const one = `x("${BUILD_PLACEHOLDER}")`
  assert.equal(stampBuild(one).build, stampBuild(one).build)
  assert.notEqual(stampBuild(one).build, stampBuild(`${one};y()`).build)
})

test('a bundle without the placeholder is refused', () => {
  assert.throws(() => stampBuild('no id here'), /no build placeholder/)
})
