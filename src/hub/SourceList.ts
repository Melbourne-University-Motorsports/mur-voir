// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import ButtonRect from "../shared/ButtonRect";
import { ensureThemeContrast } from "../shared/Colors";
import {
  SourceListConfig,
  SourceListItemState,
  SourceListOptionValueConfig,
  SourceListState,
  SourceListTypeConfig,
  SourceListTypeMemoryEntry
} from "../shared/SourceListConfig";
import { formatChannelValue, rawChannelValue } from "../shared/display/ChannelProfile";
import {
  grabModuleVelocities,
  grabPosesAuto,
  grabRobotVelocities,
  rotation3dTo2d,
  rotation3dToRPY
} from "../shared/geometry";
import { getMechanismState } from "../shared/log/LogMechanismState";
import { getLogValueText, getOrDefault } from "../shared/log/LogUtil";
import LoggableType from "../shared/log/LoggableType";
import { Units } from "../shared/units";
import { createUUID, jsonCopy } from "../shared/util";
import { isTextFrame, requestFrame } from "./FrameScheduler";

export default class SourceList {
  private events = new AbortController();
  private DRAG_THRESHOLD_PX = 5;

  static typePromptCallbacks: { [key: string]: (state: SourceListItemState) => void } = {};
  static clearPromptCallbacks: { [key: string]: () => void } = {};

  // One animation-frame loop serves every source list. Lists on hidden tabs cost nothing per frame:
  // visibility comes from an IntersectionObserver, so no list forces a layout to check it.
  private static instances = new Set<SourceList>();
  private static visibleRoots = new WeakSet<Element>();
  private static observer: IntersectionObserver | null = null;
  private static frameRequested = false;
  private static darkQuery: MediaQueryList | null = null;

  private static register(list: SourceList) {
    if (typeof IntersectionObserver === "undefined") {
      // No observer (tests): treat every list as visible
      SourceList.instances.add(list);
      SourceList.visibleRoots.add(list.ROOT);
      SourceList.schedule();
      return;
    }
    if (SourceList.observer === null) {
      SourceList.observer = new IntersectionObserver((entries) => {
        let anyVisible = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            SourceList.visibleRoots.add(entry.target);
            anyVisible = true;
          } else {
            SourceList.visibleRoots.delete(entry.target);
          }
        }
        if (anyVisible) SourceList.schedule();
      });
      // Icon colors depend on the theme
      SourceList.darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      SourceList.darkQuery.addEventListener("change", () =>
        SourceList.instances.forEach((instance) => instance.updateAllItems())
      );
    }
    SourceList.instances.add(list);
    SourceList.observer.observe(list.ROOT);
  }

  private static unregister(list: SourceList) {
    SourceList.instances.delete(list);
    SourceList.observer?.unobserve(list.ROOT);
    SourceList.visibleRoots.delete(list.ROOT);
  }

  private static schedule() {
    if (SourceList.frameRequested) return;
    SourceList.frameRequested = true;
    requestFrame(SourceList.periodic);
  }

  private static lastPreviews = -Infinity;

  private static periodic = () => {
    SourceList.frameRequested = false;
    const updatePreviews = isTextFrame(SourceList.lastPreviews);
    if (updatePreviews) SourceList.lastPreviews = performance.now();
    let anyVisible = false;
    for (const instance of SourceList.instances) {
      if (!SourceList.visibleRoots.has(instance.ROOT)) continue;
      anyVisible = true;
      if (updatePreviews) instance.updateAllPreviews();
    }
    // With every list hidden the loop stops; the observer restarts it when one appears
    if (anyVisible) SourceList.schedule();
  };

  private UUID = createUUID();
  private ITEM_TEMPLATE = document.getElementById("sourceListItemTemplate")?.firstElementChild as HTMLElement;
  private ROOT: HTMLElement;
  private TITLE: HTMLElement;
  private EDIT_BUTTON: HTMLButtonElement;
  private CLEAR_BUTTON: HTMLButtonElement;
  private HELP_BUTTON: HTMLButtonElement;
  private LIST: HTMLElement;
  private HAND_ICON: HTMLImageElement;
  private DRAG_HIGHLIGHT: HTMLElement;
  private DRAG_ITEM = document.getElementById("dragItem") as HTMLElement;

  /** Status text for fields hidden by the current graph mode. */
  itemStatus = new Map<string, { text: string; error: boolean; warn?: boolean; title?: string }>();
  private stopped = false;
  /** The item under the pointer. Only it gets the sample age tooltip, which changes every frame. */
  private hoveredItem: HTMLElement | null = null;
  /** The text last written to each preview, so updates skip reading innerText (which forces layout). */
  private previewTexts = new WeakMap<HTMLElement, string>();
  private config: SourceListConfig;
  private configStr: string;
  private state: SourceListState = [];
  private independentAllowedTypes: Set<string> = new Set(); // Types that are not only children
  private parentKeys: Map<string, string> = new Map(); // Map type key to parent key
  private supplementalStateSuppliers: (() => SourceListState)[];
  /** Called when the DBC fallback re-points a field at the same signal under another key. */
  onFieldRemapped?: (from: string, to: string) => void;
  getCriticalLimits?: (key: string) => { uuid: string; unit: string; limits: { low?: number; high?: number } };
  private getNumberPreview: ((key: string, time: number) => string | null) | undefined;
  private mouseDownInfo: [number, number] | null = null;

  private dbcLookup?: {
    log: typeof window.log;
    fieldsVersion: number;
    metadataVersion: number;
    keys: Map<string, string[]>;
  };
  private refreshLastFields: Set<string> = new Set();
  private refreshLastStructTypes: { [key: string]: string | null } = {};

  /**
   * Creates a new source list controller
   *
   * @param root The top-level HTML element of the source list
   * @param config The configuration used for controlling the source list
   * @param supplementalStateSuppliers Suppliers of additional states from other source lists, used when running auto advance logic
   */
  constructor(
    root: HTMLElement,
    config: SourceListConfig,
    supplementalStateSuppliers: (() => SourceListState)[],
    editButtonCallback?: (rect: ButtonRect) => void,
    getNumberPreview?: (key: string, time: number) => string | null
  ) {
    this.config = jsonCopy(config);
    this.configStr = JSON.stringify(config);
    this.supplementalStateSuppliers = supplementalStateSuppliers;
    this.getNumberPreview = getNumberPreview;
    this.ROOT = root;
    this.ROOT.classList.add("source-list");

    this.TITLE = document.createElement("div");
    this.ROOT.appendChild(this.TITLE);
    this.TITLE.classList.add("title");
    this.TITLE.innerText = config.title;
    this.TITLE.style.left = editButtonCallback === undefined ? "55px" : "30px";
    this.TITLE.style.right = editButtonCallback === undefined ? "55px" : "30px";

    this.EDIT_BUTTON = document.createElement("button");
    this.ROOT.appendChild(this.EDIT_BUTTON);
    this.EDIT_BUTTON.classList.add("edit");
    this.EDIT_BUTTON.title = "Edit settings";
    let editIcon = document.createElement("img");
    this.EDIT_BUTTON.appendChild(editIcon);
    editIcon.src = "symbols/morehoriz.svg";
    this.EDIT_BUTTON.hidden = editButtonCallback === undefined;

    this.CLEAR_BUTTON = document.createElement("button");
    this.ROOT.appendChild(this.CLEAR_BUTTON);
    this.CLEAR_BUTTON.classList.add("clear");
    this.CLEAR_BUTTON.title = "Clear all fields";
    let clearButton = document.createElement("img");
    this.CLEAR_BUTTON.appendChild(clearButton);
    clearButton.src = "symbols/delete.svg";
    this.CLEAR_BUTTON.hidden = editButtonCallback !== undefined;

    this.HELP_BUTTON = document.createElement("button");
    this.ROOT.appendChild(this.HELP_BUTTON);
    this.HELP_BUTTON.classList.add("help");
    this.HELP_BUTTON.title = "Help";
    let helpIcon = document.createElement("img");
    this.HELP_BUTTON.appendChild(helpIcon);
    helpIcon.src = "symbols/help.svg";
    this.HELP_BUTTON.hidden = editButtonCallback !== undefined;

    this.LIST = document.createElement("div");
    this.ROOT.appendChild(this.LIST);
    this.LIST.classList.add("list");

    this.HAND_ICON = document.createElement("img");
    this.ROOT.appendChild(this.HAND_ICON);
    this.HAND_ICON.classList.add("hand-icon");
    this.HAND_ICON.src = "symbols/trackpadinput.svg";
    this.updateHandIcon();

    this.DRAG_HIGHLIGHT = document.createElement("div");
    this.ROOT.appendChild(this.DRAG_HIGHLIGHT);
    this.DRAG_HIGHLIGHT.classList.add("drag-highlight");
    this.DRAG_HIGHLIGHT.hidden = true;

    // Summarize config
    this.config.types.forEach((typeConfig) => {
      if (typeConfig.childOf === undefined) {
        typeConfig.sourceTypes.forEach((source) => {
          this.independentAllowedTypes.add(source);
        });
      }
      if (typeConfig.parentKey !== undefined) {
        this.parentKeys.set(typeConfig.key, typeConfig.parentKey);
      }
    });

    // Edit button
    this.EDIT_BUTTON.addEventListener(
      "click",
      () => {
        let rect = this.EDIT_BUTTON.getBoundingClientRect();
        if (editButtonCallback !== undefined) {
          editButtonCallback({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          });
        }
      },
      { signal: this.events.signal }
    );
    this.CLEAR_BUTTON.addEventListener(
      "click",
      () => {
        let rect = this.CLEAR_BUTTON.getBoundingClientRect();
        window.sendMainMessage("source-list-clear-prompt", {
          uuid: this.UUID,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        });
        SourceList.clearPromptCallbacks[this.UUID] = () => {
          delete SourceList.clearPromptCallbacks[this.UUID];
          this.clear();
        };
      },
      { signal: this.events.signal }
    );
    this.HELP_BUTTON.addEventListener(
      "click",
      () => {
        window.sendMainMessage("source-list-help", this.config);
      },
      { signal: this.events.signal }
    );

    // Incoming drag handling
    window.addEventListener(
      "drag-update",
      (event) => {
        let dragData = (event as CustomEvent).detail;
        if ("sourceListUUID" in dragData.data) {
          this.handleItemDrag(dragData);
        } else if ("fields" in dragData.data) {
          this.handleFieldDrag(dragData);
        }
      },
      { signal: this.events.signal }
    );

    // Track the hovered item so its tooltip is filled in right away
    this.LIST.addEventListener(
      "pointerover",
      (event) => {
        let element = event.target as HTMLElement | null;
        while (element !== null && element.parentElement !== this.LIST) element = element.parentElement;
        if (element === this.hoveredItem) return;
        this.hoveredItem = element;
        if (element === null) return;
        const index = Array.prototype.indexOf.call(this.LIST.children, element);
        if (index >= 0 && index < this.state.length) this.updatePreview(element, this.state[index]);
      },
      { signal: this.events.signal }
    );
    this.LIST.addEventListener(
      "pointerleave",
      () => {
        this.hoveredItem = null;
      },
      { signal: this.events.signal }
    );

    // Entry dragging support
    this.LIST.addEventListener(
      "mousedown",
      (event) => {
        this.mouseDownInfo = [event.clientX, event.clientY];
      },
      { signal: this.events.signal }
    );
    this.LIST.addEventListener(
      "mouseup",
      () => {
        this.mouseDownInfo = null;
      },
      { signal: this.events.signal }
    );
    this.LIST.addEventListener(
      "mousemove",
      (event) => {
        // Start drag
        if (
          this.mouseDownInfo !== null &&
          (Math.abs(event.clientX - this.mouseDownInfo[0]) >= this.DRAG_THRESHOLD_PX ||
            Math.abs(event.clientY - this.mouseDownInfo[1]) >= this.DRAG_THRESHOLD_PX)
        ) {
          // Find item
          let index = -1;
          Array.from(this.LIST.children).forEach((element, i) => {
            let rect = element.getBoundingClientRect();
            if (
              this.mouseDownInfo![0] >= rect.left &&
              this.mouseDownInfo![0] <= rect.right &&
              this.mouseDownInfo![1] >= rect.top &&
              this.mouseDownInfo![1] <= rect.bottom
            ) {
              index = i;
            }
          });
          this.mouseDownInfo = null;
          if (index === -1) return;

          // Update drag item
          while (this.DRAG_ITEM.firstChild) {
            this.DRAG_ITEM.removeChild(this.DRAG_ITEM.firstChild);
          }
          let element = this.LIST.children[index];
          let dragContainer = document.createElement("div");
          dragContainer.style.position = "absolute";
          dragContainer.style.width = element.clientWidth.toString() + "px";
          dragContainer.style.height = "30px";
          dragContainer.style.left = "0px";
          dragContainer.style.top = "0px";
          dragContainer.style.pointerEvents = "none";
          dragContainer.style.margin = "none";
          dragContainer.style.padding = "none";
          dragContainer.classList.add("source-list");
          let elementClone = element.cloneNode(true) as HTMLElement;
          dragContainer.appendChild(elementClone);
          this.DRAG_ITEM.appendChild(dragContainer);

          // Start drag
          let itemRect = element.getBoundingClientRect();
          window.startDrag(event.clientX, event.clientY, event.clientX - itemRect.left, event.clientY - itemRect.top, {
            sourceListUUID: this.UUID,
            sourceListConfigStr: this.configStr,
            sourceListIndex: index,
            sourceListIsChild: this.isChild(index),
            sourceListElement: this.LIST,
            sourceListState: this.state
          });
        }
      },
      { signal: this.events.signal }
    );

    // Value previews run from one shared loop, and only while this list is on screen
    SourceList.register(this);
  }

  setTitle(title: string): void {
    this.TITLE.innerText = title;
  }

  /**
   * Returns the set of item states displayed by the source list.
   * @param onlyDisplayedFields Whether to only include fields that should be rendered
   */
  getState(onlyDisplayedFields = false): SourceListState {
    if (onlyDisplayedFields) {
      let availableFields: boolean[] = [];
      let parentAvailable = false;
      this.state.forEach((item) => {
        let available = this.isFieldAvailable(item);
        let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === item.type);

        if (typeConfig?.parentKey !== undefined) {
          parentAvailable = available;
        }
        if (typeConfig?.childOf !== undefined && parentAvailable !== null) {
          availableFields.push(available && parentAvailable);
        } else {
          availableFields.push(available);
        }
      });
      return this.state.filter((item, index) => item.visible && availableFields[index]);
    } else {
      return this.state;
    }
  }

  setState(state: SourceListState) {
    this.clear();
    state.forEach((itemState) => {
      this.addListItem(itemState);
    });
    this.refresh();
  }

  getActiveFields(): string[] {
    return this.state.map((item) => item.logKey);
  }

  stop() {
    this.stopped = true;
    SourceList.unregister(this);
    this.events.abort();
    delete SourceList.clearPromptCallbacks[this.UUID];
    delete SourceList.typePromptCallbacks[this.UUID];
    this.supplementalStateSuppliers = [];
    this.getNumberPreview = undefined;
    this.ROOT.replaceChildren();
  }

  /** Removes all items in the source list. */
  clear() {
    this.state = [];
    while (this.LIST.firstChild) {
      this.LIST.removeChild(this.LIST.firstChild);
    }
    this.updateHandIcon();
  }

  /** Call when a new set of log fields may be available. */
  refresh() {
    if (this.dbcLookup?.log !== window.log) this.dbcLookup = undefined;
    this.state.forEach((item, index) => {
      if (this.isFieldAvailable(item) || !item.dbcSignal) return;
      if (
        this.dbcLookup?.log !== window.log ||
        this.dbcLookup.fieldsVersion !== window.log.getFieldKeysVersion() ||
        this.dbcLookup.metadataVersion !== window.log.getMetadataVersion()
      ) {
        let dbcKeys = new Map<string, string[]>();
        window.log.getFieldKeys().forEach((key) => {
          let metadata = window.log.getMetadataString(key);
          if (metadata.length === 0) return;
          try {
            let dbcSignal = JSON.parse(metadata).dbcSignal;
            if (typeof dbcSignal !== "string" || dbcSignal.length === 0) return;
            let keys = dbcKeys.get(dbcSignal) ?? [];
            keys.push(key);
            dbcKeys.set(dbcSignal, keys);
          } catch {
            // Not every field has JSON metadata.
          }
        });
        this.dbcLookup = {
          log: window.log,
          fieldsVersion: window.log.getFieldKeysVersion(),
          metadataVersion: window.log.getMetadataVersion(),
          keys: dbcKeys
        };
      }
      let candidates = this.dbcLookup.keys.get(item.dbcSignal) ?? [];
      let matches = candidates.filter((logKey) => this.isFieldAvailable({ ...item, logKey }));
      if (matches.length === 0 && candidates.length === 1) {
        let candidateType = window.log.getType(candidates[0]);
        let sourceTypes = this.config.types.find((type) => type.key === item.type)?.sourceTypes ?? [];
        if (
          ((item.logType === "Boolean" && candidateType === LoggableType.Number) ||
            (item.logType === "Number" && candidateType === LoggableType.Boolean)) &&
          sourceTypes.includes(LoggableType[candidateType])
        ) {
          matches = candidates;
          item.logType = LoggableType[candidateType];
        }
      }
      if (matches.length === 1) {
        const previousKey = item.logKey;
        item.logKey = matches[0];
        this.onFieldRemapped?.(previousKey, item.logKey);
        let element = this.LIST.children[index] as HTMLElement;
        this.updateItem(element, item);
        this.updatePreview(element, item);
      }
    });
    let displayedFields = this.state.map((item) => item.logKey);
    let currentFields = new Set(displayedFields.filter((field) => window.log.getType(field) !== null));
    let structTypes: { [key: string]: string | null } = {};
    currentFields.forEach((field) => {
      structTypes[field] = window.log.getStructuredType(field);
    });

    let shouldUpdate = false;
    currentFields.forEach((field) => {
      if (!this.refreshLastFields.has(field)) {
        // New field was added
        shouldUpdate = true;
      }
    });

    if (!shouldUpdate) {
      this.refreshLastFields.forEach((field) => {
        if (!currentFields.has(field)) {
          // Existing field was removed
          shouldUpdate = true;
        }
      });

      if (!shouldUpdate) {
        Object.entries(structTypes).forEach(([key, type]) => {
          if (this.refreshLastStructTypes[key] !== type) {
            // Struct type changed
            shouldUpdate = true;
          }
        });
      }
    }

    this.refreshLastFields = currentFields;
    this.refreshLastStructTypes = structTypes;
    if (shouldUpdate) {
      this.updateAllItems();
    }
  }

  /**
   * Updates a set of option values and validates that all items are valid.
   */
  setOptionValues(type: string, option: string, values: SourceListOptionValueConfig[]) {
    let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === type);
    if (typeConfig === undefined) return;
    let optionConfig = typeConfig!.options.find((optionConfig) => optionConfig.key === option);
    if (optionConfig === undefined) return;
    optionConfig.values = values;

    // Verify that all items have a valid selection
    let possibleValues = values.map((x) => x.key);
    this.state.forEach((item, index) => {
      if (item.type === type && !possibleValues.includes(item.options[option])) {
        item.options[option] = values[0].key;
        this.updateItem(this.LIST.children[index] as HTMLElement, item);
      }
    });
  }

  private updateHandIcon() {
    let show = this.LIST.childElementCount === 0;
    this.HAND_ICON.style.transition = show ? "opacity 1s ease-in 1s" : "";
    this.HAND_ICON.style.opacity = show ? "0.15" : "0";
  }

  /**
   * Adds a new field to the list, if the type is valid.
   *
   * @param logKey The key for the field to add
   * @param parentIndex The index of the parent item (optional)
   */
  beforeAdd?: (key: string) => boolean;
  graphLegend = false;
  hoveredKey: string | null = null;
  private lastSingleField = "";

  addField(logKey: string, parentIndex?: number) {
    if (this.beforeAdd && !this.beforeAdd(logKey)) return;
    let logType = window.log.getType(logKey);
    let logTypeString = logType === null ? null : LoggableType[logType];
    let structuredType = window.log.getStructuredType(logKey);

    // Get memory entry
    let memory: SourceListTypeMemoryEntry | null = null;
    if (
      this.config.typeMemoryId &&
      this.config.typeMemoryId in window.typeMemory &&
      logKey in window.typeMemory[this.config.typeMemoryId]
    ) {
      memory = window.typeMemory[this.config.typeMemoryId][logKey];
    }

    // Get all possible types
    let stateWithSupplemental = this.state.concat(...this.supplementalStateSuppliers.map((func) => func()));
    let possibleTypes: { typeConfig: SourceListTypeConfig; logType: string; uses: number }[] = [];
    for (let i = 0; i < this.config.types.length; i++) {
      let typeConfig = this.config.types[i];
      if (
        (parentIndex === undefined && typeConfig.childOf !== undefined) || // Not inserting as a child
        (parentIndex !== undefined && typeConfig.childOf !== this.parentKeys.get(this.state[parentIndex!].type)) // Type is not the correct parent
      ) {
        continue;
      }
      let finalType = "";
      if (structuredType !== null && typeConfig.sourceTypes.includes(structuredType)) {
        finalType = structuredType;
      } else if (logTypeString !== null && typeConfig.sourceTypes.includes(logTypeString)) {
        finalType = logTypeString;
      }
      if (finalType.length > 0) {
        possibleTypes.push({
          typeConfig: typeConfig,
          logType: finalType,
          uses: stateWithSupplemental.filter((itemState) => itemState.type === typeConfig.key).length
        });
      }
    }

    // Find best type
    if (possibleTypes.length === 0) return;
    if (this.config.autoAdvance === true) {
      // Roles holding one field take turns once they are all full.
      let types = this.config.types;
      let next = types.findIndex((type) => type.key === this.lastSingleField) + 1;
      let turn = (type: SourceListTypeConfig) => (types.indexOf(type) - next + types.length) % types.length;
      possibleTypes.sort(
        (a, b) => a.uses - b.uses || (a.typeConfig.singleField ? turn(a.typeConfig) - turn(b.typeConfig) : 0)
      );
      let leaf = logKey.split("/").at(-1)!;
      let named = possibleTypes.findIndex(
        (type) => type.typeConfig.fieldPattern && new RegExp(type.typeConfig.fieldPattern, "i").test(leaf)
      );
      if (named > 0) possibleTypes.unshift(...possibleTypes.splice(named, 1));
    }
    let memoryTypeIndex = possibleTypes.findIndex((type) => memory !== null && type.typeConfig.key === memory.type);
    if (memoryTypeIndex !== -1) {
      let memoryType = possibleTypes.splice(memoryTypeIndex, 1)[0];
      possibleTypes.splice(0, 0, memoryType);
    }
    let bestType = possibleTypes[0];
    if (bestType.typeConfig.singleField) this.lastSingleField = bestType.typeConfig.key;

    // Add to list
    let options: { [key: string]: string } = {};
    bestType.typeConfig.options.forEach((optionConfig) => {
      if (this.config.autoAdvance === optionConfig.key) {
        // Select least used value
        let useCounts: { valueConfig: SourceListOptionValueConfig; uses: number }[] = optionConfig.values.map(
          (valueConfig) => {
            return {
              valueConfig: valueConfig,
              uses: stateWithSupplemental.filter(
                (itemState) =>
                  optionConfig.key in itemState.options && itemState.options[optionConfig.key] === valueConfig.key
              ).length
            };
          }
        );
        useCounts.sort((a, b) => a.uses - b.uses);
        options[optionConfig.key] = useCounts[0].valueConfig.key;
      } else if (
        memory !== null &&
        optionConfig.key in memory.options &&
        optionConfig.values.map((valueConfig) => valueConfig.key).includes(memory.options[optionConfig.key])
      ) {
        // Select value from type memory
        options[optionConfig.key] = memory.options[optionConfig.key];
      } else {
        // Select first value
        options[optionConfig.key] = optionConfig.values[0].key;
      }
    });
    let state: SourceListItemState = {
      type: bestType.typeConfig.key,
      logKey: logKey,
      logType: bestType.logType,
      visible: true,
      options: options
    };
    try {
      let dbcSignal = JSON.parse(window.log.getMetadataString(logKey)).dbcSignal;
      if (typeof dbcSignal === "string" && dbcSignal.length > 0) state.dbcSignal = dbcSignal;
    } catch {
      // Not every field has JSON metadata.
    }
    if (parentIndex !== undefined) {
      let insertIndex = parentIndex! + 1;
      while (insertIndex < this.state.length && this.isChild(insertIndex)) {
        insertIndex++;
      }
      this.addListItem(state, insertIndex);
    } else {
      this.addListItem(state);
    }
  }

  /** Processes a item drag event, including rearranging fields if necessary. */
  private handleItemDrag(dragData: any) {
    let uuid: string = dragData.data.sourceListUUID;
    let configStr: string = dragData.data.sourceListConfigStr;
    if (configStr !== this.configStr) return;
    let startIndex: number = dragData.data.sourceListIndex;
    let childSource: boolean = dragData.data.sourceListIsChild;
    let sourceElement: HTMLElement = dragData.data.sourceListElement;
    let sourceState: SourceListState = dragData.data.sourceListState;
    let end: boolean = dragData.end;
    let x: number = dragData.x;
    let y: number = dragData.y;

    let rootRect = this.ROOT.getBoundingClientRect();
    if (x < rootRect.left || x > rootRect.right || y < rootRect.top || y > rootRect.bottom) {
      this.DRAG_HIGHLIGHT.hidden = true;
      return;
    }

    let isValidTarget = (targetIndex: number) => {
      if (childSource) {
        if (uuid !== this.UUID) return false;

        let sourceParent = startIndex - 1;
        while (sourceParent >= 0 && this.isChild(sourceParent)) {
          sourceParent--;
        }

        let targetParent = targetIndex - 1;
        while (targetParent >= 0 && this.isChild(targetParent)) {
          targetParent--;
        }

        if (sourceParent !== targetParent) return false;
      } else {
        if (targetIndex < this.LIST.childElementCount && this.isChild(targetIndex)) return false;
      }
      return true;
    };

    let closestDist = Infinity;
    let closestIndex = 0;
    Array.from(this.LIST.children).forEach((element, index) => {
      if (!isValidTarget(index)) return;
      let dist = Math.abs(y - element.getBoundingClientRect().top);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = index;
      }
    });
    let lastElement = this.LIST.lastElementChild;
    if (lastElement !== null && isValidTarget(this.LIST.childElementCount)) {
      let dist = Math.abs(y - lastElement.getBoundingClientRect().bottom);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = this.LIST.childElementCount;
      }
    }

    if (end) {
      this.DRAG_HIGHLIGHT.hidden = true;
      let endIndex = closestIndex;
      let itemCount = 0;
      let i = startIndex;
      if (childSource) {
        itemCount = 1;
      } else {
        while (true) {
          itemCount++;
          if (i + itemCount >= this.state.length || !this.isChild(i + itemCount)) break;
        }
      }

      // Rearrange items
      for (let i = 0; i < itemCount; i++) {
        let state = sourceState[startIndex];
        if (uuid !== this.UUID) {
          sourceElement.removeChild(sourceElement.children[startIndex]);
          sourceState.splice(startIndex, 1);
          this.addListItem(state, endIndex);
          endIndex++;
        } else if (endIndex < startIndex) {
          this.LIST.removeChild(this.LIST.children[startIndex]);
          this.state.splice(startIndex, 1);
          this.addListItem(state, endIndex);
          startIndex++;
          endIndex++;
        } else if (endIndex > startIndex) {
          this.LIST.removeChild(this.LIST.children[startIndex]);
          this.state.splice(startIndex, 1);
          this.addListItem(state, endIndex - 1);
        }
      }
    } else {
      this.DRAG_HIGHLIGHT.hidden = false;
      let highlightY = 0;
      if (this.LIST.childElementCount === 0) {
        highlightY = this.LIST.getBoundingClientRect().top;
      } else if (closestIndex < this.LIST.childElementCount) {
        highlightY = this.LIST.children[closestIndex].getBoundingClientRect().top;
      } else {
        highlightY = this.LIST.children[this.LIST.childElementCount - 1].getBoundingClientRect().bottom;
      }
      highlightY -= this.ROOT.getBoundingClientRect().top;
      highlightY -= 6;
      this.DRAG_HIGHLIGHT.style.left = "0%";
      this.DRAG_HIGHLIGHT.style.top = highlightY.toString() + "px";
      this.DRAG_HIGHLIGHT.style.width = "100%";
      this.DRAG_HIGHLIGHT.style.height = "12px";
    }
  }

  /** Processes a field drag event, including adding a field if necessary. */
  private handleFieldDrag(dragData: any) {
    let end = dragData.end;
    let x = dragData.x;
    let y = dragData.y;
    let draggedFields: string[];
    if (this.config.allowChildrenFromDrag) {
      draggedFields = dragData.data.fields.concat(dragData.data.children);
    } else {
      draggedFields = dragData.data.fields;
    }

    // Exit if out of range
    let listRect = this.ROOT.getBoundingClientRect();
    if (
      listRect.width === 0 ||
      listRect.height === 0 ||
      x < listRect.left ||
      x > listRect.right ||
      y < listRect.top ||
      y > listRect.bottom
    ) {
      this.DRAG_HIGHLIGHT.hidden = true;
      Array.from(this.LIST.children).forEach((element) => {
        element.classList.remove("parent-highlight");
      });
      return;
    }

    // Check pixel ranges
    let parentIndex: number | null = null;
    for (let i = 0; i < this.LIST.childElementCount; i++) {
      let itemRect = this.LIST.children[i].getBoundingClientRect();
      let withinItem = x > itemRect.left && x < itemRect.right && y > itemRect.top && y < itemRect.bottom;
      if (withinItem && this.parentKeys.has(this.state[i].type)) {
        parentIndex = i;
      }
    }

    // Check type validity
    let isTypeValid = (sourceTypes: Set<string>): boolean => {
      return draggedFields.some((field) => {
        let logType = window.log.getType(field);
        let logTypeString = logType === null ? null : LoggableType[logType];
        let structuredType = window.log.getStructuredType(field);
        return (
          (logTypeString !== null && sourceTypes.has(logTypeString)) ||
          (structuredType !== null && sourceTypes.has(structuredType))
        );
      });
    };
    let isTypeValidAsChild = (parentType: string): boolean => {
      let parentKey = this.parentKeys.get(parentType);
      if (parentKey === undefined) return false;
      let childAllowedTypes: Set<string> = new Set();
      this.config.types.forEach((typeConfig) => {
        if (typeConfig.childOf === parentKey) {
          typeConfig.sourceTypes.forEach((type) => childAllowedTypes.add(type));
        }
      });
      return isTypeValid(childAllowedTypes);
    };
    let typeValidAsRoot = isTypeValid(this.independentAllowedTypes);
    let typeValidAsChild = false;
    if (parentIndex !== null) {
      typeValidAsChild = isTypeValidAsChild(this.state[parentIndex!].type);
    }

    // Apply parent highlights
    for (let i = 0; i < this.state.length; i++) {
      if (isTypeValidAsChild(this.state[i].type)) {
        this.LIST.children[i].classList.add("parent-highlight");
      }
    }

    // Add fields and update highlight
    if (end) {
      this.DRAG_HIGHLIGHT.hidden = true;
      if (!typeValidAsChild) parentIndex = null;
      if (parentIndex !== null || typeValidAsRoot) {
        draggedFields.forEach((field) => {
          this.addField(field, parentIndex === null ? undefined : parentIndex);
        });
      }
      Array.from(this.LIST.children).forEach((element) => {
        element.classList.remove("parent-highlight");
      });
    } else if (typeValidAsChild && parentIndex !== null) {
      let top = Math.max(this.LIST.children[parentIndex!].getBoundingClientRect().top - listRect.top, 0);
      let bottom = Math.min(
        this.LIST.children[parentIndex!].getBoundingClientRect().bottom - listRect.top,
        listRect.height
      );
      this.DRAG_HIGHLIGHT.style.left = "0%";
      this.DRAG_HIGHLIGHT.style.top = top.toString() + "px";
      this.DRAG_HIGHLIGHT.style.width = "100%";
      this.DRAG_HIGHLIGHT.style.height = (bottom - top).toString() + "px";
      this.DRAG_HIGHLIGHT.hidden = false;
    } else if (typeValidAsRoot) {
      this.DRAG_HIGHLIGHT.style.left = "0%";
      this.DRAG_HIGHLIGHT.style.top = "0%";
      this.DRAG_HIGHLIGHT.style.width = "100%";
      this.DRAG_HIGHLIGHT.style.height = "100%";
      this.DRAG_HIGHLIGHT.hidden = false;
    } else {
      this.DRAG_HIGHLIGHT.hidden = true;
      Array.from(this.LIST.children).forEach((element) => {
        element.classList.remove("parent-highlight");
      });
    }
  }

  /** Update all items to match the current state. */
  private updateAllItems() {
    let count = Math.min(this.state.length, this.LIST.childElementCount);
    for (let i = 0; i < count; i++) {
      this.updateItem(this.LIST.children[i] as HTMLElement, this.state[i]);
    }
  }

  /** Update the preview values of all items. */
  private updateAllPreviews() {
    let count = Math.min(this.state.length, this.LIST.childElementCount);
    for (let i = 0; i < count; i++) {
      this.updatePreview(this.LIST.children[i] as HTMLElement, this.state[i]);
    }
  }

  /** Make a list item element and inserts it into the list. */
  private addListItem(state: SourceListItemState, insertIndex?: number) {
    if (this.config.types.find((type) => type.key === state.type)?.singleField) {
      for (let i = this.state.length - 1; i >= 0; i--) {
        if (this.state[i].type !== state.type) continue;
        this.state.splice(i, 1);
        this.LIST.children[i].remove();
        if (insertIndex !== undefined && i < insertIndex) insertIndex--;
      }
    }
    let item = this.ITEM_TEMPLATE.cloneNode(true) as HTMLElement;
    if (insertIndex === undefined) {
      this.LIST.appendChild(item);
      this.state.push(state);
    } else {
      this.LIST.insertBefore(item, this.LIST.children[insertIndex!]);
      this.state.splice(insertIndex, 0, state);
    }
    if (this.config.showInGraph) {
      item.classList.add("has-graph-toggle");
      const button = document.createElement("button");
      button.className = "show-in-graph";
      const icon = document.createElement("img");
      icon.src = "symbols/sourceList/gesture.svg";
      button.append(icon);
      button.addEventListener("mousedown", (event) => event.stopPropagation(), { signal: this.events.signal });
      button.addEventListener(
        "click",
        () => {
          const state = this.state[Array.from(this.LIST.children).indexOf(item)];
          state.options.showInGraph = state.options.showInGraph === "true" ? "false" : "true";
          this.updateItem(item, state);
        },
        { signal: this.events.signal }
      );
      item.append(button);
    }
    this.updateItem(item, state);
    this.updateHandIcon();

    // Check if child type
    let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === state.type);
    let isChild = typeConfig !== undefined && typeConfig.childOf !== undefined;

    // Type controls
    let typeButton = item.getElementsByClassName("type")[0] as HTMLButtonElement;
    typeButton.title = "Edit field configuration";
    let typeNameElement = item.getElementsByClassName("type-name")[0] as HTMLElement;
    let promptType = (rect: ButtonRect) => {
      let index = Array.from(this.LIST.children).indexOf(item);
      window.sendMainMessage("source-list-type-prompt", {
        uuid: this.UUID,
        config: this.config,
        state: this.state[index],
        rect: rect,
        criticalLimits: this.getCriticalLimits?.(this.state[index].logKey)
      });
      let originalType = this.state[index].type;
      SourceList.typePromptCallbacks[this.UUID] = (newState) => {
        delete SourceList.typePromptCallbacks[this.UUID];
        let index = Array.from(this.LIST.children).indexOf(item);
        this.state[index] = newState;
        if (this.config.types.find((type) => type.key === newState.type)?.singleField) {
          const state = this.state.filter((entry, i) => i === index || entry.type !== newState.type);
          this.setState(state);
          return;
        }
        this.updateItem(item, newState);

        if (!isChild) {
          let originalParentKey = this.config.types.find((typeConfig) => typeConfig.key === originalType)?.parentKey;
          let newParentKey = this.config.types.find((typeConfig) => typeConfig.key === newState.type)?.parentKey;
          if (originalParentKey !== newParentKey) {
            // Changed parent key, remove children
            index++;
            if (!this.isChild(index)) return;
            let childCount = 0;
            while (index + childCount < this.state.length) {
              childCount++;
              if (!this.isChild(index + childCount)) break;
            }
            this.state.splice(index, childCount);
            for (let i = 0; i < childCount; i++) {
              this.LIST.removeChild(this.LIST.children[index]);
              this.updateHandIcon();
            }
          }
        }
      };
    };
    typeButton.addEventListener(
      "click",
      () => {
        let rect = typeButton.getBoundingClientRect();
        promptType({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
      },
      { signal: this.events.signal }
    );
    item.addEventListener(
      "contextmenu",
      (event) => {
        this.mouseDownInfo = null; // Prevent dragging
        promptType({
          x: event.clientX,
          y: event.clientY,
          width: 0,
          height: 0
        });
      },
      { signal: this.events.signal }
    );

    // Hide button
    let keyContainer = item.getElementsByClassName("key-container")[0] as HTMLElement;
    let hideButton = item.getElementsByClassName("hide")[0] as HTMLButtonElement;
    let toggleHidden = () => {
      let index = Array.from(this.LIST.children).indexOf(item);
      let newVisible = !this.state[index].visible;
      this.state[index].visible = newVisible;
      this.updateItem(item, this.state[index]);
      if (!isChild) {
        // Parent toggles its children to match
        let searchIndex = index + 1;
        while (searchIndex < this.state.length) {
          if (!this.isChild(searchIndex)) break;
          this.state[searchIndex].visible = newVisible;
          this.updateItem(this.LIST.children[searchIndex] as HTMLElement, this.state[searchIndex]);
          searchIndex++;
        }
      } else if (newVisible) {
        // Making a child visible forces the parent to be visible
        let parentIndex = index - 1;

        // Traverse upwards until we find the non-child item (the parent)
        while (parentIndex >= 0 && this.isChild(parentIndex)) {
          parentIndex--;
        }

        // If the parent exists and is currently hidden, make it visible
        if (parentIndex >= 0 && !this.state[parentIndex].visible) {
          this.state[parentIndex].visible = true;
          this.updateItem(this.LIST.children[parentIndex] as HTMLElement, this.state[parentIndex]);
        }
      }
    };
    hideButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        toggleHidden();
      },
      { signal: this.events.signal }
    );
    let lastClick = 0;
    [typeNameElement, keyContainer].forEach((element) =>
      element.addEventListener(
        "click",
        () => {
          let now = new Date().getTime();
          if (now - lastClick < 400) {
            toggleHidden();
            lastClick = 0;
          } else {
            lastClick = now;
          }
        },
        { signal: this.events.signal }
      )
    );

    // Child formatting
    if (isChild) {
      item.classList.add("child");
    }

    // Remove button
    let removeButton = item.getElementsByClassName("remove")[0] as HTMLButtonElement;
    removeButton.title = "Remove field";
    let removeIcon = removeButton.firstElementChild as HTMLElement;
    removeButton.addEventListener(
      "click",
      () => {
        let index = Array.from(this.LIST.children).indexOf(item);
        let removeCount = 0;
        while (index + removeCount < this.state.length) {
          removeCount++;
          if (isChild || !this.isChild(index + removeCount)) break;
        }
        this.state.splice(index, removeCount);
        for (let i = 0; i < removeCount; i++) {
          this.LIST.removeChild(this.LIST.children[index]);
        }
        this.updateHandIcon();
      },
      { signal: this.events.signal }
    );
    return item;
  }

  /**
   * Updates a list item to match the item state.
   *
   * @param item The HTML element to update
   * @param state The desired display state
   */
  private updateItem(item: HTMLElement, state: SourceListItemState) {
    let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === state.type);
    if (typeConfig === undefined) throw 'Unknown type "' + state.type + '"';

    // Update type icon
    let typeIcon = item.getElementsByClassName("type-icon")[0] as HTMLElement;
    let color: string;
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (typeConfig.color.startsWith("#")) {
      if (isDark && typeConfig.darkColor !== undefined) {
        color = typeConfig.darkColor;
      } else {
        color = typeConfig.color;
      }
    } else if (state.options[typeConfig.color].startsWith("#")) {
      color = state.options[typeConfig.color];
    } else {
      if (isDark) {
        color = "#ffffff";
      } else {
        color = "#000000";
      }
    }
    color = ensureThemeContrast(color);
    const icon = 'url("symbols/sourceList/' + typeConfig.symbol + '.svg")';
    if (typeIcon.style.getPropertyValue("--type-icon") !== icon) typeIcon.style.setProperty("--type-icon", icon);
    if (typeIcon.dataset.color !== color) {
      typeIcon.dataset.color = color;
      typeIcon.style.backgroundColor = color;
    }

    // Update type name
    let typeNameComponents: string[] = [];
    if (typeConfig.showInTypeName) {
      typeNameComponents.push(typeConfig.display);
    }
    typeConfig.options.forEach((optionConfig) => {
      if (optionConfig.showInTypeName) {
        let valueKey = state.options[optionConfig.key];
        let valueConfig = optionConfig.values.find((value) => value.key === valueKey);
        if (valueConfig === undefined) return;
        typeNameComponents.push(valueConfig.display);
      }
    });
    let typeNameElement = item.getElementsByClassName("type-name")[0] as HTMLElement;
    typeNameElement.innerText = typeNameComponents.join("/") + (typeNameComponents.length > 0 ? ":" : "");

    // Update log key
    let keyContainer = item.getElementsByClassName("key-container")[0] as HTMLElement;
    let keySpan = keyContainer.firstElementChild as HTMLElement;
    keySpan.innerText = state.logKey;
    keySpan.style.textDecoration = this.isFieldAvailable(state) ? "" : "line-through";
    keyContainer.title = state.logKey;

    // Update type width, cloning to a new node in case the controls aren't visible
    let mockTypeName = typeNameElement.cloneNode(true) as HTMLElement;
    let mockSourceContainer = document.createElement("div");
    mockSourceContainer.classList.add("source-list");
    mockSourceContainer.appendChild(mockTypeName);
    document.body.appendChild(mockSourceContainer);
    let typeNameWidth = mockTypeName.clientWidth;
    if (typeNameWidth > 0) typeNameWidth += 3; //Add extra margin after colon
    document.body.removeChild(mockSourceContainer);
    keyContainer.style.setProperty("--type-width", typeNameWidth.toString() + "px");

    const graphButton = item.querySelector<HTMLButtonElement>(".show-in-graph");
    if (graphButton) {
      const enabled = state.options.showInGraph === "true";
      graphButton.title = "Show in graph";
      graphButton.setAttribute("aria-label", "Show " + state.logKey + " in graph");
      graphButton.setAttribute("aria-pressed", String(enabled));
    }

    // Update hide button
    let hideButton = item.getElementsByClassName("hide")[0] as HTMLButtonElement;
    let hideIcon = hideButton.firstElementChild as HTMLImageElement;
    hideIcon.src = "symbols/" + (state.visible ? "visibility.svg" : "visibilityoff.svg");
    let titleText = state.visible ? "Hide field" : "Show field";
    hideButton.title = titleText;
    if (state.visible) {
      item.classList.remove("hidden");
    } else {
      item.classList.add("hidden");
    }

    // Save to memory
    if (this.config.typeMemoryId !== undefined) {
      if (!(this.config.typeMemoryId in window.typeMemory)) {
        window.typeMemory[this.config.typeMemoryId] = {};
      }
      window.typeMemory[this.config.typeMemoryId][state.logKey] = { type: state.type, options: state.options };
    }
  }

  private isChild(index: number) {
    if (index < 0 || index >= this.state.length) return false;
    let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === this.state[index].type);
    return typeConfig !== undefined && typeConfig.childOf !== undefined;
  }

  private isFieldAvailable(item: SourceListItemState): boolean {
    let fieldType = window.log.getType(item.logKey);
    let fieldStructuredType = window.log.getStructuredType(item.logKey);
    return (fieldType !== null && LoggableType[fieldType] === item.logType) || fieldStructuredType === item.logType;
  }

  /**
   * Updates the preview value of an item.
   *
   * @param item The HTML element to update
   * @param state The associated item state
   */
  private updatePreview(item: HTMLElement, state: SourceListItemState) {
    let time = window.selection.getRenderTime();
    let valueSymbol = item.getElementsByClassName("value-symbol")[0] as HTMLElement;
    let valueText = item.getElementsByClassName("value")[0] as HTMLElement;
    let typeConfig = this.config.types.find((typeConfig) => typeConfig.key === state.type);

    // Get text
    let text: string | null = null;
    if (this.isFieldAvailable(state) && time !== null) {
      let logType = window.log.getType(state.logKey);
      let structuredType = window.log.getStructuredType(state.logKey);
      if (logType !== null) {
        let value: any = null;
        if (logType === LoggableType.Number && this.getNumberPreview !== undefined) {
          text = this.getNumberPreview(state.logKey, time);
        } else if (logType !== LoggableType.Empty) {
          value = getOrDefault(window.log, state.logKey, logType, time, null);
        }
        if (value !== null || logType === LoggableType.Empty) {
          if (typeConfig?.previewType !== undefined) {
            if (typeConfig?.previewType !== null) {
              let numberRotationUnits: "radians" | "degrees" = "radians";
              if ("units" in state.options) {
                numberRotationUnits = state.options.units === "degrees" ? "degrees" : "radians";
              }
              let poseStrings: string[] = [];
              if (typeConfig?.previewType === "ModuleVelocities") {
                let moduleVelocities = grabModuleVelocities(window.log, state.logKey, time, undefined, this.UUID);
                moduleVelocities.forEach((state) => {
                  poseStrings.push(
                    "\u03bd: " +
                      state.velocity.toFixed(2) +
                      "m/s, \u03b8: " +
                      Units.convert(state.angle, "radians", "degrees").toFixed(2) +
                      "\u00b0"
                  );
                });
              } else if (typeConfig?.previewType === "RobotVelocities") {
                let robotVelocities = grabRobotVelocities(window.log, state.logKey, time, this.UUID);
                poseStrings.push(
                  "\u03bdx: " +
                    robotVelocities.vx.toFixed(2) +
                    "m/s, \u03bdy: " +
                    robotVelocities.vy.toFixed(2) +
                    "m/s, \u03a9: " +
                    Units.convert(robotVelocities.omega, "radians", "degrees").toFixed(2) +
                    "\u00b0/s"
                );
              } else {
                let poses = grabPosesAuto(
                  window.log,
                  state.logKey,
                  state.logType,
                  time,
                  this.UUID,
                  numberRotationUnits
                );
                poseStrings = poses.map((annotatedPose) => {
                  switch (typeConfig?.previewType) {
                    case "Rotation2d": {
                      return (
                        Units.convert(rotation3dTo2d(annotatedPose.pose.rotation), "radians", "degrees").toFixed(2) +
                        "\u00b0"
                      );
                    }
                    case "Translation2d": {
                      return (
                        "X: " +
                        annotatedPose.pose.translation[0].toFixed(3) +
                        "m, Y: " +
                        annotatedPose.pose.translation[1].toFixed(3) +
                        "m"
                      );
                    }
                    case "Pose2d":
                    case "Transform2d": {
                      return (
                        "X: " +
                        annotatedPose.pose.translation[0].toFixed(3) +
                        "m, Y: " +
                        annotatedPose.pose.translation[1].toFixed(3) +
                        "m, \u03b8: " +
                        Units.convert(rotation3dTo2d(annotatedPose.pose.rotation), "radians", "degrees").toFixed(2) +
                        "\u00b0"
                      );
                    }
                    case "Rotation3d": {
                      let rpy = rotation3dToRPY(annotatedPose.pose.rotation);
                      return (
                        "Roll: " +
                        Units.convert(rpy[0], "radians", "degrees").toFixed(2) +
                        "\u00b0, Pitch: " +
                        Units.convert(rpy[1], "radians", "degrees").toFixed(2) +
                        "\u00b0, Yaw: " +
                        Units.convert(rpy[2], "radians", "degrees").toFixed(2) +
                        "\u00b0"
                      );
                    }
                    case "Translation3d": {
                      return (
                        "X: " +
                        annotatedPose.pose.translation[0].toFixed(3) +
                        "m, Y: " +
                        annotatedPose.pose.translation[1].toFixed(3) +
                        "m, Z: " +
                        annotatedPose.pose.translation[2].toFixed(3) +
                        "m"
                      );
                    }
                    case "Pose3d": {
                      let rpy = rotation3dToRPY(annotatedPose.pose.rotation);
                      return (
                        "X: " +
                        annotatedPose.pose.translation[0].toFixed(3) +
                        "m, Y: " +
                        annotatedPose.pose.translation[1].toFixed(3) +
                        "m, Z: " +
                        annotatedPose.pose.translation[2].toFixed(3) +
                        "m, Roll: " +
                        Units.convert(rpy[0], "radians", "degrees").toFixed(2) +
                        "\u00b0, Pitch: " +
                        Units.convert(rpy[1], "radians", "degrees").toFixed(2) +
                        "\u00b0, Yaw: " +
                        Units.convert(rpy[2], "radians", "degrees").toFixed(2) +
                        "\u00b0"
                      );
                    }
                    default: {
                      return "";
                    }
                  }
                });
              }
              if (poseStrings.length === 1) {
                text = poseStrings[0];
              } else if (poseStrings.length === 0) {
                text = "No values";
              } else {
                text = text =
                  poseStrings.length.toString() +
                  " value" +
                  (poseStrings.length === 1 ? "" : "s") +
                  " \u2014 [" +
                  poseStrings.map((str) => "(" + str + ")").join(", ") +
                  "]";
              }
            }
          } else if (structuredType === "Mechanism2d") {
            let mechanismState = getMechanismState(window.log, state.logKey, time);
            if (mechanismState !== null) {
              let count = mechanismState.lines.length;
              text = count.toString() + " segment" + (count === 1 ? "" : "s");
            }
          } else if (structuredType === "Alerts") {
            let errorCount: number = getOrDefault(
              window.log,
              state.logKey + "/errors",
              LoggableType.StringArray,
              time,
              []
            ).length;
            let warningCount: number = getOrDefault(
              window.log,
              state.logKey + "/warnings",
              LoggableType.StringArray,
              time,
              []
            ).length;
            let infoCount: number = getOrDefault(
              window.log,
              state.logKey + "/infos",
              LoggableType.StringArray,
              time,
              []
            ).length;
            text =
              errorCount.toString() +
              " error" +
              (errorCount === 1 ? "" : "s") +
              ", " +
              warningCount.toString() +
              " warning" +
              (warningCount === 1 ? "" : "s") +
              ", " +
              infoCount.toString() +
              " info" +
              (infoCount === 1 ? "" : "s");
          } else if (
            logType === LoggableType.BooleanArray ||
            logType === LoggableType.NumberArray ||
            logType === LoggableType.StringArray
          ) {
            text =
              value.length.toString() +
              " value" +
              (value.length === 1 ? "" : "s") +
              " \u2014 " +
              getLogValueText(value, logType);
          } else {
            text = formatChannelValue(value, window.log.getChannelProfile(state.logKey));
          }
        }
      }
    }

    // The raw value and sample age tooltip changes every frame, so only the hovered item builds it
    let title: string | null = null;
    const rawTime = window.selection.getRenderTime();
    if (item === this.hoveredItem && rawTime !== null) {
      const type = window.log.getType(state.logKey);
      const raw = type === null ? null : getOrDefault(window.log, state.logKey, type, rawTime, null);
      title = rawChannelValue(raw, window.log.getChannelProfile(state.logKey));
      if (type === LoggableType.Number) {
        // Sample age and rate, so a held value from a stalled source is not mistaken for a live one
        const recent = window.log.getNumber(state.logKey, rawTime - 10, rawTime);
        const ts = recent?.timestamps ?? [];
        const last = ts.findLast((t) => t <= rawTime);
        if (last === undefined) title += "\nno sample in the last 10 s";
        else {
          const recentRate = ts.filter((t) => t <= rawTime && t > last - 1).length - 1;
          let nominalRate: number | undefined;
          try {
            nominalRate = JSON.parse(window.log.getMetadataString(state.logKey)).nominal_rate_hz;
          } catch {
            /* Not every imported field has JSON metadata. */
          }
          title +=
            `\nsample age ${(rawTime - last).toFixed(2)} s` +
            (nominalRate ? ` · source ${nominalRate} Hz` : recentRate > 0 ? ` · retained ${recentRate} Hz` : "");
        }
      }
    }
    const status = this.itemStatus.get(state.logKey);
    if (status) {
      text = status.text;
      title = status.title ?? status.text;
    }
    // Update state, writing only what changed so an unchanged preview costs no style or layout work
    if (title !== null && valueText.title !== title) valueText.title = title;
    const hidden = text === null;
    if (valueSymbol.hidden !== hidden) valueSymbol.hidden = hidden;
    if (valueText.hidden !== hidden) valueText.hidden = hidden;
    const height = hidden ? "30px" : "50px";
    if (item.style.height !== height) item.style.height = height;
    if (text !== null && text !== this.previewTexts.get(valueText)) {
      this.previewTexts.set(valueText, text);
      valueText.innerText = text;
    }
  }
}
