import fs from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Key, type MarkdownTheme, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DIVIDER, formatDuration, formatTokens, framePanel, type WorkflowAgentSnapshot } from "./display.js";
import type { WorkflowAgentSessionInfo } from "./workflow.js";

/** Accessors binding a session view to one agent of one live (or finished) run. */
export interface SessionViewTarget {
  runId: string;
  agentId: number;
  /** Fresh agent snapshot row (status, label, tokens, startedAtMs). */
  getAgent(): WorkflowAgentSnapshot | undefined;
  /** Live message access or persisted messages.jsonl, plus model/thinking metadata. */
  getSession(): WorkflowAgentSessionInfo | undefined;
  /** Kill exactly this agent (undefined when the run exposes no per-agent kill). */
  killAgent?(): { killed: boolean; reason?: string } | undefined;
}

export interface SessionViewOptions {
  target: SessionViewTarget;
  /** Return to the run tree. */
  onBack(): void;
  /** TUI instance for pi's ToolExecutionComponent; omitted in tests (plain fallback). */
  tui?: TUI;
  cwd?: string;
  /** pi markdown theme (getMarkdownTheme()); omitted in tests. */
  markdownTheme?: MarkdownTheme;
  /** Initial thinking visibility (false = visible, matching pi's hideThinkingBlock). */
  hideThinking?: boolean;
  /** Test seam. */
  now?: () => number;
}

/** Rows of conversation shown at once (windowed; scrollable). */
const BODY_ROWS = 24;
/** Anything with a render method — pi components and our fallbacks alike. */
interface RenderableLines {
  render(width: number): string[];
}

type MessageLike = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
};

/**
 * A pi-session-like view of one subagent's conversation, assembled from pi's
 * OWN message components (UserMessageComponent, AssistantMessageComponent,
 * ToolExecutionComponent) so rendering matches the main chat: markdown,
 * thinking blocks (t toggles), pi-style tool boxes with collapse/expand (e).
 *
 * Messages for finalized turns are componentized once and cached; the LAST
 * message is treated as volatile and rebuilt every render so live streaming
 * (the session mutates the trailing assistant message in place) just works.
 * Finished agents replay their persisted messages.jsonl through the exact same
 * pipeline.
 */
export class SessionView {
  private readonly options: SessionViewOptions;
  /** 0 = follow the bottom (live tail); >0 = scrolled up by that many lines. */
  private scrollFromBottom = 0;
  private hideThinking: boolean;
  private expandTools = false;
  private confirmKill = false;
  private flash: string | undefined;

  /** Componentized messages[0..n-2]; index-aligned prefix cache. */
  private fixedComps: RenderableLines[] = [];
  private fixedCount = 0;
  private readonly assistantComps: AssistantMessageComponent[] = [];
  private readonly toolComps = new Map<string, ToolExecutionComponent>();
  private readonly appliedResults = new Set<string>();
  /** Loaded messages.jsonl for finished agents (read once). */
  private fileMessages: unknown[] | undefined;
  private fileMessagesPath: string | undefined;

  constructor(options: SessionViewOptions) {
    this.options = options;
    this.hideThinking = options.hideThinking ?? false;
  }

  /** Component cache-invalidation hook; the volatile tail re-reads live data every render. */
  invalidate(): void {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private messages(): readonly unknown[] {
    const session = this.options.target.getSession();
    if (session?.live && session.getMessages) {
      try {
        return session.getMessages();
      } catch {
        return [];
      }
    }
    // Finished: even a still-readable live handle is preferred when present.
    if (session?.getMessages) {
      try {
        const live = session.getMessages();
        if (live.length > 0) return live;
      } catch {
        // fall through to the persisted file
      }
    }
    const messagesPath = session?.messagesPath;
    if (!messagesPath) return [];
    if (this.fileMessages && this.fileMessagesPath === messagesPath) return this.fileMessages;
    try {
      this.fileMessages = fs
        .readFileSync(messagesPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      this.fileMessages = [];
    }
    this.fileMessagesPath = messagesPath;
    return this.fileMessages;
  }

  handleInput(data: string): void {
    // Flash messages persist across the 400ms re-render ticks and clear on the
    // NEXT keypress (matching the inspector); handlers below may set a new one.
    this.flash = undefined;
    if (this.confirmKill) {
      if (data === "y" || data === "Y") {
        this.confirmKill = false;
        const outcome = this.options.target.killAgent?.();
        this.flash = outcome?.killed
          ? "killed — agent() resolves null; resume re-runs it"
          : `could not kill${outcome?.reason ? ` (${outcome.reason})` : ""}`;
        // Unlike the inspector tree (where q stays a close-overlay hatch mid-confirm),
        // q here means "back", so during a confirm it cancels the kill instead.
      } else if (data === "n" || data === "N" || matchesKey(data, Key.escape) || data === "q") {
        this.confirmKill = false;
        this.flash = "kill cancelled";
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "q") {
      this.options.onBack();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollFromBottom += 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollFromBottom += BODY_ROWS;
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollFromBottom = Math.max(0, this.scrollFromBottom - BODY_ROWS);
      return;
    }
    if (data === "g") {
      this.scrollFromBottom = Number.MAX_SAFE_INTEGER; // clamped at render
      return;
    }
    if (data === "G") {
      this.scrollFromBottom = 0;
      return;
    }
    if (data === "t") {
      this.hideThinking = !this.hideThinking;
      for (const comp of this.assistantComps) comp.setHideThinkingBlock(this.hideThinking);
      this.flash = this.hideThinking ? "thinking hidden" : "thinking visible";
      return;
    }
    if (data === "e") {
      this.expandTools = !this.expandTools;
      for (const comp of this.toolComps.values()) comp.setExpanded(this.expandTools);
      this.flash = this.expandTools ? "tool output expanded" : "tool output collapsed";
      return;
    }
    if (data === "k") {
      const agent = this.options.target.getAgent();
      if (agent?.status === "running" && this.options.target.killAgent) {
        this.confirmKill = true;
      } else {
        this.flash = agent?.status === "running" ? "kill not available" : "agent is not running";
      }
      return;
    }
  }

  /** Componentize one message (pi components; plain fallbacks without a TUI). */
  private buildComponents(message: MessageLike, final: boolean): RenderableLines[] {
    const theme = this.options.markdownTheme;
    if (message.role === "user") {
      const text = userText(message);
      return [new UserMessageComponent(text, theme), gap()];
    }
    if (message.role === "assistant") {
      const out: RenderableLines[] = [];
      const assistant = new AssistantMessageComponent(
        message as unknown as AssistantMessage,
        this.hideThinking,
        theme,
        "[thinking hidden — press t]",
      );
      this.assistantComps.push(assistant);
      out.push(assistant, gap());
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (part?.type !== "toolCall" || !part.id || !part.name) continue;
        out.push(this.buildToolComponent(part.id, part.name, part.arguments, final), gap());
      }
      return out;
    }
    if (message.role === "toolResult") {
      const id = message.toolCallId;
      const tool = id ? this.toolComps.get(id) : undefined;
      if (tool && id && !this.appliedResults.has(id)) {
        try {
          // A result implies the call finished: finalize args alongside it.
          tool.setArgsComplete();
          tool.updateResult(message as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0], false);
        } catch {
          // Result rendering is cosmetic; the raw transcript still has everything.
        }
        this.appliedResults.add(id);
      }
      if (!tool) {
        // Fallback (no TUI / unmatched call): plain result block.
        return [plainToolResult(message), gap()];
      }
      return [];
    }
    return [];
  }

  private buildToolComponent(id: string, name: string, args: unknown, final: boolean): RenderableLines {
    const existing = this.toolComps.get(id);
    if (existing) {
      // Volatile-tail rebuilds REUSE the component (pi's updateArgs streaming
      // path) instead of constructing a fresh TUI-bound instance every render
      // tick; expansion state stays sticky mid-stream.
      try {
        existing.updateArgs(args);
        if (final) existing.setArgsComplete();
      } catch {
        // Arg updates are cosmetic; the transcript still has everything.
      }
      return existing;
    }
    const { tui, cwd } = this.options;
    if (tui) {
      try {
        const comp = new ToolExecutionComponent(name, id, args, {}, undefined, tui, cwd ?? process.cwd());
        comp.markExecutionStarted();
        if (final) comp.setArgsComplete();
        comp.setExpanded(this.expandTools);
        this.toolComps.set(id, comp);
        return comp;
      } catch {
        // fall through to plain rendering
      }
    }
    return plainToolCall(name, args);
  }

  /** Body lines: cached prefix components + the volatile last message. */
  private bodyLines(width: number): string[] {
    const messages = this.messages() as MessageLike[];
    if (messages.length === 0) {
      return ["  (no session data — the agent may have been replayed from the journal cache)"];
    }
    const fixedTarget = messages.length - 1;
    if (this.fixedCount > fixedTarget) {
      // Message list shrank (stall retry started a fresh, shorter session, or a
      // live → persisted messages.jsonl swap replayed fewer messages): rebuild.
      this.fixedComps = [];
      this.fixedCount = 0;
      this.assistantComps.length = 0;
      this.toolComps.clear();
      this.appliedResults.clear();
    }
    while (this.fixedCount < fixedTarget) {
      this.fixedComps.push(...this.buildComponents(messages[this.fixedCount], true));
      this.fixedCount++;
    }
    // Volatile tail: rebuilt every render so in-place streaming mutation shows up.
    const volatileComps: RenderableLines[] = [];
    const last = messages[messages.length - 1];
    if (last) {
      const assistantBefore = this.assistantComps.length;
      volatileComps.push(...this.buildComponents(last, false));
      // Volatile assistant comps must not accumulate in the toggle registry.
      this.assistantComps.length = assistantBefore;
    }
    const lines: string[] = [];
    for (const comp of [...this.fixedComps, ...volatileComps]) {
      try {
        lines.push(...comp.render(width));
      } catch {
        lines.push("  (render error)");
      }
    }
    const agent = this.options.target.getAgent();
    if (agent?.status === "running") lines.push("▌");
    return lines;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const agent = this.options.target.getAgent();
    const session = this.options.target.getSession();
    const title = ` agent #${this.options.target.agentId}${agent ? ` · ${agent.label}` : ""} `;

    const headStatus = agent
      ? agent.status === "running" && typeof agent.startedAtMs === "number"
        ? `● running ${formatDuration(this.now() - agent.startedAtMs)}`
        : agent.status
      : "unknown";
    const meta = [
      headStatus,
      session?.model,
      session?.thinkingLevel,
      typeof agent?.tokens === "number" ? `${formatTokens(agent.tokens)} tok` : undefined,
      typeof agent?.toolCalls === "number" ? `${agent.toolCalls} tools` : undefined,
      session && !session.live
        ? session.messagesPath || session.getMessages
          ? "finished · from messages.jsonl"
          : "finished · no persisted messages"
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    const body = this.bodyLines(innerWidth);
    const maxScroll = Math.max(0, body.length - BODY_ROWS);
    if (this.scrollFromBottom > maxScroll) this.scrollFromBottom = maxScroll;
    const start = Math.max(0, body.length - BODY_ROWS - this.scrollFromBottom);
    const visible = body.slice(start, start + BODY_ROWS);

    const inner: string[] = [];
    inner.push(` ${meta}`);
    inner.push(DIVIDER);
    if (start > 0) inner.push(`   … ${start} more above (↑/PgUp/g) …`);
    inner.push(...visible);
    const below = body.length - (start + visible.length);
    if (below > 0) inner.push(`   … ${below} more below (↓/PgDn/G) …`);
    inner.push(DIVIDER);
    inner.push(this.footerText());

    return framePanel(title, inner, width, innerWidth);
  }

  private footerText(): string {
    if (this.confirmKill) {
      const agent = this.options.target.getAgent();
      return ` Kill agent #${this.options.target.agentId}${agent ? ` "${agent.label}"` : ""}? y/n`;
    }
    if (this.flash) return ` ${this.flash}`;
    return " ↑↓ scroll · PgUp/PgDn · g/G top/bottom · t thinking · e expand tools · k kill · ←/esc back";
  }
}

function gap(): RenderableLines {
  return { render: () => [""] };
}

function userText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function plainToolCall(name: string, args: unknown): RenderableLines {
  let argsText = "";
  try {
    argsText = JSON.stringify(args) ?? "";
  } catch {
    argsText = "";
  }
  return {
    render: (width: number) => wrapTextWithAnsi(`⚒ ${name} ${argsText}`.trim(), width),
  };
}

function plainToolResult(message: MessageLike): RenderableLines {
  const COLLAPSED_LINES = 4;
  const content = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : [];
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const isError = Boolean(message.isError);
  return {
    render: (width: number) => {
      const all = text
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line === "" ? " " : line, Math.max(1, width - 4)));
      const shown = all.slice(0, COLLAPSED_LINES).map((line) => `  ${isError ? "✗ " : "  "}${line}`);
      if (all.length > COLLAPSED_LINES) shown.push(`     …(+${all.length - COLLAPSED_LINES} more lines)`);
      return shown;
    },
  };
}
