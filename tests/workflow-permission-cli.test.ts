import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const cli =
  process.env.PI_WORKFLOW_CLI ??
  fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const workflowExtension = fileURLToPath(new URL("../extensions/workflow.ts", import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-permission-cli-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }),
  );
  const trace = path.join(root, "trace.jsonl");
  const ready = path.join(root, "ready");
  const provider = path.join(root, "provider.ts");
  fs.writeFileSync(
    provider,
    `
import fs from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
export default function(pi) {
  const faux = fauxProvider({ provider: 'workflow-permission-offline' });
  pi.registerProvider(faux.provider);
  pi.registerCommand('test-reload', { description: 'Reload fixture extensions', handler: async (_, ctx) => { await ctx.reload(); } });
  pi.on('session_start', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));
  pi.on('before_agent_start', (event) => {
    const names = event.prompt === 'LOAD' ? ['workflow_load'] : event.prompt === 'DENIED' ? ['workflow', 'workflow_tasks'] : ['workflow_status'];
    const capture = context => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(context) + '\\n');
    faux.setResponses([
      context => {
        capture(context);
        return fauxAssistantMessage(names.map(name => fauxToolCall(name, name === 'workflow' ? {scriptPath: '/must-not-read.js'} : name === 'workflow_tasks' ? {action: 'kill', runId: 'must-not-kill'} : {})), {stopReason: 'toolUse'});
      },
      context => { capture(context); return fauxAssistantMessage('DONE'); },
    ]);
  });
}
`,
  );
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    workflowExtension,
    "-e",
    provider,
  ];
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  return { root, agentDir, trace, ready, args, env };
}

function rows(file: string): any[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function status(messages: any[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === "toolResult" && message.toolName === "workflow_status")?.details;
}

test("offline JSON CLI starts disabled and accepts an explicit human enable command", { timeout: 20_000 }, () => {
  for (const enabled of [false, true]) {
    const f = fixture();
    try {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--mode",
          "json",
          "--no-session",
          ...f.args,
          "--provider",
          "workflow-permission-offline",
          "--model",
          "faux-1",
          ...(enabled ? ["/workflow.enable"] : []),
          "STATUS",
        ],
        {
          cwd: f.root,
          env: f.env,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      const end = events.find((event) => event.type === "tool_execution_end" && event.toolName === "workflow_status");
      assert.deepEqual(end?.result.structuredContent, { enabled, enableCommand: "/workflow.enable" });
      assert.equal(rows(f.trace).length, 2, "permission commands must not spend a model turn");
      assert.equal(fs.existsSync(path.join(f.root, ".pi-workflow-runs")), false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("offline RPC enables/disables without model turns and resets access on reload, new, and resume", {
  timeout: 30_000,
}, async () => {
  const f = fixture();
  const client = new RpcClient({
    cliPath: cli,
    cwd: f.root,
    env: f.env,
    provider: "workflow-permission-offline",
    model: "faux-1",
    args: f.args,
  });
  try {
    await client.start();
    const commands = await client.getCommands();
    assert.ok(commands.some((command) => command.name === "workflow.enable"));
    assert.ok(commands.some((command) => command.name === "workflow.disable"));
    await client.promptAndWait("STATUS");
    assert.equal(status(await client.getMessages()).enabled, false);
    let count = rows(f.trace).length;
    assert.equal(await client.prompt("/workflow.enable"), "handled");
    assert.equal(await client.prompt("/workflow.enable"), "handled");
    assert.equal(rows(f.trace).length, count);
    await client.promptAndWait("STATUS");
    assert.equal(status(await client.getMessages()).enabled, true);
    await client.promptAndWait("LOAD");
    const loadedMessages = await client.getMessages();
    const savedFile = (await client.getState()).sessionFile;
    assert.ok(savedFile);
    count = rows(f.trace).length;
    await client.prompt("/workflow.disable");
    await client.prompt("/workflow.disable");
    await client.prompt("/run-workflow does-not-exist");
    await client.prompt("/kill-workflow does-not-exist");
    assert.equal(rows(f.trace).length, count);
    await client.promptAndWait("DENIED");
    const denied = (await client.getMessages()).filter((message) => message.role === "toolResult").slice(-2);
    assert.ok(denied.every((message) => message.isError && JSON.stringify(message).includes("WORKFLOW_DISABLED")));
    assert.deepEqual((await client.getMessages()).slice(0, loadedMessages.length), loadedMessages);

    await client.prompt("/workflow.enable");
    assert.equal(await client.prompt("/test-reload"), "handled");
    await client.promptAndWait("STATUS");
    assert.equal(status(await client.getMessages()).enabled, false);
    await client.prompt("/workflow.enable");
    assert.equal((await client.newSession()).cancelled, false);
    await client.promptAndWait("STATUS");
    assert.equal(status(await client.getMessages()).enabled, false);
    await client.prompt("/workflow.enable");
    assert.equal((await client.switchSession(savedFile)).cancelled, false);
    await client.promptAndWait("STATUS");
    assert.equal(status(await client.getMessages()).enabled, false);
    assert.equal(fs.existsSync(path.join(f.root, ".pi-workflow-runs")), false);
  } finally {
    await client.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const mode of ["regular", "fullscreen"]) {
  test(`offline ${mode} TUI runs permission commands and exposes status`, {
    skip: process.env.PI_WORKFLOW_TMUX !== "1",
    timeout: 30_000,
  }, async () => {
    const f = fixture();
    const sessionFile = path.join(f.root, "parent.jsonl");
    const tmuxSession = `workflow-permission-${mode}-${process.pid}-${Date.now()}`;
    const tmux = (...args: string[]) => spawnSync("tmux", args, { encoding: "utf8", timeout: 3_000 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const args = [
      process.execPath,
      cli,
      ...f.args,
      "--session",
      sessionFile,
      "--tui-mode",
      mode,
      "--provider",
      "workflow-permission-offline",
      "--model",
      "faux-1",
    ];
    const launch = path.join(f.root, "launch.sh");
    fs.writeFileSync(
      launch,
      `cd ${quote(f.root)}\nexport HOME=${quote(f.root)} PI_CODING_AGENT_DIR=${quote(f.agentDir)} PI_OFFLINE=1\nexec ${args.map(quote).join(" ")}\n`,
    );
    const messages = () =>
      rows(sessionFile)
        .filter((row) => row.type === "message")
        .map((row) => row.message);
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error(`TUI did not settle: ${tmux("capture-pane", "-p", "-t", tmuxSession).stdout}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const send = (text: string) => {
      assert.equal(tmux("send-keys", "-t", tmuxSession, "-l", text).status, 0);
      assert.equal(tmux("send-keys", "-t", tmuxSession, "Enter", ...(text.startsWith("/") ? ["Enter"] : [])).status, 0);
    };
    try {
      const started = tmux("new-session", "-d", "-x", "110", "-y", "32", "-s", tmuxSession, `bash ${quote(launch)}`);
      assert.equal(started.status, 0, started.stderr);
      await waitFor(() => fs.existsSync(f.ready));
      send("STATUS");
      await waitFor(() => status(messages())?.enabled === false);
      await waitFor(
        () => messages().at(-1)?.role === "assistant" && JSON.stringify(messages().at(-1)).includes("DONE"),
      );
      const count = rows(f.trace).length;
      send("/workflow.enable");
      await waitFor(
        () =>
          rows(sessionFile)
            .reverse()
            .find((row) => row.customType === "workflow_access")?.details?.enabled === true,
      );
      assert.equal(rows(f.trace).length, count);
      send("STATUS");
      await waitFor(() => status(messages())?.enabled === true);
      send("/workflow.disable");
      await waitFor(
        () =>
          rows(sessionFile)
            .reverse()
            .find((row) => row.customType === "workflow_access")?.details?.enabled === false,
      );
      await waitFor(() => /Workflow access disabled/.test(tmux("capture-pane", "-p", "-t", tmuxSession).stdout));
      send("STATUS");
      await waitFor(() => status(messages())?.enabled === false);
      assert.equal(fs.existsSync(path.join(f.root, ".pi-workflow-runs")), false);
    } finally {
      tmux("kill-session", "-t", tmuxSession);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}
