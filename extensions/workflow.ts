import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  buildWorkflowGuide,
  createWorkflowTasksTool,
  createWorkflowTool,
  formatDuration,
  formatTokens,
  type LiveRunHandle,
  loadWorkflowRegistry,
  parseRunWorkflowInput,
  renderWorkflowText,
  WorkflowInspector,
  type WorkflowSnapshot,
} from "../src/index.js";

export const WORKFLOW_LOAD_TOOL_NAME = "workflow_load";
export const WORKFLOW_TOOLS_LOADED_ENTRY = "pi-dynamic-workflow-rencc:tools-loaded";
export const WORKFLOW_GUIDE_MESSAGE_TYPE = "workflow_guide";

const MANAGED_WORKFLOW_TOOL_NAMES = ["workflow", "workflow_tasks"] as const;
const WORKFLOW_LOAD_DESCRIPTION =
  "Load workflow orchestration tools. Call this first when the user explicitly requests a workflow, saved workflow, multi-agent/subagent delegation, separate agents, or parallel fan-out/fan-in; or when a substantial task needs independent investigations or perspectives followed by synthesis, such as a multi-perspective review, competing-hypothesis analysis, or cross-functional dependency plan. Do not call it for ordinary single-agent work, conceptual questions, rewriting, or mere mentions of CI, business, or GitHub Actions workflows.";

type WorkflowResultDetails = Partial<WorkflowSnapshot> & {
  runId?: string;
  name?: string;
  status?: "completed" | "failed" | "aborted";
  agentCount?: number;
  doneCount?: number;
  errorCount?: number;
  durationMs?: number;
  spentTokens?: number;
  error?: string;
  meta?: { name?: string };
};

export default function extension(pi: ExtensionAPI) {
  // Extension-owned shutdown controller. Accepted background runs are independent
  // of their originating parent-turn signal and compose this lifecycle signal so
  // quit / reload / new aborts their in-flight subagents (the handler below is
  // awaited before session.dispose(), so cancellation lands cleanly).
  let shutdownController = new AbortController();
  // Detached background runs in flight, keyed by runId. session_shutdown awaits
  // these (after firing the shutdown signal) so cancellation flushes before dispose.
  const pending = new Map<string, Promise<void>>();
  // Live-UI clear callbacks for mounted background-run widgets, keyed by runId.
  // Each run clears its own transient widget/status when it settles; this map is a
  // shutdown backstop for in-flight/interrupted runs and self-removes on settle.
  const liveUiClears = new Map<string, () => void>();
  // Live background runs for /workflows, /kill-workflow, and the workflow_tasks
  // tool, keyed by runId. Self-removes on settle.
  const liveRuns = new Map<string, Omit<LiveRunHandle, "runId">>();

  pi.registerMessageRenderer<WorkflowResultDetails>("workflow_result", (message, { expanded }, theme) => {
    const details = message.details;
    const status = details?.status ?? "completed";
    const name = details?.name ?? details?.meta?.name ?? "workflow";
    const statusColor = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
    const statusIcon = status === "completed" ? "✓" : status === "failed" ? "✗" : "-";
    const summary = `${statusIcon} Workflow ${name} ${status}${details?.runId ? ` (${details.runId})` : ""}`;
    const stats = [
      typeof details?.agentCount === "number" ? `${details.doneCount ?? 0}/${details.agentCount} agents` : undefined,
      typeof details?.errorCount === "number" && details.errorCount > 0 ? `${details.errorCount} failed` : undefined,
      typeof details?.spentTokens === "number" ? `${formatTokens(details.spentTokens)} tok` : undefined,
      typeof details?.durationMs === "number" ? formatDuration(details.durationMs) : undefined,
    ].filter(Boolean);

    const snapshot = workflowSnapshotFromDetails(details);
    const workflowPanel = snapshot ? renderWorkflowText(snapshot, status === "completed") : undefined;
    const errorLine = typeof details?.error === "string" ? theme.fg("error", `  ${details.error}`) : undefined;

    const body = [
      theme.fg(statusColor, summary),
      stats.length ? theme.fg("dim", `  ${stats.join(" · ")}`) : undefined,
      workflowPanel,
      !workflowPanel ? errorLine : undefined,
      expanded ? workflowResultText(message.content) : theme.fg("dim", "  Press Ctrl+O to expand workflow result"),
    ].filter(Boolean);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(body.join("\n"), 0, 0));
    return box;
  });

  const workflowTool = createWorkflowTool({
    // ExtensionContext (the tool-execute ctx) has no thinking-level accessor; only
    // the `pi` ExtensionAPI exposes getThinkingLevel(). Close over `pi` so subagents
    // can inherit the parent session's live thinking level.
    getThinkingLevel: () => pi.getThinkingLevel(),

    // Compose the shutdown signal into each background run.
    getShutdownSignal: () => shutdownController.signal,

    // Track each detached run so shutdown can await it. Self-removes on settle.
    trackRun: (runId, settled) => {
      pending.set(runId, settled);
      void settled.finally(() => pending.delete(runId));
    },

    // Track each run's live-UI clear() so shutdown can defensively clear any still-
    // mounted widget/status, plus its name/snapshot accessor so /workflows can list
    // live runs. Self-removes when the run settles (the run clears itself first;
    // this map just keeps a backstop for the shutdown path).
    registerLiveUi: (runId, liveUi) => {
      liveUiClears.set(runId, liveUi.clear);
      liveRuns.set(runId, {
        name: liveUi.name ?? "workflow",
        getSnapshot: liveUi.getSnapshot,
        startedAtMs: liveUi.startedAtMs,
        killRun: liveUi.killRun,
        killAgents: liveUi.killAgents,
        getAgentFeed: liveUi.getAgentFeed,
        getAgentSession: liveUi.getAgentSession,
      });
      const settled = pending.get(runId);
      void settled?.finally(() => {
        liveUiClears.delete(runId);
        liveRuns.delete(runId);
      });
    },

    // Deliver a backgrounded run's outcome back to the session (Claude Code's
    // <task-notification>). triggerTurn:true makes the idle model continue; the
    // call is fire-and-forget and may throw if the runner went stale after a
    // session switch, so guard it.
    sendResult: (result) => {
      try {
        pi.sendMessage(
          {
            customType: "workflow_result",
            content: [{ type: "text", text: result.text }],
            display: true,
            details: result.details,
          },
          { triggerTurn: true },
        );
      } catch {
        // Runner stale (e.g. session was switched/disposed before delivery). The
        // result is unrecoverable here; dropping it is the only safe option.
      }
    },
  });

  // Model-visible live-run registry (list/status/kill), backed by the same
  // self-cleaning liveRuns map that /workflows and /kill-workflow use.
  const workflowTasksTool = createWorkflowTasksTool({
    listRuns: () => [...liveRuns.entries()].map(([runId, run]) => ({ runId, ...run })),
    runsDir: () => path.join(process.cwd(), ".pi-workflow-runs"),
  });

  const uniqueToolNames = (names: readonly string[]): string[] => [...new Set(names)];
  const sameToolNames = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((name, index) => name === right[index]);
  const isManagedWorkflowTool = (name: string): boolean =>
    MANAGED_WORKFLOW_TOOL_NAMES.includes(name as (typeof MANAGED_WORKFLOW_TOOL_NAMES)[number]);
  const availableManagedTools = (): string[] => {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    return MANAGED_WORKFLOW_TOOL_NAMES.filter((name) => available.has(name));
  };
  const branchHasLoadedMarker = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === WORKFLOW_TOOLS_LOADED_ENTRY);
    } catch {
      // A missing/unreadable branch must fail closed: keep only the bootstrap
      // tool rather than leaking the full schemas and guide into a fresh branch.
      return false;
    }
  };
  const workflowGuide = (cwd: string): string => buildWorkflowGuide({ cwd, agentDir: tryGetAgentDir() });

  type WorkflowActivation = {
    addedTools: string[];
    loadedTools: string[];
    unavailableTools: string[];
    workflowLoaded: boolean;
    fullyLoaded: boolean;
    markedNow: boolean;
  };

  const workflowGuideForActivation = (cwd: string, activation: WorkflowActivation): string => {
    if (activation.fullyLoaded) return workflowGuide(cwd);
    return [
      workflowGuide(cwd),
      "",
      `Availability note: ${activation.unavailableTools.join(", ")} is excluded by Pi's tool configuration.`,
      "The core workflow tool is loaded; unavailable optional tools cannot be called.",
    ].join("\n");
  };

  const activateWorkflowTools = (ctx: ExtensionContext): WorkflowActivation => {
    const before = pi.getActiveTools();
    const available = availableManagedTools();
    const desired = uniqueToolNames([...before, ...available]);
    if (!sameToolNames(before, desired)) pi.setActiveTools(desired);

    // Re-read after setActiveTools(): Pi silently ignores tools excluded by
    // --tools/--exclude-tools, so requested names are not proof of activation.
    const after = pi.getActiveTools();
    const loadedTools = MANAGED_WORKFLOW_TOOL_NAMES.filter((name) => after.includes(name));
    const unavailableTools = MANAGED_WORKFLOW_TOOL_NAMES.filter((name) => !after.includes(name));
    const workflowLoaded = loadedTools.includes(MANAGED_WORKFLOW_TOOL_NAMES[0]);
    const fullyLoaded = unavailableTools.length === 0;
    let markedNow = false;
    // workflow_tasks is optional under an explicit Pi tool filter. Persist once
    // the core execution tool is usable; a future unfiltered reload restores
    // every then-available managed tool from the same branch marker.
    if (workflowLoaded && !branchHasLoadedMarker(ctx)) {
      pi.appendEntry(WORKFLOW_TOOLS_LOADED_ENTRY, { version: 1 });
      markedNow = true;
    }
    return {
      addedTools: loadedTools.filter((name) => !before.includes(name)),
      loadedTools,
      unavailableTools,
      workflowLoaded,
      fullyLoaded,
      markedNow,
    };
  };

  const reconcileWorkflowTools = (ctx: ExtensionContext): void => {
    const active = pi.getActiveTools();
    // Respect an explicit --tools/--exclude-tools choice that omits the loader.
    // In that case this extension does not manage the caller's active tool set.
    if (!active.includes(WORKFLOW_LOAD_TOOL_NAME)) return;

    const available = availableManagedTools();
    const availableSet = new Set(available);
    const desired = branchHasLoadedMarker(ctx)
      ? uniqueToolNames([
          ...active.filter((name) => !isManagedWorkflowTool(name) || availableSet.has(name)),
          ...available,
        ])
      : active.filter((name) => !isManagedWorkflowTool(name));
    if (!sameToolNames(active, desired)) pi.setActiveTools(desired);
  };

  const workflowLoadParameters = Type.Object({}, { additionalProperties: false });
  const workflowLoadTool: ToolDefinition<typeof workflowLoadParameters, WorkflowActivation> = {
    name: WORKFLOW_LOAD_TOOL_NAME,
    label: "Load workflow tools",
    description: WORKFLOW_LOAD_DESCRIPTION,
    parameters: workflowLoadParameters,
    executionMode: "sequential" as const,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const activation = activateWorkflowTools(ctx);
      if (!activation.workflowLoaded) {
        const text = [
          "The core workflow orchestration tool could not be loaded.",
          `Unavailable: ${activation.unavailableTools.join(", ") || "unknown"}.`,
          "The missing tools may be excluded by Pi's --tools or --exclude-tools configuration.",
        ].join(" ");
        return { content: [{ type: "text" as const, text }], details: activation };
      }
      return {
        content: [{ type: "text" as const, text: workflowGuideForActivation(ctx.cwd, activation) }],
        details: activation,
      };
    },
  };

  // Register the tiny bootstrap first for discoverability. The full tools are
  // configured but become provider-visible only after additive activation.
  pi.registerTool(workflowLoadTool);
  pi.registerTool(workflowTool);
  pi.registerTool(workflowTasksTool);

  // Plain-text listing message produced by /workflows.
  pi.registerMessageRenderer<{ text?: string }>("workflow_list", (message, _opts, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(workflowResultText(message.content), 0, 0));
    return box;
  });

  // /workflows — list saved workflows (built-in / user / project), live background
  // runs with their current progress, and recent resumable run directories.
  // Plain-text listing shared by the non-TUI /workflows path and the inspector's
  // empty state (saved workflows + live runs + recent resumable run dirs).
  const buildWorkflowsListLines = (cwd: string): string[] => {
    const lines: string[] = [];
    const registry = loadWorkflowRegistry({ cwd, agentDir: tryGetAgentDir() });
    lines.push("Saved workflows (run with /run-workflow <name> [args], or via the workflow tool: {name, args})");
    if (registry.workflows.length === 0) {
      lines.push("  (none)");
    }
    for (const workflow of registry.workflows) {
      lines.push(`  ${workflow.name} [${workflow.source}] — ${workflow.description}`);
      if (workflow.whenToUse) lines.push(`      when: ${workflow.whenToUse}`);
    }
    for (const diagnostic of registry.diagnostics) {
      lines.push(`  ! skipped: ${diagnostic}`);
    }

    lines.push("");
    lines.push("Live runs");
    if (liveRuns.size === 0) {
      lines.push("  (none)");
    }
    for (const [runId, run] of liveRuns) {
      const snapshot = run.getSnapshot?.();
      const progress = snapshot
        ? `: ${snapshot.doneCount}/${snapshot.agentCount} agents${snapshot.errorCount ? `, ${snapshot.errorCount} failed` : ""}${snapshot.currentPhase ? `, phase ${snapshot.currentPhase}` : ""}`
        : "";
      lines.push(`  ${runId} ${run.name}${progress}`);
    }

    const recent = listRecentRuns(cwd, 5);
    if (recent.length > 0) {
      lines.push("");
      lines.push("Recent runs (resume with {scriptPath: '<dir>/workflow.js', resumeFromRunId: '<runId>'})");
      for (const run of recent) {
        lines.push(`  ${run.runId}${run.hasScript ? "" : " (no script file)"} — ${run.dir}`);
      }
    }
    return lines;
  };

  // /workflows — interactive inspector in the TUI: a live tree of runs → phases →
  // agents with a detail pane (prompt, activity feed tail) and kill-with-confirm.
  // Non-TUI modes (and any overlay failure) fall back to the plain text listing.
  pi.registerCommand("workflows", {
    description: "Inspect live workflow runs (interactive in TUI); list saved workflows and recent runs",
    handler: async (_args, ctx) => {
      const sendList = () => {
        const lines = buildWorkflowsListLines(ctx.cwd);
        try {
          pi.sendMessage({
            customType: "workflow_list",
            content: [{ type: "text", text: lines.join("\n") }],
            display: true,
          });
        } catch {
          // Fallback for contexts where sending a message is unavailable.
          ctx.ui.notify(`${liveRuns.size} live workflow runs`, "info");
        }
      };

      if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        // Re-render on a timer while open so runningMs/feeds stay live. The timer
        // is cleared in finally (and self-defuses if the TUI is torn down — the
        // 0006-titlebar-spinner lesson).
        let timer: ReturnType<typeof setInterval> | undefined;
        try {
          await ctx.ui.custom<void>(
            (tui, _theme, _keybindings, done) => {
              timer = setInterval(() => {
                try {
                  tui.requestRender();
                } catch {
                  if (timer) clearInterval(timer);
                  timer = undefined;
                }
              }, 400);
              timer.unref?.();
              return new WorkflowInspector({
                listRuns: () => [...liveRuns.entries()].map(([runId, run]) => ({ runId, ...run })),
                emptyStateLines: () => buildWorkflowsListLines(ctx.cwd),
                onClose: () => done(undefined),
                tui,
                cwd: ctx.cwd,
                markdownTheme: safeMarkdownTheme(),
                hideThinking: false,
              });
            },
            { overlay: true, overlayOptions: { width: "85%", maxHeight: "85%", anchor: "center" } },
          );
          return;
        } catch {
          // Experimental overlay API unavailable or failed: use the text listing.
        } finally {
          if (timer) clearInterval(timer);
        }
      }
      sendList();
    },
  });

  // /run-workflow <name> [args] — model-free dispatch of a saved workflow. The
  // command resolves the name against the registry and invokes the workflow
  // tool's execute() directly, reusing the exact plumbing of a model-issued
  // call: in TUI sessions the run backgrounds (a notify shows the runId; the
  // completed result arrives as a workflow_result message that triggers the
  // model), while print/JSON/RPC modes run foreground and the final
  // result is posted as a workflow_result message without triggering a turn.
  pi.registerCommand("run-workflow", {
    description: "Run a saved workflow directly (no model dispatch): /run-workflow <name> [args]",
    getArgumentCompletions: (prefix: string) => {
      try {
        const registry = loadWorkflowRegistry({ cwd: process.cwd(), agentDir: tryGetAgentDir() });
        const items = registry.workflows
          .filter((workflow) => workflow.name.startsWith(prefix.trim()))
          .map((workflow) => ({ value: workflow.name, label: workflow.name, description: workflow.description }));
        return items.length > 0 ? items : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      let registry: ReturnType<typeof loadWorkflowRegistry>;
      try {
        registry = loadWorkflowRegistry({ cwd: ctx.cwd, agentDir: tryGetAgentDir() });
      } catch (error) {
        ctx.ui.notify(`/run-workflow: failed to load workflow registry: ${errorMessage(error)}`, "error");
        return;
      }
      const parsed = parseRunWorkflowInput(args ?? "", registry);
      if (!parsed.ok || !parsed.name) {
        ctx.ui.notify(
          parsed.error ?? "Usage: /run-workflow <name> [args]",
          parsed.error?.startsWith("Usage:") ? "info" : "error",
        );
        return;
      }
      try {
        await ctx.waitForIdle();
        const activation = activateWorkflowTools(ctx);
        if (activation.markedNow) {
          // Direct command dispatch has no loader tool result, so persist the
          // same cohesive guide invisibly for the next model turn.
          pi.sendMessage(
            {
              customType: WORKFLOW_GUIDE_MESSAGE_TYPE,
              content: [{ type: "text", text: workflowGuideForActivation(ctx.cwd, activation) }],
              display: false,
              details: { version: 1, loadedTools: activation.loadedTools },
            },
            { triggerTurn: false },
          );
        }
        const rawParams = { name: parsed.name, ...(parsed.args !== undefined ? { args: parsed.args } : {}) };
        const params = workflowTool.prepareArguments?.(rawParams) ?? rawParams;
        const result = await workflowTool.execute(
          "run-workflow-command",
          params,
          shutdownController.signal,
          undefined,
          ctx as unknown as Parameters<typeof workflowTool.execute>[4],
        );
        const text = workflowResultText(result.content as Array<{ type: string; text?: string }>);
        const status = (result.details as { status?: string } | undefined)?.status;
        if (status === "running") {
          // Backgrounded (interactive): completion is delivered via sendResult.
          ctx.ui.notify(text.split("\n")[0] || "Workflow started in background", "info");
        } else {
          // Foreground (print/RPC) or fast-failed: post the full result with the
          // workflow_result renderer. No triggerTurn — the user invoked this
          // directly; the model can be engaged on the next user prompt.
          pi.sendMessage({
            customType: "workflow_result",
            content: [{ type: "text", text }],
            display: true,
            details: (result.details ?? {}) as Record<string, unknown>,
          });
        }
      } catch (error) {
        ctx.ui.notify(`/run-workflow ${parsed.name} failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  // /kill-workflow <runId> — user-side abort of one background run. Completed
  // agents stay journaled, so the run remains resumable via resumeFromRunId.
  pi.registerCommand("kill-workflow", {
    description: "Abort one live background workflow run: /kill-workflow <runId>",
    getArgumentCompletions: (prefix: string) => {
      const items = [...liveRuns.entries()]
        .filter(([runId]) => runId.startsWith(prefix.trim()))
        .map(([runId, run]) => ({ value: runId, label: runId, description: run.name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const runId = (args ?? "").trim();
      const liveIds = [...liveRuns.keys()];
      if (!runId) {
        ctx.ui.notify(
          liveIds.length ? `Usage: /kill-workflow <runId>. Live: ${liveIds.join(", ")}` : "No live workflow runs.",
          "info",
        );
        return;
      }
      const run = liveRuns.get(runId);
      if (!run?.killRun) {
        ctx.ui.notify(
          `No live run "${runId}".${liveIds.length ? ` Live: ${liveIds.join(", ")}` : " No live workflow runs."}`,
          "error",
        );
        return;
      }
      run.killRun();
      ctx.ui.notify(
        `Aborting workflow ${run.name} (${runId}). Completed agents stay journaled — resume with resumeFromRunId.`,
        "info",
      );
    },
  });

  // A fresh branch starts with only the bootstrap. A branch carrying the
  // durable marker restores both full tools. Reconcile again after /tree so
  // disclosure state follows the selected branch rather than global runtime
  // state. Custom entries survive compaction and are excluded from model input.
  pi.on("session_start", (_event, ctx) => reconcileWorkflowTools(ctx));
  pi.on("session_tree", (_event, ctx) => reconcileWorkflowTools(ctx));

  // On shutdown (quit / reload / new / resume / fork) abort all in-flight
  // background runs, then AWAIT them. The handler is awaited before
  // session.dispose(), so firing the controller propagates the abort into every
  // composed run signal and the subagent sessions tear down before the runtime is
  // disposed. Replace the controller afterward so a subsequent session starts with
  // a fresh signal. Each settled promise is the run's own .then() (it never
  // rejects), so awaiting cannot throw.
  pi.on("session_shutdown", async () => {
    shutdownController.abort();
    const inflight = [...pending.values()];
    const clears = [...liveUiClears.values()];
    pending.clear();
    liveUiClears.clear();
    liveRuns.clear();
    await Promise.allSettled(inflight);
    // Defensive backstop: each run normally clears its own widget/status on settle
    // (the awaited promises above), but clear independently here too so no
    // dynamic-workflow:* panel can survive a session transition. clear() is idempotent,
    // so re-clearing an already-cleared run is a no-op; each is guarded so a torn-down
    // UI can't throw out of the handler.
    for (const clear of clears) {
      try {
        clear();
      } catch {
        // UI already gone; nothing to clear.
      }
    }
    shutdownController = new AbortController();
  });
}

function workflowSnapshotFromDetails(details: WorkflowResultDetails | undefined): WorkflowSnapshot | undefined {
  if (!details) return undefined;
  if (typeof details.name !== "string") return undefined;
  if (!Array.isArray(details.phases)) return undefined;
  if (!Array.isArray(details.logs)) return undefined;
  if (!Array.isArray(details.agents)) return undefined;
  if (typeof details.agentCount !== "number") return undefined;
  if (typeof details.runningCount !== "number") return undefined;
  if (typeof details.doneCount !== "number") return undefined;
  if (typeof details.errorCount !== "number") return undefined;
  return details as WorkflowSnapshot;
}

function workflowResultText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

/** Newest-first listing of `<cwd>/.pi-workflow-runs/<runId>` directories. */
function listRecentRuns(cwd: string, limit: number): Array<{ runId: string; dir: string; hasScript: boolean }> {
  const base = path.join(cwd, ".pi-workflow-runs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: Array<{ runId: string; dir: string; hasScript: boolean; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    try {
      runs.push({
        runId: entry.name,
        dir,
        hasScript: fs.existsSync(path.join(dir, "workflow.js")),
        mtimeMs: fs.statSync(dir).mtimeMs,
      });
    } catch {
      // Unreadable run dir: skip.
    }
  }
  return runs
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(({ runId, dir, hasScript }) => ({ runId, dir, hasScript }));
}

function tryGetAgentDir(): string | undefined {
  try {
    return getAgentDir();
  } catch {
    return undefined;
  }
}

function safeMarkdownTheme(): ReturnType<typeof getMarkdownTheme> | undefined {
  try {
    return getMarkdownTheme();
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
