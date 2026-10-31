// Shared by the Console's pages (the Prompts list and the Run page), served as /console-shared.js.

/** The models a Player can pick, the default first. */
export const MODELS = [
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
];

export const modelName = (model) => MODELS.find((option) => option.value === model)?.label ?? model;

/** Where a Run's page lives. `id` may be a Run id or the commit of a Landed change. */
export const runUrl = (id) => `/runs/${encodeURIComponent(id)}`;

export const isFinished = (run) => run.state === "landed" || run.state === "rejected";

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

export function button(text, onClick) {
  const element = document.createElement("button");
  element.type = "button";
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

// Whether the spending cap pauses the Console; Send, Replay and Roll back are disabled while it does.
let paused = false;

/** Marks a button as one the spending pause disables. */
export function pausable(element) {
  element.dataset.pausable = "";
  element.disabled = paused;
  return element;
}

/**
 * Keeps the pause up to date: polls `/api/spending` every 2 seconds, disables
 * every pausable button while paused and calls `onSpending` with each answer.
 * Returns a function that refreshes it now.
 */
export function followSpending(onSpending) {
  async function refresh() {
    const response = await fetch("/api/spending");
    if (!response.ok) return;
    const spending = await response.json();
    paused = spending.paused;
    for (const element of document.querySelectorAll("[data-pausable]")) element.disabled = paused;
    onSpending(spending);
  }
  void refresh();
  setInterval(refresh, 2000);
  return refresh;
}

// The open confirmation, kept across re-renders: the Run's id, whether it's a "replay" or a "rollback", and the picked Replay model.
let confirming;

/**
 * Replay and Roll back for a Landed Run, each asking for confirmation first.
 * `defaultModel()` is the model a Replay starts with; `onQueued` gets
 * `{ ok, run, error, what, started }` once the Console has answered.
 */
export function actionsFor(run, { defaultModel, onQueued }) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const replay = pausable(button("Replay", () => {
    confirming = { id: run.id, action: "replay", model: defaultModel() };
    showReplayConfirmation(run, actions, onQueued);
  }));
  const rollback = pausable(button("Roll back", () => {
    confirming = { id: run.id, action: "rollback" };
    showRollbackConfirmation(run, actions, onQueued);
  }));
  actions.append(replay, rollback);
  if (confirming?.id === run.id) {
    if (confirming.action === "replay") showReplayConfirmation(run, actions, onQueued);
    else showRollbackConfirmation(run, actions, onQueued);
  }
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
  const go = pausable(button("Yes, replay", async () => {
    closeConfirmation(confirm);
    onQueued(await queueChange("/api/replays", { commit: run.commit, model: model.value }, "Replay", "Claude is working on your Replay…"));
  }));
  const cancel = button("Cancel", () => closeConfirmation(confirm));
  confirm.append(question, " ", model, " ", go, " ", cancel);
  actions.append(confirm);
}

/** Asks before a Rollback starts. */
function showRollbackConfirmation(run, actions, onQueued) {
  actions.querySelector(".confirm")?.remove();
  const confirm = document.createElement("span");
  confirm.className = "confirm rollback";
  const question = span("", `Roll back ${run.nickname}'s change? Everything that Landed after it is kept.`);
  const go = pausable(button("Yes, roll back", async () => {
    closeConfirmation(confirm);
    onQueued(await queueChange("/api/rollbacks", { commit: run.commit }, "Rollback", "Rolling it back…"));
  }));
  const cancel = button("Keep it", () => closeConfirmation(confirm));
  confirm.append(question, " ", go, " ", cancel);
  actions.append(confirm);
}

async function queueChange(url, body, what, started) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, what, error: answer.error ?? `The ${what} was refused` };
  return { ok: true, what, run: answer, started };
}
