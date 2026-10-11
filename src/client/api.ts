/**
 * The Host HTTP surface this panel reads, plus its fetch helpers.
 *
 * The shapes mirror the JSON the host half answers from `/api/git-panel/*`;
 * the two files are the contract, so a field renamed here must be renamed
 * there.
 */

/** One registered profile workspace the panel can inspect. */
export interface WorkspaceOption {
  id: string
  title: string
  path: string
}

/** Per-file line counts; `binary` marks a file git refuses to count. */
export interface LineCounts {
  added: number
  deleted: number
  binary: boolean
}

/** One work-tree entry. */
export interface GitFileEntry {
  path: string
  originalPath?: string
  /** Index (staged) status character, `.` when unchanged. */
  index: string
  /** Work-tree status character, `.` when unchanged. */
  worktree: string
  untracked: boolean
  unmerged: boolean
  staged: LineCounts | null
  unstaged: LineCounts | null
}

/** Branch facts for the repository enclosing the inspected directory. */
export interface GitRepoSummary {
  root: string
  name: string
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  detached: boolean
  head: string
  upstream: string | null
  ahead: number
  behind: number
}

/** How many entries each work-tree group holds. */
export interface WorkTreeCounts {
  staged: number
  changed: number
  untracked: number
  conflicted: number
}

/** The tally and file list of one repository. */
/** An in-progress merge/cherry-pick/revert/rebase, when there is one. */
export interface OperationState {
  kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase'
  /** Files still unmerged; continuing is only possible at zero. */
  unmerged: number
}

export interface GitStatus {
  ok: true
  repo: GitRepoSummary | null
  reason?: string
  truncated?: boolean
  files: GitFileEntry[]
  counts: WorkTreeCounts
  operation: OperationState | null
}

/** One card of the overview grid. */
export interface OverviewEntry {
  workspace: WorkspaceOption
  repo: GitRepoSummary | null
  counts: WorkTreeCounts
  /** `not-a-repository` for a plain directory, `unavailable` when git refused to answer. */
  reason?: string
  error?: string
}

/** One file's comparison against the index or HEAD. */
export interface GitDiff {
  ok: true
  kind: 'text' | 'binary' | 'empty'
  path: string
  staged: boolean
  text: string
  truncated: boolean
}

/** Which repository state one file's comparison is taken against. */
export interface DiffTarget {
  path: string
  /** For a merge commit: which parent to compare against. */
  parent?: number
  /** For a range read: the older commit to compare against. */
  base?: string
  staged: boolean
  untracked: boolean
  /** Read the diff from this commit instead of from the checkout. */
  hash?: string
}

/** True for a fetch that was cancelled by its own AbortController. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Read one JSON answer, turning a rejection payload into an Error. */
async function getJson<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url.toString(), { signal, headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(payload?.error ?? `request failed (HTTP ${String(response.status)})`)
  }
  return payload as T
}

/**
 * Read every registered workspace's repository state in one request.
 * @param signal - cancellation.
 * @returns one entry per workspace, in registry order.
 */
export async function fetchOverview(signal?: AbortSignal): Promise<OverviewEntry[]> {
  const payload = await getJson<{ entries: OverviewEntry[] }>('/api/git-panel/overview', {}, signal)
  return payload.entries
}

/**
 * Read one directory's repository state, including per-file line counts.
 * @param dir - a registered workspace directory.
 * @param signal - cancellation.
 * @returns branch facts, work-tree entries, and the tally.
 */
export function fetchStatus(dir: string, signal?: AbortSignal): Promise<GitStatus> {
  return getJson<GitStatus>('/api/git-panel/status', { dir }, signal)
}

/** Actions that only touch the remote's view of the repository. */
export type RemoteAction = 'fetch' | 'pull' | 'push'

/**
 * Actions that change this checkout: its index, its work tree, or its history.
 * None of them can reach a remote, and none deletes an untracked file.
 */
export type LocalAction = 'stage' | 'unstage' | 'discard' | 'stash' | 'commit'
  | 'stashApply' | 'stashPop' | 'stashDrop' | 'abortOperation' | 'continueOperation'
  | 'checkout'

/** Every action the panel may ask the host to run. */
export type ActionName = RemoteAction | LocalAction

/** The optional parameters a local action carries. */
export interface ActionRequest {
  /** Required by `push`, `discard` and `stash`: the panel asked the user first. */
  confirm?: boolean
  /** Repository-relative paths for `stage`, `unstage`, `discard`, and `commit`. */
  paths?: string[]
  /** The commit message, or the stash message. */
  message?: string
  /** Whether `stash` also takes untracked files with it. */
  includeUntracked?: boolean
  /** The stash entry `stashApply` / `stashPop` / `stashDrop` act on, e.g. `stash@{0}`;
   * for `checkout`, the branch to switch to. */
  ref?: string
  /** `checkout`: create the branch instead of switching to an existing one. */
  create?: boolean
}

/** One git command an action ran, with its own verdict. */
export interface ActionStep {
  command: string[]
  exitCode: number | null
  succeeded: boolean
  stdout: string
  stderr: string
  truncated: boolean
}

/** What one fetch/pull/push hands back. */
export interface ActionResult {
  /** The request was served; this is not git's verdict. */
  ok: true
  action: ActionName
  /** The exact argv that ran, for the log. */
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

/**
 * Run one git action in a repository.
 * @param dir - a registered workspace directory.
 * @param action - which action to run.
 * @param request - the action's parameters. `confirm` is the user's answer to
 *   the confirmation the host demands for `push`, `discard` and `stash`; the
 *   host refuses those without it.
 * @returns the outcome; a git failure resolves with `succeeded: false`.
 */
/** One provider route and the models it advertises. */
export interface ModelCatalogEntry {
  provider: string
  providerName: string
  models: Array<{ id: string; name: string }>
  /** Why this provider's group is empty, when it could not be read. */
  error?: string
}

/** The model the panel remembered, as the host reports it. */
export interface ModelChoice {
  provider: string
  model: string
}

/** Every model a commit-message draft could be pointed at. */
export interface ModelCatalog {
  default: { provider: string; model: string } | null
  providers: ModelCatalogEntry[]
  /** The pick the panel remembered as profile configuration, if any. */
  remembered?: ModelChoice | null
}

/** The provider routes and models the picker offers. */
export async function fetchModels(signal?: AbortSignal): Promise<ModelCatalog> {
  return getJson<ModelCatalog>('/api/git-panel/models', {}, signal)
}

/** What `POST /project-summaries` answers: one line per workspace. */
export interface ProjectSummaries {
  ok: true
  summaries: Record<string, string | null>
  provider: string
  model: string
  /** True when the answer came from the host's in-memory cache. */
  cached: boolean
  truncated: boolean
  /**
   * Why the workspaces without a line still have none, when the model call for
   * them failed. The stored lines are answered regardless.
   */
  error?: string
  /** How many workspaces the failed call was meant to write. */
  failed?: number
}

/**
 * One-line "what is this project" for every workspace, from one model call.
 *
 * The host batches every workspace's signals (package description, README
 * head, recent commit subjects) into a single prompt and caches by content
 * fingerprint, so re-opening the overview does not re-spend the call.
 *
 * @param force - bypass the cache and re-summarize.
 * @returns the map from workspace path to its one-liner.
 */
export async function fetchProjectSummaries(force = false): Promise<ProjectSummaries> {
  const response = await fetch('/api/git-panel/project-summaries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify(force ? { force: true } : {}),
  })
  const payload = await response.json().catch(() => null) as (ProjectSummaries & { error?: string }) | null
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(payload?.error ?? `request failed (HTTP ${String(response.status)})`)
  }
  return payload
}

/**
 * Remember the model pick on the host, as profile configuration.
 *
 * The host writes through the settings service — the same mechanism the
 * settings page uses — so the choice holds for every browser on this profile.
 * `persisted: false` means there is no settings service (or it refused), and
 * the panel keeps the choice in this browser instead.
 */
export async function savePrefs(choice: ModelChoice | null): Promise<{ persisted: boolean; reason?: string }> {
  const response = await fetch('/api/git-panel/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify(choice ?? {}),
  })
  const payload = await response.json().catch(() => null) as { ok?: boolean; persisted?: boolean; reason?: string; error?: string } | null
  if (!response.ok || payload === null || payload.ok !== true) {
    return { persisted: false, reason: payload?.error ?? `request failed (HTTP ${String(response.status)})` }
  }
  return { persisted: payload.persisted === true, ...(payload.reason === undefined ? {} : { reason: payload.reason }) }
}

/** One AI commit-message draft, as the host built it. */
export interface CommitMessageDraft {
  message: string
  provider: string
  model: string
  /** The index, or the whole work tree when nothing is staged. */
  source: 'staged' | 'all'
  files: number
  added: number
  deleted: number
  untracked: number
  truncated: boolean
  inputTokens: number
  /** False when the provider reported no usage; the note says so instead of "0". */
  usageReported: boolean
}

/** What the streaming draft's first frame reports. */
export interface DraftBegin {
  source: 'staged' | 'all'
  files: number
  added: number
  deleted: number
  untracked: number
  truncated: boolean
}

/** Callbacks for the pieces of a streaming draft. */
export interface DraftStreamHandlers {
  /** The model call is starting; this is what it will read. */
  onBegin?: (info: DraftBegin) => void
  /** One raw piece of the message, as the model wrote it. */
  onDelta?: (text: string) => void
}

/**
 * Ask the host for a commit message and watch it being written.
 *
 * Same draft as {@link fetchCommitMessage}, streamed as server-sent events
 * over a POST (so the panel's header still guards it; this is read with
 * `fetch`, not EventSource). The returned promise resolves to the final,
 * sanitized draft — the same answer the plain route gives.
 *
 * @param dir - a registered workspace directory.
 * @param request - the draft choice: staged-only and/or a provider+model.
 * @param handlers - frame callbacks: `begin` before the model starts, `delta`
 *   per raw piece.
 * @param signal - cancellation; aborting also stops the model call.
 * @returns the finished draft.
 */
export async function streamCommitMessage(
  dir: string,
  request: { staged?: boolean; provider?: string; model?: string } = {},
  handlers: DraftStreamHandlers = {},
  signal?: AbortSignal,
): Promise<CommitMessageDraft> {
  const response = await fetch('/api/git-panel/commit-message/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify({ dir, ...request }),
    ...(signal === undefined ? {} : { signal }),
  })
  // Pre-stream failures are plain JSON; only frames come as event-stream.
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    const failure = new Error(payload?.error ?? `request failed (HTTP ${String(response.status)})`)
    failure.name = response.status === 404 ? 'StreamUnavailable' : 'DraftError'
    throw failure
  }
  if (response.body === null) throw new Error('the stream had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let draft: CommitMessageDraft | null = null
  let failure: string | null = null
  const handle = (chunk: string): void => {
    for (const part of chunk.split('\n\n')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const lines = trimmed.split('\n')
      const event = lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message'
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      if (data === '') continue
      const payload = JSON.parse(data) as Record<string, unknown>
      if (event === 'begin') handlers.onBegin?.(payload as unknown as DraftBegin)
      else if (event === 'delta') handlers.onDelta?.(String(payload.text ?? ''))
      else if (event === 'done') draft = payload as unknown as CommitMessageDraft
      else if (event === 'error') failure = String(payload.message ?? 'the draft failed')
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lastBreak = buffer.lastIndexOf('\n\n')
    if (lastBreak === -1) continue
    handle(buffer.slice(0, lastBreak + 2))
    buffer = buffer.slice(lastBreak + 2)
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') handle(buffer)
  if (failure !== null) throw new Error(failure)
  if (draft === null) throw new Error('the stream ended without a draft')
  return draft
}

/**
 * Ask the host for a commit message drafted from the repository's changes.
 *
 * This only ever returns text: staging, committing and pushing stay with the
 * user, and the draft lands in the message box for them to edit first.
 */
export async function fetchCommitMessage(
  dir: string,
  options: { staged?: boolean; provider?: string; model?: string } = {},
): Promise<CommitMessageDraft> {
  const response = await fetch('/api/git-panel/commit-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify({
      dir,
      staged: options.staged === true,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    }),
  })
  const body = await response.json() as CommitMessageDraft & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `commit message draft failed (${String(response.status)})`)
  return body
}

export async function runAction(dir: string, action: ActionName, request: ActionRequest = {}): Promise<ActionResult> {
  const response = await fetch('/api/git-panel/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify({ dir, action, ...request }),
  })
  const payload = await response.json().catch(() => null) as (ActionResult & { error?: string }) | null
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(payload?.error ?? `request failed (HTTP ${String(response.status)})`)
  }
  return payload
}

/**
 * Read one file's unified diff.
 * @param dir - a registered workspace directory.
 * @param target - the file and the state to compare against.
 * @param signal - cancellation.
 * @returns the diff payload.
 */
export function fetchDiff(dir: string, target: DiffTarget, signal?: AbortSignal): Promise<GitDiff> {
  return getJson<GitDiff>('/api/git-panel/diff', {
    dir,
    path: target.path,
    staged: target.staged ? '1' : '0',
    untracked: target.untracked ? '1' : '0',
    ...(target.hash === undefined ? {} : { hash: target.hash }),
    ...(target.parent === undefined ? {} : { parent: String(target.parent) }),
    ...(target.base === undefined ? {} : { base: target.base }),
  }, signal)
}

/** A slice of a file's unchanged lines, used to open a collapsed gap. */
export interface ContextSlice {
  ok: true
  /** The 1-based line the slice starts at. */
  start: number
  lines: string[]
  /** True when the slice reached the end of the file. */
  eof: boolean
  /** Total lines in the source, when it could be read. */
  total?: number
  /** The file or blob is not there (deleted, or absent from the index). */
  missing?: boolean
  binary?: boolean
  tooLarge?: boolean
}

/**
 * Read unchanged lines around a gap in the diff.
 * @param dir - a registered workspace directory.
 * @param target - the file and the state the diff is taken against.
 * @param start - 1-based first line to read.
 * @param count - how many lines to read.
 * @param signal - cancellation.
 * @returns the slice; a missing file comes back as `missing: true`, not an error.
 */
export function fetchContext(
  dir: string,
  target: DiffTarget,
  start: number,
  count: number,
  signal?: AbortSignal,
): Promise<ContextSlice> {
  return getJson<ContextSlice>('/api/git-panel/context', {
    dir,
    path: target.path,
    staged: target.staged ? '1' : '0',
    untracked: target.untracked ? '1' : '0',
    start: String(start),
    count: String(count),
    ...(target.hash === undefined ? {} : { hash: target.hash }),
  }, signal)
}

/** One commit in a repository's history. */
export interface CommitEntry {
  hash: string
  short: string
  /** Parent hashes, abbreviated; empty for the repository's first commit. */
  parents: string[]
  author: string
  /** ISO-8601 author date. */
  date: string
  /** Branch and tag decorations on this commit. */
  refs: string[]
  subject: string
}

/** A repository's history, newest first. */
export interface CommitLog {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  commits: CommitEntry[]
  truncated: boolean
  /** The page size the host used. */
  limit: number
  /** How many commits this page skipped. */
  skip: number
}

/** One local branch, as the branch list reads it. */
export interface BranchEntry {
  name: string
  short: string
  current: boolean
  upstream: string | null
  /** `[ahead 1, behind 2]`, `[gone]`, or null without an upstream. */
  track: string | null
  date: string
  subject: string
}

/** What `/branches` answers. */
export interface BranchList {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  branches: BranchEntry[]
  /** The checked-out branch, or null when HEAD is detached. */
  current: string | null
  truncated: boolean
}

/** One stash entry, as the stash list reads it. */
export interface StashEntry {
  /** The reflog name, e.g. `stash@{0}`; the only token the stash actions accept back. */
  ref: string
  hash: string
  short: string
  /** ISO-8601 committer date. */
  date: string
  /** The stash message, or `WIP on <branch>: …`. */
  subject: string
}

/** What `/stashes` answers. */
export interface StashList {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  stashes: StashEntry[]
  truncated: boolean
}

/** Which history to read: how much, of what, and filtered how. */
export interface LogQuery {
  limit?: number
  /** Commits to jump over, for paging older history. */
  skip?: number
  /** A branch or tag to read; the current branch when omitted. */
  ref?: string
  /** Read every ref instead of one branch's own history. */
  all?: boolean
  /** Only commits that touched this path. */
  path?: string
  /** Only commits whose author matches. */
  author?: string
  /** Only commits whose message matches, case-insensitively. */
  grep?: string
}

/** One file a commit touched. */
export interface CommitFile {
  path: string
  /** The porcelain status letter: A, M, D, R, C, T. */
  status: string
  previousPath?: string
  added: number
  deleted: number
  binary: boolean
}

/** One commit and the files it touched. */
export interface CommitShow {
  ok: true
  commit: CommitEntry | null
  files: CommitFile[]
  truncated: boolean
  /** Which parent the files were read against, for a merge commit. */
  parent?: number
  /** The older commit the files were read against, for a range read. */
  base?: string
}

/**
 * Read a repository's history.
 * @param dir - a registered workspace directory.
 * @param limit - how many commits to read (1..200).
 * @param signal - cancellation.
 * @returns the log; a repository with no commits answers with an empty list.
 */
export function fetchLog(dir: string, query: LogQuery = {}, signal?: AbortSignal): Promise<CommitLog> {
  return getJson<CommitLog>('/api/git-panel/log', {
    dir,
    limit: String(query.limit ?? 30),
    ...(query.skip === undefined || query.skip === 0 ? {} : { skip: String(query.skip) }),
    ...(query.ref === undefined ? {} : { ref: query.ref }),
    ...(query.all === true ? { all: '1' } : {}),
    ...(query.path === undefined ? {} : { path: query.path }),
    ...(query.author === undefined ? {} : { author: query.author }),
    ...(query.grep === undefined ? {} : { grep: query.grep }),
  }, signal)
}

/**
 * Read a repository's local branches.
 * @param dir - a registered workspace directory.
 * @param signal - cancellation.
 */
export function fetchBranches(dir: string, signal?: AbortSignal): Promise<BranchList> {
  return getJson<BranchList>('/api/git-panel/branches', { dir }, signal)
}

/** One line of a blame: who last touched it, and the line itself. */
export interface BlameLine {
  /** 1-based line number in the file as HEAD has it. */
  line: number
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
export interface BlamePayload {
  ok: true
  repo: { root: string; name: string } | null
  reason?: string
  path: string
  lines: BlameLine[]
  truncated: boolean
}

/**
 * Read line-by-line attribution of one committed file.
 *
 * Blame reads HEAD: uncommitted changes are not in it, and the view says so.
 *
 * @param dir - a registered workspace directory.
 * @param path - a repository-relative file path.
 * @param signal - cancellation.
 * @returns the lines with who last touched each.
 */
export function fetchBlame(dir: string, path: string, signal?: AbortSignal): Promise<BlamePayload> {
  return getJson<BlamePayload>('/api/git-panel/blame', { dir, path }, signal)
}

/**
 * Read the stash list of one repository, newest first.
 * @param dir - a registered workspace directory.
 * @param signal - cancellation.
 * @returns the entries; the `ref` of each is what the stash actions accept.
 */
export function fetchStashes(dir: string, signal?: AbortSignal): Promise<StashList> {
  return getJson<StashList>('/api/git-panel/stashes', { dir }, signal)
}

/**
 * Read one commit and the files it touched.
 * @param dir - a registered workspace directory.
 * @param hash - the commit to read.
 * @param signal - cancellation.
 * @returns the commit payload.
 */
export function fetchShow(dir: string, hash: string, signal?: AbortSignal, parent?: number, base?: string): Promise<CommitShow> {
  return getJson<CommitShow>('/api/git-panel/show', {
    dir,
    hash,
    ...(parent === undefined ? {} : { parent: String(parent) }),
    ...(base === undefined ? {} : { base }),
  }, signal)
}

/** One repository change the host pushed over the event stream. */
export interface RepoChange {
  /** The repository directory the change happened in. */
  dir: string
  /** The changed paths inside `.git`, relative to it. */
  files: string[]
  at: number
}

/** How the live stream is doing, so the panel can pick a poll interval. */
export type LiveState = 'connecting' | 'live' | 'polling'

/** What a stream subscription reports back. */
export interface WatchHandlers {
  /** A watched repository changed. */
  onChange: (change: RepoChange) => void
  /** The stream opened, or fell back to polling. */
  onState?: (state: LiveState) => void
  /** What the host confirmed it is really watching, per directory. */
  onHello?: (watching: Record<string, boolean>) => void
}

/**
 * Subscribe to repository changes over the host's event stream.
 *
 * `EventSource` is the right client here: it reconnects on its own, and the
 * route is a plain same-origin GET, so the login cookie travels with it. The
 * caller keeps a slow poll running too — a stream that cannot open (watching
 * disabled, no watcher available) must degrade to polling, not to silence.
 *
 * @param dirs - the repository directories to watch.
 * @param handlers - change, state, and hello callbacks.
 * @returns the unsubscribe function.
 */
export function watchRepos(dirs: readonly string[], handlers: WatchHandlers): () => void {
  if (dirs.length === 0 || typeof EventSource === 'undefined') return () => {}
  const url = new URL('/api/git-panel/events', window.location.origin)
  for (const dir of dirs) url.searchParams.append('dir', dir)
  const source = new EventSource(url.toString())
  handlers.onState?.('connecting')
  source.addEventListener('open', () => { handlers.onState?.('live') })
  source.addEventListener('error', () => { handlers.onState?.('polling') })
  source.addEventListener('hello', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { watching?: Record<string, boolean> }
    handlers.onHello?.(payload.watching ?? {})
  })
  source.addEventListener('change', (event) => {
    handlers.onChange(JSON.parse((event as MessageEvent<string>).data) as RepoChange)
  })
  return () => { source.close() }
}
