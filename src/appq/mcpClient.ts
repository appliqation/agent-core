// JSON-RPC client for appq's MCP server (POST /api/appq/mcp). A factory, not
// a module-level singleton — each consuming agent has its own .env/config
// shape, so origin/apiKey are supplied by the caller rather than read from a
// shared global.

export interface McpClientOptions {
  origin: string;
  apiKey: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpMessage {
  role: string;
  content: McpTextContent | { type: string; [k: string]: unknown };
}

export interface ToolCallOutcome {
  ok: boolean;
  text: string;
  raw?: unknown;
}

export interface McpClient {
  /** Fetches a named appq workflow's prose via the standard MCP `prompts/get` method. */
  fetchPrompt(name: string, args?: Record<string, unknown>): Promise<string>;
  /**
   * Fetches a named workflow via the `start_workflow` tool instead of
   * `prompts/get`. Functionally identical content (both terminate in
   * McpPromptRegistry::buildMessages() server-side) — this path additionally
   * carries the directive prefix appq prepends for non-slash-command clients.
   * Prefer fetchPrompt() unless you specifically want that directive framing.
   */
  startWorkflow(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Generic `tools/call` — the one entry point every appq MCP tool goes through. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  /**
   * Claims a locally-captured screenshot for attachment (create_defect's
   * screenshot_upload_id, or submit_execution_evidence's), via appq's
   * two-step upload flow: POST the blob, get an upload_id back.
   *
   * Content-Type MUST be one appq's endpoint whitelists (image/png, jpeg,
   * gif, webp) — it validates both the header and the actual magic bytes
   * against it and rejects anything else with 415. application/octet-stream
   * (a very natural first guess for "raw binary") fails this every time.
   */
  uploadScreenshot(pngBuffer: Buffer, label: string): Promise<string>;
}

export function createMcpClient(opts: McpClientOptions): McpClient {
  let requestId = 0;

  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++requestId;
    const res = await fetch(`${opts.origin}/api/appq/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': opts.apiKey,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    if (!res.ok) {
      throw new Error(`appq MCP HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`appq MCP error ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === undefined) {
      throw new Error('appq MCP response had no result and no error');
    }
    return body.result;
  }

  const client: McpClient = {
    async fetchPrompt(name, args = {}) {
      const result = await rpc<{ messages: McpMessage[] }>('prompts/get', { name, arguments: args });
      const text = result.messages
        .map((m) => (m.content.type === 'text' ? (m.content as McpTextContent).text : ''))
        .filter(Boolean)
        .join('\n\n');
      if (!text) throw new Error(`appq prompt "${name}" returned no text content`);
      return text;
    },

    async startWorkflow(name, args = {}) {
      const result = await client.callTool('start_workflow', { name, arguments: args });
      if (!result.ok) throw new Error(`start_workflow "${name}" failed: ${result.text}`);
      return result.text;
    },

    async callTool(name, args) {
      const result = await rpc<{ content: McpTextContent[]; isError?: boolean }>('tools/call', {
        name,
        arguments: args,
      });
      const text = result.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
      return { ok: !result.isError, text, raw: result };
    },

    async listTools() {
      const result = await rpc<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>(
        'tools/list',
        {},
      );
      return result.tools;
    },

    async uploadScreenshot(pngBuffer, label) {
      const res = await fetch(`${opts.origin}/api/appq/mcp/upload-screenshot`, {
        method: 'POST',
        headers: {
          'X-API-Key': opts.apiKey,
          'Content-Type': 'image/png',
          'X-Screenshot-Label': label,
        },
        body: new Uint8Array(pngBuffer),
      });
      if (!res.ok) throw new Error(`screenshot upload failed: HTTP ${res.status}`);
      const body = (await res.json()) as { upload_id: string };
      return body.upload_id;
    },
  };

  return client;
}
