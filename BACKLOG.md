# Backlog

## Security and isolation hardening

These issues were confirmed during the pi 0.80.8 upstream audit on 2026-07-16.
They are intentionally deferred; do not treat the current workflow VM as a
security boundary for untrusted saved workflows.

### P0 — close host/sandbox realm bridges

Host-created fulfilled values and rejection objects can currently enter the VM
with host prototypes. Structured `agent()` results, journal replays,
`parallel()`/`pipeline()` arrays, nested-workflow results, and caught host errors
must be serialized or otherwise reconstructed in the destination VM realm.

Acceptance criteria:

- No value or error crossing from host to VM exposes host constructors.
- Regression tests cover object results, arrays, journal replay, nested workflows,
  and caught rejections.
- The controlled `value.constructor.constructor("return process")()` probe fails.

### P0 — honor project trust for saved resources

A globally installed extension must not discover, advertise, complete, or execute
project-local `.pi/workflows` or `.pi/agents` while the project is untrusted.
Built-in and user-level resources remain available. Use pi's `CONFIG_DIR_NAME`
instead of hardcoding `.pi`.

### P0 — constrain run IDs and filesystem containment

Validate `runId` and `resumeFromRunId` with a bounded, separator-free grammar.
Every journal, script, worktree, transcript, and finished-run path must also pass
a resolved-path containment check. Add traversal tests for write and read paths.

### P1 — make cancellation a drain barrier

`runWorkflow()` must not settle after abort until active attempts, limiter waiters,
transcript/session finalization, and worktree release have completed. Make queued
work and worktree acquisition abort-aware and test shutdown during active and
queued agents.

### P1 — bound model-visible results

Apply pi's 50 KB / 2000-line output contract to workflow completion and
`workflow_tasks`. Persist full data and return a bounded summary plus path;
validate pagination/tail parameters and cap aggregate per-agent status output.

### P2 — complete inherited extension lifecycle

If child sessions continue to claim extension inheritance, bind extensions so
`session_start`/`resources_discover` run and dispose them through a runtime that
emits `session_shutdown`. Otherwise narrow the documented inheritance contract.

### P2 — remaining hardening and correctness

- Use session `ctx.cwd` for finished-run lookup and completion.
- Propagate invalidation to cached pi conversation components.
- Continue strengthening VM intrinsic isolation and worker-level interruption for
  microtask starvation if the workflow VM is ever promoted to a security boundary.
