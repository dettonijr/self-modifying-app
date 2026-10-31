# 01: Platform skeleton: the starter Canvas served from git

**What to build:** The host runs `docker compose up` and gets a running platform. The Console and the Canvas are served on separate origins (different ports, listening on all interfaces). On first start, the Canvas repo is created in the data volume with the starter Canvas:

- a title
- the per-feature folder structure
- one example feature
- the Canvas `CLAUDE.md`, which holds the conventions for Claude: plain HTML, CSS and JS modules with no build step, CDN libraries through import maps, one folder per feature, an entry page that only lists features, and theme variables for shared styling

The Canvas server serves files straight from the commit `main` points to, read from git objects rather than a working folder. The Console shows a placeholder page.

This ticket also sets up the test harness everything else builds on. A test can:

- start a fresh platform on random ports with a temporary data folder
- talk to the Console API
- fetch Canvas pages
- plug in a scripted fake Agent behind the Agent interface (the interface is defined here and used from 02 onwards)

The stack is TypeScript on Node, with Vitest and Playwright.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] `docker compose up` starts the platform, with the Console and Canvas reachable from another device on the network
- [ ] The first start creates the Canvas repo with the starter Canvas; later starts reuse it
- [ ] The Canvas server serves the starter Canvas from `main`'s commit, and changing the working folder without committing has no effect on what's served
- [ ] The test harness can start isolated platforms in parallel, and the Agent interface plus a scripted fake Agent exist
- [ ] Origin isolation test (Playwright): a Canvas page can't make credentialed calls to the Console origin
