# 01: Remove the spending cap

**What to build:** The game-wide spending cap goes away completely. There's no "Spent $X of $Y" header, the Console is never paused for spending, and Send, Replay and Roll back are never disabled for it. Queued Prompts start as soon as a slot frees, with no spending hold. The `raise-cap` command, the cap setting (`SPENDING_CAP_USD`) and its data files are gone, along with the spending endpoint and the pause checks on Prompts, Replays and Rollbacks. The per-Run time and token limits stay.

`docker-compose.yml` and the README are updated. Leave per-model pricing in place for ticket 02, which will price each Run's own usage.

See spec: `.scratch/prompt-tokens-and-cost/spec.md`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The Console shows no spending total and never shows a paused state
- [ ] Prompts keep running however much has been used; queued Prompts are never held for spending
- [ ] Send, Replay and Roll back are never disabled for spending
- [ ] The spending endpoint, `raise-cap` and `SPENDING_CAP_USD` no longer exist, and the README and `docker-compose.yml` don't mention them
- [ ] The per-Run time and token limits still stop a runaway Run
