import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowAgent, type WorkflowAgentSessionHandle, type WorkflowAgentTelemetry } from "../src/agent.js";

let providerOrdinal = 0;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function usage(totalTokens: number, cost = totalTokens / 1000): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(model: Model<any>, text: string, totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(totalTokens),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

interface AgentHarnessOptions {
  responses: AssistantMessage[];
  contextWindow?: number;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  extensions?: ExtensionFactory[];
  tools?: ToolDefinition[];
  autoCompaction?: boolean;
  seed?: (sessionManager: SessionManager, model: Model<any>) => void;
}

async function createAgentHarness(options: AgentHarnessOptions) {
  const root = tmpDir("wf-agent-");
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const provider = `workflow-faux-${++providerOrdinal}`;
  const faux = fauxProvider({
    provider,
    models: [
      {
        id: "workflow-model",
        name: "Workflow Model",
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: 4096,
      },
    ],
  });
  faux.setResponses(options.responses);
  const model = faux.getModel();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...options.settings });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: options.extensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  options.seed?.(sessionManager, model);

  const agent = new WorkflowAgent({
    cwd,
    tools: options.tools ?? [],
    model,
    ...(options.autoCompaction !== undefined ? { autoCompaction: options.autoCompaction } : {}),
    session: {
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
    },
  });

  return {
    agent,
    faux,
    model,
    sessionManager,
    settingsManager,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function seedCompactableSession(sessionManager: SessionManager, model: Model<any>, totalTokens = 80): void {
  const userId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "old context to compact" }],
    timestamp: Date.now() - 2000,
  });
  sessionManager.appendMessage({ ...assistant(model, "old answer", totalTokens), timestamp: Date.now() - 1000 });
  assert.ok(userId);
}

test("parallel WorkflowAgent children create isolated default ModelRuntime instances", async () => {
  const root = tmpDir("wf-runtime-isolation-");
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const faux = fauxProvider({ provider: `workflow-runtime-${++providerOrdinal}` });
  faux.setResponses([fauxAssistantMessage("left"), fauxAssistantMessage("right")]);

  const descriptor = Object.getOwnPropertyDescriptor(ModelRuntime, "create");
  assert.ok(descriptor);
  const originalCreate = ModelRuntime.create;
  const runtimes: ModelRuntime[] = [];
  Object.defineProperty(ModelRuntime, "create", {
    ...descriptor,
    value: async () => {
      const runtime = await originalCreate({ modelsPath: null, allowModelNetwork: false });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      runtimes.push(runtime);
      return runtime;
    },
  });

  try {
    const agent = new WorkflowAgent({
      cwd,
      tools: [],
      model: faux.getModel(),
      autoCompaction: false,
      session: { agentDir },
    });
    const results = await Promise.all([agent.run("first"), agent.run("second")]);
    assert.deepEqual([...results].sort(), ["left", "right"]);
    assert.equal(runtimes.length, 2);
    assert.notEqual(runtimes[0], runtimes[1]);
  } finally {
    Object.defineProperty(ModelRuntime, "create", descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("caller settingsManager requires a paired resourceLoader", () => {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  assert.throws(
    () => new WorkflowAgent({ tools: [], session: { settingsManager } }),
    /requires a paired session\.resourceLoader/,
  );
});

test("WorkflowAgent waits for Pi's transient provider retry and returns the recovered response", async () => {
  const harness = await createAgentHarness({
    responses: [
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
      fauxAssistantMessage("recovered after retry"),
    ],
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
  });
  try {
    assert.equal(await harness.agent.run("retry transient failure"), "recovered after retry");
    assert.equal(harness.faux.state.callCount, 2);
  } finally {
    harness.cleanup();
  }
});

test("terminal provider errors reject instead of returning stale assistant text", async () => {
  const harness = await createAgentHarness({
    responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })],
    autoCompaction: false,
    seed(sessionManager, model) {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "old question" }],
        timestamp: Date.now() - 2000,
      });
      sessionManager.appendMessage({ ...assistant(model, "stale success", 20), timestamp: Date.now() - 1000 });
    },
  });
  try {
    await assert.rejects(harness.agent.run("new question"), /Subagent provider failed: invalid_api_key/);
  } finally {
    harness.cleanup();
  }
});

test("telemetry excludes pre-existing history when a caller reuses a session manager", async () => {
  const compactUsage = usage(50, 0.5);
  const harness = await createAgentHarness({
    responses: [fauxAssistantMessage("current answer")],
    autoCompaction: false,
    seed(sessionManager, model) {
      const firstKeptEntryId = sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "old question" }],
        timestamp: Date.now() - 3000,
      });
      sessionManager.appendMessage({ ...assistant(model, "old answer", 100), timestamp: Date.now() - 2000 });
      sessionManager.appendCompaction("old summary", firstKeptEntryId, 100, {}, true, compactUsage);
    },
  });
  let telemetry: WorkflowAgentTelemetry | undefined;
  try {
    assert.equal(
      await harness.agent.run("current question", {
        onTelemetry: (event) => {
          telemetry = event;
        },
      }),
      "current answer",
    );
    assert.ok(telemetry?.usage);
    const currentAssistantUsage = harness.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .at(-1)?.message.usage;
    assert.ok(currentAssistantUsage);
    assert.equal(telemetry.usage.totalTokens, currentAssistantUsage.totalTokens);
    assert.equal(telemetry.usage.cost.total, currentAssistantUsage.cost.total);
    assert.equal(telemetry.usage.totalTokens, currentAssistantUsage.totalTokens);
  } finally {
    harness.cleanup();
  }
});

test("live session telemetry reports completed-turn usage before the subagent finishes", async () => {
  const first = fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
  let releaseTool!: () => void;
  const toolReleased = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let markToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const holdTool: ToolDefinition = {
    name: "hold",
    label: "Hold",
    description: "Pause until the test releases the tool",
    parameters: Type.Object({}),
    async execute() {
      markToolStarted();
      await toolReleased;
      return { content: [{ type: "text", text: "released" }], details: {} };
    },
  };
  const harness = await createAgentHarness({
    responses: [first, fauxAssistantMessage("finished")],
    tools: [holdTool],
    autoCompaction: false,
  });
  let handle: WorkflowAgentSessionHandle | undefined;
  let running: Promise<string> | undefined;
  try {
    running = harness.agent.run("measure while the tool is active", {
      onSessionHandle: (event) => {
        handle = event;
      },
    });
    await toolStarted;
    const live = handle?.getTelemetry?.();
    const completedTurnUsage = harness.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .at(-1)?.message.usage;
    assert.ok(completedTurnUsage);
    assert.ok(completedTurnUsage.totalTokens > 0);
    assert.equal(live?.tokens, completedTurnUsage.totalTokens);
    assert.equal(live?.usage?.cost.total, completedTurnUsage.cost.total);
    assert.equal(live?.toolCalls, 0, "the still-running tool has no result entry yet");
    releaseTool();
    assert.equal(await running, "finished");
  } finally {
    releaseTool();
    await running?.catch(() => {});
    harness.cleanup();
  }
});

test("overflow recovery delegates to the compaction extension and retries the child", async () => {
  const events: Array<{ reason: string; willRetry: boolean }> = [];
  const serverUsage = usage(17, 0.17);
  const serverCompaction: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      events.push({ reason: event.reason, willRetry: event.willRetry });
      return {
        compaction: {
          summary: "server-side checkpoint",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { adapter: "test-server" },
          usage: serverUsage,
        },
      };
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 1 } },
    autoCompaction: true,
    extensions: [serverCompaction],
    responses: [
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" }),
      fauxAssistantMessage("recovered"),
    ],
    seed: (sessionManager, model) => seedCompactableSession(sessionManager, model),
  });
  let telemetry: WorkflowAgentTelemetry | undefined;
  try {
    const result = await harness.agent.run("continue after overflow", {
      onTelemetry: (event) => {
        telemetry = event;
      },
    });
    assert.equal(result, "recovered");
    assert.deepEqual(events, [{ reason: "overflow", willRetry: true }]);
    assert.ok(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.ok((telemetry?.usage?.totalTokens ?? 0) >= serverUsage.totalTokens);
  } finally {
    harness.cleanup();
  }
});

test("omitted and explicit-false autoCompaction settings both preserve opt-out", async () => {
  for (const scenario of [
    { name: "persisted false", persisted: false, override: undefined },
    { name: "explicit false", persisted: true, override: false },
  ] as const) {
    let compactions = 0;
    const recordingCompaction: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", () => {
        compactions++;
        return { cancel: true };
      });
    };
    const harness = await createAgentHarness({
      contextWindow: 100,
      settings: {
        compaction: { enabled: scenario.persisted, reserveTokens: 10, keepRecentTokens: 1 },
      },
      ...(scenario.override !== undefined ? { autoCompaction: scenario.override } : {}),
      extensions: [recordingCompaction],
      responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" })],
      seed: (sessionManager, model) => seedCompactableSession(sessionManager, model),
    });
    try {
      await assert.rejects(harness.agent.run("overflow with compaction disabled"), /Subagent provider failed/);
      assert.equal(compactions, 0, scenario.name);
      assert.equal(harness.settingsManager.getCompactionEnabled(), false, scenario.name);
    } finally {
      harness.cleanup();
    }
  }
});

test("abort cancels an active compaction instead of waiting for its adapter timeout", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hangingCompaction: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", async (event) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (event.signal.aborted) resolve();
        else event.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { cancel: true };
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 } },
    extensions: [hangingCompaction],
    responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" })],
    seed: (sessionManager, model) => seedCompactableSession(sessionManager, model),
  });
  const controller = new AbortController();
  const run = harness.agent.run("trigger overflow", { signal: controller.signal });
  try {
    await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("compaction did not start")), 1000)),
    ]);
    controller.abort();
    await Promise.race([
      assert.rejects(run, /Subagent was aborted/),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort did not cancel compaction")), 1000)),
    ]);
  } finally {
    controller.abort();
    await run.catch(() => {});
    harness.cleanup();
  }
});

test("successful structured-output children skip terminal threshold compaction", async () => {
  const compactionReasons: string[] = [];
  const recordingCompaction: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      compactionReasons.push(event.reason);
      return { cancel: true };
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
    extensions: [recordingCompaction],
    responses: [fauxAssistantMessage(fauxToolCall("structured_output", { answer: "ok" }))],
  });
  try {
    assert.deepEqual(await harness.agent.run("x".repeat(10_000), { schema: Type.Object({ answer: Type.String() }) }), {
      answer: "ok",
    });
    assert.deepEqual(compactionReasons, []);
  } finally {
    harness.cleanup();
  }
});

test("successful one-shot children skip terminal threshold compaction", async () => {
  const compactionReasons: string[] = [];
  const recordingCompaction: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      compactionReasons.push(event.reason);
      return { cancel: true };
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
    extensions: [recordingCompaction],
    responses: [fauxAssistantMessage("done")],
  });
  try {
    assert.equal(await harness.agent.run("x".repeat(10_000)), "done");
    assert.deepEqual(compactionReasons, []);
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Mid-turn compaction boundaries
// ---------------------------------------------------------------------------

const MID_TURN_CONTINUE_PROMPT =
  "[mid-turn-compact] Context was compacted mid-task. Continue the current task from the latest tool results without restarting the goal.";

const noopTool: ToolDefinition = {
  name: "noop",
  label: "Noop",
  description: "Immediately succeed",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: {} };
  },
};

/**
 * Minimal extension that reproduces the mid-turn-compact protocol: abort at
 * the turn_start that follows a tool batch, then queue a continuation user
 * message once the run settles. Mirrors 0020-mid-turn-compact's lease shape
 * without the threshold math.
 *
 * With `resumeViaManualCompact`, the continuation is queued only after a
 * fire-and-forget `ctx.compact()` completes — 0020's fallback when Pi did not
 * compact the boundary turn itself.
 */
function midTurnBoundaryExtension(options: { resumeViaManualCompact?: boolean } = {}): ExtensionFactory {
  return (pi) => {
    let followsTools = false;
    let boundaryPending = false;
    const resume = (): void => pi.sendUserMessage(MID_TURN_CONTINUE_PROMPT);
    pi.on("turn_end", (event) => {
      const results = (event as { toolResults?: unknown[] }).toolResults;
      followsTools = Array.isArray(results) && results.length > 0;
    });
    pi.on("turn_start", (_event, ctx) => {
      if (!followsTools) return;
      followsTools = false;
      boundaryPending = true;
      ctx.abort();
    });
    pi.on("agent_settled", (_event, ctx) => {
      if (!boundaryPending) return;
      boundaryPending = false;
      if (options.resumeViaManualCompact) {
        ctx.compact({ onComplete: resume, onError: resume });
      } else {
        resume();
      }
    });
  };
}

function countUserMessages(sessionManager: SessionManager, text: string): number {
  return sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        (entry.message.content as unknown[]).some(
          (part) => typeof part === "object" && part !== null && (part as { text?: string }).text === text,
        ),
    ).length;
}

function hasBoundaryErrorTerminal(sessionManager: SessionManager): boolean {
  return sessionManager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        (entry.message.stopReason === "error" || entry.message.stopReason === "aborted"),
    );
}

test("mid-turn compaction boundary waits for the continuation run and returns its answer", async () => {
  const harness = await createAgentHarness({
    responses: [
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer after continuation"),
    ],
    tools: [noopTool],
    autoCompaction: false,
    extensions: [midTurnBoundaryExtension()],
  });
  try {
    assert.equal(await harness.agent.run("do the task"), "answer after continuation");
    // The boundary's aborted terminal and the continuation user message are
    // both present in the session, and the continuation consumed the second
    // scripted response.
    assert.ok(hasBoundaryErrorTerminal(harness.sessionManager));
    assert.equal(countUserMessages(harness.sessionManager, MID_TURN_CONTINUE_PROMPT), 1);
    assert.equal(harness.faux.state.callCount, 2);
  } finally {
    harness.cleanup();
  }
});

test("an abort-shaped provider error without a continuation still rejects as a provider failure", async () => {
  const harness = await createAgentHarness({
    responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "This operation was aborted" })],
    autoCompaction: false,
  });
  try {
    await assert.rejects(harness.agent.run("boom"), /Subagent provider failed: This operation was aborted/);
  } finally {
    harness.cleanup();
  }
});

test("a failing continuation run surfaces its own provider error", async () => {
  const harness = await createAgentHarness({
    responses: [
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "continuation exploded" }),
    ],
    tools: [noopTool],
    autoCompaction: false,
    extensions: [midTurnBoundaryExtension()],
  });
  try {
    await assert.rejects(harness.agent.run("do the task"), /Subagent provider failed: continuation exploded/);
  } finally {
    harness.cleanup();
  }
});

test("repeated mid-turn boundaries continue through every continuation run", async () => {
  const harness = await createAgentHarness({
    responses: [
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("final after two boundaries"),
    ],
    tools: [noopTool],
    autoCompaction: false,
    extensions: [midTurnBoundaryExtension()],
  });
  try {
    assert.equal(await harness.agent.run("do the task"), "final after two boundaries");
    assert.equal(harness.faux.state.callCount, 3);
    assert.equal(countUserMessages(harness.sessionManager, MID_TURN_CONTINUE_PROMPT), 2);
  } finally {
    harness.cleanup();
  }
});

test("a signal abort during the boundary wait aborts the subagent instead of hanging", async () => {
  const started = Promise.withResolvers<void>();
  let releaseHold!: () => void;
  const holdReleased = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const holdTool: ToolDefinition = {
    name: "hold",
    label: "Hold",
    description: "Pause until the test releases the tool",
    parameters: Type.Object({}),
    async execute() {
      started.resolve();
      await holdReleased;
      return { content: [{ type: "text", text: "released" }], details: {} };
    },
  };
  const harness = await createAgentHarness({
    responses: [
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    ],
    tools: [noopTool, holdTool],
    autoCompaction: false,
    extensions: [midTurnBoundaryExtension()],
  });
  const controller = new AbortController();
  const run = harness.agent.run("do the task", { signal: controller.signal });
  try {
    await within(started.promise, "continuation tool did not start");
    controller.abort();
    await within(assert.rejects(run, /Subagent was aborted/), "abort did not release the boundary wait");
  } finally {
    releaseHold();
    controller.abort();
    await run.catch(() => {});
    harness.cleanup();
  }
});

for (const continuation of [false, true]) {
  for (const lateFailure of [false, true]) {
    test(`cancellation shuts down a blocked ${continuation ? "continuation" : "initial"} tool before snapshot: late ${lateFailure ? "failure" : "success"}`, async () => {
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const lifecycle: string[] = [];
      let toolSignal: AbortSignal | undefined;
      const holdTool: ToolDefinition = {
        name: "hold",
        label: "Hold",
        description: "Released by extension shutdown",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          toolSignal = signal;
          started.resolve();
          await released.promise;
          lifecycle.push("tool released");
          finished.resolve();
          if (lateFailure) throw new Error("late tool failure");
          return { content: [{ type: "text", text: "late tool success" }], details: {} };
        },
      };
      const cleanupExtension: ExtensionFactory = (pi) => {
        pi.on("session_shutdown", async () => {
          lifecycle.push("shutdown");
          released.resolve();
          await finished.promise;
        });
      };
      const harness = await createAgentHarness({
        responses: [
          ...(continuation ? [fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })] : []),
          fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
        ],
        tools: [noopTool, holdTool],
        autoCompaction: false,
        extensions: [...(continuation ? [midTurnBoundaryExtension()] : []), cleanupExtension],
      });
      const controller = new AbortController();
      const run = harness.agent.run("do the task", {
        signal: controller.signal,
        onSessionEnd: () => lifecycle.push("snapshot"),
      });
      const rejected = assert.rejects(run, /Subagent was aborted/);
      try {
        await within(started.promise, "tool did not start");
        controller.abort();
        await within(rejected, "cancellation did not reach shutdown");
        assert.equal(toolSignal?.aborted, true);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        assert.deepEqual(lifecycle, ["shutdown", "tool released", "snapshot"]);
        // Drain late tool/session continuations. Node's test runner also reports
        // any unhandled rejection that escapes the cancelled prompt race.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.faux.state.callCount, continuation ? 2 : 1);
        assert.deepEqual(lifecycle, ["shutdown", "tool released", "snapshot"]);
      } finally {
        released.resolve();
        controller.abort();
        await rejected;
        harness.cleanup();
      }
    });
  }
}

test("an in-flight manual compaction at the boundary is awaited before the continuation", async () => {
  const serverUsage = usage(17, 0.17);
  const serverCompaction: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      if (event.reason !== "manual") return;
      return {
        compaction: {
          summary: "manual checkpoint",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { adapter: "test-manual" },
          usage: serverUsage,
        },
      };
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 1 } },
    responses: [
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer after manual compaction"),
    ],
    tools: [noopTool],
    autoCompaction: false,
    extensions: [midTurnBoundaryExtension({ resumeViaManualCompact: true }), serverCompaction],
    seed: (sessionManager, model) => seedCompactableSession(sessionManager, model),
  });
  try {
    assert.equal(await harness.agent.run("do the task"), "answer after manual compaction");
    assert.equal(countUserMessages(harness.sessionManager, MID_TURN_CONTINUE_PROMPT), 1);
    assert.ok(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
  } finally {
    harness.cleanup();
  }
});

test("cancellation aborts manual boundary compaction and awaits shutdown cleanup", async () => {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const lifecycle: string[] = [];
  let compactionSignal: AbortSignal | undefined;
  const compactAtBoundary: ExtensionFactory = (pi) => {
    let followsTools = false;
    let pending = false;
    pi.on("turn_end", (event) => {
      followsTools = event.toolResults.length > 0;
    });
    pi.on("turn_start", (_event, ctx) => {
      if (!followsTools) return;
      followsTools = false;
      pending = true;
      ctx.abort();
    });
    pi.on("agent_settled", (_event, ctx) => {
      if (!pending) return;
      pending = false;
      ctx.compact();
    });
    pi.on("session_before_compact", async (event) => {
      compactionSignal = event.signal;
      await new Promise<void>((resolve) => {
        event.signal.addEventListener("abort", () => resolve(), { once: true });
        if (event.signal.aborted) resolve();
        started.resolve();
      });
      lifecycle.push("compaction aborted");
      finished.resolve();
      return { cancel: true };
    });
    pi.on("session_shutdown", async () => {
      await finished.promise;
      lifecycle.push("shutdown");
    });
  };
  const harness = await createAgentHarness({
    contextWindow: 100,
    settings: { compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 1 } },
    responses: [fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })],
    tools: [noopTool],
    autoCompaction: false,
    extensions: [compactAtBoundary],
  });
  const controller = new AbortController();
  const run = harness.agent.run("do the task", {
    signal: controller.signal,
    onSessionEnd: () => lifecycle.push("snapshot"),
  });
  const rejected = assert.rejects(run, /Subagent was aborted/);
  try {
    await within(started.promise, "manual compaction did not start");
    controller.abort();
    await within(rejected, "abort did not release manual compaction");
    assert.equal(compactionSignal?.aborted, true);
    assert.deepEqual(lifecycle, ["compaction aborted", "shutdown", "snapshot"]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(harness.faux.state.callCount, 1);
  } finally {
    controller.abort();
    finished.resolve();
    await rejected;
    harness.cleanup();
  }
});

for (const scenario of ["success", "provider-error", "retry", "pre-abort", "bind-error", "nudge"] as const) {
  test(`child startup, resource discovery and shutdown are balanced: ${scenario}`, async (t) => {
    const lifecycle: string[] = [];
    let snapshot: readonly unknown[] | undefined;
    const originalDispose = AgentSession.prototype.dispose;
    const dispose = t.mock.method(AgentSession.prototype, "dispose", function (this: AgentSession) {
      assert.ok(snapshot, "snapshot captured before invalidation");
      assert.equal(lifecycle.at(-1), "snapshot");
      return originalDispose.call(this);
    });
    const capture: ExtensionFactory = (pi) => {
      pi.on("session_start", (_event, ctx) => {
        assert.equal(ctx.mode, "print");
        assert.equal(ctx.hasUI, false);
        lifecycle.push("start");
      });
      pi.on("resources_discover", () => {
        lifecycle.push("resources");
        return scenario === "bind-error" ? { promptPaths: ["/fake/prompt"] } : undefined;
      });
      pi.on("session_shutdown", () => {
        lifecycle.push("shutdown");
      });
    };
    const responses =
      scenario === "provider-error"
        ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]
        : scenario === "retry"
          ? [
              fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
              fauxAssistantMessage("ok"),
            ]
          : scenario === "nudge"
            ? [
                fauxAssistantMessage("forgot the tool"),
                fauxAssistantMessage(fauxToolCall("structured_output", { answer: "ok" }), { stopReason: "toolUse" }),
              ]
            : [fauxAssistantMessage("ok")];
    const harness = await createAgentHarness({
      responses,
      extensions: [capture],
      autoCompaction: false,
      settings: { retry: { enabled: scenario === "retry", maxRetries: 1, baseDelayMs: 1 } },
    });
    if (scenario === "bind-error") {
      // Exercise the resource-discovery failure after startup, not a provider error.
      const loader = (harness.agent as any).sessionOptions.resourceLoader;
      loader.extendResources = () => {
        throw new Error("resource discovery failed");
      };
    }
    const controller = new AbortController();
    if (scenario === "pre-abort") controller.abort();
    try {
      const run = harness.agent.run("task", {
        signal: controller.signal,
        ...(scenario === "nudge" ? { schema: Type.Object({ answer: Type.String() }) } : {}),
        onSessionEnd: (messages) => {
          snapshot = messages;
          lifecycle.push("snapshot");
        },
      });
      if (["provider-error", "pre-abort", "bind-error"].includes(scenario)) await assert.rejects(run);
      else assert.deepEqual(await run, scenario === "nudge" ? { answer: "ok" } : "ok");
      assert.deepEqual(lifecycle, ["start", "resources", "shutdown", "snapshot"]);
      assert.ok(Array.isArray(snapshot));
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      if (scenario === "retry" || scenario === "nudge") assert.equal(harness.faux.state.callCount, 2);
    } finally {
      harness.cleanup();
    }
  });
}

test("attempt telemetry counts all standalone usage kinds, tools and summaries exactly once", async () => {
  const harness = await createAgentHarness({
    responses: [fauxAssistantMessage("ok")],
    autoCompaction: false,
    extensions: [
      (pi) => {
        pi.on("before_agent_start", () => {
          const sm = harness.sessionManager;
          const kept = sm.appendMessage({ role: "user", content: "owned history", timestamp: 1 });
          sm.appendMessage(assistant(harness.model, "compacted answer", 100));
          sm.appendMessage({ role: "system", content: "policy", timestamp: 2 });
          sm.appendUsage("cache_warm", "test", "one", usage(20));
          sm.appendUsage("future_unknown_kind", "test", "two", usage(30));
          sm.appendMessage({
            role: "toolResult",
            toolCallId: "nested",
            toolName: "nested",
            content: [],
            isError: false,
            timestamp: 3,
            usage: usage(40),
          });
          sm.appendCompaction("summary", kept, 100, {}, true, usage(50));
          sm.branchWithSummary(sm.getLeafId(), "branch", {}, true, usage(60));
        });
        pi.on("session_shutdown", () => {
          harness.sessionManager.appendUsage("shutdown_overhead", "test", "three", usage(7));
        });
      },
    ],
  });
  let telemetry: WorkflowAgentTelemetry | undefined;
  try {
    await harness.agent.run("task", {
      onTelemetry: (value) => {
        telemetry = value;
      },
    });
    const response = harness.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .at(-1);
    assert.ok(response);
    assert.equal(response.type, "message");
    const currentUsage = (response as any).message.usage;
    assert.equal(telemetry?.tokens, 307 + currentUsage.totalTokens);
    assert.ok(Math.abs((telemetry?.usage?.cost.total ?? 0) - (0.307 + currentUsage.cost.total)) < 1e-12);
    assert.equal(telemetry?.toolCalls, 1);
  } finally {
    harness.cleanup();
  }
});
