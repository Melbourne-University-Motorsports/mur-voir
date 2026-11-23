// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { AdvantageScopeAssets } from "../shared/AdvantageScopeAssets";
import { getDefaultLayout, isLayoutOpen } from "../shared/DefaultLayouts";
import { HubState } from "../shared/HubState";
import NamedMessage from "../shared/NamedMessage";
import Preferences from "../shared/Preferences";
import { RenderGuard } from "../shared/RenderGuard";
import Selection, { SelectionMode } from "../shared/Selection";
import { SourceListItemState, SourceListTypeMemory } from "../shared/SourceListConfig";
import { IS_LITE } from "../shared/buildConstants";
import { setHidden } from "../shared/domWrite";
import Log from "../shared/log/Log";
import { MERGE_PREFIX } from "../shared/log/LogKeyUtils";
import { AKIT_TIMESTAMP_KEYS, getEnabledData } from "../shared/log/RobotState";
import { isRunName, isVehicleId, RunRef } from "../shared/mur/archive";
import { calcMockProgress, clampValue, htmlEncode, scaleValue } from "../shared/util";
import {
  invalidateFrames,
  isInteractive,
  onAfterFrame,
  requestFrame,
  setFramePaceSupplier,
  wakeFrames
} from "./FrameScheduler";
import { ConnectDialog } from "./LiveConnectionUI";
import SelectionImpl from "./SelectionImpl";
import Sidebar from "./Sidebar";
import SourceList from "./SourceList";
import Tabs from "./Tabs";
import WorkerManager from "./WorkerManager";
import { HistoricalDataSource, HistoricalDataSourceStatus } from "./dataSources/HistoricalDataSource";
import { sessionAddresses } from "./dataSources/LiveAddress";
import { LiveConnection } from "./dataSources/LiveConnection";
import { LiveDataSource, LiveDataSourceStatus } from "./dataSources/LiveDataSource";
import LiveDataTuner from "./dataSources/LiveDataTuner";
import { getLiveSource, getLiveSourceInfo } from "./dataSources/LiveSourceRegistry";
import { LiveStatusProvider } from "./dataSources/LiveStatus";

// Constants
const STATE_SAVE_PERIOD_MS = 250;
const TYPE_MEMORY_SAVE_PERIOD_MS = 1000;
// Saved state and type memory change only through input and messages from main
const QUIET_SAVE_PERIOD_MS = Infinity;
const DRAG_ITEM = document.getElementById("dragItem") as HTMLElement;

// Global variables
declare global {
  interface Window {
    log: Log;
    preferences: Preferences | null;
    assets: AdvantageScopeAssets | null;
    typeMemory: SourceListTypeMemory;
    platform: string;
    platformRelease: string;
    platformArch: string;
    appVersion: string;
    isFullscreen: boolean;
    isFocused: boolean;
    isBattery: boolean;
    fps: boolean;

    selection: Selection;
    sidebar: Sidebar;
    tabs: Tabs;
    tuner: LiveDataTuner | null;
    liveStatus: LiveStatusProvider | null;
    getLoadingFields(): Set<string>;
    requestStateSave(): void;

    messagePort: MessagePort | null;
    sendMainMessage: (name: string, data?: any) => void;
    startDrag: (x: number, y: number, offsetX: number, offsetY: number, data: any) => void;

    // Provided by preload script
    electron: {
      getFilePath(file: File): string;
    };
  }
}

window.log = new Log();
window.preferences = null;
window.assets = null;
window.typeMemory = {};
window.platform = "";
window.platformRelease = "";
window.isFullscreen = false;
window.isFocused = true;
window.isBattery = false;
window.fps = false;

window.selection = new SelectionImpl();
window.sidebar = new Sidebar(() =>
  historicalSources.map((entry) => {
    let components = entry.path.split(window.platform === "win32" ? "\\" : "/");
    return components[components.length - 1];
  })
);
window.tabs = new Tabs();
window.tuner = null;
window.liveStatus = null;
window.messagePort = null;

let historicalSources: {
  source: HistoricalDataSource;
  path: string;
  progress: number | null;
  progressIncluded: boolean;
}[] = [];
let liveSource: LiveDataSource | null = null;
let liveConnection: LiveConnection | null = null;
let isExporting = false;
let logFriendlyName: string | null = null;
let liveActive = false;
let liveConnected = false;
let liveAutoStartComplete = false;
/** Lite holds the live auto-start while a ?run= link opens, so live data can't replace the run. */
let liveAutoStartHeld = false;
let liveAddress = "";
let liveStatus: LiveDataSourceStatus = LiveDataSourceStatus.Stopped;
/** The archive run open in this window (File > Download runs…), or null for anything else. */
let openRun: RunRef | null = null;
/** The address of the last MUR live connection in this window, whichever way it was started. */
let murConnectionAddress: string | null = null;

// Frames run at display rate during playback, at the live pace while live data streams, and slowly otherwise
setFramePaceSupplier(() =>
  window.selection.getMode() === SelectionMode.Playback
    ? "display"
    : liveActive && liveStatus === LiveDataSourceStatus.Active
    ? "live"
    : "idle"
);

const connectDialog = new ConnectDialog((sourceId, address) => connectLive(sourceId, address));

function guardedInterval(action: () => void, period: number) {
  const guard = new RenderGuard();
  return window.setInterval(() => guard.run(action), period);
}

/**
 * Runs `action` after frames, at most once per `period`. State that can only change through input,
 * messages or data (which all cause frames) is checked here instead of on a timer, so an idle window
 * wakes for none of it. A trailing run catches a change in the last frame before the window goes idle.
 * Without recent input, the check runs at most once per `quietPeriod`, so live data frames alone do
 * not keep rebuilding state that input changes. With an infinite `quietPeriod` it runs only within
 * the second after input or a message from main, plus once after that.
 */
function afterFrames(action: () => void, period: number, quietPeriod = period) {
  const guard = new RenderGuard();
  let last = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    last = performance.now();
    guard.run(action);
  };
  onAfterFrame(() => {
    const interactive = isInteractive();
    if (!interactive && quietPeriod === Infinity) return;
    const wait = last + (interactive ? period : quietPeriod) - performance.now();
    if (wait <= 0) {
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
      run();
    } else if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        run();
      }, wait);
    }
  });
}

afterFrames(() => {
  if (!liveActive || liveStatus !== LiveDataSourceStatus.Active) return;
  const status = window.liveStatus?.getLiveStatus();
  setWindowTitle(liveAddress, status?.backend === "connected" && !status.hasFreshData ? "No car data" : undefined);
}, 500);

window.addEventListener("cancel-live-connect", () => stopLive());

let dragActive = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragLastX = 0;
let dragLastY = 0;
let dragData: any = null;

// WINDOW UTILITIES

let lastWindowTitle = "";
function setWindowTitle(name: string, status?: string) {
  let title =
    htmlEncode(name) + (status ? " (" + htmlEncode(status) + ")" : "") + " &mdash; mur-voir" + (IS_LITE ? " Lite" : "");
  if (title === lastWindowTitle) return; // Called twice a second while live
  lastWindowTitle = title;
  document.getElementsByTagName("title")[0].innerHTML = title;
  document.getElementsByClassName("title-bar-text")[0].innerHTML = title;
}

/** Shows or hides the loading indicator and updates progress. Pass "null" to disable loading indicator. */
function setLoading(progress: number | null) {
  let showLoadingGlowProperty = progress !== null ? "1" : "0";
  if (document.documentElement.style.getPropertyValue("--show-loading-glow") !== showLoadingGlowProperty) {
    document.documentElement.style.setProperty("--show-loading-glow", showLoadingGlowProperty);
  }
  if (progress !== null) {
    document.documentElement.style.setProperty("--loading-glow-progress", progress.toString());
  }
}

function updateFancyWindow() {
  // Using fancy title bar?
  let releaseSplit = window.platformRelease.split(".");
  if (window.platform === "darwin" && !window.isFullscreen) {
    document.body.classList.add("fancy-title-bar-mac");
  } else {
    document.body.classList.remove("fancy-title-bar-mac");
  }
  if (window.platform === "win32") {
    document.body.classList.add("fancy-title-bar-win");
  } else {
    document.body.classList.remove("fancy-title-bar-win");
  }
  if (window.platform === "linux") {
    document.body.classList.add("fancy-title-bar-linux");
  } else {
    document.body.classList.remove("fancy-title-bar-linux");
  }
  if (window.platform === "lite") {
    document.body.classList.add("fancy-title-bar-lite");
  } else {
    document.body.classList.remove("fancy-title-bar-lite");
  }

  // Using fancy sidebar?
  if (window.platform === "darwin") {
    document.body.classList.add("fancy-side-bar-mac");

    // macOS Golden Gate switched to a different sidebar style
    if (Number(releaseSplit[0]) >= 27) {
      document.body.classList.add("fancy-side-bar-mac-27");
    } else {
      document.body.classList.remove("fancy-side-bar-mac-27");
    }
  } else {
    document.body.classList.remove("fancy-side-bar-mac");
  }
  if (window.platform === "win32" && Number(releaseSplit[releaseSplit.length - 1]) >= 22621) {
    // Windows 11 22H2
    document.body.classList.add("fancy-side-bar-win");
  } else {
    document.body.classList.remove("fancy-side-bar-win");
  }
}

function setExporting(exporting: boolean) {
  if (exporting !== isExporting) {
    isExporting = exporting;
    window.sendMainMessage("set-exporting", exporting);
  }
}

// MANAGE STATE

/** Returns the current state. */
function saveState(): HubState {
  return {
    sidebar: window.sidebar.saveState(),
    tabs: window.tabs.saveState()
  };
}

/** Restores to the provided state. */
function restoreState(state: HubState) {
  window.sidebar.restoreState(state.sidebar);
  window.tabs.restoreState(state.tabs);
}

// Input and catalogue remaps can both change the saved layout.
let lastSavedState = "";
const saveChangedState = () => {
  const state = saveState();
  const serialized = JSON.stringify(state);
  if (serialized === lastSavedState) return;
  lastSavedState = serialized;
  window.sendMainMessage("save-state", state);
};
afterFrames(saveChangedState, STATE_SAVE_PERIOD_MS, QUIET_SAVE_PERIOD_MS);
let pendingStateSave: ReturnType<typeof setTimeout> | null = null;
window.requestStateSave = () => {
  pendingStateSave ??= setTimeout(() => {
    pendingStateSave = null;
    saveChangedState();
  }, STATE_SAVE_PERIOD_MS);
};

// Main reads and merges the type memory file for each message, so only send changes
let lastSavedTypeMemory = "";
afterFrames(
  () => {
    const serialized = JSON.stringify(window.typeMemory);
    if (serialized === lastSavedTypeMemory) return;
    lastSavedTypeMemory = serialized;
    window.sendMainMessage("save-type-memory", window.typeMemory);
  },
  TYPE_MEMORY_SAVE_PERIOD_MS,
  QUIET_SAVE_PERIOD_MS
);

// MANAGE DRAGGING

window.startDrag = (x, y, offsetX, offsetY, data) => {
  dragActive = true;
  dragOffsetX = offsetX;
  dragOffsetY = offsetY;
  dragLastX = x;
  dragLastY = y;
  dragData = data;

  DRAG_ITEM.hidden = false;
  DRAG_ITEM.style.left = (x - offsetX).toString() + "px";
  DRAG_ITEM.style.top = (y - offsetY).toString() + "px";
  document.body.style.cursor = "grabbing";
};

function dragMove(x: number, y: number) {
  if (dragActive) {
    DRAG_ITEM.style.left = (x - dragOffsetX).toString() + "px";
    DRAG_ITEM.style.top = (y - dragOffsetY).toString() + "px";
    dragLastX = x;
    dragLastY = y;
    window.dispatchEvent(
      new CustomEvent("drag-update", {
        detail: { end: false, x: x, y: y, data: dragData }
      })
    );
  }
}
window.addEventListener("mousemove", (event) => {
  dragMove(event.clientX, event.clientY);
});
window.addEventListener("touchmove", (event) => {
  dragMove(event.touches[0].clientX, event.touches[0].clientY);
});

function dragEnd() {
  if (dragActive) {
    dragActive = false;
    DRAG_ITEM.hidden = true;
    document.body.style.cursor = "";
    window.dispatchEvent(
      new CustomEvent("drag-update", {
        detail: { end: true, x: dragLastX, y: dragLastY, data: dragData }
      })
    );
  }
}
window.addEventListener("mouseup", () => {
  dragEnd();
});
window.addEventListener("touchend", () => {
  dragEnd();
});

// FPS MEASUREMENT

const fpsDiv = document.getElementsByClassName("fps")[0] as HTMLElement;
const sampleLength = 10;
let frameTimes: number[] = [];
let periodic = () => {
  requestFrame(periodic);
  frameTimes.push(window.performance.now());
  while (frameTimes.length > sampleLength) {
    frameTimes.shift();
  }
  let fps = 0;
  if (frameTimes.length > 1) {
    let avgFrameTime = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / (frameTimes.length - 1);
    fps = 1000 / avgFrameTime;
  }
  setHidden(fpsDiv, !window.fps);
  if (window.fps) {
    fpsDiv.innerText = "FPS: " + fps.toFixed(1);
  }
};
requestFrame(periodic);

// DATA SOURCE HANDLING

function checkLiveAutoStart() {
  if (IS_LITE && window.preferences !== null && !liveAutoStartComplete && !liveAutoStartHeld) {
    liveAutoStartComplete = true;
    // Anything opened before the auto-start (a ?run= link, a file) wins over live data
    if (openRun !== null || historicalSources.length > 0) return;
    startLive("robot");
  }
}

window.getLoadingFields = () => {
  let output: Set<string> = new Set();
  historicalSources.forEach((entry) => {
    entry.source.getLoadingFields().forEach((field) => output.add(field));
  });
  return output;
};

/** Connects to a historical data source. */
function startHistorical(path: string, clear = true, merge = false) {
  if (liveConnection !== null) {
    window.selection.setLiveDisconnected();
    window.selection.resetLiveSegment();
  }
  clear = clear || !merge;
  let originalTimelineRange: null | [number, number] = null;
  let originalTimelineIsMaxZoom: null | boolean = null;
  if (clear) {
    historicalSources.forEach((entry) => entry.source.stop());
    historicalSources = [];
    originalTimelineRange = window.selection.getTimelineRange();
    originalTimelineIsMaxZoom = window.selection.getTimelineIsMaxZoom();
    window.log = new Log();
    window.sidebar.refresh();
    window.tabs.refresh();
    invalidateFrames();
  }

  liveConnection?.stop();
  liveConnection = null;
  liveSource = null;
  window.tuner = null;
  window.liveStatus = null;
  liveActive = false;
  liveConnected = false;
  setLoading(null);

  let updateLoading = () => {
    if (historicalSources.every((entry) => entry.progress === null)) {
      historicalSources.forEach((entry) => (entry.progressIncluded = false));
    }

    let totalProgress = 0;
    let progressCount = 0;
    historicalSources.forEach((entry) => {
      if (!entry.progressIncluded) return;
      totalProgress += entry.progress === null ? 1 : entry.progress;
      progressCount++;
    });

    if (progressCount === 0) {
      setLoading(null);
    } else {
      setLoading(totalProgress / progressCount);
    }
  };

  let source = new HistoricalDataSource();
  let sourceEntry = { source: source, path: path, progress: 0, progressIncluded: true } as {
    source: HistoricalDataSource;
    path: string;
    progress: number | null;
    progressIncluded: boolean;
  };
  historicalSources.push(sourceEntry);
  source.openFile(
    window.log,
    path,
    merge ? "/" + MERGE_PREFIX + (historicalSources.length - 1).toString() : "",
    (status: HistoricalDataSourceStatus) => {
      if (historicalSources.length === 1) {
        let components = historicalSources[0].path.split(window.platform === "win32" ? "\\" : "/");
        logFriendlyName = components[components.length - 1];
      } else {
        logFriendlyName = historicalSources.length.toString() + " Log Files";
      }
      switch (status) {
        case HistoricalDataSourceStatus.Reading:
        case HistoricalDataSourceStatus.DecodingInitial:
          setWindowTitle(logFriendlyName, "Loading");
          break;
        case HistoricalDataSourceStatus.DecodingField:
        case HistoricalDataSourceStatus.Idle:
          setWindowTitle(logFriendlyName);
          sourceEntry.progress = null;
          updateLoading();
          if (originalTimelineRange !== null && originalTimelineIsMaxZoom !== null) {
            window.selection.setTimelineRange(originalTimelineRange, originalTimelineIsMaxZoom);
            let newTimelineRange = window.selection.getTimelineRange();
            if (window.selection.getTimelineIsMaxZoom() && originalTimelineRange[0] >= 0 && newTimelineRange[0] < 0) {
              // If the new log data made the locked range negative, limit to positive values
              window.selection.setTimelineRange([0, newTimelineRange[1]], false);
            }
            originalTimelineRange = null;
            originalTimelineIsMaxZoom = null;
          }
          break;
        case HistoricalDataSourceStatus.Error:
          setWindowTitle(logFriendlyName, "Error");
          sourceEntry.progress = null;
          updateLoading();
          let isCSV = path.endsWith(".csv");
          let message =
            "There was a problem while reading the log file. " +
            (isCSV
              ? "Please check the documentation for more information on the required format of CSV files."
              : "Please try again.");
          if (source.getCustomError() !== null) {
            message = source.getCustomError()!;
          }
          window.sendMainMessage("error", {
            title: "Failed to open log",
            content: message
          });
          break;
        case HistoricalDataSourceStatus.Stopped:
          break;
      }
    },
    (progress: number) => {
      sourceEntry.progress = progress;
      updateLoading();
    },
    (hasNewFields: boolean) => {
      window.sidebar.refresh();
      if (hasNewFields) window.tabs.refresh();
      invalidateFrames(); // Show the new data
    }
  );
}

/** Whether new data for these keys can change what is on screen. Null means unknown. */
function showsAnyField(changed: ReadonlySet<string> | null): boolean {
  if (changed === null) return true;
  if (changed.size === 0) return false;
  const sidebarFields = window.sidebar.getOnScreenFields();
  if (sidebarFields === null) return true;
  const tabFields = window.tabs.getVisibleFields();
  for (const key of changed) {
    if (tabFields.has(key)) return true;
  }
  // A sidebar row can be the child of a struct field that changed
  for (const field of sidebarFields) {
    for (let key = field; key.length > 0; key = key.substring(0, key.lastIndexOf("/"))) {
      if (changed.has(key)) return true;
    }
  }
  return false;
}

/** Connects from the prompt and saves the source and address. */
function connectLive(sourceId: string, address: string) {
  if (!window.preferences) return;
  window.preferences.liveMode = sourceId;
  sessionAddresses.set(sourceId, address);
  window.sendMainMessage("update-preferences", { liveMode: sourceId });
  startLive("robot", { sourceId: sourceId, address: address });
  reportViewSource();
}

/** Disconnects the live source, keeping the received data visible. */
function stopLive() {
  liveConnection?.stop();
  liveSource = null;
  liveConnection = null;
  window.tuner = null;
  window.liveStatus = null;
  liveActive = false;
  liveConnected = false;
  liveStatus = LiveDataSourceStatus.Stopped;
  window.selection.setLiveDisconnected();
  setWindowTitle(liveAddress, "Disconnected");
}

/** Connects to a live data source. */
function startLive(sourceType: "robot" | "sim", target?: { sourceId: string; address: string }) {
  openRun = null;
  historicalSources.forEach((entry) => entry.source.stop());
  historicalSources = [];
  liveConnection?.stop();
  liveActive = false;
  liveConnected = false;
  liveSource = null;
  setLoading(null);

  if (!window.preferences) return;
  const sourceDefinition = getLiveSource(target?.sourceId ?? window.preferences.liveMode, IS_LITE);
  const source = sourceDefinition.create();
  const connection = new LiveConnection(source);
  liveConnection = connection;

  let address = "";
  if (target !== undefined) {
    address = target.address;
  } else if (sourceType === "sim") {
    address = sourceDefinition.defaultAddress;
  } else {
    address = sessionAddresses.get(sourceDefinition.id) ?? sourceDefinition.defaultAddress;
  }
  liveAddress = address;
  if (sourceDefinition.id === "mur") murConnectionAddress = address;
  liveStatus = LiveDataSourceStatus.Connecting;
  window.liveStatus = null;
  source.newSegmentCallback = () => {
    // Time jumped backwards: restart the timeline at the new live edge
    window.selection.resetLiveSegment();
    window.sidebar.refresh();
    window.tabs.refresh();
  };

  connection.connect(
    address,
    (status: LiveDataSourceStatus) => {
      if (liveConnection !== connection) return;
      liveStatus = status;
      invalidateFrames();
      connectDialog.updateStatus(status);
      switch (status) {
        case LiveDataSourceStatus.Connecting:
          setWindowTitle(address, "Searching");
          break;
        case LiveDataSourceStatus.Active:
          liveSource = source;
          liveActive = true;
          window.liveStatus = source.getStatusProvider();
          window.tuner = source.getTuner();
          setWindowTitle(address);
          break;
        case LiveDataSourceStatus.Error:
          setWindowTitle(address, "Error");
          break;
      }

      if (status !== LiveDataSourceStatus.Active) {
        window.selection.setLiveDisconnected();
      }
    },
    (log: Log, timeSupplier: () => number) => {
      liveConnected = true;
      window.log = log;
      window.selection.setLiveConnected(timeSupplier);
      const changed = source.takeChangedFields();
      // Incremental batches have the same catalogue. The sidebar reads current values on text frames.
      if (changed === null) window.sidebar.refresh();
      window.tabs.refresh(changed);
      // Frames follow data that is on screen, up to the live frame cap. The live clock frames move
      // the timeline and age the freshness marks in between.
      if (showsAnyField(changed)) invalidateFrames();
    },
    (detail) => {
      if (liveConnection !== connection) return;
      stopLive();
      setWindowTitle(address, "Error");
      connectDialog.show(address, sourceDefinition.id);
      connectDialog.connectionFailed(detail);
    }
  );
}

// File dropped on window
document.addEventListener("dragover", (event) => {
  event.preventDefault();
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  event.stopPropagation();

  if (IS_LITE) {
    if (event.dataTransfer?.files.length) window.sendMainMessage("show-open-log");
    return;
  }
  if (event.dataTransfer) {
    let files: string[] = [];
    for (const file of event.dataTransfer.files) {
      files.push(window.electron.getFilePath(file));
    }
    if (files.length > 0) {
      window.sendMainMessage("open-files-request", { files: files });
    }
  }
});

// MAIN MESSAGE HANDLING

window.sendMainMessage = (name: string, data?: any) => {
  if (window.messagePort !== null) {
    let message: NamedMessage = { name: name, data: data };
    window.messagePort.postMessage(message);
  }
};

window.addEventListener("message", (event) => {
  if (event.data === "port") {
    window.messagePort = event.ports[0];
    window.messagePort.onmessage = (event) => {
      let message: NamedMessage = event.data;
      handleMainMessage(message);
      wakeFrames();
    };

    // Share the registered live sources for the main process menus
    window.sendMainMessage("set-live-sources", getLiveSourceInfo(IS_LITE));
  }
});

// Tell the main process what this window shows: Download runs asks before replacing live telemetry,
// Lite keeps ?run= in the address bar, and the title bar offers Copy link while a run is open.
const COPY_RUN_LINK = document.querySelector(".copy-run-link") as HTMLButtonElement;
let reportedViewSource = "";
let copyRunLinkTimer: number | null = null;
/** Live telemetry is arriving: an active source and, where the source reports it, fresh data. */
function receivingLive(): boolean {
  if (liveConnection === null || !liveActive || liveStatus !== LiveDataSourceStatus.Active) return false;
  const status = window.liveStatus?.getLiveStatus();
  return status === undefined || (status.backend === "connected" && status.hasFreshData);
}
function reportViewSource() {
  // Desktop lists the archive on the MUR server connected to this session, and has none before that.
  const murAddress =
    murConnectionAddress ??
    sessionAddresses.get("mur") ??
    (IS_LITE ? getLiveSource("mur", IS_LITE).defaultAddress : null);
  const viewSource = { live: receivingLive(), run: openRun, archiveAddress: murAddress };
  const key = JSON.stringify(viewSource);
  if (key === reportedViewSource || window.messagePort === null) return;
  reportedViewSource = key;
  window.sendMainMessage("set-view-source", viewSource);
  COPY_RUN_LINK.hidden = openRun === null;
  document.body.classList.toggle("has-run-link", openRun !== null);
}
// Most changes report straight away; the interval catches the rest (e.g. a live connection dropping).
afterFrames(reportViewSource, 250, 1000);
COPY_RUN_LINK.addEventListener("click", () => {
  if (openRun !== null) window.sendMainMessage("copy-run-link", openRun);
});

// Update touch bar slider position, only when it moves
let lastTouchBarPercent: number | null = null;
afterFrames(() => {
  if (window.platform === "darwin") {
    let range = window.log.getTimestampRange();
    let liveTime = window.selection.getCurrentLiveTime();
    if (liveTime !== null) {
      range[1] = liveTime;
    }
    let selectedTime = window.selection.getSelectedTime();
    if (selectedTime === null) {
      selectedTime = range[0];
    }
    let timePercent = clampValue(scaleValue(selectedTime, range, [0, 1]), 0, 1);
    // The slider is a few hundred points wide, so finer changes are invisible
    if (lastTouchBarPercent !== null && Math.abs(timePercent - lastTouchBarPercent) < 0.002) return;
    lastTouchBarPercent = timePercent;
    window.sendMainMessage("update-touch-bar-slider", timePercent);
  }
}, 100);

async function handleMainMessage(message: NamedMessage) {
  switch (message.name) {
    case "show-when-ready":
      // Wait for DOM updates to finish
      window.requestAnimationFrame(() => {
        window.sendMainMessage("show");
      });
      break;

    case "export-layout":
      window.sendMainMessage("export-layout", IS_LITE ? { id: message.data, state: saveState() } : saveState());
      break;

    case "restore-state":
      restoreState(message.data);
      break;

    case "add-default-layout": {
      // Adds a bundled layout's tabs after the open ones. The menu sends the id and always adds;
      // Lite's ?layout= link sends { id, ifMissing: true } so a bookmarked link doesn't pile up copies.
      const request: { id: string; ifMissing?: boolean } =
        typeof message.data === "string" ? { id: message.data } : message.data;
      const layout = getDefaultLayout(request.id);
      if (layout === undefined) break;
      if (request.ifMissing && isLayoutOpen(layout, window.tabs.saveState().tabs)) break;
      window.tabs.appendState(layout.state.tabs);
      break;
    }

    case "restore-type-memory":
      window.typeMemory = message.data;
      break;

    case "set-fullscreen":
      window.isFullscreen = message.data;
      updateFancyWindow();
      break;

    case "set-focused":
      window.isFocused = message.data;
      Array.from(document.getElementsByTagName("button")).forEach((button) => {
        if (window.isFocused) {
          button.classList.remove("blurred");
        } else {
          button.classList.add("blurred");
        }
      });
      break;

    case "set-battery":
      window.isBattery = message.data;
      break;

    case "set-version":
      window.platform = message.data.platform;
      window.platformRelease = message.data.platformRelease;
      window.platformArch = message.data.platformArch;
      window.appVersion = message.data.appVersion;
      updateFancyWindow();
      break;

    case "set-preferences":
      window.preferences = message.data;
      checkLiveAutoStart();
      break;

    case "hold-live-auto-start":
      // Lite: true while a ?run= link opens; false once it has opened or was abandoned
      liveAutoStartHeld = message.data;
      checkLiveAutoStart();
      break;

    case "set-assets":
      if (JSON.stringify(window.assets) !== JSON.stringify(message.data)) {
        let oldHadFailed = window.assets && window.assets.loadFailures.length > 0;
        let newHasFailed = message.data && message.data.loadFailures.length > 0;
        window.assets = message.data;
        window.tabs.newAssets();

        // Alert about failed assets
        if (newHasFailed) {
          console.warn(
            "Failed to load: " +
              window.assets!.loadFailures.join(", ") +
              ". Check that all assets follow the format described in the mur-voir documentation."
          );
        }
        if (newHasFailed && !oldHadFailed) {
          window.sendMainMessage("error", {
            title: "Failed to load assets",
            content: "Some asset files failed to load. Check the developer console for details."
          });
        }
        if (!newHasFailed && oldHadFailed) {
          console.log("All assets loaded successfully");
        }
      }
      break;

    case "set-active-satellites":
      window.tabs.setActiveSatellites(message.data);
      break;

    case "call-selection-setter":
      let uuid: string = message.data.uuid;
      let name: string = message.data.name;
      let args: any[] = message.data.args;
      if (window.tabs.isValidUUID(uuid)) {
        switch (name) {
          case "setHoveredTime":
            window.selection.setHoveredTime(args[0]);
            break;
          case "setSelectedTime":
            window.selection.setSelectedTime(args[0]);
            break;
          case "goIdle":
            window.selection.goIdle();
            break;
          case "play":
            window.selection.play();
            break;
          case "pause":
            window.selection.pause();
            break;
          case "togglePlayback":
            window.selection.togglePlayback();
            break;
          case "lock":
            window.selection.lock();
            break;
          case "unlock":
            window.selection.unlock();
            break;
          case "toggleLock":
            window.selection.toggleLock();
            break;
          case "stepCycle":
            window.selection.stepCycle(args[0]);
            break;
          case "setGrabZoomRange":
            window.selection.setGrabZoomRange(args[0]);
            break;
          case "finishGrabZoom":
            window.selection.finishGrabZoom();
            break;
          case "applyTimelineScroll":
            window.selection.applyTimelineScroll(args[0], args[1], args[2]);
            break;
        }
      }
      break;

    case "zoom-enabled":
      {
        let enabledData = getEnabledData(window.log);
        let range = window.log.getTimestampRange();
        let firstEnableIndex = enabledData === null ? -1 : enabledData.values.findIndex((value) => value);
        let lastDisableIndex = -1;
        if (firstEnableIndex !== -1) {
          range[0] = enabledData!.timestamps[firstEnableIndex];

          lastDisableIndex = enabledData === null ? -1 : enabledData.values.findLastIndex((value) => !value);
          if (
            enabledData !== null &&
            enabledData.values.length > 0 &&
            enabledData.values[enabledData.values.length - 1]
          ) {
            // Last value was enabled
            lastDisableIndex = -1;
          }
          if (lastDisableIndex < firstEnableIndex) lastDisableIndex = -1;
          if (lastDisableIndex !== -1) range[1] = enabledData!.timestamps[lastDisableIndex];
        }
        window.selection.unlock();
        window.selection.setTimelineRange(range, false);
      }
      break;

    case "historical-data":
      historicalSources.forEach((entry) => {
        entry.source.handleMainMessage(message.data);
      });
      break;

    case "live-data":
      (liveSource ?? liveConnection?.source)?.handleMainMessage(message.data);
      break;

    case "open-files":
      let files: string[] = message.data.files;
      let merge: boolean = message.data.merge;

      if (isExporting) {
        window.sendMainMessage("error", {
          title: "Cannot open file" + (files.length !== 1 ? "s" : ""),
          content: "Please wait for the export to finish, then try again."
        });
      } else if (merge && (liveActive || historicalSources.length === 0)) {
        window.sendMainMessage("error", {
          title: "Cannot insert file" + (files.length !== 1 ? "s" : ""),
          content: 'No log files are currently loaded. Choose "Open Log(s)" to load new files.'
        });
      } else {
        files.forEach((file, index) => {
          if (merge) {
            startHistorical(file, false, true);
          } else {
            startHistorical(file, index === 0, files.length > 1);
          }
        });
        const run = message.data.run;
        openRun =
          !merge && files.length === 1 && isRunName(run?.name) && isVehicleId(run?.vehicle)
            ? { vehicle: run.vehicle, name: run.name }
            : null;
        reportViewSource();
      }
      break;

    case "run-link-copied": {
      // Like the other title bar icons: a check for a moment, and the outcome in the tooltip.
      const icon = COPY_RUN_LINK.firstElementChild as HTMLImageElement;
      if (message.data.ok) icon.src = "symbols/check.svg";
      COPY_RUN_LINK.title = (message.data.ok ? "Link copied: " : "Couldn't copy the link: ") + message.data.link;
      if (copyRunLinkTimer !== null) window.clearTimeout(copyRunLinkTimer);
      copyRunLinkTimer = window.setTimeout(() => {
        icon.src = "symbols/link.svg";
        COPY_RUN_LINK.title = "Copy a link to this run";
      }, 1800);
      break;
    }

    case "show-connect-dialog":
      if (isExporting) {
        window.sendMainMessage("error", {
          title: "Cannot connect",
          content: "Please wait for the export to finish, then try again."
        });
      } else {
        connectDialog.show();
      }
      break;

    case "start-live":
      if (isExporting) {
        window.sendMainMessage("error", {
          title: "Cannot connect",
          content: "Please wait for the export to finish, then try again."
        });
      } else {
        startLive(message.data);
      }
      break;

    case "set-playback-options":
      window.selection.setPlaybackSpeed(message.data.speed);
      window.selection.setPlaybackLooping(message.data.looping);
      break;

    case "toggle-sidebar":
      window.sidebar.toggleVisible();
      break;

    case "toggle-controls":
      window.tabs.toggleControlsVisible();
      break;

    case "new-tab":
      window.tabs.addTab(message.data);
      break;

    case "new-satellite":
      window.tabs.newSatellite();
      break;

    case "move-tab":
      window.tabs.setSelected(window.tabs.getSelectedTab() + message.data);
      break;

    case "shift-tab":
      window.tabs.shift(window.tabs.getSelectedTab(), message.data);
      break;

    case "close-tab":
      window.tabs.close(window.tabs.getSelectedTab());
      break;

    case "rename-tab":
      window.tabs.renameTab(message.data.index, message.data.name);
      break;

    case "source-list-type-response":
      {
        let uuid: string = message.data.uuid;
        let state: SourceListItemState = message.data.state;
        if (uuid in SourceList.typePromptCallbacks) {
          SourceList.typePromptCallbacks[uuid](state);
        }
      }
      break;

    case "source-list-clear-response":
      {
        let uuid: string = message.data.uuid;
        if (uuid in SourceList.clearPromptCallbacks) {
          SourceList.clearPromptCallbacks[uuid]();
        }
      }
      break;

    case "set-robot-mode-visible":
      window.tabs.setRobotModeVisible(message.data.showRobotMode);
      break;

    case "edit-trackside-limits":
      window.tabs.editTracksideLimits(message.data.uuid, message.data.key, message.data.limits);
      break;

    case "edit-axis":
      window.tabs.editAxis(
        message.data.legend,
        message.data.lockedRange,
        message.data.unitConversion,
        message.data.filter
      );
      break;

    case "clear-axis":
      window.tabs.clearAxis(message.data);
      break;

    case "set-2d-camera":
      window.tabs.set2DCamera(message.data);
      break;

    case "add-table-range":
      window.tabs.addTableRange(message.data.controllerUUID, message.data.rendererUUID, message.data.range);
      break;

    case "video-data":
      window.tabs.processVideoData(message.data);
      break;

    case "start-export":
      let logPath = historicalSources.length > 0 ? historicalSources[0].path : null;
      if (isExporting) {
        window.sendMainMessage("error", {
          title: "Cannot export data",
          content: "Please wait for the previous export to finish, then try again."
        });
      } else if (logPath === null && !liveConnected) {
        window.sendMainMessage("error", {
          title: "Cannot export data",
          content: "Please open a log file or connect to a live source, then try again."
        });
      } else {
        setExporting(true);
        const incompleteWarning = liveConnected && window.preferences?.liveSubscribeMode === "low-bandwidth";
        const supportsAkit = window.log.getFieldKeys().find((key) => AKIT_TIMESTAMP_KEYS.includes(key)) !== undefined;
        window.sendMainMessage("prompt-export", {
          path: logPath,
          incompleteWarning: incompleteWarning,
          supportsAkit: supportsAkit
        });
      }
      break;

    case "cancel-export":
      setExporting(false);
      break;

    case "prepare-export":
      // Start mock progress
      let mockProgress = 0;
      let mockProgressStart = new Date().getTime();
      let mockProgressInterval = guardedInterval(() => {
        mockProgress = calcMockProgress((new Date().getTime() - mockProgressStart) / 1000, 0.25);
        setLoading(mockProgress);
      }, 1000 / 60);

      // Load missing fields
      await Promise.all(historicalSources.map((entry) => entry.source.loadAllFields()));

      try {
        // Convert to export format
        const content = await WorkerManager.request(
          "../bundles/exportWorker.js",
          {
            options: message.data.options,
            log: window.log.toSerialized()
          },
          (progress: number) => {
            clearInterval(mockProgressInterval);
            setLoading(scaleValue(progress, [0, 1], [mockProgress, 1]));
          }
        );
        window.sendMainMessage("write-export", {
          path: message.data.path,
          content: content
        });
      } catch {
        window.sendMainMessage("error", {
          title: "Failed to export data",
          content: "There was a problem while converting to the export format. Please try again."
        });
        setLoading(null);
      } finally {
        setExporting(false);
      }
      break;

    case "finish-export":
      setLoading(null);
      break;

    case "update-touch-bar-slider":
      let range = window.log.getTimestampRange();
      let liveTime = window.selection.getCurrentLiveTime();
      if (liveTime !== null) {
        range[1] = liveTime;
      }
      window.selection.setSelectedTime(scaleValue(message.data, [0, 1], range));
      break;

    default:
      console.warn("Unknown message from main process", message);
      break;
  }
}
