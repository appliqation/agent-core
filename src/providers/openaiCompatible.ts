import OpenAI from 'openai';
import type { LlmCompleteResult, LlmMessage, ProviderAdapter } from '../types.js';

// A generic adapter for any provider exposing an OpenAI Chat Completions-shaped
// API — DeepSeek and Zhipu's GLM both do, via the `openai` SDK pointed at a
// different baseURL. Deliberately NOT a wrapper around openai.ts: that file
// talks to OpenAI's newer Responses API (client.responses.create), which
// neither DeepSeek nor GLM implement — only the older Chat Completions
// surface (client.chat.completions.create), a materially different wire
// format (system role lives in the messages array, not a separate
// instructions field; tool defs are nested {type:'function', function:{...}}
// rather than flat; tool calls round-trip via `tool_calls`/`role:'tool'`
// messages keyed by tool_call_id).

function toChatCompletionMessages(system: string, messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).map(
        (call): OpenAI.Chat.ChatCompletionMessageToolCall => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }),
      );
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
      // Chat Completions' tool-role messages are text-only, same limitation
      // as the Responses API — see openai.ts's identical workaround. A bare
      // image_url part isn't valid inside a tool message, so it goes in a
      // synthetic follow-up user turn instead.
      if (m.images?.length) {
        out.push({
          role: 'user',
          content: m.images.map(
            (img): OpenAI.Chat.ChatCompletionContentPartImage => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            }),
          ),
        });
      }
    }
  }
  return out;
}

export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens?: number;
  /** Only used in error messages, e.g. 'DeepSeek'/'GLM' — no behavioral effect. */
  providerLabel?: string;
}

export function createOpenAiCompatibleAdapter(config: OpenAiCompatibleConfig): ProviderAdapter {
  const { apiKey, baseURL, model, maxTokens = 4096, providerLabel = baseURL } = config;
  const client = new OpenAI({ apiKey, baseURL });

  return {
    async complete({ system, messages, tools, signal }): Promise<LlmCompleteResult> {
      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await client.chat.completions.create(
          {
            model,
            max_tokens: maxTokens,
            messages: toChatCompletionMessages(system, messages),
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          },
          { signal },
        );
      } catch (err) {
        throw new Error(`${providerLabel} completion failed: ${(err as Error).message}`);
      }

      const message = response.choices[0]?.message;
      const toolCalls: LlmCompleteResult['toolCalls'] = (message?.tool_calls ?? [])
        .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        }));

      // prompt_cache_hit_tokens is a real DeepSeek response field, not part
      // of the base OpenAI usage type — read it defensively via an index
      // signature rather than widening the shared type for one provider's
      // extension. Left undefined (never a fabricated 0) for providers that
      // don't send it, matching cost.ts's own "undefined means unknown, not
      // zero" convention.
      const usageRaw = response.usage as (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number }) | undefined;

      return {
        text: message?.content ?? '',
        toolCalls,
        usage: usageRaw
          ? {
              inputTokens: usageRaw.prompt_tokens,
              outputTokens: usageRaw.completion_tokens,
              cacheReadTokens: usageRaw.prompt_cache_hit_tokens,
            }
          : undefined,
      };
    },
  };
}
