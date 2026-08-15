import type { WorkflowBackgroundResult } from "./workflow-tool.js";

export interface WorkflowResultDeliveryCoordinator {
  /** Begin accepting results for a fresh Pi session generation. */
  startSession(): void;
  /** Mark the parent model run active; queued completions must wait. */
  agentStarted(): void;
  /** Release one delivered completion turn, then send the next queued result. */
  agentSettled(): void;
  /** Queue one background result, deduplicated by tool invocation. */
  enqueue(result: WorkflowBackgroundResult): void;
  /** Temporarily prevent delivery (used by model-free direct dispatch). */
  hold(): () => void;
  /** Drop queued work and reject late results from the closing session. */
  shutdown(): void;
}

/**
 * Serialize detached workflow completions into one model turn per result.
 *
 * A completion can race the parent tool turn, another user/model turn, or other
 * workflow completions. Delivery therefore waits until the parent is settled,
 * sends exactly one trigger-turn message, then waits for that triggered run to
 * start and settle before sending the next result. Session shutdown closes the
 * queue so callbacks from cancelled old runs cannot leak into a replacement.
 */
export function createWorkflowResultDeliveryCoordinator(
  send: (result: WorkflowBackgroundResult) => void,
): WorkflowResultDeliveryCoordinator {
  const queued = new Map<number, WorkflowBackgroundResult>();
  let accepting = false;
  let agentActive = false;
  let barriers = 0;
  let generation = 0;
  let delivering: { deliveryId: number; agentStarted: boolean } | undefined;

  const flush = (): void => {
    if (!accepting || agentActive || barriers > 0 || delivering) return;

    // A synchronous stale-runner failure must not strand later completions.
    while (queued.size > 0 && !delivering) {
      const next = queued.entries().next().value as [number, WorkflowBackgroundResult] | undefined;
      if (!next) return;
      const [deliveryId, result] = next;
      queued.delete(deliveryId);
      delivering = { deliveryId, agentStarted: false };
      try {
        send(result);
      } catch {
        delivering = undefined;
      }
    }
  };

  const reset = (nextAccepting: boolean): void => {
    generation += 1;
    accepting = nextAccepting;
    agentActive = false;
    barriers = 0;
    delivering = undefined;
    queued.clear();
  };

  return {
    startSession() {
      reset(true);
    },

    agentStarted() {
      if (!accepting) return;
      agentActive = true;
      if (delivering) delivering.agentStarted = true;
    },

    agentSettled() {
      if (!accepting) return;
      agentActive = false;
      // Do not let the launching parent's own settlement claim a result sent by
      // this same callback. A delivered result is released only after a later
      // agent_start proves its trigger-turn run actually began.
      if (delivering?.agentStarted) delivering = undefined;
      flush();
    },

    enqueue(result) {
      if (!accepting) return;
      if (queued.has(result.deliveryId) || delivering?.deliveryId === result.deliveryId) return;
      queued.set(result.deliveryId, result);
      flush();
    },

    hold() {
      if (!accepting) return () => {};
      const heldGeneration = generation;
      let released = false;
      barriers += 1;
      return () => {
        if (released) return;
        released = true;
        if (!accepting || generation !== heldGeneration) return;
        barriers = Math.max(0, barriers - 1);
        flush();
      };
    },

    shutdown() {
      reset(false);
    },
  };
}
