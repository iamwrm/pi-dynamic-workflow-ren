import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  type Extension,
  getAgentDir,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/** Default number of nudge retries when a schema subagent forgets structured_output. */
const DEFAULT_STRUCTURED_OUTPUT_RETRIES = 2;

const STRUCTURED_OUTPUT_NUDGE =
  "You did not call structured_output. You MUST call it exactly once; its arguments ARE your answer. Call it now.";

/**
 * Tool name registered by this package's extension entry. Any extension exposing a
 * tool with this name is excluded from subagent sessions (recursion guard), no
 * matter where it was loaded from (this checkout, an npm-installed copy, a fork).
 */
const WORKFLOW_TOOL_NAME = "workflow";

/** This package's root directory (src/ and dist/ both sit directly below it). */
const WORKFLOW_PACKAGE_ROOT = (() => {
  try {
    return realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
  } catch {
    return undefined;
  }
})();

/**
 * Build a file-backed settings manager for a subagent. File-backed loading is
 * essential: pi keeps global and project package/resource configuration in
 * separate scopes, and an in-memory manager seeded from global settings silently
 * drops project packages. The parent's trust decision is authoritative so an
 * untrusted project cannot become trusted merely because a child session starts.
 * Exported for regression tests and SDK embedders.
 */
export function createSubagentSettingsManager(cwd: string, agentDir: string, projectTrusted = true): SettingsManager {
  return SettingsManager.create(cwd, agentDir, { projectTrusted });
}

/** Build the default child resource loader with the workflow recursion guard. */
export function createSubagentResourceLoader(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionsOverride: excludeWorkflowExtensions,
  });
}

/**
 * Recursion guard for inherited extensions: keep every extension except ones that
 * provide the workflow tool (or live inside this package). Subagents therefore
 * match the parent session's environment — custom models, prompt workarounds,
 * tracing — while recursive workflow spawning stays impossible.
 */
function excludeWorkflowExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.filter((extension) => !isWorkflowExtension(extension)) };
}

function isWorkflowExtension(extension: Extension): boolean {
  if (extension.tools.has(WORKFLOW_TOOL_NAME)) return true;
  if (!WORKFLOW_PACKAGE_ROOT) return false;
  return [extension.resolvedPath, extension.path].some((candidate) => {
    if (!candidate) return false;
    let resolved = candidate;
    try {
      resolved = realpathSync(candidate);
    } catch {
      // Path no longer resolvable (e.g. cleaned-up temp dir): compare as-is.
    }
    return resolved === WORKFLOW_PACKAGE_ROOT || resolved.startsWith(WORKFLOW_PACKAGE_ROOT + sep);
  });
}

/**
 * Persist subagent sessions as REAL pi sessions (standard session JSONL) in the
 * parent session's storage directory, linked to the parent via the session
 * header's `parentSession` field. This puts subagent trajectories AND their
 * provider token usage in the same pi session storage as the parent, so they
 * are inspectable with `pi --session <path>` and the resume picker instead of
 * living only in the run directory's capped messages.jsonl.
 */
export interface WorkflowAgentSessionPersistence {
  /** Directory holding the parent session's .jsonl files (SessionManager.getSessionDir()). */
  sessionDir: string;
  /**
   * Parent session file, recorded as the child session header's parentSession.
   * Omit to create an unlinked child (SDK embedders without a parent session).
   */
  parentSessionFile?: string;
}

/**
 * Session storage for one subagent attempt. With persistence configured, the
 * attempt becomes a pi child session in the parent's session dir. SessionManager
 * only writes the file once the first assistant message arrives, so attempts
 * that fail before any model response leave no empty session files behind.
 * Only CREATE-time storage failures (unwritable session dir, ...) degrade to
 * the previous in-memory behavior; flush-time failures (disk full, dir removed
 * mid-run) surface later during session.prompt and fail the attempt normally.
 * Exported for tests and SDK embedders.
 */
export function createSubagentSessionManager(
  persistence: WorkflowAgentSessionPersistence | undefined,
  cwd: string,
  sessionName?: string,
): SessionManager {
  if (persistence?.sessionDir) {
    try {
      const manager = SessionManager.create(cwd, persistence.sessionDir, {
        ...(persistence.parentSessionFile ? { parentSession: persistence.parentSessionFile } : {}),
      });
      // Name the child session so the resume picker stays legible among many
      // subagent sessions (the name is buffered with the other entries until
      // the first assistant message flushes the file).
      if (sessionName) manager.appendSessionInfo(sessionName);
      return manager;
    } catch {
      // Session storage unavailable: run in memory like before.
    }
  }
  return SessionManager.inMemory(cwd);
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /** Model subagents should use. Threaded from the parent session so subagents inherit it. */
  model?: Model<any>;
  /** Thinking level subagents should use. Threaded from the parent session. */
  thinkingLevel?: ThinkingLevel;
  /** Parent session's project-trust decision. Untrusted projects stay untrusted in child sessions. */
  projectTrusted?: boolean;
  /** Retries when a schema subagent finishes without calling structured_output. */
  structuredOutputRetries?: number;
  /**
   * Persist each subagent session as a pi child session in this session storage.
   * When absent (or when session.sessionManager overrides storage entirely),
   * subagents run on an in-memory SessionManager as before.
   */
  sessionPersistence?: WorkflowAgentSessionPersistence;
}

export interface WorkflowAgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Usage["cost"];
}

export interface WorkflowAgentTelemetry {
  /** Actual provider token usage, when the subagent session produced usage metadata. */
  usage?: WorkflowAgentUsage;
  /** Tokens charged to the workflow budget. Actual when usage is present; estimated only for custom runners. */
  tokens?: number;
  /** True when tokens came from the workflow fallback estimator rather than provider usage. */
  estimatedTokens?: boolean;
  /**
   * Persisted pi child session file (see WorkflowAgentSessionPersistence); set
   * only when the session actually flushed (first assistant message).
   */
  sessionFile?: string;
  /** Number of tool executions performed inside the subagent session. */
  toolCalls: number;
  /** Host-side elapsed time for the subagent turn, in milliseconds. */
  elapsedMs: number;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Per-call working directory override (e.g. an isolated git worktree). When set
   * and no explicit tools were injected, the default coding tools are rebuilt for
   * this cwd so file/bash operations land inside it.
   */
  cwd?: string;
  /** Restrict the subagent's base tools to these names (e.g. an agentType allowlist). */
  toolNames?: string[];
  /**
   * Display name for the persisted pi child session (session_info entry), e.g.
   * `workflow wf_x · #3 repo inventory`. Falls back to the label. Only used when
   * session persistence is enabled.
   */
  sessionName?: string;
  /** Per-call model override; falls back to the agent-level model. */
  model?: Model<any>;
  /** Per-call thinking level override; falls back to the agent-level thinking level. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Fired on every subagent session event (streaming deltas, tool execution, turn
   * lifecycle). The workflow runtime uses this to reset its per-agent stall timer,
   * mirroring Claude Code's activity-reset stall detection.
   */
  onActivity?: () => void;
  /**
   * Receives formatted activity-feed events (tool calls, tool errors, assistant
   * text). Advisory like onActivity: exceptions are swallowed.
   */
  onFeedEvent?: (event: WorkflowAgentFeedEvent) => void;
  /** Receives a live session handle right after the subagent session is created. */
  onSessionHandle?: (handle: WorkflowAgentSessionHandle) => void;
  /** Receives the final message array just before the session is disposed. */
  onSessionEnd?: (messages: readonly unknown[]) => void;
  /** Receives subagent usage/tool/elapsed telemetry for workflow budget accounting and UI. */
  onTelemetry?: (telemetry: WorkflowAgentTelemetry) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

/**
 * Activity-feed events emitted while a subagent session runs (advisory — a
 * throwing consumer can never break the run). The workflow runtime turns these
 * into bounded per-agent ring buffers, live text tails, and transcript files.
 */
export type WorkflowAgentFeedEvent =
  | { kind: "tool_start"; toolName: string; argsPreview: string }
  | { kind: "tool_error"; toolName: string; errorPreview: string }
  /** Full assistant text, emitted once per finished assistant message. */
  | { kind: "assistant_text"; text: string }
  /** Streaming assistant text delta (for live "currently typing" tails). */
  | { kind: "text_delta"; delta: string };

/**
 * Live access to a running subagent's session, surfaced to inspection UIs
 * (the /workflows session view). Advisory — consumers must tolerate the
 * session being disposed after the run settles.
 */
export interface WorkflowAgentSessionHandle {
  /** Current message array of the live session (pi AgentMessage shapes). */
  getMessages: () => readonly unknown[];
  /**
   * Child session path this subagent WILL flush to on its first assistant
   * message (see WorkflowAgentSessionPersistence). May never materialize.
   */
  sessionFile?: string;
  /** 'provider/model-id' the subagent runs on, when known. */
  model?: string;
  /** Thinking level of the subagent session, when known. */
  thinkingLevel?: string;
}

/** Compact single-line preview of tool-call arguments for feed lines. */
function feedArgsPreview(args: unknown): string {
  if (args == null) return "";
  try {
    const record = args as Record<string, unknown>;
    // Common primary fields render more readably than raw JSON.
    for (const key of ["cmd", "command", "path", "pattern", "url", "query"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return collapseLine(value, 96);
    }
    return collapseLine(JSON.stringify(args) ?? "", 96);
  } catch {
    return "";
  }
}

function feedResultPreview(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return collapseLine(result, 120);
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(record.content)) {
    const text = record.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
    if (text) return collapseLine(text, 120);
  }
  try {
    return collapseLine(JSON.stringify(result) ?? "", 120);
  } catch {
    return "";
  }
}

/** Collapse whitespace to single spaces and hard-cap length (feed/preview lines). */
export function collapseLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function assistantMessageText(message: unknown): string {
  const maybe = message as Partial<AssistantMessage> | undefined;
  if (maybe?.role !== "assistant" || !Array.isArray(maybe.content)) return "";
  return maybe.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  /** Whether the caller injected explicit tools (then per-call cwd must not rebuild them). */
  private readonly toolsProvided: boolean;
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly model?: Model<any>;
  private readonly thinkingLevel?: ThinkingLevel;
  private readonly projectTrusted: boolean;
  private readonly structuredOutputRetries: number;
  private readonly sessionPersistence?: WorkflowAgentSessionPersistence;
  /** Shared, offline-initialized child runtime; avoids one catalog refresh per parallel agent. */
  private childModelRuntime?: Promise<ModelRuntime>;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.toolsProvided = options.tools != null;
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.projectTrusted = options.projectTrusted ?? true;
    this.structuredOutputRetries = options.structuredOutputRetries ?? DEFAULT_STRUCTURED_OUTPUT_RETRIES;
    this.sessionPersistence = options.sessionPersistence;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const sessionCwd = options.cwd ?? this.sessionOptions.cwd ?? this.cwd;

    // Per-call cwd (worktree isolation) rebuilds the DEFAULT coding tools for that
    // cwd so file/bash operations land inside the isolated checkout. Explicitly
    // injected tools are caller-owned and never rebuilt.
    let baseTools = this.baseTools;
    if (options.cwd && !this.toolsProvided) baseTools = createCodingTools(sessionCwd);
    if (options.toolNames && options.toolNames.length > 0) {
      const allowed = new Set(options.toolNames);
      baseTools = baseTools.filter((tool) => allowed.has(tool.name));
    }
    const customTools: ToolDefinition[] = [...baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const model = options.model ?? this.model;
    const thinkingLevel = options.thinkingLevel ?? this.thinkingLevel;
    const started = Date.now();

    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    const settingsManager =
      this.sessionOptions.settingsManager ?? createSubagentSettingsManager(sessionCwd, agentDir, this.projectTrusted);
    // The child session's header cwd must be DURABLE: for worktree-isolated
    // agents sessionCwd is a disposable checkout whose path would later confuse
    // resume/session-picker cwd handling, so the header keeps the agent's stable
    // cwd while tools and prompting still run in sessionCwd.
    const sessionManager =
      this.sessionOptions.sessionManager ??
      createSubagentSessionManager(
        this.sessionPersistence,
        this.sessionOptions.cwd ?? this.cwd,
        options.sessionName ?? options.label,
      );
    // Child session file this subagent will persist into (undefined for in-memory
    // sessions). Reported only for managers we created — a caller-provided
    // sessionManager owns its own storage semantics.
    const subagentSessionFile = this.sessionOptions.sessionManager ? undefined : sessionManager.getSessionFile();
    // Subagents inherit the parent environment's extensions so extension-registered
    // models and provider workarounds apply. The default loader drops only workflow-
    // tool extensions, preventing recursive workflow spawning. Callers may still
    // supply an explicit resourceLoader for temporary CLI/inline extension inheritance.
    const resourceLoader =
      this.sessionOptions.resourceLoader ?? createSubagentResourceLoader(sessionCwd, agentDir, settingsManager);
    if (!this.sessionOptions.resourceLoader) await resourceLoader.reload();
    // Pi 0.80.8 makes ModelRuntime.create() async and refreshes configured model
    // catalogs by default. A workflow can start many child sessions concurrently,
    // so creating the default runtime inside every attempt causes a refresh herd.
    // Child sessions share one runtime initialized from the same auth/models files
    // with networking disabled; extension provider registrations are still applied
    // by each AgentSession as its inherited resource loader is bound.
    let modelRuntime = this.sessionOptions.modelRuntime;
    if (!modelRuntime) {
      let childModelRuntime = this.childModelRuntime;
      if (!childModelRuntime) {
        childModelRuntime = ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
        this.childModelRuntime = childModelRuntime;
      }
      modelRuntime = await childModelRuntime;
    }
    // Resource reload re-reads settings, so apply the child-only override after
    // reload. A caller-provided settings manager remains entirely caller-owned.
    if (!this.sessionOptions.settingsManager) {
      settingsManager.applyOverrides({ compaction: { enabled: false } });
    }

    const { session } = await createAgentSession({
      ...this.sessionOptions,
      cwd: sessionCwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime,
      customTools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    let removeAbortListener: (() => void) | undefined;
    let unsubscribeActivity: (() => void) | undefined;
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      try {
        // Effective metadata: explicit threading wins, then the session's own
        // resolved model/thinking level (covers callers relying on session defaults).
        const effectiveModel = model ?? session.model;
        const effectiveThinking =
          thinkingLevel ?? (session as { thinkingLevel?: ThinkingLevel | undefined }).thinkingLevel;
        options.onSessionHandle?.({
          getMessages: () => session.messages as readonly unknown[],
          ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
          ...(effectiveThinking ? { thinkingLevel: String(effectiveThinking) } : {}),
          ...(subagentSessionFile ? { sessionFile: subagentSessionFile } : {}),
        });
      } catch {
        // Session handles are advisory; a throwing consumer must not break the run.
      }
      if (options.onActivity || options.onFeedEvent) {
        // Every session event (text/thinking deltas, tool execution, turn lifecycle)
        // counts as progress for stall detection, and selected events are formatted
        // into the activity feed. Both callbacks are advisory: they must never break
        // the subagent run.
        const notifyActivity = options.onActivity;
        const onFeed = options.onFeedEvent;
        unsubscribeActivity = session.subscribe((event) => {
          try {
            notifyActivity?.();
          } catch {
            /* stall-timer reset is best-effort */
          }
          if (!onFeed) return;
          try {
            switch (event.type) {
              case "tool_execution_start":
                onFeed({ kind: "tool_start", toolName: event.toolName, argsPreview: feedArgsPreview(event.args) });
                break;
              case "tool_execution_end":
                if (event.isError) {
                  onFeed({
                    kind: "tool_error",
                    toolName: event.toolName,
                    errorPreview: feedResultPreview(event.result),
                  });
                }
                break;
              case "message_update": {
                const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
                if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
                  onFeed({ kind: "text_delta", delta: assistantEvent.delta });
                }
                break;
              }
              case "message_end": {
                const text = assistantMessageText(event.message);
                if (text) onFeed({ kind: "assistant_text", text });
                break;
              }
              default:
                break;
            }
          } catch {
            /* feed capture is best-effort */
          }
        });
      }
      if (options.signal) {
        // Swallow any rejection from abort(): it awaits the agent becoming idle,
        // which can fail mid-stream, and this fires precisely during cancellation
        // (Esc / shutdown) where the run is being torn down anyway. A bare `void`
        // would surface that as an unhandledRejection on the process.
        const onAbort = () => {
          session.abort().catch(() => {});
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        // Re-prompt with a firm nudge if the subagent forgot to call structured_output.
        for (let attempt = 0; !capture.called && attempt < this.structuredOutputRetries; attempt++) {
          if (options.signal?.aborted) throw new Error("Subagent was aborted");
          await session.prompt(STRUCTURED_OUTPUT_NUDGE);
          if (options.signal?.aborted) throw new Error("Subagent was aborted");
        }
        if (!capture.called) {
          throw new Error(
            `Subagent finished without calling structured_output after ${this.structuredOutputRetries} retries`,
          );
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      unsubscribeActivity?.();
      removeAbortListener?.();
      try {
        const telemetry = collectTelemetry(session.messages, Date.now() - started);
        // Only report a session file that actually exists: the JSONL is flushed on
        // the first assistant message, so an attempt that died earlier has none.
        if (subagentSessionFile && existsSync(subagentSessionFile)) telemetry.sessionFile = subagentSessionFile;
        options.onTelemetry?.(telemetry);
      } catch {
        // Telemetry is diagnostic/budget metadata; never let it change the subagent result.
      }
      try {
        // Final message snapshot BEFORE dispose, so persistence sees a valid array.
        options.onSessionEnd?.([...session.messages] as readonly unknown[]);
      } catch {
        // Advisory; never let persistence change the subagent result.
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    } else {
      // Claude Code's text-return subagent contract: the final text IS the return
      // value handed back to the orchestration script, not a message to a human.
      parts.push(
        [
          "Final output contract:",
          "- Your final text response is returned VERBATIM as a string to the calling workflow script — it is your return value, not a message to a human.",
          '- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."',
          "- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.",
          "- Be concise. The script will parse your output.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}

function collectTelemetry(messages: unknown[], elapsedMs: number): WorkflowAgentTelemetry {
  const usage = sumUsage(messages);
  return {
    ...(usage ? { usage, tokens: usage.totalTokens } : {}),
    toolCalls: countToolCalls(messages),
    elapsedMs,
  };
}

function sumUsage(messages: unknown[]): WorkflowAgentUsage | undefined {
  let sawUsage = false;
  const total: WorkflowAgentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const message of messages) {
    const maybe = message as Partial<AssistantMessage> | undefined;
    if (maybe?.role !== "assistant" || !isUsage(maybe.usage)) continue;
    sawUsage = true;
    total.input += maybe.usage.input;
    total.output += maybe.usage.output;
    total.cacheRead += maybe.usage.cacheRead;
    total.cacheWrite += maybe.usage.cacheWrite;
    total.totalTokens += maybe.usage.totalTokens;
    total.cost.input += maybe.usage.cost.input;
    total.cost.output += maybe.usage.cost.output;
    total.cost.cacheRead += maybe.usage.cost.cacheRead;
    total.cost.cacheWrite += maybe.usage.cost.cacheWrite;
    total.cost.total += maybe.usage.cost.total;
  }

  return sawUsage ? total : undefined;
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<Usage>;
  return (
    typeof usage.input === "number" &&
    typeof usage.output === "number" &&
    typeof usage.cacheRead === "number" &&
    typeof usage.cacheWrite === "number" &&
    typeof usage.totalTokens === "number" &&
    Boolean(usage.cost) &&
    typeof usage.cost?.input === "number" &&
    typeof usage.cost.output === "number" &&
    typeof usage.cost.cacheRead === "number" &&
    typeof usage.cost.cacheWrite === "number" &&
    typeof usage.cost.total === "number"
  );
}

function countToolCalls(messages: unknown[]): number {
  return messages.filter((message) => (message as { role?: unknown } | undefined)?.role === "toolResult").length;
}
