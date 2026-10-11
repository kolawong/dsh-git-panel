/**
 * Regenerate the screenshots the READMEs embed.
 *
 *   node scripts/readme-shots.mjs
 *
 * Drives a real Chromium against a running harness (default
 * http://127.0.0.1:3080), logs in with the profile's credentials, and writes
 * JPEGs into `docs/` — small enough for a README, and taken from the same
 * surfaces the docs describe. Read-only: it never clicks a write button.
 *
 * Playwright and its chromium live in the harness checkout; when either is
 * missing the run prints SKIP and exits 0, like the other browser suites.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const OUT = join(here, '..', 'docs')
const ORIGIN = process.env.DSH_GIT_PANEL_ORIGIN ?? 'http://127.0.0.1:3080'
/** JPEG keeps a README image a few hundred KB instead of a megabyte of PNG. */
const SHOT = { type: 'jpeg', quality: 84 }

/** Find playwright and its browser; null when either is unavailable. */
function loadPlaywright() {
  for (const candidate of [
    '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.js',
    '/root/deepseek-harness/node_modules/playwright/index.js',
    'playwright',
  ]) {
    try {
      const module = require(candidate)
      if (typeof module.chromium?.launch === 'function') return module
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** The chromium build playwright can actually launch here. */
function browserPath() {
  return [
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',
    '/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
  ].find(path => existsSync(path)) ?? null
}

/** The harness login credentials, read at runtime and never printed. */
function credentials() {
  const text = readFileSync(process.env.DSH_PROFILE_PATCH ?? '/root/.dsh/profiles/web/cordis.patch.yml', 'utf8')
  const unquote = value => value.replace(/^['"]|['"]$/g, '')
  return {
    username: unquote(/^\s*username:\s*(.+?)\s*$/m.exec(text)[1]),
    password: unquote(/^\s*password:\s*(.+?)\s*$/m.exec(text)[1]),
  }
}

const playwright = loadPlaywright()
const executablePath = browserPath()
if (playwright === null || executablePath === null) {
  process.stdout.write('SKIP: playwright or its chromium build is unavailable in this environment\n')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
if (await page.locator('input').count() >= 2) {
  const { username, password } = credentials()
  await page.locator('input').nth(0).fill(username)
  await page.locator('input').nth(1).fill(password)
  await page.locator('button:has-text("登")').first().click()
}
await page.waitForSelector('svg', { timeout: 25_000 })
await page.waitForTimeout(2500)

// The overview: one card per workspace, each with its AI one-liner.
await page.locator('button', { hasText: /^Git$/ }).first().click()
await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/overview.jpg`, ...SHOT })

// A dirty repository, in the changes view with a file's diff open.
const card = page.locator('button').filter({ hasText: /变更/ }).first()
if (await card.count() > 0) {
  await card.click()
  await page.waitForTimeout(2500)
  const fileButton = page.locator('button').filter({ hasText: /\.(ts|tsx|js|json|md|mjs)/ }).first()
  if (await fileButton.count() > 0) {
    await fileButton.click()
    await page.waitForTimeout(2000)
  }
  await page.screenshot({ path: `${OUT}/changes.jpg`, ...SHOT })

  await page.locator('[data-tab-history]').first().click()
  await page.waitForTimeout(2200)
  const commit = page.locator('[data-commit-row]').first()
  if (await commit.count() > 0) {
    await commit.click()
    await page.waitForTimeout(1800)
  }
  await page.screenshot({ path: `${OUT}/history.jpg`, ...SHOT })

  await page.locator('[data-tab-branches]').first().click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/branches.jpg`, ...SHOT })
}

await browser.close()
process.stdout.write(`screenshots written: ${OUT}/overview.jpg changes.jpg history.jpg branches.jpg\n`)
