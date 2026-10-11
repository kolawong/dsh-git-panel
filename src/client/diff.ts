/**
 * Unified-diff parsing and intra-line comparison.
 *
 * Deliberately free of React: the built bundle re-exports these so
 * `scripts/diff-test.mjs` can feed them real `git diff` output.
 *
 * The row model — old/new line gutters, a sign column, per-kind row tints, and
 * a chip standing in for the lines git trimmed between hunks — follows the
 * diff renderer that ships with DSH-better-sidebar. Two deliberate departures:
 *
 * - Colour lives in `panel.tsx` and uses only alias tokens this harness really
 *   defines (checked with the Theme inspect provider). That renderer names
 *   `--dsw-alias-label-tertiary` and `--dsw-alias-state-business-primary`,
 *   which do not exist here, so its line numbers inherit the row colour and its
 *   `mod` rows lose both their hue and their tint to invalid-value fallback.
 * - A rewritten pair keeps its red/green rows rather than collapsing into one
 *   `mod` row: red/green is what people read as "old/new", and the intra-line
 *   highlight already points at the exact characters that changed.
 */

/** The kind of one diff row. */
export type RowKind = 'add' | 'del' | 'context' | 'meta'

/** One rendered diff row. */
export interface DiffRow {
  kind: RowKind
  /** Old-side line number; absent on pure additions and on metadata. */
  oldLine?: number
  /** New-side line number; absent on pure deletions and on metadata. */
  newLine?: number
  /** The line's content, without git's leading marker. */
  text: string
}

/** A stretch of unchanged lines git trimmed away between two hunks. */
export interface DiffGap {
  kind: 'gap'
  /** How many lines are hidden (the same count on both sides). */
  hidden: number
  /** git's function/section note for the hunk that follows. */
  note: string
  /** 1-based first and last old-side line the gap covers. */
  oldStart: number
  oldEnd: number
  /** 1-based first and last new-side line the gap covers. */
  newStart: number
  newEnd: number
}

/** A hunk's rows, or a stand-in for the lines git trimmed away. */
export type DiffBlock = { kind: 'hunk'; rows: DiffRow[] } | DiffGap

/** One parsed diff. */
export interface ParsedDiff {
  blocks: DiffBlock[]
  added: number
  deleted: number
  /** True when the text carried no hunk at all (mode-only or empty diff). */
  empty: boolean
  /** True when the file is binary, so there is nothing to draw. */
  binary: boolean
  /**
   * True when the text is a combined (`diff --cc`) diff of an unmerged file:
   * every line has one prefix column per parent, so there is no single old
   * side and rows carry no old-side line numbers.
   */
  combined: boolean
}

/** A run of characters that either changed or did not. */
export interface InlineRun {
  text: string
  changed: boolean
}

/** Each side of one rewritten line, split into changed and unchanged runs. */
export interface InlineDiff {
  old: InlineRun[]
  next: InlineRun[]
}

/** Parse `@@ -a[,b] +c[,d] @@ note` (a count defaults to 1 when omitted). */
function parseHunkHeader(line: string): { oldStart: number; newStart: number; oldCount: number; newCount: number; note: string } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
  if (match === null) return null
  return {
    oldStart: Number(match[1]),
    newStart: Number(match[3]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    note: (match[5] ?? '').trim(),
  }
}

/**
 * Parse `git diff --no-color` output into renderable blocks.
 *
 * File headers (`diff --git`, `index`, `---`, `+++`, mode and rename lines) are
 * never rows: the panel already names the file it is showing, so those lines
 * would only be noise. Anything between hunks becomes a `gap` block carrying
 * how many lines are missing and the hunk's section note (its enclosing
 * function, say), which is the one piece of that header worth keeping.
 *
 * The hunk header's line counts drive the body, not the markers: a deleted line
 * whose text begins with `-- ` arrives as `--- ` and would otherwise be read as
 * the next file's header. Counting also ends each hunk exactly where git says
 * it ends, and lets a new `diff --git` section restart the gap arithmetic
 * instead of measuring a gap across two unrelated files.
 *
 * @param text - complete diff output.
 * @returns blocks in file order, plus the add/delete tally.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const blocks: DiffBlock[] = []
  let rows: DiffRow[] = []
  let inHunk = false
  let remaining = 0
  let oldNum = 0
  let newNum = 0
  let added = 0
  let deleted = 0
  let prevOldEnd = 0
  let prevNewEnd = 0
  let binary = false
  // An unmerged file diffs as `diff --cc`: two prefix columns, one per parent,
  // and `@@@` hunk headers with three ranges (the last one is the result).
  let combined = false
  let anyCombined = false

  const flush = (): void => {
    if (rows.length > 0) blocks.push({ kind: 'hunk', rows })
    rows = []
    inHunk = false
    remaining = 0
  }

  for (const raw of text.split('\n')) {
    // The definitive file separator: the previous section ends here.
    if (raw.startsWith('diff --git ')) {
      flush()
      prevOldEnd = 0
      prevNewEnd = 0
      combined = false
      continue
    }
    // The combined-diff file header: unmerged files diff this way.
    if (raw.startsWith('diff --cc ')) {
      flush()
      prevOldEnd = 0
      prevNewEnd = 0
      combined = true
      anyCombined = true
      continue
    }
    // Belongs to the row above, and never consumes a counted line.
    if (inHunk && raw[0] === '\\') {
      rows.push({ kind: 'meta', text: raw.slice(1).trim() })
      continue
    }
    // A combined body line: two prefix columns. `+` in either column means the
    // line is in the result, `-` in either means it is not; only result lines
    // advance the result-side number. There is no single old side, so no
    // old-side numbers are emitted at all.
    if (inHunk && combined
      && (raw[0] === ' ' || raw[0] === '-' || raw[0] === '+')
      && (raw[1] === ' ' || raw[1] === '-' || raw[1] === '+')) {
      const body = raw.slice(2)
      if (raw[0] === '-' || raw[1] === '-') {
        rows.push({ kind: 'del', text: body })
        deleted += 1
      } else if (raw[0] === '+' || raw[1] === '+') {
        rows.push({ kind: 'add', text: body, newLine: newNum })
        newNum += 1
        added += 1
      } else {
        rows.push({ kind: 'context', text: body, newLine: newNum })
        newNum += 1
      }
      prevNewEnd = newNum - 1
      continue
    }
    // A counted body line: only these advance the line numbers.
    if (inHunk && remaining > 0 && (raw[0] === ' ' || raw[0] === '-' || raw[0] === '+')) {
      if (raw[0] === ' ') {
        rows.push({ kind: 'context', text: raw.slice(1), oldLine: oldNum, newLine: newNum })
        oldNum += 1
        newNum += 1
      } else if (raw[0] === '-') {
        rows.push({ kind: 'del', text: raw.slice(1), oldLine: oldNum })
        oldNum += 1
        deleted += 1
      } else {
        rows.push({ kind: 'add', text: raw.slice(1), newLine: newNum })
        newNum += 1
        added += 1
      }
      remaining -= 1
      prevOldEnd = oldNum - 1
      prevNewEnd = newNum - 1
      continue
    }
    // The hunk is complete (or this line cannot belong to it).
    if (inHunk) flush()
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
      binary = true
      continue
    }
    // A combined hunk header: three ranges, the result side is the third. The
    // body ends where the prefixes stop, so no line budget is kept; gaps are
    // not synthesized between combined hunks (there are two old sides).
    if (combined) {
      const combinedHeader = /^@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@@(.*)$/.exec(raw)
      if (combinedHeader !== null) {
        inHunk = true
        newNum = Number(combinedHeader[1])
        rows = []
        continue
      }
    }
    const header = parseHunkHeader(raw)
    if (header === null) continue // index / --- / +++ / mode / rename metadata
    // The lines between two hunks are identical on both sides, so both spans
    // are equal; `max` is defensive, and a gap that spans nothing is not a gap.
    const oldSpan = header.oldStart - prevOldEnd - 1
    const newSpan = header.newStart - prevNewEnd - 1
    const hidden = Math.max(oldSpan, newSpan)
    if (hidden > 0) {
      blocks.push({
        kind: 'gap',
        hidden,
        note: header.note,
        oldStart: prevOldEnd + 1,
        oldEnd: prevOldEnd + Math.max(oldSpan, 0),
        newStart: prevNewEnd + 1,
        newEnd: prevNewEnd + Math.max(newSpan, 0),
      })
    }
    oldNum = header.oldStart
    newNum = header.newStart
    remaining = header.oldCount + header.newCount
    inHunk = true
    prevOldEnd = header.oldStart - 1
    prevNewEnd = header.newStart - 1
  }
  flush()
  return { blocks, added, deleted, empty: !blocks.some(block => block.kind === 'hunk'), binary, combined: anyCombined }
}

/**
 * Split one rewritten line pair into changed and unchanged runs.
 *
 * Common prefix and suffix are shared text; only the differing middle is
 * marked. That guarantees the highlight never covers an identical character,
 * and a one-word edit inside a long line stays obvious.
 *
 * @param oldText - the removed line's content.
 * @param newText - the added line's content.
 * @returns each side's runs, in order.
 */
export function diffInline(oldText: string, newText: string): InlineDiff {
  const shortest = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < shortest && oldText[prefix] === newText[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1
  const runs = (text: string): InlineRun[] => {
    const start = prefix
    const end = text.length - suffix
    const out: InlineRun[] = []
    if (start > 0) out.push({ text: text.slice(0, start), changed: false })
    if (end > start) out.push({ text: text.slice(start, end), changed: true })
    if (end < text.length) out.push({ text: text.slice(end), changed: false })
    return out
  }
  return { old: runs(oldText), next: runs(newText) }
}

/**
 * Pair the removed lines of a hunk with the added lines they were rewritten
 * into, so each pair can highlight its own changed characters.
 *
 * A pair is the n-th `del` and the n-th `add` of the same run; a run of three
 * deletions against one addition pairs only the first. Unpaired rows return
 * null and render without an intra-line highlight.
 *
 * @param rows - one hunk's rows, in order.
 * @returns inline runs keyed by row index.
 */
export function pairInlineRuns(rows: readonly DiffRow[]): Map<number, InlineRun[]> {
  const paired = new Map<number, InlineRun[]>()
  let index = 0
  while (index < rows.length) {
    if ((rows[index] as DiffRow).kind !== 'del') {
      index += 1
      continue
    }
    const firstDel = index
    while (index < rows.length && (rows[index] as DiffRow).kind === 'del') index += 1
    const firstAdd = index
    while (index < rows.length && (rows[index] as DiffRow).kind === 'add') index += 1
    const pairs = Math.min(firstAdd - firstDel, index - firstAdd)
    for (let offset = 0; offset < pairs; offset += 1) {
      const del = rows[firstDel + offset] as DiffRow
      const add = rows[firstAdd + offset] as DiffRow
      const inline = diffInline(del.text, add.text)
      paired.set(firstDel + offset, inline.old)
      paired.set(firstAdd + offset, inline.next)
    }
  }
  return paired
}
