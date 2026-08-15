import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowResultDeliveryCoordinator } from "../src/result-delivery.js";
import type { WorkflowBackgroundResult } from "../src/workflow-tool.js";

function result(runId: string, deliveryId: number, text = runId): WorkflowBackgroundResult {
  return {
    deliveryId,
    runId,
    name: `workflow-${runId}`,
    status: "completed",
    text,
    details: { runId, status: "completed" },
  };
}

test("fast completion waits for the launching parent to settle", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => sent.push(item.runId));
  delivery.startSession();
  delivery.agentStarted();

  delivery.enqueue(result("fast", 1));
  assert.deepEqual(sent, [], "completion must not collide with the launching parent turn");

  delivery.agentSettled();
  assert.deepEqual(sent, ["fast"], "launch settlement releases exactly one completion");

  // The settlement that released the result must not also count as the result's
  // own triggered turn. Until a later agent_start + agent_settled pair, the next
  // completion remains queued.
  delivery.enqueue(result("next", 2));
  delivery.agentSettled();
  assert.deepEqual(sent, ["fast"]);

  delivery.agentStarted();
  delivery.agentSettled();
  assert.deepEqual(sent, ["fast", "next"]);
});

test("concurrent completions are serialized one triggered model turn at a time", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => sent.push(item.runId));
  delivery.startSession();

  delivery.enqueue(result("one", 1));
  delivery.enqueue(result("two", 2));
  delivery.enqueue(result("three", 3));
  assert.deepEqual(sent, ["one"]);

  delivery.agentStarted();
  delivery.agentSettled();
  assert.deepEqual(sent, ["one", "two"]);

  delivery.agentStarted();
  delivery.agentSettled();
  assert.deepEqual(sent, ["one", "two", "three"]);

  delivery.agentStarted();
  delivery.agentSettled();
  assert.deepEqual(sent, ["one", "two", "three"]);
});

test("delivery ids deduplicate callbacks without blocking a resumed run id", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => sent.push(item.text));
  delivery.startSession();
  delivery.agentStarted();

  delivery.enqueue(result("same", 1, "first"));
  delivery.enqueue(result("same", 1, "duplicate while queued"));
  delivery.agentSettled();
  assert.deepEqual(sent, ["first"]);

  delivery.enqueue(result("same", 1, "duplicate while delivered"));
  assert.deepEqual(sent, ["first"]);

  delivery.agentStarted();
  delivery.enqueue(result("same", 2, "later resume"));
  assert.deepEqual(sent, ["first"], "the resumed result waits for the current delivery turn");
  delivery.agentSettled();
  assert.deepEqual(sent, ["first", "later resume"], "a later resumed run may reuse its runId");
});

test("delivery holds protect direct command dispatch and release idempotently", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => sent.push(item.runId));
  delivery.startSession();

  const releaseOuter = delivery.hold();
  const releaseInner = delivery.hold();
  delivery.enqueue(result("direct", 1));
  assert.deepEqual(sent, []);

  releaseOuter();
  releaseOuter();
  assert.deepEqual(sent, [], "an idempotent release must not consume another hold");

  releaseInner();
  assert.deepEqual(sent, ["direct"]);
});

test("shutdown clears queued delivery and stale holds cannot alter a new session", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => sent.push(item.runId));
  delivery.startSession();
  delivery.agentStarted();
  delivery.enqueue(result("old", 1));
  const staleRelease = delivery.hold();

  delivery.shutdown();
  delivery.agentSettled();
  delivery.enqueue(result("closed", 2));
  assert.deepEqual(sent, []);

  delivery.startSession();
  const freshRelease = delivery.hold();
  delivery.enqueue(result("new", 3));
  staleRelease();
  assert.deepEqual(sent, [], "a prior session's release must not consume the fresh hold");
  freshRelease();
  assert.deepEqual(sent, ["new"]);
});

test("a stale-runner send failure does not strand later results", () => {
  const sent: string[] = [];
  const delivery = createWorkflowResultDeliveryCoordinator((item) => {
    if (item.runId === "stale") throw new Error("runner disposed");
    sent.push(item.runId);
  });
  delivery.startSession();

  assert.doesNotThrow(() => delivery.enqueue(result("stale", 1)));
  delivery.enqueue(result("healthy", 2));
  assert.deepEqual(sent, ["healthy"]);
});
