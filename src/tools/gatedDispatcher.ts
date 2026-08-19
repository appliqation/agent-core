// Wraps appq MCP tools as LLM-callable tool defs, filtered to whatever
// allowlist the calling stage was constructed with, and enforces that
// allowlist before every dispatch. This is the mechanism only — the
// allowlist *content* (which tools a given agent/stage may touch) is each
// consuming agent's own domain knowledge, kept in its own tools/safety.ts,
// never here. Schemas are fetched live from appq's tools/list rather than
// hardcoded, so this stays correct as appq's tool surface evolves.

import type { LlmToolDef, ToolDispatcher, ToolResult } from '../types.js';
import type { McpClient } from '../appq/mcpClient.js';

export type ToolAllowlist = Set<string>;

/**
 * The actual enforcement point for "the one hardcoded client-side
 * invariant" every consuming agent relies on. fetchAppqToolDefs() only
 * controls what's *offered* to the model; this is what stops a call that
 * shouldn't happen from *executing*, regardless of what the model attempts
 * or what a served prompt says.
 */
export function assertToolAllowed(toolName: string, allowlist: ToolAllowlist): void {
  if (!allowlist.has(toolName)) {
    throw new Error(
      `Tool "${toolName}" is not in this stage's allowlist. This is a hardcoded ` +
        `boundary — no workflow prompt can widen it. If this tool genuinely needs to be ` +
        `reachable from this stage, that's a code change to the agent's own tools/safety.ts, ` +
        `not a prompt change.`,
    );
  }
}

export async function fetchAppqToolDefs(client: McpClient, allowlist: ToolAllowlist): Promise<LlmToolDef[]> {
  const all = await client.listTools();
  return all
    .filter((t) => allowlist.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
}

export async function dispatchAppqTool(client: McpClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const outcome = await client.callTool(name, args);
  return { ok: outcome.ok, text: outcome.text, data: outcome.raw };
}

export function createGatedAppqDispatcher(client: McpClient, allowlist: ToolAllowlist): ToolDispatcher {
  return async (name, args) => {
    assertToolAllowed(name, allowlist);
    return dispatchAppqTool(client, name, args);
  };
}
