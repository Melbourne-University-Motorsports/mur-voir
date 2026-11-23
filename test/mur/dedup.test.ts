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
    assert.equal(dedup.accept(PATH, "s1", seq), true, "rf copy " + seq);
    assert.equal(dedup.accept(PATH, "s1", seq), false, "cellular copy " + seq);
  }
});

test("the same seq on a different stream or path is not a duplicate", () => {
  const dedup = new SampleDeduplicator();
  assert.equal(dedup.accept(PATH, "s1", 5), true);
  assert.equal(dedup.accept(PATH, "s2", 5), true);
  assert.equal(dedup.accept("vehicles/mur27/other", "s1", 5), true);
  assert.equal(dedup.accept(PATH, "s1", 5), false);
});

test("seq gaps (drops, throttling) and out-of-order samples within the window are accepted", () => {
  const dedup = new SampleDeduplicator();
  assert.equal(dedup.accept(PATH, "s1", 10), true);
  assert.equal(dedup.accept(PATH, "s1", 13), true);
  assert.equal(dedup.accept(PATH, "s1", 11), true);
  assert.equal(dedup.accept(PATH, "s1", 11), false);
  assert.equal(dedup.accept(PATH, "s1", 13), false);
});

test("history overlapping live data only adds the missing older samples", () => {
  const dedup = new SampleDeduplicator();
  // Live subscription started at seq 1000 (throttled: every 2nd sample)
  for (let seq = 1000; seq <= 1100; seq += 2) dedup.accept(PATH, "s1", seq);

  // History returns every sample from 0 to 1050
  const history = [];
  for (let seq = 0; seq <= 1050; seq++) history.push({ stream_id: "s1", seq: seq });
  const accepted = dedup.filterHistory(PATH, history);

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
  assert.equal(dedup.filterHistory(PATH, history).length, 0);
});

test("old duplicates far behind the newest seq are still rejected", () => {
  const dedup = new SampleDeduplicator();
  for (let seq = 0; seq < 12288; seq++) dedup.accept(PATH, "s1", seq);
  assert.equal(dedup.accept(PATH, "s1", 5), false);
  assert.equal(dedup.accept(PATH, "s1", 12287), false);
  assert.equal(dedup.accept(PATH, "s1", 12288), true);
});

test("history fills a gap in the middle, far behind the newest seq", () => {
  const dedup = new SampleDeduplicator();
  // Streamed, hidden for a while (not subscribed), then streamed again for longer than any window
  for (let seq = 0; seq < 1000; seq++) dedup.accept(PATH, "s1", seq);
  for (let seq = 7000; seq < 20000; seq++) dedup.accept(PATH, "s1", seq);
  const history = [];
  for (let seq = 990; seq <= 7010; seq++) history.push({ stream_id: "s1", seq: seq });
  const accepted = dedup.filterHistory(PATH, history).map((sample) => sample.seq);
  assert.equal(accepted.length, 6000);
  assert.equal(accepted[0], 1000);
  assert.equal(accepted[accepted.length - 1], 6999);
  // The gap is now closed: nothing is accepted twice
  assert.equal(dedup.filterHistory(PATH, history).length, 0);
  assert.equal(dedup.accept(PATH, "s1", 3500), false);
});

test("clear forgets all streams", () => {
  const dedup = new SampleDeduplicator();
  dedup.accept(PATH, "s1", 0);
  dedup.clear();
  assert.equal(dedup.accept(PATH, "s1", 0), true);
});

test("a throttled stream past the run limit still rejects duplicates and fills recent gaps", () => {
  const dedup = new SampleDeduplicator();
  // Every second seq, so each sample starts its own run
  for (let seq = 0; seq < 40000; seq += 2) assert.equal(dedup.accept(PATH, "s1", seq), true);
  assert.equal(dedup.accept(PATH, "s1", 39998), false);
  assert.equal(dedup.accept(PATH, "s1", 30000), false);
  assert.equal(dedup.accept(PATH, "s1", 39997), true); // A recent skipped seq from history
  assert.equal(dedup.accept(PATH, "s1", 39997), false);
  assert.equal(dedup.accept(PATH, "s1", 1), false); // Merged into the oldest run: treated as seen
});
