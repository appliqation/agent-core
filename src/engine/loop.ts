// The generic think->act->observe loop. Workflow-agnostic: it knows nothing
// about any specific named workflow — it just executes whatever system
// prompt and tool palette it's given until the model stops calling tools,
// with a hard turn/call/time budget cap.

import type { LlmMessage, LlmToolDef, ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';
import { BudgetTracker } from './budget.js';

export interface LoopResult {
  report: string;
  turns: number;
  budgetExceeded: boolean;
}

export async function runLoop(args: {
  adapter: ProviderAdapter;
  system: string;
  seedMessage: string;
  tools: LlmToolDef[];
  dispatch: ToolDispatcher;
  budget: RunBudget;
  signal?: AbortSignal;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}): Promise<LoopResult> {
  const { adapter, system, tools, dispatch, budget, signal, onEvent } = args;
  const tracker = new BudgetTracker(budget);
  const messages: LlmMessage[] = [{ role: 'user', content: args.seedMessage }];

  // A cap being "exceeded" used to just append a note asking the model to
  // stop while still offering it the full tool list — a request, not an
  // enforcement, so a model that ignored it (or a turn already in flight)
  // could keep going past the cap. This is the same hard stop maxTurns
  // already used below: withhold tools entirely and force one final,
  // tools-free completion call — a cap the model is told about is not a cap
  // that's actually enforced until nothing past it can execute.
  const finalize = async (turns: number): Promise<LoopResult> => {
    messages.push({ role: 'user', content: 'Produce your final report now, without calling any tool.' });
    const final = await adapter.complete({ system, messages, tools: [], signal });
    return { report: final.text, turns, budgetExceeded: true };
  };

  for (let turn = 0; turn < budget.maxTurns; turn++) {
    if (signal?.aborted) throw new Error('Run aborted');

    const cap = tracker.exceeded();
    if (cap) {
      onEvent?.({ type: 'log', detail: `Budget cap reached: ${cap}. Requesting final report.` });
      return finalize(turn + 1);
    }

    const response = await adapter.complete({ system, messages, tools, signal });
    onEvent?.({ type: 'assistant', detail: response.text });
    if (response.usage) {
      onEvent?.({ type: 'usage', detail: response.usage });
      tracker.countUsage(response.usage);
    }

    if (response.toolCalls.length === 0) {
      return { report: response.text, turns: turn + 1, budgetExceeded: false };
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      if (signal?.aborted) throw new Error('Run aborted');
      tracker.countCall();
      if (call.name === 'browser_navigate') tracker.countPage();

      let result;
      try {
        result = await dispatch(call.name, call.arguments);
      } catch (err) {
        result = { ok: false, text: `Tool error: ${(err as Error).message}` };
      }
      onEvent?.({
        type: 'tool',
        detail: {
          name: call.name,
          args: call.arguments,
          result: result.text,
          images: result.images?.length ? result.images.length : undefined,
        },
      });
      messages.push({ role: 'tool', toolCallId: call.id, content: result.text, images: result.images });
    }
  }

  onEvent?.({ type: 'log', detail: 'Reached max turns; requesting final report.' });
  return finalize(budget.maxTurns);
}
