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

The wood and markers are spent at the camp (part 3a): the header's counts are a button that opens a
popover. **Camp** lists each building's next tier: string lights (they glow over the camp), the fire
ring II and III (warmth lifts working wood up to ×1.75 and ×2), a garden (2, then 5 wood an hour,
always), the lake and its dock (each resting crew member fishes 1, then 2 wood an hour) and up to
three cabins (3 more bunks each). **Crew** lists the members (level, XP, where they are) and three
walk-ins a day to hire into a free bunk (200 wood, 50 more for each hire after). Cabins stand at the
strip's left end, the lake and the garden at its right (narrow windows drop the outermost first);
click one to open its row. When no window has seen the camp for more than 4 hours, every window
shows a "While you were away" card with what it earned until one dismisses it. A window sees the
camp only while its strip is shown (expanded or collapsed): with the strip turned off you are away
from the camp, so the card may cover a long time when you turn it back on. A server restart or
upgrade is not time away (the seen clock moves on by the downtime).

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: the camp (part 2): `server/camp.ts` wires core's activity feed (`host.onActivity`) through the reward rules into `camp.json` (`server/store.ts`), answers `campsite.state` and sends `state` to every project's windows (`host.emitAll`); `TREK_CAMPSITE_MINUTE_MS` shortens a working minute for tests; the shop's handlers `build`, `recruit`, `seen` and `awaySeen` (part 3a); `TREK_CAMPSITE_SEED_WOOD` (test-only) gives a fresh camp wood and 3 markers for the smokes
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
  - `economy.ts`: what earns what (minutes × warmth, answers, completions, pull requests, commits); caps and the ledger; the fire ring's ceiling, the garden and fishing
  - `catalog.ts`: the buildings' tiers, costs and effects, and the numbers behind them (tunable)
  - `shop.ts`: offers, bunks, the day's walk-ins, build and recruit
  - `away.ts`: the "While you were away" tally, when it is due, and its line
  - `campView.ts`: what the camp popover's rows say
  - `campEdges.ts`: where buildings stand at the strip's ends, and the middle left for the tents
  - `buildingPixels.ts`: the buildings' pixels, the fire ring's stones, the string lights, the popover's icons
- `client/`: the slots `sessionIndicator`, `terminalBarEnd`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip and its collapsed bar), `Tent.tsx` (a tent's sign, a camp's badge and its grouped popover; Pixi draws the tent), `MiniHiker.tsx` (a tab-size hiker in the collapsed bar), `CampPopover.tsx` (the camp: build and hire), `AwayCard.tsx` (While you were away)
  - `scene/`: the expanded strip, drawn by Pixi. `PixiStrip.tsx` loads `CampStage.ts` on first use and lays a DOM overlay of buttons over the hikers and the dog (names, focus, clicks); `CampStage.ts` runs the app and draws the backdrop, tents and log; `scene/actors/` (hikers, dog, fire, buildings) draw and animate the rest; `textures.ts` and `draw.ts` turn the pixel data and geometry into Pixi objects. Without a renderer (WebGL, else WebGPU) the strip shows a note and a row of tab-size hikers.
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `campStore.ts` (the camp's snapshot, shared), `hooks.ts` (sessions, selection, prefs, the camp, the seen heartbeat (`useSeen`: on load, when the window is visible again and every 5 minutes, while the strip is shown), width, reduced motion)
  - `campsite.css`: the tab and terminal-bar hikers' animations, the overlay, header, badges and popover; `prefers-reduced-motion` is handled here and in `CampStage` (hikers stand still)
- `dev/`: a page with the strip on a fake host; `npm run campsite:render` screenshots it per scenario into `.campsite-render/` (gitignored; not `out/`, which the app packages)

Besides the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`), it has five methods (`state`, the camp's snapshot; `build` and `recruit`, which
answer the new snapshot; `seen`, sent on load and every 5 minutes while a window and its strip are shown;
`awaySeen`, the card's dismiss) and one event (`state`, sent when the snapshot changes).
