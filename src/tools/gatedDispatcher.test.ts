import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAppqToolDefs, dispatchAppqTool, createGatedAppqDispatcher, assertToolAllowed } from './gatedDispatcher.js';
import type { McpClient } from '../appq/mcpClient.js';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

describe('fetchAppqToolDefs', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
    (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'get_scenario', description: 'Fetch a scenario', inputSchema: { type: 'object' } },
      { name: 'create_defect', description: 'File a defect', inputSchema: { type: 'object' } },
      { name: 'update_run_results', description: 'Write results', inputSchema: { type: 'object' } },
    ]);
  });

  it('filters appq tools/list down to only the allowlisted names', async () => {
    const defs = await fetchAppqToolDefs(client, new Set(['get_scenario']));
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('get_scenario');
  });

  it('offers nothing when the allowlist matches none of the available tools', async () => {
    const defs = await fetchAppqToolDefs(client, new Set(['nonexistent_tool']));
    expect(defs).toEqual([]);
  });

  it('preserves description and inputSchema on the filtered defs', async () => {
    const defs = await fetchAppqToolDefs(client, new Set(['create_defect']));
    expect(defs[0].description).toBe('File a defect');
    expect(defs[0].inputSchema).toEqual({ type: 'object' });
  });
});

describe('dispatchAppqTool', () => {
  it('calls through to callTool and maps the outcome shape', async () => {
    const client = fakeClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'result text', raw: { some: 'data' } });
    const result = await dispatchAppqTool(client, 'get_scenario', { scenario_id: 1 });
    expect(client.callTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result).toEqual({ ok: true, text: 'result text', data: { some: 'data' } });
  });
});

describe('createGatedAppqDispatcher — the hardcoded write-tool boundary', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'ok', raw: {} });
  });

  it('dispatches a call within the allowlist', async () => {
    const dispatch = createGatedAppqDispatcher(client, new Set(['get_scenario']));
    const result = await dispatch('get_scenario', { scenario_id: 1 });
    expect(client.callTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result.ok).toBe(true);
  });

  it('blocks a call outside the allowlist WITHOUT ever reaching callTool', async () => {
    const dispatch = createGatedAppqDispatcher(client, new Set(['get_scenario']));
    await expect(dispatch('create_defect', { project_id: 1, text: 'bug' })).rejects.toThrow(/create_defect/);
    // The critical assertion: the disallowed call must never reach appq at all,
    // not just that an error was surfaced somewhere.
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('an executor-scoped dispatcher cannot reach a verdict-bearing tool even if asked', async () => {
    const executorAllowlist = new Set(['get_scenario', 'submit_execution_evidence']);
    const dispatch = createGatedAppqDispatcher(client, executorAllowlist);
    await expect(dispatch('update_run_results', { action: 'submit_results' })).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });
});

describe('assertToolAllowed', () => {
  const allowlist = new Set(['get_scenario', 'submit_execution_evidence']);

  it('does not throw for an allowed tool', () => {
    expect(() => assertToolAllowed('get_scenario', allowlist)).not.toThrow();
  });

  it('throws for a tool outside the allowlist, naming the tool', () => {
    expect(() => assertToolAllowed('create_defect', allowlist)).toThrow(/create_defect/);
  });

  it('throw message makes clear this is a hardcoded boundary, not prompt-adjustable', () => {
    expect(() => assertToolAllowed('create_defect', allowlist)).toThrow(/hardcoded/);
  });
});
