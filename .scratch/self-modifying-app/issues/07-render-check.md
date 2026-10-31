# 07: Render check

**What to build:** Before a change Lands, the platform loads the candidate commit in headless Chromium (Playwright). If the page is blank or throws a fatal error, the change doesn't Land: `main` stays put and the Run is rejected with the reason "Canvas didn't render", for now. Conflict handling in 08 will route this failure through its resolution path. A change that breaks a feature but still renders Lands normally; per-feature checks are deliberately out of scope.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A fake Agent edit that produces a blank page doesn't Land, and `main` is unchanged
- [ ] A fake Agent edit that throws a fatal error on load doesn't Land
- [ ] A fake Agent edit that breaks a feature but still renders the page Lands
- [ ] The rejection reason is shown in the Console history or Run outcome
