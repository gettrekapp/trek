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
  // Trails (campsite 3c): flags on every ledge ("+2" on the switchbacks), the planted summit, the cairn at 12 summits, the signpost
  { name: 'trails', scenario: 'few', trails: 'all', built: 'out', width: 1600 },
  // A middle narrower than the peak (440 px) scales it sideways (never dropped): only a window this
  // narrow has one, since the buildings give way before the camps and the middle never drops below ~500 px
  { name: 'trails-narrow', scenario: 'few', trails: 'all', width: 360 },
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
  { name: 'rain-reduced', scenario: 'few', built: 'out', width: 1600, at: '2026-11-23T12:00', seasons: 'off', weather: 'rain', reduced: true }
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
    await page.goto(`${url}?scenario=${shot.scenario}${shot.dog === false ? '&dog=0' : ''}${shot.built ? `&built=${shot.built}` : ''}${shot.away ? '&away=1' : ''}${shot.crew ? `&crew=${shot.crew}` : ''}${shot.trails ? `&trails=${shot.trails}` : ''}${shot.at ? `&at=${shot.at}` : ''}${shot.seasons ? `&seasons=${shot.seasons}` : ''}${shot.weather ? `&weather=${shot.weather}` : ''}${freeze ? '&freeze=1' : ''}`)
    await page.waitForSelector('.cs-canvas canvas', { timeout: 15000 })
    // The stage's first layout appears in place; give the dog a moment and Pixi a few frames
    await page.waitForTimeout(1200)
    // The stage skips Pixi's browser extras: no accessibility hook button (nor its global listeners)
    if (await page.evaluate(() => document.querySelector('button[title*="accessibility"]') !== null)) {
      problems.push(`${shot.name}: Pixi's accessibility button is on the page`)
    }
    // The trails' buttons (flags, a ledge's "+n", the cairn) overlap neither each other nor a hiker's
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.cs-flag, .cs-flag-more, .cs-cairn, .cs-camp-hiker')].map((el) => ({ el, r: el.getBoundingClientRect() }))
      const name = (el) => el.getAttribute('aria-label') ?? el.className
      const found = []
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]
          const b = boxes[j]
          if (a.el.classList.contains('cs-camp-hiker') && b.el.classList.contains('cs-camp-hiker')) continue
          if (a.r.left < b.r.right && b.r.left < a.r.right && a.r.top < b.r.bottom && b.r.top < a.r.bottom) found.push(`${name(a.el)} / ${name(b.el)}`)
        }
      }
      return found
    })
    for (const o of overlaps) problems.push(`${shot.name}: trail buttons overlap: ${o}`)
    const path = join(out, `${shot.name}.png`)
    if (shot.summit) {
      await page.evaluate(() => window.__summit('ship', 'feature/ship'))
      await page.waitForTimeout(700)
      await page.locator('.campsite').screenshot({ path, ...still })
    } else if (shot.trailsTab) {
      // The first flag (the trailhead's oldest) opens the Trails tab at its row; its history is read
      await page.locator('.cs-flag').first().click()
      await page.waitForSelector('.cs-camp-popover .cs-trail-log', { timeout: 5000 })
      await page.screenshot({ path, ...still })
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
