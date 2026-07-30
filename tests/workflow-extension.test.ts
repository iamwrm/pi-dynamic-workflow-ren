import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../extensions/workflow.js";

type ToolSpec = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
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
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
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
    hasUI: false,
    waitForIdle: async () => {
      operationLog.push("waitForIdle");
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: {
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
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

test("fresh sessions expose only the small workflow loader and keep the full definitions metadata-free", async () => {
  const harness = createExtensionHarness({
    active: ["read", "workflow_load", "workflow", "workflow_tasks", "third_party"],
  });

  assert.deepEqual([...harness.tools.keys()].sort(), ["workflow", "workflow_load", "workflow_tasks"]);
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
  assert.ok(loader.description.length <= 700, `loader description grew to ${loader.description.length} characters`);
  assert.match(loader.description, /multi-agent|multiple agents/i);
  assert.equal(workflow.promptSnippet, undefined);
  assert.equal(workflow.promptGuidelines, undefined);
  assert.equal(tasks.promptSnippet, undefined);
  assert.equal(tasks.promptGuidelines, undefined);

  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.active, ["read", "workflow_load", "third_party"]);
  assert.deepEqual(harness.activeTransitions, [["read", "workflow_load", "third_party"]]);
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
  harness.clearObservations();

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
  harness.clearObservations();

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

  await command.handler("does-not-exist target", harness.ctx);
  assert.deepEqual(harness.active, ["read", "workflow_load"]);
  assert.equal(harness.activeTransitions.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.notifications[0]?.message ?? "", /Unknown workflow/);
});
