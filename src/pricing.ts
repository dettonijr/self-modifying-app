import type { Model, TokenUsage } from "./agent.ts";

/**
 * US dollars per million tokens of each kind, Anthropic first-party API rates
 * (checked 2026-10-31). Cache writes are at the 5-minute TTL rate (1.25×
 * input), which is what Claude Code uses. The only place prices live: update
 * here when they change.
 */
export const PRICES: Record<Model, { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
};

/** The estimated cost in US dollars of `usage` on `model`. */
export function costOf(model: Model, usage: TokenUsage): number {
  const price = PRICES[model];
  return (
    usage.inputTokens * price.inputPerMTok +
    usage.outputTokens * price.outputPerMTok +
    (usage.cacheReadTokens ?? 0) * price.cacheReadPerMTok +
    (usage.cacheWriteTokens ?? 0) * price.cacheWritePerMTok
  ) / 1_000_000;
}
