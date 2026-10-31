# 02: A Prompt Lands, one Run at a time (fake Agent)

**What to build:** A Player opens the Console, picks a nickname (remembered in a cookie and changeable later), types a Prompt, picks a model (Sonnet 5.5 by default, or Opus 5.5) and sends it. A Run starts in its own git worktree branched from `main`, and the Agent edits files there. When the Agent finishes, the change is committed with the kind of change (Prompt), the nickname, the Prompt text and the model. `main` is fast-forwarded, the worktree is removed and the Canvas serves the new commit. The Console shows a basic history of changes that Landed: nickname, Prompt and time.

Only one Run happens at a time here; queueing and parallel Runs come later. A Prompt sent while a Run is in progress can simply be refused for now. Only the scripted fake Agent exists in this ticket; the real Claude Agent comes in 03.

**Blocked by:** 01

**Status:** resolved

- [ ] The Console asks for a nickname on first visit, stores it in a cookie and allows changing it
- [ ] The Prompt box enforces the 500-character limit with a visible counter, and the API also rejects longer Prompts
- [ ] The model dropdown offers only Sonnet 5.5 and Opus 5.5, with Sonnet 5.5 as the default; the API rejects other models
- [ ] A Prompt with a fake Agent edit Lands: the Canvas serves the edited file and the commit records kind, nickname, Prompt and model
- [ ] An Agent failure leaves `main` unchanged, and the Run's worktree is cleaned up either way
- [ ] The history in the Console lists Landed changes with nickname, Prompt and time
