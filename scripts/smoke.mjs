/**
 * Host-half smoke test.
 *
 * Drives the route handler the plugin registers into `webServer` against the
 * real `git` binary, through a minimal stand-in for the host subprocess
 * service. The browser reaches the same handler through the profile's
 * authenticated web server; this test exercises everything but that transport.
 *
 * Usage: node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, buildCommitPrompt, buildSummaryPrompt, commitSystemPrompt, parseSummaryLines, sanitizeCommitMessage, trimDiff } from '../lib/index.js'

/** One managed child, shaped like the host subprocess handle. */
function spawnStandIn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  const err = []
  child.stdout.on('data', chunk => out.push(chunk))
  child.stderr.on('data', chunk => err.push(chunk))
  // A failed spawn (missing cwd, no git) emits `error` and then still closes.
  child.on('error', () => {})
  const settle = new Promise(resolve => child.on('close', code => resolve({ exitCode: code })))
  // Hold pushes open a moment, so "one action per repository" is observable
  // instead of a race the test could lose on a fast machine.
  const done = spec.argv.includes('push')
    ? settle.then(async (outcome) => {
      await new Promise(resolve => setTimeout(resolve, 250))
      return outcome
    })
    : settle
  if (spec.signal) spec.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
  return {
    collected: {
      stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8'), lossy: false }) },
      stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8'), lossy: false }) },
    },
    done,
  }
}

const failures = []
function check(name, condition, detail) {
  if (condition) {
    process.stdout.write(`  PASS  ${name}\n`)
    return
  }
  failures.push(name)
  process.stdout.write(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/** This file's directory, so the suite can read its own package contract. */
const here = dirname(fileURLToPath(import.meta.url))

// ── the bundle contract ─────────────────────────────────────────────────────
// A profile boots as an ordered stack of bundle patch layers: a package in
// `dsh.profile.bundles` contributes loader rows only through its own
// `cordis.patch.yml`. Shipping `dsh.client` without `dsh.bundle.patch` still
// looks healthy — a runtime injection registers the row and the panel works —
// until the profile is re-assembled or restarted, when the row and the left
// rail icon disappear together. This environment has had exactly that outage,
// so the contract is asserted here rather than trusted.
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
check('the package declares its client half as a web module',
  manifest.dsh?.client?.platform === 'web' && typeof manifest.exports?.['./client']?.default === 'string',
  JSON.stringify(manifest.dsh?.client))
check('the package declares the bundle patch that carries its loader row',
  manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  JSON.stringify(manifest.dsh?.bundle))
const patchPath = join(here, '..', manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
check('the bundle patch exists and ships with the package',
  existsSync(patchPath) && (manifest.files ?? []).includes('cordis.patch.yml'))
const bundlePatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
check('the bundle patch inserts the row under the package name',
  /-\s*insert:/.test(bundlePatch)
    && /id:\s*git-panel/.test(bundlePatch)
    && bundlePatch.includes(manifest.name),
  bundlePatch.split('\n').filter(line => line.includes('id:') || line.includes('name:')).join(' | '))

const root = mkdtempSync(join(tmpdir(), 'dsh-git-panel-'))
process.env.DSH_GIT_PANEL_SUMMARY_STORE = join(root, 'summaries.json')
const repo = join(root, 'repo')
const plain = join(root, 'not-a-repo')
mkdirSync(repo)
mkdirSync(plain)

execFileSync('git', ['init', '-q'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: repo })
writeFileSync(join(repo, 'a.txt'), 'hello\n')
execFileSync('git', ['add', 'a.txt'], { cwd: repo })
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
writeFileSync(join(repo, 'a.txt'), 'hello\nchanged\n')
writeFileSync(join(repo, 'b.txt'), 'untracked\n')

// A local upstream, so ahead/behind and the upstream name are real facts:
// `clone` gains one local commit (ahead 1) and loses one to `other` (behind 1),
// `fastforward` only loses one (behind 1) so `pull --ff-only` can succeed, and
// `other` can push for real.
// A file long enough that two edits far apart produce two hunks with a gap
// between them — the case the context route exists to open.
const spread = join(root, 'spread')
mkdirSync(spread)
const spreadGit = args => execFileSync('git', args, { cwd: spread, stdio: 'pipe' })
spreadGit(['init', '-q', '--initial-branch=main'])
spreadGit(['config', 'user.email', 'smoke@example.com'])
spreadGit(['config', 'user.name', 'Smoke'])
const spreadLines = Array.from({ length: 40 }, (_unused, index) => `line ${String(index + 1)}`)
writeFileSync(join(spread, 'long.txt'), `${spreadLines.join('\n')}\n`)
spreadGit(['add', 'long.txt'])
spreadGit(['commit', '-q', '-m', 'seed long file'])
spreadLines[4] = 'line 5 changed'
spreadLines[34] = 'line 35 changed'
writeFileSync(join(spread, 'long.txt'), `${spreadLines.join('\n')}\n`)

// A repository with no commit at all: `git reset HEAD --` cannot work there,
// so unstaging has to fall back to `git rm --cached`.
const fresh = join(root, 'fresh')
mkdirSync(fresh)
const freshGit = args => execFileSync('git', args, { cwd: fresh, stdio: 'pipe' })
freshGit(['init', '-q', '--initial-branch=main'])
freshGit(['config', 'user.email', 'smoke@example.com'])
freshGit(['config', 'user.name', 'Smoke'])
writeFileSync(join(fresh, 'first.txt'), 'unborn\n')
freshGit(['add', 'first.txt'])

const remote = join(root, 'remote.git')
const seed = join(root, 'seed')
const clone = join(root, 'clone')
const fastforward = join(root, 'fastforward')
const other = join(root, 'other')
for (const directory of [remote, seed]) mkdirSync(directory)
const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' })
run(['init', '-q', '--bare', '--initial-branch=main'], remote)
run(['init', '-q', '--initial-branch=main'], seed)
run(['config', 'user.email', 'smoke@example.com'], seed)
run(['config', 'user.name', 'Smoke'], seed)
writeFileSync(join(seed, 'f.txt'), 'seed\n')
run(['add', 'f.txt'], seed)
run(['commit', '-q', '-m', 'seed'], seed)
run(['remote', 'add', 'origin', remote], seed)
run(['push', '-q', '-u', 'origin', 'main'], seed)
for (const worktree of [clone, fastforward, other]) {
  run(['clone', '-q', remote, worktree], root)
  run(['config', 'user.email', 'smoke@example.com'], worktree)
  run(['config', 'user.name', 'Smoke'], worktree)
}
writeFileSync(join(clone, 'g.txt'), 'local\n')
run(['add', 'g.txt'], clone)
run(['commit', '-q', '-m', 'local'], clone)
writeFileSync(join(other, 'h.txt'), 'remote\n')
run(['add', 'h.txt'], other)
run(['commit', '-q', '-m', 'remote'], other)
run(['push', '-q', 'origin', 'main'], other)
run(['fetch', '-q'], clone)
run(['fetch', '-q'], fastforward)

/** HEAD of a worktree, to prove an action moved (or did not move) it. */
const headOf = worktree => run(['rev-parse', 'HEAD'], worktree).toString().trim()

/** Mount one host instance and hand back the route, its service and tools. */
function mount(config) {
  let route
  let teardown
  let teardownTools
  /** What the plugin published as `ctx.gitPanel`. */
  const provided = new Map()
  /** Every tool the plugin registered, by name. */
  const tools = new Map()
  /**
   * The optional services this instance can see.
   *
   * The stub model streams back whatever the test queued, and records the exact
   * request so the prompt itself can be asserted.
   */
  const services = {
    llm: config.llm === false ? undefined : {
      calls: [],
      listProviders: () => config.llmProviders ?? [
        { id: 'stub-provider', name: 'Stub' },
        { id: 'silent-provider', name: 'Silent' },
      ],
      listModels: async (provider) => {
        if (provider === 'silent-provider') throw new Error('endpoint unreachable')
        return [{ id: 'stub-model', name: 'Stub Model' }, { id: 'other-model', name: 'Other Model' }]
      },
      async *stream(options) {
        services.llm.calls.push(options)
        // The real adapter throws on a provider rejection (a 400 from the
        // route); a stub that can only answer with a failure frame would leave
        // that path untested.
        if (config.llmThrows !== undefined) throw new Error(config.llmThrows)
        if (config.llmFailure !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: config.llmFailure } } }
          return
        }
        for (const piece of config.llmReply ?? ['feat: 默认回复']) {
          yield { type: 'text-delta', text: piece }
        }
        if (config.llmNoUsage !== true) {
          yield { type: 'usage', usage: { inputTokens: config.llmZeroUsage === true ? 0 : 42 } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agentDefaultModel: config.defaultModel === false ? undefined : {
      currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }),
    },
    // The settings service is optional too: the stub reads and writes the
    // plugin's own Config the way the real one does, and records the writes.
    settings: config.settings === undefined ? undefined : {
      updates: [],
      describe: () => [{ ns: 'git-panel', value: config.settings.value, revision: 1 }],
      update: async (ns, patch) => {
        services.settings.updates.push({ ns, patch })
        if (config.settings.fail === true) throw new Error('settings refused the write')
        Object.assign(config.settings.value, patch)
      },
    },
  }
  apply({
    effect: (factory) => {
      teardown = factory()
      return () => {}
    },
    webServer: {
      register: (registered) => {
        route = registered
        return () => {}
      },
    },
    subprocess: {
      resolveExecutable: async () => 'git',
      spawn: spawnStandIn,
    },
    // The real context has both; the stand-ins record what the plugin offers
    // other plugins and the model.
    provide: (key, value) => { provided.set(key, value) },
    // `llm` and `agentDefaultModel` are optional: the plugin reads them with
    // ctx.get, and must answer cleanly when a profile has neither.
    get: (name) => services[name],
    inject: (names, callback) => {
      if (!names.includes('tools')) return
      callback({
        effect: (factory) => {
          teardownTools = factory()
          return () => {}
        },
        tools: {
          register: (tool) => {
            tools.set(tool.name, tool)
            return () => { tools.delete(tool.name) }
          },
        },
      })
    },
    workspaceRegistry: {
      list: () => [
        { id: 'w1', title: 'repo', path: realpathSync(repo) },
        { id: 'w2', title: 'plain', path: realpathSync(plain) },
        { id: 'w3', title: 'clone', path: realpathSync(clone) },
        { id: 'w4', title: 'gone', path: join(root, 'gone') },
        { id: 'w5', title: 'fastforward', path: realpathSync(fastforward) },
        { id: 'w6', title: 'other', path: realpathSync(other) },
        { id: 'w7', title: 'spread', path: realpathSync(spread) },
        { id: 'w8', title: 'fresh', path: realpathSync(fresh) },
      ],
    },
  }, {
    timeoutMs: 20_000,
    actionTimeoutMs: 30_000,
    outputMaxBytes: 4_194_304,
    actionOutputMaxBytes: 32_768,
    contextLines: 3,
    overviewConcurrency: 4,
    allowPush: config.allowPush,
    watchEnabled: config.watchEnabled !== false,
    fetchBeforePull: config.fetchBeforePull !== false,
    allowRepoWrites: config.allowRepoWrites !== false,
    aiCommitEnabled: config.aiCommitEnabled !== false,
    aiCommitProvider: config.aiCommitProvider ?? '',
    aiCommitModel: config.aiCommitModel ?? '',
    aiCommitReasoningEffort: config.aiCommitReasoningEffort ?? '',
    aiCommitLanguage: config.aiCommitLanguage ?? 'zh',
    aiCommitMaxDiffLines: config.aiCommitMaxDiffLines ?? 1_200,
    aiCommitMaxDiffBytes: config.aiCommitMaxDiffBytes ?? 65_536,
    aiCommitTimeoutMs: config.aiCommitTimeoutMs ?? 30_000,
    aiCommitExtraPrompt: config.aiCommitExtraPrompt ?? '',
  })
  return { route, provided, tools, services, dispose: () => { teardown?.(); teardownTools?.() } }
}

const main = mount({ allowPush: true })
const route = main.route
/** A second instance with push switched off, to prove the configuration gate. */
const lockedRoute = mount({ allowPush: false }).route
/** A third with watching off, and one that skips the pull prologue. */
const blindRoute = mount({ watchEnabled: false }).route
const barePullRoute = mount({ fetchBeforePull: false }).route
/** A read-only instance: no staging, no discarding, no committing. */
const readOnlyRoute = mount({ allowRepoWrites: false }).route
/** An instance with no model adapter, and one with the draft switched off. */
const noModelRoute = mount({ llm: false }).route
const noDefaultModelRoute = mount({ defaultModel: false }).route
const aiOffRoute = mount({ aiCommitEnabled: false }).route
/** One that names its own model instead of following the default selection. */
const aiOverrideRoute = mount({ aiCommitProvider: 'custom-provider', aiCommitModel: 'custom-model' }).route
/** One that asks its route to think, for models that refuse a disabled one. */
const aiEffortMount = mount({ aiCommitReasoningEffort: 'low' })
/** One whose model fails, and one whose reply needs cleaning up. */
const aiFailRoute = mount({ llmFailure: 'upstream refused the request' }).route
// Chunked like a real stream, and wrapped the way a model wraps a reply.
const aiCataloglessRoute = mount({ llm: false }).route
const aiDirtyRoute = mount({ llmReply: ['```\n', '这是你的提交信息：\n', 'fix: 修掉 a.txt 的边界问题\n', '\n', '- 顺带补了注释\n', '\n', '```'] }).route

async function requestOn(target, url) {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (text) => { body = String(text ?? '') },
  }
  await target.handler({ method: 'GET', url }, res)
  return { status, json: body === '' ? null : JSON.parse(body) }
}

/** POST a JSON body, defaulting to the headers the panel really sends. */
async function postOn(target, url, body, headers) {
  let status = 0
  let text = ''
  const payload = JSON.stringify(body)
  const request = {
    method: 'POST',
    url,
    headers: headers ?? { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    },
  }
  const res = {
    writeHead: (code) => { status = code },
    end: (chunk) => { text = String(chunk ?? '') },
  }
  await target.handler(request, res)
  return { status, json: text === '' ? null : JSON.parse(text) }
}

const request = url => requestOn(route, url)
const post = (url, body, headers) => postOn(route, url, body, headers)
const action = (body, headers) => post('/api/git-panel/action', body, headers)

process.stdout.write('dsh-git-panel host smoke\n')
check('route registered as a prefix route', route?.kind === 'prefix' && route?.path === '/api/git-panel', JSON.stringify(route?.path))

// The overview is what the landing grid draws: one card per workspace, with the
// tally that decides whether it reads as dirty, clean, or unreadable.
const overview = await request('/api/git-panel/overview')
check('GET /overview answers 200 for every workspace', overview.status === 200 && overview.json.entries.length === 8, `${overview.status} ${JSON.stringify(overview.json).slice(0, 120)}`)
const cards = new Map((overview.json.entries ?? []).map(entry => [entry.workspace.id, entry]))
check('card identity carries workspace path', cards.get('w1')?.workspace.path === realpathSync(repo), JSON.stringify(cards.get('w1')?.workspace))
check('dirty card carries its tally', cards.get('w1')?.counts.changed === 1 && cards.get('w1')?.counts.untracked === 1, JSON.stringify(cards.get('w1')?.counts))
check('card omits the per-file diff payload', cards.get('w1')?.files === undefined)
check('clean card stays clean while diverged', cards.get('w3')?.counts.changed === 0 && cards.get('w3')?.counts.untracked === 0 && cards.get('w3')?.repo?.ahead === 1 && cards.get('w3')?.repo?.behind === 1, JSON.stringify(cards.get('w3')))
check('plain directory card reports not-a-repository', cards.get('w2')?.reason === 'not-a-repository' && cards.get('w2')?.repo === null, JSON.stringify(cards.get('w2')))
check('unreadable workspace degrades to one card', cards.get('w4')?.reason === 'unavailable' && typeof cards.get('w4')?.error === 'string', JSON.stringify(cards.get('w4')))

const status = await request(`/api/git-panel/status?dir=${encodeURIComponent(repo)}`)
const files = status.json.files ?? []
const a = files.find(file => file.path === 'a.txt')
const b = files.find(file => file.path === 'b.txt')
check('GET /status answers 200', status.status === 200 && status.json.ok === true)
check('repo root and name resolved', status.json.repo?.root === realpathSync(repo) && status.json.repo?.name === 'repo', JSON.stringify(status.json.repo))
check('branch reported, no upstream', typeof status.json.repo?.branch === 'string' && status.json.repo.upstream === null)
check('ahead/behind are zero without an upstream', status.json.repo?.ahead === 0 && status.json.repo?.behind === 0)
check('modified file listed with worktree M', a !== undefined && a.worktree === 'M' && a.untracked === false, JSON.stringify(a))
check('modified file carries line counts', (a?.unstaged?.added ?? 0) >= 1, JSON.stringify(a?.unstaged))
check('untracked file listed', b !== undefined && b.untracked === true && b.index === '?', JSON.stringify(b))
check('tally counts one change and one untracked', status.json.counts.changed === 1 && status.json.counts.untracked === 1, JSON.stringify(status.json.counts))

const diff = await request(`/api/git-panel/diff?dir=${encodeURIComponent(repo)}&path=a.txt&staged=0`)
check('GET /diff returns a text diff', diff.status === 200 && diff.json.kind === 'text', JSON.stringify(diff.json).slice(0, 160))
check('diff carries the changed line', (diff.json.text ?? '').includes('+changed'))

const untrackedDiff = await request(`/api/git-panel/diff?dir=${encodeURIComponent(repo)}&path=b.txt&untracked=1`)
check('untracked diff is a pure addition', untrackedDiff.status === 200 && untrackedDiff.json.kind === 'text' && untrackedDiff.json.text.includes('+untracked'), JSON.stringify(untrackedDiff.json).slice(0, 160))

const notRepo = await request(`/api/git-panel/status?dir=${encodeURIComponent(plain)}`)
check('plain directory reports not-a-repository', notRepo.status === 200 && notRepo.json.repo === null && notRepo.json.reason === 'not-a-repository', JSON.stringify(notRepo.json).slice(0, 120))

const tracking = await request(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
check('upstream branch is reported', tracking.json.repo?.upstream === 'origin/main', JSON.stringify(tracking.json.repo?.upstream))
check('ahead and behind are counted against the upstream', tracking.json.repo?.ahead === 1 && tracking.json.repo?.behind === 1, JSON.stringify(tracking.json.repo))

const outside = await request('/api/git-panel/status?dir=%2Froot')
check('directory outside every workspace is refused', outside.status === 403, `${outside.status} ${JSON.stringify(outside.json)}`)

const escape = await request(`/api/git-panel/diff?dir=${encodeURIComponent(repo)}&path=..%2Fetc%2Fpasswd`)
check('path escape is refused', escape.status === 400, `${escape.status} ${JSON.stringify(escape.json)}`)

const missing = await request('/api/git-panel/status')
check('missing dir is refused', missing.status === 400, `${missing.status}`)

// ---- remote actions (M2) --------------------------------------------------
const actionUrl = '/api/git-panel/action'
const dirArg = dir => encodeURIComponent(dir)
const ffBefore = headOf(fastforward)
const cloneBefore = headOf(clone)

const diverged = await request(`/api/git-panel/status?dir=${dirArg(clone)}`)
check('fixture starts diverged', diverged.json.repo.ahead === 1 && diverged.json.repo.behind === 1, JSON.stringify(diverged.json.repo))

const fetched = await action({ dir: fastforward, action: 'fetch' })
check('fetch succeeds and reports its argv', fetched.status === 200 && fetched.json.succeeded === true && fetched.json.command.join(' ') === 'git fetch --prune', `${fetched.status} ${JSON.stringify(fetched.json).slice(0, 160)}`)

const pulled = await action({ dir: fastforward, action: 'pull' })
check('pull --ff-only fast-forwards a behind-only worktree', pulled.status === 200 && pulled.json.succeeded === true && pulled.json.command.join(' ') === 'git pull --ff-only', `${pulled.status} ${JSON.stringify(pulled.json).slice(0, 200)}`)
check('a pull refreshes remote refs before it fast-forwards', pulled.json.steps?.length === 2 && pulled.json.steps[0].command.join(' ') === 'git fetch --prune' && pulled.json.steps[1].command.join(' ') === 'git pull --ff-only', JSON.stringify(pulled.json.steps?.map(step => step.command)))
check('the pull prologue reports its own exit code', pulled.json.steps[0].exitCode === 0 && pulled.json.steps[0].succeeded === true, JSON.stringify(pulled.json.steps?.[0]))
check('the fast-forward moved HEAD', headOf(fastforward) !== ffBefore)
const ffAfter = await request(`/api/git-panel/status?dir=${dirArg(fastforward)}`)
check('that worktree is level with its upstream afterwards', ffAfter.json.repo.behind === 0 && ffAfter.json.repo.ahead === 0, JSON.stringify(ffAfter.json.repo))

// The pull prologue is a switch, not a law.
const barePulled = await postOn(barePullRoute, actionUrl, { dir: fastforward, action: 'pull' })
check('the pull prologue can be switched off', barePulled.status === 200 && barePulled.json.steps?.length === 1 && barePulled.json.steps[0].command.join(' ') === 'git pull --ff-only', JSON.stringify(barePulled.json.steps?.map(step => step.command)))

const refused = await action({ dir: clone, action: 'pull' })
check('pull --ff-only refuses a diverged branch', refused.status === 200 && refused.json.succeeded === false && refused.json.exitCode !== 0, `${refused.status} ${JSON.stringify(refused.json).slice(0, 200)}`)
check('the refusal names the fast-forward rule', /fast-forward|not possible/i.test(refused.json.stderr + refused.json.stdout), JSON.stringify(refused.json.stderr).slice(0, 160))
check('a refused pull moved no HEAD and left no merge', headOf(clone) === cloneBefore)

const rejected = await action({ dir: clone, action: 'push', confirm: true })
check('push of a diverged branch is rejected, not forced', rejected.status === 200 && rejected.json.succeeded === false, `${rejected.status} ${JSON.stringify(rejected.json).slice(0, 200)}`)
check('the rejection is git\'s own non-fast-forward message', /rejected|non-fast-forward|fetch first/i.test(rejected.json.stderr + rejected.json.stdout), JSON.stringify(rejected.json.stderr).slice(0, 200))
const cloneAfter = await request(`/api/git-panel/status?dir=${dirArg(clone)}`)
check('the rejected push left the branch alone', cloneAfter.json.repo.ahead === 1 && cloneAfter.json.repo.behind === 1, JSON.stringify(cloneAfter.json.repo))

writeFileSync(join(other, 'i.txt'), 'pushed\n')
run(['add', 'i.txt'], other)
run(['commit', '-q', '-m', 'push me'], other)
const aheadBefore = await request(`/api/git-panel/status?dir=${dirArg(other)}`)
check('fixture is ahead by one before its push', aheadBefore.json.repo.ahead === 1, JSON.stringify(aheadBefore.json.repo))
const pushed = await action({ dir: other, action: 'push', confirm: true })
check('push succeeds when the branch is merely ahead', pushed.status === 200 && pushed.json.succeeded === true && pushed.json.command.join(' ') === 'git push', `${pushed.status} ${JSON.stringify(pushed.json).slice(0, 200)}`)
const otherAfter = await request(`/api/git-panel/status?dir=${dirArg(other)}`)
check('the branch is level with its upstream after the push', otherAfter.json.repo.ahead === 0, JSON.stringify(otherAfter.json.repo))

// Server-side rails, independent of what the UI does.
const noConfirm = await action({ dir: other, action: 'push' })
check('push without confirmation is refused', noConfirm.status === 428, `${noConfirm.status} ${JSON.stringify(noConfirm.json)}`)
const noHeader = await action({ dir: other, action: 'push', confirm: true }, { 'content-type': 'application/json' })
check('a write without the panel header is refused', noHeader.status === 403, `${noHeader.status}`)
const wrongType = await action({ dir: other, action: 'push', confirm: true }, { 'x-dsh-git-panel': '1', 'content-type': 'text/plain' })
check('a write without a JSON content type is refused', wrongType.status === 415, `${wrongType.status}`)
const badAction = await action({ dir: other, action: 'reset --hard' })
check('an unknown action is refused', badAction.status === 400, `${badAction.status}`)
const outsideAction = await action({ dir: '/root', action: 'fetch' })
check('an action outside every workspace is refused', outsideAction.status === 403, `${outsideAction.status}`)
const getAction = await request(actionUrl)
check('the action route is POST-only', getAction.status === 405, `${getAction.status}`)

const lockedPush = await postOn(lockedRoute, actionUrl, { dir: other, action: 'push', confirm: true })
check('push can be switched off by configuration', lockedPush.status === 403 && /disabled/i.test(String(lockedPush.json?.error)), `${lockedPush.status} ${JSON.stringify(lockedPush.json)}`)
const lockedFetch = await postOn(lockedRoute, actionUrl, { dir: other, action: 'fetch' })
check('switching push off leaves fetch available', lockedFetch.status === 200 && lockedFetch.json.succeeded === true, `${lockedFetch.status}`)

const [raceOne, raceTwo] = await Promise.all([
  action({ dir: other, action: 'push', confirm: true }),
  action({ dir: other, action: 'push', confirm: true }),
])
const raceStatuses = [raceOne.status, raceTwo.status].sort()
check('a second concurrent action on one repository is refused', raceStatuses[0] === 200 && raceStatuses[1] === 409, JSON.stringify(raceStatuses))

// ── reading the lines a gap hides ──────────────────────────────────────────
// The diff renderer stops at `-U3`; a reader who wants the code between two
// hunks asks this route for exactly that range.
const worktreeSlice = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=a.txt&staged=0&start=1&count=9`)
check('context reads the work tree for an unstaged diff', worktreeSlice.status === 200 && JSON.stringify(worktreeSlice.json.lines) === JSON.stringify(['hello', 'changed']), JSON.stringify(worktreeSlice.json))
check('context reports the source length and the end of file', worktreeSlice.json.total === 2 && worktreeSlice.json.eof === true, JSON.stringify(worktreeSlice.json))
const indexSlice = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=a.txt&staged=1&start=1&count=9`)
check('context reads the index blob for a staged diff', indexSlice.status === 200 && JSON.stringify(indexSlice.json.lines) === JSON.stringify(['hello']), JSON.stringify(indexSlice.json))
const beyondEof = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=a.txt&staged=0&start=50&count=5`)
check('a start past the end of file comes back empty and flagged', beyondEof.status === 200 && beyondEof.json.lines.length === 0 && beyondEof.json.eof === true, JSON.stringify(beyondEof.json))
const missingWorktree = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=missing.txt&staged=0&start=1&count=5`)
check('a missing work-tree file is reported, not thrown', missingWorktree.status === 200 && missingWorktree.json.missing === true, JSON.stringify(missingWorktree.json))
const missingBlob = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=missing.txt&staged=1&start=1&count=5`)
check('a path absent from the index is reported the same way', missingBlob.status === 200 && missingBlob.json.missing === true, JSON.stringify(missingBlob.json))
writeFileSync(join(repo, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]))
const binarySlice = await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=binary.bin&staged=0&start=1&count=5`)
check('a binary file is refused as context', binarySlice.status === 200 && binarySlice.json.binary === true && binarySlice.json.lines.length === 0, JSON.stringify(binarySlice.json))

// The real case: the gap between the two hunks of `spread/long.txt` is exactly
// new lines 9..31, and those lines must come back verbatim.
const gapSlice = await request(`/api/git-panel/context?dir=${dirArg(spread)}&path=long.txt&staged=0&start=9&count=23`)
check('context returns exactly the lines between two hunks', gapSlice.status === 200 && gapSlice.json.lines.length === 23 && gapSlice.json.lines[0] === 'line 9' && gapSlice.json.lines[22] === 'line 31', `${gapSlice.status} ${JSON.stringify(gapSlice.json.lines?.slice(0, 3))}`)
check('context does not disturb the lines around it', gapSlice.json.lines[4] === 'line 13' && gapSlice.json.total === 40, JSON.stringify({ total: gapSlice.json.total, spot: gapSlice.json.lines[4] }))

const badStart = await request(`/api/git-panel/context?dir=${dirArg(spread)}&path=long.txt&staged=0&start=0&count=5`)
check('a non-positive start is refused', badStart.status === 400, `${badStart.status}`)
const badCount = await request(`/api/git-panel/context?dir=${dirArg(spread)}&path=long.txt&staged=0&start=1&count=401`)
check('an oversized count is refused', badCount.status === 400, `${badCount.status}`)
const escaping = await request(`/api/git-panel/context?dir=${dirArg(spread)}&path=..%2F..%2Fetc%2Fpasswd&staged=0&start=1&count=5`)
check('a path escaping the repository is refused', escaping.status === 400, `${escaping.status}`)
const outsideContext = await request('/api/git-panel/context?dir=%2Froot&path=a.txt&staged=0&start=1&count=5')
check('context outside every workspace is refused', outsideContext.status === 403, `${outsideContext.status}`)

// ── the live event stream ──────────────────────────────────────────────────
// The panel subscribes to `.git` so a commit, a checkout, or a fetch shows up
// without waiting for a poll. The transport is server-sent events, driven here
// through the same handler the web server calls.

/** Pull the SSE frames out of a stream buffer. */
function framesOf(text) {
  return text
    .split('\n\n')
    .map(part => part.trim())
    // A frame must carry data; `retry:` hints and `:` keep-alives are not events.
    .filter(part => part !== '' && part.split('\n').some(line => line.startsWith('data: ')))
    .map(part => {
      const lines = part.split('\n')
      const event = lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message'
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      return { event, data: data === '' ? null : JSON.parse(data) }
    })
}

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return predicate()
}

/** Open an event stream and keep its response open until `finish`. */
function openStream(target, dirs) {
  let status = 0
  const headers = {}
  const listeners = new Map()
  let text = ''
  let closed = false
  const query = dirs.map((dir, index) => `${index === 0 ? '?' : '&'}dir=${dirArg(dir)}`).join('')
  const request = {
    method: 'GET',
    url: `/api/git-panel/events${query}`,
    headers: {},
    once: (event, handler) => { listeners.set(event, handler) },
  }
  const response = {
    writeHead: (code, head) => { status = code; Object.assign(headers, head ?? {}) },
    write: (chunk) => { text += String(chunk); return true },
    end: (chunk) => { closed = true; if (chunk !== undefined) text += String(chunk) },
    once: (event, handler) => { listeners.set(event, handler) },
  }
  const settled = target.handler(request, response)
  return {
    status: () => status,
    headers,
    text: () => text,
    frames: () => framesOf(text),
    closed: () => closed,
    settled,
    finish: () => { listeners.get('close')?.() },
  }
}

const repoReal = realpathSync(repo)
const stream = openStream(main.route, [repoReal])
await waitFor(() => stream.frames().length > 0, 3_000)
check('the event stream answers 200 as text/event-stream', stream.status() === 200 && /text\/event-stream/.test(stream.headers['content-type'] ?? ''), `${stream.status()} ${JSON.stringify(stream.headers)}`)
check('the stream greets with what it is really watching', stream.frames()[0]?.event === 'hello' && stream.frames()[0].data.watching[repoReal] === true, JSON.stringify(stream.frames()[0]))
check('the stream tells EventSource how fast to reconnect', stream.text().includes('retry: 3000'), stream.text().slice(0, 80))

const noDir = await requestOn(main.route, '/api/git-panel/events')
check('a stream with no dir is refused', noDir.status === 400, `${noDir.status}`)
const outsideStream = await requestOn(main.route, '/api/git-panel/events?dir=%2Froot')
check('a stream outside every workspace is refused', outsideStream.status === 403, `${outsideStream.status}`)
const blindStream = await requestOn(blindRoute, `/api/git-panel/events?dir=${dirArg(repo)}`)
check('watching can be switched off by configuration', blindStream.status === 503, `${blindStream.status}`)
const postedStream = await postOn(main.route, '/api/git-panel/events', {})
check('the event stream is GET-only', postedStream.status === 405, `${postedStream.status}`)

// Git's own bookkeeping churns on every fetch; none of it changes what the
// panel draws, so a fetch must not become a refresh storm.
mkdirSync(join(repo, '.git', 'objects', 'zz'), { recursive: true })
writeFileSync(join(repo, '.git', 'objects', 'zz', 'probe'), 'x')
writeFileSync(join(repo, '.git', 'tmp_probe'), 'x')
await new Promise(resolve => setTimeout(resolve, 700))
check('object churn and lock files stay off the stream', stream.frames().length === 1, JSON.stringify(stream.frames()))

// A real ref move is exactly what the panel must hear about.
run(['update-ref', 'refs/heads/live-probe', 'HEAD'], repo)
const heard = await waitFor(() => stream.frames().some(frame => frame.event === 'change'), 3_000)
const change = stream.frames().find(frame => frame.event === 'change')
check('a ref move reaches the open stream', heard, JSON.stringify(stream.frames()))
check('the change names the repository and the path that moved', change?.data.dir === repoReal && change.data.files.some(file => file.includes('live-probe')), JSON.stringify(change?.data))

// Closing the connection releases the watcher; nothing may arrive after it.
stream.finish()
await stream.settled
check('closing the connection ends the stream', stream.closed() === true)
run(['update-ref', 'refs/heads/live-probe2', 'HEAD'], repo)
await new Promise(resolve => setTimeout(resolve, 600))
check('a closed stream stops forwarding changes', stream.frames().filter(frame => frame.event === 'change').length === 1, JSON.stringify(stream.frames().map(frame => frame.event)))

// Unloading the plugin must not leave a stream open with no owner.
const disposable = mount({ allowPush: true })
const orphan = openStream(disposable.route, [realpathSync(other)])
await waitFor(() => orphan.frames().length > 0, 3_000)
disposable.dispose()
check('unloading the plugin closes an open stream', await waitFor(() => orphan.closed(), 2_000), `${JSON.stringify(orphan.frames().map(frame => frame.event))}`)

// The read-only promise M1 made still holds after all of that.
const repoAfter = await request(`/api/git-panel/status?dir=${dirArg(repo)}`)
check('no action staged or committed anything in the dirty fixture', repoAfter.json.counts.changed === 1 && repoAfter.json.counts.staged === 0, JSON.stringify(repoAfter.json.counts))
check('the fast-forwarded worktree holds exactly two commits', run(['rev-list', '--count', 'HEAD'], fastforward).toString().trim() === '2')

// ── the service and the tools other plugins and the model get ───────────────
const service = main.provided.get('gitPanel')
check('the plugin publishes a gitPanel service', typeof service === 'object' && service !== null
  && typeof service.status === 'function' && typeof service.diff === 'function'
  && typeof service.log === 'function' && typeof service.show === 'function'
  && typeof service.overview === 'function',
  JSON.stringify(Object.keys(service ?? {})))
const serviceStatus = await service.status(repo, false)
check('the service reads a repository the same way the route does',
  serviceStatus.repo?.branch !== null && serviceStatus.counts.changed === 1 && serviceStatus.counts.untracked === 2
    && serviceStatus.files.length === 3,
  JSON.stringify(serviceStatus.counts))
const serviceLog = await service.log(repo, 3)
check('the service reads history', serviceLog.length >= 1 && /^[0-9a-f]{40}$/.test(serviceLog[0].hash), String(serviceLog.length))
const serviceShow = await service.show(repo, serviceLog[0].hash)
check('the service reads one commit', serviceShow.commit?.hash === serviceLog[0].hash && Array.isArray(serviceShow.files),
  JSON.stringify(serviceShow.commit?.subject))
const serviceDiff = await service.diff(repo, { path: 'a.txt' })
check('the service hands out a diff as text', serviceDiff.includes('@@'), JSON.stringify(serviceDiff.slice(0, 60)))

try {
  await service.status('/etc')
  check('the service keeps the workspace allow-list', false, 'it read /etc')
} catch (error) {
  check('the service keeps the workspace allow-list', /outside every registered workspace/.test(String(error)), String(error))
}

check('the plugin registers exactly three model-facing tools',
  [...main.tools.keys()].sort().join(',') === 'git_commit_message,git_diff,git_status', [...main.tools.keys()].join(','))
const statusTool = main.tools.get('git_status')
const diffTool = main.tools.get('git_diff')
const toolStatus = await statusTool.execute({ dir: repo }, {})
check('git_status answers with the repository when given a dir',
  toolStatus.repo.branch !== null && Array.isArray(toolStatus.files) && typeof toolStatus.counts.changed === 'number'
    && toolStatus.files.every(file => typeof file.path === 'string'),
  JSON.stringify(toolStatus.counts))
const toolOverview = await statusTool.execute({}, {})
check('git_status answers with every workspace when given no dir',
  Array.isArray(toolOverview.workspaces) && toolOverview.workspaces.length >= 8
    && toolOverview.workspaces.every(entry => typeof entry.path === 'string' && typeof entry.counts.changed === 'number'),
  JSON.stringify(toolOverview.workspaces?.length))
const toolNotRepo = await statusTool.execute({ dir: plain }, {})
check('git_status says not-a-repository rather than failing', toolNotRepo.repo === null && toolNotRepo.reason === 'not-a-repository', JSON.stringify(toolNotRepo))
const toolDiff = await diffTool.execute({ dir: repo, path: 'a.txt', max_lines: 3 }, {})
check('git_diff bounds its answer and says so',
  toolDiff.total_lines > toolDiff.lines.length && toolDiff.truncated === true && typeof toolDiff.note === 'string'
    && toolDiff.lines.length === 3,
  JSON.stringify({ total: toolDiff.total_lines, lines: toolDiff.lines.length, note: toolDiff.note }))
const toolDiffFull = await diffTool.execute({ dir: repo, path: 'a.txt', hash: run(['rev-parse', 'HEAD'], repo).toString().trim() }, {})
check('git_diff can read a commit and reports no truncation when it fits',
  toolDiffFull.truncated === false && toolDiffFull.note === null && toolDiffFull.lines.some(line => /^\+/.test(line)),
  JSON.stringify({ truncated: toolDiffFull.truncated, note: toolDiffFull.note }))
check('the rendered tool text is the JSON the model reads',
  JSON.parse(statusTool.output.render({}, toolStatus).map(block => block.text).join('')).repo !== undefined)

// ── AI commit-message drafts ────────────────────────────────────────────────
// The reply is pasted straight into the commit box, so the cleanup and the
// prompt are the parts that decide whether the message is usable.
check('a fenced reply keeps only the message',
  sanitizeCommitMessage('```\nfeat: 加一个开关\n\n- 说明\n```') === 'feat: 加一个开关\n\n- 说明')
check('a fenced reply with a language tag is unwrapped too',
  sanitizeCommitMessage('```text\nfix: 修掉空指针\n```') === 'fix: 修掉空指针')
check('a "here is your message" preamble is dropped',
  sanitizeCommitMessage('提交信息：\nfeat: 加一个开关') === 'feat: 加一个开关')
check('a thinking block is dropped', sanitizeCommitMessage('<thinking>让我看看</thinking>\nchore: 整理脚本') === 'chore: 整理脚本')
check('surrounding quotes are dropped', sanitizeCommitMessage('“fix: 修掉空指针”') === 'fix: 修掉空指针')
check('blank-line runs collapse', sanitizeCommitMessage('feat: x\n\n\n\n- y') === 'feat: x\n\n- y')
check('an over-long reply is cut to the commit limit',
  sanitizeCommitMessage('a'.repeat(5_000)).length === 4_000)
check('the language word is spelled out for the model',
  commitSystemPrompt('zh').includes('用简体中文书写。') && commitSystemPrompt('en').includes('用英文书写。'),
  commitSystemPrompt('en').split('\n').at(-1))
check('extra instructions are appended', commitSystemPrompt('zh', '不要写正文').endsWith('不要写正文'))
const promptInput = {
  language: 'zh', repo: 'demo', branch: 'main', source: 'staged',
  files: [{ path: 'a.txt', added: 2, deleted: 1 }, { path: 'new.txt', added: null, deleted: null, untracked: true }],
  pending: ['b.txt（未跟踪）'], diff: '@@ -1 +1 @@\n-old\n+new', truncated: true,
}
const builtPrompt = buildCommitPrompt(promptInput)
check('the prompt carries the file list with its tally',
  builtPrompt.includes('- a.txt (+2 -1)') && builtPrompt.includes('- new.txt (新文件)'), builtPrompt.slice(0, 200))
check('the prompt names what is not part of this commit',
  builtPrompt.includes('不会进入本次提交') && builtPrompt.includes('- b.txt（未跟踪）'))
check('the prompt says when the diff was cut short', builtPrompt.includes('已按大小截断'))
check('the prompt carries the diff itself', builtPrompt.includes('+new'))
check('a diff over the line budget is cut and reported',
  JSON.stringify(trimDiff('a\nb\nc\nd', 2, 1_000)) === '{"text":"a\\nb","truncated":true}')
check('a diff over the byte budget is cut and reported',
  trimDiff('é'.repeat(100), 1_000, 10).text.length === 5 && trimDiff('é'.repeat(100), 1_000, 10).truncated === true,
  JSON.stringify(trimDiff('é'.repeat(100), 1_000, 10).text.length))
check('a diff inside both budgets is untouched',
  JSON.stringify(trimDiff('a\nb', 10, 1_000)) === '{"text":"a\\nb","truncated":false}')

const commitMessageUrl = '/api/git-panel/commit-message'
const draft = await postOn(main.route, commitMessageUrl, { dir: repo })
check('POST /commit-message answers a draft',
  draft.status === 200 && draft.json.ok === true && draft.json.message === 'feat: 默认回复', `${draft.status} ${JSON.stringify(draft.json).slice(0, 160)}`)
check('the draft follows the default model selection when nothing is configured',
  draft.json.provider === 'stub-provider' && draft.json.model === 'stub-model', `${draft.json.provider}/${draft.json.model}`)
check('the draft reports what it read',
  draft.json.source === 'all' && draft.json.files >= 3 && draft.json.untracked === 2 && draft.json.inputTokens === 42,
  JSON.stringify({ source: draft.json.source, files: draft.json.files, untracked: draft.json.untracked }))
check('a draft from a provider that reports usage says so',
  draft.json.usageReported === true, JSON.stringify(draft.json.usageReported))
// A provider that never streams usage: the number must be marked as not a
// measurement, so the panel cannot show a confident "0 tokens".
const silentMount = mount({ llmNoUsage: true })
const silentDraft = await postOn(silentMount.route, commitMessageUrl, { dir: repo })
check('a draft from a provider that reports no usage says that instead',
  silentDraft.status === 200 && silentDraft.json.usageReported === false && silentDraft.json.inputTokens === 0,
  JSON.stringify({ status: silentDraft.status, usageReported: silentDraft.json?.usageReported, inputTokens: silentDraft.json?.inputTokens }))
silentMount.dispose()
const zeroMount = mount({ llmZeroUsage: true })
const zeroDraft = await postOn(zeroMount.route, commitMessageUrl, { dir: repo })
check('a usage chunk with no input tokens is not a measurement either',
  zeroDraft.status === 200 && zeroDraft.json.usageReported === false && zeroDraft.json.inputTokens === 0,
  JSON.stringify({ status: zeroDraft.status, usageReported: zeroDraft.json?.usageReported }))
zeroMount.dispose()
const firstCall = main.services.llm.calls.at(-1)
check('the model is asked without tools, so a draft can only produce text',
  firstCall.tools === undefined && Array.isArray(firstCall.messages) && firstCall.messages.length === 1,
  JSON.stringify(Object.keys(firstCall)))
check('the prompt is the change under review, not the whole work tree',
  firstCall.messages[0].content[0].text.includes('工作区全部未提交改动') && firstCall.messages[0].content[0].text.includes('a.txt'),
  firstCall.messages[0].content[0].text.slice(0, 200))
check('the system prompt asks for a conventional Chinese subject',
  firstCall.system.includes('类型: 一句话') && firstCall.system.includes('用简体中文书写。'), firstCall.system.slice(0, 80))

// A staged commit must be described by what is staged, and nothing else: a
// message that names an unstaged file describes a commit that cannot exist.
run(['add', 'a.txt'], repo)
const stagedDraft = await postOn(main.route, commitMessageUrl, { dir: repo })
const stagedCall = main.services.llm.calls.at(-1)
check('staged changes become the source of the draft', stagedDraft.json.source === 'staged', JSON.stringify(stagedDraft.json.source))
const stagedPrompt = stagedCall.messages[0].content[0].text
// The file list is what the commit records; the pending list is what it leaves out.
const stagedFileList = stagedPrompt.split('以下改动尚未暂存')[0]
check('the staged file list holds only staged files',
  stagedDraft.json.files === 1 && stagedFileList.includes('- a.txt') && !stagedFileList.includes('b.txt'),
  JSON.stringify({ files: stagedDraft.json.files, list: stagedFileList.slice(0, 200) }))
check('unstaged work is named as not part of this commit',
  stagedCall.messages[0].content[0].text.includes('不会进入本次提交') && stagedCall.messages[0].content[0].text.includes('- b.txt（未跟踪）'))
check('the untracked count is still reported for the panel',
  stagedDraft.json.untracked === 2 && stagedDraft.json.added + stagedDraft.json.deleted > 0, JSON.stringify(stagedDraft.json))
const stagedOnly = await postOn(main.route, commitMessageUrl, { dir: repo, staged: true })
check('a request may insist on the index alone', stagedOnly.json.source === 'staged')
run(['reset', '-q'], repo)

const overrideDraft = await postOn(aiOverrideRoute, commitMessageUrl, { dir: repo })
check('the configured provider and model win over the default selection',
  overrideDraft.json.provider === 'custom-provider' && overrideDraft.json.model === 'custom-model',
  `${overrideDraft.json.provider}/${overrideDraft.json.model}`)
const cleanedDraft = await postOn(aiDirtyRoute, commitMessageUrl, { dir: repo })
check('a fenced reply with a preamble reaches the box as the message alone',
  cleanedDraft.json.message === 'fix: 修掉 a.txt 的边界问题\n\n- 顺带补了注释', JSON.stringify(cleanedDraft.json.message))
const failedDraft = await postOn(aiFailRoute, commitMessageUrl, { dir: repo })
check('a model failure is a readable 502, not a broken panel',
  failedDraft.status === 502 && /upstream refused the request/.test(failedDraft.json.error), JSON.stringify(failedDraft.json))
const effortDraft = await postOn(aiEffortMount.route, commitMessageUrl, { dir: repo })
check('the commit draft asks for the configured reasoning effort',
  effortDraft.status === 200 && aiEffortMount.services.llm.calls.at(-1).reasoningEffort === 'low',
  `${effortDraft.status} ${String(aiEffortMount.services.llm.calls.at(-1).reasoningEffort)}`)
const effortOverrideDraft = await postOn(aiEffortMount.route, commitMessageUrl, { dir: repo, reasoningEffort: 'max' })
check('a draft request may name its own reasoning effort',
  effortOverrideDraft.status === 200 && aiEffortMount.services.llm.calls.at(-1).reasoningEffort === 'max',
  `${effortOverrideDraft.status} ${String(aiEffortMount.services.llm.calls.at(-1).reasoningEffort)}`)

const noModel = await postOn(noModelRoute, commitMessageUrl, { dir: repo })
check('a profile with no model adapter says so', noModel.status === 503 && /no model adapter/.test(noModel.json.error), JSON.stringify(noModel.json))
const noDefault = await postOn(noDefaultModelRoute, commitMessageUrl, { dir: repo })
check('no default selection and no override is a 503 with the fix in it',
  noDefault.status === 503 && /aiCommitProvider/.test(noDefault.json.error), JSON.stringify(noDefault.json))
const aiOff = await postOn(aiOffRoute, commitMessageUrl, { dir: repo })
check('the draft can be switched off by configuration', aiOff.status === 403, `${aiOff.status}`)
const draftNoHeader = await postOn(main.route, commitMessageUrl, { dir: repo }, { 'content-type': 'application/json' })
check('a draft without the panel header is refused', draftNoHeader.status === 403, `${draftNoHeader.status}`)
const draftWrongType = await postOn(main.route, commitMessageUrl, { dir: repo }, { 'content-type': 'text/plain', 'x-dsh-git-panel': '1' })
check('a draft with the wrong content type is refused', draftWrongType.status === 415, `${draftWrongType.status}`)
const outsideDraft = await postOn(main.route, commitMessageUrl, { dir: '/root' })
check('a draft outside every workspace is refused', outsideDraft.status === 403, `${outsideDraft.status}`)
const notRepoDraft = await postOn(main.route, commitMessageUrl, { dir: plain })
check('a draft for a non-repository is a 404', notRepoDraft.status === 404, `${notRepoDraft.status}`)
const cleanDraft = await postOn(main.route, commitMessageUrl, { dir: other })
check('a clean repository has nothing to describe', cleanDraft.status === 409 && /nothing to commit/.test(cleanDraft.json.error), JSON.stringify(cleanDraft.json))
const draftOnGet = await requestOn(main.route, `${commitMessageUrl}?dir=${dirArg(repo)}`)
check('the draft route is POST-only', draftOnGet.status === 405, `${draftOnGet.status}`)

// ── picking the model: the catalog, and a draft pointed at one route ─────────
const models = await request('/api/git-panel/models')
check('GET /models lists the provider routes',
  models.status === 200 && models.json.providers.length === 2, `${models.status} ${JSON.stringify(models.json).slice(0, 160)}`)
check('a provider that cannot be read is an empty group with its reason, not a failure',
  models.json.providers[1].models.length === 0 && /unreachable/.test(models.json.providers[1].error),
  JSON.stringify(models.json.providers[1]))
check('the catalog names the models it found',
  models.json.providers[0].models.map(model => model.id).join(',') === 'stub-model,other-model'
    && models.json.providers[0].providerName === 'Stub',
  JSON.stringify(models.json.providers[0]))
check('the catalog carries the current default selection to compare against',
  models.json.default.provider === 'stub-provider' && models.json.default.model === 'stub-model',
  JSON.stringify(models.json.default))
const catalogless = await requestOn(aiCataloglessRoute, '/api/git-panel/models')
check('a profile with no model adapter says so on the catalog route', catalogless.status === 503, `${catalogless.status}`)

const pickedDraft = await postOn(main.route, commitMessageUrl, { dir: repo, provider: 'stub-provider', model: 'other-model' })
check('a draft can be pointed at the picked model',
  pickedDraft.status === 200 && pickedDraft.json.provider === 'stub-provider' && pickedDraft.json.model === 'other-model',
  `${pickedDraft.json.provider}/${pickedDraft.json.model}`)
check('the picked route is the one the model was called on',
  main.services.llm.calls.at(-1).provider === 'stub-provider' && main.services.llm.calls.at(-1).model === 'other-model',
  `${main.services.llm.calls.at(-1).provider}/${main.services.llm.calls.at(-1).model}`)
const halfPick = await postOn(main.route, commitMessageUrl, { dir: repo, provider: 'stub-provider' })
check('a provider alone still follows the configured model id',
  halfPick.json.provider === 'stub-provider' && halfPick.json.model === 'stub-model', JSON.stringify({ p: halfPick.json.provider, m: halfPick.json.model }))
const badPick = await postOn(main.route, commitMessageUrl, { dir: repo, provider: 42 })
check('a non-string route is a 400, not a crashed draft',
  badPick.status === 400 && /provider must be a string/.test(badPick.json.error), JSON.stringify(badPick.json))
const longPick = await postOn(main.route, commitMessageUrl, { dir: repo, model: 'x'.repeat(200) })
check('an absurd route is refused before it reaches a provider',
  longPick.status === 400 && /at most 120 characters/.test(longPick.json.error), JSON.stringify(longPick.json))
const blankPick = await postOn(main.route, commitMessageUrl, { dir: repo, provider: '   ', model: '  ' })
check('a blank route falls back rather than calling a nameless model',
  blankPick.status === 200 && blankPick.json.model === 'stub-model', JSON.stringify(blankPick.json))

// ── local write actions: the index, the work tree, and history ──────────────
// These run last on purpose: they mutate the fixtures the reads above assert on.
const statusOf = async dir => (await request(`/api/git-panel/status?dir=${dirArg(dir)}`)).json
const local = (dir, body) => action({ dir, ...body })

const stagedOne = await local(repo, { action: 'stage', paths: ['a.txt'] })
check('stage runs git add and reports the single step',
  stagedOne.status === 200 && stagedOne.json.succeeded === true && stagedOne.json.steps.length === 1
    && stagedOne.json.steps[0].command.join(' ') === 'git add -- a.txt',
  `${stagedOne.status} ${JSON.stringify(stagedOne.json.steps?.map(step => step.command))}`)
const afterStage = await statusOf(repo)
check('staging moves the file into the index', afterStage.counts.staged === 1 && afterStage.counts.changed === 0,
  `${JSON.stringify(afterStage.counts)} ${JSON.stringify((afterStage.files ?? []).map(file => `${file.index}${file.worktree} ${file.path}`))}`)

const unstagedOne = await local(repo, { action: 'unstage', paths: ['a.txt'] })
check('unstage runs git reset and reports the single step',
  unstagedOne.status === 200 && unstagedOne.json.succeeded === true
    && unstagedOne.json.steps[0].command.join(' ') === 'git reset -q HEAD -- a.txt',
  JSON.stringify(unstagedOne.json.steps?.map(step => step.command)))
const afterUnstage = await statusOf(repo)
check('unstaging moves the file back to the work tree', afterUnstage.counts.staged === 0 && afterUnstage.counts.changed === 1, JSON.stringify(afterUnstage.counts))

const unstagedFresh = await postOn(route, actionUrl, { dir: fresh, action: 'unstage', paths: ['first.txt'] })
check('unstaging in a repository with no commit falls back to git rm --cached',
  unstagedFresh.status === 200 && unstagedFresh.json.succeeded === true
    && unstagedFresh.json.steps[0].command.join(' ') === 'git rm --cached -r --quiet -- first.txt',
  JSON.stringify(unstagedFresh.json.steps?.map(step => step.command)))
check('the unborn repository is back to an untracked file',
  execFileSync('git', ['status', '--porcelain'], { cwd: fresh, stdio: 'pipe' }).toString().trim() === '?? first.txt')

// Discarding is destructive, so it is gated like a push — and it must never
// delete an untracked file.
const noPaths = await local(repo, { action: 'discard' })
check('discard without paths is refused rather than discarding everything', noPaths.status === 400, `${noPaths.status}`)
const unconfirmedDiscard = await local(repo, { action: 'discard', paths: ['a.txt'] })
check('discard without confirmation is refused', unconfirmedDiscard.status === 428, `${unconfirmedDiscard.status}`)
const escapingPath = await local(repo, { action: 'discard', paths: ['../outside'], confirm: true })
check('a path that escapes the repository is refused', escapingPath.status === 400, `${escapingPath.status}`)
const absolutePath = await local(repo, { action: 'stage', paths: ['/etc/passwd'] })
check('an absolute path is refused', absolutePath.status === 400, `${absolutePath.status}`)
const noStagePaths = await local(repo, { action: 'stage' })
check('stage without paths is refused', noStagePaths.status === 400, `${noStagePaths.status}`)

const discarded = await local(repo, { action: 'discard', paths: ['a.txt'], confirm: true })
check('discard restores the file from the index',
  discarded.status === 200 && discarded.json.succeeded === true && readFileSync(join(repo, 'a.txt'), 'utf8') === 'hello\n',
  `${discarded.status} ${JSON.stringify(readFileSync(join(repo, 'a.txt'), 'utf8'))}`)
const untrackedDiscard = await local(repo, { action: 'discard', paths: ['b.txt'], confirm: true })
check('discarding an untracked file fails instead of deleting it',
  untrackedDiscard.status === 200 && untrackedDiscard.json.succeeded === false && existsSync(join(repo, 'b.txt')),
  `${untrackedDiscard.status} ${JSON.stringify(untrackedDiscard.json.stderr)}`)

// Committing: the message is required, and named paths are staged first.
const beforeCommits = Number(run(['rev-list', '--count', 'HEAD'], repo).toString().trim())
const noMessage = await local(repo, { action: 'commit' })
check('commit without a message is refused', noMessage.status === 400, `${noMessage.status}`)
const blankMessage = await local(repo, { action: 'commit', message: '   ' })
check('a whitespace-only commit message is refused', blankMessage.status === 400, `${blankMessage.status}`)
writeFileSync(join(repo, 'a.txt'), 'hello\ncommitted\n')
const committed = await local(repo, { action: 'commit', message: 'smoke: local commit', paths: ['a.txt'] })
check('commit stages the named paths and commits them',
  committed.status === 200 && committed.json.succeeded === true && committed.json.steps.length === 2
    && committed.json.steps[0].command.join(' ') === 'git add -- a.txt'
    && committed.json.steps[1].command.join(' ') === 'git commit -m smoke: local commit',
  `${committed.status} ${JSON.stringify(committed.json.steps?.map(step => step.command))}`)
check('the commit really landed', Number(run(['rev-list', '--count', 'HEAD'], repo).toString().trim()) === beforeCommits + 1)
check('the subject is the message the panel sent',
  run(['log', '-1', '--format=%s'], repo).toString().trim() === 'smoke: local commit')

// Stashing: also confirmed first, and it can take untracked files with it.
const unconfirmedStash = await local(repo, { action: 'stash' })
check('stash without confirmation is refused', unconfirmedStash.status === 428, `${unconfirmedStash.status}`)
writeFileSync(join(repo, 'a.txt'), 'hello\ncommitted\ndirty\n')
const stashed = await local(repo, { action: 'stash', confirm: true, includeUntracked: true })
check('stash cleans the work tree, untracked files included',
  stashed.status === 200 && stashed.json.succeeded === true
    && stashed.json.steps[0].command.slice(0, 4).join(' ') === 'git stash push --include-untracked'
    && /^dsh-git-panel: /.test(stashed.json.steps[0].command[5]),
  `${stashed.status} ${JSON.stringify(stashed.json.steps?.map(step => step.command))}`)
const afterStash = await statusOf(repo)
check('nothing is left uncommitted after the stash',
  afterStash.counts.changed === 0 && afterStash.counts.untracked === 0 && afterStash.counts.staged === 0, JSON.stringify(afterStash.counts))
check('the stash entry exists', run(['stash', 'list'], repo).toString().trim().split('\n').filter(Boolean).length === 1)

// Read-only mode leaves fetch available and the local writes refused.
const readOnlyStage = await postOn(readOnlyRoute, actionUrl, { dir: repo, action: 'stage', paths: ['a.txt'] })
check('local writes can be switched off by configuration',
  readOnlyStage.status === 403 && /disabled/i.test(String(readOnlyStage.json?.error)), `${readOnlyStage.status} ${JSON.stringify(readOnlyStage.json)}`)
const readOnlyFetch = await postOn(readOnlyRoute, actionUrl, { dir: other, action: 'fetch' })
check('switching local writes off leaves fetch available', readOnlyFetch.status === 200 && readOnlyFetch.json.succeeded === true, `${readOnlyFetch.status}`)

// ── project summaries: one model call for every workspace ───────────────────
// The parser only keeps clean numbered lines; decoration is dropped piece by
// piece instead of sinking the whole answer.
{
  const parsed = parseSummaryLines('1. 第一个项目\n垃圾行\n2. 「第二个项目」\n9. 越界\n1. 覆盖\n', 3)
  check('the summary parser keeps numbered lines and drops junk',
    JSON.stringify(parsed) === JSON.stringify(['覆盖', '第二个项目', null]),
    JSON.stringify(parsed))
  check('a later duplicate line wins its slot', parsed[0] === '覆盖', String(parsed[0]))
  const prompt = buildSummaryPrompt([
    { index: 1, title: 'alpha', description: '一个描述', readme: 'README 开头', commits: ['feat: 一', 'fix: 二'] },
    { index: 2, title: 'beta', description: null, readme: null, commits: [] },
  ], '中文')
  check('the prompt numbers every workspace and carries its signals',
    prompt.includes('1. 项目「alpha」') && prompt.includes('2. 项目「beta」')
      && prompt.includes('package.json 描述：一个描述') && prompt.includes('feat: 一'),
    prompt.split('\n').slice(0, 4).join(' | '))
}

const summaryReply = Array.from({ length: 8 }, (_unused, index) => `${String(index + 1)}. 项目 ${String(index + 1)} 的一句话`).join('\n')
const summaryMount = mount({ llmReply: [summaryReply] })
const summaryPost = (body, headers) => postOn(summaryMount.route, '/api/git-panel/project-summaries', body, headers)
const firstSummaries = await summaryPost({})
check('one call summarizes every workspace by path',
  firstSummaries.status === 200 && firstSummaries.json.ok === true
    && Object.keys(firstSummaries.json.summaries).length === 8
    && firstSummaries.json.summaries[realpathSync(repo)] === '项目 1 的一句话',
  `${firstSummaries.status} ${JSON.stringify(firstSummaries.json.summaries).slice(0, 120)}`)
check('the answer names the model that wrote it',
  firstSummaries.json.provider === 'stub-provider' && firstSummaries.json.model === 'stub-model'
    && firstSummaries.json.cached === false)
check('the store lands on disk with one entry per workspace',
  existsSync(join(root, 'summaries.json'))
    && Object.keys(JSON.parse(readFileSync(join(root, 'summaries.json'), 'utf8'))).length === 8)
const summaryCallsAfterFirst = summaryMount.services.llm.calls.length
const secondSummaries = await summaryPost({})
check('a second ask is answered from the store, zero model calls',
  secondSummaries.status === 200 && secondSummaries.json.cached === true
    && summaryMount.services.llm.calls.length === summaryCallsAfterFirst,
  `calls=${String(summaryMount.services.llm.calls.length)}`)
// Only the changed project is rewritten: one new commit in `repo` and the
// next ask's prompt carries its signals alone.
run(['commit', '-q', '--allow-empty', '-m', 'smoke: summary invalidation'], repo)
const thirdSummaries = await summaryPost({})
const stalePrompt = summaryMount.services.llm.calls.at(-1).messages[0].content[0].text
check('a changed project alone is re-summarized',
  thirdSummaries.status === 200 && summaryMount.services.llm.calls.length === summaryCallsAfterFirst + 1
    && stalePrompt.includes('项目「repo」') && !stalePrompt.includes('项目「clone」'),
  stalePrompt.split('\n').filter(line => line.startsWith('1.') || line.startsWith('2.')).join(' | '))
check('the unchanged projects kept their stored lines',
  thirdSummaries.json.summaries[realpathSync(clone)] === secondSummaries.json.summaries[realpathSync(clone)]
    && thirdSummaries.json.summaries[realpathSync(repo)] !== null)
// The invalidation was a means, not an end: take it back so the history
// assertions below still read the fixture they know.
run(['reset', '-q', 'HEAD~1'], repo)
check('the fixture is restored after the invalidation probe',
  run(['log', '--format=%s', '-1'], repo).toString().trim() !== 'smoke: summary invalidation')
// A workspace that is gone from the registry leaves the store too.
{
  const stored = JSON.parse(readFileSync(join(root, 'summaries.json'), 'utf8'))
  stored['/no/such/workspace'] = { fingerprint: 'x', summary: '幽灵项目', provider: 'p', model: 'm', at: 1 }
  writeFileSync(join(root, 'summaries.json'), JSON.stringify(stored))
  await summaryPost({})
  const after = JSON.parse(readFileSync(join(root, 'summaries.json'), 'utf8'))
  check('a workspace that left the registry is pruned from the store',
    after['/no/such/workspace'] === undefined && Object.keys(after).length === 8,
    JSON.stringify(Object.keys(after).length))
}
// A corrupt store file reads as empty, not as an error.
writeFileSync(join(root, 'summaries.json'), 'not json')
const afterCorruption = await summaryPost({})
check('a corrupt store reads as empty and gets rewritten',
  afterCorruption.status === 200 && afterCorruption.json.ok === true
    && Object.keys(JSON.parse(readFileSync(join(root, 'summaries.json'), 'utf8'))).length === 8,
  `${afterCorruption.status}`)
const callsBeforeForce = summaryMount.services.llm.calls.length
const forcedSummaries = await summaryPost({ force: true })
check('force rewrites everything in one call',
  forcedSummaries.status === 200 && forcedSummaries.json.cached === false
    && summaryMount.services.llm.calls.length === callsBeforeForce + 1)

// ── a batch that fails costs its own projects, not the answered ones ─────────
// The store is fully populated at this point, so every project has a line to
// keep: the model refusing to write new ones must not blank the cards.
{
  const failing = mount({ llmThrows: '400 model "MiniMax-M3.1-Flash-Preview" requires adaptive thinking' })
  const kept = await postOn(failing.route, '/api/git-panel/project-summaries', { force: true })
  check('a failed batch still answers with every stored line',
    kept.status === 200 && kept.json.ok === true
      && Object.values(kept.json.summaries).filter(value => value !== null).length === 8,
    `${kept.status} ${JSON.stringify(kept.json.summaries).slice(0, 120)}`)
  check('the failed batch names the failure and how many projects it cost',
    typeof kept.json.error === 'string' && kept.json.error.includes('requires adaptive thinking')
      && kept.json.failed === 8 && kept.json.cached === false,
    JSON.stringify({ error: kept.json.error, failed: kept.json.failed }))
  failing.dispose()
}
// A failure frame (rather than a throw) settles the same way.
{
  const failing = mount({ llmFailure: 'upstream refused the request' })
  const kept = await postOn(failing.route, '/api/git-panel/project-summaries', { force: true })
  check('a failure frame keeps the stored lines too',
    kept.status === 200 && kept.json.error === 'upstream refused the request'
      && Object.values(kept.json.summaries).filter(value => value !== null).length === 8,
    `${kept.status} ${JSON.stringify(kept.json).slice(0, 120)}`)
  failing.dispose()
}
// With nothing stored there is no answer to keep, so the failure is the answer.
{
  const previousStore = process.env.DSH_GIT_PANEL_SUMMARY_STORE
  const emptyStore = join(root, 'empty-summaries.json')
  process.env.DSH_GIT_PANEL_SUMMARY_STORE = emptyStore
  const failing = mount({ llmThrows: 'the route refused the request' })
  const answer = await postOn(failing.route, '/api/git-panel/project-summaries', {})
  check('a failed batch with nothing stored is an honest error',
    answer.status === 502 && String(answer.json?.error).includes('refused the request'),
    `${answer.status} ${JSON.stringify(answer.json)}`)
  failing.dispose()
  process.env.DSH_GIT_PANEL_SUMMARY_STORE = previousStore
  rmSync(emptyStore, { force: true })
}

// ── the reasoning effort the panel's calls ask for ───────────────────────────
// A route whose model refuses a thinking-disabled request needs this seam; it
// must reach the model call itself, not just the config object.
{
  const effortMount = mount({ llmReply: [summaryReply], aiCommitReasoningEffort: 'low' })
  await postOn(effortMount.route, '/api/git-panel/project-summaries', { force: true })
  check('the configured reasoning effort reaches the summary call',
    effortMount.services.llm.calls.at(-1).reasoningEffort === 'low',
    String(effortMount.services.llm.calls.at(-1).reasoningEffort))
  await postOn(effortMount.route, '/api/git-panel/project-summaries', { force: true, reasoningEffort: 'max' })
  check('a request may name the reasoning effort of its own call',
    effortMount.services.llm.calls.at(-1).reasoningEffort === 'max',
    String(effortMount.services.llm.calls.at(-1).reasoningEffort))
  const malformed = await postOn(effortMount.route, '/api/git-panel/project-summaries', { reasoningEffort: 'low\nhigh' })
  check('a reasoning effort must be a single line',
    malformed.status === 400, `${malformed.status} ${JSON.stringify(malformed.json)}`)
  effortMount.dispose()
}
// No configured effort means the option is *absent*, never the literal `off`:
// naming `off` is a request to disable thinking, which some routes refuse.
{
  const quietMount = mount({ llmReply: [summaryReply] })
  await postOn(quietMount.route, '/api/git-panel/project-summaries', { force: true })
  check('an unset reasoning effort omits the option instead of sending off',
    !('reasoningEffort' in quietMount.services.llm.calls.at(-1)),
    JSON.stringify(Object.keys(quietMount.services.llm.calls.at(-1))))
  quietMount.dispose()
}
summaryMount.dispose()
const summariesDenied = await postOn(mount({ aiCommitEnabled: false }).route, '/api/git-panel/project-summaries', {})
check('summaries share the AI kill switch', summariesDenied.status === 403, `${summariesDenied.status}`)
check('summaries without the panel header are refused',
  (await summaryPost({}, { 'content-type': 'application/json' })).status === 403)

// ── the streaming draft: same answer, watched as it is written ───────────────
/** POST a body to the streaming route and capture the frames it writes. */
async function openDraftStream(target, body, headers) {
  let status = 0
  const responseHeaders = {}
  let text = ''
  const payload = JSON.stringify(body)
  const request = {
    method: 'POST',
    url: '/api/git-panel/commit-message/stream',
    headers: headers ?? { 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    },
    once: () => {},
  }
  const response = {
    writeHead: (code, head) => { status = code; Object.assign(responseHeaders, head ?? {}) },
    write: (chunk) => { text += String(chunk); return true },
    end: (chunk) => { if (chunk !== undefined) text += String(chunk) },
  }
  await target.handler(request, response)
  return { status, headers: responseHeaders, text, frames: framesOf(text) }
}

// The draft needs something to describe; the tree is clean at this point.
writeFileSync(join(repo, 'stream.txt'), 'stream me\n')
const draftStream = await openDraftStream(main.route, { dir: repo })
check('the streaming draft answers 200 as text/event-stream',
  draftStream.status === 200 && /text\/event-stream/.test(draftStream.headers['content-type'] ?? ''),
  `${draftStream.status} ${JSON.stringify(draftStream.headers)}`)
const streamEvents = draftStream.frames.map(frame => frame.event)
check('the stream opens with what the model will read, then writes, then finishes',
  streamEvents[0] === 'begin' && streamEvents.at(-1) === 'done' && streamEvents.includes('delta'),
  JSON.stringify(streamEvents))
const streamBegin = draftStream.frames[0].data
check('the begin frame is the same reading the plain route reports',
  streamBegin.source === 'all' && streamBegin.files === 1 && streamBegin.untracked === 1,
  JSON.stringify(streamBegin))
const streamDeltas = draftStream.frames.filter(frame => frame.event === 'delta').map(frame => frame.data.text)
check('the deltas are the reply, in order',
  streamDeltas.join('').includes('feat: 默认回复'), JSON.stringify(streamDeltas))
const streamDone = draftStream.frames.at(-1).data
check('the done frame is the sanitized draft the plain route would answer',
  streamDone.message === 'feat: 默认回复' && streamDone.provider === 'stub-provider'
    && streamDone.model === 'stub-model' && streamDone.usageReported === true && streamDone.inputTokens === 42,
  JSON.stringify(streamDone))

// Everything that can fail before the model starts still fails as plain JSON:
// no SSE headers, no frames, just the error a caller already knows.
const noHeaderStream = await openDraftStream(main.route, { dir: repo }, { 'content-type': 'application/json' })
check('a streaming draft without the panel header is a plain 403',
  noHeaderStream.status === 403 && noHeaderStream.frames.length === 0
    && JSON.parse(noHeaderStream.text).error.includes('x-dsh-git-panel'),
  `${noHeaderStream.status} ${noHeaderStream.text.slice(0, 80)}`)
const disabledStream = await openDraftStream(mount({ aiCommitEnabled: false }).route, { dir: repo })
check('a disabled draft is a plain 403, not a stream',
  disabledStream.status === 403 && disabledStream.frames.length === 0, `${disabledStream.status}`)
// The model failing mid-stream can only become an error frame: the headers
// are already out, so the failure travels as data the client can show.
const failingStream = await openDraftStream(mount({ llmFailure: 'upstream exploded' }).route, { dir: repo })
check('a model failure mid-stream arrives as an error frame',
  failingStream.status === 200
    && failingStream.frames.some(frame => frame.event === 'error' && frame.data.message.includes('upstream exploded')),
  JSON.stringify(failingStream.frames.map(frame => frame.event)))
rmSync(join(repo, 'stream.txt'))

// ── model memory as profile configuration, and the draft as a tool ─────────
writeFileSync(join(repo, 'prefs.txt'), 'prefs\n')
const settingsMount = mount({ settings: { value: { aiCommitProvider: '', aiCommitModel: '' } } })
const catalogRoute = await requestOn(settingsMount.route, '/api/git-panel/models')
check('with nothing remembered, /models says so',
  catalogRoute.status === 200 && catalogRoute.json.remembered === null,
  JSON.stringify(catalogRoute.json.remembered))
const saveChoice = await postOn(settingsMount.route, '/api/git-panel/prefs', { provider: 'stub-provider', model: 'other-model' })
check('picking a model writes the plugin\'s own configuration',
  saveChoice.status === 200 && saveChoice.json.persisted === true
    && settingsMount.services.settings.updates.length === 1
    && settingsMount.services.settings.updates[0].ns === 'git-panel'
    && settingsMount.services.settings.updates[0].patch.aiCommitProvider === 'stub-provider'
    && settingsMount.services.settings.updates[0].patch.aiCommitModel === 'other-model',
  JSON.stringify({ status: saveChoice.status, updates: settingsMount.services.settings.updates }))
check('after a pick, /models reports it as the remembered choice',
  (await requestOn(settingsMount.route, '/api/git-panel/models')).json.remembered?.model === 'other-model')
const rememberedDraft = await postOn(settingsMount.route, commitMessageUrl, { dir: repo })
check('a draft with no explicit choice uses the remembered one',
  rememberedDraft.status === 200 && rememberedDraft.json.provider === 'stub-provider'
    && rememberedDraft.json.model === 'other-model',
  JSON.stringify({ provider: rememberedDraft.json?.provider, model: rememberedDraft.json?.model }))
const explicitDraft = await postOn(settingsMount.route, commitMessageUrl, { dir: repo, provider: 'stub-provider', model: 'stub-model' })
check('an explicit choice still beats the remembered one',
  explicitDraft.status === 200 && explicitDraft.json.model === 'stub-model',
  JSON.stringify(explicitDraft.json?.model))
const cleared = await postOn(settingsMount.route, '/api/git-panel/prefs', {})
check('clearing the choice writes empty values, not a deleted row',
  cleared.status === 200 && cleared.json.persisted === true
    && (await requestOn(settingsMount.route, '/api/git-panel/models')).json.remembered === null)
settingsMount.dispose()

const noSettingsMount = mount({})
const noSettingsPrefs = await postOn(noSettingsMount.route, '/api/git-panel/prefs', { provider: 'stub-provider', model: 'stub-model' })
check('without a settings service the answer says it could not persist',
  noSettingsPrefs.status === 200 && noSettingsPrefs.json.persisted === false
    && noSettingsPrefs.json.reason === 'no-settings-service',
  JSON.stringify(noSettingsPrefs.json))
check('without a settings service /models remembers nothing',
  (await requestOn(noSettingsMount.route, '/api/git-panel/models')).json.remembered === null)
noSettingsMount.dispose()

const failingSettingsMount = mount({ settings: { value: { aiCommitProvider: '', aiCommitModel: '' }, fail: true } })
check('a settings write that fails is reported, not faked',
  (await postOn(failingSettingsMount.route, '/api/git-panel/prefs', { provider: 'stub-provider', model: 'stub-model' })).json.persisted === false)
failingSettingsMount.dispose()

check('prefs without the panel header is refused',
  (await postOn(main.route, '/api/git-panel/prefs', { provider: 'x' }, { 'content-type': 'application/json' })).status === 403)
check('prefs with a multiline model name is refused',
  (await postOn(main.route, '/api/git-panel/prefs', { provider: 'stub-provider', model: 'a\nb' })).status === 400)

const commitTool = main.tools.get('git_commit_message')
check('the plugin offers a git_commit_message tool', typeof commitTool === 'object' && commitTool !== null)
const toolDraft = await commitTool.execute({ dir: repo, staged: false }, {})
check('the tool drafts with the default model and says it only drafts',
  toolDraft.message === 'feat: 默认回复' && toolDraft.provider === 'stub-provider'
    && toolDraft.input_tokens === 42 && /draft only/.test(toolDraft.note),
  JSON.stringify(toolDraft))
const toolDraftExplicit = await commitTool.execute({ dir: repo, provider: 'stub-provider', model: 'other-model' }, {})
check('the tool takes an explicit model too',
  toolDraftExplicit.model === 'other-model', JSON.stringify(toolDraftExplicit.model))
rmSync(join(repo, 'prefs.txt'))

// ── history: the log, one commit, and a diff read from a commit ─────────────
const readJson = async path => (await request(path)).json
const log = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=5`)
check('the log lists the newest commits first',
  log.ok === true && log.commits.length >= 2 && log.commits[0].subject === 'smoke: local commit',
  JSON.stringify(log.commits?.map(commit => commit.subject)))
check('a log entry carries the full hash and an abbreviation that matches it',
  /^[0-9a-f]{40}$/.test(log.commits[0].hash) && log.commits[0].hash.startsWith(log.commits[0].short)
    && log.commits[0].short.length >= 7,
  JSON.stringify({ hash: log.commits[0].hash, short: log.commits[0].short }))
check('a log entry names its author and date',
  log.commits[0].author === 'Smoke' && !Number.isNaN(Date.parse(log.commits[0].date)),
  JSON.stringify({ author: log.commits[0].author, date: log.commits[0].date }))
check('a log entry carries its refs, HEAD decoration included',
  log.commits[0].refs.some(ref => /^HEAD -> \S+$/.test(ref)), JSON.stringify(log.commits[0].refs))
const logLimited = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=1`)
check('limit caps the log', logLimited.commits.length === 1, String(logLimited.commits.length))
check('a limit of zero is refused', (await request(`/api/git-panel/log?dir=${dirArg(repo)}&limit=0`)).status === 400)
check('an absurd limit is refused', (await request(`/api/git-panel/log?dir=${dirArg(repo)}&limit=5000`)).status === 400)
const unbornLog = await readJson(`/api/git-panel/log?dir=${dirArg(fresh)}`)
check('a repository with no commits reports an empty log rather than failing',
  unbornLog.ok === true && unbornLog.commits.length === 0 && unbornLog.repo !== null, JSON.stringify(unbornLog))
const nonRepoLog = await readJson(`/api/git-panel/log?dir=${dirArg(plain)}`)
check('a directory that is not a repository reports no log',
  nonRepoLog.ok === true && nonRepoLog.repo === null && nonRepoLog.reason === 'not-a-repository', JSON.stringify(nonRepoLog))

const rootCommit = run(['rev-list', '--max-parents=0', 'HEAD'], repo).toString().trim()
const show = await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${rootCommit}`)
check('show describes the commit itself',
  show.ok === true && show.commit.hash === rootCommit && show.commit.subject === 'init',
  JSON.stringify(show.commit))
check('show lists the files the commit touched, with their sizes',
  show.files.length === 1 && show.files[0].path === 'a.txt' && show.files[0].status === 'A'
    && show.files[0].added === 1 && show.files[0].deleted === 0,
  JSON.stringify(show.files))
check('a malformed hash is refused', (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=..%2Fetc`)).status === 400)
check('an unknown commit is a 404',
  (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${'0'.repeat(40)}`)).status === 404)

const headHash = run(['rev-parse', 'HEAD'], repo).toString().trim()
const commitDiff = await readJson(`/api/git-panel/diff?dir=${dirArg(repo)}&path=a.txt&hash=${headHash}`)
check('a commit diff is plain diff text with no commit header',
  commitDiff.ok === true && commitDiff.kind === 'text' && commitDiff.text.includes('@@')
    && commitDiff.text.includes('+committed') && !/^commit /m.test(commitDiff.text),
  JSON.stringify(commitDiff.text?.slice(0, 120)))
check('a malformed hash is refused by the diff route',
  (await request(`/api/git-panel/diff?dir=${dirArg(repo)}&path=a.txt&hash=nothex`)).status === 400)
const commitContext = await readJson(`/api/git-panel/context?dir=${dirArg(repo)}&path=a.txt&hash=${headHash}&start=1&count=5`)
check('context inside a commit diff reads that commit, not the work tree',
  commitContext.lines.join(',') === 'hello,committed', JSON.stringify(commitContext))
check('hash and staged together are refused',
  (await request(`/api/git-panel/context?dir=${dirArg(repo)}&path=a.txt&hash=${headHash}&staged=1&start=1&count=5`)).status === 400)

// ── paging, branches, filters, and a real merge ─────────────────────────────
// Real branches and a real merge in the fixture, so parents, paging and the
// branch list are asserted against git rather than against a fixture object.
/** The fixture repository's own initial branch, whatever git named it. */
const repoBranch = run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim()
writeFileSync(join(repo, 'side.txt'), 'side\n')
run(['checkout', '-q', '-b', 'smoke-side'], repo)
run(['add', '--', 'side.txt'], repo)
run(['-c', 'user.name=Side', 'commit', '-q', '-m', 'smoke: side work'], repo)
run(['checkout', '-q', repoBranch], repo)
run(['checkout', '-q', '-b', 'smoke-unmerged'], repo)
writeFileSync(join(repo, 'loose.txt'), 'loose\n')
run(['add', '--', 'loose.txt'], repo)
run(['commit', '-q', '-m', 'smoke: unmerged work'], repo)
run(['checkout', '-q', repoBranch], repo)
writeFileSync(join(repo, 'main.txt'), 'main\n')
run(['add', '--', 'main.txt'], repo)
run(['commit', '-q', '-m', 'smoke: main work'], repo)
run(['merge', '--no-ff', '-q', '-m', 'smoke: merge side', 'smoke-side'], repo)

const merged = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=1`)
check('the newest commit is the merge, and it names both its parents',
  merged.commits[0].subject === 'smoke: merge side' && merged.commits[0].parents.length === 2,
  JSON.stringify({ subject: merged.commits[0].subject, parents: merged.commits[0].parents }))
// A merge has one diff per parent and `git show` prints none of them, so the
// panel asks for a side explicitly.
const mergeHash = run(['rev-parse', 'HEAD'], repo).toString().trim()
const mergeItself = await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${mergeHash}`)
check('a merge commit reports no files of its own, the way git does',
  mergeItself.ok === true && mergeItself.files.length === 0 && mergeItself.parent === undefined,
  JSON.stringify(mergeItself.files))
const mergeFirst = await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${mergeHash}&parent=1`)
check('against its first parent a merge lists what the merge brought in',
  mergeFirst.parent === 1 && mergeFirst.files.map(file => file.path).join(',') === 'side.txt',
  JSON.stringify({ parent: mergeFirst.parent, files: mergeFirst.files.map(file => file.path) }))
const mergeSecond = await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${mergeHash}&parent=2`)
check('against its second parent a merge lists the other side',
  mergeSecond.parent === 2 && mergeSecond.files.map(file => file.path).join(',') === 'main.txt',
  JSON.stringify({ parent: mergeSecond.parent, files: mergeSecond.files.map(file => file.path) }))
const mergeDiff = await readJson(`/api/git-panel/diff?dir=${dirArg(repo)}&hash=${mergeHash}&parent=2&path=main.txt`)
check('a merge diff against a parent is a real patch, not an empty show',
  mergeDiff.ok === true && mergeDiff.kind === 'text' && mergeDiff.text.includes('+main'),
  JSON.stringify(mergeDiff.text?.slice(0, 80)))
check('an out-of-range parent is refused',
  (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${mergeHash}&parent=0`)).status === 400)
check('a parent past the octopus limit is refused',
  (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${mergeHash}&parent=9`)).status === 400)
check('a non-numeric parent is refused',
  (await request(`/api/git-panel/diff?dir=${dirArg(repo)}&hash=${mergeHash}&parent=x&path=main.txt`)).status === 400)
const mergeService = await service.show(repo, mergeHash, 2)
check('the service can read a merge against a parent too',
  mergeService.files.map(file => file.path).join(',') === 'main.txt',
  JSON.stringify(mergeService.files.map(file => file.path)))

check('a commit carries its parent so a graph can be drawn',
  merged.commits[0].parents.every(parent => /^[0-9a-f]{7,}$/.test(parent)),
  JSON.stringify(merged.commits[0].parents))

const whole = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=200`)
check('the first commit of a repository has no parents', whole.commits.at(-1).parents.length === 0,
  JSON.stringify(whole.commits.at(-1)))
// The invariant the lane layout rests on: a parent id is written the same way
// as the commit ids beside it, so a lane can recognise the commit it waits for.
// Full hashes next to abbreviations once opened one lane per commit.
const abbreviations = new Set(whole.commits.map(commit => commit.short))
const unmatched = whole.commits.flatMap(commit => commit.parents).filter(parent => !abbreviations.has(parent))
check('every parent in a page is written exactly like the commits in it',
  unmatched.every(parent => whole.commits.every(commit => commit.hash !== parent)),
  JSON.stringify(unmatched.slice(0, 3)))
const page1 = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=2`)
const page2 = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=2&skip=2`)
check('a page reports the size and offset it used',
  page1.commits.length === 2 && page2.commits.length === 2 && page1.limit === 2 && page2.skip === 2,
  JSON.stringify({ limit: page1.limit, skip: page2.skip }))
check('two pages neither overlap nor reorder',
  !page1.commits.some(commit => page2.commits.some(other => other.hash === commit.hash))
    && [...page1.commits, ...page2.commits].map(commit => commit.hash).join(',')
      === whole.commits.slice(0, 4).map(commit => commit.hash).join(','),
  JSON.stringify([...page1.commits, ...page2.commits].map(commit => commit.short)))
const pastEnd = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=5&skip=500`)
check('skipping past the end is an empty page, not an error',
  pastEnd.ok === true && pastEnd.commits.length === 0, JSON.stringify(pastEnd.commits))
const byPath = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=50&path=side.txt`)
check('a path filter lists only the commits that touched that path',
  byPath.commits.length > 0
    && byPath.commits.some(commit => commit.subject === 'smoke: side work')
    && !byPath.commits.some(commit => commit.subject === 'smoke: main work'),
  JSON.stringify(byPath.commits.map(commit => commit.subject)))
// git's own path simplification decides this, and the panel reports what git
// says rather than "fixing" it: a merge that only brings a branch in is not a
// commit that changed the file.
const pathSubjects = run(['log', '--format=%s', '--', 'side.txt'], repo).toString().trim().split('\n')
check('a path filter agrees with git log for that path',
  byPath.commits.map(commit => commit.subject).join(',') === pathSubjects.join(','),
  JSON.stringify({ route: byPath.commits.map(commit => commit.subject), git: pathSubjects }))
const byAuthor = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=50&author=Side`)
check('an author filter keeps only that author',
  byAuthor.commits.length === 1 && byAuthor.commits[0].author === 'Side',
  JSON.stringify(byAuthor.commits.map(commit => `${commit.author}:${commit.subject}`)))
const byGrep = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=50&grep=${encodeURIComponent('MERGE SIDE')}`)
check('a message filter ignores case',
  byGrep.commits.length === 1 && byGrep.commits[0].subject === 'smoke: merge side',
  JSON.stringify(byGrep.commits.map(commit => commit.subject)))
const branchRef = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=1&ref=smoke-side`)
check('a named ref reads that branch, not the checked-out one',
  branchRef.commits[0].subject === 'smoke: side work', JSON.stringify(branchRef.commits.map(commit => commit.subject)))
const onMain = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=50`)
check('an unmerged branch stays out of the current branch history',
  !onMain.commits.some(commit => commit.subject === 'smoke: unmerged work'),
  JSON.stringify(onMain.commits.map(commit => commit.subject).slice(0, 4)))
const everyRef = await readJson(`/api/git-panel/log?dir=${dirArg(repo)}&limit=50&all=1`)
check('asking for every ref reaches the unmerged branch',
  everyRef.commits.some(commit => commit.subject === 'smoke: unmerged work'),
  JSON.stringify(everyRef.commits.map(commit => commit.subject).slice(0, 4)))
check('a ref that looks like an option is refused',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&ref=-x`)).status === 400)
check('a ref git could not read as a name is refused',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&ref=main..smoke-side`)).status === 400)
check('a ref with a space is refused',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&ref=${encodeURIComponent('main smoke-side')}`)).status === 400)
check('a ref that does not exist is a 404, not an empty history',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&ref=no-such-branch`)).status === 404)
check('a negative skip is refused', (await request(`/api/git-panel/log?dir=${dirArg(repo)}&skip=-1`)).status === 400)
check('an absurd skip is refused', (await request(`/api/git-panel/log?dir=${dirArg(repo)}&skip=100001`)).status === 400)
check('a control character in a text filter is refused',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&grep=a%0Ab`)).status === 400)
check('an over-long path filter is refused',
  (await request(`/api/git-panel/log?dir=${dirArg(repo)}&path=${'x'.repeat(501)}`)).status === 400)

// ── the branch list ─────────────────────────────────────────────────────────
const branchList = await readJson(`/api/git-panel/branches?dir=${dirArg(repo)}`)
const mainBranch = branchList.branches.find(branch => branch.name === repoBranch)
check('the branch list names the checked-out branch',
  branchList.current === repoBranch && mainBranch?.current === true,
  JSON.stringify({ current: branchList.current, marked: branchList.branches.filter(branch => branch.current).map(branch => branch.name) }))
check('the branch list has every local branch, merged or not',
  [repoBranch, 'smoke-side', 'smoke-unmerged'].every(name => branchList.branches.some(branch => branch.name === name)),
  JSON.stringify(branchList.branches.map(branch => branch.name)))
check('a branch with no upstream says so instead of inventing one',
  mainBranch?.upstream === null && mainBranch?.track === null,
  JSON.stringify({ upstream: mainBranch?.upstream, track: mainBranch?.track }))
check('a branch carries its tip and when it was committed',
  /^[0-9a-f]{7,}$/.test(mainBranch?.short ?? '') && !Number.isNaN(Date.parse(mainBranch?.date ?? '')),
  JSON.stringify({ short: mainBranch?.short, date: mainBranch?.date }))
const cloneBranches = await readJson(`/api/git-panel/branches?dir=${dirArg(clone)}`)
const cloneMain = cloneBranches.branches.find(branch => branch.name === 'main')
// The count is whatever the run above left behind, so it is read from git
// rather than assumed.
const expectedTrack = run(['for-each-ref', '--format=%(upstream:track)', 'refs/heads/main'], clone).toString().trim()
const expectedUpstream = run(['for-each-ref', '--format=%(upstream:short)', 'refs/heads/main'], clone).toString().trim()
check('a branch with an upstream reports where it stands, as git counts it',
  cloneMain?.upstream === expectedUpstream && cloneMain?.track === expectedTrack,
  JSON.stringify({ upstream: cloneMain?.upstream, track: cloneMain?.track, want: { upstream: expectedUpstream, track: expectedTrack } }))
check('the checked-out branch is listed first', cloneBranches.branches[0]?.current === true,
  JSON.stringify(cloneBranches.branches.map(branch => branch.name)))
run(['checkout', '-q', '--detach', 'HEAD'], repo)
const detached = await readJson(`/api/git-panel/branches?dir=${dirArg(repo)}`)
check('a detached HEAD is reported as no branch at all',
  detached.current === null && detached.branches.every(branch => branch.current === false),
  JSON.stringify({ current: detached.current, marked: detached.branches.filter(branch => branch.current).length }))
run(['checkout', '-q', repoBranch], repo)
const plainBranches = await readJson(`/api/git-panel/branches?dir=${dirArg(plain)}`)
check('a directory that is not a repository has no branches',
  plainBranches.ok === true && plainBranches.repo === null && plainBranches.branches.length === 0,
  JSON.stringify(plainBranches))

// The service an agent reaches offers the same paging and branch reads.
const servicePage = await service.logPage(repo, { limit: 1 })
check('the service can page history too',
  Array.isArray(servicePage.commits) && servicePage.commits.length === 1 && servicePage.limit === 1,
  JSON.stringify(servicePage.commits?.length))
const serviceBranches = await service.branches(repo)
check('the service can read branches too',
  Array.isArray(serviceBranches.branches) && serviceBranches.current === repoBranch,
  JSON.stringify(serviceBranches.current))

// ── in-progress operations: merge conflicts, abort and continue ─────────────
// A real conflicted merge in the fixture: branch, edit both sides, merge.
const statusOf2 = async dir => (await readJson(`/api/git-panel/status?dir=${dirArg(dir)}`))
run(['checkout', '-q', '-b', 'smoke-conflict'], repo)
writeFileSync(join(repo, 'main.txt'), 'side version\n')
run(['commit', '-qam', 'smoke: conflict side'], repo)
run(['checkout', '-q', repoBranch], repo)
writeFileSync(join(repo, 'main.txt'), 'main version\n')
run(['commit', '-qam', 'smoke: conflict main'], repo)
let mergeFailed = false
try {
  run(['merge', 'smoke-conflict'], repo)
} catch {
  mergeFailed = true
}
check('the fixture merge really conflicts', mergeFailed === true)
const midMerge = await statusOf2(repo)
check('a conflicted merge is reported as an operation in progress',
  midMerge.operation !== null && midMerge.operation.kind === 'merge' && midMerge.operation.unmerged === 1,
  JSON.stringify(midMerge.operation))
check('the conflicted file is listed as unmerged too',
  midMerge.counts.conflicted === 1 && midMerge.files.some(file => file.unmerged === true && file.path === 'main.txt'),
  JSON.stringify(midMerge.files.filter(file => file.unmerged).map(file => file.path)))

// The combined diff of the conflicted file parses instead of reading as empty.
const conflictDiff = await readJson(`/api/git-panel/diff?dir=${dirArg(repo)}&path=main.txt`)
check('a conflicted file diffs as text, not as an empty answer',
  conflictDiff.kind === 'text' && conflictDiff.text.includes('diff --cc') && conflictDiff.text.includes('<<<<<<<'),
  JSON.stringify(conflictDiff.text?.slice(0, 80)))

// Continuing with unresolved conflicts is refused before git is even asked.
const prematureContinue = await local(repo, { action: 'continueOperation' })
check('continuing with unresolved conflicts is refused with the count',
  prematureContinue.status === 200 && prematureContinue.json.succeeded === false
    && prematureContinue.json.steps.at(-1).stderr.includes('1 个文件冲突'),
  JSON.stringify(prematureContinue.json.steps?.at(-1)))

// Aborting asks twice, then really aborts.
check('aborting an operation without confirmation is refused',
  (await local(repo, { action: 'abortOperation' })).status === 428)
const aborted = await local(repo, { action: 'abortOperation', confirm: true })
check('aborting a merge runs git merge --abort and ends the operation',
  aborted.status === 200 && aborted.json.succeeded === true
    && aborted.json.steps[0].command.join(' ') === 'git merge --abort'
    && (await statusOf2(repo)).operation === null,
  JSON.stringify(aborted.json.steps?.map(step => step.command)))

// With nothing in progress, both verbs say so instead of guessing.
const idleAbort = await local(repo, { action: 'abortOperation', confirm: true })
check('aborting with nothing in progress is reported, not invented',
  idleAbort.status === 200 && idleAbort.json.succeeded === false
    && idleAbort.json.steps.at(-1).stderr.includes('没有进行中'),
  JSON.stringify(idleAbort.json.steps?.at(-1)))

// Merge again, resolve the conflict, stage it, and continue for real.
try {
  run(['merge', 'smoke-conflict'], repo)
} catch {
  // expected: it conflicts again
}
writeFileSync(join(repo, 'main.txt'), 'resolved version\n')
await local(repo, { action: 'stage', paths: ['main.txt'] })
const midResolved = await statusOf2(repo)
check('a resolved-and-staged conflict drops the unmerged count to zero',
  midResolved.operation !== null && midResolved.operation.kind === 'merge' && midResolved.operation.unmerged === 0,
  JSON.stringify(midResolved.operation))
const continued = await local(repo, { action: 'continueOperation' })
check('continuing a resolved merge commits it with git commit --no-edit',
  continued.status === 200 && continued.json.succeeded === true
    && continued.json.steps[0].command.join(' ') === 'git commit --no-edit'
    && (await statusOf2(repo)).operation === null,
  JSON.stringify(continued.json.steps?.map(step => step.command)))
check('the concluded merge is a real merge commit',
  run(['rev-list', '--parents', '-n', '1', 'HEAD'], repo).toString().trim().split(' ').length === 3)
check('operations can be switched off by configuration',
  (await postOn(readOnlyRoute, actionUrl, { dir: repo, action: 'abortOperation', confirm: true })).status === 403)

// ── blame: line-by-line attribution of a committed file ────────────────────
const blame = await readJson(`/api/git-panel/blame?dir=${dirArg(repo)}&path=a.txt`)
check('blame attributes every line of a committed file',
  blame.ok === true && blame.lines.length > 0
    && blame.lines.every(line => /^[0-9a-f]{40}$/.test(line.hash) && line.short.length >= 7
      && line.author !== '' && !Number.isNaN(Date.parse(line.time)) && typeof line.text === 'string'),
  JSON.stringify(blame.lines.slice(0, 2)))
check('blame numbers the lines it returns, in order',
  blame.lines.map(line => line.line).join(',') === blame.lines.map((_unused, index) => index + 1).join(','),
  JSON.stringify(blame.lines.map(line => line.line).slice(0, 6)))
const initLine = blame.lines[0]
check('the oldest line points at the commit that wrote it',
  initLine.summary === 'init' && initLine.author === 'Smoke',
  JSON.stringify({ summary: initLine.summary, author: initLine.author }))
const porcelain = run(['blame', '--line-porcelain', 'HEAD', '--', 'a.txt'], repo).toString()
const porcelainLines = []
let porcelainHash = ''
for (const raw of porcelain.split('\n')) {
  if (/^[0-9a-f]{40} /.test(raw)) porcelainHash = raw.slice(0, 40)
  else if (raw.startsWith('\t')) porcelainLines.push(`${porcelainHash}:${raw.slice(1)}`)
}
check('blame matches git blame line for line',
  blame.lines.map(line => `${line.hash}:${line.text}`).join('\n') === porcelainLines.join('\n'),
  `${String(blame.lines.length)} vs ${String(porcelainLines.length)}`)
check('blame on a file that is not committed yet is a 404',
  (await request(`/api/git-panel/blame?dir=${dirArg(repo)}&path=definitely-not-committed.txt`)).status === 404)
check('blame on an escaping path is refused',
  (await request(`/api/git-panel/blame?dir=${dirArg(repo)}&path=..%2Fsecret`)).status === 400)
const plainBlame = await readJson(`/api/git-panel/blame?dir=${dirArg(plain)}&path=a.txt`)
check('a directory that is not a repository has nothing to blame',
  plainBlame.ok === true && plainBlame.repo === null && plainBlame.lines.length === 0,
  JSON.stringify(plainBlame))
const serviceBlame = await service.blame(repo, 'a.txt')
check('the service can read blame too',
  serviceBlame.lines.length === blame.lines.length && serviceBlame.lines[0].summary === 'init')

// ── stash management: list, apply, pop, drop ────────────────────────────────
// The write-action tests above already left one stash behind, so every count
// here is relative to that baseline.
const baselineStashes = (await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)).stashes
check('the stash list reports what the earlier stash action created',
  baselineStashes.length === 1 && baselineStashes[0].ref === 'stash@{0}'
    && baselineStashes[0].subject.includes('dsh-git-panel: '),
  JSON.stringify(baselineStashes))
check('a stash entry carries its ids and when it was made',
  /^[0-9a-f]{40}$/.test(baselineStashes[0].hash) && /^[0-9a-f]{7,}$/.test(baselineStashes[0].short)
    && !Number.isNaN(Date.parse(baselineStashes[0].date)),
  JSON.stringify(baselineStashes[0]))

writeFileSync(join(repo, 'stash-a.txt'), 'first\n')
const stashA = await local(repo, { action: 'stash', confirm: true, includeUntracked: true, message: 'panel stash A' })
check('a stash can carry a custom message',
  stashA.status === 200 && stashA.json.succeeded === true && !existsSync(join(repo, 'stash-a.txt')),
  `${stashA.status}`)
writeFileSync(join(repo, 'stash-b.txt'), 'second\n')
await local(repo, { action: 'stash', confirm: true, includeUntracked: true, message: 'panel stash B' })
const listedStashes = await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)
check('the stash list is newest first, custom messages included',
  listedStashes.stashes.length === 3
    && listedStashes.stashes[0].subject.includes('panel stash B')
    && listedStashes.stashes[1].subject.includes('panel stash A'),
  JSON.stringify(listedStashes.stashes.map(entry => entry.subject)))

const appliedA = await local(repo, { action: 'stashApply', ref: 'stash@{1}' })
check('applying a stash brings its files back and keeps the entry',
  appliedA.status === 200 && appliedA.json.succeeded === true
    && readFileSync(join(repo, 'stash-a.txt'), 'utf8') === 'first\n'
    && (await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)).stashes.length === 3,
  `${appliedA.status} ${JSON.stringify(appliedA.json.stderr)}`)
// A's untracked file is back on disk, so applying A again must fail — and the
// failure has to be reported as a failure, not swallowed.
const trampledApply = await local(repo, { action: 'stashApply', ref: 'stash@{1}' })
check('an apply that would trample local files fails honestly',
  trampledApply.status === 200 && trampledApply.json.succeeded === false
    && (await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)).stashes.length === 3,
  `${trampledApply.status} succeeded=${JSON.stringify(trampledApply.json.succeeded)}`)

const poppedB = await local(repo, { action: 'stashPop', ref: 'stash@{0}' })
check('popping a stash applies it and removes the entry',
  poppedB.status === 200 && poppedB.json.succeeded === true
    && readFileSync(join(repo, 'stash-b.txt'), 'utf8') === 'second\n'
    && (await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)).stashes.length === 2,
  `${poppedB.status} ${JSON.stringify(poppedB.json.stderr)}`)

const unconfirmedDrop = await local(repo, { action: 'stashDrop', ref: 'stash@{0}' })
check('dropping a stash without confirmation is refused', unconfirmedDrop.status === 428, `${unconfirmedDrop.status}`)
const droppedA = await local(repo, { action: 'stashDrop', ref: 'stash@{0}', confirm: true })
check('dropping a stash removes exactly that entry',
  droppedA.status === 200 && droppedA.json.succeeded === true
    && (await readJson(`/api/git-panel/stashes?dir=${dirArg(repo)}`)).stashes.length === 1,
  `${droppedA.status}`)

check('a revision is not a stash ref',
  (await local(repo, { action: 'stashApply', ref: 'HEAD' })).status === 400)
check('a stash action without a ref is refused',
  (await local(repo, { action: 'stashPop' })).status === 400)
check('a stash action can be switched off by configuration',
  (await postOn(readOnlyRoute, actionUrl, { dir: repo, action: 'stashApply', ref: 'stash@{0}' })).status === 403)
check('a pop against a missing entry is reported as failed, not as success',
  (await local(repo, { action: 'stashPop', ref: 'stash@{9}' })).json?.succeeded === false)

const serviceStashes = await service.stashes(repo)
check('the service can read the stash list too',
  serviceStashes.stashes.length === 1, JSON.stringify(serviceStashes.stashes.length))
const plainStashes = await readJson(`/api/git-panel/stashes?dir=${dirArg(plain)}`)
check('a directory that is not a repository has no stashes',
  plainStashes.ok === true && plainStashes.repo === null && plainStashes.stashes.length === 0,
  JSON.stringify(plainStashes))

// ── range reads: what changed between two commits ───────────────────────────
const rangeNew = run(['rev-parse', 'HEAD'], repo).toString().trim()
const rangeOld = run(['rev-parse', 'HEAD~2'], repo).toString().trim()
const rangeShow = await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${rangeNew}&base=${rangeOld}`)
// `-z` prints STATUS\0PATH\0 pairs (renames add a second path), so the file
// names are the pieces that are not status tokens.
const rangeGitFiles = run(['diff', '--name-status', '-z', '--find-renames', rangeOld, rangeNew], repo).toString()
  .split('\0').filter(piece => piece !== '' && !/^[AMDCRT]\d*$/.test(piece))
check('a range read lists exactly the files git says changed between the two',
  rangeShow.ok === true && rangeShow.base === rangeOld
    && rangeShow.files.length === rangeGitFiles.length
    && rangeShow.files.every(file => rangeGitFiles.includes(file.path)),
  JSON.stringify({ route: rangeShow.files.map(file => file.path), git: rangeGitFiles }))
check('a range read still describes the newer commit itself',
  rangeShow.commit !== null && rangeShow.commit.hash === rangeNew,
  JSON.stringify(rangeShow.commit?.short))
const rangePath = rangeShow.files[0]?.path ?? ''
const rangeDiff = await readJson(`/api/git-panel/diff?dir=${dirArg(repo)}&hash=${rangeNew}&base=${rangeOld}&path=${encodeURIComponent(rangePath)}`)
check('a range diff is the two-tree patch for that file',
  rangeDiff.ok === true && rangeDiff.kind === 'text'
    && rangeDiff.text === run(['diff', '--no-color', '-U3', '--find-renames', rangeOld, rangeNew, '--', rangePath], repo).toString(),
  JSON.stringify(rangeDiff.text?.slice(0, 60)))
check('a malformed base is refused',
  (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${rangeNew}&base=nothex`)).status === 400)
check('base and parent together are refused',
  (await request(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${rangeNew}&base=${rangeOld}&parent=1`)).status === 400)
check('a range of a commit against itself is an empty file list, not an error',
  (await readJson(`/api/git-panel/show?dir=${dirArg(repo)}&hash=${rangeNew}&base=${rangeNew}`)).files.length === 0)

// ── branch checkout: switch, create, and the guards ─────────────────────────
// The fixture tree is clean here, so switching is git's decision, not ours.
const headBefore = run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim()
check('switching branches without confirmation is refused',
  (await local(repo, { action: 'checkout', ref: 'smoke-side' })).status === 428)
check('a branch name that is not a name is refused',
  (await local(repo, { action: 'checkout', ref: '-x', confirm: true })).status === 400)
check('checkout without a branch name is refused',
  (await local(repo, { action: 'checkout', confirm: true })).status === 400)

const switched = await local(repo, { action: 'checkout', ref: 'smoke-side', confirm: true })
check('switching to another branch moves HEAD for real',
  switched.status === 200 && switched.json.succeeded === true
    && switched.json.steps[0].command.join(' ') === 'git checkout smoke-side'
    && run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim() === 'smoke-side',
  `${switched.status} ${JSON.stringify(switched.json.stderr)}`)
check('the status route reports the new branch after a switch',
  (await statusOf2(repo)).repo.branch === 'smoke-side')

// A dirty file blocks the switch only when the two branches disagree about
// it; main.txt exists on the target branch but not here, so an untracked copy
// of it would be overwritten and git names it.
writeFileSync(join(repo, 'main.txt'), 'local edit\n')
const blockedSwitch = await local(repo, { action: 'checkout', ref: repoBranch, confirm: true })
check('a switch that would trample a local change is refused by git, verbatim',
  blockedSwitch.status === 200 && blockedSwitch.json.succeeded === false
    && blockedSwitch.json.steps[0].stderr.includes('main.txt')
    && run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim() === 'smoke-side',
  JSON.stringify(blockedSwitch.json.steps?.[0]?.stderr?.slice(0, 120)))
rmSync(join(repo, 'main.txt'))
const backHome = await local(repo, { action: 'checkout', ref: repoBranch, confirm: true })
check('clearing the collision lets the same switch through',
  backHome.status === 200 && backHome.json.succeeded === true
    && run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim() === repoBranch,
  JSON.stringify(backHome.json.stderr))

const created = await local(repo, { action: 'checkout', ref: 'smoke-created', confirm: true, create: true })
check('creating a branch switches straight onto it',
  created.status === 200 && created.json.succeeded === true
    && created.json.steps[0].command.join(' ') === 'git checkout -b smoke-created'
    && run(['rev-parse', '--abbrev-ref', 'HEAD'], repo).toString().trim() === 'smoke-created'
    && run(['rev-parse', '--verify', 'refs/heads/smoke-created'], repo).toString().trim() !== '',
  JSON.stringify(created.json.steps?.map(step => step.command)))
check('creating a branch that already exists fails honestly',
  (await local(repo, { action: 'checkout', ref: 'smoke-created', confirm: true, create: true })).json?.succeeded === false)
await local(repo, { action: 'checkout', ref: repoBranch, confirm: true })
check('checkout can be switched off by configuration',
  (await postOn(readOnlyRoute, actionUrl, { dir: repo, action: 'checkout', ref: 'smoke-side', confirm: true })).status === 403)

rmSync(root, { recursive: true, force: true })
process.stdout.write(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
