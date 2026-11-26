// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cellSlot, cellsRange, classifyCell, fitCellAxis } from "../src/shared/Cells";

test("cell axis fits the data with at least 200 mV of span and headroom at both ends", () => {
  const [low, high] = fitCellAxis([3.912, 3.941], 0.2);
  assert.ok(Math.abs(high - low - 0.2) < 1e-12);
  assert.ok(low < 3.912 && high > 3.941);
  const [wideLow, wideHigh] = fitCellAxis([3.09, 4.275], 0.2);
  assert.ok(wideLow < 3.09 && wideHigh > 4.275);
  const options = { segmentSize: 18, lockedRange: [3.5, 4] as [number, number] };
  assert.deepEqual(
    cellsRange({ cells: [], options, references: [{ label: "Max ref", value: 4.338 }] }, "voltages"),
    [3.5, 4]
  );
  assert.ok(
    cellsRange(
      { cells: [], options: { segmentSize: 18 }, references: [{ label: "Max ref", value: 4.338 }] },
      "voltages"
    )[1] > 4.338
  );
});

test("cell colours respect limit, deviation and stale precedence", () => {
  const options = { low: 2.5, high: 4.2, outlier: 150, segmentSize: 18 };
  const color = (value?: number, staleAge?: number) =>
    classifyCell({ number: 1, key: "cell", value, staleAge }, 4, options, "voltages");
  assert.equal(color(), "missing");
  assert.equal(color(4.1), "normal");
  assert.equal(color(3.85), "normal");
  assert.equal(color(3.849), "outlier");
  assert.equal(color(4.201), "limit");
  assert.equal(color(2.499), "limit");
  assert.equal(color(2.499, 4), "stale");
  assert.equal(
    classifyCell({ number: 1, key: "temp", value: 35 }, 29, { segmentSize: 18, outlier: 5 }, "temperatures"),
    "outlier"
  );
});

test("segment gaps repeat within each row and start over at the next row", () => {
  const slot = (index: number) => cellSlot(index, 556, 18, 8);
  assert.equal(slot(0).width, 10);
  assert.equal(slot(17).x, 170);
  assert.equal(slot(18).x, 188);
  assert.equal(slot(36).x, 376);
  assert.equal(slot(53).x + slot(53).width, 556);
  assert.deepEqual(slot(54), slot(0));
});
