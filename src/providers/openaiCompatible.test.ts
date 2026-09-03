import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
const { MockOpenAiCtor } = vi.hoisted(() => ({ MockOpenAiCtor: vi.fn() }));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(opts: unknown) {
      MockOpenAiCtor(opts);
    }
  },
}));

import { createOpenAiCompatibleAdapter } from './openaiCompatible.js';
import type { LlmMessage, LlmToolDef } from '../types.js';

function fakeResponse(overrides: Partial<{ message: unknown; usage: unknown }> = {}) {
  return {
    choices: [{ message: overrides.message ?? { content: 'hello', tool_calls: [] } }],
    usage: overrides.usage ?? { prompt_tokens: 100, completion_tokens: 20 },
  };
}

const cfg = { apiKey: 'key', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' };

describe('createOpenAiCompatibleAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    MockOpenAiCtor.mockReset();
    mockCreate.mockResolvedValue(fakeResponse());
  });

  it('constructs the OpenAI client with the given apiKey and baseURL', () => {
    createOpenAiCompatibleAdapter(cfg);
    expect(MockOpenAiCtor).toHaveBeenCalledWith({ apiKey: 'key', baseURL: 'https://api.deepseek.com' });
  });

  it('uses the default maxTokens (4096) when not specified', async () => {
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'deepseek-chat', max_tokens: 4096 });
  });

  it('passes a given maxTokens through', async () => {
    const adapter = createOpenAiCompatibleAdapter({ ...cfg, maxTokens: 2048 });
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
  });

  it('sends the system prompt as the first message, role system', async () => {
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'you are the validator', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[0]).toEqual({ role: 'system', content: 'you are the validator' });
  });

  it('converts tool defs to the nested {type:function, function:{...}} shape', async () => {
    const tools: LlmToolDef[] = [{ name: 'get_scenario', description: 'fetch a scenario', inputSchema: { type: 'object' } }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages: [], tools });
    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      { type: 'function', function: { name: 'get_scenario', description: 'fetch a scenario', parameters: { type: 'object' } } },
    ]);
  });

  it('converts a plain user message', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('converts an assistant message with a tool call into tool_calls on the assistant message', async () => {
    const messages: LlmMessage[] = [{ role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'get_scenario', arguments: { x: 1 } }] }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[1]).toEqual({
      role: 'assistant',
      content: 'checking',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_scenario', arguments: JSON.stringify({ x: 1 }) } }],
    });
  });

  it('sends content:null (not omitted, not empty string) for a tool-calls-only assistant turn', async () => {
    const messages: LlmMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[1].content).toBeNull();
  });

  it('omits tool_calls entirely for an assistant turn with no tool calls', async () => {
    const messages: LlmMessage[] = [{ role: 'assistant', content: 'just text' }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[1]).toEqual({ role: 'assistant', content: 'just text' });
  });

  it('converts a tool message with no images to a plain role:tool message', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'scenario data', toolCallId: 'c1' }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'scenario data' });
  });

  it('adds a synthetic image_url follow-up user message when the tool result has images', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'screenshot attached', toolCallId: 'c1', images: [{ data: 'b64data', mimeType: 'image/png' }] }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const msgs = mockCreate.mock.calls[0][0].messages;
    expect(msgs).toHaveLength(3); // system + tool + follow-up
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'screenshot attached' });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,b64data' } }] });
  });

  it('does not add a follow-up message for a tool result with no images', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'no images here', toolCallId: 'c1' }];
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].messages).toHaveLength(2);
  });

  it('passes the abort signal through to the SDK call', async () => {
    const controller = new AbortController();
    const adapter = createOpenAiCompatibleAdapter(cfg);
    await adapter.complete({ system: 'sys', messages: [], tools: [], signal: controller.signal });
    expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('extracts text and tool_calls from the response message', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse({
        message: { content: 'Part one.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_scenario', arguments: JSON.stringify({ scenario_id: 1 }) } }] },
      }),
    );
    const adapter = createOpenAiCompatibleAdapter(cfg);
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.text).toBe('Part one.');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'get_scenario', arguments: { scenario_id: 1 } }]);
  });

  it('handles a tool call with empty/missing arguments as an empty object rather than throwing', async () => {
    mockCreate.mockResolvedValue(fakeResponse({ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '' } }] } }));
    const adapter = createOpenAiCompatibleAdapter(cfg);
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('maps usage, cacheReadTokens undefined when prompt_cache_hit_tokens is absent', async () => {
    mockCreate.mockResolvedValue(fakeResponse({ usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    const adapter = createOpenAiCompatibleAdapter(cfg);
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10, cacheReadTokens: undefined });
  });

  it('maps DeepSeek-specific prompt_cache_hit_tokens to cacheReadTokens when present', async () => {
    mockCreate.mockResolvedValue(fakeResponse({ usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 30 } }));
    const adapter = createOpenAiCompatibleAdapter(cfg);
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage?.cacheReadTokens).toBe(30);
  });

  it('leaves usage undefined when the response has none', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '' } }], usage: undefined });
    const adapter = createOpenAiCompatibleAdapter(cfg);
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toBeUndefined();
  });

  it('wraps a thrown SDK error with the provider label', async () => {
    mockCreate.mockRejectedValue(new Error('rate limited'));
    const adapter = createOpenAiCompatibleAdapter({ ...cfg, providerLabel: 'DeepSeek' });
    await expect(adapter.complete({ system: 'sys', messages: [], tools: [] })).rejects.toThrow('DeepSeek completion failed: rate limited');
  });
});
