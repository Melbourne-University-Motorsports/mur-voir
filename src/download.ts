// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// File > Download runs…: lists the MUR run archive, downloads runs and opens one. The main process
// (Lite's page or Electron) talks to the archive; this page only shows state and sends requests.

import NamedMessage from "./shared/NamedMessage";
import type { ArchiveRun } from "./shared/mur/archive";
import type { JobState } from "./shared/mur/archiveJob";
import {
  dayHeading,
  faultColumn,
  FaultGroup,
  faultLineText,
  faultListText,
  faultTimesText,
  groupByDay,
  groupFaults,
  matchesFilter,
  mergeRuns,
  OpenChoice,
  openChoices,
  pruneSelection,
  runActivityText,
  runClock,
  RunFilter,
  runLabel,
  runLengthText,
  runNumbersText,
  runStatus,
  selectionActions,
  sizeText,
  todayIn,
  toggleRun
} from "./shared/mur/archiveView";

const REFRESH_MS = 10_000;
const DONE_DISMISS_MS = 2500;

const RUNS = document.querySelector(".runs") as HTMLElement;
const WHAT = document.querySelector(".footer .what") as HTMLElement;
const FAULT_LIST = document.querySelector(".fault-list") as HTMLElement;
const COPY_BUTTON = document.querySelector(".copy-link") as HTMLButtonElement;
const DOWNLOAD_BUTTON = document.querySelector(".download") as HTMLButtonElement;
const OPEN_BUTTON = document.querySelector(".open") as HTMLButtonElement;
const CLOSE_BUTTON = document.querySelector(".header .close") as HTMLButtonElement;
const FILTER_BUTTONS = Array.from(document.querySelectorAll(".filters button")) as HTMLButtonElement[];
const SCRIM = document.querySelector(".scrim") as HTMLElement;
const DIALOG_TEXT = document.querySelector(".dialog-text") as HTMLElement;
const DIALOG_BUTTONS = document.querySelector(".dialog-buttons") as HTMLElement;
const TOAST = document.querySelector(".toast") as HTMLElement;

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

let messagePort: MessagePort | null = null;
let platform = "";
let list: ListState = { status: "loading" };
let runs: ArchiveRun[] = [];
let next: string | null = null;
let loadingOlder = false;
let olderLoaded = false;
let filter: RunFilter = "all";
let selected: string[] = [];
let liveConnected = false;
let openRun: string | null = null;
let job: JobState | null = null;
let today = todayIn();
let toastTimer: number | null = null;
let doneTimer: number | null = null;

const isLite = () => platform === "lite";
const busy = () => job !== null && job.phase !== "done";
const runNamed = (name: string) => runs.find((run) => run.name === name);
const labelOf = (name: string) => {
  const run = runNamed(name);
  return run ? runLabel(run, today) : name;
};

function sendMainMessage(name: string, data?: unknown) {
  messagePort?.postMessage({ name, data } as NamedMessage);
}

window.addEventListener("message", (event) => {
  if (event.data !== "port") return;
  messagePort = event.ports[0];
  messagePort.onmessage = (event) => handleMainMessage(event.data as NamedMessage);
});

function handleMainMessage(message: NamedMessage) {
  switch (message.name) {
    case "set-platform":
      platform = message.data;
      document.body.classList.toggle("lite", isLite());
      sendMainMessage("load", { before: null });
      break;

    case "set-context":
      liveConnected = message.data.live;
      openRun = message.data.run;
      render();
      break;

    case "set-runs": {
      const page: { runs: ArchiveRun[]; next: string | null; append: boolean } = message.data;
      today = todayIn();
      if (page.append) {
        runs = [...runs, ...page.runs.filter((run) => !runNamed(run.name))];
        next = page.next;
        loadingOlder = false;
        olderLoaded = true;
      } else {
        // A refresh brings the newest page; older pages already shown stay, and so does their cursor.
        runs = mergeRuns(runs, page.runs);
        if (!olderLoaded) next = page.next;
      }
      if (!busy()) selected = pruneSelection(selected, runs);
      list = { status: "ready" };
      render();
      break;
    }

    case "list-error":
      loadingOlder = false;
      // Keep showing runs already listed; a failed refresh only matters before the first answer.
      if (list.status !== "ready") list = { status: "error", message: message.data };
      render();
      break;

    case "set-job":
      job = message.data;
      if (doneTimer !== null) window.clearTimeout(doneTimer);
      if (job?.phase === "done") {
        if (job.kind === "download") selected = [];
        doneTimer = window.setTimeout(() => {
          job = null;
          render();
        }, DONE_DISMISS_MS);
      }
      render();
      break;

    case "start-open":
      // Opened from a ?run= link: open that run straight away, without waiting for the list.
      selected = [message.data];
      requestOpen(message.data);
      break;

    case "link-copied":
      showToast(message.data.ok ? "Link copied: " + message.data.link : "Couldn't copy the link");
      break;

    case "set-focused":
      document.body.classList.toggle("blurred", !message.data);
      break;
  }
}

// Rendering

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function faultLine(group: FaultGroup, more = 0): HTMLElement {
  const line = element("span", "fault-line " + group.severity);
  const { at, label } = faultLineText(group);
  line.append(element("span", "severity-dot"), element("span", "at", at), document.createTextNode(label));
  if (more > 0) line.append(element("span", "more", `+${more} more`));
  return line;
}

function renderRow(run: ArchiveRun): HTMLElement {
  const isSelected = selected.includes(run.name);
  const row = element("div", "run");
  row.dataset.name = run.name;
  row.tabIndex = 0;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(isSelected));
  row.classList.toggle("selected", isSelected);
  row.classList.toggle("dim", busy() && !isSelected);
  row.classList.toggle("parked", run.summary?.activity === "parked");

  row.append(element("span", "tick"));
  const unsynced = run.start !== null && !run.dated;
  const time = element("span", "time", (unsynced ? "~" : "") + runClock(run));
  if (unsynced) time.title = "Start time from an unsynced clock";
  row.append(time);

  const what = element("span", "what");
  const activity = runActivityText(run);
  if (activity === null) what.append(element("span", "no-summary", "Summary not built yet"));
  else what.append(document.createTextNode(activity));
  const status = runStatus(run);
  if (status !== null) {
    const tag = element("span", "status " + status.kind);
    if (status.kind === "live") tag.append(element("span", "pulse"));
    tag.append(document.createTextNode(status.text));
    what.append(tag);
  }
  if (run.name === openRun) what.append(element("span", "open-tag", "open"));
  row.append(what);

  row.append(element("span", "numbers", runNumbersText(run)));

  const groups = run.summary ? groupFaults(run.summary.faults) : [];
  const column = faultColumn(groups);
  const f1 = element("span", "fault f1");
  const f2 = element("span", "fault f2");
  if (column.lines[0]) f1.append(faultLine(column.lines[0]));
  if (column.lines[1]) f2.append(faultLine(column.lines[1], column.more));
  if (groups.length > 0) f1.title = f2.title = faultListText(groups);
  row.append(f1, f2);

  row.append(element("span", "length", runLengthText(run)), element("span", "size", sizeText(run.size_bytes)));
  return row;
}

function renderList() {
  const scroll = RUNS.scrollTop;
  RUNS.replaceChildren();
  if (list.status === "loading") {
    for (let i = 0; i < 6; i++) RUNS.append(element("div", "skeleton"));
    return;
  }
  if (list.status === "error") {
    const box = element("div", "error-box");
    box.append(
      element(
        "div",
        undefined,
        `Can't reach the run archive. ${list.message}. Runs are safe on the server and the car.`
      )
    );
    const retry = element("button", "action small", "Try again");
    retry.addEventListener("click", () => {
      list = { status: "loading" };
      render();
      sendMainMessage("load", { before: null });
    });
    box.append(retry);
    RUNS.append(box);
    return;
  }
  const shown = runs.filter((run) => matchesFilter(run, filter));
  if (shown.length === 0) {
    RUNS.append(element("div", "empty", runs.length === 0 ? "No runs in the archive yet." : `No ${filter} runs.`));
  }
  for (const day of groupByDay(shown)) {
    RUNS.append(element("div", "day", dayHeading(day.day, today)));
    for (const run of day.runs) RUNS.append(renderRow(run));
  }
  if (next !== null) {
    const older = element("button", "action small older", loadingOlder ? "Loading…" : "Show older runs");
    older.disabled = loadingOlder;
    older.addEventListener("click", () => {
      loadingOlder = true;
      render();
      sendMainMessage("load", { before: runs[runs.length - 1]?.name ?? null });
    });
    RUNS.append(older);
  }
  RUNS.scrollTop = scroll;
}

function megabytes(bytes: number) {
  return bytes >= 1e7 ? Math.round(bytes / 1e6).toString() : (bytes / 1e6).toFixed(1);
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = element("button", "link", text);
  button.addEventListener("click", onClick);
  return button;
}

function renderJob(state: JobState): HTMLElement[] {
  const count = state.names.length;
  const verb =
    state.kind === "open"
      ? "Opening " + labelOf(state.names[0])
      : count > 1
      ? `Downloading ${count} runs`
      : "Downloading " + labelOf(state.names[0]);
  const step = count > 1 && state.phase !== "done" ? ` (${state.index + 1} of ${count})` : "";
  const cancel = linkButton("Cancel", () => sendMainMessage("cancel-job"));
  const line = element("div", "job");
  const bar = element("progress", "job-bar");
  bar.max = 1;
  switch (state.phase) {
    case "preparing":
      line.append(`${verb}${step}, the server is preparing the run file `, cancel);
      bar.removeAttribute("value");
      return [line, bar];
    case "fetching": {
      const total = state.total ?? runNamed(state.names[state.index])?.size_bytes ?? null;
      line.append(
        `${verb}${step}, ${megabytes(state.received)}` + (total ? ` of ${megabytes(total)} MB ` : " MB "),
        cancel
      );
      if (total) bar.value = Math.min(1, state.received / total);
      else bar.removeAttribute("value");
      return [line, bar];
    }
    case "finishing":
      line.append(state.kind === "open" ? `${verb}, reading the log…` : `${verb}${step}, saving…`);
      bar.removeAttribute("value");
      return [line, bar];
    case "failed": {
      line.classList.add("failed");
      const total = state.total;
      const percent = total ? ` at ${Math.round((state.received / total) * 100)}%` : "";
      const retry = element("button", "action small", "Try again");
      retry.addEventListener("click", () => sendMainMessage("retry"));
      line.append(`${state.error ?? "Failed"}${percent}${step} `, retry, " ", cancel);
      return [line];
    }
    case "done":
      line.classList.add("done");
      line.append(
        state.kind === "open"
          ? "Opened"
          : `Downloaded ${count > 1 ? count + " runs" : labelOf(state.names[0])}` +
              (state.destination ? ` to ${state.destination}` : "")
      );
      return [line];
  }
}

function renderFooter() {
  const actions = selectionActions({ selected, busy: busy(), openRun });
  WHAT.replaceChildren();
  if (job !== null) {
    WHAT.append(...renderJob(job));
  } else if (selected.length === 0) {
    WHAT.append(element("span", "muted", "Tick runs to download. Double-click a run to open it."));
  } else {
    const bytes = selected.reduce((total, name) => total + (runNamed(name)?.size_bytes ?? 0), 0);
    WHAT.append(element("b", undefined, selected.length === 1 ? labelOf(selected[0]) : `${selected.length} runs`));
    WHAT.append(" ", element("span", "muted", sizeText(bytes)));
    if (selected.length > 1) {
      WHAT.append(
        " ",
        linkButton("Clear", () => {
          selected = [];
          render();
        }),
        element("div", "hint", "Open shows one run at a time")
      );
    }
  }

  COPY_BUTTON.disabled = !actions.copyLink;
  DOWNLOAD_BUTTON.disabled = !actions.download;
  DOWNLOAD_BUTTON.textContent = selected.length > 1 ? `Download ${selected.length}` : "Download";
  OPEN_BUTTON.disabled = !actions.open;
  OPEN_BUTTON.textContent = actions.showing ? "Showing" : "Open";

  // The full fault list for exactly one ticked run.
  const single = actions.single !== null && job === null ? runNamed(actions.single) : undefined;
  const groups = single?.summary ? groupFaults(single.summary.faults) : [];
  FAULT_LIST.hidden = groups.length === 0;
  FAULT_LIST.replaceChildren(
    ...groups.map((group) => {
      const item = element("span", "fault-line " + group.severity);
      item.append(element("span", "at", faultTimesText(group)), document.createTextNode(group.fullName));
      return item;
    })
  );
  FAULT_LIST.title = faultListText(groups);
}

function renderFilters() {
  const counts: Record<RunFilter, number> = {
    all: runs.length,
    driving: runs.filter((run) => matchesFilter(run, "driving")).length,
    parked: runs.filter((run) => matchesFilter(run, "parked")).length
  };
  for (const button of FILTER_BUTTONS) {
    const key = button.dataset.filter as RunFilter;
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    button.textContent = list.status === "ready" ? `${label} ${counts[key]}` : label;
    button.classList.toggle("on", key === filter);
    button.setAttribute("aria-checked", String(key === filter));
  }
}

/** Ticks and dimming without rebuilding the rows. */
function syncRows() {
  for (const row of Array.from(RUNS.querySelectorAll(".run")) as HTMLElement[]) {
    const isSelected = selected.includes(row.dataset.name!);
    row.classList.toggle("selected", isSelected);
    row.classList.toggle("dim", busy() && !isSelected);
    row.setAttribute("aria-selected", String(isSelected));
  }
}

function render() {
  renderFilters();
  renderList();
  renderFooter();
}

// Actions

function showToast(text: string) {
  TOAST.textContent = text;
  TOAST.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (TOAST.hidden = true), 2200);
}

function closeDialog() {
  SCRIM.hidden = true;
  DIALOG_BUTTONS.replaceChildren();
}

/** Opens one run, asking first when live telemetry would be replaced. */
function requestOpen(name: string) {
  if (busy()) return;
  selected = [name];
  syncRows();
  renderFooter();
  const choices = openChoices(liveConnected, isLite());
  if (choices === null) {
    sendMainMessage("open", { name, how: "replace" });
    return;
  }
  DIALOG_TEXT.textContent = `Opening ${labelOf(name)} here stops the live view in this ${isLite() ? "tab" : "window"}.`;
  const labels: Record<OpenChoice, string> = {
    cancel: "Cancel",
    replace: "Stop live and open",
    newTab: "Open in new tab"
  };
  DIALOG_BUTTONS.replaceChildren(
    ...choices.map((choice, index) => {
      const button = element("button", "action" + (index === choices.length - 1 ? " primary" : ""), labels[choice]);
      button.dataset.choice = choice;
      button.addEventListener("click", () => {
        closeDialog();
        if (choice !== "cancel") sendMainMessage("open", { name, how: choice });
      });
      return button;
    })
  );
  SCRIM.hidden = false;
  (DIALOG_BUTTONS.lastElementChild as HTMLElement | null)?.focus();
}

RUNS.addEventListener("click", (event) => {
  const row = (event.target as HTMLElement).closest(".run") as HTMLElement | null;
  if (row === null || busy()) return;
  selected = toggleRun({ selected, busy: busy(), openRun }, row.dataset.name!);
  // Update rows in place: replacing them between the two clicks of a double-click would lose it.
  syncRows();
  renderFooter();
});
RUNS.addEventListener("dblclick", (event) => {
  const row = (event.target as HTMLElement).closest(".run") as HTMLElement | null;
  if (row === null || busy() || row.dataset.name === openRun) return;
  requestOpen(row.dataset.name!);
});
RUNS.addEventListener("keydown", (event) => {
  const row = (event.target as HTMLElement).closest(".run") as HTMLElement | null;
  if (row === null) return;
  if (event.key === " ") {
    event.preventDefault();
    row.click();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const rows = Array.from(RUNS.querySelectorAll(".run")) as HTMLElement[];
    rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }
});
FILTER_BUTTONS.forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter as RunFilter;
    render();
  })
);
COPY_BUTTON.addEventListener("click", () => {
  if (selected.length === 1) sendMainMessage("copy-link", selected[0]);
});
DOWNLOAD_BUTTON.addEventListener("click", () => {
  if (selected.length > 0 && !busy()) sendMainMessage("download", [...selected]);
});
OPEN_BUTTON.addEventListener("click", () => {
  if (selected.length === 1) requestOpen(selected[0]);
});
CLOSE_BUTTON.addEventListener("click", () => sendMainMessage("close"));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !SCRIM.hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeDialog();
  } else if (event.key === "Enter" && SCRIM.hidden && (event.target as HTMLElement).tagName !== "BUTTON") {
    if (selected.length === 1 && !busy() && selected[0] !== openRun) requestOpen(selected[0]);
  } else if (event.key === "a" && (event.metaKey || event.ctrlKey) && !busy()) {
    event.preventDefault();
    const shown = runs.filter((run) => matchesFilter(run, filter)).map((run) => run.name);
    selected = shown.every((name) => selected.includes(name)) ? [] : shown;
    render();
  }
});

window.setInterval(() => {
  if (list.status === "ready") sendMainMessage("load", { before: null });
}, REFRESH_MS);

render();
