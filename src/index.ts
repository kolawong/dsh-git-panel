/**
 * @dsh-external/dsh-git-panel — host half.
 *
 * Git inspection for the browser Git panel: the repository enclosing a
 * registered workspace, its branch/upstream/ahead-behind facts, its work-tree
 * entries, one file's unified diff, and the one-glance tally of every
 * registered workspace the overview grid draws — plus the three remote actions
 * the panel offers (`fetch --prune`, `pull --ff-only`, `push`).
 *
 * Security and lifecycle rules this half owns:
 * - Every client-supplied directory is validated against `workspaceRegistry`
 *   before any git command runs, so the browser can never address a directory
 *   the profile has not registered.
 * - git is spawned through the host subprocess service as an argv array (never
 *   a shell), with a scrubbed non-interactive environment, a per-command
 *   deadline, and a bounded stdout cap.
 * - A non-zero exit is a result, not an exception; only transport failures
 *   (timeout, abort) throw.
 * - This plugin never stages, commits, stashes, resets, or force-pushes. Its
 *   three write actions are exactly the ones the panel labels, and only one
 *   action per repository may run at a time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { devNull, homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin name; the profile entry and the client bundle use the same spelling. */
export const name = '@dsh-external/dsh-git-panel'

/** Services this plugin cannot work without. */
export const inject = ['webServer', 'subprocess', 'workspaceRegistry']

/** Plugin configuration. */
export interface Config {
  /** Deadline for one read-only git command, in milliseconds. */
  timeoutMs: number
  /** Deadline for one fetch/pull/push, in milliseconds (network work is slower). */
  actionTimeoutMs: number
  /** In-memory stdout cap for one git command, in bytes. */
  outputMaxBytes: number
  /** Bytes of each stream an action result hands back to the panel. */
  actionOutputMaxBytes: number
  /** Unified-diff context lines. */
  contextLines: number
  /** How many workspaces the overview inspects at once. */
  overviewConcurrency: number
  /** Whether `push` may run at all; false still leaves fetch and pull available. */
  allowPush: boolean
  /** Whether repositories may be watched for live updates over the event stream. */
  watchEnabled: boolean
  /** Whether `pull` refreshes remote refs with `fetch --prune` before fast-forwarding. */
  fetchBeforePull: boolean
  /** Whether stage/unstage/discard/stash/commit may run at all. */
  allowRepoWrites: boolean
  /** Whether the panel may ask a model to draft a commit message. */
  aiCommitEnabled: boolean
  /** Provider used for the draft; empty follows the default model selection. */
  aiCommitProvider: string
  /** Model used for the draft; empty follows the default model selection. */
  aiCommitModel: string
  /**
   * Reasoning effort the panel's model calls ask for, as the route spells it
   * (`off`, `low`, `medium`, `high`, `max`, …); empty follows whatever the
   * model/route does on its own. A model that *requires* thinking (MiniMax's
   * `MiniMax-M3.1-Flash-Preview`, for one) refuses a request that disables it,
   * and this is how a deployment says "ask this route to think".
   */
  aiCommitReasoningEffort: string
  /** Language the draft must be written in. */
  aiCommitLanguage: string
  /** Diff lines one draft may read, before the request is trimmed. */
  aiCommitMaxDiffLines: number
  /** Diff bytes one draft may read, before the request is trimmed. */
  aiCommitMaxDiffBytes: number
  /** Deadline for one draft, in milliseconds. */
  aiCommitTimeoutMs: number
  /** Extra instruction appended to the draft's system prompt. */
  aiCommitExtraPrompt: string
}

export const Config = z.object({
  timeoutMs: z.natural().min(1_000).max(120_000).default(20_000),
  actionTimeoutMs: z.natural().min(1_000).max(600_000).default(60_000),
  outputMaxBytes: z.natural().min(65_536).max(67_108_864).default(4_194_304),
  actionOutputMaxBytes: z.natural().min(4_096).max(1_048_576).default(32_768),
  contextLines: z.natural().min(0).max(50).default(3),
  overviewConcurrency: z.natural().min(1).max(16).default(4),
  allowPush: z.boolean().default(true),
  watchEnabled: z.boolean().default(true),
  fetchBeforePull: z.boolean().default(true),
  allowRepoWrites: z.boolean().default(true),
  aiCommitEnabled: z.boolean().default(true),
  // Volatile: the panel's model picker writes these through the settings
  // service, so the remembered choice is live profile configuration instead
  // of browser storage. Everything else stays mount-time configuration.
  aiCommitProvider: z.string().default('').volatile(),
  aiCommitModel: z.string().default('').volatile(),
  aiCommitReasoningEffort: z.string().default('').volatile(),
  aiCommitLanguage: z.string().default('zh'),
  aiCommitMaxDiffLines: z.natural().min(20).max(20_000).default(1_200),
  aiCommitMaxDiffBytes: z.natural().min(4_096).max(1_048_576).default(65_536),
  aiCommitTimeoutMs: z.natural().min(1_000).max(300_000).default(60_000),
  aiCommitExtraPrompt: z.string().default(''),
})

/** The signals one project summary is written from. */
export interface ProjectSignal {
  /** 1-based position, which the answer echoes back. */
  index: number
  title: string
  /** package.json's description field, when there is one. */
  description: string | null
  /** The README's first lines, trimmed. */
  readme: string | null
  /** The last few commit subjects. */
  commits: string[]
}

/**
 * One batch prompt for every workspace at once.
 *
 * A dozen projects should cost one model call, not a dozen: the signals are
 * compact, and numbered output maps answers back without any JSON to break.
 */
export function buildSummaryPrompt(repos: readonly ProjectSignal[], language: string): string {
  const lines = repos.map(repo => {
    const parts = [`${String(repo.index)}. 项目「${repo.title}」`]
    if (repo.description !== null) parts.push(`package.json 描述：${repo.description}`)
    if (repo.readme !== null) parts.push(`README 开头：${repo.readme.replace(/\n+/g, ' / ')}`)
    if (repo.commits.length > 0) parts.push(`最近的提交：${repo.commits.join('；')}`)
    return parts.join('\n   ')
  })
  return [
    `给下面每个项目写一句话${language}简介（不超过 40 字，说明这个项目是做什么的，像写给同事看的注释，不要引号、不要项目编号以外的任何前缀）。`,
    '严格按编号逐行回答，每行就是「编号. 一句话」，不要任何额外内容：',
    '',
    ...lines,
  ].join('\n')
}

/**
 * Read the numbered lines back. A model that adds decoration loses those
 * lines, not the whole answer: only clean `N. text` rows are kept.
 */
export function parseSummaryLines(text: string, count: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: count }, () => null)
  for (const raw of text.split('\n')) {
    const match = /^\s*(\d{1,2})\s*[.、]\s*(.+?)\s*$/.exec(raw)
    if (match === null) continue
    const index = Number(match[1])
    if (index < 1 || index > count) continue
    const cleaned = match[2].replace(/^[「"“']+|[」"”']+$/g, '').trim()
    if (cleaned !== '') out[index - 1] = cleaned.slice(0, 80)
  }
  return out
}

/** Route prefix this plugin owns. */
const ROUTE_PREFIX = '/api/git-panel'

/** Custom header a write request must carry; a cross-origin form cannot set it. */
const ACTION_HEADER = 'x-dsh-git-panel'

/** Largest accepted request body, in bytes. */
const ACTION_BODY_MAX_BYTES = 8 * 1024

/** Retained stderr tail for diagnostics. */
const STDERR_MAX_BYTES = 16 * 1024

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000

/**
 * Git's own bookkeeping churns on every fetch and pull; none of it changes what
 * the panel shows, and forwarding it would turn one fetch into a refresh storm.
 */
const WATCH_NOISE = /^(?:objects\/|.*\.lock$|gc\.|maintenance|COMMIT_EDITMSG$|tmp_)/

/** Coalescing window for filesystem events, in milliseconds. */
const WATCH_DEBOUNCE_MS = 300

/** Comment-only keep-alive on an idle event stream, in milliseconds. */
const EVENT_HEARTBEAT_MS = 25_000

/** Ceiling on how many repositories one stream may watch. */
const MAX_WATCHED_DIRS = 64

/** Ceiling on how many unchanged lines one context request may ask for. */
const MAX_CONTEXT_LINES = 400

/** Environment that keeps git non-interactive and independent of ambient config. */
const GIT_ENV = {
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
} as const

/** One settled git command; a non-zero exit code is a normal result. */
interface GitFacts {
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when stdout hit the in-memory cap and lost its head. */
  truncated: boolean
}

/** The slice of the host subprocess service this plugin uses. */
interface SubprocessFace {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal?: AbortSignal | undefined
    env?: NodeJS.ProcessEnv | undefined
  }): {
    collected: {
      stdout?: { readFrom(fromByte: number): { text: string; lossy: boolean } }
      stderr?: { readFrom(fromByte: number): { text: string; lossy: boolean } }
    }
    done: Promise<{ exitCode: number | null }>
  }
}

/** The slice of the profile workspace registry this plugin uses. */
interface WorkspaceRegistryFace {
  list(): readonly { id: string; title: string; path: string }[]
}

/** The slice of the host web-server service this plugin uses. */
interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The host services this plugin resolved at load time. */
interface HostFaces {
  webServer: WebServerFace
  subprocess: SubprocessFace
  workspaceRegistry: WorkspaceRegistryFace
}

/** One work-tree entry as `git status --porcelain=v2` reports it. */
interface RawEntry {
  path: string
  /** Index (staged) status character, `.` when unchanged. */
  index: string
  /** Work-tree status character, `.` when unchanged. */
  worktree: string
  originalPath?: string
  untracked?: boolean
  unmerged?: boolean
}

/** Parsed `--branch` header facts plus the work-tree entries. */
interface StatusFacts {
  head: string
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  entries: RawEntry[]
}

/** What `/log` answers, and what the `gitPanel` service returns. */
interface LogPayload {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  commits: CommitEntry[]
  truncated: boolean
  /** The page size this call used, so a client can page without guessing. */
  limit: number
  /** How many commits this call skipped. */
  skip: number
}

/** How much history to read, of which ref, and with which filters. */
interface LogQuery {
  /** Commits to read this call (1..200). */
  limit: number
  /** Commits to jump over, for paging older history. */
  skip: number
  /** The ref whose history to read; the current branch when omitted. */
  ref?: string
  /** Read every ref instead of one ref's own history. */
  all: boolean
  /** Only commits that touched this path. */
  path?: string
  /** Only commits whose author matches this text. */
  author?: string
  /** Only commits whose message matches this text, case-insensitively. */
  grep?: string
}

/** One local branch, as `/branches` reports it. */
interface BranchEntry {
  name: string
  /** The branch tip, abbreviated. */
  short: string
  /** True for the branch HEAD points at. */
  current: boolean
  /** The upstream in short form, when one is configured. */
  upstream: string | null
  /** `[ahead 1, behind 2]`, `[gone]`, or null when there is no upstream. */
  track: string | null
  /** ISO-8601 committer date of the tip. */
  date: string
  subject: string
}

/** One stash entry, as `git stash list` reports it. */
interface StashEntry {
  /** The reflog name, e.g. `stash@{0}`; the only token the stash actions accept. */
  ref: string
  /** Full commit id of the stash. */
  hash: string
  /** Abbreviated commit id. */
  short: string
  /** ISO-8601 committer date. */
  date: string
  /** The reflog subject: the stash message, or `WIP on <branch>: …`. */
  subject: string
}

/** One line of a blame: who last touched it, and the line itself. */
interface BlameLine {
  /** 1-based line number in the file as HEAD has it. */
  line: number
  /** Full commit id that last touched the line. */
  hash: string
  short: string
  author: string
  /** ISO-8601 author date. */
  time: string
  /** That commit's subject. */
  summary: string
  text: string
}

/** What `/blame` answers. */
interface BlamePayload {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  path: string
  lines: BlameLine[]
  truncated: boolean
}

/** What `/stashes` answers. */
interface StashesPayload {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  stashes: StashEntry[]
  truncated: boolean
}

/** What `/branches` answers. */
interface BranchesPayload {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  /** Local branches, current first, then by name. */
  branches: BranchEntry[]
  /** The checked-out branch, or null when HEAD is detached. */
  current: string | null
  truncated: boolean
}

/** What `/show` answers, and what the `gitPanel` service returns. */
interface ShowPayload {
  ok: true
  commit: CommitEntry | null
  files: CommitFile[]
  truncated: boolean
  /** Which parent the files were read against, for a merge commit. */
  parent?: number
  /** The older commit the files were read against, for a range read. */
  base?: string
}

/** How many diff lines the `git_diff` tool hands a model by default. */
const TOOL_DIFF_LINES = 400

/** Untracked files one draft reads in full; the rest are named only. */
const AI_MAX_UNTRACKED_FILES = 10

/** Lines read from one untracked file. */
const AI_UNTRACKED_LINES = 200

/** Output budget for one draft. */
const AI_MAX_TOKENS = 1_024

/**
 * The wrapper language models put around a commit message.
 *
 * A draft is pasted straight into the commit box, so the reply has to be the
 * message itself: fences, a "here is your commit message" opening line, or
 * quoted output would otherwise end up in the commit.
 */
export function sanitizeCommitMessage(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '').trim()
  // A fenced reply is still a reply; keep what is inside the fence.
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  // Drop the whole reply when the model wrapped it in a thinking block.
  text = text.replace(/^<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
  // A preamble line ends with a colon and is not the message itself.
  const lines = text.split('\n')
  while (lines.length > 1 && /^[^\n]{0,48}[:：]$/.test(lines[0].trim())) lines.shift()
  text = lines.join('\n').trim()
  // Surrounding quotes are quoting, not part of the message.
  text = text.replace(/^["'“”『「]+/, '').replace(/["'“”』」]+$/, '').trim()
  // Collapse the blank-line runs a model likes to leave behind.
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.length > MAX_COMMIT_MESSAGE ? text.slice(0, MAX_COMMIT_MESSAGE).trimEnd() : text
}

/**
 * Cut a diff down to what one draft may read.
 *
 * Truncation is reported rather than hidden: the prompt tells the model its view
 * is partial, and the panel tells the user the same thing.
 */
export function trimDiff(text: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  let out = text
  let truncated = false
  const lines = out.split('\n')
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    // A byte cut can split a character; drop the broken tail rather than send it.
    out = Buffer.from(out, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
    truncated = true
  }
  return { text: out, truncated }
}

/** One file as the draft prompt describes it. */
export interface CommitPromptFile {
  path: string
  added: number | null
  deleted: number | null
  untracked?: boolean
}

/** Everything one draft prompt needs. */
export interface CommitPromptInput {
  language: string
  repo: string
  branch: string | null
  source: 'staged' | 'all'
  files: CommitPromptFile[]
  /** Changes that exist but are not part of the commit being described. */
  pending?: string[]
  diff: string
  truncated: boolean
  extra?: string
}

/**
 * The instructions one draft is asked to follow.
 *
 * The rules are described as what the reply must look like rather than as an
 * implementation, and the language is stated once, where it applies.
 */
export function commitSystemPrompt(language: string, extra = ''): string {
  const lines = [
    '你是 Git 提交信息撰写助手。你只输出提交信息本身：不解释、不寒暄、不使用代码围栏。',
    '',
    '格式：',
    '- 第一行是概述，通常不超过 50 个字符，形如「类型: 一句话」。',
    '- 类型取 feat/fix/docs/refactor/perf/test/build/chore/ci/style/revert 之一，紧随英文冒号与一个空格。',
    '- 需要时空一行写正文，每条一行、以「- 」开头，说明为什么改与影响面，不要逐行复述 diff。',
    '- 不要写「本次提交」「如下」这类空话，不要写任何署名或 Co-authored-by。',
    `用${languageName(language)}书写。`,
  ]
  const trimmed = extra.trim()
  if (trimmed !== '') lines.push('', trimmed)
  return lines.join('\n')
}

/** Render a language tag as the word the prompt should use. */
function languageName(language: string): string {
  const tag = language.trim().toLowerCase()
  if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-hans' || tag === 'chinese') return '简体中文'
  if (tag === 'zh-tw' || tag === 'zh-hant') return '繁体中文'
  if (tag === 'en' || tag === 'english') return '英文'
  if (tag === 'ja' || tag === 'japanese') return '日文'
  return language.trim() === '' ? '简体中文' : language.trim()
}

/** The user message that carries the change under review. */
export function buildCommitPrompt(input: CommitPromptInput): string {
  const files = input.files.map(file => {
    const where = file.untracked === true ? ' (新文件)' : ''
    const stats = file.added === null || file.deleted === null ? '' : ` (+${String(file.added)} -${String(file.deleted)})`
    return `- ${file.path}${where}${stats}`
  })
  const head = [
    `仓库：${input.repo}`,
    `分支：${input.branch ?? '（分离 HEAD）'}`,
    input.source === 'staged'
      ? '改动来源：已暂存改动（这些就是要提交的内容）'
      : '改动来源：工作区全部未提交改动（尚未暂存）',
    `文件（${String(input.files.length)} 个）：`,
    ...files,
  ]
  if (input.pending !== undefined && input.pending.length > 0) {
    head.push('', '以下改动尚未暂存，不会进入本次提交，不要写进提交信息：', ...input.pending.map(path => `- ${path}`))
  }
  if (input.truncated) head.push('', '注意：下面的 diff 已按大小截断，可能缺少部分文件或行；不要因此编造未出现的内容。')
  head.push('', 'diff：', input.diff === '' ? '（无文本 diff，可能只有二进制或模式变更）' : input.diff)
  return head.join('\n')
}

/**
 * The JSON subset a tool result may use: no `undefined`, no interfaces.
 *
 * Annotating the tool's return type matters: without it TypeScript infers a
 * union of two anonymous shapes and then refuses the union as a JSON object,
 * because a union does not get an implicit index signature.
 */
type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }

/** What one AI commit-message draft answers with. */
export interface CommitMessageDraft {
  message: string
  provider: string
  model: string
  /** Which changes the draft read: the index, or the whole work tree. */
  source: 'staged' | 'all'
  files: number
  added: number
  deleted: number
  untracked: number
  /** Whether the diff, or the reply, was cut short. */
  truncated: boolean
  inputTokens: number
  /** False when the provider never sent a usage chunk, so `inputTokens` is a
   * placeholder rather than a measurement and the panel says so. */
  usageReported: boolean
}

/** One provider route with the models it advertises. */
export interface ModelCatalogEntry {
  provider: string
  providerName: string
  models: Array<{ id: string; name: string }>
  /** Why this provider's catalog is empty, when it could not be read. */
  error?: string
}

/** What `GET /models` answers. */
export interface ModelCatalog {
  default: { provider: string; model: string } | null
  providers: ModelCatalogEntry[]
}

/** How long a model catalog is reused before the providers are asked again. */
const MODEL_CACHE_MS = 5 * 60 * 1000

/** The profile entry id this plugin's bundle patch inserts; the settings
 * service addresses the plugin's own configuration by it. */
const SETTINGS_NS = 'git-panel'

/**
 * The settings service as this plugin uses it: read the live values of its own
 * Config, and merge edits back into it. That is what makes the panel's model
 * picker survive a different browser: the choice becomes profile
 * configuration, not browser storage.
 */
interface SettingsFace {
  describe: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; value: unknown; revision: number }>
  update: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => Promise<void>
}

/**
 * The current value of one plugin configuration field.
 *
 * A field the settings service may rewrite live (`.volatile()`) reaches the
 * plugin as a stable ref rather than as its value — that ref is precisely what
 * makes the field live-editable — so reading it is `get()`. Every other field
 * arrives as the value itself. Reading a volatile field plainly yields the ref
 * object, which is why this unwraps before anything compares or trims it.
 * @param field - one configuration field as the runtime handed it over.
 * @returns the field's current plain value.
 */
function configField<T>(field: T | { get: () => T }): T {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get: () => T }).get()
  }
  return field as T
}

/**
 * The model the panel last picked, as profile configuration.
 *
 * The live settings descriptor wins (it reflects edits made after this fiber
 * started); the apply-time Config is the fallback, and covers a profile with
 * no settings service at all.
 */
function readRememberedChoice(
  settings: SettingsFace | undefined,
  config: { aiCommitProvider?: string; aiCommitModel?: string },
): { provider: string; model: string } | null {
  return readPickedModel(settings)
    ?? readChoice({
      aiCommitProvider: configField(config.aiCommitProvider),
      aiCommitModel: configField(config.aiCommitModel),
    })
}

/** Read one `{provider, model}` pair, or null when it is not a complete one. */
function readChoice(value: unknown): { provider: string; model: string } | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const provider = typeof record.aiCommitProvider === 'string' ? record.aiCommitProvider.trim() : ''
  const model = typeof record.aiCommitModel === 'string' ? record.aiCommitModel.trim() : ''
  return provider !== '' && model !== '' ? { provider, model } : null
}

/**
 * The pick the panel's own picker remembered, for the picker to display.
 *
 * Only the live settings value counts: a model pinned in the profile's plugin
 * configuration is a deployment default, and the picker still offers "follow
 * the default" ahead of it, exactly as before.
 */
function readPickedModel(settings: SettingsFace | undefined): { provider: string; model: string } | null {
  if (settings === undefined) return null
  try {
    const entry = settings.describe().find(descriptor => descriptor.ns === SETTINGS_NS)
    return readChoice(entry?.value)
  } catch {
    // A settings service that cannot answer must not break drafting.
    return null
  }
}

/** The `llm` service as this plugin uses it: one streaming text call. */
interface LlmFace {
  listProviders?: () => Array<{ id: string; name: string }>
  listModels?: (provider: string) => Promise<Array<{ id: string; name?: string }>>
  stream: (options: {
    provider: string
    model: string
    /**
     * Reasoning effort for this one call, as the route spells it. Omitted
     * leaves the decision to the model/route — which is *not* the same as
     * `off`: a route that cannot disable thinking rejects the latter.
     */
    reasoningEffort?: string
    system?: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    maxTokens?: number
    signal?: AbortSignal
  }) => AsyncIterable<{
    type: string
    text?: string
    usage?: { inputTokens?: number }
    reason?: { kind: string; failure?: { message?: string } }
  }>
}

/** The default-model selection this plugin follows when it is not overridden. */
interface DefaultModelFace {
  currentSelection: () => { provider: string; model: string }
}

/** One commit in the history list. */
interface CommitEntry {
  hash: string
  short: string
  /** Parent hashes, shortest form; empty for the first commit. */
  parents: string[]
  author: string
  /** ISO-8601 author date. */
  date: string
  /** Branch and tag decorations, without `HEAD ->` noise. */
  refs: string[]
  subject: string
}

/** One file a commit touched. */
interface CommitFile {
  path: string
  /** The porcelain status letter: A, M, D, R, C, T. */
  status: string
  previousPath?: string
  added: number
  deleted: number
  binary: boolean
}

/**
 * Parse the NUL-free record format the log query asks git for.
 *
 * Fields are separated by \x1f and records by \x1e, which is why neither
 * separator can appear inside a subject line.
 *
 * @param stdout - `git log --format=…%x1f…%x1e` output.
 * @returns the commits, newest first.
 */
function parseLog(stdout: string): CommitEntry[] {
  return stdout.split('\x1e').map(record => record.replace(/^\n/, '')).filter(record => record !== '').map((record) => {
    const [hash = '', short = '', parents = '', author = '', date = '', refs = '', subject = ''] = record.split('\x1f')
    // `%d` renders as " (HEAD -> main, tag: v1, origin/main)", with a leading
    // space and parentheses around the whole list; the panel wants the names.
    const decorations = refs.trim().replace(/^\(/, '').replace(/\)$/, '')
    return {
      hash,
      short,
      parents: parents === '' ? [] : parents.split(' ').filter(parent => parent !== ''),
      author,
      date,
      refs: decorations === ''
        ? []
        : decorations.split(',').map(item => item.trim()).filter(item => item !== ''),
      subject,
    }
  })
}

/**
 * Parse `git show --name-status -z` output.
 *
 * @param stdout - the command's NUL-separated records.
 * @returns one entry per touched file, in git's order.
 */
function parseNameStatus(stdout: string): { path: string; status: string; previousPath?: string }[] {
  const fields = stdout.split('\0').filter(field => field !== '')
  const files: { path: string; status: string; previousPath?: string }[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index] ?? ''
    // A rename or copy carries the old path before the new one.
    if (/^[RC]/.test(status)) {
      const previous = fields[index + 1]
      const path = fields[index + 2]
      if (previous === undefined || path === undefined) break
      files.push({ path, status: status.slice(0, 1), previousPath: previous })
      index += 3
      continue
    }
    const path = fields[index + 1]
    if (path === undefined) break
    files.push({ path, status: status.slice(0, 1) })
    index += 2
  }
  return files
}

/** How many commits the history list reads by default, and at most. */
const DEFAULT_LOG_LIMIT = 30
const MAX_LOG_LIMIT = 200

/**
 * The one-line format the log and show handlers share. `\x1f` separates fields
 * and `\x1e` ends the record, so a subject containing anything at all — tabs,
 * pipes, even newlines — still parses.
 *
 * `%p` (abbreviated parents), not `%P`: the commit graph matches a parent
 * against the abbreviated ids in the same list, and git shortens both with the
 * same rule, so they have to agree.
 */
const LOG_FORMAT = '%H%x1f%h%x1f%p%x1f%an%x1f%ad%x1f%d%x1f%s%x1e'

/** How many commits one `skip` may jump over. */
const MAX_LOG_SKIP = 100_000

/** The longest branch name, path filter or text filter the routes accept. */
const MAX_REF_LENGTH = 200
const MAX_PATH_LENGTH = 500

/**
 * A ref name the panel may hand to git as an argument.
 *
 * argv is passed without a shell, so this is about git's own parsing: a name
 * that starts with `-` would be read as an option, and the characters git
 * forbids in a ref (`~^:?*[\`, whitespace, `..`, `@{`) would make the command
 * ambiguous rather than merely wrong.
 */
function safeRef(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string') throw new RouteError(400, 'ref must be a string')
  if (raw.length > MAX_REF_LENGTH) throw new RouteError(400, `ref must be at most ${String(MAX_REF_LENGTH)} characters`)
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new RouteError(400, 'ref must not contain control characters')
  if (raw.startsWith('-')) throw new RouteError(400, 'ref must not start with a dash')
  if (/[\s~^:?*\[\\]/.test(raw) || raw.includes('..') || raw.includes('@{') || raw.includes('//')) {
    throw new RouteError(400, 'ref is not a name git accepts')
  }
  if (raw.endsWith('.') || raw.endsWith('.lock') || raw.endsWith('/')) {
    throw new RouteError(400, 'ref is not a name git accepts')
  }
  return raw
}

/**
 * A free-text filter (`author`, `grep`) or a pathspec.
 *
 * Both travel as single argv elements, so the only real limits are length and
 * control characters; a leading dash is fine because a pathspec follows `--`
 * and the two text filters are passed as `--author=`/`--grep=`.
 */
function safeText(raw: string | null, name: string, max: number): string | undefined {
  if (raw === null || raw === '') return undefined
  if (raw.length > max) throw new RouteError(400, `${name} must be at most ${String(max)} characters`)
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new RouteError(400, `${name} must not contain control characters`)
  return raw
}

/**
 * Which parent of a merge commit to read a diff against.
 *
 * A merge has one diff per parent and `git show` prints none of them, so the
 * panel asks for one explicitly; an octopus merge can have several.
 */
function safeParent(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new RouteError(400, 'parent must be an integer between 1 and 8')
  }
  return value
}

/** A paging number: an integer inside its range, or a 400. */
function safeCount(raw: string | null, name: string, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RouteError(400, `${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return value
}

/** A commit hash as the panel may name it: hex, 7 to 40 characters. */
const HASH_PATTERN = /^[0-9a-f]{7,40}$/

/** Per-file line counts, or a binary marker. */
interface LineCounts {
  added: number
  deleted: number
  binary: boolean
}

/** How many entries each work-tree group holds. */
interface WorkTreeCounts {
  staged: number
  changed: number
  untracked: number
  conflicted: number
}

/** Branch facts for the repository enclosing an inspected directory. */
interface RepoSummary {
  root: string
  name: string
  branch: string | null
  detached: boolean
  head: string
  upstream: string | null
  ahead: number
  behind: number
}

/** One work-tree entry as the panel consumes it. */
interface StatusFile {
  path: string
  originalPath?: string
  index: string
  worktree: string
  untracked: boolean
  unmerged: boolean
  staged: LineCounts | null
  unstaged: LineCounts | null
}

/** The repository state one directory answers with. */
interface StatusPayload {
  ok: true
  repo: RepoSummary | null
  reason?: string
  truncated?: boolean
  files: StatusFile[]
  counts: WorkTreeCounts
  /** The in-progress merge/cherry-pick/revert/rebase, when there is one. */
  operation: OperationState | null
}

/**
 * An in-progress multi-step git operation.
 *
 * A pull through this panel is `--ff-only`, so it never starts one; they arrive
 * from the terminal, or from a stash pop that conflicted. Either way the panel
 * must not leave the user staring at a list of unmerged files with no way out.
 */
interface OperationState {
  kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase'
  /** Files still unmerged; continuing is only possible at zero. */
  unmerged: number
}

/** The three remote actions the panel may run. */
/** Actions that only touch the remote's view of the repository. */
export type RemoteAction = 'fetch' | 'pull' | 'push'

/**
 * Actions that change this checkout: the index, the work tree, or history.
 * None of them can reach a remote, and none of them deletes an untracked file.
 */
export type LocalAction = 'stage' | 'unstage' | 'discard' | 'stash' | 'commit'
  | 'stashApply' | 'stashPop' | 'stashDrop' | 'abortOperation' | 'continueOperation'
  | 'checkout'

/** Every action the panel may ask for. */
export type ActionName = RemoteAction | LocalAction

/** What one fetch/pull/push hands back to the panel. */
/** One git command an action ran, with its own verdict. */
interface ActionStep {
  /** The exact argv that ran, for the panel's log. */
  command: string[]
  exitCode: number | null
  succeeded: boolean
  /** Bounded output tail; the log shows a few lines of it. */
  stdout: string
  stderr: string
  truncated: boolean
}

/** The parameters one local action may carry; every field is validated first. */
interface LocalActionParams {
  paths?: string[]
  message?: string
  includeUntracked?: boolean
  /** The stash entry to apply, pop, or drop (validated against {@link STASH_REF});
   * for `checkout`, the branch to switch to (validated against {@link safeRef}). */
  ref?: string
  /** `checkout`: create the branch instead of switching to an existing one. */
  create?: boolean
}

interface ActionPayload {
  /** The request was served; this is not git's verdict. */
  ok: true
  action: ActionName
  /** The exact argv that ran, for the panel's log. */
  command: string[]
  exitCode: number | null
  /** git's verdict: true only for a clean exit. */
  succeeded: boolean
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
  /** Every command that ran, in order; a pull fetches before it pulls. */
  steps: ActionStep[]
}

/** The argv of each action. Nothing else may be pushed: no --force, no --tags, no --set-upstream. */
const REMOTE_ACTIONS: readonly RemoteAction[] = ['fetch', 'pull', 'push']
const LOCAL_ACTIONS: readonly LocalAction[] = [
  'stage', 'unstage', 'discard', 'stash', 'commit', 'stashApply', 'stashPop', 'stashDrop',
  'abortOperation', 'continueOperation', 'checkout',
]

/**
 * The only ref the stash actions accept: exactly what `git stash list` printed,
 * so a crafted request cannot smuggle a revision or an option into the argv.
 */
const STASH_REF = /^stash@\{\d+\}$/

/** How many paths one request may name. */
const MAX_ACTION_PATHS = 200

/** Longest accepted commit message, in characters. */
const MAX_COMMIT_MESSAGE = 4_000

const ACTION_ARGV: Readonly<Record<RemoteAction, readonly string[]>> = {
  fetch: ['fetch', '--prune'],
  pull: ['pull', '--ff-only'],
  push: ['push'],
}

/**
 * Keep the last `maxChars` characters of a stream, marking what was dropped.
 * @param text - the complete stream text.
 * @param maxChars - how much of its tail to keep.
 * @returns the tail, prefixed with a marker when anything was dropped.
 */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `…（已省略前 ${text.length - maxChars} 字符）\n${text.slice(text.length - maxChars)}`
}

/** A request rejection the handler answers with a status code. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 * @param stdout - complete command output.
 * @returns branch facts and work-tree entries, in git's order.
 */
function parseStatus(stdout: string): StatusFacts {
  const tokens = stdout.split('\0')
  const entries: RawEntry[] = []
  let head = ''
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '') continue
    if (token.startsWith('# ')) {
      const separator = token.indexOf(' ', 2)
      const key = separator < 0 ? token.slice(2) : token.slice(2, separator)
      const value = separator < 0 ? '' : token.slice(separator + 1)
      if (key === 'branch.oid') head = value
      else if (key === 'branch.head') branch = value
      else if (key === 'branch.upstream') upstream = value
      else if (key === 'branch.ab') {
        const counts = /^\+(\d+) -(\d+)$/.exec(value)
        if (counts !== null) {
          ahead = Number(counts[1])
          behind = Number(counts[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '1' || kind === 'u') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const path = fields.slice(kind === '1' ? 8 : 10).join(' ')
      entries.push({ path, index: xy[0] ?? '.', worktree: xy[1] ?? '.', unmerged: kind === 'u' })
    } else if (kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const path = fields.slice(9).join(' ')
      // A rename record's source path is the very next NUL field.
      const originalPath = tokens[index + 1]
      index += 1
      entries.push({
        path,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        ...originalPath === undefined || originalPath === '' ? {} : { originalPath },
      })
    } else if (kind === '?') {
      entries.push({ path: token.slice(2), index: '?', worktree: '?', untracked: true })
    }
  }
  return { head, branch, detached: branch === '(detached)' || branch === '', upstream, ahead, behind, entries }
}

/**
 * Parse `git diff --numstat -z` output.
 * @param stdout - complete command output.
 * @returns per-path line counts; a rename record keys the new path.
 */
function parseNumstat(stdout: string): Map<string, LineCounts> {
  const queue = stdout.split('\0')
  const result = new Map<string, LineCounts>()
  while (queue.length > 0) {
    const record = queue.shift() as string
    if (record === '') continue
    // Only the first two tabs separate fields; a file name keeps its own tabs.
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) continue
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    let path = record.slice(second + 1)
    if (path === '') path = queue.shift() ?? ''
    if (path === '') continue
    const binary = added === '-' || deleted === '-'
    result.set(path, {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return result
}

/** Whether `target` is `root` itself or a path inside it. */
function isInside(root: string, target: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** Reject a work-tree path that is absolute, empty, or tries to escape the repository. */
function assertRelativePath(path: string): void {
  if (path === '' || path.includes('\0') || isAbsolute(path)) {
    throw new RouteError(400, 'path must be a non-empty repository-relative path')
  }
  if (path.split('/').includes('..')) throw new RouteError(400, 'path must not escape the repository')
}

/** Answer one request with JSON. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** The empty work-tree tally. */
function zeroCounts(): WorkTreeCounts {
  return { staged: 0, changed: 0, untracked: 0, conflicted: 0 }
}

/**
 * Read and validate the path list of an action body.
 *
 * @param body - the parsed request body.
 * @returns the validated repository-relative paths, in order.
 */
function readPaths(body: Record<string, unknown>): string[] {
  const raw = body.paths
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new RouteError(400, 'paths must be an array of strings')
  if (raw.length > MAX_ACTION_PATHS) throw new RouteError(400, `at most ${String(MAX_ACTION_PATHS)} paths may be named`)
  return raw.map((entry): string => {
    if (typeof entry !== 'string' || entry === '') throw new RouteError(400, 'every path must be a non-empty string')
    assertRelativePath(entry)
    return entry
  })
}

/**
 * Read a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object; an empty object when the body is empty.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > ACTION_BODY_MAX_BYTES) throw new RouteError(413, 'request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RouteError(400, 'request body must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouteError(400, 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Run one worker per item with a bounded number in flight, preserving order.
 * @param items - work items.
 * @param limit - greatest number of workers running at once.
 * @param worker - the async body; its rejection rejects the whole call.
 * @returns results in `items` order.
 */
async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  // A missing or nonsensical limit degrades to sequential work rather than
  // starting no worker at all, which would silently leave every slot undefined.
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length))
  let cursor = 0
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Contribute the Git panel's HTTP surface: reads plus the three remote actions.
 * @param ctx - host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const host = ctx as unknown as HostFaces
  let executable: Promise<string> | undefined
  /** Aborted when this plugin unloads, so a refresh never kills a running action. */
  const dispose = new AbortController()
  /** Directories with an action in flight; one action per repository at a time. */
  const busy = new Set<string>()

  /** One repository's live watcher, shared by every stream that subscribes. */
  interface RepoWatcher {
    listeners: Set<(files: readonly string[]) => void>
    close: () => void
  }
  const watchers = new Map<string, RepoWatcher>()

  /**
   * The directory holding a repository's metadata. A linked worktree or
   * submodule stores the path in a `.git` file instead of a directory.
   */
  const gitDirectory = (root: string): string | null => {
    const dot = join(root, '.git')
    if (!existsSync(dot)) return null
    if (statSync(dot).isDirectory()) return dot
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))
    if (pointer === null) return null
    const target = resolve(root, pointer[1]?.trim() ?? '')
    return existsSync(target) ? target : null
  }

  /**
   * Start watching one repository.
   *
   * Coverage is deliberate: `.git` itself (HEAD, index, packed-refs, ORIG_HEAD,
   * MERGE_HEAD, FETCH_HEAD, stash) plus its `refs` and `logs` trees, because a
   * new branch — including `feature/x` — can only appear under `refs`. Nothing
   * else in `.git` changes what the panel draws, so `objects/` and lock files
   * are filtered out; otherwise a single fetch would send a refresh storm.
   *
   * A watcher that cannot be created (inotify limits, unsupported filesystem)
   * is not an error: the stream still opens and says what it is watching, and
   * the panel keeps its slow poll.
   */
  const createWatcher = (root: string): RepoWatcher => {
    const listeners = new Set<(files: readonly string[]) => void>()
    const pending = new Set<string>()
    const handles: { close: () => void }[] = []
    let timer: NodeJS.Timeout | undefined
    const flush = (): void => {
      timer = undefined
      if (pending.size === 0) return
      const files = [...pending]
      pending.clear()
      for (const listener of listeners) listener(files)
    }
    const gitDir = gitDirectory(root)
    if (gitDir !== null) {
      for (const sub of ['', 'refs', 'logs']) {
        const target = sub === '' ? gitDir : join(gitDir, sub)
        if (!existsSync(target)) continue
        try {
          handles.push(watch(target, { recursive: sub !== '' }, (_eventType, filename) => {
            const name = filename === null ? '' : String(filename)
            if (WATCH_NOISE.test(name)) return
            pending.add(sub === '' ? name : `${sub}/${name}`)
            timer ??= setTimeout(flush, WATCH_DEBOUNCE_MS)
          }))
        } catch {
          // No watcher here; the stream reports it and the panel keeps polling.
        }
      }
    }
    return {
      listeners,
      close: (): void => {
        if (timer !== undefined) clearTimeout(timer)
        for (const handle of handles) handle.close()
      },
    }
  }

  /**
   * Subscribe to one repository's changes.
   * @param root - a validated repository directory.
   * @param listener - called with the changed paths, at most once per debounce window.
   * @returns the release function; the underlying watcher closes with its last subscriber.
   */
  const watchRepository = (root: string, listener: (files: readonly string[]) => void): (() => void) => {
    let watcher = watchers.get(root)
    if (watcher === undefined) {
      watcher = createWatcher(root)
      watchers.set(root, watcher)
    }
    const shared = watcher
    shared.listeners.add(listener)
    return () => {
      shared.listeners.delete(listener)
      if (shared.listeners.size === 0) {
        shared.close()
        watchers.delete(root)
      }
    }
  }

  const gitExecutable = (signal: AbortSignal): Promise<string> => {
    executable ??= host.subprocess.resolveExecutable('git', undefined, signal)
    return executable
  }

  const runGit = async (
    args: readonly string[],
    options: { cwd: string; signal: AbortSignal; maxBytes?: number; timeoutMs?: number },
  ): Promise<GitFacts> => {
    const command = await gitExecutable(options.signal)
    const budget = options.timeoutMs ?? config.timeoutMs
    const timeout = AbortSignal.timeout(budget)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = host.subprocess.spawn({
      argv: [command, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxBytes ?? config.outputMaxBytes },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: { ...GIT_ENV },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw timeout.aborted
        ? new RouteError(504, `git ${args[0] ?? ''} timed out after ${budget}ms`)
        : new RouteError(499, 'request aborted')
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }

  /** Validate a client-supplied directory against the registered workspaces. */
  const allowDirectory = (requested: string | null): string => {
    if (requested === null || requested.trim() === '') throw new RouteError(400, 'dir is required')
    const target = resolve(requested)
    const hit = host.workspaceRegistry.list().find(workspace => isInside(resolve(workspace.path), target))
    if (hit === undefined) throw new RouteError(403, 'dir is outside every registered workspace')
    return target
  }

  /** The repository enclosing a directory, or null when there is none. */
  const repoRoot = async (dir: string, signal: AbortSignal): Promise<string | null> => {
    const found = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, signal })
    if (found.exitCode !== 0) {
      if (/not a git repository/i.test(found.stderr)) return null
      throw new RouteError(500, found.stderr.trim() || 'git rev-parse failed')
    }
    return resolve(found.stdout.trim())
  }

  /**
   * Read one directory's repository state.
   * @param dir - a registered workspace directory.
   * @param signal - cancellation.
   * @param lineCounts - also read per-file line counts (two extra git calls).
   * @returns the panel's status payload.
   */
  /**
   * Detect an in-progress merge/cherry-pick/revert/rebase and count the files
   * still unmerged. A rebase puts down its state directory *and* a MERGE_HEAD
   * at a conflict, so the directory is checked first.
   */
  const detectOperation = async (root: string, signal: AbortSignal): Promise<OperationState | null> => {
    const paths = await runGit(
      ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply',
        '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD'],
      { cwd: root, signal },
    )
    if (paths.exitCode !== 0) return null
    const [rebaseMerge = '', rebaseApply = '', mergeHead = '', cherryPickHead = '', revertHead = '']
      = paths.stdout.split('\n').map(line => line.trim())
    // --git-path answers relative to the repository top level, not to this
    // process, so each candidate is anchored before it is probed.
    const there = (candidate: string): boolean => candidate !== ''
      && existsSync(isAbsolute(candidate) ? candidate : resolve(root, candidate))
    let kind: OperationState['kind'] | null = null
    if (there(rebaseMerge) || there(rebaseApply)) kind = 'rebase'
    else if (there(mergeHead)) kind = 'merge'
    else if (there(cherryPickHead)) kind = 'cherry-pick'
    else if (there(revertHead)) kind = 'revert'
    if (kind === null) return null
    const status = await runGit(['status', '--porcelain=v2', '-z'], { cwd: root, signal })
    const unmerged = status.exitCode === 0
      ? parseStatus(status.stdout).entries.filter(entry => entry.unmerged === true).length
      : 0
    return { kind, unmerged }
  }

  const readStatus = async (dir: string, signal: AbortSignal, lineCounts: boolean): Promise<StatusPayload> => {
    const root = await repoRoot(dir, signal)
    if (root === null) {
      return { ok: true, repo: null, reason: 'not-a-repository', files: [], counts: zeroCounts(), operation: null }
    }
    const status = await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: root, signal })
    if (status.exitCode !== 0) throw new RouteError(500, status.stderr.trim() || 'git status failed')
    const [unstaged, staged, operation] = lineCounts
      ? await Promise.all([
        runGit(['diff', '--numstat', '-z'], { cwd: root, signal }),
        runGit(['diff', '--numstat', '-z', '--cached'], { cwd: root, signal }),
        detectOperation(root, signal),
      ] as const)
      : [undefined, undefined, await detectOperation(root, signal)]
    const facts = parseStatus(status.stdout)
    const unstagedCounts = unstaged?.exitCode === 0 ? parseNumstat(unstaged.stdout) : new Map<string, LineCounts>()
    const stagedCounts = staged?.exitCode === 0 ? parseNumstat(staged.stdout) : new Map<string, LineCounts>()
    const files: StatusFile[] = facts.entries.map((entry) => {
      const untracked = entry.untracked === true
      return {
        path: entry.path,
        ...entry.originalPath === undefined ? {} : { originalPath: entry.originalPath },
        index: entry.index,
        worktree: entry.worktree,
        untracked,
        unmerged: entry.unmerged === true,
        staged: entry.index === '.' || untracked ? null : stagedCounts.get(entry.path) ?? null,
        unstaged: entry.worktree === '.' ? null : unstagedCounts.get(entry.path) ?? null,
      }
    })
    return {
      ok: true,
      repo: {
        root,
        name: root.slice(root.lastIndexOf(sep) + 1) || root,
        branch: facts.detached ? null : facts.branch,
        detached: facts.detached,
        head: facts.head === '(initial)' ? '' : facts.head,
        upstream: facts.upstream,
        ahead: facts.ahead,
        behind: facts.behind,
      },
      truncated: status.truncated,
      files,
      counts: {
        staged: files.filter(file => file.index !== '.' && !file.untracked).length,
        // `changed` is the work tree against the index, not "any difference":
        // a file that is only staged is ready to commit, not still modified,
        // and counting it in both made the card's tally overstate the mess.
        changed: files.filter(file => !file.untracked && file.worktree !== '.').length,
        untracked: files.filter(file => file.untracked).length,
        conflicted: files.filter(file => file.unmerged).length,
      },
      operation,
    }
  }

  /** One overview card: the workspace, its repository, and its tally. */
  interface OverviewEntry {
    workspace: { id: string; title: string; path: string }
    repo: RepoSummary | null
    counts: WorkTreeCounts
    reason?: string
    error?: string
  }

  /** Collect every workspace's card; the route and the service share this. */
  const collectOverview = async (signal: AbortSignal): Promise<{ ok: true; entries: OverviewEntry[] }> => {
    const workspaces = host.workspaceRegistry.list()
    const entries = await mapLimited(workspaces, config.overviewConcurrency, async (workspace): Promise<OverviewEntry> => {
      const card = { workspace: { id: workspace.id, title: workspace.title, path: workspace.path } }
      try {
        const status = await readStatus(resolve(workspace.path), signal, false)
        return {
          ...card,
          repo: status.repo,
          counts: status.counts,
          ...status.reason === undefined ? {} : { reason: status.reason },
        }
      } catch (error: unknown) {
        // One unreadable workspace must not blank the whole grid; an aborted
        // request, however, is the caller's own cancellation and still throws.
        if (signal.aborted || error instanceof RouteError && error.status === 499) throw error
        return {
          ...card,
          repo: null,
          counts: zeroCounts(),
          reason: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
    return { ok: true, entries }
  }

  const handleOverview = async (signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await collectOverview(signal))
  }

  const handleStatus = async (dir: string, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await readStatus(dir, signal, true))
  }

  /**
   * Read one file's diff.
   *
   * @param dir - a validated workspace directory.
   * @param target - the file, the state to compare against, and an optional commit.
   * @param signal - cancellation.
   * @returns the diff payload the route and the `gitPanel` service both hand out.
   */
  const collectDiff = async (
    dir: string,
    target: { path: string; staged: boolean; untracked: boolean; hash?: string; parent?: number; base?: string },
    signal: AbortSignal,
  ): Promise<{ ok: true; kind: string; path: string; staged: boolean; text: string; truncated: boolean }> => {
    const { path, staged, untracked } = target
    assertRelativePath(path)
    // A commit diff is read from history instead of from the checkout, so the
    // same renderer, the same parser and the same gap reader all apply to it.
    const hash = target.hash === undefined ? null : target.hash
    const parent = target.parent
    const base = target.base
    if (hash !== null && !HASH_PATTERN.test(hash)) throw new RouteError(400, 'hash must be a hexadecimal commit id')
    if (base !== undefined && !HASH_PATTERN.test(base)) throw new RouteError(400, 'base must be a hexadecimal commit id')
    if (base !== undefined && parent !== undefined) throw new RouteError(400, 'base and parent are mutually exclusive')
    const root = await repoRoot(dir, signal)
    if (root === null) throw new RouteError(404, 'not a git repository')
    const context = `-U${config.contextLines}`
    const result = hash !== null
      ? parent === undefined && base === undefined
        // `--format=` drops the commit header, leaving a plain diff.
        ? await runGit(['show', '--no-color', '--format=', context, hash, '--', path], { cwd: root, signal })
        // A merge shows nothing by default, so the caller names the parent whose
        // side of the merge it wants to see; a range names the older commit.
        : await runGit(
          ['diff', '--no-color', context, '--find-renames', parent !== undefined ? `${hash}^${String(parent)}` : String(base), hash, '--', path],
          { cwd: root, signal },
        )
      : untracked
      // `--no-index` reports a new file as a pure addition; exit code 1 means "differs".
      ? await runGit(['diff', '--no-color', context, '--no-index', '--', devNull, resolve(root, path)], { cwd: root, signal })
      : await runGit(
        ['diff', '--no-color', context, ...(staged ? ['--cached'] : []), '--', path],
        { cwd: root, signal },
      )
    if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) {
      throw new RouteError(500, result.stderr.trim() || 'git diff failed')
    }
    if (result.stdout === '') return { ok: true, kind: 'empty', path, staged, text: '', truncated: false }
    if (/^Binary files .* differ$/m.test(result.stdout)) {
      return { ok: true, kind: 'binary', path, staged, text: '', truncated: false }
    }
    return { ok: true, kind: 'text', path, staged, text: result.stdout, truncated: result.truncated }
  }

  /** The `/diff` route: validate the query, then hand out {@link collectDiff}. */
  const handleDiff = async (query: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    const hash = query.get('hash')
    const parent = safeParent(query.get('parent'))
    sendJson(res, 200, await collectDiff(allowDirectory(query.get('dir')), {
      path: query.get('path') ?? '',
      staged: query.get('staged') === '1',
      untracked: query.get('untracked') === '1',
      ...(hash === null ? {} : { hash }),
      ...(parent === undefined ? {} : { parent }),
      ...(query.get('base') === null ? {} : { base: query.get('base') as string }),
    }, signal))
  }

  /**
   * Run one remote action. The child is tied to the plugin's lifetime and to
   * `actionTimeoutMs`, never to the browser request: a page refresh or a closed
   * tab must not kill a push halfway through.
   *
   * `pull` refreshes first: `git pull` fetches on its own, but doing it as a
   * separate step means the fast-forward decision uses freshly fetched refs and
   * the ahead/behind numbers the panel shows are true again the moment the pull
   * returns. A failing first step stops the sequence — the pull cannot succeed
   * if its fetch did not, and a doomed network round trip is not worth the wait.
   *
   * @param dir - a validated workspace directory.
   * @param action - which action to run.
   * @returns every step's outcome; a non-zero exit is reported, not thrown.
   */
  const runRemoteAction = async (dir: string, action: RemoteAction): Promise<ActionPayload> => {
    const started = Date.now()
    const steps: ActionStep[] = []
    const prologue = action === 'pull' && config.fetchBeforePull === true ? ['fetch', '--prune'] : undefined
    for (const argv of [prologue, ACTION_ARGV[action]]) {
      if (argv === undefined) continue
      const result = await runGit(argv, {
        cwd: dir,
        signal: dispose.signal,
        timeoutMs: config.actionTimeoutMs,
      })
      const step: ActionStep = {
        command: ['git', ...argv],
        exitCode: result.exitCode,
        succeeded: result.exitCode === 0,
        stdout: tail(result.stdout, config.actionOutputMaxBytes),
        stderr: tail(result.stderr, config.actionOutputMaxBytes),
        truncated: result.truncated,
      }
      steps.push(step)
      if (!step.succeeded) break
    }
    const last = steps[steps.length - 1]
    return {
      ok: true,
      action,
      command: last?.command ?? ['git', ...ACTION_ARGV[action]],
      exitCode: last?.exitCode ?? null,
      succeeded: last?.succeeded === true,
      stdout: last?.stdout ?? '',
      stderr: last?.stderr ?? '',
      truncated: last?.truncated ?? false,
      durationMs: Date.now() - started,
      steps,
    }
  }

  /**
   * Read a slice of a file's *unchanged* lines, so a collapsed gap in the diff
   * can be opened. A request may ask for at most `MAX_CONTEXT_LINES` lines.
   *
   * The revision is chosen here from `staged`/`untracked` and never sent by the
   * client, so a request can only ever address the index, HEAD, or the work
   * tree — there is no way to ask for an arbitrary rev. The path must be
   * relative and must resolve inside the repository.
   *
   * @param params - query: dir, path, staged, untracked, start, count.
   * @param res - answered with the requested slice (200), even when missing.
   */
  const handleContext = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    const dir = allowDirectory(params.get('dir'))
    const path = params.get('path') ?? ''
    assertRelativePath(path)
    const staged = params.get('staged') === '1'
    // A gap inside a commit diff is read from that commit, never from the
    // checkout: opening it must not show today's code next to an old commit.
    const hash = params.get('hash')
    if (hash !== null && !HASH_PATTERN.test(hash)) throw new RouteError(400, 'hash must be a hexadecimal commit id')
    if (hash !== null && staged) throw new RouteError(400, 'hash and staged are mutually exclusive')
    const start = Number(params.get('start'))
    const count = Number(params.get('count'))
    if (!Number.isInteger(start) || start < 1) throw new RouteError(400, 'start must be a positive integer')
    if (!Number.isInteger(count) || count < 1 || count > MAX_CONTEXT_LINES) {
      throw new RouteError(400, `count must be between 1 and ${String(MAX_CONTEXT_LINES)}`)
    }
    const root = await repoRoot(dir, signal)
    if (root === null) throw new RouteError(400, 'not a git repository')
    const target = resolve(root, path)
    if (!isInside(root, target)) throw new RouteError(400, 'path escapes the repository')

    // The gap the panel is showing sits between two hunks, so it is context:
    // the new side of a staged diff is the index blob, otherwise the work tree.
    let text: string
    if (hash !== null) {
      const blob = await runGit(['show', `${hash}:${path}`], { cwd: root, signal })
      if (blob.exitCode !== 0) {
        sendJson(res, 200, { ok: true, start, lines: [], eof: true, missing: true })
        return
      }
      text = blob.stdout
    } else if (staged) {
      const blob = await runGit(['show', `:0:${path}`], { cwd: root, signal })
      if (blob.exitCode !== 0) {
        sendJson(res, 200, { ok: true, start, lines: [], eof: true, missing: true })
        return
      }
      text = blob.stdout
    } else {
      if (!existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 200, { ok: true, start, lines: [], eof: true, missing: true })
        return
      }
      if (statSync(target).size > config.outputMaxBytes) {
        sendJson(res, 200, { ok: true, start, lines: [], eof: true, tooLarge: true })
        return
      }
      text = readFileSync(target, 'utf8')
    }
    if (text.includes('\u0000')) {
      sendJson(res, 200, { ok: true, start, lines: [], eof: true, binary: true })
      return
    }
    const lines = text.split('\n')
    // A trailing newline produces a final empty element that is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const slice = lines.slice(start - 1, start - 1 + count)
    sendJson(res, 200, {
      ok: true,
      start,
      lines: slice,
      eof: start - 1 + slice.length >= lines.length,
      total: lines.length,
    })
  }

  /**
   * Run one local action: something that changes this checkout rather than the
   * remote's view of it.
   *
   * The argv is assembled here from a closed vocabulary — the client names
   * paths and a message, never a command. Paths are always passed after `--`, so
   * a path that looks like an option is still a path. `stage` with `["."]` is
   * how the panel stages everything; there is no implicit "no paths means the
   * whole repository", because `git checkout --` with no pathspec would discard
   * every modification at once.
   *
   * @param dir - a validated workspace directory.
   * @param action - which local action to run.
   * @param params - validated paths, message, and stash switch.
   * @returns every step's outcome; a non-zero exit is reported, not thrown.
   */
  const runLocalAction = async (dir: string, action: LocalAction, params: LocalActionParams): Promise<ActionPayload> => {
    const started = Date.now()
    const steps: ActionStep[] = []
    const paths = params.paths ?? []
    const step = async (argv: readonly string[]): Promise<boolean> => {
      const result = await runGit(argv, { cwd: dir, signal: dispose.signal, timeoutMs: config.actionTimeoutMs })
      const record: ActionStep = {
        command: ['git', ...argv],
        exitCode: result.exitCode,
        succeeded: result.exitCode === 0,
        stdout: tail(result.stdout, config.actionOutputMaxBytes),
        stderr: tail(result.stderr, config.actionOutputMaxBytes),
        truncated: result.truncated,
      }
      steps.push(record)
      return record.succeeded
    }

    if (action === 'stage') {
      await step(['add', '--', ...paths])
    } else if (action === 'unstage') {
      // An unborn HEAD has nothing to reset to, and `git reset` would fail on
      // the very first commit of a fresh repository.
      const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, signal: dispose.signal })
      await step(head.exitCode === 0
        ? ['reset', '-q', 'HEAD', '--', ...paths]
        : ['rm', '--cached', '-r', '--quiet', '--', ...paths])
    } else if (action === 'discard') {
      // Restores the work tree from the index. A staged change therefore
      // survives on purpose: unstage it first to throw it away for good.
      await step(['checkout', '--', ...paths])
    } else if (action === 'stash') {
      await step([
        'stash', 'push',
        ...(params.includeUntracked === true ? ['--include-untracked'] : []),
        '--message', params.message ?? `dsh-git-panel: ${new Date().toISOString()}`,
      ])
    } else if (action === 'checkout') {
      // git itself is the guard here: it refuses when the switch would trample
      // local changes or unmerged paths, and its message names the files.
      await step(params.create === true
        ? ['checkout', '-b', params.ref ?? '']
        : ['checkout', params.ref ?? ''])
    } else if (action === 'abortOperation' || action === 'continueOperation') {
      // The argv depends on what is actually in progress, so it is detected
      // here rather than trusted from the client.
      const operation = await detectOperation(dir, dispose.signal)
      const abortArgv: Record<OperationState['kind'], readonly string[]> = {
        merge: ['merge', '--abort'],
        'cherry-pick': ['cherry-pick', '--abort'],
        revert: ['revert', '--abort'],
        rebase: ['rebase', '--abort'],
      }
      const continueArgv: Record<OperationState['kind'], readonly string[]> = {
        // Concluding a merge is a commit; the others have a --continue that may
        // otherwise stop at an editor, which a panel cannot answer.
        merge: ['commit', '--no-edit'],
        'cherry-pick': ['-c', 'core.editor=true', 'cherry-pick', '--continue'],
        revert: ['-c', 'core.editor=true', 'revert', '--continue'],
        rebase: ['-c', 'core.editor=true', 'rebase', '--continue'],
      }
      if (operation === null) {
        steps.push({
          command: ['git', action === 'abortOperation' ? '(abort)' : '(continue)'],
          exitCode: 1,
          succeeded: false,
          stdout: '',
          stderr: 'panel: 当前没有进行中的合并/挑拣/回退/变基',
          truncated: false,
        })
      } else if (action === 'abortOperation') {
        await step(abortArgv[operation.kind])
      } else if (operation.unmerged > 0) {
        // git would refuse too; saying it up front is clearer than a raw error.
        steps.push({
          command: ['git', ...continueArgv[operation.kind]],
          exitCode: 1,
          succeeded: false,
          stdout: '',
          stderr: `panel: 还有 ${String(operation.unmerged)} 个文件冲突未解决；逐个解决并暂存后再继续`,
          truncated: false,
        })
      } else {
        await step(continueArgv[operation.kind])
      }
    } else if (action === 'stashApply' || action === 'stashPop' || action === 'stashDrop') {
      // git's own guard rails apply here: apply/pop refuse to trample a dirty
      // tree, and pop only drops the entry after a clean apply.
      const verb = action === 'stashApply' ? 'apply' : action === 'stashPop' ? 'pop' : 'drop'
      await step(['stash', verb, params.ref ?? ''])
    } else {
      if (paths.length > 0 && !(await step(['add', '--', ...paths]))) {
        // Fall through to the summary below with the failed `add` as the result.
      } else {
        await step(['commit', '-m', params.message ?? ''])
      }
    }

    const last = steps[steps.length - 1]
    return {
      ok: true,
      action,
      command: last?.command ?? ['git', action],
      exitCode: last?.exitCode ?? null,
      succeeded: last?.succeeded === true,
      stdout: last?.stdout ?? '',
      stderr: last?.stderr ?? '',
      truncated: last?.truncated ?? false,
      durationMs: Date.now() - started,
      steps,
    }
  }

  const handleAction = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A cross-origin HTML form cannot send this header, and the login cookie is
    // SameSite=Lax; both together keep a stray page from triggering a push.
    if (req.headers[ACTION_HEADER] === undefined) {
      throw new RouteError(403, `missing ${ACTION_HEADER} header`)
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new RouteError(415, 'action requires content-type: application/json')
    }
    const body = await readJsonBody(req)
    const requested = body.action
    const remote = REMOTE_ACTIONS.find(candidate => candidate === requested)
    const local = LOCAL_ACTIONS.find(candidate => candidate === requested)
    if (remote === undefined && local === undefined) {
      throw new RouteError(400, `action must be one of: ${[...REMOTE_ACTIONS, ...LOCAL_ACTIONS].join(', ')}`)
    }
    if (remote === 'push') {
      if (config.allowPush !== true) throw new RouteError(403, 'push is disabled by this profile\'s plugin configuration')
      // The panel asks the user first; the API insists on being told that it did.
      if (body.confirm !== true) throw new RouteError(428, 'push requires confirm: true')
    }
    const paths = readPaths(body)
    const message = typeof body.message === 'string' ? body.message.trim() : undefined
    if (local !== undefined) {
      if (config.allowRepoWrites !== true) {
        throw new RouteError(403, 'local write actions are disabled by this profile\'s plugin configuration')
      }
      // A malformed request is a 400 whatever the confirmation says; only a
      // well-formed one can be missing its confirmation.
      // `git checkout --` with no pathspec would discard every modification at
      // once; an empty path list is never what the panel means.
      if ((local === 'stage' || local === 'unstage' || local === 'discard') && paths.length === 0) {
        throw new RouteError(400, `${local} requires at least one path`)
      }
      if (local === 'commit') {
        if (message === undefined || message === '') throw new RouteError(400, 'commit requires a message')
        if (message.length > MAX_COMMIT_MESSAGE) {
          throw new RouteError(400, `the commit message must be at most ${String(MAX_COMMIT_MESSAGE)} characters`)
        }
      }
      if (local === 'stashApply' || local === 'stashPop' || local === 'stashDrop') {
        const ref = typeof body.ref === 'string' ? body.ref : ''
        if (!STASH_REF.test(ref)) {
          throw new RouteError(400, `${local} requires ref in the form stash@{N}`)
        }
      }
      if (local === 'checkout') {
        const ref = safeRef(body.ref)
        if (ref === undefined) throw new RouteError(400, 'checkout requires a branch name in ref')
      }
      // Discarding work and stashing both destroy uncommitted state, so they
      // carry the same two-step confirmation as push. Dropping a stash entry
      // destroys it outright, aborting an operation throws away every conflict
      // resolution already made, and switching branches replaces the work
      // tree, so they all ask the same way.
      if ((local === 'discard' || local === 'stash' || local === 'stashDrop' || local === 'abortOperation' || local === 'checkout') && body.confirm !== true) {
        throw new RouteError(428, `${local} requires confirm: true`)
      }
    }
    const dir = allowDirectory(typeof body.dir === 'string' ? body.dir : null)
    if (busy.has(dir)) throw new RouteError(409, 'another git operation is already running for this repository')
    busy.add(dir)
    try {
      const payload = remote !== undefined
        ? await runRemoteAction(dir, remote)
        : await runLocalAction(dir, local as LocalAction, {
          paths,
          ...(message === undefined ? {} : { message }),
          ...(body.includeUntracked === true ? { includeUntracked: true } : {}),
          ...(typeof body.ref === 'string' ? { ref: body.ref } : {}),
          ...(body.create === true ? { create: true } : {}),
        })
      sendJson(res, 200, payload)
    } finally {
      busy.delete(dir)
    }
  }

  /**
   * Stream repository changes to the panel as server-sent events.
   *
   * This handler owns its response for the whole connection: it stays open,
   * answers with one `hello` frame naming what is really being watched, then a
   * `change` frame per repository per debounce window, plus comment-only
   * keep-alives so an idle stream is not reaped. The panel keeps a slow poll
   * running as well, so a stream that cannot open degrades quietly.
   *
   * @param req - the request; its close event ends the stream.
   * @param res - the response this handler keeps writing to.
   * @param url - the query, carrying one `dir` per requested repository.
   */
  const handleEvents = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (config.watchEnabled !== true) {
      throw new RouteError(503, 'repository watching is disabled by this profile\'s plugin configuration')
    }
    const requested = url.searchParams.getAll('dir')
    if (requested.length === 0) throw new RouteError(400, 'at least one dir is required')
    if (requested.length > MAX_WATCHED_DIRS) {
      throw new RouteError(400, `at most ${String(MAX_WATCHED_DIRS)} directories can be watched`)
    }
    const dirs = [...new Set(requested.map(dir => allowDirectory(dir)))]
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const frame = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const watching: Record<string, boolean> = {}
    const releases = dirs.map(dir => {
      watching[dir] = gitDirectory(dir) !== null
      return watchRepository(dir, files => { frame('change', { dir, files, at: Date.now() }) })
    })
    res.write('retry: 3000\n\n')
    frame('hello', { dirs, watching })
    const heartbeat = setInterval(() => { res.write(': ping\n\n') }, EVENT_HEARTBEAT_MS)
    await new Promise<void>((done) => {
      const finish = (): void => { done() }
      req.once('close', finish)
      res.once('close', finish)
      // Unloading the plugin must not leave a stream open with no owner.
      dispose.signal.addEventListener('abort', finish, { once: true })
    })
    clearInterval(heartbeat)
    for (const release of releases) release()
    res.end()
  }

  /**
   * Read a repository's history, newest first.
   *
   * @param params - `dir` and an optional `limit` (1..200, default 30).
   * @param signal - cancellation.
   * @param res - the response to write the JSON payload to.
   */
  /**
   * Read a repository's history.
   *
   * @param dir - a validated workspace directory.
   * @param query - how much history, of which ref, and with which filters.
   * @param signal - cancellation.
   * @returns the log payload the route and the service both hand out.
   */
  const collectLog = async (dir: string, query: LogQuery, signal: AbortSignal): Promise<LogPayload> => {
    const root = await repoRoot(dir, signal)
    if (root === null) {
      return {
        ok: true, repo: null, reason: 'not-a-repository', commits: [], truncated: false,
        limit: query.limit, skip: query.skip,
      }
    }
    const result = await runGit([
      'log',
      `--max-count=${String(query.limit)}`,
      ...(query.skip === 0 ? [] : [`--skip=${String(query.skip)}`]),
      // A lane layout needs every parent after its children. git's default
      // order is by date, which can print a parent first when clocks disagree;
      // --topo-order is the guarantee, and it is what gitk asks for too.
      '--topo-order',
      '--no-color',
      '--date=iso-strict',
      `--format=${LOG_FORMAT}`,
      // `--all` reads every ref; a named ref reads that ref's own history; with
      // neither, git logs the current branch, which is the panel's default.
      ...(query.all === true ? ['--all'] : query.ref === undefined ? [] : [query.ref]),
      ...(query.author === undefined ? [] : [`--author=${query.author}`]),
      ...(query.grep === undefined ? [] : ['--regexp-ignore-case', `--grep=${query.grep}`]),
      // The pathspec must come last, after `--`, so a path that looks like a
      // revision is still read as a path.
      ...(query.path === undefined ? [] : ['--', query.path]),
    ], { cwd: root, signal })
    // A named ref that does not exist is the caller's mistake, not an empty
    // history; only an unborn HEAD (and a repository literal) read as "nothing".
    if (result.exitCode !== 0 && query.ref !== undefined
      && /unknown revision|bad revision|ambiguous argument|not a valid object name/i.test(result.stderr)) {
      throw new RouteError(404, `no such ref: ${query.ref}`)
    }
    // A repository whose HEAD is unborn has no history; that is an answer, not
    // a failure.
    if (result.exitCode !== 0 && !/does not have any commits|unknown revision|bad default revision|ambiguous argument/i.test(result.stderr)) {
      throw new RouteError(500, result.stderr.trim() || 'git log failed')
    }
    return {
      ok: true,
      repo: { root, name: root.slice(root.lastIndexOf(sep) + 1) || root },
      commits: parseLog(result.stdout),
      truncated: result.truncated,
      limit: query.limit,
      skip: query.skip,
    }
  }

  /** The `/log` route: validate the query, then hand out {@link collectLog}. */
  const handleLog = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    const ref = safeRef(params.get('ref'))
    const path = safeText(params.get('path'), 'path', MAX_PATH_LENGTH)
    const author = safeText(params.get('author'), 'author', MAX_REF_LENGTH)
    const grep = safeText(params.get('grep'), 'grep', MAX_REF_LENGTH)
    sendJson(res, 200, await collectLog(allowDirectory(params.get('dir')), {
      limit: safeCount(params.get('limit'), 'limit', DEFAULT_LOG_LIMIT, 1, MAX_LOG_LIMIT),
      skip: safeCount(params.get('skip'), 'skip', 0, 0, MAX_LOG_SKIP),
      all: params.get('all') === '1',
      ...(ref === undefined ? {} : { ref }),
      ...(path === undefined ? {} : { path }),
      ...(author === undefined ? {} : { author }),
      ...(grep === undefined ? {} : { grep }),
    }, signal))
  }

  /**
   * Read a repository's local branches.
   *
   * One `for-each-ref` call answers the whole list: the tip, whether it is the
   * checked-out branch, its upstream and how far it has drifted. Nothing here
   * writes, so the history view can offer branches without offering checkout.
   *
   * @param dir - a validated workspace directory.
   * @param signal - cancellation.
   * @returns the branches payload the route and the service both hand out.
   */
  const collectBranches = async (dir: string, signal: AbortSignal): Promise<BranchesPayload> => {
    const root = await repoRoot(dir, signal)
    if (root === null) return { ok: true, repo: null, reason: 'not-a-repository', branches: [], current: null, truncated: false }
    const unit = '\x1f'
    const result = await runGit([
      'for-each-ref',
      `--format=%(refname:short)${unit}%(objectname:short)${unit}%(HEAD)${unit}%(upstream:short)${unit}%(upstream:track)${unit}%(committerdate:iso-strict)${unit}%(contents:subject)`,
      '--sort=-committerdate',
      'refs/heads',
    ], { cwd: root, signal })
    if (result.exitCode !== 0) throw new RouteError(500, result.stderr.trim() || 'git for-each-ref failed')
    const branches = result.stdout.split('\n').filter(line => line.trim() !== '').map((line): BranchEntry => {
      const [name = '', short = '', head = '', upstream = '', track = '', date = '', subject = ''] = line.split(unit)
      return {
        name,
        short,
        current: head.trim() === '*',
        upstream: upstream === '' ? null : upstream,
        track: track === '' ? null : track,
        date,
        subject,
      }
    })
    // `%(HEAD)` cannot say *which* branch HEAD is on when it is detached, so
    // ask once more rather than reporting the first branch as current.
    const symbolic = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, signal })
    const current = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null
    return {
      ok: true,
      repo: { root, name: root.slice(root.lastIndexOf(sep) + 1) || root },
      branches: branches.sort((left, right) => Number(right.current) - Number(left.current)
        || left.name.localeCompare(right.name)),
      current: current === '' ? null : current,
      truncated: result.truncated,
    }
  }

  /** The `/branches` route. */
  const handleBranches = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await collectBranches(allowDirectory(params.get('dir')), signal))
  }

  /**
   * The stash list of one repository.
   *
   * Newest first, exactly as `git stash list` prints it; the `ref` the panel
   * shows is also the only token the apply/pop/drop actions accept back.
   */
  const collectStashes = async (dir: string, signal: AbortSignal): Promise<StashesPayload> => {
    const root = await repoRoot(dir, signal)
    if (root === null) return { ok: true, repo: null, reason: 'not-a-repository', stashes: [], truncated: false }
    const result = await runGit(
      ['stash', 'list', '--format=%gd%x1f%H%x1f%h%x1f%cI%x1f%gs%x1e'],
      { cwd: root, signal },
    )
    if (result.exitCode !== 0) throw new RouteError(500, result.stderr.trim() || 'git stash list failed')
    const stashes: StashEntry[] = []
    for (const record of result.stdout.split('\x1e')) {
      const line = record.replace(/^\n+/, '')
      if (line === '') continue
      const [ref = '', hash = '', short = '', date = '', subject = ''] = line.split('\x1f')
      stashes.push({ ref, hash, short, date, subject })
    }
    return { ok: true, repo: { root, name: basename(root) }, stashes, truncated: result.truncated }
  }

  const handleStashes = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await collectStashes(allowDirectory(params.get('dir')), signal))
  }

  /**
   * Line-by-line attribution of one committed file.
   *
   * Blame reads HEAD, so uncommitted changes are simply not in it — the panel
   * says so above the view rather than pretending the work tree is blamed.
   */
  const collectBlame = async (dir: string, path: string, signal: AbortSignal): Promise<BlamePayload> => {
    assertRelativePath(path)
    const root = await repoRoot(dir, signal)
    if (root === null) return { ok: true, repo: null, reason: 'not-a-repository', path, lines: [], truncated: false }
    const result = await runGit(
      ['blame', '--line-porcelain', '--date=iso-strict', 'HEAD', '--', path],
      { cwd: root, signal },
    )
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim()
      if (/no such path|does not exist|cannot stat/i.test(reason)) {
        throw new RouteError(404, `no committed file named ${path}`)
      }
      if (/does not have any commits|bad default revision/i.test(reason)) {
        throw new RouteError(409, 'this repository has no commits yet')
      }
      throw new RouteError(500, reason || 'git blame failed')
    }
    const lines: BlameLine[] = []
    let hash = ''
    let author = ''
    let time = ''
    let summary = ''
    for (const raw of result.stdout.split('\n')) {
      if (/^[0-9a-f]{40} /.test(raw)) {
        hash = raw.slice(0, 40)
      } else if (raw.startsWith('author ')) {
        author = raw.slice(7)
      } else if (raw.startsWith('author-time ')) {
        // Porcelain gives epoch seconds; --date does not change that, so the
        // conversion happens here.
        time = new Date(Number(raw.slice(12)) * 1_000).toISOString()
      } else if (raw.startsWith('summary ')) {
        summary = raw.slice(8)
      } else if (raw.startsWith('\t')) {
        lines.push({
          line: lines.length + 1,
          hash,
          short: hash.slice(0, 12),
          author,
          time,
          summary,
          text: raw.slice(1),
        })
      }
    }
    return { ok: true, repo: { root, name: basename(root) }, path, lines, truncated: result.truncated }
  }

  const handleBlame = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await collectBlame(allowDirectory(params.get('dir')), params.get('path') ?? '', signal))
  }

  /**
   * Read one commit: its metadata, the files it touched, and their sizes.
   *
   * @param params - `dir` and `hash`.
   * @param signal - cancellation.
   * @param res - the response to write the JSON payload to.
   */
  /**
   * Read one commit and the files it touched.
   *
   * @param dir - a validated workspace directory.
   * @param hash - the commit to read.
   * @param signal - cancellation.
   * @returns the commit payload the route and the service both hand out.
   */
  const collectShow = async (
    dir: string,
    hash: string,
    signal: AbortSignal,
    parent?: number,
    base?: string,
  ): Promise<ShowPayload> => {
    if (!HASH_PATTERN.test(hash)) throw new RouteError(400, 'hash must be a hexadecimal commit id')
    if (base !== undefined && !HASH_PATTERN.test(base)) throw new RouteError(400, 'base must be a hexadecimal commit id')
    if (base !== undefined && parent !== undefined) throw new RouteError(400, 'base and parent are mutually exclusive')
    const root = await repoRoot(dir, signal)
    if (root === null) throw new RouteError(404, 'not a git repository')
    // Against a named parent the files come from a two-tree diff, which is the
    // only way to see what a merge actually brought in; against another commit
    // the same mechanism answers "what changed between these two".
    const from = parent !== undefined ? `${hash}^${String(parent)}` : base !== undefined ? base : null
    const [meta, names, numbers] = await Promise.all([
      runGit(['show', '--no-color', '--date=iso-strict', `--format=${LOG_FORMAT}`, '--no-patch', hash], { cwd: root, signal }),
      from === null
        ? runGit(['show', '--no-color', '--format=', '--name-status', '-z', hash], { cwd: root, signal })
        : runGit(['diff', '--no-color', '--find-renames', '--name-status', '-z', from, hash], { cwd: root, signal }),
      from === null
        ? runGit(['show', '--no-color', '--format=', '--numstat', '-z', hash], { cwd: root, signal })
        : runGit(['diff', '--no-color', '--find-renames', '--numstat', '-z', from, hash], { cwd: root, signal }),
    ])
    if (meta.exitCode !== 0) throw new RouteError(404, meta.stderr.trim() || 'no such commit')
    const counts = numbers.exitCode === 0 ? parseNumstat(numbers.stdout) : new Map<string, LineCounts>()
    const files: CommitFile[] = names.exitCode === 0
      ? parseNameStatus(names.stdout).map((file) => {
        const tally = counts.get(file.path)
        return {
          path: file.path,
          status: file.status,
          ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
          added: tally?.added ?? 0,
          deleted: tally?.deleted ?? 0,
          binary: tally?.binary === true,
        }
      })
      : []
    const [commit = null] = parseLog(meta.stdout)
    return {
      ok: true, commit, files, truncated: meta.truncated,
      ...(parent === undefined ? {} : { parent }),
      ...(base === undefined ? {} : { base }),
    }
  }

  /** The `/show` route: validate the query, then hand out {@link collectShow}. */
  const handleShow = async (params: URLSearchParams, signal: AbortSignal, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, await collectShow(
      allowDirectory(params.get('dir')),
      params.get('hash') ?? '',
      signal,
      safeParent(params.get('parent')),
      params.get('base') ?? undefined,
    ))
  }

  /** Reused catalog, so opening the picker does not re-ask every provider. */
  let catalogCache: { at: number; value: ModelCatalog } | null = null

  /**
   * List the provider routes and models a draft may be pointed at.
   *
   * A provider that cannot be read is reported as an empty group with its
   * reason: one unreachable endpoint must not hide the other models.
   */
  const collectModels = async (): Promise<ModelCatalog> => {
    if (catalogCache !== null && Date.now() - catalogCache.at < MODEL_CACHE_MS) return catalogCache.value
    const llm = ctx.get('llm') as LlmFace | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new RouteError(503, 'this profile has no model adapter mounted')
    }
    const routes = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    const providers: ModelCatalogEntry[] = []
    for (const route of routes) {
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(route.id) : []
        providers.push({
          provider: route.id,
          providerName: route.name,
          models: models.map(model => ({ id: model.id, name: model.name ?? model.id })),
        })
      } catch (error: unknown) {
        providers.push({
          provider: route.id,
          providerName: route.name,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const defaultSelection = (ctx.get('agentDefaultModel') as DefaultModelFace | undefined)?.currentSelection() ?? null
    const value: ModelCatalog = {
      default: defaultSelection === null
        ? null
        : { provider: defaultSelection.provider, model: defaultSelection.model },
      providers,
    }
    catalogCache = { at: Date.now(), value }
    return value
  }

  /**
   * Read the changes a commit message would describe.
   *
   * Staged changes come first: they are exactly what `git commit` records. With
   * nothing staged — or with no commit yet to compare against — the work tree is
   * read instead, and the answer says so, because the panel has to tell the user
   * to stage before committing.
   */
  /** What the model is shown for one draft, as {@link collectCommitInput} builds it. */
  type CommitInput = {
    repo: string
    branch: string | null
    source: 'staged' | 'all'
    files: CommitPromptFile[]
    pending: string[]
    untracked: string[]
    diff: string
    truncated: boolean
  }

  const collectCommitInput = async (dir: string, stagedOnly: boolean, signal: AbortSignal): Promise<{
    repo: string
    branch: string | null
    source: 'staged' | 'all'
    files: CommitPromptFile[]
    pending: string[]
    untracked: string[]
    diff: string
    truncated: boolean
  }> => {
    const root = await repoRoot(dir, signal)
    if (root === null) throw new RouteError(404, 'not a git repository')
    const status = await readStatus(dir, signal, true)
    const hasHead = (await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, signal })).exitCode === 0
    const source: 'staged' | 'all' = stagedOnly || !hasHead || status.counts.staged > 0 ? 'staged' : 'all'
    /** Whether one status entry is part of what `git commit` would record. */
    const stagedEntry = (file: { index: string; untracked: boolean; unmerged: boolean }): boolean =>
      !file.untracked && !file.unmerged && file.index !== '.'
    const untracked = status.files.filter(file => file.untracked).map(file => file.path)
    if (status.files.length === 0) throw new RouteError(409, 'there is nothing to commit')
    const context = `-U${String(config.contextLines)}`
    const result = await runGit(
      source === 'staged'
        ? ['diff', '--cached', '--no-color', context]
        : ['diff', 'HEAD', '--no-color', context],
      { cwd: root, signal },
    )
    if (result.exitCode !== 0 && result.stdout === '') {
      throw new RouteError(500, result.stderr.trim() || 'git diff failed')
    }
    const parts = [result.stdout]
    // An untracked file is invisible to `git diff HEAD`, and a commit that only
    // records tracked edits should still be described with its new files in view.
    if (source === 'all') {
      for (const path of untracked.slice(0, AI_MAX_UNTRACKED_FILES)) {
        const one = await runGit(
          ['diff', '--no-color', context, '--no-index', '--', devNull, resolve(root, path)],
          { cwd: root, signal, maxBytes: config.aiCommitMaxDiffBytes },
        )
        // `--no-index` exits 1 to mean "these differ", which is the normal case.
        if ((one.exitCode === 0 || one.exitCode === 1) && one.stdout !== '') {
          parts.push(one.stdout.split('\n').slice(0, AI_UNTRACKED_LINES).join('\n'))
        }
      }
    }
    const trimmed = trimDiff(parts.join(''), config.aiCommitMaxDiffLines, config.aiCommitMaxDiffBytes)
    return {
      repo: status.repo?.name ?? (root.slice(root.lastIndexOf(sep) + 1) || root),
      branch: status.repo?.branch ?? null,
      source,
      // With a staged commit under description, nothing outside the index may
      // appear in the file list: a message that names an unstaged file describes
      // a commit that does not exist.
      // Untracked files report `?` in the index column, and a conflicted file
      // cannot be committed at all; neither belongs in a staged file list.
      files: status.files
        .filter(file => source === 'all' || stagedEntry(file))
        .map(file => {
          const counts = (source === 'staged' ? file.staged : file.unstaged ?? file.staged) ?? null
          return {
            path: file.originalPath === undefined ? file.path : `${file.originalPath} → ${file.path}`,
            added: counts === null || counts.binary ? null : counts.added,
            deleted: counts === null || counts.binary ? null : counts.deleted,
            untracked: file.untracked,
          }
        }),
      // Everything the staged commit will not record, so the model can leave it
      // out instead of inventing a message for a file that stays behind.
      pending: status.files
        .filter(file => source === 'staged' && !stagedEntry(file))
        .map(file => `${file.path}${file.untracked === true ? '（未跟踪）' : ''}`),
      untracked,
      diff: trimmed.text,
      truncated: trimmed.truncated,
    }
  }

  /**
   * Ask the configured model for one commit message.
   *
   * The call carries no tools, so a draft can only ever produce text: the model
   * cannot stage, commit or push on its own, and the user still decides both.
   */
  /**
   * Resolve which model answers: the request's own choice, then the
   * remembered pick (live profile configuration), then the profile default.
   */
  const resolveModelChoice = (choice: { provider?: string; model?: string }): { provider: string; model: string } => {
    const selection = (ctx.get('agentDefaultModel') as DefaultModelFace | undefined)?.currentSelection()
    // The picker in the panel wins over the remembered choice (which is the
    // plugin's configuration, live), which wins over the profile default.
    const remembered = choice.provider === undefined || choice.model === undefined
      ? readRememberedChoice(ctx.get('settings') as SettingsFace | undefined, config)
      : null
    const chosen = (value: string | undefined, fallback: string): string =>
      value !== undefined && value.trim() !== '' ? value.trim() : fallback
    const provider = chosen(choice.provider, chosen(remembered?.provider, selection?.provider ?? ''))
    const model = chosen(choice.model, chosen(remembered?.model, selection?.model ?? ''))
    if (provider === '' || model === '') {
      throw new RouteError(503, 'no default model is selected; set aiCommitProvider and aiCommitModel in the plugin configuration')
    }
    return { provider, model }
  }

  /**
   * Everything a draft needs before the model is asked.
   *
   * Split out of the draft so the streaming route can fail with a plain JSON
   * error for all of this — before its response turns into an event stream.
   */
  const planCommitDraft = async (
    dir: string,
    stagedOnly: boolean,
    signal: AbortSignal,
    choice: { provider?: string; model?: string; reasoningEffort?: string },
  ): Promise<{
    input: CommitInput
    llm: LlmFace
    provider: string
    model: string
    reasoningEffort?: string
  }> => {
    if (config.aiCommitEnabled !== true) {
      throw new RouteError(403, 'the AI commit-message draft is disabled by this profile\'s plugin configuration')
    }
    const input = await collectCommitInput(dir, stagedOnly, signal)
    const llm = ctx.get('llm') as LlmFace | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new RouteError(503, 'this profile has no model adapter mounted')
    }
    const { provider, model } = resolveModelChoice(choice)
    const reasoningEffort = resolveReasoningEffort(choice)
    return { input, llm, provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  }

  /**
   * Run one planned draft against the model.
   *
   * `onDelta` sees every raw piece as it arrives — the streaming route turns
   * them into frames; the final answer is still the sanitized message.
   */
  const runCommitDraft = async (
    plan: { input: CommitInput; llm: LlmFace; provider: string; model: string; reasoningEffort?: string },
    signal: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<CommitMessageDraft> => {
    const { input, llm, provider, model, reasoningEffort } = plan
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.aiCommitTimeoutMs)])
    let text = ''
    let failure: string | null = null
    let inputTokens = 0
    let usageReported = false
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        system: commitSystemPrompt(config.aiCommitLanguage, config.aiCommitExtraPrompt),
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: buildCommitPrompt({
              language: config.aiCommitLanguage,
              repo: input.repo,
              branch: input.branch,
              source: input.source,
              files: input.files,
              pending: input.pending,
              diff: input.diff,
              truncated: input.truncated,
            }),
          }],
        }],
        maxTokens: AI_MAX_TOKENS,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        signal: deadline,
      })) {
        if (chunk.type === 'text-delta') {
          text += chunk.text ?? ''
          if (chunk.text !== undefined && chunk.text !== '') onDelta?.(chunk.text)
        }
        else if (chunk.type === 'usage') {
          // Only a positive count is a measurement: some providers send a usage
          // chunk with no input tokens in it, and "0 tokens" is not a fact.
          const reported = chunk.usage?.inputTokens ?? 0
          if (reported > 0) {
            usageReported = true
            inputTokens = reported
          }
        }
        else if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'tool-calls' && chunk.reason?.kind !== 'max-tokens') {
          failure = chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'the model call failed'
        }
      }
    } catch (error: unknown) {
      if (deadline.aborted) {
        throw new RouteError(504, `the model did not answer within ${String(config.aiCommitTimeoutMs)} ms`)
      }
      throw new RouteError(502, error instanceof Error ? error.message : String(error))
    }
    const message = sanitizeCommitMessage(text)
    if (message === '') throw new RouteError(502, failure ?? 'the model returned an empty commit message')
    if (failure !== null && text.trim() === '') throw new RouteError(502, failure)
    // The reply is the message, so a real truncation is a wrong commit message:
    // the panel has to see it rather than quietly commit a cut-off subject.
    const cut = message.length >= MAX_COMMIT_MESSAGE
    return {
      message,
      provider,
      model,
      source: input.source,
      files: input.files.length,
      added: input.files.reduce((total, file) => total + (file.added ?? 0), 0),
      deleted: input.files.reduce((total, file) => total + (file.deleted ?? 0), 0),
      untracked: input.untracked.length,
      truncated: input.truncated || cut,
      inputTokens,
      usageReported,
    }
  }

  /** The `/commit-message` route: one draft, keyed to the same header as writes. */
  const handleCommitMessage = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> => {
    if (req.headers[ACTION_HEADER] === undefined) {
      throw new RouteError(403, `missing ${ACTION_HEADER} header`)
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new RouteError(415, 'a commit-message draft requires content-type: application/json')
    }
    const body = await readJsonBody(req)
    const dir = allowDirectory(typeof body.dir === 'string' ? body.dir : null)
    const plan = await planCommitDraft(dir, body.staged === true, signal, readModelChoice(body))
    sendJson(res, 200, { ok: true, ...await runCommitDraft(plan, signal) })
  }

  /**
   * The streaming draft route: the same draft, as server-sent events.
   *
   * It stays a POST with the panel's header, so a stray page cannot burn model
   * tokens the way a plain GET stream could; the client reads the body with
   * `fetch`, not EventSource. Everything that can fail before the model is
   * asked still fails as a plain JSON error; only the model's own output and
   * its failures travel as frames.
   */
  const handleCommitMessageStream = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> => {
    if (req.headers[ACTION_HEADER] === undefined) {
      throw new RouteError(403, `missing ${ACTION_HEADER} header`)
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new RouteError(415, 'a commit-message draft requires content-type: application/json')
    }
    const body = await readJsonBody(req)
    const dir = allowDirectory(typeof body.dir === 'string' ? body.dir : null)
    const plan = await planCommitDraft(dir, body.staged === true, signal, readModelChoice(body))
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const frame = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    frame('begin', {
      source: plan.input.source,
      files: plan.input.files.length,
      added: plan.input.files.reduce((total, file) => total + (file.added ?? 0), 0),
      deleted: plan.input.files.reduce((total, file) => total + (file.deleted ?? 0), 0),
      untracked: plan.input.untracked.length,
      truncated: plan.input.truncated,
    })
    // A cancelled draft must stop the model call, not just the display.
    const closer = new AbortController()
    req.once('close', () => { closer.abort() })
    try {
      const draft = await runCommitDraft(plan, AbortSignal.any([signal, closer.signal]), (piece) => {
        frame('delta', { text: piece })
      })
      frame('done', draft)
    } catch (error: unknown) {
      frame('error', {
        message: error instanceof Error ? error.message : String(error),
        ...(closer.signal.aborted ? { cancelled: true } : {}),
      })
    }
    res.end()
  }

  /**
   * Remember the panel's model pick as profile configuration.
   *
   * Persisting goes through the settings service, the same mechanism the
   * settings page uses, so the choice is live for every browser on this
   * profile and shows up in the settings UI. With no settings service the
   * answer says so, and the panel falls back to remembering locally.
   */
  const handlePrefs = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers[ACTION_HEADER] === undefined) {
      throw new RouteError(403, `missing ${ACTION_HEADER} header`)
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new RouteError(415, 'prefs requires content-type: application/json')
    }
    const body = await readJsonBody(req)
    const choice = readModelChoice(body)
    const settings = ctx.get('settings') as SettingsFace | undefined
    if (settings === undefined) {
      sendJson(res, 200, { ok: true, persisted: false, reason: 'no-settings-service' })
      return
    }
    try {
      await settings.update(SETTINGS_NS, {
        aiCommitProvider: choice.provider ?? '',
        aiCommitModel: choice.model ?? '',
      })
      sendJson(res, 200, { ok: true, persisted: true })
    } catch (error: unknown) {
      sendJson(res, 200, {
        ok: true,
        persisted: false,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * The durable per-repo summary store.
   *
   * Each project is cached on its own fingerprint — the hash of the signals
   * the summary was written from — so a busy repository costs a rewrite of
   * its own line while quiet ones keep theirs. The file survives restarts;
   * the old in-memory whole-set cache did not.
   */
  interface SummaryStoreEntry {
    fingerprint: string
    summary: string
    provider: string
    model: string
    at: number
  }
  type SummaryStore = Record<string, SummaryStoreEntry>

  /** The default store location; tests point the override at a sandbox. */
  const DEFAULT_SUMMARY_STORE_PATH = join(homedir(), '.dsh', 'git-panel', 'summaries.json')
  const summaryStorePath = (): string => process.env.DSH_GIT_PANEL_SUMMARY_STORE ?? DEFAULT_SUMMARY_STORE_PATH

  /** The fingerprint of a summary: exactly the signals it was written from. */
  const summaryFingerprint = (provider: string, model: string, repo: ProjectSignal): string =>
    createHash('sha1')
      .update(`${provider}\0${model}\0${repo.title}\0${repo.description ?? ''}\0${repo.readme ?? ''}\0${repo.commits.join('\x1f')}`)
      .digest('hex')
      .slice(0, 16)

  const readSummaryStore = (): SummaryStore => {
    try {
      const parsed = JSON.parse(readFileSync(summaryStorePath(), 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object') return {}
      return parsed as SummaryStore
    } catch {
      // A missing or corrupt store is an empty one; the next write repairs it.
      return {}
    }
  }

  const writeSummaryStore = (store: SummaryStore): void => {
    try {
      mkdirSync(dirname(summaryStorePath()), { recursive: true })
      const tmp = `${summaryStorePath()}.tmp`
      writeFileSync(tmp, JSON.stringify(store, null, 1))
      renameSync(tmp, summaryStorePath())
    } catch {
      // A store that cannot be written only costs persistence, not the panel.
    }
  }

  /**
   * Read the small facts a one-line project summary is written from.
   *
   * package.json's `description`, the README's first breath, and the last
   * three commit subjects — bounded per repo so a dozen repos still fit one
   * prompt. Reading the files directly (not through git) keeps non-repos cheap.
   */
  const collectProjectSignals = async (signal: AbortSignal): Promise<{ root: string; repo: ProjectSignal }[]> => {
    const out: { root: string; repo: ProjectSignal }[] = []
    const workspaces = host.workspaceRegistry.list()
    let index = 0
    for (const workspace of workspaces) {
      const root = allowDirectory(workspace.path)
      index += 1
      let description: string | null = null
      try {
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { description?: unknown }
        if (typeof manifest.description === 'string' && manifest.description.trim() !== '') {
          description = manifest.description.trim().slice(0, 200)
        }
      } catch {
        // No manifest, or one that will not parse: other signals carry it.
      }
      let readme: string | null = null
      for (const name of ['README.md', 'README_CN.md', 'readme.md']) {
        try {
          const text = readFileSync(join(root, name), 'utf8')
          const head = text.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 400)
          if (head !== '') {
            readme = head
            break
          }
        } catch {
          // Try the next name.
        }
      }
      const subjects = await runGit(['log', '--max-count=3', '--format=%s'], { cwd: root, signal })
      const commits = subjects.exitCode === 0
        ? subjects.stdout.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, 3)
        : []
      out.push({
        root,
        repo: { index, title: workspace.title || basename(root), description, readme, commits },
      })
    }
    return out
  }

  /** What `POST /project-summaries` answers. */
  interface ProjectSummariesPayload {
    ok: true
    summaries: Record<string, string | null>
    provider: string
    model: string
    /** True when the answer came from the in-memory cache. */
    cached: boolean
    truncated: boolean
    /**
     * Why the projects that have no line still have none, when a batch failed
     * after some projects were already answered. A failed batch is not a failed
     * answer: the stored lines travel anyway, and this says what went wrong.
     */
    error?: string
    /** How many projects the failed batch was meant to write. */
    failed?: number
  }

  const handleProjectSummaries = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> => {
    if (req.headers[ACTION_HEADER] === undefined) {
      throw new RouteError(403, `missing ${ACTION_HEADER} header`)
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw new RouteError(415, 'project summaries require content-type: application/json')
    }
    if (config.aiCommitEnabled !== true) {
      throw new RouteError(403, 'the AI features are disabled by this profile\'s plugin configuration')
    }
    const body = await readJsonBody(req)
    const force = body.force === true
    const llm = ctx.get('llm') as LlmFace | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new RouteError(503, 'this profile has no model adapter mounted')
    }
    const choice = readModelChoice(body)
    const { provider, model } = resolveModelChoice(choice)
    const reasoningEffort = resolveReasoningEffort(choice)
    const signals = await collectProjectSignals(signal)
    // Which projects need a rewrite: new ones, changed ones, forced ones.
    // Everyone else is answered from the store without touching the model.
    const store = readSummaryStore()
    // A workspace that left the registry takes its summary with it: the store
    // describes the projects there are, not every project there ever was.
    const present = new Set(signals.map(entry => entry.root))
    let pruned = false
    for (const root of Object.keys(store)) {
      if (!present.has(root)) {
        delete store[root]
        pruned = true
      }
    }
    if (pruned) writeSummaryStore(store)
    const fingerprints = new Map(signals.map(entry => [entry.root, summaryFingerprint(provider, model, entry.repo)]))
    const stale = signals.filter((entry) => {
      if (force) return true
      const kept = store[entry.root]
      return kept === undefined || kept.fingerprint !== fingerprints.get(entry.root)
    })
    // A model call that fails costs the projects it was meant to write, not the
    // ones the store already answers: the batch is one call, but the answer is
    // settled per project. `modelError` remembers the failure so the payload can
    // say why some cards still have no line.
    let modelError: string | null = null
    let modelTimedOut = false
    if (stale.length > 0) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.aiCommitTimeoutMs)])
      let text = ''
      let failure: string | null = null
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          system: '你是一句中文项目简介写手。只输出要求的内容。',
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: buildSummaryPrompt(stale.map(entry => entry.repo), config.aiCommitLanguage) }],
          }],
          maxTokens: 1_200,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          signal: deadline,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text ?? ''
          else if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'max-tokens') {
            failure = chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'the model call failed'
          }
        }
      } catch (error: unknown) {
        // A timeout is the same result whether the caller walked away or the
        // model went quiet; either way the store still answers what it knows.
        if (deadline.aborted) {
          modelTimedOut = true
          modelError = `the model did not answer within ${String(config.aiCommitTimeoutMs)} ms`
        } else {
          modelError = error instanceof Error ? error.message : String(error)
        }
      }
      if (modelError === null && text.trim() === '' && failure !== null) modelError = failure
      if (modelError === null) {
        const lines = parseSummaryLines(text, stale.length)
        stale.forEach((entry, position) => {
          const summary = lines[position]
          if (summary === null || summary === undefined) return
          store[entry.root] = {
            fingerprint: fingerprints.get(entry.root) ?? '',
            summary,
            provider,
            model,
            at: Date.now(),
          }
        })
        writeSummaryStore(store)
      }
    }
    const summaries: Record<string, string | null> = {}
    for (const entry of signals) summaries[entry.root] = store[entry.root]?.summary ?? null
    // Nothing stored at all *and* the model refused: there is no answer to hand
    // back, so the failure is the answer. With anything stored, the cards keep
    // their lines and the reason for the missing ones travels alongside them.
    if (modelError !== null && signals.every(entry => store[entry.root] === undefined)) {
      throw new RouteError(modelTimedOut ? 504 : 502, modelError)
    }
    sendJson(res, 200, {
      ok: true,
      summaries,
      provider,
      model,
      cached: stale.length === 0,
      truncated: signals.some(entry => store[entry.root] === undefined),
      ...modelError === null ? {} : { error: modelError, failed: stale.length },
    } satisfies ProjectSummariesPayload)
  }

  /**
   * Read the model a request asks for.
   *
   * A route name is not a path or a shell word: one line, bounded, and never
   * silently trimmed into something else.
   */
  const readModelChoice = (body: Record<string, unknown>): { provider?: string; model?: string; reasoningEffort?: string } => {
    const read = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null || value === '') return undefined
      if (typeof value !== 'string') throw new RouteError(400, `${field} must be a string`)
      const trimmed = value.trim()
      if (trimmed === '') return undefined
      if (trimmed.length > 120 || /[\u0000-\u001f]/.test(trimmed)) {
        throw new RouteError(400, `${field} must be a single line of at most 120 characters`)
      }
      return trimmed
    }
    return {
      provider: read(body.provider, 'provider'),
      model: read(body.model, 'model'),
      reasoningEffort: read(body.reasoningEffort, 'reasoningEffort'),
    }
  }

  /**
   * The reasoning effort one AI call asks for: the request's own, else the
   * plugin's configuration, else nothing at all.
   *
   * "Nothing at all" is deliberately passed through as an *omitted* option
   * rather than as `off`: naming `off` is a request to disable thinking, which
   * some routes now refuse outright.
   */
  const resolveReasoningEffort = (choice: { reasoningEffort?: string }): string | undefined => {
    if (choice.reasoningEffort !== undefined) return choice.reasoningEffort
    const configured = configField(config.aiCommitReasoningEffort)
    const trimmed = typeof configured === 'string' ? configured.trim() : ''
    return trimmed === '' ? undefined : trimmed
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const signal = AbortSignal.timeout(config.timeoutMs * 2 + 1_000)
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === `${ROUTE_PREFIX}/action`) {
        if (req.method !== 'POST') throw new RouteError(405, 'action requires POST')
        await handleAction(req, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/commit-message`) {
        if (req.method !== 'POST') throw new RouteError(405, 'a commit-message draft requires POST')
        await handleCommitMessage(req, res, signal)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/commit-message/stream`) {
        if (req.method !== 'POST') throw new RouteError(405, 'a streaming draft requires POST')
        await handleCommitMessageStream(req, res, signal)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/prefs`) {
        if (req.method !== 'POST') throw new RouteError(405, 'prefs requires POST')
        await handlePrefs(req, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/project-summaries`) {
        if (req.method !== 'POST') throw new RouteError(405, 'project summaries require POST')
        await handleProjectSummaries(req, res, signal)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/events`) {
        if (req.method !== 'GET') throw new RouteError(405, 'events requires GET')
        await handleEvents(req, res, url)
        return
      }
      if (req.method !== 'GET') throw new RouteError(405, 'reads are GET-only')
      if (url.pathname === `${ROUTE_PREFIX}/overview`) {
        await handleOverview(signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/status`) {
        await handleStatus(allowDirectory(url.searchParams.get('dir')), signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/diff`) {
        await handleDiff(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/context`) {
        await handleContext(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/models`) {
        sendJson(res, 200, {
          ok: true,
          ...await collectModels(),
          remembered: readPickedModel(ctx.get('settings') as SettingsFace | undefined),
        })
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/log`) {
        await handleLog(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/branches`) {
        await handleBranches(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/stashes`) {
        await handleStashes(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/blame`) {
        await handleBlame(url.searchParams, signal, res)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/show`) {
        await handleShow(url.searchParams, signal, res)
        return
      }
      throw new RouteError(404, 'unknown route')
    } catch (error: unknown) {
      // A stream that already wrote its headers cannot become a JSON error.
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof RouteError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The panel's read paths, offered to other plugins as `ctx.gitPanel`.
   *
   * Only reads are exposed here. The write actions stay behind the panel's own
   * confirmation flow: a service call from another plugin has no user attached
   * to it, and `discard`/`stash` destroy uncommitted work.
   */
  const service = {
    /** Every registered workspace with its repository state. */
    overview: (): Promise<{ ok: true; entries: OverviewEntry[] }> =>
      collectOverview(AbortSignal.timeout(config.timeoutMs * 2 + 1_000)),
    /** One repository's state, or its not-a-repository answer. */
    status: (dir: string, lineCounts = true): Promise<StatusPayload> =>
      readStatus(allowDirectory(dir), AbortSignal.timeout(config.timeoutMs * 2 + 1_000), lineCounts),
      /** Draft a commit message for what is staged (or for every uncommitted change). */
    commitMessage: async (
      dir: string,
      stagedOnly = false,
      choice: { provider?: string; model?: string } = {},
    ): Promise<CommitMessageDraft> => {
      const signal = AbortSignal.timeout(config.aiCommitTimeoutMs + 5_000)
      return runCommitDraft(await planCommitDraft(allowDirectory(dir), stagedOnly, signal, choice), signal)
    },
    /** The provider routes and models a draft may be pointed at. */
    models: (): Promise<ModelCatalog> => collectModels(),

  /** One file's unified diff, from the work tree or from a commit. */
    diff: async (dir: string, target: { path: string; staged?: boolean; untracked?: boolean; hash?: string; parent?: number }): Promise<string> => {
      const collected = await collectDiff(allowDirectory(dir), {
        path: target.path,
        staged: target.staged === true,
        untracked: target.untracked === true,
        ...(target.hash === undefined ? {} : { hash: target.hash }),
        ...(target.parent === undefined ? {} : { parent: target.parent }),
      }, AbortSignal.timeout(config.timeoutMs * 2 + 1_000))
      return collected.text
    },
    /** A repository's history, newest first. */
    log: async (dir: string, limit = DEFAULT_LOG_LIMIT): Promise<CommitEntry[]> => {
      const collected = await collectLog(allowDirectory(dir), {
        limit, skip: 0, all: false,
      }, AbortSignal.timeout(config.timeoutMs * 2 + 1_000))
      return collected.commits
    },
    /** One page of history, paged or filtered: what the history view reads. */
    logPage: async (dir: string, query: Partial<LogQuery> = {}): Promise<LogPayload> => collectLog(
      allowDirectory(dir),
      { limit: DEFAULT_LOG_LIMIT, skip: 0, all: false, ...query },
      AbortSignal.timeout(config.timeoutMs * 2 + 1_000),
    ),
    /** A repository's local branches, newest tip first. */
    branches: async (dir: string): Promise<BranchesPayload> => collectBranches(
      allowDirectory(dir),
      AbortSignal.timeout(config.timeoutMs * 2 + 1_000),
    ),
    /** A repository's stash entries, newest first. */
    stashes: async (dir: string): Promise<StashesPayload> => collectStashes(
      allowDirectory(dir),
      AbortSignal.timeout(config.timeoutMs * 2 + 1_000),
    ),
    /** Line-by-line attribution of one committed file. */
    blame: async (dir: string, path: string): Promise<BlamePayload> => collectBlame(
      allowDirectory(dir),
      path,
      AbortSignal.timeout(config.timeoutMs * 2 + 1_000),
    ),
    /** One commit and the files it touched. */
    show: async (dir: string, hash: string, parent?: number): Promise<{ commit: CommitEntry | null; files: CommitFile[] }> => {
      const collected = await collectShow(
        allowDirectory(dir), hash, AbortSignal.timeout(config.timeoutMs * 2 + 1_000), parent,
      )
      return { commit: collected.commit, files: collected.files }
    },
  }
  ctx.provide('gitPanel', service)

  // The model-facing half: two read-only tools, so an agent can answer "what is
  // uncommitted here" without a shell. Writes stay in the panel, where the user
  // is the one who confirms them.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = [
        toolCtx.tools.register(defineTool({
          name: 'git_status',
          description: 'Read git working-tree state: every registered workspace (no dir), or one repository\'s branch, upstream, ahead/behind and changed files.',
          parameters: {
            dir: { type: 'string', description: 'Absolute path of a registered workspace. Omit to list every workspace at once.' },
            line_counts: { type: 'boolean', description: 'Include per-file added/deleted counts (two extra git calls). Defaults to true for one repository.' },
          },
          output: {
            schema: { type: 'json' },
            render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args): Promise<ToolJson> => {
            // Every field is spelled out, and absent facts become null rather
            // than a missing key: the tool result must be plain JSON.
            if (args.dir === undefined || args.dir === '') {
              const all = await service.overview()
              return {
                workspaces: all.entries.map(entry => ({
                  title: entry.workspace.title,
                  path: entry.workspace.path,
                  reason: entry.reason ?? null,
                  repo: entry.repo === null ? null : {
                    branch: entry.repo.branch,
                    detached: entry.repo.detached,
                    upstream: entry.repo.upstream,
                    ahead: entry.repo.ahead,
                    behind: entry.repo.behind,
                  },
                  counts: { ...entry.counts },
                })),
              }
            }
            const status = await service.status(args.dir, args.line_counts !== false)
            if (status.repo === null) {
              return { repo: null, reason: 'not-a-repository', counts: { ...status.counts }, files: [], truncated: false }
            }
            // Interfaces are not assignable to an index-signature JSON type, so
            // every value is rebuilt as a plain literal here.
            return {
              repo: {
                root: status.repo.root,
                name: status.repo.name,
                branch: status.repo.branch,
                detached: status.repo.detached,
                head: status.repo.head,
                upstream: status.repo.upstream,
                ahead: status.repo.ahead,
                behind: status.repo.behind,
              },
              counts: { ...status.counts },
              files: status.files.map(file => ({
                path: file.path,
                index: file.index,
                worktree: file.worktree,
                untracked: file.untracked,
                unmerged: file.unmerged,
              })),
              // `StatusPayload.truncated` is optional, and `undefined` is not
              // JSON: the tool result spells it out.
              truncated: status.truncated === true,
            }
          },
        })),
        toolCtx.tools.register(defineTool({
          name: 'git_diff',
          description: 'Read one file\'s unified diff in a registered workspace. Answers are truncated to a bounded number of lines.',
          parameters: {
            dir: { type: 'string', required: true, description: 'Absolute path of a registered workspace.' },
            path: { type: 'string', required: true, description: 'Repository-relative path of the file.' },
            staged: { type: 'boolean', description: 'Diff HEAD against the index instead of against the work tree.' },
            untracked: { type: 'boolean', description: 'Read the file as a pure addition (use it for an untracked file).' },
            hash: { type: 'string', description: 'Read the diff of this commit instead of the checkout.' },
            max_lines: { type: 'number', description: 'How many diff lines to return, 1..2000. Defaults to 400.' },
          },
          output: {
            schema: { type: 'json' },
            render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args): Promise<ToolJson> => {
            const max = args.max_lines === undefined ? TOOL_DIFF_LINES : Math.max(1, Math.min(2_000, Math.trunc(args.max_lines)))
            const text = await service.diff(args.dir, {
              path: args.path,
              staged: args.staged === true,
              untracked: args.untracked === true,
              ...(args.hash === undefined ? {} : { hash: args.hash }),
            })
            const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
            return {
              path: args.path,
              staged: args.staged === true,
              hash: args.hash ?? null,
              lines: lines.slice(0, max),
              total_lines: lines.length,
              truncated: lines.length > max,
              note: lines.length > max ? `showing the first ${String(max)} of ${String(lines.length)} lines` : null,
            }
          },
        })),
        toolCtx.tools.register(defineTool({
          name: 'git_commit_message',
          description: 'Draft a Chinese commit message for a repository\'s changes with the configured model. Text only: it never stages, commits, or pushes, and it costs one model call.',
          parameters: {
            dir: { type: 'string', required: true, description: 'Absolute path of a registered workspace.' },
            staged: { type: 'boolean', description: 'Read only the staged changes instead of every uncommitted change.' },
            provider: { type: 'string', description: 'Provider to draft with (defaults to the panel\'s remembered choice, then the profile default).' },
            model: { type: 'string', description: 'Model id to draft with.' },
          },
          output: {
            schema: { type: 'json' },
            render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args): Promise<ToolJson> => {
            const draft = await service.commitMessage(args.dir, args.staged === true, {
              ...(typeof args.provider === 'string' && args.provider !== '' ? { provider: args.provider } : {}),
              ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
            })
            return {
              message: draft.message,
              provider: draft.provider,
              model: draft.model,
              source: draft.source,
              files: draft.files,
              untracked: draft.untracked,
              truncated: draft.truncated,
              input_tokens: draft.usageReported ? draft.inputTokens : null,
              note: 'draft only — staging, committing and pushing stay with the user',
            }
          },
        })),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, `${name}: tools`)
  })

  ctx.effect(() => {
    const unregister = host.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    return () => {
      // Unloading must not leave a git child running with no one to report to.
      dispose.abort()
      unregister()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    }
  }, `${name}: api`)
}
