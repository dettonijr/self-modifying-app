# 01: Thinking and tool calls in the live log

**What to build:** The Run page's live log also shows Claude's thinking and its tool calls, alongside the existing platform steps and Claude's messages.

- **Thinking:** Claude's raw thinking is never returned by the API, so the real Claude Agent asks for **thinking summaries** (adaptive thinking with `display: "summarized"`) and emits each summary as a new kind of log entry, `thinking`. On the page, thinking entries are labelled "thinking", shown dimmer than Claude's messages, and collapsed to their first line when longer, with a click to expand. Redacted or empty thinking is skipped.
- **Tool calls:** each tool call becomes one short `tool` entry with the tool and its target, never its output. For example: "Read features/snow/index.js", "Edit index.html", "Write features/rain/rain.js", "Grep 'snow' in features/", "Glob features/**/*.css". Paths are relative to the worktree. A call refused by the confinement shows the reason, e.g. "Refused: Read /etc/hostname (outside the Canvas)".
- **Filters:** the log has toggle chips at the top, "Platform · Claude · Thinking · Tools", all on by default. The choice is remembered on the device and applies to live entries too.
- **Older Runs** keep the entries they have; nothing is added after the fact.

Log entries keep the shape `{time, source, text}`, with `source` gaining `thinking` and `tool`. They're saved like other entries (no limit) and sent live the same way. `FakeAgent` scripts can emit thinking and tool-call events. Everything else about the log stays the same: timestamps, ordering, restart continuity, and the de-duplication when a fetch races a live message.

Supersedes the earlier decision "no tool-call output in the log" (user, 2026-10-31); tool *output* still stays out.

See `DECISIONS.md` ("Run log", "The real Claude Agent", "Look and feel").

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The real Claude Agent requests summarized thinking and emits each summary as a `thinking` entry; redacted/empty thinking is skipped (unit-tested on its message conversion)
- [ ] Each tool call is one `tool` entry with tool name and worktree-relative target, never its output (unit-tested for Read, Write, Edit, Glob, Grep)
- [ ] A call refused by the confinement appears as "Refused: … (reason)"
- [ ] On the Run page, thinking entries are labelled, dimmer, and collapsed to their first line with click-to-expand
- [ ] Filter chips Platform · Claude · Thinking · Tools, all on by default, hide and show entries including live ones, and the choice survives a reload
- [ ] Thinking and tool entries are saved, survive a restart, and appear live
- [ ] Colours come only from the palette; chips and expanders meet the 44px tap-target and contrast rules on phones
- [ ] The opt-in real-Claude smoke test checks that at least one tool entry appears in the log
