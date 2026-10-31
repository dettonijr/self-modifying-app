# Decisions

A running log of details and smaller decisions that matter later: constraints found while building, conventions, known limitations. Larger trade-offs live in `docs/adr/`; vocabulary lives in `GLOSSARY.md`; the plan lives in `.scratch/self-modifying-app/spec.md`.

Newest entries at the bottom. Each entry notes where it came from.

## Runtime and tooling

- **TypeScript runs directly on Node, with no build step** (ticket 01). Node ≥ 22.18 strips types natively, so imports must use `.ts` extensions and only erasable TS syntax is allowed: no `enum`, no `namespace`, no parameter properties.
- **npm, not pnpm** (ticket 01). pnpm isn't installed in the dev environment.
- **The Docker image is `mcr.microsoft.com/playwright:v1.64.1-noble`** (ticket 07, replacing `node:22` from ticket 01). It ships Node 24, git, and Chromium with its system libraries. Installing those libraries on `node:22` fails because `deb.debian.org:80` needs host approval in the sandbox. `playwright` is a runtime dependency pinned to exactly `1.64.1`; it must match the image tag whenever either is upgraded.
- **The dev machine has Chromium's system libraries and Playwright's Chromium installed** (ticket 01). Recorded in `/home/agent/.t3/notes/self-modifying-app/env.md`.
- **The dev machine's Node can't run `.ts` files** (ticket 12). Debian's Node build has `process.features.typescript === false` (`ERR_NO_TYPESCRIPT`), so `npm start` and `node src/*.ts` fail here; they work in the `node:22` Docker image, or locally with the official Node build or `nvm`. Tests must call code in-process instead of spawning `node src/*.ts`.

## Platform structure

- **The Agent interface is `run(task)`, returning a stream of `progress` and `usage` events that ends in exactly one `result`** (ticket 01). The running platform uses `unavailableAgent` until ticket 03 adds the real Claude Agent. Tests use `FakeAgent`, with a `Gate` that holds a Run until the test releases it.
- **The test harness is `startTestPlatform()`** (ticket 01). Each test gets a fresh platform on random ports with a temporary data folder. See the README.
- **Run lifecycle lives in `runs.ts`, Landing in `lander.ts`** (ticket 02). `Runs` validates Prompts (500 characters, `MODELS`, nickname from the `nickname` cookie) and drives each Run: worktree at `<data>/worktrees/<runId>` on branch `run/<runId>`, the Agent, the Lander, then removal of the worktree. A Run's final state (`landed`/`rejected`) is published only after its worktree is removed, so a Player who sees it finish can send the next Prompt. Prompts sent while a Run is in progress get 409 for now (ticket 05 replaces this with the queue).
- **Landing moves `main` with `git update-ref` and the expected old value** (ticket 02), so it's a compare-and-swap that fails if `main` moved. It never touches the Canvas repo's working folder, which goes stale after the first Land. Nothing should read or commit through that folder. Ticket 06 must rebase onto the latest `main` before the swap.
- **Commit metadata is git trailers** (ticket 02). The message is `<Kind> by <nickname>: <summary>`, a blank line, the Prompt verbatim, a blank line, then `Kind:`, `Nickname:` and `Model:` trailers. `CanvasRepository.history()` reads only commits with a `Kind` trailer. Replay and Rollback should add their reference to the original commit as another trailer.
- **A Run whose Agent changes nothing is rejected** (ticket 02), with nothing committed.
- **Console API so far** (ticket 02): `POST /api/prompts` `{prompt, model?}` with the nickname cookie returns 202 and the Run, or 400 or 409. `GET /api/runs/:id` and `GET /api/history` (newest first: commit, kind, nickname, prompt, model, time). The Console UI polls these until ticket 05 adds the WebSocket.

## The real Claude Agent

- **`ClaudeAgent` is used when `ANTHROPIC_API_KEY` is set, otherwise `unavailableAgent`** (ticket 03, `agentFromEnvironment`). The key goes only into the environment of Claude's own process and is masked in error messages.
- **Per-Run caps: `RUN_TIME_LIMIT_SECONDS` (default 600) and `RUN_TOKEN_LIMIT` (default 2,000,000)** (ticket 03). Invalid values stop the platform at startup. The token cap is checked after each message, so a Run can go slightly over before it stops. Going over a cap fails the Run with a message naming the cap.
- **How Claude is confined** (ticket 03): only the `Read`, `Write`, `Edit`, `Glob` and `Grep` tools. The shell, web, subagents and notebooks are also refused by name. A permission check allows only absolute paths inside the worktree, resolves symlinks first, and refuses anything under `.git`.
- **The Agent never loads settings, hooks or MCP servers from disk** (ticket 03). A Prompt can write `.claude/settings.json` or `.mcp.json` into the Canvas, which could otherwise run commands. Never switch this on. Because of it, the Agent reads the worktree's `CLAUDE.md` itself and adds it to the system prompt along with the platform's rules.
- **Token usage counts cached input as input** (ticket 03), so costs come out slightly high. Usage events are deltas; the final event tops up the difference to the SDK's totals, so the sum of usage events is authoritative.
- **Progress events cover only `Write` and `Edit`** (ticket 03), each saying "Editing <path relative to the worktree>".
- **Dependency: `@anthropic-ai/claude-agent-sdk` 0.3.316** (ticket 03). It ships the Claude executable as a separate package per platform, which `npm ci` in Docker installs to match the image.
- **Smoke test: `CLAUDE_SMOKE_TEST=1` plus `ANTHROPIC_API_KEY`** (ticket 03). It uses Sonnet 5.5 and passes when the page's `<h1>` or `<title>` becomes "Hello". In this sandbox the proxy supplies a real key, so any non-empty key works.

## Canvas serving and live reload

- **Canvas pages are served at `/@<commit>/<path>`** (ticket 04). A live URL redirects (302) to the same page at `main`'s commit, so relative URLs resolve inside that commit. Commit-pinned non-HTML files are cached as immutable; HTML and live URLs are `no-cache`. Only full 40-hex commits are accepted. Absolute URLs aren't pinned, so the Canvas `CLAUDE.md` tells Claude to use relative URLs. Chosen over `<base href>`, which breaks `#anchor` links; the commit shows in the address bar.
- **The live Canvas serves a pinned commit only if it's on `main` (`repo.isOnMain`); others get 404** (code review, replacing ticket 04's "any commit"). Commits found on `main` are cached for the server's lifetime, which relies on `main` only moving forward. The render check's private server passes `anyCommit: true` to serve the candidate.
- **`/__platform/` belongs to the platform and Canvas files there are never served** (ticket 04). It holds `platform.js` and `events`; ticket 11's client library and endpoints go under it too.
- **The platform script is injected into every `.html` file** (ticket 04): right after `<head …>`, otherwise after the doctype, otherwise at the start. Its UI sits in an open shadow root (`<platform-overlay>`), so Canvas CSS can't touch it.
- **The Canvas real-time channel is Server-Sent Events at `GET /__platform/events`** (ticket 04). Platform events use the SSE event name `platform`: `hello {commit, running}` first on each connection (late viewers get banners; an old page reloads), then `run-started`, `landed` and `rejected`. Ticket 11 should use its own event name and send viewer→server messages by POST under `/__platform/`, guarded by `isCrossOrigin()`.
- **Known limit: each open Canvas tab holds one HTTP/1.1 connection, and browsers allow about 6 per origin** (ticket 04). Many Canvas tabs in one browser could starve each other; moving to WebSocket would fix it.
- **`Runs.onChange(listener)` and `Runs.inProgressRuns()`** (ticket 04) drive Canvas events. `onChange` fires on running, landing, then landed/rejected (after the worktree is removed). Ticket 05's Console WebSocket can use the same hook.
- **The reload notice survives the reload through `sessionStorage`** and shows for 6 seconds (ticket 04).
- **Known limitation: if a Land deletes the page a viewer is on, the reload ends at a 404** (ticket 04).

## Landing

- **The Lander lands one Run at a time, in the order Runs reach `land()`, using a chain of promises** (ticket 06). Each Land: commit the worktree, read the current `main`, rebase with `CanvasRepository.rebaseWorktree(worktree, onto)`, run the render check, then move `main` with the compare-and-swap, expecting the `main` it rebased onto.
- **`LandFailure` is `"unchanged" | "conflict" | "render"`** (ticket 06). A conflicting rebase is aborted and returns `conflict`, with the message "The change conflicts with one that Landed while it was being made". Ticket 08 builds its handling on this.
- **Test pitfall: `FakeAgent` hands out scripts in the order Runs start, and worktree creation can reorder them under load** (ticket 06). Tests that hold a specific Run must wait with `agent.started(n)` before sending the next Prompt, or pick behaviour from `run.task.instructions`.
- **Tests that assume one Run at a time set `maxParallelRuns: 1`** (ticket 06), e.g. `queue.test.ts` and `console-ui.test.ts`.

## Conflict handling

- **A Land that fails with `conflict` or `render` goes `resolving → landing` up to `MAX_RESOLUTION_ATTEMPTS` (2), then `restarted → landing` once in a fresh worktree on the latest `main`, then `rejected`** (ticket 08). `unchanged` and Agent failures are rejected straight away. The restart gets no resolution attempts of its own.
- **Rejection message after a failed restart** (ticket 08): `COLLIDED_MESSAGE` for a conflict, "Canvas didn't render" for a render failure, or the Agent's own error.
- **The flow lives in `runs.ts` (`workAndLand` → `inWorktree` / `workOnce` / `workAndResolve` / `resolve`); constants, `resolutionInstructions()` and `hasConflictMarkers()` are in `src/resolution.ts`** (ticket 08). A Run's instructions and commit metadata are set in `workOnce` / `change()`, so Rollback and Replay get resolve → restart → reject for free by giving their Runs their own instructions and metadata.
- **Resolution always uses `RESOLUTION_MODEL` (Sonnet 5.5), and its usage goes through `Budget.record` under that model** (ticket 08).
- **Repository methods** (ticket 08): `reopenOnto(worktree, change, onto)` resets to `onto` and reapplies the change with `cherry-pick --no-commit`, returning conflicted paths with markers kept; `head(worktree)`; `changesBetween(from, to, paths?)`, oldest first, sharing parsing with `history()`. `Worktree.base` records the commit a worktree was created from.
- **What the resolving Agent is told** (ticket 08): for a conflict, the conflicted files, the Run's Prompt, and the nickname and Prompt of each commit since the base that touched those files; for a render failure, the problem (`LandResult.problem`) and every commit since the base.
- **Each Land is still exactly one commit** (ticket 08): a resolution leaves the change uncommitted on top of `main`. If reapplying onto the latest `main` is clean, the Agent isn't called. A failed attempt (Agent fails, conflict markers remain, or the next Land fails) starts the next one from the last committed change.
- **No resolution or restart starts once a Run's abort signal fires** (ticket 08), which fits restart resume.
- **Known limitation: a Run resumed after a platform restart gets a fresh set of resolution attempts and restart** (ticket 08).
- **The Console shows `resolving` and `restarted` like `running`, with a yellow badge** (ticket 08).
- **Test pitfall: resolution requests use up `FakeAgent` scripts too** (ticket 08). Tell them apart by `task.instructions !== prompt`. A test expecting rejection must queue scripts for both resolutions and the restart, or the extra attempts fail with "no script queued" and the reason changes.
- **Known flake: under full-suite load, one Playwright test in `platform-services.test.ts` once hit its 30s timeout** (ticket 08); it passed on rerun.

## Replay

- **`POST /api/replays` with `{commit, model?}` and the nickname cookie** (ticket 10) answers 202 with the Run, or 400 (no nickname or bad model), 404 (commit isn't a change on `main`, including the starter Canvas; reason `not-found`), 409 (`already-waiting`) or 503 (paused). Harness: `platform.replay({nickname, commit, model?})`.
- **Change kinds are listed in `CHANGE_KINDS` in `canvas-repository.ts`, and each kind's behaviour is in `CHANGE_KIND_RULES` in `src/change-kinds.ts`** (ticket 10; code review): `playerPicksModel`, an optional `mechanically` step with its "nothing to do" message, `instructions(repo, worktree, run)` and `intent(run)`. A new kind needs an entry in both. `history()` and `changesBetween()` list only listed kinds.
- **The reference to the original is two trailers, `Original: <sha>` and `Original-Nickname: <nick>`**, read back as `LandedChange.original = {commit, nickname}` (ticket 10). The nickname is stored so the credit needs no lookup. Rollback reuses the same field.
- **`RunView` has optional `kind` (absent means Prompt) and `original`, both saved by `RunStore`** (ticket 10). For a Replay, `run.prompt` is the original Prompt and `run.nickname` is the Player who replayed it.
- **Replay instructions are built each time work starts** (ticket 10, `CHANGE_KIND_RULES.Replay.instructions` → `replayInstructions()` in `src/replay.ts`). Later Prompts come from `changesBetween(original, worktree.base)`, so a Replay that waited or restarted gets the current list. The diff is cut at 40,000 characters (`MAX_DIFF_LENGTH`). Conflict resolution uses `run.prompt`, the original Prompt.
- **Repository methods** (ticket 10): `landedChange(commit)` returns a change only for a full 40-character hash on `main`; `diff(commit)` returns `git show` output.
- **`Runs.replay()` checks the pause before and after reading history, then goes through the same `enqueue()` as Prompts** (ticket 10), so it uses the Player's one waiting slot.
- **Console: each history entry has "Fix it to this!", which opens an inline confirmation with a "Replay model" dropdown** that survives history refreshes (ticket 10). History shows "↻ Alice replayed Bob's 'prompt' `abc1234`"; Replay Runs are marked ↻ in the Runs and queue lists.

## Rollback

- **`POST /api/rollbacks` with `{commit}` and the nickname cookie** (ticket 09) answers 202 with the Run, or 400 (no nickname), 404 (`not-found`), 409 (`already-waiting`) or 503 (paused). `Runs.rollback()` checks the pause before and after reading history, then uses the same `enqueue()` as Prompts and Replays.
- **A Rollback Run has `kind: "Rollback"`, `original: {commit, nickname}`, the original change's Prompt as `prompt`, the rolling-back Player as `nickname`, and always `DEFAULT_MODEL` (Sonnet 5.5)** (ticket 09). Players can't pick a model for a Rollback.
- **Rollback commits use the same `Original:` / `Original-Nickname:` trailers as Replay, with the subject `Rollback by <nick>: <original prompt>`** (ticket 09).
- **A Rollback first tries `CanvasRepository.revert(worktree, commit)` (`git revert --no-commit`); if that's clean the Agent isn't called** (ticket 09). If it conflicts, the worktree is reset and the Agent gets `rollbackInstructions()` from `src/rollback.ts` (original Prompt and author, the diff cut at `MAX_DIFF_LENGTH`, and later Prompts), starting from the latest Canvas with no conflict markers. The restart repeats revert-then-Agent.
- **Conflict resolution is told the Run's intent from `CHANGE_KIND_RULES[kind].intent`** (ticket 09; code review): for a Rollback that's `rollbackIntent()` ("Roll back X's change … keeping everything after"), so the resolver doesn't re-apply the change. Prompts and Replays still use `run.prompt`.
- **Rolling back a change that's already undone is rejected with `ALREADY_ROLLED_BACK_MESSAGE` ("That change is already undone")** (code review), used when the mechanical revert applied cleanly and the Lander reports `unchanged`.
- **Console: "Roll back" sits next to "Fix it to this!", with an inline confirmation; only one confirmation is open per entry** (ticket 09). History shows "↩ Alice rolled back Bob's 'prompt' `abc1234`". While paused, "Fix it to this!", "Roll back" and the confirm buttons are disabled (code review); the page keeps a `paused` flag from the spending poll.

## Render check

- **The render check is its own step in the Lander** (ticket 07): commit the worktree, run the check, then move `main`. Failures return `failure: "render"` (reason "Canvas didn't render") or `failure: "unchanged"`; ticket 08 routes on `failure`. The specific problem is only logged with `console.warn`; Players see "Canvas didn't render".
- **The check uses a private Canvas server on a random loopback port with its own channel** (ticket 07), so it never appears as a viewer of the live Canvas. It loads `/@<commit>/`. One Chromium starts on the first check and is reused until the platform closes. Page load times out after 10s, and the page is then checked as it stands.
- **Doesn't render means any of:** the entry page returns an error status (e.g. `index.html` deleted); the entry page's own inline scripts throw an uncaught error; or the body is blank, with no text and no visible sized element (the platform overlay sits outside `<body>` and doesn't count) (ticket 07).
- **Errors in a feature's own files and unhandled promise rejections don't count** (ticket 07), so a broken feature that still renders Lands, as designed.
- **Test fixtures must leave something visible in `index.html` to Land** (ticket 07); bare text like `"x"` is enough.

## Queue and the Console WebSocket

- **The parallel Run limit starts from `MAX_PARALLEL_RUNS` (default 3) and can be changed during play with `npm run set-parallel-runs -- <n>`** (tickets 05, 06; code review). The command writes `<data>/parallel-runs.json` as `{maxParallelRuns}`; once that file exists it wins over the environment variable, including after a restart. The value can go up or down; lowering never stops Runs in progress. Code is in `src/parallel-limit.ts`; `Runs` takes `maxParallelRuns` as a number or a function, and the platform passes one that re-reads the file.
- **One waiting Prompt per Player is an exact match on the trimmed nickname** (ticket 05). A second one gets 409 with reason `already-waiting`. The slot frees as soon as the Prompt starts running.
- **Queued Prompts don't start while the Console is paused by the spending cap** (orchestrator decision, built in ticket 06). They stay waiting and start once the cap is raised. Without this, Prompts queued before the cap was reached would keep spending. Because `raise-cap` and `set-parallel-runs` only write files, `startWaitingRuns()` re-checks every 500 ms whenever Prompts are waiting (`WAITING_RECHECK_MS`). Each call clears the pending timer, so a finished Run starts the next one immediately.
- **The Console WebSocket is `/api/live`, using the `ws` package** (ticket 05). On connecting, a client gets `{type:"snapshot", queue, runs}`, then `queue`, `run` (every state change) and `progress` messages. The snapshot holds Runs in progress plus the last 20 finished; each Run view keeps its latest 50 progress events. Types are `RunsEvent` and `RunsSnapshot` in `runs.ts`.
- **`Runs.subscribe(listener)` gets every Run event** (ticket 05). Ticket 04's `onChange` wraps it, so it also fires for `waiting`, which the Canvas channel ignores.
- **WebSocket upgrades go through `isCrossOrigin()` (403) and get 404 for any other path** (ticket 05). Any future WebSocket must do the same.
- **Closing an HTTP server doesn't close upgraded sockets** (ticket 05). The Console server terminates its WebSocket clients when it closes; any new WebSocket server must too, or `platform.close()` hangs.
- **The Console page gets Run status from the WebSocket and reconnects 1 second after it closes** (ticket 05). History refreshes on connect and on each Land. Spending is still polled every 2 seconds and refreshed whenever a Run finishes.
- **`playwright` is a runtime dependency, `ws` a dependency, `@types/ws` a dev dependency** (merge of 05 and 07).
- **Harness: `platform.live()` returns a WebSocket client with `messages` and `waitFor(match)`** (ticket 05).

## Platform services

- **Canvas code imports `{ channel, store }` from `/__platform/services.js`** (ticket 11; source `src/canvas-services.js`, which Claude can't edit). `channel(feature)` has `.send(msg)` and `.onMessage(fn)` (returns an unsubscribe function). `store(feature)` has `.get(key)` (`undefined` if missing), `.set(key, value)`, `.delete(key)` and `.list(prefix)` (returns `[{key, value}]` sorted by key). Values are any JSON. The feature name is the feature's folder name and must match `^[a-z0-9][a-z0-9_-]{0,63}$`.
- **Server API under `/__platform/`** (ticket 11, `src/platform-services.ts`): `POST channel/<feature>` with `{message}`; `GET|PUT|DELETE store/<feature>/<url-encoded key>` (`PUT` takes `{value}`, `GET` returns `{value}` or 404); `GET store/<feature>/?prefix=` returns `{entries}`. Every route refuses other origins with 403. Only `GET`/`HEAD` reach the rest of the Canvas server.
- **Limits: messages 16 KB, values 64 KB, keys 256 characters** (ticket 11).
- **Feature messages travel on the same SSE stream with event name `feature`**, data `{feature, message}` (ticket 11). They reach every viewer, the sender included, and aren't stored: a viewer only gets messages sent while their page is open.
- **One event connection per page** (ticket 11): the platform script exposes its EventSource as `window.__platformEvents` and the client library reuses it.
- **The key-value store uses Node's built-in `node:sqlite`, in `<data>/services.sqlite` (WAL mode), outside the Canvas repo** (ticket 11), so Land, Rollback and Replay never touch it. No new dependency; Node prints a one-time `ExperimentalWarning` at startup. Ticket 13 can reuse `node:sqlite` for the queue.
- **There are no atomic operations, so a concurrent `get` then `set` can lose an update** (ticket 11). The Canvas `CLAUDE.md` tells Claude to use one key per contribution plus `list()` for tallies. An `increment` operation could be added later if needed.
- **Each render check gets its own channel and an empty in-memory store** (ticket 11), so a candidate page can't change real data. Features see no stored data during the check, which is fine because a feature's own errors don't fail it.
- **`readJson(req, maxBytes)` and `sendJson` live in `http.ts`** (ticket 11) for reuse by any server.

## Restarts

- **The queue and Run records are saved in `<data>/runs.sqlite`** (ticket 13, `RunStore` in `src/run-store.ts`, `node:sqlite` in WAL mode), separate from `services.sqlite`. One row per Run: `seq` (send order), `id`, `state` as plain text with no constraint, and the rest of the Run as JSON without progress. New states and fields need no schema change, but **a new finished state must be added to `FINISHED` in `run-store.ts`**; anything else counts as unfinished.
- **Every state change is saved by `Runs.setState`**, plus once when a Prompt is queued (ticket 13). Always change state through `setState`.
- **`Runs.resume()` runs at startup, before the servers listen** (ticket 13): remove all leftover worktrees and `run/*` branches; reload the 20 most recently finished Runs; restart unfinished Runs from scratch on the latest `main` with the same id and Prompt; re-queue waiting Prompts in order.
- **Resumed Runs wait in a private `resuming` list that starts ahead of the queue, respecting the parallel limit but not the spending pause** (code review, replacing ticket 13's "skip the limit"). They don't appear in the queue snapshot or take the Player's waiting slot, and their saved state is unchanged until they start. Their tokens are spent again, and earlier progress events are lost.
- **Agents must fail when aborted, never return success** (ticket 13). `close()` aborts Runs; one that doesn't Land stays saved as in progress and restarts on the next start.
- **Every Landed commit has a `Run: <id>` trailer, and `resume()` marks an unfinished Run as landed if its id is already on `main`** (code review), so a crash between moving `main` and saving `landed` can't Land a Prompt twice. `history()` is read only if some unfinished Run isn't waiting. `/api/history` entries include `run`.
- **`Runs` needs a `store: RunStore` in its constructor** (ticket 13).

## Spending cap

- **Prices live only in `PRICES` in `src/budget.ts`** (ticket 12), in US dollars per million tokens, taken from the claude-api skill on 2026-10-31: Sonnet 5.5 costs $2 input and $10 output, Opus 5.5 costs $4 and $20. The cost counts input and output tokens only; if the Agent starts reporting cache tokens, extend `TokenUsage` and `PRICES` together.
- **All token usage goes through `Budget.record(model, usage)`** (ticket 12). `Runs.runAgent` calls it on every `usage` event, so a failed Run still costs what it used. Conflict resolution (ticket 08) must call it too.
- **The pause is checked when a Run starts** (ticket 12). `Runs.start` refuses with reason `paused`, and the API answers 503. Replay and Rollback (tickets 09/10) must use the same `budget.spending().paused` check. Runs already in progress are never stopped. The Console is paused when the total is greater than or equal to the cap.
- **The cap comes from `SPENDING_CAP_USD`** (default $10; the `spendingCapUsd` option in tests). `npm run raise-cap -- <dollars>`, run with `docker compose exec platform`, only raises it.
- **The platform and the `raise-cap` command share state only through files in the data folder** (ticket 12). The platform writes `spending.json`, the command writes `spending-cap.json`, both atomically, and the platform re-reads the cap file on every check. The cap in force is the higher of the configured and raised caps. The command reads `SPENDING_CAP_USD` from its own environment, which is correct under `docker compose exec`.
- **`GET /api/spending` returns `{totalUsd, capUsd, paused}`** (ticket 12). The Console polls it every 2 seconds for now; ticket 05's WebSocket can push the same body instead.

## Shared code (code review)

- **New POST endpoints that queue a Run use `queueChange(req, res, fn)` in `console-server.ts`**; the refusal error is `ChangeRefused` (formerly `PromptRefused`).
- **Diff cutting and the "later Prompts" list live in `src/change-context.ts`**, shared by Replay, Rollback and conflict resolution.
- **`positiveNumberFromEnvironment(env, name, fallback, {whole?})` in `src/environment.ts` parses numeric env vars**; `SPENDING_CAP_USD` keeps its own parser because it allows 0.
- **`readNumber` and `writeJsonAtomically` live in `src/data-files.ts`**, for the host-command files.
- **`RESOLUTION_MODEL` is `DEFAULT_MODEL`.**

## Security

- **Every Console API endpoint refuses calls from other origins using `isCrossOrigin()`** (ticket 01). Reuse it on every new endpoint, including the Canvas platform services in ticket 11.
- **Cookies aren't separated by port, so Canvas code can read and overwrite the Console's nickname cookie** (ticket 01). Accepted: nicknames are unauthenticated by design (spec, Out of Scope), and this only matters on the local network. Never put anything secret or privileged in a cookie.
