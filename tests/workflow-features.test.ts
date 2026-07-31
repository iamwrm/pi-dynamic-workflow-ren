import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentTypes, parseAgentTypeFile } from "../src/agent-types.js";
import { BUILTIN_WORKFLOWS, CODE_REVIEW_WORKFLOW, DEEP_RESEARCH_WORKFLOW } from "../src/builtin-workflows.js";
import { agentKey } from "../src/journal.js";
import { MAX_SCRIPT_BYTES, parseWorkflowScript, runWorkflow } from "../src/workflow.js";
import { findWorkflow, loadWorkflowRegistry } from "../src/workflow-registry.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const META = "export const meta = { name: 'ft', description: 'feature tests' }\n";

function fakeRunner() {
  let calls = 0;
  const prompts: string[] = [];
  const optionsSeen: Array<Record<string, unknown>> = [];
  return {
    get calls() {
      return calls;
    },
    prompts,
    optionsSeen,
    run: async (prompt: string, options?: Record<string, unknown>) => {
      calls++;
      prompts.push(prompt);
      optionsSeen.push(options ?? {});
      return `echo:${prompt}`;
    },
  };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test("item cap: parallel() rejects more than 4096 items with an explicit error", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
const thunks = Array.from({ length: 4097 }, (_, i) => () => agent('p' + i))
return await parallel(thunks)`,
      { agent: runner, journalDir: tmpDir("wf-cap-") },
    ),
    /parallel\(\) accepts at most 4096 items per call \(got 4097\)/,
  );
  assert.equal(runner.calls, 1, "no fan-out may start when the cap trips");
});

test("item cap: pipeline() rejects more than 4096 items with an explicit error", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await agent('warm up')
const items = Array.from({ length: 5000 }, (_, i) => i)
return await pipeline(items, (item) => agent('x' + item))`,
      { agent: runner, journalDir: tmpDir("wf-cap-") },
    ),
    /pipeline\(\) accepts at most 4096 items per call \(got 5000\)/,
  );
  assert.equal(runner.calls, 1);
});

test("script size cap: scripts above 524288 bytes are rejected at parse time", () => {
  const padding = `// ${"x".repeat(MAX_SCRIPT_BYTES)}\n`;
  assert.throws(() => parseWorkflowScript(`${META}${padding}return 1`), /exceeds the 524288-byte limit/);
  // A small script stays fine.
  assert.equal(parseWorkflowScript(`${META}return 1`).meta.name, "ft");
});

test("log cap: log() stops recording after 1000 entries with one sentinel line", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow(
    `${META}
await agent('warm up')
for (let i = 0; i < 1200; i++) log('line ' + i)
return 'ok'`,
    { agent: runner, journalDir: tmpDir("wf-logcap-") },
  );
  assert.equal(result.logs.length, 1001, "1000 entries + 1 sentinel");
  assert.match(result.logs[1000], /\[log\] cap reached \(1000 entries\)/);
  assert.equal(result.logs[999], "line 999", "the first 1000 log() lines are kept");
});

// ---------------------------------------------------------------------------
// Per-agent option wiring (model / agentType / isolation)
// ---------------------------------------------------------------------------

test("opts.model resolves through resolveModel and is passed to the runner for real", async () => {
  const sentinelModel = { id: "fast-model", provider: "fake" };
  const runner = fakeRunner();
  const result = await runWorkflow<string>(
    `${META}\nreturn await agent('task', { label: 'with model', model: 'fast-model' })`,
    {
      agent: runner,
      journalDir: tmpDir("wf-model-"),
      resolveModel: (ref) => (ref === "fast-model" ? (sentinelModel as never) : undefined),
    },
  );
  assert.equal(result.result, "echo:task");
  assert.equal(runner.optionsSeen[0].model, sentinelModel, "the resolved Model object reaches the runner");
  assert.ok(
    !String(runner.optionsSeen[0].instructions ?? "").includes("model hint"),
    "a resolved model must not also be emitted as a prompt hint",
  );
});

test("opts.model falls back to a logged prompt hint when unresolvable", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<string>(
    `${META}\nreturn await agent('task', { label: 'with model', model: 'no-such-model' })`,
    {
      agent: runner,
      journalDir: tmpDir("wf-model-"),
      resolveModel: () => undefined,
    },
  );
  assert.equal(result.result, "echo:task");
  assert.equal(runner.optionsSeen[0].model, undefined);
  assert.match(String(runner.optionsSeen[0].instructions), /Requested model hint: no-such-model/);
  assert.ok(result.logs.some((line) => /model 'no-such-model' not found/.test(line)));
});

test("opts.agentType resolves a named definition: role prompt, tool allowlist, and model flow to the runner", async () => {
  const sentinelModel = { id: "reviewer-model", provider: "fake" };
  const runner = fakeRunner();
  await runWorkflow(`${META}\nreturn await agent('review this', { label: 'review', agentType: 'code-reviewer' })`, {
    agent: runner,
    journalDir: tmpDir("wf-atype-"),
    resolveModel: (ref) => (ref === "reviewer-model" ? (sentinelModel as never) : undefined),
    resolveAgentType: (name) =>
      name === "code-reviewer"
        ? {
            name: "code-reviewer",
            systemPrompt: "ROLE_PROMPT_FOR_REVIEWER",
            model: "reviewer-model",
            toolNames: ["read", "grep"],
          }
        : undefined,
  });
  const seen = runner.optionsSeen[0];
  assert.match(String(seen.instructions), /acting as the "code-reviewer" subagent type/);
  assert.match(String(seen.instructions), /ROLE_PROMPT_FOR_REVIEWER/);
  assert.deepEqual(seen.toolNames, ["read", "grep"]);
  assert.equal(seen.model, sentinelModel, "the agentType's model resolves when no explicit model is given");
});

test("opts.agentType falls back to a logged prompt hint when unresolvable", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow(`${META}\nreturn await agent('go', { label: 'x', agentType: 'ghost' })`, {
    agent: runner,
    journalDir: tmpDir("wf-atype-"),
  });
  assert.match(String(runner.optionsSeen[0].instructions), /Act as workflow subagent type: ghost/);
  assert.ok(result.logs.some((line) => /agentType 'ghost' not found/.test(line)));
});

test("per-agent options change the journal cache key; plain calls keep the v1 key", () => {
  const plain = agentKey(1, "p", "l", null);
  const plainWithEmptyExtras = agentKey(1, "p", "l", null, { model: null, agentType: null, isolation: null });
  assert.equal(plain, plainWithEmptyExtras, "absent extras must keep old journals replayable");
  assert.notEqual(plain, agentKey(1, "p", "l", null, { model: "m1" }));
  assert.notEqual(agentKey(1, "p", "l", null, { model: "m1" }), agentKey(1, "p", "l", null, { model: "m2" }));
  assert.notEqual(plain, agentKey(1, "p", "l", null, { isolation: "worktree" }));
});

// ---------------------------------------------------------------------------
// Worktree isolation (requires git; skipped when unavailable)
// ---------------------------------------------------------------------------

function makeGitRepo(): string | undefined {
  try {
    const dir = tmpDir("wf-repo-");
    execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
      cwd: dir,
      stdio: "pipe",
    });
    return dir;
  } catch {
    return undefined;
  }
}

test("isolation:'worktree' runs the agent in a real detached worktree and removes it when unchanged", async (t) => {
  const repo = makeGitRepo();
  if (!repo) return t.skip("git unavailable");
  const worktreeDir = tmpDir("wf-wt-");
  let agentCwd: string | undefined;
  const runner = {
    run: async (_prompt: string, options?: { cwd?: string }) => {
      agentCwd = options?.cwd;
      assert.ok(agentCwd && fs.existsSync(path.join(agentCwd, ".git")), "worktree exists during the run");
      return "done";
    },
  };
  const result = await runWorkflow<string>(
    `${META}\nreturn await agent('isolated task', { label: 'iso', isolation: 'worktree' })`,
    { agent: runner, cwd: repo, journalDir: tmpDir("wf-wtj-"), worktreeDir },
  );
  assert.equal(result.result, "done");
  assert.ok(agentCwd, "the runner received a per-call cwd");
  assert.notEqual(agentCwd, repo, "the per-call cwd is the worktree, not the repo");
  assert.ok(agentCwd?.startsWith(worktreeDir), "the worktree lives under the configured base dir");
  assert.equal(fs.existsSync(agentCwd as string), false, "an unchanged worktree is removed on release");
});

test("isolation:'worktree' keeps a mutated worktree and logs its path", async (t) => {
  const repo = makeGitRepo();
  if (!repo) return t.skip("git unavailable");
  const worktreeDir = tmpDir("wf-wt-");
  let agentCwd: string | undefined;
  const runner = {
    run: async (_prompt: string, options?: { cwd?: string }) => {
      agentCwd = options?.cwd;
      fs.writeFileSync(path.join(agentCwd as string, "new-file.txt"), "mutation");
      return "mutated";
    },
  };
  const result = await runWorkflow<string>(
    `${META}\nreturn await agent('mutating task', { label: 'mut', isolation: 'worktree' })`,
    { agent: runner, cwd: repo, journalDir: tmpDir("wf-wtj-"), worktreeDir },
  );
  assert.equal(result.result, "mutated");
  assert.ok(fs.existsSync(agentCwd as string), "a changed worktree is kept");
  assert.ok(result.logs.some((line) => line.includes("worktree kept (has changes)")));
});

test("isolation:'worktree' outside a git repo is a normal per-agent failure (null + log)", async () => {
  const notARepo = tmpDir("wf-norepo-");
  const runner = fakeRunner();
  const result = await runWorkflow<unknown>(
    `${META}
const broken = await agent('isolated', { label: 'iso', isolation: 'worktree' })
const ok = await agent('plain', { label: 'plain' })
return { broken, ok }`,
    { agent: runner, cwd: notARepo, journalDir: tmpDir("wf-wtj-"), worktreeDir: tmpDir("wf-wt-") },
  );
  const value = result.result as { broken: unknown; ok: unknown };
  assert.equal(value.broken, null);
  assert.equal(value.ok, "echo:plain");
  assert.ok(result.logs.some((line) => /worktree creation failed/.test(line)));
});

// ---------------------------------------------------------------------------
// workflow() nesting
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `export const meta = { name: 'child-flow', description: 'child workflow' }
log('inside child')
const a = await agent('child task one', { label: 'child a' })
const b = await agent('child task two', { label: 'child b' })
return { a, b, args }`;

test("workflow() runs a saved workflow inline, sharing journal/limits, with prefixed child logs", async () => {
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(
    `${META}
phase('Parent')
const mine = await agent('parent task', { label: 'parent' })
const child = await workflow('child-flow', { topic: 'nested' })
return { mine, child }`,
    {
      agent: runner,
      journalDir: tmpDir("wf-nest-"),
      resolveWorkflow: (name) => (name === "child-flow" ? CHILD_SCRIPT : undefined),
    },
  );
  const value = result.result as { mine: string; child: { a: string; b: string; args: { topic: string } } };
  assert.equal(value.mine, "echo:parent task");
  assert.equal(value.child.a, "echo:child task one");
  assert.equal(value.child.b, "echo:child task two");
  assert.equal(value.child.args.topic, "nested", "child args are injected into the child sandbox");
  assert.equal(result.agentCount, 3, "child agents share the parent's agent accounting");
  assert.ok(
    result.logs.some((line) => line === "[child-flow] inside child"),
    "child log() output is prefixed",
  );
  assert.ok(result.logs.some((line) => /workflow child-flow started/.test(line)));
  assert.ok(result.logs.some((line) => /workflow child-flow completed/.test(line)));
});

test("workflow() nesting is limited to one level: the child's workflow() throws", async () => {
  const grandparent = `${META}\nreturn await workflow('middle')`;
  const middle = `export const meta = { name: 'middle', description: 'middle workflow' }
await agent('mid task')
return await workflow('leaf')`;
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(grandparent, {
      agent: runner,
      journalDir: tmpDir("wf-nest-"),
      resolveWorkflow: (name) => (name === "middle" ? middle : undefined),
    }),
    /workflow\(\) cannot be called from within a child workflow — nesting is limited to one level/,
  );
});

test("workflow() with an unknown name throws a clear error", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(`${META}\nawait agent('x')\nreturn await workflow('ghost-flow')`, {
      agent: runner,
      journalDir: tmpDir("wf-nest-"),
      resolveWorkflow: () => undefined,
    }),
    /unknown workflow 'ghost-flow'/,
  );
});

test("workflow() child shares the parent's maxAgents spawn cap", async () => {
  const runner = fakeRunner();
  await assert.rejects(
    runWorkflow(`${META}\nawait agent('one')\nreturn await workflow('child-flow')`, {
      agent: runner,
      journalDir: tmpDir("wf-nest-"),
      maxAgents: 2,
      resolveWorkflow: (name) => (name === "child-flow" ? CHILD_SCRIPT : undefined),
    }),
    /maxAgents cap \(2\)/,
  );
});

// ---------------------------------------------------------------------------
// Built-in workflows + registry
// ---------------------------------------------------------------------------

test("built-in workflows parse through the real parser with the expected metadata", () => {
  const deepResearch = parseWorkflowScript(DEEP_RESEARCH_WORKFLOW);
  assert.equal(deepResearch.meta.name, "deep-research");
  assert.ok(deepResearch.meta.whenToUse);
  assert.deepEqual(
    deepResearch.meta.phases?.map((phase) => phase.title),
    ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
  );

  const codeReview = parseWorkflowScript(CODE_REVIEW_WORKFLOW);
  assert.equal(codeReview.meta.name, "code-review");
  assert.deepEqual(
    codeReview.meta.phases?.map((phase) => phase.title),
    ["Scope", "Review", "Verify", "Synthesize"],
  );
});

test("deep-research runs end-to-end against a fake runner (salvage path on unusable scope)", async () => {
  // The fake runner returns plain strings, so the schema-shaped scope is unusable
  // and the script must take its graceful salvage return instead of crashing.
  const runner = fakeRunner();
  const result = await runWorkflow<Record<string, unknown>>(DEEP_RESEARCH_WORKFLOW, {
    agent: runner,
    journalDir: tmpDir("wf-dr-"),
    args: "What is the airspeed velocity of an unladen swallow?",
  });
  assert.equal(runner.calls, 1, "only the scope agent ran");
  assert.match(String((result.result as { error?: string }).error), /scoping failed/);
});

test("registry: built-ins present; project overrides user overrides built-in; diagnostics for invalid files", () => {
  const cwd = tmpDir("wf-reg-cwd-");
  const agentDir = tmpDir("wf-reg-agent-");
  fs.mkdirSync(path.join(agentDir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });

  // User workflow with a unique name + a user override of the built-in deep-research.
  fs.writeFileSync(
    path.join(agentDir, "workflows", "user-flow.js"),
    "export const meta = { name: 'user-flow', description: 'user workflow' }\nawait agent('u')\nreturn 1",
  );
  fs.writeFileSync(
    path.join(agentDir, "workflows", "override.js"),
    "export const meta = { name: 'deep-research', description: 'user override of deep-research' }\nawait agent('u')\nreturn 1",
  );
  // Project override of the user workflow.
  fs.writeFileSync(
    path.join(cwd, ".pi", "workflows", "project.js"),
    "export const meta = { name: 'user-flow', description: 'project override' }\nawait agent('p')\nreturn 1",
  );
  // Invalid file -> diagnostics, not a crash.
  fs.writeFileSync(path.join(cwd, ".pi", "workflows", "broken.js"), "not a workflow at all (");

  const registry = loadWorkflowRegistry({ cwd, agentDir });
  const names = registry.workflows.map((workflow) => workflow.name);
  assert.deepEqual(names, [...names].sort(), "registry is alpha-sorted");
  assert.ok(names.includes("code-review"));

  const deepResearch = findWorkflow(registry, "deep-research");
  assert.equal(deepResearch?.source, "user", "user files override built-ins");
  assert.equal(deepResearch?.description, "user override of deep-research");

  const userFlow = findWorkflow(registry, "user-flow");
  assert.equal(userFlow?.source, "project", "project files override user files");
  assert.equal(userFlow?.description, "project override");

  assert.equal(registry.diagnostics.length, 1);
  assert.match(registry.diagnostics[0], /broken\.js/);
});

// ---------------------------------------------------------------------------
// Agent types registry
// ---------------------------------------------------------------------------

test("agent-type files parse frontmatter (name, model, tools) and body as role prompt", () => {
  const parsed = parseAgentTypeFile(
    [
      "---",
      "name: explorer",
      "description: Repo explorer",
      "model: fake/fast-model",
      "tools: read, grep, find",
      "---",
      "",
      "You explore repositories quickly.",
    ].join("\n"),
    "fallback",
  );
  assert.equal(parsed.name, "explorer");
  assert.equal(parsed.description, "Repo explorer");
  assert.equal(parsed.model, "fake/fast-model");
  assert.deepEqual(parsed.toolNames, ["read", "grep", "find"]);
  assert.equal(parsed.systemPrompt, "You explore repositories quickly.");

  const noFront = parseAgentTypeFile("Just a prompt body.", "stem-name");
  assert.equal(noFront.name, "stem-name");
  assert.equal(noFront.systemPrompt, "Just a prompt body.");
});

test("agent-type registry: project definitions override user definitions by name", () => {
  const cwd = tmpDir("wf-at-cwd-");
  const agentDir = tmpDir("wf-at-agent-");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agents", "rev.md"), "---\nname: reviewer\n---\nuser reviewer prompt");
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "rev.md"), "---\nname: reviewer\n---\nproject reviewer prompt");

  const registry = loadAgentTypes({ cwd, agentDir });
  assert.equal(registry.agentTypes.length, 1);
  assert.equal(registry.agentTypes[0].source, "project");
  assert.equal(registry.agentTypes[0].systemPrompt, "project reviewer prompt");
});

// ---------------------------------------------------------------------------
// Tool: exactly-one-source, script persistence, scriptPath + name invocation
// ---------------------------------------------------------------------------

test("workflow tool requires exactly one of script/scriptPath/name", async () => {
  const tool = createWorkflowTool({ cwd: process.cwd(), journalDir: tmpDir("wf-onesrc-") });
  const fakeCtx = { cwd: process.cwd(), hasUI: false } as never;
  await assert.rejects(
    Promise.resolve().then(() => tool.prepareArguments?.({} as never)),
    /exactly one of `script`, `scriptPath`, or `name`/,
  );
  await assert.rejects(
    Promise.resolve().then(() => tool.prepareArguments?.({ script: `${META}`, name: "deep-research" } as never)),
    /exactly one of/,
  );
  // And execute() with a missing source must not crash differently either.
  await assert.rejects(tool.execute("one-src", {} as never, undefined, undefined, fakeCtx), /exactly one of|workflow/);
});

test("workflow tool exposes and validates the child autoCompaction override", () => {
  const tool = createWorkflowTool({ cwd: process.cwd(), journalDir: tmpDir("wf-compaction-option-") });
  const prepared = tool.prepareArguments?.({
    script: `${META}\nreturn await agent('x')`,
    autoCompaction: false,
  } as never) as { autoCompaction?: boolean } | undefined;
  assert.equal(prepared?.autoCompaction, false);
  assert.throws(
    () => tool.prepareArguments?.({ script: `${META}\nreturn await agent('x')`, autoCompaction: "false" } as never),
    /autoCompaction.*boolean/,
  );
});

test("workflow tool persists inline scripts and supports {scriptPath} re-invocation with resume", async () => {
  const journalDir = tmpDir("wf-persist-");
  const cwd = tmpDir("wf-persist-cwd-");
  const script = `${META}\nconst value = await agent('persist me', { label: 'persist' })\nreturn { value }`;
  const fakeCtx = { cwd, hasUI: false } as never;

  const runner1 = fakeRunner();
  const tool1 = createWorkflowTool({ cwd, journalDir, agent: runner1 });
  const first = await tool1.execute("persist-1", { script }, undefined, undefined, fakeCtx);
  assert.equal(runner1.calls, 1);

  const details = first.details as { runId?: string; scriptPath?: string };
  assert.ok(details.scriptPath, "the inline script is persisted and its path returned");
  assert.equal(details.scriptPath, path.join(journalDir, details.runId as string, "workflow.js"));
  assert.equal(fs.readFileSync(details.scriptPath as string, "utf8").trim(), script.trim());
  const text = first.content[0];
  assert.ok(text?.type === "text" && text.text.includes("Script file:"), "the result text mentions the script file");

  // Re-invoke from the persisted file + resume: replays the journal, no new spawns.
  const runner2 = fakeRunner();
  const tool2 = createWorkflowTool({ cwd, journalDir, agent: runner2 });
  const second = await tool2.execute(
    "persist-2",
    { scriptPath: details.scriptPath as string, resumeFromRunId: details.runId },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.equal(runner2.calls, 0, "scriptPath + resumeFromRunId replays from the journal");
  assert.equal((second.details as { runId?: string }).runId, details.runId);
  assert.equal((second.details as { scriptPath?: string }).scriptPath, details.scriptPath);
});

test("workflow tool rejects UNC and unreadable scriptPath values", async () => {
  const cwd = tmpDir("wf-unc-");
  const tool = createWorkflowTool({ cwd, journalDir: tmpDir("wf-uncj-") });
  const fakeCtx = { cwd, hasUI: false } as never;
  await assert.rejects(
    tool.execute("unc-1", { scriptPath: "\\\\server\\share\\evil.js" }, undefined, undefined, fakeCtx),
    /UNC paths are not supported/,
  );
  await assert.rejects(
    tool.execute("unc-2", { scriptPath: "does/not/exist.js" }, undefined, undefined, fakeCtx),
    /scriptPath could not be read/,
  );
});

test("workflow tool runs saved workflows by name (project registry) and persists the effective script", async () => {
  const cwd = tmpDir("wf-named-");
  const journalDir = tmpDir("wf-namedj-");
  fs.mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "workflows", "hello.js"),
    "export const meta = { name: 'hello-flow', description: 'says hello' }\nconst out = await agent('say hello to ' + args, { label: 'hello' })\nreturn { out }",
  );
  const runner = fakeRunner();
  const tool = createWorkflowTool({ cwd, journalDir, agent: runner });
  const fakeCtx = { cwd, hasUI: false } as never;

  const result = await tool.execute("named-1", { name: "hello-flow", args: "world" }, undefined, undefined, fakeCtx);
  assert.equal(runner.calls, 1);
  assert.match(runner.prompts[0], /say hello to world/);
  const details = result.details as { scriptPath?: string; runId?: string; result?: unknown };
  assert.ok(details.scriptPath?.endsWith("workflow.js"), "named invocations persist the effective script too");

  await assert.rejects(
    tool.execute("named-2", { name: "ghost" }, undefined, undefined, fakeCtx),
    /unknown workflow name 'ghost'. Known workflows: .*hello-flow/,
  );
});

test("workflow tool resolves built-in names out of the box", async () => {
  const cwd = tmpDir("wf-builtin-");
  const runner = fakeRunner();
  const tool = createWorkflowTool({ cwd, journalDir: tmpDir("wf-builtinj-"), agent: runner });
  const fakeCtx = { cwd, hasUI: false } as never;
  const result = await tool.execute(
    "builtin-1",
    { name: "deep-research", args: "why is the sky blue?" },
    undefined,
    undefined,
    fakeCtx,
  );
  // Fake runner returns strings, so deep-research takes its salvage path after Scope.
  assert.equal(runner.calls, 1);
  assert.match(JSON.stringify((result.details as { result?: unknown }).result), /scoping failed/);
});

test("BUILTIN_WORKFLOWS list matches the registered metas", () => {
  assert.deepEqual(
    BUILTIN_WORKFLOWS.map((workflow) => workflow.name),
    ["deep-research", "code-review"],
  );
  for (const builtin of BUILTIN_WORKFLOWS) {
    assert.equal(parseWorkflowScript(builtin.script).meta.name, builtin.name);
  }
});
