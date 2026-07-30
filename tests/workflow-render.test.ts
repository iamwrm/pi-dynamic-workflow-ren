import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../extensions/workflow.js";
import { formatTokens, renderWorkflowLines } from "../src/display.js";
import { loadWorkflowRegistry, parseRunWorkflowInput } from "../src/workflow-registry.js";
import {
  buildWorkflowGuide,
  createWorkflowTasksTool,
  createWorkflowTool,
  formatWorkflowScriptForDisplay,
} from "../src/workflow-tool.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  phases: [{ title: 'Scan' }]
}

phase('Scan')
await agent('inspect the repo', { label: 'repo inventory' })
return { ok: true }
`;

test("formatWorkflowScriptForDisplay includes a header and the script body", () => {
  const block = formatWorkflowScriptForDisplay(validScript);
  // Header line present (and enriched with the parsed meta.name).
  assert.match(block, /^workflow — generated script/);
  assert.match(block, /demo_workflow/);
  // Script body present (gutter-prefixed lines).
  assert.match(block, /│ phase\('Scan'\)/);
  assert.match(block, /│ await agent\('inspect the repo'/);
  // First line is the header, not script.
  assert.equal(block.split("\n")[0].startsWith("workflow — generated script"), true);
});

test("formatWorkflowScriptForDisplay unfences a ```js block", () => {
  const fenced = `\`\`\`js\n${validScript}\n\`\`\``;
  const block = formatWorkflowScriptForDisplay(fenced);
  // The fence markers must be gone from the output.
  assert.doesNotMatch(block, /```/);
  // Body still present.
  assert.match(block, /│ phase\('Scan'\)/);
});

test("formatWorkflowScriptForDisplay shows a short script fully", () => {
  const block = formatWorkflowScriptForDisplay(validScript);
  assert.doesNotMatch(block, /more lines/);
  // Every non-empty source line should appear (gutter-prefixed).
  for (const line of ["export const meta = {", "phase('Scan')", "return { ok: true }"]) {
    assert.ok(block.includes(`│ ${line}`), `expected gutter line for: ${line}`);
  }
});

test("formatWorkflowScriptForDisplay truncates a very long script with a more-lines note", () => {
  const header = "export const meta = { name: 'big', description: 'big' }\n";
  const longBody = Array.from({ length: 500 }, (_, i) => `log('line ${i}')`).join("\n");
  const block = formatWorkflowScriptForDisplay(header + longBody);
  assert.match(block, /… \(\d+ more lines\)/);
  // The early lines are kept; the tail past the cap is dropped.
  assert.ok(block.includes("│ log('line 0')"));
  assert.ok(!block.includes("│ log('line 499')"));
});

test("formatWorkflowScriptForDisplay falls back gracefully on an invalid script", () => {
  // No meta export: parseWorkflowScript throws internally; helper must not throw and
  // must keep the generic header.
  const block = formatWorkflowScriptForDisplay("const x = 1\nlog('hi')");
  assert.equal(block.split("\n")[0], "workflow — generated script");
  assert.match(block, /│ const x = 1/);
});

// Minimal Theme stub: renderCall only uses fg(color, text) and bold(text).
const themeStub = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<NonNullable<ReturnType<typeof createWorkflowTool>["renderCall"]>>[1];

function getRenderCall() {
  const tool = createWorkflowTool();
  const renderCall = tool.renderCall;
  assert.ok(renderCall, "tool must define renderCall");
  return renderCall.bind(tool);
}

test("workflow extension renders completed workflow_result snapshots in session history", () => {
  type Renderer = (
    message: unknown,
    options: { expanded: boolean },
    theme: unknown,
  ) => { render(width: number): string[] };
  const renderers = new Map<string, Renderer>();
  extension({
    registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
    getThinkingLevel: () => "medium",
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: () => {},
  } as never);

  const renderer = renderers.get("workflow_result");
  assert.ok(renderer, "workflow_result renderer must be registered");
  const message = {
    customType: "workflow_result",
    content: [{ type: "text", text: 'Workflow demo completed.\n\nResult:\n{"ok":true}' }],
    display: true,
    details: {
      status: "completed",
      name: "demo",
      runId: "wf_test",
      phases: [],
      logs: [],
      agents: [{ id: 1, label: "repo inventory", prompt: "inspect", status: "done" }],
      agentCount: 1,
      runningCount: 0,
      doneCount: 1,
      errorCount: 0,
      spentTokens: 47,
    },
  };

  const collapsed = renderer(message, { expanded: false }, themeStub).render(120).join("\n");
  assert.match(collapsed, /Workflow demo completed/);
  assert.match(collapsed, /Workflow completed/);
  assert.match(collapsed, /repo inventory/);
  assert.match(collapsed, /Ctrl\+O/);
  assert.doesNotMatch(collapsed, /Result:/);

  const expanded = renderer(message, { expanded: true }, themeStub).render(120).join("\n");
  assert.match(expanded, /Result:/);
});

test("renderWorkflowLines shows completed subagent token/tool/elapsed metrics", () => {
  const lines = renderWorkflowLines({
    name: "metrics",
    phases: ["Phase"],
    currentPhase: "Phase",
    logs: [],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
    agents: [
      {
        id: 1,
        label: "metered agent",
        phase: "Phase",
        prompt: "work",
        status: "done",
        tokens: 123,
        toolCalls: 2,
        elapsedMs: 1530,
      },
    ],
  }).join("\n");

  assert.match(lines, /metered agent \(123 tok · 2 tools · 1\.5s\)/);
});

test("formatTokens humanizes large counts (k/m) and leaves small ones alone", () => {
  assert.equal(formatTokens(847), "847");
  assert.equal(formatTokens(5000), "5k");
  assert.equal(formatTokens(126728), "126.7k");
  assert.equal(formatTokens(401846), "401.8k");
  assert.equal(formatTokens(1_234_567), "1.2m");
});

test("renderWorkflowLines humanizes six-digit token counts", () => {
  const lines = renderWorkflowLines({
    name: "metrics",
    phases: ["Phase"],
    currentPhase: "Phase",
    logs: [],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
    agents: [
      {
        id: 1,
        label: "big agent",
        phase: "Phase",
        prompt: "work",
        status: "done",
        tokens: 126728,
        toolCalls: 12,
        elapsedMs: 141_000,
      },
    ],
  }).join("\n");

  assert.match(lines, /big agent \(126\.7k tok · 12 tools · 2m21s\)/);
});

test("the on-demand workflow guide advertises the live catalog while full tools add no system-prompt metadata", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-guide-"));
  const projectDir = path.join(cwd, ".pi", "workflows");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "project.js"),
    "export const meta = { name: 'project-guide-flow', description: 'visible in the live guide' }\nreturn args",
  );

  const guide = buildWorkflowGuide({ cwd });
  assert.match(guide, /invoked directly with \{name: '<name>', args\}/);
  assert.match(guide, /deep-research \[built-in\]/);
  assert.match(guide, /code-review \[built-in\]/);
  assert.match(guide, /project-guide-flow \[project\]/);

  const workflow = createWorkflowTool();
  const tasks = createWorkflowTasksTool({ listRuns: () => [] });
  assert.equal(workflow.promptSnippet, undefined);
  assert.equal(workflow.promptGuidelines, undefined);
  assert.equal(tasks.promptSnippet, undefined);
  assert.equal(tasks.promptGuidelines, undefined);
});

test("renderCall renders the generated script for a non-empty script arg", () => {
  const renderCall = getRenderCall();
  const component = renderCall({ script: validScript }, themeStub);
  const rendered = component.render(120).join("\n");
  assert.match(rendered, /workflow — generated script/);
  assert.match(rendered, /│ phase\('Scan'\)/);
});

test("renderCall falls back to the plain workflow title when there is no usable script", () => {
  const renderCall = getRenderCall();
  // A fence that is empty once stripped must also fall back, not render a
  // "generated script" header above an empty body.
  for (const args of [undefined, {}, { script: "" }, { script: "   " }, { script: 42 }, { script: "```js\n\n```" }]) {
    const component = renderCall(args as { script?: unknown }, themeStub);
    const rendered = component.render(120).join("\n").trim();
    assert.equal(rendered, "workflow", `expected fallback title for args=${JSON.stringify(args)}`);
  }
});

test("renderCall never throws", () => {
  const renderCall = getRenderCall();
  assert.doesNotThrow(() => renderCall({ script: "```js\nnot valid {{{" }, themeStub));
  assert.doesNotThrow(() => renderCall(null as unknown as { script?: unknown }, themeStub));
});

test("/workflows command lists saved workflows (built-ins + project) via a workflow_list message", async () => {
  type CommandSpec = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };
  const commands = new Map<string, CommandSpec>();
  const sent: Array<{ customType?: string; content?: Array<{ type: string; text?: string }> }> = [];
  extension({
    registerMessageRenderer: () => {},
    registerTool: () => {},
    registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec),
    on: () => {},
    getThinkingLevel: () => "medium",
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: (message: never) => {
      sent.push(message);
    },
  } as never);

  const command = commands.get("workflows");
  assert.ok(command, "the /workflows command must be registered");

  // Project dir with one saved workflow and one recent run directory.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cmd-"));
  fs.mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "workflows", "proj.js"),
    "export const meta = { name: 'proj-flow', description: 'project workflow' }\nawait agent('x')\nreturn 1",
  );
  fs.mkdirSync(path.join(cwd, ".pi-workflow-runs", "wf_recent123456"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-workflow-runs", "wf_recent123456", "workflow.js"), "// saved\n");

  let customCalls = 0;
  await command.handler("", {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: {
      notify: () => {},
      custom: () => {
        customCalls++;
        throw new Error("RPC must not open a TUI overlay");
      },
    },
  });

  assert.equal(customCalls, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "workflow_list");
  const text = sent[0].content?.[0]?.text ?? "";
  assert.match(text, /deep-research \[built-in\]/);
  assert.match(text, /code-review \[built-in\]/);
  assert.match(text, /proj-flow \[project\] — project workflow/);
  assert.match(text, /Live runs/);
  assert.match(text, /wf_recent123456/);
});

test("parseRunWorkflowInput resolves names and args against the registry", () => {
  const registry = loadWorkflowRegistry({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "wf-parse-")) });

  const empty = parseRunWorkflowInput("", registry);
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /Usage: \/run-workflow <name> \[args\]/);
  assert.match(empty.error ?? "", /deep-research/);

  const unknown = parseRunWorkflowInput("nope some args", registry);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /Unknown workflow "nope"/);
  assert.match(unknown.error ?? "", /code-review/);

  const bare = parseRunWorkflowInput("code-review", registry);
  assert.deepEqual(bare, { ok: true, name: "code-review" });

  const plain = parseRunWorkflowInput("deep-research how do X and Y compare?", registry);
  assert.deepEqual(plain, { ok: true, name: "deep-research", args: "how do X and Y compare?" });

  const json = parseRunWorkflowInput('code-review {"target": "HEAD~3..HEAD", "focus": "security"}', registry);
  assert.equal(json.ok, true);
  assert.deepEqual(json.args, { target: "HEAD~3..HEAD", focus: "security" });

  const fallback = parseRunWorkflowInput("code-review {not json", registry);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.args, "{not json");
});

test("/run-workflow command notifies on empty input and unknown names without executing", async () => {
  type CommandSpec = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };
  const commands = new Map<string, CommandSpec>();
  extension({
    registerMessageRenderer: () => {},
    registerTool: () => {},
    registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec),
    on: () => {},
    getThinkingLevel: () => "medium",
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: () => {},
  } as never);

  const command = commands.get("run-workflow");
  assert.ok(command, "the /run-workflow command must be registered");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runcmd-"));
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = { cwd, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  await command.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Usage: \/run-workflow <name> \[args\]/);
  assert.equal(notifications[0].type, "info");

  await command.handler("does-not-exist target", ctx);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message, /Unknown workflow "does-not-exist"/);
  assert.equal(notifications[1].type, "error");
});
