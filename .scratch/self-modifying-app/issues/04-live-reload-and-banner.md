# 04: Live reload and the Canvas banner

**What to build:** The Canvas server injects a platform script into every HTML page it serves. Claude can't edit it, and the Canvas `CLAUDE.md` says so. The script connects to a real-time channel that carries platform events. During a Run, everyone viewing the Canvas sees a banner: "*nickname* is changing the page…". When a change Lands, every viewer reloads automatically and then sees a short notice: "✨ changed by *nickname*: '*prompt*'". Asset URLs include the commit hash, so a reload never shows cached files and nobody sees a half-updated Canvas.

**Blocked by:** 02

**Status:** resolved

- [ ] Served Canvas HTML includes the platform script, even if the Canvas's own files change
- [ ] A connected viewer receives a "Run started" event with the nickname and shows the banner
- [ ] A connected viewer receives a reload event when a change Lands, reloads and shows the "changed by" notice
- [ ] After a reload, the viewer gets the files of the new commit, not cached ones
