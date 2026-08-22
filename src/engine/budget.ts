import type { RunBudget } from '../types.js';

export class BudgetTracker {
  private calls = 0;
  private pages = 0;
  private totalTokens = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly budget: RunBudget) {}

  countCall(): void {
    this.calls += 1;
  }

  countPage(): void {
    this.pages += 1;
  }

  /** Accumulates one turn's real token usage — every field counts toward maxTotalTokens, cache included. */
  countUsage(usage?: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }): void {
    if (!usage) return;
    this.totalTokens += usage.inputTokens + usage.outputTokens + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  }

  /** Returns a human-readable reason if a cap has been exceeded, else null. */
  exceeded(): string | null {
    if (this.calls >= this.budget.maxCalls) return `${this.calls} tool calls (cap ${this.budget.maxCalls})`;
    if (this.pages >= this.budget.maxPages) return `${this.pages} page navigations (cap ${this.budget.maxPages})`;
    if (this.budget.maxTotalTokens && this.totalTokens >= this.budget.maxTotalTokens) {
      return `${this.totalTokens} total tokens (cap ${this.budget.maxTotalTokens})`;
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.budget.maxMillis) {
      return `${Math.round(elapsed / 1000)}s elapsed (cap ${Math.round(this.budget.maxMillis / 1000)}s)`;
    }
    return null;
  }

  state() {
    return { calls: this.calls, pages: this.pages, totalTokens: this.totalTokens, elapsedMillis: Date.now() - this.startedAt };
  }
}
