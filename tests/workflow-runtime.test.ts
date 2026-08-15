import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowAgentTelemetry } from "../src/agent.js";
import { agentKey, WorkflowJournal } from "../src/journal.js";
import { runWorkflow, type WorkflowRunControls } from "../src/workflow.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const META = "export const meta = { name: 'rt', description: 'runtime tests' }\n";

/** A fake agent runner that returns a deterministic value per prompt and counts calls. */
function fakeRunner() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async (prompt: string) => {
      calls++;
      return `echo:${prompt}`;
    },
  };
}

function tmpJournalDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-"));
}

test("sandbox hardening: injected globals expose no constructor escape hatch", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(
    `${META}
await agent('warm up')
return {
  logCtor: typeof log.constructor,
  agentCtor: typeof agent.constructor,
  parallelCtor: typeof parallel.constructor,
}`,
    { agent: runner, journalDir: tmpJournalDir() },
  );
  assert.equal(result.result.logCtor, "undefined");
  assert.equal(result.result.agentCtor, "undefined");
  assert.equal(result.result.parallelCtor, "undefined");
});

test("context provides its own fresh intrinsics (JSON/Math/Array still usable)", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(
    `${META}
await agent('warm up')
const parsed = JSON.parse('{"a":1}')
const doubled = [1,2,3].map(n => n * 2)
return {
  json: JSON.stringify(parsed),
  max: Math.max(4, 9, 2),
  arr: Array.isArray(doubled),
  sum: doubled.reduce((a, b) => a + b, 0),
}`,
    { agent: runner, journalDir: tmpJournalDir() },
  );
  assert.equal(result.result.json, '{"a":1}');
  assert.equal(result.result.max, 9);
  assert.equal(result.result.arr, true);
  assert.equal(result.result.sum, 12);
});

test("runtime determinism shim: aliased Math.random bypass throws at runtime", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
const m = Math
return m['ra' + 'ndom']()`,
      { agent: runner, journalDir: tmpJournalDir() },
    ),
    /deterministic/,
  );
});

test("runtime determinism shim: aliased Date.now bypass throws at runtime", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
const d = Date
return d['no' + 'w']()`,
      { agent: runner, journalDir: tmpJournalDir() },
    ),
    /deterministic/,
  );
});

test("runtime determinism shim: Date prototype constructor escape throws", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
return new (Date.prototype.constructor)().getTime()`,
      { agent: runner, journalDir: tmpJournalDir() },
    ),
    /deterministic/,
  );
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
return Reflect.construct(Date.prototype.constructor, []).getTime()`,
      { agent: runner, journalDir: tmpJournalDir() },
    ),
    /deterministic/,
  );
});

test("runtime determinism shim: Date with arguments still works", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<number>(
    `${META}
await agent('warm up')
return new Date(2020, 0, 1).getFullYear()`,
    { agent: runner, journalDir: tmpJournalDir() },
  );
  assert.equal(result.result, 2020);
});

test("sync timeout: an infinite synchronous loop cannot hang the host", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(`${META}\nwhile (true) {}`, {
      agent: runner,
      scriptTimeoutMs: 200,
      journalDir: tmpJournalDir(),
    }),
    /timed out|timeout/i,
  );
});

test("runaway cap: exceeding maxAgents throws a clear error", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('one')
await agent('two')
await agent('three')`,
      { agent: runner, maxAgents: 2, journalDir: tmpJournalDir() },
    ),
    /maxAgents cap \(2\)/,
  );
});

test("journal agent keys use non-ambiguous serialization", () => {
  // These two call signatures collided under the old NUL-delimited serialization:
  // `${prompt}\0${label}\0${schema}` produced `a\0b\0c\0null` for both.
  assert.notEqual(agentKey(1, "a\0b", "c", null), agentKey(1, "a", "b\0c", null));
});

test("real token accounting uses subagent telemetry for budget and result", async () => {
  let calls = 0;
  const runner = {
    run: async (_prompt: string, options?: { onTelemetry?: (telemetry: unknown) => void }) => {
      calls++;
      options?.onTelemetry?.({
        usage: {
          input: 30,
          output: 10,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 47,
          cost: { input: 0.03, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.053 },
        },
        tokens: 47,
        toolCalls: 3,
        elapsedMs: 25,
      });
      return "ok";
    },
  };

  const result = await runWorkflow<{ spent: number; remaining: number }>(
    `${META}
await agent('metered', { label: 'metered' })
return { spent: budget.spent(), remaining: budget.remaining() }`,
    { agent: runner, journalDir: tmpJournalDir(), tokenBudget: 100 },
  );

  assert.equal(calls, 1);
  assert.equal(result.result.spent, 47);
  assert.equal(result.result.remaining, 53);
  assert.equal(result.spentTokens, 47);
  assert.equal(result.tokenUsage?.totalTokens, 47);
  assert.equal(result.tokenUsage?.input, 30);
});

test("stall retries accumulate usage from every attempt", async () => {
  let attempts = 0;
  const metered = (totalTokens: number) => ({
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: totalTokens / 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens / 1000 },
    },
    tokens: totalTokens,
    toolCalls: 1,
    elapsedMs: 5,
  });
  const runner = {
    run: async (
      _prompt: string,
      options?: { signal?: AbortSignal; onTelemetry?: (telemetry: ReturnType<typeof metered>) => void },
    ) => {
      attempts++;
      if (attempts === 1) {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        options?.onTelemetry?.(metered(100));
        throw new Error("stalled");
      }
      options?.onTelemetry?.(metered(10));
      return "recovered";
    },
  };

  const result = await runWorkflow<number>(`${META}\nawait agent('metered retry')\nreturn budget.spent()`, {
    agent: runner,
    journalDir: tmpJournalDir(),
    stallTimeoutMs: 30,
    stallRetries: 1,
  });

  assert.equal(attempts, 2);
  assert.equal(result.result, 110);
  assert.equal(result.spentTokens, 110);
  assert.equal(result.tokenUsage?.totalTokens, 110);
  assert.equal(result.tokenUsage?.cost.total, 0.11);
});

test("live telemetry remains cumulative when a stalled attempt is retried", async () => {
  const metered = (totalTokens: number): WorkflowAgentTelemetry => ({
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: totalTokens / 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens / 1000 },
    },
    tokens: totalTokens,
    toolCalls: 1,
    elapsedMs: 5,
  });
  let attempts = 0;
  let controls: WorkflowRunControls | undefined;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let releaseSecond!: () => void;
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const runner = {
    run: async (
      _prompt: string,
      options?: {
        signal?: AbortSignal;
        onTelemetry?: (telemetry: WorkflowAgentTelemetry) => void;
        onSessionHandle?: (handle: {
          getMessages: () => readonly unknown[];
          getTelemetry: () => WorkflowAgentTelemetry;
        }) => void;
      },
    ) => {
      attempts++;
      const current = metered(attempts === 1 ? 100 : 10);
      options?.onSessionHandle?.({ getMessages: () => [], getTelemetry: () => current });
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        options?.onTelemetry?.(current);
        throw new Error("stalled");
      }
      markSecondStarted();
      await secondReleased;
      options?.onTelemetry?.(current);
      return "recovered";
    },
  };

  const running = runWorkflow<number>(`${META}\nawait agent('metered retry')\nreturn budget.spent()`, {
    agent: runner,
    journalDir: tmpJournalDir(),
    stallTimeoutMs: 30,
    stallRetries: 1,
    onRunControls: (value) => {
      controls = value;
    },
  });
  try {
    await secondStarted;
    const live = controls?.getAgentSession(1)?.getTelemetry?.();
    assert.equal(live?.tokens, 110, "completed retry usage and the active attempt must be combined once");
    assert.equal(live?.usage?.cost.total, 0.11);
    releaseSecond();
    const result = await running;
    assert.equal(result.result, 110);
    assert.equal(result.spentTokens, 110);
  } finally {
    releaseSecond();
    await running.catch(() => {});
  }
});

test("resume/journaling replays persisted token telemetry without re-spawning", async () => {
  const journalDir = tmpJournalDir();
  const script = `${META}
await agent('metered', { label: 'metered' })
return budget.spent()`;
  const runner1 = {
    calls: 0,
    run: async (_prompt: string, options?: { onTelemetry?: (telemetry: unknown) => void }) => {
      runner1.calls++;
      options?.onTelemetry?.({
        usage: {
          input: 50,
          output: 25,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 75,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        tokens: 75,
        toolCalls: 1,
        elapsedMs: 10,
      });
      return "ok";
    },
  };
  const first = await runWorkflow<number>(script, { agent: runner1, journalDir });
  assert.equal(first.result, 75);
  assert.equal(first.spentTokens, 75);

  const runner2 = fakeRunner();
  const second = await runWorkflow<number>(script, {
    agent: runner2,
    journalDir,
    resumeFromRunId: first.runId,
  });
  assert.equal(runner2.calls, 0);
  assert.equal(second.result, 75);
  assert.equal(second.spentTokens, 75);
  assert.equal(second.tokenUsage?.totalTokens, 75);
});

test("resume/journaling: a resumed run replays cached results without re-spawning", async () => {
  const journalDir = tmpJournalDir();
  const script = `${META}
const a = await agent('first prompt', { label: 'a' })
const b = await agent('second prompt', { label: 'b' })
return { a, b }`;

  const runner1 = fakeRunner();
  const first = await runWorkflow<{ a: string; b: string }>(script, {
    agent: runner1,
    journalDir,
  });
  assert.equal(runner1.calls, 2);
  assert.equal(first.result.a, "echo:first prompt");
  assert.equal(first.result.b, "echo:second prompt");

  const runner2 = fakeRunner();
  const second = await runWorkflow<{ a: string; b: string }>(script, {
    agent: runner2,
    journalDir,
    resumeFromRunId: first.runId,
  });
  // The fake runner must NOT have been called: results came from the journal.
  assert.equal(runner2.calls, 0);
  assert.equal(second.runId, first.runId);
  assert.equal(second.result.a, first.result.a);
  assert.equal(second.result.b, first.result.b);
});

test("runId is generated and surfaced on the result", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow(`${META}\nawait agent('x')\nreturn 1`, {
    agent: runner,
    journalDir: tmpJournalDir(),
  });
  assert.match(result.runId, /^wf_[0-9a-f-]{12}$/);
});

test("sandbox hardening: container objects expose no host-realm escape", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(
    `${META}
await agent('warm up')
const probe = (v) => { try { return typeof v.constructor; } catch { return 'thrown'; } }
return {
  budget: probe(budget),
  budgetSpent: probe(budget.spent),
  budgetRemaining: probe(budget.remaining),
  consoleObj: probe(console),
  processObj: probe(process),
}`,
    { agent: runner, journalDir: tmpJournalDir() },
  );
  // A null-prototype object/function has no `.constructor` (undefined), so the
  // `constructor.constructor("return process")()` escape chain is severed.
  assert.equal(result.result.budget, "undefined");
  assert.equal(result.result.budgetSpent, "undefined");
  assert.equal(result.result.budgetRemaining, "undefined");
  assert.equal(result.result.consoleObj, "undefined");
  assert.equal(result.result.processObj, "undefined");
});

test("sandbox hardening: args is deep-cloned into the sandbox realm (no host bridge)", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(
    `${META}
await agent('warm up')
// args.constructor must be the SANDBOX Object (===, not the host Object), so the
// constructor.constructor escape stays confined to the sandbox realm.
const ctorMatchesSandbox = args.constructor === ({}).constructor
// Read the host platform via both the args escape and the baseline sandbox escape;
// both must be confined to the sandbox (process.platform is undefined there), so
// neither yields the host platform string ('linux'/'darwin'/...).
let viaArgs = 'no-read'
try { viaArgs = String(args.constructor.constructor('return (globalThis.process && globalThis.process.platform) || "no-host-process"')()) } catch { viaArgs = 'thrown' }
let viaBaseline = 'no-read'
try { viaBaseline = String(({}).constructor.constructor('return (globalThis.process && globalThis.process.platform) || "no-host-process"')()) } catch { viaBaseline = 'thrown' }
return { value: args.x + 1, ctorMatchesSandbox, viaArgs, viaBaseline }`,
    { agent: runner, journalDir: tmpJournalDir(), args: { x: 41 } },
  );
  assert.equal(result.result.value, 42, "args remain usable inside the sandbox");
  assert.equal(result.result.ctorMatchesSandbox, true, "args uses the sandbox's own Object prototype");
  // The args escape must behave identically to the baseline sandbox escape: it
  // must NOT reach the host process.platform (which would be a real platform string).
  assert.equal(result.result.viaArgs, "no-host-process");
  assert.equal(result.result.viaArgs, result.result.viaBaseline);
});

test("sandbox hardening: non-JSON args are rejected", async () => {
  const runner = fakeRunner();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    runWorkflow(`${META}\nawait agent('x')\nreturn 1`, {
      agent: runner,
      journalDir: tmpJournalDir(),
      args: cyclic,
    }),
    /JSON-serializable/,
  );
});

test("runaway cap inside parallel() rejects instead of returning nulls", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
return await parallel([0,1,2,3,4].map((i) => () => agent('p' + i, { label: 'p' + i })))`,
      { agent: runner, maxAgents: 2, journalDir: tmpJournalDir() },
    ),
    /maxAgents cap \(2\)/,
  );
});

test("maxAgents counts spawns, not cached replays: resume with a tighter cap on pure replay succeeds", async () => {
  const journalDir = tmpJournalDir();
  const script = `${META}
await agent('a', { label: 'a' })
await agent('b', { label: 'b' })
await agent('c', { label: 'c' })
return 'ok'`;

  const runner1 = fakeRunner();
  const first = await runWorkflow<string>(script, { agent: runner1, journalDir, maxAgents: 100 });
  assert.equal(runner1.calls, 3);

  // Pure replay spawns nothing, so a tightened cap must NOT trip.
  const runner2 = fakeRunner();
  const second = await runWorkflow<string>(script, {
    agent: runner2,
    journalDir,
    resumeFromRunId: first.runId,
    maxAgents: 2,
  });
  assert.equal(runner2.calls, 0);
  assert.equal(second.result, "ok");
});

test("runaway protection: maxAgents (not a whole-run clock) bounds a `while(true){ await agent() }` loop", async () => {
  // Each call yields a macrotask like real I/O. There is deliberately NO whole-run
  // wall-clock deadline (Claude Code has none); the maxAgents lifetime cap is what
  // bounds an unbounded `await agent()` loop.
  const yieldingRunner = {
    run: async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `echo:${prompt}`;
    },
  };
  await assert.rejects(
    runWorkflow(`${META}\nawait agent('warm')\nwhile (true) { await agent('spin') }`, {
      agent: yieldingRunner,
      maxAgents: 5,
      journalDir: tmpJournalDir(),
    }),
    /maxAgents cap \(5\)/,
  );
});

test("no whole-run clock: a multi-agent run with slow (still-active) agents completes, not killed by any timer", async () => {
  // Each agent takes longer than the old 30s-style per-run deadline WOULD have been
  // simulated by a short scriptTimeoutMs, proving scriptTimeoutMs no longer bounds
  // the async phase. The delay stays well under stallTimeoutMs so no agent stalls;
  // all four must complete.
  const slowRunner = {
    run: async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return `echo:${prompt}`;
    },
  };
  const result = await runWorkflow<unknown[]>(
    `${META}\nreturn await parallel([0,1,2,3].map((i) => () => agent('p' + i, { label: 'p' + i })))`,
    {
      agent: slowRunner,
      // Keep the synchronous VM watchdog comfortably above CI scheduler jitter
      // while making the async work exceed it. A whole-run deadline would fail.
      scriptTimeoutMs: 500,
      stallTimeoutMs: 5000,
      journalDir: tmpJournalDir(),
    },
  );
  assert.deepEqual(result.result, ["echo:p0", "echo:p1", "echo:p2", "echo:p3"]);
  assert.equal(result.agentCount, 4);
});

test("stall detection: a no-activity agent is aborted, retried, then resolves to null without killing the workflow", async () => {
  // The 'slow' runner never reports activity and never resolves on its own, so the
  // stall timer aborts each attempt. With stallRetries=1 it is attempted twice
  // (initial + 1 retry), then treated as a normal failure -> null + [stall] logs;
  // the other agent and the overall run still complete.
  let slowAttempts = 0;
  const runner = {
    run: async (prompt: string, opts?: { signal?: AbortSignal }) => {
      if (prompt.includes("slow")) {
        slowAttempts++;
        // Resolve only when aborted by the stall timer; never on its own.
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted by stall timer");
      }
      return `echo:${prompt}`;
    },
  };
  const result = await runWorkflow<{ slow: unknown; fast: unknown }>(
    `${META}
const slow = await agent('slow task', { label: 'slow' })
const fast = await agent('fast task', { label: 'fast' })
return { slow, fast }`,
    {
      agent: runner,
      stallTimeoutMs: 30,
      stallRetries: 1,
      journalDir: tmpJournalDir(),
    },
  );
  assert.equal(result.result.slow, null, "the stalled agent resolved to null after retries");
  assert.equal(result.result.fast, "echo:fast task", "the rest of the workflow still ran");
  assert.equal(slowAttempts, 2, "the stalled agent was retried once (initial + 1 retry)");
  assert.ok(
    result.logs.some((line) => /\[stall\] agent "slow" stalled \(no progress\).*retrying \(1\/1\)/.test(line)),
    "the stall retry is logged",
  );
  assert.ok(
    result.logs.some((line) => /\[stall\].*giving up after 1 retries/.test(line)),
    "stall-retry exhaustion is logged",
  );
});

test("stall detection: activity resets the stall timer so long active agents are never aborted", async () => {
  // The runner takes ~6x the stall timeout in total but reports activity every
  // ~10ms (like streaming deltas / tool events); the timer keeps resetting and the
  // agent must complete on the FIRST attempt.
  let attempts = 0;
  const runner = {
    run: async (prompt: string, opts?: { onActivity?: () => void; signal?: AbortSignal }) => {
      attempts++;
      for (let i = 0; i < 18; i++) {
        if (opts?.signal?.aborted) throw new Error("aborted");
        await new Promise((resolve) => setTimeout(resolve, 10));
        opts?.onActivity?.();
      }
      return `echo:${prompt}`;
    },
  };
  const result = await runWorkflow<string>(`${META}\nreturn await agent('busy task', { label: 'busy' })`, {
    agent: runner,
    stallTimeoutMs: 30,
    stallRetries: 2,
    journalDir: tmpJournalDir(),
  });
  assert.equal(result.result, "echo:busy task");
  assert.equal(attempts, 1, "activity resets must prevent any stall retry");
  assert.ok(!result.logs.some((line) => /\[stall\]/.test(line)), "no stall lines may be logged for an active agent");
});

test("journal self-heals a torn tail left by a crashed run", () => {
  const journalDir = tmpJournalDir();
  const runDir = path.join(journalDir, "run1");
  fs.mkdirSync(runDir, { recursive: true });
  const journalPath = path.join(runDir, "journal.jsonl");
  // One good line plus a torn partial line with NO trailing newline.
  fs.writeFileSync(journalPath, '{"key":"1:x","result":"A","ts":1}\n{"key":"2:torn","resul');

  const journal = WorkflowJournal.open({ cwd: "/unused", runId: "run1", journalDir });
  assert.equal(journal.has("1:x"), true, "the good prior line replays");
  journal.append("3:z", "NEW");
  journal.close();

  // The new entry must be fully re-parseable: it must NOT have glued onto the
  // torn tail. Reopen and confirm the cache has the new key while the torn line
  // is still (correctly) skipped.
  const reopened = WorkflowJournal.open({ cwd: "/unused", runId: "run1", journalDir });
  assert.equal(reopened.has("3:z"), true, "new entry survives a crashed torn tail");
  assert.equal(reopened.get("3:z"), "NEW");
  assert.equal(reopened.has("1:x"), true);
  assert.equal(reopened.has("2:torn"), false, "the torn partial line stays unparseable/skipped");
});

test("workflow tool exposes resumeFromRunId and replays a prior run journal", async () => {
  const journalDir = tmpJournalDir();
  const script = `${META}\nconst value = await agent('resume me', { label: 'resume-target' })\nreturn { value }`;
  const fakeCtx = { cwd: process.cwd(), hasUI: false } as never;

  const runner1 = fakeRunner();
  const tool1 = createWorkflowTool({ cwd: process.cwd(), journalDir, agent: runner1 });
  const first = await tool1.execute("resume-1", { script }, undefined, undefined, fakeCtx);
  assert.equal(runner1.calls, 1);
  assert.equal(first.terminate, undefined, "foreground completion must not terminate its parent turn");
  const runId = (first.details as { runId?: string }).runId;
  assert.match(runId ?? "", /^wf_[0-9a-f-]{12}$/);

  const runner2 = fakeRunner();
  const tool2 = createWorkflowTool({ cwd: process.cwd(), journalDir, agent: runner2 });
  const second = await tool2.execute("resume-2", { script, resumeFromRunId: runId }, undefined, undefined, fakeCtx);
  assert.equal(runner2.calls, 0, "resumeFromRunId must replay the journal without spawning the subagent");
  assert.equal(second.terminate, undefined, "foreground resume must keep normal tool continuation semantics");
  assert.equal((second.details as { runId?: string }).runId, runId);
  assert.equal(
    JSON.stringify((second.details as { result?: unknown }).result),
    JSON.stringify({ value: "echo:resume me" }),
  );
});

test("workflow tool reads inherited model, thinking level, and project trust", async () => {
  // The tool-execute ctx (ExtensionContext) exposes `model` and project trust;
  // thinking level comes from the injected getThinkingLevel() (closing over the
  // `pi` ExtensionAPI). This test pins all three inheritance inputs.
  const fakeModel = { id: "fake-model", provider: "fake" } as unknown;
  let getThinkingLevelCalls = 0;
  let projectTrustCalls = 0;
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    getThinkingLevel: () => {
      getThinkingLevelCalls++;
      return "high";
    },
  });

  // Run with an already-aborted signal so the workflow rejects before any real
  // subagent session is created. We assert the thinking-level accessor was
  // consulted (proving it is wired, vs. the dead ctx.getThinkingLevel() path that
  // always returned undefined) and that reading ctx.model does not throw.
  const controller = new AbortController();
  controller.abort();
  const fakeCtx = {
    cwd: process.cwd(),
    model: fakeModel,
    isProjectTrusted: () => {
      projectTrustCalls++;
      return false;
    },
  } as never;

  await assert.rejects(
    tool.execute("call-1", { script: `${META}\nawait agent('x')\nreturn 1` }, controller.signal, undefined, fakeCtx),
    /abort/i,
  );
  // The thinking-level accessor must have been consulted (proving it is wired and
  // not the dead ctx.getThinkingLevel() path that always returned undefined).
  assert.equal(getThinkingLevelCalls, 1);
  assert.equal(projectTrustCalls, 1);
});

test("workflow tool: non-TUI modes await foreground even when RPC has UI", async () => {
  // Even with a sendResult callback present, print and RPC must not background:
  // the result could be lost when the session disposes. RPC has hasUI=true in
  // pi 0.80.6, so mode — not hasUI — is the authoritative distinction.
  for (const [label, fakeCtx] of [
    ["print", { cwd: process.cwd(), mode: "print", hasUI: false }],
    ["rpc", { cwd: process.cwd(), mode: "rpc", hasUI: true }],
  ] as const) {
    let sendResultCalls = 0;
    const tool = createWorkflowTool({
      cwd: process.cwd(),
      journalDir: tmpJournalDir(),
      sendResult: () => {
        sendResultCalls++;
      },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      tool.execute(
        `fg-${label}`,
        { script: `${META}\nawait agent('x')\nreturn 1` },
        controller.signal,
        undefined,
        fakeCtx as never,
      ),
      /abort/i,
    );
    assert.equal(sendResultCalls, 0, `${label} foreground path must not deliver via sendResult`);
  }
});

test("workflow tool: TUI mode backgrounds, returns a runId immediately, and notifies on completion", async () => {
  // Positively-interactive TUI context + a wired sendResult => background. The tool must
  // return SYNCHRONOUSLY with status 'running' and a runId, then later deliver the
  // outcome via sendResult (Claude Code's <task-notification>). We drive completion
  // deterministically with an already-aborted signal so no real model is needed: the
  // detached run aborts immediately and reports status 'aborted'.
  const delivered: Array<{ runId: string; status: string; text: string }> = [];
  const tracked: string[] = [];
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    trackRun: (runId) => {
      tracked.push(runId);
    },
    sendResult: (result) => {
      delivered.push({ runId: result.runId, status: result.status, text: result.text });
      resolveDelivery();
    },
  });
  const controller = new AbortController();
  controller.abort();
  const fakeCtx = { cwd: process.cwd(), mode: "tui", hasUI: true } as never;

  const immediate = await tool.execute(
    "bg-1",
    { script: `${META}\nawait agent('x')\nreturn 1` },
    controller.signal,
    undefined,
    fakeCtx,
  );

  // Returned immediately with a running status + runId, NOT the final result.
  const details = immediate.details as { runId?: string; status?: string };
  assert.equal(details.status, "running");
  assert.equal(immediate.terminate, true, "an accepted detached handoff must end the launching parent turn");
  assert.match(details.runId ?? "", /^wf_[0-9a-f-]{12}$/);
  const text = immediate.content?.[0];
  assert.ok(text?.type === "text" && /started in background/.test(text.text));

  // The detached run is tracked so shutdown can await it.
  assert.deepEqual(tracked, [details.runId]);

  // The completion notification arrives later via sendResult.
  await deliveryDone;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].runId, details.runId);
  assert.equal(delivered[0].status, "aborted");
});

test("workflow tool: background path does not push streaming onUpdate after the immediate result resolves", async () => {
  // Regression for the "deliver/update after the call resolved" surface: onUpdate is
  // the per-tool-call streaming sink. On the background path the tool returns a
  // "running" result immediately and the run continues detached; its later snapshot
  // callbacks must NOT push to the now-stale per-call onUpdate sink. We record the
  // number of onUpdate calls at return time and confirm it does not grow after the
  // detached run settles.
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    sendResult: () => {
      resolveDelivery();
    },
  });
  const controller = new AbortController();
  controller.abort();
  const fakeCtx = { cwd: process.cwd(), mode: "tui", hasUI: true } as never;

  let updateCalls = 0;
  const onUpdate = () => {
    updateCalls++;
  };

  await tool.execute(
    "bg-stream-1",
    { script: `${META}\nawait agent('x')\nreturn 1` },
    controller.signal,
    onUpdate as never,
    fakeCtx,
  );
  const callsAtReturn = updateCalls;

  // Let the detached run settle; any of its snapshot callbacks firing afterward must
  // not invoke onUpdate now that the tool call has resolved.
  await deliveryDone;
  // Flush a couple of macrotasks so any stray detached callback would have landed.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(updateCalls, callsAtReturn, "onUpdate must not fire after the immediate background result resolves");
});
