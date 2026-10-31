# 03: The live log

**What to build:** Each Run page shows a live, timestamped log of what Claude said and what the platform did.

- **Claude's messages:** the Agent interface gains a `message` event carrying a piece of Claude's text. The real Claude Agent emits Claude's text replies through it, and never tool calls, tool results or hidden reasoning. `FakeAgent` scripts can emit it too.
- **The platform's steps:** queued, started, rebasing, render check, each conflict-fix attempt, starting over, platform restarted, Landed, and rejected with the reason.
- Each entry has a time, a source (Claude or platform) and its text. The page shows them in order and appends new ones live while the Run is in progress.
- The log is saved in the Run store as it happens, with no size limit, and is complete after the Run finishes and after a restart. A Run resumed after a restart continues the same log after a "Platform restarted, starting over" line.
- The opt-in real-Claude smoke test checks that Claude's messages appear in the Run's log.

See spec: `.scratch/prompts-list-and-run-page/spec.md`.

**Blocked by:** 02

**Status:** resolved

- [ ] The log shows Claude's messages and the platform's steps in order, each with a timestamp
- [ ] New entries appear live on an open Run page
- [ ] No tool-call output appears in the log
- [ ] The full log is still there after the Run finishes and after a restart, with no length limit
- [ ] A Run resumed after a restart continues its log with a "Platform restarted" line
- [ ] A rejected Run's log ends with the rejection reason
- [ ] The real Claude Agent emits Claude's text as `message` events (unit-tested), and the opt-in smoke test checks they appear
