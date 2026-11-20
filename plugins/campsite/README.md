# The campsite plugin

A pixel-art hiker for each agent session: on its tab (in place of the status dot), on its
terminal's button row, and at a campsite strip along the bottom of the project window. Hikers who
need you wave by the fire, under a "!" (a bell) or a "?" (a pending `request_decision`); working
ones do camp chores; finished ones cheer; ones marked complete sit with a cocoa; idle ones sleep in
their bag. Click a hiker at camp to show its session.

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: nothing to serve; registered so the server lists it (per-project on/off)
- `shared/`: pure, tested in `scripts/campsite*.test.mjs`
  - `hiker.ts`: a look from the session id (provider = jacket color)
  - `pixels.ts`: the 12×16 pixels of each pose
  - `pose.ts`: the stance for a status, the rotating chores (`choreFor` is where activity detection would go), labels
  - `layout.ts`: where tents, the log and hikers stand; grouped mode when crowded (`moreWaiting` and `moreTents` count what does not fit); badge wording and color, tent colors, which way a camp's list opens, the header line, the collapsed row
  - `prefs.ts`: the per-app switches
- `client/`: the slots `sessionIndicator`, `terminalBarEnd`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip and its collapsed bar), `CampScene.tsx` (the dusk backdrop), `CampHiker.tsx` (a walking hiker), `Tent.tsx` (a tent in its worktree's color, and its grouped popover), `MiniHiker.tsx` (a tab-size hiker in the collapsed bar)
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `hooks.ts` (sessions, selection, prefs, width, reduced motion)
  - `campsite.css`: the animations; `prefers-reduced-motion` is handled here, so hikers stand still

It uses only the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`): no methods or events of its own.
