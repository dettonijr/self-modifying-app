# Spec: Tokens and cost per Prompt

**Status:** ready-for-agent

## Problem Statement

Players can't see what each Prompt cost. The only number is a game-wide "Spent $X of $10" with a spending cap that pauses the Console. On the host's Claude Max subscription that dollar cap doesn't correspond to real money, so it limits play for no real reason, while the interesting question — "how big was that Prompt?" — has no answer.

The cost figures are also inaccurate: cached input tokens are counted and priced as normal input, which overstates every cost, often by a lot, because Claude caches heavily.

## Solution

Every Prompt in the Prompts list and on its Run page shows one line:

**"1.2k (48k) tokens · ~$0.31"**

- the first number is the tokens that weren't cached (fresh input, cache writes and output)
- the number in brackets is the total, including cache reads
- "~$" is the estimated cost, pricing each kind of token at its own rate

The line covers everything the Prompt used, including conflict fixes, start-overs and restarts, and updates live while the Run is in progress. Prompts from before this change show "—".

The spending cap is removed completely: no game total, no pause, no `raise-cap` command, no cap setting. The per-Run time and token limits remain the safety net.

## User Stories

### Tokens and cost per Prompt

1. As a Player, I want each Prompt in the list to show how many tokens it used, so that I can see how big it was.
2. As a Player, I want to see how many of those tokens weren't cached, so that I can tell new work from reused context.
3. As a Player, I want the total including cached tokens in brackets, so that I see the whole picture in one line.
4. As a Player, I want an estimated cost next to the tokens, so that I can compare Prompts.
5. As a Player, I want the cost marked as an estimate with "~", so that I don't mistake it for a bill.
6. As a Player, I want numbers rounded with k and M, so that the line stays short and readable.
7. As a Player, I want the same line on the Run page, so that the details match the list.
8. As a Player, I want the numbers to update live while a Run is in progress, so that I can watch the cost grow.
9. As a Player, I want conflict fixes, start-overs and restarts included in a Prompt's numbers, so that they show what the Prompt really used.
10. As a Player, I want Replays and Rollbacks to show their own numbers, so that every change is accounted for.
11. As a Player, I want a Rollback that needed no Claude (a clean revert) to show zero tokens, so that it's clear it cost nothing.
12. As a Player, I want older Prompts without recorded usage to show "—", so that missing data isn't shown as zero.
13. As a Player, I want the numbers to survive a restart, so that they don't reset.
14. As the host, I want each kind of token priced at its own rate, so that the estimates are realistic.
15. As the host, I want Opus and Sonnet priced separately within one Prompt, so that an Opus Prompt fixed by Sonnet is costed correctly.

### Removing the spending cap

16. As a Player, I want no "Spent $X of $Y" header, so that the Console isn't cluttered with a meaningless total.
17. As a Player, I never want the Console paused for spending, so that play isn't blocked by a notional cap.
18. As a Player, I want Replay, Roll back and Send never disabled for spending, so that they always work.
19. As the host, I want queued Prompts to start as soon as a slot frees, with no spending hold, so that the queue keeps moving.
20. As the host, I want the cap's command and setting gone, so that there's nothing misleading left to configure.
21. As the host, I want the per-Run time and token limits kept, so that one runaway Run is still stopped.

## Implementation Decisions

- **Token usage gains cache fields.** The Agent's usage events report four counts: fresh input, cache reads, cache writes and output. The real Claude Agent fills them from the SDK's usage fields instead of folding cache tokens into input. The per-Run token limit keeps counting all four.
- **Per-model prices cover all four kinds**: input, output, cache read and cache write, per million tokens, kept in one place and looked up from Anthropic's current pricing for Sonnet 5.5 and Opus 5.5.
- **Each Run accumulates its own usage, per model**, from every usage event of its own Agent calls and its conflict-fix calls. It's saved with the Run, so it survives restarts and keeps accumulating when a resumed Run starts over. Runs recorded before this change have no usage and show "—".
- **The Run summary carries the Run's usage** (the four counts, and the cost computed from per-model usage), so the Prompts list can show it without fetching each Run. A live update is sent when a Run's usage changes.
- **Display:** "U (T) tokens · ~$C", where U = fresh input + cache writes + output, T = U + cache reads, rounded with k/M to at most one decimal (e.g. "850", "1.2k", "1.1M"), and C the estimated cost with two decimals (or "<$0.01" when above zero but below a cent). Shown on every Prompts list entry and on the Run page details, with no further breakdown.
- **The spending cap is removed:** the game total, the pause and its checks on Prompts, Replays and Rollbacks, holding queued Prompts while paused, the spending endpoint, the Console header, pause-disabled buttons, the `raise-cap` command, the cap setting and its files in the data folder. `docker-compose.yml`, the README and `DECISIONS.md` follow. The per-Run time and token limits stay.

## Testing Decisions

- **A good test checks external behaviour only**: what the Console API, the live WebSocket and the Console pages show.
- **Test surface:** the whole platform through `startTestPlatform()`, plus Playwright for the list and Run page. **Substitution:** the scripted `FakeAgent`, whose usage reports gain the cache fields. No new seams.
- **Scenarios:**
  - a Run's usage events add up into its summary and Run page line, with the right uncached and total numbers and cost
  - the line updates live while the Run is in progress
  - a conflict fix on Sonnet for an Opus Prompt is priced per model and included
  - usage survives a restart and keeps accumulating after a start-over
  - a clean-revert Rollback shows zero tokens; an older Run shows "—"
  - number formatting: below 1,000, k and M with one decimal, and the cost's two decimals / "<$0.01"
  - the real Claude Agent reports cache reads and writes separately (unit test on its usage conversion)
  - no spending header, no pause: Prompts beyond the old cap still run; Replay and Roll back are never disabled for spending; `raise-cap` no longer exists
- **Prior art:** the existing spending, Run page, Prompts list and Claude Agent usage tests.

## Out of Scope

- A per-kind or per-model breakdown table on the Run page.
- Any game-wide total or cap, including a token cap for the game.
- Real billing data from Anthropic.
- Changing the per-Run limits.

## Further Notes

- Builds on the Prompts list and Run page (`.scratch/prompts-list-and-run-page/`) and is implemented on the same integration branch, so one code review covers both.
- The cost is an estimate from list prices; on a Max subscription it isn't what the host pays.
