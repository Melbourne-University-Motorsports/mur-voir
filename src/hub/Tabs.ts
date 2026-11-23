// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { TabState, TabsState } from "../shared/HubState";
import LineGraphFilter from "../shared/LineGraphFilter";
import { RenderGuard, inlineStatus } from "../shared/RenderGuard";
import TabType, { filterRestorableTabs, getDefaultTabTitle, getTabIcon } from "../shared/TabType";
import { dbcDefinition, diffTrackside } from "../shared/Trackside";
import { getAutonomousKey, getEnabledKey, getUtilityKey } from "../shared/log/RobotState";
import CarDynamicsRenderer from "../shared/renderers/CarDynamicsRenderer";
import ConsoleRenderer from "../shared/renderers/ConsoleRenderer";
import DocumentationRenderer from "../shared/renderers/DocumentationRenderer";
import DriverInputsRenderer from "../shared/renderers/DriverInputsRenderer";
import Field2dRenderer from "../shared/renderers/Field2dRenderer";
import LineGraphRenderer from "../shared/renderers/LineGraphRenderer";
import MetadataRenderer from "../shared/renderers/MetadataRenderer";
import PointsRenderer from "../shared/renderers/PointsRenderer";
import StatisticsRenderer from "../shared/renderers/StatisticsRenderer";
import TabRenderer, { NoopRenderer } from "../shared/renderers/TabRenderer";
import TableRenderer from "../shared/renderers/TableRenderer";
import TracksideRenderer, { TracksideRendererCommand } from "../shared/renderers/TracksideRenderer";
import VideoRenderer from "../shared/renderers/VideoRenderer";
import { Units } from "../shared/units";
import { clampValue } from "../shared/util";
import { attachResizeHandle } from "./ResizeHandle";
import ScrollSensor, { ScrollSensorMouseControl } from "./ScrollSensor";
import Timeline, { TimelineBand } from "./Timeline";
import { updateTracksideAlerts } from "./TracksideAlerts";
import CarDynamicsController from "./controllers/CarDynamicsController";
import ConsoleController from "./controllers/ConsoleController";
import DriverInputsController from "./controllers/DriverInputsController";
import Field2dController from "./controllers/Field2dController";
import LineGraphController from "./controllers/LineGraphController";
import MetadataController from "./controllers/MetadataController";
import PointsController from "./controllers/PointsController";
import StatisticsController from "./controllers/StatisticsController";
import TabController, { NoopController } from "./controllers/TabController";
import TableController from "./controllers/TableController";
import TracksideController from "./controllers/TracksideController";
import VideoController from "./controllers/VideoController";

import { setHidden, setRootProperty, setStyle } from "../shared/domWrite";
import LapRenderer from "../shared/renderers/LapRenderer";
import { invalidateFrames, isInteractive, requestFrame } from "./FrameScheduler";
import { lapService } from "./LapService";
import LapController from "./controllers/LapController";

export default class Tabs {
  private TAB_DRAG_THRESHOLD_PX = 5;
  private DEFAULT_CONTROLS_HEIGHT = 200;

  private TIMELINE_CONTAINER = document.getElementsByClassName("timeline")[0] as HTMLElement;
  private TAB_BAR = document.getElementsByClassName("tab-bar")[0];
  private SHADOW_LEFT = document.getElementsByClassName("tab-bar-shadow-left")[0] as HTMLElement;
  private SHADOW_RIGHT = document.getElementsByClassName("tab-bar-shadow-right")[0] as HTMLElement;
  private SCROLL_OVERLAY = document.getElementsByClassName("tab-bar-scroll")[0] as HTMLElement;
  private DRAG_ITEM = document.getElementById("dragItem") as HTMLElement;
  private DRAG_HIGHLIGHT = document.getElementsByClassName("tab-bar-drag-highlight")[0] as HTMLElement;

  private RENDERER_CONTENT = document.getElementsByClassName("renderer-content")[0] as HTMLElement;
  private CONTROLS_CONTENT = document.getElementsByClassName("controls-content")[0] as HTMLElement;
  private CONTROLS_HANDLE = document.getElementsByClassName("controls-handle")[0] as HTMLElement;

  private CLOSE_BUTTON = document.getElementsByClassName("close")[0] as HTMLElement;
  private POPUP_BUTTON = document.getElementsByClassName("popup")[0] as HTMLElement;
  private ADD_BUTTON = document.getElementsByClassName("add-tab")[0] as HTMLElement;

  private FIXED_CONTROL_HEIGHTS: Map<TabType, number | undefined> = new Map();

  private tabsScrollSensor: ScrollSensor;
  private timeline: Timeline;

  private tabList: {
    type: TabType;
    title: string;
    titleElement: HTMLElement;
    controlsElement: HTMLElement;
    rendererElement: HTMLElement;
    controller: TabController;
    renderer: TabRenderer;
    controlsHeight: number;
  }[] = [];
  private selectedTab = 0;
  private lastControlsLayout = "";
  private shownTabsRevision = 0;
  private lapTabs = new Set<TabController>();
  private activeSatellites: string[] = [];
  /** Satellites redraw from every command, so commands go out only when they change, and at most this often. */
  private SATELLITE_INTERVAL_MS = 100;
  private SATELLITE_INTERACTIVE_INTERVAL_MS = 1000 / 30;
  private satelliteSends = new Map<
    string,
    { time: number; title: string; command: string | TracksideRendererCommand; revision: string }
  >();
  private satelliteRetry: ReturnType<typeof setTimeout> | null = null;
  private refreshRevision = 0;
  private refreshedRevision = new WeakMap<object, number>();
  private satelliteRevision = 0;
  private readonly SATELLITE_SESSION = Math.random().toString(36).slice(2);
  private fieldDragHover: { index: number; timer: number } | null = null;

  constructor() {
    // Set up tab configs
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Documentation, 0);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.LineGraph, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Table, 0);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Console, 0);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Statistics, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Field2d, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Video, 85);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Points, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Trackside, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.DriverInputs, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.CarDynamics, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Metadata, 0);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.TrackMap, undefined);
    this.FIXED_CONTROL_HEIGHTS.set(TabType.Laps, undefined);

    // Hover and click handling
    let mouseDownInfo: [number, number] | null = null;
    this.SCROLL_OVERLAY.addEventListener("mousedown", (event) => {
      mouseDownInfo = [event.clientX, event.clientY];
    });
    this.SCROLL_OVERLAY.addEventListener("mouseup", (event) => {
      if (mouseDownInfo === null) return;
      if (
        Math.abs(event.clientX - mouseDownInfo[0]) < this.TAB_DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - mouseDownInfo[1]) < this.TAB_DRAG_THRESHOLD_PX
      ) {
        this.tabList.forEach((tab, index) => {
          let rect = tab.titleElement.getBoundingClientRect();
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            this.setSelected(index);
          }
        });
      }
      mouseDownInfo = null;
    });
    this.SCROLL_OVERLAY.addEventListener("mousemove", (event) => {
      // Update hover
      this.tabList.forEach((tab) => {
        let rect = tab.titleElement.getBoundingClientRect();
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        ) {
          tab.titleElement.classList.add("tab-hovered");
        } else {
          tab.titleElement.classList.remove("tab-hovered");
        }
      });

      // Start drag
      if (
        mouseDownInfo !== null &&
        (Math.abs(event.clientX - mouseDownInfo[0]) >= this.TAB_DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - mouseDownInfo[1]) >= this.TAB_DRAG_THRESHOLD_PX)
      ) {
        // Find tab
        let tabIndex = 0;
        this.tabList.forEach((tab, index) => {
          let rect = tab.titleElement.getBoundingClientRect();
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            tabIndex = index;
          }
        });
        if (tabIndex === 0) return;

        // Trigger drag event
        while (this.DRAG_ITEM.firstChild) {
          this.DRAG_ITEM.removeChild(this.DRAG_ITEM.firstChild);
        }
        let tab = document.createElement("div");
        tab.classList.add("tab");
        if (tabIndex === this.selectedTab) {
          tab.classList.add("tab-selected");
        }
        tab.innerText = this.tabList[tabIndex].titleElement.innerText;
        this.DRAG_ITEM.appendChild(tab);
        let tabRect = this.tabList[tabIndex].titleElement.getBoundingClientRect();
        window.startDrag(event.clientX, event.clientY, event.clientX - tabRect.left, event.clientY - tabRect.top, {
          tabIndex: tabIndex
        });
        mouseDownInfo = null;
      }
    });
    this.SCROLL_OVERLAY.addEventListener("mouseout", () => {
      this.tabList.forEach((tab) => {
        tab.titleElement.classList.remove("tab-hovered");
      });
    });
    this.SCROLL_OVERLAY.addEventListener("contextmenu", (event) => {
      mouseDownInfo = null;
      this.tabList.forEach((tab, index) => {
        if (index === 0) return;
        let rect = tab.titleElement.getBoundingClientRect();
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        ) {
          window.sendMainMessage("ask-rename-tab", {
            index: index,
            name:
              this.tabList[index].title === ""
                ? getDefaultTabTitle(this.tabList[index].type)
                : this.tabList[index].title,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });
    });

    // Controls handle
    attachResizeHandle(
      this.CONTROLS_HANDLE,
      "row-resize",
      (event) => {
        this.tabList[this.selectedTab].controlsHeight = window.innerHeight - event.clientY;
        this.updateControlsHeight();
      },
      () => this.toggleControlsVisible()
    );
    window.addEventListener("toggle-tab-controls", () => this.toggleControlsVisible());
    this.updateControlsHeight();

    // Control buttons
    this.CLOSE_BUTTON.addEventListener("click", () => this.close(this.selectedTab));
    this.POPUP_BUTTON.addEventListener("click", () => this.newSatellite());
    this.ADD_BUTTON.addEventListener("click", () => {
      const rect = this.ADD_BUTTON.getBoundingClientRect();
      window.sendMainMessage("ask-new-tab", {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
    });

    // Drag handling
    window.addEventListener("drag-update", (event) => {
      let dragData = (event as CustomEvent).detail;
      if ("fields" in dragData.data) {
        // A field dragged over a tab header switches to that tab, so Raw Messages can drop onto a Line Graph
        if (!dragData.end) {
          const over = this.tabList.findIndex((tab) => {
            const r = tab.titleElement.getBoundingClientRect();
            return dragData.x >= r.left && dragData.x <= r.right && dragData.y >= r.top && dragData.y <= r.bottom;
          });
          if (over !== this.fieldDragHover?.index) {
            if (this.fieldDragHover) clearTimeout(this.fieldDragHover.timer);
            this.fieldDragHover =
              over < 0 || over === this.selectedTab
                ? null
                : { index: over, timer: window.setTimeout(() => this.setSelected(over), 350) };
          }
        } else if (this.fieldDragHover) {
          clearTimeout(this.fieldDragHover.timer);
          this.fieldDragHover = null;
        }
        return;
      }
      if (!("tabIndex" in dragData.data)) return;
      let end = dragData.end;
      let x = dragData.x;
      let y = dragData.y;
      let tabIndex = dragData.data.tabIndex;

      let tabBarRect = this.SCROLL_OVERLAY.getBoundingClientRect();
      if (y > tabBarRect.bottom + 100) {
        this.DRAG_HIGHLIGHT.hidden = true;
        return;
      }

      let closestDist = Infinity;
      let closestIndex = 0;
      this.tabList.forEach((tab, index) => {
        let dist = Math.abs(x - tab.titleElement.getBoundingClientRect().right);
        if (dist < closestDist) {
          closestDist = dist;
          closestIndex = index;
        }
      });

      if (end) {
        this.DRAG_HIGHLIGHT.hidden = true;
        if (closestIndex >= tabIndex) {
          this.shift(tabIndex, closestIndex - tabIndex);
        } else {
          this.shift(tabIndex, closestIndex - tabIndex + 1);
        }
      } else {
        this.DRAG_HIGHLIGHT.hidden = false;
        let highlightX = 0;
        highlightX =
          this.tabList[closestIndex].titleElement.getBoundingClientRect().right -
          this.SCROLL_OVERLAY.getBoundingClientRect().left +
          10;
        this.DRAG_HIGHLIGHT.style.left = highlightX.toString() + "px";
      }
    });

    // Add default tabs
    this.addTab(TabType.Documentation);
    this.addTab(TabType.LineGraph);
    this.addTab(TabType.TrackMap);
    this.setSelected(1);

    // Scroll management
    this.tabsScrollSensor = new ScrollSensor(
      this.SCROLL_OVERLAY,
      (dx: number, dy: number) => {
        this.TAB_BAR.scrollLeft += dx + dy;
      },
      ScrollSensorMouseControl.None
    );

    const updateShadows = () => this.updateTabBarShadows();
    this.TAB_BAR.addEventListener("scroll", updateShadows, { passive: true });
    new ResizeObserver(updateShadows).observe(this.TAB_BAR);

    // Add timeline
    this.timeline = new Timeline(this.TIMELINE_CONTAINER);
    this.setTimelineBandSupplier(() => lapService.bands());

    const alertElement = document.createElement("div");
    alertElement.className = "trackside-alerts";
    alertElement.hidden = true;
    document.body.append(alertElement);
    let lastAlerts = 0;
    const periodicGuard = new RenderGuard();
    const guards = new WeakMap<object, RenderGuard>();
    // Periodic function
    let periodic = () => {
      requestFrame(periodic);
      periodicGuard.run(() => {
        if (performance.now() - lastAlerts >= 200) {
          lastAlerts = performance.now();
          updateTracksideAlerts(alertElement, this.getTracksideLimits(), this.getTracksideDbcSignals());
        }
        this.tabsScrollSensor.periodic();

        // Update timeline and controls
        this.timeline.periodic();
        this.updateTimelineVisibility();
        const layout = this.controlsLayoutKey();
        if (layout !== this.lastControlsLayout) this.updateControlsHeight();
      });
      // Render new frame (only the tabs on screen here or in a satellite)
      this.getShownTabs().forEach(({ tab, activeLocal, activeSatellite }) => {
        {
          let guard = guards.get(tab);
          if (!guard) {
            guard = new RenderGuard();
            guards.set(tab, guard);
          }
          guard.run(
            () => {
              if (this.refreshedRevision.get(tab) !== this.refreshRevision) {
                this.refreshedRevision.set(tab, this.refreshRevision);
                tab.controller.refresh();
              }
              if (tab.type === TabType.Table) {
                // Update range from renderer
                let renderer = tab.renderer as TableRenderer;
                let controller = tab.controller as TableController;
                controller.addRendererRange(renderer.UUID, activeLocal ? renderer.getTimestampRange() : null);
              }
              let command = tab.controller.getCommand();
              if (activeLocal) {
                tab.renderer.render(command);
              }
              if (activeSatellite) {
                let title =
                  tab.type === TabType.Documentation
                    ? "Documentation"
                    : tab.title === ""
                    ? getDefaultTabTitle(tab.type)
                    : tab.title;
                this.sendSatelliteCommand(tab.controller.UUID, command, title, tab.type === TabType.Trackside);
              }
            },
            () =>
              inlineStatus(
                tab.rendererElement,
                "Unable to display this tab. Check its fields and options; it will retry automatically."
              ),
            () => inlineStatus(tab.rendererElement, "")
          );
        }
      });
    };
    requestFrame(periodic);
  }

  private updateTabBarShadows() {
    const bar = this.TAB_BAR;
    setStyle(this.SHADOW_LEFT, "opacity", Math.floor(bar.scrollLeft) <= 0 ? "0" : "1");
    setStyle(this.SHADOW_RIGHT, "opacity", Math.ceil(bar.scrollLeft) >= bar.scrollWidth - bar.clientWidth ? "0" : "1");
  }

  private controlsLayoutKey(): string {
    return [
      window.innerHeight,
      this.selectedTab,
      this.TIMELINE_CONTAINER.hidden,
      document.body.classList.contains("has-trackside-alerts")
    ].join("|");
  }

  private updateControlsHeight() {
    this.lastControlsLayout = this.controlsLayoutKey();
    let availableHeight = window.innerHeight - this.RENDERER_CONTENT.getBoundingClientRect().top;
    availableHeight -= 150;
    if (this.selectedTab < 0 || this.selectedTab >= this.tabList.length) return;
    let selectedTab = this.tabList[this.selectedTab];

    let fixedHeight = this.FIXED_CONTROL_HEIGHTS.get(selectedTab.type);
    let appliedHeight = clampValue(selectedTab.controlsHeight, 0, availableHeight);
    if (fixedHeight !== undefined) {
      appliedHeight = appliedHeight > 30 ? fixedHeight : 0;
    } else {
      if (appliedHeight >= 30 && appliedHeight < 100) appliedHeight = 100;
      if (appliedHeight > availableHeight) appliedHeight = 0;
      if (appliedHeight < 30) appliedHeight = 0;
    }
    selectedTab.controlsHeight = appliedHeight;
    setHidden(this.CONTROLS_HANDLE, fixedHeight === 0);
    setHidden(this.CONTROLS_CONTENT, appliedHeight === 0);
    setRootProperty("--tab-controls-height", appliedHeight.toString() + "px");
    setRootProperty("--show-tab-controls", appliedHeight === 0 ? "0" : "1");
  }

  /** Returns the current state. */
  saveState(): TabsState {
    return {
      selected: this.selectedTab,
      tabs: this.tabList.map((tab) => {
        return {
          type: tab.type,
          title: tab.title,
          controller: tab.controller.saveState(),
          controllerUUID: tab.controller.UUID,
          renderer: tab.renderer.saveState(),
          controlsHeight: tab.controlsHeight
        };
      })
    };
  }

  /** Applies a saved tab's title, contents and controls height to the tab at `index`. */
  private restoreTab(index: number, tabState: TabState) {
    if (tabState.title) this.renameTab(index, tabState.title);
    this.tabList[index].controller.restoreState(tabState.controller);
    this.tabList[index].renderer.restoreState(tabState.renderer);

    let tabConfig = this.FIXED_CONTROL_HEIGHTS.get(tabState.type);
    // Layouts from before the lap tabs had source lists saved a height of 0.
    let oldLapTab =
      tabState.controlsHeight === 0 &&
      (tabState.type === TabType.TrackMap || tabState.type === TabType.Laps) &&
      !(tabState.controller as { sourceLists?: boolean } | null)?.sourceLists;
    if (!oldLapTab && (tabState.controlsHeight === 0 || tabConfig === undefined)) {
      this.tabList[index].controlsHeight = tabState.controlsHeight;
    }
  }

  /**
   * Adds a layout's tabs after the open ones and selects the first added tab. The layout's
   * Documentation tab is skipped (the hub keeps exactly one) and each tab gets a fresh controller
   * UUID, so adding the same layout twice doesn't share satellites or log subscriptions.
   */
  appendState(state: TabsState) {
    const tabs = filterRestorableTabs(state.tabs, state.selected).tabs.filter(
      (tab) => tab.type !== TabType.Documentation
    );
    if (tabs.length === 0) return;
    const first = this.tabList.length;
    tabs.forEach((tabState) => {
      this.selectedTab = this.tabList.length - 1;
      this.addTab(tabState.type);
      this.restoreTab(this.tabList.length - 1, tabState);
    });
    this.selectedTab = first;
    this.updateElements();
    this.updateControlsHeight();
  }

  /** Restores to the provided state. */
  restoreState(state: TabsState) {
    this.tabList.forEach((tab) => {
      tab.controller.dispose?.();
      tab.renderer.dispose?.();
      this.RENDERER_CONTENT.removeChild(tab.rendererElement);
      this.CONTROLS_CONTENT.removeChild(tab.controlsElement);
    });
    this.tabList = [];
    this.lapTabs.clear();
    this.shownTabsCache = null;
    this.selectedTab = 0;
    const restored = filterRestorableTabs(state.tabs, state.selected);
    restored.tabs.forEach((tabState, index) => {
      this.addTab(tabState.type);
      this.tabList[index].controller.UUID = tabState.controllerUUID;
      this.restoreTab(index, tabState);
    });
    if (this.tabList.length === 0) this.addTab(TabType.Documentation);
    this.selectedTab = restored.selected;
    this.updateElements();
    this.updateControlsHeight();
  }

  /** Refresh shown controllers whose fields changed. Catalogue changes also invalidate hidden tabs. */
  refresh(changed: ReadonlySet<string> | null = null) {
    if (changed === null) this.refreshRevision++;
    for (const shown of this.getShownTabs()) {
      if (changed !== null && !this.touchesFields(shown, changed)) continue;
      this.refreshedRevision.set(shown.tab, this.refreshRevision);
      shown.tab.controller.refresh();
    }
    if (changed === null) this.visibleFields = null;
  }

  private touchesFields(shown: ReturnType<Tabs["getShownTabs"]>[number], changed: ReadonlySet<string>): boolean {
    const fields = this.getVisibleFieldCache().byTab.get(shown.tab);
    if (!fields) return false;
    for (const key of changed) {
      if (fields.has(key)) return true;
    }
    return false;
  }

  private shownTabsCache: {
    selected: number;
    satellites: string[];
    tabs: { tab: Tabs["tabList"][number]; activeLocal: boolean; activeSatellite: boolean }[];
  } | null = null;

  /** The selected tab and tabs open in satellites. Rebuilt only when tabs, selection or satellites change. */
  private getShownTabs() {
    const cache = this.shownTabsCache;
    if (cache && cache.selected === this.selectedTab && cache.satellites === this.activeSatellites) return cache.tabs;
    const tabs: { tab: Tabs["tabList"][number]; activeLocal: boolean; activeSatellite: boolean }[] = [];
    this.tabList.forEach((tab, index) => {
      const activeLocal = index === this.selectedTab;
      const activeSatellite = this.activeSatellites.includes(tab.controller.UUID);
      if (activeLocal || activeSatellite) tabs.push({ tab, activeLocal, activeSatellite });
    });
    this.shownTabsRevision++;
    this.shownTabsCache = { selected: this.selectedTab, satellites: this.activeSatellites, tabs };
    return tabs;
  }

  /** Refresh based on a new set of assets. */
  newAssets() {
    this.tabList.forEach((tab) => {
      tab.controller.newAssets();
    });
  }

  private dbcFields: { log: typeof window.log; fieldsVersion: number; metadataVersion: number; keys: string[] } | null =
    null;

  /** Fields with a DBC definition, cached until the log's fields or metadata change. */
  private getDbcFields(): string[] {
    const log = window.log;
    const cache = this.dbcFields;
    if (
      cache &&
      cache.log === log &&
      cache.fieldsVersion === log.getFieldKeysVersion() &&
      cache.metadataVersion === log.getMetadataVersion()
    )
      return cache.keys;
    const keys = log.getFieldKeys().filter((key) => dbcDefinition(log.getMetadataString(key), key));
    this.dbcFields = {
      log,
      fieldsVersion: log.getFieldKeysVersion(),
      metadataVersion: log.getMetadataVersion(),
      keys
    };
    return keys;
  }

  /** Sends changes at the satellite cadence. A held-back change gets a trailing frame. */
  private sendSatelliteCommand(uuid: string, command: unknown, title: string, trackside: boolean) {
    const last = this.satelliteSends.get(uuid);
    if (last?.title === title && last.command === command) return;
    const now = performance.now();
    const interval = isInteractive() ? this.SATELLITE_INTERACTIVE_INTERVAL_MS : this.SATELLITE_INTERVAL_MS;
    if (last !== undefined && now - last.time < interval - 4) {
      if (this.satelliteRetry === null)
        this.satelliteRetry = setTimeout(
          () => {
            this.satelliteRetry = null;
            invalidateFrames();
          },
          last.time + interval - now
        );
      return;
    }
    const saved = trackside ? (command as TracksideRendererCommand) : JSON.stringify(command);
    if (last?.command === saved && last.title === title) return;
    let update: object = { command };
    if (
      typeof saved !== "string" &&
      last &&
      typeof last.command !== "string" &&
      last.command.tiles.length === saved.tiles.length
    ) {
      const patch = diffTrackside(last.command, saved);
      if (!patch.tiles.length && patch.graph === undefined && patch.message === undefined && last.title === title)
        return;
      update = { patch, baseRevision: last.revision };
    }
    const revision = this.SATELLITE_SESSION + ":" + (++this.satelliteRevision).toString();
    this.satelliteSends.set(uuid, { time: now, title, command: saved, revision });
    window.sendMainMessage("update-satellite", { uuid, title, revision, ...update });
  }

  /** Whether a tab draws laps, so it needs the lap service's fields. */
  private showsLaps(tab: { controller: TabController }): boolean {
    return this.lapTabs.has(tab.controller);
  }

  private visibleFields: {
    at: number;
    shown: ReturnType<Tabs["getShownTabs"]>;
    keys: Set<string>;
    byTab: Map<Tabs["tabList"][number], Set<string>>;
  } | null = null;

  /** Shown fields and parent keys used for ingest invalidation. */
  private getVisibleFieldCache() {
    const now = performance.now();
    const shown = this.getShownTabs();
    const cache = this.visibleFields;
    if (cache && now - cache.at < 250 && cache.shown === shown) return cache;
    const keys = new Set<string>();
    const byTab = new Map<Tabs["tabList"][number], Set<string>>();
    shown.forEach(({ tab }) => {
      const fields = [...tab.controller.getActiveFields(), ...(this.showsLaps(tab) ? lapService.fields() : [])];
      const related = new Set<string>();
      fields.forEach((field) => {
        for (let key = field; key.length > 0 && !related.has(key); key = key.substring(0, key.lastIndexOf("/"))) {
          keys.add(key);
          related.add(key);
        }
      });
      byTab.set(tab, related);
    });
    return (this.visibleFields = { at: now, shown, keys, byTab });
  }

  getVisibleFields(): ReadonlySet<string> {
    return this.getVisibleFieldCache().keys;
  }

  /** Changes when the selected tab or the set of satellite tabs changes. */
  getVisibleTabsKey(): string {
    this.getShownTabs();
    return this.shownTabsRevision.toString();
  }

  /**
   * Returns the set of fields currently being displayed. With `onlyVisible`, fields of tabs that are
   * not on screen are left out; live sources use it to stream only what is drawn and backfill a tab's
   * history when it is shown. Alerts, laps and enabled state are background features and always count.
   */
  getActiveFields(onlyVisible = false): Set<string> {
    const tabs = onlyVisible ? this.getShownTabs().map(({ tab }) => tab) : this.tabList;
    const hasLapView = this.lapTabs.size > 0;
    let activeFields = new Set<string>([...this.getDbcFields(), ...(hasLapView ? lapService.fields() : [])]);
    tabs.forEach((tab) => {
      tab.controller.getActiveFields().forEach((field) => {
        activeFields.add(field);
      });
    });
    let enabledKey = getEnabledKey(window.log);
    if (enabledKey !== undefined) {
      activeFields.add(enabledKey);
    }
    let autonomousKey = getAutonomousKey(window.log);
    if (autonomousKey !== undefined) {
      activeFields.add(autonomousKey);
    }
    let utilityKey = getUtilityKey(window.log);
    if (utilityKey !== undefined) {
      activeFields.add(utilityKey);
    }
    return activeFields;
  }

  getTracksideDbcSignals(): { [key: string]: string } {
    return Object.assign(
      {},
      ...this.tabList.flatMap((tab) =>
        tab.controller instanceof TracksideController ? [tab.controller.getSavedDbcSignals()] : []
      )
    );
  }

  getTracksideLimits() {
    return this.tabList.flatMap((tab) =>
      tab.controller instanceof TracksideController ? [tab.controller.getLimits()] : []
    );
  }

  editTracksideLimits(uuid: string, key: string, limits: { low?: number; high?: number }) {
    const controller = this.tabList.find((tab) => tab.controller.UUID === uuid)?.controller;
    if (controller instanceof TracksideController) controller.limits[key] = limits;
  }

  /** Toggles the visibility of the tab controls. */
  getControlsVisible() {
    return this.tabList[this.selectedTab]?.controlsHeight > 0;
  }
  toggleControlsVisible() {
    let fixedHeight = this.FIXED_CONTROL_HEIGHTS.get(this.tabList[this.selectedTab].type);
    if (this.tabList[this.selectedTab].controlsHeight === 0) {
      this.tabList[this.selectedTab].controlsHeight =
        fixedHeight === undefined ? this.DEFAULT_CONTROLS_HEIGHT : fixedHeight;
    } else {
      this.tabList[this.selectedTab].controlsHeight *= -1;
    }
    this.updateControlsHeight();
  }

  /** Creates a new tab. */
  addTab(type: TabType) {
    // Select existing metadata tab
    if (type === TabType.Metadata) {
      let existingIndex = this.tabList.findIndex((tab) => tab.type === TabType.Metadata);
      if (existingIndex >= 0) {
        this.setSelected(existingIndex);
        return;
      }
    }

    // Add tab
    let controlsElement = document.getElementById("controller" + type.toString())?.cloneNode(true) as HTMLElement;
    let rendererElement = document.getElementById("renderer" + type.toString())?.cloneNode(true) as HTMLElement;
    controlsElement.removeAttribute("id");
    rendererElement.removeAttribute("id");
    let controller: TabController;
    let renderer: TabRenderer;
    switch (type) {
      case TabType.Documentation:
        controller = new NoopController();
        renderer = new DocumentationRenderer(rendererElement);
        break;
      case TabType.LineGraph:
        const lineGraph = new LineGraphController(controlsElement);
        lineGraph.onLapModeChanged = () => {
          if (lineGraph.getLapMode() === "time") this.lapTabs.delete(lineGraph);
          else this.lapTabs.add(lineGraph);
          this.visibleFields = null;
        };
        controller = lineGraph;
        renderer = new LineGraphRenderer(rendererElement, true);
        break;
      case TabType.Field2d:
        controller = new Field2dController(controlsElement);
        renderer = new Field2dRenderer(rendererElement);
        break;
      case TabType.Table:
        controller = new TableController(rendererElement);
        renderer = new TableRenderer(rendererElement, true);
        break;
      case TabType.Console:
        controller = new ConsoleController(rendererElement);
        renderer = new ConsoleRenderer(rendererElement, true);
        break;
      case TabType.Statistics:
        controller = new StatisticsController(controlsElement);
        renderer = new StatisticsRenderer(rendererElement);
        break;
      case TabType.Video:
        controller = new VideoController(controlsElement);
        renderer = new VideoRenderer(rendererElement);
        break;
      case TabType.Trackside:
        controller = new TracksideController(controlsElement);
        renderer = new TracksideRenderer(rendererElement, (from, to) =>
          (controller as TracksideController).reorderTiles(from, to)
        );
        break;
      case TabType.Points:
        controller = new PointsController(controlsElement);
        renderer = new PointsRenderer(rendererElement);
        break;
      case TabType.DriverInputs:
        controller = new DriverInputsController(controlsElement);
        renderer = new DriverInputsRenderer(rendererElement);
        break;
      case TabType.CarDynamics:
        controller = new CarDynamicsController(controlsElement);
        renderer = new CarDynamicsRenderer(rendererElement);
        break;
      case TabType.TrackMap:
      case TabType.Laps:
        controller = new LapController(rendererElement, type === TabType.TrackMap, controlsElement);
        renderer = new LapRenderer(rendererElement);
        break;
      case TabType.Metadata:
        controller = new MetadataController();
        renderer = new MetadataRenderer(rendererElement);
        break;
      default:
        controller = new NoopController();
        renderer = new NoopRenderer();
        break;
    }

    // Create title element
    let titleElement = document.createElement("div");
    titleElement.classList.add("tab");
    titleElement.innerText = getTabIcon(type) + " " + getDefaultTabTitle(type);
    titleElement.tabIndex = 0;
    titleElement.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        let index = this.tabList.findIndex((t) => t.titleElement === titleElement);
        if (index !== -1) {
          this.setSelected(index);
        }
      }
    });

    // Save to tab list
    if (this.tabList.length === 0) {
      this.selectedTab = -1;
    }
    let controlsHeightConfig = this.FIXED_CONTROL_HEIGHTS.get(type);
    this.shownTabsCache = null;
    if (type === TabType.TrackMap || type === TabType.Laps) this.lapTabs.add(controller);
    this.tabList.splice(this.selectedTab + 1, 0, {
      type: type,
      title: "",
      titleElement: titleElement,
      controlsElement: controlsElement,
      rendererElement: rendererElement,
      controller: controller,
      renderer: renderer,
      controlsHeight: controlsHeightConfig === undefined ? this.DEFAULT_CONTROLS_HEIGHT : controlsHeightConfig
    });
    this.selectedTab += 1;
    this.CONTROLS_CONTENT.appendChild(controlsElement);
    this.RENDERER_CONTENT.appendChild(rendererElement);
    this.updateElements();
  }

  /** Create new sallite for current tab. */
  newSatellite() {
    if (this.selectedTab >= 0) {
      window.sendMainMessage("create-satellite", {
        uuid: this.tabList[this.selectedTab].controller.UUID,
        type: this.tabList[this.selectedTab].type
      });
    }
  }

  /** Closes the specified tab. */
  close(index: number) {
    if (index < 1 || index > this.tabList.length - 1) return;

    this.tabList[index].controller.dispose?.();
    this.tabList[index].renderer.dispose?.();
    this.RENDERER_CONTENT.removeChild(this.tabList[index].rendererElement);
    this.CONTROLS_CONTENT.removeChild(this.tabList[index].controlsElement);
    this.lapTabs.delete(this.tabList[index].controller);
    this.tabList.splice(index, 1);
    this.shownTabsCache = null;
    if (this.selectedTab > index) this.selectedTab--;
    if (this.selectedTab > this.tabList.length - 1) this.selectedTab = this.tabList.length - 1;
    this.updateElements();
  }

  /** Returns the index of the selected tab. */
  getSelectedTab(): number {
    return this.selectedTab;
  }

  /** Returns the type of the selected tab. */
  getSelectedTabType(): TabType {
    return this.tabList[this.selectedTab].type;
  }

  /** Changes which tab is currently selected. */
  setSelected(index: number) {
    if (index < 0 || index > this.tabList.length - 1) return;
    this.selectedTab = index;
    this.updateElements();
  }

  /** Moves the specified tab left or right. */
  shift(index: number, shift: number) {
    const minIndex = 1;
    if (index < minIndex) return;
    if (index + shift < minIndex) shift = minIndex - index;
    if (index + shift > this.tabList.length - 1) shift = this.tabList.length - 1 - index;
    if (this.selectedTab === index) {
      this.selectedTab += shift;
    } else if (index > this.selectedTab && shift <= this.selectedTab - index) {
      this.selectedTab++;
    } else if (index < this.selectedTab && shift >= this.selectedTab - index) {
      this.selectedTab--;
    }

    let tab = this.tabList.splice(index, 1)[0];
    this.tabList.splice(index + shift, 0, tab);
    this.shownTabsCache = null;
    this.updateElements();
  }

  /** Sets the source of bands drawn behind the timeline (e.g. laps). */
  setTimelineBandSupplier(supplier: () => TimelineBand[]) {
    this.timeline.setBandSupplier(supplier);
  }

  /** Updates the list of active satellites for data publishing. */
  setActiveSatellites(activeSatellites: string[]) {
    this.activeSatellites = activeSatellites;
    // A satellite that closes and reopens needs its first command again
    for (const uuid of this.satelliteSends.keys())
      if (!activeSatellites.includes(uuid)) this.satelliteSends.delete(uuid);
  }

  /** Check whether the UUID is associated with a tab. */
  isValidUUID(uuid: string) {
    for (let i = 0; i < this.tabList.length; i++) {
      if (uuid === this.tabList[i].controller.UUID) {
        return true;
      }
    }
    return false;
  }

  /** Renames a single tab. */
  renameTab(index: number, name: string) {
    let tab = this.tabList[index];
    if (name === getDefaultTabTitle(tab.type)) {
      name = "";
    }
    tab.title = name;
    tab.titleElement.innerText = getTabIcon(tab.type) + " " + (name === "" ? getDefaultTabTitle(tab.type) : name);
  }

  /** Adjusts the locked range and unit conversion for an axis on the selected line graph. */
  editAxis(
    legend: string,
    lockedRange: [number, number] | null,
    unitConversion: Units.UIUnitOptions,
    filter: LineGraphFilter
  ) {
    if (this.tabList[this.selectedTab].type === TabType.LineGraph) {
      (this.tabList[this.selectedTab].controller as LineGraphController).editAxis(
        legend,
        lockedRange,
        unitConversion,
        filter
      );
    }
  }

  /** Clear the fields for an axis on the selected line graph. */
  clearAxis(legend: string) {
    if (this.tabList[this.selectedTab].type === TabType.LineGraph) {
      (this.tabList[this.selectedTab].controller as LineGraphController).clearAxis(legend);
    }
  }

  /** Sets the state of the robot mode visualization  on the selected line graph. */
  setRobotModeVisible(showRobotMode: boolean) {
    if (this.tabList[this.selectedTab].type === TabType.LineGraph) {
      (this.tabList[this.selectedTab].controller as LineGraphController).setRobotModeVisible(showRobotMode);
    }
  }

  /** Switches the selected camera mode for the selected 2D field. */
  set2DCamera(index: number) {
    if (this.tabList[this.selectedTab].type === TabType.Field2d) {
      (this.tabList[this.selectedTab].renderer as Field2dRenderer).set2DCamera(index);
    }
  }

  /** Adds a timestamp range for a table renderer. */
  addTableRange(controllerUUID: string, rendererUUID: string, range: [number, number] | null) {
    this.tabList.forEach((tab) => {
      if (tab.type === TabType.Table && tab.controller.UUID === controllerUUID) {
        (this.tabList[this.selectedTab].controller as TableController).addRendererRange(rendererUUID, range);
      }
    });
  }

  /** Returns whether the selected tab is a video which
   * is unlocked (and thus requires access to the left
   * and right arrow keys) */
  isUnlockedVideoSelected(): boolean {
    if (this.tabList[this.selectedTab].type === TabType.Video) {
      return !(this.tabList[this.selectedTab].controller as VideoController).isLocked();
    } else {
      return false;
    }
  }

  /** Sends video data to all video controllers. */
  processVideoData(data: any) {
    this.tabList.forEach((tab) => {
      if (tab.type === TabType.Video) {
        (tab.controller as VideoController).processVideoData(data);
      }
    });
  }

  /** Updates the displayed elements based on the tab list. */
  private updateElements() {
    // Remove old tabs
    while (this.TAB_BAR.firstChild) {
      this.TAB_BAR.removeChild(this.TAB_BAR.firstChild);
    }

    // Add title elements
    this.tabList.forEach((item, index) => {
      this.TAB_BAR.appendChild(item.titleElement);
      if (index === this.selectedTab) {
        item.titleElement.classList.add("tab-selected");
        item.rendererElement.hidden = false;
        item.controlsElement.hidden = false;
      } else {
        item.titleElement.classList.remove("tab-selected");
        item.rendererElement.hidden = true;
        item.controlsElement.hidden = true;
      }
    });

    this.updateTabBarShadows();
    // Selection and topology can change the controls height and timeline.
    this.updateTimelineVisibility();
    this.updateControlsHeight();
  }

  /** Hides or shows the timeline based on the controller request. */
  private updateTimelineVisibility() {
    let show = this.tabList[this.selectedTab].controller.showTimeline();
    setRootProperty("--show-timeline", show ? "1" : "0");
    setHidden(this.TIMELINE_CONTAINER, !show);
  }
}
