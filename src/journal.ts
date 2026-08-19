import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowAgentTelemetry } from "./agent.js";

/**
 * Append-only JSONL journal backing resumable workflow runs.
 *
 * Each agent() call computes a deterministic key. On a fresh run we append the
 * key + result as a line; on a resumed run we replay cached results for any key
 * already present, so deterministic scripts skip already-completed subagents.
 *
 * Invalidation is PER-CALL content-addressed (ordinal + prompt + label + schema),
 * NOT Claude-Code "longest unchanged prefix": changing an upstream call only
 * re-runs downstream calls whose own signature changed. Scripts must thread
 * upstream results into downstream prompts for resume to invalidate dependents.
 */

export interface JournalEntry {
  key: string;
  result: unknown;
  /** Per-agent usage/tool/elapsed telemetry persisted so resumed budget accounting is exact. */
  telemetry?: WorkflowAgentTelemetry;
  /** Host-side wall clock for debugging only; never read back into the sandbox. */
  ts: number;
}

interface CachedJournalEntry {
  result: unknown;
  telemetry?: WorkflowAgentTelemetry;
}

const DEFAULT_RUNS_DIRNAME = ".pi-workflow-runs";
const JOURNAL_FILENAME = "journal.jsonl";
const WORKFLOW_RUNS_GITIGNORE_RULE = `${DEFAULT_RUNS_DIRNAME}/`;

/** Return true for a root-level ignore rule that already covers workflow runs. */
function hasWorkflowRunsIgnoreRule(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const rule = line.trim().replace(/^(?:\*\*\/|\/)/, "");
    return rule === DEFAULT_RUNS_DIRNAME || rule === WORKFLOW_RUNS_GITIGNORE_RULE;
  });
}

/**
 * Keep generated workflow journals out of the project's Git working tree.
 *
 * This is deliberately best-effort: inability to read or update a project's
 * `.gitignore` must never prevent a workflow from running. Existing rules are
 * preserved, and repeated/concurrent workflow launches remain harmless.
 */
export function ensureWorkflowRunsGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") return;
  }

  if (hasWorkflowRunsIgnoreRule(content)) return;

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  try {
    fs.appendFileSync(gitignorePath, `${separator}${WORKFLOW_RUNS_GITIGNORE_RULE}\n`);
  } catch {
    // Git hygiene is advisory; journal creation and execution remain primary.
  }
}

/** Stable host-side hash. The determinism ban only applies inside the sandbox. */
export function stableHash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/** Per-call options that change a subagent's behavior and therefore its cache identity. */
export interface AgentKeyExtras {
  model?: string | null;
  agentType?: string | null;
  isolation?: string | null;
  /** Explicit script `opts.thinkingLevel` only; inherited parent thinking is omitted. */
  thinkingLevel?: string | null;
}

/**
 * Compute the deterministic agent key from its ordinal and call signature.
 * Calls without model/agentType/isolation/thinkingLevel keep the v1 signature
 * so journals written before those options were wired still replay for plain
 * calls. `thinkingLevel` is added to the v2 object only when set, so existing
 * model/agentType/isolation journals stay replayable.
 */
export function agentKey(
  ordinal: number,
  prompt: string,
  label: string | undefined,
  schema: unknown,
  extras?: AgentKeyExtras,
): string {
  const thinkingLevel = extras?.thinkingLevel ?? null;
  const hasExtras = Boolean(extras && (extras.model || extras.agentType || extras.isolation || thinkingLevel));
  const signature = JSON.stringify(
    hasExtras
      ? {
          v: 2,
          prompt,
          label: label ?? null,
          schema: schema ?? null,
          model: extras?.model ?? null,
          agentType: extras?.agentType ?? null,
          isolation: extras?.isolation ?? null,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        }
      : { v: 1, prompt, label: label ?? null, schema: schema ?? null },
  );
  return `${ordinal}:${stableHash(signature)}`;
}

/** Generate a short, host-side-random run id. */
export function generateRunId(): string {
  return `wf_${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Tolerant per-line JSONL read of a run journal, shared by WorkflowJournal.replay
 * and post-mortem surfaces (finished-run status). Skips corrupt/partial lines
 * (torn tails from crashed runs) and returns [] when the file is missing or
 * unreadable, so both consumers stay in lockstep on parse behavior.
 */
export function readJournalEntries(journalPath: string): JournalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as JournalEntry;
      if (entry && typeof entry.key === "string") entries.push(entry);
    } catch {
      // Skip corrupt/partial lines so a crashed run can still resume best-effort.
    }
  }
  return entries;
}

export interface JournalOptions {
  cwd: string;
  runId: string;
  /** Override the base directory that holds per-run journal folders. */
  journalDir?: string;
}

function sanitizeTelemetry(value: unknown): WorkflowAgentTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const telemetry = value as Partial<WorkflowAgentTelemetry>;
  const toolCalls = typeof telemetry.toolCalls === "number" ? telemetry.toolCalls : 0;
  const elapsedMs = typeof telemetry.elapsedMs === "number" ? telemetry.elapsedMs : 0;
  const tokens = typeof telemetry.tokens === "number" ? telemetry.tokens : telemetry.usage?.totalTokens;
  return {
    ...(telemetry.usage ? { usage: telemetry.usage } : {}),
    ...(typeof tokens === "number" ? { tokens } : {}),
    ...(telemetry.estimatedTokens ? { estimatedTokens: true } : {}),
    // Persisted pi child session path: kept so resumed runs can still point at
    // the original subagent session in pi session storage.
    ...(typeof telemetry.sessionFile === "string" ? { sessionFile: telemetry.sessionFile } : {}),
    toolCalls,
    elapsedMs,
  };
}

export class WorkflowJournal {
  readonly runId: string;
  readonly runDir: string;
  readonly journalPath: string;
  private readonly cache = new Map<string, CachedJournalEntry>();
  /**
   * True until the first append in THIS process. The first append heals any torn
   * tail left by a previously crashed run (a partial final line with no trailing
   * newline) so the new entry never glues onto the partial and stays parseable.
   */
  private firstAppend = true;

  private constructor(runId: string, runDir: string, journalPath: string) {
    this.runId = runId;
    this.runDir = runDir;
    this.journalPath = journalPath;
  }

  /**
   * Open (and if resuming, replay) the journal for a run. Reads any existing
   * entries into the in-memory cache and prepares the file for appends.
   */
  static open(options: JournalOptions): WorkflowJournal {
    const baseDir = options.journalDir ?? path.join(options.cwd, DEFAULT_RUNS_DIRNAME);
    const runDir = path.join(baseDir, options.runId);
    const journalPath = path.join(runDir, JOURNAL_FILENAME);
    fs.mkdirSync(runDir, { recursive: true });
    if (options.journalDir === undefined) ensureWorkflowRunsGitignore(options.cwd);

    const journal = new WorkflowJournal(options.runId, runDir, journalPath);
    journal.replay();
    return journal;
  }

  private replay(): void {
    for (const entry of readJournalEntries(this.journalPath)) {
      this.cache.set(entry.key, { result: entry.result, telemetry: sanitizeTelemetry(entry.telemetry) });
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get(key: string): unknown {
    return this.cache.get(key)?.result;
  }

  getTelemetry(key: string): WorkflowAgentTelemetry | undefined {
    return this.cache.get(key)?.telemetry;
  }

  /**
   * Persist a freshly produced result. Idempotent for an already-cached key.
   * Appends synchronously so the entry is flushed to the OS and survives a
   * process crash (not a power loss/OS crash without fsync). The first append in
   * a process heals a torn tail left by a previously crashed run so JSONL lines
   * stay self-delimiting.
   */
  append(key: string, result: unknown, telemetry?: WorkflowAgentTelemetry): void {
    if (this.cache.has(key)) return;
    const cleanTelemetry = sanitizeTelemetry(telemetry);
    this.cache.set(key, { result, telemetry: cleanTelemetry });
    const entry: JournalEntry = {
      key,
      result,
      ...(cleanTelemetry ? { telemetry: cleanTelemetry } : {}),
      ts: Date.now(),
    };
    let line = `${JSON.stringify(entry)}\n`;
    if (this.firstAppend) {
      this.firstAppend = false;
      // If a prior run crashed mid-append, the file may end in a partial line
      // with no trailing newline. Prepend a newline so this entry starts on its
      // own line instead of gluing onto (and thereby corrupting) the torn tail.
      if (this.hasTornTail()) line = `\n${line}`;
    }
    fs.appendFileSync(this.journalPath, line);
  }

  /** Whether the journal file exists and does not end in a newline (torn tail). */
  private hasTornTail(): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.journalPath, "r");
      const size = fs.fstatSync(fd).size;
      if (size === 0) return false;
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a; // "\n"
    } catch {
      // No existing file (or unreadable): nothing to heal.
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  close(): void {
    // No-op: appends are synchronous and need no flushing. Kept for API symmetry.
  }
}
