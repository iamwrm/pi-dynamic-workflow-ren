import fs from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowAgent, WorkflowAgentSessionPersistence } from "./agent.js";
import { loadAgentTypes, type ResolvedAgentType } from "./agent-types.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  formatTokens,
  type LiveRunHandle,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { generateRunId, readJournalEntries } from "./journal.js";
import {
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentFeed,
  type WorkflowAgentSessionInfo,
  type WorkflowRunControls,
  type WorkflowRunResult,
} from "./workflow.js";
import { findWorkflow, loadWorkflowRegistry, type WorkflowRegistry } from "./workflow-registry.js";

/** Where the live background-run progress widget is placed relative to the editor. */
const LIVE_WIDGET_PLACEMENT = "aboveEditor" as const;

/**
 * A self-contained, crash-proof live UI driver for a single BACKGROUND run.
 *
 * The background (interactive) path returns immediately and keeps running detached,
 * so its per-tool-call `onUpdate` sink is dead. The supported channel for post-return
 * UI is `ctx.ui` (stable for the whole session). This driver renders the run's live
 * progress snapshot into a per-run widget + footer status while it is in flight. On
 * completion the final snapshot is delivered as a fixed `workflow_result` message in
 * the session history, then the transient widget/status are cleared; rejected/aborted
 * runs and session shutdown clear them too.
 *
 * Every `ctx.ui.*` call is wrapped in try/catch: the UI may be torn down mid-run (e.g.
 * a session switch), and a UI failure must never reject the detached run or block the
 * final `sendResult` delivery. The widget/status are keyed uniquely per run so multiple
 * concurrent background runs never clobber each other's panels.
 */
interface LiveBackgroundUi {
  /** The per-run widget/status key (`dynamic-workflow:${runId}`), exposed so the
   * extension can defensively clear it on shutdown without depending on the run's
   * own settle chain. */
  readonly key: string;
  render(snapshot: WorkflowSnapshot, completed?: boolean): void;
  clear(): void;
  notify(message: string, type: "info" | "warning" | "error"): void;
}

function createLiveBackgroundUi(ui: ExtensionContext["ui"] | undefined, runId: string, name: string): LiveBackgroundUi {
  const key = `dynamic-workflow:${runId}`;
  if (!ui) {
    return { key, render() {}, clear() {}, notify() {} };
  }
  let cleared = false;
  return {
    key,
    render(snapshot, completed = false) {
      if (cleared) return;
      const total = snapshot.agentCount;
      const done = snapshot.doneCount;
      const errors = snapshot.errorCount;
      // Count errored agents separately so a run with failures does not read as
      // "N/N agents" (all-succeeded) in the compact footer; mirrors statusLine().
      const summary =
        errors > 0
          ? `${name}: ${done} done, ${errors} failed of ${total} agents`
          : `${name}: ${completed ? "completed " : ""}${done}/${total} agents`;
      try {
        ui.setWidget(key, renderWorkflowText(snapshot, completed).split("\n"), { placement: LIVE_WIDGET_PLACEMENT });
      } catch {
        // UI torn down mid-run; ignore so the detached run keeps making progress.
      }
      try {
        ui.setStatus(key, summary);
      } catch {
        // UI torn down mid-run; ignore.
      }
    },
    clear() {
      if (cleared) return;
      cleared = true;
      try {
        ui.setWidget(key, undefined);
      } catch {
        // UI already gone; nothing to clear.
      }
      try {
        ui.setStatus(key, undefined);
      } catch {
        // UI already gone; nothing to clear.
      }
    },
    notify(message, type) {
      try {
        ui.notify(message, type);
      } catch {
        // A notify failure must never propagate out of the detached run.
      }
    },
  };
}

/**
 * Add exact provider-reported usage from active subagent sessions to a live
 * snapshot. `/workflows` polls getSnapshot() every 400ms, so this pull model
 * needs no extra timer or per-stream-event telemetry churn. Finalized snapshot
 * fields still win once onAgentEnd records the authoritative total.
 */
function withLiveAgentTokens(snapshot: WorkflowSnapshot, controls: WorkflowRunControls | undefined): WorkflowSnapshot {
  if (!controls) return snapshot;
  let changed = false;
  const agents = snapshot.agents.map((agent) => {
    if (agent.status !== "running") return agent;
    try {
      const telemetry = controls.getAgentSession(agent.id)?.getTelemetry?.();
      const tokens = telemetry?.tokens ?? telemetry?.usage?.totalTokens;
      if (typeof tokens !== "number") return agent;
      changed = true;
      return {
        ...agent,
        tokens,
        ...(telemetry?.estimatedTokens ? { estimatedTokens: true } : {}),
      };
    } catch {
      // Live telemetry is advisory; a stale/disposed session must not break UI.
      return agent;
    }
  });
  return changed ? { ...snapshot, agents } : snapshot;
}

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences. Exactly one of script, scriptPath, or name must be provided.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), workflow(name, args), log(message), args, and budget. The workflow must call agent() at least once.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
      ].join(" "),
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path (absolute or cwd-relative) to a workflow script file — e.g. the persisted script file returned by a previous invocation. Exactly one of script, scriptPath, or name.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Name of a saved workflow: built-in (deep-research, code-review), user (~/.pi/agent/workflows/*.js), or project (.pi/workflows/*.js). Exactly one of script, scriptPath, or name.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  autoCompaction: Type.Optional(
    Type.Boolean({
      description:
        "Override automatic compaction for child sessions. Omit to preserve Pi's persisted setting (enabled by default).",
    }),
  ),
  runId: Type.Optional(
    Type.String({ description: "Optional run id to use for a new workflow journal. Generated when omitted." }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({ description: "Optional prior workflow run id whose journal should be replayed before running." }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  autoCompaction?: boolean;
  runId?: string;
  resumeFromRunId?: string;
};

/** Outcome delivered back to the session when a backgrounded run finishes. */
export interface WorkflowBackgroundResult {
  runId: string;
  name: string;
  status: "completed" | "failed" | "aborted";
  /** Text to surface to the model (a completion summary or an error message). */
  text: string;
  /** Structured details mirroring the foreground tool result's `details`. */
  details: Record<string, unknown>;
}

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /**
   * Reads the parent session's current thinking level so subagents inherit it.
   * The tool-execute ctx (ExtensionContext) has no thinking-level accessor; only
   * the `pi` object (ExtensionAPI.getThinkingLevel()) does, so the extension
   * entrypoint closes over `pi` and passes this in. Called at execute() time so
   * it reflects mid-session changes.
   */
  getThinkingLevel?: () => import("@earendil-works/pi-agent-core").ThinkingLevel | undefined;
  /**
   * Deliver a backgrounded run's outcome back to the session (mirrors Claude
   * Code's <task-notification>). The extension entrypoint wires this to
   * pi.sendMessage({...}, { triggerTurn: true }) so the idle model continues.
   * Only ever called on the background (interactive) path.
   */
  sendResult?: (result: WorkflowBackgroundResult) => void;
  /**
   * Compose a shutdown-cancellation signal into each background run so quit /
   * reload / new aborts in-flight subagents. The extension owns an AbortController
   * fired from a session_shutdown handler and returns its signal here. Once the
   * background handoff is accepted, this signal and the run's explicit kill
   * controller own its lifetime; the originating tool signal no longer does.
   */
  getShutdownSignal?: () => AbortSignal | undefined;
  /**
   * Register a detached background run so the extension can track it in a Set and
   * await it during session_shutdown (handlers are awaited before dispose), letting
   * cancellation flush cleanly. The returned promise resolves when the run settles.
   * Only called on the background path.
   */
  trackRun?: (runId: string, settled: Promise<void>) => void;
  /**
   * Register a background run's live-UI cleanup so the extension can defensively clear
   * any still-mounted widget/status on session_shutdown. Given the per-run key + an
   * idempotent clear() callback. Runs clear their own widget/status on settle; this is
   * a shutdown backstop for in-flight or interrupted runs. Only called on the background
   * path.
   */
  registerLiveUi?: (
    runId: string,
    liveUi: { key: string; clear: () => void } & Partial<Omit<LiveRunHandle, "runId">>,
  ) => void;
  /**
   * Test-only seam: inject a fake agent runner so the live background-UI path can be
   * exercised without a real model. Threaded straight into runWorkflow as its `agent`.
   * The extension entrypoint never sets this; production runs spawn real subagents.
   */
  agent?: Pick<WorkflowAgent, "run">;
  /**
   * Test-only seam: override the per-run journal directory so unit tests stay
   * hermetic (no writes under the repo cwd). The extension entrypoint never sets this.
   */
  journalDir?: string;
  /** Override the agent dir used for the workflow/agent-type registries (default: pi's getAgentDir()). */
  agentDir?: string;
  /** Test seam: override script-level model resolution (default: ctx.modelRegistry lookup). */
  resolveModel?: (ref: string) => Model<any> | undefined;
  /** Test seam: override agentType resolution (default: `<agentDir>/agents` + `.pi/agents` registry). */
  resolveAgentType?: (name: string) => ResolvedAgentType | undefined;
  /** Test seam: override the worktree base directory for isolation:'worktree'. */
  worktreeDir?: string;
}

export interface WorkflowGuideOptions {
  /** Working directory used for the project workflow registry. */
  cwd?: string;
  /** Pi agent directory used for the user workflow registry. */
  agentDir?: string;
}

/**
 * Instruction line advertising the saved workflows that exist right now (built-in
 * + user + project), so the model can invoke them directly via {name, args}
 * without the user running /workflows first. The progressive-disclosure loader
 * calls this at execution time, so newly created project/user workflows appear
 * without requiring /reload. Falls back to a static pointer when unavailable.
 */
function savedWorkflowsGuideline(options: WorkflowGuideOptions): string {
  const fallback =
    "For workflow, saved workflows are listed by /workflows; user workflows live in ~/.pi/agent/workflows/*.js and project workflows in .pi/workflows/*.js.";
  try {
    const registry = loadWorkflowRegistry({
      cwd: options.cwd ?? process.cwd(),
      agentDir: options.agentDir ?? safeAgentDir(),
    });
    if (registry.workflows.length === 0) return fallback;
    const entries = registry.workflows
      .map((workflow) => {
        const when = workflow.whenToUse ? ` (when: ${workflow.whenToUse})` : "";
        return `${workflow.name} [${workflow.source}] — ${workflow.description}${when}`;
      })
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .join("; ");
    return `For workflow, these saved workflows exist and can be invoked directly with {name: '<name>', args}: ${entries}. User workflows live in ~/.pi/agent/workflows/*.js and project workflows in .pi/workflows/*.js; /workflows shows the current list.`;
  } catch {
    return fallback;
  }
}

const WORKFLOW_PROMPT_SUMMARY =
  "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }. Saved workflows run via {name}; persisted scripts re-run via {scriptPath}.";

const WORKFLOW_TASKS_PROMPT_SUMMARY =
  "Poll or control live background workflow runs: {action: 'list'}, {action: 'status', runId}, {action: 'kill', runId, agentIds?}.";

export function buildWorkflowPromptGuidelines(options: WorkflowGuideOptions = {}): string[] {
  return [
    "Use workflow when the user explicitly requests a workflow, fan-out, or multi-agent orchestration, or when a substantial task clearly benefits from independent investigations or perspectives followed by synthesis. Do not use it for ordinary single-agent work, conceptual questions, rewriting, or mere mentions of CI, business, or GitHub Actions workflows.",
    "For workflow, pass exactly one of script (raw JavaScript, no Markdown fences or prose), scriptPath (a saved script file), or name (a saved workflow).",
    "For workflow, every invocation persists its effective script to a file under .pi-workflow-runs/<runId>/ and returns the path; to iterate on a workflow, edit that file and re-invoke with {scriptPath: '<path>'} instead of resending the script - add resumeFromRunId to reuse cached agent results.",
    savedWorkflowsGuideline(options),
    "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
    "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date(). Scripts are capped at 524288 bytes.",
    "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(name, args), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
    "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
    "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order. parallel() and pipeline() accept at most 4096 items per call.",
    "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
    "For workflow, workflow(name, args) runs a saved workflow inline and returns its result; nesting is limited to one level (a child workflow cannot call workflow()). It shares the parent's concurrency, agent cap, and token budget.",
    "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
    "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions. Stalled agents (no activity for 3 minutes) are retried up to 5 times before resolving to null.",
    "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
    "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
    "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    "For workflow, subagents inherit the parent session's model and thinking level by default. opts.model overrides the subagent's model for real ('provider/model-id' or a model id known to the session). opts.agentType resolves a named agent definition from ~/.pi/agent/agents/*.md or .pi/agents/*.md (role prompt + optional model/tool allowlist). Unresolvable references fall back to prompt hints and are logged.",
    "For workflow, opts.isolation: 'worktree' runs the agent in a REAL disposable git worktree (detached checkout of the repo). Use it ONLY when agents mutate files in parallel and would conflict - it costs setup time and disk. Unchanged worktrees are auto-removed; changed ones are kept and their paths logged.",
    "For workflow, to resume a previous workflow run, pass its runId as resumeFromRunId; resume invalidation is per-call content-addressed (ordinal + prompt + label + schema + per-agent options), not Claude-Code prefix-based, so thread upstream results into downstream prompts so changing an earlier step forces dependent steps to re-run on resume.",
    "For workflow, in an interactive session the run executes in the BACKGROUND: the tool returns immediately with a runId and status 'running', then delivers the completed result as a follow-up message once it finishes - do not block waiting for it. In non-interactive (-p/print/RPC) mode the tool runs in the foreground and returns the full result synchronously.",
    "For workflow, an accepted background run has an independent cancellation lifetime: aborting a later parent turn does not stop it. Use workflow_tasks {action: 'kill', runId} (or agentIds for selected subagents) when the user asks to stop workflow work.",
  ];
}

export const WORKFLOW_TASKS_PROMPT_GUIDELINES = [
  "Use workflow_tasks when the user asks how a running workflow is doing or wants to stop work: {action: 'list'} summarizes live runs; {action: 'status', runId} returns per-agent ids, statuses, and runningMs grouped by phase; {action: 'kill', runId} aborts the whole run; {action: 'kill', runId, agentIds: [...]} kills specific agents. Do not guess run state - poll it.",
  "For workflow_tasks kill decisions based on criteria (e.g. agents running longer than an hour), call status first and select the agentIds yourself from runningMs/status. Killed agents resolve to null in the script and are NOT journaled, so a later resumeFromRunId re-runs exactly them while completed agents replay from cache.",
] as const;

/** One cohesive, model-visible guide returned by workflow_load on demand. */
export function buildWorkflowGuide(options: WorkflowGuideOptions = {}): string {
  return [
    "Workflow orchestration guidance is loaded for this branch.",
    "",
    `workflow: ${WORKFLOW_PROMPT_SUMMARY}`,
    ...buildWorkflowPromptGuidelines(options).map((line) => `- ${line}`),
    "",
    `workflow_tasks: ${WORKFLOW_TASKS_PROMPT_SUMMARY}`,
    ...WORKFLOW_TASKS_PROMPT_GUIDELINES.map((line) => `- ${line}`),
  ].join("\n");
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "Provide exactly one of: script (raw JavaScript), scriptPath (a saved script file), or name (a saved workflow, e.g. built-in deep-research or code-review).",
      "Scripts must start with export const meta = { name, description, phases? } and must call agent() at least once.",
      "Call workflow_load again if the detailed workflow guide is no longer in context.",
    ].join(" "),
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // The tool-execute ctx is ExtensionContext, which exposes cwd/model/
      // modelRegistry as PROPERTIES (no getModel()/getThinkingLevel() methods —
      // those live on the `pi` ExtensionAPI object, not the execute ctx). Optional
      // chaining keeps unit tests that pass a minimal fake ctx working.
      const ctxAny = ctx as
        | (typeof ctx & {
            model?: unknown;
            modelRegistry?: { getAll(): Array<Model<any>> };
            isProjectTrusted?: () => boolean;
          })
        | undefined;
      const cwd = options.cwd ?? ctxAny?.cwd ?? process.cwd();
      const agentDir = options.agentDir ?? safeAgentDir();

      // Named-workflow registry, shared by `name` resolution and the script-level
      // workflow() nesting primitive. Loaded lazily, at most once per call.
      let registryCache: WorkflowRegistry | undefined;
      const getRegistry = () => {
        registryCache ??= loadWorkflowRegistry({ cwd, agentDir });
        return registryCache;
      };

      const source = resolveScriptSource(params, { cwd, getRegistry });
      const script = source.script;
      const parsed = parseWorkflowScript(script);

      const runId = params.resumeFromRunId ?? params.runId ?? generateRunId();
      // Persist the effective script under the run directory (Claude Code: every
      // invocation persists its script and reports the path) so the model can edit
      // it with Write/Edit and re-invoke via {scriptPath} instead of resending it.
      // scriptPath invocations already have their file; persistence is best-effort.
      const scriptFilePath =
        source.kind === "file"
          ? source.path
          : (persistScriptForRun(script, runId, cwd, options.journalDir) ?? source.path);
      const scriptIterationHint = scriptFilePath
        ? `\nScript file: ${scriptFilePath} (edit it and re-invoke with {scriptPath: "${scriptFilePath}"} to iterate; add resumeFromRunId to reuse cached agents)`
        : "";

      // Persist subagent trajectories + token usage into the SAME pi session
      // storage as the parent session (child sessions linked via parentSession),
      // instead of only the run directory's capped messages.jsonl.
      const sessionPersistence = resolveSessionPersistence(ctxAny?.sessionManager);

      // Inherit the parent session's model so subagents run on the same model.
      const inheritedModel = ctxAny?.model as Model<any> | undefined;
      // Thinking level is read from the `pi` object via the injected accessor,
      // since ExtensionContext has no thinking-level accessor at all.
      const inheritedThinkingLevel = options.getThinkingLevel?.();
      // Child sessions must inherit the parent's trust decision. Falling back to
      // true preserves the standalone SDK behavior when no ExtensionContext exists.
      const inheritedProjectTrusted = ctxAny?.isProjectTrusted?.() ?? true;

      // Script-level option resolvers (real wiring for opts.model / opts.agentType
      // and the workflow() nesting primitive). Test seams take precedence.
      const resolveModel = options.resolveModel ?? ((ref: string) => resolveModelRef(ctxAny?.modelRegistry, ref));
      const agentTypeRegistry = options.resolveAgentType ? undefined : loadAgentTypes({ cwd, agentDir });
      const resolveAgentType =
        options.resolveAgentType ??
        ((name: string) => agentTypeRegistry?.agentTypes.find((agentType) => agentType.name === name));
      const resolveWorkflow = (name: string) => findWorkflow(getRegistry(), name)?.script;
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: true,
        maxAgents: 4,
        maxLogs: 1,
        showResultPreviews: false,
      });

      // `onUpdate` is the per-tool-call streaming sink. It is only meaningful while
      // THIS execute() call is in flight. On the background path the tool returns a
      // "running" result immediately and the run then continues detached; pushing to
      // the now-stale per-call sink afterward is a "deliver/update after the call
      // resolved" surface, so we stop streaming once the immediate result is returned.
      // The real outcome is delivered later via sendResult. The foreground path keeps
      // streaming for its whole lifetime (the call stays in flight until completion).
      let liveStreaming = true;
      // BACKGROUND path only: a per-run live progress widget + footer status driven via
      // ctx.ui (the supported post-return channel, since onUpdate is dead once execute()
      // returns). Stays undefined on the foreground path so that path is untouched.
      let liveWidget: LiveBackgroundUi | undefined;
      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        if (liveStreaming) display.update(snapshot);
        liveWidget?.render(snapshot);
      };

      // Run the parsed-and-validated workflow under `runSignal`, streaming live
      // snapshot updates. Returns the finished tool result, or throws on abort /
      // fatal error. Shared by the foreground and background code paths so the
      // result shape and display behavior stay identical.
      // Live per-agent kill controls for the CURRENT runWorkflow invocation,
      // captured via onRunControls and exposed through registerLiveUi so the
      // workflow_tasks surface can kill specific agents in this run.
      let runControls: WorkflowRunControls | undefined;

      const runWorkflowToResult = async (
        runSignal: AbortSignal | undefined,
        runId: string,
        resumeFromRunId?: string,
      ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
        let result: WorkflowRunResult;
        try {
          result = await runWorkflow(script, {
            cwd,
            args: params.args,
            signal: runSignal,
            runId,
            ...(resumeFromRunId ? { resumeFromRunId } : {}),
            concurrency: options.concurrency,
            model: inheritedModel,
            thinkingLevel: inheritedThinkingLevel,
            projectTrusted: inheritedProjectTrusted,
            ...(params.autoCompaction !== undefined ? { autoCompaction: params.autoCompaction } : {}),
            resolveModel,
            resolveAgentType,
            resolveWorkflow,
            ...(sessionPersistence ? { sessionPersistence } : {}),
            ...(options.worktreeDir ? { worktreeDir: options.worktreeDir } : {}),
            // Test-only injection seams (undefined in production). They let the live
            // background-UI path be exercised with a fake runner + hermetic journal.
            ...(options.agent ? { agent: options.agent } : {}),
            ...(options.journalDir ? { journalDir: options.journalDir } : {}),
            onLog(message) {
              snapshot.logs.push(message);
              update();
            },
            onPhase(title) {
              snapshot.currentPhase = title;
              if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
              update();
            },
            onAgentStart(event) {
              if (runSignal?.aborted) throw new Error("Workflow was aborted");
              snapshot.agents.push({
                id: event.id,
                label: event.label,
                phase: event.phase,
                prompt: event.prompt,
                status: "running",
                startedAtMs: Date.now(),
              });
              update();
            },
            onAgentEnd(event) {
              const agent = [...snapshot.agents]
                .reverse()
                .find((item) => item.id === event.id && item.status === "running");
              if (agent) {
                agent.status = event.killed ? "killed" : event.result === null ? "error" : "done";
                if (event.killed) agent.error = "killed";
                else agent.resultPreview = preview(event.result);
                agent.tokens = event.telemetry?.tokens;
                agent.estimatedTokens = event.telemetry?.estimatedTokens;
                agent.toolCalls = event.telemetry?.toolCalls;
                agent.elapsedMs = event.telemetry?.elapsedMs;
                // Verify at read time: resume replays carry journaled paths whose
                // child session may have been deleted since the original run (pi
                // silently opens a BLANK session at nonexistent --session paths).
                const sessionFile = event.telemetry?.sessionFile;
                if (sessionFile && fs.existsSync(sessionFile)) agent.sessionFile = sessionFile;
              }
              update();
            },
            onRunControls(controls) {
              runControls = controls;
            },
          });
        } catch (error) {
          if (runSignal?.aborted || isAbortError(error)) {
            for (const agent of snapshot.agents) {
              if (agent.status === "running") {
                agent.status = "skipped";
                agent.error = "aborted";
              }
            }
            snapshot = recomputeWorkflowSnapshot(snapshot);
            if (liveStreaming) display.complete(snapshot);
            throw new Error("Workflow was aborted");
          }
          throw error;
        }

        if (result.agentCount === 0) {
          throw new Error(
            "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
          );
        }

        snapshot.result = result.result;
        snapshot.durationMs = result.durationMs;
        snapshot = recomputeWorkflowSnapshot(snapshot);
        if (liveStreaming) display.complete(snapshot);
        liveWidget?.render(snapshot, true);

        return {
          content: [
            {
              type: "text",
              text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\nResume with runId: ${result.runId}${scriptIterationHint}\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
            },
          ],
          details: {
            ...snapshot,
            meta: result.meta,
            phases: result.phases,
            logs: result.logs,
            result: result.result,
            durationMs: result.durationMs,
            spentTokens: result.spentTokens,
            tokenUsage: result.tokenUsage,
            runId: result.runId,
            ...(scriptFilePath ? { scriptPath: scriptFilePath } : {}),
          },
        };
      };

      // BACKGROUND vs FOREGROUND (Claude Code runs workflows in the background and
      // returns a runId immediately). Backgrounding is only safe in the interactive
      // TUI and when the extension wired a sendResult delivery callback. RPC also has
      // ctx.hasUI=true in pi 0.80.6, but its process/session may end before a detached
      // continuation can deliver, so print / JSON / RPC must await foreground.
      const contextMode = (ctx as { mode?: string } | undefined)?.mode;
      // The hasUI fallback keeps older SDK/minimal test contexts working; current
      // pi always supplies mode, so RPC takes the explicit non-TUI branch above.
      const interactiveTui = contextMode === "tui" || (contextMode === undefined && ctx?.hasUI === true);
      const canBackground = interactiveTui && typeof options.sendResult === "function";

      if (canBackground) {
        // A background run becomes an independently owned task when this execute()
        // call returns status "running". Relay the originating tool signal only while
        // the launch is being registered; keeping it composed after return would let
        // an unrelated later parent-turn abort (including a compaction checkpoint)
        // kill already-detached work.
        const shutdownSignal = options.getShutdownSignal?.();
        // Per-run kill controller: lets workflow_tasks / /kill-workflow abort exactly
        // this run while other background runs (and the session) keep going.
        const perRunController = new AbortController();
        const detachOriginSignal = relayAbortUntilDetached(signal, perRunController);
        const signals = [perRunController.signal];
        if (shutdownSignal) signals.push(shutdownSignal);
        const runSignal = AbortSignal.any(signals);

        const sendResult = options.sendResult as (r: WorkflowBackgroundResult) => void;
        // If extension-owned handoff registration itself throws, abort the unowned
        // run and suppress its asynchronous result instead of leaving an orphan.
        let handedOff = false;

        // Live progress UI for the detached run. Keyed per runId so concurrent
        // background runs each own their own widget/status. The run's snapshot
        // callbacks call update(), which renders into this widget.
        // Build an initial empty-snapshot render so the panel appears immediately,
        // before the first agent callback fires.
        liveWidget = createLiveBackgroundUi(ctx?.ui, runId, parsed.meta.name);
        liveWidget.render(snapshot);

        // Detach: run to completion off the tool's turn and deliver on completion,
        // mirroring Claude Code's <task-notification>. Errors are delivered, never
        // thrown out of the detached promise. Each sendResult(...) is wrapped in
        // try/catch so the guarantee is self-contained here, independent of how the
        // extension wires sendResult: a throwing sink can never reject `settled`.
        // Successful runs briefly render their final completed frame, then deliver that
        // same final snapshot as a fixed workflow_result message in the session history
        // and clear the transient widget/status. Rejected/aborted runs clear below, and
        // session_shutdown is an independent backstop.
        const settled = runWorkflowToResult(runSignal, runId, params.resumeFromRunId).then(
          (finished) => {
            if (!handedOff) {
              liveWidget?.clear();
              return;
            }
            const status: WorkflowBackgroundResult["status"] = "completed";
            // No completion toast: sendResult below posts the outcome as a
            // workflow_result message (the user-facing surface). That fixed transcript
            // message is what remains after completion; the live widget is only for
            // in-flight progress.
            try {
              sendResult({
                runId,
                name: parsed.meta.name,
                status,
                text: finished.content[0]?.text ?? `Workflow ${parsed.meta.name} (runId ${runId}) completed.`,
                details: { ...finished.details, status },
              });
            } catch {
              // A throwing delivery sink (e.g. stale runner) is unrecoverable here;
              // swallow so the detached promise cannot reject.
            }
            liveWidget?.clear();
          },
          (error: unknown) => {
            if (!handedOff) {
              liveWidget?.clear();
              return;
            }
            const aborted = runSignal?.aborted || isAbortError(error);
            const status: WorkflowBackgroundResult["status"] = aborted ? "aborted" : "failed";
            const message = error instanceof Error ? error.message : String(error);
            // Suppress the failure/abort toast when the abort is shutdown-driven:
            // on quit/reload the UI is being torn down and every in-flight run would
            // otherwise fire a warning toast on a dying UI (N runs => N toasts).
            // A genuine user-visible failure (run signal not shutdown-fired) still
            // notifies. Clear failed/aborted transient UI.
            liveWidget?.clear();
            const shutdownDriven = options.getShutdownSignal?.()?.aborted === true;
            if (!shutdownDriven) {
              liveWidget?.notify(`workflow ${parsed.meta.name} ${aborted ? "aborted" : "failed"}`, "warning");
            }
            try {
              sendResult({
                runId,
                name: parsed.meta.name,
                status,
                text: aborted
                  ? `Workflow ${parsed.meta.name} (runId ${runId}) was aborted.`
                  : `Workflow ${parsed.meta.name} (runId ${runId}) failed: ${message}`,
                details: { runId, name: parsed.meta.name, status, error: message },
              });
            } catch {
              // A throwing delivery sink is unrecoverable here; swallow so the
              // detached promise cannot reject.
            }
          },
        );
        try {
          // Track the settled promise so session_shutdown can await it (after firing
          // the shutdown signal) and let cancellation flush before dispose.
          options.trackRun?.(runId, settled);
          // Register this run's clear() so the extension can defensively clear the
          // widget/status on shutdown (clear() is idempotent), plus name/getSnapshot
          // so /workflows can list live runs with their current progress.
          const widgetToClear = liveWidget;
          options.registerLiveUi?.(runId, {
            key: widgetToClear.key,
            clear: () => widgetToClear.clear(),
            name: parsed.meta.name,
            getSnapshot: () => withLiveAgentTokens(snapshot, runControls),
            startedAtMs: Date.now(),
            killRun: () => perRunController.abort(),
            killAgents: (ids) =>
              runControls
                ? runControls.killAgents(ids)
                : ids.map((id) => ({ id, killed: false, reason: "run not started" })),
            getAgentFeed: (id) => runControls?.getAgentFeed(id),
            getAgentSession: (id) => runControls?.getAgentSession(id),
          });
          handedOff = true;
        } catch (error) {
          perRunController.abort(error);
          liveWidget.clear();
          throw error;
        } finally {
          // This is the ownership boundary: after successful registration, only
          // workflow-specific kill and session shutdown can cancel the detached run.
          detachOriginSignal();
        }

        // The immediate result is being returned now; stop streaming to the per-call
        // onUpdate sink so the detached run's later callbacks do not push updates to
        // a resolved tool call. The detached run remains bounded by its per-run and
        // session-shutdown signals and delivers its outcome via sendResult.
        liveStreaming = false;

        return {
          content: [
            {
              type: "text",
              text: `Workflow ${parsed.meta.name} started in background (runId ${runId}). You'll be notified on completion. To abort it, use workflow_tasks { action: "kill", runId: "${runId}" }; the user can run /kill-workflow ${runId}.${scriptFilePath ? ` Script file: ${scriptFilePath}` : ""}`,
            },
          ],
          details: {
            runId,
            name: parsed.meta.name,
            status: "running",
            ...(scriptFilePath ? { scriptPath: scriptFilePath } : {}),
          },
        };
      }

      // Foreground: await to completion and return the full result. This is the only
      // safe path in -p / print / RPC mode (results are never lost) and is also used
      // whenever no interactive background delivery is wired.
      return runWorkflowToResult(signal, runId, params.resumeFromRunId);
    },
    renderCall(args, theme) {
      // Show the generated workflow JS so the user can review it while the run
      // proceeds. This renders BEFORE renderResult and the live progress widget,
      // and persists in the transcript. Must be total: never throw.
      const input = args as { script?: unknown; scriptPath?: unknown; name?: unknown } | undefined;
      const script = input?.script;
      // Guard on the script AFTER normalization so a script that is empty once its
      // Markdown fence is stripped (e.g. "```js\n\n```") falls back to the plain
      // title instead of rendering a "generated script" header with an empty body.
      const normalized = typeof script === "string" ? normalizeWorkflowScript(script) : "";
      if (normalized.length > 0) {
        const block = formatWorkflowScriptForDisplay(normalized);
        const headerEnd = block.indexOf("\n");
        if (headerEnd === -1) {
          // Defensive: a header-only block (no body lines). Not reachable from a
          // non-empty normalized script today, but kept as a safe fallback.
          return new Text(theme.fg("toolTitle", theme.bold(block)), 0, 0);
        }
        const header = theme.fg("toolTitle", theme.bold(block.slice(0, headerEnd)));
        const body = theme.fg("muted", block.slice(headerEnd + 1));
        return new Text(`${header}\n${body}`, 0, 0);
      }
      // Saved-workflow / script-file invocations have no inline script to show.
      if (typeof input?.name === "string" && input.name.trim().length > 0) {
        return new Text(theme.fg("toolTitle", theme.bold(`workflow — saved workflow: ${input.name.trim()}`)), 0, 0);
      }
      if (typeof input?.scriptPath === "string" && input.scriptPath.trim().length > 0) {
        return new Text(theme.fg("toolTitle", theme.bold(`workflow — script file: ${input.scriptPath.trim()}`)), 0, 0);
      }
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") {
    throw new Error("workflow requires an object argument with exactly one of `script`, `scriptPath`, or `name`");
  }
  const value = args as Record<string, unknown>;
  const provided = (["script", "scriptPath", "name"] as const).filter((key) => value[key] !== undefined);
  if (provided.length !== 1) {
    throw new Error("workflow requires exactly one of `script`, `scriptPath`, or `name`");
  }
  for (const key of provided) {
    if (typeof value[key] !== "string") throw new Error(`workflow \`${key}\` must be a string`);
  }
  if (value.autoCompaction !== undefined && typeof value.autoCompaction !== "boolean") {
    throw new Error("workflow `autoCompaction` must be a boolean when provided");
  }
  if (value.runId !== undefined && typeof value.runId !== "string") {
    throw new Error("workflow `runId` must be a string when provided");
  }
  if (value.resumeFromRunId !== undefined && typeof value.resumeFromRunId !== "string") {
    throw new Error("workflow `resumeFromRunId` must be a string when provided");
  }
  if (
    typeof value.runId === "string" &&
    typeof value.resumeFromRunId === "string" &&
    value.runId !== value.resumeFromRunId
  ) {
    throw new Error("workflow `runId` and `resumeFromRunId` must match when both are provided");
  }
  return {
    ...value,
    ...(typeof value.script === "string" ? { script: normalizeWorkflowScript(value.script) } : {}),
  } as WorkflowToolInput;
}

/** Max number of script lines shown in the renderCall review block before truncating (Claude Code: 400). */
const MAX_DISPLAY_SCRIPT_LINES = 400;

/**
 * Build a readable, themeable display block for the generated workflow script so the
 * user can review it in the tool call (above the live progress widget). PURE and total:
 * never throws, even on malformed scripts.
 *
 * The first line is a header (`workflow — generated script`, optionally including the
 * parsed meta.name when it can be read). Each subsequent line is the normalized script
 * (Markdown fences stripped) with a subtle `│ ` gutter. The full script is shown by
 * default; only very long scripts (> MAX_DISPLAY_SCRIPT_LINES) are truncated with a
 * trailing `… (N more lines)` note to avoid an unbounded panel. Trailing whitespace is
 * trimmed.
 */
export function formatWorkflowScriptForDisplay(script: string): string {
  const normalized = normalizeWorkflowScript(script);

  // Best-effort meta.name for a friendlier header; parseWorkflowScript THROWS on
  // invalid scripts, so guard it and fall back to the generic header.
  let header = "workflow — generated script";
  try {
    const name = parseWorkflowScript(normalized).meta.name;
    if (typeof name === "string" && name.trim().length > 0) {
      header = `workflow — generated script: ${name.trim()}`;
    }
  } catch {
    // Invalid / partial script: keep the generic header.
  }

  const rawLines = normalized.split("\n");
  const truncated = rawLines.length > MAX_DISPLAY_SCRIPT_LINES;
  const shown = truncated ? rawLines.slice(0, MAX_DISPLAY_SCRIPT_LINES) : rawLines;
  const gutterLines = shown.map((line) => `│ ${line}`.replace(/\s+$/, ""));
  if (truncated) {
    gutterLines.push(`… (${rawLines.length - MAX_DISPLAY_SCRIPT_LINES} more lines)`);
  }

  return [header, ...gutterLines].join("\n").replace(/\s+$/, "");
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

/**
 * Relay a parent tool abort only until a background run crosses its explicit
 * ownership handoff. AbortSignal.any() cannot remove one source later, so use a
 * removable listener to keep launch cancellation without coupling the detached
 * run to every future abort of the originating parent turn.
 */
function relayAbortUntilDetached(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const relay = () => target.abort(source.reason);
  if (source.aborted) {
    relay();
    return () => {};
  }
  source.addEventListener("abort", relay, { once: true });
  return () => source.removeEventListener("abort", relay);
}

/** getAgentDir() touches the environment; never let it break tool execution. */
/** Live-run accessor for createWorkflowTasksTool (the extension wires its live-run map in). */
export interface WorkflowTasksSource {
  listRuns(): LiveRunHandle[];
  /** Base directory holding per-run journals, for finished-run transcript lookups. */
  runsDir?: () => string;
}

const workflowTasksSchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("kill")], {
    description:
      "list: summarize all live runs; status: per-agent detail for one run; kill: abort a whole run or specific agents",
  }),
  runId: Type.Optional(Type.String({ description: "Target run id; may be omitted when exactly one run is live" })),
  agentIds: Type.Optional(
    Type.Array(Type.Number(), { description: "kill only: agent ids from status; omit to kill the whole run" }),
  ),
  logTail: Type.Optional(Type.Number({ description: "status only: recent log lines to include (default 5)" })),
  feedTail: Type.Optional(
    Type.Number({
      description:
        "status only: per-agent activity-feed lines to include (default 0, max 200); each agent also reports its full transcript path",
    }),
  ),
});

type WorkflowTasksParams = {
  action: "list" | "status" | "kill";
  runId?: string;
  agentIds?: number[];
  logTail?: number;
  feedTail?: number;
};

type LiveRunEntry = ReturnType<WorkflowTasksSource["listRuns"]>[number];

/**
 * Model-visible registry for LIVE background workflow runs — the rencc analog of
 * Claude Code's `local_workflow` task registry, with per-agent granularity: the
 * model can count running agents, inspect any agent's status/runningMs by phase,
 * and kill a whole run or individual agents (ids from `status`).
 */
export function createWorkflowTasksTool(source: WorkflowTasksSource): ToolDefinition<typeof workflowTasksSchema, any> {
  return defineTool({
    name: "workflow_tasks",
    label: "Workflow tasks",
    description:
      "Inspect and control LIVE background workflow runs: list run summaries, get per-agent status (ids, phases, live runningMs), and kill a whole run or specific agents by id. Call workflow_load again if the detailed workflow guide is no longer in context.",
    parameters: workflowTasksSchema,
    async execute(_toolCallId, params) {
      const payload = workflowTasksPayload(source.listRuns(), params as WorkflowTasksParams, (runId) =>
        finishedRunTranscripts(source, runId),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload as Record<string, unknown>,
      };
    },
  });
}

function workflowTasksPayload(
  runs: LiveRunEntry[],
  params: WorkflowTasksParams,
  finishedRunStatus: (runId: string) => Record<string, unknown> | undefined = () => undefined,
): Record<string, unknown> {
  const now = Date.now();
  if (params.action === "list") {
    return {
      liveRuns: runs.map((run) => runSummary(run, now)),
      ...(runs.length === 0
        ? { note: "No live workflow runs. Finished runs are resumable via resumeFromRunId (see /workflows)." }
        : {}),
    };
  }
  const resolved = resolveLiveRun(runs, params.runId);
  if (!resolved.ok) {
    // A status request for a finished (non-live) run can still report its
    // persisted per-agent transcripts so post-mortems do not need a live run.
    if (params.action === "status" && params.runId) {
      const finished = finishedRunStatus(params.runId);
      if (finished) return finished;
    }
    return resolved.error;
  }
  const run = resolved.run;
  if (params.action === "status") {
    const snapshot = run.getSnapshot?.();
    if (!snapshot) return { error: `run ${run.runId} exposes no live snapshot` };
    const logTail = Math.max(0, params.logTail ?? 5);
    const feedTail = Math.min(200, Math.max(0, params.feedTail ?? 0));
    return {
      ...runSummary(run, now),
      phases: groupAgentsByPhase(
        snapshot,
        now,
        (id) => run.getAgentFeed?.(id),
        feedTail,
        (id) => run.getAgentSession?.(id),
      ),
      logs: logTail > 0 ? snapshot.logs.slice(-logTail) : [],
    };
  }
  if (params.agentIds && params.agentIds.length > 0) {
    if (!run.killAgents) return { error: `run ${run.runId} does not expose per-agent kill` };
    return { runId: run.runId, killedAgents: run.killAgents(params.agentIds) };
  }
  if (!run.killRun) return { error: `run ${run.runId} does not expose kill` };
  run.killRun();
  return {
    runId: run.runId,
    killedRun: true,
    note: "Run aborted. Completed agents stay journaled; re-run with resumeFromRunId to reuse them.",
  };
}

type ResolvedLiveRun = { ok: true; run: LiveRunEntry } | { ok: false; error: Record<string, unknown> };

function resolveLiveRun(runs: LiveRunEntry[], runId?: string): ResolvedLiveRun {
  if (runId) {
    const run = runs.find((entry) => entry.runId === runId);
    if (!run)
      return { ok: false, error: { error: `no live run ${runId}`, liveRunIds: runs.map((entry) => entry.runId) } };
    return { ok: true, run };
  }
  if (runs.length === 1) return { ok: true, run: runs[0] };
  return {
    ok: false,
    error: {
      error: runs.length === 0 ? "no live workflow runs" : "multiple live runs; pass runId",
      liveRunIds: runs.map((entry) => entry.runId),
    },
  };
}

function runSummary(run: LiveRunEntry, now: number): Record<string, unknown> {
  const snapshot = run.getSnapshot?.();
  const spentTokens = snapshot?.agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0) ?? 0;
  return {
    runId: run.runId,
    name: run.name,
    ...(snapshot?.currentPhase ? { phase: snapshot.currentPhase } : {}),
    ...(snapshot
      ? {
          agents: snapshot.agentCount,
          running: snapshot.runningCount,
          queued: snapshot.agents.filter((agent) => agent.status === "queued").length,
          done: snapshot.doneCount,
          failed: snapshot.errorCount,
        }
      : {}),
    ...(spentTokens > 0 ? { spentTokens: `${formatTokens(spentTokens)} tok` } : {}),
    ...(typeof run.startedAtMs === "number" ? { elapsedMs: now - run.startedAtMs } : {}),
  };
}

function groupAgentsByPhase(
  snapshot: WorkflowSnapshot,
  now: number,
  getFeed: (id: number) => WorkflowAgentFeed | undefined = () => undefined,
  feedTail = 0,
  getSession: (id: number) => WorkflowAgentSessionInfo | undefined = () => undefined,
): Array<Record<string, unknown>> {
  const order: string[] = [];
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const agent of snapshot.agents) {
    const phase = agent.phase ?? "(no phase)";
    if (!groups.has(phase)) {
      groups.set(phase, []);
      order.push(phase);
    }
    groups.get(phase)?.push(agentStatusEntry(agent, now, getFeed(agent.id), feedTail, getSession(agent.id)));
  }
  return order.map((title) => ({ title, agents: groups.get(title) ?? [] }));
}

function agentStatusEntry(
  agent: WorkflowAgentSnapshot,
  now: number,
  feed?: WorkflowAgentFeed,
  feedTail = 0,
  session?: WorkflowAgentSessionInfo,
): Record<string, unknown> {
  // Persisted pi child session for this agent: live handles report it first;
  // finished/replayed agents carry it in their telemetry-backed snapshot.
  const sessionPath = session?.sessionFile ?? agent.sessionFile;
  return {
    id: agent.id,
    label: agent.label,
    status: agent.status,
    ...(agent.status === "running" && typeof agent.startedAtMs === "number"
      ? { runningMs: now - agent.startedAtMs }
      : {}),
    ...(typeof agent.tokens === "number" ? { tokens: agent.tokens } : {}),
    ...(typeof agent.toolCalls === "number" ? { toolCalls: agent.toolCalls } : {}),
    ...(typeof agent.elapsedMs === "number" ? { elapsedMs: agent.elapsedMs } : {}),
    ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
    ...(agent.error ? { error: agent.error } : {}),
    ...(feed?.transcriptPath ? { transcript: feed.transcriptPath } : {}),
    ...(session?.messagesPath ? { messages: session.messagesPath } : {}),
    ...(sessionPath ? { session: sessionPath } : {}),
    ...(feed && feedTail > 0 ? { feed: feed.lines.slice(-feedTail) } : {}),
    ...(feed && feedTail > 0 && feed.liveText ? { liveText: feed.liveText.slice(-300) } : {}),
  };
}

/**
 * Post-mortem fallback for `status` on a finished run: report the persisted
 * per-agent transcript files from the run directory, when they exist.
 */
function finishedRunTranscripts(source: WorkflowTasksSource, runId: string): Record<string, unknown> | undefined {
  const baseDir = source.runsDir?.();
  if (!baseDir) return undefined;
  const agentsDir = path.join(baseDir, runId, "agents");
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  const sessions = journaledSessionFiles(path.join(baseDir, runId, "journal.jsonl"));
  return {
    runId,
    live: false,
    note: "Run is no longer live. Per-agent transcripts persist below; read them with the read tool. Subagent pi sessions (when present) open with `pi --session <path>`. Resume with resumeFromRunId to reuse journaled agents.",
    transcripts: entries.sort().map((name) => path.join(agentsDir, name)),
    ...(sessions.length > 0 ? { sessions } : {}),
  };
}

/**
 * Persisted pi child session files recorded in a finished run's journal
 * telemetry (deduped, journal order), filtered to files that STILL exist —
 * a deleted child session must not be reported (pi silently opens a blank
 * session at nonexistent --session paths). Unreadable journals yield [].
 */
function journaledSessionFiles(journalPath: string): string[] {
  const sessions = new Set<string>();
  for (const entry of readJournalEntries(journalPath)) {
    const sessionFile = entry.telemetry?.sessionFile;
    if (sessionFile && fs.existsSync(sessionFile)) sessions.add(sessionFile);
  }
  return [...sessions];
}

function safeAgentDir(): string | undefined {
  try {
    return getAgentDir();
  } catch {
    return undefined;
  }
}

/** Env kill switch for persisting subagent sessions into pi session storage. */
const SUBAGENT_SESSIONS_ENV = "PI_WORKFLOW_SUBAGENT_SESSIONS";

/**
 * Derive subagent session persistence from the parent session's storage.
 * Subagents then persist as REAL pi child sessions (header.parentSession → the
 * parent's file) in the parent's session dir, so their trajectories and token
 * usage live in the same pi session storage and open with `pi --session <path>`.
 * Requires a PERSISTED parent — an in-memory parent (unit tests, SDK embedders
 * without storage) keeps the previous in-memory subagent behavior — and can be
 * disabled with PI_WORKFLOW_SUBAGENT_SESSIONS=0|false|off. Exported for tests.
 */
export function resolveSessionPersistence(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionFile"> | undefined,
): WorkflowAgentSessionPersistence | undefined {
  const flag = (process.env[SUBAGENT_SESSIONS_ENV] ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return undefined;
  try {
    const parentSessionFile = sessionManager?.getSessionFile();
    const sessionDir = sessionManager?.getSessionDir();
    if (!parentSessionFile || !sessionDir) return undefined;
    return { sessionDir, parentSessionFile };
  } catch {
    // A throwing accessor (torn-down or fake ctx) must never break tool execution.
    return undefined;
  }
}

interface ResolvedScriptSource {
  script: string;
  kind: "inline" | "file" | "named";
  /** Source file for `file`/`named` kinds (built-ins have none). */
  path?: string;
}

/** Resolve the exactly-one-of script/scriptPath/name input to an effective script. */
function resolveScriptSource(
  params: WorkflowToolInput,
  env: { cwd: string; getRegistry: () => WorkflowRegistry },
): ResolvedScriptSource {
  if (params.script !== undefined) {
    return { script: normalizeWorkflowScript(params.script), kind: "inline" };
  }
  if (params.scriptPath !== undefined) {
    const raw = params.scriptPath.trim();
    if (!raw) throw new Error("workflow `scriptPath` must be a non-empty path");
    if (raw.startsWith("\\\\")) {
      throw new Error("workflow `scriptPath` must be a local path (UNC paths are not supported)");
    }
    const full = path.isAbsolute(raw) ? raw : path.resolve(env.cwd, raw);
    let content: string;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch (error) {
      throw new Error(
        `workflow scriptPath could not be read: ${full} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return { script: normalizeWorkflowScript(content), kind: "file", path: full };
  }
  const name = (params.name ?? "").trim();
  const registry = env.getRegistry();
  const entry = findWorkflow(registry, name);
  if (!entry) {
    const known = registry.workflows.map((workflow) => workflow.name).join(", ") || "(none)";
    throw new Error(`unknown workflow name '${name}'. Known workflows: ${known}`);
  }
  return { script: entry.script, kind: "named", path: entry.path };
}

/**
 * Persist the effective script under the run's journal directory
 * (`<journalBase>/<runId>/workflow.js`). Best-effort: a persistence failure must
 * never block the run, so errors return undefined instead of throwing.
 */
function persistScriptForRun(script: string, runId: string, cwd: string, journalDir?: string): string | undefined {
  try {
    const base = journalDir ?? path.join(cwd, ".pi-workflow-runs");
    const dir = path.join(base, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "workflow.js");
    fs.writeFileSync(file, script.endsWith("\n") ? script : `${script}\n`);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a script-level model reference against the session's ModelRegistry.
 * Accepts 'provider/model-id' or a bare model id (exact match first, then
 * case-insensitive). Returns undefined when the registry is unavailable or the
 * reference does not match — the runtime then logs and keeps the session model.
 */
function resolveModelRef(registry: { getAll(): Array<Model<any>> } | undefined, ref: string): Model<any> | undefined {
  if (!registry) return undefined;
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  let all: Array<Model<any>>;
  try {
    all = registry.getAll();
  } catch {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    const exact = all.find((model) => model.provider === provider && model.id === id);
    if (exact) return exact;
  }
  return (
    all.find((model) => model.id === trimmed) ?? all.find((model) => model.id.toLowerCase() === trimmed.toLowerCase())
  );
}
