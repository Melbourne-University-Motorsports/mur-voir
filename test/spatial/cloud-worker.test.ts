// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudDecoder } from "../../src/hub/CloudDecoder";
test("decoder bounds concurrency, copies only the message view and yields to waiting layers", async () => {
  const original = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: any;
    onerror: any;
    last: any;
    constructor() {
      workers.push(this);
    }
    postMessage(message: any) {
      this.last = message;
    }
    terminate() {}
    finish() {
      this.onmessage({ data: { payload: { ok: true } } });
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const a = {},
      b = {},
      backing = new Uint8Array([1, 2, 3, 4]),
      bytes = backing.subarray(1, 3);
    const one = CloudDecoder.request({ bytes }, a),
      two = CloudDecoder.request({ bytes }, a);
    assert.equal(workers.length, 2);
    assert.equal(CloudDecoder.request({ bytes }, b), null);
    assert.equal(workers[0].last.payload.bytes.buffer.byteLength, 2);
    assert.notEqual(workers[0].last.payload.bytes.buffer, backing.buffer);
    assert.deepEqual([...backing], [1, 2, 3, 4]);
    workers[0].finish();
    await one;
    assert.equal(CloudDecoder.request({ bytes }, a), null, "first layer yields to waiting second layer");
    const three = CloudDecoder.request({ bytes }, b);
    assert.ok(three);
    workers[0].finish();
    workers[1].finish();
    await Promise.all([two, three]);
  } finally {
    globalThis.Worker = original;
  }
});
