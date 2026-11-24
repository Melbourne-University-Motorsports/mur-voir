// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import {
  clipGaps,
  findGaps,
  gapThreshold,
  isUnresumed,
  PeriodStats,
  prepareTrace,
  TraceGapCache
} from "../src/shared/TraceGaps";

import Log from "../src/shared/log/Log";

const resumed = { t0: 0.2, v0: 2, t1: 5, v1: 5 };
test("threshold is strictly greater than max(2 seconds, ten median periods)", () => {
  assert.equal(gapThreshold(0.02), 2);
  assert.equal(gapThreshold(0.2), 2);
  assert.equal(gapThreshold(1), 10);
  assert.deepEqual(findGaps([0, 2], [1, 2], 2, 2), []);
  assert.equal(findGaps([0, 2.01], [1, 2], 2, 2.01).length, 1);
});
test("exact whole-log median is cached and updates for appended samples", () => {
  const stats = new PeriodStats();
  stats.update([0, 0.25, 0.5, 0.75, 5]);
  assert.equal(stats.median(), 0.25);
  stats.update([0, 0.25, 0.5, 0.75, 5]);
  assert.equal(stats.median(), 0.25);
  stats.update([0, 0.25, 0.5, 0.75, 5, 5.25, 5.5]);
  assert.equal(stats.median(), 0.25);
});
test("even median averages the middle periods; cutoff is exact", () => {
  const stats = new PeriodStats();
  stats.update([0, 2, 4.002]);
  assert.ok(stats.median()! > 2);
  assert.equal(gapThreshold(stats.median()), null);
});
test("period cache resets after truncation, replacement and inserted history", () => {
  const stats = new PeriodStats();
  stats.update([0, 0.1, 0.2]);
  stats.update([0, 0.05, 0.1, 0.2]);
  assert.equal(stats.median(), 0.05);
  stats.update([10, 12]);
  assert.equal(stats.median(), 2);
  stats.update([10]);
  assert.equal(stats.median(), null);
});
test("on-change fields opt out; a new field uses the minimum threshold", () => {
  assert.equal(gapThreshold(2.1), null);
  assert.equal(gapThreshold(null), 2);
  assert.ok(isUnresumed(findGaps([0], [2], gapThreshold(null)!, 0.1, true)));
});
test("zoom inside a gap keeps whole-log threshold and real bridge endpoints", () => {
  const stats = new PeriodStats();
  stats.update([0, 0.1, 0.2, 5, 5.1]);
  const gaps = findGaps([0, 0.1, 0.2, 5, 5.1], [0, 1, 2, 5, 6], gapThreshold(stats.median())!, 5.1);
  assert.deepEqual(gaps, [resumed]);
  assert.deepEqual(prepareTrace([1, 5], [2, 5], gaps), { timestamps: [5], values: [5], gapAfter: [false] });
});
test("NaN runs bridge nearest valid samples even below threshold", () => {
  assert.deepEqual(findGaps([0, 0.1, 0.2, 0.3], [1, NaN, NaN, 4], 1, 0.3), [{ t0: 0, v0: 1, t1: 0.3, v1: 4 }]);
  assert.deepEqual(findGaps([0, 0.1], [NaN, NaN], 1, 5), []);
});
test("solid segments split at gaps without a flat hold", () => {
  assert.deepEqual(prepareTrace([0, 0.1, 0.2, 1, 5, 5.1], [0, 1, 2, NaN, 5, 6], [resumed]), {
    timestamps: [0, 0.1, 0.2, 5, 5.1],
    values: [0, 1, 2, 5, 6],
    gapAfter: [false, false, true, false, false]
  });
});
test("normal streaming holds until threshold; stale/offline stops immediately", () => {
  assert.deepEqual(findGaps([0, 0.1], [1, 2], 1, 1.1), []);
  assert.ok(isUnresumed(findGaps([0, 0.1], [1, 2], 1, 0.2, true)));
  assert.ok(isUnresumed(findGaps([0, 0.1], [1, 2], 1, 1.11)));
});
test("unresumed and trailing NaN gaps have no finite bridge destination", () => {
  const gaps = findGaps([0, 0.1, 0.2], [1, 2, NaN], 1, 0.3);
  assert.ok(isUnresumed(gaps));
  assert.equal(gaps[0].t1, Infinity);
  assert.deepEqual(prepareTrace([0.1, 4], [2, 2], gaps).timestamps, [0.1]);
});
test("lap-time and distance map bridge endpoints and clip both lap boundaries", () => {
  const gap = { t0: 10, v0: 0, t1: 20, v1: 10 };
  assert.deepEqual(
    clipGaps([gap], 12, 18, (t) => t),
    [{ t0: 0, v0: 2, t1: 6, v1: 8 }]
  );
  assert.deepEqual(
    clipGaps([gap], 12, 18, (t) => t * 5),
    [{ t0: 0, v0: 2, t1: 30, v1: 8 }]
  );
  assert.deepEqual(
    clipGaps([gap], 21, 30, (t) => t),
    []
  );
});
test("unresumed gaps stay unresumed in lap coordinates", () => {
  const gaps = findGaps([10, 10.1], [1, 2], 1, 20);
  assert.ok(isUnresumed(clipGaps(gaps, 10, 15, (t) => t * 2)));
});

test("the median follows interleaved additions and expiry with many distinct exact periods", () => {
  const stats = new PeriodStats();
  const periods: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const period = ((i * 7919) % 1409) / 713 + 0.002;
    stats.changePeriod(period, 1);
    periods.push(period);
    if (periods.length > 501) stats.changePeriod(periods.shift()!, -1);
    const sorted = [...periods].sort((a, b) => a - b);
    assert.equal(
      stats.median(),
      (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    );
  }
  for (const period of periods) stats.changePeriod(period, -1);
  assert.equal(stats.median(), null);
});

test("repeated arrivals keep a held trace fresh and anchor gaps at actual sample times", () => {
  const log = new Log();
  const key = "pedal";
  const gaps = new TraceGapCache();
  for (let time = 0; time <= 300; time++) log.putNumber(key, time, 0, true);
  assert.deepEqual(log.getNumber(key, 0, 300)?.timestamps, [0]);
  assert.deepEqual(gaps.update(log, key, 300.1), []);

  const stopped = gaps.update(log, key, 301, true)!;
  assert.equal(stopped[0].t0, 300);
  assert.ok(isUnresumed(stopped));
  assert.deepEqual(prepareTrace([0], [0], stopped).timestamps, [0, 300]);

  log.putNumber(key, 315, 0, true);
  const resumed = gaps.update(log, key, 315)!;
  const data = prepareTrace([0], [0], resumed);
  assert.deepEqual(data.timestamps, [0, 300, 315]);
  assert.deepEqual(data.values, [0, 0, 0]);
  assert.deepEqual(data.gapAfter, [false, true, false]);

  for (let time = 301; time < 315; time++) log.putNumber(key, time, 0, true);
  assert.deepEqual(gaps.update(log, key, 315), []);
  log.clearBeforeTime(316);
  assert.equal(gaps.update(log, key, 318, true)?.[0].t0, 315);
  assert.equal(log.getField(key)?.getNumberArrivals()?.field.getTimestampCount(), 1);
});
