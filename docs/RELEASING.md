# Releasing Trek

Three GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` (CI) | every push to a branch, every pull request; called by `release.yml` | Linux (ubuntu-latest, Node 22): typecheck the app, trek-server and trek-relay; `npm test`; `npm run build` and `npm run build:relay`; the Node-only smokes (`server` smoke on the built bundle, `smoke:client`, `smoke:push`); the phone app's typecheck and `expo export` for iOS and Android. A newer push to the same branch or PR cancels the older run (not on `main`). |
| `macos-smokes.yml` (macOS smokes) | nightly at 07:17 UTC, by hand, and called by `release.yml` | macOS arm64: `npm test` (with the macOS-only sandbox tests), one `npm run build`, then every Electron smoke one at a time (`smoke:local`, `windows`, `providers`, `v2`, `local-app`, `local-window`, `local-features`, `server-env`, `server-integrations`, `server-prwatch`, `server-review`, `server-web`, `server-move`, `server-promote`, `server-pairing`, `import`). Each smoke runs even if an earlier one failed, so one run shows every failure. |
| `release.yml` (Release) | a pushed tag `v*` | Checks the version, runs both workflows above as its gate, builds and checks every artifact, and creates a **draft** GitHub Release. |

The phone app (`apps/mobile`) is not released here: EAS builds and submits it (see
`apps/mobile/README.md`). CI only checks that it typechecks and bundles.

## Versions

The tag is the product version. `package.json` (the app), `server/package.json` (trek-server,
baked into `trek-server.cjs` and printed by `trek-server --version`) and `relay/package.json`
(trek-relay) all carry it, and the release refuses a tag they don't match. The phone app keeps
its own version.

```sh
node scripts/set-version.mjs 0.3.0     # writes the three package.json files and their lockfiles' root
```

It refuses a version lower than any of the three (the Local server supervisor treats a lower
bundled server version as an older one), so the first release is at least the server's current
version (0.2.0 today). A version with a prerelease part (`0.3.0-rc.1`) makes a prerelease.

## Cutting a release

1. On `main`, with CI green: `node scripts/set-version.mjs X.Y.Z`, commit ("release X.Y.Z"),
   push.
2. Tag that commit and push the tag:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. Watch **Actions → Release**. It takes the longest of: the macOS smokes (about an hour), the
   signed app (notarization usually takes 5–15 minutes), the server tarballs.
4. When it is green, open the draft under **Releases**, edit the notes (they start from GitHub's
   generated notes), and publish it.

If the release fails, fix the cause on `main`, delete the tag (`git push --delete origin vX.Y.Z`,
`git tag -d vX.Y.Z`) and any draft it made, and tag again. Re-running the failed jobs on the same
tag also works when the cause was outside the repo (a flaky smoke, Apple's notary service).

## What the release builds

| Artifact | Built on | Checked by |
| --- | --- | --- |
| `Trek-X.Y.Z-arm64.dmg` | macos-latest (arm64) | `codesign --verify --deep --strict`; a Developer ID Application signature with the hardened runtime and the entitlements; every Mach-O under `app.asar.unpacked` (node-pty's `pty.node` and `spawn-helper`) signed with the hardened runtime and `spawn-helper` executable; `stapler validate` and `spctl --assess` on the app and on the app inside the dmg; then `local-server-smoke.mjs --packaged` and `local-app-smoke.mjs --packaged` on the signed app |
| `trek-server-X.Y.Z-darwin-arm64.tar.gz` | macos-latest | `scripts/server-tarball-smoke.mjs` |
| `trek-server-X.Y.Z-darwin-x64.tar.gz` | macos-15-intel | 〃 |
| `trek-server-X.Y.Z-linux-x64.tar.gz` | ubuntu-22.04 | 〃 |
| `trek-server-X.Y.Z-linux-arm64.tar.gz` | ubuntu-22.04-arm | 〃 |
| `trek-relay-X.Y.Z.cjs` and `.cjs.sha256` | ubuntu-latest | `node trek-relay-X.Y.Z.cjs version` |
| `SHA256SUMS` | | every file above |

**The app** is arm64 only (Apple silicon), as `npm run dist` builds it. An x64 or universal build
would need node-pty built for x64 as well, and `package.json`'s `build.files` leaves node-pty's
darwin-x64 prebuild out of the app (drop that exclusion first).

The app is signed by electron-builder with the hardened runtime and two entitlement files:
`build/entitlements.mac.plist` (the app: JIT and unsigned executable memory for V8, disabled
library validation so Electron's Node can load node-pty, Apple Events for the Chrome tab switch)
and `build/entitlements.mac.inherit.plist` (Electron's helpers, frameworks and node-pty's
binaries). The bundled Local trek-server (`out/server/trek-server.cjs`) is JavaScript inside
`app.asar`, run by the signed Electron binary with `ELECTRON_RUN_AS_NODE`, so it has no
signature of its own; node-pty's `pty.node` and `spawn-helper` are in `app.asar.unpacked` and are
signed with everything else. electron-builder notarizes the app and staples the ticket before it
makes the dmg; the dmg itself is not signed or notarized separately (the stapled app inside is
what Gatekeeper checks).

**The trek-server tarballs** come from `scripts/package-server.mjs`, run on a native runner of
each platform (node-pty is built for the platform it runs on: compiled from source on Linux,
node-pty's own prebuild on macOS). Each holds one folder: `bin/trek-server` (a sh launcher that
needs Node.js 22 or later on PATH, or `TREK_NODE`), `trek-server.cjs`, `build.json`, the web
client, `node_modules/node-pty` for that platform only, `trek-server.service` and a README.
`scripts/server-tarball-smoke.mjs` unpacks it in a temp HOME and checks the layout, `--version`,
a pty from its node-pty, the launcher through a symlink, `start` on loopback with a WebSocket
client, and SIGTERM. The Linux tarballs are built on Ubuntu 22.04 so they run on glibc 2.35 and
later. The macOS tarballs are not signed or notarized: a browser download quarantines them (the
README inside says how to clear it); `curl` does not.

To build and check one locally (for this machine's platform):

```sh
npm run build:web && npm --prefix server run build
node scripts/package-server.mjs --out dist-release
node scripts/server-tarball-smoke.mjs dist-release/trek-server-<version>-<os>-<arch>.tar.gz
```

## Repository secrets

Settings → Secrets and variables → Actions → **New repository secret**. The release fails at its
first step, naming what is missing, unless the certificate and one notarization method are set;
it never ships an unsigned app.

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | The **Developer ID Application** certificate and its private key, as a base64 `.p12` |
| `CSC_KEY_PASSWORD` | The `.p12`'s password |
| `APPLE_API_KEY_P8` | The App Store Connect API key: the full text of `AuthKey_<KEYID>.p8` (preferred) |
| `APPLE_API_KEY_ID` | That key's Key ID (10 characters) |
| `APPLE_API_ISSUER` | The Issuer ID shown above the keys list (a UUID) |
| `APPLE_ID` | Alternative to the API key: the Apple ID email of a team member |
| `APPLE_APP_SPECIFIC_PASSWORD` | That Apple ID's app-specific password |
| `APPLE_TEAM_ID` | The team ID (10 characters); needed with `APPLE_ID` |

With all three `APPLE_API_*` secrets set, the API key is used even if the Apple ID ones are set
too. The workflow writes the `.p8` to a file only for the packaging step (`APPLE_API_KEY`, the
path electron-builder wants) and deletes it after.

### The Developer ID Application certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`)

Only the team's Account Holder can create a Developer ID certificate.

1. On a Mac, Keychain Access → Certificate Assistant → **Request a Certificate From a Certificate
   Authority…**: your email, "Saved to disk". This makes a `.certSigningRequest` and puts the
   private key in your login keychain.
2. [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
   → **+** → **Developer ID Application** (the G2 Sub-CA) → upload the request → download the
   `.cer` and double-click it to add it to the login keychain.
3. Keychain Access → My Certificates → right-click "Developer ID Application: <Team> (<TEAMID>)"
   → **Export…** → `.p12`, with a strong password (that is `CSC_KEY_PASSWORD`). Export the
   certificate (with its key under it), not the key alone.
4. `base64 -i DeveloperID.p12 | pbcopy` and paste it as `CSC_LINK`. Delete the `.p12` file
   afterwards.

Check it before using it: `security find-identity -v -p codesigning` lists
`Developer ID Application: …` on the Mac that holds it.

### The App Store Connect API key (`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)

1. [appstoreconnect.apple.com/access/integrations/api](https://appstoreconnect.apple.com/access/integrations/api)
   → **Team Keys** → **+** (request access first if asked; the Account Holder grants it).
2. Name it (e.g. "Trek notarization"), access **Developer**, Generate.
3. Download `AuthKey_<KEYID>.p8` (only once). `APPLE_API_KEY_P8` is its whole text,
   `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`: `pbcopy < AuthKey_XXXX.p8`.
4. `APPLE_API_KEY_ID` is the key's **Key ID**; `APPLE_API_ISSUER` is the **Issuer ID** at the
   top of the page.

Check it locally:
`xcrun notarytool history --key AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer>` lists past
submissions (empty is fine) instead of an authentication error.

### Or an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)

1. [account.apple.com](https://account.apple.com) → Sign-In and Security → **App-Specific
   Passwords** → generate one ("Trek notarization").
2. The team ID is under Membership details at
   [developer.apple.com/account](https://developer.apple.com/account) (10 characters), and in
   the certificate's name: "Developer ID Application: Name (TEAMID)".

## Running the macOS smokes by hand

On GitHub: **Actions → macOS smokes → Run workflow** (any branch).

Locally, on a Mac with a logged-in GUI session, each smoke builds the app and uses its own temp
HOME and user-data directory, so it never touches your Trek or `~/.config/trek-server`. Run them
one at a time (`npm run rebuild` first, once, for node-pty under Electron):

```sh
npm run smoke:v2            # or any other smoke:<name>; README.md → Development lists them
```

`smoke:packaged` builds an unsigned `dist/mac-arm64/Trek.app` (`npm run dist:dir`) and runs the
Local server and app smokes on it. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` for `dist`/`dist:dir`
on a Mac whose keychain holds a signing identity you don't want used.

## What only GitHub can show

The workflows were checked locally (YAML parsing, the action schema, actionlint, shellcheck on
every `run:` script, the packaging and tarball scripts, `dist:dir`), but these run only on
GitHub: the Linux unit tests and node-pty's Linux builds, the Electron smokes on a runner,
signing with the real certificate, notarization, and `gh release create`.
