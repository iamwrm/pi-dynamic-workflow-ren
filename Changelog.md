# Changelog

## 1.8.7 - 2026-08-04

### Added
- The `/workflows` inspector now shows each subagent's resolved model and thinking level in the live tree and selected-agent detail pane, alongside elapsed time and token usage.

### Validated
- Biome check, build, extension typecheck, and unit/integration tests pass against Pi 0.83.0.

## 1.8.6 - 2026-08-04

### Fixed
- Accepted TUI background runs now detach from the originating tool signal after their run registry and cancellation controls are installed. A later main-agent abort, including a forced mid-turn compaction boundary, can no longer terminate already-detached workflow work.
- Failed handoff registration aborts the unowned run and suppresses its asynchronous result instead of leaving an orphaned background task.

### Changed
- Background workflow cancellation is now explicit after handoff: users retain `/kill-workflow` and the `/workflows` kill controls, models retain whole-run and per-agent `workflow_tasks` kills, and session shutdown still aborts and drains every run. Foreground workflows and launches before handoff continue to honor the originating tool signal.
- Start results and documentation now state the independent background lifetime and its workflow-specific cancellation commands.

### Validated
- Added regression coverage showing that an accepted hanging run survives its parent-turn abort and remains immediately killable through the existing per-run controller, while a failed handoff is aborted without detached delivery.
- Biome check, build, extension typecheck, and all 169 unit/integration tests pass against Pi 0.83.0.

## 1.8.5 - 2026-08-04

### Added
- The `/workflows` inspector now shows provider-reported token usage for running subagents beside the live elapsed clock, and refreshes per-agent and run totals as new model responses finish.
- Live session telemetry uses the same append-only accounting as final results, including nested tool/compaction usage, and remains cumulative across stalled-attempt retries without resetting or double-counting.

### Validated
- Added regression coverage for in-flight session usage, retry accumulation, polled live snapshots, and updating inspector tree/detail totals.
- A tmux TUI smoke test showed `6.3k tok` on a still-running agent while its elapsed clock advanced from 18s to 28s.
- Biome check, build, extension typecheck, and all 167 unit/integration tests pass against Pi 0.83.0.

## 1.8.4 - 2026-07-31

### Changed
- Updated the locked `@earendil-works/pi-*` development baseline from 0.80.8 to 0.83.0.
- Replaced the manual clone/local-path installation instructions with Pi's direct managed HTTPS Git install.
- CI now installs the tested commit through its HTTPS Git URL, verifies the managed checkout and runtime dependency, and uses the Node 24-based v5 GitHub actions.
- Workflow children preserve Pi's persisted automatic-compaction setting (default enabled) and accept an explicit `autoCompaction` override through both `WorkflowAgentOptions` and the production `workflow` tool. Caller-provided settings managers must be paired with their already-loaded resource loader so reload cannot erase in-memory overrides.
- Successful terminal one-shot turns skip threshold compaction because no later prompt can consume the summary; overflow recovery and pre-follow-up compaction remain enabled. Supported Codex/Fluxion models still delegate overflow compaction to an inherited server adapter such as `ren-public-package` `0017`, with ordinary readable Pi compaction as the fallback.

### Fixed
- Removed a CI scheduling flake from the no-whole-run-clock regression by giving synchronous VM startup a realistic watchdog while keeping the simulated async work longer than that watchdog.
- Gave each default child attempt its own offline `ModelRuntime`, preventing parallel stateful provider decorators/native-compaction adapters from overwriting sibling request snapshots.
- Reject exhausted provider errors, aborted/truncated responses, and missing terminal text instead of returning stale/empty assistant output and journaling a false success.
- Abort active compaction and branch summarization together with the agent loop so stall retries, kills, and shutdown do not wait for an adapter timeout.
- Derive usage/tool telemetry from the full append-only session entry stream, including compacted-away messages, tool usage, and compaction/branch-summary requests; accumulate it across every stalled retry attempt.

### Validated
- Added live `WorkflowAgent` regression coverage for parallel runtime isolation, terminal provider errors, server-adapter overflow recovery, active-compaction abort, full-entry telemetry, and terminal threshold suppression, plus cumulative retry accounting and compaction-setting precedence tests.
- Biome check, build, extension typecheck, and all 163 unit/integration tests pass against Pi 0.83.0.

## 1.8.3 - 2026-07-30

### Fixed
- Keep stall-guard timers referenced until an attempt settles, preventing headless Node runners from exiting before a stalled attempt can be aborted and retried.

### Changed
- Prepared the project as a standalone public Git repository under `iamwrm/pi-dynamic-workflow-ren`.
- CI validates the build and installs the checkout through Pi's local-path package flow; npm publishing is disabled.
- Removed credential-specific wording from the validation note while retaining the model/provider qualification.

## 1.8.2 - 2026-07-17

### Changed
- Updated and pinned the pi development dependencies to 0.80.8.
- Workflow child sessions now share an explicitly created, offline-initialized `ModelRuntime`, avoiding one configured-provider catalog refresh per parallel agent/retry after pi 0.80.8 made runtime creation asynchronous.
- Added `BACKLOG.md` for the separately identified workflow sandbox, trust, path-containment, cancellation, and output-bounding hardening work; those security changes are intentionally deferred.

### Validated
- Pi 0.80.8 keeps the extension-facing `ctx.modelRegistry` compatibility facade, additive dynamic-tool loading, lifecycle events, and reused TUI component APIs used by this package.
- Biome check, build, extension typecheck, and all 151 unit tests pass against pi 0.80.8. A live `WorkflowAgent` request also completed through the shared offline-initialized runtime using the xAI `grok-4.5` model.

## 1.8.1 - 2026-07-15

### Changed
- Refreshed the locked `@earendil-works/pi-*` development packages from 0.80.6 to 0.80.7 and updated the README's dynamic-loading note now that cache-friendly additive activation is released.

### Fixed
- Workflow subagents now inherit the parent session's project-trust decision and load file-backed global/project settings in their native scopes. Trusted children retain project packages/providers; untrusted children no longer auto-load `.pi/extensions`; global packages remain available in both cases. Child-only compaction disabling is applied after resource reload so it is not discarded.

### Validated
- The existing `workflow_load` activation is already purely additive during tool execution, matching pi 0.80.7's cache-friendly dynamic tool-loading contract; no source migration is needed.
- Build, extension typecheck, Biome checks, and all 151 unit tests pass against pi 0.80.7.

## 1.8.0 - 2026-07-14

### Added
- Added the tiny, always-available `workflow_load` bootstrap tool. It additively activates `workflow` and `workflow_tasks` only when the model decides orchestration is useful or the user explicitly requests it, then returns the complete workflow guide and a freshly loaded saved-workflow catalog in one result.
- Added branch-local loaded-state persistence and restoration across reload, resume, fork, and `/tree` navigation without making the full tools global to unrelated branches.

### Changed
- Removed `promptSnippet` and `promptGuidelines` from the full workflow tools. Their schemas, provider definitions, saved-workflow catalog, and detailed guidance are now absent before activation; critical execution contracts remain in the deferred tool descriptions and parameter descriptions.
- `/run-workflow` now activates the full tools during its model-free dispatch path, applies the tool's argument normalization, and makes the same on-demand guide available to subsequent model turns.
- Explicit Pi tool filters remain authoritative: a filtered optional `workflow_tasks` is reported without suppressing the core `workflow` guide or branch marker, while an unavailable `workflow` tool fails closed without recording a successful load.
- New branches start with only `workflow_load` from this package. In the measured production-like Pi 0.80.6 configuration, first-request input fell from 5,857 to 3,912 tokens, saving 1,945 tokens before workflows are used.

## 1.7.1 - 2026-07-10

### Fixed
- Background workflow execution and the `/workflows` overlay now require `ctx.mode === "tui"`. Pi 0.80.6 reports `ctx.hasUI === true` in RPC, so the former `hasUI` check could detach a run or attempt a TUI overlay in RPC instead of returning the result synchronously.

### Changed
- Refreshed the locked `@earendil-works/pi-*` development packages from 0.80.3 to 0.80.6 while preserving the pending 1.7.0 lockfile metadata update.
