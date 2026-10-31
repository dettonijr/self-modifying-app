# 04: Changed files for Runs in progress and Landed Runs

**What to build:** The Run page shows what the Run changed.

- **While in progress:** the names of the files being edited, from the Agent's existing progress events, updating live. These are saved with the Run, so they survive a page reload and a restart. No diffs while in progress.
- **Once Landed:** each file the Landed commit changed, with how many lines were added and removed, expandable to its line-by-line diff. Read from git.
- **"View the Canvas at this version":** on a Landed Run's page, a link to the Canvas's commit-pinned URL for the Landed commit.

The Console's live WebSocket sends an update when a Run's in-progress file names change.

See spec: `.scratch/prompts-list-and-run-page/spec.md`.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] File names appear on an open Run page while the Run is in progress, updating live
- [ ] In-progress file names survive a page reload
- [ ] A Landed Run's page lists its changed files with added/removed counts
- [ ] Each file expands to its diff
- [ ] A Landed Run's page links to the Canvas at the Landed commit
