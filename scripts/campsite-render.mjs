// scripts/campsite-render.mjs — screenshots the campsite strip (the real component on a fake host,
// plugins/campsite/dev/) in headless Chrome, one PNG per scenario, to look at the Pixi scene
// without running the app. Not a test: it fails only if the page errors or Pixi can't start.
// The page carries the app's CSP (no 'unsafe-eval'), so a render also proves Pixi starts under it.
// Usage: node scripts/campsite-render.mjs [outDir] [--freeze]   (default .campsite-render, not out/:
// the app packages out/**; CHROME_PATH picks the browser). --freeze stops the page's clocks before
// any of its scripts runs (FREEZE below; the harness's ?freeze=1 too) and screenshots with CSS
// animations and transitions finished, so two runs write the same bytes: render before and after a
// change that must not move anything and `cmp` the PNGs.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const freeze = args.includes('--freeze')
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, '.campsite-render'))
const CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}
const TABLET_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const SHOTS = [
  { name: 'empty', scenario: 'empty' },
  { name: 'few', scenario: 'few' },
  { name: 'few-reduced', scenario: 'few', reduced: true },
  // A tablet's user agent and touch: where Pixi's accessibility system would add its button
  { name: 'few-narrow', scenario: 'few', width: 600, touch: true },
  { name: 'exited', scenario: 'exited' },
  { name: 'grouped', scenario: 'grouped' },
  { name: 'no-dog', scenario: 'few', dog: false },
  // Every building at its top tier: all three cabins, the lake and dock, the beds, fire ring III, the lights
  { name: 'built-out', scenario: 'few', built: 'out', width: 1600 },
  // A narrow window: the outermost buildings are dropped (one cabin; the garden without the lake)
  { name: 'narrow', scenario: 'few', built: 'out', width: 700 },
  // The "While you were away" card over the strip
  { name: 'away', scenario: 'few', away: true },
  // Crew depth (campsite 3b): t1–t3's members wear tier 3, mixed and tier 1 gear on the strip, the shed built out
  { name: 'geared-crew', scenario: 'few', crew: 'geared', built: 'out', width: 1600 },
  // The camp popover's member view: portrait, bonus, pin, gear rows (Buy and a gate) and journal (the whole page, taller)
  { name: 'member-view', scenario: 'few', crew: 'geared', built: 'out', member: true, height: 720 },
  // A camper's card (a hiker clicked): a crew member's (t1), and a day hiker's (t4, at the Global log); and t1's hover label
  { name: 'camper', scenario: 'few', crew: 'geared', built: 'out', camper: 't1', height: 400 },
  { name: 'camper-day', scenario: 'few', camper: 't4', height: 400 },
  { name: 'camper-hover', scenario: 'few', camper: 't1', hover: true },
  // Trails (campsite 3c): flags on every ledge ("+2" on the switchbacks), the planted summit, the cairn at 12 summits, the signpost
  { name: 'trails', scenario: 'few', trails: 'all', built: 'out', width: 1600 },
  // A middle narrower than the peak (440 px) scales it sideways (never dropped): only a window this
  // narrow has one, since the buildings give way before the camps and the middle never drops below ~500 px
  { name: 'trails-narrow', scenario: 'few', trails: 'all', width: 360 },
  // The same with failing checks: no room for the header's 🌧 beside the counts, so it is dropped (the counts' title and label say why)
  { name: 'trails-narrow-rain', scenario: 'few', trails: 'all', width: 360, weather: 'rain' },
  // A summit mid-celebration: the planted flag climbing, sparks over the fire, the header's line (caught 700 ms in)
  { name: 'summit', scenario: 'few', trails: 'all', built: 'out', width: 1600, summit: true },
  // The Trails tab, opened from a flag: this project's rows and history, the other project (the signpost is built)
  { name: 'trails-tab', scenario: 'few', trails: 'all', built: 'out', trailsTab: true, height: 1000 },
  // The world (campsite 3d-1), its clock pinned (local time): the day, dawn and night (the lights on) with no season
  { name: 'day', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T12:00', seasons: 'off' },
  { name: 'dawn', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T06:30', seasons: 'off' },
  { name: 'night', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T22:00', seasons: 'off' },
  // The seasons (northern) at dusk, and spring's flowers by day; summer's fireflies at night
  { name: 'winter', scenario: 'few', built: 'out', trails: 'all', width: 1600, at: '2027-01-15T18:00' },
  { name: 'autumn', scenario: 'few', built: 'out', width: 1600, at: '2026-10-15T18:00' },
  { name: 'spring', scenario: 'few', built: 'out', width: 1600, at: '2026-04-15T12:00' },
  { name: 'summer-night', scenario: 'few', built: 'out', width: 1600, at: '2026-07-15T22:00' },
  // The weather: failing checks (rain; the header's 🌧), a quiet project (fog), rain at night, and rain under reduced motion (still streaks)
  { name: 'rain', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T12:00', seasons: 'off', weather: 'rain' },
  { name: 'fog', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T18:00', seasons: 'off', weather: 'fog' },
  { name: 'night-rain', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T22:00', seasons: 'off', weather: 'rain' },
  { name: 'rain-reduced', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T12:00', seasons: 'off', weather: 'rain', reduced: true },
  // Wildlife (campsite 3d-2): every species' two frames at the strip's scale (the harness's sheet: the whole page)
  { name: 'species-sheet', sheet: true, height: 640 },
  // The ranger tower at the left edge, outside the cabins: tier 1, tier 2 (a telescope and a flag), and a narrow window (the cabins go first)
  { name: 'tower', scenario: 'few', built: 'out', tower: 1, width: 1600 },
  { name: 'tower-2', scenario: 'few', built: 'out', tower: 2, width: 1600 },
  { name: 'tower-narrow', scenario: 'few', built: 'out', tower: 2, width: 700 },
  // Animals, caught partway (?age; ?r the crossing's die): a mule deer pausing on the treeline between the shed and the camp; a hawk by
  // day under the header, clear of every trail's flag; a mallard on the lake; a raccoon at night (a
  // shade darker); a fox standing still (reduced motion)
  { name: 'animal-walker', scenario: 'few', built: 'out', width: 1600, animal: 'deer', r: 0.02, age: 4500 },
  { name: 'animal-flier', scenario: 'few', built: 'out', trails: 'all', width: 1600, at: '2026-11-23T12:00', seasons: 'off', animal: 'hawk', r: 1, age: 7450 },
  { name: 'animal-swimmer', scenario: 'few', built: 'out', width: 1600, animal: 'duck', age: 5000 },
  { name: 'animal-night', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T22:00', seasons: 'off', animal: 'raccoon', dir: 'right', age: 4000 },
  { name: 'animal-reduced', scenario: 'few', built: 'out', width: 1600, animal: 'fox', reduced: true },
  // The field guide, opened from the deer's button (its card focused): five seen, three new, no tower (the rares need it)
  { name: 'guide-tab', scenario: 'few', built: 'out', width: 1600, guide: 'some', animal: 'deer', r: 0.02, age: 4500, guideFrom: 'animal', height: 1000 },
  // With ranger tower II, from the counts and the Guide tab: hints on the unseen (scrolled to the rares)
  { name: 'guide-tab-tower', scenario: 'few', built: 'out', guide: 'some', tower: 2, guideFrom: 'tab', height: 1000 },
  // The away card with sightings and new species
  { name: 'away-sightings', scenario: 'few', away: 'sightings' },
  // Real chores (campsite 4): every hiker pose and frame at the tab's, the terminal bar's and the strip's scales (the whole page)
  { name: 'hiker-sheet', sheet: 'hikers', width: 1440, height: 520 },
  // t1 (working, at the api camp) with its agent's latest tool call a second old: each kind's chore; thinking 20 s after it
  // (its tooltip must end in `words`)
  { name: 'tool-read', scenario: 'few', tool: 'read', words: 'Reading Campsite.tsx' },
  { name: 'tool-edit', scenario: 'few', tool: 'edit', words: 'Editing Campsite.tsx' },
  { name: 'tool-run', scenario: 'few', tool: 'run', words: 'Running npm test' },
  { name: 'tool-delegate', scenario: 'few', tool: 'delegate', words: 'Sending a scout: Explore the trails' },
  { name: 'tool-web', scenario: 'few', tool: 'web', words: 'Looking up github.com' },
  { name: 'tool-mcp', scenario: 'few', tool: 'mcp', words: 'On the radio: trek-dev list_worktrees' },
  { name: 'tool-think', scenario: 'few', tool: 'think', words: 'Thinking' },
  // Agents (campsite 5): the noticeboard just left of the fire's camp, with its red pin (two notes
  // unread), read (no pin), on an empty strip (clear of its line of text) and among every building and
  // trail; its button opens the Noticeboard (the Camp tab's top); the Trails tab with a trail's report
  // (one line and More) and an ended trail's. Each board shot fails unless the board's button says `board`
  { name: 'board', scenario: 'few', notes: 'some', board: 'Noticeboard, 2 new notes' },
  { name: 'board-read', scenario: 'few', notes: 'read', board: 'Noticeboard' },
  { name: 'board-empty', scenario: 'empty', notes: 'some', board: 'Noticeboard, 2 new notes' },
  { name: 'board-built', scenario: 'few', notes: 'some', built: 'out', trails: 'all', width: 1600, board: 'Noticeboard, 2 new notes' },
  { name: 'noticeboard', scenario: 'few', notes: 'many', noticeboard: true, height: 720 },
  { name: 'trails-report', scenario: 'few', notes: 'some', trails: 'all', built: 'out', trailsTab: true, flag: 'feature/api — Ridge (PR open)', height: 1000 },
  { name: 'trails-report-history', scenario: 'few', notes: 'some', trails: 'all', built: 'out', trailsTab: true, flag: 'feature/api — Ridge (PR open)', history: true, height: 1000 }
]

/**
 * --freeze, run in the page before any of its scripts: Date.now, an argument-less `new Date()` (and
 * `Date()`) stand at the page's ?at= (a local time), else 2026-11-23 12:00 UTC, and performance.now
 * at 1 ms. A Date with arguments, and Date's other statics, are the real ones. Math.random is a
 * seeded PRNG (mulberry32), so the particles land in the same places on every run
 */
function FREEZE() {
  const q = new URLSearchParams(location.search)
  const pinned = q.has('at') ? new Date(q.get('at') ?? '').getTime() : NaN
  const at = Number.isFinite(pinned) ? pinned : Date.UTC(2026, 10, 23, 12)
  const RealDate = Date
  function FrozenDate(...a) {
    if (!new.target) return new RealDate(at).toString()
    return a.length === 0 ? new RealDate(at) : new RealDate(...a)
  }
  Object.setPrototypeOf(FrozenDate, RealDate)
  FrozenDate.prototype = RealDate.prototype
  FrozenDate.now = () => at
  globalThis.Date = FrozenDate
  performance.now = () => 1
  let seed = 0x2d1
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

mkdirSync(out, { recursive: true })
const server = await createServer({
  root: join(root, 'plugins/campsite/dev'),
  configFile: false,
  logLevel: 'warn',
  // JSX by esbuild, not @vitejs/plugin-react: its React refresh preamble is an inline script, which
  // the page's CSP blocks. No HMR either: nothing to reload, and no websocket.
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root] } }
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? CHROME[process.platform], args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const problems = []
/** Frozen shots finish CSS animations and transitions first (a normal render shoots them as they are) */
const still = freeze ? { animations: 'disabled' } : {}
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({
      viewport: { width: shot.width ?? 1200, height: shot.height ?? 200 },
      deviceScaleFactor: 2,
      reducedMotion: shot.reduced ? 'reduce' : 'no-preference',
      ...(shot.touch ? { hasTouch: true, userAgent: TABLET_UA } : {})
    })
    if (freeze) await page.addInitScript(FREEZE)
    page.on('pageerror', (e) => problems.push(`${shot.name}: ${e.message}`))
    page.on('console', (m) => {
      // [campsite]: the strip's own warnings (Pixi didn't start); CSP: a blocked script or style
      if (m.text().includes('[campsite]') || m.text().includes('Content Security Policy')) problems.push(`${shot.name}: ${m.text()}`)
    })
    if (shot.sheet) {
      await page.goto(`${url}?sheet=${shot.sheet === true ? 1 : shot.sheet}`)
      await page.waitForTimeout(300)
      const path = join(out, `${shot.name}.png`)
      await page.screenshot({ path, fullPage: true, ...still })
      console.log(`wrote ${path}`)
      await page.close()
      continue
    }
    await page.goto(`${url}?scenario=${shot.scenario}${shot.dog === false ? '&dog=0' : ''}${shot.built ? `&built=${shot.built}` : ''}${shot.away ? `&away=${shot.away === true ? 1 : shot.away}` : ''}${shot.crew ? `&crew=${shot.crew}` : ''}${shot.trails ? `&trails=${shot.trails}` : ''}${shot.at ? `&at=${shot.at}` : ''}${shot.seasons ? `&seasons=${shot.seasons}` : ''}${shot.weather ? `&weather=${shot.weather}` : ''}${shot.tower ? `&tower=${shot.tower}` : ''}${shot.guide ? `&guide=${shot.guide}` : ''}${shot.tool ? `&tool=${shot.tool}` : ''}${shot.notes ? `&notes=${shot.notes}` : ''}${shot.animal ? `&animal=${shot.animal}&age=${shot.age ?? 0}${shot.dir ? `&dir=${shot.dir}` : ''}${shot.r === undefined ? '' : `&r=${shot.r}`}` : ''}${freeze ? '&freeze=1' : ''}`)
    await page.waitForSelector('.cs-canvas canvas', { timeout: 15000 })
    // The stage's first layout appears in place; give the dog a moment and Pixi a few frames
    await page.waitForTimeout(1200)
    // The harness sends the sighting once the stage is up and then moves its clock on (__animalAged): its button appears, and a few frames draw it
    if (shot.animal) {
      await page.waitForSelector('.cs-animal', { state: 'attached', timeout: 5000 })
      await page.waitForFunction(() => window.__animalAged === true, null, { timeout: 5000 })
      await page.waitForTimeout(300)
    }
    // A tool call's words: the working hiker's tooltip names it
    if (shot.words) {
      const title = await page.getAttribute('.cs-camp-hiker[aria-label="Agent 1, working"]', 'title')
      if (!title?.endsWith(` · ${shot.words}`)) problems.push(`${shot.name}: the hiker's title is ${JSON.stringify(title)}, not ending in ${JSON.stringify(shot.words)}`)
    }
    // The noticeboard's button names it (and how many notes are new)
    if (shot.board) {
      const label = await page.getAttribute('.campsite .cs-board', 'aria-label', { timeout: 5000 }).catch(() => null)
      if (label !== shot.board) problems.push(`${shot.name}: the noticeboard's button says ${JSON.stringify(label)}, not ${JSON.stringify(shot.board)}`)
    }
    // The stage skips Pixi's browser extras: no accessibility hook button (nor its global listeners)
    if (await page.evaluate(() => document.querySelector('button[title*="accessibility"]') !== null)) {
      problems.push(`${shot.name}: Pixi's accessibility button is on the page`)
    }
    // The trails' buttons (flags, a ledge's "+n", the cairn) overlap neither each other nor a hiker's;
    // the header's controls stay out of the peak's keep-out band (peakClear: between the start
    // group's room and the end group's) and off the trails' buttons; an animal's button (3d-2) meets
    // no trail's, hiker's or building's button nor a header control (the shots catch it in the clear)
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.cs-flag, .cs-flag-more, .cs-cairn, .cs-camp-hiker, .cs-building, .cs-animal, .cs-board')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((b) => getComputedStyle(b.el).visibility !== 'hidden')
      const name = (el) => el.getAttribute('aria-label') ?? el.className
      const found = []
      const is = (el, c) => el.classList.contains(c)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]
          const b = boxes[j]
          if (is(a.el, 'cs-camp-hiker') && is(b.el, 'cs-camp-hiker')) continue
          // The buildings are checked against the animal only; a swimmer lies on the lake (over its button)
          if ((is(a.el, 'cs-building') || is(b.el, 'cs-building')) && !is(a.el, 'cs-animal') && !is(b.el, 'cs-animal')) continue
          const lake = (x, y) => is(x.el, 'swimmer') && y.el.getAttribute('data-building') === 'lake'
          if (lake(a, b) || lake(b, a)) continue
          if (a.r.left < b.r.right && b.r.left < a.r.right && a.r.top < b.r.bottom && b.r.top < a.r.bottom) found.push(`${name(a.el)} / ${name(b.el)}`)
        }
      }
      // The noticeboard (campsite 5) also meets no building, tent sign, camp badge, "+n waiting" or the empty camp's line
      const board = document.querySelector('.cs-board')
      if (board) {
        const r = board.getBoundingClientRect()
        for (const el of document.querySelectorAll('.cs-building, .cs-tent-sign, .cs-camp-badge, .cs-more, .cs-empty')) {
          const o = el.getBoundingClientRect()
          if (o.width > 0 && o.height > 0 && r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom) found.push(`${name(board)} / ${name(el)}`)
        }
      }
      // The animal's button takes a click at its middle (nothing over it there)
      for (const b of boxes) {
        if (!is(b.el, 'cs-animal')) continue
        const hit = document.elementFromPoint((b.r.left + b.r.right) / 2, (b.r.top + b.r.bottom) / 2)
        if (!hit || !b.el.contains(hit)) found.push(`${name(b.el)} is under ${hit ? name(hit) : 'nothing'} at its middle`)
      }
      const header = document.querySelector('.cs-header')
      const start = document.querySelector('.cs-header-start')
      const end = document.querySelector('.cs-header-end')
      if (header && start?.style.maxWidth && end?.style.maxWidth) {
        const h = header.getBoundingClientRect()
        const band = { left: h.left + parseFloat(start.style.maxWidth) + 6, right: h.right - parseFloat(end.style.maxWidth) }
        const controls = [...header.querySelectorAll('button, .cs-weather, .cs-away, .cs-summit-line')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((c) => c.r.width > 1 && c.r.height > 1)
        const EPS = 0.01
        for (const c of controls) {
          if (c.r.right > band.left + EPS && c.r.left < band.right - EPS) found.push(`header ${name(c.el)} / the peak's band (${Math.round(band.left)}–${Math.round(band.right)})`)
          for (const b of boxes) {
            if (b.el.classList.contains('cs-camp-hiker') || b.el.classList.contains('cs-building')) continue
            if (c.r.left < b.r.right && b.r.left < c.r.right && c.r.top < b.r.bottom && b.r.top < c.r.bottom) found.push(`header ${name(c.el)} / ${name(b.el)}`)
          }
        }
      }
      return found
    })
    for (const o of overlaps) problems.push(`${shot.name}: buttons overlap: ${o}`)
    const path = join(out, `${shot.name}.png`)
    if (shot.summit) {
      await page.evaluate(() => window.__summit('ship', 'feature/ship'))
      await page.waitForTimeout(700)
      await page.locator('.campsite').screenshot({ path, ...still })
    } else if (shot.trailsTab) {
      // The first flag (the trailhead's oldest), or the one named, opens the Trails tab at its row; its history is read (and, with `history`, scrolled to)
      await (shot.flag ? page.locator(`.cs-flag[aria-label="${shot.flag}"]`) : page.locator('.cs-flag').first()).click()
      await page.waitForSelector('.cs-camp-popover .cs-trail-log', { timeout: 5000 })
      if (shot.history) {
        await page.locator('.cs-camp-popover .cs-trail-log').scrollIntoViewIfNeeded()
        await page.waitForTimeout(200)
      }
      await page.screenshot({ path, ...still })
    } else if (shot.guideFrom) {
      // From the animal's button (it moves: a dispatched click), or the counts and the Guide tab
      if (shot.guideFrom === 'animal') await page.locator('.cs-animal').dispatchEvent('click')
      else {
        await page.locator('.cs-camp-button').click()
        await page.locator('.cs-camp-popover [role="tab"]', { hasText: 'Guide' }).click()
      }
      await page.waitForSelector('.cs-camp-popover .cs-guide-card', { timeout: 5000 })
      if (shot.guideFrom === 'tab') await page.locator('.cs-camp-popover .cs-guide-card[data-species="moose"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await page.screenshot({ path, ...still })
    } else if (shot.noticeboard) {
      // The noticeboard's button opens the Camp tab at the Noticeboard, focused, its notes read
      await page.locator('.campsite .cs-board').click()
      await page.waitForSelector('.cs-camp-popover .cs-notes-list', { timeout: 5000 })
      await page.waitForTimeout(200)
      if (!(await page.evaluate(() => document.activeElement?.hasAttribute('data-noticeboard') ?? false))) problems.push(`${shot.name}: the Noticeboard did not take the focus`)
      await page.screenshot({ path, ...still })
      // The newest three of five, then "Show all (5)" (aria-expanded false) shows them all and becomes "Show fewer"
      const board = async () =>
        page.evaluate(() => {
          const b = document.querySelector('.cs-camp-popover .cs-notes-toggle')
          return { notes: document.querySelectorAll('.cs-camp-popover .cs-notes-list li').length, toggle: b?.textContent ?? null, expanded: b?.getAttribute('aria-expanded') ?? null }
        })
      const before = await board()
      if (JSON.stringify(before) !== JSON.stringify({ notes: 3, toggle: 'Show all (5)', expanded: 'false' })) problems.push(`${shot.name}: the Noticeboard shows ${JSON.stringify(before)}, not the newest three and Show all (5)`)
      await page.locator('.cs-camp-popover .cs-notes-toggle').click()
      const after = await board()
      if (JSON.stringify(after) !== JSON.stringify({ notes: 5, toggle: 'Show fewer', expanded: 'true' })) problems.push(`${shot.name}: after Show all the Noticeboard shows ${JSON.stringify(after)}`)
    } else if (shot.camper) {
      const hiker = page.locator(`.cs-camp-hiker[data-terminal="${shot.camper}"]`)
      if (shot.hover) {
        // Its label, at once
        await hiker.hover()
        await page.locator('.campsite').screenshot({ path, ...still })
      } else {
        // Its card, Go to terminal focused
        await hiker.click()
        await page.waitForSelector('.cs-camper-card', { timeout: 5000 })
        if (!(await page.evaluate(() => document.activeElement?.textContent === 'Go to terminal'))) problems.push(`${shot.name}: Go to terminal did not take the focus`)
        await page.screenshot({ path, ...still })
      }
    } else if (shot.member) {
      // The counts button, the Crew tab, the second member (mixed tiers: Buy and a gate), its journal read
      await page.locator('.cs-camp-button').click()
      await page.locator('.cs-camp-popover [role="tab"]', { hasText: 'Crew' }).click()
      await page.locator('.cs-crew-member').nth(1).click()
      await page.waitForSelector('.cs-member .cs-journal', { timeout: 5000 })
      await page.screenshot({ path, ...still })
    } else await page.locator('.campsite').screenshot({ path, ...still })
    console.log(`wrote ${path}`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
