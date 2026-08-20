// The http_request tool palette — the API-testing counterpart to
// browserTools.ts's browser_* tools. Structurally parallel on purpose: one
// tool, backed by a real Playwright APIRequestContext (already a dependency
// via the `playwright` package — no new one added for this), returning the
// real status/headers/body as the tool result. Same "never fabricate, only
// report what actually happened" discipline as every other tool in this
// family.
//
// Write-verb gating (POST/PUT/PATCH/DELETE) is dry-run-aware by
// construction, not bolted on after — this is the one place that knows a
// request is about to have a real side effect, the same reasoning behind
// browserTools.ts's destructive-action gate on browser_click.

import type { APIRequestContext } from 'playwright';
import type { LlmToolDef, ToolResult } from '../types.js';

const WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const API_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'http_request',
    description:
      'Send a real HTTP request and return the real response (status, headers, body, duration). Use this for ' +
      'every step of an API test case — no browser is offered for these. Write-verb requests ' +
      '(POST/PUT/PATCH/DELETE) are suppressed and logged instead of sent when running in dry-run mode.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method, e.g. GET, POST, PUT, PATCH, DELETE.' },
        url: { type: 'string', description: 'Absolute URL, or a path relative to the configured base URL.' },
        headers: { type: 'object', description: 'Optional extra request headers.' },
        body: { description: 'Optional request body — a JSON-serializable value, sent as the JSON request body.' },
      },
      required: ['method', 'url'],
    },
  },
];

export interface ApiRequestRecord {
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  dryRunSuppressed: boolean;
  timestamp: number;
}

/** Wraps a live Playwright APIRequestContext as an http_request tool dispatcher. */
export class ApiRequestTools {
  private readonly requestHistory: ApiRequestRecord[] = [];

  constructor(
    private readonly context: APIRequestContext,
    private readonly dryRun: boolean = false,
  ) {}

  getRequestHistory(): ApiRequestRecord[] {
    return [...this.requestHistory];
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== 'http_request') return { ok: false, text: `Unknown API tool "${name}"` };

    const method = String(args.method ?? 'GET').toUpperCase();
    const url = String(args.url ?? '');
    const headers = (args.headers as Record<string, string> | undefined) ?? undefined;
    const body = args.body;

    if (this.dryRun && WRITE_VERBS.has(method)) {
      this.requestHistory.push({ method, url, status: null, ok: true, dryRunSuppressed: true, timestamp: Date.now() });
      console.error(`[dry-run] would send ${method} ${url} with body: ${JSON.stringify(body)}`);
      return {
        ok: true,
        text: `[dry-run] ${method} ${url} suppressed — no request was sent. Args were logged for review.`,
      };
    }

    const startedAt = Date.now();
    try {
      const response = await this.context.fetch(url, {
        method,
        headers,
        data: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const durationMs = Date.now() - startedAt;
      const status = response.status();
      const responseHeaders = response.headers();
      const responseBodyText = await response.text().catch(() => '');
      const ok = response.ok();
      this.requestHistory.push({ method, url, status, ok, dryRunSuppressed: false, timestamp: Date.now() });

      const result = { method, url, status, headers: responseHeaders, body: responseBodyText, duration_ms: durationMs };
      const text = JSON.stringify(result);
      return { ok: true, text: text.length > 20_000 ? `${text.slice(0, 20_000)}... (truncated)` : text };
    } catch (err) {
      this.requestHistory.push({ method, url, status: null, ok: false, dryRunSuppressed: false, timestamp: Date.now() });
      return { ok: false, text: `Request failed: ${(err as Error).message}` };
    }
  }
}
