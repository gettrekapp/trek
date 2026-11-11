# Phase 6b: background push through a Trek push relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired phone gets pushes while the app is closed (a decision waiting, a session waiting or stopped, a watched pull request's report), through a `trek-relay` the user hosts that alone holds the APNs key and the FCM credentials.

**Architecture:** A new `relay/` package (plain Node: `http`, `http2`, `crypto`; bundled to `dist/trek-relay.cjs`) keeps phones' push tokens and per-server grants (secrets hashed) and sends APNs/FCM pushes whose words it builds from a fixed kind table. trek-server stores each phone token's grant in `secrets.json` (`push.setGrant`, write-only) and its `Pusher` follows the `attention` topic plus session-exit and PR-report hooks, posting `{kind, project, ids}` to the relay while that token has no live connection. The phone registers its native push token with the relay named in its build (`extra.relayUrl`), takes a grant per push-capable server and hands it over, with three switches per server and Pause all.

**Tech Stack:** Node 20+ (`node:http2`, `node:crypto` ES256/RS256), TypeScript run by Node's type stripping in tests, esbuild bundles, Expo SDK 58 (`expo-notifications` `getDevicePushTokenAsync`, `expo-secure-store`, `expo-constants`).

**Spec:** `docs/superpowers/specs/2026-11-11-phase6b-push-relay-design.md`. **Prototype:** `central-server-phase6b-proto` (one commit per task; executing this plan means cherry-picking them, then reviews).

---

## User decisions (2026-11-11, from the spec)

1. **Form:** a new `trek-relay` package in this repo (`relay/`), its own CLI and config, run once (e.g. on a VPS behind Caddy). The APNs and FCM secrets live only there.
2. **Trust:** phone-issued grants. The phone registers its push token with the relay once; for each paired server it asks the relay for a grant bound to that device and hands only the grant to the server. A server can push only to devices that granted it, never sees the APNs/FCM token, and the phone can revoke a grant.
3. **Payload:** the project and the kind only ("Trek · trek-app: a decision is waiting"). Never terminal text, a decision's question or a branch name.
4. **Events:** decisions waiting, sessions finished or stopped, PR watch notices; each switchable.
5. **Switches:** on the phone, per paired server (three), plus a phone-wide Pause all; the server filters before sending.
6. **Relay address:** built into the app's build config (`app.json` `extra.relayUrl`).
7. **Implementation:** plain Node, no push SDKs (APNs over `node:http2` with a `.p8` ES256 token; FCM HTTP v1 with a service-account JWT traded for an OAuth token); a JSON store.

## Decisions made in the plan (candidates for the user)

1. **Packaging.** `relay/` mirrors `server/`: its own `package.json` and lockfile (dev dependencies only: esbuild, typescript, @types/node), `npm run build` → `relay/dist/trek-relay.cjs`. The root `postinstall` also runs `npm --prefix relay install`; new root scripts `build:relay`, `typecheck:relay`. The root `npm run build` (the app) is unchanged.
2. **One vocabulary.** `src/shared/push.ts` holds the kinds, the three groups, the kind → sentence table (`pushText`), the project-name cleaning and the wire types. The relay, the server and the phone all import it; the phone's shared-code guard (`scripts/sharedForMobile.test.mjs`) now walks it too.
3. **Kinds.** `decision`, `session-finished`, `session-stopped`, `pr-checks-failed`, `pr-checks-passed`, `pr-review`, `pr-conflict`, `pr-merged`, `pr-closed`. A server cannot send words: `title`/`body` in a push body are ignored.
4. **Test-only hosts.** The relay config's `apnsHost`, `fcmHost`, `oauthHost` override the providers' origins; an `http://` APNs host means cleartext HTTP/2 (h2c), which only a stub speaks. Tests and the smoke always set them; a real config leaves them out (documented).
5. **Owner-only files.** The relay refuses to start when its config, the `.p8` or the service-account JSON has any group/other permission bits.
6. **Relay store.** `<dataDir>/relay.json` (0600, atomic). Device and grant secrets are 256-bit base64url and stored as sha256 only; the push token is stored as is (needed to send). `lastPushAt` is updated in memory and written with the next change (no rewrite per push).
7. **Dead devices.** APNs 410, or 400 `BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic`, or FCM `UNREGISTERED`, marks the device dead; its grants answer 410 until a `PUT` brings a new token. APNs `ExpiredProviderToken` re-signs and retries once; FCM 401 re-fetches the access token once.
8. **Grants on the server.** One per token name, in `secrets.json` under `push:<token name>` (the same file as the Linear/ElevenLabs keys; `SecretFile` gains `keys()`). A grant the relay refused keeps its settings without its secret (`push.status`: `active: false`, `lastError`) so the phone knows to grant again. Revoking a token drops its grant (`onConfigChange`).
9. **Relay URL rule on the server.** `https://`, or `http://` to `127.0.0.1`/`localhost`/`[::1]` only; no credentials, query or fragment.
10. **What pushes.** The `Pusher` subscribes to `attention` like any subscriber and diffs entries: a new `decision` (keyed by its `at`) → `decision`; a new `attention`/`done` session (keyed by `since`) → `session-finished`. PR notice entries are skipped there; the watcher's new `onReport` hook pushes the report's most pressing event (conflict > checks failed > review > merged > closed > checks passed; "can't be read" isn't pushed). The SessionManager's new `onSessionExit` hook pushes `session-stopped` only for a process that ended by itself (a closed, restarted, unloaded or moved session's owner is dropped before its kill, so it never reaches the hook). What is listed when the server starts is a baseline, never pushed.
11. **promote_to_primary is not pushed**: with no listening window it settles `no-window` at once, so a phone could never answer it later.
12. **Connected = any open socket with that token name.** The phone in its 20 s background grace still counts; what appears then is a 6a local notification instead.
13. **Coalescing** is leading-edge: the first push per (token, project, kind) goes, others within 30 s are dropped (the time is recorded when the push is decided, so a failed one also suppresses for 30 s).
14. **Delivery.** Network errors and 5xx retry 3 times (1, 3, 10 s); other 4xx don't retry; 401/404/410 → `refused`; 429 → `lastError`, dropped.
15. **`push` capability** is static (also on the Local server, which a phone never pairs with, so it is inert there).
16. **The phone.** `relayUrlOf(extra.relayUrl)` (https, or http to localhost/private IPv4 for development). It registers only once notification permission is granted (the 6a Attention screen asks on first launch); the device record (relay URL, id, secret, platform, token) is in secure storage; `addPushTokenListener` sends rotated tokens. Each connection generation of a push-capable server is synced once: `push.status`; a new grant when the phone has none or the server says not active (the old one revoked at the relay first); otherwise `push.setGrant` again only when the switches/pause differ. The server's own `serverId` is stored with each grant so a tapped push (which names it, under `trek` on iOS, at the top on Android) maps to the phone's entry id (`pushRouteData`).
17. **Smoke without Electron.** `smoke:push` runs a relay, a trek-server and two SDK clients in Node; the desktop's Electron UI is untouched by 6b.
18. **Review fixes (relay and server).** Supersedes parts of 7, 9, 12, 13 and 14:
    - *Dead devices.* APNs 410 (`Unregistered`, `ExpiredToken`) and FCM `UNREGISTERED`/`SENDER_ID_MISMATCH` mark a device dead; `BadDeviceToken` only once that token has had a push delivered (else, like `DeviceTokenNotForTopic`, `BadTopic`, `TopicDisallowed` and the environment errors, it is a relay config error: `422`, logged as `APNS CONFIG ERROR` naming `bundleId` and `production`). `markDead` checks the token it sent. A dead device's `GET`/`POST /v1/grants` answer `410 {error: 'device-dead'}`; any `PUT /v1/devices/:id` with a token (the same one included) revives it. Devices dead 30 days are pruned (at start, daily).
    - *Answers.* The relay maps provider refusals to `422` and 5xx/429/timeouts to `503` + `Retry-After: 30`; the server retries only `503` and network errors (honouring `Retry-After`, capped at 30 s), never `422`, and fetches with `redirect: 'error'`.
    - *Abuse.* Opt-in `trustProxy` (last `X-Forwarded-For` hop), 10 grants a minute per device, `maxDevices` (default 10,000 → `503`), optional `registrationKey` (`x-trek-relay-key`, constant-time; the build's `extra.relayKey`). A registration of an existing (platform, token) replaces that device and its grants (a reinstall). The limiters check every limit before counting any; sweeps at most once a second. Bodies: `Content-Length` over 16 KiB refused before reading, a stream cut after `413`. Config files must be owned by the relay's user; `dataDir` is made 0700.
    - *Store writes.* Secret-issuing and revoking changes stay synchronous (atomic rename) before the answer; only bookkeeping (`lastPushAt`, a token's first delivery) is debounced (≤1 s, flushed on close). Debouncing the rest would answer a device or grant secret the relay could forget in a crash.
    - *Device pause.* `PUT /v1/devices/:id {paused}`; `/v1/push` for a paused device answers `202 {accepted: true, paused: true}` and sends nothing, so Pause all holds for servers the phone can't reach.
    - *Payloads.* iOS: `{aps, body: {kind, serverId, projectId, worktreeId?, sessionId?}}` (expo-notifications reads `userInfo.body`; `trek` dropped), `apns-collapse-id` serverId:projectId:kind (sha256 past 64 bytes), `apns-expiration` from the injected clock. Android: `data` with the same keys, `android.notification.channel_id: 'default'`.
    - *APNs connection.* `session.setTimeout(2 min)` closes an idle session and one idle that long is never reused; a timed-out push destroys its session.
    - *FCM.* Successful bodies consumed; concurrent pushes share one token exchange.
    - *Pusher.* `refused`/`pushed` act only if the stored grant still has the secret that was used (a phone that granted again mid-push keeps the new grant). The session kinds coalesce as one group per (token, project) and wait 2 s, so an exit just after "waiting" pushes "stopped" only. Entries that arrived while the token was connected (≤50) are pushed when its last connection closes, if still listed (iOS suspends the app long before the server's heartbeat drops its socket). Re-subscribes to `attention` if it ends; `stop()` aborts fetches. The relay URL rule reuses 6a's `isLoopbackUrl`.
    - *Project names.* `pushProject` also strips U+2028/2029, U+FEFF and U+2060–2064, and cuts by code points.

## Risks

1. **No real APNs/FCM delivery has been tried.** The payloads follow Apple's and Google's documented formats and the stubs check them, but the first real-device run (apps/mobile/README.md checklist 10) may still find a mismatch (an entitlement, a topic, FCM's data typing).
2. **Android needs Firebase config in the build.** `getDevicePushTokenAsync` on Android needs the app built with the Firebase project's `google-services.json` (`android.googleServicesFile`). Without it the app logs a warning and never registers (Question 1).
3. **Permission granted later.** The phone checks permission when the app starts; one granted afterwards in Settings registers at the next launch.
4. **A chatty `done`.** `session-finished` fires whenever a session goes quiet after activity while the phone is away; long-running agents that pause often will push often (once per 30 s per project at most). The Sessions switch turns it off.
5. **A failed push still coalesces.** The 30 s window starts when a push is decided, so a push that failed to reach the relay suppresses the next one of that kind and project for 30 s.
6. **The relay is a single point.** If it is down, pushes are lost (retried 3 times, then dropped and recorded in `lastError`). Limits live in memory and reset on restart.
7. **LAN relay over http.** The phone accepts `http://` to a private address for development, but servers only accept `http://` on their own machine: a LAN relay over plain http works only for a server on the relay's machine.
8. **Push tokens on the relay are stored in clear** (they have to be, to send); the file is 0600 and the secrets beside them are hashes.
9. **The relay's APNs session** is opened lazily, closed after two idle minutes and never reused past that; a half-dead connection is found by the 10 s send timeout, which destroys it (that push answers `503` and the server retries).
11. **Pushes after a disconnect may surprise.** A decision the user already saw on the phone and left open is pushed when the phone's last connection closes (the server can't tell "seen" from "suspended").
12. **A known push token can evict a device.** Registering a token the relay already holds replaces that device (the reinstall path), so whoever learns a phone's push token can make its servers drop their grants until the phone grants again. Push tokens are not public; `registrationKey` and the registration limit narrow it.
13. **FCM's own `Retry-After`** isn't passed on; the relay always says 30 s.
10. **What a phone learns from a push.** The project's name and the kind reach Apple or Google and the lock screen; the user can pause pushes or turn kinds off.

## Questions

The user answered on 2026-11-11, as recommended: `google-services.json` is optional and git-ignored. An `app.config.js` sets `android.googleServicesFile` only when the file exists, the README says where to put it, and an Android build without it logs a warning and skips push registration (iOS is unaffected). **Not yet in the prototype:** Task 5 gains it when the plan is executed. None remain.

## File structure

- **Create** `src/shared/push.ts`: kinds, groups, `pushText`, `pushProject`, wire types.
- **Create** `relay/` — `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/build.mjs`, `README.md`, `src/index.ts` (CLI), `src/config.ts` (config + owner-only checks), `src/store.ts` (devices/grants), `src/limits.ts` (sliding windows), `src/api.ts` (the /v1 handler), `src/relay.ts` (HTTP server), `src/jwt.ts` (ES256/RS256, the APNs token cache), `src/apns.ts`, `src/fcm.ts`, `src/providers.ts`.
- **Create** `server/src/push/grants.ts` (`PushGrants`, `checkSetGrant`, `checkRelayUrl`), `server/src/push/pusher.ts` (`Pusher`, `prPushKind`).
- **Modify** `server/src/secrets.ts` (`keys()`), `server/src/sessions/manager.ts` (`onSessionExit`), `server/src/prWatch/watcher.ts` (`onReport`), `server/src/v2.ts` (`push.*`), `server/src/server.ts` (grants, pusher, connected tokens, revocation), `server/src/index.ts` (`push.secretsFile`), `server/src/capabilities.ts`, `src/shared/protocolV2.ts` (`CAPABILITY.push`, methods, `PushStatusResult`).
- **Create** `apps/mobile/src/logic/push.ts`, `apps/mobile/src/state/pushStorage.ts`, `apps/mobile/src/state/PushProvider.tsx`, `apps/mobile/app/push/[serverId].tsx`; **modify** `apps/mobile/app/_layout.tsx`, `apps/mobile/app/servers.tsx`, `apps/mobile/app.json` (`extra.relayUrl`), `apps/mobile/src/shared.ts`.
- **Tests** `scripts/relayApi.test.mjs`, `scripts/relayProviders.test.mjs`, `scripts/relayStubs.mjs` (stubs, shared with the smoke), `scripts/serverPush.test.mjs`, `scripts/mobileLogic.test.mjs` (push cases), `scripts/sharedForMobile.test.mjs`, `scripts/serverV2.test.mjs` (capability list); **smoke** `scripts/push-smoke.mjs` (`npm run smoke:push`).
- **Docs** `PROTOCOL.md` ("Background push"), `README.md`, `server/README.md`, `apps/mobile/README.md`, `relay/README.md`, the main spec's §6 pointer.
- **Root** `package.json`: `postinstall` installs `relay/`, `build:relay`, `typecheck:relay`, `smoke:push`.

## Prototype results

On `central-server-phase6b-proto` (head 8445e75, six commits: Tasks 1–6), 2026-11-11:

| Check | Result |
|---|---|
| `npm run typecheck` (app), `cd server && npm run typecheck`, `relay` typecheck, `apps/mobile` typecheck | clean |
| `npm test` | 2066 pass, 0 fail, 1 skipped (master: 2038); new: relayApi 9, relayProviders 5, serverPush 9, mobileLogic +5, sharedForMobile now walks push.ts |
| `npm run build`, `npm run build:relay` | pass (`relay/dist/trek-relay.cjs`, 28 KiB) |
| `npm run smoke:push` (new) | PUSH SMOKE PASS (21 checks), three runs |
| `cd server && npm run smoke` | SERVER SMOKE PASS |
| `npm run smoke:v2` | 172 checks |
| `npm run smoke:local-window` | 57 checks |
| `apps/mobile` `expo export` ios, android | both bundle |
| Leftover processes | none |

Not run: any simulator, emulator, Xcode or EAS build, and no real APNs, FCM, Google OAuth or Expo host (stubs only; the relay's hosts are always overridden in tests).

## Tasks

### Task 1: trek-relay core

relay/ as its own package; the config and its owner-only rule; the JSON store; the /v1 API (devices, grants, push), limits, the body cap; src/shared/push.ts.

**Prototype commit:** `cbeb991` on `central-server-phase6b-proto`.

**Files:**
- `package.json`
- `relay/package.json`
- `relay/scripts/build.mjs`
- `relay/src/api.ts`
- `relay/src/config.ts`
- `relay/src/index.ts`
- `relay/src/limits.ts`
- `relay/src/providers.ts`
- `relay/src/relay.ts`
- `relay/src/store.ts`
- `relay/tsconfig.json`
- `scripts/relayApi.test.mjs`
- `src/shared/push.ts`
- `relay/package-lock.json` (generated by `npm install` in `relay/`; not shown)

- [ ] **Step 1: Tests first.** Write `scripts/relayApi.test.mjs` first (the diff below): it fails (module not found) until the relay files exist.
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 3: Verify:**

```bash
node --test scripts/relayApi.test.mjs
cd relay && npm install && npm run typecheck && npm run build
```
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/package.json b/package.json
index ecd6c66..3438640 100644
--- a/package.json
+++ b/package.json
@@ -6,11 +6,13 @@
   "main": "out/main/index.js",
   "private": true,
   "scripts": {
-    "postinstall": "node scripts/fix-pty-helper.mjs && npm --prefix server install",
+    "postinstall": "node scripts/fix-pty-helper.mjs && npm --prefix server install && npm --prefix relay install",
     "dev": "npm run build:server && electron-vite dev",
     "build": "electron-vite build && npm run build:web && npm run build:server",
     "build:web": "vite build --config vite.web.config.ts",
     "build:server": "npm --prefix server run build && node scripts/bundle-server.mjs",
+    "build:relay": "npm --prefix relay run build",
+    "typecheck:relay": "npm --prefix relay run typecheck",
     "start": "electron-vite preview",
     "typecheck": "tsc --noEmit",
     "test": "node --test scripts/*.test.mjs",
diff --git a/relay/package.json b/relay/package.json
new file mode 100644
index 0000000..f6609fb
--- /dev/null
+++ b/relay/package.json
@@ -0,0 +1,25 @@
+{
+  "name": "trek-relay",
+  "version": "0.1.0",
+  "description": "Trek push relay: holds the APNs key and FCM credentials and forwards trek-server attention to paired phones",
+  "private": true,
+  "bin": {
+    "trek-relay": "dist/trek-relay.cjs"
+  },
+  "files": [
+    "dist"
+  ],
+  "engines": {
+    "node": ">=20"
+  },
+  "scripts": {
+    "build": "node scripts/build.mjs",
+    "start": "node src/index.ts start",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@types/node": "^22.0.0",
+    "esbuild": "^0.28.2",
+    "typescript": "^5.6.0"
+  }
+}
diff --git a/relay/scripts/build.mjs b/relay/scripts/build.mjs
new file mode 100644
index 0000000..65a7a07
--- /dev/null
+++ b/relay/scripts/build.mjs
@@ -0,0 +1,24 @@
+// Bundles the relay (and the shared push vocabulary it imports from ../src) into one executable
+// CommonJS file, dist/trek-relay.cjs. It has no runtime dependencies: http, http2 and crypto are
+// Node's own.
+import { build } from 'esbuild'
+import { chmodSync, readFileSync } from 'node:fs'
+import { fileURLToPath } from 'node:url'
+
+const root = fileURLToPath(new URL('..', import.meta.url))
+const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
+const outfile = `${root}dist/trek-relay.cjs`
+
+await build({
+  entryPoints: [`${root}src/index.ts`],
+  outfile,
+  bundle: true,
+  platform: 'node',
+  target: 'node20',
+  format: 'cjs',
+  define: { __TREK_RELAY_VERSION__: JSON.stringify(version) },
+  banner: { js: '#!/usr/bin/env node' },
+  logLevel: 'info'
+})
+chmodSync(outfile, 0o755)
+console.log(`trek-relay ${version}`)
diff --git a/relay/src/api.ts b/relay/src/api.ts
new file mode 100644
index 0000000..cb00288
--- /dev/null
+++ b/relay/src/api.ts
@@ -0,0 +1,203 @@
+// The relay's HTTP API (/v1). A phone registers its push token and gets a device secret; with it,
+// it makes one grant per paired server and hands only the grant's secret to that server. A server
+// pushes with its grant secret: the relay looks the grant up, builds the words from the kind and
+// project (src/shared/push.ts), and sends through APNs or FCM. Nothing a server sends reaches the
+// lock screen as free text, and the relay never logs a push's words, tokens or secrets.
+import type { IncomingMessage, ServerResponse } from 'node:http'
+import { isPushKind, MAX_PUSH_ID, pushText, type PushData, type PushKind } from '../../src/shared/push.ts'
+import { PUSHES_PER_DEVICE_PER_HOUR, PUSHES_PER_GRANT_PER_MINUTE, REGISTRATIONS_PER_MINUTE, WindowLimiter } from './limits.ts'
+import { MAX_LABEL, MAX_PUSH_TOKEN, type Device, type Platform, type RelayStore } from './store.ts'
+
+export const MAX_BODY_BYTES = 16 * 1024
+/** A project name longer than this is refused outright (pushText cuts to MAX_PUSH_PROJECT) */
+const MAX_PROJECT_INPUT = 400
+
+export interface PushMessage {
+  title: string
+  body: string
+  kind: PushKind
+  data: PushData
+}
+
+/** 'sent'; 'dead' (the token is gone: unregistered); 'failed' (anything else, logged) */
+export type SendResult = 'sent' | 'dead' | 'failed'
+
+export interface Provider {
+  send(device: Device, message: PushMessage): Promise<SendResult>
+}
+
+export interface RelayDeps {
+  store: RelayStore
+  providers: Partial<Record<Platform, Provider>>
+  now?: () => number
+  log?: (line: string) => void
+}
+
+class HttpError extends Error {
+  readonly status: number
+  constructor(status: number, message: string) {
+    super(message)
+    this.status = status
+  }
+}
+
+const json = (res: ServerResponse, status: number, body: unknown): void => {
+  const text = JSON.stringify(body)
+  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
+  res.end(text)
+}
+
+function readBody(req: IncomingMessage): Promise<unknown> {
+  return new Promise((resolve, reject) => {
+    const chunks: Buffer[] = []
+    let size = 0
+    let tooBig = false
+    req.on('data', (chunk: Buffer) => {
+      size += chunk.length
+      if (size > MAX_BODY_BYTES) {
+        tooBig = true
+        return
+      }
+      if (!tooBig) chunks.push(chunk)
+    })
+    req.on('end', () => {
+      if (tooBig) return reject(new HttpError(413, 'body too large'))
+      if (size === 0) return resolve({})
+      try {
+        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
+      } catch {
+        reject(new HttpError(400, 'body must be JSON'))
+      }
+    })
+    req.on('error', reject)
+  })
+}
+
+const bearer = (req: IncomingMessage): string => {
+  const h = req.headers.authorization
+  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(h) : null
+  if (!m) throw new HttpError(401, 'unauthorized')
+  return m[1]
+}
+
+const obj = (v: unknown): Record<string, unknown> => {
+  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be an object')
+  return v as Record<string, unknown>
+}
+
+const pushTokenOf = (v: unknown): string => {
+  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_TOKEN || /\s/.test(v)) throw new HttpError(400, 'pushToken must be a token string')
+  return v
+}
+
+const idOf = (v: unknown, what: string, required: boolean): string | undefined => {
+  if (v === undefined && !required) return undefined
+  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_ID || !/^[\w.:-]+$/.test(v)) throw new HttpError(400, `data.${what} must be an id`)
+  return v
+}
+
+export function createRelayHandler(deps: RelayDeps): (req: IncomingMessage, res: ServerResponse) => void {
+  const now = deps.now ?? Date.now
+  const log = deps.log ?? ((line: string) => console.log(line))
+  const registrations = new WindowLimiter(REGISTRATIONS_PER_MINUTE, 60_000)
+  const perGrant = new WindowLimiter(PUSHES_PER_GRANT_PER_MINUTE, 60_000)
+  const perDevice = new WindowLimiter(PUSHES_PER_DEVICE_PER_HOUR, 3_600_000)
+  const { store } = deps
+
+  const device = (req: IncomingMessage, id?: string): Device => {
+    const d = store.deviceFor(bearer(req), id)
+    if (!d) throw new HttpError(401, 'unauthorized')
+    return d
+  }
+
+  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
+    const url = new URL(req.url ?? '/', 'http://relay')
+    const path = url.pathname
+    const method = req.method ?? 'GET'
+    if (path === '/v1/health' && method === 'GET') return json(res, 200, { ok: true })
+
+    if (path === '/v1/devices' && method === 'POST') {
+      if (!registrations.take(req.socket.remoteAddress ?? '', now())) throw new HttpError(429, 'too many registrations')
+      const b = obj(await readBody(req))
+      if (b.platform !== 'ios' && b.platform !== 'android') throw new HttpError(400, "platform must be 'ios' or 'android'")
+      if (!deps.providers[b.platform]) throw new HttpError(400, `this relay does not push to ${b.platform}`)
+      const { device: d, secret } = store.addDevice(b.platform, pushTokenOf(b.pushToken))
+      log(`[relay] registered a ${d.platform} device ${d.id}`)
+      return json(res, 201, { deviceId: d.id, deviceSecret: secret })
+    }
+
+    const deviceMatch = /^\/v1\/devices\/([\w-]{1,64})$/.exec(path)
+    if (deviceMatch && (method === 'PUT' || method === 'DELETE')) {
+      const d = device(req, deviceMatch[1])
+      if (method === 'DELETE') {
+        store.removeDevice(d.id)
+        log(`[relay] removed device ${d.id}`)
+        return json(res, 200, { removed: true })
+      }
+      const b = obj(await readBody(req))
+      store.setPushToken(d.id, pushTokenOf(b.pushToken))
+      return json(res, 200, { updated: true })
+    }
+
+    if (path === '/v1/grants' && method === 'GET') {
+      const d = device(req)
+      return json(res, 200, store.grantsOf(d.id).map((g) => ({ grantId: g.id, label: g.label, createdAt: g.createdAt, lastPushAt: g.lastPushAt ?? null })))
+    }
+    if (path === '/v1/grants' && method === 'POST') {
+      const d = device(req)
+      const b = obj(await readBody(req))
+      if (typeof b.label !== 'string' || b.label.length > MAX_LABEL) throw new HttpError(400, `label must be a string of up to ${MAX_LABEL} characters`)
+      const made = store.addGrant(d.id, b.label.trim())
+      if (made === 'full') throw new HttpError(409, 'this device has too many grants')
+      return json(res, 201, { grantId: made.grant.id, grantSecret: made.secret })
+    }
+    const grantMatch = /^\/v1\/grants\/([\w-]{1,64})$/.exec(path)
+    if (grantMatch && method === 'DELETE') {
+      const d = device(req)
+      if (!store.removeGrant(d.id, grantMatch[1])) throw new HttpError(404, 'no such grant')
+      return json(res, 200, { revoked: true })
+    }
+
+    if (path === '/v1/push' && method === 'POST') {
+      const found = store.grantFor(bearer(req))
+      if (!found) throw new HttpError(401, 'unknown grant')
+      const { grant, device: d } = found
+      if (d.dead) throw new HttpError(410, 'the device is gone')
+      const b = obj(await readBody(req))
+      if (!isPushKind(b.kind)) throw new HttpError(400, 'unknown kind')
+      if (typeof b.project !== 'string' || b.project.length > MAX_PROJECT_INPUT) throw new HttpError(400, 'project must be a string')
+      const data = obj(b.data)
+      const pushData: PushData = {
+        serverId: idOf(data.serverId, 'serverId', true)!,
+        projectId: idOf(data.projectId, 'projectId', true)!,
+        ...(data.worktreeId !== undefined ? { worktreeId: idOf(data.worktreeId, 'worktreeId', false) } : {}),
+        ...(data.sessionId !== undefined ? { sessionId: idOf(data.sessionId, 'sessionId', false) } : {})
+      }
+      const t = now()
+      if (!perGrant.take(grant.id, t) || !perDevice.take(d.id, t)) throw new HttpError(429, 'too many pushes')
+      const provider = deps.providers[d.platform]
+      if (!provider) throw new HttpError(503, `this relay does not push to ${d.platform}`)
+      const words = pushText(b.kind, b.project)
+      const result = await provider.send(d, { ...words, kind: b.kind, data: pushData })
+      log(`[relay] push ${b.kind} grant ${grant.id}: ${result}`)
+      if (result === 'dead') {
+        store.markDead(d.id)
+        throw new HttpError(410, 'the device is gone')
+      }
+      if (result === 'failed') throw new HttpError(502, 'the push service refused the push')
+      store.touchGrant(grant.id)
+      return json(res, 202, { accepted: true })
+    }
+
+    throw new HttpError(404, 'not found')
+  }
+
+  return (req, res) => {
+    route(req, res).catch((err) => {
+      const status = err instanceof HttpError ? err.status : 500
+      if (status === 500) log(`[relay] internal error: ${(err as Error).message}`)
+      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : (err as Error).message })
+      else res.destroy()
+    })
+  }
+}
diff --git a/relay/src/config.ts b/relay/src/config.ts
new file mode 100644
index 0000000..9fb59c4
--- /dev/null
+++ b/relay/src/config.ts
@@ -0,0 +1,113 @@
+// trek-relay's config file. It names where the relay keeps its store and where the push
+// credentials are: the APNs .p8 key and the FCM service-account JSON. Those files, and the config
+// itself, must be readable by their owner only, or the relay refuses to start.
+import { readFileSync, statSync } from 'node:fs'
+import { dirname, isAbsolute, resolve } from 'node:path'
+
+export interface ApnsConfig {
+  keyId: string
+  teamId: string
+  /** The app's bundle id: the `apns-topic` */
+  bundleId: string
+  /** The .p8 key's path (absolute, or relative to the config file) */
+  keyPath: string
+  /** true: api.push.apple.com; false: the sandbox (development builds) */
+  production: boolean
+}
+
+export interface FcmConfig {
+  /** The service account JSON's path (absolute, or relative to the config file) */
+  serviceAccountPath: string
+}
+
+export interface RelayConfig {
+  dataDir: string
+  host: string
+  port: number
+  apns?: ApnsConfig
+  fcm?: FcmConfig
+  /**
+   * Tests only: the providers' origins (a local stub). APNs is reached over HTTP/2 at
+   * `apnsHost`; `http://` means cleartext HTTP/2 (h2c), which only a stub speaks.
+   */
+  apnsHost?: string
+  fcmHost?: string
+  oauthHost?: string
+}
+
+export const DEFAULT_RELAY_PORT = 7346
+export const DEFAULT_RELAY_HOST = '127.0.0.1'
+
+const str = (v: unknown, what: string): string => {
+  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} must be a non-empty string`)
+  return v.trim()
+}
+
+/** The file's mode must give group and others nothing. */
+export function assertOwnerOnly(path: string, what: string): void {
+  let mode: number
+  try {
+    mode = statSync(path).mode
+  } catch (err) {
+    throw new Error(`${what} (${path}) cannot be read: ${(err as Error).message}`)
+  }
+  if ((mode & 0o077) !== 0) {
+    throw new Error(`${what} (${path}) is readable by others (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`)
+  }
+}
+
+const originOf = (v: unknown, what: string): string | undefined => {
+  if (v === undefined) return undefined
+  const s = str(v, what)
+  let url: URL
+  try {
+    url = new URL(s)
+  } catch {
+    throw new Error(`${what} must be a URL`)
+  }
+  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${what} must be http(s)`)
+  return url.origin
+}
+
+/** Reads and checks the config file; relative paths resolve against its directory. */
+export function loadRelayConfig(path: string): RelayConfig {
+  assertOwnerOnly(path, 'The relay config')
+  let raw: unknown
+  try {
+    raw = JSON.parse(readFileSync(path, 'utf8'))
+  } catch (err) {
+    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
+  }
+  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`)
+  const c = raw as Record<string, unknown>
+  const base = dirname(resolve(path))
+  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(base, p))
+  const config: RelayConfig = {
+    dataDir: abs(str(c.dataDir ?? 'relay-data', 'dataDir')),
+    host: c.host === undefined ? DEFAULT_RELAY_HOST : str(c.host, 'host'),
+    port: c.port === undefined ? DEFAULT_RELAY_PORT : Number(c.port)
+  }
+  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('port must be 0–65535')
+  if (c.apns !== undefined) {
+    const a = c.apns as Record<string, unknown>
+    if (!a || typeof a !== 'object') throw new Error('apns must be an object')
+    config.apns = {
+      keyId: str(a.keyId, 'apns.keyId'),
+      teamId: str(a.teamId, 'apns.teamId'),
+      bundleId: str(a.bundleId, 'apns.bundleId'),
+      keyPath: abs(str(a.keyPath, 'apns.keyPath')),
+      production: a.production === true
+    }
+    assertOwnerOnly(config.apns.keyPath, 'The APNs key')
+  }
+  if (c.fcm !== undefined) {
+    const f = c.fcm as Record<string, unknown>
+    if (!f || typeof f !== 'object') throw new Error('fcm must be an object')
+    config.fcm = { serviceAccountPath: abs(str(f.serviceAccountPath, 'fcm.serviceAccountPath')) }
+    assertOwnerOnly(config.fcm.serviceAccountPath, 'The FCM service account')
+  }
+  config.apnsHost = originOf(c.apnsHost, 'apnsHost')
+  config.fcmHost = originOf(c.fcmHost, 'fcmHost')
+  config.oauthHost = originOf(c.oauthHost, 'oauthHost')
+  return config
+}
diff --git a/relay/src/index.ts b/relay/src/index.ts
new file mode 100644
index 0000000..f9fc6ba
--- /dev/null
+++ b/relay/src/index.ts
@@ -0,0 +1,55 @@
+// trek-relay's CLI: `trek-relay start --config <file> [--host <h>] [--port <p>]`, `trek-relay version`.
+import { loadRelayConfig } from './config.ts'
+import { createProviders } from './providers.ts'
+import { startRelay } from './relay.ts'
+
+declare const __TREK_RELAY_VERSION__: string | undefined
+const VERSION = typeof __TREK_RELAY_VERSION__ === 'string' ? __TREK_RELAY_VERSION__ : 'dev'
+
+function usage(message?: string): never {
+  if (message) console.error(message)
+  console.error('usage: trek-relay start --config <file> [--host <host>] [--port <port>]\n       trek-relay version')
+  process.exit(2)
+}
+
+async function main(argv: string[]): Promise<void> {
+  const [command, ...rest] = argv
+  if (command === 'version' || command === '--version') {
+    console.log(`trek-relay ${VERSION}`)
+    return
+  }
+  if (command !== 'start') usage(command ? `unknown command: ${command}` : undefined)
+  let configPath: string | undefined
+  let host: string | undefined
+  let port: number | undefined
+  for (let i = 0; i < rest.length; i += 1) {
+    const flag = rest[i]
+    const value = rest[i + 1]
+    if (flag === '--config' && value) configPath = value
+    else if (flag === '--host' && value) host = value
+    else if (flag === '--port' && value) port = Number(value)
+    else usage(`unknown or incomplete option: ${flag}`)
+    i += 1
+  }
+  if (!configPath) usage('--config is required')
+  const config = loadRelayConfig(configPath)
+  if (host !== undefined) config.host = host
+  if (port !== undefined) {
+    if (!Number.isInteger(port) || port < 0 || port > 65535) usage('--port must be 0–65535')
+    config.port = port
+  }
+  const providers = createProviders(config)
+  if (!providers.ios && !providers.android) console.warn('[relay] neither apns nor fcm is configured: every registration will be refused')
+  const relay = await startRelay(config, providers)
+  console.log(`[relay] trek-relay ${VERSION} listening on http://${config.host}:${relay.port} (put your TLS proxy in front)`)
+  const stop = (): void => {
+    void relay.close().then(() => process.exit(0))
+  }
+  process.on('SIGINT', stop)
+  process.on('SIGTERM', stop)
+}
+
+main(process.argv.slice(2)).catch((err) => {
+  console.error(`trek-relay: ${(err as Error).message}`)
+  process.exit(1)
+})
diff --git a/relay/src/limits.ts b/relay/src/limits.ts
new file mode 100644
index 0000000..239536a
--- /dev/null
+++ b/relay/src/limits.ts
@@ -0,0 +1,37 @@
+// Sliding-window counters for the relay's limits: device registrations per address, pushes per
+// grant and per device. Each key keeps only the times inside its window, and a key whose window
+// has emptied is dropped, so the maps stay as small as the traffic.
+
+export class WindowLimiter {
+  private readonly hits = new Map<string, number[]>()
+  private readonly limit: number
+  private readonly windowMs: number
+
+  constructor(limit: number, windowMs: number) {
+    this.limit = limit
+    this.windowMs = windowMs
+  }
+
+  /** Counts a hit and says whether it is within the limit (a refused hit isn't counted). */
+  take(key: string, now: number): boolean {
+    const since = now - this.windowMs
+    const times = (this.hits.get(key) ?? []).filter((t) => t > since)
+    if (times.length >= this.limit) {
+      this.hits.set(key, times)
+      return false
+    }
+    times.push(now)
+    this.hits.set(key, times)
+    if (this.hits.size > 10_000) this.sweep(now)
+    return true
+  }
+
+  private sweep(now: number): void {
+    const since = now - this.windowMs
+    for (const [key, times] of this.hits) if (!times.some((t) => t > since)) this.hits.delete(key)
+  }
+}
+
+export const REGISTRATIONS_PER_MINUTE = 10
+export const PUSHES_PER_GRANT_PER_MINUTE = 30
+export const PUSHES_PER_DEVICE_PER_HOUR = 120
diff --git a/relay/src/providers.ts b/relay/src/providers.ts
new file mode 100644
index 0000000..592f0f3
--- /dev/null
+++ b/relay/src/providers.ts
@@ -0,0 +1,8 @@
+// The push services the config names. Task 2 adds APNs and FCM; until then none is configured.
+import type { Provider } from './api.ts'
+import type { RelayConfig } from './config.ts'
+import type { Platform } from './store.ts'
+
+export function createProviders(_config: RelayConfig): Partial<Record<Platform, Provider>> {
+  return {}
+}
diff --git a/relay/src/relay.ts b/relay/src/relay.ts
new file mode 100644
index 0000000..b3a755c
--- /dev/null
+++ b/relay/src/relay.ts
@@ -0,0 +1,35 @@
+// Starts the relay's HTTP server on the config's host and port. TLS is the proxy's job (Caddy in
+// front, as for trek-server); the relay speaks plain HTTP on its own address.
+import { createServer, type Server } from 'node:http'
+import type { AddressInfo } from 'node:net'
+import { createRelayHandler, type Provider } from './api.ts'
+import type { RelayConfig } from './config.ts'
+import type { Platform } from './store.ts'
+import { RelayStore } from './store.ts'
+
+export interface RunningRelay {
+  server: Server
+  port: number
+  close(): Promise<void>
+}
+
+export function startRelay(
+  config: RelayConfig,
+  providers: Partial<Record<Platform, Provider>>,
+  log: (line: string) => void = (line) => console.log(line)
+): Promise<RunningRelay> {
+  const store = new RelayStore(config.dataDir)
+  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, createRelayHandler({ store, providers, log }))
+  return new Promise((resolve, reject) => {
+    server.once('error', reject)
+    server.listen(config.port, config.host, () => {
+      server.off('error', reject)
+      const port = (server.address() as AddressInfo).port
+      resolve({
+        server,
+        port,
+        close: () => new Promise<void>((done) => server.close(() => done()))
+      })
+    })
+  })
+}
diff --git a/relay/src/store.ts b/relay/src/store.ts
new file mode 100644
index 0000000..dc944e3
--- /dev/null
+++ b/relay/src/store.ts
@@ -0,0 +1,156 @@
+// The relay's devices and grants, in <dataDir>/relay.json (0600, written then renamed). A device is
+// a phone's push token (the relay needs it to send); its secret and every grant's secret are kept
+// only as sha256 hashes, so the file alone can't be used to push or to manage a phone's grants.
+import { createHash, randomBytes, randomUUID } from 'node:crypto'
+import { readFileSync } from 'node:fs'
+import { join } from 'node:path'
+import { writeFileAtomic } from '../../src/host/atomicWrite.ts'
+
+export type Platform = 'ios' | 'android'
+
+export interface Device {
+  id: string
+  platform: Platform
+  pushToken: string
+  secretHash: string
+  createdAt: number
+  /** APNs or FCM said the token is gone: its grants answer 410 */
+  dead?: true
+}
+
+export interface Grant {
+  id: string
+  deviceId: string
+  label: string
+  secretHash: string
+  createdAt: number
+  lastPushAt?: number
+}
+
+interface StoreFile {
+  version: 1
+  devices: Device[]
+  grants: Grant[]
+}
+
+export const STORE_FILE = 'relay.json'
+/** A device holds at most this many grants (one per paired server) */
+export const MAX_GRANTS_PER_DEVICE = 50
+export const MAX_LABEL = 80
+export const MAX_PUSH_TOKEN = 4096
+
+export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')
+/** 256 random bits, base64url */
+export const newSecret = (): string => randomBytes(32).toString('base64url')
+
+export class RelayStore {
+  private readonly path: string
+  private devices = new Map<string, Device>()
+  private grants = new Map<string, Grant>()
+  private deviceBySecret = new Map<string, string>()
+  private grantBySecret = new Map<string, string>()
+  private readonly now: () => number
+
+  constructor(dataDir: string, now: () => number = Date.now) {
+    this.path = join(dataDir, STORE_FILE)
+    this.now = now
+    let text: string | undefined
+    try {
+      text = readFileSync(this.path, 'utf8')
+    } catch (err) {
+      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${this.path} cannot be read: ${(err as Error).message}`)
+    }
+    if (text !== undefined) {
+      const file = JSON.parse(text) as StoreFile
+      for (const d of file.devices ?? []) this.devices.set(d.id, d)
+      for (const g of file.grants ?? []) if (this.devices.has(g.deviceId)) this.grants.set(g.id, g)
+      this.reindex()
+    }
+  }
+
+  private reindex(): void {
+    this.deviceBySecret = new Map([...this.devices.values()].map((d) => [d.secretHash, d.id]))
+    this.grantBySecret = new Map([...this.grants.values()].map((g) => [g.secretHash, g.id]))
+  }
+
+  private save(): void {
+    const file: StoreFile = { version: 1, devices: [...this.devices.values()], grants: [...this.grants.values()] }
+    writeFileAtomic(this.path, JSON.stringify(file, null, 2) + '\n', 0o600)
+  }
+
+  addDevice(platform: Platform, pushToken: string): { device: Device; secret: string } {
+    const secret = newSecret()
+    const device: Device = { id: randomUUID(), platform, pushToken, secretHash: hashSecret(secret), createdAt: this.now() }
+    this.devices.set(device.id, device)
+    this.deviceBySecret.set(device.secretHash, device.id)
+    this.save()
+    return { device, secret }
+  }
+
+  /** The device the secret belongs to, if its id matches */
+  deviceFor(secret: string, id?: string): Device | undefined {
+    const deviceId = this.deviceBySecret.get(hashSecret(secret))
+    if (!deviceId || (id !== undefined && id !== deviceId)) return undefined
+    return this.devices.get(deviceId)
+  }
+
+  /** A new token brings a dead device back */
+  setPushToken(id: string, pushToken: string): void {
+    const d = this.devices.get(id)
+    if (!d) return
+    d.pushToken = pushToken
+    delete d.dead
+    this.save()
+  }
+
+  removeDevice(id: string): void {
+    if (!this.devices.delete(id)) return
+    for (const [gid, g] of this.grants) if (g.deviceId === id) this.grants.delete(gid)
+    this.reindex()
+    this.save()
+  }
+
+  markDead(id: string): void {
+    const d = this.devices.get(id)
+    if (!d || d.dead) return
+    d.dead = true
+    this.save()
+  }
+
+  grantsOf(deviceId: string): Grant[] {
+    return [...this.grants.values()].filter((g) => g.deviceId === deviceId)
+  }
+
+  addGrant(deviceId: string, label: string): { grant: Grant; secret: string } | 'full' {
+    if (this.grantsOf(deviceId).length >= MAX_GRANTS_PER_DEVICE) return 'full'
+    const secret = newSecret()
+    const grant: Grant = { id: randomUUID(), deviceId, label, secretHash: hashSecret(secret), createdAt: this.now() }
+    this.grants.set(grant.id, grant)
+    this.grantBySecret.set(grant.secretHash, grant.id)
+    this.save()
+    return { grant, secret }
+  }
+
+  removeGrant(deviceId: string, grantId: string): boolean {
+    const g = this.grants.get(grantId)
+    if (!g || g.deviceId !== deviceId) return false
+    this.grants.delete(grantId)
+    this.grantBySecret.delete(g.secretHash)
+    this.save()
+    return true
+  }
+
+  /** The grant and its device for a server's bearer secret */
+  grantFor(secret: string): { grant: Grant; device: Device } | undefined {
+    const grantId = this.grantBySecret.get(hashSecret(secret))
+    const grant = grantId ? this.grants.get(grantId) : undefined
+    const device = grant ? this.devices.get(grant.deviceId) : undefined
+    return grant && device ? { grant, device } : undefined
+  }
+
+  /** Recorded in memory only: written with the next change, so a busy relay doesn't rewrite the file per push */
+  touchGrant(grantId: string): void {
+    const g = this.grants.get(grantId)
+    if (g) g.lastPushAt = this.now()
+  }
+}
diff --git a/relay/tsconfig.json b/relay/tsconfig.json
new file mode 100644
index 0000000..08cdaa6
--- /dev/null
+++ b/relay/tsconfig.json
@@ -0,0 +1,16 @@
+{
+  "compilerOptions": {
+    "target": "ES2022",
+    "module": "NodeNext",
+    "moduleResolution": "NodeNext",
+    "lib": ["ES2023"],
+    "types": ["node"],
+    "strict": true,
+    "skipLibCheck": true,
+    "noEmit": true,
+    "esModuleInterop": true,
+    "allowImportingTsExtensions": true,
+    "resolveJsonModule": true
+  },
+  "include": ["src/**/*.ts", "../src/shared/push.ts", "../src/host/atomicWrite.ts"]
+}
diff --git a/scripts/relayApi.test.mjs b/scripts/relayApi.test.mjs
new file mode 100644
index 0000000..25a4d25
--- /dev/null
+++ b/scripts/relayApi.test.mjs
@@ -0,0 +1,180 @@
+// trek-relay (6b): the config's owner-only rule, the store (hashed secrets, 0600) and the /v1 API
+// (registration, grants, auth, limits, the body cap, kinds, dead devices), with a fake provider.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { loadRelayConfig } from '../relay/src/config.ts'
+import { RelayStore, hashSecret, MAX_GRANTS_PER_DEVICE } from '../relay/src/store.ts'
+import { startRelay } from '../relay/src/relay.ts'
+import { MAX_BODY_BYTES } from '../relay/src/api.ts'
+import { pushText, pushGroupOf, PUSH_KINDS, MAX_PUSH_PROJECT } from '../src/shared/push.ts'
+
+const temp = (t) => {
+  const dir = mkdtempSync(join(tmpdir(), 'trek-relay-test-'))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  return dir
+}
+
+function fakeProvider() {
+  const sent = []
+  let next = 'sent'
+  return {
+    sent,
+    set result(r) {
+      next = r
+    },
+    async send(device, message) {
+      sent.push({ device: device.id, token: device.pushToken, message })
+      return next
+    }
+  }
+}
+
+async function relay(t, providers = { ios: fakeProvider(), android: fakeProvider() }) {
+  const dataDir = temp(t)
+  const running = await startRelay({ dataDir, host: '127.0.0.1', port: 0 }, providers, () => {})
+  t.after(() => running.close())
+  const base = `http://127.0.0.1:${running.port}`
+  const call = async (method, path, body, secret) => {
+    const res = await fetch(base + path, {
+      method,
+      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
+      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
+    })
+    return { status: res.status, body: await res.json().catch(() => null) }
+  }
+  return { call, providers, dataDir }
+}
+
+const pushBody = (extra = {}) => ({ kind: 'decision', project: 'trek-app', data: { serverId: 's1', projectId: 'p1', sessionId: 'x1' }, ...extra })
+
+test('push text: a fixed sentence per kind, the project cut and cleaned', () => {
+  assert.deepEqual(pushText('decision', 'trek-app'), { title: 'Trek · trek-app', body: 'A decision is waiting' })
+  assert.equal(pushText('pr-merged', 'a\u0007b‮').title, 'Trek · ab')
+  assert.equal(pushText('decision', 'x'.repeat(200)).title.length, 'Trek · '.length + MAX_PUSH_PROJECT)
+  assert.equal(pushText('session-stopped', '').title, 'Trek')
+  for (const kind of PUSH_KINDS) assert.ok(pushText(kind, 'p').body.length > 0)
+  assert.equal(pushGroupOf('decision'), 'decisions')
+  assert.equal(pushGroupOf('session-stopped'), 'sessions')
+  assert.equal(pushGroupOf('pr-conflict'), 'prWatch')
+})
+
+test('config: refuses a config or credential file others can read; resolves paths against the config', (t) => {
+  const dir = temp(t)
+  const key = join(dir, 'AuthKey.p8')
+  writeFileSync(key, 'k', { mode: 0o600 })
+  const path = join(dir, 'relay.json')
+  writeFileSync(path, JSON.stringify({ dataDir: 'data', apns: { keyId: 'K', teamId: 'T', bundleId: 'app.trek', keyPath: 'AuthKey.p8' } }), { mode: 0o644 })
+  assert.throws(() => loadRelayConfig(path), /readable by others/)
+  chmodSync(path, 0o600)
+  chmodSync(key, 0o640)
+  assert.throws(() => loadRelayConfig(path), /APNs key .* readable by others/)
+  chmodSync(key, 0o600)
+  const config = loadRelayConfig(path)
+  assert.equal(config.dataDir, join(dir, 'data'))
+  assert.equal(config.apns.keyPath, key)
+  assert.equal(config.apns.production, false)
+  assert.equal(config.port, 7346)
+})
+
+test('store: secrets are kept only as hashes, the file is 0600 and survives a reload', (t) => {
+  const dir = temp(t)
+  const store = new RelayStore(dir)
+  const { device, secret } = store.addDevice('ios', 'apns-token-1')
+  const { secret: grantSecret } = store.addGrant(device.id, 'dev server')
+  const text = readFileSync(join(dir, 'relay.json'), 'utf8')
+  assert.ok(!text.includes(secret) && !text.includes(grantSecret))
+  assert.ok(text.includes(hashSecret(secret)))
+  assert.equal(statSync(join(dir, 'relay.json')).mode & 0o777, 0o600)
+  const again = new RelayStore(dir)
+  assert.equal(again.deviceFor(secret)?.id, device.id)
+  assert.equal(again.grantFor(grantSecret)?.device.id, device.id)
+  assert.equal(again.deviceFor('nope'), undefined)
+})
+
+test('api: register, take grants, list and revoke them, rotate the token, remove the device', async (t) => {
+  const { call } = await relay(t)
+  const reg = await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-a' })
+  assert.equal(reg.status, 201)
+  const { deviceId, deviceSecret } = reg.body
+  assert.equal((await call('POST', '/v1/grants', { label: 'laptop' })).status, 401)
+  const g = await call('POST', '/v1/grants', { label: 'dev server' }, deviceSecret)
+  assert.equal(g.status, 201)
+  const list = await call('GET', '/v1/grants', undefined, deviceSecret)
+  assert.deepEqual(list.body.map((x) => x.label), ['dev server'])
+  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'tok-b' }, deviceSecret)).status, 200)
+  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'tok-c' }, g.body.grantSecret)).status, 401, 'a grant secret is not a device secret')
+  assert.equal((await call('DELETE', `/v1/grants/${g.body.grantId}`, undefined, deviceSecret)).status, 200)
+  assert.equal((await call('POST', '/v1/push', pushBody(), g.body.grantSecret)).status, 401, 'a revoked grant no longer pushes')
+  assert.equal((await call('DELETE', `/v1/devices/${deviceId}`, undefined, deviceSecret)).status, 200)
+  assert.equal((await call('GET', '/v1/grants', undefined, deviceSecret)).status, 401)
+})
+
+test('api: a push builds its words from the kind and project, and sends to the right device', async (t) => {
+  const { call, providers } = await relay(t)
+  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'android', pushToken: 'fcm-1' })).body
+  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
+  const r = await call('POST', '/v1/push', pushBody({ kind: 'pr-checks-failed', title: 'ignored', body: 'ignored' }), grantSecret)
+  assert.equal(r.status, 202)
+  assert.equal(providers.android.sent.length, 1)
+  const m = providers.android.sent[0].message
+  assert.equal(providers.android.sent[0].token, 'fcm-1')
+  assert.deepEqual([m.title, m.body, m.kind], ['Trek · trek-app', 'Pull request checks failed', 'pr-checks-failed'])
+  assert.deepEqual(m.data, { serverId: 's1', projectId: 'p1', sessionId: 'x1' })
+  assert.equal(providers.ios.sent.length, 0)
+  const list = (await call('GET', '/v1/grants', undefined, deviceSecret)).body
+  assert.equal(typeof list[0].lastPushAt, 'number')
+})
+
+test('api: bad input is refused (kind, ids, label, platform, token, body size, JSON, method)', async (t) => {
+  const { call } = await relay(t, { ios: fakeProvider() })
+  assert.equal((await call('POST', '/v1/devices', { platform: 'android', pushToken: 't' })).status, 400, 'no FCM configured')
+  assert.equal((await call('POST', '/v1/devices', { platform: 'web', pushToken: 't' })).status, 400)
+  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a b' })).status, 400)
+  assert.equal((await call('POST', '/v1/devices', '{nope')).status, 400)
+  assert.equal((await call('POST', '/v1/devices', 'x'.repeat(MAX_BODY_BYTES + 1))).status, 413)
+  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 't' })).body
+  assert.equal((await call('POST', '/v1/grants', { label: 'x'.repeat(81) }, deviceSecret)).status, 400)
+  const { grantSecret } = (await call('POST', '/v1/grants', { label: 'ok' }, deviceSecret)).body
+  assert.equal((await call('POST', '/v1/push', pushBody({ kind: 'free-text' }), grantSecret)).status, 400)
+  assert.equal((await call('POST', '/v1/push', pushBody({ data: { serverId: 's', projectId: 'p q' } }), grantSecret)).status, 400)
+  assert.equal((await call('POST', '/v1/push', pushBody({ data: { projectId: 'p' } }), grantSecret)).status, 400)
+  assert.equal((await call('GET', '/v1/push', undefined, grantSecret)).status, 404)
+})
+
+test('api: limits on registrations, pushes per grant, and grants per device', async (t) => {
+  const { call } = await relay(t)
+  let last
+  for (let i = 0; i < 11; i += 1) last = await call('POST', '/v1/devices', { platform: 'ios', pushToken: `t${i}` })
+  assert.equal(last.status, 429)
+  const store = new RelayStore(temp(t))
+  const { device } = store.addDevice('ios', 'x')
+  for (let i = 0; i < MAX_GRANTS_PER_DEVICE; i += 1) store.addGrant(device.id, `g${i}`)
+  assert.equal(store.addGrant(device.id, 'one more'), 'full')
+})
+
+test('api: 30 pushes a minute per grant, then 429', async (t) => {
+  const { call } = await relay(t)
+  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok' })).body
+  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
+  const statuses = []
+  for (let i = 0; i < 31; i += 1) statuses.push((await call('POST', '/v1/push', pushBody(), grantSecret)).status)
+  assert.equal(statuses.filter((s) => s === 202).length, 30)
+  assert.equal(statuses.at(-1), 429)
+})
+
+test('api: a token the provider calls gone marks the device dead (410) until a new token arrives', async (t) => {
+  const { call, providers } = await relay(t)
+  const { deviceId, deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'old' })).body
+  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
+  providers.ios.result = 'dead'
+  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 410)
+  providers.ios.result = 'sent'
+  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 410, 'stays dead without a new token')
+  await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'new' }, deviceSecret)
+  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 202)
+  providers.ios.result = 'failed'
+  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 502)
+})
diff --git a/src/shared/push.ts b/src/shared/push.ts
new file mode 100644
index 0000000..abf9cbf
--- /dev/null
+++ b/src/shared/push.ts
@@ -0,0 +1,86 @@
+// Background push (6b): the vocabulary shared by trek-server, trek-relay and the phone. A push
+// carries a kind and a project name only; the relay builds the words from this table, so a
+// server can never put arbitrary text (terminal output, a decision's question, a branch) on a
+// lock screen. Dependency-free: the phone imports it (scripts/sharedForMobile.test.mjs).
+
+/** What happened, as a push names it */
+export const PUSH_KINDS = [
+  'decision',
+  'session-finished',
+  'session-stopped',
+  'pr-checks-failed',
+  'pr-checks-passed',
+  'pr-review',
+  'pr-conflict',
+  'pr-merged',
+  'pr-closed'
+] as const
+export type PushKind = (typeof PUSH_KINDS)[number]
+
+/** The phone's three switches, per paired server */
+export type PushGroup = 'decisions' | 'sessions' | 'prWatch'
+export const PUSH_GROUPS: readonly PushGroup[] = ['decisions', 'sessions', 'prWatch']
+
+export function pushGroupOf(kind: PushKind): PushGroup {
+  if (kind === 'decision') return 'decisions'
+  if (kind === 'session-finished' || kind === 'session-stopped') return 'sessions'
+  return 'prWatch'
+}
+
+export function isPushKind(value: unknown): value is PushKind {
+  return typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value)
+}
+
+const BODIES: Record<PushKind, string> = {
+  decision: 'A decision is waiting',
+  'session-finished': 'A session is waiting for you',
+  'session-stopped': 'A session stopped',
+  'pr-checks-failed': 'Pull request checks failed',
+  'pr-checks-passed': 'Pull request checks passed',
+  'pr-review': 'New pull request review comments',
+  'pr-conflict': 'The pull request has a merge conflict',
+  'pr-merged': 'The pull request was merged',
+  'pr-closed': 'The pull request was closed'
+}
+
+/** Longest project name a push carries; longer ones are cut with an ellipsis */
+export const MAX_PUSH_PROJECT = 80
+/** Longest id in a push's `data` */
+export const MAX_PUSH_ID = 128
+
+/** Cuts a project name to MAX_PUSH_PROJECT and drops control characters. */
+export function pushProject(name: string): string {
+  // eslint-disable-next-line no-control-regex
+  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim()
+  return clean.length > MAX_PUSH_PROJECT ? `${clean.slice(0, MAX_PUSH_PROJECT - 1)}…` : clean
+}
+
+/** The words on the lock screen: "Trek · <project>" over the kind's fixed sentence. */
+export function pushText(kind: PushKind, project: string): { title: string; body: string } {
+  const name = pushProject(project)
+  return { title: name ? `Trek · ${name}` : 'Trek', body: BODIES[kind] }
+}
+
+/** The ids the phone uses to open the right screen when the push is tapped */
+export interface PushData {
+  serverId: string
+  projectId: string
+  worktreeId?: string
+  sessionId?: string
+}
+
+/** `POST /v1/push`'s body (from a server, bearer: its grant secret) */
+export interface RelayPushBody {
+  kind: PushKind
+  project: string
+  data: PushData
+}
+
+/** The switches a phone sets on a server (`push.setGrant`) */
+export interface PushKinds {
+  decisions: boolean
+  sessions: boolean
+  prWatch: boolean
+}
+
+export const ALL_PUSH_KINDS_ON: PushKinds = { decisions: true, sessions: true, prWatch: true }
````

</details>

### Task 2: APNs and FCM

APNs over node:http2 with the ES256 provider token (cached 50 min); FCM v1 with the service-account assertion and a cached access token; dead tokens; the stubs.

**Prototype commit:** `98644bc` on `central-server-phase6b-proto`.

**Files:**
- `relay/src/apns.ts`
- `relay/src/fcm.ts`
- `relay/src/jwt.ts`
- `relay/src/providers.ts`
- `scripts/relayProviders.test.mjs`
- `scripts/relayStubs.mjs`

- [ ] **Step 1: Tests first.** Write `scripts/relayStubs.mjs` and `scripts/relayProviders.test.mjs` first; they fail until `apns.ts`, `fcm.ts` and `jwt.ts` exist. The stub closes its HTTP/2 sessions itself, or the test run hangs.
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 3: Verify:**

```bash
node --test --test-timeout=30000 scripts/relayProviders.test.mjs scripts/relayApi.test.mjs
cd relay && npm run typecheck
```
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/relay/src/apns.ts b/relay/src/apns.ts
new file mode 100644
index 0000000..a8ea101
--- /dev/null
+++ b/relay/src/apns.ts
@@ -0,0 +1,106 @@
+// Apple Push Notification service, over HTTP/2 with a provider token (the .p8 key). One session is
+// kept open and reopened when it closes. A 410, or a 400 saying the token is bad or not for this
+// app, means the phone's token is gone; anything else fails the push and is logged by the caller.
+import { connect, constants, type ClientHttp2Session } from 'node:http2'
+import type { PushMessage, Provider, SendResult } from './api.ts'
+import { ApnsToken } from './jwt.ts'
+import type { Device } from './store.ts'
+
+export const APNS_PRODUCTION = 'https://api.push.apple.com'
+export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'
+const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])
+const SEND_TIMEOUT_MS = 10_000
+
+export interface ApnsOptions {
+  origin: string
+  bundleId: string
+  token: ApnsToken
+  log?: (line: string) => void
+}
+
+export class ApnsProvider implements Provider {
+  private session?: ClientHttp2Session
+  private readonly options: ApnsOptions
+
+  constructor(options: ApnsOptions) {
+    this.options = options
+  }
+
+  private connection(): ClientHttp2Session {
+    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
+    const session = connect(this.options.origin)
+    session.on('error', (err) => this.options.log?.(`[relay] apns connection: ${err.message}`))
+    session.on('close', () => {
+      if (this.session === session) this.session = undefined
+    })
+    session.unref()
+    this.session = session
+    return session
+  }
+
+  private request(device: Device, payload: string): Promise<{ status: number; reason?: string }> {
+    return new Promise((resolve) => {
+      let req
+      try {
+        req = this.connection().request({
+          [constants.HTTP2_HEADER_METHOD]: 'POST',
+          [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(device.pushToken)}`,
+          authorization: `bearer ${this.options.token.get()}`,
+          'apns-topic': this.options.bundleId,
+          'apns-push-type': 'alert',
+          'apns-priority': '10',
+          'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
+          'content-type': 'application/json'
+        })
+      } catch (err) {
+        resolve({ status: 0, reason: (err as Error).message })
+        return
+      }
+      let status = 0
+      let body = ''
+      const timer = setTimeout(() => req.close(constants.NGHTTP2_CANCEL), SEND_TIMEOUT_MS)
+      req.setEncoding('utf8')
+      req.on('response', (headers) => {
+        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
+      })
+      req.on('data', (chunk: string) => {
+        if (body.length < 4096) body += chunk
+      })
+      req.on('end', () => {
+        clearTimeout(timer)
+        let reason: string | undefined
+        try {
+          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined
+        } catch {
+          // not JSON
+        }
+        resolve({ status, reason })
+      })
+      req.on('error', (err) => {
+        clearTimeout(timer)
+        resolve({ status: 0, reason: err.message })
+      })
+      req.end(payload)
+    })
+  }
+
+  async send(device: Device, message: PushMessage): Promise<SendResult> {
+    const payload = JSON.stringify({
+      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
+      trek: { kind: message.kind, ...message.data }
+    })
+    let r = await this.request(device, payload)
+    if (r.status === 403 && r.reason === 'ExpiredProviderToken') {
+      this.options.token.reset()
+      r = await this.request(device, payload)
+    }
+    if (r.status === 200) return 'sent'
+    if (r.status === 410 || (r.status === 400 && r.reason && DEAD_REASONS.has(r.reason))) return 'dead'
+    this.options.log?.(`[relay] apns refused a push: ${r.status} ${r.reason ?? ''}`.trim())
+    return 'failed'
+  }
+
+  close(): void {
+    this.session?.close()
+  }
+}
diff --git a/relay/src/fcm.ts b/relay/src/fcm.ts
new file mode 100644
index 0000000..0a5cd97
--- /dev/null
+++ b/relay/src/fcm.ts
@@ -0,0 +1,115 @@
+// Firebase Cloud Messaging's HTTP v1 API. The service account's key signs an assertion, traded at
+// its token_uri for an access token (cached until a minute before it expires). UNREGISTERED means
+// the phone's token is gone; a 401 re-fetches the access token once.
+import type { KeyObject } from 'node:crypto'
+import type { PushMessage, Provider, SendResult } from './api.ts'
+import { loadPrivateKey, signJwt } from './jwt.ts'
+import type { Device } from './store.ts'
+
+export const FCM_ORIGIN = 'https://fcm.googleapis.com'
+const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
+const SEND_TIMEOUT_MS = 10_000
+
+export interface ServiceAccount {
+  project_id: string
+  client_email: string
+  private_key: string
+  token_uri: string
+}
+
+export function parseServiceAccount(text: string, path: string): ServiceAccount {
+  let raw: Record<string, unknown>
+  try {
+    raw = JSON.parse(text)
+  } catch (err) {
+    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
+  }
+  for (const field of ['project_id', 'client_email', 'private_key', 'token_uri']) {
+    if (typeof raw[field] !== 'string' || !raw[field]) throw new Error(`${path} has no ${field}`)
+  }
+  return raw as unknown as ServiceAccount
+}
+
+export interface FcmOptions {
+  account: ServiceAccount
+  /** Tests only: the FCM origin, and the origin the token_uri's path is sent to */
+  fcmOrigin?: string
+  oauthOrigin?: string
+  now?: () => number
+  log?: (line: string) => void
+}
+
+export class FcmProvider implements Provider {
+  private readonly key: KeyObject
+  private readonly options: FcmOptions
+  private access?: { token: string; until: number }
+
+  constructor(options: FcmOptions) {
+    this.options = options
+    this.key = loadPrivateKey(options.account.private_key, 'The FCM service account key')
+  }
+
+  private now(): number {
+    return (this.options.now ?? Date.now)()
+  }
+
+  private tokenUrl(): string {
+    const uri = new URL(this.options.account.token_uri)
+    return this.options.oauthOrigin ? `${this.options.oauthOrigin}${uri.pathname}` : uri.href
+  }
+
+  private async accessToken(): Promise<string> {
+    const t = this.now()
+    if (this.access && t < this.access.until) return this.access.token
+    const iat = Math.floor(t / 1000)
+    const assertion = signJwt('RS256', {}, { iss: this.options.account.client_email, scope: SCOPE, aud: this.options.account.token_uri, iat, exp: iat + 3600 }, this.key)
+    const res = await fetch(this.tokenUrl(), {
+      method: 'POST',
+      headers: { 'content-type': 'application/x-www-form-urlencoded' },
+      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
+      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
+    })
+    if (!res.ok) throw new Error(`the token exchange answered ${res.status}`)
+    const body = (await res.json()) as { access_token?: string; expires_in?: number }
+    if (!body.access_token) throw new Error('the token exchange gave no access_token')
+    const life = Math.max(60, Number(body.expires_in ?? 3600))
+    this.access = { token: body.access_token, until: t + (life - 60) * 1000 }
+    return body.access_token
+  }
+
+  private async post(device: Device, message: PushMessage): Promise<{ status: number; codes: string[] }> {
+    const origin = this.options.fcmOrigin ?? FCM_ORIGIN
+    const data: Record<string, string> = { kind: message.kind }
+    for (const [k, v] of Object.entries(message.data)) if (typeof v === 'string') data[k] = v
+    const res = await fetch(`${origin}/v1/projects/${encodeURIComponent(this.options.account.project_id)}/messages:send`, {
+      method: 'POST',
+      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
+      body: JSON.stringify({ message: { token: device.pushToken, notification: { title: message.title, body: message.body }, data, android: { priority: 'high' } } }),
+      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
+    })
+    const codes: string[] = []
+    if (!res.ok) {
+      const body = (await res.json().catch(() => null)) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null
+      if (body?.error?.status) codes.push(body.error.status)
+      for (const d of body?.error?.details ?? []) if (d.errorCode) codes.push(d.errorCode)
+    }
+    return { status: res.status, codes }
+  }
+
+  async send(device: Device, message: PushMessage): Promise<SendResult> {
+    try {
+      let r = await this.post(device, message)
+      if (r.status === 401) {
+        this.access = undefined
+        r = await this.post(device, message)
+      }
+      if (r.status === 200) return 'sent'
+      if (r.codes.includes('UNREGISTERED') || (r.status === 404 && r.codes.includes('NOT_FOUND'))) return 'dead'
+      this.options.log?.(`[relay] fcm refused a push: ${r.status} ${r.codes.join(',')}`.trim())
+      return 'failed'
+    } catch (err) {
+      this.options.log?.(`[relay] fcm: ${(err as Error).message}`)
+      return 'failed'
+    }
+  }
+}
diff --git a/relay/src/jwt.ts b/relay/src/jwt.ts
new file mode 100644
index 0000000..83af247
--- /dev/null
+++ b/relay/src/jwt.ts
@@ -0,0 +1,51 @@
+// The two JWTs the relay signs with node:crypto: APNs' provider token (ES256, the .p8 key) and
+// Google's service-account assertion (RS256) that it trades for an FCM access token.
+import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
+
+const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url')
+
+export function signJwt(alg: 'ES256' | 'RS256', header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
+  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`
+  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key)
+  return `${input}.${b64url(signature)}`
+}
+
+export function loadPrivateKey(pem: string, what: string): KeyObject {
+  try {
+    return createPrivateKey(pem)
+  } catch (err) {
+    throw new Error(`${what} is not a private key: ${(err as Error).message}`)
+  }
+}
+
+/** APNs provider tokens last an hour; Apple refuses one refreshed more often than every 20 minutes. */
+export const APNS_TOKEN_TTL_MS = 50 * 60_000
+
+/** An APNs provider token for `teamId`, re-signed once it is APNS_TOKEN_TTL_MS old. */
+export class ApnsToken {
+  private cached?: { token: string; at: number }
+  private readonly key: KeyObject
+  private readonly keyId: string
+  private readonly teamId: string
+  private readonly now: () => number
+
+  constructor(key: KeyObject, keyId: string, teamId: string, now: () => number = Date.now) {
+    this.key = key
+    this.keyId = keyId
+    this.teamId = teamId
+    this.now = now
+  }
+
+  get(): string {
+    const t = this.now()
+    if (!this.cached || t - this.cached.at >= APNS_TOKEN_TTL_MS) {
+      this.cached = { token: signJwt('ES256', { kid: this.keyId }, { iss: this.teamId, iat: Math.floor(t / 1000) }, this.key), at: t }
+    }
+    return this.cached.token
+  }
+
+  /** Apple said ExpiredProviderToken: sign a new one next time */
+  reset(): void {
+    this.cached = undefined
+  }
+}
diff --git a/relay/src/providers.ts b/relay/src/providers.ts
index 592f0f3..05f2305 100644
--- a/relay/src/providers.ts
+++ b/relay/src/providers.ts
@@ -1,8 +1,33 @@
-// The push services the config names. Task 2 adds APNs and FCM; until then none is configured.
+// The push services the config names: APNs for iOS, FCM for Android. A platform with no
+// credentials gets no provider, and the relay refuses to register its devices.
+import { readFileSync } from 'node:fs'
 import type { Provider } from './api.ts'
+import { APNS_PRODUCTION, APNS_SANDBOX, ApnsProvider } from './apns.ts'
 import type { RelayConfig } from './config.ts'
+import { FcmProvider, parseServiceAccount } from './fcm.ts'
+import { ApnsToken, loadPrivateKey } from './jwt.ts'
 import type { Platform } from './store.ts'
 
-export function createProviders(_config: RelayConfig): Partial<Record<Platform, Provider>> {
-  return {}
+export function createProviders(config: RelayConfig, log: (line: string) => void = (line) => console.log(line)): Partial<Record<Platform, Provider>> {
+  const providers: Partial<Record<Platform, Provider>> = {}
+  if (config.apns) {
+    const a = config.apns
+    const key = loadPrivateKey(readFileSync(a.keyPath, 'utf8'), 'The APNs key')
+    providers.ios = new ApnsProvider({
+      origin: config.apnsHost ?? (a.production ? APNS_PRODUCTION : APNS_SANDBOX),
+      bundleId: a.bundleId,
+      token: new ApnsToken(key, a.keyId, a.teamId),
+      log
+    })
+  }
+  if (config.fcm) {
+    const path = config.fcm.serviceAccountPath
+    providers.android = new FcmProvider({
+      account: parseServiceAccount(readFileSync(path, 'utf8'), path),
+      fcmOrigin: config.fcmHost,
+      oauthOrigin: config.oauthHost,
+      log
+    })
+  }
+  return providers
 }
diff --git a/scripts/relayProviders.test.mjs b/scripts/relayProviders.test.mjs
new file mode 100644
index 0000000..0de8343
--- /dev/null
+++ b/scripts/relayProviders.test.mjs
@@ -0,0 +1,99 @@
+// trek-relay's push services (6b), against local stubs only: APNs over HTTP/2 with an ES256
+// provider token, FCM v1 with a service-account assertion traded for an access token, and what
+// each one's answers mean (sent, the token gone, a refusal).
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createPrivateKey } from 'node:crypto'
+import { ApnsProvider } from '../relay/src/apns.ts'
+import { FcmProvider } from '../relay/src/fcm.ts'
+import { ApnsToken, APNS_TOKEN_TTL_MS } from '../relay/src/jwt.ts'
+import { readJwt, startApnsStub, startFcmStub, testApnsKey, testServiceAccount } from './relayStubs.mjs'
+
+const device = (pushToken, platform = 'ios') => ({ id: 'd1', platform, pushToken, secretHash: 'x', createdAt: 0 })
+const message = { title: 'Trek · app', body: 'A decision is waiting', kind: 'decision', data: { serverId: 's', projectId: 'p', sessionId: 'x' } }
+
+test('apns: provider token is ES256 signed by the .p8 key, cached for 50 minutes', () => {
+  const { pem, publicKey } = testApnsKey()
+  let now = 1_700_000_000_000
+  const token = new ApnsToken(createPrivateKey(pem), 'KEY123', 'TEAM456', () => now)
+  const first = token.get()
+  const jwt = readJwt(first, publicKey, 'ES256')
+  assert.ok(jwt.ok)
+  assert.deepEqual(jwt.header, { alg: 'ES256', typ: 'JWT', kid: 'KEY123' })
+  assert.deepEqual(jwt.claims, { iss: 'TEAM456', iat: 1_700_000_000 })
+  now += APNS_TOKEN_TTL_MS - 1
+  assert.equal(token.get(), first)
+  now += 1
+  assert.notEqual(token.get(), first)
+})
+
+test('apns: sends an alert with the topic, the words and the ids; reads 410 and BadDeviceToken as gone', async (t) => {
+  const stub = await startApnsStub()
+  t.after(() => stub.close())
+  const { pem } = testApnsKey()
+  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'app.trek.mobile', token: new ApnsToken(createPrivateKey(pem), 'K', 'T') })
+  t.after(() => apns.close())
+  assert.equal(await apns.send(device('abc123'), message), 'sent')
+  const p = stub.pushes[0]
+  assert.equal(p.path, '/3/device/abc123')
+  assert.equal(p.headers['apns-topic'], 'app.trek.mobile')
+  assert.equal(p.headers['apns-push-type'], 'alert')
+  assert.match(p.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
+  assert.deepEqual(p.body, { aps: { alert: { title: 'Trek · app', body: 'A decision is waiting' }, sound: 'default' }, trek: { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' } })
+  stub.respond = () => ({ status: 410, reason: 'Unregistered' })
+  assert.equal(await apns.send(device('abc123'), message), 'dead')
+  stub.respond = () => ({ status: 400, reason: 'BadDeviceToken' })
+  assert.equal(await apns.send(device('abc123'), message), 'dead')
+  stub.respond = () => ({ status: 429, reason: 'TooManyRequests' })
+  assert.equal(await apns.send(device('abc123'), message), 'failed')
+})
+
+test('apns: ExpiredProviderToken re-signs and retries once', async (t) => {
+  const stub = await startApnsStub()
+  t.after(() => stub.close())
+  const { pem } = testApnsKey()
+  let calls = 0
+  stub.respond = () => (++calls === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 })
+  let now = 0
+  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'b', token: new ApnsToken(createPrivateKey(pem), 'K', 'T', () => (now += 1000)) })
+  t.after(() => apns.close())
+  assert.equal(await apns.send(device('tok'), message), 'sent')
+  assert.equal(stub.pushes.length, 2)
+  assert.notEqual(stub.pushes[0].headers.authorization, stub.pushes[1].headers.authorization)
+})
+
+test('fcm: trades a signed assertion for an access token (cached), then sends the message', async (t) => {
+  const stub = await startFcmStub()
+  t.after(() => stub.close())
+  const { account, publicKey } = testServiceAccount()
+  const fcm = new FcmProvider({ account, fcmOrigin: stub.origin, oauthOrigin: stub.origin })
+  assert.equal(await fcm.send(device('fcm-tok', 'android'), message), 'sent')
+  assert.equal(await fcm.send(device('fcm-tok', 'android'), message), 'sent')
+  assert.equal(stub.tokensIssued(), 1, 'the access token is reused')
+  const jwt = readJwt(stub.assertions[0], publicKey, 'RS256')
+  assert.ok(jwt.ok)
+  assert.equal(jwt.claims.iss, account.client_email)
+  assert.equal(jwt.claims.aud, account.token_uri)
+  assert.equal(jwt.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging')
+  const m = stub.messages[0]
+  assert.equal(m.url, '/v1/projects/trek-test/messages:send')
+  assert.equal(m.authorization, 'Bearer access-1')
+  assert.deepEqual(m.body.message.notification, { title: 'Trek · app', body: 'A decision is waiting' })
+  assert.deepEqual(m.body.message.data, { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' })
+  assert.equal(m.body.message.token, 'fcm-tok')
+})
+
+test('fcm: UNREGISTERED is gone, a 401 re-fetches the token once, other errors fail', async (t) => {
+  const stub = await startFcmStub()
+  t.after(() => stub.close())
+  const { account } = testServiceAccount()
+  const fcm = new FcmProvider({ account, fcmOrigin: stub.origin, oauthOrigin: stub.origin })
+  stub.respond = () => ({ status: 404, error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
+  assert.equal(await fcm.send(device('t', 'android'), message), 'dead')
+  let calls = 0
+  stub.respond = () => (++calls === 1 ? { status: 401, error: { status: 'UNAUTHENTICATED' } } : { status: 200 })
+  assert.equal(await fcm.send(device('t', 'android'), message), 'sent')
+  assert.equal(stub.tokensIssued(), 2)
+  stub.respond = () => ({ status: 400, error: { status: 'INVALID_ARGUMENT' } })
+  assert.equal(await fcm.send(device('t', 'android'), message), 'failed')
+})
diff --git a/scripts/relayStubs.mjs b/scripts/relayStubs.mjs
new file mode 100644
index 0000000..ae14b08
--- /dev/null
+++ b/scripts/relayStubs.mjs
@@ -0,0 +1,112 @@
+// Local stand-ins for APNs, Google's OAuth token endpoint and FCM (6b tests and smoke:push). The
+// relay reaches them through its test-only apnsHost/fcmHost/oauthHost overrides, so no test ever
+// talks to Apple or Google. APNs is cleartext HTTP/2 (h2c) on loopback; the others plain HTTP.
+import { createServer as createH2Server } from 'node:http2'
+import { createServer } from 'node:http'
+import { generateKeyPairSync, verify } from 'node:crypto'
+
+const listen = (server) =>
+  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
+
+/** A .p8-style ES256 key (PKCS#8 PEM) and its public half, for checking provider tokens */
+export function testApnsKey() {
+  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
+  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey }
+}
+
+/** A service-account JSON like Google's, pointing token_uri at `oauthOrigin` (or Google's, overridden by the relay) */
+export function testServiceAccount(tokenUri = 'https://oauth2.googleapis.com/token') {
+  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
+  return {
+    account: {
+      type: 'service_account',
+      project_id: 'trek-test',
+      client_email: 'relay@trek-test.iam.gserviceaccount.com',
+      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
+      token_uri: tokenUri
+    },
+    publicKey
+  }
+}
+
+/** Checks a compact JWT's signature with `publicKey` and returns its header and claims */
+export function readJwt(jwt, publicKey, alg) {
+  const [h, c, s] = jwt.split('.')
+  const ok = verify('sha256', Buffer.from(`${h}.${c}`), alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, Buffer.from(s, 'base64url'))
+  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) }
+}
+
+/**
+ * APNs: records each push ({path, headers, body}); `respond(push)` picks the answer
+ * ({status, reason}), default 200.
+ */
+export async function startApnsStub() {
+  const pushes = []
+  const stub = { pushes, respond: () => ({ status: 200 }) }
+  const server = createH2Server()
+  const sessions = new Set()
+  server.on('session', (s) => {
+    sessions.add(s)
+    s.on('close', () => sessions.delete(s))
+  })
+  server.on('stream', (stream, headers) => {
+    let body = ''
+    stream.setEncoding('utf8')
+    stream.on('data', (c) => (body += c))
+    stream.on('end', () => {
+      const push = { path: headers[':path'], headers, body: body ? JSON.parse(body) : null }
+      pushes.push(push)
+      const { status, reason } = stub.respond(push)
+      stream.respond({ ':status': status, 'content-type': 'application/json' })
+      stream.end(reason ? JSON.stringify({ reason }) : '')
+    })
+  })
+  const port = await listen(server)
+  stub.origin = `http://127.0.0.1:${port}`
+  // A client's HTTP/2 session stays open between pushes: end them, or close() waits forever.
+  stub.close = () =>
+    new Promise((resolve) => {
+      for (const s of sessions) s.destroy()
+      server.close(() => resolve())
+    })
+  return stub
+}
+
+/**
+ * Google's token endpoint (POST /token) and FCM (POST /v1/projects/<p>/messages:send). Records the
+ * token requests' assertions and the messages; `respond(message)` picks FCM's answer.
+ */
+export async function startFcmStub() {
+  const assertions = []
+  const messages = []
+  let issued = 0
+  const stub = { assertions, messages, respond: () => ({ status: 200 }), tokensIssued: () => issued }
+  const server = createServer((req, res) => {
+    let body = ''
+    req.setEncoding('utf8')
+    req.on('data', (c) => (body += c))
+    req.on('end', () => {
+      if (req.url === '/token') {
+        const form = new URLSearchParams(body)
+        assertions.push(form.get('assertion'))
+        issued += 1
+        res.writeHead(200, { 'content-type': 'application/json' })
+        res.end(JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600 }))
+        return
+      }
+      if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url ?? '')) {
+        const message = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) }
+        messages.push(message)
+        const { status, error } = stub.respond(message)
+        res.writeHead(status, { 'content-type': 'application/json' })
+        res.end(JSON.stringify(status === 200 ? { name: 'projects/trek-test/messages/1' } : { error }))
+        return
+      }
+      res.writeHead(404).end()
+    })
+  })
+  const port = await listen(server)
+  stub.origin = `http://127.0.0.1:${port}`
+  stub.close = () => new Promise((resolve) => server.close(() => resolve()))
+  return stub
+}
````

</details>

### Task 3: trek-server push

The push capability, push.setGrant/clearGrant/status, grants per token in secrets.json, the Pusher (attention, exits, PR reports), the switches, pause, connected tokens, coalescing, retries, refused grants, revocation.

**Prototype commit:** `332f7d5` on `central-server-phase6b-proto`.

**Files:**
- `scripts/serverPush.test.mjs`
- `scripts/serverV2.test.mjs`
- `server/src/capabilities.ts`
- `server/src/index.ts`
- `server/src/prWatch/watcher.ts`
- `server/src/push/grants.ts`
- `server/src/push/pusher.ts`
- `server/src/secrets.ts`
- `server/src/server.ts`
- `server/src/sessions/manager.ts`
- `server/src/v2.ts`
- `src/shared/protocolV2.ts`

- [ ] **Step 1: Tests first.** Write `scripts/serverPush.test.mjs` first; add `push` to the capability list in `scripts/serverV2.test.mjs`.
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 3: Verify:**

```bash
node --test --test-timeout=30000 scripts/serverPush.test.mjs scripts/serverV2.test.mjs
npm run typecheck && (cd server && npm run typecheck)
npm test
```
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/scripts/serverPush.test.mjs b/scripts/serverPush.test.mjs
new file mode 100644
index 0000000..4130451
--- /dev/null
+++ b/scripts/serverPush.test.mjs
@@ -0,0 +1,192 @@
+// Background push on the server (6b): a phone's grant (write-only, per token, in the secrets file),
+// and the pusher: which attention it pushes, the phone's switches and pause, skipping a connected
+// token, coalescing, retries, and dropping a grant the relay refused.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createSecretFile } from '../server/src/secrets.ts'
+import { PushGrants, checkRelayUrl, checkSetGrant } from '../server/src/push/grants.ts'
+import { COALESCE_MS, Pusher, prPushKind } from '../server/src/push/pusher.ts'
+import { TopicHub } from '../server/src/topicHub.ts'
+import { dispatchV2 } from '../server/src/v2.ts'
+
+const SECRET = 'g'.repeat(43)
+const temp = (t) => {
+  const dir = mkdtempSync(join(tmpdir(), 'trek-push-test-'))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  return dir
+}
+
+function grantsIn(t, names = ['phone-a', 'phone-b']) {
+  const path = join(temp(t), 'secrets.json')
+  const tokens = { names }
+  return { grants: new PushGrants(createSecretFile(path), () => tokens.names), path, tokens }
+}
+
+const grant = (extra = {}) => ({ relayUrl: 'https://relay.example', grantSecret: SECRET, kinds: { decisions: true, sessions: true, prWatch: true }, paused: false, ...extra })
+
+function harness(t, { names = ['phone-a'], respond = () => 202 } = {}) {
+  const hub = new TopicHub()
+  hub.publish('attention', { entries: [] })
+  const { grants } = grantsIn(t, names)
+  const posts = []
+  const connected = new Set()
+  let now = 1_000_000
+  const fetch = async (url, init) => {
+    const status = typeof respond === 'function' ? respond(posts.length) : respond
+    posts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) })
+    if (status === 'throw') throw new Error('connection refused')
+    return new Response(null, { status })
+  }
+  const pusher = new Pusher({ hub, grants, isConnected: (n) => connected.has(n), serverId: () => 'srv-1', fetch, now: () => now, sleep: async () => {}, log: () => {} })
+  pusher.start()
+  t.after(() => pusher.stop())
+  return {
+    hub,
+    grants,
+    posts,
+    connected,
+    pusher,
+    advance: (ms) => (now += ms),
+    attention: (entries) => hub.publish('attention', { entries })
+  }
+}
+
+const decisionEntry = (at = 5) => ({ projectId: 'p1', worktreeId: 'w1', sessionId: 's1', title: 'Agent', status: 'working', since: at, projectName: 'trek-app', decision: { question: 'Merge it?', at } })
+const doneEntry = (since = 7) => ({ projectId: 'p1', worktreeId: 'w1', sessionId: 's2', title: 'Agent', status: 'done', since, projectName: 'trek-app' })
+const prEntry = { projectId: 'p1', worktreeId: 'w1', sessionId: '', title: 'PR #3', status: 'attention', since: 9, projectName: 'trek-app', pullRequest: { text: 'checks failed', url: 'https://x' } }
+
+test('relay URL: https, or http only on loopback; no credentials, query or fragment', () => {
+  assert.equal(checkRelayUrl('https://relay.example/'), 'https://relay.example')
+  assert.equal(checkRelayUrl('http://127.0.0.1:7346'), 'http://127.0.0.1:7346')
+  for (const bad of ['http://relay.example', 'ftp://x', 'https://u:p@relay.example', 'https://relay.example/?a=1', 'nope', 'x'.repeat(600)]) {
+    assert.throws(() => checkRelayUrl(bad), /relayUrl/, bad)
+  }
+  assert.deepEqual(checkSetGrant({ relayUrl: 'https://r.example', grantSecret: SECRET }).kinds, { decisions: true, sessions: true, prWatch: true })
+  assert.throws(() => checkSetGrant({ relayUrl: 'https://r.example', grantSecret: 'short' }), /grantSecret/)
+  assert.throws(() => checkSetGrant({ relayUrl: 'https://r.example', grantSecret: SECRET, kinds: { decisions: 'yes' } }), /kinds\.decisions/)
+})
+
+test('grants: per token in the secrets file (0600), status never shows the secret, a revoked token loses its grant', (t) => {
+  const { grants, path, tokens } = grantsIn(t)
+  grants.set('phone-a', grant({ paused: true }))
+  grants.set('phone-b', grant())
+  assert.equal(statSync(path).mode & 0o777, 0o600)
+  const status = grants.status('phone-a')
+  assert.deepEqual(status, { relayUrl: 'https://relay.example', kinds: { decisions: true, sessions: true, prWatch: true }, paused: true, active: true })
+  assert.ok(!JSON.stringify(status).includes(SECRET))
+  assert.equal(grants.status('phone-c'), null)
+  tokens.names = ['phone-b']
+  assert.equal(grants.retain(new Set(tokens.names)), 1)
+  assert.ok(!readFileSync(path, 'utf8').includes('push:phone-a'))
+  assert.equal(grants.status('phone-b').active, true)
+  grants.refused('phone-b', 'gone')
+  assert.deepEqual([grants.status('phone-b').active, grants.status('phone-b').lastError], [false, 'gone'])
+  assert.equal(grants.active().length, 0)
+})
+
+test('push.* over v2: write-only, per calling token, NOT_FOUND without push', (t) => {
+  const { grants } = grantsIn(t)
+  const ctx = { push: { grants }, tokenName: 'phone-a' }
+  assert.deepEqual(dispatchV2('push.setGrant', { relayUrl: 'https://relay.example', grantSecret: SECRET, kinds: { prWatch: false } }, ctx), { ok: true, result: null })
+  const status = dispatchV2('push.status', {}, ctx)
+  assert.equal(status.result.kinds.prWatch, false)
+  assert.ok(!JSON.stringify(status).includes(SECRET))
+  assert.equal(dispatchV2('push.status', {}, { ...ctx, tokenName: 'phone-b' }).result, null, "another token doesn't see it")
+  assert.equal(dispatchV2('push.setGrant', { relayUrl: 'http://relay.example', grantSecret: SECRET }, ctx).error.code, 'BAD_REQUEST')
+  dispatchV2('push.clearGrant', {}, ctx)
+  assert.equal(dispatchV2('push.status', {}, ctx).result, null)
+  assert.equal(dispatchV2('push.status', {}, { tokenName: 'phone-a' }).error.code, 'NOT_FOUND')
+})
+
+test('pusher: a new decision and a session waiting push once each, with only the kind, project and ids', async (t) => {
+  const h = harness(t)
+  h.grants.set('phone-a', grant())
+  h.attention([decisionEntry()])
+  h.attention([decisionEntry(), doneEntry()])
+  h.attention([decisionEntry(), doneEntry()])
+  await h.pusher.idle()
+  assert.deepEqual(h.posts.map((p) => p.body.kind), ['decision', 'session-finished'])
+  assert.equal(h.posts[0].url, 'https://relay.example/v1/push')
+  assert.equal(h.posts[0].auth, `Bearer ${SECRET}`)
+  assert.deepEqual(h.posts[0].body, { kind: 'decision', project: 'trek-app', data: { serverId: 'srv-1', projectId: 'p1', worktreeId: 'w1', sessionId: 's1' } })
+  assert.ok(!JSON.stringify(h.posts).includes('Merge it?'), "the decision's question never leaves the server")
+})
+
+test('pusher: what was already listed at start, and pull request entries, are not pushed from attention', async (t) => {
+  const hub = new TopicHub()
+  hub.publish('attention', { entries: [decisionEntry()] })
+  const { grants } = grantsIn(t, ['phone-a'])
+  grants.set('phone-a', grant())
+  const posts = []
+  const pusher = new Pusher({ hub, grants, isConnected: () => false, serverId: () => 's', fetch: async (u, i) => (posts.push(i), new Response(null, { status: 202 })), sleep: async () => {} })
+  pusher.start()
+  t.after(() => pusher.stop())
+  hub.publish('attention', { entries: [decisionEntry(), prEntry] })
+  await pusher.idle()
+  assert.equal(posts.length, 0)
+})
+
+test('pusher: the switches, pause and a connected token stop a push', async (t) => {
+  const h = harness(t, { names: ['phone-a', 'phone-b', 'phone-c'] })
+  h.grants.set('phone-a', grant({ kinds: { decisions: false, sessions: true, prWatch: true } }))
+  h.grants.set('phone-b', grant({ paused: true }))
+  h.grants.set('phone-c', grant())
+  h.connected.add('phone-c')
+  h.attention([decisionEntry()])
+  await h.pusher.idle()
+  assert.equal(h.posts.length, 0)
+  h.connected.delete('phone-c')
+  h.attention([decisionEntry(), doneEntry()])
+  await h.pusher.idle()
+  assert.deepEqual(h.posts.map((p) => p.body.kind).sort(), ['session-finished', 'session-finished'], 'phone-a (sessions on) and phone-c')
+})
+
+test('pusher: one push per token, project and kind in 30 seconds', async (t) => {
+  const h = harness(t)
+  h.grants.set('phone-a', grant())
+  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's1' })
+  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's2' })
+  h.pusher.notify({ kind: 'session-stopped', projectId: 'p2', projectName: 'b', sessionId: 's3' })
+  h.advance(COALESCE_MS)
+  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's4' })
+  await h.pusher.idle()
+  assert.deepEqual(h.posts.map((p) => p.body.data.sessionId), ['s1', 's3', 's4'])
+})
+
+test('pusher: retries a network error or 5xx, drops a grant the relay refuses, records a 429', async (t) => {
+  const flaky = harness(t, { respond: (n) => (n < 2 ? (n === 0 ? 'throw' : 503) : 202) })
+  flaky.grants.set('phone-a', grant())
+  flaky.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
+  await flaky.pusher.idle()
+  assert.equal(flaky.posts.length, 3)
+  assert.equal(flaky.grants.status('phone-a').lastError, undefined)
+
+  const gone = harness(t, { respond: 410 })
+  gone.grants.set('phone-a', grant())
+  gone.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
+  await gone.pusher.idle()
+  assert.equal(gone.grants.status('phone-a').active, false)
+  assert.match(gone.grants.status('phone-a').lastError, /grant again/)
+  gone.advance(COALESCE_MS)
+  gone.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
+  await gone.pusher.idle()
+  assert.equal(gone.posts.length, 1, 'a dropped grant pushes no more')
+
+  const limited = harness(t, { respond: 429 })
+  limited.grants.set('phone-a', grant())
+  limited.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
+  await limited.pusher.idle()
+  assert.equal(limited.posts.length, 1)
+  assert.match(limited.grants.status('phone-a').lastError, /429/)
+  assert.equal(limited.grants.status('phone-a').active, true)
+})
+
+test('pull request reports push their most pressing event', () => {
+  assert.equal(prPushKind([{ kind: 'checksPassed' }, { kind: 'comments', count: 2 }]), 'pr-review')
+  assert.equal(prPushKind([{ kind: 'checksFailed', names: [] }, { kind: 'conflict' }]), 'pr-conflict')
+  assert.equal(prPushKind([{ kind: 'merged' }]), 'pr-merged')
+  assert.equal(prPushKind([]), undefined)
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 318a091..e6c57bd 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -382,7 +382,7 @@ test('project.delete ends the project topic for its subscribers, before the serv
 })
 
 test('welcome capabilities: mcp while the listener is up, then what the server always has, pairing except on the local server, then local on the local server', () => {
-  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move', 'promote']
+  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move', 'promote', 'push']
   assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all, 'pairing'])
   assert.deepEqual(welcomeCapabilities(false), [...all, 'pairing'])
   assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all, 'pairing'])
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index b556d7b..8ff1379 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -9,7 +9,8 @@ import { CAPABILITY } from '../../src/shared/protocolV2.ts'
  * draft line comments. `move` (5d): `move.*`, a worktree's
  * move to or from another server. `promote` (5e): `worktree.promote`, `worktree.demote`,
  * `promote.listen`, `promote.claim` and `promote.answer`, and promote_to_primary's
- * `promote.request` / `promote.settled`.
+ * `promote.request` / `promote.settled`. `push` (6b): `push.setGrant`, `push.clearGrant` and
+ * `push.status`, a phone's relay grant for background push.
  */
 export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.topicEnd,
@@ -24,7 +25,8 @@ export const STATIC_CAPABILITIES: readonly string[] = [
   CAPABILITY.skills,
   CAPABILITY.review,
   CAPABILITY.move,
-  CAPABILITY.promote
+  CAPABILITY.promote,
+  CAPABILITY.push
 ]
 
 /**
diff --git a/server/src/index.ts b/server/src/index.ts
index 6e570cb..d8f4ec8 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -497,6 +497,8 @@ const server = startServer(
       pollMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS),
       recheckMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS)
     },
+    // Background push (6b): the phones' relay grants live in the same secrets file.
+    push: { secretsFile: secretsPathFor(resolve(args.configPath)) },
     web: webBundle ? { bundle: webBundle } : undefined
   }
 )
diff --git a/server/src/prWatch/watcher.ts b/server/src/prWatch/watcher.ts
index b5d19f3..24d249a 100644
--- a/server/src/prWatch/watcher.ts
+++ b/server/src/prWatch/watcher.ts
@@ -55,6 +55,8 @@ export interface PrWatcherDeps {
   gh: GhRunner
   /** gh's sign-in changed: the server tells every connection (`integrations.changed` `{prWatch}`) */
   onAvailability?: (available: boolean) => void
+  /** A round found something to report (its notice is set): the push (6b) */
+  onReport?: (p: { projectId: string; projectName: string; worktreeId: string; events: readonly PrEvent[] }) => void
   pollMs?: number
   recheckMs?: number
   now?: () => number
@@ -414,5 +416,11 @@ export class PrWatcher {
       }
     }
     this.setNotice(target, worktree.id, { title: `PR #${target.number}`, text: noticeText(events, outcome), url: target.url, at: this.now() })
+    try {
+      const projectName = [...this.deps.projects.all()].find((p) => p.id === target.projectId)?.name ?? ''
+      this.deps.onReport?.({ projectId: target.projectId, projectName, worktreeId: worktree.id, events })
+    } catch (err) {
+      console.warn('[prWatch] onReport failed', err)
+    }
   }
 }
diff --git a/server/src/push/grants.ts b/server/src/push/grants.ts
new file mode 100644
index 0000000..fab6db2
--- /dev/null
+++ b/server/src/push/grants.ts
@@ -0,0 +1,173 @@
+// The phones' push grants (6b), one per paired token, in the server's secrets file (0600) under
+// `push:<token name>`. A phone sets its grant with `push.setGrant`: the relay's URL, the grant's
+// secret, which kinds it wants and whether it is paused. The secret is write-only over the
+// protocol. A grant the relay refused (401/404/410) keeps its settings and why, without its secret,
+// so `push.status` can tell the phone to grant again.
+import { ALL_PUSH_KINDS_ON, type PushKinds } from '../../../src/shared/push.ts'
+import { codedError } from '../errors.ts'
+import type { SecretFile } from '../secrets.ts'
+
+export interface StoredGrant {
+  relayUrl: string
+  /** '' once the relay refused it */
+  grantSecret: string
+  kinds: PushKinds
+  paused: boolean
+  lastError?: string
+  lastPushAt?: number
+}
+
+export interface PushStatus {
+  relayUrl: string
+  kinds: PushKinds
+  paused: boolean
+  /** false once the relay refused the grant: the phone asks it for a new one */
+  active: boolean
+  lastError?: string
+  lastPushAt?: number
+}
+
+const PREFIX = 'push:'
+export const MAX_RELAY_URL = 512
+export const MAX_GRANT_SECRET = 128
+
+const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
+
+/** A relay is reached over https; http only to loopback (a relay on the same machine, or a test). */
+export function checkRelayUrl(value: unknown): string {
+  if (typeof value !== 'string' || !value || value.length > MAX_RELAY_URL) throw codedError('BAD_REQUEST', 'relayUrl must be a URL')
+  let url: URL
+  try {
+    url = new URL(value)
+  } catch {
+    throw codedError('BAD_REQUEST', 'relayUrl must be a URL')
+  }
+  if (url.username || url.password || url.search || url.hash) throw codedError('BAD_REQUEST', 'relayUrl must be a plain origin (and path)')
+  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
+    throw codedError('BAD_REQUEST', 'relayUrl must be https:// (http:// only on this machine)')
+  }
+  return url.href.replace(/\/+$/, '')
+}
+
+function checkKinds(value: unknown): PushKinds {
+  if (value === undefined) return { ...ALL_PUSH_KINDS_ON }
+  if (!value || typeof value !== 'object') throw codedError('BAD_REQUEST', 'kinds must be an object')
+  const k = value as Record<string, unknown>
+  const flag = (name: keyof PushKinds): boolean => {
+    if (k[name] === undefined) return true
+    if (typeof k[name] !== 'boolean') throw codedError('BAD_REQUEST', `kinds.${name} must be true or false`)
+    return k[name] as boolean
+  }
+  return { decisions: flag('decisions'), sessions: flag('sessions'), prWatch: flag('prWatch') }
+}
+
+/** `push.setGrant`'s params, checked */
+export function checkSetGrant(p: Record<string, unknown>): StoredGrant {
+  if (typeof p.grantSecret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(p.grantSecret)) throw codedError('BAD_REQUEST', 'grantSecret must be the relay grant secret')
+  if (p.paused !== undefined && typeof p.paused !== 'boolean') throw codedError('BAD_REQUEST', 'paused must be true or false')
+  return { relayUrl: checkRelayUrl(p.relayUrl), grantSecret: p.grantSecret, kinds: checkKinds(p.kinds), paused: p.paused === true }
+}
+
+export class PushGrants {
+  private readonly file: SecretFile
+  /** Names with a stored grant, kept so a push doesn't re-read the file per token */
+  private cache?: Map<string, StoredGrant>
+  private readonly names: () => Iterable<string>
+
+  /** `names` lists every token the config has (the only ones whose grants are looked at) */
+  constructor(file: SecretFile, names: () => Iterable<string>) {
+    this.file = file
+    this.names = names
+  }
+
+  private load(): Map<string, StoredGrant> {
+    if (this.cache) return this.cache
+    const all = new Map<string, StoredGrant>()
+    for (const name of this.names()) {
+      const raw = this.file.get(PREFIX + name)
+      if (!raw) continue
+      try {
+        all.set(name, JSON.parse(raw) as StoredGrant)
+      } catch {
+        // a hand-edited value: ignored
+      }
+    }
+    this.cache = all
+    return all
+  }
+
+  private write(name: string, grant: StoredGrant | null): void {
+    this.file.set(PREFIX + name, grant ? JSON.stringify(grant) : null)
+    const all = this.load()
+    if (grant) all.set(name, grant)
+    else all.delete(name)
+  }
+
+  set(name: string, grant: StoredGrant): void {
+    this.write(name, grant)
+  }
+
+  clear(name: string): void {
+    this.write(name, null)
+  }
+
+  get(name: string): StoredGrant | undefined {
+    return this.load().get(name)
+  }
+
+  status(name: string): PushStatus | null {
+    const g = this.get(name)
+    if (!g) return null
+    return {
+      relayUrl: g.relayUrl,
+      kinds: { ...g.kinds },
+      paused: g.paused,
+      active: g.grantSecret !== '',
+      ...(g.lastError ? { lastError: g.lastError } : {}),
+      ...(g.lastPushAt ? { lastPushAt: g.lastPushAt } : {})
+    }
+  }
+
+  /** The grants that can push: secret still good */
+  active(): [string, StoredGrant][] {
+    return [...this.load()].filter(([, g]) => g.grantSecret !== '')
+  }
+
+  /** The relay refused the grant: forget its secret, keep its settings and why */
+  refused(name: string, why: string): void {
+    const g = this.get(name)
+    if (g) this.write(name, { ...g, grantSecret: '', lastError: why })
+  }
+
+  pushed(name: string, at: number, error?: string): void {
+    const g = this.get(name)
+    if (!g) return
+    // Only `lastPushAt` changes on success; it is kept in memory, not rewritten to disk each push.
+    if (error === undefined) {
+      g.lastPushAt = at
+      if (g.lastError) {
+        delete g.lastError
+        this.write(name, g)
+      }
+    } else if (g.lastError !== error) this.write(name, { ...g, lastError: error })
+  }
+
+  /** A revoked token's grant goes with it. Returns how many were dropped. */
+  retain(active: Set<string>): number {
+    this.cache = undefined
+    const before = this.allStoredNames()
+    let dropped = 0
+    for (const name of before) {
+      if (active.has(name)) continue
+      this.file.set(PREFIX + name, null)
+      dropped += 1
+    }
+    this.cache = undefined
+    return dropped
+  }
+
+  /** Every name with a stored grant, the file's own (a revoked token's included) */
+  private allStoredNames(): string[] {
+    return this.file.keys().filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
+  }
+}
diff --git a/server/src/push/pusher.ts b/server/src/push/pusher.ts
new file mode 100644
index 0000000..c63ddf1
--- /dev/null
+++ b/server/src/push/pusher.ts
@@ -0,0 +1,192 @@
+// Background push (6b): what the server sends to a phone's relay, and when. It follows the
+// `attention` topic (a decision asked, a session waiting for the user) and hears session exits and
+// pull request reports directly. For each phone grant that wants that kind, isn't paused, and whose
+// token has no live connection (the app shows it already), it posts the kind, the project's name
+// and the ids to the relay. One push per (token, project, kind) in 30 seconds; network errors and
+// 5xx are retried (3 times, backing off); a 401/404/410 means the grant is gone, so it is dropped.
+import type { AttentionEntry } from '../../../src/shared/model/types.ts'
+import type { AttentionTopic } from '../../../src/shared/model/topics.ts'
+import type { PrEvent } from '../../../src/shared/prWatch.ts'
+import { pushGroupOf, type PushData, type PushKind, type RelayPushBody } from '../../../src/shared/push.ts'
+import { applyPatch, type PatchOp } from '../../../src/shared/sync/jsonPatch.ts'
+import type { Subscriber, TopicHub } from '../topicHub.ts'
+import type { PushGrants } from './grants.ts'
+
+export const COALESCE_MS = 30_000
+export const PUSH_RETRIES = 3
+const BACKOFF_MS = [1_000, 3_000, 10_000]
+const POST_TIMEOUT_MS = 10_000
+
+export interface PushEvent {
+  kind: PushKind
+  projectId: string
+  projectName: string
+  worktreeId?: string | null
+  sessionId?: string
+}
+
+export interface PusherDeps {
+  hub: TopicHub
+  grants: PushGrants
+  /** Whether any connection signed in with this token is open now */
+  isConnected(tokenName: string): boolean
+  serverId(): string
+  fetch?: typeof fetch
+  now?: () => number
+  sleep?: (ms: number) => Promise<void>
+  log?: (line: string) => void
+}
+
+/** The kind a pull request report pushes as: the most pressing of its events, or none */
+export function prPushKind(events: readonly PrEvent[]): PushKind | undefined {
+  const has = (k: PrEvent['kind']): boolean => events.some((e) => e.kind === k)
+  if (has('conflict')) return 'pr-conflict'
+  if (has('checksFailed')) return 'pr-checks-failed'
+  if (has('comments')) return 'pr-review'
+  if (has('merged')) return 'pr-merged'
+  if (has('closed')) return 'pr-closed'
+  if (has('checksPassed')) return 'pr-checks-passed'
+  return undefined
+}
+
+/** A session entry's identity for "is this new": a decision by when it was asked, a waiting session by since */
+function entryKey(e: AttentionEntry): { key: string; kind: PushKind } | undefined {
+  if (!e.sessionId) return undefined // a pull request notice: pushed from the watcher's report
+  if (e.decision) return { key: `${e.projectId}\0${e.sessionId}\0d\0${e.decision.at}`, kind: 'decision' }
+  if (e.status === 'attention' || e.status === 'done') return { key: `${e.projectId}\0${e.sessionId}\0f\0${e.since}`, kind: 'session-finished' }
+  return undefined
+}
+
+export class Pusher {
+  private readonly deps: PusherDeps
+  private attention?: AttentionTopic
+  private seen = new Set<string>()
+  private readonly lastSent = new Map<string, number>()
+  private unsubscribe?: () => void
+  private stopped = false
+  private readonly inFlight = new Set<Promise<void>>()
+
+  constructor(deps: PusherDeps) {
+    this.deps = deps
+  }
+
+  private now(): number {
+    return (this.deps.now ?? Date.now)()
+  }
+
+  /** Follows `attention` from its current state: what is already listed is never pushed. */
+  start(): void {
+    const subscriber: Subscriber = {
+      send: (_topic, _rev, ops: PatchOp[]) => {
+        if (!this.attention) return
+        this.attention = applyPatch(this.attention, ops)
+        this.onAttention()
+      },
+      ended: () => {
+        this.attention = undefined
+      }
+    }
+    const start = this.deps.hub.subscribe('attention', subscriber)
+    if (start) {
+      this.attention = start.snapshot as AttentionTopic
+      this.seen = new Set(this.attention.entries.map((e) => entryKey(e)?.key).filter((k): k is string => k !== undefined))
+    }
+    this.unsubscribe = () => this.deps.hub.unsubscribe('attention', subscriber)
+  }
+
+  private onAttention(): void {
+    const keys = new Set<string>()
+    for (const e of this.attention?.entries ?? []) {
+      const k = entryKey(e)
+      if (!k) continue
+      keys.add(k.key)
+      if (this.seen.has(k.key)) continue
+      this.notify({ kind: k.kind, projectId: e.projectId, projectName: e.projectName, worktreeId: e.worktreeId, sessionId: e.sessionId })
+    }
+    // Forget what left the list: the same decision asked again later is new.
+    this.seen = keys
+  }
+
+  /** A pull request report (the watcher's): one push of its most pressing event */
+  prReport(p: { projectId: string; projectName: string; worktreeId: string; events: readonly PrEvent[] }): void {
+    const kind = prPushKind(p.events)
+    if (kind) this.notify({ kind, projectId: p.projectId, projectName: p.projectName, worktreeId: p.worktreeId })
+  }
+
+  /** Sends `event` to every grant that wants it now. */
+  notify(event: PushEvent): void {
+    if (this.stopped) return
+    const group = pushGroupOf(event.kind)
+    const now = this.now()
+    for (const [name, grant] of this.deps.grants.active()) {
+      if (grant.paused || !grant.kinds[group]) continue
+      if (this.deps.isConnected(name)) continue
+      const coalesce = `${name}\0${event.projectId}\0${event.kind}`
+      const last = this.lastSent.get(coalesce)
+      if (last !== undefined && now - last < COALESCE_MS) continue
+      this.lastSent.set(coalesce, now)
+      const data: PushData = { serverId: this.deps.serverId(), projectId: event.projectId }
+      if (event.worktreeId) data.worktreeId = event.worktreeId
+      if (event.sessionId) data.sessionId = event.sessionId
+      const body: RelayPushBody = { kind: event.kind, project: event.projectName, data }
+      const job = this.post(name, grant.relayUrl, grant.grantSecret, body).finally(() => this.inFlight.delete(job))
+      this.inFlight.add(job)
+    }
+    if (this.lastSent.size > 5_000) {
+      for (const [k, t] of this.lastSent) if (now - t >= COALESCE_MS) this.lastSent.delete(k)
+    }
+  }
+
+  private async post(name: string, relayUrl: string, secret: string, body: RelayPushBody): Promise<void> {
+    const doFetch = this.deps.fetch ?? fetch
+    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()))
+    const log = this.deps.log ?? ((line: string) => console.warn(line))
+    let lastError = ''
+    for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
+      if (this.stopped) return
+      if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)])
+      let status = 0
+      try {
+        const res = await doFetch(`${relayUrl}/v1/push`, {
+          method: 'POST',
+          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
+          body: JSON.stringify(body),
+          signal: AbortSignal.timeout(POST_TIMEOUT_MS)
+        })
+        status = res.status
+        await res.body?.cancel().catch(() => {})
+      } catch (err) {
+        lastError = `the relay could not be reached: ${(err as Error).message}`
+        continue
+      }
+      if (status >= 200 && status < 300) {
+        this.deps.grants.pushed(name, this.now())
+        return
+      }
+      if (status === 401 || status === 404 || status === 410) {
+        const why = status === 410 ? 'the relay says this phone is gone (grant again)' : 'the relay no longer knows this grant (grant again)'
+        log(`[push] dropping token "${name}"'s grant: the relay answered ${status}`)
+        this.deps.grants.refused(name, why)
+        return
+      }
+      if (status === 429) {
+        this.deps.grants.pushed(name, this.now(), 'the relay is limiting pushes (429)')
+        return
+      }
+      lastError = `the relay answered ${status}`
+      if (status < 500) break
+    }
+    log(`[push] a ${body.kind} push for token "${name}" failed: ${lastError}`)
+    this.deps.grants.pushed(name, this.now(), lastError)
+  }
+
+  /** Waits for the pushes on their way (tests and shutdown) */
+  async idle(): Promise<void> {
+    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
+  }
+
+  stop(): void {
+    this.stopped = true
+    this.unsubscribe?.()
+  }
+}
diff --git a/server/src/secrets.ts b/server/src/secrets.ts
index 6e6603e..746d6ac 100644
--- a/server/src/secrets.ts
+++ b/server/src/secrets.ts
@@ -18,6 +18,8 @@ export interface SecretFile {
   set(name: string, value: string | null): void
   /** Stores `value` only while nothing is stored under `name`; true when it stored it. */
   setIfAbsent(name: string, value: string): boolean
+  /** Every stored key's name */
+  keys(): string[]
 }
 
 /**
@@ -58,6 +60,9 @@ export function createSecretFile(path: string): SecretFile {
       } else all[name] = value
       write(all)
     },
+    keys() {
+      return Object.keys(readAll())
+    },
     setIfAbsent(name, value) {
       const all = readAll()
       if (Object.hasOwn(all, name)) return false
diff --git a/server/src/server.ts b/server/src/server.ts
index 60aead0..6ae7d70 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -40,6 +40,9 @@ import { createWebHandler } from './web/http'
 import { sweepEvery, WebSocketSignIns } from './web/sockets'
 import type { WebBundle } from './web/bundle'
 import { moveTransfers, sweepStaleMoveDirs } from './move/transfers'
+import { createSecretFile } from './secrets'
+import { PushGrants } from './push/grants'
+import { Pusher } from './push/pusher'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -85,6 +88,11 @@ export interface ServerOptions {
   web?: {
     bundle: WebBundle
   }
+  /**
+   * Background push (6b): the phones' relay grants, in the server's secrets file. Without it the
+   * server answers `push.*` with NOT_FOUND and pushes nothing. `fetch` is for tests.
+   */
+  push?: { secretsFile: string; fetch?: typeof fetch }
 }
 
 export interface ProjectsSetup {
@@ -128,7 +136,8 @@ export function startServer(
     store,
     hub,
     mcpAccess: access ? (projectId) => access.accessFor(projectId) : undefined,
-    voicePrompt: () => (options.integrations?.voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined)
+    voicePrompt: () => (options.integrations?.voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined),
+    onSessionExit: (p) => pusher?.notify({ kind: 'session-stopped', ...p })
   })
 
   // Set once the connections exist (below): gh's first answer comes after this function returns.
@@ -140,13 +149,28 @@ export function startServer(
         gh: options.prWatch.gh,
         pollMs: options.prWatch.pollMs,
         recheckMs: options.prWatch.recheckMs,
-        onAvailability: (available) => prWatchChanged(available)
+        onAvailability: (available) => prWatchChanged(available),
+        onReport: (p) => pusher?.prReport(p)
       })
     : undefined
   prWatch?.start()
   // promote_to_primary's confirmations (5e): asked of the project's windows.
   const promoteRequests = new PromoteRequests(hub)
 
+  // Background push (6b). A token counts as connected while any of its sockets is open: its
+  // phone (or its window) already shows what would be pushed.
+  const connectedTokens = new Map<WebSocket, string>()
+  const pushGrants = options.push ? new PushGrants(createSecretFile(options.push.secretsFile), () => listTokens(store.config).map((t) => t.name)) : undefined
+  const pusher: Pusher | undefined = pushGrants
+    ? new Pusher({
+        hub,
+        grants: pushGrants,
+        isConnected: (name) => [...connectedTokens.values()].includes(name),
+        serverId: () => store.config.serverId ?? '',
+        fetch: options.push?.fetch
+      })
+    : undefined
+
   /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
   const authed = new Map<WebSocket, string>()
   /** Revoked sockets that have not finished closing yet; terminated if the close handshake stalls. */
@@ -186,6 +210,11 @@ export function startServer(
     const active = activeTokenHashes(store.config)
     // A revoked token's browser sessions end with it (their sockets close in the loop below).
     for (const key of web?.sessions.prune(active) ?? []) signedOut(key)
+    // A revoked token's push grant goes with it.
+    if (pushGrants) {
+      const droppedGrants = pushGrants.retain(new Set(listTokens(store.config).map((t) => t.name)))
+      if (droppedGrants) console.warn(`[push] dropped ${droppedGrants} push grant(s) of a revoked token`)
+    }
     // A revoked token's waiting pairing codes go with it: a code it asked for no longer pairs.
     if (pairing) {
       const dropped = pairing.retainIssuedBy(new Set(listTokens(store.config).map((t) => t.name)), Date.now())
@@ -213,6 +242,7 @@ export function startServer(
   refreshServerTopic = serverState.refresh
   projectsSetup.store.on('health', serverState.refresh)
   poller.start()
+  pusher?.start()
 
   const httpServer = createServer(
     web
@@ -402,6 +432,7 @@ export function startServer(
         }
         protocolVersion = frame.protocolVersion
         authed.set(ws, entry.hash)
+        connectedTokens.set(ws, entry.name)
         callerTokenName = entry.name
         const viaWeb = !token && webSession !== undefined
         if (viaWeb) webSignIns?.add(ws, webSession.key, Date.now())
@@ -446,6 +477,7 @@ export function startServer(
         promoteRecoveryDir: options.promoteRecoveryDir,
         pairing,
         tokenName: callerTokenName,
+        push: pushGrants ? { grants: pushGrants } : undefined,
         mcpAccess: access
           ? {
               revoke: (id) => {
@@ -480,6 +512,7 @@ export function startServer(
       revokeTimers.delete(ws)
       clearInterval(heartbeat)
       authed.delete(ws)
+      connectedTokens.delete(ws)
       webSignIns?.delete(ws)
       hub.unsubscribeAll(subscriber)
       // A promote_to_primary request this window claimed but had not started fails.
@@ -535,6 +568,7 @@ export function startServer(
     poller.stop()
     prWatch?.stop()
     promoteRequests.stop()
+    pusher?.stop()
     sessions.stopAll()
     // A move's staged histories (5d) are only of use to the connection that was sending them.
     const cleared = moveTransfers.clear().catch(() => {})
diff --git a/server/src/sessions/manager.ts b/server/src/sessions/manager.ts
index 4591b98..ac3426d 100644
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -65,6 +65,8 @@ export interface SessionManagerDeps {
   voicePrompt?: () => string | undefined
   /** Whether a program resolves in the login shell (server.agents); default agentService.commandExists */
   commandExists?: (binary: string) => Promise<boolean>
+  /** A session's process ended by itself (not closed, restarted or unloaded): the push (6b) */
+  onSessionExit?: (p: { projectId: string; projectName: string; worktreeId: string | null; sessionId: string }) => void
 }
 
 function requireSize(p: any): { cols: number; rows: number } {
@@ -733,15 +735,18 @@ export class SessionManager {
     this.dropActivity(owner.sessionId)
     // A Codex session that exited before its id was found is never bound (pickClaimant's rule).
     this.stopDiscovery(owner.sessionId)
+    let exited: { projectName: string; worktreeId: string | null } | undefined
     try {
       this.deps.projects.apply(
         owner.projectId,
         (d) => {
-          const s = findSession(d, owner.sessionId).session
+          const found = findSession(d, owner.sessionId)
+          const s = found.session
           if (s.ptyId !== ptyId) return
           delete s.ptyId
           s.status = 'exited'
           s.exitCode = exitCode
+          exited = { projectName: d.name, worktreeId: found.worktree?.id ?? null }
         },
         { persist: false }
       )
@@ -749,6 +754,13 @@ export class SessionManager {
       // the project or session is gone
     }
     this.publishAttention()
+    if (exited) {
+      try {
+        this.deps.onSessionExit?.({ projectId: owner.projectId, sessionId: owner.sessionId, ...exited })
+      } catch (err) {
+        console.warn('onSessionExit failed', err)
+      }
+    }
   }
 
   // ---- live status ----
diff --git a/server/src/v2.ts b/server/src/v2.ts
index 3d7d974..96e3cf7 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -31,6 +31,7 @@ import type { ProjectState } from './projects/state.ts'
 import type { SessionManager } from './sessions/manager.ts'
 import { applySettingsPatch, isSettingsKey, pruneDeletedTags } from './projects/settings.ts'
 import { realOrResolved } from './repos.ts'
+import { checkSetGrant, type PushGrants } from './push/grants.ts'
 import {
   assertNoProtoKeys,
   checkExpected,
@@ -76,10 +77,18 @@ export interface V2Context {
   pairing?: PairingCodes
   /** The name of the token this connection signed in with (a web session's token, for a browser) */
   tokenName?: string
+  /** Background push (6b): each token's relay grant */
+  push?: { grants: PushGrants }
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
 
+function pushGrantsOf(ctx: V2Context): PushGrants {
+  if (!ctx.push) throw codedError('NOT_FOUND', 'This server does not push')
+  if (!ctx.tokenName) throw codedError('BAD_REQUEST', 'push grants belong to a token')
+  return ctx.push.grants
+}
+
 /** A clearable string field: null or "" clears it; anything else must be a string. */
 function clearableString(value: unknown, field: string): string | null {
   if (value === null || value === '') return null
@@ -340,6 +349,18 @@ const handlers: Record<string, Handler> = {
 
   // Drops a waiting code. Any signed-in connection that knows the code may: whoever holds it
   // could redeem it, which is more.
+  // Background push (6b): the calling token's relay grant. Write-only: status never returns the secret.
+  'push.setGrant': (p, ctx) => {
+    const grants = pushGrantsOf(ctx)
+    grants.set(ctx.tokenName!, checkSetGrant(p))
+    return null
+  },
+  'push.clearGrant': (_p, ctx) => {
+    pushGrantsOf(ctx).clear(ctx.tokenName!)
+    return null
+  },
+  'push.status': (_p, ctx) => pushGrantsOf(ctx).status(ctx.tokenName!),
+
   'pairing.cancel': (p, ctx) => {
     if (!ctx.pairing) throw codedError('NOT_FOUND', 'This server does not pair phones (the local server is not reachable from one)')
     if (typeof p.code !== 'string' || p.code.length > 64) throw codedError('BAD_REQUEST', 'code must be a string')
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 80b3248..b19c2bf 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -14,6 +14,7 @@ import type {
 import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
 import type { LlmProviderId, LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
+import type { PushKinds } from './push.ts'
 import type { PromoteClaimResult, PromotePlan, PromoteRequestEvent, PromoteResult, PromoteSettledEvent } from './promote.ts'
 import type {
   ComposeAction,
@@ -239,7 +240,12 @@ export const CAPABILITY = {
    * Phone pairing (6a): `pairing.create` gives a signed-in client a one-time code (5 minutes) that
    * a phone redeems once at hello (`pairingCode`) for its own named token (`welcome.pairedToken`)
    */
-  pairing: 'pairing'
+  pairing: 'pairing',
+  /**
+   * Background push (6b): a phone hands the server its relay grant (`push.setGrant`, write-only),
+   * and the server posts the kinds it switched on to the relay while the phone isn't connected
+   */
+  push: 'push'
 } as const
 
 /** Close reasons for a refused pairing hello (sent with CLOSE_UNAUTHORIZED, 4003). */
@@ -388,6 +394,12 @@ export interface MethodParamsV2 {
   'pairing.create': { name?: string }
   /** 6a: drops a waiting code (the desktop's New code, or its panel closing); it is then refused as expired */
   'pairing.cancel': { code: string }
+  /** 6b: this token's relay grant (replaces the one before); `kinds` defaults to all on, `paused` to false */
+  'push.setGrant': { relayUrl: string; grantSecret: string; kinds?: Partial<PushKinds>; paused?: boolean }
+  /** 6b: forget this token's relay grant */
+  'push.clearGrant': Record<string, never>
+  /** 6b: this token's grant, without its secret */
+  'push.status': Record<string, never>
   /**
    * 5e: the user confirmed a `promote.request`: the first claim wins; send it before any teardown.
    * Repeated by the claimant (or with its `claimToken` from a new connection) it refreshes the claim.
@@ -615,6 +627,10 @@ export interface MethodResultsV2 {
   'pairing.create': { code: string; expiresAt: number; expiresInMs: number }
   /** Whether a waiting code was dropped (false: unknown, spent or expired already) */
   'pairing.cancel': { cancelled: boolean }
+  'push.setGrant': null
+  'push.clearGrant': null
+  /** null: no grant. `active` false: the relay refused it (`lastError` says why): grant again */
+  'push.status': PushStatusResult | null
   'promote.claim': PromoteClaimResult
   'worktree.commits': CommitInfo[]
   'branch.setTag': null
@@ -769,3 +785,13 @@ export interface VoiceSummaryEvent {
   /** The mp3, base64 */
   audio: string
 }
+
+/** `push.status`'s answer (6b) */
+export interface PushStatusResult {
+  relayUrl: string
+  kinds: PushKinds
+  paused: boolean
+  active: boolean
+  lastError?: string
+  lastPushAt?: number
+}
````

</details>

### Task 4: smoke:push

A relay with a local APNs stub, a trek-server and SDK clients for the desktop and the phone.

**Prototype commit:** `bf6b4ea` on `central-server-phase6b-proto`.

**Files:**
- `package.json`
- `scripts/push-smoke.mjs`

- [ ] **Step 1: Tests first.** Expected: `PUSH SMOKE PASS (21 checks)`, and no trek-server, trek-relay or fake-agent process left (`pgrep -fl "trek-relay.cjs|trek-server.cjs|fake-agent"` prints nothing).
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 3: Verify:**

```bash
npm run smoke:push
```
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/package.json b/package.json
index 3438640..0b7ea1f 100644
--- a/package.json
+++ b/package.json
@@ -33,6 +33,7 @@
     "smoke:server-move": "npm run build && node scripts/server-move-smoke.mjs",
     "smoke:server-promote": "npm run build && node scripts/server-promote-smoke.mjs",
     "smoke:server-web": "npm run build && node scripts/server-web-smoke.mjs",
+    "smoke:push": "npm --prefix server run build && npm --prefix relay run build && node scripts/push-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/push-smoke.mjs b/scripts/push-smoke.mjs
new file mode 100644
index 0000000..c72bb86
--- /dev/null
+++ b/scripts/push-smoke.mjs
@@ -0,0 +1,290 @@
+// scripts/push-smoke.mjs — background push (6b): a trek-server posts a phone's attention to a
+// trek-relay, which sends it to (a stub of) APNs. No Electron; no Apple, Google or Expo host is
+// ever reached: the relay's APNs origin is a local cleartext HTTP/2 stub (its test-only apnsHost).
+//
+// Run: npm run smoke:push   (builds the server and the relay, then runs this script)
+//
+// The relay and the server each run with their own temp HOME; the server with the not-signed-in
+// stub gh every smoke gets (smokeGh.mjs), docker and colima stubs first on its PATH, and a fake
+// agent that waits until told to exit. A Node SDK client plays the desktop, and another (with its
+// own named token) the phone. It checks:
+//   - the welcome lists push; the phone registers with the relay, takes a grant and hands it to
+//     the server (push.setGrant), and push.status shows it without the secret;
+//   - with the phone away, a decision reaches the APNs stub once, as an alert to the phone's
+//     token: "Trek · <project>" / "A decision is waiting" and the ids — never the question;
+//   - with Decisions switched off, a new decision sends nothing;
+//   - with the phone connected, nothing is sent;
+//   - a session that exits by itself pushes "A session stopped";
+//   - a grant revoked at the relay is dropped by the server on its next push (push.status: not
+//     active, with why);
+//   - nothing was left running.
+import './smokeGh.mjs'
+import { execFileSync, spawn } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
+import { startApnsStub, testApnsKey } from './relayStubs.mjs'
+
+const WATCHDOG_MS = 180_000
+const READY_MS = 15_000
+
+const checks = []
+const failedChecks = []
+const check = (name, actual, expected) => {
+  const ok = JSON.stringify(actual) === JSON.stringify(expected)
+  checks.push(ok)
+  if (!ok) failedChecks.push(name)
+  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
+}
+const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
+const until = async (fn, expected, ms = 15_000) => {
+  const deadline = Date.now() + ms
+  let value = await fn()
+  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
+    await sleep(200)
+    value = await fn()
+  }
+  return value
+}
+
+const root = new URL('..', import.meta.url).pathname
+const hashOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
+const desktopToken = randomBytes(16).toString('base64url')
+const phoneToken = randomBytes(16).toString('base64url')
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-push-smoke-')))
+const serverHome = join(work, 'server-home')
+const relayHome = join(work, 'relay-home')
+const data = join(work, 'data')
+const serverTmp = join(work, 'tmp')
+const repo = join(work, 'repo')
+const repo2 = join(work, 'repo2')
+for (const dir of [serverHome, relayHome, data, serverTmp, repo, repo2]) mkdirSync(dir, { recursive: true })
+
+const noGitConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
+const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8', env: { ...process.env, ...noGitConfig } })
+for (const r of [repo, repo2]) {
+  git('init', '-q', '-b', 'main', r)
+  writeFileSync(join(r, 'a.txt'), 'a\n')
+  git('-C', r, 'add', '.')
+  git('-C', r, 'commit', '-q', '-m', 'init')
+}
+
+// docker and colima stubs: the server's environment poll never runs the real ones.
+const stubs = join(work, 'stubs')
+mkdirSync(stubs)
+for (const tool of ['docker', 'colima']) writeFileSync(join(stubs, tool), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${tool} 0.0.0-stub"; fi\nexit 0\n`, { mode: 0o755 })
+// The fake agent: prints once, then waits until its stop file exists and exits 3 (by itself).
+const fakeAgent = join(work, 'fake-agent.sh')
+writeFileSync(fakeAgent, `#!/bin/sh\necho "FAKE_AGENT"\nwhile [ ! -e "$PWD/.stop-agent" ]; do sleep 0.2; done\nexit 3\n`, { mode: 0o755 })
+
+const configPath = join(work, 'config.json')
+writeFileSync(
+  configPath,
+  JSON.stringify({
+    tokenHash: hashOf(desktopToken),
+    tokens: [{ name: 'phone-smoke', hash: hashOf(phoneToken), createdAt: '2026-11-11T00:00:00.000Z' }],
+    repos: [
+      { id: 'app', name: 'app', path: repo },
+      { id: 'app2', name: 'app2', path: repo2 }
+    ],
+    llm: { providers: { claude: { command: fakeAgent } } }
+  })
+)
+
+const freePort = () =>
+  new Promise((resolve, reject) => {
+    const s = createServer()
+    s.once('error', reject)
+    s.listen(0, '127.0.0.1', () => {
+      const { port } = s.address()
+      s.close(() => resolve(port))
+    })
+  })
+
+const startProcess = (name, args, cwd, env, ready) =>
+  new Promise((resolve, reject) => {
+    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
+    let output = ''
+    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${output}`)), READY_MS)
+    const onData = (b) => {
+      output += b
+      if (ready.test(output)) {
+        clearTimeout(timer)
+        resolve(p)
+      }
+    }
+    p.stdout.on('data', onData)
+    p.stderr.on('data', (b) => {
+      onData(b)
+      if (process.env.SMOKE_VERBOSE) process.stderr.write(b)
+    })
+    p.once('exit', (code) => reject(new Error(`${name} exited (${code}):\n${output}`)))
+  })
+
+let relayProc = null
+let daemon = null
+let apns = null
+let desktop = null
+let phone = null
+let exitCode = 1
+let finished = false
+const stop = async (p) => {
+  if (!p || p.exitCode !== null || p.signalCode !== null) return
+  p.kill()
+  await Promise.race([new Promise((r) => p.once('exit', r)), sleep(5000).then(() => p.kill('SIGKILL'))])
+}
+const finish = async (reason) => {
+  if (finished) return
+  finished = true
+  if (reason) console.error(reason)
+  desktop?.close()
+  phone?.close()
+  await stop(daemon)
+  await stop(relayProc)
+  await apns?.close()
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  if (exitCode !== 0 && !failedChecks.length && !reason) failedChecks.push('aborted by an error')
+  console.log(exitCode === 0 ? `PUSH SMOKE PASS (${checks.length} checks)` : `PUSH SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS).unref()
+
+try {
+  // ---- 1. The APNs stub and the relay ------------------------------------------------------------
+  apns = await startApnsStub()
+  const keyPath = join(relayHome, 'AuthKey_SMOKE.p8')
+  writeFileSync(keyPath, testApnsKey().pem, { mode: 0o600 })
+  const relayConfig = join(relayHome, 'relay.json')
+  const relayPort = await freePort()
+  writeFileSync(
+    relayConfig,
+    JSON.stringify({ dataDir: join(relayHome, 'data'), port: relayPort, apns: { keyId: 'SMOKEKEY', teamId: 'SMOKETEAM', bundleId: 'app.trek.smoke', keyPath }, apnsHost: apns.origin }),
+    { mode: 0o600 }
+  )
+  relayProc = await startProcess('trek-relay', ['dist/trek-relay.cjs', 'start', '--config', relayConfig], join(root, 'relay'), { ...process.env, HOME: relayHome }, /listening on http:\/\//)
+  const relayUrl = `http://127.0.0.1:${relayPort}`
+  const relay = async (method, path, body, secret) => {
+    const res = await fetch(relayUrl + path, { method, headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
+    return { status: res.status, body: await res.json().catch(() => null) }
+  }
+  check('the relay refuses a phone platform it has no credentials for', (await relay('POST', '/v1/devices', { platform: 'android', pushToken: 'x' })).status, 400)
+
+  // ---- 2. The server, a project with a running session (the desktop's SDK) ------------------------
+  const port = await freePort()
+  daemon = await startProcess(
+    'trek-server',
+    ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data],
+    join(root, 'server'),
+    { ...process.env, PATH: `${stubs}:${process.env.PATH}`, TMPDIR: serverTmp, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh', ...noGitConfig },
+    /listening on ws:\/\//
+  )
+  const url = `ws://127.0.0.1:${port}`
+  desktop = new ServerConnection({ url, token: desktopToken, createSocket: globalSocketFactory, client: 'push-smoke-desktop' })
+  desktop.connect()
+  await until(() => desktop.status, 'connected', 5000)
+  check('the welcome lists push', desktop.welcome?.capabilities.includes('push'), true)
+  const { projectId } = await desktop.request('project.create', { name: 'push-app', repositories: [{ path: repo }] })
+  const { projectId: projectId2 } = await desktop.request('project.create', { name: 'other-app', repositories: [{ path: repo2 }] })
+  const mainOf = async (pid) => {
+    const { snapshot } = await desktop.request('sub.subscribe', { topic: `project:${pid}` })
+    await desktop.request('sub.unsubscribe', { topic: `project:${pid}` })
+    return snapshot.repositories[0].worktrees.find((w) => w.isMain)
+  }
+  const mainWt = await mainOf(projectId)
+  const { sessionId } = await desktop.request('session.start', { projectId, worktreeId: mainWt.id, title: 'Agent', cols: 100, rows: 30 })
+  const mainWt2 = await mainOf(projectId2)
+  const { sessionId: sessionId2 } = await desktop.request('session.start', { projectId: projectId2, worktreeId: mainWt2.id, title: 'Agent 2', cols: 100, rows: 30 })
+
+  const mcp = JSON.parse(readFileSync(join(data, 'mcp', `${projectId}.json`), 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const mcpRpc = async (method, params) =>
+    (await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })).json()
+  await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'push-smoke', version: '0' } })
+  const ask = async (question) => {
+    await desktop.request('session.dismissDecision', { projectId, sessionId }).catch(() => {})
+    return mcpRpc('tools/call', { name: 'request_decision', arguments: { terminalId: sessionId, question } })
+  }
+
+  // ---- 3. The phone: registers with the relay, takes a grant, hands it to the server --------------
+  const reg = await relay('POST', '/v1/devices', { platform: 'ios', pushToken: 'abcdef0123456789' })
+  check('the phone registers with the relay', reg.status, 201)
+  const grant = await relay('POST', '/v1/grants', { label: 'push smoke server' }, reg.body.deviceSecret)
+  check('and takes a grant for the server', grant.status, 201)
+  const phoneOnline = async () => {
+    phone = new ServerConnection({ url, token: phoneToken, createSocket: globalSocketFactory, client: 'push-smoke-phone' })
+    phone.connect()
+    await until(() => phone.status, 'connected', 5000)
+  }
+  const phoneAway = async () => {
+    phone.close()
+    phone = null
+    await sleep(300)
+  }
+  await phoneOnline()
+  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret, kinds: { decisions: true, sessions: true, prWatch: true } })
+  const status = await phone.request('push.status', {})
+  check('push.status shows the grant, never its secret', [status.active, status.paused, status.kinds, JSON.stringify(status).includes(grant.body.grantSecret)], [true, false, { decisions: true, sessions: true, prWatch: true }, false])
+  check("the desktop's token has no grant of its own", await desktop.request('push.status', {}), null)
+
+  const decisionPushes = () => apns.pushes.filter((p) => p.body?.trek?.kind === 'decision')
+  const kindsPushed = () => apns.pushes.map((p) => p.body?.trek?.kind)
+
+  // ---- 4. Away: a decision is pushed once, with only the kind and the project --------------------
+  await phoneAway()
+  check('the session asks a decision through its MCP tools', (await ask('Ship it to production?')).result?.isError, false)
+  check('a decision reaches APNs once', await until(() => decisionPushes().length, 1), 1)
+  const p = decisionPushes()[0]
+  check("as an alert to the phone's token, for the app's bundle", [p?.path, p?.headers['apns-topic'], p?.headers['apns-push-type']], ['/3/device/abcdef0123456789', 'app.trek.smoke', 'alert'])
+  check('saying only the project and the kind', p?.body?.aps?.alert, { title: 'Trek · push-app', body: 'A decision is waiting' })
+  check('with the ids to open it', [p?.body?.trek?.projectId, p?.body?.trek?.sessionId, p?.body?.trek?.serverId?.length > 0], [projectId, sessionId, true])
+  check("the question never left the server", JSON.stringify(apns.pushes).includes('production'), false)
+
+  // ---- 5. Decisions off: nothing --------------------------------------------------------------------
+  await phoneOnline()
+  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret, kinds: { decisions: false, sessions: true, prWatch: true } })
+  await phoneAway()
+  await ask('And now?')
+  await sleep(2000)
+  check('with Decisions switched off, a new decision sends nothing', decisionPushes().length, 1)
+
+  // ---- 6. Connected: nothing ------------------------------------------------------------------------
+  await phoneOnline()
+  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret })
+  const before = apns.pushes.length
+  await ask('While you look?')
+  await sleep(2000)
+  check('with the phone connected, nothing is sent', apns.pushes.length, before)
+  await phoneAway()
+
+  // ---- 7. A session that exits by itself --------------------------------------------------------------
+  writeFileSync(join(repo, '.stop-agent'), '')
+  check('a session that exits by itself pushes "A session stopped"', await until(() => kindsPushed().includes('session-stopped'), true), true)
+  const stopped = apns.pushes.find((x) => x.body?.trek?.kind === 'session-stopped')
+  check('for its project and session', [stopped?.body?.aps?.alert?.body, stopped?.body?.trek?.sessionId], ['A session stopped', sessionId])
+
+  // ---- 8. A grant revoked at the relay is dropped by the server --------------------------------------
+  check('the phone revokes its grant at the relay', (await relay('DELETE', `/v1/grants/${grant.body.grantId}`, undefined, reg.body.deviceSecret)).status, 200)
+  const pushesBefore = apns.pushes.length
+  writeFileSync(join(repo2, '.stop-agent'), '')
+  // The phone stays away until the session has exited and the server has tried to push it.
+  const status2 = async () => (await mainOf(projectId2)).sessions.find((s) => s.id === sessionId2)?.status
+  check('the other project\'s session exits by itself', await until(status2, 'exited'), 'exited')
+  await sleep(1500)
+  await phoneOnline()
+  const dropped = await until(async () => (await phone.request('push.status', {})).active, false)
+  check('the next push finds it gone, and the server drops it', dropped, false)
+  check('saying why', /grant again/.test((await phone.request('push.status', {})).lastError ?? ''), true)
+  check('nothing reached APNs for it', apns.pushes.length, pushesBefore)
+  await phoneAway()
+
+  exitCode = failedChecks.length ? 1 : 0
+} catch (err) {
+  console.error(err)
+  exitCode = 1
+}
+await finish()
````

</details>

### Task 5: the phone

Registration with the build relay, a grant per push-capable server, push.setGrant, the switches and Pause all, removal, tapped pushes routed by the server id.

**Prototype commit:** `4c10f13` on `central-server-phase6b-proto`.

**Files:**
- `apps/mobile/app.json`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/app/push/[serverId].tsx`
- `apps/mobile/app/servers.tsx`
- `apps/mobile/src/logic/push.ts`
- `apps/mobile/src/shared.ts`
- `apps/mobile/src/state/PushProvider.tsx`
- `apps/mobile/src/state/pushStorage.ts`
- `scripts/mobileLogic.test.mjs`
- `scripts/sharedForMobile.test.mjs`

- [ ] **Step 1: Tests first.** Add the push cases to `scripts/mobileLogic.test.mjs` first (the diff below). Never run a simulator, emulator, Xcode or EAS; export to a scratch directory, not the repo.
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 3: Verify:**

```bash
node --test scripts/mobileLogic.test.mjs scripts/sharedForMobile.test.mjs
cd apps/mobile && npm ci && npm run typecheck
cd apps/mobile && npx expo export --platform ios --output-dir <scratch>/ios && npx expo export --platform android --output-dir <scratch>/android
```
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/apps/mobile/app.json b/apps/mobile/app.json
index 2764d48..30ae185 100644
--- a/apps/mobile/app.json
+++ b/apps/mobile/app.json
@@ -42,6 +42,9 @@
           }
         }
       ]
-    ]
+    ],
+    "extra": {
+      "relayUrl": ""
+    }
   }
 }
diff --git a/apps/mobile/app/_layout.tsx b/apps/mobile/app/_layout.tsx
index c3bbf6c..688cfe6 100644
--- a/apps/mobile/app/_layout.tsx
+++ b/apps/mobile/app/_layout.tsx
@@ -1,9 +1,10 @@
-import { useEffect } from 'react'
+import { useEffect, useRef } from 'react'
 import { router, Stack } from 'expo-router'
 import { StatusBar } from 'expo-status-bar'
 import * as Notifications from 'expo-notifications'
 import { notificationRoute } from '../src/logic/attention.ts'
 import { ServersProvider } from '../src/state/ServersProvider.tsx'
+import { PushProvider, usePush } from '../src/state/PushProvider.tsx'
 import { colors } from '../src/ui/theme.ts'
 
 // A notification that arrives while the app is open is shown as a banner, without sound.
@@ -17,6 +18,10 @@ export const unstable_settings = { initialRouteName: 'index' }
 
 /** Tapping a notification opens its session (or worktree): while running, and on a cold start. */
 function NotificationRouting(): null {
+  // A push (6b) names the server by its own id: mapped to the phone's entry for it.
+  const { routeData } = usePush()
+  const routeRef = useRef(routeData)
+  routeRef.current = routeData
   useEffect(() => {
     const handled = new Set<string>()
     const open = (response: Notifications.NotificationResponse | null): void => {
@@ -24,7 +29,7 @@ function NotificationRouting(): null {
       const id = response.notification.request.identifier
       if (handled.has(id)) return
       handled.add(id)
-      const route = notificationRoute(response.notification.request.content.data)
+      const route = notificationRoute(routeRef.current(response.notification.request.content.data))
       if (route) router.push(route)
     }
     // The tap that started the app, once navigation is up.
@@ -48,6 +53,7 @@ function NotificationRouting(): null {
 export default function RootLayout(): React.JSX.Element {
   return (
     <ServersProvider>
+      <PushProvider>
       <StatusBar style="light" />
       <NotificationRouting />
       <Stack
@@ -62,7 +68,9 @@ export default function RootLayout(): React.JSX.Element {
         <Stack.Screen name="add-server" options={{ title: 'Add server', presentation: 'modal' }} />
         <Stack.Screen name="pair" options={{ title: 'Add server' }} />
         <Stack.Screen name="projects" options={{ title: 'Projects' }} />
+        <Stack.Screen name="push/[serverId]" options={{ title: 'Push notifications' }} />
       </Stack>
+      </PushProvider>
     </ServersProvider>
   )
 }
diff --git a/apps/mobile/app/push/[serverId].tsx b/apps/mobile/app/push/[serverId].tsx
new file mode 100644
index 0000000..d43d4c0
--- /dev/null
+++ b/apps/mobile/app/push/[serverId].tsx
@@ -0,0 +1,50 @@
+// One paired server's push switches (6b): Decisions, Sessions, PR watch. Each change is saved to
+// the server at once (push.setGrant), so a kind switched off never leaves the server.
+import { Switch, Text, View } from 'react-native'
+import { useLocalSearchParams } from 'expo-router'
+import { PUSH_GROUPS, type PushGroup } from '../../src/shared.ts'
+import { usePush } from '../../src/state/PushProvider.tsx'
+import { useServers } from '../../src/state/ServersProvider.tsx'
+import { colors, ui } from '../../src/ui/theme.ts'
+
+const LABELS: Record<PushGroup, { title: string; detail: string }> = {
+  decisions: { title: 'Decisions', detail: 'A session asks you to decide something' },
+  sessions: { title: 'Sessions', detail: 'A session is waiting for you, or stopped' },
+  prWatch: { title: 'PR watch', detail: 'Checks, reviews, conflicts and merges on a watched pull request' }
+}
+
+export default function PushSettingsScreen(): React.JSX.Element {
+  const { serverId } = useLocalSearchParams<{ serverId: string }>()
+  const { servers } = useServers()
+  const push = usePush()
+  const server = servers.find((s) => s.id === serverId)
+  const kinds = push.kindsOf(serverId)
+  const problem = push.problemOf(serverId)
+  if (!server) return <View style={ui.screen}><Text style={[ui.muted, ui.pad]}>This server is no longer paired.</Text></View>
+  const canPush = server.capabilities.includes('push')
+  return (
+    <View style={[ui.screen, ui.pad]}>
+      <Text style={ui.title}>{server.name}</Text>
+      {!push.registered ? <Text style={ui.warn}>Allow notifications for Trek in Settings to get pushes.</Text> : null}
+      {server.status === 'connected' && !canPush ? <Text style={ui.warn}>This server doesn't push. Update trek-server to use push notifications.</Text> : null}
+      {push.paused ? <Text style={ui.warn}>All pushes are paused (Servers screen).</Text> : null}
+      {problem ? <Text style={ui.error}>{problem}</Text> : null}
+      {PUSH_GROUPS.map((group) => (
+        <View key={group} style={[ui.card, ui.row, { justifyContent: 'space-between' }]}>
+          <View style={{ flex: 1 }}>
+            <Text style={ui.text}>{LABELS[group].title}</Text>
+            <Text style={ui.muted}>{LABELS[group].detail}</Text>
+          </View>
+          <Switch
+            accessibilityLabel={`${LABELS[group].title} pushes`}
+            value={kinds[group]}
+            disabled={server.status !== 'connected' || !canPush || !push.registered}
+            trackColor={{ true: colors.accent }}
+            onValueChange={(on) => void push.setKinds(serverId, { ...kinds, [group]: on })}
+          />
+        </View>
+      ))}
+      <Text style={ui.muted}>A push says only the project and what happened. Changes are saved to the server while it is connected.</Text>
+    </View>
+  )
+}
diff --git a/apps/mobile/app/servers.tsx b/apps/mobile/app/servers.tsx
index c3520f2..c4a6280 100644
--- a/apps/mobile/app/servers.tsx
+++ b/apps/mobile/app/servers.tsx
@@ -1,22 +1,25 @@
 // The paired servers and their connection state (6a). Removing one forgets its token on this
 // phone only: it stays valid on the server until revoked there.
-import { Alert, FlatList, Text, View } from 'react-native'
+import { Alert, FlatList, Switch, Text, View } from 'react-native'
 import { Link } from 'expo-router'
 import { statusLabel, useServers, type ServerView } from '../src/state/ServersProvider.tsx'
 import { Button } from '../src/ui/Button.tsx'
+import { usePush } from '../src/state/PushProvider.tsx'
 import { colors, ui } from '../src/ui/theme.ts'
 
 const needsPairing = (status: ServerView['status']): boolean => status === 'needs-auth' || status === 'no-token'
 
 export default function ServersScreen(): React.JSX.Element {
   const { servers, remove } = useServers()
+  const push = usePush()
   const confirmRemove = (id: string, name: string): void => {
     Alert.alert(
       `Remove ${name}?`,
       'Its token is deleted from this phone. It stays valid on the server until you revoke it there (the desktop app, or trek-server token revoke).',
       [
         { text: 'Cancel', style: 'cancel' },
-        { text: 'Remove', style: 'destructive', onPress: () => void remove(id) }
+        // Its push grant goes first: cleared on the server and revoked at the relay (6b).
+        { text: 'Remove', style: 'destructive', onPress: () => void push.forget(id).finally(() => remove(id)) }
       ]
     )
   }
@@ -27,6 +30,17 @@ export default function ServersScreen(): React.JSX.Element {
         data={servers}
         keyExtractor={(s) => s.id}
         ListEmptyComponent={<Text style={ui.muted}>No servers yet.</Text>}
+        ListHeaderComponent={
+          push.enabled ? (
+            <View style={[ui.card, ui.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
+              <View style={{ flex: 1 }}>
+                <Text style={ui.text}>Pause all pushes</Text>
+                <Text style={ui.muted}>{push.registered ? 'No server pushes to this phone while paused' : 'Allow notifications to get pushes'}</Text>
+              </View>
+              <Switch accessibilityLabel="Pause all pushes" value={push.paused} disabled={!push.registered} trackColor={{ true: colors.accent }} onValueChange={(v) => void push.setPaused(v)} />
+            </View>
+          ) : undefined
+        }
         renderItem={({ item }) => (
           <View style={ui.card}>
             <Text style={ui.title}>{item.name}</Text>
@@ -42,6 +56,11 @@ export default function ServersScreen(): React.JSX.Element {
                   Pair again
                 </Link>
               ) : null}
+              {push.enabled && item.capabilities.includes('push') ? (
+                <Link href={{ pathname: '/push/[serverId]', params: { serverId: item.id } }} style={{ color: colors.accent }}>
+                  Push…
+                </Link>
+              ) : null}
               <Button ghost danger label="Remove" onPress={() => confirmRemove(item.id, item.name)} />
             </View>
           </View>
diff --git a/apps/mobile/src/logic/push.ts b/apps/mobile/src/logic/push.ts
new file mode 100644
index 0000000..ff5ca33
--- /dev/null
+++ b/apps/mobile/src/logic/push.ts
@@ -0,0 +1,120 @@
+// Background push on the phone (6b), the pure part: the build's relay address, the relay's calls
+// (register this device, take or revoke a grant, rotate the token) over an injected fetch, and what
+// a server needs from the phone (a grant, and push.setGrant again after a switch changes). No React
+// Native imports, so `node --test` covers it (scripts/mobileLogic.test.mjs).
+import { ALL_PUSH_KINDS_ON, type PushKinds } from '../../../../src/shared/push.ts'
+
+export type { PushKinds }
+export { ALL_PUSH_KINDS_ON }
+
+export type Platform = 'ios' | 'android'
+
+/** This phone at the relay: kept in secure storage */
+export interface RelayDevice {
+  relayUrl: string
+  deviceId: string
+  deviceSecret: string
+  platform: Platform
+  pushToken: string
+}
+
+/** One paired server's push: its grant at the relay and the phone's switches for it */
+export interface ServerPush {
+  grantId: string
+  grantSecret: string
+  kinds: PushKinds
+  /** The server's own id (its welcome's): a push names it, the phone's routes use the entry's */
+  serverId: string
+}
+
+/**
+ * A tapped notification's data, for the phone's routes. A local notification (6a) already names
+ * the entry; a push (6b) names the server's own id, under `trek` on iOS (the APNs payload's key)
+ * or at the top on Android (FCM data), and is mapped to the entry that holds that server.
+ */
+export function pushRouteData(data: unknown, entryFor: (serverId: string) => string | undefined): unknown {
+  if (!data || typeof data !== 'object') return data
+  const d = data as Record<string, unknown>
+  const inner = d.trek && typeof d.trek === 'object' ? (d.trek as Record<string, unknown>) : d
+  if (typeof inner.kind !== 'string') return data
+  const entry = typeof inner.serverId === 'string' ? entryFor(inner.serverId) : undefined
+  if (!entry) return null
+  return { ...inner, serverId: entry }
+}
+
+/**
+ * The relay named in the app's build config (`extra.relayUrl`): https, or http only to this
+ * device or a private address (a relay on the LAN during development). Empty or invalid: no push.
+ */
+export function relayUrlOf(value: unknown): string | null {
+  if (typeof value !== 'string' || !value.trim()) return null
+  let url: URL
+  try {
+    url = new URL(value.trim())
+  } catch {
+    return null
+  }
+  if (url.username || url.password || url.search || url.hash) return null
+  const host = url.hostname.replace(/^\[|\]$/g, '')
+  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
+  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
+  return url.href.replace(/\/+$/, '')
+}
+
+type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>
+
+export class RelayError extends Error {
+  readonly status: number
+  constructor(status: number, message: string) {
+    super(message)
+    this.status = status
+  }
+}
+
+async function call<T>(fetch: Fetch, relayUrl: string, method: string, path: string, body?: unknown, secret?: string): Promise<T> {
+  let res
+  try {
+    res = await fetch(relayUrl + path, {
+      method,
+      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
+      body: body === undefined ? undefined : JSON.stringify(body)
+    })
+  } catch (err) {
+    throw new RelayError(0, `The push relay could not be reached: ${(err as Error).message}`)
+  }
+  const data = (await res.json().catch(() => null)) as { error?: string } | null
+  if (res.status < 200 || res.status >= 300) throw new RelayError(res.status, data?.error ?? `The push relay answered ${res.status}`)
+  return data as T
+}
+
+export const relay = {
+  register: (fetch: Fetch, relayUrl: string, platform: Platform, pushToken: string) =>
+    call<{ deviceId: string; deviceSecret: string }>(fetch, relayUrl, 'POST', '/v1/devices', { platform, pushToken }),
+  updateToken: (fetch: Fetch, d: RelayDevice, pushToken: string) => call(fetch, d.relayUrl, 'PUT', `/v1/devices/${d.deviceId}`, { pushToken }, d.deviceSecret),
+  grant: (fetch: Fetch, d: RelayDevice, label: string) =>
+    call<{ grantId: string; grantSecret: string }>(fetch, d.relayUrl, 'POST', '/v1/grants', { label: label.slice(0, 80) }, d.deviceSecret),
+  revoke: (fetch: Fetch, d: RelayDevice, grantId: string) => call(fetch, d.relayUrl, 'DELETE', `/v1/grants/${grantId}`, undefined, d.deviceSecret)
+}
+
+/**
+ * What the phone must do for this device and token: nothing, register (no device yet, or a
+ * different relay), or send the new token (the OS rotated it).
+ */
+export function deviceAction(saved: RelayDevice | null, relayUrl: string, platform: Platform, pushToken: string): 'none' | 'register' | 'update' {
+  if (!saved || saved.relayUrl !== relayUrl || saved.platform !== platform) return 'register'
+  return saved.pushToken === pushToken ? 'none' : 'update'
+}
+
+/**
+ * Whether a server needs a new grant from the relay: the phone has none for it, or the server's
+ * `push.status` says the relay refused the one it had (not active). A server that has no grant on
+ * record (null: it was cleared) gets the phone's existing one again with push.setGrant.
+ */
+export function needsGrant(saved: ServerPush | null, status: { active: boolean } | null | undefined): boolean {
+  return !saved || status?.active === false
+}
+
+/** push.setGrant's params for a server */
+export function setGrantParams(relayUrl: string, push: ServerPush, paused: boolean): { relayUrl: string; grantSecret: string; kinds: PushKinds; paused: boolean } {
+  return { relayUrl, grantSecret: push.grantSecret, kinds: { ...push.kinds }, paused }
+}
diff --git a/apps/mobile/src/shared.ts b/apps/mobile/src/shared.ts
index 463247a..a870007 100644
--- a/apps/mobile/src/shared.ts
+++ b/apps/mobile/src/shared.ts
@@ -7,3 +7,6 @@ export { CAPABILITY, CLOSE_UNAUTHORIZED } from '../../../src/shared/protocolV2.t
 export type { AgentInfo, ServerAgents } from '../../../src/shared/protocolV2.ts'
 export type { ChangedFile, WorktreeChanges, SessionType, StackStatus, EnvironmentInfo } from '../../../src/shared/types.ts'
 export type { PromoteRequestEvent, PromoteSettledEvent } from '../../../src/shared/promote.ts'
+export { ALL_PUSH_KINDS_ON, PUSH_GROUPS } from '../../../src/shared/push.ts'
+export type { PushKinds, PushGroup, PushData } from '../../../src/shared/push.ts'
+export type { PushStatusResult } from '../../../src/shared/protocolV2.ts'
diff --git a/apps/mobile/src/state/PushProvider.tsx b/apps/mobile/src/state/PushProvider.tsx
new file mode 100644
index 0000000..e9de859
--- /dev/null
+++ b/apps/mobile/src/state/PushProvider.tsx
@@ -0,0 +1,195 @@
+// Background push on the phone (6b). With a relay in the build's config (`extra.relayUrl`) and
+// notification permission granted, this device registers its native push token (APNs or FCM, not
+// an Expo token) with the relay once, and sends a rotated token. For each paired server whose
+// welcome lists `push`, it takes a grant from the relay and hands it to the server
+// (`push.setGrant`), with the three switches and "Pause all"; a grant the relay refused (the
+// server's `push.status` says not active) is replaced. Removing a server clears its grant there
+// and revokes it at the relay.
+import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
+import { Platform } from 'react-native'
+import Constants from 'expo-constants'
+import * as Notifications from 'expo-notifications'
+import { CAPABILITY, type PushKinds, type PushStatusResult } from '../shared.ts'
+import { ALL_PUSH_KINDS_ON, deviceAction, needsGrant, pushRouteData, relay, relayUrlOf, setGrantParams, type RelayDevice, type ServerPush } from '../logic/push.ts'
+import { pushStorage } from './pushStorage.ts'
+import { useServers } from './ServersProvider.tsx'
+
+interface PushValue {
+  /** The build names a relay: the push settings are shown */
+  enabled: boolean
+  /** This device is registered with the relay (permission granted) */
+  registered: boolean
+  paused: boolean
+  setPaused(paused: boolean): Promise<void>
+  kindsOf(entryId: string): PushKinds
+  setKinds(entryId: string, kinds: PushKinds): Promise<void>
+  /** The server's last word on its grant (push.status), or the phone's own trouble reaching the relay */
+  problemOf(entryId: string): string | undefined
+  /** Clears and revokes a server's grant before the server is removed from the phone */
+  forget(entryId: string): Promise<void>
+  /** A tapped notification's data mapped to the phone's routes (a push names the server's own id) */
+  routeData(data: unknown): unknown
+}
+
+const PushContext = createContext<PushValue | null>(null)
+
+export function usePush(): PushValue {
+  const value = useContext(PushContext)
+  if (!value) throw new Error('usePush outside PushProvider')
+  return value
+}
+
+const relayUrl = relayUrlOf(Constants.expoConfig?.extra?.relayUrl)
+const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null
+
+export function PushProvider({ children }: { children: ReactNode }): React.JSX.Element {
+  const { servers, get, generationOf } = useServers()
+  const [device, setDevice] = useState<RelayDevice | null>(null)
+  const [paused, setPausedState] = useState(false)
+  const [pushes, setPushes] = useState<Record<string, ServerPush>>({})
+  const [problems, setProblems] = useState<Record<string, string | undefined>>({})
+  const deviceRef = useRef<RelayDevice | null>(null)
+  deviceRef.current = device
+  const pausedRef = useRef(false)
+  pausedRef.current = paused
+  /** `${entryId}:${generation}` already synced */
+  const synced = useRef(new Set<string>())
+
+  const problem = (entryId: string, message: string | undefined): void => setProblems((p) => ({ ...p, [entryId]: message }))
+
+  // This device at the relay: registered once, the token sent again when the OS rotates it.
+  useEffect(() => {
+    if (!relayUrl || !platform) return
+    let live = true
+    const ensure = async (pushToken: string): Promise<void> => {
+      const saved = await pushStorage.device()
+      const action = deviceAction(saved, relayUrl, platform, pushToken)
+      let next = saved
+      if (action === 'register') {
+        const { deviceId, deviceSecret } = await relay.register(fetch, relayUrl, platform, pushToken)
+        next = { relayUrl, deviceId, deviceSecret, platform, pushToken }
+      } else if (action === 'update' && saved) {
+        await relay.updateToken(fetch, saved, pushToken)
+        next = { ...saved, pushToken }
+      }
+      if (next && action !== 'none') await pushStorage.setDevice(next)
+      if (live) setDevice(next)
+    }
+    void (async () => {
+      setPausedState(await pushStorage.paused())
+      const permission = await Notifications.getPermissionsAsync().catch(() => null)
+      if (!permission?.granted) return
+      const token = await Notifications.getDevicePushTokenAsync()
+      await ensure(String(token.data))
+    })().catch((err) => console.warn(`[push] could not register with the relay: ${(err as Error).message}`))
+    const sub = Notifications.addPushTokenListener((token) => {
+      void ensure(String(token.data)).catch((err) => console.warn(`[push] could not send the new token: ${(err as Error).message}`))
+    })
+    return () => {
+      live = false
+      sub.remove()
+    }
+  }, [])
+
+  // What the phone knows of each saved server's push, before any connection is up: a push tapped
+  // on a cold start is routed by the server id stored with its grant.
+  const ids = servers.map((s) => s.id).join('\n')
+  useEffect(() => {
+    let live = true
+    void Promise.all(ids.split('\n').filter(Boolean).map(async (id) => [id, await pushStorage.server(id)] as const)).then((pairs) => {
+      if (!live) return
+      setPushes((p) => {
+        const next = { ...p }
+        for (const [id, push] of pairs) if (push && !next[id]) next[id] = push
+        return next
+      })
+    })
+    return () => {
+      live = false
+    }
+  }, [ids])
+
+  /** Takes a grant if the server needs one, then hands the server its grant and switches. */
+  const sync = useCallback(
+    async (entryId: string, label: string, force = false): Promise<void> => {
+      const d = deviceRef.current
+      const conn = get(entryId)?.connection
+      if (!d || !relayUrl || !conn || !conn.welcome?.capabilities.includes(CAPABILITY.push)) return
+      let saved = await pushStorage.server(entryId)
+      const status = (await conn.request('push.status', {})) as PushStatusResult | null
+      if (needsGrant(saved, status)) {
+        if (saved) await relay.revoke(fetch, d, saved.grantId).catch(() => {})
+        const g = await relay.grant(fetch, d, label)
+        saved = { grantId: g.grantId, grantSecret: g.grantSecret, kinds: saved?.kinds ?? { ...ALL_PUSH_KINDS_ON }, serverId: conn.welcome.serverId }
+        await pushStorage.setServer(entryId, saved)
+      } else if (!force && status && status.paused === pausedRef.current && JSON.stringify(status.kinds) === JSON.stringify(saved!.kinds)) {
+        setPushes((p) => ({ ...p, [entryId]: saved! }))
+        problem(entryId, status.lastError)
+        return
+      }
+      await conn.request('push.setGrant', setGrantParams(relayUrl, saved!, pausedRef.current))
+      setPushes((p) => ({ ...p, [entryId]: saved! }))
+      problem(entryId, undefined)
+    },
+    [get]
+  )
+
+  // Each connection (each generation of it) is synced once it is up.
+  useEffect(() => {
+    if (!device) return
+    for (const s of servers) {
+      if (s.status !== 'connected' || !s.capabilities.includes(CAPABILITY.push)) continue
+      const key = `${s.id}:${generationOf(s.id)}`
+      if (synced.current.has(key)) continue
+      synced.current.add(key)
+      void sync(s.id, s.name).catch((err) => problem(s.id, (err as Error).message))
+    }
+  }, [servers, device, generationOf, sync])
+
+  const setPaused = useCallback(
+    async (next: boolean) => {
+      setPausedState(next)
+      pausedRef.current = next
+      await pushStorage.setPaused(next)
+      await Promise.all(servers.filter((s) => s.status === 'connected').map((s) => sync(s.id, s.name, true).catch((err) => problem(s.id, (err as Error).message))))
+    },
+    [servers, sync]
+  )
+
+  const setKinds = useCallback(
+    async (entryId: string, kinds: PushKinds) => {
+      const saved = await pushStorage.server(entryId)
+      if (!saved) return
+      const next = { ...saved, kinds }
+      await pushStorage.setServer(entryId, next)
+      setPushes((p) => ({ ...p, [entryId]: next }))
+      const name = servers.find((s) => s.id === entryId)?.name ?? ''
+      await sync(entryId, name, true).catch((err) => problem(entryId, (err as Error).message))
+    },
+    [servers, sync]
+  )
+
+  const forget = useCallback(async (entryId: string) => {
+    const saved = await pushStorage.server(entryId)
+    await get(entryId)?.connection.request('push.clearGrant', {}).catch(() => {})
+    const d = deviceRef.current
+    if (saved && d) await relay.revoke(fetch, d, saved.grantId).catch(() => {})
+    await pushStorage.setServer(entryId, null)
+  }, [get])
+
+  const value = useMemo<PushValue>(
+    () => ({
+      enabled: relayUrl !== null,
+      registered: device !== null,
+      paused,
+      setPaused,
+      kindsOf: (id) => pushes[id]?.kinds ?? ALL_PUSH_KINDS_ON,
+      setKinds,
+      problemOf: (id) => problems[id],
+      forget,
+      routeData: (data) => pushRouteData(data, (serverId) => Object.entries(pushes).find(([, p]) => p.serverId === serverId)?.[0])
+    }),
+    [device, paused, setPaused, pushes, setKinds, problems, forget]
+  )
+  return <PushContext.Provider value={value}>{children}</PushContext.Provider>
+}
diff --git a/apps/mobile/src/state/pushStorage.ts b/apps/mobile/src/state/pushStorage.ts
new file mode 100644
index 0000000..ab3c811
--- /dev/null
+++ b/apps/mobile/src/state/pushStorage.ts
@@ -0,0 +1,30 @@
+// Background push's secrets on the phone (6b), in secure storage beside the servers' tokens: this
+// device's registration at the relay (its secret), each paired server's grant (its secret and the
+// three switches), and "Pause all pushes".
+import * as SecureStore from 'expo-secure-store'
+import type { RelayDevice, ServerPush } from '../logic/push.ts'
+
+const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
+const DEVICE_KEY = 'trek.push.device'
+const PAUSED_KEY = 'trek.push.paused'
+const serverKey = (entryId: string): string => `trek.push.server.${entryId.replace(/[^A-Za-z0-9._-]/g, '_')}`
+
+async function readJson<T>(key: string): Promise<T | null> {
+  const raw = await SecureStore.getItemAsync(key, OPTIONS)
+  if (!raw) return null
+  try {
+    return JSON.parse(raw) as T
+  } catch {
+    return null
+  }
+}
+
+export const pushStorage = {
+  device: () => readJson<RelayDevice>(DEVICE_KEY),
+  setDevice: (d: RelayDevice | null) => (d ? SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(d), OPTIONS) : SecureStore.deleteItemAsync(DEVICE_KEY, OPTIONS)),
+  server: (entryId: string) => readJson<ServerPush>(serverKey(entryId)),
+  setServer: (entryId: string, p: ServerPush | null) =>
+    p ? SecureStore.setItemAsync(serverKey(entryId), JSON.stringify(p), OPTIONS) : SecureStore.deleteItemAsync(serverKey(entryId), OPTIONS),
+  paused: async () => (await SecureStore.getItemAsync(PAUSED_KEY, OPTIONS)) === '1',
+  setPaused: (paused: boolean) => SecureStore.setItemAsync(PAUSED_KEY, paused ? '1' : '0', OPTIONS)
+}
diff --git a/scripts/mobileLogic.test.mjs b/scripts/mobileLogic.test.mjs
index 35522c3..5bb5d2e 100644
--- a/scripts/mobileLogic.test.mjs
+++ b/scripts/mobileLogic.test.mjs
@@ -182,3 +182,54 @@ test('ref counts: on for the first user, off after the last', () => {
   assert.equal(counts.release('p'), false)
   assert.equal(counts.acquire('p'), true)
 })
+
+// ---- Background push (6b): apps/mobile/src/logic/push.ts ----
+import { deviceAction, needsGrant, pushRouteData, relay, relayUrlOf, setGrantParams } from '../apps/mobile/src/logic/push.ts'
+
+test('push: the build relay is https, or http to this device or a private address; nothing else', () => {
+  assert.equal(relayUrlOf('https://relay.example/'), 'https://relay.example')
+  assert.equal(relayUrlOf('http://192.168.1.5:7346'), 'http://192.168.1.5:7346')
+  for (const bad of ['', '  ', 'http://relay.example', 'https://u:p@relay.example', 'https://relay.example?x=1', 'nope', 42, undefined]) assert.equal(relayUrlOf(bad), null, String(bad))
+})
+
+test('push: register once, send a rotated token, register again for another relay', () => {
+  const saved = { relayUrl: 'https://r', deviceId: 'd', deviceSecret: 's', platform: 'ios', pushToken: 'a' }
+  assert.equal(deviceAction(null, 'https://r', 'ios', 'a'), 'register')
+  assert.equal(deviceAction(saved, 'https://r', 'ios', 'a'), 'none')
+  assert.equal(deviceAction(saved, 'https://r', 'ios', 'b'), 'update')
+  assert.equal(deviceAction(saved, 'https://other', 'ios', 'a'), 'register')
+})
+
+test('push: a new grant when the phone has none or the relay refused it; the old one again when the server forgot it', () => {
+  const push = { grantId: 'g', grantSecret: 'x', kinds: { decisions: true, sessions: false, prWatch: true }, serverId: 's' }
+  assert.equal(needsGrant(null, null), true)
+  assert.equal(needsGrant(push, { active: false }), true)
+  assert.equal(needsGrant(push, { active: true }), false)
+  assert.equal(needsGrant(push, null), false)
+  assert.deepEqual(setGrantParams('https://r', push, true), { relayUrl: 'https://r', grantSecret: 'x', kinds: { decisions: true, sessions: false, prWatch: true }, paused: true })
+})
+
+test("push: the relay's calls carry the device secret, and its errors say what it answered", async () => {
+  const calls = []
+  const fetch = async (url, init) => {
+    calls.push({ url, ...init })
+    if (url.endsWith('/v1/grants')) return { status: 409, json: async () => ({ error: 'this device has too many grants' }) }
+    return { status: 201, json: async () => ({ deviceId: 'd1', deviceSecret: 'sec' }) }
+  }
+  const reg = await relay.register(fetch, 'https://r', 'android', 'tok')
+  assert.deepEqual(reg, { deviceId: 'd1', deviceSecret: 'sec' })
+  assert.deepEqual(JSON.parse(calls[0].body), { platform: 'android', pushToken: 'tok' })
+  await assert.rejects(relay.grant(fetch, { relayUrl: 'https://r', deviceId: 'd1', deviceSecret: 'sec' }, 'x'.repeat(200)), /too many grants/)
+  assert.equal(calls[1].headers.authorization, 'Bearer sec')
+  assert.equal(JSON.parse(calls[1].body).label.length, 80)
+  await assert.rejects(relay.register(async () => { throw new Error('offline') }, 'https://r', 'ios', 't'), /could not be reached/)
+})
+
+test("push: a tapped push names the server's own id (under trek on iOS, at the top on Android): mapped to the entry", () => {
+  const entryFor = (id) => (id === 'srv-1' ? 'entry-1' : undefined)
+  assert.deepEqual(pushRouteData({ trek: { kind: 'decision', serverId: 'srv-1', projectId: 'p', sessionId: 's' } }, entryFor), { kind: 'decision', serverId: 'entry-1', projectId: 'p', sessionId: 's' })
+  assert.deepEqual(pushRouteData({ kind: 'pr-merged', serverId: 'srv-1', projectId: 'p', worktreeId: 'w' }, entryFor), { kind: 'pr-merged', serverId: 'entry-1', projectId: 'p', worktreeId: 'w' })
+  assert.equal(pushRouteData({ kind: 'decision', serverId: 'unknown', projectId: 'p' }, entryFor), null)
+  const local = { serverId: 'entry-1', projectId: 'p', sessionId: 's' }
+  assert.equal(pushRouteData(local, entryFor), local, "a local notification (6a) already names the entry")
+})
diff --git a/scripts/sharedForMobile.test.mjs b/scripts/sharedForMobile.test.mjs
index 5a14ac8..49828a1 100644
--- a/scripts/sharedForMobile.test.mjs
+++ b/scripts/sharedForMobile.test.mjs
@@ -10,7 +10,7 @@ import { dirname, join, relative, resolve } from 'node:path'
 
 const root = resolve(new URL('..', import.meta.url).pathname)
 /** What apps/mobile imports from the shared code (keep in step with apps/mobile/src/shared.ts). */
-export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts', 'src/shared/types.ts', 'src/shared/promote.ts']
+export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts', 'src/shared/types.ts', 'src/shared/promote.ts', 'src/shared/push.ts']
 /** Packages the phone also has (none today: the shared code is dependency-free). */
 const ALLOWED_PACKAGES = new Set([])
 
````

</details>

### Task 6: docs

relay/README.md, PROTOCOL.md "Background push", the READMEs, the phone README's push section and real-device checklist, the spec pointer.

**Prototype commit:** `8445e75` on `central-server-phase6b-proto`.

**Files:**
- `PROTOCOL.md`
- `README.md`
- `apps/mobile/README.md`
- `docs/superpowers/specs/2026-11-04-central-server-design.md`
- `relay/README.md`
- `server/README.md`

- [ ] **Step 1: Tests first.** Check every statement against the code of Tasks 1–5.
- [ ] **Step 2: Implement** as in the diff below (cherry-pick the prototype commit, then review it).
- [ ] **Step 4: Commit** with the standing command (`git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m … -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`).

<details><summary>The prototype's diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 2a33fb5..f70fd48 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -437,6 +437,48 @@ redeems the code at `hello`.
   `[::ffff:127.0.0.1]`, and the any-address `0.0.0.0` / `[::]`). On the phone a `trek://pair`
   link only fills the Add server form; nothing is redeemed until the user taps Pair.
 
+## Background push
+
+Phase 6b, behind the `push` capability. A phone hands each paired server a grant from the user's
+push relay (`trek-relay`, `relay/README.md`), and the server posts the phone's attention to the
+relay while the phone isn't connected. The relay holds the APNs and FCM credentials; the server
+never sees them, nor the phone's push token.
+
+| Method | Params | Result |
+|---|---|---|
+| `push.setGrant` | `{relayUrl, grantSecret, kinds?: {decisions?, sessions?, prWatch?}, paused?}` | `null` |
+| `push.clearGrant` | `{}` | `null` |
+| `push.status` | `{}` | `{relayUrl, kinds, paused, active, lastError?, lastPushAt?}` or `null` |
+
+- **Per token:** a grant belongs to the token the connection signed in with (the phone's own
+  `phone-<device>`), one per token: `push.setGrant` replaces the one before. It is kept in the
+  server's `secrets.json` (0600) under `push:<token name>`, and `push.status` never returns the
+  secret. Revoking the token drops its grant. `kinds` default to all on and `paused` to false.
+- **The relay address** must be `https://`, or `http://` to `127.0.0.1`, `localhost` or `[::1]`
+  (a relay on the server's machine, or a test), with no user name, password, query or fragment.
+- **What is pushed:** a new attention entry whose kind the grant has on.
+  - `decisions`: a session's `request_decision` (kind `decision`).
+  - `sessions`: a session waiting for the user, in `attention` or `done` (`session-finished`), or
+    one whose process exited by itself (`session-stopped`; not one closed, restarted, unloaded or
+    moved).
+  - `prWatch`: a watched pull request's report (5c-1), as its most pressing event:
+    `pr-conflict`, `pr-checks-failed`, `pr-review`, `pr-merged`, `pr-closed`, then
+    `pr-checks-passed`. A "can't be read" notice isn't pushed.
+  - `promote_to_primary` requests aren't pushed: with no window listening they end at once
+    (`no-window`), so there is nothing for a phone to answer later.
+
+  What was already listed when the server started is never pushed.
+- **When not:** never while the grant is `paused`, and never while any connection signed in with
+  that token is open (the phone shows it already). One push per (token, project, kind) in 30
+  seconds, so a burst is one push.
+- **The push:** `POST <relayUrl>/v1/push` with the grant secret as the bearer, and only
+  `{kind, project: <the project's name>, data: {serverId, projectId, worktreeId?, sessionId?}}`.
+  The relay builds the words from the kind (`relay/README.md`). Network errors and `5xx` are
+  retried 3 times (1, 3 and 10 seconds apart). `401`, `404` or `410` mean the relay no longer has
+  the grant, or the phone is gone: the server keeps the grant's settings without its secret,
+  `push.status` answers `active: false` with `lastError`, and the phone takes a new grant. A `429`
+  is recorded in `lastError` and that push is dropped.
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config; never `--local`, which is a
diff --git a/README.md b/README.md
index d149e52..f5c020b 100644
--- a/README.md
+++ b/README.md
@@ -284,8 +284,13 @@ tears them down first).
   Caddy").
 - **Addresses**: `wss://` always; plain `ws://` only to a private network address
   (LAN, Tailscale, `.local`), with a warning.
-- **Not yet**: notifications while the app is closed (6b: a push relay), and
-  creating or moving worktrees, or starting a promote, from the phone.
+- **Push** (6b): with a push relay (`relay/README.md`, `trek-relay`) built into the app
+  (`expo.extra.relayUrl` in `apps/mobile/app.json`), the phone gets notifications while it is
+  closed: decisions, sessions waiting or stopped, pull request reports. Each server has three
+  switches on the phone (Servers → Push…), and the Servers screen has **Pause all pushes**. A push
+  says only the project and what happened. The relay holds the APNs key and the FCM credentials;
+  your servers never do.
+- **Not yet**: creating or moving worktrees, or starting a promote, from the phone.
 
 See `apps/mobile/README.md` to build and run it.
 
@@ -504,6 +509,10 @@ one at a time:
   token, New code withdrawing the code (Done keeps it), and that token's revocation;
   the server listens on this machine's first non-internal IPv4 address (the smoke prints
   SKIP and passes without one);
+- `npm run smoke:push`: background push (6b), without Electron: a trek-relay with a local
+  APNs stub, a trek-server and the SDK playing the desktop and the phone: the grant handed
+  over, a decision pushed with only its project and kind, nothing when muted or while the
+  phone is connected, a session's own exit pushed, a grant revoked at the relay dropped;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/apps/mobile/README.md b/apps/mobile/README.md
index bc2e747..f04992c 100644
--- a/apps/mobile/README.md
+++ b/apps/mobile/README.md
@@ -1,8 +1,8 @@
 # Trek phone companion (`apps/mobile`)
 
-Phase 6a. An Expo app (SDK 58, Expo Router) for iOS and Android: what needs you on every
-paired trek-server, sessions and their terminals, prompts, decisions and read-only
-Changes. The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone
+Phase 6a (and 6b's background push). An Expo app (SDK 58, Expo Router) for iOS and
+Android: what needs you on every paired trek-server, sessions and their terminals,
+prompts, decisions and read-only Changes, and pushes while it is closed. The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone
 pairing") how it signs in.
 
 It talks protocol v2 through the repo's own shared code: `src/shared.ts` re-exports
@@ -60,6 +60,32 @@ from outside it.
 The app's pure modules (`src/logic/`) are tested from the repo root
 (`scripts/mobileLogic.test.mjs`, part of `npm test`).
 
+## Push (6b)
+
+Background push goes through your own push relay (`relay/README.md`), which holds the APNs
+key and the FCM service account for this app's bundle id / package. Set its address in
+`app.json` before building:
+
+```json
+{ "expo": { "extra": { "relayUrl": "https://push.example.com" } } }
+```
+
+It must be `https://` (or `http://` to this device or a private address, for a relay on the
+LAN while developing). Empty (the default): no push settings, nothing registered.
+
+With a relay and notification permission, the app registers its native push token (APNs or
+FCM, not an Expo push token) with the relay once, and sends a new one when the OS rotates it.
+For each paired server whose welcome lists `push`, it takes a grant from the relay and hands
+it to the server (`push.setGrant`). Servers → **Push…** has the server's three switches
+(Decisions, Sessions, PR watch), saved to the server at once; **Pause all pushes** pauses
+every server. Removing a server clears its grant there and revokes it at the relay. The
+device secret and each grant's secret are kept in secure storage. A tapped push opens its
+session (or worktree), like a local notification.
+
+APNs and FCM only deliver to a real build: a development build on a device (EAS or
+`npx expo run:ios --device`) with the push entitlement, or an Android device with the
+app's `google-services.json`. The simulator gets no remote pushes.
+
 ## Run it
 
 The camera, secure storage, notifications and the WebView are native modules, so the app
@@ -121,4 +147,18 @@ network, so a server on this Mac at a LAN address works, with a warning for `ws:
 9. **Revocation:** `trek-server token revoke phone-<name>`. The server shows **Pair again**.
    Pairing again from there replaces the entry: the server is listed once.
 
-No real push services (APNs, FCM, Expo) are used: background push is 6b.
+10. **Push (6b), on a real device only** (a development build with the push entitlement, a
+    relay configured as in `relay/README.md`, its address in `extra.relayUrl`):
+    - Allow notifications. The relay's `relay.json` lists the device; Servers shows **Push…**
+      for the server.
+    - Close the app. A `request_decision` gives a push "Trek · <project>" / "A decision is
+      waiting", without the question. Tapping it opens that session.
+    - A session that exits by itself gives "A session stopped".
+    - Push… → Decisions off: the next decision gives nothing; Sessions still do.
+    - **Pause all pushes**: nothing from any server; off again: pushes return.
+    - With the app open on that server, nothing is pushed (the list shows it).
+    - Remove the server: the relay's grant is gone (`GET /v1/grants` no longer lists it).
+    - `trek-server token revoke phone-<name>`: the server drops the grant; no more pushes.
+
+The repo's checks use no real push service (APNs, FCM, Expo): `npm run smoke:push` runs
+against a local APNs stub.
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index c1d3cd4..e25741d 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -502,7 +502,8 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
    by a one-time code from the desktop app), spec `2026-11-11-phase6a-mobile-companion-design.md`, plan
    `docs/superpowers/plans/2026-11-11-central-server-phase6a-mobile.md`;
    **6b** is background push through a Trek push relay the user hosts, spec
-   `2026-11-11-phase6b-push-relay-design.md`.
+   `2026-11-11-phase6b-push-relay-design.md`, plan
+   `docs/superpowers/plans/2026-11-11-central-server-phase6b-push.md`.
 
 Remote projects can be opened after phase 3. After phase 4 every project is on a server and
 the legacy path is gone; phase 5 brings back the remaining features.
diff --git a/relay/README.md b/relay/README.md
new file mode 100644
index 0000000..a30e523
--- /dev/null
+++ b/relay/README.md
@@ -0,0 +1,104 @@
+# trek-relay: the Trek push relay
+
+Phase 6b. iOS can only wake an app that isn't running through Apple's push service (APNs), and
+Android through Firebase Cloud Messaging (FCM). Both need credentials tied to one build of the
+phone app. `trek-relay` is the one place that holds them: your trek-servers post "a decision is
+waiting in trek-app" to it, and it sends the push. You host it once, for your build of the app.
+
+- **No credentials on the servers.** A server never sees the APNs key, the FCM service account or
+  a phone's push token. It holds only a grant: a secret the phone got from the relay and handed to
+  that server.
+- **No free text.** A push carries a kind (`decision`, `session-finished`, `session-stopped`,
+  `pr-checks-failed`, `pr-checks-passed`, `pr-review`, `pr-conflict`, `pr-merged`, `pr-closed`)
+  and a project name. The relay builds the words ("Trek · trek-app" / "A decision is waiting"), so
+  terminal text, a decision's question or a branch name can't reach a lock screen.
+- **Nothing to install at run time.** The relay is plain Node (20 or later): `http`, `http2` and
+  `crypto`. `npm run build` bundles it into one file, `dist/trek-relay.cjs`.
+
+## Credentials
+
+You need at least one platform. A platform with no credentials is refused at registration.
+
+- **APNs (iOS):** in the Apple Developer account that signs the app, create a key with Apple Push
+  Notifications service enabled (Certificates, Identifiers & Profiles → Keys). Download the
+  `AuthKey_<KEYID>.p8` file once, and note its Key ID and your Team ID. The bundle id is the app's
+  (`ios.bundleIdentifier` in `apps/mobile/app.json`). Use `"production": false` for development
+  builds (the APNs sandbox) and `true` for TestFlight and App Store builds.
+- **FCM (Android):** in the Firebase project the Android app is registered in, create a service
+  account key (Project settings → Service accounts → Generate new private key). That JSON file is
+  `serviceAccountPath`.
+
+Keep both files readable only by the relay's user (`chmod 600`). The relay refuses to start if
+they, or its config, can be read by group or others.
+
+## Configure and run
+
+```json
+{
+  "dataDir": "/var/lib/trek-relay",
+  "host": "127.0.0.1",
+  "port": 7346,
+  "apns": {
+    "keyId": "ABC123DEFG",
+    "teamId": "TEAM123456",
+    "bundleId": "dev.trek.mobile",
+    "keyPath": "/etc/trek-relay/AuthKey_ABC123DEFG.p8",
+    "production": false
+  },
+  "fcm": { "serviceAccountPath": "/etc/trek-relay/firebase-service-account.json" }
+}
+```
+
+```bash
+cd relay && npm ci && npm run build
+chmod 600 /etc/trek-relay/relay.json
+node dist/trek-relay.cjs start --config /etc/trek-relay/relay.json
+```
+
+Relative paths in the config resolve against the config file's directory. `--host` and `--port`
+override the config's. The relay listens on plain HTTP: put it behind a TLS proxy, as you do
+trek-server. Servers only accept an `https://` relay address (or `http://` on their own machine).
+
+```caddyfile
+push.example.com {
+  reverse_proxy 127.0.0.1:7346
+}
+```
+
+Then build the phone app with that address: set `expo.extra.relayUrl` in `apps/mobile/app.json`
+(for example `"https://push.example.com"`) before building. A build without it shows no push
+settings and registers nothing.
+
+## What it stores
+
+`<dataDir>/relay.json` (mode 0600): each phone's push token and platform, and its grants (one per
+paired server, labelled with the server's name). The phone's device secret and every grant's
+secret are kept only as sha256 hashes. A device whose token APNs or FCM reports as gone is marked
+dead: its grants answer `410` until the phone sends a new token. The relay logs the kind, the
+grant id and the push service's answer, never a push's words, tokens or secrets.
+
+## API
+
+JSON over `/v1`, bodies at most 16 KiB. The phone's calls carry its device secret, a server's its
+grant secret, each as `Authorization: Bearer <secret>`.
+
+| Call | Who | Body | Answer |
+|---|---|---|---|
+| `POST /v1/devices` | phone | `{platform: 'ios'\|'android', pushToken}` | `201 {deviceId, deviceSecret}` |
+| `PUT /v1/devices/:id` | phone | `{pushToken}` | `200` (a rotated token; revives a dead device) |
+| `DELETE /v1/devices/:id` | phone | | `200` (the device and its grants) |
+| `POST /v1/grants` | phone | `{label}` (up to 80 characters) | `201 {grantId, grantSecret}` |
+| `GET /v1/grants` | phone | | `200 [{grantId, label, createdAt, lastPushAt}]` |
+| `DELETE /v1/grants/:id` | phone | | `200` |
+| `POST /v1/push` | server | `{kind, project, data: {serverId, projectId, worktreeId?, sessionId?}}` | `202`; `401` unknown grant; `410` the device is gone; `429` limited; `502` the push service refused |
+| `GET /v1/health` | anyone | | `200 {ok: true}` |
+
+Limits: 10 registrations a minute per address; 30 pushes a minute per grant and 120 an hour per
+device; 50 grants per device.
+
+## Testing
+
+`npm test` at the repo root runs the relay's tests (`scripts/relay*.test.mjs`) against local stubs
+of APNs, Google's token endpoint and FCM. `npm run smoke:push` runs a relay, a trek-server and a
+phone played by the SDK, with a local APNs stub. The config's `apnsHost`, `fcmHost` and
+`oauthHost` exist only for those stubs: leave them out in a real config.
diff --git a/server/README.md b/server/README.md
index 2557e9c..7765240 100644
--- a/server/README.md
+++ b/server/README.md
@@ -251,6 +251,18 @@ share it. If the config can't be written the phone is refused ("the server could
 save the new token", with the reason in the log) and the code stays spent. The local
 server doesn't pair phones. See PROTOCOL.md, "Phone pairing".
 
+## Background push
+
+With a push relay (6b, `relay/README.md`), a paired phone gets pushes while the app is closed: a
+decision waiting, a session waiting or stopped, a watched pull request's report. The phone hands
+the server a grant from the relay (`push.setGrant`), kept in `secrets.json` beside the config under
+`push:<token name>`, never shown again. The server posts only the kind, the project's name and
+ids, and only while that phone has no connection open, at most once per project and kind in 30
+seconds. The phone's three switches and Pause all are applied here, so a muted kind never leaves
+the server. Revoking the phone's token drops its grant; a grant the relay refuses (`401`/`404`/
+`410`) is dropped too and the phone takes a new one. The relay's address must be `https://` (or
+`http://` on this machine). See PROTOCOL.md, "Background push".
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config, read at start) also serves
````

</details>

### Task 7: Verification

- [ ] Root: `npm run typecheck`, `cd server && npm run typecheck`, `npm run typecheck:relay`, `cd apps/mobile && npm run typecheck`.
- [ ] `npm test` (0 fail; known parallel flakes: `scripts/serverMachine.test.mjs:337`, `botTurn.test.mjs` "a good result beats a stop…", `serverMove.test.mjs` "C1: an untracked real directory…": rerun one alone if it fails under load).
- [ ] `npm run build`, `npm run build:relay`.
- [ ] `npm run smoke:push`, `cd server && npm run smoke`, then every Electron smoke one at a time (each with its own temp `--user-data-dir` and HOME): v2, local-window, local-app, local-features, server-env, server-integrations, server-prwatch, server-review, server-pairing, server-move, server-promote, server-web, providers, windows, import, local, client.
- [ ] `apps/mobile`: `npx expo export` for ios and android into a scratch directory.
- [ ] A clean clone: `npm ci` (which installs `server/` and `relay/`), typechecks, `npm test`, `npm run build`, `npm run build:relay`, and `apps/mobile` `npm ci` + typecheck + both exports.
- [ ] No leftover trek-server, trek-relay, Electron, Metro or fake-agent processes.
