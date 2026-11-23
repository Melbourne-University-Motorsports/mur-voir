// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import DecimatedSeries from "../../src/shared/log/DecimatedSeries";
import Log from "../../src/shared/log/Log";
import LogField from "../../src/shared/log/LogField";
import LoggableType from "../../src/shared/log/LoggableType";

const KEY = "/speed";
const value = (i: number) => (i % 97 === 0 ? NaN : Math.sin(i / 50) * 100 + (i % 7));

function fill(log: Log, from: number, to: number) {
  for (let i = from; i < to; i++) log.putNumber(KEY, i / 50, value(i));
}

test("short ranges are not reduced", () => {
  const log = new Log();
  fill(log, 0, 1000);
  assert.equal(new DecimatedSeries().get(log, KEY, 0, 20), null);
});

test("a live series extended in steps matches one reduced at once, and keeps each bucket's extremes", () => {
  const live = new Log();
  const series = new DecimatedSeries();
  for (let end = 6000; end <= 12000; end += 37) {
    fill(live, end === 6000 ? 0 : end - 37, end);
    series.get(live, KEY, 0, 250);
  }
  const whole = new Log();
  fill(whole, 0, 12000 - ((12000 - 6000) % 37));
  const fresh = new DecimatedSeries().get(whole, KEY, 0, 250)!;
  const incremental = series.get(live, KEY, 0, 250)!;
  assert.deepEqual(incremental, fresh);
  assert.ok(fresh.timestamps.length < 6000);

  // Every bucket's lowest and highest raw value is present, and so is every gap
  const raw = whole.getNumber(KEY, -Infinity, Infinity)!;
  const bucket = 2 ** Math.ceil(Math.log2(250 / 1024));
  const kept = new Map<number, number[]>();
  fresh.timestamps.forEach((t, i) => {
    const values = kept.get(Math.floor(t / bucket)) ?? [];
    values.push(fresh.values[i]);
    kept.set(Math.floor(t / bucket), values);
  });
  const extremes = new Map<number, { min: number; max: number; nan: boolean }>();
  raw.timestamps.forEach((t, i) => {
    const index = Math.floor(t / bucket);
    const entry = extremes.get(index) ?? { min: Infinity, max: -Infinity, nan: false };
    const v = raw.values[i];
    if (Number.isNaN(v)) entry.nan = true;
    else {
      entry.min = Math.min(entry.min, v);
      entry.max = Math.max(entry.max, v);
    }
    extremes.set(index, entry);
  });
  extremes.forEach((entry, index) => {
    const values = kept.get(index)!;
    if (entry.min !== Infinity) assert.ok(values.includes(entry.min) && values.includes(entry.max), "bucket " + index);
    assert.equal(values.some(Number.isNaN), entry.nan, "gap in bucket " + index);
  });
  assert.deepEqual(
    fresh.timestamps,
    [...fresh.timestamps].sort((a, b) => a - b)
  );
});

test("inserted history rebuilds the reduction", () => {
  const log = new Log();
  fill(log, 0, 3000);
  fill(log, 5000, 12000);
  const series = new DecimatedSeries();
  const before = series.get(log, KEY, 0, 250)!;
  fill(log, 3000, 5000); // The gap fills in behind the newest data
  const after = series.get(log, KEY, 0, 250)!;
  const whole = new Log();
  fill(whole, 0, 12000);
  assert.ok(after.timestamps.length > before.timestamps.length);
  assert.deepEqual(after, new DecimatedSeries().get(whole, KEY, 0, 250));
});

test("reduction returns the raw samples bracketing both viewport edges", () => {
  const log = new Log();
  for (let i = 0; i <= 5020; i++) log.putNumber(KEY, i / 100, i % 11);
  const start = 0.105;
  const end = 50.135;
  const result = new DecimatedSeries().get(log, KEY, start, end)!;
  const raw = log.getNumber(KEY, start, end)!;
  assert.deepEqual(result.timestamps.slice(0, 2), raw.timestamps.slice(0, 2));
  assert.deepEqual(result.values.slice(0, 2), raw.values.slice(0, 2));
  assert.deepEqual(result.timestamps.slice(-2), raw.timestamps.slice(-2));
  assert.deepEqual(result.values.slice(-2), raw.values.slice(-2));
  assert.ok(result.timestamps.slice(1, -1).every((t) => t > start && t < end));
});

test("recreating a field with the same sample count invalidates the reduction", () => {
  const log = new Log();
  fill(log, 0, 5000);
  const series = new DecimatedSeries();
  assert.ok(series.get(log, KEY, 0, 99)?.values.some((v) => v < 1000));
  log.deleteField(KEY);
  const field = new LogField(LoggableType.Number);
  for (let i = 0; i < 5000; i++) field.putNumber(i / 50, 1000 + i);
  log.setField(KEY, field);
  assert.ok(series.get(log, KEY, 0, 99)?.values.every((v) => v >= 1000));
});
