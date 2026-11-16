# Releasing Trek

Five GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` (CI) | every pull request, every push to `main`, by hand (Run workflow); called by `release.yml` | Linux (ubuntu-latest, Node 22): `npm ci`, which runs `npm ci` in `server/` and `relay/` too (`scripts/postinstall.mjs`), so every lockfile is enforced; typecheck the app, trek-server and trek-relay; `npm test`; `npm run build` and `npm run build:relay`; the Node-only smokes (`server` smoke on the built bundle, `smoke:client`, `smoke:push`); the phone app's typecheck and `expo export` for iOS and Android. A newer push to the same PR cancels the older run (not on `main`). A push to any other branch runs nothing by itself (open a PR, or Run workflow), so a PR's branch is not tested twice per push. |
| `macos-smokes.yml` (Electron smokes, macOS, Linux and Windows) | nightly at 07:17 UTC, by hand, and called by `release.yml` | A matrix of macOS arm64, Linux x64 and Windows x64 (windows-latest, run under Git Bash). Each leg: one `npm run build`, then every Electron smoke one at a time (`smoke:local`, `windows`, `providers`, `v2`, `local-app`, `local-window`, `local-features`, `server-env`, `server-integrations`, `server-prwatch`, `server-review`, `server-web`, `server-move`, `server-promote`, `server-pairing`, `server-update-app`, `import`). `npm test` runs on the macOS leg only (it includes the macOS-only sandbox tests), and `server-update-app` prints SKIP off macOS. The Linux leg runs each smoke under `xvfb-run -a` with `TREK_NO_KEYRING_NOTICE=1`. Each smoke runs even if an earlier one failed, so one run shows every failure. |
| `linux-app.yml` (Linux app) | called by `release.yml`, and by hand | Builds the `.deb` on ubuntu-22.04 (x64) and ubuntu-22.04-arm (arm64), checks it (see the artifact table) and uploads it with its update feed. |
| `windows-app.yml` (Windows app) | called by `release.yml` (as `windows-app`), and by hand | Builds `Trek-X.Y.Z-win-x64.exe` on windows-latest, checks it (see the artifact table) and uploads it with its update feed. On a `v*` tag the `signed` job runs, in the `release` environment: it signs only when all seven Azure signing secrets are set, builds unsigned with a warning when none are, and fails when only some are; on anything else the `unsigned` job runs, with the signature checks skipped. |
| `release.yml` (Release) | a pushed tag `v*` | Checks the version (every other job waits for it, so a malformed tag stops there), runs CI and the Electron smokes as its gate, builds the `.deb`s (`linux-app.yml`), the Windows installer (`windows-app.yml`) and every other artifact and checks them, and creates a **draft** GitHub Release. |

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

3. Watch **Actions → Release**. It takes the longest of: the Electron smokes (about an hour), the
   signed apps (notarization usually takes 5–15 minutes), the server tarballs.
   The `mac-app`, `server-mac`, `windows-app` (its `signed` job), `server-win` and `release` jobs run in the `release` environment: if you gave
   it a required reviewer, each waits for an approval (**Review deployments** on the run's page)
   before it starts. `mac-app`, `server-mac`, `windows-app` and `server-win` ask at the start of the run; `release` asks once
   everything else is green, so a release needs one more approval at its end, before the draft
   is made.
4. Before the first Linux release, once the run is green, run the manual checklist in
   [LINUX.md](LINUX.md) on a real Ubuntu desktop with the draft's `.deb`. Before the first Windows
   release, run the desktop checklist in [WINDOWS.md](WINDOWS.md) on a real Windows PC with the
   draft's installer. (Windows server releases have their own checklist, in the same file.)
5. Open the draft under **Releases**, edit the notes, and publish it. The
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
| `Trek-X.Y.Z-arm64.zip`, `Trek-X.Y.Z-arm64.zip.blockmap`, `latest-mac.yml` | macos-latest (arm64), the same build as the dmg | the built `dist/mac-arm64/Trek.app`: `Contents/Resources/app-update.yml` exists and names the repository; the zip and its block map exist; the app unzipped: `codesign --verify --deep --strict`, `stapler validate`, `spctl --assess`; `scripts/latest-mac-yml.mjs` drops the dmg's entry from `latest-mac.yml` and checks the zip's size and SHA-512 against it |
| `Trek-X.Y.Z-linux-x64.deb`, `latest-linux.yml` | ubuntu-22.04 (`linux-app.yml`) | `dpkg-deb` checks (package name `trek`, version, architecture, the files, `pty.node` built for the architecture, no foreign prebuilds); `apt install` of the deb; then `local-server-smoke.mjs --packaged /opt/Trek` and `local-app-smoke.mjs --packaged /opt/Trek` under xvfb. `latest-linux.yml` is the update feed |
| `Trek-X.Y.Z-linux-arm64.deb`, `latest-linux-arm64.yml` | ubuntu-22.04-arm (`linux-app.yml`) | 〃 |
| `Trek-X.Y.Z-win-x64.exe` | windows-latest (`windows-app.yml`) | the installer, `latest.yml` and `Trek.exe` exist; node-pty's win32-x64 `conpty.node` is in the app and no other platform's prebuild; when signing is on (all seven secrets), the installer and every Trek-built `.exe`, `.dll` and `.node` carry a valid signature from `AZURE_SIGNING_PUBLISHER`, and any other `.exe`/`.dll`/`.node` a valid one; then the installer runs silently into `%LOCALAPPDATA%\Programs\trek`, the installed files are checked again, `local-server-smoke.mjs --packaged` and `local-app-smoke.mjs --packaged` run on the installed app, and it is uninstalled silently |
| `Trek-X.Y.Z-win-x64.exe.blockmap` | windows-latest, the same build | exists; a Trek that has updated before downloads only the blocks that changed |
| `latest.yml` | windows-latest, the same build | exists and names the installer; the app's `app-update.yml` names the repository. It is the update feed |
| `trek-server-X.Y.Z-darwin-arm64.tar.gz` | macos-latest | `codesign` (in `package-server.mjs --sign`) and `notarytool` on node-pty's `pty.node` and `spawn-helper`; `scripts/server-tarball-smoke.mjs --notarized` (Developer ID, hardened runtime, timestamp; unpacked quarantined) |
| `trek-server-X.Y.Z-darwin-x64.tar.gz` | macos-15-intel | 〃 |
| `trek-server-X.Y.Z-linux-x64.tar.gz` | ubuntu-22.04 | `scripts/server-tarball-smoke.mjs` |
| `trek-server-X.Y.Z-linux-arm64.tar.gz` | ubuntu-22.04-arm | 〃 |
| `trek-server-X.Y.Z-win32-x64.zip` | windows-latest (the `server-win` job, in the `release` environment) | `bin\trek-server.ps1` signed with Azure Trusted Signing (`package-server.mjs --sign-azure`) and checked signed inside the zip, when all seven Azure secrets are set; unsigned (with a warning) when none are, a failure when only some; the zip unpacked and run |
| `trek-relay-X.Y.Z.cjs` and `.cjs.sha256` | ubuntu-latest | `node trek-relay-X.Y.Z.cjs version` |
| `SHA256SUMS` | ubuntu-latest (the `release` job) | every file above |
| `SHA256SUMS.sig` | ubuntu-latest (the `release` job) | `scripts/sign-sums.mjs sign`: signed with `UPDATE_SIGNING_KEY`, then verified against the public keys in `server/src/update/keys.ts`; a mismatch stops the release. Absent (with a warning on the run) until the key is set up; not listed in `SHA256SUMS` |

**The macOS app** is arm64 only (Apple silicon), as `npm run dist` builds it. An x64 or universal build
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

**The Windows installer** is built by `windows-app.yml` with `npm run dist:win` (NSIS, x64, one-click,
per user, installed to `%LOCALAPPDATA%\Programs\trek` without elevation). When all seven Azure secrets
are set, electron-builder signs it through Azure Trusted Signing (`azureSignOptions`, given on the
command line from the `AZURE_SIGNING_*` secrets, so a local, branch or secret-less build stays
unsigned), and electron-updater checks that an update is signed by the same publisher,
`AZURE_SIGNING_PUBLISHER`. Unsigned, there is no `publisherName` in `app-update.yml`, so the
updater checks no signer. Until the secrets exist the release ships unsigned and SmartScreen asks
once (docs/WINDOWS.md); the release notes' Windows line says so, and needs rewording when signing
is switched on. The Local server runs on
`Trek.exe`, so the installer must replace it: the app stops the server before it installs an
update, and the installer and uninstaller close whatever still runs from the install folder.

**The Windows trek-server zip** is built by the `server-win` job (in the `release` environment):
With all seven secrets, `bin\trek-server.ps1` is signed so PowerShell's execution policy accepts it; `bin\trek-server.cmd`
cannot be signed.

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

## App updates

The text below is the macOS flow. Windows is the same flow, from `latest.yml` and the installer: Trek stops the Local server before it installs, and an update installs only through Restart to Update (docs/WINDOWS.md → Updating); test it with the checklist in docs/WINDOWS.md, which needs a previous Windows release. On Linux, updates are notify-only: Trek checks the same way
(from `latest-linux.yml` or `latest-linux-arm64.yml`), and its dialog offers Open Release Page,
Later and Skip This Version. The user installs the new `.deb` with apt (docs/LINUX.md → Updating).

An installed Trek (the first release that includes the updater, and later ones) checks the latest
**published** release ten seconds after it starts and once a day, and from **Trek → Check for
Updates…**. It reads `latest-mac.yml` from the release, and only when the user chooses Download
does it fetch `Trek-X.Y.Z-arm64.zip`; macOS checks the zip's Developer ID signature before the app
is replaced. Nothing is offered while the release is a draft or a prerelease, so publishing the
draft is what ships the update. A Trek from a release before the updater was added never checks:
it needs one manual install of a newer dmg.

`latest-mac.yml` lists only the zip. electron-builder also lists the dmg, but the workflow staples
the dmg after that file is written, so `scripts/latest-mac-yml.mjs` removes the dmg's stale entry.

`Trek-X.Y.Z-arm64.zip.blockmap` is electron-builder's block map of the zip. A Trek that has
updated itself before keeps that update's zip, and uses the two releases' block maps to download
only the blocks that changed; when either block map is missing it downloads the whole zip.

Do not rename or delete the zip or `latest-mac.yml` on a published release: installed apps would
find no update, or fail to download it.

The feed is `Contents/Resources/app-update.yml` in the app. electron-builder writes it only when
the build has a `dmg` or `zip` target (app-builder-lib `out/publish/PublishManager.js`, its
`onAfterPack` hook), so an app from `npm run dist:dir` has no feed and its update check fails
quietly; only `npm run dist` or the release workflow produce an app that can update.
`TREK_NO_UPDATE_CHECK=1` (or `true`, `yes`) turns the checks off and disables the
menu item: every smoke sets it, the packaged-app smoke included, so no test contacts GitHub.

The updater cannot be tested without two signed, published builds. On the first two releases that
carry it, with the older one installed in /Applications:

- [ ] Publish the newer release. Within a minute of launching the older Trek, the title bar shows
      "Update available: X.Y.Z" in every window.
- [ ] Click it → **Release Notes** opens the release page; the indicator stays.
- [ ] **Later** hides the indicator; **Check for Updates…** brings the dialog back.
- [ ] **Skip This Version** hides it; quit and relaunch: nothing is offered. **Check for
      Updates…** still offers it.
- [ ] **Download** shows "Downloading N%", then "Restart to Update".
- [ ] **Restart to Update** → **Restart to Update**: Trek closes and reopens as the new version
      (Trek → About), its windows restored, and offers to restart the Local server.
- [ ] Repeat the download, choose **Later**, quit Trek: the next launch is the new version.
- [ ] With the newest version installed, **Check for Updates…** says it is the latest version.
- [ ] Offline, **Check for Updates…** shows an error; a launch offline shows nothing.

## Server updates

A trek-server installed from a release tarball on macOS or Linux updates itself with
`trek-server update` (server/README.md, "Updating"). It reads `SHA256SUMS` and `SHA256SUMS.sig`
from the latest **published** release, and installs nothing unless the signature verifies against
a public key built into that server (`UPDATE_PUBLIC_KEYS` in `server/src/update/keys.ts`); the
tarball it then downloads must have the sha256 that `SHA256SUMS` names. A draft or a prerelease is
never offered, so publishing the draft is what ships the update. A running server also looks once
a day: it logs what it finds and tells its connected clients, and a Trek app can then ask it to
run the same update (the server's row in Open on server…; PROTOCOL.md, "Updating the server").
It installs nothing by itself.

Do not rename or delete `SHA256SUMS`, `SHA256SUMS.sig` or the server tarballs on a published
release, and do not replace any of them with other bytes: servers would find no update, or
refuse it.

`scripts/server-update-smoke.mjs` runs a real update, a refused one and a rollback against a
signed feed on this machine (a test build with its own key; it never contacts GitHub).

### The update signing key

This was done on 2026-11-15: `UPDATE_PUBLIC_KEYS` holds the project's key, and the steps below
are kept for a new key (see "Rotating the key" and "If the key is lost or leaks"). With an empty
list the `release` job warns ("Checksums not signed") and signs nothing, and `trek-server update`
says it has no update key built in.

Once, before the first release that servers should be able to update from:

1. Generate the pair, on a machine you trust, into a new folder outside the repository:

   ```sh
   mkdir -m 700 ~/trek-update-key
   node scripts/sign-sums.mjs generate ~/trek-update-key
   ```

   The private key is written to `~/trek-update-key/update-signing-key.pem` (mode 0600) and is
   never printed. The public key is printed. Do not open, print or paste the private key
   anywhere: the next step reads it from the file.
2. Add the private key as the `release` environment's secret, from the file, then delete the
   file (run in a checkout of the repository, signed in to `gh` as someone who may change its
   environments):

   ```sh
   gh secret set UPDATE_SIGNING_KEY --env release < ~/trek-update-key/update-signing-key.pem \
     && rm -rf ~/trek-update-key
   ```

   The folder is removed only if the secret was set. If you want an offline copy, copy the file
   to it (`cp`) before this. Without the
   private key, the only way on is a new key, which servers get by one manual install (see "If
   the key is lost or leaks").
3. Add the printed public key (the whole PEM, `-----BEGIN PUBLIC KEY-----` to
   `-----END PUBLIC KEY-----`, as a template string) to `UPDATE_PUBLIC_KEYS` in
   `server/src/update/keys.ts`, and commit it. The public key is not a secret.

Do steps 2 and 3 before the same release tag. With only one of them the release stops at "Sign
SHA256SUMS": a secret with no committed key would sign what no server can verify, and a
committed key with no secret would publish a release every server refuses.

The first release after that has the key built in and is signed. Servers running it (installed
by hand, once) can update to the releases after it. A server from an earlier release has no
`update` command, or has one with no key, which refuses every release: it needs that one manual
install.

**Rotating the key.** A server accepts a signature from any key in its own `UPDATE_PUBLIC_KEYS`,
and a release is signed with one key, so servers must have the new public key before a release
is signed with it:

1. Generate a new pair as above, but do not set the secret yet: keep the private key's file
   (or move it offline) until step 2. Add its public key to `UPDATE_PUBLIC_KEYS` beside the old
   one, commit, and release. That release is still signed with the old key, so every server
   that trusts the old key can update to it, and it carries both keys.
2. Once that release is published (and for as many releases after it as you want to give
   servers time), set the secret to the new private key and delete the file, as in step 2
   above. Not before it is published: a re-run of its `release` job while it is still a draft
   signs it with whatever key the secret then holds.
3. From the next release on, checksums are signed with the new key. Remove the old public key
   from `UPDATE_PUBLIC_KEYS` in that release or any later one (not earlier: the secret must
   always match a committed key, or the release stops).

A server that is still on a release from before step 1 when the first release signed with the new
key is published does not have the new key: `trek-server update` there refuses with "no valid
signature", and it needs one manual install. Every release kept signed with the old key in step
2 gives such servers longer to catch up.

**If the key is lost or leaks.** Generate a new pair, replace the old public key in
`UPDATE_PUBLIC_KEYS` with the new one, set the secret to the new private key, and release.
Servers on earlier versions trust only the old key, so they refuse the new releases and must be
updated by hand once: say so in the release notes. After a leak, those servers also still accept
the leaked key until then; an update is only ever read from this repository's releases over
https, so the leaked key alone does not let anyone install something on them.

## One-time GitHub setup

The signing and notarization secrets live in a GitHub **environment** named `release`, not in the
repository's secrets: only the `mac-app`, `server-mac`, `windows-app` (`signed`), `server-win` and `release` jobs name that environment
(`release` for the key that signs `SHA256SUMS`, which only its signing step is given), and the
environment only lets a `v*` tag use it, so no branch, pull request or other workflow can read
them. A tag ruleset then limits who can create a `v*` tag.

1. **The environment.** Settings → Environments → **New environment** → name it `release`
   (exactly) → Configure environment:
   - **Deployment branches and tags** → *Selected branches and tags* → **Add deployment branch or
     tag rule** → Ref type **Tag**, name pattern `v*`. (Leave no branch rule: the release runs
     only on tags.)
   - Optional: **Required reviewers** → add yourself (or the release managers). Each job that
     names the environment then waits for an approval on each release run: `mac-app`,
     `server-mac`, `windows-app` and `server-win` when the run starts (they can be approved together), and `release` at the end,
     when everything else has passed. Leave *Prevent self-review* off if you are the only
     reviewer and you push the tags yourself.
   - Optional: leave *Allow administrators to bypass configured protection rules* unchecked.

   Create it before the first release tag: a workflow that names an environment that does not
   exist makes an empty one with no rules (the release would then stop at its secrets check).
2. **The secrets**, in that environment: Settings → Environments → `release` → **Environment
   secrets** → **Add environment secret**, once for each of the Apple secrets in the table
   below (the certificate's two and one notarization method's three; all eight is fine), and once for each of the seven Azure ones.
   `UPDATE_SIGNING_KEY` is set from a file instead: see "The update signing key". Don't add them as
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
macOS server tarball. Windows signing is optional: `windows-app` and `server-win` sign and verify only when all seven `AZURE_*` secrets are set, build unsigned with a warning when none are, and fail at their first step, naming the missing ones, when only some are.

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
| `UPDATE_SIGNING_KEY` | The Ed25519 private key (PEM) that signs `SHA256SUMS`, for `trek-server update` (see "The update signing key"). Optional: without it and without a committed public key, releases build with unsigned checksums and no server can update itself |

| `AZURE_TENANT_ID` | The Microsoft Entra tenant (directory) ID of the app registration below |
| `AZURE_CLIENT_ID` | That app registration's Application (client) ID |
| `AZURE_CLIENT_SECRET` | A client secret created for that app registration (its value, shown once) |
| `AZURE_SIGNING_ENDPOINT` | The Trusted Signing account's endpoint: the account's region URI, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | The Trusted Signing account's name |
| `AZURE_SIGNING_PROFILE` | The certificate profile's name |
| `AZURE_SIGNING_PUBLISHER` | The certificate profile's subject CN, the publisher name Windows shows. electron-updater checks it on updates, and the workflow checks every signature against it |

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

### Azure Trusted Signing (the seven `AZURE_*` secrets), to turn signing on

Optional: the Windows installer and the trek-server zip ship unsigned until all seven secrets are
in the `release` environment. Add all of them or none.

Start early: identity validation for a Trusted Signing account can take days.

1. In the Azure portal, create a **Trusted Signing account**. Its region's URI is
   `AZURE_SIGNING_ENDPOINT` and its name is `AZURE_SIGNING_ACCOUNT`. Complete **identity
   validation** for your organization, then create a **certificate profile** (Public Trust): its
   name is `AZURE_SIGNING_PROFILE` and its subject CN is `AZURE_SIGNING_PUBLISHER`.
2. In Microsoft Entra ID, create an **app registration** (App registrations → New registration).
   Its Directory (tenant) ID is `AZURE_TENANT_ID` and its Application (client) ID is
   `AZURE_CLIENT_ID`. Under Certificates & secrets, create a **client secret** and copy its value
   (shown once) as `AZURE_CLIENT_SECRET`.
3. On the certificate profile (or the account), Access control (IAM) → add the role
   **Trusted Signing Certificate Profile Signer** for the app registration.

The signature checks run only on a `v*` tag with all seven secrets, so a bad setup shows up on the release run.

## Running the Electron smokes by hand

On GitHub: **Actions → Electron smokes → Run workflow** (any branch).

Locally, on a Mac with a logged-in GUI session, on Linux under `xvfb-run -a` (set `TREK_NO_KEYRING_NOTICE=1` there), or on Windows in Git Bash, each smoke builds the app and uses its own temp
HOME and user-data directory, so it never touches your Trek or `~/.config/trek-server`. Run them
one at a time (`npm run rebuild` first, once, for node-pty under Electron):

```sh
npm run smoke:v2            # or any other smoke:<name>; README.md → Development lists them
```

`smoke:packaged` builds an unsigned `dist/mac-arm64/Trek.app` (`npm run dist:dir`) on a Mac, or
`dist/linux-unpacked` / `dist/linux-arm64-unpacked` (`npm run dist:linux:dir`) on Linux, or `dist/win-unpacked` (`npm run dist:win:dir`) on Windows, and runs
the Local server and app smokes on it. `npm run dist:linux` builds the `.deb` and `npm run dist:win` the installer. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` for `dist`/`dist:dir`
on a Mac whose keychain holds a signing identity you don't want used.

## What only GitHub can show

The workflows were checked locally (YAML parsing, the action schema, actionlint, shellcheck on
every `run:` script, the packaging and tarball scripts, `dist:dir`), but these run only on
GitHub: the Linux and Windows unit tests, node-pty's Linux builds, the installed-app smokes on Windows, the Electron smokes on a runner,
signing with the real certificates (Apple and Azure), notarization of the app and the dmg, the `release`
environment's tag rule and reviewers, the `release` job's sparse checkout and its signing with the
real `UPDATE_SIGNING_KEY`, and `gh release create` / `upload --clobber`.
