import type { Model, TokenUsage } from "./agent.ts";

/**
 * US dollars per million tokens, Anthropic first-party API rates (checked
 * 2026-10-31). The only place prices live: update here when they change.
 */
export const PRICES: Record<Model, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
};

export function costOf(model: Model, usage: TokenUsage): number {
  const price = PRICES[model];
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}
