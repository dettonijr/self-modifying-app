# Decisions

A running log of details and smaller decisions that matter later: constraints found while building, conventions, known limitations. Larger trade-offs live in `docs/adr/`; vocabulary lives in `GLOSSARY.md`; the plan lives in `.scratch/self-modifying-app/spec.md`.

Newest entries at the bottom. Each entry notes where it came from.

## Runtime and tooling

- **TypeScript runs directly on Node, with no build step** (ticket 01). Node ≥ 22.18 strips types natively, so imports must use `.ts` extensions and only erasable TS syntax is allowed: no `enum`, no `namespace`, no parameter properties.
- **npm, not pnpm** (ticket 01). pnpm isn't installed in the dev environment.
- **The Docker image is the full `node:22`, not a slim variant** (ticket 01). Debian's package mirror is blocked during `docker build` in the sandbox until the host approves it, and the full image already includes git. Ticket 07 will need Chromium and its system libraries in the image, which may require that approval.
- **The dev machine has Chromium's system libraries and Playwright's Chromium installed** (ticket 01). Recorded in `/home/agent/.t3/notes/self-modifying-app/env.md`.

## Platform structure

- **The Agent interface is `run(task)`, returning a stream of `progress` and `usage` events that ends in exactly one `result`** (ticket 01). The running platform uses `unavailableAgent` until ticket 03 adds the real Claude Agent. Tests use `FakeAgent`, with a `Gate` that holds a Run until the test releases it.
- **The test harness is `startTestPlatform()`** (ticket 01). Each test gets a fresh platform on random ports with a temporary data folder. See the README.
- **Run lifecycle lives in `runs.ts`, Landing in `lander.ts`** (ticket 02). `Runs` validates Prompts (500 characters, `MODELS`, nickname from the `nickname` cookie) and drives each Run: worktree at `<data>/worktrees/<runId>` on branch `run/<runId>`, the Agent, the Lander, then removal of the worktree. A Run's final state (`landed`/`rejected`) is published only after its worktree is removed, so a Player who sees it finish can send the next Prompt. Prompts sent while a Run is in progress get 409 for now (ticket 05 replaces this with the queue).
- **Landing moves `main` with `git update-ref` and the expected old value** (ticket 02), so it's a compare-and-swap that fails if `main` moved. It never touches the Canvas repo's working folder, which goes stale after the first Land. Nothing should read or commit through that folder. Ticket 06 must rebase onto the latest `main` before the swap.
- **Commit metadata is git trailers** (ticket 02). The message is `<Kind> by <nickname>: <summary>`, a blank line, the Prompt verbatim, a blank line, then `Kind:`, `Nickname:` and `Model:` trailers. `CanvasRepository.history()` reads only commits with a `Kind` trailer. Replay and Rollback should add their reference to the original commit as another trailer.
- **A Run whose Agent changes nothing is rejected** (ticket 02), with nothing committed.
- **Console API so far** (ticket 02): `POST /api/prompts` `{prompt, model?}` with the nickname cookie returns 202 and the Run, or 400 or 409. `GET /api/runs/:id` and `GET /api/history` (newest first: commit, kind, nickname, prompt, model, time). The Console UI polls these until ticket 05 adds the WebSocket.

## Security

- **Every Console API endpoint refuses calls from other origins using `isCrossOrigin()`** (ticket 01). Reuse it on every new endpoint, including the Canvas platform services in ticket 11.
- **Cookies aren't separated by port, so Canvas code can read and overwrite the Console's nickname cookie** (ticket 01). Accepted: nicknames are unauthenticated by design (spec, Out of Scope), and this only matters on the local network. Never put anything secret or privileged in a cookie.
