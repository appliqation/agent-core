// Reads the Playwright storageState a project/role's authenticated session
// lives at, computed by @appliqation/automation-sdk's setupAuth() — the same
// pure path function the customer's own Playwright config, the appq-auth-setup
// CLI, and Appliqation's hosted executor all already agree on. A consuming
// agent never performs login itself and never handles credentials: only the
// resulting session (cookies/localStorage) is ever read, directly from disk,
// never through an LLM tool call.

import { existsSync, readFileSync } from 'node:fs';
import { setupAuth } from '@appliqation/automation-sdk/utils';
import type { BrowserContextOptions } from 'playwright';

export function resolveStorageState(projectId: number, role: string): NonNullable<BrowserContextOptions['storageState']> {
  const path = setupAuth({ project_id: projectId, role });
  if (!existsSync(path)) {
    throw new Error(
      `No authenticated session found for project ${projectId}, role "${role}" (expected at ${path}). ` +
        `Run \`npx appq-auth-setup --project-id ${projectId} --role ${role}\` first ` +
        `(needs APPQ_PROJECT_${projectId}_${role.toUpperCase()}_USERNAME/_PASSWORD and APPLIQATION_SUT_BASE_URL set).`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * BYO-credential resolution for API testing — same posture as
 * resolveStorageState()'s UI auth: read from the consuming agent's own
 * .env, never performed or handled beyond that single read, never exposed
 * to the model as a value (the caller injects the returned header directly
 * into an APIRequestContext's extraHTTPHeaders, once, at construction).
 *
 * APPQ_PROJECT_<id>_<ROLE>_API_KEY holds the credential value.
 * APPQ_PROJECT_<id>_<ROLE>_API_HEADER_NAME optionally overrides the header
 * name (defaults to "Authorization", with the value sent as "Bearer
 * <key>" — set API_HEADER_NAME to send the raw key as-is under a different
 * header, e.g. "X-Api-Key").
 */
export interface ApiAuthHeader {
  name: string;
  value: string;
}

export function resolveApiAuth(projectId: number, role: string): ApiAuthHeader | undefined {
  const upperRole = role.toUpperCase();
  const apiKey = process.env[`APPQ_PROJECT_${projectId}_${upperRole}_API_KEY`];
  if (!apiKey) return undefined;

  const headerName = process.env[`APPQ_PROJECT_${projectId}_${upperRole}_API_HEADER_NAME`];
  if (headerName) return { name: headerName, value: apiKey };
  return { name: 'Authorization', value: `Bearer ${apiKey}` };
}
