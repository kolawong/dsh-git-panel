/**
 * Before/after screenshots of every panel surface, for the UI rebuild.
 *
 *   node scripts/shots.mjs <tag>
 *
 * Writes `.visual-out/<tag>-overview.png` etc. Read-only: it never clicks a
 * write button.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const OUT = join(here, '..', '.visual-out')
const ORIGIN = 'http://127.0.0.1:3080'
const tag = process.argv[2] ?? 'shot'

function loadPlaywright() {
  for (const candidate of [
    '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.js',
    '/root/deepseek-harness/node_modules/playwright/index.js',
    'playwright',
  ]) {
    try {
      const module = require(candidate)
      if (typeof module.chromium?.launch === 'function') return module
    } catch { /* next */ }
  }
  return null
}

function browserPath() {
  const candidates = [
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',
    '/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
  ]
  return candidates.find(path => existsSync(path)) ?? null
}

function credentials() {
  const text = readFileSync('/root/.dsh/profiles/web/cordis.patch.yml', 'utf8')
  const unquote = value => value.replace(/^['"]|['"]$/g, '')
  return {
    username: unquote(/^\s*username:\s*(.+?)\s*$/m.exec(text)[1]),
    password: unquote(/^\s*password:\s*(.+?)\s*$/m.exec(text)[1]),
  }
}

const playwright = loadPlaywright()
const executablePath = browserPath()
if (playwright === null || executablePath === null) {
  process.stdout.write('SKIP: playwright unavailable\n')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
if (await page.locator('input').count() >= 2) {
  const { username, password } = credentials()
  await page.locator('input').nth(0).fill(username)
  await page.locator('input').nth(1).fill(password)
  await page.locator('button:has-text("登")').first().click()
}
await page.waitForSelector('svg', { timeout: 25_000 })
await page.waitForTimeout(2500)

await page.locator('button', { hasText: /^Git$/ }).first().click()
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/${tag}-overview.png` })

// A dirty repo: changes view.
const card = page.locator('button').filter({ hasText: /变更/ }).first()
await card.click()
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/${tag}-changes.png` })

// A file open, so the diff pane is showing.
const fileButton = page.locator('button').filter({ hasText: /\.(ts|tsx|js|json|md)/ }).first()
if (await fileButton.count() > 0) {
  await fileButton.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/${tag}-diff.png` })
}

await page.locator('[data-tab-history]').first().click()
await page.waitForTimeout(2000)
await page.locator('[data-commit-row]').first().click()
await page.waitForTimeout(1800)
await page.screenshot({ path: `${OUT}/${tag}-history.png` })

await page.locator('[data-tab-branches]').first().click()
await page.waitForTimeout(2000)
await page.screenshot({ path: `${OUT}/${tag}-branches.png` })

await browser.close()
process.stdout.write(`screenshots: ${OUT}/${tag}-*.png\n`)
