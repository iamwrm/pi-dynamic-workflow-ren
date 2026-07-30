import fs from "node:fs";
import path from "node:path";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows.js";
import { parseWorkflowScript } from "./workflow.js";

/**
 * Named/saved workflow registry, mirroring Claude Code's (§8 of the feature ref):
 *
 * | Source    | Location                       |
 * |-----------|--------------------------------|
 * | built-in  | shipped scripts (deep-research, code-review) |
 * | user      | `<agentDir>/workflows/*.js`    (e.g. ~/.pi/agent/workflows/) |
 * | project   | `<cwd>/.pi/workflows/*.js`     |
 *
 * All sources merge by `meta.name` with project > user > built-in precedence,
 * then sort alphabetically. Every file is validated through the real workflow
 * parser (pure-literal meta, determinism ban, 512KB size cap); invalid files are
 * skipped and reported in `diagnostics`.
 */
export interface WorkflowRegistryEntry {
  name: string;
  description: string;
  whenToUse?: string;
  source: "built-in" | "user" | "project";
  /** File the workflow was loaded from (absent for built-ins). */
  path?: string;
  script: string;
}

export interface WorkflowRegistry {
  workflows: WorkflowRegistryEntry[];
  diagnostics: string[];
}

export interface LoadWorkflowRegistryOptions {
  /** Project directory; `<cwd>/.pi/workflows` is scanned when set. */
  cwd?: string;
  /** Agent dir; `<agentDir>/workflows` is scanned when set. */
  agentDir?: string;
  /** Include the shipped built-in workflows (default true). */
  includeBuiltins?: boolean;
}

export function loadWorkflowRegistry(options: LoadWorkflowRegistryOptions = {}): WorkflowRegistry {
  const byName = new Map<string, WorkflowRegistryEntry>();
  const diagnostics: string[] = [];

  if (options.includeBuiltins !== false) {
    for (const builtin of BUILTIN_WORKFLOWS) {
      try {
        const { meta } = parseWorkflowScript(builtin.script);
        byName.set(meta.name, {
          name: meta.name,
          description: meta.description,
          ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
          source: "built-in",
          script: builtin.script,
        });
      } catch (error) {
        diagnostics.push(`built-in ${builtin.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const scanDir = (dir: string, source: "user" | "project") => {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return; // Directory absent: nothing to load.
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".js")) continue;
      const full = path.join(dir, file);
      try {
        const script = fs.readFileSync(full, "utf8");
        const { meta } = parseWorkflowScript(script);
        byName.set(meta.name, {
          name: meta.name,
          description: meta.description,
          ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
          source,
          path: full,
          script,
        });
      } catch (error) {
        diagnostics.push(`${full}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  if (options.agentDir) scanDir(path.join(options.agentDir, "workflows"), "user");
  if (options.cwd) scanDir(path.join(options.cwd, ".pi", "workflows"), "project");

  return {
    workflows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  };
}

export function findWorkflow(registry: WorkflowRegistry, name: string): WorkflowRegistryEntry | undefined {
  return registry.workflows.find((workflow) => workflow.name === name);
}

/** Parse result for the /run-workflow command's argument line. */
export interface RunWorkflowInputParse {
  ok: boolean;
  /** Resolved saved-workflow name (when ok). */
  name?: string;
  /** Workflow args: JSON-parsed when the remainder looks like JSON, else the raw string. */
  args?: unknown;
  /** Human-readable error including the available names (when not ok). */
  error?: string;
}

/**
 * Parse `/run-workflow <name> [args...]` input against the registry. The first
 * whitespace-delimited token is the workflow name; the rest of the line is the
 * args payload. A remainder that starts like JSON (`{`, `[`, or `"`) is
 * JSON.parsed so structured args (e.g. `{"target": "HEAD~3..HEAD"}`) pass
 * through typed; invalid JSON falls back to the raw string. Missing or unknown
 * names produce an error message that lists the available workflows.
 */
export function parseRunWorkflowInput(input: string, registry: WorkflowRegistry): RunWorkflowInputParse {
  const available = registry.workflows.map((workflow) => workflow.name).join(", ") || "(none)";
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: `Usage: /run-workflow <name> [args]. Available: ${available}` };
  }
  const space = trimmed.search(/\s/);
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const remainder = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (!findWorkflow(registry, name)) {
    return { ok: false, error: `Unknown workflow "${name}". Available: ${available}` };
  }
  if (!remainder) return { ok: true, name };
  let args: unknown = remainder;
  if (/^[{["]/.test(remainder)) {
    try {
      args = JSON.parse(remainder);
    } catch {
      // Not valid JSON after all: pass the raw string through.
    }
  }
  return { ok: true, name, args };
}
