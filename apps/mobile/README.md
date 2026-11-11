# Trek phone companion (`apps/mobile`)

Phase 6a (and 6b's background push). An Expo app (SDK 58, Expo Router) for iOS and
Android: what needs you on every paired trek-server, sessions and their terminals,
prompts, decisions and read-only Changes, and pushes while it is closed. The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone
pairing") how it signs in.

It talks protocol v2 through the repo's own shared code: `src/shared.ts` re-exports
`../../src/shared/client`, `model` and `protocolV2`, which Metro watches
(`metro.config.js`). That code must stay free of Node, Electron, DOM and packages:
`scripts/sharedForMobile.test.mjs` (in the root's `npm test`) checks it.

## The terminal

The session screen's terminal is xterm.js in a WebView at the pty's own size: the phone
**never resizes a pty** (it's shared with the desktop's view). It follows the size the
pty has: the attach's (and a re-attach's) answer, and `pty.resized` when the desktop's
window changes it. Output is held until the size is known, so the scrollback is drawn at
the right width. The font shrinks to fit the width (down to 6 px; past that the page
scrolls sideways). Links in the output (OSC 8) are never opened, and the WebView refuses
every navigation and new window. Everything the terminal sends goes to the server, xterm's
own query replies (cursor position, device attributes, colours) included: the server writes
those to the program from one attached client per pty, the earliest attached (PROTOCOL.md,
"Query replies and the reply owner"), so the phone answers when it's the only one watching
and stays quiet when the desktop was there first. If the WebView's content process dies
(iOS) or its renderer goes (Android), the page is loaded again and the stream starts over.

**Restart** passes the size the phone last saw the session's pty at, remembered for this
run of the app only; if it never saw that pty (the app was started since, or the session
was never opened on the phone) it restarts at **80×24**, as `session.restart` needs a size.
The desktop's window resizes it to its own size as soon as it attaches.

## Plain ws:// on Android

`ws://` (to a private address only: `src/logic/serverUrl.ts`) needs cleartext traffic,
which Android release builds refuse by default. `app.json` turns it on through
`expo-build-properties` (`android.usesCleartextTraffic`); the app's own address rule is
what keeps plain `ws://` to a LAN, Tailscale or `.local` address. (iOS isn't checked on a
device yet: App Transport Security may want `NSAllowsLocalNetworking` for a `.local`
name). iOS asks for local network access the first time, with the reason in `app.json`'s
`ios.infoPlist.NSLocalNetworkUsageDescription`.

## Install

The app has its own `package.json` and lockfile; the repo root's `npm install` doesn't
touch it.

```bash
cd apps/mobile
npm ci                 # also builds the terminal page (postinstall)
npm run typecheck
npm run export         # JS bundles for iOS and Android into dist/ (no device needed)
```

`postinstall`, `typecheck` and `export` first run `scripts/build-terminal.mjs`, which writes
`src/terminal/terminalHtml.generated.ts` (gitignored): the session screen's WebView page,
xterm.js and `src/terminal/page.js` inlined into one HTML string whose CSP allows nothing
from outside it.

The app's pure modules (`src/logic/`) are tested from the repo root
(`scripts/mobileLogic.test.mjs`, part of `npm test`).

## Push (6b)

Background push goes through your own push relay (`relay/README.md`), which holds the APNs
key and the FCM service account for this app's bundle id / package. Set its address (and its
registration key, if the relay has one) in `app.json` before building:

```json
{ "expo": { "extra": { "relayUrl": "https://push.example.com", "relayKey": "" } } }
```

or from the environment, which `app.config.js` prefers over `app.json`: `TREK_RELAY_URL`,
`TREK_RELAY_KEY`. It must be `https://`: servers accept plain `http://` only on their own
machine, which a phone's relay never is. Empty (the default) or anything else: no push
settings, nothing registered.

With a relay and notification permission, the app registers its native push token (APNs or
FCM, not an Expo push token) with the relay as soon as permission is granted (no restart), and
on every launch and return to the foreground sends the current token again (which brings back
a device the relay marked dead) along with **Pause all pushes**. A relay that no longer knows
the device gets a new registration. For each paired server whose welcome lists `push`, it
takes a grant from the relay and hands it to the server (`push.setGrant`); a grant from another
relay or registration, or one the server says the relay refused, is replaced. Servers →
**Push…** has the server's three switches (Decisions, Sessions, PR watch), saved to the server
at once. **Pause all pushes** is held at the relay for this device, so pausing and resuming
both cover servers out of reach too: the servers are told `paused: false` while the relay holds
it. Only while the relay can't be told does the phone hand the pause to each connected server
instead (a fallback, undone once the relay holds it); the Servers screen says when the relay
couldn't be told. Removing a server clears its grant there and revokes it at the relay (not
waited on). Every relay call gives up after 10 s. The device secret and each grant's secret
are kept in secure storage. A tapped push opens its session (or worktree), like a local
notification, also from a cold start.

**Android: `google-services.json`.** FCM needs the Firebase project's `google-services.json`
in the build. It is optional and git-ignored: put it at `apps/mobile/google-services.json`, or
point `GOOGLE_SERVICES_JSON` at it. `app.config.js` sets `android.googleServicesFile` only when
the file exists. For EAS, upload it as a secret **file** environment variable named
`GOOGLE_SERVICES_JSON` (EAS gives the build its path). The Android app (package
`dev.trek.mobile`, `android.package`) must be registered in the same Firebase project as the
relay's service account. Without the file the build has no FCM token: the app shows "This build
has no push config (Android: google-services.json)" and registers nothing (iOS is unaffected).

**iOS: the APNs environment.** A development build gets sandbox tokens; TestFlight and App
Store builds production ones. Build those with `TREK_APNS_MODE=production` (the
expo-notifications plugin's `mode: 'production'`, the `aps-environment` entitlement), and use a
relay with `"production": true` for them: one APNs environment per relay.

APNs and FCM only deliver to a real build: a development build on a device (EAS or
`npx expo run:ios --device`) with the push entitlement, or an Android device built with the
app's `google-services.json`. The simulator gets no remote pushes.

## Run it

The camera, secure storage, notifications and the WebView are native modules, so the app
runs in a development build, not Expo Go:

```bash
npx expo run:ios       # builds and runs on the iOS simulator (Xcode needed)
npx expo run:android   # or an Android emulator
```

Nothing in the repo's checks runs these: they need Xcode or the Android SDK, and a device
or simulator.

## Manual checklist (iOS simulator)

Against a trek-server reachable from the simulator. The simulator shares the Mac's
network, so a server on this Mac at a LAN address works, with a warning for `ws://`.

1. **Pairing:** on the desktop, open **Open on server…** and choose **Pair a phone…** for
   the server.
   - The phone's **Add server**: type the address and the code, and keep the phone name. **Pair**.
   - The server is listed as Connected. `trek-server token list` shows `phone-<name>`.
   - The same code again: "already used". After 5 minutes: "expired".
   - Opening `trek://pair?url=…&code=…` in Safari opens Add server filled in, without pairing.
     With the app closed first, too; Back from there goes to Attention.
   - Scanning a QR that isn't a pairing code says "Not a Trek pairing code".
   - With camera access denied (Settings → Trek → Camera off), Add server offers Open Settings.
2. **Attention:**
   - A session that rings the bell or finishes is listed with its project and age, newest first.
   - A `request_decision` shows its question. **Send answer** types it into the session; **Dismiss** clears it.
     With the keyboard up, one tap on **Send answer** sends it.
3. **Projects:**
   - The server's projects, repositories and worktrees, with their branches and sessions' states.
   - **Load** / **Unload** follow on the desktop.
4. **Sessions:**
   - **New session** with the default agent, another agent, and a session type.
   - **Restart** and **Close** (Close asks first).
5. **Terminal:**
   - The scrollback, then live output, in colour, at the desktop's width (the font shrinks).
     The scrollback isn't wrapped at 80 columns first.
   - Resize the desktop's window: the phone's terminal follows (`pty.resized`); the phone
     never changes the desktop's size.
   - Touch-scroll the scrollback up and back down (and sideways at a wide size).
   - Tap and type. Each key-bar key does what its label says.
   - `printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'` in the session: tapping
     "link" opens nothing.
   - With the keyboard up, the prompt box stays above it, below the header.
   - **Send** types the prompt now. **Queue** adds it to the queue below, where **Remove** takes it out.
6. **Changes:** files with their status and counts. Tapping one shows its patch: additions green, deletions red.
7. **Promote:**
   - With the project open, an agent's `promote_to_primary` shows the confirmation. **Promote** moves the branch into the main checkout, and the desktop's dialog closes.
   - With the worktree's stack running, the phone says to confirm on the desktop.
8. **Background:**
   - Send the app to the background. A session needing you within ~20 s gives a notification;
     a decision's says "A decision is waiting in <project>", not its question.
   - Tapping the notification opens that session (also with the app closed since).
   - What was already waiting when the app connected gives no notification.
   - Back in the foreground, everything reconnects.
9. **Revocation:** `trek-server token revoke phone-<name>`. The server shows **Pair again**.
   Pairing again from there replaces the entry: the server is listed once.

10. **Push (6b), on a real device only** (a development build with the push entitlement, a
    relay configured as in `relay/README.md`, its address in `extra.relayUrl` or
    `TREK_RELAY_URL`):
    - First launch of a fresh install: allow notifications when asked. Without restarting, the
      relay's `relay.json` lists the device and Servers shows **Push…** for the server.
    - Android: a build without `google-services.json` shows "This build has no push config
      (Android: google-services.json)"; with it, the device registers.
    - Close the app. A `request_decision` gives a push "Trek · <project>" / "A decision is
      waiting", without the question. Tapping it opens that session.
    - Kill the app (swipe it away), then tap a push: the app starts on that session. Check
      on iOS and on Android.
    - iOS: close the app and wait about a minute (iOS suspends it, its connection drops
      silently), then raise a decision: a push arrives for it.
    - A session that exits by itself gives "A session stopped".
    - Push… → Decisions off: the next decision gives nothing; Sessions still do.
    - **Pause all pushes**: nothing from any server; off again: pushes return.
    - **Pause all pushes** with a server out of reach (its machine asleep or off the network):
      once it is back, it still pushes nothing while paused (the relay holds the pause).
      With the relay out of reach, the Servers screen says it wasn't told.
    - With the app open on that server, nothing is pushed (the list shows it).
    - Remove the server: the relay's grant is gone (`GET /v1/grants` no longer lists it);
      with the relay out of reach, the server is still removed at once.
    - `trek-server token revoke phone-<name>`: the server drops the grant; no more pushes.

The repo's checks use no real push service (APNs, FCM, Expo): `npm run smoke:push` runs
against a local APNs stub.
