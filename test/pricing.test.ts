import { describe, expect, it } from "vitest";
import { costOf } from "../src/pricing.ts";

describe("Pricing", () => {
  it("prices input and output tokens at each model's rate", () => {
    // Sonnet 5.5: $2 / $10 per million input / output tokens; Opus 5.5: $4 / $20.
    expect(costOf("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3, 9);
    expect(costOf("claude-opus-5-5", { inputTokens: 250_000, outputTokens: 50_000 })).toBeCloseTo(2, 9);
  });
});
