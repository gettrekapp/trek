// scripts/campsite-render.mjs — screenshots the campsite strip (the real component on a fake host,
// plugins/campsite/dev/) in headless Chrome, one PNG per scenario, to look at the Pixi scene
// without running the app. Not a test: it fails only if the page errors or Pixi can't start.
// The page carries the app's CSP (no 'unsafe-eval'), so a render also proves Pixi starts under it.
// Usage: node scripts/campsite-render.mjs [outDir]   (default .campsite-render, not out/: the app
// packages out/**; CHROME_PATH picks the browser)
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(root, '.campsite-render'))
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
  { name: 'away', scenario: 'few', away: true }
]

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
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({
      viewport: { width: shot.width ?? 1200, height: 200 },
      deviceScaleFactor: 2,
      reducedMotion: shot.reduced ? 'reduce' : 'no-preference',
      ...(shot.touch ? { hasTouch: true, userAgent: TABLET_UA } : {})
    })
    page.on('pageerror', (e) => problems.push(`${shot.name}: ${e.message}`))
    page.on('console', (m) => {
      // [campsite]: the strip's own warnings (Pixi didn't start); CSP: a blocked script or style
      if (m.text().includes('[campsite]') || m.text().includes('Content Security Policy')) problems.push(`${shot.name}: ${m.text()}`)
    })
    await page.goto(`${url}?scenario=${shot.scenario}${shot.dog === false ? '&dog=0' : ''}${shot.built ? `&built=${shot.built}` : ''}${shot.away ? '&away=1' : ''}`)
    await page.waitForSelector('.cs-canvas canvas', { timeout: 15000 })
    // The stage's first layout appears in place; give the dog a moment and Pixi a few frames
    await page.waitForTimeout(1200)
    // The stage skips Pixi's browser extras: no accessibility hook button (nor its global listeners)
    if (await page.evaluate(() => document.querySelector('button[title*="accessibility"]') !== null)) {
      problems.push(`${shot.name}: Pixi's accessibility button is on the page`)
    }
    const path = join(out, `${shot.name}.png`)
    await page.locator('.campsite').screenshot({ path })
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
