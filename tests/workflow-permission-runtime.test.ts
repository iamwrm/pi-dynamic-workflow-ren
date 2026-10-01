import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension, { WORKFLOW_ACCESS_MESSAGE_TYPE } from "../extensions/workflow.js";

let ordinal = 0;

async function harness(seed?: (manager: SessionManager) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-permission-runtime-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const faux = fauxProvider({ provider: `workflow-permission-${++ordinal}` });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode"],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension, createCodemodeExtension()],
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(root);
  seed?.(sessionManager);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager,
    modelRuntime,
    model: faux.getModel(),
  });
  await session.bindExtensions({ mode: "rpc" });
  const requests: TranscriptContext[] = [];
  const capture = (context: TranscriptContext) => requests.push(JSON.parse(JSON.stringify(context)));
  const respond = (calls: ReturnType<typeof fauxToolCall>[] = []) => {
    faux.setResponses([
      (context) => {
        capture(context);
        return fauxAssistantMessage(calls.length ? calls : "DONE", { stopReason: calls.length ? "toolUse" : "stop" });
      },
      ...(calls.length
        ? [
            (context: TranscriptContext) => {
              capture(context);
              return fauxAssistantMessage("DONE");
            },
          ]
        : []),
    ]);
  };
  const results = () => session.messages.filter((message) => message.role === "toolResult");
  return {
    root,
    faux,
    session,
    requests,
    capture,
    respond,
    results,
    cleanup() {
      session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("cold bootstrap footprint keeps full workflow schemas and guide out of the request", async () => {
  const h = await harness();
  try {
    h.respond();
    await h.session.prompt("continue single-agent");
    const request = h.requests[0];
    const workflowNames = ["workflow_status", "workflow_load"];
    const definitions = workflowNames.map((name) => {
      const definition = h.session.getToolDefinition(name);
      assert.ok(definition);
      return definition;
    });
    const declarations = request.messages.flatMap((message) =>
      message.role === "system" ? (message.toolsAdded ?? []) : [],
    );
    assert.deepEqual(
      declarations
        .filter((tool) => tool.name.startsWith("workflow"))
        .map((tool) => tool.name)
        .sort(),
      ["workflow_load", "workflow_status"],
    );
    assert.doesNotMatch(JSON.stringify(request), /export const meta|For workflow, available globals/);
    const notices = h.session.messages.filter(
      (message) => message.role === "custom" && message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE,
    );
    assert.equal(notices.length, 0, "empty SDK sessions need no access notice");
    assert.ok(definitions.reduce((sum, tool) => sum + tool.description.length, 0) <= 360);
    const footprint = {
      bootstrapDescriptionChars: Object.fromEntries(definitions.map((tool) => [tool.name, tool.description.length])),
      bootstrapDeclarationChars: JSON.stringify(
        definitions.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      ).length,
      requestWorkflowDeclarationChars: JSON.stringify(declarations.filter((tool) => tool.name.startsWith("workflow")))
        .length,
      startupNoticeChars: notices.reduce(
        (sum, notice) => sum + (notice.role === "custom" ? JSON.stringify(notice.content).length : 0),
        0,
      ),
      startupNoticeCount: notices.length,
      requestChars: JSON.stringify(request).length,
      requestMessageCount: request.messages.length,
    };
    if (process.env.PI_WORKFLOW_FOOTPRINT_OUTPUT) {
      fs.writeFileSync(process.env.PI_WORKFLOW_FOOTPRINT_OUTPUT, `${JSON.stringify(footprint, null, 2)}\n`);
    }
  } finally {
    h.cleanup();
  }
});

for (const compacted of [false, true]) {
  test(`real Pi reasserts disabled state after ${compacted ? "compacted" : "resumed"} enabled history`, async () => {
    const h = await harness((manager) => {
      manager.appendCustomMessageEntry(
        WORKFLOW_ACCESS_MESSAGE_TYPE,
        "Workflow access enabled for this session.",
        false,
        { enabled: true, enableCommand: "/workflow.enable" },
      );
      if (compacted) manager.appendCompaction("Earlier workflow access was enabled.", null, 0);
    });
    try {
      h.respond([fauxToolCall("workflow_status", {})]);
      await h.session.prompt("continue single-agent");
      assert.deepEqual(h.results().at(-1)?.details, { enabled: false, enableCommand: "/workflow.enable" });
      const requestText = JSON.stringify(h.requests[0]);
      assert.match(requestText, /Workflow access disabled\./);
      const oldStateText = compacted
        ? "Earlier workflow access was enabled."
        : "Workflow access enabled for this session.";
      assert.ok(requestText.includes(oldStateText));
      assert.ok(requestText.lastIndexOf("Workflow access disabled.") > requestText.lastIndexOf(oldStateText));
      const notices = h.session.messages.filter(
        (message) => message.role === "custom" && message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE,
      );
      const latest = notices.at(-1);
      assert.ok(latest?.role === "custom");
      assert.equal(latest.content, "Workflow access disabled.");
      assert.deepEqual(latest.details, { enabled: false, enableCommand: "/workflow.enable" });
      if (!compacted) {
        const first = notices[0];
        assert.ok(first.role === "custom");
        assert.equal(first.content, "Workflow access enabled for this session.", "old notices must not be rewritten");
        assert.equal(notices.length, 2);
      }
    } finally {
      h.cleanup();
    }
  });
}

test("real Pi nested codemode calls can inspect disabled status but cannot load workflows", async () => {
  const h = await harness();
  try {
    h.respond([
      fauxToolCall("codemode", {
        code: "text(await tools.workflow_status({})); text(await tools.workflow_load({}));",
      }),
    ]);
    await h.session.prompt("consider delegation");
    const result = h.results().at(-1);
    assert.ok(result);
    assert.equal(result.toolName, "codemode");
    assert.match(JSON.stringify(result), /WORKFLOW_DISABLED/);
    assert.match(JSON.stringify(result), /enabled.*false/);
    assert.ok(!h.session.getActiveToolNames().includes("workflow"));
    assert.equal(fs.existsSync(path.join(h.root, ".pi-workflow-runs")), false);
  } finally {
    h.cleanup();
  }
});

test("real Pi toggles append conversation state without changing the request prefix or declarations", async () => {
  const h = await harness();
  try {
    const initialTools = h.session.getActiveToolNames();
    h.respond([fauxToolCall("workflow_status", {})]);
    await h.session.prompt("status before permission");
    assert.deepEqual(h.results().at(-1)?.details, { enabled: false, enableCommand: "/workflow.enable" });
    const firstHistory = h.requests.at(-1)?.messages;
    assert.ok(firstHistory);
    const before = h.requests[0].messages[0];
    const callsBeforeCommand = h.faux.state.callCount;
    await h.session.prompt("/workflow.enable");
    await h.session.prompt("/workflow.enable");
    assert.equal(h.faux.state.callCount, callsBeforeCommand, "commands must not trigger model requests");
    assert.deepEqual(h.session.getActiveToolNames(), initialTools);
    h.respond([fauxToolCall("workflow_status", {})]);
    await h.session.prompt("status after permission");
    assert.deepEqual(h.results().at(-1)?.details, { enabled: true, enableCommand: "/workflow.enable" });
    const enabledRequest = h.requests[2];
    assert.deepEqual(enabledRequest.messages[0], before);
    assert.deepEqual(enabledRequest.messages.slice(0, firstHistory.length), firstHistory);

    // Explicit loading is a separate operation with its own intentional tool delta.
    h.respond([fauxToolCall("workflow_load", {})]);
    await h.session.prompt("load enabled tools");
    assert.equal(h.results().at(-1)?.isError, false);
    assert.ok(h.session.getActiveToolNames().includes("workflow"));
    const loadedTools = h.session.getActiveToolNames();
    const historyBeforeDisable = h.requests.at(-1)?.messages;
    assert.ok(historyBeforeDisable);
    await h.session.prompt("/workflow.disable");
    await h.session.prompt("/workflow.disable");
    assert.deepEqual(h.session.getActiveToolNames(), loadedTools);
    h.respond([
      fauxToolCall("workflow", { scriptPath: "/must-not-read.js" }),
      fauxToolCall("workflow_tasks", { action: "kill", runId: "must-not-kill" }),
      fauxToolCall("workflow_status", {}),
    ]);
    await h.session.prompt("try stale tool references");
    const denied = h.results().slice(-3);
    assert.ok(denied.slice(0, 2).every((result) => result.isError));
    assert.ok(denied.slice(0, 2).every((result) => JSON.stringify(result).includes("WORKFLOW_DISABLED")));
    assert.deepEqual(denied[2].details, { enabled: false, enableCommand: "/workflow.enable" });
    const disabledRequest = h.requests.at(-2);
    assert.ok(disabledRequest);
    assert.deepEqual(disabledRequest.messages.slice(0, historyBeforeDisable.length), historyBeforeDisable);
    assert.equal(disabledRequest.messages.filter((message) => message.role === "system").length, 2);
    assert.equal(fs.existsSync(path.join(h.root, ".pi-workflow-runs")), false);
    const notices = h.session.messages.filter(
      (message) => message.role === "custom" && message.customType === WORKFLOW_ACCESS_MESSAGE_TYPE,
    );
    assert.equal(notices.length, 2, "enable, disable; no startup or duplicate no-op notices");
  } finally {
    h.cleanup();
  }
});

test("real Pi revokes permission during provider streaming without steering or unpairing tool results", async () => {
  const h = await harness();
  let release = () => {};
  try {
    await h.session.prompt("/workflow.enable");
    h.respond([fauxToolCall("workflow_load", {})]);
    await h.session.prompt("load tools");
    const activeTools = h.session.getActiveToolNames();
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.faux.setResponses([
      async (context) => {
        h.capture(context);
        started();
        await held;
        return fauxAssistantMessage(fauxToolCall("workflow", { scriptPath: "/must-not-read.js" }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        h.capture(context);
        return fauxAssistantMessage("DONE");
      },
    ]);
    const running = h.session.prompt("provider in flight");
    await waiting;
    await h.session.prompt("/workflow.disable");
    assert.deepEqual(h.session.getActiveToolNames(), activeTools);
    release();
    await running;
    assert.equal(h.results().at(-1)?.isError, true);
    assert.match(JSON.stringify(h.results().at(-1)), /WORKFLOW_DISABLED/);
    assert.equal(h.faux.getPendingResponseCount(), 0);
    const newestFirst = [...h.session.sessionManager.getBranch()].reverse();
    const resultIndex = newestFirst.findIndex(
      (entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "workflow",
    );
    const noticeIndex = newestFirst.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_ACCESS_MESSAGE_TYPE,
    );
    assert.ok(
      resultIndex >= 0 && noticeIndex >= 0 && noticeIndex < resultIndex,
      "revocation notice must not split a tool call/result pair",
    );
    const followup = h.requests.at(-1);
    assert.match(JSON.stringify(followup), /Workflow access disabled/);
    assert.equal(fs.existsSync(path.join(h.root, ".pi-workflow-runs")), false);
  } finally {
    release();
    await h.session.abort();
    h.cleanup();
  }
});
