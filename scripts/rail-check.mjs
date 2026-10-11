/**
 * Left-rail check: is this plugin actually composed as a bundle?
 *
 * A package listed in the profile's `dsh.profile.bundles` contributes loader
 * rows **only** through its own `cordis.patch.yml` (`dsh.bundle.patch`). Without
 * that file the plugin can still appear through a runtime injection and look
 * perfectly healthy — right up to the next profile re-assembly or restart, when
 * the row disappears and the left rail silently loses its icon. That is a real
 * outage this environment has had, so it gets its own fast check:
 *
 *   node scripts/rail-check.mjs
 *
 * Drives a real headless Chromium: loads the harness, asserts the Git entry is
 * in the left rail, opens the panel, and asserts the entry survives a few
 * seconds of the page's own life. Playwright is skipped with a message when it
 * (or its browser) is missing, so this never breaks a plain test run.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ORIGIN = 'http://127.0.0.1:3080'

const failures = []
function check(name, condition, detail) {
  process.stdout.write(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!condition) failures.push(name)
}

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

function browserPath() {
  const candidates = [
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux/headless_shell/headless_shell',
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
  process.stdout.write('SKIP: playwright or its chromium build is unavailable in this environment\n')
  process.exit(0)
}

const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })
const page = await context.newPage()
/** Uncaught script failures: a broken client half reports here, not in the DOM. */
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 200)))

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  if (await page.locator('input').count() >= 2) {
    const { username, password } = credentials()
    await page.locator('input').nth(0).fill(username)
    await page.locator('input').nth(1).fill(password)
    await page.locator('button:has-text("登")').first().click()
  }
  await page.waitForSelector('svg', { timeout: 25_000 })
  await page.waitForTimeout(3000)

  const rail = page.locator('button', { hasText: /^Git$/ }).first()
  const texts = await page.evaluate(() => [...document.querySelectorAll('button')]
    .map(node => (node.innerText ?? '').trim())
    .filter(text => text !== '' && text.length <= 12))
  check('a fresh page load carries the Git entry in the left rail', await rail.count() > 0,
    JSON.stringify(texts.slice(0, 12)))

  if (await rail.count() > 0) {
    await rail.click()
    await page.waitForTimeout(2500)
    const opened = await page.evaluate(() => ({
      panel: document.querySelector('[data-git-panel]') !== null,
      cards: document.querySelectorAll('[data-repo-card], [data-git-panel] button').length,
    }))
    check('clicking the rail entry opens the Git panel', opened.panel === true, JSON.stringify(opened))
  }

  // A page that has been open for a while must not lose the entry either: the
  // client half is what registers it, and a failed re-registration shows up
  // here and nowhere else.
  await page.waitForTimeout(8000)
  check('the entry is still there after the page has been open a while',
    await page.locator('button', { hasText: /^Git$/ }).first().count() > 0)

  check('the page reported no uncaught script failure', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
} finally {
  await browser.close()
}

process.stdout.write(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
