import fs from "node:fs";
import path from "node:path";

/**
 * Named subagent type definitions for `agent(prompt, { agentType })`, mirroring
 * Claude Code's custom-agent registry. Definitions are Markdown files with a
 * small frontmatter header; the body becomes the subagent's role system prompt:
 *
 * ```md
 * ---
 * name: code-reviewer
 * description: Thorough code reviewer
 * model: anthropic/claude-opus-4-5      # optional per-type model override
 * thinking: high                        # optional per-type thinking level
 * tools: read, grep, find, ls           # optional tool allowlist
 * ---
 * You are a meticulous code reviewer. Focus on ...
 * ```
 *
 * Discovery (later sources override earlier ones by name):
 * - user:    `<agentDir>/agents/*.md`   (e.g. ~/.pi/agent/agents/)
 * - project: `<cwd>/.pi/agents/*.md`
 */
export interface ResolvedAgentType {
  name: string;
  description?: string;
  whenToUse?: string;
  /** Model reference resolved through the workflow's resolveModel hook. */
  model?: string;
  /** Raw thinking override from frontmatter `thinking` / `thinkingLevel`. */
  thinkingLevel?: string;
  /** Restrict the subagent's tools to these names. */
  toolNames?: string[];
  /** Role definition appended to the subagent's task instructions. */
  systemPrompt?: string;
  source?: "user" | "project";
  path?: string;
}

export interface AgentTypeRegistry {
  agentTypes: ResolvedAgentType[];
  diagnostics: string[];
}

export function loadAgentTypes(options: { cwd?: string; agentDir?: string }): AgentTypeRegistry {
  const byName = new Map<string, ResolvedAgentType>();
  const diagnostics: string[] = [];

  const scan = (dir: string, source: "user" | "project") => {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return; // Directory absent: nothing to load.
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      try {
        const parsed = parseAgentTypeFile(fs.readFileSync(full, "utf8"), path.basename(file, ".md"));
        byName.set(parsed.name, { ...parsed, source, path: full });
      } catch (error) {
        diagnostics.push(`${full}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  if (options.agentDir) scan(path.join(options.agentDir, "agents"), "user");
  if (options.cwd) scan(path.join(options.cwd, ".pi", "agents"), "project");

  return {
    agentTypes: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  };
}

/**
 * Parse one agent-type Markdown file. Frontmatter is optional; when absent the
 * whole file is the system prompt and the name falls back to the file stem.
 * The frontmatter parser is deliberately minimal (flat `key: value` lines) so
 * the package needs no YAML dependency.
 */
export function parseAgentTypeFile(content: string, fallbackName: string): ResolvedAgentType {
  let body = content;
  const front: Record<string, string> = {};

  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (match) {
    body = content.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed
        .slice(colon + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (key) front[key] = value;
    }
  }

  const name = (front.name ?? "").trim() || fallbackName;
  if (!name) throw new Error("agent type must have a name (frontmatter `name:` or file name)");

  const toolNames = front.tools
    ? front.tools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean)
    : undefined;

  const systemPrompt = body.trim();
  return {
    name,
    ...(front.description ? { description: front.description } : {}),
    ...(front.whenToUse ? { whenToUse: front.whenToUse } : {}),
    ...(front.model ? { model: front.model } : {}),
    ...(front.thinkingLevel || front.thinking ? { thinkingLevel: front.thinkingLevel || front.thinking } : {}),
    ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}
