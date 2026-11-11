# Phase 6a: the Trek phone companion (design)

Status: approved by the user, 2026-11-11. Parent spec: `2026-11-04-central-server-design.md` §6.
Phase 6 is split: **6a** (this spec) is the companion app and pairing; **6b** is background push
through a Trek push relay (outlined at the end, specified separately).

## Purpose

A native phone app for watching and steering agents away from the desk. It is a companion, not
the desktop window shrunk: attention first, then the sessions behind it. The web client (5c-3)
remains the way to do everything else from a browser.

## User decisions (2026-11-11)

1. **Purpose:** a phone companion: attention, terminals, prompts, sessions, decisions.
2. **Toolchain:** Expo (managed, with dev builds), iOS and Android, in a new `apps/mobile`
   workspace.
3. **Terminal:** xterm.js in a WebView fed by the pty stream, with a key bar and a prompt box;
   direct typing into the terminal too.
4. **Pairing:** the desktop app shows a QR. It carries a short-lived, one-time pairing code (not a
   token) that any signed-in client can ask a server for; the phone redeems it once for its own
   named token. Manual entry is the fallback.
5. **Features beyond attention, terminals and prompts:** start, close and restart sessions;
   load and unload worktrees; answer decisions; read-only Changes. Not creating worktrees.
6. **Push:** background push goes through a Trek push relay the user hosts (holding the APNs key
   and FCM credentials), in 6b. iOS cannot receive background pushes for a custom app any other
   way than through APNs, so ntfy-style relays were ruled out for iOS.
7. **Code sharing:** the app imports `src/shared/client`, `src/shared/model` and
   `src/shared/protocolV2` directly through Metro (no `packages/client` extraction yet).
8. **Split:** 6a (the app and pairing), then 6b (the relay and server push).

## 1. Architecture and pairing

- **App:** `apps/mobile`, Expo with dev builds. Expo Router for screens, `expo-secure-store` for
  tokens, `expo-camera` to scan the QR, `expo-notifications` for local notifications,
  `react-native-webview` for the terminal.
- **Shared code:** Metro `watchFolders` (and a resolver alias) bring in the three shared modules.
  The connection uses React Native's global `WebSocket` through the SDK's socket layer. A unit
  test walks the import graph of every shared module the app imports and fails on `node:*`,
  `electron`, or DOM-only APIs (`document`, `window`), so the shared code stays usable from the
  phone.
- **Server: pairing.**
  - `pairing.create {name?}`: any authenticated connection. Returns `{code, expiresAt}`. The
    code is 128 random bits, shown as base32. It lasts 5 minutes and can be used once. The
    server keeps only its hash, in memory (a restart drops pending codes). At most 20 codes are
    pending; creating one past that drops the oldest.
  - **Redeem at hello:** `hello {pairingCode, deviceName}` is accepted before auth. If the code
    is valid, the server:
    1. mints a named token `phone-<deviceName>` (token names allow only letters, digits, `.`,
       `_` and `-`, so "phone: <device>" became `phone-<device>` in the plan), with the device
       name cut to 60 characters and a numeric suffix added if the name is taken;
    2. sends the token once in the welcome (`pairedToken`);
    3. spends the code.

    From then on the connection is an ordinary authenticated one. Failed redeems count against
    the same limits as the web sign-in: 5 a minute per address, 50 a minute in total.
  - **Revoking:** revoking the token (CLI or config) unpairs the phone, as for any token.
  - **Capability:** `pairing`.
- **Desktop: "Pair a phone…".**
  - It is under Settings → Servers, on a server whose welcome lists `pairing`.
  - The URL in the QR is the one the desktop app itself uses for that server. "Pair a phone…" is
    hidden for the Local server and for any server whose URL is loopback, since a phone can't
    reach those.
  - Main asks that server for a code. The renderer gets only the code, the expiry and that URL. It shows a QR of `trek://pair?url=<url>&code=<code>`, the code
    as text, and a countdown.
  - No token ever reaches the renderer or the QR.
- **Phone: adding a server.**
  - **Scan or enter by hand:** you can scan the QR or type the URL and the code. A
    `trek://pair` deep link only fills the form; nothing is redeemed without a tap.
  - **Existing token:** a URL plus an existing named token can be entered instead.
  - **Storage:** tokens are kept in secure storage, keyed by the server id from the welcome. Only
    the connection layer reads them.

## 2. Screens

- **Servers:** the paired servers and their connection state. You can add one, or remove one
  (which forgets the token on the phone). Removing says the token stays valid until revoked from
  the desktop or the CLI.
- **Attention (home tab):**
  - What needs you, across every server, newest first: decisions waiting, sessions that finished
    or stopped, PR watch notices.
  - Tapping an item opens its session or decision.
  - It is fed by one SDK connection per server, like the desktop's attention aggregator.
- **Projects:** a server's projects. A project shows its repos and worktrees: each worktree's
  branch, status, and sessions with their states.
- **Worktree:**
  - load or unload it;
  - start a session (pick the agent and session type);
  - its sessions, each with close and restart;
  - a **Changes** tab: changed files and a read-only diff per file (`worktree.changes`,
    `worktree.diff`).
- **Session:**
  - **The terminal:**
    - xterm.js runs in a WebView from a bundled local page. The page allows no navigation, no
      network (a CSP of `default-src 'none'`, with scripts and styles from the bundle) and loads
      no remote content.
    - The pty stream reaches it by `postMessage`.
    - Tapping the terminal opens the keyboard for direct typing.
  - **The key bar:** Enter, Esc, Tab, Ctrl-C, the four arrows, y, n.
  - **The prompt box:** **Send**, or **Queue** (`session.enqueue`). It also shows the queue
    with remove.
- **Decisions:**
  - **`request_decision`:** answered inline from Attention, with the same meaning as on the
    desktop.
  - **`promote_to_primary`:** shown as a native confirm through 5e's `promote.listen` and
    `promote.claim`. The phone cannot tear down a dev stack or VM. If the worktree has one
    running, the phone shows "Confirm on the desktop" and does not claim.
- **Not in 6a:**
  - creating, deleting, moving and promoting worktrees from a menu;
  - review comments;
  - Docker, environments and stacks;
  - settings beyond the server list;
  - background push (6b).

## 3. Data flow, background, errors, security, testing

- **Connections:**
  - one `RegisteredServer` per paired server;
  - a project topic is subscribed only while its screens are open, or for attention;
  - a pty stream is attached only while its session screen is open.
- **Background:**
  - When the app is backgrounded, it closes its sockets (iOS suspends it within seconds anyway).
  - On returning, it reconnects. The SDK resubscribes and handles a rev gap, and Attention
    refreshes.
  - Local notifications fire only from a live connection: the app is open, or in its short
    background grace.
- **Errors:**
  - **A needs-auth welcome** marks that server "Pair again".
  - **A failed redeem** says which: expired, used, too many attempts, or wrong code.
  - **Lost connection:** "Reconnecting…" with backoff.
  - **A refused request** shows the server's message.
  - **Missing capabilities** hide their features.
- **Security:**
  - tokens only in secure storage, never logged;
  - the terminal WebView rules above;
  - deep links only prefill.
  - **Allowed URLs:** `wss://` always; `ws://` only for loopback or private-LAN addresses, with a
    warning shown.
- **Testing:**
  - **Unit tests** (`node --test`, in `scripts/`):
    - pairing on the server: codes, expiry, single use, the pending cap, rate limits, the token
      minted and named, revocation;
    - the app's pure modules: the attention list, `trek://pair` parsing, the URL rule, key-bar
      sequences;
    - the shared-code import guard.
  - **`smoke:server-pairing`:**
    1. A trek-server and the desktop app are driven as in other smokes.
    2. "Pair a phone…" shows a QR whose payload has no token.
    3. A Node SDK client playing the phone redeems the code, and the new token works.
    4. A second redeem of the same code fails.
    5. After revocation, the phone's token is refused.
    6. No token appears in the desktop's renderer.
  - **The app:** checked by typecheck and `expo export` for both platforms. A manual checklist
    covers the iOS simulator, with an optional Maestro flow. Device or simulator runs happen only
    when the user asks, and never on real accounts.
  - **No external services:** 6a uses no real APNs, FCM or Expo services.

## 6b outline (separate spec)

- **The relay:** a Trek push relay service the user hosts. It holds the APNs key and the FCM
  service account.
- **Devices:** a phone registers its push token with each paired server.
- **Sending:**
  - on attention, a server posts to the relay with a per-server relay key;
  - the payload is minimal: project and "needs attention", no terminal text;
  - the relay sends through APNs and FCM.
- **Controls:** a per-device mute, and a server setting naming the relay.
