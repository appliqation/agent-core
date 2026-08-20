import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { knownRolesForProject, inferRole, isApiTest, parseScenarioTcList, parseTestSetTcList } from './roleInference.js';

describe('knownRolesForProject', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('APPQ_PROJECT_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns an empty array when no role env vars are configured', () => {
    expect(knownRolesForProject(1349)).toEqual([]);
  });

  it('discovers a role from its USERNAME env var', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
  });

  it('discovers multiple roles', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_1349_ADMIN_USERNAME = 'y';
    expect(knownRolesForProject(1349).sort()).toEqual(['admin', 'manager']);
  });

  it('does not leak another project\'s roles', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_9999_ADMIN_USERNAME = 'y';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
    expect(knownRolesForProject(9999)).toEqual(['admin']);
  });

  it('dedupes when both USERNAME and PASSWORD are set for the same role', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_1349_MANAGER_PASSWORD = 'y';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
  });

  it('ignores unrelated env vars that merely share the numeric prefix', () => {
    process.env.APPQ_PROJECT_13499_MANAGER_USERNAME = 'x'; // different (longer) project id
    expect(knownRolesForProject(1349)).toEqual([]);
  });
});

describe('inferRole', () => {
  const roles = ['manager', 'admin'];

  it('uses an explicit role:<name> tag', () => {
    expect(inferRole({ testCaseUuid: 't1', name: 'Some TC', tag: 'role:manager' }, roles)).toBe('manager');
  });

  it('role:anonymous means explicitly unauthenticated', () => {
    expect(inferRole({ testCaseUuid: 't2', name: 'Some TC', tag: 'role:anonymous' }, roles)).toBeNull();
  });

  it('an explicit tag wins even if the role is not in the known-roles list', () => {
    // resolveStorageState() will itself fail closed later if this role has
    // no local session — inferRole()'s job is just to surface the signal.
    expect(inferRole({ testCaseUuid: 't3', name: 'Some TC', tag: 'role:auditor' }, roles)).toBe('auditor');
  });

  it('falls back to a known role name appearing in the TC title', () => {
    expect(inferRole({ testCaseUuid: 't4', name: 'Admin can view settings page' }, roles)).toBe('admin');
  });

  it('"anonymous" in the title is an explicit unauthenticated signal', () => {
    expect(inferRole({ testCaseUuid: 't5', name: 'Anonymous user blocked from settings' }, roles)).toBeNull();
  });

  it('returns null, not an error, when there is no signal at all', () => {
    expect(inferRole({ testCaseUuid: 't6', name: 'Homepage loads correctly' }, roles)).toBeNull();
  });

  it('ignores a non-role tag', () => {
    expect(inferRole({ testCaseUuid: 't7', name: 'Homepage loads', tag: 'smoke' }, roles)).toBeNull();
  });

  it('an explicit tag takes precedence over a name match for a different role', () => {
    expect(inferRole({ testCaseUuid: 't8', name: 'Admin can view settings', tag: 'role:manager' }, roles)).toBe('manager');
  });

  it('matching is case-insensitive on the TC name', () => {
    expect(inferRole({ testCaseUuid: 't9', name: 'ADMIN can view settings' }, roles)).toBe('admin');
  });

  it('with no known roles configured, only explicit signals produce a role', () => {
    expect(inferRole({ testCaseUuid: 't10', name: 'Admin can view settings' }, [])).toBeNull();
    expect(inferRole({ testCaseUuid: 't11', name: 'Some TC', tag: 'role:manager' }, [])).toBe('manager');
  });
});

describe('isApiTest', () => {
  it('returns false when the TC has no tag at all', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC' })).toBe(false);
  });

  it('returns true for an exact "api" tag', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'api' })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'API' })).toBe(true);
  });

  it('matches within a real, comma-separated multi-tag string, regardless of position', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'Functional, api' })).toBe(true);
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'api, Appq_Auto' })).toBe(true);
  });

  it('does not match a tag that merely contains "api" as a substring', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'Appq_Auto' })).toBe(false);
  });

  it('returns false for an unrelated tag', () => {
    expect(isApiTest({ testCaseUuid: 't1', name: 'Some TC', tag: 'Functional' })).toBe(false);
  });
});

describe('parseScenarioTcList', () => {
  it('parses the real get_scenario text format (GetScenarioTool.php)', () => {
    const text = [
      'Scenario: Convert Phone field to mandatory in newsletter (AD-88)',
      'Project ID: 1349',
      'Tags: (none)',
      'Jira Issue: AD-88',
      'Sprint: (none)',
      '',
      'Test Cases:',
      '  1. Phone Number field appears on subscribe form with correct attributes (UUID: 2424-533acecf-306d-4f14-94df-b9bb5f9bed90)',
      '  2. Admin can view settings page (UUID: 2424-aaaa1111-1111-1111-1111-111111111111) [Tag: role:manager]',
      '  3. Anonymous user blocked from settings (UUID: 2424-bbbb2222-2222-2222-2222-222222222222) [Tag: role:anonymous]',
      '',
    ].join('\n');

    const tcs = parseScenarioTcList(text);

    expect(tcs).toHaveLength(3);
    expect(tcs[0]).toEqual({
      name: 'Phone Number field appears on subscribe form with correct attributes',
      testCaseUuid: '2424-533acecf-306d-4f14-94df-b9bb5f9bed90',
    });
    expect(tcs[1]).toEqual({
      name: 'Admin can view settings page',
      testCaseUuid: '2424-aaaa1111-1111-1111-1111-111111111111',
      tag: 'role:manager',
    });
    expect(tcs[2].tag).toBe('role:anonymous');
  });

  it('returns an empty array for a scenario with no test cases', () => {
    const text = 'Scenario: Empty (AD-1)\nProject ID: 1\nTags: (none)\nJira Issue: (none)\nSprint: (none)\n\nTest Cases:\n  No test cases\n';
    expect(parseScenarioTcList(text)).toEqual([]);
  });

  it('handles a TC with no tag', () => {
    const text = '  1. Untagged TC (UUID: 1-abc)\n';
    expect(parseScenarioTcList(text)).toEqual([{ name: 'Untagged TC', testCaseUuid: '1-abc' }]);
  });
});

describe('parseTestSetTcList', () => {
  it('parses the real get_test_set text format (GetTestSetTool.php) — TCs spanning multiple scenarios', () => {
    const text = [
      'Test Set: DailyPulse — Smoke',
      'ID: 1358',
      'Project ID: 1349',
      'Priority: Critical',
      'Test Cases: 3',
      '',
      '  1. Phone Number field renders correctly on subscribe form (UUID: 1540-8d01d9a5-b53f-4e8d-8e3c-c1b69adc26d6)',
      '     Scenario ID: 1540 | Tag: Functional',
      '  2. Submitting a query from the navbar inline search navigates to the search results page (UUID: 1356-de45003e-18c7-4cdb-8736-724ddab1102a)',
      '     Scenario ID: 1356 | Tag: functional',
      '  3. Navigating to an unknown URL shows the 404 page (UUID: 1355-469a8ed0-ee19-42e4-9043-5847be1c4d40)',
      '     Scenario ID: 1355',
      '',
    ].join('\n');

    const tcs = parseTestSetTcList(text);

    expect(tcs).toHaveLength(3);
    expect(tcs[0]).toEqual({
      name: 'Phone Number field renders correctly on subscribe form',
      testCaseUuid: '1540-8d01d9a5-b53f-4e8d-8e3c-c1b69adc26d6',
      tag: 'Functional',
    });
    expect(tcs[1].testCaseUuid).toBe('1356-de45003e-18c7-4cdb-8736-724ddab1102a');
  });

  it('handles a TC whose scenario line has no tag', () => {
    const text = ['  3. Navigating to an unknown URL shows the 404 page (UUID: 1355-469a8ed0-ee19-42e4-9043-5847be1c4d40)', '     Scenario ID: 1355', ''].join('\n');
    const tcs = parseTestSetTcList(text);
    expect(tcs).toEqual([{ name: 'Navigating to an unknown URL shows the 404 page', testCaseUuid: '1355-469a8ed0-ee19-42e4-9043-5847be1c4d40' }]);
  });

  it('returns an empty array when there are no test cases', () => {
    const text = 'Test Set: Empty\nID: 1\nProject ID: 1\nPriority: Low\nTest Cases: 0\n';
    expect(parseTestSetTcList(text)).toEqual([]);
  });

  it('does not need a "Tag:" segment to be present at all', () => {
    const text = '  1. X (UUID: 1-abc)\n     Scenario ID: 1\n';
    expect(parseTestSetTcList(text)[0].tag).toBeUndefined();
  });
});
