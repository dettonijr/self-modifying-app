// The platform script, injected into every page the Canvas server serves.
// Claude can't edit it: it lives outside the Canvas repo. It listens to the
// Canvas real-time channel for platform events: banners while Runs are in
// progress, and a reload with a "changed by" notice when a change Lands.
(() => {
  const NOTICE_KEY = "__platform.notice";
  const NOTICE_MS = 6000;
  const pinned = /^\/@([0-9a-f]{40})(\/.*)$/.exec(location.pathname);
  const pageCommit = pinned?.[1];
  // The page's live URL, which the Canvas server redirects to the newest commit.
  const liveUrl = () => (pinned ? pinned[2] : location.pathname) + location.search + location.hash;

  // Shadow DOM keeps the Canvas's styles and scripts' selectors away from the platform's UI.
  // Its `!important` rules on `:host` also beat the Canvas's own `!important` rules on the host element.
  // Colours come from the platform's palette; the overlay stays hidden until it has loaded.
  const host = document.createElement("platform-overlay");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<link rel="stylesheet" href="/__platform/palette.css"><style>
    :host { all: initial !important; display: block !important; position: fixed !important; inset: 0 0 auto 0 !important; z-index: 2147483647 !important; pointer-events: none !important; visibility: visible !important; opacity: 1 !important; transform: none !important; filter: none !important; }
    .overlay { display: grid; gap: 0.5rem; justify-items: end; padding: 0.75rem; font: 600 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--color-text); }
    .overlay:not(.ready) { visibility: hidden; }
    p { margin: 0; display: flex; align-items: center; gap: 0.6rem; max-width: min(32rem, 100%); padding: 0.6rem 1rem; border-radius: 14px; border: 1px solid var(--color-border-strong); background: var(--color-surface); color: var(--color-text); box-shadow: 0 6px 24px var(--color-shadow); overflow-wrap: anywhere; }
    p.banner::before { content: ""; flex: none; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--color-accent); animation: pulse 1.2s ease-in-out infinite; }
    p.notice { border-color: var(--color-success); border-left-width: 5px; }
    @keyframes pulse { 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { p.banner::before { animation: none; } }
    @media (max-width: 30rem) { .overlay { justify-items: stretch; padding: 0.5rem; } p { max-width: none; } }
  </style><div class="overlay" data-palette></div>`;
  const overlay = root.querySelector(".overlay");
  const ready = () => overlay.classList.add("ready");
  root.querySelector("link").addEventListener("load", ready);
  root.querySelector("link").addEventListener("error", ready);
  const attach = () => document.documentElement.append(host);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  /** @type {Map<string, HTMLElement>} */
  const banners = new Map();
  function showBanner(runId, nickname) {
    if (banners.has(runId)) return;
    const banner = message(`${nickname} is changing the page…`, "banner");
    banner.setAttribute("role", "status");
    banners.set(runId, banner);
  }
  function removeBanner(runId) {
    banners.get(runId)?.remove();
    banners.delete(runId);
  }
  function message(text, kind) {
    const element = document.createElement("p");
    element.className = kind;
    element.textContent = text;
    overlay.append(element);
    return element;
  }

  const reload = (notice) => {
    if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
    location.replace(liveUrl());
  };

  const notice = sessionStorage.getItem(NOTICE_KEY);
  if (notice) {
    sessionStorage.removeItem(NOTICE_KEY);
    const element = message(notice, "notice");
    element.setAttribute("role", "status");
    setTimeout(() => element.remove(), NOTICE_MS);
  }

  const events = new EventSource("/__platform/events");
  // The services library (/__platform/services.js) shares this stream rather than opening another.
  Object.defineProperty(window, "__platformEvents", { value: events });
  events.addEventListener("platform", (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "hello") {
      // A page from an older commit (a bookmark, or a Land missed while disconnected) catches up.
      if (pageCommit && event.commit !== pageCommit) return reload();
      for (const runId of [...banners.keys()]) removeBanner(runId);
      for (const run of event.running) showBanner(run.runId, run.nickname);
    } else if (event.type === "run-started") {
      showBanner(event.runId, event.nickname);
    } else if (event.type === "rejected") {
      removeBanner(event.runId);
    } else if (event.type === "landed") {
      removeBanner(event.runId);
      if (event.commit !== pageCommit) reload(`✨ changed by ${event.nickname}: '${event.prompt}'`);
    }
  });
})();
