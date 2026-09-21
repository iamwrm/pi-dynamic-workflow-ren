import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execExtension = process.env.PI_WORKFLOW_EXEC_EXTENSION;

for (const mode of ["json", "tui"] as const) {
  test(`offline Pi ${mode} executes parent workflow, inherits child extensions, and drains child exec`, {
    skip: !execExtension || (mode === "tui" && process.env.PI_WORKFLOW_TMUX !== "1"),
    timeout: 30000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cli-0861-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    const lifecyclePath = path.join(root, "lifecycle.jsonl");
    const pidPath = path.join(root, "pid");
    const fixture = path.join(root, "0001-anthropic-oauth-cc-compat.ts");
    const workflowExtension = fileURLToPath(new URL("../extensions/workflow.ts", import.meta.url));
    const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
    const nodeScript = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(nodeScript)}`;
    const script =
      "export const meta = { name: 'cli-cleanup', description: 'offline acceptance' }; return { answer: await agent('child task') }";
    // The fixture uses 0001's filename to prove inheritance does not filter provider-only
    // packages by their name. It is a faux provider, not the private OAuth implementation.
    fs.writeFileSync(
      fixture,
      `
import fs from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
export default function(pi) {
  const faux = fauxProvider({ provider: 'workflow-offline' });
  pi.registerProvider(faux.provider);
  let parent;
  const log = (event, ctx) => fs.appendFileSync(${JSON.stringify(lifecyclePath)}, JSON.stringify({ event, parent, id: ctx.sessionManager.getSessionId(), mode: ctx.mode }) + '\\n');
  pi.on('session_start', (_, ctx) => {
    parent = pi.getAllTools().some(t => t.name === 'workflow_load');
    faux.setResponses(parent ? [
      fauxAssistantMessage(fauxToolCall('workflow_load', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('workflow', { script: ${JSON.stringify(script)} }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('PARENT_OK'),
    ] : [
      fauxAssistantMessage(fauxToolCall('exec_command', { cmd: ${JSON.stringify(cmd)}, yield_time_ms: 250, on_exit: 'wake' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('CHILD_OK'),
    ]);
    log('start', ctx);
  });
  pi.on('resources_discover', (_, ctx) => { log('resources', ctx); });
  pi.on('session_shutdown', (_, ctx) => { log('shutdown', ctx); });
}
`,
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [fixture, execExtension],
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const tmuxSession = `workflow-0861-${process.pid}-${Date.now()}`;
    const tmux = (...args: string[]) => spawnSync("tmux", args, { encoding: "utf8", timeout: 3000 });
    const jsonLines = (file: string) =>
      fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error(`TUI did not settle: ${tmux("capture-pane", "-p", "-t", tmuxSession).stdout}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      if (mode === "json") {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "--mode",
            "json",
            "--no-session",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "-e",
            workflowExtension,
            "--provider",
            "workflow-offline",
            "--model",
            "faux-1",
            "run test",
          ],
          {
            cwd: root,
            env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
            encoding: "utf8",
            timeout: 20000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        const rows = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line));
        const workflowResult = rows.find((row) => row.type === "tool_execution_end" && row.toolName === "workflow");
        assert.ok(workflowResult, result.stdout.slice(-8000));
        assert.equal(workflowResult.isError, false);
        assert.deepEqual(workflowResult.result.details.result, { answer: "CHILD_OK" });
        assert.match(result.stdout, /PARENT_OK/);
        assert.doesNotMatch(result.stdout, /unified-exec-completed/);
      } else {
        const parentFile = path.join(root, "parent.jsonl");
        const launch = path.join(root, "launch.sh");
        const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
        const args = [
          process.execPath,
          cli,
          "--session",
          parentFile,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "-e",
          workflowExtension,
          "--provider",
          "workflow-offline",
          "--model",
          "faux-1",
          "run test",
        ];
        fs.writeFileSync(
          launch,
          `cd ${quote(root)}\nexport HOME=${quote(root)} PI_CODING_AGENT_DIR=${quote(agentDir)} PI_OFFLINE=1\nexec ${args.map(quote).join(" ")}\n`,
        );
        const started = tmux("new-session", "-d", "-x", "100", "-y", "30", "-s", tmuxSession, `bash ${quote(launch)}`);
        assert.equal(started.status, 0, started.stderr);
        await waitFor(() =>
          jsonLines(parentFile).some(
            (row) =>
              row.type === "message" &&
              row.message.role === "assistant" &&
              row.message.content.some((part: any) => part.type === "text" && part.text === "PARENT_OK"),
          ),
        );
        const transcript = jsonLines(parentFile);
        const running = transcript.find(
          (row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolName === "workflow",
        );
        assert.equal(running.message.details.status, "running");
        const finished = transcript.filter(
          (row) => row.type === "custom_message" && row.customType === "workflow_result",
        );
        assert.equal(finished.length, 1);
        assert.deepEqual(finished[0].details.result, { answer: "CHILD_OK" });
        assert.equal(
          transcript.some((row) => row.customType === "unified-exec-completed"),
          false,
        );
        // Session persistence precedes Pi's scheduled terminal render. Observe both
        // boundaries rather than racing capture-pane against that final frame.
        await waitFor(() => /PARENT_OK/.test(tmux("capture-pane", "-p", "-t", tmuxSession).stdout));
        assert.match(tmux("capture-pane", "-p", "-t", tmuxSession).stdout, /PARENT_OK/);
        tmux("send-keys", "-t", tmuxSession, "C-d");
        await waitFor(() => jsonLines(lifecyclePath).some((row) => row.parent && row.event === "shutdown"));
      }
      const lifecycle = fs
        .readFileSync(lifecyclePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const parent of [true, false]) {
        const events = lifecycle.filter((row) => row.parent === parent);
        assert.deepEqual(
          events.map((row) => row.event),
          ["start", "resources", "shutdown"],
        );
        assert.equal(new Set(events.map((row) => row.id)).size, 1);
        assert.ok(events.every((row) => row.mode === (parent ? mode : "print")));
      }
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (mode === "tui") tmux("kill-session", "-t", tmuxSession);
      if (fs.existsSync(pidPath)) {
        try {
          process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
