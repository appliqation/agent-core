import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMcpClient } from './mcpClient.js';

function jsonRpcOk(result: unknown, id = 1) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) } as Response;
}

function jsonRpcError(code: number, message: string, id = 1) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { code, message } }) } as Response;
}

function httpError(status: number, body = 'server error') {
  return { ok: false, status, text: async () => body, json: async () => ({}) } as Response;
}

function client() {
  // maxRetries: 0 — these tests aren't exercising retry behavior, and the
  // default retry count would otherwise make a "throws on HTTP 500" test
  // wait through real backoff delays for no reason. See the dedicated
  // "timeout and retry" describe block below for that behavior.
  return createMcpClient({ origin: 'https://appq.test', apiKey: 'test-api-key', maxRetries: 0 });
}

describe('callTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts a well-formed tools/call JSON-RPC request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await client().callTool('get_scenario', { scenario_id: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://appq.test/api/appq/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_scenario', arguments: { scenario_id: 1 } } });
  });

  it('joins multiple text content blocks with a newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] })),
    );
    const result = await client().callTool('get_scenario', {});
    expect(result.text).toBe('line one\nline two');
  });

  it('ok is true when isError is absent, false when isError is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'x' }] })));
    expect((await client().callTool('t', {})).ok).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'boom' }], isError: true })));
    expect((await client().callTool('t', {})).ok).toBe(false);
  });

  it('throws on a non-ok HTTP response, including the status and body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(500, 'internal error')));
    await expect(client().callTool('t', {})).rejects.toThrow(/HTTP 500.*internal error/s);
  });

  it('throws on a JSON-RPC error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcError(-32601, 'Method not found')));
    await expect(client().callTool('t', {})).rejects.toThrow(/-32601.*Method not found/s);
  });

  it('increments the request id across successive calls on the same client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();
    await c.callTool('t1', {});
    await c.callTool('t2', {});
    const id1 = JSON.parse(fetchMock.mock.calls[0][1].body).id;
    const id2 = JSON.parse(fetchMock.mock.calls[1][1].body).id;
    expect(id2).toBe(id1 + 1);
  });
});

describe('fetchPrompt', () => {
  it('joins multiple message texts with a blank line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRpcOk({
          messages: [
            { role: 'user', content: { type: 'text', text: 'Phase 0' } },
            { role: 'user', content: { type: 'text', text: 'Phase 1' } },
          ],
        }),
      ),
    );
    const text = await client().fetchPrompt('appq:runman', { project_id: 1 });
    expect(text).toBe('Phase 0\n\nPhase 1');
  });

  it('sends the prompt name and args via prompts/get', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await client().fetchPrompt('appq:runman', { project_id: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ method: 'prompts/get', params: { name: 'appq:runman', arguments: { project_id: 1 } } });
  });

  it('throws when the prompt has no text content at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ messages: [] })));
    await expect(client().fetchPrompt('appq:runman')).rejects.toThrow(/returned no text content/);
  });
});

describe('startWorkflow', () => {
  it('delegates to the start_workflow tool and returns its text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'workflow prose' }] })));
    const text = await client().startWorkflow('autotest', { run_id: 'r1' });
    expect(text).toBe('workflow prose');
  });

  it('throws with the tool\'s own error text when start_workflow fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'unknown workflow' }], isError: true })));
    await expect(client().startWorkflow('bogus')).rejects.toThrow(/unknown workflow/);
  });
});

describe('listTools', () => {
  it('returns the tools array from tools/list', async () => {
    const tools = [{ name: 'get_scenario', description: 'x', inputSchema: {} }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ tools })));
    expect(await client().listTools()).toEqual(tools);
  });
});

describe('timeout and retry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies AbortSignal.timeout so a hung origin cannot hang the call forever', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', timeoutMs: 5000, maxRetries: 0 });
    await c.callTool('t', {});
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a 500 and succeeds on the next attempt, never surfacing the failure to the caller', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(500))
      .mockResolvedValueOnce(jsonRpcOk({ content: [{ type: 'text', text: 'recovered' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    const resultPromise = c.callTool('t', {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.text).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 the same way as a 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(429, 'rate limited'))
      .mockResolvedValueOnce(jsonRpcOk({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    const resultPromise = c.callTool('t', {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network-level rejection (not just a bad HTTP status)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonRpcOk({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    const resultPromise = c.callTool('t', {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries and surfaces the last real failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(503, 'still down'));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    const resultPromise = c.callTool('t', {});
    const assertion = expect(resultPromise).rejects.toThrow(/HTTP 503.*still down/s);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry a non-retryable HTTP status (e.g. 400)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(400, 'bad request'));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    await expect(c.callTool('t', {})).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a JSON-RPC application-level error — retrying can\'t fix it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcError(-32601, 'Method not found'));
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    await expect(c.callTool('t', {})).rejects.toThrow(/Method not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries uploadScreenshot the same way as an RPC call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ upload_id: 'abc' }) });
    vi.stubGlobal('fetch', fetchMock);
    const c = createMcpClient({ origin: 'https://appq.test', apiKey: 'k', maxRetries: 2 });

    const uploadPromise = c.uploadScreenshot(Buffer.from([1]), 'label');
    await vi.runAllTimersAsync();
    const uploadId = await uploadPromise;
    expect(uploadId).toBe('abc');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('uploadScreenshot', () => {
  it('posts the PNG bytes with the correct whitelisted content type and label header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ upload_id: 'abc-123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const uploadId = await client().uploadScreenshot(Buffer.from([1, 2, 3]), 'autotest-step');

    expect(uploadId).toBe('abc-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://appq.test/api/appq/mcp/upload-screenshot');
    expect(init.headers).toMatchObject({
      'X-API-Key': 'test-api-key',
      'Content-Type': 'image/png', // never application/octet-stream — appq's endpoint 415s on that
      'X-Screenshot-Label': 'autotest-step',
    });
  });

  it('throws on a failed upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 415 }));
    await expect(client().uploadScreenshot(Buffer.from([1]), 'label')).rejects.toThrow(/HTTP 415/);
  });
});
