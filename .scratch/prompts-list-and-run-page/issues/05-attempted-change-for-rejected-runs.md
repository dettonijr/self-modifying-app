# 05: Attempted change for rejected Runs

**What to build:** A rejected Run's page shows the change it tried to make, in the same files-with-diffs view as Landed Runs. The attempted change is captured as a diff and saved with the Run before its worktree is removed, so it's still there later and after a restart. A Run that failed before changing anything says "No changes".

When a Run went through conflict fixes or started over, only the final change is shown: what Landed, or the last attempt. The log already narrates each attempt.

See spec: `.scratch/prompts-list-and-run-page/spec.md`.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] A rejected Run's page shows its attempted change as files with counts and diffs
- [ ] The attempted change is still shown after a restart
- [ ] A Run that changed nothing says "No changes"
- [ ] A Run that went through a conflict fix shows only its final change
