// The platform services client library, served at /__platform/services.js.
// Canvas features import it to get a real-time channel and a key-value store
// without any server code of their own (docs/adr/0002). Like the platform
// script, it lives outside the Canvas repo, so Claude can't edit it.

const BASE = "/__platform";
const FEATURE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function checkFeature(feature) {
  if (typeof feature !== "string" || !FEATURE_NAME.test(feature)) {
    throw new TypeError(`Feature names are lowercase letters, digits, "-" and "_", like the feature's folder: got ${JSON.stringify(feature)}`);
  }
  return feature;
}

// A pinned view of an older version (`/@<commit>/…?version`) is read-only: it
// sees live data and messages, but writes and sends are quietly dropped, so
// old code carries on as if they worked. The Canvas server refuses them too.
const viewOnly = /^\/@[0-9a-f]{40}\//.test(location.pathname) && new URLSearchParams(location.search).has("version");

// One event stream per page, shared with the platform script when it's there.
let events;
function eventStream() {
  events ??= globalThis.__platformEvents ?? new EventSource(`${BASE}/events`);
  return events;
}

async function call(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Platform service ${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

/**
 * A feature's real-time channel. Messages are any JSON value and reach every
 * viewer of the Canvas on this feature's channel, the sender included.
 */
export function channel(feature) {
  checkFeature(feature);
  const path = `/channel/${feature}`;
  return {
    async send(message) {
      if (viewOnly) return;
      await call("POST", path, { message });
    },
    /** Calls `listener(message)` for each message; returns a function that stops listening. */
    onMessage(listener) {
      const handler = (event) => {
        const data = JSON.parse(event.data);
        if (data.feature === feature) listener(data.message);
      };
      const stream = eventStream();
      stream.addEventListener("feature", handler);
      return () => stream.removeEventListener("feature", handler);
    },
  };
}

/**
 * A feature's key-value store. Values are any JSON value. Keys belong to the
 * feature, so two features can use the same key without clashing. Data is kept
 * across every change to the Canvas, including Rollback and Replay.
 */
export function store(feature) {
  checkFeature(feature);
  const keyPath = (key) => {
    if (typeof key !== "string" || key === "") throw new TypeError("Keys are non-empty strings");
    return `/store/${feature}/${encodeURIComponent(key)}`;
  };
  return {
    /** The value stored at `key`, or `undefined`. */
    async get(key) {
      const response = await call("GET", keyPath(key));
      return response.status === 404 ? undefined : (await response.json()).value;
    },
    async set(key, value) {
      const path = keyPath(key);
      if (value === undefined) throw new TypeError("Use delete() to remove a key");
      if (viewOnly) return;
      await call("PUT", path, { value });
    },
    async delete(key) {
      const path = keyPath(key);
      if (viewOnly) return;
      await call("DELETE", path);
    },
    /** Every entry whose key starts with `prefix` (all of them by default), sorted by key: `[{ key, value }]`. */
    async list(prefix = "") {
      const response = await call("GET", `/store/${feature}/?prefix=${encodeURIComponent(prefix)}`);
      return (await response.json()).entries;
    },
  };
}
