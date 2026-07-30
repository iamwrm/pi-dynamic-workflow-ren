import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Claude Code's worktree concurrency limiter size. */
export const DEFAULT_WORKTREE_SLOTS = 50;

export interface WorktreeLease {
  /** Absolute path of the created worktree checkout. */
  cwd: string;
  /**
   * Clean up the lease: removes the worktree when it has no changes, keeps it
   * (and logs the kept path) when the agent mutated files, and always frees the
   * concurrency slot. Idempotent. Never throws — cleanup failures are logged.
   */
  release(log?: (message: string) => void): Promise<void>;
}

export interface WorktreeManagerOptions {
  /** Repository the worktrees are created from (the workflow cwd). */
  repoCwd: string;
  /** Directory that holds the worktree checkouts (default: a temp dir is REQUIRED from the caller). */
  baseDir: string;
  /** Concurrency slots (Claude Code: 50). A lease holds its slot until release(). */
  maxSlots?: number;
}

/**
 * Creates and disposes real `git worktree` checkouts for `agent(..., { isolation:
 * 'worktree' })`, mirroring Claude Code:
 *
 * - each isolated agent gets a fresh detached worktree (~200-500ms setup + disk),
 * - a 50-slot limiter bounds how many worktrees exist concurrently,
 * - unchanged worktrees are auto-removed on release; changed ones are kept and
 *   their path is logged so the orchestrator (or user) can collect the edits.
 */
export class WorktreeManager {
  private readonly repoCwd: string;
  private readonly baseDir: string;
  private readonly maxSlots: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: WorktreeManagerOptions) {
    this.repoCwd = options.repoCwd;
    this.baseDir = options.baseDir;
    this.maxSlots = Math.max(1, options.maxSlots ?? DEFAULT_WORKTREE_SLOTS);
  }

  /**
   * Acquire a slot and create a detached worktree named after `name`. Throws when
   * the repo is not a git repository (or git is unavailable); the caller treats
   * that as a normal per-agent failure.
   */
  async acquire(name: string, signal?: AbortSignal): Promise<WorktreeLease> {
    await this.acquireSlot();
    const dir = path.join(this.baseDir, sanitizeWorktreeName(name));
    try {
      if (signal?.aborted) throw new Error("workflow aborted");
      fs.mkdirSync(this.baseDir, { recursive: true });
      await execFileAsync("git", ["-C", this.repoCwd, "worktree", "add", "--detach", dir], { signal });
    } catch (error) {
      this.releaseSlot();
      throw new Error(`worktree creation failed: ${describeExecError(error)}`);
    }

    let released = false;
    return {
      cwd: dir,
      release: async (log?: (message: string) => void) => {
        if (released) return;
        released = true;
        try {
          await this.cleanup(dir, log);
        } catch (error) {
          log?.(`worktree cleanup failed for ${dir}: ${describeExecError(error)}`);
        } finally {
          this.releaseSlot();
        }
      },
    };
  }

  /** Remove the worktree if unchanged; keep (and log) it when the agent made changes. */
  private async cleanup(dir: string, log?: (message: string) => void): Promise<void> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain"]);
    if (stdout.trim().length === 0) {
      await execFileAsync("git", ["-C", this.repoCwd, "worktree", "remove", "--force", dir]);
      return;
    }
    log?.(`worktree kept (has changes): ${dir}`);
  }

  private async acquireSlot(): Promise<void> {
    if (this.active >= this.maxSlots) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

function sanitizeWorktreeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

function describeExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const execError = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof execError.stderr === "string" ? execError.stderr.trim() : "";
    if (stderr) return stderr.split("\n")[0];
    if (typeof execError.message === "string") return execError.message;
  }
  return String(error);
}
