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

Claude needs the host's Anthropic API key in `ANTHROPIC_API_KEY` (in the environment or an `.env` file next to `docker-compose.yml`). Without it every Run fails. The key is only handed to Claude's own process; it never goes into the Canvas or the Console. Each Run is stopped and rejected after `RUN_TIME_LIMIT_SECONDS` (default 600) or `RUN_TOKEN_LIMIT` tokens (default 2,000,000, counting input, cached input and output).

### Spending cap

Every Run's token usage is converted to cost with the per-model prices in `src/budget.ts` and added to a running total, shown in the Console. When the total reaches the cap, the Console pauses: new Prompts are refused, and Runs already in progress finish. The cap is `SPENDING_CAP_USD` (default $10). To raise it while the platform runs:

```sh
docker compose exec platform npm run raise-cap -- 20
```

It can only go up, and the Console resumes at once. The total (`spending.json`) and the raised cap (`spending-cap.json`) live in the data volume, so both survive restarts.

Without Docker you need Node 22.18 or later, which runs the TypeScript directly with no build step, and git: `npm install && npm start`. The data goes to `./data`.

## Layout

- `src/`: the platform. `platform.ts` starts everything. The main pieces are the `canvas-repository.ts` git repo, the `canvas-server.ts` and `console-server.ts` servers (separate origins, the Console UI is `console-page.html`), and the `agent.ts` Agent interface. `claude-agent.ts` is the real Agent: Claude through the Claude Agent SDK, with only file tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) confined to the Run's worktree, no settings, hooks or MCP servers from disk, and the time and token caps.
- A Prompt becomes a Run in `runs.ts`: it validates the Prompt, gives the Run a worktree branched from `main` (under `<data>/worktrees/`), lets the Agent edit it, hands it to the Lander and removes the worktree whatever happens. `lander.ts` commits the worktree and moves `main` to that commit, so the change is live. Every commit records its metadata as git trailers (`Kind`, `Nickname`, `Model`) after the Prompt text, and the history is read back from them.
- `budget.ts` records token usage, prices it and decides whether the Console is paused. `cli.ts` (logic in `host-commands.ts`) holds the host's commands, such as `raise-cap`.
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

- `startTestPlatform()` (`test/support/harness.ts`) starts a fresh platform on random ports with a temporary data folder, so tests run in parallel. It gives you `consoleApi(path)`, `fetchCanvas(path)`, `sendPrompt({ nickname, prompt, model? })`, `waitForRun(id)` (until it has Landed or been rejected), `canvasRepoDir` and `close()`. Pass `dataDir` to restart on the same data.
- The only substitution is the Agent. `FakeAgent` (`test/support/fake-agent.ts`) plays one queued script per Run. A script can edit files (`writeFile`, `deleteFile`), report `progress` and `usage`, throw to crash, or wait on a `Gate` until the test calls `release()`. It can also hang until the Run is aborted (`aborted()`). `agent.tasks` records what each Run was asked to do, and `agent.started(n)` resolves once n Runs have started.
- `test/claude-agent.test.ts` tests the real Agent with the SDK's `query` replaced by a scripted message stream.
- `test/claude-smoke.test.ts` sends "change the title to Hello" through the real Claude and checks it Lands. It spends real tokens, so it's skipped unless both `ANTHROPIC_API_KEY` and `CLAUDE_SMOKE_TEST=1` are set.
