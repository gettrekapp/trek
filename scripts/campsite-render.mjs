// scripts/campsite-render.mjs — screenshots the campsite strip (the real component on a fake host,
// plugins/campsite/dev/) in headless Chrome, one PNG per scenario, to look at the Pixi scene
// without running the app. Not a test: it fails only if the page errors or Pixi can't start.
// Usage: node scripts/campsite-render.mjs [outDir]   (default out/campsite-render; CHROME_PATH picks the browser)
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(root, 'out/campsite-render'))
const CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}
const SHOTS = [
  { name: 'empty', scenario: 'empty' },
  { name: 'few', scenario: 'few' },
  { name: 'few-reduced', scenario: 'few', reduced: true },
  { name: 'few-narrow', scenario: 'few', width: 600 },
  { name: 'exited', scenario: 'exited' },
  { name: 'grouped', scenario: 'grouped' },
  { name: 'no-dog', scenario: 'few', dog: false }
]

mkdirSync(out, { recursive: true })
const server = await createServer({
  root: join(root, 'plugins/campsite/dev'),
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? CHROME[process.platform], args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const problems = []
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: shot.width ?? 1200, height: 200 }, deviceScaleFactor: 2, reducedMotion: shot.reduced ? 'reduce' : 'no-preference' })
    page.on('pageerror', (e) => problems.push(`${shot.name}: ${e.message}`))
    page.on('console', (m) => {
      if (m.text().includes('[campsite]')) problems.push(`${shot.name}: ${m.text()}`)
    })
    await page.goto(`${url}?scenario=${shot.scenario}${shot.dog === false ? '&dog=0' : ''}`)
    await page.waitForSelector('.cs-canvas canvas', { timeout: 15000 })
    // The stage's first layout appears in place; give the dog a moment and Pixi a few frames
    await page.waitForTimeout(1200)
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
