import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { Model } from "@earendil-works/pi-ai";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import {
  collapseLine,
  WorkflowAgent,
  type WorkflowAgentFeedEvent,
  type WorkflowAgentOptions,
  type WorkflowAgentSessionHandle,
  type WorkflowAgentTelemetry,
  type WorkflowAgentUsage,
} from "./agent.js";
import type { ResolvedAgentType } from "./agent-types.js";
import { agentKey, generateRunId, WorkflowJournal } from "./journal.js";
import { type WorktreeLease, WorktreeManager } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /**
   * Bound on SYNCHRONOUS vm evaluation only (ms, default 30000). This is the
   * `timeout` passed to vm.Script#runInContext, matching Claude Code's internal
   * sync-only runInContext timeout (mf6). It catches an await-free infinite loop
   * (`while (true) {}`) but does NOT bound the async phase: once the body hits its
   * first `await` the work runs outside this timeout. There is deliberately NO
   * whole-run wall-clock deadline — a workflow spends ~all its time awaiting real
   * subagent LLM turns (minutes each), so a per-run clock would falsely kill it.
   * Async runaways are bounded by maxAgents + abort + the per-subagent budget.
   */
  scriptTimeoutMs?: number;
  /**
   * Per-agent STALL timeout (ms, default 180000 / 3 min), mirroring Claude Code's
   * activity-reset stall detection: an attempt is aborted only after this long
   * with NO subagent activity — streaming deltas and tool executions reset the
   * timer (the runner reports them via onActivity). A stalled attempt is retried
   * up to stallRetries times; exhaustion is a normal per-agent failure (null +
   * log), never a whole-run error. There is deliberately NO fixed per-agent
   * wall-clock budget: long tool-heavy turns that keep making progress never trip.
   */
  stallTimeoutMs?: number;
  /** Retries per agent after a stall (default 5, matching Claude Code). */
  stallRetries?: number;
  /**
   * Resolve a script-level `agent(..., { model })` reference ('provider/model-id'
   * or bare model id) to a real Model. When absent or unresolvable, the reference
   * degrades to a prompt hint (plus a log line) and the session model is used.
   */
  resolveModel?: (ref: string) => Model<any> | undefined;
  /** Resolve `agent(..., { agentType })` to a named subagent definition. */
  resolveAgentType?: (name: string) => ResolvedAgentType | undefined;
  /**
   * Resolve `workflow(name, args)` to a saved workflow's script source (the
   * registry hook). Nesting is limited to one level, like Claude Code.
   */
  resolveWorkflow?: (name: string) => string | undefined;
  /** Base directory for isolation:'worktree' checkouts (default: a per-run temp dir). */
  worktreeDir?: string;
  /** Cap on actual agent() SPAWNS (default 1000); cached replays do not count. Exceeding it aborts the run. */
  maxAgents?: number;
  /** Run id for journaling. Generated when absent. */
  runId?: string;
  /** Resume a previous run by id: replays its journal so completed agents are skipped. */
  resumeFromRunId?: string;
  /** Base directory that holds per-run journals. Defaults to `<cwd>/.pi-workflow-runs`. */
  journalDir?: string;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { id: number; label: string; phase?: string; prompt: string }) => void;
  onAgentEnd?: (event: {
    id: number;
    label: string;
    phase?: string;
    result: unknown;
    telemetry?: WorkflowAgentTelemetry;
    /** True when the agent was manually killed (workflow_tasks / run controls). */
    killed?: boolean;
  }) => void;
  /** Receives this run's live controls (per-agent kill) once, before the script starts. */
  onRunControls?: (controls: WorkflowRunControls) => void;
}

/** One outcome from WorkflowRunControls.killAgents. */
export interface WorkflowAgentKillResult {
  id: number;
  label?: string;
  killed: boolean;
  /** Why the kill was a no-op (e.g. the agent is not currently running). */
  reason?: string;
}

/**
 * Session access for one agent: live message reads while the subagent runs,
 * and the persisted messages.jsonl path once it finished. Model id and
 * thinking level ride along for inspection headers.
 */
export interface WorkflowAgentSessionInfo {
  live: boolean;
  /** Live session reads while running; the capped final snapshot once finished. */
  getMessages?: () => readonly unknown[];
  /**
   * Cumulative telemetry through the current attempt. During a stall retry this
   * includes completed attempts plus usage reported by the active session.
   */
  getTelemetry?: () => WorkflowAgentTelemetry;
  /** Newest persisted attempt (attempt 1 plain, stall retries suffixed .retryN). */
  messagesPath?: string;
  /**
   * Persisted pi child session file (see WorkflowAgentSessionPersistence);
   * openable with `pi --session <path>`. Live entries carry the up-front path
   * the session WILL flush to; finished entries only keep flush-verified paths.
   */
  sessionFile?: string;
  model?: string;
  thinkingLevel?: string;
}

/** Snapshot of one agent's activity feed (bounded ring buffer + live text tail). */
export interface WorkflowAgentFeed {
  /** Formatted activity lines, oldest first (capped at FEED_MAX_LINES). */
  lines: string[];
  /** In-progress assistant text tail (streaming; cleared on message end). */
  liveText: string;
  /** Full transcript file (complete assistant texts + tool lines), when writable. */
  transcriptPath?: string;
}

/**
 * Live controls for a workflow run in flight. Kills target the per-agent ordinal
 * ids reported by onAgentStart/onAgentEnd (and surfaced by workflow_tasks
 * status). A killed agent's `agent()` call resolves to null exactly like a
 * stall-exhausted one — logged, NOT journaled — so a later resumeFromRunId
 * re-runs it while completed agents replay from cache.
 */
export interface WorkflowRunControls {
  killAgents(ids: number[]): WorkflowAgentKillResult[];
  /** Activity feed for any agent that has started in this run (live or finished). */
  getAgentFeed(id: number): WorkflowAgentFeed | undefined;
  /** Session access (live messages or persisted messages.jsonl) for any started agent. */
  getAgentSession(id: number): WorkflowAgentSessionInfo | undefined;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  /** Tokens charged to the workflow budget (actual when provider usage exists, estimated for custom runners). */
  spentTokens: number;
  /** Sum of actual provider usage reported by subagents. Omitted when no subagent reported usage. */
  tokenUsage?: WorkflowAgentUsage;
  /** Id of this run; pass as resumeFromRunId to continue it. */
  runId: string;
}

/** Bounds the SYNCHRONOUS vm evaluation slice only (matches Claude Code's mf6). */
const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;
/** Lifetime cap on actual agent() spawns; the primary async-runaway bound (Claude Code's 1000). */
const DEFAULT_MAX_AGENTS = 1000;
/** Per-agent stall timeout: aborts an attempt after this long with NO activity (Claude Code: 180s). */
const DEFAULT_STALL_TIMEOUT_MS = 180_000;
/** Stall retries per agent (Claude Code: 5). */
const DEFAULT_STALL_RETRIES = 5;
/** Max items per parallel()/pipeline() call — an explicit error, not silent truncation (Claude Code: 4096). */
const MAX_COLLECTION_ITEMS = 4096;
/** Max workflow script size in bytes, enforced at parse time (Claude Code: 512KB). */
export const MAX_SCRIPT_BYTES = 524_288;
/** Max log() entries kept per run; one sentinel line is appended when tripped (Claude Code: 1000). */
const MAX_LOG_ENTRIES = 1000;
/** Concurrent worktree slots for isolation:'worktree' (Claude Code: 50). */
const WORKTREE_SLOTS = 50;

/** Internal marker for stall-retry exhaustion so the failure log keeps the [stall] prefix. */
class WorkflowStallError extends Error {}

/** Internal marker for a manual per-agent kill: logs with [kill] and skips the stall-retry loop. */
class WorkflowKillError extends Error {}

/** Ring-buffer cap for per-agent activity feed lines. */
const FEED_MAX_LINES = 200;
/** Per-string cap when persisting session messages (keeps messages.jsonl bounded). */
const MESSAGE_STRING_CAP = 16_384;

/** Deep-cap long strings inside a message before persistence. */
function capLongStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MESSAGE_STRING_CAP
      ? `${value.slice(0, MESSAGE_STRING_CAP)}…[truncated ${value.length - MESSAGE_STRING_CAP} chars]`
      : value;
  }
  // Arrays honor the same depth cap as objects: the bound exists to keep
  // recursion finite on pathological nesting (deep values pass through as-is).
  if (Array.isArray(value)) return depth < 8 ? value.map((item) => capLongStrings(item, depth + 1)) : value;
  if (value && typeof value === "object" && depth < 8) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = capLongStrings(item, depth + 1);
    return out;
  }
  return value;
}

/**
 * Persist a subagent's final message array as JSONL (one capped message per
 * line) so the session view can replay finished agents. Best-effort: returns
 * the path on success, undefined when the disk says no.
 */
function persistAgentMessages(filePath: string, messages: readonly unknown[]): string | undefined {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Messages arrive pre-capped (the same bounded copy backs the in-memory
    // finished-session handle), so persistence is serialize-only.
    const lines = messages.map((message) => {
      try {
        return JSON.stringify(message);
      } catch {
        return JSON.stringify({ role: "unserializable" });
      }
    });
    fs.writeFileSync(filePath, lines.length ? `${lines.join("\n")}\n` : "");
    return filePath;
  } catch {
    return undefined;
  }
}
/** Cap for the streaming live-text tail kept per agent. */
const FEED_LIVE_TEXT_MAX = 2_000;

/** Mutable per-agent feed state plus its event handler and lifecycle hooks. */
interface AgentFeedState {
  feed: { lines: string[]; liveText: string; transcriptPath?: string };
  onFeedEvent: (event: WorkflowAgentFeedEvent) => void;
  finish: (status: string) => void;
}

function transcriptSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "agent";
}

/**
 * Create the per-agent activity feed: a bounded line buffer + live text tail in
 * memory, and a full transcript appended incrementally to
 * `<runDir>/agents/<ordinal>-<label>.md` (complete assistant texts; streaming
 * deltas only feed the in-memory tail). All fs work is best-effort — a failing
 * disk can never break the run — and the first append failure disables further
 * writes for this agent.
 */
function createAgentFeed(args: {
  runDir: string;
  ordinal: number;
  label: string;
  phase?: string;
  prompt: string;
}): AgentFeedState {
  const feed: AgentFeedState["feed"] = { lines: [], liveText: "" };
  let appendLine: (line: string) => void = () => {};
  try {
    const agentsDir = path.join(args.runDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    const transcriptPath = path.join(
      agentsDir,
      `${String(args.ordinal).padStart(3, "0")}-${transcriptSlug(args.label)}.md`,
    );
    const header = [
      `# agent #${args.ordinal} — ${args.label}`,
      "",
      `- phase: ${args.phase ?? "(none)"}`,
      `- started: ${new Date().toISOString()}`,
      "",
      "## Prompt",
      "",
      args.prompt,
      "",
      "## Activity",
      "",
    ].join("\n");
    fs.writeFileSync(transcriptPath, `${header}\n`);
    feed.transcriptPath = transcriptPath;
    appendLine = (line: string) => {
      try {
        fs.appendFileSync(transcriptPath, `${line}\n`);
      } catch {
        appendLine = () => {};
      }
    };
  } catch {
    // Transcript unavailable; in-memory feed still works.
  }

  const pushLine = (line: string) => {
    feed.lines.push(line);
    if (feed.lines.length > FEED_MAX_LINES) feed.lines.splice(0, feed.lines.length - FEED_MAX_LINES);
  };
  const stamp = () => new Date().toISOString().slice(11, 19);

  return {
    feed,
    onFeedEvent: (event) => {
      switch (event.kind) {
        case "tool_start": {
          const line = `⚒ ${event.toolName}${event.argsPreview ? `: ${event.argsPreview}` : ""}`;
          pushLine(line);
          appendLine(`[${stamp()}] ${line}`);
          break;
        }
        case "tool_error": {
          const line = `✗ ${event.toolName} failed${event.errorPreview ? `: ${event.errorPreview}` : ""}`;
          pushLine(line);
          appendLine(`[${stamp()}] ${line}`);
          break;
        }
        case "text_delta":
          feed.liveText = (feed.liveText + event.delta).slice(-FEED_LIVE_TEXT_MAX);
          break;
        case "assistant_text":
          pushLine(`💬 ${collapseLine(event.text, 140)}`);
          appendLine(`\n[${stamp()}] assistant:\n${event.text}\n`);
          feed.liveText = "";
          break;
      }
    },
    finish: (status) => {
      feed.liveText = "";
      appendLine(`\n[${stamp()}] — ${status}`);
    },
  };
}

/**
 * Prelude run INSIDE the sandbox context (not on the host) to make the
 * context-local intrinsics deterministic. This mirrors Claude Code: shim the
 * sandbox's own Math/Date, never the host's. It is defense-in-depth on top of
 * the source-level AST determinism checks and catches aliased bypasses such as
 * `const m = Math; m.random()`.
 */
const DETERMINISM_SHIM = `
(() => {
  const banned = (name) => () => {
    throw new Error(name + " is unavailable: workflow scripts must be deterministic");
  };
  Math.random = banned("Math.random()");
  Date.now = banned("Date.now()");
  const RealDate = Date;
  const DeterministicDate = function Date(...args) {
    if (args.length === 0) {
      throw new Error("new Date() is unavailable: workflow scripts must be deterministic");
    }
    return Reflect.construct(RealDate, args, new.target ? new.target : DeterministicDate);
  };
  DeterministicDate.prototype = RealDate.prototype;
  Object.defineProperty(DeterministicDate.prototype, "constructor", {
    value: DeterministicDate,
    writable: false,
    configurable: false,
  });
  DeterministicDate.UTC = RealDate.UTC;
  DeterministicDate.parse = RealDate.parse;
  DeterministicDate.now = banned("Date.now()");
  globalThis.Date = DeterministicDate;
})();
`;

/**
 * Strip the prototype chain and constructor/prototype escape hatches off an
 * injected host callable. Without this, a script can reach the host realm via
 * `someInjectedFn.constructor("return process")()`. Severing the [[Prototype]]
 * to null is what actually closes the escape; the deletes are belt-and-suspenders.
 * They are guarded because `delete fn.prototype` on a normal (non-arrow) function
 * throws a TypeError in strict mode (Function.prototype is non-configurable).
 */
function harden<F extends (...args: any[]) => any>(fn: F): F {
  Object.setPrototypeOf(fn, null);
  try {
    delete (fn as { constructor?: unknown }).constructor;
  } catch {
    /* non-configurable own prop; the null prototype already severs the escape */
  }
  try {
    delete (fn as { prototype?: unknown }).prototype;
  } catch {
    /* non-configurable own prop; the null prototype already severs the escape */
  }
  return fn;
}

/**
 * Sever the [[Prototype]] of an injected container object so a script cannot
 * climb `obj.constructor.constructor("return process")()` into the host realm.
 * Without this, every host-created object literal handed to the sandbox bridges
 * to the host Function via its prototype chain. Freezes after detaching.
 */
function hardenObject<O extends object>(obj: O): O {
  Object.setPrototypeOf(obj, null);
  return Object.freeze(obj);
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  /** Set once the MAX_LOG_ENTRIES cap tripped; further log() calls are dropped. */
  logsSuppressed?: boolean;
  phases: string[];
  agentCount: number;
  /** Subagents actually spawned (excludes journal-cached replays). Gated by maxAgents. */
  spawned: number;
  spent: number;
  usage: WorkflowAgentUsage;
  hasActualUsage: boolean;
  /** Monotonic ordinal incremented synchronously at the top of every agent() call. */
  ordinal: number;
  /**
   * Set once a non-recoverable control-flow condition trips (the maxAgents spawn
   * cap). parallel()/pipeline() rethrow instead of swallowing to null when this is
   * set, so the runaway error cannot be caught by the per-thunk try/catch and
   * silently turned into nulls. (There is no longer a whole-run deadline; a
   * per-subagent budget timeout is a recoverable agent failure, not a fatal.)
   */
  fatal?: Error;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const DETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date()/Date.now()/Math.random()/new Date() are unavailable";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    spawned: 0,
    spent: 0,
    usage: emptyUsage(),
    hasActualUsage: false,
    ordinal: 0,
  };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const stallRetries = Math.max(0, options.stallRetries ?? DEFAULT_STALL_RETRIES);
  const scriptCwd = options.cwd ?? process.cwd();

  const runId = options.resumeFromRunId ?? options.runId ?? generateRunId();
  const journal = WorkflowJournal.open({
    cwd: scriptCwd,
    runId,
    journalDir: options.journalDir,
  });

  // Worktree manager for agent({ isolation: 'worktree' }). Created lazily on first
  // use; checkouts live under a per-run temp dir and a 50-slot limiter bounds
  // concurrent worktrees (Claude Code parity).
  let worktreeManager: WorktreeManager | undefined;
  const getWorktreeManager = (): WorktreeManager => {
    worktreeManager ??= new WorktreeManager({
      repoCwd: scriptCwd,
      baseDir: options.worktreeDir ?? path.join(os.tmpdir(), "pi-workflow-worktrees", runId),
      maxSlots: WORKTREE_SLOTS,
    });
    return worktreeManager;
  };

  const log = (message: string) => {
    if (state.logsSuppressed) return;
    const text = String(message);
    if (state.logs.length >= MAX_LOG_ENTRIES) {
      // Mirror Claude Code's 1000-entry journal log cap: one sentinel, then drop.
      state.logsSuppressed = true;
      const note = `[log] cap reached (${MAX_LOG_ENTRIES} entries); further log() output suppressed`;
      state.logs.push(note);
      options.onLog?.(note);
      return;
    }
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: string) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  };

  const budget = hardenObject({
    total: options.tokenBudget ?? null,
    spent: harden(() => state.spent),
    remaining: harden(() => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent))),
  });

  /** Trip a non-recoverable condition (maxAgents cap). The error is sticky so it cannot be swallowed. */
  const fatal = (message: string): Error => {
    const error = new Error(message);
    if (!state.fatal) state.fatal = error;
    return state.fatal;
  };

  const throwIfAborted = () => {
    // A fatal (maxAgents cap) condition propagates like an abort: parallel()/pipeline()
    // rethrow it instead of converting to null.
    if (state.fatal) throw state.fatal;
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  /**
   * One stall-guarded attempt of a subagent turn. The stall timer mirrors Claude
   * Code: it aborts the attempt after stallTimeoutMs of NO activity, and any
   * subagent session activity (stream deltas, tool executions) resets it via the
   * runner's onActivity callback. Returns { ok: false } only for a stall; all
   * other failures (and whole-run aborts) propagate to the caller.
   */
  const runAttempt = async (
    prompt: string,
    runnerOptions: Record<string, unknown>,
    killState?: { label: string; killed: boolean; controller: AbortController },
  ): Promise<{ ok: true; result: unknown } | { ok: false }> => {
    const stallController = new AbortController();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const onStall = () => {
      stalled = true;
      stallController.abort();
    };
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      // Keep the guard referenced: a headless runner may be waiting only on the
      // abort signal, and an unref'ed timer lets Node exit before it fires.
      stallTimer = setTimeout(onStall, stallTimeoutMs);
    };
    armStallTimer();
    const signals = [stallController.signal];
    if (options.signal) signals.push(options.signal);
    if (killState) signals.push(killState.controller.signal);
    const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const result = await agentRunner.run(prompt, {
        ...runnerOptions,
        signal: combinedSignal,
        onActivity: () => {
          if (!stalled) armStallTimer();
        },
      } as any);
      return { ok: true, result };
    } catch (error) {
      if (state.fatal || options.signal?.aborted) throw error;
      // A manual kill aborts the attempt like a stall, but must NOT retry.
      if (killState?.killed) throw new WorkflowKillError(`agent "${killState.label}" killed`);
      if (stalled) return { ok: false };
      throw error;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  };

  // Live per-agent kill registry for THIS run. Entries exist only while an agent
  // attempt is actually running (queued/replayed agents are not killable), keyed
  // by the same ordinal id reported in onAgentStart/onAgentEnd events.
  const killControls = new Map<number, { label: string; kill: () => void }>();
  // Per-agent activity feeds, kept for the whole run (post-mortem inspection of
  // finished agents). Cached replays never create feeds (their transcript, if
  // any, lives in the original run's directory).
  const agentFeeds = new Map<number, AgentFeedState>();
  // Per-agent session access: live message reads while running, persisted
  // messages.jsonl after the agent settles.
  const agentSessions = new Map<number, WorkflowAgentSessionInfo>();
  options.onRunControls?.({
    killAgents: (ids) =>
      ids.map((id) => {
        const entry = killControls.get(id);
        if (!entry) return { id, killed: false, reason: "not running" };
        entry.kill();
        return { id, label: entry.label, killed: true };
      }),
    getAgentFeed: (id) => {
      const state = agentFeeds.get(id);
      if (!state) return undefined;
      return {
        lines: [...state.feed.lines],
        liveText: state.feed.liveText,
        ...(state.feed.transcriptPath ? { transcriptPath: state.feed.transcriptPath } : {}),
      };
    },
    getAgentSession: (id) => {
      const entry = agentSessions.get(id);
      return entry ? { ...entry } : undefined;
    },
  });

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    // Increment the ordinal SYNCHRONOUSLY before any await / before the limiter so
    // that single-threaded, deterministic scripts produce stable ordinals across
    // replays, including inside parallel()/pipeline().
    const ordinal = ++state.ordinal;
    const key = agentKey(ordinal, prompt, agentOptions.label, agentOptions.schema ?? null, {
      model: agentOptions.model ?? null,
      agentType: agentOptions.agentType ?? null,
      isolation: agentOptions.isolation ?? null,
    });
    throwIfAborted();
    const assignedPhase = agentOptions.phase ?? state.currentPhase;
    const requestedLabel = agentOptions.label?.trim();

    // Resume: a journaled result short-circuits the spawn entirely (no limiter, no
    // subagent, and crucially WITHOUT counting against the maxAgents spawn cap, since
    // a cached replay performs no fan-out).
    if (journal.has(key)) {
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      const cached = journal.get(key);
      const telemetry = completeTelemetry(cached, journal.getTelemetry(key));
      options.onAgentStart?.({ id: ordinal, label, phase: assignedPhase, prompt });
      recordTelemetry(state, telemetry);
      options.onAgentEnd?.({ id: ordinal, label, phase: assignedPhase, result: cached, telemetry });
      return cached;
    }

    // The cap bounds actual SPAWNS (runaway fan-out), not cached replays. Trip a
    // sticky fatal error so parallel()/pipeline() rethrow rather than swallow it.
    if (++state.spawned > maxAgents) {
      throw fatal(`workflow exceeded maxAgents cap (${maxAgents}); aborting to prevent runaway fan-out`);
    }

    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");

    return limiter(async () => {
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      options.onAgentStart?.({ id: ordinal, label, phase: assignedPhase, prompt });

      // Registered for the whole limiter slot (including stall retries); removed in
      // the finally below so finished agents are never killable.
      const killState = { label, killed: false, controller: new AbortController() };
      killControls.set(ordinal, {
        label,
        kill: () => {
          killState.killed = true;
          killState.controller.abort();
        },
      });
      const feedState = createAgentFeed({ runDir: journal.runDir, ordinal, label, phase: assignedPhase, prompt });
      agentFeeds.set(ordinal, feedState);
      // Per-ATTEMPT messages files: stall retries create fresh sessions, and each
      // attempt's teardown persists separately. Write-once paths (attempt 1 plain,
      // retries suffixed .retryN) mean path-keyed caches can never serve a stale
      // attempt, and stalled attempts' conversations are preserved for forensics.
      // The session entry always points at the newest file.
      // Display name for the persisted pi child session (when the run has
      // sessionPersistence); stall retries get a `· retryN` suffix matching the
      // .retryN messages files so the resume picker distinguishes attempts.
      const sessionNameBase = `workflow ${journal.runId} · #${ordinal} ${label}`;
      let sessionEndCount = 0;
      const messagesPathFor = (attempt: number) =>
        path.join(
          journal.runDir,
          "agents",
          `${String(ordinal).padStart(3, "0")}-${transcriptSlug(label)}${attempt > 1 ? `.retry${attempt}` : ""}.messages.jsonl`,
        );

      let attemptTelemetry: WorkflowAgentTelemetry | undefined;
      let cumulativeTelemetry: WorkflowAgentTelemetry | undefined;
      const agentStarted = Date.now();
      let worktree: WorktreeLease | undefined;
      try {
        throwIfAborted();

        // REAL per-agent option wiring (Claude Code parity): `model` resolves through
        // the host model registry, `agentType` resolves a named subagent definition
        // (role prompt + optional model/tool allowlist), and `isolation: 'worktree'`
        // creates an actual detached git worktree. Unresolvable references degrade to
        // the previous prompt-hint behavior with a log line.
        let resolvedModel: Model<any> | undefined;
        if (agentOptions.model) {
          resolvedModel = options.resolveModel?.(agentOptions.model);
          if (!resolvedModel) log(`agent ${label}: model '${agentOptions.model}' not found; using the session model`);
        }
        let agentType: ResolvedAgentType | undefined;
        if (agentOptions.agentType) {
          agentType = options.resolveAgentType?.(agentOptions.agentType);
          if (!agentType) {
            log(`agent ${label}: agentType '${agentOptions.agentType}' not found; passing it as a prompt hint`);
          } else if (!resolvedModel && agentType.model && options.resolveModel) {
            resolvedModel = options.resolveModel(agentType.model);
            if (!resolvedModel) {
              log(`agent ${label}: agentType model '${agentType.model}' not found; using the session model`);
            }
          }
        }
        if (agentOptions.isolation === "worktree") {
          // Throws when the cwd is not a git repo / git is unavailable; that is a
          // normal per-agent failure (caught below → null + log).
          worktree = await getWorktreeManager().acquire(`agent-${ordinal}`, options.signal);
        }

        const runnerOptions: Record<string, unknown> = {
          label,
          sessionName: sessionNameBase,
          schema: agentOptions.schema,
          instructions: buildAgentInstructions(assignedPhase, agentOptions, {
            agentType,
            worktreeCwd: worktree?.cwd,
            modelResolved: Boolean(resolvedModel),
          }),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(worktree ? { cwd: worktree.cwd } : {}),
          ...(agentType?.toolNames?.length ? { toolNames: agentType.toolNames } : {}),
          onTelemetry(event: WorkflowAgentTelemetry) {
            // WorkflowAgent reports once in its finally. Keep only the latest
            // callback for this attempt, then fold it into the cumulative total
            // exactly once after runAttempt settles.
            attemptTelemetry = event;
          },
          onFeedEvent: feedState.onFeedEvent,
          onSessionHandle: (handle: WorkflowAgentSessionHandle) => {
            // Freeze the completed-attempt baseline for THIS new session. The
            // live reader then adds only the current attempt, so a stall retry
            // neither resets the displayed count nor double-counts its predecessor.
            const priorAttemptTelemetry = cumulativeTelemetry;
            const readCurrentTelemetry = handle.getTelemetry;
            const getTelemetry = readCurrentTelemetry
              ? () => {
                  const current = readCurrentTelemetry();
                  return priorAttemptTelemetry ? mergeTelemetry(priorAttemptTelemetry, current) : current;
                }
              : priorAttemptTelemetry
                ? () => priorAttemptTelemetry
                : undefined;
            agentSessions.set(ordinal, {
              live: true,
              getMessages: handle.getMessages,
              ...(getTelemetry ? { getTelemetry } : {}),
              ...(handle.sessionFile ? { sessionFile: handle.sessionFile } : {}),
              ...(handle.model ? { model: handle.model } : {}),
              ...(handle.thinkingLevel ? { thinkingLevel: handle.thinkingLevel } : {}),
            });
          },
          onSessionEnd: (messages: readonly unknown[]) => {
            sessionEndCount++;
            const prior = agentSessions.get(ordinal);
            // Cap once: the same bounded copy backs the in-memory finished handle
            // (fast same-run inspection, no fs round-trip) and the persisted JSONL.
            const capped = messages.map((message) => capLongStrings(message));
            const persisted = persistAgentMessages(messagesPathFor(sessionEndCount), capped);
            agentSessions.set(ordinal, {
              live: false,
              getMessages: () => capped,
              ...(prior?.getTelemetry ? { getTelemetry: prior.getTelemetry } : {}),
              ...(persisted ? { messagesPath: persisted } : {}),
              // Take the pi child session path from THIS ATTEMPT's telemetry, not
              // the live handle or cumulative prior attempts: agent.run's finally
              // fires onTelemetry (existsSync-verified) before onSessionEnd.
              ...(attemptTelemetry?.sessionFile ? { sessionFile: attemptTelemetry.sessionFile } : {}),
              ...(prior?.model ? { model: prior.model } : {}),
              ...(prior?.thinkingLevel ? { thinkingLevel: prior.thinkingLevel } : {}),
            });
          },
        };

        // Stall-retry loop (Claude Code: up to 5 retries per agent on stall).
        let result: unknown;
        for (let attemptNo = 0; ; attemptNo++) {
          attemptTelemetry = undefined;
          const attemptStarted = Date.now();
          let attempt: Awaited<ReturnType<typeof runAttempt>> | undefined;
          try {
            attempt = await runAttempt(
              prompt,
              attemptNo > 0
                ? { ...runnerOptions, sessionName: `${sessionNameBase} · retry${attemptNo + 1}` }
                : runnerOptions,
              killState,
            );
          } finally {
            // Charge every attempted session, including compacted-away usage and
            // stalled attempts. A custom runner that supplies no telemetry keeps
            // the legacy result-size estimate for a successful attempt.
            const completedAttemptTelemetry =
              attemptTelemetry ??
              (attempt?.ok ? completeTelemetry(attempt.result, undefined, attemptStarted) : undefined);
            if (completedAttemptTelemetry) {
              cumulativeTelemetry = mergeTelemetry(cumulativeTelemetry, completedAttemptTelemetry);
            }
          }
          if (!attempt) throw new Error("subagent attempt ended without an outcome");
          if (attempt.ok) {
            result = attempt.result;
            break;
          }
          if (attemptNo < stallRetries) {
            log(
              `[stall] agent "${label}" stalled (no progress) after ${Math.round(stallTimeoutMs / 1000)}s — retrying (${attemptNo + 1}/${stallRetries})`,
            );
            continue;
          }
          throw new WorkflowStallError(
            `agent "${label}" stalled (no progress) after ${Math.round(stallTimeoutMs / 1000)}s — giving up after ${stallRetries} retries`,
          );
        }

        throwIfAborted();
        const finalTelemetry = completeTelemetry(result, cumulativeTelemetry, agentStarted);
        journal.append(key, result, finalTelemetry);
        recordTelemetry(state, finalTelemetry);
        feedState.finish(`done (${finalTelemetry.tokens ?? 0} tok, ${finalTelemetry.toolCalls} tools)`);
        options.onAgentEnd?.({ id: ordinal, label, phase: assignedPhase, result, telemetry: finalTelemetry });
        return result;
      } catch (error) {
        // A real whole-run abort (Esc) or the maxAgents fatal must propagate.
        if (state.fatal || options.signal?.aborted) throw error;
        const finalTelemetry = completeTelemetry(null, cumulativeTelemetry, agentStarted);
        recordTelemetry(state, finalTelemetry);
        // Kills, stall exhaustion, and other failures are recoverable: this agent
        // resolves to null and is NOT journaled, so a resume re-runs it.
        const killed = error instanceof WorkflowKillError;
        if (killed) {
          log(`[kill] ${error.message}`);
        } else if (error instanceof WorkflowStallError) {
          log(`[stall] ${error.message}`);
        } else {
          log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        feedState.finish(killed ? "killed" : `failed: ${error instanceof Error ? error.message : String(error)}`);
        options.onAgentEnd?.({
          id: ordinal,
          label,
          phase: assignedPhase,
          result: null,
          telemetry: finalTelemetry,
          ...(killed ? { killed: true } : {}),
        });
        return null;
      } finally {
        killControls.delete(ordinal);
        // Worktree cleanup never throws (release guards internally) and frees its slot.
        if (worktree) await worktree.release(log);
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.length > MAX_COLLECTION_ITEMS) {
      throw new Error(
        `parallel() accepts at most ${MAX_COLLECTION_ITEMS} items per call (got ${thunks.length}); split the work into batches`,
      );
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (state.fatal || options.signal?.aborted) throw error;
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length > MAX_COLLECTION_ITEMS) {
      throw new Error(
        `pipeline() accepts at most ${MAX_COLLECTION_ITEMS} items per call (got ${items.length}); split the work into batches`,
      );
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (state.fatal || options.signal?.aborted) throw error;
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  const syncTimeout = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  // Assigned right before the root body runs; workflow() child runs close over it.
  let abortPromise: Promise<never> | undefined;

  /** Evaluate a (parent or child) script body in `context` under the sync-only vm timeout. */
  const runBody = (context: vm.Context, scriptBody: string, filename: string): Promise<unknown> => {
    const wrapped = `(async () => {\n${scriptBody}\n})()`;
    const scriptPromise = new vm.Script(wrapped, { filename }).runInContext(context, {
      timeout: syncTimeout,
    }) as Promise<unknown>;
    return abortPromise ? Promise.race([scriptPromise, abortPromise]) : scriptPromise;
  };

  /**
   * The `workflow(nameOrRef, args?)` sandbox primitive: run a saved/named workflow
   * inline with ONE level of nesting (Claude Code parity). The child script runs in
   * its OWN fresh sandbox context but shares the parent's agent/parallel/pipeline
   * hooks — and therefore the same concurrency limiter, spawn counter/cap, token
   * budget, journal ordinals, and abort signal. Child phase() calls are silenced and
   * child log() output is prefixed with `[childName] `. The child's own workflow()
   * global throws, capping the depth at orchestrator → parent → child → subagent.
   */
  const workflowFn = async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
    throwIfAborted();
    let source: string | undefined;
    let refName: string | undefined;
    if (typeof nameOrRef === "string") {
      refName = nameOrRef;
      source = options.resolveWorkflow?.(nameOrRef);
    } else if (
      nameOrRef &&
      typeof nameOrRef === "object" &&
      typeof (nameOrRef as { script?: unknown }).script === "string"
    ) {
      source = (nameOrRef as { script: string }).script;
    }
    if (source === undefined) {
      throw new Error(
        refName !== undefined
          ? `unknown workflow '${refName}'${options.resolveWorkflow ? "" : " (no workflow registry is wired into this run)"}`
          : "workflow() expects a workflow name string or a { script } object",
      );
    }
    const child = parseWorkflowScript(source);
    log(`workflow ${child.meta.name} started`);
    const childContext = buildContext({ childName: child.meta.name }, childArgs);
    const value = await runBody(childContext, child.body, `${child.meta.name}.js`);
    log(`workflow ${child.meta.name} completed`);
    return value;
  };

  /**
   * Build a sandbox context for the root script or a one-level child workflow.
   *
   * Do NOT pass host intrinsics (JSON/Math/Array/Object/String/...) here: that
   * shares host realm objects with the sandbox. vm.createContext seeds the
   * context with its OWN fresh intrinsics, which we then shim for determinism.
   *
   * Every injected callable is hardened (harden) and every injected container
   * object is null-prototyped + frozen (hardenObject). This is REQUIRED: a host
   * object literal handed to the sandbox keeps its [[Prototype]] chain to the
   * host Object/Function, so without severing it a script can escape via
   * `obj.constructor.constructor("return process")()`.
   *
   * `scopedArgs` must not be a host-realm object reference (its prototype chain
   * would bridge to the host Function). injectArgs serializes it to JSON on the
   * host and re-parses it INSIDE the sandbox so the resulting object uses the
   * sandbox's own intrinsics; non-JSON values (functions, symbols, cycles) are
   * rejected, so attacker-supplied args cannot smuggle host callables in.
   */
  const buildContext = (scope: { childName?: string }, scopedArgs: unknown): vm.Context => {
    const isChild = scope.childName !== undefined;
    const scopedLog = isChild ? (message: unknown) => log(`[${scope.childName}] ${String(message)}`) : log;
    const context = vm.createContext({
      agent: harden(agent),
      parallel: harden(parallel),
      pipeline: harden(pipeline),
      log: harden(scopedLog),
      // Child phase() calls are no-ops (the parent owns phase progression).
      phase: isChild ? harden(() => {}) : harden(phase),
      workflow: isChild
        ? harden(() => {
            throw new Error(
              "workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.",
            );
          })
        : harden(workflowFn),
      cwd: scriptCwd,
      process: hardenObject({ cwd: harden(() => scriptCwd) }),
      budget,
      console: hardenObject({
        log: harden((m: unknown) => scopedLog(String(m))),
        info: harden((m: unknown) => scopedLog(String(m))),
        warn: harden((m: unknown) => scopedLog(`[warn] ${String(m)}`)),
        error: harden((m: unknown) => scopedLog(`[error] ${String(m)}`)),
      }),
    });

    // Shim the context-local intrinsics for runtime determinism (defense in depth).
    new vm.Script(DETERMINISM_SHIM, { filename: "determinism-shim.js" }).runInContext(context);
    injectArgs(context, scopedArgs);
    return context;
  };

  const context = buildContext({}, options.args);

  // The vm `timeout` in runBody bounds ONLY the SYNCHRONOUS slice of evaluation,
  // matching Claude Code's internal sync-only runInContext timeout (mf6). The body
  // is wrapped in an async IIFE that returns a Promise immediately, so any work
  // after the first `await` runs OUTSIDE this timeout. We deliberately do NOT
  // impose a whole-run wall-clock deadline: a workflow spends ~all of its time
  // awaiting real subagent LLM turns (minutes each), so a per-run clock would
  // falsely kill multi-agent runs. Like Claude Code, async runaways are bounded by
  // the maxAgents lifetime cap, the abort signal, the concurrency limiter, and the
  // per-agent stall detection instead.
  //
  // We still race the script promise against an ABORT promise (not a timer) so Esc /
  // options.signal cancellation halts the run promptly even while it is awaiting.
  //
  // RESIDUAL LIMITATION (same as Claude Code): a loop that NEVER yields after the
  // first await — a pure microtask spin (`while (true) { await Promise.resolve() }`)
  // — starves the event loop, so neither abort nor any in-thread timer can interrupt
  // it. Fully bounding that would require a worker thread + worker.terminate(); out
  // of scope here. The await-free synchronous infinite loop (`while (true) {}`) IS
  // still caught by the sync-only vm timeout, and an `await agent()` loop is caught
  // by the maxAgents cap.
  // The abort listener is scoped to a local controller so it is detached on the
  // NORMAL-completion path too (see finally), not only when abort fires. Otherwise
  // a long-lived shared options.signal would accumulate one dangling listener +
  // retained reject closure per completed run.
  const abortListenerScope = new AbortController();
  abortPromise = options.signal
    ? new Promise<never>((_, reject) => {
        const signal = options.signal as AbortSignal;
        if (signal.aborted) {
          reject(new Error("workflow aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("workflow aborted")), {
          once: true,
          signal: abortListenerScope.signal,
        });
      })
    : undefined;

  try {
    const result = await runBody(context, body, `${meta.name || "workflow"}.js`);
    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: state.agentCount,
      durationMs: Date.now() - started,
      spentTokens: state.spent,
      ...(state.hasActualUsage ? { tokenUsage: state.usage } : {}),
      runId,
    };
  } finally {
    // Detach the abort listener whether the run resolved or rejected, so a
    // long-lived shared options.signal does not accumulate listeners/closures.
    abortListenerScope.abort();
    journal.close();
  }
}

/**
 * Deep-clone `args` across the realm boundary by serializing on the host and
 * re-parsing inside the sandbox, then expose it as the global `args`. Using the
 * sandbox's own JSON.parse means the resulting object/array prototype chain
 * stays within the sandbox realm (no bridge to host Function). Non-JSON values
 * (functions, symbols, undefined, cycles) are dropped/rejected by JSON.stringify,
 * so attacker-supplied args cannot smuggle host callables in.
 */
function injectArgs(context: vm.Context, args: unknown): void {
  if (args === undefined) {
    new vm.Script("globalThis.args = undefined;").runInContext(context);
    return;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch (error) {
    throw new TypeError(
      `workflow args must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // JSON.stringify returns undefined for a bare function/symbol/undefined value.
  if (serialized === undefined) {
    new vm.Script("globalThis.args = undefined;").runInContext(context);
    return;
  }
  context.__workflowArgsJson = serialized;
  new vm.Script("globalThis.args = JSON.parse(globalThis.__workflowArgsJson); delete globalThis.__workflowArgsJson;", {
    filename: "inject-args.js",
  }).runInContext(context);
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const scriptBytes = Buffer.byteLength(script, "utf8");
  if (scriptBytes > MAX_SCRIPT_BYTES) {
    throw new Error(`workflow script exceeds the ${MAX_SCRIPT_BYTES}-byte limit (got ${scriptBytes} bytes)`);
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description, phases }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function assertDeterministicAst(ast: AnyNode): void {
  walkAst(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node.callee as AnyNode | undefined;
      if (
        isIdentifier(callee, "Date") ||
        isStaticMember(callee, "Date", "now") ||
        isStaticMember(callee, "Math", "random")
      ) {
        throw new Error(DETERMINISM_ERROR);
      }
    }
    if (node.type === "NewExpression" && isIdentifier(node.callee as AnyNode | undefined, "Date")) {
      const args = (node.arguments as AnyNode[] | undefined) ?? [];
      if (args.length === 0) throw new Error(DETERMINISM_ERROR);
    }
  });
}

function walkAst(node: AnyNode, visit: (node: AnyNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) walkAst(child, visit);
      }
    } else if (isNode(value)) {
      walkAst(value, visit);
    }
  }
}

function isNode(value: unknown): value is AnyNode {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function isIdentifier(node: AnyNode | undefined, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

function isStaticMember(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || !isIdentifier(node.object as AnyNode | undefined, objectName)) return false;
  return staticPropertyName(node) === propertyName;
}

function staticPropertyName(member: AnyNode): string | undefined {
  const property = member.property as AnyNode | undefined;
  if (!property) return undefined;
  if (!member.computed && property.type === "Identifier") return property.name;
  if (member.computed && property.type === "Literal" && typeof property.value === "string") return property.value;
  return undefined;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

// Per-agent options are wired for real when the run provides resolvers
// (resolveModel/resolveAgentType) or the option is isolation:'worktree'. The
// instruction block reflects what actually happened: resolved agentTypes inject
// their role prompt, worktree isolation announces the checkout path, and only
// UNRESOLVED references degrade to the legacy prompt-hint lines.
function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  resolved: { agentType?: ResolvedAgentType; worktreeCwd?: string; modelResolved?: boolean } = {},
): string | undefined {
  const lines: string[] = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (resolved.agentType) {
    lines.push(`You are acting as the "${resolved.agentType.name}" subagent type.`);
    if (resolved.agentType.systemPrompt) lines.push(resolved.agentType.systemPrompt);
  } else if (options.agentType) {
    lines.push(`Act as workflow subagent type: ${options.agentType}`);
  }
  if (resolved.worktreeCwd) {
    lines.push(
      `You are running in an isolated git worktree (detached checkout): ${resolved.worktreeCwd}. Make ALL file changes inside it; unchanged worktrees are removed when you finish, changed ones are kept and reported.`,
    );
  } else if (options.isolation) {
    lines.push(`Requested isolation: ${options.isolation}`);
  }
  if (options.model && !resolved.modelResolved) lines.push(`Requested model hint: ${options.model}`);
  return lines.length ? lines.join("\n") : undefined;
}

function mergeTelemetry(
  total: WorkflowAgentTelemetry | undefined,
  next: WorkflowAgentTelemetry,
): WorkflowAgentTelemetry {
  const totalTokens = total?.tokens ?? total?.usage?.totalTokens;
  const nextTokens = next.tokens ?? next.usage?.totalTokens;
  let usage: WorkflowAgentUsage | undefined;
  if (total?.usage || next.usage) {
    usage = emptyUsage();
    if (total?.usage) addUsage(usage, total.usage);
    if (next.usage) addUsage(usage, next.usage);
  }
  return {
    ...(usage ? { usage } : {}),
    ...(totalTokens !== undefined || nextTokens !== undefined
      ? { tokens: (totalTokens ?? 0) + (nextTokens ?? 0) }
      : {}),
    ...(total?.estimatedTokens || next.estimatedTokens ? { estimatedTokens: true } : {}),
    ...(next.sessionFile
      ? { sessionFile: next.sessionFile }
      : total?.sessionFile
        ? { sessionFile: total.sessionFile }
        : {}),
    toolCalls: (total?.toolCalls ?? 0) + next.toolCalls,
    elapsedMs: (total?.elapsedMs ?? 0) + next.elapsedMs,
  };
}

function completeTelemetry(
  result: unknown,
  telemetry: WorkflowAgentTelemetry | undefined,
  started?: number,
): WorkflowAgentTelemetry {
  const tokens = telemetry?.tokens ?? telemetry?.usage?.totalTokens;
  if (typeof tokens === "number") {
    return {
      ...telemetry,
      tokens,
      toolCalls: telemetry?.toolCalls ?? 0,
      elapsedMs: telemetry?.elapsedMs ?? (started ? Date.now() - started : 0),
    };
  }
  return {
    ...telemetry,
    tokens: estimateTokens(result),
    estimatedTokens: true,
    toolCalls: telemetry?.toolCalls ?? 0,
    elapsedMs: telemetry?.elapsedMs ?? (started ? Date.now() - started : 0),
  };
}

function recordTelemetry(state: RuntimeState, telemetry: WorkflowAgentTelemetry): void {
  state.spent += telemetry.tokens ?? 0;
  if (telemetry.usage) {
    addUsage(state.usage, telemetry.usage);
    state.hasActualUsage = true;
  }
}

function emptyUsage(): WorkflowAgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: WorkflowAgentUsage, usage: WorkflowAgentUsage): void {
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

function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  return Math.ceil(JSON.stringify(value).length / 4);
}
