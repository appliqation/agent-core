// Fetches a named workflow (an appq MCP prompt, or a locally-bundled file)
// and runs it through the generic loop as one fresh-context invocation. This
// is the one reusable primitive every consuming agent is built around.

import { readFile } from 'node:fs/promises';
import type { LlmToolDef, ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';
import { runLoop, type LoopResult } from './loop.js';

export type WorkflowSource =
  | { kind: 'appq'; name: string; args?: Record<string, unknown> }
  | { kind: 'local'; path: string };

export type FetchPromptFn = (name: string, args?: Record<string, unknown>) => Promise<string>;

async function resolveWorkflowText(source: WorkflowSource, fetchPrompt: FetchPromptFn): Promise<string> {
  if (source.kind === 'appq') {
    return fetchPrompt(source.name, source.args ?? {});
  }
  const text = await readFile(source.path, 'utf-8');
  if (!text.trim()) throw new Error(`Local workflow file "${source.path}" is empty`);
  return text;
}

export async function runWorkflow(args: {
  source: WorkflowSource;
  /** Only required when source.kind === 'appq' — pass the calling agent's McpClient.fetchPrompt. */
  fetchPrompt?: FetchPromptFn;
  seedMessage: string;
  tools: LlmToolDef[];
  dispatch: ToolDispatcher;
  adapter: ProviderAdapter;
  budget: RunBudget;
  signal?: AbortSignal;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}): Promise<LoopResult> {
  if (args.source.kind === 'appq' && !args.fetchPrompt) {
    throw new Error('runWorkflow() requires fetchPrompt when source.kind is "appq"');
  }
  const system = await resolveWorkflowText(args.source, args.fetchPrompt as FetchPromptFn);
  return runLoop({
    adapter: args.adapter,
    system,
    seedMessage: args.seedMessage,
    tools: args.tools,
    dispatch: args.dispatch,
    budget: args.budget,
    signal: args.signal,
    onEvent: args.onEvent,
  });
}
