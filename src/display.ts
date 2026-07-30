import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowAgentFeed, WorkflowAgentKillResult, WorkflowAgentSessionInfo, WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "killed" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  /** Wall-clock start of the live attempt (host time); lets status surfaces compute runningMs. */
  startedAtMs?: number;
  resultPreview?: string;
  error?: string;
  tokens?: number;
  estimatedTokens?: boolean;
  toolCalls?: number;
  elapsedMs?: number;
  /** Persisted pi child session file for this agent (pi session storage), when enabled. */
  sessionFile?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
}

/**
 * Control/introspection surface of one live workflow run — the single shape
 * shared by the inspector (InspectorRun), the workflow_tasks tool source, and
 * the extension's live-run registry, so the handles cannot drift apart.
 */
export interface LiveRunHandle {
  runId: string;
  name: string;
  /** Wall-clock start of the run (for elapsed/status surfaces). */
  startedAtMs?: number;
  getSnapshot?: () => WorkflowSnapshot;
  /** Abort this run only (composed into the run signal; journal stays resumable). */
  killRun?: () => void;
  /** Kill specific live agents by ordinal id (ids from the snapshot/status). */
  killAgents?: (ids: number[]) => WorkflowAgentKillResult[];
  /** Activity feed (lines/liveText/transcript) for any started agent in this run. */
  getAgentFeed?: (id: number) => WorkflowAgentFeed | undefined;
  /** Session access (live messages / persisted messages.jsonl) per started agent. */
  getAgentSession?: (id: number) => WorkflowAgentSessionInfo | undefined;
}

/** Sentinel line that framePanel renders as a full-width `├──┤` divider. */
export const DIVIDER = "\u0000DIVIDER\u0000";

/**
 * Wrap inner lines in a bordered `┌─ title ─┐ … └──┘` panel. Overlays composite
 * over live session content, so every interior line is truncated and padded to
 * exactly `innerWidth` display columns (ANSI/emoji/CJK aware) to keep the panel
 * opaque and the borders straight; DIVIDER sentinel lines become `├──┤` rules.
 */
export function framePanel(title: string, inner: string[], width: number, innerWidth: number): string[] {
  const barWidth = Math.max(2, innerWidth + 2);
  const top = truncateToWidth(`┌─${title}${"─".repeat(Math.max(0, barWidth - 1 - visibleWidth(title)))}┐`, width, "…");
  const bottom = truncateToWidth(`└${"─".repeat(barWidth)}┘`, width, "…");
  const framed = inner.map((line) => {
    if (line === DIVIDER) return truncateToWidth(`├${"─".repeat(barWidth)}┤`, width, "…");
    const fitted = truncateToWidth(line, innerWidth, "…");
    const gap = innerWidth - visibleWidth(fitted);
    return truncateToWidth(`│ ${fitted}${gap > 0 ? " ".repeat(gap) : ""} │`, width, "…");
  });
  return [top, ...framed, bottom];
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error" || agent.status === "killed").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const metrics = formatAgentMetrics(agent);
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${metrics}${result}`);
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      const metrics = formatAgentMetrics(agent);
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${metrics}${result}`);
    }
  }

  for (const log of snapshot.logs.slice(-maxLogs)) lines.push(`  log: ${log}`);
  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

/**
 * Humanize token counts for compact display: 847 → "847", 126728 → "126.7k",
 * 1234567 → "1.2m". One decimal, with a trailing ".0" trimmed (5000 → "5k").
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return String(tokens);
  if (tokens < 1000) return String(tokens);
  const millions = tokens >= 1_000_000;
  const scaled = millions ? tokens / 1_000_000 : tokens / 1000;
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${millions ? "m" : "k"}`;
}

function formatAgentMetrics(agent: WorkflowAgentSnapshot): string {
  if (agent.status === "running" || agent.status === "queued") return "";
  const parts = [];
  if (typeof agent.tokens === "number")
    parts.push(`${agent.estimatedTokens ? "~" : ""}${formatTokens(agent.tokens)} tok`);
  if (typeof agent.toolCalls === "number") parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`);
  if (typeof agent.elapsedMs === "number") parts.push(formatDuration(agent.elapsedMs));
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "killed":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
