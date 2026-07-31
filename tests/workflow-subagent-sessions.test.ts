import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createSubagentResourceLoader,
  createSubagentSessionManager,
  createSubagentSettingsManager,
} from "../src/agent.js";
import type { WorkflowSnapshot } from "../src/display.js";
import { runWorkflow, type WorkflowRunControls } from "../src/workflow.js";
import { createWorkflowTasksTool, resolveSessionPersistence } from "../src/workflow-tool.js";

const META = "export const meta = { name: 'ss', description: 'subagent session tests' }\n";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

/** Minimal assistant message: enough for SessionManager to flush the file. */
function assistantMessage(text: string): AppendableMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as AppendableMessage;
}

function userMessage(text: string): AppendableMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AppendableMessage;
}

test("createSubagentSessionManager persists a real pi child session linked to the parent", () => {
  const sessionDir = tmpDir("wf-subagent-sessions-");
  const cwd = tmpDir("wf-subagent-cwd-");
  const parentSessionFile = path.join(sessionDir, "parent.jsonl");
  const manager = createSubagentSessionManager(
    { sessionDir, parentSessionFile },
    cwd,
    "workflow wf_test · #1 repo inventory",
  );

  assert.equal(manager.isPersisted(), true);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile, "persisted manager must expose its session file path");
  assert.equal(path.dirname(sessionFile), sessionDir);
  // Nothing is flushed before the first assistant message: a subagent that dies
  // before responding must leave no empty session file behind.
  assert.equal(fs.existsSync(sessionFile), false);

  manager.appendMessage(userMessage("inspect the repo"));
  manager.appendMessage(assistantMessage("done"));
  assert.equal(fs.existsSync(sessionFile), true);

  const lines = fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = lines[0] as { type: string; cwd?: string; parentSession?: string };
  assert.equal(header.type, "session");
  assert.equal(header.parentSession, parentSessionFile);
  assert.equal(header.cwd, path.resolve(cwd));
  const info = lines.find((entry) => entry.type === "session_info") as { name?: string } | undefined;
  assert.equal(info?.name, "workflow wf_test · #1 repo inventory");
  const roles = lines
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry.message as { role: string }).role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

test("createSubagentSessionManager header variants: unlinked child, unnamed session", () => {
  const sessionDir = tmpDir("wf-subagent-sessions-");
  const cwd = tmpDir("wf-subagent-cwd-");
  // No parentSessionFile and no sessionName: still a valid pi session, just
  // unlinked and unnamed (SDK embedders without a parent session).
  const manager = createSubagentSessionManager({ sessionDir }, cwd);
  manager.appendMessage(assistantMessage("hi"));
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const lines = fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal("parentSession" in lines[0], false);
  assert.equal(
    lines.some((entry) => entry.type === "session_info"),
    false,
  );
});

test("createSubagentSessionManager degrades to in-memory without persistence or on storage failure", () => {
  const cwd = tmpDir("wf-subagent-cwd-");
  const none = createSubagentSessionManager(undefined, cwd);
  assert.equal(none.isPersisted(), false);
  assert.equal(none.getSessionFile(), undefined);

  // A file used as the session "dir" makes mkdir/creation fail -> in-memory fallback.
  const notADir = path.join(tmpDir("wf-subagent-bad-"), "file");
  fs.writeFileSync(notADir, "not a directory");
  const fallback = createSubagentSessionManager({ sessionDir: path.join(notADir, "nested") }, cwd, "name");
  assert.equal(fallback.isPersisted(), false);
});

function writeToolExtension(filePath: string, toolName: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(toolName)},
    label: ${JSON.stringify(toolName)},
    description: "test tool",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
}
`,
  );
}

function createScopedSettingsFixture(compactionEnabled?: boolean): { cwd: string; agentDir: string } {
  const cwd = tmpDir("wf-subagent-settings-cwd-");
  const agentDir = tmpDir("wf-subagent-settings-agent-");
  const projectConfigDir = path.join(cwd, ".pi");
  fs.mkdirSync(projectConfigDir, { recursive: true });

  const globalPackage = path.join(agentDir, "global-package");
  fs.mkdirSync(globalPackage, { recursive: true });
  fs.writeFileSync(
    path.join(globalPackage, "package.json"),
    JSON.stringify({ name: "global-package", keywords: ["pi-package"], pi: { extensions: ["./global.ts"] } }),
  );
  writeToolExtension(path.join(globalPackage, "global.ts"), "global_inherited_tool");

  const projectPackage = path.join(cwd, "project-package");
  fs.mkdirSync(projectPackage, { recursive: true });
  fs.writeFileSync(
    path.join(projectPackage, "package.json"),
    JSON.stringify({
      name: "project-package",
      keywords: ["pi-package"],
      pi: { extensions: ["./project.ts", "./workflow.ts"] },
    }),
  );
  writeToolExtension(path.join(projectPackage, "project.ts"), "project_inherited_tool");
  writeToolExtension(path.join(projectPackage, "workflow.ts"), "workflow");
  writeToolExtension(path.join(projectConfigDir, "extensions", "auto.ts"), "project_auto_tool");

  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: ["./global-package"],
      ...(compactionEnabled !== undefined ? { compaction: { enabled: compactionEnabled } } : {}),
    }),
  );
  fs.writeFileSync(path.join(projectConfigDir, "settings.json"), JSON.stringify({ packages: ["../project-package"] }));
  return { cwd, agentDir };
}

function loadedToolNames(loader: ReturnType<typeof createSubagentResourceLoader>): string[] {
  return loader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.keys()])
    .sort();
}

test("trusted subagents inherit global + project packages while filtering recursive workflow tools", async () => {
  const { cwd, agentDir } = createScopedSettingsFixture();
  const settingsManager = createSubagentSettingsManager(cwd, agentDir, true);
  const loader = createSubagentResourceLoader(cwd, agentDir, settingsManager);

  await loader.reload();

  assert.equal(settingsManager.isProjectTrusted(), true);
  assert.deepEqual(settingsManager.getGlobalSettings().packages, ["./global-package"]);
  assert.deepEqual(settingsManager.getProjectSettings().packages, ["../project-package"]);
  assert.equal(settingsManager.getCompactionEnabled(), true);
  assert.deepEqual(loadedToolNames(loader), ["global_inherited_tool", "project_auto_tool", "project_inherited_tool"]);
});

test("untrusted subagents keep global packages but suppress project settings and extensions", async () => {
  const { cwd, agentDir } = createScopedSettingsFixture(false);
  const settingsManager = createSubagentSettingsManager(cwd, agentDir, false);
  const loader = createSubagentResourceLoader(cwd, agentDir, settingsManager);

  await loader.reload();

  assert.equal(settingsManager.isProjectTrusted(), false);
  assert.deepEqual(settingsManager.getGlobalSettings().packages, ["./global-package"]);
  assert.deepEqual(settingsManager.getProjectSettings(), {});
  assert.equal(settingsManager.getCompactionEnabled(), false, "persisted compaction opt-out survives resource reload");
  assert.deepEqual(loadedToolNames(loader), ["global_inherited_tool"]);
});

test("telemetry sessionFile flows to run events, journals, and resumed replays", async () => {
  const journalDir = tmpDir("wf-journal-");
  const script = `${META}
await agent('inspect', { label: 'inspect' })
return 'ok'`;
  const sessionFile = "/tmp/fake-child-session.jsonl";
  const runner1 = {
    calls: 0,
    run: async (_prompt: string, options?: { sessionName?: string; onTelemetry?: (telemetry: unknown) => void }) => {
      runner1.calls++;
      assert.match(options?.sessionName ?? "", /^workflow wf_[\w-]+ · #1 inspect$/);
      options?.onTelemetry?.({ tokens: 10, toolCalls: 1, elapsedMs: 5, sessionFile });
      return "done";
    },
  };

  const sessions: Array<string | undefined> = [];
  const first = await runWorkflow<string>(script, {
    agent: runner1,
    journalDir,
    onAgentEnd: (event) => sessions.push(event.telemetry?.sessionFile),
  });
  assert.equal(runner1.calls, 1);
  assert.deepEqual(sessions, [sessionFile]);

  // Resume: the journaled telemetry still points at the original pi session file.
  const runner2 = {
    calls: 0,
    run: async () => {
      runner2.calls++;
      return "unexpected";
    },
  };
  const resumedSessions: Array<string | undefined> = [];
  let controls: WorkflowRunControls | undefined;
  const second = await runWorkflow<string>(script, {
    agent: runner2,
    journalDir,
    resumeFromRunId: first.runId,
    onAgentEnd: (event) => resumedSessions.push(event.telemetry?.sessionFile),
    onRunControls: (c) => {
      controls = c;
    },
  });
  assert.equal(runner2.calls, 0);
  assert.equal(second.result, "ok");
  assert.deepEqual(resumedSessions, [sessionFile]);
  assert.ok(controls, "run controls should be provided");
});

test("live session handles surface the pi child session file; finished entries keep only flushed paths", async () => {
  const journalDir = tmpDir("wf-journal-");
  const sessionFile = "/tmp/fake-live-session.jsonl";
  type RunnerOptions = {
    onSessionHandle?: (handle: { getMessages: () => readonly unknown[]; sessionFile?: string }) => void;
    onSessionEnd?: (messages: readonly unknown[]) => void;
    onTelemetry?: (telemetry: unknown) => void;
  };
  const runner = {
    run: async (prompt: string, options?: RunnerOptions) => {
      options?.onSessionHandle?.({ getMessages: () => [], sessionFile });
      // Mirror WorkflowAgent.run's finally: telemetry (existsSync-verified there)
      // fires before onSessionEnd. The 'flushed' agent reports the file in
      // telemetry; the 'phantom' agent died before its first assistant message,
      // so its telemetry has NO sessionFile even though the handle carried one.
      options?.onTelemetry?.(
        prompt.includes("flushed")
          ? { tokens: 1, toolCalls: 0, elapsedMs: 1, sessionFile }
          : { tokens: 1, toolCalls: 0, elapsedMs: 1 },
      );
      options?.onSessionEnd?.([]);
      return "done";
    },
  };
  let controls: WorkflowRunControls | undefined;
  await runWorkflow(
    `${META}\nawait agent('flushed probe', { label: 'flushed' })\nawait agent('phantom probe', { label: 'phantom' })\nreturn 'ok'`,
    {
      agent: runner,
      journalDir,
      onRunControls: (c) => {
        controls = c;
      },
    },
  );
  const flushed = controls?.getAgentSession(1);
  assert.equal(flushed?.live, false);
  assert.equal(flushed?.sessionFile, sessionFile);
  // Phantom-path fix: the finished entry must NOT advertise a session file that
  // never flushed (pi silently opens a blank session at nonexistent paths).
  const phantom = controls?.getAgentSession(2);
  assert.equal(phantom?.live, false);
  assert.equal(phantom?.sessionFile, undefined);
});

test("stall retries thread distinct session names per attempt", async () => {
  const journalDir = tmpDir("wf-journal-");
  const names: Array<string | undefined> = [];
  let attempt = 0;
  const runner = {
    run: async (_prompt: string, options?: { signal?: AbortSignal; sessionName?: string }) => {
      attempt++;
      names.push(options?.sessionName);
      if (attempt === 1) {
        // Hang until the stall timer aborts this attempt, then fail it.
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      }
      return "ok";
    },
  };
  const result = await runWorkflow(`${META}\nreturn await agent('retry me', { label: 'retrier' })`, {
    agent: runner,
    journalDir,
    runId: "wf_names01",
    stallTimeoutMs: 30,
    stallRetries: 1,
  });
  assert.equal(result.result, "ok");
  // retry2 matches the .retry2 messages-file suffix for the same attempt.
  assert.deepEqual(names, ["workflow wf_names01 · #1 retrier", "workflow wf_names01 · #1 retrier · retry2"]);
});

test("resolveSessionPersistence: persisted parent required; failures degrade to undefined", () => {
  assert.deepEqual(
    resolveSessionPersistence({ getSessionDir: () => "/dir", getSessionFile: () => "/dir/parent.jsonl" }),
    { sessionDir: "/dir", parentSessionFile: "/dir/parent.jsonl" },
  );
  // In-memory parent: no file, empty dir.
  assert.equal(resolveSessionPersistence({ getSessionDir: () => "", getSessionFile: () => undefined }), undefined);
  // No session manager at all (fake ctx in unit tests / print harnesses).
  assert.equal(resolveSessionPersistence(undefined), undefined);
  // Throwing accessors (torn-down ctx) must not break tool execution.
  assert.equal(
    resolveSessionPersistence({
      getSessionDir: () => {
        throw new Error("disposed");
      },
      getSessionFile: () => {
        throw new Error("disposed");
      },
    }),
    undefined,
  );
});

test("resolveSessionPersistence: PI_WORKFLOW_SUBAGENT_SESSIONS kill switch", () => {
  const persisted = { getSessionDir: () => "/dir", getSessionFile: () => "/dir/parent.jsonl" };
  const prior = process.env.PI_WORKFLOW_SUBAGENT_SESSIONS;
  try {
    for (const off of ["0", "false", "off", "OFF", " False "]) {
      process.env.PI_WORKFLOW_SUBAGENT_SESSIONS = off;
      assert.equal(resolveSessionPersistence(persisted), undefined, `flag ${JSON.stringify(off)} must disable`);
    }
    for (const on of ["", "1", "on", "anything-else"]) {
      process.env.PI_WORKFLOW_SUBAGENT_SESSIONS = on;
      assert.ok(resolveSessionPersistence(persisted), `flag ${JSON.stringify(on)} must keep it enabled`);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_WORKFLOW_SUBAGENT_SESSIONS;
    else process.env.PI_WORKFLOW_SUBAGENT_SESSIONS = prior;
  }
});

test("workflow_tasks status reports per-agent session with handle-over-snapshot precedence", async () => {
  const snapshot: WorkflowSnapshot = {
    name: "demo",
    phases: ["Probe"],
    logs: [],
    agentCount: 2,
    runningCount: 1,
    doneCount: 1,
    errorCount: 0,
    agents: [
      { id: 1, label: "live one", phase: "Probe", prompt: "p", status: "running", startedAtMs: Date.now() },
      { id: 2, label: "done one", phase: "Probe", prompt: "p", status: "done", sessionFile: "/from/snapshot.jsonl" },
    ],
  };
  const tool = createWorkflowTasksTool({
    listRuns: () => [
      {
        runId: "wf_live01",
        name: "demo",
        getSnapshot: () => snapshot,
        getAgentSession: (id) => (id === 1 ? { live: true, sessionFile: "/from/handle.jsonl" } : undefined),
      },
    ],
  });
  const status = (
    await tool.execute("t", { action: "status" } as never, undefined as never, undefined, undefined as never)
  ).details as { phases: Array<{ agents: Array<Record<string, unknown>> }> };
  const agents = status.phases[0].agents;
  assert.equal(agents[0].session, "/from/handle.jsonl");
  assert.equal(agents[1].session, "/from/snapshot.jsonl");
});

test("workflow_tasks status on a finished run lists only still-existing journaled sessions, deduped", async () => {
  const base = tmpDir("wf-runs-");
  const runDir = path.join(base, "wf_fin01");
  fs.mkdirSync(path.join(runDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "agents", "001-worker.md"), "# agent #1\n");
  const existing = path.join(base, "child-session.jsonl");
  fs.writeFileSync(existing, "{}\n");
  const deleted = path.join(base, "deleted-session.jsonl");
  const telemetry = (sessionFile: string) => ({ toolCalls: 0, elapsedMs: 1, sessionFile });
  fs.writeFileSync(
    path.join(runDir, "journal.jsonl"),
    `${[
      JSON.stringify({ key: "1:a", result: "ok", telemetry: telemetry(existing), ts: 1 }),
      JSON.stringify({ key: "2:b", result: "ok", telemetry: telemetry(deleted), ts: 2 }),
      JSON.stringify({ key: "3:c", result: "ok", telemetry: telemetry(existing), ts: 3 }),
      JSON.stringify({ key: "4:d", result: "ok", ts: 4 }),
    ].join("\n")}\n`,
  );
  const tool = createWorkflowTasksTool({ listRuns: () => [], runsDir: () => base });
  const status = (
    await tool.execute(
      "t",
      { action: "status", runId: "wf_fin01" } as never,
      undefined as never,
      undefined,
      undefined as never,
    )
  ).details as Record<string, unknown>;
  assert.equal(status.live, false);
  assert.deepEqual(status.sessions, [existing]);
});
