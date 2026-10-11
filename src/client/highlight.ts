/**
 * A deliberately small, language-agnostic line tokenizer for the diff view.
 *
 * The rule this file follows: **a lexer that errs looks worse than no coloring
 * at all**. So it refuses to be clever. It recognizes exactly four things —
 * comments, string literals, a short list of unambiguous keywords, and numbers
 * — and leaves everything else untouched. No heuristics about types, calls,
 * members, or interpolation, because those are where per-line tokenizers
 * produce confidently wrong colors.
 *
 * Two more rules keep it honest:
 * - A string is only claimed when it closes on the same line. A backtick that
 *   opens a multi-line template (or a lone apostrophe in prose) therefore stops
 *   the scan instead of painting the rest of the file as a string.
 * - A keyword only counts as one when it stands alone as a word and is not a
 *   member access (`object.new`, `row.type`), which is what a naive word match
 *   gets wrong most often.
 */

/** What a stretch of a line is, as far as the panel colors it. */
export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number'

/** One colored stretch of a line. */
export interface Token {
  text: string
  kind: TokenKind
}

/**
 * Words colored as keywords. Kept short on purpose: every entry must be
 * unambiguous in the languages this panel shows (JS/TS, Python, Go, shell).
 */
const KEYWORDS = new Set([
  // declarations and modules
  'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'struct',
  'import', 'export', 'from', 'package', 'def', 'func', 'lambda', 'module', 'namespace',
  // control flow
  'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'yield', 'try', 'catch', 'finally', 'throw', 'raise', 'defer',
  // operators and values
  'async', 'await', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'is', 'not',
  'and', 'or', 'extends', 'implements', 'with', 'as', 'this', 'super', 'self',
  'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil',
  // modifiers
  'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'final', 'void',
])

/**
 * Comment starters. `//` always counts. `#` only counts at the start of a line
 * or after whitespace — otherwise CSS ids and `foo#bar` would turn into
 * comments. `--` and `;` are deliberately absent: in JS and Go a decrement or a
 * statement terminator is far more common than an SQL comment, and a tokenizer
 * that paints those is worse than one that never colors SQL.
 */
function commentAt(rest: string, previous: string | undefined): boolean {
  if (rest.startsWith('//')) return true
  return rest.startsWith('#') && (previous === undefined || previous.trim() === '')
}

/** Characters that may not sit directly before a keyword for it to count. */
const NOT_BEFORE_KEYWORD = /[A-Za-z0-9_$.]/

/**
 * Split one line into colored tokens.
 *
 * @param text - the line's content, without the diff marker.
 * @returns the line as consecutive tokens covering every character exactly once.
 */
export function tokenizeLine(text: string): Token[] {
  const tokens: Token[] = []
  let plain = ''
  let index = 0

  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ text: plain, kind: 'plain' })
      plain = ''
    }
  }
  const push = (kind: TokenKind, value: string): void => {
    flush()
    if (value !== '') tokens.push({ text: value, kind })
  }

  while (index < text.length) {
    const rest = text.slice(index)

    // A comment owns the rest of the line, so it ends the scan.
    if (commentAt(rest, index === 0 ? undefined : text[index - 1])) {
      push('comment', rest)
      index = text.length
      continue
    }

    const char = text[index] as string
    if (char === '"' || char === "'" || char === '`') {
      // Find the unescaped closing quote on this same line; without one this is
      // not a string we can color, so it stays plain text.
      let scan = index + 1
      let closed = false
      while (scan < text.length) {
        const current = text[scan] as string
        if (current === '\\') {
          scan += 2
          continue
        }
        if (current === char) {
          closed = true
          break
        }
        scan += 1
      }
      if (closed) {
        push('string', text.slice(index, scan + 1))
        index = scan + 1
        continue
      }
    }

    if (char >= '0' && char <= '9') {
      const match = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
      if (match !== null && !NOT_BEFORE_KEYWORD.test(text[index - 1] ?? '')) {
        push('number', match[0])
        index += match[0].length
        continue
      }
    }

    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
      const word = match?.[0] ?? ''
      const before = text[index - 1] ?? ''
      if (word !== '' && KEYWORDS.has(word) && !NOT_BEFORE_KEYWORD.test(before)) {
        push('keyword', word)
        index += word.length
        continue
      }
      // Not a keyword: consume the whole word, so its digits cannot be
      // mistaken for a number literal.
      plain += word === '' ? char : word
      index += word === '' ? 1 : word.length
      continue
    }

    plain += char
    index += 1
  }
  flush()
  return tokens
}

/**
 * Overlay the intra-line change marks onto a line's tokens.
 *
 * Both describe the same string: the tokens cover it in runs, and `changed`
 * gives one flag per character (see `pairInlineRuns`). A token that is only
 * partly changed is split, so the tint never bleeds onto identical characters.
 *
 * @param tokens - the line's colored tokens.
 * @param changed - per-character flags, or undefined when the line has no pair.
 * @returns segments carrying both attributes.
 */
export function overlayChange(
  tokens: readonly Token[],
  changed: readonly boolean[] | undefined,
): { text: string; kind: TokenKind; changed: boolean }[] {
  const segments: { text: string; kind: TokenKind; changed: boolean }[] = []
  let offset = 0
  for (const token of tokens) {
    const flags = token.text.split('').map((_unused, inner) => changed?.[offset + inner] === true)
    offset += token.text.length
    let run = ''
    let current = flags[0] ?? false
    for (const [inner, char] of [...token.text].entries()) {
      const flag = flags[inner] ?? false
      if (flag !== current && run !== '') {
        segments.push({ text: run, kind: token.kind, changed: current })
        run = ''
      }
      current = flag
      run += char
    }
    if (run !== '') segments.push({ text: run, kind: token.kind, changed: current })
  }
  return segments
}
