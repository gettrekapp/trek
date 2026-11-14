// What an update is trusted by: the release workflow signs SHA256SUMS with an Ed25519 key kept in
// GitHub's `release` environment (docs/RELEASING.md), and only a signature one of these public
// keys verifies is accepted. A list, so a key can be rotated: add the new one in one release,
// sign with it from the next, drop the old one later.
//
// Empty until the project's key is generated (docs/RELEASING.md, "The update signing key"): with
// no key, no update verifies, and `trek-server update` says so.
export const UPDATE_PUBLIC_KEYS: readonly string[] = []

/** GitHub's releases: `<feed>/latest/download/<file>` is the newest published release's file. */
export const UPDATE_FEED = 'https://github.com/gettrekapp/trek/releases'

declare const __TREK_SERVER_TEST_UPDATE__: boolean | undefined

/** A build made for the update tests (server/scripts/build.mjs, TREK_SERVER_TEST_UPDATE=1): never released. */
export function isTestUpdateBuild(): boolean {
  return typeof __TREK_SERVER_TEST_UPDATE__ === 'boolean' && __TREK_SERVER_TEST_UPDATE__
}

/**
 * The feed and the keys. Fixed, except in a test build whose environment names both
 * TREK_UPDATE_FEED and TREK_UPDATE_PUBKEY (a PEM public key): a release build never reads them.
 */
export function updateSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
  testBuild: boolean = isTestUpdateBuild()
): { feed: string; keys: readonly string[] } {
  if (testBuild && env.TREK_UPDATE_FEED && env.TREK_UPDATE_PUBKEY) {
    return { feed: env.TREK_UPDATE_FEED.replace(/\/+$/, ''), keys: [env.TREK_UPDATE_PUBKEY] }
  }
  return { feed: UPDATE_FEED, keys: UPDATE_PUBLIC_KEYS }
}
