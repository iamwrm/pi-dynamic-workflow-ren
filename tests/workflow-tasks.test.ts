import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/display.js";
import { runWorkflow, type WorkflowRunControls } from "../src/workflow.js";
import { createWorkflowTasksTool, createWorkflowTool } from "../src/workflow-tool.js";

const META = "export const meta = { name: 'tasks', description: 'workflow_tasks tests' }\n";

function tmpJournalDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-tasks-"));
}

/** Runner whose 'hang' prompts park until aborted; everything else echoes. */
function hangAwareRunner() {
  let hangAttempts = 0;
  return {
    get hangAttempts() {
      return hangAttempts;
    },
    run: async (prompt: string, opts?: { signal?: AbortSignal }) => {
      if (prompt.includes("hang")) {
        hangAttempts++;
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      }
      return `echo:${prompt}`;
    },
  };
}

const PARALLEL_SCRIPT = `${META}
const [hung, fast] = await parallel([
  () => agent('hang forever', { label: 'hung' }),
  () => agent('fast task', { label: 'fast' }),
])
return { hung, fast }`;

test("per-agent kill: null result, no retries, [kill] log, not journaled; resume re-runs only the killed agent", async () => {
  const journalDir = tmpJournalDir();
  const runner = hangAwareRunner();
  let controls: WorkflowRunControls | undefined;
  const ends: Array<{ id: number; killed?: boolean; result: unknown }> = [];
  const logs: string[] = [];

  // Kill the hung agent as soon as its kill control is registered (registration
  // happens just after onAgentStart fires, so the first attempt may be a no-op).
  const killWhenRegistered = (id: number) => {
    const tick = () => {
      const outcome = controls?.killAgents([id])[0];
      if (!outcome?.killed) setTimeout(tick, 5);
    };
    tick();
  };

  const first = await runWorkflow<{ hung: unknown; fast: unknown }>(PARALLEL_SCRIPT, {
    agent: runner,
    journalDir,
    runId: "wf_killsource01",
    stallTimeoutMs: 60_000,
    onRunControls: (c) => {
      controls = c;
    },
    onAgentStart: (event) => {
      if (event.label === "hung") killWhenRegistered(event.id);
    },
    onAgentEnd: (event) => ends.push({ id: event.id, killed: event.killed, result: event.result }),
    onLog: (message) => logs.push(message),
  });

  // The killed agent resolved null; the sibling and the run itself completed.
  // (Field-wise: sandbox-realm objects fail deepStrictEqual on prototype.)
  assert.equal(first.result.hung, null);
  assert.equal(first.result.fast, "echo:fast task");
  // A manual kill must not consume stall retries: exactly one attempt.
  assert.equal(runner.hangAttempts, 1);
  assert.ok(
    logs.some((line) => line.startsWith("[kill]") && line.includes('"hung"')),
    `expected a [kill] log, got: ${JSON.stringify(logs)}`,
  );
  const killedEnd = ends.find((event) => event.killed);
  assert.ok(killedEnd, "onAgentEnd must carry killed: true for the killed agent");
  assert.equal(killedEnd?.result, null);

  // Kills are NOT journaled: a resume re-runs exactly the killed agent and
  // replays the completed one from cache.
  const prompts: string[] = [];
  const secondRunner = {
    run: async (prompt: string) => {
      prompts.push(prompt);
      return `second:${prompt}`;
    },
  };
  const resumed = await runWorkflow<{ hung: unknown; fast: unknown }>(PARALLEL_SCRIPT, {
    agent: secondRunner,
    journalDir,
    resumeFromRunId: "wf_killsource01",
  });
  assert.deepEqual(prompts, ["hang forever"]);
  assert.equal(resumed.result.hung, "second:hang forever");
  assert.equal(resumed.result.fast, "echo:fast task");
});

test("kill of an unknown/finished agent id reports killed:false with a reason", async () => {
  let controls: WorkflowRunControls | undefined;
  const runner = { run: async (prompt: string) => `echo:${prompt}` };
  await runWorkflow(`${META}\nawait agent('only task', { label: 'only' })\nreturn 1`, {
    agent: runner,
    journalDir: tmpJournalDir(),
    onRunControls: (c) => {
      controls = c;
    },
  });
  assert.deepEqual(controls?.killAgents([42]), [{ id: 42, killed: false, reason: "not running" }]);
});

test("workflow_tasks list/status answer counts, per-phase addressing, and live runningMs", async () => {
  const now = Date.now();
  const snapshot: WorkflowSnapshot = {
    name: "demo",
    phases: ["Scan", "Review"],
    currentPhase: "Review",
    logs: ["l1", "l2", "l3", "l4", "l5", "l6"],
    agentCount: 3,
    runningCount: 1,
    doneCount: 1,
    errorCount: 1,
    agents: [
      {
        id: 1,
        label: "scanner",
        phase: "Scan",
        prompt: "p",
        status: "done",
        tokens: 126728,
        toolCalls: 3,
        elapsedMs: 900,
      },
      { id: 2, label: "rev a", phase: "Review", prompt: "p", status: "killed", error: "killed" },
      { id: 3, label: "rev b", phase: "Review", prompt: "p", status: "running", startedAtMs: now - 5_000 },
    ],
  };
  const killedCalls: number[][] = [];
  let runKilled = false;
  const tool = createWorkflowTasksTool({
    listRuns: () => [
      {
        runId: "wf_demo",
        name: "demo",
        startedAtMs: now - 60_000,
        getSnapshot: () => snapshot,
        killRun: () => {
          runKilled = true;
        },
        killAgents: (ids) => {
          killedCalls.push(ids);
          return ids.map((id) => ({ id, killed: true }));
        },
      },
    ],
  });
  const run = async (params: Record<string, unknown>) =>
    (await tool.execute("t", params as never, undefined as never, undefined, undefined as never)).details as Record<
      string,
      unknown
    >;

  // "How many subagents are running?"
  const list = (await run({ action: "list" })) as { liveRuns: Array<Record<string, unknown>> };
  assert.equal(list.liveRuns.length, 1);
  assert.equal(list.liveRuns[0].running, 1);
  assert.equal(list.liveRuns[0].done, 1);
  assert.equal(list.liveRuns[0].failed, 1);
  assert.equal(list.liveRuns[0].spentTokens, "126.7k tok");
  assert.ok((list.liveRuns[0].elapsedMs as number) >= 60_000);

  // "What is the status of the 2nd agent in the 2nd phase?" — addressable by
  // phase grouping; running agents expose a live runningMs for criteria like
  // "kill everything running longer than an hour".
  const status = (await run({ action: "status" })) as {
    phases: Array<{ title: string; agents: Array<Record<string, unknown>> }>;
    logs: string[];
  };
  assert.deepEqual(
    status.phases.map((phase) => phase.title),
    ["Scan", "Review"],
  );
  const reviewAgents = status.phases[1].agents;
  assert.equal(reviewAgents[0].status, "killed");
  assert.equal(reviewAgents[1].id, 3);
  assert.equal(reviewAgents[1].status, "running");
  assert.ok((reviewAgents[1].runningMs as number) >= 5_000);
  assert.deepEqual(status.logs, ["l2", "l3", "l4", "l5", "l6"]);

  // Kill specific agents by id (the model picks ids after filtering status).
  const killAgents = await run({ action: "kill", runId: "wf_demo", agentIds: [3] });
  assert.deepEqual(killedCalls, [[3]]);
  assert.deepEqual(killAgents.killedAgents, [{ id: 3, killed: true }]);

  // Kill the whole run.
  const killRun = await run({ action: "kill", runId: "wf_demo" });
  assert.equal(runKilled, true);
  assert.equal(killRun.killedRun, true);
  assert.match(String(killRun.note), /resumeFromRunId/);

  // Unknown run id → error plus the live ids.
  const unknown = await run({ action: "status", runId: "wf_nope" });
  assert.match(String(unknown.error), /no live run/);
  assert.deepEqual(unknown.liveRunIds, ["wf_demo"]);
});

test("workflow_tasks with no live runs explains itself", async () => {
  const tool = createWorkflowTasksTool({ listRuns: () => [] });
  const empty = (
    await tool.execute("t", { action: "list" } as never, undefined as never, undefined, undefined as never)
  ).details as Record<string, unknown>;
  assert.deepEqual(empty.liveRuns, []);
  assert.match(String(empty.note), /No live workflow runs/);
  const status = (
    await tool.execute("t", { action: "status" } as never, undefined as never, undefined, undefined as never)
  ).details as Record<string, unknown>;
  assert.match(String(status.error), /no live workflow runs/);
});

test("agent feeds: events become bounded lines + live tail and persist to a transcript file", async () => {
  const journalDir = tmpJournalDir();
  let controls: WorkflowRunControls | undefined;
  const runner = {
    run: async (
      _prompt: string,
      opts?: { onFeedEvent?: (event: { kind: string; [key: string]: unknown }) => void },
    ) => {
      const emit = opts?.onFeedEvent as ((event: unknown) => void) | undefined;
      emit?.({ kind: "tool_start", toolName: "bash", argsPreview: "npm test" });
      emit?.({ kind: "text_delta", delta: "thinking about " });
      emit?.({ kind: "text_delta", delta: "results" });
      emit?.({ kind: "tool_error", toolName: "read", errorPreview: "no such file" });
      emit?.({ kind: "assistant_text", text: "All tests pass.\nShip it." });
      // Overflow the ring buffer.
      for (let i = 0; i < 220; i++) emit?.({ kind: "tool_start", toolName: "grep", argsPreview: `q${i}` });
      return "ok";
    },
  };
  const result = await runWorkflow(`${META}\nreturn await agent('feed me', { label: 'feeder' })`, {
    agent: runner,
    journalDir,
    runId: "wf_feedsource1",
    onRunControls: (c) => {
      controls = c;
    },
  });
  assert.equal(result.result, "ok");

  const feed = controls?.getAgentFeed(1);
  assert.ok(feed, "feed must exist for agent ordinal 1");
  // Ring buffer capped at 200 lines, oldest dropped.
  assert.equal(feed?.lines.length, 200);
  assert.match(feed?.lines.at(-1) ?? "", /grep: q219/);
  // Live tail was cleared by the assistant_text event.
  assert.equal(feed?.liveText, "");

  // Transcript persisted: header, prompt, tool lines, FULL assistant text, status.
  assert.ok(feed?.transcriptPath, "transcript path must be set");
  const transcript = fs.readFileSync(feed?.transcriptPath ?? "", "utf8");
  assert.match(transcript, /# agent #1 — feeder/);
  assert.match(transcript, /## Prompt\n\nfeed me/);
  assert.match(transcript, /⚒ bash: npm test/);
  assert.match(transcript, /✗ read failed: no such file/);
  assert.match(transcript, /assistant:\nAll tests pass\.\nShip it\./);
  assert.match(transcript, /— done \(/);
  // Lives under <runDir>/agents/.
  assert.match(feed?.transcriptPath ?? "", /wf_feedsource1[/\\]agents[/\\]001-feeder\.md$/);
});

test("agent sessions: live handle during the run, persisted capped messages.jsonl after", async () => {
  const journalDir = tmpJournalDir();
  let controls: WorkflowRunControls | undefined;
  let liveCheck: { live?: boolean; messageCount?: number; model?: string } = {};
  const big = "x".repeat(20_000);
  const runner = {
    run: async (
      _prompt: string,
      opts?: {
        onSessionHandle?: (handle: unknown) => void;
        onSessionEnd?: (messages: readonly unknown[]) => void;
      },
    ) => {
      opts?.onSessionHandle?.({
        getMessages: () => [{ role: "user", content: "hi" }],
        model: "anthropic/test-model",
        thinkingLevel: "xhigh",
      });
      const session = controls?.getAgentSession(1);
      liveCheck = {
        live: session?.live,
        messageCount: session?.getMessages?.().length,
        model: session?.model,
      };
      opts?.onSessionEnd?.([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: big }] },
      ]);
      return "ok";
    },
  };
  await runWorkflow(`${META}\nreturn await agent('sess', { label: 'sessioned' })`, {
    agent: runner,
    journalDir,
    runId: "wf_sess01",
    onRunControls: (c) => {
      controls = c;
    },
  });

  // While the runner was inside the agent, the session was live and readable.
  assert.deepEqual(liveCheck, { live: true, messageCount: 1, model: "anthropic/test-model" });

  // After the run: not live, metadata kept, messages persisted with caps.
  const final = controls?.getAgentSession(1);
  assert.equal(final?.live, false);
  assert.equal(final?.model, "anthropic/test-model");
  assert.equal(final?.thinkingLevel, "xhigh");
  assert.match(final?.messagesPath ?? "", /wf_sess01[/\\]agents[/\\]001-sessioned\.messages\.jsonl$/);
  const lines = fs
    .readFileSync(final?.messagesPath ?? "", "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  const assistant = JSON.parse(lines[1]) as { content: Array<{ text: string }> };
  assert.match(assistant.content[0].text, /…\[truncated 3616 chars\]$/);

  // The finished handle serves the same capped snapshot from memory (no fs).
  const inMemory = final?.getMessages?.() as Array<{ content: Array<{ text: string }> | string }>;
  assert.equal(inMemory?.length, 2);
  assert.match((inMemory?.[1]?.content as Array<{ text: string }>)[0].text, /…\[truncated 3616 chars\]$/);
});

test("stall retries persist per-attempt messages files; the entry points at the newest", async () => {
  const journalDir = tmpJournalDir();
  let controls: WorkflowRunControls | undefined;
  let attempt = 0;
  const runner = {
    run: async (
      _prompt: string,
      opts?: {
        signal?: AbortSignal;
        onSessionHandle?: (handle: unknown) => void;
        onSessionEnd?: (messages: readonly unknown[]) => void;
      },
    ) => {
      attempt++;
      const mine = attempt;
      opts?.onSessionHandle?.({ getMessages: () => [], model: "anthropic/m" });
      if (mine === 1) {
        // Hang until the stall timer aborts, then persist this attempt's session
        // (mirrors WorkflowAgent.run's finally) and fail the attempt.
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        opts?.onSessionEnd?.([{ role: "user", content: "attempt one" }]);
        throw new Error("aborted");
      }
      opts?.onSessionEnd?.([{ role: "user", content: "attempt two" }]);
      return "ok";
    },
  };
  const result = await runWorkflow(`${META}\nreturn await agent('retry me', { label: 'retrier' })`, {
    agent: runner,
    journalDir,
    runId: "wf_retry01",
    stallTimeoutMs: 30,
    stallRetries: 1,
    onRunControls: (c) => {
      controls = c;
    },
  });
  assert.equal(result.result, "ok");

  // Newest attempt wins the entry; both write-once files survive.
  const entry = controls?.getAgentSession(1);
  assert.match(entry?.messagesPath ?? "", /001-retrier\.retry2\.messages\.jsonl$/);
  const dir = path.dirname(entry?.messagesPath ?? "");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("001-retrier") && name.endsWith(".messages.jsonl"))
    .sort();
  assert.deepEqual(files, ["001-retrier.messages.jsonl", "001-retrier.retry2.messages.jsonl"]);
  assert.match(fs.readFileSync(path.join(dir, files[0]), "utf8"), /attempt one/);
  assert.match(fs.readFileSync(path.join(dir, files[1]), "utf8"), /attempt two/);
  assert.equal((entry?.getMessages?.() as Array<{ content: string }>)[0]?.content, "attempt two");
});

test("pathologically deep array nesting persists without unbounded recursion", async () => {
  const journalDir = tmpJournalDir();
  let controls: WorkflowRunControls | undefined;
  let deep: unknown = "leaf";
  for (let i = 0; i < 50; i++) deep = [deep];
  const runner = {
    run: async (_prompt: string, opts?: { onSessionEnd?: (messages: readonly unknown[]) => void }) => {
      opts?.onSessionEnd?.([{ role: "user", content: deep }]);
      return "ok";
    },
  };
  await runWorkflow(`${META}\nreturn await agent('deep', { label: 'deep' })`, {
    agent: runner,
    journalDir,
    onRunControls: (c) => {
      controls = c;
    },
  });
  const entry = controls?.getAgentSession(1);
  assert.ok(entry?.messagesPath, "deep message must still persist");
  const parsed = JSON.parse(fs.readFileSync(entry?.messagesPath ?? "", "utf8").trim()) as { content: unknown };
  // 50 levels survive the round-trip (recursion is bounded, values pass through).
  let depth = 0;
  let cursor: unknown = parsed.content;
  while (Array.isArray(cursor)) {
    depth++;
    cursor = cursor[0];
  }
  assert.equal(depth, 50);
  assert.equal(cursor, "leaf");
});

test("workflow_tasks status attaches feedTail lines, liveText, and transcript paths", async () => {
  const snapshot: WorkflowSnapshot = {
    name: "demo",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
    agents: [{ id: 1, label: "worker", phase: "P", prompt: "p", status: "running", startedAtMs: Date.now() - 1000 }],
  };
  const tool = createWorkflowTasksTool({
    listRuns: () => [
      {
        runId: "wf_feedy",
        name: "demo",
        getSnapshot: () => snapshot,
        getAgentFeed: (id) =>
          id === 1
            ? {
                lines: ["⚒ bash: ls", "💬 found it", "⚒ read x.ts"],
                liveText: "and now I will",
                transcriptPath: "/tmp/run/agents/001-worker.md",
              }
            : undefined,
        getAgentSession: (id) =>
          id === 1 ? { live: false, messagesPath: "/tmp/run/agents/001-worker.messages.jsonl" } : undefined,
      },
    ],
  });
  const status = (
    await tool.execute(
      "t",
      { action: "status", feedTail: 2 } as never,
      undefined as never,
      undefined,
      undefined as never,
    )
  ).details as { phases: Array<{ agents: Array<Record<string, unknown>> }> };
  const agent = status.phases[0].agents[0];
  assert.deepEqual(agent.feed, ["💬 found it", "⚒ read x.ts"]);
  assert.equal(agent.liveText, "and now I will");
  assert.equal(agent.transcript, "/tmp/run/agents/001-worker.md");
  assert.equal(agent.messages, "/tmp/run/agents/001-worker.messages.jsonl");

  // Without feedTail the lines stay out but the transcript path is still reported.
  const bare = (
    await tool.execute("t", { action: "status" } as never, undefined as never, undefined, undefined as never)
  ).details as { phases: Array<{ agents: Array<Record<string, unknown>> }> };
  const bareAgent = bare.phases[0].agents[0];
  assert.equal(bareAgent.feed, undefined);
  assert.equal(bareAgent.transcript, "/tmp/run/agents/001-worker.md");
});

test("workflow_tasks status on a finished run reports persisted transcripts", async () => {
  const base = tmpJournalDir();
  const agentsDir = path.join(base, "wf_done01", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "001-worker.md"), "# agent #1\n");
  fs.writeFileSync(path.join(agentsDir, "002-checker.md"), "# agent #2\n");
  const tool = createWorkflowTasksTool({ listRuns: () => [], runsDir: () => base });
  const status = (
    await tool.execute(
      "t",
      { action: "status", runId: "wf_done01" } as never,
      undefined as never,
      undefined,
      undefined as never,
    )
  ).details as Record<string, unknown>;
  assert.equal(status.live, false);
  assert.deepEqual(status.transcripts, [path.join(agentsDir, "001-worker.md"), path.join(agentsDir, "002-checker.md")]);
  // Kill on a finished run still errors.
  const kill = (
    await tool.execute(
      "t",
      { action: "kill", runId: "wf_done01" } as never,
      undefined as never,
      undefined,
      undefined as never,
    )
  ).details as Record<string, unknown>;
  assert.match(String(kill.error), /no live run/);
});

test("background run: registerLiveUi exposes kill controls; killRun aborts only that run", async () => {
  const delivered: Array<{ status: string }> = [];
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let liveUi:
    | {
        getSnapshot?: () => WorkflowSnapshot;
        killRun?: () => void;
        killAgents?: (ids: number[]) => Array<{ id: number; killed: boolean }>;
        startedAtMs?: number;
      }
    | undefined;
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: hangAwareRunner(),
    sendResult: (result) => {
      delivered.push({ status: result.status });
      resolveDelivery();
    },
    registerLiveUi: (_runId, ui) => {
      liveUi = ui;
    },
  });

  const immediate = await tool.execute(
    "bg-kill",
    { script: `${META}\nawait agent('hang forever')\nreturn 1` } as never,
    new AbortController().signal,
    undefined,
    { cwd: process.cwd(), hasUI: true } as never,
  );
  assert.equal((immediate.details as { status?: string }).status, "running");
  assert.ok(liveUi?.killRun, "registerLiveUi must expose killRun");
  assert.ok(liveUi?.killAgents, "registerLiveUi must expose killAgents");
  assert.equal(typeof liveUi?.startedAtMs, "number");

  // Wait for the detached run to actually start its agent, then kill the run.
  await waitFor(() => (liveUi?.getSnapshot?.()?.agents.length ?? 0) === 1);
  liveUi?.killRun?.();
  await deliveryDone;
  assert.deepEqual(delivered, [{ status: "aborted" }]);
});

test("failed background handoff aborts the unowned run without delivering a detached result", async () => {
  let deliveries = 0;
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: hangAwareRunner(),
    sendResult: () => {
      deliveries++;
    },
    registerLiveUi: () => {
      throw new Error("registry unavailable");
    },
  });

  await assert.rejects(
    tool.execute(
      "bg-handoff-failure",
      { script: `${META}\nawait agent('hang forever')\nreturn 1` } as never,
      new AbortController().signal,
      undefined,
      { cwd: process.cwd(), hasUI: true } as never,
    ),
    /registry unavailable/,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveries, 0);
});

test("accepted background run survives its parent-turn abort and remains explicitly killable", async () => {
  const delivered: Array<{ status: string }> = [];
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let liveUi:
    | {
        getSnapshot?: () => WorkflowSnapshot;
        killRun?: () => void;
      }
    | undefined;
  const origin = new AbortController();
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: hangAwareRunner(),
    sendResult: (result) => {
      delivered.push({ status: result.status });
      resolveDelivery();
    },
    registerLiveUi: (_runId, ui) => {
      liveUi = ui;
    },
  });

  const immediate = await tool.execute(
    "bg-parent-abort",
    { script: `${META}\nawait agent('hang forever')\nreturn 1` } as never,
    origin.signal,
    undefined,
    { cwd: process.cwd(), hasUI: true } as never,
  );
  assert.equal((immediate.details as { status?: string }).status, "running");
  await waitFor(() => liveUi?.getSnapshot?.().agents[0]?.status === "running");

  // Models and extensions may abort the originating main-agent turn later (for
  // example, to establish a mid-turn compaction boundary). The accepted run owns
  // an independent cancellation scope, so that parent abort must not stop it.
  origin.abort(new Error("parent turn checkpoint"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered, []);
  assert.equal(liveUi?.getSnapshot?.().agents[0]?.status, "running");

  // Workflow-specific cancellation remains authoritative for both the user-facing
  // /kill-workflow command and the model-facing workflow_tasks kill action.
  liveUi?.killRun?.();
  await deliveryDone;
  assert.deepEqual(delivered, [{ status: "aborted" }]);
});

test("background run: killAgents kills one agent and the run still completes", async () => {
  const delivered: Array<{ status: string }> = [];
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let liveUi:
    | {
        getSnapshot?: () => WorkflowSnapshot;
        killAgents?: (ids: number[]) => Array<{ id: number; killed: boolean }>;
      }
    | undefined;
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: hangAwareRunner(),
    sendResult: (result) => {
      delivered.push({ status: result.status });
      resolveDelivery();
    },
    registerLiveUi: (_runId, ui) => {
      liveUi = ui;
    },
  });

  await tool.execute("bg-kill-agent", { script: PARALLEL_SCRIPT } as never, new AbortController().signal, undefined, {
    cwd: process.cwd(),
    hasUI: true,
  } as never);

  // Find the hung agent's id from the live snapshot, then kill it (retrying
  // until its kill control is registered).
  await waitFor(() => Boolean(snapshotAgent(liveUi?.getSnapshot?.(), "hung")));
  const hungId = snapshotAgent(liveUi?.getSnapshot?.(), "hung")?.id as number;
  await waitFor(() => liveUi?.killAgents?.([hungId])[0]?.killed === true);

  await deliveryDone;
  assert.deepEqual(delivered, [{ status: "completed" }]);
  const killedAgent = snapshotAgent(liveUi?.getSnapshot?.(), "hung");
  assert.equal(killedAgent?.status, "killed");
});

function snapshotAgent(snapshot: WorkflowSnapshot | undefined, label: string) {
  return snapshot?.agents.find((agent) => agent.label === label);
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
