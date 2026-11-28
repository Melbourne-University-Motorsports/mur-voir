// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS_PER_ROW, cellSlot, cellsRange, classifyCell, voltageColor } from "../src/shared/Cells";

test("the voltage axis stays fixed with changing samples and saved locks", () => {
  const options = { segmentSize: 18, lockedRange: [3.5, 4] as [number, number] };
  const cell = { number: 1, key: "cell" };
  for (const value of [undefined, 1.9, 3.912, 4.5]) {
    assert.deepEqual(cellsRange({ cells: [{ ...cell, value }], options }, "voltages"), [2, 4.35]);
  }
  assert.deepEqual(cellsRange({ cells: [], options }, "voltages"), [2, 4.35]);
});

test("the temperature axis still fits the data and supports a lock", () => {
  assert.deepEqual(
    cellsRange({ cells: [{ number: 1, key: "temp", value: 29 }], options: { segmentSize: 18 } }, "temperatures"),
    [28, 30]
  );
  assert.deepEqual(
    cellsRange({ cells: [], options: { segmentSize: 18, lockedRange: [25, 40] } }, "temperatures"),
    [25, 40]
  );
});

test("voltage shading uses the axis bounds and clamps readings outside them", () => {
  const [low, high] = cellsRange({ cells: [], options: { segmentSize: 18 } }, "voltages");
  assert.equal(voltageColor(low), "rgb(218 30 40)");
  assert.equal(voltageColor(low - 1), voltageColor(low));
  assert.equal(voltageColor((low + high) / 2), "rgb(241 194 27)");
  assert.equal(voltageColor(3.9), "rgb(168 217 111)");
  assert.equal(voltageColor(4), "rgb(139 205 102)");
  assert.equal(voltageColor(high), "rgb(36 161 72)");
  assert.equal(voltageColor(high + 1), voltageColor(high));
});

test("stale temperature colours take precedence over limit colours", () => {
  const options = { low: 25, high: 50, segmentSize: 18 };
  const color = (value?: number, staleAge?: number) =>
    classifyCell({ number: 1, key: "temp", value, staleAge }, options);
  assert.equal(color(), "missing");
  assert.equal(color(25), "normal");
  assert.equal(color(50), "normal");
  assert.equal(color(51), "limit");
  assert.equal(color(24), "limit");
  assert.equal(color(24, 4), "stale");
});

test("segment gaps repeat within each row and start over at the next row", () => {
  assert.equal(CELLS_PER_ROW, 36);
  const width = 368;
  const slot = (index: number) => cellSlot(index, width, 18, 8);
  assert.equal(slot(0).width, 10);
  assert.equal(slot(17).x, 170);
  assert.equal(slot(18).x, 188);
  assert.equal(slot(35).x + slot(35).width, width);
  assert.deepEqual(slot(36), slot(0));
  assert.deepEqual(slot(72), slot(0));
  assert.deepEqual(slot(107), slot(35));
});
