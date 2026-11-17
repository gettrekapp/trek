# Trek phone companion (`apps/mobile`)

Phase 6a (and 6b's background push). An Expo app (SDK 58, Expo Router) for iOS and
Android: what needs you on every paired trek-server, sessions and their terminals,
prompts, quick buttons, decisions, Changes with its review (line comments on a diff, sent to
a session), adding and removing worktrees, a branch's tag, custom tags, note, ticket and pull
request, the pull request's watch and its notices, a branch's history, a project's automations
(their runs, Run now, on and off, name and prompt, missed runs), and pushes while it is closed.
The repo's README ("Phone companion") says what it does; PROTOCOL.md ("Phone pairing") how it
signs in.

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
what keeps plain `ws://` to a LAN, Tailscale or `.local` address.
A `ws://` address in Tailscale's range (`100.64.0.0/10`) gets its own warning: Tailscale encrypts
the traffic between devices, so the LAN warning would be wrong there. That is the address the
desktop's Local server gives a phone (**Pair a phone…** on its Local row, PROTOCOL.md "Phone access
on the local server"). (iOS isn't checked on a
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
`app.gettrek.mobile`, `android.package`) must be registered in the same Firebase project as the
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

## Store review

Reviewers have no Trek server, so the app has a built-in demo: **Try the demo** on the first
screen (and on Servers) adds a "Demo server" that runs inside the app
(`src/demo/`), with a sample project (`acme-web`): worktrees, sessions with terminal output, a
decision to answer, a pull request notice, a draft review, automations and branch history.
Nothing leaves the phone. It isn't saved: it's gone after a relaunch, and every Try the demo
starts it fresh.

Review notes (App Store Connect → App Review Information → Notes, and Google Play → App
content → App access → "All or some functionality is restricted" → instructions):

> Trek is the phone companion to the Trek desktop app and server, which run AI coding agents
> on the user's own computer. To review the app without a server, tap **Try the demo** on the
> first screen: it opens a built-in sample server inside the app (no account, no network).
> Everything in the app works against it. To pair a real server, the desktop app shows a QR
> code under Servers → Pair a phone…
>
> In the demo, tapping the sample pull request shows a note instead of opening GitHub.

Attach a short screen recording of pairing a real server to the review notes.

What the demo leaves out: push notifications, dev stacks and Docker environments, promote, and
creating automations (`src/demo/demoHandlers.ts`' `NOT_IN_DEMO`). Every request the phone
sends is either answered by the demo or listed there: `scripts/mobileDemo.test.mjs` fails
otherwise.

## Manual checklist (iOS simulator)

Against a trek-server reachable from the simulator. The simulator shares the Mac's
network, so a server on this Mac at a LAN address works, with a warning for `ws://`.

1. **Pairing:** on the desktop, open **Open on server…** and choose **Pair a phone…** for
   the server.
   - The phone's **Add server**: type the address and the code, and keep the phone name. **Pair**.
   - The server is listed as Connected. `trek-server token list` shows `phone-<name>`.
   - The same code again: "already used". After 5 minutes: "expired".
   - Opening `trek://pair?url=…&code=…` in Safari opens Add server filled in, without pairing.
     With the app closed first, too; Back from there goes to Needs you.
   - Scanning a QR that isn't a pairing code says "Not a Trek pairing code".
   - With camera access denied (Settings → Trek → Camera off), Add server offers Open Settings.
2. **Needs you** (the home tab, and the first of the bar at the bottom: Needs you, Projects,
   Servers):
   - The bar is on those three screens only. Needs you shows how many items wait in amber.
     Projects and Servers change without a slide and have no back arrow; Needs you in the
     bar (and Android's back) returns home. Tapping between Projects and Servers many times,
     then Needs you, leaves nothing under home.
   - A session that rings the bell or finishes is a row, newest first: an amber `!` (blue dot
     for one that finished), its title and age, what it wants, and its project and server.
   - A `request_decision` shows its question. **Send answer** types it into the session; **Dismiss** clears it.
     With the keyboard up, one tap on **Send answer** sends it.
   - A pull request notice (item 11) is listed with its title ("PR #<n>") and text. Tapping
     its text opens the worktree.
   - **Dismiss** on a pull request item clears the notice without opening the worktree; the
     item leaves the list, and the notice leaves the worktree's screen and the desktop's chip.
   - Two quick taps on that **Dismiss** send one request and open nothing.
   - With the server out of reach, **Dismiss** shows the error under the item, which stays.
3. **Projects:**
   - The server's projects, repositories and worktrees. Each worktree is a row, as in the
     desktop's sidebar: one mark for its sessions (amber `!` needs you, blue dot finished,
     green arc working, hollow ring idle, none with nothing loaded), its branch, and at the
     right "primary", `●` for uncommitted changes, `↑n ↓n`, and `▸n` for an unloaded
     worktree's saved sessions. Its second line is the branch's tag (in its colour), custom
     tags, ticket and pull request.
   - A worktree that wants you shows the reason on that line instead: "Missing on the
     server", "Decision: <question>", or its pull request notice ("PR #<n>: Checks failed:
     build"), cut off at the row's width, with no buttons.
   - **Load sessions** / **Unload sessions** (the worktree screen's Worktree list) follow on
     the desktop.
4. **Sessions:**
   - The worktree screen opens with one line under its title (the branch's tag, ticket and
     pull request, then "uncommitted changes" or "clean" and `↑n ↓n`), then its sessions, each a
     row with its state mark. A session's decision is answered on its row.
   - **New session** lists the default agent, the other agents, and the session types.
   - A session's **⋯** offers **Restart** and **Close…** (Close asks first).
   - The worktree's path is at the bottom of the screen.
5. **Terminal:**
   - The scrollback, then live output, in colour, at the desktop's width (the font shrinks).
     The scrollback isn't wrapped at 80 columns first.
   - Resize the desktop's window: the phone's terminal follows (`pty.resized`); the phone
     never changes the desktop's size.
   - Touch-scroll the scrollback up and back down (and sideways at a wide size).
   - The session's state mark is beside its title in the header, and the terminal runs the
     full width of the screen.
   - Tap and type. **Keys** (first in the row under the terminal) opens the key bar and
     closes it again; each key does what its label says. Open on one session, it is open on
     the next until the app is closed.
   - `printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'` in the session: tapping
     "link" opens nothing.
   - With the keyboard up, the prompt box stays above it, below the header.
   - The composer: the round **↑** sends the prompt now (grey with nothing typed). **Queue**
     appears beside it once something is typed and adds it to the queue. A queue shows as
     one line under the composer ("Next: …" and "<n> queued ›"); tapping it lists the
     queue, where **Remove** takes a prompt out.
   - **Quick buttons** (set them up on the desktop: a terminal's button row): the project's
     buttons are in a row above the prompt box, after **Keys**; a Global session shows the
     Global ones; a project with none shows **Keys** alone.
     - A button with plain text or built-ins that have a value (`[branch]`) sends at once.
     - A button with an `{INPUT}` (marked with a trailing …) opens a sheet: the field, a preview that follows
       what is typed, **Send** and **Cancel**. Text in the prompt box is still there afterwards.
     - A button using `[ticket_url]` on a branch whose ticket links (the project has its
       tracker's setting: the Linear workspace, the Azure DevOps project URL) sends the link at
       once. Without that setting, or with `[ticket]` on a branch without a ticket, it opens
       the sheet with that field marked "no value here".
     - Add a button on the desktop: it appears on the phone without reopening the screen.
     - With the sheet open and the keyboard up, the fields, the preview and **Send** are all visible above the keyboard, on iOS and on Android (not checked on a device yet).
     - With the sheet open and something typed, send the app to the background for 30 s and come back: the sheet and what was typed are still there; with the server out of reach, **Send** shows the error in the sheet and keeps it open.
6. **Changes** (a worktree's **Changes**; the review needs a server with the `review`
   capability, and its draft is the one the desktop's Changes tab shows):
   - **Branch**, **Uncommitted** and **Commit** are at the top, with what is compared under
     them: "The branch against its base", "Uncommitted changes" or "Commit <sha> (<subject>)".
   - **Commit** lists the newest commits (subject, short sha, author, age); tapping one shows
     that commit's files.
   - Files with their status and counts. Tapping one shows its patch with old and new line
     numbers: additions green, deletions red.
   - Opening another file closes the one that was open.
   - A file with no patch says why instead: "No text changes" (binary), "Diff not shown: over
     the size limit".
   - A large file: a patch of more than 2,000 lines shows its first 2,000 and **Show all <n>
     lines**, which draws the rest. Opening a 10,000-line patch does not hang the screen.
   - Pulling down reloads the file list and the patches for the shown source.
   - A failed refresh leaves no file on "Loading…": open a file and pull down at once with the
     server's network cut. The error shows under the source, and the open file says "Diff not
     available" with the error (or keeps the patch it had); closing and opening it reads it again.
   - Tapping an added, removed or unchanged line opens a comment box under it. A hunk header
     (`@@ … @@`) opens nothing.
   - **Save** is disabled while the box is blank. **Save** puts the comment under its line,
     and it shows on the desktop's Changes tab; **Cancel** closes the box and adds nothing.
   - A line with a comment is marked: a tinted row with a bar at its left edge.
   - With text typed in a box, tapping another line asks "Discard your comment?"; **Cancel**
     keeps the box and its text.
   - With text typed in a new comment's box, choosing another source asks the same.
   - While a box is open (a new comment or an edit), its file's header says " · writing a
     comment", also with the file closed or the box scrolled away.
   - A refresh that removes the file being commented on: write a comment on a file without
     saving, revert that file in the worktree, pull down. The box is gone and the line above the
     bar says "The file you were commenting on is no longer in this diff." and, on a new line,
     "You had written: <the text>"; the text can be selected and copied.
   - A comment on a line beyond the first 2,000 of a large file: tap **Edit**, close the file
     and open it again. The box is drawn (the lines down to it are shown).
   - **Edit** on a comment opens the box with its text; **Save** changes it, on the desktop too.
   - **Delete** asks "Delete this comment?" and then removes it.
   - Edit conflict: tap **Edit** on the phone, change that comment on the desktop, then
     **Save** on the phone. The box stays open with what was typed, with "The comment changed
     on the server" and the desktop's text under it. **Save** again overwrites it.
   - Delete that comment on the desktop while it is being edited on the phone: with nothing
     changed in the box it just closes; with changed text the box closes and the line above the
     bar says "The comment you were editing is no longer in the review." and, on a new line,
     "You had written: <the text>". The same when the desktop sends or discards the review.
   - A **Save** whose reply was lost but which the server did apply (cut the network just
     after tapping it), saved again once back online: the box closes with the comment as
     typed, and no "The comment changed on the server".
   - Outdated: comment on a line, change that line in the worktree, pull down. The comment is
     at the top of its file under "Outdated: its line has changed", with "line <n>: <the line
     as it was>"; **Edit** and **Delete** still work there.
   - While the draft has comments, a bar at the bottom says "<n> comments", with **Send to…**
     and **Discard**. A comment added on the desktop changes the count without reopening.
   - A comment made on another source (or on a file not in this diff) adds "· <m> elsewhere"
     to the bar; tapping that lists them (the source, path, line and body) with **Delete**.
   - **Send to…** lists the worktree's running sessions with their status. Tapping one queues
     the review as one prompt in that session, and the bar goes (the draft is empty).
   - **Send to…** with no session running: "Start a session in this worktree to send the
     review to"; for an unloaded worktree, "Load the worktree to send the review to one of
     its sessions". Nothing can be tapped.
   - **Send to…** with text typed in a box that is not saved (a new comment, or an edit that
     changed something) asks "Your comment is not saved": **Cancel** sends nothing and keeps the
     box and its text; **Send without it** closes the box and sends the review as it was saved.
   - **Discard** asks "Discard <n> comments?" and then deletes the review, on the desktop too.
     With unsaved text in a box the same question adds that the comment being written is
     discarded too: **Cancel** keeps the review, the box and its text; **Discard** closes the box.
   - Review conflict: with the **Discard** question up, add a comment on the desktop, then
     answer **Discard**. "The review changed on the server. Check it and send again." shows
     above the bar, nothing is discarded, and the bar has the new count.
   - With **Send to…**'s list open, add a comment on the desktop: the list closes, so a
     session is never sent a review other than the one that was counted.
   - Cut the server's network, then **Save** a comment: the error says the comment "may not
     have been added" and to check the file's comments before adding it again. The same for
     **Send to…** ("may not have been sent", the session's queue).
   - Two quick taps on **Save** add one comment; the buttons are disabled while a request runs.
   - Tap targets: a line that takes a comment is tall enough to hit with a thumb (28 pt), and
     a tap on one line never opens the box on its neighbour (not checked on a device yet).
   - The keyboard: with a comment box open and the keyboard up, the box stays above it, and
     one tap on **Save** saves, on iOS and on Android (not checked on a device yet).
   - Scroll a patch with long lines sideways: the comments and the open box under a line stay
     on screen instead of being left behind at the left (not checked on a device yet).
   - The two line-number columns are wide enough for the file's largest numbers, and the code
     is in a monospace font, also on Android (not checked on a device yet).
   - An edit box in the bar's "elsewhere" list (edit a comment, then pull down after its file
     left the diff): the file list behind it does not scroll by itself when the box is drawn or
     the keyboard comes up (not checked on a device yet).
   - A server without `review` (an older trek-server): no **Branch** / **Uncommitted** /
     **Commit**, no comments and no bar. The files of the branch against its base, with the
     uncommitted work, open as coloured patches; tapping a line does nothing.
   - Opening Changes before the server has connected shows "Loading…" (with the connection's
     notice, if any) until it has, never the read-only screen first on a server with `review`.
7. **Promote:**
   - With the project open, an agent's `promote_to_primary` shows the confirmation. **Promote** moves the branch into the main checkout, and the desktop's dialog closes.
   - With the worktree's stack running, the phone says to confirm on the desktop.
8. **Add worktree** (a repository's **Add worktree** on the project screen):
   - Typing in the branch field lists up to 8 branches containing the text; tapping one fills
     the field and turns **Use existing branch** on.
   - If the repository's branches can't be loaded, "Could not load the branches: …" shows,
     nothing is suggested, and **Create** still works.
   - **Create** is disabled while the field is empty. With the switch off it creates a new
     branch; with it on it checks out the named one. The new worktree's screen replaces Add
     worktree (Back goes to the project), and no session is started.
   - A branch that already has a worktree, or a new branch whose name exists: the server's
     error shows under **Create**, and the form keeps what was typed.
   - A repository with linked folders, one of which can't be linked: an alert lists the
     warnings before the worktree's screen opens.
   - A pull request field holding anything but a github.com pull request link says "Not a
     GitHub pull request link", and **Add PR** is disabled.
   - **Add PR** with a pull request's link creates the worktree on `pr/<n>` and opens it; its
     Branch section shows "PR #<n>".
   - **Add PR** again with the same link (its branch already has a worktree): no second
     worktree, and that worktree's screen opens with the pull request linked.
   - Two quick taps on **Create** or **Add PR** create one worktree.
9. **Remove a worktree** (**Remove worktree** in the worktree screen's Worktree list; its
   questions' button is **Remove**):
   - The main checkout has no **Remove worktree**.
   - A clean, unloaded worktree: "Remove <name>?" says its folder is deleted and its branch
     stays. **Remove** removes it, and the phone goes back to the project, where it is gone.
     The branch still exists (`git branch`).
   - **Cancel**, or Android's back button or a tap outside the alert, removes nothing.
   - A loaded worktree: the question also says "Its running sessions will be stopped." It is
     unloaded first, then removed.
   - A worktree with uncommitted changes: the question is "<name> has uncommitted changes."
     with **Discard and remove** (and, when it is loaded, that its sessions will be stopped).
     Cancelling leaves it as it was, still loaded.
   - Change a file in a clean worktree and tap **Remove** before the phone shows "uncommitted
     changes": after the first question the discard question follows (for a worktree that
     was loaded, it says again that its sessions will be stopped). Declining it leaves the
     worktree there, and loaded again if it was loaded.
   - On that discard question, put the app in the background for 30 s, come back and tap
     **Cancel**: the worktree is loaded again, or the phone says "It was unloaded and could
     not be loaded again: use Load." It is not left unloaded with nothing said.
   - Unload a loaded worktree on the desktop while the phone's first question is up, then
     answer **Remove** and have the removal fail (e.g. a locked worktree): the phone does
     not load it again.
   - With the worktree's dev stack running, or its Docker VM, the phone says "Remove this
     worktree on the desktop: …" and asks nothing.
   - Start the worktree's dev stack on the desktop while the phone's question is up, then
     answer **Remove**: the same "Remove this worktree on the desktop: …", and nothing is
     unloaded or removed.
   - When the phone can't check that (the server stops answering as **Remove** is tapped,
     e.g. its network is cut): "Could not check whether this worktree's dev stack or Docker
     VM is running, so it was not removed. Try again." Nothing is asked, nothing is removed,
     and it does not say to use the desktop.
   - A server machine without colima (and so with no Docker VMs) removes a worktree normally:
     that is not a failed check.
   - A removal the server refuses for another reason shows its error, and a worktree the
     phone unloaded for it is loaded again (or the error ends with "It was unloaded and
     could not be loaded again: use Load.").
   - A worktree listed as Missing (its folder was deleted) is removed the same way, also on
     a server that runs dev stacks.
10. **Branch details** (the **Branch details** row of a worktree that is on a branch, which
    opens the section in place; a detached worktree has none; "the Branch section" below is
    this one):
    - **Workflow tag**: the project's tags in their colours, the branch's one filled in.
      Tapping another sets it, tapping the current one clears it; the desktop follows. A
      project whose tag list was emptied shows no row.
    - **Custom tags**: each of the project's custom tags toggles on its own; a project with
      none shows no row.
    - A tag set on the desktop shows on the phone without reopening the screen, and on the
      project screen's worktree row.
    - **Note**: "No note", or the note. **Edit** opens a multi-line box; **Save** saves it,
      **Cancel** leaves it as it was, and saving an empty box clears it.
    - Note conflict: tap **Edit** on the phone, change the note on the desktop, then **Save**
      on the phone. The box stays open with what was typed, with "The note changed on the
      server" and the desktop's note under it. **Save** again overwrites it with the phone's
      text; **Cancel** keeps the desktop's.
    - **Ticket**: **Edit**, then a Linear id (`TOW-12`), an Azure DevOps id (`123`) or either
      tracker's URL saves its id and shows its label. Anything else shows what the trackers
      take ("Enter a Linear issue id … or issue URL…"); with no tracker on in the project,
      "No ticket tracker is on in this project. Turn one on in the desktop app's Settings →
      Plugins." **Clear** (only with a ticket set) unlinks it.
    - A ticket whose tracker has its project setting (the Linear workspace, the Azure DevOps
      project URL) opens in the browser when tapped; without it, it is plain text. Pasting a
      tracker URL on the phone does not write that setting.
    - **Pull request**: **Edit**, then `https://github.com/<owner>/<repo>/pull/<n>/files`
      saves the link without `/files` and shows "PR #<n>"; tapping it opens the browser.
      Anything else says "Not a GitHub pull request link" and saves nothing. **Clear** unlinks
      it.
    - **Watch** (under a linked pull request, on a server whose machine has `gh` signed in):
      the label becomes "PR #<n> · watching" and the button **Stop watching**; the desktop's
      chip says "watching" too. **Stop watching** takes both away.
    - A branch without a pull request has no **Watch**. Neither has a linked one on a server
      where `gh` is not signed in, unless it is already watched.
    - Sign `gh` out on the server's machine (`gh auth logout`) with the worktree's screen
      open. Within about 10 minutes, without reopening the screen, an unwatched pull request
      loses **Watch**, and a watched one says "PR #<n> · watch paused, gh signed out" and
      keeps **Stop watching**, which still works. Signing in again brings both back.
    - Watching a pull request whose link is not a github.com one shows the server's refusal
      ("… is not a GitHub pull request URL") in the section's error line.
    - **Edit** the pull request to another link, or **Clear** it: the watch is gone with it.
    - With the keyboard up, one tap on **Save** saves, and the box being edited stays above the
      keyboard, on iOS and on Android (not checked on a device yet).
    - Two quick taps on **Save**, or on a tag, send one request; the section's buttons are
      disabled while it runs.
    - With the server out of reach, **Save** shows the error under the section and the box
      keeps what was typed.
11. **Pull request notices** (a watched pull request whose checks fail or settle, that gets
    a review or a comment, conflicts, or is merged or closed; the server polls every 3 minutes):
    - The worktree's screen shows the notice above its sessions: its title ("PR
      #<n>"), what happened, and how long ago.
    - **Open** opens the pull request in the browser.
    - **Dismiss** removes the notice from the screen, from the worktree's row, from the
      Needs you list and from the desktop.
    - Dismissing it on the desktop removes it from the phone without reopening the screen.
    - A second report on the same pull request replaces the first notice.
    - Two quick taps on **Dismiss** send one request.
    - With the server out of reach, **Dismiss** shows the error in the notice, which stays.
12. **Automations** (a server with the `automations` capability; create them in the
    desktop app):
    - The project screen has an **Automations** row under the repositories: "Automations ·
      <n>", or "Automations" with none. A server without the capability (an older
      trek-server) shows no row.
    - With an automation that has missed runs, the row ends with " · missed runs" in the
      attention colour.
    - The row opens the list: each automation as a card with its name, its schedule in words
      and timezone ("Weekdays at 09:00 · America/New_York"), "Next: <date and time>" or "Off",
      its last run ("Ran 2 h ago", "Failed 2 h ago: <error>", "Skipped …", or "Never run"), and
      "Agent: …" when it names one.
    - A project with no automations: "No automations. Create them in the desktop app."
    - An automation added, renamed or run on the desktop changes the list without reopening it.
    - Times: "Next:" and an automation's next runs are wall-clock times in the schedule's own
      timezone, the same as the desktop shows, on an iOS and on an Android device (not checked
      on a device yet: the phone's JavaScript engine must know the timezone).
    - If the engine cannot work out a time, the card has no "Next:" line and the automation's
      screen has no "Next runs"; run times and "missed since" show as ages ("2 h ago"). The
      schedule's words do not depend on it. No screen crashes and no time reads "NaN" (not
      checked on a device yet).
    - **Missed runs** (stop the server past an automation's time and start it again): a
      "Missed automations" card is on top of the list, with each such automation's name and
      "<count> missed since <when>".
    - Each row has **Run** and **Skip**, with **Skip** chosen at first; tapping one chooses it.
    - **Done** with one automation on **Run** and another on **Skip**: the first runs (its card
      says "Ran just now", its run is "Missed"), the second does not, and the card goes. The
      desktop's missed-runs dialog closes too.
    - Answer the missed runs on the desktop while the phone's card is up: the card goes
      without a tap.
    - **Done** with **Run** on an automation whose run tab is still working: "Some automations
      did not start" lists "<name>: skipped, the previous run is still working"; **OK** closes it.
    - Two quick taps on **Done** send one answer; the card's buttons are disabled while it runs.
    - With the server out of reach, **Done** shows the error in the card, which keeps its choices.
    - Tapping a card opens the automation: its name and its prompt in full, **On** / **Off**,
      **Run now**, its schedule, and its runs.
    - **Schedule**: the schedule in words, the cron text, the timezone, and "Next runs" with
      three times while it is on (none while it is off), then "Change the schedule in the
      desktop app." Nothing there can be tapped.
    - **Edit** opens a name box and a multi-line prompt box. **Save** saves both, on the
      desktop too; **Cancel** leaves them as they were.
    - **Save** is disabled while the name or the prompt is blank.
    - The name box takes at most 80 characters.
    - A prompt of more than 20,000 characters: **Save** shows the server's refusal
      ("automation.prompt must be at most 20000 characters") and the box keeps the text.
    - After a **Save** the schedule, the timezone, the agent and on / off are as they were
      (check on the desktop's editor).
    - Changed elsewhere: tap **Edit** on the phone, change the automation's name or prompt on
      the desktop, then **Save** on the phone. Nothing is saved; the box stays open with what
      was typed, with "This automation changed on the server" and the desktop's name and
      prompt under the buttons. **Save** again overwrites them; **Cancel** keeps the desktop's.
    - Delete the automation on the desktop while its screen is open: "This automation is
      gone."; with the edit box open, what was typed shows under "You had written:" and can be
      copied.
    - A long prompt in the edit box: the box stops growing and scrolls inside, and **Save**
      stays within reach (not checked on a device yet).
    - With the keyboard up, one tap on **Save** saves, and the box being typed in stays above
      the keyboard, on iOS and on Android (not checked on a device yet).
    - The switch turns the automation off ("Off"; its card says "Off", and the desktop's
      checkbox clears) and on again.
    - Turning off an automation that has missed runs asks "Turn <name> off?" with "Its <n>
      missed runs are discarded." (or "Its 1 missed run is discarded."). **Cancel** leaves it
      on with its missed runs; **Turn off** turns it off, and its missed runs are gone from
      the list's card. Without missed runs nothing is asked.
      If more runs are missed while the question is up, **Turn off** asks again with the new
      count.
    - Turning it on or off with the edit box open leaves the box and its text as they are.
    - The switch does not flip back and forth while its request runs (not checked on a device
      yet).
    - **Run now** starts a run and opens its session, where the prompt is the first message.
      It also runs an automation that is off.
    - **Run now** while the automation's run tab is still working: "The previous run is still
      working." shows under the button, nothing opens, and the run is listed as "Skipped".
    - Two quick taps on **Run now** start one run.
    - **Run now** is disabled while **Edit** is open (it runs the saved prompt, not the typed
      one).
    - **Open run tab** is there once the automation has a run tab (it ran, and the tab was not
      closed) and opens that session; close the tab on the desktop and the button goes.
    - **Runs** lists the runs newest first: the time (in the schedule's timezone), "Scheduled",
      "Manual" or "Missed", and "Ran", "Failed" or "Skipped", with the error under a failed or
      skipped one. An automation that never ran: "No runs yet."
    - Only the newest run that ran says "Open session", and tapping it opens the run tab;
      older runs open nothing (the tab holds the newest run only). With the tab closed, no run
      opens anything.
    - With the server out of reach, **Save**, the switch and **Run now** each show the error
      under themselves, and nothing changes.
13. **Branch history** (a server with the `history` capability):
    - The **Branch** section of a worktree ends with **History**. A server without the
      capability (an older trek-server) shows no button.
    - **History** opens the branch's history: its name, then the entries newest first under
      "Today", "Yesterday" or a date.
    - Each entry says what changed in the desktop History panel's words ("Status Todo → In
      review", "Note edited", "PR set to #42"), then who and when ("You · 09:05", "MCP ·
      <session title>", "Trek"), and the reason when an agent gave one.
    - A workflow tag or custom tag in an entry is drawn in its colour.
    - A branch with nothing recorded: "No changes recorded yet."
    - Live: with the screen open, set the branch's tag on the desktop. The entry appears on
      top without a refresh.
    - Edit the branch's note twice within 5 minutes on the desktop: one note entry, not two.
    - A change to another branch adds nothing to this screen.
    - A branch with more than 100 entries has **Load more** at the bottom; it adds the older
      ones under the list, and goes when there are no more.
    - Two quick taps on **Load more** add each entry once; it is disabled while a page loads
      and while the list is refreshing.
    - Pulling down reloads from the newest: older pages loaded before are dropped, and **Load
      more** brings them back.
    - Send the app to the background for 30 s, change the branch on the desktop, and come
      back: the new entry is in the list without pulling down.
    - With the server out of reach, pulling down shows the error above the list, which stays
      as it was; with nothing loaded yet there is **Try again**.
    - A branch named with a slash, and one with `%41` or `?` in its name (`git branch
      'feat%41/x?y'`): **History** shows that branch's name and its entries, not another's.
14. **Background:**
   - Send the app to the background. A session needing you within ~20 s gives a notification;
     a decision's says "A decision is waiting in <project>", not its question.
   - Tapping the notification opens that session (also with the app closed since).
   - What was already waiting when the app connected gives no notification.
   - Back in the foreground, everything reconnects.
15. **Revocation:** `trek-server token revoke phone-<name>`. The server shows **Pair again**.
    Pairing again from there replaces the entry: the server is listed once.

16. **Push (6b), on a real device only** (a development build with the push entitlement, a
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
17. **What the phone shows** (a server with the `ui` capability; from an agent session in the
    project, with no desktop or web window used since the phone's last screen change):
    - On a worktree's screen, the MCP tool `get_selected_worktree` returns that worktree with
      `client: "phone"` and `terminalId: null`; on a session's screen, its worktree and that
      session's `terminalId`; on the project screen, `worktree: null`.
    - `focus_session` with a session's `terminalId`, from the project's or a worktree's screen,
      opens that session's screen (Back returns to the screen before); from another session's
      screen, it takes that screen's place (Back returns to the screen before that one, however
      many times it is asked); with the session already shown, nothing moves.
    - On the Servers or Projects screen only (no project open), both tools say no client has
      the project open.
18. **The demo** (no server needed; with no servers paired first):
    - The home screen shows **Try the demo**; tapping it opens the `acme-web` project, and
      Servers lists "Demo server" as Connected with a **Demo** badge.
    - Needs you lists the decision on *Fix login timeout*, the PR #42 notice, *Redesign
      checkout summary* finished and the nightly run finished. **Send answer** "1" on the
      decision: the reply plays in its terminal, then the session is finished. Typing "1"
      and Enter in that terminal instead does the same.
    - Tapping the PR #42 notice, or the pull request in Branch details, shows a "Demo pull
      request" alert; nothing opens.
    - *Add timeout tests* prints a line every few seconds, then finishes.
    - Changes on `feature/checkout-redesign`: three files, two draft comments on their lines.
      Add one, **Send to…** the Claude session: the review is in its queue (2 queued: the
      pull request's prompt was there already). Queued prompts stay queued, as on a real server.
    - Branch details: change the tag, custom tags, note, ticket and pull request (to another
      link: the watch stops); each shows in History.
    - **Add worktree** `feature/saved-carts`, start a Codex session in it, send a prompt, then
      remove the worktree.
    - Automations: **Run now** on *Weekly changelog*; **Done** with **Run** on the nightly's
      missed run. In a fresh demo, turning the nightly off before that asks "Its 1 missed run
      is discarded." first.
    - Background the app for 30 s and come back: the changes are still there.
    - Servers: **Open the demo** goes to the project; **Remove** asks, then the row goes.
      **Try the demo** again starts it fresh. Relaunch the app: no demo row.

The repo's checks use no real push service (APNs, FCM, Expo): `npm run smoke:push` runs
against a local APNs stub.
