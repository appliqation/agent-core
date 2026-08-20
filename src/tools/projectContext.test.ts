import { describe, it, expect, vi } from 'vitest';
import { createReadOnlyProjectContextDispatcher } from './projectContext.js';
import type { ToolResult } from '../types.js';

describe('createReadOnlyProjectContextDispatcher', () => {
  it('passes through action: "read" to the inner dispatcher', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'context data' } satisfies ToolResult);
    const dispatch = createReadOnlyProjectContextDispatcher(inner);
    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(inner).toHaveBeenCalledWith('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(result.text).toBe('context data');
  });

  it('refuses action: "write" without ever calling the inner dispatcher', async () => {
    const inner = vi.fn();
    const dispatch = createReadOnlyProjectContextDispatcher(inner);
    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'write', knowledge: {} });
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/read-only/);
  });

  it('refuses a missing action, fail-closed, not passed through as a default', async () => {
    const inner = vi.fn();
    const dispatch = createReadOnlyProjectContextDispatcher(inner);
    const result = await dispatch('enrich_project_context', { project_id: 1349 });
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed action value, not just the literal string "write"', async () => {
    const inner = vi.fn();
    const dispatch = createReadOnlyProjectContextDispatcher(inner);
    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'READ' });
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('the refusal message names it as a hardcoded, non-prompt-adjustable boundary', async () => {
    const dispatch = createReadOnlyProjectContextDispatcher(vi.fn());
    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'write' });
    expect(result.text).toMatch(/hardcoded boundary/);
  });

  it('leaves every other tool name completely untouched', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'scenario data' } satisfies ToolResult);
    const dispatch = createReadOnlyProjectContextDispatcher(inner);
    const result = await dispatch('get_scenario', { scenario_id: 2424 });
    expect(inner).toHaveBeenCalledWith('get_scenario', { scenario_id: 2424 });
    expect(result.text).toBe('scenario data');
  });
});
