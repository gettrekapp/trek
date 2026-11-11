# Trek phone companion (`apps/mobile`)

Phase 6a. An Expo app (SDK 58, Expo Router) for iOS and Android: what needs you on every
paired trek-server, sessions and their terminals, prompts, decisions and read-only
Changes. The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone
pairing") how it signs in.

It talks protocol v2 through the repo's own shared code: `src/shared.ts` re-exports
`../../src/shared/client`, `model` and `protocolV2`, which Metro watches
(`metro.config.js`). That code must stay free of Node, Electron, DOM and packages:
`scripts/sharedForMobile.test.mjs` (in the root's `npm test`) checks it.

## Install

The app has its own `package.json` and lockfile; the repo root's `npm install` doesn't
touch it.

```bash
cd apps/mobile
npm install            # also builds the terminal page (postinstall)
npm run typecheck
npm run export         # JS bundles for iOS and Android into dist/ (no device needed)
```

`postinstall`, `typecheck` and `export` first run `scripts/build-terminal.mjs`, which writes
`src/terminal/terminalHtml.generated.ts` (gitignored): the session screen's WebView page,
xterm.js and `src/terminal/page.js` inlined into one HTML string whose CSP allows nothing
from outside it.

The app's pure modules (`src/logic/`) are tested from the repo root
(`scripts/mobileLogic.test.mjs`, part of `npm test`).

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
2. **Attention:**
   - A session that rings the bell or finishes is listed with its project and age, newest first.
   - A `request_decision` shows its question. **Send answer** types it into the session; **Dismiss** clears it.
3. **Projects:**
   - The server's projects, repositories and worktrees, with their branches and sessions' states.
   - **Load** / **Unload** follow on the desktop.
4. **Sessions:**
   - **New session** with the default agent, another agent, and a session type.
   - **Restart** and **Close** (Close asks first).
5. **Terminal:**
   - The scrollback, then live output, in colour, at the desktop's width (the font shrinks).
   - Tap and type. Each key-bar key does what its label says.
   - **Send** types the prompt now. **Queue** adds it to the queue below, where **Remove** takes it out.
6. **Changes:** files with their status and counts. Tapping one shows its patch: additions green, deletions red.
7. **Promote:**
   - With the project open, an agent's `promote_to_primary` shows the confirmation. **Promote** moves the branch into the main checkout, and the desktop's dialog closes.
   - With the worktree's stack running, the phone says to confirm on the desktop.
8. **Background:**
   - Send the app to the background. A session needing you within ~20 s gives a notification.
   - Back in the foreground, everything reconnects.
9. **Revocation:** `trek-server token revoke phone-<name>`. The server shows **Pair again**.

No real push services (APNs, FCM, Expo) are used: background push is 6b.
