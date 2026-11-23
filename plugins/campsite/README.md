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
worktrees the first time it hears from a project (an event, or a window's `state`, which names its
project), after each worktree event, and every 10 minutes; before a commit or pull request event it
opens any missing trail first (a worktree made outside Trek, `git worktree add -b feat`, has its trail
before that event moves it; a commit in a worktree that summited another branch starts its new
trail). For 2 minutes after the server starts (the restart grace period) only those openings before a
commit or pull request event run: until core's poller first refreshes, the worktrees' branches come
from the saved project file and can be stale, so the trails stay as `camp.json` saved them (a new
worktree's own event still opens or ends its trail) and nothing is ended, turned back or restarted;
the first tick after the grace period reconciles fully.

Some trails end as "Turned back" though their work goes on: promoting a worktree to primary, moving
a worktree to another server, and removing a worktree before its merge is seen. The merge still
counts as a summit (and grows the cairn) when it arrives later. A branch that summited and stays
checked out in its worktree shows no trail (after its 24 hours at the peak) until that worktree
changes branch.

**The world** (part 3d-1, looks only: nothing here pays). The strip's sky follows the window's
clock: dawn 05–08, day 08–17, dusk 17–20 and night 20–05, each blending into the next over its
last 30 minutes. Day is a muted blue-grey with a pale sun and dark string lights; night is darker,
with more stars and a wider glow from the fire. The seasons follow the month (northern, or southern:
six months on): winter frosts the pines, whitens the ground's edge, caps the ridge and the peak with
snow and lets a few flakes fall; spring puts small flowers on the ground (clear of the tents, the
log, the hikers, the fire and the buildings; the dog's button can pass over one); summer brings
fireflies at dusk and night; autumn rusts some pines and drops leaves. The weather is the window's
project's: rain while any of its trails' *watched* pull requests has failing checks (for at most 24
hours after their last result, so unlinking the pull request or turning its watch off leaves the
rain up for the rest of those 24 hours; snow in winter), fog once it has been quiet for 12 hours
(no activity event and no working minute; right after upgrading, a project has no last activity
and shows no fog until its next event), else clear. The header shows 🌧️, ❄️ or 🌫️ after the
counts when there is room for it (a narrow strip drops it before the counts would reach the peak),
its title saying why ("Rain: checks failing on feature/x", "Fog: quiet for 14 h"); the counts
button's title and label always say it too ("… · Rain: checks failing on feature/x"). Under reduced motion nothing falls or drifts: a few still streaks, flakes, leaves or
fireflies, and still fog. Settings → Plugins → Campsite has **Sky** (Follow the clock, or Always
dusk: the strip's look before 3d) and **Seasons** (Northern, Southern, Off). Dusk with the seasons
off and clear weather is exactly the strip before 3d-1.

**Wildlife** (part 3d-2, collection only: nothing here pays). 24 species (20 common, 4 rare) cross
the strip now and then. The server rolls each minute for every project it knows where the plugin
is on and that is active (a working session, or activity in the last 10 minutes) or has a window
open: a 1 in 20 chance while active, else 1 in 120; ranger tower II lifts both by a quarter. A quiet
project with no window open doesn't roll, so a server left running doesn't fill the guide unseen. The species is drawn by weight
among those the project's time of day, season and weather allow (by the windows' time zone and
Seasons setting, which each window's `seen` ping reports: one clock for the whole camp, the last
ping wins, so windows in different zones take turns; the Sky setting doesn't gate), and the
lake (swimmers) and the ranger tower (the rares, one draw in 80) let in; never the species just
seen there. Each sighting goes into the field guide (how many, first and last), the last 30
sightings (`camp.sightings`, saved but not shown yet: kept for later use) and the away card ("2 new species: Great blue heron, Lynx · … · 12 sightings", the new
species first so the one line never cuts them off), and the
`sighting` event goes to that project's windows only. In an expanded, visible strip its animal
crosses, one at a time (one arriving during a crossing is logged but not drawn): a walker on the
treeline behind the buildings, tents and hikers (15–25 s, one pause), a flier between the header
and the ridge, clear of the peak's flags (8–12 s), a swimmer bobbing on the lake for 20 s (none
without the lake); a shade darker at night; standing still for 10 s under reduced motion (a walker
in a gap clear of the tents, the log, the fire and the buildings). It goes at once when the strip
collapses, changes width or moves the lake, or reduced motion changes. Its
button opens the camp popover's **Guide** tab at its card: a grid of the 24 (still sprite, name,
count, first day; unseen a silhouette and "???"; rares last, "Needs the ranger tower" without
it), with a dot on species first seen since the tab was last opened (`guideSeenAt`, per app), and
hints from each unseen species' gates with ranger tower II. The **ranger tower** (500 wood and 2
markers; II: 1,200 and 3) stands at the strip's left end, outside the cabins, and is the last
building dropped there.

Working hikers show what their agent is doing (part 4), for agents that report their tool calls
(Claude, from its session transcript; Codex, Gemini, Grok and Local report none yet and keep the
random chores). Core follows each Claude session's tool calls (an agent's `activity`) into the
activity feed as `session.tool`, at most one each 2 s per session; the server keeps each session's
latest in memory (never in `camp.json`, and it pays nothing) and sends it as `tool` to that
project's windows. A call less than 8 s old shows its chore: reading (Read, Grep, Glob, LS) the map,
editing chopping wood, a command tending the fire, a subagent pitching the tent, the web binoculars,
an MCP tool the radio (its antenna blinking), anything else the map; after 8 s the hiker sits and
thinks until the next call, and two minutes after the last one it goes back to the random chores (a
`/clear` in Claude starts a new transcript that isn't followed, so its calls stop coming). The strip's and the terminal bar's tooltips name it ("Editing
Campsite.tsx", "Running npm test", "Sending a scout: Explore the trails", "Looking up github.com",
"On the radio: trek-dev list_worktrees", "Thinking"); the tab's title keeps the status words.

- `manifest.ts`: id `campsite`, on by default, no secrets or settings
- `server/`: the camp (part 2): `server/camp.ts` wires core's activity feed (`host.onActivity`) through the reward rules into `camp.json` (`server/store.ts`, version 6; older versions migrate on load), answers `campsite.state` and sends `state` to every project's windows (`host.emitAll`); `TREK_CAMPSITE_MINUTE_MS` shortens a working minute for tests; the shop's handlers `build`, `recruit`, `seen` and `awaySeen` (part 3a), `gear`, `pin` and `journal` (part 3b), `trailLog` and the `summit` event (part 3c); each project's last activity and the trails' checks for the weather (part 3d-1); the host's `projectName` and `worktree` name the journal's places (`hostWhere`); `TREK_CAMPSITE_SEED_WOOD` (test-only) gives a fresh camp wood and 3 markers for the smokes; wildlife (part 3d-2): `seen` keeps the window's time zone and Seasons setting, the minute tick rolls sightings and sends `sighting` to a project's windows (`host.emit`), `build` takes the ranger tower; `TREK_CAMPSITE_FORCE_SIGHTINGS=1` (test-only, honoured only with `TREK_CAMPSITE_MINUTE_MS` set too, as the smoke does; a warning at start-up either way) makes every roll a sighting; a removed project's last species goes with its last activity; real chores (part 4): each session's latest tool call (`session.tool`) in memory, sent as `tool { terminalId, tool }` to its project's windows (`tool: null` when its agent starts again, stops or exits, or it closes), and in a window's `state` answer as `tools` (by session, with their age)
- `shared/`: pure, tested in `scripts/campsite*.test.mjs`
  - `hiker.ts`: a look from the session id (provider = jacket color); `withKit` dresses it in a member's gear
  - `pixels.ts`: the 12×16 pixels of each pose (binoculars, radio and think for part 4's chores), with the gear's pack, boots, hat and tool
  - `pose.ts`: the stance for a status, a working hiker's chore (`choreFor`: its latest tool call's, thinking after 8 s, the rotating random ones after 2 minutes or with none; `liveTool`: the call its words name), labels and the tool calls' words
  - `layout.ts`: where tents, the log and hikers stand; grouped mode when crowded (`moreWaiting` and `moreTents` count what does not fit); badge wording and color, tent colors, which way a camp's list opens, the header line, the collapsed row
  - `dog.ts`: the camp dog's pixels, and where it runs next
  - `stage.ts`: the Pixi strip's pure half: pixels to RGBA, the motions' timing, walks in and off (`reconcileMovers`), the dog's wander, and where the backdrop, fire, tents, log and signs go
  - `prefs.ts`: the per-app switches, the sky and seasons choices, and when the field guide was last opened
  - `camp.ts`: the camp and its snapshot
  - `crew.ts`: names, assignment (pins first), trips, levels, summits, pinning, the seen session types and agents, each session's gear for its hiker
  - `journal.ts`: a member's journal entries and their words
  - `economy.ts`: what earns what (minutes × warmth, answers, completions, pull requests, commits); caps and the ledger; the fire ring's ceiling, the garden and fishing
  - `catalog.ts`: the buildings' tiers, costs and effects, and the numbers behind them; gear (slots, tiers, prices, bonuses, gates) (tunable)
  - `shop.ts`: offers, bunks, the day's walk-ins, build, recruit and buyGear
  - `away.ts`: the "While you were away" tally, when it is due, and its line
  - `campView.ts`: what the camp popover's rows say, a member's view (gear rows, the pin's choices, the bonus), and the field guide's cards and hints
  - `campEdges.ts`: where buildings stand at the strip's ends, and the middle left for the tents
  - `buildingPixels.ts`: the buildings' pixels (the ranger tower's too), the fire ring's stones, the string lights, the popover's icons
  - `trails.ts`: the trails' stages, what moves them (`trailEvent`), `reconcile` with a project's worktrees, the history, the cairn's size
  - `mountain.ts`: the peak, its ledges and path (in the world's colours, `mountainLook`), the flags' places and pixels, the summit's climb and sparks, the cairn's pixels and place
  - `world.ts`: the time of day (`phaseAt`), the season (`seasonAt`), the backdrop's palettes (`paletteAt`; dusk is the strip's colours before 3d), the weather (`weatherOf`), the world's key, the snow caps (`capsAbove`), the wall clock in another time zone (`zonedDate`)
  - `wildlife.ts`: the 24 species and their gates, the draw (`pickSpecies`), the minute's roll and its odds, the guide, the last sightings, the windows' clock
  - `animalPixels.ts`: each species' two frames, as rows of letters
  - `crossing.ts`: where an animal goes on the strip and for how long
  - `touches.ts`: spring's flowers, the particle pool (rain, snow, leaves, fireflies; at most 60, moved in place), fog's bands
- `client/`: the slots `sessionIndicator`, `terminalBarEnd`, `bottomBar` and `settings`
  - `Campsite.tsx` (the strip and its collapsed bar), `Tent.tsx` (a tent's sign, a camp's badge and its grouped popover; Pixi draws the tent), `MiniHiker.tsx` (a tab-size hiker in the collapsed bar), `CampPopover.tsx` (the camp: build and hire), `MemberView.tsx` (a member: pin, gear, journal), `TrailsTab.tsx` (the trails and their history), `GuideTab.tsx` (the field guide), `AwayCard.tsx` (While you were away)
  - `scene/`: the expanded strip, drawn by Pixi. `PixiStrip.tsx` loads `CampStage.ts` on first use and lays a DOM overlay of buttons over the buildings, the flags, the cairn, the hikers, the dog and a sighting's animal (names, focus, clicks); `CampStage.ts` runs the app and draws the tents and log; `scene/actors/` (the world: the backdrop, flowers and fog; mountain and cairn, hikers, dog, fire, buildings, particles, wildlife) draw and animate the rest; `textures.ts` and `draw.ts` turn the pixel data and geometry into Pixi objects. Without a renderer (WebGL, else WebGPU) the strip shows a note and a row of tab-size hikers.
  - `Hiker.tsx`, `SessionIndicator.tsx`, `TerminalHiker.tsx`, `Settings.tsx`
  - `prefsStore.ts` (the per-app prefs, shared by the slots), `campStore.ts` (the camp's snapshot, shared; a member's journal on request; each session's latest tool call, stamped with the window's clock), `hooks.ts` (sessions, selection, prefs, the camp, the seen heartbeat (`useSeen`: on load, when the window is visible again and every 5 minutes, while the strip is shown), a session's hiker look in its member's gear (`useHikerLook`: it listens for the session's kit alone, so a push that only moves the wood doesn't render the hikers again), the sessions' tool calls (`useTools`, `useTool`), width, reduced motion)
  - `campsite.css`: the tab and terminal-bar hikers' animations, the overlay, header, badges and popover; `prefers-reduced-motion` is handled here and in `CampStage` (hikers stand still)
- `dev/`: a page with the strip on a fake host; `npm run campsite:render` screenshots it per scenario into `.campsite-render/` (gitignored; not `out/`, which the app packages); `?at=` (a local time) starts its clock there and lets it run on (it stands still with `--freeze`) and turns on the clock's sky, `?seasons=north|south|off` picks the seasons with it (northern by default), and `?weather=rain|fog` forces the weather; `?tower=1|2`, `?guide=some`, `?away=sightings`, `?animal=<species>&age=<ms>&dir=left|right&r=<0–1>` (an animal that far into its crossing; `r` pins the crossing's die, its length, pause and spot, default 0.5) and `?sheet=1` (every species' two frames) show the wildlife; `?tool=read|edit|run|delegate|web|mcp|other|think` gives the working t1 a tool call (`think`: one 20 s old) and `?sheet=hikers` shows every hiker pose at scales 1–3; `npm run campsite:render -- <dir> --freeze` stops the page's clocks (and seeds `Math.random`), so two runs can be compared byte for byte

Besides the host's session view (`sessions`, `onSessionsChanged`, `selectedTerminalId`,
`focusSession`), it has nine methods (`state`, the camp's snapshot; `build`, `recruit`, `gear` and `pin`, which
answer the new snapshot; `journal`, a member's journal; `trailLog`, a project's ended trails; `seen`, sent on load and every 5 minutes while a window and its strip are shown;
`awaySeen`, the card's dismiss) and four events (`state`, sent when the snapshot changes; `summit`, when a merge first paid summits a trail; `sighting`, to one project's windows when an animal is seen there; `tool`, to one project's windows when a session's latest tool call changes or goes).
