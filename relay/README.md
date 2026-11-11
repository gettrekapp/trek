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
  (`ios.bundleIdentifier` in `apps/mobile/app.json`). Use `"production": false` for development
  builds (the APNs sandbox) and `true` for TestFlight and App Store builds.
- **FCM (Android):** in the Firebase project the Android app is registered in, create a service
  account key (Project settings → Service accounts → Generate new private key). That JSON file is
  `serviceAccountPath`.

Keep both files readable only by the relay's user (`chmod 600`). The relay refuses to start if
they, or its config, can be read by group or others.

## Configure and run

```json
{
  "dataDir": "/var/lib/trek-relay",
  "host": "127.0.0.1",
  "port": 7346,
  "apns": {
    "keyId": "ABC123DEFG",
    "teamId": "TEAM123456",
    "bundleId": "dev.trek.mobile",
    "keyPath": "/etc/trek-relay/AuthKey_ABC123DEFG.p8",
    "production": false
  },
  "fcm": { "serviceAccountPath": "/etc/trek-relay/firebase-service-account.json" }
}
```

```bash
cd relay && npm ci && npm run build
chmod 600 /etc/trek-relay/relay.json
node dist/trek-relay.cjs start --config /etc/trek-relay/relay.json
```

Relative paths in the config resolve against the config file's directory. `--host` and `--port`
override the config's. The relay listens on plain HTTP: put it behind a TLS proxy, as you do
trek-server. Servers only accept an `https://` relay address (or `http://` on their own machine).

```caddyfile
push.example.com {
  reverse_proxy 127.0.0.1:7346
}
```

Then build the phone app with that address: set `expo.extra.relayUrl` in `apps/mobile/app.json`
(for example `"https://push.example.com"`) before building. A build without it shows no push
settings and registers nothing.

## What it stores

`<dataDir>/relay.json` (mode 0600): each phone's push token and platform, and its grants (one per
paired server, labelled with the server's name). The phone's device secret and every grant's
secret are kept only as sha256 hashes. A device whose token APNs or FCM reports as gone is marked
dead: its grants answer `410` until the phone sends a new token. The relay logs the kind, the
grant id and the push service's answer, never a push's words, tokens or secrets.

## API

JSON over `/v1`, bodies at most 16 KiB. The phone's calls carry its device secret, a server's its
grant secret, each as `Authorization: Bearer <secret>`.

| Call | Who | Body | Answer |
|---|---|---|---|
| `POST /v1/devices` | phone | `{platform: 'ios'\|'android', pushToken}` | `201 {deviceId, deviceSecret}` |
| `PUT /v1/devices/:id` | phone | `{pushToken}` | `200` (a rotated token; revives a dead device) |
| `DELETE /v1/devices/:id` | phone | | `200` (the device and its grants) |
| `POST /v1/grants` | phone | `{label}` (up to 80 characters) | `201 {grantId, grantSecret}` |
| `GET /v1/grants` | phone | | `200 [{grantId, label, createdAt, lastPushAt}]` |
| `DELETE /v1/grants/:id` | phone | | `200` |
| `POST /v1/push` | server | `{kind, project, data: {serverId, projectId, worktreeId?, sessionId?}}` | `202`; `401` unknown grant; `410` the device is gone; `429` limited; `502` the push service refused |
| `GET /v1/health` | anyone | | `200 {ok: true}` |

Limits: 10 registrations a minute per address; 30 pushes a minute per grant and 120 an hour per
device; 50 grants per device.

## Testing

`npm test` at the repo root runs the relay's tests (`scripts/relay*.test.mjs`) against local stubs
of APNs, Google's token endpoint and FCM. `npm run smoke:push` runs a relay, a trek-server and a
phone played by the SDK, with a local APNs stub. The config's `apnsHost`, `fcmHost` and
`oauthHost` exist only for those stubs: leave them out in a real config.
