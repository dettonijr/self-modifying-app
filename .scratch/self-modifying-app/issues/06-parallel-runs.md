# 06: Parallel Runs, Landing one at a time

**What to build:**

- Up to N Runs go at once, each in its own worktree. N defaults to 3 and is a single setting.
- Extra Prompts wait in the queue and start as Runs finish.
- Finished Runs Land one at a time, in the order they finish. Each Run's branch is rebased onto the current `main` before `main` is fast-forwarded, so a Run always builds on everything that Landed before it.
- In this ticket, a rebase conflict simply rejects the Run; conflict handling comes in 08.

**Blocked by:** 05

**Status:** resolved

- [ ] With the limit at 3, a 4th Prompt waits, and starts when one Run finishes
- [ ] Two parallel Runs editing different features both Land, and the final Canvas contains both changes. The test holds one fake Agent until the other Run has Landed.
- [ ] Changes Land one at a time; `main` never moves backwards or loses a change that Landed
- [ ] A conflicting rebase rejects the Run and leaves `main` unchanged
- [ ] The parallel Run limit can be changed through configuration
