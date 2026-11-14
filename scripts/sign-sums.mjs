// scripts/sign-sums.mjs — the signature `trek-server update` trusts.
//
//   node scripts/sign-sums.mjs generate <dir>     once: a new Ed25519 key pair. The private key
//                                                 goes to <dir>/update-signing-key.pem (0600) and
//                                                 is never printed; the public key is printed, to
//                                                 commit in server/src/update/keys.ts.
//   node scripts/sign-sums.mjs sign <SHA256SUMS>  the release: signs it with $UPDATE_SIGNING_KEY
//                                                 (the private key's PEM), writes <SHA256SUMS>.sig
//                                                 (base64 of the raw signature) and checks that a
//                                                 key committed in keys.ts verifies it.
//
// Until a key exists (no secret, no committed key) `sign` writes nothing and says so: releases
// still build, and no server can self-update. One without the other stops the release.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRIVATE_KEY_FILE = 'update-signing-key.pem'

/** A new key pair: the private key written to `dir` (never returned), the public key returned. */
export function generate(dir) {
  const privatePath = join(dir, PRIVATE_KEY_FILE)
  if (existsSync(privatePath)) throw new Error(`${privatePath} already exists: move it away first`)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePath }
}

/** Signs `sumsPath` with `privatePem` and checks the result against `publicKeys` (keys.ts). */
export function signSums({ sumsPath, privatePem, publicKeys }) {
  const hasKey = privatePem.trim() !== ''
  if (!hasKey && publicKeys.length === 0) return { signed: false }
  if (!hasKey) throw new Error('UPDATE_SIGNING_KEY is not set, but server/src/update/keys.ts lists a public key: servers would refuse this release')
  if (publicKeys.length === 0) throw new Error('UPDATE_SIGNING_KEY is set, but server/src/update/keys.ts lists no public key: no server could verify this release')
  let key
  try {
    key = createPrivateKey(privatePem)
  } catch {
    throw new Error('UPDATE_SIGNING_KEY is not a private key in PEM form')
  }
  const bytes = readFileSync(sumsPath)
  const signature = sign(null, bytes, key)
  const matches = publicKeys.some((pem) => {
    try {
      return verify(null, bytes, createPublicKey(pem), signature)
    } catch {
      return false
    }
  })
  if (!matches) throw new Error('UPDATE_SIGNING_KEY does not match any public key in server/src/update/keys.ts')
  const sigPath = `${sumsPath}.sig`
  writeFileSync(sigPath, signature.toString('base64') + '\n')
  return { signed: true, sigPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, target] = process.argv.slice(2)
  try {
    if (mode === 'generate' && target) {
      const { publicPem, privatePath } = generate(target)
      console.log(`The private key is in ${privatePath} (not printed). Add it as the release environment's secret,\nthen delete the file:\n`)
      console.log(`  gh secret set UPDATE_SIGNING_KEY --env release < ${privatePath}\n`)
      console.log('The public key, to add to UPDATE_PUBLIC_KEYS in server/src/update/keys.ts:\n')
      console.log(publicPem)
    } else if (mode === 'sign' && target) {
      const { UPDATE_PUBLIC_KEYS } = await import('../server/src/update/keys.ts')
      const out = signSums({ sumsPath: target, privatePem: process.env.UPDATE_SIGNING_KEY ?? '', publicKeys: UPDATE_PUBLIC_KEYS })
      if (out.signed) console.log(`signed: ${out.sigPath}`)
      else console.log('::warning title=Checksums not signed::No update signing key is set up (docs/RELEASING.md), so SHA256SUMS is not signed and no trek-server can update itself to this release.')
    } else {
      console.error('usage: node scripts/sign-sums.mjs generate <dir> | sign <SHA256SUMS>')
      process.exit(2)
    }
  } catch (err) {
    console.error(`::error title=Checksum signing::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
