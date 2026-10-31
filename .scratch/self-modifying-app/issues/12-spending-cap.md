# 12: Spending cap

**What to build:** The platform records the token usage the Agent reports for every Run, conflict resolution included, and converts it to cost using per-model prices. The Console shows the running total to everyone. When the total reaches the cap, set by configuration, the Console pauses: new Prompts, Replays and Rollbacks are refused with a clear message. Runs already in progress finish. The host can raise the cap with a command-line command while the platform is running, which resumes the Console. The total survives restarts.

**Blocked by:** 02

**Status:** resolved

- [ ] Token usage reported by the fake Agent turns into the correct cost for each model
- [ ] The Console shows the running total live
- [ ] Reaching the cap pauses the Console and refuses new Prompts with a message
- [ ] Raising the cap from the command line resumes the Console without a restart
- [ ] The running total persists across restarts
