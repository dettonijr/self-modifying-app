# Parallel Runs in git worktrees, Landing one at a time

Several Prompts can be sent at once, and each Claude Run takes 30 seconds to 2 minutes, so a single queue would make Players wait too long. Each Run gets its own git worktree branched from `main`, and up to a configured number of Runs (default 3) work in parallel. Landing happens one Run at a time: rebase onto the current `main`, render check, fast-forward. A Run that conflicts goes to Claude for resolution, up to 2 attempts, then starts over once, then is rejected.

## Considered Options

- **One queue, one Run at a time**: no conflicts, but waits grow with the crowd. Rejected for game pace.
- **Batching waiting Prompts into one Run**: higher throughput, but blurs "your Prompt did this" and mixes contradictory Prompts. Kept as a possible later fallback.

## Consequences

Conflicts are expected, not exceptional. The Canvas `CLAUDE.md` keeps each feature in its own folder so that parallel Runs rarely touch the same files.
