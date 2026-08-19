/**
 * Pi thinking levels accepted by `agent(..., { thinkingLevel })` and agent-type
 * frontmatter (`thinking` / `thinkingLevel`). Unknown values are rejected at
 * the host boundary so sandbox scripts cannot pass garbage into createAgentSession.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type WorkflowThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/** Canonicalize a script/frontmatter value for journal identity. Empty → unset. */
export function thinkingLevelKey(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    return normalized || undefined;
  }
  return String(raw);
}

/** Return a valid Pi thinking level, or undefined if the value is missing/invalid. */
export function parseThinkingLevel(raw: unknown): WorkflowThinkingLevel | undefined {
  const key = thinkingLevelKey(raw);
  if (!key || !THINKING_LEVEL_SET.has(key)) return undefined;
  return key as WorkflowThinkingLevel;
}
