/**
 * The Git panel: the left rail glyph, the overview grid of every registered
 * workspace, and the per-repository page behind each card.
 *
 * The overview is the landing screen — one card per workspace, dirty ones
 * first, so "which project needs attention" is answerable without opening
 * anything. A card opens the repository page: branch and upstream facts, the
 * work-tree entries, and the selected file's unified diff.
 *
 * Both screens can run the three remote actions (fetch / pull --ff-only / push).
 * `push` is never one click: the button arms itself, and the confirmation is
 * sent to the host as `confirm: true`, which the host refuses to act without.
 * Every action lands in the session's operation log at the bottom of the panel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { ensurePanelStyles, removePanelStyles } from './styles'
import { fetchBlame, fetchBranches, fetchCommitMessage, fetchContext, fetchDiff, fetchLog, fetchModels, fetchOverview, fetchProjectSummaries, fetchShow, fetchStashes, fetchStatus, isAbort, runAction, savePrefs, streamCommitMessage, watchRepos } from './api'
import { pairInlineRuns, parseUnifiedDiff } from './diff'
import { overlayChange, tokenizeLine } from './highlight'
import type { TokenKind } from './highlight'
import { runSequentially } from './queue'
import { buildGraph } from './graph'
import type { GraphRow } from './graph'
import {
  IconAlert, IconArchive, IconArrowDown, IconArrowLeft, IconArrowUp, IconBranch, IconCheck,
  IconChevronDown, IconCloudDown, IconCloudUp, IconCommit, IconCross, IconDiff, IconDot,
  IconEllipsis, IconFolder, IconHistory, IconMinus, IconPlus, IconRefresh, IconSpark,
  IconTerminal, IconUndo,
} from './icons'
import type { RunProgress } from './queue'
import type { ModelCatalog, OperationState, StashList , BlamePayload , BlameLine } from './api'
import type { DiffRow, InlineRun, ParsedDiff, RowKind } from './diff'
import type {
  ActionName,
  ActionRequest,
  BranchList,
  CommitEntry,
  CommitFile,
  CommitLog,
  CommitShow,
  LiveState,
  LocalAction,
  DiffTarget,
  GitDiff,
  GitFileEntry,
  GitRepoSummary,
  GitStatus,
  LineCounts,
  OverviewEntry,
  WorkspaceOption,
  WorkTreeCounts,
} from './api'

/** How often the visible overview re-reads every workspace. */
const OVERVIEW_REFRESH_MS = 20_000

/** How often the visible repository page re-reads its repository. */
const REPO_REFRESH_MS = 15_000

/** How often either screen re-reads while the event stream is open, as a safety net. */
const OVERVIEW_LIVE_REFRESH_MS = 60_000
const REPO_LIVE_REFRESH_MS = 60_000

/** How long a push button stays armed before it disarms itself. */
const ARM_TIMEOUT_MS = 8_000

/** How many operations the log keeps. */
const LOG_MAX = 30

/** How many output lines one log entry shows. */
const LOG_LINES = 20

const SURFACE = 'var(--dsw-alias-bg-base)'
const LAYER_1 = 'var(--dsw-alias-bg-layer-1)'
const LAYER_2 = 'var(--dsw-alias-bg-layer-2)'
const BORDER = 'var(--dsw-alias-border-l1)'
const TEXT = 'var(--dsw-alias-label-primary)'
const MUTED = 'var(--dsw-alias-label-secondary)'
const BRAND = 'var(--dsw-alias-brand-primary)'
const SUCCESS = 'var(--dsw-alias-state-success-primary)'
const ERROR = 'var(--dsw-alias-state-error-primary)'

/**
 * Where the picked draft model is remembered.
 *
 * The choice belongs to the person at this browser, not to the profile: it is
 * read back on the next visit, so nobody has to re-pick it every time.
 */
const MODEL_CHOICE_KEY = 'dsh-git-panel:commit-model'

/** One model route, as the picker holds it. */
interface ModelChoice {
  provider: string
  model: string
}

/** Read the remembered route, tolerating a browser that refuses storage. */
function readModelChoice(): ModelChoice | null {
  try {
    const raw = window.localStorage.getItem(MODEL_CHOICE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown }
    if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') return null
    if (parsed.provider === '' || parsed.model === '') return null
    return { provider: parsed.provider, model: parsed.model }
  } catch {
    return null
  }
}

/** Remember the route, or forget it when the user goes back to the default. */
function writeModelChoice(choice: ModelChoice | null): void {
  try {
    if (choice === null) window.localStorage.removeItem(MODEL_CHOICE_KEY)
    else window.localStorage.setItem(MODEL_CHOICE_KEY, JSON.stringify(choice))
  } catch {
    // A full or disabled store costs the memory, never the draft.
  }
}

/** The value one `<option>` carries: provider and model in one string. */
const choiceValue = (provider: string, model: string): string => `${provider}\u0000${model}`

/** Split an option value back into a route. */
function parseChoiceValue(value: string): ModelChoice | null {
  const at = value.indexOf('\u0000')
  if (at <= 0) return null
  const model = value.slice(at + 1)
  return model === '' ? null : { provider: value.slice(0, at), model }
}
const WARN = 'var(--dsw-alias-state-warn-primary)'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/** Which screen the panel currently shows. */
type Screen = { kind: 'overview' } | { kind: 'repo'; dir: string }

/** The group a work-tree entry is listed under. */
type GroupKey = 'conflicted' | 'staged' | 'changes' | 'untracked'

/** One rendered section of the file list. */
interface FileGroup {
  key: GroupKey
  title: string
  files: GitFileEntry[]
}

/** What one selected row asks the host for. */
interface Selection extends DiffTarget {
  group: GroupKey
}

/** One card's headline state. */
interface CardState {
  tone: string
  label: string
  /** Sort rank: conflicts, then dirty, then clean, then unreadable. */
  rank: number
}

/** One finished operation. */
interface LogEntry {
  id: number
  at: number
  /** The repository the action ran in. */
  dir: string
  title: string
  action: ActionName
  /** git's verdict. */
  succeeded: boolean
  exitCode: number | null
  durationMs: number
  command: string[]
  output: string
  truncated: boolean
  /** Every command the action ran, in order (a pull fetches before it pulls). */
  steps?: { command: string[]; exitCode: number | null; succeeded: boolean; output: string }[]
  /** Present when the request itself failed and git never ran. */
  error?: string
}

/** One status indicator for the live event stream. */
function LiveChip({ state }: { state: LiveState }): ReactNode {
  const label = state === 'live' ? '实时' : state === 'connecting' ? '连接中…' : '轮询'
  const tone = state === 'live' ? SUCCESS : state === 'connecting' ? MUTED : WARN
  return (
    <span data-live={state} title={state === 'live' ? '正在监听 .git，变化立即反映' : '事件流不可用，退回定时刷新'}>
      <Chip tone={tone}><IconDot size={7} />{label}</Chip>
    </span>
  )
}

/**
 * Run one remote action, wherever the button was, and record it in the log.
 * It resolves when the action settled, which is what lets "fetch every
 * repository" run them one at a time instead of firing a dozen fetches at once.
 */
type RunAction = (dir: string, title: string, action: ActionName, request?: ActionRequest) => Promise<boolean>

/** The error text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A wall clock time for the log. */
function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** The headline state of one overview card. */
function cardState(entry: OverviewEntry): CardState {
  if (entry.reason === 'unavailable') return { tone: ERROR, label: '不可用', rank: 3 }
  if (entry.reason === 'not-a-repository' || entry.repo === null) return { tone: MUTED, label: '非 git 仓库', rank: 3 }
  const { conflicted, staged, changed, untracked } = entry.counts
  if (conflicted > 0) return { tone: ERROR, label: `${conflicted} 处冲突`, rank: 0 }
  if (staged + changed + untracked > 0) return { tone: WARN, label: '有改动', rank: 1 }
  return { tone: SUCCESS, label: '干净', rank: 2 }
}

/** The `n 已暂存 · n 变更` summary of one tally. */
function countsSummary(counts: WorkTreeCounts): string {
  const parts: string[] = []
  if (counts.conflicted > 0) parts.push(`${counts.conflicted} 冲突`)
  if (counts.staged > 0) parts.push(`${counts.staged} 已暂存`)
  if (counts.changed > 0) parts.push(`${counts.changed} 变更`)
  if (counts.untracked > 0) parts.push(`${counts.untracked} 未跟踪`)
  return parts.join(' · ')
}

/** Split work-tree entries into the groups the repository page renders. */
function groupFiles(files: readonly GitFileEntry[]): FileGroup[] {
  const conflicted = files.filter(file => file.unmerged)
  const staged = files.filter(file => !file.untracked && !file.unmerged && file.index !== '.')
  const changes = files.filter(file => !file.untracked && !file.unmerged && file.worktree !== '.')
  const untracked = files.filter(file => file.untracked)
  return [
    { key: 'conflicted', title: '冲突', files: conflicted },
    { key: 'staged', title: '已暂存', files: staged },
    { key: 'changes', title: '变更', files: changes },
    { key: 'untracked', title: '未跟踪', files: untracked },
  ].filter(group => group.files.length > 0) as FileGroup[]
}

/** The status letter one row shows for its group. */
function statusLetter(file: GitFileEntry, group: GroupKey): string {
  if (group === 'untracked') return '?'
  if (group === 'conflicted') return '!'
  const code = group === 'staged' ? file.index : file.worktree
  return code === '.' ? '·' : code.toUpperCase()
}

/** The tone one status letter carries. */
function letterColor(letter: string): string {
  if (letter === 'D') return ERROR
  if (letter === 'R' || letter === 'C') return BRAND
  if (letter === 'M' || letter === 'T') return WARN
  if (letter === '!' || letter === 'U') return ERROR
  return MUTED
}

/** The `+n −m` tally of one group, or null when git counted nothing. */
function countsLabel(counts: LineCounts | null): LineCounts | null {
  return counts
}

/** The colour of one row kind's text and sign. */
function rowColor(kind: RowKind): string {
  if (kind === 'add') return SUCCESS
  if (kind === 'del') return ERROR
  if (kind === 'meta') return MUTED
  return TEXT
}

/** The faint full-width tint under a changed row. */
function rowTint(kind: RowKind): string | undefined {
  if (kind === 'add') return `color-mix(in srgb, ${SUCCESS} 8%, transparent)`
  if (kind === 'del') return `color-mix(in srgb, ${ERROR} 8%, transparent)`
  return undefined
}

/** The sign a row shows in its gutter. */
/**
 * The color of one syntax token.
 *
 * Only tokens that really exist in this harness's theme are used: a comment is
 * the muted label, a string the success color, a keyword the brand color, a
 * number the warning color. Plain text keeps the row's own color, so added and
 * removed lines stay green and red while their keywords still read as keywords.
 */
function tokenColor(kind: TokenKind): string | undefined {
  switch (kind) {
    case 'comment': return MUTED
    case 'string': return SUCCESS
    case 'keyword': return BRAND
    case 'number': return WARN
    default: return undefined
  }
}

/** Expand per-run change flags into one flag per character. */
function changeFlags(runs: readonly InlineRun[] | undefined, length: number): boolean[] | undefined {
  if (runs === undefined || runs.length === 0) return undefined
  const flags: boolean[] = []
  for (const run of runs) for (const _char of run.text) flags.push(run.changed)
  if (flags.length !== length) return undefined
  return flags
}

function rowSign(kind: RowKind): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '-'
  return ' '
}

/** The muted colour of the line-number gutters. */
const LINE_NO = `color-mix(in srgb, ${MUTED} 70%, transparent)`

/** The fixed style of one line-number gutter. */
const LINE_NO_STYLE: CSSProperties = {
  flex: 'none',
  width: '2.6em',
  textAlign: 'right',
  color: LINE_NO,
  fontSize: 10,
  lineHeight: '18px',
  userSelect: 'none',
}

/** A small rounded chip. */
/** What each in-progress operation is called, and how its verbs read. */
const OPERATION_LABEL: Record<OperationState['kind'], { name: string; continuing: string; aborting: string; abortTitle: string; continueTitle: string }> = {
  merge: {
    name: '合并',
    continuing: '完成合并',
    aborting: '中止合并',
    abortTitle: 'git merge --abort：放弃这次合并，工作区回到合并前（已做的冲突解决一并丢弃）',
    continueTitle: 'git commit --no-edit：冲突已全部解决，提交这次合并',
  },
  'cherry-pick': {
    name: '挑拣（cherry-pick）',
    continuing: '继续挑拣',
    aborting: '中止挑拣',
    abortTitle: 'git cherry-pick --abort：放弃这次挑拣，回到开始前',
    continueTitle: 'git cherry-pick --continue：冲突已全部解决，继续',
  },
  revert: {
    name: '回退（revert）',
    continuing: '继续回退',
    aborting: '中止回退',
    abortTitle: 'git revert --abort：放弃这次回退，回到开始前',
    continueTitle: 'git revert --continue：冲突已全部解决，继续',
  },
  rebase: {
    name: '变基（rebase）',
    continuing: '继续变基',
    aborting: '中止变基',
    abortTitle: 'git rebase --abort：放弃这次变基，回到开始前',
    continueTitle: 'git rebase --continue：冲突已全部解决，继续',
  },
}

/**
 * The banner for an in-progress merge/cherry-pick/revert/rebase.
 *
 * The panel's own pull is `--ff-only` so it never starts one of these; they
 * arrive from the terminal or from a conflicting stash pop. Either way the
 * file list alone is not enough: the user needs to know the repository is
 * mid-operation, and to have the two honest ways out.
 */
function OperationBanner({ operation, busy, onRun }: {
  operation: OperationState
  busy: string | null
  onRun: (action: 'abortOperation' | 'continueOperation', request?: { confirm?: boolean }) => void
}): ReactNode {
  const label = OPERATION_LABEL[operation.kind]
  const resolved = operation.unmerged === 0
  return (
    <div
      data-operation={operation.kind}
      className="gp-banner"
      data-resolved={resolved}
    >
      <IconAlert size={13} />
      <span style={{ fontWeight: 600 }}>{`${label.name}进行中`}</span>
      <span style={{ color: MUTED }}>
        {resolved
          ? '冲突已全部解决，可以继续。'
          : `还有 ${String(operation.unmerged)} 个文件冲突：在编辑器里解决后逐个暂存，然后继续。`}
      </span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
        <ToolbarButton
          small
          marker="operation-continue"
          disabled={busy !== null || !resolved}
          title={resolved ? label.continueTitle : `还有 ${String(operation.unmerged)} 个文件冲突未解决，不能继续`}
          onClick={() => { onRun('continueOperation') }}
        >
          <IconCheck size={11} />
          {busy === 'continueOperation' ? '继续中…' : label.continuing}
        </ToolbarButton>
        <ConfirmButton
          small
          marker="operation-abort"
          label={<><IconCross size={11} />{label.aborting}</>}
          armedLabel={`确认${label.aborting}`}
          title={label.abortTitle}
          armedTitle="再点一次即中止，已做的冲突解决会被丢弃"
          disabled={busy !== null}
          onConfirm={() => { onRun('abortOperation', { confirm: true }) }}
        />
      </span>
    </div>
  )
}

function Chip({ children, tone, title }: { children: ReactNode; tone?: string; title?: string }): ReactNode {
  return (
    <span
      className="gp-chip"
      title={title}
      style={tone === undefined ? undefined : { borderColor: tone, color: tone }}
    >
      {children}
    </span>
  )
}

/**
 * Drag-to-resize for the list/detail split.
 *
 * `null` means the CSS default (`clamp(320px, 27vw, 460px)`); a drag switches
 * to pixels, a double-click on the handle resets. Pointer events, not mouse
 * events, so a pen or a touch drags the same way.
 */
function useSplitWidth(min: number, maxShare: number): {
  width: number | null
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: () => void
  }
  dragging: boolean
} {
  const [width, setWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    const parent = handle.parentElement
    if (parent === null) return
    const column = handle.previousElementSibling as HTMLElement | null
    if (column === null) return
    start.current = { x: event.clientX, width: column.getBoundingClientRect().width }
    handle.setPointerCapture(event.pointerId)
    setDragging(true)
    const onMove = (move: PointerEvent): void => {
      if (start.current === null) return
      const maxWidth = parent.getBoundingClientRect().width * maxShare
      const next = Math.round(Math.min(maxWidth, Math.max(min, start.current.width + (move.clientX - start.current.x))))
      setWidth(next)
    }
    const onUp = (): void => {
      start.current = null
      setDragging(false)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  const onDoubleClick = (): void => { setWidth(null) }
  return { width, handleProps: { onPointerDown, onDoubleClick }, dragging }
}

/** The visible handle between the list and the detail. */
function SplitHandle({ split }: { split: ReturnType<typeof useSplitWidth> }): ReactNode {
  return (
    <div
      data-split-handle
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整列表宽度，双击复位"
      tabIndex={0}
      className="gp-split-handle"
      data-dragging={split.dragging}
      {...split.handleProps}
      onKeyDown={(event) => {
        // Arrow keys resize too: the handle is a separator, so ←/→ move it.
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const handle = (event.target as HTMLElement)
        const column = handle.previousElementSibling as HTMLElement | null
        if (column === null) return
        const current = column.getBoundingClientRect().width
        const next = Math.round(current + (event.key === 'ArrowRight' ? 24 : -24))
        column.style.width = `${String(next)}px`
        column.style.flex = `0 0 ${String(next)}px`
      }}
    />
  )
}

/** One toolbar button. */
function ToolbarButton({ children, onClick, disabled, title, tone, small, marker, primary }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  tone?: string
  small?: boolean
  /** The one action the row is for: filled, not bordered. */
  primary?: boolean
  /** Sets `data-<marker>`, so the DOM says what the button is for. */
  marker?: string
}): ReactNode {
  return (
    <button
      type="button"
      className={primary === true ? 'gp-btn gp-btn-primary' : 'gp-btn'}
      {...(marker === undefined ? {} : { [`data-${marker}`]: '' })}
      onClick={onClick}
      disabled={disabled === true}
      title={title}
      style={{
        height: small === true ? 24 : 28,
        padding: small === true ? '0 8px' : '0 11px',
        fontSize: small === true ? 11 : 12,
        ...(tone === undefined ? {} : { color: tone }),
      }}
    >
      {children}
    </button>
  )
}

/** The sticky top bar shared by both screens. */
function HeaderBar({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '10px 16px',
        borderBottom: `1px solid ${BORDER}`,
        background: LAYER_1,
      }}
    >
      {children}
    </div>
  )
}

/** The left rail glyph: a branch with two commits. */
export function GitPanelIcon({ size, active }: { size: number; active: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.6 : 1.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="4.6" cy="3.6" r="1.9" />
      <circle cx="4.6" cy="12.4" r="1.9" />
      <circle cx="11.4" cy="5.6" r="1.9" />
      <path d="M4.6 5.5v5" />
      <path d="M11.4 7.5c0 2.3-2.1 3.3-4.3 3.7" />
    </svg>
  )
}

/**
 * The fetch / pull / push buttons for one repository.
 *
 * `compact` is the card variant: pull and push only appear when the tally says
 * they would do something. The repository page shows all three always, so a
 * stale reading never hides the button the user came for.
 */
function RemoteActions({ repo, compact, busy, onRun }: {
  repo: GitRepoSummary | null
  compact?: boolean
  busy: ActionName | null
  onRun: (action: ActionName, request?: ActionRequest) => void
}): ReactNode {
  const [armed, setArmed] = useState(false)

  // A push left armed is a push waiting for a stray click; disarm it.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => { setArmed(false) }, ARM_TIMEOUT_MS)
    return () => { window.clearTimeout(timer) }
  }, [armed])

  if (repo === null) return null
  const hasUpstream = repo.upstream !== null && !repo.detached
  const running = busy !== null
  const upstreamNote = hasUpstream ? '' : '（当前分支没有上游，push/pull 不可用）'

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <ToolbarButton
        small={compact}
        disabled={running}
        title="git fetch --prune：更新远端引用，不改动工作区"
        onClick={() => { setArmed(false); onRun('fetch') }}
      >
        <IconCloudDown size={11} />
        {busy === 'fetch' ? 'Fetch 中…' : 'Fetch'}
      </ToolbarButton>

      {(compact !== true || repo.behind > 0) && (
        <ToolbarButton
          small={compact}
          tone={repo.behind > 0 ? WARN : undefined}
          disabled={running || !hasUpstream}
          title={`git pull --ff-only：只做快进，不产生合并提交；分叉或本地有冲突改动时 git 会拒绝${upstreamNote}`}
          onClick={() => { setArmed(false); onRun('pull') }}
        >
          <IconCloudDown size={11} />
          {busy === 'pull'
            ? 'Pull 中…'
            : repo.behind > 0
              ? <>Pull <IconArrowDown size={10} />{repo.behind}</>
              : 'Pull --ff-only'}
        </ToolbarButton>
      )}

      {(compact !== true || repo.ahead > 0) && (
        <>
          <ToolbarButton
            small={compact}
            tone={armed ? ERROR : undefined}
            disabled={running || !hasUpstream}
            title={armed ? '再点一次即执行 git push' : `git push：把本地提交推到 ${repo.upstream ?? '上游'}${upstreamNote}`}
            onClick={() => {
              if (armed) {
                setArmed(false)
                onRun('push', { confirm: true })
                return
              }
              setArmed(true)
            }}
          >
            <IconCloudUp size={11} />
            {busy === 'push'
              ? 'Push 中…'
              : armed
                ? `确认 push → ${repo.upstream ?? ''}`
                : <>Push <IconArrowUp size={10} />{repo.ahead}</>}
          </ToolbarButton>
          {armed && (
            <ToolbarButton small={compact} onClick={() => { setArmed(false) }} title="取消">
              取消
            </ToolbarButton>
          )}
        </>
      )}
    </span>
  )
}

/** The syntax-coloring switch that sits in a diff header. */
function ColorizeToggle({ on, onToggle }: { on: boolean; onToggle: () => void }): ReactNode {
  return (
    <button
      type="button"
      data-colorize-toggle={on ? 'on' : 'off'}
      onClick={onToggle}
      title={on ? '关闭语法着色' : '开启语法着色'}
      style={{ all: 'unset', cursor: 'pointer', color: on ? BRAND : MUTED, fontSize: 10.5 }}
    >
      {on ? '着色 开' : '着色 关'}
    </button>
  )
}

/**
 * A button that runs something destructive only on its second click.
 *
 * The same shape the push button uses: the first click arms it, the second
 * runs it, and it disarms itself after {@link ARM_TIMEOUT_MS} so a button left
 * armed cannot be fired by a stray click minutes later.
 */
function ConfirmButton({ label, armedLabel, title, armedTitle, disabled, small, marker, onConfirm }: {
  label: ReactNode
  armedLabel: ReactNode
  title?: string
  armedTitle?: string
  disabled?: boolean
  small?: boolean
  marker?: string
  onConfirm: () => void
}): ReactNode {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => { setArmed(false) }, ARM_TIMEOUT_MS)
    return () => { window.clearTimeout(timer) }
  }, [armed])
  return (
    <span className={armed ? 'gp-btn-armed-wrap' : undefined} style={armed ? { display: 'inline-flex' } : undefined}>
      <ToolbarButton
        small={small}
        marker={marker}
        disabled={disabled === true}
        title={armed ? armedTitle ?? title : title}
        onClick={() => {
          if (!armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          onConfirm()
        }}
        {...(armed ? { tone: ERROR } : {})}
      >
        {armed ? armedLabel : label}
      </ToolbarButton>
    </span>
  )
}

/** One workspace card. */
function WorkspaceCard({ entry, busy, onOpen, onRun, projectSummary, summaryProblem }: {
  entry: OverviewEntry
  busy: ActionName | null
  onOpen: () => void
  onRun: (action: ActionName, request?: ActionRequest) => void
  /** The one-line "what is this project", when the host has answered. */
  projectSummary?: string | null
  /**
   * Why this card has no line yet, when the host said the summary call failed.
   * Without it a missing line is "not written yet" and reads as a placeholder;
   * with it the card says so instead of shimmering forever.
   */
  summaryProblem?: string | null
}): ReactNode {
  const state = cardState(entry)
  const summary = countsSummary(entry.counts)
  const hub = entry.repo
  return (
    <div
      className="gp-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px 10px',
        minHeight: 122,
        borderLeft: `3px solid ${state.tone}`,
        color: TEXT,
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        title={entry.error === undefined ? `打开 ${entry.workspace.path}` : entry.error}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          flex: 1,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: TEXT,
          textAlign: 'left',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, fontWeight: 600 }}>
            {entry.workspace.title || hub?.name || entry.workspace.path}
          </span>
          <Chip tone={state.tone}>{state.label}</Chip>
        </span>
        {projectSummary !== undefined && (
          projectSummary === null
            ? (summaryProblem === undefined || summaryProblem === null
              ? <span className="gp-skeleton" style={{ width: '72%', height: 11 }} />
              : (
                <span
                  data-project-summary-missing
                  title={summaryProblem}
                  style={{
                    fontSize: 11.5,
                    color: 'var(--dsw-alias-label-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  简介暂不可用
                </span>
              ))
            : (
              <span
                data-project-summary
                title={projectSummary}
                style={{
                  fontSize: 11.5,
                  color: 'var(--dsw-alias-label-secondary)',
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  lineHeight: '16px',
                }}
              >
                {projectSummary}
              </span>
            )
        )}
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          {hub === null
            ? <span style={{ fontSize: 11.5, color: MUTED }}>{entry.error ?? '不是 git 仓库'}</span>
            : (
              <>
                <span className="gp-branch-chip" title={hub.root} style={{ height: 20, fontSize: 11 }}>
                  <IconBranch size={10} />
                  {hub.detached ? 'detached' : hub.branch ?? '(no branch)'}
                </span>
                {hub.upstream !== null && (hub.ahead > 0 || hub.behind > 0) && (
                  <Chip title={`上游 ${hub.upstream}`}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: hub.ahead > 0 ? SUCCESS : MUTED }}>
                      <IconArrowUp size={10} />{hub.ahead}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: hub.behind > 0 ? WARN : MUTED }}>
                      <IconArrowDown size={10} />{hub.behind}
                    </span>
                  </Chip>
                )}
              </>
            )}
        </span>
        <span style={{ fontSize: 11.5, color: summary === '' ? MUTED : TEXT, minHeight: 16 }}>
          {summary === '' ? '没有未提交改动' : summary}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.workspace.path}
        </span>
      </button>
      {hub !== null && (
        <RemoteActions repo={hub} compact busy={busy} onRun={onRun} />
      )}
    </div>
  )
}

/** The landing screen: every registered workspace as one card. */
function OverviewScreen({ onOpen, onRun, busyFor, refreshToken }: {
  onOpen: (dir: string) => void
  onRun: RunAction
  busyFor: (dir: string) => ActionName | null
  refreshToken: number
}): ReactNode {
  const [entries, setEntries] = useState<OverviewEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** One-line project summaries by workspace path; undefined while unasked. */
  const [summaries, setSummaries] = useState<Record<string, string | null> | undefined>(undefined)
  /**
   * Why a card still has no line, when the host said the summary call failed.
   * The stored lines arrive in the same answer, so a failed batch explains the
   * cards without a line instead of erasing the ones that already had one.
   */
  const [summaryProblem, setSummaryProblem] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState>('connecting')
  // The stream handler reads the newest entries without re-subscribing on every
  // card update; a stable key keeps the subscription itself from churning.
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true)
    // The summary is one model call for all workspaces; a failure there must
    // not cost the cards their git facts, so it settles on its own.
    if (signal === undefined || !signal.aborted) {
      fetchProjectSummaries()
        .then((answer) => {
          setSummaries(answer.summaries)
          // A partial answer carries the reason the missing lines are missing.
          setSummaryProblem(answer.error ?? null)
        })
        .catch((failure: unknown) => {
          // A failed ask must not erase lines the cards already had: keep the
          // last answer and let the cards without one say why they have none.
          setSummaryProblem(messageOf(failure))
        })
    }
    try {
      setEntries(await fetchOverview(signal))
      setError(null)
    } catch (failure: unknown) {
      if (!isAbort(failure)) setError(messageOf(failure))
    } finally {
      if (signal === undefined || !signal.aborted) setLoading(false)
    }
  }, [])

  /** Re-read one card after its repository changed under us. */
  const refreshCard = useCallback(async (workspace: WorkspaceOption): Promise<void> => {
    try {
      const status = await fetchStatus(workspace.path)
      setEntries(current => current.map(entry => (entry.workspace.id === workspace.id
        ? {
          workspace: entry.workspace,
          repo: status.repo,
          counts: status.counts,
          ...(status.repo === null ? { reason: status.reason ?? 'not-a-repository' } : {}),
        }
        : entry)))
    } catch {
      // Leave the card alone; the next full read reports the failure.
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load, refreshToken])

  // While the stream is open the interval is only a safety net.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, live === 'live' ? OVERVIEW_LIVE_REFRESH_MS : OVERVIEW_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [load, live])

  const rootKey = useMemo(
    () => [...new Set(entries.flatMap(entry => (entry.repo === null ? [] : [entry.repo.root])))].sort().join('\n'),
    [entries],
  )
  useEffect(() => {
    if (rootKey === '') return
    return watchRepos(rootKey.split('\n'), {
      onState: setLive,
      onChange: (change) => {
        for (const entry of entriesRef.current) {
          if (entry.repo?.root === change.dir) void refreshCard(entry.workspace)
        }
      },
    })
  }, [rootKey, refreshCard])

  /** The card filter: a substring against the title and the path. */
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return entries
    return entries.filter(entry =>
      (entry.workspace.title || entry.workspace.path).toLowerCase().includes(needle)
      || entry.workspace.path.toLowerCase().includes(needle))
  }, [entries, filter])
  const sorted = useMemo(
    () => [...filtered].sort((left, right) => {
      const order = cardState(left).rank - cardState(right).rank
      if (order !== 0) return order
      return (left.workspace.title || left.workspace.path).localeCompare(right.workspace.title || right.workspace.path)
    }),
    [filtered],
  )
  const attention = entries.filter(entry => cardState(entry).rank <= 1).length
  /** Repositories a bulk fetch can actually refresh: those with an upstream. */
  const fetchable = useMemo(
    () => entries.filter(entry => entry.repo !== null && entry.repo.upstream !== null),
    [entries],
  )
  const [syncing, setSyncing] = useState<RunProgress | null>(null)

  /** Fetch every repository that has an upstream, one at a time. */
  const syncAll = useCallback(async (): Promise<void> => {
    // The button disables itself while a run is in flight; this is the belt to
    // that pair of braces.
    if (syncing !== null) return
    await runSequentially(
      fetchable,
      // Sequential on purpose: a dozen simultaneous fetches help nobody, and
      // each card shows its own spinner as its turn comes round.
      async entry => { await onRun(entry.workspace.path, entry.workspace.title || entry.workspace.path, 'fetch') },
      setSyncing,
      entry => entry.workspace.title || entry.workspace.path,
    )
  }, [fetchable, onRun, syncing])

  return (
    <div style={{ height: '100%', overflow: 'auto', background: SURFACE, color: TEXT, fontSize: 13 }}>
      <HeaderBar>
        <strong style={{ fontSize: 13 }}>Git 总览</strong>
        {entries.length > 0 && (
          <span style={{ color: MUTED, fontSize: 11 }}>
            {filter.trim() === ''
              ? `${String(entries.length)} 个工作区`
              : `${String(filtered.length)} / ${String(entries.length)} 个工作区`}
            {attention === 0 ? ' · 全部干净' : ` · ${String(attention)} 个有改动`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {entries.length > 0 && (
          <input
            data-overview-filter
            className="gp-input"
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
            placeholder="筛选工作区…"
            title="按名字或路径筛选卡片"
            style={{ width: 150, height: 24, padding: '0 8px', fontSize: 11.5 }}
          />
        )}
        <LiveChip state={live} />
        <ToolbarButton onClick={() => { void syncAll() }} disabled={syncing !== null || fetchable.length === 0} title="对每个有上游的仓库依次执行 git fetch --prune">
          <IconCloudDown size={12} />
          {syncing === null ? `全部 Fetch（${String(fetchable.length)}）` : `Fetch ${String(syncing.done + 1)}/${String(syncing.total)}${syncing.label === undefined ? '' : ` · ${syncing.label}`}…`}
        </ToolbarButton>
        <ToolbarButton onClick={() => { void load() }} disabled={loading} title="重新读取所有工作区">
          <IconRefresh size={12} />
          {loading ? '刷新中…' : '刷新'}
        </ToolbarButton>
      </HeaderBar>

      {error !== null && (
        <div style={{ margin: 16, padding: '8px 12px', borderRadius: 8, border: `1px solid ${ERROR}`, color: ERROR, fontSize: 12 }}>
          {error}
        </div>
      )}

      {error === null && entries.length > 0 && filtered.length === 0 && (
        <div style={{ padding: 24, color: MUTED }}>
          没有名字或路径含「{filter.trim()}」的工作区。<button type="button" data-overview-filter-clear onClick={() => { setFilter('') }} style={{ border: 'none', background: 'none', color: BRAND, cursor: 'pointer', font: 'inherit' }}>清除筛选</button>
        </div>
      )}

      {error === null && entries.length === 0 && (
        <div style={{ padding: 24, color: MUTED }}>
          {loading ? '读取工作区…' : '这个 profile 还没有注册工作区。'}
        </div>
      )}

      {entries.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
            padding: 16,
            alignContent: 'start',
          }}
        >
          {sorted.map(entry => (
            <WorkspaceCard
              key={entry.workspace.id}
              entry={entry}
              projectSummary={summaries === undefined
                // Nothing asked yet: no line at all. Asked and answered with a
                // failure: the card has a reason to show instead of a shimmer.
                ? (summaryProblem === null ? undefined : null)
                : (summaries[entry.workspace.path] ?? null)}
              summaryProblem={summaryProblem}
              busy={busyFor(entry.workspace.path)}
              onOpen={() => { onOpen(entry.workspace.path) }}
              onRun={(action, request) => {
                onRun(entry.workspace.path, entry.workspace.title || entry.workspace.path, action, request)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** How long a diff line may get before it renders folded to one ellipsized row. */
const DIFF_FOLD_THRESHOLD = 120

/** How many diff rows render before the remainder waits behind a button. */
const MAX_DIFF_ROWS = 2_000

/** One line-number gutter cell. */
function Gutter({ line }: { line: number | undefined }): ReactNode {
  return <span style={LINE_NO_STYLE}>{line === undefined ? '' : String(line)}</span>
}

/** One hunk row: line-number gutters, sign, and the text itself. */
function DiffLineRow({ row, inline, expanded, onToggle, colorize }: {
  row: DiffRow
  /** Changed/unchanged runs for this row, when it paired with its rewrite. */
  inline: readonly InlineRun[] | undefined
  expanded: boolean
  onToggle: () => void
  /** Whether syntax tokens are colored on this row. */
  colorize: boolean
}): ReactNode {
  const textRef = useRef<HTMLSpanElement | null>(null)
  // A long line starts folded, and a measurement then decides whether it truly
  // overflows the row. A line that fits keeps its whole text and no chip: the
  // marker must never claim something was hidden when nothing was.
  const long = row.text.length > DIFF_FOLD_THRESHOLD
  const [foldable, setFoldable] = useState(long)
  const folded = foldable && !expanded
  useLayoutEffect(() => {
    if (!folded) return
    const node = textRef.current
    if (node === null) return
    setFoldable(node.scrollWidth > node.clientWidth + 1)
  }, [folded, row.text])
  if (row.kind === 'meta') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '0 10px', lineHeight: '18px', color: MUTED, fontStyle: 'italic' }}>
        <Gutter line={undefined} />
        <Gutter line={undefined} />
        <span style={{ flex: 'none', width: '1em' }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          {row.text === '' ? '\\ 文件末尾没有换行' : `\\ ${row.text}`}
        </span>
      </div>
    )
  }
  const color = rowColor(row.kind)
  const flags = changeFlags(inline, row.text.length)
  const segments = colorize ? overlayChange(tokenizeLine(row.text), flags) : null
  const content: ReactNode = segments !== null
    ? segments.map((segment, index) => (
      <span
        key={index}
        data-token={segment.kind === 'plain' ? undefined : segment.kind}
        style={{
          ...(tokenColor(segment.kind) === undefined ? {} : { color: tokenColor(segment.kind) }),
          ...(segment.changed
            ? { background: `color-mix(in srgb, ${color} 26%, transparent)`, borderRadius: 3, padding: '0 1px' }
            : {}),
        }}
      >
        {segment.text}
      </span>
    ))
    : inline === undefined || inline.length === 0
      ? (row.text === '' ? '\u00a0' : row.text)
      : inline.map((run, index) => (
        run.changed
          ? (
            <span
              key={index}
              style={{ background: `color-mix(in srgb, ${color} 26%, transparent)`, borderRadius: 3, padding: '0 1px' }}
            >
              {run.text}
            </span>
          )
          : <span key={index}>{run.text}</span>
      ))
  return (
    <div
      data-kind={row.kind}
      data-folded={folded ? 'true' : undefined}
      onClick={long ? onToggle : undefined}
      title={folded ? row.text : undefined}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 5,
        padding: '0 10px',
        lineHeight: '18px',
        background: rowTint(row.kind),
        cursor: folded ? 'pointer' : 'default',
      }}
    >
      <Gutter line={row.oldLine} />
      <Gutter line={row.newLine} />
      <span style={{ flex: 'none', width: '1em', textAlign: 'center', fontWeight: 700, color, userSelect: 'none' }}>
        {rowSign(row.kind)}
      </span>
      <span
        ref={textRef}
        data-text=""
        style={{
          flex: 1,
          minWidth: 0,
          color: row.kind === 'context' ? TEXT : color,
          whiteSpace: folded ? 'nowrap' : 'pre-wrap',
          wordBreak: 'break-word',
          overflow: folded ? 'hidden' : undefined,
          textOverflow: folded ? 'ellipsis' : undefined,
        }}
      >
        {content}
      </span>
      {/* Outside the text span on purpose: a clipped row must never eat the
          marker that says it was clipped. */}
      {foldable && (
        <span
          data-fold-marker={folded ? 'folded' : 'expanded'}
          className="gp-mini-btn"
          title={folded ? '展开这一行' : '收起这一行'}
          style={{
            flex: 'none',
            alignSelf: 'center',
            padding: '0 5px',
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            background: LAYER_2,
            color: MUTED,
            fontSize: 10,
            lineHeight: '15px',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {`${String(row.text.length)} 字符`}
        </span>
      )}
    </div>
  )
}

/**
 * One parsed diff: hunks with a chip standing in for the lines git trimmed.
 *
 * A gap is a real, clickable thing: its chip fetches the hidden lines from the
 * host and draws them as ordinary context rows, which is what lets a reader
 * follow a change whose surrounding code git judged unnecessary.
 */
function DiffRows({ parsed, loadGap, colorize }: {
  parsed: ParsedDiff
  /** Read the unchanged lines a gap hides; rejects when the host cannot answer. */
  loadGap?: ((start: number, count: number) => Promise<string[]>) | undefined
  /** Whether syntax tokens are colored. */
  colorize: boolean
}): ReactNode {
  // Long lines fold to one row; the set holds the row keys the user opened.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [everything, setEverything] = useState(false)
  // Gaps the reader opened, by block index, holding the lines that came back.
  const [gaps, setGaps] = useState<ReadonlyMap<number, string[]>>(new Map())
  const [gapBusy, setGapBusy] = useState<ReadonlySet<number>>(new Set())
  const [gapError, setGapError] = useState<ReadonlyMap<number, string>>(new Map())
  // A new diff is a new layout: bump the revision so every row remounts (and
  // re-measures whether it folds) instead of reusing the previous diff's state.
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setOpened(new Set())
    setEverything(false)
    setGaps(new Map())
    setGapBusy(new Set())
    setGapError(new Map())
    setRevision(value => value + 1)
  }, [parsed])

  const toggle = useCallback((key: string): void => {
    setOpened((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const total = parsed.blocks.reduce((sum, block) => sum + (block.kind === 'hunk' ? block.rows.length : 0), 0)
  const cap = everything ? Number.POSITIVE_INFINITY : MAX_DIFF_ROWS
  let rendered = 0

  const openGap = async (blockIndex: number, start: number, count: number): Promise<void> => {
    if (loadGap === undefined || gapBusy.has(blockIndex)) return
    setGapBusy(previous => new Set(previous).add(blockIndex))
    try {
      const lines = await loadGap(start, count)
      setGaps(previous => new Map(previous).set(blockIndex, lines))
      setGapError((previous) => {
        const next = new Map(previous)
        next.delete(blockIndex)
        return next
      })
    } catch (failure: unknown) {
      setGapError(previous => new Map(previous).set(blockIndex, messageOf(failure)))
    } finally {
      setGapBusy((previous) => {
        const next = new Set(previous)
        next.delete(blockIndex)
        return next
      })
    }
  }

  const closeGap = (blockIndex: number): void => {
    setGaps((previous) => {
      const next = new Map(previous)
      next.delete(blockIndex)
      return next
    })
  }

  const parts: ReactNode[] = parsed.blocks.map((block, blockIndex) => {
    if (block.kind === 'gap') {
      const openedLines = gaps.get(blockIndex)
      const busy = gapBusy.has(blockIndex)
      const failure = gapError.get(blockIndex)
      // Both sides must exist for the rows to carry two gutters; the shift is
      // constant across an unchanged stretch, so one subtraction is enough.
      const shift = block.newStart - block.oldStart
      const expandable = loadGap !== undefined && block.newEnd >= block.newStart && block.oldEnd >= block.oldStart
      const chip = (
        <span
          className="gp-mini-btn"
          style={{
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 7px',
            borderRadius: 4,
            border: `1px solid ${BORDER}`,
            background: LAYER_2,
            color: MUTED,
            fontSize: 10.5,
            lineHeight: '17px',
          }}
        >
          {openedLines === undefined
            ? <><IconEllipsis size={11} />{`${String(block.hidden)} 行未显示`}</>
            : <><IconChevronDown size={11} />{`收起 ${String(openedLines.length)} 行`}</>}
        </span>
      )
      if (openedLines !== undefined) {
        return (
          <div key={`gap-${String(blockIndex)}`} data-gap={block.hidden} data-gap-opened="true">
            {openedLines.map((text, index) => (
              <DiffLineRow
                key={`gaprow-${String(blockIndex)}-${String(index)}`}
                row={{
                  kind: 'context',
                  text,
                  oldLine: block.oldStart + index,
                  newLine: block.oldStart + index + shift,
                }}
                inline={undefined}
                expanded={false}
                onToggle={() => {}}
                colorize={colorize}
              />
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', minWidth: 0 }}>
              <button
                type="button"
                data-gap-toggle={block.hidden}
                onClick={() => { closeGap(blockIndex) }}
                style={{ all: 'unset', cursor: 'pointer' }}
                title="收起这一段"
              >
                {chip}
              </button>
            </div>
          </div>
        )
      }
      return (
        <div
          key={`gap-${String(blockIndex)}`}
          data-gap={block.hidden}
          data-gap-note={block.note === '' ? undefined : block.note}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', minWidth: 0 }}
        >
          {expandable
            ? (
              <button
                type="button"
                data-gap-toggle={block.hidden}
                disabled={busy}
                onClick={() => { void openGap(blockIndex, block.newStart, block.newEnd - block.newStart + 1) }}
                style={{ all: 'unset', cursor: busy ? 'progress' : 'pointer' }}
                title={`读取并显示这 ${String(block.hidden)} 行`}
              >
                {busy ? <Chip>读取中…</Chip> : chip}
              </button>
            )
            : chip}
          {failure !== undefined && (
            <span style={{ color: ERROR, fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {failure}
            </span>
          )}
          {/* git's section note names the enclosing scope of the NEXT hunk, so
              it sits beside the chip rather than inside it. */}
          {block.note !== '' && (
            <span
              title={block.note}
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: MUTED, fontSize: 10.5 }}
            >
              {block.note}
            </span>
          )}
        </div>
      )
    }
    const inline = pairInlineRuns(block.rows)
    const rows: ReactNode[] = []
    block.rows.forEach((row, rowIndex) => {
      if (rendered >= cap) return
      rendered += 1
      const rowKey = `${String(revision)}-${String(blockIndex)}-${String(rowIndex)}`
      rows.push(
        <DiffLineRow
          key={rowKey}
          row={row}
          inline={inline.get(rowIndex)}
          expanded={opened.has(rowKey)}
          onToggle={() => { toggle(rowKey) }}
          colorize={colorize}
        />,
      )
    })
    return <div key={`hunk-${String(blockIndex)}`}>{rows}</div>
  })

  return (
    <div data-colorize={colorize ? 'on' : 'off'} style={{ fontFamily: MONO, fontSize: 11, padding: '4px 0 8px' }}>
      {parts}
      {!everything && total > rendered && (
        <button
          type="button"
          onClick={() => { setEverything(true) }}
          style={{
            display: 'block',
            width: 'calc(100% - 20px)',
            margin: '4px 10px',
            padding: 4,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            background: 'transparent',
            color: MUTED,
            font: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {`展开其余 ${String(total - rendered)} 行`}
        </button>
      )}
    </div>
  )
}

/** The unified diff of the selected file. */
/**
 * The blame view for one committed file.
 *
 * Lines are grouped into runs by the commit that last touched them: the run's
 * first line carries the commit's short id, author and date, later lines keep
 * the text column aligned. Attribution reads HEAD, so the header says what is
 * not in it.
 */
function BlameView({ blame, loading, error }: {
  blame: BlamePayload | null
  loading: boolean
  error: string | null
}): ReactNode {
  if (loading) return <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>读取追溯…</div>
  if (error !== null) return <div style={{ padding: 16, color: ERROR, fontSize: 12 }}>{error}</div>
  if (blame === null) return null
  if (blame.lines.length === 0) {
    return <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>这个文件在 HEAD 里没有内容可以追溯。</div>
  }
  const runs: Array<{ hash: string; rows: BlameLine[] }> = []
  for (const line of blame.lines) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.hash === line.hash) last.rows.push(line)
    else runs.push({ hash: line.hash, rows: [line] })
  }
  let runIndex = -1
  return (
    <div data-blame>
      <div style={{ padding: '6px 12px', color: MUTED, fontSize: 11, borderBottom: `1px solid ${BORDER}` }}>
        {`逐行追溯（基于 HEAD，未提交的改动不在其中）· ${String(blame.lines.length)} 行 · ${String(runs.length)} 段`}
        {blame.truncated && ' · 输出被截断'}
      </div>
      {runs.map((run) => {
        runIndex += 1
        const accent = laneColor(runIndex)
        const first = run.rows[0]
        return (
          <div key={`${run.hash}:${String(first.line)}`} style={{ borderLeft: `2px solid ${accent}` }}>
            {run.rows.map((row, index) => (
              <div
                key={row.line}
                data-blame-row
                data-blame-hash={row.hash}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '1px 12px 1px 10px',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  lineHeight: '18px',
                  background: index === 0 ? LAYER_1 : 'transparent',
                }}
              >
                <span style={{ flex: 'none', width: 34, textAlign: 'right', color: MUTED, userSelect: 'none' }}>
                  {row.line}
                </span>
                {index === 0 ? (
                  <span
                    style={{ flex: 'none', width: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={`${row.hash}\n${row.summary}`}
                  >
                    <span style={{ color: accent }}>{row.short}</span>
                    {' '}
                    <span style={{ color: TEXT }}>{row.author}</span>
                    {' '}
                    <span style={{ color: MUTED, fontSize: 10.5 }}>{formatCommitDate(row.time)}</span>
                  </span>
                ) : (
                  <span style={{ flex: 'none', width: 250 }} />
                )}
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: TEXT }}>
                  {row.text}
                </span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function DiffView({ diff, parsed, loading, error, loadGap, colorize }: {
  diff: GitDiff | null
  parsed: ParsedDiff | null
  loading: boolean
  error: string | null
  /** Reads the lines a gap hides, so the chip can open it. */
  loadGap?: ((start: number, count: number) => Promise<string[]>) | undefined
  colorize: boolean
}): ReactNode {
  if (loading) return <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>读取 diff…</div>
  if (error !== null) {
    return <div style={{ padding: 16, color: ERROR, fontSize: 12, fontFamily: MONO }}>{error}</div>
  }
  if (diff === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 220, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
        <IconDiff size={22} />
        选择左侧文件查看 diff
      </div>
    )
  }
  if (diff.kind === 'binary') {
    return <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>二进制文件，无文本 diff：{diff.path}</div>
  }
  if (parsed === null || parsed.empty) {
    return <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>该文件在当前分组下没有差异</div>
  }
  return (
    <div>
      {diff.truncated && (
        <div style={{ padding: '6px 12px', color: WARN, fontSize: 11, borderBottom: `1px solid ${BORDER}` }}>
          diff 超出单次输出上限，以上内容被截断
        </div>
      )}
      <DiffRows parsed={parsed} loadGap={loadGap} colorize={colorize} />
    </div>
  )
}

/** One repository page: facts, actions, work-tree groups, and the selected diff. */
function RepoScreen({ dir, onBack, onRun, busyFor, refreshToken }: {
  dir: string
  onBack: () => void
  onRun: RunAction
  busyFor: (dir: string) => ActionName | null
  refreshToken: number
}): ReactNode {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [stashes, setStashes] = useState<StashList | null>(null)
  const changesSplit = useSplitWidth(280, 0.6)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  /** Checked files, for staging exactly those. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  /** Blame mode for the selected file: attribution replaces the diff. */
  const [blameOn, setBlameOn] = useState(false)
  const [blame, setBlame] = useState<BlamePayload | null>(null)
  const [blameError, setBlameError] = useState<string | null>(null)
  const [blameLoading, setBlameLoading] = useState(false)
  const [live, setLive] = useState<LiveState>('connecting')
  /** Bumped by a live change so the status and the open diff both re-read. */
  const [liveToken, setLiveToken] = useState(0)
  /** Syntax coloring: on by default, one click away from off. */
  const [colorize, setColorize] = useState(true)
  /** What the user typed in the commit box. */
  const [message, setMessage] = useState('')
  /** Which half of the repository page is on screen. */
  const [tab, setTab] = useState<'changes' | 'history' | 'branches'>('changes')
  /** A branch the branch list asked to read: applied by the history view. */
  const [branchPick, setBranchPick] = useState<{ ref: string | null; at: number } | undefined>(undefined)
  /** True while a model is drafting a commit message for this repository. */
  const [drafting, setDrafting] = useState(false)
  /** The provider routes a draft may be pointed at; null until read. */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  /** The picked route, or null to follow the profile's default model. */
  const [choice, setChoice] = useState<ModelChoice | null>(() => readModelChoice())
  /** The message box, so it can grow with what is in it. */
  const messageBox = useRef<HTMLTextAreaElement | null>(null)
  /** What the last draft read, or why it failed; shown under the commit box. */
  const [draftNote, setDraftNote] = useState<string | null>(null)
  /** Whether that note is an error, which colors it. */
  const [draftFailed, setDraftFailed] = useState(false)

  // A commit message is usually a subject plus a few lines: let the box show
  // them instead of scrolling behind a two-line window.
  useLayoutEffect(() => {
    const node = messageBox.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, 220))}px`
  }, [message, tab])

  // The model list is read once per repository page: it is small and cached on
  // the host, and a draft that waited for it would feel broken.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        setCatalog(await fetchModels(controller.signal))
      } catch {
        // A missing catalog only costs the picker: a draft still runs on the
        // profile default, and says what failed if that fails too.
      }
    })()
    return () => { controller.abort() }
  }, [])

  // The host's remembered choice is the one every browser shares; it wins
  // over what this browser stored locally, which only remains as the fallback
  // for a profile with no settings service.
  useEffect(() => {
    if (catalog?.remembered == null) return
    const remembered = catalog.remembered
    setChoice(previous => (previous?.provider === remembered.provider && previous?.model === remembered.model
      ? previous
      : remembered))
    writeModelChoice(remembered)
  }, [catalog])

  // A remembered route that no longer exists falls back to the default, and
  // says so rather than quietly drafting with something else.
  useEffect(() => {
    if (catalog === null || choice === null) return
    const known = catalog.providers.some(group => group.provider === choice.provider
      && group.models.some(model => model.id === choice.model))
    if (!known) {
      setChoice(null)
      writeModelChoice(null)
      setDraftFailed(false)
      setDraftNote(`上次选的模型（${choice.provider} / ${choice.model}）已不在可选列表里，已回到默认模型`)
    }
  }, [catalog, choice])

  /**
   * Ask the model for a commit message and put it in the box.
   *
   * The draft only fills the box: the user reads it, edits it, and decides
   * whether to commit — and whether to push afterwards.
   */
  /** Aborts the in-flight draft, so 停止 also stops the model call. */
  const draftAbort = useRef<AbortController | null>(null)
  const draftMessage = useCallback(async (): Promise<void> => {
    draftAbort.current?.abort()
    const controller = new AbortController()
    draftAbort.current = controller
    setDrafting(true)
    setDraftFailed(false)
    setDraftNote('正在读改动并向模型要一条提交信息…')
    const request = { ...(choice === null ? {} : { provider: choice.provider, model: choice.model }) }
    try {
      let draft
      try {
        draft = await streamCommitMessage(dir, request, {
          onBegin: () => {
            // The box now belongs to the draft: clear it and write as the
            // model writes; the sanitized final replaces it at the end.
            setMessage('')
            setDraftNote('正在写…（Esc 停止）')
          },
          onDelta: (piece) => {
            setMessage(previous => previous + piece)
          },
        }, controller.signal)
      } catch (failure: unknown) {
        // A host from before the stream route answers 404: fall back to the
        // plain draft instead of failing for an upgrade artifact.
        if (failure instanceof Error && failure.name === 'StreamUnavailable') {
          draft = await fetchCommitMessage(dir, request)
        } else {
          throw failure
        }
      }
      setMessage(draft.message)
      // One quiet line by default; a warning only when there is one. The full
      // reading (files, tallies, tokens) stays in the host payload for anyone
      // who cares — the note is a note, not a report.
      const warnings: string[] = []
      if (draft.truncated) warnings.push('diff 有截断，信息可能不完整')
      if (draft.untracked > 0 && draft.source !== 'all') warnings.push(`${String(draft.untracked)} 个未跟踪文件不在本次提交内`)
      const headline = draft.source === 'all'
        ? `${draft.model} 写好了（写的是全部未提交改动）——一键提交即可，也可先全部暂存`
        : `${draft.model} 写好了，可自行改写`
      setDraftNote(warnings.length === 0 ? headline : `${warnings.join(' · ')} · ${headline}`)
    } catch (failure: unknown) {
      setDraftFailed(true)
      setDraftNote(`${controller.signal.aborted || isAbort(failure) ? '已取消' : 'AI 写信息失败'}：${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      if (draftAbort.current === controller) draftAbort.current = null
      setDrafting(false)
    }
  }, [dir, choice])

  const stopDraft = useCallback((): void => {
    draftAbort.current?.abort()
  }, [])

  // Escape while a draft streams stops it — the same gesture as the button.
  useEffect(() => {
    if (!drafting) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') stopDraft()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [drafting, stopDraft])

  // Parsed once here: the pane header shows the tally and the renderer draws rows.
  const parsed = useMemo(
    () => (diff !== null && diff.kind === 'text' ? parseUnifiedDiff(diff.text) : null),
    [diff],
  )

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true)
    try {
      const next = await fetchStatus(dir, signal)
      setStatus(next)
      setError(null)
    } catch (failure: unknown) {
      if (!isAbort(failure)) setError(messageOf(failure))
    } finally {
      if (signal === undefined || !signal.aborted) setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [dir, load, refreshToken, liveToken])

  // A staged file leaves the list, so the checkbox state must follow reality.
  useEffect(() => {
    if (status === null) return
    const present = new Set(status.files.map(file => file.path))
    setChecked(previous => {
      const next = [...previous].filter(path => present.has(path))
      return next.length === previous.size ? previous : new Set(next)
    })
  }, [status])

  // The stash list rides the same refresh triggers as the status, but on its
  // own catch: a host that cannot answer it must not take the file list down.
  useEffect(() => {
    const controller = new AbortController()
    fetchStashes(dir, controller.signal)
      .then((next) => { setStashes(next) })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) setStashes(null)
      })
    return () => { controller.abort() }
  }, [dir, refreshToken, liveToken])

  // While the stream is open the interval is only a safety net.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, live === 'live' ? REPO_LIVE_REFRESH_MS : REPO_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [load, live])

  // The host watches the repository's `.git`; a change there means the branch,
  // the index, or the refs moved, which is exactly when this page is wrong.
  const repoRoot = status?.repo?.root ?? ''
  useEffect(() => {
    if (repoRoot === '') return
    return watchRepos([repoRoot], {
      onState: setLive,
      onChange: () => { setLiveToken(value => value + 1) },
    })
  }, [repoRoot])

  const selectionKey = selection === null ? '' : `${selection.group}:${selection.path}`

  // Another file, another story: blame follows the selection, off by default.
  useEffect(() => {
    setBlameOn(false)
    setBlame(null)
    setBlameError(null)
  }, [selectionKey])

  useEffect(() => {
    if (!blameOn || selection === null) return
    const controller = new AbortController()
    setBlameLoading(true)
    setBlameError(null)
    fetchBlame(dir, selection.path, controller.signal)
      .then((payload) => { setBlame(payload) })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) {
          setBlame(null)
          setBlameError(messageOf(failure))
        }
      })
      .finally(() => { if (!controller.signal.aborted) setBlameLoading(false) })
    return () => { controller.abort() }
  }, [dir, blameOn, selection])

  useEffect(() => {
    if (selection === null) {
      setDiff(null)
      return
    }
    const controller = new AbortController()
    setDiffLoading(true)
    setDiffError(null)
    const target: DiffTarget = { path: selection.path, staged: selection.staged, untracked: selection.untracked }
    void (async () => {
      try {
        const next = await fetchDiff(dir, target, controller.signal)
        if (!controller.signal.aborted) setDiff(next)
      } catch (failure: unknown) {
        if (!isAbort(failure)) {
          setDiff(null)
          setDiffError(messageOf(failure))
        }
      } finally {
        if (!controller.signal.aborted) setDiffLoading(false)
      }
    })()
    return () => { controller.abort() }
    // selectionKey identifies the request; `selection` itself is a fresh object
    // each render, and a remote action or a live change can alter the contents.
  }, [dir, selectionKey, refreshToken, liveToken])

  /**
   * Read the unchanged lines a gap hides. The host decides which revision that
   * is from the diff target, so this only has to name the line range.
   */
  const loadGap = useCallback(async (start: number, count: number): Promise<string[]> => {
    if (selection === null) return []
    const target: DiffTarget = { path: selection.path, staged: selection.staged, untracked: selection.untracked }
    const slice = await fetchContext(dir, target, start, count)
    return slice.lines
  }, [dir, selection])

  const groups = useMemo(() => groupFiles(status?.files ?? []), [status])

  // j/k walk the file list the way the arrow keys walk it: the selection is
  // the open diff, so moving is reading the next file. Space toggles the
  // bulk-staging checkbox of the file under the cursor.
  useEffect(() => {
    if (tab !== 'changes') return
    const flat = groups.flatMap(group => group.files.map(file => ({ group: group.key, path: file.path, staged: group.key === 'staged', untracked: group.key === 'untracked' })))
    if (flat.length === 0) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if ((target?.closest('[data-git-panel]') ?? null) === null) return
      const keys = ['j', 'k', 'ArrowDown', 'ArrowUp', ' ']
      if (!keys.includes(event.key)) return
      const index = selection === null ? -1 : flat.findIndex(item => item.path === selection.path)
      if (event.key === ' ') {
        if (selection === null) return
        const current = flat[index]
        if (current === undefined || current.staged) return
        event.preventDefault()
        setChecked(previous => {
          const next = new Set(previous)
          if (next.has(current.path)) next.delete(current.path)
          else next.add(current.path)
          return next
        })
        return
      }
      event.preventDefault()
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = index === -1 ? (step === 1 ? 0 : flat.length - 1) : (index + step + flat.length) % flat.length
      const next = flat[nextIndex]
      setSelection({ group: next.group as Selection['group'], path: next.path, staged: next.staged, untracked: next.untracked })
      document.querySelector(`[data-file-row="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [tab, groups, selection])
  /** The entry behind the open diff, which is what the file actions act on. */
  const selectedFile = selection === null
    ? undefined
    : status?.files.find(file => file.path === selection.path)

  // A refresh that no longer lists the selected file drops the selection.
  useEffect(() => {
    if (selection === null || status === null) return
    if (!status.files.some(file => file.path === selection.path)) setSelection(null)
  }, [status, selection])

  const repo = status?.repo ?? null
  const counts = status?.counts
  const title = repo?.name ?? dir

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: SURFACE, color: TEXT, fontSize: 13 }}>
      <div className="gp-header">
        {/* Row 1: what this repository is, and what reaches its remote. */}
        <div className="gp-header-row">
          <ToolbarButton small onClick={onBack} title="返回所有项目">
            <IconArrowLeft size={12} />总览
          </ToolbarButton>
          <span className="gp-repo-name">{repo?.name ?? 'Git'}</span>
          {repo !== null && (
            <span className="gp-branch-chip" title={repo.root}>
              <IconBranch size={11} />
              {repo.detached ? `detached @ ${repo.head.slice(0, 7)}` : repo.branch ?? '(no branch)'}
            </span>
          )}
          {repo !== null && (
            repo.upstream === null
              ? <span className="gp-chip" title="当前分支没有上游，无法判断需要 pull / push">无上游</span>
              : (
                <span className="gp-chip" title={`上游 ${repo.upstream}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: repo.ahead > 0 ? SUCCESS : undefined }}>
                    <IconArrowUp size={10} />{repo.ahead}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: repo.behind > 0 ? WARN : undefined }}>
                    <IconArrowDown size={10} />{repo.behind}
                  </span>
                  <span>{repo.upstream}</span>
                </span>
              )
          )}
          <span style={{ flex: 1 }} />
          <LiveChip state={live} />
          <RemoteActions
            repo={repo}
            busy={busyFor(dir)}
            onRun={(action, request) => { onRun(dir, title, action, request) }}
          />
          <ToolbarButton small onClick={() => { void load() }} disabled={loading} title="重新读取仓库状态">
            <IconRefresh size={12} />
            {loading ? '刷新中…' : '刷新'}
          </ToolbarButton>
        </div>
        {/* Row 2: which view of the repository is on screen, plus the actions
            that belong to it. */}
        <div className="gp-header-row" style={{ marginTop: 8, paddingBottom: 10 }}>
          <span className="gp-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'changes'}
              className="gp-tab"
              data-tab-changes
              title="未提交的改动"
              onClick={() => { setTab('changes') }}
            >
              <IconDiff size={12} />变更
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className="gp-tab"
              data-tab-history
              title="提交历史"
              onClick={() => { setTab('history') }}
            >
              <IconHistory size={12} />历史
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'branches'}
              className="gp-tab"
              data-tab-branches
              title="本地分支与它们相对上游的位置"
              onClick={() => { setTab('branches') }}
            >
              <IconBranch size={12} />分支
            </button>
          </span>
          {counts !== undefined && tab === 'changes' && (
            <span style={{ color: MUTED, fontSize: 11.5 }}>
              {counts.conflicted > 0 && <span style={{ color: ERROR }}>{counts.conflicted} 冲突 · </span>}
              {counts.staged} 已暂存 · {counts.changed} 变更 · {counts.untracked} 未跟踪
            </span>
          )}
          <span style={{ flex: 1 }} />
          {tab === 'changes' && (
            /* Stashing is local and destructive, so it asks first — and says
               what it takes with it. */
            <ConfirmButton
              small
              marker="stash"
              label={<><IconArchive size={12} />贮藏</>}
              armedLabel="确认贮藏（含未跟踪）"
              title="git stash push --include-untracked：把当前改动（含未跟踪文件）收进 stash，工作区回到干净状态"
              armedTitle="再点一次即执行 git stash push --include-untracked"
              disabled={busyFor(dir) !== null || repo === null || (status?.counts.changed === 0 && status?.counts.staged === 0 && status?.counts.untracked === 0)}
              onConfirm={() => { void onRun(dir, title, 'stash', { confirm: true, includeUntracked: true }) }}
            />
          )}
        </div>
      </div>

      {error !== null && (
        <div style={{ margin: 16, padding: '8px 12px', borderRadius: 8, border: `1px solid ${ERROR}`, color: ERROR, fontSize: 12 }}>
          {error}
        </div>
      )}

      {repo !== null && tab === 'changes' && status?.operation != null && (
        <OperationBanner
          operation={status.operation}
          busy={busyFor(dir)}
          onRun={(action, request) => { void onRun(dir, title, action, request) }}
        />
      )}

      {error === null && status !== null && repo === null && (
        <div style={{ padding: 24, color: MUTED }}>
          不是 git 仓库：<span style={{ fontFamily: MONO }}>{dir}</span>
        </div>
      )}

      {repo !== null && tab === 'history' && (
        <HistoryView
          dir={dir}
          colorize={colorize}
          onToggleColorize={() => { setColorize(value => !value) }}
          refreshToken={refreshToken + liveToken}
          {...(branchPick === undefined ? {} : { requestedRef: branchPick })}
        />
      )}

      {repo !== null && tab === 'branches' && (
        <BranchesView
          dir={dir}
          refreshToken={refreshToken + liveToken}
          busy={busyFor(dir)}
          onRun={(action, request) => { void onRun(dir, title, action, request) }}
          onPick={(ref) => {
            setBranchPick({ ref, at: Date.now() })
            setTab('history')
          }}
        />
      )}

      {repo !== null && tab === 'changes' && (
        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <div
            data-split-list
            className="gp-split-list"
            style={{
              width: changesSplit.width === null ? 'clamp(320px, 27vw, 460px)' : changesSplit.width,
              flex: changesSplit.width === null ? '0 0 clamp(320px, 27vw, 460px)' : `0 0 ${String(changesSplit.width)}px`,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Committing is the one write whose content the user authors, so
                it gets a box of its own: `git add` then `git commit -m`. The
                box is flat on the column and pinned; only the list scrolls. */}
            <div data-commit-box className="gp-commit">
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 0 10px' }}>
<select
                  data-ai-model
                  className="gp-select"
                  value={choice === null ? '' : choiceValue(choice.provider, choice.model)}
                  onChange={event => {
                    const next = parseChoiceValue(event.target.value)
                    setChoice(next)
                    // localStorage stays as the fallback mirror; the host
                    // decides whether it can persist for every browser.
                    writeModelChoice(next)
                    void savePrefs(next)
                  }}
                  title={choice === null
                    ? `写提交信息用哪个模型（当前跟随默认${catalog?.default === null || catalog?.default === undefined ? '' : `：${catalog.default.model}`}）；选择会记住，跨浏览器生效`
                    : `写提交信息用 ${choice.provider} / ${choice.model}；选择会记住，跨浏览器生效`}
                  style={{
                    maxWidth: 130,
                    height: 22,
                    color: 'var(--dsw-alias-label-tertiary)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '2px 2px',
                    fontSize: 11,
                    outline: 'none',
                    background: 'transparent',
                  }}
                >
                  <option value="">
                    {catalog?.default === null || catalog?.default === undefined
                      ? '默认模型'
                      : catalog.default.model}
                  </option>
                  {(catalog?.providers ?? []).map(group => (
                    <optgroup
                      key={group.provider}
                      label={group.error === undefined ? group.providerName : `${group.providerName}（读取失败）`}
                    >
                      {group.models.map(model => (
                        <option key={`${group.provider}/${model.id}`} value={choiceValue(group.provider, model.id)}>
                          {model.name === model.id ? model.id : model.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 10.5 }}>
                  {`已暂存 ${String(status?.counts.staged ?? 0)} 项`}
                </span>
              </div>
              <textarea
                data-commit-message
                className="gp-textarea"
                ref={messageBox}
                value={message}
                rows={3}
                placeholder="提交信息（提交已暂存的改动）"
                onChange={event => { setMessage(event.target.value) }}
                onKeyDown={event => {
                  // The standard shortcut of every commit box: Ctrl/Cmd+Enter
                  // commits what the primary button would commit.
                  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
                  event.preventDefault()
                  const text = message.trim()
                  if (text === '' || busyFor(dir) !== null) return
                  const staged = status?.counts.staged ?? 0
                  const dirty = (status?.counts.changed ?? 0) + (status?.counts.untracked ?? 0)
                  if (staged === 0 && dirty === 0) return
                  void (async () => {
                    if (await onRun(dir, title, 'commit', staged === 0 ? { message: text, paths: ['.'] } : { message: text })) setMessage('')
                  })()
                }}
                style={{
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 56,
                  maxHeight: 220,
                  padding: '8px 10px 0',
                  fontSize: 13,
                  lineHeight: '19px',
                }}
              />
              {/* One row: the actions on the left, the draft model as a quiet
                  chip on the right; the staged count is the caption above the
                  box, so nothing here is dead weight. */}
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 6, padding: '8px 10px 2px' }}>
                <ToolbarButton
                  small
                  primary
                  marker="commit"
                  disabled={busyFor(dir) !== null || message.trim() === '' || (status?.counts.staged ?? 0) === 0}
                  title={message.trim() === '' ? '先写提交信息（Ctrl+Enter 提交）' : (status?.counts.staged ?? 0) === 0 ? '还没有暂存的改动：先「全部暂存」或逐文件暂存（Ctrl+Enter 会连暂存一起）' : 'git commit -m：提交已暂存的改动（Ctrl+Enter 直接提交）'}
                  onClick={() => {
                    const text = message.trim()
                    if (text === '') return
                    void (async () => {
                      // Keep the text when git refuses the commit, so a failing
                      // hook does not cost the user their message.
                      if (await onRun(dir, title, 'commit', { message: text })) setMessage('')
                    })()
                  }}
                >
                  <IconCommit size={11} />
                  {busyFor(dir) === 'commit' ? '提交中…' : (status?.counts.staged ?? 0) > 0 ? `提交（${String(status?.counts.staged)}）` : '提交'}
                </ToolbarButton>
                {/* A message written for the whole work tree still needs the
                    index filled before `git commit` can run. This is that step
                    and the commit in one click; pushing stays manual. */}
                {(status?.counts.staged ?? 0) === 0
                  && (status?.counts.changed ?? 0) + (status?.counts.untracked ?? 0) > 0 && (
                  <ToolbarButton
                    small
                    marker="commit-all"
                    disabled={busyFor(dir) !== null || message.trim() === ''}
                    title={message.trim() === ''
                      ? '先写提交信息：这条会把全部改动一起提交'
                      : 'git add -- . 然后 git commit -m：把所有改动（含未跟踪文件）一起提交；推送仍由你点（Ctrl+Enter 同效）'}
                    onClick={() => {
                      const text = message.trim()
                      if (text === '') return
                      void (async () => {
                        if (await onRun(dir, title, 'commit', { message: text, paths: ['.'] })) setMessage('')
                      })()
                    }}
                  >
                    <IconPlus size={11} /><IconCommit size={11} />
                    {busyFor(dir) === 'commit' ? '提交中…' : '一键提交'}
                  </ToolbarButton>
                )}
                {drafting ? (
                  <ToolbarButton
                    small
                    marker="ai-stop"
                    title="停止生成（同时中止模型调用，已写出的部分保留在输入框里）"
                    onClick={stopDraft}
                  >
                    <IconCross size={12} />
                    停止
                  </ToolbarButton>
                ) : (
                  <ToolbarButton
                    small
                    marker="ai-message"
                    disabled={busyFor(dir) !== null}
                    title={draftNote ?? `读当前改动，让 ${choice === null ? '默认模型' : `${choice.provider} / ${choice.model}`} 写一条中文提交信息（只填入输入框，提交与推送仍由你点）`}
                    onClick={() => { void draftMessage() }}
                  >
                    <IconSpark size={12} />
                    AI 写信息
                  </ToolbarButton>
                )}
                <ToolbarButton
                  small
                  marker="stage-all"
                  disabled={busyFor(dir) !== null || (status?.counts.changed === 0 && status?.counts.untracked === 0)}
                  title="git add -- .：把所有改动（含未跟踪文件）放进暂存区"
                  onClick={() => { void onRun(dir, title, 'stage', { paths: ['.'] }) }}
                >
                  <IconPlus size={11} />
                  {busyFor(dir) === 'stage' ? '暂存中…' : '全部暂存'}
                </ToolbarButton>
              </div>
              {/* The model lives on the quiet context row above, not the action
                  row: the buttons stay one clean line at any width. */}

              {draftNote !== null && (
                <div
                  data-ai-note
                  style={{ marginTop: 5, color: draftFailed ? ERROR : MUTED, fontSize: 10.5, lineHeight: '15px' }}
                >
                  {draftNote}
                </div>
              )}
            </div>
            {/* The list scrolls; the commit box above stays pinned. */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {checked.size > 0 && (
              <div
                data-bulk-bar
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderTop: `1px solid ${BORDER}`,
                  borderBottom: `1px solid ${BORDER}`,
                  background: LAYER_1,
                  fontSize: 11.5,
                }}
              >
                <span>{`已选 ${String(checked.size)} 项`}</span>
                <ToolbarButton
                  small
                  marker="stage-selected"
                  disabled={busyFor(dir) !== null}
                  title={`git add -- ${[...checked].slice(0, 3).join(' ')}${checked.size > 3 ? ' …' : ''}：只暂存勾选的文件`}
                  onClick={() => {
                    void (async () => {
                      if (await onRun(dir, title, 'stage', { paths: [...checked] })) setChecked(new Set())
                    })()
                  }}
                >
                  <IconPlus size={11} />暂存选中
                </ToolbarButton>
                <ToolbarButton small marker="clear-checked" title="取消全部勾选" onClick={() => { setChecked(new Set()) }}>
                  <IconCross size={11} />清除
                </ToolbarButton>
              </div>
            )}
            {groups.length === 0 && <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>工作区干净，没有未提交改动。</div>}
            {status?.truncated === true && (
              <div style={{ padding: '8px 12px', color: WARN, fontSize: 11 }}>文件过多，status 输出被截断</div>
            )}
            {groups.map(group => (
              <div key={group.key}>
                <div
                  className="gp-group-head"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 12px',
                    color: MUTED,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    background: LAYER_1,
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  {group.title}
                  <span>({group.files.length})</span>
                </div>
                {group.files.map(file => {
                  const letter = statusLetter(file, group.key)
                  const tally = countsLabel(group.key === 'staged' ? file.staged : group.key === 'untracked' ? null : file.unstaged)
                  const selected = selection !== null && selection.group === group.key && selection.path === file.path
                  return (
                    <button
                      key={`${group.key}:${file.path}`}
                      type="button"
                      className="gp-row"
                      data-file-row={file.path}
                      aria-current={selected}
                      onClick={() => {
                        setSelection({
                          group: group.key,
                          path: file.path,
                          staged: group.key === 'staged',
                          untracked: group.key === 'untracked',
                        })
                      }}
                      title={file.originalPath === undefined ? file.path : `${file.originalPath} → ${file.path}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '4px 12px',
                        border: 'none',
                        borderLeft: `2px solid ${selected ? BRAND : 'transparent'}`,
                        color: TEXT,
                        fontSize: 12,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      {(group.key === 'changes' || group.key === 'untracked' || group.key === 'conflicted') && (
                        <input
                          type="checkbox"
                          data-select-file={file.path}
                          checked={checked.has(file.path)}
                          onClick={(event) => { event.stopPropagation() }}
                          onChange={() => {
                            setChecked(previous => {
                              const next = new Set(previous)
                              if (next.has(file.path)) next.delete(file.path)
                              else next.add(file.path)
                              return next
                            })
                          }}
                          title="勾选以批量暂存"
                          style={{ margin: 0, accentColor: BRAND, flex: 'none' }}
                        />
                      )}
                      <span style={{ width: 10, color: letterColor(letter), fontFamily: MONO, fontWeight: 600 }}>{letter}</span>
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          direction: 'rtl',
                          textAlign: 'left',
                          fontFamily: MONO,
                          fontSize: 11.5,
                        }}
                      >
                        {file.path}
                      </span>
                      {tally !== null && (
                        <span style={{ fontSize: 11, fontFamily: MONO, whiteSpace: 'nowrap' }}>
                          {tally.binary
                            ? <span style={{ color: MUTED }}>bin</span>
                            : (
                              <>
                                <span style={{ color: SUCCESS }}>+{tally.added}</span>
                                {' '}
                                <span style={{ color: ERROR }}>−{tally.deleted}</span>
                              </>
                            )}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
            {stashes !== null && stashes.stashes.length > 0 && (
              <div data-stashes>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    color: MUTED,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    background: LAYER_1,
                    borderTop: `1px solid ${BORDER}`,
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  <IconArchive size={11} />
                  贮藏
                  <span>({stashes.stashes.length})</span>
                  <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
                    应用保留条目 · 弹出成功后移除条目
                  </span>
                </div>
                {stashes.stashes.map(entry => (
                  <div
                    key={entry.ref}
                    data-stash-row={entry.ref}
                    className="gp-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 12px',
                      borderBottom: `1px solid ${BORDER}`,
                      fontSize: 12,
                      color: TEXT,
                    }}
                  >
                    <span
                      title={`${entry.ref} · ${entry.subject}`}
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      <span style={{ fontFamily: MONO, fontSize: 11, color: MUTED }}>{entry.ref}</span>
                      {' '}
                      {entry.subject}
                    </span>
                    <span style={{ flex: 'none', fontSize: 10.5, color: MUTED }}>{formatCommitDate(entry.date)}</span>
                    <span style={{ flex: 'none', display: 'inline-flex', gap: 4 }}>
                      <ToolbarButton
                        small
                        marker="stash-apply"
                        disabled={busyFor(dir) !== null}
                        title={`git stash apply ${entry.ref}：把这份贮藏应用回工作区，条目保留`}
                        onClick={() => { void onRun(dir, title, 'stashApply', { ref: entry.ref }) }}
                      >
                        应用
                      </ToolbarButton>
                      <ToolbarButton
                        small
                        marker="stash-pop"
                        disabled={busyFor(dir) !== null}
                        title={`git stash pop ${entry.ref}：应用回工作区；应用干净后条目随之移除，有冲突时条目保留`}
                        onClick={() => { void onRun(dir, title, 'stashPop', { ref: entry.ref }) }}
                      >
                        弹出
                      </ToolbarButton>
                      <ConfirmButton
                        small
                        marker="stash-drop"
                        label="删除"
                        armedLabel="确认删除"
                        title={`git stash drop ${entry.ref}：丢弃这份贮藏，不可恢复`}
                        armedTitle="再点一次即丢弃这份贮藏"
                        disabled={busyFor(dir) !== null}
                        onConfirm={() => { void onRun(dir, title, 'stashDrop', { ref: entry.ref, confirm: true }) }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>
          <SplitHandle split={changesSplit} />
          <div data-pane="diff" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
            {selection !== null && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: `1px solid ${BORDER}`,
                  background: LAYER_1,
                  fontSize: 11,
                  color: MUTED,
                  fontFamily: MONO,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selection.path}</span>
                <Chip>{selection.untracked ? 'untracked' : selection.staged ? 'staged' : 'worktree'}</Chip>
                {parsed?.combined === true && (
                  <Chip tone={WARN} title="冲突文件的合并 diff：每行有两列前缀（两个父提交各一列），所以没有单一的旧侧行号">
                    合并冲突
                  </Chip>
                )}
                {selectedFile !== undefined && (
                  <span style={{ display: 'inline-flex', gap: 5 }}>
                    {(selectedFile.untracked || selectedFile.worktree !== '.') && (
                      <ToolbarButton
                        small
                        marker="stage-file"
                        disabled={busyFor(dir) !== null}
                        title={`git add -- ${selection.path}`}
                        onClick={() => { void onRun(dir, title, 'stage', { paths: [selection.path] }) }}
                      >
                        <IconPlus size={11} />
                        {busyFor(dir) === 'stage' ? '暂存中…' : '暂存'}
                      </ToolbarButton>
                    )}
                    {!selectedFile.untracked && selectedFile.index !== '.' && (
                      <ToolbarButton
                        small
                        marker="unstage-file"
                        disabled={busyFor(dir) !== null}
                        title={`git reset -q HEAD -- ${selection.path}`}
                        onClick={() => { void onRun(dir, title, 'unstage', { paths: [selection.path] }) }}
                      >
                        <IconMinus size={11} />
                        {busyFor(dir) === 'unstage' ? '取消中…' : '取消暂存'}
                      </ToolbarButton>
                    )}
                    {/* Never offered for an untracked file: the host has no
                        action for deleting one, on purpose. */}
                    {!selectedFile.untracked && selectedFile.worktree !== '.' && (
                      <ConfirmButton
                        small
                        marker="discard-file"
                        label={<><IconUndo size={11} />还原</>}
                        armedLabel="确认还原"
                        title={`git checkout -- ${selection.path}：丢弃这个文件工作区里的改动（已暂存的部分保留）`}
                        armedTitle="再点一次即丢弃工作区改动"
                        disabled={busyFor(dir) !== null}
                        onConfirm={() => { void onRun(dir, title, 'discard', { paths: [selection.path], confirm: true }) }}
                      />
                    )}
                  </span>
                )}
                <ToolbarButton
                  small
                  marker="blame-toggle"
                  tone={blameOn ? BRAND : undefined}
                  disabled={selection.untracked}
                  title={selection.untracked
                    ? '未跟踪文件还没有提交，无处追溯'
                    : blameOn
                      ? '回到 diff'
                      : `git blame HEAD -- ${selection.path}：逐行看谁最后动过（基于 HEAD，未提交改动不在其中）`}
                  onClick={() => { setBlameOn(value => !value) }}
                >
                  <IconHistory size={11} />
                  {blameOn ? '看 diff' : '追溯'}
                </ToolbarButton>
                {!blameOn && (
                  <ColorizeToggle on={colorize} onToggle={() => { setColorize(value => !value) }} />
                )}
                {parsed !== null && !parsed.empty && !blameOn && (
                  <span style={{ marginLeft: 'auto', flex: 'none', display: 'inline-flex', gap: 5 }}>
                    <span style={{ color: SUCCESS }}>+{parsed.added}</span>
                    <span style={{ color: ERROR }}>−{parsed.deleted}</span>
                  </span>
                )}
              </div>
            )}
            {blameOn ? (
              <BlameView blame={blame} loading={blameLoading} error={blameError} />
            ) : (
              <DiffView
                diff={diff}
                parsed={parsed}
                loading={diffLoading}
                error={diffError}
                loadGap={loadGap}
                colorize={colorize}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** The status letter a commit's file list shows, in the diff's own colors. */
function commitStatusLabel(file: CommitFile): string {
  switch (file.status) {
    case 'A': return '新增'
    case 'D': return '删除'
    case 'R': return '重命名'
    case 'C': return '复制'
    case 'T': return '类型变更'
    default: return '修改'
  }
}

/** `2026-09-29T22:12:23+08:00` → `09-29 22:12`, which is all a commit row needs. */
/**
 * Which day group a commit belongs to: the separators that give a long flat
 * history its rhythm. Computed from the calendar day, not the hour count.
 */
export function historyDayLabel(iso: string, now: Date = new Date()): '今天' | '昨天' | '最近 7 天' | '更早' {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '更早'
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days <= 7) return '最近 7 天'
  return '更早'
}

/**
 * A commit date the way a reader actually thinks about it: relative while it
 * is recent, absolute once it is old. The full timestamp stays in the tooltip.
 */
export function formatCommitDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const ageMs = Date.now() - at.getTime()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const absolute = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (ageMs < 0) return absolute
  if (ageMs < 60_000) return '刚刚'
  if (ageMs < 3_600_000) return `${String(Math.floor(ageMs / 60_000))} 分钟前`
  if (ageMs < 86_400_000) return `${String(Math.floor(ageMs / 3_600_000))} 小时前`
  if (ageMs < 30 * 86_400_000) return `${String(Math.floor(ageMs / 86_400_000))} 天前`
  return absolute
}

/**
 * A repository's history: the commits on the left, the selected commit's files
 * and diff on the right.
 *
 * The diff goes through exactly the same renderer, parser and gap reader as the
 * work-tree view — the only difference is that `hash` travels with the target,
 * so the host reads the file from that commit instead of from the checkout.
 */
/** How many commits one page of history reads. */
const HISTORY_PAGE = 50

/** How tall one row of the graph is; the list and the lanes share it. */
const GRAPH_ROW_HEIGHT = 42

/** Pixels between two lanes of the graph. */
const GRAPH_LANE_WIDTH = 12

/**
 * The lanes' colours.
 *
 * Every one is a theme token or a mix of two, so the graph holds up in the
 * light theme and in the dark one without a second palette to maintain.
 */
const LANE_COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'color-mix(in srgb, var(--dsw-alias-brand-primary) 58%, var(--dsw-alias-state-success-primary))',
  'color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, var(--dsw-alias-state-warn-primary))',
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-state-warn-primary))',
]

/** The colour of one lane, wrapping so long histories stay distinguishable. */
function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] ?? BRAND
}

/**
 * The graph column for one row: the lines through this row and its node.
 *
 * It draws exactly what {@link buildGraph} decided — half-lines for the lanes
 * that are open above and below, a curve for every edge, and the node on the
 * commit's own lane — so the picture cannot drift from the layout the tests
 * assert.
 */
function GraphCell({ row, active }: { row: GraphRow; active: boolean }): ReactNode {
  const width = 14 + Math.max(1, row.width) * GRAPH_LANE_WIDTH
  const mid = GRAPH_ROW_HEIGHT / 2
  const x = (lane: number): number => 7 + lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
  const arriving = (lane: number): boolean => row.edges.some(edge => edge.to === lane)
  return (
    <svg
      data-graph-row={row.lane}
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${String(width)} ${String(GRAPH_ROW_HEIGHT)}`}
      fill="none"
      aria-hidden="true"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {row.incoming.map(lane => (
        <line key={`in-${String(lane)}`} x1={x(lane)} y1={0} x2={x(lane)} y2={mid} stroke={laneColor(lane)} strokeWidth={1.5} />
      ))}
      {row.edges.map((edge, index) => (
        <path
          key={`edge-${String(index)}`}
          d={edge.from === edge.to
            ? `M ${String(x(edge.from))} ${String(mid)} L ${String(x(edge.to))} ${String(GRAPH_ROW_HEIGHT)}`
            : `M ${String(x(edge.from))} ${String(mid)} C ${String(x(edge.from))} ${String(mid + 8)}, ${String(x(edge.to))} ${String(GRAPH_ROW_HEIGHT - 8)}, ${String(x(edge.to))} ${String(GRAPH_ROW_HEIGHT)}`}
          stroke={laneColor(edge.from)}
          strokeWidth={1.5}
        />
      ))}
      {/* A lane that was already open above keeps going below; a lane that only
          starts here is drawn by the curve that arrives in it. */}
      {row.outgoing.map(lane => (row.incoming.includes(lane) || !arriving(lane) ? (
        <line key={`out-${String(lane)}`} x1={x(lane)} y1={mid} x2={x(lane)} y2={GRAPH_ROW_HEIGHT} stroke={laneColor(lane)} strokeWidth={1.5} />
      ) : null))}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={active ? 4.2 : 3.4}
        fill={row.root ? SURFACE : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={1.6}
      />
    </svg>
  )
}

/** A ref decoration: HEAD and tags read loud, remotes stay quiet. */
function RefBadge({ name }: { name: string }): ReactNode {
  const tone = name.startsWith('HEAD') ? BRAND : name.startsWith('tag:') ? SUCCESS : MUTED
  return <Chip tone={tone}>{name}</Chip>
}

/** Which history the view is reading. */
interface HistoryQuery {
  /** Read every ref instead of one branch's own history. */
  all: boolean
  /** The branch to read; null follows the checked-out branch. */
  ref: string | null
  /** Only commits that touched this path. */
  path: string | null
  /** Only commits whose author matches this text. */
  author: string
  /** Only commits whose message matches this text. */
  grep: string
}

/** The query with nothing filtered out. */
const HISTORY_DEFAULT: HistoryQuery = { all: false, ref: null, path: null, author: '', grep: '' }

/**
 * The history screen: a lane graph of commits on the left, the selected
 * commit's files and diff on the right.
 *
 * Everything it reads is read-only — the branch list can be viewed but not
 * checked out, and no filter touches the repository — so a reader can explore
 * history without the panel ever writing to the work tree.
 */
function HistoryView({ dir, colorize, onToggleColorize, refreshToken, requestedRef }: {
  dir: string
  colorize: boolean
  onToggleColorize: () => void
  refreshToken: number
  /** A branch picked elsewhere in the panel, applied when it changes. */
  requestedRef?: { ref: string | null; at: number }
}): ReactNode {
  const [log, setLog] = useState<CommitLog | null>(null)
  const [older, setOlder] = useState<CommitEntry[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [branches, setBranches] = useState<BranchList | null>(null)
  const [query, setQuery] = useState<HistoryQuery>(HISTORY_DEFAULT)
  /** What is typed, before it becomes a query. */
  const [authorText, setAuthorText] = useState('')
  const [grepText, setGrepText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hash, setHash] = useState<string | null>(null)
  const historySplit = useSplitWidth(300, 0.6)
  const [shown, setShown] = useState<CommitShow | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  /** Which parent of a merge commit the detail pane reads against. */
  const [parent, setParent] = useState(1)
  /** Range-compare mode: the older commit the selected one is read against. */
  const [compareBase, setCompareBase] = useState<CommitEntry | null>(null)
  const [compareArmed, setCompareArmed] = useState(false)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // A branch picked in the branch list becomes this view's scope.
  useEffect(() => {
    if (requestedRef === undefined) return
    setQuery(previous => ({ ...previous, all: false, ref: requestedRef.ref }))
  }, [requestedRef])

  // Another commit means another set of parents: start from the first again.
  useEffect(() => {
    setParent(1)
    setCompareArmed(false)
  }, [hash])

  // Typing is not a query: wait for a pause, so one word is one request.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(previous => (previous.author === authorText ? previous : { ...previous, author: authorText.trim() }))
    }, 300)
    return () => { window.clearTimeout(timer) }
  }, [authorText])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(previous => (previous.grep === grepText ? previous : { ...previous, grep: grepText.trim() }))
    }, 300)
    return () => { window.clearTimeout(timer) }
  }, [grepText])

  const firstPage = useMemo(() => ({
    limit: HISTORY_PAGE,
    skip: 0,
    all: query.all,
    ...(query.ref === null ? {} : { ref: query.ref }),
    ...(query.path === null ? {} : { path: query.path }),
    ...(query.author === '' ? {} : { author: query.author }),
    ...(query.grep === '' ? {} : { grep: query.grep }),
  }), [query])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetchLog(dir, firstPage, controller.signal)
      .then((payload) => {
        setLog(payload)
        setOlder([])
        setError(null)
        setExhausted(payload.commits.length < payload.limit)
        // Keep the open commit when it is still listed, so a refresh or a new
        // filter does not yank the reader somewhere else.
        setHash(previous => (previous !== null && payload.commits.some(commit => commit.hash === previous)
          ? previous
          : payload.commits[0]?.hash ?? null))
      })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) setError(messageOf(failure))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [dir, refreshToken, firstPage])

  useEffect(() => {
    const controller = new AbortController()
    fetchBranches(dir, controller.signal)
      .then((payload) => { setBranches(payload) })
      .catch(() => {
        // Without the branch list the scope selector falls back to the current
        // branch and "every ref"; the history itself still works.
      })
    return () => { controller.abort() }
  }, [dir, refreshToken])

  const commits = useMemo(() => [...(log?.commits ?? []), ...older], [log, older])
  const graph = useMemo(() => buildGraph(commits.map(commit => ({ short: commit.short, parents: commit.parents }))), [commits])

  // j/k walk the history the way the changes list walks: the selection is the
  // open commit. Compare-armed rows still become the base when clicked, so the
  // keys do not.
  useEffect(() => {
    if (commits.length === 0) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if ((target?.closest('[data-history]') ?? null) === null) return
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1
      const index = hash === null ? -1 : commits.findIndex(commit => commit.hash === hash)
      const nextIndex = index === -1 ? (step === 1 ? 0 : commits.length - 1) : (index + step + commits.length) % commits.length
      const next = commits[nextIndex]
      setHash(next.hash)
      document.querySelector(`[data-commit-row="${next.short}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [commits, hash])

  const loadMore = useCallback((): void => {
    if (loadingMore || exhausted || log === null) return
    setLoadingMore(true)
    fetchLog(dir, { ...firstPage, skip: commits.length })
      .then((payload) => {
        setOlder(previous => [...previous, ...payload.commits])
        setExhausted(payload.commits.length < payload.limit)
      })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) setError(messageOf(failure))
      })
      .finally(() => { setLoadingMore(false) })
  }, [dir, firstPage, commits.length, exhausted, loadingMore, log])

  // Older history loads when the list is scrolled to its end, and the button
  // below stays for a keyboard, or for a short list that never scrolls.
  useEffect(() => {
    const node = sentinel.current
    if (node === null || exhausted) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) loadMore()
    }, { rootMargin: '160px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [exhausted, loadMore])

  useEffect(() => {
    if (hash === null) {
      setShown(null)
      setPath(null)
      return
    }
    const controller = new AbortController()
    // `git show` prints nothing for a merge, so the first parent is the useful
    // default there; the pane offers the others. A compare base turns the same
    // read into "what changed between these two commits".
    fetchShow(dir, hash, controller.signal, compareBase === null ? parent : undefined, compareBase?.hash)
      .then((payload) => {
        setShown(payload)
        setPath(payload.files[0]?.path ?? null)
      })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) setError(messageOf(failure))
      })
    return () => { controller.abort() }
  }, [dir, hash, refreshToken, parent, compareBase])

  useEffect(() => {
    if (hash === null || path === null) {
      setDiff(null)
      return
    }
    const controller = new AbortController()
    setDiffLoading(true)
    setDiffError(null)
    fetchDiff(dir, {
      path,
      staged: false,
      untracked: false,
      hash,
      ...(compareBase === null ? { parent } : { base: compareBase.hash }),
    }, controller.signal)
      .then((payload) => { setDiff(payload) })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return
        setDiff(null)
        setDiffError(messageOf(failure))
      })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false) })
    return () => { controller.abort() }
  }, [dir, hash, path, refreshToken, parent, compareBase])

  const parsed = useMemo(() => (diff?.kind === 'text' ? parseUnifiedDiff(diff.text) : null), [diff])
  const loadGap = useCallback(async (start: number, count: number): Promise<string[]> => {
    if (hash === null || path === null) return []
    // The gap sits inside the new side of the diff, which for a merge is the
    // file as the merge commit has it: that blob does not depend on the parent
    // being compared against.
    const slice = await fetchContext(dir, { path, staged: false, untracked: false, hash }, start, count)
    return slice.lines
  }, [dir, hash, path, parent])

  const selected = shown?.commit ?? null
  const scoped = branches?.branches ?? []
  // The current branch has its own option, so picking it from the branch list
  // (which does name it) still shows the "current branch" choice.
  const scopeValue = query.all
    ? '\u0000all'
    : query.ref === null || query.ref === branches?.current
      ? ''
      : query.ref
  const filtering = query.path !== null || query.author !== '' || query.grep !== ''

  return (
    <div data-history style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Which history: a branch, every ref, and the three filters that are one
          request each. All of it read-only. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, background: LAYER_1 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: MUTED }}>
          <IconBranch size={12} />
          <select
            data-history-scope
            value={scopeValue}
            onChange={(event) => {
              const value = event.target.value
              setQuery(previous => value === '\u0000all'
                ? { ...previous, all: true, ref: null }
                : { ...previous, all: false, ref: value === '' ? null : value })
            }}
            title="读哪个分支的历史：当前分支、某个分支，或所有 ref（含远端与标签）"
            className="gp-select"
            style={{ height: 24, padding: '0 4px', fontSize: 11.5 }}
          >
            <option value="">{`当前分支${branches?.current === null || branches?.current === undefined ? '' : `（${branches.current}）`}`}</option>
            <option value={'\u0000all'}>所有 ref（含远端与标签）</option>
            {scoped.filter(branch => !branch.current).map(branch => (
              <option key={branch.name} value={branch.name}>{branch.name}</option>
            ))}
          </select>
        </label>
        <input
          data-history-author
          className="gp-input"
          value={authorText}
          onChange={(event) => { setAuthorText(event.target.value) }}
          placeholder="作者"
          title="只列出作者匹配的提交（git log --author）"
          style={{ width: 96, height: 24, padding: '0 8px', fontSize: 11.5 }}
        />
        <input
          data-history-grep
          className="gp-input"
          value={grepText}
          onChange={(event) => { setGrepText(event.target.value) }}
          placeholder="提交信息"
          title="只列出提交信息匹配的提交，忽略大小写（git log --grep）"
          style={{ width: 128, height: 24, padding: '0 8px', fontSize: 11.5 }}
        />
        {query.path !== null && (
          <span data-history-path style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Chip tone={BRAND}>{`仅 ${query.path}`}</Chip>
            <ToolbarButton small marker="history-path-clear" title="去掉路径过滤" onClick={() => { setQuery(previous => ({ ...previous, path: null })) }}>
              <IconCross size={10} />清除
            </ToolbarButton>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: MUTED }}>
          {loading ? '读取中…' : `${String(commits.length)} 条${exhausted ? '（已到最初）' : '，可继续向前加载'}`}
        </span>
        {filtering && (
          <ToolbarButton small marker="history-reset" title="清掉全部过滤，回到当前分支的全部历史" onClick={() => {
            setAuthorText('')
            setGrepText('')
            setQuery(HISTORY_DEFAULT)
          }}>
            <IconRefresh size={11} />重置
          </ToolbarButton>
        )}
      </div>

      {error !== null && <div style={{ padding: '8px 12px', color: ERROR, fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minHeight: 0 }}>
        <div
          data-split-list
          className="gp-split-list"
          style={{
            width: historySplit.width === null ? 400 : historySplit.width,
            flex: historySplit.width === null ? '0 0 400px' : `0 0 ${String(historySplit.width)}px`,
            overflow: 'auto',
          }}
        >
          {loading && commits.length === 0 && (
            <div data-history-skeleton style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[0, 1, 2, 3, 4].map(index => (
                <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="gp-skeleton" style={{ width: 12, height: 12, borderRadius: 6, flex: 'none' }} />
                  <span className="gp-skeleton" style={{ width: `${String(58 + (index % 3) * 12)}%` }} />
                </div>
              ))}
            </div>
          )}
          {!loading && commits.length === 0 && (
            <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>
              {log?.repo === null ? '不是 git 仓库。' : filtering ? '这个过滤条件下没有提交。' : '这个仓库还没有提交。'}
            </div>
          )}
          {compareArmed && (
            <div style={{ padding: '6px 12px', color: WARN, fontSize: 11, borderBottom: `1px solid ${BORDER}` }}>
              点选另一个提交作为对比基准
            </div>
          )}
          <div data-graph style={{ display: 'flex', flexDirection: 'column' }}>
            {commits.map((commit, index) => {
              const active = commit.hash === hash
              const row = graph[index]
              // The rhythm of a long history: a separator wherever the day
              // bucket changes, with the open lanes drawn through it.
              const day = historyDayLabel(commit.date)
              const previousDay = index === 0 ? null : historyDayLabel(commits[index - 1].date)
              const separator = day !== previousDay && (
                <div
                  key={`sep:${day}:${commit.short}`}
                  data-graph-sep
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 10px 5px 2px',
                    borderBottom: `1px solid ${BORDER}`,
                    background: LAYER_1,
                    color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                  }}
                >
                  {row !== undefined && (
                    <svg
                      width={14 + Math.max(1, row.width) * GRAPH_LANE_WIDTH}
                      height={12}
                      style={{ display: 'block', flex: 'none' }}
                      aria-hidden="true"
                    >
                      {row.incoming.map(lane => (
                        <line
                          key={lane}
                          x1={7 + lane * GRAPH_LANE_WIDTH}
                          y1={0}
                          x2={7 + lane * GRAPH_LANE_WIDTH}
                          y2={12}
                          stroke={laneColor(lane)}
                          strokeWidth={1.2}
                          opacity={0.45}
                        />
                      ))}
                    </svg>
                  )}
                  {day}
                </div>
              )
              return (
                <span key={`wrap:${commit.hash}`} style={{ display: 'contents' }}>
                  {separator}
                <button
                  key={commit.hash}
                  type="button"
                  className="gp-commit-row"
                  aria-current={active}
                  data-commit-row={commit.short}
                  onClick={() => {
                    if (compareArmed && commit.hash !== hash) {
                      setCompareBase(commit)
                      setCompareArmed(false)
                      return
                    }
                    setHash(commit.hash)
                  }}
                  title={`${commit.hash}\n${commit.author}\n${commit.date}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    height: GRAPH_ROW_HEIGHT,
                    padding: '0 10px 0 2px',
                    border: 'none',
                    borderLeft: `2px solid ${active ? BRAND : 'transparent'}`,
                    borderBottom: `1px solid ${BORDER}`,
                    color: TEXT,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  {row !== undefined && <GraphCell row={row} active={active} />}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    {/* Tier 1: the subject is what the eye scans for. */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {commit.parents.length > 1 && (
                        <span title={`合并提交 · ${String(commit.parents.length)} 个父提交`} style={{ display: 'inline-flex', flex: 'none', color: WARN }}>
                          <IconBranch size={11} />
                        </span>
                      )}
                      <span data-commit-subject style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: 500, color: TEXT }}>
                        {commit.subject}
                      </span>
                    </span>
                    {/* Tier 2: everything about it, one quiet line. */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: MONO, flex: 'none' }}>{commit.short}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 'none', maxWidth: 110 }}>{commit.author}</span>
                      <span style={{ flex: 'none' }}>{formatCommitDate(commit.date)}</span>
                      {commit.refs.slice(0, 2).map(ref => <RefBadge key={ref} name={ref} />)}
                    </span>
                  </span>
                </button>
                </span>
              )
            })}
          </div>
          <div ref={sentinel} style={{ height: 1 }} />
          {!exhausted && commits.length > 0 && (
            <div style={{ padding: '6px 12px 12px' }}>
              <ToolbarButton small marker="history-more" title="再读一页更早的提交（也可以滚到底自动加载）" onClick={loadMore}>
                <IconChevronDown size={11} />{loadingMore ? '加载中…' : '加载更早的提交'}
              </ToolbarButton>
            </div>
          )}
        </div>

        <SplitHandle split={historySplit} />
        <div data-pane="history-diff" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {selected !== null && (
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, background: LAYER_1, fontSize: 11, color: MUTED }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: MONO, color: BRAND }}>{selected.short}</span>
                <span style={{ color: TEXT, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.subject}</span>
                <span style={{ flex: 1 }} />
                {compareBase === null ? (
                  <ToolbarButton
                    small
                    marker="compare"
                    tone={compareArmed ? WARN : undefined}
                    title={compareArmed ? '在左侧点另一个提交作为基准（再点这里取消）' : '把这个提交与更早的任意提交对比（git diff <基准> <这个提交>）'}
                    onClick={() => { setCompareArmed(value => !value) }}
                  >
                    <IconDiff size={11} />
                    {compareArmed ? '取消对比' : '对比…'}
                  </ToolbarButton>
                ) : (
                  <Chip tone={BRAND} title={`git diff ${compareBase.short} ${selected.short}：两个提交之间的全部改动`}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {`${compareBase.short}..${selected.short}`}
                      <button
                        type="button"
                        data-compare-clear
                        onClick={() => { setCompareBase(null) }}
                        title="退出范围对比"
                        style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, display: 'inline-flex' }}
                      >
                        <IconCross size={10} />
                      </button>
                    </span>
                  </Chip>
                )}
                <ColorizeToggle on={colorize} onToggle={onToggleColorize} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                <span>{selected.author}</span>
                <span>{formatCommitDate(selected.date)}</span>
                <span style={{ fontFamily: MONO }}>{selected.hash.slice(0, 12)}</span>
                {selected.refs.map(ref => <RefBadge key={ref} name={ref} />)}
                {compareBase === null && selected.parents.length > 1 && (
                  <>
                    <Chip tone={WARN}>{`合并提交 · ${String(selected.parents.length)} 个父提交`}</Chip>
                    {/* A merge has one diff per parent and none by default, so
                        the reader picks the side to look at. */}
                    <span data-parent-picker style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span>对比</span>
                      {selected.parents.map((_parent, index) => {
                        const number = index + 1
                        const active = number === parent
                        return (
                          <button
                            key={number}
                            type="button"
                            data-parent={String(number)}
                            onClick={() => { setParent(number) }}
                            title={`与第 ${String(number)} 个父提交比较（git diff ${selected.short}^${String(number)} ${selected.short}）`}
                            style={{
                              padding: '1px 6px',
                              borderRadius: 6,
                              border: `1px solid ${active ? BRAND : BORDER}`,
                              background: active ? LAYER_1 : 'transparent',
                              color: active ? BRAND : MUTED,
                              fontFamily: MONO,
                              fontSize: 10.5,
                              cursor: 'pointer',
                            }}
                          >
                            {`^${String(number)}`}
                          </button>
                        )
                      })}
                    </span>
                  </>
                )}
              </div>
              {shown !== null && shown.files.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
                  {shown.files.map((file) => {
                    const active = file.path === path
                    return (
                      <span key={`${file.status}:${file.path}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <button
                          type="button"
                          data-commit-file={file.path}
                          onClick={() => { setPath(file.path) }}
                          title={`${commitStatusLabel(file)} ${file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '2px 7px',
                            borderRadius: 6,
                            border: `1px solid ${active ? BRAND : BORDER}`,
                            background: active ? LAYER_2 : 'transparent',
                            color: TEXT,
                            fontFamily: MONO,
                            fontSize: 10.5,
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ color: letterColor(file.status) }}>{file.status}</span>
                          <span>{file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`}</span>
                          {!file.binary && (
                            <span>
                              <span style={{ color: SUCCESS }}>+{file.added}</span>
                              {' '}
                              <span style={{ color: ERROR }}>−{file.deleted}</span>
                            </span>
                          )}
                        </button>
                        {/* File history: the same view, narrowed to one path. */}
                        <button
                          type="button"
                          data-file-history={file.path}
                          onClick={() => { setQuery(previous => ({ ...previous, path: file.path })) }}
                          title={`只看 ${file.path} 的历史（git log -- ${file.path}）`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '2px 5px',
                            borderRadius: 6,
                            border: `1px solid ${BORDER}`,
                            background: 'transparent',
                            color: MUTED,
                            cursor: 'pointer',
                          }}
                        >
                          <IconHistory size={11} />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {shown !== null && shown.files.length === 0 && selected !== null && (
            <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>
              {selected.parents.length > 1
                ? `与第 ${String(parent)} 个父提交相比没有改动。`
                : '这个提交没有文件改动（空提交或合并提交）。'}
            </div>
          )}
          <DiffView
            diff={diff}
            parsed={parsed}
            loading={diffLoading}
            error={diffError}
            loadGap={loadGap}
            colorize={colorize}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The branch list.
 *
 * Read-only on purpose: it says which branch HEAD is on, where each one stands
 * against its upstream, and offers to *look* at any of them. Checking a branch
 * out writes to the work tree, so it is not offered here.
 */
function BranchesView({ dir, refreshToken, busy, onRun, onPick }: {
  dir: string
  refreshToken: number
  busy: string | null
  onRun: (action: 'checkout', request: { ref: string; confirm: boolean; create?: boolean }) => void
  /** Read this branch's history: the caller switches to the history view. */
  onPick: (ref: string | null) => void
}): ReactNode {
  const [list, setList] = useState<BranchList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [newBranch, setNewBranch] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetchBranches(dir, controller.signal)
      .then((payload) => { setList(payload); setError(null) })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(messageOf(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [dir, refreshToken])

  const branches = list?.branches ?? []
  return (
    <div data-branches style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, background: LAYER_1, fontSize: 11, color: MUTED, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>
          {loading
            ? '读取分支…'
            : `${String(branches.length)} 个本地分支${list?.current === null || list?.current === undefined ? '（HEAD 处于游离状态）' : `，当前在 ${list.current}`}`}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            data-branch-new
            className="gp-input"
            value={newBranch}
            onChange={(event) => { setNewBranch(event.target.value) }}
            placeholder="新分支名"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && newBranch.trim() !== '' && busy === null) {
                onRun('checkout', { ref: newBranch.trim(), confirm: true, create: true })
                setNewBranch('')
              }
            }}
            style={{
              width: 130,
              padding: '3px 8px',
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: SURFACE,
              color: TEXT,
              fontSize: 11.5,
              fontFamily: MONO,
            }}
          />
          <ToolbarButton
            small
            marker="branch-create"
            disabled={busy !== null || newBranch.trim() === ''}
            title={`git checkout -b ${newBranch.trim() === '' ? '<名字>' : newBranch.trim()}：从当前检出新建分支并切换过去`}
            onClick={() => {
              onRun('checkout', { ref: newBranch.trim(), confirm: true, create: true })
              setNewBranch('')
            }}
          >
            <IconPlus size={11} />新建并切换
          </ToolbarButton>
        </span>
      </div>
      {error !== null && <div style={{ padding: '8px 12px', color: ERROR, fontSize: 12 }}>{error}</div>}
      {!loading && branches.length === 0 && error === null && (
        <div style={{ padding: 16, color: MUTED, fontSize: 12 }}>
          {list?.repo === null ? '不是 git 仓库。' : '还没有分支：仓库的第一个提交之后才会出现。'}
        </div>
      )}
      {branches.map(branch => (
        <div
          key={branch.name}
          data-branch-row={branch.name}
          className="gp-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px',
            borderBottom: `1px solid ${BORDER}`,
            background: branch.current ? LAYER_1 : 'transparent',
          }}
        >
          <IconBranch size={13} />
          <span style={{ fontFamily: MONO, fontSize: 12, color: branch.current ? BRAND : TEXT }}>{branch.name}</span>
          {branch.current && <Chip tone={BRAND}>HEAD</Chip>}
          {branch.upstream === null
            ? <Chip>无上游</Chip>
            : (
              <Chip tone={branch.track === null ? undefined : /behind [1-9]/.test(branch.track) ? WARN : undefined}>
                {`${branch.upstream}${branch.track === null ? '' : ` ${branch.track}`}`}
              </Chip>
            )}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: MUTED }}>
            {branch.subject}
          </span>
          <span style={{ fontSize: 10.5, color: MUTED, fontFamily: MONO }}>{branch.short}</span>
          <span style={{ fontSize: 10.5, color: MUTED }}>{formatCommitDate(branch.date)}</span>
          <ToolbarButton small marker="branch-history" title={`看 ${branch.name} 的历史`} onClick={() => { onPick(branch.name) }}>
            <IconHistory size={11} />看历史
          </ToolbarButton>
          {!branch.current && (
            <ConfirmButton
              small
              marker="branch-checkout"
              label="切换"
              armedLabel="确认切换"
              title={`git checkout ${branch.name}：切换工作区到这条分支（会被覆盖的本地改动会被 git 拦下并点名）`}
              armedTitle={`再点一次即切换到 ${branch.name}`}
              disabled={busy !== null}
              onConfirm={() => { onRun('checkout', { ref: branch.name, confirm: true }) }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/** One line of the operation log. */
function LogRow({ entry }: { entry: LogEntry }): ReactNode {
  const raw = entry.steps ?? [{
    command: entry.command,
    exitCode: entry.exitCode,
    succeeded: entry.succeeded,
    output: entry.output,
  }]
  const steps = raw.map(step => {
    const lines = step.output === '' ? [] : step.output.replace(/\n$/, '').split('\n')
    return { ...step, lines, shown: lines.slice(-LOG_LINES) }
  })
  return (
    <div style={{ padding: '6px 0', borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 11 }}>
        <span style={{ display: 'inline-flex', color: entry.succeeded ? SUCCESS : ERROR, fontWeight: 600 }}>
          {entry.succeeded ? <IconCheck size={12} /> : <IconCross size={12} />}
        </span>
        <span style={{ color: MUTED, fontFamily: MONO }}>{formatTime(entry.at)}</span>
        <span style={{ fontFamily: MONO }}>{entry.action}</span>
        <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{entry.title}</span>
        {entry.exitCode !== null && <Chip tone={entry.succeeded ? SUCCESS : ERROR}>exit {entry.exitCode}</Chip>}
        <span style={{ color: MUTED }}>{(entry.durationMs / 1000).toFixed(1)}s</span>
        {entry.truncated && <Chip tone={WARN}>输出被截断</Chip>}
      </div>
      {steps.map((step, index) => (
        <div key={index}>
          <div style={{ fontFamily: MONO, fontSize: 11, color: MUTED, marginTop: 2 }}>
            {`$ ${step.command.join(' ')}`}
            {steps.length > 1 && (
              <span style={{ color: step.succeeded ? SUCCESS : ERROR }}>{`  · exit ${String(step.exitCode ?? '—')}`}</span>
            )}
          </div>
          {step.lines.length > 0 && (
            <pre
              style={{
                margin: '4px 0 0',
                fontFamily: MONO,
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                color: TEXT,
                background: LAYER_2,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                padding: '6px 8px',
                maxHeight: 120,
                overflow: 'auto',
              }}
            >
              {step.lines.length > LOG_LINES ? `…（仅显示最后 ${LOG_LINES} 行）\n` : ''}
              {step.shown.join('\n')}
            </pre>
          )}
        </div>
      ))}
      {entry.error !== undefined && (
        <div style={{ color: ERROR, fontSize: 11, marginTop: 2 }}>{entry.error}</div>
      )}
    </div>
  )
}

/** The session's operation log, collapsed to one line until inspected. */
function ActionLog({ entries, open, onToggle }: {
  entries: LogEntry[]
  open: boolean
  onToggle: (next: boolean) => void
}): ReactNode {
  if (entries.length === 0) return null
  const latest = entries[0] as LogEntry
  return (
    <details
      open={open}
      onToggle={event => { onToggle((event.currentTarget as HTMLDetailsElement).open) }}
      style={{ flex: '0 0 auto', borderTop: `1px solid ${BORDER}`, background: LAYER_1 }}
    >
      <summary style={{ cursor: 'pointer', padding: '7px 14px', fontSize: 11, color: MUTED, userSelect: 'none' }}>
        操作日志（{entries.length}）
        <span style={{ color: latest.succeeded ? SUCCESS : ERROR }}>
          {' · 最近：'}
          {latest.action}
          {latest.succeeded ? ' 成功' : ' 失败'}
        </span>
        <span style={{ color: MUTED }}>{` · ${latest.title}`}</span>
      </summary>
      <div style={{ overflow: 'auto', maxHeight: 200, padding: '0 14px 10px' }}>
        {entries.map(entry => <LogRow key={entry.id} entry={entry} />)}
      </div>
    </details>
  )
}

/** The page the left rail's Git entry opens. */
export function GitPanelPage(): ReactNode {
  // The design system is one stylesheet: hover, focus rings and transitions
  // cannot be inline styles, and the panel ships its own.
  useEffect(() => {
    ensurePanelStyles()
    return () => { removePanelStyles() }
  }, [])
  const [screen, setScreen] = useState<Screen>({ kind: 'overview' })
  const [log, setLog] = useState<LogEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [busy, setBusy] = useState<string[]>([])
  const [refreshToken, setRefreshToken] = useState(0)
  const nextId = useRef(0)

  const appendLog = useCallback((entry: Omit<LogEntry, 'id' | 'at'>): void => {
    nextId.current += 1
    const record: LogEntry = { ...entry, id: nextId.current, at: Date.now() }
    setLog(previous => [record, ...previous].slice(0, LOG_MAX))
  }, [])

  const perform = useCallback<RunAction>(async (dir, title, action, request) => {
    const key = `${dir}:${action}`
    setBusy(previous => [...previous, key])
    try {
      const result = await runAction(dir, action, request)
      appendLog({
        dir,
        title,
        action,
        succeeded: result.succeeded,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        output: result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim(),
        truncated: result.truncated,
        steps: result.steps.map(step => ({
          command: step.command,
          exitCode: step.exitCode,
          succeeded: step.succeeded,
          output: step.stderr.trim() === '' ? step.stdout.trim() : step.stderr.trim(),
        })),
      })
      if (!result.succeeded) setLogOpen(true)
      return result.succeeded
    } catch (failure: unknown) {
      appendLog({
        dir,
        title,
        action,
        succeeded: false,
        exitCode: null,
        durationMs: 0,
        command: ['git', action],
        output: '',
        truncated: false,
        error: messageOf(failure),
      })
      setLogOpen(true)
      return false
    } finally {
      setBusy(previous => previous.filter(item => item !== key))
      // Whatever happened, the reading on screen is now stale.
      setRefreshToken(token => token + 1)
    }
  }, [appendLog])

  const busyFor = useCallback((dir: string): ActionName | null => {
    const prefix = `${dir}:`
    const hit = busy.find(item => item.startsWith(prefix))
    return hit === undefined ? null : hit.slice(prefix.length) as ActionName
  }, [busy])

  return (
    <div data-git-panel style={{ height: '100%', display: 'flex', flexDirection: 'column', background: SURFACE, color: TEXT }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        {screen.kind === 'repo'
          ? (
            <RepoScreen
              dir={screen.dir}
              onBack={() => { setScreen({ kind: 'overview' }) }}
              onRun={perform}
              busyFor={busyFor}
              refreshToken={refreshToken}
            />
          )
          : (
            <OverviewScreen
              onOpen={dir => { setScreen({ kind: 'repo', dir }) }}
              onRun={perform}
              busyFor={busyFor}
              refreshToken={refreshToken}
            />
          )}
      </div>
      <ActionLog entries={log} open={logOpen} onToggle={setLogOpen} />
    </div>
  )
}
