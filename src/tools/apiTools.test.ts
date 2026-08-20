import { describe, it, expect, vi } from 'vitest';
import { ApiRequestTools } from './apiTools.js';
import type { APIRequestContext } from 'playwright';

function fakeResponse(overrides: Partial<{ status: number; ok: boolean; headers: Record<string, string>; text: string }> = {}) {
  return {
    status: vi.fn().mockReturnValue(overrides.status ?? 200),
    ok: vi.fn().mockReturnValue(overrides.ok ?? true),
    headers: vi.fn().mockReturnValue(overrides.headers ?? { 'content-type': 'application/json' }),
    text: vi.fn().mockResolvedValue(overrides.text ?? '{"result":"ok"}'),
  };
}

function fakeContext(response: ReturnType<typeof fakeResponse>) {
  return { fetch: vi.fn().mockResolvedValue(response) } as unknown as APIRequestContext;
}

describe('ApiRequestTools', () => {
  describe('dispatch — unknown tool', () => {
    it('returns an explicit error for an unrecognized tool name', async () => {
      const tools = new ApiRequestTools(fakeContext(fakeResponse()));
      const result = await tools.dispatch('delete_everything', {});
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Unknown API tool/);
    });
  });

  describe('http_request — real execution', () => {
    it('sends the request and returns the real response as JSON', async () => {
      const response = fakeResponse({ status: 201, text: '{"id":42}' });
      const context = fakeContext(response);
      const tools = new ApiRequestTools(context);
      const result = await tools.dispatch('http_request', { method: 'post', url: '/api/users', body: { name: 'x' } });

      expect(context.fetch).toHaveBeenCalledWith('/api/users', {
        method: 'POST',
        headers: undefined,
        data: JSON.stringify({ name: 'x' }),
      });
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed).toMatchObject({ method: 'POST', url: '/api/users', status: 201, body: '{"id":42}' });
    });

    it('uppercases a lowercase method', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context);
      await tools.dispatch('http_request', { method: 'get', url: '/api/users' });
      expect(context.fetch).toHaveBeenCalledWith('/api/users', expect.objectContaining({ method: 'GET' }));
    });

    it('passes through custom headers', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context);
      await tools.dispatch('http_request', { method: 'GET', url: '/api/users', headers: { 'X-Trace': 'abc' } });
      expect(context.fetch).toHaveBeenCalledWith('/api/users', expect.objectContaining({ headers: { 'X-Trace': 'abc' } }));
    });

    it('omits data entirely when no body is given (not JSON.stringify(undefined))', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context);
      await tools.dispatch('http_request', { method: 'GET', url: '/api/users' });
      expect(context.fetch).toHaveBeenCalledWith('/api/users', expect.objectContaining({ data: undefined }));
    });

    it('reports a real failure (e.g. network error) as ok:false, never fabricating a response', async () => {
      const context = { fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as unknown as APIRequestContext;
      const tools = new ApiRequestTools(context);
      const result = await tools.dispatch('http_request', { method: 'GET', url: '/api/users' });
      expect(result.ok).toBe(false);
      expect(result.text).toContain('ECONNREFUSED');
    });

    it('records every real request in getRequestHistory', async () => {
      const context = fakeContext(fakeResponse({ status: 404, ok: false }));
      const tools = new ApiRequestTools(context);
      await tools.dispatch('http_request', { method: 'GET', url: '/api/missing' });
      const history = tools.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ method: 'GET', url: '/api/missing', status: 404, ok: false, dryRunSuppressed: false });
    });
  });

  describe('http_request — dry-run write-verb gating', () => {
    it('suppresses a POST request in dry-run mode, never calling the real context', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, true);
      const result = await tools.dispatch('http_request', { method: 'POST', url: '/api/users', body: { name: 'x' } });
      expect(context.fetch).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/suppressed/);
    });

    it('suppresses PUT/PATCH/DELETE the same way', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, true);
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        await tools.dispatch('http_request', { method, url: '/api/x' });
      }
      expect(context.fetch).not.toHaveBeenCalled();
    });

    it('does NOT suppress GET in dry-run mode — read-only requests are safe to actually send', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, true);
      const result = await tools.dispatch('http_request', { method: 'GET', url: '/api/users' });
      expect(context.fetch).toHaveBeenCalled();
      expect(result.text).not.toMatch(/suppressed/);
    });

    it('records a suppressed write as dryRunSuppressed:true in the history, not a real result', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, true);
      await tools.dispatch('http_request', { method: 'DELETE', url: '/api/users/1' });
      const history = tools.getRequestHistory();
      expect(history[0]).toMatchObject({ method: 'DELETE', status: null, dryRunSuppressed: true });
    });

    it('logs the suppressed request to stderr for review', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, true);
      await tools.dispatch('http_request', { method: 'POST', url: '/api/users', body: { name: 'x' } });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('POST /api/users'));
    });

    it('a real (non-dry-run) instance sends write-verb requests normally', async () => {
      const context = fakeContext(fakeResponse());
      const tools = new ApiRequestTools(context, false);
      const result = await tools.dispatch('http_request', { method: 'POST', url: '/api/users', body: { name: 'x' } });
      expect(context.fetch).toHaveBeenCalled();
      expect(result.text).not.toMatch(/suppressed/);
    });
  });
});
