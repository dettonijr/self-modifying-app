# Spec: Self-Modifying App

**Status:** ready-for-agent

## Problem Statement

A group of people on the same local network want a playful, shared creative experience: everyone types what they want a website to become, and watches it change live. Today, changing a website means writing code by hand, one person at a time. There's no way for a crowd to steer a website together, see each other's changes land in real time, and recover when someone's change accidentally breaks something.

The host running the game also needs confidence that letting anyone send instructions to an AI agent won't break the game itself, damage their machine, or run up an unbounded bill.

## Solution

A web app with two parts:

- The **Console**: a fixed page where any **Player** picks a nickname and sends **Prompts**. Claude can never change it.
- The **Canvas**: a shared website that Claude rewrites in response to Prompts.

Each Prompt starts a **Run**: a Claude session working on its own copy of the Canvas. Several Runs work in parallel. When a Run finishes, its change **Lands** on the live Canvas, and everyone viewing the Canvas sees it reload with a notice crediting the Player. Runs that collide with changes that already Landed are reconciled automatically.

Accidents are part of the game: a Prompt can break someone else's feature. Players recover by **Replaying** an earlier Prompt ("Fix it to this!"), which re-applies its intent on top of the current Canvas, or by **Rolling back** a change. The only hard guarantee is that a Canvas that won't load at all never Lands.

Claude only writes front-end code. Features that need a backend, such as a live chat, are built on two fixed platform services: a real-time channel and a shared key-value store.

Everything runs in one Docker container on the host's machine, with a spending cap on the host's Anthropic API key.

## User Stories

### Joining and identity

1. As a Player, I want to open the Console on my phone over the local Wi-Fi, so that I can join without installing anything.
2. As a Player, I want to pick a nickname the first time I open the Console, so that my changes are credited to me.
3. As a Player, I want my nickname remembered on my device, so that I don't have to enter it again after a reload.
4. As a Player, I want to change my nickname, so that I can fix a typo or pick a better one.
5. As a viewer, I want to open the Canvas on any device on the network, so that I can watch it evolve on a big screen or my own phone.

### Sending Prompts

6. As a Player, I want to type a Prompt and send it, so that Claude changes the Canvas the way I describe.
7. As a Player, I want to choose between Sonnet 5.5 and Opus 5.5 for my Prompt, so that I can trade speed for quality.
8. As a Player, I want Sonnet 5.5 selected by default, so that I get a fast result without thinking about models.
9. As a Player, I want to see a character counter with the 500-character limit, so that I know when my Prompt is too long.
10. As a Player, I want a clear message if my Prompt is rejected for being too long, so that I can shorten it.
11. As a Player, I want to be told I already have a Prompt waiting if I try to send a second one, so that I understand why I can't send another yet.
12. As a Player, I want to be able to send again as soon as my waiting Prompt starts running, so that I'm not blocked for the whole Run.
13. As the host, I want each Player limited to one waiting Prompt, so that no one can fill the queue.

### Queue and progress

14. As a Player, I want to see the live queue with each waiting Prompt's nickname and text, so that I know what's coming and where I am.
15. As a Player, I want to see which Runs are in progress, so that I know what's being worked on right now.
16. As a Player, I want to see a Run's progress, such as which files Claude is editing, so that waiting is entertaining.
17. As a Player, I want to see when my Run Lands, fails, or is rejected, and why, so that I know what happened to my Prompt.
18. As a viewer, I want a banner on the Canvas saying "nickname is changing the page…" during a Run, so that I know a change is coming.
19. As the host, I want at most 3 Runs at once, with extra Prompts waiting in the queue, so that cost and conflicts stay manageable.
20. As the host, I want the parallel Run limit to be a single setting, so that I can tune it during play.

### Landing and reload

21. As a viewer, I want the Canvas to reload automatically when a change Lands, so that I always see the latest version.
22. As a viewer, I want a short notice after the reload saying "changed by nickname: 'prompt'", so that I know who did what.
23. As a viewer, I never want to see a half-updated Canvas, so that the page is always consistent.
24. As a viewer, I want the reloaded Canvas to show the new version rather than a cached one, so that I'm not confused by stale files.
25. As a Player, I want my Run to build on everything that Landed before it Lands, even if other Runs Landed while mine was in progress, so that no one's change is silently overwritten.
26. As the host, I want a Run whose result doesn't render, because of a blank page or a fatal error, to never Land, so that the Canvas is always at least loadable.
27. As a Player, I want a Run that breaks a feature but still renders to Land anyway, so that accidents keep the game dynamic.

### Conflicts

28. As a Player, I want my Run to be reconciled automatically when it conflicts with something that Landed, so that my Prompt still takes effect.
29. As a Player, I want the reconciliation to respect both my Prompt and the Prompts it collided with, so that neither intention is thrown away.
30. As a Player, I want my Prompt rerun from scratch on the latest Canvas if reconciliation fails twice, so that it gets a second chance.
31. As a Player, I want to be told my Prompt collided and was rejected if the rerun also fails, so that I can try again with a different Prompt.
32. As the host, I want Claude to follow Canvas conventions, with each feature in its own folder, so that parallel Runs rarely touch the same files.

### History, Replay and Rollback

33. As a Player, I want to see the history of every change that Landed, with nickname, Prompt and time, so that I can follow how the Canvas evolved.
34. As a Player, I want a "Fix it to this!" button on each change in the history, so that I can bring back a feature someone broke.
35. As a Player, I want a confirmation before a Replay starts, so that I don't trigger it by accident.
36. As a Player, I want a Replay to re-apply the original Prompt on top of the current Canvas, keeping everything that came after, so that I don't lose other people's work.
37. As a Player, I want a Replay to win over later changes on the specific thing it's about, so that "make it snow" works again even after someone stopped the snow.
38. As a Player, I want to pick the model for a Replay, so that I can use Opus 5.5 for a tricky fix.
39. As a Player, I want a Replay credited to me with a link to the original, such as "↻ Alice replayed Bob's 'make it snow'", so that history stays honest.
40. As a Player, I want a Replay to use up my one waiting slot like a normal Prompt, so that the rules are consistent.
41. As a Player, I want to Roll back a change from the history, so that I can undo something I dislike.
42. As a Player, I want a confirmation before a Rollback, so that I don't remove someone's work by accident.
43. As a Player, I want a Rollback to keep everything that Landed after the change, so that only that change is undone.
44. As a Player, I want a Rollback that conflicts with later changes to be handled by Claude, so that it still works when the code has moved on.
45. As a Player, I want Rollbacks and Replays to appear in the history like any other change, so that nothing is hidden.
46. As a Player, I want to Replay or Roll back a change that was itself Rolled back, so that I can bring things back.

### Canvas capabilities

47. As a Player, I want to ask for features like a live chat, multiplayer cursors or live votes, so that the Canvas can be interactive between viewers.
48. As a Player, I want to ask for features that save data, like a guestbook, scores or counters, so that the Canvas can remember things.
49. As a viewer, I want messages sent on one device to appear on everyone else's Canvas in real time, so that real-time features work.
50. As a viewer, I want saved data to survive Rollbacks and Replays, so that the chat history isn't wiped when code changes.
51. As the host, I want each feature's saved data kept under its own name, so that features don't clobber each other's data.
52. As a Player, I want Claude to be able to use libraries and fonts from CDNs, so that ambitious features are possible.
53. As a Player, I want the first Prompt to start from a minimal starter Canvas with a title and an example feature, so that Claude sees the conventions from the start.

### Safety and cost

54. As the host, I want the Console on a separate origin from the Canvas, so that Canvas code can never read or change the Console.
55. As the host, I want Claude confined to its Run's copy of the Canvas, editing files only, with no shell or network access, so that Prompts can't touch the rest of my machine.
56. As the host, I want time and token limits per Run, so that a single Prompt can't run forever.
57. As the host, I want the whole platform in one Docker container, so that even a leak in Claude's confinement can't reach my machine.
58. As the host, I want a spending cap, so that anonymous Players can't run up an unbounded bill.
59. As a Player, I want to see the running cost in the Console, so that everyone knows how much the game has spent.
60. As a Player, I want a clear message when the spending cap is reached and the Console is paused, so that I know why I can't send Prompts.
61. As the host, I want to raise the spending cap from the command line, so that the game can continue without a restart.
62. As the host, I want the model to be chosen only from Sonnet 5.5 and Opus 5.5, so that Players can't pick something unexpected.

### Running it

63. As the host, I want to start everything with one command, so that setup is trivial.
64. As the host, I want to provide my Anthropic API key as an environment variable, so that it's never stored in the Canvas or shown to Players.
65. As the host, I want the Canvas history and saved data to survive restarts, so that the game continues where it left off.
66. As the host, I want waiting Prompts to survive a restart, so that Players don't lose their place.
67. As the host, I want Runs that were in progress during a restart to start again on the latest Canvas, so that no Prompt is silently lost.
68. As the host, I want the game to be one continuous Canvas with no reset, so that the evening's work is never accidentally wiped.

## Implementation Decisions

### Shape

- One TypeScript/Node platform process, packaged as a single Docker container started with Docker Compose. A mounted data volume holds the Canvas repo and a SQLite database.
- Two HTTP servers in the same process, each listening on all interfaces:
  - the **Console server**, which serves the Console UI and the Console API (HTTP plus a WebSocket for live updates)
  - the **Canvas server**, which serves the Canvas and hosts the platform services
- The two servers run on different ports, and therefore different origins. This is the security boundary that protects the Console from Canvas code. The Canvas server must not accept credentialed requests from Console pages, and vice versa.

### Modules

- **Canvas repository**: owns the git repo for the Canvas. `main` is the live Canvas, and every commit on `main` is a version. It exposes:
  - reading a file at a commit
  - creating and removing a Run's worktree, branched from the current `main`
  - committing a Run's changes with nickname and Prompt metadata
  - rebasing a Run's branch onto `main`
  - fast-forwarding `main`
  - reverting a commit
  - listing history with that metadata
  On first start, it seeds the starter Canvas: a title, the per-feature folder structure, one example feature, and a `CLAUDE.md` with conventions for Claude.
- **Agent**: the single interface that hides Claude. Input: a worktree, instructions and a model. Output: a stream of progress events (such as files being edited), token usage, and a final success or failure. The real implementation uses the Claude Agent SDK, limited to file-editing tools within the worktree, with no shell or network access, and with per-Run time and token caps. This is the only substitution point in tests.
- **Run coordinator**: owns the queue and the Run lifecycle. It enforces:
  - one waiting Prompt per Player
  - the 500-character limit
  - the allowed models
  - the parallel Run limit (default 3, configurable)
  It starts Runs as slots free up and sends finished Runs to the Lander. On startup, it restores waiting Prompts from SQLite and restarts interrupted Runs from scratch on the current `main`.
- **Lander**: Lands finished Runs one at a time, in finish order:
  1. rebase onto current `main`
  2. render check
  3. fast-forward `main`
  4. broadcast a reload event
  5. remove the worktree
  If the rebase conflicts, it asks the Agent to resolve the conflict in the same worktree. The Agent gets the conflict, the Run's Prompt, and the Prompts of the conflicting commits. There are up to 2 resolution attempts. After that, the Run starts over once from the latest `main`, and if that fails too, the Run is rejected. A render-check failure follows the same path.
- **Render check**: loads a candidate Canvas commit in headless Chromium (Playwright) and passes if the page loads without fatal errors and isn't blank. It deliberately doesn't test individual features.
- **Replay**: creates a new Run whose instructions contain the original Prompt, the original commit's diff (as reference, not to be applied blindly), the Prompts that Landed since, and the rule that the Replay wins on its specific subject while keeping unrelated later changes. It's credited to the Player who replayed it, with a reference to the original commit.
- **Rollback**: first tries a mechanical revert of the target commit on a Run branch. If that conflicts, it becomes an Agent Run instructed to "undo this change, keep what came after". Either way, it goes through the Lander.
- **Platform services**: a real-time channel that broadcasts messages to every Canvas viewer, and a key-value store backed by SQLite, with keys namespaced per feature. Both are exposed to Canvas code through a small client library that the Canvas server provides, and they aren't versioned with the Canvas. The real-time channel also carries the platform's own events: Run-in-progress banners and reload notices.
- **Canvas server**: serves files straight from the commit `main` points to, read from git objects rather than a working folder, so Landing is just moving `main`. It injects the platform's banner and reload script, which Claude can't change, into served HTML. Asset URLs include the commit hash so browsers don't serve stale files.
- **Budget**: records token usage reported by the Agent for every Run, conflict resolution included, and converts it to cost per model. When the cap is reached, it pauses the Console, so new Prompts, Replays and Rollbacks are refused. The cap is set by configuration and can be raised through a command-line command while the platform is running. The running total is shown in the Console.
- **Console UI**: nickname entry (stored in a cookie), the Prompt box with model dropdown and character counter, the live queue, Runs in progress and their progress, the history with "Fix it to this!" and Rollback buttons (both behind a confirmation), the running cost, and a paused state.

### Contracts

- A Player is identified by nickname only, from a cookie. Nicknames aren't authenticated, which is acceptable on a local network.
- Run states: `waiting → running → landing → landed`, with failure paths `resolving` (up to 2 times) and `restarted` (once), ending in `rejected`. A Run also ends in `rejected` if the Agent fails or hits a cap.
- Every commit on `main` records the kind of change (Prompt, Replay or Rollback), the Player's nickname, the Prompt text and the model, plus a reference to the original commit for Replay and Rollback.
- Canvas conventions given to Claude: plain HTML, CSS and JS modules with no build step, libraries from CDNs through import maps, one folder per feature, an entry page that only lists features, shared styling through a small set of theme variables, and a ban on editing the platform's injected script.

## Testing Decisions

- **A good test checks external behaviour only.** Tests drive the platform the way a Player or viewer would and check what's observable: what the Canvas serves, Run and queue states, history, and real-time events. They never check internal structure, such as how the queue is implemented or how the rebase is done, so internals can be rewritten freely.
- **One test surface:** the whole platform, started fresh for each test on random ports with a temporary data folder, driven through the Console API (HTTP and WebSocket) and the Canvas server. Git, SQLite and the Playwright render check are real.
- **One substitution:** a scripted fake Agent. Each test scripts its file edits and behaviour: conflicting edits, a broken page, hanging, crashing, reported token usage, and **holding until the test releases it**, which forces exact orderings between parallel Runs without sleeps.
- **Runner:** Vitest, with Playwright for browser-level checks such as origin isolation and the banner and reload behaviour.
- **Scenarios to cover:**
  - **Landing:** a Prompt Lands, the Canvas serves the new commit, viewers get a reload and the history credits the Player
  - **Limits:** a second waiting Prompt from the same Player is rejected, as are an over-length Prompt and an unknown model
  - **Parallelism:** a 4th Prompt waits while 3 Runs are going, and starts when one finishes
  - **Clean rebase:** parallel Runs touching different features both Land
  - **Conflicts:** a conflicting Run is resolved and Lands; resolution fails twice, then the restart succeeds; resolution and restart both fail, and the Run is rejected
  - **Render check:** a page that doesn't render doesn't Land and `main` is unchanged; a broken feature that still renders does Land
  - **Rollback:** a clean revert Lands; a conflicting revert becomes an Agent Run
  - **Replay:** the fake Agent receives the original Prompt and diff; the commit credits the Player who replayed it, with a reference to the original
  - **Budget:** reaching the cap pauses the Console; raising it resumes
  - **Restart:** the queue survives, and Runs in progress start again
  - **Origin isolation:** Canvas pages can't make credentialed calls to the Console origin
  - **Platform services:** a real-time message reaches another viewer, and a key-value entry survives a Rollback
- **Opt-in real-Claude smoke test:** sends "change the title to Hello" through the real Agent and checks that it Lands. It's skipped unless an API key and an explicit flag are set.
- **Prior art:** none. The repo is empty, so this suite sets the pattern.

## Out of Scope

- Authentication, accounts and access control for the Console. Anyone on the network can play.
- Running on the public internet or hosted deployment.
- Back-end code written by Claude. Backend needs are met only by the fixed platform services.
- Per-feature smoke tests or regression tests that block Landing. Accidents are part of the game.
- A content filter or moderation of Prompts.
- "New game", resetting or archiving the Canvas.
- A build step, bundler or package installation for the Canvas.
- Automatic batching of Prompts.
- Choosing models other than Sonnet 5.5 and Opus 5.5.

## Further Notes

- Vocabulary follows the root glossary: Console, Canvas, Prompt, Player, Run, Land, Rollback and Replay.
- Four decisions are good candidates for ADRs but haven't been recorded yet:
  - parallel Runs in worktrees, with Landing one at a time
  - fixed platform services instead of back-end code written by Claude
  - serving the Canvas straight from git with no build step
  - separate origins as the Console's security boundary
- If parallel Runs turn out to conflict too often in practice, lowering the parallel Run limit is the first thing to try. Batching remains a possible later change.
- The host's machine needs internet access for the Anthropic API, and for Canvas features that load from CDNs.
