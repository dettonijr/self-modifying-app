# 02: "View the Canvas at this version" stays on that version, read-only

**What to build:** The Run page's "View the Canvas at this version" link opens an older Canvas version and keeps it open. Today the page loads and immediately jumps back to the live Canvas, because the injected platform script treats any page whose commit differs from `main` as a stale tab (on `hello`) and reloads on every Land.

- **Pinned views.** The link opens `/@<commit>/?version`. When the platform script sees that marker it doesn't follow the live Canvas: no catch-up reload on `hello`, no reload on Land, and no "changing the page…" banners. Normal tabs keep catching up exactly as today. The marker survives navigation inside the pinned version where practical (links within the old version keep `?version`), and is otherwise at least on the entry page.
- **Banner.** Pinned views show a fixed banner, "Older version: view only · Go to the live Canvas", with a link to the live Canvas. It comes from the **current** platform script, which the Canvas server injects into every HTML page it serves, whatever the commit, and it sits in the platform's shadow root, so an old version's own code and CSS can't hide or restyle it. This must hold for versions committed before this change.
- **Read-only, in two layers.** A pinned view sees live stored data and live channel messages, but can't change anything:
  1. the platform's services library (served fresh from `/__platform/`, never from git) drops `set`, `delete` and `send` in a pinned view, quietly (no errors thrown into the old code)
  2. the server refuses every store write/delete and channel send whose `Referer` is a pinned-version address (`/@<commit>/…?version` or any `/@<commit>/` page not on the live commit), whatever code made the request; refused with 403 and logged
- **Unchanged:** the live Canvas, normal tabs' catch-up and reloads, the render check's isolated store and channel, and the Console.

Known, accepted limits: code that deliberately strips `Referer` could still write (only Claude writes Canvas code, on a local network); a normal tab in the second between a Land and its reload still runs old code against live data, as today. A separate origin for old versions (watertight, third port) was considered and rejected as overkill.

See `DECISIONS.md` ("Canvas serving and live reload", "Platform services", "Run page", "Look and feel").

**Blocked by:** 01 (done first at the user's request)

**Status:** ready-for-agent

- [ ] Opening "View the Canvas at this version" shows that version and it stays there after the platform's `hello` and after a new Land (Playwright, waiting past both)
- [ ] A normal tab at an old commit still catches up to the live Canvas
- [ ] Pinned views show "Older version: view only · Go to the live Canvas", and the link goes live
- [ ] The banner appears on a version committed before this change, and old-version CSS can't hide it
- [ ] In a pinned view, store reads return live data, and `set`/`delete`/`send` through the library change nothing and throw nothing
- [ ] A direct store write or channel send with a pinned-version `Referer` gets 403 and changes nothing; the same request from the live Canvas still works
- [ ] Colours from the palette only; banner meets contrast and tap-target rules on phones
