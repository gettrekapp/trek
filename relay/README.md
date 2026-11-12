# trek-relay: the Trek push relay

Phase 6b. iOS can only wake an app that isn't running through Apple's push service (APNs), and
Android through Firebase Cloud Messaging (FCM). Both need credentials tied to one build of the
phone app. `trek-relay` is the one place that holds them: your trek-servers post "a decision is
waiting in trek-app" to it, and it sends the push. You host it once, for your build of the app.

- **No credentials on the servers.** A server never sees the APNs key, the FCM service account or
  a phone's push token. It holds only a grant: a secret the phone got from the relay and handed to
  that server.
- **No free text.** A push carries a kind (`decision`, `session-finished`, `session-stopped`,
  `pr-checks-failed`, `pr-checks-passed`, `pr-review`, `pr-conflict`, `pr-merged`, `pr-closed`)
  and a project name. The relay builds the words ("Trek · trek-app" / "A decision is waiting"), so
  terminal text, a decision's question or a branch name can't reach a lock screen.
- **Nothing to install at run time.** The relay is plain Node (20 or later): `http`, `http2` and
  `crypto`. `npm run build` bundles it into one file, `dist/trek-relay.cjs`.

## Credentials

You need at least one platform. A platform with no credentials is refused at registration.

- **APNs (iOS):** in the Apple Developer account that signs the app, create a key with Apple Push
  Notifications service enabled (Certificates, Identifiers & Profiles → Keys). Download the
  `AuthKey_<KEYID>.p8` file once, and note its Key ID and your Team ID. The bundle id is the app's
  (`ios.bundleIdentifier` in `apps/mobile/app.json`), and its App ID needs the Push
  Notifications capability. **One APNs environment per relay:** `"production": false` for
  development builds (the APNs sandbox), `true` for TestFlight and App Store builds, which are
  built with the expo-notifications plugin's `mode: 'production'` (`TREK_APNS_MODE=production`,
  `apps/mobile/README.md`). A relay can't serve both kinds of build; run two if you need both.
- **FCM (Android):** in the Firebase project the Android app (package `app.gettrek.mobile`) is
  registered in, with the Firebase Cloud Messaging API (V1) enabled, create a service account key
  (Project settings → Service accounts → Generate new private key). That JSON file is
  `serviceAccountPath`. The app's build needs the same project's `google-services.json`
  (`apps/mobile/README.md`).

Keep both files owned by, and readable only by, the relay's user (`chmod 600`). The relay
refuses to start if they, or its config, belong to another user or can be read by group or
others. It makes `dataDir` mode 0700 if it has to create it.

**When APNs refuses the setup.** `DeviceTokenNotForTopic`, `BadTopic`, `TopicDisallowed` and the
environment errors mean the relay's `apns.bundleId` or `apns.production` doesn't match the build
(a development build's token works only with `"production": false`, a TestFlight or App Store
build's only with `true`). So does `BadDeviceToken` for a token that has never had a push
delivered: that is almost always a build/relay environment mismatch, a config error, not a dead
token. The relay logs these as `APNS CONFIG ERROR`, naming both settings, answers the server
`422`, and keeps the device: fix the config and restart. `BadDeviceToken` for a token that has
had a push delivered, and APNs' `410`, mean the token is gone.

## Configure and run

```json
{
  "dataDir": "/var/lib/trek-relay",
  "host": "127.0.0.1",
  "port": 7346,
  "apns": {
    "keyId": "ABC123DEFG",
    "teamId": "TEAM123456",
    "bundleId": "app.gettrek.mobile",
    "keyPath": "/etc/trek-relay/AuthKey_ABC123DEFG.p8",
    "production": false
  },
  "fcm": { "serviceAccountPath": "/etc/trek-relay/firebase-service-account.json" },
  "trustProxy": true,
  "registrationKey": "a-long-random-string-baked-into-your-build",
  "maxDevices": 10000
}
```

- `trustProxy` (default `false`): the relay is behind a proxy that appends the client's address
  to `X-Forwarded-For` (Caddy does), and the per-address registration limit reads that header's
  **last** hop, the one the proxy added. Only set it when the relay's port can't be reached but
  through the proxy (it listens on `127.0.0.1` by default): otherwise a client can name any
  address it likes.
- `registrationKey` (optional, 16–256 characters): `POST /v1/devices` then needs the header
  `x-trek-relay-key: <key>` (compared in constant time), so only your build can register. Bake it
  into the build as `expo.extra.relayKey` in `apps/mobile/app.json`, next to `relayUrl` (or
  `TREK_RELAY_KEY` when building); the phone sends it. Anyone with the app binary can read it, so it keeps out strangers who found the
  relay's address, not a determined attacker.
- `maxDevices` (default 10,000): beyond it, registration answers `503`.

```bash
cd relay && npm ci && npm run build
chmod 600 /etc/trek-relay/relay.json
node dist/trek-relay.cjs start --config /etc/trek-relay/relay.json
# or: npm start -- --config /etc/trek-relay/relay.json (runs the same built file)
```

Relative paths in the config resolve against the config file's directory. `--host` and `--port`
override the config's. The relay listens on plain HTTP: put it behind a TLS proxy, as you do
trek-server. Servers only accept an `https://` relay address (or `http://` on their own machine).

```caddyfile
push.example.com {
  reverse_proxy 127.0.0.1:7346
}
```

Caddy's `reverse_proxy` appends the client's address to `X-Forwarded-For`: set `"trustProxy":
true` so the relay limits registrations per client rather than treating every phone as Caddy's
`127.0.0.1` (which would let ten registrations a minute, from anyone, lock out everyone).

Then build the phone app with that address: set `expo.extra.relayUrl` in `apps/mobile/app.json`
(for example `"https://push.example.com"`), or `TREK_RELAY_URL`, before building. The phone, like
the servers, takes only an `https://` address. A build without it shows no push
settings and registers nothing.

## What it stores

`<dataDir>/relay.json` (mode 0600, in a 0700 directory): each phone's push token and platform,
whether it paused its pushes, and its grants (one per paired server, labelled with the server's
name). The phone's device secret and every grant's secret are kept only as sha256 hashes. A change
that issues or revokes a secret is written (then renamed into place) before the relay answers, and
so is a token's first delivery (it decides whether `BadDeviceToken` means gone); bookkeeping (a
grant's last push) is written within a second, and on a clean shutdown, so a crash loses at most
that. A device whose token APNs or FCM reports as gone
is marked dead: its grants answer `410` to servers, and its own grant calls `410 {"error":
"device-dead"}`, until the phone sends its token again. A device dead for 30 days is removed with
its grants, and so is a device with no grant for 7 days (registered and never granted, or every
grant revoked) (both checked at start and daily). The relay logs the kind, the grant id and the push
service's answer, never a push's words, tokens or secrets.

**A reinstalled app** loses its device secret, but the phone's push token often stays the same.
Registering a (platform, token) the relay already has replaces that device: the old one and its
grants are removed (its servers' next push answers `410` and they drop the grant; the phone grants
again). Registration's limits (and the registration key, when set) apply as usual. **Note:**
anyone who knows a phone's push token (and the registration key, when set) can register it and so
evict that phone's device. That is denial of service only: the new registration's secret pushes
to the phone's token but can't read or manage the old device's grants, and the phone recovers on
its next check (its device calls answer `401`, so it registers again and re-grants its servers).

## API

JSON over `/v1`, bodies at most 16 KiB (a larger `Content-Length` is answered `413` before the
body is read; a body that streams past it is answered `413` and the connection closed). The
phone's calls carry its device secret, a server's its grant secret, each as `Authorization:
Bearer <secret>`.

| Call | Who | Body | Answer |
|---|---|---|---|
| `POST /v1/devices` | phone | `{platform: 'ios'\|'android', pushToken}`; header `x-trek-relay-key` when the relay has a `registrationKey` | `201 {deviceId, deviceSecret}` (replacing a device with the same token); `401` no or wrong key; `429` limited; `503` the relay is full |
| `PUT /v1/devices/:id` | phone | `{pushToken?, paused?: boolean}` (at least one) | `200 {updated: true, paused}`. A `pushToken`, new or the same, revives a dead device |
| `DELETE /v1/devices/:id` | phone | | `200` (the device and its grants) |
| `POST /v1/grants` | phone | `{label}` (up to 80 characters) | `201 {grantId, grantSecret}`; `410 {error: 'device-dead'}`; `429` (10 a minute per device); `409` 50 grants already |
| `GET /v1/grants` | phone | | `200 [{grantId, label, createdAt, lastPushAt}]`; `410 {error: 'device-dead'}` |
| `DELETE /v1/grants/:id` | phone | | `200` |
| `POST /v1/push` | server | `{kind, project, data: {serverId, projectId, worktreeId?, sessionId?}}` | `202 {accepted: true}` sent, or `{accepted: true, paused: true}` dropped (the phone paused); `401` unknown grant; `410` the device is gone; `422` the push service refused this push (not worth retrying); `429` limited; `503` with `Retry-After: 30` the push service is unavailable, limiting or timed out |
| `GET /v1/health` | anyone | | `200 {ok: true}` |

**The phone's side.** On each launch (and each registration check), the phone sends its current
push token with `PUT /v1/devices/:id`, even when it hasn't changed: that brings a device marked
dead back. A `410 {error: 'device-dead'}` from the grant calls means the same: send the token,
then retry (the phone does, once). A `401` to a device call means the relay no longer knows the
device: the phone forgets it and registers again. Every phone call gives up after 10 s. "Pause
all pushes" is `PUT /v1/devices/:id {paused: true}`, and resuming `{paused: false}` (the phone
sends its state with the token on every check): the relay holds it for every server, reachable or
not, both ways, because the phone tells its servers `paused: false` while the relay holds it. Only
while the relay can't be told does the phone pause its connected servers instead, until it can.

**What reaches the phone.** On iOS the notification is
`{aps: {alert: {title, body}, sound: 'default'}, body: {kind, serverId, projectId, worktreeId?, sessionId?}}`
(expo-notifications gives an app `userInfo.body` as the notification's data), with
`apns-collapse-id: <serverId>:<projectId>:<kind>` (its sha256 when over 64 bytes), so a newer
push of the same kind replaces the older one, and an hour's `apns-expiration`. On Android the FCM
message has `notification: {title, body}`, `data` with the same string keys
(`kind, serverId, projectId, worktreeId?, sessionId?`) and `android: {priority: 'high',
collapse_key, notification: {channel_id: 'default', tag}}` (the channel the app creates), the tag
and `collapse_key` being the same collapse id as on iOS, so a newer push of a kind for a project
replaces the older one there too.

**Retry-After.** The relay always answers a `503` with `Retry-After: 30`. A server retries 3
times honouring it, so a provider outage delays a push by up to about 90 seconds before the server
records it as failed.

Limits: 10 registrations a minute per address; 10 grants a minute per device; 30 pushes a minute
per grant and 120 an hour per device (a push refused by one limit counts against neither); 50
grants per device; `maxDevices` devices.

**The APNs connection.** One HTTP/2 session, closed after two minutes without a push and never
reused past that; a push with no answer in 10 seconds destroys it, so the next push reconnects.

## Testing

`npm test` at the repo root runs the relay's tests (`scripts/relay*.test.mjs`) against local stubs
of APNs, Google's token endpoint and FCM. `npm run smoke:push` runs a relay, a trek-server and a
phone played by the SDK, with a local APNs stub. The config's `apnsHost`, `fcmHost` and
`oauthHost` exist only for those stubs: leave them out in a real config.
