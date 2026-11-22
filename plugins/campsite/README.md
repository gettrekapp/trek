# The campsite plugin

A pixel-art hiker for each agent session: on its tab (in place of the status dot), on its
terminal's button row, and at a campsite strip along the bottom of the project window. Hikers who
need you wave by the fire, under a "!" (a bell) or a "?" (a pending `request_decision`); working
ones do camp chores; finished ones cheer; ones marked complete sit with a cocoa; idle ones sleep in
their bag. Click a hiker at camp to show its session. A camp dog runs about the strip; click it to pet
it (it belongs to no session and does nothing else). Real work earns the camp (one for the whole
server) wood and trail markers, which the strip's header counts (`🪵 340 · ⛳ 2`); each session
borrows a named crew member while its agent runs, whom its hikers' tooltips name (`Aspen · Lv 2
Trailblazer`, or `Day hiker` when the crew is all out). A member comes back to camp when the agent
stops (it exits, its worktree is unloaded, a promote moves it, or the session closes), and the next
launch borrows one again; an automation's run tab always gets a day hiker (it still earns wood).
Commits earn wood as new commits on a worktree's head, however they got there (a commit, a pull, a
fast-forward merge); a head that moves anywhere else (a rewrite, a reset back) earns nothing.

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: the camp (part 2): `server/camp.ts` wires core's activity feed (`host.onActivity`) through the reward rules into `camp.json` (`server/store.ts`), answers `campsite.state` and sends `state` to every project's windows (`host.emitAll`); `TREK_CAMPSITE_MINUTE_MS` shortens a working minute for tests
- `shared/`: pure, tested in `scripts/campsite*.test.mjs`
  - `hiker.ts`: a look from the session id (provider = jacket color)
  - `pixels.ts`: the 12×16 pixels of each pose
  - `pose.ts`: the stance for a status, the rotating chores (`choreFor` is where activity detection would go), labels
  - `layout.ts`: where tents, the log and hikers stand; grouped mode when crowded (`moreWaiting` and `moreTents` count what does not fit); badge wording and color, tent colors, which way a camp's list opens, the header line, the collapsed row
  - `dog.ts`: the camp dog's pixels, and where it runs next
  - `stage.ts`: the Pixi strip's pure half: pixels to RGBA, the motions' timing, walks in and off (`reconcileMovers`), the dog's wander, and where the backdrop, fire, tents, log and signs go
  - `prefs.ts`: the per-app switches
  - `camp.ts`: the camp and its snapshot
  - `crew.ts`: names, assignment, levels
  - `economy.ts`: what earns what (minutes × warmth, answers, completions, pull requests, commits); caps and the ledger
- `client/`: the slots `sessionIndicator`, `terminalBarEnd`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip and its collapsed bar), `Tent.tsx` (a tent's sign, a camp's badge and its grouped popover; Pixi draws the tent), `MiniHiker.tsx` (a tab-size hiker in the collapsed bar)
  - `scene/`: the expanded strip, drawn by Pixi. `PixiStrip.tsx` loads `CampStage.ts` on first use and lays a DOM overlay of buttons over the hikers and the dog (names, focus, clicks); `CampStage.ts` draws and animates; `textures.ts` and `draw.ts` turn the pixel data and geometry into Pixi objects. Without a renderer (WebGL, else WebGPU) the strip shows a note and a row of tab-size hikers.
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `campStore.ts` (the camp's snapshot, shared), `hooks.ts` (sessions, selection, prefs, the camp, width, reduced motion)
  - `campsite.css`: the tab and terminal-bar hikers' animations, the overlay, header, badges and popover; `prefers-reduced-motion` is handled here and in `CampStage` (hikers stand still)
- `dev/`: a page with the strip on a fake host; `npm run campsite:render` screenshots it per scenario into `.campsite-render/` (gitignored; not `out/`, which the app packages)

Besides the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`), it has one method (`state`, the camp's snapshot) and one event (`state`, sent when
the snapshot changes).
