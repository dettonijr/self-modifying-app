# 09: Rollback

**What to build:** Every change in the Console history has a Rollback button, behind a confirmation. A Rollback undoes that change while keeping everything that Landed after it:

1. First, try a mechanical revert of the target commit on a Run branch.
2. If the revert conflicts, it becomes an Agent Run instructed to undo the change and keep what came after.

Either way, it goes through the normal Landing path, including conflict handling and the render check. It uses up the Player's one waiting slot, and appears in the history as a Rollback credited to that Player, with a reference to the original commit. Changes that were themselves Rolled back can be Rolled back or Replayed again.

**Blocked by:** 08

**Status:** resolved

- [ ] Rollback asks for confirmation in the Console
- [ ] A clean revert Lands, and later changes are kept
- [ ] A conflicting revert becomes an Agent Run with the undo instruction
- [ ] The Rollback commit records kind, nickname and a reference to the original commit
- [ ] A Rollback counts against the Player's one waiting Prompt
