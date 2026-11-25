// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { GraphColors } from "../../shared/Colors";
import LogField from "../../shared/log/LogField";
import { TracksideRendererCommand } from "../../shared/renderers/TracksideRenderer";
import { SourceListItemState, SourceListState } from "../../shared/SourceListConfig";
import {
  dbcDefinition,
  isTracksideLive,
  Limits,
  limitUnit,
  sameTracksideTile,
  tileLabel,
  tileState,
  TracksideTile
} from "../../shared/Trackside";
import { createUUID } from "../../shared/util";
import { isTextFrame } from "../FrameScheduler";
import SourceList from "../SourceList";
import type { TracksideAlertSource } from "../TracksideAlerts";
import LineGraphController from "./LineGraphController";
import TabController from "./TabController";
import TracksideController_Config from "./TracksideController_Config";

/** Moves a visible tile to an insertion boundary while retaining hidden list entries. */
export function reorderTiles(sources: SourceListState, from: number, to: number): SourceListState {
  const visible = sources.flatMap((source, index) => (source.visible ? [index] : []));
  const result = sources.slice();
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= visible.length ||
    to < 0 ||
    to > visible.length ||
    to === from ||
    to === from + 1
  )
    return result;
  const start = visible[from];
  const end = visible[to] ?? sources.length;
  const [source] = result.splice(start, 1);
  result.splice(end > start ? end - 1 : end, 0, source);
  return result;
}

/** Map opted-in tiles to the stock graph's numeric and discrete sources. */
export function tracksideGraphSources(sources: SourceListState) {
  const selected = sources.filter((source) => source.options.showInGraph === "true");
  const fields = selected.map((source, index) => ({
    ...source,
    visible: true,
    type: source.logType === "Number" ? "stepped" : "stripes",
    options: { color: GraphColors[index % GraphColors.length].key, size: "normal" }
  }));
  return {
    leftSources: fields.filter((source) => source.logType === "Number"),
    discreteSources: fields.filter((source) => source.logType !== "Number")
  };
}

export default class TracksideController implements TabController {
  UUID = createUUID();
  limits: { [logKey: string]: Limits } = {};
  private sourceList: SourceList;
  private graphController: LineGraphController;
  private graphSources = "";
  private hasGraph = false;
  private lastCommand?: TracksideRendererCommand;
  private tiles = new WeakMap<
    SourceListItemState,
    {
      field: LogField | null;
      version: number;
      discard: number;
      time: number;
      logKey: string;
      metadata: string;
      dbcSignal: string | undefined;
      label: string;
      definition: ReturnType<typeof dbcDefinition>;
      profile: ReturnType<typeof window.log.getChannelProfile>;
      low: number | undefined;
      high: number | undefined;
      freshness: string;
      tile: TracksideTile;
    }
  >();

  constructor(root: HTMLElement) {
    // Use the stock graph pipeline for units, gaps and axes.
    const graphRoot = document.createElement("div");
    for (const axis of ["left", "right", "discrete"]) {
      const element = document.createElement("div");
      element.className = "line-graph-" + axis;
      graphRoot.append(element);
    }
    this.graphController = new LineGraphController(graphRoot);
    this.sourceList = new SourceList(root.firstElementChild as HTMLElement, TracksideController_Config, []);
    this.sourceList.getCriticalLimits = (key) => ({
      uuid: this.UUID,
      unit: limitUnit(window.log.getChannelProfile(key)),
      limits: this.limits[key] ?? {}
    });
    // Limits follow a tile when the DBC fallback moves it, e.g. from a cellular path to an MF4 key.
    this.sourceList.onFieldRemapped = (from, to) => this.moveLimits(from, to);
  }
  dispose() {
    this.sourceList.stop();
    this.graphController.dispose();
  }
  /** Moves a tile's limits to its new key, unless that key already has its own. */
  moveLimits(from: string, to: string) {
    if (!(from in this.limits) || to in this.limits) return;
    this.limits[to] = this.limits[from];
    delete this.limits[from];
  }
  reorderTiles(from: number, to: number) {
    this.sourceList.setState(reorderTiles(this.sourceList.getState(), from, to));
  }
  saveState() {
    return { sources: this.sourceList.getState(), limits: this.limits };
  }
  restoreState(state: unknown) {
    if (typeof state !== "object" || state === null) return;
    // Limits first: setting the sources can re-point tiles, which moves their limits.
    if ("limits" in state && typeof state.limits === "object" && state.limits !== null)
      this.limits = { ...(state.limits as typeof this.limits) };
    if ("sources" in state) this.sourceList.setState(state.sources as SourceListState);
  }
  refresh() {
    this.sourceList.refresh();
  }
  newAssets() {}
  private alertConfig: TracksideAlertSource[] = [];

  /** Alert labels and limits follow the tiles, including unavailable or hidden fields. */
  getAlertConfiguration(): TracksideAlertSource[] {
    const sources = this.sourceList.getState();
    if (
      sources.length === this.alertConfig.length &&
      sources.every(({ logKey, dbcSignal }, index) => {
        const entry = this.alertConfig[index];
        const limits = this.limits[logKey];
        return (
          entry.key === logKey &&
          entry.dbcSignal === dbcSignal &&
          entry.low === limits?.low &&
          entry.high === limits?.high
        );
      })
    )
      return this.alertConfig;
    return (this.alertConfig = sources.map(({ logKey, dbcSignal }) => ({
      key: logKey,
      dbcSignal,
      low: this.limits[logKey]?.low,
      high: this.limits[logKey]?.high
    })));
  }

  getActiveFields() {
    return this.sourceList.getActiveFields();
  }
  showTimeline() {
    return false;
  }
  followsLiveTime() {
    return this.hasGraph;
  }
  getCommand(): TracksideRendererCommand {
    const liveTime = window.selection.getCurrentLiveTime();
    const time = liveTime ?? window.log.getTimestampRange()[1];
    const summary = window.liveStatus?.getLiveStatus();
    const liveEdge = isTracksideLive(summary, liveTime, time);
    const sources = this.sourceList.getState();
    const graphSources = JSON.stringify(sources.filter((source) => source.options.showInGraph === "true"));
    if (graphSources !== this.graphSources) {
      this.graphSources = graphSources;
      const state = tracksideGraphSources(sources);
      this.hasGraph = state.leftSources.length > 0 || state.discreteSources.length > 0;
      this.graphController.restoreState(state);
    }
    const graph = this.hasGraph ? this.graphController.getCommand(time) : null;
    const message =
      liveEdge && summary.backend === "connected" && !summary.hasFreshData ? "Base connected, no car data" : "";
    const previous = this.lastCommand;
    let tiles = previous?.tiles;
    // Trackside readings are text. Use the shared text cadence while drawing an opted-in graph
    // at the full frame rate. Historical seeks and layout edits still draw on input frames.
    if (!previous || !liveEdge || isTextFrame() || (previous.message && !message)) {
      tiles = sources
        .filter((source) => source.visible)
        .map((source) => this.getTile(source, time, liveEdge ? summary : undefined));
      if (previous && tiles.length === previous.tiles.length && tiles.every((tile, i) => tile === previous.tiles[i])) {
        tiles = previous.tiles;
      }
    }
    if (previous && tiles === previous.tiles && graph === previous.graph && message === previous.message)
      return previous;
    return (this.lastCommand = { tiles: tiles!, graph, message });
  }

  private getTile(
    source: SourceListItemState,
    time: number,
    summary: ReturnType<NonNullable<typeof window.liveStatus>["getLiveStatus"]> | undefined
  ) {
    const { logKey, dbcSignal } = source;
    const log = window.log;
    const field = log.getField(logKey);
    const version = field?.getDataVersion() ?? 0;
    const discard = field?.getDiscardVersion() ?? 0;
    const sampleTime = Math.min(time, field?.getTimestamp(field.getTimestampCount() - 1) ?? -Infinity);
    const metadata = log.getMetadataString(logKey);
    const profile = log.getChannelProfile(logKey);
    const limits = this.limits[logKey];
    const freshness = summary ? window.liveStatus!.getFieldFreshness(logKey) : null;
    const age =
      summary?.backend === "connected" && (freshness === "stale" || freshness === "offline")
        ? window.liveStatus!.getFieldAge(logKey)
        : null;
    const freshnessKey = summary ? [summary.backend, summary.hasFreshData, freshness, age?.toFixed(1)].join("|") : "";
    const previous = this.tiles.get(source);
    const sameDescriptor =
      previous?.logKey === logKey && previous.metadata === metadata && previous.dbcSignal === dbcSignal;
    if (
      sameDescriptor &&
      previous.field === field &&
      previous.version === version &&
      previous.discard === discard &&
      previous.time === sampleTime &&
      previous.profile === profile &&
      previous.low === limits?.low &&
      previous.high === limits?.high &&
      previous.freshness === freshnessKey
    ) {
      return previous.tile;
    }
    const range = field?.getRange(time, time, this.UUID);
    const value = range && range.timestamps[0] <= time ? range.values[0] : undefined;
    const label = sameDescriptor ? previous.label : tileLabel(metadata, logKey, dbcSignal);
    const definition = sameDescriptor ? previous.definition : dbcDefinition(metadata, logKey);
    let tile = tileState(
      logKey,
      value,
      profile,
      limits,
      definition,
      summary ? { summary, freshness, age } : undefined,
      label
    );
    if (previous && sameTracksideTile(previous.tile, tile)) tile = previous.tile;
    this.tiles.set(source, {
      field,
      version,
      discard,
      time: sampleTime,
      logKey,
      metadata,
      dbcSignal,
      label,
      definition,
      profile,
      low: limits?.low,
      high: limits?.high,
      freshness: freshnessKey,
      tile
    });
    return tile;
  }
}
