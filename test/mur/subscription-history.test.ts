// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import { writeValue } from "../../src/hub/dataSources/mur/MURLogAdapter";
import MURSource from "../../src/hub/dataSources/mur/MURSource";
import Log from "../../src/shared/log/Log";

test("resubscribing requests history again and merges overlapping samples once", async (t) => {
  const path = "vehicles/mur27/gps/latitude";
  const descriptor = { path, type: "float64" } as any;
  const source = new MURSource() as any;
  source.log = new Log();
  const writes = t.mock.method(source.log, "putNumber");
  source.catalogue = { epoch: "test", revision: 1 };
  source.descriptors.set(path, descriptor);
  let active = new Set(["/" + path]);
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      tabs: { getActiveFields: () => active, getVisibleTabsKey: () => "" },
      sidebar: { getActiveFields: () => [] }
    }
  });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const sample = (seq: number) => ({ stream_id: "test", seq, t_ns: String(seq * 1000000000), value: seq });
  let history = [sample(1), sample(2)];
  let requests = 0;
  let respond: Promise<void> | undefined;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests++;
    urls.push(url);
    await respond;
    return { ok: true, status: 200, json: async () => ({ samples: history }) };
  });
  source.send = () => {};
  // The subscription check runs at most every 250 ms; step the clock past that before each periodic()
  t.mock.timers.enable({ apis: ["Date"] });
  const periodic = () => {
    t.mock.timers.tick(250);
    source.periodic();
  };
  const fetchHistory = source.fetchHistory.bind(source);
  let pending: Promise<void>;
  source.fetchHistory = (path: string, generation: number) => (pending = fetchHistory(path, generation));
  const live = (seq: number) => {
    const s = sample(seq);
    const time = source.timeBase.sampleTime(s).seconds;
    if (source.dedup.accept(path, s.stream_id, seq, time)) {
      writeValue(source.log, descriptor, time, s.value);
    }
  };
  live(2);
  periodic();
  await pending!;
  periodic();
  assert.equal(requests, 1);
  source.lastSampleNs.set(path, 2000000000n); // The newest sample before the tab was hidden
  active = new Set();
  periodic();
  source.lastSampleNs.set(path, 3000000000n); // A later sample (e.g. for the sidebar) must not move the resume point
  assert.equal(source.historyRequested.has(path), false);
  history = [sample(1), sample(2), sample(3), sample(4)];
  active = new Set(["/" + path]);
  live(4);
  periodic();
  await pending!;
  assert.equal(requests, 2);
  assert.doesNotMatch(urls[0], /from_ns/);
  assert.match(urls[1], /from_ns=2000000000/); // The gap since the tab was hidden fills in
  const data = source.log.getNumber("/" + path, -Infinity, Infinity);
  assert.deepEqual(data.values, [1, 2, 3, 4]);
  assert.equal(new Set(data.timestamps).size, 4);
  assert.equal(writes.mock.callCount(), 4);
  active = new Set();
  source.lastSampleNs.set(path, 4000000000n);
  periodic();
  let release!: () => void;
  respond = new Promise<void>((resolve) => (release = resolve));
  active = new Set(["/" + path]);
  periodic();
  live(6);
  source.lastSampleNs.set(path, 6000000000n);
  active = new Set();
  periodic();
  release();
  await pending!;
  respond = undefined;
  active = new Set(["/" + path]);
  periodic();
  await pending!;
  assert.match(urls[3], /from_ns=/, "a retired request cannot erase the next resume cursor");
});
