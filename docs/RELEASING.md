# Releasing Trek

Three GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` (CI) | every pull request, every push to `main`, by hand (Run workflow); called by `release.yml` | Linux (ubuntu-latest, Node 22): `npm ci`, which runs `npm ci` in `server/` and `relay/` too (`scripts/postinstall.mjs`), so every lockfile is enforced; typecheck the app, trek-server and trek-relay; `npm test`; `npm run build` and `npm run build:relay`; the Node-only smokes (`server` smoke on the built bundle, `smoke:client`, `smoke:push`); the phone app's typecheck and `expo export` for iOS and Android. A newer push to the same PR cancels the older run (not on `main`). A push to any other branch runs nothing by itself (open a PR, or Run workflow), so a PR's branch is not tested twice per push. |
| `macos-smokes.yml` (macOS smokes) | nightly at 07:17 UTC, by hand, and called by `release.yml` | macOS arm64: `npm test` (with the macOS-only sandbox tests), one `npm run build`, then every Electron smoke one at a time (`smoke:local`, `windows`, `providers`, `v2`, `local-app`, `local-window`, `local-features`, `server-env`, `server-integrations`, `server-prwatch`, `server-review`, `server-web`, `server-move`, `server-promote`, `server-pairing`, `import`). Each smoke runs even if an earlier one failed, so one run shows every failure. |
| `release.yml` (Release) | a pushed tag `v*` | Checks the version (every other job waits for it, so a malformed tag stops there), runs both workflows above as its gate, builds and checks every artifact, and creates a **draft** GitHub Release. |

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
   The `mac-app` and `server-mac` jobs run in the `release` environment: if you gave it a
   required reviewer, each waits for an approval (**Review deployments** on the run's page) before it starts.
4. When it is green, open the draft under **Releases**, edit the notes, and publish it. The
   notes start with the workflow's own (the list of files and how to check them), followed by
   GitHub's generated notes (the merged PRs since the last release).

If the release fails, fix the cause on `main`, delete the tag (`git push --delete origin vX.Y.Z`,
`git tag -d vX.Y.Z`) and any draft it made, and tag again. Re-running the failed jobs on the same
tag also works when the cause was outside the repo (a flaky smoke, Apple's notary service). A
re-run whose `release` job finds the draft already there uploads the files into that draft
(`gh release upload --clobber`, replacing same-named ones) instead of failing; its notes are
left as they were. It refuses to touch a release that is already published.

## What the release builds

| Artifact | Built on | Checked by |
| --- | --- | --- |
| `Trek-X.Y.Z-arm64.dmg` | macos-latest (arm64) | `codesign --verify --deep --strict`; a Developer ID Application signature with the hardened runtime and the entitlements; every Mach-O under `app.asar.unpacked` (node-pty's `pty.node` and `spawn-helper`) signed with the hardened runtime and `spawn-helper` executable; `stapler validate` and `spctl --assess` on the app, `stapler validate` on the notarized dmg and on the app inside it; then `local-server-smoke.mjs --packaged` and `local-app-smoke.mjs --packaged` on the signed app |
| `trek-server-X.Y.Z-darwin-arm64.tar.gz` | macos-latest | `codesign` (in `package-server.mjs --sign`) and `notarytool` on node-pty's `pty.node` and `spawn-helper`; `scripts/server-tarball-smoke.mjs --notarized` (Developer ID, hardened runtime, timestamp; unpacked quarantined) |
| `trek-server-X.Y.Z-darwin-x64.tar.gz` | macos-15-intel | 〃 |
| `trek-server-X.Y.Z-linux-x64.tar.gz` | ubuntu-22.04 | `scripts/server-tarball-smoke.mjs` |
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
makes the dmg. Then the workflow notarizes the dmg too (`xcrun notarytool submit --wait`, with
the same API key or Apple ID; a status other than Accepted fails the job and prints the notary's
log) and staples its ticket (`xcrun stapler staple`), so a downloaded dmg opens offline without
Gatekeeper asking Apple; `stapler validate` checks both tickets. The dmg itself is not
code-signed: electron-builder advises against it (`dmg.sign`), and the stapled ticket is what
Gatekeeper checks. If Apple ever refuses an unsigned dmg, set `"dmg": { "sign": true }` in
`package.json`'s `build`.

**The trek-server tarballs** come from `scripts/package-server.mjs`, run on a native runner of
each platform (node-pty is built for the platform it runs on: compiled from source on Linux,
node-pty's own prebuild on macOS). Each holds one folder: `bin/trek-server` (a sh launcher that
needs Node.js 22 or later on PATH, or `TREK_NODE`), `trek-server.cjs`, `build.json`, the web
client, `node_modules/node-pty` for that platform only, `trek-server.service` and a README.
`scripts/server-tarball-smoke.mjs` unpacks it in a temp HOME and checks the layout, `--version`,
a pty from its node-pty, the launcher through a symlink, `start` on loopback with a WebSocket
client, and SIGTERM. The Linux tarballs are built on Ubuntu 22.04 so they run on glibc 2.35 and
later.

**The macOS tarballs** are built by the `server-mac` job, which runs in the `release` environment
like `mac-app`. A browser download is quarantined, tar passes the flag on to every file it
unpacks, and macOS loads a quarantined native module only if it is notarized: an unsigned node-pty
fails with "library load disallowed by system policy" (node-pty itself reports it as "Cannot find
module './prebuilds/darwin-arm64//pty.node'"; `trek-server start` says what happened and how to
clear the flag). So `package-server.mjs --sign 'Developer ID Application'` signs `pty.node` and
`spawn-helper` with the hardened runtime and a timestamp, from the keychain
`scripts/macos-signing.sh` makes (the script `mac-app` sources too), and the job notarizes the two
(a zip of node-pty's native folder; a bare Mach-O cannot be stapled, so Gatekeeper fetches the
ticket online on first load). `server-tarball-smoke.mjs --notarized` then checks both signatures
and unpacks a quarantined copy, so its pty check and `start` go through Gatekeeper.

To build and check one locally (for this machine's platform):

```sh
npm run build:web && npm --prefix server run build
node scripts/package-server.mjs --out dist-release
node scripts/server-tarball-smoke.mjs dist-release/trek-server-<version>-<os>-<arch>.tar.gz
```

## One-time GitHub setup

The signing and notarization secrets live in a GitHub **environment** named `release`, not in the
repository's secrets: only the `mac-app` and `server-mac` jobs name that environment, and the environment only
lets a `v*` tag use it, so no branch, pull request or other workflow can read them. A tag ruleset
then limits who can create a `v*` tag.

1. **The environment.** Settings → Environments → **New environment** → name it `release`
   (exactly) → Configure environment:
   - **Deployment branches and tags** → *Selected branches and tags* → **Add deployment branch or
     tag rule** → Ref type **Tag**, name pattern `v*`. (Leave no branch rule: the release runs
     only on tags.)
   - Optional: **Required reviewers** → add yourself (or the release managers). The `mac-app`
     job then waits for an approval on each release run. Leave *Prevent self-review* off if you
     are the only reviewer and you push the tags yourself.
   - Optional: leave *Allow administrators to bypass configured protection rules* unchecked.

   Create it before the first release tag: a workflow that names an environment that does not
   exist makes an empty one with no rules (the release would then stop at its secrets check).
2. **The secrets**, in that environment: Settings → Environments → `release` → **Environment
   secrets** → **Add environment secret**, once for each secret in the table below (the
   certificate's two and one notarization method's three; all eight is fine). Don't add them as
   repository secrets as well; if they already are, delete those (Settings → Secrets and
   variables → Actions → Repository secrets).
3. **The tag ruleset.** Settings → Rules → Rulesets → **New ruleset** → **New tag ruleset**:
   - Name: `release tags`; Enforcement status: **Active**.
   - Bypass list: **Add bypass** → the people or role allowed to release (e.g. *Repository
     admin*), "Always allow".
   - Target tags → **Add target** → **Include by pattern** → `v*`.
   - Rules: **Restrict creations**, **Restrict updates** and **Restrict deletions** (and *Block
     force pushes*). Create.

   Now only the bypass list can push, move or delete a `v*` tag, so only they can start a release.
   (Deleting a failed release's tag, under "Cutting a release", is then theirs to do too.)

## The secrets

The release fails at its first step, naming what is missing, unless the certificate and one
notarization method are set in the `release` environment; it never ships an unsigned app or
macOS server tarball.

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
too. The workflow writes the `.p8` to a file in the runner's temp directory (mode 0600) only for
the packaging step (`APPLE_API_KEY`, the path electron-builder wants, then notarytool for the dmg),
and a shell `trap` on the step's exit deletes it however the step ends, a failed
electron-builder or notarization included.

The certificate is not handed to electron-builder as `CSC_LINK`: electron-builder 26.15.3 unlocks
its own temp keychain with the `.p12`'s password and fails. The step instead imports the `.p12`
into a keychain it creates in the runner's temp directory (random password), points
electron-builder at it with `CSC_KEYCHAIN`, and the same `trap` deletes the decoded `.p12` and that
keychain.

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
signing with the real certificate, notarization of the app and the dmg, the `release`
environment's tag rule and reviewers, and `gh release create` / `upload --clobber`.
