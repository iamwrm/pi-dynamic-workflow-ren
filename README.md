# pi-dynamic-workflow-rencc

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds an on-demand workflow toolkit. Instead of one assistant doing everything sequentially, the model can load the toolkit, write a small JavaScript script that fans out work across isolated subagents, and then synthesize the results.

This is the `rencc` fork; see [rencc improvements over the prototype](#rencc-improvements-over-the-prototype) below.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

This project is distributed as a Git repository, not as an npm package. After
reviewing the source, let Pi clone and manage it directly over HTTPS:

```bash
pi install https://github.com/iamwrm/pi-dynamic-workflow-ren.git
```

Pi installs the runtime dependencies as part of this managed Git install, so no
manual clone or `npm install` is required.

Then in Pi:

```text
/reload
```

That's it. The extension registers the small `workflow_load` bootstrap plus the full `workflow` and `workflow_tasks` tools, along with `/workflows` (an interactive live-run inspector in the TUI) and `/run-workflow` / `/kill-workflow` commands. Only the bootstrap is active on a new branch; the full tools load on demand.

### Progressive tool loading

`workflow_load` has an empty parameter schema and no `promptSnippet` or
`promptGuidelines`. Its concise provider-visible description lets the model
discover orchestration without putting the full tool schemas, saved-workflow
catalog, or detailed guide into every session.

When called, the loader additively activates `workflow` and `workflow_tasks`,
returns their complete guide as one result, and reads the saved-workflow catalog
at execution time. The tools remain loaded for that session branch; reload,
resume, fork, and `/tree` navigation restore the state recorded on the selected
branch instead of leaking it to unrelated branches. Calling the loader again is
safe and refreshes the guide and catalog.

Explicit Pi tool filters are respected. `workflow` is the core success
threshold: if optional `workflow_tasks` is filtered out, the loader still
returns the complete guide, records the branch state, and reports the missing
tool. If `workflow` itself is unavailable, loading fails without recording a
false success marker.

In the production-like Pi 0.80.6 probe used for this package, the first request
fell from 5,857 input tokens with eager loading to 3,912 with the bootstrap: a
1,945-token reduction before a workflow is used. Pi 0.80.7 introduced, and
0.83.0 preserves, anchoring of purely additive activation at the loader result
for provider-cache-friendly deferral on supported Anthropic and OpenAI Responses
models; other providers still receive the complete active list on the following
model turn.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

On an unloaded branch the model first calls `workflow_load`, then writes a workflow script and calls `workflow`. On an already loaded branch it can call `workflow` directly. The tool call shows the generated workflow script (the JS the model wrote) above the live progress, so you can review exactly what is running while the run proceeds; it persists in the transcript. Live progress then shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Once a TUI run reports `started in background`, it owns an independent cancellation lifetime. Use `/kill-workflow <runId>`, press `K` on its run in `/workflows`, or ask the main agent to call `workflow_tasks {action: 'kill', runId}`. `Esc` still cancels a foreground workflow or a launch that has not handed off, but aborting a later main-agent turn does not kill an accepted background run.

### Saved workflows and `/workflows`

The tool takes **exactly one** of three script sources:

| Parameter | Meaning |
| --- | --- |
| `script` | Inline raw JavaScript (the common case — the model writes it). |
| `scriptPath` | Path to a workflow script file, e.g. one persisted by a previous invocation. UNC paths are rejected. |
| `name` | A saved workflow from the registry. |

Every invocation **persists its effective script** to `<cwd>/.pi-workflow-runs/<runId>/workflow.js` and reports the path in the tool result — to iterate on a workflow, edit that file and re-invoke with `{scriptPath}` (add `resumeFromRunId` to replay cached agents).

The saved-workflow registry merges three sources (project > user > built-in, alpha-sorted):

- **built-in** — `deep-research` (fan-out web research with adversarial claim verification; pass the question as `args`) and `code-review` (multi-dimension review with adversarial finding verification; pass a git range/target as `args`)
- **user** — `~/.pi/agent/workflows/*.js`
- **project** — `<cwd>/.pi/workflows/*.js`

Run `/workflows` to list saved workflows, live background runs (with progress), and recent resumable run directories.

### `/run-workflow` — direct, model-free dispatch

```
/run-workflow <name> [args]
```

Runs a saved workflow immediately, without spending a model turn on dispatch: the
command resolves `<name>` against the registry and invokes the workflow tool's
execute path directly (same background run, live widget, and `workflow_result`
delivery as a model-issued call). It also activates the full workflow tools and
records that state for subsequent turns on the branch. The rest of the line is
passed as the workflow's `args` — if it starts like JSON (`{`, `[`, or `"`), it
is parsed so structured args pass through typed; otherwise it is handed over as
a raw string.

```
/run-workflow code-review HEAD~5..HEAD
/run-workflow code-review {"target": "uncommitted", "focus": "security"}
/run-workflow deep-research how do X and Y compare for Z?
```

Argument completion suggests saved workflow names. (For comparison, Claude Code
has no model-free launcher: its `/review` command dispatches by instructing the
model to call the Workflow tool. `/run-workflow` goes one step further and skips
the model entirely for dispatch.)

### `workflow_tasks` — inspect and control live runs

A model-visible registry of LIVE background runs — the rencc analog of Claude
Code's `local_workflow` task registry, with per-agent granularity:

```
workflow_tasks {action: 'list'}                              → run summaries (running/queued/done/failed, tokens, elapsed)
workflow_tasks {action: 'status', runId}                     → per-agent ids, statuses, live runningMs, grouped by phase + log tail
workflow_tasks {action: 'kill', runId}                       → abort the whole run
workflow_tasks {action: 'kill', runId, agentIds: [5, 6]}     → kill specific agents
```

`runId` may be omitted when exactly one run is live. `status` also accepts
`logTail` (recent run log lines, default 5) alongside `feedTail`.

This answers "how many subagents are running?", "what's the status of the 3rd
agent in the 2nd phase?", and "kill everything that's been running for an hour"
(the model calls `status`, filters by `runningMs`, then kills the chosen ids).

Kill semantics compose with resume: a killed agent's `agent()` call resolves to
`null` (the script's null-handling decides what happens next), skips stall
retries, and is **not** journaled — so `resumeFromRunId` re-runs exactly the
killed agents while completed ones replay from cache. A killed run delivers an
`aborted` workflow_result; its journal stays resumable too.

`/kill-workflow <runId>` is the user-side equivalent of a whole-run kill, with
runId completion from live runs.

### `/workflows` — interactive run inspector (TUI)

In the interactive TUI, `/workflows` opens a keyboard-driven overlay over the
session: a live tree of runs → phases → agents with a detail pane for the
selection.

```
 Workflows — live runs
 ▸ ▾ repo_review (wf_ab12) · Parallel reviews — 2/5 done · 2 running · 412.3k tok · 3m04s
     ── Parallel reviews
     #2 ● packages review — running 4m12s · 285.6k tok · anthropic/claude-opus · high
     #3 ✓ root and docs — 126.7k tok · 12 tools · 2m21s · anthropic/claude-sonnet · medium
 ─────────────────────────────────────────────────────
 #2 packages review — running 4m12s · 285.6k tok · Parallel reviews · anthropic/claude-opus · high
  prompt: You are reviewing the git repository at …
  ⚒ read src/workflow-tool.ts
  ⚒ grep redact
  ▌currently drafting the findings section…
 ↑↓ move · ⏎ fold · k kill agent · K kill run · y resume hint · q close
```

- `↑/↓` move over runs and agents, `⏎`/`←`/`→` fold/unfold a run
- the tree and detail pane show each agent's resolved **model** and **thinking
  level**, plus the selected agent's live `running` clock and accumulated
  provider-reported token usage, prompt, recent **activity feed** (tool calls,
  errors, message summaries), and streaming text tail (`▌…`) — refreshed
  ~2.5×/second while open; token totals advance after each completed model
  response
- `k` kills the selected running agent, `K` kills the whole run — both with an
  inline `y/n` confirm, riding the same kill semantics as `workflow_tasks`
- `y` prints a copy-able resume snippet for the selected run
- non-TUI modes (print/RPC) and overlay failures fall back to the plain text
  listing; the experimental pi overlay API is the only dependency

#### Session view — ⏎ on an agent

Pressing Enter on an agent row drills into a **normal-pi-session-like view** of
that subagent's conversation, assembled from pi's own message components
(`UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`),
so markdown, thinking blocks, and tool boxes render exactly like the main chat:

- the full composed user message ("what is sent": task label, prompt, output
  contract), assistant turns with live streaming, pi-style tool call/result boxes
- header shows status + live clock, **model id**, **thinking level**, and the same live token total
- `↑↓`/`PgUp`/`PgDn`/`g`/`G` scroll with bottom-follow while streaming;
  `t` toggles thinking blocks; `e` expands/collapses tool results;
  `k` kills (confirm) without leaving the view; `←`/`esc` back to the tree
- live agents read the real session messages; agents that already finished
  (while the run is live) replay from an in-memory capped snapshot, persisted
  as `agents/<NNN>-<label>.messages.jsonl`. Stall-retried attempts persist
  separately (write-once `.retryN.messages.jsonl` files — stalled attempts'
  conversations are preserved), and the per-agent `messages` path reported by
  `workflow_tasks status` always points at the newest attempt —
  full-fidelity post-mortems for the model and for `read`. (Once a run fully
  settles it leaves the live tree; its transcript/messages files remain.)

### Activity feeds & transcripts

Every spawned agent gets:

- an in-memory **feed** — the last 200 formatted activity lines (`⚒ tool: args`,
  `✗ tool failed: …`, `💬 message summary`) plus a streaming live-text tail —
  shown in the inspector and available to the model via
  `workflow_tasks {action: 'status', runId, feedTail: 20}` (default 0, max 200)
- a **full transcript file** at `.pi-workflow-runs/<runId>/agents/<NNN>-<label-slug>.md`
  (3-digit agent ordinal, label slugged to ≤40 chars)
  (prompt, timestamped tool lines, complete assistant texts, final status —
  including `killed`/`failed`), written incrementally and surviving the run.
  `status` reports each agent's `transcript` path; when the tail is not enough,
  read the file. `status` on a **finished** run returns its persisted transcript
  paths, so post-mortems never need a live run.
- a **pi child session** in the SAME pi session storage as the parent session
  (`~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`), created when the parent session
  is itself persisted. The child's header links back via `parentSession`, it is
  named `workflow <runId> · #<ordinal> <label>` (stall retries suffixed
  `· retryN`), and it carries the FULL untruncated trajectory including provider
  token usage — open it with `pi --session <path>` or from the resume picker.
  `workflow_tasks status` reports it per agent as `session` (also for finished
  runs, read back from the journal), and the `workflow_result` details carry a
  per-agent `sessionFile`. The file only appears once the subagent produced an
  assistant message, so failed-before-response attempts leave nothing behind.
  Disable with `PI_WORKFLOW_SUBAGENT_SESSIONS=0`.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `workflow(nameOrRef, args?)` | Run a saved workflow inline (one nesting level only). Shares the parent's concurrency, agent cap, budget, journal, and abort. Child `phase()` is silenced; child `log()` is prefixed with `[childName]`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line (capped at 1000 entries per run). |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

`parallel()` and `pipeline()` accept at most **4096 items per call** (an explicit error, not silent truncation); scripts are capped at **524,288 bytes** at parse time. Both limits match Claude Code.

### Per-agent options (`agent(prompt, opts)`)

| Option | Behavior |
| --- | --- |
| `label` | Display label for live progress and logs. |
| `phase` | Explicit phase assignment (avoids races inside `parallel`/`pipeline`). |
| `schema` | Plain JSON Schema → forced `structured_output` call → validated object result. |
| `model` | **Real model override.** Resolved against the session's model registry (`'provider/model-id'` or a bare model id). Unresolvable references degrade to a prompt hint + log line. |
| `agentType` | **Real named agent definition.** Resolved from `~/.pi/agent/agents/*.md` and `<cwd>/.pi/agents/*.md` (project overrides user): Markdown frontmatter (`name`, `description`, `model`, `tools`) + body as the role system prompt. Applies the role prompt, optional tool allowlist, and optional model. |
| `isolation: 'worktree'` | **Real git worktree isolation.** Creates a detached `git worktree` (50 concurrent slots, like Claude Code), runs the subagent with its tools rebuilt for that checkout, auto-removes unchanged worktrees, and keeps + logs changed ones. Failure to create one (e.g. not a git repo) is a normal per-agent failure (`null` + log). Use only when agents mutate files in parallel. |

Per-agent options are part of the journal cache key (plain calls keep their old v1 keys, so existing journals still replay).

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()` (zero-arg) — `new Date(...)` with arguments is allowed
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

These are enforced twice: a source-level regex pre-check rejects the literal calls before parsing, and a runtime shim on the sandbox's own `Math`/`Date` intrinsics throws even on aliased bypasses such as `const m = Math; m.random()`. This keeps `meta` parseable, runs reproducible, and the surface area small.

### Timeouts, budgets, and runaway protection

These semantics mirror Claude Code rather than imposing a single wall-clock deadline on the whole run (a workflow spends almost all of its time awaiting real subagent LLM turns, so a per-run clock would falsely kill multi-agent runs):

- **Sync-only script timeout (`scriptTimeoutMs`, default 30s).** Bounds the *synchronous* evaluation slice passed to `vm.runInContext` only — it catches an await-free infinite loop such as `while (true) {}`. It does **not** bound the async phase: once the body hits its first `await`, work runs outside this timeout. There is deliberately **no** whole-run wall-clock deadline.
- **Per-agent stall detection (`stallTimeoutMs`, default 3 min; `stallRetries`, default 5).** Claude-Code-style: each `agent()` attempt carries a stall timer that **resets on any subagent activity** (streaming deltas, tool executions — reported via the runner's `onActivity` hook), so long tool-heavy turns that keep making progress never trip. After `stallTimeoutMs` with *no* activity the attempt is aborted and retried, with logs like `[stall] agent "x" stalled (no progress) after 180s — retrying (1/5)`. Retry exhaustion is a normal per-agent failure (`null` + log) — it never kills the whole workflow.
- **Lifetime cap (`maxAgents`, default 1000) + abort + concurrency limiter.** The primary bound on async runaways. An unbounded `while (true) { await agent() }` loop is stopped by the spawn cap; the workflow-owned kill and shutdown signals cancel in-flight subagents. Foreground execution and a background launch that has not handed off also honor the originating tool signal. Concurrency is capped at `min(16, cpus − 2)`.
- **Residual limitation (same as Claude Code).** A pure microtask spin that never yields after the first `await` (e.g. `while (true) { await Promise.resolve() }`) starves the event loop, so neither abort nor any in-thread timer can interrupt it. Fully bounding that would require a worker thread; it is out of scope. The await-free synchronous loop is still caught by the sync-only vm timeout, and the `await agent()` loop by the spawn cap.

### Background vs foreground execution

Like Claude Code, the `workflow` tool runs in the **background** only in the interactive TUI (`ctx.mode === "tui"`): it returns immediately with a `runId` and `status: "running"`, then delivers the completed result back to the session as a follow-up message (Claude Code's `<task-notification>`) once it finishes. In-flight background runs are tracked and cancelled on session shutdown (quit / reload / new).

The `running` result is an explicit ownership handoff. Before it, the originating tool signal can cancel the launch. After it, the detached run is bounded only by its workflow-specific kill controller and the extension's session-shutdown signal. Consequently, an `Esc` or extension-driven abort of a later parent turn—including a forced compaction boundary—does not accidentally terminate accepted workflow work. Use `/kill-workflow`, `/workflows` (`K` for the run or `k` for one agent), or `workflow_tasks kill` for intentional cancellation.

While a background run is in flight, the interactive session shows a **live progress widget above the editor** plus a **compact footer status** (`<name>: <done>/<total> agents`), updated as phases and subagents progress. Each run owns a widget keyed per `runId`, so concurrent background runs do not clobber each other. When the result message is delivered, successful runs render the final completed workflow UI as a fixed `workflow_result` entry in the session history, then clear the transient widget/status; new messages can push it away, and you can scroll back to it later. Failed/aborted runs and session shutdown clear the transient UI. No live widget appears outside TUI mode.

In non-TUI modes (`-p` / `--print` / `--mode json` / RPC / piped stdin) the tool runs in the **foreground** and returns the full result synchronously. RPC has `ctx.hasUI === true` in pi 0.80.6, so `ctx.mode` is the authoritative distinction. Foreground execution is required for correctness because these sessions may dispose before a detached continuation can deliver.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an isolated Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh Pi sessions with the standard coding tools, inherited global/project packages and extensions, and the parent session's project-trust decision. When the parent has persisted session storage, each child is also persisted as a linked Pi session.

Child sessions preserve Pi's persisted automatic-compaction setting (Pi defaults it to enabled). Overflow recovery remains active while a child is working; a successful terminal one-shot response skips threshold compaction because no later prompt would consume the summary. If inherited resources include the `ren-public-package` server-compaction extension, supported Codex and Fluxion models use its native server adapter; otherwise Pi uses its ordinary readable compactor. Every child attempt owns a separate offline `ModelRuntime`, so parallel server-compaction adapters cannot overwrite one another's request state.

Use the workflow tool's optional `autoCompaction` boolean or `WorkflowAgentOptions.autoCompaction` to override the persisted setting. SDK callers that inject `session.settingsManager` must also inject its paired, already-loaded `session.resourceLoader`; this prevents resource reload from erasing caller-owned in-memory overrides. Temporary CLI-only extensions are not inherited automatically.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime (stall retries, caps, `workflow()` nesting, per-agent option wiring). |
| `src/workflow-tool.ts` | The deferred `workflow` / `workflow_tasks` tools, shared on-demand guide, script sources and persistence, rendering, and abort handling. |
| `src/workflow-registry.ts` | Saved-workflow registry (built-in / user / project). |
| `src/builtin-workflows.ts` | Built-in `deep-research` and `code-review` workflow scripts. |
| `src/agent-types.ts` | Named agentType registry (`*.md` with frontmatter + role prompt). |
| `src/worktree.ts` | Real git-worktree isolation with a 50-slot limiter. |
| `src/agent.ts` | `WorkflowAgent`, an isolated Pi subagent runner (scoped settings/trust inheritance, text-return + structured contracts, activity events, per-call cwd/model/tools). |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint: `workflow_load`, additive activation and branch-local state, full-tool registration, commands, and result renderers. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## rencc improvements over the prototype

This fork closes several Claude-Code-style gaps in the original prototype:

- **Progressive disclosure.** New branches expose only the tiny `workflow_load`
  bootstrap; the model loads the full tools, detailed guide, and current
  saved-workflow catalog only when orchestration is useful. Loaded state follows
  the relevant session branch, and `/run-workflow` performs the same activation
  during model-free dispatch.
- **Resume / journaling.** Every run gets a `runId` and an append-only JSONL journal under `<cwd>/.pi-workflow-runs/<runId>/journal.jsonl` (override with `journalDir`). Each `agent()` call is keyed by a deterministic ordinal + stable hash of a JSON-serialized prompt/label/schema tuple. Re-running the tool with `resumeFromRunId` set to a prior `runId` replays cached results and skips already-completed subagents entirely. The tool surfaces `Resume with runId: wf_...` in its output.
- **Runtime determinism shim.** A prelude runs inside the sandbox context and makes the context-local `Math.random()`, `Date.now()`, and zero-arg `new Date()` throw at runtime, catching aliased bypasses that the source pre-check cannot see. `new Date(...)` with arguments still works.
- **Sandbox hardening.** Every injected callable (`agent`, `parallel`, `pipeline`, `log`, `phase`, the `console` methods, `process.cwd`) has its prototype/constructor stripped, closing the `injectedFn.constructor("return process")()` host-realm escape. Host intrinsics are no longer shared into the sandbox; the `vm` context uses its own fresh `JSON`/`Math`/`Array`/etc.
- **CC-faithful timeouts.** `scriptTimeoutMs` (default 30s) bounds *only* the synchronous `vm` evaluation slice (matching Claude Code's internal sync-only `runInContext` timeout), so a `while (true) {}` cannot hang the host. There is no whole-run wall-clock deadline; instead activity-reset per-agent **stall detection** (180s, 5 retries — matching Claude Code) aborts and retries an individual stuck subagent and finally treats it as a normal failure (`null` + log), never killing the run.
- **Runaway lifetime cap.** `maxAgents` (default 1000) caps total `agent()` spawns and throws a clear error when exceeded — the primary bound on `await agent()` runaways, alongside the abort signal and concurrency limiter.
- **Background execution.** In TUI sessions a run executes in the background, returning a `runId` immediately and notifying on completion (Claude Code's `<task-notification>`); accepted runs have workflow-owned cancellation independent of later parent turns. In print/JSON/RPC modes it runs in the foreground so results are never lost. The mode check is intentional because RPC has `ctx.hasUI === true` in pi 0.80.6. In-flight background runs are cancelled and awaited on session shutdown.
- **Structured-output retry.** When a subagent has a schema but finishes without calling `structured_output`, it is re-prompted with a firm nudge up to N times (default 2) before failing. Exhausted Pi provider retries (`stopReason: "error"`), aborted/truncated turns, and empty terminal text are failures rather than journaled successes.
- **Real parent-environment inheritance.** Subagents inherit the parent Pi session's `model`, `thinkingLevel`, project-trust decision, file-backed global/project package settings, and automatic-compaction preference. Child resource loading preserves trusted project providers/workarounds while suppressing all project resources for untrusted parents; only workflow-tool extensions are filtered as a recursion guard. Temporary CLI `-e` extensions and inline factories cannot be reconstructed from settings, so SDK callers needing those can inject a paired `WorkflowAgentOptions.session.settingsManager` + `resourceLoader`.
- **Real per-agent option wiring.** Script-level `opts.model` resolves through the session's model registry; `opts.agentType` resolves named agent definitions from `~/.pi/agent/agents` / `.pi/agents`; `opts.isolation: 'worktree'` creates actual detached git worktrees (50-slot limiter, auto-cleanup of unchanged checkouts).
- **Stall-based per-agent timeout with retries.** Activity-reset stall detection (180s default) with up to 5 retries per agent, replacing the earlier fixed per-agent wall clock. Cancellation aborts both the agent loop and active compaction; token/cost telemetry accumulates across every retry and all append-only session entries, including compacted history and compaction requests.
- **Script persistence + `scriptPath` iteration.** Every invocation persists its effective script to `.pi-workflow-runs/<runId>/workflow.js` and reports the path; re-invoke with `{scriptPath}` (+ `resumeFromRunId`) to iterate without resending the script.
- **Saved workflows + `workflow()` nesting.** A named registry (built-in / user / project) invokable via the tool's `name` parameter, and a `workflow(nameOrRef, args)` sandbox primitive with one-level nesting that shares the parent's caps/budget/journal/abort.
- **Built-in `deep-research` and `code-review` workflows** ported from Claude Code 2.1.172 (scope → fan-out → adversarial verify → synthesize, with the same vote constants and graceful salvage paths).
- **`/workflows` command** listing saved workflows, live background runs with progress, and recent resumable runs.
- **Subagent sessions in pi session storage.** Every spawned subagent persists as a real pi child session (standard session JSONL, `parentSession` → the parent's session file) in the parent's session directory, so subagent trajectories and token usage are inspectable with `pi --session <path>`/the resume picker instead of living only under `.pi-workflow-runs`. Requires a persisted parent session; opt out with `PI_WORKFLOW_SUBAGENT_SESSIONS=0`.
- **CC parity caps.** 4096-item cap per `parallel()`/`pipeline()` call, 524,288-byte script cap, 1000-entry log cap, 400-line script preview, and Claude Code's verbatim text-return subagent contract.

## Security backlog

The workflow VM is a determinism/convenience boundary, not currently a safe
boundary for untrusted saved scripts. Confirmed realm-bridge, project-trust,
path-containment, cancellation-drain, and output-bounding work is tracked in
[`BACKLOG.md`](./BACKLOG.md). Do not execute project-local saved workflows from
untrusted repositories.

## Status

This fork implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) behind an on-demand progressive loader, plus resumable journaled runs, a runtime determinism shim, a hardened sandbox, Claude-Code-faithful timeout semantics (sync-only vm timeout + activity-reset stall detection with retries + a `maxAgents` lifetime cap, with no whole-run wall-clock deadline), background execution in interactive sessions (foreground in `-p`/print/RPC), structured-output retries, real model/agentType/worktree wiring, script persistence with `scriptPath` iteration, a saved-workflow registry with built-in `deep-research`/`code-review` and one-level `workflow()` nesting, and a `/workflows` manager command.

Known remaining gaps vs Claude Code 2.1.172: turn-wide shared token budget, throttle detection (45s backoff), full SES-style intrinsic lockdown, MCP ToolSearch access for subagents, and plugin-namespaced workflows.

## License

MIT
