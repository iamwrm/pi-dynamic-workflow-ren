import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { WorkflowJournal } from "../src/journal.js";
import { workflowJson } from "../src/json.js";
import { runWorkflow } from "../src/workflow.js";

const META = "export const meta = { name: 'json', description: 'json boundary' };\n";

test("workflow JSON copies cross-realm data and rejects lossy or executable values", () => {
  const data = vm.runInNewContext('({ rows: [null, true, 1, "hello"], nested: { value: 2 } })');
  const copy = workflowJson(data);
  assert.deepEqual(copy, JSON.parse(JSON.stringify(data)));
  assert.notEqual(copy, data);
  const cycle: any = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const accessor = {
    get value() {
      getterCalls++;
      return 1;
    },
  };
  for (const bad of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    Symbol("x"),
    new Date(),
    new Map(),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          getterCalls++;
          throw new Error("must not execute");
        },
      },
    ),
    Object.create(
      Object.defineProperty(Object.create(null), "constructor", {
        get() {
          getterCalls++;
          return Object;
        },
      }),
    ),
    Object.create(
      Object.assign(Object.create(null), {
        constructor: new Proxy(Object, {
          getOwnPropertyDescriptor() {
            getterCalls++;
            throw new Error("must not execute constructor proxy");
          },
        }),
      }),
    ),
    { omitted: undefined },
    [undefined],
    Array(2),
    cycle,
    accessor,
    { toJSON: () => "hidden" },
    { [Symbol("x")]: 1 },
    Object.assign([1], { extra: true }),
  ]) {
    assert.throws(() => workflowJson(bad), /JSON|cycle|accessor|symbol|enumerable/);
  }
  assert.equal(getterCalls, 0);
});

test("failed journal serialization/write never poisons replay cache; persisted data is detached", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-json-"));
  try {
    const journal = WorkflowJournal.open({ cwd: root, runId: "test", journalDir: root });
    assert.throws(() => journal.append("invalid", { bad: 1n }));
    assert.equal(journal.has("invalid"), false);
    fs.mkdirSync(journal.journalPath);
    assert.throws(() => journal.append("retry", { ok: true }));
    assert.equal(journal.has("retry"), false);
    fs.rmdirSync(journal.journalPath);
    const value = { ok: true };
    journal.append("retry", value);
    value.ok = false;
    assert.deepEqual(journal.get("retry"), { ok: true });
    assert.deepEqual(WorkflowJournal.open({ cwd: root, runId: "test", journalDir: root }).get("retry"), { ok: true });
    journal.append("retry", { ok: false });
    assert.equal(fs.readFileSync(journal.journalPath, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow results fail closed before tool/session persistence; omitted return is explicit null", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-result-"));
  try {
    const options = { cwd: root, journalDir: root, agent: { run: async () => "ok" } };
    for (const expression of [
      "{ bad: undefined }",
      "{ n: 0 / 0 }",
      "() => 1",
      "1n",
      "(() => { const c = {}; c.self = c; return c; })()",
    ])
      await assert.rejects(runWorkflow(`${META}await agent('ok'); return ${expression}`, options), /JSON|cycle/);
    assert.equal((await runWorkflow(`${META}await agent('ok')`, options)).result, null);
    const result = await runWorkflow(
      `${META}const answer = await agent('ok'); return { answer, nested: [1, true] }`,
      options,
    );
    assert.deepEqual(result.result, { answer: "ok", nested: [1, true] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
