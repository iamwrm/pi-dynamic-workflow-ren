/**
 * Built-in saved workflows, ported from Claude Code 2.1.172:
 *
 * - `deep-research` — Scope → pipeline(Search → URL-dedup → Fetch+Extract) →
 *   3-vote adversarial Verify → Synthesize. Constants match the binary
 *   (VOTES_PER_CLAIM=3, REFUTATIONS_REQUIRED=2, MAX_FETCH=15, MAX_VERIFY_CLAIMS=25).
 *   CC uses WebSearch/WebFetch; pi subagents are prompted to use a web tool when
 *   available and fall back to `bash` + curl.
 * - `code-review` — Scope → dimension reviewers → adversarial Verify → Synthesize
 *   (CC ships this shape for /review at high/max/ultra effort).
 *
 * The scripts must satisfy the workflow parser: pure-literal `meta` first,
 * deterministic (no Date.now/Math.random/argless new Date()), ≤512KB.
 */

export interface BuiltinWorkflow {
  name: string;
  script: string;
}

export const DEEP_RESEARCH_WORKFLOW = `export const meta = {
  name: 'deep-research',
  description: 'Deep research harness — fan out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  whenToUse: 'When the user wants a deep, multi-source, fact-checked research report. BEFORE invoking, check the question is specific enough — if underspecified, ask 2-3 clarifying questions first. Pass the research question as args.',
  phases: [
    { title: 'Scope', detail: 'decompose the question into complementary search angles' },
    { title: 'Search', detail: 'one web searcher per angle' },
    { title: 'Fetch', detail: 'fetch novel sources and extract falsifiable claims' },
    { title: 'Verify', detail: 'adversarial refutation votes per claim' },
    { title: 'Synthesize', detail: 'merge confirmed claims into a cited report' },
  ],
}

// Ported from bughunter architecture. Web search/fetch instead of git/grep.
const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'the research question, restated precisely' },
    summary: { type: 'string', description: '1-2 sentence summary of what is being researched' },
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'short angle label, 2-4 words' },
          query: { type: 'string', description: 'the search query for this angle' },
          rationale: { type: 'string', description: 'why this angle is complementary' },
        },
        required: ['label', 'query', 'rationale'],
      },
    },
  },
  required: ['question', 'summary', 'angles'],
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['url', 'title', 'relevance'],
      },
    },
  },
  required: ['results'],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    sourceQuality: { type: 'string', enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string', description: 'publish date if stated, else empty string' },
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'one falsifiable claim relevant to the question' },
          quote: { type: 'string', description: 'short supporting quote from the source' },
          importance: { type: 'string', enum: ['central', 'supporting', 'tangential'] },
        },
        required: ['claim', 'quote', 'importance'],
      },
    },
  },
  required: ['sourceQuality', 'claims'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if you found credible evidence against the claim, or could not corroborate it. Default to true if uncertain.' },
    evidence: { type: 'string', description: 'the strongest evidence for your verdict' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string', description: 'URL of the refuting/corroborating source, else empty string' },
  },
  required: ['refuted', 'evidence', 'confidence'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '3-5 sentence executive summary' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
        },
        required: ['claim', 'confidence', 'sources'],
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', maxItems: 4, items: { type: 'string' } },
  },
  required: ['summary', 'findings', 'caveats', 'openQuestions'],
}

const question = typeof args === 'string'
  ? args.trim()
  : (args && typeof args.question === 'string' ? args.question.trim() : '')
if (!question) {
  return { error: 'deep-research requires a research question: pass it via args (a string or { question }).' }
}

phase('Scope')
const scope = await agent(
  'Decompose this research question into 3-6 complementary web-search angles (e.g. broad overview, academic/primary sources, recent news, contrarian/skeptic, practitioner experience — tuned to the domain; 5 angles is the target). Question: ' + question,
  { label: 'scope question', phase: 'Scope', schema: SCOPE_SCHEMA },
)
if (!scope || !Array.isArray(scope.angles) || scope.angles.length === 0) {
  return { question, error: 'scoping failed: no search angles produced' }
}
log('scoped into ' + scope.angles.length + ' angles')

phase('Search')
const seenUrls = new Map()
const stats = { angles: scope.angles.length, sourcesFetched: 0, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, afterSynthesis: 0, urlDupes: 0, fetchDropped: 0 }
let fetchSlots = 0

const angleResults = await pipeline(
  scope.angles,
  async (angle) => {
    const found = await agent(
      'Web-search for sources answering: ' + angle.query
        + '\\nResearch angle: ' + angle.label + ' — ' + angle.rationale
        + '\\nUse a web search tool if available; otherwise use bash (e.g. curl a search engine or a known index/API). Return the top 4-6 most relevant result URLs with title, snippet, and relevance.',
      { label: 'search: ' + angle.label, phase: 'Search', schema: SEARCH_SCHEMA },
    )
    return { angle, results: found && Array.isArray(found.results) ? found.results : [] }
  },
  async (search) => {
    // Pure JS: normalize + dedup against the shared map, enforce the global fetch cap.
    const novel = []
    for (const result of search.results) {
      const url = String(result.url || '').replace(/#.*$/, '').replace(/\\/+$/, '')
      if (!url) continue
      if (seenUrls.has(url)) { stats.urlDupes++; continue }
      seenUrls.set(url, true)
      if (fetchSlots >= MAX_FETCH) { stats.fetchDropped++; continue }
      fetchSlots++
      novel.push({ url, title: result.title || '', relevance: result.relevance || 'medium' })
    }
    if (stats.fetchDropped > 0) log('fetch cap (' + MAX_FETCH + '): dropped ' + stats.fetchDropped + ' sources so far')
    const extractions = await parallel(novel.map((source) => () => agent(
      'Fetch this source and extract claims relevant to the research question.'
        + '\\nQuestion: ' + question
        + '\\nURL: ' + source.url + (source.title ? '\\nTitle: ' + source.title : '')
        + '\\nUse a web fetch tool if available; otherwise bash with curl -L. Extract 2-5 falsifiable claims with short supporting quotes, rate the source quality, and include the publish date if stated.',
      { label: 'fetch: ' + source.url.replace(/^https?:\\/\\//, '').split('/')[0], phase: 'Fetch', schema: EXTRACT_SCHEMA },
    )))
    const out = []
    for (let i = 0; i < novel.length; i++) {
      if (extractions[i]) out.push({ source: novel[i], extraction: extractions[i] })
    }
    return out
  },
)

phase('Verify')
const allClaims = []
for (const angleResult of angleResults) {
  if (!Array.isArray(angleResult)) continue
  for (const item of angleResult) {
    stats.sourcesFetched++
    for (const claim of item.extraction.claims || []) {
      stats.claimsExtracted++
      allClaims.push({
        claim: claim.claim,
        quote: claim.quote || '',
        importance: claim.importance || 'supporting',
        url: item.source.url,
        sourceQuality: item.extraction.sourceQuality || 'secondary',
      })
    }
  }
}
if (allClaims.length === 0) {
  return { question, summary: scope.summary, findings: [], refuted: [], sources: [...seenUrls.keys()], stats, note: 'no claims could be extracted from any source' }
}

const importanceRank = { central: 0, supporting: 1, tangential: 2 }
const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
allClaims.sort((a, b) =>
  (importanceRank[a.importance] - importanceRank[b.importance])
  || (qualityRank[a.sourceQuality] - qualityRank[b.sourceQuality]))
const toVerify = allClaims.slice(0, MAX_VERIFY_CLAIMS)
if (allClaims.length > toVerify.length) {
  log('verify cap (' + MAX_VERIFY_CLAIMS + '): ' + (allClaims.length - toVerify.length) + ' lower-priority claims left unverified')
}

const voteTasks = []
for (let claimIndex = 0; claimIndex < toVerify.length; claimIndex++) {
  for (let vote = 0; vote < VOTES_PER_CLAIM; vote++) voteTasks.push({ claimIndex, vote })
}
const votes = await parallel(voteTasks.map((task) => () => agent(
  'You are an adversarial fact-checker. Try to REFUTE this claim by finding contradicting or more-recent credible sources (web search / fetch; bash with curl as fallback). Corroborate only if refutation fails. Default to refuted=true if uncertain.'
    + '\\nClaim: ' + toVerify[task.claimIndex].claim
    + '\\nSource: ' + toVerify[task.claimIndex].url
    + (toVerify[task.claimIndex].quote ? '\\nQuote: ' + toVerify[task.claimIndex].quote : ''),
  { label: 'verify ' + (task.claimIndex + 1) + '.' + (task.vote + 1), phase: 'Verify', schema: VERDICT_SCHEMA },
)))

const survivors = []
const killed = []
for (let claimIndex = 0; claimIndex < toVerify.length; claimIndex++) {
  const claimVotes = []
  for (let i = 0; i < voteTasks.length; i++) {
    if (voteTasks[i].claimIndex === claimIndex) claimVotes.push(votes[i])
  }
  const valid = claimVotes.filter((vote) => vote && typeof vote.refuted === 'boolean')
  const refutations = valid.filter((vote) => vote.refuted).length
  // Survives only with enough valid votes AND fewer refutations than the kill
  // threshold; all-abstain claims cannot false-survive.
  const survives = valid.length >= REFUTATIONS_REQUIRED && refutations < REFUTATIONS_REQUIRED
  const entry = { ...toVerify[claimIndex], votes: { valid: valid.length, refuted: refutations } }
  if (survives) survivors.push(entry)
  else killed.push(entry)
}
stats.claimsVerified = toVerify.length
stats.confirmed = survivors.length
stats.killed = killed.length
log(stats.confirmed + ' claims confirmed, ' + stats.killed + ' refuted/unverifiable')

phase('Synthesize')
if (survivors.length === 0) {
  return { question, summary: 'All extracted claims were refuted or unverifiable.', findings: [], refuted: killed.map((entry) => entry.claim), sources: [...seenUrls.keys()], stats }
}
const report = await agent(
  'Synthesize a fact-checked research report from these verified claims. Merge duplicates, group related claims into findings with per-finding confidence and source URLs, write a 3-5 sentence executive summary, note caveats, and list 2-4 open questions.'
    + '\\nQuestion: ' + question
    + '\\nVerified claims (JSON): ' + JSON.stringify(survivors)
    + '\\nRefuted claims (JSON, for caveats only): ' + JSON.stringify(killed.map((entry) => entry.claim)),
  { label: 'synthesize report', phase: 'Synthesize', schema: REPORT_SCHEMA },
)
if (!report) {
  return { question, summary: scope.summary, findings: survivors, refuted: killed.map((entry) => entry.claim), sources: [...seenUrls.keys()], stats, note: 'synthesis failed; returning raw confirmed claims' }
}
stats.afterSynthesis = (report.findings || []).length
return {
  question,
  summary: report.summary,
  findings: report.findings,
  caveats: report.caveats,
  openQuestions: report.openQuestions,
  refuted: killed.map((entry) => entry.claim),
  sources: [...seenUrls.keys()],
  stats,
}
`;

export const CODE_REVIEW_WORKFLOW = `export const meta = {
  name: 'code-review',
  description: 'Multi-perspective code review — scope the change, fan out dimension reviewers, adversarially verify findings, synthesize a prioritized report.',
  whenToUse: 'When the user asks for a thorough review of a diff, branch, PR, or recent changes. Pass the review target as args (e.g. "HEAD~5..HEAD", "uncommitted", a path list, or { target, focus }).',
  phases: [
    { title: 'Scope', detail: 'collect the diff and changed-file inventory' },
    { title: 'Review', detail: 'one reviewer per dimension (correctness, security, performance, tests, maintainability)' },
    { title: 'Verify', detail: 'adversarial refutation votes per finding' },
    { title: 'Synthesize', detail: 'prioritized review report with a verdict' },
  ],
}

const VOTES_PER_FINDING = 3
const REFUTATIONS_REQUIRED = 2
const MAX_VERIFY_FINDINGS = 20
const DIMENSIONS = [
  { name: 'correctness', focus: 'logic errors, broken edge cases, race conditions, wrong assumptions, regressions' },
  { name: 'security', focus: 'injection, unsafe deserialization, path traversal, secrets, authz/authn gaps, unsafe defaults' },
  { name: 'performance', focus: 'algorithmic complexity, N+1 patterns, unnecessary IO/allocations, blocking calls on hot paths' },
  { name: 'tests', focus: 'missing/weak test coverage for the changed behavior, untested error paths, brittle tests' },
  { name: 'maintainability', focus: 'API contracts, naming, duplication, dead code, confusing control flow, doc drift' },
]

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'the change set under review, as resolved (e.g. a git range)' },
    overview: { type: 'string', description: '2-4 sentence overview of what the change does' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          changeSummary: { type: 'string' },
          risk: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['path', 'changeSummary', 'risk'],
      },
    },
  },
  required: ['target', 'overview', 'files'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          location: { type: 'string', description: 'function/line hint, else empty string' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'what is wrong and why it matters' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['file', 'title', 'detail', 'severity', 'confidence'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding is wrong, already handled, or not reproducible in the actual code. Default to true if uncertain.' },
    evidence: { type: 'string', description: 'file/line evidence for your verdict' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['refuted', 'evidence', 'confidence'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '3-5 sentence executive summary of the review' },
    verdict: { type: 'string', enum: ['approve', 'approve-with-nits', 'request-changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['severity', 'file', 'title', 'detail'],
      },
    },
    testGaps: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', maxItems: 4, items: { type: 'string' } },
  },
  required: ['summary', 'verdict', 'findings', 'testGaps', 'openQuestions'],
}

const target = typeof args === 'string'
  ? args.trim()
  : (args && typeof args.target === 'string' ? args.target.trim() : '')
const focus = args && typeof args.focus === 'string' ? args.focus : ''
const effectiveTarget = target || 'uncommitted changes (staged + unstaged: git diff HEAD)'

phase('Scope')
const scope = await agent(
  'Collect the change set under review: ' + effectiveTarget
    + '\\nUse git (via bash) and file reads from the repository at ' + cwd + '.'
    + '\\nResolve the target to a concrete diff (e.g. git diff for a range/working tree), list each changed file with a one-line change summary and a risk rating, and write a short overview of what the change does.',
  { label: 'scope change set', phase: 'Scope', schema: SCOPE_SCHEMA },
)
if (!scope || !Array.isArray(scope.files) || scope.files.length === 0) {
  return { target: effectiveTarget, error: 'scoping failed: no changed files found for the review target' }
}
log('reviewing ' + scope.files.length + ' files: ' + scope.overview)

phase('Review')
const fileList = scope.files.map((file) => file.path + ' (' + file.risk + ' risk: ' + file.changeSummary + ')').join('\\n')
const reviews = await parallel(DIMENSIONS.map((dimension) => () => agent(
  'Review this change set strictly for ' + dimension.name + ' issues: ' + dimension.focus
    + (focus ? '\\nExtra reviewer focus requested by the user: ' + focus : '')
    + '\\nTarget: ' + scope.target
    + '\\nOverview: ' + scope.overview
    + '\\nChanged files:\\n' + fileList
    + '\\nRepository: ' + cwd + '. Read the actual diff and surrounding code (bash + git, file reads); do not guess. Report at most 8 real findings for your dimension; an empty findings list is a valid answer.',
  { label: 'review: ' + dimension.name, phase: 'Review', schema: FINDINGS_SCHEMA },
)))

const allFindings = []
for (let i = 0; i < DIMENSIONS.length; i++) {
  const review = reviews[i]
  if (!review || !Array.isArray(review.findings)) continue
  for (const finding of review.findings) allFindings.push({ ...finding, dimension: DIMENSIONS[i].name })
}
if (allFindings.length === 0) {
  return { target: scope.target, overview: scope.overview, verdict: 'approve', summary: 'No reviewer surfaced findings across correctness, security, performance, tests, or maintainability.', findings: [], testGaps: [], stats: { files: scope.files.length, findingsRaw: 0, findingsVerified: 0, confirmed: 0, killed: 0 } }
}

phase('Verify')
const severityRank = { critical: 0, major: 1, minor: 2, nit: 3 }
allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
const toVerify = allFindings.slice(0, MAX_VERIFY_FINDINGS)
if (allFindings.length > toVerify.length) {
  log('verify cap (' + MAX_VERIFY_FINDINGS + '): ' + (allFindings.length - toVerify.length) + ' lower-severity findings pass through unverified')
}

const voteTasks = []
for (let findingIndex = 0; findingIndex < toVerify.length; findingIndex++) {
  for (let vote = 0; vote < VOTES_PER_FINDING; vote++) voteTasks.push({ findingIndex, vote })
}
const votes = await parallel(voteTasks.map((task) => () => agent(
  'You are an adversarial reviewer verifying a code-review finding. Read the ACTUAL code in the repository at ' + cwd + ' (bash + git, file reads) and try to REFUTE the finding: is it wrong, already handled, or unreproducible? Default to refuted=true if uncertain.'
    + '\\nFinding (' + toVerify[task.findingIndex].severity + ', ' + toVerify[task.findingIndex].dimension + '): ' + toVerify[task.findingIndex].title
    + '\\nFile: ' + toVerify[task.findingIndex].file + (toVerify[task.findingIndex].location ? ' @ ' + toVerify[task.findingIndex].location : '')
    + '\\nDetail: ' + toVerify[task.findingIndex].detail,
  { label: 'verify ' + (task.findingIndex + 1) + '.' + (task.vote + 1), phase: 'Verify', schema: VERDICT_SCHEMA },
)))

const survivors = []
const killed = []
for (let findingIndex = 0; findingIndex < toVerify.length; findingIndex++) {
  const findingVotes = []
  for (let i = 0; i < voteTasks.length; i++) {
    if (voteTasks[i].findingIndex === findingIndex) findingVotes.push(votes[i])
  }
  const valid = findingVotes.filter((vote) => vote && typeof vote.refuted === 'boolean')
  const refutations = valid.filter((vote) => vote.refuted).length
  const survives = valid.length >= REFUTATIONS_REQUIRED && refutations < REFUTATIONS_REQUIRED
  if (survives) survivors.push(toVerify[findingIndex])
  else killed.push(toVerify[findingIndex])
}
const unverified = allFindings.slice(MAX_VERIFY_FINDINGS)
log(survivors.length + ' findings confirmed, ' + killed.length + ' refuted, ' + unverified.length + ' unverified')

phase('Synthesize')
const report = await agent(
  'Synthesize a prioritized code-review report. Merge duplicate findings, order by severity, add a suggested fix per finding where clear, list test gaps, and give an overall verdict (approve / approve-with-nits / request-changes). Confirmed findings survived adversarial verification; unverified ones exceeded the verify cap — include them only if clearly real.'
    + '\\nTarget: ' + scope.target
    + '\\nOverview: ' + scope.overview
    + '\\nConfirmed findings (JSON): ' + JSON.stringify(survivors)
    + '\\nUnverified findings (JSON): ' + JSON.stringify(unverified)
    + '\\nRefuted findings (JSON, context only): ' + JSON.stringify(killed.map((finding) => finding.title)),
  { label: 'synthesize review', phase: 'Synthesize', schema: REPORT_SCHEMA },
)
const stats = { files: scope.files.length, findingsRaw: allFindings.length, findingsVerified: toVerify.length, confirmed: survivors.length, killed: killed.length, unverified: unverified.length }
if (!report) {
  return { target: scope.target, overview: scope.overview, verdict: survivors.some((finding) => finding.severity === 'critical' || finding.severity === 'major') ? 'request-changes' : 'approve-with-nits', summary: 'Synthesis failed; returning raw confirmed findings.', findings: survivors, testGaps: [], stats }
}
return { target: scope.target, overview: scope.overview, verdict: report.verdict, summary: report.summary, findings: report.findings, testGaps: report.testGaps, openQuestions: report.openQuestions, refuted: killed.map((finding) => finding.title), stats }
`;

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  { name: "deep-research", script: DEEP_RESEARCH_WORKFLOW },
  { name: "code-review", script: CODE_REVIEW_WORKFLOW },
];
