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

The crew has depth (part 3b). The **gear shed** (250 wood, then 800 wood and a marker) stands inside
the cabins at the strip's left end (the first building a narrow window drops) and lets members buy
gear: a pack, boots, a hat and a tool, three tiers each (60, 200 and 500 wood; tier 2 needs Lv 3,
tier 3 the shed's second tier and Lv 5). Each item adds 2, 4 or 6% to the wood credited to that
member's sessions (+24% fully geared; day hikers, automations, the garden and fishing get none), and
shows on its hiker everywhere: the strip, the tab and the terminal bar. In the Crew tab each member is
a button that opens its view: its portrait, its bonus, what it goes out on (any session, or a session
type or agent the camp saw start a session in the last 30 days: a pinned member goes out only on
those, and rests otherwise), its gear, and its trail journal (joined, trips of a minute or more,
summits when a pull request of its worktree's branch merges, levels, gear, pins; the last 40). The
journal is not pushed with the camp's snapshot (each member has only its `journalCount` and
`journalAt`): the member view asks for it (`journal { crewId }`) while it is open, and again when
those, its XP, gear or pin change.

Every worktree's branch is a trail (part 3c): each worktree on a branch, except a repository's main
checkout, climbs its project's mountain, a peak behind the fire. Only real milestones move it: a
commit takes it to the switchbacks, its pull request to the ridge, green checks to the false summit
(failed checks back to the ridge), the merge to the summit (a closed PR back to the switchbacks).
Each of the window's project's trails is a flag in its worktree's tent colours on its stage's ledge
(click it for the Trails tab at its row); a summit here climbs the flag to the peak, raises sparks
from the fire and says "⛳ Summited `branch`" in the header. A summited trail stays at the peak for 24
hours (or until its worktree goes), then moves to the project's history; a worktree removed below
the summit (or whose branch changes) turns back. Merges build a cairn at the trailhead (sizes at 1, 3,
10, 25, 50 and 100 summits). The popover's **Trails** tab lists this project's trails and history;
the **trail signpost** (150 wood, at the right end inside the garden, the first building dropped
there) adds every other project's trails and counts them on its planks. The history is not pushed:
the tab asks for it (`trailLog { projectId }`). The server reconciles a project's trails with its
worktrees at start-up (the projects with trails), the first time it hears from a project (an event,
or a window's `state`, which names its project), after each worktree event, and every 10 minutes;
before a commit or pull request event it opens any missing trail first (a worktree made outside Trek,
`git worktree add -b feat`, has its trail before that event moves it). For 2 minutes after the server
starts (the restart grace period) reconciles only open missing trails: until core's poller first
refreshes, the worktrees' branches come from the saved project file and can be stale, so nothing is
ended, turned back or restarted then; the first tick after the grace period reconciles fully.

Some trails end as "Turned back" though their work goes on: promoting a worktree to primary, moving
a worktree to another server, and removing a worktree before its merge is seen. The merge still
counts as a summit (and grows the cairn) when it arrives later. A branch that summited and stays
checked out in its worktree shows no trail (after its 24 hours at the peak) until that worktree
changes branch.

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: the camp (part 2): `server/camp.ts` wires core's activity feed (`host.onActivity`) through the reward rules into `camp.json` (`server/store.ts`, version 4; older versions migrate on load), answers `campsite.state` and sends `state` to every project's windows (`host.emitAll`); `TREK_CAMPSITE_MINUTE_MS` shortens a working minute for tests; the shop's handlers `build`, `recruit`, `seen` and `awaySeen` (part 3a), `gear`, `pin` and `journal` (part 3b), `trailLog` and the `summit` event (part 3c); the host's `projectName` and `worktree` name the journal's places (`hostWhere`); `TREK_CAMPSITE_SEED_WOOD` (test-only) gives a fresh camp wood and 3 markers for the smokes
- `shared/`: pure, tested in `scripts/campsite*.test.mjs`
  - `hiker.ts`: a look from the session id (provider = jacket color); `withKit` dresses it in a member's gear
  - `pixels.ts`: the 12×16 pixels of each pose, with the gear's pack, boots, hat and tool
  - `pose.ts`: the stance for a status, the rotating chores (`choreFor` is where activity detection would go), labels
  - `layout.ts`: where tents, the log and hikers stand; grouped mode when crowded (`moreWaiting` and `moreTents` count what does not fit); badge wording and color, tent colors, which way a camp's list opens, the header line, the collapsed row
  - `dog.ts`: the camp dog's pixels, and where it runs next
  - `stage.ts`: the Pixi strip's pure half: pixels to RGBA, the motions' timing, walks in and off (`reconcileMovers`), the dog's wander, and where the backdrop, fire, tents, log and signs go
  - `prefs.ts`: the per-app switches
  - `camp.ts`: the camp and its snapshot
  - `crew.ts`: names, assignment (pins first), trips, levels, summits, pinning, the seen session types and agents, each session's gear for its hiker
  - `journal.ts`: a member's journal entries and their words
  - `economy.ts`: what earns what (minutes × warmth, answers, completions, pull requests, commits); caps and the ledger; the fire ring's ceiling, the garden and fishing
  - `catalog.ts`: the buildings' tiers, costs and effects, and the numbers behind them; gear (slots, tiers, prices, bonuses, gates) (tunable)
  - `shop.ts`: offers, bunks, the day's walk-ins, build, recruit and buyGear
  - `away.ts`: the "While you were away" tally, when it is due, and its line
  - `campView.ts`: what the camp popover's rows say, and a member's view (gear rows, the pin's choices, the bonus)
  - `campEdges.ts`: where buildings stand at the strip's ends, and the middle left for the tents
  - `buildingPixels.ts`: the buildings' pixels, the fire ring's stones, the string lights, the popover's icons
  - `trails.ts`: the trails' stages, what moves them (`trailEvent`), `reconcile` with a project's worktrees, the history, the cairn's size
  - `mountain.ts`: the peak, its ledges and path, the flags' places and pixels, the summit's climb and sparks, the cairn's pixels and place
- `client/`: the slots `sessionIndicator`, `terminalBarEnd`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip and its collapsed bar), `Tent.tsx` (a tent's sign, a camp's badge and its grouped popover; Pixi draws the tent), `MiniHiker.tsx` (a tab-size hiker in the collapsed bar), `CampPopover.tsx` (the camp: build and hire), `MemberView.tsx` (a member: pin, gear, journal), `TrailsTab.tsx` (the trails and their history), `AwayCard.tsx` (While you were away)
  - `scene/`: the expanded strip, drawn by Pixi. `PixiStrip.tsx` loads `CampStage.ts` on first use and lays a DOM overlay of buttons over the buildings, the flags, the cairn, the hikers and the dog (names, focus, clicks); `CampStage.ts` runs the app and draws the backdrop, tents and log; `scene/actors/` (mountain and cairn, hikers, dog, fire, buildings) draw and animate the rest; `textures.ts` and `draw.ts` turn the pixel data and geometry into Pixi objects. Without a renderer (WebGL, else WebGPU) the strip shows a note and a row of tab-size hikers.
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `campStore.ts` (the camp's snapshot, shared; a member's journal on request), `hooks.ts` (sessions, selection, prefs, the camp, the seen heartbeat (`useSeen`: on load, when the window is visible again and every 5 minutes, while the strip is shown), a session's hiker look in its member's gear (`useHikerLook`: it listens for the session's kit alone, so a push that only moves the wood doesn't render the hikers again), width, reduced motion)
  - `campsite.css`: the tab and terminal-bar hikers' animations, the overlay, header, badges and popover; `prefers-reduced-motion` is handled here and in `CampStage` (hikers stand still)
- `dev/`: a page with the strip on a fake host; `npm run campsite:render` screenshots it per scenario into `.campsite-render/` (gitignored; not `out/`, which the app packages)

Besides the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`), it has nine methods (`state`, the camp's snapshot; `build`, `recruit`, `gear` and `pin`, which
answer the new snapshot; `journal`, a member's journal; `trailLog`, a project's ended trails; `seen`, sent on load and every 5 minutes while a window and its strip are shown;
`awaySeen`, the card's dismiss) and two events (`state`, sent when the snapshot changes; `summit`, when a merge first paid summits a trail).
