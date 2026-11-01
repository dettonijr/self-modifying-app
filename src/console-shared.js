// Shared by the Console's pages (the Prompts list and the Run page), served as /console-shared.js.

/** The models a Player can pick, the default first. */
export const MODELS = [
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
];

export const modelName = (model) => MODELS.find((option) => option.value === model)?.label ?? model;

/** Where a Run's page lives. `id` may be a Run id or the commit of a Landed change. */
export const runUrl = (id) => `/runs/${encodeURIComponent(id)}`;

/** A token count rounded with k or M to at most one decimal: "850", "1.2k", "48k", "1.1M". */
export function tokenCount(count) {
  const rounded = (value, suffix) => `${Number(value.toFixed(1))}${suffix}`;
  if (count < 1000) return String(count);
  if (Number((count / 1000).toFixed(1)) < 1000) return rounded(count / 1000, "k");
  return rounded(count / 1_000_000, "M");
}

/**
 * "U (T) tokens · ~$C": the tokens that weren't cached (fresh input, cache
 * writes and output), the total including cache reads, and the estimated
 * cost. "—" for a Run from before usage was recorded.
 */
export function usageLine(usage) {
  if (!usage) return "—";
  const uncached = usage.inputTokens + usage.cacheWriteTokens + usage.outputTokens;
  const cost = usage.cost > 0 && usage.cost < 0.01 ? "<$0.01" : `~$${usage.cost.toFixed(2)}`;
  return `${tokenCount(uncached)} (${tokenCount(uncached + usage.cacheReadTokens)}) tokens · ${cost}`;
}

/** The Run's tokens and cost line, for its details. */
export function usageSpan(run) {
  const element = span("usage", usageLine(run.usage));
  if (!run.usage) element.title = "No usage was recorded for this Run";
  return element;
}

/**
 * A Run's details: model, time, tokens and cost, and its outcome once
 * finished, as nodes to put in its `.details` element.
 */
export function detailsOf(run) {
  const details = [span("model", modelName(run.model))];
  if (run.time) {
    const time = document.createElement("time");
    time.dateTime = run.time;
    time.textContent = new Date(run.time).toLocaleString();
    details.push(" · ", time);
  }
  details.push(" · ", usageSpan(run));
  if (run.state === "landed") details.push(" · ", span("outcome landed", "Landed"));
  if (run.state === "rejected") details.push(" · ", span("outcome error", run.error ?? "Rejected"));
  return details;
}

/**
 * How a Replay Run is labelled: its mark, its kind's name, and what its
 * Player did or is doing to the original ("replayed", "replays").
 * `run.finished` comes from the Console API.
 */
export function changeLabel(run) {
  return { mark: "↻ ", name: "Replay", verb: run.finished ? "replayed" : "replays" };
}

/** Shows `message` (text, or an array of text and nodes) in a status line, as an error if `isError`. */
export function setStatus(element, message, isError = false) {
  element.replaceChildren(...(Array.isArray(message) ? message : [message]));
  element.className = isError ? "error" : "";
}

/** Fills a `<select>` with the models, picking the default. */
export function fillModels(select) {
  select.replaceChildren(...MODELS.map(({ value, label }) => new Option(label, value)));
  select.value = MODELS[0].value;
  return select;
}

export function span(className, text) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

/** A button; `look` is "secondary" (see console.css), primary if omitted. */
export function button(text, onClick, look) {
  const element = document.createElement("button");
  element.type = "button";
  if (look) element.className = look;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

/** Connects to the Console's live updates, reconnecting 1 second after the connection closes. */
export function connectLive(onMessage) {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket.addEventListener("message", (event) => onMessage(JSON.parse(event.data)));
  socket.addEventListener("close", () => setTimeout(() => connectLive(onMessage), 1000));
}

// The open Replay confirmation, kept across re-renders: the Run's id and the picked model.
let confirming;

/**
 * Replay for a Landed Run, asking for confirmation first.
 * `defaultModel()` is the model a Replay starts with; `onQueued` gets
 * `{ ok, run, error, what, started }` once the Console has answered.
 */
export function actionsFor(run, { defaultModel, onQueued }) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const replay = button("Replay", () => {
    confirming = { id: run.id, model: defaultModel() };
    showReplayConfirmation(run, actions, onQueued);
  }, "secondary");
  actions.append(replay);
  if (confirming?.id === run.id) showReplayConfirmation(run, actions, onQueued);
  return actions;
}

function closeConfirmation(confirm) {
  confirming = undefined;
  confirm.remove();
}

/** Asks before a Replay starts, and lets the Player pick its model. */
function showReplayConfirmation(run, actions, onQueued) {
  actions.querySelector(".confirm")?.remove();
  const confirm = document.createElement("span");
  confirm.className = "confirm replay";
  const question = span("", `Replay ${run.nickname}'s Prompt on the current Canvas?`);
  const model = fillModels(document.createElement("select"));
  model.setAttribute("aria-label", "Replay model");
  model.value = confirming.model;
  model.addEventListener("change", () => (confirming.model = model.value));
  const go = button("Yes, replay", async () => {
    closeConfirmation(confirm);
    onQueued(await queueChange("/api/replays", { commit: run.commit, model: model.value }, "Replay", "Claude is working on your Replay…"));
  });
  const cancel = button("Cancel", () => closeConfirmation(confirm), "secondary");
  confirm.append(question, " ", model, " ", go, " ", cancel);
  actions.append(confirm);
}

/**
 * POSTs a change (a Prompt or Replay) to the Console API. Resolves
 * with `{ ok, what, run, started }` once queued, or `{ ok: false, what, error }`
 * if refused; `started` is the status to show if it's already running.
 */
export async function queueChange(url, body, what, started) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, what, error: answer.error ?? `The ${what} was refused` };
  return { ok: true, what, run: answer, started };
}
