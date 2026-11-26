// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { CELLS_MODES, Cell, CellsCommand, CellsMode, CellsOptions, CellsView, cellsRange } from "../../shared/Cells";
import { SourceListConfig, SourceListState } from "../../shared/SourceListConfig";
import { isTracksideLive } from "../../shared/Trackside";
import { Units } from "../../shared/units";
import { createUUID } from "../../shared/util";
import SourceList from "../SourceList";
import TabController from "./TabController";

const sourceConfig = (title: string, singleField = false): SourceListConfig => ({
  title,
  autoAdvance: false,
  allowChildrenFromDrag: !singleField,
  types: [
    {
      key: "number",
      display: title,
      symbol: "numbers",
      showInTypeName: false,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: ["Number"],
      singleField,
      showDocs: false,
      options: []
    }
  ]
});

type CellsState = Record<CellsMode, { sources: SourceListState; options: CellsOptions }> & {
  minimum: SourceListState;
  maximum: SourceListState;
};

export default class CellsController implements TabController {
  UUID = createUUID();
  private sources: Record<CellsMode, SourceList>;
  private minimum: SourceList;
  private maximum: SourceList;
  private options: Record<CellsMode, CellsOptions> = {
    voltages: { segmentSize: 18 },
    temperatures: { segmentSize: 18 }
  };
  private syncOptions: (() => void)[] = [];
  private lastCommand?: CellsCommand;

  constructor(root: HTMLElement) {
    this.sources = {
      voltages: new SourceList(root.querySelector(".cells-voltage-sources")!, sourceConfig("Voltages"), []),
      temperatures: new SourceList(root.querySelector(".cells-temperature-sources")!, sourceConfig("Temperatures"), [])
    };
    this.minimum = new SourceList(root.querySelector(".cells-minimum")!, sourceConfig("Minimum reference", true), []);
    this.maximum = new SourceList(root.querySelector(".cells-maximum")!, sourceConfig("Maximum reference", true), []);

    for (const mode of CELLS_MODES) {
      const section = root.querySelector<HTMLElement>('[data-cells-options="' + mode + '"]')!;
      const lock = section.querySelector<HTMLButtonElement>(".cells-options button")!;
      const syncLock = () => {
        const range = this.options[mode].lockedRange;
        lock.setAttribute("aria-pressed", String(range !== undefined));
        lock.title = range ? `Unlock range (${range[0].toFixed(3)} to ${range[1].toFixed(3)})` : "Lock current range";
        lock.setAttribute("aria-label", lock.title);
        lock.querySelector("img")!.src = range ? "symbols/lock.svg" : "symbols/lockopenright.svg";
      };
      lock.onclick = () => {
        const view = this.lastCommand?.[mode];
        if (this.options[mode].lockedRange) this.options[mode] = { ...this.options[mode], lockedRange: undefined };
        else if (view?.cells.some(({ value }) => value !== undefined) || view?.references.length) {
          this.options[mode] = { ...this.options[mode], lockedRange: cellsRange(view, mode) };
        }
        syncLock();
      };
      this.syncOptions.push(syncLock);
      for (const input of section.querySelectorAll<HTMLInputElement>(".cells-options input")) {
        const key = input.name as "low" | "high" | "outlier" | "segmentSize";
        const sync = () => (input.value = this.options[mode][key]?.toString() ?? "");
        this.syncOptions.push(sync);
        input.onchange = () => {
          const value = input.valueAsNumber;
          if (input.checkValidity()) {
            const options = this.options[mode];
            const next = Number.isFinite(value) ? value : undefined;
            if (
              (key !== "low" || next === undefined || next <= (options.high ?? Infinity)) &&
              (key !== "high" || next === undefined || next >= (options.low ?? -Infinity))
            ) {
              this.options[mode] = { ...options, [key]: next ?? (key === "segmentSize" ? 18 : undefined) };
            }
          }
          sync();
        };
      }
    }
    this.syncOptions.forEach((sync) => sync());
  }

  private lists() {
    return [this.sources.voltages, this.sources.temperatures, this.minimum, this.maximum];
  }

  dispose() {
    this.lists().forEach((list) => list.stop());
  }

  saveState(): CellsState {
    return {
      voltages: { sources: this.sources.voltages.getState(), options: this.options.voltages },
      temperatures: { sources: this.sources.temperatures.getState(), options: this.options.temperatures },
      minimum: this.minimum.getState(),
      maximum: this.maximum.getState()
    };
  }

  restoreState(state: unknown) {
    if (!state || typeof state !== "object") return;
    const saved = state as Partial<CellsState>;
    for (const mode of CELLS_MODES) {
      const view = saved[mode];
      if (!view) continue;
      this.sources[mode].setState(view.sources);
      this.options[mode] = { ...view.options, segmentSize: Math.max(1, Math.floor(view.options.segmentSize || 18)) };
    }
    this.minimum.setState(saved.minimum ?? []);
    this.maximum.setState(saved.maximum ?? []);
    this.syncOptions.forEach((sync) => sync());
  }

  refresh() {
    this.lists().forEach((list) => list.refresh());
  }

  newAssets() {}

  getActiveFields() {
    return this.lists().flatMap((list) => list.getActiveFields());
  }

  showTimeline() {
    return true;
  }

  getCommand(): CellsCommand {
    const log = window.log;
    const time = window.selection.getRenderTime() ?? log.getTimestampRange()[1];
    const live = window.liveStatus;
    const liveTime = window.selection.getCurrentLiveTime();
    const atLiveEdge = live && isTracksideLive(live.getLiveStatus(), liveTime, time);
    const read = (key: string, temperature = false): Omit<Cell, "number" | "key"> => {
      const field = log.getField(key);
      const samples = (field?.getNumberArrivals()?.field ?? field)?.getNumber(time, time, this.UUID);
      const value = samples?.values[0];
      if (!samples || samples.timestamps[0] > time || value === undefined || !Number.isFinite(value)) return {};
      const sampleTime = samples.timestamps[0];
      const freshness = atLiveEdge ? live.getFieldFreshness(key) : null;
      const sampleAge = Math.max(0, time - sampleTime);
      const stale = freshness === null ? sampleAge > 3 : freshness === "stale" || freshness === "offline";
      const unit = log.getChannelProfile(key).from;
      const target = temperature ? "celsius" : "volts";
      const convert = unit && Units.GROUP_BY_UNIT[unit] === Units.GROUP_BY_UNIT[target];
      return {
        value: convert ? Units.convert(value, unit, target) : value,
        staleAge: stale ? Math.round(((atLiveEdge ? live.getFieldAge(key) : null) ?? sampleAge) * 10) / 10 : undefined
      };
    };
    const references = [
      [this.minimum, "Min ref"],
      [this.maximum, "Max ref"]
    ].flatMap(([list, label]) => {
      const key = (list as SourceList).getState().find((source) => source.visible)?.logKey;
      if (key === undefined) return [];
      const reading = read(key);
      return reading.value !== undefined && reading.staleAge === undefined
        ? [{ label: label as string, value: reading.value }]
        : [];
    });
    const build = (mode: CellsMode): CellsView => {
      const old = this.lastCommand?.[mode];
      const cells = this.sources[mode].getState().flatMap((source, index) => {
        if (!source.visible) return [];
        const key = source.logKey;
        const sample = read(key, mode === "temperatures");
        return [{ number: index + 1, key, ...sample }];
      });
      const options = this.options[mode];
      const lines = mode === "voltages" ? references : [];
      if (
        old?.options === options &&
        cells.length === old.cells.length &&
        lines.length === old.references.length &&
        cells.every((cell, i) => {
          const last = old.cells[i];
          return (
            cell.number === last.number &&
            cell.key === last.key &&
            cell.value === last.value &&
            cell.staleAge === last.staleAge
          );
        }) &&
        lines.every((line, i) => line.label === old.references[i].label && line.value === old.references[i].value)
      )
        return old;
      return { cells, references: lines, options };
    };
    const voltages = build("voltages");
    const temperatures = build("temperatures");
    if (this.lastCommand?.voltages === voltages && this.lastCommand.temperatures === temperatures)
      return this.lastCommand;
    return (this.lastCommand = { voltages, temperatures });
  }
}
