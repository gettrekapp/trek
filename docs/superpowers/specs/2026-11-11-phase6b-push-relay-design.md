# Phase 6b: background push through a Trek push relay (design)

Status: approved by the user, 2026-11-11. Parent specs: `2026-11-04-central-server-design.md` §6 and
`2026-11-11-phase6a-mobile-companion-design.md` (its "6b outline").

## Purpose

Phase 6a's phone companion notifies only while it is open or briefly backgrounded. 6b adds real
background push, so a decision waiting, a session finishing or a PR watch notice reaches the phone
when the app is closed. iOS can only wake a custom app through APNs, so pushes go through a relay
the user hosts that holds the APNs key and the FCM credentials.

## User decisions (2026-11-11)

1. **Form:** a new `trek-relay` package in this repo (`relay/`): its own CLI and config, run
   once (for example on a VPS behind Caddy). The APNs and FCM secrets live only there.
2. **Trust:** phone-issued grants.
   - The phone registers its push token with the relay once.
   - For each paired server, it asks the relay for a grant bound to that device and hands only
     the grant to the server.
   - A server can push only to devices that granted it. It never sees the APNs or FCM token. The
     phone can revoke a grant.
3. **Payload:** the project and the kind of event only, for example "Trek · trek-app: a decision
   is waiting". There is never terminal text, a decision's question or a branch name. Tapping
   opens the app, which reads the details over its own connection.
4. **Events:** decisions waiting, sessions finished or stopped, and PR watch notices. Each can be
   switched on and off.
5. **Switches:** on the phone, per paired server: three switches, plus a phone-wide "Pause all
   pushes". The phone sends the choices to the server with its grant, and the server filters
   before sending, so a muted kind never leaves the server.
6. **Relay address:** built into the app's build config (`app.json` `extra.relayUrl`, overridable
   per build). An APNs key belongs to one app ID, so a relay belongs to one build of the app.
7. **Implementation:** plain Node with no push SDKs.
   - APNs over `node:http2` with a `.p8` token, signed ES256 with `node:crypto`.
   - FCM HTTP v1, using a service-account JWT exchanged for an OAuth token.
   - A JSON store.

## 1. The relay (`relay/`, `trek-relay`)

- **Running:** `trek-relay start --config <file> [--host <h>] [--port <p>]`, behind the user's
  TLS proxy, like trek-server. The config file holds:
  - `apns: {keyId, teamId, bundleId, keyPath, production}`;
  - `fcm: {serviceAccountPath}`;
  - `dataDir`.

  Either credential block may be absent; that platform is then refused.

  The relay refuses to start if a credential file, or the config, is readable by group or
  others. For tests only, the config also accepts `apnsHost`, `fcmHost` and `oauthHost` to point
  at local stub servers.
- **API** (JSON under `/v1`; bodies capped at 16 KiB):
  - **Register a device:** `POST /v1/devices {platform: 'ios'|'android', pushToken}` returns
    `{deviceId, deviceSecret}`.
  - **Device calls** (bearer: the device secret):
    - `PUT /v1/devices/:id {pushToken}` rotates the token;
    - `DELETE /v1/devices/:id` removes the device and all its grants;
    - `POST /v1/grants {label}` returns `{grantId, grantSecret}`. The label is the server's name,
      up to 80 characters;
    - `GET /v1/grants` returns `[{grantId, label, createdAt, lastPushAt}]`;
    - `DELETE /v1/grants/:id` revokes a grant.
  - **Send a push:** `POST /v1/push {kind, project, data: {serverId, projectId, sessionId?,
    worktreeId?}}`, with the grant secret as the bearer.
    - `kind` is one of `decision`, `session-finished`, `session-stopped`, `pr-checks-failed`,
      `pr-checks-passed`, `pr-review`, `pr-conflict`, `pr-merged`, `pr-closed`.
    - The relay builds the title and body from `kind` and `project` (title "Trek · <project>",
      body from a fixed table), so a server cannot send arbitrary text.
    - `data` values are ids up to 128 characters each.
    - The answer is `202`, or `401` for an unknown grant and `410` for a revoked grant or a dead
      device.
- **Storage:**
  - `<dataDir>/relay.json`, written atomically with mode 0600.
  - Device and grant secrets are 256-bit random values, stored only as sha256 hashes.
  - A device that APNs reports as `Unregistered` or `BadDeviceToken` (or HTTP 410), or that FCM
    reports as `UNREGISTERED`, is marked dead, and its grants then answer `410`.
- **Limits:**
  - device registration: 10 a minute per address;
  - pushes: 30 a minute per grant and 120 an hour per device (`429`);
  - at most 50 grants per device;
  - `project` up to 80 characters.
- **Logging:** the kind, the grant id and the provider's result only, never the push text,
  tokens or secrets.
- **Delivery:**
  - **APNs:** an `alert` push with `apns-push-type: alert`, priority 10, and `apns-topic` from
    `bundleId`. The JWT is cached for 50 minutes.
  - **FCM:** a v1 `message` with `notification` and `data`. The OAuth token is cached until it
    nears expiry.

## 2. trek-server

- **Methods,** behind a new `push` capability:
  - `push.setGrant {relayUrl, grantSecret, kinds: {decisions, sessions, prWatch}, paused}`:
    - called by the phone;
    - stored against the calling connection's token, in the server's secrets file (0600);
    - write-only (the secret is never returned);
    - one grant per token, so a new call replaces the old one.
  - `push.clearGrant {}`.
  - `push.status {}`: returns `{relayUrl, kinds, paused, lastError?, lastPushAt?}`, or `null`.
- **Lifetime:** revoking a token drops its grant.
- **Pushing:**
  - **When:** a new attention entry whose kind the grant has switched on.
    - `decisions`: `request_decision` and `promote_to_primary` requests.
    - `sessions`: a session finished (idle and waiting) or stopped (exited or errored).
    - `prWatch`: the 5c-1 notices.
  - **When not:** never while `paused`, and never while that token has a live connection to the
    server, since the app already shows it.
  - **Coalescing:** per (token, project, kind) within 30 seconds, so a burst becomes one push.
- **Delivery:**
  - `POST <relayUrl>/v1/push`, with up to 3 retries on network errors or `5xx`, backing off from
    1 to 10 seconds.
  - A `401`, `404` or `410` drops the grant and records `lastError`, which the phone sees in
    `push.status`.
  - A `429` is recorded and that push is dropped.
  - `relayUrl` must be `https://`, or `http://` for loopback only (tests).
- **What it sends:** only `kind`, the project's name and the ids above.

## 3. The phone (`apps/mobile`)

- **Registering:**
  1. When notification permission is granted and the build has a `relayUrl`, the app gets the
     native token (`getDevicePushTokenAsync`, not an Expo token).
  2. It registers with the relay.
  3. It keeps `{deviceId, deviceSecret}` in secure storage.
  4. A changed token is sent with `PUT`.
- **Grants:** for each paired server whose welcome lists `push`, the app:
  1. creates a grant labelled with the server's name;
  2. calls `push.setGrant` (default kinds: all on; not paused);
  3. keeps the grant id with the server entry.
- **Settings:**
  - Each server's settings screen gets three switches (Decisions, Sessions, PR watch), saved to
    the server immediately, and shows `push.status`'s `lastError`.
  - The Servers screen gets "Pause all pushes", which sets `paused` on every server.
- **Removing a server** calls `push.clearGrant` (if connected) and revokes the grant at the relay.
- **Taps** open the session or worktree through 6a's existing routing.
- **A build without `relayUrl`** hides the push settings and registers nothing.

## 4. Testing (no real Apple, Google or Expo services)

- **Relay unit tests** (`node --test`, in `scripts/`):
  - the ES256 APNs JWT, checked against a test key;
  - the FCM service-account JWT and token exchange, against a stub OAuth endpoint;
  - the API: registration, grants, auth, limits, the body cap, kind validation, dead devices;
  - the store's atomic write and mode;
  - the refusal to start with readable credential files.
- **Server unit tests:**
  - setGrant, clearGrant and status, write-only;
  - filtering by kind, and pause;
  - skipping while connected;
  - coalescing;
  - retries and backoff;
  - dropping the grant on 401/404/410;
  - the relay-URL rule;
  - token revocation dropping the grant.
- **`smoke:push`:** a relay with stub APNs and FCM hosts (a local http2 server for APNs), a
  trek-server, and an SDK client playing the phone. It:
  1. registers, takes a grant and calls setGrant;
  2. disconnects, raises a decision, and checks the stub received exactly one push carrying only
     the kind and project;
  3. checks a muted kind sends nothing;
  4. checks a connected phone gets nothing;
  5. checks a revoked grant is dropped by the server, with `lastError` set.
- **The phone:** unit tests for its pure logic; typecheck and `expo export` for both platforms.
  Real delivery needs an EAS dev build on a device. That is in `apps/mobile/README.md`'s checklist
  and runs only when the user asks.
- **Isolation:** the usual smoke rules apply (temp HOME, data dirs and `TMPDIR`), with no real
  provider hosts.

## Out of scope

- Rich or encrypted notification content.
- Notification actions (answering from the lock screen).
- Several relays per build.
- A web or desktop push target.
