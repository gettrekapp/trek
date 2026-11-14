// scripts/signSums.test.mjs — the release's checksum signing: a key pair is generated to a file
// (the private key never printed), and SHA256SUMS is signed only with a key the server will accept.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRIVATE_KEY_FILE, generate, signSums } from './sign-sums.mjs'
import { verifySums } from '../server/src/update/feed.ts'
import { removeDir } from './testPlatform.mjs'

const SUMS = `${'a'.repeat(64)}  trek-server-0.5.0-linux-x64.tar.gz\n`
const temp = () => mkdtempSync(join(tmpdir(), 'trek-sign-sums-'))

test('generate writes the private key to a 0600 file and returns only the public key', () => {
  const dir = temp()
  try {
    const made = generate(dir)
    const { publicPem, privatePath } = made
    assert.deepEqual(Object.keys(made).sort(), ['privatePath', 'publicPem'], 'nothing else is returned')
    assert.match(publicPem, /^-----BEGIN PUBLIC KEY-----\n/)
    assert.doesNotMatch(publicPem, /PRIVATE/)
    assert.equal(privatePath, join(dir, PRIVATE_KEY_FILE))
    if (process.platform !== 'win32') assert.equal(statSync(privatePath).mode & 0o777, 0o600)
    const before = readFileSync(privatePath, 'utf8')
    assert.match(before, /^-----BEGIN PRIVATE KEY-----\n/)
    assert.throws(() => generate(dir), /already exists/, 'never overwrites a key')
    assert.equal(readFileSync(privatePath, 'utf8'), before, 'the key that was there is untouched')
  } finally {
    removeDir(dir)
  }
})

test('signSums writes SHA256SUMS.sig that the server verifies with the committed key', () => {
  const dir = temp()
  try {
    const { publicPem, privatePath } = generate(dir)
    const sums = join(dir, 'SHA256SUMS')
    writeFileSync(sums, SUMS)
    const out = signSums({ sumsPath: sums, privatePem: readFileSync(privatePath, 'utf8'), publicKeys: [publicPem] })
    assert.deepEqual(out, { signed: true, sigPath: `${sums}.sig` })
    assert.equal(verifySums(readFileSync(sums), readFileSync(`${sums}.sig`, 'utf8'), [publicPem]), true)
    assert.equal(verifySums(Buffer.from(SUMS.replace('a', 'b')), readFileSync(`${sums}.sig`, 'utf8'), [publicPem]), false, 'the signature is over these bytes only')
    assert.equal(readFileSync(sums, 'utf8'), SUMS, 'SHA256SUMS itself is not rewritten')
  } finally {
    removeDir(dir)
  }
})

test('a secret and a committed key that do not match stop the release; neither set skips signing', () => {
  const dir = temp()
  try {
    const sums = join(dir, 'SHA256SUMS')
    writeFileSync(sums, SUMS)
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
    const { publicPem, privatePath } = generate(dir)
    const privatePem = readFileSync(privatePath, 'utf8')
    assert.throws(() => signSums({ sumsPath: sums, privatePem, publicKeys: [other] }), /does not match/)
    assert.throws(() => signSums({ sumsPath: sums, privatePem, publicKeys: [] }), /no public key/)
    assert.throws(() => signSums({ sumsPath: sums, privatePem: '', publicKeys: [publicPem] }), /UPDATE_SIGNING_KEY is not set/)
    assert.throws(() => signSums({ sumsPath: sums, privatePem: 'garbage', publicKeys: [publicPem] }), /not a private key/)
    assert.deepEqual(signSums({ sumsPath: sums, privatePem: '', publicKeys: [] }), { signed: false })
    assert.deepEqual(signSums({ sumsPath: sums, privatePem: ' \n', publicKeys: [] }), { signed: false }, 'an empty secret is no secret')
    assert.equal(existsSync(`${sums}.sig`), false, 'no refusal and no skip leaves a signature behind')
  } finally {
    removeDir(dir)
  }
})
