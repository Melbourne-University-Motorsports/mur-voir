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
import type { JobKind, JobState } from "./shared/mur/archiveJob";
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
  openTarget,
  pruneSelection,
  resumesJob,
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

const FILE_LIST = document.querySelector(".file-list") as HTMLElement;
const RUNS = document.querySelector(".runs") as HTMLElement;
const LOADING_ANIMATION = document.querySelector(".loading") as HTMLElement;
const FAULT_LIST = document.querySelector(".fault-list") as HTMLElement;
const FILTER = document.querySelector("select.filter") as HTMLSelectElement;
const ALERT_TEXT = document.querySelector(".alert-text") as HTMLElement;
const PROGRESS_BAR = document.querySelector("progress") as HTMLProgressElement;
const PROGRESS_DETAILS = document.querySelector(".progress-details") as HTMLElement;
const COPY_BUTTON = document.getElementById("copy-link") as HTMLButtonElement;
const OPEN_BUTTON = document.getElementById("open") as HTMLButtonElement;
const EXIT_BUTTON = document.getElementById("exit") as HTMLButtonElement;
const DOWNLOAD_BUTTON = document.getElementById("download") as HTMLButtonElement;
const SCRIM = document.querySelector(".scrim") as HTMLElement;
const DIALOG_TEXT = document.querySelector(".dialog-text") as HTMLElement;
const DIALOG_BUTTONS = document.querySelector(".dialog-buttons") as HTMLElement;

const FOOTER_HEIGHT_PX = 46;
const ROW_HEIGHT_PX = 41;

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "needs-connection" }
  | { status: "ready" };

let messagePort: MessagePort | null = null;
let platform = "";
let list: ListState = { status: "loading" };
let runs: ArchiveRun[] = [];
let next: string | null = null;
let loadingOlder = false;
let olderPaused = false;
let olderLoaded = false;
let filter: RunFilter = "all";
let selected: string[] = [];
let liveConnected = false;
let openRun: string | null = null;
let job: JobState | null = null;
let today = todayIn();
let notice: string | null = null;
let noticeTimer: number | null = null;
let doneTimer: number | null = null;

const isLite = () => platform === "lite";
// A failed job unlocks the ticks: Download or Open resumes it only while the same runs stay ticked.
const busy = () => job !== null && job.phase !== "done" && job.phase !== "failed";
const runNamed = (name: string) => runs.find((run) => run.name === name);
const resumes = (kind: JobKind) => {
  const target = openTarget(
    selected,
    runs.map((run) => run.name)
  );
  return resumesJob(job, kind, kind === "download" ? selected : target === null ? [] : [target]);
};
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
      olderPaused = false;
      render();
      break;
    }

    case "list-error":
      // A failed older page waits for the next refresh before scrolling asks again.
      if (loadingOlder) olderPaused = true;
      loadingOlder = false;
      // Keep showing runs already listed; a failed refresh only matters before the first answer.
      if (list.status !== "ready") list = { status: "error", message: message.data };
      render();
      break;

    case "need-connection":
      // Desktop before any MUR connection: there is no server to ask. A refresh asks again.
      loadingOlder = false;
      if (list.status !== "ready") list = { status: "needs-connection" };
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
      showNotice(message.data.ok ? "Link copied: " + message.data.link : "Couldn't copy the link");
      if (message.data.ok) flashIcon(COPY_BUTTON, "symbols/check.svg", "symbols/link.svg");
      break;

    case "set-focused":
      Array.from(document.getElementsByTagName("button")).forEach((button) =>
        button.classList.toggle("blurred", !message.data)
      );
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

  const tick = element("input");
  tick.type = "checkbox";
  tick.tabIndex = -1;
  tick.checked = isSelected;
  row.append(tick, fileIcon());
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
    if (status.kind === "incomplete")
      tag.title = "The logger marked this run incomplete, so its last part may be missing";
    tag.append(document.createTextNode(status.text));
    what.append(tag);
  }
  if (run.name === openRun) what.append(element("span", "status open", "Open"));
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

/** The MF4 file icon for this platform, as stock picks its log icons. */
function fileIcon(): HTMLImageElement {
  const img = element("img");
  switch (platform) {
    case "darwin":
      img.src = "../icons/download/mf4-icon-mac.png";
      img.classList.add("mac");
      break;
    case "lite":
      img.src = "../icons/mf4-icon.png";
      break;
    default:
      img.src = "../icons/download/mf4-icon-linuxwin.png";
      break;
  }
  return img;
}

function renderList() {
  const scroll = FILE_LIST.scrollTop;
  RUNS.replaceChildren();
  LOADING_ANIMATION.hidden = list.status === "ready";
  if (list.status !== "ready") return;
  const shown = runs.filter((run) => matchesFilter(run, filter));
  let index = 0;
  for (const day of groupByDay(shown)) {
    RUNS.append(element("div", "day", dayHeading(day.day, today)));
    for (const run of day.runs) {
      const row = renderRow(run);
      row.classList.toggle("even", index++ % 2 === 1);
      RUNS.append(row);
    }
  }
  if (loadingOlder) RUNS.append(element("div", "loading-older", "Loading older runs…"));
  updateFiller();
  FILE_LIST.scrollTop = scroll;
  loadOlderIfNeeded();
}

/** Adds filler rows so the stripes reach the bottom of the list, as stock does. */
function updateFiller() {
  RUNS.querySelectorAll(".filler").forEach((filler) => filler.remove());
  if (list.status !== "ready") return;
  const rows = RUNS.querySelectorAll(".run").length;
  const space = FILE_LIST.clientHeight - RUNS.offsetHeight;
  for (let i = 0; i < Math.ceil(space / ROW_HEIGHT_PX); i++) {
    RUNS.append(element("div", "filler" + ((rows + i) % 2 === 1 ? " even" : "")));
  }
}

/** Fetches the next older page once the list is scrolled near its end (or doesn't fill the window). */
function loadOlderIfNeeded() {
  if (next === null || loadingOlder || olderPaused || list.status !== "ready") return;
  if (FILE_LIST.scrollTop + FILE_LIST.clientHeight < FILE_LIST.scrollHeight - 2 * ROW_HEIGHT_PX) return;
  loadingOlder = true;
  RUNS.querySelectorAll(".filler").forEach((filler) => filler.remove());
  RUNS.append(element("div", "loading-older", "Loading older runs…"));
  sendMainMessage("load", { before: runs[runs.length - 1]?.name ?? null });
}

function megabytes(bytes: number) {
  return bytes >= 1e7 ? Math.round(bytes / 1e6).toString() : (bytes / 1e6).toFixed(1);
}

/** The job's line under the progress bar, or its alert text once it has stopped. */
function jobText(state: JobState): string {
  const count = state.names.length;
  const verb =
    state.kind === "open"
      ? "Opening " + labelOf(state.names[0])
      : count > 1
      ? `Downloading ${count} runs`
      : "Downloading " + labelOf(state.names[0]);
  const step = count > 1 && state.phase !== "done" ? ` (${state.index + 1} of ${count})` : "";
  switch (state.phase) {
    case "preparing":
      return `${verb}${step}: server preparing the file`;
    case "fetching": {
      const total = state.total ?? runNamed(state.names[state.index])?.size_bytes ?? null;
      return `${verb}${step}: ${megabytes(state.received)}` + (total ? ` / ${megabytes(total)} MB` : " MB");
    }
    case "finishing":
      return state.kind === "open" ? `${verb}: reading the log` : `${verb}${step}: saving`;
    case "failed": {
      const total = state.total;
      const percent = total ? ` at ${Math.round((state.received / total) * 100)}%` : "";
      const again = state.kind === "open" ? "Open" : "Download";
      return `${state.error ?? "Failed"}${percent}. ${again} again to resume.`;
    }
    case "done":
      return state.kind === "open"
        ? "Opened"
        : `Downloaded ${count > 1 ? count + " runs" : labelOf(state.names[0])}` +
            (state.destination ? ` to ${state.destination}` : "");
  }
}

/** The stock alert text, or the progress bar while a job runs. */
function renderStatus() {
  const running = job !== null && (job.phase === "preparing" || job.phase === "fetching" || job.phase === "finishing");
  ALERT_TEXT.hidden = running;
  PROGRESS_BAR.hidden = !running;
  PROGRESS_DETAILS.hidden = !running;
  ALERT_TEXT.className = "alert-text";
  ALERT_TEXT.replaceChildren();
  ALERT_TEXT.title = "";

  if (job !== null && running) {
    PROGRESS_DETAILS.textContent = jobText(job);
    const total = job.phase === "fetching" ? job.total ?? runNamed(job.names[job.index])?.size_bytes : null;
    if (total) PROGRESS_BAR.value = Math.min(1, job.received / total);
    else PROGRESS_BAR.removeAttribute("value");
  } else if (job !== null && (job.phase !== "failed" || resumes(job.kind))) {
    // A failure stays up while the button would resume it; once other runs are ticked, show those.
    ALERT_TEXT.classList.add("job", job.phase);
    ALERT_TEXT.textContent = jobText(job);
  } else if (notice !== null) {
    ALERT_TEXT.textContent = notice;
  } else if (list.status === "loading") {
    ALERT_TEXT.textContent = "Loading runs…";
  } else if (list.status === "needs-connection") {
    ALERT_TEXT.textContent = "Connect to MUR first (File > Connect…).";
  } else if (list.status === "error") {
    ALERT_TEXT.textContent = `Can't reach the run archive. ${list.message}. Runs are safe on the server and the car.`;
  } else if (runs.length === 0) {
    ALERT_TEXT.textContent = "No runs in the archive yet.";
  } else if (!runs.some((run) => matchesFilter(run, filter))) {
    ALERT_TEXT.textContent = `No ${filter} runs.`;
  } else if (selected.length === 0) {
    ALERT_TEXT.textContent = "Tick runs to download. Double-click a run to open it.";
  } else {
    const bytes = selected.reduce((total, name) => total + (runNamed(name)?.size_bytes ?? 0), 0);
    ALERT_TEXT.append(
      element("b", undefined, selected.length === 1 ? labelOf(selected[0]) : `${selected.length} runs`),
      " (" + sizeText(bytes) + ")"
    );
  }
  ALERT_TEXT.title = ALERT_TEXT.textContent ?? "";
}

function renderFooter() {
  const actions = selectionActions({ selected, busy: busy(), openRun, order: runs.map((run) => run.name) });
  const resumeDownload = resumes("download");
  const resumeOpen = resumes("open");
  renderStatus();

  COPY_BUTTON.disabled = !actions.copyLink;
  DOWNLOAD_BUTTON.disabled = !(actions.download || resumeDownload);
  DOWNLOAD_BUTTON.title = resumeDownload
    ? "Try again"
    : selected.length > 1
    ? `Download ${selected.length} runs`
    : "Download";
  OPEN_BUTTON.disabled = !(actions.open || resumeOpen);
  OPEN_BUTTON.title = resumeOpen
    ? "Try again"
    : actions.showing
    ? "Already open"
    : selected.length > 1 && actions.target !== null
    ? `Open the most recent ticked run, ${labelOf(actions.target)}`
    : "Open";
  EXIT_BUTTON.title = busy() ? "Cancel" : "Close";

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
  const footer = FOOTER_HEIGHT_PX + (FAULT_LIST.hidden ? 0 : FAULT_LIST.offsetHeight);
  if (document.body.style.getPropertyValue("--footer-height") !== footer + "px") {
    document.body.style.setProperty("--footer-height", footer + "px");
    updateFiller();
  }
}

function renderFilters() {
  const counts: Record<RunFilter, number> = {
    all: runs.length,
    driving: runs.filter((run) => matchesFilter(run, "driving")).length,
    parked: runs.filter((run) => matchesFilter(run, "parked")).length
  };
  for (const option of Array.from(FILTER.options)) {
    const key = option.value as RunFilter;
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    option.textContent = list.status === "ready" ? `${label} (${counts[key]})` : label;
  }
  FILTER.value = filter;
}

/** Ticks and dimming without rebuilding the rows. */
function syncRows() {
  for (const row of Array.from(RUNS.querySelectorAll(".run")) as HTMLElement[]) {
    const isSelected = selected.includes(row.dataset.name!);
    row.classList.toggle("selected", isSelected);
    (row.querySelector("input") as HTMLInputElement).checked = isSelected;
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

/** Shows a message in the alert text for a moment. */
function showNotice(text: string) {
  notice = text;
  renderStatus();
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice = null;
    renderStatus();
  }, 2200);
}

/** Swaps a button's icon for a moment, e.g. a check after copying. */
function flashIcon(button: HTMLButtonElement, src: string, restore: string) {
  const icon = button.firstElementChild as HTMLImageElement;
  icon.src = src;
  window.setTimeout(() => (icon.src = restore), 1800);
}

function closeDialog() {
  SCRIM.hidden = true;
  DIALOG_BUTTONS.replaceChildren();
}

/** Open and Enter: resume a failed open of the same run, otherwise open the most recent ticked run. */
function openTicked() {
  if (resumes("open")) {
    sendMainMessage("retry");
    return;
  }
  const target = openTarget(
    selected,
    runs.map((run) => run.name)
  );
  if (target !== null && target !== openRun) requestOpen(target);
}

/** Opens one run, asking first when live telemetry would be replaced. */
function requestOpen(name: string) {
  if (busy()) return;
  // Opening the most recent of several ticked runs keeps the other ticks.
  if (!selected.includes(name)) selected = [name];
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
    ...choices.map((choice) => {
      const button = element("button", undefined, labels[choice]);
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
FILE_LIST.addEventListener("scroll", loadOlderIfNeeded);
window.addEventListener("resize", () => {
  updateFiller();
  loadOlderIfNeeded();
});
FILTER.addEventListener("change", () => {
  filter = FILTER.value as RunFilter;
  render();
});
COPY_BUTTON.addEventListener("click", () => {
  if (selected.length === 1) sendMainMessage("copy-link", selected[0]);
});
DOWNLOAD_BUTTON.addEventListener("click", () => {
  if (resumes("download")) sendMainMessage("retry");
  else if (selected.length > 0 && !busy()) sendMainMessage("download", [...selected]);
});
OPEN_BUTTON.addEventListener("click", openTicked);
EXIT_BUTTON.addEventListener("click", () => sendMainMessage(busy() ? "cancel-job" : "close"));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !SCRIM.hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeDialog();
  } else if (
    event.key === "Enter" &&
    SCRIM.hidden &&
    !["BUTTON", "SELECT"].includes((event.target as HTMLElement).tagName)
  ) {
    openTicked();
  } else if (event.key === "a" && (event.metaKey || event.ctrlKey) && !busy()) {
    event.preventDefault();
    const shown = runs.filter((run) => matchesFilter(run, filter)).map((run) => run.name);
    selected = shown.every((name) => selected.includes(name)) ? [] : shown;
    render();
  }
});

// Refresh the newest page, and keep trying while the archive is unreachable (as stock retries the robot).
window.setInterval(() => {
  if (list.status !== "loading") sendMainMessage("load", { before: null });
}, REFRESH_MS);

render();
