# 02: The Run page

**What to build:** Clicking a row in the Prompts list (anywhere except its buttons) opens that Run's page at `/runs/<id>` on the Console's origin, so Canvas code can't reach it. The link works when opened directly or shared.

The page shows:

- a "← Prompts" link back to the list
- the same details as the list entry: state, nickname, the full Prompt, model, time and outcome, updating live while the Run is in progress
- for Landed Runs, the Replay and Roll back buttons, with the same confirmations and pause rules as the list
- for Replays and Rollbacks, the change they came from, e.g. "↻ Replay of Bob's 'make it snow'", linking to that change's page
- a placeholder for the log and changed files (built in tickets 03 and 04); Runs with no saved log say "No log recorded"

An unknown id shows a clear "No such Run" page.

See spec: `.scratch/prompts-list-and-run-page/spec.md`.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Clicking a row opens `/runs/<id>`; clicking its buttons doesn't
- [ ] The page opens directly from its URL and links back to the Prompts list
- [ ] The page shows the Run's details and updates live while it's in progress
- [ ] A Landed Run's page has working Replay and Roll back buttons with confirmations, disabled while paused
- [ ] A Replay's or Rollback's page names and links its original change
- [ ] An unknown id shows "No such Run"
- [ ] The page refuses cross-origin access like other Console endpoints
