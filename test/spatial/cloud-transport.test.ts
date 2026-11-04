// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudTransport } from "../../src/shared/spatial/CloudTransport";
test("satellites transmit arrays once, preserve receiver identity, and resend on reset", () => {
  const sender = new CloudTransport(),
    receiver = new CloudTransport();
  const object = {
    type: "cloud",
    id: "scan",
    positions: new Float32Array([1, 2, 3]),
    values: new Float32Array([4]),
    colors: null
  };
  const first = receiver.apply(structuredClone(sender.apply({ objects: [object] }, true)), false).objects[0];
  const delta = sender.apply({ objects: [{ ...object, min: 2 }] }, true);
  assert.equal(delta.objects[0].positions, undefined);
  assert.deepEqual(
    new CloudTransport().apply(structuredClone(delta), false).objects,
    [],
    "new satellite waits for full buffers"
  );
  const next = receiver.apply(structuredClone(delta), false).objects[0];
  assert.equal(first.positions, next.positions);
  assert.equal(next.min, 2);
  sender.clear();
  assert.equal(sender.apply({ objects: [object] }, true).objects[0].positions, object.positions);
  receiver.apply({ objects: [] }, false);
  assert.equal((receiver as any).buffers.size, 0);
});

test("receiver misses recover on a full resend and repeated IDs cannot reuse old buffers", () => {
  const sender = new CloudTransport(),
    receiver = new CloudTransport();
  let object = {
    type: "cloud",
    id: "same",
    positions: new Float32Array([1]),
    values: new Float32Array([2]),
    colors: null
  };
  const send = () => structuredClone(sender.apply({ objects: [object] }, true));
  receiver.apply(send(), false);
  for (const target of [new CloudTransport(), new CloudTransport()]) {
    assert.deepEqual(target.apply(send(), false).objects, []);
    assert.equal(target.missing, true);
    sender.clear();
    assert.equal(target.apply(send(), false).objects[0].positions[0], 1);
  }
  object = { ...object, positions: new Float32Array([9]) };
  send(); // drop full packet after Log reset, with repeated scan ID
  assert.deepEqual(receiver.apply(send(), false).objects, []);
  assert.equal(receiver.missing, true);
  sender.clear();
  assert.equal(receiver.apply(send(), false).objects[0].positions[0], 9);
});
