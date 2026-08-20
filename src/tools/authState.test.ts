import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// setupAuth() itself is the real SDK's pure path-computation function —
// already verified separately against the real ~/.appq-auth/ convention.
// Mocked here only so these tests read/write a throwaway temp directory
// instead of touching a real user's actual session directory.
const mockSetupAuth = vi.fn();
vi.mock('@appliqation/automation-sdk/utils', () => ({
  setupAuth: (...args: unknown[]) => mockSetupAuth(...args),
}));

describe('resolveStorageState', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authstate-test-'));
    path = join(dir, 'project-1349-manager.json');
    mockSetupAuth.mockReturnValue(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls setupAuth with the project/role it was given', async () => {
    const { resolveStorageState } = await import('./authState.js');
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    resolveStorageState(1349, 'manager');
    expect(mockSetupAuth).toHaveBeenCalledWith({ project_id: 1349, role: 'manager' });
  });

  it('reads and parses an existing storageState file', async () => {
    const { resolveStorageState } = await import('./authState.js');
    const fakeState = {
      cookies: [{ name: 'session', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [],
    };
    writeFileSync(path, JSON.stringify(fakeState));
    const result = resolveStorageState(1349, 'manager');
    expect(result).toEqual(fakeState);
  });

  it('throws a fail-closed, actionable error when no session file exists', async () => {
    const { resolveStorageState } = await import('./authState.js');
    // Deliberately do not write the file.
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /No authenticated session found for project 1349, role "manager"/,
    );
  });

  it('the missing-session error names the exact prerequisite command', async () => {
    const { resolveStorageState } = await import('./authState.js');
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /npx appq-auth-setup --project-id 1349 --role manager/,
    );
  });

  it('the missing-session error names the exact env vars needed', async () => {
    const { resolveStorageState } = await import('./authState.js');
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /APPQ_PROJECT_1349_MANAGER_USERNAME.*APPLIQATION_SUT_BASE_URL/s,
    );
  });
});

describe('resolveApiAuth', () => {
  const ENV_KEYS = ['APPQ_PROJECT_1349_MANAGER_API_KEY', 'APPQ_PROJECT_1349_MANAGER_API_HEADER_NAME'];

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('returns undefined when no API key is configured for this project/role', async () => {
    const { resolveApiAuth } = await import('./authState.js');
    expect(resolveApiAuth(1349, 'manager')).toBeUndefined();
  });

  it('defaults to an Authorization: Bearer header when only the key is set', async () => {
    process.env.APPQ_PROJECT_1349_MANAGER_API_KEY = 'secret-token';
    const { resolveApiAuth } = await import('./authState.js');
    expect(resolveApiAuth(1349, 'manager')).toEqual({ name: 'Authorization', value: 'Bearer secret-token' });
  });

  it('uses a custom header name, sending the raw key, when API_HEADER_NAME is set', async () => {
    process.env.APPQ_PROJECT_1349_MANAGER_API_KEY = 'secret-token';
    process.env.APPQ_PROJECT_1349_MANAGER_API_HEADER_NAME = 'X-Api-Key';
    const { resolveApiAuth } = await import('./authState.js');
    expect(resolveApiAuth(1349, 'manager')).toEqual({ name: 'X-Api-Key', value: 'secret-token' });
  });

  it('is scoped per role — a different role with no key configured gets undefined', async () => {
    process.env.APPQ_PROJECT_1349_MANAGER_API_KEY = 'secret-token';
    const { resolveApiAuth } = await import('./authState.js');
    expect(resolveApiAuth(1349, 'admin')).toBeUndefined();
  });
});
