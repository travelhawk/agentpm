export const meta = {
  name: 'github-issue-loop',
  description: 'Iterate every open GitHub issue in a repo and implement it in a plan → implement → validate loop',
  whenToUse: 'When you want to auto-implement a backlog of GitHub issues, each on its own branch, with a self-correcting validate/fix loop.',
  phases: [
    { title: 'Discover', detail: 'gh issue list → structured backlog' },
    { title: 'Plan', detail: 'one plan per issue' },
    { title: 'Implement', detail: 'branch + code change per issue' },
    { title: 'Validate', detail: 'build/test, fix-and-retry loop' },
    { title: 'Report', detail: 'summary of outcomes' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs (pass via Workflow `args`):
//   { repo: "owner/name",        // REQUIRED — target repository
//     limit: 30,                 // max issues to process (default 30)
//     labels: "bug,good first issue", // optional gh label filter (comma list)
//     state: "open",             // open | closed | all (default open)
//     maxFixAttempts: 2,         // validate→fix retries per issue (default 2)
//     baseBranch: "main",        // branch to cut feature branches from
//     openPr: true,              // open a draft PR per implemented issue
//     force: false,              // reprocess issues that already have a branch/PR
//     skipLabel: "" }            // skip issues carrying this label (e.g. "wontfix")
//
// IDEMPOTENCY: safe to re-run (cron / GitHub Actions). Discover also fetches
// existing `issue-<n>` branches and PRs and SKIPS any issue already handled,
// so new runs only pick up genuinely new/unstarted issues. Use force:true to
// reprocess everything. Let merged PRs (which `closes #n`) drop issues from the
// open set, and/or set skipLabel to exclude triaged issues.
//
// PRECONDITION: run this workflow from inside a local clone of `repo`. The
// implement/validate agents operate on the session's working tree. Issues are
// processed SEQUENTIALLY (shared working tree, one branch per issue) so the
// separate plan/implement/validate/fix agents share state coherently.
// ---------------------------------------------------------------------------

const repo = args && args.repo
if (!repo) throw new Error('args.repo is required, e.g. { repo: "owner/name" }')
const limit = (args && args.limit) || 30
const labels = (args && args.labels) || ''
const state = (args && args.state) || 'open'
const maxFixAttempts = (args && typeof args.maxFixAttempts === 'number') ? args.maxFixAttempts : 2
const baseBranch = (args && args.baseBranch) || 'main'
const openPr = !(args && args.openPr === false)
const force = !!(args && args.force)
const skipLabel = (args && args.skipLabel) || ''

const ISSUE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title'],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    handledBranches: {
      type: 'array',
      items: { type: 'string' },
      description: 'Existing branch names matching the pattern issue-<n> (local or remote)',
    },
    prHeads: {
      type: 'array',
      items: { type: 'string' },
      description: 'headRefName of every PR (any state) — used to detect issue-<n> branches that already have a PR',
    },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps', 'feasible'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph approach' },
    steps: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' }, description: 'Files likely to change' },
    testStrategy: { type: 'string', description: 'How this change will be validated' },
    risks: { type: 'array', items: { type: 'string' } },
    feasible: { type: 'boolean', description: 'false if the issue cannot be implemented from the repo alone (needs human input, external creds, ambiguous spec)' },
    skipReason: { type: 'string' },
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'branch', 'summary'],
  properties: {
    success: { type: 'boolean' },
    branch: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    blocker: { type: 'string', description: 'set when success=false' },
  },
}

const VALIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'checksRun'],
  properties: {
    passed: { type: 'boolean' },
    checksRun: { type: 'array', items: { type: 'string' }, description: 'commands actually run (build, lint, tests)' },
    failures: { type: 'array', items: { type: 'string' }, description: 'concrete failure messages' },
    notes: { type: 'string' },
  },
}

const FINALIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed'],
  properties: {
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    prUrl: { type: 'string' },
    notes: { type: 'string' },
  },
}

const ghFilter =
  `gh issue list -R ${repo} --state ${state} --limit ${limit} ` +
  (labels ? labels.split(',').map(l => `--label "${l.trim()}"`).join(' ') + ' ' : '') +
  `--json number,title,body,labels`

// --- Phase 1: discover the backlog + what's already handled -----------------
phase('Discover')
const discovery = await agent(
  `Gather the backlog AND the work already in flight, then return it as structured data. ` +
  `Run these commands:\n\n` +
  `  1. Issues:   ${ghFilter}\n` +
  `  2. PRs:      gh pr list -R ${repo} --state all --limit 200 --json headRefName\n` +
  `  3. Branches: git ls-remote --heads origin "issue-*"\n\n` +
  `From #1, for each issue return number, title, body (truncate to ~2000 chars), and label names.\n` +
  `From #2, return prHeads = every PR's headRefName.\n` +
  `From #3, return handledBranches = the branch names (strip the refs/heads/ prefix), e.g. "issue-12".\n` +
  `If a command errors (auth, repo not found, no remote), treat its result as empty rather than failing. ` +
  `If issue discovery itself fails, return {"issues": []}.`,
  { label: `discover:${repo}`, phase: 'Discover', schema: ISSUE_LIST_SCHEMA }
)

const allIssues = (discovery && discovery.issues) || []
if (!allIssues.length) {
  log(`No issues found for ${repo} (state=${state}${labels ? `, labels=${labels}` : ''}). Nothing to do.`)
  return { repo, processed: 0, results: [] }
}

// Build the set of issue numbers already handled (branch exists OR a PR exists).
const handled = new Set()
const collectIssueNum = (ref) => {
  const m = /(?:^|\/)issue-(\d+)$/.exec(String(ref || '').trim())
  if (m) handled.add(Number(m[1]))
}
;(discovery.handledBranches || []).forEach(collectIssueNum)
;(discovery.prHeads || []).forEach(collectIssueNum)

// Apply the idempotency guard + optional label skip.
const skipped = []
const issues = allIssues.filter((iss) => {
  if (!force && handled.has(iss.number)) {
    skipped.push({ issue: iss.number, title: iss.title, status: 'skipped', reason: 'already has a branch/PR' })
    return false
  }
  if (skipLabel && (iss.labels || []).includes(skipLabel)) {
    skipped.push({ issue: iss.number, title: iss.title, status: 'skipped', reason: `carries skipLabel "${skipLabel}"` })
    return false
  }
  return true
})

if (skipped.length) {
  log(`Skipping ${skipped.length} already-handled/excluded issue(s): ${skipped.map(s => '#' + s.issue).join(', ')}`)
}
if (!issues.length) {
  log(`All ${allIssues.length} discovered issue(s) are already handled or excluded. Nothing new to do.`)
  return { repo, processed: 0, counts: { skipped: skipped.length }, results: skipped }
}
log(`${issues.length} new issue(s) to process in ${repo} (${skipped.length} skipped). Processing sequentially.`)

// --- Per-issue: plan → implement → validate/fix → finalize -----------------
// Sequential on purpose: the agents below share one working tree.
const results = [...skipped]

for (let i = 0; i < issues.length; i++) {
  const issue = issues[i]
  const tag = `#${issue.number}`
  const branch = `issue-${issue.number}`
  const ctx =
    `Repository: ${repo}\n` +
    `Issue ${tag}: ${issue.title}\n` +
    `Labels: ${(issue.labels || []).join(', ') || '(none)'}\n` +
    `Body:\n${issue.body || '(no description)'}\n`

  log(`[${i + 1}/${issues.length}] ${tag} ${issue.title}`)

  // 1) PLAN -----------------------------------------------------------------
  phase('Plan')
  const plan = await agent(
    `You are planning the implementation of a GitHub issue. Read the relevant parts of the ` +
    `codebase in the current working directory to ground your plan in reality.\n\n${ctx}\n` +
    `Produce a concrete, minimal implementation plan. Set feasible=false (with skipReason) ONLY if ` +
    `the issue genuinely cannot be implemented from the repo alone (needs product decisions, secrets, ` +
    `or is too ambiguous). Do NOT modify any files in this step.`,
    { label: `plan:${tag}`, phase: 'Plan', schema: PLAN_SCHEMA }
  )

  if (!plan || plan.feasible === false) {
    const reason = (plan && plan.skipReason) || 'planning failed'
    log(`  ↳ skipped ${tag}: ${reason}`)
    results.push({ issue: issue.number, title: issue.title, status: 'skipped', reason })
    continue
  }

  // 2) IMPLEMENT (creates the branch, makes the change) ---------------------
  phase('Implement')
  const impl = await agent(
    `Implement the plan below for issue ${tag} in the current working tree.\n\n${ctx}\n` +
    `PLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
    `Steps:\n` +
    `1. Ensure a clean tree, checkout ${baseBranch}, pull, then create branch "${branch}" ` +
    `(if it exists, reset it to ${baseBranch}). Use the Bash tool with git.\n` +
    `2. Make the code changes per the plan. Keep the diff minimal and idiomatic to the surrounding code.\n` +
    `3. Do NOT commit yet — leave changes in the working tree for validation.\n` +
    `Return success=false with a blocker if you cannot implement it.`,
    { label: `implement:${tag}`, phase: 'Implement', schema: IMPLEMENT_SCHEMA }
  )

  if (!impl || !impl.success) {
    const blocker = (impl && impl.blocker) || 'implementation failed'
    log(`  ↳ failed ${tag}: ${blocker}`)
    results.push({ issue: issue.number, title: issue.title, status: 'failed', reason: blocker })
    continue
  }

  // 3) VALIDATE → FIX loop --------------------------------------------------
  phase('Validate')
  let validation = null
  let passed = false
  for (let attempt = 0; attempt <= maxFixAttempts; attempt++) {
    validation = await agent(
      `Validate the changes for issue ${tag} on branch "${branch}".\n\n${ctx}\n` +
      `Discover and run this repo's checks (build, lint, type-check, and the most relevant tests). ` +
      `Prefer the narrowest test set that covers the change; run the full suite if the repo is small. ` +
      `Report passed=true only if all checks you ran succeeded. List concrete failures verbatim.`,
      { label: `validate:${tag}${attempt ? `:retry${attempt}` : ''}`, phase: 'Validate', schema: VALIDATE_SCHEMA }
    )

    if (validation && validation.passed) { passed = true; break }
    if (attempt === maxFixAttempts) break

    log(`  ↳ ${tag} validation failed (attempt ${attempt + 1}/${maxFixAttempts + 1}), fixing…`)
    await agent(
      `Validation failed for issue ${tag}. Fix the code so the checks pass. Do not regress the ` +
      `intended change.\n\n${ctx}\nFAILURES:\n${JSON.stringify((validation && validation.failures) || [], null, 2)}\n\n` +
      `Make the minimal fix in the working tree. Do not commit.`,
      { label: `fix:${tag}:attempt${attempt + 1}`, phase: 'Validate' }
    )
  }

  // 4) FINALIZE (commit + optional PR) -------------------------------------
  phase('Report')
  const finalize = await agent(
    `Finalize issue ${tag} on branch "${branch}". Validation ${passed ? 'PASSED' : 'did NOT pass'}.\n\n${ctx}\n` +
    `1. Stage and commit all changes with a message: "${issue.title} (closes #${issue.number})". ` +
    `${passed ? '' : 'Prefix the commit subject with "WIP: " since validation did not pass. '}` +
    `Co-author the commit appropriately.\n` +
    (openPr
      ? `2. Push the branch and open a ${passed ? 'regular' : 'DRAFT'} PR with \`gh pr create -R ${repo} ` +
        `--base ${baseBranch} --head ${branch}\`, linking the issue in the body. Return the PR url.\n`
      : `2. Push the branch with \`git push -u origin ${branch}\`. Do not open a PR.\n`) +
    `Return commitSha and (if created) prUrl. Then checkout ${baseBranch} to leave a clean tree.`,
    { label: `finalize:${tag}`, phase: 'Report', schema: FINALIZE_SCHEMA }
  )

  results.push({
    issue: issue.number,
    title: issue.title,
    status: passed ? 'implemented' : 'implemented-unvalidated',
    branch,
    commitSha: finalize && finalize.commitSha,
    prUrl: finalize && finalize.prUrl,
    checks: (validation && validation.checksRun) || [],
    failures: passed ? [] : (validation && validation.failures) || [],
  })
}

// --- Summary ---------------------------------------------------------------
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})
log(`Done. ${JSON.stringify(counts)}`)
return { repo, processed: issues.length, skipped: skipped.length, counts, results }
