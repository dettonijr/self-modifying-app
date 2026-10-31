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
  const host = document.createElement("platform-overlay");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host { all: initial; position: fixed; inset: 0.75rem 0.75rem auto auto; z-index: 2147483647; display: grid; gap: 0.5rem; justify-items: end; pointer-events: none; font: 14px/1.4 system-ui, sans-serif; }
    p { margin: 0; padding: 0.5rem 0.9rem; border-radius: 999px; background: #1d1b2fe6; color: #fff; box-shadow: 0 2px 10px #0004; max-width: 32rem; overflow-wrap: anywhere; }
  </style>`;
  const attach = () => document.documentElement.append(host);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  /** @type {Map<string, HTMLElement>} */
  const banners = new Map();
  function showBanner(runId, nickname) {
    if (banners.has(runId)) return;
    const banner = message(`${nickname} is changing the page…`);
    banner.setAttribute("role", "status");
    banners.set(runId, banner);
  }
  function removeBanner(runId) {
    banners.get(runId)?.remove();
    banners.delete(runId);
  }
  function message(text) {
    const element = document.createElement("p");
    element.textContent = text;
    root.append(element);
    return element;
  }

  const reload = (notice) => {
    if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
    location.replace(liveUrl());
  };

  const notice = sessionStorage.getItem(NOTICE_KEY);
  if (notice) {
    sessionStorage.removeItem(NOTICE_KEY);
    const element = message(notice);
    element.setAttribute("role", "status");
    setTimeout(() => element.remove(), NOTICE_MS);
  }

  const events = new EventSource("/__platform/events");
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
