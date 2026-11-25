// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SampleDeduplicator } from "../../src/hub/dataSources/mur/MURDedup.ts";

const PATH = "vehicles/mur27/dynamics/vehicle_speed";

test("RF and cellular copies of the same (path, stream_id, seq) are accepted once", () => {
  const dedup = new SampleDeduplicator();
  for (let seq = 0; seq < 100; seq++) {
    assert.equal(dedup.accept(PATH, "s1", seq, seq / 100), true, "rf copy " + seq);
    assert.equal(dedup.accept(PATH, "s1", seq, seq / 100), false, "cellular copy " + seq);
  }
});

test("the same seq on a different stream or path is not a duplicate", () => {
  const dedup = new SampleDeduplicator();
  assert.equal(dedup.accept(PATH, "s1", 5, 5 / 100), true);
  assert.equal(dedup.accept(PATH, "s2", 5, 5 / 100), true);
  assert.equal(dedup.accept("vehicles/mur27/other", "s1", 5, 5 / 100), true);
  assert.equal(dedup.accept(PATH, "s1", 5, 5 / 100), false);
});

test("seq gaps (drops, throttling) and out-of-order samples are accepted", () => {
  const dedup = new SampleDeduplicator();
  assert.equal(dedup.accept(PATH, "s1", 10, 10 / 100), true);
  assert.equal(dedup.accept(PATH, "s1", 13, 13 / 100), true);
  assert.equal(dedup.accept(PATH, "s1", 11, 11 / 100), true);
  assert.equal(dedup.accept(PATH, "s1", 11, 11 / 100), false);
  assert.equal(dedup.accept(PATH, "s1", 13, 13 / 100), false);
});

test("history overlapping live data only adds the missing older samples", () => {
  const dedup = new SampleDeduplicator();
  // Live subscription started at seq 1000 (throttled: every 2nd sample)
  for (let seq = 1000; seq <= 1100; seq += 2) dedup.accept(PATH, "s1", seq, seq / 100);

  // History returns every sample from 0 to 1050
  const history = [];
  for (let seq = 0; seq <= 1050; seq++) history.push({ stream_id: "s1", seq: seq });
  const accepted = history.filter(({ stream_id, seq }) => dedup.accept(PATH, stream_id, seq, seq / 100));

  const acceptedSeqs = accepted.map((sample) => sample.seq);
  // Everything before live started, plus the odd seqs live skipped, and none of the live seqs
  assert.equal(acceptedSeqs.includes(1000), false);
  assert.equal(acceptedSeqs.includes(1050), false);
  assert.equal(acceptedSeqs.includes(1001), true);
  assert.equal(acceptedSeqs.includes(0), true);
  assert.equal(acceptedSeqs.length, 1000 + 25);
  // Returned in ascending order for insertion
  assert.deepEqual(
    acceptedSeqs,
    [...acceptedSeqs].sort((a, b) => a - b)
  );

  // Fetching the same history again adds nothing
  assert.equal(history.filter(({ stream_id, seq }) => dedup.accept(PATH, stream_id, seq, seq / 100)).length, 0);
});

test("old duplicates far behind the newest seq are still rejected", () => {
  const dedup = new SampleDeduplicator();
  for (let seq = 0; seq < 12288; seq++) dedup.accept(PATH, "s1", seq, seq / 100);
  assert.equal(dedup.accept(PATH, "s1", 5, 5 / 100), false);
  assert.equal(dedup.accept(PATH, "s1", 12287, 12287 / 100), false);
  assert.equal(dedup.accept(PATH, "s1", 12288, 12288 / 100), true);
});

test("history fills a gap in the middle, far behind the newest seq", () => {
  const dedup = new SampleDeduplicator();
  // Streamed, hidden for a while (not subscribed), then streamed again
  for (let seq = 0; seq < 1000; seq++) dedup.accept(PATH, "s1", seq, seq / 100);
  for (let seq = 7000; seq < 20000; seq++) dedup.accept(PATH, "s1", seq, seq / 100);
  const history = [];
  for (let seq = 990; seq <= 7010; seq++) history.push({ stream_id: "s1", seq: seq });
  const accepted = history
    .filter(({ stream_id, seq }) => dedup.accept(PATH, stream_id, seq, seq / 100))
    .map((sample) => sample.seq);
  assert.equal(accepted.length, 6000);
  assert.equal(accepted[0], 1000);
  assert.equal(accepted[accepted.length - 1], 6999);
  // The gap is now closed: nothing is accepted twice
  assert.equal(history.filter(({ stream_id, seq }) => dedup.accept(PATH, stream_id, seq, seq / 100)).length, 0);
  assert.equal(dedup.accept(PATH, "s1", 3500, 3500 / 100), false);
});

test("clear forgets all streams", () => {
  const dedup = new SampleDeduplicator();
  dedup.accept(PATH, "s1", 0, 0 / 100);
  dedup.clear();
  assert.equal(dedup.accept(PATH, "s1", 0, 0 / 100), true);
});

test("retained backfill can fill neighbouring gaps more than 36,000 sequences behind live", () => {
  const dedup = new SampleDeduplicator();
  assert.equal(dedup.accept(PATH, "s1", 0, 0), true);
  assert.equal(dedup.accept(PATH, "s1", 40000, 800), true);
  dedup.discardBefore(30);
  assert.equal(dedup.accept(PATH, "s1", 4000, 80), true);
  assert.equal(dedup.accept(PATH, "s1", 4001, 80.02), true);
  assert.equal(dedup.accept(PATH, "s1", 4000, 80.01), false);
  assert.equal(dedup.accept(PATH, "s1", 4001, 80.02), false);
  assert.equal(dedup.accept(PATH, "s1", 0, 0), false);
});

test("discards remove old membership and apply the same time boundary to unseen samples", () => {
  const dedup = new SampleDeduplicator();
  for (let i = 0; i < 100; i++) dedup.accept(PATH, "old", i, i);
  dedup.discardBefore(100.5);
  assert.equal(dedup.accept(PATH, "old", 99, 99), false);
  assert.equal(dedup.accept(PATH, "s1", 200, 100.499), false);
  assert.equal(dedup.accept(PATH, "s1", 201, 100.5), true);
  assert.equal(dedup.accept(PATH, "s1", 201, 101), false);
  assert.equal((dedup as any).streams.size, 1);
  assert.equal((dedup as any).streams.values().next().value.size, 1);
  dedup.clear();
  assert.equal(dedup.accept(PATH, "old", 0, 0), true);
});
