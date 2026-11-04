// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudCache, cloudRange, cloudWindow } from "../../src/shared/spatial/CloudWindow";
test("scan selection is independent of forward, backward and playback history", () => {
  const stamps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const history = { getTimestampCount: () => stamps.length, getTimestamp: (i: number) => stamps[i] };
  for (const route of [
    [0, 10, 5],
    [10, 5],
    [0, 1, 2, 3, 4, 5]
  ]) {
    let result: number[] = [];
    for (const t of route) result = cloudWindow(history, t, 3);
    assert.deepEqual(result, [3, 4, 5]);
  }
  assert.deepEqual(cloudWindow(history, -1, 10), []);
  assert.deepEqual(cloudWindow(history, 5.1, 1), [5]);
});
test("one scalar range is applied across every scan", () => {
  const scans = [
    { min: 0, max: 10 },
    { min: -10, max: 30 }
  ];
  assert.deepEqual(cloudRange(scans), { min: -10, max: 30 });
});
test("byte LRU preserves current windows across layers and rejects over-budget inserts", () => {
  const cache = new CloudCache(32),
    a = {},
    b = {};
  const value = { positions: new Float32Array(4) };
  cache.set("old", value);
  cache.set("a", value);
  cache.protect(a, ["a"]);
  cache.protect(b, ["b"]);
  assert.equal(cache.set("b", value), true);
  assert.equal(cache.get("old"), undefined);
  assert.equal(cache.bytes, 32);
  assert.equal(cache.set("c", value), false);
});
