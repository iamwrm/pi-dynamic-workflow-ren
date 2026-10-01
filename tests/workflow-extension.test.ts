import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension, { WORKFLOW_ACCESS_MESSAGE_TYPE, WORKFLOW_STATUS_TOOL_NAME } from "../extensions/workflow.js";

type ToolSpec = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  outputSchema?: unknown;
  exposure?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: string;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
    terminate?: boolean;
    structuredContent?: unknown;
  }>;
};

type CommandSpec = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

type EventHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type BranchEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
};

type SentMessage = {
  message: {
    customType?: string;
    content?: string | Array<{ type: string; text?: string }>;
    display?: boolean;
    details?: unknown;
  };
  options?: { triggerTurn?: boolean; deliverAs?: string };
};

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createExtensionHarness(
  options: { active?: string[]; branch?: BranchEntry[]; cwd?: string; availableTools?: string[] } = {},
) {
  const tools = new Map<string, ToolSpec>();
  const commands = new Map<string, CommandSpec>();
  const handlers = new Map<string, EventHandler[]>();
  const activeTransitions: string[][] = [];
  const appendedEntries: BranchEntry[] = [];
  const sentMessages: SentMessage[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const operationLog: string[] = [];
  let active = [...(options.active ?? [])];
  let branch = [...(options.branch ?? [])];
  let branchError: Error | undefined;
  let nextEntryId = 1;
  const cwd = options.cwd ?? tmpDir("wf-extension-");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {
      operationLog.push("waitForIdle");
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: {
      buildSessionProjection: () => {
        if (branchError) throw branchError;
        return {
          messages: branch.flatMap((entry) => {
            if (entry.type === "message") return [entry.message];
            if (entry.type === "custom_message") return [{ role: "custom", ...entry }];
            if (entry.type === "compaction" || entry.type === "branch_summary") return [{ role: "user" }];
            return [];
          }),
        };
      },
      getBranch: () => {
        if (branchError) throw branchError;
        return branch;
      },
    },
  };

  extension({
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerTool: (tool: ToolSpec) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: CommandSpec) => commands.set(name, command),
    on: (event: string, handler: EventHandler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    getThinkingLevel: () => "medium",
    getAllTools: () =>
      [...tools.values()]
        .filter((tool) => !options.availableTools || options.availableTools.includes(tool.name))
        .map((tool) => ({ name: tool.name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      operationLog.push("setActiveTools");
      active = [...names];
      activeTransitions.push([...names]);
    },
    appendEntry: (customType: string, data?: unknown) => {
      operationLog.push("appendEntry");
      const entry: BranchEntry = {
        type: "custom",
        id: `custom-${nextEntryId++}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      };
      appendedEntries.push(entry);
      branch.push(entry);
    },
    sendMessage: (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
      operationLog.push(`sendMessage:${message.customType ?? "unknown"}`);
      sentMessages.push({ message, options: sendOptions });
      branch.push({ type: "custom_message", ...message });
    },
  } as never);

  return {
    tools,
    commands,
    activeTransitions,
    appendedEntries,
    sentMessages,
    notifications,
    operationLog,
    ctx,
    get active() {
      return [...active];
    },
    get branch() {
      return [...branch];
    },
    replaceBranch(entries: BranchEntry[]) {
      branch = [...entries];
    },
    setBranchError(error: Error | undefined) {
      branchError = error;
    },
    clearObservations() {
      activeTransitions.length = 0;
      appendedEntries.length = 0;
      sentMessages.length = 0;
      notifications.length = 0;
      operationLog.length = 0;
    },
    async emit(event: string, payload: unknown) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
  };
}

async function enable(harness: ReturnType<typeof createExtensionHarness>): Promise<void> {
  const command = harness.commands.get("workflow.enable");
  assert.ok(command);
  await command.handler("", harness.ctx);
  harness.clearObservations();
}

test("fresh sessions expose only small workflow status/loading tools and keep definitions metadata-free", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_status", "workflow_load", "workflow", "workflow_tasks", "third_party"],
  });

  assert.deepEqual([...harness.tools.keys()].sort(), [
    "workflow",
    "workflow_load",
    "workflow_status",
    "workflow_tasks",
  ]);
  const loader = harness.tools.get("workflow_load");
  const workflow = harness.tools.get("workflow");
  const tasks = harness.tools.get("workflow_tasks");
  assert.ok(loader);
  assert.ok(workflow);
  assert.ok(tasks);

  assert.equal(loader.executionMode, "sequential");
  assert.deepEqual(loader.parameters.properties ?? {}, {});
  assert.equal(loader.promptSnippet, undefined);
  assert.equal(loader.promptGuidelines, undefined);
  assert.ok(loader.description.length <= 200, `loader description grew to ${loader.description.length} characters`);
  assert.match(loader.description, /multi-agent|multiple agents/i);
  assert.equal(workflow.promptSnippet, undefined);
  assert.equal(workflow.promptGuidelines, undefined);
  assert.equal(tasks.promptSnippet, undefined);
  assert.equal(tasks.promptGuidelines, undefined);

  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.active, ["read", "workflow_status", "workflow_load", "third_party"]);
  assert.deepEqual(harness.activeTransitions, [["read", "workflow_status", "workflow_load", "third_party"]]);
  assert.deepEqual(harness.sentMessages, [], "fresh startup needs no redundant access notice");
});

for (const branch of [
  [],
  [{ type: "custom", customType: "metadata", data: { enabled: true } }],
  [{ type: "message", message: { role: "system" } }],
]) {
  test(`metadata-only startup skips access notices: ${JSON.stringify(branch)}`, async () => {
    const harness = createExtensionHarness({ branch });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(harness.sentMessages, []);
    assert.equal((await access(harness)).details?.enabled, false);
  });
}

for (const entry of [
  { type: "message", message: { role: "user", content: "existing conversation" } },
  { type: "message", message: { role: "assistant", content: [] } },
  { type: "custom_message", customType: WORKFLOW_ACCESS_MESSAGE_TYPE, details: { enabled: true } },
  { type: "compaction", summary: "Earlier workflow access was enabled" },
  { type: "branch_summary", summary: "Earlier workflow access was enabled" },
]) {
  test(`nonempty startup reasserts disabled state: ${entry.type}/${entry.customType ?? ""}`, async () => {
    const harness = createExtensionHarness({ branch: [entry] });
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].message.content, "Workflow access disabled.");
    assert.equal((await access(harness)).details?.enabled, false);
  });
}

test("an unreadable projection keeps permission disabled and appends a reset notice", async () => {
  const harness = createExtensionHarness();
  harness.setBranchError(new Error("projection unavailable"));
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(harness.sentMessages[0]?.message.content, "Workflow access disabled.");
  assert.equal((await access(harness)).details?.enabled, false);
});

test("lifecycle management does not override an explicit tool selection that omitted workflow_load", async () => {
  const harness = createExtensionHarness({ active: ["read", "workflow", "workflow_tasks"] });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.active, ["read", "workflow", "workflow_tasks"]);
  assert.deepEqual(harness.activeTransitions, []);
});

test("workflow_load activates additively, returns a live catalog, and is idempotent", async () => {
  const cwd = tmpDir("wf-loader-");
  const harness = createExtensionHarness({
    cwd,
    active: ["read", "workflow_load", "workflow", "workflow_tasks", "third_party"],
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await enable(harness);

  const projectDir = path.join(cwd, ".pi", "workflows");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "late.js"),
    "export const meta = { name: 'late-project-flow', description: 'created after registration' }\nreturn args",
  );

  const loader = harness.tools.get("workflow_load");
  assert.ok(loader);
  const first = await loader.execute("load-1", {}, undefined, undefined, harness.ctx);
  const firstText = toolResultText(first);
  assert.deepEqual(harness.active, ["read", "workflow_load", "third_party", "workflow", "workflow_tasks"]);
  assert.equal(new Set(harness.active).size, harness.active.length);
  assert.match(firstText, /late-project-flow/);
  assert.match(firstText, /deep-research/);
  assert.match(firstText, /workflow_tasks/);
  assert.equal(harness.sentMessages.length, 0, "a model-called loader returns its guide in the tool result");
  assert.equal(harness.appendedEntries.length, 1);
  assert.equal(harness.appendedEntries[0].type, "custom");
  assert.match(harness.appendedEntries[0].customType ?? "", /workflow.*loaded|tools-loaded/i);

  fs.writeFileSync(
    path.join(projectDir, "later.js"),
    "export const meta = { name: 'even-later-flow', description: 'created before the second load' }\nreturn args",
  );
  const second = await loader.execute("load-2", {}, undefined, undefined, harness.ctx);
  assert.match(toolResultText(second), /even-later-flow/);
  assert.deepEqual(harness.active, ["read", "workflow_load", "third_party", "workflow", "workflow_tasks"]);
  assert.equal(harness.appendedEntries.length, 1, "reloading the guide must not append duplicate durable markers");
});

test("workflow_load reports CLI-filtered full tools as unavailable and does not persist a false success marker", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load"],
    availableTools: ["workflow_load"],
  });
  const loader = harness.tools.get("workflow_load");
  assert.ok(loader);

  await enable(harness);
  const result = await loader.execute("load-filtered", {}, undefined, undefined, harness.ctx);
  assert.deepEqual(harness.active, ["read", "workflow_load"]);
  assert.match(toolResultText(result), /core workflow orchestration tool could not be loaded/i);
  assert.match(toolResultText(result), /workflow/);
  assert.equal(result.details?.workflowLoaded, false);
  assert.equal(result.details?.fullyLoaded, false);
  assert.deepEqual(result.details?.unavailableTools, ["workflow", "workflow_tasks"]);
  assert.equal(harness.appendedEntries.length, 0);
});

test("workflow_load keeps its guide and marker when only optional workflow_tasks is filtered", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load"],
    availableTools: ["workflow_load", "workflow"],
  });
  const loader = harness.tools.get("workflow_load");
  assert.ok(loader);

  await enable(harness);
  const result = await loader.execute("load-core-only", {}, undefined, undefined, harness.ctx);
  const text = toolResultText(result);
  assert.deepEqual(harness.active, ["read", "workflow_load", "workflow"]);
  assert.match(text, /workflow orchestration guidance is loaded/i);
  assert.match(text, /Availability note: workflow_tasks is excluded/i);
  assert.equal(result.details?.workflowLoaded, true);
  assert.equal(result.details?.fullyLoaded, false);
  assert.deepEqual(result.details?.unavailableTools, ["workflow_tasks"]);
  assert.equal(harness.appendedEntries.length, 1);

  harness.clearObservations();
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.deepEqual(harness.active, ["read", "workflow_load", "workflow"]);
  assert.equal(harness.appendedEntries.length, 0);
});

test("session_start and session_tree restore full tools only on branches containing the durable marker", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load", "workflow", "workflow_tasks"],
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  const loader = harness.tools.get("workflow_load");
  assert.ok(loader);
  await enable(harness);
  await loader.execute("load", {}, undefined, undefined, harness.ctx);
  const marker = harness.branch.find(
    (entry) => entry.type === "custom" && /workflow|tools/.test(entry.customType ?? ""),
  );
  assert.ok(marker, "loader must append a branch-local durable marker");

  harness.replaceBranch([]);
  await harness.emit("session_tree", { type: "session_tree", oldLeafId: "after", newLeafId: "before" });
  assert.deepEqual(harness.active, ["read", "workflow_load"]);

  harness.replaceBranch([
    marker,
    { type: "compaction", id: "compact-1", parentId: null, timestamp: new Date(0).toISOString() },
  ]);
  await harness.emit("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" });
  assert.deepEqual(harness.active, ["read", "workflow_load", "workflow", "workflow_tasks"]);

  harness.replaceBranch([{ type: "custom_message", customType: marker.customType }]);
  await harness.emit("session_tree", { type: "session_tree", oldLeafId: "after", newLeafId: "message-only" });
  assert.deepEqual(harness.active, ["read", "workflow_load"], "a context message is not the durable state marker");

  harness.replaceBranch([marker]);
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.deepEqual(harness.active, ["read", "workflow_load", "workflow", "workflow_tasks"]);
});
test("a branch-read failure fails closed to loader-only", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load", "workflow", "workflow_tasks"],
  });
  harness.setBranchError(new Error("session is unavailable"));
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.deepEqual(harness.active, ["read", "workflow_load"]);
});

test("/run-workflow activates tools, injects the guide, prepares arguments, and then dispatches directly", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load", "workflow", "workflow_tasks", "third_party"],
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await enable(harness);

  const workflow = harness.tools.get("workflow");
  const command = harness.commands.get("run-workflow");
  assert.ok(workflow);
  assert.ok(command);

  let rawArguments: unknown;
  let executedArguments: unknown;
  const preparedArguments = { name: "code-review", args: { target: "HEAD" }, runId: "prepared-run" };
  workflow.prepareArguments = (args) => {
    harness.operationLog.push("prepareArguments");
    rawArguments = args;
    return preparedArguments;
  };
  workflow.execute = async (_toolCallId, params) => {
    harness.operationLog.push("execute");
    executedArguments = params;
    return {
      content: [{ type: "text", text: "Workflow code-review completed." }],
      details: { status: "completed", name: "code-review", runId: "prepared-run" },
    };
  };

  await command.handler('code-review {"target":"HEAD"}', harness.ctx);

  assert.deepEqual(rawArguments, { name: "code-review", args: { target: "HEAD" } });
  assert.equal(executedArguments, preparedArguments, "execute must receive prepareArguments' return value");
  assert.deepEqual(harness.active, ["read", "workflow_load", "third_party", "workflow", "workflow_tasks"]);
  assert.equal(harness.appendedEntries.length, 1);

  const guide = harness.sentMessages.find((entry) => entry.message.customType === "workflow_guide");
  const result = harness.sentMessages.find((entry) => entry.message.customType === "workflow_result");
  assert.ok(guide, "the model-free command must inject the same workflow guide into model context");
  assert.equal(guide.message.display, false);
  assert.notEqual(guide.options?.triggerTurn, true, "the guide must not start a model turn before dispatch");
  assert.ok(result, "the completed direct dispatch must still post its normal workflow_result");

  const setIndex = harness.operationLog.indexOf("setActiveTools");
  const idleIndex = harness.operationLog.indexOf("waitForIdle");
  const prepareIndex = harness.operationLog.indexOf("prepareArguments");
  const executeIndex = harness.operationLog.indexOf("execute");
  const guideIndex = harness.operationLog.indexOf("sendMessage:workflow_guide");
  assert.ok(idleIndex >= 0 && idleIndex < setIndex);
  assert.ok(setIndex >= 0 && setIndex < executeIndex);
  assert.ok(guideIndex >= 0 && guideIndex < executeIndex);
  assert.ok(prepareIndex >= 0 && prepareIndex < executeIndex);
});

test("/run-workflow parse failures do not activate tools or add workflow context", async () => {
  const harness = createExtensionHarness({ active: ["read", "workflow_load"] });
  const command = harness.commands.get("run-workflow");
  assert.ok(command);

  await enable(harness);
  await command.handler("does-not-exist target", harness.ctx);
  assert.deepEqual(harness.active, ["read", "workflow_load"]);
  assert.equal(harness.activeTransitions.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.notifications[0]?.message ?? "", /Unknown workflow/);
});

test("a fast background result terminates launch, waits for settlement, and triggers one fresh turn", async () => {
  const harness = createExtensionHarness({ active: ["workflow_load", "workflow"] });
  harness.ctx.mode = "tui";
  harness.ctx.hasUI = true;
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await enable(harness);

  // Model turn that launches the workflow is active. An already-aborted signal
  // makes the detached run complete immediately without invoking a real model.
  await harness.emit("agent_start", { type: "agent_start" });
  const controller = new AbortController();
  controller.abort();
  const workflow = harness.tools.get("workflow");
  assert.ok(workflow);
  const immediate = await workflow.execute(
    "background-fast",
    {
      script:
        "export const meta = { name: 'fast_background', description: 'delivery lifecycle test' }\nawait agent('x')\nreturn 1",
    },
    controller.signal,
    undefined,
    harness.ctx,
  );

  assert.equal(immediate.details?.status, "running");
  assert.equal(immediate.terminate, true);
  await harness.commands.get("workflow.disable")?.handler("", harness.ctx);
  assert.equal(
    harness.sentMessages.find((entry) => entry.message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE)?.message.content,
    "Workflow access disabled. Accepted runs continue; /kill-workflow cancels a run.",
  );
  await assert.rejects(
    harness.tools
      .get("workflow_tasks")
      ?.execute("disabled-poll", { action: "list" }, undefined, undefined, harness.ctx) ?? Promise.resolve(),
    /WORKFLOW_DISABLED/,
  );
  await waitFor(
    () => harness.notifications.some((entry) => /aborted/.test(entry.message)),
    "detached workflow did not settle",
  );
  assert.equal(
    harness.sentMessages.filter((entry) => entry.message.customType === "workflow_result").length,
    0,
    "completion must remain queued while the launching parent is active",
  );

  await harness.emit("agent_settled", { type: "agent_settled" });
  await waitFor(
    () => harness.sentMessages.some((entry) => entry.message.customType === "workflow_result"),
    "queued completion was not delivered after settlement",
  );
  const delivered = harness.sentMessages.filter((entry) => entry.message.customType === "workflow_result");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options?.triggerTurn, true);

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "test" });
});

async function access(harness: ReturnType<typeof createExtensionHarness>) {
  const status = harness.tools.get(WORKFLOW_STATUS_TOOL_NAME);
  assert.ok(status);
  return status.execute("status", {}, undefined, undefined, harness.ctx);
}

test("workflow_status is small, structured, and side-effect-free while disabled or enabled", async () => {
  const harness = createExtensionHarness({ active: ["workflow_status", "workflow_load"] });
  const status = harness.tools.get(WORKFLOW_STATUS_TOOL_NAME);
  assert.ok(status);
  assert.deepEqual(status.parameters.properties, {});
  assert.ok(status.outputSchema);
  assert.equal(status.promptSnippet, undefined);
  assert.equal(status.promptGuidelines, undefined);
  assert.match(status.description, /before drafting or loading multi-agent workflows/);
  assert.ok(status.description.length <= 160);
  assert.deepEqual((await access(harness)).structuredContent, { enabled: false, enableCommand: "/workflow.enable" });
  assert.equal(harness.operationLog.length, 0);
  await enable(harness);
  assert.deepEqual((await access(harness)).structuredContent, { enabled: true, enableCommand: "/workflow.enable" });
  assert.equal(harness.operationLog.length, 0);
  assert.deepEqual(harness.active, ["workflow_status", "workflow_load"]);
});

test("disabled execution rejects every workflow entry before reading context or writing files", async () => {
  for (const active of [
    ["workflow_status", "workflow_load"],
    ["workflow", "workflow_tasks"],
  ]) {
    const harness = createExtensionHarness({ active });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    harness.clearObservations();
    const untouchedContext = {
      get cwd() {
        throw new Error("a disabled tool must not read execution context");
      },
    };
    for (const [name, params] of [
      ["workflow_load", {}],
      ["workflow", { scriptPath: "/must-not-read.js" }],
      ["workflow_tasks", { action: "kill", runId: "must-not-kill" }],
    ] as const) {
      const tool = harness.tools.get(name);
      assert.ok(tool);
      await assert.rejects(
        tool.execute("blocked", params, undefined, undefined, untouchedContext),
        /WORKFLOW_DISABLED/,
      );
    }
    assert.deepEqual(harness.operationLog, []);
    assert.deepEqual(fs.readdirSync(harness.ctx.cwd), []);
    const command = harness.commands.get("run-workflow");
    assert.ok(command);
    await command.handler("does-not-exist", harness.ctx);
    assert.match(harness.notifications[0]?.message ?? "", /WORKFLOW_DISABLED/);
    assert.deepEqual(harness.operationLog, []);
  }
});

test("tool_call blocks direct and nested workflow calls but never blocks status", async () => {
  const harness = createExtensionHarness();
  for (const toolName of ["workflow_load", "workflow", "workflow_tasks"]) {
    for (const parentToolCallId of [undefined, "codemode-call"]) {
      const results = await harness.emit("tool_call", { toolName, parentToolCallId, input: {} });
      assert.deepEqual(results, [{ block: true, reason: results[0]?.reason }]);
      assert.match(results[0]?.reason ?? "", /WORKFLOW_DISABLED/);
    }
  }
  assert.deepEqual(await harness.emit("tool_call", { toolName: "workflow_status", input: {} }), [undefined]);
  assert.deepEqual(await harness.emit("tool_call", { toolName: "read", input: {} }), [undefined]);
  await enable(harness);
  assert.deepEqual(await harness.emit("tool_call", { toolName: "workflow_load", input: {} }), [undefined]);
});

test("toggles do not change declarations or active tools, and repeated commands append no notices", async () => {
  const harness = createExtensionHarness({ active: ["read", "workflow_status", "workflow_load", "third_party"] });
  const declarations = () => JSON.stringify([...harness.tools.values()]);
  const before = declarations();
  const enableCommand = harness.commands.get("workflow.enable");
  const disableCommand = harness.commands.get("workflow.disable");
  assert.ok(enableCommand);
  assert.ok(disableCommand);
  await enableCommand.handler("", harness.ctx);
  await enableCommand.handler("", harness.ctx);
  await disableCommand.handler("", harness.ctx);
  await disableCommand.handler("", harness.ctx);
  assert.equal(declarations(), before);
  assert.deepEqual(harness.activeTransitions, []);
  assert.deepEqual(harness.active, ["read", "workflow_status", "workflow_load", "third_party"]);
  assert.equal(harness.sentMessages.length, 2);
  assert.deepEqual(
    harness.sentMessages.map((entry) => entry.message.content),
    ["Workflow access enabled for this session.", "Workflow access disabled."],
  );
  assert.ok(harness.sentMessages.every((entry) => entry.message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE));
  assert.ok(harness.sentMessages.every((entry) => entry.options?.triggerTurn === false));
  assert.equal(harness.operationLog.includes("waitForIdle"), false, "revocation cannot wait for idle");
  assert.deepEqual(harness.appendedEntries, [], "permission is not persisted as authorization");
  await enableCommand.handler("true", harness.ctx);
  assert.equal((await access(harness)).details?.enabled, false, "commands accept no alternate permission inputs");
});

test("loaded tools remain declared after disable and a stale enabled status cannot authorize execution", async () => {
  const harness = createExtensionHarness({ active: ["workflow_status", "workflow_load"] });
  await enable(harness);
  const oldStatus = await access(harness);
  const loader = harness.tools.get("workflow_load");
  assert.ok(loader);
  await loader.execute("load", {}, undefined, undefined, harness.ctx);
  const active = harness.active;
  harness.clearObservations();
  await harness.commands.get("workflow.disable")?.handler("", harness.ctx);
  assert.deepEqual(harness.active, active);
  assert.deepEqual(harness.activeTransitions, []);
  assert.equal(oldStatus.details?.enabled, true);
  assert.equal((await access(harness)).details?.enabled, false);
  await assert.rejects(loader.execute("stale", {}, undefined, undefined, harness.ctx), /WORKFLOW_DISABLED/);
  assert.deepEqual(harness.appendedEntries, []);
});

for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
  test(`session_start ${reason} resets permission independently of loaded markers and old notices`, async () => {
    const harness = createExtensionHarness({ active: ["workflow_status", "workflow_load"] });
    await enable(harness);
    await harness.tools.get("workflow_load")?.execute("load", {}, undefined, undefined, harness.ctx);
    assert.equal((await access(harness)).details?.enabled, true);
    harness.clearObservations();
    await harness.emit("session_start", { type: "session_start", reason });
    assert.equal((await access(harness)).details?.enabled, false);
    assert.deepEqual(harness.active, ["workflow_status", "workflow_load", "workflow", "workflow_tasks"]);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal((harness.sentMessages[0].message.details as { enabled: boolean }).enabled, false);
  });
}

test("history navigation and compaction report live permission instead of restoring historical permission", async () => {
  const harness = createExtensionHarness({ active: ["workflow_status", "workflow_load"] });
  await enable(harness);
  harness.replaceBranch([
    { type: "custom_message", customType: WORKFLOW_ACCESS_MESSAGE_TYPE, details: { enabled: false } },
  ]);
  await harness.emit("session_tree", { type: "session_tree" });
  assert.equal((await access(harness)).details?.enabled, true);
  await harness.commands.get("workflow.disable")?.handler("", harness.ctx);
  harness.replaceBranch([
    { type: "custom_message", customType: WORKFLOW_ACCESS_MESSAGE_TYPE, details: { enabled: true } },
  ]);
  await harness.emit("session_tree", { type: "session_tree" });
  assert.equal((await access(harness)).details?.enabled, false);
  await harness.emit("session_compact", { type: "session_compact" });
  assert.equal((harness.sentMessages.at(-1)?.message.details as { enabled: boolean }).enabled, false);
  assert.ok(harness.sentMessages.every((entry) => entry.options?.triggerTurn === false));
  assert.ok(harness.commands.has("workflows"));
  assert.ok(harness.commands.has("kill-workflow"));
});

test("/run-workflow rechecks permission after waiting for idle", async () => {
  const harness = createExtensionHarness({ active: ["workflow_status", "workflow_load"] });
  await enable(harness);
  harness.ctx.waitForIdle = async () => {
    await harness.commands.get("workflow.disable")?.handler("", harness.ctx);
  };
  const command = harness.commands.get("run-workflow");
  assert.ok(command);
  await command.handler("code-review HEAD", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /WORKFLOW_DISABLED/);
  assert.deepEqual(harness.activeTransitions, []);
  assert.deepEqual(harness.appendedEntries, []);
  assert.ok(harness.sentMessages.every((entry) => entry.message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE));
});
