# Changelog

## Unreleased - 2026-07-30

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
