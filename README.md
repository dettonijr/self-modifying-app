<img src="assets/icon.svg" width="64" height="64" alt="">

# self-modifying-app

Created in [T3 Code](https://t3.codes).

A game where anyone on the local network sends Prompts and Claude rewrites a website, the Canvas, in response. See `GLOSSARY.md` for the vocabulary and `docs/adr/` for the main decisions.

## Running it

```sh
docker compose up --build
```

- Console: `http://<host-ip>:3000`
- Canvas: `http://<host-ip>:3001`

Both listen on all interfaces, so other devices on the network can join. Set `CONSOLE_PORT` or `CANVAS_PORT` to change the published ports. The Canvas repo lives in the `data` volume. It's created with the starter Canvas (`starter-canvas/`) on first start and reused afterwards.

Claude needs the host's Anthropic API key in `ANTHROPIC_API_KEY` (in the environment or an `.env` file next to `docker-compose.yml`). Without it every Run fails. The key is only handed to Claude's own process; it never goes into the Canvas or the Console. Each Run is stopped and rejected after `RUN_TIME_LIMIT_SECONDS` (default 600) or `RUN_TOKEN_LIMIT` tokens (default 2,000,000, counting input, cached input and output). There's no game-wide spending cap: these per-Run limits are the safety net. Up to `MAX_PARALLEL_RUNS` Runs (default 3) work at once to start with; further Prompts wait in the queue. Lowering the limit is the first thing to try if parallel Runs conflict too often. To change it while the platform runs:

```sh
docker compose exec platform npm run set-parallel-runs -- 2
```

It can go up or down and takes effect within a second. Lowering it never stops Runs in progress; waiting Prompts just start once fewer Runs are in progress than the new limit. The setting (`parallel-runs.json`) lives in the data volume and, once set, wins over `MAX_PARALLEL_RUNS`, including after a restart. Runs that were in progress when the platform stopped start again first, ahead of the queue, within the limit.

Without Docker you need Node 22.18 or later, which runs the TypeScript directly with no build step, and git: `npm install && npm start`. The data goes to `./data`.

## Layout

- `src/`: the platform. `platform.ts` starts everything. The main pieces are the `canvas-repository.ts` git repo, the `canvas-server.ts` and `console-server.ts` servers (separate origins, the Console UI is `console-page.html`), and the `agent.ts` Agent interface. `claude-agent.ts` is the real Agent: Claude through the Claude Agent SDK, with only file tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) confined to the Run's worktree, no settings, hooks or MCP servers from disk, and the time and token caps. The Canvas server redirects pages to `/@<commit>/…` so a page and its files come from one commit, injects `canvas-platform-script.js` into every page, and streams platform events to viewers from `canvas-channel.ts` (Server-Sent Events at `/__platform/events`). It also hosts the platform services for Canvas features (`platform-services.ts`): a per-feature real-time channel on that same stream and a per-feature key-value store (`key-value-store.ts`, SQLite at `<data>/services.sqlite`), used through the client library `canvas-services.js` at `/__platform/services.js`.
- A Prompt becomes a Run in `runs.ts`: it validates the Prompt, queues it (one waiting Prompt per Player; up to the parallel Run limit at once), gives the Run a worktree branched from `main` (under `<data>/worktrees/`), lets the Agent edit it, hands it to the Lander and removes the worktree whatever happens. `lander.ts` Lands finished Runs one at a time, in the order they finish: it commits the worktree, rebases it onto the current `main` (a conflict rejects the Run), render-checks it and moves `main` to it, so the change is live. Every commit records its metadata as git trailers (`Kind`, `Nickname`, `Model`, `Run`, and `Original`/`Original-Nickname` for a Replay or Rollback) after the Prompt text, and the history is read back from them. What differs between a Prompt, a Replay and a Rollback (model choice, a mechanical revert first, the Agent's instructions) is gathered in `change-kinds.ts`.
- The Console page shows one Prompts list: every Run ever sent (Prompts, Replays and Rollbacks, waiting, in progress, Landed or rejected), newest first, kept forever. Landed changes on `main` with no Run record (from before Runs were saved) are listed as Landed entries. `GET /api/runs` returns the list as `RunSummary`s (`runs.ts`); the page follows it live over the `/api/live` WebSocket: a `snapshot` (`{queue, runs}`, `runs` being the whole list) on connecting, then a `run` message with a Run's new summary whenever it changes, plus `queue`, `progress` and `log` messages (`RunsEvent` in `runs.ts`).
- Clicking an entry (anywhere but its buttons) opens its Run page at `/runs/<id>` on the Console, where `<id>` is a Run id or the commit of a Landed change. It shows the Run's details, live, with Replay and Roll back once Landed, links a Replay's or Rollback's original change, and has sections for the log and changed files. The log lists, with times, what Claude said (the Agent's `message` events: text replies only, never tool calls) and each platform step, from Queued to Landed or rejected with the reason; it's saved in the Run store as it happens, with no limit, and appended live. `GET /api/runs/<id>` serves the full Run, log included. Other origins can't fetch or embed the page, but a link to it opens anywhere. Code shared by both pages is in `src/console-shared.js`, served as `/console-shared.js`.
- `pricing.ts` holds the per-model token prices (`PRICES`, `costOf`). `cli.ts` (logic in `host-commands.ts`) holds the host's command, `set-parallel-runs` (`parallel-limit.ts`).
- `starter-canvas/`: what a new Canvas repo starts with, including the Canvas `CLAUDE.md` conventions for Claude.
- `test/`: the test suite. `test/support/` holds the harness.

## Testing

```sh
npm install
npx playwright install chromium   # once; add `--with-deps` on a fresh Linux machine
npm test                          # Vitest, including the Playwright browser tests
npm run typecheck
```

Tests check external behaviour only, through the Console API and the Canvas server, on a whole platform:

- `startTestPlatform()` (`test/support/harness.ts`) starts a fresh platform on random ports with a temporary data folder, so tests run in parallel. It gives you `consoleApi(path)`, `fetchCanvas(path)`, `sendPrompt({ nickname, prompt, model? })`, `waitForRun(id)` (until it has Landed or been rejected), `live()` (a Console WebSocket client with `messages` and `waitFor(match)`), `canvasRepoDir` and `close()`. Pass `dataDir` to restart on the same data.
- The only substitution is the Agent. `FakeAgent` (`test/support/fake-agent.ts`) plays one queued script per Run. A script can edit files (`writeFile`, `deleteFile`), report `progress` and `usage`, say something as Claude with `message(text)`, throw to crash, or wait on a `Gate` until the test calls `release()`. It can also hang until the Run is aborted (`aborted()`). `agent.tasks` records what each Run was asked to do, and `agent.started(n)` resolves once n Runs have started.
- `test/claude-agent.test.ts` tests the real Agent with the SDK's `query` replaced by a scripted message stream.
- `test/claude-smoke.test.ts` sends "change the title to Hello" through the real Claude and checks it Lands. It spends real tokens, so it's skipped unless both `ANTHROPIC_API_KEY` and `CLAUDE_SMOKE_TEST=1` are set.
