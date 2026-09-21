import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowAgent } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

// Optional standalone integration dependency, never loaded/installed into the host's settings.
const execPath = process.env.PI_WORKFLOW_EXEC_EXTENSION;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const scenario of ["success", "error", "abort", "stall-retry"] as const) {
  test(`real unified-exec child process is killed and its wake suppressed: ${scenario}`, {
    skip: !execPath,
    timeout: 20000,
  }, async () => {
    assert.ok(execPath);
    const execFactory: ExtensionFactory = (await import(execPath)).default;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-child-exec-"));
    const controller = new AbortController();
    const pids: number[] = [];
    const lifecycle: string[] = [];
    const wakes: unknown[] = [];
    let attempts = 0;
    let holdStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      holdStarted = resolve;
    });
    const runner = {
      async run(prompt: string, options: Parameters<WorkflowAgent["run"]>[1] = {}) {
        const attempt = ++attempts;
        const agentDir = path.join(root, `agent-${attempt}`);
        fs.mkdirSync(agentDir);
        const pidFile = path.join(root, `pid-${attempt}`);
        const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
        const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
        const hold = scenario === "abort" || (scenario === "stall-retry" && attempt === 1);
        const faux = fauxProvider({ provider: `child-exec-${scenario}-${attempt}` });
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("exec_command", { cmd, yield_time_ms: 250, on_exit: "wake" }), {
            stopReason: "toolUse",
          }),
          hold
            ? fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })
            : scenario === "error"
              ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })
              : fauxAssistantMessage("ok"),
        ]);
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: null,
          allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.refresh({ allowNetwork: false });
        const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            (pi) => {
              execFactory({
                ...pi,
                sendMessage: (...args) => {
                  wakes.push(args);
                },
              });
              pi.on("session_start", () => {
                lifecycle.push(`${attempt}:start`);
              });
              pi.on("resources_discover", () => {
                lifecycle.push(`${attempt}:resources`);
              });
              pi.on("session_shutdown", () => {
                lifecycle.push(`${attempt}:shutdown`);
              });
              pi.on("tool_execution_end", (event) => {
                if (event.toolName === "exec_command") {
                  assert.equal(event.isError, false);
                  pids.push(Number(fs.readFileSync(pidFile, "utf8")));
                }
              });
              pi.registerTool({
                name: "hold",
                label: "hold",
                description: "Wait for cancellation",
                parameters: Type.Object({}),
                async execute(_id, _params, signal) {
                  holdStarted();
                  await new Promise<void>((resolve) => {
                    if (signal?.aborted) resolve();
                    else signal?.addEventListener("abort", () => resolve(), { once: true });
                  });
                  return { content: [{ type: "text", text: "aborted" }], details: {} };
                },
              });
            },
          ],
        });
        await loader.reload();
        const agent = new WorkflowAgent({
          cwd: root,
          tools: [],
          model: faux.getModel(),
          session: {
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(root),
          },
        });
        return agent.run(prompt, options);
      },
    };
    try {
      if (scenario === "stall-retry") {
        const result = await runWorkflow(
          "export const meta = { name: 'cleanup', description: 'cleanup' }; return await agent('task')",
          {
            cwd: root,
            journalDir: root,
            agent: runner,
            stallTimeoutMs: 1500,
            stallRetries: 1,
          },
        );
        assert.equal(result.result, "ok");
        assert.equal(attempts, 2);
      } else {
        const running = runner.run("task", { signal: controller.signal });
        if (scenario === "abort") {
          await held;
          controller.abort();
        }
        if (scenario === "success") assert.equal(await running, "ok");
        else await assert.rejects(running, /aborted|provider failed/);
      }
      assert.equal(pids.length, attempts);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await pause(400); // coordinator's debounce must not deliver after teardown
      assert.deepEqual(wakes, []);
      assert.deepEqual(
        lifecycle,
        Array.from({ length: attempts }, (_, i) => [
          `${i + 1}:start`,
          `${i + 1}:resources`,
          `${i + 1}:shutdown`,
        ]).flat(),
      );
    } finally {
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
