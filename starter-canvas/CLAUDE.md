# Canvas conventions

This folder is the Canvas: a website that changes in response to Prompts sent by Players. Several Runs edit it in parallel and their changes are combined, so follow these conventions to keep features from colliding.

## Plain files, no build step

- Write plain HTML, CSS and JavaScript modules (`<script type="module">`). There is no build step: no bundler, no TypeScript, no `npm install`. The files are served exactly as committed.
- Load libraries and fonts from CDNs. Register JavaScript libraries in the import map in `index.html` (`<script type="importmap">`) and import them by name, e.g. add `"canvas-confetti": "https://esm.sh/canvas-confetti@1"` and `import confetti from "canvas-confetti";`.

## One folder per feature

- Every feature lives in its own folder under `features/<feature-name>/`, holding all of its HTML, CSS, JS and assets. See `features/hello/` for an example.
- Change other features' folders only when the Prompt is about them.
- `index.html` is the entry page and only lists features: the title, the import map, the shared stylesheet, and one `<section id="<feature-name>" class="feature">` per feature that pulls in that feature's stylesheet and module. Don't put feature code in it.

## Every change works on phones

Players play on phones as well as computers, so every feature and every page must work on a phone:

- Layouts fit narrow screens (from 360px wide) without scrolling sideways. Prefer flexible widths (`%`, `fr`, `min()`, `max-width: 100%`) over fixed pixel widths, and let content wrap.
- Touch works everywhere a mouse does. Use pointer events (`pointerdown`, `pointermove`, `pointerup`) rather than mouse-only events (`mousedown`, `mousemove`, `mouseup`), and set `touch-action: none` on things you drag so the page doesn't scroll instead.
- Nothing only works on hover. Anything shown on hover must also be reachable by tapping.
- Tap targets (buttons, links, controls) are at least 44×44px.
- Every page has `<meta name="viewport" content="width=device-width, initial-scale=1">` in its `<head>`.

## Shared styling through theme variables

- `theme.css` defines a small set of theme variables (`--color-*`, `--font-*`, `--radius`, `--space`). Features use them rather than hard-coded colours and fonts, so the whole Canvas can be restyled in one place.
- Change the theme variables only when the Prompt asks for an overall look change.

## The platform script

- The platform injects its own script into every page it serves (the "changing the page" banner and automatic reload). Don't try to edit, remove or work around it.
- Paths under `/__platform/` belong to the platform; don't create files there.
- Pages are served at URLs that include the version, like `/@<commit>/index.html`. Refer to the Canvas's own files with relative URLs (`theme.css`, `features/x/x.js`, `./y.js`), never ones starting with `/`, so every file a page loads comes from the same version.

## Shared and real-time data: the platform services

The Canvas has no server code of its own, and you can't add any. Features that need a backend (a live chat, cursors, votes, a guestbook, high scores, a counter) use the two platform services instead, through the client library at `/__platform/services.js` (one of the few absolute URLs you should use):

```js
import { channel, store } from "/__platform/services.js";

// Real-time channel: messages reach every viewer of the Canvas, the sender included.
const chat = channel("chat");
const stop = chat.onMessage((message) => showLine(message.nickname, message.text)); // stop() unsubscribes
await chat.send({ nickname, text }); // any JSON value, up to 16 KB

// Key-value store: shared by every viewer and kept across every change to the Canvas.
const db = store("chat");
await db.set("line/" + Date.now(), { nickname, text }); // any JSON value, up to 64 KB; keys up to 256 characters
const title = await db.get("title"); // undefined if missing
const lines = await db.list("line/"); // [{ key, value }] sorted by key; list() returns everything
await db.delete("title");
```

- Pass the feature's folder name to `channel()` and `store()`. Each feature has its own channel and its own keys, so features don't see each other's messages or overwrite each other's data. Use another feature's name only when the Prompt is about sharing its data.
- Channel messages aren't stored: a viewer only gets messages sent while their page is open. To show history (chat logs, guestbooks), also save each item in the store and load it with `list()` when the page opens.
- Stored data isn't part of the Canvas's files, so it survives every change and Replay, including removing the feature. Code may find data saved by an older version of the feature, so read it defensively.
- There are no transactions: `get` then `set` from two viewers at once can lose an update. For tallies, prefer one key per contribution (e.g. `vote/<random id>`) counted with `list()`, over one shared counter.
- Pages reload when a change Lands, so subscribe and load data when the module starts.
