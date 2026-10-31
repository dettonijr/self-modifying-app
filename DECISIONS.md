# Decisions

A running log of details and smaller decisions that matter later: constraints found while building, conventions, known limitations. Larger trade-offs live in `docs/adr/`; vocabulary lives in `GLOSSARY.md`; the plan lives in `.scratch/self-modifying-app/spec.md`.

Newest entries at the bottom. Each entry notes where it came from.

## Runtime and tooling

- **TypeScript runs directly on Node, with no build step** (ticket 01). Node ≥ 22.18 strips types natively, so imports must use `.ts` extensions and only erasable TS syntax is allowed: no `enum`, no `namespace`, no parameter properties.
- **npm, not pnpm** (ticket 01). pnpm isn't installed in the dev environment.
- **The Docker image is the full `node:22`, not a slim variant** (ticket 01). Debian's package mirror is blocked during `docker build` in the sandbox until the host approves it, and the full image already includes git. Ticket 07 will need Chromium and its system libraries in the image, which may require that approval.
- **The dev machine has Chromium's system libraries and Playwright's Chromium installed** (ticket 01). Recorded in `/home/agent/.t3/notes/self-modifying-app/env.md`.
- **The dev machine's Node can't run `.ts` files** (ticket 12). Debian's Node build has `process.features.typescript === false`, so `npm start` and `node src/*.ts` fail here; they work in the `node:22` Docker image. Tests must call code in-process instead of spawning `node src/*.ts`.

## Platform structure

- **The Agent interface is `run(task)`, returning a stream of `progress` and `usage` events that ends in exactly one `result`** (ticket 01). The running platform uses `unavailableAgent` until ticket 03 adds the real Claude Agent. Tests use `FakeAgent`, with a `Gate` that holds a Run until the test releases it.
- **The test harness is `startTestPlatform()`** (ticket 01). Each test gets a fresh platform on random ports with a temporary data folder. See the README.
- **Run lifecycle lives in `runs.ts`, Landing in `lander.ts`** (ticket 02). `Runs` validates Prompts (500 characters, `MODELS`, nickname from the `nickname` cookie) and drives each Run: worktree at `<data>/worktrees/<runId>` on branch `run/<runId>`, the Agent, the Lander, then removal of the worktree. A Run's final state (`landed`/`rejected`) is published only after its worktree is removed, so a Player who sees it finish can send the next Prompt. Prompts sent while a Run is in progress get 409 for now (ticket 05 replaces this with the queue).
- **Landing moves `main` with `git update-ref` and the expected old value** (ticket 02), so it's a compare-and-swap that fails if `main` moved. It never touches the Canvas repo's working folder, which goes stale after the first Land. Nothing should read or commit through that folder. Ticket 06 must rebase onto the latest `main` before the swap.
- **Commit metadata is git trailers** (ticket 02). The message is `<Kind> by <nickname>: <summary>`, a blank line, the Prompt verbatim, a blank line, then `Kind:`, `Nickname:` and `Model:` trailers. `CanvasRepository.history()` reads only commits with a `Kind` trailer. Replay and Rollback should add their reference to the original commit as another trailer.
- **A Run whose Agent changes nothing is rejected** (ticket 02), with nothing committed.
- **Console API so far** (ticket 02): `POST /api/prompts` `{prompt, model?}` with the nickname cookie returns 202 and the Run, or 400 or 409. `GET /api/runs/:id` and `GET /api/history` (newest first: commit, kind, nickname, prompt, model, time). The Console UI polls these until ticket 05 adds the WebSocket.

## Spending cap

- **Prices live only in `PRICES` in `src/budget.ts`** (ticket 12), in US dollars per million tokens, taken from the claude-api skill on 2026-10-31: Sonnet 5.5 costs $2 input and $10 output, Opus 5.5 costs $4 and $20. The cost counts input and output tokens only; if the Agent starts reporting cache tokens, extend `TokenUsage` and `PRICES` together.
- **All token usage goes through `Budget.record(model, usage)`** (ticket 12). `Runs.runAgent` calls it on every `usage` event, so a failed Run still costs what it used. Conflict resolution (ticket 08) must call it too.
- **The pause is checked when a Run starts** (ticket 12). `Runs.start` refuses with reason `paused`, and the API answers 503. Replay and Rollback (tickets 09/10) must use the same `budget.spending().paused` check. Runs already in progress are never stopped. The Console is paused when the total is greater than or equal to the cap.
- **The cap comes from `SPENDING_CAP_USD`** (default $10; the `spendingCapUsd` option in tests). `npm run raise-cap -- <dollars>`, run with `docker compose exec platform`, only raises it.
- **The platform and the `raise-cap` command share state only through files in the data folder** (ticket 12). The platform writes `spending.json`, the command writes `spending-cap.json`, both atomically, and the platform re-reads the cap file on every check. The cap in force is the higher of the configured and raised caps. The command reads `SPENDING_CAP_USD` from its own environment, which is correct under `docker compose exec`.
- **`GET /api/spending` returns `{totalUsd, capUsd, paused}`** (ticket 12). The Console polls it every 2 seconds for now; ticket 05's WebSocket can push the same body instead.

## Security

- **Every Console API endpoint refuses calls from other origins using `isCrossOrigin()`** (ticket 01). Reuse it on every new endpoint, including the Canvas platform services in ticket 11.
- **Cookies aren't separated by port, so Canvas code can read and overwrite the Console's nickname cookie** (ticket 01). Accepted: nicknames are unauthenticated by design (spec, Out of Scope), and this only matters on the local network. Never put anything secret or privileged in a cookie.
