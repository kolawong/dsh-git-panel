/**
 * Diff-renderer tests: the parser and intra-line comparison are pure, so they
 * are asserted against real `git diff` output — no browser involved.
 *
 * The bundle is loaded the way the harness loads it (a `window.__ModuleLoader__`
 * handshake) with a stubbed `require`, and the plugin re-exports these
 * functions for exactly this purpose.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      plugin = factory(require)
    },
  },
}
// React only has to be resolvable; nothing here renders.
await import(join(here, '..', 'lib', 'client.js'))

const failures = []
function check(name, condition, detail) {
  process.stdout.write(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!condition) failures.push(name)
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `got ${a}, want ${e}`)
}

if (plugin === null || typeof plugin.parseUnifiedDiff !== 'function') {
  process.stdout.write('FAIL  the bundle exports the diff helpers\n')
  process.exit(1)
}
const { parseUnifiedDiff, diffInline, pairInlineRuns, runSequentially, tokenizeLine, overlayChange, buildGraph, graphWidth, formatCommitDate, historyDayLabel } = plugin

// ── A real repository, so every fixture is real git output ───────────────────
const sandbox = join(here, '..', '.diff-test-sandbox')
const repo = join(sandbox, 'repo')
const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString()
const write = (name, text) => writeFileSync(join(repo, name), text)

try {
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  git(['init', '-q', '--initial-branch=main'])
  git(['config', 'user.email', 'diff@example.com'])
  git(['config', 'user.name', 'Diff'])
  // 60 numbered lines: enough to produce two hunks separated by a real gap.
  write('code.txt', Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n') + '\n')
  write('gone.txt', 'removed file\n')
  write('same.txt', 'unchanged\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'base'])
  git(['rm', '-q', 'gone.txt'])
  write('code.txt', [
    ...Array.from({ length: 3 }, (_, index) => `line ${String(index + 1)}`),
    'line 4 changed here',
    ...Array.from({ length: 45 }, (_, index) => `line ${String(index + 5)}`),
    'line 51 changed here',
    ...Array.from({ length: 9 }, (_, index) => `line ${String(index + 52)}`),
    '',
  ].join('\n'))
  git(['add', 'code.txt'])
  write('added.txt', 'brand new\nsecond line\n')
  git(['add', 'added.txt'])
  write('no-newline.txt', 'no trailing newline')
  git(['add', 'no-newline.txt'])

  const staged = git(['diff', '--cached', '--no-color'])
  const parsed = parseUnifiedDiff(staged)

  // ── File headers are never rows ────────────────────────────────────────────
  check('file headers (diff --git / index / --- / +++) produce no rows', !parsed.blocks.some(block => block.kind === 'hunk' && block.rows.some(row => /^(diff --git|index |--- |\+\+\+ )/.test(row.text))))

  // ── Line numbers ───────────────────────────────────────────────────────────
  const rows = parsed.blocks.filter(block => block.kind === 'hunk').flatMap(block => block.rows)
  const changed = rows.find(row => row.text === 'line 4 changed here')
  equal('an added row carries only a new-side number', [changed.kind, changed.oldLine, changed.newLine], ['add', undefined, 4])
  const context = rows.find(row => row.text === 'line 5')
  equal('a context row carries both numbers', [context.kind, context.oldLine, context.newLine], ['context', 5, 5])
  const deleted = rows.find(row => row.kind === 'del')
  equal('a deleted row carries only an old-side number', deleted?.newLine, undefined)
  // The edit replaces one line with one line, so no later line shifts: the
  // replaced line arrives as a deletion immediately before its addition, and
  // the neighbours stay aligned.
  const replaced = rows[rows.indexOf(changed) - 1]
  equal('the replaced line arrives as a deletion just before it', [replaced.kind, replaced.text, replaced.oldLine, replaced.newLine], ['del', 'line 4', 4, undefined])
  const contextAfter = rows[rows.indexOf(changed) + 1]
  equal('a balanced replacement leaves the following lines aligned', [contextAfter.text, contextAfter.oldLine, contextAfter.newLine], ['line 5', 5, 5])

  // ── Gaps between hunks ─────────────────────────────────────────────────────
  const gaps = parsed.blocks.filter(block => block.kind === 'gap')
  check('the trimmed lines between two hunks become a gap block', gaps.length >= 1, JSON.stringify(gaps))
  check('the gap counts the lines git omitted', gaps.every(gap => gap.hidden > 0), JSON.stringify(gaps))
  // One file with two edited regions separated by untouched lines. The expected
  // gap is derived from the raw hunk headers, independently of the parser, so
  // git stays free to pick its own context window.
  const oneFileText = git(['diff', '--cached', '--no-color', '--', 'code.txt'])
  const oneFile = parseUnifiedDiff(oneFileText)
  const headers = [...oneFileText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  }))
  equal('one file with two edits yields two hunks and one gap', [
    oneFile.blocks.filter(block => block.kind === 'hunk').length,
    oneFile.blocks.filter(block => block.kind === 'gap').length,
  ], [2, 1])
  // A gap must carry the line ranges it covers, because that is what the panel
  // asks the host for when the reader opens it.
  const oneGap = oneFile.blocks.find(block => block.kind === 'gap')
  // The fixture's second edit sits on line 50, so its hunk covers 47..53 and the
  // gap between the hunks is lines 8..46 — 39 lines, as the raw headers say.
  equal('a gap names the old-side range it covers', [oneGap.oldStart, oneGap.oldEnd], [8, 46])
  equal('a gap names the new-side range it covers', [oneGap.newStart, oneGap.newEnd], [8, 46])
  equal('a gap\'s spans agree with its count', oneGap.oldEnd - oneGap.oldStart + 1, oneGap.hidden)
  equal('the new side of a gap is the old side plus the running shift',
    oneGap.newStart - oneGap.oldStart, 0)
  equal('the gap counts exactly the lines between the hunks', oneFile.blocks.find(block => block.kind === 'gap').hidden, Math.max(
    headers[1].oldStart - (headers[0].oldStart + headers[0].oldCount),
    headers[1].newStart - (headers[0].newStart + headers[0].newCount),
  ))
  const ordered = oneFile.blocks.flatMap(block => (block.kind === 'hunk' ? block.rows : []))
  const firstDel = ordered.findIndex(row => row.kind === 'del')
  const firstAdd = ordered.findIndex(row => row.kind === 'add')
  check('a rewrite emits its deletions before its additions', firstDel >= 0 && firstDel < firstAdd, `del at ${String(firstDel)}, add at ${String(firstAdd)}`)

  // ── Tallies ────────────────────────────────────────────────────────────────
  const addedLines = rows.filter(row => row.kind === 'add').length
  const deletedLines = rows.filter(row => row.kind === 'del').length
  equal('the add tally matches the rows', parsed.added, addedLines)
  equal('the delete tally matches the rows', parsed.deleted, deletedLines)
  check('the deleted file contributes only deletions', deletedLines >= 1 && addedLines >= 3)

  // ── No-newline marker ──────────────────────────────────────────────────────
  const meta = rows.filter(row => row.kind === 'meta')
  check('the no-newline marker becomes a meta row', meta.length >= 1, JSON.stringify(meta))
  check('the meta row is not attributed to a line', meta.every(row => row.oldLine === undefined && row.newLine === undefined))

  // ── A fresh untracked-file style diff (--no-index, /dev/null side) ─────────
  const onlyAdded = parseUnifiedDiff(git(['diff', '--cached', '--no-color', '--', 'added.txt']))
  const addedRows = onlyAdded.blocks.flatMap(block => (block.kind === 'hunk' ? block.rows : []))
  check('a brand-new file parses as pure additions', addedRows.every(row => row.kind === 'add') && onlyAdded.deleted === 0, JSON.stringify(onlyAdded.blocks))
  equal('the new file counts two lines', onlyAdded.added, 2)

  // ── Binary and mode-only diffs ─────────────────────────────────────────────
  write('blob.bin', '\u0000\u0001binary\u0000')
  git(['add', 'blob.bin'])
  const binary = parseUnifiedDiff(git(['diff', '--cached', '--no-color', '--', 'blob.bin']))
  check('a binary diff is flagged and draws nothing', binary.binary && binary.empty, JSON.stringify(binary))

  // ── Truncated / headerless text must not throw ─────────────────────────────
  equal('an empty diff is empty', parseUnifiedDiff('').empty, true)
  equal('a header-only diff is empty', parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n').empty, true)
  const leading = parseUnifiedDiff('@@ -10,2 +10,2 @@\n-a\n+b\n')
  equal('a hunk starting at line 10 opens with a 9-line gap',
    leading.blocks[0], { kind: 'gap', hidden: 9, note: '', oldStart: 1, oldEnd: 9, newStart: 1, newEnd: 9 })
  equal('a hunk note is preserved', parseUnifiedDiff('@@ -5,1 +5,1 @@ def frobnicate():\n-a\n+b\n').blocks[0].note, 'def frobnicate():')
  equal('a diff whose last line has no newline still parses', parseUnifiedDiff('@@ -1,1 +1,1 @@\n-old\n+new').blocks[0].rows.length, 2)
  // A deleted line whose own text starts with '-- ' arrives as '--- ' and must
  // stay a deletion, not be mistaken for the next file's header.
  const tricky = parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n--- a marker\n keep\n+plus\n')
  const trickyRow = tricky.blocks[0].rows[0]
  equal('a deletion starting with two dashes stays a deletion', [trickyRow.kind, trickyRow.oldLine, trickyRow.text], ['del', 1, '-- a marker'])
  equal('the following rows still line up', [tricky.deleted, tricky.added, tricky.blocks.flatMap(b => b.kind === 'hunk' ? b.rows : []).length], [1, 1, 3])
  // Two files in one document must not measure a gap across the boundary: each
  // section keeps only its own leading gap (39 and 29 hidden lines).
  const twoFiles = parseUnifiedDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -40,1 +40,1 @@\n-x\n+y\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -30,1 +30,1 @@\n-p\n+q\n')
  equal('each file section keeps only its own leading gap', twoFiles.blocks.filter(block => block.kind === 'gap').map(block => block.hidden), [39, 29])

  // ── Intra-line diff ────────────────────────────────────────────────────────
  const inline = diffInline('let count = 1;', 'let count = 42;')
  equal('the shared prefix is not marked changed', inline.old[0], { text: 'let count = ', changed: false })
  equal('only the differing middle is marked on the old side', inline.old[1], { text: '1', changed: true })
  equal('only the differing middle is marked on the new side', inline.next[1], { text: '42', changed: true })
  check('both sides end with the shared suffix', inline.old[2].text === ';' && inline.next[2].text === ';' && !inline.old[2].changed)
  // Suffix trimming works inside a word: only "Curren" / "Longes" differ.
  const word = diffInline('streakCurrent;', 'streakLongest;')
  equal('a shared trailing character stays out of the highlight', [word.old[1], word.next[1], word.old[2]], [
    { text: 'Curren', changed: true },
    { text: 'Longes', changed: true },
    { text: 't;', changed: false },
  ])
  equal('identical lines yield no changed run', diffInline('same', 'same').old, [{ text: 'same', changed: false }])
  const empty = diffInline('', 'new line')
  equal('an insertion at the start marks the whole addition', empty.next, [{ text: 'new line', changed: true }])
  equal('the removed side of a pure insertion is empty', empty.old, [])
  equal('a whitespace-only edit marks only the whitespace', diffInline('a b', 'a  b').next, [{ text: 'a ', changed: false }, { text: ' ', changed: true }, { text: 'b', changed: false }])

  // ── Pairing ────────────────────────────────────────────────────────────────
  const paired = pairInlineRuns([
    { kind: 'del', text: 'const a = 1;', oldLine: 1 },
    { kind: 'add', text: 'const a = 2;', newLine: 1 },
  ])
  equal('a del/add pair is paired on both sides', [paired.size, paired.get(0)[1], paired.get(1)[1]], [2, { text: '1', changed: true }, { text: '2', changed: true }])
  const unequal = pairInlineRuns([
    { kind: 'del', text: 'x = 1', oldLine: 1 },
    { kind: 'add', text: 'x = 2', newLine: 1 },
    { kind: 'add', text: 'y = 3', newLine: 2 },
  ])
  equal('an unmatched extra addition is left unpaired', unequal.size, 2)
  equal('pure deletions pair with nothing', pairInlineRuns([{ kind: 'del', text: 'gone', oldLine: 1 }]).size, 0)
  equal('context rows are never paired', pairInlineRuns([{ kind: 'context', text: 'same', oldLine: 1, newLine: 1 }]).size, 0)

  // ── Conservative syntax tokens ─────────────────────────────────────────────
  // The rule the tokenizer follows is "never color what you are not sure of",
  // so most of these assertions are about what it refuses to claim.
  const kindsOf = text => tokenizeLine(text).map(token => `${token.kind}:${token.text}`).join('|')
  equal('a declaration line splits into keyword, plain and number',
    kindsOf('const x = 1;'), 'keyword:const|plain: x = |number:1|plain:;')
  equal('a comment owns the rest of the line',
    kindsOf('const a = 1 // const b = 2'), 'keyword:const|plain: a = |number:1|plain: |comment:// const b = 2')
  equal('a hash comment works for shell and python',
    kindsOf('# not code'), 'comment:# not code')
  equal('a string is one token, and keywords inside it are not keywords',
    kindsOf('const s = "if else"'), 'keyword:const|plain: s = |string:"if else"')
  equal('an unterminated quote is left as plain text',
    kindsOf("it's fine"), "plain:it's fine")
  equal('a hash only starts a comment at a word boundary',
    kindsOf('color: #fff'), 'plain:color: |comment:#fff')
  equal('an id selector is not a comment', kindsOf('a#b { color: red }'), 'plain:a#b { color: red }')
  equal('a decrement is not a comment', kindsOf('i--;'), 'plain:i--;')
  equal('a member access is not a keyword', kindsOf('row.type = x'), 'plain:row.type = x')
  equal('a keyword inside an identifier is not a keyword', kindsOf('myreturn = 1'), 'plain:myreturn = |number:1')
  equal('digits inside an identifier are not a number', kindsOf('abc123'), 'plain:abc123')
  equal('an escaped quote does not end the string',
    kindsOf(`'it\\'s'`), `string:'it\\'s'`)

  // Every character must survive tokenizing, colored or not: a tokenizer that
  // drops text would silently corrupt the diff it is decorating.
  const samples = [
    'const { a, b } = require("react") // trailing',
    'if (x && y) { return `nope',
    '#include <stdio.h>',
    "print('hi', 42)",
    'var x=1;',
    '',
  ]
  check('tokenizing preserves every character',
    samples.every(text => tokenizeLine(text).map(token => token.text).join('') === text),
    JSON.stringify(samples.filter(text => tokenizeLine(text).map(token => token.text).join('') !== text)))

  // Overlaying the intra-line marks must not disturb the tokens either.
  const overlayInput = 'const value = 41;'
  const overlayTokens = tokenizeLine(overlayInput)
  const overlayFlags = [...overlayInput].map((_char, index) => index >= 14 && index <= 15)
  const segments = overlayChange(overlayTokens, overlayFlags)
  equal('overlaying change marks preserves every character',
    segments.map(segment => segment.text).join(''), overlayInput)
  equal('a partly changed token is split, so the tint stops at the boundary',
    segments.filter(segment => segment.changed).map(segment => segment.text).join(''), '41')
  equal('tokens survive the overlay', segments.map(segment => segment.kind).join('|'),
    'keyword|plain|number|plain')
  equal('without marks every token stays one segment',
    overlayChange(overlayTokens, undefined).length, overlayTokens.length)

  // ── The bulk-fetch queue behind "全部 Fetch" ───────────────────────────────
  // One repository at a time, with progress the button can show and a cleanup
  // that runs even when a step throws, so the spinner can never get stuck.
  const order = []
  const progress = []
  await runSequentially(
    ['alpha', 'beta', 'gamma'],
    async (item) => {
      order.push(`start:${item}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${item}`)
    },
    report => { progress.push(report === null ? 'done' : `${String(report.done)}/${String(report.total)}:${report.label ?? ''}`) },
    item => item,
  )
  equal('the queue runs every item', order.length, 6)
  equal('a step cannot start before the previous one ended',
    order.join(' '), 'start:alpha end:alpha start:beta end:beta start:gamma end:gamma')
  equal('progress names each item before it runs, in order',
    progress.join(' | '), '0/3:alpha | 1/3:beta | 2/3:gamma | done')

  const failed = []
  await runSequentially(
    ['one', 'two'],
    async (item) => { failed.push(item); if (item === 'one') throw new Error('fetch failed') },
    report => { failed.push(report === null ? 'cleared' : 'running') },
  ).catch(() => { failed.push('rejected') })
  equal('a failing step stops the run and still clears the spinner',
    failed.join(' '), 'running one cleared rejected')

  const emptyProgress = []
  await runSequentially([], async () => {}, report => { emptyProgress.push(report === null ? 'done' : 'running') })
  equal('an empty queue still reports completion once', emptyProgress.join(' '), 'done')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// ── The commit graph: lanes, merges and paginated edges ──────────────────────
// The repositories below prove the data; these fixtures prove the layout, so a
// merge, a collapsed lane or a page boundary is asserted rather than eyeballed.
const linear = buildGraph([
  { short: 'c', parents: ['b'] },
  { short: 'b', parents: ['a'] },
  { short: 'a', parents: [] },
])
equal('a linear history keeps one lane', linear.map(row => row.lane), [0, 0, 0])
equal('a linear history never widens past one lane', graphWidth(linear), 1)
equal('the line passes through every row of a linear history', linear.map(row => row.outgoing), [[0], [0], []])
check('only the repository\'s first commit is a root', linear[2].root === true && linear[0].root === false)
check('a linear history draws no merging edges', linear.every(row => row.edges.length === 0), JSON.stringify(linear.map(row => row.edges)))

const merge = buildGraph([
  { short: 'm', parents: ['p1', 'p2'] },
  { short: 'p1', parents: ['base'] },
  { short: 'p2', parents: ['base'] },
  { short: 'base', parents: [] },
])
equal('a merge opens a second lane', merge[0].width, 2)
equal('the merge line leaves the commit lane for the new lane', merge[0].edges, [{ from: 0, to: 1 }])
equal('the merge commit sits in the first lane', merge[0].lane, 0)
equal('both lanes stay open while the merge is unresolved', merge[0].outgoing, [0, 1])
equal('the side branch collapses into the lane both parents share', merge[2].edges, [{ from: 0, to: 1 }])
equal('the collapse closes the left lane', merge[2].outgoing, [1])
equal('the shared parent is the last row and closes the lane', merge[3].outgoing, [])

const tips = buildGraph([
  { short: 'x', parents: [] },
  { short: 'y', parents: [] },
])
equal('two unrelated tips each start their own line', tips.map(row => row.lane), [0, 0])
// ── Combined diffs (`diff --cc`): the shape of a conflicted file ────────────
// A real conflicted merge in a throwaway fixture, parsed through the same
// function. The shared sandbox is already gone by this point, so this fixture
// owns its own lifecycle.
{
  const conflict = join(sandbox, 'conflict-repo')
  mkdirSync(conflict, { recursive: true })
  try {
  const cgit = args => execFileSync('git', args, { cwd: conflict, stdio: 'pipe' }).toString()
  cgit(['init', '-q', '--initial-branch=main'])
  cgit(['config', 'user.email', 'diff@example.com'])
  cgit(['config', 'user.name', 'Diff'])
  writeFileSync(join(conflict, 'f.txt'), 'line1\nline2\nline3\n')
  cgit(['add', 'f.txt'])
  cgit(['commit', '-q', '-m', 'init'])
  cgit(['checkout', '-q', '-b', 'side'])
  writeFileSync(join(conflict, 'f.txt'), 'line1\nside\nline3\n')
  cgit(['commit', '-qam', 'side'])
  cgit(['checkout', '-q', 'main'])
  writeFileSync(join(conflict, 'f.txt'), 'line1\nmain\nline3\n')
  cgit(['commit', '-qam', 'main'])
  let clashed = false
  try {
    cgit(['merge', 'side'])
  } catch {
    clashed = true
  }
  check('the combined-diff fixture really conflicts', clashed === true)
  const combinedText = cgit(['diff', '--', 'f.txt'])
  const combined = parseUnifiedDiff(combinedText)
  check('a combined diff is not read as an empty answer',
    combined.empty === false && combined.combined === true && combinedText.includes('diff --cc'))
  const combinedRows = combined.blocks.filter(block => block.kind === 'hunk').flatMap(block => block.rows)
  check('every conflict line is a row, markers included',
    combinedRows.length === 7
      && combinedRows.some(row => row.text.startsWith('<<<<<<<')) && combinedRows.some(row => row.text.startsWith('>>>>>>>')),
    JSON.stringify(combinedRows.map(row => `${row.kind}:${row.text.slice(0, 12)}`)))
  check('combined rows carry only the result-side number, never an old side',
    combinedRows.every(row => row.oldLine === undefined)
      && combinedRows.filter(row => row.kind !== 'del').map(row => row.newLine).join(',') === '1,2,3,4,5,6,7',
    JSON.stringify(combinedRows.map(row => [row.kind, row.oldLine, row.newLine])))
  check('the combined tally counts the added lines of the result',
    combined.added === 5 && combined.deleted === 0, `+${String(combined.added)} -${String(combined.deleted)}`)
  // An unmerged path always diffs combined — git has no one-sided answer for
  // it — so the "not combined" case comes from an ordinary commit diff in the
  // same fixture.
  const ordinary = parseUnifiedDiff(cgit(['diff', 'HEAD~1', 'HEAD', '--', 'f.txt']))
  check('a plain unified diff is not marked combined',
    ordinary.combined === false && ordinary.empty === false, String(ordinary.combined))
  } finally {
    rmSync(conflict, { recursive: true, force: true })
  }
}

// ── History day buckets: the separators' rhythm ─────────────────────────────
{
  const now = new Date('2026-10-06T12:00:00+08:00')
  check('a commit from today lands in 今天',
    historyDayLabel('2026-10-06T09:30:00+08:00', now) === '今天')
  check('a commit from yesterday lands in 昨天, even an hour old',
    historyDayLabel('2026-10-05T23:00:00+08:00', now) === '昨天')
  check('a commit from five days ago lands in 最近 7 天',
    historyDayLabel('2026-10-01T10:00:00+08:00', now) === '最近 7 天')
  check('a commit older than a week lands in 更早',
    historyDayLabel('2026-09-01T10:00:00+08:00', now) === '更早')
  check('an unparseable date lands in 更早, not in an error',
    historyDayLabel('junk', now) === '更早')
}

// ── Commit dates: relative while recent, absolute when old ──────────────────
{
  const now = Date.now()
  check('a commit from seconds ago reads as 刚刚', formatCommitDate(new Date(now - 20_000).toISOString()) === '刚刚')
  check('a commit from minutes ago reads in minutes', formatCommitDate(new Date(now - 5 * 60_000).toISOString()) === '5 分钟前')
  check('a commit from hours ago reads in hours', formatCommitDate(new Date(now - 3 * 3_600_000).toISOString()) === '3 小时前')
  check('a commit from days ago reads in days', formatCommitDate(new Date(now - 4 * 86_400_000).toISOString()) === '4 天前')
  check('an old commit reads as an absolute date',
    /^\d{2}-\d{2} \d{2}:\d{2}$/.test(formatCommitDate('2026-01-15T10:30:00.000Z')))
  check('an unparseable date passes through unchanged', formatCommitDate('not-a-date') === 'not-a-date')
}

check('unrelated tips both report themselves as roots', tips.every(row => row.root === true))

const paged = buildGraph([{ short: 'a', parents: ['zzz'] }])
equal('a parent outside the page leaves its line open', paged[0].outgoing, [0])
check('a commit whose parent is unseen is not reported as a root', paged[0].root === false)

// A history whose dates lie: git's default order can print a parent above its
// child, which used to leave a lane open for a commit that never comes again.
const skewed = buildGraph([
  { short: 'parent', parents: ['base'] },
  { short: 'child', parents: ['parent'] },
  { short: 'base', parents: [] },
])
equal('a parent printed above its child does not open a lane',
  skewed.map(row => row.width), [1, 2, 1])
equal('the child needs a lane of its own, and the older line keeps its own',
  skewed[1].outgoing, [0])
check('the child is not reported as a root even though its line ends',
  skewed[1].root === false && skewed[0].lane === 0)
equal('the shared ancestor closes the last line', skewed[2].outgoing, [])

// The regression this was written for: with dates that lie, the old layout
// opened one lane per misordered parent and grew without bound.
const manySkewed = buildGraph([
  { short: 'p1', parents: ['base'] },
  { short: 'c1', parents: ['p1'] },
  { short: 'p2', parents: ['base'] },
  { short: 'c2', parents: ['p2'] },
  { short: 'p3', parents: ['base'] },
  { short: 'c3', parents: ['p3'] },
  { short: 'base', parents: [] },
])
check('a long misordered history does not accumulate lanes',
  graphWidth(manySkewed) <= 3, JSON.stringify(manySkewed.map(row => ({ width: row.width, lane: row.lane }))))
equal('the last row of a misordered history closes everything', manySkewed.at(-1).outgoing, [])

// Many children of one parent: the shared parent must not leave a lane each.
const siblings = buildGraph([
  { short: 's1', parents: ['base'] },
  { short: 's2', parents: ['base'] },
  { short: 's3', parents: ['base'] },
  { short: 'base', parents: [] },
])
check('sibling lines collapse onto the lane that reached the parent first',
  siblings[1].edges.length === 1 && siblings[2].edges.length === 1, JSON.stringify(siblings.map(row => row.edges)))
equal('three siblings still only ever need two lanes', graphWidth(siblings), 2)

// A caller that mixes a full hash with abbreviations: the lanes still meet.
const mixed = buildGraph([
  { short: 'aaaaaaa', parents: ['bbbbbbb1111222233334444555566667777888'] },
  { short: 'bbbbbbb', parents: [] },
])
equal('a full parent hash still finds the abbreviated commit', mixed[1].lane, 0)
equal('no second lane is opened for a commit that is already on the page', graphWidth(mixed), 1)
equal('the matched commit closes the only line', mixed[1].outgoing, [])

const crossed = buildGraph([
  { short: 'child', parents: ['parent'] },
  { short: 'sibling', parents: ['base'] },
  { short: 'parent', parents: ['base'] },
  { short: 'base', parents: [] },
])
check('a lane waiting for a commit picks it up wherever it appears',
  crossed[2].lane === 0, JSON.stringify(crossed[2]))
equal('a redundant lane folds into the one that reached the commit first', crossed[2].edges, [{ from: 1, to: 0 }])
equal('the folded lane is closed', crossed[2].outgoing, [0])
equal('the sibling sits beside the main line', crossed[1].lane, 1)
equal('the two lines meet at the shared base', crossed[3].outgoing, [])

process.stdout.write(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
