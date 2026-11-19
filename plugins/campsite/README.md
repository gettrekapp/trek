# The campsite plugin

A pixel-art hiker for each agent session: on its tab (in place of the status dot), in its
terminal's corner, and at a campsite strip along the bottom of the project window. Hikers who need
you (a bell, or a pending `request_decision`) wave by the fire; working ones do camp chores; done
ones sit with a cocoa; idle ones doze. Click a hiker at camp to show its session.

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: nothing to serve; registered so the server lists it (per-project on/off)
- `shared/`: pure, tested in `scripts/campsite*.test.mjs`
  - `hiker.ts`: a look from the session id (provider = jacket color)
  - `pixels.ts`: the 12×16 pixels of each pose
  - `pose.ts`: the stance for a status, the rotating chores (`choreFor` is where activity detection would go), labels
  - `layout.ts`: where tents, the log and hikers stand; grouped mode when crowded (`moreWaiting` and `moreTents` count what does not fit)
  - `prefs.ts`: the per-app switches
- `client/`: the slots `sessionIndicator`, `terminalOverlay`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip), `CampScene.tsx` (night backdrop), `CampHiker.tsx` (a walking hiker), `Tent.tsx` (a tent and its grouped popover)
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `hooks.ts` (sessions, selection, prefs, width, reduced motion)
  - `campsite.css`: the animations; `prefers-reduced-motion` is handled here, so hikers stand still

The core's terminal-overlay wrapper dims the corner hiker while the user types or scrolls back.

It uses only the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`): no methods or events of its own.
