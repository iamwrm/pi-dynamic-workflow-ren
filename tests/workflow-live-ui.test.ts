import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowAgentTelemetry } from "../src/agent.js";
import type { WorkflowSnapshot } from "../src/display.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const META = "export const meta = { name: 'live_ui', description: 'live ui tests' }\n";

function tmpJournalDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-live-ui-"));
}

/** A fake agent runner that resolves deterministically, so real subagent callbacks fire. */
function fakeRunner() {
  return {
    run: async (prompt: string) => `echo:${prompt}`,
  };
}

function telemetry(totalTokens: number): WorkflowAgentTelemetry {
  return {
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
  };
}

interface WidgetCall {
  key: string;
  content: string[] | undefined;
}
interface StatusCall {
  key: string;
  text: string | undefined;
}

/** Records ctx.ui.* calls so assertions can inspect the live widget lifecycle. */
function recordingUi(overrides: Partial<Record<"setWidget" | "setStatus" | "notify", () => void>> = {}) {
  const widgetCalls: WidgetCall[] = [];
  const statusCalls: StatusCall[] = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  return {
    widgetCalls,
    statusCalls,
    notifyCalls,
    ui: {
      setWidget(key: string, content: string[] | undefined) {
        widgetCalls.push({ key, content });
        overrides.setWidget?.();
      },
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
        overrides.setStatus?.();
      },
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
        overrides.notify?.();
      },
    },
  };
}

test("background path drives a live progress widget, then fixes the final UI in history", async () => {
  const rec = recordingUi();
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const delivered: Array<{ runId: string; status: string; text: string; details: Record<string, unknown> }> = [];

  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    sendResult: (result) => {
      delivered.push({ runId: result.runId, status: result.status, text: result.text, details: result.details });
      resolveDelivery();
    },
  });

  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  const immediate = await tool.execute(
    "bg-ui-1",
    { script: `${META}\nconst a = await agent('hello', { label: 'greeter' })\nreturn { a }` },
    undefined,
    undefined,
    fakeCtx,
  );

  const details = immediate.details as { runId?: string; status?: string };
  assert.equal(details.status, "running");
  const runId = details.runId ?? "";
  assert.match(runId, /^wf_[0-9a-f-]{12}$/);
  const key = `dynamic-workflow:${runId}`;

  // The detached run delivers via sendResult on completion.
  await deliveryDone;
  // Flush a couple of macrotasks so any trailing final render/clear lands.
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(delivered.length, 1, "sendResult must still deliver the final result");
  assert.equal(delivered[0].runId, runId);
  assert.equal(delivered[0].status, "completed");

  // (a) At least one widget update carried non-empty progress content reflecting an
  // agent that ran. The greeter agent's label must appear in some rendered frame.
  const progressFrames = rec.widgetCalls.filter(
    (call): call is { key: string; content: string[] } => call.key === key && Array.isArray(call.content),
  );
  assert.ok(progressFrames.length >= 1, "expected at least one live widget update");
  assert.ok(
    progressFrames.some((frame) => frame.content.some((line) => line.includes("greeter"))),
    "a live widget frame must reflect the running/completed agent",
  );
  const finalFrame = progressFrames.at(-1);
  assert.ok(finalFrame, "expected a final workflow widget frame before clear");
  assert.match(finalFrame.content[0] ?? "", /Workflow completed/);

  // (b) The delivered workflow_result details contain the same final snapshot, so the
  // extension renderer can show it as a fixed transcript entry instead of a floating
  // widget.
  assert.equal(delivered[0].details.name, "live_ui");
  assert.equal(delivered[0].details.doneCount, 1);
  assert.equal(delivered[0].details.agentCount, 1);
  const agents = delivered[0].details.agents as Array<{ label?: string }> | undefined;
  assert.ok(
    agents?.some((agent) => agent.label === "greeter"),
    "final details must include the agent snapshot",
  );

  // (c) After delivery, the transient widget + footer status are cleared so new
  // messages can push the fixed workflow_result message up through session history.
  assert.equal(rec.widgetCalls.filter((call) => call.key === key).at(-1)?.content, undefined);
  assert.equal(rec.statusCalls.filter((call) => call.key === key).at(-1)?.text, undefined);
});

test("registered live snapshots poll changing subagent token usage before completion", async () => {
  const rec = recordingUi();
  let tokens = 1_200;
  let markAgentStarted!: () => void;
  const agentStarted = new Promise<void>((resolve) => {
    markAgentStarted = resolve;
  });
  let releaseAgent!: () => void;
  const agentReleased = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let readSnapshot: (() => WorkflowSnapshot) | undefined;
  const runner = {
    run: async (
      _prompt: string,
      options?: {
        onSessionHandle?: (handle: {
          getMessages: () => readonly unknown[];
          getTelemetry: () => WorkflowAgentTelemetry;
        }) => void;
        onTelemetry?: (value: WorkflowAgentTelemetry) => void;
      },
    ) => {
      options?.onSessionHandle?.({ getMessages: () => [], getTelemetry: () => telemetry(tokens) });
      markAgentStarted();
      await agentReleased;
      options?.onTelemetry?.(telemetry(tokens));
      return "ok";
    },
  };
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: runner,
    registerLiveUi: (_runId, liveUi) => {
      readSnapshot = liveUi.getSnapshot;
    },
    sendResult: () => resolveDelivery(),
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  try {
    await tool.execute(
      "bg-live-tokens",
      { script: `${META}\nawait agent('measure', { label: 'metered' })\nreturn 1` },
      undefined,
      undefined,
      fakeCtx,
    );
    await agentStarted;
    assert.ok(readSnapshot, "background registration must expose getSnapshot");
    assert.equal(readSnapshot().agents[0]?.tokens, 1_200);
    tokens = 2_345;
    assert.equal(readSnapshot().agents[0]?.tokens, 2_345, "each poll must read fresh session telemetry");
    releaseAgent();
    await deliveryDone;
  } finally {
    releaseAgent();
  }
});

test("registered cleanup is idempotent after completion clears the widget", async () => {
  const rec = recordingUi();
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let clearCompletedUi: (() => void) | undefined;

  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    registerLiveUi: (_runId, liveUi) => {
      clearCompletedUi = liveUi.clear;
    },
    sendResult: () => {
      resolveDelivery();
    },
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  const immediate = await tool.execute(
    "bg-cleanup-cleared",
    { script: `${META}\nawait agent('hello', { label: 'greeter' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );
  const runId = (immediate.details as { runId?: string }).runId ?? "";
  const key = `dynamic-workflow:${runId}`;

  await deliveryDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(clearCompletedUi, "the widget must register a shutdown cleanup while in flight");
  const clearCount = rec.widgetCalls.filter((call) => call.key === key && call.content === undefined).length;
  assert.equal(clearCount, 1, "completion must clear the transient widget once");

  clearCompletedUi();

  assert.equal(
    rec.widgetCalls.filter((call) => call.key === key && call.content === undefined).length,
    clearCount,
    "the registered shutdown cleanup should be idempotent after completion",
  );
});

test("a completed background run emits no notify toast (sendResult is the only completion surface)", async () => {
  // Completion is delivered via sendResult (a workflow_result message). A success
  // notify() would double-surface the outcome, so the success path must NOT notify.
  const rec = recordingUi();
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    sendResult: () => {
      resolveDelivery();
    },
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  await tool.execute(
    "bg-no-notify",
    { script: `${META}\nawait agent('hello', { label: 'greeter' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );

  await deliveryDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(rec.notifyCalls.length, 0, "a successful background run must not emit any notify toast");
});

test("a shutdown-driven abort suppresses the failure toast (no toast on a dying UI)", async () => {
  // On quit/reload the shutdown signal fires; the run aborts. The user-facing failure
  // toast must be suppressed (N concurrent runs would otherwise toast N times on a
  // UI being torn down). sendResult still delivers the aborted outcome.
  const rec = recordingUi();
  const shutdown = new AbortController();
  shutdown.abort();
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const delivered: Array<{ status: string }> = [];
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    getShutdownSignal: () => shutdown.signal,
    sendResult: (result) => {
      delivered.push({ status: result.status });
      resolveDelivery();
    },
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  await tool.execute(
    "bg-shutdown-abort",
    { script: `${META}\nawait agent('hello', { label: 'greeter' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );

  await deliveryDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(delivered.length, 1, "the aborted outcome must still be delivered via sendResult");
  assert.equal(delivered[0].status, "aborted");
  assert.equal(rec.notifyCalls.length, 0, "a shutdown-driven abort must not emit a notify toast on a dying UI");
  // The widget/status were still cleared on settle despite the suppressed toast.
  assert.ok(
    rec.widgetCalls.some((c) => c.content === undefined),
    "the widget must still be cleared on a shutdown-driven abort",
  );
});

test("the footer status distinguishes failed agents from completed ones", async () => {
  // When an agent fails, the compact footer must not read as all-succeeded; it should
  // surface the failure count rather than counting errors toward "done".
  const rec = recordingUi();
  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  // A runner that rejects so the agent records an error in the live snapshot. Failed
  // agent() branches return null (logged) and the workflow continues, so the run
  // completes with errorCount > 0.
  const failingRunner = {
    run: async () => {
      throw new Error("boom");
    },
  };
  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: failingRunner,
    sendResult: () => {
      resolveDelivery();
    },
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  await tool.execute(
    "bg-footer-fail",
    { script: `${META}\nawait agent('hello', { label: 'doomed' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );

  await deliveryDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const failedSummaries = rec.statusCalls.filter((c) => typeof c.text === "string" && /\bfailed\b/.test(c.text));
  assert.ok(failedSummaries.length >= 1, "the footer status must surface a 'failed' count when an agent errors");
});

test("a thrown ctx.ui error does not break final delivery", async () => {
  // Every ctx.ui.* call throws; the detached run must still settle and sendResult must
  // still deliver the final result.
  const rec = recordingUi({
    setWidget: () => {
      throw new Error("ui torn down");
    },
    setStatus: () => {
      throw new Error("ui torn down");
    },
    notify: () => {
      throw new Error("ui torn down");
    },
  });

  let resolveDelivery: () => void;
  const deliveryDone = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const delivered: Array<{ status: string }> = [];

  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    sendResult: (result) => {
      delivered.push({ status: result.status });
      resolveDelivery();
    },
  });

  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  const immediate = await tool.execute(
    "bg-ui-throw",
    { script: `${META}\nawait agent('hello', { label: 'greeter' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.equal((immediate.details as { status?: string }).status, "running");

  await deliveryDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Despite every UI call throwing, the run completed and delivered its result.
  assert.equal(delivered.length, 1, "a throwing UI must not block the final delivery");
  assert.equal(delivered[0].status, "completed");
});

test("concurrent background runs own distinct widget keys and clear only their own after delivery", async () => {
  const rec = recordingUi();
  const deliveries: string[] = [];
  let remaining = 2;
  let resolveAll: () => void;
  const allDone = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  const tool = createWorkflowTool({
    cwd: process.cwd(),
    journalDir: tmpJournalDir(),
    agent: fakeRunner(),
    sendResult: (result) => {
      deliveries.push(result.runId);
      if (--remaining === 0) resolveAll();
    },
  });
  const fakeCtx = { cwd: process.cwd(), hasUI: true, ui: rec.ui } as never;

  const first = await tool.execute(
    "bg-a",
    { script: `${META}\nawait agent('a', { label: 'agent-a' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );
  const second = await tool.execute(
    "bg-b",
    { script: `${META}\nawait agent('b', { label: 'agent-b' })\nreturn 1` },
    undefined,
    undefined,
    fakeCtx,
  );

  const runIdA = (first.details as { runId?: string }).runId ?? "";
  const runIdB = (second.details as { runId?: string }).runId ?? "";
  assert.notEqual(runIdA, runIdB);
  const keyA = `dynamic-workflow:${runIdA}`;
  const keyB = `dynamic-workflow:${runIdB}`;

  await allDone;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const framesA = rec.widgetCalls.filter(
    (c): c is { key: string; content: string[] } => c.key === keyA && Array.isArray(c.content),
  );
  const framesB = rec.widgetCalls.filter(
    (c): c is { key: string; content: string[] } => c.key === keyB && Array.isArray(c.content),
  );
  assert.match(framesA.at(-1)?.content[0] ?? "", /Workflow completed/);
  assert.match(framesB.at(-1)?.content[0] ?? "", /Workflow completed/);
  assert.ok(framesA.at(-1)?.content.some((line) => line.includes("agent-a")));
  assert.ok(framesB.at(-1)?.content.some((line) => line.includes("agent-b")));
  assert.equal(rec.widgetCalls.filter((c) => c.key === keyA).at(-1)?.content, undefined);
  assert.equal(rec.widgetCalls.filter((c) => c.key === keyB).at(-1)?.content, undefined);
  assert.equal(rec.statusCalls.filter((c) => c.key === keyA).at(-1)?.text, undefined);
  assert.equal(rec.statusCalls.filter((c) => c.key === keyB).at(-1)?.text, undefined);
  // Every widget call must be keyed to one of the two distinct run keys.
  assert.ok(rec.widgetCalls.every((c) => c.key === keyA || c.key === keyB));
});
