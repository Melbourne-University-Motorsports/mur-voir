// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldMatches, filterFieldTree, isFilterActive, type FieldFilterContext } from "../src/shared/log/FieldFilter";
import type LogFieldTree from "../src/shared/log/LogFieldTree";

/** Builds a tree the way Log.getFieldTree does, rooted below "/". */
function tree(keys: string[]): { [id: string]: LogFieldTree } {
  const root: { [id: string]: LogFieldTree } = {};
  keys.forEach((key) => {
    let position: LogFieldTree = { fullKey: null, children: root };
    key
      .slice(1)
      .split("/")
      .forEach((name) => {
        if (!(name in position.children)) position.children[name] = { fullKey: null, children: {} };
        position = position.children[name];
      });
    position.fullKey = key;
  });
  return root;
}

const keys = [
  "/vehicles/mur27/can0/inverter/motor_temp",
  "/vehicles/mur27/can0/inverter/dc_bus_voltage",
  "/vehicles/mur27/can1/pedals/throttle",
  "/vehicles/mur27/bms/pack_soc",
  "/vehicles/mur27/bms/cell_max_temp",
  "/vehicles/mur27/.schema/ignored_temp"
];
const freshness: { [key: string]: string } = {
  "/vehicles/mur27/can0/inverter/motor_temp": "online",
  "/vehicles/mur27/can0/inverter/dc_bus_voltage": "stale",
  "/vehicles/mur27/can1/pedals/throttle": "online",
  "/vehicles/mur27/bms/pack_soc": "offline",
  "/vehicles/mur27/bms/cell_max_temp": "unknown"
};
const context: FieldFilterContext = {
  freshness: (key) => freshness[key] ?? null,
  aliases: (key) => (key.endsWith("throttle") ? ["APPS", "Pedal_Throttle_Pct"] : []),
  hiddenKeys: [".schema"]
};

test("an empty query with All filters nothing", () => {
  assert.equal(isFilterActive({ query: "  ", live: "all" }), false);
  assert.equal(isFilterActive({ query: "x", live: "all" }), true);
  assert.equal(isFilterActive({ query: "", live: "not-live" }), true);
});

test("text matches the full path case-insensitively, plus display labels and DBC signal names", () => {
  const filter = (query: string) => ({ query: query, live: "all" as const });
  assert.equal(fieldMatches("/vehicles/mur27/can0/inverter/motor_temp", filter("MOTOR_t"), context), true);
  assert.equal(fieldMatches("/vehicles/mur27/can0/inverter/motor_temp", filter("can0/inv"), context), true);
  assert.equal(fieldMatches("/vehicles/mur27/can1/pedals/throttle", filter("apps"), context), true);
  assert.equal(fieldMatches("/vehicles/mur27/can1/pedals/throttle", filter("pedal_throttle_pct"), context), true);
  assert.equal(fieldMatches("/vehicles/mur27/bms/pack_soc", filter("apps"), context), false);

  const result = filterFieldTree(tree(keys), filter("temp"), context);
  assert.equal(result.matchCount, 2);
  assert.deepEqual(
    [...result.matches].sort(),
    ["/vehicles/mur27/bms/cell_max_temp", "/vehicles/mur27/can0/inverter/motor_temp"],
    "hidden keys never match"
  );
});

test("Live keeps fresh fields; Not live keeps every other catalogued field", () => {
  const live = filterFieldTree(tree(keys), { query: "", live: "live" }, context);
  assert.deepEqual([...live.matches].sort(), [
    "/vehicles/mur27/can0/inverter/motor_temp",
    "/vehicles/mur27/can1/pedals/throttle"
  ]);

  const notLive = filterFieldTree(
    tree([...keys, "/vehicles/mur27/derived/lap"]),
    { query: "", live: "not-live" },
    context
  );
  assert.deepEqual(
    [...notLive.matches].sort(),
    [
      "/vehicles/mur27/bms/cell_max_temp",
      "/vehicles/mur27/bms/pack_soc",
      "/vehicles/mur27/can0/inverter/dc_bus_voltage"
    ],
    "stale, offline and never-received fields; fields the live source does not catalogue are in neither"
  );
});

test("text and live state combine with AND", () => {
  const result = filterFieldTree(tree(keys), { query: "temp", live: "not-live" }, context);
  assert.deepEqual([...result.matches], ["/vehicles/mur27/bms/cell_max_temp"]);
  assert.equal(result.matchCount, 1);
});

test("folders show and expand only when a descendant matches", () => {
  const result = filterFieldTree(tree(keys), { query: "throttle", live: "all" }, context);
  assert.deepEqual([...result.visible].sort(), [
    "/vehicles",
    "/vehicles/mur27",
    "/vehicles/mur27/can1",
    "/vehicles/mur27/can1/pedals",
    "/vehicles/mur27/can1/pedals/throttle"
  ]);
  assert.deepEqual([...result.expand].sort(), [
    "/vehicles",
    "/vehicles/mur27",
    "/vehicles/mur27/can1",
    "/vehicles/mur27/can1/pedals"
  ]);
});

test("children of a matching field stay visible, and generated ones are not counted", () => {
  const structTree = tree(["/odometry", "/odometry/x", "/odometry/y", "/other"]);
  const result = filterFieldTree(
    structTree,
    { query: "odometry", live: "all" },
    { freshness: () => null, isGenerated: (key) => key !== "/odometry" && key !== "/other" }
  );
  assert.deepEqual([...result.visible].sort(), ["/odometry", "/odometry/x", "/odometry/y"]);
  assert.equal(result.matchCount, 1);
});

test("nothing matching leaves an empty tree", () => {
  const result = filterFieldTree(tree(keys), { query: "no such field", live: "all" }, context);
  assert.equal(result.matchCount, 0);
  assert.equal(result.visible.size, 0);
  assert.equal(result.expand.size, 0);
});

test("the signature changes only when the shown tree changes", () => {
  const before = filterFieldTree(tree(keys), { query: "", live: "live" }, context);
  const same = filterFieldTree(tree(keys), { query: "", live: "live" }, context);
  assert.equal(before.signature, same.signature);
  freshness["/vehicles/mur27/bms/pack_soc"] = "online";
  const after = filterFieldTree(tree(keys), { query: "", live: "live" }, context);
  freshness["/vehicles/mur27/bms/pack_soc"] = "offline";
  assert.notEqual(before.signature, after.signature);
});
