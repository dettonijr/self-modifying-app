# 08: Conflict handling

**What to build:** When a finished Run's rebase onto `main` conflicts, or its result fails the render check, the platform asks the Agent to fix it in the same worktree. The Agent gets:

- the conflict or failure
- the Run's own Prompt
- the Prompts of the commits it collided with

so both intentions are respected. Conflict resolution always uses Sonnet 5.5. There are up to 2 attempts. If both fail, the Run starts over once from scratch on the latest `main`. If that also fails, the Run is rejected and the Player is told their Prompt collided. The Run states `resolving` and `restarted` appear in the Console.

**Blocked by:** 06, 07

**Status:** resolved

- [ ] Conflicting Runs: when the fake Agent resolves the conflict, the second Run Lands with both changes
- [ ] The resolution request includes the Run's Prompt and the Prompts of the conflicting commits
- [ ] Two failed resolutions lead to one restart on the latest `main`, which can Land
- [ ] Failed resolutions plus a failed restart reject the Run with a "collided" message
- [ ] A render-check failure follows the same resolve → restart → reject path
- [ ] The Console shows the `resolving` and `restarted` states
