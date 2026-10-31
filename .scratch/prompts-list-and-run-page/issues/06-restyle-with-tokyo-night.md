# 06: Restyle every page with the Tokyo Night palette

**What to build:** Every platform page gets a polished look based on the **Tokyo Night (Night)** palette, dark only for now, and works well on phones:

- the Console with the Prompts list
- the Run page
- the platform's banner and "changed by…" notice on the Canvas
- the starter Canvas

**One swappable palette for the platform.** The Console, the Run page and the Canvas banner/notice share one palette file of named colour variables, such as background, surface, text, muted text, accent, success, warning and danger, mapped to Tokyo Night Night's colours. Every colour in those pages comes from these variables, so changing the palette means editing that one file; adding Day or another theme later is just another set of values. The banner and notice keep their shadow root, so the Canvas's CSS still can't touch them.

**The starter Canvas gets its own copy.** The starter Canvas's theme variables are set to the same Tokyo Night colours. The Canvas belongs to the Players, so it doesn't import the platform's palette, and Prompts can change its look freely. This only affects new games; an existing Canvas keeps what Players made.

**Readable buttons.** Buttons have large text, strong contrast (at least WCAG AA against their background), clear labels, and an obvious disabled state. Destructive actions such as "Yes, roll back" are visually distinct.

**Phones first.** All pages fit narrow screens (from 360px wide) without scrolling sideways, tap targets are at least 44×44px, text stays readable without zooming, and nothing depends on hover. Desktop layouts can use the extra width.

See spec: `.scratch/prompts-list-and-run-page/spec.md` (the pages this restyles) and `DECISIONS.md` (Look and feel).

**Blocked by:** 01, 02, 03, 04, 05

**Status:** ready-for-agent

- [ ] The Console, Run page, Canvas banner and notice use Tokyo Night colours, all from one palette file of named variables
- [ ] Changing a value in the palette file changes it on every platform page (tested by swapping one variable)
- [ ] The starter Canvas's theme variables use Tokyo Night colours, without importing the platform palette
- [ ] Buttons meet WCAG AA contrast, have an obvious disabled state, and destructive confirmations look distinct
- [ ] At 360×740 and 390×844, no page scrolls sideways and every button is at least 44×44px (Playwright)
- [ ] The Canvas banner and notice still can't be restyled by Canvas CSS
- [ ] Existing behaviour and tests are unchanged apart from styling
