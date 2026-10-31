# 13: Surviving restarts

**What to build:** The queue and Run records are saved in SQLite. When the platform restarts, waiting Prompts are still there, in order, and Runs that were in progress start again from scratch on the latest `main`. Leftover worktrees from interrupted Runs are cleaned up. History and the Canvas already live in git, so they need nothing extra.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] After a restart, waiting Prompts are still queued in the same order
- [ ] Runs that were in progress before the restart start again on the latest `main` and can Land
- [ ] Leftover worktrees from before the restart are removed
- [ ] The one-waiting-Prompt-per-Player rule still holds after a restart
