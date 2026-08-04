import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// The session view renders pi message components, which read the module-level
// theme at render time; initialize it once for headless tests.
initTheme("dark");

import type { WorkflowSnapshot } from "../src/display.js";
import { type InspectorRun, WorkflowInspector } from "../src/inspector-ui.js";

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

const NOW = 1_000_000;

function fixtureSnapshot(): WorkflowSnapshot {
  return {
    name: "demo",
    phases: ["Scan", "Review"],
    currentPhase: "Review",
    logs: ["log one", "log two"],
    agentCount: 3,
    runningCount: 1,
    doneCount: 1,
    errorCount: 1,
    agents: [
      {
        id: 1,
        label: "scanner",
        phase: "Scan",
        prompt: "scan the repository",
        status: "done",
        tokens: 126728,
        toolCalls: 3,
        elapsedMs: 90_000,
      },
      { id: 2, label: "rev a", phase: "Review", prompt: "review part a", status: "killed", error: "killed" },
      { id: 3, label: "rev b", phase: "Review", prompt: "review part b", status: "running", startedAtMs: NOW - 65_000 },
    ],
  };
}

function fixture(overrides: Partial<InspectorRun> = {}) {
  const snapshot = fixtureSnapshot();
  const killedAgentCalls: number[][] = [];
  let runKills = 0;
  const run: InspectorRun = {
    runId: "wf_demo",
    name: "demo",
    startedAtMs: NOW - 120_000,
    getSnapshot: () => snapshot,
    killRun: () => {
      runKills++;
    },
    killAgents: (ids) => {
      killedAgentCalls.push(ids);
      return ids.map((id) => ({ id, killed: true }));
    },
    getAgentFeed: (id) =>
      id === 3
        ? {
            lines: ["⚒ bash: npm test", "💬 looking at results"],
            liveText: "now checking the failing case",
            transcriptPath: "/tmp/agents/003-rev-b.md",
          }
        : undefined,
    getAgentSession: (id) =>
      id === 1
        ? { live: false, model: "anthropic/claude-done", thinkingLevel: "medium" }
        : id === 3
          ? { live: true, model: "openai/gpt-running", thinkingLevel: "high" }
          : undefined,
    ...overrides,
  };
  let closed = 0;
  const inspector = new WorkflowInspector({
    listRuns: () => [run],
    onClose: () => {
      closed++;
    },
    now: () => NOW,
  });
  return {
    inspector,
    snapshot,
    frame: (width = 100) => inspector.render(width).join("\n"),
    killedAgentCalls,
    runKillCount: () => runKills,
    closedCount: () => closed,
  };
}

test("inspector renders the run tree with phases, icons, and metrics", () => {
  const { frame } = fixture();
  const text = frame();
  assert.match(text, /▾ demo \(wf_demo\) · Review — 1\/3 done · 1 running · 1 failed · 126\.7k tok · 2m00s/);
  assert.match(text, /── Scan/);
  assert.match(text, /── Review/);
  assert.match(text, /#1 ✓ scanner — 126\.7k tok · 3 tools · 1m30s · anthropic\/claude-done · medium/);
  assert.match(text, /#2 ✗ rev a \(killed\)/);
  assert.match(text, /#3 ● rev b — running 1m05s · openai\/gpt-running · high/);
  // The run row is selected initially and its detail shows logs.
  assert.match(text, /▸ ▾ demo/);
  assert.match(text, /log two/);
});

test("running-agent and run totals refresh when live token usage changes", () => {
  const { inspector, snapshot, frame } = fixture();
  const running = snapshot.agents[2];
  assert.ok(running);
  running.tokens = 12_345;
  let text = frame();
  assert.match(text, /demo \(wf_demo\).*139\.1k tok/);
  assert.match(text, /#3 ● rev b — running 1m05s · 12\.3k tok · openai\/gpt-running · high/);

  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  assert.match(frame(), /#3 rev b — running 1m05s · 12\.3k tok · Review · openai\/gpt-running · high/);

  running.tokens = 23_456;
  text = frame();
  assert.match(text, /#3 ● rev b — running 1m05s · 23\.5k tok · openai\/gpt-running · high/);
  assert.match(text, /demo \(wf_demo\).*150\.2k tok/);
});

test("navigation moves over runs and agents (skipping phase headers) and shows agent detail", () => {
  const { inspector, frame } = fixture();
  inspector.handleInput(KEY_DOWN);
  let text = frame();
  assert.match(text, /▸ {3}#1 ✓ scanner/);
  assert.match(text, /prompt: scan the repository/);
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  text = frame();
  assert.match(text, /▸ {3}#3 ● rev b/);
  // Live activity feed + streaming tail for the selected running agent.
  assert.match(text, /⚒ bash: npm test/);
  assert.match(text, /💬 looking at results/);
  assert.match(text, /▌now checking the failing case/);
  // Up returns toward the run row.
  inspector.handleInput(KEY_UP);
  text = frame();
  assert.match(text, /▸ {3}#2 ✗ rev a/);
});

test("enter folds and unfolds the selected run", () => {
  const { inspector, frame } = fixture();
  inspector.handleInput(KEY_ENTER);
  let text = frame();
  assert.match(text, /▸ ▸ demo/);
  assert.doesNotMatch(text, /#1 ✓ scanner/);
  inspector.handleInput(KEY_ENTER);
  text = frame();
  assert.match(text, /#1 ✓ scanner/);
});

test("k on a running agent confirms, y kills it through killAgents", () => {
  const { inspector, frame, killedAgentCalls } = fixture();
  inspector.handleInput(KEY_DOWN); // #1
  inspector.handleInput(KEY_DOWN); // #2
  inspector.handleInput(KEY_DOWN); // #3 running
  inspector.handleInput("k");
  assert.match(frame(), /Kill agent #3 "rev b"\? y\/n/);
  inspector.handleInput("y");
  assert.deepEqual(killedAgentCalls, [[3]]);
  assert.match(frame(), /killed agent #3 "rev b"/);
});

test("k on a finished agent only flashes guidance", () => {
  const { inspector, frame, killedAgentCalls } = fixture();
  inspector.handleInput(KEY_DOWN); // #1 done
  inspector.handleInput("k");
  assert.match(frame(), /agent #1 is done — only running agents can be killed/);
  assert.equal(killedAgentCalls.length, 0);
});

test("n cancels a pending confirm without killing", () => {
  const { inspector, frame, killedAgentCalls, runKillCount } = fixture();
  inspector.handleInput("K");
  assert.match(frame(), /Kill run wf_demo "demo"\? y\/n/);
  inspector.handleInput("n");
  assert.match(frame(), /kill cancelled/);
  assert.equal(runKillCount(), 0);
  assert.equal(killedAgentCalls.length, 0);
});

test("K + y kills the whole run", () => {
  const { inspector, frame, runKillCount } = fixture();
  inspector.handleInput("K");
  inspector.handleInput("y");
  assert.equal(runKillCount(), 1);
  assert.match(frame(), /killed run wf_demo "demo" — journal stays resumable/);
});

test("y outside a confirm shows the resume hint", () => {
  const { inspector, frame } = fixture();
  inspector.handleInput("y");
  // Wide frame: the hint includes the full scriptPath + resumeFromRunId snippet.
  assert.match(frame(160), /resumeFromRunId: 'wf_demo'/);
});

test("q and escape close the inspector", () => {
  const { inspector, closedCount } = fixture();
  inspector.handleInput("q");
  assert.equal(closedCount(), 1);
  inspector.handleInput(KEY_ESCAPE);
  assert.equal(closedCount(), 2);
});

test("every rendered line respects the width contract", () => {
  const { inspector } = fixture();
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  for (const width of [38, 60, 100]) {
    for (const line of inspector.render(width)) {
      assert.ok([...line].length <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
    }
  }
});

test("the frame is bordered and fully opaque (every interior line padded to width)", () => {
  const { inspector } = fixture();
  const width = 80;
  const lines = inspector.render(width);
  assert.match(lines[0], /^┌─ Workflows ─+┐$/);
  assert.match(lines.at(-1) ?? "", /^└─+┘$/);
  for (const line of lines.slice(1, -1)) {
    assert.equal([...line].length, width, `interior line not padded to ${width}: ${JSON.stringify(line)}`);
    assert.ok(
      line.startsWith("│") || line.startsWith("├"),
      `interior line missing left border: ${JSON.stringify(line)}`,
    );
    assert.ok(line.endsWith("│") || line.endsWith("┤"), `interior line missing right border: ${JSON.stringify(line)}`);
  }
  // The tree/detail divider uses connected box characters.
  assert.ok(
    lines.some((line) => /^├─+┤$/.test(line)),
    "expected a ├─┤ divider",
  );
});

test("empty state renders the fallback listing lines", () => {
  let closed = 0;
  const inspector = new WorkflowInspector({
    listRuns: () => [],
    emptyStateLines: () => ["Saved workflows", "  code-review [built-in]"],
    onClose: () => {
      closed++;
    },
  });
  const text = inspector.render(80).join("\n");
  assert.match(text, /\(no live workflow runs\)/);
  assert.match(text, /code-review \[built-in\]/);
  inspector.handleInput("q");
  assert.equal(closed, 1);
});

test("emoji and ANSI content cannot shear the border (display-width padding)", () => {
  const { inspector } = fixture({
    getAgentFeed: (id) =>
      id === 3
        ? {
            lines: ["💬 🚀🚀🚀 wide emoji content 漢字テスト", "⚒ bash: echo \x1b[31mred\x1b[0m and \x07bell"],
            liveText: "🔥 streaming 漢字 tail",
          }
        : undefined,
  });
  // Select the running agent so the emoji-heavy feed renders in the detail pane.
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  const width = 60;
  for (const line of inspector.render(width)) {
    assert.equal(visibleWidth(line), width, `line display width must be exactly ${width}: ${JSON.stringify(line)}`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are gone
    assert.doesNotMatch(line, /\x1b\[31m/, "ANSI escapes must be stripped");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
    assert.doesNotMatch(line, /[\x00-\x08\x0b-\x1f\x7f]/, "control chars must be stripped");
  }
});

test("selection reseats to the nearest neighbor when the selected row vanishes", () => {
  const snapshot = fixtureSnapshot();
  const inspector = new WorkflowInspector({
    listRuns: () => [{ runId: "wf_demo", name: "demo", getSnapshot: () => snapshot }],
    onClose: () => {},
    now: () => NOW,
  });
  // Move to the last agent (#3).
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_DOWN);
  assert.match(inspector.render(100).join("\n"), /▸ {3}#3 ● rev b/);
  // The selected agent disappears from the snapshot (e.g. it finished and the
  // run shape changed): the selection must land on its neighbor (#2), not the top.
  snapshot.agents.pop();
  assert.match(inspector.render(100).join("\n"), /▸ {3}#2 ✗ rev a/);
});

test("folding the run from an agent row (←) selects the run row", () => {
  const { inspector, frame } = fixture();
  inspector.handleInput(KEY_DOWN); // #1
  inspector.handleInput("\x1b[D"); // ← folds the run from inside (⏎ now inspects)
  const text = frame();
  assert.match(text, /▸ ▸ demo/);
  assert.doesNotMatch(text, /#1 ✓ scanner/);
});

test("q during a pending confirm cancels it and closes the inspector", () => {
  const { inspector, frame, closedCount, runKillCount } = fixture();
  inspector.handleInput("K");
  assert.match(frame(), /Kill run wf_demo/);
  inspector.handleInput("q");
  assert.equal(closedCount(), 1);
  assert.equal(runKillCount(), 0);
});

test("K without a killRun capability flashes instead of confirming", () => {
  const { inspector, frame } = fixture({ killRun: undefined });
  inspector.handleInput("K");
  const text = frame();
  assert.match(text, /run wf_demo does not expose kill/);
  assert.doesNotMatch(text, /y\/n/);
});

test("enter on an agent row opens the session view; escape returns to the tree", () => {
  const { inspector, frame } = fixture({
    getAgentSession: (id) =>
      id === 1
        ? {
            live: true,
            getMessages: () => [{ role: "user", content: "scan the repository", timestamp: 1 }],
            model: "anthropic/claude-test",
            thinkingLevel: "xhigh",
          }
        : undefined,
  });
  inspector.handleInput(KEY_DOWN); // select agent #1
  inspector.handleInput(KEY_ENTER); // drill in
  let text = frame(120);
  assert.match(text, /┌─ agent #1/);
  assert.match(text, /anthropic\/claude-test · xhigh/);
  inspector.handleInput(KEY_ESCAPE); // back to tree
  text = frame(120);
  assert.match(text, /┌─ Workflows/);
  assert.match(text, /#1 ✓ scanner/);
});

test("long agent lists window around the selection", () => {
  const agents = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    label: `agent ${i + 1}`,
    phase: "Phase",
    prompt: "p",
    status: "running" as const,
    startedAtMs: NOW - 1000,
  }));
  const snapshot: WorkflowSnapshot = {
    name: "big",
    phases: ["Phase"],
    currentPhase: "Phase",
    logs: [],
    agentCount: agents.length,
    runningCount: agents.length,
    doneCount: 0,
    errorCount: 0,
    agents,
  };
  const inspector = new WorkflowInspector({
    listRuns: () => [{ runId: "wf_big", name: "big", getSnapshot: () => snapshot }],
    onClose: () => {},
    now: () => NOW,
  });
  const text = inspector.render(100).join("\n");
  assert.match(text, /… \d+ more below …/);
});
