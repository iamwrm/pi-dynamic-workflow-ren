import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot } from "../src/display.js";
import { SessionView, type SessionViewTarget } from "../src/session-view.js";

// pi's message components read the module-level theme at render time; tests run
// outside a TUI so initialize it once with a built-in theme.
initTheme("dark");

const KEY_UP = "\x1b[A";
const KEY_ESCAPE = "\x1b";
const NOW = 5_000_000;

function fixtureMessages(): unknown[] {
  return [
    { role: "user", content: "Review the file please", timestamp: 1 },
    {
      role: "assistant",
      api: "anthropic",
      content: [
        { type: "thinking", thinking: "secret reasoning here" },
        { type: "text", text: "# Findings\n\nLooking at **the code** now." },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/x.ts" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6\nline7" }],
      isError: false,
      timestamp: 3,
    },
    { role: "assistant", api: "anthropic", content: [{ type: "text", text: "All done. SHIP_IT" }], timestamp: 4 },
  ];
}

function fixture(
  overrides: {
    messages?: unknown[];
    agent?: Partial<WorkflowAgentSnapshot>;
    session?: Partial<ReturnType<NonNullable<SessionViewTarget["getSession"]>>> | null;
    killResult?: { killed: boolean; reason?: string };
  } = {},
) {
  const messages = overrides.messages ?? fixtureMessages();
  const agent: WorkflowAgentSnapshot = {
    id: 2,
    label: "reviewer",
    phase: "P",
    prompt: "p",
    status: "running",
    startedAtMs: NOW - 65_000,
    tokens: 12_345,
    ...overrides.agent,
  };
  const kills: number[] = [];
  let backs = 0;
  const view = new SessionView({
    target: {
      runId: "wf_sv",
      agentId: 2,
      getAgent: () => agent,
      getSession: () =>
        overrides.session === null
          ? undefined
          : {
              live: true,
              getMessages: () => messages,
              model: "anthropic/claude-test",
              thinkingLevel: "xhigh",
              ...overrides.session,
            },
      killAgent: () => {
        kills.push(agent.id);
        return overrides.killResult ?? { killed: true };
      },
    },
    onBack: () => {
      backs++;
    },
    now: () => NOW,
  });
  return { view, frame: (width = 100) => view.render(width).join("\n"), kills, backsCount: () => backs };
}

test("renders the conversation: prompt, markdown text, thinking, tool call + collapsed result", () => {
  const { frame } = fixture();
  const text = frame(120);
  // Header: id, label, live status, model id, thinking level, tokens.
  assert.match(text, /agent #2 · reviewer/);
  assert.match(text, /● running 1m05s/);
  assert.match(text, /anthropic\/claude-test · xhigh · 12\.3k tok/);
  // User prompt ("what is sent").
  assert.match(text, /Review the file please/);
  // Assistant markdown text and visible-by-default thinking.
  assert.match(text, /Findings/);
  assert.match(text, /the code/);
  assert.match(text, /secret reasoning here/);
  // Tool call fallback (no TUI in tests) and collapsed result (4 lines + marker).
  assert.match(text, /⚒ read \{"path":"\/tmp\/x\.ts"\}/);
  assert.match(text, /line4/);
  assert.doesNotMatch(text, /line5/);
  assert.match(text, /…\(\+3 more lines\)/);
  // Final assistant message and the live streaming marker.
  assert.match(text, /SHIP_IT/);
  assert.match(text, /▌/);
});

test("t toggles thinking visibility on already-rendered messages", () => {
  const { view, frame } = fixture();
  assert.match(frame(120), /secret reasoning here/);
  view.handleInput("t");
  const hidden = frame(120);
  assert.doesNotMatch(hidden, /secret reasoning here/);
  assert.match(hidden, /\[thinking hidden — press t\]/);
  view.handleInput("t");
  assert.match(frame(120), /secret reasoning here/);
});

test("scrolling detaches from the bottom and G re-attaches", () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: "user",
    content: `message number ${i}`,
    timestamp: i,
  }));
  const { view, frame } = fixture({ messages });
  // Following the bottom: the last message is visible.
  assert.match(frame(), /message number 29/);
  view.handleInput(KEY_UP);
  view.handleInput(KEY_UP);
  const scrolled = frame();
  assert.match(scrolled, /… \d+ more below \(↓\/PgDn\/G\) …/);
  view.handleInput("G");
  assert.match(frame(), /message number 29/);
});

test("finished agents replay from messages.jsonl and say so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sv-"));
  const messagesPath = path.join(dir, "002-reviewer.messages.jsonl");
  fs.writeFileSync(
    messagesPath,
    `${fixtureMessages()
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`,
  );
  const { frame } = fixture({
    agent: { status: "done", startedAtMs: undefined, elapsedMs: 90_000 },
    session: { live: false, getMessages: undefined, messagesPath },
  });
  const text = frame(120);
  assert.match(text, /finished · from messages\.jsonl/);
  assert.match(text, /Review the file please/);
  assert.match(text, /SHIP_IT/);
  assert.doesNotMatch(text, /▌/);
});

test("k confirms and kills the running agent from inside the session view", () => {
  const { view, frame, kills } = fixture();
  view.handleInput("k");
  assert.match(frame(), /Kill agent #2 "reviewer"\? y\/n/);
  view.handleInput("y");
  assert.deepEqual(kills, [2]);
  assert.match(frame(), /killed — agent\(\) resolves null/);
});

test("flash messages survive re-render ticks and clear on the next keypress", () => {
  const { view, frame } = fixture();
  view.handleInput("k");
  view.handleInput("y");
  // The 400ms timer re-renders constantly; the outcome must survive renders.
  assert.match(frame(), /killed — agent\(\) resolves null/);
  assert.match(frame(), /killed — agent\(\) resolves null/);
  assert.match(frame(), /killed — agent\(\) resolves null/);
  // ...and clear on input.
  view.handleInput(KEY_UP);
  assert.doesNotMatch(frame(), /killed — agent\(\) resolves null/);
});

test("finished without persisted messages says so instead of claiming a file", () => {
  const { frame } = fixture({
    agent: { status: "done", startedAtMs: undefined },
    session: { live: false, getMessages: undefined, messagesPath: undefined },
  });
  const text = frame(120);
  assert.match(text, /finished · no persisted messages/);
  assert.doesNotMatch(text, /from messages\.jsonl/);
  assert.match(text, /no session data/);
});

test("finished agents with an in-memory snapshot render without touching the filesystem", () => {
  const { frame } = fixture({
    agent: { status: "done", startedAtMs: undefined },
    session: { live: false, getMessages: () => fixtureMessages(), messagesPath: undefined },
  });
  const text = frame(120);
  assert.match(text, /finished · from messages\.jsonl/);
  assert.match(text, /Review the file please/);
  assert.match(text, /SHIP_IT/);
});

test("a changed messagesPath (stall-retry re-persistence) refreshes the SAME view's file cache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sv-retry-"));
  const first = path.join(dir, "002-reviewer.messages.jsonl");
  const second = path.join(dir, "002-reviewer.retry2.messages.jsonl");
  fs.writeFileSync(first, `${JSON.stringify({ role: "user", content: "attempt one", timestamp: 1 })}\n`);
  fs.writeFileSync(second, `${JSON.stringify({ role: "user", content: "attempt two", timestamp: 2 })}\n`);
  let currentPath = first;
  const view = new SessionView({
    target: {
      runId: "wf_retrycache",
      agentId: 2,
      getAgent: () => ({ id: 2, label: "reviewer", prompt: "p", status: "done" }),
      getSession: () => ({ live: false, messagesPath: currentPath }),
    },
    onBack: () => {},
    now: () => NOW,
  });
  assert.match(view.render(120).join("\n"), /attempt one/);
  // The retry re-persists to a NEW write-once path; the same open view must
  // drop its parsed-file cache because the path changed (regression for the
  // stale-cache bug when the path was reused and overwritten).
  currentPath = second;
  assert.match(view.render(120).join("\n"), /attempt two/);
  assert.doesNotMatch(view.render(120).join("\n"), /attempt one/);
});

test("escape and q go back to the tree", () => {
  const { view, backsCount } = fixture();
  view.handleInput(KEY_ESCAPE);
  assert.equal(backsCount(), 1);
  view.handleInput("q");
  assert.equal(backsCount(), 2);
});

test("missing session data explains the cache-replay case", () => {
  const { frame } = fixture({ session: null });
  assert.match(frame(), /no session data — the agent may have been replayed/);
});

test("framed lines hold the display-width contract", () => {
  const { view } = fixture();
  for (const width of [44, 80, 120]) {
    const lines = view.render(width);
    assert.match(lines[0], /^┌─ agent #2/);
    for (const line of lines.slice(1, -1)) {
      assert.equal(visibleWidth(line), width, `line width must be ${width}: ${JSON.stringify(line)}`);
    }
  }
});
