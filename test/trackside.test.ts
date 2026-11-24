// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import TracksideController, { reorderTiles, tracksideGraphSources } from "../src/hub/controllers/TracksideController";
import SourceList from "../src/hub/SourceList";
import { updateTracksideAlerts } from "../src/hub/TracksideAlerts";
import { channelProfile } from "../src/shared/display/ChannelProfile";
import Log from "../src/shared/log/Log";
import {
  alertLine,
  applyTracksidePatch,
  dbcDefinition,
  diffTrackside,
  isTracksideLive,
  limitUnit,
  parseCriticalLimit,
  parseLimitInputs,
  tileState
} from "../src/shared/Trackside";

const profile = channelProfile({ name: "Motor temp", unit: "degC" });
const definition = { name: "IMD_State", values: { 0: "Normal", 4: "Earth Fault", 5: "Ground Fault Warning" } };

test("Trackside reads the live edge and latest disconnected sample independently of the analysis cursor", () => {
  const globals = globalThis as any;
  const previous = globals.window;
  let liveTime: number | null = 100;
  const queriedTimes: number[] = [];
  const graphTimes: number[] = [];
  const log = new Log();
  log.putNumber("/temp", 99, 112);
  log.getChannelProfile = () => profile;
  const field = log.getField("/temp")!;
  const getRange = field.getRange.bind(field);
  field.getRange = (start, end) => {
    assert.equal(start, end);
    queriedTimes.push(start);
    return getRange(start, end);
  };
  const summary = { backend: "connected", hasFreshData: true, viewedRun: 0, runCount: 1 };
  globals.window = {
    selection: {
      getCurrentLiveTime: () => liveTime,
      getRenderTime: () => {
        throw new Error("Trackside must not read the analysis cursor");
      }
    },
    log,
    liveStatus: {
      getLiveStatus: () => summary,
      getFieldFreshness: () => "online",
      getFieldAge: () => 0.1
    }
  };
  const sources = [
    { type: "tile", logKey: "/temp", logType: "Number", visible: true, options: { showInGraph: "true" } }
  ];
  const controller: TracksideController = Object.assign(Object.create(TracksideController.prototype), {
    sourceList: { getState: () => sources },
    graphController: {
      restoreState: () => {},
      getCommand: (time: number) => {
        graphTimes.push(time);
        return null;
      }
    },
    limits: { "/temp": { high: 110 } },
    tiles: new WeakMap()
  });
  try {
    assert.equal(controller.showTimeline(), false);
    assert.equal(controller.getCommand().tiles[0].severity, "critical");
    liveTime = 101;
    controller.getCommand();
    liveTime = null;
    summary.backend = "error";
    const disconnected = controller.getCommand().tiles[0];
    assert.equal(disconnected.severity, "ok");
    assert.equal(disconnected.state, "⊘ link lost");
    assert.deepEqual(queriedTimes, [100, 99]);
    assert.deepEqual(graphTimes, [100, 101, 99]);
  } finally {
    globals.window = previous;
  }
});

test("tiles use display units for limits and do not ship numeric alarms", () => {
  const kelvin = channelProfile({ name: "temperature", unit: "kelvin" });
  assert.equal(tileState("/Motor temp", 385.15, kelvin).severity, "ok");
  assert.equal(tileState("/Motor temp", 385.15, kelvin, { high: 110 }).severity, "critical");
  assert.equal(tileState("/Motor temp", 110, profile, { high: 110 }).severity, "ok");
  assert.equal(tileState("/Motor temp", -1, profile, { low: 0 }).severity, "critical");
  assert.equal(tileState("/missing", undefined, profile).text, "—");
  assert.equal(tileState("/bool", false, profile).text, "false");
});

test("limit prompt units match the tile's display unit, even before data arrives", () => {
  assert.equal(limitUnit(channelProfile({ name: "temperature", unit: "kelvin" })), "°C");
  assert.equal(limitUnit(channelProfile({ name: "pack_voltage", unit: "V" })), "V");
  assert.equal(limitUnit(channelProfile({ name: "ratio", unit: "1" })), "");
  assert.equal(limitUnit(channelProfile({ name: "IMD_State", enumLabels: { 0: "Normal" } })), "");
  assert.equal(limitUnit(channelProfile({ name: "mystery" })), "");
});

test("limit prompt treats blank as no limit, keeps zero and rejects bad ranges", () => {
  assert.deepEqual(parseLimitInputs("", "4.2"), { range: [null, 4.2] });
  assert.deepEqual(parseLimitInputs("2.8", " "), { range: [2.8, null] });
  assert.deepEqual(parseLimitInputs("", ""), { range: [null, null] });
  assert.deepEqual(parseLimitInputs("0", "90"), { range: [0, 90] });
  const order = { error: "Critical minimum must be lower than critical maximum." };
  assert.deepEqual(parseLimitInputs("5", "5"), order);
  assert.deepEqual(parseLimitInputs("6", "5"), order);
  assert.ok("error" in parseLimitInputs("1e999", ""));
  assert.ok("error" in parseLimitInputs("", "invalid"));
});

test("limit input parsing preserves finite extremes on either side", () => {
  for (const value of [1e-7, 1e303, Number.MIN_VALUE, Number.MAX_VALUE, -1e-7, -1e303]) {
    assert.deepEqual(parseLimitInputs("", String(value)), { range: [null, value] });
    assert.deepEqual(parseLimitInputs(String(value), ""), { range: [value, null] });
  }
});

test("DBC classification controls tile severity and rejects non-DBC metadata", () => {
  assert.equal(tileState("/IMD_State", 4, profile, {}, definition).severity, "critical");
  assert.equal(tileState("/IMD_State", 5, profile, {}, definition).severity, "warn");
  assert.equal(tileState("/IMD_State", 0, profile, {}, definition).severity, "ok");
  assert.equal(dbcDefinition(JSON.stringify({ name: "Fault" }), "/Fault"), null);
  assert.equal(dbcDefinition(JSON.stringify({ dbcSignal: "FaultFlags" }), "/raw"), null);
});

test("live freshness suppresses alarms and distinguishes stale, offline and lost link", () => {
  const summary = { backend: "connected" as const, hasFreshData: true, backendDetail: "", viewedRun: 0, runCount: 1 };
  const stale = tileState("/Motor temp", 112, profile, { high: 110 }, null, { summary, freshness: "stale", age: 2.1 });
  assert.equal(stale.state, "◇ 2.1 s");
  assert.equal(stale.severity, "ok");
  assert.match(stale.text, /112/);
  assert.equal(
    tileState("/x", 1, profile, {}, null, { summary, freshness: "offline", age: 7 }).state,
    "⊘ offline 7.0 s"
  );
  assert.equal(
    tileState("/x", 1, profile, {}, null, { summary: { ...summary, backend: "error" }, freshness: "online", age: 1 })
      .state,
    "⊘ link lost"
  );
});

test("alert line names current faults and limit violations and clears on recovery", () => {
  const fault = { tile: tileState("/IMD_State", 4, profile, {}, definition), value: 4, profile, fault: true };
  const limits = { high: 110 };
  const high = { tile: tileState("/Motor temp", 112, profile, limits), value: 112, profile, limits };
  assert.match(alertLine([fault, high]).text, /^Earth Fault · IMD_State   ·   Motor temp 112/);
  assert.match(alertLine([high]).text, /above 110$/);
  assert.equal(alertLine([fault, high]).severity, "critical");
  assert.equal(alertLine([{ ...high, tile: tileState("/Motor temp", 90, profile, limits) }]).text, "");
});

test("warning-only alerts remain amber and unknown live fields do not alert", () => {
  const warning = tileState("/IMD_State", 5, profile, {}, definition);
  assert.equal(alertLine([{ tile: warning, value: 5, profile, fault: true }]).severity, "warn");
  assert.equal(alertLine([{ tile: warning, value: 5, profile, fault: true }]).text, "Ground Fault Warning · IMD_State");
  const summary = { backend: "connected" as const, hasFreshData: false, backendDetail: "", viewedRun: 0, runCount: 1 };
  assert.equal(
    tileState("/IMD_State", 4, profile, {}, definition, { summary, freshness: "unknown", age: null }).severity,
    "ok"
  );
});

test("removed tiles stop contributing limits and active subscriptions", () => {
  const source = { type: "tile", logKey: "/Motor temp", logType: "Number", visible: true, options: {} };
  const sourceList = Object.assign(Object.create(SourceList.prototype), { state: [source] });
  const controller: TracksideController = Object.assign(Object.create(TracksideController.prototype), {
    sourceList,
    alertConfig: [],
    limits: { "/Motor temp": { high: 110 }, "/removed": { high: 0 } }
  });
  const [configured] = controller.getAlertConfiguration();
  assert.equal(configured.key, "/Motor temp");
  assert.equal(configured.high, 110);
  assert.deepEqual(controller.getActiveFields(), ["/Motor temp"]);
  sourceList.state = [];
  assert.deepEqual(controller.getAlertConfiguration(), []);
  assert.deepEqual(controller.getActiveFields(), []);
});

test("healthy live tiles have no status dot and keep alarm text", () => {
  const summary = { backend: "connected" as const, hasFreshData: true, backendDetail: "", viewedRun: 0, runCount: 1 };
  const live = { summary, freshness: "online" as const, age: 0.1 };
  assert.equal(tileState("/Motor temp", 90, profile, { high: 110 }, null, live).state, "");
  assert.equal(tileState("/Motor temp", 112, profile, { high: 110 }, null, live).state, "Alarm");
});

test("latest live runs retain status after disconnect and across reconnects", () => {
  const summary = { backend: "error" as const, hasFreshData: false, backendDetail: "", viewedRun: 0, runCount: 1 };
  assert.equal(isTracksideLive(summary, null, 100), true);
  const tile = tileState(
    "/Motor temp",
    112,
    profile,
    { high: 110 },
    null,
    isTracksideLive(summary, null, 100) ? { summary, freshness: "offline", age: 1 } : undefined
  );
  assert.equal(tile.severity, "ok");
  assert.equal(tile.state, "⊘ link lost");
  assert.equal(tile.freshness, "offline");
  assert.equal(alertLine([{ tile, value: 112, profile, limits: { high: 110 } }]).text, "");
  const connected = { ...summary, backend: "connected" as const, hasFreshData: true };
  assert.equal(isTracksideLive(connected, 100, 100), true);
  assert.equal(isTracksideLive(connected, 100, 90), false);
  assert.equal(isTracksideLive(connected, 100), true);
  assert.equal(isTracksideLive({ ...connected, runCount: 2 }, null), false);
  assert.equal(isTracksideLive({ ...connected, runCount: 2, viewedRun: 1 }, null), true);
  assert.equal(isTracksideLive(undefined, null, 100), false);
});

test("tile reorder uses insertion boundaries and retains hidden entries and source configuration", () => {
  const sources = ["a", "hidden", "b", "c", "d"].map((logKey) => ({
    type: "tile",
    logKey,
    logType: "Number",
    visible: logKey !== "hidden",
    options: { unit: "original" }
  }));
  const keys = (state: typeof sources) => state.map((source) => source.logKey);
  const moved = reorderTiles(sources, 3, 0);
  assert.deepEqual(keys(moved), ["d", "a", "hidden", "b", "c"]);
  assert.equal(moved[0], sources[4]);
  assert.deepEqual(keys(reorderTiles(sources, 0, 4)), ["hidden", "b", "c", "d", "a"]);
  assert.deepEqual(keys(reorderTiles(sources, 1, 3)), ["a", "hidden", "c", "b", "d"]);
  for (const [from, to] of [
    [1, 1],
    [1, 2],
    [-1, 0],
    [4, 0],
    [0, 5]
  ]) {
    assert.deepEqual(reorderTiles(sources, from, to), sources);
  }
  assert.deepEqual(reorderTiles([], 0, 0), []);
  const beforeHidden = ["a", "b", "hidden", "c"].map((logKey) => ({
    ...sources[0],
    logKey,
    visible: logKey !== "hidden"
  }));
  assert.deepEqual(reorderTiles(beforeHidden, 1, 1), beforeHidden);
  assert.deepEqual(reorderTiles(beforeHidden, 1, 2), beforeHidden);
  assert.deepEqual(keys(sources), ["a", "hidden", "b", "c", "d"]);
});

test("graph sources opt in independently of tile visibility and use stock styles", () => {
  const sources = ["Number", "Boolean", "String", "Number"].map((logType, index) => ({
    type: "tile",
    logKey: String(index),
    logType,
    visible: false,
    options: index < 3 ? { showInGraph: "true" } : {}
  }));
  const result = tracksideGraphSources(sources);
  assert.deepEqual(
    result.leftSources.map((s) => s.logKey),
    ["0"]
  );
  assert.deepEqual(
    result.discreteSources.map((s) => s.logKey),
    ["1", "2"]
  );
  assert.equal(result.leftSources[0].type, "stepped");
  assert.equal(result.leftSources[0].options.size, "normal");
  assert.equal(result.leftSources[0].visible, true);
  assert.equal(sources[0].visible, false);
  assert.deepEqual(tracksideGraphSources([sources[3]]), { leftSources: [], discreteSources: [] });
});

test("Trackside saves and restores graph toggles alongside tile options", () => {
  let sources = [{ type: "tile", logKey: "/temp", logType: "Number", visible: true, options: { showInGraph: "true" } }];
  const controller: TracksideController = Object.assign(Object.create(TracksideController.prototype), {
    sourceList: {
      getState: () => sources,
      setState: (state: typeof sources) => {
        sources = state;
      }
    },
    limits: {}
  });
  const saved = JSON.parse(JSON.stringify(controller.saveState()));
  sources = [];
  controller.restoreState(saved);
  assert.equal(sources[0].options.showInGraph, "true");
  assert.equal(tracksideGraphSources(sources).leftSources.length, 1);
  assert.equal(reorderTiles(sources, 0, 1)[0].options.showInGraph, "true");
});

test("graph opt-in rejects false and missing options without changing the source list", () => {
  const sources = [undefined, "false", "true"].map((showInGraph, index) => ({
    type: "tile",
    logKey: String(index),
    logType: "Number",
    visible: true,
    options: showInGraph === undefined ? {} : { showInGraph }
  }));
  const before = structuredClone(sources);
  assert.deepEqual(
    tracksideGraphSources(sources).leftSources.map((source) => source.logKey),
    ["2"]
  );
  assert.deepEqual(sources, before);
  assert.deepEqual(tracksideGraphSources([]), { leftSources: [], discreteSources: [] });
});

test("tile drops keep graph opt-ins attached to their fields and retain hidden rows", () => {
  const sources = ["a", "hidden", "b"].map((logKey) => ({
    type: "tile",
    logKey,
    logType: "Number",
    visible: logKey !== "hidden",
    options: { showInGraph: logKey === "b" ? "false" : "true" }
  }));
  const moved = reorderTiles(sources, 0, 2);
  assert.deepEqual(
    moved.map((source) => source.logKey),
    ["hidden", "b", "a"]
  );
  assert.deepEqual(
    tracksideGraphSources(moved).leftSources.map((source) => source.logKey),
    ["hidden", "a"]
  );
  assert.deepEqual(
    sources.map((source) => source.logKey),
    ["a", "hidden", "b"]
  );
});

test("single critical limit edits preserve the opposite limit and validate ordering", () => {
  for (const value of [Number.MIN_VALUE, Number.MAX_VALUE, 1e-7, 1e303, -Number.MIN_VALUE, -Number.MAX_VALUE]) {
    assert.deepEqual(parseCriticalLimit("low", String(value), [null, null]), { range: [value, null] });
    assert.deepEqual(parseCriticalLimit("high", String(value), [null, null]), { range: [null, value] });
    assert.deepEqual(parseCriticalLimit("low", "", [null, value]), { range: [null, value] });
    assert.deepEqual(parseCriticalLimit("high", "", [value, null]), { range: [value, null] });
  }
  assert.deepEqual(parseCriticalLimit("low", "0", [null, 1]), { range: [0, 1] });
  assert.deepEqual(parseCriticalLimit("high", "1", [0, null]), { range: [0, 1] });
  assert.ok("error" in parseCriticalLimit("low", "1", [null, 1]));
  assert.ok("error" in parseCriticalLimit("high", "0", [0, null]));
  assert.ok("error" in parseCriticalLimit("high", "invalid", [0, null]));
});

test("single critical limits clear independently and reject invalid values on either side", () => {
  assert.deepEqual(parseCriticalLimit("low", " ", [-5, 90]), { range: [null, 90] });
  assert.deepEqual(parseCriticalLimit("high", "", [-5, 90]), { range: [-5, null] });
  for (const side of ["low", "high"] as const) {
    for (const text of ["invalid", "-", "1e999", "NaN", "Infinity"]) {
      assert.deepEqual(parseCriticalLimit(side, text, [null, null]), {
        error: "Enter a number, or leave the box blank."
      });
    }
  }
  assert.ok("error" in parseCriticalLimit("low", "91", [null, 90]));
  assert.ok("error" in parseCriticalLimit("high", "-6", [-5, null]));
});

test("single critical edits drive tile alarms and clearing restores a healthy tile", () => {
  for (const [side, text] of [
    ["low", "100"],
    ["high", "0"]
  ] as const) {
    const result = parseCriticalLimit(side, text, [null, null]);
    assert.ok("range" in result);
    const limits = { low: result.range[0] ?? undefined, high: result.range[1] ?? undefined };
    assert.equal(tileState("/Motor temp", 50, profile, limits).severity, "critical");
    const cleared = parseCriticalLimit(side, "", result.range);
    assert.ok("range" in cleared);
    assert.deepEqual(cleared.range, [null, null]);
    assert.equal(
      tileState("/Motor temp", 50, profile, {
        low: cleared.range[0] ?? undefined,
        high: cleared.range[1] ?? undefined
      }).severity,
      "ok"
    );
  }
});

test("trackside sends only changed cells and can replay the merged snapshot", () => {
  const tile = (text: string) => ({
    label: "Speed",
    text,
    unit: "km/h",
    state: "",
    severity: "ok" as const,
    freshness: "online" as const
  });
  const previous = { tiles: [tile("30"), tile("45")], graph: null, message: "Offline" };
  const next = { tiles: [tile("30"), tile("47")], graph: null, message: "" };
  const patch = diffTrackside(previous, next);
  assert.deepEqual(patch, { tiles: [[1, next.tiles[1]]], message: "" });
  const cached = applyTracksidePatch(previous, patch);
  assert.equal(cached.tiles[0], previous.tiles[0]);
  assert.deepEqual(cached, next);
  assert.deepEqual(diffTrackside(cached, next), { tiles: [] });
});

test("standing alerts reuse their value and label until the sample, freshness or configuration changes", () => {
  const before = { window: globalThis.window, document: globalThis.document };
  const log = new Log();
  log.putNumber("/temp", 0, 112);
  const element = { hidden: true, textContent: "", title: "", dataset: {} } as any;
  const classes = new Set<string>();
  let reads = 0;
  const field = log.getField("/temp")!;
  const getRange = field.getRange.bind(field);
  field.getRange = (...args) => {
    reads++;
    return getRange(...args);
  };
  let time = 1;
  let freshness = "online";
  globalThis.window = {
    log,
    selection: { getCurrentLiveTime: () => time },
    liveStatus: {
      getLiveStatus: () => ({ backend: "connected", hasFreshData: true, viewedRun: 0, runCount: 1 }),
      getFieldFreshness: () => freshness
    }
  } as any;
  globalThis.document = {
    body: {
      classList: {
        contains: (name: string) => classes.has(name),
        toggle: (name: string, set: boolean) => (set ? classes.add(name) : classes.delete(name))
      }
    }
  } as any;
  try {
    const config = [[{ key: "/temp", dbcSignal: "Inverter temp", high: 100 }]];
    updateTracksideAlerts(element, config);
    assert.match(element.textContent, /Inverter temp .*above 100/);
    time = 2;
    updateTracksideAlerts(element, config);
    assert.equal(reads, 1);
    freshness = "offline";
    updateTracksideAlerts(element, config);
    assert.equal(element.hidden, true);
    freshness = "online";
    updateTracksideAlerts(element, config);
    assert.equal(element.hidden, false);
    assert.equal(reads, 1);
    log.putNumber("/temp", 2.1, 50);
    time = 3;
    updateTracksideAlerts(element, config);
    assert.equal(element.hidden, true);
    updateTracksideAlerts(element, [[{ key: "/temp", dbcSignal: "Renamed temp", high: 40 }]]);
    assert.match(element.textContent, /Renamed temp .*above 40/);
  } finally {
    Object.assign(globalThis, before);
  }
});
