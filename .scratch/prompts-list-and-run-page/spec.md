# Spec: Prompts list and Run page

**Status:** resolved

## Problem Statement

The Console shows a Prompt's life in three separate lists: the Queue (waiting), Runs (in progress plus the last 20 finished) and History (everything that Landed). The same Prompt jumps between lists as it moves along, finished Runs disappear from Runs after 20, and rejected Runs vanish from view entirely. Players can't easily follow "what happened to my Prompt" in one place.

There's also no way to see *how* a Run went. The only detail is a short trail of "Editing <file>" lines while it runs, which isn't saved, so after a Run finishes, or after a restart, there's no record of what Claude said, why a Run was rejected beyond a one-line reason, or what it actually changed.

Finally, the "Fix it to this!" button doesn't match the glossary term **Replay**.

## Solution

The Console gets a single **Prompts** list, newest first, where every Prompt, Replay and Rollback appears exactly once and updates in place as it goes from waiting to running to Landed or rejected. Every entry stays forever, rejected ones included. Landed entries carry **Replay** and **Roll back** buttons.

Clicking an entry opens its **Run page** on the Console. It shows:

- a live log of what Claude said and what the platform did, saved forever
- the files being edited while the Run is in progress
- once finished, the final change as files with line-by-line diffs (or the attempted change, for a rejected Run)
- for Landed Runs, a link to view the Canvas at that version

## User Stories

### The Prompts list

1. As a Player, I want one list of all Prompts instead of three, so that I can follow my Prompt in one place.
2. As a Player, I want each Prompt to appear exactly once and update in place, so that I don't have to look for it in different lists as it moves along.
3. As a Player, I want the newest entries at the top, so that what's waiting and running is easy to find.
4. As a Player, I want waiting Prompts in the same list, so that I can see what's coming and where mine is.
5. As a Player, I want each entry to show its state, nickname, Prompt, model, time and outcome, so that I can scan the list at a glance.
6. As a Player, I want long Prompts shortened in the list, so that rows stay compact.
7. As a Player, I want rejected Runs to stay in the list with their reason, so that I can see what failed and why.
8. As a Player, I want every entry to stay in the list forever, so that the whole game's story is visible.
9. As a Player, I want the list to survive a platform restart unchanged, so that nothing disappears.
10. As a Player, I want Replays and Rollbacks marked distinctly in the list, so that I can tell them from ordinary Prompts.
11. As a Player, I want Replay and Roll back buttons on Landed entries only, so that I'm only offered actions that make sense.
12. As a Player, I want the button to say "Replay", so that it matches what the game calls it.
13. As a Player, I want Replay to ask "Yes, replay" or "Cancel" before starting, so that I don't trigger it by accident.
14. As a Player, I want the buttons disabled while the Console is paused, so that I'm not offered actions that will be refused.
15. As a Player, I want to click an entry to open its Run page, so that I can see the details.

### The Run page

16. As a Player, I want each Run to have its own page with a shareable link, so that I can show others what happened.
17. As a Player, I want a link back to the Prompts list, so that I can return easily.
18. As a Player, I want the Run page to show the same details as the list entry, so that I know which Run I'm looking at.
19. As a Player, I want Replay and Roll back buttons on a Landed Run's page, so that I can act without going back to the list.
20. As a Player, I want a Replay's or Rollback's page to name and link the change it came from, so that I can follow the chain.

### The live log

21. As a Player, I want to see what Claude says while it works, so that waiting is entertaining.
22. As a Player, I want to see the platform's steps (queued, started, rebasing, render check, conflict fixes, starting over, Landed or rejected), so that I understand what's happening to my Prompt.
23. As a Player, I want the log to update live while the Run is in progress, so that I can watch it happen.
24. As a Player, I want timestamps on log lines, so that I can see how long each step took.
25. As a Player, I want the log free of tool-call noise, so that it stays readable.
26. As a Player, I want the log saved forever, so that I can read it long after the Run finished.
27. As a Player, I want the whole log kept with no length limit, so that nothing is cut off.
28. As a Player, I want a Run resumed after a restart to continue the same log with a "Platform restarted, starting over" line, so that its story stays in one place.
29. As a Player, I want a rejected Run's log to end with the reason, so that I know why it failed.

### Changed files

30. As a Player, I want to see the names of files being edited while a Run is in progress, so that I can follow its work.
31. As a Player, I want a finished Run to show the files it changed with how many lines were added and removed, so that I can see the size of the change.
32. As a Player, I want to expand each file to its line-by-line diff, so that I can see exactly what changed.
33. As a Player, I want a rejected Run to show the change it attempted, so that I can see what went wrong.
34. As a Player, I want a Run that failed before changing anything to say "No changes", so that the page isn't confusing.
35. As a Player, I want only the final change shown when a Run went through conflict fixes or started over, so that I see the result, not every attempt.
36. As a Player, I want a "View the Canvas at this version" link on a Landed Run's page, so that I can see the Canvas as that change left it.

## Implementation Decisions

- **One list of Runs replaces the Queue, Runs and History lists.** Each entry is one Run, whatever its kind (Prompt, Replay, Rollback) or state. The list holds every Run ever recorded, newest first. Landed changes in `main`'s history that have no Run record (from before Runs were saved) appear as Landed entries whose page says "No log recorded".
- **All Runs are kept and served forever.** The Run store already saves every Run; the platform stops limiting what it reloads and serves to the latest 20. The Console's live snapshot includes summaries of every Run (no logs or diffs), and later changes arrive as updates to individual entries.
- **The Agent interface gains a `message` event** carrying a piece of Claude's text. The real Claude Agent emits Claude's text replies as `message` events; it never emits tool calls, tool results or hidden reasoning into it. The existing `progress` events ("Editing <file>") stay, and feed the list of files being edited rather than the log.
- **Each Run has an append-only log of entries `{time, source, text}`**, where `source` is `claude` or `platform`. Platform entries are written for: queued, started, rebasing, render check, each conflict-fix attempt, starting over, platform restarted, Landed, and rejected with the reason. Log entries are saved in the Run store as they happen, with no size limit, and survive restarts. A resumed Run appends to its existing log.
- **Changed files per Run:**
  - while in progress: the set of file names from `progress` events, saved with the Run
  - Landed: the files changed by the Landed commit, read from git
  - rejected: the attempted change, captured as a diff and saved before the worktree is removed; empty means "No changes"
  - only the final change is kept: what Landed, or the last attempt
- **Console API:**
  - a list endpoint returning every Run summary, newest first
  - the Run endpoint returns the summary plus the full log, the changed files (names while in progress; per-file added/removed counts and diffs once finished), the original change for Replays and Rollbacks, and the Landed commit
  - the live WebSocket adds `log` updates (a new entry for a Run) and `files` updates (the in-progress file names changed)
  - the old History endpoint is no longer used by the Console and can be removed
- **The Run page lives on the Console's origin at `/runs/<id>`**, so Canvas code can't reach it, and can be opened directly from a link. It subscribes to the same live WebSocket for updates while the Run is in progress.
- **"View the Canvas at this version"** links to the Canvas's commit-pinned URL for the Landed commit.
- **Labels:** the button is "Replay", and its confirmation offers "Yes, replay" and "Cancel", mirroring "Roll back" / "Yes, roll back" / "Keep it".
- Existing rules stay: one waiting Prompt per Player, the spending pause disables Replay and Roll back, cross-origin refusal on every Console endpoint and upgrade.

## Testing Decisions

- **A good test checks external behaviour only:** what the Console API, the live WebSocket and the Console pages show, never internal structure.
- **Test surface:** the whole platform through `startTestPlatform()`, driven through the Console API and WebSocket, plus Playwright for the Prompts list and the Run page. Git, SQLite and the render check are real.
- **Substitution:** the scripted `FakeAgent`, extended so a script can emit `message` events. No new seams.
- **Scenarios to cover:**
  - one entry per Prompt that moves waiting → running → Landed in place; rejected entries stay with their reason
  - more than 20 finished Runs are all still listed, including after a restart
  - Replay and Roll back appear only on Landed entries; "Replay" → "Yes, replay" / "Cancel"; both disabled while paused
  - clicking an entry opens `/runs/<id>`; the page links back and links a Replay's or Rollback's original
  - the log shows Claude's messages and the platform's steps in order, updates live, contains no tool-call output, and is complete after the Run finishes and after a restart
  - a Run resumed after a restart continues its log with a "Platform restarted" line
  - file names appear while a Run is in progress; once Landed, the files show added/removed counts and diffs; a rejected Run shows its attempted change; a Run that changed nothing says "No changes"
  - a Run that went through a conflict fix shows only its final change
  - "View the Canvas at this version" points to the Landed commit's Canvas URL
- **Real Claude:** the opt-in smoke test is extended to check that Claude's messages appear in the Run's log.
- **Prior art:** the existing Console UI, queue, replay, rollback, conflicts and restart tests.

## Out of Scope

- Tool-call output in the log.
- Live diffs while a Run is in progress (only file names).
- Every intermediate attempt's change (only the final one).
- A size limit on logs.
- Pagination, search or filtering of the Prompts list.
- Changes to the Canvas side.

## Further Notes

- Vocabulary follows `GLOSSARY.md`; no new terms are needed. "Prompts list" and "Run page" are UI names, not domain terms.
- Runs recorded before this change have no saved log; their page says "No log recorded".
- With no size limit and every Run kept forever, the Run store grows for the life of the game. Accepted by the user.
