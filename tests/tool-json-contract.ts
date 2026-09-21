import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { WorkflowSnapshot } from "../src/display.js";
import type { WorkflowTasksDetails, WorkflowToolDetails } from "../src/workflow-tool.js";

type Assert<T extends true> = T;
type Persistable<T> = [ToolResultMessage<T>] extends [never] ? false : true;

// AgentToolResult itself permits unknown details; persisted Pi messages do not.
// Compile these with the extension gate so an unsafe callback/result cannot regress.
export type WorkflowDetailsContract = Assert<Persistable<WorkflowToolDetails>>;
export type WorkflowTasksContract = Assert<Persistable<WorkflowTasksDetails>>;
export type WorkflowUpdateContract = Assert<Persistable<WorkflowSnapshot>>;
