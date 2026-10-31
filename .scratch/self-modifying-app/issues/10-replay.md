# 10: Replay ("Fix it to this!")

**What to build:** Every change in the Console history has a "Fix it to this!" button, behind a confirmation, with a model choice. A Replay starts a new Run whose instructions contain:

- the original Prompt
- the original commit's diff, as reference only and not to be applied blindly
- the Prompts that Landed since then
- the rule: make the Canvas fulfil this Prompt again, win over later changes on this specific subject, and keep everything unrelated

It goes through the normal Landing path, uses up the Player's waiting slot and is credited in history as "↻ *replayer* replayed *original Player*'s '*prompt*'", with a reference to the original commit.

**Blocked by:** 08

**Status:** resolved

- [ ] Replay asks for confirmation and lets the Player choose the model
- [ ] The fake Agent receives the original Prompt, the original diff and the later Prompts in its instructions
- [ ] The Replay commit records kind, the replaying Player's nickname and a reference to the original commit
- [ ] The history shows the "↻ … replayed …" credit
- [ ] A Replay counts against the Player's one waiting Prompt
