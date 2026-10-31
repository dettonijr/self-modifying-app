# 02: Tokens and cost per Prompt

**What to build:** Every Prompts list entry and Run page shows one line, "**U (T) tokens · ~$C**", e.g. "1.2k (48k) tokens · ~$0.31":

- **U** = fresh input + cache writes + output (the tokens that weren't cached)
- **T** = U + cache reads (the total)
- numbers rounded with k/M to at most one decimal ("850", "1.2k", "1.1M")
- **C** = estimated cost with two decimals, or "<$0.01" when above zero but under a cent

How it works:

- **Usage gains cache fields.** The Agent's usage events report fresh input, cache reads, cache writes and output separately. The real Claude Agent fills them from the SDK's fields instead of folding cache tokens into input. The per-Run token limit still counts all four.
- **Prices cover all four kinds** for Sonnet 5.5 and Opus 5.5, in one place, from Anthropic's current pricing (use the claude-api skill).
- **Each Run accumulates its own usage per model** from its Agent calls and conflict-fix calls, saved with the Run so it survives restarts and keeps accumulating after a start-over.
- **The Run summary carries the usage and cost**, so the list needs no extra fetches, and a live update goes out whenever a Run's usage changes, so the line updates live in the list and on an open Run page.
- Replays and Rollbacks show their own numbers; a clean-revert Rollback shows "0 (0) tokens · ~$0.00"; Runs from before this change show "—".

See spec: `.scratch/prompt-tokens-and-cost/spec.md`.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A Run's usage adds up into its list entry and Run page line with correct U, T and cost
- [ ] The line updates live while the Run is in progress, in the list and on the Run page
- [ ] A Sonnet conflict fix on an Opus Prompt is included and priced per model
- [ ] Usage survives a restart and keeps accumulating after a start-over
- [ ] A clean-revert Rollback shows zero; an older Run shows "—"
- [ ] Formatting covers under 1,000, k, M, two-decimal cost and "<$0.01"
- [ ] The real Claude Agent reports cache reads and writes separately (unit test)
