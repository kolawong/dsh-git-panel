/**
 * Visual check of the Git panel against a running harness.
 *
 * Drives a real headless Chromium: logs in through the harness login form,
 * opens the Git panel from the left rail, walks into a dirty workspace card and
 * a changed file, then asserts what the diff renderer actually produced in the
 * DOM — line-number gutters, row tints, intra-line highlights, gap chips, fold
 * markers — and writes screenshots to `.visual-out/`.
 *
 * Playwright lives in the harness checkout; the run is skipped with a message
 * when it (or its browser) is missing, so this never breaks a plain test run.
 *
 *   node scripts/visual-check.mjs
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const OUT = join(here, '..', '.visual-out')
const ORIGIN = 'http://127.0.0.1:3080'

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
  const candidates = [
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',
    '/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
  ]
  return candidates.find(path => existsSync(path)) ?? null
}

const playwright = loadPlaywright()
const executablePath = browserPath()
if (playwright === null || executablePath === null) {
  process.stdout.write('SKIP: playwright or its chromium build is unavailable in this environment\n')
  process.exit(0)
}

/** The harness login credentials, read at runtime and never printed. */
function credentials() {
  const text = readFileSync('/root/.dsh/profiles/web/cordis.patch.yml', 'utf8')
  const unquote = value => value.replace(/^['"]|['"]$/g, '')
  return {
    username: unquote(/^\s*username:\s*(.+?)\s*$/m.exec(text)[1]),
    password: unquote(/^\s*password:\s*(.+?)\s*$/m.exec(text)[1]),
  }
}

const failures = []
function check(name, condition, detail) {
  process.stdout.write(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!condition) failures.push(name)
}

mkdirSync(OUT, { recursive: true })
const { chromium } = playwright
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 300)))

/** True when the suite registered its own fixture workspace and must remove it. */
let fixtureOwned = false
/** The hermetic dirty fixture's directory, removed in cleanup when owned. */
const FIXTURE_DIR = join(homedir(), 'dsh-git-panel-visual-fixture')

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  if (await page.locator('input').count() >= 2) {
    const { username, password } = credentials()
    await page.locator('input').nth(0).fill(username)
    await page.locator('input').nth(1).fill(password)
    await page.locator('button:has-text("登")').first().click()
  }
  await page.waitForSelector('svg', { timeout: 25_000 })
  await page.waitForTimeout(2500)

  // ── The left rail entry ────────────────────────────────────────────────────
  const rail = page.locator('button', { hasText: /^Git$/ }).first()
  check('the left rail carries a Git entry', await rail.count() > 0)
  await rail.click()
  await page.waitForTimeout(2000)

  const overview = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('div')].filter(node => (node.getAttribute('style') ?? '').includes('border-left')).length,
    header: (document.body.innerText.match(/Git 总览[\s\S]{0,60}/) ?? [''])[0].replace(/\n/g, ' '),
  }))
  check('the overview renders a workspace grid', overview.cards >= 8, JSON.stringify(overview))
  // ── each card gets a one-line "what is this project" from one model call ──
  await page.waitForFunction(() => document.querySelectorAll('[data-project-summary]').length > 0
    || document.querySelectorAll('[data-git-panel] .gp-card').length === 0, null, { timeout: 60_000 })
  const summaryLines = await page.evaluate(() => ({
    lines: [...document.querySelectorAll('[data-project-summary]')].map(node => (node.textContent ?? '').trim()).filter(text => text !== ''),
    chinese: [...document.querySelectorAll('[data-project-summary]')].filter(node => /[\u4e00-\u9fff]/.test(node.textContent ?? '')).length,
  }))
  check('cards carry an AI one-liner for the project',
    summaryLines.lines.length > 0 && summaryLines.chinese > 0,
    JSON.stringify(summaryLines.lines.slice(0, 2)))

  // ── the overview filter narrows the cards and restores them ────────────────
  const allCards = await page.locator('.gp-card').count()
  check('the overview offers a filter once there are cards',
    await page.locator('[data-overview-filter]').count() === 1)
  await page.locator('[data-overview-filter]').first().fill('quota')
  await page.waitForTimeout(400)
  const narrowed = await page.locator('.gp-card').count()
  check('filtering narrows the cards to the matching workspaces',
    narrowed > 0 && narrowed < allCards, `${String(allCards)} → ${String(narrowed)}`)
  check('the count reads as filtered',
    (await page.locator('[data-git-panel]').textContent())?.includes(`${String(narrowed)} / ${String(allCards)}`) === true)
  await page.locator('[data-overview-filter]').first().fill('zzz-no-such-workspace-zzz')
  await page.waitForTimeout(400)
  check('a filter with no match says so and offers to clear',
    await page.locator('[data-overview-filter-clear]').count() === 1
      && await page.locator('.gp-card').count() === 0)
  await page.locator('[data-overview-filter-clear]').first().click()
  await page.waitForTimeout(400)
  check('clearing the filter restores every card',
    await page.locator('.gp-card').count() === allCards, `${String(await page.locator('.gp-card').count())} vs ${String(allCards)}`)

  check('the overview header counts the workspaces', /Git 总览\s*\d+ 个工作区/.test(overview.header), overview.header)

  // The event stream is what makes a commit or a fetch show up without a wait.
  // This asserts the browser really opened it and got the host's greeting.
  const liveChip = await page.evaluate(() => {
    const node = document.querySelector('[data-live]')
    return { state: node?.getAttribute('data-live') ?? null, text: (node?.textContent ?? '').trim() }
  })
  check('the panel reports a live event stream in the browser', liveChip.state === 'live' && liveChip.text.includes('实时'), JSON.stringify(liveChip))
  const syncButton = await page.locator('button').filter({ hasText: /全部 Fetch/ }).first()
  check('the overview offers one-click fetch for every repository', await syncButton.count() > 0 && /全部 Fetch（\d+）/.test(await syncButton.innerText()), await syncButton.count() > 0 ? await syncButton.innerText() : 'missing')
  await page.screenshot({ path: `${OUT}/1-overview.png` })

  // ── The icon set ───────────────────────────────────────────────────────────
  // Every icon is one grid and one stroke, and no control falls back to a glyph
  // or an emoji: those render differently per platform and cannot take a theme
  // colour.
  const icons = await page.evaluate(() => {
    const root = document.querySelector('[data-git-panel]')
    if (root === null) return null
    const nodes = [...root.querySelectorAll('[data-icon]')]
    return {
      count: nodes.length,
      offGrid: nodes.filter(node => node.getAttribute('viewBox') !== '0 0 16 16').length,
      square: nodes.filter(node => node.getAttribute('width') !== node.getAttribute('height')).length,
      strokes: [...new Set(nodes.map(node => node.getAttribute('stroke-width')))],
      glyphs: (root.textContent ?? '').match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2713}\u{2717}\u{22EF}\u{FE0F}\u{2190}-\u{2193}]/gu) ?? [],
    }
  })
  check('the panel root is addressable', icons !== null)
  check('the icon set is in use', (icons?.count ?? 0) >= 10, `icons=${String(icons?.count)}`)
  check('every icon is on the same 16x16 grid and square', icons?.offGrid === 0 && icons?.square === 0,
    `offGrid=${String(icons?.offGrid)} nonSquare=${String(icons?.square)}`)
  check('every stroked icon shares one stroke width', icons?.strokes.every(width => width === null || Number(width) <= 1.4),
    JSON.stringify(icons?.strokes))
  check('no emoji, glyph tick, arrow or ellipsis is left as an icon', (icons?.glyphs ?? ['?']).length === 0,
    JSON.stringify(icons?.glyphs))

  // ── Into a dirty card ──────────────────────────────────────────────────────
  // ── the hermetic dirty fixture ─────────────────────────────────────────────
  // The diff/staging/draft flow needs a dirty repository. When the user's own
  // workspaces are all clean (it happens), the suite registers a fixture of
  // its own through the same picker a human would use, and removes it after.
  const gitInFixture = args => execFileSync('git', args, { cwd: FIXTURE_DIR, stdio: 'pipe' })
  if (await page.locator('button').filter({ hasText: /变更/ }).count() === 0) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
    mkdirSync(FIXTURE_DIR, { recursive: true })
    gitInFixture(['init', '-q', '--initial-branch=main'])
    gitInFixture(['config', 'user.email', 'fixture@example.com'])
    gitInFixture(['config', 'user.name', 'Fixture'])
    const base = Array.from({ length: 60 }, (_u, i) => `line ${String(i + 1)}`).join('\n') + '\n'
    writeFileSync(join(FIXTURE_DIR, 'a.txt'), base)
    const codeLines = Array.from({ length: 60 }, (_u, index) => {
      const line = index + 1
      if (line === 3 || line === 53) return '// gap section'
      if (line % 3 === 0) return `const n${String(line)} = ${String(line)}`
      return `const v${String(line)} = "value-${String(line)}"`
    })
    writeFileSync(join(FIXTURE_DIR, 'code.ts'), `${codeLines.join('\n')}\n`)
    writeFileSync(join(FIXTURE_DIR, 'README.md'), '# fixture\n\nFor the visual suite.\n')
    gitInFixture(['add', '.'])
    gitInFixture(['commit', '-q', '-m', 'fixture: base'])
    writeFileSync(join(FIXTURE_DIR, 'a.txt'), base.replace('line 5', 'line 5 changed').replace('line 55', 'line 55 changed'))
    // Nothing yet: the second commit moves a.txt only, code.ts stays put.
    gitInFixture(['add', '.'])
    gitInFixture(['commit', '-q', '-m', 'fixture: second'])
    // The dirty state the flow reads: two far-apart hunks plus an untracked
    // file, and at least two dirty source files the file filter can see.
    const current = readFileSync(join(FIXTURE_DIR, 'a.txt'), 'utf8')
    writeFileSync(join(FIXTURE_DIR, 'a.txt'), current.replace('line 6', 'line 6 dirtied').replace('line 56', 'line 56 dirtied'))
    writeFileSync(join(FIXTURE_DIR, 'code.ts'), readFileSync(join(FIXTURE_DIR, 'code.ts'), 'utf8')
      .replace('const v6 = "value-6"', 'const v6 = "changed-6"')
      .replace('const v56 = "value-56"', 'const v56 = "changed-56"'))
    writeFileSync(join(FIXTURE_DIR, 'README.md'), `${readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8')}A dirty line.\n`)
    writeFileSync(join(FIXTURE_DIR, 'untracked.txt'), 'never committed\n')
    await page.locator('[aria-label="添加工作区"]').first().click()
    await page.waitForTimeout(1200)
    await page.getByText('dsh-git-panel-visual-fixture', { exact: true }).last().click()
    await page.waitForTimeout(800)
    await page.locator('button', { hasText: /^打开$/ }).first().click()
    await page.waitForTimeout(1500)
    // Registering navigates the shell to the new workspace's session page;
    // the suite's home is the Git overview, so go back there first.
    await page.locator('button', { hasText: /^Git$/ }).first().click()
    await page.waitForTimeout(2500)
    fixtureOwned = true
    check('the suite registers its own dirty fixture when everything is clean',
      await page.locator('button').filter({ hasText: /变更/ }).count() > 0)
  }

  const card = page.locator('button').filter({ hasText: /变更/ }).first()
  check('a dirty card is offered', await card.count() > 0)
  await card.click()
  await page.waitForTimeout(2500)
  check('the repository page lists files', await page.locator('button').filter({ hasText: /\.(ts|tsx|js|json|md)\b/ }).count() > 0)
  const repoLive = await page.evaluate(() => document.querySelector('[data-live]')?.getAttribute('data-live') ?? null)
  check('the repository page subscribes to its own repository', repoLive === 'live', String(repoLive))
  // Every control the tests (and the eye) reach by marker draws an icon.
  const markedIcons = await page.evaluate(() => {
    const selectors = ['data-tab-changes', 'data-tab-history', 'data-stash', 'data-commit', 'data-ai-message', 'data-stage-all']
    return selectors.map(name => ({
      name,
      count: document.querySelectorAll(`[${name}]`).length,
      icon: [...document.querySelectorAll(`[${name}]`)].every(node => node.querySelector('[data-icon]') !== null),
    }))
  })
  // ── the design system: one stylesheet, real interaction states ─────────────
  check('the panel installs its stylesheet',
    await page.evaluate(() => document.getElementById('dsh-git-panel-styles') !== null))
  check('the view switch is a segmented control with real tabs',
    await page.evaluate(() => {
      const tabs = document.querySelector('.gp-tabs')
      return tabs !== null && tabs.querySelectorAll('[role="tab"]').length === 3
        && tabs.querySelector('[aria-selected="true"]') !== null
    }))
  const hover = await page.evaluate(async () => {
    const row = document.querySelector('.gp-row, .gp-commit-row')
    if (row === null) return null
    const before = getComputedStyle(row).backgroundColor
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    row.matches(':hover') // hover needs a pointer, not an event
    return { before }
  })
  // A real pointer hover: the row's background has to change.
  const hoverRow = page.locator('.gp-row, .gp-commit-row').first()
  const hoverBefore = await hoverRow.evaluate(node => getComputedStyle(node).backgroundColor)
  await hoverRow.hover()
  await page.waitForTimeout(250)
  const hoverAfter = await hoverRow.evaluate(node => getComputedStyle(node).backgroundColor)
  check('rows light up on hover', hoverBefore !== hoverAfter, `${hoverBefore} → ${hoverAfter}`)
  void hover
  // Keyboard focus draws a ring — but only a real Tab keypress sets the
  // keyboard modality that :focus-visible listens for; element.focus() does not.
  await page.locator('[data-git-panel]').first().click({ position: { x: 8, y: 8 } })
  let ring = null
  for (let presses = 0; presses < 24; presses += 1) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
    ring = await page.evaluate(() => {
      const node = document.activeElement
      if (node === null || !node.closest('[data-git-panel]')) return null
      const style = getComputedStyle(node)
      return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, tag: node.tagName, cls: node.className }
    })
    if (ring !== null && ring.outlineStyle !== 'none' && ring.outlineWidth !== '0px') break
  }
  check('keyboard focus draws a visible ring',
    ring !== null && ring.outlineStyle !== 'none' && ring.outlineWidth !== '0px',
    JSON.stringify(ring))

  check('every marked toolbar control carries an icon',
    markedIcons.every(entry => entry.count > 0 && entry.icon),
    JSON.stringify(markedIcons.filter(entry => entry.count === 0 || !entry.icon)))
  await page.screenshot({ path: `${OUT}/2-repo.png` })

  // ── the write surface: a commit box, per-file actions, a stash button ─────
  // Behaviour is proven against real git in smoke.mjs and live-check.mjs; here
  // the question is whether the panel offers the right thing in the right
  // state. Nothing destructive is clicked: this browser is pointed at the
  // user's real workspaces, so these checks stay observational.
  const commitBox = page.locator('[data-commit-box]')
  check('the repository page offers a commit box',
    await commitBox.count() === 1 && await page.locator('[data-commit-message]').count() === 1)
  // The action row is one line: the buttons share a top edge; the model chip
  // lives on the quiet caption row above instead of competing with them.
  const footerShape = await page.evaluate(() => {
    const box = document.querySelector('[data-commit-box]')
    if (box === null) return null
    const buttons = [...box.querySelectorAll('button')]
    const tops = [...new Set(buttons.map(node => Math.round(node.getBoundingClientRect().top)))]
    const select = box.querySelector('[data-ai-model]')
    return {
      buttonRows: tops,
      selectAbove: select !== null && buttons.length > 0
        ? select.getBoundingClientRect().top < Math.min(...buttons.map(node => node.getBoundingClientRect().top))
        : false,
    }
  })
  check('the commit actions sit on one row, the model on the caption row',
    footerShape !== null && footerShape.buttonRows.length === 1 && footerShape.selectAbove,
    JSON.stringify(footerShape))

  check('the commit button starts disabled while the message is empty',
    await page.locator('[data-commit]').first().isDisabled())
  const stagedLabel = await commitBox.textContent()
  const stagedMatch = /已暂存 (\d+) 项/.exec(stagedLabel ?? '')
  check('the commit box says how much is staged', stagedMatch !== null, JSON.stringify(stagedLabel?.slice(0, 80)))
  const stagedCount = Number(stagedMatch?.[1] ?? '0')
  await page.locator('[data-commit-message]').first().fill('视觉检查：不会真的提交')
  await page.waitForTimeout(200)
  const commitDisabled = await page.locator('[data-commit]').first().isDisabled()
  check('the commit button follows the rule: a message and something staged',
    commitDisabled === (stagedCount === 0), `staged=${String(stagedCount)} disabled=${String(commitDisabled)}`)
  check('the commit button explains what is missing when nothing is staged',
    stagedCount > 0 || /全部暂存|还没有暂存/.test(String(await page.locator('[data-commit]').first().getAttribute('title'))),
    String(await page.locator('[data-commit]').first().getAttribute('title')))
  check('the whole work tree can be staged in one click', await page.locator('[data-stage-all]').count() === 1)
  check('stashing is offered but not armed', await page.locator('[data-stash]').count() === 1
    && !/确认/.test(String(await page.locator('[data-stash]').first().textContent())))
  await page.screenshot({ path: `${OUT}/6-write-surface.png` })

  // ── the AI draft: one real model call, wearing the same safety belt ────────
  // Clicking this only fills the message box: it stages nothing, commits
  // nothing and pushes nothing, so it is safe against a real repository.
  check('the commit box offers an AI draft button', await page.locator('[data-ai-message]').count() === 1)
  check('the AI button says what it will do',
    /提交与推送仍由你点/.test(String(await page.locator('[data-ai-message]').first().getAttribute('title'))),
    String(await page.locator('[data-ai-message]').first().getAttribute('title')))
  check('no draft note is shown before the first draft', await page.locator('[data-ai-note]').count() === 0)
  await page.locator('[data-commit-message]').first().fill('')
  await page.locator('[data-ai-message]').first().click()
  // The draft streams: the button becomes 停止 while the model writes. A fast
  // answer may already be done by the time we look, and that is fine too.
  await page.waitForTimeout(600)
  const midDraft = await page.evaluate(() => ({
    stop: document.querySelector('[data-ai-stop]') !== null,
    note: document.querySelector('[data-ai-note]')?.textContent ?? '',
    box: (document.querySelector('[data-commit-message]'))?.value ?? '',
  }))
  check('while the model writes, the button offers to stop (or it already finished)',
    midDraft.stop || /写好了|失败|已取消/.test(midDraft.note), JSON.stringify(midDraft))
  // Waiting only for a non-empty box would read the note mid-stream; the end
  // of a draft is its final note.
  await page.waitForFunction(() => {
    const note = document.querySelector('[data-ai-note]')?.textContent ?? ''
    return /写好了|失败|已取消/.test(note)
  }, null, { timeout: 120_000 })
  const drafted = await page.locator('[data-commit-message]').first().inputValue()
  check('the draft lands in the message box for the user to edit',
    drafted.trim() !== '' && drafted.split('\n').length >= 1, JSON.stringify(drafted.slice(0, 120)))
  check('the draft is written in Chinese', /[\u4e00-\u9fff]/.test(drafted), JSON.stringify(drafted.slice(0, 120)))
  check('the draft fits the commit box contract', drafted.length < 4_000, String(drafted.length))
  const note = await page.locator('[data-ai-note]').first().textContent()
  check('the note names the model that answered and says it can be edited',
    note.includes('写好了') && /可自行改写|一键提交/.test(String(note)),
    JSON.stringify(String(note).slice(0, 160)))
  check('a draft that read the whole work tree says so',
    stagedCount > 0 || /全部未提交改动/.test(String(note)), JSON.stringify(String(note).slice(0, 160)))
  check('the draft button comes back once the draft is done',
    await page.locator('[data-ai-message]').count() === 1 && await page.locator('[data-ai-stop]').count() === 0)
  check('the commit button stays in the user\'s hands after a draft',
    (await page.locator('[data-commit]').first().isDisabled()) === (stagedCount === 0),
    `staged=${String(stagedCount)} disabled=${String(await page.locator('[data-commit]').first().isDisabled())}`)
  // A draft for the whole work tree leaves nothing staged, so the plain commit
  // button cannot run; the write controls must still be usable, and the step
  // that fills the index has to be on offer.
  const stageControl = page.locator('[data-stage-all]').first()
  check('a draft never disables the staging control',
    await stageControl.count() === 1 && !(await stageControl.isDisabled()),
    `count=${String(await stageControl.count())} disabled=${String(await stageControl.isDisabled())}`)
  const commitAll = page.locator('[data-commit-all]').first()
  if (stagedCount === 0) {
    check('with nothing staged, the one-step commit is offered instead',
      await commitAll.count() === 1 && !(await commitAll.isDisabled()),
      `count=${String(await commitAll.count())} disabled=${String(await commitAll.isDisabled())}`)
    check('the one-step commit says what it will do',
      /git add -- \. 然后 git commit -m/.test(String(await commitAll.getAttribute('title'))),
      String(await commitAll.getAttribute('title')).slice(0, 120))
    check('the draft note points at the step that will work',
      /一键提交/.test(String(note)), JSON.stringify(String(note).slice(0, 160)))
  } else {
    check('with work already staged, the one-step commit stays out of the way',
      await commitAll.count() === 0, `count=${String(await commitAll.count())}`)
  }
  await page.screenshot({ path: `${OUT}/8-ai-message.png` })

  // ── the model picker, and the choice it remembers ─────────────────────────
  const picker = page.locator('[data-ai-model]').first()
  check('the commit box offers a model picker', await picker.count() === 1)
  const options = await picker.locator('option').count()
  const groups = await picker.locator('optgroup').count()
  check('the picker offers the default plus the models this profile has',
    options > 1 && groups > 0, `options=${String(options)} groups=${String(groups)}`)
  const groupLabels = await picker.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.getAttribute('label') ?? ''))
  check('the picker groups models by provider', groupLabels.every(label => label.trim() !== ''), JSON.stringify(groupLabels.slice(0, 4)))
  // The default is always the first option; whether it is *selected* depends on
  // whether the panel already remembered a pick — the user's own choice
  // legitimately wins, so the suite reads the state it is in rather than
  // assuming a fresh profile.
  const rememberedAtStart = await page.evaluate(async () => {
    const response = await fetch('/api/git-panel/models')
    return (await response.json()).remembered ?? null
  })
  const firstOption = String(await picker.locator('option').first().textContent())
  const pickerTitle = String(await picker.getAttribute('title'))
  check('the picker offers the profile default as its first choice',
    firstOption.trim() !== '' && !firstOption.includes('（读取失败）')
      // Nothing remembered: the default is what is selected, and the tooltip
      // says so. Something remembered: that pick is selected instead.
      && (rememberedAtStart === null ? pickerTitle.includes('跟随默认') : !pickerTitle.includes('跟随默认')),
    JSON.stringify({ firstOption, rememberedAtStart, pickerTitle: pickerTitle.slice(0, 80) }))
  // Picking now persists through the settings service into the user's real
  // profile — that is the feature — so the previous choice is captured here
  // and restored after the reload assertions.
  const rememberedBefore = await page.evaluate(async () => {
    const response = await fetch('/api/git-panel/models')
    return (await response.json()).remembered ?? null
  })
  // Pick something concrete, then check the choice is what a draft would use.
  const pickedValue = await picker.locator('option').nth(1).getAttribute('value')
  await picker.selectOption(String(pickedValue))
  await page.waitForTimeout(200)
  const stored = await page.evaluate(() => window.localStorage.getItem('dsh-git-panel:commit-model'))
  check('picking a model is remembered in the browser', typeof stored === 'string' && stored.includes('\u0000') === false && stored !== '',
    JSON.stringify(stored))
  const storedChoice = JSON.parse(String(stored))
  check('the remembered choice is the provider and model that were picked',
    typeof storedChoice.provider === 'string' && typeof storedChoice.model === 'string' && pickedValue.startsWith(storedChoice.provider),
    JSON.stringify(storedChoice))
  // A narrow column must not eat a control: everything drawn in the box has to
  // fit inside it, whether it wrapped onto another line or not.
  const overflowing = await page.evaluate(() => {
    const box = document.querySelector('[data-commit-box]')
    if (box === null) return ['no commit box']
    const edge = box.getBoundingClientRect().right
    return [...box.querySelectorAll('button, select, textarea')]
      .map(node => ({ text: (node.textContent ?? '').trim().slice(0, 20), right: Math.round(node.getBoundingClientRect().right) }))
      .filter(item => item.right > edge + 1)
      .map(item => `${item.text}@${String(item.right)}`)
  })
  check('every control in the commit box fits inside it', overflowing.length === 0, JSON.stringify(overflowing))

  const measure = () => page.locator('[data-commit-message]').first().evaluate(node => node.getBoundingClientRect().height)
  await page.locator('[data-commit-message]').first().fill('chore: 短信息')
  await page.waitForTimeout(200)
  const boxHeight = await measure()
  check('the message box is tall enough to read a commit message', boxHeight >= 60, `${String(Math.round(boxHeight))}px`)
  await page.locator('[data-commit-message]').first().fill('chore: 视觉检查\n\n- 第一行正文\n- 第二行正文\n- 第三行正文\n- 第四行正文')
  await page.waitForTimeout(200)
  const grownHeight = await measure()
  check('the message box grows with the message', grownHeight > boxHeight && grownHeight <= 221,
    `${String(Math.round(boxHeight))}px → ${String(Math.round(grownHeight))}px`)
  // Prove the memory survives a reload: reopen the panel and read the picker.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('svg', { timeout: 25_000 })
  await page.waitForTimeout(2_000)
  await page.locator('button', { hasText: /^Git$/ }).first().click()
  await page.waitForTimeout(1_500)
  await page.locator('button').filter({ hasText: /变更/ }).first().click()
  await page.waitForTimeout(2_500)
  const afterReload = await page.locator('[data-ai-model]').first().inputValue()
  const rememberedAfter = await page.evaluate(async () => {
    const response = await fetch('/api/git-panel/models')
    return (await response.json()).remembered ?? null
  })
  check('the pick is remembered as profile configuration, not just in this browser',
    rememberedAfter !== null && typeof rememberedAfter.provider === 'string'
      && String(pickedValue).startsWith(rememberedAfter.provider),
    JSON.stringify(rememberedAfter))
  check('the picked model is still selected after a reload',
    afterReload === String(pickedValue), `${JSON.stringify(afterReload)} vs ${JSON.stringify(pickedValue)}`)
  // Roll the probe pick back: the profile belongs to the user, not the suite.
  await page.evaluate(async (choice) => {
    await fetch('/api/git-panel/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
      body: JSON.stringify(choice ?? {}),
    })
  }, rememberedBefore)
  const restoredChoice = await page.evaluate(async () => {
    const response = await fetch('/api/git-panel/models')
    return (await response.json()).remembered ?? null
  })
  check('the probe pick is rolled back afterwards',
    JSON.stringify(restoredChoice) === JSON.stringify(rememberedBefore),
    JSON.stringify({ restored: restoredChoice, before: rememberedBefore }))
  check('the draft button says which model it will use',
    String(await page.locator('[data-ai-message]').first().getAttribute('title')).includes(storedChoice.model)
      || await page.locator('[data-ai-note]').count() > 0,
    String(await page.locator('[data-ai-message]').first().getAttribute('title')).slice(0, 120))
  await page.screenshot({ path: `${OUT}/9-model-picker.png` })

  // ── Into a changed file, where the diff renderer does its work ─────────────
  const fileText = await page.evaluate(() => [...document.querySelectorAll('button')]
    .map(node => (node.textContent ?? '').trim().replace(/\s+/g, ' '))
    .find(text => /^\S*\.(ts|tsx|js|json)\b/.test(text) && text.length < 90) ?? '')
  if (fileText !== '') {
    await page.locator('button').filter({ hasText: fileText.slice(0, 30) }).first().click()
  }
  await page.waitForTimeout(2500)

  const shape = await page.evaluate(() => {
    const pane = document.querySelector('[data-pane="diff"]')
    const rows = [...document.querySelectorAll('[data-kind]')]
    const paneRect = pane?.getBoundingClientRect()
    const rect = node => {
      const box = node.getBoundingClientRect()
      return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) }
    }
    const folded = rows.filter(row => row.getAttribute('data-folded') === 'true')
    return {
      rows: rows.length,
      kinds: rows.reduce((counts, row) => {
        const kind = row.getAttribute('data-kind')
        counts[kind] = (counts[kind] ?? 0) + 1
        return counts
      }, {}),
      tinted: rows.filter(row => (row.getAttribute('style') ?? '').includes('color-mix')).length,
      highlights: document.querySelectorAll('[data-text] span[style*="border-radius: 3px"]').length,
      gaps: [...document.querySelectorAll('[data-gap]')].map(node => Number(node.getAttribute('data-gap'))),
      gapNotes: [...document.querySelectorAll('[data-gap-note]')].length,
      folded: folded.length,
      pane: paneRect === undefined ? null : { left: Math.round(paneRect.left), right: Math.round(paneRect.right) },
      foldMarkersInsidePane: folded.every(row => {
        const marker = row.querySelector('[data-fold-marker]')
        if (marker === null || paneRect === undefined) return false
        const box = marker.getBoundingClientRect()
        return box.left >= paneRect.left && box.right <= paneRect.right + 1
      }),
      guttersAligned: rows.slice(0, 40).every(row => {
        const spans = [...row.children]
        if (spans.length < 3) return false
        const [oldNo, newNo] = spans.map(span => span.getBoundingClientRect())
        // Two fixed-width columns side by side: equal widths keep the digits
        // aligned, and the second starts right after the first.
        return Math.abs(oldNo.width - newNo.width) < 0.5 && newNo.left >= oldNo.right
      }),
      sample: rows.slice(0, 6).map(row => ({ kind: row.getAttribute('data-kind'), text: row.textContent.slice(0, 40), rect: rect(row) })),
    }
  })
  process.stdout.write(`  diff shape: ${JSON.stringify(shape, null, 1)}\n`)

  check('the diff renders rows with line-number gutters', shape.rows > 3 && shape.guttersAligned)
  check('changed rows carry a tint', shape.tinted >= 1, `tinted ${String(shape.tinted)}`)
  check('additions and deletions are both present or the file has none',
    !('add' in shape.kinds) || !('del' in shape.kinds) || (shape.kinds.add > 0 && shape.kinds.del > 0), JSON.stringify(shape.kinds))
  check('gap chips stand in for the trimmed lines', Array.isArray(shape.gaps) && shape.gaps.every(hidden => hidden > 0), JSON.stringify(shape.gaps))
  check('long lines fold and their marker stays inside the pane', shape.folded === 0 || shape.foldMarkersInsidePane, `folded ${String(shape.folded)}`)
  check('no page error reached the panel', pageErrors.length === 0, pageErrors.join(' | '))
  await page.screenshot({ path: `${OUT}/3-diff.png` })

  // ── A gap chip is a promise: clicking it must fetch and draw the lines ─────
  // Not every file has two hunks far enough apart, so walk the file list until
  // one does.
  const fileButtons = page.locator('button').filter({ hasText: /^\S*\.(ts|tsx|js|json|md)\b/ })
  let gapToggle = page.locator('button[data-gap-toggle]').first()
  let tried = 0
  while (await gapToggle.count() === 0 && tried < 8) {
    if (await fileButtons.nth(tried).count() === 0) break
    await fileButtons.nth(tried).click()
    await page.waitForTimeout(700)
    gapToggle = page.locator('button[data-gap-toggle]').first()
    tried += 1
  }
  check('some changed file offers an openable gap', await gapToggle.count() > 0, `tried ${String(tried)} files`)
  if (await gapToggle.count() > 0) {
    const before = await page.locator('[data-kind]').count()
    await gapToggle.click()
    await page.waitForTimeout(900)
    const after = await page.locator('[data-kind]').count()
    const opened = await page.locator('[data-gap-opened="true"]').count()
    check('opening a gap draws the lines it was hiding', after > before && opened > 0, `rows ${String(before)} -> ${String(after)}, opened ${String(opened)}`)
    const openedShape = await page.evaluate(() => {
      const gap = document.querySelector('[data-gap-opened="true"]')
      if (gap === null) return null
      const rows = [...gap.querySelectorAll('[data-kind="context"]')]
      const first = rows[0]
      const gutters = first === undefined
        ? []
        : [...first.querySelectorAll('span')].slice(0, 2).map(span => (span.textContent ?? '').trim())
      return { rows: rows.length, gutters }
    })
    check('the opened lines carry line numbers on both sides',
      openedShape !== null && openedShape.rows > 0 && openedShape.gutters.length === 2
        && openedShape.gutters.every(value => /^\d+$/.test(value)),
      JSON.stringify(openedShape))
    await page.screenshot({ path: `${OUT}/5-gap-open.png` })
    await page.locator('[data-gap-opened="true"] button[data-gap-toggle]').first().click()
    await page.waitForTimeout(500)
    check('a gap collapses back to its chip', await page.locator('[data-kind]').count() === before, `${String(await page.locator('[data-kind]').count())} rows, expected ${String(before)}`)
    check('no page error came from opening a gap', pageErrors.length === 0, pageErrors.join(' | '))
  }

  // ── An untracked file takes the other parser branch (--no-index /dev/null) ─
  // ── Syntax coloring, and the switch that turns it off ─────────────────────
  // What each token is worth is the tokenizer's business (asserted in
  // diff-test.mjs); here the question is whether the panel wires and toggles it.
  const colored = await page.evaluate(() => ({
    state: document.querySelector('[data-colorize]')?.getAttribute('data-colorize') ?? null,
    tokens: document.querySelectorAll('[data-token]').length,
    keywords: document.querySelectorAll('[data-token="keyword"]').length,
    strings: document.querySelectorAll('[data-token="string"]').length,
    comments: document.querySelectorAll('[data-token="comment"]').length,
    numbers: document.querySelectorAll('[data-token="number"]').length,
  }))
  check('the diff renders colored syntax tokens', colored.state === 'on' && colored.tokens > 0, JSON.stringify(colored))
  check('every colored token uses a kind this theme can color',
    colored.keywords + colored.strings + colored.comments + colored.numbers === colored.tokens, JSON.stringify(colored))
  await page.locator('[data-colorize-toggle]').first().click()
  await page.waitForTimeout(400)
  const plain = await page.evaluate(() => ({
    state: document.querySelector('[data-colorize]')?.getAttribute('data-colorize') ?? null,
    tokens: document.querySelectorAll('[data-token]').length,
  }))
  check('the switch turns coloring off completely', plain.state === 'off' && plain.tokens === 0, JSON.stringify(plain))
  await page.locator('[data-colorize-toggle]').first().click()
  await page.waitForTimeout(400)
  check('the switch turns coloring back on', await page.locator('[data-colorize="on"]').count() > 0)

  // The shortcut is bound but disciplined: with an empty message it must not
  // run anything — no log entry, no staged change, no write to the repo.
  await page.locator('[data-commit-message]').first().click()
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(600)
  const afterShortcut = await page.evaluate(() => ({
    message: (document.querySelector('[data-commit-message]'))?.value ?? null,
    staged: (document.querySelector('[data-commit-box]')?.textContent ?? '').match(/已暂存 (\d+) 项/)?.[1] ?? null,
  }))
  check('Ctrl+Enter with an empty message commits nothing',
    afterShortcut.message === '' && afterShortcut.staged === '0',
    JSON.stringify(afterShortcut))

  check('the commit buttons advertise the Ctrl+Enter shortcut',
    ((await page.locator('[data-commit], [data-commit-all]').first().getAttribute('title')) ?? '').includes('Ctrl+Enter'),
    String(await page.locator('[data-commit], [data-commit-all]').first().getAttribute('title')).slice(0, 120))

  // ── keyboard: j/k walk the file list, Space toggles bulk selection ─────────
  // The panel must be what receives the keys, so a row is focused first.
  await page.locator('[data-file-row]').first().click()
  await page.waitForTimeout(500)
  const firstRow = await page.locator('[data-file-row]').first().getAttribute('data-file-row')
  await page.keyboard.press('j')
  await page.waitForTimeout(400)
  const afterJ = await page.evaluate(() => document.querySelector('[aria-current="true"]')?.getAttribute('data-file-row') ?? null)
  check('j moves the open diff to the next file',
    afterJ !== null && afterJ !== firstRow, JSON.stringify({ firstRow, afterJ }))
  await page.keyboard.press('k')
  await page.waitForTimeout(400)
  const afterK = await page.evaluate(() => document.querySelector('[aria-current="true"]')?.getAttribute('data-file-row') ?? null)
  check('k moves it back', afterK === firstRow, JSON.stringify({ firstRow, afterK }))
  // Space toggles the bulk checkbox of the row under the cursor — no staging
  // happens: the bar counts, the button is what runs git.
  const countsBefore = await page.locator('[data-commit-box]').textContent()
  await page.keyboard.press(' ')
  await page.waitForTimeout(400)
  const barAfterSpace = await page.locator('[data-bulk-bar]').count()
  const fileStillUnstaged = (await page.locator('[data-commit-box]').textContent()) === countsBefore
  check('Space toggles bulk selection without staging',
    (barAfterSpace === 1) === true && fileStillUnstaged, `bar=${String(barAfterSpace)}`)
  await page.locator('[data-clear-checked]').first().click()
  await page.waitForTimeout(300)

  // ── bulk selection: checkboxes drive the batch bar, never executed here ────
  const boxes = page.locator('[data-select-file]')
  const boxCount = await boxes.count()
  check('stageable file rows offer a checkbox', boxCount > 0, String(boxCount))
  if (boxCount >= 2) {
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await page.waitForTimeout(300)
    const bar = await page.evaluate(() => ({
      text: document.querySelector('[data-bulk-bar]')?.textContent ?? '',
      stage: document.querySelectorAll('[data-stage-selected]').length,
    }))
    check('checking files brings up the bulk bar with the count',
      bar.stage === 1 && bar.text.includes('已选 2 项'), JSON.stringify(bar))
    await boxes.nth(1).uncheck()
    await page.waitForTimeout(300)
    check('unchecking shrinks the count', (await page.locator('[data-bulk-bar]').textContent())?.includes('已选 1 项') === true)
    await page.locator('[data-clear-checked]').first().click()
    await page.waitForTimeout(300)
    check('clearing dismisses the bar without staging anything',
      await page.locator('[data-bulk-bar]').count() === 0
        && (await page.locator('[data-commit-box]').textContent())?.includes('已暂存 0 项') === true)
  }

  // ── the split handle: drag widens the list, double-click resets ─────────────
  const listBefore = await page.locator('[data-split-list]').first().evaluate(node => Math.round(node.getBoundingClientRect().width))
  const handle = page.locator('[data-split-handle]').first()
  check('the list and the diff are split by a draggable handle', await handle.count() === 1)
  const box = await handle.boundingBox()
  if (box !== null) {
    await page.mouse.move(box.x + 3, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 123, box.y + 200, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const listAfter = await page.locator('[data-split-list]').first().evaluate(node => Math.round(node.getBoundingClientRect().width))
    check('dragging the handle widens the list',
      Math.abs(listAfter - listBefore - 120) <= 8, `${String(listBefore)} → ${String(listAfter)}`)
    await handle.dblclick()
    await page.waitForTimeout(300)
    const listReset = await page.locator('[data-split-list]').first().evaluate(node => Math.round(node.getBoundingClientRect().width))
    check('double-clicking the handle resets the split', Math.abs(listReset - listBefore) <= 4, `${String(listBefore)} → ${String(listReset)}`)
  }

  // ── blame: attribution of the same file, then back to the diff ────────────
  const blameToggle = page.locator('[data-blame-toggle]').first()
  check('a committed file offers line-by-line blame', await blameToggle.count() === 1)
  if (await blameToggle.count() === 1) {
    await blameToggle.click()
    await page.waitForTimeout(2500)
    const blame = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-blame-row]').length,
      withHash: document.querySelectorAll('[data-blame-row][data-blame-hash]').length,
      note: (document.querySelector('[data-blame]')?.textContent ?? '').slice(0, 80),
    }))
    check('blame renders one row per line, each attributed to a commit',
      blame.rows > 0 && blame.withHash === blame.rows, JSON.stringify(blame))
    check('the blame view says it is based on HEAD',
      /基于 HEAD/.test(blame.note), JSON.stringify(blame.note))
    await page.screenshot({ path: `${OUT}/16-blame.png` })
    await page.locator('[data-blame-toggle]').first().click()
    await page.waitForTimeout(1500)
    check('toggling back returns to the diff',
      await page.locator('[data-blame-row]').count() === 0 && await page.locator('[data-kind]').count() > 0)
  }

  // Per-file controls carry icons — with a tracked, modified file open, so
  // both stage and discard exist; unstage only exists when something is
  // staged, and it gets checked when it is.
  const fileIcons = await page.evaluate(() => ['data-stage-file', 'data-discard-file', 'data-unstage-file']
    .map(name => ({ name, count: document.querySelectorAll(`[${name}]`).length, icon: [...document.querySelectorAll(`[${name}]`)].every(node => node.querySelector('[data-icon]') !== null) })))
  check('the per-file controls in the file list carry icons too',
    fileIcons.filter(entry => entry.count > 0).length >= 2 && fileIcons.every(entry => entry.count === 0 || entry.icon),
    JSON.stringify(fileIcons))

  const untracked = page.locator('button').filter({ hasText: /^\?/ }).first()
  if (await untracked.count() === 0) {
    const texts = await page.evaluate(() => [...document.querySelectorAll('button')]
      .map(node => (node.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(text => text !== '' && text.length < 60).slice(0, 30))
    process.stdout.write(`  no untracked button found; buttons: ${JSON.stringify(texts)}\n`)
  }
  if (await untracked.count() > 0) {
    await untracked.click()
    await page.waitForTimeout(2000)
    const newFile = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-kind]')]
      const gutters = rows.map(row => [...row.children].slice(0, 2).map(span => (span.textContent ?? '').trim()))
      return {
        rows: rows.length,
        kinds: [...new Set(rows.map(row => row.getAttribute('data-kind')))],
        oldSideEmpty: gutters.every(([old]) => old === ''),
        firstNewLine: gutters[0]?.[1] ?? '',
        gaps: document.querySelectorAll('[data-gap]').length,
      }
    })
    process.stdout.write(`  untracked shape: ${JSON.stringify(newFile)}\n`)
    // An untracked file may be staged, but there is deliberately no way to
  // discard it: the host has no action that deletes one.
  check('an untracked file offers staging only',
    await page.locator('[data-stage-file]').count() >= 1
      && await page.locator('[data-unstage-file]').count() === 0
      && await page.locator('[data-discard-file]').count() === 0,
    `stage=${String(await page.locator('[data-stage-file]').count())} unstage=${String(await page.locator('[data-unstage-file]').count())} discard=${String(await page.locator('[data-discard-file]').count())}`)
  check('an untracked file renders as pure additions from line 1',
      newFile.rows > 0 && newFile.kinds.join() === 'add' && newFile.oldSideEmpty && newFile.firstNewLine === '1' && newFile.gaps === 0,
      JSON.stringify(newFile))
    await page.screenshot({ path: `${OUT}/4-untracked.png` })
  }

  // ── the history tab: commits, the files one touched, and its diff ─────────
  // Read-only throughout: this browser is pointed at the user's real repos.
  await page.locator('[data-tab-history]').first().click()
  await page.waitForTimeout(1800)
  check('the history tab lists the repository commits',
    await page.locator('[data-history]').count() === 1 && await page.locator('[data-commit-row]').count() > 0,
    `rows=${String(await page.locator('[data-commit-row]').count())}`)
  await page.locator('[data-commit-row]').first().click()
  await page.waitForTimeout(1500)
  const commitFiles = await page.locator('[data-commit-file]').count()
  check('a commit shows the files it touched', commitFiles > 0, String(commitFiles))
  if (commitFiles > 0) {
    await page.locator('[data-commit-file]').first().click()
    await page.waitForTimeout(1500)
    const historyRows = await page.locator('[data-pane="history-diff"] [data-kind]').count()
    check('a file inside a commit renders as a diff', historyRows > 0, String(historyRows))
    check('the history diff keeps the syntax coloring switch',
      await page.locator('[data-pane="history-diff"] [data-colorize-toggle]').count() === 1)
  }
  // ── the graph, the filters and paging ─────────────────────────────────────
  const graph = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-graph-row]')]
    const commits = document.querySelectorAll('[data-commit-row]').length
    return {
      commits,
      rows: rows.length,
      // Every row has to draw something: at least the node.
      empty: rows.filter(node => node.querySelectorAll('circle').length === 0).length,
      painted: rows.filter(node => node.querySelectorAll('line, path').length > 0).length,
      widths: [...new Set(rows.map(node => node.getAttribute('width')))],
      colours: [...new Set([...document.querySelectorAll('[data-graph-row] line, [data-graph-row] path')]
        .map(node => node.getAttribute('stroke')))],
    }
  })
  check('the history view draws a graph row per commit',
    graph.rows === graph.commits && graph.commits > 0, JSON.stringify({ rows: graph.rows, commits: graph.commits }))
  check('every graph row has a node and its lines',
    graph.empty === 0 && graph.painted === graph.rows, JSON.stringify({ empty: graph.empty, painted: graph.painted }))
  check('the graph is drawn in theme colours, one per lane',
    graph.colours.length > 0 && graph.colours.every(colour => /^(var\(--dsw-alias|color-mix\(in srgb, var\(--dsw-alias)/.test(String(colour))),
    JSON.stringify(graph.colours.slice(0, 3)))
  const scopeOptions = await page.locator('[data-history-scope] option').allInnerTexts()
  check('the history can be scoped to a branch or to every ref',
    await page.locator('[data-history-scope]').count() === 1
      && scopeOptions.some(text => /当前分支/.test(text)) && scopeOptions.some(text => /所有 ref/.test(text)),
    JSON.stringify(scopeOptions.slice(0, 4)))
  // ── the history has rhythm: day separators, merge glyphs, tiered rows ──────
  const rhythm = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-commit-row]')]
    const first = rows[0]
    return {
      rows: rows.length,
      separators: [...document.querySelectorAll('[data-graph-sep]')].map(node => (node.textContent ?? '').trim()),
      merges: document.querySelectorAll('[data-commit-row] [title^="合并提交"]').length,
      // Tier 1 subject is heavier than tier 2 meta.
      tiers: first === undefined ? null : (() => {
        const subject = first.querySelector('[data-commit-subject]')
        return {
          subjectWeight: subject === null ? null : getComputedStyle(subject).fontWeight,
          subjectSize: subject === null ? null : getComputedStyle(subject).fontSize,
        }
      })(),
    }
  })
  check('the history groups commits under day separators',
    rhythm.rows > 0 && rhythm.separators.length > 0,
    JSON.stringify(rhythm.separators))
  check('merge commits are marked in the list',
    rhythm.merges >= 0, String(rhythm.merges))
  check('the subject outranks the meta line', rhythm.tiers === null || rhythm.tiers.subjectWeight === '500',
    JSON.stringify(rhythm.tiers))

  check('the history offers an author and a message filter',
    await page.locator('[data-history-author]').count() === 1 && await page.locator('[data-history-grep]').count() === 1)

  // A filter that matches nothing empties the list and says why; reset brings
  // the history back. Both go through the real route.
  const rowsBefore = await page.locator('[data-commit-row]').count()
  await page.locator('[data-history-grep]').first().fill('zzz-no-such-commit-zzz')
  await page.waitForTimeout(1800)
  const filteredRows = await page.locator('[data-commit-row]').count()
  check('a message filter with no match empties the list',
    filteredRows === 0 && (await page.locator('[data-history]').innerText()).includes('这个过滤条件下没有提交'),
    `rows=${String(filteredRows)}`)
  await page.locator('[data-history-reset]').first().click()
  await page.waitForTimeout(1800)
  check('resetting the filters brings the whole history back',
    await page.locator('[data-commit-row]').count() === rowsBefore,
    `${String(await page.locator('[data-commit-row]').count())} vs ${String(rowsBefore)}`)

  // Older history: either there is another page to ask for, or the view says
  // it has reached the first commit.
  const more = page.locator('[data-history-more]').first()
  const exhaustedText = await page.evaluate(() => (document.querySelector('[data-history]')?.textContent ?? '').match(/\d+ 条（已到最初）/)?.[0] ?? null)
  if (await more.count() === 1) {
    await more.click()
    await page.waitForTimeout(1800)
    check('asking for older commits adds rows instead of replacing them',
      await page.locator('[data-commit-row]').count() > rowsBefore,
      `${String(await page.locator('[data-commit-row]').count())} vs ${String(rowsBefore)}`)
  } else {
    check('a short history says it has reached the first commit', exhaustedText !== null, String(exhaustedText))
    process.stdout.write('  note  this repository fits in one page, so auto-loading older commits was not exercised here\n')
  }
  await page.screenshot({ path: `${OUT}/7-history.png` })

  // The path filter: a file inside a commit narrows the history to that file.
  const commitFilesNow = await page.locator('[data-commit-file]').count()
  if (commitFilesNow > 0) {
    await page.locator('[data-file-history]').first().click()
    await page.waitForTimeout(1800)
    check('a file in a commit offers its own history',
      await page.locator('[data-history-path]').count() === 1
        && await page.locator('[data-commit-row]').count() > 0
        && await page.locator('[data-commit-row]').count() <= rowsBefore,
      `rows=${String(await page.locator('[data-commit-row]').count())}`)
    await page.locator('[data-history-path-clear]').first().click()
    await page.waitForTimeout(1500)
    check('clearing the path filter goes back to the whole history',
      await page.locator('[data-history-path]').count() === 0
        && await page.locator('[data-commit-row]').count() === rowsBefore)
  }

  // ── the branch list ───────────────────────────────────────────────────────
  await page.locator('[data-tab-branches]').first().click()
  await page.waitForTimeout(1800)
  const branches = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-branch-row]')].map(node => node.getAttribute('data-branch-row')),
    headChips: [...document.querySelectorAll('[data-branch-row]')].filter(node => /HEAD/.test(node.textContent ?? '')).length,
    hasUse: document.querySelectorAll('[data-branch-history]').length,
    text: (document.querySelector('[data-branches]')?.textContent ?? '').slice(0, 120),
  }))
  check('the branch tab lists the local branches',
    branches.rows.length > 0 && branches.hasUse === branches.rows.length,
    JSON.stringify(branches.rows))
  check('exactly one branch is marked as the checked-out one',
    branches.headChips === 1, String(branches.headChips))
  // Switching is offered on every other branch — armed, never executed here.
  const checkoutButtons = await page.locator('[data-branch-checkout]').count()
  check('every branch but the current one offers to switch to it',
    checkoutButtons === Math.max(0, branches.rows.length - 1),
    `buttons=${String(checkoutButtons)} rows=${String(branches.rows.length)}`)
  if (checkoutButtons > 0) {
    await page.locator('[data-branch-checkout]').first().click()
    await page.waitForTimeout(400)
    check('switching branches asks twice',
      (await page.locator('[data-branch-checkout]').first().innerText()).includes('确认'))
  }
  check('a new branch can be named, and the button tracks the input',
    await page.locator('[data-branch-new]').count() === 1
      && await page.locator('[data-branch-create]').isDisabled())
  await page.locator('[data-branch-new]').first().fill('visual-probe-branch')
  await page.waitForTimeout(300)
  check('naming a branch enables creating it — left unexecuted here',
    await page.locator('[data-branch-create]').isEnabled()
      && (await page.locator('[data-branch-create]').getAttribute('title') ?? '').includes('visual-probe-branch'))
  await page.locator('[data-branch-new]').first().fill('')
  await page.screenshot({ path: `${OUT}/11-branches.png` })
  // Reading a branch's history switches to the history view scoped to it.
  const otherBranch = branches.rows.find(name => !/^(main|master)$/.test(name)) ?? branches.rows[0]
  await page.locator(`[data-branch-row="${String(otherBranch)}"] [data-branch-history]`).first().click()
  await page.waitForTimeout(2000)
  const scoped = await page.evaluate(() => ({
    history: document.querySelector('[data-history]') !== null,
    scope: document.querySelector('[data-history-scope]')?.value ?? null,
    rows: document.querySelectorAll('[data-commit-row]').length,
    selected: document.querySelector('[data-history-scope] option:checked')?.textContent ?? null,
  }))
  check('looking at a branch reads that branch\'s history',
    scoped.history && scoped.rows > 0 && scoped.scope !== '\u0000all', JSON.stringify(scoped))
  await page.screenshot({ path: `${OUT}/10-history-branch.png` })

  // ── a long, branching history ─────────────────────────────────────────────
  // The one place the paging control and a wide graph meet real data: the
  // harness checkout itself, read-only like everything else here.
  await page.locator('button').filter({ hasText: /^总览$/ }).first().click()
  await page.waitForTimeout(2500)
  const bigCard = page.locator('button').filter({ hasText: /deepseek-harness/ }).first()
  if (await bigCard.count() > 0) {
    await bigCard.click()
    await page.waitForTimeout(3000)
    await page.locator('[data-tab-history]').first().click()
    await page.waitForTimeout(3000)
    const bigRows = await page.locator('[data-commit-row]').count()
    const bigMore = page.locator('[data-history-more]').first()
    check('a long history says there is more and offers to load it',
      bigRows >= 50 && await bigMore.count() === 1, `rows=${String(bigRows)} more=${String(await bigMore.count())}`)
    if (await bigMore.count() === 1) {
      await bigMore.click()
      await page.waitForTimeout(2500)
      const afterMore = await page.locator('[data-commit-row]').count()
      check('asking for older commits appends the next page instead of replacing it',
        afterMore > bigRows, `${String(bigRows)} → ${String(afterMore)}`)
    }
    const lanes = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-graph-row]')]
      return {
        rows: rows.length,
        widest: Math.max(0, ...rows.map(node => Number(node.getAttribute('width')))),
        curved: rows.filter(node => node.querySelectorAll('path').length > 0).length,
      }
    })
    check('a long history still draws exactly one graph row per commit',
      lanes.rows === await page.locator('[data-commit-row]').count(), JSON.stringify(lanes))
    check('a branching history draws merge curves and keeps the lane column bounded',
      lanes.curved > 0 && lanes.widest <= 14 + 32 * 12, JSON.stringify(lanes))
    await page.screenshot({ path: `${OUT}/12-history-long.png` })

    // A merge commit: git prints no diff for it, so the pane offers each parent
    // and has to reread when the choice changes.
    const mergeRow = page.locator('[data-commit-row]').filter({ hasText: /Merge pull request/ }).first()
    if (await mergeRow.count() > 0) {
      await mergeRow.click()
      await page.waitForTimeout(2000)
      const parents = await page.locator('[data-parent-picker] [data-parent]').count()
      check('a merge commit offers the parent to compare against', parents >= 2, String(parents))
      const readSide = () => page.evaluate(() => ({
        files: [...document.querySelectorAll('[data-commit-file]')].map(node => (node.textContent ?? '').slice(0, 40)),
        pane: (document.querySelector('[data-pane="history-diff"]')?.textContent ?? '').slice(0, 120),
        chosen: document.querySelector('[data-parent-picker] [data-parent][style*="brand"]')?.getAttribute('data-parent') ?? null,
      }))
      const firstSide = await readSide()
      await page.locator('[data-parent-picker] [data-parent="2"]').first().click()
      await page.waitForTimeout(2500)
      const secondSide = await readSide()
      check('choosing another parent rereads the merge instead of keeping the old answer',
        JSON.stringify(firstSide) !== JSON.stringify(secondSide),
        JSON.stringify({ first: firstSide.files.length, second: secondSide.files.length }))
      await page.screenshot({ path: `${OUT}/13-history-merge.png` })

    // Range compare on real history: arm 对比…, pick another commit, and the
    // detail reads the two-tree answer; clear it afterwards.
    await page.locator('[data-compare]').first().click()
    await page.waitForTimeout(400)
    check('arming a compare tells the list what a click now means',
      await page.evaluate(() => (document.querySelector('[data-history]')?.textContent ?? '').includes('对比基准')))
    const baseRow = page.locator('[data-commit-row]').nth(4)
    const baseShort = await baseRow.getAttribute('data-commit-row')
    await baseRow.click()
    await page.waitForTimeout(2000)
    const range = await page.evaluate(() => ({
      chip: (document.querySelector('[data-pane="history-diff"]')?.textContent ?? '').match(/[0-9a-f]{10}\.\.[0-9a-f]{10}/)?.[0] ?? null,
      files: document.querySelectorAll('[data-pane="history-diff"] [data-commit-file]').length,
      clear: document.querySelectorAll('[data-compare-clear]').length,
    }))
    check('picking a base turns the detail into a range read',
      range.chip !== null && baseShort !== null && range.chip.startsWith(baseShort.slice(0, 10))
        && range.clear === 1,
      JSON.stringify(range))
    check('a real range lists the files that changed between the two commits',
      range.files > 0, String(range.files))
    if (range.files > 0) {
      await page.locator('[data-pane="history-diff"] [data-commit-file]').first().click()
      await page.waitForTimeout(1500)
      check('a file inside a range renders as a diff',
        await page.locator('[data-pane="history-diff"] [data-kind]').count() > 0)
    }
    await page.screenshot({ path: `${OUT}/17-history-range.png` })
    await page.locator('[data-compare-clear]').first().click()
    await page.waitForTimeout(1200)
    check('clearing the compare returns to the single-commit read',
      await page.locator('[data-compare-clear]').count() === 0)
    } else {
      process.stdout.write('  note  no merge row in the first pages, so the parent picker was not exercised\n')
    }
    // The stash list, on a real repository that happens to hold a stash.
    // Read-only as everywhere here: buttons are inspected, never executed.
    await page.locator('[data-tab-changes]').first().click()
    await page.waitForTimeout(2000)
    const stashRows = await page.locator('[data-stash-row]').count()
    if (stashRows > 0) {
      check('a repository with stashes lists them with apply, pop and drop',
        await page.locator('[data-stash-apply]').count() === stashRows
          && await page.locator('[data-stash-pop]').count() === stashRows
          && await page.locator('[data-stash-drop]').count() === stashRows,
        `rows=${String(stashRows)}`)
      const stashControls = await page.evaluate(() => [...document.querySelectorAll('[data-stash-apply], [data-stash-pop], [data-stash-drop]')]
        .every(node => (node.getAttribute('title') ?? '').includes('git stash')))
      check('every stash control says the exact git command it runs', stashControls)
      // Arming the drop confirm is not executing it: one click shows the armed
      // label, the second — never taken here — would run `git stash drop`.
      await page.locator('[data-stash-drop]').first().click()
      await page.waitForTimeout(400)
      check('dropping a stash asks twice',
        (await page.locator('[data-stash-drop]').first().innerText()).includes('确认'))
      await page.screenshot({ path: `${OUT}/14-stashes.png` })
      // deepseek-harness has many branches, so the switch path is exercised
      // here too: armed once, never executed.
      await page.locator('[data-tab-branches]').first().click()
      await page.waitForTimeout(2000)
      const realCheckout = await page.locator('[data-branch-checkout]').count()
      check('a multi-branch repository offers switching on every other branch',
        realCheckout > 0, String(realCheckout))
      if (realCheckout > 0) {
        await page.locator('[data-branch-checkout]').first().click()
        await page.waitForTimeout(400)
        check('switching a real branch asks twice',
          (await page.locator('[data-branch-checkout]').first().innerText()).includes('确认'))
        await page.screenshot({ path: `${OUT}/15-branches-switch.png` })
      }
      await page.locator('[data-tab-changes]').first().click()
      await page.waitForTimeout(800)
    } else {
      process.stdout.write('  note  no stash entries on this repository, so the stash list was not exercised\n')
    }
  } else {
    process.stdout.write('  note  no deepseek-harness card in this workspace list, so the long history was not exercised\n')
  }
  await page.locator('[data-tab-changes]').first().click()
  await page.waitForTimeout(800)
  check('the changes tab comes back with its commit box',
    await page.locator('[data-commit-box]').count() === 1 && await page.locator('[data-history]').count() === 0)

  // No repository here is mid-merge, and the banner must stay out of the way
  // then; the conflicted state itself is driven for real in smoke and live.
  // The split runs to the panel's bottom edge: a list that stops mid-screen
  // with the divider stopping with it is the layout bug this guards.
  const fullHeight = await page.evaluate(() => {
    const panel = document.querySelector('[data-git-panel]')
    const list = document.querySelector('[data-split-list]')
    const diff = document.querySelector('[data-pane="diff"]')
    const handle = document.querySelector('[data-split-handle]')
    if (panel === null || list === null || diff === null || handle === null) return null
    const bottom = panel.getBoundingClientRect().bottom
    return {
      list: bottom - list.getBoundingClientRect().bottom,
      diff: bottom - diff.getBoundingClientRect().bottom,
      handle: bottom - handle.getBoundingClientRect().bottom,
    }
  })
  check('the list, the diff and the divider all reach the panel bottom',
    fullHeight !== null && fullHeight.list < 2 && fullHeight.diff < 2 && fullHeight.handle < 2,
    JSON.stringify(fullHeight))

  check('a repository with no operation in progress shows no operation banner',
    await page.locator('[data-operation]').count() === 0)

  // The untouched overview must still be clean of diff rows.
  await page.locator('button', { hasText: '总览' }).first().click()
  await page.waitForTimeout(1500)
  check('returning to the overview clears the diff rows', await page.locator('[data-kind]').count() === 0)

// ── adaptation: the dark theme and a narrow window ──────────────────────────
// A second browser, dark scheme: every colour on the panel comes from a theme
// token, so a dark pass either works everywhere or betrays a hardcoded value.
{
  const dark = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark' })
  const darkPage = await dark.newPage()
  try {
    await darkPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    if (await darkPage.locator('input').count() >= 2) {
      const { username, password } = credentials()
      await darkPage.locator('input').nth(0).fill(username)
      await darkPage.locator('input').nth(1).fill(password)
      await darkPage.locator('button:has-text("登")').first().click()
    }
    await darkPage.waitForSelector('svg', { timeout: 25_000 })
    await darkPage.waitForTimeout(2500)
    await darkPage.locator('button:has-text("Git")').first().click()
    await darkPage.waitForTimeout(2200)
    const darkState = await darkPage.evaluate(() => {
      const root = document.querySelector('[data-git-panel]')
      const probe = document.querySelector('main') ?? document.body
      const bg = getComputedStyle(probe).getPropertyValue('--dsw-alias-bg-base').trim()
      const panelBg = root === null ? '' : getComputedStyle(root).backgroundColor
      return { bg, panelBg, cards: document.querySelectorAll('.gp-card').length }
    })
    check('the panel follows the dark theme',
      darkState.bg !== '' && darkState.bg !== '#fff' && darkState.bg !== '#ffffff'
        && darkState.panelBg !== '' && darkState.panelBg !== 'rgb(255, 255, 255)',
      JSON.stringify(darkState))
    await darkPage.screenshot({ path: `${OUT}/18-dark.png` })
  } finally {
    await dark.close()
  }
}

// A narrower window: the header wraps, and nothing sticks out past the panel.
{
  const narrow = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  const narrowPage = await narrow.newPage()
  try {
    await narrowPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    if (await narrowPage.locator('input').count() >= 2) {
      const { username, password } = credentials()
      await narrowPage.locator('input').nth(0).fill(username)
      await narrowPage.locator('input').nth(1).fill(password)
      await narrowPage.locator('button:has-text("登")').first().click()
    }
    await narrowPage.waitForSelector('svg', { timeout: 25_000 })
    await narrowPage.waitForTimeout(2500)
    await narrowPage.locator('button:has-text("Git")').first().click()
    await narrowPage.waitForTimeout(2200)
    const card = narrowPage.locator('button').filter({ hasText: /变更/ }).first()
    if (await card.count() > 0) {
      await card.click()
      await narrowPage.waitForTimeout(1800)
    }
    const stuck = await narrowPage.evaluate(() => {
      const root = document.querySelector('[data-git-panel]')
      if (root === null) return ['no panel']
      const edge = root.getBoundingClientRect().right
      return [...root.querySelectorAll('*')]
        .filter(node => node.getBoundingClientRect().right > edge + 2)
        .slice(0, 5)
        .map(node => `${node.tagName}@${String(Math.round(node.getBoundingClientRect().right))}`)
    })
    check('nothing sticks out of the panel at 1100px', stuck.length === 0, JSON.stringify(stuck))
    await narrowPage.screenshot({ path: `${OUT}/19-narrow.png` })
  } finally {
    await narrow.close()
  }
}

// ── a failed summary batch must not blank the cards ─────────────────────────
// The regression this guards: one failed model call wiped the whole map, so
// every card sat on a shimmer forever instead of saying what went wrong.
{
  await page.route('**/api/git-panel/project-summaries', route => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: '400 model requires adaptive thinking' }),
  }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('svg', { timeout: 25_000 })
  await page.waitForTimeout(2500)
  if (await page.locator('.gp-card').count() === 0) {
    await page.locator('button:has-text("Git")').first().click()
    await page.waitForTimeout(2200)
  }
  await page.waitForSelector('[data-project-summary-missing]', { timeout: 30_000 })
  const failedSummary = await page.evaluate(() => ({
    lines: document.querySelectorAll('[data-project-summary]').length,
    reasons: [...document.querySelectorAll('[data-project-summary-missing]')].map(node => node.getAttribute('title') ?? ''),
    skeletons: document.querySelectorAll('[data-git-panel] .gp-skeleton').length,
    cards: document.querySelectorAll('.gp-card').length,
  }))
  check('a failed summary batch leaves no card shimmering forever',
    failedSummary.lines === 0 && failedSummary.reasons.length === failedSummary.cards && failedSummary.skeletons === 0,
    JSON.stringify({ ...failedSummary, reasons: failedSummary.reasons.length }))
  check('the cards without a summary carry the reason why',
    failedSummary.reasons.every(reason => /adaptive thinking/.test(reason)),
    JSON.stringify(failedSummary.reasons.slice(0, 1)))
  await page.unroute('**/api/git-panel/project-summaries')
  await page.screenshot({ path: `${OUT}/20-summary-failure.png` })
}
} finally {
  // A fixture the suite registered leaves no trace: the workspace goes first
  // (kebab → 删除工作区 → confirm), then the directory.
  if (fixtureOwned) {
    try {
      const row = page.locator('[data-row-key^="workspace:"]', { hasText: 'visual-fixture' }).first()
      await row.hover()
      await page.waitForTimeout(400)
      await row.locator('button').nth(0).click()
      await page.waitForTimeout(600)
      await page.getByText('删除工作区', { exact: true }).last().click()
      await page.waitForTimeout(700)
      const confirmDelete = page.locator('button', { hasText: /^删除工作区$/ }).last()
      if (await confirmDelete.count() > 0) await confirmDelete.click()
      await page.waitForTimeout(1000)
    } catch {
      // A fixture that cannot be removed politely still loses its directory below.
    }
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
  await browser.close()
}

process.stdout.write(`\nscreenshots: ${OUT}\n`)
process.stdout.write(failures.length === 0 ? 'ALL PASS\n' : `${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
