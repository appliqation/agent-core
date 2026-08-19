import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveRun, scenarioIdFromTcUuid, resolveScenarioId, fetchScenarioInfo, fetchTestSetInfo, resolveUrl } from './scenarioResolvers.js';
import type { McpClient } from './mcpClient.js';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

describe('scenarioIdFromTcUuid', () => {
  it('extracts the numeric scenario ID prefix from a TC UUID', () => {
    expect(scenarioIdFromTcUuid('2424-533acecf-306d-4f14-94df-b9bb5f9bed90')).toBe(2424);
  });

  it('throws for a UUID with no numeric prefix', () => {
    expect(() => scenarioIdFromTcUuid('abc-533acecf-306d-4f14-94df-b9bb5f9bed90')).toThrow(/Could not derive/);
  });

  it('throws for a zero or negative scenario ID', () => {
    expect(() => scenarioIdFromTcUuid('0-533acecf-306d-4f14-94df-b9bb5f9bed90')).toThrow();
    expect(() => scenarioIdFromTcUuid('-5-533acecf')).toThrow();
  });

  it('throws for an empty string', () => {
    expect(() => scenarioIdFromTcUuid('')).toThrow();
  });
});

describe('resolveScenarioId', () => {
  it('derives scenario_id from --test-case-uuid, ignoring a stale --scenario-id if both are given', () => {
    // The UUID is the source of truth — see scenarioResolvers.ts's docblock.
    // A mismatched --scenario-id can only be a typo, never a legitimate value.
    expect(resolveScenarioId({ testCaseUuid: '2424-abc', scenarioId: '9999' })).toBe(2424);
  });

  it('uses --scenario-id directly in whole-scenario mode (no TC UUID)', () => {
    expect(resolveScenarioId({ scenarioId: '2424' })).toBe(2424);
  });

  it('throws when neither is given', () => {
    expect(() => resolveScenarioId({})).toThrow(/--scenario-id is required/);
  });
});

describe('resolveRun', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
  });

  it('returns the given run ID unchanged without calling appq, when --run-id is provided', async () => {
    const runId = await resolveRun(client, { runId: 'run_existing' });
    expect(runId).toBe('run_existing');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('throws when no run-id and scenario/project are incomplete', async () => {
    await expect(resolveRun(client, { scenarioId: '1' })).rejects.toThrow(/--scenario-id and --project-id are required/);
    await expect(resolveRun(client, { projectId: '1' })).rejects.toThrow();
    await expect(resolveRun(client, {})).rejects.toThrow();
  });

  it('creates a run via update_run_results when scenario_id + project_id are given', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ run_id: 'run_new' }) });
    const runId = await resolveRun(client, { scenarioId: '2424', projectId: '1349' });
    expect(runId).toBe('run_new');
    expect(client.callTool).toHaveBeenCalledWith('update_run_results', {
      action: 'create_run',
      scenario_id: 2424,
      project_id: 1349,
    });
  });

  it('includes environment in the create_run call only when given', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ run_id: 'run_new' }) });
    await resolveRun(client, { scenarioId: '2424', projectId: '1349', environment: 'Stage' });
    expect(client.callTool).toHaveBeenCalledWith('update_run_results', {
      action: 'create_run',
      scenario_id: 2424,
      project_id: 1349,
      environment: 'Stage',
    });
  });

  it('throws with the appq error text when create_run fails', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'no environment configured' });
    await expect(resolveRun(client, { scenarioId: '2424', projectId: '1349' })).rejects.toThrow(/no environment configured/);
  });
});

describe('fetchScenarioInfo', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
  });

  const scenarioText = [
    'Scenario: Some scenario (AD-1)',
    'Project ID: 1349',
    'Tags: (none)',
    'Jira Issue: (none)',
    'Sprint: (none)',
    '',
    'Test Cases:',
    '  1. First TC (UUID: 1349-aaa)',
    '  2. Second TC (UUID: 1349-bbb) [Tag: role:manager]',
  ].join('\n');

  it('extracts project_id from get_scenario\'s response', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: scenarioText });
    const { projectId } = await fetchScenarioInfo(client, 1349);
    expect(projectId).toBe(1349);
    expect(client.callTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1349 });
  });

  it('parses the TC list from the same response, avoiding a second call', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: scenarioText });
    const { tcs } = await fetchScenarioInfo(client, 1349);
    expect(tcs).toHaveLength(2);
    expect(tcs[1].tag).toBe('role:manager');
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('throws when get_scenario fails', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'scenario not found' });
    await expect(fetchScenarioInfo(client, 9999)).rejects.toThrow(/scenario not found/);
  });

  it('throws when the response has no parseable project ID', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'Scenario: weird response with no project line' });
    await expect(fetchScenarioInfo(client, 1349)).rejects.toThrow(/Could not find a project ID/);
  });
});

describe('fetchTestSetInfo', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
  });

  const testSetText = [
    'Test Set: DailyPulse — Smoke',
    'ID: 1358',
    'Project ID: 1349',
    'Priority: Critical',
    'Test Cases: 2',
    '',
    '  1. First TC (UUID: 1540-aaa)',
    '     Scenario ID: 1540 | Tag: Functional',
    '  2. Second TC (UUID: 1356-bbb)',
    '     Scenario ID: 1356',
  ].join('\n');

  it('extracts project_id from get_test_set\'s response, calling testset_id (not test_set_id)', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: testSetText });
    const { projectId } = await fetchTestSetInfo(client, 1358);
    expect(projectId).toBe(1349);
    expect(client.callTool).toHaveBeenCalledWith('get_test_set', { testset_id: 1358 });
  });

  it('parses TCs spanning multiple scenarios from the same response, avoiding a second call', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: testSetText });
    const { tcs } = await fetchTestSetInfo(client, 1358);
    expect(tcs).toHaveLength(2);
    expect(tcs[0]).toEqual({ name: 'First TC', testCaseUuid: '1540-aaa', tag: 'Functional' });
    expect(tcs[1]).toEqual({ name: 'Second TC', testCaseUuid: '1356-bbb' });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('throws when get_test_set fails', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'test set not found' });
    await expect(fetchTestSetInfo(client, 9999)).rejects.toThrow(/test set not found/);
  });

  it('throws when the response has no parseable project ID', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'Test Set: weird response with no project line' });
    await expect(fetchTestSetInfo(client, 1358)).rejects.toThrow(/Could not find a project ID/);
  });
});

describe('resolveUrl', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
  });

  it('resolves the URL for the named environment', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ environments: [{ name: 'Stage', url: 'https://stage.example.com' }] }),
    });
    const url = await resolveUrl(client, 'Stage', 1349);
    expect(url).toBe('https://stage.example.com');
    expect(client.callTool).toHaveBeenCalledWith('get_project_settings', { project_id: 1349 });
  });

  it('throws listing available environments when the named one does not match', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ environments: [{ name: 'Stage', url: 'x' }, { name: 'Preprod', url: 'y' }] }),
    });
    await expect(resolveUrl(client, 'Production', 1349)).rejects.toThrow(/Stage, Preprod/);
  });

  it('reports "(none configured)" when the project has no environments at all', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ environments: [] }) });
    await expect(resolveUrl(client, 'Stage', 1349)).rejects.toThrow(/\(none configured\)/);
  });

  it('throws when get_project_settings itself fails', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'access denied' });
    await expect(resolveUrl(client, 'Stage', 1349)).rejects.toThrow(/access denied/);
  });
});
