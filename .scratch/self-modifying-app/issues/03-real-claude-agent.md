# 03: The real Claude Agent

**What to build:** Replace the fake Agent in the running platform with a real implementation of the Agent interface, using the Claude Agent SDK. The fake stays for tests.

The real Agent:

- edits files in the Run's worktree using the model the Player chose
- can only use file-editing tools, confined to that worktree, with no shell and no network access
- respects per-Run time and token caps
- reports progress events (files being edited), token usage and success or failure through the Agent interface

The Anthropic API key comes from an environment variable and is never written to the Canvas or shown to Players. Claude follows the Canvas `CLAUDE.md` conventions.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] With an API key set, a real Prompt from the Console changes the Canvas and Lands
- [ ] The Agent can't run shell commands, use the network, or read or write outside its worktree
- [ ] A Run that exceeds its time or token cap is stopped and reported as failed
- [ ] Token usage per Run is reported through the Agent interface
- [ ] An opt-in smoke test ("change the title to Hello" Lands) runs only when an API key and an explicit flag are set, and is skipped otherwise
