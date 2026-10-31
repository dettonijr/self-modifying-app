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

Without Docker you need Node 22.18 or later, which runs the TypeScript directly with no build step, and git: `npm install && npm start`. The data goes to `./data`.

## Layout

- `src/`: the platform. `platform.ts` starts everything. The main pieces are the `canvas-repository.ts` git repo, the `canvas-server.ts` and `console-server.ts` servers (separate origins), and the `agent.ts` Agent interface.
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

- `startTestPlatform()` (`test/support/harness.ts`) starts a fresh platform on random ports with a temporary data folder, so tests run in parallel. It gives you `consoleApi(path)`, `fetchCanvas(path)`, `canvasRepoDir` and `close()`. Pass `dataDir` to restart on the same data.
- The only substitution is the Agent. `FakeAgent` (`test/support/fake-agent.ts`) plays one queued script per Run. A script can edit files (`writeFile`, `deleteFile`), report `progress` and `usage`, throw to crash, or wait on a `Gate` until the test calls `release()`. It can also hang until the Run is aborted (`aborted()`). `agent.tasks` records what each Run was asked to do, and `agent.started(n)` resolves once n Runs have started.
