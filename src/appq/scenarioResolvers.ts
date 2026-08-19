// Scenario/project/run/url resolution against appq's MCP tools. Pure
// appq-response-shape parsing, no agent-specific meaning — every consuming
// agent needs the identical scenario/project/url derivation, including the
// "never accept project_id/url as separate, possibly-diverging inputs"
// invariant: a scenario belongs to exactly one project, and there's no
// server-side check that a caller-supplied URL actually matches a named
// environment — a diverging value would silently test the wrong target. Take
// an McpClient explicitly rather than importing a global one, matching
// mcpClient.ts's factory-not-singleton design.

import type { McpClient } from './mcpClient.js';
import type { TcInfo } from '../tools/roleInference.js';
import { parseScenarioTcList, parseTestSetTcList } from '../tools/roleInference.js';

export async function resolveRun(
  client: McpClient,
  opts: {
    runId?: string;
    scenarioId?: string;
    projectId?: string;
    environment?: string;
  },
): Promise<string> {
  if (opts.runId) return opts.runId;
  if (!opts.scenarioId || !opts.projectId) {
    throw new Error('--scenario-id and --project-id are required to create a run (or pass --run-id to reuse one).');
  }
  const created = await client.callTool('update_run_results', {
    action: 'create_run',
    scenario_id: Number(opts.scenarioId),
    project_id: Number(opts.projectId),
    ...(opts.environment ? { environment: opts.environment } : {}),
  });
  if (!created.ok) throw new Error(`Failed to create run: ${created.text}`);
  const parsed = JSON.parse(created.text) as { run_id: string };
  console.error(`[setup] created run ${parsed.run_id}`);
  return parsed.run_id;
}

/** A TC UUID is always "{scenario_id}-{uuid4}" — appq's own tools parse it the same way (e.g. CreateDefectTool). */
export function scenarioIdFromTcUuid(tcUuid: string): number {
  const prefix = tcUuid.split('-', 1)[0];
  const id = Number(prefix);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Could not derive a scenario ID from test case UUID "${tcUuid}" — expected "{scenario_id}-{uuid4}".`);
  }
  return id;
}

/**
 * scenario_id is never accepted as a separate input alongside a TC UUID —
 * it's mathematically embedded in the UUID, so a caller-supplied value
 * could only ever be a stale/typo'd duplicate, never a legitimate override.
 * In whole-scenario mode there's nothing to derive it from, so scenarioId is
 * the one genuinely required primary input there.
 */
export function resolveScenarioId(opts: { scenarioId?: string; testCaseUuid?: string }): number {
  if (opts.testCaseUuid) return scenarioIdFromTcUuid(opts.testCaseUuid);
  if (opts.scenarioId) return Number(opts.scenarioId);
  throw new Error('--scenario-id is required in whole-scenario mode (no --test-case-uuid given).');
}

/**
 * project_id is always derived, never accepted as a separate input — a
 * scenario belongs to exactly one project, so a caller-supplied value that
 * diverges from the real one can only be wrong. get_scenario needs only
 * scenario_id; its response always includes "Project ID: N" plus each TC's
 * name/UUID/tag — fetched once and reused for role inference too, rather
 * than a second call for the same data.
 */
export async function fetchScenarioInfo(client: McpClient, scenarioId: number): Promise<{ projectId: number; tcs: TcInfo[] }> {
  const result = await client.callTool('get_scenario', { scenario_id: scenarioId });
  if (!result.ok) throw new Error(`get_scenario failed while resolving scenario ${scenarioId}: ${result.text}`);
  const match = result.text.match(/Project ID:\s*(\d+)/);
  if (!match) throw new Error(`Could not find a project ID in get_scenario's response for scenario ${scenarioId}.`);
  console.error(`[setup] project ${match[1]} (scenario ${scenarioId})`);
  return { projectId: Number(match[1]), tcs: parseScenarioTcList(result.text) };
}

/**
 * project_id is always derived here too, same reasoning as
 * fetchScenarioInfo() — get_test_set already returns "Project ID: N" since
 * a test set belongs to exactly one project, even though its test cases
 * can span multiple *scenarios* (that's the whole point of a test set —
 * a curated cross-scenario collection, e.g. a regression/smoke/sanity
 * suite for CI). Each returned TcInfo's own scenario_id is NOT included as
 * a separate field — derive it per-TC via scenarioIdFromTcUuid() when
 * needed, the same single source of truth every other TC-scoped
 * resolution in this package already trusts, rather than a second parsed
 * value that could quietly disagree with it.
 */
export async function fetchTestSetInfo(client: McpClient, testSetId: number): Promise<{ projectId: number; tcs: TcInfo[] }> {
  const result = await client.callTool('get_test_set', { testset_id: testSetId });
  if (!result.ok) throw new Error(`get_test_set failed while resolving test set ${testSetId}: ${result.text}`);
  const match = result.text.match(/Project ID:\s*(\d+)/);
  if (!match) throw new Error(`Could not find a project ID in get_test_set's response for test set ${testSetId}.`);
  console.error(`[setup] project ${match[1]} (test set ${testSetId})`);
  return { projectId: Number(match[1]), tcs: parseTestSetTcList(result.text) };
}

/**
 * url is always derived from an environment name, never accepted as a
 * separate input. Unlike project_id (which create_run itself validates
 * against the scenario and rejects on mismatch), there's no server-side
 * check that a caller-supplied URL actually matches the named environment —
 * a diverging value would silently test the wrong target while the run gets
 * recorded against a different environment, with nothing to catch it.
 * get_project_settings already stores a URL per named environment.
 */
export async function resolveUrl(client: McpClient, environment: string, projectId: number): Promise<string> {
  const result = await client.callTool('get_project_settings', { project_id: projectId });
  if (!result.ok) throw new Error(`get_project_settings failed while resolving the URL for environment "${environment}": ${result.text}`);
  const settings = JSON.parse(result.text) as { environments?: Array<{ name: string; url: string }> };
  const env = (settings.environments ?? []).find((e) => e.name === environment);
  if (!env) {
    const available = (settings.environments ?? []).map((e) => e.name).join(', ') || '(none configured)';
    throw new Error(`No environment named "${environment}" on project ${projectId}. Available: ${available}`);
  }
  console.error(`[setup] url ${env.url} (environment "${environment}")`);
  return env.url;
}
