# 05: Live queue and progress in the Console

**What to build:**

- Prompts sent while a Run is in progress wait in a queue instead of being refused. Runs still go one at a time; parallel Runs come in 06.
- Each Player can have at most one waiting Prompt, and can send again as soon as theirs starts running.
- The Console shows, live over WebSocket:
  - the queue, with each waiting Prompt's nickname and text
  - the Run in progress and its progress events (files being edited)
  - each Run's outcome: Landed, failed or rejected, with the reason
- Run states follow the spec: waiting → running → landing → landed, or rejected.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A second Prompt from another Player waits in the queue and runs after the first one Lands
- [ ] A second waiting Prompt from the same Player is rejected with a clear message; once the first starts running, the Player can send again
- [ ] Console clients receive queue changes, Run state changes and progress events live
- [ ] A failed or rejected Run shows its reason in the Console
