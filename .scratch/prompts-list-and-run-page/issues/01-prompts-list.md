# 01: The Prompts list replaces Queue, Runs and History

**What to build:** The Console shows one list, headed "Prompts", instead of the Queue, Runs and History lists. Every Run appears exactly once, newest first, whatever its kind (Prompt, Replay or Rollback) or state, and its entry updates in place as it goes from waiting to running (including resolving and starting over) to Landed or rejected.

Each entry is a compact row:

- state badge
- nickname
- the Prompt, shortened if long
- model
- time
- outcome: "Landed", or the rejection reason

Replays and Rollbacks are marked distinctly, as today.

Every Run stays in the list forever, rejected ones included. The platform stops limiting what it reloads and serves to the latest 20, and the list is unchanged after a restart. Landed changes on `main` that have no Run record (from before Runs were saved) still appear as Landed entries.

Landed entries have a **Replay** button, which confirms with "Yes, replay" or "Cancel", and the existing **Roll back** button. Rejected, waiting and running entries have neither. Both are disabled while the Console is paused.

The Console's live snapshot carries summaries of every Run; updates change individual entries. The Console no longer uses the History endpoint.

See spec: `.scratch/prompts-list-and-run-page/spec.md`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The Console has a single "Prompts" list and no separate Queue, Runs or History lists
- [ ] A Prompt appears once and its entry moves waiting → running → Landed in place
- [ ] A rejected Run stays in the list with its reason
- [ ] More than 20 finished Runs are all listed, including after a restart
- [ ] Landed changes without a Run record still appear as Landed entries
- [ ] Replay and Roll back appear only on Landed entries; Replay confirms with "Yes, replay" / "Cancel"; both are disabled while paused
- [ ] The one-waiting-Prompt rule and existing Replay/Rollback behaviour are unchanged
