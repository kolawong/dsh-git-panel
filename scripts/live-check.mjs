/**
 * Live M2 verification against the running harness.
 *
 * Every action runs inside a throwaway sandbox created under a *non-repository*
 * registered workspace, with its own bare remote — so the run touches no real
 * project, no real remote, and leaves nothing behind (the sandbox is removed in
 * a `finally`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ORIGIN = 'http://127.0.0.1:3080'

/** Basic credentials for the CLI path; read at runtime and never printed. */
const authorization = (() => {
  const text = readFileSync('/root/.dsh/profiles/web/cordis.patch.yml', 'utf8')
  const unquote = value => value.replace(/^['"]|['"]$/g, '')
  const user = /^\s*username:\s*(.+?)\s*$/m.exec(text)[1]
  const password = /^\s*password:\s*(.+?)\s*$/m.exec(text)[1]
  return `Basic ${Buffer.from(`${unquote(user)}:${unquote(password)}`).toString('base64')}`
})()

const failures = []
function check(name, condition, detail) {
  process.stdout.write(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!condition) failures.push(name)
}

async function read(path) {
  const response = await fetch(`${ORIGIN}${path}`, { headers: { authorization } })
  return { status: response.status, json: await response.json().catch(() => null) }
}

async function act(body, headers = { 'content-type': 'application/json', 'x-dsh-git-panel': '1' }) {
  const response = await fetch(`${ORIGIN}/api/git-panel/action`, {
    method: 'POST',
    headers: { authorization, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

/** One AI commit-message draft, over the real transport. */
async function draft(body, headers = { 'content-type': 'application/json', 'x-dsh-git-panel': '1' }) {
  const response = await fetch(`${ORIGIN}/api/git-panel/commit-message`, {
    method: 'POST',
    headers: { authorization, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

/**
 * Open the host's event stream and read frames off it incrementally.
 * @param dir - the repository to watch.
 * @returns the response, a pump that waits for text, and a closer.
 */
async function openStream(dir) {
  const controller = new AbortController()
  const response = await fetch(`${ORIGIN}/api/git-panel/events?dir=${encodeURIComponent(dir)}`, {
    headers: { authorization, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = async (untilMs, needle) => {
    const deadline = Date.now() + untilMs
    while (Date.now() < deadline && !buffer.includes(needle)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => { setTimeout(() => { resolve(null) }, Math.max(1, deadline - Date.now())) }),
      ])
      if (chunk === null || chunk.done === true) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    return buffer
  }
  return { response, pump, close: () => { controller.abort() } }
}

const overview = await read('/api/git-panel/overview')
const hostWorkspace = (overview.json?.entries ?? []).find(entry => entry.reason === 'not-a-repository')
if (hostWorkspace === undefined) {
  process.stdout.write('no non-repository workspace to host the sandbox\n')
  process.exit(1)
}
const sandbox = join(hostWorkspace.workspace.path, `.dsh-git-panel-live-${String(process.pid)}`)
process.stdout.write(`sandbox: ${sandbox}\n  (inside the non-repository workspace "${hostWorkspace.workspace.title}")\n`)

const remote = join(sandbox, 'remote.git')
const seed = join(sandbox, 'seed')
const clone = join(sandbox, 'clone')
const status = async () => (await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)).json

try {
  mkdirSync(sandbox, { recursive: true })
  for (const dir of [remote, seed]) mkdirSync(dir)
  run(['init', '-q', '--bare', '--initial-branch=main'], remote)
  run(['init', '-q', '--initial-branch=main'], seed)
  run(['config', 'user.email', 'live@example.com'], seed)
  run(['config', 'user.name', 'Live'], seed)
  writeFileSync(join(seed, 'f.txt'), 'seed\n')
  run(['add', 'f.txt'], seed)
  run(['commit', '-q', '-m', 'seed'], seed)
  run(['remote', 'add', 'origin', remote], seed)
  run(['push', '-q', '-u', 'origin', 'main'], seed)
  run(['clone', '-q', remote, clone], sandbox)
  run(['config', 'user.email', 'live@example.com'], clone)
  run(['config', 'user.name', 'Live'], clone)
  // Move the remote on, so the clone is genuinely behind one commit.
  writeFileSync(join(seed, 'g.txt'), 'remote move\n')
  run(['add', 'g.txt'], seed)
  run(['commit', '-q', '-m', 'remote move'], seed)
  run(['push', '-q', 'origin', 'main'], seed)

  const first = await status()
  check('the sandbox repository is addressable', first?.repo?.upstream === 'origin/main', JSON.stringify(first?.repo))
  // A fresh clone's remote-tracking ref is stale, so it reads as level until
  // something fetches — exactly the state the panel's Fetch button exists for.
  check('it reads level while its remote ref is stale', first?.repo?.ahead === 0 && first?.repo?.behind === 0, JSON.stringify(first?.repo))

  const fetched = await act({ dir: clone, action: 'fetch' })
  check('live fetch succeeds', fetched.status === 200 && fetched.json.succeeded === true, `${fetched.status} ${JSON.stringify(fetched.json).slice(0, 160)}`)
  check('after the fetch the clone is one commit behind', (await status())?.repo?.behind === 1, JSON.stringify((await status())?.repo))

  const pulled = await act({ dir: clone, action: 'pull' })
  check('live pull --ff-only succeeds', pulled.status === 200 && pulled.json.succeeded === true && pulled.json.command.join(' ') === 'git pull --ff-only', `${pulled.status} ${JSON.stringify(pulled.json).slice(0, 160)}`)
  check('the live pull refreshed with a fetch first', pulled.json.steps?.length === 2 && pulled.json.steps[0].command.join(' ') === 'git fetch --prune' && pulled.json.steps[0].succeeded === true, JSON.stringify(pulled.json.steps?.map(step => step.command)))
  check('the live clone is level after the pull', (await status())?.repo?.behind === 0)

  const unconfirmed = await act({ dir: clone, action: 'push' })
  check('live push without confirmation is refused', unconfirmed.status === 428, `${unconfirmed.status} ${JSON.stringify(unconfirmed.json)}`)

  writeFileSync(join(clone, 'h.txt'), 'local\n')
  run(['add', 'h.txt'], clone)
  run(['commit', '-q', '-m', 'local'], clone)
  check('the live clone is ahead by one before its push', (await status())?.repo?.ahead === 1)
  const pushed = await act({ dir: clone, action: 'push', confirm: true })
  check('live push succeeds and reports git\'s own output', pushed.status === 200 && pushed.json.succeeded === true, `${pushed.status} ${JSON.stringify(pushed.json).slice(0, 200)}`)
  check('the live clone is level after the push', (await status())?.repo?.ahead === 0)
  check('the pushed commit really landed on the remote', run(['rev-list', '--count', 'main'], remote).trim() === '3', run(['rev-list', '--count', 'main'], remote))

  // ── history, over the real transport ──────────────────────────────────────
  const commitLog = await read(`/api/git-panel/log?dir=${encodeURIComponent(clone)}&limit=5`)
  check('live log lists the clone history newest first',
    commitLog.status === 200 && commitLog.json.commits.length >= 2 && /^[0-9a-f]{40}$/.test(commitLog.json.commits[0].hash),
    JSON.stringify(commitLog.json.commits?.map(commit => commit.subject)))
  check('live log entries carry author, date and refs',
    commitLog.json.commits[0].author !== '' && !Number.isNaN(Date.parse(commitLog.json.commits[0].date))
      && Array.isArray(commitLog.json.commits[0].refs) && commitLog.json.commits[0].refs.some(ref => /^HEAD -> /.test(ref)),
    JSON.stringify(commitLog.json.commits[0]))
  check('live log refuses an absurd limit',
    (await read(`/api/git-panel/log?dir=${encodeURIComponent(clone)}&limit=0`)).status === 400)
  const headCommit = run(['rev-parse', 'HEAD'], clone).trim()
  const shownCommit = await read(`/api/git-panel/show?dir=${encodeURIComponent(clone)}&hash=${headCommit}`)
  check('live show describes a commit and its files',
    shownCommit.status === 200 && shownCommit.json.commit.hash === headCommit
      && shownCommit.json.files.length >= 1 && shownCommit.json.files.every(file => typeof file.status === 'string'),
    `${shownCommit.status} ${JSON.stringify(shownCommit.json.files)}`)
  check('live show turns a bad hash away',
    (await read(`/api/git-panel/show?dir=${encodeURIComponent(clone)}&hash=nope`)).status === 400)
  const commitFile = shownCommit.json.files[0].path
  const commitDiff = await read(`/api/git-panel/diff?dir=${encodeURIComponent(clone)}&path=${encodeURIComponent(commitFile)}&hash=${headCommit}`)
  check('live diff reads a file from a commit, with no commit header',
    commitDiff.status === 200 && commitDiff.json.kind === 'text' && commitDiff.json.text.includes('@@')
      && !/^commit /m.test(commitDiff.json.text),
    `${commitDiff.status} ${JSON.stringify(commitDiff.json.text?.slice(0, 80))}`)
  const commitContext = await read(`/api/git-panel/context?dir=${encodeURIComponent(clone)}&path=${encodeURIComponent(commitFile)}&hash=${headCommit}&start=1&count=3`)
  check('live context inside a commit reads that commit',
    commitContext.status === 200 && Array.isArray(commitContext.json.lines),
    `${commitContext.status} ${JSON.stringify(commitContext.json)}`)

  // ── local write actions, over the real transport, in a clone we own ────────
  // Every one of these changes the checkout, so they run only against the
  // disposable clone inside a workspace that is not itself a repository.
  writeFileSync(join(clone, 'f.txt'), 'seed\nlocal edit\n')
  const stagedLive = await act({ dir: clone, action: 'stage', paths: ['f.txt'] })
  check('live stage moves a file into the index',
    stagedLive.status === 200 && stagedLive.json.succeeded === true
      && stagedLive.json.steps[0].command.join(' ') === 'git add -- f.txt',
    `${stagedLive.status} ${JSON.stringify(stagedLive.json.steps?.map(step => step.command))}`)
  const stagedStatus = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  check('live status agrees that the file is staged',
    stagedStatus.json.counts.staged === 1 && stagedStatus.json.counts.changed === 0, JSON.stringify(stagedStatus.json.counts))

  const unstageLive = await act({ dir: clone, action: 'unstage', paths: ['f.txt'] })
  check('live unstage puts it back in the work tree',
    unstageLive.status === 200 && unstageLive.json.succeeded === true, `${unstageLive.status}`)
  const unstageStatus = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  check('live status agrees that it is a work tree change again',
    unstageStatus.json.counts.staged === 0 && unstageStatus.json.counts.changed === 1, JSON.stringify(unstageStatus.json.counts))

  const noConfirm = await act({ dir: clone, action: 'discard', paths: ['f.txt'] })
  check('live discard demands confirmation', noConfirm.status === 428, `${noConfirm.status}`)
  const discardLive = await act({ dir: clone, action: 'discard', paths: ['f.txt'], confirm: true })
  check('live discard restores the file from the index',
    discardLive.status === 200 && discardLive.json.succeeded === true && readFileSync(join(clone, 'f.txt'), 'utf8') === 'seed\n',
    `${discardLive.status} ${JSON.stringify(readFileSync(join(clone, 'f.txt'), 'utf8'))}`)

  const commitsBefore = Number(run(['rev-list', '--count', 'HEAD'], clone).trim())
  writeFileSync(join(clone, 'f.txt'), 'local\ncommitted from the panel\n')
  const commitLive = await act({ dir: clone, action: 'commit', message: 'live: committed from the panel', paths: ['f.txt'] })
  check('live commit stages then commits',
    commitLive.status === 200 && commitLive.json.succeeded === true && commitLive.json.steps.length === 2,
    `${commitLive.status} ${JSON.stringify(commitLive.json.steps?.map(step => step.command))}`)
  check('live commit really moved HEAD',
    Number(run(['rev-list', '--count', 'HEAD'], clone).trim()) === commitsBefore + 1
      && run(['log', '-1', '--format=%s'], clone).trim() === 'live: committed from the panel')
  const emptyCommit = await act({ dir: clone, action: 'commit', message: '' })
  check('live commit refuses an empty message', emptyCommit.status === 400, `${emptyCommit.status}`)

  writeFileSync(join(clone, 'j.txt'), 'to be stashed\n')
  const stashLive = await act({ dir: clone, action: 'stash', confirm: true, includeUntracked: true })
  check('live stash cleans the work tree',
    stashLive.status === 200 && stashLive.json.succeeded === true
      && run(['stash', 'list'], clone).trim().split('\n').filter(Boolean).length >= 1,
    `${stashLive.status} ${JSON.stringify(stashLive.json.steps?.map(step => step.command))}`)
  const cleanStatus = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  check('live status is clean after the stash',
    cleanStatus.json.counts.changed === 0 && cleanStatus.json.counts.untracked === 0 && cleanStatus.json.counts.staged === 0,
    JSON.stringify(cleanStatus.json.counts))

  // ── reading the lines a gap hides, over the real transport ────────────────
  // The write block above committed f.txt, so the work tree now holds exactly
  // what this reads back — which is the point: context reads the file, not HEAD.
  const worktreeContext = await read(`/api/git-panel/context?dir=${encodeURIComponent(clone)}&path=f.txt&staged=0&start=1&count=5`)
  check('live context reads the work tree for an unstaged diff',
    worktreeContext.status === 200 && worktreeContext.json.lines.join(',') === 'local,committed from the panel',
    `${worktreeContext.status} ${JSON.stringify(worktreeContext.json)}`)
  const indexContext = await read(`/api/git-panel/context?dir=${encodeURIComponent(clone)}&path=h.txt&staged=1&start=1&count=5`)
  check('live context reads the index blob for a staged diff',
    indexContext.status === 200 && indexContext.json.lines.join(',') === 'local', `${indexContext.status} ${JSON.stringify(indexContext.json)}`)
  const badContext = await read(`/api/git-panel/context?dir=${encodeURIComponent(clone)}&path=f.txt&staged=0&start=0&count=5`)
  check('live context refuses a non-positive start', badContext.status === 400, `${badContext.status}`)

  // ── the live event stream, over the real authenticated transport ──────────
  const stream = await openStream(clone)
  check('the live event stream opens as text/event-stream', /text\/event-stream/.test(stream.response.headers.get('content-type') ?? ''), String(stream.response.headers.get('content-type')))
  const greeting = await stream.pump(4_000, 'event: hello')
  check('the live stream greets with a hello frame', greeting.includes('event: hello'), greeting.slice(0, 200))
  check('the live stream confirms the sandbox is watched', greeting.includes('"watching"') && greeting.includes('true'), greeting.slice(0, 300))

  // A real commit is what the panel must hear about without waiting for a poll.
  writeFileSync(join(clone, 'i.txt'), 'live\n')
  run(['add', 'i.txt'], clone)
  run(['commit', '-q', '-m', 'live watch'], clone)
  const heard = await stream.pump(5_000, 'event: change')
  check('a real commit reaches the live stream unprompted', heard.includes('event: change'), heard.slice(-200))
  check('the change frame names the index or a ref that moved', /"files":\[[^\]]*(index|refs\/)/.test(heard), heard.slice(-400))
  stream.close()

  // ── the AI commit-message draft, against the real model this profile runs ──
  // One real call: the point is the round trip, not the wording.
  writeFileSync(join(clone, 'j.txt'), 'draft me\n')
  writeFileSync(join(clone, 'k.txt'), 'also draft me\n')
  run(['add', 'j.txt'], clone)
  const beforeDraft = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  /** What `git commit` would record, as the status route reports it. */
  const stagedEntries = beforeDraft.json.files.filter(file => !file.untracked && file.index !== '.').length
  const startedAt = Date.now()
  const draftResponse = await draft({ dir: clone })
  const draftMs = Date.now() - startedAt
  check('a live draft answers 200 from the mounted model',
    draftResponse.status === 200 && draftResponse.json?.ok === true,
    `${draftResponse.status} ${JSON.stringify(draftResponse.json).slice(0, 200)}`)
  const drafted = draftResponse.json ?? {}
  check('the live draft reads exactly the staged changes, not the work tree',
    drafted.source === 'staged' && drafted.files === stagedEntries && drafted.untracked === 1,
    JSON.stringify({ source: drafted.source, files: drafted.files, stagedEntries, untracked: drafted.untracked }))
  check('the live draft names the model that answered',
    typeof drafted.provider === 'string' && drafted.provider !== '' && typeof drafted.model === 'string' && drafted.model !== '',
    `${drafted.provider}/${drafted.model}`)
  check('the live draft is a non-empty Chinese commit message',
    typeof drafted.message === 'string' && drafted.message.trim() !== '' && /[\u4e00-\u9fff]/.test(drafted.message) && drafted.message.length < 4_000,
    JSON.stringify(String(drafted.message).slice(0, 200)))
  check('the live draft is a subject a commit would accept',
    typeof drafted.message === 'string' && /^[a-z]+: \S/.test(drafted.message.split('\n')[0])
      || /^\S/.test(drafted.message.split('\n')[0] ?? ''),
    JSON.stringify(String(drafted.message).split('\n')[0]))
  // Providers are not required to stream usage; the draft has to say whether
  // the number is a measurement or a placeholder.
  check('the live draft says whether the model reported its token usage',
    typeof drafted.usageReported === 'boolean'
      && (drafted.usageReported ? drafted.inputTokens > 0 : drafted.inputTokens === 0),
    JSON.stringify({ usageReported: drafted.usageReported, inputTokens: drafted.inputTokens }))
  check('the live draft took a bounded amount of time', draftMs < 60_000, `${draftMs}ms`)
  // The user decides what happens next: a draft must not have written anything.
  const afterDraft = await read(`/api/git-panel/log?dir=${encodeURIComponent(clone)}&limit=1`)
  check('a draft commits nothing on its own',
    afterDraft.json.commits[0].subject === 'live watch', JSON.stringify(afterDraft.json.commits[0].subject))
  const draftStatus = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  check('a draft leaves the index alone',
    draftStatus.json.counts.staged === beforeDraft.json.counts.staged
      && draftStatus.json.counts.untracked === beforeDraft.json.counts.untracked,
    `${JSON.stringify(beforeDraft.json.counts)} → ${JSON.stringify(draftStatus.json.counts)}`)

  // The picker's list, from the real providers this profile has mounted.
  const models = await read('/api/git-panel/models')
  check('the live model catalog lists the mounted providers',
    models.status === 200 && Array.isArray(models.json.providers) && models.json.providers.length > 0,
    `${models.status} ${JSON.stringify(models.json).slice(0, 160)}`)
  check('the live catalog names the model a draft would use',
    typeof models.json.default?.provider === 'string' && typeof models.json.default?.model === 'string'
      && typeof models.json.providers[0].providerName === 'string',
    JSON.stringify(models.json.default))
  /** The first provider that actually advertises a model. */
  const richest = (models.json.providers ?? []).find(group => group.models.length > 0)
  check('at least one provider advertises models to pick from', richest !== undefined, JSON.stringify(models.json.providers.map(group => `${group.provider}:${String(group.models.length)}`)))
  // Picking a route explicitly must reach that route: one more real call, on a
  // *different* model than the default when the profile offers one.
  const alternative = (richest?.models ?? []).find(model => model.id !== models.json.default?.model) ?? richest?.models?.[0]
  if (richest !== undefined && alternative !== undefined) {
    const picked = await draft({ dir: clone, provider: richest.provider, model: alternative.id })
    check('a live draft runs on the picked provider and model',
      picked.status === 200 && picked.json.provider === richest.provider && picked.json.model === alternative.id,
      `${picked.status} ${picked.json.provider}/${picked.json.model}`)
    check('a live draft from a picked model is still a Chinese commit message',
      /[\u4e00-\u9fff]/.test(String(picked.json.message)) && picked.json.message.length < 4_000,
      JSON.stringify(String(picked.json.message).slice(0, 120)))
    const badRoute = await draft({ dir: clone, provider: richest.provider, model: 'no-such-model-xyz' })
    check('an unknown model is a readable failure, not a crash',
      badRoute.status === 502 && typeof badRoute.json.error === 'string' && badRoute.json.error !== '',
      `${badRoute.status} ${JSON.stringify(badRoute.json).slice(0, 160)}`)
  }

  // What the panel's one-step button sends: stage everything, then commit the
  // drafted message. Run here against a disposable clone, never a real repo.
  const beforeOneStep = Number(run(['rev-list', '--count', 'HEAD'], clone).toString().trim())
  const oneStep = await act({ dir: clone, action: 'commit', message: drafted.message, paths: ['.'] })
  check('the one-step commit request stages everything and commits',
    oneStep.status === 200 && oneStep.json.succeeded === true
      && oneStep.json.steps.some(step => step.command.join(' ') === 'git add -- .')
      && oneStep.json.steps.some(step => step.command[1] === 'commit'),
    `${oneStep.status} ${JSON.stringify(oneStep.json.steps?.map(step => step.command))}`)
  check('one click really lands a commit with the drafted subject',
    Number(run(['rev-list', '--count', 'HEAD'], clone).toString().trim()) === beforeOneStep + 1
      && run(['log', '-1', '--format=%s'], clone).toString().trim().split('\n')[0] === drafted.message.split('\n')[0],
    JSON.stringify(run(['log', '-1', '--format=%s'], clone).toString().trim().slice(0, 80)))
  check('the one-step commit leaves nothing uncommitted behind',
    run(['status', '--porcelain'], clone).toString().trim() === '',
    JSON.stringify(run(['status', '--porcelain'], clone).toString().trim().slice(0, 120)))
  // Nothing was pushed: the user still decides that.
  check('the one-step commit pushes nothing',
    run(['rev-list', '--count', 'origin/main'], clone).toString().trim() !== run(['rev-list', '--count', 'HEAD'], clone).toString().trim(),
    'origin/main moved without a push')

  // ── history: paging, filters and the branch list, over the real transport ──
  const logPage1 = await read(`/api/git-panel/log?dir=${encodeURIComponent(clone)}&limit=1`)
  const logPage2 = await read(`/api/git-panel/log?dir=${encodeURIComponent(clone)}&limit=1&skip=1`)
  check('the live history pages without repeating itself',
    logPage1.status === 200 && logPage2.status === 200
      && logPage1.json.commits.length === 1 && logPage2.json.commits.length === 1
      && logPage1.json.commits[0].hash !== logPage2.json.commits[0].hash
      && logPage2.json.skip === 1,
    JSON.stringify([logPage1.json.commits?.[0]?.short, logPage2.json.commits?.[0]?.short]))
  check('a live commit carries its parent for the graph',
    logPage1.json.commits[0].parents.length === 1 && /^[0-9a-f]{7,}$/.test(logPage1.json.commits[0].parents[0]),
    JSON.stringify(logPage1.json.commits[0].parents))
  const pageForGraph = await read('/api/git-panel/log?dir=' + encodeURIComponent('/root/deepseek-harness') + '&limit=100')
  if (pageForGraph.status === 200 && (pageForGraph.json.commits ?? []).length > 0) {
    const shorts = new Set(pageForGraph.json.commits.map(commit => commit.short))
    const strays = pageForGraph.json.commits.flatMap(commit => commit.parents).filter(parent => !shorts.has(parent))
    check('in a real 100-commit page every parent is written like the commits beside it',
      strays.every(parent => pageForGraph.json.commits.every(commit => commit.hash !== parent)),
      JSON.stringify(strays.slice(0, 3)))
    const merges = pageForGraph.json.commits.filter(commit => commit.parents.length > 1).length
    // A merge: the panel has to ask for a parent, because git prints no diff of
    // its own for a merge.
    const mergeCommits = pageForGraph.json.commits.filter(commit => commit.parents.length > 1).slice(0, 5)
    let mergeWithFiles = 0
    for (const merge of mergeCommits) {
      const mergeShow = await read(`/api/git-panel/show?dir=${encodeURIComponent('/root/deepseek-harness')}&hash=${merge.hash}&parent=1`)
      if (mergeShow.status !== 200 || mergeShow.json.parent !== 1 || !Array.isArray(mergeShow.json.files)) {
        check('a real merge reads against a named parent', false, `${String(mergeShow.status)} ${JSON.stringify(mergeShow.json)?.slice(0, 120)}`)
        break
      }
      if (mergeShow.json.files.length > 0) {
        if (mergeWithFiles === 0) {
          const first = mergeShow.json.files[0]
          const mergeDiff = await read(`/api/git-panel/diff?dir=${encodeURIComponent('/root/deepseek-harness')}&hash=${merge.hash}&parent=1&path=${encodeURIComponent(first.path)}`)
          check('a real merge diff against a parent is a patch with hunks',
            mergeDiff.status === 200 && mergeDiff.json.kind === 'text' && mergeDiff.json.text.includes('@@'),
            `${String(mergeDiff.status)} ${JSON.stringify(mergeDiff.json.kind)}`)
        }
        mergeWithFiles += 1
      }
    }
    check('a real merge shows what it brought in, read against its first parent',
      merges.length === 0 || mergeWithFiles > 0, `merges=${String(merges.length)} withFiles=${String(mergeWithFiles)}`)
    check('a real parent out of range is refused',
      (await read(`/api/git-panel/show?dir=${encodeURIComponent('/root/deepseek-harness')}&hash=${mergeCommits[0]?.hash ?? 'HEAD'}&parent=0`)).status === 400)

    check('a real page of a branching repository reports its merges with both parents',
      merges > 0 && pageForGraph.json.commits.every(commit => commit.parents.length <= 8),
      `merges=${String(merges)}`)
  }
  // The real repositories of this profile are read-only here: history reads
  // never write, so this is safe on the user's own checkouts.
  const realRepo = (await read('/api/git-panel/status?dir=' + encodeURIComponent('/root/dsh-plugin-quota-badges'))).json
  if (realRepo?.repo != null) {
    const realPath = realRepo.repo.root
    const realLog = await read(`/api/git-panel/log?dir=${encodeURIComponent(realPath)}&limit=5&path=README.md`)
    const expected = run(['log', '--format=%H', '--max-count=5', '--', 'README.md'], realPath).trim().split('\n').filter(line => line !== '')
    check('a live path filter agrees with git log for that path',
      realLog.status === 200 && realLog.json.commits.map(commit => commit.hash).join(',') === expected.join(','),
      JSON.stringify({ route: realLog.json.commits?.length, git: expected.length }))
    const realAuthor = run(['log', '--format=%an', '--max-count=1'], realPath).trim()
    const authored = await read(`/api/git-panel/log?dir=${encodeURIComponent(realPath)}&limit=5&author=${encodeURIComponent(realAuthor)}`)
    check('a live author filter returns only that author',
      authored.status === 200 && authored.json.commits.length > 0
        && authored.json.commits.every(commit => commit.author === realAuthor),
      `${authored.status} ${JSON.stringify(authored.json.commits?.map(commit => commit.author))}`)
    const realBranches = await read(`/api/git-panel/branches?dir=${encodeURIComponent(realPath)}`)
    const gitBranches = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], realPath).trim().split('\n').filter(line => line !== '')
    const gitHead = run(['symbolic-ref', '--short', '-q', 'HEAD'], realPath).trim()
    // `-q` still prints nothing on success, so the exit code decides; compare
    // against git rev-parse instead.
    const headName = run(['rev-parse', '--abbrev-ref', 'HEAD'], realPath).trim()
    check('the live branch list names every local branch',
      realBranches.status === 200
        && gitBranches.every(name => realBranches.json.branches.some(branch => branch.name === name))
        && realBranches.json.branches.length === gitBranches.length,
      JSON.stringify({ route: realBranches.json.branches?.map(branch => branch.name), git: gitBranches }))
    check('the live branch list marks the checked-out branch',
      realBranches.json.current === (headName === 'HEAD' ? null : headName)
        && realBranches.json.branches.filter(branch => branch.current).length === (headName === 'HEAD' ? 0 : 1),
      JSON.stringify({ current: realBranches.json.current, head: headName, gitHead }))
    const track = run(['for-each-ref', '--format=%(upstream:track)', `refs/heads/${headName}`], realPath).trim()
    const upstream = run(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${headName}`], realPath).trim()
    const markedBranch = realBranches.json.branches.find(branch => branch.current)
    check('a live branch reports the same upstream and track as git',
      markedBranch !== undefined && markedBranch.upstream === (upstream === '' ? null : upstream)
        && markedBranch.track === (track === '' ? null : track),
      JSON.stringify({ route: { upstream: markedBranch?.upstream, track: markedBranch?.track }, git: { upstream, track } }))
    check('a live ref that does not exist is a 404',
      (await read(`/api/git-panel/log?dir=${encodeURIComponent(realPath)}&ref=no-such-branch`)).status === 404)
    check('a live ref that looks like an option is refused',
      (await read(`/api/git-panel/log?dir=${encodeURIComponent(realPath)}&ref=-x`)).status === 400)
  }

  // ── stash management over the real transport, in the sandbox clone ────────
  writeFileSync(join(clone, 'live-stash.txt'), 'stash me\n')
  const liveStash = await act({ dir: clone, action: 'stash', confirm: true, includeUntracked: true, message: 'live panel stash' })
  check('a live stash cleans the work tree',
    liveStash.status === 200 && liveStash.json.succeeded === true && !existsSync(join(clone, 'live-stash.txt')),
    `${liveStash.status}`)
  // The earlier stash test in this suite already left one entry behind, so
  // every count is relative to that baseline.
  const liveBaseline = (await read(`/api/git-panel/stashes?dir=${encodeURIComponent(clone)}`)).json.stashes.length
  const liveList = await read(`/api/git-panel/stashes?dir=${encodeURIComponent(clone)}`)
  check('the live stash list names the entry just made, newest first',
    liveList.status === 200 && liveList.json.stashes.length === liveBaseline
      && liveList.json.stashes[0].ref === 'stash@{0}'
      && liveList.json.stashes[0].subject.includes('live panel stash'),
    JSON.stringify(liveList.json.stashes.map(entry => entry.subject)))
  const liveApply = await act({ dir: clone, action: 'stashApply', ref: 'stash@{0}' })
  check('a live apply restores the file and keeps the entry',
    liveApply.status === 200 && liveApply.json.succeeded === true
      && readFileSync(join(clone, 'live-stash.txt'), 'utf8') === 'stash me\n'
      && (await read(`/api/git-panel/stashes?dir=${encodeURIComponent(clone)}`)).json.stashes.length === liveBaseline,
    `${liveApply.status} ${JSON.stringify(liveApply.json?.stderr)}`)
  rmSync(join(clone, 'live-stash.txt'))
  const liveDropUnconfirmed = await act({ dir: clone, action: 'stashDrop', ref: 'stash@{0}' })
  check('a live drop without confirmation is refused', liveDropUnconfirmed.status === 428, `${liveDropUnconfirmed.status}`)
  const liveDrop = await act({ dir: clone, action: 'stashDrop', ref: 'stash@{0}', confirm: true })
  check('a live drop removes the entry for good',
    liveDrop.status === 200 && liveDrop.json.succeeded === true
      && (await read(`/api/git-panel/stashes?dir=${encodeURIComponent(clone)}`)).json.stashes.length === liveBaseline - 1,
    `${liveDrop.status}`)
  check('a live stash action refuses a revision as its ref',
    (await act({ dir: clone, action: 'stashPop', ref: 'main' })).status === 400)

  // ── an in-progress merge over the real transport ──────────────────────────
  run(['checkout', '-q', '-b', 'live-conflict'], clone)
  writeFileSync(join(clone, 'f.txt'), 'side change\n')
  run(['commit', '-qam', 'live conflict side'], clone)
  run(['checkout', '-q', 'main'], clone)
  writeFileSync(join(clone, 'f.txt'), 'main change\n')
  run(['commit', '-qam', 'live conflict main'], clone)
  let liveConflicted = false
  try {
    run(['merge', 'live-conflict'], clone)
  } catch {
    liveConflicted = true
  }
  check('the live fixture merge really conflicts', liveConflicted === true)
  const midOperation = await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)
  check('the live status reports the merge and its unmerged file',
    midOperation.status === 200 && midOperation.json.operation?.kind === 'merge'
      && midOperation.json.operation.unmerged === 1 && midOperation.json.counts.conflicted === 1,
    JSON.stringify(midOperation.json.operation))
  const prematureContinue = await act({ dir: clone, action: 'continueOperation' })
  check('a live continue with unresolved conflicts is refused with the count',
    prematureContinue.status === 200 && prematureContinue.json.succeeded === false
      && String(prematureContinue.json.steps.at(-1).stderr).includes('1 个文件冲突'),
    JSON.stringify(prematureContinue.json.steps?.at(-1)))
  check('a live abort without confirmation is refused',
    (await act({ dir: clone, action: 'abortOperation' })).status === 428)
  const liveAborted = await act({ dir: clone, action: 'abortOperation', confirm: true })
  check('a live abort runs merge --abort and ends the operation',
    liveAborted.status === 200 && liveAborted.json.succeeded === true
      && liveAborted.json.steps[0].command.join(' ') === 'git merge --abort'
      && (await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)).json.operation === null,
    JSON.stringify(liveAborted.json.steps?.map(step => step.command)))
  // Merge again, resolve, stage, continue — the whole path a user would take.
  try {
    run(['merge', 'live-conflict'], clone)
  } catch {
    // expected: it conflicts again
  }
  writeFileSync(join(clone, 'f.txt'), 'resolved for real\n')
  await act({ dir: clone, action: 'stage', paths: ['f.txt'] })
  const liveContinued = await act({ dir: clone, action: 'continueOperation' })
  check('a live continue on a resolved merge commits it',
    liveContinued.status === 200 && liveContinued.json.succeeded === true
      && liveContinued.json.steps[0].command.join(' ') === 'git commit --no-edit'
      && (await read(`/api/git-panel/status?dir=${encodeURIComponent(clone)}`)).json.operation === null
      && run(['rev-list', '--parents', '-n', '1', 'HEAD'], clone).trim().split(' ').length === 3,
    JSON.stringify(liveContinued.json.steps?.map(step => step.command)))

  // ── branch checkout over the real transport, in the sandbox clone ─────────
  check('a live switch without confirmation is refused',
    (await act({ dir: clone, action: 'checkout', ref: 'live-conflict' })).status === 428)
  const liveCreated = await act({ dir: clone, action: 'checkout', ref: 'live-switch', confirm: true, create: true })
  check('a live create-and-switch moves HEAD onto the new branch',
    liveCreated.status === 200 && liveCreated.json.succeeded === true
      && liveCreated.json.steps[0].command.join(' ') === 'git checkout -b live-switch'
      && run(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim() === 'live-switch',
    `${liveCreated.status} ${JSON.stringify(liveCreated.json?.stderr)}`)
  check('a live create over an existing name fails honestly',
    (await act({ dir: clone, action: 'checkout', ref: 'live-switch', confirm: true, create: true })).json?.succeeded === false)
  // A collision: f.txt differs between live-switch (resolved for real) and
  // live-conflict (side change), and the local edit would be overwritten.
  writeFileSync(join(clone, 'f.txt'), 'unsaved local edit\n')
  const liveBlocked = await act({ dir: clone, action: 'checkout', ref: 'live-conflict', confirm: true })
  check('a live switch that would trample a local change is refused by git, verbatim',
    liveBlocked.status === 200 && liveBlocked.json.succeeded === false
      && String(liveBlocked.json.steps[0].stderr).includes('f.txt')
      && run(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim() === 'live-switch',
    JSON.stringify(liveBlocked.json.steps?.[0]?.stderr?.slice(0, 120)))
  run(['checkout', '-q', '--', 'f.txt'], clone)
  const liveSwitched = await act({ dir: clone, action: 'checkout', ref: 'main', confirm: true })
  check('a live switch back lands on the target branch',
    liveSwitched.status === 200 && liveSwitched.json.succeeded === true
      && run(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim() === 'main',
    `${liveSwitched.status}`)
  check('a live checkout refuses a name that is not a name',
    (await act({ dir: clone, action: 'checkout', ref: '-x', confirm: true })).status === 400)

  // ── the streaming draft over the real transport ────────────────────────────
  writeFileSync(join(clone, 'live-stream.txt'), 'stream this change\n')
  const streamResponse = await fetch(`${ORIGIN}/api/git-panel/commit-message/stream`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
    body: JSON.stringify({ dir: clone }),
  })
  check('the live streaming draft answers 200 as text/event-stream',
    streamResponse.status === 200
      && (streamResponse.headers.get('content-type') ?? '').includes('text/event-stream'),
    `${String(streamResponse.status)}`)
  const streamText = await streamResponse.text()
  const liveFrames = streamText.split('\n\n')
    .map(part => part.trim())
    .filter(part => part !== '' && part.split('\n').some(line => line.startsWith('data: ')))
    .map((part) => {
      const lines = part.split('\n')
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message',
        data: JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')),
      }
    })
  const liveEvents = liveFrames.map(frame => frame.event)
  check('the live stream is begin, some deltas, then done',
    liveEvents[0] === 'begin' && liveEvents.at(-1) === 'done' && liveEvents.includes('delta'),
    JSON.stringify(liveEvents.slice(0, 6)))
  check('the live begin frame names what the model read',
    liveFrames[0].data.source === 'all' && liveFrames[0].data.files === 1
      && liveFrames[0].data.untracked === 1,
    JSON.stringify(liveFrames[0].data))
  const liveDraft = liveFrames.at(-1).data
  check('the live done frame is a Chinese commit message from a named model',
    typeof liveDraft.message === 'string' && /[\u4e00-\u9fff]/.test(liveDraft.message)
      && typeof liveDraft.provider === 'string' && liveDraft.provider !== ''
      && typeof liveDraft.model === 'string' && liveDraft.model !== '',
    JSON.stringify({ provider: liveDraft.provider, model: liveDraft.model, message: String(liveDraft.message).slice(0, 60) }))
  check('the live stream says whether the model reported its usage',
    typeof liveDraft.usageReported === 'boolean'
      && (liveDraft.usageReported ? liveDraft.inputTokens > 0 : liveDraft.inputTokens === 0),
    JSON.stringify({ usageReported: liveDraft.usageReported, inputTokens: liveDraft.inputTokens }))
  const joined = liveFrames.filter(frame => frame.event === 'delta').map(frame => String(frame.data.text)).join('')
  check('the live deltas together hold the reply the done frame sanitizes',
    joined.includes(liveDraft.message.slice(0, 8)) || liveDraft.message.length < 8,
    JSON.stringify(joined.slice(0, 60)))

  // ── model memory as profile configuration, over the real settings service ──
  // The probe writes the user's real profile patch by design (that is the
  // feature); it is read first and restored in `finally`.
  const rememberedBefore = (await read('/api/git-panel/models')).json.remembered ?? null
  const prefsCatalog = (await read('/api/git-panel/models')).json
  const probeRoute = prefsCatalog.providers
    .filter(group => group.error === undefined)
    .flatMap(group => group.models.map(model => ({ provider: group.provider, model: model.id })))[0]
  check('a real model catalog offers at least one route to probe', probeRoute !== undefined)
  const savePrefs = async choice => {
    const response = await fetch(`${ORIGIN}/api/git-panel/prefs`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
      body: JSON.stringify(choice ?? {}),
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  }
  try {
    if (probeRoute !== undefined) {
      const saved = await savePrefs(probeRoute)
      check('a live pick persists through the settings service',
        saved.status === 200 && saved.json.persisted === true,
        `${String(saved.status)} ${JSON.stringify(saved.json)}`)
      const after = (await read('/api/git-panel/models')).json.remembered
      check('a live /models then reports the remembered choice',
        after?.provider === probeRoute.provider && after?.model === probeRoute.model,
        JSON.stringify(after))
    }
  } finally {
    if (probeRoute !== undefined) {
      await savePrefs(rememberedBefore)
      const restored = (await read('/api/git-panel/models')).json.remembered ?? null
      check('the probe choice is rolled back afterwards',
        JSON.stringify(restored) === JSON.stringify(rememberedBefore),
        JSON.stringify({ restored, before: rememberedBefore }))
    }
  }

  // ── blame over the real transport, on a real file ──────────────────────────
  const liveBlame = await read(`/api/git-panel/blame?dir=${encodeURIComponent('/root/deepseek-harness')}&path=README.md`)
  check('a live blame attributes real lines to real authors',
    liveBlame.status === 200 && liveBlame.json.lines.length > 0
      && liveBlame.json.lines.every(line => /^[0-9a-f]{40}$/.test(line.hash) && line.author !== ''),
    `${String(liveBlame.status)} lines=${String(liveBlame.json.lines?.length)}`)
  const blameGit = run(['blame', '--line-porcelain', 'HEAD', '--', 'README.md'], '/root/deepseek-harness')
  const gitLineCount = blameGit.split('\n').filter(raw => raw.startsWith('\t')).length
  check('a live blame agrees with git blame on the line count',
    liveBlame.json.lines.length === gitLineCount, `${String(liveBlame.json.lines.length)} vs ${String(gitLineCount)}`)
  check('a live blame on a file that is not committed is a 404',
    (await read(`/api/git-panel/blame?dir=${encodeURIComponent('/root/deepseek-harness')}&path=no-such-file.xyz`)).status === 404)

  // ── range reads over the real transport ────────────────────────────────────
  const liveNew = run(['rev-parse', 'HEAD'], '/root/deepseek-harness').trim()
  const liveOld = run(['rev-parse', 'HEAD~2'], '/root/deepseek-harness').trim()
  const liveRange = await read(`/api/git-panel/show?dir=${encodeURIComponent('/root/deepseek-harness')}&hash=${liveNew}&base=${liveOld}`)
  const liveRangeGit = run(['diff', '--name-only', '--find-renames', liveOld, liveNew], '/root/deepseek-harness').trim().split('\n').filter(line => line !== '')
  check('a live range read agrees with git on the changed files',
    liveRange.status === 200 && liveRange.json.base === liveOld
      && liveRange.json.files.map(file => file.path).join(',') === liveRangeGit.join(','),
    JSON.stringify({ route: liveRange.json.files?.length, git: liveRangeGit.length }))
  if ((liveRange.json.files ?? []).length > 0) {
    const rangeFile = liveRange.json.files[0].path
    const liveRangeDiff = await read(`/api/git-panel/diff?dir=${encodeURIComponent('/root/deepseek-harness')}&hash=${liveNew}&base=${liveOld}&path=${encodeURIComponent(rangeFile)}`)
    check('a live range diff matches git diff for that file',
      liveRangeDiff.status === 200 && liveRangeDiff.json.kind === 'text'
        && liveRangeDiff.json.text === run(['diff', '--no-color', '-U3', '--find-renames', liveOld, liveNew, '--', rangeFile], '/root/deepseek-harness'),
      `${String(liveRangeDiff.status)}`)
  }

  // ── project summaries over the real model ──────────────────────────────────
  const summariesPost = async body => {
    const response = await fetch(`${ORIGIN}/api/git-panel/project-summaries`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'x-dsh-git-panel': '1' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  }
  const liveSummaries = await summariesPost({})
  const summaryValues = Object.values(liveSummaries.json?.summaries ?? {})
  check('the real model summarizes workspaces in one call',
    liveSummaries.status === 200 && summaryValues.length > 0
      && summaryValues.some(value => typeof value === 'string' && value.length >= 6 && /[\u4e00-\u9fff]/.test(value)),
    `${String(liveSummaries.status)} values=${String(summaryValues.length)}`)
  check('the answer names the model that wrote it',
    typeof liveSummaries.json.provider === 'string' && liveSummaries.json.provider !== ''
      && typeof liveSummaries.json.model === 'string' && liveSummaries.json.model !== '')
  // Whether the first ask hit the cache depends on who asked before us; a
  // forced ask never does.
  const forcedSummaries = await summariesPost({ force: true })
  check('a forced ask bypasses the cache', forcedSummaries.json.cached === false)
  const cachedSummaries = await summariesPost({})
  check('the second ask hits the host cache', cachedSummaries.json.cached === true)

  const draftOutside = await draft({ dir: '/root' })
  check('a live draft outside every workspace is refused', draftOutside.status === 403, `${draftOutside.status}`)
  const draftNoHeader = await draft({ dir: clone }, { 'content-type': 'application/json' })
  check('a live draft without the panel header is refused', draftNoHeader.status === 403, `${draftNoHeader.status}`)

  const outside = await act({ dir: '/root', action: 'fetch' })
  check('a live action outside every workspace is refused', outside.status === 403, `${outside.status}`)

  const overviewAfter = await read('/api/git-panel/overview')
  check('reads still work after the writes', overviewAfter.status === 200 && overviewAfter.json.entries.length === (overview.json.entries.length), `${overviewAfter.status}`)
} finally {
  // Verify the resolved target before removing it: the sandbox must sit inside
  // the workspace it was created under, and carry this run's marker.
  const safe = sandbox.startsWith(`${hostWorkspace.workspace.path}/`) && sandbox.includes('.dsh-git-panel-live-')
  if (!safe) {
    process.stdout.write(`REFUSING to remove ${sandbox}\n`)
  } else {
    rmSync(sandbox, { recursive: true, force: true })
    process.stdout.write(`sandbox removed: ${sandbox}\n`)
  }
}

process.stdout.write(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
