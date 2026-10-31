# 07: Canvas changes must work on phones

**What to build:** Every change Players ask for should be playable on a phone.

- **Rules for Claude.** The starter Canvas's `CLAUDE.md` and the platform's rules for the Agent require every change to work on phones: layouts that fit narrow screens without scrolling sideways, touch working everywhere a mouse does (pointer events rather than mouse-only), nothing that only works on hover, tap targets big enough for fingers, and a mobile viewport meta tag on every page.
- **Render check at phone size too.** The render check loads the candidate at desktop size as today, and also at phone size (about 390×844, touch enabled). It rejects the change if the page is blank or crashes at either size: the same rules as today, applied twice. Layout isn't checked, so an awkward but working mobile layout still Lands.

This doesn't touch the Console, so it can be built in parallel with tickets 01–05.

See `DECISIONS.md` (Look and feel; Render check).

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The starter Canvas `CLAUDE.md` and the Agent's platform rules contain the mobile rules
- [ ] The starter Canvas has a mobile viewport meta tag and fits a 390px-wide screen without scrolling sideways
- [ ] A candidate that renders on desktop but is blank or crashes at phone size doesn't Land
- [ ] A candidate with an awkward but working mobile layout still Lands
- [ ] A render-check failure at phone size goes through the existing conflict-fix path, with a problem description that says it failed on a phone-sized screen
