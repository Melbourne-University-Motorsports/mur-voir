// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { IS_LITE } from "../shared/buildConstants";
import { formatChannelValue, rawChannelValue } from "../shared/display/ChannelProfile";
import { setInnerText } from "../shared/domWrite";
import { SidebarState } from "../shared/HubState";
import { FieldFilter, FieldFilterResult, filterFieldTree, isFilterActive, LiveFilter } from "../shared/log/FieldFilter";
import LogFieldTree from "../shared/log/LogFieldTree";
import LoggableType from "../shared/log/LoggableType";
import { getOrDefault, TYPE_KEY } from "../shared/log/LogUtil";
import { RenderGuard } from "../shared/RenderGuard";
import { SelectionMode } from "../shared/Selection";
import { arraysEqual, htmlEncode, setsEqual } from "../shared/util";
import CustomSchemas from "./dataSources/schema/CustomSchemas";
import { invalidateFrames, isTextFrame, requestFrame } from "./FrameScheduler";
import { attachResizeHandle } from "./ResizeHandle";

export default class Sidebar {
  private DEFAULT_SIDEBAR_WIDTH = 300;

  private SIDEBAR = document.getElementsByClassName("side-bar")[0] as HTMLElement;
  private SIDEBAR_HANDLE = document.getElementsByClassName("side-bar-handle")[0] as HTMLElement;
  private SIDEBAR_SHADOW = document.getElementsByClassName("side-bar-shadow")[0] as HTMLElement;
  private SIDEBAR_TITLE = document.getElementsByClassName("side-bar-title")[0] as HTMLElement;
  private SEARCH_INPUT = document.getElementsByClassName("side-bar-search")[0] as HTMLInputElement;
  private LIVE_FILTER = document.getElementsByClassName("side-bar-live-filter")[0] as HTMLSelectElement;
  private TUNING_BUTTON = document.getElementsByClassName("side-bar-tuning-button")[0] as HTMLButtonElement;
  private FIELD_LIST = document.getElementById("fieldList") as HTMLElement;
  private ICON_TEMPLATES = document.getElementById("fieldItemIconTemplates") as HTMLElement;
  private DRAG_ITEM = document.getElementById("dragItem") as HTMLElement;

  private MERGED_KEY = "Log";
  private KNOWN_KEYS = [
    "DriverStation",
    "NetworkTables",
    "RealOutputs",
    "ReplayOutputs",
    "SystemStats",
    "PowerDistribution",
    "Tuning",
    "NetworkInputs",
    "DashboardInputs",
    "RadioStatus",
    "Timestamp",
    "AdvantageKit",
    "DS",
    "NT",
    "NTConnection",
    "messages",
    "systemTime",
    "DSLog",
    "DSEvents"
  ];
  private HIDDEN_KEYS = [".schema", "Metadata", "RealMetadata", "ReplayMetadata"];
  private INDENT_SIZE_PX = 20;
  private FIELD_DRAG_THRESHOLD_PX = 3;
  private VALUE_WIDTH_MARGIN_PX = 12;
  private LIVE_FILTER_PERIOD_MS = 1000;

  private getFilenames: () => string[];
  private sidebarWidth = this.DEFAULT_SIDEBAR_WIDTH;
  private fieldCount = 0;
  private isTuningMode = false;
  private fieldKeysLog: unknown;
  private fieldKeysVersion = -1;
  private lastFieldKeys: string[] = [];
  private expandedFields = new Set<string>();
  private activeFields = new Set<string>();
  private activeFieldCallbacks: (() => void)[] = [];
  private updateTypeWarningCallbacks: (() => void)[] = [];
  private updateValueCallbacks: ((time: number | null) => void)[] = [];
  /** Field rows on screen, reported by an observer so value updates never measure every row. */
  private rowOnScreen = new WeakMap<Element, boolean>();
  private rowKeys = new WeakMap<Element, string>();
  private onScreenFields = new Set<string>();
  private rowObserver =
    typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => this.rowsMoved(entries)) : null;
  private selectGroup: string[] = [];
  private selectGroupClearCallbacks: (() => void)[] = [];
  private revealKey: string | null = null;
  private revealCallbacks: (() => void)[] = [];
  private fieldMouseMove: ((event: MouseEvent) => void) | null = null;

  // Field filter, per window and never saved in layouts
  private filter: FieldFilter = { query: "", live: "all" };
  private filterResult: FieldFilterResult | null = null;
  private filterExpanded = new Map<string, boolean>(); // Folders opened or closed by hand while filtering
  private filterCursorKey: string | null = null;
  private unfilteredScroll = 0;
  private aliasCache = new Map<string, { metadata: string; aliases: string[] }>();
  private setTuningModeActiveCallbacks: ((active: boolean) => void)[] = [];
  private tuningModePublishCallbacks: (() => void)[] = [];
  private tuningValueCache: { [key: string]: string } = {};
  private updateMetadataCallbacks: (() => void)[] = [];
  private updateLoadingCallbacks: ((loadingFields: Set<string>) => void)[] = [];

  constructor(getFilenames: () => string[]) {
    this.getFilenames = getFilenames;

    // Set up handle for resizing
    let enableIframes = (enabled: boolean) => {
      Array.from(document.getElementsByTagName("iframe")).forEach((iframe) => {
        iframe.style.pointerEvents = enabled ? "initial" : "none";
      });
    };
    attachResizeHandle(
      this.SIDEBAR_HANDLE,
      "col-resize",
      (event) => {
        let width = event.clientX;
        if (width > 500) width = 500;
        if (width >= 80 && width < 160) width = 160;
        if (width < 80) {
          if (this.sidebarWidth > 0) {
            width = 0;
          } else {
            width = this.sidebarWidth;
          }
        }
        this.sidebarWidth = width;
        this.updateWidth();
      },
      () => this.toggleVisible(),
      (active) => enableIframes(!active)
    );
    this.updateWidth();

    // Set up shadow when scrolling
    this.SIDEBAR.addEventListener("scroll", () => {
      this.SIDEBAR_SHADOW.style.opacity = this.SIDEBAR.scrollTop === 0 ? "0" : "1";
    });

    // Menu bar
    let menuBar = document.getElementsByClassName("title-bar-menu")[0] as HTMLElement;
    Array.from(menuBar.getElementsByTagName("button")).forEach((button, index) => {
      let active = false;
      button.addEventListener("click", () => {
        if (active && !IS_LITE) {
          active = false;
          window.sendMainMessage("close-app-menu", {
            index: index
          });
        } else {
          active = true;
          let rect = button.getBoundingClientRect();
          window.sendMainMessage("open-app-menu", {
            index: index,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });
      button.addEventListener("mouseleave", () => {
        active = false;
      });
    });

    // Field filter controls
    this.SEARCH_INPUT.addEventListener("input", () => {
      this.filter.query = this.SEARCH_INPUT.value;
      this.applyFilter();
    });
    this.SEARCH_INPUT.addEventListener("keydown", (event) => {
      if (event.code === "ArrowDown" || event.code === "ArrowUp") {
        event.preventDefault();
        this.moveFilterCursor(event.code === "ArrowDown" ? 1 : -1);
      } else if (event.code === "Enter") {
        this.revealFilterCursor();
      } else if (event.code === "Escape" && this.SEARCH_INPUT.value.length > 0) {
        event.preventDefault();
        this.SEARCH_INPUT.value = "";
        this.filter.query = "";
        this.applyFilter();
      }
    });
    this.LIVE_FILTER.addEventListener("change", () => {
      this.filter.live = this.LIVE_FILTER.value as LiveFilter;
      this.applyFilter();
    });

    // Dragging fields (one listener for every field, since the tree is rebuilt as the filter changes)
    window.addEventListener("mousemove", (event) => this.fieldMouseMove?.(event));
    window.addEventListener("mouseup", () => (this.fieldMouseMove = null));

    // Tuning button
    this.TUNING_BUTTON.addEventListener("click", () => {
      this.setTuningModeActive(!this.isTuningMode);
    });
    this.TUNING_BUTTON.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      let values = Object.keys(this.tuningValueCache)
        .sort()
        .map((key) => key + " = " + this.tuningValueCache[key])
        .join("\n");
      window.sendMainMessage("ask-open-tuning-context-menu", {
        isTuningMode: this.isTuningMode,
        values: values,
        position: [event.clientX, event.clientY]
      });
    });

    // Periodic functions, run in paced frames so an idle window does none of this
    const guard = new RenderGuard();
    const liveFilterGuard = new RenderGuard();
    let lastTuningPublish = -Infinity;
    let lastLiveFilter = -Infinity;
    let lastValues = -Infinity;
    let periodic = () => {
      requestFrame(periodic);
      guard.run(() => {
        this.updateLiveFilterControl();
        this.updateTitle();
        if (isTextFrame(lastValues)) {
          lastValues = performance.now();
          this.updateValues();
        }
        this.updateTuningButton();
      });
      const now = performance.now();
      if (this.isTuningMode && now - lastTuningPublish >= 250) {
        lastTuningPublish = now;
        this.tuningModePublishCallbacks.forEach((callback) => callback());
      }
      // Fields go live or stale continuously; follow them at most once per period, never per sample
      if (now - lastLiveFilter >= this.LIVE_FILTER_PERIOD_MS) {
        lastLiveFilter = now;
        liveFilterGuard.run(() => this.updateLiveFilter());
      }
    };
    requestFrame(periodic);
  }

  /** Returns the current state. */
  saveState(): SidebarState {
    return {
      width: this.sidebarWidth,
      expanded: [...this.expandedFields]
    };
  }

  /** Restores to the provided state. */
  restoreState(state: SidebarState) {
    let widthEqual = state.width === this.sidebarWidth;
    let expandedSet = new Set<string>(state.expanded);
    let expandedEqual = setsEqual(expandedSet, this.expandedFields);
    this.sidebarWidth = state.width;
    this.expandedFields = expandedSet;
    if (!widthEqual) this.updateWidth();
    if (!expandedEqual) this.refresh(true);
  }

  /** Toggles the visibility of the sidebar. */
  toggleVisible() {
    if (this.sidebarWidth === 0) {
      this.sidebarWidth = this.DEFAULT_SIDEBAR_WIDTH;
    } else {
      this.sidebarWidth *= -1;
    }
    this.updateWidth();
  }

  /** The filter applied to the tree. Live state only filters while a live source reports it. */
  private getEffectiveFilter(): FieldFilter {
    return { query: this.filter.query, live: window.liveStatus ? this.filter.live : "all" };
  }

  /** Filters the field tree, or returns null when no filter is active. */
  private computeFilter(tree: { [id: string]: LogFieldTree }): FieldFilterResult | null {
    const filter = this.getEffectiveFilter();
    if (!isFilterActive(filter)) return null;
    return filterFieldTree(tree, filter, {
      freshness: (key) => window.liveStatus?.getFieldFreshness(key) ?? null,
      aliases: (key) => this.getAliases(key),
      isGenerated: (key) => window.log.isGenerated(key),
      hiddenKeys: this.HIDDEN_KEYS
    });
  }

  /** Display label and DBC signal name from a field's metadata. */
  private getAliases(key: string): string[] {
    const metadata = window.log.getMetadataString(key);
    const cached = this.aliasCache.get(key);
    if (cached && cached.metadata === metadata) return cached.aliases;
    let aliases: string[] = [];
    if (metadata.length > 0) {
      try {
        const parsed = JSON.parse(metadata);
        aliases = [parsed?.label, parsed?.dbcSignal].filter((x) => typeof x === "string" && x.length > 0);
      } catch {
        // Not every field has JSON metadata
      }
    }
    this.aliasCache.set(key, { metadata: metadata, aliases: aliases });
    return aliases;
  }

  /** Rebuilds the tree after the user changes the filter. */
  private applyFilter() {
    const wasActive = this.filterResult !== null;
    const active = isFilterActive(this.getEffectiveFilter());
    if (!wasActive && active) this.unfilteredScroll = this.SIDEBAR.scrollTop;
    this.filterExpanded.clear();
    this.filterCursorKey = null;
    this.refresh(true);
    if (active) {
      this.SIDEBAR.scrollTop = 0;
    } else if (wasActive) {
      this.SIDEBAR.scrollTop = this.unfilteredScroll;
    }
  }

  /** Re-filters by live state, rebuilding only when the visible tree changes. */
  private updateLiveFilter() {
    if (this.filterResult === null || this.getEffectiveFilter().live === "all") return;
    const result = this.computeFilter(this.getDisplayTree());
    if (result === null || result.signature !== this.filterResult.signature) this.refresh(true);
  }

  /** Enables the live state filter only while a live source reports field freshness. */
  private updateLiveFilterControl() {
    const available = window.liveStatus !== null;
    if (this.LIVE_FILTER.disabled === !available) return;
    this.LIVE_FILTER.disabled = !available;
    this.LIVE_FILTER.title = available
      ? "Filter fields by live state"
      : "Connect to a live source to filter fields by live state";
    if (!available && this.filter.live !== "all") {
      this.filter.live = "all";
      this.LIVE_FILTER.value = "all";
      this.applyFilter();
    }
  }

  /** Moves the keyboard selection through the matching fields. */
  private moveFilterCursor(step: number) {
    if (this.filterResult === null) return;
    const matches = Array.from(
      this.FIELD_LIST.querySelectorAll<HTMLElement>("div.field-item-container.filter-match")
    ).filter((element) => element.offsetParent !== null);
    if (matches.length === 0) return;
    let index = matches.findIndex((element) => element.dataset.key === this.filterCursorKey);
    index =
      index === -1 ? (step > 0 ? 0 : matches.length - 1) : Math.min(Math.max(index + step, 0), matches.length - 1);
    this.filterCursorKey = matches[index].dataset.key!;
    matches.forEach((element, i) => element.classList.toggle("filter-cursor", i === index));
    matches[index].scrollIntoView({ block: "nearest" });
  }

  /** Clears the text filter and shows the selected (or first) matching field in the tree. */
  private revealFilterCursor() {
    if (this.filterResult === null) return;
    let key = this.filterCursorKey;
    if (key === null) {
      const first = this.FIELD_LIST.querySelector<HTMLElement>("div.field-item-container.filter-match");
      if (first === null) return;
      key = first.dataset.key!;
    }
    this.SEARCH_INPUT.value = "";
    this.filter.query = "";
    this.applyFilter();
    this.revealKey = key;
    this.revealCallbacks.forEach((callback) => callback());
    this.revealKey = null;
    this.SEARCH_INPUT.blur();
  }

  /** Updates the displayed width based on the current state. */
  private updateWidth() {
    let appliedWidth = Math.max(this.sidebarWidth, 0);
    document.documentElement.style.setProperty("--side-bar-width", appliedWidth.toString() + "px");
    document.documentElement.style.setProperty("--show-side-bar", appliedWidth === 0 ? "0" : "1");
  }

  /** Updates the title with the duration and field count. */
  private updateTitle() {
    let range = window.log.getTimestampRange();
    let liveTime = window.selection.getCurrentLiveTime();
    if (liveTime !== null) {
      range[1] = liveTime;
    }
    let title: string;
    if (this.fieldCount === 0) {
      title = "Open a log or connect to view data";
    } else {
      let runtime = range[1] - range[0];
      let runtimeUnit = "s";
      if (runtime > 120) {
        runtime /= 60;
        runtimeUnit = "m";
      }
      if (runtime > 120) {
        runtime /= 60;
        runtimeUnit = "h";
      }
      title =
        (this.filterResult === null ? "" : this.filterResult.matchCount.toString() + " of ") +
        this.fieldCount.toString() +
        " field" +
        (this.fieldCount === 1 ? "" : "s") +
        ", " +
        Math.floor(runtime).toString() +
        runtimeUnit +
        " runtime";
    }
    setInnerText(this.SIDEBAR_TITLE, title);
  }

  /** Watches a field row so value updates know whether it is on screen. */
  private observeRow(element: Element, key: string | null) {
    if (this.rowObserver === null) return;
    if (key !== null) this.rowKeys.set(element, key);
    this.rowObserver.observe(element);
  }

  private rowsMoved(entries: IntersectionObserverEntry[]) {
    let shown = false;
    entries.forEach((entry) => {
      const rect = entry.boundingClientRect;
      const onScreen = entry.isIntersecting && rect.width > 0 && rect.height > 0;
      this.rowOnScreen.set(entry.target, onScreen);
      const key = this.rowKeys.get(entry.target);
      if (key === undefined) return;
      if (onScreen) {
        this.onScreenFields.add(key);
        shown = true;
      } else {
        this.onScreenFields.delete(key);
      }
    });
    if (shown) invalidateFrames(); // Fill in rows that scrolled or expanded into view
  }

  /** Whether a field row is on screen. A row the observer has not reported yet is measured. */
  private isRowOnScreen(element: Element): boolean {
    const known = this.rowOnScreen.get(element);
    if (known !== undefined) return known;
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0 && rect.top >= -rect.height && rect.top <= window.innerHeight;
  }

  /**
   * Keys of the field rows on screen, which show live values and freshness, or null when rows are
   * not observed and any field may be on screen.
   */
  getOnScreenFields(): ReadonlySet<string> | null {
    return this.rowObserver === null ? null : this.onScreenFields;
  }

  /** Updates the values displayed next to next field. */
  private updateValues() {
    let time: number | null = null;
    let selectionMode = window.selection.getMode();
    let hoveredTime = window.selection.getHoveredTime();
    let selectedTime = window.selection.getSelectedTime();
    if (selectionMode === SelectionMode.Playback || selectionMode === SelectionMode.Locked) {
      time = selectedTime as number;
    } else if (hoveredTime !== null) {
      time = hoveredTime;
    } else if (selectedTime !== null) {
      time = selectedTime;
    }
    this.updateValueCallbacks.forEach((callback) => callback(time));
  }

  /** Show or hide tuning button based on tuner availability. */
  private updateTuningButton() {
    let tuningButtonVisible = !this.TUNING_BUTTON.hidden;
    let tunerAvailable = window.tuner !== null && window.tuner.hasTunableFields();
    if (tuningButtonVisible !== tunerAvailable) {
      this.TUNING_BUTTON.hidden = !tunerAvailable;
      document.documentElement.style.setProperty("--show-tuning-button", tunerAvailable ? "1" : "0");
      if (!tunerAvailable) {
        this.setTuningModeActive(false);
      }
    }
  }

  private setTuningModeActive(active: boolean) {
    this.isTuningMode = active;
    this.setTuningModeActiveCallbacks.forEach((callback) => {
      callback(active);
    });
    if (active) {
      this.TUNING_BUTTON.classList.add("active");
    } else {
      this.TUNING_BUTTON.classList.remove("active");
    }
  }

  /** The field tree as the sidebar shows it, rooted at a lone table when there is one. */
  private getDisplayTree(): { [id: string]: LogFieldTree } {
    let tree = window.log.getFieldTree();
    let rootKeys = Object.keys(tree).filter((x) => !x.startsWith("."));
    if (rootKeys.length === 1 && tree[rootKeys[0]].fullKey === null) {
      // If only one table, use it as the root
      tree = tree[rootKeys[0]].children;
    }
    // Repeat to use "DS:/Dscomm/" as the root if available
    let secondaryRootKeys = Object.keys(tree).filter((x) => !x.startsWith("."));
    if (
      secondaryRootKeys.length === 1 &&
      secondaryRootKeys[0] === "Dscomm" &&
      tree[secondaryRootKeys[0]].fullKey === null
    ) {
      tree = tree[secondaryRootKeys[0]].children;
    }
    return tree;
  }

  /** Refresh based on new log data or expanded field list. */
  refresh(forceRefresh: boolean = false) {
    const version = window.log.getFieldKeysVersion();
    const fieldKeys =
      window.log === this.fieldKeysLog && version === this.fieldKeysVersion
        ? this.lastFieldKeys
        : window.log.getFieldKeys();
    this.fieldKeysLog = window.log;
    this.fieldKeysVersion = version;
    let fieldsChanged =
      forceRefresh || (fieldKeys !== this.lastFieldKeys && !arraysEqual(fieldKeys, this.lastFieldKeys));
    this.lastFieldKeys = fieldKeys;

    if (fieldsChanged) {
      // Update field count
      this.fieldCount = window.log.getFieldCount();

      // Remove old list
      let originalScroll = this.SIDEBAR.scrollTop;
      while (this.FIELD_LIST.firstChild) {
        this.FIELD_LIST.removeChild(this.FIELD_LIST.firstChild);
      }
      this.activeFields = new Set();
      this.activeFieldCallbacks = [];
      this.updateTypeWarningCallbacks = [];
      this.updateValueCallbacks = [];
      this.selectGroupClearCallbacks = [];
      this.setTuningModeActiveCallbacks = [];
      this.tuningModePublishCallbacks = [];
      this.updateMetadataCallbacks = [];

      this.revealCallbacks = [];

      // Add new list
      this.rowObserver?.disconnect();
      this.onScreenFields.clear();
      let tree = this.getDisplayTree();
      this.filterResult = this.computeFilter(tree);
      Object.keys(tree)
        .filter((key) => !this.HIDDEN_KEYS.includes(key))
        .sort((a, b) => this.sortKeys(a, b, true))
        .forEach((key) => {
          this.addFields(key, "/" + key, tree[key], this.FIELD_LIST, 0);
        });
      if (this.filterResult !== null && this.filterResult.matchCount === 0 && this.fieldCount > 0) {
        let empty = document.createElement("div");
        empty.classList.add("side-bar-empty");
        empty.innerText = "No matching fields";
        this.FIELD_LIST.appendChild(empty);
      }
      this.SIDEBAR.scrollTop = originalScroll;

      // Fill in values now so rebuilt rows never show blank for a frame
      this.updateValues();
    } else {
      // Update type warnings and metadata
      this.updateTypeWarningCallbacks.forEach((callback) => callback());
      this.updateMetadataCallbacks.forEach((callback) => callback());
      this.updateLoadingCallbacks.forEach((callback) => callback(window.getLoadingFields()));
    }
  }

  /** Recursively adds a set of fields. */
  private addFields(
    title: string,
    fullTitle: string,
    field: LogFieldTree,
    parentElement: HTMLElement,
    indent: number,
    generated = false
  ) {
    if (this.filterResult !== null && !this.filterResult.visible.has(fullTitle)) return;
    let hasChildren = Object.keys(field.children).length > 0;
    let childrenGenerated = generated || (field.fullKey !== null && window.log.isGeneratedParent(field.fullKey));

    // Create element
    let fieldElementContainer = document.createElement("div");
    parentElement.appendChild(fieldElementContainer);
    fieldElementContainer.classList.add("field-item-container");
    let fieldElement = document.createElement("div");
    fieldElementContainer.appendChild(fieldElement);
    fieldElement.classList.add("field-item");
    if (generated) {
      fieldElement.classList.add("generated");
    }
    let valueElement = document.createElement("div");
    fieldElementContainer.appendChild(valueElement);
    valueElement.classList.add("field-value");
    this.observeRow(fieldElement, field.fullKey);
    fieldElementContainer.style.setProperty("--value-width", "0px");
    if (this.filterResult !== null && field.fullKey !== null && this.filterResult.matches.has(fullTitle)) {
      fieldElementContainer.classList.add("filter-match");
      fieldElementContainer.dataset.key = field.fullKey;
      if (field.fullKey === this.filterCursorKey) fieldElementContainer.classList.add("filter-cursor");
    }

    // Active fields callback
    this.activeFieldCallbacks.push(() => {
      // The observer knows which rows are on screen. Only array and structured rows also count while
      // scrolled out of view, so only they measure whether their parent is expanded.
      let onScreen = this.isRowOnScreen(fieldElement);
      let isExpanded = () => onScreen || fieldElement.getBoundingClientRect().height > 0;

      if (field.fullKey !== null) {
        let isActive = false;
        let type = window.log.getType(field.fullKey);
        let structuredType = window.log.getStructuredType(field.fullKey);
        let wpilibType = window.log.getWpilibType(field.fullKey);

        // Active if expanded and array or structured
        if (
          (type === LoggableType.BooleanArray ||
            type === LoggableType.NumberArray ||
            type === LoggableType.StringArray ||
            (type !== LoggableType.Empty && structuredType !== null) ||
            (type === LoggableType.Raw && wpilibType !== null && CustomSchemas.has(wpilibType))) &&
          isExpanded()
        ) {
          isActive = true;
        }

        // Active if number, boolean, or string and on screen
        if (
          onScreen &&
          (type === LoggableType.Number || type === LoggableType.Boolean || type === LoggableType.String)
        ) {
          isActive = true;
        }

        // Apply active status
        if (isActive) {
          this.activeFields.add(field.fullKey);
        } else {
          this.activeFields.delete(field.fullKey);
        }
      }

      // Add type subkey if available
      if (TYPE_KEY in field.children && field.children[TYPE_KEY].fullKey !== null) {
        let typeKey = field.children[TYPE_KEY].fullKey;
        if (isExpanded()) {
          this.activeFields.add(typeKey);
        } else {
          this.activeFields.delete(typeKey);
        }
      }
    });

    // Add icons
    let closedIcon = this.ICON_TEMPLATES.children[0].cloneNode(true) as HTMLElement;
    let openIcon = this.ICON_TEMPLATES.children[1].cloneNode(true) as HTMLElement;
    let neutralIcon = this.ICON_TEMPLATES.children[2].cloneNode(true) as HTMLElement;
    fieldElement.append(closedIcon, openIcon, neutralIcon);
    closedIcon.style.display = hasChildren ? "initial" : "none";
    openIcon.style.display = "none";
    neutralIcon.style.display = hasChildren ? "none" : "initial";

    // Create label
    let label = document.createElement("div");
    fieldElement.appendChild(label);
    label.classList.add("field-item-label");
    if (
      (indent === 0 ||
        (indent === this.INDENT_SIZE_PX &&
          (fullTitle.startsWith("/AdvantageKit") || fullTitle.startsWith("/" + this.MERGED_KEY)))) &&
      (this.KNOWN_KEYS.includes(title) || title.startsWith(this.MERGED_KEY))
    ) {
      label.classList.add("known");
    }
    {
      let labelSpan = document.createElement("span");
      label.appendChild(labelSpan);
      labelSpan.innerText = title;
    }
    if (field.fullKey !== null) {
      label.classList.add("full-key");
    }
    if (field.fullKey) {
      {
        let typeWarningSpan = document.createElement("span");
        label.appendChild(typeWarningSpan);
        typeWarningSpan.innerHTML = " &#x26A0;";
        typeWarningSpan.style.cursor = "help";
        const warningText =
          "Values with conflicting types have been written to this field. Only values compatible with the initial type can be viewed and exported.";
        typeWarningSpan.addEventListener("click", () => {
          window.sendMainMessage("alert", {
            title: "Conflicting types",
            content: warningText
          });
        });
        typeWarningSpan.title = warningText;
        let lastHidden = false;
        let updateTypeWarning = () => {
          let hidden = !window.log.getTypeWarning(field.fullKey!);
          if (hidden !== lastHidden) {
            lastHidden = hidden;
            typeWarningSpan.hidden = hidden;
          }
        };
        this.updateTypeWarningCallbacks.push(updateTypeWarning);
        updateTypeWarning();
      }
      {
        // Live freshness dot (online/stale/offline) and unsynchronised clock flag (mur-voir)
        let freshnessDot = document.createElement("div");
        fieldElement.appendChild(freshnessDot);
        freshnessDot.classList.add("field-item-freshness");
        freshnessDot.hidden = true;
        let unsyncSpan = document.createElement("span");
        label.appendChild(unsyncSpan);
        unsyncSpan.classList.add("field-item-unsync");
        unsyncSpan.innerHTML = " &#x26A0;";
        unsyncSpan.title =
          "Unsynchronised clock: this source's timestamps are not synchronised, so receive time is shown instead (approximate alignment only).";
        unsyncSpan.hidden = true;
        let lastFreshness: string | null = null;
        let lastUnsync = false;
        // Built on hover: the sample age changes every frame, and nobody reads it until then
        freshnessDot.addEventListener("pointerenter", () => {
          const age = window.liveStatus?.getFieldAge(field.fullKey!);
          freshnessDot.title = `${lastFreshness ?? "unknown"} · ${
            age === null || age === undefined ? "No sample received" : `sample age ${age.toFixed(1)} s`
          }`;
        });
        this.updateValueCallbacks.push(() => {
          if (!this.isRowOnScreen(fieldElement)) return;
          let freshness = window.liveStatus?.getFieldFreshness(field.fullKey!) ?? null;
          if (freshness !== lastFreshness) {
            lastFreshness = freshness;
            freshnessDot.hidden = freshness === null;
            freshnessDot.className = "field-item-freshness" + (freshness === null ? "" : " " + freshness);
            freshnessDot.innerText =
              freshness === "online" ? "●" : freshness === "stale" ? "◇" : freshness === "offline" ? "⊘" : "?";
          }
          let unsync = window.liveStatus?.isFieldUnsynchronised(field.fullKey!) ?? false;
          if (unsync !== lastUnsync) {
            lastUnsync = unsync;
            unsyncSpan.hidden = !unsync;
          }
        });
      }
      let structuredType = window.log.getStructuredType(field.fullKey);
      if (structuredType !== null) {
        let typeLabel = document.createElement("span");
        typeLabel.classList.add("field-item-type-label");
        label.appendChild(typeLabel);
        typeLabel.innerHTML = " &ndash; " + htmlEncode(structuredType);
      }
    } else {
      if (title.startsWith(this.MERGED_KEY) && indent === 0) {
        let mergeIndex = Number(title.slice(this.MERGED_KEY.length));
        let mergedFilenames = this.getFilenames();
        if (mergeIndex < mergedFilenames.length) {
          let filename = mergedFilenames[mergeIndex];

          let typeLabel = document.createElement("span");
          typeLabel.classList.add("field-item-type-label");
          label.appendChild(typeLabel);
          typeLabel.innerHTML = " &ndash; " + htmlEncode(filename);
        }
      }
    }

    // Right-click context menu for copying field paths
    let mouseDownInfo: [number, number, number, number] | null = null;
    label.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      mouseDownInfo = null;
      window.sendMainMessage("ask-open-sidebar-context-menu", {
        title: title,
        fullTitle: fullTitle,
        position: [event.clientX, event.clientY]
      });
    });

    // Full key fields
    if (field.fullKey !== null) {
      // Dragging support
      {
        let dragEvent = (x: number, y: number, offsetX: number, offsetY: number) => {
          let isGroup = this.selectGroup.includes(field.fullKey !== null ? field.fullKey : "");
          while (this.DRAG_ITEM.firstChild) {
            this.DRAG_ITEM.removeChild(this.DRAG_ITEM.firstChild);
          }

          let text = document.createElement("span");
          text.classList.add("field-text");
          this.DRAG_ITEM.appendChild(text);
          text.innerText = title + (isGroup ? "\u2026" : "");
          text.style.fontWeight = isGroup ? "bolder" : "initial";

          window.startDrag(x, y, offsetX, offsetY, {
            fields: isGroup ? this.selectGroup : [field.fullKey],
            children: isGroup
              ? []
              : Object.values(field.children)
                  .map((x) => x.fullKey)
                  .filter((x) => x !== null && !x.endsWith("/length"))
          });
          if (isGroup) {
            this.selectGroup = [];
            this.selectGroupClearCallbacks.forEach((callback) => callback());
          }
        };
        let mouseMove = (event: MouseEvent) => {
          if (mouseDownInfo !== null) {
            if (
              Math.abs(event.clientX - mouseDownInfo[0]) >= this.FIELD_DRAG_THRESHOLD_PX ||
              Math.abs(event.clientY - mouseDownInfo[1]) >= this.FIELD_DRAG_THRESHOLD_PX
            ) {
              dragEvent(mouseDownInfo[0], mouseDownInfo[1], mouseDownInfo[2], mouseDownInfo[3]);
              mouseDownInfo = null;
            }
          }
        };
        label.addEventListener("mousedown", (event) => {
          mouseDownInfo = [event.clientX, event.clientY, event.offsetX, event.offsetY];
          this.fieldMouseMove = mouseMove;
        });
        label.addEventListener("mouseup", (event) => {
          if (mouseDownInfo !== null) {
            if (
              (event.ctrlKey || event.metaKey) &&
              Math.abs(event.clientX - mouseDownInfo[0]) < this.FIELD_DRAG_THRESHOLD_PX &&
              Math.abs(event.clientY - mouseDownInfo[1]) < this.FIELD_DRAG_THRESHOLD_PX
            ) {
              let index = this.selectGroup.indexOf(field.fullKey !== null ? field.fullKey : "");
              if (index === -1) {
                this.selectGroup.push(field.fullKey !== null ? field.fullKey : "");
                label.style.fontWeight = "bolder";
              } else {
                this.selectGroup.splice(index, 1);
                label.style.fontWeight = "initial";
              }
            }
            mouseDownInfo = null;
          }
        });
        label.addEventListener("touchstart", (event) => {
          let touch = event.targetTouches[0];
          dragEvent(
            touch.clientX,
            touch.clientY,
            touch.clientX - label.getBoundingClientRect().x,
            touch.clientY - label.getBoundingClientRect().y
          );
        });
      }

      // Select update callback
      this.selectGroupClearCallbacks.push(() => {
        label.style.fontWeight = "initial";
      });

      // Reveal callback
      let highlightForReveal = () => {
        if (this.revealKey !== null && field.fullKey === this.revealKey) {
          // @ts-expect-error
          fieldElement.scrollIntoViewIfNeeded(); // Available in Chromium but not standard
          fieldElementContainer.classList.add("highlight");
          setTimeout(() => fieldElementContainer.classList.remove("highlight"), 3000);
        }
      };
      this.revealCallbacks.push(highlightForReveal);
      highlightForReveal(); // Try immediately in case this field was generating while expanding to reveal it

      // Update value callback
      let type = window.log.getType(field.fullKey);
      let numValueInput: HTMLInputElement | null = null;
      let numValueSpan: HTMLElement | null = null;
      if (type === LoggableType.Boolean) {
        let svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        valueElement.appendChild(svg);
        svg.setAttributeNS(null, "width", "9");
        svg.setAttributeNS(null, "height", "9");
        let circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        svg.appendChild(circle);
        circle.setAttributeNS(null, "cx", "4.5");
        circle.setAttributeNS(null, "cy", "4.5");
        circle.setAttributeNS(null, "r", "4.5");
        let line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        svg.appendChild(line);
        line.setAttributeNS(null, "x1", "0");
        line.setAttributeNS(null, "y1", "0");
        line.setAttributeNS(null, "x2", "9");
        line.setAttributeNS(null, "y2", "9");
        line.setAttributeNS(null, "stroke-width", "2");
        line.setAttributeNS(null, "stroke", "white");
        line.setAttributeNS(null, "clip-path", "url(#booleanCircleClip)");

        const booleanText = document.createElement("span");
        valueElement.appendChild(booleanText);
        // Update values periodically
        let firstUpdate = true;
        let lastValue: boolean | null = null;
        let lastHidden: boolean | null = null;
        this.updateValueCallbacks.push((time) => {
          if (!this.isRowOnScreen(fieldElement)) return;

          let value: boolean | null =
            time === null ? null : getOrDefault(window.log, field.fullKey!, LoggableType.Boolean, time, null);
          if (!firstUpdate && value === lastValue) return;
          firstUpdate = false;
          lastValue = value;

          if (value !== null) {
            const darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
            circle.setAttributeNS(null, "fill", value ? (darkMode ? "lightgreen" : "green") : "red");
            line.style.display = value ? "none" : "initial";
          }
          booleanText.textContent = formatChannelValue(value, window.log.getChannelProfile(field.fullKey!));
          valueElement.title = rawChannelValue(value, window.log.getChannelProfile(field.fullKey!));
          svg.style.display = value === null ? "none" : "";
          let hidden = false;
          valueElement.hidden = hidden;
          if (hidden !== lastHidden) {
            lastHidden = hidden;
            let valueWidth = valueElement.clientWidth === 0 ? 0 : valueElement.clientWidth + this.VALUE_WIDTH_MARGIN_PX;
            fieldElementContainer.style.setProperty("--value-width", valueWidth.toString() + "px");
          }
        });

        // Tuning mode controls
        svg.addEventListener("click", () => {
          if (!svg.classList.contains("tunable")) return;
          let oldValue = circle.getAttributeNS(null, "fill") !== "red";
          let value = !oldValue;
          let liveTime = window.selection.getCurrentLiveTime();
          if (liveTime !== null) {
            this.tuningValueCache[field.fullKey!] = value.toString();
            window.tuner?.publish(field.fullKey!, value);
            window.log.putBoolean(field.fullKey!, liveTime, value);
          }
        });
        let setTuningModeActive = (active: boolean) => {
          active = active && window.tuner !== null && window.tuner.isTunable(field.fullKey!);
          if (active) {
            svg.classList.add("tunable");
          } else {
            svg.classList.remove("tunable");
            delete this.tuningValueCache[field.fullKey!];
          }
        };
        this.setTuningModeActiveCallbacks.push(setTuningModeActive);
        setTuningModeActive(this.isTuningMode);
      } else if (type === LoggableType.Number) {
        // Create wrapper elements
        numValueInput = document.createElement("input");
        numValueInput.hidden = true;
        numValueInput.type = "number";
        numValueInput.title = "Set value";
        valueElement.appendChild(numValueInput);
        numValueSpan = document.createElement("span");
        valueElement.appendChild(numValueSpan);

        // Add callback
        let firstUpdate = true;
        let lastValue: number | null = null;
        let lastCharCount: number | null = null;
        this.updateValueCallbacks.push((time) => {
          if (!this.isRowOnScreen(fieldElement)) return;

          let value: number | null =
            time === null ? null : getOrDefault(window.log, field.fullKey!, LoggableType.Number, time, null);
          if (!firstUpdate && value === lastValue) return;
          firstUpdate = false;
          lastValue = value;

          const profile = window.log.getChannelProfile(field.fullKey!);
          let valueStr = formatChannelValue(value, profile);
          valueElement.title = rawChannelValue(value, profile);
          numValueInput!.placeholder = valueStr;
          numValueSpan!.innerText = valueStr;
          let charCount = valueStr.length;
          if (charCount !== lastCharCount) {
            lastCharCount = charCount;
            let valueWidth = valueElement.clientWidth === 0 ? 0 : valueElement.clientWidth + this.VALUE_WIDTH_MARGIN_PX;
            fieldElementContainer.style.setProperty("--value-width", valueWidth.toString() + "px");
          }
        });
      } else if (type === LoggableType.String) {
        let firstUpdate = true;
        let lastValue: string | null = null;
        let lastCharCount: number | null = null;
        let lastSidebarWidth = 0;
        this.updateValueCallbacks.push((time) => {
          if (!this.isRowOnScreen(fieldElement)) return;

          let value: string | null =
            time === null ? null : getOrDefault(window.log, field.fullKey!, LoggableType.String, time, null);
          if (!firstUpdate && value === lastValue && this.sidebarWidth === lastSidebarWidth) return;
          firstUpdate = false;
          lastValue = value;
          lastSidebarWidth = this.sidebarWidth;

          let valueStr = "";
          if (value !== null) {
            const maxCharacters = Math.round(this.sidebarWidth * 0.03);
            if (value.length > maxCharacters) {
              valueStr = value.substring(0, maxCharacters - 1) + "\u2026";
            } else {
              valueStr = value;
            }
          } else {
            valueStr = "—";
          }
          valueElement.title = rawChannelValue(value, window.log.getChannelProfile(field.fullKey!));
          valueElement.innerText = valueStr;
          let charCount = valueStr.length;
          if (charCount !== lastCharCount) {
            lastCharCount = charCount;
            let valueWidth = valueElement.clientWidth === 0 ? 0 : valueElement.clientWidth + this.VALUE_WIDTH_MARGIN_PX;
            fieldElementContainer.style.setProperty("--value-width", valueWidth.toString() + "px");
          }
        });
      }

      // Tuning mode callbacks for number
      if (type === LoggableType.Number) {
        // Enable & disable tuning mode
        let setTuningModeActive = (active: boolean) => {
          active = active && window.tuner !== null && window.tuner.isTunable(field.fullKey!);
          numValueInput!.hidden = !active;
          numValueSpan!.hidden = active;
          if (!active) {
            delete this.tuningValueCache[field.fullKey!];
          }
          let valueWidth = valueElement.clientWidth === 0 ? 0 : valueElement.clientWidth + this.VALUE_WIDTH_MARGIN_PX;
          fieldElementContainer.style.setProperty("--value-width", valueWidth.toString() + "px");
        };
        this.setTuningModeActiveCallbacks.push(setTuningModeActive);
        setTuningModeActive(this.isTuningMode);

        // Manage focus
        let isFocused = false;
        numValueInput?.addEventListener("focus", () => (isFocused = true));
        numValueInput?.addEventListener("blur", () => (isFocused = false));
        numValueInput?.addEventListener("keydown", (event) => {
          if (event.key === "Enter") numValueInput?.blur();
        });

        // Publish & unpublish value
        let lastHasValue = false;
        this.tuningModePublishCallbacks.push(() => {
          if (!this.isTuningMode || isFocused) return;
          let value = Number(numValueInput!.value);
          let hasValue = numValueInput!.value.length > 0 && !isNaN(value) && isFinite(value);
          if (hasValue) {
            this.tuningValueCache[field.fullKey!] = numValueInput!.value;
            let liveTime = window.selection.getCurrentLiveTime();
            if (liveTime !== null) {
              window.tuner?.publish(field.fullKey!, value);
              window.log.putNumber(field.fullKey!, liveTime, value);
            }
          } else if (lastHasValue) {
            delete this.tuningValueCache[field.fullKey!];
            window.tuner?.unpublish(field.fullKey!);
          }
          lastHasValue = hasValue;
        });

        // Set initial value from cache
        if (field.fullKey in this.tuningValueCache) {
          numValueInput!.value = this.tuningValueCache[field.fullKey];
        }
      }

      // Metadata callback
      let lastMetadata: string | null = null;
      let updateMetadata = () => {
        let metadata = window.log.getMetadataString(field.fullKey!);
        if (metadata === lastMetadata) return;
        lastMetadata = metadata;
        try {
          let metadataParsed = JSON.parse(metadata);
          label.title = Object.keys(metadataParsed)
            .sort()
            .map((key) => key + ": " + metadataParsed[key])
            .join("\n");
        } catch {
          label.title = metadata;
        }
      };
      this.updateMetadataCallbacks.push(updateMetadata);
      updateMetadata();

      // Loading callback
      let lastLoading = false;
      let updateLoading = (loadingFields: Set<string>) => {
        let isLoading = loadingFields.has(field.fullKey!);
        if (isLoading && !lastLoading) {
          label.classList.add("loading");
        } else if (!isLoading && lastLoading) {
          label.classList.remove("loading");
        }
        lastLoading = isLoading;
      };
      this.updateLoadingCallbacks.push(updateLoading);
      updateLoading(window.getLoadingFields());
    }

    // Add children
    if (hasChildren) {
      let childSpan = document.createElement("span");
      parentElement.appendChild(childSpan);
      childSpan.style.setProperty("--indent", (indent + this.INDENT_SIZE_PX).toString() + "px");
      childSpan.hidden = true;

      let firstExpand = true;
      let currentlyExpanded = false;
      let setExpanded = (expanded: boolean) => {
        currentlyExpanded = expanded;

        // Update icon and span display
        childSpan.hidden = !expanded;
        closedIcon.style.display = expanded ? "none" : "initial";
        openIcon.style.display = expanded ? "initial" : "none";
        // While filtering, leave the saved expand state alone so clearing the filter restores it
        if (this.filterResult === null) {
          if (expanded) {
            this.expandedFields.add(fullTitle);
          } else {
            this.expandedFields.delete(fullTitle);
          }
        }

        // Add children if first time
        if (firstExpand) {
          firstExpand = false;
          let childKeys = Object.keys(field.children).filter((key) => !this.HIDDEN_KEYS.includes(key));
          if (fullTitle === "/AdvantageKit" || fullTitle === "/NT" || fullTitle.startsWith("/" + this.MERGED_KEY)) {
            // Apply known keys sorting
            childKeys = childKeys.sort((a, b) => this.sortKeys(a, b, true));
          } else {
            childKeys = childKeys.sort((a, b) => this.sortKeys(a, b));
          }
          childKeys.forEach((key) => {
            this.addFields(
              key,
              fullTitle + "/" + key,
              field.children[key],
              childSpan,
              indent + this.INDENT_SIZE_PX,
              childrenGenerated
            );
          });
        }
      };

      // Reveal callback
      let expandForReveal = () => {
        if (this.revealKey === null) return;
        let foundSearchKey = false;
        let searchTree = (tree: LogFieldTree) => {
          if (tree.fullKey === this.revealKey) {
            foundSearchKey = true;
          } else {
            Object.values(tree.children).forEach((tree) => searchTree(tree));
          }
        };
        Object.values(field.children).forEach((tree) => searchTree(tree));
        if (foundSearchKey && !currentlyExpanded) {
          setExpanded(true);
        }
      };
      this.revealCallbacks.push(expandForReveal);
      expandForReveal(); // Try immediately in case this field was generating while expanding to reveal it

      // User controls
      let toggle = (expanded: boolean) => {
        // Changes made while filtering last until the filter changes and never reach the layout
        if (this.filterResult !== null) this.filterExpanded.set(fullTitle, expanded);
        setExpanded(expanded);
      };
      closedIcon.addEventListener("click", () => toggle(true));
      openIcon.addEventListener("click", () => toggle(false));
      if (this.filterResult !== null) {
        if (this.filterExpanded.get(fullTitle) ?? this.filterResult.expand.has(fullTitle)) setExpanded(true);
      } else if (this.expandedFields.has(fullTitle)) {
        setExpanded(true);
      }
    }
  }

  /** Soring function that uses the known keys (optionally) and correctly interprets numbers within strings. */
  private sortKeys(a: string, b: string, useKnown: boolean = false): number {
    // Check for known keys
    if (useKnown) {
      let isMerged = (key: string) => key.startsWith(this.MERGED_KEY);
      if (isMerged(a) && !isMerged(b)) return 1;
      if (!isMerged(a) && isMerged(b)) return -1;

      let isKnown = (key: string) => this.KNOWN_KEYS.includes(key);
      if (isKnown(a) && !isKnown(b)) return 1;
      if (!isKnown(a) && isKnown(b)) return -1;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  }

  /** Returns the set of field keys that are currently visible. */
  getActiveFields(): Set<string> {
    if (this.sidebarWidth > 0) {
      this.activeFieldCallbacks.forEach((callback) => callback());
      return this.activeFields;
    } else {
      return new Set();
    }
  }
}
