// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { Freshness, LiveStatusSummary } from "../hub/dataSources/LiveStatus";
import { classifyDBCFault, DBCFaultDefinition, Severity } from "./DBCFault";
import { ChannelProfile, convertChannelValue, formatChannelValue } from "./display/ChannelProfile";
import type { TracksideRendererCommand } from "./renderers/TracksideRenderer";

export type Limits = { low?: number; high?: number };
export type TracksideTile = {
  label: string;
  text: string;
  unit: string;
  state: string;
  severity: Severity;
  freshness: Freshness | null;
  /** Full names of the set fault bits, one per line, for the tooltip. */
  detail?: string;
};

export function sameTracksideTile(a: TracksideTile, b: TracksideTile): boolean {
  return (
    a === b ||
    (a.label === b.label &&
      a.text === b.text &&
      a.unit === b.unit &&
      a.state === b.state &&
      a.severity === b.severity &&
      a.freshness === b.freshness &&
      a.detail === b.detail)
  );
}

export type TracksidePatch = {
  tiles: [index: number, tile: TracksideTile][];
  message?: string;
  graph?: TracksideRendererCommand["graph"];
};

/** The caller sends a full snapshot when the tile count changes. */
export function diffTrackside(previous: TracksideRendererCommand, next: TracksideRendererCommand): TracksidePatch {
  const patch: TracksidePatch = { tiles: [] };
  next.tiles.forEach((tile, index) => {
    if (!sameTracksideTile(tile, previous.tiles[index])) patch.tiles.push([index, tile]);
  });
  if (next.message !== previous.message) patch.message = next.message;
  if (next.graph !== previous.graph) patch.graph = next.graph;
  return patch;
}

export function applyTracksidePatch(
  command: TracksideRendererCommand,
  patch: TracksidePatch
): TracksideRendererCommand {
  const tiles = patch.tiles.length ? command.tiles.slice() : command.tiles;
  for (const [index, tile] of patch.tiles) tiles[index] = tile;
  return {
    tiles,
    message: patch.message ?? command.message,
    graph: patch.graph === undefined ? command.graph : patch.graph
  };
}

export function isTracksideLive(
  summary: LiveStatusSummary | undefined,
  liveTime: number | null,
  renderTime?: number
): summary is LiveStatusSummary {
  return (
    summary !== undefined &&
    summary.viewedRun === summary.runCount - 1 &&
    (renderTime === undefined || liveTime === null || renderTime >= liveTime - 0.05)
  );
}

export function dbcDefinition(metadataString: string, path: string): DBCFaultDefinition | null {
  if (path.endsWith("/raw")) return null;
  try {
    const metadata = JSON.parse(metadataString);
    if (!metadata.dbcSignal) return null;
    const def = { name: metadata.dbcSignal, values: metadata.values ?? metadata.enumLabels, comment: metadata.comment };
    return classifyDBCFault(def, 0) ? def : null;
  } catch {
    return null;
  }
}

/**
 * A tile's name: the field's DBC signal, then the layout's saved DBC signal (for a field the open
 * log lacks), then the source's label, then the last path segment.
 */
export function tileLabel(metadataString: string, path: string, savedDbcSignal?: string): string {
  let metadata: any = null;
  try {
    metadata = JSON.parse(metadataString);
  } catch {
    // Not every field has JSON metadata.
  }
  for (const name of [metadata?.dbcSignal, savedDbcSignal, metadata?.label]) {
    if (typeof name === "string" && name.length > 0) return name;
  }
  return path.split("/").pop() || path;
}

/** Unit suffix for a field's limits: the same display unit `tileState` compares against, or none if unitless. */
export function limitUnit(profile: ChannelProfile): string {
  return profile.enumLabels || profile.unit === "1" ? "" : profile.unit;
}

/** Parses the limits prompt's boxes. A blank box means no limit on that side. */
export function parseLimitInputs(
  low: string,
  high: string
): { range: [number | null, number | null] } | { error: string } {
  const range = [low, high].map((text) => (text.trim() === "" ? null : Number(text))) as [number | null, number | null];
  if (range.some((value) => value !== null && !Number.isFinite(value)))
    return { error: "Enter a number, or leave the box blank." };
  if (range[0] !== null && range[1] !== null && range[0] >= range[1])
    return { error: "Critical minimum must be lower than critical maximum." };
  return { range };
}

/** Edits one limit while retaining the other value exactly. */
export function parseCriticalLimit(side: "low" | "high", text: string, range: [number | null, number | null]) {
  return parseLimitInputs(
    side === "low" ? text : range[0] === null ? "" : String(range[0]),
    side === "high" ? text : range[1] === null ? "" : String(range[1])
  );
}

export function tileState(
  path: string,
  value: unknown,
  profile: ChannelProfile,
  limits: Limits = {},
  definition: DBCFaultDefinition | null = null,
  live?: { summary: LiveStatusSummary; freshness: Freshness | null; age: number | null },
  label = path.split("/").pop() || path
): TracksideTile {
  // NaN is a "no reading" sample (a DBC sentinel): show it as such, never as a limit violation.
  const noReading = typeof value === "number" && Number.isNaN(value);
  const fault = definition ? classifyDBCFault(definition, value) : null;
  const numeric = typeof value === "number" ? convertChannelValue(value, profile) : NaN;
  const violation = numeric < (limits.low ?? -Infinity) || numeric > (limits.high ?? Infinity);
  const available =
    !live || (live.summary.backend === "connected" && live.summary.hasFreshData && live.freshness === "online");
  const severity = !available
    ? "ok"
    : violation
    ? "critical"
    : fault?.severity === "unknown"
    ? "ok"
    : fault?.severity ?? "ok";
  // The age shows only as text at 0.1 s steps, so the tile changes (and a satellite is sent it) only then
  const age = live?.age ?? null;
  const ageText =
    age === null || (live?.freshness !== "stale" && live?.freshness !== "offline") ? "" : ` ${age.toFixed(1)} s`;
  let state = severity === "critical" ? "Alarm" : severity === "warn" ? "Warning" : "";
  if (live) {
    if (live.summary.backend !== "connected") state = "⊘ link lost";
    else if (live.freshness === "stale") state = `◇${ageText}`;
    else if (live.freshness === "offline") state = `⊘ offline${ageText}`;
    else if (live.freshness === "unknown" || live.freshness === null) state = "?";
  }
  return {
    label,
    text:
      value === undefined
        ? "—"
        : noReading
        ? "no reading"
        : fault?.label ?? formatChannelValue(value, { ...profile, unit: "" }),
    unit: value !== undefined && typeof value === "number" && !noReading && !fault ? limitUnit(profile) : "",
    state,
    severity,
    freshness: live?.freshness ?? null,
    ...(fault?.detail ? { detail: fault.detail } : {})
  };
}

export function alertLine(
  items: { tile: TracksideTile; value: unknown; profile: ChannelProfile; limits?: Limits; fault?: boolean }[]
) {
  const alarms = items.filter(({ tile }) => tile.severity !== "ok");
  return {
    severity: alarms.some(({ tile }) => tile.severity === "critical") ? "critical" : "warn",
    text: alarms
      .map(({ tile, value, profile, limits, fault }) => {
        if (fault) return `${tile.text} · ${tile.label}`;
        const above = typeof value === "number" && convertChannelValue(value, profile) > (limits?.high ?? Infinity);
        return `${tile.label} ${tile.text}${tile.unit ? " " + tile.unit : ""}, ${above ? "above" : "below"} ${
          above ? limits?.high : limits?.low
        }`;
      })
      .join("   ·   "),
    detail: alarms
      .map(({ tile }) => tile.detail)
      .filter((detail) => detail)
      .join("\n")
  };
}
