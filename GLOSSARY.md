# Self-Modifying App

A game where anyone sends prompts and Claude rewrites a website in response.

## Language

**Console**:
The page where prompts are sent. Claude can never change it.
_Avoid_: Prompt page, admin page, control panel

**Canvas**:
The website Claude rewrites in response to prompts.
_Avoid_: Site, app, playground

**Prompt**:
A request that someone sends from the Console, asking Claude to change the Canvas.
_Avoid_: Command, instruction, message

**Player**:
Anyone who sends Prompts, known only by the nickname they choose.
_Avoid_: User, account

**Run**:
One Claude session working on one Prompt in its own copy of the Canvas.
_Avoid_: Job, task, build

**Land**:
What happens when a Run's change becomes part of the live Canvas.
_Avoid_: Merge, deploy, publish

**Replay**:
A new Run that sends a past Prompt again against the current Canvas, keeping everything that Landed since. It wins over later changes on the thing it's about.
_Avoid_: Retry, redo, restore
