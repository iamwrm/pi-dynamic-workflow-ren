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
  type SessionEntry,
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
 * Cap on consecutive mid-turn compaction boundaries observed inside one
 * subagent attempt. Each boundary requires crossing the soft threshold again
 * (hundreds of thousands of tokens of new context), so this cap is generous;
 * exceeding it falls back to the ordinary terminal-failure path.
 */
const MAX_MID_TURN_BOUNDARIES = 8;

/**
 * Grace allowed after a continuation run settles for the NEXT continuation's
 * agent_start to appear. The resume is a fire-and-forget session prompt whose
 * preflight (input handlers, model/compaction checks, before_agent_start) runs
 * a few microtasks after the settle event, so the engine must not declare a
 * failure in that gap. Real failures without any boundary evidence never enter
 * this wait (zero regression); a continuation that ended in a real provider
 * error is delayed by at most this grace.
 */
const BOUNDARY_EVIDENCE_GRACE_MS = 500;

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

/** Last assistant message in a session message list, or undefined when none exists. */
function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage>;
    if (message.role === "assistant" && Array.isArray(message.content)) return message as AssistantMessage;
  }
  return undefined;
}

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
  /**
   * Override createAgentSession options (model, modelRuntime, resourceLoader, etc.).
   * A caller-provided settingsManager must be paired with a resourceLoader so
   * WorkflowAgent never reloads and destroys caller-owned in-memory overrides.
   */
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
  /**
   * Override Pi's automatic compaction setting in child sessions. When omitted,
   * the inherited/persisted Pi setting is preserved (Pi defaults it to true).
   */
  autoCompaction?: boolean;
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
  /** Receives live message and telemetry access right after the subagent session is created. */
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
   * Current append-only usage/tool telemetry. Provider token usage becomes
   * available after each completed model response; elapsed time remains live.
   */
  getTelemetry?: () => WorkflowAgentTelemetry;
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
  private readonly autoCompaction?: boolean;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.toolsProvided = options.tools != null;
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    if (this.sessionOptions.settingsManager && !this.sessionOptions.resourceLoader) {
      throw new TypeError(
        "WorkflowAgent session.settingsManager requires a paired session.resourceLoader so caller-owned overrides are not erased by resource reload",
      );
    }
    this.instructions = options.instructions;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.projectTrusted = options.projectTrusted ?? true;
    this.structuredOutputRetries = options.structuredOutputRetries ?? DEFAULT_STRUCTURED_OUTPUT_RETRIES;
    this.sessionPersistence = options.sessionPersistence;
    this.autoCompaction = options.autoCompaction;
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
    // Extension provider decorators can own mutable per-session state (the native
    // server-compaction adapter does). Give every child attempt its own offline
    // runtime so parallel children cannot replace one another's decorator state.
    // An explicitly injected runtime remains caller-owned.
    const modelRuntime =
      this.sessionOptions.modelRuntime ??
      (await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        allowModelNetwork: false,
      }));
    // Resource reload re-reads persisted settings. Only apply a compaction value
    // when the caller explicitly supplied one; otherwise preserve persisted false
    // as well as Pi's normal default-true behavior.
    if (this.autoCompaction !== undefined) {
      settingsManager.applyOverrides({ compaction: { enabled: this.autoCompaction } });
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
    let unsubscribeSession: (() => void) | undefined;
    let terminalCompactionSuppressed = false;
    const suppressTerminalCompaction = () => {
      if (terminalCompactionSuppressed || !settingsManager.getCompactionEnabled()) return;
      settingsManager.applyOverrides({ compaction: { enabled: false } });
      terminalCompactionSuppressed = true;
    };
    const restoreTerminalCompaction = () => {
      if (!terminalCompactionSuppressed) return;
      settingsManager.applyOverrides({ compaction: { enabled: true } });
      terminalCompactionSuppressed = false;
    };

    // Mid-turn boundary tracking (see promptSession below). A deliberate
    // extension abort of a tool-follow-up turn is a boundary, not a failure,
    // when the child session continues on its own: the continuation run starts
    // before session.prompt() resolves. The flags below are reset at every
    // error/aborted terminal (the boundary candidate) and updated by the
    // native lifecycle events that follow, so the post-prompt decision never
    // waits on time:
    //   boundaryActive       - the last assistant terminal was error/aborted
    //   continuationStarted  - a run started on its own after that terminal
    //   continuationSettled  - that run settled (a fast continuation finishes
    //                          before the post-prompt decision)
    //   compactionStarted/Ended - a compaction ran after that terminal; while
    //                          started and not ended it is in flight, which
    //                          means the continuation is still on its way even
    //                          though no run has started yet
    let boundaryActive = false;
    let continuationStarted = false;
    let continuationSettled = false;
    let compactionStarted = false;
    let compactionEnded = false;
    let lastFinalAgentEndMessages: readonly unknown[] | undefined;
    // Sticky across boundaries within this attempt: any continuation or
    // compaction evidence at all. Gates the post-settle evidence grace so
    // real failures without any boundary activity keep failing immediately.
    let boundaryEvidenceSeen = false;
    // One bounded grace attempt per boundary for the next continuation's
    // agent_start to appear after a settle (the fire-and-forget resume prompt
    // runs a few microtasks of preflight before its run starts).
    let graceAttempted = false;
    // Set when any combined abort signal (stall, whole-run abort, manual kill)
    // fired, so a pending boundary wait cannot swallow an abort.
    let combinedAborted = false;
    let boundaryWaitResolve: (() => void) | undefined;
    let boundaryGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const resolveBoundaryWait = (): void => {
      if (boundaryGraceTimer !== undefined) {
        clearTimeout(boundaryGraceTimer);
        boundaryGraceTimer = undefined;
      }
      const resolve = boundaryWaitResolve;
      boundaryWaitResolve = undefined;
      resolve?.();
    };
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
          getTelemetry: () => collectTelemetry(sessionManager.getEntries(), Date.now() - started),
          ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
          ...(effectiveThinking ? { thinkingLevel: String(effectiveThinking) } : {}),
          ...(subagentSessionFile ? { sessionFile: subagentSessionFile } : {}),
        });
      } catch {
        // Session handles are advisory; a throwing consumer must not break the run.
      }

      // Every event counts as progress for stall detection. The same subscription
      // suppresses post-success threshold compaction: a one-shot child has no next
      // prompt that could use that summary. Error/overflow turns remain enabled,
      // and a queued continuation restores compaction as soon as its agent run starts.
      const notifyActivity = options.onActivity;
      const onFeed = options.onFeedEvent;
      unsubscribeSession = session.subscribe((event) => {
        try {
          notifyActivity?.();
        } catch {
          /* stall-timer reset is best-effort */
        }
        try {
          if (event.type === "agent_start") {
            if (boundaryActive) {
              continuationStarted = true;
              boundaryEvidenceSeen = true;
            }
            restoreTerminalCompaction();
            resolveBoundaryWait();
          } else if (event.type === "agent_end") {
            if (!event.willRetry) {
              lastFinalAgentEndMessages = event.messages;
            }
          } else if (event.type === "agent_settled") {
            if (continuationStarted) continuationSettled = true;
            // The run that followed the boundary has settled. Its extension
            // handlers (which queue the next continuation, if any) already ran
            // before this event, so re-evaluating here sees the next run's
            // agent_start too. Wake the boundary wait.
            resolveBoundaryWait();
          } else if (event.type === "compaction_start") {
            if (boundaryActive) {
              compactionStarted = true;
              boundaryEvidenceSeen = true;
            }
            resolveBoundaryWait();
          } else if (event.type === "compaction_end") {
            compactionEnded = true;
            resolveBoundaryWait();
          } else if (event.type === "message_end") {
            const assistant = event.message as Partial<AssistantMessage>;
            if (
              assistant.role === "assistant" &&
              (assistant.stopReason === "error" || assistant.stopReason === "aborted")
            ) {
              // Reset the boundary state at the candidate terminal so the
              // post-prompt check only sees lifecycle events that follow it.
              boundaryActive = true;
              continuationStarted = false;
              continuationSettled = false;
              compactionStarted = false;
              compactionEnded = false;
              graceAttempted = false;
            } else if (assistant.role === "assistant" && assistant.stopReason === "stop") {
              suppressTerminalCompaction();
            }
          } else if (
            event.type === "tool_execution_end" &&
            event.toolName === "structured_output" &&
            !event.isError &&
            capture.called
          ) {
            // structured_output terminates on its tool result, so its final
            // assistant has stopReason=toolUse rather than stop.
            suppressTerminalCompaction();
          }
        } catch {
          /* terminal compaction suppression is best-effort */
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

      if (options.signal) {
        // AgentSession.abort() does not cancel compaction. Abort both operations so
        // a stalled/killed child cannot sit in a native adapter's timeout before the
        // workflow retry starts. Swallow abort() rejection during teardown.
        let abortStarted = false;
        const onAbort = () => {
          if (abortStarted) return;
          abortStarted = true;
          combinedAborted = true;
          // A pending boundary wait must not outlive an abort: release it so
          // promptSession can re-check and surface the abort as a failure.
          resolveBoundaryWait();
          session.abortCompaction();
          session.abortBranchSummary();
          session.abort().catch(() => {});
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        // Close the addEventListener race: an already-aborted signal does not fire
        // a newly attached listener.
        if (options.signal.aborted) onAbort();
      }

      // Wait for the next boundary-relevant session event (a run settle, a
      // self-started run, a compaction transition) or, with a grace timeout,
      // for the evidence window to elapse. The stall timer stays armed and
      // every session event resets it, and an abort releases the wait
      // immediately via resolveBoundaryWait(), so this cannot hang.
      const waitForBoundaryProgress = (graceMs?: number): Promise<void> =>
        new Promise<void>((resolve) => {
          boundaryWaitResolve = resolve;
          if (graceMs !== undefined && boundaryGraceTimer === undefined) {
            boundaryGraceTimer = setTimeout(() => {
              boundaryGraceTimer = undefined;
              resolve();
            }, graceMs);
          }
          if (combinedAborted) resolve();
        });

      const promptSession = async (text: string): Promise<AssistantMessage> => {
        const priorEntryIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
        try {
          await session.prompt(text);
        } finally {
          restoreTerminalCompaction();
        }
        if (options.signal?.aborted) throw new Error("Subagent was aborted");
        let terminal = this.currentTerminalAssistant(sessionManager.getBranch(), priorEntryIds);
        if (!terminal) throw new Error("Subagent completed without an assistant response");

        // Mid-turn compaction boundary: an extension (for example the
        // mid-turn-compact extension) may deliberately abort the run at a
        // tool-follow-up turn so Pi's post-run compaction can shrink the
        // context, then queue a continuation user message. That continuation
        // run starts on its own — the engine never asked for it — while
        // session.prompt() is still awaiting the settled lifecycle, so a
        // self-started run (or an in-flight manual compaction that will
        // produce one) after an error terminal is evidence of a boundary, not
        // a failure: wait for the continuation's terminal and treat it as the
        // attempt's result. Without that evidence, fail exactly as before.
        for (let boundary = 0; boundary < MAX_MID_TURN_BOUNDARIES; boundary++) {
          if (terminal.stopReason !== "error" && terminal.stopReason !== "aborted") break;
          const compactionInFlight = compactionStarted && !compactionEnded;
          if (!continuationStarted && !compactionInFlight) {
            // No continuation evidence yet. A settle may have just happened
            // with the next continuation's run still in preflight (its
            // agent_start fires a few microtasks after the settle event), so
            // give that race one bounded grace. Real failures without any
            // boundary evidence never get here and keep failing immediately.
            if (!boundaryEvidenceSeen || graceAttempted) break; // real failure
            graceAttempted = true;
            await waitForBoundaryProgress(BOUNDARY_EVIDENCE_GRACE_MS);
            if (combinedAborted) throw new Error("Subagent was aborted");
            continue; // re-evaluate: evidence may have arrived
          }
          if (!continuationSettled) {
            // Continuation run is running (or will start after an in-flight
            // manual compaction). Wait for its agent_settled; the stall timer
            // stays armed and every session event resets it, so this wait
            // cannot outlive a stalled session, and an abort releases it
            // immediately via resolveBoundaryWait().
            await waitForBoundaryProgress();
          }
          if (combinedAborted) throw new Error("Subagent was aborted");
          const continuationMessages = lastFinalAgentEndMessages;
          const continuationTerminal = continuationMessages ? lastAssistantMessage(continuationMessages) : undefined;
          if (continuationTerminal) terminal = continuationTerminal;
          if (!terminal) throw new Error("Subagent completed without an assistant response");
        }
        this.assertTerminalAssistant(terminal);
        return terminal;
      };

      const terminal = await promptSession(
        this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)),
      );

      if (options.schema) {
        // Re-prompt with a firm nudge if the subagent forgot to call structured_output.
        for (let attempt = 0; !capture.called && attempt < this.structuredOutputRetries; attempt++) {
          await promptSession(STRUCTURED_OUTPUT_NUDGE);
        }
        if (!capture.called) {
          throw new Error(
            `Subagent finished without calling structured_output after ${this.structuredOutputRetries} retries`,
          );
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      if (terminal.stopReason !== "stop") {
        throw new Error(`Subagent ended without a final text response (stopReason=${terminal.stopReason})`);
      }
      const text = this.assistantText(terminal);
      if (!text.trim()) throw new Error("Subagent completed without a text response");
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      restoreTerminalCompaction();
      // Release any pending boundary wait and its grace timer so neither can
      // outlive the attempt (a stray timer would keep the process alive).
      resolveBoundaryWait();
      unsubscribeSession?.();
      removeAbortListener?.();
      try {
        const telemetry = collectTelemetry(sessionManager.getEntries(), Date.now() - started);
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

  private currentTerminalAssistant(
    entries: readonly SessionEntry[],
    priorEntryIds: ReadonlySet<string>,
  ): AssistantMessage | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (priorEntryIds.has(entry.id) || entry.type !== "message") continue;
      const message = entry.message as Partial<AssistantMessage>;
      if (message.role === "assistant" && Array.isArray(message.content)) return message as AssistantMessage;
    }
    return undefined;
  }

  private assertTerminalAssistant(message: AssistantMessage): void {
    if (message.stopReason === "error") {
      throw new Error(`Subagent provider failed: ${message.errorMessage?.trim() || "unknown provider error"}`);
    }
    if (message.stopReason === "aborted") throw new Error("Subagent was aborted");
    if (message.stopReason === "pending") throw new Error("Subagent returned an incomplete pending response");
    if (message.stopReason === "length") throw new Error("Subagent response was truncated at the model output limit");
  }

  private assistantText(message: AssistantMessage): string {
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
}

function collectTelemetry(entries: readonly SessionEntry[], elapsedMs: number): WorkflowAgentTelemetry {
  const usage = sumUsage(entries);
  return {
    ...(usage ? { usage, tokens: usage.totalTokens } : {}),
    toolCalls: countToolCalls(entries),
    elapsedMs,
  };
}

function sumUsage(entries: readonly SessionEntry[]): WorkflowAgentUsage | undefined {
  let sawUsage = false;
  const total: WorkflowAgentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const entry of entries) {
    let usage: unknown;
    if (entry.type === "message") {
      const message = entry.message as Partial<AssistantMessage> & { usage?: unknown };
      if (message.role === "assistant" || message.role === "toolResult") usage = message.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage;
    }
    if (!isUsage(usage)) continue;
    sawUsage = true;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
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

function countToolCalls(entries: readonly SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length;
}
