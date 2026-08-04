import { Key, type MarkdownTheme, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  DIVIDER,
  formatDuration,
  formatTokens,
  framePanel,
  type LiveRunHandle,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { SessionView } from "./session-view.js";

/** One live run as seen by the inspector (the extension's liveRuns map entry). */
export type InspectorRun = LiveRunHandle;

export interface WorkflowInspectorOptions {
  /** Live runs, re-read on every render so the view stays current. */
  listRuns(): InspectorRun[];
  /** Close the overlay (wired to ctx.ui.custom's done()). */
  onClose(): void;
  /** Lines shown when no run is live (saved workflows, recent runs, ...). */
  emptyStateLines?: () => string[];
  /** TUI instance for the session view's pi tool components (omit in tests). */
  tui?: TUI;
  cwd?: string;
  /** pi markdown theme for session-view message rendering (omit in tests). */
  markdownTheme?: MarkdownTheme;
  /** Initial thinking visibility in session views (false = visible). */
  hideThinking?: boolean;
  /** Test seam for time-dependent rendering. */
  now?: () => number;
}

type Row =
  | { kind: "run"; key: string; run: InspectorRun; snapshot?: WorkflowSnapshot }
  | { kind: "phase"; key: string; title: string }
  | { kind: "agent"; key: string; run: InspectorRun; agent: WorkflowAgentSnapshot };

type Confirm = { kind: "run" | "agent"; runId: string; agentId?: number; label: string };

/** Max tree rows shown at once (windowed around the selection). */
const TREE_ROWS = 14;
/** Max feed lines in the agent detail pane. */
const DETAIL_FEED_LINES = 6;

/**
 * Keyboard-only workflow inspector: a tree of live runs → phases → agents with
 * a live detail pane (prompt, status, activity feed tail), plus kill-with-confirm
 * for single agents (k) and whole runs (K). Pure component — all data access goes
 * through the injected listRuns(), so tests drive it with fixtures and the
 * extension re-renders it on a timer for live updates.
 */
export class WorkflowInspector {
  private readonly options: WorkflowInspectorOptions;
  private selectedKey: string | undefined;
  /** Last known position among selectable rows, for nearest-neighbor reseat. */
  private lastSelectedIndex = 0;
  private readonly collapsed = new Set<string>();
  private confirm: Confirm | undefined;
  private flash: string | undefined;

  constructor(options: WorkflowInspectorOptions) {
    this.options = options;
  }

  /** Component cache-invalidation hook; this component recomputes every render. */
  invalidate(): void {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Flattened tree rows (fresh snapshot every call). */
  private buildRows(): Row[] {
    const rows: Row[] = [];
    for (const run of this.options.listRuns()) {
      const snapshot = run.getSnapshot?.();
      rows.push({ kind: "run", key: `run:${run.runId}`, run, snapshot });
      if (this.collapsed.has(run.runId) || !snapshot) continue;
      let phase: string | undefined;
      let sawPhase = false;
      for (const agent of snapshot.agents) {
        if (agent.phase !== phase || !sawPhase) {
          phase = agent.phase;
          sawPhase = true;
          // Positional key: repeated phase titles (A, B, A) stay distinct.
          rows.push({ kind: "phase", key: `phase:${run.runId}:${rows.length}`, title: phase ?? "(no phase)" });
        }
        rows.push({ kind: "agent", key: `agent:${run.runId}:${agent.id}`, run, agent });
      }
    }
    return rows;
  }

  private selectableRows(rows: Row[]): Row[] {
    return rows.filter((row) => row.kind !== "phase");
  }

  private selectedRow(rows: Row[]): Row | undefined {
    const selectable = this.selectableRows(rows);
    if (selectable.length === 0) return undefined;
    const index = selectable.findIndex((row) => row.key === this.selectedKey);
    if (index !== -1) {
      this.lastSelectedIndex = index;
      return selectable[index];
    }
    // Selection vanished (run finished, agent list changed): reseat to the
    // nearest neighbor of the previous position rather than jumping to the top.
    const reseat = Math.min(this.lastSelectedIndex, selectable.length - 1);
    this.lastSelectedIndex = reseat;
    this.selectedKey = selectable[reseat].key;
    return selectable[reseat];
  }

  private moveSelection(delta: number): void {
    const rows = this.buildRows();
    const selectable = this.selectableRows(rows);
    if (selectable.length === 0) return;
    // Resolve (and possibly reseat) the current selection first so movement is
    // always relative to what the user sees.
    this.selectedRow(rows);
    const index = Math.max(
      0,
      selectable.findIndex((row) => row.key === this.selectedKey),
    );
    const next = Math.min(selectable.length - 1, Math.max(0, index + delta));
    this.selectedKey = selectable[next].key;
    this.lastSelectedIndex = next;
  }

  /** Active drill-in session view (Enter on an agent row); undefined = tree. */
  private session: SessionView | undefined;

  /** Open the pi-session-like view for one agent of one run. */
  private openSession(run: InspectorRun, agentId: number): void {
    this.session = new SessionView({
      target: {
        runId: run.runId,
        agentId,
        getAgent: () => run.getSnapshot?.()?.agents.find((agent) => agent.id === agentId),
        getSession: () => run.getAgentSession?.(agentId),
        killAgent: run.killAgents ? () => run.killAgents?.([agentId])[0] : undefined,
      },
      onBack: () => {
        this.session = undefined;
      },
      tui: this.options.tui,
      cwd: this.options.cwd,
      markdownTheme: this.options.markdownTheme,
      hideThinking: this.options.hideThinking,
      now: this.options.now,
    });
  }

  handleInput(data: string): void {
    if (this.session) {
      this.session.handleInput(data);
      return;
    }
    if (this.confirm) {
      if (data === "y" || data === "Y") {
        this.executeConfirm();
      } else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
        this.confirm = undefined;
        this.flash = "kill cancelled";
      } else if (data === "q") {
        // q stays an exit hatch even while a confirm is pending.
        this.confirm = undefined;
        this.options.onClose();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      this.options.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.flash = undefined;
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.flash = undefined;
      this.moveSelection(1);
      return;
    }

    const row = this.selectedRow(this.buildRows());
    if (!row || row.kind === "phase") return;

    if (matchesKey(data, Key.enter) && row.kind === "agent") {
      // Drill into the agent's session (pi-like conversation view).
      this.openSession(row.run, row.agent.id);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const runId = row.run.runId;
      if (matchesKey(data, Key.right)) this.collapsed.delete(runId);
      else if (matchesKey(data, Key.left)) this.collapsed.add(runId);
      else if (this.collapsed.has(runId)) this.collapsed.delete(runId);
      else this.collapsed.add(runId);
      // Folding away the selected agent must not teleport the selection: land on
      // the run row the user just folded.
      if (this.collapsed.has(runId)) this.selectedKey = `run:${runId}`;
      return;
    }
    if (data === "k") {
      if (row.kind === "agent" && row.agent.status === "running") {
        this.confirm = {
          kind: "agent",
          runId: row.run.runId,
          agentId: row.agent.id,
          label: `agent #${row.agent.id} "${row.agent.label}"`,
        };
      } else if (row.kind === "agent") {
        this.flash = `agent #${row.agent.id} is ${row.agent.status} — only running agents can be killed`;
      } else {
        this.flash = "select an agent to kill (K kills the whole run)";
      }
      return;
    }
    if (data === "K") {
      if (!row.run.killRun) {
        this.flash = `run ${row.run.runId} does not expose kill`;
        return;
      }
      this.confirm = { kind: "run", runId: row.run.runId, label: `run ${row.run.runId} "${row.run.name}"` };
      return;
    }
    if (data === "y") {
      this.flash = `resume: workflow {scriptPath: '.pi-workflow-runs/${row.run.runId}/workflow.js', resumeFromRunId: '${row.run.runId}'}`;
      return;
    }
  }

  private executeConfirm(): void {
    const confirm = this.confirm;
    this.confirm = undefined;
    if (!confirm) return;
    const run = this.options.listRuns().find((entry) => entry.runId === confirm.runId);
    if (!run) {
      this.flash = `${confirm.label} is no longer live`;
      return;
    }
    if (confirm.kind === "run") {
      if (!run.killRun) {
        this.flash = `${confirm.label} does not expose kill`;
        return;
      }
      run.killRun();
      this.flash = `killed ${confirm.label} — journal stays resumable`;
      return;
    }
    const outcome = run.killAgents?.([confirm.agentId ?? -1])[0];
    this.flash = outcome?.killed
      ? `killed ${confirm.label} — its agent() resolves null; resume re-runs it`
      : `could not kill ${confirm.label}${outcome?.reason ? ` (${outcome.reason})` : ""}`;
  }

  render(width: number): string[] {
    if (this.session) return this.session.render(width);
    // All inner lines go through fit() (sanitize + truncate) before framing.
    const innerWidth = Math.max(16, width - 4);
    return framePanel(" Workflows ", this.renderInner(innerWidth), width, innerWidth);
  }

  private renderInner(width: number): string[] {
    const rows = this.buildRows();
    const selected = this.selectedRow(rows);
    const lines: string[] = [];
    const push = (text: string) => lines.push(fit(text, width));

    if (rows.length === 0) {
      push("  (no live workflow runs)");
      for (const line of this.options.emptyStateLines?.() ?? []) push(`  ${line}`);
      lines.push(DIVIDER);
      push(fit(this.footerText(), width));
      return lines;
    }

    // Windowed tree around the selection.
    const selectedIndex = Math.max(
      0,
      rows.findIndex((row) => row.key === selected?.key),
    );
    const start = Math.max(0, Math.min(selectedIndex - Math.floor(TREE_ROWS / 2), rows.length - TREE_ROWS));
    const visible = rows.slice(start, start + TREE_ROWS);
    if (start > 0) push(`   … ${start} more above …`);
    for (const row of visible) {
      const marker = row.key === selected?.key ? "▸" : " ";
      if (row.kind === "run") push(`${marker} ${this.runLine(row)}`);
      else if (row.kind === "phase") push(`   ── ${row.title}`);
      else push(`${marker}   ${this.agentLine(row.run, row.agent)}`);
    }
    const hidden = rows.length - (start + visible.length);
    if (hidden > 0) push(`   … ${hidden} more below …`);

    lines.push(DIVIDER);
    for (const line of this.detailLines(selected, width)) push(line);
    lines.push(DIVIDER);
    push(fit(this.footerText(), width));
    return lines;
  }

  private footerText(): string {
    if (this.confirm) return ` Kill ${this.confirm.label}? y/n`;
    if (this.flash) return ` ${this.flash}`;
    return " ↑↓ move · ⏎ inspect agent / fold run · k kill agent · K kill run · y resume hint · q close";
  }

  private runLine(row: Row & { kind: "run" }): string {
    const { run, snapshot } = row;
    const fold = this.collapsed.has(run.runId) ? "▸" : "▾";
    const counts = snapshot
      ? `${snapshot.doneCount}/${snapshot.agentCount} done${snapshot.runningCount ? ` · ${snapshot.runningCount} running` : ""}${snapshot.errorCount ? ` · ${snapshot.errorCount} failed` : ""}`
      : "starting";
    const spent = snapshot ? snapshot.agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0) : 0;
    const elapsed = typeof run.startedAtMs === "number" ? ` · ${formatDuration(this.now() - run.startedAtMs)}` : "";
    const phase = snapshot?.currentPhase ? ` · ${snapshot.currentPhase}` : "";
    return `${fold} ${run.name} (${run.runId})${phase} — ${counts}${spent ? ` · ${formatTokens(spent)} tok` : ""}${elapsed}`;
  }

  private agentSessionMetrics(run: InspectorRun, agentId: number): string[] {
    try {
      const session = run.getAgentSession?.(agentId);
      return [session?.model, session?.thinkingLevel].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
    } catch {
      // A session may disappear while a background run settles; metadata is advisory.
      return [];
    }
  }

  private agentLine(run: InspectorRun, agent: WorkflowAgentSnapshot): string {
    const icon =
      agent.status === "running"
        ? "●"
        : agent.status === "queued"
          ? "○"
          : agent.status === "done"
            ? "✓"
            : agent.status === "skipped"
              ? "-"
              : "✗";
    const sessionMetrics = this.agentSessionMetrics(run, agent.id);
    const metrics =
      agent.status === "running"
        ? [
            typeof agent.startedAtMs === "number"
              ? `running ${formatDuration(this.now() - agent.startedAtMs)}`
              : "running",
            typeof agent.tokens === "number" ? `${formatTokens(agent.tokens)} tok` : undefined,
            ...sessionMetrics,
          ]
            .filter(Boolean)
            .join(" · ")
        : [
            typeof agent.tokens === "number" ? `${formatTokens(agent.tokens)} tok` : undefined,
            typeof agent.toolCalls === "number" ? `${agent.toolCalls} tools` : undefined,
            typeof agent.elapsedMs === "number" ? formatDuration(agent.elapsedMs) : undefined,
            ...sessionMetrics,
          ]
            .filter(Boolean)
            .join(" · ") || agent.status;
    const killedMark = agent.status === "killed" ? " (killed)" : "";
    return `#${agent.id} ${icon} ${agent.label}${killedMark} — ${metrics}`;
  }

  private detailLines(selected: Row | undefined, width: number): string[] {
    if (!selected) return ["  (nothing selected)"];
    if (selected.kind === "run") {
      const snapshot = selected.snapshot ?? selected.run.getSnapshot?.();
      const lines = [` ${selected.run.name} — ${selected.run.runId}`];
      if (snapshot) {
        for (const log of snapshot.logs.slice(-4)) lines.push(`  ${log}`);
        if (snapshot.logs.length === 0) lines.push("  (no logs yet)");
      }
      return lines;
    }
    if (selected.kind === "phase") return [];
    const agent = selected.agent;
    const lines: string[] = [];
    const sessionMetrics = this.agentSessionMetrics(selected.run, agent.id);
    const status =
      agent.status === "running"
        ? [
            typeof agent.startedAtMs === "number"
              ? `running ${formatDuration(this.now() - agent.startedAtMs)}`
              : "running",
            typeof agent.tokens === "number" ? `${formatTokens(agent.tokens)} tok` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        : agent.status;
    lines.push(
      ` #${agent.id} ${agent.label} — ${status}${agent.phase ? ` · ${agent.phase}` : ""}${sessionMetrics.length ? ` · ${sessionMetrics.join(" · ")}` : ""}`,
    );
    lines.push(`  prompt: ${collapse(agent.prompt, Math.max(20, width - 12))}`);
    const feed = selected.run.getAgentFeed?.(agent.id);
    if (feed) {
      for (const line of feed.lines.slice(-DETAIL_FEED_LINES)) lines.push(`  ${line}`);
      if (feed.liveText) lines.push(`  ▌${collapse(feed.liveText.slice(-400), Math.max(20, width - 6))}`);
      if (feed.lines.length === 0 && !feed.liveText) lines.push("  (no activity yet)");
    } else if (agent.resultPreview) {
      lines.push(`  result: ${agent.resultPreview}`);
    } else if (agent.error) {
      lines.push(`  error: ${agent.error}`);
    }
    return lines;
  }
}

/**
 * Strip ANSI escapes and control characters from externally sourced text
 * (snapshot logs, prompts, feed lines): the inspector tree/detail panes render
 * plain text, and stray escapes would shear the border or leak styling.
 */
function sanitize(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
      .replace(/[\r\n]+/g, " ")
  );
}

/** Truncate to DISPLAY width (ANSI/emoji/CJK aware) — never exceeds the TUI contract. */
function fit(text: string, width: number): string {
  // Outer sanitize: truncateToWidth wraps its ellipsis in ANSI resets, but the
  // inspector pane is plain text — stray escapes would shear the frame border.
  return sanitize(truncateToWidth(sanitize(text), width, "…"));
}

function collapse(text: string, max: number): string {
  const collapsed = sanitize(text).replace(/\s+/g, " ").trim();
  return visibleWidth(collapsed) > max ? truncateToWidth(collapsed, max, "…") : collapsed;
}
