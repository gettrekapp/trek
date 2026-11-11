# Phase 6a: the Trek phone companion, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone app (iOS and Android) that pairs with a trek-server through a one-time code shown by the desktop app, then lists what needs the user across every paired server and drives sessions: terminals, prompts, decisions, read-only Changes.

**Architecture:**
- **Server:** gains phone pairing (`pairing.create`, and a `pairingCode` redeemed at `hello` for a minted named token).
- **Desktop:** gains **Pair a phone…**, a QR of a one-time code (never a token).
- **App:** `apps/mobile` is a new Expo app with its own `package.json`. It imports the repo's protocol code (`src/shared/client`, `model`, `protocolV2`) straight from source through Metro; a test keeps that code free of Node, Electron, DOM and packages.
- **Terminal:** xterm.js in a WebView, running a bundled, network-less page.

**Tech Stack:** TypeScript, trek-server (Node, `ws`), Electron and React (desktop), Expo SDK 58 (React Native 0.88, Expo Router, expo-secure-store, expo-camera, expo-notifications, react-native-webview), xterm.js 6, `qrcode` (desktop QR), `node --test`, Playwright `_electron` (smoke).

**Spec:** `docs/superpowers/specs/2026-11-11-phase6a-mobile-companion-design.md` (approved 2026-11-11).
**Prototype:** branch `central-server-phase6a-proto`, one commit per task (Tasks 1–9); this plan's diffs are those commits.

---

## User decisions (2026-11-11, from the spec)

1. **Purpose:** a phone companion: attention, terminals, prompts, sessions, decisions. It is not the desktop window shrunk.
2. **Toolchain:** Expo (managed, with dev builds), iOS and Android, in `apps/mobile`.
3. **Terminal:** xterm.js in a WebView fed by the pty stream, plus a key bar and a prompt box, with direct typing too.
4. **Pairing:** the desktop shows a QR carrying a short-lived, one-time pairing code (not a token) that any signed-in client can ask a server for. The phone redeems it once for its own named token. Manual entry is the fallback.
5. **Beyond attention, terminals and prompts:** start, close and restart sessions; load and unload worktrees; answer decisions; read-only Changes. Not creating worktrees.
6. **Background push:** through a Trek push relay the user hosts, in 6b. 6a has local notifications only.
7. **Shared code:** the app imports `src/shared/client`, `src/shared/model` and `src/shared/protocolV2` directly (no `packages/client` extraction).
8. **Split:** 6a (the app and pairing), then 6b (the relay and server push).

## Decisions made in this plan

1. **Token name `phone-<device>`.** Token names allow only letters, digits, `.`, `_` and `-` (`tokens.ts` `NAME_RE`), so the spec's "phone: <device>" can't be stored. The device name is mapped to those characters and cut to fit 64, and `-2`, `-3`… are added when taken. The spec is updated to match.
2. **The code:**
   - **Format:** 128 random bits as 26 base32 characters (RFC 4648 alphabet). Case, spaces and dashes are ignored on the way back, so the desktop shows it in groups of five.
   - **Storage:** kept as a sha256 in memory, redeemable once, for 5 minutes. At most 20 wait at once; a 21st drops the oldest.
   - **Refusal reasons:** spent and expired codes are remembered (hash only) for 30 minutes, so a refusal can say which.
3. **Refusals close `4003`** after the usual bad-token delay, with the reason in plain words:
   - `pairing code expired`
   - `pairing code already used`
   - `pairing code not recognised`
   - `too many pairing attempts`

   The SDK maps them to `PairingError.kind`.
4. **Rate limits:** failed redeems count against the web sign-in's limiter (5 a minute per address, 50 in all). When the web client is on, the two share one limiter; otherwise pairing has its own instance.
5. **The local server never pairs.** It doesn't list `pairing`, `pairing.create` answers `NOT_FOUND`, and a `pairingCode` hello is refused as unknown. A phone can't reach this machine's loopback.
6. **Desktop side:**
   - **Where the code comes from:** main asks over its own connection (`appServers:pairPhone`). It refuses the Local entry, a loopback URL (`isLoopbackUrl`: `localhost`, `127.0.0.1`, `::1`), a server that isn't connected, and one without `pairing`.
   - **What the window gets:** `{url, code, expiresAt, link}`. The URL is the one the app itself uses for that server.
   - **The QR:** drawn as SVG squares from `qrcode`'s module matrix, with no data URL and no innerHTML. `qrcode` is a devDependency, since the renderer bundles it.
7. **Where the button lives:** in `ConnectServer`'s row actions, beside Test, shown by `canPairPhone(server)`: connected, not Local, not loopback, and `pairing` listed.
8. **The smoke's address:** `smoke:server-pairing` saves the server as `ws://[::ffff:127.0.0.1]:<port>`. That reaches the loopback listener without being one of the loopback names the button hides for.
9. **The shared-code guard** (`scripts/sharedForMobile.test.mjs`):
   - **What it walks:** the import graph from `MOBILE_ENTRIES`, kept equal to what `apps/mobile/src/shared.ts` imports, which a second test checks.
   - **What fails it:** `node:*` or a Node built-in, `electron`, any package, or a DOM global used as a value.
   - **Result:** the shared code passes as it is. React Native's WebSocket has the WHATWG `addEventListener` surface `socket.ts` uses, so no shared-code change was needed.
10. **`apps/mobile` has its own `package.json` and lockfile.** The root `postinstall` does not install it: about 530 packages that Electron work never needs. The root `npm test` still covers the app's pure modules (`apps/mobile/src/logic/*.ts`, no package imports).
11. **Dependency versions:**
    - **How they were installed:** with `npx expo install`, so they match SDK 58.
    - **`react-dom`:** pinned to the SDK's `19.3.0`, because Expo Router's web pieces pull in `react-dom` and an unpinned one wanted `react@19.3.1`.
    - **`@xterm/xterm`:** a devDependency, since it is inlined into the terminal page at build time.
12. **Navigation is a Stack only, no tabs** (`expo-router`'s `Tabs` is deprecated in SDK 58 in favour of `expo-router/js-tabs`). Attention is the home screen, with **Servers** and **Projects** in its header.
13. **Storage:** the server list (id, name, URL) and each token live in `expo-secure-store`, with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
    - The entry id is the server's `serverId` from the pairing welcome, or a random one for a manually added token.
    - Removing forgets the token on the phone only.
14. **Connections:** one `ServerRegistry` entry per server.
    - **Leaving the foreground:** connections are closed 20 s after the app leaves the foreground, and made again on return. A `generation` counter makes screens resubscribe.
    - **The attention topic:** subscribed for every server, feeding the home list.
    - **Local notifications:** only for items the app hasn't seen, and only while it is not in the foreground. The foreground list is visible; the first snapshot after a launch counts as seen.
15. **The phone never resizes the shared pty.** The terminal shows the pty at its own size (the desktop's), with the font fitted to the screen width (6–13 px) and sideways scrolling past that. Resizing would reflow every desktop view of the session (Question 2).
16. **The terminal page:**
    - **Build:** one HTML string, generated into `src/terminal/terminalHtml.generated.ts` (gitignored) by `scripts/build-terminal.mjs`, with xterm.js, its CSS and `page.js` inlined.
    - **CSP:** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:`. Inline is the only way to bundle a single page; `default-src 'none'` still blocks every fetch.
    - **The WebView:**
      - allows only `about:` loads;
      - no file access, DOM storage or extra windows;
      - the app talks to it through `injectJavaScript` with JSON payloads, and it answers through `ReactNativeWebView.postMessage`.
17. **A new session starts at 80×24.** A pty's size is the desktop's to set (Decision 15).
18. **A decision is answered** with `session.sendPrompt` (any input clears it, as on the desktop) or Dismiss (`session.dismissDecision`).
19. **`promote_to_primary` on the phone:**
    - **When it listens:** only while that project's screen is open (`promote.listen`, again on every welcome; `listen: false` on leaving).
    - **How it asks:** with an in-app `Modal`, because React Native's `Alert` can't be closed when another window claims the request.
    - **A refused dry run:** claimed and answered `failed` silently, as the desktop does.
    - **An unknown worktree:** answered `unknown-worktree`.
    - **A running dev stack** (`containers > 0` or `upRunning`) **or Docker VM** (`vmState: 'running'`): "Confirm on the desktop", and the phone neither claims nor answers.
20. **Changes** shows the default source (the branch against its base, with the uncommitted work). Each file's patch is fetched on tap with `worktree.diff {paths: [path]}`.
21. **The icons** are Expo's template placeholders; real artwork comes before any store build.

## Risks

1. **A photographed QR is a token.** Anyone who scans the code within its 5 minutes gets a shell-level token. Mitigations:
   - the code works once;
   - the token is named after the device and listed by `token list`;
   - it is revocable.
2. **A leaked token can mint durable ones.** `pairing.create` is open to any token, so a leaked one can mint more tokens that survive revoking it (Question 1).
3. **Hiding the button for loopback is a convenience, not a guard.** `[::ffff:127.0.0.1]` and `127.0.0.2` aren't recognised as loopback, so the button shows for them; a phone simply can't connect there. The smoke relies on this.
4. **Native behaviour is untested.** Nothing here ran on a simulator or device: the camera, secure storage, notifications, the WebView's keyboard and messaging, and the `KeyboardAvoidingView` offset. The prototype was checked by typecheck and `expo export` only. `apps/mobile/README.md` has the manual iOS simulator checklist.
5. **Large replays may be slow.** Each pty chunk is one `injectJavaScript` call, so a big scrollback replay may be slow on a phone. Batching chunks per animation frame is the follow-up if it is.
6. **The terminal is small on a phone.** It shows at the desktop's width, so on a narrow phone the font gets very small (Decision 15).
7. **`ws://` exposes the token.** It is allowed to private addresses (LAN, Tailscale, `.local`) with a warning. The paired token itself travels in the welcome, so pairing over plain `ws://` exposes it on that network.
8. **Notifications stop after the grace.** Nothing notifies once the 20 s background grace ends; that is 6b.
9. **Bundle size.** The terminal page adds about 490 KiB to the JS bundle.
10. **Expo SDK churn.** SDK 58 moves fast (the template warns of renamed APIs). The prototype relied on the installed types, not memory; an SDK upgrade is its own task.
11. **Promote confirmations need the project open.** With it closed, the phone doesn't show them (Decision 19; Question 3).

## Questions

The user answered all three on 2026-11-11, as recommended:
1. A token minted by pairing records `pairedBy: <the asking token's name>`, shown in `trek-server token list`; revocations never cascade. **Not yet in the prototype:** Task 1 gains it when the plan is executed (the token entry's new optional field, set at redeem, kept by config reload, printed by `token list`, documented in PROTOCOL.md and server/README.md, tested).
2. The phone never resizes a session's pty: it shows the desktop's width with a smaller font and sideways scroll.
3. The phone confirms `promote_to_primary` only for the project it has open.

None remain.

## File structure

**Server and shared**

| File | What changes |
|---|---|
| `server/src/pairing.ts` | new: `PairingCodes`, `newPairingCode`, `normalizePairingCode`, `phoneTokenName` |
| `server/src/server.ts` | the `pairingCode` hello, the limiter, `pairing` in the context |
| `server/src/v2.ts` | `pairing.create` |
| `server/src/capabilities.ts` | `pairing`, except on the local server |
| `server/scripts/smoke.mjs` | pairing checks |
| `src/shared/protocolV2.ts` | `HelloFrame.pairingCode` / `deviceName`, `WelcomeFrameV2.pairedToken` / `pairedTokenName`, `CAPABILITY.pairing`, `PAIRING_CLOSE_REASON`, `pairing.create` |
| `src/shared/client/pairing.ts` | new: `redeemPairingCode`, `PairingError`, `pairingFailureOf`, `parsePairingLink`, `pairingLink` |
| `src/shared/client/index.ts` | exports it |

**Desktop**

| File | What changes |
|---|---|
| `src/main/appServers.ts` | `appServers:pairPhone` |
| `src/preload/index.ts` | the `pairPhone` bridge |
| `src/web/webApi.ts` | a `pairPhone` refusal |
| `src/shared/types.ts` | `AppServerPairing` |
| `src/renderer/src/components/PairPhone.tsx` | new: the panel and the SVG QR |
| `src/renderer/src/components/ConnectServer.tsx` | the button, `canPairPhone` |
| `src/renderer/src/styles.css` | `.pair-phone*` |
| `package.json`, `package-lock.json` | `qrcode`, `@types/qrcode` (dev); `smoke:server-pairing` |

**Tests and smoke**

| File | What changes |
|---|---|
| `scripts/serverPairing.test.mjs` | new |
| `scripts/serverV2.test.mjs` | the capability list |
| `scripts/sharedForMobile.test.mjs` | new |
| `scripts/mobileLogic.test.mjs` | new |
| `scripts/server-pairing-smoke.mjs` | new |

**The app** (`apps/mobile/`, all new)

| File | What it is |
|---|---|
| `package.json`, `package-lock.json`, `app.json`, `tsconfig.json`, `metro.config.js`, `.gitignore`, `assets/` | the scaffold |
| `README.md` | install, run, the manual checklist |
| `scripts/build-terminal.mjs` | builds the terminal page |
| `src/shared.ts` | the shared-code re-exports |
| `src/logic/serverUrl.ts`, `attention.ts`, `keys.ts`, `diff.ts` | pure modules |
| `src/state/storage.ts` | secure storage |
| `src/state/ServersProvider.tsx` | the connections, attention, notifications |
| `src/state/hooks.ts` | `useTopic`, `useServer` |
| `src/terminal/page.js` | runs in the WebView |
| `src/ui/theme.ts`, `Button.tsx`, `status.ts` | UI pieces |
| `src/ui/DecisionActions.tsx` | the decision answer |
| `src/ui/PromotePrompt.tsx` | promote confirmations |

**The app's screens** (`apps/mobile/app/`)

| File | Screen |
|---|---|
| `_layout.tsx` | the Stack and the provider |
| `index.tsx` | Attention |
| `servers.tsx` | Servers |
| `add-server.tsx` | Add server |
| `pair.tsx` | the `trek://pair` link |
| `projects.tsx` | Projects |
| `project/[serverId]/[projectId].tsx` | a project |
| `worktree/[serverId]/[projectId]/[worktreeId].tsx` | a worktree |
| `changes/[serverId]/[projectId]/[worktreeId].tsx` | its Changes |
| `session/[serverId]/[projectId]/[sessionId].tsx` | a session |

**Docs:** `PROTOCOL.md` (Phone pairing, the capability, the handshake notes), `README.md` (Phone companion, the smoke), `server/README.md` (Phone pairing), and the spec (the token name).


## Prototype results (2026-11-11, `central-server-phase6a-proto` at Task 9)

| Check | Result |
|---|---|
| `npm run typecheck` (app) | clean |
| `cd server && npm run typecheck` | clean |
| `cd apps/mobile && npm run typecheck` | clean (the shared code typechecks under React Native's types) |
| `npm test` | 2008 pass, 0 fail, 1 skipped (master: 1991) |
| `npm run build` | passes |
| `cd apps/mobile && npm run export` (iOS and Android, Hermes) | passes, 3.7 MB each; the bundles carry the shared pairing code |
| `npm run smoke:server-pairing` (new) | SERVER PAIRING SMOKE PASS (17 checks) |
| `npm run smoke:v2` | 172 checks |
| `npm run smoke:local-window` | 57 checks |
| `cd server && npm run smoke -- --built` | SERVER SMOKE PASS, with its new pairing checks |

Not run: the iOS simulator, Android emulator, Xcode or EAS builds, and real push services. The app was not run on any device (Risk 4).


## Tasks

### Task 1: Phone pairing on the server

(Prototype commit `44a7f8d`.)

`pairing.create` and the redeem at `hello` (Decisions 1–5).

- [ ] **Step 1: the protocol's types.** Add these to `src/shared/protocolV2.ts`:
  - `HelloFrame.pairingCode` and `deviceName`;
  - `WelcomeFrameV2.pairedToken` and `pairedTokenName`;
  - `CAPABILITY.pairing`;
  - `PAIRING_CLOSE_REASON`;
  - `pairing.create` in the params and results maps.
- [ ] **Step 2: the failing tests.** Write `scripts/serverPairing.test.mjs` (codes, expiry, single use, the pending cap, `phoneTokenName`, the link, the SDK's redeem against `clientFakes`) and update `scripts/serverV2.test.mjs`'s capability list. Run `node --test scripts/serverPairing.test.mjs scripts/serverV2.test.mjs`: it fails, because nothing is implemented yet.
- [ ] **Step 3: the server code.** Write `server/src/pairing.ts`, then wire it in:
  - `pairing.create` in `server/src/v2.ts`;
  - the hello in `server/src/server.ts`;
  - the capability in `server/src/capabilities.ts` (not on the local server).
- [ ] **Step 4: the SDK.** Write `src/shared/client/pairing.ts` and export it from `index.ts`.
- [ ] **Step 5: the server smoke.** Add its pairing checks (`server/scripts/smoke.mjs`):
  - pairing is listed;
  - a typed-back code redeems once;
  - the paired token works and is listed;
  - "already used", "not recognised", and "too many pairing attempts" on the sixth failure;
  - revoking it closes the phone (`4003`).
- [ ] **Step 6: run.** `node --test scripts/serverPairing.test.mjs scripts/serverV2.test.mjs`, `cd server && npm run typecheck && npm run build && npm run smoke`. Expected: pass, SERVER SMOKE PASS.
- [ ] **Step 7: commit.**

```diff
diff --git a/scripts/serverPairing.test.mjs b/scripts/serverPairing.test.mjs
new file mode 100644
index 0000000..d0da043
--- /dev/null
+++ b/scripts/serverPairing.test.mjs
@@ -0,0 +1,112 @@
+// Phone pairing (6a): the server's one-time codes and the token name, and the client's redeem.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import {
+  MAX_PENDING_PAIRING_CODES,
+  PAIRING_CODE_TTL_MS,
+  PairingCodes,
+  newPairingCode,
+  normalizePairingCode,
+  phoneTokenName
+} from '../server/src/pairing.ts'
+import { pairingFailureOf, pairingLink, parsePairingLink, redeemPairingCode, PairingError } from '../src/shared/client/pairing.ts'
+import { fakeServer, fakeTimers } from './clientFakes.mjs'
+
+test('a code is 128 random bits as 26 base32 characters', () => {
+  assert.equal(newPairingCode(Buffer.alloc(16)), 'A'.repeat(26))
+  assert.equal(newPairingCode(Buffer.alloc(16, 0xff)), `${'7'.repeat(25)}4`)
+  assert.match(newPairingCode(), /^[A-Z2-7]{26}$/)
+  assert.notEqual(newPairingCode(), newPairingCode())
+})
+
+test('what a person types back: case, spaces and dashes are ignored', () => {
+  assert.equal(normalizePairingCode('abcde-fghij klmno'), 'ABCDEFGHIJKLMNO')
+})
+
+test('a code redeems once, before it expires, and says why it no longer does', () => {
+  const codes = new PairingCodes()
+  const { code, expiresAt } = codes.create('kitchen', 1000)
+  assert.equal(expiresAt, 1000 + PAIRING_CODE_TTL_MS)
+  assert.deepEqual(codes.redeem(code.toLowerCase(), 2000), { ok: true, name: 'kitchen' })
+  assert.deepEqual(codes.redeem(code, 2001), { ok: false, reason: 'used' })
+  const late = codes.create('', 0).code
+  assert.deepEqual(codes.redeem(late, PAIRING_CODE_TTL_MS), { ok: false, reason: 'expired' })
+  assert.deepEqual(codes.redeem('A'.repeat(26), 0), { ok: false, reason: 'unknown' })
+})
+
+test('at most 20 codes wait: one past that drops the oldest', () => {
+  const codes = new PairingCodes()
+  const made = Array.from({ length: MAX_PENDING_PAIRING_CODES + 1 }, (_, i) => codes.create(`n${i}`, i).code)
+  assert.equal(codes.size(100), MAX_PENDING_PAIRING_CODES)
+  assert.equal(codes.redeem(made[0], 100).ok, false)
+  assert.equal(codes.redeem(made[MAX_PENDING_PAIRING_CODES], 100).ok, true)
+})
+
+test('the phone token name: phone-<device> in token-name characters, numbered when taken', () => {
+  assert.equal(phoneTokenName('Greg’s iPhone 15', new Set()), 'phone-Greg-s-iPhone-15')
+  assert.equal(phoneTokenName('   ', new Set()), 'phone-device')
+  assert.equal(phoneTokenName('pixel', new Set(['phone-pixel'])), 'phone-pixel-2')
+  assert.equal(phoneTokenName('pixel', new Set(['phone-pixel', 'phone-pixel-2'])), 'phone-pixel-3')
+  const long = phoneTokenName('x'.repeat(200), new Set())
+  assert.ok(long.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(long))
+  const longTaken = phoneTokenName('x'.repeat(200), new Set([long]))
+  assert.ok(longTaken.length <= 64 && longTaken.endsWith('-2'))
+})
+
+test('the pairing link round-trips, and anything else is not a pairing link', () => {
+  const link = pairingLink('wss://dev.example.com', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
+  assert.deepEqual(parsePairingLink(link), { url: 'wss://dev.example.com', code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' })
+  assert.equal(parsePairingLink('https://dev.example.com/?code=x'), null)
+  assert.equal(parsePairingLink('trek://other?url=wss%3A%2F%2Fa&code=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), null)
+  assert.equal(parsePairingLink('trek://pair?url=https%3A%2F%2Fa&code=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), null)
+  assert.equal(parsePairingLink('trek://pair?url=wss%3A%2F%2Fa&code=short'), null)
+  assert.equal(parsePairingLink('trek://pair?url=wss%3A%2F%2Fa&code=%3Cscript%3E0123456789abcdef'), null)
+  assert.equal(parsePairingLink('not a url'), null)
+})
+
+test('redeem: sends the code with no token, and resolves with the welcome\'s token', async () => {
+  const server = fakeServer()
+  const { timers } = fakeTimers()
+  const done = redeemPairingCode({ url: 'wss://s', code: 'CODE', deviceName: 'pixel', createSocket: server.factory, timers })
+  const sock = server.last()
+  sock.open()
+  const hello = sock.sent[0]
+  assert.equal(hello.type, 'hello')
+  assert.equal(hello.pairingCode, 'CODE')
+  assert.equal(hello.deviceName, 'pixel')
+  assert.equal('token' in hello, false)
+  sock.welcome({ pairedToken: 'tok', pairedTokenName: 'phone-pixel' })
+  const result = await done
+  assert.deepEqual(result, { token: 'tok', tokenName: 'phone-pixel', serverId: 'sid', serverName: 'box', capabilities: ['mcp'] })
+  assert.deepEqual(sock.closedWith, { code: 1000, reason: 'paired' })
+})
+
+test('redeem: a refusal says which, from the close reason', async () => {
+  for (const [reason, kind] of [
+    ['pairing code expired', 'expired'],
+    ['pairing code already used', 'used'],
+    ['pairing code not recognised', 'unknown'],
+    ['too many pairing attempts', 'limited'],
+    ['unauthorized', 'refused']
+  ]) {
+    const server = fakeServer()
+    const { timers } = fakeTimers()
+    const done = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers })
+    server.last().open()
+    server.last().serverClose(4003, reason)
+    await assert.rejects(done, (err) => err instanceof PairingError && err.kind === kind)
+  }
+  assert.equal(pairingFailureOf(1006, ''), 'unreachable')
+})
+
+test('redeem: a welcome with no token (a server that ignored the code) is a refusal; no answer times out', async () => {
+  const server = fakeServer()
+  const { timers, advance } = fakeTimers()
+  const plain = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers })
+  server.last().open()
+  server.last().welcome()
+  await assert.rejects(plain, (err) => err.kind === 'refused')
+  const slow = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers, timeoutMs: 1000 })
+  advance(1000)
+  await assert.rejects(slow, (err) => err.kind === 'timeout')
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
index 304275e..b767cdc 100644
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -381,11 +381,11 @@ test('project.delete ends the project topic for its subscribers, before the serv
   assert.deepEqual(sent.map((m) => m.ended ? [m.topic, m.ended] : [m.topic, 'patch']), [[`project:${projectId}`, 'deleted'], ['server', 'patch']])
 })
 
-test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
+test('welcome capabilities: mcp while the listener is up, then what the server always has, pairing except on the local server, then local on the local server', () => {
   const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'review', 'move', 'promote']
-  assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
-  assert.deepEqual(welcomeCapabilities(false), all)
-  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
+  assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all, 'pairing'])
+  assert.deepEqual(welcomeCapabilities(false), [...all, 'pairing'])
+  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all, 'pairing'])
   assert.deepEqual(welcomeCapabilities(true, true), ['mcp', ...all, 'local'])
   assert.deepEqual(welcomeCapabilities(false, true), [...all, 'local'])
 })
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 02b4b0f..ae281ca 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -289,6 +289,59 @@ if (!snap.ok || !snap.result.snapshot.repos.some((r) => r.id === 'repo3')) {
 if (phone2.frames.some((f) => f.type === 'res' && f.id === 99)) fail('revoked socket got a response')
 checker.sock.close()
 
+// --- phone pairing (6a): a one-time code from pairing.create, redeemed once at hello for a named token ---
+const pairHello = async (code, deviceName) => {
+  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`)
+  const frames = []
+  sock.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
+  const closed = new Promise((r) => sock.on('close', (c, reason) => r({ code: c, reason: reason.toString() })))
+  await new Promise((r) => sock.on('open', r))
+  sock.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'smoke-phone', clientVersion: '0', pairingCode: code, deviceName }))
+  await waitFor(() => frames.length > 0, 3000)
+  return { sock, frames, closed }
+}
+{
+  const desk = await connect(2, token)
+  if (!desk.welcome?.capabilities.includes('pairing')) fail(`welcome lacks pairing: ${JSON.stringify(desk.welcome?.capabilities)}`)
+  else ok('the welcome lists pairing')
+  const created = await desk.req('pairing.create', { name: 'smoke' })
+  const code = created.result?.code
+  if (!created.ok || !/^[A-Z2-7]{26}$/.test(code ?? '') || !(created.result.expiresAt > Date.now())) fail(`pairing.create: ${JSON.stringify(created)}`)
+  else ok('pairing.create gives a 26-character base32 code that expires later')
+  // Typed back with lower case and dashes, as a person might.
+  const typed = code.toLowerCase().replace(/(.{5})/g, '$1-')
+  const redeem = await pairHello(typed, 'Smoke iPhone')
+  const welcome = redeem.frames.find((f) => f.type === 'welcome')
+  if (!welcome?.pairedToken || welcome.pairedTokenName !== 'phone-Smoke-iPhone') fail(`pairing redeem: ${JSON.stringify(redeem.frames)}`)
+  else ok('a redeemed code mints the phone\'s own token "phone-Smoke-iPhone", sent once in the welcome')
+  redeem.sock.close()
+  const tokenList = cli('token', 'list')
+  if (!/phone-Smoke-iPhone/.test(tokenList)) fail(`token list after pairing: ${tokenList}`)
+  else ok('the paired token is listed by `token list`')
+  const paired = await connect(2, welcome?.pairedToken)
+  if (paired.welcome?.protocolVersion !== 2 || paired.welcome.pairedToken !== undefined) fail(`paired token login: ${JSON.stringify(paired.frames)}`)
+  else ok('the paired token authenticates, and an ordinary welcome carries no token')
+  const again = await pairHello(code, 'Other')
+  const againClose = await raceTimeout(again.closed, 4000)
+  if (againClose.code !== 4003 || againClose.reason !== 'pairing code already used' || again.frames.length !== 0) fail(`reused code: ${JSON.stringify(againClose)} ${JSON.stringify(again.frames)}`)
+  else ok('a code redeems once: a second try closes 4003 "pairing code already used", with no frame')
+  for (let i = 0; i < 4; i++) {
+    const bad = await pairHello('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'x')
+    const badClose = await raceTimeout(bad.closed, 4000)
+    if (i === 0 && (badClose.code !== 4003 || badClose.reason !== 'pairing code not recognised')) fail(`unknown code: ${JSON.stringify(badClose)}`)
+    else if (i === 0) ok('an unknown code closes 4003 "pairing code not recognised"')
+  }
+  const limited = await pairHello('AAAAAAAAAAAAAAAAAAAAAAAAAA', 'x')
+  const limitedClose = await raceTimeout(limited.closed, 4000)
+  if (limitedClose.code !== 4003 || limitedClose.reason !== 'too many pairing attempts') fail(`pairing limit: ${JSON.stringify(limitedClose)}`)
+  else ok('five failed redeems from one address in a minute: the sixth closes "too many pairing attempts"')
+  cli('token', 'revoke', 'phone-Smoke-iPhone')
+  const pairedClosed = await raceTimeout(paired.closed, 4000)
+  if (pairedClosed !== 4003) fail(`revoked paired token: ${pairedClosed}`)
+  else ok('revoking the paired token closes the phone\'s connection (4003)')
+  desk.sock.close()
+}
+
 // Malformed frames close the socket with 1002 and do not crash the server.
 for (const bad of ['null', '"x"', '[]', JSON.stringify({ type: 'hello', protocolVersion: 2, token: 5 }),
   JSON.stringify({ type: 'hello', protocolVersion: '2', token: 'TOKEN' })]) {
diff --git a/server/src/capabilities.ts b/server/src/capabilities.ts
index 848a50f..b556d7b 100644
--- a/server/src/capabilities.ts
+++ b/server/src/capabilities.ts
@@ -28,13 +28,16 @@ export const STATIC_CAPABILITIES: readonly string[] = [
 ]
 
 /**
- * `mcp` while the MCP listener is up, then the features this server always has, then `prWatch`
- * while gh is signed in on its machine (5c-1), then `local` on the local server.
+ * `mcp` while the MCP listener is up, then the features this server always has, then `pairing`
+ * (6a: `pairing.create`, and a phone's `pairingCode` at hello) on any server but the local one (a
+ * phone can't reach this machine's loopback), then `prWatch` while gh is signed in on its machine
+ * (5c-1), then `local` on the local server.
  */
 export function welcomeCapabilities(mcp: boolean, local = false, prWatch = false): string[] {
   return [
     ...(mcp ? [CAPABILITY.mcp] : []),
     ...STATIC_CAPABILITIES,
+    ...(local ? [] : [CAPABILITY.pairing]),
     ...(prWatch ? [CAPABILITY.prWatch] : []),
     ...(local ? [CAPABILITY.local] : [])
   ]
diff --git a/server/src/pairing.ts b/server/src/pairing.ts
new file mode 100644
index 0000000..544e734
--- /dev/null
+++ b/server/src/pairing.ts
@@ -0,0 +1,123 @@
+// Phone pairing (6a): one-time codes a signed-in client asks for (`pairing.create`) and a phone
+// redeems once at hello for its own named token. Only each code's hash is kept, in memory: a
+// restart drops the pending codes. Spent and expired codes are remembered (hashes only) for a while,
+// so a second try can be told "already used" or "expired" instead of "unknown".
+import { createHash, randomBytes } from 'node:crypto'
+
+/** How long a code stays redeemable. */
+export const PAIRING_CODE_TTL_MS = 5 * 60_000
+/** At most this many codes wait at once; creating one past it drops the oldest. */
+export const MAX_PENDING_PAIRING_CODES = 20
+/** How long a spent or expired code is remembered, to say so. */
+const REMEMBER_MS = 30 * 60_000
+const REMEMBER_MAX = 200
+/** The longest device name kept (the token's name is built from it). */
+export const MAX_DEVICE_NAME = 60
+
+const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
+
+/** 128 random bits as 26 base32 characters (RFC 4648 alphabet, no padding). */
+export function newPairingCode(bytes: Buffer = randomBytes(16)): string {
+  let bits = 0
+  let value = 0
+  let out = ''
+  for (const byte of bytes) {
+    value = (value << 8) | byte
+    bits += 8
+    while (bits >= 5) {
+      out += BASE32[(value >>> (bits - 5)) & 31]
+      bits -= 5
+    }
+  }
+  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
+  return out
+}
+
+/** What a person types back: case, spaces and dashes don't matter. */
+export function normalizePairingCode(code: string): string {
+  return code.toUpperCase().replace(/[\s-]+/g, '')
+}
+
+const hashCode = (code: string): string => createHash('sha256').update(normalizePairingCode(code), 'utf8').digest('hex')
+
+export type RedeemOutcome = { ok: true; name: string } | { ok: false; reason: 'expired' | 'used' | 'unknown' }
+
+interface Pending {
+  expiresAt: number
+  /** The name the code was asked for with (a hint for the token's name); '' for none */
+  name: string
+}
+
+export class PairingCodes {
+  private readonly pending = new Map<string, Pending>()
+  /** Spent or expired: hash → why, and until when it is remembered */
+  private readonly spent = new Map<string, { reason: 'expired' | 'used'; until: number }>()
+
+  create(name: string, now: number): { code: string; expiresAt: number } {
+    this.sweep(now)
+    while (this.pending.size >= MAX_PENDING_PAIRING_CODES) {
+      const oldest = this.pending.keys().next().value as string
+      this.pending.delete(oldest)
+    }
+    const code = newPairingCode()
+    const expiresAt = now + PAIRING_CODE_TTL_MS
+    this.pending.set(hashCode(code), { expiresAt, name: name.slice(0, MAX_DEVICE_NAME) })
+    return { code, expiresAt }
+  }
+
+  /** Spends the code: true at most once per code. */
+  redeem(code: string, now: number): RedeemOutcome {
+    this.sweep(now)
+    const hash = hashCode(code)
+    const entry = this.pending.get(hash)
+    if (entry) {
+      this.pending.delete(hash)
+      this.remember(hash, 'used', now)
+      return { ok: true, name: entry.name }
+    }
+    const known = this.spent.get(hash)
+    return { ok: false, reason: known ? known.reason : 'unknown' }
+  }
+
+  /** How many codes wait now (tests, health). */
+  size(now: number): number {
+    this.sweep(now)
+    return this.pending.size
+  }
+
+  private sweep(now: number): void {
+    for (const [hash, entry] of this.pending) {
+      if (entry.expiresAt <= now) {
+        this.pending.delete(hash)
+        this.remember(hash, 'expired', now)
+      }
+    }
+    for (const [hash, s] of this.spent) if (s.until <= now) this.spent.delete(hash)
+  }
+
+  private remember(hash: string, reason: 'expired' | 'used', now: number): void {
+    this.spent.set(hash, { reason, until: now + REMEMBER_MS })
+    while (this.spent.size > REMEMBER_MAX) this.spent.delete(this.spent.keys().next().value as string)
+  }
+}
+
+const TOKEN_NAME_MAX = 64
+
+/**
+ * The phone's token name: `phone-<device>` with what token names allow (letters, digits, ".",
+ * "_", "-"), cut to fit, and `-2`, `-3`… added when the name is taken. ("phone: <device>" in the
+ * spec; token names can't hold ": " or spaces.)
+ */
+export function phoneTokenName(deviceName: string, taken: ReadonlySet<string>): string {
+  const cleaned = deviceName
+    .slice(0, MAX_DEVICE_NAME)
+    .replace(/[^A-Za-z0-9._-]+/g, '-')
+    .replace(/^[-._]+|[-._]+$/g, '')
+  const base = `phone-${cleaned || 'device'}`.slice(0, TOKEN_NAME_MAX)
+  if (!taken.has(base)) return base
+  for (let n = 2; ; n++) {
+    const suffix = `-${n}`
+    const name = `${base.slice(0, TOKEN_NAME_MAX - suffix.length)}${suffix}`
+    if (!taken.has(name)) return name
+  }
+}
diff --git a/server/src/server.ts b/server/src/server.ts
index 006d070..d72d003 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -5,6 +5,7 @@ import {
   CLOSE_REASON_UPGRADE_CLIENT,
   CLOSE_UNAUTHORIZED,
   CLOSE_UNSUPPORTED_VERSION,
+  PAIRING_CLOSE_REASON,
   PROTOCOL_VERSION_V2,
   SUPPORTED_PROTOCOL_VERSIONS,
   type IntegrationsChangedEvent,
@@ -18,7 +19,8 @@ import type { ConfigStore } from './configStore'
 import type { ProjectState } from './projects/state'
 import type { ProjectStore } from './projects/store'
 import { publishServerState } from './serverState'
-import { activeTokenHashes, listTokens, matchToken } from './tokens'
+import { activeTokenHashes, addToken, listTokens, matchToken } from './tokens'
+import { PairingCodes, phoneTokenName } from './pairing'
 import { TopicHub, type Subscriber } from './topicHub'
 import { dispatchV2, responseRev } from './v2'
 import { GitPoller } from './git/poller'
@@ -174,6 +176,10 @@ export function startServer(
     : undefined
   if (web) webSignIns = new WebSocketSignIns(web.sessions, (ws) => closeRevoked(ws, 'signed out'))
   const signedOut = (key: string): void => webSignIns?.signedOut(key)
+  // Phone pairing (6a), on any server but the local one. Failed redeems count against the web
+  // sign-in's limits (shared with it when the web client is on).
+  const pairing = options.local ? undefined : new PairingCodes()
+  const pairingLimiter = web?.limiter ?? new LoginLimiter()
   // Expired sessions end on the hour even if nothing looks them up, closing their sockets.
   const stopSweep = web ? sweepEvery(web.sessions) : () => {}
   const onConfigChange = (): void => {
@@ -334,7 +340,12 @@ export function startServer(
           return
         }
         clearTimeout(helloTimer)
-        if (typeof frame.protocolVersion !== 'number' || (frame.token !== undefined && typeof frame.token !== 'string')) {
+        if (
+          typeof frame.protocolVersion !== 'number' ||
+          (frame.token !== undefined && typeof frame.token !== 'string') ||
+          (frame.pairingCode !== undefined && (typeof frame.pairingCode !== 'string' || frame.pairingCode.length > 64)) ||
+          (frame.deviceName !== undefined && (typeof frame.deviceName !== 'string' || frame.deviceName.length > 200))
+        ) {
           ws.close(1002, 'invalid hello')
           return
         }
@@ -346,9 +357,36 @@ export function startServer(
           ws.close(CLOSE_UNSUPPORTED_VERSION, frame.protocolVersion < PROTOCOL_VERSION_V2 ? CLOSE_REASON_UPGRADE_CLIENT : 'unsupported protocol version')
           return
         }
+        // A phone pairing (6a): a one-time code in place of a token. A good one mints the phone's
+        // own named token, sent once in the welcome; a bad one closes like a bad token, with why.
+        let paired: { token: string; name: string } | undefined
+        if (typeof frame.pairingCode === 'string' && !frame.token && !headerToken) {
+          const refuse = (reason: string): void => {
+            console.warn(`[auth] pairing refused (${reason}) from ${req.socket.remoteAddress}`)
+            rejected = true
+            rejectTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, reason), BAD_TOKEN_CLOSE_DELAY_MS)
+          }
+          const address = req.socket.remoteAddress ?? ''
+          const at = Date.now()
+          if (!pairing) return refuse(PAIRING_CLOSE_REASON.unknown)
+          if (!pairingLimiter.allow(address, at)) return refuse(PAIRING_CLOSE_REASON.limited)
+          const redeemed = pairing.redeem(frame.pairingCode, at)
+          if (!redeemed.ok) return refuse(PAIRING_CLOSE_REASON[redeemed.reason])
+          pairingLimiter.succeed(address, at)
+          const name = phoneTokenName(
+            typeof frame.deviceName === 'string' && frame.deviceName.trim() ? frame.deviceName.trim() : redeemed.name,
+            new Set(listTokens(store.config).map((t) => t.name))
+          )
+          let token = ''
+          store.update((c) => {
+            token = addToken(c, name)
+          })
+          paired = { token, name }
+          console.log(`[auth] paired a phone as token "${name}" from ${address}`)
+        }
         // An empty frame token falls back to the Authorization header, then to the web sign-in:
         // its session must still be live and its token still listed.
-        const token = (frame.token as string | undefined) || headerToken
+        const token = paired?.token || (frame.token as string | undefined) || headerToken
         const entry = token
           ? matchToken(store.config, token)
           : webSession && web?.sessions.has(webSession.key, Date.now())
@@ -374,7 +412,8 @@ export function startServer(
           daemonVersion,
           serverId: store.config.serverId ?? '',
           serverName: store.config.name ?? '',
-          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true, prWatch?.available() === true)
+          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true, prWatch?.available() === true),
+          ...(paired ? { pairedToken: paired.token, pairedTokenName: paired.name } : {})
         })
         return
       }
@@ -402,6 +441,7 @@ export function startServer(
         prWatch,
         promoteRequests,
         promoteRecoveryDir: options.promoteRecoveryDir,
+        pairing,
         mcpAccess: access
           ? {
               revoke: (id) => {
diff --git a/server/src/v2.ts b/server/src/v2.ts
index a3ff350..04b1318 100644
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -4,6 +4,7 @@
 // Linear, voice and skills with the server's own keys and disk (integrationHandlers.ts), and the
 // pull request watch (prWatchHandlers.ts), the Changes tab's review (reviewHandlers.ts), and
 // moving a worktree between servers (moveHandlers.ts).
+import type { PairingCodes } from './pairing'
 import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
 import type { IntegrationsChangedEvent, TopicRev } from '../../src/shared/protocolV2'
 import type { ConfigStore } from './configStore'
@@ -71,6 +72,8 @@ export interface V2Context {
   promoteRequests?: PromoteRequests
   /** Where a promote or demote saves a copy of the work it carries (5e; default: the temp dir) */
   promoteRecoveryDir?: string
+  /** Phone pairing's one-time codes (6a); absent on the local server */
+  pairing?: PairingCodes
 }
 
 type Handler = (params: any, ctx: V2Context) => unknown
@@ -321,7 +324,15 @@ const handlers: Record<string, Handler> = {
   ...prWatchHandlers,
   ...reviewHandlers,
   ...moveHandlers,
-  ...promoteHandlers
+  ...promoteHandlers,
+
+  // A one-time code a phone redeems at hello for its own token (6a). Any signed-in client may ask:
+  // a token already holds shell-level power on this machine. Only the code's hash is kept.
+  'pairing.create': (p, ctx) => {
+    if (!ctx.pairing) throw codedError('NOT_FOUND', 'This server does not pair phones (the local server is not reachable from one)')
+    if (p.name !== undefined && typeof p.name !== 'string') throw codedError('BAD_REQUEST', 'name must be a string')
+    return ctx.pairing.create(((p.name as string | undefined) ?? '').trim(), Date.now())
+  }
 }
 
 /** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
diff --git a/src/shared/client/index.ts b/src/shared/client/index.ts
index 856240e..75073c9 100644
--- a/src/shared/client/index.ts
+++ b/src/shared/client/index.ts
@@ -3,3 +3,4 @@ export * from './mirror.ts'
 export * from './ptyStream.ts'
 export * from './registry.ts'
 export * from './socket.ts'
+export * from './pairing.ts'
diff --git a/src/shared/client/pairing.ts b/src/shared/client/pairing.ts
new file mode 100644
index 0000000..ca2f91b
--- /dev/null
+++ b/src/shared/client/pairing.ts
@@ -0,0 +1,146 @@
+// Redeeming a phone pairing code (6a): one hello with `pairingCode` instead of a token. The
+// server mints the phone's own named token and sends it once in the welcome; the socket is then
+// closed, and the phone connects again with that token like any client. Nothing here imports Node,
+// DOM or Electron modules (the phone runs it).
+import { CLOSE_UNAUTHORIZED, PAIRING_CLOSE_REASON, PROTOCOL_VERSION_V2 } from '../protocolV2.ts'
+import { realTimers, type SocketFactory, type Timers } from './socket.ts'
+
+export type PairingFailure = 'expired' | 'used' | 'unknown' | 'limited' | 'unreachable' | 'refused' | 'timeout'
+
+export class PairingError extends Error {
+  readonly kind: PairingFailure
+  constructor(kind: PairingFailure, message: string) {
+    super(message)
+    this.name = 'PairingError'
+    this.kind = kind
+  }
+}
+
+export interface PairingResult {
+  token: string
+  tokenName: string
+  serverId: string
+  serverName: string
+  capabilities: string[]
+}
+
+export interface RedeemOptions {
+  url: string
+  code: string
+  deviceName: string
+  createSocket: SocketFactory
+  client?: string
+  clientVersion?: string
+  timeoutMs?: number
+  timers?: Timers
+}
+
+const MESSAGES: Record<PairingFailure, string> = {
+  expired: 'That pairing code has expired. Ask for a new one on the desktop.',
+  used: 'That pairing code was already used. Ask for a new one on the desktop.',
+  unknown: 'The server does not recognise that pairing code. Check it, or ask for a new one.',
+  limited: 'Too many pairing attempts. Wait a minute and try again.',
+  unreachable: 'Could not reach the server.',
+  refused: 'The server refused the pairing.',
+  timeout: 'The server did not answer in time.'
+}
+
+/** Why a 4003 close refused the code, from its reason. */
+export function pairingFailureOf(code: number, reason: string): PairingFailure {
+  if (code !== CLOSE_UNAUTHORIZED) return 'unreachable'
+  for (const [kind, text] of Object.entries(PAIRING_CLOSE_REASON)) if (reason === text) return kind as PairingFailure
+  return 'refused'
+}
+
+export function redeemPairingCode(opts: RedeemOptions): Promise<PairingResult> {
+  const timers = opts.timers ?? realTimers
+  return new Promise<PairingResult>((resolve, reject) => {
+    let done = false
+    let socket: ReturnType<SocketFactory>
+    const finish = (err: PairingError | null, result?: PairingResult): void => {
+      if (done) return
+      done = true
+      timers.clearTimeout(timer)
+      try {
+        socket?.close(1000, 'paired')
+      } catch {
+        // already closed
+      }
+      if (err) reject(err)
+      else resolve(result!)
+    }
+    const fail = (kind: PairingFailure): void => finish(new PairingError(kind, MESSAGES[kind]))
+    const timer = timers.setTimeout(() => fail('timeout'), opts.timeoutMs ?? 15_000)
+    try {
+      socket = opts.createSocket(opts.url)
+    } catch {
+      fail('unreachable')
+      return
+    }
+    socket.addEventListener('open', () => {
+      socket.send(
+        JSON.stringify({
+          type: 'hello',
+          protocolVersion: PROTOCOL_VERSION_V2,
+          client: opts.client ?? 'trek-mobile',
+          clientVersion: opts.clientVersion ?? '0',
+          pairingCode: opts.code,
+          deviceName: opts.deviceName
+        })
+      )
+    })
+    socket.addEventListener('message', (event) => {
+      let frame: Record<string, unknown>
+      try {
+        frame = JSON.parse(String(event.data))
+      } catch {
+        return
+      }
+      if (frame?.type !== 'welcome') return
+      if (typeof frame.pairedToken !== 'string' || frame.pairedToken === '') return fail('refused')
+      finish(null, {
+        token: frame.pairedToken,
+        tokenName: typeof frame.pairedTokenName === 'string' ? frame.pairedTokenName : '',
+        serverId: typeof frame.serverId === 'string' ? frame.serverId : '',
+        serverName: typeof frame.serverName === 'string' ? frame.serverName : '',
+        capabilities: Array.isArray(frame.capabilities) ? frame.capabilities.filter((c): c is string => typeof c === 'string') : []
+      })
+    })
+    socket.addEventListener('close', (event) => fail(pairingFailureOf(event.code, event.reason)))
+    socket.addEventListener('error', () => {
+      // 'close' follows with the code
+    })
+  })
+}
+
+/**
+ * A `trek://pair?url=…&code=…` link (the desktop's QR): the server URL and the code, or null.
+ * Only fills the pairing form; nothing is redeemed without the user's tap.
+ */
+export function parsePairingLink(link: string): { url: string; code: string } | null {
+  let parsed: URL
+  try {
+    parsed = new URL(link.trim())
+  } catch {
+    return null
+  }
+  if (parsed.protocol !== 'trek:') return null
+  // trek://pair?… : the host is "pair" (or the path, for trek:pair?…)
+  const target = parsed.hostname || parsed.pathname.replace(/^\/+/, '')
+  if (target !== 'pair') return null
+  const url = parsed.searchParams.get('url') ?? ''
+  const code = parsed.searchParams.get('code') ?? ''
+  if (!url || !code || !/^[A-Za-z2-7\s-]{16,64}$/.test(code)) return null
+  try {
+    const server = new URL(url)
+    if (server.protocol !== 'ws:' && server.protocol !== 'wss:') return null
+  } catch {
+    return null
+  }
+  return { url, code }
+}
+
+/** The link the desktop shows as a QR. */
+export function pairingLink(url: string, code: string): string {
+  return `trek://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`
+}
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 5e85623..39b2d74 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -119,6 +119,13 @@ export interface HelloFrame {
   token?: string
   client: string
   clientVersion: string
+  /**
+   * A phone pairing (6a): a one-time code from `pairing.create`, redeemed in place of a token (with
+   * no token). The server mints the phone's own named token and sends it once in the welcome.
+   */
+  pairingCode?: string
+  /** With `pairingCode`: the device's name, for the token's name (`phone-<deviceName>`) */
+  deviceName?: string
 }
 
 export interface ReqFrame {
@@ -220,7 +227,20 @@ export const CAPABILITY = {
    * and settled by its `worktree.promote {requestId}`, or declined (`promote.answer`); then
    * `promote.settled`
    */
-  promote: 'promote'
+  promote: 'promote',
+  /**
+   * Phone pairing (6a): `pairing.create` gives a signed-in client a one-time code (5 minutes) that
+   * a phone redeems once at hello (`pairingCode`) for its own named token (`welcome.pairedToken`)
+   */
+  pairing: 'pairing'
+} as const
+
+/** Close reasons for a refused pairing hello (sent with CLOSE_UNAUTHORIZED, 4003). */
+export const PAIRING_CLOSE_REASON = {
+  expired: 'pairing code expired',
+  used: 'pairing code already used',
+  unknown: 'pairing code not recognised',
+  limited: 'too many pairing attempts'
 } as const
 
 /** Why a topic ended (`topic.ended`). */
@@ -240,6 +260,10 @@ export interface WelcomeFrameV2 {
   serverName: string
   /** Optional features, e.g. "mcp", "bot", "docker"; clients hide what is missing */
   capabilities: string[]
+  /** Only to a hello that redeemed a `pairingCode` (6a): the phone's new token, sent this once */
+  pairedToken?: string
+  /** With `pairedToken`: the name the server gave it (`phone-<device>`) */
+  pairedTokenName?: string
 }
 
 interface ProjectRef {
@@ -350,6 +374,7 @@ export interface MethodParamsV2 {
   'promote.answer': { projectId: string; requestId: string; outcome: 'declined' | 'failed' | 'unknown-worktree'; error?: string; claimToken?: string }
   /** 5e: this connection can confirm promote_to_primary's requests for the project (`listen: false`: no longer) */
   'promote.listen': { projectId: string; listen?: boolean }
+  'pairing.create': { name?: string }
   /**
    * 5e: the user confirmed a `promote.request`: the first claim wins; send it before any teardown.
    * Repeated by the claimant (or with its `claimToken` from a new connection) it refreshes the claim.
@@ -573,6 +598,7 @@ export interface MethodResultsV2 {
   'worktree.demote': PromotePlan | PromoteResult
   'promote.answer': { accepted: boolean }
   'promote.listen': null
+  'pairing.create': { code: string; expiresAt: number }
   'promote.claim': PromoteClaimResult
   'worktree.commits': CommitInfo[]
   'branch.setTag': null
```

### Task 2: The desktop's Pair a phone…

(Prototype commit `18b8df6`.)

Main asks for the code; the window draws the QR. `smoke:server-pairing` (Decisions 6–8).

- [ ] **Step 1: dependencies.** `npm install --save-dev qrcode@^1.5.4 @types/qrcode@^1.5.5` (the lockfile follows).
- [ ] **Step 2: main and the bridge.** `AppServerPairing` in `src/shared/types.ts`; `pairPhone` in `src/main/appServers.ts` and its IPC; the preload bridge; the web client's refusal.
- [ ] **Step 3: the window.** `PairPhone.tsx`, the button in `ConnectServer.tsx` (`canPairPhone`), and the styles.
- [ ] **Step 4: the smoke.** Write `scripts/server-pairing-smoke.mjs` and add `smoke:server-pairing` to `package.json`.
- [ ] **Step 5: run.** `npm run typecheck && npm run smoke:server-pairing`. Expected: SERVER PAIRING SMOKE PASS (17 checks).
- [ ] **Step 6: commit.**

```diff
diff --git a/package.json b/package.json
index e2684fa..ecd6c66 100644
--- a/package.json
+++ b/package.json
@@ -27,6 +27,7 @@
     "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
     "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
     "smoke:server-review": "npm run build && node scripts/server-review-smoke.mjs",
+    "smoke:server-pairing": "npm run build && node scripts/server-pairing-smoke.mjs",
     "smoke:server-move": "npm run build && node scripts/server-move-smoke.mjs",
     "smoke:server-promote": "npm run build && node scripts/server-promote-smoke.mjs",
     "smoke:server-web": "npm run build && node scripts/server-web-smoke.mjs",
@@ -78,6 +79,7 @@
   "devDependencies": {
     "@electron/rebuild": "^4.2.0",
     "@types/node": "^26.1.1",
+    "@types/qrcode": "^1.5.5",
     "@types/react": "^19.2.17",
     "@types/react-dom": "^19.2.3",
     "@vitejs/plugin-react": "^5.2.0",
@@ -87,6 +89,7 @@
     "electron-builder": "^26.15.3",
     "electron-vite": "^5.0.0",
     "playwright-core": "^1.61.1",
+    "qrcode": "^1.5.4",
     "react": "^19.2.7",
     "react-dom": "^19.2.7",
     "typescript": "^7.0.2",
diff --git a/scripts/server-pairing-smoke.mjs b/scripts/server-pairing-smoke.mjs
new file mode 100644
index 0000000..8a814c9
--- /dev/null
+++ b/scripts/server-pairing-smoke.mjs
@@ -0,0 +1,214 @@
+// scripts/server-pairing-smoke.mjs — "Pair a phone…" (6a): the desktop asks a remote server for a
+// one-time code, a phone (here: the SDK in Node) redeems it for its own token, and the token works
+// until it is revoked.
+//
+// Run: npm run smoke:server-pairing   (builds the app and the server, then runs this script)
+//
+// A plain `trek-server start` (no `local`) with its own HOME and the not-signed-in stub gh every
+// smoke gets (smokeGh.mjs). The built app runs with a temp HOME and --user-data-dir and no Local
+// server. The server is saved in the app under an IPv4-mapped address (`[::ffff:127.0.0.1]`): it
+// reaches this machine's loopback, but isn't one of the loopback names the button is hidden for.
+// Through the DOM and the SDK it checks:
+//   - Pair a phone… shows for the connected remote server (and not for a loopback URL);
+//   - its QR and text carry the code and the URL, and nothing in the window holds a token;
+//   - the code redeems once, at hello, for a named token phone-<device> that then signs in;
+//   - a second redeem of the same code is refused, saying it was used;
+//   - revoking the token (the server's CLI) closes the phone's connection and refuses it after;
+//   - no error dialogs, console or page errors.
+import './smokeGh.mjs'
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory, parsePairingLink, redeemPairingCode } from '../src/shared/client/index.ts'
+import { closeApp } from './smokeTeardown.mjs'
+
+const WATCHDOG_MS = 180_000
+const DAEMON_READY_MS = 15_000
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
+const token = randomBytes(16).toString('base64url')
+const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-pairing-smoke-')))
+const serverHome = join(work, 'server-home')
+const appHome = join(work, 'app-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
+const configPath = join(work, 'config.json')
+writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [] }))
+
+// Main's dialogs never reach the screen: they are recorded and answered "OK".
+const mainStub = join(work, 'main-stub.cjs')
+writeFileSync(
+  mainStub,
+  `const { dialog } = require('electron')
+globalThis.__dialogs = []
+dialog.showMessageBox = async (...args) => {
+  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
+  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message })
+  return { response: 0, checkboxChecked: false }
+}
+`
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
+let daemon = null
+let app = null
+let phone = null
+const pageErrors = []
+const watch = (page) => {
+  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
+  page.on('console', (m) => {
+    if (m.type() === 'error') pageErrors.push(m.text())
+  })
+}
+
+let exitCode = 1
+let finished = false
+const finish = async (reason) => {
+  if (finished) return
+  finished = true
+  if (reason) console.error(reason)
+  phone?.close()
+  await closeApp(app)
+  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
+    daemon.kill()
+    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
+  }
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(exitCode === 0 ? `SERVER PAIRING SMOKE PASS (${checks.length} checks)` : `SERVER PAIRING SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+try {
+  // ---- 1. The server ---------------------------------------------------------------------------------
+  const port = await freePort()
+  const serverEnv = { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' }
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
+      cwd: join(root, 'server'),
+      env: serverEnv,
+      stdio: ['ignore', 'pipe', 'pipe']
+    })
+    daemon = d
+    let output = ''
+    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
+    d.stdout.on('data', (b) => {
+      output += b
+      if (/listening on ws:\/\//.test(output)) {
+        clearTimeout(timer)
+        resolve()
+      }
+    })
+    d.stderr.on('data', (b) => {
+      output += b
+      process.stderr.write(b)
+    })
+    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
+  })
+  const url = `ws://[::ffff:127.0.0.1]:${port}`
+  const cli = (...args) => execFileSync(process.execPath, ['dist/trek-server.cjs', ...args, '--config', configPath], { cwd: join(root, 'server'), env: serverEnv, encoding: 'utf8' })
+
+  // ---- 2. The app, with the server saved, on the Servers view ---------------------------------------
+  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
+  delete env.ELECTRON_RUN_AS_NODE
+  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
+  app.on('window', watch)
+  const win = await app.firstWindow()
+  watch(win)
+  await win.waitForLoadState('domcontentloaded')
+  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
+  // A loopback URL for the same server: the button is hidden there.
+  const loopback = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Loopback', url: u, token: t }), [`ws://127.0.0.1:${port}`, token])
+  const linkStatus = (id) => async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === id)?.status ?? null
+  check("main's connection to the server is up", await until(linkStatus(entry.id), 'connected'), 'connected')
+  await until(linkStatus(loopback.id), 'connected')
+  await win.locator('.start-actions button', { hasText: 'Open on server…' }).click()
+  const item = (name) => win.locator('.connect-server-item', { has: win.locator('.connect-server-name', { hasText: new RegExp(`^${name}$`) }) })
+  await item('Remote').waitFor({ timeout: 10_000 })
+  const pairButton = (name) => item(name).locator('button', { hasText: 'Pair a phone…' })
+  check('Pair a phone… shows for the remote server', await until(() => pairButton('Remote').count(), 1), 1)
+  check('and not for the same server at a loopback URL', await pairButton('Loopback').count(), 0)
+  check('main refuses it for a loopback URL too', await win.evaluate((id) => window.api.appServers.pairPhone(id).then(() => 'paired', (e) => String(e.message ?? e)), loopback.id).then((m) => /loopback/.test(m)), true)
+
+  // ---- 3. The code ----------------------------------------------------------------------------------
+  await pairButton('Remote').click()
+  const panel = item('Remote').locator('.pair-phone')
+  await panel.locator('[data-testid="pair-code"]').waitFor({ timeout: 10_000 })
+  check('the QR is drawn', await panel.locator('[data-testid="pair-qr"] path').count(), 1)
+  const shownUrl = await panel.locator('[data-testid="pair-url"]').textContent()
+  const shownCode = (await panel.locator('[data-testid="pair-code"]').textContent()) ?? ''
+  check('the panel shows the URL this app uses for the server', shownUrl, url)
+  check('and the code, in groups of five', /^([A-Z2-7]{5}-){5}[A-Z2-7]$/.test(shownCode), true)
+  // What the QR holds: the window asks main again for the link it would draw (main gives the code, not a token).
+  const second = await win.evaluate((id) => window.api.appServers.pairPhone(id), entry.id)
+  check('the QR link is trek://pair with the URL and a code, and no token', [parsePairingLink(second.link)?.url, second.link.includes(token), Object.keys(second).sort()], [url, false, ['code', 'expiresAt', 'link', 'url']])
+  check('the window holds no token (store, page and storage)', await win.evaluate((t) => {
+    const strings = JSON.stringify(window.__store?.getState() ?? {}) + document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
+    return strings.includes(t)
+  }, token), false)
+
+  // ---- 4. The phone ---------------------------------------------------------------------------------
+  const code = shownCode
+  const paired = await redeemPairingCode({ url, code, deviceName: 'Smoke Phone', createSocket: globalSocketFactory, client: 'pairing-smoke' })
+  check('the phone redeems the code for its own named token', [paired.tokenName, paired.token.length > 20, paired.token !== token], ['phone-Smoke-Phone', true, true])
+  check('the server lists the token', /phone-Smoke-Phone/.test(cli('token', 'list')), true)
+  phone = new ServerConnection({ url, token: paired.token, createSocket: globalSocketFactory, client: 'pairing-smoke-phone' })
+  phone.connect()
+  check('the phone signs in with it', await until(() => phone.status, 'connected', 5000), 'connected')
+  const reused = await redeemPairingCode({ url, code, deviceName: 'Other', createSocket: globalSocketFactory }).then(() => 'paired', (e) => e.kind)
+  check('the same code again is refused: already used', reused, 'used')
+  // The other code (asked for above) still works once: then it is spent too.
+  await redeemPairingCode({ url, code: second.code, deviceName: 'Smoke Phone', createSocket: globalSocketFactory }).then((r) => {
+    check('a second phone named the same gets a numbered token', r.tokenName, 'phone-Smoke-Phone-2')
+  })
+
+  // ---- 5. Revocation --------------------------------------------------------------------------------
+  cli('token', 'revoke', 'phone-Smoke-Phone')
+  check("revoking the token closes the phone's connection", await until(() => phone.status, 'needs-auth', 8000), 'needs-auth')
+
+  check('no error dialogs', await app.evaluate(() => globalThis.__dialogs.filter((d) => d.type === 'error')), [])
+  check('no console or page errors', pageErrors, [])
+  exitCode = checks.every(Boolean) ? 0 : 1
+} catch (err) {
+  console.error(err)
+  exitCode = 1
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
index f8c11da..9ae94bd 100644
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -25,15 +25,15 @@ import {
   type AppServer,
   type RemovingEntry
 } from './appServersRules'
-import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
+import { SERVER_REMOVED_MESSAGE, globalSocketFactory, pairingLink } from '../shared/client/index.ts'
 import { probeServer } from './appServerProbe'
 import { closeForServer } from './v2relay'
 import { checkLocalServer, localEntry, localServerUrl, localToken, onLocalServerChanged } from './localServer'
 import { LOCAL_ENTRY_ID } from './localServerRules'
-import { isLocalEntryId } from '../shared/appServerRules.ts'
+import { isLocalEntryId, isLoopbackUrl } from '../shared/appServerRules.ts'
 import { createServerLinks, type ServerLinks, type ServerLinksDeps } from './serverLinks'
 import type { RegisteredServer } from '../shared/client/index.ts'
-import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'
+import type { AppServerInfo, AppServerPairing, AppServersChanged, AppServerTest } from '../shared/types'
 
 const FILE_NAME = 'app-servers.json'
 
@@ -320,6 +320,24 @@ export async function adoptAppServerToken(id: string, url: string, token: string
   return stored
 }
 
+/**
+ * "Pair a phone…" (6a): asks the server, over main's own connection, for a one-time pairing code.
+ * The window gets the code, its expiry and the URL this app uses for the server: never a token.
+ * Refused for the Local server and a loopback URL (a phone can't reach either), and for a server
+ * whose welcome doesn't list `pairing`.
+ */
+async function pairPhone(id: unknown): Promise<AppServerPairing> {
+  const server = requireKnown(id)
+  if (isLocalEntryId(server.id)) throw new Error('A phone cannot reach the Local server')
+  if (isLoopbackUrl(server.url)) throw new Error('A phone cannot reach a server at a loopback address (localhost or 127.0.0.1)')
+  const link = links?.get(server.id)
+  const welcome = link?.connection.welcome
+  if (!link || link.connection.status !== 'connected' || !welcome) throw new Error('Not connected to this server')
+  if (!welcome.capabilities.includes('pairing')) throw new Error('This server does not pair phones; update it')
+  const { code, expiresAt } = await link.connection.request('pairing.create', { name: '' })
+  return { url: server.url, code, expiresAt, link: pairingLink(server.url, code) }
+}
+
 /** Quit: main's connections close for good. */
 export function closeServerLinks(): void {
   links?.close()
@@ -377,4 +395,5 @@ export function registerAppServerHandlers(
   ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
   ipcMain.handle('appServers:remove', (_event, id: unknown) => remove(id))
   ipcMain.handle('appServers:test', (_event, id: unknown) => test(id))
+  ipcMain.handle('appServers:pairPhone', (_event, id: unknown) => pairPhone(id))
 }
diff --git a/src/preload/index.ts b/src/preload/index.ts
index ac70234..8b328e3 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -6,6 +6,7 @@ import type {
   AttentionChanged,
   SessionSelect,
   V2SocketOpenResult,
+  AppServerPairing,
   AppServerTest,
   InitialWindowState,
   RecentEntry,
@@ -77,6 +78,8 @@ const api = {
     setToken: (id: string, token: string): Promise<void> => ipcRenderer.invoke('appServers:setToken', id, token),
     remove: (id: string): Promise<void> => ipcRenderer.invoke('appServers:remove', id),
     test: (id: string): Promise<AppServerTest> => ipcRenderer.invoke('appServers:test', id),
+    /** A one-time phone pairing code for the QR (6a); never a token */
+    pairPhone: (id: string): Promise<AppServerPairing> => ipcRenderer.invoke('appServers:pairPhone', id),
     /** The list with main's connection statuses (never a token); `onChanged` hears every change after it. */
     links: (): Promise<AppServersChanged> => ipcRenderer.invoke('appServers:links'),
     onChanged: (callback: (snapshot: AppServersChanged) => void): (() => void) =>
diff --git a/src/renderer/src/components/ConnectServer.tsx b/src/renderer/src/components/ConnectServer.tsx
index 4e1db3f..c6934ed 100644
--- a/src/renderer/src/components/ConnectServer.tsx
+++ b/src/renderer/src/components/ConnectServer.tsx
@@ -5,6 +5,7 @@ import { errorText } from '../v2/errors'
 import { shouldReconnect, shouldReconnectOnMove } from '../v2/appServerLinks'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { NewServerProjectModal } from './NewServerProjectModal'
+import { PairPhone } from './PairPhone'
 import { STATUS_LABELS, isLoopbackUrl, localStatusLabel, originOf } from '../../../shared/appServerRules.ts'
 import type { ConnectionStatus, RegisteredServer, StatusChange } from '../../../shared/client/index.ts'
 import type { ServerTopic } from '../../../shared/model/topics'
@@ -49,6 +50,14 @@ function unencryptedRemote(url: string): boolean {
   }
 }
 
+/**
+ * "Pair a phone…" (6a) shows for a connected server whose welcome lists `pairing`, but never for
+ * the Local server or a loopback URL: a phone can't reach those.
+ */
+export function canPairPhone(server: AppServerLink): boolean {
+  return !server.local && server.status === 'connected' && !isLoopbackUrl(server.url) && (server.capabilities ?? []).includes('pairing')
+}
+
 function needsTokenAgain(form: FormState): boolean {
   if (form.id === null || form.savedUrl === null) return false
   return originOf(form.savedUrl) !== originOf(form.url)
@@ -61,6 +70,7 @@ export function ConnectServer({ onBack }: Props): React.JSX.Element {
   const [formError, setFormError] = useState<string | null>(null)
   const [saving, setSaving] = useState(false)
   const [tokenFor, setTokenFor] = useState<string | null>(null)
+  const [pairFor, setPairFor] = useState<string | null>(null)
   const [tokenValue, setTokenValue] = useState('')
   const [tests, setTests] = useState<Record<string, TestState>>({})
   const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
@@ -249,6 +259,11 @@ export function ConnectServer({ onBack }: Props): React.JSX.Element {
                 <button className="btn btn-ghost" disabled={testState?.busy} onClick={() => void test(server)}>
                   {testState?.busy ? 'Testing…' : 'Test'}
                 </button>
+                {canPairPhone(server) && (
+                  <button className="btn btn-ghost" onClick={() => setPairFor(pairFor === server.id ? null : server.id)}>
+                    Pair a phone…
+                  </button>
+                )}
                 <button className="btn btn-ghost" onClick={() => startEdit(server)}>
                   Edit
                 </button>
@@ -291,6 +306,8 @@ export function ConnectServer({ onBack }: Props): React.JSX.Element {
               </div>
             )}
 
+            {pairFor === server.id && canPairPhone(server) && <PairPhone serverId={server.id} onClose={() => setPairFor(null)} />}
+
             {rowErrors[server.id] && <div className="error">{rowErrors[server.id]}</div>}
 
             {form?.id === server.id && (
diff --git a/src/renderer/src/components/PairPhone.tsx b/src/renderer/src/components/PairPhone.tsx
new file mode 100644
index 0000000..4cbc16d
--- /dev/null
+++ b/src/renderer/src/components/PairPhone.tsx
@@ -0,0 +1,99 @@
+import { useCallback, useEffect, useMemo, useState } from 'react'
+import { create } from 'qrcode'
+import { errorText } from '../v2/errors'
+import type { AppServerPairing } from '../../../shared/types'
+
+/**
+ * "Pair a phone…" (6a): a one-time code from the server, shown as a QR of
+ * `trek://pair?url=…&code=…` and as text, with its countdown. The code is not a token: the phone
+ * redeems it once for its own. Main asks the server for it (window.api.appServers.pairPhone).
+ */
+export function PairPhone({ serverId, onClose }: { serverId: string; onClose: () => void }): React.JSX.Element {
+  const [pairing, setPairing] = useState<AppServerPairing | null>(null)
+  const [error, setError] = useState<string | null>(null)
+  const [now, setNow] = useState(() => Date.now())
+
+  const ask = useCallback(async () => {
+    setError(null)
+    setPairing(null)
+    try {
+      setPairing(await window.api.appServers.pairPhone(serverId))
+    } catch (err) {
+      setError(errorText(err))
+    }
+  }, [serverId])
+
+  useEffect(() => {
+    void ask()
+  }, [ask])
+
+  useEffect(() => {
+    const timer = setInterval(() => setNow(Date.now()), 1000)
+    return () => clearInterval(timer)
+  }, [])
+
+  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
+  const expired = pairing !== null && left === 0
+
+  return (
+    <div className="pair-phone" role="group" aria-label="Pair a phone">
+      {error && <div className="error">Could not get a pairing code: {error}</div>}
+      {!pairing && !error && <p className="muted">Asking the server for a pairing code…</p>}
+      {pairing && (
+        <>
+          {!expired && <QrCode text={pairing.link} />}
+          <div className="pair-phone-text">
+            <p>
+              In the Trek app on your phone, choose <strong>Add server</strong> and scan this code, or type the server
+              address and the code below.
+            </p>
+            <div className="pair-phone-field">
+              <span className="muted">Server</span> <code data-testid="pair-url">{pairing.url}</code>
+            </div>
+            <div className="pair-phone-field">
+              <span className="muted">Code</span> <code data-testid="pair-code">{groupCode(pairing.code)}</code>
+            </div>
+            <p className={expired ? 'warn' : 'muted'} aria-live="polite">
+              {expired
+                ? 'This code has expired.'
+                : `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more. The phone gets its own token, which you can revoke on the server.`}
+            </p>
+          </div>
+        </>
+      )}
+      <div className="pair-phone-actions">
+        <button className="btn btn-ghost" onClick={() => void ask()}>
+          New code
+        </button>
+        <button className="btn btn-ghost" onClick={onClose}>
+          Done
+        </button>
+      </div>
+    </div>
+  )
+}
+
+/** In groups of five, for reading aloud or typing. */
+export function groupCode(code: string): string {
+  return code.replace(/(.{5})(?=.)/g, '$1-')
+}
+
+/** The QR as SVG squares (no image data, no innerHTML): a 4-module quiet zone, black on white. */
+function QrCode({ text }: { text: string }): React.JSX.Element {
+  const { size, path } = useMemo(() => {
+    const { modules } = create(text, { errorCorrectionLevel: 'M' })
+    let d = ''
+    for (let row = 0; row < modules.size; row++) {
+      for (let col = 0; col < modules.size; col++) {
+        if (modules.get(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`
+      }
+    }
+    return { size: modules.size + 8, path: d }
+  }, [text])
+  return (
+    <svg className="pair-phone-qr" data-testid="pair-qr" viewBox={`0 0 ${size} ${size}`} width={220} height={220} role="img" aria-label="Pairing QR code">
+      <rect width={size} height={size} fill="#fff" />
+      <path d={path} fill="#000" shapeRendering="crispEdges" />
+    </svg>
+  )
+}
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index bce70dc..6d50df5 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -3271,6 +3271,47 @@ button:disabled {
   color: #f38ba8;
 }
 
+/* "Pair a phone…" (6a): the QR, the address and code, the countdown */
+.pair-phone {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 16px;
+  align-items: flex-start;
+  padding: 10px 8px;
+  border-top: 1px solid var(--border);
+}
+
+.pair-phone-qr {
+  flex: none;
+  border-radius: 6px;
+}
+
+.pair-phone-text {
+  flex: 1;
+  min-width: 220px;
+  font-size: 12px;
+}
+
+.pair-phone-field {
+  margin: 6px 0;
+}
+
+.pair-phone-field code {
+  font-size: 13px;
+  user-select: all;
+}
+
+.pair-phone-text .warn {
+  color: var(--attention);
+}
+
+.pair-phone-actions {
+  display: flex;
+  gap: 8px;
+  width: 100%;
+  justify-content: flex-end;
+}
+
 .server-form-actions {
   display: flex;
   align-items: center;
diff --git a/src/shared/types.ts b/src/shared/types.ts
index d25aac3..0b62685 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -244,6 +244,19 @@ export interface AppServerTest {
   serverId?: string
 }
 
+/**
+ * "Pair a phone…" (6a): a one-time code from the server, for the QR. Never a token: the phone
+ * redeems the code for its own. `url` is the address this app uses for the server.
+ */
+export interface AppServerPairing {
+  url: string
+  code: string
+  /** ms since the epoch */
+  expiresAt: number
+  /** `trek://pair?url=…&code=…`, what the QR holds */
+  link: string
+}
+
 /** Identifies a worktree across machines — path alone is ambiguous. */
 export interface WorktreeLocator {
   serverId?: string
diff --git a/src/web/webApi.ts b/src/web/webApi.ts
index 4e4c3b1..03ea9fa 100644
--- a/src/web/webApi.ts
+++ b/src/web/webApi.ts
@@ -147,6 +147,7 @@ export function createWebApi(Socket: BrowserSocketClass = WebSocket as unknown a
       setToken: refuse,
       remove: refuse,
       test: refuse,
+      pairPhone: refuse,
       links: async () => links(),
       onChanged: (cb) => {
         linkListeners.add(cb)
```

### Task 3: The shared-code guard

(Prototype commit `d3ee63b`.)

A test keeps what the phone imports free of Node, Electron, DOM and packages (Decision 9). The shared code needs no change.

- [ ] **Step 1: the test.** Write `scripts/sharedForMobile.test.mjs`; Task 4 widens `MOBILE_ENTRIES` to what `apps/mobile/src/shared.ts` imports, and adds the check that keeps them equal.
- [ ] **Step 2: run.** `node --test scripts/sharedForMobile.test.mjs`. Expected: pass.
- [ ] **Step 3: commit.**

```diff
diff --git a/scripts/sharedForMobile.test.mjs b/scripts/sharedForMobile.test.mjs
new file mode 100644
index 0000000..257eee7
--- /dev/null
+++ b/scripts/sharedForMobile.test.mjs
@@ -0,0 +1,83 @@
+// The phone (6a, apps/mobile) imports src/shared/client, src/shared/model and src/shared/protocolV2
+// straight from the repo (Metro watchFolders). This walks the import graph from those entry points
+// and fails on anything React Native can't run: node:* and Node built-ins, electron, a package the
+// phone doesn't have, or the DOM's document/window globals.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { readFileSync, existsSync } from 'node:fs'
+import { builtinModules } from 'node:module'
+import { dirname, join, relative, resolve } from 'node:path'
+
+const root = resolve(new URL('..', import.meta.url).pathname)
+/** What apps/mobile imports from the shared code (keep in step with apps/mobile/src/shared.ts). */
+export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts']
+/** Packages the phone also has (none today: the shared code is dependency-free). */
+const ALLOWED_PACKAGES = new Set([])
+
+const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]*?\s+from\s+)?['"]([^'"]+)['"]/g
+const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
+/** A DOM global used as a value (not in a comment or a type position we can tell apart cheaply). */
+const DOM_RE = /(?<![\w.$'"])(document|window|localStorage|sessionStorage|navigator)\s*[.[(]/
+
+function resolveLocal(from, spec) {
+  const base = resolve(dirname(from), spec)
+  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
+    if (existsSync(candidate) && !candidate.endsWith('/')) {
+      try {
+        readFileSync(candidate)
+        return candidate
+      } catch {
+        // a directory
+      }
+    }
+  }
+  return null
+}
+
+const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
+
+function walk() {
+  const seen = new Map()
+  const problems = []
+  const queue = MOBILE_ENTRIES.map((e) => join(root, e))
+  while (queue.length) {
+    const file = queue.shift()
+    if (seen.has(file)) continue
+    const src = stripComments(readFileSync(file, 'utf8'))
+    seen.set(file, true)
+    const rel = relative(root, file)
+    const specs = [...src.matchAll(IMPORT_RE)].map((m) => m[1])
+    for (const m of src.matchAll(DYNAMIC_RE)) specs.push(m[1] ?? m[2])
+    for (const spec of specs) {
+      if (spec.startsWith('.')) {
+        const target = resolveLocal(file, spec)
+        if (!target) problems.push(`${rel}: cannot resolve ${spec}`)
+        else if (!relative(join(root, 'src', 'shared'), target).startsWith('..')) queue.push(target)
+        else problems.push(`${rel}: imports ${relative(root, target)}, outside src/shared`)
+      } else if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) {
+        problems.push(`${rel}: imports the Node built-in ${spec}`)
+      } else if (spec === 'electron' || spec.startsWith('electron/')) {
+        problems.push(`${rel}: imports electron`)
+      } else if (!ALLOWED_PACKAGES.has(spec)) {
+        problems.push(`${rel}: imports the package ${spec}, which the phone does not have`)
+      }
+    }
+    const dom = DOM_RE.exec(src)
+    if (dom) problems.push(`${rel}: uses the DOM global ${dom[1]}`)
+  }
+  return { files: [...seen.keys()].map((f) => relative(root, f)).sort(), problems }
+}
+
+test('the shared code the phone imports runs on React Native: no Node, Electron, DOM or packages', () => {
+  const { files, problems } = walk()
+  assert.ok(files.length >= MOBILE_ENTRIES.length, `walked ${files.length} files`)
+  assert.deepEqual(problems, [])
+})
+
+test('the guard catches what it should (a planted Node import and a DOM global)', () => {
+  assert.match("import { readFile } from 'node:fs'", IMPORT_RE)
+  IMPORT_RE.lastIndex = 0
+  assert.equal(DOM_RE.test('const x = document.title'), true)
+  assert.equal(DOM_RE.test("const s = 'document.title'"), false)
+  assert.equal(DOM_RE.test('globalThis.WebSocket'), false)
+})
```

### Task 4: The `apps/mobile` scaffold

(Prototype commit `0f0ee9d`.)

An Expo app with its own `package.json` and lockfile, a Metro config that watches `../../src/shared`, `src/shared.ts`, and the terminal page's build (Decisions 10–11 and 16).

- [ ] **Step 1: the template.** `mkdir -p apps && cd apps && CI=1 npx create-expo-app@latest mobile --template blank-typescript --no-install`. Then delete the template's `.claude/`, `AGENTS.md`, `LICENSE`, `App.tsx`, `index.ts` and `assets/favicon.png`. The diff below shows the files as they end up.
- [ ] **Step 2: dependencies.** In `apps/mobile`:
  1. `npm install`
  2. `CI=1 npx expo install expo-router expo-secure-store expo-camera expo-notifications react-native-webview expo-linking expo-constants expo-device react-native-safe-area-context react-native-screens react-dom`
  3. `npm install --save-dev @xterm/xterm@^6.0.0`

  These write `package-lock.json`, which is not shown.
- [ ] **Step 3: the code.** Write the files below. The `package.json` scripts run `scripts/build-terminal.mjs` at `postinstall`, and before `typecheck` and `export`.
- [ ] **Step 4: run.** `cd apps/mobile && npm run typecheck` (it fails until Task 5 adds `app/`; the full check is in Task 10) and `node --test scripts/sharedForMobile.test.mjs`.
- [ ] **Step 5: commit.** Leave out `node_modules`, `dist` and the generated page.

```diff
diff --git a/apps/mobile/.gitignore b/apps/mobile/.gitignore
new file mode 100644
index 0000000..3bd2d86
--- /dev/null
+++ b/apps/mobile/.gitignore
@@ -0,0 +1,44 @@
+# Learn more https://docs.github.com/en/get-started/getting-started-with-git/ignoring-files
+
+# dependencies
+node_modules/
+
+# Expo
+.expo/
+dist/
+web-build/
+expo-env.d.ts
+
+# Native
+.kotlin/
+*.orig.*
+*.jks
+*.p8
+*.p12
+*.key
+*.mobileprovision
+
+# Metro
+.metro-health-check*
+
+# debug
+npm-debug.*
+yarn-debug.*
+yarn-error.*
+
+# macOS
+.DS_Store
+*.pem
+
+# local env files
+.env*.local
+
+# typescript
+*.tsbuildinfo
+
+# generated native folders
+/ios
+/android
+
+# Generated by scripts/build-terminal.mjs
+src/terminal/terminalHtml.generated.ts
diff --git a/apps/mobile/app.json b/apps/mobile/app.json
new file mode 100644
index 0000000..06f54a0
--- /dev/null
+++ b/apps/mobile/app.json
@@ -0,0 +1,36 @@
+{
+  "expo": {
+    "name": "Trek",
+    "slug": "trek-mobile",
+    "version": "0.1.0",
+    "orientation": "portrait",
+    "icon": "./assets/icon.png",
+    "userInterfaceStyle": "automatic",
+    "ios": {
+      "supportsTablet": false,
+      "bundleIdentifier": "dev.trek.mobile"
+    },
+    "android": {
+      "adaptiveIcon": {
+        "backgroundColor": "#E6F4FE",
+        "foregroundImage": "./assets/android-icon-foreground.png",
+        "backgroundImage": "./assets/android-icon-background.png",
+        "monochromeImage": "./assets/android-icon-monochrome.png"
+      },
+      "predictiveBackGestureEnabled": false,
+      "package": "dev.trek.mobile"
+    },
+    "scheme": "trek",
+    "plugins": [
+      "expo-router",
+      "expo-secure-store",
+      [
+        "expo-camera",
+        {
+          "cameraPermission": "Trek uses the camera to scan a server's pairing code."
+        }
+      ],
+      "expo-notifications"
+    ]
+  }
+}
diff --git a/apps/mobile/metro.config.js b/apps/mobile/metro.config.js
new file mode 100644
index 0000000..3a001ae
--- /dev/null
+++ b/apps/mobile/metro.config.js
@@ -0,0 +1,11 @@
+// The phone imports the repo's shared protocol code (src/shared) straight from the source tree:
+// Metro watches that folder too. That code imports no packages (scripts/sharedForMobile.test.mjs
+// checks), so every package resolves from this app's node_modules (nested ones included).
+const { getDefaultConfig } = require('expo/metro-config')
+const path = require('node:path')
+
+const config = getDefaultConfig(__dirname)
+config.watchFolders = [path.resolve(__dirname, '../../src/shared')]
+config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]
+
+module.exports = config
diff --git a/apps/mobile/package.json b/apps/mobile/package.json
new file mode 100644
index 0000000..c0c25fc
--- /dev/null
+++ b/apps/mobile/package.json
@@ -0,0 +1,37 @@
+{
+  "name": "trek-mobile",
+  "version": "0.1.0",
+  "main": "expo-router/entry",
+  "dependencies": {
+    "expo": "~58.0.24",
+    "expo-camera": "~58.0.14",
+    "expo-constants": "~58.0.16",
+    "expo-device": "~58.0.5",
+    "expo-linking": "~58.0.17",
+    "expo-notifications": "~58.1.9",
+    "expo-router": "~58.0.31",
+    "expo-secure-store": "~58.0.3",
+    "expo-status-bar": "~58.0.5",
+    "react": "19.3.0",
+    "react-dom": "19.3.0",
+    "react-native": "0.88.1",
+    "react-native-safe-area-context": "~5.11.1",
+    "react-native-screens": "~4.30.1",
+    "react-native-webview": "14.0.1"
+  },
+  "devDependencies": {
+    "@types/react": "~19.3.0",
+    "@xterm/xterm": "^6.0.0",
+    "typescript": "~6.0.3"
+  },
+  "scripts": {
+    "start": "expo start",
+    "ios": "expo start --ios",
+    "android": "expo start --android",
+    "typecheck": "node scripts/build-terminal.mjs && tsc --noEmit",
+    "export": "node scripts/build-terminal.mjs && expo export --platform ios --platform android --output-dir dist",
+    "build:terminal": "node scripts/build-terminal.mjs",
+    "postinstall": "node scripts/build-terminal.mjs"
+  },
+  "private": true
+}
diff --git a/apps/mobile/scripts/build-terminal.mjs b/apps/mobile/scripts/build-terminal.mjs
new file mode 100644
index 0000000..8b066a6
--- /dev/null
+++ b/apps/mobile/scripts/build-terminal.mjs
@@ -0,0 +1,22 @@
+// Builds src/terminal/terminalHtml.generated.ts (gitignored): the session screen's WebView page,
+// one self-contained HTML string with xterm.js, its CSS and src/terminal/page.js inlined. Its CSP
+// allows nothing from outside the page. Run by postinstall, and before typecheck and export.
+import { readFileSync, writeFileSync } from 'node:fs'
+import { dirname, join } from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+const app = join(dirname(fileURLToPath(import.meta.url)), '..')
+const read = (p) => readFileSync(join(app, p), 'utf8')
+// A literal "</script" inside an inlined script would end the tag early.
+const safe = (js) => js.replace(/<\/script/gi, '<\\/script')
+const html = `<!doctype html><html><head><meta charset="utf-8">
+<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
+<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
+<style>${read('node_modules/@xterm/xterm/css/xterm.css')}
+html,body{margin:0;padding:0;background:#1e1e2e;overflow-x:auto}#t{padding:4px}</style>
+</head><body><div id="t"></div>
+<script>${safe(read('node_modules/@xterm/xterm/lib/xterm.js'))}</script>
+<script>${safe(read('src/terminal/page.js'))}</script>
+</body></html>`
+writeFileSync(join(app, 'src/terminal/terminalHtml.generated.ts'), `// Generated by scripts/build-terminal.mjs: do not edit.\nexport const TERMINAL_HTML: string = ${JSON.stringify(html)}\n`)
+console.log(`terminal page: ${Math.round(html.length / 1024)} KiB`)
diff --git a/apps/mobile/src/shared.ts b/apps/mobile/src/shared.ts
new file mode 100644
index 0000000..463247a
--- /dev/null
+++ b/apps/mobile/src/shared.ts
@@ -0,0 +1,9 @@
+// What the phone takes from the repo's shared protocol code (Metro watches ../../src/shared).
+// Keep in step with MOBILE_ENTRIES in scripts/sharedForMobile.test.mjs.
+export * from '../../../src/shared/client/index.ts'
+export type * from '../../../src/shared/model/topics.ts'
+export type * from '../../../src/shared/model/types.ts'
+export { CAPABILITY, CLOSE_UNAUTHORIZED } from '../../../src/shared/protocolV2.ts'
+export type { AgentInfo, ServerAgents } from '../../../src/shared/protocolV2.ts'
+export type { ChangedFile, WorktreeChanges, SessionType, StackStatus, EnvironmentInfo } from '../../../src/shared/types.ts'
+export type { PromoteRequestEvent, PromoteSettledEvent } from '../../../src/shared/promote.ts'
diff --git a/apps/mobile/src/terminal/page.js b/apps/mobile/src/terminal/page.js
new file mode 100644
index 0000000..f82ad0a
--- /dev/null
+++ b/apps/mobile/src/terminal/page.js
@@ -0,0 +1,36 @@
+// Runs inside the session screen's WebView (6a): xterm.js at the pty's own size, fed by the app.
+// No network and no navigation (the page's CSP and the WebView's rules); the app talks to it with
+// window.__trek(message) and it answers through ReactNativeWebView.postMessage.
+/* global Terminal */
+;(function () {
+  var post = function (m) {
+    window.ReactNativeWebView.postMessage(JSON.stringify(m))
+  }
+  var term = new Terminal({
+    fontFamily: 'Menlo, monospace',
+    fontSize: 11,
+    scrollback: 5000,
+    allowProposedApi: false,
+    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' }
+  })
+  term.open(document.getElementById('t'))
+  term.onData(function (data) {
+    post({ type: 'input', data: data })
+  })
+  // The pty's size (the server's, shared with the desktop's view): the font shrinks to fit the
+  // width, down to 6 px; past that the page scrolls sideways.
+  var fitFont = function (cols) {
+    var width = window.innerWidth - 8
+    var size = Math.max(6, Math.min(13, Math.floor(width / (cols * 0.6))))
+    if (term.options.fontSize !== size) term.options.fontSize = size
+  }
+  window.__trek = function (m) {
+    if (m.type === 'data') term.write(m.data)
+    else if (m.type === 'reset') term.reset()
+    else if (m.type === 'size') {
+      fitFont(m.cols)
+      term.resize(m.cols, m.rows)
+    } else if (m.type === 'focus') term.focus()
+  }
+  post({ type: 'ready' })
+})()
diff --git a/apps/mobile/src/ui/Button.tsx b/apps/mobile/src/ui/Button.tsx
new file mode 100644
index 0000000..e328f96
--- /dev/null
+++ b/apps/mobile/src/ui/Button.tsx
@@ -0,0 +1,16 @@
+import { Pressable, Text } from 'react-native'
+import { ui } from './theme.ts'
+
+export function Button({ label, onPress, disabled, ghost, danger }: { label: string; onPress: () => void; disabled?: boolean; ghost?: boolean; danger?: boolean }): React.JSX.Element {
+  return (
+    <Pressable
+      accessibilityRole="button"
+      accessibilityState={{ disabled: !!disabled }}
+      disabled={disabled}
+      onPress={onPress}
+      style={({ pressed }) => [ghost ? ui.ghost : ui.button, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
+    >
+      <Text style={[ghost ? ui.ghostText : ui.buttonText, danger ? { color: '#f38ba8' } : null]}>{label}</Text>
+    </Pressable>
+  )
+}
diff --git a/apps/mobile/src/ui/theme.ts b/apps/mobile/src/ui/theme.ts
new file mode 100644
index 0000000..4424bf2
--- /dev/null
+++ b/apps/mobile/src/ui/theme.ts
@@ -0,0 +1,33 @@
+// Colours and shared styles (dark, like the desktop app).
+import { StyleSheet } from 'react-native'
+
+export const colors = {
+  bg: '#1e1e2e',
+  panel: '#262637',
+  border: '#3a3a4f',
+  text: '#cdd6f4',
+  muted: '#9399b2',
+  accent: '#89b4fa',
+  attention: '#e2a336',
+  danger: '#f38ba8',
+  ok: '#85d8a3'
+}
+
+export const ui = StyleSheet.create({
+  screen: { flex: 1, backgroundColor: colors.bg },
+  pad: { padding: 16, gap: 12 },
+  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
+  card: { backgroundColor: colors.panel, borderRadius: 10, padding: 12, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
+  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
+  text: { color: colors.text, fontSize: 14 },
+  muted: { color: colors.muted, fontSize: 13 },
+  warn: { color: colors.attention, fontSize: 13 },
+  error: { color: colors.danger, fontSize: 13 },
+  heading: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 8 },
+  input: { color: colors.text, backgroundColor: colors.panel, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
+  button: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
+  buttonText: { color: '#11111b', fontWeight: '600', fontSize: 15 },
+  ghost: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
+  ghostText: { color: colors.text, fontSize: 14 },
+  mono: { fontFamily: 'Menlo', fontSize: 12, color: colors.text }
+})
diff --git a/apps/mobile/tsconfig.json b/apps/mobile/tsconfig.json
new file mode 100644
index 0000000..7981440
--- /dev/null
+++ b/apps/mobile/tsconfig.json
@@ -0,0 +1,10 @@
+{
+  "extends": "expo/tsconfig.base",
+  "compilerOptions": {
+    "strict": true,
+    "noEmit": true,
+    // The shared code (../../src/shared) imports its siblings with their .ts extension.
+    "allowImportingTsExtensions": true
+  },
+  "include": ["app", "src", "expo-env.d.ts", ".expo/types/**/*.ts"]
+}
diff --git a/scripts/sharedForMobile.test.mjs b/scripts/sharedForMobile.test.mjs
index 257eee7..7c99963 100644
--- a/scripts/sharedForMobile.test.mjs
+++ b/scripts/sharedForMobile.test.mjs
@@ -10,7 +10,7 @@ import { dirname, join, relative, resolve } from 'node:path'
 
 const root = resolve(new URL('..', import.meta.url).pathname)
 /** What apps/mobile imports from the shared code (keep in step with apps/mobile/src/shared.ts). */
-export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts']
+export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts', 'src/shared/types.ts', 'src/shared/promote.ts']
 /** Packages the phone also has (none today: the shared code is dependency-free). */
 const ALLOWED_PACKAGES = new Set([])
 
@@ -74,6 +74,13 @@ test('the shared code the phone imports runs on React Native: no Node, Electron,
   assert.deepEqual(problems, [])
 })
 
+test("apps/mobile/src/shared.ts imports only these entry points", () => {
+  const src = readFileSync(join(root, 'apps/mobile/src/shared.ts'), 'utf8')
+  const imported = [...src.matchAll(/from '\.\.\/\.\.\/\.\.\/(src\/shared\/[^']+)'/g)].map((m) => m[1])
+  assert.ok(imported.length > 0)
+  for (const path of imported) assert.ok(MOBILE_ENTRIES.includes(path), `${path} is not in MOBILE_ENTRIES`)
+})
+
 test('the guard catches what it should (a planted Node import and a DOM global)', () => {
   assert.match("import { readFile } from 'node:fs'", IMPORT_RE)
   IMPORT_RE.lastIndex = 0
```

### Task 5: The phone's connections, Servers and pairing

(Prototype commit `ea9d9bf`.)

Secure storage, the provider (connections, background grace, attention, notifications), the root layout, Servers, Add server (scan, type, or a token) and the `trek://pair` link (Decisions 12–14).

- [ ] **Step 1: write the files below.**
- [ ] **Step 2: run.** `cd apps/mobile && npm run typecheck`.
- [ ] **Step 3: commit.**

```diff
diff --git a/apps/mobile/app/_layout.tsx b/apps/mobile/app/_layout.tsx
new file mode 100644
index 0000000..c7becfc
--- /dev/null
+++ b/apps/mobile/app/_layout.tsx
@@ -0,0 +1,31 @@
+import { Stack } from 'expo-router'
+import { StatusBar } from 'expo-status-bar'
+import * as Notifications from 'expo-notifications'
+import { ServersProvider } from '../src/state/ServersProvider.tsx'
+import { colors } from '../src/ui/theme.ts'
+
+// A notification that arrives while the app is open is shown as a banner, without sound.
+Notifications.setNotificationHandler({
+  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
+})
+
+export default function RootLayout(): React.JSX.Element {
+  return (
+    <ServersProvider>
+      <StatusBar style="light" />
+      <Stack
+        screenOptions={{
+          headerStyle: { backgroundColor: colors.panel },
+          headerTintColor: colors.text,
+          contentStyle: { backgroundColor: colors.bg }
+        }}
+      >
+        <Stack.Screen name="index" options={{ title: 'Attention' }} />
+        <Stack.Screen name="servers" options={{ title: 'Servers' }} />
+        <Stack.Screen name="add-server" options={{ title: 'Add server', presentation: 'modal' }} />
+        <Stack.Screen name="pair" options={{ title: 'Add server' }} />
+        <Stack.Screen name="projects" options={{ title: 'Projects' }} />
+      </Stack>
+    </ServersProvider>
+  )
+}
diff --git a/apps/mobile/app/add-server.tsx b/apps/mobile/app/add-server.tsx
new file mode 100644
index 0000000..c922a28
--- /dev/null
+++ b/apps/mobile/app/add-server.tsx
@@ -0,0 +1,111 @@
+// Add a server (6a): scan the desktop's QR (or type its address and code), and the phone redeems
+// the one-time code for its own token. Or type an address and an existing named token. A
+// trek://pair link only fills this form: nothing is sent until Pair is tapped.
+import { useState } from 'react'
+import { ScrollView, Text, TextInput, View } from 'react-native'
+import { router, useLocalSearchParams } from 'expo-router'
+import { CameraView, useCameraPermissions } from 'expo-camera'
+import * as Device from 'expo-device'
+import { globalSocketFactory, parsePairingLink, redeemPairingCode, PairingError } from '../src/shared.ts'
+import { checkServerUrl } from '../src/logic/serverUrl.ts'
+import { useServers } from '../src/state/ServersProvider.tsx'
+import { Button } from '../src/ui/Button.tsx'
+import { ui } from '../src/ui/theme.ts'
+
+const randomId = (): string => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
+
+export default function AddServer(): React.JSX.Element {
+  const params = useLocalSearchParams<{ url?: string; code?: string }>()
+  const { add } = useServers()
+  const [mode, setMode] = useState<'code' | 'token'>('code')
+  const [url, setUrl] = useState(params.url ?? '')
+  const [code, setCode] = useState(params.code ?? '')
+  const [token, setToken] = useState('')
+  const [deviceName, setDeviceName] = useState(Device.deviceName ?? 'phone')
+  const [scanning, setScanning] = useState(false)
+  const [permission, requestPermission] = useCameraPermissions()
+  const [busy, setBusy] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+
+  const checked = url.trim() ? checkServerUrl(url) : null
+
+  const scan = async (): Promise<void> => {
+    setError(null)
+    const granted = permission?.granted || (await requestPermission()).granted
+    if (!granted) {
+      setError('Trek needs the camera to scan the code. You can type the address and code instead.')
+      return
+    }
+    setScanning(true)
+  }
+
+  const scanned = (data: string): void => {
+    const link = parsePairingLink(data)
+    if (!link) return
+    setScanning(false)
+    setMode('code')
+    setUrl(link.url)
+    setCode(link.code)
+  }
+
+  const submit = async (): Promise<void> => {
+    if (!checked?.ok) return
+    setBusy(true)
+    setError(null)
+    try {
+      if (mode === 'code') {
+        const paired = await redeemPairingCode({ url: checked.url, code: code.trim(), deviceName: deviceName.trim() || 'phone', createSocket: globalSocketFactory, client: 'trek-mobile', clientVersion: '0.1.0' })
+        await add({ id: paired.serverId || randomId(), name: paired.serverName || new URL(checked.url).hostname, url: checked.url }, paired.token)
+      } else {
+        await add({ id: randomId(), name: new URL(checked.url).hostname, url: checked.url }, token.trim())
+      }
+      router.replace('/servers')
+    } catch (err) {
+      setError(err instanceof PairingError ? err.message : `Could not add the server: ${String(err)}`)
+    } finally {
+      setBusy(false)
+    }
+  }
+
+  if (scanning) {
+    return (
+      <View style={ui.screen}>
+        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scanned(data)} />
+        <View style={ui.pad}>
+          <Text style={ui.muted}>Point the camera at the QR in the desktop app's Pair a phone…</Text>
+          <Button ghost label="Cancel" onPress={() => setScanning(false)} />
+        </View>
+      </View>
+    )
+  }
+
+  return (
+    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
+      <Button label="Scan the pairing code" onPress={() => void scan()} />
+      <Text style={ui.heading}>Or type it</Text>
+      <Text style={ui.muted}>Server address</Text>
+      <TextInput style={ui.input} value={url} onChangeText={setUrl} placeholder="wss://dev.example.com" placeholderTextColor="#6c7086" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Server address" />
+      {checked && !checked.ok ? <Text style={ui.error}>{checked.message}</Text> : null}
+      {checked?.ok && checked.warning ? <Text style={ui.warn}>{checked.warning}</Text> : null}
+      <View style={ui.row}>
+        <Button ghost label={mode === 'code' ? '• Pairing code' : 'Pairing code'} onPress={() => setMode('code')} />
+        <Button ghost label={mode === 'token' ? '• Access token' : 'Access token'} onPress={() => setMode('token')} />
+      </View>
+      {mode === 'code' ? (
+        <>
+          <Text style={ui.muted}>Code (works once, for 5 minutes)</Text>
+          <TextInput style={ui.input} value={code} onChangeText={setCode} placeholder="ABCDE-FGHIJ-…" placeholderTextColor="#6c7086" autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Pairing code" />
+          <Text style={ui.muted}>This phone's name (the token is named after it)</Text>
+          <TextInput style={ui.input} value={deviceName} onChangeText={setDeviceName} autoCorrect={false} accessibilityLabel="Phone name" />
+        </>
+      ) : (
+        <>
+          <Text style={ui.muted}>A named token from trek-server token add</Text>
+          <TextInput style={ui.input} value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="Access token" />
+        </>
+      )}
+      <Button label={busy ? 'Pairing…' : mode === 'code' ? 'Pair' : 'Add'} disabled={busy || !checked?.ok || (mode === 'code' ? !code.trim() : !token.trim())} onPress={() => void submit()} />
+      {error ? <Text style={ui.error}>{error}</Text> : null}
+    </ScrollView>
+  )
+}
diff --git a/apps/mobile/app/pair.tsx b/apps/mobile/app/pair.tsx
new file mode 100644
index 0000000..65e0866
--- /dev/null
+++ b/apps/mobile/app/pair.tsx
@@ -0,0 +1,8 @@
+// A trek://pair?url=…&code=… link (the desktop's QR, opened by the camera app): only fills the
+// Add server form; nothing is redeemed without a tap there.
+import { Redirect, useLocalSearchParams } from 'expo-router'
+
+export default function PairLink(): React.JSX.Element {
+  const { url, code } = useLocalSearchParams<{ url?: string; code?: string }>()
+  return <Redirect href={{ pathname: '/add-server', params: { url: url ?? '', code: code ?? '' } }} />
+}
diff --git a/apps/mobile/app/servers.tsx b/apps/mobile/app/servers.tsx
new file mode 100644
index 0000000..b9cdc86
--- /dev/null
+++ b/apps/mobile/app/servers.tsx
@@ -0,0 +1,54 @@
+// The paired servers and their connection state (6a). Removing one forgets its token on this
+// phone only: it stays valid on the server until revoked there.
+import { Alert, FlatList, Text, View } from 'react-native'
+import { Link } from 'expo-router'
+import { statusLabel, useServers } from '../src/state/ServersProvider.tsx'
+import { Button } from '../src/ui/Button.tsx'
+import { colors, ui } from '../src/ui/theme.ts'
+
+export default function ServersScreen(): React.JSX.Element {
+  const { servers, remove } = useServers()
+  const confirmRemove = (id: string, name: string): void => {
+    Alert.alert(
+      `Remove ${name}?`,
+      'Its token is deleted from this phone. It stays valid on the server until you revoke it there (the desktop app, or trek-server token revoke).',
+      [
+        { text: 'Cancel', style: 'cancel' },
+        { text: 'Remove', style: 'destructive', onPress: () => void remove(id) }
+      ]
+    )
+  }
+  return (
+    <View style={ui.screen}>
+      <FlatList
+        contentContainerStyle={ui.pad}
+        data={servers}
+        keyExtractor={(s) => s.id}
+        ListEmptyComponent={<Text style={ui.muted}>No servers yet.</Text>}
+        renderItem={({ item }) => (
+          <View style={ui.card}>
+            <Text style={ui.title}>{item.name}</Text>
+            <Text style={ui.muted}>{item.url}</Text>
+            <Text style={item.status === 'connected' ? { color: colors.ok } : item.status === 'needs-auth' ? ui.warn : ui.muted}>
+              {statusLabel(item.status)}
+              {item.message && item.status !== 'connected' ? ` · ${item.message}` : ''}
+            </Text>
+            <View style={[ui.row, { marginTop: 6 }]}>
+              {item.status === 'needs-auth' ? (
+                <Link href={{ pathname: '/add-server', params: { url: item.url } }} style={{ color: colors.accent }}>
+                  Pair again
+                </Link>
+              ) : null}
+              <Button ghost danger label="Remove" onPress={() => confirmRemove(item.id, item.name)} />
+            </View>
+          </View>
+        )}
+        ListFooterComponent={
+          <Link href="/add-server" style={{ color: colors.accent, fontSize: 16, marginTop: 12 }}>
+            Add server
+          </Link>
+        }
+      />
+    </View>
+  )
+}
diff --git a/apps/mobile/src/logic/attention.ts b/apps/mobile/src/logic/attention.ts
new file mode 100644
index 0000000..c596313
--- /dev/null
+++ b/apps/mobile/src/logic/attention.ts
@@ -0,0 +1,45 @@
+// The home tab (6a): what needs the user across every paired server, newest first. Pure.
+import type { AttentionEntry } from '../shared.ts'
+
+export interface AttentionItem extends AttentionEntry {
+  /** The phone's id for the server entry */
+  serverId: string
+  serverName: string
+  /** Unique across servers, for list keys and "already notified" */
+  key: string
+}
+
+export function mergeAttention(perServer: { serverId: string; serverName: string; entries: AttentionEntry[] }[]): AttentionItem[] {
+  const items: AttentionItem[] = []
+  for (const { serverId, serverName, entries } of perServer) {
+    for (const entry of entries) {
+      const ref = entry.sessionId || `pr:${entry.worktreeId ?? ''}`
+      items.push({ ...entry, serverId, serverName, key: `${serverId}/${entry.projectId}/${ref}/${entry.since}` })
+    }
+  }
+  return items.sort((a, b) => b.since - a.since || a.key.localeCompare(b.key))
+}
+
+/** One line for the list and the notification. */
+export function attentionText(item: AttentionEntry): string {
+  if (item.decision) return `Decision: ${item.decision.question}`
+  if (item.pullRequest) return item.pullRequest.text
+  if (item.status === 'done') return 'Finished'
+  return 'Needs you'
+}
+
+/** The items not seen before (by key), for local notifications. */
+export function newItems(items: AttentionItem[], seen: ReadonlySet<string>): AttentionItem[] {
+  return items.filter((i) => !seen.has(i.key))
+}
+
+/** "3 min ago" */
+export function ago(since: number, now: number): string {
+  const s = Math.max(0, Math.round((now - since) / 1000))
+  if (s < 60) return 'just now'
+  const m = Math.round(s / 60)
+  if (m < 60) return `${m} min ago`
+  const h = Math.round(m / 60)
+  if (h < 24) return `${h} h ago`
+  return `${Math.round(h / 24)} d ago`
+}
diff --git a/apps/mobile/src/logic/serverUrl.ts b/apps/mobile/src/logic/serverUrl.ts
new file mode 100644
index 0000000..f92ccf7
--- /dev/null
+++ b/apps/mobile/src/logic/serverUrl.ts
@@ -0,0 +1,40 @@
+// Which server addresses the phone connects to (6a): wss:// always; plain ws:// only to this
+// device, a private LAN or Tailscale address (with a warning: the token travels unencrypted on
+// that network). Pure, so `node --test` covers it (scripts/mobileLogic.test.mjs).
+
+export type UrlCheck = { ok: true; url: string; warning?: string } | { ok: false; message: string }
+
+const PLAIN_WARNING = 'Not encrypted: anyone on this network can read the traffic, the token included. Use wss:// through a TLS proxy when you can.'
+
+function ipv4(host: string): number[] | null {
+  const parts = host.split('.')
+  if (parts.length !== 4) return null
+  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
+  return nums.every((n) => n >= 0 && n <= 255) ? nums : null
+}
+
+/** Loopback, RFC 1918, link-local, Tailscale's 100.64/10, IPv6 ULA and link-local, and .local names. */
+export function isPrivateHost(hostname: string): boolean {
+  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
+  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true
+  const v4 = ipv4(host.startsWith('::ffff:') ? host.slice(7) : host)
+  if (v4) {
+    const [a, b] = v4
+    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
+  }
+  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
+}
+
+export function checkServerUrl(input: string): UrlCheck {
+  const text = input.trim()
+  let url: URL
+  try {
+    url = new URL(text)
+  } catch {
+    return { ok: false, message: 'Enter the server address, like wss://dev.example.com' }
+  }
+  if (url.protocol === 'wss:') return { ok: true, url: text }
+  if (url.protocol !== 'ws:') return { ok: false, message: 'The address starts with wss:// (or ws:// on a private network)' }
+  if (!isPrivateHost(url.hostname)) return { ok: false, message: 'Plain ws:// is only allowed to a private network address. Use wss://' }
+  return { ok: true, url: text, warning: PLAIN_WARNING }
+}
diff --git a/apps/mobile/src/state/ServersProvider.tsx b/apps/mobile/src/state/ServersProvider.tsx
new file mode 100644
index 0000000..02b13d5
--- /dev/null
+++ b/apps/mobile/src/state/ServersProvider.tsx
@@ -0,0 +1,202 @@
+// The phone's connections (6a): one SDK connection per paired server, closed when the app goes
+// to the background (after a short grace) and opened again when it returns; the SDK resubscribes
+// and re-attaches on its own after a reconnect. Each server's `attention` topic feeds the home tab
+// and, while the app is in its background grace, local notifications.
+import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
+import { AppState, type AppStateStatus } from 'react-native'
+import * as Notifications from 'expo-notifications'
+import { ServerRegistry, globalSocketFactory, type ConnectionStatus, type RegisteredServer, type AttentionEntry } from '../shared.ts'
+import { attentionText, mergeAttention, newItems, type AttentionItem } from '../logic/attention.ts'
+import { forgetServer, loadServers, loadToken, saveServer, type SavedServer } from './storage.ts'
+
+/** How long the connections stay up after the app leaves the foreground (iOS suspends it soon after anyway). */
+const BACKGROUND_GRACE_MS = 20_000
+
+export interface ServerView extends SavedServer {
+  status: ConnectionStatus | 'no-token'
+  message: string
+  capabilities: string[]
+}
+
+interface ServersValue {
+  ready: boolean
+  servers: ServerView[]
+  attention: AttentionItem[]
+  /** The live connection to a server, while the app is in the foreground */
+  get(id: string): RegisteredServer | undefined
+  /** Bumped each time the connections are made again: screens re-subscribe on it */
+  generation: number
+  add(server: SavedServer, token: string): Promise<void>
+  remove(id: string): Promise<void>
+}
+
+const ServersContext = createContext<ServersValue | null>(null)
+
+export function useServers(): ServersValue {
+  const value = useContext(ServersContext)
+  if (!value) throw new Error('useServers outside ServersProvider')
+  return value
+}
+
+export function ServersProvider({ children }: { children: ReactNode }): React.JSX.Element {
+  const registry = useMemo(() => new ServerRegistry({ createSocket: globalSocketFactory, client: 'trek-mobile', clientVersion: '0.1.0' }), [])
+  const [saved, setSaved] = useState<SavedServer[]>([])
+  const [ready, setReady] = useState(false)
+  const [generation, setGeneration] = useState(0)
+  const [statuses, setStatuses] = useState<Record<string, { status: ConnectionStatus; message: string; capabilities: string[] }>>({})
+  const [attentionByServer, setAttentionByServer] = useState<Record<string, AttentionEntry[]>>({})
+  const appState = useRef<AppStateStatus>((AppState.currentState as AppStateStatus | null | undefined) ?? 'active')
+  const notified = useRef(new Set<string>())
+  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
+  const detachers = useRef(new Map<string, () => void>())
+  const savedRef = useRef<SavedServer[]>([])
+  savedRef.current = saved
+
+  const disconnect = useCallback((id: string) => {
+    detachers.current.get(id)?.()
+    detachers.current.delete(id)
+    registry.remove(id)
+  }, [registry])
+
+  const connect = useCallback(
+    async (server: SavedServer) => {
+      if (registry.get(server.id)) return
+      const token = await loadToken(server.id)
+      if (!token || registry.get(server.id)) return
+      const registered = registry.add({ id: server.id, url: server.url, token })
+      const offStatus = registered.connection.on('status', ({ status, message }) =>
+        setStatuses((s) => ({ ...s, [server.id]: { status, message, capabilities: registered.connection.welcome?.capabilities ?? [] } }))
+      )
+      const offAttention = registered.mirror.subscribe('attention', (update) => {
+        if ('error' in update) return
+        setAttentionByServer((a) => ({ ...a, [server.id]: update.snapshot.entries }))
+      })
+      detachers.current.set(server.id, () => {
+        offStatus()
+        offAttention()
+      })
+    },
+    [registry]
+  )
+
+  const connectAll = useCallback(async () => {
+    await Promise.all(savedRef.current.map(connect))
+    setGeneration((g) => g + 1)
+  }, [connect])
+
+  const disconnectAll = useCallback(() => {
+    for (const s of savedRef.current) disconnect(s.id)
+    setGeneration((g) => g + 1)
+  }, [disconnect])
+
+  useEffect(() => {
+    void loadServers().then((list) => {
+      setSaved(list)
+      savedRef.current = list
+      setReady(true)
+      void connectAll()
+    })
+    return () => disconnectAll()
+    // Once: the list is then kept by add/remove.
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, [])
+
+  // Background: keep the sockets for a short grace (local notifications can still fire), then
+  // close them. Foreground: connect again.
+  useEffect(() => {
+    const sub = AppState.addEventListener('change', (next) => {
+      const prev = appState.current
+      appState.current = next
+      if (next === 'active') {
+        if (graceTimer.current) clearTimeout(graceTimer.current)
+        graceTimer.current = null
+        if (prev !== 'active') void connectAll()
+      } else if (prev === 'active') {
+        graceTimer.current = setTimeout(() => {
+          graceTimer.current = null
+          disconnectAll()
+        }, BACKGROUND_GRACE_MS)
+      }
+    })
+    return () => sub.remove()
+  }, [connectAll, disconnectAll])
+
+  const servers: ServerView[] = saved.map((s) => {
+    const st = statuses[s.id]
+    return { ...s, status: st?.status ?? 'disconnected', message: st?.message ?? '', capabilities: st?.capabilities ?? [] }
+  })
+
+  const attention = useMemo(
+    () =>
+      mergeAttention(
+        saved.map((s) => ({ serverId: s.id, serverName: s.name, entries: attentionByServer[s.id] ?? [] }))
+      ),
+    [saved, attentionByServer]
+  )
+
+  // A local notification for each new item, but only out of the foreground (the list is on screen
+  // otherwise). The first snapshot after connecting counts as seen.
+  useEffect(() => {
+    const fresh = newItems(attention, notified.current)
+    for (const item of attention) notified.current.add(item.key)
+    if (appState.current === 'active') return
+    for (const item of fresh) {
+      void Notifications.scheduleNotificationAsync({
+        content: { title: `${item.projectName}: ${item.title}`, body: attentionText(item), data: { serverId: item.serverId, projectId: item.projectId, sessionId: item.sessionId } },
+        trigger: null
+      }).catch(() => {})
+    }
+  }, [attention])
+
+  const add = useCallback(
+    async (server: SavedServer, token: string) => {
+      disconnect(server.id)
+      await saveServer(server, token)
+      const list = [...savedRef.current.filter((s) => s.id !== server.id), server]
+      savedRef.current = list
+      setSaved(list)
+      await connect(server)
+      setGeneration((g) => g + 1)
+    },
+    [connect, disconnect]
+  )
+
+  const remove = useCallback(
+    async (id: string) => {
+      disconnect(id)
+      await forgetServer(id)
+      const list = savedRef.current.filter((s) => s.id !== id)
+      savedRef.current = list
+      setSaved(list)
+      setAttentionByServer((a) => {
+        const { [id]: _gone, ...rest } = a
+        return rest
+      })
+    },
+    [disconnect]
+  )
+
+  const value: ServersValue = { ready, servers, attention, get: (id) => registry.get(id), generation, add, remove }
+  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>
+}
+
+/** The status in a few words, for the server list. */
+export function statusLabel(status: ServerView['status']): string {
+  switch (status) {
+    case 'connected':
+      return 'Connected'
+    case 'connecting':
+      return 'Connecting…'
+    case 'needs-auth':
+      return 'Pair again'
+    case 'incompatible':
+      return 'Update the server or the app'
+    case 'no-token':
+      return 'No token'
+    case 'error':
+    case 'disconnected':
+      return 'Reconnecting…'
+    default:
+      return 'Not connected'
+  }
+}
diff --git a/apps/mobile/src/state/hooks.ts b/apps/mobile/src/state/hooks.ts
new file mode 100644
index 0000000..c94efbc
--- /dev/null
+++ b/apps/mobile/src/state/hooks.ts
@@ -0,0 +1,40 @@
+// A topic's snapshot while a screen shows it, subscribed through the server's SDK mirror (and
+// unsubscribed when the screen goes); again after the connections are made again.
+import { useEffect, useState } from 'react'
+import type { RegisteredServer, Topic, TopicSnapshot } from '../shared.ts'
+import { useServers } from './ServersProvider.tsx'
+
+export type TopicView<T extends Topic> = { state: 'loading' } | { state: 'ready'; snapshot: TopicSnapshot<T> } | { state: 'error'; message: string }
+
+export function useTopic<T extends Topic>(serverId: string, topic: T | null): TopicView<T> {
+  const { get, generation } = useServers()
+  const [view, setView] = useState<TopicView<T>>({ state: 'loading' })
+  useEffect(() => {
+    if (!topic) return
+    const server = get(serverId)
+    if (!server) {
+      setView({ state: 'error', message: 'Not connected' })
+      return
+    }
+    setView({ state: 'loading' })
+    return server.mirror.subscribe(topic, (update) => {
+      if ('error' in update) setView({ state: 'error', message: update.error.message })
+      else setView({ state: 'ready', snapshot: update.snapshot as TopicSnapshot<T> })
+    })
+    // get is stable per generation
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, [serverId, topic, generation])
+  return view
+}
+
+/** The server's live connection, or undefined (out of the foreground, or not paired). */
+export function useServer(serverId: string): RegisteredServer | undefined {
+  const { get, generation } = useServers()
+  void generation
+  return get(serverId)
+}
+
+/** The server's error message, as the server worded it. */
+export function errorMessage(err: unknown): string {
+  return err instanceof Error ? err.message : String(err)
+}
diff --git a/apps/mobile/src/state/storage.ts b/apps/mobile/src/state/storage.ts
new file mode 100644
index 0000000..32a239e
--- /dev/null
+++ b/apps/mobile/src/state/storage.ts
@@ -0,0 +1,50 @@
+// The paired servers (6a): the list (name and URL) and each one's token, both in the device's
+// secure storage (Keychain / Android Keystore). Only this module and the connection layer read a
+// token; it is never logged or shown.
+import * as SecureStore from 'expo-secure-store'
+
+export interface SavedServer {
+  /** The phone's id for the entry (the server's own serverId when known) */
+  id: string
+  name: string
+  url: string
+}
+
+const LIST_KEY = 'trek.servers'
+const tokenKey = (id: string): string => `trek.token.${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
+const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
+
+export async function loadServers(): Promise<SavedServer[]> {
+  const raw = await SecureStore.getItemAsync(LIST_KEY, OPTIONS)
+  if (!raw) return []
+  try {
+    const parsed: unknown = JSON.parse(raw)
+    if (!Array.isArray(parsed)) return []
+    return parsed.filter(
+      (s): s is SavedServer => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string'
+    )
+  } catch {
+    return []
+  }
+}
+
+async function saveList(servers: SavedServer[]): Promise<void> {
+  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(servers), OPTIONS)
+}
+
+export async function loadToken(id: string): Promise<string | null> {
+  return SecureStore.getItemAsync(tokenKey(id), OPTIONS)
+}
+
+/** Adds or replaces the entry with that id, and stores its token. */
+export async function saveServer(server: SavedServer, token: string): Promise<void> {
+  await SecureStore.setItemAsync(tokenKey(server.id), token, OPTIONS)
+  const list = (await loadServers()).filter((s) => s.id !== server.id)
+  await saveList([...list, server])
+}
+
+/** Forgets the entry and its token on this phone (the token stays valid on the server until revoked). */
+export async function forgetServer(id: string): Promise<void> {
+  await SecureStore.deleteItemAsync(tokenKey(id), OPTIONS)
+  await saveList((await loadServers()).filter((s) => s.id !== id))
+}
```

### Task 6: Attention, Projects, a worktree and its Changes

(Prototype commit `5d525c9`.)

The home list (a decision answered inline), the projects, a project's worktrees, a worktree's actions and sessions, and the read-only Changes (Decisions 17, 18 and 20).

- [ ] **Step 1: write the files below.**
- [ ] **Step 2: run.** `cd apps/mobile && npm run typecheck`.
- [ ] **Step 3: commit.**

```diff
diff --git a/apps/mobile/app/changes/[serverId]/[projectId]/[worktreeId].tsx b/apps/mobile/app/changes/[serverId]/[projectId]/[worktreeId].tsx
new file mode 100644
index 0000000..e476387
--- /dev/null
+++ b/apps/mobile/app/changes/[serverId]/[projectId]/[worktreeId].tsx
@@ -0,0 +1,81 @@
+// A worktree's changes (6a), read-only: the branch against its base (the desktop's default view),
+// each file's patch on tap. No review comments on the phone.
+import { useCallback, useEffect, useState } from 'react'
+import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
+import { useLocalSearchParams } from 'expo-router'
+import type { WorktreeChanges } from '../../../../src/shared.ts'
+import { errorMessage, useServer } from '../../../../src/state/hooks.ts'
+import { classifyDiff } from '../../../../src/logic/diff.ts'
+import { colors, ui } from '../../../../src/ui/theme.ts'
+
+const LINE_COLOR = { add: colors.ok, del: colors.danger, hunk: colors.accent, meta: colors.muted, context: colors.text }
+
+export default function ChangesScreen(): React.JSX.Element {
+  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
+  const server = useServer(serverId)
+  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
+  const [open, setOpen] = useState<string | null>(null)
+  const [patches, setPatches] = useState<Record<string, string>>({})
+  const [error, setError] = useState<string | null>(null)
+  const [loading, setLoading] = useState(false)
+
+  const load = useCallback(async () => {
+    if (!server) return
+    setLoading(true)
+    setError(null)
+    try {
+      setChanges(await server.connection.request('worktree.changes', { projectId, worktreeId }))
+      setPatches({})
+    } catch (err) {
+      setError(errorMessage(err))
+    } finally {
+      setLoading(false)
+    }
+  }, [server, projectId, worktreeId])
+  useEffect(() => {
+    void load()
+  }, [load])
+
+  const toggle = async (path: string): Promise<void> => {
+    if (open === path) return setOpen(null)
+    setOpen(path)
+    if (patches[path] !== undefined || !server) return
+    try {
+      const result = await server.connection.request('worktree.diff', { projectId, worktreeId, paths: [path] })
+      setPatches((p) => ({ ...p, [path]: result[path] ?? '' }))
+    } catch (err) {
+      setPatches((p) => ({ ...p, [path]: `Could not read the diff: ${errorMessage(err)}` }))
+    }
+  }
+
+  return (
+    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
+      {error ? <Text style={ui.error}>{error}</Text> : null}
+      {changes ? <Text style={ui.muted}>{changes.base ? `Against ${changes.base}, with the uncommitted work` : 'Uncommitted work'}</Text> : null}
+      {changes && changes.files.length === 0 ? <Text style={ui.muted}>No changes.</Text> : null}
+      {changes?.files.map((f) => (
+        <View key={f.path} style={ui.card}>
+          <Pressable accessibilityRole="button" onPress={() => void toggle(f.path)}>
+            <Text style={ui.text}>{f.path}</Text>
+            <Text style={ui.muted}>
+              {f.status}
+              {f.binary ? ' · binary' : ` · +${f.added} −${f.deleted}`}
+            </Text>
+          </Pressable>
+          {open === f.path ? (
+            <ScrollView horizontal>
+              <View>
+                {patches[f.path] === undefined ? <Text style={ui.muted}>Loading…</Text> : null}
+                {classifyDiff(patches[f.path] ?? '').map((line, i) => (
+                  <Text key={i} style={[ui.mono, { color: LINE_COLOR[line.kind] }]}>
+                    {line.text || ' '}
+                  </Text>
+                ))}
+              </View>
+            </ScrollView>
+          ) : null}
+        </View>
+      ))}
+    </ScrollView>
+  )
+}
diff --git a/apps/mobile/app/index.tsx b/apps/mobile/app/index.tsx
new file mode 100644
index 0000000..38de8da
--- /dev/null
+++ b/apps/mobile/app/index.tsx
@@ -0,0 +1,72 @@
+// Home: what needs you across every paired server, newest first (6a). A decision is answered here.
+import { useEffect, useState } from 'react'
+import { FlatList, Pressable, Text, View } from 'react-native'
+import { Link, router, Stack } from 'expo-router'
+import * as Notifications from 'expo-notifications'
+import { useServers } from '../src/state/ServersProvider.tsx'
+import { ago, attentionText, type AttentionItem } from '../src/logic/attention.ts'
+import { DecisionActions } from '../src/ui/DecisionActions.tsx'
+import { colors, ui } from '../src/ui/theme.ts'
+
+export default function AttentionScreen(): React.JSX.Element {
+  const { ready, servers, attention } = useServers()
+  const [now, setNow] = useState(() => Date.now())
+  useEffect(() => {
+    const t = setInterval(() => setNow(Date.now()), 30_000)
+    return () => clearInterval(t)
+  }, [])
+  // Asked once: local notifications for what needs you while the app is in the background.
+  useEffect(() => {
+    void Notifications.requestPermissionsAsync().catch(() => {})
+  }, [])
+
+  const open = (item: AttentionItem): void => {
+    if (item.sessionId) router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId: item.serverId, projectId: item.projectId, sessionId: item.sessionId } })
+    else if (item.worktreeId) router.push({ pathname: '/worktree/[serverId]/[projectId]/[worktreeId]', params: { serverId: item.serverId, projectId: item.projectId, worktreeId: item.worktreeId } })
+  }
+
+  return (
+    <View style={ui.screen}>
+      <Stack.Screen
+        options={{
+          headerLeft: () => (
+            <Link href="/servers" style={{ color: colors.accent, fontSize: 16 }}>
+              Servers
+            </Link>
+          ),
+          headerRight: () => (
+            <Link href="/projects" style={{ color: colors.accent, fontSize: 16 }}>
+              Projects
+            </Link>
+          )
+        }}
+      />
+      {ready && servers.length === 0 ? (
+        <View style={ui.pad}>
+          <Text style={ui.title}>No servers yet</Text>
+          <Text style={ui.muted}>On your desktop, open Trek's server list and choose Pair a phone… for a server, then add it here.</Text>
+          <Link href="/add-server" style={{ color: colors.accent, fontSize: 16 }}>
+            Add server
+          </Link>
+        </View>
+      ) : (
+        <FlatList
+          contentContainerStyle={ui.pad}
+          data={attention}
+          keyExtractor={(i) => i.key}
+          ListEmptyComponent={<Text style={ui.muted}>Nothing needs you.</Text>}
+          renderItem={({ item }) => (
+            <Pressable accessibilityRole="button" onPress={() => open(item)} style={ui.card}>
+              <Text style={ui.muted}>
+                {item.serverName} · {item.projectName} · {ago(item.since, now)}
+              </Text>
+              <Text style={ui.title}>{item.title}</Text>
+              <Text style={item.decision ? ui.warn : ui.text}>{attentionText(item)}</Text>
+              {item.decision && item.sessionId ? <DecisionActions serverId={item.serverId} projectId={item.projectId} sessionId={item.sessionId} /> : null}
+            </Pressable>
+          )}
+        />
+      )}
+    </View>
+  )
+}
diff --git a/apps/mobile/app/project/[serverId]/[projectId].tsx b/apps/mobile/app/project/[serverId]/[projectId].tsx
new file mode 100644
index 0000000..cf22789
--- /dev/null
+++ b/apps/mobile/app/project/[serverId]/[projectId].tsx
@@ -0,0 +1,51 @@
+// A project (6a): its repositories and worktrees, each with its branch, status and sessions.
+import { ScrollView, Pressable, Text, View } from 'react-native'
+import { router, Stack, useLocalSearchParams } from 'expo-router'
+import { useTopic } from '../../../src/state/hooks.ts'
+import { STATUS_TEXT, statusColor } from '../../../src/ui/status.ts'
+import { ui } from '../../../src/ui/theme.ts'
+
+export default function ProjectScreen(): React.JSX.Element {
+  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
+  const topic = useTopic(serverId, `project:${projectId}`)
+  return (
+    <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
+      <Stack.Screen options={{ title: topic.state === 'ready' ? topic.snapshot.name : 'Project' }} />
+      {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
+      {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
+      {topic.state === 'ready'
+        ? topic.snapshot.repositories.map((repo) => (
+            <View key={repo.id} style={{ gap: 8 }}>
+              <Text style={ui.heading}>{repo.name}</Text>
+              {repo.worktrees.map((wt) => (
+                <Pressable
+                  key={wt.id}
+                  accessibilityRole="button"
+                  style={ui.card}
+                  onPress={() => router.push({ pathname: '/worktree/[serverId]/[projectId]/[worktreeId]', params: { serverId, projectId, worktreeId: wt.id } })}
+                >
+                  <Text style={ui.title}>
+                    {wt.branch ?? wt.name}
+                    {wt.isMain ? ' (main checkout)' : ''}
+                  </Text>
+                  <Text style={ui.muted}>
+                    {wt.missing ? 'Missing · ' : ''}
+                    {wt.loaded ? 'Loaded' : 'Unloaded'}
+                    {wt.dirty ? ' · uncommitted changes' : ''}
+                    {wt.ahead ? ` · ${wt.ahead} ahead` : ''}
+                    {wt.behind ? ` · ${wt.behind} behind` : ''}
+                  </Text>
+                  {wt.sessions.map((s) => (
+                    <Text key={s.id} style={{ color: statusColor(s.status), fontSize: 13 }}>
+                      {s.title}: {STATUS_TEXT[s.status]}
+                      {s.decision ? ' · decision waiting' : ''}
+                    </Text>
+                  ))}
+                </Pressable>
+              ))}
+            </View>
+          ))
+        : null}
+    </ScrollView>
+  )
+}
diff --git a/apps/mobile/app/projects.tsx b/apps/mobile/app/projects.tsx
new file mode 100644
index 0000000..430ccf2
--- /dev/null
+++ b/apps/mobile/app/projects.tsx
@@ -0,0 +1,36 @@
+// Every paired server's projects (6a), from each server's `server` topic.
+import { FlatList, Pressable, Text, View } from 'react-native'
+import { router } from 'expo-router'
+import { useServers, statusLabel, type ServerView } from '../src/state/ServersProvider.tsx'
+import { useTopic } from '../src/state/hooks.ts'
+import { ui } from '../src/ui/theme.ts'
+
+function ServerProjects({ server }: { server: ServerView }): React.JSX.Element {
+  const topic = useTopic(server.id, server.status === 'connected' ? 'server' : null)
+  return (
+    <View style={{ gap: 8 }}>
+      <Text style={ui.heading}>
+        {server.name}
+        {server.status !== 'connected' ? ` · ${statusLabel(server.status)}` : ''}
+      </Text>
+      {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
+      {topic.state === 'ready' && topic.snapshot.projects.length === 0 ? <Text style={ui.muted}>No projects on this server.</Text> : null}
+      {topic.state === 'ready'
+        ? topic.snapshot.projects.map((p) => (
+            <Pressable key={p.id} accessibilityRole="button" style={ui.card} onPress={() => router.push({ pathname: '/project/[serverId]/[projectId]', params: { serverId: server.id, projectId: p.id } })}>
+              <Text style={ui.title}>{p.name}</Text>
+            </Pressable>
+          ))
+        : null}
+    </View>
+  )
+}
+
+export default function ProjectsScreen(): React.JSX.Element {
+  const { servers } = useServers()
+  return (
+    <View style={ui.screen}>
+      <FlatList contentContainerStyle={ui.pad} data={servers} keyExtractor={(s) => s.id} renderItem={({ item }) => <ServerProjects server={item} />} ListEmptyComponent={<Text style={ui.muted}>No servers yet.</Text>} />
+    </View>
+  )
+}
diff --git a/apps/mobile/app/worktree/[serverId]/[projectId]/[worktreeId].tsx b/apps/mobile/app/worktree/[serverId]/[projectId]/[worktreeId].tsx
new file mode 100644
index 0000000..58aa5b9
--- /dev/null
+++ b/apps/mobile/app/worktree/[serverId]/[projectId]/[worktreeId].tsx
@@ -0,0 +1,139 @@
+// A worktree (6a): load or unload it, start a session (agent and session type), its sessions
+// with close and restart, and the read-only Changes.
+import { useEffect, useState } from 'react'
+import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
+import { router, Stack, useLocalSearchParams } from 'expo-router'
+import { CAPABILITY, type AgentInfo, type Project, type SessionType, type Worktree } from '../../../../src/shared.ts'
+import { errorMessage, useServer, useTopic } from '../../../../src/state/hooks.ts'
+import { Button } from '../../../../src/ui/Button.tsx'
+import { STATUS_TEXT, statusColor } from '../../../../src/ui/status.ts'
+import { ui } from '../../../../src/ui/theme.ts'
+
+/** A new session's first size; the terminal screen resizes it to the phone's once it attaches. */
+const START_SIZE = { cols: 80, rows: 24 }
+
+function findWorktree(project: Project, worktreeId: string): Worktree | undefined {
+  for (const repo of project.repositories) for (const wt of repo.worktrees) if (wt.id === worktreeId) return wt
+  return undefined
+}
+
+export default function WorktreeScreen(): React.JSX.Element {
+  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
+  const server = useServer(serverId)
+  const topic = useTopic(serverId, `project:${projectId}`)
+  const [agents, setAgents] = useState<AgentInfo[]>([])
+  const [busy, setBusy] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+  const [picking, setPicking] = useState(false)
+
+  useEffect(() => {
+    if (!server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
+    void server.connection
+      .request('server.agents', { projectId })
+      .then((a) => setAgents(a.agents.filter((x) => x.installed)))
+      .catch(() => {})
+  }, [server, projectId])
+
+  const project = topic.state === 'ready' ? topic.snapshot : null
+  const worktree = project ? findWorktree(project, worktreeId) : undefined
+  const sessionTypes: SessionType[] = project?.settings.sessionTypes ?? []
+
+  const run = async (fn: () => Promise<unknown>): Promise<unknown> => {
+    if (!server) return
+    setBusy(true)
+    setError(null)
+    try {
+      return await fn()
+    } catch (err) {
+      setError(errorMessage(err))
+    } finally {
+      setBusy(false)
+    }
+  }
+  const req = server?.connection
+
+  const start = async (choice: { agent?: AgentInfo; type?: SessionType }): Promise<void> => {
+    setPicking(false)
+    const started = (await run(() =>
+      req!.request('session.start', {
+        projectId,
+        worktreeId,
+        ...START_SIZE,
+        ...(choice.agent ? { llm: { provider: choice.agent.provider } } : {}),
+        ...(choice.type ? { sessionTypeId: choice.type.id } : {})
+      })
+    )) as { sessionId: string } | undefined
+    if (started) router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId: started.sessionId } })
+  }
+
+  const confirmClose = (sessionId: string, title: string): void => {
+    Alert.alert(`Close ${title}?`, 'The session stops. Its history stays on the server.', [
+      { text: 'Cancel', style: 'cancel' },
+      { text: 'Close', style: 'destructive', onPress: () => void run(() => req!.request('session.close', { projectId, sessionId })) }
+    ])
+  }
+
+  return (
+    <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
+      <Stack.Screen options={{ title: worktree ? (worktree.branch ?? worktree.name) : 'Worktree' }} />
+      {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
+      {project && !worktree ? <Text style={ui.muted}>This worktree is gone.</Text> : null}
+      {worktree ? (
+        <>
+          <Text style={ui.muted}>{worktree.path}</Text>
+          <Text style={ui.text}>
+            {worktree.loaded ? 'Loaded' : 'Unloaded'}
+            {worktree.dirty ? ' · uncommitted changes' : ''}
+          </Text>
+          <View style={[ui.row, { flexWrap: 'wrap' }]}>
+            <Button
+              ghost
+              label={worktree.loaded ? 'Unload' : 'Load'}
+              disabled={busy || !server}
+              onPress={() => void run(() => req!.request(worktree.loaded ? 'worktree.unload' : 'worktree.load', { projectId, worktreeId }))}
+            />
+            <Button ghost label="Changes" onPress={() => router.push({ pathname: '/changes/[serverId]/[projectId]/[worktreeId]', params: { serverId, projectId, worktreeId } })} />
+            <Button label="New session" disabled={busy || !server} onPress={() => setPicking((p) => !p)} />
+          </View>
+          {picking ? (
+            <View style={ui.card}>
+              <Pressable accessibilityRole="button" onPress={() => void start({})}>
+                <Text style={ui.text}>The project's default agent</Text>
+              </Pressable>
+              {agents.map((a) => (
+                <Pressable key={a.provider} accessibilityRole="button" onPress={() => void start({ agent: a })}>
+                  <Text style={ui.text}>{a.label}</Text>
+                </Pressable>
+              ))}
+              {sessionTypes.length ? <Text style={ui.heading}>Session types</Text> : null}
+              {sessionTypes.map((t) => (
+                <Pressable key={t.id} accessibilityRole="button" onPress={() => void start({ type: t })}>
+                  <Text style={ui.text}>{t.name}</Text>
+                </Pressable>
+              ))}
+            </View>
+          ) : null}
+          {error ? <Text style={ui.error}>{error}</Text> : null}
+          <Text style={ui.heading}>Sessions</Text>
+          {worktree.sessions.length === 0 ? <Text style={ui.muted}>No sessions.</Text> : null}
+          {worktree.sessions.map((s) => (
+            <View key={s.id} style={ui.card}>
+              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId: s.id } })}>
+                <Text style={ui.title}>{s.title}</Text>
+                <Text style={{ color: statusColor(s.status) }}>
+                  {STATUS_TEXT[s.status]}
+                  {s.decision ? ` · ${s.decision.question}` : ''}
+                  {s.queue.length ? ` · ${s.queue.length} queued` : ''}
+                </Text>
+              </Pressable>
+              <View style={[ui.row, { marginTop: 6 }]}>
+                <Button ghost label="Restart" disabled={busy || !server} onPress={() => void run(() => req!.request('session.restart', { projectId, sessionId: s.id, ...START_SIZE }))} />
+                <Button ghost danger label="Close" disabled={busy || !server} onPress={() => confirmClose(s.id, s.title)} />
+              </View>
+            </View>
+          ))}
+        </>
+      ) : null}
+    </ScrollView>
+  )
+}
diff --git a/apps/mobile/src/logic/diff.ts b/apps/mobile/src/logic/diff.ts
new file mode 100644
index 0000000..6b01faa
--- /dev/null
+++ b/apps/mobile/src/logic/diff.ts
@@ -0,0 +1,14 @@
+// A unified diff's lines, classed for colouring (read-only Changes, 6a). Pure.
+export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'
+
+export function classifyDiff(patch: string): { kind: DiffLineKind; text: string }[] {
+  const lines = patch.split('\n')
+  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
+  return lines.map((text) => {
+    if (text.startsWith('@@')) return { kind: 'hunk', text }
+    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(text)) return { kind: 'meta', text }
+    if (text.startsWith('+')) return { kind: 'add', text }
+    if (text.startsWith('-')) return { kind: 'del', text }
+    return { kind: 'context', text }
+  })
+}
diff --git a/apps/mobile/src/ui/DecisionActions.tsx b/apps/mobile/src/ui/DecisionActions.tsx
new file mode 100644
index 0000000..ad389bc
--- /dev/null
+++ b/apps/mobile/src/ui/DecisionActions.tsx
@@ -0,0 +1,36 @@
+// A request_decision answered from the phone (6a): an answer typed to the session (which clears
+// the decision, as any input to the session does) or Dismiss (session.dismissDecision).
+import { useState } from 'react'
+import { Text, TextInput, View } from 'react-native'
+import { useServer, errorMessage } from '../state/hooks.ts'
+import { Button } from './Button.tsx'
+import { ui } from './theme.ts'
+
+export function DecisionActions({ serverId, projectId, sessionId }: { serverId: string; projectId: string; sessionId: string }): React.JSX.Element {
+  const server = useServer(serverId)
+  const [answer, setAnswer] = useState('')
+  const [busy, setBusy] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+  const run = async (fn: () => Promise<unknown>): Promise<void> => {
+    setBusy(true)
+    setError(null)
+    try {
+      await fn()
+      setAnswer('')
+    } catch (err) {
+      setError(errorMessage(err))
+    } finally {
+      setBusy(false)
+    }
+  }
+  return (
+    <View style={{ gap: 8, marginTop: 8 }}>
+      <TextInput style={ui.input} placeholder="Your answer" placeholderTextColor="#6c7086" value={answer} onChangeText={setAnswer} accessibilityLabel="Your answer" />
+      <View style={ui.row}>
+        <Button label="Send answer" disabled={!server || busy || !answer.trim()} onPress={() => void run(() => server!.connection.request('session.sendPrompt', { projectId, sessionId, text: answer.trim() }))} />
+        <Button ghost label="Dismiss" disabled={!server || busy} onPress={() => void run(() => server!.connection.request('session.dismissDecision', { projectId, sessionId }))} />
+      </View>
+      {error ? <Text style={ui.error}>{error}</Text> : null}
+    </View>
+  )
+}
diff --git a/apps/mobile/src/ui/status.ts b/apps/mobile/src/ui/status.ts
new file mode 100644
index 0000000..8936557
--- /dev/null
+++ b/apps/mobile/src/ui/status.ts
@@ -0,0 +1,15 @@
+import type { SessionStatus } from '../shared.ts'
+import { colors } from './theme.ts'
+
+export const STATUS_TEXT: Record<SessionStatus, string> = {
+  working: 'Working',
+  attention: 'Needs you',
+  done: 'Done',
+  complete: 'Complete',
+  idle: 'Idle',
+  exited: 'Exited'
+}
+
+export function statusColor(status: SessionStatus): string {
+  return status === 'attention' ? colors.attention : status === 'working' ? colors.accent : status === 'done' ? colors.ok : colors.muted
+}
```

### Task 7: The session screen

(Prototype commit `f35904b`.)

The terminal (the bundled page in a WebView, fed by the pty stream at the pty's own size), the key bar, the prompt box and the queue, and the app's pure modules' tests (Decisions 15 and 16).

- [ ] **Step 1: the tests.** Write `scripts/mobileLogic.test.mjs` and run `node --test scripts/mobileLogic.test.mjs`. It fails until `keys.ts` exists.
- [ ] **Step 2: the screen.** Write `keys.ts` and the session screen. WebView's typings don't carry its ref, which the screen's cast notes.
- [ ] **Step 3: run.** `cd apps/mobile && npm run typecheck`, then the test.
- [ ] **Step 4: commit.**

```diff
diff --git a/apps/mobile/app/session/[serverId]/[projectId]/[sessionId].tsx b/apps/mobile/app/session/[serverId]/[projectId]/[sessionId].tsx
new file mode 100644
index 0000000..5129c4c
--- /dev/null
+++ b/apps/mobile/app/session/[serverId]/[projectId]/[sessionId].tsx
@@ -0,0 +1,168 @@
+// A session (6a): its terminal (xterm.js in a WebView, fed by the pty stream, at the pty's own
+// size), a key bar, and a prompt box that sends now or queues, with the queue below it. A
+// decision the agent asked for is answered here too.
+import { useCallback, useEffect, useRef, useState } from 'react'
+import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
+import { Stack, useLocalSearchParams } from 'expo-router'
+import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview'
+import type { Project, Session } from '../../../../src/shared.ts'
+import { errorMessage, useServer, useTopic } from '../../../../src/state/hooks.ts'
+import { KEY_BAR } from '../../../../src/logic/keys.ts'
+import { TERMINAL_HTML } from '../../../../src/terminal/terminalHtml.generated.ts'
+import { Button } from '../../../../src/ui/Button.tsx'
+import { DecisionActions } from '../../../../src/ui/DecisionActions.tsx'
+import { STATUS_TEXT, statusColor } from '../../../../src/ui/status.ts'
+import { colors, ui } from '../../../../src/ui/theme.ts'
+
+interface WebViewHandle {
+  injectJavaScript(script: string): void
+}
+// The package types WebView as a function component without its ref; at run time it forwards one.
+const WebView = RNWebView as unknown as React.ComponentType<React.ComponentProps<typeof RNWebView> & { ref?: React.Ref<WebViewHandle> }>
+
+function findSession(project: Project, sessionId: string): Session | undefined {
+  for (const s of project.globalSessions) if (s.id === sessionId) return s
+  for (const repo of project.repositories) for (const wt of repo.worktrees) for (const s of wt.sessions) if (s.id === sessionId) return s
+  return undefined
+}
+
+export default function SessionScreen(): React.JSX.Element {
+  const { serverId, projectId, sessionId } = useLocalSearchParams<{ serverId: string; projectId: string; sessionId: string }>()
+  const server = useServer(serverId)
+  const topic = useTopic(serverId, `project:${projectId}`)
+  const session = topic.state === 'ready' ? findSession(topic.snapshot, sessionId) : undefined
+  const ptyId = session?.ptyId
+  const web = useRef<WebViewHandle>(null)
+  const [pageReady, setPageReady] = useState(false)
+  const [ended, setEnded] = useState<string | null>(null)
+  const [prompt, setPrompt] = useState('')
+  const [error, setError] = useState<string | null>(null)
+  const [busy, setBusy] = useState(false)
+
+  const toPage = useCallback((message: unknown) => {
+    web.current?.injectJavaScript(`window.__trek && window.__trek(${JSON.stringify(message)}); true;`)
+  }, [])
+
+  // The pty stream, while the screen shows it: the scrollback replays first, then live output.
+  useEffect(() => {
+    if (!server || !ptyId || !pageReady) return
+    setEnded(null)
+    toPage({ type: 'reset' })
+    let attached = true
+    server.ptys
+      .attach(ptyId, {
+        onData: (data) => toPage({ type: 'data', data }),
+        onReset: () => toPage({ type: 'reset' }),
+        onExit: (code) => setEnded(`The process exited (${code}).`),
+        onClosed: (reason) => setEnded(reason === 'gone' ? 'The session ended while the phone was away.' : 'Disconnected.'),
+        onError: (err) => setEnded(errorMessage(err)),
+        onReattach: (info) => toPage({ type: 'size', cols: info.cols, rows: info.rows })
+      })
+      .then((info) => toPage({ type: 'size', cols: info.cols, rows: info.rows }))
+      .catch((err) => setEnded(errorMessage(err)))
+    return () => {
+      if (attached) void server.ptys.detach(ptyId).catch(() => {})
+      attached = false
+    }
+  }, [server, ptyId, pageReady, toPage])
+
+  const write = (data: string): void => {
+    if (server && ptyId) void server.ptys.write(ptyId, data).catch((err) => setError(errorMessage(err)))
+  }
+
+  const onMessage = (event: WebViewMessageEvent): void => {
+    let m: { type?: string; data?: unknown }
+    try {
+      m = JSON.parse(event.nativeEvent.data)
+    } catch {
+      return
+    }
+    if (m.type === 'ready') setPageReady(true)
+    else if (m.type === 'input' && typeof m.data === 'string') write(m.data)
+  }
+
+  const run = async (fn: () => Promise<unknown>): Promise<void> => {
+    if (!server) return
+    setBusy(true)
+    setError(null)
+    try {
+      await fn()
+      setPrompt('')
+    } catch (err) {
+      setError(errorMessage(err))
+    } finally {
+      setBusy(false)
+    }
+  }
+  const text = prompt.trim()
+
+  return (
+    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
+      <Stack.Screen options={{ title: session?.title ?? 'Session' }} />
+      {session ? (
+        <View style={{ paddingHorizontal: 12, paddingTop: 6 }}>
+          <Text style={{ color: statusColor(session.status) }}>{STATUS_TEXT[session.status]}</Text>
+          {session.decision ? (
+            <>
+              <Text style={ui.warn}>Decision: {session.decision.question}</Text>
+              <DecisionActions serverId={serverId} projectId={projectId} sessionId={sessionId} />
+            </>
+          ) : null}
+        </View>
+      ) : null}
+      <View style={{ flex: 1, margin: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
+        {ptyId ? (
+          <WebView
+            ref={web}
+            source={{ html: TERMINAL_HTML }}
+            originWhitelist={['about:*']}
+            // The page loads nothing and goes nowhere: only its own about:blank.
+            onShouldStartLoadWithRequest={(r: { url: string }) => r.url.startsWith('about:')}
+            javaScriptEnabled
+            domStorageEnabled={false}
+            allowFileAccess={false}
+            allowsLinkPreview={false}
+            setSupportMultipleWindows={false}
+            keyboardDisplayRequiresUserAction={false}
+            hideKeyboardAccessoryView
+            onMessage={onMessage}
+            style={{ backgroundColor: colors.bg }}
+          />
+        ) : (
+          <View style={ui.pad}>
+            <Text style={ui.muted}>{session ? 'Not running. Restart it from the worktree, or load the worktree.' : topic.state === 'loading' ? 'Loading…' : 'This session is gone.'}</Text>
+          </View>
+        )}
+      </View>
+      {ended ? <Text style={[ui.muted, { paddingHorizontal: 12 }]}>{ended}</Text> : null}
+      <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 8 }} style={{ flexGrow: 0 }}>
+        {KEY_BAR.map((k) => (
+          <Pressable key={k.name} accessibilityRole="button" accessibilityLabel={k.name} disabled={!ptyId} onPress={() => write(k.data)} style={[ui.ghost, { minWidth: 44, alignItems: 'center' }]}>
+            <Text style={ui.ghostText}>{k.label}</Text>
+          </Pressable>
+        ))}
+      </ScrollView>
+      <View style={{ padding: 8, gap: 6 }}>
+        <TextInput style={[ui.input, { maxHeight: 120 }]} multiline value={prompt} onChangeText={setPrompt} placeholder="Prompt" placeholderTextColor="#6c7086" accessibilityLabel="Prompt" />
+        <View style={ui.row}>
+          <Button label="Send" disabled={busy || !session || !text} onPress={() => void run(() => server!.connection.request('session.sendPrompt', { projectId, sessionId, text }))} />
+          <Button ghost label="Queue" disabled={busy || !session || !text} onPress={() => void run(() => server!.connection.request('session.enqueue', { projectId, sessionId, text }))} />
+        </View>
+        {error ? <Text style={ui.error}>{error}</Text> : null}
+        {session && session.queue.length ? (
+          <View style={{ gap: 4 }}>
+            <Text style={ui.heading}>Queued</Text>
+            {session.queue.map((q, index) => (
+              <View key={`${index}:${q}`} style={[ui.row, { justifyContent: 'space-between' }]}>
+                <Text style={[ui.text, { flex: 1 }]} numberOfLines={2}>
+                  {q}
+                </Text>
+                <Button ghost danger label="Remove" disabled={busy} onPress={() => void run(() => server!.connection.request('session.dequeue', { projectId, sessionId, index, expected: q }))} />
+              </View>
+            ))}
+          </View>
+        ) : null}
+      </View>
+    </KeyboardAvoidingView>
+  )
+}
diff --git a/apps/mobile/src/logic/keys.ts b/apps/mobile/src/logic/keys.ts
new file mode 100644
index 0000000..be95dc0
--- /dev/null
+++ b/apps/mobile/src/logic/keys.ts
@@ -0,0 +1,20 @@
+// The session screen's key bar (6a): what each key writes to the pty. Pure.
+export interface BarKey {
+  label: string
+  /** Accessibility label */
+  name: string
+  data: string
+}
+
+export const KEY_BAR: readonly BarKey[] = [
+  { label: '⏎', name: 'Enter', data: '\r' },
+  { label: 'Esc', name: 'Escape', data: '\x1b' },
+  { label: 'Tab', name: 'Tab', data: '\t' },
+  { label: '^C', name: 'Control C', data: '\x03' },
+  { label: '↑', name: 'Up', data: '\x1b[A' },
+  { label: '↓', name: 'Down', data: '\x1b[B' },
+  { label: '←', name: 'Left', data: '\x1b[D' },
+  { label: '→', name: 'Right', data: '\x1b[C' },
+  { label: 'y', name: 'y', data: 'y' },
+  { label: 'n', name: 'n', data: 'n' }
+]
diff --git a/scripts/mobileLogic.test.mjs b/scripts/mobileLogic.test.mjs
new file mode 100644
index 0000000..60182ea
--- /dev/null
+++ b/scripts/mobileLogic.test.mjs
@@ -0,0 +1,53 @@
+// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
+// attention list, the key bar and the diff colouring.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { checkServerUrl, isPrivateHost } from '../apps/mobile/src/logic/serverUrl.ts'
+import { ago, attentionText, mergeAttention, newItems } from '../apps/mobile/src/logic/attention.ts'
+import { KEY_BAR } from '../apps/mobile/src/logic/keys.ts'
+import { classifyDiff } from '../apps/mobile/src/logic/diff.ts'
+
+test('wss:// is always allowed; ws:// only to a private address, with a warning', () => {
+  assert.deepEqual(checkServerUrl(' wss://dev.example.com '), { ok: true, url: 'wss://dev.example.com' })
+  const lan = checkServerUrl('ws://192.168.1.20:7345')
+  assert.equal(lan.ok, true)
+  assert.match(lan.warning, /Not encrypted/)
+  for (const url of ['ws://10.0.0.5', 'ws://172.20.1.1', 'ws://100.101.1.2', 'ws://studio.local:7345', 'ws://[fd7a:115c:a1e0::1]', 'ws://127.0.0.1']) {
+    assert.equal(checkServerUrl(url).ok, true, url)
+  }
+  for (const url of ['ws://dev.example.com', 'ws://8.8.8.8', 'ws://172.32.0.1', 'ws://100.128.0.1', 'https://dev.example.com', 'dev.example.com', '']) {
+    assert.equal(checkServerUrl(url).ok, false, url)
+  }
+  assert.equal(isPrivateHost('[::ffff:192.168.0.1]'), true)
+})
+
+test('attention: every server merged, newest first, with keys unique across servers', () => {
+  const entry = (sessionId, since, extra = {}) => ({ projectId: 'p', worktreeId: 'w', sessionId, title: sessionId, status: 'attention', since, projectName: 'App', ...extra })
+  const items = mergeAttention([
+    { serverId: 'a', serverName: 'A', entries: [entry('s1', 10), entry('', 30, { pullRequest: { text: 'Checks failed', url: 'u' } })] },
+    { serverId: 'b', serverName: 'B', entries: [entry('s1', 20, { decision: { question: 'Ship?', at: 20 } })] }
+  ])
+  assert.deepEqual(items.map((i) => [i.serverName, i.title, i.since]), [['A', '', 30], ['B', 's1', 20], ['A', 's1', 10]])
+  assert.equal(new Set(items.map((i) => i.key)).size, 3)
+  assert.deepEqual(items.map(attentionText), ['Checks failed', 'Decision: Ship?', 'Needs you'])
+  assert.deepEqual(newItems(items, new Set([items[0].key])).map((i) => i.since), [20, 10])
+  assert.equal(attentionText({ ...entry('s', 1), status: 'done' }), 'Finished')
+})
+
+test('ago', () => {
+  assert.equal(ago(0, 5_000), 'just now')
+  assert.equal(ago(0, 3 * 60_000), '3 min ago')
+  assert.equal(ago(0, 2 * 3_600_000), '2 h ago')
+  assert.equal(ago(0, 3 * 86_400_000), '3 d ago')
+})
+
+test('the key bar writes the terminal sequences', () => {
+  const byName = Object.fromEntries(KEY_BAR.map((k) => [k.name, k.data]))
+  assert.deepEqual(byName, { Enter: '\r', Escape: '\x1b', Tab: '\t', 'Control C': '\x03', Up: '\x1b[A', Down: '\x1b[B', Left: '\x1b[D', Right: '\x1b[C', y: 'y', n: 'n' })
+})
+
+test('a unified diff, classed line by line', () => {
+  const patch = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
+  assert.deepEqual(classifyDiff(patch).map((l) => l.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add'])
+  assert.deepEqual(classifyDiff(''), [])
+})
```

### Task 8: Promote confirmations on the phone

(Prototype commit `ed4ff3c`.)

`PromotePrompt` in the project screen (Decision 19).

- [ ] **Step 1: write the files below.**
- [ ] **Step 2: run.** `cd apps/mobile && npm run typecheck`.
- [ ] **Step 3: commit.**

```diff
diff --git a/apps/mobile/app/project/[serverId]/[projectId].tsx b/apps/mobile/app/project/[serverId]/[projectId].tsx
index cf22789..f1db382 100644
--- a/apps/mobile/app/project/[serverId]/[projectId].tsx
+++ b/apps/mobile/app/project/[serverId]/[projectId].tsx
@@ -1,7 +1,9 @@
 // A project (6a): its repositories and worktrees, each with its branch, status and sessions.
+// While it is open, the phone also answers promote_to_primary's confirmations for it.
 import { ScrollView, Pressable, Text, View } from 'react-native'
 import { router, Stack, useLocalSearchParams } from 'expo-router'
 import { useTopic } from '../../../src/state/hooks.ts'
+import { PromotePrompt } from '../../../src/ui/PromotePrompt.tsx'
 import { STATUS_TEXT, statusColor } from '../../../src/ui/status.ts'
 import { ui } from '../../../src/ui/theme.ts'
 
@@ -11,6 +13,7 @@ export default function ProjectScreen(): React.JSX.Element {
   return (
     <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
       <Stack.Screen options={{ title: topic.state === 'ready' ? topic.snapshot.name : 'Project' }} />
+      <PromotePrompt serverId={serverId} projectId={projectId} project={topic.state === 'ready' ? topic.snapshot : null} />
       {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
       {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
       {topic.state === 'ready'
diff --git a/apps/mobile/src/ui/PromotePrompt.tsx b/apps/mobile/src/ui/PromotePrompt.tsx
new file mode 100644
index 0000000..70c2d73
--- /dev/null
+++ b/apps/mobile/src/ui/PromotePrompt.tsx
@@ -0,0 +1,145 @@
+// An agent's promote_to_primary, confirmed from the phone (6a) while the project is open, through
+// 5e's steps: promote.listen; on a request, a dry run; then the user confirms, the phone claims it
+// (promote.claim) and runs worktree.promote {requestId}, and the server settles it with its own
+// result. The phone can't tear down a dev stack or VM: with either running it says to confirm on
+// the desktop and neither claims nor answers. A request another window claims or ends closes here.
+import { useEffect, useRef, useState } from 'react'
+import { Modal, Text, View } from 'react-native'
+import { CAPABILITY, type Project, type PromoteRequestEvent, type PromoteSettledEvent } from '../shared.ts'
+import { useServer, errorMessage } from '../state/hooks.ts'
+import { Button } from './Button.tsx'
+import { colors, ui } from './theme.ts'
+
+type Prompt =
+  | { kind: 'confirm'; request: PromoteRequestEvent; summary: string }
+  | { kind: 'desktop'; request: PromoteRequestEvent; why: string }
+  | { kind: 'running'; request: PromoteRequestEvent }
+  | { kind: 'result'; request: PromoteRequestEvent; text: string; failed: boolean }
+
+export function PromotePrompt({ serverId, projectId, project }: { serverId: string; projectId: string; project: Project | null }): React.JSX.Element | null {
+  const server = useServer(serverId)
+  const [prompt, setPrompt] = useState<Prompt | null>(null)
+  const projectRef = useRef(project)
+  projectRef.current = project
+  const promptRef = useRef(prompt)
+  promptRef.current = prompt
+
+  useEffect(() => {
+    if (!server) return
+    const conn = server.connection
+    const can = (): boolean => conn.welcome?.capabilities.includes(CAPABILITY.promote) === true
+    const listen = (on: boolean): void => {
+      if (can()) void conn.request('promote.listen', { projectId, listen: on }).catch(() => {})
+    }
+    listen(true)
+    // Listening is per connection: again after a reconnect.
+    const offWelcome = conn.on('welcome', () => listen(true))
+    const offEvent = conn.on('event', ({ event, payload }) => {
+      if (event === 'promote.settled') {
+        const settled = payload as PromoteSettledEvent
+        const open = promptRef.current
+        // Another window claimed or the request ended: close it, unless this phone is running it.
+        if (open && open.request.requestId === settled.requestId && open.kind !== 'running' && open.kind !== 'result') setPrompt(null)
+        return
+      }
+      if (event !== 'promote.request') return
+      const request = payload as PromoteRequestEvent
+      if (request.projectId !== projectId || promptRef.current) return
+      void ask(request)
+    })
+    const ask = async (request: PromoteRequestEvent): Promise<void> => {
+      const repo = projectRef.current?.repositories.find((r) => r.worktrees.some((w) => w.id === request.worktreeId))
+      const worktree = repo?.worktrees.find((w) => w.id === request.worktreeId)
+      if (!repo || !worktree) {
+        await conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'unknown-worktree' }).catch(() => {})
+        return
+      }
+      let summary: string
+      try {
+        const plan = await conn.request('worktree.promote', { projectId, worktreeId: request.worktreeId, dryRun: true })
+        if (!('mainPath' in plan)) return
+        summary =
+          `${plan.branch} is checked out in the main checkout (${plan.mainPath}) and this worktree is removed.` +
+          (plan.dirty ? ' Its uncommitted work comes along, unstaged.' : '') +
+          (plan.sessions.length ? ` ${plan.sessions.length} session(s) move and resume.` : '') +
+          (plan.otherLoaded ? " The main checkout's running sessions keep running on the new branch." : '') +
+          (plan.ignoredCount ? ` ${plan.ignoredCount} ignored file(s) in the worktree are deleted with it.` : '') +
+          (plan.overwrittenIgnoredCount ? ` ${plan.overwrittenIgnoredCount} ignored file(s) in the main checkout are overwritten.` : '')
+      } catch (err) {
+        // Refused (dirty main checkout, a lock…): one window answers it, without a dialog.
+        const claim = await conn.request('promote.claim', { projectId, requestId: request.requestId }).catch(() => null)
+        if (claim?.accepted) await conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'failed', error: errorMessage(err).slice(0, 500) }).catch(() => {})
+        return
+      }
+      const caps = conn.welcome?.capabilities ?? []
+      const stack = caps.includes(CAPABILITY.stacks) ? await conn.request('stack.status', { projectId, worktreeId: worktree.id }).catch(() => null) : null
+      const envs = caps.includes(CAPABILITY.env) ? await conn.request('env.list', { projectId, repoId: repo.id }).catch(() => []) : []
+      const vm = envs.find((e) => e.worktreePath === worktree.path && e.vmState === 'running')
+      if (stack && (stack.containers > 0 || stack.upRunning)) setPrompt({ kind: 'desktop', request, why: 'its dev stack is running' })
+      else if (vm) setPrompt({ kind: 'desktop', request, why: `its Docker VM (${vm.profile}) is running` })
+      else setPrompt({ kind: 'confirm', request, summary })
+    }
+    return () => {
+      offWelcome()
+      offEvent()
+      listen(false)
+    }
+  }, [server, projectId])
+
+  if (!prompt || !server) return null
+  const conn = server.connection
+  const { request } = prompt
+  const close = (): void => setPrompt(null)
+  const decline = (): void => {
+    void conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'declined' }).catch(() => {})
+    close()
+  }
+  const confirm = async (): Promise<void> => {
+    setPrompt({ kind: 'running', request })
+    try {
+      const claim = await conn.request('promote.claim', { projectId, requestId: request.requestId })
+      if (!claim.accepted) {
+        setPrompt({ kind: 'result', request, failed: true, text: 'This request has already ended (answered elsewhere, or the agent stopped waiting); nothing was done.' })
+        return
+      }
+      const result = await conn.request('worktree.promote', { projectId, worktreeId: request.worktreeId, requestId: request.requestId, claimToken: claim.claimToken })
+      const notes = 'notes' in result && result.notes.length ? ` ${result.notes.join(' ')}` : ''
+      setPrompt({ kind: 'result', request, failed: false, text: `${request.branch} is in the main checkout now.${notes}` })
+    } catch (err) {
+      setPrompt({ kind: 'result', request, failed: true, text: `Could not promote: ${errorMessage(err)}` })
+    }
+  }
+
+  return (
+    <Modal transparent animationType="fade" visible onRequestClose={prompt.kind === 'confirm' ? decline : prompt.kind === 'running' ? undefined : close}>
+      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
+        <View style={[ui.card, { gap: 10 }]} accessibilityViewIsModal>
+          <Text style={ui.title}>Promote {request.branch} to the main checkout?</Text>
+          {request.from ? <Text style={ui.muted}>Asked by the session “{request.from}”.</Text> : null}
+          {prompt.kind === 'confirm' ? (
+            <>
+              <Text style={ui.text}>{prompt.summary}</Text>
+              <View style={ui.row}>
+                <Button label="Promote" onPress={() => void confirm()} />
+                <Button ghost label="Decline" onPress={decline} />
+              </View>
+            </>
+          ) : null}
+          {prompt.kind === 'desktop' ? (
+            <>
+              <Text style={ui.warn}>Confirm this on the desktop: {prompt.why}, and only the desktop can tear it down first.</Text>
+              <Button ghost label="OK" onPress={close} />
+            </>
+          ) : null}
+          {prompt.kind === 'running' ? <Text style={ui.muted}>Promoting…</Text> : null}
+          {prompt.kind === 'result' ? (
+            <>
+              <Text style={{ color: prompt.failed ? colors.danger : colors.ok }}>{prompt.text}</Text>
+              <Button ghost label="OK" onPress={close} />
+            </>
+          ) : null}
+        </View>
+      </View>
+    </Modal>
+  )
+}
```

### Task 9: Docs

(Prototype commit `d2681e9`.)

`PROTOCOL.md`'s Phone pairing and capability, the READMEs, `apps/mobile/README.md` with the manual checklist, and the spec's token name.

- [ ] **Step 1: write the changes below.**
- [ ] **Step 2: commit.**

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index e4fd331..6ee615f 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -32,6 +32,9 @@ reconnecting with backoff, so it must be updated to talk to this server.
    `token` falls back to it too, then, on a server with the web client, to the
    browser's session cookie: "Web client" below).
 
+   A phone pairing (6a) sends a one-time `pairingCode` (and the phone's `deviceName`)
+   with no token instead: see [Phone pairing](#phone-pairing).
+
 2. The server replies with `welcome` on success (below).
 
 3. Failure closes the socket:
@@ -40,7 +43,7 @@ reconnecting with backoff, so it must be updated to talk to this server.
    |---|---|
    | `4001` | no `hello` within 5s, or another frame before it |
    | `4002` | unsupported `protocolVersion`; reason `UPGRADE_CLIENT` for an older client (v1) |
-   | `4003` | bad token (closed after a short delay; no detail given), or a revoked one |
+   | `4003` | bad token (closed after a short delay; no detail given), or a revoked one; a refused `pairingCode` says why in the reason |
    | `1002` | malformed JSON or frame |
    | `1003` | binary frame |
    | `1011` | internal error |
@@ -108,6 +111,7 @@ new optional field needs no capability: its absence says enough.
 | `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
 | `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export`, `move.history` and `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort`, `move.receive` and `move.unreceive` on the target |
 | `promote` | Promote to primary and its reverse (see [Promote to primary](#promote-to-primary)): `worktree.promote` and `worktree.demote`, each with `dryRun`, and the MCP tool `promote_to_primary`'s confirmation: `promote.request` to the windows that listen (`promote.listen`), `promote.claim` from the one that confirms (then its `worktree.promote {requestId}`) or `promote.answer` to decline, then `promote.settled` |
+| `pairing` | Phone pairing (see [Phone pairing](#phone-pairing)): `pairing.create`, and a `pairingCode` redeemed at `hello`. Every server but the local one (a phone can't reach this machine's loopback) |
 | `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
@@ -363,6 +367,56 @@ Tokens are named, one per device (`trek-server token add <name>`). Revoking a
 token closes its open connections with `4003`, and ends the web client's browser
 sessions signed in with it.
 
+## Phone pairing
+
+Phase 6a. A phone gets its own named token without anyone typing one: a signed-in client (the
+desktop's **Pair a phone…**) asks the server for a one-time code, shows it as a QR, and the phone
+redeems the code at `hello`.
+
+| Method | Params | Result |
+|---|---|---|
+| `pairing.create` | `{name?}` | `{code, expiresAt}` |
+
+- **The code:** 128 random bits as 26 base32 characters (`A`–`Z`, `2`–`7`). Case, spaces and
+  dashes are ignored when it comes back, so it can be shown in groups of five. It is redeemable
+  once, for 5 minutes. The server keeps only its sha256, in memory (a restart drops the waiting
+  codes), and at most 20 wait at once: one more drops the oldest. Any authenticated connection may
+  ask, since a token already holds shell-level power on the server's machine. `name` is a hint for
+  the token's name. The local server answers `NOT_FOUND`.
+- **Redeeming:** the phone's `hello` carries `pairingCode` and `deviceName` and no token:
+
+  ```json
+  { "type": "hello", "protocolVersion": 2, "client": "trek-mobile", "clientVersion": "0.1.0",
+    "pairingCode": "ABCDE…", "deviceName": "Greg's iPhone" }
+  ```
+
+  A good code mints a named token `phone-<deviceName>` (the device name in token-name characters,
+  `-2`, `-3`… if taken; the spec's "phone: <device>" can't be a token name), writes it to the
+  config like `trek-server token add`, and the welcome carries it this once:
+
+  ```json
+  { "type": "welcome", …, "pairedToken": "…", "pairedTokenName": "phone-Greg-s-iPhone" }
+  ```
+
+  The connection is then signed in with that token. The phone keeps it and connects with it as any
+  client does; revoking it (`trek-server token revoke`, or the config) closes the phone's
+  connections and refuses it after.
+- **Refusals** close `4003` after the bad-token delay, with the reason:
+
+  | Reason | When |
+  |---|---|
+  | `pairing code expired` | its 5 minutes passed |
+  | `pairing code already used` | it was redeemed before |
+  | `pairing code not recognised` | no such code (or the local server) |
+  | `too many pairing attempts` | 5 failed redeems from the address in a minute, or 50 in all: the web sign-in's limits, shared with it when the web client is on |
+
+  A spent or expired code is remembered (its hash) for 30 minutes, so the reason can say which.
+- **The QR** holds `trek://pair?url=<the server's URL, as the desktop reaches it>&code=<code>`: a
+  code, never a token. The desktop shows **Pair a phone…** only for a connected server whose
+  welcome lists `pairing`, never for the Local server or a loopback URL (`localhost`, `127.0.0.1`,
+  `::1`). On the phone a `trek://pair` link only fills the Add server form; nothing is redeemed
+  until the user taps Pair.
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config; never `--local`, which is a
diff --git a/README.md b/README.md
index 90386b1..d1322dd 100644
--- a/README.md
+++ b/README.md
@@ -261,6 +261,34 @@ other window on that project sees them live.
   waits for the answer.
 - **Not yet**: the project bot (after the native client).
 
+## Phone companion
+
+The Trek phone app (`apps/mobile`, Expo, iOS and Android; phase 6a) is for watching and
+steering agents away from the desk. Its home tab lists what needs you on every paired
+server, newest first: decisions waiting (answered right there), sessions that finished
+or stopped, pull request notices. From there: a server's projects, a worktree (load or
+unload it, start a session with an agent or session type, close or restart one, its
+read-only Changes), and a session's terminal with a key bar (Enter, Esc, Tab, ^C,
+arrows, y, n) and a prompt box that sends now or queues. While a project is open on
+the phone, an agent's `promote_to_primary` can be confirmed there, unless the
+worktree's dev stack or Docker VM is running (then only the desktop can, since it
+tears them down first).
+
+- **Pairing**: in **Open on server…**, a connected remote server has **Pair a phone…**.
+  It shows a QR and a one-time code (5 minutes, used once), never a token. Scan it in
+  the app's **Add server** (or type the server's address and the code): the phone
+  gets its own named token, `phone-<its name>`, kept in the phone's secure storage.
+  Revoke it with `trek-server token revoke phone-<name>` to unpair. Pair a phone… is
+  not offered for the Local server or a `localhost` / `127.0.0.1` address: a phone
+  can't reach those. Expose the server first (server/README.md, "Expose it with
+  Caddy").
+- **Addresses**: `wss://` always; plain `ws://` only to a private network address
+  (LAN, Tailscale, `.local`), with a warning.
+- **Not yet**: notifications while the app is closed (6b: a push relay), and
+  creating, moving or promoting worktrees from the phone.
+
+See `apps/mobile/README.md` to build and run it.
+
 ## Importing a .trekproj
 
 A `.trekproj` is the project file older Trek builds kept projects in. Trek no longer
@@ -471,6 +499,9 @@ one at a time:
   bare browser window (no Trek main or preload): sign-in, the cookie, a project and its
   session's terminal, the Origin rule on sockets, sign-out, revocation and the
   sign-in limit;
+- `npm run smoke:server-pairing`: Pair a phone… for a remote server: the QR's code (no
+  token in the window), a phone (the SDK in Node) redeeming it once for its own named
+  token, and that token's revocation;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/apps/mobile/README.md b/apps/mobile/README.md
new file mode 100644
index 0000000..bea86ef
--- /dev/null
+++ b/apps/mobile/README.md
@@ -0,0 +1,79 @@
+# Trek phone companion (`apps/mobile`)
+
+Phase 6a. An Expo app (SDK 58, Expo Router) for iOS and Android: what needs you on every
+paired trek-server, sessions and their terminals, prompts, decisions and read-only
+Changes. The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone
+pairing") how it signs in.
+
+It talks protocol v2 through the repo's own shared code: `src/shared.ts` re-exports
+`../../src/shared/client`, `model` and `protocolV2`, which Metro watches
+(`metro.config.js`). That code must stay free of Node, Electron, DOM and packages:
+`scripts/sharedForMobile.test.mjs` (in the root's `npm test`) checks it.
+
+## Install
+
+The app has its own `package.json` and lockfile; the repo root's `npm install` doesn't
+touch it.
+
+```bash
+cd apps/mobile
+npm install            # also builds the terminal page (postinstall)
+npm run typecheck
+npm run export         # JS bundles for iOS and Android into dist/ (no device needed)
+```
+
+`postinstall`, `typecheck` and `export` first run `scripts/build-terminal.mjs`, which writes
+`src/terminal/terminalHtml.generated.ts` (gitignored): the session screen's WebView page,
+xterm.js and `src/terminal/page.js` inlined into one HTML string whose CSP allows nothing
+from outside it.
+
+The app's pure modules (`src/logic/`) are tested from the repo root
+(`scripts/mobileLogic.test.mjs`, part of `npm test`).
+
+## Run it
+
+The camera, secure storage, notifications and the WebView are native modules, so the app
+runs in a development build, not Expo Go:
+
+```bash
+npx expo run:ios       # builds and runs on the iOS simulator (Xcode needed)
+npx expo run:android   # or an Android emulator
+```
+
+Nothing in the repo's checks runs these: they need Xcode or the Android SDK, and a device
+or simulator.
+
+## Manual checklist (iOS simulator)
+
+Against a trek-server reachable from the simulator. The simulator shares the Mac's
+network, so a server on this Mac at a LAN address works, with a warning for `ws://`.
+
+1. **Pairing:** on the desktop, open **Open on server…** and choose **Pair a phone…** for
+   the server.
+   - The phone's **Add server**: type the address and the code, and keep the phone name. **Pair**.
+   - The server is listed as Connected. `trek-server token list` shows `phone-<name>`.
+   - The same code again: "already used". After 5 minutes: "expired".
+   - Opening `trek://pair?url=…&code=…` in Safari opens Add server filled in, without pairing.
+2. **Attention:**
+   - A session that rings the bell or finishes is listed with its project and age, newest first.
+   - A `request_decision` shows its question. **Send answer** types it into the session; **Dismiss** clears it.
+3. **Projects:**
+   - The server's projects, repositories and worktrees, with their branches and sessions' states.
+   - **Load** / **Unload** follow on the desktop.
+4. **Sessions:**
+   - **New session** with the default agent, another agent, and a session type.
+   - **Restart** and **Close** (Close asks first).
+5. **Terminal:**
+   - The scrollback, then live output, in colour, at the desktop's width (the font shrinks).
+   - Tap and type. Each key-bar key does what its label says.
+   - **Send** types the prompt now. **Queue** adds it to the queue below, where **Remove** takes it out.
+6. **Changes:** files with their status and counts. Tapping one shows its patch: additions green, deletions red.
+7. **Promote:**
+   - With the project open, an agent's `promote_to_primary` shows the confirmation. **Promote** moves the branch into the main checkout, and the desktop's dialog closes.
+   - With the worktree's stack running, the phone says to confirm on the desktop.
+8. **Background:**
+   - Send the app to the background. A session needing you within ~20 s gives a notification.
+   - Back in the foreground, everything reconnects.
+9. **Revocation:** `trek-server token revoke phone-<name>`. The server shows **Pair again**.
+
+No real push services (APNs, FCM, Expo) are used: background push is 6b.
diff --git a/docs/superpowers/specs/2026-11-11-phase6a-mobile-companion-design.md b/docs/superpowers/specs/2026-11-11-phase6a-mobile-companion-design.md
index 944b301..1cc5b3b 100644
--- a/docs/superpowers/specs/2026-11-11-phase6a-mobile-companion-design.md
+++ b/docs/superpowers/specs/2026-11-11-phase6a-mobile-companion-design.md
@@ -46,8 +46,9 @@ remains the way to do everything else from a browser.
     pending; creating one past that drops the oldest.
   - **Redeem at hello:** `hello {pairingCode, deviceName}` is accepted before auth. If the code
     is valid, the server:
-    1. mints a named token `phone: <deviceName>`, with the device name cut to 60 characters and
-       a numeric suffix added if the name is taken;
+    1. mints a named token `phone-<deviceName>` (token names allow only letters, digits, `.`,
+       `_` and `-`, so "phone: <device>" became `phone-<device>` in the plan), with the device
+       name cut to 60 characters and a numeric suffix added if the name is taken;
     2. sends the token once in the welcome (`pairedToken`);
     3. spends the code.
 
diff --git a/server/README.md b/server/README.md
index 599c1bd..3b63240 100644
--- a/server/README.md
+++ b/server/README.md
@@ -234,6 +234,16 @@ The `promote_to_primary` MCP tool asks the windows that listen (`promote.listen`
 (`promote.request`); the first that confirms claims it (`promote.claim`) and its
 `worktree.promote {requestId}` settles it; the tool waits up to 15 minutes for one to answer. See PROTOCOL.md, "Promote to primary".
 
+## Phone pairing
+
+The Trek phone app (6a) gets its own token from a one-time code: a signed-in client asks
+for one (`pairing.create`; the desktop's **Pair a phone…** shows it as a QR), and the phone
+redeems it once, within 5 minutes, at `hello`. The server mints a named token
+`phone-<device>` (listed by `trek-server token list`) and sends it to the phone that once.
+Revoke it like any token. Codes live only in memory, as hashes; failed redeems share the
+web sign-in's limits (5 a minute per address, 50 in all). The local server doesn't pair
+phones. See PROTOCOL.md, "Phone pairing".
+
 ## Web client
 
 `trek-server start --web` (or `"web": true` in the config, read at start) also serves
```

### Task 10: Verification

- [ ] **Step 1: the checks, one at a time.**
  1. `npm run typecheck`, `cd server && npm run typecheck`, `cd apps/mobile && npm install && npm run typecheck`
  2. `npm test`
  3. `npm run build`
  4. `cd apps/mobile && npm run export`. Check that `dist/_expo/static/js/*/*.hbc` contains `pairing code not recognised`, then remove `dist`.
  5. Every smoke, one at a time, each with its own temp `--user-data-dir` and HOME: `smoke:server-pairing`, `server-promote`, `server-move`, `server-web`, `server-review`, `server-prwatch`, `v2`, `local-app`, `local-window`, `local-features`, `server-env`, `server-integrations`, `providers`, `windows`, `import`, `local`, `client`
  6. `cd server && npm run build && npm run smoke -- --built`
- [ ] **Step 2: a clean clone.** Clone the branch into a temp dir, then `npm ci` (which installs `server/`), `npm run typecheck`, `npm test` and `npm run build`. Then `cd apps/mobile && npm ci && npm run typecheck && npm run export`.
- [ ] **Step 3: no leftovers.** No trek-server or Electron processes from the runs, and no temp dirs.
- [ ] **Step 4 (only when the user asks): a device.** The manual iOS simulator checklist in `apps/mobile/README.md`.
